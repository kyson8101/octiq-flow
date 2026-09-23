//! Where this chat is, and what became of its work.
//!
//! A chat that has been running for an hour knows what it is doing; the person
//! reading it four chats later does not. Which branch is this? Is it the
//! primary checkout or a task worktree? Was the thing it finished yesterday
//! ever merged, or is it still sitting on a branch nobody pushed?
//!
//! ## Two halves, two owners
//!
//! The split is the whole point of this module:
//!
//!   * **What the task IS** — objective, the steps, which one is running — can
//!     only come from the agent. It is a REPORT: stored with the time it was
//!     made and who made it, and shown as that. Nothing here infers it, and a
//!     chat whose agent never reported says "not reported" rather than
//!     guessing from the transcript.
//!   * **Where the work IS** — branch, worktree, commits, merge, release — is
//!     verified by this process, with git, every time it is asked for. An
//!     agent saying "merged" does not make it merged. If git cannot confirm
//!     it, the answer is "unverified", never "yes".
//!
//! That is deliberate: an LLM forgets to update a status line, and a status
//! line nobody can trust is worse than none. The half that can be checked is
//! checked; the half that cannot carries its own timestamp so a stale report
//! looks stale.
//!
//! ## The record outlives the worktree
//!
//! The moment a task worktree is removed, its branch, its head commit and its
//! merge state become unanswerable from `cwd` — which is exactly when the
//! question "did that ever land?" gets asked. So every verification writes its
//! snapshot down, including the repository's PRIMARY checkout path and the
//! head commit, and a chat whose directory has gone is re-verified from the
//! primary checkout against that remembered commit. It is marked `stale`: the
//! working tree is gone, but "merged into main" is still a fact git can prove.
use std::collections::{BTreeMap, HashMap};
use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::Mutex;
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};

use crate::git::run_git;

/// One step of the agent's own plan.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TaskStep {
    pub title: String,
    /// `done` · `active` · `pending`. Anything else is read as `pending`
    /// rather than rejected — a report that arrives slightly wrong is still
    /// worth keeping, and the alternative is an agent losing a whole update to
    /// a typo.
    #[serde(default = "pending_state")]
    pub state: String,
}

fn pending_state() -> String {
    "pending".into()
}

/// What the agent last said it was doing.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TaskReport {
    /// The task as a whole. This is the line that must survive "what's the
    /// status?" being asked six times — it is not replaced by the answer to
    /// the latest question.
    pub objective: String,
    /// What is happening right now, or what is being waited for.
    #[serde(default)]
    pub next_step: String,
    #[serde(default)]
    pub steps: Vec<TaskStep>,
    /// When this was reported. Shown, because an old report IS the answer to
    /// "is the progress current?".
    pub reported_at: i64,
    /// Which agent reported it.
    #[serde(default)]
    pub reported_by: String,
}

/// Where the work is meant to end up.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TaskTarget {
    pub branch: String,
    pub set_at: i64,
    /// `host` when it was derived from the repository's default branch,
    /// `agent` or `user` when it was chosen.
    #[serde(default)]
    pub set_by: String,
}

/// How this project decides that a commit is RELEASED — as opposed to merged,
/// which git can always answer on its own.
///
/// Both halves are optional, and neither being set is a legitimate answer: the
/// release column then reads "unverified" instead of inventing a yes.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReleaseCheck {
    /// A git ref that is only ever advanced by a release — a deploy tag, a
    /// `release` branch, `origin/production`. Released means "this commit is
    /// an ancestor of that ref", which needs nothing but git.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reference: Option<String>,
    /// A command whose output names the commit that is actually running (for
    /// OctiqFlow itself, `./scripts/octiq-check.sh` prints the live build).
    /// The first 7-40 character hex string in its output is taken as that
    /// commit.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub command: Option<String>,
}

impl ReleaseCheck {
    fn configured(&self) -> bool {
        self.reference
            .as_ref()
            .is_some_and(|r| !r.trim().is_empty())
            || self.command.as_ref().is_some_and(|c| !c.trim().is_empty())
    }
}

