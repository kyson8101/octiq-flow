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

const STORE_VERSION: u32 = 1;
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
    pub created_at: i64,
    pub updated_at: i64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub stopped_reason: Option<String>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Task {
    pub id: String,
    pub run_id: String,
    pub title: String,
    pub spec: String,
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
    pub cwd: String,
    #[serde(default)]
    pub branch: String,
    #[serde(default)]
    pub is_worktree: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub summary: Option<String>,
    #[serde(default)]
    pub files_modified: Vec<String>,
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
}

#[derive(Clone, Debug)]
pub struct WorkerLaunch {
    pub task_id: String,
    pub agent: ChatAgent,
    pub model: Option<String>,
    pub effort: Option<String>,
    pub access: Access,
    pub new_worktree: bool,
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
        }
    }
}

impl OrchestrationStore {
    pub fn load(path: PathBuf) -> Self {
        let mut inner = Inner::default();
        let mut recovered = false;
        match fs::read(&path) {
            Ok(bytes) => match serde_json::from_slice::<Stored>(&bytes) {
                Ok(mut data) if data.version == STORE_VERSION => {
                    recovered = recover_interrupted_workers(&mut data);
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
        let visible: BTreeSet<_> = runs.iter().map(|run| run.id.as_str()).collect();

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
        Ok(Snapshot {
            runs,
            tasks,
            attempts,
            gates,
            messages,
        })
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

    pub fn create_run(
        &self,
        actor_chat_key: String,
        objective: String,
        workspace_id: String,
        root_path: String,
        max_concurrent: Option<u16>,
    ) -> Result<Run, String> {
        validate_chat_key(&actor_chat_key)?;
        let objective = required_text("objective", objective, 40_000)?;
        let workspace_id = required_text("workspace", workspace_id, 256)?;
        let root_path = required_text("workspace path", root_path, 8_192)?;
        let max_concurrent = max_concurrent
            .unwrap_or(DEFAULT_MAX_CONCURRENT)
            .clamp(1, MAX_CONCURRENT);
        let now = now_ms();
        let run = Run {
            id: format!("run_{}", compact_id()),
            objective,
            coordinator_chat_key: actor_chat_key,
            workspace_id,
            root_path,
            status: RunStatus::Planning,
            max_concurrent,
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

    pub fn create_task(
        &self,
        actor_chat_key: &str,
        run_id: String,
        title: String,
        spec: String,
        depends_on: Vec<String>,
        parent_task_id: Option<String>,
    ) -> Result<Task, String> {
        let title = required_text("task title", title, 240)?;
        let spec = required_text("task spec", spec, 40_000)?;
        let run_id_for_event = run_id.clone();
        self.mutate(|data| {
            coordinator(data, &run_id, actor_chat_key)?;
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
            data.tasks.insert(task.id.clone(), task);
            if let Some(run) = data.runs.get_mut(&run_id) {
                run.status = RunStatus::Running;
                run.updated_at = now;
            }
            Ok(created)
        })
        .inspect(|_| announce(&run_id_for_event, "task_created"))
    }

    fn reserve_attempt(
        &self,
        actor_chat_key: &str,
        launch: &WorkerLaunch,
    ) -> Result<(Run, Task, Attempt), String> {
        self.mutate(|data| {
            let task = data
                .tasks
                .get(&launch.task_id)
                .cloned()
                .ok_or("The task does not exist.")?;
            let run = coordinator(data, &task.run_id, actor_chat_key)?.clone();
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
            if let Some(active_id) = task.active_attempt_id.as_deref() {
                let active_status = data.attempts.get(active_id).map(|attempt| attempt.status);
                let has_open_gate = data.gates.values().any(|gate| {
                    gate.task_id.as_deref() == Some(task.id.as_str())
                        && gate.status == GateStatus::Open
                });
                match active_status {
                    Some(AttemptStatus::Preparing | AttemptStatus::Running) => {
                        return Err("This task already has an active worker.".into())
                    }
                    Some(AttemptStatus::Blocked) if has_open_gate => {
                        return Err("This task is waiting for its open decision gate.".into())
                    }
                    Some(AttemptStatus::Blocked) => {
                        if let Some(previous) = data.attempts.get_mut(active_id) {
                            previous.status = AttemptStatus::Cancelled;
                            previous.updated_at = now_ms();
                        }
                    }
                    _ => {}
                }
            }
            let active = data
                .attempts
                .values()
                .filter(|attempt| {
                    attempt.run_id == run.id
                        && matches!(
                            attempt.status,
                            AttemptStatus::Preparing
                                | AttemptStatus::Running
                                | AttemptStatus::Blocked
                        )
                })
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
            let attempt = Attempt {
                id: id.clone(),
                run_id: run.id.clone(),
                task_id: task.id.clone(),
                number,
                worker_chat_key: format!("chat:orch-{}", compact_id()),
                agent: launch.agent,
                model: launch.model.clone(),
                effort: launch.effort.clone(),
                access: launch.access,
                status: AttemptStatus::Preparing,
                cwd: String::new(),
                branch: String::new(),
                is_worktree: false,
                summary: None,
                files_modified: Vec::new(),
                created_at: now,
                updated_at: now,
            };
            data.attempts.insert(id.clone(), attempt.clone());
            let reserved_task = data
                .tasks
                .get_mut(&task.id)
                .expect("the task was read above");
            reserved_task.status = TaskStatus::Running;
            reserved_task.active_attempt_id = Some(id);
            reserved_task.result = None;
            reserved_task.updated_at = now;
            let active_run = data.runs.get_mut(&run.id).expect("the run was read above");
            active_run.status = RunStatus::Running;
            active_run.updated_at = now;
            Ok((run, reserved_task.clone(), attempt))
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
        self.mutate(|data| {
            let now = now_ms();
            let (task_id, run_id) = {
                let attempt = data
                    .attempts
                    .get_mut(attempt_id)
                    .ok_or("The reserved worker attempt disappeared.")?;
                attempt.status = AttemptStatus::Failed;
                attempt.summary = Some(reason.clone());
                attempt.cwd = cwd;
                attempt.branch = branch;
                attempt.is_worktree = is_worktree;
                attempt.updated_at = now;
                (attempt.task_id.clone(), attempt.run_id.clone())
            };
            if let Some(task) = data.tasks.get_mut(&task_id) {
                if task.active_attempt_id.as_deref() == Some(attempt_id) {
                    task.status = TaskStatus::Failed;
                    task.result = Some(reason);
                    task.updated_at = now;
                }
            }
            recompute_run(data, &run_id);
            Ok(())
        })
    }

    pub fn start_worker(
        &self,
        chats: Arc<ChatManager>,
        workspaces: &WorkspaceState,
        actor_chat_key: &str,
        launch: WorkerLaunch,
    ) -> Result<Attempt, String> {
        if launch.agent == ChatAgent::Pi {
            return Err(
                "pi.dev does not yet expose OctiqFlow's worker completion tools; choose Claude or Codex."
                    .into(),
            );
        }
        let (run, task, reserved) = self.reserve_attempt(actor_chat_key, &launch)?;
        announce(&run.id, "worker_preparing");
        let workspace = workspace(workspaces, &run.workspace_id)?;
        let prepared = if launch.new_worktree {
            crate::git_ops::git_prepare_chat_workspace(
                run.root_path.clone(),
                launch.base_branch.clone(),
                true,
                task.title.clone(),
                reserved.id.clone(),
            )
        } else {
            Ok(crate::git_ops::PreparedWorkspace {
                cwd: run.root_path.clone(),
                branch: launch.base_branch.clone(),
                is_repo: Path::new(&run.root_path).join(".git").exists(),
                is_worktree: false,
            })
        };
        let prepared = match prepared {
            Ok(prepared) => prepared,
            Err(error) => {
                let _ = self.fail_preparation(
                    &reserved.id,
                    error.clone(),
                    String::new(),
                    String::new(),
                    false,
                );
                announce(&run.id, "worker_failed");
                return Err(error);
            }
        };

        let chat_id = reserved
            .worker_chat_key
            .strip_prefix("chat:")
            .unwrap_or(&reserved.worker_chat_key)
            .to_string();
        let now = now_ms();
        let meta = crate::chat_index::ChatMeta {
            id: chat_id.clone(),
            project_id: run.workspace_id.clone(),
            title: format!("Worker: {}", task.title),
            latest_response: None,
            custom_title: true,
            session_id: None,
            cwd: Some(prepared.cwd.clone()),
            model_id: Some(model_id(launch.agent, launch.model.as_deref())),
            access: Some(access_id(launch.access).into()),
            created_at: now,
            updated_at: now,
            read_at: None,
            pinned: false,
            deleted_at: None,
            generation: 0,
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

        let prompt = worker_prompt(&run, &task, &reserved);
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
        if let Err(error) = start {
            let _ = crate::agent_chat::chat_index_remove(
                chat_id,
                reserved.worker_chat_key.clone(),
                None,
                Some(meta),
            );
            let _ = self.fail_preparation(
                &reserved.id,
                error.clone(),
                prepared.cwd,
                prepared.branch,
                prepared.is_worktree,
            );
            announce(&run.id, "worker_failed");
            return Err(error);
        }

        match self.activate_attempt(
            &reserved.id,
            prepared.cwd,
            prepared.branch,
            prepared.is_worktree,
        ) {
            Ok(attempt) => {
                announce(&run.id, "worker_started");
                Ok(attempt)
            }
            Err(error) => {
                let _ = crate::agent_chat::chat_stop_impl(&chats, reserved.worker_chat_key);
                Err(error)
            }
        }
    }

    pub fn report_worker(
        &self,
        actor_chat_key: &str,
        report: WorkerReport,
    ) -> Result<Task, String> {
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
                AttemptStatus::Preparing | AttemptStatus::Running | AttemptStatus::Blocked
            ) {
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

            let task_mut = data
                .tasks
                .get_mut(&attempt.task_id)
                .expect("the task was read above");
            task_mut.status = match report.outcome {
                WorkerOutcome::Completed => TaskStatus::Completed,
                WorkerOutcome::Failed => TaskStatus::Failed,
                WorkerOutcome::Blocked => TaskStatus::Blocked,
            };
            task_mut.result = Some(summary);
            task_mut.updated_at = now;
            let settled = task_mut.clone();
            event_run_id = task_mut.run_id.clone();
            make_ready(data, &attempt.run_id);
            recompute_run(data, &attempt.run_id);
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
                    attempt.updated_at = now;
                }
            }
            if let Some(run) = data.runs.get_mut(&run_id) {
                run.status = RunStatus::Waiting;
                run.updated_at = now;
            }
            data.gates.insert(gate.id.clone(), gate.clone());
            Ok(gate)
        })
        .inspect(|_| announce(&run_id_for_event, "gate_created"))
    }

    pub fn resolve_gate(
        &self,
        actor_chat_key: &str,
        gate_id: String,
        resolution: String,
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
                        attempt.updated_at = now;
                    }
                }
            }
            event_run_id = run_id.clone();
            recompute_run(data, &run_id);
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
        let reason = required_text("stop reason", reason, 2_000)?;
        let run_id_for_event = run_id.clone();
        self.mutate(|data| {
            coordinator(data, &run_id, actor_chat_key)?;
            let now = now_ms();
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
                if matches!(
                    attempt.status,
                    AttemptStatus::Preparing | AttemptStatus::Running | AttemptStatus::Blocked
                ) {
                    attempt.status = AttemptStatus::Cancelled;
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
    let workspace_id = workspace_id
        .filter(|id| !id.trim().is_empty())
        .or_else(|| meta.as_ref().map(|meta| meta.project_id.clone()))
        .ok_or("The coordinator chat is not attached to a project.")?;
    let workspace = workspace(workspaces, &workspace_id)?;
    let root_path = root_path
        .filter(|path| !path.trim().is_empty())
        .or_else(|| meta.and_then(|meta| meta.cwd))
        .unwrap_or_else(|| workspace.primary_path.clone());
    if !Path::new(&root_path).is_dir() {
        return Err("The coordinator's project folder does not exist.".into());
    }
    Ok((workspace_id, root_path))
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
                && matches!(
                    attempt.status,
                    AttemptStatus::Preparing | AttemptStatus::Running | AttemptStatus::Blocked
                )
        })
        .and_then(|attempt| data.tasks.get(&attempt.task_id))
        .cloned()
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
}

/// Agent processes are children of the server and cannot survive its restart.
/// Persisted active attempts therefore become failed attempts on load rather
/// than "ghost" workers that hold a task and concurrency slot forever.
fn recover_interrupted_workers(data: &mut Stored) -> bool {
    let now = now_ms();
    let mut recovered = BTreeMap::new();
    for attempt in data.attempts.values_mut() {
        if !matches!(
            attempt.status,
            AttemptStatus::Preparing | AttemptStatus::Running | AttemptStatus::Blocked
        ) {
            continue;
        }
        attempt.status = AttemptStatus::Failed;
        attempt.summary =
            Some("Worker was interrupted when OctiqFlow restarted. Start a new attempt.".into());
        attempt.updated_at = now;
        recovered.insert(
            attempt.task_id.clone(),
            (attempt.id.clone(), attempt.run_id.clone()),
        );
    }
    if recovered.is_empty() {
        return false;
    }
    let mut run_ids = BTreeSet::new();
    for (task_id, (attempt_id, run_id)) in recovered {
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
    format!(
        "You are an OctiqFlow orchestration worker. This dispatch is authoritative only for the identifiers below.\n\nRun: {}\nTask: {}\nAttempt: {}\nObjective: {}\n\nYour task\nTitle: {}\n{}\n\nWork only on this task in the provided workspace. Communicate only with your coordinator: use orchestration_message_send with to=coordinator. The person can inspect this chat but sends all instructions through the main chat. Do not ask the person directly, message other workers, or create a run. If a decision blocks you, call orchestration_gate_create for this run and task, then end your turn. When the task settles, call orchestration_worker_report exactly once with attemptId '{}', an outcome of completed, failed, or blocked, a concise summary, and the files you changed. A normal prose answer does not complete the task in OctiqFlow.",
        run.id,
        task.id,
        attempt.id,
        run.objective,
        task.title,
        task.spec,
        attempt.id
    )
}

pub fn master_prompt(run: &Run) -> String {
    format!(
        "OctiqFlow created orchestration run {} and assigned this chat as its master.\n\nObjective\n{}\n\nTreat the host orchestration state as authoritative. Start by creating a shallow task DAG with orchestration_task_create. Dispatch the full ready wave up to the run's concurrency limit ({}) before waiting, using a new worktree for each code task by default. Re-read orchestration_snapshot after worker reports or decisions. Use orchestration_message_send for directed coordination and orchestration_gate_create only for a decision that truly needs the person. Do not claim the run is complete until every required task is completed in the snapshot. A worker's prose does not settle a task; its orchestration_worker_report does.",
        run.id, run.objective, run.max_concurrent
    )
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

    fn run(store: &OrchestrationStore) -> Run {
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

    fn task(store: &OrchestrationStore, run: &Run, depends_on: Vec<String>) -> Task {
        store
            .create_task(
                "chat:master",
                run.id.clone(),
                "Implement".into(),
                "Make the requested change".into(),
                depends_on,
                None,
            )
            .unwrap()
    }

    fn running_worker(store: &OrchestrationStore, run: &Run) -> Attempt {
        let task = task(store, run, Vec::new());
        let (_, _, attempt) = store
            .reserve_attempt(
                "chat:master",
                &WorkerLaunch {
                    task_id: task.id,
                    agent: ChatAgent::Codex,
                    model: None,
                    effort: None,
                    access: Access::Auto,
                    new_worktree: true,
                    base_branch: String::new(),
                },
            )
            .unwrap();
        store
            .activate_attempt(&attempt.id, "/tmp".into(), "test".into(), true)
            .unwrap()
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
            new_worktree: true,
            base_branch: String::new(),
        };
        let (_, _, attempt) = store.reserve_attempt("chat:master", &launch).unwrap();
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
            new_worktree: true,
            base_branch: String::new(),
        };
        let (_, _, first) = store.reserve_attempt("chat:master", &launch).unwrap();
        store
            .fail_preparation(
                &first.id,
                "retry".into(),
                String::new(),
                String::new(),
                false,
            )
            .unwrap();
        let (_, _, second) = store.reserve_attempt("chat:master", &launch).unwrap();

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
            new_worktree: true,
            base_branch: String::new(),
        };
        let (_, _, attempt) = store.reserve_attempt("chat:master", &launch).unwrap();
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
            new_worktree: true,
            base_branch: String::new(),
        };
        let (_, _, first) = store.reserve_attempt("chat:master", &launch).unwrap();
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
        let (_, _, second) = store.reserve_attempt("chat:master", &launch).unwrap();
        assert_ne!(first.id, second.id);
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
                run.id,
                Some(task.id),
                "Which API?".into(),
                vec!["A".into(), "B".into()],
            )
            .unwrap();
        assert!(store
            .reserve_attempt("chat:master", &launch)
            .unwrap_err()
            .contains("decision gate"));
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
            new_worktree: true,
            base_branch: String::new(),
        };
        let (_, _, attempt) = store.reserve_attempt("chat:master", &launch).unwrap();
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
}
