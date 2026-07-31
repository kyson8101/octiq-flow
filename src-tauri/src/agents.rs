// Agent process overview: what each running agent (and its MCP servers) costs
// in RAM, and how old it is.
//
// Why this exists: every `claude` / `codex` session spawns its own fleet of MCP
// servers as CHILD processes. Leave a dozen old sessions open — in OctiqFlow
// tabs or anywhere else — and they quietly hold several GB. The tab strip shows
// only "an agent is here", never "this one has been idle for 4 days and is
// holding 900 MB", so nothing tells the user which tab to close.
//
// The signal is a single `ps` sweep: build the pid -> children tree, find the
// AGENT ROOTS (a process whose argv[0] basename is `claude`/`codex` and that has
// no agent ancestor — a `codex mcp` server under a `claude` is a child, not a
// session), then sum RSS over each root's subtree. That subtree sum IS the
// number the user cares about, because the MCP servers are where the memory went.
//
// Each root is matched back to the OctiqFlow terminal that owns it by walking its
// ancestors until one of them is a live PTY's shell pid. A root with no such
// ancestor is a stray started outside the app; it still shows (it is still eating
// the same RAM), just with no tab to jump to.
//
// ponytail: shells out instead of linking a process-info crate — one command,
// one parse. Unix reads `ps`; Windows reads the same five-field shape from
// PowerShell CIM (`Get-CimInstance Win32_Process`, see the Windows `snapshot`).
// On Windows every session — the CLI, the VS Code agent, the browser host — is
// `claude.exe`, so the exact-basename check that hides the macOS Desktop app
// cannot separate them; the IDE/browser variants are filtered by command line
// instead (see `is_embedded_agent`) so the app never offers to kill your editor's
// own agent.
use crate::proc::no_console;
use crate::pty::PtyManager;
use serde::Serialize;
use std::collections::HashMap;
use std::process::Command;
use std::sync::Mutex;
use std::time::{Duration, Instant};
use tauri::State;

/// One running agent session, with everything it spawned folded in.
#[derive(Clone, Serialize)]
pub struct AgentProc {
    /// The agent process itself (what a kill targets).
    pub pid: i32,
    /// "claude" or "codex".
    pub kind: String,
    /// Resident memory of the agent AND every process under it (its MCP
    /// servers), in MB. RSS double-counts shared pages, so read it as a good
    /// estimate, not an exact figure.
    pub rss_mb: u64,
    /// How many processes that subtree holds (1 = the agent alone).
    pub procs: u32,
    /// Seconds since the agent process started — the "this is stale" signal.
    pub age_secs: u64,
    /// The OctiqFlow terminal id running it, or None when it was started outside
    /// the app.
    pub term_id: Option<String>,
}

/// One row of the `ps` sweep.
struct Proc {
    ppid: i32,
    rss_kb: u64,
    age_secs: u64,
    /// Some("claude"/"codex") when this process IS an agent binary.
    kind: Option<String>,
}

/// The agent kind a command line names, if any. `argv[0]`'s file name must be
/// exactly `claude` or `codex`: the Claude DESKTOP app's processes also carry
/// "claude" in their path (`/Applications/Claude.app/...`), and a loose
/// substring match would list every Electron helper it runs as an agent.
fn agent_kind(command: &str) -> Option<String> {
    let argv0 = command.split_whitespace().next()?;
    // Windows CommandLine wraps the exe path in quotes ("C:\...\claude.exe");
    // strip them so the basename is clean.
    let argv0 = argv0.trim_matches('"');
    // basename after either separator — Unix `/` or Windows `\`.
    let name = argv0.rsplit(['/', '\\']).next()?;
    // A Windows executable/script carries an extension the bare name does not.
    let name = name
        .strip_suffix(".exe")
        .or_else(|| name.strip_suffix(".cmd"))
        .or_else(|| name.strip_suffix(".bat"))
        .or_else(|| name.strip_suffix(".ps1"))
        .unwrap_or(name);
    match name {
        "claude" | "codex" => Some(name.to_string()),
        _ => None,
    }
}

