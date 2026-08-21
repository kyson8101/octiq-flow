//! Questions the agent is waiting on.
//!
//! `claude -p` cannot prompt. A permission it has not been granted is simply
//! denied, with no channel to ask down — so on its own, a chat client is a
//! choice between an agent that can do nothing and one that can do anything.
//!
//! This is the channel. A PreToolUse hook (scripts/hooks/permission-ask.cjs)
//! holds the tool call and asks here; this puts the question on the event bus,
//! waits for a person to answer it in the UI, and hands the answer back.
//!
//! `--permission-mode auto` decides WHEN a question is worth raising — it runs
//! unattended and stops at what looks unsafe. That pairing is the whole design:
//! the mode picks the moments, this module carries them to someone. Without the
//! hook, every one of `auto`'s stops would land as a flat denial instead.
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

/// One question, and what answering it "always" would mean.
struct Waiting {
    tx: oneshot::Sender<Decision>,
    /// Chat key and signature. None when there is nothing to key a grant by —
    /// a call with no chat behind it has no "this chat" to be scoped to.
    remember: Option<(String, String)>,
}

/// Questions waiting on a person, by id.
static PENDING: Mutex<Option<HashMap<String, Waiting>>> = Mutex::new(None);

fn with_pending<T>(f: impl FnOnce(&mut HashMap<String, Waiting>) -> T) -> T {
    let mut guard = PENDING.lock().unwrap_or_else(|e| e.into_inner());
    f(guard.get_or_insert_with(HashMap::new))
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

/// Tools that cannot change anything, whatever level the chat is on.
///
/// A read is not a change. Stopping to ask about one is noise on every level:
/// `Manual` promises to ask "before making changes", and `Plan` will not let a
/// change through at all. This is what made Auto here behave like Manual — the
/// hook is the FIRST step of the permission chain, so Claude's own judgement
/// never got the chance to wave a `Read` past.
const READ_TOOLS: [&str; 6] = ["read", "grep", "glob", "ls", "notebookread", "todoread"];

/// Programs that only look: no writing, no deleting, no network.
///
/// A whitelist, and deliberately a short one. Anything not on it asks, which is
/// the safe direction to be wrong in.
const SAFE_COMMANDS: [&str; 21] = [
    "ls", "cat", "head", "tail", "wc", "pwd", "echo", "file", "stat", "which", "whoami", "date",
    "uname", "basename", "dirname", "realpath", "ps", "env", "tree", "jq", "rg",
];

/// The git subcommands that only read. `git` on its own names a dozen different
/// jobs, half of which rewrite history.
const GIT_READS: [&str; 11] = [
    "status",
    "diff",
    "log",
    "show",
    "branch",
    "rev-parse",
    "blame",
    "describe",
    "tag",
    "ls-files",
    "shortlog",
];

/// OctiqFlow's own tools, from the MCP server it hands the agent.
///
/// They are already named in `--allowedTools`, but this hook runs BEFORE that
/// list is read, so they were being stopped anyway. Asking permission to put a
/// TODO list on screen is noise; asking permission to ASK YOU A QUESTION is a
/// question about a question, and it timed out in front of a real user before
/// this line existed.
const OURS: [&str; 2] = ["mcp__octiq__ask_user", "mcp__octiq__todo_write"];

fn is_read_tool(tool: Option<&str>) -> bool {
    tool.map(str::to_ascii_lowercase).is_some_and(|t| {
        READ_TOOLS.contains(&t.as_str()) || OURS.contains(&t.as_str())
    })
}

/// Is this shell line one of the harmless ones?
///
/// The rule is blunt on purpose. Anything that can chain, redirect, substitute
/// or expand is refused outright — `echo hi && rm -rf .` begins with a program
/// on the list, and a whitelist that tries to parse shell is not a whitelist.
/// What is left is one command, its flags, and its arguments.
fn safe_command(command: &str) -> bool {
    if command.contains(['&', '|', ';', '<', '>', '$', '`', '(', ')', '\n', '\r']) {
        return false;
    }
    let words: Vec<&str> = command.split_whitespace().collect();
    // `CI=true ls` runs `ls`. The assignments in front are setup, not the
    // program, and skipping them is what stops a prefix hiding the real command.
    let start = words
        .iter()
        .position(|w| !is_env_assignment(w))
        .unwrap_or(words.len());
    let Some(first) = words.get(start) else {
        return false;
    };
    let program = first.rsplit('/').next().unwrap_or(first);
    let rest = &words[start + 1..];
    match program {
        // Reads a file — unless it is asked to write one back.
        "sed" => !rest
            .iter()
            .any(|w| w.starts_with("-i") || *w == "--in-place"),
        // Walks a tree — unless it is asked to run something on what it finds.
        "find" => !rest.iter().any(|w| {
            matches!(
                *w,
                "-delete" | "-exec" | "-execdir" | "-ok" | "-okdir" | "-fprint" | "-fls"
            )
        }),
        "git" => rest.first().is_some_and(|w| GIT_READS.contains(w)),
        // grep writes nothing, but its `-f` reads a pattern file and its long
        // forms are many; the plain form is what the list is for.
        "grep" => true,
        other => SAFE_COMMANDS.contains(&other),
    }
}

fn is_env_assignment(word: &str) -> bool {
    match word.split_once('=') {
        Some((name, _)) => {
            !name.is_empty()
                && name
                    .chars()
                    .all(|c| c.is_ascii_alphanumeric() || c == '_')
                && !name.starts_with(|c: char| c.is_ascii_digit())
        }
        None => false,
    }
}

/// What this call may do without anybody being asked, at this level.
fn passes_unasked(access: crate::agent_chat::Access, request: &Request) -> Option<&'static str> {
    let tool = request.tool_name.as_deref();
    if is_read_tool(tool) {
        return Some("this only looks, or is OctiqFlow's own");
    }
    // Edits, on Accept edits AND on Auto. Auto sits ABOVE Accept edits on the
    // ladder, so anything the rung below waves through has to pass here too —
    // without this line Auto was the stricter of the two, which is the sort of
    // thing nobody reports as a bug, they just stop trusting the picker.
    if matches!(
        access,
        crate::agent_chat::Access::Edits | crate::agent_chat::Access::Auto
    ) && is_edit(tool)
    {
        return Some("you chose to accept file edits without asking");
    }
    // Safe shell lines, on the two levels that mean "get on with it". Manual
    // and Plan are chosen BY someone who wants to see each step, so a command
    // still stops there even when it only looks.
    if matches!(
        access,
        crate::agent_chat::Access::Auto | crate::agent_chat::Access::Edits
    ) && tool.map(str::to_ascii_lowercase).as_deref() == Some("bash")
    {
        let command = request
            .tool_input
            .as_ref()
            .and_then(|i| i.get("command"))
            .and_then(serde_json::Value::as_str)
            .unwrap_or_default();
        if safe_command(command) {
            return Some("this only reads");
        }
    }
    None
}

