//! Letting the agent ask you something.
//!
//! `claude -p` is not offered `AskUserQuestion` at all. That is not the SDK
//! lacking it — the SDK routes it to a `canUseTool` callback — it is that print
//! mode has nobody to answer, so the tool never reaches the model.
//!
//! We can hand it one. `-p` loads MCP servers in full (78 skills, 8 servers,
//! all present), so a tool of our own is a first-class tool as far as the agent
//! is concerned. It calls `ask_user`, the call blocks, the questions appear
//! wherever you are, and your answers come back as the tool result.
//!
//! A call carries a LIST, and that is the shape rather than a convenience.
//! Claude Code runs MCP tool calls one at a time, so an agent with five things
//! to settle used to produce five cards, each of them waiting on the last and
//! each costing another round trip to whoever's phone was nearest. Asked in one
//! call they arrive on one card, and the person settles them the way they were
//! thought of — together, seeing all of it.
//!
//! Nothing is returned until every answer is in. Handing back the first while
//! the person is still deciding the third would let the agent start building on
//! half a decision — the same trap one question per call had, moved inside the
//! call rather than removed. So the whole list blocks and the whole list is
//! reported.
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

/// What the agent is told when there was nobody to ask in the first place.
///
/// Said once for the whole call however many questions it carried: the reason
/// is the room, not the question, and repeating it per question would read like
/// several separate failures.
const NOBODY_TO_ASK: &str = "Nobody is watching OctiqFlow, so this question could not be asked. \
                             Proceed without it, or say what you would need to know.";

/// What an individual question is told when the clock ran out on it.
const NOT_IN_TIME: &str = "The user did not answer in time. Do not assume an answer — say what \
                           you need and stop, or continue in a way that does not depend on it.";

/// What an individual question is told when the person left mid-answer.
const NOBODY_LEFT: &str = "Nobody is watching OctiqFlow any more, so this question went \
                           unanswered. Proceed without it, or say what you would need to know.";

/// A call with an empty list. Not an error: the agent asked for nothing and is
/// told it got nothing, rather than being left to read silence as an answer.
const NOTHING_ASKED: &str = "No question was given, so nothing was asked.";

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
///
/// One of these goes out per QUESTION even when a call asked several, so a
/// browser that has only ever handled one at a time keeps working unchanged.
/// What tells it there are others is `batch`: an id shared by every question of
/// one call, and the count beside it so a card can be drawn complete before the
/// rest of the events have arrived. Both are absent for a lone question, which
/// makes those events byte-for-byte what they were before batching existed.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Asked {
    id: String,
    #[serde(flatten)]
    question: Question,
    #[serde(skip_serializing_if = "Option::is_none")]
    batch: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    batch_size: Option<usize>,
}

/// A `/hook/ask` body, in either of the two shapes that arrive.
///
/// `Many` is tried first and a legacy single-question body simply fails it —
/// there is no `questions` key to read — so it falls through to `One`. Ordering
/// is the whole mechanism here: put `One` first and a batch would match it on
/// the strength of `chatKey` alone and lose every question.
#[derive(Deserialize)]
#[serde(untagged)]
pub enum Request {
    Many(Batch),
    One(Question),
}

/// Everything one `ask_user` call wants to know.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Batch {
    /// Which chat is asking. Named once for the call rather than on each
    /// question: the sub-questions arrive without it, and it is the call that
    /// belongs to a chat.
    pub chat_key: Option<String>,
    pub questions: Vec<Question>,
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

/// Ask whatever a `/hook/ask` body carried, in whichever shape it arrived in.
pub async fn ask_request(request: Request) -> String {
    match request {
        Request::Many(batch) => ask_many(batch.chat_key, batch.questions).await,
        Request::One(question) => ask(question).await,
    }
}

/// Put one question in front of the user and wait.
///
/// A batch of one, on purpose. The single question is the case that must never
/// regress, so it goes down the same code every batch does rather than a copy
/// of it that would be free to drift.
pub async fn ask(question: Question) -> String {
    ask_many(question.chat_key.clone(), vec![question]).await
}

