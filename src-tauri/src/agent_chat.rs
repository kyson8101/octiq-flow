//! Agent chat sessions: an agent run as a JSON STREAM instead of a terminal.
//!
//! The rest of this app drives agents through a PTY, which is what makes their
//! real TUI work. A TUI is the wrong source for a chat UI, though: what crosses
//! the wire is cursor moves and repaints, so there is no message to render — you
//! would be scraping pixels back into text.
//!
//! Both agents already offer the stream a chat UI actually wants:
//!
//! ```text
//! claude -p --output-format stream-json --input-format stream-json \
//!        --include-partial-messages --verbose
//! ```
//!
//! stdout is then one JSON object per line — `assistant` messages (text,
//! thinking and tool_use blocks), `user` messages carrying tool results,
//! `stream_event` deltas while a reply is still being written, and a final
//! `result` with cost and duration. stdin takes user messages in the same
//! shape, so one process serves a whole conversation.
//!
//! This module owns those processes: spawn one per chat, read its stdout line
//! by line, and re-emit each line as a `chat-event`. Nothing here interprets
//! the JSON — the shapes are the agent's, and a UI that knows them should not
//! have to wait for a Rust change to see a new field.
//!
//! No PTY: this is a plain piped child. It is launched through a LOGIN SHELL
//! all the same, for the reason pty.rs does it — a GUI app does not inherit the
//! interactive shell's PATH, so `claude` would simply not be found.

use std::collections::HashMap;
use std::io::{BufRead, BufReader, Write};
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::{Arc, Mutex};
use std::thread;

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tauri::State;

/// One line of an agent's stdout, on its way to the UI.
#[derive(Clone, Serialize)]
struct ChatEvent {
    /// The chat this came from (the frontend picks the key at start time, the
    /// same way it picks PTY ids).
    key: String,
    /// Where this sits in the chat's record. A client remembers the highest it
    /// has seen and asks for everything after it when it reconnects, which is
    /// what stops a closed laptop losing the rest of an answer.
    #[serde(skip_serializing_if = "Option::is_none")]
    seq: Option<u64>,
    /// The agent's own JSON object, passed through untouched.
    event: Value,
}

/// The agent said something on stderr, or the process ended.
#[derive(Clone, Serialize)]
struct ChatStatus {
    key: String,
    /// "exit" | "stderr" | "error"
    kind: String,
    text: String,
    code: Option<i32>,
}

struct ChatSession {
    child: Child,
    stdin: Option<ChildStdin>,
    /// Which program this is. Only Claude has a control channel, so a setting
    /// changed part-way through a chat has to know before it writes one.
    agent: ChatAgent,
}

#[derive(Default)]
pub struct ChatManager {
    sessions: Mutex<HashMap<String, Arc<Mutex<ChatSession>>>>,
    /// Only chats opened as rooms appear here. No entry means no room.
    ///
    /// Stored here because a seat that speaks needs a session and a round
    /// needs both at once — everything ELSE about a room lives in `chat_room`.
    pub(crate) rooms: Mutex<HashMap<String, crate::chat_room::Room>>,
}

/// Which agents this module can start. The name from the UI only ever picks
/// between these literals — it is never interpolated into the command line.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ChatAgent {
    Claude,
    Codex,
}

impl ChatAgent {
    pub(crate) fn bin(self) -> &'static str {
        match self {
            ChatAgent::Claude => "claude",
            ChatAgent::Codex => "codex",
        }
    }
}

/// Single-quote a value for the login shell that launches the agent.
///
/// Everything the UI can influence — a model alias, a working directory, the
/// first prompt — goes through here. Inside single quotes a POSIX shell expands
/// nothing at all, so the only character that needs care is the quote itself.
fn sh_quote(s: &str) -> String {
    format!("'{}'", s.replace('\'', r"'\''"))
}

/// One TOML basic string, quoted and escaped.
///
/// `sh_quote` makes a value safe to sit on a command line and nothing more. A
/// couple of Codex settings are TOML written by hand (`-c key=value`), and a
/// value going in there passes through TWO parsers: the shell's, then Codex's
/// TOML. A folder named `a", evil = "yes` survives the first untouched and
/// closes the string in the second, after which the rest of the path is read as
/// further config. So the TOML layer gets its own escaping, applied first.
fn toml_string(s: &str) -> String {
    format!("\"{}\"", s.replace('\\', r"\\").replace('"', "\\\""))
}

/// Model aliases we will pass on. An unknown value is dropped rather than
/// forwarded: the model name reaches a command line, so it is an allowlist, not
/// an escaping problem.
pub(crate) fn safe_model(model: &str) -> Option<String> {
    let ok = model
        .chars()
        .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '.' || c == '_');
    if ok && !model.is_empty() && model.len() <= 64 {
        Some(model.to_string())
    } else {
        None
    }
}

/// Session ids are uuids the agent gave us. Checked, not escaped: like the
/// model name it lands on a command line, so the shape is the guard.
pub(crate) fn safe_session_id(id: &str) -> Option<String> {
    let ok = id.len() <= 64
        && !id.is_empty()
        && id.chars().all(|c| c.is_ascii_alphanumeric() || c == '-');
    ok.then(|| id.to_string())
}

/// Reasoning effort, per agent.
///
/// Both support the idea and neither spells it the same way: Claude takes
/// `--effort`, Codex takes a config override. The levels differ too — Codex has
/// a `minimal` that Claude does not, Claude has a `max` and an `ultracode` that
/// Codex does not — so the UI offers each agent its own list and this refuses
/// anything else. Same reasoning as the model allowlist: it reaches a command
/// line.
///
/// `auto` is the one level with no flag behind it. Claude takes it from the
/// `/effort` command inside a running session, but NOT on the command line —
/// `claude --effort auto` warns and falls back — and it means the agent picks
/// the level itself, which is exactly what passing no `--effort` at all does.
/// So it maps to None: no flag, same as an unknown value, and by design.
fn safe_effort(agent: ChatAgent, level: &str) -> Option<&'static str> {
    match (agent, level) {
        (_, "low") => Some("low"),
        (_, "medium") => Some("medium"),
        (_, "high") => Some("high"),
        (_, "xhigh") => Some("xhigh"),
        (_, "max") => Some("max"),
        (ChatAgent::Claude, "ultracode") => Some("ultracode"),
        _ => None,
    }
}

/// How much the agent may do unattended, as ONE idea across both agents.
///
/// The UI asks one question — look only, edit files, or anything — because that
/// is the decision the user is actually making. Each agent then gets its own
/// flag for it: Claude a permission mode, Codex a sandbox policy. Mapping here
/// rather than in the UI keeps the two spellings out of the frontend.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Access {
    /// Look and plan, change nothing. Claude's `plan`.
    Read,
    /// Ask before every change. Claude's `manual`.
    ///
    /// The PreToolUse hook does the asking, as it does on every level below
    /// Full — the difference is only how much it is asked about.
    Manual,
    /// File edits go through; everything else still asks. Claude's `acceptEdits`.
    ///
    /// The mode name is Claude's and so is the behaviour, but the FLAG cannot
    /// deliver it here on its own: the hook runs before `--permission-mode` is
    /// consulted, so an edit would be stopped by the hook before the mode ever
    /// got the chance to accept it. `permission::ask` knows about this level and
    /// stands aside for the edit tools — see EDIT_TOOLS there.
    Edits,
    /// Get on with it, and ask when something looks unsafe. Claude's `auto`.
    ///
    /// This was once `Edit`, mapped to `acceptEdits`, and was the middle rung on
    /// its own: that auto-accepted FILE EDITS and nothing else, so every shell
    /// command still stopped — not what a chat wants, and not what the label
    /// promised. Both rungs exist now, which is what Claude itself offers.
    Auto,
    /// Run anything without asking. Claude's `bypassPermissions`.
    Full,
}

impl Access {
    /// Claude's `--permission-mode` value.
    fn claude(self) -> &'static str {
        match self {
            Access::Read => "plan",
            Access::Manual => "manual",
            Access::Edits => "acceptEdits",
            Access::Auto => "auto",
            Access::Full => "bypassPermissions",
        }
    }

    /// What the PreToolUse hook is told, in `OCTIQ_ACCESS`.
    ///
    /// The hook runs BEFORE `--permission-mode` is consulted — it is the first
    /// step of the permission chain — so "run anything without asking" never
    /// reaches it through that flag, and the hook went on asking about every
    /// command even under bypassPermissions. It has to be told separately.
    fn as_env(self) -> &'static str {
        match self {
            Access::Read => "read",
            Access::Manual => "manual",
            Access::Edits => "edits",
            Access::Auto => "auto",
            Access::Full => "full",
        }
    }

    /// Codex's `--sandbox` value — what a command may TOUCH.
    /// `workspace-write` is the direct match for the middle level: writes inside
    /// the workspace, nothing outside it.
    fn codex(self) -> &'static str {
        match self {
            Access::Read => "read-only",
            // Codex has no per-change asking and no edits-only mode: its sandbox
            // says what a command may TOUCH, not what may happen unasked. Both
            // middle rungs are therefore the same sandbox here — the difference
            // between them is Claude's, and the Codex picker does not offer
            // them (see ACCESS in Composer.tsx, which is per provider).
            Access::Manual | Access::Edits | Access::Auto => "workspace-write",
            Access::Full => "danger-full-access",
        }
    }

    /// Codex's `approval_policy` value — whether a command RUNS unasked.
    ///
    /// Codex splits in two what Claude answers with one flag, and only the
    /// sandbox half was ever set. Left alone, the approval policy fell back to
    /// the user's own config, so both outer levels could behave as the opposite
    /// of their label: `Full` stopping to ask, `Read` prompting about a sandbox
    /// that would have refused the write anyway. `on-request` — "the model
    /// decides when to ask" — is the one that matches Claude's `auto`.
    fn codex_approval(self) -> &'static str {
        match self {
            // The sandbox already refuses the write; asking on top of it is a
            // question whose only honest answer is "it would fail regardless".
            Access::Read => "never",
            Access::Manual | Access::Edits | Access::Auto => "on-request",
            Access::Full => "never",
        }
    }
}