/// Seconds from a `ps` etime field: `MM:SS`, `HH:MM:SS`, or `DD-HH:MM:SS`.
/// An unparsable field yields 0 (shown as an unknown age, never a crash).
/// Unix-only: Windows reads age straight from CIM as seconds, so this is unused
/// there (still compiled for the shared test suite).
#[cfg_attr(not(unix), allow(dead_code))]
fn parse_etime(etime: &str) -> u64 {
    let (days, clock) = match etime.split_once('-') {
        Some((d, rest)) => (d.parse::<u64>().unwrap_or(0), rest),
        None => (0, etime),
    };
    let mut secs = 0u64;
    for part in clock.split(':') {
        secs = secs * 60 + part.parse::<u64>().unwrap_or(0);
    }
    days * 86_400 + secs
}

/// Snapshot every process: pid -> its parent, memory, age, and agent kind.
#[cfg(unix)]
fn snapshot() -> HashMap<i32, Proc> {
    let mut cmd = Command::new("ps");
    cmd.args(["-axo", "pid=,ppid=,rss=,etime=,command="]);
    no_console(&mut cmd);
    let Ok(out) = cmd.output() else {
        return HashMap::new();
    };
    let text = String::from_utf8_lossy(&out.stdout);
    let mut procs = HashMap::new();
    for line in text.lines() {
        // pid ppid rss etime command... — the command holds spaces, so split off
        // the four fixed fields and keep the rest whole.
        let mut fields = line.split_whitespace();
        let (Some(pid), Some(ppid), Some(rss), Some(etime)) =
            (fields.next(), fields.next(), fields.next(), fields.next())
        else {
            continue;
        };
        let command = fields.collect::<Vec<_>>().join(" ");
        let (Ok(pid), Ok(ppid), Ok(rss_kb)) = (pid.parse(), ppid.parse(), rss.parse()) else {
            continue;
        };
        procs.insert(
            pid,
            Proc {
                ppid,
                rss_kb,
                age_secs: parse_etime(etime),
                kind: agent_kind(&command),
            },
        );
    }
    procs
}

// Windows has no `ps`, so shell out to PowerShell and read the process table
// through CIM (`Get-CimInstance Win32_Process`). One line per process, four
// fixed fields then the command line — the same shape the Unix parser expects.
// Age is computed in PowerShell from CreationDate so Rust never parses a date.
// The script is passed as a UTF-16 `-EncodedCommand` (base64) so its inner
// quotes and backtick-escapes survive Windows argument quoting untouched.
#[cfg(windows)]
fn snapshot() -> HashMap<i32, Proc> {
    use base64::Engine;
    const SCRIPT: &str = "[Console]::OutputEncoding=[System.Text.Encoding]::UTF8;\
Get-CimInstance Win32_Process|ForEach-Object{\
$a=0;if($_.CreationDate){$a=[int]((Get-Date)-$_.CreationDate).TotalSeconds};\
$c=$_.CommandLine;if(-not $c){$c=$_.Name};\
\"$($_.ProcessId)`t$($_.ParentProcessId)`t$($_.WorkingSetSize)`t$a`t$c\"}";
    let utf16: Vec<u8> = SCRIPT.encode_utf16().flat_map(u16::to_le_bytes).collect();
    let encoded = base64::engine::general_purpose::STANDARD.encode(utf16);

    let mut cmd = Command::new("powershell.exe");
    cmd.args(["-NoProfile", "-NonInteractive", "-EncodedCommand", &encoded]);
    no_console(&mut cmd);
    let Ok(out) = cmd.output() else {
        return HashMap::new();
    };
    let text = String::from_utf8_lossy(&out.stdout);
    let mut procs = HashMap::new();
    for line in text.lines() {
        if let Some((pid, proc)) = parse_win_line(line) {
            procs.insert(pid, proc);
        }
    }
    procs
}

#[cfg(not(any(unix, windows)))]
fn snapshot() -> HashMap<i32, Proc> {
    HashMap::new()
}

