//! "Always allow" for a call Claude refused only because its classifier was
//! unavailable.
//!
//! Claude's auto mode skips its server-side classifier for any call a
//! `permissions.allow` rule covers. When the classifier is down, the one way
//! a person can let such a call through for good is such a rule, so the
//! outage card offers to write one — on an explicit click, never by itself.
//!
//! Two halves, both pure enough to test against temp folders:
//!
//! - `derive_rule` picks the NARROWEST rule that covers the refused call, or
//!   none: `git push origin main` → `Bash(git push:*)`, an MCP tool → its exact
//!   name. It never answers a blanket `Bash`, and it refuses anything a prefix
//!   rule would widen into "run anything" (compound lines, interpreters).
//! - `add_allow_rules` merges rules into ONE of two non-shared settings files
//!   — the project's `.claude/settings.local.json` or the person's own
//!   `settings.json` — keeping every other key in its place.
//!
//! Claude 2.1.284 re-reads `.claude/settings.local.json` while a `claude -p`
//! session runs (a live probe on 2026-09-30: a rule written between two turns
//! let the second turn's call run with no ask), so a written rule applies to
//! the retry in the same process.

use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use serde::{Deserialize, Serialize};

use crate::paths::Canonical;

/// Where an "always allow" rule goes.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "lowercase")]
pub(crate) enum Scope {
    /// `<project>/.claude/settings.local.json`: this project, this machine,
    /// not committed.
    Project,
    /// `<Claude config dir>/settings.json`: every project of this person.
    User,
}

impl Scope {
    pub(crate) fn decision(self) -> &'static str {
        match self {
            Scope::Project => "allowed_project",
            Scope::User => "allowed_user",
        }
    }
}

/// The rule for one refused call, and the words it was taken from.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct DerivedRule {
    pub rule: String,
    /// For Bash, the leading command words the rule covers (`git push`).
    pub words: Option<String>,
}

/// Programs a prefix rule would turn into "run anything": shells,
/// interpreters, and commands whose job is to run another command. Claude
/// 2.1.284 itself strips such rules in auto mode ("strippedDangerousRules"),
/// so offering one would also promise something that does not happen.
const RUNS_ANYTHING: &[&str] = &[
    "sh",
    "bash",
    "zsh",
    "fish",
    "dash",
    "ksh",
    "csh",
    "tcsh",
    "pwsh",
    "powershell",
    "cmd",
    "python",
    "python2",
    "python3",
    "node",
    "deno",
    "bun",
    "bunx",
    "npx",
    "pnpx",
    "ruby",
    "perl",
    "php",
    "lua",
    "osascript",
    "awk",
    "gawk",
    "mawk",
    "nawk",
    "eval",
    "exec",
    "source",
    ".",
    "sudo",
    "su",
    "doas",
    "env",
    "xargs",
    "nohup",
    "time",
    "timeout",
    "watch",
    "nice",
    "command",
    "builtin",
    "ssh",
];

/// Tools organised by subcommand. For these, the program alone
/// (`Bash(git:*)`) would allow every subcommand — `git push --force` along
/// with `git status` — so a line whose second word is not a subcommand gets
/// no rule at all rather than a broad one.
const SUBCOMMAND_TOOLS: &[&str] = &[
    "git",
    "gh",
    "npm",
    "pnpm",
    "yarn",
    "cargo",
    "docker",
    "kubectl",
    "brew",
    "pip",
    "pip3",
    "uv",
    "go",
    "dotnet",
    "terraform",
    "aws",
    "gcloud",
    "az",
    "flyctl",
    "vercel",
    "wrangler",
];

