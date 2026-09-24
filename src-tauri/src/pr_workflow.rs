//! Durable links between a GitHub pull request, its originating chat, and an
//! optional ticket-completion chat.
//!
//! GitHub remains the authority for PR state. Callers pass [`PrObservation`]
//! values built from a fresh backend-owned GitHub lookup; no browser command
//! accepts `state` or `approved`. This module only persists the link and the
//! consequences of trusted observations.

use std::collections::{BTreeMap, BTreeSet};
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use serde::{Deserialize, Serialize};
use uuid::Uuid;

const STORE_VERSION: u32 = 1;
const STORE_FILE: &str = "pr-workflows.json";

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PrTicketLink {
    pub reference: String,
    #[serde(default)]
    pub url: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PrTicketAction {
    pub id: String,
    pub head_sha: String,
    pub status: String,
    #[serde(default)]
    pub chat_id: Option<String>,
    pub message: String,
    pub updated_at: i64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PrCompletion {
    pub state: String,
    pub trigger: String,
    pub head_sha: String,
    #[serde(default)]
    pub completed_at: Option<i64>,
    pub note: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PrWorkflow {
    pub root: String,
    pub number: u64,
    pub url: String,
    pub head_sha: String,
    pub base_sha: String,
    #[serde(default)]
    pub chat_id: Option<String>,
    #[serde(default)]
    pub ticket: Option<PrTicketLink>,
    pub complete_on: String,
    pub completion: PrCompletion,
    #[serde(default)]
    pub ticket_action: Option<PrTicketAction>,
    pub updated_at: i64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PrChatCompletion {
    pub root: String,
    pub number: u64,
    pub url: String,
    pub head_sha: String,
    pub trigger: String,
    pub completed_at: i64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PrTicketLaunch {
    pub workflow: PrWorkflow,
    pub action_id: String,
    pub prompt: String,
    pub cwd: String,
    pub title: String,
}

/// Fresh PR evidence obtained by backend code, never directly from a browser.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PrObservation {
    pub root: String,
    pub number: u64,
    pub url: String,
    pub head_sha: String,
    pub base_sha: String,
    pub state: String,
    pub approved: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct StoredAction {
    root: String,
    number: u64,
    action: PrTicketAction,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Store {
    version: u32,
    #[serde(default)]
    workflows: BTreeMap<String, PrWorkflow>,
    /// Every action is retained, including actions superseded by a new head or
    /// a retry. `PrWorkflow.ticket_action` is only the action for its current
    /// head and ticket.
    #[serde(default)]
    actions: BTreeMap<String, StoredAction>,
}

impl Default for Store {
    fn default() -> Self {
        Self {
            version: STORE_VERSION,
            workflows: BTreeMap::new(),
            actions: BTreeMap::new(),
        }
    }
}

/// Serialises every read-modify-write. Atomic rename protects readers from a
/// torn file; the mutex protects writers from losing one another's updates.
static LOCK: Mutex<()> = Mutex::new(());

fn store_path() -> Result<PathBuf, String> {
    crate::transcript::chats_dir()
        .map(|dir| dir.join(STORE_FILE))
        .ok_or_else(|| "Could not find the profile chats folder.".to_string())
}

fn workflow_key(root: &str, number: u64) -> String {
    // NUL cannot occur in a filesystem path and serde_json escapes it. Keeping
    // the number first avoids ambiguous string concatenation without changing
    // the public schema.
    format!("{number}\0{root}")
}

fn read_store(path: &Path) -> Result<Store, String> {
    let raw = match fs::read(path) {
        Ok(raw) => raw,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(Store::default()),
        Err(error) => return Err(format!("Could not read PR workflows: {error}")),
    };
    let store: Store = serde_json::from_slice(&raw)
        .map_err(|error| format!("Saved PR workflows could not be read: {error}"))?;
    if store.version != STORE_VERSION {
        return Err(format!(
            "Saved PR workflows use unsupported version {}.",
            store.version
        ));
    }
    Ok(store)
}

fn read() -> Result<Store, String> {
    read_store(&store_path()?)
}

fn write_store(path: &Path, store: &Store) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    }
    let bytes = serde_json::to_vec_pretty(store).map_err(|error| error.to_string())?;
    let name = path
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or(STORE_FILE);
    let temp = path.with_file_name(format!(".{name}.{}.tmp", Uuid::new_v4().simple()));
    fs::write(&temp, bytes).map_err(|error| error.to_string())?;
    if let Err(error) = fs::rename(&temp, path) {
        let _ = fs::remove_file(&temp);
        return Err(error.to_string());
    }
    Ok(())
}

fn write(store: &Store) -> Result<(), String> {
    write_store(&store_path()?, store)
}

fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|duration| duration.as_millis().min(i64::MAX as u128) as i64)
        .unwrap_or(0)
}

fn clean_observation(mut observation: PrObservation) -> Result<PrObservation, String> {
    observation.root = observation.root.trim().to_string();
    observation.url = observation.url.trim().to_string();
    observation.head_sha = observation.head_sha.trim().to_string();
    observation.base_sha = observation.base_sha.trim().to_string();
    observation.state = observation.state.trim().to_ascii_lowercase();
    if observation.root.is_empty()
        || observation.url.is_empty()
        || observation.head_sha.is_empty()
        || observation.base_sha.is_empty()
        || observation.number == 0
    {
        return Err("A PR observation needs a root, number, URL, head SHA, and base SHA.".into());
    }
    pr_repository_identity(&observation.url, observation.number)?;
    Ok(observation)
}

/// Return the repository identity carried by a canonical GitHub pull-request
/// URL. GitHub owner and repository names are case-insensitive, while the host
/// remains part of the identity so GitHub Enterprise repositories cannot be
/// confused with github.com (or with one another).
fn pr_repository_identity(url: &str, number: u64) -> Result<String, String> {
    let without_suffix = url
        .split(['?', '#'])
        .next()
        .unwrap_or_default()
        .trim_end_matches('/');
    let (_, location) = without_suffix
        .split_once("://")
        .ok_or_else(|| format!("The observed URL does not identify GitHub PR #{number}."))?;
    let parts: Vec<_> = location
        .split('/')
        .filter(|part| !part.is_empty())
        .collect();
    if parts.len() < 5
        || !parts[3].eq_ignore_ascii_case("pull")
        || parts[4].parse::<u64>().ok() != Some(number)
    {
        return Err(format!(
            "The observed URL does not identify GitHub PR #{number}."
        ));
    }

    Ok(format!(
        "{}/{}/{}",
        parts[0].to_ascii_lowercase(),
        parts[1].to_ascii_lowercase(),
        parts[2]
            .strip_suffix(".git")
            .unwrap_or(parts[2])
            .to_ascii_lowercase()
    ))
}

fn require_same_repository(
    workflow: &PrWorkflow,
    observation: &PrObservation,
) -> Result<(), String> {
    let saved = pr_repository_identity(&workflow.url, workflow.number)?;
    let observed = pr_repository_identity(&observation.url, observation.number)?;
    if saved != observed {
        return Err(
            "The observed PR belongs to a different GitHub repository than the saved workflow; the existing links and action history were preserved."
                .into(),
        );
    }
    Ok(())
}

fn clean_root(root: String, number: u64) -> Result<(String, u64), String> {
    let root = root.trim().to_string();
    if root.is_empty() || number == 0 {
        return Err("A PR workflow needs a repository root and PR number.".into());
    }
    Ok((root, number))
}

fn clean_trigger(trigger: String) -> Result<String, String> {
    match trigger.trim() {
        "approved" => Ok("approved".into()),
        "merged" => Ok("merged".into()),
        _ => Err("completeOn must be either 'approved' or 'merged'.".into()),
    }
}

fn clean_ticket(ticket: Option<PrTicketLink>) -> Result<Option<PrTicketLink>, String> {
    let Some(ticket) = ticket else {
        return Ok(None);
    };
    let reference = ticket.reference.trim().to_string();
    if reference.is_empty() {
        return Err("A linked ticket needs a reference.".into());
    }
    Ok(Some(PrTicketLink {
        reference,
        url: ticket
            .url
            .map(|url| url.trim().to_string())
            .filter(|url| !url.is_empty()),
    }))
}

fn clean_chat(chat_id: Option<String>, root: &str) -> Result<Option<String>, String> {
    let Some(chat_id) = chat_id else {
        return Ok(None);
    };
    let chat_id = chat_id.trim().to_string();
    if chat_id.is_empty() {
        return Err("A linked chat ID cannot be empty.".into());
    }
    validate_chat(&chat_id, root)?;
    Ok(Some(chat_id))
}

fn validate_chat(chat_id: &str, root: &str) -> Result<(), String> {
    let chat = crate::chat_index::list()
        .into_iter()
        .find(|chat| chat.id == chat_id)
        .ok_or_else(|| format!("Chat '{chat_id}' does not exist."))?;

    if chat_id.starts_with("orch-") || is_recorded_worker(chat_id)? {
        return Err("Orchestration worker chats cannot be linked to a PR workflow.".into());
    }

    if let Some(project_id) = project_for_root(root) {
        if !chat.project_id.is_empty() && chat.project_id != project_id {
            return Err("The linked chat belongs to a different project.".into());
        }
    }
    Ok(())
}

/// Read the orchestration ledger without constructing an `OrchestrationStore`:
/// loading that store performs interruption recovery, while validation must be
/// read-only and preserve host-owned delivery state.
fn is_recorded_worker(chat_id: &str) -> Result<bool, String> {
    let path = crate::profile::profile_dir().join("orchestrations.json");
    let raw = match fs::read(&path) {
        Ok(raw) => raw,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(false),
        Err(error) => return Err(format!("Could not validate the linked chat: {error}")),
    };
    let value: serde_json::Value = serde_json::from_slice(&raw)
        .map_err(|error| format!("Could not validate the linked chat: {error}"))?;
    let worker_key = format!("chat:{chat_id}");
    Ok(value
        .get("attempts")
        .and_then(serde_json::Value::as_object)
        .is_some_and(|attempts| {
            attempts.values().any(|attempt| {
                attempt
                    .get("workerChatKey")
                    .and_then(serde_json::Value::as_str)
                    == Some(worker_key.as_str())
            })
        }))
}

/// Infer a repository's project only when the workspace store gives one
/// unambiguous answer. The dispatch layer can enforce stronger context when a
/// repository is shared by several projects.
fn project_for_root(root: &str) -> Option<String> {
    let wanted = fs::canonicalize(root).ok()?;
    let state = crate::workspaces::WorkspaceState::load();
    let workspaces = crate::workspaces::list_workspaces_impl(&state).ok()?;
    let mut matching = BTreeSet::new();
    for workspace in workspaces {
        let paths = std::iter::once(workspace.primary_path.as_str())
            .chain(workspace.paths.iter().map(String::as_str));
        if paths.filter(|path| !path.trim().is_empty()).any(|path| {
            fs::canonicalize(path).ok().is_some_and(|candidate| {
                candidate == wanted
                    || candidate.starts_with(&wanted)
                    || wanted.starts_with(&candidate)
            })
        }) {
            matching.insert(workspace.id);
        }
    }
    (matching.len() == 1).then(|| matching.into_iter().next().unwrap())
}

fn pending_completion(trigger: &str, head: &str, base: &str) -> PrCompletion {
    PrCompletion {
        state: "pending".into(),
        trigger: trigger.into(),
        head_sha: head.into(),
        completed_at: None,
        note: format!(
            "Waiting for {} on head {} against base {}.",
            if trigger == "approved" {
                "approval"
            } else {
                "merge"
            },
            short(head),
            short(base)
        ),
    }
}

fn eligible(observation: &PrObservation, trigger: &str) -> bool {
    match trigger {
        "approved" => observation.approved,
        "merged" => observation.state == "merged",
        _ => false,
    }
}

fn apply_evidence(
    workflow: &mut PrWorkflow,
    observation: &PrObservation,
    allow_completion_after_snapshot_change: bool,
) -> bool {
    let before = workflow.clone();
    let snapshot_changed =
        workflow.head_sha != observation.head_sha || workflow.base_sha != observation.base_sha;
    workflow.url = observation.url.clone();
    workflow.head_sha = observation.head_sha.clone();
    workflow.base_sha = observation.base_sha.clone();

    if snapshot_changed {
        workflow.completion = pending_completion(
            &workflow.complete_on,
            &workflow.head_sha,
            &workflow.base_sha,
        );
        workflow.ticket_action = None;
    }

    if !snapshot_changed || allow_completion_after_snapshot_change {
        if eligible(observation, &workflow.complete_on) {
            if workflow.completion.state != "completed"
                || workflow.completion.head_sha != workflow.head_sha
                || workflow.completion.trigger != workflow.complete_on
            {
                workflow.completion = PrCompletion {
                    state: "completed".into(),
                    trigger: workflow.complete_on.clone(),
                    head_sha: workflow.head_sha.clone(),
                    completed_at: Some(now_ms()),
                    note: format!(
                        "Trusted GitHub state confirms {} for head {} against base {}.",
                        if workflow.complete_on == "approved" {
                            "approval"
                        } else {
                            "merge"
                        },
                        short(&workflow.head_sha),
                        short(&workflow.base_sha)
                    ),
                };
            }
        } else if workflow.completion.state != "pending"
            || workflow.completion.head_sha != workflow.head_sha
            || workflow.completion.trigger != workflow.complete_on
        {
            workflow.completion = pending_completion(
                &workflow.complete_on,
                &workflow.head_sha,
                &workflow.base_sha,
            );
        }
    }
    *workflow != before
}

fn invalidate_current_action(store: &mut Store, workflow: &mut PrWorkflow, reason: &str) -> bool {
    let Some(current) = workflow.ticket_action.clone() else {
        return false;
    };
    let mut action = store
        .actions
        .get(&current.id)
        .map(|stored| stored.action.clone())
        .unwrap_or(current);
    if !matches!(action.status.as_str(), "pending" | "running") {
        return false;
    }

    action.status = "failed".into();
    action.message = reason.into();
    action.updated_at = now_ms();
    store.actions.insert(
        action.id.clone(),
        StoredAction {
            root: workflow.root.clone(),
            number: workflow.number,
            action: action.clone(),
        },
    );
    workflow.ticket_action = Some(action);
    true
}

fn short(sha: &str) -> String {
    sha.chars().take(9).collect()
}

fn touch(workflow: &mut PrWorkflow) {
    workflow.updated_at = now_ms();
}

fn emit_change(workflow: &PrWorkflow, previous_chat: Option<&str>) {
    crate::bus::emit("pull-request-workflow", workflow);
    let mut chats = BTreeSet::new();
    if let Some(chat_id) = previous_chat {
        chats.insert(chat_id.to_string());
    }
    if let Some(chat_id) = workflow.chat_id.as_ref() {
        chats.insert(chat_id.clone());
    }
    for chat_id in chats {
        if let Ok(status) = crate::chat_task::chat_task_impl(chat_id, false) {
            // A completion change is meaningful even when the verified git
            // half stayed still, so emit explicitly.
            crate::bus::emit("chat-task", status);
        }
    }
}

pub fn get(root: String, number: u64) -> Result<Option<PrWorkflow>, String> {
    let (root, number) = clean_root(root, number)?;
    Ok(read()?.workflows.get(&workflow_key(&root, number)).cloned())
}

/// Locate the current PR workflow for a durable ticket action without
/// mutating either record. Dispatch uses this before obtaining fresh GitHub
/// evidence and validating the chat that will be attached.
pub fn workflow_for_action(action_id: String) -> Result<PrWorkflow, String> {
    let action_id = action_id.trim();
    if action_id.is_empty() {
        return Err("A ticket action ID is required.".into());
    }
    let store = read()?;
    let stored = store
        .actions
        .get(action_id)
        .ok_or("The ticket action does not exist.")?;
    store
        .workflows
        .get(&workflow_key(&stored.root, stored.number))
        .cloned()
        .ok_or_else(|| "The ticket action's PR workflow no longer exists.".into())
}

pub fn save(
    observation: PrObservation,
    expected_head: String,
    chat_id: Option<String>,
    ticket: Option<PrTicketLink>,
    complete_on: String,
) -> Result<PrWorkflow, String> {
    let observation = clean_observation(observation)?;
    if expected_head.trim() != observation.head_sha {
        return Err("The PR head changed. Refresh the PR before saving its workflow.".into());
    }
    let chat_id = clean_chat(chat_id, &observation.root)?;
    let ticket = clean_ticket(ticket)?;
    let complete_on = clean_trigger(complete_on)?;
    let key = workflow_key(&observation.root, observation.number);

    let (workflow, previous_chat, changed) = {
        let _guard = LOCK.lock().unwrap_or_else(|error| error.into_inner());
        let mut store = read()?;
        let previous = store.workflows.get(&key).cloned();
        if let Some(previous) = previous.as_ref() {
            require_same_repository(previous, &observation)?;
        }
        let previous_chat = previous.as_ref().and_then(|item| item.chat_id.clone());
        let mut workflow = previous.clone().unwrap_or_else(|| PrWorkflow {
            root: observation.root.clone(),
            number: observation.number,
            url: observation.url.clone(),
            head_sha: observation.head_sha.clone(),
            base_sha: observation.base_sha.clone(),
            chat_id: None,
            ticket: None,
            complete_on: complete_on.clone(),
            completion: pending_completion(
                &complete_on,
                &observation.head_sha,
                &observation.base_sha,
            ),
            ticket_action: None,
            updated_at: now_ms(),
        });

        let snapshot_changed =
            workflow.head_sha != observation.head_sha || workflow.base_sha != observation.base_sha;
        let ticket_changed = workflow.ticket != ticket;
        let trigger_changed = workflow.complete_on != complete_on;
        let mut action_history_changed = false;
        if snapshot_changed || ticket_changed || trigger_changed {
            action_history_changed |= invalidate_current_action(
                &mut store,
                &mut workflow,
                if snapshot_changed {
                    "The ticket action was superseded by a new PR head or base."
                } else if ticket_changed {
                    "The ticket action was superseded by a changed ticket link."
                } else {
                    "The ticket action was superseded by a changed PR completion trigger."
                },
            );
            workflow.ticket_action = None;
        }
        workflow.chat_id = chat_id;
        workflow.ticket = ticket;
        workflow.complete_on = complete_on;
        if trigger_changed {
            workflow.completion = pending_completion(
                &workflow.complete_on,
                &workflow.head_sha,
                &workflow.base_sha,
            );
        }
        let evidence_changed = apply_evidence(
            &mut workflow,
            &observation,
            previous.is_none() || !snapshot_changed,
        );
        if workflow.completion.state != "completed" {
            action_history_changed |= invalidate_current_action(
                &mut store,
                &mut workflow,
                "The configured PR completion event is no longer satisfied.",
            );
        }
        let changed =
            previous.as_ref() != Some(&workflow) || evidence_changed || action_history_changed;
        if changed {
            touch(&mut workflow);
            store.workflows.insert(key, workflow.clone());
            write(&store)?;
        }
        (workflow, previous_chat, changed)
    };
    if changed {
        emit_change(&workflow, previous_chat.as_deref());
    }
    Ok(workflow)
}

pub fn refresh(observation: PrObservation) -> Result<Option<PrWorkflow>, String> {
    let observation = clean_observation(observation)?;
    let key = workflow_key(&observation.root, observation.number);
    let outcome = {
        let _guard = LOCK.lock().unwrap_or_else(|error| error.into_inner());
        let mut store = read()?;
        let Some(mut workflow) = store.workflows.get(&key).cloned() else {
            return Ok(None);
        };
        require_same_repository(&workflow, &observation)?;
        let previous = workflow.clone();
        let snapshot_changed =
            workflow.head_sha != observation.head_sha || workflow.base_sha != observation.base_sha;
        if snapshot_changed {
            invalidate_current_action(
                &mut store,
                &mut workflow,
                "The ticket action was superseded by a new PR head or base.",
            );
        }
        let evidence_changed = apply_evidence(&mut workflow, &observation, false);
        let action_history_changed = if workflow.completion.state != "completed" {
            invalidate_current_action(
                &mut store,
                &mut workflow,
                "The configured PR completion event is no longer satisfied.",
            )
        } else {
            false
        };
        let changed = evidence_changed || action_history_changed;
        if changed {
            touch(&mut workflow);
            store.workflows.insert(key, workflow.clone());
            write(&store)?;
        }
        Some((workflow, previous.chat_id, changed))
    };
    let Some((workflow, previous_chat, changed)) = outcome else {
        return Ok(None);
    };
    if changed {
        emit_change(&workflow, previous_chat.as_deref());
    }
    Ok(Some(workflow))
}

pub fn prepare_ticket(
    observation: PrObservation,
    expected_head: String,
) -> Result<PrTicketLaunch, String> {
    let observation = clean_observation(observation)?;
    if expected_head.trim() != observation.head_sha {
        return Err("The PR head changed. Refresh the PR before updating its ticket.".into());
    }
    let key = workflow_key(&observation.root, observation.number);

    let mut changed_workflow: Option<(PrWorkflow, Option<String>)> = None;
    let result = (|| {
        let _guard = LOCK.lock().unwrap_or_else(|error| error.into_inner());
        let mut store = read()?;
        let mut workflow = store
            .workflows
            .get(&key)
            .cloned()
            .ok_or("Save this PR workflow before preparing a ticket update.")?;
        require_same_repository(&workflow, &observation)?;
        let before = workflow.clone();
        let snapshot_changed =
            workflow.head_sha != observation.head_sha || workflow.base_sha != observation.base_sha;
        let mut action_history_changed = false;
        if snapshot_changed {
            action_history_changed |= invalidate_current_action(
                &mut store,
                &mut workflow,
                "The ticket action was superseded by a new PR head or base.",
            );
        }
        let evidence_changed = apply_evidence(&mut workflow, &observation, false);
        if workflow.completion.state != "completed" {
            action_history_changed |= invalidate_current_action(
                &mut store,
                &mut workflow,
                "The configured PR completion event is no longer satisfied.",
            );
        }
        if evidence_changed || action_history_changed {
            touch(&mut workflow);
            store.workflows.insert(key.clone(), workflow.clone());
            write(&store)?;
            changed_workflow = Some((workflow.clone(), before.chat_id));
        }

        if workflow.completion.state != "completed" {
            Err(
                "The configured PR completion event has not been confirmed for this head and base."
                    .into(),
            )
        } else {
            let ticket = workflow
                .ticket
                .clone()
                .ok_or("Link a ticket before preparing its completion workflow.")?;

            if store.actions.values().any(|stored| {
                stored.root == workflow.root
                    && stored.number == workflow.number
                    && stored.action.head_sha == workflow.head_sha
                    && stored.action.status == "confirmed"
            }) {
                return Err(
                    "The ticket update was already user-confirmed for this PR head.".into(),
                );
            }

            if let Some(action) = workflow.ticket_action.clone() {
                if action.head_sha == workflow.head_sha {
                    match action.status.as_str() {
                        "pending" | "running" => {
                            return Ok(ticket_launch(workflow, action.id, &ticket));
                        }
                        "confirmed" => {
                            return Err(
                                "The ticket update was already user-confirmed for this PR head."
                                    .into(),
                            );
                        }
                        "failed" => {}
                        _ => {
                            return Err("The saved ticket action has an unsupported status.".into())
                        }
                    }
                }
            }

            let action = PrTicketAction {
                id: format!("pr-ticket-{}", Uuid::new_v4().simple()),
                head_sha: workflow.head_sha.clone(),
                status: "pending".into(),
                chat_id: None,
                message: "Waiting for a ticket-resolution chat to start.".into(),
                updated_at: now_ms(),
            };
            store.actions.insert(
                action.id.clone(),
                StoredAction {
                    root: workflow.root.clone(),
                    number: workflow.number,
                    action: action.clone(),
                },
            );
            workflow.ticket_action = Some(action.clone());
            touch(&mut workflow);
            store.workflows.insert(key, workflow.clone());
            write(&store)?;
            changed_workflow = Some((workflow.clone(), workflow.chat_id.clone()));
            Ok(ticket_launch(workflow, action.id, &ticket))
        }
    })();

    if let Some((workflow, previous_chat)) = changed_workflow {
        emit_change(&workflow, previous_chat.as_deref());
    }
    result
}

fn ticket_launch(workflow: PrWorkflow, action_id: String, ticket: &PrTicketLink) -> PrTicketLaunch {
    let ticket_location = ticket
        .url
        .as_deref()
        .map(|url| format!(" ({url})"))
        .unwrap_or_default();
    let prompt = format!(
        "Inspect ticket {}{} and the completed PR #{} at {}. Use the available Workspace tools or the project's resolve-ticket workflow as appropriate. Follow every required confirmation gate. Update the development status and resolution, include the PR link and concrete verification, and check the resulting ticket before reporting success. Do not imply that OctiqFlow updated or remotely verified the ticket automatically; the person will separately confirm the result in the PR dashboard.",
        ticket.reference, ticket_location, workflow.number, workflow.url
    );
    PrTicketLaunch {
        cwd: workflow.root.clone(),
        title: format!("Resolve {} for PR #{}", ticket.reference, workflow.number),
        workflow,
        action_id,
        prompt,
    }
}

pub fn attach_ticket(action_id: String, chat_id: String) -> Result<PrWorkflow, String> {
    let action_id = action_id.trim().to_string();
    if action_id.is_empty() {
        return Err("A ticket action ID is required.".into());
    }
    let chat_id = chat_id.trim().to_string();
    if chat_id.is_empty() {
        return Err("A ticket workflow chat ID is required.".into());
    }

    // Keep durable existence/worker validation outside the workflow mutex.
    // Besides avoiding a recursive lock through chat metadata, this gives the
    // coordinator the same repository identity exposed by workflow_for_action.
    let located = workflow_for_action(action_id.clone())?;
    validate_chat(&chat_id, &located.root)?;

    let workflow = {
        let _guard = LOCK.lock().unwrap_or_else(|error| error.into_inner());
        let mut store = read()?;
        let stored = store
            .actions
            .get(&action_id)
            .cloned()
            .ok_or("The ticket action does not exist.")?;
        let key = workflow_key(&stored.root, stored.number);
        let mut workflow = store
            .workflows
            .get(&key)
            .cloned()
            .ok_or("The ticket action's PR workflow no longer exists.")?;
        require_current_completed_action(&workflow, &stored.action)?;
        let mut action = stored.action;
        match action.status.as_str() {
            "pending" => {
                action.status = "running".into();
                action.chat_id = Some(chat_id);
                action.message =
                    "Ticket workflow chat is running; completion still requires user confirmation."
                        .into();
                action.updated_at = now_ms();
            }
            "running" | "confirmed" if action.chat_id.as_deref() == Some(chat_id.as_str()) => {
                return Ok(workflow)
            }
            "running" | "confirmed" => {
                return Err("The ticket action is already attached to another chat.".into())
            }
            "failed" => return Err("The ticket action failed. Prepare a retry first.".into()),
            _ => return Err("The ticket action has an unsupported status.".into()),
        }
        store.actions.insert(
            action_id,
            StoredAction {
                root: stored.root,
                number: stored.number,
                action: action.clone(),
            },
        );
        workflow.ticket_action = Some(action);
        touch(&mut workflow);
        store.workflows.insert(key, workflow.clone());
        write(&store)?;
        workflow
    };
    emit_change(&workflow, workflow.chat_id.as_deref());
    Ok(workflow)
}

pub fn confirm_ticket(
    action_id: String,
    confirmed: bool,
    message: String,
) -> Result<PrWorkflow, String> {
    let action_id = action_id.trim().to_string();
    if action_id.is_empty() {
        return Err("A ticket action ID is required.".into());
    }
    let workflow = {
        let _guard = LOCK.lock().unwrap_or_else(|error| error.into_inner());
        let mut store = read()?;
        let stored = store
            .actions
            .get(&action_id)
            .cloned()
            .ok_or("The ticket action does not exist.")?;
        let key = workflow_key(&stored.root, stored.number);
        let mut workflow = store
            .workflows
            .get(&key)
            .cloned()
            .ok_or("The ticket action's PR workflow no longer exists.")?;
        let mut action = stored.action;

        if confirmed {
            require_current_completed_action(&workflow, &action)?;
            if action.status == "confirmed" {
                return Ok(workflow);
            }
            if action.status != "running" {
                return Err("Only a running ticket workflow can be user-confirmed.".into());
            }
        } else {
            // Launch and agent failures remain reportable even when fresh
            // evidence has revoked completion or superseded this action. That
            // closes the durable history without allowing a stale success.
            if action.status == "failed" {
                return Ok(workflow);
            }
            if action.status == "confirmed" {
                return Err("A confirmed ticket action cannot be changed to failed.".into());
            }
            if !matches!(action.status.as_str(), "pending" | "running") {
                return Err("The ticket action has an unsupported status.".into());
            }
        }

        action.status = if confirmed { "confirmed" } else { "failed" }.into();
        action.message = if message.trim().is_empty() {
            if confirmed {
                "User confirmed that the linked ticket was updated; no remote verification was performed."
                    .into()
            } else {
                "User reported that the ticket workflow did not complete.".into()
            }
        } else {
            message.trim().to_string()
        };
        action.updated_at = now_ms();
        store.actions.insert(
            action_id,
            StoredAction {
                root: stored.root,
                number: stored.number,
                action: action.clone(),
            },
        );
        if workflow
            .ticket_action
            .as_ref()
            .is_some_and(|current| current.id == action.id)
        {
            workflow.ticket_action = Some(action);
            touch(&mut workflow);
            store.workflows.insert(key, workflow.clone());
        }
        write(&store)?;
        workflow
    };
    emit_change(&workflow, workflow.chat_id.as_deref());
    Ok(workflow)
}

fn require_current_completed_action(
    workflow: &PrWorkflow,
    action: &PrTicketAction,
) -> Result<(), String> {
    if action.head_sha != workflow.head_sha
        || workflow
            .ticket_action
            .as_ref()
            .map(|current| current.id.as_str())
            != Some(action.id.as_str())
    {
        return Err("The ticket action is stale for the current PR head.".into());
    }
    if workflow.completion.state != "completed"
        || workflow.completion.head_sha != workflow.head_sha
        || workflow.completion.trigger != workflow.complete_on
    {
        return Err(
            "The configured PR completion event is no longer confirmed for this action.".into(),
        );
    }
    Ok(())
}

/// Completion shown on a chat is all-or-nothing. If several PRs link to the
/// same chat, one pending PR withholds completion for the whole chat. Once all
/// are complete, the most recently completed link represents the group.
pub fn completion_for_chat(chat_id: &str) -> Option<PrChatCompletion> {
    let chat_id = chat_id.trim();
    if chat_id.is_empty() {
        return None;
    }
    let store = read().ok()?;
    let linked: Vec<_> = store
        .workflows
        .values()
        .filter(|workflow| workflow.chat_id.as_deref() == Some(chat_id))
        .collect();
    if linked.is_empty()
        || linked
            .iter()
            .any(|workflow| workflow.completion.state != "completed")
    {
        return None;
    }
    let workflow = linked
        .into_iter()
        .max_by_key(|workflow| workflow.completion.completed_at)?;
    Some(PrChatCompletion {
        root: workflow.root.clone(),
        number: workflow.number,
        url: workflow.url.clone(),
        head_sha: workflow.head_sha.clone(),
        trigger: workflow.complete_on.clone(),
        completed_at: workflow.completion.completed_at?,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::chat_index::ChatMeta;

    static TEST_LOCK: Mutex<()> = Mutex::new(());

    fn observation(root: &str, number: u64, head: &str) -> PrObservation {
        PrObservation {
            root: root.into(),
            number,
            url: format!("https://github.test/acme/repo/pull/{number}"),
            head_sha: head.into(),
            base_sha: "base000000000000000000000000000000000000".into(),
            state: "open".into(),
            approved: false,
        }
    }

    fn add_chat(id: &str) {
        crate::chat_index::upsert(ChatMeta {
            id: id.into(),
            project_id: format!("project-{id}"),
            title: "Workflow origin".into(),
            latest_response: None,
            custom_title: false,
            agent_title: false,
            session_id: None,
            cwd: None,
            model_id: None,
            access: None,
            created_at: now_ms(),
            updated_at: now_ms(),
            read_at: None,
            pinned: false,
            deleted_at: None,
            generation: 0,
        })
        .expect("add chat");
    }

    fn remove_chat(id: &str) {
        crate::chat_index::remove(id).expect("remove chat");
    }

    #[test]
    fn corrupt_and_future_stores_are_never_silently_replaced() {
        let _guard = TEST_LOCK.lock().unwrap();
        let dir = std::env::temp_dir().join(format!("octiq-pr-store-{}", Uuid::new_v4()));
        fs::create_dir_all(&dir).unwrap();
        let path = dir.join("store.json");
        fs::write(&path, b"not json").unwrap();
        assert!(read_store(&path).unwrap_err().contains("could not be read"));
        let before = fs::read(&path).unwrap();
        assert!(read_store(&path).is_err());
        assert_eq!(fs::read(&path).unwrap(), before);

        fs::write(
            &path,
            serde_json::to_vec(&serde_json::json!({
                "version": STORE_VERSION + 1,
                "workflows": {},
                "actions": {}
            }))
            .unwrap(),
        )
        .unwrap();
        assert!(read_store(&path)
            .unwrap_err()
            .contains("unsupported version"));
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn approved_completion_reopens_for_snapshot_change_and_revocation() {
        let _guard = TEST_LOCK.lock().unwrap();
        let suffix = Uuid::new_v4().simple().to_string();
        let root = format!("/test/pr-approved-{suffix}");
        let chat = format!("pr-origin-{suffix}");
        add_chat(&chat);

        let mut observed = observation(&root, 11, "head-a");
        observed.approved = true;
        let saved = save(
            observed.clone(),
            "head-a".into(),
            Some(chat.clone()),
            None,
            "approved".into(),
        )
        .unwrap();
        assert_eq!(saved.completion.state, "completed");
        assert!(completion_for_chat(&chat).is_some());

        observed.head_sha = "head-b".into();
        let moved = refresh(observed.clone()).unwrap().unwrap();
        assert_eq!(moved.completion.state, "pending");
        assert!(completion_for_chat(&chat).is_none());

        let stable = refresh(observed.clone()).unwrap().unwrap();
        assert_eq!(stable.completion.state, "completed");

        observed.base_sha = "base111111111111111111111111111111111111".into();
        let rebased = refresh(observed.clone()).unwrap().unwrap();
        assert_eq!(rebased.completion.state, "pending");
        assert_eq!(
            refresh(observed.clone()).unwrap().unwrap().completion.state,
            "completed"
        );
        observed.approved = false;
        let revoked = refresh(observed).unwrap().unwrap();
        assert_eq!(revoked.completion.state, "pending");
        remove_chat(&chat);
    }

    #[test]
    fn merge_is_not_inferred_from_approval() {
        let _guard = TEST_LOCK.lock().unwrap();
        let suffix = Uuid::new_v4().simple().to_string();
        let root = format!("/test/pr-merged-{suffix}");
        let mut observed = observation(&root, 12, "head-a");
        observed.approved = true;
        let saved = save(
            observed.clone(),
            "head-a".into(),
            None,
            None,
            "merged".into(),
        )
        .unwrap();
        assert_eq!(saved.completion.state, "pending");
        let json = serde_json::to_value(&saved).unwrap();
        assert!(json["chatId"].is_null());
        assert!(json["ticket"].is_null());
        assert!(json["ticketAction"].is_null());
        assert!(json["completion"]["completedAt"].is_null());
        assert_eq!(get(root, 12).unwrap(), Some(saved));
        observed.state = "merged".into();
        assert_eq!(
            refresh(observed).unwrap().unwrap().completion.state,
            "completed"
        );
    }

    #[test]
    fn one_pending_pr_withholds_a_multi_pr_chat_completion() {
        let _guard = TEST_LOCK.lock().unwrap();
        let suffix = Uuid::new_v4().simple().to_string();
        let chat = format!("pr-multi-{suffix}");
        add_chat(&chat);
        for number in [21, 22] {
            let mut observed = observation(&format!("/test/pr-multi-{suffix}"), number, "head-a");
            observed.approved = number == 21;
            save(
                observed,
                "head-a".into(),
                Some(chat.clone()),
                None,
                "approved".into(),
            )
            .unwrap();
        }
        assert!(completion_for_chat(&chat).is_none());
        let mut second = observation(&format!("/test/pr-multi-{suffix}"), 22, "head-a");
        second.approved = true;
        refresh(second).unwrap();
        assert!(completion_for_chat(&chat).is_some());
        remove_chat(&chat);
    }

    #[test]
    fn chat_links_must_exist_and_workers_are_rejected() {
        let _guard = TEST_LOCK.lock().unwrap();
        let suffix = Uuid::new_v4().simple().to_string();
        let root = format!("/test/pr-chat-validation-{suffix}");
        let observed = observation(&root, 31, "head-a");
        let error = save(
            observed.clone(),
            "head-a".into(),
            Some(format!("missing-{suffix}")),
            None,
            "merged".into(),
        )
        .unwrap_err();
        assert!(error.contains("does not exist"));

        let worker = format!("orch-{suffix}");
        add_chat(&worker);
        let error = save(
            observed,
            "head-a".into(),
            Some(worker.clone()),
            None,
            "merged".into(),
        )
        .unwrap_err();
        assert!(error.contains("worker chats"));
        remove_chat(&worker);
    }

    #[test]
    fn revoked_approval_invalidates_running_action_and_prevents_stale_success() {
        let _guard = TEST_LOCK.lock().unwrap();
        let suffix = Uuid::new_v4().simple().to_string();
        let root = format!("/test/pr-revoked-action-{suffix}");
        let runner = format!("runner-{suffix}");
        let other_runner = format!("other-runner-{suffix}");
        add_chat(&runner);
        add_chat(&other_runner);

        let mut observed = observation(&root, 36, "head-a");
        observed.approved = true;
        save(
            observed.clone(),
            "head-a".into(),
            None,
            Some(PrTicketLink {
                reference: "T-36".into(),
                url: None,
            }),
            "approved".into(),
        )
        .unwrap();
        let launch = prepare_ticket(observed.clone(), "head-a".into()).unwrap();
        let running = attach_ticket(launch.action_id.clone(), runner.clone()).unwrap();
        assert_eq!(running.ticket_action.as_ref().unwrap().status, "running");

        // Retrying the same attachment is harmless, while a different chat
        // cannot steal an action that has already started.
        let duplicate = attach_ticket(launch.action_id.clone(), runner.clone()).unwrap();
        assert_eq!(duplicate.ticket_action, running.ticket_action);
        assert!(
            attach_ticket(launch.action_id.clone(), other_runner.clone())
                .unwrap_err()
                .contains("another chat")
        );

        observed.approved = false;
        let revoked = refresh(observed).unwrap().unwrap();
        assert_eq!(revoked.completion.state, "pending");
        assert_eq!(revoked.ticket_action.as_ref().unwrap().status, "failed");
        assert_eq!(
            read().unwrap().actions[&launch.action_id].action.status,
            "failed"
        );
        assert!(
            confirm_ticket(launch.action_id.clone(), true, "stale success".into())
                .unwrap_err()
                .contains("no longer confirmed")
        );

        // Failure reporting is still idempotent after eligibility is lost.
        let failed = confirm_ticket(launch.action_id, false, "approval revoked".into()).unwrap();
        assert_eq!(failed.ticket_action.unwrap().status, "failed");

        remove_chat(&runner);
        remove_chat(&other_runner);
    }

    #[test]
    fn changing_from_approval_to_unmet_merge_invalidates_the_action() {
        let _guard = TEST_LOCK.lock().unwrap();
        let suffix = Uuid::new_v4().simple().to_string();
        let root = format!("/test/pr-trigger-change-{suffix}");
        let runner = format!("runner-{suffix}");
        add_chat(&runner);

        let mut observed = observation(&root, 37, "head-a");
        observed.approved = true;
        save(
            observed.clone(),
            "head-a".into(),
            None,
            Some(PrTicketLink {
                reference: "T-37".into(),
                url: None,
            }),
            "approved".into(),
        )
        .unwrap();
        let launch = prepare_ticket(observed.clone(), "head-a".into()).unwrap();
        attach_ticket(launch.action_id.clone(), runner.clone()).unwrap();

        let changed = save(
            observed.clone(),
            "head-a".into(),
            None,
            Some(PrTicketLink {
                reference: "T-37".into(),
                url: None,
            }),
            "merged".into(),
        )
        .unwrap();
        assert_eq!(changed.complete_on, "merged");
        assert_eq!(changed.completion.state, "pending");
        assert!(changed.ticket_action.is_none());
        assert_eq!(
            read().unwrap().actions[&launch.action_id].action.status,
            "failed"
        );
        assert!(
            confirm_ticket(launch.action_id.clone(), true, "stale success".into())
                .unwrap_err()
                .contains("stale")
        );
        assert!(confirm_ticket(launch.action_id.clone(), false, "trigger changed".into()).is_ok());

        observed.state = "merged".into();
        let completed = refresh(observed.clone()).unwrap().unwrap();
        assert_eq!(completed.completion.state, "completed");
        let retry = prepare_ticket(observed, "head-a".into()).unwrap();
        assert_ne!(retry.action_id, launch.action_id);
        remove_chat(&runner);
    }

    #[test]
    fn repository_identity_mismatch_never_rewrites_an_existing_workflow() {
        let _guard = TEST_LOCK.lock().unwrap();
        let suffix = Uuid::new_v4().simple().to_string();
        let root = format!("/test/pr-identity-{suffix}");
        let mut observed = observation(&root, 38, "head-a");
        observed.approved = true;
        save(
            observed.clone(),
            "head-a".into(),
            None,
            Some(PrTicketLink {
                reference: "T-38".into(),
                url: None,
            }),
            "approved".into(),
        )
        .unwrap();
        let launch = prepare_ticket(observed.clone(), "head-a".into()).unwrap();
        assert_eq!(
            workflow_for_action(launch.action_id.clone()).unwrap().url,
            observed.url
        );
        let before = serde_json::to_value(read().unwrap()).unwrap();

        let mut mismatched = observed;
        mismatched.url = "https://github.test/other/repository/pull/38".into();
        for result in [
            save(
                mismatched.clone(),
                "head-a".into(),
                None,
                Some(PrTicketLink {
                    reference: "T-38-changed".into(),
                    url: None,
                }),
                "approved".into(),
            )
            .map(|_| ()),
            refresh(mismatched.clone()).map(|_| ()),
            prepare_ticket(mismatched, "head-a".into()).map(|_| ()),
        ] {
            assert!(result.unwrap_err().contains("different GitHub repository"));
        }

        let after = serde_json::to_value(read().unwrap()).unwrap();
        assert_eq!(after, before);
        let preserved = workflow_for_action(launch.action_id).unwrap();
        assert_eq!(preserved.url, "https://github.test/acme/repo/pull/38");
        assert_eq!(preserved.ticket.unwrap().reference, "T-38");
    }

    #[test]
    fn ticket_actions_are_idempotent_retryable_and_stale_safe() {
        let _guard = TEST_LOCK.lock().unwrap();
        let suffix = Uuid::new_v4().simple().to_string();
        let root = format!("/test/pr-ticket-{suffix}");
        let origin = format!("origin-{suffix}");
        let runner = format!("runner-{suffix}");
        add_chat(&origin);
        add_chat(&runner);
        let mut observed = observation(&root, 41, "head-a");
        observed.state = "merged".into();
        save(
            observed.clone(),
            "head-a".into(),
            Some(origin.clone()),
            Some(PrTicketLink {
                reference: "T-41".into(),
                url: Some("https://tickets.test/T-41".into()),
            }),
            "merged".into(),
        )
        .unwrap();

        let first = prepare_ticket(observed.clone(), "head-a".into()).unwrap();
        let duplicate = prepare_ticket(observed.clone(), "head-a".into()).unwrap();
        assert_eq!(first.action_id, duplicate.action_id);
        attach_ticket(first.action_id.clone(), runner.clone()).unwrap();
        confirm_ticket(first.action_id.clone(), false, "agent failed".into()).unwrap();

        let retry = prepare_ticket(observed.clone(), "head-a".into()).unwrap();
        assert_ne!(retry.action_id, first.action_id);
        let store = read().unwrap();
        assert_eq!(store.actions[&first.action_id].action.status, "failed");
        assert!(store.actions.contains_key(&retry.action_id));
        attach_ticket(retry.action_id.clone(), runner.clone()).unwrap();
        let confirmed = confirm_ticket(retry.action_id.clone(), true, String::new()).unwrap();
        let confirmed_action = confirmed.ticket_action.unwrap();
        assert_eq!(confirmed_action.status, "confirmed");
        assert!(confirmed_action.message.contains("no remote verification"));

        let relinked = save(
            observed.clone(),
            "head-a".into(),
            Some(origin.clone()),
            Some(PrTicketLink {
                reference: "T-41-relinked".into(),
                url: None,
            }),
            "merged".into(),
        )
        .unwrap();
        assert!(relinked.ticket_action.is_none());
        assert!(prepare_ticket(observed.clone(), "head-a".into())
            .unwrap_err()
            .contains("already user-confirmed"));

        observed.head_sha = "head-b".into();
        let reopened = refresh(observed.clone()).unwrap().unwrap();
        assert_eq!(reopened.completion.state, "pending");
        assert!(reopened.ticket_action.is_none());
        assert!(confirm_ticket(retry.action_id, true, "late".into())
            .unwrap_err()
            .contains("stale"));

        remove_chat(&origin);
        remove_chat(&runner);
    }

    #[test]
    fn failed_launch_can_be_recorded_before_attach_and_retried() {
        let _guard = TEST_LOCK.lock().unwrap();
        let suffix = Uuid::new_v4().simple().to_string();
        let root = format!("/test/pr-ticket-launch-{suffix}");
        let mut observed = observation(&root, 51, "head-a");
        observed.approved = true;
        save(
            observed.clone(),
            "head-a".into(),
            None,
            Some(PrTicketLink {
                reference: "T-51".into(),
                url: None,
            }),
            "approved".into(),
        )
        .unwrap();
        let first = prepare_ticket(observed.clone(), "head-a".into()).unwrap();
        let failed =
            confirm_ticket(first.action_id.clone(), false, "launch failed".into()).unwrap();
        assert_eq!(failed.ticket_action.unwrap().status, "failed");
        let retry = prepare_ticket(observed, "head-a".into()).unwrap();
        assert_ne!(retry.action_id, first.action_id);
    }
}
