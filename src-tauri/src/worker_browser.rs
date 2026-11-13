//! What a Claude orchestration worker keeps of the person's MCP servers.
//!
//! A worker starts with `--strict-mcp-config` and OctiqFlow's own MCP config,
//! so it sees no server of the person's. That also took away the browser:
//! checked against claude 2.1 (`system/init` of a stream-json launch), the
//! person's `playwright` server is the only browser tool an ordinary chat has
//! (Claude in Chrome exists only with `--chrome`, which no launch passes).
//!
//! The person's definition of each server in `CLAUDE_WORKER_MCP_ON`, and of
//! nothing else, is written to a second config file the launch names with one
//! more `--mcp-config`. The definition is theirs unchanged (it may carry
//! `env` secrets, so the file is private and never put on the command line).
//! A config that cannot be read changes nothing: the worker starts without a
//! browser, as before.
//!
//! A Codex worker gets the same browser from the same definition: a stdio
//! `playwright` is rendered as one whole inline TOML table for a single `-c
//! mcp_servers.playwright=...` override (`codex_playwright`). Codex has no
//! config file to point at, so the entry (and its `env`, if any) is on the
//! launch line. No definition, or one Codex cannot take, adds nothing.

use serde_json::{json, Map, Value};
use sha2::{Digest, Sha256};
use std::path::{Path, PathBuf};

/// The browser server a worker keeps, by the name the person gave it.
pub const PLAYWRIGHT: &str = "playwright";

/// MCP servers a Claude worker keeps, by the name the person gave them.
pub const CLAUDE_WORKER_MCP_ON: &[&str] = &[PLAYWRIGHT];

/// The allowlisted servers among those the person configured for `cwd`:
/// user scope first, the project's own (local scope, `projects[cwd]`) on top,
/// as Claude resolves a name that exists in both.
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

/// Where the person's Claude keeps its settings (`.claude.json`): the
/// project's `CLAUDE_CONFIG_DIR` when it sets one, else the home folder.
fn claude_config_path(env: Option<&std::collections::BTreeMap<String, String>>) -> Option<PathBuf> {
    let dir = env
        .and_then(|env| env.get("CLAUDE_CONFIG_DIR").cloned())
        .or_else(|| std::env::var("CLAUDE_CONFIG_DIR").ok())
        .filter(|dir| !dir.trim().is_empty());
    match dir {
        Some(dir) => Some(Path::new(&dir).join(".claude.json")),
        None => crate::paths::home_dir().map(|home| home.join(".claude.json")),
    }
}

/// The person's allowlisted servers for a launch in `cwd`, read from their
/// Claude settings. Empty when there are none or the file cannot be read.
fn person_servers(
    cwd: &str,
    env: Option<&std::collections::BTreeMap<String, String>>,
) -> Map<String, Value> {
    let read = || -> Option<Map<String, Value>> {
        let text = std::fs::read_to_string(claude_config_path(env)?).ok()?;
        let config: Value = serde_json::from_str(&text).ok()?;
        Some(allowlisted_servers(&config, cwd))
    };
    read().unwrap_or_default()
}

/// The second `--mcp-config` file for a Claude worker in `cwd`, or `None`
/// when the person has no allowlisted server or it cannot be set up.
pub fn for_launch(
    cwd: &str,
    env: Option<&std::collections::BTreeMap<String, String>>,
) -> Option<PathBuf> {
    let servers = person_servers(cwd, env);
    if servers.is_empty() {
        return None;
    }
    let dir = crate::paths::home_dir()?.join(".octiqflow").join("mcp");
    write_config(&dir, &servers)
}

/// The inline TOML table for a Codex worker's `playwright` in `cwd`, from the
/// same definition a Claude worker reads; `None` adds nothing.
pub fn for_codex_launch(
    cwd: &str,
    env: Option<&std::collections::BTreeMap<String, String>>,
) -> Option<String> {
    codex_playwright(person_servers(cwd, env).get(PLAYWRIGHT)?)
}

