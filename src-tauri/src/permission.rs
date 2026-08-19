//! Questions the agent is waiting on.
//!
//! `claude -p` cannot prompt. A permission it has not been granted is simply
//! denied, and the only lever is `--permission-mode`, fixed when the process
//! spawns — so a chat client is a choice between an agent that can do nothing
//! and one that can do anything.
//!
//! This is the middle. A PreToolUse hook (scripts/hooks/permission-ask.cjs)
//! holds the tool call and asks here; this puts the question on the event bus,
//! waits for a person to answer it in the UI, and hands the answer back.
//!
//! Three rules shape everything below:
//!
//!   * **Never block on nobody.** With no browser attached, the answer is
//!     `Abstain`, immediately. A background run must not stall on a question no
//!     one can see.
//!   * **Silence is not consent.** If someone is watching but does not answer
//!     in time, the answer is `Deny`. The agent carries on and says it could
//!     not do the thing, which is recoverable; the alternative is not.
//!   * **Abstain is not deny.** Abstaining leaves the agent exactly as it would
//!     be without the hook, so the feature failing is never worse than the
//!     feature being absent.
use std::collections::HashMap;
use std::sync::Mutex;
use std::time::Duration;

use serde::{Deserialize, Serialize};
use tokio::sync::oneshot;

/// How long a watching user has to answer before the tool call is refused.
///
/// Long enough to pick up a phone, short enough that a forgotten question does
/// not hold a turn open indefinitely.
pub const ANSWER_TIMEOUT: Duration = Duration::from_secs(180);

/// What the user said.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Decision {
    Allow,
    Deny,
    /// No opinion — behave as though this hook were not installed.
    Abstain,
}

impl Decision {
    fn as_str(self) -> &'static str {
        match self {
            Decision::Allow => "allow",
            Decision::Deny => "deny",
            Decision::Abstain => "abstain",
        }
    }
}

/// What the hook tells us, and what the UI needs to draw the question.
#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Request {
    /// Which chat asked — the key OctiqFlow gave the agent process.
    pub chat_key: Option<String>,
    pub session_id: Option<String>,
    pub tool_name: Option<String>,
    /// The tool's own arguments, passed through untouched so the UI can show
    /// the file and its contents rather than just a tool name.
    pub tool_input: Option<serde_json::Value>,
    /// Matches the tool block already in the transcript, so the question can be
    /// attached to the exact call that raised it.
    pub tool_use_id: Option<String>,
    pub cwd: Option<String>,
}

/// The question as it goes out to the UI.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct Asked {
    id: String,
    #[serde(flatten)]
    request: Request,
}

/// The answer, as it goes back to the hook.
#[derive(Debug, Clone, Serialize)]
pub struct Answer {
    pub decision: &'static str,
    pub reason: String,
}

/// Questions waiting on a person, by id.
static PENDING: Mutex<Option<HashMap<String, oneshot::Sender<Decision>>>> = Mutex::new(None);

fn with_pending<T>(f: impl FnOnce(&mut HashMap<String, oneshot::Sender<Decision>>) -> T) -> T {
    let mut guard = PENDING.lock().unwrap_or_else(|e| e.into_inner());
    f(guard.get_or_insert_with(HashMap::new))
}

/// Ask, and wait for an answer.
pub async fn ask(request: Request) -> Answer {
    // Nobody is watching: do not hold the agent up for a question that would go
    // unseen. This is what keeps an unattended run behaving normally.
    if !crate::bus::clients_connected() {
        return Answer {
            decision: Decision::Abstain.as_str(),
            reason: "nobody is watching OctiqFlow".into(),
        };
    }

    let id = uuid::Uuid::new_v4().to_string();
    let (tx, rx) = oneshot::channel();
    with_pending(|p| p.insert(id.clone(), tx));

    crate::bus::emit(
        "permission-ask",
        Asked {
            id: id.clone(),
            request,
        },
    );

    // The reason travels to the agent, which repeats it to the user. A refusal
    // and a timeout are both a Deny, but they are not the same thing to the
    // person reading the answer — reporting "timed out" to someone who pressed
    // Deny is simply a lie about what happened.
    match tokio::time::timeout(ANSWER_TIMEOUT, rx).await {
        Ok(Ok(decision)) => Answer {
            decision: decision.as_str(),
            reason: match decision {
                Decision::Allow => "you allowed it".into(),
                Decision::Deny => "you denied it".into(),
                Decision::Abstain => "no opinion".into(),
            },
        },
        // Nobody answered, or the waiter was dropped. Silence is not consent:
        // the agent is told no and carries on.
        _ => {
            with_pending(|p| p.remove(&id));
            crate::bus::emit("permission-expired", serde_json::json!({ "id": id }));
            Answer {
                decision: Decision::Deny.as_str(),
                reason: "nobody answered in time".into(),
            }
        }
    }
}

/// Answer a waiting question. `false` when it is already gone — answered
/// twice, or expired while the tap was in flight.
pub fn decide(id: &str, decision: Decision) -> bool {
    let Some(tx) = with_pending(|p| p.remove(id)) else {
        return false;
    };
    tx.send(decision).is_ok()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn with_nobody_watching_it_abstains_rather_than_waiting() {
        // No client is attached in a test process, which is the same state as a
        // background run — the agent must not be held up.
        let answer = ask(Request {
            chat_key: None,
            session_id: None,
            tool_name: Some("Write".into()),
            tool_input: None,
            tool_use_id: None,
            cwd: None,
        })
        .await;
        assert_eq!(answer.decision, "abstain");
    }

    #[test]
    fn answering_an_unknown_question_is_refused_not_panicked() {
        assert!(!decide("no-such-id", Decision::Allow));
    }

    #[tokio::test]
    async fn a_question_can_only_be_answered_once() {
        let id = "only-once".to_string();
        let (tx, _rx) = oneshot::channel();
        with_pending(|p| p.insert(id.clone(), tx));

        assert!(decide(&id, Decision::Allow));
        // The second tap — a double click, or two devices — finds nothing.
        assert!(!decide(&id, Decision::Deny));
    }

    #[tokio::test]
    async fn a_refusal_and_a_timeout_are_reported_differently() {
        // Both deny, but the agent repeats the reason to the user, so calling a
        // deliberate refusal a timeout misinforms the person who pressed it.
        let id = "explicit".to_string();
        let (tx, rx) = oneshot::channel();
        with_pending(|p| p.insert(id.clone(), tx));
        assert!(decide(&id, Decision::Deny));

        let answered = rx.await.expect("the decision should arrive");
        assert_eq!(answered, Decision::Deny);

        // The timeout path words it its own way.
        let timed_out = Answer {
            decision: Decision::Deny.as_str(),
            reason: "nobody answered in time".into(),
        };
        assert_ne!(timed_out.reason, "you denied it");
    }

    #[test]
    fn a_decision_serializes_as_the_word_the_hook_expects() {
        assert_eq!(Decision::Allow.as_str(), "allow");
        assert_eq!(Decision::Deny.as_str(), "deny");
        assert_eq!(Decision::Abstain.as_str(), "abstain");
    }
}
