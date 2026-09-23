pub mod workflow;

// Mutating git commands for the Git changes panel: commit, push, pull, switch
// branch.
//
// `git.rs` is the read-only git backend and stays that way. Every command that
// CHANGES a repository lives here, so "can this touch my repo?" is answered by
// the module name alone. Reads these commands need (branch name, upstream,
// index entries) borrow `git::run_git`.
//
// Three rules hold for everything in this file:
//
//   * **Never wait for input.** A Tauri command has no terminal, so any prompt
//     hangs forever with nothing able to answer it. Commit passes `-m`, merge
//     passes `--no-edit`, and the network commands run with
//     `GIT_TERMINAL_PROMPT=0` plus ssh `BatchMode=yes`, so a repo that needs a
//     password fails fast with a readable message instead of freezing.
//   * **Report git's own words.** On failure the command returns git's stderr
//     verbatim as the error string and the panel shows it. Replacing it with
//     friendlier text would hide the one line that says what actually happened.
//   * **Touch only what the user ticked.** Commit stages exactly the ticked
//     paths and then commits with `--only`, so anything staged outside this
//     panel stays staged and out of the commit.
//
// Long-running hooks are the one thing that can still block: a `pre-commit`
// hook that runs a test suite holds the command until it finishes. The webview
// stays responsive (Tauri runs commands off the UI thread) and the panel shows
// the button as busy meanwhile.
use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::process::Command;

use serde::Serialize;

use crate::git::run_git;

/// The outcome of one successful commit / push / pull.
#[derive(Debug, Clone, Serialize)]
pub struct GitOpResult {
    /// One short line for the panel's status row ("Committed 3 files").
    pub summary: String,
    /// git's own combined stdout + stderr, shown under the summary.
    pub output: String,
}

/// The exact directory and branch an agent chat should start in after the
/// host has applied the location choices made in the composer.
#[derive(Debug, Clone, Serialize)]
pub struct PreparedWorkspace {
    pub cwd: String,
    pub branch: String,
    pub is_repo: bool,
    pub is_worktree: bool,
}

/// Prepare the selected project before its agent starts.
///
/// With `new_worktree = false`, an explicitly selected local branch is
/// switched in the project's existing checkout. With it enabled, `branch` is
/// the base and a fresh `octiq/<task>-<chat>` branch is created in the same
/// `.worktrees/<repo>/...` layout used by OctiqFlow's own development flow.
/// The prompt only supplies a readable branch hint; it is never interpreted as
/// a project or branch instruction.
pub fn git_prepare_chat_workspace(
    path: String,
    branch: String,
    new_worktree: bool,
    prompt: String,
    chat_id: String,
) -> Result<PreparedWorkspace, String> {
    let Some(root) = run_git(&path, &["rev-parse", "--show-toplevel"])
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
    else {
        return Ok(PreparedWorkspace {
            cwd: path,
            branch: String::new(),
            is_repo: false,
            is_worktree: false,
        });
    };

    let selected = if branch.trim().is_empty() {
        current_branch(&root)?
    } else {
        branch.trim().to_string()
    };
    ensure_local_branch(&root, &selected)?;

    if !new_worktree {
        git_switch_branch(root.clone(), selected.clone())?;
        return Ok(PreparedWorkspace {
            cwd: path,
            branch: selected,
            is_repo: true,
            is_worktree: is_linked_worktree(&root),
        });
    }

    let primary = primary_checkout_root(&root)?;
    let repo_name = primary
        .file_name()
        .and_then(|name| name.to_str())
        .filter(|name| !name.is_empty())
        .ok_or("Could not name this repository for its worktree folder.")?;
    let repo_parent = primary
        .parent()
        .ok_or("Could not find a parent folder for this repository.")?;
    let worktree_root = repo_parent.join(".worktrees").join(repo_name);
    let branch_stem = generated_branch_stem(&prompt, &chat_id);
    let (created_branch, target) = available_worktree_target(&root, &worktree_root, &branch_stem);
    let parent = target
        .parent()
        .ok_or("Could not prepare the worktree folder.")?;
    std::fs::create_dir_all(parent)
        .map_err(|error| format!("Could not create the worktree folder: {error}"))?;

    let target_text = target.to_string_lossy().into_owned();
    run_git_mut(
        &root,
        &[
            "worktree",
            "add",
            "-b",
            created_branch.as_str(),
            target_text.as_str(),
            selected.as_str(),
        ],
        false,
    )?;

    let cwd = worktree_cwd(&path, &root, &target);
    Ok(PreparedWorkspace {
        cwd,
        branch: created_branch,
        is_repo: true,
        is_worktree: true,
    })
}

