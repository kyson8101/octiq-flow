//! Peer help: a registered agent asking a teammate one question while it
//! works.
//!
//! A question and an answer, never a handoff. The asker keeps its task, its
//! workspace and its report; the teammate only reads and advises. The host
//! decides every part of it — who may be asked, how often, and what the
//! answering turn may touch — so none of it rests on an agent's word:
//!
//! - Two kinds of chat may ask: the chat of a RUNNING attempt whose task was
//!   handed to a registered agent, and a registered lead's own agents-mode
//!   chat (`LeadCaller`, which the caller builds from the chat's capability,
//!   never from an argument). Only a registered member of the asker's own
//!   team (`team::teammates`) who may work in the project may answer.
//! - The answer runs as the teammate's registered identity (provider, model,
//!   effort) in a one-shot process that has read tools only, no MCP server at
//!   all and none of the chat's `OCTIQ_*` variables. It cannot write, cannot
//!   reach the orchestration hook, and so cannot ask a peer of its own.
//! - Each attempt may ask `MAX_ASKS_PER_ATTEMPT` times, and a lead chat
//!   `MAX_LEAD_ASKS_PER_HOUR` times in any rolling hour; an answer longer
//!   than `MAX_ANSWER_CHARS` is cut there.
//! - Every ask is recorded (`PeerAsk`) before the teammate is started and
//!   settled when it answers, so it shows whatever the asker does with it. A
//!   worker's is recorded under its run, task and attempt; a lead chat has
//!   no attempt, so its ask names the chat (`asker_chat_key`) and, when the
//!   chat coordinates a live run, that run.
//!
//! No gate: a peer ask reads and advises, and changes nothing about
//! reports-to, project scope, access or plan approval. Work is asked for
//! with `peer_request.rs`, which does wait for the person.
use std::io::Read;
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

use serde_json::Value;

use super::*;
use crate::team::{AgentTeam, TeamAgent};

/// Asks one attempt may make, answered or not.
pub const MAX_ASKS_PER_ATTEMPT: usize = 5;
/// Asks one lead chat may make in any `LEAD_ASK_WINDOW_MS`, answered or not.
pub const MAX_LEAD_ASKS_PER_HOUR: usize = 5;
/// The rolling window `MAX_LEAD_ASKS_PER_HOUR` is counted over.
pub const LEAD_ASK_WINDOW_MS: i64 = 60 * 60 * 1000;
/// The longest question a worker may put.
pub const MAX_QUESTION_CHARS: usize = 4_000;
/// The longest answer handed back and kept; the rest is cut.
pub const MAX_ANSWER_CHARS: usize = 8_000;
/// Files a worker may point its teammate at.
pub const MAX_CONTEXT_PATHS: usize = 8;
/// How long a teammate has to answer before its process is ended.
const HELPER_TIMEOUT: Duration = Duration::from_secs(10 * 60);

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum PeerAskStatus {
    /// The teammate's turn is running.
    Asking,
    Answered,
    /// The teammate could not answer; `error` says why.
    Failed,
}

/// Tokens the answering turn used, as its provider reported them.
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PeerUsage {
    pub input_tokens: u64,
    pub output_tokens: u64,
}

/// One question and its answer, as the run keeps it.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PeerAsk {
    pub id: String,
    /// The run the ask belongs to: the asking worker's, or the live run a
    /// lead chat coordinates. Empty for a lead chat that coordinates none.
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub run_id: String,
    /// The asking worker's task and attempt. Empty for a lead chat's ask.
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub task_id: String,
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub attempt_id: String,
    /// The lead chat that asked, when the asker is not a worker.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub asker_chat_key: Option<String>,
    pub asker: TaskAssignee,
    pub helper: TaskAssignee,
    /// The identity the answer ran as, copied from the teammate's record
    /// when it was asked.
    pub helper_agent: ChatAgent,
    pub helper_model: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub helper_effort: Option<String>,
    pub question: String,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub context_paths: Vec<String>,
    pub status: PeerAskStatus,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub answer: Option<String>,
    /// The answer was longer than `MAX_ANSWER_CHARS`; `answer` is its start.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub truncated: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub usage: Option<PeerUsage>,
    pub asked_at: i64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub answered_at: Option<i64>,
}

/// What the worker asked, as its tool call gave it.
#[derive(Clone, Debug, Default)]
pub struct PeerQuestion {
    pub teammate_id: String,
    pub question: String,
    pub context_paths: Vec<String>,
}

