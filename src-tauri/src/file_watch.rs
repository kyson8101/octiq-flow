// File-system watcher behind the file preview pane's live reload. The frontend
// points it at the exact set of files open as tabs (`file_watch_paths`); when
// one of them changes on disk — an agent edits it, a build regenerates it, git
// checks out another branch — a debounced `file-changed` event carries the
// affected paths back and filepreview.js re-reads them.
//
// Why the PARENT DIRECTORY is watched instead of the file itself: almost every
// editor (and most tools) save by writing a temp file and renaming it over the
// target. That replaces the inode, so a watch registered on the file survives as
// a watch on a file nobody writes to any more and goes silent after the first
// save. Watching the containing folder non-recursively keeps working, and the
// event path tells us which watched file it was.
use std::collections::{BTreeSet, HashSet};
use std::sync::Arc;
use std::path::PathBuf;
use std::sync::{mpsc, Mutex};
use std::time::{Duration, Instant};

use notify::{RecommendedWatcher, RecursiveMode, Watcher};
use tauri::State;

/// Trailing quiet period: emit once no event has arrived for this long. Shorter
/// than the git watcher's — this drives a visible pane, not a status count.
const QUIET: Duration = Duration::from_millis(150);
/// Upper bound on coalescing, so a file being appended to continuously (a log)
/// still refreshes periodically instead of waiting for quiet that never comes.
const MAX_COALESCE: Duration = Duration::from_millis(1000);

/// The currently installed watcher (replaced wholesale when the open-file set
/// changes). Dropping the old watcher disconnects its channel, ending its
/// debounce thread.
#[derive(Default)]
pub struct FileWatchState(Mutex<Option<RecommendedWatcher>>);

/// (Re)point the watcher at `paths` — the files currently open in the preview
/// pane. Replaces any previous watcher; an empty list stops watching. Missing or
/// unreadable paths are skipped (best-effort, never an error).
#[tauri::command]
pub fn file_watch_paths(
    state: State<Arc<FileWatchState>>,
    paths: Vec<String>,
) -> Result<(), String> {
    file_watch_paths_impl(
        &state,
        paths,
    )
}

/// The Tauri-free half of `file_watch_paths`.
pub fn file_watch_paths_impl(
    state: &FileWatchState,
    paths: Vec<String>,
) -> Result<(), String> {
    let mut guard = state.0.lock().map_err(|e| e.to_string())?;
    *guard = None; // drop the old watcher first; its debounce thread ends
    if paths.is_empty() {
        return Ok(());
    }

    let watched: HashSet<PathBuf> = paths.iter().map(PathBuf::from).collect();
    // One watch per containing folder, however many open files share it.
    let dirs: HashSet<PathBuf> = watched
        .iter()
        .filter_map(|p| p.parent().map(PathBuf::from))
        .filter(|d| d.is_dir())
        .collect();
    if dirs.is_empty() {
        return Ok(());
    }

    let (tx, rx) = mpsc::channel::<String>();
    let mut watcher = notify::recommended_watcher(move |res: notify::Result<notify::Event>| {
        let Ok(event) = res else { return };
        for p in &event.paths {
            if watched.contains(p) {
                let _ = tx.send(p.to_string_lossy().into_owned());
            }
        }
    })
    .map_err(|e| e.to_string())?;

    for dir in &dirs {
        let _ = watcher.watch(dir, RecursiveMode::NonRecursive);
    }

    std::thread::spawn(move || debounce_loop(rx));
    *guard = Some(watcher);
    Ok(())
}

/// Collapse bursts of raw fs events into sparse `file-changed` emits: wait for
/// the first event, absorb until QUIET passes with no event (or MAX_COALESCE
/// total), then emit once with the set of changed paths. A single save often
/// produces several events (create temp, rename, chmod); the frontend must see
/// one reload, not three. Ends when the watcher is dropped.
fn debounce_loop(rx: mpsc::Receiver<String>) {
    while let Ok(first) = rx.recv() {
        let mut changed = BTreeSet::new();
        changed.insert(first);

        let started = Instant::now();
        let mut disconnected = false;
        loop {
            if started.elapsed() >= MAX_COALESCE {
                break;
            }
            match rx.recv_timeout(QUIET) {
                Ok(path) => {
                    changed.insert(path);
                }
                Err(mpsc::RecvTimeoutError::Timeout) => break,
                Err(mpsc::RecvTimeoutError::Disconnected) => {
                    disconnected = true;
                    break;
                }
            }
        }
        crate::bus::emit("file-changed", changed.into_iter().collect::<Vec<String>>());
        if disconnected {
            return;
        }
    }
}
