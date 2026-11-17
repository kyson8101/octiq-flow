//! Wait for a Codex worker's browser server before its first turn.
//!
//! Codex builds a turn's tool list when the turn STARTS. A worker launch adds
//! the person's `playwright` as an MCP server (`worker_browser`), and a cold
//! `npx` start reaches `ready` only after the first `turn/start` has begun, so
//! that turn (where a worker does most of its work) had no browser tools while
//! every later turn did. app-server says when each server settles with the
//! `mcpServer/startupStatus/updated` notification (`starting`, `ready`,
//! `failed`, `cancelled`), so the host holds the first turn until that
//! server has settled.
//!
//! The wait runs on a thread of its own, after `start_chat` has returned
//! (`agent_chat::hand_over_first_turn`): the caller holds the orchestration
//! ledger's workspace lock until then, and a Task or Run Stop takes the same
//! lock. While it waits, the session reads busy (a message sent meanwhile
//! queues behind the first prompt) and carries `first_turn_held`, which tells
//! an interrupt there is no turn in flight to cut short.
//!
//! The wait only ever delays: `ready` goes on at once, and a failure, a
//! closed process or the bound running out also goes on, with one diagnostics
//! line saying why. It never refuses a launch and never hangs a task.
//!
//! The bound is 30 seconds because that is Codex's own default
//! `startup_timeout_sec` for an MCP server: past it Codex has already marked
//! the server `failed` (which this gate then reads), so waiting longer cannot
//! produce a browser. A warm `npx` settles in a few seconds and a cold one
//! (package download) in the order of ten, so the bound leaves headroom for
//! both.
//!
//! Only worker launches that carry the `playwright` entry, or keep the
//! computer-use servers for an agent that opted in (`desktop_tools`), on the
//! app-server transport have a gate, and it waits for every one of them. `codex exec` has no equivalent: it prints no MCP
//! startup state on its stream and takes its prompt as an argument, so the
//! host has nothing to wait on (see `docs/agent-chat-footprint.md`).

use serde_json::Value;
use std::sync::{Arc, Condvar, Mutex};
use std::time::{Duration, Instant};

/// How long the first turn waits for the browser server.
pub(crate) const BOUND: Duration = Duration::from_secs(30);

const METHOD: &str = "mcpServer/startupStatus/updated";

/// The most a startup timeout from the person's config may stretch the wait
/// to. The bundled computer-use servers ask for 120 s; a value past this is
/// treated as this.
const MOST: Duration = Duration::from_secs(120);

/// Where the watched server stands.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) enum Readiness {
    Waiting,
    Ready,
    Failed(String),
    /// app-server went away before the server settled.
    Closed,
}

/// What the wait ended with.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) enum Outcome {
    Ready,
    Failed(String),
    Closed,
    TimedOut,
}

pub(crate) struct McpReady {
    /// Every server the first turn waits for, each with where it stands.
    servers: Mutex<Vec<(String, Readiness)>>,
    /// The longest `startup_timeout_sec` any of them was given, so the wait
    /// is never shorter than Codex itself allows (`bound_for`).
    longest: Duration,
    changed: Condvar,
}

impl McpReady {
    pub(crate) fn new(server: &str) -> Arc<Self> {
        Self::watching(&[server.to_owned()], Duration::ZERO)
    }

    /// Wait for every one of `servers`. `longest` is the longest startup
    /// timeout Codex gives any of them (zero when none says).
    pub(crate) fn watching(servers: &[String], longest: Duration) -> Arc<Self> {
        Arc::new(Self {
            servers: Mutex::new(
                servers
                    .iter()
                    .map(|name| (name.clone(), Readiness::Waiting))
                    .collect(),
            ),
            longest,
            changed: Condvar::new(),
        })
    }