/// The narrowest permission rule covering one refused call, or None when no
/// rule is narrow enough to offer.
pub(crate) fn derive_rule(tool: &str, command: Option<&str>) -> Option<DerivedRule> {
    let tool = tool.trim();
    if tool == "Bash" {
        let words = bash_words(command?)?;
        return Some(DerivedRule {
            rule: format!("Bash({words}:*)"),
            words: Some(words),
        });
    }
    if let Some(rest) = tool.strip_prefix("mcp__") {
        // `mcp__<server>__<tool>`, both parts named: the exact tool, never
        // the whole server.
        let (server, name) = rest.split_once("__")?;
        let plain = |s: &str| {
            !s.is_empty()
                && s.chars()
                    .all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-')
        };
        return (plain(server) && plain(name)).then(|| DerivedRule {
            rule: tool.to_string(),
            words: None,
        });
    }
    let named = tool.starts_with(|c: char| c.is_ascii_alphabetic())
        && tool.chars().all(|c| c.is_ascii_alphanumeric() || c == '_');
    named.then(|| DerivedRule {
        rule: tool.to_string(),
        words: None,
    })
}

/// The leading words of one simple shell command: `git push` for
/// `git push origin main`, `ls` for `ls -la`. None for anything a prefix rule
/// cannot describe safely.
fn bash_words(line: &str) -> Option<String> {
    let line = strip_leading_cd(line.trim());
    if !is_simple(line) {
        return None;
    }
    let mut tokens = line.split_whitespace();
    let program = tokens.next()?;
    // `FOO=1 git push` changes what runs; a rule on `FOO=1` means nothing.
    if program.contains('=') || program.contains(['"', '\'', '$', '*', '?', '[', '~']) {
        return None;
    }
    let base = program.rsplit('/').next().unwrap_or(program);
    let family = base.trim_end_matches(|c: char| c.is_ascii_digit() || c == '.');
    if RUNS_ANYTHING.contains(&base) || RUNS_ANYTHING.contains(&family) {
        return None;
    }
    let sub = tokens.next().filter(|word| {
        word.starts_with(|c: char| c.is_ascii_lowercase())
            && word
                .chars()
                .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-')
    });
    match sub {
        Some(sub) => Some(format!("{program} {sub}")),
        None if SUBCOMMAND_TOOLS.contains(&base) => None,
        None => Some(program.to_string()),
    }
}

/// `cd <dir> && rest` → `rest`: the agent's habit of changing folder first
/// says nothing about which command it wanted.
fn strip_leading_cd(line: &str) -> &str {
    let Some(rest) = line.strip_prefix("cd ") else {
        return line;
    };
    let rest = rest.trim_start();
    let dir_end = rest.find(char::is_whitespace).unwrap_or(rest.len());
    let (dir, after) = rest.split_at(dir_end);
    let plain_dir =
        !dir.is_empty() && !dir.contains([';', '&', '|', '<', '>', '(', ')', '`', '$', '"', '\'']);
    match after.trim_start().strip_prefix("&&") {
        Some(command) if plain_dir => command.trim_start(),
        _ => line,
    }
}

/// One command, no operators: nothing chained, piped, redirected, run in the
/// background or substituted. Quoted text may contain anything except a
/// substitution, which a double-quoted string still expands.
fn is_simple(line: &str) -> bool {
    if line.is_empty() {
        return false;
    }
    let mut chars = line.chars().peekable();
    let mut quote: Option<char> = None;
    while let Some(c) = chars.next() {
        match quote {
            Some('\'') => {
                if c == '\'' {
                    quote = None;
                }
            }
            Some(_) => match c {
                '"' => quote = None,
                '\\' => {
                    chars.next();
                }
                '`' => return false,
                '$' if chars.peek() == Some(&'(') => return false,
                _ => {}
            },
            None => match c {
                '\'' | '"' => quote = Some(c),
                '\\' => {
                    chars.next();
                }
                ';' | '&' | '|' | '<' | '>' | '(' | ')' | '`' | '{' | '}' | '\n' | '\r' => {
                    return false
                }
                '$' if chars.peek() == Some(&'(') => return false,
                _ => {}
            },
        }
    }
    quote.is_none()
}

/// The project's own, uncommitted settings file. None for a chat with no
/// project folder: there is nothing for "this project" to mean.
pub(crate) fn project_settings_path(cwd: &Path) -> Option<PathBuf> {
    (!cwd.as_os_str().is_empty()).then(|| cwd.join(".claude").join("settings.local.json"))
}

