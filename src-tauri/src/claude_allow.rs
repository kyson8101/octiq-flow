//! "Always allow" for a call Claude's auto mode refused: because its
//! classifier was unavailable (an outage card), or because the classifier
//! judged it (a safety card).
//!
//! Claude's auto mode skips its server-side classifier for any call a
//! `permissions.allow` rule covers — for a judged call too: a live probe on
//! 2026-10-01 (claude 2.1.284) saw `git push --force origin main` refused as
//! [Git Destructive], then run with no refusal once
//! `Bash(git push --force origin main)` was in the project's settings. Such a
//! rule is the one way a person can let a refused call through, and it lasts:
//! it is never "once" (see `safety_block::EXACT_GRANT_WITHDRAWN`). So a card
//! offers to write one on an explicit click, never by itself, and says that
//! matching calls skip the check from then on.
//!
//! Three parts, all pure enough to test against temp folders:
//!
//! - `derive_rule` picks the NARROWEST rule that covers a call an OUTAGE
//!   refused, or none: `git push origin main` → `Bash(git push:*)`, an MCP
//!   tool → its exact name. It never answers a blanket `Bash`, and it refuses
//!   anything a prefix rule would widen into "run anything" (compound lines,
//!   interpreters).
//! - `derive_judged_rules` is stricter, for a call the classifier JUDGED:
//!   exact commands only, one per segment it is safe to name.
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

/// More programs that run another program, never named by a judged EXACT
/// rule (`exact_nameable`) — whether first on the line or later. Kept apart
/// from RUNS_ANYTHING so the outage card's prefix rules stay as they were.
const RUNS_ANOTHER: &[&str] = &[
    "parallel",
    // Build and task runners run whatever their project file says today.
    "make",
    "gmake",
    "just",
    "task",
    "entr",
    "flock",
    "script",
    "expect",
    "strace",
    "ltrace",
    "gdb",
    "lldb",
    "chroot",
    "unshare",
    "nsenter",
    "setsid",
    "stdbuf",
    "ionice",
    "caffeinate",
    // Openers hand a file to whatever program is registered for it.
    "open",
    "xdg-open",
    "start",
];

/// Options and subcommands that turn an otherwise plain program into one
/// that runs another: `find -exec`, `git bisect run`, `npm run`. A segment
/// carrying one is never named by a judged rule, because the program it hands
/// over to — often a script in the project — can change after the rule is
/// written while the rule's text stays the same. `find`'s own writing actions
/// are here too, since an exact rule for them is no narrower than `rm`.
const HANDS_OFF: &[(&str, &[&str])] = &[
    ("find", FIND_ACTIONS),
    ("gfind", FIND_ACTIONS),
    (
        "git",
        &[
            // A config value can name a pager, an ssh command or a `!` alias.
            "-c",
            "--config-env",
            "--exec",
            "-x",
            "run",
            "foreach",
            "filter-branch",
        ],
    ),
    ("npm", PACKAGE_SCRIPTS),
    ("pnpm", PACKAGE_SCRIPTS),
    ("yarn", PACKAGE_SCRIPTS),
    ("cargo", &["run"]),
    ("go", &["run", "generate"]),
];

const FIND_ACTIONS: &[&str] = &[
    "-exec", "-execdir", "-ok", "-okdir", "-delete", "-fprint", "-fprint0", "-fprintf", "-fls",
];