    /// `base`, or the longest startup timeout of a watched server when that is
    /// longer: past it Codex has already marked the server `failed`, which the
    /// wait reads, so waiting longer than it allows cannot produce a tool.
    pub(crate) fn bound_for(&self, base: Duration) -> Duration {
        base.max(self.longest.min(MOST))
    }

    fn names(&self) -> String {
        let servers = self.servers.lock().unwrap_or_else(|e| e.into_inner());
        servers
            .iter()
            .map(|(name, _)| name.as_str())
            .collect::<Vec<_>>()
            .join("`, `")
    }

    fn set(&self, server: &str, next: Readiness) {
        let mut servers = self.servers.lock().unwrap_or_else(|e| e.into_inner());
        // The first word that settles stays: a later `starting` from a
        // restart, or a `closed` after `ready`, changes nothing.
        if let Some((_, state)) = servers.iter_mut().find(|(name, _)| name == server) {
            if *state == Readiness::Waiting {
                *state = next;
                self.changed.notify_all();
            }
        }
    }

    /// Feed every line the app-server wrote. Anything that is not a watched
    /// server's startup status is ignored.
    pub(crate) fn observe(&self, message: &Value) {
        if message.get("method").and_then(Value::as_str) != Some(METHOD) {
            return;
        }
        let params = &message["params"];
        let Some(server) = params.get("name").and_then(Value::as_str) else {
            return;
        };
        match params.get("status").and_then(Value::as_str) {
            Some("ready") => self.set(server, Readiness::Ready),
            Some(status @ ("failed" | "cancelled")) => {
                let why = params
                    .get("error")
                    .and_then(Value::as_str)
                    .filter(|why| !why.trim().is_empty())
                    .unwrap_or(status);
                self.set(server, Readiness::Failed(why.to_owned()));
            }
            _ => {}
        }
    }

    /// The app-server's output ended.
    pub(crate) fn close(&self) {
        let mut servers = self.servers.lock().unwrap_or_else(|e| e.into_inner());
        for (_, state) in servers.iter_mut() {
            if *state == Readiness::Waiting {
                *state = Readiness::Closed;
            }
        }
        self.changed.notify_all();
    }

    /// Block until every watched server settles, the process closes or
    /// `bound` passes.
    pub(crate) fn wait(&self, bound: Duration) -> Outcome {
        let deadline = Instant::now() + bound;
        let mut servers = self.servers.lock().unwrap_or_else(|e| e.into_inner());
        loop {
            if servers
                .iter()
                .all(|(_, state)| *state != Readiness::Waiting)
            {
                if servers.iter().any(|(_, state)| *state == Readiness::Closed) {
                    return Outcome::Closed;
                }
                let failed = servers.iter().find_map(|(name, state)| match state {
                    Readiness::Failed(why) => Some((name, why)),
                    _ => None,
                });
                return match failed {
                    Some((name, why)) if servers.len() > 1 => {
                        Outcome::Failed(format!("{name}: {why}"))
                    }
                    Some((_, why)) => Outcome::Failed(why.clone()),
                    None => Outcome::Ready,
                };
            }
            let left = deadline.saturating_duration_since(Instant::now());
            if left.is_zero() {
                return Outcome::TimedOut;
            }
            servers = self
                .changed
                .wait_timeout(servers, left)
                .unwrap_or_else(|e| e.into_inner())
                .0;
        }
    }
}

/// What the wait decided.
#[derive(Debug, PartialEq, Eq)]
pub(crate) struct Hold {
    /// Whether the first turn should still be handed over. False only when
    /// the process closed: there is nobody to give it to.
    pub(crate) goes_on: bool,
    /// The diagnostics line when the turn goes on without a settled-ready
    /// server (or does not go on); `None` when it was ready.
    pub(crate) note: Option<String>,
}

