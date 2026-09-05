// Which agents this machine can actually launch.
//
// This module used to do more: a `ps` / PowerShell-CIM process sweep that
// reported what each running agent and its MCP-server fleet cost in RAM, how old
// it was, and which terminal owned it — plus a kill that took the fleet with it.
// That whole overview was reachable only from the desktop app's Agents screen,
// which no longer exists, so it went. Recover it from git history if the browser
// client ever wants it back.
//
// The RAM half of it IS back, in `memory.rs`, and deliberately not here: it
// answers "what is this APP holding", walking down from the server's own pid,
// where this one answered "which agents are running on this machine", finding
// agent roots anywhere by command line. Do not restore the old sweep alongside
// it — restore the AGE and the kill on top of `memory.rs` if they are wanted.
use crate::agent_provider::{provider_for, AgentKind, AgentProvider};
use crate::proc::no_console;
use serde::Serialize;
use serde_json::{json, Value};
use std::collections::HashSet;
use std::io::{BufRead, BufReader, Write};
use std::process::{Command, Stdio};
use std::sync::mpsc;
use std::sync::Mutex;
use std::time::{Duration, Instant};

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

/// Every provider the app knows how to launch, in picker order. The provider
/// registry is the single source of truth for its id, display name, and binary,
/// so this probe cannot drift from the runtime that actually starts a chat.
fn known_agents() -> impl Iterator<Item = &'static dyn AgentProvider> {
    AgentKind::ALL.into_iter().map(provider_for)
}

/// How long a probe result is trusted before the login shell is asked again.
/// Installing an agent mid-session is rare, and a login shell costs a few
/// hundred milliseconds, so the menu reads the cache almost every time — but a
/// fresh install still shows up within a few minutes without a restart.
const AGENT_PROBE_TTL: Duration = Duration::from_secs(300);

/// Cached probe result: when it was taken, and what it found — each hit as
/// (agent name, the path the shell resolved it to).
static AGENT_PROBE: Mutex<Option<(Instant, Vec<(String, String)>)>> = Mutex::new(None);

/// One agent this app can start, and whether this machine has its CLI.
///
/// Every known agent gets a row, installed or not: the screen lists what the app
/// CAN start, so "Codex — not installed" is the useful answer and a vanished row
/// is not.
#[derive(Clone, Serialize)]
pub struct AgentInstall {
    /// The id the chat backend takes (`ChatAgent`), which is also the binary
    /// name: "claude" / "codex".
    pub id: String,
    /// What the CLI is called on screen.
    pub name: String,
    /// The command that starts it — the same string as `id`, named separately
    /// because the screen shows it as a command, not as an id.
    pub bin: String,
    /// Whether the login shell resolves that command.
    pub installed: bool,
    /// Where it resolved, when the shell told us. `None` when the agent is
    /// missing — and also when it is installed but the path could not be read,
    /// which is why `installed` is its own field rather than `path.is_some()`.
    pub path: Option<String>,
}

/// Every agent the app can start, each marked installed or not.
///
/// `refresh` forces the login shell to be asked again. Someone who has just
/// installed an agent in a terminal and comes back to look is exactly the case
/// the TTL gets wrong: without this, a "check again" button would return the
/// same stale answer for five minutes and look broken.
pub fn agent_installs(refresh: Option<bool>) -> Vec<AgentInstall> {
    if refresh.unwrap_or(false) {
        forget_probe();
    }
    install_rows(&probe_cached())
}

// ---- Codex skills ---------------------------------------------------------

/// Long enough for a cold Codex app-server to read config and discover plugin
/// skills, but bounded so opening the slash menu cannot strand a web request.
const CODEX_SKILLS_TIMEOUT: Duration = Duration::from_secs(10);

