//! `chat_turn_delivery`: what became of a person's turn, by id.
//!
//! A page that drew a message optimistically and then lost the live stream
//! (a reload, a dropped socket, a line it never heard) has to say whether the
//! message is waiting, delivered, or lost. It used to guess from what it had
//! drawn and told the person `Not sent` for turns the host had dispatched and
//! the agent had answered. This command answers from the host's own facts,
//! the queue in memory and the chat's record on disk, so the page asks
//! instead of guessing.
//!
//! **Socket only, read-only.** It has an arm in `dispatch.rs` and no hook
//! action and no MCP tool; it writes nothing and takes no chat lock but the
//! queue's, for the length of one lookup.
//!
//! ```text
//! chat_turn_delivery { chatKey: string, turnIds: string[1..=32] }
//!   -> { turns: { [turnId]: { state, seq?, into? } } }
//! ```
//!
//! `chatKey` must be a chat the index lists (`chat:<id>` or the bare id; both read the same queue and record).
//! `turnIds` is 1 to 32 ids, each 1 to 256 characters; anything else is an
//! error in words. Duplicates are answered once.
//!
//! `state` is the newest fact the host holds for the turn, newest by the
//! record's logical `seq`:
//!
//! | state | what holds |
//! | --- | --- |
//! | `queued` | the turn is in `ChatManager::queued_turns` now. Asked first, from memory; it has no `seq`. |
//! | `accepted` | the record holds the agent's own pickup: a line carrying `octiq_user_turn_id` = the id (Claude's echo of the prompt, Codex's `turn.started`, Pi's `turn_start`, Antigravity's equivalent). Final: see below. |
//! | `dispatched` | the newest fact is an `octiq_user_turn_delivery` line saying `dispatched`, `starting` or `unknown`, and there is no pickup. |
//! | `failed` | the newest fact is a delivery line saying `failed`. |
//! | `cancelled` | `octiq_user_turn_cancelled`: the person took it back. |
//! | `dismissed` | `octiq_user_turn_dismissed`: the page dropped an unsent bubble. |
//! | `absent` | nothing about the id in the queue or the record. |
//!
//! `seq` is the logical seq of the line that decided the state, so a page can
//! tell an old answer from a new one. It is left out for `queued` and `absent`.
//!
//! `chat_dismiss_unsent` goes through `append_unless_picked_up` (this module's
//! one definition of a pickup) and answers `false`, writing no
//! `octiq_user_turn_dismissed` line, for a turn the agent has taken up. The
//! check and the append are one step against the record: the whole record is
//! read outside every lock, and the append (`transcript::append_after_walk`)
//! then asks under the append lock that the record is still the same file and
//! life and that nothing was added after the end that was read. A line that
//! was (a pickup landing after the read) is read as a tail and the decision
//! is made again; a record replaced during the read is read again whole. The
//! mark is the end of the last whole (newline-terminated) line, never a byte
//! of a line a writer is still finishing; see docs/chat-record-storage.md.
//!
//! `chatKey` is canonicalized once to `chat:<id>`: the queue and the record
//! are kept under that key, and a bare id names the same chat.
//!
//! A turn appended to another before it was sent (`octiq_user_turn_appended`,
//! the page reads it as `sourceTurnIds`) has no pickup of its own: the agent
//! echoes the target's id. It is answered with the target's state and `into`
//! is the target's id. A turn merged into a queued unit is `queued` with
//! `into` set the same way.
//!
//! Three rules where the host's lines are not simply ordered:
//!
//! - **A pickup is final.** Once the agent has taken a turn up, nothing
//!   un-sends it, so `accepted` stands over a `dispatched` line written
//!   after it (the line is written after the prompt is handed over, and the
//!   agent's echo can land first) and over a `failed`, `cancelled` or
//!   `dismissed` line written after it. The last is the record of a real
//!   chat: a page that never heard the pickup dismissed the bubble
//!   (`chat_dismiss_unsent` used to check the queue and not the record) and the
//!   newest line said `dismissed` for a turn the agent had answered. Newest
//!   wins among everything else: without a pickup, a `failed`, `cancelled` or
//!   `dismissed` line newer than the `dispatched` one is the state.
//!
//! - **A `queued` delivery line is not a fact.** The queue in memory decides
//!   it. A `queued` line with the unit gone from the queue and nothing after
//!   it is `absent`: a server that restarted took its queue with it.
//! - **`unknown`** (the process ended before it said it had the turn) is
//!   `dispatched`: the words may have reached the agent, so the page must not
//!   call them unsent (`agent_chat::host_turns` reads it the same way).
//!
//! **The read.** One pass over the record through `transcript::walk`
//! (`for_each_line`: logical seq, `octiq_compacted` ranges, disk-only list
//! references). A line is parsed only when its bytes name `"octiq_user_turn_`
//! or `"octiq_append_to"`, so a 100 MB record costs a memchr over the bytes
//! and a parse per delivery line. The scan is forward and never stops early:
//! a later line (a failure, a cancel) can still change a turn's state, and
//! the walk has no way back from the end. No lock is held during the scan; a
//! line appended while it runs may be missed, and the next ask has it. A
//! profile that is away answers with `profile::available`'s sentence (the
//! dispatch arm asks it first, like `chat_since`).