/// Commit the ticked files of ONE repo.
///
/// `files` are repo-relative paths straight from the panel's list; for a rename
/// the caller sends BOTH the old and the new path so the pair is committed
/// together. An empty message or an empty selection is rejected here rather
/// than handed to git, whose own error for those cases is less clear.
pub fn git_commit(
    root: String,
    files: Vec<String>,
    message: String,
) -> Result<GitOpResult, String> {
    let message = message.trim().to_string();
    if message.is_empty() {
        return Err("Enter a commit message.".into());
    }
    let paths = dedupe(files);
    if paths.is_empty() {
        return Err("Tick at least one file to commit.".into());
    }

    // 1. Stage the ticked paths. `-A` covers all three cases at once: a new file
    //    is added, a modified one updated, a deleted one recorded as removed.
    let addable = addable_paths(&root, &paths);
    if !addable.is_empty() {
        let mut args = vec!["add", "-A", "--"];
        args.extend(addable.iter().map(String::as_str));
        run_git_mut(&root, &args, false)?;
    }

    // 2. Commit ONLY those paths: `--only` builds the commit from HEAD plus the
    //    given paths, ignoring whatever else sits in the index.
    let mut args = vec!["commit", "--only", "-m", message.as_str(), "--"];
    args.extend(paths.iter().map(String::as_str));
    let output = run_git_mut(&root, &args, false)?;

    Ok(GitOpResult {
        summary: format!("Committed {}", count_label(paths.len())),
        output,
    })
}

/// Push the current branch. A branch with no upstream is pushed with
/// `--set-upstream` to the repo's default remote, so the first push of a new
/// branch works from the panel without dropping to a terminal.
pub fn git_push(root: String) -> Result<GitOpResult, String> {
    let branch = current_branch(&root)?;
    let output = if has_upstream(&root) {
        run_git_mut(&root, &["push"], true)?
    } else {
        let remote = default_remote(&root)?;
        run_git_mut(
            &root,
            &["push", "--set-upstream", remote.as_str(), branch.as_str()],
            true,
        )?
    };
    Ok(GitOpResult {
        summary: push_summary(&branch, &output),
        output,
    })
}

/// Pull the upstream into the current branch. `mode` is the user's choice from
/// the panel: "rebase", "merge", or "ff-only" (see `pull_args`).
///
/// Pulling needs an upstream, so a branch that was never pushed is rejected up
/// front with the fix ("Push it first") instead of git's longer advice block.
pub fn git_pull(root: String, mode: String) -> Result<GitOpResult, String> {
    let branch = current_branch(&root)?;
    if !has_upstream(&root) {
        return Err(format!(
            "'{branch}' does not track a remote branch yet. Push it first."
        ));
    }
    let output = run_git_mut(&root, pull_args(&mode), true)?;
    Ok(GitOpResult {
        summary: pull_summary(&branch, &output),
        output,
    })
}

/// Switch this repo to another LOCAL branch (the panel's branch dropdown).
///
/// `git switch`, never `git checkout`: switch only ever moves HEAD, so a name
/// that happens to match a file can never be read as "throw away my changes to
/// that path". `--` ends the options for the same reason a path would need it.
///
/// Uncommitted work is left to git, which is the whole point of not stashing
/// behind the user's back: changes that do not clash come along to the new
/// branch, and ones that would be overwritten abort the switch with git's own
/// "Your local changes … would be overwritten" text, which the panel shows.
pub fn git_switch_branch(root: String, branch: String) -> Result<GitOpResult, String> {
    let branch = branch.trim().to_string();
    if branch.is_empty() {
        return Err("Pick a branch to switch to.".into());
    }
    // Already there: say so instead of running git. The dropdown can send this
    // (re-picking the selected option), and a pointless switch still touches the
    // index, which would wake the fs watcher for nothing.
    if current_branch(&root).ok().as_deref() == Some(branch.as_str()) {
        return Ok(GitOpResult {
            summary: format!("Already on {branch}."),
            output: String::new(),
        });
    }
    let output = run_git_mut(&root, &["switch", "--", branch.as_str()], false)?;
    Ok(GitOpResult {
        summary: format!("Switched to {branch}"),
        output,
    })
}