/// The person's own settings file: `$CLAUDE_CONFIG_DIR/settings.json` when
/// the chat was launched with one, otherwise `~/.claude/settings.json`.
pub(crate) fn user_settings_path(
    config_dir: Option<&Path>,
    home: Option<&Path>,
) -> Option<PathBuf> {
    let dir = match config_dir.filter(|dir| !dir.as_os_str().is_empty()) {
        Some(dir) => dir.to_path_buf(),
        None => home?.join(".claude"),
    };
    Some(dir.join("settings.json"))
}

/// Folders Claude reads MANAGED settings from. An organisation's policy is
/// not the person's to widen from a chat.
fn managed_roots() -> Vec<PathBuf> {
    vec![
        PathBuf::from("/Library/Application Support/ClaudeCode"),
        PathBuf::from("/etc/claude-code"),
        PathBuf::from(r"C:\Program Files\ClaudeCode"),
        PathBuf::from(r"C:\ProgramData\ClaudeCode"),
    ]
}

/// Whether the already-resolved folder `real` is one of `roots` or inside it.
fn under_any(real: &Path, roots: &[PathBuf]) -> bool {
    roots.iter().any(|root| {
        let root = root.canonical().unwrap_or_else(|_| root.clone());
        real.starts_with(&root)
    })
}

/// What a merge did.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Added {
    /// Rules newly written.
    pub added: Vec<String>,
    /// Rules the file already held; nothing was written for them.
    pub present: Vec<String>,
}

static WRITES: Mutex<()> = Mutex::new(());

/// Merge `rules` into `permissions.allow` of the settings file at `path`.
///
/// `scope` says which of the two files `path` must be; anything else is
/// refused before a byte is read. Refused too, leaving the file as it was:
/// a file that is not JSON, a `permissions` or `allow` of the wrong shape, a
/// symlinked file (it would write somewhere else), a project `.claude` folder
/// that is a symlink, and a path under a managed-settings folder. Every other
/// key keeps its value and its place; the file's indent and final newline are
/// kept; the write is a temp file renamed over the old one.
pub(crate) fn add_allow_rules(
    path: &Path,
    scope: Scope,
    rules: &[String],
) -> Result<Added, String> {
    let expected = match scope {
        Scope::Project => "settings.local.json",
        Scope::User => "settings.json",
    };
    if path.file_name().and_then(|n| n.to_str()) != Some(expected) {
        return Err(format!(
            "OctiqFlow writes allow rules only to {expected}, not {}.",
            path.display()
        ));
    }
    let parent = path
        .parent()
        .filter(|p| !p.as_os_str().is_empty())
        .ok_or("The settings file has no folder.")?;
    if scope == Scope::Project && parent.file_name().and_then(|n| n.to_str()) != Some(".claude") {
        return Err("A project allow rule goes only in the project's .claude folder.".into());
    }
    if rules.is_empty() {
        return Err("There is no rule to add.".into());
    }
    let _guard = WRITES.lock().unwrap_or_else(|e| e.into_inner());

    if scope == Scope::Project
        && fs::symlink_metadata(parent).is_ok_and(|meta| meta.file_type().is_symlink())
    {
        return Err(format!(
            "{} is a symlink, so a rule written there would land in another folder. Nothing was written.",
            parent.display()
        ));
    }
    fs::create_dir_all(parent).map_err(|e| format!("Cannot create {}: {e}", parent.display()))?;
    let real_parent = parent
        .canonical()
        .map_err(|e| format!("Cannot resolve {}: {e}", parent.display()))?;
    if under_any(&real_parent, &managed_roots()) {
        return Err("That is a managed settings folder, which OctiqFlow never writes.".into());
    }

    let original = match fs::symlink_metadata(path) {
        Ok(meta) if meta.file_type().is_symlink() => {
            return Err(format!(
                "{} is a symlink, so a rule written there would land in another file. Nothing was written.",
                path.display()
            ));
        }
        Ok(meta) if !meta.is_file() => {
            return Err(format!("{} is not a file.", path.display()));
        }
        Ok(_) => Some(
            fs::read_to_string(path).map_err(|e| format!("Cannot read {}: {e}", path.display()))?,
        ),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => None,
        Err(e) => return Err(format!("Cannot read {}: {e}", path.display())),
    };

    let text = original.as_deref().unwrap_or("");
    let (merged, added) = merge(text, rules)
        .map_err(|why| format!("{why} in {}. Nothing was written.", path.display()))?;
    if added.added.is_empty() {
        return Ok(added);
    }
    let temp = parent.join(format!(
        ".{expected}.octiq-{}.tmp",
        uuid::Uuid::new_v4().simple()
    ));
    let written = (|| {
        fs::write(&temp, merged.as_bytes())?;
        if let Ok(meta) = fs::metadata(path) {
            fs::set_permissions(&temp, meta.permissions())?;
        }
        fs::rename(&temp, path)
    })();
    if let Err(e) = written {
        let _ = fs::remove_file(&temp);
        return Err(format!("Cannot write {}: {e}", path.display()));
    }
    Ok(added)
}

