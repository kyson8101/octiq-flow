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

/// One thing you can pick.
///
/// A bare string and a `{label, description}` object are both accepted, because
/// both are what an agent will send. Every Claude model is trained on
/// `AskUserQuestion`, whose choices are objects, so the object shape is the one
/// it reaches for by reflex — and a boundary that stringified whatever it was
/// handed turned that reflex into four buttons reading `[object Object]`.
/// Accepting both costs a deserializer; teaching every agent which of the two
/// we meant costs a wrong question every time one forgets.
#[derive(Debug, Clone, PartialEq, Deserialize, Serialize)]
pub struct Choice {
    /// The words on the button, and the words sent back as the answer. A
    /// description is never part of what is answered: the agent has to be able
    /// to match what it is told against what it offered.
    pub label: String,
    /// A line under the label, for when the label alone does not say enough.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
}

/// A choice as it arrives, before we know whether it is usable.
#[derive(Deserialize)]
#[serde(untagged)]
enum RawChoice {
    Text(String),
    Labelled {
        label: String,
        #[serde(default)]
        description: Option<String>,
    },
    /// Anything else at all — a number, a null, an object with no label.
    Unusable(serde_json::Value),
}

/// Read the offered choices, keeping the ones a person could actually read.
///
/// Tolerant on purpose. One malformed entry rejecting the whole request would
/// fail the call the agent is BLOCKED on, and the person would see nothing at
/// all rather than one choice fewer.
fn choices<'de, D>(d: D) -> Result<Vec<Choice>, D::Error>
where
    D: serde::Deserializer<'de>,
{
    Ok(Vec::<RawChoice>::deserialize(d)?
        .into_iter()
        .filter_map(|raw| match raw {
            RawChoice::Text(label) => Some(Choice {
                label,
                description: None,
            }),
            RawChoice::Labelled { label, description } => Some(Choice {
                label,
                // A blank line under the label is a gap in the card, not a
                // description.
                description: description.filter(|d| !d.trim().is_empty()),
            }),
            // Dropped rather than drawn. A button with no words on it is not a
            // choice, and `[object Object]` is worse than one button fewer.
            RawChoice::Unusable(_) => None,
        })
        .filter(|c| !c.label.trim().is_empty())
        .collect())
}

/// What the agent wants to know.
#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Question {
    /// Which chat is asking.
    pub chat_key: Option<String>,
    pub question: String,
    /// Choices to offer. Empty means any answer will do, so the UI asks for
    /// text instead of showing buttons.
    #[serde(default, deserialize_with = "choices")]
    pub options: Vec<Choice>,
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
    /// Whether more than one of `options` may be picked.
    ///
    /// Off unless the agent asks for it, and asked for per question rather than
    /// offered on every one: "which database?" takes exactly one answer, and a
    /// UI that let you tick both would be inviting an answer the agent cannot
    /// act on. The agent knows which of its questions is a set and which is a
    /// choice; nothing else does.
    ///
    /// Read under BOTH names. `AskUserQuestion` calls this `multiSelect`, and
    /// that is what an agent going on training rather than on our schema
    /// sends — a name we did not read was a set-shaped question quietly drawn
    /// as a one-of card, with no ticks, no error, and nothing to notice.
    #[serde(default, alias = "multiSelect")]
    pub multiple: bool,
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

    crate::bus::emit("user-question", asked.clone());
    // Ten minutes to answer this one, and the agent is stopped until it is
    // answered — so it goes to the phone as well as to any open browser.
    crate::push::notify_chat(
        asked.question.chat_key.as_deref(),
        "question",
        &asked.question.question,
    );

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
            options: vec![
                Choice {
                    label: "Postgres".into(),
                    description: None,
                },
                Choice {
                    label: "SQLite".into(),
                    description: Some("One file, no server".into()),
                },
            ],
            recommended: Some(0),
            multiple: false,
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
    fn several_answers_are_allowed_only_when_the_agent_asks_for_them() {
        // One answer is the safe reading of a question, so it is the one you
        // get by saying nothing: "which database?" must never come back with
        // two just because the UI could send two.
        let one: Question =
            serde_json::from_str(r#"{"question":"Which database?","options":["a","b"]}"#)
                .expect("parses without the flag");
        assert!(!one.multiple);

        // And a question that genuinely takes a set says so itself.
        let many: Question = serde_json::from_str(
            r#"{"question":"Which of these?","options":["a","b"],"multiple":true}"#,
        )
        .expect("parses with the flag");
        assert!(many.multiple);
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
            // And nothing to pick several of either.
            multiple: false,
        };
        assert!(free.options.is_empty());
        assert!(!free.question.is_empty());
        assert_eq!(free.recommended, None);
    }

    #[test]
    fn a_choice_arrives_as_a_string_or_as_a_labelled_object() {
        // Every Claude model is trained on `AskUserQuestion`, whose choices are
        // `{label, description}` objects. That is the shape an agent reaches for
        // by reflex, and a boundary that stringified whatever it was handed
        // turned the reflex into four buttons reading `[object Object]` — a
        // question nobody could answer, with nothing anywhere saying why.
        let q: Question = serde_json::from_str(
            r#"{"question":"Which database?","options":[
                 "Postgres",
                 {"label":"SQLite","description":"One file, no server"}
               ]}"#,
        )
        .expect("parses both shapes");
        assert_eq!(q.options[0].label, "Postgres");
        assert_eq!(q.options[0].description, None);
        assert_eq!(q.options[1].label, "SQLite");
        assert_eq!(
            q.options[1].description.as_deref(),
            Some("One file, no server")
        );
    }

    #[test]
    fn a_choice_nobody_could_read_is_dropped_rather_than_drawn() {
        // An object with no label has no words to put on a button. Dropping it
        // loses a choice; drawing it loses the whole question.
        let q: Question = serde_json::from_str(
            r#"{"question":"Which?","options":["Keep",{"value":"Lost"},"  ",7]}"#,
        )
        .expect("parses past the unusable ones");
        assert_eq!(q.options.len(), 1);
        assert_eq!(q.options[0].label, "Keep");
    }

    #[test]
    fn the_set_flag_answers_to_the_name_the_agent_knows_it_by() {
        // `AskUserQuestion` calls it `multiSelect`, so that is what an agent
        // sends when it is going on training rather than on our schema. Read
        // only `multiple` and the ticks silently never appear — which is
        // exactly how a set-shaped question came back as a one-of card, with
        // nothing logged and nothing to notice.
        let ours: Question = serde_json::from_str(
            r#"{"question":"Which files?","options":["a","b"],"multiple":true}"#,
        )
        .expect("parses our name");
        assert!(ours.multiple);

        let theirs: Question = serde_json::from_str(
            r#"{"question":"Which files?","options":["a","b"],"multiSelect":true}"#,
        )
        .expect("parses their name");
        assert!(theirs.multiple);
    }
}