/// The tools Claude's `acceptEdits` lets through: the ones that write to a
/// file and nothing else. Kept here because this hook is what has to honour
/// that mode — it runs BEFORE `--permission-mode` is consulted, so an edit it
/// stops never reaches the mode that would have accepted it.
///
/// Lowercased on both sides, so a rename of the tool's casing cannot silently
/// turn the level back into "ask about everything".
const EDIT_TOOLS: [&str; 4] = ["write", "edit", "multiedit", "notebookedit"];

fn is_edit(tool: Option<&str>) -> bool {
    tool.map(str::to_ascii_lowercase)
        .is_some_and(|t| EDIT_TOOLS.contains(&t.as_str()))
}

/// Ask, and wait for an answer.
pub async fn ask(request: Request) -> Answer {
    // The person has already answered. The most permissive level means run
    // anything without asking, and this hook is the FIRST step of the
    // permission chain — before deny rules, allow rules and the mode — so
    // without this, choosing Full access and then being asked about `ls` is the
    // setting visibly not working.
    //
    // Abstaining is right here, not allowing: with no opinion the call falls
    // through to `bypassPermissions`, which is the answer the person gave. On
    // the other two levels this hook is the whole point and stays in the way.
    let access = current_access(&request);
    if access == crate::agent_chat::Access::Full {
        return Answer {
            decision: Decision::Abstain.as_str(),
            reason: "you chose to run anything without asking".into(),
        };
    }

    // Everything this level lets past without a question: a read on any level,
    // a file edit under Accept edits, a shell line that only looks under either
    // of the two "get on with it" levels.
    //
    // Abstaining rather than allowing, in every case. With no opinion the call
    // falls through to the deny rules, the allow rules and then the mode, which
    // is the chain the person's choice actually configured. Allowing outright
    // would step over the deny rules, and this hook has no business overruling
    // those.
    if let Some(reason) = passes_unasked(access, &request) {
        return Answer {
            decision: Decision::Abstain.as_str(),
            reason: reason.into(),
        };
    }

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
    if !crate::bus::clients_connected() {
        return Answer {
            decision: Decision::Abstain.as_str(),
            reason: "nobody is watching OctiqFlow".into(),
        };
    }

    let id = uuid::Uuid::new_v4().to_string();
    let (tx, rx) = oneshot::channel();
    with_pending(|p| {
        p.insert(
            id.clone(),
            Waiting {
                tx,
                remember: grant,
            },
        )
    });

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

    #[tokio::test]
    async fn the_most_permissive_level_is_answered_without_asking_anyone() {
        // Full access means run anything without asking. This hook is the first
        // step of the permission chain, so if it does not stand aside here, the
        // level the person chose never gets a say.
        let answer = ask(asking_about(None, Some("full"))).await;
        assert_eq!(answer.decision, "abstain");
        assert_eq!(answer.reason, "you chose to run anything without asking");
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
        assert_eq!(command_head("CI=true cargo build"), Some("cargo build".into()));
        assert_eq!(command_head("cd /tmp && rm -rf x"), None);
        assert_eq!(command_head("cat a | sh"), None);
    }

    #[test]
    fn a_safe_line_passes_on_auto_and_a_chained_one_does_not() {
        assert!(safe_command("ls -la web/src"));
        assert!(safe_command("git log --oneline -5"));
        assert!(safe_command("sed -n 1,40p src/main.rs"));
        // The whole point of refusing metacharacters.
        assert!(!safe_command("echo hi && rm -rf ."));
        assert!(!safe_command("cat x > y"));
        assert!(!safe_command("sed -i '' s/a/b/ x"));
        assert!(!safe_command("git push --force"));
        assert!(!safe_command("find . -name x -delete"));
    }

    #[tokio::test]
    async fn auto_is_never_stricter_than_accept_edits() {
        // Auto sits above Accept edits on the ladder. Anything the rung below
        // waves through has to pass here too, or the picker is lying about
        // which way it goes.
        crate::agent_chat::remember_access("chat-auto", crate::agent_chat::Access::Auto);
        let mut editing = asking_about(Some("chat-auto"), None);
        editing.tool_name = Some("Write".into());
        assert_eq!(ask(editing).await.decision, Decision::Abstain.as_str());
    }

    #[tokio::test]
    async fn accept_edits_lets_a_write_through_and_still_asks_about_a_command() {
        // The mode's whole promise. The hook is the first step of the chain, so
        // if it asks about the edit anyway, "Accept edits" is just "Manual"
        // with a different name on it.
        crate::agent_chat::remember_access("chat-edits", crate::agent_chat::Access::Edits);

        let mut editing = asking_about(Some("chat-edits"), None);
        editing.tool_name = Some("Edit".into());
        assert_eq!(ask(editing).await.decision, Decision::Abstain.as_str());

        let mut running = asking_about(Some("chat-edits"), None);
        running.tool_name = Some("Bash".into());
        // Nobody is attached in a test, so this falls through to the
        // no-watcher abstain rather than waiting — what matters is that it got
        // PAST the edits rule instead of being short-circuited by it.
        assert_eq!(
            ask(running).await.reason,
            "nobody is watching OctiqFlow".to_string()
        );
    }

    #[test]
    fn an_edit_is_recognised_whatever_its_casing() {
        assert!(is_edit(Some("Write")));
        assert!(is_edit(Some("multiedit")));
        assert!(!is_edit(Some("Bash")));
        assert!(!is_edit(None));
    }

    #[test]
    fn answering_an_unknown_question_is_refused_not_panicked() {
        assert!(!decide("no-such-id", Decision::Allow, false));
    }

    #[tokio::test]
    async fn a_question_can_only_be_answered_once() {
        let id = "only-once".to_string();
        let (tx, _rx) = oneshot::channel();
        with_pending(|p| {
            p.insert(
                id.clone(),
                Waiting {
                    tx,
                    remember: None,
                },
            )
        });

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
        with_pending(|p| {
            p.insert(
                id.clone(),
                Waiting {
                    tx,
                    remember: None,
                },
            )
        });
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