/// A registered lead calling from its own agents-mode chat. Built by the
/// caller from what the host knows about the chat its capability proves (the
/// lead record, the chat's project and folder), never from a tool argument.
#[derive(Clone, Debug, PartialEq)]
pub struct LeadCaller {
    pub agent_id: String,
    /// The chat's project.
    pub project_id: String,
    /// The chat's folder: what a teammate reads to answer, and where a run
    /// the host opens for a peer request is rooted.
    pub cwd: String,
    /// The lead the person talks to across projects (`LeadRecord`).
    pub cross_project: bool,
}

/// Everything the one-shot answering process needs.
#[derive(Clone, Debug, PartialEq)]
pub struct HelperTurn {
    pub agent: ChatAgent,
    pub model: String,
    pub effort: Option<String>,
    /// The asker's workspace, which the teammate reads and never writes.
    pub cwd: String,
    pub prompt: String,
}

/// What the answering process said.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct HelperAnswer {
    pub text: String,
    pub usage: Option<PeerUsage>,
}

/// What the asker's tool call returns.
#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PeerReply {
    pub ask_id: String,
    pub teammate: String,
    pub answer: String,
    pub truncated: bool,
    pub asks_left: usize,
}

/// The teammate a worker may ask: a registered member of its own team, not
/// itself, who may work in the task's project. By id, or by exact name.
pub fn choose_helper<'a>(
    agents: &'a [TeamAgent],
    teams: &[AgentTeam],
    asker_id: &str,
    teammate: &str,
    project_id: &str,
) -> Result<&'a TeamAgent, String> {
    let teammate = teammate.trim();
    let asker = agents
        .iter()
        .find(|a| a.id == asker_id)
        .ok_or("You are no longer a registered agent, so you have no team to ask.")?;
    let team = asker
        .team_id
        .as_deref()
        .and_then(|id| teams.iter().find(|t| t.id == id))
        .ok_or("You are not on a team, so there is no teammate to ask. Carry on with the task yourself.")?;
    if teammate.is_empty() {
        return Err("Name the teammate to ask by id.".into());
    }
    if teammate == asker.id || teammate.eq_ignore_ascii_case(&asker.name) {
        return Err("You cannot ask yourself. Ask a teammate, or work it out.".into());
    }
    let peers = crate::team::teammates(agents, teams, asker);
    let listed = || {
        let names: Vec<_> = peers
            .iter()
            .filter(|a| crate::team::may_work_in(a, project_id))
            .map(|a| format!("{} (`{}`)", a.name, a.id))
            .collect();
        if names.is_empty() {
            "no one on your team can look at this project".to_owned()
        } else {
            format!("you can ask {}", names.join(", "))
        }
    };
    let helper = agents
        .iter()
        .find(|a| a.id == teammate)
        .or_else(|| {
            agents
                .iter()
                .find(|a| a.name.eq_ignore_ascii_case(teammate))
        })
        .ok_or_else(|| format!("No registered agent is called {teammate}; {}.", listed()))?;
    if helper.team_id.as_deref() != Some(team.id.as_str()) {
        return Err(format!(
            "{} is not on your team ({}); {}.",
            helper.name,
            team.name,
            listed()
        ));
    }
    if !crate::team::may_work_in(helper, project_id) {
        return Err(format!(
            "{} works only in another project and cannot look at this task's work; {}.",
            helper.name,
            listed()
        ));
    }
    Ok(helper)
}

/// The paths a worker pointed at, each inside its workspace and existing,
/// spelled relative to it.
pub fn context_paths(cwd: &str, paths: &[String]) -> Result<Vec<String>, String> {
    if paths.len() > MAX_CONTEXT_PATHS {
        return Err(format!(
            "Point your teammate at {MAX_CONTEXT_PATHS} files or fewer."
        ));
    }
    let root = crate::paths::canonicalize(cwd)
        .map_err(|_| "Your workspace could not be read.".to_string())?;
    paths
        .iter()
        .map(|given| {
            let trimmed = given.trim();
            let candidate = Path::new(trimmed);
            let joined = if candidate.is_absolute() {
                candidate.to_path_buf()
            } else {
                root.join(candidate)
            };
            let real = crate::paths::canonicalize(&joined)
                .map_err(|_| format!("{trimmed} does not exist in your workspace."))?;
            let inside = real
                .strip_prefix(&root)
                .map_err(|_| format!("{trimmed} is outside your workspace."))?;
            let spelled = inside.to_string_lossy().replace('\\', "/");
            Ok(if spelled.is_empty() {
                ".".to_owned()
            } else {
                spelled
            })
        })
        .collect()
}

