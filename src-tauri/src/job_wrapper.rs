//! `octiq-job`: run one long command and tell the chat how far it has got
//! (`docs/jobs.md`).
//!
//! ```text
//! octiq-job [--label L] [--format auto|ffmpeg|cargo|remotion|nm|percent]
//!           [--progress-file P] [--no-wake] -- <cmd> [args…]
//! ```
//!
//! The command is started directly, never through a shell. Both of its
//! streams are passed on unchanged, byte for byte, and also read: each line
//! (and each piece a `\r` rewrites) goes through `job_progress`, and the last
//! lines are kept for the turn that wakes the agent when the job ends. A
//! termination signal the wrapper receives is handed on to the command, and
//! the wrapper exits with the command's own code (128 + the signal when a
//! signal ended it).
//!
//! It speaks to the host over the chat's hook port with the capability the
//! agent's environment already carries (`OCTIQ_HOOK_PORT`,
//! `OCTIQ_CHAT_CAPABILITY`, and the session the capability was issued to).
//! The start is the only call that needs the capability: the host answers it
//! with the job's id and a token of its own, which carry the progress and the
//! end, so a job outlives the agent process that started it. With no such
//! environment the command is run and nothing is reported, and a host that
//! cannot be reached never fails the command.
//!
//! The same code runs as the `octiq-job` binary and as `octiq-server job`,
//! which is what agents reach through `OCTIQ_JOB` (`chat_jobs::launcher`).

use crate::job_progress::{progress_file, Format, Parser, Progress, Splitter, Tail};
use serde_json::{json, Value};
use std::io::{Read, Write};
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{mpsc, Arc, Mutex};
use std::time::{Duration, Instant};

/// How many lines of output the end report carries for the wake turn.
pub const TAIL_LINES: usize = 20;
/// The least time between two progress reports of one job: at most 2 a second.
const REPORT_EVERY: Duration = Duration::from_millis(500);
/// How long a call to the host may take before it is given up.
const HOST_TIMEOUT: Duration = Duration::from_secs(3);

#[derive(Debug, PartialEq)]
pub(crate) struct Options {
    pub label: Option<String>,
    pub format: Format,
    pub progress_file: Option<String>,
    pub wake: bool,
    pub command: Vec<String>,
}

pub(crate) enum Parsed {
    Run(Options),
    Help,
}

pub(crate) fn parse_args(args: &[String]) -> Result<Parsed, String> {
    let mut options = Options {
        label: None,
        format: Format::Auto,
        progress_file: None,
        wake: true,
        command: Vec::new(),
    };
    let mut i = 0;
    while i < args.len() {
        let arg = args[i].as_str();
        let value = |i: usize| {
            args.get(i + 1)
                .cloned()
                .ok_or_else(|| format!("{arg} needs a value"))
        };
        match arg {
            "--" => {
                options.command = args[i + 1..].to_vec();
                break;
            }
            "-h" | "--help" => return Ok(Parsed::Help),
            "--label" | "-l" => {
                options.label = Some(value(i)?);
                i += 2;
            }
            "--format" | "-f" => {
                options.format = Format::parse(&value(i)?)?;
                i += 2;
            }
            "--progress-file" | "-p" => {
                options.progress_file = Some(value(i)?);
                i += 2;
            }
            "--no-wake" => {
                options.wake = false;
                i += 1;
            }
            _ if arg.starts_with('-') => return Err(format!("unknown option {arg}")),
            // The command, without a `--` before it.
            _ => {
                options.command = args[i..].to_vec();
                break;
            }
        }
    }
    if options.command.is_empty() {
        return Err("no command to run: put it after --".into());
    }
    Ok(Parsed::Run(options))
}

pub(crate) const HELP: &str = "\
octiq-job - run a long command and show its progress in its OctiqFlow chat

USAGE:
    octiq-job [--label L] [--format F] [--progress-file P] [--no-wake] -- <cmd> [args...]

