//! Once per server start: a chat an earlier build opened as a read-only
//! discussion goes back to its agent's registered access.
//!
//! Up to 0.3.9 a route the front desk called a discussion was confirmed at
//! read access, whatever its agent was registered at. Nothing opens a chat
//! that way any more (`route.rs`), and a chat keeps the level it has: no
//! rule raises one at a start. So the chats that build left at read are
//! lifted here, one time, and by nothing else.
//!
//! **Which chats.** Only the chat a route's own record names: a `Route`
//! that is `Confirmed`, was a discussion, whose settings say read, and that
//! an earlier build left and this pass has not looked at yet
//! (`lift_settled` is not set). That record is the proof the product put
//! the chat at read, not the person. A chat with no such record is never
//! touched.
//!
//! **A record this build makes, confirms or finishes is born looked at.**
//! Both constructors store `lift_settled`, and `prepare` sets it with the
//! settings it reads from the roster, so a chat this build opens at read
//! because its agent is registered at read is never raised here when that
//! registration changes: no standing rule raises a chat. A record that does
//! not say (the field is new) is an earlier build's. One whose chat an
//! earlier build had started before the restart cut its record at
//! `Starting` is only flipped to `Confirmed` by `recover`, with the field
//! as it was, and is looked at by the next start's pass.
//!
//! **What an earlier build's record cannot say.** That build forced read
//! on every discussion, so a record of an agent who was registered at read
//! then looks the same as one of an agent registered higher. If that
//! registration was raised before this build's first start, the chat is
//! lifted to the level registered then.
//!
//! **When it is lifted.** Only when all of this holds; otherwise the chat is
//! left as it is:
//!
//! - the record's agent is on the roster and registered above read;
//! - the chat is that agent's own conversation (its lead record names the
//!   agent), and not a front desk's or a worker's;
//! - the agent's scope covers the project the lead record names;
//! - the chat index lists the chat, out of the trash, at exactly read:
//!   anything else was changed since (a card's Upgrade, the access picker);
//! - no process runs under the chat's key.
//!
//! **What it writes**, in this order, each through its owner and each only
//! where the level is still read: the ledger's saved start settings for the
//! chat, when it holds some (they must agree with the index, or a run's
//! notification is refused after a restart); the chat index entry; and
//! last the record's `lift_settled`. That is the one mark, and it means
//! "the one-time pass has looked at this record": a chat that was left is
//! marked like one that was lifted, so the lift is once for it too, and a
//! registration that changes later lifts nothing. The record's settings
//! are not written: they stay what it was confirmed with.
//!
//! **What cannot be read or written is tried again at the next start.** The
//! record stays unmarked, and every step is safe to repeat: a ledger entry
//! or an index entry already lifted is no longer at read. A record whose
//! own write failed after its chat was lifted finds the chat changed at
//! the next start, and is marked then.
//!
//! It says nothing on the bus, writes no line in a transcript and keeps
//! nothing in memory. It never raises above the registered access and never
//! lowers.
use std::collections::BTreeMap;
use std::path::Path;

use super::{read, write, Kind, Status, LOCK};
use crate::agent_chat::Access;
use crate::orchestration::OrchestrationStore;
use crate::team::{self, TeamAgent};

/// Why a chat was left as it is. Its record is marked like a lifted one:
/// it is not looked at again.
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord)]
pub(crate) enum Left {
    AgentRemoved,
    RegisteredAtRead,
    FrontDesk,
    Worker,
    AnotherAgents,
    OutOfScope,
    NotListed,
    LevelChanged,
    Running,
}

impl Left {
    fn words(self) -> &'static str {
        match self {
            Left::AgentRemoved => "agent removed",
            Left::RegisteredAtRead => "agent registered at read",
            Left::FrontDesk => "a front desk's chat",
            Left::Worker => "a worker's chat",
            Left::AnotherAgents => "not that agent's conversation",
            Left::OutOfScope => "agent no longer works in the chat's project",
            Left::NotListed => "not in the chat list",
            Left::LevelChanged => "level changed since",
            Left::Running => "chat running",
        }
    }
}

/// What could not be read or written. The record stays unmarked and the
/// next start tries again.
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord)]
pub(crate) enum Again {
    Roster,
    Ledger,
    Index,
    Record,
}

impl Again {
    fn words(self) -> &'static str {
        match self {
            Again::Roster => "the roster could not be read",
            Again::Ledger => "the run ledger could not be read or saved",
            Again::Index => "the chat index could not be read or saved",
            Again::Record => "the route's record could not be saved",
        }
    }
}

/// What one pass did, in counts.
#[derive(Debug, Default, PartialEq, Eq)]
pub(crate) struct Tally {
    pub lifted: usize,
    pub left: BTreeMap<Left, usize>,
    pub again: BTreeMap<Again, usize>,
}

impl Tally {
    /// The pass in one line, with no chat's name, id or words in it.
    pub(crate) fn line(&self) -> String {
        fn counted<K: Copy>(of: &BTreeMap<K, usize>, words: impl Fn(K) -> &'static str) -> String {
            let total: usize = of.values().sum();
            if total == 0 {
                return "0".into();
            }
            let reasons: Vec<String> = of
                .iter()
                .map(|(why, count)| format!("{count} {}", words(*why)))
                .collect();
            format!("{total} ({})", reasons.join(", "))
        }
        let mut line = format!(
            "{} lifted to their agent's registered access, {} left",
            self.lifted,
            counted(&self.left, Left::words)
        );
        if !self.again.is_empty() {
            line.push_str(&format!(
                ", {} to try again at the next start",
                counted(&self.again, Again::words)
            ));
        }
        line
    }
}