/// What the teammate is told. The question is quoted as the asker's words;
/// the rules around it are the host's.
pub fn helper_prompt(
    policy: &str,
    helper: &TeamAgent,
    asker: &str,
    task_title: Option<&str>,
    question: &str,
    paths: &[String],
) -> String {
    // A worker asks from its task; a lead from the conversation it leads.
    let doing = match task_title {
        Some(title) => format!("is working on the task \"{title}\""),
        None => "is leading a conversation with the person".to_owned(),
    };
    let role = if helper.role.trim().is_empty() {
        String::new()
    } else {
        format!(" Your role: {}.", helper.role.replace('\n', " "))
    };
    let paths = if paths.is_empty() {
        String::new()
    } else {
        format!(
            "\n\nFiles {asker} suggests reading first (relative to the current directory):\n{}",
            paths
                .iter()
                .map(|p| format!("- {p}"))
                .collect::<Vec<_>>()
                .join("\n")
        )
    };
    // The shared policy and the helper's standing instructions come first,
    // as in every brief the helper is launched with.
    let standing = crate::team::standing_brief(policy, helper);
    format!(
        "{standing}You are {name}, a registered OctiqFlow agent.{role} Your teammate {asker} {doing} and asks you the question below.\n\n\
You are a peer answering a question, not doing the work. The current directory is {asker}'s workspace and you may only read it: do not edit files or run anything that changes state. You have no orchestration tools and cannot ask anyone else. Answer directly and concisely, in under {limit} characters. If what you can read does not settle it, say so and say what would.{paths}\n\n\
{asker}'s question:\n{question}",
        name = helper.name,
        limit = MAX_ANSWER_CHARS,
    )
}

/// The one-shot command line the answer runs as: read tools only, no MCP,
/// no session kept. POSIX-quoted, for `proc::resolve_agent_shell`.
pub fn helper_command(turn: &HelperTurn) -> Result<String, String> {
    use crate::agent_provider::{provider_for, safe_model, sh_quote};
    let model = safe_model(&turn.model).ok_or("The teammate's model is not valid.")?;
    let effort = turn
        .effort
        .as_deref()
        .and_then(|e| provider_for(turn.agent).effort(e));
    match turn.agent {
        ChatAgent::Claude => {
            // The prompt goes first: `--tools` takes every word after it.
            let mut cmd = format!(
                "exec claude -p {} --output-format json --no-session-persistence --model {}",
                sh_quote(&turn.prompt),
                sh_quote(&model)
            );
            if let Some(effort) = effort {
                cmd.push_str(&format!(" --effort {effort}"));
            }
            cmd.push_str(
                " --permission-mode default --strict-mcp-config --disable-slash-commands --setting-sources '' --tools Read,Grep,Glob",
            );
            Ok(cmd)
        }
        ChatAgent::Codex => {
            let mut cmd = format!(
                "exec codex exec --json --ephemeral --ignore-user-config --skip-git-repo-check -s read-only -c approval_policy=never -m {}",
                sh_quote(&model)
            );
            if let Some(effort) = effort {
                cmd.push_str(&format!(" -c model_reasoning_effort={}", sh_quote(effort)));
            }
            cmd.push_str(&format!(
                " -C {} {}",
                sh_quote(&turn.cwd),
                sh_quote(&turn.prompt)
            ));
            Ok(cmd)
        }
        ChatAgent::Antigravity => {
            // Plan mode is Antigravity's read-only one, and no OctiqFlow
            // plugin is added, so it has no MCP server of ours. It keeps no
            // ephemeral mode: the answer is saved as a conversation of its
            // own. A model id names its own effort, so none is passed.
            let prompt = format!(
                "{}\n\nUse only your file reading and search tools: a shell command is refused here and would end your answer.",
                turn.prompt
            );
            Ok(format!(
                "exec agy -p {} --output-format stream-json --mode plan --disable-slash-commands --model {}",
                sh_quote(&prompt),
                sh_quote(&model)
            ))
        }
        ChatAgent::Pi => {
            // JSON mode is one run and exits. Read tools only, none of the
            // person's extensions or OctiqFlow's MCP, and no session kept.
            let reference = crate::agent_provider::pi_model_ref(&model)
                .map(|(upstream, id)| format!("{upstream}/{id}"))
                .ok_or("The teammate's model is not valid.")?;
            let mut cmd = format!(
                "exec pi --mode json --no-session -ne --no-skills --no-prompt-templates --no-context-files --tools read,grep,find,ls --model {}",
                sh_quote(&reference)
            );
            if let Some(effort) = effort {
                cmd.push_str(&format!(" --thinking {effort}"));
            }
            cmd.push_str(&format!(" -- {}", sh_quote(&turn.prompt)));
            Ok(cmd)
        }
    }
}

