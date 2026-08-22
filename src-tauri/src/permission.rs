//! Questions the agent is waiting on.
//!
//! `claude -p` cannot prompt. A permission it has not been granted is simply
//! denied, with no channel to ask down — so on its own, a chat client is a
//! choice between an agent that can do nothing and one that can do anything.
//!
//! This is the channel. The agent is started with `--permission-prompt-tool
//! stdio`, so when it wants approval it sends a `can_use_tool` control request
//! down its own stdout; `agent_chat` reads it and calls in here. This puts the
//! question on the event bus, waits for a person to answer it in the UI, and
//! hands the answer back as a `control_response`.
//!
//! **It runs last, and that is the point.** This was a PreToolUse hook until
//! 2026-08-21, and a hook is the FIRST step of the permission chain: before the
//! deny rules, before the allow rules, before `--permission-mode`. So it had to
//! answer for every call, including the ones the chain was about to allow by
//! itself, and it could not tell those apart. It grew a list of safe programs
//! and a memory of past answers trying to — a second, worse copy of what Claude
//! and the user's own settings.json already do — and it still asked about
//! `Read`. Worse, its verdict landed before the allow rules were read, so a
//! `Bash(git commit:*)` the user had written never counted.
//!
//! Now the chain decides and only escalates what a person must answer. `auto`
//! is as quiet here as it is in a terminal.
//!
//! Two rules shape everything below:
//!
//!   * **Never block on nobody.** With no browser attached, the answer comes
//!     back immediately. A background run must not stall on a question no one
//!     can see.
//!   * **Silence is not consent.** If someone is watching but does not answer
//!     in time, the answer is `Deny`. The agent carries on and says it could
//!     not do the thing, which is recoverable; the alternative is not.
use std::collections::{HashMap, HashSet};
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
    /// The level the hook was STARTED with, from `OCTIQ_ACCESS`. Reported, not
    /// obeyed: it is only the fallback for a chat this server has no live
    /// record of. See `current_access`.
    pub access: Option<String>,
}

/// One line naming what is being asked for: the tool, and the path when it
/// names one. The Rust half of `askSummary` in `PermissionAsk.tsx`, kept in
/// step with it so a banner reads the same whichever route raised it.
fn tool_summary(request: &Request) -> String {
    let tool = request.tool_name.as_deref().unwrap_or("A tool");
    let path = request.tool_input.as_ref().and_then(|input| {
        ["file_path", "filePath", "path", "notebook_path"]
            .iter()
            .find_map(|key| input.get(key).and_then(|v| v.as_str()))
            .filter(|s| !s.is_empty())
    });
    match path {
        Some(path) => format!("{tool} — {path}"),
        None => tool.to_string(),
    }
}

/// The question as it goes out to the UI.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Asked {
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

/// One question, and what answering it "always" would mean.
struct Waiting {
    tx: oneshot::Sender<Decision>,
    /// Chat key and signature. None when there is nothing to key a grant by —
    /// a call with no chat behind it has no "this chat" to be scoped to.
    remember: Option<(String, String)>,
    /// The question as the UI was shown it, kept so it can be shown again. See
    /// `pending`.
    asked: Asked,
}

/// Questions waiting on a person, by id.
static PENDING: Mutex<Option<HashMap<String, Waiting>>> = Mutex::new(None);

fn with_pending<T>(f: impl FnOnce(&mut HashMap<String, Waiting>) -> T) -> T {
    let mut guard = PENDING.lock().unwrap_or_else(|e| e.into_inner());
    f(guard.get_or_insert_with(HashMap::new))
}

/// Every permission still waiting on a person.
///
/// A browser asks for this the moment it connects. Until it could, a reload
/// during a permission prompt lost the prompt for good: the card was only ever
/// in the page's memory, the agent went on waiting three minutes for it, and
/// the chat sat there looking broken.
pub fn pending() -> Vec<Asked> {
    with_pending(|p| p.values().map(|w| w.asked.clone()).collect())
}

/// Grants made with "Always", as `chat key` + NUL + `signature`.
///
/// Per CHAT, not per machine and not for ever: the answer to "may you run
/// pnpm here" is one somebody gave about this piece of work. `forget_chat`
/// drops them when the chat is stopped.
static REMEMBERED: Mutex<Option<HashSet<String>>> = Mutex::new(None);

fn with_remembered<T>(f: impl FnOnce(&mut HashSet<String>) -> T) -> T {
    let mut guard = REMEMBERED.lock().unwrap_or_else(|e| e.into_inner());
    f(guard.get_or_insert_with(HashSet::new))
}

