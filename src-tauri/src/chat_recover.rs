//! A chat whose folder was removed is put somewhere it can run again, before
//! its agent is started.
//!
//! A chat remembers the exact folder it ran in, and for a task chat that is a
//! linked worktree. Worktrees get removed once their work is merged, by the
//! person or by a cleanup, and the chat outlives them: the next message would
//! start an agent in a folder that is not there. `chat_start` therefore comes
//! through here first, and only when the folder is missing.
//!
//! The order, and why it is that order:
//!
//! 1. **Rebuild the worktree at the SAME path.** From its branch when the
//!    branch still exists, else by making the branch again at the commit that
//!    was remembered for it. The same path is the point: Claude files a
//!    session under its working directory, so `--resume` only finds it from
//!    there, and a chat's sandbox is bound to the folder it was made for.
//!    What the worktree was is read from two places, because either can be
//!    the one that survived: git's own record of it (`git worktree list`,
//!    which keeps a removed worktree until the next prune) and the last
//!    verification `chat_task` stored.
//! 2. **Move the chat to a folder that does exist**: the worktree's root when
//!    only a subfolder went, else the repository's primary checkout, else the
//!    folder the chat was planned in, else the project's folder the page
//!    names. The index is told, and a Claude session is carried to the new
//!    folder's session directory. Codex resumes by id from anywhere.
//! 3. **Say why not**, in words a person can act on, instead of the OS error.
//!
//! Every repository change is `git_ops`'s to make. Nothing here deletes or
//! overwrites: a path that exists is never rebuilt over, and git refuses a
//! branch another worktree holds, which falls through to step 2.
//!
//! What happened is written into the chat as a durable notice
//! (`octiq_chat_recovered`), and the agent is told on its next prompt: its
//! folder was recreated, committed work is intact, uncommitted work is not.

use std::collections::{BTreeMap, HashMap};
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};

use serde_json::json;

use crate::agent_chat::ChatAgent;
use crate::git::run_git;

/// What is known about where a chat ran, gathered before anything is changed.
#[derive(Debug, Clone, Default)]
pub(crate) struct Remembered {
    /// The last verified workspace (`chat_task`). Its branch and repository
    /// outlive the folder.
    pub workspace: Option<crate::chat_task::Workspace>,
    /// The commit the chat's branch was last seen at.
    pub head: String,
    /// The folder the chat was planned in, before any worktree was made.
    pub plan_path: String,
    /// The project's folder as the page has it now.
    pub fallback: String,
}

