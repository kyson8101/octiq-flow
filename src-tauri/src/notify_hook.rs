// Optional user hook that can rewrite or suppress an attention alert before
// OctiqFlow shows it (card 19).
//
// Convention: an executable at `<profile dir>/notify-hook`, in any language.
// When it is absent — the normal case — nothing here runs and alerts behave
// exactly as before.
//
// Protocol, deliberately tiny (a JSON envelope in, a JSON patch out):
//
//   stdin   { "id": "proj-a:0", "source": "osc", "title": "Claude",
//             "body": "needs input", "project": "proj-a" }
//   stdout  { "title": "CLAUDE", "body": "…", "suppress": false }
//
// Every field of the reply is optional: an absent `title` keeps the original
// title, and so on. `"suppress": true` drops the alert entirely.
//
// The hook is BEST-EFFORT and must never be able to break alerting — the same
// rule the agent capture hook follows. A missing file, a non-zero exit, a
// crash, unreadable output, output that is not JSON, or a hook that hangs past
// HOOK_TIMEOUT all fall back to showing the ORIGINAL alert. The only way to
// lose an alert is for the hook to succeed and explicitly ask for it.
use std::io::Write;
use std::path::PathBuf;
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};

/// How long the hook may take before it is killed and its alert shown as-is.
/// A hook is a notification filter, not a workflow — two seconds is generous.
const HOOK_TIMEOUT: Duration = Duration::from_secs(2);

/// How often to check whether the hook has exited while waiting it out.
const POLL_INTERVAL: Duration = Duration::from_millis(10);

/// One attention alert, on its way to the user.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct Alert {
    /// The pty session id that raised it.
    pub id: String,
    /// What noticed it: `"osc"` (an escape sequence in the terminal output) or
    /// `"quiet"` (the frontend's silence monitor, card 15).
    pub source: String,
    pub title: String,
    pub body: String,
    /// The project this terminal belongs to, when its id names one.
    pub project: Option<String>,
}

/// What a hook may change about an alert. Every field is optional, so a hook
/// that only wants to rename the title emits `{"title":"…"}` and nothing else.
#[derive(Debug, Default, Deserialize)]
struct HookPatch {
    title: Option<String>,
    body: Option<String>,
    suppress: Option<bool>,
}

/// The pty id prefixes that are NOT project ids. Terminal ids are namespaced
/// `<projectId>:N`, `cmd:<projectId>:N`, or `<reserved>:N` for the app's own
/// non-project groups (see `terminals.js`).
const RESERVED_PREFIXES: [&str; 3] = ["chat", "util", "sched"];

/// The project id a pty session belongs to, or `None` when it belongs to no
/// project (a chat terminal, a utility terminal, or an unnamespaced id).
fn project_of(id: &str) -> Option<&str> {
    // "cmd:<projectId>:N" — a command terminal run from a project's panel.
    if let Some(rest) = id.strip_prefix("cmd:") {
        let project = rest.split(':').next()?;
        return (!project.is_empty()).then_some(project);
    }
    let head = id.split(':').next()?;
    if head.is_empty() || head == id || RESERVED_PREFIXES.contains(&head) {
        // No ':' at all, or one of the app's own groups: not a project.
        return None;
    }
    Some(head)
}

/// Apply a hook's reply to the alert it was given. `None` means the hook asked
/// for the alert to be dropped. Fields the hook left out keep their original
/// value, so a partial reply is not a way to blank out a title by accident.
fn apply_patch(alert: Alert, patch: HookPatch) -> Option<Alert> {
    if patch.suppress.unwrap_or(false) {
        return None;
    }
    Some(Alert {
        title: patch.title.unwrap_or(alert.title),
        body: patch.body.unwrap_or(alert.body),
        ..alert
    })
}

/// Path of the user's hook, if it exists and is a file. A directory or a
/// missing entry means "no hook".
fn hook_path() -> Option<PathBuf> {
    let path = crate::profile::profile_dir().join("notify-hook");
    path.is_file().then_some(path)
}