// --- Running git ------------------------------------------------------------

/// Run one MUTATING git command and keep everything it said.
///
/// Unlike `git::run_git` (which drops stderr and reports failure as `None`),
/// this returns git's combined output on success and its combined output as the
/// error on failure — that text is the whole value of the command to the user.
///
/// `network` marks the commands that talk to a remote (push / pull) and turns
/// off every way git could stop to ask for a credential.
fn run_git_mut(root: &str, args: &[&str], network: bool) -> Result<String, String> {
    let mut cmd = Command::new("git");
    cmd.arg("-C").arg(root).args(args);
    if network {
        // No terminal prompt (there is no terminal), and no ssh prompt either.
        // An ssh command the user already set wins — it may carry the identity
        // or proxy this repo needs.
        cmd.env("GIT_TERMINAL_PROMPT", "0");
        if std::env::var_os("GIT_SSH_COMMAND").is_none() {
            cmd.env("GIT_SSH_COMMAND", "ssh -o BatchMode=yes");
        }
    }
    crate::proc::no_console(&mut cmd);

    let out = cmd
        .output()
        .map_err(|e| format!("Could not run git: {e}"))?;
    let text = combine_output(&out.stdout, &out.stderr);
    if out.status.success() {
        Ok(text)
    } else if text.is_empty() {
        Err(format!("git {} failed.", args.first().unwrap_or(&"")))
    } else {
        Err(text)
    }
}

/// Join a command's stdout and stderr into the one block the panel shows. git
/// splits its report across both (`push` writes progress to stderr, `commit`
/// its summary to stdout), so either alone tells half the story.
fn combine_output(stdout: &[u8], stderr: &[u8]) -> String {
    let mut parts: Vec<String> = Vec::new();
    for raw in [stdout, stderr] {
        let text = String::from_utf8_lossy(raw).trim().to_string();
        if !text.is_empty() {
            parts.push(text);
        }
    }
    parts.join("\n")
}

// --- Repo lookups -----------------------------------------------------------

fn ensure_local_branch(root: &str, branch: &str) -> Result<(), String> {
    let reference = format!("refs/heads/{branch}");
    if run_git(
        root,
        &["show-ref", "--verify", "--quiet", reference.as_str()],
    )
    .is_some()
    {
        Ok(())
    } else {
        Err(format!("Local branch '{branch}' does not exist."))
    }
}

