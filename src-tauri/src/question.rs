//! Letting the agent ask you something.
//!
//! `claude -p` is not offered `AskUserQuestion` at all. That is not the SDK
//! lacking it — the SDK routes it to a `canUseTool` callback — it is that print
//! mode has nobody to answer, so the tool never reaches the model.
//!
//! We can hand it one. `-p` loads MCP servers in full (78 skills, 8 servers,
//! all present), so a tool of our own is a first-class tool as far as the agent
//! is concerned. It calls `ask_user`, the call blocks, the question appears
//! wherever you are, and your answer comes back as the tool result.
//!
//! This is the same shape as `permission.rs` and differs in what an answer IS:
//! a permission is allow-or-deny with a safe default, a question is a choice
//! among options with no safe default at all — which is why a timeout here
//! tells the agent nobody answered rather than picking for you.
use std::collections::HashMap;
use std::sync::Mutex;
use std::time::Duration;

use serde::{Deserialize, Serialize};
use tokio::sync::oneshot;

/// How long the agent waits. Longer than a permission prompt: a question is
/// something you have to think about, and it holds up nothing but its own turn.
pub const ANSWER_TIMEOUT: Duration = Duration::from_secs(600);

/// How long a break in the connection may be before it counts as leaving.
///
/// A page reload drops the socket for a second or two. Reading that as "nobody
/// is watching" is how a question asked at the wrong moment came back answered
/// before the user ever saw it — and it is the same gap that used to strand a
/// question already on screen. Generous on purpose: a phone rejoining a network
/// takes longer than a laptop, and the cost of waiting a few extra seconds for
/// somebody who has genuinely gone is far smaller than the cost of speaking for
/// somebody who has not.
pub const RELOAD_GRACE: Duration = Duration::from_secs(20);

/// What the agent wants to know.
#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Question {
    /// Which chat is asking.
    pub chat_key: Option<String>,
    pub question: String,
    /// Choices to offer. Empty means any answer will do, so the UI asks for
    /// text instead of showing buttons.
    #[serde(default)]
    pub options: Vec<String>,
    /// Which option the agent would pick, as an INDEX into `options`.
    ///
    /// An index rather than a flag on each choice, because "recommended" is
    /// singular by nature: a recommendation among three recommendations is not
    /// one. An index cannot express two, so the shape enforces what a comment
    /// would only ask for.
    ///
    /// This stays ADVISORY. It is not a default and must never become one — the
    /// timeout still reports that nobody answered rather than taking this, for
    /// the reason in the module header: a question has no safe default. It says
    /// what the agent thinks, so you can disagree with it quickly.
    #[serde(default)]
    pub recommended: Option<usize>,
}

/// The question, once it has an id to answer against.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Asked {
    id: String,
    #[serde(flatten)]
    question: Question,
}

/// One question, and the channel its answer goes back down.
///
/// The question is kept beside the channel rather than being dropped once it
/// has been announced. It is announced ONCE, over a broadcast nobody can replay
/// — so a browser that reloads mid-question had no way to learn the question
/// existed, while the agent went on waiting ten minutes for an answer to
/// something no longer on anyone's screen. `pending` is how it gets it back.
struct Waiting {
    tx: oneshot::Sender<String>,
    asked: Asked,
}

static PENDING: Mutex<Option<HashMap<String, Waiting>>> = Mutex::new(None);

fn with_pending<T>(f: impl FnOnce(&mut HashMap<String, Waiting>) -> T) -> T {
    let mut guard = PENDING.lock().unwrap_or_else(|e| e.into_inner());
    f(guard.get_or_insert_with(HashMap::new))
}

/// Every question still waiting on an answer.
///
/// Asked by a browser as soon as it connects, which is what makes a reload — or
/// arriving on a second device — pick up a question already in flight instead
/// of staring at a chat that looks stuck.
pub fn pending() -> Vec<Asked> {
    with_pending(|p| p.values().map(|w| w.asked.clone()).collect())
}

/// Put the question in front of the user and wait.
///
/// The string that comes back is what the agent is told. When nobody is there
/// to ask, or nobody answers, it is told exactly that — a question with no
/// answer must never be reported as an answer, because the agent will act on
/// whatever it is given.
pub async fn ask(question: Question) -> String {
    if !crate::bus::watched_within(RELOAD_GRACE) {
        return "Nobody is watching OctiqFlow, so this question could not be asked. \
                Proceed without it, or say what you would need to know."
            .into();
    }

    let id = uuid::Uuid::new_v4().to_string();
    let (tx, rx) = oneshot::channel();
    let asked = Asked {
        id: id.clone(),
        question,
    };
    with_pending(|p| {
        p.insert(
            id.clone(),
            Waiting {
                tx,
                asked: asked.clone(),
            },
        )
    });

    crate::bus::emit("user-question", asked);

    // Three ways this ends, and they are not the same thing to tell an agent.
    //
    // The watcher is why a reload is survivable. A gap in the connection no
    // longer decides anything: the question stays up, the browser coming back
    // asks for it through `pending`, and only somebody who is really gone —
    // away for `RELOAD_GRACE` without returning — releases the turn.
    let outcome = tokio::select! {
        answered = tokio::time::timeout(ANSWER_TIMEOUT, rx) => match answered {
            Ok(Ok(answer)) => return answer,
            _ => "The user did not answer in time. Do not assume an answer — say what \
                  you need and stop, or continue in a way that does not depend on it.",
        },
        _ = crate::bus::once_unwatched(RELOAD_GRACE) => {
            "Nobody is watching OctiqFlow any more, so this question went unanswered. \
             Proceed without it, or say what you would need to know."
        }
    };

    with_pending(|p| p.remove(&id));
    crate::bus::emit("question-expired", serde_json::json!({ "id": id }));
    outcome.into()
}

