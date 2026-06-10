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
use std::path::Path;
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

    let (tx, rx) = mpsc::channel::<()>();
    let mut watcher = notify::recommended_watcher(move |res: notify::Result<notify::Event>| {
        if let Ok(event) = res {
            if event.paths.is_empty() || event.paths.iter().any(|p| is_relevant(p)) {
                let _ = tx.send(());
            }
        }
    })
    .map_err(|e| e.to_string())?;

    let mut seen = std::collections::HashSet::new();
    for p in paths {
        if !seen.insert(p.clone()) {
            continue; // two projects sharing a folder: watch it once
        }
        let path = Path::new(&p);
        if path.is_dir() {
            let _ = watcher.watch(path, RecursiveMode::Recursive);
        }
    }

    std::thread::spawn(move || debounce_loop(app, rx));
    *guard = Some(watcher);
    Ok(())
}

/// Collapse bursts of raw fs events into sparse `git-status-changed` emits:
/// wait for the first event, then keep absorbing until QUIET passes with no
/// event (or MAX_COALESCE total), then emit once. Ends when the watcher is
/// dropped and the channel disconnects.
fn debounce_loop(app: AppHandle, rx: mpsc::Receiver<()>) {
    while rx.recv().is_ok() {
        let first = Instant::now();
        loop {
            if first.elapsed() >= MAX_COALESCE {
                break;
            }
            match rx.recv_timeout(QUIET) {
                Ok(_) => continue,
                Err(mpsc::RecvTimeoutError::Timeout) => break,
                Err(mpsc::RecvTimeoutError::Disconnected) => {
                    let _ = app.emit("git-status-changed", ());
                    return;
                }
            }
        }
        let _ = app.emit("git-status-changed", ());
    }
}

/// Can a change to this path affect `git status`? Everything outside `.git`
/// counts (working-tree edits, new files, deletes). Inside `.git` only the
/// files rewritten by a commit, stage, checkout, or merge count: HEAD, index,
/// ORIG_HEAD / MERGE_HEAD, and anything under refs/ or logs/. The object store
/// (`.git/objects/…`) and `*.lock` temp files are churn with no status impact.
fn is_relevant(path: &Path) -> bool {
    let comps: Vec<String> = path
        .components()
        .map(|c| c.as_os_str().to_string_lossy().into_owned())
        .collect();
    let Some(pos) = comps.iter().position(|c| c == ".git") else {
        return true; // a working-tree path
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
}