fn number(value: Option<&Value>) -> u64 {
    value.and_then(Value::as_u64).unwrap_or(0)
}

/// Claude's `--output-format json`: one result object.
pub fn parse_claude(stdout: &str) -> Result<HelperAnswer, String> {
    let result = stdout
        .lines()
        .rev()
        .filter_map(|line| serde_json::from_str::<Value>(line.trim()).ok())
        .find(|v| v.get("type").and_then(Value::as_str) == Some("result"))
        .ok_or("No answer came back.")?;
    let text = result
        .get("result")
        .and_then(Value::as_str)
        .unwrap_or("")
        .trim()
        .to_owned();
    if result.get("is_error").and_then(Value::as_bool) == Some(true) {
        return Err(if text.is_empty() {
            "The answering turn failed.".into()
        } else {
            text
        });
    }
    if text.is_empty() {
        return Err("No answer came back.".into());
    }
    let usage = result.get("usage").map(|u| PeerUsage {
        input_tokens: number(u.get("input_tokens"))
            + number(u.get("cache_read_input_tokens"))
            + number(u.get("cache_creation_input_tokens")),
        output_tokens: number(u.get("output_tokens")),
    });
    Ok(HelperAnswer { text, usage })
}

/// Codex's `exec --json`: the last agent message, and the turn's usage.
pub fn parse_codex(stdout: &str) -> Result<HelperAnswer, String> {
    let mut text = None;
    let mut usage = None;
    let mut failure = None;
    for event in stdout
        .lines()
        .filter_map(|line| serde_json::from_str::<Value>(line.trim()).ok())
    {
        match event.get("type").and_then(Value::as_str) {
            Some("item.completed") => {
                let item = event.get("item");
                if item.and_then(|i| i.get("type")).and_then(Value::as_str) == Some("agent_message")
                {
                    text = item
                        .and_then(|i| i.get("text"))
                        .and_then(Value::as_str)
                        .map(|t| t.trim().to_owned());
                }
            }
            Some("turn.completed") => {
                usage = event.get("usage").map(|u| PeerUsage {
                    input_tokens: number(u.get("input_tokens")),
                    output_tokens: number(u.get("output_tokens")),
                });
            }
            Some("turn.failed") => {
                failure = event
                    .pointer("/error/message")
                    .and_then(Value::as_str)
                    .map(str::to_owned);
            }
            Some("error") => {
                failure = event
                    .get("message")
                    .and_then(Value::as_str)
                    .map(str::to_owned);
            }
            _ => {}
        }
    }
    match text.filter(|t| !t.is_empty()) {
        Some(text) => Ok(HelperAnswer { text, usage }),
        None => Err(failure.unwrap_or_else(|| "No answer came back.".into())),
    }
}

/// Pi's `--mode json`: the last assistant message's words, the usage of every
/// model call of the run, and the error of a call that failed.
pub fn parse_pi(stdout: &str) -> Result<HelperAnswer, String> {
    let mut text = None;
    let mut failure = None;
    let mut input = 0;
    let mut output = 0;
    for event in stdout
        .lines()
        .filter_map(|line| serde_json::from_str::<Value>(line.trim()).ok())
    {
        if event.get("type").and_then(Value::as_str) != Some("message_end")
            || event.pointer("/message/role").and_then(Value::as_str) != Some("assistant")
        {
            continue;
        }
        let message = &event["message"];
        if let Some(usage) = message.get("usage") {
            input += number(usage.get("input")) + number(usage.get("cacheRead"));
            output += number(usage.get("output"));
        }
        if message.get("stopReason").and_then(Value::as_str) == Some("error") {
            failure = message
                .get("errorMessage")
                .and_then(Value::as_str)
                .map(str::to_owned);
            continue;
        }
        let said = message
            .get("content")
            .and_then(Value::as_array)
            .map(|blocks| {
                blocks
                    .iter()
                    .filter(|block| block.get("type").and_then(Value::as_str) == Some("text"))
                    .filter_map(|block| block.get("text").and_then(Value::as_str))
                    .collect::<Vec<_>>()
                    .join("\n")
            })
            .unwrap_or_default();
        if !said.trim().is_empty() {
            text = Some(said.trim().to_owned());
        }
    }
    match text {
        Some(text) => Ok(HelperAnswer {
            text,
            usage: Some(PeerUsage {
                input_tokens: input,
                output_tokens: output,
            }),
        }),
        None => Err(failure.unwrap_or_else(|| "No answer came back.".into())),
    }
}

