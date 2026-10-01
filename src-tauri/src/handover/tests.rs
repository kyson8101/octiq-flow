use std::process::Command;
use std::sync::Mutex as StdMutex;

use super::*;
use crate::git_ops::PreparedWorkspace;
use crate::team::TeamDraft;

/// A throwaway folder for one test.
fn scratch(tag: &str) -> PathBuf {
    let dir = std::env::temp_dir().join(format!("octiq-handover-{tag}-{}", uuid::Uuid::new_v4()));
    fs::create_dir_all(&dir).unwrap();
    crate::paths::canonicalize(&dir).unwrap()
}

fn git(dir: &Path, args: &[&str]) {
    let out = Command::new("git")
        .arg("-C")
        .arg(dir)
        .args([
            "-c",
            "user.name=t",
            "-c",
            "user.email=t@t",
            "-c",
            "commit.gpgsign=false",
        ])
        .args(args)
        .output()
        .unwrap();
    assert!(
        out.status.success(),
        "git {args:?}: {}",
        String::from_utf8_lossy(&out.stderr)
    );
}

/// A repository with one commit on `main`.
fn repo(root: &Path, name: &str) -> PathBuf {
    let dir = root.join(name);
    fs::create_dir_all(&dir).unwrap();
    git(&dir, &["init", "-q", "-b", "main"]);
    git(&dir, &["config", "core.autocrlf", "false"]);
    fs::write(dir.join("README"), "x").unwrap();
    git(&dir, &["add", "README"]);
    git(&dir, &["commit", "-q", "-m", "init"]);
    dir
}

fn project(id: &str, name: &str, paths: &[&Path]) -> Workspace {
    let paths: Vec<String> = paths
        .iter()
        .map(|p| p.to_string_lossy().into_owned())
        .collect();
    serde_json::from_value(serde_json::json!({
        "id": id, "name": name,
        "primary_path": paths.first().cloned().unwrap_or_default(),
        "paths": paths.iter().skip(1).collect::<Vec<_>>(),
        "env": { "PROJECT_VAR": "1" },
    }))
    .unwrap()
}

fn register(
    team: &Path,
    name: &str,
    project: Option<&str>,
    model: &str,
    access: Access,
) -> TeamAgent {
    team::save(
        team,
        TeamDraft {
            id: None,
            name: name.into(),
            role: "builds things".into(),
            agent: ChatAgent::Claude,
            model: model.into(),
            effort: Some("high".into()),
            access: Some(access),
            project_id: project.map(Into::into),
            reports_to: None,
            avatar: None,
            team_id: None,
        },
    )
    .unwrap()
}

struct World {
    root: PathBuf,
    store: PathBuf,
    team: PathBuf,
    app: PathBuf,
    other: PathBuf,
    projects: Vec<Workspace>,
    global: TeamAgent,
    scoped: TeamAgent,
}

fn world() -> World {
    let root = scratch("world");
    let app = repo(&root, "app");
    let other = repo(&root, "other");
    let team = root.join("team.json");
    let projects = vec![
        project("p-app", "App", &[&app]),
        project("p-other", "Other", &[&other]),
    ];
    let global = register(&team, "Potato", None, "opus", Access::Auto);
    let scoped = register(&team, "Mango", Some("p-app"), "sonnet", Access::Edits);
    World {
        store: root.join("handovers.json"),
        root,
        team,
        app,
        other,
        projects,
        global,
        scoped,
    }
}

fn source(chat: &str) -> Source {
    Source {
        chat_key: chat.into(),
        title: "Fix the login bug".into(),
        project_id: Some("p-app".into()),
        lead: None,
        origin: crate::question_store::test_origin(chat),
        worker: false,
        cwd: None,
        coordinating: None,
    }
}

fn ask(recipient: &str, request_id: &str) -> Ask {
    Ask {
        recipient: recipient.into(),
        project: None,
        repository: None,
        request_id: request_id.into(),
        brief: Brief {
            objective: "Finish the login fix".into(),
            done_so_far: "Found the bug".into(),
            remaining: "Write the test".into(),
            authorized: vec!["commit on the task branch".into()],
            not_authorized: vec!["push".into(), "deploy".into()],
            ..Brief::default()
        },
    }
}

fn team_of(w: &World) -> Vec<TeamAgent> {
    team::list(&w.team, None, true).unwrap()
}

