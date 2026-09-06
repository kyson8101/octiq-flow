// OctiqFlow's backend, as a service.
//
// There is one front end: the browser client in `web/`. A request arrives over
// HTTP/WebSocket (web.rs), is routed by name through the dispatch table
// (dispatch.rs) and runs here. Terminals are real PTYs (pty.rs) whose output
// goes back out over the event bus (bus.rs) to every attached browser.
//
// This used to be a Tauri desktop app with the server bolted on the side. The
// window went; what is left is the part that did the work.

mod access;
mod agent_api;
mod agent_chat;
mod agent_history;
mod agent_provider;
mod agents;
mod bus;
mod canvas;
mod chat_index;
mod chat_room;
mod dispatch;
mod file_watch;
mod fsbrowse;
mod git;
mod git_ops;
mod git_watch;
mod mission_control;
mod world;
mod mission_migrations;
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
mod transcript;
mod usage_limits;
mod web;
mod workspaces;

/// Run the backend as a service: no window, no Dock icon.
///
/// `enabled` in web.json is deliberately ignored here. That flag decided whether
/// the old desktop app opened a port as a side effect; running this binary is
/// already the decision.
pub async fn run_headless() {
    // Refuse rather than fight. A service that silently overwrites another
    // copy's project list is worse than one that does not start.
    if let Err(owner) = profile_lock::acquire("server") {
        eprintln!("[server] {}", profile_lock::conflict_message(&owner));
        std::process::exit(1);
    }
    // Once, before anything can be running: tidy away transcripts no chat
    // points at any more.
    chat_index::reconcile();

    // `postgres::Client` is synchronous and internally starts work of its own.
    // Calling it on Tokio's main worker panics before the HTTP listener can
    // start, so boot migrations use the same blocking boundary as every web
    // command that touches the operational store.
    let migration_result =
        match tokio::task::spawn_blocking(mission_migrations::migrate_from_env).await {
            Ok(result) => result,
            Err(_) => Err("OctiqOS migration worker stopped unexpectedly.".to_string()),
        };
    match migration_result {
        Ok(mission_migrations::StartupMigration::Applied { count }) if count > 0 => {
            println!("[server] OctiqOS applied {count} database migration(s)");
        }
        Ok(mission_migrations::StartupMigration::Applied { .. }) => {
            println!("[server] OctiqOS database schema is current");
        }
        Ok(mission_migrations::StartupMigration::Skipped)
            if mission_migrations::database_required() =>
        {
            eprintln!("[server] OctiqOS requires DATABASE_URL, but it is not configured");
            std::process::exit(1);
        }
        Ok(mission_migrations::StartupMigration::Skipped) => {
            eprintln!("[server] OctiqOS database is not configured; /os will remain unavailable");
        }
        Err(why) if mission_migrations::database_required() => {
            eprintln!("[server] {why}");
            std::process::exit(1);
        }
        Err(why) => eprintln!("[server] {why}; OctiqOS will remain unavailable"),
    }

    let cfg = web::load_config();
    let services = dispatch::Services::load();
    println!("[server] OctiqFlow backend — no window, agents run here");
    web::start_headless(cfg, services).await;
}
