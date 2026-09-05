// What this app is actually holding in RAM, and which chat or terminal is
// holding it.
//
// Why a whole module for one number: `octiq-server` itself is ~40 MB and has
// never been the interesting part. Everything expensive hangs BELOW it — every
// chat is an agent plus its own private copy of every MCP server it starts
// (playwright, codegraph, a python server…), which is how one chat reaches
// ~480 MB and six of them reach nearly 4 GB with nothing on screen to say so.
// The sidebar shows which chats exist; it has never shown which one is the
// 450 MB one you have not spoken to since Tuesday.
//
// The measurement is one `ps` sweep and one walk:
//
//   1. Snapshot every process on the machine as pid -> (ppid, RSS).
//   2. Walk DOWN from THIS process. Everything under us is ours, by definition
//      — we spawned it — and nothing outside is, so a `claude` the person is
//      running in their own Terminal.app is correctly not counted.
//   3. Carry the nearest CLAIMED ancestor down the walk. A chat's session key
//      and a terminal's tab id each claim one pid (`ChatManager::chat_pids`,
//      `PtyManager::shell_pids`), so every process lands in the bucket of the
//      chat or tab that started it, however deep. What no claim covers is the
//      server itself.
//
// RSS double-counts pages two processes share, so the total reads high — treat
// it as "about this much", which is the only honest reading `ps` supports and
// is plenty for "which of these should I close".
//
// The sweep is CACHED for a few seconds because several browser tabs poll it at
// once (the same person keeps four open) and they should share one `ps`, not
// fork one each.
use crate::agent_chat::ChatManager;
use crate::proc::no_console;
use crate::pty::PtyManager;
use serde::Serialize;
use std::collections::HashMap;
use std::process::Command;
use std::sync::Mutex;
use std::time::{Duration, Instant};

/// How long one sweep is served to everybody who asks. Long enough that four
/// tabs polling on their own timers cost one `ps`; short enough that a chat you
/// just stopped is gone from the list by the time you look back at it.
const CACHE_TTL: Duration = Duration::from_secs(5);

static CACHE: Mutex<Option<(Instant, MemoryUsage)>> = Mutex::new(None);

/// One thing holding memory: a chat, a terminal tab, or the server itself.
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MemoryRow {
    /// "chat" | "terminal" | "server". The client turns the first two into a
    /// name by looking the id up in what it already has on screen; the backend
    /// does not know what a conversation is called and should not have to.
    pub kind: String,
    /// The chat's session key or the terminal's tab id. Empty for the server.
    pub id: String,
    /// Resident memory of that process and everything under it, in MB.
    pub mb: u64,
    /// How many processes that is (1 = the thing alone, nothing spawned).
    pub procs: u32,
}

/// The whole app's footprint, and where it went.
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MemoryUsage {
    /// Every process under this server, including this server, in MB.
    pub total_mb: u64,
    /// How many processes that total covers.
    pub procs: u32,
    /// Biggest first. Always at least the server's own row.
    pub rows: Vec<MemoryRow>,
}

/// One process, as the sweep sees it. Nothing else about it is needed — the
/// command line is deliberately not read, because who owns a process is
/// answered by the process TREE, not by what its argv looks like.
struct Proc {
    ppid: i32,
    rss_kb: u64,
}

/// The command: what this app holds right now, at most one `ps` per `CACHE_TTL`.
pub fn memory_usage(ptys: &PtyManager, chats: &ChatManager) -> MemoryUsage {
    if let Ok(cache) = CACHE.lock() {
        if let Some((at, usage)) = cache.as_ref() {
            if at.elapsed() < CACHE_TTL {
                return usage.clone();
            }
        }
    }

    let mut claimed: HashMap<i32, (String, String)> = HashMap::new();
    for (pid, key) in chats.chat_pids() {
        claimed.insert(pid, ("chat".to_string(), key));
    }
    // Terminals second: if a pid were somehow in both maps, the chat is the
    // truer owner — a chat's process is never a terminal's shell.
    for (pid, id) in ptys.shell_pids() {
        claimed.entry(pid).or_insert(("terminal".to_string(), id));
    }

    let usage = attribute(std::process::id() as i32, &snapshot(), &claimed);
    if let Ok(mut cache) = CACHE.lock() {
        *cache = Some((Instant::now(), usage.clone()));
    }
    usage
}

