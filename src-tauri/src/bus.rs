//! Shared event frames for browser sockets, with opt-in per-chat routing.
//!
//! Producers serialize once. Each socket chooses its live chats; legacy
//! sockets still get the complete stream. Small status/card/index events
//! stay global, and unopened chats get coalesced activity without text.
use std::collections::{BTreeMap, BTreeSet};
use std::ops::Deref;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, Instant};

use serde::Serialize;
use serde_json::{json, Value};
use tokio::sync::broadcast;

pub mod activity;

/// Frames a slow client may fall behind by before it starts losing them. A
/// streaming PTY produces a lot; this is a couple of seconds of it.
const EVENT_BACKLOG: usize = 512;

/// The fan-out to attached clients. One per process, created on first use.
static EVENTS: OnceLock<broadcast::Sender<Arc<Event>>> = OnceLock::new();

/// Serialize once, route without parsing a provider's (possibly huge) JSON
/// again for every socket. Broadcast receivers share the bytes until send.
pub struct Event {
    wire: String,
    chat_key: Option<String>,
    seq: Option<u64>,
    work: bool,
    /// Opt-in pages need execution status, never lastProgress/tool bodies.
    compact: Option<String>,
}

impl Event {
    pub fn chat_key(&self) -> &str {
        self.chat_key.as_deref().unwrap_or_default()
    }
    fn new(event: &str, payload: Value) -> Self {
        let chat_key = (event == "chat-event")
            .then(|| payload["key"].as_str().map(str::to_owned))
            .flatten();
        let seq = payload["seq"].as_u64();
        let work = chat_key.is_some() && activity::sign_of_work(&payload["event"]);
        let compact =
            (event == "orchestration-changed" && payload["execution"].is_object()).then(|| {
                let mut small = payload.clone();
                crate::orchestration::summary::compact_execution(&mut small["execution"]);
                json!({"t":"event", "event":event, "payload":small}).to_string()
            });
        Self {
            wire: json!({"t":"event", "event":event, "payload":payload}).to_string(),
            chat_key,
            seq,
            work,
            compact,
        }
    }
}

impl Deref for Event {
    type Target = str;
    fn deref(&self) -> &str {
        &self.wire
    }
}

impl std::fmt::Display for Event {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.wire)
    }
}

/// None is deliberately different from an empty subscription: old pages
/// have never sent the command and must still receive the original frames.
#[derive(Default)]
pub struct ChatSubscriptions(Option<BTreeSet<String>>);

impl ChatSubscriptions {
    pub fn replace(&mut self, keys: Vec<String>) -> Result<Vec<String>, String> {
        if keys.len() > 64 || keys.iter().any(|key| key.is_empty() || key.len() > 512) {
            return Err(
                "chat_subscribe accepts at most 64 nonempty chat keys, each at most 512 bytes"
                    .into(),
            );
        }
        let keys: BTreeSet<_> = keys.into_iter().collect();
        let result = keys.iter().cloned().collect();
        self.0 = Some(keys);
        Ok(result)
    }

    pub fn accepts(&self, event: &Event) -> bool {
        self.0
            .as_ref()
            .is_none_or(|keys| event.chat_key.as_ref().is_none_or(|key| keys.contains(key)))
    }

    pub fn wire<'a>(&self, event: &'a Event) -> Option<&'a str> {
        if !self.accepts(event) {
            return None;
        }
        if self.0.is_some() {
            if let Some(compact) = &event.compact {
                return Some(compact);
            }
        }
        Some(&event.wire)
    }
}

#[derive(Default)]
struct Revisions {
    sequence: u64,
    runs: BTreeMap<String, u64>,
}
static REVISIONS: Mutex<Revisions> = Mutex::new(Revisions {
    sequence: 0,
    runs: BTreeMap::new(),
});
static EPOCH: OnceLock<String> = OnceLock::new();

fn revision(sequence: u64) -> String {
    format!(
        "{}:{sequence}",
        EPOCH.get_or_init(|| uuid::Uuid::new_v4().simple().to_string())
    )
}

/// Read-time invalidation tokens, never saved into the ledger or accepted
/// from an agent. A new server has a new epoch, even before its first change.
pub struct RevisionRead {
    global: String,
    runs: BTreeMap<String, String>,
}