impl Access {
    /// Read back what `as_env` wrote, for the hook reporting the level it was
    /// started with. An unknown word is the most cautious level, not the most
    /// permissive — the same rule the spawn side follows.
    pub fn from_env(word: &str) -> Access {
        match word {
            "manual" => Access::Manual,
            "edits" => Access::Edits,
            "auto" => Access::Auto,
            "full" => Access::Full,
            _ => Access::Read,
        }
    }
}

/// The level each running chat is on RIGHT NOW, by chat key.
///
/// `OCTIQ_ACCESS` is written once, into the environment of a process that has
/// already been spawned, so a level changed part-way through a chat can never
/// reach it — nothing can rewrite the environment of a running process from
/// outside. The permission hook used to decide from that variable alone, which
/// meant it answered for the level the chat STARTED on: pick Bypass permissions
/// halfway through and it went on stopping every command, dial back down from
/// it and it stood aside from the very asking that level is for.
///
/// So the hook no longer decides. It reports the level it was handed and this
/// is consulted first — see `permission::ask`.
///
/// Entries are written by `chat_start` and `chat_set_access` and dropped by
/// `chat_stop`. A chat that ends on its own leaves its entry behind on purpose:
/// removing it from the reaper thread would race a restart under the same key
/// and delete the NEW level. A stale entry costs nothing — the only reader is a
/// hook belonging to that chat, and a chat that is gone has none.
static ACCESS: Mutex<Option<HashMap<String, Access>>> = Mutex::new(None);

fn with_access<T>(f: impl FnOnce(&mut HashMap<String, Access>) -> T) -> T {
    let mut guard = ACCESS.lock().unwrap_or_else(|e| e.into_inner());
    f(guard.get_or_insert_with(HashMap::new))
}

/// What a chat may do at this moment, or None when no chat by that key is known.
pub fn access_now(key: &str) -> Option<Access> {
    with_access(|a| a.get(key).copied())
}

/// Pretend a chat by this key is running at this level. Tests only: the real
/// recorders are `chat_start` and `chat_set_access`, and both want a process.
#[cfg(test)]
pub(crate) fn remember_access(key: &str, access: Access) {
    with_access(|a| a.insert(key.to_string(), access));
}

/// Build the agent's command line.
///
/// Claude speaks stream-json in both directions, so one process handles the
/// whole conversation. Codex's `exec --json` is one-shot, so a Codex chat sends
/// its prompt on the command line and the session ends with the answer; the UI
/// starts a new one for the next turn.
fn build_command(
    agent: ChatAgent,
    model: Option<&str>,
    access: Option<Access>,
    prompt: &str,
    resume: Option<&str>,
    extra_dirs: &[String],
    effort: Option<&str>,
    images: &[String],
    // A chat started clean: none of this machine's skills, hooks or other MCP
    // servers. Claude only — see the branch below.
    lite: bool,
) -> String {
    match agent {
        ChatAgent::Claude => {
            let mut cmd = String::from(
                "claude -p --output-format stream-json --input-format stream-json \
                 --include-partial-messages --replay-user-messages --verbose",
            );
            // Continuing an earlier conversation: the agent comes back with its
            // own context, rather than being handed a transcript to read.
            if let Some(id) = resume.and_then(|id| safe_session_id(id)) {
                cmd.push_str(&format!(" --resume {}", sh_quote(&id)));
            }
            if let Some(m) = model.and_then(|m| safe_model(m)) {
                cmd.push_str(&format!(" --model {}", sh_quote(&m)));
            }
            if let Some(a) = access {
                cmd.push_str(&format!(" --permission-mode {}", a.claude()));
            }
            if let Some(e) = effort.and_then(|e| safe_effort(agent, e)) {
                cmd.push_str(&format!(" --effort {e}"));
            }
            // How the agent asks the user for permission.
            //
            // `stdio` means: send the question down this process's own stdout as
            // a `can_use_tool` control request, and wait for a `control_response`
            // on stdin. Both directions are channels this module already owns —
            // see the stdout loop in `chat_start` and `write_control_response`.
            //
            // This replaced a PreToolUse hook, and the difference is WHEN it
            // fires. A hook is the FIRST step of the permission chain: it runs
            // before the deny rules, before the allow rules, and before
            // `--permission-mode`, so it has to answer for calls the chain was
            // about to wave through on its own. It cannot tell them apart, so it
            // asked about everything — including reads, and including a user's
            // own `Bash(git commit:*)` allow rule, which it never gets to see.
            //
            // This fires LAST, only once the chain has decided that a person has
            // to answer. Auto is as quiet here as it is in a terminal, every
            // rule in the user's settings.json counts again, and the questions
            // that do reach the phone are the ones Claude genuinely stopped for.
            //
            // The flag is real but undocumented — `claude --help` does not list
            // it. It is what `@anthropic-ai/claude-agent-sdk` passes when a
            // `canUseTool` callback is supplied; the literal string is `stdio`.
            cmd.push_str(" --permission-prompt-tool stdio");
            // The tool that flag turns on behind our back.
            //
            // `--permission-prompt-tool` reads as though it only says WHERE a
            // permission question goes. It also decides which tools the model
            // is shown: with it, print mode offers `AskUserQuestion`, which
            // without it it never does.
            //
            // We cannot answer that one. It does not arrive as a `can_use_tool`
            // request — permission passes, and the CLI then runs the tool
            // itself, looking for the interactive prompt a `-p` process has no
            // way to draw. It gives up immediately and hands the agent "The
            // user did not answer the questions", so a question the user never
            // saw comes back looking like one they refused.
            //
            // `ask_user` is the one that reaches them, so it is left as the
            // only way to ask. Not conditional on the MCP config below: if that
            // could not be written there is no way to ask at all, which is what
            // this command line did before the flag existed — better than a
            // tool that fails every time it is used.
            cmd.push_str(" --disallowedTools AskUserQuestion");
            // Our own two tools, plus the sentences that make the agent reach
            // for them. Both are pre-approved: a tool whose whole purpose is to
            // talk to the user must not itself raise a permission question, and
            // a TODO list that had to be approved item by item would be worse
            // than none.
            if let Some(mcp) = ask_mcp_config() {
                cmd.push_str(&format!(
                    " --mcp-config {} --allowedTools {} --append-system-prompt {}",
                    sh_quote(&mcp.to_string_lossy()),
                    sh_quote("mcp__octiq__ask_user mcp__octiq__todo_write"),
                    sh_quote(ASK_PROMPT),
                ));
            }
            // A clean chat: this machine's skills, hooks and other MCP servers
            // left out of it.
            //
            // Measured in this repo, a first turn costs 60.4k of context before
            // anyone has said anything, and the skill list is about half of
            // that. These three flags bring it to 30.2k:
            //
            //   --strict-mcp-config     only the servers named above — ours
            //   --disable-slash-commands   no skills
            //   --setting-sources ''    no user/project/local settings, so no
            //                           SessionStart hooks and no rules
            //
            // What it deliberately does NOT use is `--bare`, the flag that
            // looks like this feature's name. Bare never reads the OAuth login
            // or the keychain — auth is strictly ANTHROPIC_API_KEY — so on a
            // subscription every bare chat ends at "Not logged in" without
            // reaching the model. `--safe-mode` keeps the login but drops MCP
            // servers even when we pass them ourselves, taking `ask_user` and
            // the todo list with them, and still costs more (31.6k) because it
            // goes on listing the built-in skills.
            //
            // CLAUDE.md still loads. Only bare and safe mode drop it, and both
            // cost more than they save.
            if lite {
                cmd.push_str(" --strict-mcp-config --disable-slash-commands --setting-sources ''");
            }
            // A project can group several folders. The agent starts in one of
            // them (`cwd`) and can already read that one; every OTHER folder of
            // the project has to be named or the agent cannot touch it.
            for dir in extra_dirs {
                cmd.push_str(&format!(" --add-dir {}", sh_quote(dir)));
            }
            cmd
        }
        ChatAgent::Codex => {
            // Codex ends after each turn, so every turn is a new process. That
            // makes continuing a conversation a RESUME rather than something
            // written to a running stdin — `codex exec resume <id> <prompt>`,
            // where the id is the `thread_id` from its own `thread.started`.
            //
            // The resume subcommand takes a narrower set of flags than a fresh
            // exec: no `--sandbox`, no `--add-dir`. Both have config keys
            // instead, so the same settings are expressed with `-c` and the
            // conversation is kept.
            let resuming = resume.and_then(|id| safe_session_id(id));
            let mut cmd = match &resuming {
                Some(id) => format!("codex exec resume --json {}", sh_quote(id)),
                None => String::from("codex exec --json"),
            };
            if let Some(m) = model.and_then(|m| safe_model(m)) {
                cmd.push_str(&format!(" -m {}", sh_quote(&m)));
            }
            // Codex calls it a sandbox policy rather than a permission mode,
            // and splits into two what Claude answers with one flag: the sandbox
            // says what a command may touch, the approval policy says whether it
            // runs without being asked. Both are needed — a sandbox alone leaves
            // the asking to whatever the user's own config happens to say.
            //
            // The approval half travels as a CONFIG KEY on both forms.
            // `--ask-for-approval` survives only on the interactive `codex`;
            // `codex exec` dropped it (0.147.0 answers the flag with "error:
            // unexpected argument '--ask-for-approval' found" and refuses to
            // start), and `codex exec resume` never took it. `-c
            // approval_policy=` is the one spelling both accept.
            if let Some(a) = access {
                if resuming.is_some() {
                    cmd.push_str(&format!(" -c sandbox_mode={}", sh_quote(a.codex())));
                } else {
                    cmd.push_str(&format!(" --sandbox {}", a.codex()));
                }
                cmd.push_str(&format!(
                    " -c approval_policy={}",
                    sh_quote(a.codex_approval())
                ));
            }
            // Effort has no flag of its own on either form: it is a config key.
            // The value comes from the allowlist, so it is a bare word — which
            // fails to parse as TOML and is taken as the literal string, which
            // is what we want.
            if let Some(e) = effort.and_then(|e| safe_effort(agent, e)) {
                cmd.push_str(&format!(" -c model_reasoning_effort={}", sh_quote(e)));
            }
            // Extra folders: the same idea as Claude's, and the reason a chat
            // in a multi-folder project can reach all of it.
            for dir in extra_dirs {
                if resuming.is_some() {
                    // `--add-dir` is not offered on resume; the config key is.
                    cmd.push_str(&format!(
                        " -c sandbox_workspace_write.writable_roots={}",
                        sh_quote(&format!("[{}]", toml_string(dir)))
                    ));
                } else {
                    cmd.push_str(&format!(" --add-dir {}", sh_quote(dir)));
                }
            }
            // Images are FILES on the command line here, where Claude takes
            // them inline on stdin (see write_user_message). Same attachment
            // either way — only the delivery differs.
            for path in images {
                cmd.push_str(&format!(" -i {}", sh_quote(path)));
            }
            cmd.push(' ');
            cmd.push_str(&sh_quote(prompt));
            cmd
        }
    }
}

