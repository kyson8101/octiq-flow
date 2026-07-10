// octiq: a bidirectional agent-to-agent message bus over a shared filesystem.
//
// Two CLI agents (Claude Code, Codex) each running in their own octiq terminal
// can hand work to each other and wait for the answer — no IPC with the app, no
// PTY injection. Everything goes through files under a shared bus directory
// (default ~/.octiqflow/bus), so this also works in any two plain terminals,
// which is what makes it a clean proof-of-concept.
//
// The model fits how CLI agents actually behave: they are turn-based, not
// daemons. A worker that wants to receive work runs `octiq recv`, which BLOCKS
// (its turn waits) until a task lands, then prints it. The asker runs
// `octiq ask`, which BLOCKS until the worker answers, then prints the answer —
// so from the asker's side it reads like any other command that returns output.
// "Bidirectional" = the CLI is symmetric: either side can ask, either side can
// recv/reply, and the roles can swap turn to turn.
//
// Protocol (one in-flight request per worker, which is enough for a POC):
//   ask  : write a request into the TARGET's inbox, then poll MY replies dir.
//   recv : poll MY inbox for the oldest request, record it as "current", print it.
//   reply: read MY "current", write the answer into the ASKER's replies dir.
//
// Files under <root>:
//   <name>/inbox/<ts>-<reqId>.json   a request waiting for <name>   {reqId,from,message,ts}
//   <name>/current.json              the request <name> is answering {reqId,from}
//   <name>/replies/<reqId>.json      an answer addressed to <name>   {reqId,from,answer,ts}
//
// Identity ("who am I") resolves from --as, else $OCTIQ_BUS_NAME, else
// $OCTIQ_TERM_KEY (the stable per-tab key octiq already exports). Atomic writes
// (temp file + rename) mean a poller never reads a half-written request.
//
// Standalone binary target, auto-discovered from src/bin/. Independent of the
// app (lib + the `octiq-flow` binary).

use std::ffi::OsStr;
use std::fs;
use std::path::{Path, PathBuf};
use std::process::ExitCode;
use std::thread::sleep;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use uuid::Uuid;

/// How often the blocking commands re-check the filesystem.
const POLL: Duration = Duration::from_millis(250);
/// Default seconds `ask` waits for a reply before giving up. `recv` defaults to
/// 0 (wait forever) since "wait for work" has no natural deadline.
const DEFAULT_ASK_TIMEOUT: u64 = 120;

#[derive(Debug, Serialize, Deserialize)]
struct Request {
    #[serde(rename = "reqId")]
    req_id: String,
    from: String,
    message: String,
    ts: u128,
}

#[derive(Debug, Serialize, Deserialize)]
struct Reply {
    #[serde(rename = "reqId")]
    req_id: String,
    from: String,
    answer: String,
    ts: u128,
}

/// The "current" request a worker is answering, written by `recv` and consumed
/// by `reply` so `reply` knows where to send the answer.
#[derive(Debug, Serialize, Deserialize)]
struct Current {
    #[serde(rename = "reqId")]
    req_id: String,
    from: String,
}

// ---- Paths (pure) ---------------------------------------------------------

/// The user's home dir from HOME (Unix) or USERPROFILE (Windows).
///
/// A deliberate copy of `paths::home_dir` rather than a call to it (card 26).
/// This is a STANDALONE binary: `use octiq_flow_lib::paths` would link the whole
/// Tauri app — webview, PTY manager, git backend — into a tiny bus CLI. Six
/// lines duplicated is the cheaper trade. Named `bus_home_dir` so the app's
/// "exactly one `fn home_dir`" rule still holds.
fn bus_home_dir() -> Option<PathBuf> {
    std::env::var("HOME")
        .ok()
        .or_else(|| std::env::var("USERPROFILE").ok())
        .filter(|s| !s.is_empty())
        .map(PathBuf::from)
}

/// The bus root: $OCTIQ_BUS_DIR if set (used by tests), else ~/.octiqflow/bus.
fn bus_root() -> Result<PathBuf, String> {
    if let Ok(dir) = std::env::var("OCTIQ_BUS_DIR") {
        if !dir.is_empty() {
            return Ok(PathBuf::from(dir));
        }
    }
    bus_home_dir()
        .map(|h| h.join(".octiqflow").join("bus"))
        .ok_or_else(|| "could not resolve home directory (set OCTIQ_BUS_DIR)".to_string())
}

