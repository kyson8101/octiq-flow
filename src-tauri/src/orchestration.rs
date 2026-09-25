//! Durable, host-owned coordination for a master agent and its workers.
//!
//! Chats execute work; this module owns the work's truth. A transcript can say
//! that a task finished, but only the active attempt may move that task to a
//! terminal state here. That distinction is what makes retries safe: a late
//! worker from attempt one cannot overwrite the result of attempt two.
//!
//! The store is deliberately small JSON rather than a database. Runs contain
//! metadata and bounded summaries, never transcripts or command output. Every
//! mutation writes a complete replacement through a sibling temporary file,
//! matching the other profile stores in this backend.

use std::collections::{BTreeMap, BTreeSet};
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::{SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use serde_json::json;
use uuid::Uuid;

use crate::agent_chat::{Access, ChatAgent, ChatManager};
use crate::workspaces::{Workspace, WorkspaceState};

pub mod agent_view;
mod archive;
pub mod automation;
pub mod destination;
pub mod execution;
pub mod inbox;
pub mod lifecycle;
mod retention;
mod workspaces;
use crate::git_ops::workflow::WorkspaceMode;
pub use destination::TaskDestination;
use workspaces::TaskWorkspace;

const STORE_VERSION: u32 = 4;
const DEFAULT_MAX_CONCURRENT: u16 = 4;
const MAX_CONCURRENT: u16 = 32;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum RunStatus {
    Planning,
    Running,
    Waiting,
    Completed,
    Failed,
    Stopped,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum TaskStatus {
    Pending,
    Ready,
    Running,
    Blocked,
    Completed,
    Failed,
    Cancelled,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum AttemptStatus {
    Preparing,
    Running,
    Blocked,
    Completed,
    Failed,
    Cancelled,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum GateStatus {
    Open,
    Resolved,
    Cancelled,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum WorkerOutcome {
    Completed,
    Failed,
    Blocked,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Run {
    pub id: String,
    pub objective: String,
    pub coordinator_chat_key: String,
    pub workspace_id: String,
    pub root_path: String,
    pub status: RunStatus,
    pub max_concurrent: u16,
    #[serde(default)]
    pub workspace_mode: WorkspaceMode,
    #[serde(default)]
    pub worker_defaults: Option<automation::WorkerDefaults>,
    /// Agents mode: the lead's plan waits for the person before any worker
    /// starts. Absent on every other run.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub plan_approval: Option<PlanApproval>,
    pub created_at: i64,
    pub updated_at: i64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub stopped_reason: Option<String>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum PlanStatus {
    Pending,
    Approved,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PlanApproval {
    pub status: PlanStatus,
    pub requested_at: i64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub decided_at: Option<i64>,
}

impl Run {
    /// No worker may start while this is true.
    pub fn awaiting_plan_approval(&self) -> bool {
        self.plan_approval
            .as_ref()
            .is_some_and(|plan| plan.status == PlanStatus::Pending)
    }
}

/// Who a task was handed to in agents mode. A copy, not a reference: the
/// registered agent can be renamed or removed while the ledger keeps its word.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TaskAssignee {
    pub id: String,
    pub name: String,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Task {
    pub id: String,
    pub run_id: String,
    pub title: String,
    pub spec: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub worker: Option<automation::WorkerSettings>,
    /// Agents mode: the registered agent this task was handed to (team.rs).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub assignee: Option<TaskAssignee>,
    /// Where the task runs: a registered project and repository
    /// (`destination.rs`). Absent means the run's own root, which is what
    /// every task created before destinations existed has.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub destination: Option<TaskDestination>,
    /// Agents mode: when the person approved this task as part of the plan.
    /// A coordinator task added after approval has none until they approve
    /// again, so new or re-routed work never rides an earlier approval.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub approved_at: Option<i64>,
    /// The task in the plan's standard shape: one line of problem, one line
    /// of goal, and a few checkable acceptance criteria. Given by the lead
    /// when it creates the task and fixed from then on, like the destination.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub card: Option<TaskCard>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub workspace: Option<TaskWorkspace>,
    #[serde(default)]
    pub depends_on: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub parent_task_id: Option<String>,
    pub status: TaskStatus,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub active_attempt_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub result: Option<String>,
    pub created_at: i64,
    pub updated_at: i64,
}

/// A task as a plan shows it: why, what, and how it is judged done.
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TaskCard {
    #[serde(default)]
    pub problem: String,
    #[serde(default)]
    pub goal: String,
    #[serde(default)]
    pub acceptance: Vec<String>,
}

impl TaskCard {
    /// Bounded, one line each, at most five criteria. `None` when nothing was
    /// given, so a task created without a card is exactly what it always was.
    pub fn checked(
        problem: Option<String>,
        goal: Option<String>,
        acceptance: Option<Vec<String>>,
    ) -> Result<Option<Self>, String> {
        fn line(text: &str) -> String {
            text.split_whitespace().collect::<Vec<_>>().join(" ")
        }
        let problem = line(problem.as_deref().unwrap_or_default());
        let goal = line(goal.as_deref().unwrap_or_default());
        let acceptance: Vec<String> = acceptance
            .unwrap_or_default()
            .iter()
            .map(|item| line(item))
            .filter(|item| !item.is_empty())
            .collect();
        if problem.chars().count() > 300 || goal.chars().count() > 300 {
            return Err(
                "Keep the problem and the goal to one short sentence each (300 characters).".into(),
            );
        }
        if acceptance.len() > 5 {
            return Err("Give at most five acceptance criteria.".into());
        }
        if acceptance.iter().any(|item| item.chars().count() > 240) {
            return Err(
                "Keep each acceptance criterion to one checkable line (240 characters).".into(),
            );
        }
        if problem.is_empty() && goal.is_empty() && acceptance.is_empty() {
            return Ok(None);
        }
        Ok(Some(Self {
            problem,
            goal,
            acceptance,
        }))
    }
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Attempt {
    pub id: String,
    pub run_id: String,
    pub task_id: String,
    pub number: u32,
    pub worker_chat_key: String,
    pub agent: ChatAgent,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub model: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub effort: Option<String>,
    pub access: Access,
    pub status: AttemptStatus,
    #[serde(default)]
    pub execution: execution::Execution,
    #[serde(default)]
    pub cwd: String,
    #[serde(default)]
    pub branch: String,
    #[serde(default)]
    pub is_worktree: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub summary: Option<String>,
    #[serde(default)]
    pub files_modified: Vec<String>,
    /// Settlement time is immutable; later archival or delivery metadata is not runtime.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub finished_at: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub archived_at: Option<i64>,
    pub created_at: i64,
    pub updated_at: i64,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Gate {
    pub id: String,
    pub run_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub task_id: Option<String>,
    pub created_by_chat_key: String,
    pub target_chat_key: String,
    pub question: String,
    #[serde(default)]
    pub options: Vec<String>,
    pub status: GateStatus,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub resolution: Option<String>,
    pub created_at: i64,
    pub updated_at: i64,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OrchestrationMessage {
    pub id: String,
    pub run_id: String,
    pub from_chat_key: String,
    pub to_chat_key: String,
    pub kind: String,
    pub subject: String,
    pub body: String,
    pub created_at: i64,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Snapshot {
    pub runs: Vec<Run>,
    pub tasks: Vec<Task>,
    pub attempts: Vec<Attempt>,
    pub gates: Vec<Gate>,
    pub messages: Vec<OrchestrationMessage>,
    pub notifications: Vec<inbox::Notification>,
    pub reports: BTreeMap<String, crate::chat_task::TaskReport>,
    pub native_decisions: Vec<lifecycle::NativeDecision>,
    pub services: Vec<lifecycle::Service>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
struct Stored {
    #[serde(default = "store_version")]
    version: u32,
    #[serde(default)]
    runs: BTreeMap<String, Run>,
    #[serde(default)]
    tasks: BTreeMap<String, Task>,
    #[serde(default)]
    attempts: BTreeMap<String, Attempt>,
    #[serde(default)]
    gates: BTreeMap<String, Gate>,
    #[serde(default)]
    messages: BTreeMap<String, OrchestrationMessage>,
    #[serde(default)]
    notifications: BTreeMap<String, inbox::Notification>,
    #[serde(default)]
    resume_contexts: BTreeMap<String, crate::agent_chat::StartContext>,
    #[serde(default)]
    native_decisions: BTreeMap<String, lifecycle::NativeDecision>,
    #[serde(default)]
    services: BTreeMap<String, lifecycle::Service>,
}

fn store_version() -> u32 {
    STORE_VERSION
}

impl Default for Stored {
    fn default() -> Self {
        Self {
            version: STORE_VERSION,
            runs: BTreeMap::new(),
            tasks: BTreeMap::new(),
            attempts: BTreeMap::new(),
            gates: BTreeMap::new(),
            messages: BTreeMap::new(),
            notifications: BTreeMap::new(),
            resume_contexts: BTreeMap::new(),
            native_decisions: BTreeMap::new(),
            services: BTreeMap::new(),
        }
    }
}

#[derive(Default)]
struct Inner {
    data: Stored,
    load_error: Option<String>,
}

pub struct OrchestrationStore {
    path: Option<PathBuf>,
    inner: Mutex<Inner>,
    workspace_ops: Mutex<()>,
}

#[derive(Clone, Debug)]
pub struct WorkerLaunch {
    pub task_id: String,
    pub agent: ChatAgent,
    pub model: Option<String>,
    pub effort: Option<String>,
    pub access: Access,
    pub new_worktree: Option<bool>,
    pub base_branch: String,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkerReport {
    pub attempt_id: String,
    pub outcome: WorkerOutcome,
    pub summary: String,
    #[serde(default)]
    pub files_modified: Vec<String>,
}

impl Default for OrchestrationStore {
    fn default() -> Self {
        Self {
            path: None,
            inner: Mutex::new(Inner::default()),
            workspace_ops: Mutex::new(()),
        }
    }
}

impl OrchestrationStore {
    pub fn load(path: PathBuf) -> Self {
        let mut inner = Inner::default();
        let mut recovered = false;
        match fs::read(&path) {
            Ok(bytes) => match serde_json::from_slice::<Stored>(&bytes) {
                Ok(mut data) if (1..=STORE_VERSION).contains(&data.version) => {
                    recovered = data.version != STORE_VERSION;
                    data.version = STORE_VERSION;
                    recovered |= recover_interrupted_workers(&mut data);
                    recovered |= workspaces::recover_workspaces(&mut data);
                    recovered |= lifecycle::recover(&mut data);
                    recovered |= retention::prune_finished_runs(&mut data);
                    inner.data = data;
                }
                Ok(data) => {
                    inner.load_error = Some(format!(
                        "Saved orchestrations use unsupported version {}.",
                        data.version
                    ))
                }
                Err(error) => {
                    inner.load_error =
                        Some(format!("Saved orchestrations could not be read: {error}"))
                }
            },
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => {
                inner.load_error = Some(format!("Saved orchestrations could not be read: {error}"))
            }
        }
        let store = Self {
            path: Some(path),
            inner: Mutex::new(inner),
            workspace_ops: Mutex::new(()),
        };
        if recovered {
            let result = store
                .inner
                .lock()
                .map_err(|error| error.to_string())
                .and_then(|inner| store.persist(&inner.data));
            if let Err(error) = result {
                if let Ok(mut inner) = store.inner.lock() {
                    inner.load_error = Some(format!(
                        "Interrupted workers were recovered in memory, but the orchestration store could not be updated: {error}"
                    ));
                }
            }
        }
        store
    }

    pub fn load_profile() -> Self {
        Self::load(crate::profile::profile_dir().join("orchestrations.json"))
    }

    fn persist(&self, data: &Stored) -> Result<(), String> {
        let Some(path) = &self.path else {
            return Ok(());
        };
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent).map_err(|error| error.to_string())?;
        }
        let bytes = serde_json::to_vec_pretty(data).map_err(|error| error.to_string())?;
        let temp = sibling_temp(path);
        fs::write(&temp, bytes).map_err(|error| error.to_string())?;
        fs::rename(&temp, path).map_err(|error| error.to_string())
    }

    fn mutate<T>(
        &self,
        change: impl FnOnce(&mut Stored) -> Result<T, String>,
    ) -> Result<T, String> {
        let mut inner = self.inner.lock().map_err(|error| error.to_string())?;
        if let Some(error) = &inner.load_error {
            return Err(error.clone());
        }
        let mut next = inner.data.clone();
        let result = change(&mut next)?;
        self.persist(&next)?;
        inner.data = next;
        Ok(result)
    }

    pub fn snapshot(&self, run_id: Option<&str>) -> Result<Snapshot, String> {
        self.capture_native_decisions()?;
        let inner = self.inner.lock().map_err(|error| error.to_string())?;
        if let Some(error) = &inner.load_error {
            return Err(error.clone());
        }
        let mut runs: Vec<_> = inner
            .data
            .runs
            .values()
            .filter(|run| run_id.is_none_or(|id| run.id == id))
            .cloned()
            .collect();
        runs.sort_by_key(|run| std::cmp::Reverse(run.updated_at));
        let visible: BTreeSet<_> = runs.iter().map(|run| run.id.clone()).collect();

        let mut tasks: Vec<_> = inner
            .data
            .tasks
            .values()
            .filter(|task| visible.contains(task.run_id.as_str()))
            .cloned()
            .collect();
        tasks.sort_by_key(|task| (task.created_at, task.id.clone()));
        let mut attempts: Vec<_> = inner
            .data
            .attempts
            .values()
            .filter(|attempt| visible.contains(attempt.run_id.as_str()))
            .cloned()
            .collect();
        attempts.sort_by_key(|attempt| (attempt.created_at, attempt.id.clone()));
        let mut gates: Vec<_> = inner
            .data
            .gates
            .values()
            .filter(|gate| visible.contains(gate.run_id.as_str()))
            .cloned()
            .collect();
        gates.sort_by_key(|gate| (gate.created_at, gate.id.clone()));
        let mut messages: Vec<_> = inner
            .data
            .messages
            .values()
            .filter(|message| visible.contains(message.run_id.as_str()))
            .cloned()
            .collect();
        messages.sort_by_key(|message| (message.created_at, message.id.clone()));
        let mut snapshot = Snapshot {
            runs,
            tasks,
            attempts,
            gates,
            messages,
            notifications: inner
                .data
                .notifications
                .values()
                .filter(|n| visible.contains(n.run_id.as_str()))
                .cloned()
                .collect(),
            reports: BTreeMap::new(),
            native_decisions: inner
                .data
                .native_decisions
                .values()
                .filter(|d| visible.contains(d.run_id.as_str()))
                .cloned()
                .collect(),
            services: inner
                .data
                .services
                .values()
                .filter(|s| visible.contains(s.run_id.as_str()))
                .cloned()
                .collect(),
        };
        drop(inner);
        lifecycle::refresh_decision_views(&mut snapshot);
        snapshot.reports = crate::chat_task::reports_for_chat_keys(
            snapshot
                .attempts
                .iter()
                .map(|attempt| attempt.worker_chat_key.as_str()),
        );
        Ok(snapshot)
    }

    /// Worker ownership outlives an attempt. A completed, stopped, or deleted
    /// master's worker must never become an ordinary writable chat on reload.
    pub fn worker_coordinator(&self, chat_key: &str) -> Result<Option<String>, String> {
        let inner = self.inner.lock().map_err(|error| error.to_string())?;
        if let Some(error) = &inner.load_error {
            return Err(error.clone());
        }
        Ok(inner
            .data
            .attempts
            .values()
            .find(|attempt| attempt.worker_chat_key == chat_key)
            .map(|attempt| {
                inner
                    .data
                    .runs
                    .get(&attempt.run_id)
                    .map(|run| run.coordinator_chat_key.clone())
                    .unwrap_or_default()
            }))
    }

    pub fn require_user_chat(&self, chat_key: &str) -> Result<(), String> {
        if chat_key.starts_with("chat:orch-") || self.worker_coordinator(chat_key)?.is_some() {
            return Err(
                "This agent chat is read-only. Send instructions and requests in its main chat."
                    .into(),
            );
        }
        Ok(())
    }

    /// Native and legacy question tools use the same coordinator gate as the
    /// orchestration tool, so they cannot create a second user-input channel.
    pub fn route_worker_questions(
        &self,
        chat_key: &str,
        questions: &[crate::question::Question],
    ) -> Result<Option<Gate>, String> {
        if self.worker_coordinator(chat_key)?.is_none() {
            return Ok(None);
        }
        let task = {
            let inner = self.inner.lock().map_err(|error| error.to_string())?;
            active_task_for_actor(&inner.data, chat_key)
                .ok_or("This worker attempt has settled. Continue in the main chat.")?
        };
        let question = questions
            .iter()
            .enumerate()
            .map(|(index, question)| {
                let options = question
                    .options
                    .iter()
                    .map(|choice| match &choice.description {
                        Some(description) => format!("- {}: {}", choice.label, description),
                        None => format!("- {}", choice.label),
                    })
                    .collect::<Vec<_>>()
                    .join("\n");
                format!(
                    "{}. {}{}",
                    index + 1,
                    question.question,
                    if options.is_empty() {
                        String::new()
                    } else {
                        format!("\n{options}")
                    }
                )
            })
            .collect::<Vec<_>>()
            .join("\n\n");
        let options = if questions.len() == 1 && !questions[0].multiple {
            questions[0]
                .options
                .iter()
                .map(|choice| choice.label.clone())
                .collect()
        } else {
            Vec::new()
        };
        self.create_gate(chat_key, task.run_id, Some(task.id), question, options)
            .map(Some)
    }

    pub(crate) fn guard_master_start(
        &self,
        actor: &str,
        id: &str,
    ) -> Result<(std::sync::MutexGuard<'_, ()>, Run), String> {
        let guard = self.workspace_ops.lock().map_err(|e| e.to_string())?;
        let run = self.resumable_run(actor, id)?;
        Ok((guard, run))
    }

    /// Browser launch/recovery checks the durable owner and run state before
    /// touching a provider. The caller holds workspace_ops through launch.
    pub(crate) fn resumable_run(&self, actor: &str, id: &str) -> Result<Run, String> {
        let inner = self.inner.lock().map_err(|e| e.to_string())?;
        if let Some(error) = &inner.load_error {
            return Err(error.clone());
        }
        let run = coordinator(&inner.data, id, actor)?;
        if !matches!(
            run.status,
            RunStatus::Planning | RunStatus::Running | RunStatus::Waiting
        ) {
            return Err("This run has settled. Start a new run in this chat.".into());
        }
        Ok(run.clone())
    }

    #[cfg(test)]
    pub fn create_run(
        &self,
        actor_chat_key: String,
        objective: String,
        workspace_id: String,
        root_path: String,
        max_concurrent: Option<u16>,
    ) -> Result<Run, String> {
        self.create_run_with_mode(
            actor_chat_key,
            objective,
            workspace_id,
            root_path,
            max_concurrent,
            WorkspaceMode::Auto,
        )
    }

    pub fn create_run_with_mode(
        &self,
        actor_chat_key: String,
        objective: String,
        workspace_id: String,
        root_path: String,
        max_concurrent: Option<u16>,
        workspace_mode: WorkspaceMode,
    ) -> Result<Run, String> {
        validate_chat_key(&actor_chat_key)?;
        let objective = required_text("objective", objective, 40_000)?;
        let workspace_id = required_text("workspace", workspace_id, 256)?;
        let root_path = required_text("workspace path", root_path, 8_192)?;
        let max_concurrent = max_concurrent
            .unwrap_or(DEFAULT_MAX_CONCURRENT)
            .clamp(1, MAX_CONCURRENT);
        let max_concurrent = if workspace_mode == WorkspaceMode::Direct {
            1
        } else {
            max_concurrent
        };
        let now = now_ms();
        let run = Run {
            id: format!("run_{}", compact_id()),
            objective,
            coordinator_chat_key: actor_chat_key,
            workspace_id,
            root_path,
            status: RunStatus::Planning,
            max_concurrent,
            workspace_mode,
            worker_defaults: None,
            plan_approval: None,
            created_at: now,
            updated_at: now,
            stopped_reason: None,
        };
        let created = run.clone();
        self.mutate(|data| {
            if run.coordinator_chat_key.starts_with("chat:orch-")
                || data
                    .attempts
                    .values()
                    .any(|attempt| attempt.worker_chat_key == run.coordinator_chat_key)
            {
                return Err(
                    "A worker cannot become a coordinator. Continue in the main chat.".into(),
                );
            }
            data.runs.insert(run.id.clone(), run);
            Ok(created)
        })
        .inspect(|run| announce(&run.id, "run_created"))
    }

    #[cfg(test)]
    pub fn create_task(
        &self,
        actor_chat_key: &str,
        run_id: String,
        title: String,
        spec: String,
        depends_on: Vec<String>,
        parent_task_id: Option<String>,
        worker: Option<automation::WorkerSettings>,
    ) -> Result<Task, String> {
        self.create_task_for(
            actor_chat_key,
            run_id,
            title,
            spec,
            depends_on,
            parent_task_id,
            worker,
            None,
            None,
        )
    }

    /// The run's project and coordinator, for resolving an agents-mode
    /// assignee against the agents that project can see.
    pub fn run_owner(&self, run_id: &str) -> Result<(String, String), String> {
        let inner = self.inner.lock().map_err(|error| error.to_string())?;
        inner
            .data
            .runs
            .get(run_id)
            .map(|run| (run.workspace_id.clone(), run.coordinator_chat_key.clone()))
            .ok_or_else(|| "That run does not exist.".into())
    }

    /// A task's assignee and destination, for routing a subtask.
    pub fn task_route(
        &self,
        task_id: &str,
    ) -> Result<(Option<TaskAssignee>, Option<TaskDestination>), String> {
        let inner = self.inner.lock().map_err(|error| error.to_string())?;
        inner
            .data
            .tasks
            .get(task_id)
            .map(|task| (task.assignee.clone(), task.destination.clone()))
            .ok_or_else(|| "The parent task does not exist.".into())
    }

    /// Agents mode: the task a worker chat is running now, for routing its
    /// own split and listing where it may send work.
    pub fn active_task(&self, chat_key: &str) -> Result<Option<Task>, String> {
        let inner = self.inner.lock().map_err(|error| error.to_string())?;
        Ok(active_task_for_actor(&inner.data, chat_key))
    }

    /// Agents mode: the registered agent a worker chat is running as, from the
    /// task of its most recent attempt.
    pub fn assignee_for_worker(&self, chat_key: &str) -> Result<Option<String>, String> {
        let inner = self.inner.lock().map_err(|error| error.to_string())?;
        Ok(inner
            .data
            .attempts
            .values()
            .filter(|attempt| attempt.worker_chat_key == chat_key)
            .max_by_key(|attempt| attempt.created_at)
            .and_then(|attempt| inner.data.tasks.get(&attempt.task_id))
            .and_then(|task| task.assignee.as_ref())
            .map(|assignee| assignee.id.clone()))
    }

    /// Agents mode: hold this run's workers until the person approves.
    pub fn require_plan_approval(&self, run_id: &str) -> Result<Run, String> {
        self.mutate(|data| {
            let run = data.runs.get_mut(run_id).ok_or("The run does not exist.")?;
            run.plan_approval = Some(PlanApproval {
                status: PlanStatus::Pending,
                requested_at: now_ms(),
                decided_at: None,
            });
            Ok(run.clone())
        })
        .inspect(|run| announce(&run.id, "plan_pending"))
    }

    /// The person approves the lead's plan; the scheduler starts the ready
    /// wave on its next pass.
    ///
    /// `seen` is the plan the person was looking at: the ids of the tasks
    /// awaiting approval. When the lead added a task in the meantime, the
    /// approval is refused rather than stretched over work nobody reviewed.
    pub fn approve_plan(
        &self,
        actor_chat_key: &str,
        run_id: &str,
        seen: Option<&[String]>,
    ) -> Result<Run, String> {
        self.mutate(|data| {
            coordinator(data, run_id, actor_chat_key)?;
            let run = data.runs.get_mut(run_id).ok_or("The run does not exist.")?;
            if matches!(
                run.status,
                RunStatus::Stopped | RunStatus::Completed | RunStatus::Failed
            ) {
                return Err("This run has ended.".into());
            }
            let plan = run
                .plan_approval
                .as_mut()
                .ok_or("This run has no plan waiting for approval.")?;
            if plan.status == PlanStatus::Approved {
                return Err("This plan is already approved.".into());
            }
            if !data.tasks.values().any(|task| task.run_id == run_id) {
                return Err("The plan has no tasks yet.".into());
            }
            let waiting: BTreeSet<&str> = data
                .tasks
                .values()
                .filter(|task| task.run_id == run_id && task.approved_at.is_none())
                .filter(|task| task.parent_task_id.is_none())
                .map(|task| task.id.as_str())
                .collect();
            if let Some(seen) = seen {
                let seen: BTreeSet<&str> = seen.iter().map(String::as_str).collect();
                if seen != waiting {
                    return Err("The plan changed while you were reviewing it. Look it over again, then approve.".into());
                }
            }
            let now = now_ms();
            plan.status = PlanStatus::Approved;
            plan.decided_at = Some(now);
            run.updated_at = now;
            let approved = run.clone();
            for task in data.tasks.values_mut() {
                if task.run_id == run_id && task.approved_at.is_none() {
                    task.approved_at = Some(now);
                }
            }
            Ok(approved)
        })
        .inspect(|run| announce(&run.id, "plan_approved"))
    }

    #[cfg(test)]
    #[allow(clippy::too_many_arguments)]
    pub fn create_task_for(
        &self,
        actor_chat_key: &str,
        run_id: String,
        title: String,
        spec: String,
        depends_on: Vec<String>,
        parent_task_id: Option<String>,
        worker: Option<automation::WorkerSettings>,
        assignee: Option<TaskAssignee>,
        destination: Option<TaskDestination>,
    ) -> Result<Task, String> {
        self.create_carded_task(
            actor_chat_key,
            run_id,
            title,
            spec,
            depends_on,
            parent_task_id,
            worker,
            assignee,
            destination,
            None,
        )
    }

    /// Create a task with the plan card it was given. The card goes in with
    /// the task, in the same write: nothing that reads the store, and no
    /// browser told `task_created`, ever sees the task without it. There is
    /// no setter afterwards — the card is part of the plan the person
    /// approves, so it is fixed once the task exists.
    #[allow(clippy::too_many_arguments)]
    pub fn create_carded_task(
        &self,
        actor_chat_key: &str,
        run_id: String,
        title: String,
        spec: String,
        depends_on: Vec<String>,
        parent_task_id: Option<String>,
        worker: Option<automation::WorkerSettings>,
        assignee: Option<TaskAssignee>,
        destination: Option<TaskDestination>,
        card: Option<TaskCard>,
    ) -> Result<Task, String> {
        let title = required_text("task title", title, 240)?;
        let spec = required_text("task spec", spec, 40_000)?;
        let worker = worker
            .map(automation::WorkerSettings::normalized)
            .transpose()?;
        let run_id_for_event = run_id.clone();
        let mut created_under: Option<String> = None;
        let mut reopened_plan = false;
        self.mutate(|data| {
            let run = match coordinator(data, &run_id, actor_chat_key) {
                Ok(run) => run,
                // Agents mode: a manager may split its OWN task, once.
                Err(not_coordinator) => {
                    let Some(parent) = parent_task_id.as_deref() else {
                        return Err(not_coordinator);
                    };
                    let mine = active_task_for_actor(data, actor_chat_key)
                        .is_some_and(|task| task.id == parent);
                    let parent_task = data.tasks.get(parent).ok_or("The parent task does not exist.")?;
                    if !mine || parent_task.assignee.is_none() {
                        return Err(not_coordinator);
                    }
                    if parent_task.parent_task_id.is_some() {
                        return Err("This task is already a subtask. Delegation goes no deeper; do it yourself.".into());
                    }
                    if assignee.is_none() {
                        return Err("Give each subtask an `assignee`: one of your direct reports.".into());
                    }
                    created_under = Some(parent.to_owned());
                    data.runs.get(&run_id).ok_or("The run does not exist.")?
                }
            };
            if worker.is_none() && run.worker_defaults.as_ref().is_some_and(|d| d.agent.is_none()) {
                return Err("Choose a suitable worker for this task: provide worker.agent, worker.model, worker.access, and optional worker.effort.".into());
            }
            let deps: BTreeSet<_> = depends_on.iter().collect();
            if deps.len() != depends_on.len() {
                return Err("A task dependency was listed more than once.".into());
            }
            for dependency in &depends_on {
                let task = data
                    .tasks
                    .get(dependency)
                    .ok_or_else(|| format!("Dependency {dependency} does not exist."))?;
                if task.run_id != run_id {
                    return Err("A task cannot depend on a task from another run.".into());
                }
            }
            if let Some(parent) = parent_task_id.as_deref() {
                let task = data
                    .tasks
                    .get(parent)
                    .ok_or("The parent task does not exist.")?;
                if task.run_id != run_id {
                    return Err("A parent task must belong to the same run.".into());
                }
            }
            let now = now_ms();
            let ready = depends_on.iter().all(|dependency| {
                data.tasks
                    .get(dependency)
                    .is_some_and(|task| task.status == TaskStatus::Completed)
            });
            let task = Task {
                id: format!("task_{}", compact_id()),
                run_id: run_id.clone(),
                title,
                spec,
                worker,
                assignee,
                destination,
                approved_at: None,
                card,
                workspace: None,
                depends_on,
                parent_task_id,
                status: if ready {
                    TaskStatus::Ready
                } else {
                    TaskStatus::Pending
                },
                active_attempt_id: None,
                result: None,
                created_at: now,
                updated_at: now,
            };
            let created = task.clone();
            // Anything still waiting on the manager's task waits for its
            // subtasks too, so the manager may settle as soon as it has split.
            if let Some(parent) = &created_under {
                for other in data.tasks.values_mut() {
                    if other.run_id == run_id
                        && other.depends_on.contains(parent)
                        && matches!(other.status, TaskStatus::Pending | TaskStatus::Ready)
                    {
                        other.depends_on.push(created.id.clone());
                        other.status = TaskStatus::Pending;
                        other.updated_at = now;
                    }
                }
            }
            data.tasks.insert(task.id.clone(), task);
            if let Some(run) = data.runs.get_mut(&run_id) {
                run.status = RunStatus::Running;
                run.updated_at = now;
                // Agents mode: the lead adding work after the person approved
                // puts the plan back in front of them. A manager's split is
                // exempt: only the top plan needs the person.
                if created_under.is_none() {
                    if let Some(plan) = run
                        .plan_approval
                        .as_mut()
                        .filter(|plan| plan.status == PlanStatus::Approved)
                    {
                        plan.status = PlanStatus::Pending;
                        plan.requested_at = now;
                        plan.decided_at = None;
                        reopened_plan = true;
                    }
                }
            }
            Ok(created)
        })
        .inspect(|_| {
            announce(&run_id_for_event, "task_created");
            if reopened_plan {
                announce(&run_id_for_event, "plan_pending");
            }
        })
    }

    #[cfg(test)]
    fn reserve_attempt(
        &self,
        actor_chat_key: &str,
        launch: &WorkerLaunch,
    ) -> Result<(Run, Task, Attempt, Option<Attempt>), String> {
        self.reserve_attempt_for(actor_chat_key, launch, None)
    }

    fn reserve_attempt_for(
        &self,
        actor_chat_key: &str,
        launch: &WorkerLaunch,
        recovery_of: Option<&str>,
    ) -> Result<(Run, Task, Attempt, Option<Attempt>), String> {
        let mut worker = automation::WorkerSettings {
            agent: launch.agent,
            model: launch.model.clone(),
            effort: launch.effort.clone(),
            access: launch.access,
            recovery: None,
        }
        .normalized()?;
        self.mutate(|data| {
            let task = data
                .tasks
                .get(&launch.task_id)
                .cloned()
                .ok_or("The task does not exist.")?;
            let run = coordinator(data, &task.run_id, actor_chat_key)?.clone();
            if run.awaiting_plan_approval() {
                return Err(
                    "The person has not approved this plan yet. Workers start once they do.".into(),
                );
            }
            worker.recovery = task
                .worker
                .as_ref()
                .and_then(|w| w.recovery.clone())
                .or_else(|| {
                    run.worker_defaults
                        .as_ref()
                        .and_then(|w| w.recovery.clone())
                });
            let recovery_agent = task
                .worker
                .as_ref()
                .filter(|w| w.recovery.is_some())
                .map(|w| w.agent)
                .or_else(|| run.worker_defaults.as_ref().and_then(|w| w.agent));
            if recovery_agent.is_some_and(|agent| agent != worker.agent) {
                if let Some(policy) = &mut worker.recovery {
                    policy.fallback_model = None;
                }
            }
            worker = worker.normalized()?;
            if let Some(expected) = recovery_of {
                if task.active_attempt_id.as_deref() != Some(expected)
                    || !data.attempts.get(expected).is_some_and(|a| {
                        a.status == AttemptStatus::Failed
                            && a.execution.next_retry_at.is_some_and(|at| at <= now_ms())
                    })
                {
                    return Err("This recovery was superseded or is not due.".into());
                }
            }
            if matches!(run.status, RunStatus::Completed | RunStatus::Stopped) {
                return Err("This run no longer accepts workers.".into());
            }
            if task.status == TaskStatus::Completed || task.status == TaskStatus::Cancelled {
                return Err("This task no longer accepts workers.".into());
            }
            if task.depends_on.iter().any(|dependency| {
                !data
                    .tasks
                    .get(dependency)
                    .is_some_and(|dependency| dependency.status == TaskStatus::Completed)
            }) {
                return Err("This task is waiting for its dependencies.".into());
            }
            let previous = task
                .active_attempt_id
                .as_deref()
                .and_then(|id| data.attempts.get(id))
                .cloned();
            if let Some(active) = previous.as_ref() {
                match active.status {
                    AttemptStatus::Preparing | AttemptStatus::Running => {
                        return Err("This task already has an active worker.".into())
                    }
                    AttemptStatus::Blocked if attempt_has_open_gate(data, active) => {
                        return Err("This task is waiting for its open decision gate.".into())
                    }
                    AttemptStatus::Blocked => {
                        if let Some(previous) = data.attempts.get_mut(&active.id) {
                            previous.finished_at.get_or_insert(previous.updated_at);
                            previous.status = AttemptStatus::Cancelled;
                            previous.execution.state = execution::ExecutionState::Cancelled;
                            previous.updated_at = now_ms();
                        }
                    }
                    _ => {}
                }
            }
            let active = data
                .attempts
                .values()
                .filter(|attempt| attempt.run_id == run.id && attempt_is_unsettled(data, attempt))
                .count();
            if active >= usize::from(run.max_concurrent) {
                return Err(format!(
                    "Run {} already has its {} allowed workers active.",
                    run.id, run.max_concurrent
                ));
            }

            let number = data
                .attempts
                .values()
                .filter(|attempt| attempt.task_id == task.id)
                .count()
                .saturating_add(1) as u32;
            let id = format!("attempt_{}", compact_id());
            let now = now_ms();
            let mut execution = execution::Execution::queued(
                now,
                recovery_of
                    .and(previous.as_ref())
                    .map_or(0, |a| a.execution.retry_count + 1),
            );
            if let Some(previous) = recovery_of.and(previous.as_ref()) {
                execution.latest_error = previous.execution.latest_error.clone();
                execution.last_progress = previous.execution.last_progress.clone();
                execution.last_progress_at = previous.execution.last_progress_at;
            }
            let attempt = Attempt {
                id: id.clone(),
                run_id: run.id.clone(),
                task_id: task.id.clone(),
                number,
                worker_chat_key: format!("chat:orch-{}", compact_id()),
                agent: launch.agent,
                model: worker.model.clone(),
                effort: launch.effort.clone(),
                access: launch.access,
                status: AttemptStatus::Preparing,
                execution,
                cwd: String::new(),
                branch: String::new(),
                is_worktree: false,
                summary: None,
                files_modified: Vec::new(),
                finished_at: None,
                archived_at: None,
                created_at: now,
                updated_at: now,
            };
            if let Some(previous) = previous.as_ref().and_then(|a| data.attempts.get_mut(&a.id)) {
                previous.execution.next_retry_at = None;
            }
            data.attempts.insert(id.clone(), attempt.clone());
            let reserved_task = data
                .tasks
                .get_mut(&task.id)
                .expect("the task was read above");
            reserved_task.status = TaskStatus::Running;
            reserved_task.worker = Some(worker);
            reserved_task.active_attempt_id = Some(id);
            reserved_task.result = None;
            reserved_task.updated_at = now;
            let active_run = data.runs.get_mut(&run.id).expect("the run was read above");
            active_run.status = RunStatus::Running;
            active_run.updated_at = now;
            Ok((run, reserved_task.clone(), attempt, previous))
        })
    }

    fn activate_attempt(
        &self,
        attempt_id: &str,
        cwd: String,
        branch: String,
        is_worktree: bool,
    ) -> Result<Attempt, String> {
        self.mutate(|data| {
            let attempt = data
                .attempts
                .get_mut(attempt_id)
                .ok_or("The reserved worker attempt disappeared.")?;
            if attempt.status != AttemptStatus::Preparing {
                return Err("The worker attempt is no longer being prepared.".into());
            }
            attempt.status = AttemptStatus::Running;
            attempt.execution.current_operation = Some("Dispatching provider request".into());
            attempt.execution.last_activity_at = Some(now_ms());
            attempt.cwd = cwd;
            attempt.branch = branch;
            attempt.is_worktree = is_worktree;
            attempt.updated_at = now_ms();
            Ok(attempt.clone())
        })
    }

    fn fail_preparation(
        &self,
        attempt_id: &str,
        reason: String,
        cwd: String,
        branch: String,
        is_worktree: bool,
    ) -> Result<(), String> {
        let run_id = self.mutate(|data| {
            let attempt = data
                .attempts
                .get_mut(attempt_id)
                .ok_or("The reserved worker attempt disappeared.")?;
            if !cwd.is_empty() {
                attempt.cwd = cwd;
                attempt.branch = branch;
                attempt.is_worktree = is_worktree;
            }
            let run_id = attempt.run_id.clone();
            execution::fail_dispatch(data, attempt_id, &reason);
            Ok(run_id)
        })?;
        announce(&run_id, "worker_failed");
        Ok(())
    }

    pub fn start_worker(
        &self,
        chats: Arc<ChatManager>,
        workspaces: &WorkspaceState,
        actor_chat_key: &str,
        launch: WorkerLaunch,
    ) -> Result<Attempt, String> {
        self.start_worker_for(chats, workspaces, actor_chat_key, launch, None)
    }

    pub(super) fn start_worker_for(
        &self,
        chats: Arc<ChatManager>,
        workspaces: &WorkspaceState,
        actor_chat_key: &str,
        mut launch: WorkerLaunch,
        recovery_of: Option<&str>,
    ) -> Result<Attempt, String> {
        launch.model = Some(automation::worker_model(
            launch.agent,
            launch.model.as_deref(),
        )?);
        let _operation = self.workspace_ops.lock().map_err(|e| e.to_string())?;
        // Validate project before reserving a concurrency slot.
        let (owning_run, owned) = self.owned_task(actor_chat_key, &launch.task_id)?;
        let run_project = match owned.destination {
            None => Some(workspace(workspaces, &owning_run.workspace_id)?),
            Some(_) => None,
        };
        let (run, task, reserved, previous) =
            self.reserve_attempt_for(actor_chat_key, &launch, recovery_of)?;
        announce(&run.id, "worker_preparing");
        // A routed task runs in its destination project, which must still be
        // registered with that repository on it. Checked after reserving, so
        // a destination removed since approval fails this attempt visibly and
        // tells the coordinator, instead of being retried in silence; nothing
        // falls back to the run's root.
        let workspace = match (run_project, &task.destination) {
            (Some(project), _) => project,
            (None, destination) => {
                let verified =
                    crate::workspaces::list_workspaces_impl(workspaces).and_then(|projects| {
                        match destination {
                            Some(destination) => {
                                destination::verify(&projects, destination).cloned()
                            }
                            None => workspace(workspaces, &run.workspace_id),
                        }
                    });
                match verified {
                    Ok(project) => project,
                    Err(error) => {
                        self.fail_preparation(
                            &reserved.id,
                            error.clone(),
                            String::new(),
                            String::new(),
                            false,
                        )?;
                        return Err(error);
                    }
                }
            }
        };
        let prepared = match self.prepare_task_workspace(
            &chats,
            &run,
            &task,
            &reserved,
            previous.as_ref(),
            &launch,
        ) {
            Ok(prepared) => prepared,
            Err(error) => {
                self.fail_preparation(
                    &reserved.id,
                    error.clone(),
                    String::new(),
                    String::new(),
                    false,
                )?;
                announce(&run.id, "worker_failed");
                return Err(error);
            }
        };
        if let Some(previous) = previous.as_ref() {
            // A settled chat must not wake after a replacement becomes
            // authoritative. This is essential when the retry reuses its
            // checkout, where two processes could otherwise mutate one tree.
            let _ = crate::agent_chat::chat_stop_impl(&chats, previous.worker_chat_key.clone());
        }

        let chat_id = reserved
            .worker_chat_key
            .strip_prefix("chat:")
            .unwrap_or(&reserved.worker_chat_key)
            .to_string();
        let now = now_ms();
        let meta = crate::chat_index::ChatMeta {
            id: chat_id.clone(),
            project_id: workspace.id.clone(),
            title: format!("Worker: {}", task.title),
            latest_response: None,
            custom_title: true,
            agent_title: false,
            session_id: None,
            cwd: Some(prepared.cwd.clone()),
            model_id: Some(model_id(launch.agent, launch.model.as_deref())),
            access: Some(access_id(launch.access).into()),
            created_at: now,
            updated_at: now,
            read_at: None,
            pinned: false,
            done_at: None,
            deleted_at: None,
            generation: 0,
            launch: None,
        };
        if let Err(error) = crate::agent_chat::chat_index_save(meta.clone()) {
            let _ = self.fail_preparation(
                &reserved.id,
                error.clone(),
                prepared.cwd,
                prepared.branch,
                prepared.is_worktree,
            );
            return Err(error);
        }

        let (_, task) = self.owned_task(actor_chat_key, &task.id)?;
        // Activate before spawning: a fast worker can report immediately.
        let active = self.activate_attempt(
            &reserved.id,
            prepared.cwd.clone(),
            prepared.branch.clone(),
            prepared.is_worktree,
        )?;
        let mut prompt = worker_prompt(&run, &task, &active);
        // Agents mode: every assigned agent has its own memory.
        if let Some(assignee) = &task.assignee {
            let path = crate::team::default_path();
            if let Ok(team) = crate::team::list(&path, None, true) {
                if let Some(me) = team.iter().find(|a| a.id == assignee.id) {
                    let _ = crate::team::ensure_memory(
                        &crate::memory_vault::Vault::profile(),
                        &reserved.worker_chat_key,
                        me,
                    );
                    prompt.push_str("\n\n");
                    prompt.push_str(&crate::team::memory_brief(me, &team));
                }
            }
        }
        // Agents mode: a second-level assignee that manages agents may split.
        if let (Some(assignee), None) = (&task.assignee, &task.parent_task_id) {
            if let Ok(Some(brief)) = crate::team::manager_brief(
                &crate::team::default_path(),
                &workspace.id,
                &assignee.id,
                &task.id,
                &run.id,
            ) {
                prompt.push_str("\n\n");
                prompt.push_str(&brief);
            }
        }
        if let Some(previous) = &previous {
            let reports = crate::chat_task::reports_for_chat_keys(std::iter::once(
                previous.worker_chat_key.as_str(),
            ));
            prompt.push_str(&format!("\n\nPrevious attempt {} stopped: {}\nLast observed progress: {}\nPrevious checklist: {}\nContinue from the retained workspace. Inspect existing changes and completed work before acting; do not blindly repeat earlier tools or external actions. The previous worker chat is {}.",
                previous.id, previous.summary.as_deref().unwrap_or("No summary"),
                previous.execution.last_progress.as_deref().unwrap_or("Not observed"),
                serde_json::to_string(&reports).unwrap_or_default(), previous.worker_chat_key));
        }
        let mut worker_env = workspace.env.clone();
        worker_env.insert("OCTIQ_ORCHESTRATION_ATTEMPT".into(), reserved.id.clone());
        let start = crate::agent_chat::chat_start_user_impl(
            chats.clone(),
            reserved.worker_chat_key.clone(),
            prepared.cwd.clone(),
            launch.agent,
            launch.model.clone(),
            Some(launch.access),
            Some(prompt),
            None,
            None,
            // A worker owns one isolated checkout. Giving it the workspace's
            // other paths would silently widen its write boundary back to the
            // primary checkout (or another repository) and defeat that
            // isolation. Cross-repository work should be split into explicit
            // tasks, each with its own run root and worker.
            Some(Vec::new()),
            Some(worker_env),
            launch.effort.clone(),
            None,
            Some(false),
            Some(format!("orchestration-{}", reserved.id)),
        );
        self.finish_dispatch(&active, start)
    }

    fn finish_dispatch(
        &self,
        active: &Attempt,
        start: Result<(), String>,
    ) -> Result<Attempt, String> {
        if let Err(error) = start {
            self.fail_preparation(
                &active.id,
                error.clone(),
                active.cwd.clone(),
                active.branch.clone(),
                active.is_worktree,
            )?;
            return Err(error);
        }
        // A provider can fail during startup, before chat_start returns.
        let current = self
            .snapshot(Some(&active.run_id))?
            .attempts
            .into_iter()
            .find(|a| a.id == active.id)
            .unwrap_or_else(|| active.clone());
        announce(
            &active.run_id,
            if current.status == AttemptStatus::Failed {
                "worker_failed"
            } else {
                "worker_started"
            },
        );
        Ok(current)
    }

    pub fn report_worker(
        &self,
        actor_chat_key: &str,
        report: WorkerReport,
    ) -> Result<Task, String> {
        self.capture_native_decisions()?;
        if crate::safety_block::has_pending_for_chat(actor_chat_key) {
            return Err("A native safety decision is still pending. End the turn without settling; the existing safety card must keep this attempt resumable.".into());
        }
        let mut event_run_id = String::new();
        let result = self.mutate(|data| {
            let attempt = data
                .attempts
                .get(&report.attempt_id)
                .cloned()
                .ok_or("The worker attempt does not exist.")?;
            if attempt.worker_chat_key != actor_chat_key {
                return Err("This chat does not own that worker attempt.".into());
            }
            let task = data
                .tasks
                .get(&attempt.task_id)
                .ok_or("The worker task does not exist.")?;
            if task.active_attempt_id.as_deref() != Some(attempt.id.as_str()) {
                return Err("This worker attempt is stale; a newer attempt owns the task.".into());
            }
            if !matches!(
                attempt.status,
                AttemptStatus::Preparing | AttemptStatus::Running
            ) {
                if attempt.status == AttemptStatus::Blocked && attempt_has_open_gate(data, &attempt)
                {
                    return Err("This worker attempt is waiting for its open decision gate.".into());
                }
                return Err("This worker attempt has already settled.".into());
            }
            let summary = required_text("worker summary", report.summary, 20_000)?;
            let now = now_ms();
            let attempt_mut = data
                .attempts
                .get_mut(&attempt.id)
                .expect("the attempt was read above");
            attempt_mut.status = match report.outcome {
                WorkerOutcome::Completed => AttemptStatus::Completed,
                WorkerOutcome::Failed => AttemptStatus::Failed,
                WorkerOutcome::Blocked => AttemptStatus::Blocked,
            };
            attempt_mut.summary = Some(summary.clone());
            attempt_mut.files_modified = clean_files(report.files_modified);
            attempt_mut.updated_at = now;
            attempt_mut.finished_at = Some(now);
            attempt_mut.execution.state = match report.outcome {
                WorkerOutcome::Completed => execution::ExecutionState::Completed,
                WorkerOutcome::Failed => execution::ExecutionState::Failed,
                WorkerOutcome::Blocked => execution::ExecutionState::Blocked,
            };
            attempt_mut.execution.last_activity_at = Some(now);
            attempt_mut.execution.last_progress_at = Some(now);
            attempt_mut.execution.last_progress = Some(summary.clone());
            attempt_mut.execution.current_operation = None;
            attempt_mut.execution.next_retry_at = None;

            let task_mut = data
                .tasks
                .get_mut(&attempt.task_id)
                .expect("the task was read above");
            task_mut.status = match report.outcome {
                WorkerOutcome::Completed => TaskStatus::Completed,
                WorkerOutcome::Failed => TaskStatus::Failed,
                WorkerOutcome::Blocked => TaskStatus::Blocked,
            };
            if let Some(ws) = task_mut.workspace.as_mut() {
                ws.state = workspaces::WorkspaceState::Retained;
            }
            task_mut.result = Some(summary);
            task_mut.updated_at = now;
            let settled = task_mut.clone();
            event_run_id = task_mut.run_id.clone();
            make_ready(data, &attempt.run_id);
            recompute_run(data, &attempt.run_id);
            let target = data.runs[&attempt.run_id].coordinator_chat_key.clone();
            inbox::enqueue(data, &attempt.run_id, actor_chat_key, &target, format!("report:{}", attempt.id), "report",
                format!("Worker reported {:?} for task {} ({}).\n\n{}\n\nRead orchestration_snapshot and continue coordination. Never resume a settled attempt; use an explicit retry if needed.", settled.status, settled.id, settled.title, settled.result.as_deref().unwrap_or_default()));
            Ok(settled)
        });
        if result.is_ok() {
            announce(&event_run_id, "worker_reported");
        }
        result
    }

    pub fn create_gate(
        &self,
        actor_chat_key: &str,
        run_id: String,
        task_id: Option<String>,
        question: String,
        options: Vec<String>,
    ) -> Result<Gate, String> {
        let question = required_text("gate question", question, 10_000)?;
        let options = options
            .into_iter()
            .filter_map(|option| {
                let option = option.trim().to_string();
                (!option.is_empty()).then_some(option)
            })
            .take(12)
            .collect::<Vec<_>>();
        let run_id_for_event = run_id.clone();
        self.mutate(|data| {
            let run = data
                .runs
                .get(&run_id)
                .cloned()
                .ok_or("The run does not exist.")?;
            let owned_task = active_task_for_actor(data, actor_chat_key);
            if actor_chat_key != run.coordinator_chat_key
                && owned_task.as_ref().map(|task| task.run_id.as_str()) != Some(run_id.as_str())
            {
                return Err("This chat does not belong to that run.".into());
            }
            if let Some(requested) = task_id.as_deref() {
                let task = data
                    .tasks
                    .get(requested)
                    .ok_or("The task does not exist.")?;
                if task.run_id != run_id {
                    return Err("The gate's task belongs to another run.".into());
                }
                if let Some(attempt) = task.active_attempt_id.as_ref().and_then(|id| data.attempts.get(id)) {
                    if !attempt_is_unsettled(data, attempt) {
                        return Err("This attempt has settled. Retry or reopen the task instead of creating a gate.".into());
                    }
                }
                if data.gates.values().any(|gate| gate.task_id.as_deref() == Some(requested) && gate.status == GateStatus::Open) {
                    return Err("This task already has an open decision gate. Resolve it first.".into());
                }
                if actor_chat_key != run.coordinator_chat_key
                    && owned_task.as_ref().map(|task| task.id.as_str()) != Some(requested)
                {
                    return Err("A worker may open a gate only for its own task.".into());
                }
            }
            let now = now_ms();
            let gate = Gate {
                id: format!("gate_{}", compact_id()),
                run_id: run_id.clone(),
                task_id: task_id
                    .clone()
                    .or_else(|| owned_task.as_ref().map(|task| task.id.clone())),
                created_by_chat_key: actor_chat_key.into(),
                target_chat_key: run.coordinator_chat_key.clone(),
                question,
                options,
                status: GateStatus::Open,
                resolution: None,
                created_at: now,
                updated_at: now,
            };
            if let Some(task) = gate.task_id.as_ref().and_then(|id| data.tasks.get_mut(id)) {
                task.status = TaskStatus::Blocked;
                task.updated_at = now;
                if let Some(attempt) = task
                    .active_attempt_id
                    .as_ref()
                    .and_then(|id| data.attempts.get_mut(id))
                {
                    attempt.status = AttemptStatus::Blocked;
                    attempt.execution.state = execution::ExecutionState::Blocked;
                    attempt.execution.current_operation = Some("Waiting for a decision".into());
                    attempt.updated_at = now;
                }
            }
            if let Some(run) = data.runs.get_mut(&run_id) {
                run.status = RunStatus::Waiting;
                run.updated_at = now;
            }
            data.gates.insert(gate.id.clone(), gate.clone());
            if gate.created_by_chat_key != gate.target_chat_key {
                inbox::enqueue(data, &gate.run_id, &gate.created_by_chat_key, &gate.target_chat_key,
                    format!("gate:{}", gate.id), "decision", format!("Worker needs a decision for gate {}.\n\n{}\n\nRead orchestration_snapshot and resolve through orchestration_gate_resolve. Only ask the person if their decision is needed.", gate.id, gate.question));
            }
            Ok(gate)
        })
        .inspect(|_| announce(&run_id_for_event, "gate_created"))
    }

    #[cfg(test)]
    pub fn resolve_gate(
        &self,
        actor: &str,
        gate_id: String,
        resolution: String,
    ) -> Result<Gate, String> {
        self.resolve_gate_and_resume(actor, gate_id, resolution, false)
    }

    pub fn resolve_gate_and_resume(
        &self,
        actor_chat_key: &str,
        gate_id: String,
        resolution: String,
        resume_target: bool,
    ) -> Result<Gate, String> {
        let resolution = required_text("gate resolution", resolution, 10_000)?;
        let mut event_run_id = String::new();
        let resolved = self.mutate(|data| {
            let gate = data
                .gates
                .get(&gate_id)
                .cloned()
                .ok_or("The gate does not exist.")?;
            let run_id = coordinator(data, &gate.run_id, actor_chat_key)?.id.clone();
            if gate.status != GateStatus::Open {
                return Err("This gate has already settled.".into());
            }
            let now = now_ms();
            let gate_mut = data
                .gates
                .get_mut(&gate_id)
                .expect("the gate was read above");
            gate_mut.status = GateStatus::Resolved;
            gate_mut.resolution = Some(resolution);
            gate_mut.updated_at = now;
            let resolved = gate_mut.clone();
            if let Some(task) = resolved
                .task_id
                .as_ref()
                .and_then(|id| data.tasks.get_mut(id))
            {
                if task.status == TaskStatus::Blocked {
                    task.status = if task.active_attempt_id.is_some() {
                        TaskStatus::Running
                    } else {
                        TaskStatus::Ready
                    };
                    task.updated_at = now;
                }
                if let Some(attempt) = task
                    .active_attempt_id
                    .as_ref()
                    .and_then(|id| data.attempts.get_mut(id))
                {
                    if attempt.status == AttemptStatus::Blocked {
                        attempt.status = AttemptStatus::Running;
                        attempt.execution.state = execution::ExecutionState::Queued;
                        attempt.execution.current_operation = Some("Waiting for decision delivery".into());
                        attempt.updated_at = now;
                    }
                }
            }
            event_run_id = run_id.clone();
            recompute_run(data, &run_id);
            if resume_target || resolved.created_by_chat_key != actor_chat_key {
                inbox::enqueue(data, &run_id, actor_chat_key, &resolved.created_by_chat_key, format!("resolved:{}", resolved.id), "resolution",
                    format!("Gate {} was resolved.\n\nQuestion: {}\nDecision: {}\n\nContinue the assigned task using this decision. Report the exact attempt when it settles.", resolved.id, resolved.question, resolved.resolution.as_deref().unwrap_or_default()));
            }
            Ok(resolved)
        });
        if resolved.is_ok() {
            announce(&event_run_id, "gate_resolved");
        }
        resolved
    }

    pub fn record_message(
        &self,
        actor_chat_key: &str,
        run_id: String,
        to: String,
        kind: String,
        subject: String,
        body: String,
    ) -> Result<OrchestrationMessage, String> {
        let kind = required_text("message kind", kind, 64)?;
        let subject = required_text("message subject", subject, 240)?;
        let body = required_text("message body", body, 20_000)?;
        let run_id_for_event = run_id.clone();
        self.mutate(|data| {
            let run = data
                .runs
                .get(&run_id)
                .cloned()
                .ok_or("The run does not exist.")?;
            let owned = active_task_for_actor(data, actor_chat_key);
            if actor_chat_key != run.coordinator_chat_key
                && owned.as_ref().map(|task| task.run_id.as_str()) != Some(run_id.as_str())
            {
                return Err("This chat does not belong to that run.".into());
            }
            let target = if to == "coordinator" {
                run.coordinator_chat_key
            } else {
                if actor_chat_key != run.coordinator_chat_key {
                    return Err("Workers may send messages only to their coordinator.".into());
                }
                let attempt = data
                    .attempts
                    .get(&to)
                    .ok_or("The target attempt does not exist.")?;
                if attempt.run_id != run_id {
                    return Err("The target attempt belongs to another run.".into());
                }
                let task = data
                    .tasks
                    .get(&attempt.task_id)
                    .ok_or("The target attempt's task does not exist.")?;
                if task.active_attempt_id.as_deref() != Some(attempt.id.as_str()) {
                    return Err("The target attempt is stale; a newer attempt owns the task.".into());
                }
                match attempt.status {
                    AttemptStatus::Preparing | AttemptStatus::Running => {}
                    AttemptStatus::Blocked if attempt_has_open_gate(data, attempt) => {
                        return Err("The target attempt is waiting for an open decision gate. Resolve that gate instead of sending a continuation message.".into());
                    }
                    AttemptStatus::Completed => {
                        return Err("The target attempt completed and cannot be resumed. Create a new task if more work is required.".into());
                    }
                    AttemptStatus::Blocked | AttemptStatus::Failed => {
                        return Err("The target attempt has settled. Start a retry with orchestration_worker_start before sending more instructions.".into());
                    }
                    AttemptStatus::Cancelled => {
                        return Err("The target attempt was cancelled and cannot be resumed.".into());
                    }
                }
                attempt.worker_chat_key.clone()
            };
            let message = OrchestrationMessage {
                id: format!("message_{}", compact_id()),
                run_id: run_id.clone(),
                from_chat_key: actor_chat_key.into(),
                to_chat_key: target,
                kind,
                subject,
                body,
                created_at: now_ms(),
            };
            data.messages.insert(message.id.clone(), message.clone());
            if message.to_chat_key != message.from_chat_key {
                inbox::enqueue(data, &run_id, actor_chat_key, &message.to_chat_key, format!("message:{}", message.id), if message.kind == "progress" { "progress" } else { "message" },
                    format!("Orchestration message [{}]\nSubject: {}\nFrom: {}\n\n{}", message.kind, message.subject, message.from_chat_key, message.body));
            }
            Ok(message)
        })
        .inspect(|_| announce(&run_id_for_event, "message_sent"))
    }

    pub fn stop_run(
        &self,
        actor_chat_key: &str,
        run_id: String,
        reason: String,
    ) -> Result<Vec<String>, String> {
        let _operation = self.workspace_ops.lock().map_err(|e| e.to_string())?;
        let reason = required_text("stop reason", reason, 2_000)?;
        let run_id_for_event = run_id.clone();
        self.mutate(|data| {
            coordinator(data, &run_id, actor_chat_key)?;
            let now = now_ms();
            for n in data.notifications.values_mut().filter(|n| {
                n.run_id == run_id
                    && matches!(
                        n.state,
                        inbox::DeliveryState::Pending | inbox::DeliveryState::Delivering
                    )
            }) {
                n.state = inbox::DeliveryState::Cancelled;
                n.updated_at = now;
            }
            let mut workers = Vec::new();
            for task in data.tasks.values_mut().filter(|task| task.run_id == run_id) {
                if !matches!(task.status, TaskStatus::Completed | TaskStatus::Failed) {
                    task.status = TaskStatus::Cancelled;
                    task.updated_at = now;
                }
            }
            for attempt in data
                .attempts
                .values_mut()
                .filter(|attempt| attempt.run_id == run_id)
            {
                attempt.execution.next_retry_at = None;
                if matches!(
                    attempt.status,
                    AttemptStatus::Preparing | AttemptStatus::Running | AttemptStatus::Blocked
                ) {
                    attempt.status = AttemptStatus::Cancelled;
                    attempt.execution.state = execution::ExecutionState::Cancelled;
                    attempt.execution.current_operation = None;
                    attempt.finished_at.get_or_insert(now);
                    attempt.updated_at = now;
                    workers.push(attempt.worker_chat_key.clone());
                }
            }
            for gate in data.gates.values_mut().filter(|gate| gate.run_id == run_id) {
                if gate.status == GateStatus::Open {
                    gate.status = GateStatus::Cancelled;
                    gate.updated_at = now;
                }
            }
            let run = data
                .runs
                .get_mut(&run_id)
                .expect("the run was checked above");
            run.status = RunStatus::Stopped;
            run.stopped_reason = Some(reason);
            run.updated_at = now;
            retention::prune_run(data, &run_id);
            Ok(workers)
        })
        .inspect(|_| announce(&run_id_for_event, "run_stopped"))
    }
}

fn workspace(state: &WorkspaceState, id: &str) -> Result<Workspace, String> {
    crate::workspaces::list_workspaces_impl(state)?
        .into_iter()
        .find(|workspace| workspace.id == id)
        .ok_or_else(|| "The run's project no longer exists.".into())
}

pub fn infer_context(
    workspaces: &WorkspaceState,
    actor_chat_key: &str,
    workspace_id: Option<String>,
    root_path: Option<String>,
) -> Result<(String, String), String> {
    validate_chat_key(actor_chat_key)?;
    let chat_id = actor_chat_key
        .strip_prefix("chat:")
        .unwrap_or(actor_chat_key);
    let meta = crate::chat_index::list()
        .into_iter()
        .find(|meta| meta.id == chat_id);
    let workspace_id = workspace_id.filter(|id| !id.trim().is_empty());
    // A saved chat's run belongs to that chat's project. Naming another one
    // would put its workers under a project the coordinator is not in.
    if let (Some(requested), Some(meta)) = (&workspace_id, &meta) {
        if requested != &meta.project_id {
            return Err("A run belongs to its coordinator chat's project.".into());
        }
    }
    let workspace_id = workspace_id
        .or_else(|| meta.as_ref().map(|meta| meta.project_id.clone()))
        .ok_or("The coordinator chat is not attached to a project.")?;
    let workspace = workspace(workspaces, &workspace_id)?;
    let chat_cwd = meta.and_then(|meta| meta.cwd);
    let root_path = match root_path.filter(|path| !path.trim().is_empty()) {
        // A root named in the request must be the chat's own folder or lie in
        // one the project registers. Any other folder is refused, not adopted.
        Some(root) => {
            if !root_allowed(&workspace, chat_cwd.as_deref(), &root) {
                return Err(format!(
                    "{root} is not this chat's folder or a folder registered on project {}.",
                    workspace.name
                ));
            }
            root
        }
        None => chat_cwd.unwrap_or_else(|| workspace.primary_path.clone()),
    };
    if !Path::new(&root_path).is_dir() {
        return Err("The coordinator's project folder does not exist.".into());
    }
    Ok((workspace_id, root_path))
}

/// A run root is the chat's own folder, or inside a repository registered on
/// the run's project.
fn root_allowed(workspace: &Workspace, chat_cwd: Option<&str>, root: &str) -> bool {
    let root = Path::new(root.trim());
    if !root.is_absolute()
        || root
            .components()
            .any(|c| c == std::path::Component::ParentDir)
    {
        return false;
    }
    chat_cwd.is_some_and(|cwd| Path::new(cwd) == root)
        || destination::repositories(workspace)
            .iter()
            .any(|repo| root.starts_with(repo))
}

fn coordinator<'a>(
    data: &'a Stored,
    run_id: &str,
    actor_chat_key: &str,
) -> Result<&'a Run, String> {
    let run = data.runs.get(run_id).ok_or("The run does not exist.")?;
    if run.coordinator_chat_key != actor_chat_key {
        return Err("Only this run's coordinator may do that.".into());
    }
    Ok(run)
}

fn active_task_for_actor(data: &Stored, actor_chat_key: &str) -> Option<Task> {
    data.attempts
        .values()
        .find(|attempt| {
            attempt.worker_chat_key == actor_chat_key
                && attempt_is_unsettled(data, attempt)
                && data.tasks.get(&attempt.task_id).is_some_and(|task| {
                    task.active_attempt_id.as_deref() == Some(attempt.id.as_str())
                })
        })
        .and_then(|attempt| data.tasks.get(&attempt.task_id))
        .cloned()
}

/// `Blocked` has two meanings in the persisted schema: a live worker waiting
/// on an open decision gate, or a terminal worker report with a blocked
/// outcome. The gate is the authoritative discriminator between them.
fn attempt_has_open_gate(data: &Stored, attempt: &Attempt) -> bool {
    data.gates.values().any(|gate| {
        gate.task_id.as_deref() == Some(attempt.task_id.as_str()) && gate.status == GateStatus::Open
    })
}

fn attempt_is_unsettled(data: &Stored, attempt: &Attempt) -> bool {
    matches!(
        attempt.status,
        AttemptStatus::Preparing | AttemptStatus::Running
    ) || (attempt.status == AttemptStatus::Blocked && attempt_has_open_gate(data, attempt))
}

fn make_ready(data: &mut Stored, run_id: &str) {
    let completed: BTreeSet<_> = data
        .tasks
        .values()
        .filter(|task| task.run_id == run_id && task.status == TaskStatus::Completed)
        .map(|task| task.id.clone())
        .collect();
    let now = now_ms();
    for task in data.tasks.values_mut().filter(|task| {
        task.run_id == run_id
            && task.status == TaskStatus::Pending
            && task.depends_on.iter().all(|id| completed.contains(id))
    }) {
        task.status = TaskStatus::Ready;
        task.updated_at = now;
    }
}

fn recompute_run(data: &mut Stored, run_id: &str) {
    let tasks: Vec<_> = data
        .tasks
        .values()
        .filter(|task| task.run_id == run_id)
        .map(|task| task.status)
        .collect();
    let has_open_gate = data
        .gates
        .values()
        .any(|gate| gate.run_id == run_id && gate.status == GateStatus::Open);
    let status = if tasks.is_empty() {
        RunStatus::Planning
    } else if tasks.iter().all(|status| *status == TaskStatus::Completed) {
        RunStatus::Completed
    } else if has_open_gate || tasks.contains(&TaskStatus::Blocked) {
        RunStatus::Waiting
    } else if tasks.iter().any(|status| {
        matches!(
            status,
            TaskStatus::Running | TaskStatus::Ready | TaskStatus::Pending
        )
    }) {
        RunStatus::Running
    } else if tasks.contains(&TaskStatus::Failed) {
        RunStatus::Failed
    } else {
        RunStatus::Stopped
    };
    if let Some(run) = data.runs.get_mut(run_id) {
        if run.status != RunStatus::Stopped {
            run.status = status;
            run.updated_at = now_ms();
        }
    }
    retention::prune_run(data, run_id);
}

/// Agent processes are children of the server and cannot survive its restart.
/// Persisted active attempts therefore become failed attempts on load rather
/// than "ghost" workers that hold a task and concurrency slot forever.
fn recover_interrupted_workers(data: &mut Stored) -> bool {
    let now = now_ms();
    let gate_blocked_tasks = data
        .gates
        .values()
        .filter(|gate| gate.status == GateStatus::Open)
        .filter_map(|gate| gate.task_id.clone())
        .collect::<BTreeSet<_>>();
    let mut recovered = BTreeMap::new();
    let mut migrated = false;
    for attempt in data.attempts.values_mut() {
        if attempt.execution.last_activity_at.is_none() {
            attempt.execution.last_activity_at = Some(attempt.updated_at);
            attempt.execution.state = match attempt.status {
                AttemptStatus::Completed => execution::ExecutionState::Completed,
                AttemptStatus::Failed => execution::ExecutionState::Failed,
                AttemptStatus::Cancelled => execution::ExecutionState::Cancelled,
                AttemptStatus::Blocked => execution::ExecutionState::Blocked,
                _ => execution::ExecutionState::Queued,
            };
            migrated = true;
        }
        let interrupted = matches!(
            attempt.status,
            AttemptStatus::Preparing | AttemptStatus::Running
        ) || (attempt.status == AttemptStatus::Blocked
            && gate_blocked_tasks.contains(&attempt.task_id));
        if !interrupted {
            if attempt.finished_at.is_none() {
                attempt.finished_at = Some(attempt.updated_at);
                migrated = true;
            }
            continue;
        }
        attempt.status = AttemptStatus::Failed;
        attempt.execution.state = execution::ExecutionState::Disconnected;
        attempt.execution.current_operation = None;
        attempt.execution.next_retry_at = None;
        attempt.execution.latest_error = Some(execution::ExecutionError {
            kind: "disconnected".into(),
            message: "Worker was interrupted when OctiqFlow restarted.".into(),
            at: now,
            retryable: false,
        });
        attempt.summary =
            Some("Worker was interrupted when OctiqFlow restarted. Start a new attempt.".into());
        attempt.updated_at = now;
        attempt.finished_at = Some(now);
        recovered.insert(
            attempt.task_id.clone(),
            (attempt.id.clone(), attempt.run_id.clone()),
        );
    }
    if recovered.is_empty() {
        return migrated;
    }
    for gate in data.gates.values_mut() {
        if gate.status == GateStatus::Open
            && gate
                .task_id
                .as_ref()
                .is_some_and(|id| recovered.contains_key(id))
        {
            gate.status = GateStatus::Cancelled;
            gate.updated_at = now;
        }
    }
    let mut run_ids = BTreeSet::new();
    for (task_id, (attempt_id, run_id)) in recovered {
        let attempt = &data.attempts[&attempt_id];
        let target = data.runs[&run_id].coordinator_chat_key.clone();
        let worker = attempt.worker_chat_key.clone();
        inbox::enqueue(data, &run_id, &worker, &target, format!("execution-failed:{attempt_id}"), "disconnected",
            format!("Worker for task {task_id} (attempt {attempt_id}) disconnected when the host restarted. The attempt is failed. Workspace and completed work are preserved. Read orchestration_snapshot before retrying."));
        run_ids.insert(run_id);
        if let Some(task) = data.tasks.get_mut(&task_id) {
            if task.active_attempt_id.as_deref() == Some(attempt_id.as_str())
                && !matches!(task.status, TaskStatus::Completed | TaskStatus::Cancelled)
            {
                task.status = TaskStatus::Failed;
                task.result = Some(
                    "Worker was interrupted when OctiqFlow restarted. Start a new attempt.".into(),
                );
                task.updated_at = now;
            }
        }
    }
    for run_id in run_ids {
        recompute_run(data, &run_id);
    }
    true
}

fn worker_prompt(run: &Run, task: &Task, attempt: &Attempt) -> String {
    let brief = format!(
        "You are an OctiqFlow orchestration worker. This dispatch is authoritative only for the identifiers below.\n\nRun: {}\nTask: {}\nAttempt: {}\nObjective: {}\n\nYour task\nTitle: {}\n{}\n\nWork only on this task in the provided workspace. Use task_status to report a short checklist at the start, then send the whole checklist when a step finishes or the plan changes. Set nextStep to the current stage. These reports drive the task board; never invent a completion percentage. Before settling, report the final checklist state. Communicate only with your coordinator: use orchestration_message_send with to=coordinator. The person can inspect this chat but sends all instructions through the main chat. Do not ask the person directly, message other workers, or create a run. If a decision blocks you, call orchestration_gate_create for this run and task, then end your turn. A Codex safety rejection with a pending OctiqFlow approval card is not a settled task: report the rejected action in prose, do not create a gate or report the worker, and end the turn so the card can resume this same attempt. When the task settles, call orchestration_worker_report exactly once with attemptId '{}', an outcome of completed, failed, or blocked, a concise summary, and the files you changed. A normal prose answer does not complete the task in OctiqFlow.",
        run.id,
        task.id,
        attempt.id,
        run.objective,
        task.title,
        task.spec,
        attempt.id
    );
    let destination = task
        .destination
        .as_ref()
        .map(|d| {
            format!(
                "\nDestination: project {} ({}), repository {}",
                d.project_name, d.project_id, d.repository
            )
        })
        .unwrap_or_default();
    let workspace = task.workspace.as_ref().map(|w| format!(
        "\n\nAssigned workspace: {}\nBranch: {}\nMode: {:?}\nBase SHA: {}\nExisting changes to preserve:\n{}\nThe host owns this workspace lifecycle. Do not switch branches, create replacement worktrees, or remove this directory. Stop all source changes after reporting. Use orchestration validation workspaces for isolated commit checks.",
        w.plan.cwd, w.plan.branch, w.plan.mode, w.plan.base_sha, w.plan.initial_status
    )).unwrap_or_default();
    format!("{brief}{destination}{workspace}\n\nIf you start a local service that downstream work needs, register its loopback host, port, and precise source/recovery guidance with orchestration_service_register before settling. A completed startup task is not live service readiness; application health still needs verification. Never include credentials in recovery guidance.")
}

pub fn master_prompt(run: &Run) -> String {
    let brief = format!(
        "OctiqFlow created orchestration run {} and assigned this chat as its master.\n\nObjective\n{}\n\nTreat the host orchestration state as authoritative. Start by creating a shallow task DAG with orchestration_task_create. Give every task a concise outcome-based title and a spec with concrete checklist steps and validation. The person follows these assignments in a compact task board; workers report their steps through task_status. Dispatch the full ready wave up to the run's concurrency limit ({}) before ending your turn, using the run workspace policy (the host selects and leases the workspace). After dispatch, end your turn so the person can keep chatting. Do not poll or wait for workers in a long-running turn; the host delivers durable notifications when action is needed. Do not write in a checkout delegated to a worker. Workers use an isolated worktree in Auto mode; Current checkout mode serializes writers. Workspace lifetime continues through review and merge; never delete it merely because a worker completed. Re-read orchestration_snapshot after worker reports or decisions. Use orchestration_message_send only for an active attempt; a settled attempt cannot resume. If a blocked or failed task needs more work, start a new authoritative attempt with orchestration_worker_start, using newWorktree=false to reuse its previous worker workspace. Use orchestration_gate_create only for a decision that truly needs the person. Do not claim the run is complete until every required task is completed in the snapshot. A worker's prose does not settle a task; its orchestration_worker_report does.",
        run.id, run.objective, run.max_concurrent
    );
    let brief = format!("{brief}\n\nChoose the provider, model, and reasoning effort suitable for EACH task and include them in orchestration_task_create's worker settings (agent, model, access, effort). You may mix Claude and Codex workers in one run. Use Sol (codex, gpt-5.6-sol) or Opus (claude, opus) for demanding implementation or review, Terra (codex, gpt-5.6-terra) or Sonnet (claude, sonnet) for everyday execution, and Luna (codex, gpt-5.6-luna) or Haiku (claude, haiku) for small, well-bounded tasks. Match effort to complexity. Use access=auto unless the task needs another boundary, such as read for investigation. Fable and Astra are reserved for main agents orchestrating other agents; NEVER choose either for an execution worker, including retries or review tasks. Do not inherit the main agent's model or leave worker selection to a CLI default. Explain the assignment briefly in the task spec. For manual dispatch and retries, pass the chosen settings to orchestration_worker_start.");
    let brief = format!("{brief}\n\nUse attempt.execution as host evidence of activity: state, lastActivityAt, lastProgressAt, lastProgress, currentOperation, and latestError. Task status running alone does not mean a worker is executing. Capacity-blocked, retrying, stalled, and disconnected workers need attention. The host records provider failures and durable notifications even when the worker cannot respond. Before a manual retry, inspect nextRetryAt and retryCount; an automatic recovery may already be scheduled. Recovery preserves the workspace and creates a new attempt. Do not replay a tool merely because it is quiet.");
    let brief = if run.awaiting_plan_approval() {
        format!("{brief}\n\nThe person approves this run's plan before any worker starts; the host refuses every dispatch until then. Create all tasks, reply with the plan as one short list, and end your turn. Do not call orchestration_worker_start or orchestration_dispatch_ready before approval.")
    } else {
        brief
    };
    if run.worker_defaults.is_some() {
        format!("{brief}\n\nAutomatic dispatch is enabled. Create all tasks with their dependencies and chosen worker settings; the host starts each task with its own selection and starts subsequent waves automatically. Do not also start those tasks manually. Legacy tasks without a worker selection can be started explicitly with orchestration_worker_start. Host-detected transient provider failures have bounded automatic recovery. Inspect attempt.execution and nextRetryAt before retrying; do not duplicate a scheduled recovery. Worker-reported failures and blocks still require an explicit retry decision. Workspace mode: {:?}.", run.workspace_mode)
    } else {
        brief
    }
}

fn model_id(agent: ChatAgent, model: Option<&str>) -> String {
    let provider = match agent {
        ChatAgent::Claude => "claude",
        ChatAgent::Codex => "codex",
        ChatAgent::Pi => "pi",
    };
    let Some(model) = model.filter(|model| !model.trim().is_empty()) else {
        return format!("{provider}:default");
    };
    let known = match (agent, model) {
        (ChatAgent::Claude, "opus" | "sonnet" | "haiku" | "fable") => Some(model),
        (ChatAgent::Codex, "gpt-6-astra") => Some("astra"),
        (ChatAgent::Codex, "gpt-5.6-sol") => Some("sol"),
        (ChatAgent::Codex, "gpt-5.6-terra") => Some("terra"),
        (ChatAgent::Codex, "gpt-5.6-luna") => Some("luna"),
        (ChatAgent::Pi, "gpt-6-astra") => Some("astra"),
        (ChatAgent::Pi, "gpt-5.6-sol") => Some("sol"),
        (ChatAgent::Pi, "gpt-5.6-terra") => Some("terra"),
        (ChatAgent::Pi, "gpt-5.6-luna") => Some("luna"),
        _ => None,
    };
    known.map_or_else(
        || format!("{provider}:model:{}", percent_encode(model)),
        |name| format!("{provider}:{name}"),
    )
}

fn percent_encode(value: &str) -> String {
    let mut encoded = String::new();
    for byte in value.bytes() {
        if byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.' | b'~') {
            encoded.push(char::from(byte));
        } else {
            encoded.push_str(&format!("%{byte:02X}"));
        }
    }
    encoded
}

fn access_id(access: Access) -> &'static str {
    match access {
        Access::Read => "read",
        Access::Manual => "manual",
        Access::Edits => "edits",
        Access::Auto => "auto",
        Access::Full => "full",
    }
}

fn clean_files(files: Vec<String>) -> Vec<String> {
    let mut seen = BTreeSet::new();
    files
        .into_iter()
        .filter_map(|file| {
            let file = file.trim().to_string();
            (!file.is_empty() && file.len() <= 8_192 && seen.insert(file.clone())).then_some(file)
        })
        .take(500)
        .collect()
}

fn required_text(label: &str, value: String, max: usize) -> Result<String, String> {
    let value = value.trim().to_string();
    if value.is_empty() {
        return Err(format!("The {label} is required."));
    }
    if value.len() > max {
        return Err(format!("The {label} is too long."));
    }
    Ok(value)
}

fn validate_chat_key(key: &str) -> Result<(), String> {
    if key
        .strip_prefix("chat:")
        .is_some_and(|id| !id.is_empty() && id.len() <= 256)
    {
        Ok(())
    } else {
        Err("A valid OctiqFlow chat is required.".into())
    }
}

fn compact_id() -> String {
    Uuid::new_v4().simple().to_string()
}

fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis().min(i64::MAX as u128) as i64)
        .unwrap_or(0)
}

fn sibling_temp(path: &Path) -> PathBuf {
    let name = path
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or("orchestrations.json");
    path.with_file_name(format!(".{name}.{}.tmp", compact_id()))
}

fn announce(run_id: &str, change: &str) {
    crate::bus::emit(
        "orchestration-changed",
        json!({ "runId": run_id, "change": change }),
    );
}

#[cfg(test)]
mod tests {
    use super::*;

    pub(super) fn run(store: &OrchestrationStore) -> Run {
        store
            .create_run(
                "chat:master".into(),
                "Ship the feature".into(),
                "workspace".into(),
                "/tmp".into(),
                Some(2),
            )
            .unwrap()
    }

    pub(super) fn task(store: &OrchestrationStore, run: &Run, depends_on: Vec<String>) -> Task {
        store
            .create_task(
                "chat:master",
                run.id.clone(),
                "Implement".into(),
                "Make the requested change".into(),
                depends_on,
                None,
                None,
            )
            .unwrap()
    }

    pub(super) fn running_worker(store: &OrchestrationStore, run: &Run) -> Attempt {
        let task = task(store, run, Vec::new());
        let (_, _, attempt, _) = store
            .reserve_attempt(
                "chat:master",
                &WorkerLaunch {
                    task_id: task.id,
                    agent: ChatAgent::Codex,
                    model: None,
                    effort: None,
                    access: Access::Auto,
                    new_worktree: Some(true),
                    base_branch: String::new(),
                },
            )
            .unwrap();
        store
            .activate_attempt(&attempt.id, "/tmp".into(), "test".into(), true)
            .unwrap()
    }

    fn launch_for(task_id: &str) -> WorkerLaunch {
        WorkerLaunch {
            task_id: task_id.into(),
            agent: ChatAgent::Codex,
            model: None,
            effort: None,
            access: Access::Auto,
            new_worktree: Some(true),
            base_branch: String::new(),
        }
    }

    fn assigned(
        store: &OrchestrationStore,
        run: &Run,
        actor: &str,
        parent: Option<String>,
        depends_on: Vec<String>,
    ) -> Result<Task, String> {
        store.create_task_for(
            actor,
            run.id.clone(),
            "Part".into(),
            "Do the part".into(),
            depends_on,
            parent,
            None,
            Some(TaskAssignee {
                id: "agent_ada".into(),
                name: "Ada".into(),
            }),
            None,
        )
    }

    #[test]
    fn a_plan_card_is_one_line_each_bounded_and_set_once() {
        let s = |text: &str| Some(text.to_string());
        let card = TaskCard::checked(
            s("  The chat\nlist hides   destinations. "),
            s("Show them."),
            Some(vec![
                "Badges show".into(),
                "  ".into(),
                "Tests\npass".into(),
            ]),
        )
        .unwrap()
        .unwrap();
        assert_eq!(card.problem, "The chat list hides destinations.");
        assert_eq!(card.acceptance, vec!["Badges show", "Tests pass"]);
        assert_eq!(TaskCard::checked(None, s(" "), Some(vec![])).unwrap(), None);
        assert!(TaskCard::checked(s(&"x".repeat(301)), None, None).is_err());
        assert!(TaskCard::checked(None, None, Some(vec!["a".into(); 6])).is_err());
        assert!(TaskCard::checked(None, None, Some(vec!["a".repeat(241)])).is_err());

        let root = std::env::temp_dir().join(format!("octiq-orchestration-{}", compact_id()));
        fs::create_dir_all(&root).unwrap();
        let file = root.join("orchestrations.json");
        let store = OrchestrationStore::load(file.clone());
        let run = run(&store);
        let bare = task(&store, &run, Vec::new());
        assert_eq!(bare.card, None);
        let carded = |actor: &str, card: TaskCard| {
            store.create_carded_task(
                actor,
                run.id.clone(),
                "Show destinations".into(),
                "Badge each row".into(),
                Vec::new(),
                None,
                None,
                None,
                None,
                Some(card),
            )
        };
        let created = carded("chat:master", card.clone()).unwrap();
        assert_eq!(created.card.as_ref(), Some(&card));
        // One write: the task is stored, and saved, with its card already on
        // it, so neither a snapshot nor the file ever holds it without one.
        let seen = store.snapshot(Some(&run.id)).unwrap();
        let stored = seen.tasks.iter().find(|t| t.id == created.id).unwrap();
        assert_eq!(stored.card.as_ref(), Some(&card));
        let reloaded = OrchestrationStore::load(file);
        let saved = reloaded.snapshot(Some(&run.id)).unwrap();
        let by_id = |id: &str| {
            saved
                .tasks
                .iter()
                .find(|t| t.id == id)
                .unwrap()
                .card
                .clone()
        };
        assert_eq!(by_id(&created.id), Some(card.clone()));
        assert_eq!(by_id(&bare.id), None);
        // A refused create leaves no task behind, carded or not.
        assert!(carded("chat:stranger", card).is_err());
        assert_eq!(store.snapshot(Some(&run.id)).unwrap().tasks.len(), 2);
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn a_pending_plan_holds_every_worker_until_the_person_approves() {
        let store = OrchestrationStore::default();
        let run = run(&store);
        store.require_plan_approval(&run.id).unwrap();
        // Nothing to approve before the lead has made a plan.
        assert!(store.approve_plan("chat:master", &run.id, None).is_err());
        let first = task(&store, &run, Vec::new());
        assert!(store
            .reserve_attempt("chat:master", &launch_for(&first.id))
            .unwrap_err()
            .contains("not approved"));
        assert!(store.approve_plan("chat:worker", &run.id, None).is_err());
        let approved = store.approve_plan("chat:master", &run.id, None).unwrap();
        assert!(!approved.awaiting_plan_approval());
        assert!(store.approve_plan("chat:master", &run.id, None).is_err());
        assert!(store
            .reserve_attempt("chat:master", &launch_for(&first.id))
            .is_ok());
    }

    #[test]
    fn approval_covers_the_plan_seen_and_new_lead_work_needs_it_again() {
        let store = OrchestrationStore::default();
        let run = run(&store);
        store.require_plan_approval(&run.id).unwrap();
        let destination = TaskDestination {
            project_id: "shop".into(),
            project_name: "Shop".into(),
            repository: "/repos/api".into(),
        };
        let first = store
            .create_task_for(
                "chat:master",
                run.id.clone(),
                "API".into(),
                "Build the API".into(),
                Vec::new(),
                None,
                None,
                Some(TaskAssignee {
                    id: "agent_ada".into(),
                    name: "Ada".into(),
                }),
                Some(destination.clone()),
            )
            .unwrap();
        // The destination is part of the persisted task.
        let stored = store.snapshot(None).unwrap().tasks.remove(0);
        assert_eq!(stored.destination.as_ref(), Some(&destination));
        assert!(stored.approved_at.is_none());
        // The person approves exactly what they saw, nothing else.
        let stale = [first.id.clone(), "task_other".into()];
        assert!(store
            .approve_plan("chat:master", &run.id, Some(&stale))
            .unwrap_err()
            .contains("changed"));
        store
            .approve_plan("chat:master", &run.id, Some(&[first.id.clone()]))
            .unwrap();
        assert!(store.snapshot(None).unwrap().tasks[0].approved_at.is_some());

        // The lead adds a task after approval: it waits for the person, and
        // the approved destination of the first task is untouched.
        let (_, _, attempt, _) = store
            .reserve_attempt("chat:master", &launch_for(&first.id))
            .unwrap();
        let attempt = store
            .activate_attempt(&attempt.id, "/tmp".into(), "test".into(), true)
            .unwrap();
        let second = assigned(&store, &run, "chat:master", None, Vec::new()).unwrap();
        let snapshot = store.snapshot(None).unwrap();
        assert!(snapshot.runs[0].awaiting_plan_approval());
        let first_now = snapshot.tasks.iter().find(|t| t.id == first.id).unwrap();
        assert_eq!(first_now.destination.as_ref(), Some(&destination));
        assert!(store
            .reserve_attempt("chat:master", &launch_for(&second.id))
            .unwrap_err()
            .contains("not approved"));
        // Only the new task is awaiting approval now.
        assert!(store
            .approve_plan(
                "chat:master",
                &run.id,
                Some(&[first.id.clone(), second.id.clone()])
            )
            .is_err());
        store
            .approve_plan("chat:master", &run.id, Some(&[second.id.clone()]))
            .unwrap();

        // A manager's own split is not the top plan and needs no approval.
        let part = assigned(
            &store,
            &run,
            &attempt.worker_chat_key,
            Some(first.id.clone()),
            Vec::new(),
        );
        assert!(part.is_ok());
        assert!(!store.snapshot(None).unwrap().runs[0].awaiting_plan_approval());
    }

    #[test]
    fn a_legacy_task_without_destination_or_approval_still_loads() {
        let task: Task = serde_json::from_value(json!({
            "id": "task_old", "runId": "run_old", "title": "Old", "spec": "Old work",
            "dependsOn": [], "status": "pending", "createdAt": 1, "updatedAt": 1,
        }))
        .unwrap();
        assert!(task.destination.is_none());
        assert!(task.approved_at.is_none());
        let value = serde_json::to_value(&task).unwrap();
        assert!(value.get("destination").is_none());
    }

    #[test]
    fn a_run_root_must_be_the_chat_folder_or_registered() {
        let project: Workspace = serde_json::from_value(json!({
            "id": "p", "name": "P", "primary_path": "/repos/app", "paths": ["/repos/lib"],
        }))
        .unwrap();
        assert!(root_allowed(&project, None, "/repos/app"));
        assert!(root_allowed(&project, None, "/repos/lib/sub"));
        assert!(root_allowed(&project, Some("/wt/feature"), "/wt/feature"));
        assert!(!root_allowed(&project, Some("/wt/feature"), "/etc"));
        assert!(!root_allowed(&project, None, "/repos/app/../../etc"));
        assert!(!root_allowed(&project, None, "relative/app"));
    }

    #[test]
    fn a_manager_splits_its_own_task_once_and_dependents_wait_for_the_parts() {
        let store = OrchestrationStore::default();
        let run = run(&store);
        let managed = assigned(&store, &run, "chat:master", None, Vec::new()).unwrap();
        let after = assigned(&store, &run, "chat:master", None, vec![managed.id.clone()]).unwrap();
        let (_, _, attempt, _) = store
            .reserve_attempt("chat:master", &launch_for(&managed.id))
            .unwrap();
        let attempt = store
            .activate_attempt(&attempt.id, "/tmp".into(), "test".into(), true)
            .unwrap();
        let manager = attempt.worker_chat_key.as_str();

        let part = assigned(&store, &run, manager, Some(managed.id.clone()), Vec::new()).unwrap();
        assert_eq!(part.parent_task_id.as_deref(), Some(managed.id.as_str()));
        let snapshot = store.snapshot(None).unwrap();
        let waiting = snapshot.tasks.iter().find(|t| t.id == after.id).unwrap();
        assert!(waiting.depends_on.contains(&part.id));

        // Only with an assignee, only under its own task, and no deeper.
        let mut bare = assigned(&store, &run, manager, Some(managed.id.clone()), Vec::new());
        assert!(bare.is_ok());
        bare = store.create_task_for(
            manager,
            run.id.clone(),
            "Part".into(),
            "Do it".into(),
            Vec::new(),
            Some(managed.id.clone()),
            None,
            None,
            None,
        );
        assert!(bare.unwrap_err().contains("assignee"));
        assert!(assigned(&store, &run, manager, None, Vec::new()).is_err());
        assert!(assigned(
            &store,
            &run,
            "chat:someone",
            Some(managed.id.clone()),
            Vec::new()
        )
        .is_err());
        assert!(assigned(&store, &run, manager, Some(part.id.clone()), Vec::new()).is_err());
    }

    #[test]
    fn master_recovery_keeps_run_identity_and_checks_owner_and_settlement() {
        let store = OrchestrationStore::default();
        let original = run(&store);
        for _ in 0..2 {
            let (_guard, resumed) = store
                .guard_master_start("chat:master", &original.id)
                .unwrap();
            assert_eq!(resumed.id, original.id);
        }
        assert_eq!(store.snapshot(None).unwrap().runs.len(), 1);
        assert!(store
            .guard_master_start("chat:other", &original.id)
            .is_err());
        store
            .stop_run("chat:master", original.id.clone(), "Stop".into())
            .unwrap();
        assert!(store
            .guard_master_start("chat:master", &original.id)
            .unwrap_err()
            .contains("settled"));
        let next = run(&store);
        assert_ne!(next.id, original.id);
        assert!(store.guard_master_start("chat:master", &next.id).is_ok());
    }

    fn question() -> crate::question::Question {
        serde_json::from_value(serde_json::json!({
            "question": "Which approach?", "options": [
                { "label": "Keep", "description": "Keep the existing behavior" }, "Change"
            ]
        }))
        .unwrap()
    }

    #[test]
    fn worker_chat_mutations_are_rejected_before_any_side_effect() {
        let store = Arc::new(OrchestrationStore::default());
        let run = run(&store);
        let worker = running_worker(&store, &run);
        let mut manager = ChatManager::default();
        manager.orchestrations = store.clone();
        let svc = crate::dispatch::Services {
            workspaces: Arc::new(crate::workspaces::WorkspaceState::load()),
            chats: Arc::new(manager),
            watch: Arc::new(crate::file_watch::FileWatchState::default()),
            git_watch: Arc::new(crate::git_watch::GitWatchState::default()),
            orchestrations: store.clone(),
            ptys: Arc::new(crate::pty::PtyManager::default()),
        };
        let commands = [
            "chat_start",
            "chat_send",
            "chat_cancel_auto_resume",
            "chat_cancel_queued",
            "chat_dismiss_unsent",
            "chat_start_queued",
            "chat_interrupt",
            "chat_set_access",
            "chat_stop",
            "chat_retarget",
            "chat_restart",
            "chat_forget",
            "chat_index_remove",
        ];
        for key in [&worker.worker_chat_key, "chat:orch-not-yet-loaded"] {
            for command in commands {
                let error = crate::dispatch::dispatch(
                    &svc,
                    command,
                    serde_json::json!({
                        "key": key, "id": key.trim_start_matches("chat:"), "recordUser": false,
                        "text": "bypass", "prompt": null,
                    }),
                )
                .unwrap_err();
                assert!(error.contains("read-only"), "{command}: {error}");
            }
        }
        assert!(
            crate::dispatch::dispatch(&svc, "orchestration_snapshot", serde_json::json!({}))
                .is_ok()
        );
        assert!(store.require_user_chat("chat:master").is_ok());
        assert!(store.require_user_chat("chat:ordinary").is_ok());

        let (_, _receiver) = svc
            .chats
            .questions
            .insert(
                crate::question_store::test_origin(&worker.worker_chat_key),
                vec![question()],
            )
            .unwrap();
        let id = svc.chats.questions.pending().unwrap()[0].id.clone();
        for command in [
            "question_answer",
            "question_answer_batch",
            "question_retry",
            "question_cancel",
        ] {
            let result = crate::dispatch::dispatch(
                &svc,
                command,
                serde_json::json!({
                    "id": id, "ids": [id], "answer": "bypass", "answers": [{"id": id, "answer": "bypass"}]
                }),
            );
            assert!(result.unwrap_err().contains("read-only"), "{command}");
        }
        assert_eq!(svc.chats.questions.pending().unwrap().len(), 1);
    }

    #[test]
    fn settlement_time_is_separate_from_later_metadata_changes() {
        let store = OrchestrationStore::default();
        let run = run(&store);
        let worker = running_worker(&store, &run);
        assert_eq!(worker.finished_at, None);
        store
            .report_worker(
                &worker.worker_chat_key,
                WorkerReport {
                    attempt_id: worker.id.clone(),
                    outcome: WorkerOutcome::Completed,
                    summary: "done".into(),
                    files_modified: Vec::new(),
                },
            )
            .unwrap();
        let finished = store.snapshot(None).unwrap().attempts[0]
            .finished_at
            .unwrap();
        let mut inner = store.inner.lock().unwrap();
        let attempt = inner.data.attempts.get_mut(&worker.id).unwrap();
        assert_eq!(finished, attempt.updated_at);
        attempt.updated_at += 100_000;
        assert!(!recover_interrupted_workers(&mut inner.data));
        assert_eq!(inner.data.attempts[&worker.id].finished_at, Some(finished));
        // Old ledgers retain their last settlement time before later metadata changes.
        let attempt = inner.data.attempts.get_mut(&worker.id).unwrap();
        attempt.finished_at = None;
        attempt.updated_at = finished;
        assert!(recover_interrupted_workers(&mut inner.data));
        assert_eq!(inner.data.attempts[&worker.id].finished_at, Some(finished));
    }

    #[test]
    fn finished_and_old_workers_remain_read_only() {
        let store = OrchestrationStore::default();
        let run = run(&store);
        let worker = running_worker(&store, &run);
        store
            .report_worker(
                &worker.worker_chat_key,
                WorkerReport {
                    attempt_id: worker.id.clone(),
                    outcome: WorkerOutcome::Completed,
                    summary: "done".into(),
                    files_modified: Vec::new(),
                },
            )
            .unwrap();
        // Legacy keys have no reserved prefix, but still belong to the ledger.
        store
            .inner
            .lock()
            .unwrap()
            .data
            .attempts
            .get_mut(&worker.id)
            .unwrap()
            .worker_chat_key = "chat:legacy-worker".into();
        assert_eq!(
            store
                .worker_coordinator("chat:legacy-worker")
                .unwrap()
                .as_deref(),
            Some("chat:master")
        );
        assert!(store
            .require_user_chat("chat:legacy-worker")
            .unwrap_err()
            .contains("read-only"));
        assert!(store
            .route_worker_questions("chat:legacy-worker", &[question()])
            .unwrap_err()
            .contains("settled"));
        assert!(store
            .create_run(
                "chat:legacy-worker".into(),
                "Nested run".into(),
                "workspace".into(),
                "/tmp".into(),
                None
            )
            .is_err());
    }

    #[test]
    fn only_coordinators_can_send_to_workers() {
        let store = OrchestrationStore::default();
        let run = run(&store);
        let worker = running_worker(&store, &run);
        let peer = running_worker(&store, &run);
        let send = |actor: &str, to: &str| {
            store.record_message(
                actor,
                run.id.clone(),
                to.into(),
                "update".into(),
                "Progress".into(),
                "Ready".into(),
            )
        };
        assert_eq!(
            send(&worker.worker_chat_key, "coordinator")
                .unwrap()
                .to_chat_key,
            "chat:master"
        );
        assert_eq!(
            send("chat:master", &worker.id).unwrap().to_chat_key,
            worker.worker_chat_key
        );
        assert!(send(&worker.worker_chat_key, &peer.id)
            .unwrap_err()
            .contains("only to their coordinator"));
        assert!(store
            .create_run(
                worker.worker_chat_key,
                "Nested".into(),
                "workspace".into(),
                "/tmp".into(),
                None
            )
            .is_err());
        assert_eq!(store.snapshot(None).unwrap().messages.len(), 2);
    }

    #[test]
    fn worker_questions_become_coordinator_gates_without_an_implied_answer() {
        let store = OrchestrationStore::default();
        let run = run(&store);
        let worker = running_worker(&store, &run);
        assert!(store
            .route_worker_questions("chat:master", &[question()])
            .unwrap()
            .is_none());
        let gate = store
            .route_worker_questions(&worker.worker_chat_key, &[question()])
            .unwrap()
            .unwrap();
        assert_eq!(gate.target_chat_key, "chat:master");
        assert_eq!(gate.task_id.as_deref(), Some(worker.task_id.as_str()));
        assert_eq!(gate.options, vec!["Keep", "Change"]);
        assert!(gate.question.contains("Keep the existing behavior"));
        assert_eq!(gate.status, GateStatus::Open);
        assert!(gate.resolution.is_none());
        assert_eq!(
            store.snapshot(None).unwrap().attempts[0].status,
            AttemptStatus::Blocked
        );
        assert!(store
            .resolve_gate(&worker.worker_chat_key, gate.id.clone(), "Keep".into())
            .is_err());
        assert_eq!(
            store
                .resolve_gate("chat:master", gate.id, "Keep".into())
                .unwrap()
                .status,
            GateStatus::Resolved
        );
        assert_eq!(
            store.snapshot(None).unwrap().attempts[0].status,
            AttemptStatus::Running
        );
    }

    #[test]
    fn stale_native_question_cannot_create_a_gate() {
        let store = Arc::new(OrchestrationStore::default());
        let run = run(&store);
        let worker = running_worker(&store, &run);
        let mut manager = ChatManager::default();
        manager.orchestrations = store.clone();
        let manager = Arc::new(manager);
        assert!(crate::agent_chat::route_worker_questions(
            &manager,
            &worker.worker_chat_key,
            Some(&worker.worker_chat_key),
            Some("expired-launch"),
            &[question()]
        )
        .unwrap_err()
        .contains("no longer running"));
        assert!(store.snapshot(None).unwrap().gates.is_empty());
        assert!(manager.questions.pending().unwrap().is_empty());
    }

    #[test]
    fn dependencies_become_ready_only_after_their_prerequisite_completes() {
        let store = OrchestrationStore::default();
        let run = run(&store);
        let first = task(&store, &run, Vec::new());
        let second = task(&store, &run, vec![first.id.clone()]);
        assert_eq!(first.status, TaskStatus::Ready);
        assert_eq!(second.status, TaskStatus::Pending);

        let launch = WorkerLaunch {
            task_id: first.id.clone(),
            agent: ChatAgent::Codex,
            model: None,
            effort: None,
            access: Access::Auto,
            new_worktree: Some(true),
            base_branch: String::new(),
        };
        let (_, _, attempt, _) = store.reserve_attempt("chat:master", &launch).unwrap();
        store
            .activate_attempt(&attempt.id, "/tmp".into(), "test".into(), true)
            .unwrap();
        store
            .report_worker(
                &attempt.worker_chat_key,
                WorkerReport {
                    attempt_id: attempt.id,
                    outcome: WorkerOutcome::Completed,
                    summary: "done".into(),
                    files_modified: vec!["a.rs".into()],
                },
            )
            .unwrap();
        let snapshot = store.snapshot(Some(&run.id)).unwrap();
        assert_eq!(
            snapshot
                .tasks
                .iter()
                .find(|task| task.id == second.id)
                .unwrap()
                .status,
            TaskStatus::Ready
        );
    }

    #[test]
    fn only_the_active_attempt_can_settle_a_task() {
        let store = OrchestrationStore::default();
        let run = run(&store);
        let task = task(&store, &run, Vec::new());
        let launch = WorkerLaunch {
            task_id: task.id,
            agent: ChatAgent::Codex,
            model: None,
            effort: None,
            access: Access::Auto,
            new_worktree: Some(true),
            base_branch: String::new(),
        };
        let (_, _, first, _) = store.reserve_attempt("chat:master", &launch).unwrap();
        store
            .fail_preparation(
                &first.id,
                "retry".into(),
                String::new(),
                String::new(),
                false,
            )
            .unwrap();
        let (_, _, second, _) = store.reserve_attempt("chat:master", &launch).unwrap();

        let error = store
            .report_worker(
                &first.worker_chat_key,
                WorkerReport {
                    attempt_id: first.id,
                    outcome: WorkerOutcome::Completed,
                    summary: "late".into(),
                    files_modified: Vec::new(),
                },
            )
            .unwrap_err();
        assert!(error.contains("stale"));
        assert_eq!(
            store.snapshot(Some(&run.id)).unwrap().tasks[0]
                .active_attempt_id
                .as_deref(),
            Some(second.id.as_str())
        );
    }

    #[test]
    fn a_worker_cannot_report_for_someone_elses_attempt() {
        let store = OrchestrationStore::default();
        let run = run(&store);
        let task = task(&store, &run, Vec::new());
        let launch = WorkerLaunch {
            task_id: task.id,
            agent: ChatAgent::Claude,
            model: None,
            effort: None,
            access: Access::Auto,
            new_worktree: Some(true),
            base_branch: String::new(),
        };
        let (_, _, attempt, _) = store.reserve_attempt("chat:master", &launch).unwrap();
        let error = store
            .report_worker(
                "chat:impostor",
                WorkerReport {
                    attempt_id: attempt.id,
                    outcome: WorkerOutcome::Completed,
                    summary: "not mine".into(),
                    files_modified: Vec::new(),
                },
            )
            .unwrap_err();
        assert!(error.contains("does not own"));
    }

    #[test]
    fn a_reported_block_can_be_retried_but_an_open_gate_cannot() {
        let store = OrchestrationStore::default();
        let run = run(&store);
        let task = task(&store, &run, Vec::new());
        let launch = WorkerLaunch {
            task_id: task.id.clone(),
            agent: ChatAgent::Codex,
            model: None,
            effort: None,
            access: Access::Auto,
            new_worktree: Some(true),
            base_branch: String::new(),
        };
        let (_, _, first, _) = store.reserve_attempt("chat:master", &launch).unwrap();
        store
            .activate_attempt(&first.id, "/tmp".into(), "first".into(), true)
            .unwrap();
        store
            .report_worker(
                &first.worker_chat_key,
                WorkerReport {
                    attempt_id: first.id.clone(),
                    outcome: WorkerOutcome::Blocked,
                    summary: "needs a different approach".into(),
                    files_modified: Vec::new(),
                },
            )
            .unwrap();
        let second_report = store
            .report_worker(
                &first.worker_chat_key,
                WorkerReport {
                    attempt_id: first.id.clone(),
                    outcome: WorkerOutcome::Completed,
                    summary: "late completion".into(),
                    files_modified: Vec::new(),
                },
            )
            .unwrap_err();
        assert!(second_report.contains("already settled"), "{second_report}");

        let message_error = store
            .record_message(
                "chat:master",
                run.id.clone(),
                first.id.clone(),
                "instruction".into(),
                "Continue".into(),
                "Continue the run.".into(),
            )
            .unwrap_err();
        assert!(message_error.contains("Start a retry"), "{message_error}");
        assert!(store.snapshot(Some(&run.id)).unwrap().messages.is_empty());

        let (_, _, second, previous) = store.reserve_attempt("chat:master", &launch).unwrap();
        assert_ne!(first.id, second.id);
        let previous = previous.expect("the retry keeps its predecessor context");
        assert_eq!(previous.cwd, "/tmp");
        assert_eq!(previous.branch, "first");
        assert!(previous.is_worktree);
        assert_eq!(
            store
                .snapshot(Some(&run.id))
                .unwrap()
                .attempts
                .iter()
                .find(|attempt| attempt.id == first.id)
                .unwrap()
                .status,
            AttemptStatus::Cancelled
        );

        store
            .activate_attempt(&second.id, "/tmp".into(), "second".into(), true)
            .unwrap();
        store
            .create_gate(
                &second.worker_chat_key,
                run.id.clone(),
                Some(task.id),
                "Which API?".into(),
                vec!["A".into(), "B".into()],
            )
            .unwrap();
        assert!(store
            .reserve_attempt("chat:master", &launch)
            .unwrap_err()
            .contains("decision gate"));
        let gate_message_error = store
            .record_message(
                "chat:master",
                run.id,
                second.id,
                "instruction".into(),
                "Continue".into(),
                "Continue the run.".into(),
            )
            .unwrap_err();
        assert!(
            gate_message_error.contains("Resolve that gate"),
            "{gate_message_error}"
        );
    }

    #[test]
    fn a_settled_block_does_not_consume_a_concurrency_slot() {
        let store = OrchestrationStore::default();
        let run = store
            .create_run(
                "chat:master".into(),
                "Ship the feature".into(),
                "workspace".into(),
                "/tmp".into(),
                Some(1),
            )
            .unwrap();
        let first_task = task(&store, &run, Vec::new());
        let second_task = task(&store, &run, Vec::new());
        let mut launch = WorkerLaunch {
            task_id: first_task.id,
            agent: ChatAgent::Codex,
            model: None,
            effort: None,
            access: Access::Auto,
            new_worktree: Some(true),
            base_branch: String::new(),
        };
        let (_, _, first, _) = store.reserve_attempt("chat:master", &launch).unwrap();
        store
            .activate_attempt(&first.id, "/tmp".into(), "first".into(), true)
            .unwrap();
        store
            .report_worker(
                &first.worker_chat_key,
                WorkerReport {
                    attempt_id: first.id,
                    outcome: WorkerOutcome::Blocked,
                    summary: "blocked".into(),
                    files_modified: Vec::new(),
                },
            )
            .unwrap();

        launch.task_id = second_task.id;
        store.reserve_attempt("chat:master", &launch).unwrap();
    }

    #[test]
    fn unreadable_state_is_never_overwritten_by_a_new_run() {
        let root = std::env::temp_dir().join(format!("octiq-orchestration-{}", compact_id()));
        fs::create_dir_all(&root).unwrap();
        let file = root.join("orchestrations.json");
        fs::write(&file, b"not json").unwrap();
        let store = OrchestrationStore::load(file.clone());
        assert!(store
            .create_run(
                "chat:master".into(),
                "objective".into(),
                "workspace".into(),
                "/tmp".into(),
                None,
            )
            .is_err());
        assert_eq!(fs::read(&file).unwrap(), b"not json");
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn pending_safety_card_keeps_its_worker_attempt_resumable() {
        let store = OrchestrationStore::default();
        let run = run(&store);
        let task = task(&store, &run, Vec::new());
        let launch = WorkerLaunch {
            task_id: task.id,
            agent: ChatAgent::Codex,
            model: None,
            effort: None,
            access: Access::Auto,
            new_worktree: Some(true),
            base_branch: String::new(),
        };
        let (_, _, attempt, _) = store.reserve_attempt("chat:master", &launch).unwrap();
        store
            .activate_attempt(&attempt.id, "/tmp".into(), "worker".into(), true)
            .unwrap();
        crate::safety_block::observe(ChatAgent::Codex, &attempt.worker_chat_key,
            "codex_core::tools::router: error=This action was rejected due to unacceptable risk.\\nReason: Upload requires a decision.");
        let result = store.report_worker(
            &attempt.worker_chat_key,
            WorkerReport {
                attempt_id: attempt.id.clone(),
                outcome: WorkerOutcome::Blocked,
                summary: "Waiting for upload decision".into(),
                files_modified: vec![],
            },
        );
        crate::safety_block::forget_chat(&attempt.worker_chat_key);
        assert!(result.unwrap_err().contains("safety"));
        assert_eq!(
            store.snapshot(Some(&run.id)).unwrap().attempts[0].status,
            AttemptStatus::Running
        );
    }

    #[test]
    fn active_workers_become_retriable_after_a_server_restart() {
        let root = std::env::temp_dir().join(format!("octiq-orchestration-{}", compact_id()));
        fs::create_dir_all(&root).unwrap();
        let file = root.join("orchestrations.json");
        let store = OrchestrationStore::load(file.clone());
        let run = run(&store);
        let task = task(&store, &run, Vec::new());
        let launch = WorkerLaunch {
            task_id: task.id.clone(),
            agent: ChatAgent::Codex,
            model: None,
            effort: None,
            access: Access::Auto,
            new_worktree: Some(true),
            base_branch: String::new(),
        };
        let (_, _, attempt, _) = store.reserve_attempt("chat:master", &launch).unwrap();
        store
            .activate_attempt(&attempt.id, "/tmp".into(), "worker".into(), true)
            .unwrap();
        drop(store);

        let restored = OrchestrationStore::load(file);
        let snapshot = restored.snapshot(Some(&run.id)).unwrap();
        assert_eq!(snapshot.attempts[0].status, AttemptStatus::Failed);
        assert_eq!(snapshot.tasks[0].status, TaskStatus::Failed);
        assert_eq!(snapshot.runs[0].status, RunStatus::Failed);
        restored.reserve_attempt("chat:master", &launch).unwrap();
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn a_reported_block_stays_settled_after_a_server_restart() {
        let root = std::env::temp_dir().join(format!("octiq-orchestration-{}", compact_id()));
        fs::create_dir_all(&root).unwrap();
        let file = root.join("orchestrations.json");
        let store = OrchestrationStore::load(file.clone());
        let run = run(&store);
        let task = task(&store, &run, Vec::new());
        let launch = WorkerLaunch {
            task_id: task.id,
            agent: ChatAgent::Codex,
            model: None,
            effort: None,
            access: Access::Auto,
            new_worktree: Some(true),
            base_branch: String::new(),
        };
        let (_, _, attempt, _) = store.reserve_attempt("chat:master", &launch).unwrap();
        store
            .activate_attempt(&attempt.id, "/tmp".into(), "worker".into(), true)
            .unwrap();
        store
            .report_worker(
                &attempt.worker_chat_key,
                WorkerReport {
                    attempt_id: attempt.id,
                    outcome: WorkerOutcome::Blocked,
                    summary: "blocked".into(),
                    files_modified: Vec::new(),
                },
            )
            .unwrap();
        drop(store);

        let restored = OrchestrationStore::load(file);
        let snapshot = restored.snapshot(Some(&run.id)).unwrap();
        assert_eq!(snapshot.attempts[0].status, AttemptStatus::Blocked);
        assert_eq!(snapshot.tasks[0].status, TaskStatus::Blocked);
        assert_eq!(snapshot.runs[0].status, RunStatus::Waiting);
        let _ = fs::remove_dir_all(root);
    }
}