/// Start a chat session. `key` names it for every later call, exactly as a PTY
/// id does. Starting a key that already runs is an error, not a silent replace —
/// a second process on the same key would interleave two conversations.
#[tauri::command]
pub fn chat_start(
    manager: State<Arc<ChatManager>>,
    key: String,
    cwd: String,
    agent: ChatAgent,
    model: Option<String>,
    access: Option<Access>,
    prompt: Option<String>,
    resume: Option<String>,
    // The project's other folders, so a chat sees the whole project and not
    // just the folder it starts in. See build_command.
    extra_dirs: Option<Vec<String>>,
    // Reasoning effort (Claude only), fixed for the life of the process.
    effort: Option<String>,
    // Image files to attach to the first turn.
    images: Option<Vec<String>>,
    // Start clean: none of this machine's skills, hooks or other MCP servers.
    // Claude only, and fixed for the life of the process — the flags it sets
    // are read once, when the agent starts.
    lite: Option<bool>,
) -> Result<(), String> {
    chat_start_impl(
        manager.inner().clone(),
        key,
        cwd,
        agent,
        model,
        access,
        prompt,
        resume,
        extra_dirs,
        effort,
        images,
        lite,
    )
}

/// Start a chat. The Tauri-free half of `chat_start`, so a headless server can
/// call exactly the same code path rather than a copy of it.
#[allow(clippy::too_many_arguments)]
pub fn chat_start_impl(
    manager: Arc<ChatManager>,
    key: String,
    cwd: String,
    agent: ChatAgent,
    model: Option<String>,
    access: Option<Access>,
    prompt: Option<String>,
    resume: Option<String>,
    extra_dirs: Option<Vec<String>>,
    effort: Option<String>,
    images: Option<Vec<String>>,
    lite: Option<bool>,
) -> Result<(), String> {
    let manager_for_exit = manager.clone();
    {
        let sessions = manager.sessions.lock().map_err(|e| e.to_string())?;
        if sessions.contains_key(&key) {
            return Err(format!("chat '{key}' is already running"));
        }
    }

    // The folder we start in is already visible to the agent, so naming it
    // again would be noise; blanks and repeats are dropped for the same reason.
    let mut seen = std::collections::HashSet::new();
    let extras: Vec<String> = extra_dirs
        .unwrap_or_default()
        .into_iter()
        .filter(|p| !p.trim().is_empty() && p != &cwd && seen.insert(p.clone()))
        .collect();

    let prompt = prompt.unwrap_or_default();
    let images = images.unwrap_or_default();
    let line = build_command(
        agent,
        model.as_deref(),
        access,
        &prompt,
        resume.as_deref(),
        &extras,
        effort.as_deref(),
        &images,
        lite.unwrap_or(false),
    );

    // Login shell, for PATH — see the module docs.
    let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/zsh".to_string());
    let mut child = Command::new(&shell)
        .args(["-lc", &format!("exec {line}")])
        .current_dir(if cwd.trim().is_empty() {
            std::env::var("HOME").unwrap_or_else(|_| "/".into())
        } else {
            cwd.clone()
        })
        // Claude reads every turn off stdin, so it needs a pipe. Codex must
        // NOT have one: `codex exec` treats piped stdin as MORE INPUT to append
        // to the prompt, so an open pipe leaves it sitting on
        // "Reading additional input from stdin..." waiting for an end that
        // never comes. Its prompt is on the command line; there is nothing to
        // send it.
        // The hook answers only for agents we started, and needs to know
        // which chat is asking so the UI can attach the question to it.
        .env("OCTIQ_CHAT_KEY", &key)
        // What the person chose. The hook cannot read --permission-mode, and on
        // bypassPermissions it must step aside rather than ask about every command.
        // Unset means the most cautious of the three, not the most permissive:
        // a missing value must never be the one that stops the asking.
        .env("OCTIQ_ACCESS", access.map(Access::as_env).unwrap_or("read"))
        // The Artifact tool, which print mode hides from itself.
        //
        // Claude Code decides whether to offer `Artifact` by ENTRYPOINT, and it
        // refuses for `-p`, for the SDKs, for the GitHub action and for `mcp` —
        // so a chat agent here is never shown it, no matter what it is asked
        // for. A truthy `CLAUDE_CODE_ARTIFACT` skips that check, and nothing
        // else about the tool needs arranging: the call goes through the same
        // `--permission-prompt-tool stdio` chain as every other tool, so the
        // person still approves it.
        //
        // Unlike `AskUserQuestion` above, the tool WORKS without a terminal to
        // draw in — it publishes an HTML/Markdown file the agent has already
        // written to disk as a private page on claude.ai and hands back a URL.
        // So it needs the network and a claude.ai login; on any other auth the
        // CLI keeps the tool hidden and this var changes nothing. `disableArtifact`
        // in the user's settings still wins, which is how they turn it back off.
        //
        // Harmless for Codex, which shares this spawn and has never read it.
        .env("CLAUDE_CODE_ARTIFACT", "1")
        .stdin(match agent {
            ChatAgent::Claude => Stdio::piped(),
            ChatAgent::Codex => Stdio::null(),
        })
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| format!("could not start {}: {e}", agent.bin()))?;

    let stdout = child
        .stdout
        .take()
        .ok_or("no stdout on the agent process")?;
    let stderr = child
        .stderr
        .take()
        .ok_or("no stderr on the agent process")?;
    let stdin = child.stdin.take();

    let session = Arc::new(Mutex::new(ChatSession {
        child,
        stdin,
        agent,
    }));
    manager
        .sessions
        .lock()
        .map_err(|e| e.to_string())?
        .insert(key.clone(), session.clone());
    // The level the hook will be answered with, from here until it changes.
    // Unset is the most cautious of the three, matching `OCTIQ_ACCESS` above.
    with_access(|a| a.insert(key.clone(), access.unwrap_or(Access::Read)));

    // Say hello, or never be asked anything.
    //
    // `--permission-prompt-tool stdio` alone is not enough: without this the
    // agent decides there is nobody on the other end and denies outright rather
    // than asking — measured, not assumed. It is the first thing the Agent SDK
    // writes, and the agent answers it with its own capabilities before any
    // conversation starts.
    //
    // Claude only. Codex has no stdin at all here (see the pipe above).
    if agent == ChatAgent::Claude {
        let hello = json!({
            "type": "control_request",
            "request_id": format!("{HELLO_REQUEST_ID}{}", uuid::Uuid::new_v4()),
            "request": { "subtype": "initialize" }
        });
        if let Ok(mut guard) = session.lock() {
            if let Some(stdin) = guard.stdin.as_mut() {
                let _ = writeln!(stdin, "{hello}");
                let _ = stdin.flush();
            }
        }
    }

    // stdout: one JSON object per line, passed through as-is.
    {
        let key = key.clone();
        let asking = session.clone();
        // Whose stdout this is. `chat_start_impl` starts the HOST, so there is
        // nobody to name and every event goes through untouched — see
        // `stamp_speaker`. Card 67 gives a seat its own process, and this is
        // the one line it changes: the seat is passed in and its every event
        // then says so, in the record as well as on the wire.
        let speaker: Option<crate::chat_room::Seat> = None;
        // The runtime the answer will be waited on. Captured HERE, on the thread
        // that still has one: `chat_start` is called from an async handler, the
        // reader below is a plain thread, and `Handle::current()` panics there.
        // Absent only on the desktop build, which has no server runtime — see
        // `answer_permission`.
        let rt = tokio::runtime::Handle::try_current().ok();
        thread::spawn(move || {
            let reader = BufReader::new(stdout);
            for line in reader.lines() {
                let Ok(line) = line else { break };
                let trimmed = line.trim();
                if trimmed.is_empty() {
                    continue;
                }
                match serde_json::from_str::<Value>(trimmed) {
                    Ok(event) => {
                        // Anything the agent asks US, named in the log first.
                        //
                        // This whole path is invisible otherwise: a
                        // `can_use_tool` never reaches the transcript, so the
                        // only symptom of one going unanswered was a chat that
                        // sat still. One line per control request is the
                        // difference between diagnosing that in a minute and
                        // guessing at it across three restarts.
                        if event.get("type").and_then(Value::as_str) == Some("control_request") {
                            eprintln!(
                                "[perm] {key} <- {}",
                                event
                                    .get("request")
                                    .and_then(|r| r.get("subtype"))
                                    .and_then(Value::as_str)
                                    .unwrap_or("?")
                            );
                        }
                        if let Some((id, request)) = can_use_tool(&event) {
                            answer_permission(&asking, &key, rt.as_ref(), id, request);
                            continue;
                        }
                        // The answer to our hello. It is the agent listing its
                        // own commands and capabilities — several kilobytes of
                        // it — and it is not conversation, so it goes no further
                        // than here rather than into the transcript.
                        if answered_hello(&event) {
                            // Whether it WORKED is worth a line: the agent only
                            // asks over stdio once this is accepted, and a
                            // rejected handshake is otherwise silent.
                            eprintln!(
                                "[perm] {key} handshake {}",
                                event
                                    .get("response")
                                    .and_then(|r| r.get("subtype"))
                                    .and_then(Value::as_str)
                                    .unwrap_or("?")
                            );
                            continue;
                        }
                        // The one line this module reads rather than passes on:
                        // the answer to a request WE sent, not something the
                        // agent said. A refused mode change has to be known
                        // here or the picker would promise a level the agent is
                        // not on. See `chat_set_access`.
                        if let Some(error) = refused_access_change(&event) {
                            crate::bus::emit(
                                "chat-status",
                                ChatStatus {
                                    key: key.clone(),
                                    kind: "access-refused".into(),
                                    text: error,
                                    code: None,
                                },
                            );
                        }
                        // A turn that ended, to whatever is not open.
                        //
                        // `result` is the agent's own full stop, and it carries
                        // the closing words — which is the line the banner
                        // wants, without having to walk the transcript back
                        // looking for the last turn that actually said
                        // something. An errored turn still ended, and being
                        // told so matters more than being told it went well.
                        if event.get("type").and_then(|t| t.as_str()) == Some("result") {
                            let said = event
                                .get("result")
                                .and_then(|r| r.as_str())
                                .unwrap_or_default();
                            crate::push::notify_chat(Some(&key), "done", said);
                        }
                        // Who said this — BEFORE the record is written, so a
                        // client that catches up later is told the same thing a
                        // client watching live was told. `None` is the host,
                        // and the host's events go through completely
                        // untouched; that is what makes a chat with no seats
                        // byte-for-byte the chat that shipped before card 66.
                        let mut event = event;
                        crate::chat_room::stamp_speaker(&mut event, speaker.as_ref());
                        // Recorded BEFORE it is sent, so a client that
                        // reconnects can never be told about an event that was
                        // not written down.
                        let seq = crate::transcript::append(&key, &event);
                        crate::bus::emit(
                            "chat-event",
                            ChatEvent {
                                key: key.clone(),
                                seq,
                                event,
                            },
                        )
                    }
                    // A non-JSON line means the agent printed something we did
                    // not ask for (a login prompt, an update notice). Surface it
                    // rather than dropping it — it is usually the reason a chat
                    // produced nothing. The one exception is below.
                    Err(_) => crate::bus::emit(
                        "chat-status",
                        ChatStatus {
                            key: key.clone(),
                            kind: "stderr".into(),
                            text: trimmed.to_string(),
                            code: None,
                        },
                    ),
                }
            }
        });
    }

    // stderr: never JSON, always worth showing.
    {
        let key = key.clone();
        thread::spawn(move || {
            let reader = BufReader::new(stderr);
            for line in reader.lines().map_while(Result::ok) {
                if line.trim().is_empty() || is_expected_chatter(&line) {
                    continue;
                }
                crate::bus::emit(
                    "chat-status",
                    ChatStatus {
                        key: key.clone(),
                        kind: "stderr".into(),
                        text: line,
                        code: None,
                    },
                );
            }
        });
    }

    // Reap the child and tell the UI, so a chat can never look "still thinking"
    // after its process is gone.
    {
        let key = key.clone();
        let session = session.clone();
        thread::spawn(move || {
            let code = loop {
                let status = {
                    let Ok(mut s) = session.lock() else {
                        break None;
                    };
                    s.child.try_wait().ok().flatten()
                };
                match status {
                    Some(st) => break st.code(),
                    None => thread::sleep(std::time::Duration::from_millis(200)),
                }
            };
            crate::bus::emit(
                "chat-status",
                ChatStatus {
                    key: key.clone(),
                    kind: "exit".into(),
                    text: String::new(),
                    code,
                },
            );
            // Forget the session now it is gone, so its key is free to be
            // started again. The manager is held by Arc rather than looked up
            // through an AppHandle: this thread outlives the call, and a
            // headless server has no app to look anything up in.
            manager_for_exit
                .sessions
                .lock()
                .ok()
                .map(|mut m| m.remove(&key));
        });
    }

    // Claude's first turn rides in on stdin like every later one, so the send
    // path is the same code for turn 1 and turn 9. Codex already has the prompt
    // on its command line.
    if agent == ChatAgent::Claude && !prompt.trim().is_empty() {
        write_user_message(&session, &prompt, &images)?;
    }

    Ok(())
}

