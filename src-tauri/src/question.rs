//! Ask through a live MCP result, or keep the question until a later answer
//! resumes its original conversation. Browser connectivity does not decide
//! whether the user is allowed to answer. Durable state lives in question_store.
use std::sync::Arc;
use std::time::Duration;

use crate::agent_chat::ChatManager;
use serde::{Deserialize, Serialize};

/// Release the tool transport after ten minutes, keeping the question durable.
pub const ANSWER_TIMEOUT: Duration = Duration::from_secs(600);
/// Legacy permission prompts still use this disconnect grace. Questions do not.
pub const RELOAD_GRACE: Duration = Duration::from_secs(20);
const NOT_IN_TIME: &str = "The questions are saved and still waiting for the user. End this turn without assuming an answer or repeating the questions. OctiqFlow will continue this conversation when the answers arrive.";
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
    Unusable(serde::de::IgnoredAny),
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
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Asked {
    pub(crate) id: String,
    #[serde(flatten)]
    pub(crate) question: Question,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) batch: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) batch_size: Option<usize>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) answer: Option<String>,
    pub(crate) status: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) error: Option<String>,
    pub(crate) retryable: bool,
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
    #[serde(default)]
    pub session_key: Option<String>,
    #[serde(default)]
    pub launch_id: Option<String>,
    /// Which chat is asking. Named once for the call rather than on each
    /// question: the sub-questions arrive without it, and it is the call that
    /// belongs to a chat.
    pub chat_key: Option<String>,
    pub questions: Vec<Question>,
}

/// The transport may disappear without removing the persisted question.
struct WaitingTool {
    store: Arc<crate::question_store::QuestionStore>,
    id: String,
}
impl Drop for WaitingTool {
    fn drop(&mut self) {
        self.store.detach(&self.id);
    }
}

pub async fn ask_request(manager: Arc<ChatManager>, request: Request) -> String {
    ask_request_with_timeout(manager, request, ANSWER_TIMEOUT).await
}

pub(crate) async fn ask_request_with_timeout(
    manager: Arc<ChatManager>,
    request: Request,
    timeout: Duration,
) -> String {
    let (chat_key, session_key, launch_id, questions) = match request {
        Request::Many(batch) => (
            batch.chat_key,
            batch.session_key,
            batch.launch_id,
            batch.questions,
        ),
        Request::One(q) => (q.chat_key.clone(), None, None, vec![q]),
    };
    if questions.is_empty() {
        return NOTHING_ASKED.into();
    }
    let outcome = async {
        let chat_key = chat_key.ok_or("The question has no conversation")?;
        // The same gate as Stop: a late request from a stopped process cannot
        // register a new question after cancellation has already run.
        let (origin, id, rx) = {
            let _delivery = manager
                .questions
                .delivery_lock
                .lock()
                .map_err(|e| e.to_string())?;
            let origin =
                manager.question_origin(&chat_key, session_key.as_deref(), launch_id.as_deref())?;
            let (id, rx) = manager.questions.insert(origin.clone(), questions)?;
            (origin, id, rx)
        };
        let _waiting = WaitingTool {
            store: manager.questions.clone(),
            id: id.clone(),
        };
        crate::push::notify_chat(
            Some(&origin.chat_key),
            "question",
            "Questions are waiting for your answer",
        );
        let _ = tokio::time::timeout(timeout, rx).await;
        // Check even at the deadline: a submitted answer that won the lock
        // still goes down the live channel, never down both delivery paths.
        if let Some(answer) = manager.questions.take_tool(&id)? {
            return Ok(answer);
        }
        Ok(NOT_IN_TIME.to_string())
    }
    .await;
    outcome.unwrap_or_else(|why: String| {
        format!("The question could not be delivered: {why}. Do not assume an answer.")
    })
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
pub(crate) fn report(questions: &[Question], answers: &[Result<String, &str>]) -> String {
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
            answer: None,
            status: "pending".into(),
            error: None,
            retryable: false,
        };
        let json = serde_json::to_string(&alone).expect("serialises");
        assert!(!json.contains("batch"), "{json}");

        let together = Asked {
            id: "b".into(),
            question: question(),
            batch: Some("one-call".into()),
            batch_size: Some(3),
            answer: None,
            status: "pending".into(),
            error: None,
            retryable: false,
        };
        let json = serde_json::to_string(&together).expect("serialises");
        assert!(json.contains(r#""batch":"one-call""#), "{json}");
        assert!(json.contains(r#""batchSize":3"#), "{json}");
    }
}