impl Remembered {
    fn of(chat_id: &str, fallback: Option<&str>) -> Self {
        let (workspace, delivery) = crate::chat_task::remembered(chat_id);
        let plan_path = crate::chat_index::list()
            .into_iter()
            .find(|meta| meta.id == chat_id)
            .and_then(|meta| meta.launch)
            .map(|plan| plan.path)
            .unwrap_or_default();
        Self {
            workspace,
            head: delivery.map(|delivery| delivery.head).unwrap_or_default(),
            plan_path,
            fallback: fallback.unwrap_or_default().to_string(),
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum Kind {
    /// The worktree is back at the path it had.
    Rebuilt,
    /// The chat now runs in another folder.
    Moved,
}

impl Kind {
    fn id(self) -> &'static str {
        match self {
            Self::Rebuilt => "rebuilt",
            Self::Moved => "moved",
        }
    }
}

/// A chat put back on its feet, and what to say about it.
#[derive(Debug, Clone, PartialEq)]
pub(crate) struct Recovery {
    pub kind: Kind,
    /// The folder that was missing.
    pub from: String,
    /// Where the chat starts now.
    pub cwd: String,
    /// The branch checked out in `cwd`. Empty for a detached HEAD or a folder
    /// that is not a repository.
    pub branch: String,
    pub head: String,
    /// For the person, shown in the chat.
    pub notice: String,
    /// For the agent, put in front of its next prompt.
    pub agent_note: String,
}

/// The worktree a missing folder belonged to.
#[derive(Debug, Clone, PartialEq)]
struct Lost {
    primary: String,
    root: String,
    branch: String,
    head: String,
}

/// Recover the folder of `key`'s chat when it is missing. `None` when it is
/// there, which is every ordinary start.
pub(crate) fn recover(
    key: &str,
    cwd: &str,
    fallback: Option<&str>,
) -> Result<Option<Recovery>, String> {
    if cwd.trim().is_empty() || Path::new(cwd).is_dir() {
        return Ok(None);
    }
    let chat_id = key.strip_prefix("chat:").unwrap_or(key);
    restore(cwd, &Remembered::of(chat_id, fallback)).map(Some)
}

/// The recovery itself, from what is remembered. Touches git and the disk and
/// no store, so it can be run against a scratch repository.
pub(crate) fn restore(cwd: &str, known: &Remembered) -> Result<Recovery, String> {
    let lost = lost_worktree(cwd, known);
    let mut why_not = String::new();
    if let Some(lost) = lost.as_ref().filter(|lost| !Path::new(&lost.root).exists()) {
        match crate::git_ops::restore_worktree(&lost.primary, &lost.root, &lost.branch, &lost.head)
        {
            Ok(restored) => return Ok(rebuilt(cwd, lost, &restored)),
            Err(why) => why_not = one_line(&why),
        }
    }

    let stored = known.workspace.as_ref();
    let candidates = [
        lost.as_ref().map(|lost| lost.root.as_str()),
        stored.map(|workspace| workspace.repo_root.as_str()),
        stored.map(|workspace| workspace.primary_root.as_str()),
        Some(known.plan_path.as_str()),
        Some(known.fallback.as_str()),
    ];
    let Some(target) = candidates
        .into_iter()
        .flatten()
        .find(|path| !path.trim().is_empty() && Path::new(path).is_dir())
    else {
        let named = candidates
            .into_iter()
            .flatten()
            .rfind(|path| !path.trim().is_empty() && !same_place(path, cwd));
        let why = match (why_not.is_empty(), named) {
            (false, _) => why_not,
            (true, Some(path)) => format!("{path} is gone too"),
            (true, None) => "nothing is recorded about the repository it came from".into(),
        };
        return Err(format!(
            "The chat's folder {cwd} was removed and could not be restored: {why}. Start a new chat."
        ));
    };
    Ok(moved(cwd, target, lost.as_ref(), &why_not))
}

/// Which worktree `cwd` was (in), from git's own list first and the stored
/// verification second.
fn lost_worktree(cwd: &str, known: &Remembered) -> Option<Lost> {
    let stored = known
        .workspace
        .as_ref()
        .filter(|workspace| workspace.is_worktree && !workspace.repo_root.trim().is_empty());
    // A detached HEAD is stored as "(abc1234)", which is not a branch name.
    let stored_branch = stored
        .map(|workspace| workspace.branch.as_str())
        .filter(|branch| !branch.starts_with('('))
        .unwrap_or_default();

    let mut primaries: Vec<String> = Vec::new();
    for path in [
        known
            .workspace
            .as_ref()
            .map(|workspace| workspace.primary_root.as_str()),
        Some(known.plan_path.as_str()),
        Some(known.fallback.as_str()),
    ]
    .into_iter()
    .flatten()
    .filter(|path| !path.trim().is_empty() && Path::new(path).is_dir())
    {
        if let Ok(primary) = crate::git_ops::primary_checkout_root(path) {
            let primary = primary.to_string_lossy().into_owned();
            if !primaries.contains(&primary) {
                primaries.push(primary);
            }
        }
    }

    for primary in &primaries {
        // The first entry is the primary checkout itself.
        for entry in crate::git_ops::listed_worktrees(primary)
            .into_iter()
            .skip(1)
        {
            if !holds(&entry.path, cwd) {
                continue;
            }
            let recorded = !entry.head.is_empty() && entry.head.chars().any(|c| c != '0');
            return Some(Lost {
                primary: primary.clone(),
                branch: if entry.branch.is_empty() {
                    stored_branch.to_string()
                } else {
                    entry.branch
                },
                head: if recorded {
                    entry.head
                } else {
                    known.head.clone()
                },
                root: entry.path,
            });
        }
    }

    let stored = stored?;
    let primary = primaries.into_iter().find(|primary| {
        same_place(primary, &stored.primary_root) || stored.primary_root.trim().is_empty()
    })?;
    holds(&stored.repo_root, cwd).then(|| Lost {
        primary,
        root: stored.repo_root.clone(),
        branch: stored_branch.to_string(),
        head: known.head.clone(),
    })
}

fn rebuilt(cwd: &str, lost: &Lost, restored: &crate::git_ops::RestoredWorktree) -> Recovery {
    // A project can point one level into its repository, and that subfolder
    // may not be on the branch at all.
    let now = if Path::new(cwd).is_dir() {
        cwd.to_string()
    } else {
        lost.root.clone()
    };
    let at = short(&restored.head);
    let source = match (restored.branch.is_empty(), restored.branch_recreated) {
        (true, _) => format!("detached at {at}"),
        (false, false) => format!("from branch {} at {at}", restored.branch),
        (false, true) => format!(
            "at {at}, on branch {} which was gone and was made again there",
            restored.branch
        ),
    };
    let elsewhere = if now == cwd {
        String::new()
    } else {
        format!(" The folder {cwd} is not on that branch, so this chat continues in {now}.")
    };
    Recovery {
        kind: Kind::Rebuilt,
        from: cwd.to_string(),
        cwd: now,
        branch: restored.branch.clone(),
        head: restored.head.clone(),
        notice: format!(
            "Worktree {} was removed. Rebuilt it at the same path {source}.{elsewhere} Committed work is intact; anything not committed in the removed folder is lost.",
            lost.root
        ),
        agent_note: format!(
            "[OctiqFlow] Your working folder {} had been removed since your last turn. OctiqFlow rebuilt the worktree at the same path {source}.{elsewhere} Committed work is intact. Anything that was not committed in the removed folder is lost, including files you remember editing: check `git status` and `git log` before relying on them.",
            lost.root
        ),
    }
}

fn moved(cwd: &str, target: &str, lost: Option<&Lost>, why_not: &str) -> Recovery {
    let branch = run_git(target, &["branch", "--show-current"])
        .map(|value| value.trim().to_string())
        .unwrap_or_default();
    let head = run_git(target, &["rev-parse", "HEAD"])
        .map(|value| value.trim().to_string())
        .unwrap_or_default();
    let on = if branch.is_empty() {
        String::new()
    } else {
        format!(" on branch {branch}")
    };
    let rebuild = if why_not.is_empty() {
        String::new()
    } else {
        format!(" It could not be rebuilt: {why_not}.")
    };
    // Where the earlier work is, when it is not where the chat now stands.
    let earlier = lost
        .filter(|lost| !lost.branch.is_empty() && lost.branch != branch)
        .map(|lost| {
            let kept = run_git(
                &lost.primary,
                &[
                    "rev-parse",
                    "--verify",
                    "--quiet",
                    &format!("refs/heads/{}", lost.branch),
                ],
            )
            .is_some();
            match (kept, lost.head.is_empty()) {
                (true, _) => format!(" Its earlier work is on branch {}.", lost.branch),
                (false, false) => format!(
                    " Its branch {} is gone; it was last at {}.",
                    lost.branch,
                    short(&lost.head)
                ),
                (false, true) => format!(" Its branch {} is gone.", lost.branch),
            }
        })
        .unwrap_or_default();
    Recovery {
        kind: Kind::Moved,
        from: cwd.to_string(),
        cwd: target.to_string(),
        branch,
        head,
        notice: format!(
            "Folder {cwd} was removed.{rebuild} This chat continues in {target}{on}.{earlier} Anything not committed in the removed folder is lost."
        ),
        agent_note: format!(
            "[OctiqFlow] Your working folder {cwd} had been removed since your last turn.{rebuild} You are now running in {target}{on}.{earlier} Paths under {cwd} no longer exist, and anything that was not committed there is lost. Check `git status` and the current branch before changing anything."
        ),
    }
}

impl Recovery {
    /// Record a recovery that has taken hold: the index learns a new folder,
    /// a Claude session follows the chat there, the chat is told in its
    /// transcript and the agent's next prompt carries the note. Called once
    /// the start has been admitted with the recovered folder, so a refused
    /// start says nothing.
    pub(crate) fn settle(
        mut self,
        key: &str,
        agent: ChatAgent,
        resume: Option<&str>,
        env: Option<&BTreeMap<String, String>>,
    ) -> Self {
        let chat_id = key.strip_prefix("chat:").unwrap_or(key);
        if self.cwd != self.from {
            if let Ok(true) = crate::chat_index::set_cwd(chat_id, &self.cwd) {
                crate::agent_chat::announce_index_change(chat_id, false);
            }
            if let (ChatAgent::Claude, Some(session)) = (agent, resume) {
                let carried = claude_projects_root(env)
                    .ok_or_else(|| "Claude's session folder could not be found".to_string())
                    .and_then(|root| carry_claude_session(&root, session, Path::new(&self.cwd)));
                if let Err(why) = carried {
                    let lost = format!(
                        " Claude's earlier session could not be carried over ({why}), so the agent may start without its memory of this conversation."
                    );
                    self.notice.push_str(&lost);
                }
            }
        }
        crate::chat_task::expire(chat_id);
        crate::diagnostics::record(agent, key, "recovered", &self.notice);
        notes()
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .insert(key.to_string(), self.agent_note.clone());
        crate::agent_chat::record_chat_event(
            key,
            json!({
                "type": "octiq_chat_recovered",
                "kind": self.kind.id(),
                "from": self.from,
                "cwd": self.cwd,
                "branch": self.branch,
                "head": self.head,
                "text": self.notice,
            }),
        );
        self
    }
}

fn notes() -> &'static Mutex<HashMap<String, String>> {
    static NOTES: OnceLock<Mutex<HashMap<String, String>>> = OnceLock::new();
    NOTES.get_or_init(Default::default)
}

/// The line a recovered chat's agent is owed, handed over once: on the first
/// prompt after the recovery.
fn take_note(key: &str) -> Option<String> {
    notes()
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .remove(key)
}

/// Put that line in front of the prompt the agent is about to get. What the
/// person typed stays the visible turn, so the bubble and the transcript show
/// their words and not the host's. A start with no prompt leaves the note for
/// the first one that has.
pub(crate) fn with_note(
    key: &str,
    prompt: Option<String>,
    visible: Option<String>,
) -> (Option<String>, Option<String>) {
    let Some(prompt) = prompt else {
        return (None, visible);
    };
    match take_note(key) {
        Some(note) => {
            let visible = visible.or_else(|| Some(prompt.clone()));
            (Some(format!("{note}\n\n{prompt}")), visible)
        }
        None => (Some(prompt), visible),
    }
}

// ------------------------------------------------------------ Claude session

/// `<config dir>/projects`, where Claude files each session under its working
/// directory. The config dir is the project's own `CLAUDE_CONFIG_DIR` when it
/// sets one, else the server's, else `~/.claude`: what `start_session` hands
/// the agent.
fn claude_projects_root(env: Option<&BTreeMap<String, String>>) -> Option<PathBuf> {
    let configured = env
        .and_then(|env| {
            crate::workspaces::resolved_env(env)
                .into_iter()
                .find(|(name, _)| name == "CLAUDE_CONFIG_DIR")
                .map(|(_, dir)| dir)
        })
        .or_else(|| std::env::var("CLAUDE_CONFIG_DIR").ok())
        .filter(|dir| !dir.trim().is_empty());
    let base = match configured {
        Some(dir) => PathBuf::from(dir),
        None => crate::paths::home_dir()?.join(".claude"),
    };
    base.is_absolute().then(|| base.join("projects"))
}

/// The folder name Claude gives a working directory: every character that is
/// not an ASCII letter or digit becomes a dash, one per UTF-16 unit. Checked
/// against 318 real folders. Past 200 characters Claude shortens the name and
/// adds a hash this cannot reproduce, so that is `None`.
pub(crate) fn claude_project_folder(cwd: &Path) -> Option<String> {
    let name: String = cwd
        .to_string_lossy()
        .encode_utf16()
        .map(|unit| match char::from_u32(unit.into()) {
            Some(c) if c.is_ascii_alphanumeric() => c,
            _ => '-',
        })
        .collect();
    (name.len() <= 200).then_some(name)
}

/// Make a Claude session findable from `new_cwd`: `--resume <id>` only looks
/// in the session folder of the directory it is started in. The file is
/// hard-linked there, or copied when a link cannot be made; the original
/// stays where it was.
pub(crate) fn carry_claude_session(
    projects: &Path,
    session: &str,
    new_cwd: &Path,
) -> Result<PathBuf, String> {
    let plain = !session.is_empty()
        && session
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_');
    if !plain {
        return Err("its id is not a plain session id".into());
    }
    let name = format!("{session}.jsonl");
    let source = std::fs::read_dir(projects)
        .map_err(|error| format!("{} cannot be read: {error}", projects.display()))?
        .flatten()
        .map(|entry| entry.path().join(&name))
        .find(|candidate| candidate.is_file())
        .ok_or("its session file no longer exists")?;
    // Claude reads its working directory with symlinks resolved.
    let resolved = crate::paths::canonicalize(new_cwd).unwrap_or_else(|_| new_cwd.to_path_buf());
    let folder = claude_project_folder(&resolved)
        .ok_or("the new folder's path is too long to name its session folder")?;
    let target = projects.join(folder).join(&name);
    if target.is_file() {
        return Ok(target);
    }
    let parent = target.parent().ok_or("the session folder has no parent")?;
    std::fs::create_dir_all(parent)
        .map_err(|error| format!("{} cannot be created: {error}", parent.display()))?;
    if std::fs::hard_link(&source, &target).is_err() {
        std::fs::copy(&source, &target)
            .map_err(|error| format!("the session file cannot be copied: {error}"))?;
    }
    Ok(target)
}

// ------------------------------------------------------------------- paths

/// A path with its symlinks resolved as far as it exists, so a folder that is
/// gone still compares equal to git's spelling of it.
fn resolved(path: &str) -> PathBuf {
    let path = Path::new(path.trim_end_matches(['/', '\\']));
    crate::paths::canonical_target(path).unwrap_or_else(|| path.to_path_buf())
}

fn same_place(a: &str, b: &str) -> bool {
    resolved(a) == resolved(b)
}

/// Whether `inner` is `root` or lies under it.
fn holds(root: &str, inner: &str) -> bool {
    !root.trim().is_empty() && resolved(inner).starts_with(resolved(root))
}

fn short(sha: &str) -> String {
    sha.chars().take(7).collect()
}

/// git's refusal as one sentence fragment, for the middle of a notice.
fn one_line(text: &str) -> String {
    let line = text
        .lines()
        .map(str::trim)
        .filter(|line| !line.is_empty())
        .collect::<Vec<_>>()
        .join(" ");
    line.trim_end_matches('.').to_string()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::chat_task::Workspace;
    use std::process::Command;

    fn git(dir: &Path, args: &[&str]) -> String {
        let out = Command::new("git")
            .arg("-C")
            .arg(dir)
            .args(args)
            .output()
            .expect("git runs");
        assert!(
            out.status.success(),
            "git {args:?}: {}",
            String::from_utf8_lossy(&out.stderr)
        );
        String::from_utf8_lossy(&out.stdout).trim().to_string()
    }

    /// A repository with one commit at `<scratch>/repo`, and a linked
    /// worktree on `task/one` with a commit of its own at `<scratch>/wt/one`.
    struct Scene {
        _guard: crate::test_dir::TestDir,
        repo: PathBuf,
        worktree: PathBuf,
        head: String,
    }

    fn scene(name: &str) -> Scene {
        let guard = crate::test_dir::TestDir::new(&format!("recover-{name}")).canonicalized();
        let repo = guard.join("repo");
        std::fs::create_dir_all(&repo).unwrap();
        git(&repo, &["init", "-q", "-b", "main"]);
        git(&repo, &["config", "user.email", "test@octiqflow.local"]);
        git(&repo, &["config", "user.name", "OctiqFlow Test"]);
        git(&repo, &["config", "core.hooksPath", "/dev/null"]);
        std::fs::write(repo.join("kept.txt"), "one\n").unwrap();
        git(&repo, &["add", "-A"]);
        git(&repo, &["commit", "-qm", "init"]);
        let worktree = guard.join("wt").join("one");
        git(
            &repo,
            &[
                "worktree",
                "add",
                "-q",
                "-b",
                "task/one",
                worktree.to_str().unwrap(),
            ],
        );
        std::fs::write(worktree.join("work.txt"), "done\n").unwrap();
        git(&worktree, &["add", "-A"]);
        git(&worktree, &["commit", "-qm", "work"]);
        let head = git(&worktree, &["rev-parse", "HEAD"]);
        Scene {
            _guard: guard,
            repo,
            worktree,
            head,
        }
    }

    impl Scene {
        fn text(path: &Path) -> String {
            path.to_string_lossy().into_owned()
        }

        /// What `chat_task` stored while the worktree was still there.
        fn remembered(&self) -> Remembered {
            Remembered {
                workspace: Some(Workspace {
                    cwd: Self::text(&self.worktree),
                    exists: false,
                    is_repo: true,
                    repo_root: Self::text(&self.worktree),
                    primary_root: Self::text(&self.repo),
                    branch: "task/one".into(),
                    is_worktree: true,
                    ..Workspace::default()
                }),
                head: self.head.clone(),
                ..Remembered::default()
            }
        }

        /// The cleanup's way: git forgets the worktree as well.
        fn remove_worktree(&self) {
            git(
                &self.repo,
                &[
                    "worktree",
                    "remove",
                    "--force",
                    self.worktree.to_str().unwrap(),
                ],
            );
        }
    }

    #[test]
    fn a_folder_that_exists_is_left_alone() {
        let here = crate::test_dir::TestDir::new("recover-present");
        assert_eq!(
            recover("chat:present", &here.to_string_lossy(), None),
            Ok(None)
        );
        assert_eq!(recover("chat:blank", "", None), Ok(None));
    }

    #[test]
    fn a_removed_worktree_is_rebuilt_at_the_same_path_on_its_branch() {
        let scene = scene("branch");
        scene.remove_worktree();
        let cwd = Scene::text(&scene.worktree);

        let recovery = restore(&cwd, &scene.remembered()).expect("recovered");

        assert_eq!(recovery.kind, Kind::Rebuilt);
        assert_eq!(recovery.cwd, cwd, "the same path");
        assert_eq!(recovery.branch, "task/one");
        assert_eq!(recovery.head, scene.head);
        assert_eq!(
            git(&scene.worktree, &["branch", "--show-current"]),
            "task/one"
        );
        assert!(
            scene.worktree.join("work.txt").is_file(),
            "committed work is back"
        );
        assert!(recovery.notice.contains("from branch task/one"));
        assert!(recovery.agent_note.contains("not committed"));
        assert_eq!(
            git(&scene.repo, &["branch", "--show-current"]),
            "main",
            "the primary checkout stays put"
        );
    }

    #[test]
    fn a_deleted_branch_is_made_again_at_the_remembered_commit() {
        let scene = scene("head");
        scene.remove_worktree();
        git(&scene.repo, &["branch", "-D", "task/one"]);
        let cwd = Scene::text(&scene.worktree);

        let recovery = restore(&cwd, &scene.remembered()).expect("recovered");

        assert_eq!(recovery.kind, Kind::Rebuilt);
        assert_eq!(recovery.cwd, cwd);
        assert_eq!(recovery.head, scene.head);
        assert_eq!(
            git(&scene.worktree, &["branch", "--show-current"]),
            "task/one"
        );
        assert_eq!(git(&scene.worktree, &["rev-parse", "HEAD"]), scene.head);
        assert!(recovery.notice.contains("made again"));
    }

    #[test]
    fn a_folder_deleted_by_hand_is_rebuilt_from_gits_own_record() {
        // `rm -rf` leaves git's entry for the worktree in place, and nothing
        // was ever verified for this chat: only the project's folder is known.
        let scene = scene("unverified");
        std::fs::remove_dir_all(&scene.worktree).unwrap();
        let cwd = Scene::text(&scene.worktree);
        let known = Remembered {
            fallback: Scene::text(&scene.repo),
            ..Remembered::default()
        };

        let recovery = restore(&cwd, &known).expect("recovered");

        assert_eq!(recovery.kind, Kind::Rebuilt);
        assert_eq!(recovery.cwd, cwd);
        assert_eq!(recovery.branch, "task/one");
        assert!(scene.worktree.join("work.txt").is_file());
    }

    #[test]
    fn a_branch_held_elsewhere_moves_the_chat_to_the_primary_checkout() {
        let scene = scene("held");
        scene.remove_worktree();
        // The primary checkout took the branch over, so no worktree can.
        git(&scene.repo, &["switch", "-q", "task/one"]);
        let cwd = Scene::text(&scene.worktree);

        let recovery = restore(&cwd, &scene.remembered()).expect("recovered");

        assert_eq!(recovery.kind, Kind::Moved);
        assert_eq!(recovery.cwd, Scene::text(&scene.repo));
        assert_eq!(recovery.branch, "task/one");
        assert!(!scene.worktree.exists(), "nothing was rebuilt");
        assert!(
            recovery.notice.contains("could not be rebuilt"),
            "{}",
            recovery.notice
        );
        assert!(recovery.agent_note.contains(&Scene::text(&scene.repo)));
    }

    #[test]
    fn a_folder_that_was_never_a_worktree_falls_back_to_the_projects_folder() {
        let scene = scene("plain");
        let gone = scene.repo.parent().unwrap().join("elsewhere");
        let known = Remembered {
            workspace: Some(Workspace {
                cwd: Scene::text(&gone),
                ..Workspace::default()
            }),
            fallback: Scene::text(&scene.repo),
            ..Remembered::default()
        };

        let recovery = restore(&Scene::text(&gone), &known).expect("recovered");

        assert_eq!(recovery.kind, Kind::Moved);
        assert_eq!(recovery.cwd, Scene::text(&scene.repo));
        assert_eq!(recovery.branch, "main");
        assert!(!gone.exists());
        assert!(recovery.notice.contains("continues in"));
    }

    #[test]
    fn a_missing_subfolder_moves_the_chat_to_the_worktree_that_is_still_there() {
        let scene = scene("subfolder");
        let cwd = Scene::text(&scene.worktree.join("packages").join("app"));

        let recovery = restore(&cwd, &scene.remembered()).expect("recovered");

        assert_eq!(recovery.kind, Kind::Moved);
        assert_eq!(recovery.cwd, Scene::text(&scene.worktree));
        assert_eq!(recovery.branch, "task/one");
    }

    #[test]
    fn nothing_to_go_back_to_is_said_in_words() {
        let scene = scene("nowhere");
        let gone = Scene::text(&scene.repo.parent().unwrap().join("vanished"));

        let nothing = restore(&gone, &Remembered::default()).unwrap_err();
        assert!(
            nothing.starts_with(&format!("The chat's folder {gone} was removed")),
            "{nothing}"
        );
        assert!(nothing.contains("nothing is recorded"), "{nothing}");
        assert!(nothing.ends_with("Start a new chat."), "{nothing}");
        assert!(!nothing.contains("os error"), "{nothing}");

        let other = Scene::text(&scene.repo.parent().unwrap().join("also-gone"));
        let known = Remembered {
            fallback: other.clone(),
            ..Remembered::default()
        };
        let named = restore(&gone, &known).unwrap_err();
        assert!(named.contains(&format!("{other} is gone too")), "{named}");
    }

    #[test]
    fn a_recovery_changes_the_index_and_is_told_to_the_chat_and_the_agent() {
        let scene = scene("settle");
        let chat = format!("recover-settle-{}", uuid::Uuid::new_v4().simple());
        let key = format!("chat:{chat}");
        crate::chat_index::upsert(crate::chat_index::ChatMeta {
            id: chat.clone(),
            project_id: "p1".into(),
            title: "task".into(),
            latest_response: None,
            custom_title: false,
            agent_title: false,
            session_id: None,
            cwd: Some("/gone/folder".into()),
            model_id: None,
            access: None,
            effort: None,
            created_at: 1,
            updated_at: 1,
            read_at: None,
            pinned: false,
            done_at: None,
            deleted_at: None,
            generation: 0,
            launch: None,
        })
        .unwrap();
        let recovery = Recovery {
            kind: Kind::Moved,
            from: "/gone/folder".into(),
            cwd: Scene::text(&scene.repo),
            branch: "main".into(),
            head: String::new(),
            notice: "Folder /gone/folder was removed.".into(),
            agent_note: "[OctiqFlow] moved".into(),
        };

        let settled = recovery.settle(&key, ChatAgent::Codex, Some("session-1"), None);

        let listed = crate::chat_index::list()
            .into_iter()
            .find(|meta| meta.id == chat)
            .expect("still listed");
        assert_eq!(listed.cwd.as_deref(), Some(settled.cwd.as_str()));
        let told = crate::transcript::since(&key, 0)
            .into_iter()
            .map(|item| item.event)
            .find(|event| event["type"] == "octiq_chat_recovered")
            .expect("the chat is told");
        assert_eq!(told["kind"], "moved");
        assert_eq!(told["cwd"], settled.cwd.as_str());
        assert_eq!(told["text"], "Folder /gone/folder was removed.");
        // A start with no prompt keeps the note for the first that has one.
        assert_eq!(with_note(&key, None, None), (None, None));
        assert_eq!(
            with_note(&key, Some("carry on".into()), None),
            (
                Some("[OctiqFlow] moved\n\ncarry on".into()),
                Some("carry on".into())
            ),
            "the agent gets the note; the person's words stay the visible turn"
        );
        assert_eq!(
            with_note(&key, Some("and then".into()), None),
            (Some("and then".into()), None),
            "handed over once"
        );
        let _ = crate::chat_index::remove(&chat);
    }

    #[test]
    fn claude_names_a_session_folder_after_its_working_directory() {
        assert_eq!(
            claude_project_folder(Path::new(
                "/Users/kyson/03-projects/.worktrees/octiq-flow/feature/chat_1"
            ))
            .as_deref(),
            Some("-Users-kyson-03-projects--worktrees-octiq-flow-feature-chat-1")
        );
        assert_eq!(
            claude_project_folder(Path::new(r"C:\Works\octiq flow")).as_deref(),
            Some("C--Works-octiq-flow")
        );
        let long = format!("/{}", "a".repeat(240));
        assert_eq!(claude_project_folder(Path::new(&long)), None);
    }

    #[test]
    fn a_claude_session_follows_the_chat_to_its_new_folder() {
        let scratch = crate::test_dir::TestDir::new("recover-claude").canonicalized();
        let projects = scratch.join("projects");
        let old = projects.join("-gone-worktree");
        std::fs::create_dir_all(&old).unwrap();
        std::fs::write(old.join("abc-123.jsonl"), "{\"type\":\"user\"}\n").unwrap();
        let new_cwd = scratch.join("primary");
        std::fs::create_dir_all(&new_cwd).unwrap();

        let carried = carry_claude_session(&projects, "abc-123", &new_cwd).expect("carried");

        let folder = claude_project_folder(&new_cwd).unwrap();
        assert_eq!(carried, projects.join(&folder).join("abc-123.jsonl"));
        assert_eq!(
            std::fs::read_to_string(&carried).unwrap(),
            "{\"type\":\"user\"}\n"
        );
        assert!(old.join("abc-123.jsonl").is_file(), "the original stays");
        // A second recovery finds it already there.
        assert_eq!(
            carry_claude_session(&projects, "abc-123", &new_cwd),
            Ok(carried)
        );

        let missing = carry_claude_session(&projects, "never-was", &new_cwd).unwrap_err();
        assert!(missing.contains("no longer exists"), "{missing}");
        assert!(carry_claude_session(&projects, "../escape", &new_cwd).is_err());
    }
}