/// A claude/codex process the app must NOT list as a killable session: an
/// IDE-embedded agent (VS Code / Cursor drive `claude` with the stream-json
/// I/O flags, from a `native-binary` path) or the browser native-messaging host.
/// On Windows every one of these is `claude.exe`, so the exact-basename check
/// that hides the macOS Desktop app cannot tell them apart — and killing the
/// editor's own agent from the Agents screen would be a nasty surprise. The
/// command line is the reliable signal, so filter on it before a process becomes
/// an agent root.
#[cfg_attr(not(windows), allow(dead_code))]
fn is_embedded_agent(command: &str) -> bool {
    command.contains("--chrome-native-host")
        || command.contains("--output-format stream-json")
        || command.contains("--input-format stream-json")
        || command.contains("native-binary")
}

/// Parse one line of the Windows CIM sweep — `pid \t ppid \t rssBytes \t
/// ageSecs \t commandLine` — into the same `Proc` the Unix path builds. The
/// command line is last and kept whole (it holds spaces and tabs of its own).
/// A line whose fixed fields do not parse (a header, a blank, a truncated row)
/// yields None and is skipped. An IDE/browser helper still parses — it belongs
/// in the tree so a real agent's RAM is complete — but its `kind` is cleared so
/// it can never be an agent root.
#[cfg_attr(not(windows), allow(dead_code))]
fn parse_win_line(line: &str) -> Option<(i32, Proc)> {
    let mut fields = line.splitn(5, '\t');
    let pid = fields.next()?.trim().parse().ok()?;
    let ppid = fields.next()?.trim().parse().ok()?;
    let rss_bytes = fields.next()?.trim().parse::<u64>().ok()?;
    let age_secs = fields.next()?.trim().parse().unwrap_or(0);
    let command = fields.next().unwrap_or("");
    let kind = agent_kind(command).filter(|_| !is_embedded_agent(command));
    Some((
        pid,
        Proc {
            ppid,
            rss_kb: rss_bytes / 1024,
            age_secs,
            kind,
        },
    ))
}

/// Whether any ancestor of `pid` is itself an agent — i.e. this process is part
/// of an agent's fleet (an MCP server) rather than a session of its own. The
/// walk is bounded by the process count, so a pid cycle cannot hang it.
fn has_agent_ancestor(pid: i32, procs: &HashMap<i32, Proc>) -> bool {
    let mut cur = procs.get(&pid).map(|p| p.ppid).unwrap_or(0);
    for _ in 0..procs.len() {
        let Some(p) = procs.get(&cur) else {
            return false;
        };
        if p.kind.is_some() {
            return true;
        }
        cur = p.ppid;
    }
    false
}

/// Total RSS (MB) and process count of `pid` plus everything under it.
fn subtree_cost(
    pid: i32,
    children: &HashMap<i32, Vec<i32>>,
    procs: &HashMap<i32, Proc>,
) -> (u64, u32) {
    let mut rss_kb = 0;
    let mut count = 0;
    let mut stack = vec![pid];
    while let Some(p) = stack.pop() {
        if let Some(proc) = procs.get(&p) {
            rss_kb += proc.rss_kb;
            count += 1;
        }
        if let Some(kids) = children.get(&p) {
            stack.extend(kids);
        }
    }
    (rss_kb / 1024, count)
}

/// The OctiqFlow terminal whose shell is an ancestor of `pid`, if any.
fn owning_terminal(
    pid: i32,
    procs: &HashMap<i32, Proc>,
    shells: &HashMap<i32, String>,
) -> Option<String> {
    let mut cur = pid;
    for _ in 0..procs.len() {
        let p = procs.get(&cur)?;
        if let Some(id) = shells.get(&p.ppid) {
            return Some(id.clone());
        }
        cur = p.ppid;
    }
    None
}