/// Antigravity's `--output-format stream-json`: the `result` event's
/// response, and the usage of the turn's model calls.
pub fn parse_antigravity(stdout: &str) -> Result<HelperAnswer, String> {
    let mut input = 0;
    let mut output = 0;
    let mut result = None;
    for event in stdout
        .lines()
        .filter_map(|line| serde_json::from_str::<Value>(line.trim()).ok())
    {
        match event.get("event").and_then(Value::as_str) {
            Some("step_update") => {
                if let Some(usage) = event.pointer("/step_update/usage") {
                    input += number(usage.get("input_tokens"));
                    output += number(usage.get("output_tokens"));
                }
            }
            Some("result") => result = event.get("result").cloned(),
            _ => {}
        }
    }
    let result = result.ok_or("No answer came back.")?;
    let failed = matches!(
        result.get("status").and_then(Value::as_str),
        Some("ERROR" | "INVALID")
    );
    if failed {
        return Err(result
            .get("error")
            .and_then(Value::as_str)
            .unwrap_or("The answering turn failed.")
            .to_owned());
    }
    let text = result
        .get("response")
        .and_then(Value::as_str)
        .unwrap_or("")
        .trim();
    if text.is_empty() {
        return Err("No answer came back.".into());
    }
    Ok(HelperAnswer {
        text: text.to_owned(),
        usage: Some(PeerUsage {
            input_tokens: input,
            output_tokens: output,
        }),
    })
}

/// Variables that would tie the answering process to a chat: with none of
/// them its OctiqFlow MCP (were one configured at all) has no chat to act
/// for, and the hook no capability to accept.
const CHAT_VARIABLES: [&str; 7] = [
    "OCTIQ_CHAT_KEY",
    "OCTIQ_CHAT_CAPABILITY",
    "OCTIQ_SESSION_KEY",
    "OCTIQ_HOOK_PORT",
    "OCTIQ_ORCHESTRATION_ATTEMPT",
    "OCTIQ_WEB_TOKEN",
    "OCTIQ_CANVAS_DIR",
];

/// Run the teammate's answer for real: one process, a deadline, no stdin.
pub fn run_helper(turn: &HelperTurn) -> Result<HelperAnswer, String> {
    let line = helper_command(turn)?;
    run_one_shot(
        turn.agent,
        &line,
        &turn.cwd,
        &BTreeMap::new(),
        HELPER_TIMEOUT,
        "The teammate",
    )
}

/// Whether `name` is one of OctiqFlow's own variables, which tie a process
/// to a chat. A one-shot answering process gets none of them.
pub fn is_octiq_variable(name: &str) -> bool {
    name.starts_with("OCTIQ_") || CHAT_VARIABLES.contains(&name)
}

/// The answering process, not yet started: `line` handed to `shell` through
/// `AgentShell::command_on`, never as a raw `-lc` argument (on Windows, Git
/// Bash would parse that again, cutting it near 8186 characters and halving
/// its backslashes), in `cwd` with no stdin, every `OCTIQ_*` variable removed
/// (inherited or in `env`). The one exception is Windows' carrier, which
/// `command_on` has just set to `line`, overriding any inherited copy, and
/// which the shell takes back out before it runs anything. Elsewhere the line
/// is an argument, so the carrier goes like every other `OCTIQ_*` variable.
pub fn one_shot_command(
    shell: &crate::proc::AgentShell,
    line: &str,
    cwd: &str,
    env: &BTreeMap<String, String>,
    is_windows: bool,
) -> Command {
    let mut cmd = shell.command_on(line, is_windows);
    cmd.current_dir(cwd)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    let carrier = |name: &str| is_windows && name == crate::proc::LINE_ENV;
    for (name, _) in std::env::vars_os() {
        if name
            .to_str()
            .is_some_and(|n| is_octiq_variable(n) && !carrier(n))
        {
            cmd.env_remove(name);
        }
    }
    for name in CHAT_VARIABLES {
        cmd.env_remove(name);
    }
    if !is_windows {
        cmd.env_remove(crate::proc::LINE_ENV);
    }
    for (name, value) in env.iter().filter(|(name, _)| !is_octiq_variable(name)) {
        cmd.env(name, value);
    }
    crate::proc::no_console(&mut cmd);
    cmd
}

