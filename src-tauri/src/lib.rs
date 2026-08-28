// Tauri backend: wires together the multi-PTY manager (terminals spawned by id
// from the frontend) and the workspace store. The frontend renders each PTY
// stream with xterm.js and talks to a terminal by the id it chose at spawn
// time. Registered commands run as real PTYs via pty_spawn — there is no
// separate headless runner.
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;

use tauri::{Emitter, Manager, WindowEvent};
use tauri_plugin_dialog::{DialogExt, MessageDialogButtons};
use tauri_plugin_opener::OpenerExt;

mod access;
mod agent_api;
mod agent_chat;
mod agent_history;
mod agent_resume;
mod agents;
mod appearance;
mod bus;
mod canvas;
mod chat_index;
mod chat_room;
mod dispatch;
mod file_watch;
mod focus;
mod fonts;
mod fsbrowse;
mod git;
mod git_ops;
mod git_watch;
mod notify_hook;
mod paths;
mod permission;
mod proc;
mod profile;
mod profile_lock;
mod pty;
mod push;
mod question;
mod round;
mod terminal_layout;
mod transcript;
mod usage_limits;
mod vault;
mod web;
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
/// Run the backend as a service: no window, no Dock icon, no Tauri app.
///
/// The same code the desktop app runs, minus the parts that need a GUI. It
/// serves the v2 client and dispatches its commands directly (dispatch.rs)
/// rather than handing them to a webview, which is what made a window
/// necessary before.
///
/// `enabled` in web.json is deliberately ignored here. That flag decides
/// whether the DESKTOP app opens a port as a side effect; running this binary
/// is already the decision.
pub async fn run_headless() {
    // Refuse rather than fight. A service that silently overwrites the app's
    // project list is worse than one that does not start.
    if let Err(owner) = profile_lock::acquire("server") {
        eprintln!("[server] {}", profile_lock::conflict_message(&owner));
        std::process::exit(1);
    }
    // Once, before anything can be running: tidy away transcripts no chat
    // points at any more.
    chat_index::reconcile();

    let cfg = web::load_config();
    let services = dispatch::Services::load();
    println!("[server] OctiqFlow backend — no window, agents run here");
    web::start_headless(cfg, services).await;
}