pub fn orchestration_revisions() -> RevisionRead {
    let revisions = REVISIONS.lock().unwrap_or_else(|e| e.into_inner());
    RevisionRead {
        global: revision(revisions.sequence),
        runs: revisions
            .runs
            .iter()
            .map(|(key, seq)| (key.clone(), revision(*seq)))
            .collect(),
    }
}

impl RevisionRead {
    pub fn stamp(&self, view: &mut Value, run_id: Option<&str>) {
        let token = |id: &str| self.runs.get(id).cloned().unwrap_or_else(|| revision(0));
        view["revision"] = json!(run_id.map(token).unwrap_or_else(|| self.global.clone()));
        let mut selected = BTreeMap::new();
        for run in view["runs"].as_array_mut().into_iter().flatten() {
            if let Some(id) = run["id"].as_str().map(str::to_owned) {
                let rev = token(&id);
                run["revision"] = json!(rev);
                selected.insert(id, rev);
            }
        }
        view["runRevisions"] = json!(selected);
    }
}

/// How many browsers are attached. Lives here rather than in the web server's
/// state because `pty.rs` only needs to know whether anyone is watching.
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
pub fn events() -> &'static broadcast::Sender<Arc<Event>> {
    EVENTS.get_or_init(|| broadcast::channel(EVENT_BACKLOG).0)
}

/// Announce something to everyone listening.
pub fn emit<S: Serialize>(event: &str, payload: S) {
    let Ok(mut value) = serde_json::to_value(&payload) else {
        return;
    };
    // Both ordinary changes and execution patches pass this door. Advance
    // even with no browser attached, so a reconnect's summary has a token.
    if event == "orchestration-changed" {
        if let Some(run) = value["runId"].as_str().map(str::to_owned) {
            let mut revisions = REVISIONS.lock().unwrap_or_else(|e| e.into_inner());
            revisions.sequence += 1;
            let seq = revisions.sequence;
            revisions.runs.insert(run, seq);
            value["revision"] = json!(revision(seq));
        }
    }
    #[cfg(test)]
    tap::hear(event, &value);
    let tx = events();
    // Nobody attached: the frame would be built and dropped.
    if tx.receiver_count() == 0 {
        return;
    }
    let _ = tx.send(Arc::new(Event::new(event, value)));
}

/// How a test reads back what was emitted about one thing, in order.
///
/// The broadcast channel is shared by every test in the process and drops
/// the oldest frames of a reader that falls behind, so "was A said before B"
/// cannot be asked of it under a loaded suite. A tap keeps every event whose
/// payload names its needle (a chat id, say), in the order `emit` was called.
#[cfg(test)]
pub(crate) mod tap {
    use std::sync::{Arc, Mutex};

    use serde_json::Value;

    type Heard = Arc<Mutex<Vec<(String, Value)>>>;

    static TAPS: Mutex<Vec<(String, Heard)>> = Mutex::new(Vec::new());

    pub(crate) struct Tap {
        needle: String,
        heard: Heard,
    }

    impl Tap {
        /// Hear every event from now on whose payload contains `needle`.
        pub(crate) fn on(needle: &str) -> Self {
            let heard = Heard::default();
            TAPS.lock()
                .unwrap_or_else(|e| e.into_inner())
                .push((needle.to_string(), heard.clone()));
            Self {
                needle: needle.to_string(),
                heard,
            }
        }

        /// `(event, payload)` for everything heard so far, oldest first.
        pub(crate) fn heard(&self) -> Vec<(String, Value)> {
            self.heard.lock().unwrap_or_else(|e| e.into_inner()).clone()
        }
    }

    impl Drop for Tap {
        fn drop(&mut self) {
            TAPS.lock()
                .unwrap_or_else(|e| e.into_inner())
                .retain(|(needle, heard)| {
                    needle != &self.needle || !Arc::ptr_eq(heard, &self.heard)
                });
        }
    }