#[derive(Default)]
struct FakeHost {
    projects: Vec<Workspace>,
    team: PathBuf,
    root: PathBuf,
    starts: StdMutex<Vec<Start>>,
    saved: StdMutex<Vec<crate::chat_index::ChatMeta>>,
    worktrees: StdMutex<usize>,
    fail_start: StdMutex<bool>,
    /// Checkouts another writer holds.
    taken: StdMutex<Vec<String>>,
}

impl FakeHost {
    fn of(w: &World) -> Self {
        Self {
            projects: w.projects.clone(),
            team: w.team.clone(),
            root: w.root.clone(),
            ..Self::default()
        }
    }
}

impl Host for FakeHost {
    fn projects(&self) -> Result<Vec<Workspace>, String> {
        Ok(self.projects.clone())
    }
    fn team_path(&self) -> PathBuf {
        self.team.clone()
    }
    fn new_worktree(
        &self,
        _repo: &str,
        branch: &str,
        _prompt: &str,
        chat_id: &str,
    ) -> Result<PreparedWorkspace, String> {
        *self.worktrees.lock().unwrap() += 1;
        let cwd = self.root.join("worktrees").join(chat_id);
        fs::create_dir_all(&cwd).unwrap();
        Ok(PreparedWorkspace {
            cwd: cwd.to_string_lossy().into_owned(),
            branch: format!(
                "handover-from-{}",
                if branch.is_empty() { "main" } else { branch }
            ),
            is_repo: true,
            is_worktree: true,
        })
    }
    fn save_index(&self, meta: crate::chat_index::ChatMeta) -> Result<(), String> {
        self.saved.lock().unwrap().push(meta);
        Ok(())
    }
    fn start(&self, start: Start) -> Result<(), String> {
        if *self.fail_start.lock().unwrap() {
            return Err("CLI unavailable".into());
        }
        self.starts.lock().unwrap().push(start);
        Ok(())
    }
    fn checkout_free(&self, path: &str, _except: &[&str]) -> Result<(), String> {
        let path = crate::paths::canonicalize(path).unwrap();
        if self
            .taken
            .lock()
            .unwrap()
            .iter()
            .any(|taken| crate::paths::canonicalize(taken).unwrap() == path)
        {
            return Err(format!("{} is held by another writer", path.display()));
        }
        Ok(())
    }
    fn base_url(&self) -> Option<String> {
        Some("http://127.0.0.1:1421".into())
    }
}

// ---- validation: the host decides, not the model --------------------------

#[test]
fn an_unknown_recipient_is_refused_by_name() {
    let w = world();
    let error = request(
        &w.store,
        &FakeHost::of(&w),
        source("chat:s1"),
        ask("Nobody", "r1"),
    )
    .unwrap_err();
    assert!(
        error.contains("No registered agent called Nobody"),
        "{error}"
    );
    assert!(
        error.contains("Potato") && error.contains("Mango"),
        "lists who exists: {error}"
    );
    assert!(list(&w.store).unwrap().is_empty(), "nothing is recorded");
}

#[test]
fn a_project_agent_is_refused_outside_its_project() {
    let w = world();
    let mut asked = ask("Mango", "r1");
    asked.project = Some("Other".into());
    let error = request(&w.store, &FakeHost::of(&w), source("chat:s1"), asked).unwrap_err();
    assert!(error.contains("Mango works only in App"), "{error}");
}

#[test]
fn a_global_recipient_must_be_told_where() {
    let w = world();
    let error = request(
        &w.store,
        &FakeHost::of(&w),
        source("chat:s1"),
        ask("Potato", "r1"),
    )
    .unwrap_err();
    assert!(error.contains("pass `project`"), "{error}");
}

#[test]
fn an_unregistered_project_or_repository_is_refused_and_nothing_falls_back() {
    let w = world();
    let mut asked = ask("Potato", "r1");
    asked.project = Some("Nowhere".into());
    let error = request(&w.store, &FakeHost::of(&w), source("chat:s1"), asked).unwrap_err();
    assert!(
        error.contains("No registered project called Nowhere"),
        "{error}"
    );

    let mut asked = ask("Potato", "r2");
    asked.project = Some("App".into());
    asked.repository = Some(w.other.to_string_lossy().into_owned());
    let error = request(&w.store, &FakeHost::of(&w), source("chat:s1"), asked).unwrap_err();
    assert!(
        error.contains("is not a repository registered on project App"),
        "{error}"
    );
    assert!(list(&w.store).unwrap().is_empty());
}