fn remembered_key(chat: &str, signature: &str) -> String {
    format!("{chat}\u{0}{signature}")
}

/// Drop every grant made in one chat. Called when the chat is stopped: a grant
/// that outlived the work it was given for would be a permission nobody
/// remembers giving.
pub fn forget_chat(chat_key: &str) {
    let prefix = format!("{chat_key}\u{0}");
    with_remembered(|r| r.retain(|k| !k.starts_with(&prefix)));
}

/// What "Always" remembers about a call.
///
/// A SIMPLE shell line is remembered by the program it runs: `pnpm test` and
/// `pnpm build` are the same grant to the person tapping the button, and a key
/// made of the exact string would ask again for every argument.
///
/// A COMPOUND line is remembered whole. `cd /tmp && printf …` reduces to the
/// program `cd`, and a grant on `cd` would wave through `cd /tmp && rm -rf x` —
/// the program at the front of a chain says nothing about the rest of it. An
/// exact key means the same line never asks twice and a different one still
/// does, which is the honest answer for a line doing several things at once.
///
/// Everything else is remembered by tool name.
fn signature(request: &Request) -> Option<String> {
    let tool = request.tool_name.as_deref()?.to_ascii_lowercase();
    if tool == "bash" {
        let command = request
            .tool_input
            .as_ref()
            .and_then(|i| i.get("command"))
            .and_then(serde_json::Value::as_str)?;
        return Some(match command_head(command) {
            Some(head) => format!("bash:{head}"),
            None => format!("bash!{}", command.trim()),
        });
    }
    Some(format!("tool:{tool}"))
}

/// The name of the program a shell line runs, with its subcommand where the
/// program alone says nothing — or None when the line is not one command.
///
/// Mirrors `commandHead` in web/src/lib/toolGroups, with one addition it does
/// not need: that one is labelling a tool card, where naming the first program
/// of a chain is merely imprecise. Here the answer becomes a PERMISSION, and
/// naming the first program of a chain would grant the rest of it.
fn command_head(command: &str) -> Option<String> {
    if command.contains(['&', '|', ';', '<', '>', '$', '`', '(', ')', '\n', '\r']) {
        return None;
    }
    const SUBCOMMAND: [&str; 8] = ["git", "gh", "pnpm", "npm", "npx", "yarn", "cargo", "docker"];
    let words: Vec<&str> = command.split_whitespace().collect();
    let start = words
        .iter()
        .position(|w| !is_env_assignment(w))
        .unwrap_or(words.len());
    let first = words.get(start)?;
    let head = first.rsplit('/').next().unwrap_or(first);
    Some(match words.get(start + 1) {
        Some(next) if SUBCOMMAND.contains(&head) && !next.starts_with('-') => {
            format!("{head} {next}")
        }
        _ => head.to_string(),
    })
}

/// What the asking chat may do at this moment.
///
/// The live record first, the hook's own starting value second. The hook can
/// only ever see the environment its process was born with, and the level can
/// change part-way through a chat — so a hook that decided for itself decided
/// from a stale value, which is how "Bypass permissions" ended up still asking
/// about every command.
fn current_access(request: &Request) -> crate::agent_chat::Access {
    request
        .chat_key
        .as_deref()
        .and_then(crate::agent_chat::access_now)
        .or_else(|| {
            request
                .access
                .as_deref()
                .map(crate::agent_chat::Access::from_env)
        })
        // Neither: the most cautious of the three. A missing value must never
        // be the one that stops the asking.
        .unwrap_or(crate::agent_chat::Access::Read)
}

fn is_env_assignment(word: &str) -> bool {
    match word.split_once('=') {
        Some((name, _)) => {
            !name.is_empty()
                && name.chars().all(|c| c.is_ascii_alphanumeric() || c == '_')
                && !name.starts_with(|c: char| c.is_ascii_digit())
        }
        None => false,
    }
}

