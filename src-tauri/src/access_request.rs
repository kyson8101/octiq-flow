//! An agent asking the person to raise its chat's access level.
//!
//! The `request_access` MCP tool (`scripts/mcp/octiq-ask.cjs` → `POST
//! /hook/access`) puts a card in the chat its launch's capability proves: the
//! level the chat runs at, the level asked for, and why. That is ALL a call can
//! do. Nothing here changes a level. The card's Upgrade makes the page call
//! `chat_set_access` — the same command the composer's access picker sends, on
//! the person's socket, which an agent never has — and only then answers the
//! card, so the agent hears what happened.
//!
//! What the agent is told about a raise is read back from the chat's own
//! record of its level (`ChatManager::access_standing`), never from the page's
//! word: a card answered "raised" for a chat still on its old level says so.
//!
//! When a new level takes hold differs by provider, and the card and the
//! answer both say which (`Takes`):
//!
//!   * Claude takes a `set_permission_mode` control request mid-turn, so a
//!     raise applies to the call it is waiting in.
//!   * Codex's app-server, and every command-line provider, take it from the
//!     next turn: this turn keeps the level it started on.
//!   * Antigravity takes a level only between turns, and refuses the change
//!     while one is running. So its call does not wait: the card stays up, the
//!     agent is told to end its turn, and the person's choice applies to the
//!     message that resumes it.
//!
//! Like a permission card it never blocks on nobody: with no browser
//! watching, a waiting call is answered at once and no card is drawn.
use std::collections::HashMap;
use std::sync::Mutex;
use std::time::Duration;

use serde::{Deserialize, Serialize};
use tokio::sync::oneshot;

use crate::agent_provider::{Access, AgentCapabilities, AgentKind};

/// How long Claude's call may wait: as long as a permission card.
pub const CLAUDE_WAIT: Duration = crate::permission::ANSWER_TIMEOUT;
/// Codex gives an MCP call about a minute, so its card closes first, and a
/// late Upgrade is not read by Codex as a failed call (`team_tools`).
pub const CODEX_WAIT: Duration = Duration::from_secs(50);

/// When a raised level reaches the agent.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum Takes {
    /// In the call the agent is waiting in.
    Now,
    /// From the agent's next turn; this one keeps its level.
    NextTurn,
    /// Only between turns; the agent ends this one first.
    BetweenTurns,
}

/// Which of the three a chat's process is, from what it can do. A Codex
/// app-server thread is told apart by its session, not its capabilities: the
/// exec fallback has the same provider and no live channel at all.
pub fn takes(app_server_thread: bool, capabilities: AgentCapabilities) -> Takes {
    if app_server_thread {
        return Takes::NextTurn;
    }
    if capabilities.supports_live_access_change {
        return Takes::Now;
    }
    if capabilities.input.accepts_stdin() && capabilities.interrupt_ends_process {
        return Takes::BetweenTurns;
    }
    Takes::NextTurn
}

/// What an access request needs to know about the chat it is for.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Standing {
    pub agent: AgentKind,
    pub access: Access,
    pub takes: Takes,
}

/// Lowest to highest: what each level lets an agent do without asking.
pub const fn rank(access: Access) -> u8 {
    match access {
        Access::Read => 0,
        Access::Manual => 1,
        Access::Edits => 2,
        Access::Auto => 3,
        Access::Full => 4,
    }
}

/// The levels each provider's access picker offers, lowest first. Kept in step
/// with `access` in `web/src/lib/agentProviders.ts`: a card may only ask for a
/// level the picker can show.
pub const fn offered(agent: AgentKind) -> &'static [Access] {
    match agent {
        AgentKind::Claude => &[
            Access::Read,
            Access::Manual,
            Access::Edits,
            Access::Auto,
            Access::Full,
        ],
        AgentKind::Codex => &[Access::Read, Access::Auto, Access::Full],
        AgentKind::Pi => &[Access::Read, Access::Full],
        AgentKind::Antigravity => &[Access::Read, Access::Edits, Access::Auto, Access::Full],
    }
}

/// The least level this provider offers that covers `wanted`. Codex has no
/// Accept edits; its Workspace write is the least that lets an edit through.
pub fn least_offered(agent: AgentKind, wanted: Access) -> Access {
    offered(agent)
        .iter()
        .copied()
        .find(|level| rank(*level) >= rank(wanted))
        .unwrap_or(Access::Full)
}