OPTIONS:
    -l, --label <L>          What the chat calls the job (default: the command).
    -f, --format <F>         How to read progress from the output: auto (default),
                             ffmpeg, cargo, remotion, nm (N/M), percent (NN%).
    -p, --progress-file <P>  A JSON file the job rewrites whole:
                             {\"done\":3,\"total\":8,\"phase\":\"Generating\"}
        --no-wake            Do not wake the chat's agent when the job ends.
    -h, --help               Show this help.

The command runs directly (no shell), its output passes through unchanged,
and octiq-job exits with its exit code. Outside an OctiqFlow chat it only
runs the command.
";

/// The command line as the page shows it: each argument that needs quoting
/// in single quotes.
pub(crate) fn display_command(command: &[String]) -> String {
    let shown: Vec<String> = command
        .iter()
        .map(|arg| {
            if !arg.is_empty()
                && arg
                    .chars()
                    .all(|c| c.is_alphanumeric() || "-_./:=@%+,".contains(c))
            {
                arg.clone()
            } else {
                format!("'{}'", arg.replace('\'', "'\\''"))
            }
        })
        .collect();
    shown.join(" ")
}

/// The variables cargo needs to draw its bar into a pipe, for a cargo
/// command that has not set them itself.
pub(crate) fn cargo_env(
    format: Format,
    program: &str,
    has: &dyn Fn(&str) -> bool,
) -> Vec<(&'static str, &'static str)> {
    let stem = std::path::Path::new(program)
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or_default();
    if !(format == Format::Cargo || (format == Format::Auto && stem == "cargo")) {
        return Vec::new();
    }
    [
        ("CARGO_TERM_PROGRESS_WHEN", "always"),
        ("CARGO_TERM_PROGRESS_WIDTH", "80"),
    ]
    .into_iter()
    .filter(|(name, _)| !has(name))
    .collect()
}

/// Where the host is, from the agent's environment. `None` when this is not
/// an OctiqFlow chat.
pub(crate) struct Host {
    agent: ureq::Agent,
    url: String,
    capability: String,
    session: String,
}

impl Host {
    pub(crate) fn from_env(get: &dyn Fn(&str) -> Option<String>) -> Option<Self> {
        let port: u16 = get("OCTIQ_HOOK_PORT")?.trim().parse().ok()?;
        let capability = get("OCTIQ_CHAT_CAPABILITY").filter(|c| !c.is_empty())?;
        // Codex hides variables whose name says KEY from the commands it
        // runs, so the host also hands the session over as OCTIQ_JOB_SESSION.
        let session = ["OCTIQ_JOB_SESSION", "OCTIQ_SESSION_KEY", "OCTIQ_CHAT_KEY"]
            .into_iter()
            .find_map(|name| get(name).filter(|v| !v.is_empty()))?;
        Some(Self {
            agent: ureq::AgentBuilder::new().timeout(HOST_TIMEOUT).build(),
            url: format!("http://127.0.0.1:{port}/hook/job"),
            capability,
            session,
        })
    }

    fn call(&self, action: &str, args: Value) -> Result<Value, String> {
        let body = json!({ "sessionKey": self.session, "action": action, "args": args });
        let answer = self
            .agent
            .post(&self.url)
            .set("x-octiq-chat-capability", &self.capability)
            .send_json(body);
        match answer {
            Ok(response) => {
                let value: Value = response.into_json().map_err(|e| e.to_string())?;
                Ok(value.get("result").cloned().unwrap_or(Value::Null))
            }
            Err(ureq::Error::Status(_, response)) => {
                let value: Value = response.into_json().unwrap_or(Value::Null);
                Err(value["error"]
                    .as_str()
                    .unwrap_or("the host refused the call")
                    .to_string())
            }
            Err(error) => Err(error.to_string()),
        }
    }
}

/// The job as the host knows it: its id and the token that carries its
/// progress and its end.
struct Registered {
    id: String,
    token: String,
}

/// What the readers of the two streams and the progress file share.
struct Shared {
    parser: Parser,
    tail: Tail,
    progress: Option<Progress>,
    /// Changed since it was last reported.
    dirty: bool,
    /// The progress file speaks for the job; the output does not.
    from_file: bool,
}

/// Run `octiq-job` with these arguments (the program name not among them),
/// and answer the exit code.
pub fn main(args: Vec<String>) -> i32 {
    let options = match parse_args(&args) {
        Ok(Parsed::Run(options)) => options,
        Ok(Parsed::Help) => {
            print!("{HELP}");
            return 0;
        }
        Err(why) => {
            eprintln!("octiq-job: {why}");
            eprint!("{HELP}");
            return 2;
        }
    };
    run(options, Host::from_env(&|name| std::env::var(name).ok()))
}

fn run(options: Options, host: Option<Host>) -> i32 {
    let program = resolve_program(&options.command[0]);
    let mut command = Command::new(&program);
    command
        .args(&options.command[1..])
        .stdin(Stdio::inherit())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    for (name, value) in cargo_env(options.format, &options.command[0], &|name| {
        std::env::var_os(name).is_some()
    }) {
        command.env(name, value);
    }
    signals::install();
    let mut child = match command.spawn() {
        Ok(child) => child,
        Err(error) => {
            eprintln!("octiq-job: could not start {}: {error}", options.command[0]);
            return if error.kind() == std::io::ErrorKind::NotFound {
                127
            } else {
                126
            };
        }
    };
    let shown = display_command(&options.command);
    let label = options
        .label
        .clone()
        .filter(|label| !label.trim().is_empty())
        .unwrap_or_else(|| shown.chars().take(80).collect());
    let job = host.as_ref().and_then(|host| {
        let answer = host.call(
            "start",
            json!({
                "label": label,
                "command": shown,
                "wake": options.wake,
                "wrapperPid": std::process::id(),
                "childPid": child.id(),
            }),
        );
        match answer {
            Ok(value) => Some(Registered {
                id: value["id"].as_str()?.to_string(),
                token: value["token"].as_str()?.to_string(),
            }),
            Err(why) => {
                eprintln!(
                    "octiq-job: the chat was not told of this job ({why}); running it anyway"
                );
                None
            }
        }
    });

    let shared = Arc::new(Mutex::new(Shared {
        parser: Parser::new(options.format),
        tail: Tail::new(TAIL_LINES),
        progress: None,
        dirty: false,
        from_file: options.progress_file.is_some(),
    }));
    let (done_tx, done_rx) = mpsc::channel::<()>();
    let stdout = child
        .stdout
        .take()
        .map(|out| pass_on(out, std::io::stdout(), shared.clone(), done_tx.clone()));
    let stderr = child
        .stderr
        .take()
        .map(|err| pass_on(err, std::io::stderr(), shared.clone(), done_tx.clone()));
    drop(done_tx);
    let readers = usize::from(stdout.is_some()) + usize::from(stderr.is_some());
    let finished = Arc::new(AtomicBool::new(false));
    if let Some(path) = options.progress_file.clone() {
        watch_file(path, shared.clone(), finished.clone());
    }
    let host = host.map(Arc::new);
    let reporter = match (&host, &job) {
        (Some(host), Some(job)) => {
            let host = host.clone();
            let (id, token) = (job.id.clone(), job.token.clone());
            let (shared, finished) = (shared.clone(), finished.clone());
            Some(std::thread::spawn(move || {
                while !finished.load(Ordering::SeqCst) {
                    std::thread::sleep(REPORT_EVERY);
                    report_progress(&host, &id, &token, &shared);
                }
            }))
        }
        _ => None,
    };

    // Wait for the command, handing on any signal meanwhile.
    let status = loop {
        if let Some(signal) = signals::take() {
            signals::forward(child.id(), signal);
        }
        match child.try_wait() {
            Ok(Some(status)) => break Some(status),
            Ok(None) => std::thread::sleep(Duration::from_millis(50)),
            Err(error) => {
                eprintln!("octiq-job: could not wait for the command: {error}");
                break None;
            }
        }
    };
    // Its output to the last byte, unless something it started still holds
    // the pipes open: then what was read is enough.
    let deadline = Instant::now() + Duration::from_secs(2);
    for _ in 0..readers {
        let left = deadline.saturating_duration_since(Instant::now());
        if done_rx.recv_timeout(left).is_err() {
            break;
        }
    }
    finished.store(true, Ordering::SeqCst);
    if let Some(reporter) = reporter {
        let _ = reporter.join();
    }
    let (exit_code, signal) = describe(status.as_ref());
    if let (Some(host), Some(job)) = (&host, &job) {
        report_progress(host, &job.id, &job.token, &shared);
        let tail = shared
            .lock()
            .map(|shared| shared.tail.lines())
            .unwrap_or_default();
        if let Err(why) = host.call(
            "end",
            json!({
                "id": job.id, "token": job.token,
                "exitCode": exit_code, "signal": signal, "tail": tail,
            }),
        ) {
            eprintln!("octiq-job: the chat was not told how the job ended ({why})");
        }
    }
    match (exit_code, signal) {
        (Some(code), _) => code,
        (None, Some(signal)) => 128 + signal,
        (None, None) => 1,
    }
}

/// The exit code, or the signal that ended the command.
fn describe(status: Option<&std::process::ExitStatus>) -> (Option<i32>, Option<i32>) {
    let Some(status) = status else {
        return (None, None);
    };
    #[cfg(unix)]
    {
        use std::os::unix::process::ExitStatusExt;
        if let Some(signal) = status.signal() {
            return (None, Some(signal));
        }
    }
    (status.code(), None)
}

/// Copy one of the command's streams to ours unchanged, and read it.
fn pass_on(
    mut from: impl Read + Send + 'static,
    mut to: impl Write + Send + 'static,
    shared: Arc<Mutex<Shared>>,
    done: mpsc::Sender<()>,
) -> std::thread::JoinHandle<()> {
    std::thread::spawn(move || {
        let mut splitter = Splitter::default();
        let mut buffer = [0u8; 16 * 1024];
        // A reader that has gone away (the agent closed its end) is not a
        // reason to stop reading: the command would block on a full pipe.
        let mut passing = true;
        loop {
            let read = match from.read(&mut buffer) {
                Ok(0) => break,
                Ok(read) => read,
                Err(error) if error.kind() == std::io::ErrorKind::Interrupted => continue,
                Err(_) => break,
            };
            let bytes = &buffer[..read];
            if passing && to.write_all(bytes).and_then(|()| to.flush()).is_err() {
                passing = false;
            }
            let segments = splitter.feed(bytes);
            take_in(&shared, &segments);
        }
        if let Some(last) = splitter.finish() {
            take_in(&shared, &[last]);
        }
        let _ = done.send(());
    })
}

fn take_in(shared: &Mutex<Shared>, segments: &[crate::job_progress::Segment]) {
    let Ok(mut shared) = shared.lock() else {
        return;
    };
    for segment in segments {
        shared.tail.push(segment);
        if shared.from_file {
            continue;
        }
        if let Some(progress) = shared.parser.line(&segment.text) {
            if shared.progress.as_ref() != Some(&progress) {
                shared.progress = Some(progress);
                shared.dirty = true;
            }
        }
    }
}

/// Read the progress file whenever it changes, until the job is over.
fn watch_file(path: String, shared: Arc<Mutex<Shared>>, finished: Arc<AtomicBool>) {
    std::thread::spawn(move || {
        let mut last_text = String::new();
        while !finished.load(Ordering::SeqCst) {
            if let Ok(text) = std::fs::read_to_string(&path) {
                if text != last_text {
                    if let Some(progress) = progress_file(&text) {
                        if let Ok(mut shared) = shared.lock() {
                            shared.progress = Some(progress);
                            shared.dirty = true;
                        }
                    }
                    last_text = text;
                }
            }
            std::thread::sleep(Duration::from_millis(250));
        }
    });
}

fn report_progress(host: &Host, id: &str, token: &str, shared: &Mutex<Shared>) {
    let progress = {
        let Ok(mut shared) = shared.lock() else {
            return;
        };
        if !shared.dirty {
            return;
        }
        shared.dirty = false;
        shared.progress.clone()
    };
    let Some(progress) = progress else { return };
    let mut args = serde_json::to_value(&progress).unwrap_or_else(|_| json!({}));
    args["id"] = json!(id);
    args["token"] = json!(token);
    // A progress report that does not arrive is replaced by the next one.
    let _ = host.call("progress", args);
}

/// The program to start. On Windows a bare name is looked up with the
/// extensions `PATHEXT` names, so `npx` finds `npx.cmd`, which `Command`
/// alone does not.
fn resolve_program(program: &str) -> String {
    if !cfg!(windows) {
        return program.to_string();
    }
    windows_program(
        program,
        std::env::var("PATH").ok().as_deref(),
        std::env::var("PATHEXT").ok().as_deref(),
        &|candidate| std::path::Path::new(candidate).is_file(),
    )
    .unwrap_or_else(|| program.to_string())
}

/// `resolve_program`'s search, apart from the machine so it is testable.
pub(crate) fn windows_program(
    program: &str,
    path: Option<&str>,
    pathext: Option<&str>,
    exists: &dyn Fn(&str) -> bool,
) -> Option<String> {
    let has_dir = program.contains('/') || program.contains('\\');
    let has_ext = std::path::Path::new(program).extension().is_some();
    let exts: Vec<String> = pathext
        .unwrap_or(".COM;.EXE;.BAT;.CMD")
        .split(';')
        .filter(|e| !e.is_empty())
        .map(str::to_ascii_lowercase)
        .collect();
    let candidates = |base: &str| -> Vec<String> {
        if has_ext {
            vec![base.to_string()]
        } else {
            exts.iter().map(|ext| format!("{base}{ext}")).collect()
        }
    };
    if has_dir {
        return candidates(program).into_iter().find(|c| exists(c));
    }
    for dir in path
        .unwrap_or_default()
        .split(';')
        .map(|dir| dir.trim_end_matches(['/', '\\']))
        .filter(|dir| !dir.is_empty())
    {
        if let Some(found) = candidates(&format!("{dir}\\{program}"))
            .into_iter()
            .find(|c| exists(c))
        {
            return Some(found);
        }
    }
    None
}

#[cfg(unix)]
mod signals {
    use std::sync::atomic::{AtomicI32, Ordering};

    static PENDING: AtomicI32 = AtomicI32::new(0);

    extern "C" fn note(signal: libc::c_int) {
        PENDING.store(signal, Ordering::SeqCst);
    }

    /// Hold the signals that end a process, so the wrapper lives to hand
    /// them on and to report how the command ended.
    pub fn install() {
        for signal in [libc::SIGINT, libc::SIGTERM, libc::SIGHUP, libc::SIGQUIT] {
            // SAFETY: the handler only stores into an atomic, which is
            // async-signal-safe.
            unsafe {
                libc::signal(
                    signal,
                    note as extern "C" fn(libc::c_int) as libc::sighandler_t,
                );
            }
        }
    }

    pub fn take() -> Option<i32> {
        let signal = PENDING.swap(0, Ordering::SeqCst);
        (signal != 0).then_some(signal)
    }

    pub fn forward(pid: u32, signal: i32) {
        // SAFETY: sends a signal to the child this process started.
        unsafe {
            libc::kill(pid as libc::pid_t, signal);
        }
    }
}

/// Windows has no signals to hand on: a console's Ctrl-C reaches the command
/// as it reaches the wrapper.
#[cfg(not(unix))]
mod signals {
    pub fn install() {}
    pub fn take() -> Option<i32> {
        None
    }
    pub fn forward(_pid: u32, _signal: i32) {}
}

#[cfg(test)]
mod tests {
    use super::*;

    fn args(list: &[&str]) -> Vec<String> {
        list.iter().map(|s| s.to_string()).collect()
    }

    fn options(list: &[&str]) -> Options {
        match parse_args(&args(list)).unwrap() {
            Parsed::Run(options) => options,
            Parsed::Help => panic!("help"),
        }
    }

    #[test]
    fn options_come_before_the_command() {
        let o = options(&[
            "--label",
            "render",
            "--format",
            "remotion",
            "--progress-file",
            "p.json",
            "--no-wake",
            "--",
            "npx",
            "remotion",
            "--label",
            "x",
        ]);
        assert_eq!(o.label.as_deref(), Some("render"));
        assert_eq!(o.format, Format::Remotion);
        assert_eq!(o.progress_file.as_deref(), Some("p.json"));
        assert!(!o.wake);
        assert_eq!(o.command, args(&["npx", "remotion", "--label", "x"]));
        assert_eq!(
            options(&["cargo", "build"]).command,
            args(&["cargo", "build"])
        );
        assert!(options(&["--", "x"]).wake);
        for bad in [
            &["--"][..],
            &[],
            &["--label"],
            &["--format", "x264", "--", "a"],
            &["--what", "--", "a"],
        ] {
            assert!(parse_args(&args(bad)).is_err(), "{bad:?}");
        }
        assert!(matches!(parse_args(&args(&["-h"])), Ok(Parsed::Help)));
    }

    #[test]
    fn a_command_is_shown_as_it_would_be_typed() {
        assert_eq!(
            display_command(&args(&["sh", "-c", "for i in 1 2; do echo \"$i/2\"; done"])),
            "sh -c 'for i in 1 2; do echo \"$i/2\"; done'"
        );
        assert_eq!(
            display_command(&args(&["a", "it's", ""])),
            "a 'it'\\''s' ''"
        );
    }

    #[test]
    fn cargo_is_asked_for_its_bar_unless_it_was_told_otherwise() {
        let none = |_: &str| false;
        assert_eq!(cargo_env(Format::Auto, "cargo", &none).len(), 2);
        assert_eq!(cargo_env(Format::Auto, "/x/bin/cargo", &none).len(), 2);
        assert_eq!(cargo_env(Format::Cargo, "cross", &none).len(), 2);
        assert!(cargo_env(Format::Auto, "ffmpeg", &none).is_empty());
        let set = |name: &str| name == "CARGO_TERM_PROGRESS_WHEN";
        assert_eq!(
            cargo_env(Format::Auto, "cargo", &set),
            [("CARGO_TERM_PROGRESS_WIDTH", "80")]
        );
    }

    #[test]
    fn the_host_is_found_in_the_agents_environment_or_not_at_all() {
        let env = |pairs: &'static [(&'static str, &'static str)]| {
            move |name: &str| {
                pairs
                    .iter()
                    .find(|(n, _)| *n == name)
                    .map(|(_, v)| v.to_string())
            }
        };
        let full = env(&[
            ("OCTIQ_HOOK_PORT", "1421"),
            ("OCTIQ_CHAT_CAPABILITY", "cap"),
            ("OCTIQ_JOB_SESSION", "chat:a"),
        ]);
        let host = Host::from_env(&full).unwrap();
        assert_eq!(host.url, "http://127.0.0.1:1421/hook/job");
        assert_eq!(host.session, "chat:a");
        // Codex hid the session's KEY variables; the session is still known.
        let codex = env(&[
            ("OCTIQ_HOOK_PORT", "1421"),
            ("OCTIQ_CHAT_CAPABILITY", "cap"),
            ("OCTIQ_CHAT_KEY", "chat:b"),
        ]);
        assert_eq!(Host::from_env(&codex).unwrap().session, "chat:b");
        for missing in [
            env(&[
                ("OCTIQ_CHAT_CAPABILITY", "cap"),
                ("OCTIQ_CHAT_KEY", "chat:a"),
            ]),
            env(&[("OCTIQ_HOOK_PORT", "1421"), ("OCTIQ_CHAT_KEY", "chat:a")]),
            env(&[
                ("OCTIQ_HOOK_PORT", "x"),
                ("OCTIQ_CHAT_CAPABILITY", "c"),
                ("OCTIQ_CHAT_KEY", "k"),
            ]),
            env(&[
                ("OCTIQ_HOOK_PORT", "1421"),
                ("OCTIQ_CHAT_CAPABILITY", "cap"),
            ]),
        ] {
            assert!(Host::from_env(&missing).is_none());
        }
    }

    #[test]
    fn windows_finds_a_cmd_shim_by_pathext() {
        let exists = |c: &str| c == "C:\\node\\npx.cmd" || c == "C:\\bin\\tool.exe";
        let path = Some("C:\\Windows;C:\\node\\");
        assert_eq!(
            windows_program("npx", path, Some(".COM;.EXE;.BAT;.CMD"), &exists).as_deref(),
            Some("C:\\node\\npx.cmd")
        );
        assert_eq!(
            windows_program("npx", path, None, &exists).as_deref(),
            Some("C:\\node\\npx.cmd")
        );
        assert_eq!(
            windows_program("C:\\bin\\tool", None, None, &exists).as_deref(),
            Some("C:\\bin\\tool.exe")
        );
        assert_eq!(windows_program("missing", path, None, &exists), None);
    }

    /// The command runs, its output passes through, and its exit code is
    /// the wrapper's, with no host to tell.
    #[cfg(unix)]
    #[test]
    fn with_no_host_the_command_runs_and_its_code_is_kept() {
        assert_eq!(
            run(options(&["--", "sh", "-c", "echo 1/2; exit 3"]), None),
            3
        );
        assert_eq!(
            run(options(&["--", "sh", "-c", "kill -TERM $$"]), None),
            128 + 15
        );
        assert_eq!(run(options(&["--", "no-such-program-here"]), None), 127);
    }
}