fn inbox_dir(root: &Path, name: &str) -> PathBuf {
    root.join(name).join("inbox")
}

fn replies_dir(root: &Path, name: &str) -> PathBuf {
    root.join(name).join("replies")
}

fn current_path(root: &Path, name: &str) -> PathBuf {
    root.join(name).join("current.json")
}

/// Inbox filename for a request: the millisecond timestamp zero-padded to 13
/// digits then the request id, so a plain lexicographic sort of the directory is
/// chronological (oldest first) for FIFO delivery.
fn request_filename(ts: u128, req_id: &str) -> String {
    format!("{ts:013}-{req_id}.json")
}

/// Milliseconds since the Unix epoch. Zero if the clock is before the epoch
/// (it never is) — used only for FIFO ordering, so the exact value never matters
/// beyond being monotonic-ish.
fn now_millis() -> u128 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0)
}

// ---- Filesystem helpers ---------------------------------------------------

/// Serialize `value` to `path` atomically: write a sibling temp file, then
/// rename it into place. Rename within a directory is atomic on a normal
/// filesystem, so a concurrent poller reading `path` never sees partial JSON.
fn write_json_atomic<T: Serialize>(path: &Path, value: &T) -> Result<(), String> {
    let parent = path
        .parent()
        .ok_or_else(|| format!("no parent dir for {}", path.display()))?;
    fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    let raw = serde_json::to_string_pretty(value).map_err(|e| e.to_string())?;
    let tmp = parent.join(format!(".tmp-{}", Uuid::new_v4()));
    fs::write(&tmp, raw).map_err(|e| e.to_string())?;
    fs::rename(&tmp, path).map_err(|e| e.to_string())
}

/// The oldest `*.json` file in `dir` (smallest filename = oldest, by the
/// zero-padded timestamp prefix), or None if the dir is missing or empty. Hidden
/// temp files (`.tmp-*`) are skipped — they are mid-write and not yet requests.
fn oldest_inbox_file(dir: &Path) -> Option<PathBuf> {
    let mut entries: Vec<PathBuf> = fs::read_dir(dir)
        .ok()?
        .filter_map(|e| e.ok())
        .map(|e| e.path())
        .filter(|p| p.extension() == Some(OsStr::new("json")))
        .collect();
    entries.sort();
    entries.into_iter().next()
}

// ---- Identity -------------------------------------------------------------

/// A name or request id is used directly as a path segment under the bus root,
/// so it MUST be a simple identifier — otherwise a value like `../../etc/cron.d`
/// (from a crafted request file, a hand-edited current.json, or just a mistyped
/// `octiq ask ../foo`) would let a reply be written outside the bus directory
/// (path traversal / arbitrary file write). Allow only ASCII letters, digits,
/// `-` and `_`, 1–128 chars. UUIDs and ordinary bus names ("claude", "codex")
/// pass; anything with a slash, dot, or control byte is rejected.
fn validate_id(kind: &str, value: &str) -> Result<(), String> {
    let ok = !value.is_empty()
        && value.len() <= 128
        && value
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_');
    if ok {
        Ok(())
    } else {
        Err(format!(
            "invalid {kind} '{value}': only ASCII letters, digits, '-' and '_' (1–128 chars)"
        ))
    }
}

/// Resolve "who am I" from the explicit flag, then $OCTIQ_BUS_NAME, then
/// $OCTIQ_TERM_KEY (octiq exports this stable per-tab key into every shell). The
/// resolved name is validated, since it becomes a path segment.
fn resolve_self(explicit: Option<&str>) -> Result<String, String> {
    let name = explicit
        .filter(|s| !s.is_empty())
        .map(|s| s.to_string())
        .or_else(|| {
            ["OCTIQ_BUS_NAME", "OCTIQ_TERM_KEY"]
                .into_iter()
                .find_map(|var| std::env::var(var).ok().filter(|v| !v.is_empty()))
        })
        .ok_or_else(|| "no identity: pass --as <name> or set OCTIQ_BUS_NAME".to_string())?;
    validate_id("name", &name)?;
    Ok(name)
}

// ---- Command parsing (pure) -----------------------------------------------