/// The primary checkout owns the common `.git` directory even when `root` is
/// itself a linked worktree. Its parent is therefore the stable place from
/// which all OctiqFlow worktrees can be grouped.
fn primary_checkout_root(root: &str) -> Result<PathBuf, String> {
    let common = run_git(
        root,
        &["rev-parse", "--path-format=absolute", "--git-common-dir"],
    )
    .ok_or("Could not find this repository's common Git directory.")?;
    let common = PathBuf::from(common.trim());
    common
        .parent()
        .map(Path::to_path_buf)
        .ok_or_else(|| "Could not find this repository's primary checkout.".into())
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

fn generated_branch_stem(prompt: &str, chat_id: &str) -> String {
    let mut task = slug_part(prompt, 36);
    if task.is_empty() {
        task.push_str("task");
    }
    let mut identity = slug_part(chat_id, 8);
    if identity.is_empty() {
        identity.push_str("chat");
    }
    format!("octiq/{task}-{identity}")
}

/// ASCII branch hints stay readable in terminals and portable across Git
/// hosts. Non-ASCII prompts simply fall back to `task-<chat>` rather than
/// transliterating a person's words incorrectly.
fn slug_part(value: &str, limit: usize) -> String {
    let mut slug = String::new();
    let mut separated = false;
    for character in value.chars() {
        if character.is_ascii_alphanumeric() {
            if separated && !slug.is_empty() && slug.len() < limit {
                slug.push('-');
            }
            separated = false;
            if slug.len() < limit {
                slug.push(character.to_ascii_lowercase());
            }
        } else {
            separated = true;
        }
        if slug.len() >= limit {
            break;
        }
    }
    slug.trim_matches('-').to_string()
}

fn available_worktree_target(
    root: &str,
    worktree_root: &Path,
    branch_stem: &str,
) -> (String, PathBuf) {
    for suffix in 1.. {
        let branch = if suffix == 1 {
            branch_stem.to_string()
        } else {
            format!("{branch_stem}-{suffix}")
        };
        let reference = format!("refs/heads/{branch}");
        let target = worktree_root.join(&branch);
        if run_git(
            root,
            &["show-ref", "--verify", "--quiet", reference.as_str()],
        )
        .is_none()
            && !target.exists()
        {
            return (branch, target);
        }
    }
    unreachable!("an unbounded numeric suffix always has a candidate")
}

/// Preserve a project's selected subfolder inside the linked worktree. Most
/// projects point at the repo root; monorepo projects often point one level in.
fn worktree_cwd(requested: &str, root: &str, target: &Path) -> String {
    let relative = std::fs::canonicalize(requested)
        .ok()
        .and_then(|path| {
            std::fs::canonicalize(root)
                .ok()
                .and_then(|repo| path.strip_prefix(repo).ok().map(Path::to_path_buf))
        })
        .unwrap_or_default();
    let candidate = target.join(relative);
    if candidate.is_dir() {
        candidate.to_string_lossy().into_owned()
    } else {
        target.to_string_lossy().into_owned()
    }
}

/// The checked-out branch name. A detached HEAD has none, and committing to it
/// is a foot-gun the panel should not offer, so it is an error here.
fn current_branch(root: &str) -> Result<String, String> {
    let branch = run_git(root, &["branch", "--show-current"])
        .unwrap_or_default()
        .trim()
        .to_string();
    if branch.is_empty() {
        return Err("HEAD is detached — check out a branch first.".into());
    }
    Ok(branch)
}

/// True when the current branch tracks an upstream branch.
fn has_upstream(root: &str) -> bool {
    run_git(root, &["rev-parse", "--abbrev-ref", "@{u}"]).is_some()
}

/// The remote to push a brand-new branch to: "origin" when it exists, otherwise
/// the first remote configured. A repo with no remote at all cannot be pushed.
fn default_remote(root: &str) -> Result<String, String> {
    let listed = run_git(root, &["remote"]).unwrap_or_default();
    let remotes: Vec<&str> = listed
        .lines()
        .map(str::trim)
        .filter(|l| !l.is_empty())
        .collect();
    if remotes.contains(&"origin") {
        return Ok("origin".into());
    }
    match remotes.first() {
        Some(first) => Ok((*first).to_string()),
        None => Err("This repository has no remote to push to.".into()),
    }
}

/// Keep the paths `git add` can actually match, in the caller's order.
///
/// A path that is gone from BOTH the working tree and the index — the old name
/// of an already-staged rename, or a file already `git rm`-ed — makes
/// `git add` fail with "pathspec did not match any files" and would abort a
/// commit that is otherwise fine. Such a path needs no staging anyway: its
/// removal is in the index already, and the commit step still receives it.
fn addable_paths(root: &str, paths: &[String]) -> Vec<String> {
    let mut args = vec!["-c", "core.quotePath=false", "ls-files", "-z", "--"];
    args.extend(paths.iter().map(String::as_str));
    let listed = run_git(root, &args).unwrap_or_default();
    let indexed: HashSet<&str> = listed.split('\0').filter(|s| !s.is_empty()).collect();

    paths
        .iter()
        .filter(|p| indexed.contains(p.as_str()) || on_disk(root, p))
        .cloned()
        .collect()
}

/// True when the path exists in the working tree. `symlink_metadata` so a
/// broken symlink still counts as present — git tracks the link, not its target.
fn on_disk(root: &str, path: &str) -> bool {
    Path::new(root).join(path).symlink_metadata().is_ok()
}

// --- Pure helpers (unit-tested below) ---------------------------------------

/// Drop blanks and repeats while keeping the caller's order. A rename sends its
/// old and new path, and two renames can name the same path twice.
fn dedupe(paths: Vec<String>) -> Vec<String> {
    let mut seen: HashSet<String> = HashSet::new();
    paths
        .into_iter()
        .filter(|p| !p.trim().is_empty())
        .filter(|p| seen.insert(p.clone()))
        .collect()
}

/// The git arguments for one pull mode. An unknown mode falls back to rebase,
/// the panel's default — a pull is never silently turned into a merge commit.
fn pull_args(mode: &str) -> &'static [&'static str] {
    match mode {
        // Merge: `--no-edit` keeps git from opening an editor for the merge
        // commit message, which would hang with no terminal to type into.
        "merge" => &["pull", "--no-rebase", "--no-edit"],
        // Fast-forward only: refuses to pull when the branches have diverged.
        "ff-only" => &["pull", "--ff-only"],
        _ => &["pull", "--rebase"],
    }
}