/// Run one read-only answering process to its end: `line` through the agent
/// shell in `cwd`, no stdin, every `OCTIQ_*` variable removed (inherited or in
/// `env`), and killed at `timeout`. `who` names it in the errors.
pub fn run_one_shot(
    agent: ChatAgent,
    line: &str,
    cwd: &str,
    env: &BTreeMap<String, String>,
    timeout: Duration,
    who: &str,
) -> Result<HelperAnswer, String> {
    let shell = crate::proc::resolve_agent_shell(
        std::env::var("SHELL").ok(),
        std::env::var("LOCALAPPDATA").ok(),
        cfg!(windows),
        &crate::proc::find_executable,
    )?;
    let mut cmd = one_shot_command(&shell, line, cwd, env, cfg!(windows));
    let mut child = cmd
        .spawn()
        .map_err(|e| format!("{who} could not be started: {e}"))?;
    // Read both pipes as they fill, or a long answer blocks the process.
    let drain = |pipe: Option<Box<dyn Read + Send>>| {
        std::thread::spawn(move || {
            let mut out = String::new();
            if let Some(mut pipe) = pipe {
                let _ = pipe.read_to_string(&mut out);
            }
            out
        })
    };
    let stdout = drain(
        child
            .stdout
            .take()
            .map(|p| Box::new(p) as Box<dyn Read + Send>),
    );
    let stderr = drain(
        child
            .stderr
            .take()
            .map(|p| Box::new(p) as Box<dyn Read + Send>),
    );
    let started = Instant::now();
    let status = loop {
        match child.try_wait() {
            Ok(Some(status)) => break status,
            Ok(None) if started.elapsed() > timeout => {
                let _ = child.kill();
                let _ = child.wait();
                let secs = timeout.as_secs_f64().ceil() as u64;
                return Err(if secs >= 60 {
                    format!("{who} did not answer within {} minutes.", secs / 60)
                } else {
                    format!("{who} did not answer within {secs}s.")
                });
            }
            Ok(None) => std::thread::sleep(Duration::from_millis(200)),
            Err(e) => return Err(format!("{who}'s process was lost: {e}")),
        }
    };
    let stdout = stdout.join().unwrap_or_default();
    let stderr = stderr.join().unwrap_or_default();
    let parsed = match agent {
        ChatAgent::Codex => parse_codex(&stdout),
        ChatAgent::Antigravity => parse_antigravity(&stdout),
        ChatAgent::Pi => parse_pi(&stdout),
        _ => parse_claude(&stdout),
    };
    match parsed {
        Ok(answer) => Ok(answer),
        Err(why) if !status.success() => {
            let detail = stderr.lines().rev().find(|l| !l.trim().is_empty());
            Err(match detail {
                Some(detail) => format!("{why} ({})", detail.trim()),
                None => why,
            })
        }
        Err(why) => Err(why),
    }
}

/// An answer cut to `MAX_ANSWER_CHARS`, and whether it was cut.
pub fn clip_answer(text: &str) -> (String, bool) {
    match text.char_indices().nth(MAX_ANSWER_CHARS) {
        Some((at, _)) => (text[..at].to_owned(), true),
        None => (text.to_owned(), false),
    }
}

/// An ask still marked as running when the store loads was cut off by a
/// restart; nothing will ever answer it.
pub(super) fn recover(data: &mut Stored) -> bool {
    let mut changed = false;
    for ask in data.peer_asks.values_mut() {
        if ask.status == PeerAskStatus::Asking {
            ask.status = PeerAskStatus::Failed;
            ask.error = Some("OctiqFlow restarted before the teammate answered.".into());
            changed = true;
        }
    }
    changed
}

