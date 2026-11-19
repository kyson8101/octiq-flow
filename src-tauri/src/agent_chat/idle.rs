use super::*;

/// How long a chat may sit with nothing happening before its process is ended.
///
/// Ending one is cheap because nothing is lost: every event is already written
/// down (`transcript.rs`), the agent's own session id is kept in the chat
/// index, and the client's send path already starts a chat it has no process
/// for with `resume` — the same two calls it makes for a chat picked back up
/// the next morning. So the next message carries on the conversation and the
/// only thing the person sees is that the live dot was off.
///
/// What it buys is real: on one machine nine chats left open overnight held
/// 4.3 GB between them — about 480 MB each, once each agent's own MCP servers
/// are counted.
pub(super) const IDLE_TIMEOUT: Duration = Duration::from_secs(5 * 60);

/// How often the sweeper looks. Well under the timeout, and cheap: it takes one
/// lock, reads a flag and an `Instant` per chat, and goes back to sleep.
pub(super) const IDLE_SWEEP: Duration = Duration::from_secs(60);

/// The timeout in force, which `OCTIQ_CHAT_IDLE_MINS` may change. `0` turns the
/// sweeper off altogether, for anyone who would rather pay the memory than have
/// a process end behind their back.
pub(super) fn idle_timeout() -> Option<Duration> {
    match std::env::var("OCTIQ_CHAT_IDLE_MINS")
        .ok()
        .and_then(|v| v.trim().parse::<u64>().ok())
    {
        Some(0) => None,
        Some(mins) => Some(Duration::from_secs(mins * 60)),
        None => Some(IDLE_TIMEOUT),
    }
}

/// The chats that have been sitting still for longer than timeout.
pub(super) fn still_keys(manager: &ChatManager, timeout: Duration) -> Vec<String> {
    let Ok(sessions) = manager.sessions.lock() else {
        return Vec::new();
    };
    sessions
        .iter()
        .filter(|(_, s)| {
            s.lock()
                .ok()
                .and_then(|s| s.still_for())
                .is_some_and(|still| still >= timeout)
        })
        .map(|(key, _)| key.clone())
        .collect()
}

/// End every chat that has been sitting still too long.
pub(super) fn sweep_still_chats(manager: &ChatManager, timeout: Duration) -> Vec<String> {
    let mut ended = Vec::new();
    for key in still_keys(manager, timeout) {
        if end_process_when(manager, &key, Some(timeout)) == Ok(true) {
            ended.push(key);
        }
    }
    ended
}

/// End every idle chat whose agent program an upgrade removed
/// (`ChatManager::replaced_binary_keys`). `Duration::ZERO` still makes
/// `end_process_when` re-check, under its locks, that no turn and no
/// background work started in between.
pub(super) fn sweep_replaced_binaries(manager: &ChatManager) -> Vec<String> {
    manager
        .replaced_binary_keys()
        .into_iter()
        .filter(|key| end_process_when(manager, key, Some(Duration::ZERO)) == Ok(true))
        .collect()
}

/// Watch for chats nobody is using and give their memory back.
pub fn start_idle_reaper(manager: Arc<ChatManager>) {
    let Some(timeout) = idle_timeout() else {
        println!("[chat] idle sweeper off (OCTIQ_CHAT_IDLE_MINS=0)");
        return;
    };
    println!(
        "[chat] idle sweeper on: a chat with nothing happening for {} minutes is ended and resumed on its next message",
        timeout.as_secs() / 60
    );
    thread::spawn(move || loop {
        thread::sleep(IDLE_SWEEP);
        for key in sweep_still_chats(&manager, timeout) {
            println!("[chat] {key} ended after {}m still", timeout.as_secs() / 60);
            // Every message in it has stopped, so its stream pieces can go.
            crate::record_trim::compact_chat(&manager, &key);
        }
        for key in sweep_replaced_binaries(&manager) {
            println!("[chat] {key} ended: the agent program it runs was replaced on disk");
        }
    });
}
