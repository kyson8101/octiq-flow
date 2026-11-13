//! What an orchestration worker keeps of the person's MCP servers.
//!
//! A worker starts with `--strict-mcp-config` (Claude) or every inherited
//! server switched off (Codex), so it sees no server of the person's. That
//! also took away the browser: checked against claude 2.1 (`system/init` of a
//! stream-json launch), the person's `playwright` server is the only browser
//! tool an ordinary chat has (Claude in Chrome exists only with `--chrome`,
//! which no launch passes).
//!
//! The person's definition of each server in `CLAUDE_WORKER_MCP_ON`, and of
//! nothing else, is read from their Claude settings (user scope, then the
//! project's own on top). **Only a valid stdio definition qualifies, for both
//! providers**, and it is validated AFTER the scope precedence has chosen it:
//! a project-scope `http`, `sse` or `{}` entry is not replaced by the user
//! scope's and adds nothing. A definition that is not usable never affects the
//! launch: the worker starts without a browser, as before.
//!
//! Claude gets the definition in a second config file the launch names with
//! one more `--mcp-config` (the file is 0600 and content addressed: nothing
//! of it is on the command line).
//!
//! Codex has no config file to point at, so the server is one inline `-c
//! mcp_servers.<name>=...` table (`codex_browser`). Two things about it were
//! found against the real CLI (codex-cli 0.164, `codex mcp list --json`):
//!
//! * **The name is the host's own** (`CODEX_SERVER`), never `playwright`.
//!   A whole-table `-c` override of a name the person's Codex config also uses
//!   does NOT replace it: Codex deep-merges, so the person's old `args`, `env`,
//!   `env_vars` and `enabled = false` survive, and an old `url` plus the new
//!   `command` fails the bootstrap. The person's own `playwright` (if Codex
//!   has one) is switched off like every other inherited server.
//! * **No env VALUE is ever on a command line** (`ps` shows it). The table
//!   lists the variable NAMES in `env_vars`, and the values are set in the
//!   environment of the process the host spawns (`CodexBrowser::env`), which
//!   Codex forwards to the server by name. Claude's file already carries none.

use serde_json::{json, Map, Value};
use sha2::{Digest, Sha256};
use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

/// The browser server a worker keeps, by the name the person gave it in their
/// Claude settings.
pub const PLAYWRIGHT: &str = "playwright";

/// What a Codex worker's copy of it is called: a name no person's config
/// uses (`codex_server_name` steps aside if one does).
pub const CODEX_SERVER: &str = "octiq_playwright";

/// MCP servers a Claude worker keeps, by the name the person gave them.
pub const CLAUDE_WORKER_MCP_ON: &[&str] = &[PLAYWRIGHT];

/// The allowlisted servers among those the person configured for `cwd`:
/// user scope first, the project's own (local scope, `projects[cwd]`) on top,
/// as Claude resolves a name that exists in both. Nothing is validated here:
/// the winner is chosen first, then judged (`stdio`).
pub fn allowlisted_servers(config: &Value, cwd: &str) -> Map<String, Value> {
    let mut found = Map::new();
    let scopes = [
        config.get("mcpServers"),
        config
            .get("projects")
            .and_then(|projects| projects.get(cwd))
            .and_then(|project| project.get("mcpServers")),
    ];
    for scope in scopes.into_iter().flatten().filter_map(Value::as_object) {
        for name in CLAUDE_WORKER_MCP_ON {
            if let Some(definition) = scope.get(*name).filter(|d| d.is_object()) {
                found.insert((*name).to_owned(), definition.clone());
            }
        }
    }
    found
}

/// A definition both providers can take: no `type` or `"stdio"`, a non-empty
/// string `command`, string `args` and string `env` values.
struct Stdio<'a> {
    command: &'a str,
    args: Option<Vec<&'a str>>,
    env: Vec<(&'a str, &'a str)>,
}

fn stdio(definition: &Value) -> Option<Stdio<'_>> {
    let object = definition.as_object()?;
    if object
        .get("type")
        .is_some_and(|kind| kind.as_str() != Some("stdio"))
    {
        return None;
    }
    let command = object
        .get("command")
        .and_then(Value::as_str)
        .filter(|command| !command.trim().is_empty())?;
    let args = match object.get("args") {
        Some(args) => Some(
            args.as_array()?
                .iter()
                .map(Value::as_str)
                .collect::<Option<Vec<_>>>()?,
        ),
        None => None,
    };
    let env = match object.get("env") {
        Some(env) => env
            .as_object()?
            .iter()
            .map(|(name, value)| Some((name.as_str(), value.as_str()?)))
            .collect::<Option<Vec<_>>>()?,
        None => Vec::new(),
    };
    Some(Stdio { command, args, env })
}