/// Where the chat is sitting, as git sees it.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Workspace {
    /// The chat's own directory, exactly as the chat was started in.
    pub cwd: String,
    /// False once the directory has been removed — a finished task worktree.
    #[serde(default)]
    pub exists: bool,
    #[serde(default)]
    pub is_repo: bool,
    #[serde(default)]
    pub repo_root: String,
    /// The repository's primary checkout. Kept because it is the one place
    /// that can still answer a question about a branch after its worktree has
    /// been deleted.
    #[serde(default)]
    pub primary_root: String,
    #[serde(default)]
    pub branch: String,
    /// True for a linked worktree, false for the primary checkout. The
    /// difference is the one the person asks about by name.
    #[serde(default)]
    pub is_worktree: bool,
    /// Changed entries in the working tree (staged, unstaged and untracked).
    #[serde(default)]
    pub changed: usize,
    #[serde(default)]
    pub ahead: u32,
    #[serde(default)]
    pub behind: u32,
    #[serde(default)]
    pub has_upstream: bool,
}

/// What became of the work: committed, pushed, merged, released — each one
/// checked, none of them taken on anybody's word.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Delivery {
    /// The branch this work is going to.
    pub target: String,
    /// The commit the branch is at, and the commit every question below is
    /// asked about. Remembered, so the questions survive the worktree.
    #[serde(default)]
    pub head: String,
    /// True when the chat is working directly ON the target branch, where
    /// "merged" is not a question that can be asked.
    #[serde(default)]
    pub on_target: bool,
    /// Commits this branch has that the target does not.
    #[serde(default)]
    pub commits: u32,
    /// Changed files not committed yet.
    #[serde(default)]
    pub uncommitted: usize,
    /// The head commit is on this branch's remote.
    #[serde(default)]
    pub pushed: bool,
    /// The head commit is contained in the LOCAL target branch.
    #[serde(default)]
    pub merged: bool,
    /// …and in the target branch on the remote. Local-only is its own state:
    /// merged on this machine, invisible to everyone else.
    #[serde(default)]
    pub merged_remote: bool,
    /// `None` is "unverified", and it is not a failure — most projects have no
    /// release check configured.
    #[serde(default)]
    pub released: Option<bool>,
    /// One line saying what the release answer was based on.
    #[serde(default)]
    pub release_note: String,
    /// True when the chat's own directory is gone and this was verified from
    /// the primary checkout against the remembered commit.
    #[serde(default)]
    pub stale: bool,
    pub checked_at: i64,
}

/// Everything this module knows about one chat.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TaskStatus {
    pub chat_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub report: Option<TaskReport>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub target: Option<TaskTarget>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub workspace: Option<Workspace>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub delivery: Option<Delivery>,
    /// The project's release check, when it has one. Sent so the panel can
    /// show WHAT "released" was decided against, and offer to set it when the
    /// answer is unverified for want of one.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub release_check: Option<ReleaseCheck>,
    /// Which project this chat belongs to, so the panel can change that check
    /// without asking a second command where the chat lives.
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub project_id: String,
}

/// What is kept on disk for one chat: the agent's report, the chosen target,
/// and the last verification — the last one because it is what answers the
/// question after the worktree is gone.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Stored {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    report: Option<TaskReport>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    target: Option<TaskTarget>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    workspace: Option<Workspace>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    delivery: Option<Delivery>,
    /// The project this chat belongs to, copied from the chat index so the
    /// record can still name its release check after the chat is gone.
    #[serde(default, skip_serializing_if = "String::is_empty")]
    project_id: String,
}

#[derive(Debug, Default, Serialize, Deserialize)]
struct Store {
    #[serde(default)]
    chats: BTreeMap<String, Stored>,
    /// Release checks are a property of the PROJECT, not of one chat: every
    /// chat in a repository releases the same way.
    #[serde(default)]
    projects: BTreeMap<String, ReleaseCheck>,
}

/// Serialises read-modify-write, exactly as `chat_index` does: several chats
/// report at once, and the loser of that race would otherwise erase the winner.
static LOCK: Mutex<()> = Mutex::new(());

fn path() -> Option<PathBuf> {
    Some(crate::transcript::chats_dir()?.join("task-status.json"))
}

fn read() -> Store {
    let Some(path) = path() else {
        return Store::default();
    };
    match fs::read_to_string(&path) {
        Ok(raw) => serde_json::from_str(&raw).unwrap_or_default(),
        Err(_) => Store::default(),
    }
}

