// External focus channel: let a tool OUTSIDE the app jump us to a terminal.
//
// An outside tool (e.g. a notch/menu-bar panel watching the agent transcripts)
// knows an agent by its *session id* — that is all any agent writes down. It
// writes that id into `~/.octiqflow/focus`; we resolve it to the tab running
// that session (agent_resume.rs already maps tab key -> session), bring the
// window forward, and emit `focus-terminal` so the frontend activates the tab.
//
// Channel shape mirrors the rest of the app: no IPC socket, just a file on disk
// (like the agent-session store) plus a `notify` watcher (like git_watch.rs /
// canvas.rs). The path is FIXED, not profile-scoped, for the same reason the
// agent-session hook's dir is: an outside tool cannot know the active profile.
use std::path::PathBuf;
use std::sync::mpsc;
use std::time::Duration;

use notify::{RecursiveMode, Watcher};
use tauri::{AppHandle, Emitter, Manager};

/// One write of a file arrives as several fs events; absorb the burst.
const BURST: Duration = Duration::from_millis(80);

/// `~/.octiqflow/focus` — the file an outside tool writes an agent session id
/// into. Fixed path (not the profile dir) so the writer needs no OctiqFlow state.
fn focus_path() -> Option<PathBuf> {
    crate::paths::home_dir().map(|h| h.join(".octiqflow").join("focus"))
}

/// Start watching the focus file. Best-effort: any failure (no home dir, watcher
/// refused) just means no external focus, never a broken app. Called once from
/// `setup()`; the watcher lives in the spawned thread for the app's lifetime.
pub fn watch(app: AppHandle) {
    std::thread::spawn(move || {
        let Some(path) = focus_path() else { return };
        let Some(dir) = path.parent().map(|p| p.to_path_buf()) else {
            return;
        };
        // Watch the DIR, not the file: the file may not exist yet, and a writer
        // that replaces it atomically would break a watch on the inode.
        if std::fs::create_dir_all(&dir).is_err() {
            return;
        }

        let (tx, rx) = mpsc::channel::<()>();
        let watched = path.clone();
        let Ok(mut watcher) =
            notify::recommended_watcher(move |res: notify::Result<notify::Event>| {
                if let Ok(event) = res {
                    if event.paths.iter().any(|p| *p == watched) {
                        let _ = tx.send(());
                    }
                }
            })
        else {
            return;
        };
        if watcher.watch(&dir, RecursiveMode::NonRecursive).is_err() {
            return;
        }
        let _watcher = watcher; // must outlive the loop, or the channel closes

        while rx.recv().is_ok() {
            while rx.recv_timeout(BURST).is_ok() {} // absorb the write burst
            let Ok(raw) = std::fs::read_to_string(&path) else {
                continue;
            };
            let Some(key) = crate::agent_resume::key_for_session(raw.trim()) else {
                continue; // unknown / stale / malformed session id
            };
            if let Some(win) = app.get_webview_window("main") {
                let _ = win.unminimize();
                let _ = win.show();
                let _ = win.set_focus();
            }
            let _ = app.emit("focus-terminal", &key);
        }
    });
}