/// Run `hook` over the JSON envelope and return whatever it wrote to stdout,
/// or `None` for ANY failure (spawn error, non-zero exit, timeout, non-UTF-8
/// output). A hook that outlives `HOOK_TIMEOUT` is killed.
fn run_hook(hook: &PathBuf, envelope: &str) -> Option<String> {
    let mut child = Command::new(hook)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        // A chatty hook must not spam the app's own stderr.
        .stderr(Stdio::null())
        .spawn()
        .ok()?;

    // Writing the envelope and DROPPING the pipe gives the hook its EOF, so a
    // `read()`-to-end hook (the natural way to write one) can finish. A hook
    // that never reads its stdin makes this write fail with EPIPE; that is not
    // an error we care about — the timeout below still bounds us.
    if let Some(mut stdin) = child.stdin.take() {
        let _ = stdin.write_all(envelope.as_bytes());
    }

    // std has no `wait_timeout`, so poll. An alert is a human-paced event and
    // the hook is expected to finish in milliseconds, so a 10ms poll costs
    // nothing and keeps the kill path simple (`wait_with_output` would consume
    // the child and leave us no handle to kill).
    let deadline = Instant::now() + HOOK_TIMEOUT;
    loop {
        match child.try_wait() {
            Ok(Some(status)) => {
                if !status.success() {
                    return None;
                }
                break;
            }
            Ok(None) => {}
            Err(_) => return None,
        }
        if Instant::now() >= deadline {
            let _ = child.kill();
            let _ = child.wait(); // reap it; never leave a zombie behind
            return None;
        }
        std::thread::sleep(POLL_INTERVAL);
    }

    let output = child.wait_with_output().ok()?;
    String::from_utf8(output.stdout).ok()
}

/// Run the user's hook over an alert, returning the alert to show — possibly
/// rewritten — or `None` if the hook suppressed it.
///
/// This BLOCKS for up to `HOOK_TIMEOUT`. Never call it from the PTY reader
/// thread: a hook that hangs would stall that terminal's output. Callers hand
/// it a thread of its own.
pub fn filter(alert: Alert) -> Option<Alert> {
    filter_with(hook_path(), alert)
}

/// `filter`, with the hook path handed in — so the tests can point it at a
/// script instead of at whatever happens to sit in the user's profile dir.
///
/// This is where the "best effort" promise is kept: EVERY failure mode falls
/// through to `Some(alert)`, the original.
fn filter_with(hook: Option<PathBuf>, alert: Alert) -> Option<Alert> {
    let Some(hook) = hook else {
        return Some(alert); // no hook installed: the overwhelmingly common case
    };
    let Ok(envelope) = serde_json::to_string(&alert) else {
        return Some(alert);
    };
    let Some(stdout) = run_hook(&hook, &envelope) else {
        return Some(alert); // spawn failed, hung, crashed, or exited non-zero
    };
    match serde_json::from_str::<HookPatch>(stdout.trim()) {
        Ok(patch) => apply_patch(alert, patch),
        // Not JSON (or the wrong shape): the hook is broken, the alert is not.
        Err(_) => Some(alert),
    }
}

/// Build an alert for a pty id, deriving its project from the id.
pub fn alert_for(id: String, source: &str, title: String, body: String) -> Alert {
    let project = project_of(&id).map(str::to_string);
    Alert {
        id,
        source: source.to_string(),
        title,
        body,
        project,
    }
}

/// What the frontend gets back from `notify_hook_filter`.
#[derive(Serialize)]
pub struct FilteredAlert {
    pub title: String,
    pub body: String,
    pub suppress: bool,
}