/// Put a whole call's questions in front of the user and wait for all of them.
///
/// The string that comes back is what the agent is told. When nobody is there
/// to ask, or nobody answers, it is told exactly that — a question with no
/// answer must never be reported as an answer, because the agent will act on
/// whatever it is given.
pub async fn ask_many(chat_key: Option<String>, questions: Vec<Question>) -> String {
    // Answered before we look at who is watching: an empty call failed on what
    // it sent, and "nobody is there" would blame the room for it.
    if questions.is_empty() {
        return NOTHING_ASKED.into();
    }
    if !crate::bus::watched_within(RELOAD_GRACE) {
        return NOBODY_TO_ASK.into();
    }

    // Only a real batch is marked as one, so a client cannot be left holding a
    // card of one waiting for a second question that was never coming.
    let batch = (questions.len() > 1).then(|| uuid::Uuid::new_v4().to_string());
    let batch_size = batch.as_ref().map(|_| questions.len());

    let mut asked = Vec::with_capacity(questions.len());
    let mut ids = Vec::with_capacity(questions.len());
    let mut waiting = Vec::with_capacity(questions.len());
    for mut question in questions {
        // The chat is named once for the call and the sub-questions arrive
        // bare. A question that does not know its chat cannot be pushed to a
        // phone, and could be answered into the wrong conversation.
        if question.chat_key.is_none() {
            question.chat_key.clone_from(&chat_key);
        }
        let id = uuid::Uuid::new_v4().to_string();
        let (tx, rx) = oneshot::channel();
        let announced = Asked {
            id: id.clone(),
            question: question.clone(),
            batch: batch.clone(),
            batch_size,
        };
        with_pending(|p| {
            p.insert(
                id.clone(),
                Waiting {
                    tx,
                    asked: announced.clone(),
                },
            )
        });
        crate::bus::emit("user-question", announced);
        ids.push(id);
        waiting.push(rx);
        asked.push(question);
    }

    // Ten minutes to answer, and the agent is stopped until they are answered —
    // so it goes to the phone as well as to any open browser. ONE notification
    // for the call whatever it carried: a buzz per question is the pile-up that
    // asking them together exists to end, moved to the lock screen.
    let summary = match asked.as_slice() {
        [only] => only.question.clone(),
        many => format!("{} questions · {}", many.len(), many[0].question),
    };
    crate::push::notify_chat(asked[0].chat_key.as_deref(), "question", &summary);

    // Three ways this ends, and they are not the same thing to tell an agent.
    //
    // The watcher is why a reload is survivable. A gap in the connection no
    // longer decides anything: the questions stay up, the browser coming back
    // asks for them through `pending`, and only somebody who is really gone —
    // away for `RELOAD_GRACE` without returning — releases the turn.
    let mut answers: Vec<Option<String>> = vec![None; asked.len()];
    // ONE deadline for the call rather than one per question. The person is
    // reading a card, not a queue, and a clock that started per question would
    // expire the ones at the bottom of it while they were still on the first.
    let deadline = tokio::time::Instant::now() + ANSWER_TIMEOUT;
    let unanswered = tokio::select! {
        // The receivers live OUTSIDE the select — borrowed here, not moved —
        // because the other branch has to be able to go through them afterwards
        // for answers that did arrive.
        _ = async {
            for (answer, rx) in answers.iter_mut().zip(waiting.iter_mut()) {
                // Still reads an answer already sitting in the channel once the
                // deadline is past: `Timeout` polls what it wraps before it
                // looks at the clock. Nothing answered in time is thrown away
                // for having been late in the list.
                if let Ok(Ok(said)) = tokio::time::timeout_at(deadline, rx).await {
                    *answer = Some(said);
                }
            }
        } => NOT_IN_TIME,
        _ = crate::bus::once_unwatched(RELOAD_GRACE) => NOBODY_LEFT,
    };

    // Somebody who walked off will often have answered half the card first.
    // Those answers were made and the agent gets them; only what is genuinely
    // missing is reported missing.
    for (answer, rx) in answers.iter_mut().zip(waiting.iter_mut()) {
        if answer.is_none() {
            *answer = rx.try_recv().ok();
        }
    }

    // Everything still on the board comes down. `answer()` already took the
    // answered ones off it, so a `remove` that finds nothing is how the two are
    // told apart — including one answered a second ago on another device.
    for id in &ids {
        if with_pending(|p| p.remove(id)).is_some() {
            crate::bus::emit("question-expired", serde_json::json!({ "id": id }));
        }
    }

    let outcome: Vec<Result<String, &str>> = answers
        .into_iter()
        .map(|answer| answer.ok_or(unanswered))
        .collect();
    report(&asked, &outcome)
}