/// "1 file" / "3 files".
fn count_label(n: usize) -> String {
    if n == 1 {
        "1 file".to_string()
    } else {
        format!("{n} files")
    }
}

/// One-line push result. git says "Everything up-to-date" on stderr when there
/// was nothing to send; saying "Pushed" there would be a lie.
fn push_summary(branch: &str, output: &str) -> String {
    if output.contains("Everything up-to-date") {
        "Nothing to push.".to_string()
    } else {
        format!("Pushed {branch}")
    }
}

/// One-line pull result, same idea as `push_summary`.
fn pull_summary(branch: &str, output: &str) -> String {
    if output.contains("Already up to date") {
        "Already up to date.".to_string()
    } else {
        format!("Pulled into {branch}")
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pull_args_map_each_mode() {
        assert_eq!(pull_args("rebase"), &["pull", "--rebase"]);
        assert_eq!(pull_args("merge"), &["pull", "--no-rebase", "--no-edit"]);
        assert_eq!(pull_args("ff-only"), &["pull", "--ff-only"]);
    }

    #[test]
    fn pull_args_unknown_mode_falls_back_to_rebase() {
        assert_eq!(pull_args(""), &["pull", "--rebase"]);
        assert_eq!(pull_args("squash-everything"), &["pull", "--rebase"]);
    }

    #[test]
    fn dedupe_keeps_order_and_drops_repeats_and_blanks() {
        let out = dedupe(vec![
            "b.rs".into(),
            "a.rs".into(),
            "b.rs".into(),
            "  ".into(),
        ]);
        assert_eq!(out, vec!["b.rs".to_string(), "a.rs".to_string()]);
    }

    #[test]
    fn count_label_singular_and_plural() {
        assert_eq!(count_label(1), "1 file");
        assert_eq!(count_label(3), "3 files");
    }

    #[test]
    fn generated_worktree_branch_is_readable_and_bounded() {
        assert_eq!(
            generated_branch_stem("Show branch name in the chat list", "ABC-1234-REST"),
            "octiq/show-branch-name-in-the-chat-list-abc-1234"
        );
        assert_eq!(
            generated_branch_stem("修复聊天列表", "chat-9000"),
            "octiq/task-chat-900"
        );
    }

    #[test]
    fn summaries_report_the_no_op_cases() {
        assert_eq!(
            push_summary("main", "Everything up-to-date"),
            "Nothing to push."
        );
        assert_eq!(push_summary("main", "To github.com:x/y.git"), "Pushed main");
        assert_eq!(
            pull_summary("main", "Already up to date."),
            "Already up to date."
        );
        assert_eq!(pull_summary("main", "Fast-forward"), "Pulled into main");
    }

    #[test]
    fn combine_output_joins_both_streams_and_skips_empties() {
        assert_eq!(combine_output(b"out\n", b"err\n"), "out\nerr");
        assert_eq!(combine_output(b"", b"err\n"), "err");
        assert_eq!(combine_output(b"out\n", b""), "out");
        assert_eq!(combine_output(b"", b""), "");
    }

    // ---- Repo-backed tests (skipped when `git` is unavailable) --------------

    /// A throwaway repo with one commit and a `user.*` identity, so `git commit`
    /// works on a machine with no global git config.
    fn temp_repo(name: &str) -> Option<std::path::PathBuf> {
        let dir =
            std::env::temp_dir().join(format!("octiq-gitops-test-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).ok()?;
        let git = |args: &[&str]| {
            Command::new("git")
                .arg("-C")
                .arg(&dir)
                .args(args)
                .output()
                .ok()
                .filter(|o| o.status.success())
        };
        git(&["init", "-q"])?;
        git(&["config", "user.email", "test@octiqflow.local"])?;
        git(&["config", "user.name", "OctiqFlow Test"])?;
        // Commit hooks from a global template would run during these tests.
        git(&["config", "core.hooksPath", "/dev/null"]);
        std::fs::write(dir.join("kept.txt"), "one\n").ok()?;
        std::fs::write(dir.join("gone.txt"), "two\n").ok()?;
        git(&["add", "-A"])?;
        git(&["commit", "-qm", "init"])?;
        Some(dir)
    }

    #[test]
    fn commit_takes_only_the_ticked_files() {
        let Some(dir) = temp_repo("only") else {
            return; // no usable git on this machine
        };
        let root = dir.to_string_lossy().into_owned();

        // Three kinds of change at once, but only two are ticked.
        std::fs::write(dir.join("kept.txt"), "one changed\n").unwrap();
        std::fs::remove_file(dir.join("gone.txt")).unwrap();
        std::fs::write(dir.join("fresh.txt"), "new\n").unwrap();
        std::fs::write(dir.join("untouched.txt"), "left alone\n").unwrap();

        let res = git_commit(
            root.clone(),
            vec!["kept.txt".into(), "gone.txt".into(), "fresh.txt".into()],
            "  test commit  ".into(),
        )
        .expect("commit succeeds");
        assert_eq!(res.summary, "Committed 3 files");

        // The commit holds the modify, the delete and the add…
        let shown = run_git(&root, &["show", "--name-status", "--format=%s", "HEAD"]).unwrap();
        assert!(shown.contains("test commit"), "message is trimmed: {shown}");
        assert!(shown.contains("M\tkept.txt"), "{shown}");
        assert!(shown.contains("D\tgone.txt"), "{shown}");
        assert!(shown.contains("A\tfresh.txt"), "{shown}");
        // …and the file that was not ticked is still an uncommitted change.
        let status = run_git(&root, &["status", "--porcelain"]).unwrap();
        assert_eq!(status.trim(), "?? untouched.txt");

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn commit_leaves_work_staged_outside_the_panel_alone() {
        let Some(dir) = temp_repo("staged") else {
            return;
        };
        let root = dir.to_string_lossy().into_owned();

        // The user staged one file in a terminal, then commits ANOTHER file here.
        std::fs::write(dir.join("gone.txt"), "staged by hand\n").unwrap();
        Command::new("git")
            .arg("-C")
            .arg(&dir)
            .args(["add", "gone.txt"])
            .output()
            .unwrap();
        std::fs::write(dir.join("kept.txt"), "one changed\n").unwrap();

        git_commit(root.clone(), vec!["kept.txt".into()], "just kept".into()).unwrap();

        let shown = run_git(&root, &["show", "--name-status", "HEAD"]).unwrap();
        assert!(shown.contains("kept.txt"), "{shown}");
        assert!(
            !shown.contains("gone.txt"),
            "hand-staged file stayed out: {shown}"
        );
        // It is still staged, exactly as the user left it.
        let staged = run_git(&root, &["diff", "--cached", "--name-only"]).unwrap();
        assert_eq!(staged.trim(), "gone.txt");

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn commit_rejects_an_empty_message_or_no_files() {
        let Some(dir) = temp_repo("guards") else {
            return;
        };
        let root = dir.to_string_lossy().into_owned();
        std::fs::write(dir.join("kept.txt"), "changed\n").unwrap();

        assert!(git_commit(root.clone(), vec!["kept.txt".into()], "   ".into()).is_err());
        assert!(git_commit(root.clone(), vec![], "a message".into()).is_err());
        // Neither attempt created a commit.
        let log = run_git(&root, &["log", "--oneline"]).unwrap();
        assert_eq!(log.lines().count(), 1);

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn commit_handles_a_rename_already_staged_by_git_mv() {
        let Some(dir) = temp_repo("rename") else {
            return;
        };
        let root = dir.to_string_lossy().into_owned();
        Command::new("git")
            .arg("-C")
            .arg(&dir)
            .args(["mv", "kept.txt", "moved.txt"])
            .output()
            .unwrap();

        // The panel sends both sides of the rename. The old path is in neither
        // the working tree nor the index, so `git add` must skip it.
        let res = git_commit(
            root.clone(),
            vec!["moved.txt".into(), "kept.txt".into()],
            "move it".into(),
        )
        .expect("rename commits");
        assert_eq!(res.summary, "Committed 2 files");

        let shown = run_git(&root, &["show", "--name-status", "-M", "HEAD"]).unwrap();
        assert!(
            shown.contains("kept.txt") && shown.contains("moved.txt"),
            "{shown}"
        );
        assert_eq!(
            run_git(&root, &["status", "--porcelain"]).unwrap().trim(),
            ""
        );

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn switch_moves_head_to_another_local_branch() {
        let Some(dir) = temp_repo("switch") else {
            return;
        };
        let root = dir.to_string_lossy().into_owned();
        Command::new("git")
            .arg("-C")
            .arg(&dir)
            .args(["branch", "feature/x"])
            .output()
            .unwrap();

        let res = git_switch_branch(root.clone(), "  feature/x  ".into()).expect("switch works");
        assert_eq!(res.summary, "Switched to feature/x");
        assert_eq!(
            run_git(&root, &["branch", "--show-current"])
                .unwrap()
                .trim(),
            "feature/x"
        );

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn switch_to_the_current_branch_changes_nothing() {
        let Some(dir) = temp_repo("switch-same") else {
            return;
        };
        let root = dir.to_string_lossy().into_owned();
        let branch = run_git(&root, &["branch", "--show-current"])
            .unwrap()
            .trim()
            .to_string();

        // An uncommitted change proves git was never called: `git switch` to the
        // branch you are already on prints "Already on …" but also re-reads the
        // index, and we want the no-op to be free.
        std::fs::write(dir.join("kept.txt"), "changed\n").unwrap();
        let res = git_switch_branch(root.clone(), branch.clone()).expect("no-op succeeds");
        assert_eq!(res.summary, format!("Already on {branch}."));
        assert_eq!(
            run_git(&root, &["status", "--porcelain"]).unwrap().trim(),
            "M kept.txt"
        );

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn switch_rejects_an_empty_branch_name() {
        let Some(dir) = temp_repo("switch-empty") else {
            return;
        };
        let err = git_switch_branch(dir.to_string_lossy().into_owned(), "   ".into()).unwrap_err();
        assert!(err.contains("Pick a branch"), "{err}");

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn switch_reports_gits_own_refusal() {
        let Some(dir) = temp_repo("switch-refused") else {
            return;
        };
        let root = dir.to_string_lossy().into_owned();
        let err = git_switch_branch(root, "no-such-branch".into()).unwrap_err();
        // git's own words, not ours — the panel shows this line verbatim.
        assert!(err.contains("no-such-branch"), "{err}");

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn prepare_switches_the_selected_checkout_before_chat_start() {
        let Some(dir) = temp_repo("prepare-switch") else {
            return;
        };
        let root = dir.to_string_lossy().into_owned();
        Command::new("git")
            .arg("-C")
            .arg(&dir)
            .args(["branch", "feature/selected"])
            .output()
            .unwrap();

        let prepared = git_prepare_chat_workspace(
            root.clone(),
            "feature/selected".into(),
            false,
            "ignored prompt".into(),
            "chat-a".into(),
        )
        .expect("checkout is prepared");

        assert_eq!(prepared.cwd, root);
        assert_eq!(prepared.branch, "feature/selected");
        assert!(!prepared.is_worktree);
        assert_eq!(current_branch(&prepared.cwd).unwrap(), "feature/selected");

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn prepare_creates_a_task_branch_in_a_linked_worktree() {
        let Some(dir) = temp_repo("prepare-worktree") else {
            return;
        };
        let root = dir.to_string_lossy().into_owned();
        let base = current_branch(&root).unwrap();

        let prepared = git_prepare_chat_workspace(
            root.clone(),
            base.clone(),
            true,
            "Build the project picker".into(),
            "chat-12345678".into(),
        )
        .expect("worktree is prepared");

        assert!(prepared.is_worktree);
        assert_eq!(prepared.branch, "octiq/build-the-project-picker-chat-123");
        assert_eq!(current_branch(&prepared.cwd).unwrap(), prepared.branch);
        assert_eq!(
            current_branch(&root).unwrap(),
            base,
            "primary checkout stays put"
        );

        let worktree = prepared.cwd.clone();
        let _ = run_git_mut(
            &root,
            &["worktree", "remove", "--force", worktree.as_str()],
            false,
        );
        if let Some(group) = Path::new(&worktree).ancestors().nth(2) {
            let _ = std::fs::remove_dir_all(group);
        }
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn pull_without_an_upstream_says_to_push_first() {
        let Some(dir) = temp_repo("noupstream") else {
            return;
        };
        let err = git_pull(dir.to_string_lossy().into_owned(), "rebase".into()).unwrap_err();
        assert!(err.contains("Push it first"), "{err}");

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn push_without_a_remote_says_so() {
        let Some(dir) = temp_repo("noremote") else {
            return;
        };
        let err = git_push(dir.to_string_lossy().into_owned()).unwrap_err();
        assert!(err.contains("no remote"), "{err}");

        let _ = std::fs::remove_dir_all(&dir);
    }
}
