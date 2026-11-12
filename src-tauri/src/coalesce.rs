//! Concurrent identical reads share one run, without ever serving an answer
//! that was started before the caller asked.
//!
//! A slow read (a `git status` in a large repository) asked by several tabs
//! at once used to run once per caller. Here at most ONE run is in flight per
//! key and at most one more is queued behind it. A caller that arrives while
//! a run is going cannot take its answer (that run began before the caller
//! asked, and a change may have landed in between), so it waits for the next
//! run, which every caller that arrived in the meantime shares. N concurrent
//! callers therefore cost at most two runs, and each answer post-dates the
//! call that receives it.
//!
//! Nothing here caches: with no run in flight the next call starts its own.

use std::collections::HashMap;
use std::hash::Hash;
use std::sync::{Arc, Condvar, Mutex};

pub struct Coalesce<K, V> {
    flights: Mutex<HashMap<K, Arc<Flight<V>>>>,
}

struct Flight<V> {
    state: Mutex<State<V>>,
    done: Condvar,
}

struct State<V> {
    running: bool,
    /// Runs begun so far on this key; the running one is number `started`.
    started: u64,
    /// The highest run number whose answer is in `answer`.
    finished: u64,
    answer: Option<V>,
}

/// Frees the key if the run panics, so waiters are never stranded.
struct Running<'a, V> {
    flight: &'a Flight<V>,
    number: u64,
    answer: Option<V>,
}

impl<V> Drop for Running<'_, V> {
    fn drop(&mut self) {
        let mut state = self.flight.state.lock().unwrap_or_else(|e| e.into_inner());
        state.running = false;
        if let Some(answer) = self.answer.take() {
            state.finished = self.number;
            state.answer = Some(answer);
        } else {
            // The run died without an answer: give its number back so a
            // waiter leads the run it was waiting for.
            state.started = self.number - 1;
        }
        self.flight.done.notify_all();
    }
}

impl<K, V> Default for Coalesce<K, V> {
    fn default() -> Self {
        Self {
            flights: Mutex::new(HashMap::new()),
        }
    }
}

impl<K: Eq + Hash + Clone, V: Clone> Coalesce<K, V> {
    pub fn new() -> Self {
        Self::default()
    }

    /// Run `read` for `key`, or share the next run with every caller that
    /// arrives while the current one is going.
    pub fn run(&self, key: &K, read: impl FnOnce() -> V) -> V {
        let flight = {
            let mut flights = self.flights.lock().unwrap_or_else(|e| e.into_inner());
            flights
                .entry(key.clone())
                .or_insert_with(|| {
                    Arc::new(Flight {
                        state: Mutex::new(State {
                            running: false,
                            started: 0,
                            finished: 0,
                            answer: None,
                        }),
                        done: Condvar::new(),
                    })
                })
                .clone()
        };
        let mut state = flight.state.lock().unwrap_or_else(|e| e.into_inner());
        // The first run that began after this call: one that is going now
        // does not count.
        let wanted = state.started + 1;
        let mut read = Some(read);
        loop {
            if state.finished >= wanted {
                if let Some(answer) = state.answer.clone() {
                    return answer;
                }
            }
            if !state.running && state.started < wanted {
                // This caller leads the run everyone waiting shares.
                state.running = true;
                state.started += 1;
                let number = state.started;
                drop(state);
                let mut run = Running {
                    flight: &flight,
                    number,
                    answer: None,
                };
                run.answer = Some((read.take().expect("a leader reads once"))());
                let answer = run.answer.clone().expect("just set");
                drop(run);
                return answer;
            }
            state = flight.done.wait(state).unwrap_or_else(|e| e.into_inner());
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::time::Duration;

    #[test]
    fn a_lone_call_runs_and_the_next_runs_again() {
        let c: Coalesce<String, usize> = Coalesce::new();
        let runs = AtomicUsize::new(0);
        let key = "k".to_string();
        let a = c.run(&key, || runs.fetch_add(1, Ordering::SeqCst) + 1);
        let b = c.run(&key, || runs.fetch_add(1, Ordering::SeqCst) + 1);
        assert_eq!((a, b), (1, 2), "nothing is cached between calls");
    }

    #[test]
    fn many_concurrent_callers_cost_two_runs_and_none_gets_an_older_answer() {
        let c: Arc<Coalesce<String, usize>> = Arc::new(Coalesce::new());
        let runs = Arc::new(AtomicUsize::new(0));
        let key = "k".to_string();
        let (started_tx, started_rx) = std::sync::mpsc::channel::<()>();
        let (release_tx, release_rx) = std::sync::mpsc::channel::<()>();
        let first = {
            let (c, runs, key) = (c.clone(), runs.clone(), key.clone());
            std::thread::spawn(move || {
                c.run(&key, || {
                    let n = runs.fetch_add(1, Ordering::SeqCst) + 1;
                    started_tx.send(()).unwrap();
                    release_rx.recv().unwrap();
                    n
                })
            })
        };
        started_rx.recv().unwrap();
        // Eight callers arrive while run 1 is going.
        let waiters: Vec<_> = (0..8)
            .map(|_| {
                let (c, runs, key) = (c.clone(), runs.clone(), key.clone());
                std::thread::spawn(move || c.run(&key, || runs.fetch_add(1, Ordering::SeqCst) + 1))
            })
            .collect();
        std::thread::sleep(Duration::from_millis(100));
        release_tx.send(()).unwrap();
        assert_eq!(first.join().unwrap(), 1);
        let answers: Vec<_> = waiters.into_iter().map(|w| w.join().unwrap()).collect();
        assert!(
            answers.iter().all(|a| *a == 2),
            "every waiter shares the run that began after it asked: {answers:?}"
        );
        assert_eq!(runs.load(Ordering::SeqCst), 2);
    }

    #[test]
    fn a_panicking_run_frees_the_key() {
        let c: Arc<Coalesce<String, usize>> = Arc::new(Coalesce::new());
        let key = "k".to_string();
        let crashed = {
            let (c, key) = (c.clone(), key.clone());
            std::thread::spawn(move || c.run(&key, || panic!("boom"))).join()
        };
        assert!(crashed.is_err());
        assert_eq!(c.run(&key, || 7), 7);
    }

    #[test]
    fn different_keys_do_not_wait_for_each_other() {
        let c: Arc<Coalesce<String, usize>> = Arc::new(Coalesce::new());
        let (tx, rx) = std::sync::mpsc::channel::<()>();
        let slow = {
            let c = c.clone();
            std::thread::spawn(move || {
                c.run(&"slow".to_string(), || {
                    rx.recv().unwrap();
                    1
                })
            })
        };
        std::thread::sleep(Duration::from_millis(50));
        assert_eq!(c.run(&"fast".to_string(), || 2), 2);
        tx.send(()).unwrap();
        assert_eq!(slow.join().unwrap(), 1);
    }
}
