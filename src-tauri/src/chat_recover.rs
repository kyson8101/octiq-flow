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
//!    was remembered for it. The same path is the point: a chat's sandbox is
//!    bound to the folder it was made for, and Claude files each session
//!    under its working directory.
//!    What the worktree was is read from two places, because either can be
//!    the one that survived: git's own record of it (`git worktree list`,
//!    which keeps a removed worktree until the next prune) and the last
//!    verification `chat_task` stored.
//! 2. **Move the chat to a folder that does exist**: the worktree's root when
//!    only a subfolder went, else the repository's primary checkout as it was
//!    last verified, else a folder registered for the chat's project. The
//!    index is told, and a Claude session is carried to the new folder's
//!    session directory. Claude Code 2.1.292 was seen to resume by id from
//!    any folder, with its session file left under the removed folder's
//!    name, so the carry is for a CLI that only looks under the folder it is
//!    started in. Codex resumes by id from anywhere.
//! 3. **Say why not**, in words a person can act on, instead of the OS error.
//!
//! Three things keep that from doing harm:
//!
//! - **Refused before anything is changed.** A chat that already has a
//!   process, a worker's chat, and a folder a task holds or is cleaning up
//!   are all turned away first (`recover`). The workspace lifecycle lock and
//!   a claim on the chat are then held until the chat has been started
//!   ([`Held`]), so no worker is handed the checkout and no second tab starts
//!   an agent in between.
//! - **A chat is moved only to a folder the host can vouch for**
//!   (`Remembered::vouched`). The folder the page names is whatever a client
//!   sent, and "/" is a directory too: it may choose among the vouched
//!   folders and adds none. A filesystem root and the home folder are never
//!   moved into, and a folder that merely sits where a worktree used to is
//!   not that worktree, whoever offers it: a known worktree root is gone to
//!   only while git still calls it that repository's checkout (`Former`).
//! - **Nothing is deleted or overwritten.** Every repository change is
//!   `git_ops`'s to make: a path that exists is never rebuilt over, and git
//!   refuses a branch another worktree holds, which falls through to step 2.
//!   A session file is carried without writing through either of its names,
//!   one carry at a time (`carry_file`, `Carrying`).
//!
//! What happened is written into the chat as a durable notice
//! (`octiq_chat_recovered`), and the agent is told on its next prompt: its
//! folder was recreated, committed work is intact, uncommitted work is not.

use std::collections::{BTreeMap, HashMap};
use std::path::{Path, PathBuf};
use std::sync::{Mutex, MutexGuard, OnceLock};

use serde_json::json;

use crate::agent_chat::{ChatAgent, ChatManager, StartClaim};
use crate::git::run_git;

/// What is known about where a chat ran, gathered before anything is changed.
#[derive(Debug, Clone, Default)]
pub(crate) struct Remembered {
    /// The last verified workspace (`chat_task`). Its branch and repository
    /// outlive the folder.
    pub workspace: Option<crate::chat_task::Workspace>,
    /// The commit the chat's branch was last seen at.
    pub head: String,
    /// The folders registered for the chat's project (`workspaces.rs`), its
    /// primary one first.
    pub project_paths: Vec<String>,
    /// Where the chat would rather continue: the folder it was planned in,
    /// then the one the page names. Neither is trusted. They choose AMONG the
    /// folders the host can vouch for and add none.
    pub preferred: Vec<String>,
    /// The person's home folder, which no chat is moved into.
    pub home: String,
}

impl Remembered {
    /// `projects` is every registered project; the chat's own is the one its
    /// index entry names, never one the page names.
    fn of(
        chat_id: &str,
        fallback: Option<&str>,
        projects: &[crate::workspaces::Workspace],
    ) -> Self {
        let (workspace, delivery) = crate::chat_task::remembered(chat_id);
        let meta = crate::chat_index::list()
            .into_iter()
            .find(|meta| meta.id == chat_id);
        let project_paths = meta
            .as_ref()
            .and_then(|meta| {
                projects
                    .iter()
                    .find(|project| project.id == meta.project_id)
            })
            .map(|project| {
                std::iter::once(&project.primary_path)
                    .chain(&project.paths)
                    .filter(|path| !path.trim().is_empty())
                    .cloned()
                    .collect()
            })
            .unwrap_or_default();
        let planned = meta.and_then(|meta| meta.launch).map(|plan| plan.path);
        Self {
            workspace,
            head: delivery.map(|delivery| delivery.head).unwrap_or_default(),
            project_paths,
            preferred: planned
                .into_iter()
                .chain(fallback.map(str::to_string))
                .filter(|path| !path.trim().is_empty())
                .collect(),
            home: crate::paths::home_dir()
                .map(|home| home.to_string_lossy().into_owned())
                .unwrap_or_default(),
        }
    }

    /// The folders the host can vouch for, best first: the repository's
    /// primary checkout as `chat_task` last verified it, then the folders
    /// registered for the chat's project, a preferred one ahead of the rest.
    /// Each is named in the host's own spelling, never the client's.
    fn vouched(&self) -> Vec<String> {
        let recorded = self
            .workspace
            .as_ref()
            .map(|workspace| workspace.primary_root.as_str());
        let known: Vec<&str> = recorded
            .into_iter()
            .chain(self.project_paths.iter().map(String::as_str))
            .filter(|path| !path.trim().is_empty())
            .collect();
        let chosen = self.preferred.iter().filter_map(|wanted| {
            known
                .iter()
                .copied()
                .find(|path| !wanted.trim().is_empty() && same_place(path, wanted))
        });
        let mut vouched: Vec<String> = Vec::new();
        for path in recorded
            .into_iter()
            .filter(|path| !path.trim().is_empty())
            .chain(chosen)
            .chain(known.iter().copied())
        {
            if !vouched.iter().any(|seen| seen == path) {
                vouched.push(path.to_string());
            }
        }
        vouched
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

/// A recovery, and what keeps it true until the chat has been started: the
/// workspace lifecycle lock, so no worker is handed this checkout and no
/// cleanup begins, and a claim on the chat, so nothing else starts it. The
/// caller holds this across the start it was made for.
pub(crate) struct Held<'a> {
    pub recovery: Recovery,
    _claim: StartClaim<'a>,
    _lifecycle: MutexGuard<'a, ()>,
}

/// Recover the folder of `key`'s chat when it is missing. `None` when it is
/// there, which is every ordinary start.
///
/// `fallback` is the folder the page names. It is a hint and no more
/// (`Remembered::preferred`).
pub(crate) fn recover<'a>(
    chats: &'a ChatManager,
    projects: &crate::workspaces::WorkspaceState,
    key: &str,
    cwd: &str,
    fallback: Option<&str>,
) -> Result<Option<Held<'a>>, String> {
    let chat_id = key.strip_prefix("chat:").unwrap_or(key);
    recover_from(chats, key, cwd, || {
        let projects = crate::workspaces::list_workspaces_impl(projects).unwrap_or_default();
        Remembered::of(chat_id, fallback, &projects)
    })
}