/// Ask, and wait for an answer.
pub async fn ask(request: Request) -> Answer {
    // Nothing is second-guessed here any more.
    //
    // This used to run FIRST in the permission chain, as a PreToolUse hook, so
    // it had to answer for every call — including the ones the chain was about
    // to allow by itself. To do that it grew a list of safe programs, a rule
    // about shell metacharacters and a memory of what had been permitted: a
    // second, worse copy of what Claude and the user's own settings.json
    // already do. Worse still, it answered BEFORE the allow rules were read, so
    // a `Bash(git commit:*)` the user had written stopped counting.
    //
    // It runs LAST now, over `--permission-prompt-tool stdio`: the deny rules,
    // the allow rules and the mode have each had their say, and a question only
    // arrives because the chain decided a person has to answer it. Which is why
    // 143 lines of judgement could go — every question that gets here is one
    // worth asking.

    // Already answered, with "Always", in this chat. This one IS an allow: it
    // is not an absence of opinion, it is a person's decision being kept.
    let grant = request.chat_key.clone().zip(signature(&request));
    if let Some((chat, sig)) = &grant {
        if with_remembered(|r| r.contains(&remembered_key(chat, sig))) {
            return Answer {
                decision: Decision::Allow.as_str(),
                reason: "you allowed this for this chat".into(),
            };
        }
    }

    // Nobody is watching: do not hold the agent up for a question that would go
    // unseen. This is what keeps an unattended run behaving normally.
    //
    // Through the grace window, not the raw count: a page mid-reload has a
    // count of zero and a person in front of it.
    if !crate::bus::watched_within(crate::question::RELOAD_GRACE) {
        return Answer {
            decision: Decision::Abstain.as_str(),
            reason: "nobody is watching OctiqFlow".into(),
        };
    }

    let id = uuid::Uuid::new_v4().to_string();
    let (tx, rx) = oneshot::channel();
    let asked = Asked {
        id: id.clone(),
        request,
    };
    with_pending(|p| {
        p.insert(
            id.clone(),
            Waiting {
                tx,
                remember: grant,
                asked: asked.clone(),
            },
        )
    });

    // To the browsers that are attached…
    crate::bus::emit("permission-ask", asked.clone());
    // …and to the phone in a pocket, which is attached to nothing. This one
    // times out in three minutes, so it is the moment most worth carrying.
    crate::push::notify_chat(
        asked.request.chat_key.as_deref(),
        "permission",
        &tool_summary(&asked.request),
    );

    // The reason travels to the agent, which repeats it to the user. A refusal
    // and a timeout are both a Deny, but they are not the same thing to the
    // person reading the answer — reporting "timed out" to someone who pressed
    // Deny is simply a lie about what happened.
    //
    // The third arm is the reload. A break in the connection used to end this
    // question by itself — the card lived only in the page, so a refresh took
    // it away and left the agent waiting out the full timeout for an answer
    // nobody could give. Now the question survives the gap (`pending` hands it
    // back), and only a person who has actually gone releases it.
    let (decision, reason) = tokio::select! {
        answered = tokio::time::timeout(ANSWER_TIMEOUT, rx) => match answered {
            Ok(Ok(decision)) => (
                decision,
                match decision {
                    Decision::Allow => "you allowed it",
                    Decision::Deny => "you denied it",
                    Decision::Abstain => "no opinion",
                },
            ),
            // Nobody answered, or the waiter was dropped. Silence is not
            // consent: the agent is told no and carries on.
            _ => (Decision::Deny, "nobody answered in time"),
        },
        // Everyone left while it was up. Not a refusal — the same abstain an
        // unattended run gets, so the chain decides as though we never asked.
        _ = crate::bus::once_unwatched(crate::question::RELOAD_GRACE) => {
            (Decision::Abstain, "nobody is watching OctiqFlow any more")
        }
    };

    with_pending(|p| p.remove(&id));
    crate::bus::emit("permission-expired", serde_json::json!({ "id": id }));
    Answer {
        decision: decision.as_str(),
        reason: reason.into(),
    }
}