use crate::agent_chat::ChatManager;
use serde::Serialize;
use serde_json::Value;
use std::collections::BTreeMap;

/// How many ids one ask may carry.
pub(crate) const MAX_TURNS: usize = 32;
/// The longest id an ask may carry.
pub(crate) const MAX_ID_CHARS: usize = 256;
/// Appends are followed this far; a longer chain is a record that is wrong.
const MAX_HOPS: usize = 8;

/// One turn's answer.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct Delivery {
    pub state: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub seq: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub into: Option<String>,
}

#[derive(Debug, Serialize)]
pub struct Answer {
    pub turns: BTreeMap<String, Delivery>,
}

/// What the record says about one id, each fact at its newest line.
#[derive(Debug, Default, Clone)]
struct Facts {
    pickup: Option<u64>,
    dispatched: Option<u64>,
    failed: Option<u64>,
    cancelled: Option<u64>,
    dismissed: Option<u64>,
    /// The turn this one was appended to.
    merged_into: Option<String>,
}

fn newer(slot: &mut Option<u64>, seq: u64) {
    if slot.is_none_or(|old| seq > old) {
        *slot = Some(seq);
    }
}

fn later(a: Option<u64>, b: Option<u64>) -> Option<u64> {
    a.into_iter().chain(b).max()
}

impl Facts {
    fn absorb(&mut self, other: &Facts) {
        self.pickup = later(self.pickup, other.pickup);
        self.dispatched = later(self.dispatched, other.dispatched);
        self.failed = later(self.failed, other.failed);
        self.cancelled = later(self.cancelled, other.cancelled);
        self.dismissed = later(self.dismissed, other.dismissed);
    }

    /// The newest fact, except that the agent's own pickup is final: once
    /// the agent has taken a turn up nothing un-sends it, so a `dispatched`
    /// line written after the pickup (the echo can land first) and a
    /// `failed`, `cancelled` or `dismissed` line written after it (a page
    /// that dismissed a bubble it had never heard the pickup for) are the
    /// record being wrong about a turn that was delivered. See the module doc.
    fn decide(&self) -> (&'static str, Option<u64>) {
        if let Some(pickup) = self.pickup {
            return ("accepted", Some(pickup));
        }
        let ending = [
            ("failed", self.failed),
            ("cancelled", self.cancelled),
            ("dismissed", self.dismissed),
        ]
        .into_iter()
        .filter_map(|(state, seq)| seq.map(|seq| (state, seq)))
        .max_by_key(|&(_, seq)| seq);
        match (self.dispatched, ending) {
            (Some(sent), Some((state, seq))) if seq > sent => (state, Some(seq)),
            (Some(sent), _) => ("dispatched", Some(sent)),
            (None, Some((state, seq))) => (state, Some(seq)),
            (None, None) => ("absent", None),
        }
    }
}