#[test]
fn a_worker_on_a_leased_attempt_is_refused() {
    let w = world();
    let mut worker = source("chat:orch-abc");
    worker.worker = true;
    let error = request(&w.store, &FakeHost::of(&w), worker, ask("Mango", "r1")).unwrap_err();
    assert!(error.contains("orchestration_worker_report"), "{error}");
    assert!(list(&w.store).unwrap().is_empty());
}

#[test]
fn a_named_checkout_of_another_repository_is_refused_never_adopted() {
    let w = world();
    let mut asked = ask("Mango", "r1");
    asked.brief.state.worktree = w.other.to_string_lossy().into_owned();
    let error = request(&w.store, &FakeHost::of(&w), source("chat:s1"), asked).unwrap_err();
    assert!(error.contains("is not a worktree of App"), "{error}");
}

// ---- the record --------------------------------------------------------------

#[test]
fn a_request_is_pending_with_the_recipients_registered_settings() {
    let w = world();
    let record = request(
        &w.store,
        &FakeHost::of(&w),
        source("chat:s1"),
        ask("Mango", "r1"),
    )
    .unwrap();
    assert_eq!(record.status, Status::Pending);
    assert_eq!(record.to.agent_id.as_deref(), Some(w.scoped.id.as_str()));
    assert_eq!(record.settings.model.as_deref(), Some("sonnet"));
    assert_eq!(record.settings.access, Access::Edits);
    assert_eq!(record.settings.effort.as_deref(), Some("high"));
    assert_eq!(record.destination.project_id, "p-app");
    assert_eq!(record.source_project, "App");
    assert_eq!(record.workspace.mode, "worktree");
    // The browser view never carries the asking chat's private settings.
    let public = serde_json::to_string(&record.public()).unwrap();
    assert!(
        !public.contains("origin") && !public.contains("session-1"),
        "{public}"
    );
}

#[test]
fn the_same_request_id_answers_with_the_same_handover() {
    let w = world();
    let first = request(
        &w.store,
        &FakeHost::of(&w),
        source("chat:s1"),
        ask("Mango", "r1"),
    )
    .unwrap();
    let again = request(
        &w.store,
        &FakeHost::of(&w),
        source("chat:s1"),
        ask("Mango", "r1"),
    )
    .unwrap();
    assert_eq!(first.id, again.id);
    assert_eq!(list(&w.store).unwrap().len(), 1);

    // The same id for something else is refused, not answered with the first.
    let mut different = ask("Mango", "r1");
    different.brief.objective = "Something else".into();
    let error = request(&w.store, &FakeHost::of(&w), source("chat:s1"), different).unwrap_err();
    assert!(
        error.contains("already used for a different handover"),
        "{error}"
    );

    // And one chat has one handover waiting at a time.
    let error = request(
        &w.store,
        &FakeHost::of(&w),
        source("chat:s1"),
        ask("Mango", "r2"),
    )
    .unwrap_err();
    assert!(error.contains("still waiting for the person"), "{error}");
}

// ---- confirm and decline ----------------------------------------------------