/// Lines an agent writes to stderr as a matter of course, which are noise here.
///
/// `codex exec` announces "Reading additional input from stdin..." whenever its
/// stdin is not a terminal — which is always, for a process we spawned. Nothing
/// is wrong and nothing is waiting: it reads EOF and carries on. Showing it as
/// a notice on every Codex turn trains the user to ignore notices, which is
/// exactly what a real one needs them not to do.
fn is_expected_chatter(line: &str) -> bool {
    let line = line.trim();
    line.starts_with("Reading additional input from stdin")
}

/// The media type for an image path, or None when it is not an image we can
/// hand to the model. Anthropic accepts these four and nothing else.
fn image_media_type(path: &str) -> Option<&'static str> {
    let ext = path.rsplit('.').next()?.to_ascii_lowercase();
    match ext.as_str() {
        "png" => Some("image/png"),
        "jpg" | "jpeg" => Some("image/jpeg"),
        "gif" => Some("image/gif"),
        "webp" => Some("image/webp"),
        _ => None,
    }
}

/// Read an image off disk as a base64 content block. `None` when it is not a
/// readable image — a failed attachment must not stop the message being sent.
fn image_block(path: &str) -> Option<Value> {
    use base64::Engine;
    let media_type = image_media_type(path)?;
    let bytes = std::fs::read(path).ok()?;
    // A ceiling, because this whole payload goes down a pipe as one line.
    if bytes.is_empty() || bytes.len() > 12 * 1024 * 1024 {
        return None;
    }
    let data = base64::engine::general_purpose::STANDARD.encode(bytes);
    Some(json!({
        "type": "image",
        "source": { "type": "base64", "media_type": media_type, "data": data }
    }))
}

/// Write one user message to a Claude session's stdin, in the shape
/// `--input-format stream-json` expects.
///
/// Images go in as content blocks beside the text, which is how the model
/// actually SEES them — as opposed to being told a path and having to open it
/// with a tool. They come first: a picture followed by the question about it
/// reads better to a model than the reverse.
fn write_user_message(
    session: &Arc<Mutex<ChatSession>>,
    text: &str,
    images: &[String],
) -> Result<(), String> {
    let mut content: Vec<Value> = images.iter().filter_map(|p| image_block(p)).collect();
    content.push(json!({ "type": "text", "text": text }));
    let payload = json!({
        "type": "user",
        "message": { "role": "user", "content": content }
    });
    let mut guard = session.lock().map_err(|e| e.to_string())?;
    let stdin = guard
        .stdin
        .as_mut()
        .ok_or("this chat does not take more input")?;
    writeln!(stdin, "{payload}").map_err(|e| e.to_string())?;
    stdin.flush().map_err(|e| e.to_string())
}

/// Send the next user turn to a running chat, with any images attached to it.
#[tauri::command]
pub fn chat_send(
    manager: State<Arc<ChatManager>>,
    key: String,
    text: String,
    images: Option<Vec<String>>,
) -> Result<(), String> {
    chat_send_impl(&manager, key, text, images)
}

