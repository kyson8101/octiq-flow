// Tauri backend: wires together the multi-PTY manager (terminals spawned by id
// from the frontend) and the workspace store. The frontend renders each PTY
// stream with xterm.js and talks to a terminal by the id it chose at spawn
// time. Registered commands run as real PTYs via pty_spawn — there is no
// separate headless runner.
use tauri::Manager;

mod dashboard;
mod pty;
mod utilities;
mod workspaces;
use pty::PtyManager;
use utilities::UtilitiesState;
use workspaces::WorkspaceState;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .setup(|app| {
            // Load the persisted workspace store (folders the user works in).
            app.manage(WorkspaceState::load(app.handle()));
            // Multi-PTY manager: terminals are spawned by id on demand from the
            // frontend (including the boot terminal), not at setup time.
            app.manage(PtyManager::default());
            // Utilities template store (labelled agent-launch prompts).
            app.manage(UtilitiesState::load(app.handle()));

            Ok(())
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
            workspaces::add_workspace_path,
            workspaces::remove_workspace_path,
            workspaces::set_docs_path,
            workspaces::clear_docs_path,
            workspaces::add_action,
            workspaces::update_action,
            workspaces::delete_action,
            workspaces::pick_folder,
            dashboard::git_status_summary,
            dashboard::list_docs,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