    pub(super) fn hear(event: &str, payload: &Value) {
        let taps = TAPS.lock().unwrap_or_else(|e| e.into_inner());
        if taps.is_empty() {
            return;
        }
        let text = payload.to_string();
        for (needle, heard) in taps.iter() {
            if text.contains(needle.as_str()) {
                heard
                    .lock()
                    .unwrap_or_else(|e| e.into_inner())
                    .push((event.to_string(), payload.clone()));
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::Value;

    #[test]
    fn legacy_wire_is_unchanged_and_opt_in_execution_is_small() {
        let payload = json!({"key":"chat:legacy", "seq":9, "event":{"text":"x".repeat(100_000)}});
        let event = Event::new("chat-event", payload.clone());
        let legacy = ChatSubscriptions::default();
        assert_eq!(
            legacy.wire(&event).unwrap(),
            json!({"t":"event","event":"chat-event","payload":payload}).to_string()
        );
        let mut selected = ChatSubscriptions::default();
        selected.replace(vec![]).unwrap();
        assert!(selected.wire(&event).is_none());
        let payload = json!({"runId":"r","revision":"epoch:1","change":"worker_execution","execution":{"state":"waiting_tool","lastProgress":"x".repeat(100_000),"pendingTools":{"t":"x".repeat(100_000)}}});
        let event = Event::new("orchestration-changed", payload.clone());
        assert_eq!(
            serde_json::from_str::<Value>(legacy.wire(&event).unwrap()).unwrap()["payload"],
            payload
        );
        let wire = selected.wire(&event).unwrap();
        assert!(wire.len() < 512);
        let value: Value = serde_json::from_str(wire).unwrap();
        assert_eq!(value["payload"]["execution"]["state"], "waiting_tool");
        assert_eq!(value["payload"]["revision"], "epoch:1");
    }

    #[test]
    fn changed_events_and_reads_share_per_run_revision_tokens() {
        let id = "bus-revision-test-run";
        let tap = tap::Tap::on(id);
        emit("orchestration-changed", json!({"runId":id,"change":"task"}));
        let mut view = json!({"runs":[{"id":id},{"id":"bus-unrelated-run"}]});
        orchestration_revisions().stamp(&mut view, Some(id));
        let first = view["revision"].clone();
        assert_eq!(tap.heard().last().unwrap().1["revision"], first);
        assert_eq!(view["runs"][0]["revision"], first);
        let unrelated = view["runs"][1]["revision"].clone();
        emit(
            "orchestration-changed",
            json!({"runId":id,"change":"worker_execution","execution":{"state":"executing"}}),
        );
        orchestration_revisions().stamp(&mut view, Some(id));
        assert_ne!(view["revision"], first);
        assert_eq!(view["runs"][1]["revision"], unrelated);
        assert_eq!(view["revision"], tap.heard().last().unwrap().1["revision"]);
    }

    #[test]
    fn subscriptions_are_opt_in_and_keep_status_global() {
        let own = Event::new(
            "chat-event",
            json!({"key":"chat:one", "event":{"delta":"text"}}),
        );
        let other = Event::new(
            "chat-event",
            json!({"key":"chat:two", "event":{"delta":"text"}}),
        );
        let mut subscriptions = ChatSubscriptions::default();
        assert!(subscriptions.accepts(&own));
        assert!(subscriptions.accepts(&other), "old pages keep every frame");
        subscriptions.replace(vec!["chat:one".into()]).unwrap();
        assert!(subscriptions.accepts(&own));
        assert!(!subscriptions.accepts(&other));
        for kind in [
            "chat-status",
            "chat-task",
            "chat-index-changed",
            "chat-completed",
            "permission-ask",
            "safety-blocked",
            "user-question",
            "orchestration-changed",
            "pty-output",
        ] {
            assert!(
                subscriptions.accepts(&Event::new(kind, json!({"key":"chat:two"}))),
                "{kind} must remain global"
            );
        }
        subscriptions.replace(vec![]).unwrap();
        assert!(!subscriptions.accepts(&own));
        assert!(
            ChatSubscriptions::default().accepts(&own),
            "a new socket starts in legacy mode; resubscribe on reconnect"
        );
    }

    #[test]
    fn an_invalid_subscription_does_not_replace_the_current_selection() {
        let mut subscriptions = ChatSubscriptions::default();
        subscriptions
            .replace(vec!["chat:one".into(), "chat:one".into()])
            .unwrap();
        assert!(subscriptions.replace(vec!["x".repeat(513)]).is_err());
        assert!(subscriptions
            .replace((0..65).map(|i| format!("chat:{i}")).collect())
            .is_err());
        assert!(subscriptions.accepts(&Event::new("chat-event", json!({"key":"chat:one"}))));
        assert!(!subscriptions.accepts(&Event::new("chat-event", json!({"key":"chat:two"}))));
    }

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
