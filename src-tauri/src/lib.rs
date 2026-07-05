// Tauri backend: wires together the multi-PTY manager (terminals spawned by id
// from the frontend) and the workspace store. The frontend renders each PTY
// stream with xterm.js and talks to a terminal by the id it chose at spawn
// time. Registered commands run as real PTYs via pty_spawn — there is no
// separate headless runner.
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;

use tauri::{Emitter, Manager, WindowEvent};

mod agent_resume;
mod agent_usage;
mod canvas;
mod dashboard;
mod fsbrowse;
mod git;
mod git_watch;
mod proc;
mod profile;
mod pty;
mod terminal_layout;
mod usage_limits;
mod vault;
mod workspaces;
use pty::PtyManager;
use terminal_layout::TerminalLayoutState;
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
        // Lift macOS WKWebView's 60fps requestAnimationFrame cap so the terminal
        // can scroll at the display's native refresh rate (e.g. 120Hz ProMotion).
        // No-op on non-macOS platforms.
        .plugin(tauri_plugin_macos_fps::init())
        .manage(CloseGuard(AtomicBool::new(false)))
        .setup(|app| {
            // Seed the active profile from the old fixed `app_data_dir` locations
            // on first launch, BEFORE the stores below load — they now read from
            // the profile's data root, so the migrated files must be in place.
            profile::migrate_app_data_stores(app.path().app_data_dir().ok());
            // Move the legacy fixed-path canvas + vault folders into the profile,
            // so screenshots and canvas docs taken before profiles still show.
            profile::migrate_canvas_vault();
            // Move the legacy agent-session store into the profile, so agent
            // resume keeps working across the move to per-profile roots.
            profile::migrate_agent_sessions();
            // Load the persisted workspace store (folders the user works in).
            app.manage(WorkspaceState::load());
            // Multi-PTY manager: terminals are spawned by id on demand from the
            // frontend (including the boot terminal), not at setup time.
            app.manage(PtyManager::default());
            // Persisted terminal layout + scrollback, used to rebuild each
            // project's terminals after a restart.
            app.manage(TerminalLayoutState::load());
            // Fs watcher behind the sidebar's live git counts; the frontend
            // installs the watched paths via git_watch_paths after each render.
            app.manage(git_watch::GitWatchState::default());
            // Fs watcher behind the canvas pane; the frontend points it at the
            // selected project's ~/.octiqflow/canvas/<key> folder via canvas_watch
            // so an agent's document writes re-render the pane live.
            app.manage(canvas::CanvasWatchState::default());
            // Screenshot-vault hotkey monitor. Holds the chord config; the global
            // key listener starts only when the frontend opts in (vault_start_monitor),
            // so the Input Monitoring permission prompt never fires unasked.
            app.manage(vault::VaultMonitor::default());
            // Keep the agent session-capture hook script on disk current with this
            // build, so resume fixes ship without the user re-running setup from
            // Settings. Writes only the script file (never an agent's settings);
            // best-effort, so a failure here never blocks startup.
            agent_resume::refresh_hook_script();
            // Upgrade an existing opt-in: if the user already installed our agent
            // hook, also register the Notification attention hook (and retire the
            // old SessionEnd entry), so cross-project "an agent is waiting for
            // you" alerts work without re-running setup from Settings. Only
            // touches configs that already carry our hook; best-effort, so a
            // failure here never blocks startup.
            agent_resume::upgrade_agent_hooks_if_present();

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
            pty::pty_agent_running,
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
            workspaces::set_terminal_command,
            workspaces::set_description,
            workspaces::set_color,
            workspaces::set_initial,
            workspaces::set_icon,
            workspaces::set_workspace_shelved,
            workspaces::set_font_override,
            workspaces::pick_folder,
            terminal_layout::save_terminal_layout,
            terminal_layout::load_terminal_layouts,
            terminal_layout::save_scrollback,
            terminal_layout::load_scrollback,
            terminal_layout::clear_project_layout,
            agent_resume::agent_resume_cmd,
            agent_resume::agent_tab_info,
            agent_usage::agent_usage_all,
            usage_limits::usage_summary,
            agent_resume::setup_agent_hooks,
            agent_resume::prune_exited_agent_sessions,
            confirm_close,
            profile::read_profile_settings,
            profile::write_profile_settings,
            profile::profile_dir_path,
            profile::get_profile_config,
            profile::list_profiles,
            profile::create_profile,
            profile::switch_profile,
            profile::set_profile_base,
            dashboard::list_docs,
            git::git_status_summary,
            git_watch::git_watch_paths,
            git::git_changed_files,
            git::git_file_diff,
            git::git_local_branches,
            fsbrowse::list_dir,
            fsbrowse::read_file_preview,
            fsbrowse::write_file,
            fsbrowse::resolve_paths,
            canvas::canvas_dir,
            canvas::canvas_list,
            canvas::canvas_list_all,
            canvas::canvas_read,
            canvas::canvas_delete,
            canvas::canvas_delete_all,
            canvas::canvas_watch,
            canvas::install_canvas_skill,
            canvas::install_canvas_codex_guide,
            vault::vault_start_monitor,
            vault::vault_set_keys,
            vault::vault_capture_now,
            vault::vault_permissions,
            vault::vault_request_permissions,
            vault::vault_list,
            vault::vault_remove,
            vault::vault_clear,
            vault::vault_write_image,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
