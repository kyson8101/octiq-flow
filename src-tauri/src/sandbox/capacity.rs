//! How many test environments may run at once, host-wide (feedback
//! caa2ca88, B3).
//!
//! A Performance environment is SQL Server plus three .NET services and a
//! frontend. Nothing bounded them: every retry built another, and parallel
//! tasks each built their own. So an environment is only started once it has
//! a slot, and a task that cannot get one WAITS, in order, visibly — it does
//! not fail, and it can be cancelled.
//!
//! Live means an environment that has been started and not stopped since
//! (whatever its readiness), plus the slots a starting task holds. A task
//! asks for every environment it needs in ONE request — its own and its
//! dependencies' — and gets all of them or none, so two tasks that each need
//! two environments can never hold one each and wait on each other forever.
//! A request for more than the limit could never be met and is refused at
//! once, with that cause.
//!
//! The same module is the wake-up signal for the lifecycle reconciler
//! (`orchestration::environments`): anything that might free or need a slot
//! calls `changed()`.
use std::collections::{BTreeMap, BTreeSet, VecDeque};
use std::sync::{Condvar, Mutex, OnceLock};
use std::time::Duration;

pub const DEFAULT_LIMIT: usize = 3;

/// `OCTIQ_SANDBOX_LIMIT`, at least 1; 3 when unset or unreadable.
pub fn limit() -> usize {
    std::env::var("OCTIQ_SANDBOX_LIMIT")
        .ok()
        .and_then(|v| v.trim().parse::<usize>().ok())
        .filter(|n| *n > 0)
        .unwrap_or(DEFAULT_LIMIT)
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Waiter {
    pub ticket: u64,
    pub label: String,
    pub keys: Vec<String>,
    pub since: u64,
}

#[derive(Default)]
struct State {
    next: u64,
    waiting: VecDeque<Waiter>,
    /// Slots held by admitted starts, by chat key.
    held: BTreeMap<String, usize>,
    /// Bumped on every `changed()`, so a sleeper can tell it was woken.
    generation: u64,
}

static STATE: OnceLock<(Mutex<State>, Condvar)> = OnceLock::new();

fn state() -> &'static (Mutex<State>, Condvar) {
    STATE.get_or_init(|| (Mutex::new(State::default()), Condvar::new()))
}

/// Something that could free or need a slot happened.
pub fn changed() {
    let (lock, wake) = state();
    if let Ok(mut s) = lock.lock() {
        s.generation = s.generation.wrapping_add(1);
    }
    wake.notify_all();
}

/// Block until `changed()` or `timeout`, for the reconciler. Returns the
/// generation seen, so a caller can skip work when nothing moved.
pub fn wait_changed(seen: u64, timeout: Duration) -> u64 {
    let (lock, wake) = state();
    let Ok(s) = lock.lock() else {
        return seen;
    };
    if s.generation != seen {
        return s.generation;
    }
    match wake.wait_timeout(s, timeout) {
        Ok((s, _)) => s.generation,
        Err(_) => seen,
    }
}

/// Keys that must not be stopped to make room: held by an admitted start,
/// or asked for by a waiting one.
pub fn protected() -> BTreeSet<String> {
    let (lock, _) = state();
    let Ok(s) = lock.lock() else {
        return BTreeSet::new();
    };
    s.held
        .keys()
        .cloned()
        .chain(s.waiting.iter().flat_map(|w| w.keys.iter().cloned()))
        .collect()
}

/// Whether anything is waiting for a slot.
pub fn pressure() -> bool {
    let (lock, _) = state();
    lock.lock().map(|s| !s.waiting.is_empty()).unwrap_or(false)
}

pub fn waiting() -> Vec<Waiter> {
    let (lock, _) = state();
    lock.lock()
        .map(|s| s.waiting.iter().cloned().collect())
        .unwrap_or_default()
}

pub fn held() -> BTreeSet<String> {
    let (lock, _) = state();
    lock.lock()
        .map(|s| s.held.keys().cloned().collect())
        .unwrap_or_default()
}