/// The file's text with `rules` added to `permissions.allow`, or why not.
fn merge(text: &str, rules: &[String]) -> Result<(String, Added), String> {
    let mut root = if text.trim().is_empty() {
        Json::Object(Vec::new())
    } else {
        serde_json::from_str::<Json>(text).map_err(|_| "The settings file is not valid JSON")?
    };
    let Json::Object(top) = &mut root else {
        return Err("The settings file is not a JSON object".into());
    };
    let permissions = entry(top, "permissions", || Json::Object(Vec::new()));
    let Json::Object(permissions) = permissions else {
        return Err("\"permissions\" is not an object".into());
    };
    let allow = entry(permissions, "allow", || Json::Array(Vec::new()));
    let Json::Array(allow) = allow else {
        return Err("\"permissions.allow\" is not a list".into());
    };
    let mut result = Added::default();
    for rule in rules {
        let held = allow
            .iter()
            .any(|item| matches!(item, Json::String(s) if s == rule));
        if held || result.added.contains(rule) {
            result.present.push(rule.clone());
        } else {
            allow.push(Json::String(rule.clone()));
            result.added.push(rule.clone());
        }
    }
    let indent = detect_indent(text);
    let mut out = Vec::new();
    let formatter = serde_json::ser::PrettyFormatter::with_indent(indent.as_bytes());
    let mut serializer = serde_json::Serializer::with_formatter(&mut out, formatter);
    root.serialize(&mut serializer).map_err(|e| e.to_string())?;
    let mut out = String::from_utf8(out).map_err(|e| e.to_string())?;
    if text.is_empty() || text.ends_with('\n') {
        out.push('\n');
    }
    Ok((out, result))
}

/// The value under `key` (the last one, as a JSON reader takes it), added
/// at the end when missing.
fn entry<'a>(
    object: &'a mut Vec<(String, Json)>,
    key: &str,
    empty: impl FnOnce() -> Json,
) -> &'a mut Json {
    let at = match object.iter().rposition(|(k, _)| k == key) {
        Some(at) => at,
        None => {
            object.push((key.to_string(), empty()));
            object.len() - 1
        }
    };
    &mut object[at].1
}

/// The indent of the file's first indented line, so a rewrite keeps its
/// look. Two spaces when there is none to copy — what Claude itself writes.
fn detect_indent(text: &str) -> String {
    text.lines()
        .skip(1)
        .find_map(|line| {
            let lead = &line[..line.len() - line.trim_start().len()];
            let usable = !lead.is_empty()
                && lead.len() <= 8
                && (lead.chars().all(|c| c == ' ') || lead.chars().all(|c| c == '\t'));
            usable.then(|| lead.to_string())
        })
        .unwrap_or_else(|| "  ".to_string())
}

/// JSON that keeps object keys in the order the file had them. This crate's
/// serde_json sorts `Value` objects, which would reshuffle a person's
/// settings file on every write.
#[derive(Debug, Clone, PartialEq)]
enum Json {
    Null,
    Bool(bool),
    Number(serde_json::Number),
    String(String),
    Array(Vec<Json>),
    Object(Vec<(String, Json)>),
}