/// Run the notify hook over an alert the FRONTEND raised (card 15's silence
/// monitor), so a user hook filters those exactly as it filters an OSC alert.
///
/// The OSC path does not come through here — `pty.rs` calls `filter` directly on
/// its own thread, because it has the alert before the frontend ever hears of it.
#[tauri::command]
pub async fn notify_hook_filter(
    id: String,
    source: String,
    title: String,
    body: String,
) -> FilteredAlert {
    // `async` so Tauri runs this on its thread pool: `filter` blocks for up to
    // HOOK_TIMEOUT and must not sit on the main thread.
    match filter(alert_for(id, &source, title.clone(), body.clone())) {
        Some(alert) => FilteredAlert {
            title: alert.title,
            body: alert.body,
            suppress: false,
        },
        None => FilteredAlert {
            title,
            body,
            suppress: true,
        },
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn alert() -> Alert {
        Alert {
            id: "proj-a:0".into(),
            source: "osc".into(),
            title: "Claude".into(),
            body: "needs input".into(),
            project: Some("proj-a".into()),
        }
    }

    // ---- project_of ---------------------------------------------------------

    #[test]
    fn project_of_reads_a_plain_project_terminal() {
        assert_eq!(project_of("proj-a:0"), Some("proj-a"));
    }

    #[test]
    fn project_of_reads_a_command_terminal() {
        assert_eq!(project_of("cmd:proj-a:3"), Some("proj-a"));
    }

    #[test]
    fn project_of_is_none_for_the_apps_own_groups() {
        assert_eq!(project_of("chat:0"), None);
        assert_eq!(project_of("util:1"), None);
        assert_eq!(project_of("sched:2"), None);
    }

    #[test]
    fn project_of_is_none_for_an_unnamespaced_id() {
        assert_eq!(project_of("weird"), None);
        assert_eq!(project_of(""), None);
        assert_eq!(project_of(":3"), None);
        assert_eq!(project_of("cmd::3"), None);
    }

    // ---- apply_patch --------------------------------------------------------

    #[test]
    fn an_empty_patch_leaves_the_alert_untouched() {
        // The shape a hook that only inspects, never edits, would emit: `{}`.
        assert_eq!(apply_patch(alert(), HookPatch::default()), Some(alert()));
    }

    #[test]
    fn a_patch_rewrites_only_the_fields_it_names() {
        let patch = HookPatch {
            title: Some("CLAUDE".into()),
            body: None,
            suppress: None,
        };
        let out = apply_patch(alert(), patch).expect("not suppressed");
        assert_eq!(out.title, "CLAUDE");
        // Omitting `body` must KEEP the body, not blank it.
        assert_eq!(out.body, "needs input");
        assert_eq!(out.id, "proj-a:0");
        assert_eq!(out.project.as_deref(), Some("proj-a"));
    }

    #[test]
    fn suppress_drops_the_alert() {
        let patch = HookPatch {
            title: Some("ignored".into()),
            body: None,
            suppress: Some(true),
        };
        assert_eq!(apply_patch(alert(), patch), None);
    }

    #[test]
    fn suppress_false_is_the_same_as_omitting_it() {
        let patch = HookPatch {
            title: None,
            body: None,
            suppress: Some(false),
        };
        assert_eq!(apply_patch(alert(), patch), Some(alert()));
    }

    #[test]
    fn a_hook_can_blank_a_field_only_by_naming_it() {
        let patch = HookPatch {
            title: Some(String::new()),
            body: None,
            suppress: None,
        };
        let out = apply_patch(alert(), patch).expect("not suppressed");
        assert_eq!(out.title, "");
    }

    // ---- the reply is parsed the way the docs promise ------------------------

    #[test]
    fn a_partial_json_reply_parses_with_the_rest_defaulted() {
        let patch: HookPatch = serde_json::from_str(r#"{"suppress": true}"#).unwrap();
        assert_eq!(apply_patch(alert(), patch), None);
    }

    #[test]
    fn unknown_reply_keys_are_ignored() {
        // Forward compat: a hook written for a later version must not break now.
        let patch: HookPatch = serde_json::from_str(r#"{"title":"T","urgency":"high"}"#).unwrap();
        assert_eq!(apply_patch(alert(), patch).unwrap().title, "T");
    }

    #[test]
    fn the_envelope_serializes_with_the_documented_keys() {
        let json = serde_json::to_string(&alert()).unwrap();
        for key in [
            "\"id\"",
            "\"source\"",
            "\"title\"",
            "\"body\"",
            "\"project\"",
        ] {
            assert!(json.contains(key), "envelope missing {key}: {json}");
        }
    }

    #[test]
    fn alert_for_derives_the_project_from_the_id() {
        let a = alert_for("cmd:p1:2".into(), "quiet", "T".into(), "B".into());
        assert_eq!(a.project.as_deref(), Some("p1"));
        assert_eq!(a.source, "quiet");
        let chat = alert_for("chat:0".into(), "osc", "T".into(), "B".into());
        assert_eq!(chat.project, None);
    }

    // ---- filter_with, against REAL hook processes ---------------------------
    // These are the card's acceptance criteria. They run a throwaway shell
    // script as the hook, so the whole spawn / stdin / stdout / exit / timeout
    // path is exercised, not just the pure helpers above.

    /// Write `body` as an executable `/bin/sh` script in a fresh temp dir and
    /// return its path. The dir is intentionally leaked: these are short-lived
    /// test scripts in the OS temp dir, and a cleanup guard would be more code
    /// than the thing it guards.
    ///
    /// The script is staged under a temp name, made executable, and only THEN
    /// renamed into place. Exec'ing a file the same process just finished
    /// writing can fail with ETXTBSY; renaming hands `exec` a settled inode, so
    /// these tests cannot flake on their own setup.
    #[cfg(unix)]
    fn script(name: &str, body: &str) -> PathBuf {
        use std::os::unix::fs::PermissionsExt;
        let dir = std::env::temp_dir().join(format!("octiq-hook-test-{name}"));
        let _ = std::fs::create_dir_all(&dir);
        let staged = dir.join("notify-hook.staged");
        let path = dir.join("notify-hook");
        std::fs::write(&staged, format!("#!/bin/sh\n{body}\n")).unwrap();
        std::fs::set_permissions(&staged, std::fs::Permissions::from_mode(0o755)).unwrap();
        std::fs::rename(&staged, &path).unwrap();
        path
    }

    #[test]
    fn no_hook_file_leaves_the_alert_unchanged() {
        assert_eq!(filter_with(None, alert()), Some(alert()));
    }

    #[cfg(unix)]
    #[test]
    fn a_hook_that_uppercases_the_title_is_reflected() {
        let hook = script("upper", r#"printf '{"title":"CLAUDE"}'"#);
        let out = filter_with(Some(hook), alert()).expect("not suppressed");
        assert_eq!(out.title, "CLAUDE");
        assert_eq!(out.body, "needs input");
    }

    #[cfg(unix)]
    #[test]
    fn a_hook_can_suppress_only_the_source_it_chooses() {
        // The card's example: silence `activity`, leave everything else alone.
        // The hook reads the envelope from stdin, so this also proves the
        // envelope is actually delivered.
        let hook = script(
            "by-source",
            r#"
            payload=$(cat)
            case "$payload" in
              *'"source":"activity"'*) printf '{"suppress":true}' ;;
              *) printf '{}' ;;
            esac
            "#,
        );
        let activity = Alert {
            source: "activity".into(),
            ..alert()
        };
        assert_eq!(filter_with(Some(hook.clone()), activity), None);
        // An `osc` alert from the same hook survives untouched.
        assert_eq!(filter_with(Some(hook), alert()), Some(alert()));
    }

    #[cfg(unix)]
    #[test]
    fn a_hook_that_hangs_is_killed_and_the_original_alert_shows() {
        // Sleeps well past HOOK_TIMEOUT. filter_with must return the original
        // alert, and must do so at roughly the timeout, not the sleep.
        let hook = script("hang", "sleep 30");
        let started = Instant::now();
        assert_eq!(filter_with(Some(hook), alert()), Some(alert()));
        let waited = started.elapsed();
        assert!(
            waited >= HOOK_TIMEOUT,
            "returned before the timeout: {waited:?}"
        );
        // The upper bound only has to separate "killed at the timeout" from
        // "waited out the hook's 30s sleep". Keep the slack generous: this suite
        // spawns real processes in parallel, and a tight bound here turns a busy
        // machine into a spurious failure.
        assert!(
            waited < Duration::from_secs(15),
            "waited far past the timeout ({waited:?}) — was the hook killed?"
        );
    }

    #[cfg(unix)]
    #[test]
    fn a_hook_that_exits_non_zero_leaves_the_alert_unchanged() {
        // Its stdout is ignored entirely — a failed hook has no say.
        let hook = script("fail", r#"printf '{"suppress":true}'; exit 3"#);
        assert_eq!(filter_with(Some(hook), alert()), Some(alert()));
    }

    #[cfg(unix)]
    #[test]
    fn a_hook_that_prints_garbage_leaves_the_alert_unchanged() {
        let hook = script("garbage", "printf 'not json at all'");
        assert_eq!(filter_with(Some(hook), alert()), Some(alert()));
    }

    #[cfg(unix)]
    #[test]
    fn a_hook_that_prints_nothing_leaves_the_alert_unchanged() {
        // Exit 0 with empty stdout: nothing to apply, so nothing changes.
        let hook = script("silent", "exit 0");
        assert_eq!(filter_with(Some(hook), alert()), Some(alert()));
    }

    #[cfg(unix)]
    #[test]
    fn a_hook_that_never_reads_stdin_still_works() {
        // Our envelope write gets EPIPE. That is the hook's business, not ours;
        // its reply must still be honoured.
        let hook = script("no-stdin", r#"printf '{"body":"rewritten"}'"#);
        let out = filter_with(Some(hook), alert()).expect("not suppressed");
        assert_eq!(out.body, "rewritten");
    }

    #[test]
    fn a_missing_hook_file_is_not_treated_as_a_hook() {
        let missing = std::env::temp_dir().join("octiq-hook-test-does-not-exist/notify-hook");
        // Spawn fails; the alert survives.
        assert_eq!(filter_with(Some(missing), alert()), Some(alert()));
    }
}