/// The slots an admitted start holds until it is dropped: by then its
/// environments are live in their own right, or failed.
pub struct Reservation {
    keys: Vec<String>,
}

impl Drop for Reservation {
    fn drop(&mut self) {
        let (lock, _) = state();
        if let Ok(mut s) = lock.lock() {
            for key in &self.keys {
                if let Some(count) = s.held.get_mut(key) {
                    *count -= 1;
                    if *count == 0 {
                        s.held.remove(key);
                    }
                }
            }
        }
        changed();
    }
}

/// What a waiting start sees while it waits.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Wait {
    pub position: usize,
    pub in_use: usize,
    pub limit: usize,
    pub needed: usize,
}

struct Leave(u64);
impl Drop for Leave {
    fn drop(&mut self) {
        let (lock, _) = state();
        if let Ok(mut s) = lock.lock() {
            s.waiting.retain(|w| w.ticket != self.0);
        }
        changed();
    }
}

/// Take a slot for each of `keys` (the first being the environment the start
/// is for) that is not already live, all at once,
/// waiting in order while there are not enough. `live` reads the store's
/// started environments; `cancelled` is asked on every wake (at least every
/// few seconds) and ends the wait with an error; `waiting` hears each
/// change of position or use.
pub fn acquire(
    keys: &[String],
    label: &str,
    now: u64,
    live: impl Fn() -> BTreeSet<String>,
    cancelled: impl Fn() -> bool,
    mut waiting: impl FnMut(&Wait),
) -> Result<Reservation, String> {
    let limit = limit();
    // In the caller's order: the first is the one the start is for.
    let mut keys = keys.to_vec();
    let mut seen = BTreeSet::new();
    keys.retain(|key| seen.insert(key.clone()));
    if keys.len() > limit {
        return Err(format!(
            "This task needs {} test environments at once, and this host runs at most {limit} (OCTIQ_SANDBOX_LIMIT). Raise the limit or split the check.",
            keys.len()
        ));
    }
    let (lock, wake) = state();
    let mut s = lock.lock().map_err(|e| e.to_string())?;
    s.next += 1;
    let ticket = s.next;
    s.waiting.push_back(Waiter {
        ticket,
        label: label.to_owned(),
        keys: keys.clone(),
        since: now,
    });
    let _leave = Leave(ticket);
    let mut last: Option<Wait> = None;
    loop {
        // Read the store without holding the queue: it takes its own lock.
        drop(s);
        let started = live();
        if cancelled() {
            return Err(
                "Stopped waiting for environment capacity: the attempt is no longer live.".into(),
            );
        }
        s = lock.lock().map_err(|e| e.to_string())?;
        let position = s
            .waiting
            .iter()
            .position(|w| w.ticket == ticket)
            .unwrap_or(0);
        let mut in_use: BTreeSet<&String> = started.iter().collect();
        in_use.extend(s.held.keys());
        let needed = keys.iter().filter(|k| !in_use.contains(k)).count();
        // First in line, or needing nothing new: go when it fits.
        if (position == 0 || needed == 0) && in_use.len() + needed <= limit {
            s.waiting.retain(|w| w.ticket != ticket);
            for key in &keys {
                *s.held.entry(key.clone()).or_default() += 1;
            }
            drop(s);
            changed();
            return Ok(Reservation { keys });
        }
        let now_waiting = Wait {
            position: position + 1,
            in_use: in_use.len(),
            limit,
            needed,
        };
        if last.as_ref() != Some(&now_waiting) {
            drop(s);
            waiting(&now_waiting);
            // Ask the reconciler to free what nothing needs.
            changed();
            last = Some(now_waiting);
            s = lock.lock().map_err(|e| e.to_string())?;
        }
        s = wake
            .wait_timeout(s, Duration::from_secs(3))
            .map_err(|e| e.to_string())?
            .0;
    }
}