/// The app was opened while something else already owns the profile.
///
/// Both the app and the service keep the whole profile in memory and write it
/// back whole, so whichever saves last silently reverts the other's work: add a
/// project on your phone, open the app, touch anything, and the project is
/// gone. Nothing crashes, which is what makes it nasty.
///
/// Sharing is not attempted, because the app would have to re-read before every
/// write in four separate stores and would still race. It says where the running
/// copy is and closes — the only outcome that cannot lose a project.
fn defer_to_running_copy(app: &tauri::AppHandle, owner: &profile_lock::Owner) {
    let url = format!("http://127.0.0.1:{}/", web::load_config().port);
    let handle = app.clone();
    let opened = url.clone();
    // Deliberately NOT `blocking_show`. This runs inside `setup`, before the
    // event loop starts, and on macOS a blocking dialog there returns at once
    // without drawing anything — the app then vanished on launch saying nothing,
    // which is worse than the collision it was added to explain. The callback
    // fires once the loop is up, so the window (configured hidden) simply never
    // appears and the dialog is the only thing on screen.
    app.dialog()
        .message(format!(
            "{}\n\nYour projects, chats and terminals are all there:\n{opened}",
            profile_lock::conflict_message(owner)
        ))
        .title("OctiqFlow is already running")
        .buttons(MessageDialogButtons::OkCancelCustom(
            "Open in Browser".into(),
            "Quit".into(),
        ))
        .show(move |open| {
            if open {
                let _ = handle.opener().open_url(&url, None::<&str>);
            }
            handle.exit(0);
        });
}

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
            // One owner per profile, decided BEFORE anything below runs: the
            // migrations and every store that follows write to the profile, so
            // a check further down would already be too late.
            if let Err(owner) = profile_lock::acquire("desktop") {
                defer_to_running_copy(app.handle(), &owner);
                // Returning here is what makes this safe: not one line below
                // runs, so no migration and no store ever writes to a profile
                // we do not own. The exit happens when the dialog is answered.
                return Ok(());
            }

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
            app.manage(std::sync::Arc::new(WorkspaceState::load()));
            // Multi-PTY manager: terminals are spawned by id on demand from the
            // frontend (including the boot terminal), not at setup time.
            app.manage(std::sync::Arc::new(PtyManager::default()));
            // Agent chat sessions: agents run as a JSON stream instead of a TUI,
            // for the chat view (agent_chat.rs).
            let chats = std::sync::Arc::new(agent_chat::ChatManager::default());
            // Card 83 — who was sitting in each chat when this last stopped. A
            // seat has no process to restore (it is spawned when it is asked),
            // so bringing the roster back is the whole of it. What does NOT come
            // back is the discussion: `round::Rounds` is in memory and is not
            // written anywhere, so a restored seat's view starts here.
            if let Some(path) = chat_room::rooms_path() {
                chat_room::load_rooms(&chats, &path);
            }
            // A chat nobody has touched for a quarter of an hour is ended, and
            // resumed on its next message. See `agent_chat::start_idle_reaper`.
            agent_chat::start_idle_reaper(chats.clone());
            app.manage(chats);
            app.manage(std::sync::Arc::new(round::Rounds::default()));
            // Persisted terminal layout + scrollback, used to rebuild each
            // project's terminals after a restart.
            app.manage(TerminalLayoutState::load());
            // Fs watcher behind the sidebar's live git counts; the frontend
            // installs the watched paths via git_watch_paths after each render.
            app.manage(git_watch::GitWatchState::default());
            // Fs watcher behind the file preview pane's live reload; the frontend
            // points it at the open editor tabs via file_watch_paths so an
            // external edit (agent, build, git checkout) refreshes the pane.
            app.manage(std::sync::Arc::new(file_watch::FileWatchState::default()));
            // Fs watcher behind the canvas pane; the frontend points it at the
            // selected project's ~/.octiqflow/canvas/<key> folder via canvas_watch
            // so an agent's document writes re-render the pane live.
            app.manage(canvas::CanvasWatchState::default());
            // Screenshot-vault hotkey monitor. Holds the chord config; the global
            // key listener starts only when the frontend opts in (vault_start_monitor),
            // so the Input Monitoring permission prompt never fires unasked.
            app.manage(vault::VaultMonitor::default());
            // External focus channel: an outside tool writes an agent session id
            // into ~/.octiqflow/focus and we jump to the tab running it.
            focus::watch(app.handle().clone());
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

            // Remote access (web.rs). Off unless the profile's web.json (or
            // OCTIQ_WEB=1) turns it on: this serves the app's UI and a socket
            // that can start shells. When it IS on, this process is the server —
            // the PTYs live here and a browser on another machine drives them.
            // Events reach the window through the bus from here on, so producers need
            // no AppHandle — which is what lets the same code run headless.
            web::mirror_events_to_desktop(app.handle());
            // Reaching here means we own the profile — the alternative left
            // above — so these no longer have to ask.
            chat_index::reconcile();

            let web_cfg = web::load_config();
            if web_cfg.enabled {
                // One WebState, shared by the Tauri commands that read it and
                // by the server itself — the same shape the headless server
                // builds for itself.
                let state = std::sync::Arc::new(web::WebState::new(web_cfg.clone()));
                app.manage(state.clone());
                web::start(app.handle(), state, web_cfg);
            }

            // Configured hidden so that a refusal above never flashes a window.
            // We own the profile, so this is a real launch: show it.
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.show();
            }

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
            pty::pty_active_sessions,
            agent_chat::chat_start,
            agent_chat::chat_send,
            agent_chat::chat_seat_start,
            agent_chat::chat_interrupt,
            agent_chat::chat_set_access,
            agent_chat::chat_stop,
            agent_chat::chat_restart,
            agent_chat::chat_list,
            chat_room::chat_add_agent,
            chat_room::chat_remove_agent,
            chat_room::chat_room,
            chat_room::chat_forget_room,
            round::chat_round,
            round::chat_round_stop,
            round::chat_round_state,
            round::chat_new_topic,
            agent_chat::chat_since,
            agent_chat::chat_forget,
            agent_chat::chat_index_list,
            agent_chat::chat_index_save,
            agent_chat::chat_index_remove,
            agent_chat::save_attachment,
            agent_history::agent_history_list,
            agent_history::agent_history_read,
            pty::pty_agent_running,
            pty::pty_set_visible,
            pty::pty_attach,
            pty::pty_set_status_scan,
            agents::agent_procs,
            agents::agent_kill,
            agents::available_agents,
            agents::agent_installs,
            appearance::system_accent,
            notify_hook::notify_hook_filter,
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
            workspaces::list_global_actions,
            workspaces::set_global_actions,
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
            terminal_layout::load_pane_layouts,
            terminal_layout::save_layout_preset,
            terminal_layout::list_layout_presets,
            terminal_layout::load_layout_preset,
            terminal_layout::delete_layout_preset,
            terminal_layout::save_scrollback,
            terminal_layout::load_scrollback,
            terminal_layout::clear_project_layout,
            agent_resume::agent_resume_cmd,
            agent_resume::agent_tab_infos,
            usage_limits::usage_summary,
            agent_resume::setup_agent_hooks,
            agent_resume::prune_exited_agent_sessions,
            confirm_close,
            fonts::list_fonts,
            profile::read_profile_settings,
            profile::write_profile_settings,
            profile::profile_dir_path,
            profile::get_profile_config,
            profile::list_profiles,
            profile::create_profile,
            profile::switch_profile,
            profile::set_profile_base,
            git::git_status_summary,
            git_watch::git_watch_paths,
            file_watch::file_watch_paths,
            git::git_changed_files,
            git::git_file_diff,
            git::git_local_branches,
            git_ops::git_commit,
            git_ops::git_push,
            git_ops::git_pull,
            git_ops::git_switch_branch,
            fsbrowse::list_dir,
            fsbrowse::open_in_vscode,
            fsbrowse::read_file_preview,
            fsbrowse::write_file,
            fsbrowse::resolve_paths,
            fsbrowse::stat_paths,
            fsbrowse::search_files,
            fsbrowse::list_project_files,
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
            web::web_reply,
            web::web_info,
            web::web_set_config,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