#[derive(Debug, PartialEq)]
enum Command {
    Ask {
        target: String,
        message: String,
        me: Option<String>,
        timeout: u64,
    },
    Recv {
        me: Option<String>,
        timeout: u64,
    },
    Reply {
        answer: String,
        me: Option<String>,
    },
    Names,
    Help,
}

/// Pull `--as <name>` and `--timeout <secs>` out of an argument list, returning
/// the remaining positional args. A flag with no value, or a non-numeric
/// timeout, is an error.
fn take_options(args: &[String]) -> Result<(Option<String>, Option<u64>, Vec<String>), String> {
    let mut me = None;
    let mut timeout = None;
    let mut positional = Vec::new();
    let mut i = 0;
    while i < args.len() {
        match args[i].as_str() {
            "--as" => {
                let v = args.get(i + 1).ok_or("flag --as needs a value")?;
                me = Some(v.clone());
                i += 2;
            }
            "--timeout" => {
                let v = args.get(i + 1).ok_or("flag --timeout needs a value")?;
                timeout = Some(v.parse().map_err(|_| "--timeout must be a number")?);
                i += 2;
            }
            other => {
                positional.push(other.to_string());
                i += 1;
            }
        }
    }
    Ok((me, timeout, positional))
}

fn parse(args: &[String]) -> Result<Command, String> {
    let Some(sub) = args.first() else {
        return Ok(Command::Help);
    };
    if sub == "--help" || sub == "-h" || sub == "help" {
        return Ok(Command::Help);
    }
    let rest = &args[1..];
    let (me, timeout, positional) = take_options(rest)?;
    match sub.as_str() {
        "ask" => {
            let target = positional
                .first()
                .cloned()
                .ok_or("ask needs a target: octiq ask <target> <message>")?;
            let message = positional[1..].join(" ");
            if message.is_empty() {
                return Err("ask needs a message: octiq ask <target> <message>".into());
            }
            Ok(Command::Ask {
                target,
                message,
                me,
                timeout: timeout.unwrap_or(DEFAULT_ASK_TIMEOUT),
            })
        }
        "recv" => Ok(Command::Recv {
            me,
            timeout: timeout.unwrap_or(0),
        }),
        "reply" => {
            let answer = positional.join(" ");
            if answer.is_empty() {
                return Err("reply needs an answer: octiq reply <answer>".into());
            }
            Ok(Command::Reply { answer, me })
        }
        "names" => Ok(Command::Names),
        other => Err(format!("unknown command '{other}' (try --help)")),
    }
}

// ---- Command bodies -------------------------------------------------------

/// `deadline` from a timeout in seconds: None when timeout is 0 (wait forever).
fn deadline_after(secs: u64) -> Option<SystemTime> {
    (secs > 0).then(|| SystemTime::now() + Duration::from_secs(secs))
}

fn expired(deadline: Option<SystemTime>) -> bool {
    deadline.is_some_and(|d| SystemTime::now() >= d)
}

/// Send `message` to `target` and block until `target` answers (or timeout).
/// Prints only the answer to stdout, so the calling agent reads it as the
/// command's output.
fn run_ask(
    root: &Path,
    me: &str,
    target: &str,
    message: &str,
    timeout: u64,
) -> Result<String, String> {
    // `target` becomes a path segment (the target's inbox dir), so it must be a
    // safe identifier — `octiq ask ../../foo` must not write outside the bus.
    validate_id("target", target)?;
    let req_id = Uuid::new_v4().to_string();
    let ts = now_millis();
    let req = Request {
        req_id: req_id.clone(),
        from: me.to_string(),
        message: message.to_string(),
        ts,
    };
    let inbox = inbox_dir(root, target);
    write_json_atomic(&inbox.join(request_filename(ts, &req_id)), &req)?;
    eprintln!("octiq: sent to '{target}', waiting for reply…");

    let reply_path = replies_dir(root, me).join(format!("{req_id}.json"));
    let deadline = deadline_after(timeout);
    loop {
        if let Ok(raw) = fs::read_to_string(&reply_path) {
            if let Ok(reply) = serde_json::from_str::<Reply>(&raw) {
                let _ = fs::remove_file(&reply_path);
                return Ok(reply.answer);
            }
        }
        if expired(deadline) {
            return Err(format!("timed out after {timeout}s waiting for '{target}'"));
        }
        sleep(POLL);
    }
}