/// Ask Codex itself which skills are active for `cwd`.
///
/// Codex does not emit a skill catalog in `codex exec --json`, unlike Claude's
/// startup event. Its app-server owns the same discovery code the CLI uses,
/// including repo, user, system and plugin roots, so using `skills/list` here
/// avoids maintaining a second, inevitably incomplete directory scanner.
pub fn codex_skills(cwd: String) -> Result<Vec<String>, String> {
    let cwd = std::path::PathBuf::from(cwd);
    if !cwd.is_absolute() || !cwd.is_dir() {
        return Err("the Codex skills folder must be an existing absolute directory".into());
    }

    let executable = probe_cached()
        .into_iter()
        .find(|(name, _)| name == AgentKind::Codex.id())
        .ok_or_else(|| "Codex is not installed on this machine".to_string())?
        .1;
    let mut command = Command::new(if executable.is_empty() {
        provider_for(AgentKind::Codex).bin()
    } else {
        &executable
    });
    command
        .args(["app-server", "--stdio"])
        .current_dir(&cwd)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        // Login-shell banners are not involved because the probe gave us the
        // resolved executable. App-server diagnostics are not menu entries.
        .stderr(Stdio::null());
    no_console(&mut command);
    let mut child = command
        .spawn()
        .map_err(|e| format!("could not start Codex to load skills: {e}"))?;

    let request = [
        json!({
            "id": 1,
            "method": "initialize",
            "params": {
                "clientInfo": { "name": "octiqflow", "version": env!("CARGO_PKG_VERSION") },
                "capabilities": { "experimentalApi": true }
            }
        }),
        json!({ "method": "initialized" }),
        json!({
            "id": 2,
            "method": "skills/list",
            "params": { "cwds": [cwd.to_string_lossy()], "forceReload": false }
        }),
    ];
    let write_result = child
        .stdin
        .take()
        .ok_or_else(|| "Codex stdin was unavailable".to_string())
        .and_then(|mut stdin| {
            for message in request {
                writeln!(stdin, "{message}")
                    .map_err(|e| format!("could not ask Codex for skills: {e}"))?;
            }
            Ok(())
        });
    if let Err(error) = write_result {
        let _ = child.kill();
        let _ = child.wait();
        return Err(error);
    }

    // Drain stdout on its own thread. A real skill catalog can exceed a pipe's
    // buffer, so waiting for the child before reading it can deadlock.
    let Some(stdout) = child.stdout.take() else {
        let _ = child.kill();
        let _ = child.wait();
        return Err("Codex stdout was unavailable".into());
    };
    let (send, receive) = mpsc::channel();
    let reader = std::thread::spawn(move || {
        for line in BufReader::new(stdout).lines().map_while(Result::ok) {
            if let Some(answer) = parse_skills_response(&line) {
                let _ = send.send(answer);
                return;
            }
        }
        let _ = send.send(Err("Codex ended without returning a skill list".into()));
    });

    let answer = receive
        .recv_timeout(CODEX_SKILLS_TIMEOUT)
        .unwrap_or_else(|_| Err("Codex took too long to load its skill list".into()));
    let _ = child.kill();
    let _ = child.wait();
    let _ = reader.join();
    answer
}

/// A `skills/list` response among app-server notifications, or no response on
/// this line. Kept pure so protocol parsing does not need a real Codex process
/// in the test suite.
fn parse_skills_response(line: &str) -> Option<Result<Vec<String>, String>> {
    let value: Value = serde_json::from_str(line).ok()?;
    if value.get("id").and_then(Value::as_u64) != Some(2) {
        return None;
    }
    if let Some(error) = value.get("error") {
        let message = error
            .get("message")
            .and_then(Value::as_str)
            .unwrap_or("Codex could not load its skill list");
        return Some(Err(message.to_string()));
    }
    let Some(entries) = value
        .get("result")
        .and_then(|v| v.get("data"))
        .and_then(Value::as_array)
    else {
        return Some(Err("Codex returned an invalid skill list".into()));
    };

    let mut seen = HashSet::new();
    let mut names = Vec::new();
    for skill in entries
        .iter()
        .filter_map(|entry| entry.get("skills").and_then(Value::as_array))
        .flatten()
    {
        if skill.get("enabled").and_then(Value::as_bool) != Some(true) {
            continue;
        }
        let Some(name) = skill.get("name").and_then(Value::as_str) else {
            continue;
        };
        let key = name.to_lowercase();
        if !name.is_empty() && !name.chars().any(char::is_whitespace) && seen.insert(key) {
            names.push(name.to_string());
        }
    }
    Some(Ok(names))
}

/// Drop the cached probe so the next read asks the shell again.
fn forget_probe() {
    if let Ok(mut cache) = AGENT_PROBE.lock() {
        *cache = None;
    }
}

/// Put a known answer in the cache so a test can call the command without
/// starting a login shell — which would make the test slow, machine-dependent,
/// and dependent on whatever the user's rc files do.
#[cfg(test)]
pub fn seed_probe_for_test(found: Vec<(String, String)>) {
    if let Ok(mut cache) = AGENT_PROBE.lock() {
        *cache = Some((Instant::now(), found));
    }
}

/// Turn the probe's hits into one row per known agent. Pure, so the "a missing
/// agent is still a row" rule is testable without a shell.
fn install_rows(found: &[(String, String)]) -> Vec<AgentInstall> {
    known_agents()
        .map(|provider| {
            let id = provider.kind().id();
            let hit = found.iter().find(|(name, _)| name == id);
            AgentInstall {
                id: id.to_string(),
                name: provider.display_name().to_string(),
                bin: provider.bin().to_string(),
                installed: hit.is_some(),
                path: hit.map(|(_, p)| p.clone()).filter(|p| !p.is_empty()),
            }
        })
        .collect()
}