#[test]
fn confirm_starts_exactly_one_chat_on_the_recipients_registered_settings() {
    let w = world();
    let record = request(
        &w.store,
        &FakeHost::of(&w),
        source("chat:s1"),
        ask("Mango", "r1"),
    )
    .unwrap();
    // The registry changes after the card was drawn: confirm uses what is
    // registered NOW, never what the card (or the caller) said.
    let current = team::save(
        &w.team,
        TeamDraft {
            id: Some(w.scoped.id.clone()),
            name: "Mango".into(),
            role: "builds things".into(),
            agent: ChatAgent::Claude,
            model: "haiku".into(),
            effort: Some("low".into()),
            access: Some(Access::Read),
            project_id: Some("p-app".into()),
            reports_to: None,
            avatar: None,
            team_id: None,
        },
    )
    .unwrap();
    let host = FakeHost::of(&w);
    let confirmed = confirm(&w.store, &record.id, &host).unwrap();
    assert_eq!(confirmed.status, Status::Confirmed);
    let starts = host.starts.lock().unwrap().clone();
    assert_eq!(starts.len(), 1);
    let start = &starts[0];
    assert_eq!(start.agent, current.agent);
    assert_eq!(start.model.as_deref(), Some("haiku"));
    assert_eq!(start.access, Access::Read);
    assert_eq!(start.effort.as_deref(), Some("low"));
    assert_eq!(Some(start.key.clone()), confirmed.target_chat_key);
    assert_eq!(start.env.get("PROJECT_VAR").map(String::as_str), Some("1"));
    // The first message: the brief, the link back, and the lead brief after
    // the mark so the recipient can still pass the work on.
    assert!(
        start.prompt.contains("## Objective\nFinish the login fix"),
        "{}",
        start.prompt
    );
    assert!(start.prompt.contains("chat ID s1"), "{}", start.prompt);
    assert!(
        start.prompt.contains("http://127.0.0.1:1421/#/p/app/c/s1"),
        "{}",
        start.prompt
    );
    assert!(start.prompt.contains(team::BRIEF_MARK));
    assert!(
        start.prompt.contains("OctiqFlow did not grant these"),
        "{}",
        start.prompt
    );
    let lead = team::lead_for_chat(&w.team, &start.key).unwrap().unwrap();
    assert_eq!(lead.lead_id, w.scoped.id);
    assert_eq!(host.saved.lock().unwrap().len(), 1);
    assert_eq!(*host.worktrees.lock().unwrap(), 1);

    // A second confirm (another tab, a double click) starts nothing.
    let again = confirm(&w.store, &record.id, &host).unwrap();
    assert_eq!(again.target_chat_key, confirmed.target_chat_key);
    assert_eq!(host.starts.lock().unwrap().len(), 1);
    assert_eq!(*host.worktrees.lock().unwrap(), 1);
}

#[test]
fn a_failed_start_keeps_the_chat_id_and_the_worktree_for_the_retry() {
    let w = world();
    let record = request(
        &w.store,
        &FakeHost::of(&w),
        source("chat:s1"),
        ask("Mango", "r1"),
    )
    .unwrap();
    let host = FakeHost::of(&w);
    *host.fail_start.lock().unwrap() = true;
    let error = confirm(&w.store, &record.id, &host).unwrap_err();
    assert!(error.contains("CLI unavailable"));
    let failed = get(&w.store, &record.id).unwrap();
    assert_eq!(failed.status, Status::Pending);
    assert_eq!(failed.error.as_deref(), Some("CLI unavailable"));
    let key = failed.target_chat_key.clone().expect("the chat id is kept");

    *host.fail_start.lock().unwrap() = false;
    let confirmed = confirm(&w.store, &record.id, &host).unwrap();
    assert_eq!(confirmed.target_chat_key.as_deref(), Some(key.as_str()));
    assert_eq!(host.starts.lock().unwrap().len(), 1);
    assert_eq!(*host.worktrees.lock().unwrap(), 1, "no second worktree");
    assert_eq!(confirmed.error, None);
}

#[test]
fn decline_creates_nothing_and_cannot_be_confirmed_afterwards() {
    let w = world();
    let record = request(
        &w.store,
        &FakeHost::of(&w),
        source("chat:s1"),
        ask("Mango", "r1"),
    )
    .unwrap();
    let declined = decline(&w.store, &record.id).unwrap();
    assert_eq!(declined.status, Status::Declined);
    assert_eq!(declined.target_chat_key, None);
    let host = FakeHost::of(&w);
    assert!(confirm(&w.store, &record.id, &host).is_err());
    assert!(host.starts.lock().unwrap().is_empty());
    assert!(host.saved.lock().unwrap().is_empty());
    assert!(outcome_text(&declined, None).contains("declined"));
    // A declined handover frees the chat to ask again.
    let mut again = ask("Mango", "r2");
    again.brief.objective = "Try again".into();
    request(&w.store, &FakeHost::of(&w), source("chat:s1"), again).unwrap();
}

#[test]
fn a_removed_recipient_is_refused_at_confirm() {
    let w = world();
    let record = request(
        &w.store,
        &FakeHost::of(&w),
        source("chat:s1"),
        ask("Mango", "r1"),
    )
    .unwrap();
    team::delete(&w.team, &w.scoped.id).unwrap();
    let host = FakeHost::of(&w);
    let error = confirm(&w.store, &record.id, &host).unwrap_err();
    assert!(error.contains("no longer a registered agent"), "{error}");
    assert!(host.starts.lock().unwrap().is_empty());
}