/// `recover`, with what is remembered handed in. Every refusal comes before
/// anything is changed: the page asking may be a stale one, and the folder it
/// names may by now be a task's.
pub(crate) fn recover_from<'a>(
    chats: &'a ChatManager,
    key: &str,
    cwd: &str,
    known: impl FnOnce() -> Remembered,
) -> Result<Option<Held<'a>>, String> {
    if cwd.trim().is_empty() || Path::new(cwd).is_dir() {
        return Ok(None);
    }
    let orchestrations = &chats.orchestrations;
    // One at a time, with workspace lifecycle held still. Two tabs sending
    // into the same chat would otherwise both try to rebuild the worktree,
    // and the loser, refused by git, would move the chat to the primary
    // checkout under the winner's feet. The second one finds the folder back.
    let lifecycle = orchestrations.hold_workspace_lifecycle()?;
    if Path::new(cwd).is_dir() {
        return Ok(None);
    }
    let claim = chats.claim_start(key)?;
    orchestrations.require_no_owner_of_removed(key, cwd)?;
    // A folder the start itself would be refused in is passed over like one
    // that is gone, so nothing is settled for a start that cannot happen.
    let admitted = |target: &str| {
        orchestrations
            .chat_workspace_access(key, target, true)
            .is_ok()
    };
    let recovery = restore_where(cwd, &known(), &admitted)?;
    Ok(Some(Held {
        recovery,
        _claim: claim,
        _lifecycle: lifecycle,
    }))
}

/// The recovery itself, from what is remembered. Touches git and the disk and
/// no store, so it can be run against a scratch repository.
#[cfg(test)]
pub(crate) fn restore(cwd: &str, known: &Remembered) -> Result<Recovery, String> {
    restore_where(cwd, known, &|_| true)
}

/// `admitted` says whether the chat could be started in a folder at all.
fn restore_where(
    cwd: &str,
    known: &Remembered,
    admitted: &dyn Fn(&str) -> bool,
) -> Result<Recovery, String> {
    let vouched = known.vouched();
    let listed = Listed::under(&vouched);
    let lost = lost_worktree(cwd, known, &listed);
    let mut why_not = String::new();
    if let Some(lost) = lost.as_ref().filter(|lost| !Path::new(&lost.root).exists()) {
        match crate::git_ops::restore_worktree(&lost.primary, &lost.root, &lost.branch, &lost.head)
        {
            Ok(restored) => return Ok(rebuilt(cwd, lost, &restored)),
            Err(why) => why_not = one_line(&why),
        }
    }

    // Where the chat can go instead. The worktree it was in comes first, when
    // only a folder inside it went. Whether it is still that worktree is
    // asked below, of it and of every other folder alike.
    let stored = known.workspace.as_ref();
    let mut candidates: Vec<String> = Vec::new();
    if let Some(lost) = lost.as_ref().filter(|lost| Path::new(&lost.root).is_dir()) {
        candidates.push(lost.root.clone());
    }
    if let Some(workspace) = stored {
        let root = &workspace.repo_root;
        if (workspace.is_worktree && Path::new(root).is_dir())
            || still_checkout_of(root, &workspace.primary_root)
        {
            candidates.push(root.clone());
        }
    }
    candidates.extend(vouched);

    // A folder that was a worktree's root is somewhere to go only while git
    // still calls it that repository's checkout, whichever list offers it: a
    // folder somebody made where a worktree used to be is a directory and
    // nothing more, and being registered for the project does not make it
    // the worktree again.
    let mut former = Former::known(known, lost.as_ref(), &listed);
    let (mut replaced, mut too_wide, mut gone) = (None, None, None);
    for path in &candidates {
        if !Path::new(path).is_dir() {
            if !same_place(path, cwd) {
                gone = Some(path);
            }
        } else if let Some(root) = former.replaced_over(path) {
            replaced.get_or_insert(root);
        } else if !movable(path, &known.home) {
            too_wide.get_or_insert(path);
        } else if admitted(path) {
            return Ok(moved(cwd, path, lost.as_ref(), &why_not));
        }
    }
    // The folder the chat was in may be the one that was replaced, with
    // nobody offering it.
    let replaced = replaced.or_else(|| former.replaced_over(cwd));
    let why = match (why_not.is_empty(), replaced, too_wide, gone) {
        (false, ..) => why_not,
        (true, Some(root), _, gone) => {
            let also = gone
                .map(|path| format!(", and {path} is gone too"))
                .unwrap_or_default();
            format!("{root} is no longer a checkout of the repository it belonged to{also}")
        }
        (true, None, Some(path), _) => format!("{path} is not a folder a chat is moved into"),
        (true, None, None, Some(path)) => format!("{path} is gone too"),
        (true, None, None, None) => "nothing is recorded about the repository it came from".into(),
    };
    Err(format!(
        "The chat's folder {cwd} was removed and could not be restored: {why}. Start a new chat."
    ))
}

/// What git lists for the repositories the host can vouch for: each one's
/// primary checkout, and its linked worktrees. A removed worktree stays
/// listed until the next prune.
#[derive(Default)]
struct Listed {
    primaries: Vec<String>,
    /// A linked worktree, and the primary checkout that lists it.
    worktrees: Vec<(String, crate::git_ops::WorktreeEntry)>,
}

impl Listed {
    /// Only a repository the host can vouch for is asked what it lists.
    fn under(vouched: &[String]) -> Self {
        let mut listed = Self::default();
        for path in vouched
            .iter()
            .filter(|path| Path::new(path.as_str()).is_dir())
        {
            let Ok(primary) = crate::git_ops::primary_checkout_root(path) else {
                continue;
            };
            let primary = primary.to_string_lossy().into_owned();
            if listed.primaries.contains(&primary) {
                continue;
            }
            // The first entry is the primary checkout itself.
            for entry in crate::git_ops::listed_worktrees(&primary)
                .into_iter()
                .skip(1)
            {
                listed.worktrees.push((primary.clone(), entry));
            }
            listed.primaries.push(primary);
        }
        listed
    }
}

/// Which worktree `cwd` was (in), from git's own list first and the stored
/// verification second.
fn lost_worktree(cwd: &str, known: &Remembered, listed: &Listed) -> Option<Lost> {
    let stored = known
        .workspace
        .as_ref()
        .filter(|workspace| workspace.is_worktree && !workspace.repo_root.trim().is_empty());
    // A detached HEAD is stored as "(abc1234)", which is not a branch name.
    let stored_branch = stored
        .map(|workspace| workspace.branch.as_str())
        .filter(|branch| !branch.starts_with('('))
        .unwrap_or_default();

    for (primary, entry) in &listed.worktrees {
        if !holds(&entry.path, cwd) {
            continue;
        }
        let recorded = !entry.head.is_empty() && entry.head.chars().any(|c| c != '0');
        return Some(Lost {
            primary: primary.clone(),
            branch: if entry.branch.is_empty() {
                stored_branch.to_string()
            } else {
                entry.branch.clone()
            },
            head: if recorded {
                entry.head.clone()
            } else {
                known.head.clone()
            },
            root: spelled_like(cwd, &entry.path),
        });
    }

    let stored = stored?;
    let primary = listed.primaries.iter().find(|primary| {
        same_place(primary, &stored.primary_root) || stored.primary_root.trim().is_empty()
    })?;
    holds(&stored.repo_root, cwd).then(|| Lost {
        primary: primary.clone(),
        root: stored.repo_root.clone(),
        branch: stored_branch.to_string(),
        head: known.head.clone(),
    })
}

/// The folders the host knows to have been a linked worktree's root, each
/// with the repositories it is said to have been a checkout of. Three places
/// say so: the worktree the missing folder was found in, the last
/// verification `chat_task` stored, and git's own list for every repository
/// the host can vouch for.
struct Former(Vec<FormerRoot>);

struct FormerRoot {
    root: String,
    /// `root` with its symlinks resolved, to compare against.
    place: PathBuf,
    primaries: Vec<String>,
    /// Whether git still calls it one of those repositories' checkout. Asked
    /// once, and only when something lies in it: a repository can list dozens
    /// of worktrees that have nothing to do with this chat.
    still: Option<bool>,
}

