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
use std::sync::OnceLock;

use serde::Serialize;
use serde_json::{json, Value};
use tokio::sync::broadcast;

/// Frames a slow client may fall behind by before it starts losing them. A
/// streaming PTY produces a lot; this is a couple of seconds of it.
const EVENT_BACKLOG: usize = 512;

/// The fan-out to attached clients. One per process, created on first use.
static EVENTS: OnceLock<broadcast::Sender<String>> = OnceLock::new();

/// Where events also go when a desktop window exists. `None` headless.
type DesktopSink = Box<dyn Fn(&str, Value) + Send + Sync>;
static DESKTOP: OnceLock<DesktopSink> = OnceLock::new();

/// The channel to subscribe to for the event stream.
pub fn events() -> &'static broadcast::Sender<String> {
    EVENTS.get_or_init(|| broadcast::channel(EVENT_BACKLOG).0)
}

/// Mirror every event into a desktop window as well. Called once by the Tauri
/// app at startup; calling it again is ignored, since a second sink would
/// double every event.
pub fn set_desktop_sink(sink: impl Fn(&str, Value) + Send + Sync + 'static) {
    let _ = DESKTOP.set(Box::new(sink));
}

/// Announce something to everyone listening.
///
/// Serialized ONCE and shared: the desktop window and the sockets want the same
/// bytes, and an event on a busy PTY is emitted often enough for that to matter.
pub fn emit<S: Serialize>(event: &str, payload: S) {
    let Ok(value) = serde_json::to_value(&payload) else {
        return;
    };
    if let Some(sink) = DESKTOP.get() {
        sink(event, value.clone());
    }
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
}