/// The Tauri-free half of `chat_send`.
pub fn chat_send_impl(
    manager: &ChatManager,
    key: String,
    text: String,
    images: Option<Vec<String>>,
) -> Result<(), String> {
    let session = {
        let sessions = manager.sessions.lock().map_err(|e| e.to_string())?;
        sessions.get(&key).cloned().ok_or("no such chat")?
    };
    write_user_message(&session, &text, &images.unwrap_or_default())
}

/// Ask the agent to stop what it is doing, WITHOUT ending the conversation.
///
/// Claude's init event advertises `interrupt_receipt_v1`, so the running turn
/// can be cancelled over the same stdin the prompts go down and the session
/// stays alive with its context. Killing the process would work too and is what
/// `chat_stop` does — but it throws the conversation away, which is a heavy
/// price for "actually, stop".
#[tauri::command]
pub fn chat_interrupt(manager: State<Arc<ChatManager>>, key: String) -> Result<(), String> {
    chat_interrupt_impl(&manager, key)
}

/// The Tauri-free half of `chat_interrupt`.
pub fn chat_interrupt_impl(manager: &ChatManager, key: String) -> Result<(), String> {
    let session = {
        let sessions = manager.sessions.lock().map_err(|e| e.to_string())?;
        sessions.get(&key).cloned().ok_or("no such chat")?
    };
    let payload = json!({
        "type": "control_request",
        "request_id": format!("int-{}", uuid::Uuid::new_v4()),
        "request": { "subtype": "interrupt" }
    });
    let mut guard = session.lock().map_err(|e| e.to_string())?;
    let stdin = guard
        .stdin
        .as_mut()
        .ok_or("this chat does not take more input")?;
    writeln!(stdin, "{payload}").map_err(|e| e.to_string())?;
    stdin.flush().map_err(|e| e.to_string())
}

/// Is this line the agent asking whether it may use a tool? Its request id and
/// the request itself if so.
///
/// Control requests travel in BOTH directions on this channel. The ones we send
/// — `interrupt`, `set_permission_mode` — are answered by the agent with a
/// `control_response`. This is the other way round: `--permission-prompt-tool
/// stdio` makes the agent send `can_use_tool`, and the response is ours to
/// write.
fn can_use_tool(event: &Value) -> Option<(String, Value)> {
    if event.get("type")?.as_str()? != "control_request" {
        return None;
    }
    let request = event.get("request")?;
    if request.get("subtype")?.as_str()? != "can_use_tool" {
        return None;
    }
    Some((
        event.get("request_id")?.as_str()?.to_string(),
        request.clone(),
    ))
}

/// Was this line the agent answering our handshake?
fn answered_hello(event: &Value) -> bool {
    event.get("type").and_then(Value::as_str) == Some("control_response")
        && event
            .get("response")
            .and_then(|r| r.get("request_id"))
            .and_then(Value::as_str)
            .is_some_and(|id| id.starts_with(HELLO_REQUEST_ID))
}

/// Put the question to the person, then write the answer back to the agent.
///
/// The agent is BLOCKED until that answer arrives, so nothing here may be
/// skipped: every path writes exactly one `control_response`. A question that
/// went unanswered used to be a chat that sat still with nothing on screen
/// explaining why.
fn answer_permission(
    session: &Arc<Mutex<ChatSession>>,
    key: &str,
    rt: Option<&tokio::runtime::Handle>,
    request_id: String,
    request: Value,
) {
    let field = |name: &str| {
        request
            .get(name)
            .and_then(Value::as_str)
            .map(str::to_string)
    };
    let ask = crate::permission::Request {
        chat_key: Some(key.to_string()),
        session_id: field("session_id"),
        tool_name: field("tool_name"),
        tool_input: request.get("input").cloned(),
        tool_use_id: field("tool_use_id"),
        cwd: None,
        // Only the hook had a stale copy of the level to report. This arrives
        // from the live process, so there is nothing to fall back to.
        access: None,
    };

    let tool = ask.tool_name.clone().unwrap_or_default();
    let Some(rt) = rt else {
        // No runtime to wait on — the desktop build. Deny rather than leave the
        // agent parked on a question that will never be put to anyone.
        eprintln!("[perm] {key} no runtime to ask on; denying {tool}");
        write_control_response(
            session,
            &request_id,
            json!({ "behavior": "deny", "message": "OctiqFlow could not ask anyone." }),
        );
        return;
    };

    let session = session.clone();
    let key = key.to_string();
    rt.spawn(async move {
        eprintln!("[perm] {key} asking about {tool}");
        let answer = crate::permission::ask(ask).await;
        eprintln!(
            "[perm] {key} {tool} -> {} ({})",
            answer.decision, answer.reason
        );
        // `allow` is the only yes. Everything else — a refusal, a timeout,
        // nobody watching — is a no WITH ITS REASON, which the agent repeats to
        // the user. "Abstain" has no meaning here: the chain has already decided
        // it wants a person, so there is nothing left to defer to.
        let response = if answer.decision == "allow" {
            json!({ "behavior": "allow" })
        } else {
            json!({ "behavior": "deny", "message": answer.reason })
        };
        write_control_response(&session, &request_id, response);
    });
}

/// Write one `control_response` back to the agent. Best-effort: a chat whose
/// stdin has gone is a chat that is no longer waiting for this.
fn write_control_response(session: &Arc<Mutex<ChatSession>>, request_id: &str, response: Value) {
    let payload = json!({
        "type": "control_response",
        "response": {
            "subtype": "success",
            "request_id": request_id,
            "response": response,
        }
    });
    let Ok(mut guard) = session.lock() else {
        return;
    };
    let Some(stdin) = guard.stdin.as_mut() else {
        return;
    };
    let _ = writeln!(stdin, "{payload}");
    let _ = stdin.flush();
}

/// Marks a control request as ours, so its answer can be told apart from every
/// other one on the wire. Claude echoes the id back on the `control_response`.
const ACCESS_REQUEST_ID: &str = "octiq-access-";

/// The same, for the handshake. Its answer carries the agent's own capabilities
/// and is of no use to the UI, so it is recognised here and dropped.
const HELLO_REQUEST_ID: &str = "octiq-hello-";

/// Was this line Claude refusing a mode change we asked for? The error text if
/// so, and None for every other line — including our own successful answers.
fn refused_access_change(event: &Value) -> Option<String> {
    if event.get("type")?.as_str()? != "control_response" {
        return None;
    }
    let response = event.get("response")?;
    if response.get("subtype")?.as_str()? != "error" {
        return None;
    }
    if !response
        .get("request_id")?
        .as_str()?
        .starts_with(ACCESS_REQUEST_ID)
    {
        return None;
    }
    Some(
        response
            .get("error")
            .and_then(Value::as_str)
            .unwrap_or("the agent refused the change")
            .to_string(),
    )
}

/// Change what a RUNNING chat may do, WITHOUT ending it.
///
/// The mode is on the command line, so changing it used to mean killing the
/// process and letting the next message start a new one. That threw away a turn
/// in flight and said nothing about why the answer had stopped half-written.
/// Claude takes a `set_permission_mode` control request down the same stdin the
/// prompts go down — the way `chat_interrupt` takes `interrupt` — so the session
/// and its context survive the change.
///
/// The hook is told separately, through `ACCESS`. It runs BEFORE
/// `--permission-mode` is consulted, so the control request on its own would
/// leave it answering for the level the chat started on.
///
/// Not every change can be made this way, and the agent is the one that says
/// so: `bypassPermissions` is refused unless the process was launched with
/// `--dangerously-skip-permissions`, and `auto` is refused by models that do not
/// have it. Those answers arrive on stdout and go out as an `access-refused`
/// status (see `refused_access_change`); the UI falls back to a restart. The
/// recorded level is deliberately NOT rolled back when that happens — every
/// combination of "hook thinks X, agent is on Y" the failure can leave behind
/// ends in the agent asking or refusing, never in it acting unasked.
///
/// Codex has no such channel and needs none: every `codex exec` turn is its own
/// process and takes the new `--sandbox` on its command line, so recording the
/// level is the whole job.
#[tauri::command]
pub fn chat_set_access(
    manager: State<Arc<ChatManager>>,
    key: String,
    access: Access,
) -> Result<(), String> {
    chat_set_access_impl(&manager, key, access)
}

/// The Tauri-free half of `chat_set_access`.
pub fn chat_set_access_impl(
    manager: &ChatManager,
    key: String,
    access: Access,
) -> Result<(), String> {
    let session = {
        let sessions = manager.sessions.lock().map_err(|e| e.to_string())?;
        sessions.get(&key).cloned().ok_or("no such chat")?
    };
    // Written before the request goes out: a tool call already on its way to
    // the hook must not be answered under the level being left behind.
    with_access(|a| a.insert(key, access));

    let mut guard = session.lock().map_err(|e| e.to_string())?;
    if guard.agent != ChatAgent::Claude {
        return Ok(());
    }
    let payload = json!({
        "type": "control_request",
        "request_id": format!("{ACCESS_REQUEST_ID}{}", uuid::Uuid::new_v4()),
        "request": { "subtype": "set_permission_mode", "mode": access.claude() }
    });
    let stdin = guard
        .stdin
        .as_mut()
        .ok_or("this chat does not take more input")?;
    writeln!(stdin, "{payload}").map_err(|e| e.to_string())?;
    stdin.flush().map_err(|e| e.to_string())
}

