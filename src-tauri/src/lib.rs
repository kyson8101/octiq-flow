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
mod agent_avatar;
mod agent_chat;
mod agent_history;
mod agent_provider;
mod agent_usage;
mod agents;
mod auto_resume;
mod background_tasks;
mod bus;
mod canvas;
mod chat_index;
mod chat_search;
mod chat_task;
mod claude_allow;
mod codex_app_server;
mod diagnostics;
mod dispatch;
mod feedback;
mod file_watch;
mod fsbrowse;
mod git;
mod git_ops;
mod git_watch;
mod image_preview;
mod memory;
mod memory_activity;
mod memory_vault;
mod notify_hook;
mod orchestration;
mod paths;
mod permission;
mod pr_workflow;
mod proc;
mod profile;
mod profile_lock;
mod pty;
mod push;
mod question;
mod question_store;
mod record_trim;
mod safety_block;
mod sandbox;
mod team;
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
    agent_chat::start_deleted_chat_reaper();
    // Once per profile, off the startup path: old records lose the snapshot
    // reads they were recorded with (see record_trim.rs).
    std::thread::spawn(record_trim::prune_old_records);

    // Before anything can start a chat: the orchestration scheduler starts
    // workers from a plain thread, and their permission questions are waited
    // on here.
    agent_chat::remember_runtime(tokio::runtime::Handle::current());
    let cfg = web::load_config();
    // Before the scheduler can start a worker: every agent is told this port.
    web::remember_hook_port(cfg.port);
    let services = dispatch::Services::load();
    // Memory update lines whose intent a crash left unconfirmed are written
    // (or found already written) now, not only when that write is retried,
    // and a confirmed line a transcript has lost is written back. A
    // coordinator's line needs the orchestration ledger to say it still is.
    let orchestrations = services.orchestrations.clone();
    std::thread::spawn(move || memory_activity::recover(&orchestrations));
    println!("[server] OctiqFlow backend — no window, agents run here");
    web::start_headless(cfg, services).await;
}
