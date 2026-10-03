//! Peer help: a worker asking a teammate one question while it works.
//!
//! A question and an answer, never a handoff. The asker keeps its task, its
//! workspace and its report; the teammate only reads and advises. The host
//! decides every part of it — who may be asked, how often, and what the
//! answering turn may touch — so none of it rests on an agent's word:
//!
//! - Only the chat of a RUNNING attempt whose task was handed to a registered
//!   agent may ask, and only a registered member of that agent's own team
//!   (`team::teammates`) who may work in the task's project may answer.
//! - The answer runs as the teammate's registered identity (provider, model,
//!   effort) in a one-shot process that has read tools only, no MCP server at
//!   all and none of the chat's `OCTIQ_*` variables. It cannot write, cannot
//!   reach the orchestration hook, and so cannot ask a peer of its own.
//! - Each attempt may ask `MAX_ASKS_PER_ATTEMPT` times; an answer longer than
//!   `MAX_ANSWER_CHARS` is cut there.
//! - Every ask is recorded in the run (`PeerAsk`) before the teammate is
//!   started and settled when it answers, so the task view shows it whatever
//!   the asker does with it.
//!
//! No gate: a peer ask sits inside the task the person already approved, and
//! changes nothing about reports-to, project scope, access or plan approval.
use std::io::Read;
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

use serde_json::Value;

use super::*;
use crate::team::{AgentTeam, TeamAgent};