/// Answer a waiting question. `false` when it is already gone — answered
/// twice, or expired while the tap was in flight.
///
/// The same event a timeout sends goes out here too, for the same reason as in
/// `question.rs`: the ask was put on every attached browser, so deciding it on
/// one has to take it off the rest. A card still asking to allow something that
/// has already run is worse than no card.
pub fn decide(id: &str, decision: Decision, remember: bool) -> bool {
    let Some(waiting) = with_pending(|p| p.remove(id)) else {
        return false;
    };
    // Only an ALLOW is worth keeping. A remembered deny would be a tool that
    // quietly stopped working with no way to see why, and "no, not this time"
    // is the answer people actually mean when they tap Deny.
    if remember && matches!(decision, Decision::Allow) {
        if let Some((chat, sig)) = &waiting.remember {
            with_remembered(|r| r.insert(remembered_key(chat, sig)));
        }
    }
    let delivered = waiting.tx.send(decision).is_ok();
    crate::bus::emit("permission-expired", serde_json::json!({ "id": id }));
    delivered
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
            access: None,
        })
        .await;
        assert_eq!(answer.decision, "abstain");
    }

    /// A `Waiting` for the tests below. The `asked` copy is what a reconnecting
    /// browser is handed, so it has to be built here too.
    fn waiting_on(id: &str, tx: oneshot::Sender<Decision>) -> Waiting {
        Waiting {
            tx,
            remember: None,
            asked: Asked {
                id: id.to_string(),
                request: asking_about(None, None),
            },
        }
    }

    fn asking_about(chat_key: Option<&str>, access: Option<&str>) -> Request {
        Request {
            chat_key: chat_key.map(str::to_string),
            session_id: None,
            tool_name: Some("Bash".into()),
            tool_input: None,
            tool_use_id: None,
            cwd: None,
            access: access.map(str::to_string),
        }
    }

    #[test]
    fn the_live_level_beats_the_one_the_hook_was_started_with() {
        // The whole point: a chat that STARTED on full and has since been dialled
        // back has to be asked about, whatever the hook's environment still says.
        crate::agent_chat::remember_access("chat-a", crate::agent_chat::Access::Auto);
        let request = asking_about(Some("chat-a"), Some("full"));
        assert_eq!(current_access(&request), crate::agent_chat::Access::Auto);
    }

    #[test]
    fn the_started_level_is_used_when_the_chat_is_not_known() {
        // A chat the server has no record of — the only case the hook's own
        // value still decides.
        let request = asking_about(Some("chat-never-started"), Some("full"));
        assert_eq!(current_access(&request), crate::agent_chat::Access::Full);
    }

    #[test]
    fn neither_a_live_level_nor_a_reported_one_is_the_cautious_one() {
        // A missing or unreadable value must never be the one that stops the
        // asking.
        assert_eq!(
            current_access(&asking_about(None, None)),
            crate::agent_chat::Access::Read
        );
        assert_eq!(
            current_access(&asking_about(None, Some("nonsense"))),
            crate::agent_chat::Access::Read
        );
    }

    #[test]
    fn always_never_grants_a_chain_by_its_first_program() {
        // The hole this closes: `cd` at the front of `cd /tmp && rm -rf x` is
        // not what anybody thinks they are allowing when they tap Always.
        assert_eq!(command_head("pnpm test --watch"), Some("pnpm test".into()));
        assert_eq!(command_head("/usr/bin/sed -n 1,5p x"), Some("sed".into()));
        assert_eq!(
            command_head("CI=true cargo build"),
            Some("cargo build".into())
        );
        assert_eq!(command_head("cd /tmp && rm -rf x"), None);
        assert_eq!(command_head("cat a | sh"), None);
    }

    #[tokio::test]
    async fn a_waiting_permission_can_be_asked_for_again() {
        // The reload case. A permission card lives only in the page it was drawn
        // in, and it is announced once over a broadcast with no replay — so
        // without this a refresh took the card away for good while the agent
        // went on waiting out its three minutes for an answer.
        let id = "p-pending".to_string();
        let (tx, _rx) = oneshot::channel();
        with_pending(|p| p.insert(id.clone(), waiting_on(&id, tx)));

        assert!(
            pending().iter().any(|a| a.id == id),
            "a permission still waiting has to be findable"
        );

        // Deciding it takes it off the list, so a page arriving afterwards does
        // not offer a choice that has already been made.
        assert!(decide(&id, Decision::Allow, false));
        assert!(!pending().iter().any(|a| a.id == id));
    }

    #[test]
    fn answering_an_unknown_question_is_refused_not_panicked() {
        assert!(!decide("no-such-id", Decision::Allow, false));
    }

    #[tokio::test]
    async fn a_question_can_only_be_answered_once() {
        let id = "only-once".to_string();
        let (tx, _rx) = oneshot::channel();
        with_pending(|p| p.insert(id.clone(), waiting_on(&id, tx)));

        assert!(decide(&id, Decision::Allow, false));
        // The second tap — a double click, or two devices — finds nothing.
        assert!(!decide(&id, Decision::Deny, false));
    }

    #[tokio::test]
    async fn a_refusal_and_a_timeout_are_reported_differently() {
        // Both deny, but the agent repeats the reason to the user, so calling a
        // deliberate refusal a timeout misinforms the person who pressed it.
        let id = "explicit".to_string();
        let (tx, rx) = oneshot::channel();
        with_pending(|p| p.insert(id.clone(), waiting_on(&id, tx)));
        assert!(decide(&id, Decision::Deny, false));

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
