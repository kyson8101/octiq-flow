//! One place every event leaves the backend.
//!
//! Events used to go out through `AppHandle::emit`, which tied every producer
//! to a running Tauri app — and therefore to a window. That is the single
//! reason this backend could not run headless: `pty.rs` and `agent_chat.rs` do
//! not need a GUI to do their work, only to announce it.
//!
//! So the channel lives here instead, in process-global state, and anyone who
//! wants events subscribes:
//!
//! ```text
//!   pty.rs / agent_chat.rs / file_watch.rs
//!            │  bus::emit("pty-output", …)
//!            ▼
//!        ┌───────────┐
//!        │    bus    │
//!        └─────┬─────┘
//!      ┌───────┴────────┐
//!      ▼                ▼
//!  desktop sink     broadcast ──► every attached browser
//!  (set by the app,
//!   absent headless)
//! ```
//!
//! The desktop sink is optional and set once at startup by the Tauri app. With
//! no app there is simply no sink, and events go only to the sockets — which is
//! exactly what a headless server needs.
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};

use serde::Serialize;
use serde_json::json;
use tokio::sync::broadcast;

/// Frames a slow client may fall behind by before it starts losing them. A
/// streaming PTY produces a lot; this is a couple of seconds of it.
const EVENT_BACKLOG: usize = 512;

/// The fan-out to attached clients. One per process, created on first use.
static EVENTS: OnceLock<broadcast::Sender<String>> = OnceLock::new();

/// How many browsers are attached. Lives here rather than in the web server's
/// state because `pty.rs` needs the answer and has no business knowing whether
/// a Tauri app exists — it only wants to know whether anyone is watching.
static CLIENTS: AtomicUsize = AtomicUsize::new(0);

/// When a browser was last attached. `None` until the first one arrives.
///
/// This exists for one question: is nobody watching, or did somebody just press
/// reload? Both look identical to `CLIENTS` — a refresh closes the socket and
/// opens another a second later, and in between the count is zero. Anything
/// that answers "nobody is watching" in that gap is answering for a person who
/// is still there. See `watched_within`.
static LAST_SEEN: Mutex<Option<Instant>> = Mutex::new(None);

fn touch() {
    if let Ok(mut seen) = LAST_SEEN.lock() {
        *seen = Some(Instant::now());
    }
}

/// Count a client in, and out again when it leaves.
pub fn client_joined() {
    CLIENTS.fetch_add(1, Ordering::SeqCst);
    touch();
}

pub fn client_left() {
    CLIENTS.fetch_sub(1, Ordering::SeqCst);
    touch();
}

/// Whether any browser is attached right now.
pub fn clients_connected() -> bool {
    CLIENTS.load(Ordering::SeqCst) > 0
}

/// Whether anyone is watching, allowing for somebody who is on their way back.
///
/// A page reload is a disconnect: `clients_connected` goes false for a second
/// or two and then true again. Asking it alone is how a question the user was
/// about to be shown got answered "nobody is watching" instead — they were
/// there, they had simply pressed refresh.
///
/// `grace` is how long a gap may be before it counts as leaving. Callers that
/// are about to hold up an agent should use this; anything that only wants to
/// know whether to bother building an event can keep using
/// `clients_connected`.
pub fn watched_within(grace: Duration) -> bool {
    if clients_connected() {
        return true;
    }
    LAST_SEEN
        .lock()
        .ok()
        .and_then(|seen| *seen)
        .is_some_and(|at| at.elapsed() < grace)
}

/// Resolve once nobody has been watching for `grace` without interruption.
///
/// The other half of `watched_within`: a question that was worth asking when it
/// arrived stops being worth waiting on once the person it was for has really
/// gone. Without this, closing the browser mid-question would hold the agent
/// for the whole answer timeout with nobody left to answer.
pub async fn once_unwatched(grace: Duration) {
    let mut gone_since: Option<Instant> = None;
    loop {
        if clients_connected() {
            gone_since = None;
        } else {
            let since = *gone_since.get_or_insert_with(Instant::now);
            if since.elapsed() >= grace {
                return;
            }
        }
        tokio::time::sleep(Duration::from_millis(250)).await;
    }
}

/// The channel to subscribe to for the event stream.
pub fn events() -> &'static broadcast::Sender<String> {
    EVENTS.get_or_init(|| broadcast::channel(EVENT_BACKLOG).0)
}

/// Announce something to everyone listening.
pub fn emit<S: Serialize>(event: &str, payload: S) {
    let Ok(value) = serde_json::to_value(&payload) else {
        return;
    };
    let tx = events();
    // Nobody attached: the frame would be built and dropped.
    if tx.receiver_count() == 0 {
        return;
    }
    let frame = json!({ "t": "event", "event": event, "payload": value });
    if let Ok(text) = serde_json::to_string(&frame) {
        let _ = tx.send(text);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::Value;

    #[test]
    fn an_event_reaches_a_subscriber_as_a_wire_frame() {
        let mut rx = events().subscribe();
        emit("pty-output", json!({ "id": "t1", "chunk": "hello" }));

        // The bus is process-global on purpose — one fan-out per process is the
        // whole point — so a subscriber sees whatever else the process emits,
        // including other tests running beside this one. Read until our own
        // event turns up rather than assuming it is first.
        for _ in 0..32 {
            let Ok(text) = rx.try_recv() else { break };
            let frame: Value = serde_json::from_str(&text).unwrap();
            assert_eq!(frame["t"], "event");
            if frame["event"] == "pty-output" {
                assert_eq!(frame["payload"]["chunk"], "hello");
                return;
            }
        }
        panic!("the pty-output frame never arrived");
    }

    #[test]
    fn emitting_with_nobody_listening_is_not_an_error() {
        // No subscriber here — the point is that this does not panic or block,
        // because most events are emitted with nothing attached.
        emit("nobody-home", json!({ "x": 1 }));
    }

    #[test]
    fn a_browser_that_just_left_still_counts_as_watching() {
        // The reload case, and the reason this function exists. A refresh closes
        // the socket and opens another a moment later; asked in that gap,
        // `clients_connected` says nobody is there and a question meant for a
        // person gets answered on their behalf.
        client_joined();
        client_left();

        assert!(!clients_connected(), "the socket really is gone");
        assert!(
            watched_within(Duration::from_secs(60)),
            "but somebody was here a moment ago, so the question waits"
        );
        // With no grace at all it is the old answer, which is what an actually
        // unattended run should keep getting once the window has passed.
        assert!(!watched_within(Duration::ZERO));
    }
}