/// What runs a package.json script or a downloaded package.
const PACKAGE_SCRIPTS: &[&str] = &[
    "run",
    "run-script",
    "exec",
    "dlx",
    "test",
    "start",
    "restart",
    "stop",
    "create",
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

/// What "Always allow" may write for a call Claude's classifier JUDGED and
/// refused, as opposed to one an outage refused unjudged.
///
/// A judgement is not an outage: the classifier looked at this call and said
/// no. So the rule is the narrowest Claude has — the exact command, never a
/// prefix — and it is offered only for a shell command. `rm -f x` is allowed
/// as `Bash(rm -f x)` and nothing else; no `Bash(rm:*)` is ever derived here.
/// A tool other than Bash gets nothing: its rule would be the whole tool
/// (every URL, every file), which is far wider than the call.
///
/// A compound line is cut into its segments the way Claude checks them —
/// Claude matches each segment of `a; b && c | d` against the rules on its
/// own — and each segment that is safe to name gets its exact rule. The rest
/// are `uncovered`: Claude still judges a line with any uncovered segment, so
/// the retry may well be refused again (a live probe on 2026-10-01, claude
/// 2.1.284, auto mode: `git push --force origin main; git status --short`
/// with only `Bash(git status --short)` allowed was refused again; with both
/// exact rules it ran).
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub(crate) struct JudgedRules {
    /// One exact `Bash(<segment>)` rule per nameable segment, in line order.
    pub rules: Vec<String>,
    /// Segments no rule names.
    pub uncovered: Vec<String>,
}

/// Longer than this, an exact rule is a script in disguise.
const EXACT_RULE_MAX: usize = 300;

/// The exact rules for a judged refusal, or None when not one segment of the
/// call is safe to name — then the card offers no allow at all.
pub(crate) fn derive_judged_rules(tool: &str, command: Option<&str>) -> Option<JudgedRules> {
    if tool.trim() != "Bash" {
        return None;
    }
    let mut judged = JudgedRules::default();
    for segment in segments(command?.trim())? {
        let rule = format!("Bash({})", segment.text);
        if !segment.redirected && exact_nameable(&segment.text) {
            if !judged.rules.contains(&rule) {
                judged.rules.push(rule);
            }
        } else if !judged.uncovered.contains(&segment.text) {
            judged.uncovered.push(segment.text);
        }
    }
    (!judged.rules.is_empty()).then_some(judged)
}

/// One command of a compound line.
#[derive(Debug, Clone, PartialEq, Eq)]
struct Segment {
    text: String,
    /// It reads or writes a file through `<` or `>`.
    redirected: bool,
}

/// A line cut at its top-level `;`, `&&`, `||`, `|` and newlines. None for
/// anything whose parts cannot be told apart this simply — a substitution,
/// a subshell or group, a background job, a heredoc, a comment — because a
/// cut that differs from Claude's would name a rule nothing ever matches, or
/// worse, one that matches more than the person was shown.
fn segments(line: &str) -> Option<Vec<Segment>> {
    let mut out = Vec::new();
    let mut text = String::new();
    let mut redirected = false;
    let mut quote: Option<char> = None;
    let mut chars = line.chars().peekable();
    let mut cut = |text: &mut String, redirected: &mut bool| {
        let trimmed = text.trim();
        if !trimmed.is_empty() {
            out.push(Segment {
                text: trimmed.to_string(),
                redirected: *redirected,
            });
        }
        text.clear();
        *redirected = false;
    };
    while let Some(c) = chars.next() {
        match quote {
            Some('\'') => {
                text.push(c);
                if c == '\'' {
                    quote = None;
                }
            }
            Some(_) => {
                text.push(c);
                match c {
                    '"' => quote = None,
                    '\\' => text.extend(chars.next()),
                    '`' => return None,
                    '$' if chars.peek() == Some(&'(') => return None,
                    _ => {}
                }
            }
            None => match c {
                '\'' | '"' => {
                    quote = Some(c);
                    text.push(c);
                }
                '\\' => {
                    text.push(c);
                    text.extend(chars.next());
                }
                ';' | '\n' => cut(&mut text, &mut redirected),
                '&' if chars.peek() == Some(&'&') => {
                    chars.next();
                    cut(&mut text, &mut redirected);
                }
                '|' => {
                    // `||`, `|` and `|&` all end the command before them.
                    if matches!(chars.peek(), Some('|') | Some('&')) {
                        chars.next();
                    }
                    cut(&mut text, &mut redirected);
                }
                '<' if chars.peek() == Some(&'<') => return None,
                '<' | '>' => {
                    redirected = true;
                    text.push(c);
                    // `2>&1`, `>&2`: the `&` belongs to the redirect, and so
                    // does the `|` of `>|` — it is not a pipe.
                    if chars.peek() == Some(&'&') || (c == '>' && chars.peek() == Some(&'|')) {
                        text.extend(chars.next());
                    }
                }
                // `&>` is a redirect; a lone `&` runs a job in the background.
                '&' if chars.peek() == Some(&'>') => {
                    redirected = true;
                    text.push(c);
                }
                '&' | '`' | '(' | ')' | '{' | '}' | '\r' => return None,
                '$' if chars.peek() == Some(&'(') => return None,
                '#' if text.is_empty() || text.ends_with(char::is_whitespace) => return None,
                _ => text.push(c),
            },
        }
    }
    if quote.is_some() {
        return None;
    }
    cut(&mut text, &mut redirected);
    (!out.is_empty()).then_some(out)
}

/// Whether one segment can be named by an exact rule that allows exactly
/// what the card shows and nothing more.
fn exact_nameable(segment: &str) -> bool {
    if segment.is_empty() || segment.len() > EXACT_RULE_MAX || !is_simple(segment) {
        return false;
    }
    // `*` is a wildcard inside a rule, and a parenthesis would end it.
    if segment.contains(['*', '(', ')']) {
        return false;
    }
    // A variable or an unquoted glob makes the rule's text mean different
    // commands on different days.
    let mut quote: Option<char> = None;
    let mut chars = segment.chars();
    while let Some(c) = chars.next() {
        match (quote, c) {
            (Some('\''), '\'') => quote = None,
            (Some('\''), _) => {}
            (Some(_), '"') => quote = None,
            (_, '\\') => {
                chars.next();
            }
            (_, '$') => return false,
            (None, '\'' | '"') => quote = Some(c),
            (None, '?' | '[') => return false,
            _ => {}
        }
    }
    let mut words = segment.split_whitespace();
    let Some(program) = words.next() else {
        return false;
    };
    if program.contains(['=', '"', '\'', '\\', '~']) {
        return false;
    }
    // A program named by its path is a file, and a file's contents change:
    // `./deploy.sh` today is not `./deploy.sh` tomorrow.
    if program.contains('/') {
        return false;
    }
    let base = program;
    if is_runner(base) {
        return false;
    }
    // `tee` writes whatever is piped into it over the files it names, so
    // `Bash(tee x)` would let any content overwrite x: the same reason a
    // redirected segment is never named.
    if base == "tee" {
        return false;
    }
    let args: Vec<&str> = words.collect();
    // A runner anywhere on the line, not only first: `find … -exec sh {} \;`,
    // `docker exec box sh`, `kubectl exec pod -- bash`.
    if args.iter().any(|word| names_a_runner(word)) {
        return false;
    }
    if let Some((_, triggers)) = HANDS_OFF.iter().find(|(name, _)| *name == base) {
        let hands_off = args.iter().any(|word| {
            let word = word.trim_matches(['"', '\'']);
            triggers.iter().any(|t| {
                word == *t
                    || word
                        .strip_prefix(t)
                        .is_some_and(|rest| rest.starts_with('='))
            })
        });
        if hands_off {
            return false;
        }
    }
    if matches!(base, "rm" | "rmdir" | "unlink") {
        return removes_only_plain_relative_paths(args.into_iter());
    }
    true
}

/// Whether a program name (a basename) is one that runs another program,
/// version digits aside (`python3.12` is `python`).
fn is_runner(base: &str) -> bool {
    let family = base.trim_end_matches(|c: char| c.is_ascii_digit() || c == '.');
    [base, family]
        .iter()
        .any(|name| RUNS_ANYTHING.contains(name) || RUNS_ANOTHER.contains(name))
}

/// Whether one argument names a program that runs another — as itself
/// (`sh`), by a path (`/bin/bash`), with a version (`python3.12`), or as an
/// option's value (`--pre=bash`). A lone `.` is a folder here, not `source`:
/// `git add .` and `find .` run nothing.
fn names_a_runner(word: &str) -> bool {
    fn runner(w: &str) -> bool {
        let base = w.rsplit(['/', '\\']).next().unwrap_or(w);
        base != "." && is_runner(base)
    }
    let word = word.replace(['"', '\''], "");
    runner(&word) || word.rsplit('=').next().is_some_and(runner)
}

/// The one shape of `rm` (and `rmdir`, `unlink`) an exact rule may name:
/// every target a plain path relative to the folder Claude runs in — not
/// absolute, not under `~`, not `.` itself, and with no `..` component — so
/// a recursive flag can only ever reach inside that folder. The person's own
/// `rm -f web/pnpm-workspace.yaml` is such a line; `rm -rf /`, `rm -rf ~`,
/// `rm -r ../x`, `rm /etc/hosts` and `rm -rf .` are not. Absolute paths are
/// refused even inside the project: the rule is not tied to one folder.
fn removes_only_plain_relative_paths<'a>(words: impl Iterator<Item = &'a str>) -> bool {
    let mut options_done = false;
    for word in words {
        if !options_done && word == "--" {
            options_done = true;
            continue;
        }
        if !options_done && word.starts_with('-') {
            continue;
        }
        let path = word.trim_matches(['"', '\'']);
        let plain = !path.is_empty()
            && !path.starts_with('/')
            && !path.starts_with('~')
            && !path.contains('\\')
            // `C:/x`: absolute on Windows.
            && path.as_bytes().get(1) != Some(&b':')
            && !path.split('/').any(|part| part == "..")
            && !path.split('/').all(|part| part.is_empty() || part == ".");
        if !plain {
            return false;
        }
    }
    true
}