/// Where the person's Claude keeps its settings (`.claude.json`): the
/// project's `CLAUDE_CONFIG_DIR` when it sets one, else the process's own,
/// else the home folder. The project's value is resolved exactly as the
/// launch resolves it (`workspaces::resolved_env`: a leading `~` is the home
/// folder), so `~/alt-config` names the folder the agent will really use.
fn claude_config_path(env: Option<&BTreeMap<String, String>>) -> Option<PathBuf> {
    let from_project = env.and_then(|env| {
        crate::workspaces::resolved_env(env)
            .into_iter()
            .find(|(name, _)| name == "CLAUDE_CONFIG_DIR")
            .map(|(_, dir)| dir)
    });
    let dir = from_project
        .or_else(|| std::env::var("CLAUDE_CONFIG_DIR").ok())
        .filter(|dir| !dir.trim().is_empty());
    match dir {
        Some(dir) => Some(Path::new(&dir).join(".claude.json")),
        None => crate::paths::home_dir().map(|home| home.join(".claude.json")),
    }
}

/// The person's allowlisted servers for a launch in `cwd`, read from their
/// Claude settings. Empty when there are none or the file cannot be read.
fn person_servers(cwd: &str, env: Option<&BTreeMap<String, String>>) -> Map<String, Value> {
    let read = || -> Option<Map<String, Value>> {
        let text = std::fs::read_to_string(claude_config_path(env)?).ok()?;
        let config: Value = serde_json::from_str(&text).ok()?;
        Some(allowlisted_servers(&config, cwd))
    };
    read().unwrap_or_default()
}

/// The second `--mcp-config` file for a Claude worker in `cwd`, or `None`
/// when the person has no usable allowlisted server or it cannot be set up.
pub fn for_launch(cwd: &str, env: Option<&BTreeMap<String, String>>) -> Option<PathBuf> {
    let mut servers = person_servers(cwd, env);
    servers.retain(|_, definition| stdio(definition).is_some());
    if servers.is_empty() {
        return None;
    }
    let dir = crate::paths::home_dir()?.join(".octiqflow").join("mcp");
    write_config(&dir, &servers)
}

/// A Codex worker's browser: what goes on its command line and what goes in
/// its environment.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct CodexBrowser {
    /// The server's name in the launch (`CODEX_SERVER`, or a numbered
    /// variant when the person's Codex config already uses it).
    pub name: String,
    /// The whole inline table: `{command=..,args=[..],env_vars=[names]}`.
    pub entry: String,
    /// The definition's `env`, name and value. Values never reach a command
    /// line: they are set in the spawned process's environment.
    pub env: Vec<(String, String)>,
}

/// The name for a Codex worker's browser: `CODEX_SERVER`, then
/// `CODEX_SERVER_2`, ... until none of the person's Codex servers has it.
pub fn codex_server_name(taken: &[String]) -> String {
    let mut name = CODEX_SERVER.to_owned();
    let mut n = 1;
    while taken.iter().any(|other| *other == name) {
        n += 1;
        name = format!("{CODEX_SERVER}_{n}");
    }
    name
}

/// The browser for a Codex worker in `cwd`, from the same definition a Claude
/// worker reads; `None` adds nothing. `taken` are the names of the servers
/// the person's Codex already has. `current` answers what a variable is set
/// to for the process about to be spawned (the project's environment, then
/// the server's own): a value that would CHANGE one already there is not
/// carried, because setting it would change Codex itself, not just the server.
#[cfg(test)]
pub fn for_codex_launch(
    cwd: &str,
    env: Option<&BTreeMap<String, String>>,
    taken: &[String],
    current: &dyn Fn(&str) -> Option<String>,
) -> Option<CodexBrowser> {
    for_codex_launch_noted(cwd, env, taken, current).0
}

/// [`for_codex_launch`], and when a browser the person configured is left out
/// for its environment, a sentence saying so for the diagnostics log: the
/// variable NAMES and the reason, never a value.
pub fn for_codex_launch_noted(
    cwd: &str,
    env: Option<&BTreeMap<String, String>>,
    taken: &[String],
    current: &dyn Fn(&str) -> Option<String>,
) -> (Option<CodexBrowser>, Option<String>) {
    let servers = person_servers(cwd, env);
    let Some(definition) = servers.get(PLAYWRIGHT) else {
        return (None, None);
    };
    match codex_browser_checked(definition, taken, current) {
        Ok(browser) => (Some(browser), None),
        Err(skip) => (None, skip.note()),
    }
}