/// What the agent ends up reading.
///
/// One question answers with the answer and nothing else — no numbering, no
/// framing — because that is what `ask_user` has always returned and what every
/// prompt written against it expects. The common case pays nothing for batching.
///
/// Several come back numbered, each answer under the words it answers. The
/// agent asked them in one breath and hears them in one, and the pairing is
/// what stops "Postgres / yes / tomorrow" being read against the wrong three
/// questions — an ordering it has no way to check and every reason to trust.
fn report(questions: &[Question], answers: &[Result<String, &str>]) -> String {
    let said = |answer: &Result<String, &str>| match answer {
        Ok(words) => words.to_string(),
        Err(excuse) => (*excuse).to_string(),
    };
    match answers {
        [] => NOTHING_ASKED.into(),
        [only] => said(only),
        _ => questions
            .iter()
            .zip(answers)
            .enumerate()
            .map(|(i, (question, answer))| {
                let n = i + 1;
                format!("Q{n}: {}\nA{n}: {}", question.question, said(answer))
            })
            .collect::<Vec<_>>()
            .join("\n\n"),
    }
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

    /// A bare free-text question, for the cases where only the words matter.
    fn asking(text: &str) -> Question {
        Question {
            chat_key: None,
            question: text.into(),
            options: vec![],
            recommended: None,
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
                        batch: None,
                        batch_size: None,
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
                        batch: None,
                        batch_size: None,
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

    #[test]
    fn a_body_with_a_list_is_a_batch_and_one_without_is_still_a_question() {
        // Both shapes arrive at `/hook/ask`. The MCP server sends a list now,
        // but a `claude -p` started before this change is still running the
        // script it was handed, and that one sends a question flat.
        //
        // Untagged tries `Many` first: the flat body has no `questions` to
        // read, fails it, and lands on `One`. The ORDER of the variants is the
        // entire mechanism — put `One` first and every batch would match it on
        // the strength of `chatKey` alone and arrive with nothing in it.
        let many: Request = serde_json::from_str(
            r#"{"chatKey":"c1","questions":[{"question":"Which database?"},
                {"question":"What should it be called?"}]}"#,
        )
        .expect("parses the list shape");
        match many {
            Request::Many(batch) => {
                assert_eq!(batch.chat_key.as_deref(), Some("c1"));
                assert_eq!(batch.questions.len(), 2);
                // The chat is named once for the call; the questions come bare.
                assert_eq!(batch.questions[0].chat_key, None);
            }
            Request::One(_) => panic!("a body carrying a list is not one question"),
        }

        let one: Request = serde_json::from_str(
            r#"{"chatKey":"c1","question":"Which database?","options":["a","b"],"recommended":0}"#,
        )
        .expect("parses the flat shape");
        match one {
            Request::One(q) => {
                assert_eq!(q.question, "Which database?");
                assert_eq!(q.chat_key.as_deref(), Some("c1"));
                assert_eq!(q.recommended, Some(0));
            }
            Request::Many(_) => panic!("a body with no list is one question"),
        }
    }

    #[tokio::test]
    async fn a_call_that_asked_nothing_is_told_so() {
        // Answered before anything looks at who is watching, because the call
        // failed on what it sent rather than on who was there. Told it that
        // nobody was watching, an agent would go off "proceeding without" a
        // question it never actually managed to ask.
        assert_eq!(ask_many(Some("c1".into()), vec![]).await, NOTHING_ASKED);
    }

    #[tokio::test]
    async fn with_nobody_watching_a_whole_batch_is_told_so_at_once() {
        // The room is the reason, not the questions, so the whole call is
        // refused in one breath rather than fanned out into five cards nobody
        // will see and five identical excuses.
        //
        // Read loosely on wording: `watched_within` is process-global and
        // another test in this binary counts a browser in and straight out
        // again, which can land this call inside somebody else's reload grace.
        // What must hold either way is that the agent is told nobody was there
        // and is never handed an answer to a question nobody saw.
        let reply = ask_many(Some("c1".into()), vec![question(), question()]).await;
        assert!(reply.contains("Nobody is watching"), "{reply}");
        assert!(
            !reply.contains("Postgres") && !reply.contains("SQLite"),
            "an unasked question must not come back looking answered: {reply}"
        );
    }

    #[test]
    fn one_question_comes_back_as_the_bare_answer() {
        // What `ask_user` has always returned, and what every prompt written
        // against it expects. Number a single question and every existing agent
        // starts reading "A1: " as part of what the person said.
        assert_eq!(report(&[question()], &[Ok("SQLite".into())]), "SQLite");
        // An unanswered one is its excuse, equally unframed.
        assert_eq!(report(&[question()], &[Err(NOT_IN_TIME)]), NOT_IN_TIME);
    }

    #[test]
    fn several_answers_come_back_under_the_questions_they_answer() {
        // The agent cannot check an ordering it is handed and has every reason
        // to trust it, so three bare answers in a row are three chances to act
        // on the wrong one. Each is quoted under its own question.
        //
        // And the one nobody got to carries its own excuse rather than a blank
        // line, which an agent would read as an answer of "nothing".
        let asked = [
            asking("Which database?"),
            asking("What should it be called?"),
            asking("Ship it today?"),
        ];
        let answers = [Ok("SQLite".to_string()), Err(NOT_IN_TIME), Ok("Yes".into())];
        assert_eq!(
            report(&asked, &answers),
            format!(
                "Q1: Which database?\nA1: SQLite\n\n\
                 Q2: What should it be called?\nA2: {NOT_IN_TIME}\n\n\
                 Q3: Ship it today?\nA3: Yes"
            )
        );
    }

    #[test]
    fn only_a_real_batch_says_that_it_is_one() {
        // A client builds its card out of these events and nothing else.
        // `batch` is what gathers several of them onto one card and `batchSize`
        // is what tells it the card is whole before the last event has landed.
        //
        // So a lone question must carry NEITHER, and carry it by being absent
        // rather than null: a page that has never heard of batching has to see
        // byte-for-byte the event it always saw.
        let alone = Asked {
            id: "a".into(),
            question: question(),
            batch: None,
            batch_size: None,
        };
        let json = serde_json::to_string(&alone).expect("serialises");
        assert!(!json.contains("batch"), "{json}");

        let together = Asked {
            id: "b".into(),
            question: question(),
            batch: Some("one-call".into()),
            batch_size: Some(3),
        };
        let json = serde_json::to_string(&together).expect("serialises");
        assert!(json.contains(r#""batch":"one-call""#), "{json}");
        assert!(json.contains(r#""batchSize":3"#), "{json}");
    }
}