/// Answer a waiting question. `false` when it is already gone.
///
/// Every attached browser was shown this question, and answering it on one of
/// them leaves the card sitting on all the others — still asking something that
/// has already been decided, and still tappable, which is worse: the second tap
/// finds nothing to answer and does nothing at all, with no way to tell that
/// from a tap that failed. So the same event a timeout sends goes out here too.
/// It says one thing, "this question is over"; how it ended is the agent's news
/// to give, in the answer it is now free to act on.
pub fn answer(id: &str, choice: String) -> bool {
    let Some(waiting) = with_pending(|p| p.remove(id)) else {
        return false;
    };
    let delivered = waiting.tx.send(choice).is_ok();
    crate::bus::emit("question-expired", serde_json::json!({ "id": id }));
    delivered
}

#[cfg(test)]
mod tests {
    use super::*;

    fn question() -> Question {
        Question {
            chat_key: None,
            question: "Which database?".into(),
            options: vec!["Postgres".into(), "SQLite".into()],
            recommended: Some(0),
        }
    }

    #[test]
    fn a_recommendation_is_never_an_answer() {
        // The whole point of the marker is that it is advisory. If it ever
        // leaks into the answer path, a question the user ignored starts
        // getting answered on their behalf — which is exactly what the module
        // header says must not happen.
        let q = question();
        assert_eq!(q.recommended, Some(0));
        // Serialising and reading it back must not turn it into a selection:
        // the only fields that carry an answer are elsewhere entirely.
        let json = serde_json::to_string(&q).expect("serialises");
        assert!(json.contains("\"recommended\":0"));
        assert!(!json.contains("answer"));
    }

    #[test]
    fn a_question_without_a_view_simply_has_none() {
        // Omitted by the agent, absent in the JSON, None here — no default
        // creeping in at any layer.
        let q: Question = serde_json::from_str(r#"{"question":"Which one?","options":["a","b"]}"#)
            .expect("parses without a recommendation");
        assert_eq!(q.recommended, None);
    }

    #[tokio::test]
    async fn with_nobody_watching_the_agent_is_told_so() {
        let reply = ask(question()).await;
        // The agent must be able to tell "no answer" from an answer. Returning
        // an empty string or a default would have it act on a choice the user
        // never made.
        assert!(reply.contains("Nobody is watching"), "{reply}");
    }

    #[tokio::test]
    async fn a_waiting_question_can_be_asked_for_again() {
        // What a reloaded page reads. The question is announced once, on a
        // broadcast with no replay, so a browser that was not attached at that
        // moment — or was mid-refresh — has no other way to learn it exists,
        // and the agent is meanwhile holding its turn open for ten minutes.
        let id = "q-pending".to_string();
        let (tx, _rx) = oneshot::channel();
        with_pending(|p| {
            p.insert(
                id.clone(),
                Waiting {
                    tx,
                    asked: Asked {
                        id: id.clone(),
                        question: question(),
                    },
                },
            )
        });

        let waiting = pending();
        assert!(
            waiting.iter().any(|a| a.id == id),
            "a question still waiting has to be findable"
        );

        // And it stops being offered the moment it is answered, or the reloaded
        // page would draw a card for something already decided.
        assert!(answer(&id, "SQLite".into()));
        assert!(!pending().iter().any(|a| a.id == id));
    }

    #[test]
    fn answering_an_unknown_question_is_refused() {
        assert!(!answer("no-such-id", "Postgres".into()));
    }

    #[tokio::test]
    async fn an_answer_reaches_the_waiting_agent_once() {
        let id = "q-once".to_string();
        let (tx, rx) = oneshot::channel();
        with_pending(|p| {
            p.insert(
                id.clone(),
                Waiting {
                    tx,
                    asked: Asked {
                        id: id.clone(),
                        question: question(),
                    },
                },
            )
        });

        assert!(answer(&id, "SQLite".into()));
        assert_eq!(rx.await.unwrap(), "SQLite");
        // A second tap, or a second device, finds nothing left to answer.
        assert!(!answer(&id, "Postgres".into()));
    }

    #[test]
    fn a_question_with_no_options_is_still_a_question() {
        // Free-text questions are the common case for "what should I call it?",
        // so options must be optional rather than assumed.
        let free = Question {
            chat_key: None,
            question: "What should the table be called?".into(),
            options: vec![],
            // Nothing to point at, so nothing is pointed at.
            recommended: None,
        };
        assert!(free.options.is_empty());
        assert!(!free.question.is_empty());
        assert_eq!(free.recommended, None);
    }
}