/// Who asks, where the teammate reads, and what the ask is recorded under.
struct Asking {
    asker: TaskAssignee,
    project: String,
    cwd: String,
    /// The asker's task, when it is a worker.
    task_title: Option<String>,
    run_id: String,
    task_id: String,
    attempt_id: String,
    chat: Option<String>,
    /// Asks already made against the limit that applies.
    asked: usize,
    limit: usize,
}

/// The run a lead chat coordinates that is still in flight: the newest one,
/// when it has several.
pub(super) fn live_run_of<'a>(data: &'a Stored, chat_key: &str) -> Option<&'a Run> {
    data.runs
        .values()
        .filter(|run| {
            run.coordinator_chat_key == chat_key
                && run.archived_at.is_none()
                && matches!(
                    run.status,
                    RunStatus::Planning | RunStatus::Running | RunStatus::Waiting
                )
        })
        .max_by_key(|run| (run.created_at, run.id.clone()))
}

/// Whether `chat_key` is a worker's chat, read under the store's own lock
/// (`OrchestrationStore::is_worker_chat` takes that lock itself).
pub(super) fn worker_chat(data: &Stored, chat_key: &str) -> bool {
    chat_key.starts_with("chat:orch-")
        || data
            .attempts
            .values()
            .any(|attempt| attempt.worker_chat_key == chat_key)
}

/// The registered lead behind a lead chat's call, as a ledger copy.
pub(super) fn lead_asker(
    data: &Stored,
    actor: &str,
    lead: &LeadCaller,
    agents: &[TeamAgent],
) -> Result<TaskAssignee, String> {
    if worker_chat(data, actor) {
        return Err("This chat is an orchestration worker, not a lead's own chat.".into());
    }
    agents
        .iter()
        .find(|a| a.id == lead.agent_id)
        .map(|a| TaskAssignee {
            id: a.id.clone(),
            name: a.name.clone(),
        })
        .ok_or_else(|| "You are no longer a registered agent, so you have no team to ask.".into())
}