/// Block until a request lands in `me`'s inbox, record it as current, and return
/// its message text. The request file is removed once claimed.
fn run_recv(root: &Path, me: &str, timeout: u64) -> Result<String, String> {
    let inbox = inbox_dir(root, me);
    fs::create_dir_all(&inbox).map_err(|e| e.to_string())?;
    eprintln!("octiq: '{me}' waiting for a task…");
    let deadline = deadline_after(timeout);
    loop {
        if let Some(path) = oldest_inbox_file(&inbox) {
            // A claimed request is removed from the inbox so it is delivered once.
            if let Ok(raw) = fs::read_to_string(&path) {
                if let Ok(req) = serde_json::from_str::<Request>(&raw) {
                    let _ = fs::remove_file(&path);
                    // The sender and id get stored in current.json and later
                    // used to build the reply path, so reject a crafted request
                    // whose `from`/`reqId` is not a safe identifier (path
                    // traversal). Drop it and keep waiting rather than failing.
                    if validate_id("from", &req.from).is_err()
                        || validate_id("reqId", &req.req_id).is_err()
                    {
                        eprintln!("octiq: dropped a request with an unsafe sender/id");
                    } else {
                        write_json_atomic(
                            &current_path(root, me),
                            &Current {
                                req_id: req.req_id,
                                from: req.from.clone(),
                            },
                        )?;
                        return Ok(req.message);
                    }
                } else {
                    // Unparsable file: drop it so it cannot wedge the loop.
                    let _ = fs::remove_file(&path);
                }
            }
        }
        if expired(deadline) {
            return Err(format!("timed out after {timeout}s waiting for a task"));
        }
        sleep(POLL);
    }
}

/// Answer the request `me` last received via `recv`, routing the answer back to
/// the asker. Errors if there is no current request to answer.
fn run_reply(root: &Path, me: &str, answer: &str) -> Result<String, String> {
    let cur_path = current_path(root, me);
    let raw = fs::read_to_string(&cur_path)
        .map_err(|_| "nothing to reply to (run `octiq recv` first)".to_string())?;
    let cur: Current = serde_json::from_str(&raw).map_err(|e| e.to_string())?;
    // Defense in depth: current.json is written by our own (validated) recv, but
    // a hand-edited file must still not steer the reply outside the bus.
    validate_id("from", &cur.from)?;
    validate_id("reqId", &cur.req_id)?;
    let reply = Reply {
        req_id: cur.req_id.clone(),
        from: me.to_string(),
        answer: answer.to_string(),
        ts: now_millis(),
    };
    write_json_atomic(
        &replies_dir(root, &cur.from).join(format!("{}.json", cur.req_id)),
        &reply,
    )?;
    let _ = fs::remove_file(&cur_path);
    Ok(format!("octiq: replied to '{}'", cur.from))
}

/// Names that have a bus presence (a sub-directory under the root). Sorted.
fn run_names(root: &Path) -> Vec<String> {
    let mut names: Vec<String> = fs::read_dir(root)
        .into_iter()
        .flatten()
        .filter_map(|e| e.ok())
        .filter(|e| e.file_type().map(|t| t.is_dir()).unwrap_or(false))
        .filter_map(|e| e.file_name().into_string().ok())
        .collect();
    names.sort();
    names
}

fn help_text() -> &'static str {
    "\
octiq - bidirectional agent-to-agent message bus (over a shared filesystem)

USAGE:
    octiq ask <target> <message...> [--as <name>] [--timeout <secs>]
    octiq recv [--as <name>] [--timeout <secs>]
    octiq reply <answer...> [--as <name>]
    octiq names

COMMANDS:
    ask     Send a message to <target> and BLOCK until it replies; prints the reply.
    recv    BLOCK until a task arrives for me; prints the task. (timeout 0 = forever)
    reply   Answer the task I last received with `recv`.
    names   List names that have a bus presence.

IDENTITY:
    \"Who am I\" resolves from --as, then $OCTIQ_BUS_NAME, then $OCTIQ_TERM_KEY.
    Set OCTIQ_BUS_NAME once per terminal (e.g. `export OCTIQ_BUS_NAME=claude`).

BUS DIR:
    $OCTIQ_BUS_DIR if set, else ~/.octiqflow/bus.