/// Wait for the gate. Meant for a thread of its own: it holds no lock of the
/// host's and ends at once when the process closes (a Stop kills it).
pub(crate) fn hold_first_turn(ready: &McpReady, bound: Duration) -> Hold {
    let server = ready.names();
    match ready.wait(bound) {
        Outcome::Ready => Hold {
            goes_on: true,
            note: None,
        },
        Outcome::Failed(why) => Hold {
            goes_on: true,
            note: Some(format!(
                "MCP server `{server}` failed to start ({why}); the first turn goes ahead without it"
            )),
        },
        Outcome::Closed => Hold {
            goes_on: false,
            note: Some(format!(
                "Codex app-server closed before MCP server `{server}` was ready"
            )),
        },
        Outcome::TimedOut => Hold {
            goes_on: true,
            note: Some(format!(
                "MCP server `{server}` was not ready after {}s; the first turn goes ahead without it",
                bound.as_secs()
            )),
        },
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use std::sync::mpsc;
    use std::thread;

    fn status(name: &str, status: &str, error: Option<&str>) -> Value {
        json!({
            "method": METHOD,
            "params": { "name": name, "status": status, "error": error, "threadId": null },
        })
    }

    /// A stand-in app-server: a thread writing JSON lines to a channel after
    /// the delays it is given, read by the host side the way the reader
    /// thread does.
    fn stub_app_server(script: Vec<(u64, Value)>, ready: Arc<McpReady>) -> thread::JoinHandle<()> {
        let (tx, rx) = mpsc::channel::<Value>();
        thread::spawn(move || {
            for (delay_ms, line) in script {
                thread::sleep(Duration::from_millis(delay_ms));
                if tx.send(line).is_err() {
                    return;
                }
            }
        });
        thread::spawn(move || {
            for line in rx {
                ready.observe(&line);
            }
            ready.close();
        })
    }

    #[test]
    fn it_goes_on_as_soon_as_the_server_is_ready() {
        let ready = McpReady::new("playwright");
        let _reader = stub_app_server(
            vec![
                (10, status("playwright", "starting", None)),
                (50, status("playwright", "ready", None)),
            ],
            ready.clone(),
        );
        let started = Instant::now();
        assert_eq!(hold_first_turn(&ready, Duration::from_secs(10)).note, None);
        assert!(started.elapsed() < Duration::from_secs(5));
    }

    #[test]
    fn it_does_not_wait_when_the_server_was_ready_before_the_wait_began() {
        let ready = McpReady::new("playwright");
        ready.observe(&status("playwright", "ready", None));
        let started = Instant::now();
        assert_eq!(hold_first_turn(&ready, Duration::from_secs(10)).note, None);
        assert!(started.elapsed() < Duration::from_secs(1));
    }

    #[test]
    fn it_says_why_when_the_bound_runs_out() {
        let ready = McpReady::new("playwright");
        // Only `starting` ever arrives, and another server's `ready` does not count.
        ready.observe(&status("playwright", "starting", None));
        ready.observe(&status("octiq", "ready", None));
        let started = Instant::now();
        let note = hold_first_turn(&ready, Duration::from_millis(150))
            .note
            .expect("a timeout note");
        assert!(started.elapsed() >= Duration::from_millis(150));
        assert!(note.contains("not ready after"), "{note}");
        assert!(note.contains("playwright"), "{note}");
    }

    #[test]
    fn it_goes_on_and_says_so_when_the_server_fails() {
        let ready = McpReady::new("playwright");
        let _reader = stub_app_server(
            vec![
                (10, status("playwright", "starting", None)),
                (20, status("playwright", "failed", Some("spawn npx ENOENT"))),
            ],
            ready.clone(),
        );
        let note = hold_first_turn(&ready, Duration::from_secs(10))
            .note
            .expect("a failure note");
        assert!(note.contains("failed to start"), "{note}");
        assert!(note.contains("spawn npx ENOENT"), "{note}");
    }

    #[test]
    fn a_cancelled_start_is_a_failure_and_a_bare_failure_names_its_status() {
        let ready = McpReady::new("playwright");
        ready.observe(&status("playwright", "cancelled", None));
        assert_eq!(
            ready.wait(Duration::from_secs(1)),
            Outcome::Failed("cancelled".into())
        );
    }

    #[test]
    fn a_process_that_closes_first_ends_the_wait_at_once() {
        let ready = McpReady::new("playwright");
        // The stub writes nothing and hangs up.
        let _reader = stub_app_server(Vec::new(), ready.clone());
        let started = Instant::now();
        let held = hold_first_turn(&ready, Duration::from_secs(10));
        assert!(!held.goes_on, "nobody is left to give the turn to");
        let note = held.note.expect("a closed note");
        assert!(note.contains("closed"), "{note}");
        assert!(started.elapsed() < Duration::from_secs(5));
    }

    #[test]
    fn the_first_word_that_settles_stays() {
        let ready = McpReady::new("playwright");
        ready.observe(&status("playwright", "ready", None));
        ready.observe(&status("playwright", "failed", Some("later")));
        ready.close();
        assert_eq!(ready.wait(Duration::from_secs(1)), Outcome::Ready);
    }

    #[test]
    fn lines_that_are_not_a_startup_status_change_nothing() {
        let ready = McpReady::new("playwright");
        ready.observe(&json!({ "method": "turn/started", "params": {} }));
        ready.observe(&json!({ "id": 1, "result": {} }));
        ready.observe(&json!({ "method": METHOD, "params": { "name": "playwright" } }));
        assert_eq!(ready.wait(Duration::from_millis(20)), Outcome::TimedOut);
    }

    #[test]
    fn it_waits_for_every_watched_server_and_names_the_one_that_failed() {
        let names = [
            "octiq_playwright".to_owned(),
            "cua_repl".to_owned(),
            "node_repl".to_owned(),
        ];
        let ready = McpReady::watching(&names, Duration::from_secs(120));
        ready.observe(&status("octiq_playwright", "ready", None));
        ready.observe(&status("cua_repl", "ready", None));
        assert_eq!(
            ready.wait(Duration::from_millis(30)),
            Outcome::TimedOut,
            "one still starting holds the turn"
        );
        ready.observe(&status("node_repl", "failed", Some("spawn failed")));
        assert_eq!(
            ready.wait(Duration::from_secs(1)),
            Outcome::Failed("node_repl: spawn failed".into())
        );
        let note = hold_first_turn(&ready, Duration::from_secs(1))
            .note
            .unwrap();
        assert!(
            note.contains("octiq_playwright") && note.contains("cua_repl"),
            "{note}"
        );
        assert!(note.contains("node_repl: spawn failed"), "{note}");

        let all = McpReady::watching(&names, Duration::ZERO);
        for name in &names {
            all.observe(&status(name, "ready", None));
        }
        assert_eq!(all.wait(Duration::from_secs(1)), Outcome::Ready);
    }

    #[test]
    fn the_wait_is_never_shorter_than_codexs_own_startup_timeout() {
        let one = McpReady::new("playwright");
        assert_eq!(one.bound_for(BOUND), BOUND, "no timeout said: unchanged");
        let slow = McpReady::watching(&["node_repl".to_owned()], Duration::from_secs(120));
        assert_eq!(slow.bound_for(BOUND), Duration::from_secs(120));
        let short = McpReady::watching(&["x".to_owned()], Duration::from_secs(10));
        assert_eq!(short.bound_for(BOUND), BOUND);
        let silly = McpReady::watching(&["x".to_owned()], Duration::from_secs(9999));
        assert_eq!(silly.bound_for(BOUND), Duration::from_secs(120));
    }

    #[test]
    fn a_close_ends_the_wait_for_every_server_still_starting() {
        let names = ["a".to_owned(), "b".to_owned()];
        let ready = McpReady::watching(&names, Duration::ZERO);
        ready.observe(&status("a", "ready", None));
        ready.close();
        assert_eq!(ready.wait(Duration::from_secs(1)), Outcome::Closed);
    }
}