/// The level's name as this provider's access picker shows it, so the agent
/// and the person read the same words.
pub const fn label(agent: AgentKind, access: Access) -> &'static str {
    match (agent, access) {
        (AgentKind::Codex | AgentKind::Pi, Access::Read) => "Read-only",
        (_, Access::Read) => "Plan",
        (AgentKind::Antigravity, Access::Manual) => "Antigravity's default mode",
        (_, Access::Manual) => "Manual",
        (_, Access::Edits) => "Accept edits",
        (AgentKind::Codex, Access::Auto) => "Workspace write",
        (AgentKind::Antigravity, Access::Auto) => "Auto · unguarded",
        (_, Access::Auto) => "Auto",
        (AgentKind::Claude, Access::Full) => "Bypass permissions",
        (AgentKind::Codex, Access::Full) => "Danger: full access",
        (AgentKind::Pi, Access::Full) => "Full access",
        (AgentKind::Antigravity, Access::Full) => "Skip permissions",
    }
}

/// `request_access`'s arguments, as the hook receives them.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Ask {
    pub level: Access,
    #[serde(default)]
    pub reason: String,
}

/// The longest reason a card shows. An agent's reason is a sentence or two.
const REASON_LIMIT: usize = 1000;

/// The card, as it goes out to the page and comes back on a reconnect.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Asked {
    pub id: String,
    pub chat_key: String,
    pub agent: AgentKind,
    pub current: Access,
    pub requested: Access,
    pub reason: String,
    pub takes: Takes,
    /// Whether the agent's call is held open for the answer. When it is not
    /// (Antigravity), the card is the person's alone and outlives the turn.
    pub wait: bool,
    /// The card's real deadline, when a call waits.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub answer_within_secs: Option<u64>,
}

/// The person's answer, as the page reports it AFTER acting on it.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Decision {
    /// The page called `chat_set_access` and it succeeded.
    Raised,
    Declined,
    /// The person chose Upgrade and the change failed; `error` says why.
    Failed,
}

#[derive(Debug, Clone, PartialEq, Eq)]
enum Outcome {
    Answered(Decision, Option<String>),
    TimedOut,
    Unwatched,
}

struct Waiting {
    /// None for a card no call waits on.
    tx: Option<oneshot::Sender<(Decision, Option<String>)>>,
    asked: Asked,
}

static PENDING: Mutex<Option<HashMap<String, Waiting>>> = Mutex::new(None);

fn with_pending<T>(f: impl FnOnce(&mut HashMap<String, Waiting>) -> T) -> T {
    let mut guard = PENDING.lock().unwrap_or_else(|e| e.into_inner());
    f(guard.get_or_insert_with(HashMap::new))
}

/// Every card still waiting on the person, for a browser that has just
/// connected: the announcement has no replay.
pub fn pending() -> Vec<Asked> {
    with_pending(|p| p.values().map(|w| w.asked.clone()).collect())
}

/// Take a card down everywhere it is drawn.
fn take_down(id: &str) {
    crate::bus::emit("access-request-expired", serde_json::json!({ "id": id }));
}

/// The chat stopped: its cards ask about a process that is gone.
pub fn forget_chat(chat_key: &str) {
    let gone: Vec<String> = with_pending(|p| {
        let ids: Vec<String> = p
            .iter()
            .filter(|(_, w)| w.asked.chat_key == chat_key)
            .map(|(id, _)| id.clone())
            .collect();
        for id in &ids {
            p.remove(id);
        }
        ids
    });
    for id in gone {
        take_down(&id);
    }
}

/// The person's answer to a card. `false` when it is already gone: answered
/// on another page, timed out, or its chat stopped.
pub fn answer(id: &str, decision: Decision, error: Option<String>) -> bool {
    let Some(waiting) = with_pending(|p| p.remove(id)) else {
        return false;
    };
    if let Some(tx) = waiting.tx {
        let _ = tx.send((decision, error));
    }
    take_down(id);
    true
}

/// Remove a card when the call holding it goes, however it goes: answered,
/// timed out, or dropped because the agent's MCP hung up mid-wait.
struct Held(String);
impl Drop for Held {
    fn drop(&mut self) {
        if with_pending(|p| p.remove(&self.0)).is_some() {
            take_down(&self.0);
        }
    }
}

/// Why nothing was asked, when a request cannot stand. A level the chat
/// already has needs no card, and neither does a lower one: lowering is the
/// person's, from the picker.
pub fn check(agent: AgentKind, current: Access, requested: Access) -> Result<(), String> {
    if rank(requested) <= rank(current) {
        return Err(format!(
            "This chat already runs at {}, which covers {}. Nothing was asked; carry on.",
            label(agent, current),
            label(agent, requested)
        ));
    }
    Ok(())
}

