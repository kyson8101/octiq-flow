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
    /// Null if the session lock could not be read; never guessed.
    pub running: Option<bool>,
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
    sent: State,
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
        state: State,
        now: Instant,
        at: i64,
    ) -> Option<String> {
        let key = event.chat_key.as_ref()?;
        let incoming = Activity {
            key: key.clone(),
            seq: event.seq,
            state: state.clone(),
            last_activity_at: at,
            work: event.work,
        };
        let Some(window) = self.0.get_mut(key) else {
            let wire = incoming.wire();
            let mut latest = incoming;
            latest.work = false;
            self.0.insert(
                key.clone(),
                Window {
                    latest,
                    sent: state,
                    sent_at: now,
                    seen_at: now,
                    pending: false,
                },
            );
            return Some(wire);
        };
        let work = window.latest.work || incoming.work;
        window.latest = incoming;
        window.latest.work = work;
        window.seen_at = now;
        window.pending = true;
        if window.sent != state || now.duration_since(window.sent_at) >= GAP {
            Some(send(window, now))
        } else {
            None
        }
    }

    /// Flush the trailing window even when no next frame arrives. Also read
    /// the final busy state: a provider's last frame can be emitted just
    /// before its session records turn_ended, and must not leave a busy dot.
    pub fn flush(&mut self, now: Instant, mut state: impl FnMut(&str) -> State) -> Vec<String> {
        let mut wires = Vec::new();
        self.0.retain(|key, window| {
            let current = state(key);
            window.latest.state = current.clone();
            if window.sent != current
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
    window.sent = window.latest.state.clone();
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

    #[test]
    fn a_burst_keeps_work_and_flushes_its_last_sequence_once() {
        let mut feed = Feed::default();
        let now = Instant::now();
        assert!(feed
            .observe(&frame(1, json!({"type":"user"})), busy(true), now, 100)
            .is_some());
        for seq in 2..100 {
            assert!(feed
                .observe(
                    &frame(seq, json!({"type":"assistant"})),
                    busy(true),
                    now + Duration::from_millis(100),
                    200
                )
                .is_none());
        }
        assert!(feed
            .flush(now + Duration::from_millis(999), |_| busy(true))
            .is_empty());
        let wires = feed.flush(now + GAP, |_| busy(true));
        assert_eq!(wires.len(), 1);
        let p: Value = serde_json::from_str(&wires[0]).unwrap();
        assert_eq!(p["payload"]["seq"], 99);
        assert_eq!(p["payload"]["work"], true);
        assert_eq!(p["payload"]["lastActivityAt"], 200);
        assert!(feed.flush(now + GAP + GAP, |_| busy(true)).is_empty());
        assert_eq!(
            feed.flush(now + GAP + GAP, |_| busy(false)).len(),
            1,
            "a final busy flip without another stream frame is still sent"
        );
        feed.flush(now + KEEP + GAP, |_| busy(false));
        assert!(feed.0.is_empty());
    }

    #[test]
    fn busy_or_turn_changes_are_sent_without_waiting_for_the_window() {
        let mut feed = Feed::default();
        let now = Instant::now();
        feed.observe(&frame(1, json!({"type":"user"})), busy(true), now, 1);
        let wire = feed
            .observe(
                &frame(2, json!({"type":"result"})),
                busy(false),
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
                next,
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
