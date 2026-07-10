// File-system watcher behind the sidebar's live git counts. The frontend points
// it at the union of every project's folder paths (`git_watch_paths`); it
// watches them recursively and emits a debounced `git-status-changed` event
// whenever something that can affect `git status` changes — a working-tree edit,
// a new file, or a commit/branch switch (which rewrites `.git/HEAD` / refs).
// The frontend listens and re-runs its `git_status_summary` annotation.
//
// Two guards keep this from melting down:
//   * `.git` internals are filtered to the few files that change on commit /
//     stage / checkout (HEAD, index, refs, logs); the object store and `*.lock`
//     temp files are noise and ignored. Our own read-only git calls also run
//     with GIT_OPTIONAL_LOCKS=0 (see git.rs) so a status query never rewrites
//     `.git/index` and re-triggers the watcher in a feedback loop.
//   * Events are debounced: one emit after a quiet period, with an upper bound
//     so a long busy burst (a build writing files) still reports periodically.
use std::path::{Path, PathBuf};
use std::sync::{mpsc, Mutex};
use std::time::{Duration, Instant};

use notify::{RecommendedWatcher, RecursiveMode, Watcher};
use tauri::{AppHandle, Emitter};

/// Trailing quiet period: emit once no event has arrived for this long.
const QUIET: Duration = Duration::from_millis(400);
/// Upper bound on coalescing: during a continuous burst of events, emit at
/// least this often instead of waiting for quiet that never comes.
const MAX_COALESCE: Duration = Duration::from_millis(2000);

/// The currently installed watcher (replaced wholesale when the watched path
/// set changes). Dropping the old watcher disconnects its event channel, which
/// ends its debounce thread.
#[derive(Default)]
pub struct GitWatchState(Mutex<Option<RecommendedWatcher>>);

/// (Re)point the watcher at `paths` — the union of every project's folders.
/// Replaces any previous watcher. An empty list stops watching. Paths that are
/// missing or unreadable are skipped (best-effort, never an error), matching
/// how git.rs treats bad paths.
#[tauri::command]
pub fn git_watch_paths(
    app: AppHandle,
    state: tauri::State<GitWatchState>,
    paths: Vec<String>,
) -> Result<(), String> {
    let mut guard = state.0.lock().map_err(|e| e.to_string())?;
    *guard = None; // drop the old watcher first; its debounce thread ends
    if paths.is_empty() {
        return Ok(());
    }

    // The watched roots, needed to make each event path relative before the
    // ignore rules are applied (see `under_root`).
    let mut seen = std::collections::HashSet::new();
    let roots: Vec<PathBuf> = paths
        .into_iter()
        .filter(|p| seen.insert(p.clone())) // two projects sharing a folder: watch it once
        .map(PathBuf::from)
        .filter(|p| p.is_dir())
        .collect();
    if roots.is_empty() {
        return Ok(());
    }

    // Each send carries the watched ROOT the change happened under, so the
    // frontend can re-annotate only the affected projects instead of rescanning
    // every path of every project.
    let (tx, rx) = mpsc::channel::<String>();
    let event_roots = roots.clone();
    let mut watcher = notify::recommended_watcher(move |res: notify::Result<notify::Event>| {
        let Ok(event) = res else { return };
        if event.paths.is_empty() {
            // A dropped/overflowed event batch: we no longer know what changed,
            // so ask the frontend for a full rescan (an empty payload).
            let _ = tx.send(String::new());
            return;
        }
        for p in &event.paths {
            if !is_relevant(under_root(p, &event_roots)) {
                continue;
            }
            let root = event_roots
                .iter()
                .find(|r| p.starts_with(r))
                .map(|r| r.to_string_lossy().into_owned())
                .unwrap_or_default();
            let _ = tx.send(root);
        }
    })
    .map_err(|e| e.to_string())?;

    for root in &roots {
        let _ = watcher.watch(root, RecursiveMode::Recursive);
    }

    std::thread::spawn(move || debounce_loop(app, rx));
    *guard = Some(watcher);
    Ok(())
}