impl Serialize for Json {
    fn serialize<S: serde::Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        use serde::ser::{SerializeMap, SerializeSeq};
        match self {
            Json::Null => s.serialize_unit(),
            Json::Bool(b) => s.serialize_bool(*b),
            Json::Number(n) => n.serialize(s),
            Json::String(v) => s.serialize_str(v),
            Json::Array(items) => {
                let mut seq = s.serialize_seq(Some(items.len()))?;
                for item in items {
                    seq.serialize_element(item)?;
                }
                seq.end()
            }
            Json::Object(entries) => {
                let mut map = s.serialize_map(Some(entries.len()))?;
                for (k, v) in entries {
                    map.serialize_entry(k, v)?;
                }
                map.end()
            }
        }
    }
}

impl<'de> Deserialize<'de> for Json {
    fn deserialize<D: serde::Deserializer<'de>>(d: D) -> Result<Self, D::Error> {
        struct Visitor;
        impl<'de> serde::de::Visitor<'de> for Visitor {
            type Value = Json;
            fn expecting(&self, f: &mut std::fmt::Formatter) -> std::fmt::Result {
                f.write_str("JSON")
            }
            fn visit_unit<E>(self) -> Result<Json, E> {
                Ok(Json::Null)
            }
            fn visit_none<E>(self) -> Result<Json, E> {
                Ok(Json::Null)
            }
            fn visit_bool<E>(self, v: bool) -> Result<Json, E> {
                Ok(Json::Bool(v))
            }
            fn visit_i64<E>(self, v: i64) -> Result<Json, E> {
                Ok(Json::Number(v.into()))
            }
            fn visit_u64<E>(self, v: u64) -> Result<Json, E> {
                Ok(Json::Number(v.into()))
            }
            fn visit_f64<E: serde::de::Error>(self, v: f64) -> Result<Json, E> {
                serde_json::Number::from_f64(v)
                    .map(Json::Number)
                    .ok_or_else(|| E::custom("not a JSON number"))
            }
            fn visit_str<E>(self, v: &str) -> Result<Json, E> {
                Ok(Json::String(v.to_string()))
            }
            fn visit_string<E>(self, v: String) -> Result<Json, E> {
                Ok(Json::String(v))
            }
            fn visit_seq<A: serde::de::SeqAccess<'de>>(self, mut seq: A) -> Result<Json, A::Error> {
                let mut items = Vec::new();
                while let Some(item) = seq.next_element()? {
                    items.push(item);
                }
                Ok(Json::Array(items))
            }
            fn visit_map<A: serde::de::MapAccess<'de>>(self, mut map: A) -> Result<Json, A::Error> {
                let mut entries = Vec::new();
                while let Some((k, v)) = map.next_entry::<String, Json>()? {
                    entries.push((k, v));
                }
                Ok(Json::Object(entries))
            }
        }
        d.deserialize_any(Visitor)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn rule(tool: &str, command: Option<&str>) -> Option<String> {
        derive_rule(tool, command).map(|r| r.rule)
    }

    fn bash(line: &str) -> Option<String> {
        rule("Bash", Some(line))
    }

    #[test]
    fn a_bash_rule_names_the_program_and_its_subcommand() {
        assert_eq!(
            bash("git push origin main").as_deref(),
            Some("Bash(git push:*)")
        );
        assert_eq!(
            derive_rule("Bash", Some("git push origin main"))
                .unwrap()
                .words
                .as_deref(),
            Some("git push")
        );
        assert_eq!(bash("  git push  ").as_deref(), Some("Bash(git push:*)"));
        assert_eq!(
            bash("npm publish --tag next").as_deref(),
            Some("Bash(npm publish:*)")
        );
        assert_eq!(bash("ls -la").as_deref(), Some("Bash(ls:*)"));
        assert_eq!(bash("make").as_deref(), Some("Bash(make:*)"));
        assert_eq!(
            bash("./scripts/install.sh").as_deref(),
            Some("Bash(./scripts/install.sh:*)")
        );
        // Quoted text may hold what would otherwise be an operator.
        assert_eq!(
            bash("git commit -m 'fix: a; b | c'").as_deref(),
            Some("Bash(git commit:*)")
        );
        assert_eq!(
            bash("gh pr create --title \"a && b\"").as_deref(),
            Some("Bash(gh pr:*)")
        );
    }

    #[test]
    fn a_leading_cd_is_not_the_command() {
        assert_eq!(
            bash("cd x && git push").as_deref(),
            Some("Bash(git push:*)")
        );
        assert_eq!(
            bash("cd /Users/me/repo && git push origin HEAD").as_deref(),
            Some("Bash(git push:*)")
        );
        // Only one cd, and only a plain folder.
        assert_eq!(bash("cd x && git push && rm -rf y"), None);
        assert_eq!(bash("cd $(pwd) && git push"), None);
    }

    #[test]
    fn a_line_no_prefix_can_describe_gets_no_rule() {
        for line in [
            "",
            "   ",
            "a && b",
            "a || b",
            "a; b",
            "ls | wc -l",
            "echo hi > out.txt",
            "cat < in",
            "sleep 1 &",
            "echo $(whoami)",
            "echo \"$(whoami)\"",
            "echo `whoami`",
            "(cd x; ls)",
            "{ ls; }",
            "FOO=1 git push",
            "git push\nrm -rf /",
            "echo 'unterminated",
            "$HOME/bin/tool run",
        ] {
            assert_eq!(bash(line), None, "{line:?}");
        }
    }

    #[test]
    fn an_interpreter_or_wrapper_gets_no_rule() {
        for line in [
            "python x.py",
            "python3 -c 'print(1)'",
            "python3.12 x.py",
            "/usr/bin/python3 x.py",
            "node script.js",
            "npx some-tool",
            "bash -c 'ls'",
            "sh run.sh",
            "sudo rm x",
            "env FOO=1 ls",
            "xargs rm",
            "eval ls",
            "ssh host ls",
            "timeout 5 ls",
        ] {
            assert_eq!(bash(line), None, "{line:?}");
        }
    }

    #[test]
    fn a_subcommand_tool_without_a_subcommand_gets_no_program_wide_rule() {
        // Bash(git:*) would allow git push --force along with git status.
        assert_eq!(bash("git -C repo push"), None);
        assert_eq!(bash("git"), None);
        assert_eq!(bash("cargo +nightly build"), None);
        assert_eq!(bash("git status").as_deref(), Some("Bash(git status:*)"));
    }

    #[test]
    fn never_a_blanket_rule() {
        for line in ["git push", "ls", "*", "Bash", ""] {
            let rule = bash(line);
            assert_ne!(rule.as_deref(), Some("Bash"));
            assert_ne!(rule.as_deref(), Some("Bash(*)"));
            assert_ne!(rule.as_deref(), Some("Bash(:*)"));
        }
        assert_eq!(rule("Bash", None), None);
        assert_eq!(rule("*", None), None);
        assert_eq!(rule("", None), None);
    }

    #[test]
    fn an_mcp_rule_is_the_exact_tool() {
        assert_eq!(
            rule("mcp__claude_ai_Higgfield__media_upload", None).as_deref(),
            Some("mcp__claude_ai_Higgfield__media_upload")
        );
        assert_eq!(
            rule("mcp__octiq__ask_user", Some("ignored")).as_deref(),
            Some("mcp__octiq__ask_user")
        );
        // Never a whole server.
        assert_eq!(rule("mcp__octiq", None), None);
        assert_eq!(rule("mcp__octiq__", None), None);
        assert_eq!(rule("mcp____tool", None), None);
        assert_eq!(rule("mcp__a b__c", None), None);
    }

    #[test]
    fn another_tool_is_its_name() {
        assert_eq!(rule("WebFetch", None).as_deref(), Some("WebFetch"));
        assert_eq!(rule("Write", Some("x")).as_deref(), Some("Write"));
        assert_eq!(rule("A tool", None), None);
        assert_eq!(rule("Bash(x)", None), None);
    }

    fn temp() -> PathBuf {
        let dir = std::env::temp_dir().join(format!("octiq-allow-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn rules(list: &[&str]) -> Vec<String> {
        list.iter().map(|s| s.to_string()).collect()
    }

    #[test]
    fn a_new_project_file_is_created_with_the_rule() {
        let project = temp();
        let path = project_settings_path(&project).unwrap();
        let added = add_allow_rules(&path, Scope::Project, &rules(&["Bash(git push:*)"])).unwrap();
        assert_eq!(added.added, rules(&["Bash(git push:*)"]));
        assert_eq!(
            fs::read_to_string(&path).unwrap(),
            "{\n  \"permissions\": {\n    \"allow\": [\n      \"Bash(git push:*)\"\n    ]\n  }\n}\n"
        );
        fs::remove_dir_all(project).unwrap();
    }

    #[test]
    fn a_merge_keeps_every_other_key_in_its_place() {
        let project = temp();
        let path = project_settings_path(&project).unwrap();
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        let before = "{\n    \"zeta\": 1,\n    \"permissions\": {\n        \"deny\": [\"Bash(rm:*)\"],\n        \"allow\": [\"Read\"],\n        \"defaultMode\": \"auto\"\n    },\n    \"alpha\": {\"nested\": [1, 2.5, null, true]}\n}";
        fs::write(&path, before).unwrap();
        let added = add_allow_rules(
            &path,
            Scope::Project,
            &rules(&["Bash(git push:*)", "Read", "mcp__a__b"]),
        )
        .unwrap();
        assert_eq!(added.added, rules(&["Bash(git push:*)", "mcp__a__b"]));
        assert_eq!(added.present, rules(&["Read"]));
        let after = fs::read_to_string(&path).unwrap();
        // Order kept, four-space indent kept, no newline added where none was.
        assert_eq!(
            after,
            "{\n    \"zeta\": 1,\n    \"permissions\": {\n        \"deny\": [\n            \"Bash(rm:*)\"\n        ],\n        \"allow\": [\n            \"Read\",\n            \"Bash(git push:*)\",\n            \"mcp__a__b\"\n        ],\n        \"defaultMode\": \"auto\"\n    },\n    \"alpha\": {\n        \"nested\": [\n            1,\n            2.5,\n            null,\n            true\n        ]\n    }\n}"
        );
        // Same meaning as before, plus the two rules.
        let before: serde_json::Value = serde_json::from_str(before).unwrap();
        let after: serde_json::Value = serde_json::from_str(&after).unwrap();
        assert_eq!(before["alpha"], after["alpha"]);
        assert_eq!(before["permissions"]["deny"], after["permissions"]["deny"]);
        fs::remove_dir_all(project).unwrap();
    }

    #[test]
    fn a_rule_already_there_is_not_written_twice() {
        let project = temp();
        let path = project_settings_path(&project).unwrap();
        add_allow_rules(&path, Scope::Project, &rules(&["Bash(git push:*)"])).unwrap();
        let first = fs::read_to_string(&path).unwrap();
        let again = add_allow_rules(&path, Scope::Project, &rules(&["Bash(git push:*)"])).unwrap();
        assert!(again.added.is_empty());
        assert_eq!(again.present, rules(&["Bash(git push:*)"]));
        assert_eq!(fs::read_to_string(&path).unwrap(), first);
        fs::remove_dir_all(project).unwrap();
    }

    #[test]
    fn a_file_that_is_not_settings_json_is_left_alone() {
        let project = temp();
        let path = project_settings_path(&project).unwrap();
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        for bad in [
            "{ not json",
            "[1, 2]",
            "{\"permissions\": []}",
            "{\"permissions\": {\"allow\": \"Bash\"}}",
        ] {
            fs::write(&path, bad).unwrap();
            let err = add_allow_rules(&path, Scope::Project, &rules(&["Read"])).unwrap_err();
            assert!(err.contains("Nothing was written"), "{err}");
            assert_eq!(fs::read_to_string(&path).unwrap(), bad);
        }
        fs::remove_dir_all(project).unwrap();
    }

    #[test]
    fn shared_and_managed_settings_are_never_written() {
        let project = temp();
        // The committed, shared project file.
        let shared = project.join(".claude").join("settings.json");
        assert!(add_allow_rules(&shared, Scope::Project, &rules(&["Read"])).is_err());
        assert!(!shared.exists());
        // A project-scope file outside a .claude folder.
        let loose = project.join("settings.local.json");
        assert!(add_allow_rules(&loose, Scope::Project, &rules(&["Read"])).is_err());
        assert!(!loose.exists());
        // The managed folders, and anything inside one.
        for root in managed_roots() {
            let path = root.join("managed-settings.json");
            assert!(add_allow_rules(&path, Scope::User, &rules(&["Read"])).is_err());
            assert!(
                add_allow_rules(&root.join("settings.json"), Scope::User, &rules(&["Read"]))
                    .is_err()
            );
        }
        let managed = project.canonical().unwrap().join("ClaudeCode");
        fs::create_dir_all(managed.join("sub")).unwrap();
        assert!(under_any(&managed, std::slice::from_ref(&managed)));
        assert!(under_any(
            &managed.join("sub"),
            std::slice::from_ref(&managed)
        ));
        assert!(!under_any(
            &project.canonical().unwrap(),
            std::slice::from_ref(&managed)
        ));
        // A sibling whose name merely starts the same is not inside.
        assert!(!under_any(
            &project.canonical().unwrap().join("ClaudeCode-x"),
            &[managed]
        ));
        fs::remove_dir_all(project).unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn a_symlink_that_would_write_elsewhere_is_refused() {
        let project = temp();
        let elsewhere = temp();
        // The project's .claude is a link to another folder.
        std::os::unix::fs::symlink(&elsewhere, project.join(".claude")).unwrap();
        let path = project_settings_path(&project).unwrap();
        let err = add_allow_rules(&path, Scope::Project, &rules(&["Read"])).unwrap_err();
        assert!(err.contains("symlink"), "{err}");
        assert!(!elsewhere.join("settings.local.json").exists());

        // The settings file itself is a link.
        let user = temp();
        let target = elsewhere.join("real.json");
        fs::write(&target, "{}").unwrap();
        std::os::unix::fs::symlink(&target, user.join("settings.json")).unwrap();
        let err = add_allow_rules(&user.join("settings.json"), Scope::User, &rules(&["Read"]))
            .unwrap_err();
        assert!(err.contains("symlink"), "{err}");
        assert_eq!(fs::read_to_string(&target).unwrap(), "{}");
        for dir in [project, elsewhere, user] {
            fs::remove_dir_all(dir).unwrap();
        }
    }

    #[test]
    fn the_user_file_follows_claude_config_dir() {
        let home = PathBuf::from("/home/me");
        assert_eq!(
            user_settings_path(None, Some(&home)),
            Some(home.join(".claude").join("settings.json"))
        );
        let custom = PathBuf::from("/work/claude-config");
        assert_eq!(
            user_settings_path(Some(&custom), Some(&home)),
            Some(custom.join("settings.json"))
        );
        assert_eq!(
            user_settings_path(Some(Path::new("")), Some(&home)),
            Some(home.join(".claude").join("settings.json"))
        );
        assert_eq!(user_settings_path(None, None), None);
        assert_eq!(project_settings_path(Path::new("")), None);

        let config = temp();
        let path = user_settings_path(Some(&config), None).unwrap();
        fs::write(&path, "{\n\t\"model\": \"opus\"\n}\n").unwrap();
        add_allow_rules(&path, Scope::User, &rules(&["mcp__a__b"])).unwrap();
        assert_eq!(
            fs::read_to_string(&path).unwrap(),
            "{\n\t\"model\": \"opus\",\n\t\"permissions\": {\n\t\t\"allow\": [\n\t\t\t\"mcp__a__b\"\n\t\t]\n\t}\n}\n"
        );
        fs::remove_dir_all(config).unwrap();
    }
}