fn trimmed_reason(reason: &str) -> String {
    let reason = reason.trim();
    if reason.chars().count() <= REASON_LIMIT {
        return reason.to_string();
    }
    let cut: String = reason.chars().take(REASON_LIMIT).collect();
    format!("{cut}…")
}

/// How long the agent's call waits for this provider, or None for one whose
/// call must not wait.
pub fn wait_for(standing: Standing) -> Option<Duration> {
    match (standing.takes, standing.agent) {
        (Takes::BetweenTurns, _) => None,
        (_, AgentKind::Codex) => Some(CODEX_WAIT),
        _ => Some(CLAUDE_WAIT),
    }
}

/// Put the card up and, where the provider allows, wait for the person.
///
/// `level_now` reads the chat's level after an answer, so the result names
/// what the chat really runs at. `announce` carries the card to a phone; it is
/// a parameter so tests never reach the person's real push subscription.
pub async fn request(
    chat_key: &str,
    standing: Standing,
    ask: Ask,
    level_now: impl Fn() -> Option<Access>,
    announce: impl FnOnce(&Asked),
) -> Result<String, String> {
    let requested = least_offered(standing.agent, ask.level);
    check(standing.agent, standing.access, requested)?;
    let reason = trimmed_reason(&ask.reason);
    if reason.is_empty() {
        return Err(
            "Say why this chat needs the higher level: the person decides on that reason.".into(),
        );
    }
    let within = wait_for(standing);
    // Never hold an agent on a card nobody can see.
    if within.is_some() && !crate::bus::watched_within(crate::question::RELOAD_GRACE) {
        return Ok(answer_text(
            standing,
            requested,
            &Outcome::Unwatched,
            standing.access,
        ));
    }
    let id = uuid::Uuid::new_v4().to_string();
    let asked = Asked {
        id: id.clone(),
        chat_key: chat_key.to_string(),
        agent: standing.agent,
        current: standing.access,
        requested,
        reason,
        takes: standing.takes,
        wait: within.is_some(),
        answer_within_secs: within.map(|d| d.as_secs()),
    };
    let Some(within) = within else {
        // A newer request from the same chat replaces its older card.
        let stale: Vec<String> = with_pending(|p| {
            let ids: Vec<String> = p
                .iter()
                .filter(|(_, w)| w.asked.chat_key == chat_key && w.tx.is_none())
                .map(|(id, _)| id.clone())
                .collect();
            for old in &ids {
                p.remove(old);
            }
            p.insert(
                id.clone(),
                Waiting {
                    tx: None,
                    asked: asked.clone(),
                },
            );
            ids
        });
        for old in stale {
            take_down(&old);
        }
        crate::bus::emit("access-request", &asked);
        announce(&asked);
        return Ok(not_waiting_text(standing, requested));
    };
    let (tx, rx) = oneshot::channel();
    with_pending(|p| {
        p.insert(
            id.clone(),
            Waiting {
                tx: Some(tx),
                asked: asked.clone(),
            },
        )
    });
    let _held = Held(id);
    crate::bus::emit("access-request", &asked);
    announce(&asked);
    let outcome = tokio::select! {
        answered = tokio::time::timeout(within, rx) => match answered {
            Ok(Ok((decision, error))) => Outcome::Answered(decision, error),
            _ => Outcome::TimedOut,
        },
        _ = crate::bus::once_unwatched(crate::question::RELOAD_GRACE) => Outcome::Unwatched,
    };
    let now = level_now().unwrap_or(standing.access);
    Ok(answer_text(standing, requested, &outcome, now))
}

/// What the agent is told when its call does not wait for the person.
fn not_waiting_text(standing: Standing, requested: Access) -> String {
    format!(
        "Your request for {} is on a card in this chat. This agent takes a new access level only between turns, so end this turn now: say what you will do once the access is raised, and do not retry the refused work. If the person raises it, their next message continues at the new level. Access is {} until then.",
        label(standing.agent, requested),
        label(standing.agent, standing.access)
    )
}