/// Stop a chat and drop it. Killing an unknown key is a no-op success, so the
/// UI can close a chat twice without caring.
#[tauri::command]
pub fn chat_stop(manager: State<Arc<ChatManager>>, key: String) -> Result<(), String> {
    chat_stop_impl(&manager, key)
}

/// The Tauri-free half of `chat_stop`.
pub fn chat_stop_impl(manager: &ChatManager, key: String) -> Result<(), String> {
    // Anything the person allowed "always" was allowed for THIS piece of work.
    // Outliving it would be a permission nobody remembers giving.
    crate::permission::forget_chat(&key);
    let session = {
        let mut sessions = manager.sessions.lock().map_err(|e| e.to_string())?;
        sessions.remove(&key)
    };
    with_access(|a| a.remove(&key));
    let Some(session) = session else {
        return Ok(());
    };
    let mut guard = session.lock().map_err(|e| e.to_string())?;
    // Closing stdin asks Claude to finish; the kill is the backstop.
    guard.stdin.take();
    let _ = guard.child.kill();
    Ok(())
}

/// An MCP server carrying the two tools print mode has no answer for: asking
/// the user something, and keeping a TODO list on their screen.
///
/// Print mode is never offered `AskUserQuestion` or `TodoWrite` — there is
/// nobody to answer and nowhere to draw, so neither tool reaches the model. It
/// does load MCP servers in full, so this hands it ours instead.
const ASK_MCP: &str = include_str!("../../scripts/mcp/octiq-ask.cjs");

/// Told to the agent so it knows the tool is there and when it is wanted.
/// Without this it has a tool it never thinks to reach for.
const ASK_PROMPT: &str = "When a decision is the user's to make rather than yours — which of several approaches to take, what something should be called, whether an assumption you are about to build on is right — call the `ask_user` tool and wait for their answer. Prefer it over guessing and over stopping to ask in prose: they may be on a phone, and it puts the question in front of them wherever they are.\n\nWhen you take on work that runs to more than a step or two, call the `todo_write` tool straight away with the whole plan, and call it again whenever an item starts or finishes. The list is pinned on their screen: it is how they see that you understood the request, and how far through it you are. Keep exactly one item in_progress, and send the whole list each time.";

/// Write the ask-user MCP server and its config, and return the config path.
///
/// Rewritten on every start, like the hook, so an upgraded OctiqFlow cannot
/// leave an old copy behind. Best-effort: without it the chat simply runs
/// without the tool, which is how it behaved before this existed.
fn ask_mcp_config() -> Option<std::path::PathBuf> {
    let dir = crate::paths::home_dir()?.join(".octiqflow").join("mcp");
    std::fs::create_dir_all(&dir).ok()?;

    let script = dir.join("octiq-ask.cjs");
    std::fs::write(&script, ASK_MCP).ok()?;

    let config = dir.join("octiq-ask.json");
    let body = json!({
        "mcpServers": {
            "octiq": {
                "command": "node",
                "args": [script.to_string_lossy()],
            }
        }
    });
    std::fs::write(&config, serde_json::to_vec_pretty(&body).ok()?).ok()?;
    Some(config)
}

/// Where pasted images are kept. Under `~/.octiqflow` rather than in the
/// project, because a screenshot you pasted into a chat is not part of anyone's
/// repository and must never turn up in `git status`.
fn attachments_dir() -> Result<std::path::PathBuf, String> {
    let dir = crate::paths::home_dir()
        .ok_or("could not find your home folder")?
        .join(".octiqflow")
        .join("attachments");
    std::fs::create_dir_all(&dir).map_err(|e| format!("could not make {dir:?}: {e}"))?;
    Ok(dir)
}

/// Save a pasted image and return its path.
///
/// A clipboard image has no file behind it, and both agents need one: Codex
/// takes `-i <FILE>`, and Claude wants bytes we can only read from somewhere.
/// So it lands on disk first, and the path is what the rest of the flow passes
/// around — the same shape as a file the user picked.
///
/// The name is ours, never the browser's: a name from the page could carry
/// `../` and walk out of the folder.
#[tauri::command]
pub fn save_attachment(data_base64: String, extension: String) -> Result<String, String> {
    use base64::Engine;
    let ext = extension
        .trim()
        .trim_start_matches('.')
        .to_ascii_lowercase();
    let ext = match ext.as_str() {
        "png" | "jpg" | "jpeg" | "gif" | "webp" => ext,
        _ => return Err(format!("unsupported image type: {extension}")),
    };
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(data_base64.as_bytes())
        .map_err(|e| format!("not valid base64: {e}"))?;
    if bytes.is_empty() {
        return Err("empty image".into());
    }
    if bytes.len() > 12 * 1024 * 1024 {
        return Err("image is larger than 12 MB".into());
    }
    let path = attachments_dir()?.join(format!("{}.{ext}", uuid::Uuid::new_v4()));
    std::fs::write(&path, bytes).map_err(|e| format!("could not save the image: {e}"))?;
    Ok(path.to_string_lossy().into_owned())
}

/// The chats that exist, newest first.
#[tauri::command]
pub fn chat_index_list() -> Vec<crate::chat_index::ChatMeta> {
    crate::chat_index::list()
}

/// Record a chat, or update what is known about it.
#[tauri::command]
pub fn chat_index_save(meta: crate::chat_index::ChatMeta) -> Result<(), String> {
    crate::chat_index::upsert(meta)
}

/// Forget a chat entirely — its entry in the list and its transcript.
#[tauri::command]
pub fn chat_index_remove(id: String, key: String) -> Result<(), String> {
    crate::transcript::forget(&key);
    crate::chat_index::remove(&id)
}

/// Everything a chat said after `after`.
///
/// How a client catches up. It remembers the highest seq it has seen and asks
/// for the rest — after a reconnect, a reload, or on a second device that has
/// never seen this conversation at all.
#[tauri::command]
pub fn chat_since(key: String, after: u64) -> Vec<crate::transcript::Recorded> {
    crate::transcript::since(&key, after)
}

/// Throw away a chat's record. Deleting a conversation should leave nothing.
#[tauri::command]
pub fn chat_forget(key: String) {
    crate::transcript::forget(&key);
}

/// The keys of every running chat. A reconnecting browser uses this the way it
/// uses pty_active_sessions: to find what is already going.
#[tauri::command]
pub fn chat_list(manager: State<Arc<ChatManager>>) -> Result<Vec<String>, String> {
    chat_list_impl(&manager)
}

/// The Tauri-free half of `chat_list`.
pub fn chat_list_impl(manager: &ChatManager) -> Result<Vec<String>, String> {
    let sessions = manager.sessions.lock().map_err(|e| e.to_string())?;
    Ok(sessions.keys().cloned().collect())
}

#[cfg(test)]
mod tests {

    use super::*;

    #[test]
    fn full_access_is_named_in_the_environment_the_hook_reads() {
        assert_eq!(Access::Full.as_env(), "full");
        assert_eq!(Access::Auto.as_env(), "auto");
        assert_eq!(Access::Read.as_env(), "read");
    }

    #[test]
    fn the_agents_permission_question_is_recognised_and_nothing_else_is() {
        // The shape is measured, not guessed: it is what `claude -p
        // --permission-prompt-tool stdio` actually wrote when asked to run a
        // command it needed approval for.
        let asking = json!({
            "type": "control_request",
            "request_id": "req-1",
            "request": {
                "subtype": "can_use_tool",
                "tool_name": "Bash",
                "display_name": "Bash",
                "input": { "command": "mkfifo /tmp/x.fifo" },
                "permission_suggestions": [{
                    "type": "addRules",
                    "rules": [{ "toolName": "Bash", "ruleContent": "mkfifo /tmp/x.fifo" }]
                }]
            }
        });
        let (id, request) = can_use_tool(&asking).expect("the question");
        assert_eq!(id, "req-1");
        assert_eq!(request["tool_name"], "Bash");

        // Control requests travel BOTH ways on this channel. Ours must not be
        // mistaken for the agent's, or setting the mode would raise a question.
        let ours = json!({
            "type": "control_request",
            "request_id": "octiq-access-1",
            "request": { "subtype": "set_permission_mode", "mode": "auto" }
        });
        assert!(can_use_tool(&ours).is_none());
        assert!(can_use_tool(&json!({ "type": "assistant" })).is_none());
    }

    #[test]
    fn the_agent_is_told_to_ask_us_rather_than_deny() {
        // Without this flag an `ask` decision in print mode is terminal: the
        // call is denied, nobody is asked, and the chat says nothing about why.
        let line = build_command(
            ChatAgent::Claude,
            None,
            Some(Access::Auto),
            "hello",
            None,
            &[],
            None,
            &[],
            false,
        );
        assert!(line.contains("--permission-prompt-tool stdio"));
    }

    #[test]
    fn the_question_tool_the_agent_cannot_be_answered_on_is_taken_back() {
        // `--permission-prompt-tool stdio` does not only route permissions. It
        // also hands the model `AskUserQuestion`, which plain print mode never
        // offered: measured on the same CLI, 30 built-in tools without the flag
        // and 33 with it, the three being `AskUserQuestion`, `EnterPlanMode`
        // and `ExitPlanMode`. The flag alone does it; the handshake is not
        // involved.
        //
        // That tool is not ours to answer. It is not a `can_use_tool` request —
        // permission is granted and the CLI then runs the tool itself, looking
        // for an interactive prompt that a `-p` process does not have. It gives
        // up at once and tells the agent "The user did not answer the
        // questions", which reads as a refusal nobody made.
        //
        // So it is taken back, and `ask_user` is left as the only way to ask —
        // the one that reaches a phone. Unconditional on purpose: when the MCP
        // config could not be written there is no `ask_user` either, and no
        // question at all is what this command line did before the flag arrived.
        let line = build_command(
            ChatAgent::Claude,
            None,
            Some(Access::Auto),
            "hello",
            None,
            &[],
            None,
            &[],
            false,
        );
        assert!(line.contains("--disallowedTools AskUserQuestion"));
    }

