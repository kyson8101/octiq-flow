// Tauri backend: wires together the multi-PTY manager (terminals spawned by id
// from the frontend) and the workspace store. The frontend renders each PTY
// stream with xterm.js and talks to a terminal by the id it chose at spawn
// time. Registered commands run as real PTYs via pty_spawn — there is no
// separate headless runner.
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;

use tauri::{Emitter, Manager, WindowEvent};

mod dashboard;
mod fsbrowse;
mod pty;
mod terminal_layout;
mod utilities;
mod workspaces;
use pty::PtyManager;
use terminal_layout::TerminalLayoutState;
use utilities::UtilitiesState;
use workspaces::WorkspaceState;

/// One-shot flag for the quit handshake. The first window close is intercepted
/// so the frontend can flush terminal scrollback; once it confirms (or the
/// fallback timer fires) this flips true and the next close is allowed through.
struct CloseGuard(AtomicBool);

/// How long to wait for the frontend's flush before forcing the window closed.
/// Bounds quit latency so a hung terminal can never make the app unclosable.
const CLOSE_FLUSH_TIMEOUT: Duration = Duration::from_millis(2500);

/// Let the window close. Called by the frontend once it has flushed all terminal
/// scrollback (see the `app-closing` listener). Sets the guard so the close
/// request is no longer intercepted, then closes the window.
#[tauri::command]
fn confirm_close(window: tauri::Window, guard: tauri::State<CloseGuard>) -> Result<(), String> {
    guard.0.store(true, Ordering::SeqCst);
    window.close().map_err(|e| e.to_string())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_notification::init())
        .manage(CloseGuard(AtomicBool::new(false)))
        .setup(|app| {
            // Load the persisted workspace store (folders the user works in).
            app.manage(WorkspaceState::load(app.handle()));
            // Multi-PTY manager: terminals are spawned by id on demand from the
            // frontend (including the boot terminal), not at setup time.
            app.manage(PtyManager::default());
            // Utilities template store (labelled agent-launch prompts).
            app.manage(UtilitiesState::load(app.handle()));
            // Persisted terminal layout + scrollback, used to rebuild each
            // project's terminals after a restart.
            app.manage(TerminalLayoutState::load(app.handle()));

            Ok(())
        })
        // Quit handshake: on the first close request, hold the window open and
        // ask the frontend to flush every terminal's scrollback to disk, so a
        // clean quit never loses the most recent output. The frontend calls
        // `confirm_close` when done; a fallback timer forces the close after
        // CLOSE_FLUSH_TIMEOUT so the app can never get stuck unclosable.
        .on_window_event(|window, event| {
            if let WindowEvent::CloseRequested { api, .. } = event {
                let guard = window.state::<CloseGuard>();
                if guard.0.load(Ordering::SeqCst) {
                    return; // already flushed (or forced): allow the close
                }
                api.prevent_close();
                let _ = window.emit("app-closing", ());
                let w = window.clone();
                std::thread::spawn(move || {
                    std::thread::sleep(CLOSE_FLUSH_TIMEOUT);
                    w.state::<CloseGuard>().0.store(true, Ordering::SeqCst);
                    let _ = w.close();
                });
            }
        })
        .invoke_handler(tauri::generate_handler![
            pty::pty_spawn,
            pty::pty_write,
            pty::pty_resize,
            pty::pty_close,
            pty::pty_list_active,
            pty::pty_clear_attention,
            utilities::list_templates,
            utilities::add_template,
            utilities::update_template,
            utilities::delete_template,
            workspaces::list_workspaces,
            workspaces::add_workspace,
            workspaces::set_primary_path,
            workspaces::rename_workspace,
            workspaces::delete_workspace,
            workspaces::reorder_workspaces,
            workspaces::add_workspace_path,
            workspaces::remove_workspace_path,
            workspaces::set_docs_path,
            workspaces::clear_docs_path,
            workspaces::add_action,
            workspaces::update_action,
            workspaces::delete_action,
            workspaces::set_startup,
            workspaces::pick_folder,
            terminal_layout::save_terminal_layout,
            terminal_layout::load_terminal_layouts,
            terminal_layout::save_scrollback,
            terminal_layout::load_scrollback,
            terminal_layout::clear_project_layout,
            confirm_close,
            dashboard::git_status_summary,
            dashboard::list_docs,
            fsbrowse::list_dir,
            fsbrowse::read_file_preview,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