/// Walk down from `root`, charging every process to the nearest claimed
/// ancestor at or above it, and add up each bucket.
///
/// Pure, so the rule that matters — an MCP server three levels under a chat is
/// still THAT chat's memory — is testable without a process table.
///
/// The walk is bounded by the number of processes seen rather than by the tree
/// shape: `ps` is a snapshot taken over a moving table, so a pid whose parent
/// exited mid-sweep can be re-parented in a way that looks like a cycle, and a
/// visited set is what keeps that from spinning.
fn attribute(
    root: i32,
    procs: &HashMap<i32, Proc>,
    claimed: &HashMap<i32, (String, String)>,
) -> MemoryUsage {
    let mut children: HashMap<i32, Vec<i32>> = HashMap::new();
    for (pid, p) in procs {
        children.entry(p.ppid).or_default().push(*pid);
    }

    // (kind, id) -> (kb, process count). The server's own remainder is the
    // entry with no owner, so it needs no special case in the walk.
    let mut buckets: HashMap<Option<(String, String)>, (u64, u32)> = HashMap::new();
    let mut total_kb = 0u64;
    let mut total_procs = 0u32;
    let mut seen = std::collections::HashSet::new();

    let mut stack: Vec<(i32, Option<(String, String)>)> = vec![(root, None)];
    while let Some((pid, inherited)) = stack.pop() {
        if !seen.insert(pid) {
            continue;
        }
        // A pid claims for itself and for everything beneath it; anything not
        // claimed keeps whatever it inherited from above.
        let owner = claimed.get(&pid).cloned().or(inherited);
        if let Some(p) = procs.get(&pid) {
            total_kb += p.rss_kb;
            total_procs += 1;
            let slot = buckets.entry(owner.clone()).or_insert((0, 0));
            slot.0 += p.rss_kb;
            slot.1 += 1;
        }
        for kid in children.get(&pid).into_iter().flatten() {
            stack.push((*kid, owner.clone()));
        }
    }

    let mut rows: Vec<MemoryRow> = buckets
        .into_iter()
        .map(|(owner, (kb, procs))| {
            let (kind, id) = owner.unwrap_or_else(|| ("server".to_string(), String::new()));
            MemoryRow {
                kind,
                id,
                mb: kb / 1024,
                procs,
            }
        })
        .collect();
    // Biggest first, then by id so equal rows do not shuffle between polls —
    // a list that reorders under the pointer is unreadable.
    rows.sort_by(|a, b| b.mb.cmp(&a.mb).then_with(|| a.id.cmp(&b.id)));

    MemoryUsage {
        total_mb: total_kb / 1024,
        procs: total_procs,
        rows,
    }
}

/// Every process on the machine: pid -> parent and resident size.
#[cfg(unix)]
fn snapshot() -> HashMap<i32, Proc> {
    let mut cmd = Command::new("ps");
    cmd.args(["-axo", "pid=,ppid=,rss="]);
    no_console(&mut cmd);
    let Ok(out) = cmd.output() else {
        return HashMap::new();
    };
    parse_ps(&String::from_utf8_lossy(&out.stdout))
}

/// Windows has no `ps`; CIM answers the same three questions. The script is
/// written without a single double quote so it survives Windows argument
/// quoting as one `-Command` argument, with no base64 dance.
#[cfg(windows)]
fn snapshot() -> HashMap<i32, Proc> {
    const SCRIPT: &str = "Get-CimInstance Win32_Process|ForEach-Object{\
($_.ProcessId,$_.ParentProcessId,[int64]($_.WorkingSetSize/1024)) -join ' '}";
    let mut cmd = Command::new("powershell.exe");
    cmd.args(["-NoProfile", "-NonInteractive", "-Command", SCRIPT]);
    no_console(&mut cmd);
    let Ok(out) = cmd.output() else {
        return HashMap::new();
    };
    parse_ps(&String::from_utf8_lossy(&out.stdout))
}

#[cfg(not(any(unix, windows)))]
fn snapshot() -> HashMap<i32, Proc> {
    HashMap::new()
}

/// Three whitespace-separated numbers per line — pid, ppid, RSS in KB — which
/// is the shape both sweeps print. A line that does not parse (a header, a
/// blank, a truncated row) is skipped rather than guessed at.
fn parse_ps(text: &str) -> HashMap<i32, Proc> {
    let mut procs = HashMap::new();
    for line in text.lines() {
        let mut fields = line.split_whitespace();
        let (Some(pid), Some(ppid), Some(rss)) = (fields.next(), fields.next(), fields.next())
        else {
            continue;
        };
        let (Ok(pid), Ok(ppid), Ok(rss_kb)) = (pid.parse(), ppid.parse(), rss.parse()) else {
            continue;
        };
        procs.insert(pid, Proc { ppid, rss_kb });
    }
    procs
}

#[cfg(test)]
mod tests {
    use super::*;