const NEEDLES: [&[u8]; 2] = [br#""octiq_user_turn_"#, br#""octiq_append_to""#];

/// Every id's facts, folded from the record's lines one at a time, so a
/// whole record and a tail added later are read by the same code.
struct Scanner {
    needles: [memchr::memmem::Finder<'static>; 2],
    facts: BTreeMap<String, Facts>,
}

impl Scanner {
    fn new() -> Self {
        Scanner {
            needles: NEEDLES.map(memchr::memmem::Finder::new),
            facts: BTreeMap::new(),
        }
    }

    fn observe(&mut self, seq: u64, line: &[u8]) {
        if !self
            .needles
            .iter()
            .any(|needle| needle.find(line).is_some())
        {
            return;
        }
        let Ok(event) = serde_json::from_slice::<Value>(line) else {
            return;
        };
        let facts = &mut self.facts;
        // The agent's own pickup: the provider's acknowledgement, which the
        // chat stamps with the exact prompt it was written for.
        if let Some(id) = event["octiq_user_turn_id"].as_str() {
            newer(&mut facts.entry(id.to_string()).or_default().pickup, seq);
        }
        let Some(id) = event["uuid"].as_str() else {
            return;
        };
        match event["type"].as_str() {
            Some("octiq_user_turn_delivery") => {
                let entry = facts.entry(id.to_string()).or_default();
                match event["state"].as_str() {
                    Some("dispatched" | "starting" | "unknown") => {
                        newer(&mut entry.dispatched, seq)
                    }
                    Some("failed") => newer(&mut entry.failed, seq),
                    _ => {}
                }
            }
            Some("octiq_user_turn_cancelled") => {
                newer(&mut facts.entry(id.to_string()).or_default().cancelled, seq)
            }
            Some("octiq_user_turn_dismissed") => {
                newer(&mut facts.entry(id.to_string()).or_default().dismissed, seq)
            }
            Some("octiq_user_turn_appended") => {
                if let Some(source) = event["appended_uuid"].as_str() {
                    facts.entry(source.to_string()).or_default().merged_into = Some(id.to_string());
                }
            }
            // The envelope of an appended turn says what it joined too, for
            // a record whose `octiq_user_turn_appended` line was not written.
            Some("user") if event["octiq_user_turn"] == true => {
                if let Some(target) = event["octiq_append_to"].as_str() {
                    let entry = facts.entry(id.to_string()).or_default();
                    entry.merged_into.get_or_insert_with(|| target.to_string());
                }
            }
            _ => {}
        }
    }
}

/// Every id's facts, in one pass over the record.
fn scan(key: &str) -> Result<BTreeMap<String, Facts>, String> {
    let mut scanner = Scanner::new();
    crate::transcript::walk(key, |seq, line| scanner.observe(seq, line))?;
    Ok(scanner.facts)
}

/// `id`'s answer from the record: its own facts, then the facts of every
/// turn it was appended to, which is where the agent's echo is.
fn answer_from(facts: &BTreeMap<String, Facts>, id: &str) -> Delivery {
    let mut all = facts.get(id).cloned().unwrap_or_default();
    let mut into = None;
    let mut at = all.merged_into.clone();
    for _ in 0..MAX_HOPS {
        let Some(target) = at.take().filter(|target| target != id) else {
            break;
        };
        let Some(theirs) = facts.get(&target) else {
            into = Some(target);
            break;
        };
        all.absorb(theirs);
        at = theirs.merged_into.clone();
        into = Some(target);
    }
    let (state, seq) = all.decide();
    Delivery {
        state,
        seq,
        into: into.filter(|_| state != "absent"),
    }
}

/// Whether `facts` hold the agent's pickup of `turn_id` (or of the turn it
/// was appended to). The one definition of a pickup, for a caller that must
/// refuse to un-send a turn (`append_unless_picked_up`).
fn holds_pickup(facts: &BTreeMap<String, Facts>, turn_id: &str) -> bool {
    answer_from(facts, turn_id).state == "accepted"
}

/// How many times the record may change under a dismissal before it is
/// refused: each change is a pickup, a failure or a whole new record, and
/// each costs a tail read, or a full read when the record itself moved.
const ATTEMPTS: usize = 6;

/// Append `event` (a dismissal of `turn_id`) unless the agent has taken the
/// turn up, and answer its seq; `None` when it has and nothing was written.
///
/// The decision and the append are one step with respect to the record. The
/// whole record is read outside every lock; the append then checks, under the
/// append lock (`transcript::append_after_walk`), that the record is still
/// the file and the life that was read and that nothing came after the end
/// that was read. A line that did (a pickup between the end of the read and
/// the append) is read as a tail and the decision is made again; a record
/// that was replaced is read again whole. Never a dismissal after a pickup.
/// Past `ATTEMPTS` changes it writes nothing and answers `None`: the page asks
/// `chat_turn_delivery`.
pub(crate) fn append_unless_picked_up(
    key: &str,
    turn_id: &str,
    event: &Value,
) -> Result<Option<u64>, String> {
    use crate::transcript::{append_after_walk, walk_marked, walk_on, After};
    let mut scanner = Scanner::new();
    let mut walked = walk_marked(key, |seq, line| scanner.observe(seq, line))?;
    for _ in 0..ATTEMPTS {
        if holds_pickup(&scanner.facts, turn_id) {
            return Ok(None);
        }
        let mut again = match append_after_walk(key, &walked, event)? {
            After::Written(seq) => return Ok(Some(seq)),
            After::Grew => false,
            After::Moved => true,
        };
        if !again {
            again = !walk_on(key, &mut walked, |seq, line| scanner.observe(seq, line))?;
        }
        if again {
            scanner = Scanner::new();
            walked = walk_marked(key, |seq, line| scanner.observe(seq, line))?;
        }
    }
    Ok(None)
}

fn validated(ids: Vec<String>) -> Result<Vec<String>, String> {
    if ids.is_empty() || ids.len() > MAX_TURNS {
        return Err(crate::outcome::refuse(
            crate::outcome::ReasonClass::Validation,
            format!(
                "turnIds must hold 1 to {MAX_TURNS} ids; this asked for {}",
                ids.len()
            ),
        ));
    }
    for id in &ids {
        if id.is_empty() || id.chars().count() > MAX_ID_CHARS {
            return Err(crate::outcome::refuse(
                crate::outcome::ReasonClass::Validation,
                format!("a turn id must be 1 to {MAX_ID_CHARS} characters"),
            ));
        }
    }
    let mut seen = std::collections::BTreeSet::new();
    Ok(ids
        .into_iter()
        .filter(|id| seen.insert(id.clone()))
        .collect())
}

/// The command. Asks the queue first and the record once, for every id.
pub fn chat_turn_delivery_impl(
    manager: &ChatManager,
    chat_key: &str,
    turn_ids: Vec<String>,
) -> Result<Answer, String> {
    let ids = validated(turn_ids)?;
    // One spelling for the queue and the record, as the index's: a bare id
    // names the same chat as `chat:<id>`, and the queue and the record are
    // kept under the prefixed key.
    let chat_id = chat_key.strip_prefix("chat:").unwrap_or(chat_key);
    let canonical = format!("chat:{chat_id}");
    let chat_key = canonical.as_str();
    if !crate::chat_index::listed(chat_id)? {
        return Err(crate::outcome::refuse(
            crate::outcome::ReasonClass::Validation,
            format!("no such chat: {chat_key}"),
        ));
    }
    let mut turns = BTreeMap::new();
    let mut rest = Vec::new();
    for id in &ids {
        match manager.queued_unit_of(chat_key, id)? {
            Some(unit) => {
                let into = (unit != *id).then_some(unit);
                turns.insert(
                    id.clone(),
                    Delivery {
                        state: "queued",
                        seq: None,
                        into,
                    },
                );
            }
            None => rest.push(id),
        }
    }
    if !rest.is_empty() {
        let facts = scan(chat_key)?;
        for id in rest {
            turns.insert(id.clone(), answer_from(&facts, id));
        }
    }
    Ok(Answer { turns })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_dir::TestDir;
    use serde_json::json;

    pub(crate) fn listed_chat(id: &str) -> String {
        let row = serde_json::from_value(
            json!({"id": id, "projectId": "p", "title": "T", "updatedAt": 1}),
        )
        .unwrap();
        crate::chat_index::upsert(row).unwrap();
        format!("chat:{id}")
    }

    fn ask(key: &str, ids: &[&str]) -> Result<Answer, String> {
        chat_turn_delivery_impl(
            &ChatManager::default(),
            key,
            ids.iter().map(|id| id.to_string()).collect(),
        )
    }

    fn state_of(key: &str, id: &str) -> Delivery {
        ask(key, &[id]).unwrap().turns.remove(id).unwrap()
    }

    fn line(key: &str, event: Value) -> u64 {
        crate::transcript::append(key, &event).expect("the line is written")
    }

    fn delivery(key: &str, id: &str, state: &str) -> u64 {
        line(
            key,
            json!({"type": "octiq_user_turn_delivery", "uuid": id, "state": state}),
        )
    }

    fn envelope(key: &str, id: &str) -> u64 {
        line(
            key,
            json!({"type": "user", "uuid": id, "octiq_user_turn": true,
                   "message": {"content": "hello"}}),
        )
    }

    fn echo(key: &str, id: &str) -> u64 {
        line(
            key,
            json!({"type": "user", "isReplay": true, "octiq_user_turn_id": id,
                   "message": {"content": "hello"}}),
        )
    }

    #[test]
    fn every_state_is_what_the_newest_line_says() {
        let home = TestDir::new("turn-delivery-states");
        let _profile = crate::profile::started_in(&home);
        let key = listed_chat("td-states");

        assert_eq!(
            state_of(&key, "never-heard-of"),
            Delivery {
                state: "absent",
                seq: None,
                into: None
            }
        );

        envelope(&key, "sent");
        delivery(&key, "sent", "queued");
        // A queued line with nothing after it and the queue empty: absent.
        assert_eq!(state_of(&key, "sent").state, "absent");
        let at = delivery(&key, "sent", "dispatched");
        assert_eq!(
            state_of(&key, "sent"),
            Delivery {
                state: "dispatched",
                seq: Some(at),
                into: None
            }
        );
        let picked = echo(&key, "sent");
        assert_eq!(
            state_of(&key, "sent"),
            Delivery {
                state: "accepted",
                seq: Some(picked),
                into: None
            }
        );

        delivery(&key, "starting", "starting");
        assert_eq!(state_of(&key, "starting").state, "dispatched");
        delivery(&key, "lost", "unknown");
        assert_eq!(state_of(&key, "lost").state, "dispatched");

        let failed = delivery(&key, "broke", "failed");
        assert_eq!(
            state_of(&key, "broke"),
            Delivery {
                state: "failed",
                seq: Some(failed),
                into: None
            }
        );
        delivery(&key, "broke", "dispatched");
        assert_eq!(state_of(&key, "broke").state, "dispatched", "newest wins");
        delivery(&key, "broke", "failed");
        assert_eq!(state_of(&key, "broke").state, "failed");
        // The pickup after a failure line is the agent taking it up.
        echo(&key, "broke");
        assert_eq!(state_of(&key, "broke").state, "accepted");

        let gone = line(
            &key,
            json!({"type": "octiq_user_turn_cancelled", "uuid": "back"}),
        );
        assert_eq!(
            state_of(&key, "back"),
            Delivery {
                state: "cancelled",
                seq: Some(gone),
                into: None
            }
        );
        let dismissed = line(
            &key,
            json!({"type": "octiq_user_turn_dismissed", "uuid": "dropped"}),
        );
        assert_eq!(
            state_of(&key, "dropped"),
            Delivery {
                state: "dismissed",
                seq: Some(dismissed),
                into: None
            }
        );

        // Codex's turn.started and Pi's turn_start carry the same stamp.
        let started = line(
            &key,
            json!({"type": "turn.started", "octiq_user_turn_id": "codex-turn"}),
        );
        assert_eq!(state_of(&key, "codex-turn").seq, Some(started));
    }

    #[test]
    fn a_pickup_stands_over_a_dispatched_line_written_after_it() {
        let home = TestDir::new("turn-delivery-race");
        let _profile = crate::profile::started_in(&home);
        let key = listed_chat("td-race");
        envelope(&key, "fast");
        let picked = echo(&key, "fast");
        delivery(&key, "fast", "dispatched");
        assert_eq!(
            state_of(&key, "fast"),
            Delivery {
                state: "accepted",
                seq: Some(picked),
                into: None
            }
        );
        // The pickup is final: lines that say otherwise, written after it, are
        // the record being wrong about a turn the agent answered.
        delivery(&key, "fast", "failed");
        line(
            &key,
            json!({"type": "octiq_user_turn_cancelled", "uuid": "fast"}),
        );
        line(
            &key,
            json!({"type": "octiq_user_turn_dismissed", "uuid": "fast"}),
        );
        assert_eq!(
            state_of(&key, "fast"),
            Delivery {
                state: "accepted",
                seq: Some(picked),
                into: None
            }
        );
    }

    /// The shape of the chat this was found in: dispatched, echoed, answered,
    /// and then a page dismissed the bubble as unsent.
    #[test]
    fn a_dismissal_after_the_agent_took_the_turn_up_does_not_unsend_it() {
        let home = TestDir::new("turn-delivery-dismissed");
        let _profile = crate::profile::started_in(&home);
        let key = listed_chat("td-dismissed");
        envelope(&key, "answered");
        delivery(&key, "answered", "dispatched");
        let picked = echo(&key, "answered");
        line(
            &key,
            json!({"type": "assistant", "message": {"content": "done"}}),
        );
        line(
            &key,
            json!({"type": "octiq_user_turn_dismissed", "uuid": "answered"}),
        );
        assert_eq!(
            state_of(&key, "answered"),
            Delivery {
                state: "accepted",
                seq: Some(picked),
                into: None
            }
        );
        // Dismissed with no pickup is dismissed.
        envelope(&key, "never");
        delivery(&key, "never", "dispatched");
        line(
            &key,
            json!({"type": "octiq_user_turn_dismissed", "uuid": "never"}),
        );
        assert_eq!(state_of(&key, "never").state, "dismissed");
    }

    #[test]
    fn an_appended_turn_answers_with_its_targets_state() {
        let home = TestDir::new("turn-delivery-appended");
        let _profile = crate::profile::started_in(&home);
        let key = listed_chat("td-appended");
        envelope(&key, "first");
        delivery(&key, "first", "queued");
        envelope(&key, "second");
        delivery(&key, "second", "queued");
        line(
            &key,
            json!({"type": "octiq_user_turn_appended", "uuid": "first",
                   "appended_uuid": "second"}),
        );
        delivery(&key, "first", "dispatched");
        let answer = ask(&key, &["first", "second"]).unwrap();
        assert_eq!(answer.turns["second"].state, "dispatched");
        assert_eq!(answer.turns["second"].into.as_deref(), Some("first"));
        assert_eq!(answer.turns["first"].into, None);
        let picked = echo(&key, "first");
        let second = state_of(&key, "second");
        assert_eq!(
            second,
            Delivery {
                state: "accepted",
                seq: Some(picked),
                into: Some("first".into())
            }
        );

        // The envelope alone says what the turn joined when the event was lost.
        envelope(&key, "lone");
        line(
            &key,
            json!({"type": "user", "uuid": "joiner", "octiq_user_turn": true,
                   "octiq_append_to": "lone", "message": {"content": "more"}}),
        );
        delivery(&key, "lone", "failed");
        let joiner = state_of(&key, "joiner");
        assert_eq!(
            (joiner.state, joiner.into.as_deref()),
            ("failed", Some("lone"))
        );

        // A cancel names every id of the unit; the appended one's own line wins.
        line(
            &key,
            json!({"type": "octiq_user_turn_cancelled", "uuid": "joiner"}),
        );
        assert_eq!(state_of(&key, "joiner").state, "cancelled");
    }

    #[test]
    fn a_compacted_record_keeps_the_logical_seq() {
        let home = TestDir::new("turn-delivery-compacted");
        let _profile = crate::profile::started_in(&home);
        let key = listed_chat("td-compacted");
        envelope(&key, "old");
        for _ in 0..3 {
            line(
                &key,
                json!({"type": "octiq_compacted", "into": 5, "count": 5}),
            );
        }
        let at = delivery(&key, "old", "dispatched");
        assert!(at > 15, "the ranges occupy their original positions: {at}");
        let picked = echo(&key, "old");
        assert_eq!(
            state_of(&key, "old"),
            Delivery {
                state: "accepted",
                seq: Some(picked),
                into: None
            }
        );
        // The seq is the one the page reads the record by.
        let seen = crate::transcript::since(&key, 0)
            .into_iter()
            .find(|item| item.event["octiq_user_turn_id"] == "old")
            .unwrap();
        assert_eq!(seen.seq, picked);
    }

    #[test]
    fn a_torn_line_hides_nothing_after_it() {
        let home = TestDir::new("turn-delivery-torn");
        let _profile = crate::profile::started_in(&home);
        let key = listed_chat("td-torn");
        envelope(&key, "t");
        let path = crate::transcript::path_for(&key).unwrap();
        let mut bytes = std::fs::read(&path).unwrap();
        bytes.extend_from_slice(b"{\"type\":\"octiq_user_turn_deliv\xff\n");
        std::fs::write(&path, bytes).unwrap();
        echo(&key, "t");
        // The torn line occupies a position, so the seq is the reader's own
        // (the append counter was not told of the line written around it).
        let read = crate::transcript::since(&key, 0)
            .into_iter()
            .find(|item| item.event["octiq_user_turn_id"] == "t")
            .unwrap();
        assert_eq!(read.seq, 3);
        assert_eq!(state_of(&key, "t").seq, Some(read.seq));
    }

    #[test]
    fn the_ask_is_checked_in_words() {
        let home = TestDir::new("turn-delivery-asks");
        let _profile = crate::profile::started_in(&home);
        let key = listed_chat("td-asks");
        let manager = ChatManager::default();
        let too_few = chat_turn_delivery_impl(&manager, &key, vec![]).unwrap_err();
        assert!(too_few.contains("1 to 32"), "{too_few}");
        let ids: Vec<String> = (0..33).map(|n| format!("id-{n}")).collect();
        let too_many = chat_turn_delivery_impl(&manager, &key, ids).unwrap_err();
        assert!(
            too_many.contains("1 to 32") && too_many.contains("33"),
            "{too_many}"
        );
        let exactly: Vec<String> = (0..32).map(|n| format!("id-{n}")).collect();
        let held = chat_turn_delivery_impl(&manager, &key, exactly).unwrap();
        assert_eq!(held.turns.len(), 32);
        let empty = chat_turn_delivery_impl(&manager, &key, vec![String::new()]).unwrap_err();
        assert!(empty.contains("characters"), "{empty}");
        let long = "x".repeat(MAX_ID_CHARS + 1);
        assert!(chat_turn_delivery_impl(&manager, &key, vec![long]).is_err());
        // Duplicates are one answer.
        let twice = ask(&key, &["a", "a"]).unwrap();
        assert_eq!(twice.turns.len(), 1);
        // A chat the index does not list, with or without the prefix.
        let nobody = ask("chat:nobody", &["a"]).unwrap_err();
        assert!(nobody.contains("no such chat"), "{nobody}");
        assert!(ask("nobody", &["a"]).is_err());
        // The bare id of a listed chat is that chat.
        assert!(ask("td-asks", &["a"]).is_ok());
    }

    fn dismiss(key: &str, id: &str) -> Result<bool, String> {
        crate::agent_chat::chat_dismiss_unsent_impl(
            &ChatManager::default(),
            key.to_string(),
            id.to_string(),
        )
    }

    fn types_in(key: &str) -> Vec<String> {
        crate::transcript::every_line(key)
            .unwrap()
            .into_iter()
            .map(|line| {
                let kind = line.event["type"].as_str().unwrap_or("").to_string();
                if line.event["octiq_user_turn_id"].is_string() {
                    format!("{kind}:pickup")
                } else {
                    kind
                }
            })
            .collect()
    }

    /// The reviewer's probe (a): the agent's pickup is appended after the
    /// scan reached the end of the record and before the dismissal is
    /// written. The guard must see it and write nothing.
    #[test]
    fn a_pickup_appended_after_the_scan_ended_is_not_dismissed_over() {
        let home = TestDir::new("turn-delivery-race-tail");
        let _profile = crate::profile::started_in(&home);
        let key = listed_chat("td-race-tail");
        envelope(&key, "late");
        delivery(&key, "late", "dispatched");
        let hooked = key.clone();
        crate::transcript::after_walk_hook(move || {
            echo(&hooked, "late");
        });
        assert_eq!(dismiss(&key, "late"), Ok(false));
        assert!(
            !types_in(&key).contains(&"octiq_user_turn_dismissed".to_string()),
            "{:?}",
            types_in(&key)
        );
        assert_eq!(state_of(&key, "late").state, "accepted");
    }

    /// A line that came after the scan and is not this turn's pickup costs a
    /// tail read, not the dismissal: the turn is still unsent.
    #[test]
    fn an_unrelated_line_after_the_scan_does_not_stop_a_true_dismissal() {
        let home = TestDir::new("turn-delivery-race-other");
        let _profile = crate::profile::started_in(&home);
        let key = listed_chat("td-race-other");
        envelope(&key, "unsent");
        delivery(&key, "unsent", "failed");
        let hooked = key.clone();
        crate::transcript::after_walk_hook(move || {
            echo(&hooked, "someone-else");
            line(
                &hooked,
                json!({"type": "assistant", "message": {"content": "hi"}}),
            );
        });
        assert_eq!(dismiss(&key, "unsent"), Ok(true));
        let kinds = types_in(&key);
        assert_eq!(kinds.last().unwrap(), "octiq_user_turn_dismissed");
        assert_eq!(state_of(&key, "unsent").state, "dismissed");
    }

    /// The reviewer's probe (b): the record is published anew (an atomic
    /// replace) while the scan runs, and the new file holds the pickup. The
    /// dismissal must not be written into it.
    #[test]
    fn a_record_published_during_the_scan_is_read_again_before_dismissing() {
        let home = TestDir::new("turn-delivery-race-publish");
        let _profile = crate::profile::started_in(&home);
        let key = listed_chat("td-race-publish");
        envelope(&key, "moved");
        delivery(&key, "moved", "dispatched");
        let path = crate::transcript::path_for(&key).unwrap();
        let (hooked, target) = (key.clone(), path.clone());
        crate::transcript::after_walk_hook(move || {
            let mut text = std::fs::read_to_string(&target).unwrap();
            text.push_str(
                &json!({"type": "user", "isReplay": true, "octiq_user_turn_id": "moved",
                        "message": {"content": "hello"}})
                .to_string(),
            );
            text.push('\n');
            let staged = target.with_extension("jsonl.staged");
            std::fs::write(&staged, text).unwrap();
            std::fs::rename(&staged, &target).unwrap();
            let _ = &hooked;
        });
        assert_eq!(dismiss(&key, "moved"), Ok(false));
        assert!(!types_in(&key).contains(&"octiq_user_turn_dismissed".to_string()));
        assert_eq!(state_of(&key, "moved").state, "accepted");
    }

    /// A record that did not exist when the scan began and does when the
    /// dismissal is written is a record that grew from nothing.
    #[test]
    fn a_record_made_during_the_scan_is_read_before_dismissing() {
        let home = TestDir::new("turn-delivery-race-made");
        let _profile = crate::profile::started_in(&home);
        let key = listed_chat("td-race-made");
        let hooked = key.clone();
        crate::transcript::after_walk_hook(move || {
            echo(&hooked, "born");
        });
        assert_eq!(dismiss(&key, "born"), Ok(false));
        assert_eq!(types_in(&key), vec!["user:pickup".to_string()]);
    }

    /// Round 4 H1b: the scan reads a pickup line a writer has only half
    /// written, and the writer finishes it before the scan's next read. The
    /// two halves are not two lines; the guard must see the pickup.
    #[test]
    fn a_pickup_line_finished_between_two_reads_of_the_scan_is_not_dismissed_over() {
        use std::io::Write;
        let home = TestDir::new("turn-delivery-race-midline");
        let _profile = crate::profile::started_in(&home);
        let key = listed_chat("td-race-midline");
        envelope(&key, "split");
        delivery(&key, "split", "dispatched");
        let path = crate::transcript::path_for(&key).unwrap();
        let whole = format!(
            "{}\n",
            json!({"type": "user", "isReplay": true, "octiq_user_turn_id": "split",
                   "message": {"content": "hello"}})
        );
        let (head, rest) = whole.split_at(whole.len() / 2);
        let mut file = std::fs::OpenOptions::new()
            .append(true)
            .open(&path)
            .unwrap();
        file.write_all(head.as_bytes()).unwrap();
        let (target, rest) = (path.clone(), rest.to_string());
        crate::transcript::after_partial_line_hook(move || {
            let mut file = std::fs::OpenOptions::new()
                .append(true)
                .open(&target)
                .unwrap();
            file.write_all(rest.as_bytes()).unwrap();
        });
        assert_eq!(dismiss(&key, "split"), Ok(false));
        assert!(
            !types_in(&key).contains(&"octiq_user_turn_dismissed".to_string()),
            "{:?}",
            types_in(&key)
        );
        assert_eq!(state_of(&key, "split").state, "accepted");
    }

    /// The same, in the tail read: the record grew by the first half of a
    /// pickup line (so the guard re-reads the tail), and the writer finishes
    /// it before that read's next step. The tail read must not take the two
    /// halves for two lines.
    #[test]
    fn a_pickup_line_finished_between_two_reads_of_the_tail_is_not_dismissed_over() {
        use std::io::Write;
        let home = TestDir::new("turn-delivery-race-midline-tail");
        let _profile = crate::profile::started_in(&home);
        let key = listed_chat("td-race-midline-tail");
        envelope(&key, "split-tail");
        delivery(&key, "split-tail", "dispatched");
        let path = crate::transcript::path_for(&key).unwrap();
        let whole = format!(
            "{}\n",
            json!({"type": "user", "isReplay": true, "octiq_user_turn_id": "split-tail",
                   "message": {"content": "hello"}})
        );
        let (head, rest) = whole.split_at(whole.len() / 2);
        let (head, rest, target) = (head.to_string(), rest.to_string(), path.clone());
        crate::transcript::after_walk_hook(move || {
            // The scan has ended: half a line lands, and the tail read that
            // follows meets it unfinished and sees it finished.
            let open = || {
                std::fs::OpenOptions::new()
                    .append(true)
                    .open(&target)
                    .unwrap()
            };
            open().write_all(head.as_bytes()).unwrap();
            let (target, rest) = (target.clone(), rest.clone());
            crate::transcript::after_partial_line_hook(move || {
                let mut file = std::fs::OpenOptions::new()
                    .append(true)
                    .open(&target)
                    .unwrap();
                file.write_all(rest.as_bytes()).unwrap();
            });
        });
        assert_eq!(dismiss(&key, "split-tail"), Ok(false));
        assert!(
            !types_in(&key).contains(&"octiq_user_turn_dismissed".to_string()),
            "{:?}",
            types_in(&key)
        );
        assert_eq!(state_of(&key, "split-tail").state, "accepted");
    }

    /// A last line that is never finished is not a line the guard can stand
    /// behind: it writes nothing and answers false (the page then asks
    /// `chat_turn_delivery`), and the lookup skips the fragment as before.
    #[test]
    fn a_cut_last_line_that_stays_cut_gives_no_dismissal() {
        use std::io::Write;
        let home = TestDir::new("turn-delivery-cut-tail");
        let _profile = crate::profile::started_in(&home);
        let key = listed_chat("td-cut-tail");
        envelope(&key, "cut");
        delivery(&key, "cut", "failed");
        let path = crate::transcript::path_for(&key).unwrap();
        let mut file = std::fs::OpenOptions::new()
            .append(true)
            .open(&path)
            .unwrap();
        file.write_all(br#"{"type":"user","octiq_user_t"#).unwrap();
        assert_eq!(dismiss(&key, "cut"), Ok(false));
        let text = std::fs::read_to_string(&path).unwrap();
        assert!(!text.contains("octiq_user_turn_dismissed"), "{text}");
        assert_eq!(state_of(&key, "cut").state, "failed");
    }

    #[test]
    fn a_true_dismissal_is_still_written_once_with_nothing_racing() {
        let home = TestDir::new("turn-delivery-dismiss-plain");
        let _profile = crate::profile::started_in(&home);
        let key = listed_chat("td-dismiss-plain");
        envelope(&key, "plain");
        delivery(&key, "plain", "failed");
        assert_eq!(dismiss(&key, "plain"), Ok(true));
        assert_eq!(
            types_in(&key).last().map(String::as_str),
            Some("octiq_user_turn_dismissed")
        );
    }

    /// A bare chat id is the chat `chat:<id>`: both read the one record.
    #[test]
    fn a_bare_chat_id_reads_the_same_record_as_the_prefixed_key() {
        let home = TestDir::new("turn-delivery-bare");
        let _profile = crate::profile::started_in(&home);
        let key = listed_chat("td-bare");
        envelope(&key, "sent");
        let picked = echo(&key, "sent");
        let want = Delivery {
            state: "accepted",
            seq: Some(picked),
            into: None,
        };
        assert_eq!(state_of(&key, "sent"), want);
        assert_eq!(state_of("td-bare", "sent"), want);
        // And an id the record does not hold is absent under both.
        assert_eq!(state_of("td-bare", "nope").state, "absent");
    }

    #[test]
    fn the_answer_is_shaped_as_the_contract_says() {
        let home = TestDir::new("turn-delivery-shape");
        let _profile = crate::profile::started_in(&home);
        let key = listed_chat("td-shape");
        envelope(&key, "s");
        let picked = echo(&key, "s");
        let value = serde_json::to_value(ask(&key, &["s", "nope"]).unwrap()).unwrap();
        assert_eq!(
            value,
            json!({"turns": {
                "s": {"state": "accepted", "seq": picked},
                "nope": {"state": "absent"},
            }})
        );
    }
}
