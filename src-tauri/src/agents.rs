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
// ponytail: shells out to `ps` instead of linking a process-info crate — one
// command, one parse, Unix only. Windows gets an empty list until someone needs
// it.
use crate::proc::no_console;
use crate::pty::PtyManager;
use serde::Serialize;
use std::collections::HashMap;
use std::process::Command;
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
    let name = argv0.rsplit('/').next()?;
    match name {
        "claude" | "codex" => Some(name.to_string()),
        _ => None,
    }
}

/// Seconds from a `ps` etime field: `MM:SS`, `HH:MM:SS`, or `DD-HH:MM:SS`.
/// An unparsable field yields 0 (shown as an unknown age, never a crash).
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

#[cfg(not(unix))]
fn snapshot() -> HashMap<i32, Proc> {
    HashMap::new()
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
    let mut cmd = Command::new("kill");
    cmd.args(["-TERM", &pid.to_string()]);
    no_console(&mut cmd);
    let out = cmd.output().map_err(|e| e.to_string())?;
    if out.status.success() {
        Ok(())
    } else {
        Err(String::from_utf8_lossy(&out.stderr).trim().to_string())
    }
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