/// The project's own, uncommitted settings file. None for a chat with no
/// project folder: there is nothing for "this project" to mean.
pub(crate) fn project_settings_path(cwd: &Path) -> Option<PathBuf> {
    (!cwd.as_os_str().is_empty()).then(|| cwd.join(".claude").join("settings.local.json"))
}

/// The person's own settings file, resolved and confined, or why "Always
/// allow everywhere" may not write it.
///
/// `config_dir` is the `CLAUDE_CONFIG_DIR` Claude was launched with, exactly
/// as it got it; none means `~/.claude`. A relative one is read the way
/// Claude reads it, from `launch_cwd` (the folder the process started in),
/// never from this server's own folder. The folder is then canonicalized, so
/// a symlink or `..` cannot dress one folder up as another, and refused when
/// it is not plainly the person's own:
///
/// - inside any `.claude` folder other than `~/.claude` itself: that is a
///   project's settings folder, and its `settings.json` is the SHARED file,
///   committed for everyone who clones the project;
/// - inside `project` (the chat's own folder) or inside any git work tree:
///   whatever is written there can be committed;
/// - inside a managed-settings folder: an organisation's policy.
pub(crate) fn user_settings_target(
    config_dir: Option<&str>,
    launch_cwd: &Path,
    home: Option<&Path>,
    project: Option<&Path>,
) -> Result<PathBuf, String> {
    let home_claude = home.map(|home| home.join(".claude"));
    let dir = match config_dir.map(str::trim).filter(|dir| !dir.is_empty()) {
        Some(dir) if Path::new(dir).is_absolute() => PathBuf::from(dir),
        Some(dir) if launch_cwd.is_absolute() => launch_cwd.join(dir),
        Some(_) => {
            return Err(
                "Claude's config folder is relative and its launch folder is unknown.".into(),
            )
        }
        None => home_claude
            .clone()
            .ok_or("Claude's own settings folder could not be found.")?,
    };
    let real = resolve_existing(&dir)?;
    if under_any(&real, &managed_roots()) {
        return Err("That is a managed settings folder, which OctiqFlow never writes.".into());
    }
    let personal = home_claude
        .as_deref()
        .and_then(|dir| resolve_existing(dir).ok());
    if personal.as_deref() != Some(real.as_path()) {
        let shared = || {
            Err(format!(
                "{} is not your own Claude settings folder: a file there is shared with the project. Nothing was written.",
                real.display()
            ))
        };
        if real
            .components()
            .any(|part| part.as_os_str() == std::ffi::OsStr::new(".claude"))
        {
            return shared();
        }
        if let Some(project) = project.filter(|p| !p.as_os_str().is_empty()) {
            if resolve_existing(project).is_ok_and(|project| real.starts_with(project)) {
                return shared();
            }
        }
        if real.ancestors().any(|dir| dir.join(".git").exists()) {
            return shared();
        }
    }
    Ok(real.join("settings.json"))
}