/// Asks one attempt may make, answered or not.
pub const MAX_ASKS_PER_ATTEMPT: usize = 5;
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
    pub run_id: String,
    pub task_id: String,
    pub attempt_id: String,
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
    helper: &TeamAgent,
    asker: &str,
    task_title: &str,
    question: &str,
    paths: &[String],
) -> String {
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
    format!(
        "You are {name}, a registered OctiqFlow agent.{role} Your teammate {asker} is working on the task \"{task_title}\" and asks you the question below.\n\n\
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
        ChatAgent::Pi => Err("A registered agent runs on Claude or Codex.".into()),
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

impl OrchestrationStore {
    /// One peer ask from `actor`'s running attempt, answered by `run` as the
    /// teammate. Recorded before the teammate starts and settled after, so
    /// the limit counts asks in flight and the run shows every one.
    pub fn peer_ask(
        &self,
        actor: &str,
        question: PeerQuestion,
        agents: &[TeamAgent],
        teams: &[AgentTeam],
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
        let (ask, turn, asked) = self.mutate(|data| {
            let attempt = data
                .attempts
                .values()
                .find(|a| a.worker_chat_key == actor && a.status == AttemptStatus::Running)
                .cloned()
                .ok_or("Peer help is for a worker on a running task. This chat has no running attempt.")?;
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
            let project = task
                .destination
                .as_ref()
                .map(|d| d.project_id.clone())
                .unwrap_or_else(|| run.workspace_id.clone());
            let helper = choose_helper(agents, teams, &asker.id, &question.teammate_id, &project)?;
            let asked = data
                .peer_asks
                .values()
                .filter(|a| a.attempt_id == attempt.id)
                .count();
            if asked >= MAX_ASKS_PER_ATTEMPT {
                return Err(format!(
                    "You have asked your teammates {MAX_ASKS_PER_ATTEMPT} times on this attempt, which is the limit. Carry on with what you have."
                ));
            }
            let paths = context_paths(&attempt.cwd, &question.context_paths)?;
            let now = now_ms();
            let ask = PeerAsk {
                id: format!("peer_{}", compact_id()),
                run_id: run.id.clone(),
                task_id: task.id.clone(),
                attempt_id: attempt.id.clone(),
                asker: asker.clone(),
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
                cwd: attempt.cwd.clone(),
                prompt: helper_prompt(helper, &asker.name, &task.title, &text, &paths),
            };
            data.peer_asks.insert(ask.id.clone(), ask.clone());
            Ok((ask, turn, asked + 1))
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
                asks_left: MAX_ASKS_PER_ATTEMPT.saturating_sub(asked),
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
mod tests {
    use super::*;

    fn agent(id: &str, team: Option<&str>, project: Option<&str>) -> TeamAgent {
        TeamAgent {
            id: id.into(),
            name: id.to_uppercase(),
            role: format!("{id} role"),
            agent: ChatAgent::Claude,
            model: "sonnet".into(),
            effort: Some("high".into()),
            access: Access::Auto,
            project_id: project.map(Into::into),
            reports_to: None,
            memory_note: None,
            avatar: None,
            team_id: team.map(Into::into),
            created_at: 0,
            updated_at: 0,
        }
    }

    fn team(id: &str) -> AgentTeam {
        AgentTeam {
            id: id.into(),
            name: format!("Team {id}"),
            project_id: None,
            created_at: 0,
            updated_at: 0,
        }
    }

    fn roster() -> (Vec<TeamAgent>, Vec<AgentTeam>) {
        (
            vec![
                agent("ada", Some("t1"), None),
                agent("bo", Some("t1"), Some("p1")),
                agent("cy", Some("t2"), None),
                agent("di", Some("t1"), Some("p2")),
                agent("ed", None, None),
                TeamAgent {
                    model: "fable".into(),
                    ..agent("fa", Some("t1"), None)
                },
            ],
            vec![team("t1"), team("t2")],
        )
    }

    #[test]
    fn only_a_registered_teammate_who_may_look_at_the_project_is_asked() {
        let (agents, teams) = roster();
        let pick = |asker: &str, who: &str| {
            choose_helper(&agents, &teams, asker, who, "p1").map(|a| a.id.clone())
        };
        assert_eq!(pick("ada", "bo").unwrap(), "bo");
        // By exact name too, whatever the case.
        assert_eq!(pick("ada", "Bo").unwrap(), "bo");
        // A lead-only model may still answer: answering is not working a task.
        assert_eq!(pick("ada", "fa").unwrap(), "fa");
        assert_eq!(
            pick("ada", "ada").unwrap_err(),
            "You cannot ask yourself. Ask a teammate, or work it out."
        );
        let other_team = pick("ada", "cy").unwrap_err();
        assert!(
            other_team.starts_with("CY is not on your team (Team t1)"),
            "{other_team}"
        );
        assert!(other_team.contains("BO (`bo`)"));
        assert!(pick("ada", "ed")
            .unwrap_err()
            .starts_with("ED is not on your team"));
        assert!(pick("ada", "zed")
            .unwrap_err()
            .starts_with("No registered agent is called zed"));
        assert!(pick("ada", "di")
            .unwrap_err()
            .starts_with("DI works only in another project"));
        assert_eq!(
            pick("ed", "ada").unwrap_err(),
            "You are not on a team, so there is no teammate to ask. Carry on with the task yourself."
        );
        assert!(pick("gone", "ada").is_err());
        assert!(pick("ada", "  ").is_err());
        // A team that was removed is no team.
        assert!(choose_helper(&agents, &teams[1..], "ada", "bo", "p1").is_err());
    }

    #[test]
    fn the_answer_runs_with_read_tools_only_and_no_mcp() {
        let turn = HelperTurn {
            agent: ChatAgent::Claude,
            model: "sonnet".into(),
            effort: Some("high".into()),
            cwd: "/w".into(),
            prompt: "it's a question".into(),
        };
        let claude = helper_command(&turn).unwrap();
        assert!(
            claude.starts_with("exec claude -p 'it'\\''s a question' "),
            "{claude}"
        );
        assert!(claude.contains("--model 'sonnet' --effort high"));
        assert!(claude.contains("--strict-mcp-config"));
        assert!(!claude.contains("--mcp-config"));
        assert!(claude.ends_with("--tools Read,Grep,Glob"));
        assert!(!claude.contains("dangerously") && !claude.contains("bypass"));
        let codex = helper_command(&HelperTurn {
            agent: ChatAgent::Codex,
            model: "gpt-5.6-sol".into(),
            effort: Some("bogus".into()),
            ..turn.clone()
        })
        .unwrap();
        assert!(codex.contains("-s read-only -c approval_policy=never"));
        assert!(
            codex.contains("--ignore-user-config"),
            "no configured MCP servers"
        );
        assert!(
            !codex.contains("model_reasoning_effort"),
            "an unknown effort is dropped"
        );
        assert!(codex.ends_with("-C '/w' 'it'\\''s a question'"));
        assert!(helper_command(&HelperTurn {
            model: "bad model".into(),
            ..turn.clone()
        })
        .is_err());
        assert!(helper_command(&HelperTurn {
            agent: ChatAgent::Pi,
            ..turn
        })
        .is_err());
    }

    #[test]
    fn provider_output_is_read_for_the_answer_and_its_tokens() {
        let claude = parse_claude(
            "{\"type\":\"result\",\"subtype\":\"success\",\"is_error\":false,\"result\":\" Use the lock. \",\"usage\":{\"input_tokens\":10,\"cache_read_input_tokens\":5,\"output_tokens\":7}}\n",
        )
        .unwrap();
        assert_eq!(claude.text, "Use the lock.");
        assert_eq!(
            claude.usage,
            Some(PeerUsage {
                input_tokens: 15,
                output_tokens: 7
            })
        );
        assert_eq!(
            parse_claude("{\"type\":\"result\",\"is_error\":true,\"result\":\"Not logged in\"}")
                .unwrap_err(),
            "Not logged in"
        );
        assert!(parse_claude("garbage").is_err());
        let codex = parse_codex(concat!(
            "{\"type\":\"thread.started\",\"thread_id\":\"t\"}\n",
            "{\"type\":\"item.completed\",\"item\":{\"type\":\"agent_message\",\"text\":\"first\"}}\n",
            "{\"type\":\"item.completed\",\"item\":{\"type\":\"agent_message\",\"text\":\"final\"}}\n",
            "{\"type\":\"turn.completed\",\"usage\":{\"input_tokens\":3,\"output_tokens\":4}}\n",
        ))
        .unwrap();
        assert_eq!(codex.text, "final");
        assert_eq!(codex.usage.unwrap().output_tokens, 4);
        assert_eq!(
            parse_codex("{\"type\":\"turn.failed\",\"error\":{\"message\":\"quota\"}}")
                .unwrap_err(),
            "quota"
        );
    }

    #[test]
    fn a_long_answer_is_cut_on_a_character_boundary() {
        let long = "é".repeat(MAX_ANSWER_CHARS + 3);
        let (cut, truncated) = clip_answer(&long);
        assert!(truncated);
        assert_eq!(cut.chars().count(), MAX_ANSWER_CHARS);
        assert_eq!(clip_answer("short"), ("short".into(), false));
    }

    #[test]
    fn context_paths_stay_inside_the_workspace() {
        let root = crate::test_dir::TestDir::new("peer");
        fs::create_dir_all(root.join("src")).unwrap();
        fs::write(root.join("src/a.rs"), "").unwrap();
        let cwd = root.to_string_lossy().into_owned();
        assert_eq!(
            context_paths(&cwd, &["src/a.rs".into(), " src ".into()]).unwrap(),
            ["src/a.rs", "src"]
        );
        assert!(context_paths(&cwd, &["../".into()])
            .unwrap_err()
            .contains("outside your workspace"));
        assert!(context_paths(&cwd, &["/etc/hosts".into()]).is_err());
        assert!(context_paths(&cwd, &["missing.rs".into()])
            .unwrap_err()
            .contains("does not exist"));
        assert!(context_paths(&cwd, &vec!["src".to_string(); MAX_CONTEXT_PATHS + 1]).is_err());
    }

    fn worker_on_a_team(store: &OrchestrationStore) -> Attempt {
        let run = super::super::tests::run(store);
        let attempt = super::super::tests::running_worker(store, &run);
        store
            .mutate(|data| {
                let a = data.attempts.get_mut(&attempt.id).unwrap();
                a.assignee = Some(TaskAssignee {
                    id: "ada".into(),
                    name: "ADA".into(),
                });
                Ok(a.clone())
            })
            .unwrap()
    }

    fn ask(to: &str, words: &str) -> PeerQuestion {
        PeerQuestion {
            teammate_id: to.into(),
            question: words.into(),
            context_paths: Vec::new(),
        }
    }

    fn answered(text: &str) -> Result<HelperAnswer, String> {
        Ok(HelperAnswer {
            text: text.into(),
            usage: Some(PeerUsage {
                input_tokens: 100,
                output_tokens: 20,
            }),
        })
    }

    fn logged(store: &OrchestrationStore) -> Vec<PeerAsk> {
        store.snapshot(None).unwrap().peer_asks
    }

    #[test]
    fn an_ask_runs_as_the_teammate_and_is_recorded_in_the_run() {
        let store = OrchestrationStore::default();
        let attempt = worker_on_a_team(&store);
        let (mut agents, teams) = roster();
        // The run's own project is "workspace": Bo is moved there.
        agents[1].project_id = Some("workspace".into());
        let mut seen = None;
        let reply = store
            .peer_ask(
                &attempt.worker_chat_key,
                ask("bo", "  Which lock guards the ledger?  "),
                &agents,
                &teams,
                |turn| {
                    seen = Some(turn.clone());
                    answered("The store's inner mutex.")
                },
            )
            .unwrap();
        assert_eq!(reply.teammate, "BO");
        assert_eq!(reply.answer, "The store's inner mutex.");
        assert_eq!(reply.asks_left, MAX_ASKS_PER_ATTEMPT - 1);
        let turn = seen.unwrap();
        assert_eq!(
            (
                turn.agent,
                turn.model.as_str(),
                turn.effort.as_deref(),
                turn.cwd.as_str()
            ),
            (ChatAgent::Claude, "sonnet", Some("high"), "/tmp")
        );
        assert!(turn
            .prompt
            .ends_with("ADA's question:\nWhich lock guards the ledger?"));
        let log = logged(&store);
        assert_eq!(log.len(), 1);
        let record = &log[0];
        assert_eq!(record.status, PeerAskStatus::Answered);
        assert_eq!(
            (record.asker.id.as_str(), record.helper.id.as_str()),
            ("ada", "bo")
        );
        assert_eq!(record.attempt_id, attempt.id);
        assert_eq!(record.task_id, attempt.task_id);
        assert_eq!(record.question, "Which lock guards the ledger?");
        assert_eq!(record.answer.as_deref(), Some("The store's inner mutex."));
        assert_eq!(record.usage.as_ref().unwrap().output_tokens, 20);
        assert!(record.answered_at.unwrap() >= record.asked_at);
        // Nothing else about the task moved: the ask is not a handoff.
        let task = store
            .snapshot(None)
            .unwrap()
            .tasks
            .into_iter()
            .find(|t| t.id == attempt.task_id)
            .unwrap();
        assert_eq!(task.active_attempt_id.as_deref(), Some(attempt.id.as_str()));
        assert_eq!(task.status, TaskStatus::Running);
        assert!(task.handoffs.is_empty());
    }

    #[test]
    fn a_failed_answer_is_recorded_and_every_ask_counts_toward_the_limit() {
        let store = OrchestrationStore::default();
        let attempt = worker_on_a_team(&store);
        let (agents, teams) = roster();
        let err = store
            .peer_ask(
                &attempt.worker_chat_key,
                ask("fa", "Q?"),
                &agents,
                &teams,
                |_| Err("Not logged in".into()),
            )
            .unwrap_err();
        assert_eq!(err, "FA could not answer: Not logged in");
        assert_eq!(logged(&store)[0].status, PeerAskStatus::Failed);
        assert_eq!(logged(&store)[0].error.as_deref(), Some("Not logged in"));
        let long = "x".repeat(MAX_ANSWER_CHARS + 50);
        let reply = store
            .peer_ask(
                &attempt.worker_chat_key,
                ask("fa", "Q?"),
                &agents,
                &teams,
                |_| answered(&long),
            )
            .unwrap();
        assert!(reply.truncated);
        assert_eq!(reply.answer.len(), MAX_ANSWER_CHARS);
        for _ in 2..MAX_ASKS_PER_ATTEMPT {
            store
                .peer_ask(
                    &attempt.worker_chat_key,
                    ask("fa", "Q?"),
                    &agents,
                    &teams,
                    |_| answered("ok"),
                )
                .unwrap();
        }
        let mut called = false;
        let over = store
            .peer_ask(
                &attempt.worker_chat_key,
                ask("fa", "Q?"),
                &agents,
                &teams,
                |_| {
                    called = true;
                    answered("no")
                },
            )
            .unwrap_err();
        assert!(over.contains("which is the limit"), "{over}");
        assert!(!called, "a refused ask never starts the teammate");
        assert_eq!(logged(&store).len(), MAX_ASKS_PER_ATTEMPT);
    }

    #[test]
    fn refused_asks_start_nothing_and_record_nothing() {
        let store = OrchestrationStore::default();
        let attempt = worker_on_a_team(&store);
        let (agents, teams) = roster();
        let refuse = |actor: &str, question: PeerQuestion| {
            let mut called = false;
            let err = store
                .peer_ask(actor, question, &agents, &teams, |_| {
                    called = true;
                    answered("no")
                })
                .unwrap_err();
            assert!(!called);
            err
        };
        let me = attempt.worker_chat_key.as_str();
        assert!(refuse(me, ask("cy", "Q?")).contains("not on your team"));
        assert!(refuse(me, ask("ada", "Q?")).contains("cannot ask yourself"));
        assert!(refuse(me, ask("nobody", "Q?")).contains("No registered agent"));
        assert!(refuse(me, ask("fa", "   ")).contains("Ask your teammate a question"));
        assert!(refuse(me, ask("fa", &"q".repeat(MAX_QUESTION_CHARS + 1))).contains("under"));
        assert!(refuse(
            me,
            PeerQuestion {
                context_paths: vec!["../../etc".into()],
                ..ask("fa", "Q?")
            }
        )
        .contains("outside your workspace"));
        // Only a running worker's own chat may ask: not its coordinator, and
        // not a helper, which has no chat at all.
        assert!(refuse("chat:master", ask("fa", "Q?")).contains("no running attempt"));
        assert!(refuse("chat:someone", ask("fa", "Q?")).contains("no running attempt"));
        assert!(logged(&store).is_empty());
    }

    #[test]
    fn a_task_with_no_registered_agent_has_no_team() {
        let store = OrchestrationStore::default();
        let run = super::super::tests::run(&store);
        let attempt = super::super::tests::running_worker(&store, &run);
        let (agents, teams) = roster();
        let err = store
            .peer_ask(
                &attempt.worker_chat_key,
                ask("bo", "Q?"),
                &agents,
                &teams,
                |_| answered("no"),
            )
            .unwrap_err();
        assert!(err.contains("not handed to a registered agent"), "{err}");
    }

    #[test]
    fn an_ask_cut_off_by_a_restart_is_failed_on_load() {
        let dir = crate::test_dir::TestDir::new("peer-store");
        let path = dir.join("orchestrations.json");
        let store = OrchestrationStore::load(path.clone());
        let attempt = worker_on_a_team(&store);
        let (agents, teams) = roster();
        // Stand in for a restart mid-answer: the record is written as
        // asking, and the answer never comes back.
        let _ = store.peer_ask(
            &attempt.worker_chat_key,
            ask("fa", "Q?"),
            &agents,
            &teams,
            |_| {
                let reloaded = OrchestrationStore::load(path.clone());
                let asks = reloaded.snapshot(None).unwrap().peer_asks;
                assert_eq!(asks[0].status, PeerAskStatus::Failed);
                assert!(asks[0].error.as_deref().unwrap().contains("restarted"));
                answered("late")
            },
        );
    }

    #[cfg(unix)]
    #[test]
    fn a_one_shot_process_gets_no_octiq_variable_from_anywhere() {
        // This suite usually runs inside an OctiqFlow chat, whose own
        // OCTIQ_* variables the child would otherwise inherit.
        let env = BTreeMap::from([
            ("KEPT".to_string(), "yes".to_string()),
            ("OCTIQ_CHAT_KEY".to_string(), "chat:leak".to_string()),
            ("OCTIQ_HOOK_PORT".to_string(), "1".to_string()),
        ]);
        let line = r#"printf '{"type":"result","is_error":false,"result":"octiq=%s kept=%s"}\n' "$(env | grep -c '^OCTIQ_')" "$KEPT""#;
        let answer = run_one_shot(
            ChatAgent::Claude,
            line,
            "/",
            &env,
            Duration::from_secs(30),
            "The stand-in",
        )
        .unwrap();
        assert_eq!(answer.text, "octiq=0 kept=yes");
        assert!(is_octiq_variable("OCTIQ_ANYTHING_NEW"));
        assert!(!is_octiq_variable("PATH"));
    }

    /// A prompt past the 8186 characters Git Bash keeps of one argument,
    /// with Windows paths and the quotes a question carries.
    fn long_windows_prompt() -> String {
        let prompt = "Why does C:\\Users\\me\\repo\\src\\main.rs fail? It's \\\\server\\share, \"quoted\", 中文.\n"
            .repeat(120);
        assert!(prompt.chars().count() > 8186);
        prompt
    }

    /// Every line both callers send, Claude and Codex: peer help's and ask
    /// back's, with the long prompt and a Windows checkout.
    fn every_one_shot_line(prompt: &str) -> Vec<(&'static str, String)> {
        let dir = r"C:\Users\me\repo with space";
        let helper = |agent| {
            helper_command(&HelperTurn {
                agent,
                model: "sonnet".into(),
                effort: None,
                cwd: dir.into(),
                prompt: prompt.into(),
            })
            .unwrap()
        };
        let fork = |agent| {
            crate::handover::back::fork_command(&crate::handover::back::AnswerTurn {
                agent,
                model: None,
                effort: None,
                session_id: "abc-123".into(),
                cwd: r"C:\Users\me\source".into(),
                read_dirs: vec![dir.into()],
                env: BTreeMap::new(),
                prompt: prompt.into(),
            })
            .unwrap()
        };
        vec![
            ("help claude", helper(ChatAgent::Claude)),
            ("help codex", helper(ChatAgent::Codex)),
            ("ask claude", fork(ChatAgent::Claude)),
            ("ask codex", fork(ChatAgent::Codex)),
        ]
    }

    /// The lines that name a folder as an argument: Codex's `-C` for peer
    /// help, Claude's `--add-dir` for ask back. The others run in their cwd.
    fn names_the_checkout(name: &str) -> bool {
        matches!(name, "help codex" | "ask claude")
    }

    #[test]
    fn a_one_shot_line_reaches_git_bash_in_the_environment_never_as_an_argument() {
        let prompt = long_windows_prompt();
        let bash = crate::proc::AgentShell {
            program: r"C:\Program Files\Git\bin\bash.exe".into(),
            args: vec!["-lc".into()],
        };
        let env = BTreeMap::from([
            ("KEPT".to_string(), "yes".to_string()),
            (crate::proc::LINE_ENV.to_string(), "forged".to_string()),
            ("OCTIQ_CHAT_KEY".to_string(), "chat:leak".to_string()),
        ]);
        for (name, line) in every_one_shot_line(&prompt) {
            assert!(line.len() > 8186, "{name}");
            assert_eq!(
                line.contains(r"'C:\Users\me\repo with space'"),
                names_the_checkout(name),
                "{name}"
            );
            let cmd = one_shot_command(&bash, &line, r"C:\Users\me\source", &env, true);
            assert_eq!(cmd.get_program(), r"C:\Program Files\Git\bin\bash.exe");
            let args: Vec<_> = cmd.get_args().map(|a| a.to_str().unwrap()).collect();
            assert_eq!(args.len(), 2, "{name}");
            assert_eq!(args[0], "-lc");
            assert!(
                args[1].len() < 200 && !args[1].contains("claude") && !args[1].contains("codex"),
                "{name}: the argument must not carry the line: {}",
                args[1]
            );
            let envs: BTreeMap<_, _> = cmd
                .get_envs()
                .map(|(k, v)| (k.to_str().unwrap(), v.map(|v| v.to_str().unwrap())))
                .collect();
            assert_eq!(
                envs.get(crate::proc::LINE_ENV),
                Some(&Some(line.as_str())),
                "{name}: the line travels whole, backslashes and all"
            );
            assert_eq!(envs.get("KEPT"), Some(&Some("yes")));
            assert_eq!(envs.get("OCTIQ_CHAT_KEY"), Some(&None), "{name}");
            let set: Vec<_> = envs
                .iter()
                .filter(|(k, v)| k.starts_with("OCTIQ_") && v.is_some())
                .map(|(k, _)| *k)
                .collect();
            assert_eq!(set, [crate::proc::LINE_ENV], "{name}: no other OCTIQ_ set");
            assert_eq!(
                cmd.get_current_dir().and_then(|d| d.to_str()),
                Some(r"C:\Users\me\source")
            );
        }
    }

    #[test]
    fn off_windows_a_one_shot_line_is_the_argument_and_no_octiq_variable_is_set() {
        let prompt = long_windows_prompt();
        let sh = crate::proc::AgentShell {
            program: "/bin/zsh".into(),
            args: vec!["-lc".into()],
        };
        let env = BTreeMap::from([
            ("KEPT".to_string(), "yes".to_string()),
            (crate::proc::LINE_ENV.to_string(), "forged".to_string()),
            ("OCTIQ_CHAT_KEY".to_string(), "chat:leak".to_string()),
        ]);
        for (name, line) in every_one_shot_line(&prompt) {
            let cmd = one_shot_command(&sh, &line, "/", &env, false);
            let args: Vec<_> = cmd.get_args().map(|a| a.to_str().unwrap()).collect();
            assert_eq!(args, ["-lc", line.as_str()], "{name}");
            let envs: BTreeMap<_, _> = cmd
                .get_envs()
                .map(|(k, v)| (k.to_str().unwrap(), v.map(|v| v.to_str().unwrap())))
                .collect();
            assert_eq!(envs.get("KEPT"), Some(&Some("yes")), "{name}");
            let set: Vec<_> = envs
                .iter()
                .filter(|(k, v)| is_octiq_variable(k) && v.is_some())
                .collect();
            assert!(set.is_empty(), "{name}: {set:?}");
            // Removed outright, whatever this process inherited: the carrier
            // and every variable that ties a process to a chat.
            for removed in CHAT_VARIABLES.iter().chain([&crate::proc::LINE_ENV]) {
                assert_eq!(envs.get(removed), Some(&None), "{name}: {removed}");
            }
        }
    }

    /// Set by `an_inherited_octiq_variable_never_reaches_a_one_shot_process`
    /// on the copy of this test binary it starts.
    const INHERITING_RUN: &str = "PEER_TEST_INHERITED_OCTIQ";

    /// The suite's own environment decides nothing here: this test starts
    /// a copy of itself with a forged launch line and chat key really in its
    /// environment, and that copy runs the one-shot checks. No other test's
    /// environment is touched.
    #[cfg(unix)]
    #[test]
    fn an_inherited_octiq_variable_never_reaches_a_one_shot_process() {
        if std::env::var_os(INHERITING_RUN).is_some() {
            assert_eq!(
                std::env::var(crate::proc::LINE_ENV).as_deref(),
                Ok("inherited-forged")
            );
            // Off Windows: the agent sees no OCTIQ_ variable at all.
            a_one_shot_process_gets_no_octiq_variable_from_anywhere();
            // On Windows' delivery: the shell runs OUR line, not the forged
            // one, and the agent again sees no OCTIQ_ variable.
            the_windows_delivery_hands_every_one_shot_line_over_whole();
            return;
        }
        let name = "orchestration::peer::tests::an_inherited_octiq_variable_never_reaches_a_one_shot_process";
        let out = Command::new(std::env::current_exe().unwrap())
            .args([name, "--exact", "--nocapture", "--test-threads=1"])
            .env(INHERITING_RUN, "1")
            .env(crate::proc::LINE_ENV, "inherited-forged")
            .env("OCTIQ_CHAT_CAPABILITY", "inherited-forged")
            .stdin(Stdio::null())
            .output()
            .unwrap();
        let printed = format!(
            "{}{}",
            String::from_utf8_lossy(&out.stdout),
            String::from_utf8_lossy(&out.stderr)
        );
        assert!(out.status.success(), "{printed}");
        assert!(printed.contains("1 passed"), "the copy ran it: {printed}");
    }

    /// The Windows delivery, run by this machine's own agent shell (Git Bash
    /// on Windows, where it matters; the same one-liner runs in zsh): the
    /// stand-in for the agent writes back every argument it got, and what
    /// OCTIQ_ variables it saw.
    #[test]
    fn the_windows_delivery_hands_every_one_shot_line_over_whole() {
        // Forward slashes, which Git Bash reads as readily as `\`.
        let posix = |p: &Path| p.display().to_string().replace('\\', "/");
        let dir = crate::test_dir::TestDir::new("oneshot");
        let stub = dir.join("agent");
        fs::write(
            &stub,
            "#!/bin/sh\nfor a in \"$@\"; do printf '%s\\0' \"$a\"; done > \"$OUT\"\nenv | grep -c '^OCTIQ_' > \"$OUT.env\"\nexit 0\n",
        )
        .unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            fs::set_permissions(&stub, fs::Permissions::from_mode(0o755)).unwrap();
        }
        let shell = crate::proc::resolve_agent_shell(
            std::env::var("SHELL").ok(),
            std::env::var("LOCALAPPDATA").ok(),
            cfg!(windows),
            &crate::proc::find_executable,
        )
        .unwrap();
        let prompt = long_windows_prompt();
        let stub = crate::agent_provider::sh_quote(&posix(&stub));
        for (name, line) in every_one_shot_line(&prompt) {
            let out = dir.join(name.replace(' ', "-"));
            // The same quoting, with the stand-in in the agent's place.
            let line = line
                .replacen("exec claude ", &format!("exec {stub} "), 1)
                .replacen("exec codex ", &format!("exec {stub} "), 1);
            let env = BTreeMap::from([("OUT".to_string(), posix(&out))]);
            let status = one_shot_command(&shell, &line, "/", &env, true)
                .status()
                .unwrap();
            assert!(status.success(), "{name}");
            let got = fs::read(&out).unwrap();
            let args: Vec<String> = got
                .split(|b| *b == 0)
                .filter(|a| !a.is_empty())
                .map(|a| String::from_utf8(a.to_vec()).unwrap())
                .collect();
            assert!(args.contains(&prompt), "{name}: the prompt arrived whole");
            if names_the_checkout(name) {
                assert!(
                    args.iter().any(|a| a == r"C:\Users\me\repo with space"),
                    "{name}: {:?}",
                    &args.iter().filter(|a| a.len() < 200).collect::<Vec<_>>()
                );
            }
            let leaked = fs::read_to_string(format!("{}.env", out.display())).unwrap();
            assert_eq!(
                leaked.trim(),
                "0",
                "{name}: no OCTIQ_ variable, the line's included"
            );
        }
    }

    #[cfg(unix)]
    #[test]
    fn a_one_shot_process_that_overruns_is_ended() {
        let error = run_one_shot(
            ChatAgent::Claude,
            "exec sleep 30",
            "/",
            &BTreeMap::new(),
            Duration::from_millis(300),
            "The stand-in",
        )
        .unwrap_err();
        assert_eq!(error, "The stand-in did not answer within 1s.");
    }

    #[test]
    fn the_prompt_quotes_the_question_under_the_hosts_rules() {
        let (agents, _) = roster();
        let prompt = helper_prompt(
            &agents[1],
            "ADA",
            "Fix login",
            "Why does it 401?",
            &["src/a.rs".into()],
        );
        assert!(prompt.starts_with("You are BO, a registered OctiqFlow agent. Your role: bo role."));
        assert!(prompt.contains("working on the task \"Fix login\""));
        assert!(prompt.contains("not doing the work"));
        assert!(prompt.contains("cannot ask anyone else"));
        assert!(prompt.contains("- src/a.rs"));
        assert!(prompt.ends_with("ADA's question:\nWhy does it 401?"));
    }
}