/// Why a configured browser is not given to a Codex worker.
#[derive(Debug, PartialEq, Eq)]
pub enum Skip {
    /// Not a valid stdio definition: nothing to say, nothing was asked for.
    NotStdio,
    /// These variables are already set to something else for the process
    /// about to be spawned, and setting them would change Codex itself.
    EnvConflict(Vec<String>),
    /// An entry in `env` that cannot be an environment variable at all.
    BadEnv,
}

impl Skip {
    fn note(&self) -> Option<String> {
        match self {
            Skip::NotStdio => None,
            Skip::EnvConflict(names) => Some(format!(
                "the person's playwright browser was not added to this worker: its env sets {} \
                 to a value different from the one this launch already has, and that would \
                 change Codex itself",
                names.join(", ")
            )),
            Skip::BadEnv => Some(
                "the person's playwright browser was not added to this worker: its env holds \
                 an entry that cannot be an environment variable"
                    .to_owned(),
            ),
        }
    }
}

/// The pure half of `for_codex_launch`.
#[cfg(test)]
pub fn codex_browser(
    definition: &Value,
    taken: &[String],
    current: &dyn Fn(&str) -> Option<String>,
) -> Option<CodexBrowser> {
    codex_browser_checked(definition, taken, current).ok()
}

/// [`codex_browser`], saying why when there is none.
pub fn codex_browser_checked(
    definition: &Value,
    taken: &[String],
    current: &dyn Fn(&str) -> Option<String>,
) -> Result<CodexBrowser, Skip> {
    use crate::agent_provider::toml_string;
    let stdio = stdio(definition).ok_or(Skip::NotStdio)?;
    let mut env = Vec::new();
    let mut conflicts = Vec::new();
    for (name, value) in &stdio.env {
        if name.is_empty() || name.contains(['=', '\0']) || value.contains('\0') {
            return Err(Skip::BadEnv);
        }
        if current(name).is_some_and(|there| there != *value) {
            conflicts.push((*name).to_owned());
        }
        env.push(((*name).to_owned(), (*value).to_owned()));
    }
    if !conflicts.is_empty() {
        return Err(Skip::EnvConflict(conflicts));
    }
    let mut entry = format!("{{command={}", toml_string(stdio.command));
    if let Some(args) = &stdio.args {
        let args: Vec<String> = args.iter().map(|arg| toml_string(arg)).collect();
        entry.push_str(&format!(",args=[{}]", args.join(",")));
    }
    if !env.is_empty() {
        let names: Vec<String> = env.iter().map(|(name, _)| toml_string(name)).collect();
        entry.push_str(&format!(",env_vars=[{}]", names.join(",")));
    }
    entry.push('}');
    Ok(CodexBrowser {
        name: codex_server_name(taken),
        entry,
        env,
    })
}