/// `{command="npx",args=["-y","..."],env={KEY="v"}}`: the whole entry, since
/// a partial `-c` override of a server does not merge. Only a stdio server
/// qualifies (no `type`, or `"stdio"`), with a non-empty string `command`,
/// string `args` and string `env` values. Anything else is `None`, never an
/// error: the worker just starts without a browser.
pub fn codex_playwright(definition: &Value) -> Option<String> {
    use crate::agent_provider::toml_string;
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
    let mut entry = format!("{{command={}", toml_string(command));
    if let Some(args) = object.get("args") {
        let args: Option<Vec<String>> = args
            .as_array()?
            .iter()
            .map(|arg| arg.as_str().map(toml_string))
            .collect();
        entry.push_str(&format!(",args=[{}]", args?.join(",")));
    }
    if let Some(vars) = object.get("env") {
        let vars: Option<Vec<String>> = vars
            .as_object()?
            .iter()
            .map(|(name, value)| {
                Some(format!(
                    "{}={}",
                    toml_string(name),
                    toml_string(value.as_str()?)
                ))
            })
            .collect();
        entry.push_str(&format!(",env={{{}}}", vars?.join(",")));
    }
    entry.push('}');
    Some(entry)
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

    #[test]
    fn a_stdio_playwright_becomes_one_whole_inline_table() {
        let entry = codex_playwright(&json!({
            "type": "stdio",
            "command": "npx",
            "args": ["-y", "@playwright/mcp@latest", "--executable-path", "/A B/Brave \"x\""],
            "env": {"TOKEN": "s3cret", "A-B": "c:\\d"}
        }))
        .expect("an entry");
        assert_eq!(
            entry,
            r#"{command="npx",args=["-y","@playwright/mcp@latest","--executable-path","/A B/Brave \"x\""],env={"A-B"="c:\\d","TOKEN"="s3cret"}}"#
        );
        // No type, no args, no env is still a stdio server.
        assert_eq!(
            codex_playwright(&json!({"command": "pw"})).unwrap(),
            r#"{command="pw"}"#
        );
        assert_eq!(
            codex_playwright(&json!({"command": "pw", "env": {}, "args": []})).unwrap(),
            r#"{command="pw",args=[],env={}}"#
        );
    }

    #[test]
    fn a_definition_codex_cannot_take_adds_nothing() {
        for bad in [
            json!({"type": "http", "url": "https://x"}),
            json!({"type": "sse", "command": "x"}),
            json!({"url": "https://x"}),
            json!({"command": ""}),
            json!({"command": 3}),
            json!({"command": "x", "args": [1]}),
            json!({"command": "x", "args": "-y"}),
            json!({"command": "x", "env": {"A": 1}}),
            json!("npx"),
        ] {
            assert!(codex_playwright(&bad).is_none(), "{bad}");
        }
    }

    #[test]
    fn the_codex_entry_comes_from_the_same_source_as_the_claude_file() {
        let dir = TestDir::new("worker-browser-codex");
        let mut env = std::collections::BTreeMap::new();
        env.insert(
            "CLAUDE_CONFIG_DIR".to_owned(),
            dir.to_string_lossy().into_owned(),
        );
        assert!(for_codex_launch("/a", Some(&env)).is_none(), "no file");
        std::fs::write(
            dir.join(".claude.json"),
            serde_json::to_vec(&config()).unwrap(),
        )
        .unwrap();
        let user = for_codex_launch("/elsewhere", Some(&env)).expect("user scope");
        assert!(user.starts_with("{command=\"npx\""), "{user}");
        let project = for_codex_launch("/work/app", Some(&env)).expect("project scope");
        assert_eq!(project, "{command=\"local-playwright\"}");
        std::fs::write(
            dir.join(".claude.json"),
            r#"{"mcpServers":{"sentry":{"command":"x"}}}"#,
        )
        .unwrap();
        assert!(
            for_codex_launch("/a", Some(&env)).is_none(),
            "no playwright"
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