/// Collapse bursts of raw fs events into sparse `git-status-changed` emits:
/// wait for the first event, then keep absorbing until QUIET passes with no
/// event (or MAX_COALESCE total), then emit once with the set of watched roots
/// that changed. Ends when the watcher is dropped and the channel disconnects.
///
/// The payload is the union of roots seen during the window. An EMPTY payload
/// means "something changed but we do not know where" — the frontend must then
/// fall back to a full rescan. That happens when the watcher drops an event
/// batch, and it is also what a boot-time render does.
fn debounce_loop(app: AppHandle, rx: mpsc::Receiver<String>) {
    /// Collect a root into the window's set. An empty root poisons the set into
    /// "unknown", because one unattributable change means we cannot claim the
    /// other roots are clean.
    fn absorb(roots: &mut std::collections::BTreeSet<String>, unknown: &mut bool, root: String) {
        if root.is_empty() {
            *unknown = true;
        } else {
            roots.insert(root);
        }
    }

    while let Ok(first_root) = rx.recv() {
        let mut roots = std::collections::BTreeSet::new();
        let mut unknown = false;
        absorb(&mut roots, &mut unknown, first_root);

        let first = Instant::now();
        let mut disconnected = false;
        loop {
            if first.elapsed() >= MAX_COALESCE {
                break;
            }
            match rx.recv_timeout(QUIET) {
                Ok(root) => absorb(&mut roots, &mut unknown, root),
                Err(mpsc::RecvTimeoutError::Timeout) => break,
                Err(mpsc::RecvTimeoutError::Disconnected) => {
                    disconnected = true;
                    break;
                }
            }
        }
        // An unknown change means we cannot name the affected roots, so send
        // none and let the frontend rescan everything.
        let payload: Vec<String> = if unknown {
            Vec::new()
        } else {
            roots.into_iter().collect()
        };
        let _ = app.emit("git-status-changed", payload);
        if disconnected {
            return;
        }
    }
}

/// Directories whose contents never belong in `git status`: they are build
/// output or installed dependencies, and every real project gitignores them.
/// A `cargo build` or `npm install` writes thousands of files under these, and
/// each one used to open the 2s coalesce window for the whole build.
///
/// Matched as a whole PATH COMPONENT, never as a substring — a source file at
/// `src/target_resolver.rs` or a folder named `my-dist-tools` must still count.
const IGNORED_DIRS: [&str; 5] = ["node_modules", "target", "dist", "build", ".venv"];

/// `path` with the first watched root that contains it stripped off, or `path`
/// itself when no root matches.
///
/// The ignore rules below MUST be applied to this relative remainder, never to
/// the absolute path. A user whose project lives at `~/build/my-app` or
/// `~/dist/site` would otherwise have every one of its files ignored, and their
/// sidebar counts would simply stop updating.
fn under_root<'a>(path: &'a Path, roots: &[PathBuf]) -> &'a Path {
    for root in roots {
        if let Ok(rel) = path.strip_prefix(root) {
            return rel;
        }
    }
    path
}