/// Write the whole file through a temporary and a rename, so a process that
/// dies mid-write leaves the previous record rather than half of the new one.
fn write(store: &Store) -> Result<(), String> {
    let path = path().ok_or("could not find the profile folder")?;
    let body = serde_json::to_vec_pretty(store).map_err(|e| e.to_string())?;
    let temp = path.with_extension("json.tmp");
    fs::write(&temp, body).map_err(|e| e.to_string())?;
    fs::rename(&temp, &path).map_err(|e| e.to_string())
}

fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

/// How long a verification stands before the next request re-runs git.
///
/// Every open browser tab asks, and several ask again on the same
/// `git-status-changed` event. One `git status` per chat per few seconds is
/// nothing; a dozen of them per keystroke is the kind of thing that makes a
/// laptop fan audible.
const FRESH_FOR: Duration = Duration::from_secs(4);

fn verified_at() -> &'static Mutex<HashMap<String, Instant>> {
    static AT: std::sync::OnceLock<Mutex<HashMap<String, Instant>>> = std::sync::OnceLock::new();
    AT.get_or_init(|| Mutex::new(HashMap::new()))
}

// ---------------------------------------------------------------- commands

/// The agent's own account of the task. Replaces the previous one whole: a
/// report is a snapshot of the plan, not an edit to it.
pub fn chat_task_report_impl(
    chat_id: String,
    objective: String,
    next_step: String,
    steps: Vec<TaskStep>,
    reported_by: String,
) -> Result<TaskStatus, String> {
    let objective = objective.trim().to_string();
    if objective.is_empty() {
        return Err("A task report needs an objective.".into());
    }
    {
        let _guard = LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let mut store = read();
        let entry = store.chats.entry(chat_id.clone()).or_default();
        entry.report = Some(TaskReport {
            objective,
            next_step: next_step.trim().to_string(),
            steps: steps
                .into_iter()
                .filter(|step| !step.title.trim().is_empty())
                .map(|step| TaskStep {
                    title: step.title.trim().to_string(),
                    state: match step.state.as_str() {
                        "done" | "active" => step.state,
                        _ => pending_state(),
                    },
                })
                .collect(),
            reported_at: now_ms(),
            reported_by: reported_by.trim().to_string(),
        });
        write(&store)?;
    }
    // A report says nothing about git, but it is the moment the panel is most
    // likely being looked at, so the verified half is refreshed with it.
    let status = chat_task_impl(chat_id, true)?;
    Ok(status)
}

/// Point this chat's work at a branch. The verified half is re-read straight
/// away, because every merge answer below depends on it.
pub fn chat_task_set_target_impl(
    chat_id: String,
    branch: String,
    set_by: String,
) -> Result<TaskStatus, String> {
    let branch = branch.trim().to_string();
    if branch.is_empty() {
        return Err("A target needs a branch name.".into());
    }
    {
        let _guard = LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let mut store = read();
        let entry = store.chats.entry(chat_id.clone()).or_default();
        entry.target = Some(TaskTarget {
            branch,
            set_at: now_ms(),
            set_by: if set_by.trim().is_empty() {
                "user".into()
            } else {
                set_by.trim().to_string()
            },
        });
        write(&store)?;
    }
    chat_task_impl(chat_id, true)
}

/// Teach a project how a release is recognised. Empty strings clear it, which
/// puts the release column back to "unverified" rather than to "no".
pub fn chat_task_set_release_check_impl(
    project_id: String,
    reference: Option<String>,
    command: Option<String>,
) -> Result<ReleaseCheck, String> {
    let clean = |value: Option<String>| {
        value
            .map(|v| v.trim().to_string())
            .filter(|v| !v.is_empty())
    };
    let check = ReleaseCheck {
        reference: clean(reference),
        command: clean(command),
    };
    let _guard = LOCK.lock().unwrap_or_else(|e| e.into_inner());
    let mut store = read();
    if check.configured() {
        store.projects.insert(project_id, check.clone());
    } else {
        store.projects.remove(&project_id);
    }
    write(&store)?;
    Ok(check)
}