/// `path` with its longest existing ancestor canonicalized and the rest
/// appended, so a folder not created yet still resolves. A `..` in the part
/// that does not exist cannot be resolved honestly and is refused.
fn resolve_existing(path: &Path) -> Result<PathBuf, String> {
    let mut missing = Vec::new();
    let mut at = path;
    loop {
        match at.canonical() {
            Ok(real) => {
                let mut real = real;
                for part in missing.iter().rev() {
                    real.push(part);
                }
                return Ok(real);
            }
            Err(_) => {
                let (Some(parent), Some(name)) = (at.parent(), at.file_name()) else {
                    return Err(format!("Cannot resolve {}.", path.display()));
                };
                missing.push(name.to_os_string());
                at = parent;
            }
        }
    }
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

    fn temp() -> crate::test_dir::TestDir {
        crate::test_dir::TestDir::new("allow")
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
    }

    #[test]
    fn the_user_file_follows_claude_config_dir() {
        let root = temp();
        let real = |p: &Path| p.canonical().unwrap();
        let home = root.join("home");
        let project = root.join("project");
        fs::create_dir_all(&home).unwrap();
        fs::create_dir_all(&project).unwrap();
        let target =
            |dir: Option<&str>| user_settings_target(dir, &project, Some(&home), Some(&project));
        // No CLAUDE_CONFIG_DIR, or an empty one: `~/.claude`, even before it
        // exists.
        let personal = real(&home).join(".claude").join("settings.json");
        assert_eq!(target(None).unwrap(), personal);
        assert_eq!(target(Some("  ")).unwrap(), personal);
        fs::create_dir_all(home.join(".claude")).unwrap();
        assert_eq!(target(None).unwrap(), personal);
        assert_eq!(
            target(Some(home.join(".claude").to_str().unwrap())).unwrap(),
            personal
        );
        assert!(user_settings_target(None, &project, None, Some(&project)).is_err());
        assert_eq!(project_settings_path(Path::new("")), None);

        let config = temp();
        let path = target(Some(config.to_str().unwrap())).unwrap();
        assert_eq!(path, real(&config).join("settings.json"));
        fs::write(&path, "{\n\t\"model\": \"opus\"\n}\n").unwrap();
        add_allow_rules(&path, Scope::User, &rules(&["mcp__a__b"])).unwrap();
        assert_eq!(
            fs::read_to_string(&path).unwrap(),
            "{\n\t\"model\": \"opus\",\n\t\"permissions\": {\n\t\t\"allow\": [\n\t\t\t\"mcp__a__b\"\n\t\t]\n\t}\n}\n"
        );
        fs::remove_dir_all(config).unwrap();
        fs::remove_dir_all(root).unwrap();
    }

    /// Review finding (5bf9f85): `CLAUDE_CONFIG_DIR=<repo>/.claude` made
    /// "Always allow everywhere" write the project's SHARED settings.json.
    #[test]
    fn a_config_dir_at_the_projects_own_claude_folder_is_refused() {
        let root = temp();
        let home = root.join("home");
        let project = root.join("project");
        let shared = project.join(".claude");
        fs::create_dir_all(&home).unwrap();
        fs::create_dir_all(&shared).unwrap();
        fs::write(shared.join("settings.json"), "{}").unwrap();
        let target =
            |dir: &Path| user_settings_target(dir.to_str(), &project, Some(&home), Some(&project));

        let err = target(&shared).unwrap_err();
        assert!(err.contains("not your own"), "{err}");
        // Spelled another way, or not created yet: still that folder.
        assert!(target(&project.join("sub").join("..").join(".claude")).is_err());
        assert!(target(&shared.join("nested")).is_err());
        // Another project's .claude, reached through a symlink.
        let other = root.join("other").join(".claude");
        fs::create_dir_all(&other).unwrap();
        #[cfg(unix)]
        {
            let link = root.join("looks-personal");
            std::os::unix::fs::symlink(&other, &link).unwrap();
            assert!(target(&link).is_err(), "a symlink resolves to .claude");
        }
        assert!(target(&other).is_err());
        // Anywhere inside the chat's own folder, or inside a git work tree.
        assert!(target(&project.join("claude-config")).is_err());
        let repo = root.join("repo");
        fs::create_dir_all(repo.join(".git")).unwrap();
        assert!(target(&repo.join("config")).is_err());
        assert_eq!(
            fs::read_to_string(shared.join("settings.json")).unwrap(),
            "{}"
        );
        fs::remove_dir_all(root).unwrap();
    }

    /// A relative CLAUDE_CONFIG_DIR is Claude's launch folder's, not this
    /// server's.
    #[test]
    fn a_relative_config_dir_resolves_from_the_launch_folder() {
        let root = temp();
        let home = root.join("home");
        let project = root.join("project");
        fs::create_dir_all(home.join("cfg")).unwrap();
        fs::create_dir_all(&project).unwrap();
        // A chat with no folder runs in the home folder.
        let path = user_settings_target(Some("cfg"), &home, Some(&home), None).unwrap();
        assert_eq!(
            path,
            home.canonical().unwrap().join("cfg").join("settings.json")
        );
        let server_cwd = std::env::current_dir().unwrap();
        assert!(!path.starts_with(server_cwd.canonical().unwrap()));
        let path = user_settings_target(Some("../home/cfg"), &project, Some(&home), None).unwrap();
        assert_eq!(
            path,
            home.canonical().unwrap().join("cfg").join("settings.json")
        );
        // Relative to a project, it lands in the project: refused.
        assert!(
            user_settings_target(Some(".claude"), &project, Some(&home), Some(&project)).is_err()
        );
        assert!(user_settings_target(Some("cfg"), &project, Some(&home), Some(&project)).is_err());
        // No launch folder to read it from.
        assert!(user_settings_target(Some("cfg"), Path::new(""), Some(&home), None).is_err());
        fs::remove_dir_all(root).unwrap();
    }

    /// The happy path answers the canonical file, the one Claude reads.
    #[test]
    fn a_personal_config_dir_resolves_to_its_canonical_file() {
        let root = temp();
        let home = root.join("home");
        let personal = root.join("personal");
        fs::create_dir_all(&home).unwrap();
        fs::create_dir_all(&personal).unwrap();
        let spelled = root.join("home").join("..").join("personal");
        let path = user_settings_target(spelled.to_str(), &home, Some(&home), None).unwrap();
        assert_eq!(path, personal.canonical().unwrap().join("settings.json"));
        #[cfg(unix)]
        {
            let link = root.join("link");
            std::os::unix::fs::symlink(&personal, &link).unwrap();
            let path = user_settings_target(link.to_str(), &home, Some(&home), None).unwrap();
            assert_eq!(path, personal.canonical().unwrap().join("settings.json"));
        }
        // Not created yet: the folder it will be, under a real parent.
        let fresh = root.join("fresh-config");
        let path = user_settings_target(fresh.to_str(), &home, Some(&home), None).unwrap();
        assert_eq!(
            path,
            root.canonical()
                .unwrap()
                .join("fresh-config")
                .join("settings.json")
        );
        assert!(!fresh.exists(), "resolving creates nothing");
        add_allow_rules(&path, Scope::User, &rules(&["Read"])).unwrap();
        assert!(fresh.join("settings.json").is_file());
        fs::remove_dir_all(root).unwrap();
    }

    fn judged(line: &str) -> Option<(Vec<String>, Vec<String>)> {
        derive_judged_rules("Bash", Some(line)).map(|j| (j.rules, j.uncovered))
    }

    /// The two lines the person saw refused as "Irreversible Local
    /// Destruction" (2026-10-01), shaped as the worker called them.
    #[test]
    fn the_refused_worker_lines_get_one_exact_rule_per_segment() {
        assert_eq!(
            judged("rm -f web/pnpm-workspace.yaml; git status --short; sed -n '1,80p' web/package.json"),
            Some((
                rules(&[
                    "Bash(rm -f web/pnpm-workspace.yaml)",
                    "Bash(git status --short)",
                    "Bash(sed -n '1,80p' web/package.json)",
                ]),
                vec![]
            ))
        );
        assert_eq!(
            judged("git status --short; sed -n '1,40p' src-tauri/src/claude_allow.rs"),
            Some((
                rules(&[
                    "Bash(git status --short)",
                    "Bash(sed -n '1,40p' src-tauri/src/claude_allow.rs)",
                ]),
                vec![]
            ))
        );
    }

    #[test]
    fn a_judged_rule_is_the_exact_command_never_a_prefix() {
        assert_eq!(
            judged("git push origin main"),
            Some((rules(&["Bash(git push origin main)"]), vec![]))
        );
        assert_eq!(
            judged("  git push   origin main  "),
            Some((rules(&["Bash(git push   origin main)"]), vec![]))
        );
        // Destructive verbs get their exact line, and never `:*`.
        for line in [
            "rm -rf build",
            "git reset --hard HEAD~1",
            "git clean -fdx",
            "chmod 600 key.pem",
            "mv a b",
            "dd if=a of=b",
        ] {
            let (found, _) = judged(line).unwrap();
            assert_eq!(found, vec![format!("Bash({line})")], "{line}");
            assert!(!found[0].contains(":*"));
        }
        // Each separator cuts; a repeated segment is one rule.
        assert_eq!(
            judged("git fetch && git status || git log | head -5; git status")
                .unwrap()
                .0,
            rules(&[
                "Bash(git fetch)",
                "Bash(git status)",
                "Bash(git log)",
                "Bash(head -5)",
            ])
        );
        assert_eq!(
            judged("git fetch\ngit status").unwrap().0,
            rules(&["Bash(git fetch)", "Bash(git status)"])
        );
    }

    #[test]
    fn segments_unsafe_to_name_are_listed_as_uncovered() {
        assert_eq!(
            judged("python3 -c 'print(1)'; git status"),
            Some((
                rules(&["Bash(git status)"]),
                vec!["python3 -c 'print(1)'".into()]
            ))
        );
        assert_eq!(
            judged("cargo build 2>&1 | tail -3"),
            Some((rules(&["Bash(tail -3)"]), vec!["cargo build 2>&1".into()]))
        );
        assert_eq!(
            judged("echo hi > out.txt; ls").unwrap().1,
            vec!["echo hi > out.txt".to_string()]
        );
        for (line, left) in [
            ("ls *.log; pwd", "ls *.log"),
            ("rm -rf $DIR; pwd", "rm -rf $DIR"),
            ("echo \"$HOME\"; pwd", "echo \"$HOME\""),
            ("ls file?.txt; pwd", "ls file?.txt"),
            ("FOO=1 git push; pwd", "FOO=1 git push"),
            ("rm -rf /; pwd", "rm -rf /"),
            ("rm -rf ~; pwd", "rm -rf ~"),
            ("rm -rf ~/; pwd", "rm -rf ~/"),
            ("rm -rf ..; pwd", "rm -rf .."),
            ("rm -rf ../..; pwd", "rm -rf ../.."),
            ("rmdir .; pwd", "rmdir ."),
            (
                "git commit -m \"fix (x)\"; pwd",
                "git commit -m \"fix (x)\"",
            ),
            ("sudo rm x; pwd", "sudo rm x"),
            ("env FOO=1 ls; pwd", "env FOO=1 ls"),
            ("xargs rm; pwd", "xargs rm"),
        ] {
            assert_eq!(
                judged(line),
                Some((rules(&["Bash(pwd)"]), vec![left.to_string()])),
                "{line:?}"
            );
        }
        // Coordinator review: any redirection, and `tee`, can overwrite a
        // file while the named program looks harmless.
        for (line, left) in [
            ("echo hi >> log.txt; pwd", "echo hi >> log.txt"),
            ("sort < in.txt; pwd", "sort < in.txt"),
            ("ls 2> err.txt; pwd", "ls 2> err.txt"),
            ("ls &> all.txt; pwd", "ls &> all.txt"),
            ("ls >| forced.txt; pwd", "ls >| forced.txt"),
            ("git log 2>&1; pwd", "git log 2>&1"),
            ("git log | tee out.txt; pwd", "tee out.txt"),
            ("tee -a ~/.zshrc; pwd", "tee -a ~/.zshrc"),
        ] {
            let (found, uncovered) = judged(line).unwrap();
            assert!(found.contains(&"Bash(pwd)".to_string()), "{line:?}");
            assert_eq!(uncovered, vec![left.to_string()], "{line:?}");
            assert!(found
                .iter()
                .all(|r| !r.contains('>') && !r.contains('<') && !r.contains("tee")));
        }
        // A quoted `>` is text, not a redirect.
        assert_eq!(
            judged("git commit -m 'a > b'").unwrap().0,
            rules(&["Bash(git commit -m 'a > b')"])
        );
        // Single quotes keep `$`, `*` aside — but `*` still ends a rule early
        // as a wildcard, so it is never named.
        assert_eq!(
            judged("echo '$HOME'").unwrap().0,
            rules(&["Bash(echo '$HOME')"])
        );
        assert_eq!(judged("grep 'a*b' f"), None);
        let long = format!("echo {}", "x".repeat(EXACT_RULE_MAX));
        assert_eq!(judged(&long), None);
    }

    /// Coordinator review: which `rm` lines an exact rule may name.
    #[test]
    fn only_rm_of_plain_relative_paths_is_named() {
        for line in [
            "rm -f web/pnpm-workspace.yaml",
            "rm -rf build",
            "rm -rf target/debug/incremental",
            "rm -r -f ./dist",
            "rm --recursive node_modules/.cache",
            "rm -- -weird-name",
            "rm a.txt 'b c.txt'",
            "rmdir empty-dir",
            "unlink stale.lock",
        ] {
            assert_eq!(
                judged(line).unwrap().0,
                vec![format!("Bash({line})")],
                "{line:?}"
            );
        }
        for line in [
            "rm -rf /",
            "rm -f /etc/hosts",
            "rm -rf /Users/me/repo/build",
            "rm -rf ~",
            "rm -rf ~/",
            "rm -f ~/.zshrc",
            "rm -rf .",
            "rm -rf ./",
            "rm -rf ..",
            "rm -rf ../sibling",
            "rm -rf build/../..",
            "rm -rf a/../../b",
            "rm -f ok.txt /tmp/x",
            "rmdir ..",
            "unlink /tmp/x",
            "rm -rf C:/Users",
            "rm -rf 'C:\\Users'",
        ] {
            assert_eq!(judged(line), None, "{line:?}");
        }
    }

    #[test]
    fn an_interpreter_line_gets_no_judged_rule() {
        for line in [
            "python3 -c 'print(1)'",
            "node script.js",
            "bash -c 'rm -rf build'",
            "sh run.sh",
            "npx some-tool",
            "awk '{print $1}' f",
            "/usr/bin/python3 x.py",
            "eval ls",
        ] {
            assert_eq!(judged(line), None, "{line:?}");
        }
    }

    /// Review (Tofu, 2026-10-01): only the first word was checked, so a
    /// runner later on the line slipped through.
    #[test]
    fn a_runner_anywhere_on_the_line_gets_no_judged_rule() {
        for line in [
            // The reviewer's line, exactly as reported.
            "find /tmp/commands -type f -exec sh '{}' \\;",
            "git bisect run bash test.sh",
            "docker exec box sh",
            "docker exec -it box /bin/bash",
            "kubectl exec pod -- bash",
            "kubectl exec pod -- \"zsh\"",
            "rg --pre=bash x",
            "git -c core.pager=less log",
            "ssh-agent python3.12 x",
            "gh pr create --title 'sudo'",
        ] {
            assert_eq!(judged(line), None, "{line:?}");
            assert_eq!(
                judged(&format!("{line}; pwd")),
                Some((rules(&["Bash(pwd)"]), vec![line.to_string()])),
                "{line:?}"
            );
        }
        // A `.` argument is a folder, not `source`.
        for line in ["git add .", "ls .", "grep -rn foo ."] {
            assert_eq!(judged(line).unwrap().0, vec![format!("Bash({line})")]);
        }
    }

    #[test]
    fn find_is_named_only_without_an_action_that_runs_or_writes() {
        for line in [
            "find . -name Cargo.toml",
            "find src -type f -newer Cargo.toml",
            "gfind . -maxdepth 2 -print",
        ] {
            assert_eq!(judged(line).unwrap().0, vec![format!("Bash({line})")]);
        }
        for action in FIND_ACTIONS {
            for program in ["find", "gfind"] {
                let line = format!("{program} . -type f {action} x");
                assert_eq!(judged(&line), None, "{line:?}");
            }
        }
    }

    #[test]
    fn a_program_that_runs_another_is_never_named() {
        for program in [
            "parallel",
            "make",
            "gmake",
            "just",
            "task",
            "entr",
            "flock",
            "script",
            "expect",
            "strace",
            "ltrace",
            "gdb",
            "lldb",
            "chroot",
            "unshare",
            "nsenter",
            "setsid",
            "stdbuf",
            "ionice",
            "caffeinate",
            "open",
            "xdg-open",
            "start",
        ] {
            let line = format!("{program} build");
            assert_eq!(judged(&line), None, "{line:?}");
            // Also as a later word: `nice -n 5 make`, `time gdb`.
            let later = format!("echo {program}");
            assert_eq!(judged(&later), None, "{later:?}");
        }
        // A script run by its path can change after the rule is written.
        for line in ["./deploy.sh", "scripts/release.sh --yes", "/tmp/x"] {
            assert_eq!(judged(line), None, "{line:?}");
        }
    }

    #[test]
    fn a_subcommand_that_hands_off_execution_is_never_named() {
        for line in [
            "git bisect run ./test.sh",
            "git submodule foreach git clean -fdx",
            "git rebase -x 'cargo test' main",
            "git rebase --exec=./check main",
            "git -c alias.x=!rm x",
            "git --config-env=core.pager=PAGER log",
            "git filter-branch --tree-filter x HEAD",
            "npm run build",
            "npm test",
            "pnpm exec vitest",
            "pnpm dlx create-thing",
            "yarn run lint",
            "cargo run --release",
            "go run ./cmd/x",
            "go generate ./...",
        ] {
            assert_eq!(judged(line), None, "{line:?}");
        }
        // The same programs stay namable for what runs nothing of the project's.
        for line in [
            "git push --force origin main",
            "git clean -fdx",
            "npm view octiqflow version",
            "cargo build --release",
            "go version",
        ] {
            assert_eq!(judged(line).unwrap().0, vec![format!("Bash({line})")]);
        }
    }

    #[test]
    fn a_line_that_cannot_be_cut_plainly_gets_no_judged_rule() {
        for line in [
            "",
            "   ",
            "echo $(whoami); ls",
            "echo `whoami`; ls",
            "ls; echo \"$(whoami)\"",
            "(cd x; ls)",
            "{ ls; }",
            "sleep 1 & ls",
            "cat <<EOF\nrm -rf /\nEOF",
            "ls # rm -rf /",
            "echo 'unterminated; ls",
            "diff <(ls a) <(ls b)",
            "ls\r\nrm x",
        ] {
            assert_eq!(judged(line), None, "{line:?}");
        }
    }

    #[test]
    fn never_a_blanket_or_tool_wide_judged_rule() {
        for line in ["*", "Bash", ":*", "Bash(*)", "git push:*"] {
            if let Some((found, _)) = judged(line) {
                for rule in &found {
                    assert!(
                        rule != "Bash" && rule != "Bash(*)" && !rule.contains('*'),
                        "{rule}"
                    );
                }
            }
        }
        assert_eq!(derive_judged_rules("Bash", None), None);
        // Any other tool's rule would be the whole tool: none is offered.
        for tool in [
            "WebFetch",
            "Write",
            "Edit",
            "Read",
            "mcp__octiq__ask_user",
            "mcp__github__delete_repo",
            "*",
            "",
        ] {
            assert_eq!(derive_judged_rules(tool, Some("ls")), None, "{tool}");
        }
    }

    /// Both scopes take judged rules through the same writer.
    #[test]
    fn judged_rules_are_written_to_either_scope() {
        let root = temp();
        let home = root.join("home");
        let project = root.join("project");
        fs::create_dir_all(&home).unwrap();
        fs::create_dir_all(&project).unwrap();
        let found = derive_judged_rules("Bash", Some("git status --short; git push origin main"))
            .unwrap()
            .rules;
        let path = project_settings_path(&project).unwrap();
        let added = add_allow_rules(&path, Scope::Project, &found).unwrap();
        assert_eq!(added.added, found);
        let user = user_settings_target(None, &home, Some(&home), Some(&project)).unwrap();
        add_allow_rules(&user, Scope::User, &found).unwrap();
        for file in [&path, &user] {
            let written: serde_json::Value =
                serde_json::from_str(&fs::read_to_string(file).unwrap()).unwrap();
            assert_eq!(
                written["permissions"]["allow"],
                serde_json::json!(["Bash(git status --short)", "Bash(git push origin main)"])
            );
        }
        fs::remove_dir_all(root).unwrap();
    }
}