#[cfg(test)]
pub(crate) static TEST_LOCK: Mutex<()> = Mutex::new(());

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicBool, Ordering};
    use std::sync::Arc;

    fn keys(names: &[&str]) -> Vec<String> {
        names.iter().map(|n| n.to_string()).collect()
    }

    #[test]
    fn a_start_waits_in_line_until_a_slot_frees_and_can_be_cancelled() {
        let _serial = TEST_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        assert_eq!(
            limit(),
            DEFAULT_LIMIT,
            "tests expect OCTIQ_SANDBOX_LIMIT unset"
        );
        let live = Arc::new(Mutex::new(
            keys(&["chat:a", "chat:b", "chat:c"])
                .into_iter()
                .collect::<BTreeSet<_>>(),
        ));
        // Full: the fourth waits and says where it stands.
        let seen = Arc::new(Mutex::new(Vec::new()));
        let waiter = {
            let live = live.clone();
            let seen = seen.clone();
            std::thread::spawn(move || {
                acquire(
                    &keys(&["chat:d"]),
                    "task d",
                    1,
                    || live.lock().unwrap().clone(),
                    || false,
                    |w| seen.lock().unwrap().push(w.clone()),
                )
                .map(|r| drop(r))
            })
        };
        let deadline = std::time::Instant::now() + Duration::from_secs(5);
        while waiting().is_empty() && std::time::Instant::now() < deadline {
            std::thread::sleep(Duration::from_millis(20));
        }
        assert_eq!(waiting().len(), 1);
        assert!(pressure());
        assert!(protected().contains("chat:d"));
        live.lock().unwrap().remove("chat:a");
        changed();
        waiter.join().unwrap().unwrap();
        let first = seen.lock().unwrap()[0].clone();
        assert_eq!((first.position, first.in_use, first.limit), (1, 3, 3));
        assert!(waiting().is_empty());

        // A cancelled wait leaves the line and holds nothing.
        let stop = Arc::new(AtomicBool::new(false));
        let waiter = {
            let live = live.clone();
            let stop = stop.clone();
            live.lock().unwrap().insert("chat:a".into());
            std::thread::spawn(move || {
                acquire(
                    &keys(&["chat:e"]),
                    "task e",
                    1,
                    || live.lock().unwrap().clone(),
                    || stop.load(Ordering::SeqCst),
                    |_| {},
                )
                .map(|r| drop(r))
            })
        };
        while waiting().is_empty() {
            std::thread::sleep(Duration::from_millis(20));
        }
        stop.store(true, Ordering::SeqCst);
        changed();
        assert!(waiter
            .join()
            .unwrap()
            .unwrap_err()
            .contains("no longer live"));
        assert!(waiting().is_empty());
        assert!(held().is_empty());
    }

    #[test]
    fn a_start_takes_all_its_environments_at_once_or_is_refused() {
        let _serial = TEST_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        // Two already live of three: a start needing two NEW ones waits for
        // both rather than taking one and holding it.
        let live: BTreeSet<String> = keys(&["chat:x", "chat:y"]).into_iter().collect();
        let refused = acquire(
            &keys(&["chat:1", "chat:2", "chat:3", "chat:4"]),
            "too many",
            1,
            || live.clone(),
            || false,
            |_| {},
        );
        assert!(refused.err().unwrap().contains("at most 3"));
        // Its own dependency already live costs no new slot.
        let reservation = acquire(
            &keys(&["chat:x", "chat:new"]),
            "fits",
            1,
            || live.clone(),
            || false,
            |_| {},
        )
        .unwrap();
        assert_eq!(held(), keys(&["chat:new", "chat:x"]).into_iter().collect());
        drop(reservation);
        assert!(held().is_empty());
        // Full, but a retry whose taken-over environment is already live
        // needs no new slot: it goes, and counts that one only once.
        let full: BTreeSet<String> = keys(&["chat:x", "chat:y", "chat:z"]).into_iter().collect();
        let retry = acquire(
            &keys(&["chat:x", "chat:x"]),
            "retry",
            1,
            || full.clone(),
            || false,
            |_| {},
        )
        .unwrap();
        assert_eq!(held(), keys(&["chat:x"]).into_iter().collect());
        drop(retry);
    }
}