/// This chat's status, verified unless it was verified moments ago.
pub fn chat_task_impl(chat_id: String, refresh: bool) -> Result<TaskStatus, String> {
    let store = read();
    let mut stored = store.chats.get(&chat_id).cloned().unwrap_or_default();
    let fresh = verified_at()
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .get(&chat_id)
        .is_some_and(|at| at.elapsed() < FRESH_FOR);
    if fresh && !refresh {
        return Ok(assemble(chat_id, stored, &store));
    }

    // Which project a chat belongs to is the chat index's to answer, and the
    // stored copy is what answers it for a chat the index no longer lists.
    let chat = crate::chat_index::list()
        .into_iter()
        .find(|meta| meta.id == chat_id);
    let cwd = chat.as_ref().and_then(|meta| meta.cwd.clone());
    if let Some(meta) = chat.as_ref() {
        stored.project_id = meta.project_id.clone();
    }
    let release = store
        .projects
        .get(&stored.project_id)
        .cloned()
        .unwrap_or_default();

    let (workspace, delivery) = verify(&stored, cwd.as_deref(), &release);

    let changed = stored.workspace != workspace || stored.delivery != delivery;
    if changed
        || store.chats.get(&chat_id).map(|old| old.project_id.clone())
            != Some(stored.project_id.clone())
    {
        let _guard = LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let mut store = read();
        let entry = store.chats.entry(chat_id.clone()).or_default();
        entry.workspace = workspace.clone();
        entry.delivery = delivery.clone();
        entry.project_id = stored.project_id.clone();
        write(&store)?;
    }
    verified_at()
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .insert(chat_id.clone(), Instant::now());

    stored.workspace = workspace;
    stored.delivery = delivery;
    let status = assemble(chat_id, stored, &store);
    // Only when something actually moved: the panel is open in several tabs,
    // and an event per poll would be an event per second saying nothing.
    if changed {
        crate::bus::emit("chat-task", &status);
    }
    Ok(status)
}

/// One chat's record as the client reads it, with the project's release check
/// alongside — so the panel can say what "released" was decided against, and
/// offer to answer it when nothing has.
fn assemble(chat_id: String, stored: Stored, store: &Store) -> TaskStatus {
    let release_check = store
        .projects
        .get(&stored.project_id)
        .filter(|check| check.configured())
        .cloned();
    TaskStatus {
        chat_id,
        report: stored.report,
        target: stored.target,
        workspace: stored.workspace,
        delivery: stored.delivery,
        release_check,
        project_id: stored.project_id,
    }
}

/// Forget one chat's record, for a chat that is being deleted.
pub fn forget(chat_id: &str) {
    let _guard = LOCK.lock().unwrap_or_else(|e| e.into_inner());
    let mut store = read();
    if store.chats.remove(chat_id).is_some() {
        let _ = write(&store);
    }
    verified_at()
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .remove(chat_id);
}

// ------------------------------------------------------------ verification

/// The verified half, from git and nothing else.
fn verify(
    stored: &Stored,
    cwd: Option<&str>,
    release: &ReleaseCheck,
) -> (Option<Workspace>, Option<Delivery>) {
    let Some(cwd) = cwd.map(str::trim).filter(|value| !value.is_empty()) else {
        // A chat with no recorded directory. There is nothing to check and
        // nothing to invalidate: whatever was verified before still stands.
        return (stored.workspace.clone(), stored.delivery.clone());
    };
    let workspace = verify_workspace(cwd, stored.workspace.as_ref());
    let delivery = verify_delivery(&workspace, stored, release);
    (Some(workspace), delivery)
}

fn verify_workspace(cwd: &str, previous: Option<&Workspace>) -> Workspace {
    let exists = Path::new(cwd).is_dir();
    if !exists {
        // The worktree has been removed. Keep everything that was true of it —
        // its branch and its repository are still the answer to "where was
        // this done?" — and say only that the directory is gone.
        let mut gone = previous.cloned().unwrap_or_default();
        gone.cwd = cwd.to_string();
        gone.exists = false;
        gone.changed = 0;
        return gone;
    }
    let repo_root = run_git(cwd, &["rev-parse", "--show-toplevel"])
        .map(|value| value.trim().to_string())
        .unwrap_or_default();
    if repo_root.is_empty() {
        return Workspace {
            cwd: cwd.to_string(),
            exists: true,
            ..Workspace::default()
        };
    }
    let (ahead, behind) = ahead_behind(&repo_root);
    Workspace {
        cwd: cwd.to_string(),
        exists: true,
        is_repo: true,
        branch: branch_of(&repo_root),
        is_worktree: is_linked_worktree(&repo_root),
        primary_root: primary_root(&repo_root).unwrap_or_else(|| repo_root.clone()),
        changed: run_git(&repo_root, &["status", "--porcelain"])
            .map(|out| out.lines().filter(|line| !line.trim().is_empty()).count())
            .unwrap_or(0),
        ahead,
        behind,
        has_upstream: run_git(&repo_root, &["rev-parse", "--abbrev-ref", "@{upstream}"]).is_some(),
        repo_root,
    }
}