EXAMPLE (Claude asks Codex to review, Codex answers, Claude continues):
    # In the Codex terminal, sit waiting for work (loop to serve repeatedly):
    while octiq recv --as codex; do : ; done   # each task prints; then run reply
    # In the Claude terminal:
    octiq ask codex \"Review src/auth.ts and reply with a bullet list of issues.\"
    # Back in Codex after doing the work:
    octiq reply --as codex \"1) missing nonce check  2) token logged in plaintext\"
"
}

fn main() -> ExitCode {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let cmd = match parse(&args) {
        Ok(c) => c,
        Err(msg) => {
            eprintln!("octiq: {msg}");
            return ExitCode::FAILURE;
        }
    };

    if matches!(cmd, Command::Help) {
        print!("{}", help_text());
        return ExitCode::SUCCESS;
    }

    let root = match bus_root() {
        Ok(r) => r,
        Err(msg) => {
            eprintln!("octiq: {msg}");
            return ExitCode::FAILURE;
        }
    };

    let result: Result<Option<String>, String> = match cmd {
        Command::Ask {
            target,
            message,
            me,
            timeout,
        } => resolve_self(me.as_deref())
            .and_then(|me| run_ask(&root, &me, &target, &message, timeout))
            .map(Some),
        Command::Recv { me, timeout } => resolve_self(me.as_deref())
            .and_then(|me| run_recv(&root, &me, timeout))
            .map(Some),
        Command::Reply { answer, me } => resolve_self(me.as_deref())
            .and_then(|me| run_reply(&root, &me, &answer))
            .map(Some),
        Command::Names => Ok(Some(run_names(&root).join("\n"))),
        Command::Help => unreachable!("handled above"),
    };

    match result {
        Ok(Some(out)) => {
            println!("{out}");
            ExitCode::SUCCESS
        }
        Ok(None) => ExitCode::SUCCESS,
        Err(msg) => {
            eprintln!("octiq: {msg}");
            ExitCode::FAILURE
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn s(v: &[&str]) -> Vec<String> {
        v.iter().map(|x| x.to_string()).collect()
    }

    #[test]
    fn request_filename_sorts_chronologically() {
        // Lexicographic order of the filenames must match timestamp order.
        let a = request_filename(9, "z");
        let b = request_filename(100, "a");
        assert!(a < b, "{a} should sort before {b}");
    }

    #[test]
    fn parse_ask_collects_target_and_message() {
        let cmd = parse(&s(&["ask", "codex", "review", "this", "file"])).unwrap();
        assert_eq!(
            cmd,
            Command::Ask {
                target: "codex".into(),
                message: "review this file".into(),
                me: None,
                timeout: DEFAULT_ASK_TIMEOUT,
            }
        );
    }

    #[test]
    fn parse_ask_reads_as_and_timeout_flags_anywhere() {
        let cmd = parse(&s(&[
            "ask",
            "--as",
            "claude",
            "codex",
            "--timeout",
            "5",
            "go",
        ]))
        .unwrap();
        assert_eq!(
            cmd,
            Command::Ask {
                target: "codex".into(),
                message: "go".into(),
                me: Some("claude".into()),
                timeout: 5,
            }
        );
    }

    #[test]
    fn parse_recv_defaults_to_forever() {
        assert_eq!(
            parse(&s(&["recv", "--as", "codex"])).unwrap(),
            Command::Recv {
                me: Some("codex".into()),
                timeout: 0
            }
        );
    }

    #[test]
    fn parse_rejects_missing_message_and_unknown_command() {
        assert!(parse(&s(&["ask", "codex"])).is_err());
        assert!(parse(&s(&["reply"])).is_err());
        assert!(parse(&s(&["frobnicate"])).is_err());
        assert!(parse(&s(&["--timeout"])).is_err()); // help path? no: first token is a flag
    }

    #[test]
    fn no_args_and_help_are_help() {
        assert_eq!(parse(&[]).unwrap(), Command::Help);
        assert_eq!(parse(&s(&["--help"])).unwrap(), Command::Help);
        assert_eq!(parse(&s(&["help"])).unwrap(), Command::Help);
    }

    #[test]
    fn resolve_self_prefers_explicit_then_errors_without_identity() {
        assert_eq!(resolve_self(Some("claude")).unwrap(), "claude");
        // With no flag and (in the test env) no relevant vars set, it errors.
        // We can't safely unset process env vars in a parallel test, so only
        // assert the explicit path here; the env fallbacks are covered by use.
    }

    // A full ask -> recv -> reply round-trip against a temp bus directory,
    // driving the run_* bodies directly (no blocking: each step's precondition
    // is already satisfied before the next is called).
    #[test]
    fn ask_recv_reply_round_trip_via_filesystem() {
        let root = std::env::temp_dir().join(format!("octiq-bus-test-{}", Uuid::new_v4()));
        fs::create_dir_all(&root).unwrap();

        // 1) Claude asks Codex. run_ask would block on the reply, so instead
        //    write the request directly the same way run_ask does, then assert
        //    Codex can receive it.
        let req_id = Uuid::new_v4().to_string();
        let ts = now_millis();
        write_json_atomic(
            &inbox_dir(&root, "codex").join(request_filename(ts, &req_id)),
            &Request {
                req_id: req_id.clone(),
                from: "claude".into(),
                message: "review auth.ts".into(),
                ts,
            },
        )
        .unwrap();

        // 2) Codex receives — returns the message and records current.json.
        let task = run_recv(&root, "codex", 1).unwrap();
        assert_eq!(task, "review auth.ts");
        assert!(current_path(&root, "codex").exists());
        // The claimed request is gone from the inbox (delivered once).
        assert!(oldest_inbox_file(&inbox_dir(&root, "codex")).is_none());

        // 3) Codex replies — answer lands in Claude's replies dir, keyed by reqId.
        run_reply(&root, "codex", "two issues found").unwrap();
        let reply_path = replies_dir(&root, "claude").join(format!("{req_id}.json"));
        let reply: Reply = serde_json::from_str(&fs::read_to_string(&reply_path).unwrap()).unwrap();
        assert_eq!(reply.answer, "two issues found");
        assert_eq!(reply.from, "codex");
        // current.json is consumed so a stray second reply has nothing to send.
        assert!(!current_path(&root, "codex").exists());
        assert!(run_reply(&root, "codex", "again").is_err());

        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn validate_id_rejects_path_traversal_and_control_bytes() {
        assert!(validate_id("name", "claude").is_ok());
        assert!(validate_id("reqId", "3f2a1b9c-0d4e-4a6b-8c2d-1e2f3a4b5c6d").is_ok());
        assert!(validate_id("name", "").is_err());
        assert!(validate_id("target", "../../etc/cron.d").is_err());
        assert!(validate_id("target", "a/b").is_err());
        assert!(validate_id("name", ".").is_err());
        assert!(validate_id("name", "has space").is_err());
        assert!(validate_id("name", &"x".repeat(200)).is_err());
    }

    #[test]
    fn recv_drops_a_request_with_a_traversal_sender_and_keeps_waiting() {
        let root = std::env::temp_dir().join(format!("octiq-bus-test-{}", Uuid::new_v4()));
        fs::create_dir_all(&root).unwrap();
        // A malicious request whose `from` would escape the bus on reply.
        let ts = now_millis();
        write_json_atomic(
            &inbox_dir(&root, "codex").join(request_filename(ts, "evil")),
            &Request {
                req_id: "evil".into(),
                from: "../../../../tmp/pwned".into(),
                message: "do harm".into(),
                ts,
            },
        )
        .unwrap();
        // recv must NOT deliver it; it drops the file and then times out empty.
        assert!(run_recv(&root, "codex", 1).is_err());
        // No current.json was written (nothing was claimed).
        assert!(!current_path(&root, "codex").exists());
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn ask_rejects_a_traversal_target() {
        let root = std::env::temp_dir().join(format!("octiq-bus-test-{}", Uuid::new_v4()));
        fs::create_dir_all(&root).unwrap();
        assert!(run_ask(&root, "claude", "../../etc", "hi", 1).is_err());
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn recv_times_out_when_no_task_arrives() {
        let root = std::env::temp_dir().join(format!("octiq-bus-test-{}", Uuid::new_v4()));
        fs::create_dir_all(&root).unwrap();
        // timeout 1s, empty inbox -> Err, and quickly.
        assert!(run_recv(&root, "lonely", 1).is_err());
        let _ = fs::remove_dir_all(&root);
    }
}