    fn table(rows: &[(i32, i32, u64)]) -> HashMap<i32, Proc> {
        rows.iter()
            .map(|(pid, ppid, rss_kb)| {
                (
                    *pid,
                    Proc {
                        ppid: *ppid,
                        rss_kb: *rss_kb,
                    },
                )
            })
            .collect()
    }

    fn owned(kind: &str, id: &str) -> (String, String) {
        (kind.to_string(), id.to_string())
    }

    fn row<'a>(usage: &'a MemoryUsage, id: &str) -> &'a MemoryRow {
        usage
            .rows
            .iter()
            .find(|r| r.id == id)
            .unwrap_or_else(|| panic!("no row for {id:?}"))
    }

    #[test]
    fn a_chats_mcp_servers_are_that_chats_memory() {
        // The whole point. The agent is 400 MB; the three MCP servers it
        // started are another 300 between them, and they are only there
        // because that chat is. Charging them to the server instead would say
        // "OctiqFlow is holding 300 MB" and name nothing you could close.
        let procs = table(&[
            (100, 1, 40 * 1024),    // the server
            (200, 100, 400 * 1024), // a chat's shell + agent
            (300, 200, 100 * 1024), // its MCP servers, one level down
            (301, 200, 100 * 1024),
            (302, 300, 100 * 1024), // and one two levels down
        ]);
        let claimed = HashMap::from([(200, owned("chat", "c1"))]);
        let usage = attribute(100, &procs, &claimed);

        assert_eq!(usage.total_mb, 740);
        assert_eq!(usage.procs, 5);
        assert_eq!(row(&usage, "c1").mb, 700);
        assert_eq!(row(&usage, "c1").procs, 4);
        // What no chat claims is the server's own remainder.
        assert_eq!(row(&usage, "").kind, "server");
        assert_eq!(row(&usage, "").mb, 40);
    }

    #[test]
    fn nothing_outside_this_process_tree_is_counted() {
        // A `claude` the person started in their own Terminal.app is holding
        // the same 400 MB, and it is not ours to report or to offer to close.
        let procs = table(&[
            (100, 1, 40 * 1024),
            (900, 1, 400 * 1024), // someone else's, a sibling of the server
        ]);
        let usage = attribute(100, &procs, &HashMap::new());
        assert_eq!(usage.total_mb, 40);
        assert_eq!(usage.procs, 1);
    }

    #[test]
    fn terminals_and_chats_are_separate_rows_biggest_first() {
        let procs = table(&[
            (100, 1, 40 * 1024),
            (200, 100, 300 * 1024), // a chat
            (400, 100, 12 * 1024),  // a terminal tab
            (401, 400, 8 * 1024),   // something running in it
        ]);
        let claimed = HashMap::from([(200, owned("chat", "c1")), (400, owned("terminal", "t1"))]);
        let usage = attribute(100, &procs, &claimed);

        assert_eq!(
            usage.rows.iter().map(|r| r.id.as_str()).collect::<Vec<_>>(),
            vec!["c1", "", "t1"],
            "biggest first, and the server is a row like any other"
        );
        assert_eq!(row(&usage, "t1").mb, 20);
        assert_eq!(row(&usage, "t1").kind, "terminal");
    }

    #[test]
    fn a_reparented_pid_cannot_spin_the_walk() {
        // `ps` reads a moving table: a parent that exits mid-sweep can leave
        // rows that point at each other. The walk must end regardless — this
        // one would loop forever without the visited set.
        let procs = table(&[(100, 1, 1024), (200, 100, 1024), (100, 200, 1024)]);
        let usage = attribute(100, &procs, &HashMap::new());
        assert!(usage.procs <= 2);
    }

    #[test]
    fn ps_output_parses_and_junk_lines_are_skipped() {
        let procs = parse_ps("  100     1  40960\nPID PPID RSS\n\n  200   100  4096\ngarbage\n");
        assert_eq!(procs.len(), 2);
        assert_eq!(procs[&200].ppid, 100);
        assert_eq!(procs[&200].rss_kb, 4096);
    }

    #[test]
    fn a_chat_with_no_process_left_is_simply_not_a_row() {
        // The idle sweeper ends chats behind your back. Its claim outlives its
        // process by however long the cache is; a stale claim must not invent
        // a 0 MB row, and must never match whatever the OS reuses that pid for
        // — it cannot, because a reused pid is not under this server.
        let procs = table(&[(100, 1, 40 * 1024)]);
        let claimed = HashMap::from([(200, owned("chat", "gone"))]);
        let usage = attribute(100, &procs, &claimed);
        assert_eq!(usage.rows.len(), 1);
        assert_eq!(usage.rows[0].kind, "server");
    }
}