fn verify_delivery(
    workspace: &Workspace,
    stored: &Stored,
    release: &ReleaseCheck,
) -> Option<Delivery> {
    // Where the questions get asked. A live worktree answers for itself; a
    // removed one is answered by the primary checkout, which shares every ref
    // that matters.
    let live = workspace.exists && workspace.is_repo;
    let root = if live {
        workspace.repo_root.clone()
    } else {
        workspace.primary_root.clone()
    };
    if root.is_empty() || !Path::new(&root).is_dir() {
        return stored.delivery.clone();
    }

    let branch = workspace.branch.clone();
    let head = if live {
        run_git(&root, &["rev-parse", "HEAD"])
            .map(|value| value.trim().to_string())
            .unwrap_or_default()
    } else {
        // The branch may still exist after its worktree was removed; prefer
        // it, and fall back to the commit that was remembered.
        branch_head(&root, &branch)
            .or_else(|| stored.delivery.as_ref().map(|d| d.head.clone()))
            .unwrap_or_default()
    };
    if head.is_empty() {
        return stored.delivery.clone();
    }

    let target = stored
        .target
        .as_ref()
        .map(|target| target.branch.clone())
        .unwrap_or_else(|| default_target(&root, &branch));
    let on_target = !branch.is_empty() && branch == target;
    let remote_branch = format!("origin/{branch}");
    let remote_target = format!("origin/{target}");

    let merged = !on_target && is_ancestor(&root, &head, &target);

    // A commit that is not even in the target branch cannot be in a release,
    // and the person is reading the Merge row anyway. Asking anyway would run
    // the project's check command on every verification — several times a
    // minute across open tabs — to learn something git has already settled.
    let (released, release_note) = if merged || on_target {
        check_release(&root, &head, release)
    } else {
        (
            None,
            format!("Not in {target} yet, so there is nothing to look for in a release."),
        )
    };
    Some(Delivery {
        commits: count_commits(&root, &target, &head),
        uncommitted: workspace.changed,
        pushed: !branch.is_empty() && is_ancestor(&root, &head, &remote_branch),
        merged,
        merged_remote: !on_target && is_ancestor(&root, &head, &remote_target),
        on_target,
        released,
        release_note,
        stale: !live,
        head,
        target,
        checked_at: now_ms(),
    })
}

/// Is `commit` contained in `reference`? A reference that does not exist
/// answers no — "there is no origin/main here" is not the same as merged, and
/// both are better than an error nobody sees.
fn is_ancestor(root: &str, commit: &str, reference: &str) -> bool {
    if !ref_exists(root, reference) {
        return false;
    }
    run_git(root, &["merge-base", "--is-ancestor", commit, reference]).is_some()
}

fn ref_exists(root: &str, reference: &str) -> bool {
    run_git(
        root,
        &[
            "rev-parse",
            "--verify",
            "--quiet",
            &format!("{reference}^{{commit}}"),
        ],
    )
    .is_some()
}

fn branch_head(root: &str, branch: &str) -> Option<String> {
    if branch.is_empty() {
        return None;
    }
    run_git(
        root,
        &[
            "rev-parse",
            "--verify",
            "--quiet",
            &format!("refs/heads/{branch}"),
        ],
    )
    .map(|value| value.trim().to_string())
    .filter(|value| !value.is_empty())
}

fn count_commits(root: &str, target: &str, head: &str) -> u32 {
    if !ref_exists(root, target) {
        return 0;
    }
    run_git(root, &["rev-list", "--count", &format!("{target}..{head}")])
        .and_then(|out| out.trim().parse().ok())
        .unwrap_or(0)
}

fn branch_of(root: &str) -> String {
    let branch = run_git(root, &["branch", "--show-current"])
        .unwrap_or_default()
        .trim()
        .to_string();
    if !branch.is_empty() {
        return branch;
    }
    run_git(root, &["rev-parse", "--short", "HEAD"])
        .map(|sha| format!("({})", sha.trim()))
        .unwrap_or_else(|| "(detached)".into())
}

