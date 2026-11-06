//! Small, coalesced facts for an opt-in socket's unopened chats.
use super::Event;
use serde::Serialize;
use serde_json::{json, Value};
use std::collections::BTreeMap;
use std::time::{Duration, Instant};

const GAP: Duration = Duration::from_secs(1);
const KEEP: Duration = Duration::from_secs(60);

#[derive(Clone, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct State {
    /// Null only when a poisoned table prevents reading session existence.
    /// Contention defers the whole update instead of sending null fields.
    pub running: Option<bool>,
    /// Null if a poisoned table/session prevents reading the turn state.
    pub busy: Option<bool>,
    pub turn_id: Option<String>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct Activity {
    key: String,
    seq: Option<u64>,
    #[serde(flatten)]
    state: State,
    last_activity_at: i64,
    work: bool,
}

impl Activity {
    fn wire(&self) -> String {
        json!({"t":"event","event":"chat-stream-activity","payload":self}).to_string()
    }
}

struct Window {
    latest: Activity,
    sent: Option<State>,
    sent_at: Instant,
    seen_at: Instant,
    pending: bool,
}

/// Owned by one socket and dropped on disconnect. It never holds stream
/// bodies. Quiet entries expire so a long-lived tab doesn't grow a ledger.
#[derive(Default)]
pub struct Feed(BTreeMap<String, Window>);

impl Feed {
    pub fn observe(
        &mut self,
        event: &Event,
        state: Option<State>,
        now: Instant,
        at: i64,
    ) -> Option<String> {
        let key = event.chat_key.as_ref()?;
        let incoming = Activity {
            key: key.clone(),
            seq: event.seq,
            // Internal placeholder only: no update can be sent until a
            // successful read supplies the host's current state.
            state: state.clone().unwrap_or_default(),
            last_activity_at: at,
            work: event.work,
        };
        let Some(window) = self.0.get_mut(key) else {
            let wire = state.as_ref().map(|_| incoming.wire());
            let mut latest = incoming;
            if wire.is_some() {
                latest.work = false;
            }
            self.0.insert(
                key.clone(),
                Window {
                    latest,
                    sent: state,
                    sent_at: now,
                    seen_at: now,
                    pending: wire.is_none(),
                },
            );
            return wire;
        };
        let work = window.latest.work || incoming.work;
        window.latest = incoming;
        window.latest.work = work;
        window.seen_at = now;
        window.pending = true;
        // Keep seq/work/at, but neither emit nor change sent on contention.
        let state = state?;
        if window.sent.as_ref() != Some(&state) || now.duration_since(window.sent_at) >= GAP {
            Some(send(window, now))
        } else {
            None
        }
    }

    /// Flush the trailing window even when no next frame arrives. Also read
    /// the final busy state: a provider's last frame can be emitted just
    /// before its session records turn_ended, and must not leave a busy dot.
    /// A contended read (`None`) leaves the entry, pending work and last sent
    /// state intact for the next tick, even if the quiet-entry TTL elapsed.
    pub fn flush(
        &mut self,
        now: Instant,
        mut state: impl FnMut(&str) -> Option<State>,
    ) -> Vec<String> {
        let mut wires = Vec::new();
        self.0.retain(|key, window| {
            let Some(current) = state(key) else {
                return true;
            };
            window.latest.state = current.clone();
            if window.sent.as_ref() != Some(&current)
                || (window.pending && now.duration_since(window.sent_at) >= GAP)
            {
                wires.push(send(window, now));
            }
            now.duration_since(window.seen_at) < KEEP || window.pending
        });
        wires
    }
}

fn send(window: &mut Window, now: Instant) -> String {
    let wire = window.latest.wire();
    window.sent = Some(window.latest.state.clone());
    window.latest.work = false;
    window.sent_at = now;
    window.pending = false;
    wire
}

/// Mirrors web/src/lib/restoredPark.signOfWork, including the main-writer
/// exclusion. A tool result or host line cannot end a restored park.
pub fn sign_of_work(event: &Value) -> bool {
    if !event.is_object() || truthy(&event["parent_tool_use_id"]) || truthy(&event["octiq_speaker"])
    {
        return false;
    }
    if event["event"] == "step_update" {
        return true;
    }
    let Some(kind) = event["type"].as_str() else {
        return false;
    };
    if matches!(kind, "stream_event" | "assistant") {
        return true;
    }
    if kind == "item.completed" {
        return matches!(
            event["item"]["type"].as_str(),
            Some("agent_message" | "reasoning")
        );
    }
    kind.starts_with("item.")
}