#[test]
fn self_without_a_registered_agent_copies_the_chats_own_settings() {
    let w = world();
    let record = request(
        &w.store,
        &FakeHost::of(&w),
        source("chat:s1"),
        ask("self", "r1"),
    )
    .unwrap();
    // test_origin: codex, gpt-test, manual, high.
    assert_eq!(record.to.agent_id, None);
    assert_eq!(record.settings.agent, ChatAgent::Codex);
    assert_eq!(record.settings.model.as_deref(), Some("gpt-test"));
    assert_eq!(record.settings.access, Access::Manual);
    assert_eq!(
        record.destination.project_id, "p-app",
        "the source chat's project"
    );
    let host = FakeHost::of(&w);
    confirm(&w.store, &record.id, &host).unwrap();
    let start = host.starts.lock().unwrap()[0].clone();
    assert_eq!(start.agent, ChatAgent::Codex);
    assert!(
        !start.prompt.contains(team::BRIEF_MARK),
        "no lead brief for an unregistered chat"
    );
}

#[test]
fn self_in_a_lead_chat_is_that_registered_agent() {
    let w = world();
    let mut src = source("chat:s1");
    src.lead = Some(LeadRecord {
        chat_key: "chat:s1".into(),
        lead_id: w.global.id.clone(),
        lead_name: "Potato".into(),
        project_id: "p-app".into(),
        cross_project: false,
        created_at: 0,
    });
    let record = request(&w.store, &FakeHost::of(&w), src, ask("self", "r1")).unwrap();
    assert_eq!(record.to.agent_id.as_deref(), Some(w.global.id.as_str()));
    assert_eq!(record.from.name, "Potato");
    assert_eq!(record.settings.model.as_deref(), Some("opus"));
}

// ---- workspace ----------------------------------------------------------------

#[test]
fn a_named_worktree_of_the_same_repository_is_continued_in_place() {
    let w = world();
    let tree = w.root.join("app-feature");
    git(
        &w.app,
        &[
            "worktree",
            "add",
            "-q",
            "-b",
            "feature",
            &tree.to_string_lossy(),
        ],
    );
    let mut asked = ask("Mango", "r1");
    asked.brief.state.worktree = tree.to_string_lossy().into_owned();
    asked.brief.state.branch = "feature".into();
    let record = request(&w.store, &FakeHost::of(&w), source("chat:s1"), asked).unwrap();
    assert_eq!(record.workspace.mode, "continue");
    assert_eq!(record.workspace.branch, "feature");
    let host = FakeHost::of(&w);
    let confirmed = confirm(&w.store, &record.id, &host).unwrap();
    assert_eq!(*host.worktrees.lock().unwrap(), 0, "no fresh checkout");
    let start = host.starts.lock().unwrap()[0].clone();
    assert_eq!(
        crate::paths::canonicalize(&start.cwd).unwrap(),
        crate::paths::canonicalize(&tree).unwrap()
    );
    assert!(outcome_text(&confirmed, None).contains("Stop now"));

    // Named by branch alone, the worktree that has it is found.
    let mut by_branch = ask("Mango", "r2");
    by_branch.brief.state.branch = "feature".into();
    by_branch.brief.objective = "Second".into();
    let record = request(&w.store, &FakeHost::of(&w), source("chat:s2"), by_branch).unwrap();
    assert_eq!(record.workspace.mode, "continue");
}

#[test]
fn a_branch_no_worktree_has_is_refused_rather_than_replaced_with_a_fresh_checkout() {
    let w = world();
    git(&w.app, &["branch", "parked"]);
    for branch in ["no-such-branch", "parked"] {
        let mut asked = ask("Mango", "r1");
        asked.brief.state.branch = branch.into();
        let error = request(&w.store, &FakeHost::of(&w), source("chat:s1"), asked).unwrap_err();
        assert!(error.contains("No worktree of"), "{branch}: {error}");
    }
    assert!(list(&w.store).unwrap().is_empty());
}