fn is_linked_worktree(root: &str) -> bool {
    let git_dir = run_git(root, &["rev-parse", "--path-format=absolute", "--git-dir"]);
    let common = run_git(
        root,
        &["rev-parse", "--path-format=absolute", "--git-common-dir"],
    );
    match (git_dir, common) {
        (Some(git_dir), Some(common)) => git_dir.trim() != common.trim(),
        _ => false,
    }
}

fn primary_root(root: &str) -> Option<String> {
    let common = run_git(
        root,
        &["rev-parse", "--path-format=absolute", "--git-common-dir"],
    )?;
    PathBuf::from(common.trim())
        .parent()
        .map(|parent| parent.to_string_lossy().into_owned())
}

fn ahead_behind(root: &str) -> (u32, u32) {
    let Some(counts) = run_git(
        root,
        &["rev-list", "--left-right", "--count", "HEAD...@{upstream}"],
    ) else {
        return (0, 0);
    };
    let mut parts = counts.split_whitespace();
    let ahead = parts.next().and_then(|n| n.parse().ok()).unwrap_or(0);
    let behind = parts.next().and_then(|n| n.parse().ok()).unwrap_or(0);
    (ahead, behind)
}

/// The branch work goes back to when nobody has said. The remote's own default
/// first, because that is the repository's answer rather than this machine's.
fn default_target(root: &str, branch: &str) -> String {
    if let Some(head) = run_git(
        root,
        &["symbolic-ref", "--short", "refs/remotes/origin/HEAD"],
    ) {
        if let Some(name) = head.trim().strip_prefix("origin/") {
            if !name.is_empty() {
                return name.to_string();
            }
        }
    }
    for candidate in ["main", "develop", "master"] {
        if ref_exists(root, &format!("refs/heads/{candidate}")) {
            return candidate.to_string();
        }
    }
    branch.to_string()
}

/// How long a project's release check may take before it is abandoned. It runs
/// on the request path, and a check that hangs would hang the panel.
const RELEASE_CHECK_TIMEOUT: Duration = Duration::from_secs(15);

/// Is this commit in what is actually running? Answers `None` — "unverified" —
/// whenever the project has not said how to tell, which is most of them.
fn check_release(root: &str, head: &str, check: &ReleaseCheck) -> (Option<bool>, String) {
    if let Some(reference) = check
        .reference
        .as_deref()
        .map(str::trim)
        .filter(|r| !r.is_empty())
    {
        if !ref_exists(root, reference) {
            return (
                None,
                format!("The release ref '{reference}' does not exist in this repository."),
            );
        }
        let released = is_ancestor(root, head, reference);
        return (Some(released), format!("Compared against {reference}."));
    }
    if let Some(command) = check
        .command
        .as_deref()
        .map(str::trim)
        .filter(|c| !c.is_empty())
    {
        return match run_release_command(root, command) {
            Err(why) => (None, why),
            Ok(output) => match find_commit(&output) {
                None => (
                    None,
                    "The release check printed no commit to compare against.".into(),
                ),
                Some(found) => {
                    if !ref_exists(root, &found) {
                        return (
                            None,
                            format!("The release check named {found}, which this repository does not have."),
                        );
                    }
                    (
                        Some(is_ancestor(root, head, &found)),
                        format!("The release check reports {} running.", short(&found)),
                    )
                }
            },
        };
    }
    (
        None,
        "No release check is configured for this project.".into(),
    )
}

fn short(sha: &str) -> String {
    sha.chars().take(9).collect()
}

/// The first hex string long enough to be a commit. Release checks print
/// prose; the commit is the part that matters and the rest is noise.
fn find_commit(output: &str) -> Option<String> {
    let mut run = String::new();
    let mut best: Option<String> = None;
    for ch in output.chars().chain(std::iter::once(' ')) {
        if ch.is_ascii_hexdigit() {
            run.push(ch);
            continue;
        }
        if (7..=40).contains(&run.len()) && best.is_none() {
            best = Some(run.to_lowercase());
        }
        run.clear();
    }
    best
}