impl Former {
    fn known(known: &Remembered, lost: Option<&Lost>, listed: &Listed) -> Self {
        let stored = known
            .workspace
            .as_ref()
            .filter(|workspace| workspace.is_worktree)
            .map(|workspace| {
                (
                    workspace.repo_root.as_str(),
                    workspace.primary_root.as_str(),
                )
            });
        let said = lost
            .map(|lost| (lost.root.as_str(), lost.primary.as_str()))
            .into_iter()
            .chain(stored)
            .chain(
                listed
                    .worktrees
                    .iter()
                    .map(|(primary, entry)| (entry.path.as_str(), primary.as_str())),
            );
        let mut roots: Vec<FormerRoot> = Vec::new();
        for (root, primary) in said.filter(|(root, _)| !root.trim().is_empty()) {
            let place = resolved(root);
            let at = match roots.iter().position(|former| former.place == place) {
                Some(at) => at,
                None => {
                    roots.push(FormerRoot {
                        root: root.to_string(),
                        place,
                        primaries: Vec::new(),
                        still: None,
                    });
                    roots.len() - 1
                }
            };
            if !primary.trim().is_empty() && !roots[at].primaries.iter().any(|p| p == primary) {
                roots[at].primaries.push(primary.to_string());
            }
        }
        Self(roots)
    }

    /// The former worktree root `path` is, or lies in, that is a folder now
    /// and no longer a checkout of the repository it belonged to. `None` for
    /// a folder that never was a worktree, which is most of what a project
    /// registers, and for one that still is.
    fn replaced_over(&mut self, path: &str) -> Option<String> {
        let place = resolved(path);
        for former in &mut self.0 {
            if !place.starts_with(&former.place) || !Path::new(&former.root).is_dir() {
                continue;
            }
            let still = match former.still {
                Some(still) => still,
                None => former
                    .primaries
                    .iter()
                    .any(|primary| still_checkout_of(&former.root, primary)),
            };
            former.still = Some(still);
            if !still {
                return Some(former.root.clone());
            }
        }
        None
    }
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
    let target = native(target);
    let target = target.as_str();
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

impl Held<'_> {
    /// Record the recovery this holds, once nothing can refuse the start any
    /// more. It is a method of what is held, and the only way in from outside
    /// this module, so it cannot run after the lock and the claim are let go:
    /// the session is carried, and the chat's folder changed, while nothing
    /// else can start this chat's agent or read where it is going.
    pub(crate) fn settle(
        &self,
        key: &str,
        agent: ChatAgent,
        resume: Option<&str>,
        env: Option<&BTreeMap<String, String>>,
    ) {
        self.recovery.clone().settle(key, agent, resume, env);
    }
}