/// What one record came to.
enum Outcome {
    Lifted,
    Left(Left),
    Again(Again),
}

/// The pass. `running` says whether a process runs under a chat's key.
///
/// An `Err` is the whole pass refused before anything was written: the
/// handovers could not be read (in the profile's own words when its folder
/// is away or is not the one the server started with), or the roster could
/// not.
pub(crate) fn run(
    store: &Path,
    team_path: &Path,
    ledger: &OrchestrationStore,
    running: &dyn Fn(&str) -> bool,
) -> Result<Tally, String> {
    let _guard = LOCK.lock().map_err(|e| e.to_string())?;
    let mut stored = read(store)?;
    let waiting: Vec<String> = stored
        .handovers
        .values()
        .filter(|h| {
            h.kind == Kind::Route
                && h.status == Status::Confirmed
                && h.route.as_ref().is_some_and(|route| route.discuss)
                && h.settings.access == Access::Read
                && h.target_chat_key.is_some()
                && !h.lift_settled
        })
        .map(|h| h.id.clone())
        .collect();
    let mut tally = Tally::default();
    if waiting.is_empty() {
        return Ok(tally);
    }
    let roster = team::list(team_path, None, true)?;
    for id in waiting {
        let record = &stored.handovers[&id];
        let key = record.target_chat_key.clone().unwrap_or_default();
        let agent = record
            .to
            .agent_id
            .as_deref()
            .and_then(|id| roster.iter().find(|a| a.id == id));
        let outcome = settle(&key, agent, team_path, ledger, running);
        if let Outcome::Again(why) = outcome {
            *tally.again.entry(why).or_default() += 1;
            continue;
        }
        // Last, and only now: the mark that this record was looked at.
        stored
            .handovers
            .get_mut(&id)
            .expect("read above")
            .lift_settled = true;
        if write(store, &stored).is_err() {
            // Its chat is decided all the same, so the mark is true and a
            // later record's write may carry it; else the next start finds
            // nothing left to lift and marks it then.
            *tally.again.entry(Again::Record).or_default() += 1;
            continue;
        }
        match outcome {
            Outcome::Lifted => tally.lifted += 1,
            Outcome::Left(why) => *tally.left.entry(why).or_default() += 1,
            Outcome::Again(_) => {}
        }
    }
    Ok(tally)
}

/// Decide one chat, and lift it when everything holds.
fn settle(
    key: &str,
    agent: Option<&TeamAgent>,
    team_path: &Path,
    ledger: &OrchestrationStore,
    running: &dyn Fn(&str) -> bool,
) -> Outcome {
    use crate::access_request::rank;
    let left = Outcome::Left;
    let Some(agent) = agent else {
        return left(Left::AgentRemoved);
    };
    let registered = agent.access;
    if rank(registered) <= rank(Access::Read) {
        return left(Left::RegisteredAtRead);
    }
    if team::front_desk_chat(team_path, key).is_some() {
        return left(Left::FrontDesk);
    }
    match ledger.is_worker_chat(key) {
        Ok(false) => {}
        Ok(true) => return left(Left::Worker),
        Err(_) => return Outcome::Again(Again::Ledger),
    }
    let lead = match team::lead_for_chat(team_path, key) {
        Ok(Some(lead)) if lead.lead_id == agent.id => lead,
        Ok(_) => return left(Left::AnotherAgents),
        Err(_) => return Outcome::Again(Again::Roster),
    };
    // The roster's own rule for where an agent works, as it is now.
    match team::list(team_path, Some(&lead.project_id), false) {
        Ok(there) if there.iter().any(|a| a.id == agent.id) => {}
        Ok(_) => return left(Left::OutOfScope),
        Err(_) => return Outcome::Again(Again::Roster),
    }
    let id = key.strip_prefix("chat:").unwrap_or(key);
    match crate::chat_index::listed(id) {
        Ok(true) => {}
        Ok(false) => return left(Left::NotListed),
        Err(_) => return Outcome::Again(Again::Index),
    }
    // Listed a moment ago: not found now is an index that stopped reading.
    let Some(entry) = crate::chat_index::list().into_iter().find(|c| c.id == id) else {
        return Outcome::Again(Again::Index);
    };
    if entry.access.as_deref() != Some("read") {
        return left(Left::LevelChanged);
    }
    if running(key) {
        return left(Left::Running);
    }
    if ledger.lift_resume_context(key, registered).is_err() {
        return Outcome::Again(Again::Ledger);
    }
    match crate::chat_index::lift_read(id, crate::orchestration::access_id(registered)) {
        Ok(true) => Outcome::Lifted,
        Ok(false) => left(Left::LevelChanged),
        Err(_) => Outcome::Again(Again::Index),
    }
}

/// The pass over the profile's own stores, and its one line on the log.
/// Called once, before anything that can start a chat is running.
pub(crate) fn at_startup(ledger: &OrchestrationStore, running: &dyn Fn(&str) -> bool) {
    let passed = run(
        &super::default_path(),
        &team::default_path(),
        ledger,
        running,
    );
    match passed {
        Ok(tally) => println!("[handover] read-only discussions: {}", tally.line()),
        Err(why) => eprintln!(
            "[handover] read-only discussions: nothing lifted, to try again at the next start: {why}"
        ),
    }
}

#[cfg(test)]
mod tests;