/// Run the project's release check, with a deadline. This is the one place in
/// the module that runs something other than git, and it runs only what the
/// person configured for their own project.
fn run_release_command(root: &str, command: &str) -> Result<String, String> {
    let mut cmd = Command::new("sh");
    cmd.arg("-c")
        .arg(command)
        .current_dir(root)
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped());
    crate::proc::no_console(&mut cmd);
    let mut child = cmd
        .spawn()
        .map_err(|e| format!("The release check could not be started: {e}"))?;
    let started = Instant::now();
    loop {
        match child.try_wait() {
            Err(e) => return Err(format!("The release check failed: {e}")),
            Ok(Some(_)) => break,
            Ok(None) => {
                if started.elapsed() > RELEASE_CHECK_TIMEOUT {
                    let _ = child.kill();
                    return Err("The release check took too long and was stopped.".into());
                }
                std::thread::sleep(Duration::from_millis(50));
            }
        }
    }
    let out = child
        .wait_with_output()
        .map_err(|e| format!("The release check failed: {e}"))?;
    let mut text = String::from_utf8_lossy(&out.stdout).into_owned();
    text.push('\n');
    text.push_str(&String::from_utf8_lossy(&out.stderr));
    Ok(text)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_commit_is_picked_out_of_ordinary_output() {
        let out = "octiq-server up since 12:04\nbuild 6f728a5c9de0 · web/dist ahead: no\n";
        assert_eq!(find_commit(out), Some("6f728a5c9de0".into()));
    }

    #[test]
    fn short_hex_words_are_not_commits() {
        // "up", "since" and a port number are hex-ish or too short; nothing
        // here should be read as a commit.
        assert_eq!(find_commit("listening on 1421, state ok\n"), None);
    }

    #[test]
    fn a_report_replaces_the_plan_whole_and_normalises_states() {
        let steps = vec![
            TaskStep {
                title: " Design ".into(),
                state: "done".into(),
            },
            TaskStep {
                title: "Build".into(),
                state: "running".into(),
            },
            TaskStep {
                title: "   ".into(),
                state: "done".into(),
            },
        ];
        let chat = format!("status-test-{}", now_ms());
        let status = chat_task_report_impl(
            chat.clone(),
            "  Keep the chat's place visible  ".into(),
            "Wiring the panel".into(),
            steps,
            "claude".into(),
        )
        .expect("report");
        let report = status.report.expect("a report");
        assert_eq!(report.objective, "Keep the chat's place visible");
        assert_eq!(report.steps.len(), 2, "the blank step is dropped");
        assert_eq!(report.steps[0].title, "Design");
        assert_eq!(
            report.steps[1].state, "pending",
            "an unknown state is read as pending, not kept"
        );
        forget(&chat);
    }

    #[test]
    fn an_objective_is_required() {
        let out = chat_task_report_impl(
            "nobody".into(),
            "   ".into(),
            String::new(),
            vec![],
            "claude".into(),
        );
        assert!(out.is_err(), "an empty objective is not a report");
    }

    #[test]
    fn an_unmerged_branch_does_not_run_the_projects_release_check() {
        let dir = scratch_repo("guard");
        let at = dir.to_string_lossy().to_string();
        let git = |args: &[&str]| run_git(&at, args).expect("git");
        git(&["checkout", "-b", "feature/thing"]);
        git(&["commit", "--allow-empty", "-m", "work"]);

        let delivery = verify_delivery(
            &verify_workspace(&at, None),
            &Stored::default(),
            &ReleaseCheck {
                // Running this would fail the test by writing the file.
                command: Some(format!("touch {at}/release-check-ran")),
                ..ReleaseCheck::default()
            },
        )
        .expect("a delivery");
        assert_eq!(delivery.released, None);
        assert!(delivery.release_note.contains("Not in main yet"));
        assert!(
            !Path::new(&dir).join("release-check-ran").exists(),
            "a branch git says is unmerged cannot be released; do not go and ask"
        );
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_release_check_nobody_configured_is_unverified_not_no() {
        let (released, note) = check_release("/", "deadbeef", &ReleaseCheck::default());
        assert_eq!(released, None);
        assert!(note.contains("No release check"));
    }

    /// A throwaway repository with one commit on `main`. Real git, because
    /// every answer in this module is git's answer and a mocked one would
    /// prove nothing.
    fn scratch_repo(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "octiq-task-{name}-{}-{}",
            std::process::id(),
            now_ms()
        ));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).expect("temp dir");
        let at = dir.to_string_lossy().to_string();
        let git = |args: &[&str]| {
            run_git(&at, args).unwrap_or_else(|| panic!("git {args:?} failed in {at}"))
        };
        git(&["init", "-b", "main"]);
        git(&["config", "user.email", "test@example.com"]);
        git(&["config", "user.name", "Test"]);
        git(&["commit", "--allow-empty", "-m", "first"]);
        dir
    }

    #[test]
    fn a_branch_is_owed_a_merge_until_it_is_in_the_target() {
        let dir = scratch_repo("merge");
        let at = dir.to_string_lossy().to_string();
        let git = |args: &[&str]| run_git(&at, args).expect("git");
        git(&["checkout", "-b", "feature/thing"]);
        git(&["commit", "--allow-empty", "-m", "work"]);

        let stored = Stored {
            target: Some(TaskTarget {
                branch: "main".into(),
                set_at: now_ms(),
                set_by: "test".into(),
            }),
            ..Stored::default()
        };
        let workspace = verify_workspace(&at, None);
        assert!(workspace.is_repo && !workspace.is_worktree);
        assert_eq!(workspace.branch, "feature/thing");

        let before =
            verify_delivery(&workspace, &stored, &ReleaseCheck::default()).expect("a delivery");
        assert_eq!(before.target, "main");
        assert_eq!(before.commits, 1, "one commit main does not have");
        assert!(!before.merged, "nothing has been merged yet");
        assert_eq!(
            before.released, None,
            "with no release check the answer is unverified, never no"
        );

        // The merge itself is the only thing that moves it.
        git(&["checkout", "main"]);
        git(&["merge", "--no-ff", "--no-edit", "feature/thing"]);
        git(&["checkout", "feature/thing"]);
        let after = verify_delivery(
            &verify_workspace(&at, None),
            &stored,
            &ReleaseCheck {
                reference: Some("main".into()),
                ..ReleaseCheck::default()
            },
        )
        .expect("a delivery");
        assert!(after.merged, "the branch is now contained in main");
        assert_eq!(after.commits, 0);
        assert_eq!(
            after.released,
            Some(true),
            "a release ref that contains the commit answers yes"
        );
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_release_ref_that_does_not_contain_the_commit_answers_no() {
        let dir = scratch_repo("release");
        let at = dir.to_string_lossy().to_string();
        let git = |args: &[&str]| run_git(&at, args).expect("git");
        // `release` is left behind at the first commit; main moves on.
        git(&["branch", "release"]);
        git(&["commit", "--allow-empty", "-m", "after the release"]);

        let workspace = verify_workspace(&at, None);
        let delivery = verify_delivery(
            &workspace,
            &Stored::default(),
            &ReleaseCheck {
                reference: Some("release".into()),
                ..ReleaseCheck::default()
            },
        )
        .expect("a delivery");
        assert!(delivery.on_target, "this chat is on the default branch");
        assert_eq!(delivery.released, Some(false));
        assert!(delivery.release_note.contains("release"));
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_release_command_is_read_for_the_commit_it_names() {
        let dir = scratch_repo("command");
        let at = dir.to_string_lossy().to_string();
        let head = run_git(&at, &["rev-parse", "HEAD"])
            .expect("head")
            .trim()
            .to_string();
        let delivery = verify_delivery(
            &verify_workspace(&at, None),
            &Stored::default(),
            &ReleaseCheck {
                command: Some(format!("echo 'octiq-server up · build {head} · ok'")),
                ..ReleaseCheck::default()
            },
        )
        .expect("a delivery");
        assert_eq!(
            delivery.released,
            Some(true),
            "the running build names this commit"
        );

        // A check that says nothing usable is unverified, not a failure state.
        let quiet = verify_delivery(
            &verify_workspace(&at, None),
            &Stored::default(),
            &ReleaseCheck {
                command: Some("echo 'service is up'".into()),
                ..ReleaseCheck::default()
            },
        )
        .expect("a delivery");
        assert_eq!(quiet.released, None);
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn the_target_survives_the_worktree_being_removed() {
        // A directory that is not there any more keeps everything that was
        // verified about it, and only says the directory is gone.
        let previous = Workspace {
            cwd: "/gone/feature".into(),
            exists: true,
            is_repo: true,
            repo_root: "/gone/feature".into(),
            primary_root: "/repo".into(),
            branch: "feature/thing".into(),
            is_worktree: true,
            changed: 4,
            ..Workspace::default()
        };
        let now = verify_workspace("/gone/feature", Some(&previous));
        assert!(!now.exists);
        assert_eq!(now.branch, "feature/thing");
        assert_eq!(now.primary_root, "/repo");
        assert_eq!(now.changed, 0, "a directory that is gone has no changes");
    }
}
