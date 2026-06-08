// Tauri backend: wires together the multi-PTY manager (terminals spawned by id
// from the frontend), the dev-space process runner, and the workspace store.
// The frontend renders each PTY stream with xterm.js and talks to a session by
// the id it chose at spawn time.
use tauri::Manager;

mod pty;
mod runner;
mod workspaces;
use pty::PtyManager;
use runner::RunnerState;
use workspaces::WorkspaceState;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .setup(|app| {
            // Load the persisted workspace store (folders the user works in).
            app.manage(WorkspaceState::load(app.handle()));
            // Dev-space process runner state (tracks running commands).
            app.manage(RunnerState::default());
            // Multi-PTY manager: terminals are spawned by id on demand from the
            // frontend (including the boot terminal), not at setup time.
            app.manage(PtyManager::default());

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            pty::pty_spawn,
            pty::pty_write,
            pty::pty_resize,
            pty::pty_close,
            pty::pty_list_active,
            workspaces::list_workspaces,
            workspaces::add_workspace,
            workspaces::set_primary_path,
            workspaces::rename_workspace,
            workspaces::delete_workspace,
            workspaces::add_workspace_path,
            workspaces::remove_workspace_path,
            workspaces::set_docs_path,
            workspaces::clear_docs_path,
            workspaces::add_session,
            workspaces::delete_session,
            workspaces::set_session_plan,
            workspaces::add_task,
            workspaces::set_task_done,
            workspaces::delete_task,
            workspaces::add_action,
            workspaces::update_action,
            workspaces::delete_action,
            workspaces::pick_folder,
            runner::run_action,
            runner::stop_action,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