/// Every agent session running on this machine right now, biggest first.
fn collect(shells: HashMap<i32, String>) -> Vec<AgentProc> {
    let procs = snapshot();
    let mut children: HashMap<i32, Vec<i32>> = HashMap::new();
    for (pid, p) in &procs {
        children.entry(p.ppid).or_default().push(*pid);
    }

    let mut rows: Vec<AgentProc> = procs
        .iter()
        .filter_map(|(pid, p)| {
            let kind = p.kind.clone()?;
            if has_agent_ancestor(*pid, &procs) {
                return None; // an MCP server under an agent, not a session
            }
            let (rss_mb, count) = subtree_cost(*pid, &children, &procs);
            Some(AgentProc {
                pid: *pid,
                kind,
                rss_mb,
                procs: count,
                age_secs: p.age_secs,
                term_id: owning_terminal(*pid, &procs, &shells),
            })
        })
        .collect();
    rows.sort_by(|a, b| b.rss_mb.cmp(&a.rss_mb));
    rows
}

/// List every running agent session with its RAM, process count, age, and the
/// OctiqFlow terminal that owns it (when it has one).
#[tauri::command]
pub fn agent_procs(manager: State<PtyManager>) -> Vec<AgentProc> {
    collect(manager.shell_pids())
}

/// Kill one agent session: SIGTERM the agent, which takes its MCP servers with
/// it. The pid MUST still be a live agent root — the frontend hands us a pid
/// from a snapshot that may be seconds stale, and by now that pid could belong
/// to an unrelated process. Re-deriving the roots here means this command can
/// only ever kill an agent, never an arbitrary pid.
///
/// The terminal itself is left alone: its shell stays, the tab stays, and the
/// scrollback stays. Only the agent (and its fleet) goes.
#[tauri::command]
pub fn agent_kill(manager: State<PtyManager>, pid: i32) -> Result<(), String> {
    if !collect(manager.shell_pids()).iter().any(|a| a.pid == pid) {
        return Err(format!("pid {pid} is not a running agent"));
    }
    let mut cmd = kill_command(pid);
    no_console(&mut cmd);
    let out = cmd.output().map_err(|e| e.to_string())?;
    if out.status.success() {
        Ok(())
    } else {
        Err(String::from_utf8_lossy(&out.stderr).trim().to_string())
    }
}

/// SIGTERM the agent so it tears its own MCP fleet down with it.
#[cfg(unix)]
fn kill_command(pid: i32) -> Command {
    let mut cmd = Command::new("kill");
    cmd.args(["-TERM", &pid.to_string()]);
    cmd
}

/// `taskkill /T` kills the whole process tree, so the MCP servers (which hang
/// off the agent through intermediate `cmd.exe` / `npx` hops on Windows) go with
/// it — the same net effect as the Unix SIGTERM-takes-the-fleet path.
#[cfg(windows)]
fn kill_command(pid: i32) -> Command {
    let mut cmd = Command::new("taskkill");
    cmd.args(["/PID", &pid.to_string(), "/T", "/F"]);
    cmd
}

#[cfg(not(any(unix, windows)))]
fn kill_command(pid: i32) -> Command {
    let mut cmd = Command::new("kill");
    cmd.args(["-TERM", &pid.to_string()]);
    cmd
}

// ---- Which agents can this machine launch? ---------------------------------
//
// The terminal add-menu offers a row per agent. Offering "Codex" on a machine
// with no `codex` installed just produces a tab printing "command not found",
// so the menu asks here first and hides the rows that would fail.
//
// The probe must see the same PATH a spawned terminal sees. A GUI app does not
// inherit the interactive shell PATH (the same reason pty.rs spawns a LOGIN
// shell), so the check runs through the login shell too — otherwise an agent
// installed by a version manager would look missing.

/// Every agent the app knows how to launch, in menu order. A fixed compile-time
/// list: the frontend never supplies a name, so nothing user-typed is ever
/// interpolated into the probe script or a launch command.
pub const KNOWN_AGENTS: [&str; 2] = ["claude", "codex"];

