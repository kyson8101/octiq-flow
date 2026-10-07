//! Deterministic Git operations for task-owned workspaces. No agent text is
//! interpreted as a command, a merge result, or permission to remove a tree.
use super::{
    current_branch, ensure_local_branch, is_linked_worktree, primary_checkout_root, run_git_mut,
};
use crate::paths::Canonical;
use serde::{Deserialize, Serialize};
use std::path::Path;
use std::process::Command;

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum WorkspaceMode {
    #[default]
    Auto,
    Worktree,
    Direct,
    /// One worktree per repository for the whole mission, on
    /// `feature/mission-<run>`, shared by its tasks one writer at a time.
    /// Follow-up work lands on the same branch; closing the mission is what
    /// removes it.
    Mission,
}

impl WorkspaceMode {
    /// A managed linked worktree this workflow created and may remove.
    pub fn is_worktree(self) -> bool {
        matches!(self, WorkspaceMode::Worktree | WorkspaceMode::Mission)
    }
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspacePlan {
    pub mode: WorkspaceMode,
    #[serde(deserialize_with = "crate::paths::de_simplified")]
    pub cwd: String,
    #[serde(deserialize_with = "crate::paths::de_simplified")]
    pub checkout_root: String,
    #[serde(deserialize_with = "crate::paths::de_simplified")]
    pub repository_root: String,
    pub branch: String,
    pub base_branch: String,
    pub base_sha: String,
    /// Only worktrees created by this workflow can be removed by it.
    pub managed: bool,
    pub is_repo: bool,
    pub warnings: Vec<String>,
    pub initial_status: String,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DeliveryEvidence {
    pub head_sha: String,
    pub dirty: bool,
    pub has_commits: bool,
    pub pushed: bool,
    pub remote_branch: Option<String>,
    pub pull_request: Option<String>,
    pub review_state: Option<String>,
    pub merged: bool,
    /// In what is actually running, by the project's own release check.
    /// `None` until merged, and whenever the project has no release check:
    /// unverified, never "no" (feedback ee0a43b0).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub released: Option<bool>,
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub release_note: String,
    pub checked_at: i64,
    pub notes: Vec<String>,
}

fn git(root: &str, args: &[&str]) -> Result<String, String> {
    let output = Command::new("git")
        .arg("-C")
        .arg(root)
        .args(args)
        .env("GIT_TERMINAL_PROMPT", "0")
        .env("GIT_SSH_COMMAND", "ssh -o BatchMode=yes")
        // A read (a plan preview's `git status` above all) must not refresh
        // the index behind a person's back; mutations go through run_git_mut.
        .env("GIT_OPTIONAL_LOCKS", "0")
        .output()
        .map_err(|e| format!("Could not run Git: {e}"))?;
    if !output.status.success() {
        return Err(String::from_utf8_lossy(&output.stderr).trim().to_string());
    }
    Ok(String::from_utf8_lossy(&output.stdout)
        .trim_end()
        .to_string())
}

pub fn checkout_identity(path: &str) -> Result<String, String> {
    let shown = path;
    let path = Path::new(path)
        .canonical()
        .map_err(|e| format!("Workspace does not exist: {shown}: {e}"))?;
    let path = path.to_string_lossy().into_owned();
    let root = git(&path, &["rev-parse", "--show-toplevel"]).unwrap_or(path);
    Path::new(&root)
        .canonical()
        .map(|p| p.to_string_lossy().into_owned())
        .map_err(|e| e.to_string())
}

/// The checkout ANOTHER chat or attempt holds, for an overlap check only.
///
/// Feedback dda0bd59 / ed5ab9e3: a directory deleted under a live chat, or a
/// stale attempt's removed worktree, made `checkout_identity` fail, and its
/// `?` refused every dispatch in every run with a path-less ENOENT. A path
/// that is gone holds nothing, so it is compared as written: it still clashes
/// with a checkout it literally names, and with nothing else.
pub fn held_checkout(path: &str) -> String {
    checkout_identity(path).unwrap_or_else(|_| path.to_string())
}

/// Whether `root` is inside a Git repository, the same test `plan` makes.
pub fn has_git(root: &str) -> bool {
    checkout_identity(root)
        .is_ok_and(|checkout| git(&checkout, &["rev-parse", "--git-common-dir"]).is_ok())
}

pub fn overlaps(a: &str, b: &str) -> bool {
    Path::new(a).starts_with(b) || Path::new(b).starts_with(a)
}

/// Whether another chat working in `other` (a [`held_checkout`]) shares a
/// writer's `checkout`.
///
/// A managed worktree is a folder nobody else was given, so only a chat that
/// works INSIDE it shares it. A chat in a folder above it — a project that
/// lists the plain folder its repositories sit in, say — was not handed this
/// worktree, and counting it refused every worktree under that folder with
/// "already using this checkout" (feedback 63e319a4). Every other checkout
/// keeps the strict rule both ways.
pub fn shares_checkout(checkout: &str, other: &str, managed_worktree: bool) -> bool {
    if managed_worktree {
        Path::new(other).starts_with(checkout)
    } else {
        overlaps(checkout, other)
    }
}

pub fn plan(
    root: &str,
    base: &str,
    task_id: &str,
    mode: WorkspaceMode,
) -> Result<WorkspacePlan, String> {
    let cwd = Path::new(root)
        .canonical()
        .map_err(|e| e.to_string())?
        .to_string_lossy()
        .into_owned();
    let checkout = checkout_identity(&cwd)?;
    let is_repo = git(&checkout, &["rev-parse", "--git-common-dir"]).is_ok();
    if !is_repo {
        // A mission in a folder with no Git history has nothing to branch:
        // it works in the folder, like Current checkout, rather than failing
        // every task it plans.
        if !matches!(mode, WorkspaceMode::Direct | WorkspaceMode::Mission) {
            return Err(
                "Worktree mode requires a Git repository. Select Current checkout for this folder."
                    .into(),
            );
        }
        return Ok(WorkspacePlan {
            mode: WorkspaceMode::Direct,
            cwd: cwd.clone(),
            checkout_root: checkout.clone(),
            repository_root: checkout,
            branch: String::new(),
            base_branch: String::new(),
            base_sha: String::new(),
            managed: false,
            is_repo,
            warnings: vec!["This folder has no Git history. Changes are made directly.".into()],
            initial_status: String::new(),
        });
    }
    let current = current_branch(&checkout)?;
    let status = git(
        &checkout,
        &["status", "--porcelain=v1", "--untracked-files=all"],
    )?;
    let primary = primary_checkout_root(&checkout)?
        .canonical()
        .map_err(|e| e.to_string())?;
    if mode == WorkspaceMode::Direct {
        if !base.is_empty() && base != current {
            return Err("Current checkout mode never switches branches. Select its current branch or use Worktree mode.".into());
        }
        let mut warnings = Vec::new();
        if !is_linked_worktree(&checkout) {
            warnings.push("Changes will be made in the primary checkout.".into());
        }
        if !status.is_empty() {
            warnings.push("Existing uncommitted changes must be preserved.".into());
        }
        let base_sha = git(&checkout, &["rev-parse", "HEAD"])?;
        return Ok(WorkspacePlan {
            mode,
            cwd,
            checkout_root: checkout,
            repository_root: primary.to_string_lossy().into_owned(),
            branch: current.clone(),
            base_branch: current,
            base_sha,
            managed: false,
            is_repo,
            warnings,
            initial_status: status,
        });
    }
    let base = if base.is_empty() { &current } else { base };
    ensure_local_branch(&checkout, base)?;
    let base_sha = git(&checkout, &["rev-parse", &format!("refs/heads/{base}")])?;
    // A mission's workspace is keyed by its run, so every task in it plans the
    // same branch and path; a task's own by the task.
    let mission = mode == WorkspaceMode::Mission;
    let id = task_id
        .strip_prefix(if mission { "run_" } else { "task_" })
        .unwrap_or(task_id);
    if id.is_empty() || !id.bytes().all(|c| c.is_ascii_alphanumeric() || c == b'-') {
        return Err("Invalid task ID for a workspace.".into());
    }
    let branch = if mission {
        format!("feature/mission-{id}")
    } else {
        format!("feature/octiq-{id}")
    };
    let mut target = primary
        .parent()
        .ok_or("Repository has no parent directory.")?
        .join(".worktrees")
        .join(
            primary
                .file_name()
                .ok_or("Repository has no folder name.")?,
        );
    // One segment at a time: joined whole, `feature/octiq-x` keeps its `/` on
    // Windows and the path never equals its own canonical form again.
    target.extend(branch.split('/'));
    let relative = Path::new(&cwd)
        .strip_prefix(&checkout)
        .map_err(|e| e.to_string())?;
    Ok(WorkspacePlan {
        mode: if mission {
            WorkspaceMode::Mission
        } else {
            WorkspaceMode::Worktree
        },
        cwd: target.join(relative).to_string_lossy().into_owned(),
        checkout_root: target.to_string_lossy().into_owned(),
        repository_root: primary.to_string_lossy().into_owned(),
        branch,
        base_branch: base.into(),
        base_sha,
        managed: true,
        is_repo,
        warnings: Vec::new(),
        initial_status: String::new(),
    })
}

/// What already occupies a managed plan's branch or path, read without
/// touching either. `provision` adopts an existing path it recognises, which is
/// right for a retry and wrong for a first launch: before a task has a
/// workspace, anything already there belongs to someone else.
pub fn occupied(plan: &WorkspacePlan) -> Option<String> {
    if !plan.managed {
        return None;
    }
    // A mission's later tasks find its worktree already there, made by this
    // workflow for this path — that is the point of it, not a collision.
    if plan.mode == WorkspaceMode::Mission && owned_here(plan) {
        return None;
    }
    let branch = git(
        &plan.repository_root,
        &[
            "show-ref",
            "--verify",
            "--quiet",
            &format!("refs/heads/{}", plan.branch),
        ],
    )
    .is_ok();
    let path = Path::new(&plan.checkout_root).exists();
    match (branch, path) {
        (false, false) => None,
        (true, false) => Some(format!("Branch {} already exists.", plan.branch)),
        (false, true) => Some(format!("{} already exists.", plan.checkout_root)),
        (true, true) => Some(format!(
            "Branch {} and {} already exist.",
            plan.branch, plan.checkout_root
        )),
    }
}

/// The plan's branch exists and records this very path as its owner — the
/// mark `provision` leaves, and nothing else writes.
fn owned_here(plan: &WorkspacePlan) -> bool {
    git(
        &plan.repository_root,
        &[
            "config",
            "--get",
            &format!("branch.{}.octiqWorkspace", plan.branch),
        ],
    )
    .is_ok_and(|owner| owner == plan.checkout_root)
}

/// A persisted plan is written before this runs. Retrying uses the SAME branch
/// and path; it never allocates a numbered replacement and loses the old work.
pub fn provision(plan: &WorkspacePlan) -> Result<(), String> {
    if !plan.managed {
        return verify(plan);
    }
    if Path::new(&plan.checkout_root).exists() {
        return verify(plan);
    }
    let owner_key = format!("branch.{}.octiqWorkspace", plan.branch);
    let existing_owner = git(&plan.repository_root, &["config", "--get", &owner_key]).ok();
    let branch_exists = git(
        &plan.repository_root,
        &[
            "show-ref",
            "--verify",
            &format!("refs/heads/{}", plan.branch),
        ],
    )
    .is_ok();
    if branch_exists && existing_owner.as_deref() != Some(plan.checkout_root.as_str()) {
        return Err("The planned branch already exists and is not owned by this workspace.".into());
    }
    std::fs::create_dir_all(
        Path::new(&plan.checkout_root)
            .parent()
            .ok_or("Workspace has no parent.")?,
    )
    .map_err(|e| e.to_string())?;
    if branch_exists {
        run_git_mut(
            &plan.repository_root,
            &["worktree", "add", &plan.checkout_root, &plan.branch],
            false,
        )?;
    } else {
        // Disable tracking even if the person's branch.autoSetupMerge is always.
        run_git_mut(
            &plan.repository_root,
            &[
                "worktree",
                "add",
                "--no-track",
                "-b",
                &plan.branch,
                &plan.checkout_root,
                &plan.base_sha,
            ],
            false,
        )?;
    }
    run_git_mut(
        &plan.repository_root,
        &["config", &owner_key, &plan.checkout_root],
        false,
    )?;
    verify(plan)
}

pub fn verify(plan: &WorkspacePlan) -> Result<(), String> {
    verify_checkout(plan)?;
    if plan.is_repo && current_branch(&plan.cwd)? != plan.branch {
        return Err(
            "The assigned workspace branch changed. Restore its branch before continuing.".into(),
        );
    }
    Ok(())
}

/// `verify` short of the branch: the folder is still this task's checkout of
/// this repository, whatever it has checked out. A reviewer told to detach at
/// the exact head it reviews is still in its own workspace.
fn verify_checkout(plan: &WorkspacePlan) -> Result<(), String> {
    if !Path::new(&plan.cwd).is_dir() {
        return Err(format!(
            "The assigned workspace is missing: {}. Restore it before retrying.",
            plan.cwd
        ));
    }
    if checkout_identity(&plan.cwd)? != plan.checkout_root {
        return Err(
            "The assigned checkout path changed; refusing to use another workspace.".into(),
        );
    }
    if plan.is_repo {
        let primary = primary_checkout_root(&plan.cwd)?
            .canonical()
            .map_err(|e| e.to_string())?;
        if primary != Path::new(&plan.repository_root) {
            return Err("The assigned workspace belongs to a different repository.".into());
        }
        if plan.managed && !is_linked_worktree(&plan.cwd) {
            return Err("A managed workspace must be a linked worktree.".into());
        }
    }
    Ok(())
}

pub fn inspect(plan: &WorkspacePlan, check_remote: bool) -> Result<DeliveryEvidence, String> {
    verify(plan)?;
    let mut result = DeliveryEvidence {
        checked_at: std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_millis() as i64,
        ..Default::default()
    };
    if !plan.is_repo {
        result.notes.push("Delivery tracking requires Git.".into());
        return Ok(result);
    }
    result.head_sha = git(&plan.cwd, &["rev-parse", "HEAD"])?;
    result.dirty = !git(
        &plan.cwd,
        &["status", "--porcelain=v1", "--untracked-files=all"],
    )?
    .is_empty();
    result.has_commits = result.head_sha != plan.base_sha;
    result.remote_branch = git(
        &plan.cwd,
        &[
            "rev-parse",
            "--abbrev-ref",
            "--symbolic-full-name",
            "@{upstream}",
        ],
    )
    .ok();
    if check_remote {
        if let (Ok(remote), Ok(branch)) = (
            git(
                &plan.cwd,
                &["config", "--get", &format!("branch.{}.remote", plan.branch)],
            ),
            git(
                &plan.cwd,
                &["config", "--get", &format!("branch.{}.merge", plan.branch)],
            ),
        ) {
            if remote != "." && !remote.starts_with('-') && branch.starts_with("refs/heads/") {
                match git(&plan.cwd, &["ls-remote", "--exit-code", &remote, &branch]) {
                    Ok(tip) => {
                        result.pushed =
                            tip.split_whitespace().next() == Some(result.head_sha.as_str())
                    }
                    Err(_) => result
                        .notes
                        .push("Could not verify the current commit on its remote branch.".into()),
                }
            }
        }
        // gh resolves the repo from this checkout. A PR for a different head is
        // evidence about older work, never cleanup permission for this HEAD.
        if let Ok(output) = Command::new("gh")
            .args([
                "pr",
                "view",
                &plan.branch,
                "--json",
                "url,state,headRefOid,baseRefName,reviewDecision",
            ])
            .current_dir(&plan.cwd)
            .env("GH_PROMPT_DISABLED", "1")
            .output()
        {
            if output.status.success() {
                if let Ok(pr) = serde_json::from_slice::<serde_json::Value>(&output.stdout) {
                    if pr["headRefOid"].as_str() == Some(&result.head_sha)
                        && pr["baseRefName"].as_str() == Some(&plan.base_branch)
                    {
                        result.pull_request = pr["url"].as_str().map(str::to_owned);
                        result.review_state = pr["reviewDecision"]
                            .as_str()
                            .filter(|s| !s.is_empty())
                            .map(str::to_owned);
                        result.merged = pr["state"].as_str() == Some("MERGED");
                        // A matching PR proves the commit was published even if
                        // GitHub deleted the branch after a squash merge.
                        result.pushed |= result.merged;
                    } else {
                        result.notes.push(
                            "The PR head or base differs from this workspace; merge is unverified."
                                .into(),
                        );
                    }
                }
            }
        }
        // Without a PR, the exact HEAD must be in the base branch's tip on its
        // remote. Never use `git branch -d` or the branch's upstream as a
        // merge gate. The task branch need not have been pushed: a lead who
        // fast-forwards the base and pushes that leaves no other trace, and
        // asking for the branch too hid cleanup for every such task
        // (feedback 1becac39, 9b1e8978).
        if result.pull_request.is_none() && plan.branch != plan.base_branch {
            match merged_into_remote_base(plan, &result.head_sha) {
                Some(merged) => {
                    result.merged = merged;
                    // In the remote base, the commit is published.
                    result.pushed |= merged;
                }
                None => result.notes.push(format!(
                    "Could not compare this commit with {} on its remote; merge is unverified.",
                    plan.base_branch
                )),
            }
        }
    }
    Ok(result)
}

/// Whether `head` is already in the base branch on its remote, read without
/// the mission branch ever having been pushed: a lead who fast-forwards the
/// base locally and pushes it leaves exactly this behind, and no PR. The
/// remote is the base branch's own, else `origin`. Asks the remote; never
/// fetches. `None` when the remote could not be asked, or the tip it names is
/// not here to compare against.
pub fn merged_into_remote_base(plan: &WorkspacePlan, head: &str) -> Option<bool> {
    if !plan.is_repo || plan.base_branch.is_empty() || head.is_empty() {
        return None;
    }
    let remote = git(
        &plan.repository_root,
        &[
            "config",
            "--get",
            &format!("branch.{}.remote", plan.base_branch),
        ],
    )
    .ok()
    .filter(|r| r != "." && !r.starts_with('-'))
    .unwrap_or_else(|| "origin".into());
    let tip = git(
        &plan.repository_root,
        &[
            "ls-remote",
            "--exit-code",
            &remote,
            &format!("refs/heads/{}", plan.base_branch),
        ],
    )
    .ok()?;
    let sha = tip.split_whitespace().next()?.to_string();
    git(
        &plan.repository_root,
        &["cat-file", "-e", &format!("{sha}^{{commit}}")],
    )
    .ok()?;
    Some(
        git(
            &plan.repository_root,
            &["merge-base", "--is-ancestor", head, &sha],
        )
        .is_ok(),
    )
}

/// Delete a closed mission's LOCAL branch, with `-d`: Git itself refuses one
/// that is not merged, so this can never lose a commit. The remote branch is
/// never touched. `Ok(false)` when Git kept it — a squash merge, say — which
/// is reported, not forced.
pub fn delete_merged_branch(plan: &WorkspacePlan) -> Result<bool, String> {
    if !plan.managed || plan.mode != WorkspaceMode::Mission || !owned_here(plan) {
        return Ok(false);
    }
    if Path::new(&plan.checkout_root).exists() {
        return Err("Remove the mission's worktree before its branch.".into());
    }
    Ok(run_git_mut(
        &plan.repository_root,
        &["branch", "-d", &plan.branch],
        false,
    )
    .is_ok())
}

pub fn cleanup(plan: &WorkspacePlan, expected_head: &str) -> Result<(), String> {
    if !plan.managed || !plan.mode.is_worktree() {
        return Err(
            "Current checkout and adopted workspaces are never removed automatically.".into(),
        );
    }
    verify(plan)?;
    let evidence = inspect(plan, false)?;
    if evidence.dirty || evidence.head_sha != expected_head {
        return Err("Workspace changed during cleanup checks. Refresh and try again.".into());
    }
    // No --force: Git also checks untracked files, locked worktrees and
    // submodules. Keep branches and all published history available.
    run_git_mut(
        &plan.repository_root,
        &["worktree", "remove", &plan.checkout_root],
        false,
    )?;
    Ok(())
}

/// Detached validation checkout for a committed patch range. The source tree,
/// index and uncommitted edits are never touched; callers remove it separately.
pub fn validation_worktree(
    plan: &WorkspacePlan,
    base: &str,
    commits: &[String],
    target: &Path,
) -> Result<(), String> {
    // Built from the repository at exact commits, so what the task checkout
    // has checked out does not matter (feedback ef927bf0 / 6b1d8eba).
    verify_checkout(plan)?;
    let exact = |sha: &str| -> Result<String, String> {
        if sha.len() < 7 || !sha.bytes().all(|b| b.is_ascii_hexdigit()) {
            return Err("Validation requires exact commit SHAs.".into());
        }
        git(
            &plan.cwd,
            &["rev-parse", "--verify", &format!("{sha}^{{commit}}")],
        )
    };
    let base = exact(base)?;
    let commits = commits
        .iter()
        .map(|c| exact(c))
        .collect::<Result<Vec<_>, _>>()?;
    if target.exists() {
        return Err("Validation target already exists.".into());
    }
    run_git_mut(
        &plan.repository_root,
        &[
            "worktree",
            "add",
            "--detach",
            &target.to_string_lossy(),
            &base,
        ],
        false,
    )?;
    for commit in commits {
        // Commits keep a successful validation checkout clean and removable;
        // conflicts are retained for inspection, never forcibly discarded.
        run_git_mut(
            &target.to_string_lossy(),
            &[
                "-c",
                "user.name=OctiqFlow validation",
                "-c",
                "user.email=validation@localhost",
                "-c",
                "commit.gpgSign=false",
                "cherry-pick",
                &commit,
            ],
            false,
        )?;
    }
    Ok(())
}

pub fn remove_validation(plan: &WorkspacePlan, path: &str) -> Result<(), String> {
    if !Path::new(path).exists() {
        // Removing an already absent path needs no filesystem mutation. The
        // caller only removes its own recorded allocation.
        return Ok(());
    }
    if checkout_identity(path)? != path {
        return Err("Validation checkout path changed.".into());
    }
    if primary_checkout_root(path)?
        .canonical()
        .map_err(|e| e.to_string())?
        != Path::new(&plan.repository_root)
    {
        return Err("Validation checkout belongs to a different repository.".into());
    }
    if git(path, &["symbolic-ref", "-q", "HEAD"]).is_ok() {
        return Err(
            "Validation checkout now has a branch. Preserve it manually before removal.".into(),
        );
    }
    run_git_mut(&plan.repository_root, &["worktree", "remove", path], false)?;
    Ok(())
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;
    pub(crate) struct Repo {
        pub dir: crate::test_dir::TestDir,
        pub root: String,
    }
    impl Repo {
        pub(crate) fn new() -> Self {
            let dir = crate::test_dir::TestDir::new("workflow-test").canonicalized();
            std::fs::create_dir_all(dir.join("repo")).unwrap();
            let root = dir.join("repo").to_string_lossy().into_owned();
            git(&root, &["init", "-b", "main"]).unwrap();
            git(&root, &["config", "user.name", "Workflow test"]).unwrap();
            git(&root, &["config", "user.email", "test@localhost"]).unwrap();
            git(&root, &["config", "commit.gpgSign", "false"]).unwrap();
            // Checkouts are compared byte for byte; Git for Windows installs
            // with core.autocrlf=true, which would write "\r\n" into them.
            git(&root, &["config", "core.autocrlf", "false"]).unwrap();
            std::fs::write(Path::new(&root).join("source.txt"), "original\n").unwrap();
            git(&root, &["add", "."]).unwrap();
            git(&root, &["commit", "-m", "base"]).unwrap();
            Self { dir, root }
        }
        pub(crate) fn git(&self, args: &[&str]) -> String {
            git(&self.root, args).unwrap()
        }
        pub(crate) fn commit(&self, cwd: &str, file: &str, value: &str) -> String {
            std::fs::write(Path::new(cwd).join(file), value).unwrap();
            git(cwd, &["add", file]).unwrap();
            git(cwd, &["commit", "-m", "test change"]).unwrap();
            git(cwd, &["rev-parse", "HEAD"]).unwrap()
        }
        pub(crate) fn remote(&self) {
            let remote = self.dir.join("remote.git");
            git(&self.root, &["init", "--bare", &remote.to_string_lossy()]).unwrap();
            self.git(&["remote", "add", "origin", &remote.to_string_lossy()]);
            self.git(&["push", "-u", "origin", "main"]);
        }
    }
    pub(crate) fn push_branch(cwd: &str, branch: &str) {
        git(cwd, &["push", "-u", "origin", branch]).unwrap();
    }
    #[test]
    fn a_mission_in_a_folder_without_git_works_in_place() {
        let dir = crate::test_dir::TestDir::new("workflow-plain").canonicalized();
        let root = dir.to_string_lossy().into_owned();
        let p = plan(&root, "", "run_abc", WorkspaceMode::Mission).unwrap();
        assert_eq!(p.mode, WorkspaceMode::Direct);
        assert!(!p.managed && p.branch.is_empty());
    }
    #[test]
    fn stable_allocation_preserves_primary_and_disables_inherited_tracking() {
        let repo = Repo::new();
        repo.git(&["config", "branch.autoSetupMerge", "always"]);
        std::fs::write(
            Path::new(&repo.root).join("source.txt"),
            "existing user edits\n",
        )
        .unwrap();
        let p = plan(&repo.root, "main", "task_test", WorkspaceMode::Worktree).unwrap();
        let again = plan(&repo.root, "main", "task_test", WorkspaceMode::Worktree).unwrap();
        assert_eq!(p.checkout_root, again.checkout_root);
        provision(&p).unwrap();
        provision(&p).unwrap();
        assert_eq!(repo.git(&["branch", "--show-current"]), "main");
        assert_eq!(
            std::fs::read_to_string(Path::new(&repo.root).join("source.txt")).unwrap(),
            "existing user edits\n"
        );
        assert!(git(&p.cwd, &["rev-parse", "@{upstream}"]).is_err());
        assert_eq!(
            std::fs::read_to_string(Path::new(&p.cwd).join("source.txt")).unwrap(),
            "original\n"
        );
    }

    #[test]
    fn direct_mode_preserves_changes_reports_real_branch_and_never_removes_it() {
        let repo = Repo::new();
        std::fs::write(Path::new(&repo.root).join("user.txt"), "keep").unwrap();
        let p = plan(&repo.root, "", "task_direct", WorkspaceMode::Direct).unwrap();
        assert_eq!(p.branch, "main");
        assert_eq!(p.warnings.len(), 2);
        assert!(p.initial_status.contains("user.txt"));
        assert!(!p.managed);
        provision(&p).unwrap();
        assert!(plan(
            &repo.root,
            "different",
            "task_direct",
            WorkspaceMode::Direct
        )
        .is_err());
        assert!(cleanup(&p, &p.base_sha).is_err());
        assert!(Path::new(&repo.root).join("user.txt").exists());
    }

    #[test]
    fn checkout_identity_resolves_subdirectories_and_aliases() {
        let repo = Repo::new();
        std::fs::create_dir(Path::new(&repo.root).join("nested")).unwrap();
        let alias = repo.dir.join("alias");
        #[cfg(unix)]
        std::os::unix::fs::symlink(&repo.root, &alias).unwrap();
        #[cfg(unix)]
        assert_eq!(
            checkout_identity(&alias.join("nested").to_string_lossy()).unwrap(),
            repo.root
        );
        assert_eq!(
            checkout_identity(&format!("{}/nested", repo.root)).unwrap(),
            repo.root
        );
    }

    /// Feedback dda0bd59 / ed5ab9e3: someone else's vanished folder is not an
    /// error for this dispatch. It still clashes with what it literally names.
    #[test]
    fn a_vanished_folder_holds_only_the_path_it_names() {
        let repo = Repo::new();
        let gone = repo.dir.join("removed-worktree");
        let gone = gone.to_string_lossy();
        let error = checkout_identity(&gone).unwrap_err();
        assert!(error.contains(gone.as_ref()), "{error}");
        assert_eq!(held_checkout(&gone), gone);
        assert!(!overlaps(&held_checkout(&gone), &repo.root));
        assert!(overlaps(&held_checkout(&gone), &format!("{gone}/sub")));
        assert_eq!(held_checkout(&repo.root), repo.root);
    }

    /// Feedback 63e319a4: a chat in the plain folder above a repository does
    /// not hold a managed worktree, but does hold an ordinary checkout.
    #[test]
    fn only_a_chat_inside_a_managed_worktree_shares_it() {
        let parent = "/work/Starfall";
        let worktree = "/work/Starfall/.worktrees/novel/feature/octiq-x";
        assert!(!shares_checkout(worktree, parent, true));
        assert!(shares_checkout(worktree, worktree, true));
        assert!(shares_checkout(worktree, &format!("{worktree}/web"), true));
        assert!(!shares_checkout(worktree, "/work/Starfall/novel", true));
        let primary = "/work/Starfall/novel";
        assert!(shares_checkout(primary, parent, false));
        assert!(shares_checkout(primary, &format!("{primary}/web"), false));
    }

    #[test]
    fn retained_workspace_branch_drift_is_rejected() {
        let repo = Repo::new();
        let p = plan(&repo.root, "main", "task_drift", WorkspaceMode::Worktree).unwrap();
        provision(&p).unwrap();
        git(&p.cwd, &["switch", "-c", "other"]).unwrap();
        assert!(verify(&p).unwrap_err().contains("branch changed"));
        assert!(provision(&p).is_err());
    }

    #[test]
    fn pushed_is_distinct_from_merged_and_cleanup_checks_fresh_head_and_dirt() {
        let repo = Repo::new();
        repo.remote();
        let p = plan(&repo.root, "main", "task_delivery", WorkspaceMode::Worktree).unwrap();
        provision(&p).unwrap();
        let head = repo.commit(&p.cwd, "feature.txt", "feature\n");
        git(&p.cwd, &["push", "-u", "origin", &p.branch]).unwrap();
        let evidence = inspect(&p, true).unwrap();
        assert!(evidence.pushed);
        assert!(evidence.has_commits);
        assert!(!evidence.merged);
        assert!(cleanup(&p, &p.base_sha).is_err());
        std::fs::write(Path::new(&p.cwd).join("scratch.txt"), "keep").unwrap();
        assert!(cleanup(&p, &head).is_err());
        // Commit the scratch file rather than deleting data to make a gate pass.
        let head = repo.commit(&p.cwd, "scratch.txt", "keep");
        git(&p.cwd, &["push"]).unwrap();
        repo.git(&["merge", "--ff-only", &p.branch]);
        repo.git(&["push"]);
        assert!(inspect(&p, true).unwrap().merged);
        cleanup(&p, &head).unwrap();
        assert!(!Path::new(&p.cwd).exists());
        assert_eq!(
            repo.git(&["rev-parse", &p.branch]),
            head,
            "cleanup retains the branch"
        );
    }

    /// Feedback ef927bf0 / 6b1d8eba: a reviewer detached at the exact head it
    /// reviews can still have a validation checkout made, and its own tree is
    /// left where it was. Dispatch still insists on the branch.
    #[test]
    fn a_detached_review_checkout_still_gets_a_validation_checkout() {
        let repo = Repo::new();
        let p = plan(&repo.root, "main", "task_detached", WorkspaceMode::Worktree).unwrap();
        provision(&p).unwrap();
        let head = repo.commit(&p.cwd, "feature.txt", "feature\n");
        git(&p.cwd, &["checkout", "--detach", &head]).unwrap();
        assert!(verify(&p).is_err(), "a writer still needs its branch");
        let target = repo.dir.join("validation-detached");
        validation_worktree(&p, &p.base_sha, &[head.clone()], &target).unwrap();
        assert!(target.join("feature.txt").exists());
        assert_eq!(git(&p.cwd, &["rev-parse", "HEAD"]).unwrap(), head);
        assert!(git(&p.cwd, &["branch", "--show-current"])
            .unwrap()
            .is_empty());
        remove_validation(&p, &target.to_string_lossy()).unwrap();
    }

    /// Feedback 1becac39 / 9b1e8978: the lead fast-forwards the base and
    /// pushes that; the task branch itself never reaches the remote.
    #[test]
    fn a_head_in_the_remote_base_is_merged_without_its_branch_pushed() {
        let repo = Repo::new();
        repo.remote();
        let p = plan(&repo.root, "main", "task_unpushed", WorkspaceMode::Worktree).unwrap();
        provision(&p).unwrap();
        let head = repo.commit(&p.cwd, "feature.txt", "feature\n");
        let before = inspect(&p, true).unwrap();
        assert!(!before.merged && !before.pushed, "{:?}", before.notes);
        repo.git(&["merge", "--ff-only", &p.branch]);
        repo.git(&["push"]);
        let after = inspect(&p, true).unwrap();
        assert!(after.merged, "{:?}", after.notes);
        assert!(after.pushed, "in the remote base, it is published");
        cleanup(&p, &head).unwrap();
        assert!(!Path::new(&p.cwd).exists());
    }

    #[test]
    fn validation_selected_patch_does_not_touch_preserved_dirty_source() {
        let repo = Repo::new();
        let base = repo.git(&["rev-parse", "HEAD"]);
        let one = repo.commit(&repo.root, "one.txt", "one");
        repo.commit(&repo.root, "two.txt", "two");
        std::fs::write(
            Path::new(&repo.root).join("source.txt"),
            "uncommitted user work",
        )
        .unwrap();
        let p = plan(&repo.root, "", "task_validation", WorkspaceMode::Direct).unwrap();
        let target = repo.dir.join("validation");
        validation_worktree(&p, &base, &[one], &target).unwrap();
        assert!(target.join("one.txt").exists());
        assert!(!target.join("two.txt").exists());
        assert_eq!(
            std::fs::read_to_string(Path::new(&repo.root).join("source.txt")).unwrap(),
            "uncommitted user work"
        );
        remove_validation(&p, &target.to_string_lossy()).unwrap();
        assert!(!target.exists());
        assert!(Path::new(&repo.root).join("two.txt").exists());
    }
}