/// The probe result, taken at most once per `AGENT_PROBE_TTL`.
fn probe_cached() -> Vec<(String, String)> {
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

/// Run the probe through a login shell and read back what it found.
fn probe_agents() -> Vec<(String, String)> {
    let mut cmd = probe_command();
    no_console(&mut cmd);
    match cmd.output() {
        Ok(out) => parse_probe_output(&String::from_utf8_lossy(&out.stdout)),
        // Could not even start a shell — fail OPEN, with no path to show for any
        // of them. A menu that silently loses both agents is far worse than one
        // offering an agent that turns out to be missing.
        Err(_) => known_agents()
            .map(|provider| (provider.kind().id().to_string(), String::new()))
            .collect(),
    }
}

/// Keep only lines that name a known provider, in registry order and without
/// duplicates. A login shell prints whatever the user's rc files print (banners,
/// version notices, fastfetch), so the output is filtered against the fixed list
/// rather than trusted line by line.
///
/// Each line is `name<TAB>path`. The path is what the shell resolved and is
/// shown as proof the agent is really there; a line carrying only the name
/// still counts as installed, because the name IS the answer to "does this
/// resolve" and the path is only the detail.
fn parse_probe_output(stdout: &str) -> Vec<(String, String)> {
    let lines: Vec<(&str, &str)> = stdout
        .lines()
        .map(|l| l.trim())
        .map(|l| match l.split_once('\t') {
            Some((name, path)) => (name.trim(), path.trim()),
            None => (l, ""),
        })
        .collect();
    known_agents()
        .filter_map(|provider| {
            let id = provider.kind().id();
            let (_, path) = lines.iter().find(|(name, _)| *name == id)?;
            Some((id.to_string(), (*path).to_string()))
        })
        .collect()
}

/// Ask the user's LOGIN shell which agents resolve on its PATH, printing one
/// name per hit. One shell for both agents: starting a login shell is the
/// expensive part, and the loop inside it is free.
#[cfg(unix)]
fn probe_command() -> Command {
    let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/zsh".to_string());
    // `command -v` already prints the path it resolved, so the path costs
    // nothing extra here — it is kept rather than thrown at /dev/null.
    let script = format!(
        "for a in {}; do p=$(command -v \"$a\" 2>/dev/null) && printf '%s\\t%s\\n' \"$a\" \"$p\"; done",
        known_agents()
            .map(AgentProvider::bin)
            .collect::<Vec<_>>()
            .join(" ")
    );
    let mut cmd = Command::new(shell);
    // `-l` populates PATH the way pty.rs does for a real terminal; `-c` runs
    // the script. Both are needed — `-c` alone would read the GUI PATH.
    //
    // `-i` matters as much as `-l`: pty.rs spawns its shell on a TTY, so that
    // shell is INTERACTIVE and reads `.zshrc`/`.bashrc`, while a bare `-lc`
    // shell reads only the login files. Anything a version manager or installer
    // adds to PATH from the interactive rc (e.g. `~/.local/bin` via
    // `. "$HOME/.local/bin/env"`, which is where npm-less `claude` installs go)
    // is invisible without it — the probe would hide an agent that a real
    // terminal launches fine. Interactive rc files also print banners and
    // prompt-plugin warnings on stderr/stdout; `parse_probe_output` keeps only
    // lines that exactly match a known agent, so that noise is already handled.
    cmd.args(["-lic", &script]);
    cmd
}

/// Windows has no login shell; PowerShell loading the user profile is the
/// equivalent step that fills PATH, so the profile is deliberately NOT skipped.
#[cfg(windows)]
fn probe_command() -> Command {
    let names = known_agents()
        .map(|provider| format!("'{}'", provider.bin()))
        .collect::<Vec<_>>()
        .join(",");
    // "`t" is PowerShell's tab escape — the same name<TAB>path shape the Unix
    // probe prints, so one parser reads both.
    let script = format!(
        "foreach ($a in {names}) {{ $c = Get-Command $a -ErrorAction SilentlyContinue; if ($c) {{ \"$a`t$($c.Source)\" }} }}"
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
    /// `parse_probe_output` reads "name<TAB>path" lines. Only the names survive
    /// the filter; this checks the name half.
    fn names(stdout: &str) -> Vec<String> {
        parse_probe_output(stdout)
            .into_iter()
            .map(|(a, _)| a)
            .collect()
    }

    #[test]
    fn probe_output_keeps_only_known_agents_in_menu_order() {
        // A login shell prints the user's own banners around our echoes, and
        // may print them in any order. Only the known names survive, and they
        // come back in KNOWN_AGENTS order, not in the order the shell printed.
        let out = "Welcome to zsh!\ncodex\t/opt/homebrew/bin/codex\nnpm notice: update available\nclaude\t/Users/x/.local/bin/claude\n";
        assert_eq!(names(out), vec!["claude", "codex"]);
        // One installed agent.
        assert_eq!(names("claude\t/usr/local/bin/claude\n"), vec!["claude"]);
        // Neither installed: banner noise alone yields nothing.
        assert!(parse_probe_output("some banner\n").is_empty());
        // A line that merely CONTAINS an agent name is not a hit.
        assert!(parse_probe_output("claude not found\n").is_empty());
    }

    #[test]
    fn probe_output_reads_the_path_the_login_shell_resolved() {
        // The path is the proof that the agent is really there — and it is the
        // LOGIN shell's answer, which is the whole point of probing through one.
        let found = parse_probe_output("claude\t/Users/x/.local/bin/claude\n");
        assert_eq!(found[0].1, "/Users/x/.local/bin/claude");
    }

    #[test]
    fn a_bare_name_with_no_path_still_counts_as_installed() {
        // A shell that prints the name but no path (or a path we could not
        // read) has still told us the agent resolves. Losing the row over a
        // missing path would hide an agent that launches fine.
        let found = parse_probe_output("claude\n");
        assert_eq!(found, vec![("claude".to_string(), String::new())]);
    }

    #[test]
    fn install_rows_name_every_known_agent_present_or_not() {
        // The page lists what this app CAN start, so a missing agent is a row
        // saying "not installed" — never a row that quietly vanishes.
        let found = vec![("codex".to_string(), "/opt/homebrew/bin/codex".to_string())];
        let rows = install_rows(&found);
        assert_eq!(rows.len(), known_agents().count());

        assert_eq!(rows[0].id, "claude");
        assert!(!rows[0].installed);
        assert!(rows[0].path.is_none());

        assert_eq!(rows[1].id, "codex");
        assert_eq!(rows[1].name, "Codex");
        assert!(rows[1].installed);
        assert_eq!(rows[1].path.as_deref(), Some("/opt/homebrew/bin/codex"));
    }

    #[test]
    fn forgetting_the_probe_makes_the_next_read_ask_again() {
        // "Check again" exists for the person who just installed an agent in a
        // terminal. Reading through the TTL would hand them the same stale
        // answer for five minutes, so the forced path must clear the cache.
        if let Ok(mut cache) = AGENT_PROBE.lock() {
            *cache = Some((Instant::now(), vec![("claude".into(), "/stale".into())]));
        }
        forget_probe();
        assert!(
            AGENT_PROBE.lock().unwrap().is_none(),
            "a forced check must drop the cached answer"
        );
    }

    #[test]
    fn install_rows_carry_a_name_for_the_screen() {
        // "claude" is the binary; "Claude Code" is what the CLI is called.
        let rows = install_rows(&[]);
        assert_eq!(rows[0].name, "Claude Code");
        assert_eq!(rows[0].bin, "claude");
    }

    #[test]
    fn codex_skill_response_keeps_enabled_unique_names() {
        let line = serde_json::json!({
            "id": 2,
            "result": {
                "data": [{
                    "cwd": "/project",
                    "skills": [
                        { "name": "release", "enabled": true },
                        { "name": "release", "enabled": false },
                        { "name": "PDF:pdf", "enabled": true },
                        { "name": "pdf:pdf", "enabled": true },
                        { "name": "bad name", "enabled": true }
                    ],
                    "errors": []
                }]
            }
        })
        .to_string();

        assert_eq!(
            parse_skills_response(&line).unwrap().unwrap(),
            vec!["release".to_string(), "PDF:pdf".to_string()]
        );
    }

    #[test]
    fn codex_skill_parser_ignores_other_app_server_messages() {
        assert!(parse_skills_response(r#"{"id":1,"result":{}}"#).is_none());
        assert!(
            parse_skills_response(r#"{"method":"remoteControl/status/changed","params":{}}"#)
                .is_none()
        );
    }

    /// The probe shell must be INTERACTIVE as well as a login shell. pty.rs
    /// spawns its shell on a TTY, which makes it interactive, so it reads
    /// `.zshrc`/`.bashrc`; a `-lc` probe reads only the login files and misses
    /// every PATH entry those rc files add (that is how the "Claude" row
    /// disappeared from the add menu while `claude` ran fine in a terminal).
    #[cfg(unix)]
    #[test]
    fn probe_runs_an_interactive_login_shell() {
        let cmd = probe_command();
        let args: Vec<String> = cmd
            .get_args()
            .map(|a| a.to_string_lossy().into_owned())
            .collect();
        assert_eq!(args[0], "-lic", "probe shell must be login AND interactive");
        // The script itself asks about exactly the agents the menu offers.
        for provider in known_agents() {
            assert!(
                args[1].contains(provider.bin()),
                "probe script must ask about {}",
                provider.bin()
            );
        }
    }
}