/// `<dir>/worker-browser-<hash of the content>.json`, written whole under a
/// temporary name and renamed into place, private to the person. A file that
/// is already there holds the same bytes, so a launch racing another is fine.
pub fn write_config(dir: &Path, servers: &Map<String, Value>) -> Option<PathBuf> {
    let body = serde_json::to_vec_pretty(&json!({ "mcpServers": servers })).ok()?;
    let digest = Sha256::digest(&body);
    let name: String = digest.iter().take(8).map(|b| format!("{b:02x}")).collect();
    let target = dir.join(format!("worker-browser-{name}.json"));
    if target.is_file() {
        return Some(target);
    }
    crate::profile::create_dir_all(dir).ok()?;
    let temp = dir.join(format!(".worker-browser-{name}-{}.tmp", std::process::id()));
    {
        use std::io::Write;
        let mut options = std::fs::OpenOptions::new();
        options.write(true).create(true).truncate(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        let mut file = options.open(&temp).ok()?;
        file.write_all(&body).ok()?;
        file.sync_all().ok()?;
    }
    if std::fs::rename(&temp, &target).is_err() {
        let _ = std::fs::remove_file(&temp);
        return target.is_file().then_some(target);
    }
    Some(target)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_dir::TestDir;

    fn config() -> Value {
        json!({
            "mcpServers": {
                "playwright": {"type": "stdio", "command": "npx", "args": ["-y", "@playwright/mcp@latest"], "env": {"TOKEN": "s3cret"}},
                "sentry": {"type": "http", "url": "https://mcp.sentry.dev/mcp"},
                "docspace": {"command": "node"}
            },
            "projects": {
                "/work/app": {"mcpServers": {
                    "playwright": {"command": "local-playwright"},
                    "mssql": {"command": "mssql"}
                }}
            }
        })
    }

    #[test]
    fn only_the_allowlisted_server_is_carried() {
        let found = allowlisted_servers(&config(), "/elsewhere");
        assert_eq!(found.keys().collect::<Vec<_>>(), ["playwright"]);
        assert_eq!(found["playwright"]["command"], "npx");
    }

    #[test]
    fn the_projects_own_definition_wins_over_the_user_scope() {
        let found = allowlisted_servers(&config(), "/work/app");
        assert_eq!(found.len(), 1);
        assert_eq!(found["playwright"]["command"], "local-playwright");
    }

    #[test]
    fn no_allowlisted_server_means_no_file() {
        let config = json!({"mcpServers": {"sentry": {"command": "x"}}});
        assert!(allowlisted_servers(&config, "/a").is_empty());
        assert!(allowlisted_servers(&json!({}), "/a").is_empty());
        assert!(
            allowlisted_servers(&json!({"mcpServers": {"playwright": "oops"}}), "/a").is_empty()
        );
    }

    #[test]
    fn the_file_holds_the_definition_privately_and_is_stable() {
        let dir = TestDir::new("worker-browser");
        let servers = allowlisted_servers(&config(), "/elsewhere");
        let first = write_config(&dir, &servers).expect("written");
        let second = write_config(&dir, &servers).expect("written again");
        assert_eq!(first, second, "same content, same file");
        let saved: Value = serde_json::from_slice(&std::fs::read(&first).unwrap()).unwrap();
        assert_eq!(saved["mcpServers"]["playwright"]["env"]["TOKEN"], "s3cret");
        assert!(saved["mcpServers"].get("sentry").is_none());
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = std::fs::metadata(&first).unwrap().permissions().mode() & 0o777;
            assert_eq!(mode, 0o600);
        }
        let other = allowlisted_servers(&config(), "/work/app");
        assert_ne!(first, write_config(&dir, &other).unwrap());
    }

    #[test]
    fn an_unreadable_config_changes_nothing() {
        let dir = TestDir::new("worker-browser-config");
        let mut env = std::collections::BTreeMap::new();
        env.insert(
            "CLAUDE_CONFIG_DIR".to_owned(),
            dir.to_string_lossy().into_owned(),
        );
        assert!(for_launch("/a", Some(&env)).is_none(), "no file");
        std::fs::write(dir.join(".claude.json"), "{not json").unwrap();
        assert!(for_launch("/a", Some(&env)).is_none(), "not JSON");
    }

    fn none_set(_: &str) -> Option<String> {
        None
    }

    fn env_with(dir: &Path) -> BTreeMap<String, String> {
        let mut env = BTreeMap::new();
        env.insert(
            "CLAUDE_CONFIG_DIR".to_owned(),
            dir.to_string_lossy().into_owned(),
        );
        env
    }

    #[test]
    fn a_stdio_playwright_is_one_table_with_names_and_never_values() {
        let browser = codex_browser(
            &json!({
                "type": "stdio",
                "command": "npx",
                "args": ["-y", "@playwright/mcp@latest", "--executable-path", "/A B/Brave \"x\""],
                "env": {"TOKEN": "s3cret", "A-B": "c:\\d"}
            }),
            &[],
            &none_set,
        )
        .expect("a browser");
        assert_eq!(browser.name, "octiq_playwright");
        assert_eq!(
            browser.entry,
            r#"{command="npx",args=["-y","@playwright/mcp@latest","--executable-path","/A B/Brave \"x\""],env_vars=["A-B","TOKEN"]}"#
        );
        assert!(
            !browser.entry.contains("s3cret"),
            "no value on a command line"
        );
        assert!(!browser.entry.contains("c:"), "no value on a command line");
        assert_eq!(
            browser.env,
            [
                ("A-B".to_owned(), "c:\\d".to_owned()),
                ("TOKEN".to_owned(), "s3cret".to_owned())
            ]
        );
        // No type, no args, no env is still a stdio server.
        let bare = codex_browser(&json!({"command": "pw"}), &[], &none_set).unwrap();
        assert_eq!(bare.entry, r#"{command="pw"}"#);
        assert!(bare.env.is_empty());
        let empty = codex_browser(
            &json!({"command": "pw", "env": {}, "args": []}),
            &[],
            &none_set,
        )
        .unwrap();
        assert_eq!(empty.entry, r#"{command="pw",args=[]}"#);
    }

    #[test]
    fn a_definition_that_is_not_stdio_adds_nothing_for_either_provider() {
        for bad in [
            json!({"type": "http", "url": "https://x"}),
            json!({"type": "sse", "command": "x"}),
            json!({"type": "sse", "url": "https://x"}),
            json!({"url": "https://x"}),
            json!({}),
            json!({"command": ""}),
            json!({"command": "  "}),
            json!({"command": 3}),
            json!({"command": "x", "args": [1]}),
            json!({"command": "x", "args": "-y"}),
            json!({"command": "x", "env": {"A": 1}}),
            json!("npx"),
        ] {
            assert!(codex_browser(&bad, &[], &none_set).is_none(), "codex {bad}");
            assert!(stdio(&bad).is_none(), "claude {bad}");
        }
    }

    #[test]
    fn claude_writes_no_file_for_a_definition_that_is_not_stdio() {
        // Review round 1 (M4): http, sse and {} each made a second config.
        for bad in [
            json!({"type": "http", "url": "https://x"}),
            json!({"type": "sse", "url": "https://x"}),
            json!({}),
        ] {
            let dir = TestDir::new("worker-browser-bad");
            std::fs::write(
                dir.join(".claude.json"),
                serde_json::to_vec(&json!({"mcpServers": {"playwright": bad}})).unwrap(),
            )
            .unwrap();
            let env = env_with(&dir);
            assert!(for_launch("/a", Some(&env)).is_none(), "{bad}");
            assert!(for_codex_launch("/a", Some(&env), &[], &none_set).is_none());
        }
    }

    #[test]
    fn the_scope_winner_is_judged_not_replaced_by_the_other_scope() {
        // The project's own definition wins, and when it is not stdio the
        // user scope's valid one is NOT used instead.
        let dir = TestDir::new("worker-browser-precedence");
        std::fs::write(
            dir.join(".claude.json"),
            serde_json::to_vec(&json!({
                "mcpServers": {"playwright": {"command": "npx"}},
                "projects": {"/p": {"mcpServers": {"playwright": {"type": "http", "url": "https://x"}}}}
            }))
            .unwrap(),
        )
        .unwrap();
        let env = env_with(&dir);
        assert!(for_launch("/p", Some(&env)).is_none());
        assert!(for_codex_launch("/p", Some(&env), &[], &none_set).is_none());
        assert!(for_launch("/other", Some(&env)).is_some());
    }

    #[test]
    fn the_codex_browser_comes_from_the_same_source_as_the_claude_file() {
        let dir = TestDir::new("worker-browser-codex");
        let env = env_with(&dir);
        assert!(
            for_codex_launch("/a", Some(&env), &[], &none_set).is_none(),
            "no file"
        );
        std::fs::write(
            dir.join(".claude.json"),
            serde_json::to_vec(&config()).unwrap(),
        )
        .unwrap();
        let user = for_codex_launch("/elsewhere", Some(&env), &[], &none_set).expect("user scope");
        assert!(user.entry.starts_with("{command=\"npx\""), "{}", user.entry);
        assert_eq!(user.env, [("TOKEN".to_owned(), "s3cret".to_owned())]);
        let project =
            for_codex_launch("/work/app", Some(&env), &[], &none_set).expect("project scope");
        assert_eq!(project.entry, "{command=\"local-playwright\"}");
        std::fs::write(
            dir.join(".claude.json"),
            r#"{"mcpServers":{"sentry":{"command":"x"}}}"#,
        )
        .unwrap();
        assert!(
            for_codex_launch("/a", Some(&env), &[], &none_set).is_none(),
            "no playwright"
        );
    }

    #[test]
    fn the_name_is_the_hosts_own_and_steps_aside_for_a_taken_one() {
        let def = json!({"command": "pw"});
        let name = |taken: &[&str]| {
            let taken: Vec<String> = taken.iter().map(|s| s.to_string()).collect();
            codex_browser(&def, &taken, &none_set).unwrap().name
        };
        assert_eq!(name(&[]), "octiq_playwright");
        // The person's own `playwright` is not this server's name.
        assert_eq!(name(&["playwright"]), "octiq_playwright");
        assert_eq!(name(&["octiq_playwright"]), "octiq_playwright_2");
        assert_eq!(
            name(&["octiq_playwright", "octiq_playwright_2"]),
            "octiq_playwright_3"
        );
    }

    #[test]
    fn a_value_that_would_change_the_process_environment_is_not_carried() {
        let def = json!({"command": "pw", "env": {"PATH": "/evil", "TOKEN": "t"}});
        // A variable already set to something else would change Codex itself.
        let there = |name: &str| (name == "PATH").then(|| "/usr/bin".to_owned());
        assert!(codex_browser(&def, &[], &there).is_none());
        // The same value is no change.
        let same = |name: &str| (name == "PATH").then(|| "/evil".to_owned());
        assert!(codex_browser(&def, &[], &same).is_some());
        // A name that cannot be an environment variable.
        assert!(codex_browser(
            &json!({"command": "pw", "env": {"A=B": "x"}}),
            &[],
            &none_set
        )
        .is_none());
        assert!(
            codex_browser(&json!({"command": "pw", "env": {"": "x"}}), &[], &none_set).is_none()
        );
    }

    #[test]
    fn a_skipped_browser_says_which_variables_and_never_their_values() {
        let def = json!({"command": "pw", "env": {"PATH": "/secret-evil", "TOKEN": "t0k"}});
        let there = |name: &str| (name == "PATH").then(|| "/usr/bin".to_owned());
        let skip = codex_browser_checked(&def, &[], &there).unwrap_err();
        assert_eq!(skip, Skip::EnvConflict(vec!["PATH".to_owned()]));
        let note = skip.note().expect("a note");
        assert!(note.contains("PATH"), "{note}");
        assert!(
            !note.contains("TOKEN"),
            "only the conflicting names: {note}"
        );
        for value in ["/secret-evil", "/usr/bin", "t0k"] {
            assert!(!note.contains(value), "no value in the log: {note}");
        }
        // Not a stdio definition, or no definition: nothing was asked for.
        assert_eq!(Skip::NotStdio.note(), None);
        assert!(Skip::BadEnv.note().is_some());
        let bad = json!({"command": "pw", "env": {"A=B": "hidden"}});
        let skip = codex_browser_checked(&bad, &[], &none_set).unwrap_err();
        assert_eq!(skip, Skip::BadEnv);
        assert!(!skip.note().unwrap().contains("hidden"));
    }

    #[test]
    fn a_tilde_config_dir_is_expanded_the_way_the_launch_expands_it() {
        // Review round 1 (M5): `~/alt-config` was read as a folder named `~`.
        // The home folder is whatever the launch's own expansion says it is.
        let mut probe = BTreeMap::new();
        probe.insert("H".to_owned(), "~".to_owned());
        let home = crate::workspaces::resolved_env(&probe)[0].1.clone();
        if home == "~" {
            return; // no home folder to expand to on this machine
        }
        let mut env = BTreeMap::new();
        env.insert("CLAUDE_CONFIG_DIR".to_owned(), "~/alt-config".to_owned());
        assert_eq!(
            claude_config_path(Some(&env)),
            Some(Path::new(&home).join("alt-config").join(".claude.json"))
        );
        env.insert("CLAUDE_CONFIG_DIR".to_owned(), "~".to_owned());
        assert_eq!(
            claude_config_path(Some(&env)),
            Some(Path::new(&home).join(".claude.json"))
        );
        env.insert("CLAUDE_CONFIG_DIR".to_owned(), "/abs/x".to_owned());
        assert_eq!(
            claude_config_path(Some(&env)),
            Some(Path::new("/abs/x").join(".claude.json"))
        );
    }

    #[test]
    fn a_project_config_dir_is_the_one_read() {
        let dir = TestDir::new("worker-browser-dir");
        std::fs::write(
            dir.join(".claude.json"),
            serde_json::to_vec(&config()).unwrap(),
        )
        .unwrap();
        let mut env = std::collections::BTreeMap::new();
        env.insert(
            "CLAUDE_CONFIG_DIR".to_owned(),
            dir.to_string_lossy().into_owned(),
        );
        let path = for_launch("/elsewhere", Some(&env)).expect("a config for the worker");
        let saved: Value = serde_json::from_slice(&std::fs::read(path).unwrap()).unwrap();
        assert_eq!(saved["mcpServers"].as_object().unwrap().len(), 1);
    }
}