#[test]
fn with_nothing_named_the_source_chats_own_checkout_is_continued_as_git_sees_it() {
    let w = world();
    let tree = w.root.join("app-work");
    git(
        &w.app,
        &[
            "worktree",
            "add",
            "-q",
            "-b",
            "work",
            &tree.to_string_lossy(),
        ],
    );
    fs::create_dir_all(tree.join("src")).unwrap();
    fs::write(tree.join("src/wip.rs"), "half done").unwrap();
    let mut src = source("chat:s1");
    // The host-recorded folder, somewhere inside the checkout.
    src.cwd = Some(tree.join("src").to_string_lossy().into_owned());
    let record = request(&w.store, &FakeHost::of(&w), src, ask("Mango", "r1")).unwrap();
    assert_eq!(record.workspace.mode, "continue");
    assert_eq!(record.workspace.chosen, "source");
    assert_eq!(record.workspace.branch, "work");
    assert_eq!(
        record.workspace.uncommitted,
        Some(true),
        "from git, not the brief"
    );
    assert!(!record.workspace.head.is_empty());
    assert_eq!(
        crate::paths::canonicalize(&record.workspace.path).unwrap(),
        crate::paths::canonicalize(&tree).unwrap()
    );
}

#[test]
fn a_source_with_no_checkout_in_the_destination_gets_a_new_worktree() {
    let w = world();
    let mut src = source("chat:s1");
    src.cwd = Some(w.other.to_string_lossy().into_owned());
    let record = request(&w.store, &FakeHost::of(&w), src, ask("Mango", "r1")).unwrap();
    assert_eq!(record.workspace.mode, "worktree");
    assert_eq!(record.workspace.chosen, "new");
    assert_eq!(
        record.workspace.branch, "main",
        "off the repository's current branch"
    );
}

#[test]
fn a_checkout_another_writer_holds_is_refused_at_request_and_at_confirm() {
    let w = world();
    let mut src = source("chat:s1");
    src.cwd = Some(w.app.to_string_lossy().into_owned());
    let host = FakeHost::of(&w);
    host.taken
        .lock()
        .unwrap()
        .push(w.app.to_string_lossy().into_owned());
    let error = request(&w.store, &host, src, ask("Mango", "r1")).unwrap_err();
    assert!(error.contains("held by another writer"), "{error}");

    // Free when asked, taken by the time the person confirms.
    let mut src = source("chat:s1");
    src.cwd = Some(w.app.to_string_lossy().into_owned());
    let record = request(&w.store, &FakeHost::of(&w), src, ask("Mango", "r2")).unwrap();
    let error = confirm(&w.store, &record.id, &host).unwrap_err();
    assert!(error.contains("held by another writer"), "{error}");
    assert!(host.starts.lock().unwrap().is_empty());
    assert_eq!(get(&w.store, &record.id).unwrap().status, Status::Pending);
}

#[test]
fn a_chat_coordinating_a_live_run_cannot_hand_over() {
    let w = world();
    let mut src = source("chat:s1");
    src.coordinating = Some("Ship the login fix".into());
    let error = request(&w.store, &FakeHost::of(&w), src, ask("Mango", "r1")).unwrap_err();
    assert!(
        error.contains("coordinates a live orchestration run"),
        "{error}"
    );
    assert!(list(&w.store).unwrap().is_empty());
}

#[test]
fn a_confirm_racing_a_decline_has_exactly_one_winner() {
    for _ in 0..8 {
        let w = world();
        let record = request(
            &w.store,
            &FakeHost::of(&w),
            source("chat:s1"),
            ask("Mango", "r1"),
        )
        .unwrap();
        let host = std::sync::Arc::new(FakeHost::of(&w));
        let barrier = std::sync::Arc::new(std::sync::Barrier::new(2));
        let (store, id, h, b) = (
            w.store.clone(),
            record.id.clone(),
            host.clone(),
            barrier.clone(),
        );
        let confirming = std::thread::spawn(move || {
            b.wait();
            confirm(&store, &id, h.as_ref()).is_ok()
        });
        let (store, id) = (w.store.clone(), record.id.clone());
        let declining = std::thread::spawn(move || {
            barrier.wait();
            decline(&store, &id).is_ok()
        });
        let confirmed = confirming.join().unwrap();
        let declined = declining.join().unwrap();
        assert!(
            confirmed ^ declined,
            "exactly one wins: confirmed {confirmed}, declined {declined}"
        );
        let status = get(&w.store, &record.id).unwrap().status;
        assert_eq!(status == Status::Confirmed, confirmed);
        assert_eq!(host.starts.lock().unwrap().len(), usize::from(confirmed));
    }
}