    #[test]
    fn a_lite_chat_drops_the_machines_skills_hooks_and_other_mcp_servers() {
        // What this machine loads into a chat that never asked for it: ten MCP
        // servers, every installed skill, and the SessionStart hooks. Measured
        // in this repo, that is 60.4k of context before the first word — half
        // of it the skill list alone. Lite is the same chat without them.
        //
        // `--bare` is the flag that reads like the answer and is not: it never
        // looks at the OAuth login or the keychain, so on a subscription it
        // dies at "Not logged in" before it reaches the model. `--safe-mode`
        // does keep the login, but it drops MCP servers passed with
        // `--mcp-config` too — which is where `ask_user` lives, so the chat
        // could no longer ask anything. These three flags are the cut that
        // leaves the login and our own two tools standing: 30.2k.
        let line = build_command(
            ChatAgent::Claude,
            None,
            Some(Access::Auto),
            "hello",
            None,
            &[],
            None,
            &[],
            true,
        );
        assert!(line.contains("--strict-mcp-config"));
        assert!(line.contains("--disable-slash-commands"));
        // Empty, and quoted: the flag takes a list, and no list is the whole
        // point. An unquoted empty word would vanish in the shell and the next
        // flag would be read as its value.
        assert!(line.contains("--setting-sources ''"));
        // Ours survives the cut. `--strict-mcp-config` means ONLY the servers
        // named on this command line, and ours is named on it.
        assert!(line.contains("--mcp-config"));
    }

    #[test]
    fn a_normal_chat_still_gets_everything_this_machine_offers() {
        let line = build_command(
            ChatAgent::Claude,
            None,
            Some(Access::Auto),
            "hello",
            None,
            &[],
            None,
            &[],
            false,
        );
        assert!(!line.contains("--strict-mcp-config"));
        assert!(!line.contains("--disable-slash-commands"));
        assert!(!line.contains("--setting-sources"));
    }

    #[test]
    fn lite_says_nothing_to_codex() {
        // Codex loads its skills from a folder rather than from the config it
        // can be told to ignore, so the same idea saved 21.2k against 20.8k
        // there — a rounding error, for flags that would still have to be
        // written and kept right. The switch is a Claude one until that changes.
        let line = build_command(
            ChatAgent::Codex,
            None,
            Some(Access::Auto),
            "hello",
            None,
            &[],
            None,
            &[],
            true,
        );
        assert!(!line.contains("--ignore-user-config"));
        assert!(!line.contains("--strict-mcp-config"));
    }