/// Can a change to this path affect `git status`? `path` is relative to the
/// watched project folder (see `under_root`).
///
/// Working-tree paths count, with two exceptions:
///   * anything under a build/dependency directory (see `IGNORED_DIRS`);
///   * inside `.git`, only the files rewritten by a commit, stage, checkout or
///     merge — HEAD, index, ORIG_HEAD / MERGE_HEAD, and anything under refs/ or
///     logs/. The object store (`.git/objects/…`) and `*.lock` temp files are
///     churn with no status impact.
///
/// The build-dir rule is a heuristic on the WATCHER side, not a substitute for
/// gitignore: a TRACKED file that happens to live under `build/` would be
/// missed until the next event elsewhere in the repo. That trade is worth it —
/// the alternative is re-running three git subprocesses per project path every
/// two seconds for the whole length of every build.
fn is_relevant(path: &Path) -> bool {
    let comps: Vec<String> = path
        .components()
        .map(|c| c.as_os_str().to_string_lossy().into_owned())
        .collect();
    let Some(pos) = comps.iter().position(|c| c == ".git") else {
        // A working-tree path: relevant unless it sits under a build dir.
        return !comps.iter().any(|c| IGNORED_DIRS.contains(&c.as_str()));
    };
    let inner = &comps[pos + 1..];
    let Some(file) = inner.last() else {
        return true; // the .git dir itself (e.g. repo created/deleted)
    };
    if file.ends_with(".lock") {
        return false;
    }
    matches!(
        inner[0].as_str(),
        "HEAD" | "index" | "MERGE_HEAD" | "ORIG_HEAD" | "refs" | "logs"
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn working_tree_paths_are_relevant() {
        assert!(is_relevant(Path::new("/repo/src/main.rs")));
        assert!(is_relevant(Path::new("/repo/new-file.txt")));
        // A working-tree lock file (e.g. Cargo.lock) is a real change.
        assert!(is_relevant(Path::new("/repo/Cargo.lock")));
    }

    #[test]
    fn git_commit_files_are_relevant() {
        assert!(is_relevant(Path::new("/repo/.git/HEAD")));
        assert!(is_relevant(Path::new("/repo/.git/index")));
        assert!(is_relevant(Path::new("/repo/.git/MERGE_HEAD")));
        assert!(is_relevant(Path::new("/repo/.git/ORIG_HEAD")));
        assert!(is_relevant(Path::new("/repo/.git/refs/heads/main")));
        assert!(is_relevant(Path::new("/repo/.git/logs/HEAD")));
    }

    #[test]
    fn git_internal_noise_is_ignored() {
        assert!(!is_relevant(Path::new("/repo/.git/objects/ab/cdef0123")));
        assert!(!is_relevant(Path::new("/repo/.git/index.lock")));
        assert!(!is_relevant(Path::new("/repo/.git/refs/heads/main.lock")));
        assert!(!is_relevant(Path::new("/repo/.git/FETCH_HEAD")));
        assert!(!is_relevant(Path::new("/repo/.git/COMMIT_EDITMSG")));
    }

    #[test]
    fn bare_git_dir_event_is_relevant() {
        // The .git dir itself appearing/disappearing changes repo-ness.
        assert!(is_relevant(Path::new("/repo/.git")));
    }

    // ---- build / dependency directories are ignored (card 21) --------------

    #[test]
    fn build_and_dependency_dirs_are_ignored() {
        assert!(!is_relevant(Path::new("node_modules/react/index.js")));
        assert!(!is_relevant(Path::new("target/debug/build/foo/out")));
        assert!(!is_relevant(Path::new("dist/bundle.js")));
        assert!(!is_relevant(Path::new("build/output.o")));
        assert!(!is_relevant(Path::new(".venv/lib/python3.12/site.py")));
        // Nested deeper than the first component.
        assert!(!is_relevant(Path::new("packages/web/node_modules/x/a.js")));
        assert!(!is_relevant(Path::new(
            "src-tauri/target/debug/deps/x.rlib"
        )));
    }

    #[test]
    fn ignored_names_match_whole_components_not_substrings() {
        // The rule must not swallow real source files whose name merely CONTAINS
        // an ignored word. This is the bug a naive `path.contains("target")` has.
        assert!(is_relevant(Path::new("src/target_resolver.rs")));
        assert!(is_relevant(Path::new("src/build_script.rs")));
        assert!(is_relevant(Path::new("my-dist-tools/main.js")));
        assert!(is_relevant(Path::new("distribution/notes.md")));
        assert!(is_relevant(Path::new("src/node_modules_shim.ts")));
    }

    // ---- under_root: the ignore rules apply BELOW the watched folder --------

    #[test]
    fn under_root_strips_the_matching_watched_root() {
        let roots = vec![PathBuf::from("/Users/k/proj")];
        assert_eq!(
            under_root(Path::new("/Users/k/proj/src/main.rs"), &roots),
            Path::new("src/main.rs")
        );
    }

    #[test]
    fn under_root_returns_the_path_when_no_root_matches() {
        let roots = vec![PathBuf::from("/Users/k/other")];
        let p = Path::new("/Users/k/proj/src/main.rs");
        assert_eq!(under_root(p, &roots), p);
    }

    #[test]
    fn a_project_living_under_a_build_named_folder_is_not_ignored() {
        // The whole point of under_root. Watching `~/build/my-app`, a change to
        // `~/build/my-app/src/main.rs` is relevant — the `build` component
        // belongs to the ROOT, not to the path inside the project.
        let roots = vec![PathBuf::from("/Users/k/build/my-app")];
        let changed = Path::new("/Users/k/build/my-app/src/main.rs");
        assert!(is_relevant(under_root(changed, &roots)));

        // …while a build dir INSIDE that project is still ignored.
        let ignored = Path::new("/Users/k/build/my-app/node_modules/react/index.js");
        assert!(!is_relevant(under_root(ignored, &roots)));
    }

    #[test]
    fn dot_git_rules_still_apply_below_a_root() {
        let roots = vec![PathBuf::from("/Users/k/proj")];
        assert!(is_relevant(under_root(
            Path::new("/Users/k/proj/.git/HEAD"),
            &roots
        )));
        assert!(!is_relevant(under_root(
            Path::new("/Users/k/proj/.git/index.lock"),
            &roots
        )));
    }
}
