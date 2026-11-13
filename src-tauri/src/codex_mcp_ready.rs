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
//! Only worker launches that carry the `playwright` entry on the app-server
//! transport have a gate. `codex exec` has no equivalent: it prints no MCP
//! startup state on its stream and takes its prompt as an argument, so the
//! host has nothing to wait on (see `docs/agent-chat-footprint.md`).

use serde_json::Value;
use std::sync::{Arc, Condvar, Mutex};
use std::time::{Duration, Instant};

/// How long the first turn waits for the browser server.
pub(crate) const BOUND: Duration = Duration::from_secs(30);

const METHOD: &str = "mcpServer/startupStatus/updated";

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
    server: String,
    state: Mutex<Readiness>,
    changed: Condvar,
}

impl McpReady {
    pub(crate) fn new(server: &str) -> Arc<Self> {
        Arc::new(Self {
            server: server.to_owned(),
            state: Mutex::new(Readiness::Waiting),
            changed: Condvar::new(),
        })
    }

    fn set(&self, next: Readiness) {
        let mut state = self.state.lock().unwrap_or_else(|e| e.into_inner());
        // The first word that settles stays: a later `starting` from a
        // restart, or a `closed` after `ready`, changes nothing.
        if *state == Readiness::Waiting {
            *state = next;
            self.changed.notify_all();
        }
    }

    /// Feed every line the app-server wrote. Anything that is not this
    /// server's startup status is ignored.
    pub(crate) fn observe(&self, message: &Value) {
        if message.get("method").and_then(Value::as_str) != Some(METHOD) {
            return;
        }
        let params = &message["params"];
        if params.get("name").and_then(Value::as_str) != Some(self.server.as_str()) {
            return;
        }
        match params.get("status").and_then(Value::as_str) {
            Some("ready") => self.set(Readiness::Ready),
            Some(status @ ("failed" | "cancelled")) => {
                let why = params
                    .get("error")
                    .and_then(Value::as_str)
                    .filter(|why| !why.trim().is_empty())
                    .unwrap_or(status);
                self.set(Readiness::Failed(why.to_owned()));
            }
            _ => {}
        }
    }

    /// The app-server's output ended.
    pub(crate) fn close(&self) {
        self.set(Readiness::Closed);
    }

    /// Block until the server settles, the process closes or `bound` passes.
    pub(crate) fn wait(&self, bound: Duration) -> Outcome {
        let deadline = Instant::now() + bound;
        let mut state = self.state.lock().unwrap_or_else(|e| e.into_inner());
        loop {
            match &*state {
                Readiness::Ready => return Outcome::Ready,
                Readiness::Failed(why) => return Outcome::Failed(why.clone()),
                Readiness::Closed => return Outcome::Closed,
                Readiness::Waiting => {}
            }
            let left = deadline.saturating_duration_since(Instant::now());
            if left.is_zero() {
                return Outcome::TimedOut;
            }
            state = self
                .changed
                .wait_timeout(state, left)
                .unwrap_or_else(|e| e.into_inner())
                .0;
        }
    }
}

/// Hold the first turn for the gate. Returns the diagnostics line when the
/// turn goes on without a settled-ready server; `None` when it was ready.
pub(crate) fn hold_first_turn(ready: &McpReady, bound: Duration) -> Option<String> {
    let server = &ready.server;
    match ready.wait(bound) {
        Outcome::Ready => None,
        Outcome::Failed(why) => Some(format!(
            "MCP server `{server}` failed to start ({why}); the first turn goes ahead without it"
        )),
        Outcome::Closed => Some(format!(
            "Codex app-server closed before MCP server `{server}` was ready"
        )),
        Outcome::TimedOut => Some(format!(
            "MCP server `{server}` was not ready after {}s; the first turn goes ahead without it",
            bound.as_secs()
        )),
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
        assert_eq!(hold_first_turn(&ready, Duration::from_secs(10)), None);
        assert!(started.elapsed() < Duration::from_secs(5));
    }

    #[test]
    fn it_does_not_wait_when_the_server_was_ready_before_the_wait_began() {
        let ready = McpReady::new("playwright");
        ready.observe(&status("playwright", "ready", None));
        let started = Instant::now();
        assert_eq!(hold_first_turn(&ready, Duration::from_secs(10)), None);
        assert!(started.elapsed() < Duration::from_secs(1));
    }

    #[test]
    fn it_says_why_when_the_bound_runs_out() {
        let ready = McpReady::new("playwright");
        // Only `starting` ever arrives, and another server's `ready` does not count.
        ready.observe(&status("playwright", "starting", None));
        ready.observe(&status("octiq", "ready", None));
        let started = Instant::now();
        let note = hold_first_turn(&ready, Duration::from_millis(150)).expect("a timeout note");
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
        let note = hold_first_turn(&ready, Duration::from_secs(10)).expect("a failure note");
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
        let note = hold_first_turn(&ready, Duration::from_secs(10)).expect("a closed note");
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
}
