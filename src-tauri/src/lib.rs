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
mod diagnostics;
mod dispatch;
mod file_watch;
mod fsbrowse;
mod git;
mod git_ops;
mod git_watch;
mod memory;
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

    let cfg = web::load_config();
    let services = dispatch::Services::load();
    println!("[server] OctiqFlow backend — no window, agents run here");
    web::start_headless(cfg, services).await;
}