/// How long a probe result is trusted before the login shell is asked again.
/// Installing an agent mid-session is rare, and a login shell costs a few
/// hundred milliseconds, so the menu reads the cache almost every time — but a
/// fresh install still shows up within a few minutes without a restart.
const AGENT_PROBE_TTL: Duration = Duration::from_secs(300);

/// Cached probe result: when it was taken, and what it found.
static AGENT_PROBE: Mutex<Option<(Instant, Vec<String>)>> = Mutex::new(None);

/// The agents this machine can actually launch, in `KNOWN_AGENTS` order.
///
/// Fails OPEN: if the probe cannot run at all (no shell, spawn error), every
/// known agent is returned. These rows are a convenience, and a menu that
/// silently loses both agents is far worse than one offering an agent that
/// turns out to be missing.
#[tauri::command]
pub fn available_agents() -> Vec<String> {
    if let Ok(cache) = AGENT_PROBE.lock() {
        if let Some((at, found)) = cache.as_ref() {
            if at.elapsed() < AGENT_PROBE_TTL {
                return found.clone();
            }
        }
    }
    let found = probe_agents();
    if let Ok(mut cache) = AGENT_PROBE.lock() {
        *cache = Some((Instant::now(), found.clone()));
    }
    found
}

/// Run the probe through a login shell and read back the names it found.
fn probe_agents() -> Vec<String> {
    let mut cmd = probe_command();
    no_console(&mut cmd);
    match cmd.output() {
        Ok(out) => parse_probe_output(&String::from_utf8_lossy(&out.stdout)),
        // Could not even start a shell — fail open (see available_agents).
        Err(_) => KNOWN_AGENTS.iter().map(|a| a.to_string()).collect(),
    }
}

/// Keep only lines that name a known agent, in `KNOWN_AGENTS` order and without
/// duplicates. A login shell prints whatever the user's rc files print (banners,
/// version notices, fastfetch), so the output is filtered against the fixed list
/// rather than trusted line by line.
fn parse_probe_output(stdout: &str) -> Vec<String> {
    let lines: Vec<&str> = stdout.lines().map(|l| l.trim()).collect();
    KNOWN_AGENTS
        .iter()
        .filter(|a| lines.iter().any(|l| l == *a))
        .map(|a| a.to_string())
        .collect()
}

/// Ask the user's LOGIN shell which agents resolve on its PATH, printing one
/// name per hit. One shell for both agents: starting a login shell is the
/// expensive part, and the loop inside it is free.
#[cfg(unix)]
fn probe_command() -> Command {
    let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/zsh".to_string());
    let script = format!(
        "for a in {}; do command -v \"$a\" >/dev/null 2>&1 && echo \"$a\"; done",
        KNOWN_AGENTS.join(" ")
    );
    let mut cmd = Command::new(shell);
    // `-l` populates PATH the way pty.rs does for a real terminal; `-c` runs
    // the script. Both are needed — `-c` alone would read the GUI PATH.
    cmd.args(["-lc", &script]);
    cmd
}