    #[test]
    fn a_folder_name_cannot_break_out_of_the_toml_string_it_lands_in() {
        // `writable_roots` is a TOML array built by hand, so the path inside it
        // has to survive TOML as well as the shell. sh_quote covers the shell
        // and nothing else: a `"` in a folder name would close the string and
        // whatever follows would be read as more config.
        assert_eq!(toml_string(r#"/tmp/plain"#), r#""/tmp/plain""#);
        assert_eq!(
            toml_string(r#"/tmp/a", evil = "yes"#),
            r#""/tmp/a\", evil = \"yes""#
        );
        assert_eq!(toml_string(r"/tmp/back\slash"), r#""/tmp/back\\slash""#);
    }

    #[test]
    fn a_codex_resume_puts_the_folder_in_the_config_key_safely() {
        let line = build_command(
            ChatAgent::Codex,
            None,
            None,
            "hello",
            Some("abc-123"),
            &[r#"/tmp/a", evil = "yes"#.to_string()],
            None,
            &[],
            false,
        );
        assert!(
            line.contains(r#"["/tmp/a\", evil = \"yes"]"#),
            "the folder must arrive escaped: {line}"
        );
    }

    #[test]
    fn quotes_close_the_hole() {
        assert_eq!(sh_quote("plain"), "'plain'");
        // The one character that can end the quoted run is re-opened safely.
        assert_eq!(sh_quote("it's"), r"'it'\''s'");
        assert_eq!(sh_quote("a; rm -rf /"), "'a; rm -rf /'");
    }

    #[test]
    fn model_names_are_allowlisted() {
        assert_eq!(safe_model("opus").as_deref(), Some("opus"));
        assert_eq!(
            safe_model("claude-fable-5").as_deref(),
            Some("claude-fable-5")
        );
        assert_eq!(safe_model("gpt-5.6-sol").as_deref(), Some("gpt-5.6-sol"));
        // Anything that could become another shell word is refused outright.
        assert_eq!(safe_model("opus; id"), None);
        assert_eq!(safe_model("$(id)"), None);
        assert_eq!(safe_model(""), None);
    }

    #[test]
    fn resume_only_takes_a_plain_id() {
        let id = "a2c8ca18-dcd4-41bc-a49d-b078f2a8e056";
        let c = build_command(ChatAgent::Claude, None, None, "", Some(id), &[], None, &[], false);
        assert!(c.contains(&format!("--resume '{id}'")));
        // Anything that could become a second shell word is dropped outright.
        let bad = build_command(
            ChatAgent::Claude,
            None,
            None,
            "",
            Some("x; rm -rf /"),
            &[],
            None,
            &[],
            false,
        );
        assert!(!bad.contains("--resume"));
    }

    #[test]
    fn one_access_level_becomes_each_agents_own_flag() {
        // The same question — how much may it do unattended — asked once and
        // spelled differently for each agent. Codex needs BOTH halves: a sandbox
        // says what a command may touch, an approval policy says whether it runs
        // unasked. Setting only the sandbox left the middle level asking about
        // everything and the top level asking at all, neither of which is what
        // the label promises.
        for (level, claude, sandbox, approval) in [
            (Access::Read, "plan", "read-only", "never"),
            (Access::Auto, "auto", "workspace-write", "on-request"),
            (
                Access::Full,
                "bypassPermissions",
                "danger-full-access",
                "never",
            ),
        ] {
            let c = build_command(
                ChatAgent::Claude,
                None,
                Some(level),
                "",
                None,
                &[],
                None,
                &[],
                false,
            );
            assert!(
                c.contains(&format!("--permission-mode {claude}")),
                "claude {level:?}"
            );
            assert!(
                !c.contains("--sandbox"),
                "claude must not get a sandbox flag"
            );

            let x = build_command(
                ChatAgent::Codex,
                None,
                Some(level),
                "hi",
                None,
                &[],
                None,
                &[],
                false,
            );
            assert!(
                x.contains(&format!("--sandbox {sandbox}")),
                "codex {level:?}"
            );
            assert!(
                x.contains(&format!("-c approval_policy='{approval}'")),
                "codex approval {level:?}"
            );
            assert!(
                !x.contains("--ask-for-approval"),
                "codex exec dropped the flag form; it only takes the config key"
            );
            assert!(
                !x.contains("--permission-mode"),
                "codex must not get a permission mode"
            );
        }
    }

    #[test]
    fn codex_resume_spells_both_halves_as_config_keys() {
        // `codex exec resume` accepts neither --sandbox nor --ask-for-approval,
        // so the same two settings have to travel as -c keys or a resumed chat
        // silently falls back to whatever the user's own config says.
        let id = "a2c8ca18-dcd4-41bc-a49d-b078f2a8e056";
        let x = build_command(
            ChatAgent::Codex,
            None,
            Some(Access::Auto),
            "hi",
            Some(id),
            &[],
            None,
            &[],
            false,
        );
        assert!(x.contains("-c sandbox_mode='workspace-write'"));
        assert!(x.contains("-c approval_policy='on-request'"));
        assert!(!x.contains("--sandbox"), "resume does not take --sandbox");
        assert!(
            !x.contains("--ask-for-approval"),
            "resume does not take the flag form"
        );
    }

    #[test]
    fn claude_gets_a_two_way_stream_and_codex_gets_the_prompt() {
        // A prompt that cannot appear by accident inside another word. The
        // first version of this test used "hi", which is a substring of
        // "which" — so it passed until an unrelated flag happened to contain
        // that word, then failed for a reason that had nothing to do with the
        // thing being tested.
        let prompt = "zzq-prompt-marker";
        let c = build_command(
            ChatAgent::Claude,
            Some("opus"),
            Some(Access::Read),
            prompt,
            None,
            &[],
            None,
            &[],
            false,
        );
        assert!(c.contains("--input-format stream-json"));
        assert!(c.contains("--model 'opus'"));
        assert!(c.contains("--permission-mode plan"));
        // Claude's prompt goes over stdin, never on the command line.
        assert!(!c.contains(prompt));

        let x = build_command(
            ChatAgent::Codex,
            None,
            None,
            "hi there",
            None,
            &[],
            None,
            &[],
            false,
        );
        assert!(x.contains("codex exec --json"));
        assert!(x.ends_with("'hi there'"));
    }

    #[test]
    fn effort_is_an_allowlist_and_spelled_per_agent() {
        let c = build_command(
            ChatAgent::Claude,
            None,
            None,
            "",
            None,
            &[],
            Some("xhigh"),
            &[],
            false,
        );
        assert!(c.contains("--effort xhigh"));
        // Codex supports it too, but only as a config override.
        let x = build_command(
            ChatAgent::Codex,
            None,
            None,
            "hi",
            None,
            &[],
            Some("xhigh"),
            &[],
            false,
        );
        assert!(x.contains("-c model_reasoning_effort='xhigh'"));
        assert!(!x.contains("--effort"));

        // Anything outside the set is dropped rather than forwarded.
        let bad = build_command(
            ChatAgent::Claude,
            None,
            None,
            "",
            None,
            &[],
            Some("turbo; id"),
            &[],
            false,
        );
        assert!(!bad.contains("--effort"));

        // `max` is BOTH agents': Codex's own model list gives it to every
        // GPT-5.6 model (`supported_reasoning_levels` in
        // `~/.codex/models_cache.json`), so refusing it here dropped a level
        // the agent would have taken.
        let claude_max = build_command(
            ChatAgent::Claude,
            None,
            None,
            "",
            None,
            &[],
            Some("max"),
            &[],
            false,
        );
        assert!(claude_max.contains("--effort max"));
        let codex_max = build_command(
            ChatAgent::Codex,
            None,
            None,
            "hi",
            None,
            &[],
            Some("max"),
            &[],
            false,
        );
        assert!(codex_max.contains("model_reasoning_effort='max'"));

        // `minimal` is nobody's any more. The same model list dropped it from
        // every GPT-5.6 model, and Claude never had it.
        let codex_min = build_command(
            ChatAgent::Codex,
            None,
            None,
            "hi",
            None,
            &[],
            Some("minimal"),
            &[],
            false,
        );
        assert!(!codex_min.contains("model_reasoning_effort"));
        let claude_min = build_command(
            ChatAgent::Claude,
            None,
            None,
            "",
            None,
            &[],
            Some("minimal"),
            &[],
            false,
        );
        assert!(!claude_min.contains("--effort"));

        // `ultracode` is Claude's top rung. It is missing from `--help`, but the
        // flag takes it: an unknown value warns and falls back, and this one
        // does not.
        let ultra = build_command(
            ChatAgent::Claude,
            None,
            None,
            "",
            None,
            &[],
            Some("ultracode"),
            &[],
            false,
        );
        assert!(ultra.contains("--effort ultracode"));
        let codex_ultra = build_command(
            ChatAgent::Codex,
            None,
            None,
            "hi",
            None,
            &[],
            Some("ultracode"),
            &[],
            false,
        );
        assert!(!codex_ultra.contains("model_reasoning_effort"));

        // `auto` deliberately reaches the command line as nothing at all: the
        // flag rejects it, and no flag IS "the agent picks". The UI then sends
        // `/effort auto` to the running session, which does take it.
        let auto = build_command(
            ChatAgent::Claude,
            None,
            None,
            "",
            None,
            &[],
            Some("auto"),
            &[],
            false,
        );
        assert!(!auto.contains("--effort"));
    }

    #[test]
    fn codex_continues_a_conversation_by_resuming_its_thread() {
        let id = "01a0142d-552d-7a93-9152-47530c33e501";
        let c = build_command(
            ChatAgent::Codex,
            None,
            Some(Access::Read),
            "next question",
            Some(id),
            &["/tmp/api".to_string()],
            Some("high"),
            &[],
            false,
        );
        // The subcommand, with the id BEFORE the prompt — that is the order
        // `codex exec resume [OPTIONS] [SESSION_ID] [PROMPT]` expects.
        assert!(c.starts_with(&format!("codex exec resume --json '{id}'")));
        assert!(c.ends_with("'next question'"));
        // resume takes neither --sandbox nor --add-dir, so both settings have
        // to travel as config overrides instead.
        assert!(!c.contains("--sandbox"));
        assert!(!c.contains("--add-dir"));
        assert!(c.contains("-c sandbox_mode='read-only'"));
        assert!(c.contains("-c model_reasoning_effort='high'"));
        assert!(c.contains("writable_roots"));

        // A FIRST turn has no thread yet, so it is a plain exec with the flags.
        let first = build_command(
            ChatAgent::Codex,
            None,
            Some(Access::Read),
            "hello",
            None,
            &["/tmp/api".to_string()],
            None,
            &[],
            false,
        );
        assert!(first.starts_with("codex exec --json"));
        assert!(!first.contains("resume"));
        assert!(first.contains("--sandbox read-only"));
        assert!(first.contains("--add-dir '/tmp/api'"));
    }

    #[test]
    fn the_stdin_notice_codex_always_prints_is_not_a_notice() {
        assert!(is_expected_chatter(
            "Reading additional input from stdin..."
        ));
        assert!(is_expected_chatter(
            "  Reading additional input from stdin... "
        ));
        // Anything else still reaches the user — that is the whole point of
        // surfacing stderr.
        assert!(!is_expected_chatter("Error loading config.toml"));
        assert!(!is_expected_chatter("You've hit your usage limit."));
    }

    #[test]
    fn codex_takes_images_as_files_and_claude_does_not() {
        let shots = vec!["/tmp/a shot.png".to_string(), "/tmp/b.webp".to_string()];
        let x = build_command(
            ChatAgent::Codex,
            None,
            None,
            "look",
            None,
            &[],
            None,
            &shots,
            false,
        );
        // Quoted, so a space in the name stays one argument.
        assert!(x.contains("-i '/tmp/a shot.png'"));
        assert!(x.contains("-i '/tmp/b.webp'"));
        // ...and the prompt still ends the line, after the images.
        assert!(x.ends_with("'look'"));

        // Claude's images ride on stdin instead — see write_user_message.
        let c = build_command(
            ChatAgent::Claude,
            None,
            None,
            "look",
            None,
            &[],
            None,
            &shots,
            false,
        );
        assert!(!c.contains("-i "));
    }

    #[test]
    fn only_real_image_extensions_are_offered_to_the_model() {
        assert_eq!(image_media_type("/tmp/a.PNG"), Some("image/png"));
        assert_eq!(image_media_type("/tmp/a.jpeg"), Some("image/jpeg"));
        assert_eq!(image_media_type("/tmp/a.webp"), Some("image/webp"));
        // Not an image: passing it on would be an API error, so it is dropped.
        assert_eq!(image_media_type("/tmp/notes.md"), None);
        assert_eq!(image_media_type("/tmp/noextension"), None);
    }

    #[test]
    fn a_projects_other_folders_are_added_for_both_agents() {
        let dirs = vec!["/Users/me/api".to_string(), "/Users/me/my docs".to_string()];
        let c = build_command(ChatAgent::Claude, None, None, "", None, &dirs, None, &[], false);
        assert!(c.contains("--add-dir '/Users/me/api'"));
        // A space in a folder name stays one argument.
        assert!(c.contains("--add-dir '/Users/me/my docs'"));

        // Codex takes extra folders too — it was a mistake to think otherwise.
        let x = build_command(ChatAgent::Codex, None, None, "hi", None, &dirs, None, &[], false);
        assert!(x.contains("--add-dir '/Users/me/api'"));
        assert!(x.contains("--add-dir '/Users/me/my docs'"));
    }
}

#[cfg(test)]
mod access_tests {
    use super::*;

    #[test]
    fn a_refusal_of_our_own_mode_change_is_picked_out_of_the_stream() {
        let refused = json!({
            "type": "control_response",
            "response": {
                "subtype": "error",
                "request_id": format!("{ACCESS_REQUEST_ID}1"),
                "error": "Cannot set permission mode to bypassPermissions \
                          because the session was not launched with \
                          --dangerously-skip-permissions"
            }
        });
        assert!(refused_access_change(&refused)
            .expect("a refusal")
            .contains("bypassPermissions"));
    }

    #[test]
    fn nothing_else_on_the_wire_is_mistaken_for_one() {
        // Our own success, somebody else's control request, and an ordinary
        // message. None of these means the picker is lying about the level.
        let ours_worked = json!({
            "type": "control_response",
            "response": { "subtype": "success", "request_id": format!("{ACCESS_REQUEST_ID}1") }
        });
        let someone_elses = json!({
            "type": "control_response",
            "response": { "subtype": "error", "request_id": "int-1", "error": "no" }
        });
        let a_message = json!({ "type": "assistant", "message": { "content": [] } });
        assert!(refused_access_change(&ours_worked).is_none());
        assert!(refused_access_change(&someone_elses).is_none());
        assert!(refused_access_change(&a_message).is_none());
    }

    #[test]
    fn a_level_survives_the_round_trip_through_the_hook_environment() {
        for level in [Access::Read, Access::Auto, Access::Full] {
            assert_eq!(Access::from_env(level.as_env()), level);
        }
        // And an unknown word is the cautious one, not the permissive one.
        assert_eq!(Access::from_env("bypassPermissions"), Access::Read);
        assert_eq!(Access::from_env(""), Access::Read);
    }

    #[test]
    fn each_level_names_a_mode_claude_will_actually_take() {
        // Verified against the CLI's own control channel: `plan` and `auto` are
        // accepted mid-session, `bypassPermissions` only when the process was
        // launched for it — which is why a switch UP to Full still restarts.
        assert_eq!(Access::Read.claude(), "plan");
        assert_eq!(Access::Auto.claude(), "auto");
        assert_eq!(Access::Full.claude(), "bypassPermissions");
    }
}
