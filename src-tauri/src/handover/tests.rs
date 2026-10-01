use std::process::Command;
use std::sync::Mutex as StdMutex;

use super::*;
use crate::git_ops::PreparedWorkspace;
use crate::team::TeamDraft;

/// A throwaway folder for one test.
pub(crate) fn scratch(tag: &str) -> PathBuf {
    let dir = std::env::temp_dir().join(format!("octiq-handover-{tag}-{}", uuid::Uuid::new_v4()));
    fs::create_dir_all(&dir).unwrap();
    crate::paths::canonicalize(&dir).unwrap()
}

pub(crate) fn git(dir: &Path, args: &[&str]) {
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
pub(crate) fn repo(root: &Path, name: &str) -> PathBuf {
    let dir = root.join(name);
    fs::create_dir_all(&dir).unwrap();
    git(&dir, &["init", "-q", "-b", "main"]);
    git(&dir, &["config", "core.autocrlf", "false"]);
    fs::write(dir.join("README"), "x").unwrap();
    git(&dir, &["add", "README"]);
    git(&dir, &["commit", "-q", "-m", "init"]);
    dir
}

pub(crate) fn project(id: &str, name: &str, paths: &[&Path]) -> Workspace {
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

pub(crate) fn register(
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
pub(crate) struct FakeHost {
    pub(crate) projects: Vec<Workspace>,
    pub(crate) team: PathBuf,
    pub(crate) root: PathBuf,
    pub(crate) starts: StdMutex<Vec<Start>>,
    pub(crate) saved: StdMutex<Vec<crate::chat_index::ChatMeta>>,
    pub(crate) worktrees: StdMutex<usize>,
    pub(crate) fail_start: StdMutex<bool>,
    /// Checkouts another writer holds.
    pub(crate) taken: StdMutex<Vec<String>>,
    /// Chats with a turn in flight.
    pub(crate) busy: StdMutex<Vec<String>>,
    /// Chats with a running process.
    pub(crate) live: StdMutex<Vec<String>>,
    /// Decisions handed to asking chats as continuations: (chat, text).
    pub(crate) told: StdMutex<Vec<(String, String)>>,
    /// The handover store to break as the next start returns, the way a full
    /// disk would: the chat is started and its record cannot be saved.
    pub(crate) break_store: StdMutex<Option<PathBuf>>,
    /// Provider sessions of running chats, by chat key.
    pub(crate) sessions: StdMutex<Vec<(String, String)>>,
    /// Every answering turn run, and what each answers.
    pub(crate) answered: StdMutex<Vec<back::AnswerTurn>>,
    pub(crate) answer_with: StdMutex<Option<Result<String, String>>>,
}

/// Whether a handover call is being held open on `id`.
pub(crate) fn is_waiting(id: &str) -> bool {
    WAITERS.lock().unwrap().contains_key(id)
}

/// The store `FakeHost::break_store` broke, put back as it was.
pub(crate) fn mend_store(store: &Path) {
    fs::remove_dir(store).unwrap();
    fs::rename(store.with_extension("json.saved"), store).unwrap();
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
        if let Some(store) = self.break_store.lock().unwrap().take() {
            fs::rename(&store, store.with_extension("json.saved")).unwrap();
            fs::create_dir(&store).unwrap();
        }
        Ok(())
    }
    fn started(&self, key: &str, turn_id: &str) -> bool {
        self.starts
            .lock()
            .unwrap()
            .iter()
            .any(|start| start.key == key && start.turn_id == turn_id)
    }
    fn chat_live(&self, key: &str) -> bool {
        self.live.lock().unwrap().iter().any(|live| live == key)
    }
    fn turn_in_flight(&self, chat_key: &str) -> bool {
        self.busy.lock().unwrap().iter().any(|key| key == chat_key)
    }
    fn tell_source(
        &self,
        origin: &QuestionOrigin,
        text: String,
        _turn_id: String,
    ) -> Result<(), String> {
        self.told
            .lock()
            .unwrap()
            .push((origin.chat_key.clone(), text));
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
    fn session_of(&self, chat_key: &str) -> Option<String> {
        self.sessions
            .lock()
            .unwrap()
            .iter()
            .find(|(key, _)| key == chat_key)
            .map(|(_, id)| id.clone())
    }
    fn answer(
        &self,
        turn: &back::AnswerTurn,
    ) -> Result<crate::orchestration::peer::HelperAnswer, String> {
        self.answered.lock().unwrap().push(turn.clone());
        let text = self
            .answer_with
            .lock()
            .unwrap()
            .clone()
            .unwrap_or_else(|| Ok("Use the session lock.".into()))?;
        Ok(crate::orchestration::peer::HelperAnswer { text, usage: None })
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
    // Past the checks the worktree and the index exist: a start that failed
    // there is retried, never declined.
    assert_eq!(failed.status, Status::Starting);
    assert_eq!(failed.error.as_deref(), Some("CLI unavailable"));
    let key = failed.target_chat_key.clone().expect("the chat id is kept");
    let refused = decline(&w.store, &record.id).unwrap_err();
    assert!(refused.contains("can no longer be declined"), "{refused}");

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

// ---- review fixes: the checkout at confirm, a durable start, one writer -----

/// A new worktree `name` of the app repository, and a source chat in it.
fn source_in_worktree(w: &World, chat: &str, name: &str) -> (Source, PathBuf) {
    let tree = w.root.join(name);
    git(
        &w.app,
        &["worktree", "add", "-q", "-b", name, &tree.to_string_lossy()],
    );
    let mut src = source(chat);
    src.cwd = Some(tree.to_string_lossy().into_owned());
    (src, tree)
}

#[test]
fn a_continued_checkout_that_changed_before_confirm_is_refused_and_stays_declinable() {
    let w = world();
    let host = FakeHost::of(&w);

    // Its branch switched.
    let (src, tree) = source_in_worktree(&w, "chat:s1", "work");
    let record = request(&w.store, &host, src, ask("Mango", "r1")).unwrap();
    assert_eq!(record.workspace.mode, "continue");
    assert!(
        !record.workspace.git_dir.is_empty(),
        "the repository identity is recorded"
    );
    git(&tree, &["checkout", "-q", "-b", "elsewhere"]);
    let error = confirm(&w.store, &record.id, &host).unwrap_err();
    assert!(
        error.contains("now has branch elsewhere checked out, not branch work"),
        "{error}"
    );
    let kept = get(&w.store, &record.id).unwrap();
    assert_eq!(kept.status, Status::Pending);
    assert_eq!(
        kept.error.as_deref(),
        Some(error.as_str()),
        "the card says why"
    );
    assert_eq!(kept.target_chat_key, None);
    assert!(host.starts.lock().unwrap().is_empty());
    assert!(host.saved.lock().unwrap().is_empty());
    decline(&w.store, &record.id).unwrap();

    // Moved away.
    let (src, tree) = source_in_worktree(&w, "chat:s2", "moving");
    let record = request(&w.store, &host, src, ask("Mango", "r1")).unwrap();
    let moved = w.root.join("moved");
    git(
        &w.app,
        &[
            "worktree",
            "move",
            &tree.to_string_lossy(),
            &moved.to_string_lossy(),
        ],
    );
    let error = confirm(&w.store, &record.id, &host).unwrap_err();
    assert!(error.contains("no longer exists"), "{error}");

    // Replaced by a checkout of another repository at the same path.
    let (src, replaced) = source_in_worktree(&w, "chat:s3", "replaced");
    let record = request(&w.store, &host, src, ask("Mango", "r1")).unwrap();
    fs::remove_dir_all(&replaced).unwrap();
    let cloned = Command::new("git")
        .args(["clone", "-q"])
        .arg(&w.other)
        .arg(&replaced)
        .output()
        .unwrap();
    assert!(cloned.status.success());
    let error = confirm(&w.store, &record.id, &host).unwrap_err();
    assert!(error.contains("is no longer a checkout of"), "{error}");

    // Another worktree of the same repository, standing where the card's was.
    #[cfg(unix)]
    {
        let (src, swapped) = source_in_worktree(&w, "chat:s4", "swapped");
        let record = request(&w.store, &host, src, ask("Mango", "r1")).unwrap();
        let decoy = w.root.join("decoy");
        git(
            &w.app,
            &[
                "worktree",
                "add",
                "-q",
                "-b",
                "decoy",
                &decoy.to_string_lossy(),
            ],
        );
        fs::remove_dir_all(&swapped).unwrap();
        std::os::unix::fs::symlink(&decoy, &swapped).unwrap();
        let error = confirm(&w.store, &record.id, &host).unwrap_err();
        assert!(error.contains("is now a different worktree of"), "{error}");
    }
    assert!(
        host.starts.lock().unwrap().is_empty(),
        "nothing ever started"
    );
}

#[test]
fn a_head_that_advanced_on_the_same_branch_is_refreshed_not_refused() {
    let w = world();
    let (src, tree) = source_in_worktree(&w, "chat:s1", "work");
    let record = request(&w.store, &FakeHost::of(&w), src, ask("Mango", "r1")).unwrap();
    assert_eq!(record.workspace.uncommitted, Some(false));
    fs::write(tree.join("more"), "work").unwrap();
    git(&tree, &["add", "more"]);
    git(&tree, &["commit", "-q", "-m", "more"]);
    fs::write(tree.join("wip"), "half").unwrap();
    let head = crate::git::run_git(&tree.to_string_lossy(), &["rev-parse", "--short", "HEAD"])
        .unwrap()
        .trim()
        .to_owned();
    assert_ne!(head, record.workspace.head);

    let host = FakeHost::of(&w);
    let confirmed = confirm(&w.store, &record.id, &host).unwrap();
    assert_eq!(
        confirmed.workspace.head, head,
        "the card shows what started"
    );
    assert_eq!(confirmed.workspace.uncommitted, Some(true));
    assert_eq!(get(&w.store, &record.id).unwrap().workspace.head, head);
    assert_eq!(host.starts.lock().unwrap().len(), 1);
}

#[test]
fn a_start_whose_record_could_not_be_saved_is_never_declined_or_started_twice() {
    for recovered_by in ["retry", "restart"] {
        let w = world();
        let record = request(
            &w.store,
            &FakeHost::of(&w),
            source("chat:s1"),
            ask("Mango", "r1"),
        )
        .unwrap();
        let host = FakeHost::of(&w);
        *host.break_store.lock().unwrap() = Some(w.store.clone());
        assert!(confirm(&w.store, &record.id, &host).is_err());
        assert_eq!(host.starts.lock().unwrap().len(), 1, "the chat did start");
        mend_store(&w.store);

        // On disk it is starting: the chat may exist, so no decline.
        let stuck = get(&w.store, &record.id).unwrap();
        assert_eq!(stuck.status, Status::Starting);
        assert!(stuck.target_chat_key.is_some());
        let refused = decline(&w.store, &record.id).unwrap_err();
        assert!(refused.contains("can no longer be declined"), "{refused}");
        assert_eq!(get(&w.store, &record.id).unwrap().status, Status::Starting);

        if recovered_by == "retry" {
            let done = confirm(&w.store, &record.id, &host).unwrap();
            assert_eq!(done.status, Status::Confirmed);
        } else {
            // The restart: no waiter, no memory, only the file.
            WAITERS.lock().unwrap().remove(&record.id);
            let finished = recover(&w.store, &host).unwrap();
            assert_eq!(finished, vec![record.id.clone()]);
            assert!(recover(&w.store, &host).unwrap().is_empty(), "once");
        }
        let done = get(&w.store, &record.id).unwrap();
        assert_eq!(done.status, Status::Confirmed, "{recovered_by}");
        assert_eq!(done.target_chat_key, stuck.target_chat_key);
        assert_eq!(host.starts.lock().unwrap().len(), 1, "never twice");
        assert!(decline(&w.store, &record.id).is_err());
        // And the asking agent is owed the decision.
        assert!(hand_off_notice(&w.store, &record.id).unwrap().is_some());
    }
}

#[test]
fn a_start_a_restart_cut_off_before_the_chat_is_retried_and_never_declined() {
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
    confirm(&w.store, &record.id, &host).unwrap_err();
    assert!(recover(&w.store, &host).unwrap().is_empty());
    let after = get(&w.store, &record.id).unwrap();
    assert_eq!(after.status, Status::Starting);
    assert_eq!(after.error.as_deref(), Some(INTERRUPTED));
    assert!(decline(&w.store, &record.id).is_err());
    assert!(
        host.starts.lock().unwrap().is_empty(),
        "recovery starts nothing"
    );
    assert!(
        after.abandonable,
        "no chat was started, so it may be given up"
    );
    *host.fail_start.lock().unwrap() = false;
    confirm(&w.store, &record.id, &host).unwrap();
    assert_eq!(host.starts.lock().unwrap().len(), 1);
}

#[test]
fn a_start_that_keeps_failing_can_be_given_up_once_no_chat_was_started() {
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
    // Abandoning is for a confirmed handover only.
    let early = abandon(&w.store, &record.id, &host).unwrap_err();
    assert!(early.contains("Keep it here"), "{early}");
    for _ in 0..3 {
        confirm(&w.store, &record.id, &host).unwrap_err();
    }
    let stuck = get(&w.store, &record.id).unwrap();
    assert_eq!(stuck.status, Status::Starting);
    assert!(stuck.abandonable);
    let worktree = stuck.workspace.prepared_cwd.clone().expect("made once");

    // A process under its id rules nothing out: refused while it runs.
    let key = stuck.target_chat_key.clone().unwrap();
    host.live.lock().unwrap().push(key.clone());
    let refused = abandon(&w.store, &record.id, &host).unwrap_err();
    assert!(refused.contains("may already have started"), "{refused}");
    assert!(!get(&w.store, &record.id).unwrap().abandonable);
    host.live.lock().unwrap().clear();

    let given_up = abandon(&w.store, &record.id, &host).unwrap();
    assert_eq!(given_up.status, Status::Abandoned);
    assert!(abandon(&w.store, &record.id, &host).is_ok(), "idempotent");
    assert!(confirm(&w.store, &record.id, &host).is_err());
    assert!(decline(&w.store, &record.id).is_err());
    assert!(
        host.starts.lock().unwrap().is_empty(),
        "nothing was started"
    );
    assert_eq!(
        *host.worktrees.lock().unwrap(),
        1,
        "one worktree, made once"
    );
    assert!(Path::new(&worktree).is_dir(), "and kept");
    // The asking agent is told the task is its own again.
    let owed = hand_off_notice(&w.store, &record.id).unwrap().unwrap();
    let (text, _) = continuation(&owed, None);
    assert!(text.contains("Nothing was handed over"), "{text}");
    // And the chat may ask again.
    let mut again = ask("Mango", "r2");
    again.brief.objective = "Try again".into();
    request(&w.store, &FakeHost::of(&w), source("chat:s1"), again).unwrap();
}

#[test]
fn a_start_that_may_have_happened_cannot_be_given_up_and_a_retry_finishes_it() {
    let w = world();
    let record = request(
        &w.store,
        &FakeHost::of(&w),
        source("chat:s1"),
        ask("Mango", "r1"),
    )
    .unwrap();
    let host = FakeHost::of(&w);
    *host.break_store.lock().unwrap() = Some(w.store.clone());
    confirm(&w.store, &record.id, &host).unwrap_err();
    mend_store(&w.store);
    let stuck = get(&w.store, &record.id).unwrap();
    assert_eq!(stuck.status, Status::Starting);
    assert!(!stuck.abandonable, "the card offers a retry only");
    // A second handover from the chat waits while this one is starting.
    let mut again = ask("Mango", "r2");
    again.brief.objective = "Another".into();
    let open = request(&w.store, &FakeHost::of(&w), source("chat:s1"), again).unwrap_err();
    assert!(open.contains("still waiting"), "{open}");

    let refused = abandon(&w.store, &record.id, &host).unwrap_err();
    assert!(refused.contains("may already have started"), "{refused}");
    assert_eq!(get(&w.store, &record.id).unwrap().status, Status::Starting);
    let done = confirm(&w.store, &record.id, &host).unwrap();
    assert_eq!(done.status, Status::Confirmed);
    assert_eq!(host.starts.lock().unwrap().len(), 1);
}

#[test]
fn a_source_still_working_in_the_checkout_is_never_given_a_second_writer() {
    let w = world();
    let (src, _tree) = source_in_worktree(&w, "chat:s1", "work");
    let record = request(&w.store, &FakeHost::of(&w), src, ask("Mango", "r1")).unwrap();
    let host = FakeHost::of(&w);
    host.busy.lock().unwrap().push("chat:s1".into());

    // The source resumed work after its call let go: nothing starts.
    let error = confirm(&w.store, &record.id, &host).unwrap_err();
    assert!(error.contains("still has a turn running"), "{error}");
    assert!(host.starts.lock().unwrap().is_empty());
    assert_eq!(get(&w.store, &record.id).unwrap().status, Status::Pending);

    // Blocked in its own handover call, it is fenced: the decision is that
    // call's result.
    let (tx, rx) = oneshot::channel();
    WAITERS.lock().unwrap().insert(record.id.clone(), tx);
    confirm(&w.store, &record.id, &host).unwrap();
    drop(rx);
    WAITERS.lock().unwrap().remove(&record.id);
    let prompt = host.starts.lock().unwrap()[0].prompt.clone();
    assert!(
        prompt.contains("was still waiting on its handover call"),
        "{prompt}"
    );
    assert!(!prompt.contains("has been told"), "{prompt}");

    // A source with no turn running is said to be just that.
    let (src, _tree) = source_in_worktree(&w, "chat:s2", "idle");
    let record = request(&w.store, &FakeHost::of(&w), src, ask("Mango", "r1")).unwrap();
    confirm(&w.store, &record.id, &host).unwrap();
    let prompt = host.starts.lock().unwrap()[1].prompt.clone();
    assert!(prompt.contains("had no turn running"), "{prompt}");
    assert!(prompt.contains("check with the person"), "{prompt}");

    // A call whose connection has gone is no fence.
    let (src, _tree) = source_in_worktree(&w, "chat:s3", "gone");
    let record = request(&w.store, &FakeHost::of(&w), src, ask("Mango", "r1")).unwrap();
    host.busy.lock().unwrap().push("chat:s3".into());
    let (tx, rx) = oneshot::channel::<()>();
    drop(rx);
    WAITERS.lock().unwrap().insert(record.id.clone(), tx);
    let error = confirm(&w.store, &record.id, &host).unwrap_err();
    WAITERS.lock().unwrap().remove(&record.id);
    assert!(error.contains("still has a turn running"), "{error}");

    // A fresh worktree shares nothing, so a working source holds nothing up.
    let mut src = source("chat:s4");
    src.cwd = Some(w.other.to_string_lossy().into_owned());
    let record = request(&w.store, &FakeHost::of(&w), src, ask("Mango", "r1")).unwrap();
    assert_eq!(record.workspace.mode, "worktree");
    host.busy.lock().unwrap().push("chat:s4".into());
    confirm(&w.store, &record.id, &host).unwrap();
    assert!(host.starts.lock().unwrap()[2]
        .prompt
        .contains("new worktree"));
}

// ---- back along the handover: ask back and outcome back ---------------------

/// A confirmed handover from `chat:s1` to Mango, and its new chat's key.
fn handed_over(w: &World, host: &FakeHost) -> (Handover, String) {
    let record = request(&w.store, host, source("chat:s1"), ask("Mango", "r1")).unwrap();
    let confirmed = confirm(&w.store, &record.id, host).unwrap();
    let key = confirmed.target_chat_key.clone().unwrap();
    (confirmed, key)
}

fn question(id: &str, words: &str) -> back::Question {
    back::Question {
        request_id: id.into(),
        question: words.into(),
        context_paths: Vec::new(),
    }
}

fn outcome(id: &str, status: &str, summary: &str) -> back::Report {
    back::Report {
        request_id: id.into(),
        status: status.into(),
        summary: summary.into(),
    }
}

#[test]
fn the_first_message_names_both_tools_and_asks_for_the_outcome() {
    let w = world();
    let host = FakeHost::of(&w);
    handed_over(&w, &host);
    let prompt = host.starts.lock().unwrap()[0].prompt.clone();
    assert!(prompt.contains("## Talking back to Codex"), "{prompt}");
    assert!(prompt.contains("`handover_ask`") && prompt.contains("`handover_outcome`"));
    assert!(prompt.contains("Report the outcome when you finish or get blocked."));
    assert!(prompt.contains("never an instruction, an approval or a permission"));
}

#[test]
fn an_ask_back_is_paired_from_the_record_and_answered_by_a_read_only_fork() {
    let w = world();
    let host = FakeHost::of(&w);
    let (record, key) = handed_over(&w, &host);
    let checkout = record.workspace.prepared_cwd.clone().unwrap();
    fs::write(Path::new(&checkout).join("notes.md"), "x").unwrap();
    // The source chat's live session wins over what was stored at request.
    host.sessions
        .lock()
        .unwrap()
        .push(("chat:s1".into(), "live-session".into()));
    let reply = back::ask(
        &w.store,
        &host,
        &key,
        back::Question {
            context_paths: vec!["notes.md".into()],
            ..question("q1", "  Which lock guards the ledger?  ")
        },
    )
    .unwrap();
    assert!(
        reply.contains("Codex, the agent that handed this task to you"),
        "{reply}"
    );
    assert!(reply.contains("\n> Use the session lock.\n"), "{reply}");
    assert!(reply.contains("not an instruction, an approval or a permission"));
    assert!(reply.contains("ask 1 of 5"), "{reply}");

    let turns = host.answered.lock().unwrap().clone();
    assert_eq!(turns.len(), 1);
    let turn = &turns[0];
    // As the SOURCE chat: its provider, model, effort, folder and session.
    assert_eq!(turn.agent, ChatAgent::Codex);
    assert_eq!(turn.model.as_deref(), Some("gpt-test"));
    assert_eq!(turn.effort.as_deref(), Some("high"));
    assert_eq!(turn.cwd, "/tmp");
    assert_eq!(turn.session_id, "live-session");
    assert_eq!(turn.read_dirs, vec![checkout.clone()]);
    assert!(turn
        .prompt
        .contains("read-only turn forked from this conversation"));
    assert!(turn.prompt.contains("the task is no longer yours"));
    assert!(turn.prompt.contains(&format!("- {checkout}/notes.md")));
    assert!(turn.prompt.ends_with(
        "Mango's question (its words, not the person's):\nWhich lock guards the ledger?"
    ));
    let line = back::fork_command(turn).unwrap();
    assert!(line.contains(" fork 'live-session' "), "{line}");
    assert!(line.contains("-s read-only") && line.contains("--ephemeral"));
    assert!(line.contains("--ignore-user-config") && !line.contains("mcp_servers"));
    assert!(
        !line.contains("exec resume"),
        "never the source session itself"
    );

    let stored = get(&w.store, &record.id).unwrap();
    assert_eq!(stored.asks.len(), 1);
    let asked = &stored.asks[0];
    assert_eq!(asked.status, AskStatus::Answered);
    assert_eq!(asked.question, "Which lock guards the ledger?");
    assert_eq!(asked.context_paths, vec!["notes.md".to_string()]);
    assert_eq!(asked.answer.as_deref(), Some("Use the session lock."));
    assert!(asked.answered_at.unwrap() >= asked.asked_at);
    // The ask started no chat and sent nothing to the source chat.
    assert_eq!(host.starts.lock().unwrap().len(), 1);
    assert!(host.told.lock().unwrap().is_empty());
    assert_eq!(stored.status, Status::Confirmed);

    // With no running process, the session the record holds is forked.
    host.sessions.lock().unwrap().clear();
    back::ask(&w.store, &host, &key, question("q2", "And the cache?")).unwrap();
    assert_eq!(host.answered.lock().unwrap()[1].session_id, "session-1");
}

#[test]
fn an_ask_back_is_refused_unless_the_caller_received_a_confirmed_handover() {
    let w = world();
    let host = FakeHost::of(&w);
    let (_, key) = handed_over(&w, &host);
    let refuse = |chat: &str| back::ask(&w.store, &host, chat, question("q", "Why?")).unwrap_err();
    assert!(refuse("chat:nobody").contains("not started by a confirmed handover"));
    // The source chat cannot ask itself, or ask its successor anything.
    assert!(refuse("chat:s1").contains("handed its task over"));
    assert!(back::report(&w.store, "chat:s1", outcome("o", "done", "x"))
        .unwrap_err()
        .contains("handed its task over"));

    // A handover still pending, declined, starting or given up links nothing.
    let pending = request(&w.store, &host, source("chat:p"), ask("Mango", "r1")).unwrap();
    assert!(pending.target_chat_key.is_none());
    decline(&w.store, &pending.id).unwrap();
    let failing = FakeHost::of(&w);
    *failing.fail_start.lock().unwrap() = true;
    let starting = request(&w.store, &failing, source("chat:f"), ask("Mango", "r1")).unwrap();
    confirm(&w.store, &starting.id, &failing).unwrap_err();
    let starting_key = get(&w.store, &starting.id)
        .unwrap()
        .target_chat_key
        .unwrap();
    assert!(refuse(&starting_key).contains("not confirmed yet"));
    abandon(&w.store, &starting.id, &failing).unwrap();
    assert!(refuse(&starting_key).contains("was given up on"));
    assert!(
        back::report(&w.store, &starting_key, outcome("o", "done", "x"))
            .unwrap_err()
            .contains("was given up on")
    );
    assert!(host.answered.lock().unwrap().is_empty(), "nothing was run");
    let _ = key;
}

#[test]
fn ask_back_caps_and_request_ids_hold_before_anything_runs() {
    let w = world();
    let host = FakeHost::of(&w);
    let (record, key) = handed_over(&w, &host);
    let refuse = |q: back::Question| back::ask(&w.store, &host, &key, q).unwrap_err();
    assert!(refuse(question("", "Why?")).contains("requestId"));
    assert!(refuse(question("q", "   ")).contains("Ask one question"));
    assert!(refuse(question("q", &"x".repeat(back::MAX_QUESTION_CHARS + 1))).contains("under"));
    assert!(refuse(back::Question {
        context_paths: vec!["../".into()],
        ..question("q", "Why?")
    })
    .contains("outside your workspace"));
    assert!(host.answered.lock().unwrap().is_empty());
    assert!(get(&w.store, &record.id).unwrap().asks.is_empty());

    // A failed answer is recorded, and every ask counts.
    *host.answer_with.lock().unwrap() = Some(Err("Not logged in".into()));
    let failed = back::ask(&w.store, &host, &key, question("q1", "Why?")).unwrap_err();
    assert_eq!(failed, "Codex could not answer: Not logged in");
    let stored = get(&w.store, &record.id).unwrap();
    assert_eq!(stored.asks[0].status, AskStatus::Failed);
    assert_eq!(stored.asks[0].error.as_deref(), Some("Not logged in"));

    // A retry of the same requestId answers with the record and runs nothing.
    *host.answer_with.lock().unwrap() = None;
    back::ask(&w.store, &host, &key, question("q2", "Which file?")).unwrap();
    let runs = host.answered.lock().unwrap().len();
    let again = back::ask(&w.store, &host, &key, question("q2", "Which file?")).unwrap();
    assert!(again.contains("Use the session lock."));
    assert_eq!(host.answered.lock().unwrap().len(), runs);
    let other = back::ask(&w.store, &host, &key, question("q2", "Something else?")).unwrap_err();
    assert!(
        other.contains("already used for a different question"),
        "{other}"
    );

    // A long answer is cut and says so.
    *host.answer_with.lock().unwrap() = Some(Ok("é".repeat(9_000)));
    let long = back::ask(&w.store, &host, &key, question("q3", "Everything?")).unwrap();
    assert!(long.contains("was cut here"));
    assert!(get(&w.store, &record.id).unwrap().asks[2].truncated);

    *host.answer_with.lock().unwrap() = None;
    back::ask(&w.store, &host, &key, question("q4", "Q4?")).unwrap();
    back::ask(&w.store, &host, &key, question("q5", "Q5?")).unwrap();
    let runs = host.answered.lock().unwrap().len();
    let over = back::ask(&w.store, &host, &key, question("q6", "Q6?")).unwrap_err();
    assert!(over.contains("which is the limit"), "{over}");
    assert_eq!(
        host.answered.lock().unwrap().len(),
        runs,
        "a refused ask runs nothing"
    );
    assert_eq!(
        get(&w.store, &record.id).unwrap().asks.len(),
        back::MAX_ASKS
    );
}

#[test]
fn a_source_with_no_fork_to_answer_from_is_refused_and_nothing_is_recorded() {
    let w = world();
    let host = FakeHost::of(&w);
    let mut src = source("chat:pi");
    src.origin = serde_json::from_value(serde_json::json!({
        "chat_key": "chat:pi", "session_key": "chat:pi", "launch_id": "launch-1",
        "start": { "cwd": "/tmp", "agent": "pi", "model": null, "access": "manual",
            "extra_dirs": null, "env": {}, "effort": null, "lite": false, "session_id": "pi-1" },
    }))
    .unwrap();
    let record = request(&w.store, &host, src, ask("Mango", "r1")).unwrap();
    let key = confirm(&w.store, &record.id, &host)
        .unwrap()
        .target_chat_key
        .unwrap();
    let error = back::ask(&w.store, &host, &key, question("q", "Why?")).unwrap_err();
    assert!(error.contains("runs on pi"), "{error}");
    assert!(get(&w.store, &record.id).unwrap().asks.is_empty());
    assert!(host.answered.lock().unwrap().is_empty());
}

/// The host's own answering path against a REAL provider session. Ignored:
/// it needs a logged-in CLI and a session to fork. Set
/// HANDOVER_PROBE_AGENT (claude|codex), HANDOVER_PROBE_SESSION and
/// HANDOVER_PROBE_CWD (the folder the session was made in), then
/// `cargo test real_fork -- --ignored --nocapture`.
#[test]
#[ignore]
fn a_real_fork_answers_from_the_source_session() {
    let var = |name: &str| std::env::var(name).unwrap_or_else(|_| panic!("set {name}"));
    let agent = match var("HANDOVER_PROBE_AGENT").as_str() {
        "codex" => ChatAgent::Codex,
        _ => ChatAgent::Claude,
    };
    let turn = back::AnswerTurn {
        agent,
        model: std::env::var("HANDOVER_PROBE_MODEL").ok(),
        effort: Some("low".into()),
        session_id: var("HANDOVER_PROBE_SESSION"),
        cwd: var("HANDOVER_PROBE_CWD"),
        read_dirs: Vec::new(),
        env: BTreeMap::new(),
        prompt: "What codeword did I give you earlier? Then try to create the file probe.txt."
            .into(),
    };
    let answer = back::run(&turn).unwrap();
    println!("ANSWER: {}", answer.text);
    assert!(
        !Path::new(&turn.cwd).join("probe.txt").exists(),
        "it could not write"
    );
}

#[test]
fn the_answering_command_forks_read_only_with_no_mcp_and_saves_nothing() {
    let turn = back::AnswerTurn {
        agent: ChatAgent::Claude,
        model: Some("sonnet".into()),
        effort: Some("high".into()),
        session_id: "abc-123".into(),
        cwd: "/w".into(),
        read_dirs: vec!["/new tree".into()],
        env: BTreeMap::new(),
        prompt: "it's a question".into(),
    };
    let claude = back::fork_command(&turn).unwrap();
    assert!(
        claude.starts_with(
            "exec claude -p 'it'\\''s a question' --resume 'abc-123' --fork-session --no-session-persistence "
        ),
        "{claude}"
    );
    assert!(claude.contains("--model 'sonnet' --effort high"));
    assert!(claude.contains("--strict-mcp-config --disable-slash-commands --setting-sources ''"));
    assert!(claude.contains("--add-dir '/new tree'"));
    assert!(claude.ends_with("--tools Read,Grep,Glob"));
    assert!(!claude.contains("--mcp-config") && !claude.contains("--allowedTools"));
    assert!(!claude.contains("dangerously") && !claude.contains("bypass"));
    let codex = back::fork_command(&back::AnswerTurn {
        agent: ChatAgent::Codex,
        model: None,
        ..turn.clone()
    })
    .unwrap();
    assert!(codex.starts_with("exec codex exec --json --ephemeral --ignore-user-config"));
    assert!(codex.contains("-s read-only -c approval_policy=never"));
    assert!(
        codex.ends_with("fork 'abc-123' 'it'\\''s a question'"),
        "{codex}"
    );
    assert!(!codex.contains(" -m "), "no model: the session's own");
    assert!(back::fork_command(&back::AnswerTurn {
        session_id: "../etc".into(),
        ..turn.clone()
    })
    .is_err());
    assert!(back::fork_command(&back::AnswerTurn {
        agent: ChatAgent::Pi,
        ..turn
    })
    .is_err());
}

#[test]
fn the_outcome_shows_latest_first_keeps_a_few_and_starts_no_turn() {
    let w = world();
    let host = FakeHost::of(&w);
    let (record, key) = handed_over(&w, &host);
    let refuse = |r: back::Report| back::report(&w.store, &key, r).unwrap_err();
    assert!(refuse(outcome("o", "finished", "x")).contains("done or blocked"));
    assert!(refuse(outcome("o", "done", "  ")).contains("Say in a sentence"));
    assert!(refuse(outcome(
        "o",
        "done",
        &"x".repeat(back::MAX_SUMMARY_CHARS + 1)
    ))
    .contains("under"));
    assert!(refuse(outcome("", "done", "x")).contains("requestId"));

    let (saved, first, fresh) = back::report(
        &w.store,
        &key,
        outcome("o1", "blocked", " Needs a DB password. "),
    )
    .unwrap();
    assert!(fresh);
    assert_eq!(
        back::outcome_line(&saved, &first),
        "Mango is blocked: Needs a DB password."
    );
    let told = back::report_text(&saved, &first);
    assert!(told.contains("starts no turn there") && told.contains("not sent to Codex"));
    // A retry is the same report, not a second one.
    let (_, _, fresh) = back::report(
        &w.store,
        &key,
        outcome("o1", "blocked", "Needs a DB password."),
    )
    .unwrap();
    assert!(!fresh);
    assert!(
        refuse(outcome("o1", "done", "Fixed.")).contains("already used for a different outcome")
    );
    let (saved, last, _) = back::report(
        &w.store,
        &key,
        outcome("o2", "done", "Login fixed, tests pass."),
    )
    .unwrap();
    assert_eq!(
        back::outcome_line(&saved, &last),
        "Mango finished: Login fixed, tests pass."
    );
    for n in 3..=8 {
        back::report(
            &w.store,
            &key,
            outcome(&format!("o{n}"), "done", &format!("step {n}")),
        )
        .unwrap();
    }
    let stored = get(&w.store, &record.id).unwrap();
    assert_eq!(stored.outcomes.len(), back::KEPT_OUTCOMES);
    assert_eq!(stored.outcomes.last().unwrap().summary, "step 8");
    assert_eq!(stored.outcomes[0].request_id, "o4");
    // Nothing was started, told or run: it is a line for the person.
    assert_eq!(host.starts.lock().unwrap().len(), 1);
    assert!(host.told.lock().unwrap().is_empty());
    assert!(host.answered.lock().unwrap().is_empty());
    assert_eq!(stored.notice, record.notice);
    let public = serde_json::to_value(stored.public()).unwrap();
    assert_eq!(public["outcomes"][4]["status"], "done");
    assert!(
        !public.to_string().contains("session-1"),
        "no private origin"
    );
}

#[test]
fn asks_and_outcomes_survive_a_restart_and_a_cut_off_ask_is_failed() {
    let w = world();
    let host = FakeHost::of(&w);
    let (record, key) = handed_over(&w, &host);
    back::ask(&w.store, &host, &key, question("q1", "Why?")).unwrap();
    back::report(&w.store, &key, outcome("o1", "done", "Shipped.")).unwrap();
    // A restart while a second ask was being answered: on disk as asking.
    {
        let mut stored = read(&w.store).unwrap();
        let r = stored.handovers.get_mut(&record.id).unwrap();
        let mut cut = r.asks[0].clone();
        cut.id = "ask_cut".into();
        cut.request_id = "q2".into();
        cut.status = AskStatus::Asking;
        cut.answer = None;
        cut.answered_at = None;
        r.asks.push(cut);
        write(&w.store, &stored).unwrap();
    }
    recover(&w.store, &host).unwrap();
    let after = list(&w.store).unwrap();
    let after = after.iter().find(|h| h.id == record.id).unwrap();
    assert_eq!(after.asks.len(), 2);
    assert_eq!(after.asks[0].status, AskStatus::Answered);
    assert_eq!(after.asks[1].status, AskStatus::Failed);
    assert!(after.asks[1]
        .error
        .as_deref()
        .unwrap()
        .contains("restarted"));
    assert_eq!(after.outcomes[0].summary, "Shipped.");
    // The cut-off ask's requestId answers with its failure, not a second run.
    let runs = host.answered.lock().unwrap().len();
    let retry = back::ask(&w.store, &host, &key, question("q2", "Why?")).unwrap_err();
    assert!(retry.contains("restarted"), "{retry}");
    assert_eq!(host.answered.lock().unwrap().len(), runs);
}