/// What the agent is told once the card is settled. `now` is the chat's level
/// as the host records it after the answer.
fn answer_text(standing: Standing, requested: Access, outcome: &Outcome, now: Access) -> String {
    let stays = format!(
        "Access stays at {}. Carry on within it, or say plainly what you cannot do; do not ask again unless the person asks you to.",
        label(standing.agent, standing.access)
    );
    match outcome {
        Outcome::Unwatched => format!(
            "Nobody has OctiqFlow open, so the person could not be asked. {stays}"
        ),
        Outcome::TimedOut => format!("Nobody answered the card in time. {stays}"),
        Outcome::Answered(Decision::Declined, _) => format!("The person declined. {stays}"),
        Outcome::Answered(Decision::Failed, error) => format!(
            "The person chose to raise the access, but the change failed{}. {stays}",
            error
                .as_deref()
                .map(|why| format!(": {}", why.trim()))
                .unwrap_or_default()
        ),
        Outcome::Answered(Decision::Raised, _) if rank(now) < rank(requested) => format!(
            "The person chose to raise the access, but this chat still runs at {}. Carry on within it, or say plainly what you cannot do.",
            label(standing.agent, now)
        ),
        Outcome::Answered(Decision::Raised, _) => match standing.takes {
            Takes::Now => format!(
                "The person raised this chat's access to {}. It applies now: carry on with the work.",
                label(standing.agent, now)
            ),
            Takes::NextTurn | Takes::BetweenTurns => format!(
                "The person raised this chat's access to {}. It applies from your next turn; this turn still runs at {}. Do what this level allows now, then end the turn saying what you will do next; the person's next message continues at {}.",
                label(standing.agent, now),
                label(standing.agent, standing.access),
                label(standing.agent, now)
            ),
        },
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::agent_provider::InputTransport;

    fn caps(input: InputTransport, live: bool, interrupt_ends: bool) -> AgentCapabilities {
        AgentCapabilities {
            input,
            supports_live_access_change: live,
            supports_lite_mode: false,
            uses_octiq_mcp: true,
            interrupt_ends_process: interrupt_ends,
        }
    }

    fn standing(agent: AgentKind, access: Access, takes: Takes) -> Standing {
        Standing {
            agent,
            access,
            takes,
        }
    }

    #[test]
    fn each_provider_says_when_a_raise_takes_hold() {
        // Claude: a live control request.
        assert_eq!(
            takes(false, caps(InputTransport::StreamJson, true, false)),
            Takes::Now
        );
        // Codex app-server: the next turn/start carries the policy.
        assert_eq!(
            takes(true, caps(InputTransport::AppServer, true, false)),
            Takes::NextTurn
        );
        // Antigravity: one process per chat, no control message.
        assert_eq!(
            takes(false, caps(InputTransport::StreamJson, false, true)),
            Takes::BetweenTurns
        );
        // A command-line provider (Pi, Codex's exec fallback).
        assert_eq!(
            takes(false, caps(InputTransport::CommandLine, false, false)),
            Takes::NextTurn
        );
        // The real providers agree.
        let provider = |kind| crate::agent_provider::provider_for(kind).capabilities();
        assert_eq!(takes(false, provider(AgentKind::Claude)), Takes::Now);
        assert_eq!(
            takes(false, provider(AgentKind::Antigravity)),
            Takes::BetweenTurns
        );
        assert_eq!(takes(false, provider(AgentKind::Pi)), Takes::NextTurn);
    }

    #[test]
    fn only_a_higher_level_is_asked_for() {
        assert!(check(AgentKind::Claude, Access::Read, Access::Edits).is_ok());
        assert!(check(AgentKind::Claude, Access::Read, Access::Manual).is_ok());
        assert!(check(AgentKind::Claude, Access::Auto, Access::Full).is_ok());
        let same = check(AgentKind::Claude, Access::Edits, Access::Edits).unwrap_err();
        assert!(same.contains("already runs at Accept edits"), "{same}");
        assert!(check(AgentKind::Claude, Access::Auto, Access::Edits).is_err());
        assert!(check(AgentKind::Claude, Access::Full, Access::Read).is_err());
    }

    #[test]
    fn a_level_the_picker_does_not_offer_becomes_the_least_one_that_covers_it() {
        assert_eq!(least_offered(AgentKind::Codex, Access::Edits), Access::Auto);
        assert_eq!(
            least_offered(AgentKind::Codex, Access::Manual),
            Access::Auto
        );
        assert_eq!(least_offered(AgentKind::Pi, Access::Edits), Access::Full);
        assert_eq!(
            least_offered(AgentKind::Antigravity, Access::Manual),
            Access::Edits
        );
        assert_eq!(
            least_offered(AgentKind::Claude, Access::Manual),
            Access::Manual
        );
        for agent in AgentKind::ALL {
            for level in Access::ALL_FOR_TESTS {
                assert!(rank(least_offered(agent, level)) >= rank(level));
                assert!(offered(agent).contains(&least_offered(agent, level)));
            }
        }
        assert_eq!(label(AgentKind::Codex, Access::Auto), "Workspace write");
        assert_eq!(label(AgentKind::Claude, Access::Read), "Plan");
    }

    #[test]
    fn only_antigravity_does_not_wait_and_codex_waits_less_than_its_tool_timeout() {
        assert_eq!(
            wait_for(standing(AgentKind::Claude, Access::Read, Takes::Now)),
            Some(CLAUDE_WAIT)
        );
        let codex = wait_for(standing(AgentKind::Codex, Access::Read, Takes::NextTurn)).unwrap();
        assert!(codex < Duration::from_secs(60), "{codex:?}");
        assert_eq!(
            wait_for(standing(
                AgentKind::Antigravity,
                Access::Read,
                Takes::BetweenTurns
            )),
            None
        );
    }

    #[test]
    fn the_answer_names_the_level_the_host_records_not_the_pages_word() {
        let claude = standing(AgentKind::Claude, Access::Read, Takes::Now);
        let raised = Outcome::Answered(Decision::Raised, None);
        let text = answer_text(claude, Access::Edits, &raised, Access::Edits);
        assert!(
            text.contains("raised this chat's access to Accept edits"),
            "{text}"
        );
        assert!(text.contains("applies now"), "{text}");
        // The page said raised, but the chat is still on its old level.
        let text = answer_text(claude, Access::Edits, &raised, Access::Read);
        assert!(text.contains("still runs at Plan"), "{text}");
        assert!(!text.contains("raised this chat's access"), "{text}");
    }

    #[test]
    fn a_next_turn_provider_is_told_this_turn_keeps_its_level() {
        let codex = standing(AgentKind::Codex, Access::Read, Takes::NextTurn);
        let text = answer_text(
            codex,
            Access::Auto,
            &Outcome::Answered(Decision::Raised, None),
            Access::Auto,
        );
        assert!(text.contains("applies from your next turn"), "{text}");
        assert!(text.contains("this turn still runs at Read-only"), "{text}");
    }

    #[test]
    fn a_decline_a_failure_and_silence_each_leave_the_level_and_say_why() {
        let claude = standing(AgentKind::Claude, Access::Edits, Takes::Now);
        for (outcome, words) in [
            (Outcome::Answered(Decision::Declined, None), "declined"),
            (Outcome::TimedOut, "in time"),
            (Outcome::Unwatched, "could not be asked"),
            (
                Outcome::Answered(
                    Decision::Failed,
                    Some("Full access needs a fresh agent".into()),
                ),
                "Full access needs a fresh agent",
            ),
        ] {
            let text = answer_text(claude, Access::Auto, &outcome, Access::Edits);
            assert!(text.contains(words), "{text}");
            assert!(text.contains("Access stays at Accept edits"), "{text}");
            assert!(text.contains("do not ask again"), "{text}");
        }
    }

    #[test]
    fn the_ask_reads_the_tools_arguments() {
        let ask: Ask = serde_json::from_value(
            serde_json::json!({ "level": "edits", "reason": "write the fix" }),
        )
        .unwrap();
        assert_eq!(ask.level, Access::Edits);
        assert!(serde_json::from_value::<Ask>(serde_json::json!({ "level": "root" })).is_err());
    }

    #[tokio::test]
    async fn a_refused_request_puts_no_card_up() {
        let claude = standing(AgentKind::Claude, Access::Auto, Takes::Now);
        let ask = Ask {
            level: Access::Edits,
            reason: "x".into(),
        };
        let refused = request(
            "chat:t-refused",
            claude,
            ask,
            || None,
            |_| panic!("announced"),
        )
        .await
        .unwrap_err();
        assert!(refused.contains("already runs at Auto"), "{refused}");
        let blank = request(
            "chat:t-refused",
            standing(AgentKind::Claude, Access::Read, Takes::Now),
            Ask {
                level: Access::Edits,
                reason: "  ".into(),
            },
            || None,
            |_| panic!("announced"),
        )
        .await
        .unwrap_err();
        assert!(blank.contains("Say why"), "{blank}");
        assert!(pending().iter().all(|a| a.chat_key != "chat:t-refused"));
    }

    #[tokio::test]
    async fn a_waiting_request_with_nobody_watching_is_answered_at_once() {
        // No browser is attached in a test process.
        let text = request(
            "chat:t-unwatched",
            standing(AgentKind::Claude, Access::Read, Takes::Now),
            Ask {
                level: Access::Edits,
                reason: "write the fix".into(),
            },
            || None,
            |_| panic!("announced"),
        )
        .await
        .unwrap();
        assert!(text.contains("could not be asked"), "{text}");
        assert!(pending().iter().all(|a| a.chat_key != "chat:t-unwatched"));
    }

    #[tokio::test]
    async fn an_antigravity_request_leaves_a_card_the_next_one_replaces() {
        let agy = standing(AgentKind::Antigravity, Access::Read, Takes::BetweenTurns);
        let key = "chat:t-agy";
        let mut announced = 0;
        let text = request(
            key,
            agy,
            Ask {
                level: Access::Edits,
                reason: "write notes.txt".into(),
            },
            || None,
            |_| announced += 1,
        )
        .await
        .unwrap();
        assert_eq!(announced, 1);
        assert!(text.contains("end this turn now"), "{text}");
        let first: Vec<Asked> = pending()
            .into_iter()
            .filter(|a| a.chat_key == key)
            .collect();
        assert_eq!(first.len(), 1);
        assert!(!first[0].wait);
        assert_eq!(first[0].takes, Takes::BetweenTurns);
        request(
            key,
            agy,
            Ask {
                level: Access::Auto,
                reason: "run the tests".into(),
            },
            || None,
            |_| {},
        )
        .await
        .unwrap();
        let second: Vec<Asked> = pending()
            .into_iter()
            .filter(|a| a.chat_key == key)
            .collect();
        assert_eq!(second.len(), 1, "the newer card replaces the older");
        assert_eq!(second[0].requested, Access::Auto);
        assert!(answer(&second[0].id, Decision::Raised, None));
        assert!(
            !answer(&second[0].id, Decision::Raised, None),
            "answered once"
        );
        assert!(pending().iter().all(|a| a.chat_key != key));
    }

    #[test]
    fn stopping_a_chat_takes_its_cards_down() {
        let asked = |id: &str, key: &str| Asked {
            id: id.into(),
            chat_key: key.into(),
            agent: AgentKind::Antigravity,
            current: Access::Read,
            requested: Access::Edits,
            reason: "r".into(),
            takes: Takes::BetweenTurns,
            wait: false,
            answer_within_secs: None,
        };
        with_pending(|p| {
            p.insert(
                "t-stop-1".into(),
                Waiting {
                    tx: None,
                    asked: asked("t-stop-1", "chat:t-stop"),
                },
            );
            p.insert(
                "t-stop-2".into(),
                Waiting {
                    tx: None,
                    asked: asked("t-stop-2", "chat:t-keep"),
                },
            );
        });
        forget_chat("chat:t-stop");
        let ids: Vec<String> = pending().into_iter().map(|a| a.id).collect();
        assert!(!ids.contains(&"t-stop-1".to_string()));
        assert!(ids.contains(&"t-stop-2".to_string()));
        forget_chat("chat:t-keep");
    }

    #[tokio::test]
    async fn a_held_card_goes_when_its_call_does() {
        let (tx, rx) = oneshot::channel();
        let asked = Asked {
            id: "t-held".into(),
            chat_key: "chat:t-held".into(),
            agent: AgentKind::Claude,
            current: Access::Read,
            requested: Access::Edits,
            reason: "r".into(),
            takes: Takes::Now,
            wait: true,
            answer_within_secs: Some(180),
        };
        with_pending(|p| {
            p.insert(
                "t-held".into(),
                Waiting {
                    tx: Some(tx),
                    asked,
                },
            )
        });
        {
            let _held = Held("t-held".into());
            assert!(answer("t-held", Decision::Declined, None));
        }
        assert_eq!(rx.await.unwrap(), (Decision::Declined, None));
        // The MCP hung up before anyone answered: the guard alone removes it.
        let (tx, _rx) = oneshot::channel();
        with_pending(|p| {
            p.insert(
                "t-dropped".into(),
                Waiting {
                    tx: Some(tx),
                    asked: Asked {
                        id: "t-dropped".into(),
                        chat_key: "chat:t-held".into(),
                        agent: AgentKind::Claude,
                        current: Access::Read,
                        requested: Access::Edits,
                        reason: "r".into(),
                        takes: Takes::Now,
                        wait: true,
                        answer_within_secs: Some(180),
                    },
                },
            )
        });
        drop(Held("t-dropped".into()));
        assert!(pending().iter().all(|a| a.id != "t-dropped"));
    }
}