impl Recovery {
    /// Record a recovery that has taken hold: the index learns a new folder,
    /// a Claude session follows the chat there, the chat is told in its
    /// transcript and the agent's next prompt carries the note. Reached
    /// through [`Held::settle`], so after every refusal `recover` makes and
    /// before anything else can start the chat: a start refused there says
    /// nothing.
    fn settle(
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

/// Make a Claude session findable from `new_cwd`, for a CLI whose
/// `--resume <id>` looks only in the session folder of the directory it is
/// started in. The file is hard-linked there, so both names stay one
/// conversation, or copied when a link cannot be made; the original stays
/// where it was. When several folders hold the session, the one written last
/// is the conversation.
///
/// One carry runs at a time ([`carrying`]), so a second one of the same
/// session starts only when the first has finished: it finds the whole file,
/// or none.
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
    let turn = carrying();
    let filed: Vec<PathBuf> = std::fs::read_dir(projects)
        .map_err(|error| format!("{} cannot be read: {error}", projects.display()))?
        .flatten()
        .map(|entry| entry.path().join(&name))
        .filter(|candidate| candidate.is_file())
        .collect();
    if filed.is_empty() {
        return Err("its session file no longer exists".into());
    }
    // Claude reads its working directory with symlinks resolved.
    let resolved = crate::paths::canonicalize(new_cwd).unwrap_or_else(|_| new_cwd.to_path_buf());
    let folder = claude_project_folder(&resolved)
        .ok_or("the new folder's path is too long to name its session folder")?;
    let target = projects.join(folder).join(&name);
    let Some(source) = filed
        .into_iter()
        .filter(|candidate| *candidate != target)
        .max_by_key(|candidate| written(candidate))
    else {
        // Filed under the new folder and nowhere else.
        return Ok(target);
    };
    let parent = target.parent().ok_or("the session folder has no parent")?;
    std::fs::create_dir_all(parent)
        .map_err(|error| format!("{} cannot be created: {error}", parent.display()))?;
    carry_file(&source, &target, &turn)?;
    Ok(target)
}

/// The one carry this process is making. Every function that gives a session
/// file a second name asks for it, so none can be called beside another: it
/// is made only by [`carrying`], which waits for the carry before it, and it
/// cannot be lent to a second thread.
///
/// What that buys is the last resort (`write_new`), the one way a name can
/// exist before its file is whole. A second carry of the same session, and
/// the start that follows it, wait here until the first has written the
/// whole file or taken its unfinished one away.
struct Carrying {
    _turn: MutexGuard<'static, ()>,
    /// A guard is `Sync`; this is not, so `&Carrying` stays on its thread.
    _here: std::marker::PhantomData<*const ()>,
}

static CARRY: Mutex<()> = Mutex::new(());

fn carrying() -> Carrying {
    Carrying {
        _turn: CARRY.lock().unwrap_or_else(|e| e.into_inner()),
        _here: std::marker::PhantomData,
    }
}

/// Give the file at `source` the name `target` as well, without ever writing
/// through either name.
///
/// Two starts of one chat can both get here, one after the other. The second
/// finds `target` made, and that is success: a copy over it would open for
/// writing the very file it is reading, since both names are one file, and
/// leave the conversation empty under both.
fn carry_file(source: &Path, target: &Path, turn: &Carrying) -> Result<(), String> {
    match std::fs::hard_link(source, target) {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {
            keep_newer(source, target, turn)
        }
        // No link can be made: another device, or a filesystem without them.
        Err(_) => publish_copy(source, target, turn),
    }
}

/// When a file was last written. `None` sorts first, so a file that cannot be
/// read is never taken for the newer one.
fn written(path: &Path) -> Option<std::time::SystemTime> {
    std::fs::metadata(path)
        .and_then(|meta| meta.modified())
        .ok()
}

/// `target` is already there. It stays, unless `source` was written after it:
/// then it is an older copy of the conversation, and the newer one takes its
/// name by a rename, which swaps the whole file at once. Two names of one
/// file were written at the same moment, so a link is always left alone.
fn keep_newer(source: &Path, target: &Path, _turn: &Carrying) -> Result<(), String> {
    match (written(source), written(target)) {
        (Some(from), Some(to)) if from > to => {}
        _ => return Ok(()),
    }
    let staged = staged_copy(source, target)?;
    std::fs::rename(&staged, target).map_err(|error| {
        let _ = std::fs::remove_file(&staged);
        format!("the newer session file cannot replace the older one: {error}")
    })
}

/// A whole copy of `source` beside `target`, under a name nothing reads: not
/// a `.jsonl`, so Claude and the history list pass it over.
fn staged_copy(source: &Path, target: &Path) -> Result<PathBuf, String> {
    let name = target
        .file_name()
        .ok_or("the session file has no name")?
        .to_string_lossy();
    let staged = target.with_file_name(format!(
        ".{name}.{}.carrying",
        uuid::Uuid::new_v4().simple()
    ));
    std::fs::copy(source, &staged).map_err(|error| {
        let _ = std::fs::remove_file(&staged);
        format!("the session file cannot be copied: {error}")
    })?;
    Ok(staged)
}

/// Carry by copying: the copy is made whole under another name first, then
/// given the name `target` by a hard link, which publishes the whole file at
/// once and only if nothing has the name. A carry that finds the name taken
/// changes nothing. Only a filesystem with no links at all goes on to the
/// last resort, which promises less (`write_new`).
fn publish_copy(source: &Path, target: &Path, turn: &Carrying) -> Result<(), String> {
    let staged = staged_copy(source, target)?;
    let published = match std::fs::hard_link(&staged, target) {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {
            keep_newer(source, target, turn)
        }
        Err(_) => publish_exclusive(&staged, target, turn),
    };
    let _ = std::fs::remove_file(&staged);
    published
}

/// The last resort, for a filesystem with no links at all.
fn publish_exclusive(staged: &Path, target: &Path, turn: &Carrying) -> Result<(), String> {
    let mut from = std::fs::File::open(staged)
        .map_err(|error| format!("the session file cannot be copied: {error}"))?;
    write_new(&mut from, target, turn)
}

/// Make `target` with `create_new` and write `from` into it. `create_new` is
/// what refuses a name somebody else made first, and that again is success:
/// nothing that exists is ever written over or cut short.
///
/// What it does NOT give is a name that appears whole. Nothing in `std`
/// publishes a file without a link and without replacing, so here the name
/// exists while the file is still being written. Two things keep that from
/// being read as the conversation:
///
/// - no other carry runs meanwhile ([`Carrying`]), so the next one finds the
///   file whole, or gone: one this made and could not finish is taken away
///   again before the turn is given up;
/// - the chat's agent is started by the thread that settled the recovery,
///   after this has returned, and nothing else can start it
///   ([`Held::settle`]).
///
/// Another program reading the folder in that moment can see part of the
/// file, and a server that dies in the middle leaves that part behind.
fn write_new(from: &mut dyn std::io::Read, target: &Path, _turn: &Carrying) -> Result<(), String> {
    let mut to = match std::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(target)
    {
        Ok(file) => file,
        Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => return Ok(()),
        Err(error) => return Err(format!("the session file cannot be created: {error}")),
    };
    let copied = std::io::copy(from, &mut to).and_then(|_| to.sync_all());
    drop(to);
    copied.map_err(|error| {
        let _ = std::fs::remove_file(target);
        format!("the session file cannot be copied: {error}")
    })
}

// ------------------------------------------------------------------- paths

/// A path with its symlinks resolved as far as it exists, so a folder that is
/// gone still compares equal to git's spelling of it.
fn resolved(path: &str) -> PathBuf {
    let path = Path::new(path.trim_end_matches(['/', '\\']));
    crate::paths::canonical_target(path).unwrap_or_else(|| path.to_path_buf())
}

/// A path in the platform's own spelling. git answers `C:/repo/wt` on Windows,
/// and stored as a chat's folder that would sit beside `C:\repo\wt` as though
/// it were somewhere else.
fn native(path: &str) -> String {
    Path::new(path)
        .components()
        .collect::<PathBuf>()
        .to_string_lossy()
        .into_owned()
}

/// git's name for a worktree, spelled the way the chat spells its own folder:
/// the ancestor of `cwd` that is that place. The chat's spelling is the one
/// its index entry and its sandbox were recorded under.
fn spelled_like(cwd: &str, listed: &str) -> String {
    let wanted = resolved(listed);
    Path::new(cwd.trim_end_matches(['/', '\\']))
        .ancestors()
        .find(|ancestor| resolved(&ancestor.to_string_lossy()) == wanted)
        .map(|ancestor| ancestor.to_string_lossy().into_owned())
        .unwrap_or_else(|| native(listed))
}

fn same_place(a: &str, b: &str) -> bool {
    resolved(a) == resolved(b)
}

/// Whether `root` is, right now, a checkout of the repository whose primary
/// checkout is `primary`: git names `root` itself as the top of a working
/// tree, and that tree belongs to `primary`. A plain folder made where a
/// worktree was removed fails the first half, even inside another checkout.
fn still_checkout_of(root: &str, primary: &str) -> bool {
    if root.trim().is_empty() || primary.trim().is_empty() || !Path::new(root).is_dir() {
        return false;
    }
    let top = run_git(root, &["rev-parse", "--show-toplevel"]);
    top.is_some_and(|top| same_place(top.trim(), root))
        && crate::git_ops::primary_checkout_root(root)
            .is_ok_and(|found| same_place(&found.to_string_lossy(), primary))
}

/// Whether a chat may be moved into `path` at all, as written and with its
/// symlinks resolved.
fn movable(path: &str, home: &str) -> bool {
    let real = |path: &str| resolved(path).to_string_lossy().into_owned();
    let real_home = if home.trim().is_empty() {
        String::new()
    } else {
        real(home)
    };
    !too_broad(path, home, cfg!(windows)) && !too_broad(&real(path), &real_home, cfg!(windows))
}

/// A place no chat is moved into on the host's own initiative: a filesystem
/// root, or the person's home folder. Neither is anybody's choice of a
/// working folder: a project made without one is registered at the home
/// folder (`workspaces::default_path`), and an agent started there reaches
/// everything the person has.
///
/// Pure, with the platform as a parameter, so the Windows spellings are
/// tested where this is developed.
fn too_broad(path: &str, home: &str, is_windows: bool) -> bool {
    let plain = |path: &str| {
        let path = path.trim();
        if !is_windows {
            return path.trim_end_matches('/').to_string();
        }
        let path = path.replace('/', "\\").to_ascii_lowercase();
        let path = match path.strip_prefix(r"\\?\unc\") {
            Some(share) => format!(r"\\{share}"),
            None => path.strip_prefix(r"\\?\").unwrap_or(&path).to_string(),
        };
        path.trim_end_matches('\\').to_string()
    };
    let place = plain(path);
    // "/" and "C:\" come down to nothing and a bare drive; a share's own root
    // is `\\server\share`.
    let root = place.is_empty()
        || (is_windows
            && (place
                .strip_suffix(':')
                .is_some_and(|drive| drive.len() == 1)
                || place
                    .strip_prefix(r"\\")
                    .is_some_and(|share| share.split('\\').count() <= 2)));
    root || (!home.trim().is_empty() && place == plain(home))
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

    /// A chat the index lists under `project`, with a folder that is gone.
    fn listed_chat(name: &str, project: &str) -> String {
        let chat = format!("recover-{name}-{}", uuid::Uuid::new_v4().simple());
        crate::chat_index::upsert(crate::chat_index::ChatMeta {
            id: chat.clone(),
            project_id: project.into(),
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
        chat
    }

    /// What git lists for the scene's repository, one path per worktree.
    fn listed_worktrees(scene: &Scene) -> Vec<String> {
        crate::git_ops::listed_worktrees(&Scene::text(&scene.repo))
            .into_iter()
            .map(|entry| entry.path)
            .collect()
    }

    /// Whether a recovery was told to `key`'s chat.
    fn told(key: &str) -> bool {
        crate::transcript::since(key, 0)
            .into_iter()
            .any(|item| item.event["type"] == "octiq_chat_recovered")
    }

    #[test]
    fn a_folder_that_exists_is_left_alone() {
        let here = crate::test_dir::TestDir::new("recover-present");
        let chats = ChatManager::default();
        let projects = crate::workspaces::WorkspaceState::with_projects(Vec::new());
        let present = recover(
            &chats,
            &projects,
            "chat:present",
            &here.to_string_lossy(),
            None,
        );
        assert!(matches!(present, Ok(None)));
        let blank = recover(&chats, &projects, "chat:blank", "", None);
        assert!(matches!(blank, Ok(None)));
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
    fn a_rebuilt_worktree_is_the_folder_the_chats_sandbox_belongs_to() {
        let scene = scene("sandbox");
        let scratch = crate::test_dir::TestDir::new("recover-sandbox-store");
        let sandboxes = crate::sandbox::Store::at(scratch.join("sandboxes"));
        let cwd = Scene::text(&scene.worktree);
        sandboxes
            .select("chat:sandboxed", &cwd, Some(true), false)
            .expect("a sandbox bound to the worktree");
        scene.remove_worktree();

        // What the person used to be shown.
        let raw = sandboxes
            .select("chat:sandboxed", &cwd, None, true)
            .unwrap_err();
        assert!(raw.starts_with("Chat folder is unavailable"), "{raw}");

        let recovery = restore(&cwd, &scene.remembered()).expect("recovered");
        assert_eq!(recovery.cwd, cwd);
        sandboxes
            .select("chat:sandboxed", &recovery.cwd, None, true)
            .expect("the same folder, so the same sandbox");

        // Ownership is not loosened for a chat that had to move instead.
        scene.remove_worktree();
        git(&scene.repo, &["switch", "-q", "task/one"]);
        let moved = restore(&cwd, &scene.remembered()).expect("recovered");
        assert_eq!(moved.kind, Kind::Moved);
        let refused = sandboxes
            .select("chat:sandboxed", &moved.cwd, None, true)
            .unwrap_err();
        assert!(
            refused.contains("belongs to a different folder"),
            "{refused}"
        );
    }

    #[test]
    fn a_folder_deleted_by_hand_is_rebuilt_from_gits_own_record() {
        // `rm -rf` leaves git's entry for the worktree in place, and nothing
        // was ever verified for this chat: only the project's folder is known.
        let scene = scene("unverified");
        std::fs::remove_dir_all(&scene.worktree).unwrap();
        let cwd = Scene::text(&scene.worktree);
        let known = Remembered {
            project_paths: vec![Scene::text(&scene.repo)],
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
            project_paths: vec![Scene::text(&scene.repo)],
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
    fn gits_spelling_of_a_worktree_becomes_the_chats_own() {
        let scene = scene("spelling");
        let root = Scene::text(&scene.worktree);
        let inside = Scene::text(&scene.worktree.join("packages").join("app"));
        // git lists a Windows worktree with forward slashes.
        let listed = root.replace('\\', "/");
        assert_eq!(spelled_like(&inside, &listed), root);
        assert_eq!(spelled_like(&format!("{root}/"), &listed), root);
        // Nothing of the chat's to borrow from: the platform's spelling.
        assert_eq!(
            native("/repos/app//wt/"),
            ["", "repos", "app", "wt"].join(std::path::MAIN_SEPARATOR_STR)
        );
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
            project_paths: vec![other.clone()],
            ..Remembered::default()
        };
        let named = restore(&gone, &known).unwrap_err();
        assert!(named.contains(&format!("{other} is gone too")), "{named}");
    }

    #[test]
    fn a_recovery_changes_the_index_and_is_told_to_the_chat_and_the_agent() {
        let scene = scene("settle");
        let chat = listed_chat("settle", "p1");
        let key = format!("chat:{chat}");
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

    // ------------------------------------------------- refused before a change

    #[test]
    fn a_chat_that_is_running_is_refused_before_anything_is_changed() {
        let scene = scene("live");
        // Deleted by hand, so git still lists it: a rebuild would prune that.
        std::fs::remove_dir_all(&scene.worktree).unwrap();
        let before = listed_worktrees(&scene);
        let cwd = Scene::text(&scene.worktree);
        let chats = ChatManager::default();
        let key = format!("chat:recover-live-{}", uuid::Uuid::new_v4().simple());
        chats.test_launch(&key);

        // A stale page sends the removed folder for a chat that has since
        // been started somewhere else.
        let refused = recover_from(&chats, &key, &cwd, || scene.remembered())
            .err()
            .expect("refused");

        assert!(refused.contains("already running"), "{refused}");
        assert!(!scene.worktree.exists(), "nothing was rebuilt");
        assert_eq!(listed_worktrees(&scene), before, "git was not touched");
        assert!(!told(&key));
        chats.test_end(&key);

        // The same start, once the chat has no process, puts the folder back.
        let held = recover_from(&chats, &key, &cwd, || scene.remembered())
            .expect("recovered")
            .expect("its folder was gone");
        assert_eq!(held.recovery.kind, Kind::Rebuilt);
    }

    #[test]
    fn two_starts_of_one_removed_worktree_rebuild_it_once() {
        let scene = scene("twice");
        scene.remove_worktree();
        let cwd = Scene::text(&scene.worktree);
        let chats = ChatManager::default();
        let key = format!("chat:recover-twice-{}", uuid::Uuid::new_v4().simple());
        const STARTS: usize = 8;
        let together = std::sync::Barrier::new(STARTS);

        let outcomes: Vec<Result<Option<Kind>, String>> = std::thread::scope(|scope| {
            let starts: Vec<_> = (0..STARTS)
                .map(|_| {
                    scope.spawn(|| {
                        together.wait();
                        let held = recover_from(&chats, &key, &cwd, || scene.remembered())?;
                        Ok(held.map(|held| {
                            // What `chat_start` does while it still holds
                            // the recovery: start the chat.
                            chats.test_launch(&key);
                            held.recovery.kind
                        }))
                    })
                })
                .collect();
            starts
                .into_iter()
                .map(|start| start.join().expect("a start"))
                .collect()
        });

        let rebuilt = outcomes
            .iter()
            .filter(|outcome| **outcome == Ok(Some(Kind::Rebuilt)))
            .count();
        assert_eq!(rebuilt, 1, "{outcomes:?}");
        // Every other start found the folder back, and is the ordinary start
        // of a chat that is already running.
        assert_eq!(
            outcomes
                .iter()
                .filter(|outcome| **outcome == Ok(None))
                .count(),
            STARTS - 1,
            "{outcomes:?}"
        );
        assert!(chats.has_process(&key));
        assert_eq!(
            listed_worktrees(&scene)
                .iter()
                .filter(|path| same_place(path, &cwd))
                .count(),
            1
        );
        assert_eq!(
            git(&scene.worktree, &["branch", "--show-current"]),
            "task/one"
        );
        chats.test_end(&key);
    }

    // -------------------------------------------------- where a chat may move

    #[test]
    fn the_folder_a_page_names_chooses_among_the_vouched_and_adds_none() {
        let scene = scene("named");
        let scratch = scene.repo.parent().unwrap().to_path_buf();
        let gone = Scene::text(&scratch.join("vanished"));
        let unrelated = scratch.join("unrelated");
        let second = scratch.join("second");
        std::fs::create_dir_all(&unrelated).unwrap();
        std::fs::create_dir_all(&second).unwrap();
        let root = Scene::text(scratch.ancestors().last().unwrap());

        // Named by the page and vouched for by nobody: "/" and a folder that
        // has nothing to do with the chat are directories, and no more.
        for named in [root.clone(), Scene::text(&unrelated)] {
            let known = Remembered {
                preferred: vec![named.clone()],
                ..Remembered::default()
            };
            let refused = restore(&gone, &known).unwrap_err();
            assert!(
                refused.starts_with(&format!("The chat's folder {gone} was removed")),
                "{refused}"
            );
            assert!(
                refused.contains("nothing is recorded"),
                "{named}: {refused}"
            );
            assert!(refused.ends_with("Start a new chat."), "{refused}");
        }

        // It does choose between the project's own folders.
        let project = vec![Scene::text(&scene.repo), Scene::text(&second)];
        let chosen = Remembered {
            project_paths: project.clone(),
            preferred: vec![format!("{}/", Scene::text(&second))],
            ..Remembered::default()
        };
        let recovery = restore(&gone, &chosen).expect("recovered");
        assert_eq!(recovery.cwd, Scene::text(&second), "in the host's spelling");

        // And a name that is not one of them changes nothing.
        let ignored = Remembered {
            project_paths: project,
            preferred: vec![Scene::text(&unrelated), root],
            ..Remembered::default()
        };
        let recovery = restore(&gone, &ignored).expect("recovered");
        assert_eq!(recovery.cwd, Scene::text(&scene.repo));
    }

    #[test]
    fn a_chat_is_never_moved_into_a_root_or_the_home_folder() {
        let scene = scene("broad");
        let scratch = scene.repo.parent().unwrap().to_path_buf();
        let gone = Scene::text(&scratch.join("vanished"));
        let root = Scene::text(scratch.ancestors().last().unwrap());
        let home = Scene::text(&scene.repo);

        // Even registered: a project made without a folder gets the home one.
        let at_root = Remembered {
            project_paths: vec![root.clone()],
            preferred: vec![root.clone()],
            ..Remembered::default()
        };
        let refused = restore(&gone, &at_root).unwrap_err();
        assert!(
            refused.contains(&format!("{root} is not a folder a chat is moved into")),
            "{refused}"
        );
        assert!(refused.ends_with("Start a new chat."), "{refused}");

        let at_home = Remembered {
            project_paths: vec![home.clone()],
            preferred: vec![home.clone()],
            home: format!("{home}/"),
            ..Remembered::default()
        };
        let refused = restore(&gone, &at_home).unwrap_err();
        assert!(
            refused.contains(&format!("{home} is not a folder a chat is moved into")),
            "{refused}"
        );

        // The recorded primary checkout is held to the same rule.
        let recorded = Remembered {
            workspace: Some(Workspace {
                cwd: gone.clone(),
                primary_root: home.clone(),
                ..Workspace::default()
            }),
            home: home.clone(),
            ..Remembered::default()
        };
        assert!(restore(&gone, &recorded).is_err());
        // The same folder is fine when it is nobody's home.
        let elsewhere = Remembered {
            home: Scene::text(&scratch.join("somebody")),
            ..recorded
        };
        assert_eq!(restore(&gone, &elsewhere).expect("recovered").cwd, home);
    }

    #[test]
    fn a_root_and_a_home_folder_are_told_apart_on_either_platform() {
        // POSIX.
        assert!(too_broad("/", "/Users/ada", false));
        assert!(too_broad("//", "", false));
        assert!(too_broad("", "", false));
        assert!(too_broad("/Users/ada", "/Users/ada", false));
        assert!(too_broad("/Users/ada/", "/Users/ada", false));
        assert!(!too_broad("/Users/ada/app", "/Users/ada", false));
        assert!(
            !too_broad("/Users/Ada", "/Users/ada", false),
            "case matters"
        );
        assert!(!too_broad("/repos/app", "", false), "no home known");
        // Windows: drives, shares, verbatim spellings, either slash.
        for root in [
            r"C:\",
            "C:",
            "c:/",
            r"\",
            "/",
            r"\\?\C:\",
            r"\\server\share",
            r"\\server\share\",
            r"\\?\UNC\server\share",
            "//server/share",
        ] {
            assert!(too_broad(root, r"C:\Users\ada", true), "{root}");
        }
        assert!(too_broad(r"C:\Users\ada", r"C:\Users\ada", true));
        assert!(too_broad(r"c:/users/ADA/", r"C:\Users\ada", true));
        assert!(too_broad(r"\\?\C:\Users\ada", r"C:\Users\ada", true));
        assert!(!too_broad(r"C:\Users\ada\app", r"C:\Users\ada", true));
        assert!(!too_broad(r"C:\Works", r"C:\Users\ada", true));
        assert!(!too_broad(r"\\server\share\app", r"C:\Users\ada", true));
        assert!(!too_broad(r"D:\repos", "", true));
    }

    #[test]
    fn a_plain_folder_where_a_worktree_was_is_not_that_worktree() {
        // Removed properly, then somebody made a folder of the same name.
        let scene = scene("replaced");
        scene.remove_worktree();
        std::fs::create_dir_all(&scene.worktree).unwrap();
        let cwd = Scene::text(&scene.worktree.join("packages").join("app"));

        let recovery = restore(&cwd, &scene.remembered()).expect("recovered");

        assert_eq!(recovery.kind, Kind::Moved);
        assert_eq!(
            recovery.cwd,
            Scene::text(&scene.repo),
            "the primary checkout, not the stand-in folder"
        );
        assert!(!scene.worktree.join(".git").exists(), "left as it was");

        // The same, when git still lists the worktree it used to be.
        let scene = self::scene("replaced-listed");
        std::fs::remove_dir_all(&scene.worktree).unwrap();
        std::fs::create_dir_all(&scene.worktree).unwrap();
        let cwd = Scene::text(&scene.worktree.join("packages").join("app"));
        let recovery = restore(&cwd, &scene.remembered()).expect("recovered");
        assert_eq!(recovery.cwd, Scene::text(&scene.repo));

        // With nowhere vouched for to go instead, it is said in words.
        let alone = Remembered {
            workspace: Some(Workspace {
                primary_root: Scene::text(&scene.repo.parent().unwrap().join("no-repo")),
                ..scene.remembered().workspace.unwrap()
            }),
            ..Remembered::default()
        };
        let refused = restore(&cwd, &alone).unwrap_err();
        assert!(
            refused.starts_with(&format!("The chat's folder {cwd} was removed")),
            "{refused}"
        );
        assert!(refused.contains("is gone too"), "{refused}");
        assert!(refused.contains("is no longer a checkout"), "{refused}");
        assert!(refused.ends_with("Start a new chat."), "{refused}");
    }

    /// Review R3, the reviewer's scene: the worktree was removed properly, a
    /// plain folder now sits at its root, and the primary checkout was moved
    /// away, so the one on record is gone. The chat ran one level inside.
    fn replaced_with_the_primary_gone(name: &str) -> (Scene, String) {
        let scene = scene(name);
        scene.remove_worktree();
        std::fs::create_dir_all(&scene.worktree).unwrap();
        std::fs::write(scene.worktree.join("replacement.txt"), "not a checkout\n").unwrap();
        std::fs::rename(&scene.repo, scene.repo.with_file_name("repo-moved")).unwrap();
        let cwd = Scene::text(&scene.worktree.join("packages").join("app"));
        (scene, cwd)
    }

    fn names_in(folder: &Path) -> Vec<String> {
        let mut names: Vec<String> = std::fs::read_dir(folder)
            .unwrap()
            .flatten()
            .map(|entry| entry.file_name().to_string_lossy().into_owned())
            .collect();
        names.sort();
        names
    }

    #[test]
    fn a_replaced_worktree_root_is_not_gone_to_because_the_project_registers_it() {
        let (scene, cwd) = replaced_with_the_primary_gone("registered");
        let root = Scene::text(&scene.worktree);
        let repo = Scene::text(&scene.repo);
        let refusal = format!(
            "The chat's folder {cwd} was removed and could not be restored: {root} is no longer a checkout of the repository it belonged to, and {repo} is gone too. Start a new chat."
        );

        // Nobody offers it.
        assert_eq!(restore(&cwd, &scene.remembered()), Err(refusal.clone()));

        // The chat's project registers it, and the page names it: it used to
        // come back in through that list, unchecked.
        let registered = Remembered {
            project_paths: vec![root.clone()],
            preferred: vec![root.clone()],
            ..scene.remembered()
        };
        assert_eq!(restore(&cwd, &registered), Err(refusal.clone()));

        // A project that points one level into it fares no better.
        let inside = scene.worktree.join("packages");
        std::fs::create_dir_all(&inside).unwrap();
        let one_level_in = Remembered {
            project_paths: vec![Scene::text(&inside)],
            ..scene.remembered()
        };
        assert_eq!(restore(&cwd, &one_level_in), Err(refusal));
        assert_eq!(
            names_in(&scene.worktree),
            ["packages", "replacement.txt"],
            "left as it was"
        );
    }

    #[test]
    fn a_replaced_worktree_root_is_passed_over_for_a_registered_folder_that_is_safe() {
        let (scene, cwd) = replaced_with_the_primary_gone("registered-second");
        let root = Scene::text(&scene.worktree);
        // A project folder with no Git history: never a worktree.
        let second = scene.repo.with_file_name("second");
        std::fs::create_dir_all(&second).unwrap();
        let known = Remembered {
            project_paths: vec![root.clone(), Scene::text(&second)],
            preferred: vec![root],
            ..scene.remembered()
        };

        let recovery = restore(&cwd, &known).expect("recovered");

        assert_eq!(recovery.kind, Kind::Moved);
        assert_eq!(recovery.cwd, Scene::text(&second));
        assert_eq!(recovery.branch, "");
        assert_eq!(names_in(&scene.worktree), ["replacement.txt"]);
    }

    #[test]
    fn a_replaced_worktree_root_git_still_lists_is_passed_over_too() {
        // Deleted by hand, so git's list is what says it was a worktree:
        // nothing was ever verified for this chat.
        let scene = scene("registered-listed");
        std::fs::remove_dir_all(&scene.worktree).unwrap();
        std::fs::create_dir_all(&scene.worktree).unwrap();
        let cwd = Scene::text(&scene.worktree.join("packages").join("app"));
        let known = Remembered {
            project_paths: vec![Scene::text(&scene.worktree), Scene::text(&scene.repo)],
            ..Remembered::default()
        };

        let recovery = restore(&cwd, &known).expect("recovered");

        assert_eq!(recovery.kind, Kind::Moved);
        assert_eq!(recovery.cwd, Scene::text(&scene.repo));
        assert_eq!(recovery.branch, "main");
    }

    #[test]
    fn a_registered_worktree_that_is_still_a_checkout_takes_the_chat_back() {
        // Only a folder inside it went, and the project registers the
        // worktree itself.
        let scene = scene("registered-live");
        let root = Scene::text(&scene.worktree);
        let cwd = Scene::text(&scene.worktree.join("packages").join("app"));
        let verified = Remembered {
            project_paths: vec![root.clone()],
            ..scene.remembered()
        };
        // The same, for a chat nothing was ever verified for.
        let unverified = Remembered {
            project_paths: vec![root.clone()],
            ..Remembered::default()
        };

        for known in [verified, unverified] {
            let recovery = restore(&cwd, &known).expect("recovered");
            assert_eq!(recovery.kind, Kind::Moved);
            assert_eq!(recovery.cwd, root);
            assert_eq!(recovery.branch, "task/one");
            assert_eq!(recovery.head, scene.head);
        }
    }

    #[test]
    fn a_registered_folder_with_no_git_history_is_still_somewhere_to_go() {
        let scratch = crate::test_dir::TestDir::new("recover-no-git").canonicalized();
        let notes = scratch.join("notes");
        std::fs::create_dir_all(&notes).unwrap();
        let gone = Scene::text(&notes.join("drafts"));
        let known = Remembered {
            workspace: Some(Workspace {
                cwd: gone.clone(),
                ..Workspace::default()
            }),
            project_paths: vec![Scene::text(&notes)],
            ..Remembered::default()
        };

        let recovery = restore(&gone, &known).expect("recovered");

        assert_eq!(recovery.kind, Kind::Moved);
        assert_eq!(recovery.cwd, Scene::text(&notes));
        assert_eq!((recovery.branch.as_str(), recovery.head.as_str()), ("", ""));
    }

    #[test]
    fn a_chats_project_is_the_one_its_index_entry_names() {
        let scene = scene("project");
        let repo = Scene::text(&scene.repo);
        let extra = Scene::text(&scene.repo.parent().unwrap().join("extra"));
        let other = Scene::text(&scene.repo.parent().unwrap().join("other"));
        let project = |id: &str, primary: &str, paths: &[&str]| -> crate::workspaces::Workspace {
            serde_json::from_value(json!({
                "id": id, "name": id, "primary_path": primary, "paths": paths,
            }))
            .unwrap()
        };
        let projects = [
            project("p-other", &other, &[]),
            project("p-mine", &repo, &[&repo, &extra, " "]),
        ];
        let chat = listed_chat("project", "p-mine");

        let known = Remembered::of(&chat, Some(&other), &projects);

        assert_eq!(known.project_paths, vec![repo.clone(), repo.clone(), extra]);
        assert_eq!(known.preferred, vec![other.clone()], "a hint, kept apart");
        assert_eq!(known.vouched(), known.project_paths[1..].to_vec());
        // A chat the index does not list has no project to speak for it.
        let unlisted = Remembered::of("recover-never-listed", Some(&other), &projects);
        assert!(unlisted.project_paths.is_empty());
        assert!(unlisted.vouched().is_empty());
        let _ = crate::chat_index::remove(&chat);
    }

    // ------------------------------------------------------- session carrying

    /// A session filed under one folder, big enough that a copy takes a
    /// moment, and the folder a chat moved to.
    fn filed_session(name: &str) -> (crate::test_dir::TestDir, PathBuf, PathBuf, Vec<u8>) {
        let scratch = crate::test_dir::TestDir::new(&format!("recover-{name}")).canonicalized();
        let old = scratch.join("projects").join("-gone-worktree");
        std::fs::create_dir_all(&old).unwrap();
        let original: Vec<u8> = (0..40_000)
            .flat_map(|line| format!("{{\"type\":\"user\",\"line\":{line}}}\n").into_bytes())
            .collect();
        let source = old.join("abc-123.jsonl");
        std::fs::write(&source, &original).unwrap();
        let new_cwd = scratch.join("primary");
        std::fs::create_dir_all(&new_cwd).unwrap();
        (scratch, source, new_cwd, original)
    }

    /// Run `carry` on 24 threads at once and hand back what each answered.
    fn at_once<T: Send>(carry: impl Fn() -> T + Sync) -> Vec<T> {
        const STARTS: usize = 24;
        let together = std::sync::Barrier::new(STARTS);
        std::thread::scope(|scope| {
            let carries: Vec<_> = (0..STARTS)
                .map(|_| {
                    scope.spawn(|| {
                        together.wait();
                        carry()
                    })
                })
                .collect();
            carries
                .into_iter()
                .map(|carry| carry.join().expect("a carry"))
                .collect()
        })
    }

    fn leftovers(folder: &Path) -> Vec<String> {
        std::fs::read_dir(folder)
            .unwrap()
            .flatten()
            .map(|entry| entry.file_name().to_string_lossy().into_owned())
            .filter(|name| name.ends_with(".carrying"))
            .collect()
    }

    #[test]
    fn twenty_four_starts_carrying_one_session_leave_both_names_whole() {
        // Review R1: the loser of the race fell back to copying the session
        // onto its own hard link, which emptied it under both names.
        let (scratch, source, new_cwd, original) = filed_session("carry-race");
        let projects = scratch.join("projects");

        let carried = at_once(|| carry_claude_session(&projects, "abc-123", &new_cwd));

        let target = projects
            .join(claude_project_folder(&new_cwd).unwrap())
            .join("abc-123.jsonl");
        for outcome in &carried {
            assert_eq!(outcome.as_ref(), Ok(&target));
        }
        assert_eq!(std::fs::read(&source).unwrap(), original, "the original");
        assert_eq!(std::fs::read(&target).unwrap(), original, "the carried");
        assert_eq!(leftovers(target.parent().unwrap()), Vec::<String>::new());
    }

    #[test]
    fn twenty_four_carries_that_must_copy_publish_one_whole_file() {
        // No link from the original can be made (another device): each carry
        // copies, one after the other, and only one copy gets the name.
        let (scratch, source, _new_cwd, original) = filed_session("carry-copy");
        let folder = scratch.join("projects").join("-primary");
        std::fs::create_dir_all(&folder).unwrap();
        let target = folder.join("abc-123.jsonl");

        for outcome in at_once(|| publish_copy(&source, &target, &carrying())) {
            assert_eq!(outcome, Ok(()));
        }

        assert_eq!(std::fs::read(&source).unwrap(), original);
        assert_eq!(std::fs::read(&target).unwrap(), original);
        assert_eq!(leftovers(&folder), Vec::<String>::new());

        // And on a filesystem with no links at all, `create_new` decides.
        let bare = folder.join("def-456.jsonl");
        let outcomes = at_once(|| {
            let turn = carrying();
            let staged = staged_copy(&source, &bare)?;
            let published = publish_exclusive(&staged, &bare, &turn);
            std::fs::remove_file(&staged).unwrap();
            published
        });
        for outcome in outcomes {
            assert_eq!(outcome, Ok(()));
        }
        assert_eq!(std::fs::read(&source).unwrap(), original);
        assert_eq!(std::fs::read(&bare).unwrap(), original);
        assert_eq!(leftovers(&folder), Vec::<String>::new());
    }

    #[test]
    fn a_carry_keeps_the_newer_file_and_never_writes_over_one_in_place() {
        let (scratch, source, new_cwd, original) = filed_session("carry-newer");
        let projects = scratch.join("projects");
        let target = projects
            .join(claude_project_folder(&new_cwd).unwrap())
            .join("abc-123.jsonl");
        std::fs::create_dir_all(target.parent().unwrap()).unwrap();
        let stamp = |path: &Path, seconds: u64| {
            std::fs::OpenOptions::new()
                .append(true)
                .open(path)
                .unwrap()
                .set_modified(std::time::UNIX_EPOCH + std::time::Duration::from_secs(seconds))
                .unwrap();
        };

        // A separate copy that was written to since: it stays.
        std::fs::write(&target, b"{\"type\":\"user\",\"later\":true}\n").unwrap();
        stamp(&source, 1_000);
        stamp(&target, 2_000);
        assert_eq!(
            carry_claude_session(&projects, "abc-123", &new_cwd),
            Ok(target.clone())
        );
        assert_eq!(
            std::fs::read(&target).unwrap(),
            b"{\"type\":\"user\",\"later\":true}\n"
        );
        assert_eq!(std::fs::read(&source).unwrap(), original);

        // An older copy gives way to the conversation as it now stands, in
        // one rename: somebody still reading the old file keeps the old file.
        stamp(&target, 500);
        // Not on Windows, where an open file's name cannot be given away.
        let reading = (!cfg!(windows)).then(|| std::fs::File::open(&target).unwrap());
        assert_eq!(
            carry_claude_session(&projects, "abc-123", &new_cwd),
            Ok(target.clone())
        );
        assert_eq!(std::fs::read(&target).unwrap(), original);
        assert_eq!(std::fs::read(&source).unwrap(), original);
        if let Some(mut reading) = reading {
            let mut old = Vec::new();
            std::io::Read::read_to_end(&mut reading, &mut old).unwrap();
            assert_eq!(old, b"{\"type\":\"user\",\"later\":true}\n");
        }
        assert_eq!(leftovers(target.parent().unwrap()), Vec::<String>::new());
    }

    /// A session that stops half way, says so, and goes on when told to.
    struct Paused<'a> {
        bytes: &'a [u8],
        at: usize,
        half: Option<std::sync::mpsc::Sender<()>>,
        go: std::sync::mpsc::Receiver<()>,
    }

    impl std::io::Read for Paused<'_> {
        fn read(&mut self, buf: &mut [u8]) -> std::io::Result<usize> {
            let middle = self.bytes.len() / 2;
            if self.at == middle {
                if let Some(half) = self.half.take() {
                    let _ = half.send(());
                    // Not for ever, so a failed assertion ends the test.
                    let _ = self.go.recv_timeout(std::time::Duration::from_secs(30));
                }
            }
            let until = if self.at < middle {
                middle
            } else {
                self.bytes.len()
            };
            let count = buf.len().min(until - self.at);
            buf[..count].copy_from_slice(&self.bytes[self.at..self.at + count]);
            self.at += count;
            Ok(count)
        }
    }

    /// A session that cannot be read to its end.
    struct Cut(bool);

    impl std::io::Read for Cut {
        fn read(&mut self, buf: &mut [u8]) -> std::io::Result<usize> {
            if std::mem::replace(&mut self.0, true) {
                return Err(std::io::Error::other("the disk went away"));
            }
            buf[..1].copy_from_slice(b"{");
            Ok(1)
        }
    }

    #[test]
    fn a_second_carry_waits_until_a_last_resort_copy_is_whole() {
        // Review M1: with no link to publish by, the name is made first and
        // written after. A second carry used to find the name, answer Ok at
        // once, and let a start read half a conversation.
        use std::sync::mpsc::channel;
        use std::time::Duration;
        let (scratch, source, new_cwd, original) = filed_session("carry-paused");
        let projects = scratch.join("projects");
        let target = projects
            .join(claude_project_folder(&new_cwd).unwrap())
            .join("abc-123.jsonl");
        std::fs::create_dir_all(target.parent().unwrap()).unwrap();
        let (half, at_half) = channel();
        let (go, told) = channel();
        let (answered, answer) = channel();
        let mut from = Paused {
            bytes: &original,
            at: 0,
            half: Some(half),
            go: told,
        };

        std::thread::scope(|scope| {
            let first = scope.spawn(|| write_new(&mut from, &target, &carrying()));
            at_half
                .recv_timeout(Duration::from_secs(10))
                .expect("the first copy is under way");
            // What the last resort does not promise: the name is there.
            let seen = std::fs::read(&target).unwrap();
            assert!(seen.len() < original.len(), "{} bytes", seen.len());
            // What it does: nobody else is carrying.
            assert!(matches!(
                CARRY.try_lock(),
                Err(std::sync::TryLockError::WouldBlock)
            ));
            let second = scope.spawn(|| {
                let carried = carry_claude_session(&projects, "abc-123", &new_cwd);
                let _ = answered.send(());
                carried
            });
            assert!(
                answer.recv_timeout(Duration::from_millis(300)).is_err(),
                "no answer while the file is partial"
            );

            go.send(()).unwrap();
            assert_eq!(first.join().expect("the first carry"), Ok(()));
            assert_eq!(second.join().expect("the second carry"), Ok(target.clone()));
        });

        assert_eq!(std::fs::read(&target).unwrap(), original, "the carried");
        assert_eq!(std::fs::read(&source).unwrap(), original, "the original");

        // A copy that cannot be finished takes its file away again before the
        // next carry gets a turn, so that one finds no name and carries.
        let cut = target.with_file_name("def-456.jsonl");
        let failed = write_new(&mut Cut(false), &cut, &carrying()).unwrap_err();
        assert!(failed.contains("cannot be copied"), "{failed}");
        assert!(!cut.exists(), "nothing half-written is left under the name");
        // And a name somebody else made first is never written into.
        std::fs::write(&cut, b"theirs").unwrap();
        assert_eq!(write_new(&mut &original[..], &cut, &carrying()), Ok(()));
        assert_eq!(std::fs::read(&cut).unwrap(), b"theirs");
    }
}