/// Windows has no login shell; PowerShell loading the user profile is the
/// equivalent step that fills PATH, so the profile is deliberately NOT skipped.
#[cfg(windows)]
fn probe_command() -> Command {
    let names = KNOWN_AGENTS
        .iter()
        .map(|a| format!("'{a}'"))
        .collect::<Vec<_>>()
        .join(",");
    let script = format!(
        "foreach ($a in {names}) {{ if (Get-Command $a -ErrorAction SilentlyContinue) {{ $a }} }}"
    );
    let mut cmd = Command::new("powershell.exe");
    cmd.args(["-NoLogo", "-Command", &script]);
    cmd
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Not a unit test — a hand-run probe against THIS machine's real process
    /// table, so the `ps` parse can be checked against what `ps` actually
    /// prints here. Ignored by default (its output depends on what is running).
    /// Run it with: cargo test -- --ignored --nocapture live_agents
    #[test]
    #[ignore]
    fn live_agents() {
        for a in collect(HashMap::new()) {
            println!(
                "{:>6} {:<7} {:>6} MB {:>3} procs {:>9}s",
                a.pid, a.kind, a.rss_mb, a.procs, a.age_secs
            );
        }
    }

    #[test]
    fn probe_output_keeps_only_known_agents_in_menu_order() {
        // A login shell prints the user's own banners around our echoes, and
        // may print them in any order. Only the known names survive, and they
        // come back in KNOWN_AGENTS order, not in the order the shell printed.
        let out = "Welcome to zsh!\ncodex\nnpm notice: update available\nclaude\n";
        assert_eq!(parse_probe_output(out), vec!["claude", "codex"]);
        // One installed agent.
        assert_eq!(parse_probe_output("claude\n"), vec!["claude"]);
        // Neither installed: banner noise alone yields nothing.
        assert!(parse_probe_output("some banner\n").is_empty());
        // A line that merely CONTAINS an agent name is not a hit.
        assert!(parse_probe_output("claude not found\n").is_empty());
    }

    #[test]
    fn agent_kind_reads_a_windows_exe_path() {
        // Windows CommandLine quotes the exe path and uses `\` separators; the
        // basename carries a `.exe` / `.cmd` extension. All must reduce to the
        // bare agent name.
        assert_eq!(
            agent_kind("\"C:\\Users\\Jink\\.local\\bin\\claude.exe\" --resume abc"),
            Some("claude".into())
        );
        assert_eq!(agent_kind("\"C:\\tools\\codex.cmd\""), Some("codex".into()));
        // A node-hosted MCP server on Windows is still not an agent session.
        assert_eq!(
            agent_kind("\"C:\\Program Files\\nodejs\\node.exe\" npx-cli.js"),
            None
        );
    }

    #[test]
    fn windows_ide_and_browser_helpers_are_not_sessions() {
        // The VS Code extension binary and the browser native-messaging host are
        // both `claude.exe` on Windows — killing them from the Agents screen would
        // take down the user's active editor agent, so they must be excluded.
        assert!(is_embedded_agent(
            "c:\\Users\\Jink\\.vscode\\extensions\\anthropic.claude-code\\native-binary\\claude.exe --output-format stream-json --verbose"
        ));
        assert!(is_embedded_agent(
            "\"C:\\Users\\Jink\\.local\\bin\\claude.exe\" --chrome-native-host"
        ));
        // A real interactive session is NOT a helper.
        assert!(!is_embedded_agent(
            "\"C:\\Users\\Jink\\.local\\bin\\claude.exe\" --resume 92669ab2"
        ));
        assert!(!is_embedded_agent(
            "\"C:\\Users\\Jink\\.local\\bin\\claude.exe\""
        ));
    }

    #[test]
    fn parse_win_line_reads_a_cim_row_and_folds_bytes_to_kb() {
        // pid \t ppid \t rssBytes \t ageSecs \t commandLine
        let line =
            "55816\t24588\t67846144\t567\t\"C:\\Users\\Jink\\.local\\bin\\claude.exe\" --resume e76de334";
        let (pid, proc) = parse_win_line(line).expect("row parses");
        assert_eq!(pid, 55816);
        assert_eq!(proc.ppid, 24588);
        assert_eq!(proc.rss_kb, 67_846_144 / 1024);
        assert_eq!(proc.age_secs, 567);
        assert_eq!(proc.kind.as_deref(), Some("claude"));
    }

    #[test]
    fn parse_win_line_keeps_the_ide_binary_as_a_process_but_not_an_agent() {
        // It counts toward the process tree (so a real agent's RAM is complete)
        // but must never become an agent ROOT.
        let line =
            "85212\t62520\t220237824\t230\tc:\\Users\\Jink\\.vscode\\extensions\\x\\native-binary\\claude.exe --output-format stream-json";
        let (_, proc) = parse_win_line(line).expect("row parses");
        assert!(proc.kind.is_none());
    }

    #[test]
    fn parse_win_line_skips_a_header_or_junk_line() {
        assert!(parse_win_line("").is_none());
        assert!(parse_win_line("not-a-number\tx\ty\tz\tcmd").is_none());
    }

    #[test]
    fn agent_kind_matches_the_cli_not_the_desktop_app() {
        assert_eq!(agent_kind("claude --resume abc"), Some("claude".into()));
        assert_eq!(agent_kind("/usr/local/bin/codex"), Some("codex".into()));
        // The desktop app and its helpers must NOT read as agent sessions.
        assert_eq!(
            agent_kind("/Applications/Claude.app/Contents/MacOS/Claude"),
            None
        );
        assert_eq!(agent_kind("npm exec @playwright/mcp@latest"), None);
        assert_eq!(agent_kind(""), None);
    }

    #[test]
    fn parse_etime_reads_every_ps_shape() {
        assert_eq!(parse_etime("12:56"), 776);
        assert_eq!(parse_etime("06:22:35"), 22_955);
        assert_eq!(parse_etime("04-03:55:45"), 4 * 86_400 + 14_145);
        assert_eq!(parse_etime("nonsense"), 0);
    }

    #[test]
    fn subtree_cost_folds_in_the_mcp_children() {
        // claude(10) -> mcp(11), mcp(12) -> nested(13); a sibling(20) is excluded.
        let procs = HashMap::from([
            (
                10,
                Proc {
                    ppid: 1,
                    rss_kb: 1024,
                    age_secs: 0,
                    kind: Some("claude".into()),
                },
            ),
            (
                11,
                Proc {
                    ppid: 10,
                    rss_kb: 2048,
                    age_secs: 0,
                    kind: None,
                },
            ),
            (
                12,
                Proc {
                    ppid: 10,
                    rss_kb: 1024,
                    age_secs: 0,
                    kind: None,
                },
            ),
            (
                13,
                Proc {
                    ppid: 12,
                    rss_kb: 1024,
                    age_secs: 0,
                    kind: None,
                },
            ),
            (
                20,
                Proc {
                    ppid: 1,
                    rss_kb: 9999,
                    age_secs: 0,
                    kind: None,
                },
            ),
        ]);
        let mut children: HashMap<i32, Vec<i32>> = HashMap::new();
        for (pid, p) in &procs {
            children.entry(p.ppid).or_default().push(*pid);
        }
        assert_eq!(subtree_cost(10, &children, &procs), (5, 4));
    }

    #[test]
    fn an_mcp_server_under_an_agent_is_not_a_session() {
        // `codex mcp` runs as a child of claude — it is fleet, not a session.
        let procs = HashMap::from([
            (
                10,
                Proc {
                    ppid: 1,
                    rss_kb: 0,
                    age_secs: 0,
                    kind: Some("claude".into()),
                },
            ),
            (
                11,
                Proc {
                    ppid: 10,
                    rss_kb: 0,
                    age_secs: 0,
                    kind: Some("codex".into()),
                },
            ),
        ]);
        assert!(!has_agent_ancestor(10, &procs));
        assert!(has_agent_ancestor(11, &procs));
    }

    #[test]
    fn owning_terminal_walks_up_to_the_pty_shell() {
        // shell(5) -> claude(10); shell 5 is OctiqFlow terminal "proj:1".
        let procs = HashMap::from([
            (
                5,
                Proc {
                    ppid: 1,
                    rss_kb: 0,
                    age_secs: 0,
                    kind: None,
                },
            ),
            (
                10,
                Proc {
                    ppid: 5,
                    rss_kb: 0,
                    age_secs: 0,
                    kind: Some("claude".into()),
                },
            ),
            (
                30,
                Proc {
                    ppid: 1,
                    rss_kb: 0,
                    age_secs: 0,
                    kind: Some("claude".into()),
                },
            ),
        ]);
        let shells = HashMap::from([(5, "proj:1".to_string())]);
        assert_eq!(owning_terminal(10, &procs, &shells), Some("proj:1".into()));
        assert_eq!(owning_terminal(30, &procs, &shells), None); // started outside the app
    }
}