#[test]
fn a_pending_card_restored_after_a_restart_is_confirmable_exactly_once() {
    let w = world();
    let record = request(
        &w.store,
        &FakeHost::of(&w),
        source("chat:s1"),
        ask("Mango", "r1"),
    )
    .unwrap();
    // The restart: no waiter, no memory, only the file.
    WAITERS.lock().unwrap().clear();
    let restored = list(&w.store).unwrap();
    assert_eq!(restored[0].status, Status::Pending);
    let host = FakeHost::of(&w);
    confirm(&w.store, &record.id, &host).unwrap();
    confirm(&w.store, &record.id, &host).unwrap();
    assert_eq!(host.starts.lock().unwrap().len(), 1);
    assert!(
        decline(&w.store, &record.id).is_err(),
        "a confirmed handover stays confirmed"
    );
}

// ---- durability and the agent's answer ---------------------------------------

#[test]
fn the_record_survives_a_restart_and_a_late_decision_goes_by_continuation() {
    let w = world();
    let record = request(
        &w.store,
        &FakeHost::of(&w),
        source("chat:s1"),
        ask("Mango", "r1"),
    )
    .unwrap();
    // A restart is a new process reading the same file: nothing is cached.
    let bytes = fs::read(&w.store).unwrap();
    fs::write(&w.store, &bytes).unwrap();
    let reloaded = list(&w.store).unwrap();
    assert_eq!(reloaded.len(), 1);
    assert_eq!(reloaded[0].status, Status::Pending);

    let host = FakeHost::of(&w);
    confirm(&w.store, &record.id, &host).unwrap();
    // Nobody is waiting (the tool timed out, or the server restarted): the
    // decision is handed back for a continuation turn, once.
    let pending = hand_off_notice(&w.store, &record.id)
        .unwrap()
        .expect("a continuation is owed");
    assert!(pending.origin.is_some());
    let (text, turn) = continuation(&pending, None);
    assert!(text.contains("confirmed handover"), "{text}");
    assert_eq!(turn, format!("octiq-handover-{}", record.id));
    noticed(&w.store, &record.id, Ok(())).unwrap();
    assert!(
        hand_off_notice(&w.store, &record.id).unwrap().is_none(),
        "told once"
    );
    let after = list(&w.store).unwrap();
    assert_eq!(after[0].status, Status::Confirmed);
    assert_eq!(after[0].notice, Notice::Delivered);
    assert!(after[0].target_chat_key.is_some());
}

#[tokio::test]
async fn a_waiting_tool_gets_the_decision_and_nothing_is_sent_twice() {
    let w = world();
    let record = request(
        &w.store,
        &FakeHost::of(&w),
        source("chat:s1"),
        ask("Mango", "r1"),
    )
    .unwrap();
    let waiting = tokio::spawn(wait(
        w.store.clone(),
        record.id.clone(),
        std::time::Duration::from_secs(10),
        None,
    ));
    // Let the tool register before the decision.
    for _ in 0..100 {
        if WAITERS.lock().unwrap().contains_key(&record.id) {
            break;
        }
        tokio::time::sleep(std::time::Duration::from_millis(10)).await;
    }
    decline(&w.store, &record.id).unwrap();
    assert!(
        hand_off_notice(&w.store, &record.id).unwrap().is_none(),
        "the tool has it"
    );
    let text = waiting.await.unwrap().unwrap();
    assert!(text.contains("declined"), "{text}");
    assert_eq!(get(&w.store, &record.id).unwrap().notice, Notice::Tool);
}

#[tokio::test]
async fn a_tool_that_times_out_says_pending_and_leaves_the_decision_to_a_continuation() {
    let w = world();
    let record = request(
        &w.store,
        &FakeHost::of(&w),
        source("chat:s1"),
        ask("Mango", "r1"),
    )
    .unwrap();
    let text = wait(
        w.store.clone(),
        record.id.clone(),
        std::time::Duration::from_millis(20),
        None,
    )
    .await
    .unwrap();
    assert!(text.contains("End this turn now"), "{text}");
    decline(&w.store, &record.id).unwrap();
    assert!(hand_off_notice(&w.store, &record.id).unwrap().is_some());
}