fn truthy(value: &Value) -> bool {
    match value {
        Value::Null => false,
        Value::Bool(v) => *v,
        Value::String(v) => !v.is_empty(),
        Value::Number(v) => v.as_f64().is_some_and(|v| v != 0.0),
        _ => true,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn frame(seq: u64, event: Value) -> Event {
        Event::new(
            "chat-event",
            json!({"key":"chat:activity-test", "seq":seq, "event":event}),
        )
    }
    fn busy(busy: bool) -> State {
        State {
            running: Some(true),
            busy: Some(busy),
            turn_id: Some("turn".into()),
        }
    }

    // Exercise the real socket reader and Feed together. Release the held
    // lock even if the reader blocks, so a regression fails instead of hanging.
    fn contended_chat_lock(table: bool) {
        use crate::agent_chat::{chat_stream_state, ChatManager};
        use std::sync::{mpsc, Arc};

        let manager = Arc::new(ChatManager::default());
        let key = "chat:activity-test";
        let child = manager.test_hold(key, crate::agent_chat::ChatAgent::Claude, true);
        let now = Instant::now();
        let mut existing = Feed::default();
        existing.observe(
            &frame(1, json!({"type":"user"})),
            chat_stream_state(&manager, key),
            now,
            100,
        );
        manager.test_busy(key, false);
        let table_guard = table.then(|| manager.test_hold_table());
        let session_guard = (!table).then(|| child.test_hold_lock());
        let reader = manager.clone();
        let (done, completed) = mpsc::channel();
        let thread = std::thread::spawn(move || {
            let state = chat_stream_state(&reader, key);
            let read = serde_json::to_value(&state).unwrap();
            let mut fresh = Feed::default();
            let observed = fresh.observe(
                &frame(2, json!({"type":"assistant"})),
                state.clone(),
                now,
                200,
            );
            let existing_wires =
                existing.flush(now + KEEP + GAP, |key| chat_stream_state(&reader, key));
            let fresh_wires = fresh.flush(now + KEEP + GAP, |key| chat_stream_state(&reader, key));
            // A failed session read must not leave the table held either.
            if !table {
                drop(reader.test_hold_table());
            }
            done.send(()).unwrap();
            (read, observed, existing_wires, fresh_wires, existing, fresh)
        });
        let immediate = completed.recv_timeout(Duration::from_secs(2)).is_ok();
        drop(session_guard);
        drop(table_guard);
        let (read, observed, old_wires, new_wires, mut existing, mut fresh) =
            thread.join().unwrap();
        let recovered = existing.flush(now + KEEP + GAP, |key| chat_stream_state(&manager, key));
        let first = fresh.flush(now + KEEP + GAP, |key| chat_stream_state(&manager, key));
        manager.test_end(key);

        assert!(immediate, "the socket reader waited for a held chat lock");
        assert_eq!(
            read,
            Value::Null,
            "contention means not read, not unknown state"
        );
        assert!(observed.is_none());
        assert!(old_wires.is_empty());
        assert!(new_wires.is_empty());
        for wires in [recovered, first.clone()] {
            assert_eq!(wires.len(), 1, "retry must send the real state");
            let payload = serde_json::from_str::<Value>(&wires[0]).unwrap()["payload"].clone();
            assert_eq!(payload["running"], true);
            assert_eq!(payload["busy"], false);
        }
        let payload = serde_json::from_str::<Value>(&first[0]).unwrap()["payload"].clone();
        assert_eq!(payload["seq"], 2);
        assert_eq!(
            payload["work"], true,
            "retain omitted work until a readable state"
        );
    }

    #[test]
    fn held_session_lock_defers_activity_until_the_next_readable_flush() {
        contended_chat_lock(false);
    }

    #[test]
    fn held_table_lock_defers_activity_until_the_next_readable_flush() {
        contended_chat_lock(true);
    }

    #[test]
    fn a_missing_session_is_read_as_stopped_and_idle() {
        let manager = crate::agent_chat::ChatManager::default();
        let state = crate::agent_chat::chat_stream_state(&manager, "chat:missing");
        assert!(
            state.is_some(),
            "missing is a readable state, not contention"
        );
        let state = serde_json::to_value(state).unwrap();
        assert_eq!(state, json!({"running":false,"busy":false,"turnId":null}));
    }

    #[test]
    fn a_contended_observation_keeps_sent_and_coalesces_its_work() {
        let mut feed = Feed::default();
        let now = Instant::now();
        feed.observe(
            &frame(1, json!({"type":"user"})),
            Some(busy(true)),
            now,
            100,
        );
        for (seq, event) in [
            (2, json!({"type":"assistant"})),
            (3, json!({"type":"result"})),
        ] {
            assert!(feed.observe(&frame(seq, event), None, now, 200).is_none());
        }
        assert!(feed.flush(now + GAP, |_| None).is_empty());
        let window = &feed.0["chat:activity-test"];
        assert!(window.sent.as_ref() == Some(&busy(true)));
        assert_eq!(window.sent_at, now);
        assert!(window.pending);
        let wires = feed.flush(now + GAP, |_| Some(busy(true)));
        assert_eq!(wires.len(), 1);
        let payload = serde_json::from_str::<Value>(&wires[0]).unwrap()["payload"].clone();
        assert_eq!(payload["seq"], 3);
        assert_eq!(payload["lastActivityAt"], 200);
        assert_eq!(payload["work"], true);
        assert!(feed.flush(now + GAP + GAP, |_| Some(busy(true))).is_empty());
    }

    #[test]
    fn a_burst_keeps_work_and_flushes_its_last_sequence_once() {
        let mut feed = Feed::default();
        let now = Instant::now();
        assert!(feed
            .observe(
                &frame(1, json!({"type":"user"})),
                Some(busy(true)),
                now,
                100
            )
            .is_some());
        for seq in 2..100 {
            assert!(feed
                .observe(
                    &frame(seq, json!({"type":"assistant"})),
                    Some(busy(true)),
                    now + Duration::from_millis(100),
                    200
                )
                .is_none());
        }
        assert!(feed
            .flush(now + Duration::from_millis(999), |_| Some(busy(true)))
            .is_empty());
        let wires = feed.flush(now + GAP, |_| Some(busy(true)));
        assert_eq!(wires.len(), 1);
        let p: Value = serde_json::from_str(&wires[0]).unwrap();
        assert_eq!(p["payload"]["seq"], 99);
        assert_eq!(p["payload"]["work"], true);
        assert_eq!(p["payload"]["lastActivityAt"], 200);
        assert!(feed.flush(now + GAP + GAP, |_| Some(busy(true))).is_empty());
        assert_eq!(
            feed.flush(now + GAP + GAP, |_| Some(busy(false))).len(),
            1,
            "a final busy flip without another stream frame is still sent"
        );
        feed.flush(now + KEEP + GAP, |_| Some(busy(false)));
        assert!(feed.0.is_empty());
    }

    #[test]
    fn busy_or_turn_changes_are_sent_without_waiting_for_the_window() {
        let mut feed = Feed::default();
        let now = Instant::now();
        feed.observe(&frame(1, json!({"type":"user"})), Some(busy(true)), now, 1);
        let wire = feed
            .observe(
                &frame(2, json!({"type":"result"})),
                Some(busy(false)),
                now + Duration::from_millis(1),
                2,
            )
            .unwrap();
        assert_eq!(
            serde_json::from_str::<Value>(&wire).unwrap()["payload"]["busy"],
            false
        );
        let mut next = busy(true);
        next.turn_id = Some("next".into());
        assert!(feed
            .observe(
                &frame(3, json!({"type":"turn.started"})),
                Some(next),
                now + Duration::from_millis(2),
                3
            )
            .is_some());
    }

    #[test]
    fn work_matches_the_main_writer_definition() {
        for e in [
            json!({"type":"assistant"}),
            json!({"type":"stream_event"}),
            json!({"type":"item.started"}),
            json!({"type":"item.updated"}),
            json!({"type":"item.completed","item":{"type":"agent_message"}}),
            json!({"type":"item.completed","item":{"type":"reasoning"}}),
            json!({"event":"step_update"}),
        ] {
            assert!(sign_of_work(&e), "{e}");
        }
        for e in [
            json!(null),
            json!({"type":"user"}),
            json!({"type":"octiq_user_turn_delivery"}),
            json!({"type":"result"}),
            json!({"type":"item.completed","item":{"type":"command_execution"}}),
            json!({"type":"stream_event","parent_tool_use_id":"subagent"}),
            json!({"type":"assistant","octiq_speaker":"seat"}),
            json!({"event":"step_update","octiq_speaker":{"id":"seat"}}),
        ] {
            assert!(!sign_of_work(&e), "{e}");
        }
    }
}