impl OrchestrationStore {
    /// One peer ask from `actor`, answered by `run` as the teammate: from
    /// its running attempt, or, with `lead`, from a registered lead's own
    /// chat. Recorded before the teammate starts and settled after, so the
    /// limit counts asks in flight and the ledger shows every one.
    #[allow(clippy::too_many_arguments)]
    pub fn peer_ask(
        &self,
        actor: &str,
        lead: Option<&LeadCaller>,
        question: PeerQuestion,
        agents: &[TeamAgent],
        teams: &[AgentTeam],
        policy: &str,
        run: impl FnOnce(&HelperTurn) -> Result<HelperAnswer, String>,
    ) -> Result<PeerReply, String> {
        let text = question.question.trim().to_owned();
        if text.is_empty() {
            return Err("Ask your teammate a question.".into());
        }
        if text.chars().count() > MAX_QUESTION_CHARS {
            return Err(format!(
                "Keep the question under {MAX_QUESTION_CHARS} characters; point at files with contextPaths instead of pasting them."
            ));
        }
        let (ask, turn, left) = self.mutate(|data| {
            let now = now_ms();
            let asking = match lead {
                Some(lead) => {
                    let asker = lead_asker(data, actor, lead, agents)?;
                    Asking {
                        asker,
                        project: lead.project_id.clone(),
                        cwd: lead.cwd.clone(),
                        task_title: None,
                        run_id: live_run_of(data, actor)
                            .map(|run| run.id.clone())
                            .unwrap_or_default(),
                        task_id: String::new(),
                        attempt_id: String::new(),
                        chat: Some(actor.to_owned()),
                        asked: data
                            .peer_asks
                            .values()
                            .filter(|a| {
                                a.asker_chat_key.as_deref() == Some(actor)
                                    && a.asked_at > now - LEAD_ASK_WINDOW_MS
                            })
                            .count(),
                        limit: MAX_LEAD_ASKS_PER_HOUR,
                    }
                }
                None => {
                    let attempt = data
                        .attempts
                        .values()
                        .find(|a| a.worker_chat_key == actor && a.status == AttemptStatus::Running)
                        .cloned()
                        .ok_or("Peer help is for a worker on a running task, or a lead in its own agents-mode chat. This chat has no running attempt.")?;
                    let task = data
                        .tasks
                        .get(&attempt.task_id)
                        .cloned()
                        .ok_or("The task no longer exists.")?;
                    if task.active_attempt_id.as_deref() != Some(attempt.id.as_str()) {
                        return Err("This attempt is no longer the task's current one.".to_string());
                    }
                    let run = data
                        .runs
                        .get(&attempt.run_id)
                        .cloned()
                        .ok_or("The run no longer exists.")?;
                    let asker = attempt.assignee.clone().ok_or(
                        "This task was not handed to a registered agent, so it has no team to ask.",
                    )?;
                    Asking {
                        asker,
                        project: task
                            .destination
                            .as_ref()
                            .map(|d| d.project_id.clone())
                            .unwrap_or_else(|| run.workspace_id.clone()),
                        cwd: attempt.cwd.clone(),
                        task_title: Some(task.title.clone()),
                        run_id: run.id.clone(),
                        task_id: task.id.clone(),
                        asked: data
                            .peer_asks
                            .values()
                            .filter(|a| a.attempt_id == attempt.id)
                            .count(),
                        attempt_id: attempt.id,
                        chat: None,
                        limit: MAX_ASKS_PER_ATTEMPT,
                    }
                }
            };
            let helper = choose_helper(
                agents,
                teams,
                &asking.asker.id,
                &question.teammate_id,
                &asking.project,
            )?;
            if asking.asked >= asking.limit {
                return Err(if asking.chat.is_some() {
                    format!(
                        "You have asked your teammates {MAX_LEAD_ASKS_PER_HOUR} times from this chat in the last hour, which is the limit. Carry on with what you have, or ask again later."
                    )
                } else {
                    format!(
                        "You have asked your teammates {MAX_ASKS_PER_ATTEMPT} times on this attempt, which is the limit. Carry on with what you have."
                    )
                });
            }
            let paths = context_paths(&asking.cwd, &question.context_paths)?;
            let ask = PeerAsk {
                id: format!("peer_{}", compact_id()),
                run_id: asking.run_id,
                task_id: asking.task_id,
                attempt_id: asking.attempt_id,
                asker_chat_key: asking.chat,
                asker: asking.asker.clone(),
                helper: TaskAssignee {
                    id: helper.id.clone(),
                    name: helper.name.clone(),
                },
                helper_agent: helper.agent,
                helper_model: helper.model.clone(),
                helper_effort: helper.effort.clone(),
                question: text.clone(),
                context_paths: paths.clone(),
                status: PeerAskStatus::Asking,
                answer: None,
                truncated: false,
                error: None,
                usage: None,
                asked_at: now,
                answered_at: None,
            };
            let turn = HelperTurn {
                agent: helper.agent,
                model: helper.model.clone(),
                effort: helper.effort.clone(),
                cwd: asking.cwd,
                prompt: helper_prompt(
                    policy,
                    helper,
                    &asking.asker.name,
                    asking.task_title.as_deref(),
                    &text,
                    &paths,
                ),
            };
            data.peer_asks.insert(ask.id.clone(), ask.clone());
            Ok((ask, turn, asking.limit.saturating_sub(asking.asked + 1)))
        })?;
        announce(&ask.run_id, "peer_asked");
        let outcome = run(&turn);
        let settled = self.mutate(|data| {
            let record = data
                .peer_asks
                .get_mut(&ask.id)
                .ok_or("The peer ask was lost from the run.")?;
            record.answered_at = Some(now_ms());
            match &outcome {
                Ok(answer) => {
                    let (text, truncated) = clip_answer(&answer.text);
                    record.status = PeerAskStatus::Answered;
                    record.answer = Some(text);
                    record.truncated = truncated;
                    record.usage = answer.usage.clone();
                }
                Err(why) => {
                    record.status = PeerAskStatus::Failed;
                    record.error = Some(why.clone());
                }
            }
            Ok(record.clone())
        });
        announce(&ask.run_id, "peer_answered");
        let settled = settled?;
        match (settled.status, settled.answer) {
            (PeerAskStatus::Answered, Some(answer)) => Ok(PeerReply {
                ask_id: settled.id,
                teammate: settled.helper.name,
                answer,
                truncated: settled.truncated,
                asks_left: left,
            }),
            _ => Err(format!(
                "{} could not answer: {}",
                settled.helper.name,
                settled.error.unwrap_or_else(|| "no answer".into())
            )),
        }
    }
}

#[cfg(test)]
mod tests;
