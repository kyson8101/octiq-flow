//! Review of ca81617: a registered agent's chat starts no lower than that
//! agent's registered access, and the host is the one that says so.
//!
//! The rule was first put on the page, which cannot hold it: it does not
//! always know the roster, or whether a process is running, when it has to
//! decide (H1, M1), and it saved a level the process did not run at (M2).
//! It is decided at `start_session`, the one door every process start goes
//! through, from the roster as it is at that moment.
//!
//! Review of a4d072b: the host then told pages the level on an event of its
//! own, which had no order against a level the person had just picked (R1).
//! There is no such event. For a registered agent's own conversation the
//! host is the only writer of the index entry's level; every other chat is
//! saved by its page exactly as before.
//!
//! Every start here is the real one, down every path that reaches the door,
//! against the stores a server loads from its profile folder. Only the
//! process is a stand-in (`ChatManager::test_stand_in_launches`): the level
//! it is started at, the session table, the remembered start, the chat index
//! and what is said on the bus are what a server does.
use super::*;
use crate::bus::tap::Tap;
use crate::dispatch::{told, Services};
use crate::orchestration::inbox::{DeliveryState, Notification, RECEIPT_PREFIX};
use crate::orchestration::tests::{run, running_worker_on};
use crate::profile::tests::Home;
use crate::team::{TeamAgent, TeamDraft};
use crate::test_dir::TestDir;
use serde_json::json;

/// A server with its profile folder on a drive of its own, whose launches
/// are stand-ins.
struct World {
    svc: Services,
    /// The roster's path is one global in tests.
    _roster: crate::team::TestTeamPath,
    _process: crate::profile::Started,
    _home: Home,
    /// The folder chats run in.
    project: TestDir,
    team: PathBuf,
}

/// One chat: its key, and what is said about its level from here on.
struct Chat {
    id: String,
    key: String,
    /// The provider's id for its conversation.
    session: String,
    said: Tap,
}

impl World {
    fn new() -> Self {
        let home = Home::with_a_configured_base();
        let process = crate::profile::started_in(&home.dir);
        let team = crate::profile::profile_dir().join("team.json");
        let roster = crate::team::use_test_path(team.clone());
        let svc = Services::at_profile();
        svc.chats.test_stand_in_launches();
        Self {
            svc,
            _roster: roster,
            _process: process,
            _home: home,
            project: TestDir::new("level-project"),
            team,
        }
    }

    /// The server is stopped and started again: what was in memory is gone,
    /// and what was on disk is read back.
    fn restart(&mut self) {
        self.svc = Services::at_profile();
        self.svc.chats.test_stand_in_launches();
    }

    fn chats(&self) -> &Arc<ChatManager> {
        &self.svc.chats
    }

    fn cwd(&self) -> String {
        self.project.0.to_string_lossy().into_owned()
    }

    /// Register an agent at `access`, or move a registered one to it.
    fn register(&self, id: Option<&str>, access: Access) -> TeamAgent {
        self.register_as("Vesper", id, access)
    }

    fn register_as(&self, name: &str, id: Option<&str>, access: Access) -> TeamAgent {
        self.register_in(name, id, access, None)
    }

    /// The same, as an agent of the one project `project`, or a global one.
    fn register_in(
        &self,
        name: &str,
        id: Option<&str>,
        access: Access,
        project: Option<&str>,
    ) -> TeamAgent {
        crate::team::save(
            &self.team,
            TeamDraft {
                id: id.map(str::to_string),
                name: name.into(),
                role: "Leads the work.".into(),
                agent: ChatAgent::Claude,
                model: "sonnet".into(),
                effort: None,
                access: Some(access),
                project_id: project.map(str::to_string),
                reports_to: None,
                avatar: None,
                team_id: None,
                persistent_prompt: None,
            },
        )
        .expect("the agent is registered")
    }

    /// A chat the index lists at `saved`, with nobody behind it.
    fn plain(&self, saved: Option<&str>) -> Chat {
        self.listed(&format!("level-{}", uuid::Uuid::new_v4().simple()), saved)
    }

    /// A chat the index does not list yet: one whose first save is still
    /// to come.
    fn unlisted(&self) -> Chat {
        let id = format!("level-{}", uuid::Uuid::new_v4().simple());
        let key = format!("chat:{id}");
        Chat {
            said: Tap::on(&key),
            session: format!("session-{id}"),
            id,
            key,
        }
    }

    fn listed(&self, id: &str, saved: Option<&str>) -> Chat {
        let key = format!("chat:{id}");
        // Its own conversation with its provider: a session two chats
        // shared would be refused to one of them (`require_user_resume`).
        let session = format!("session-{id}");
        crate::chat_index::upsert(
            serde_json::from_value(json!({
                "id": id,
                "projectId": "p1",
                "updatedAt": 100,
                "cwd": self.cwd(),
                "sessionId": session,
                "access": saved,
            }))
            .unwrap(),
        )
        .unwrap();
        Chat {
            said: Tap::on(&key),
            id: id.to_string(),
            key,
            session,
        }
    }

    /// A conversation with `agent`, which the index lists at `saved`: what
    /// an earlier read-only discussion left behind when `saved` is `read`.
    fn chat_of(&self, agent: &TeamAgent, saved: Option<&str>) -> Chat {
        let chat = self.plain(saved);
        self.is_of(&chat, agent);
        chat
    }

    fn is_of(&self, chat: &Chat, agent: &TeamAgent) {
        crate::team::record_lead(&self.team, &chat.key, agent, "p1", false)
            .expect("the chat is the agent's");
    }

    /// How a chat was last started, as the host remembers it.
    fn start(&self, chat: &Chat, access: Option<Access>) -> StartContext {
        StartContext {
            cwd: self.cwd(),
            agent: ChatAgent::Claude,
            model: None,
            access,
            extra_dirs: None,
            env: None,
            effort: None,
            lite: None,
            session_id: Some(chat.session.clone()),
        }
    }

    /// The page's `chat_start` at `access`.
    fn page_starts(&self, chat: &Chat, access: Option<&str>) -> Result<Value, String> {
        told(
            &self.svc,
            "chat_start",
            json!({
                "key": chat.key,
                "cwd": self.cwd(),
                "agent": "claude",
                "access": access,
                "prompt": "/carry on",
                "resume": chat.session,
                "turnId": format!("user-{}", uuid::Uuid::new_v4()),
            }),
        )
        .result
    }

    /// The door itself, for a chat the page's own command would not start:
    /// the chat's own voice, asked at `access`.
    fn host_starts(&self, chat: &Chat, access: Access) -> Result<(), String> {
        start_session(
            self.chats().clone(),
            Voice::host(chat.key.clone()),
            self.cwd(),
            ChatAgent::Claude,
            None,
            Some(access),
            Some("/carry on".into()),
            Some(chat.session.clone()),
            None,
            None,
            None,
            None,
            None,
            Some(format!("user-{}", uuid::Uuid::new_v4())),
            true,
            None,
        )
    }

    /// The page's save of the chat's index entry, naming `access`.
    fn page_saves(&self, chat: &Chat, access: &str) {
        self.page_saves_in(chat, access, "p1");
    }

    /// The same, with the chat listed under `project`.
    fn page_saves_in(&self, chat: &Chat, access: &str, project: &str) {
        let saved = told(
            &self.svc,
            "chat_index_save",
            json!({ "meta": {
                "id": chat.id,
                "projectId": project,
                "updatedAt": 200,
                "cwd": self.cwd(),
                "sessionId": chat.session,
                "access": access,
            }}),
        );
        assert_eq!(saved.result, Ok(Value::Null));
    }

    /// The level the chat's process runs at, when it has one.
    fn runs_at(&self, chat: &Chat) -> Option<Access> {
        self.chats().running_level(&chat.key)
    }

    /// The page's `chat_set_access`, for a chat with a process.
    fn person_picks(&self, chat: &Chat, access: &str) {
        let set = told(
            &self.svc,
            "chat_set_access",
            json!({ "key": chat.key, "access": access }),
        );
        assert_eq!(set.result, Ok(Value::Null), "the level is changed");
    }

    /// The level the chat index says.
    fn listed_at(&self, chat: &Chat) -> Option<String> {
        crate::chat_index::list()
            .into_iter()
            .find(|meta| meta.id == chat.id)
            .expect("the chat is listed")
            .access
    }

    /// The chat has a process at `level`, and everything the host keeps
    /// about its level says that one: what a host resume starts from, and
    /// the index, which is the host's to write for an agent's own chat.
    /// Nothing was said about a level on the bus.
    #[track_caller]
    fn started_at(&self, chat: &Chat, level: Access, why: &str) {
        self.runs_as(chat, level, why);
        assert_eq!(
            self.listed_at(chat).as_deref(),
            Some(level.as_env()),
            "{why}: the chat index"
        );
    }

    /// The door alone was asked (`host_starts`, which remembers no start:
    /// that is its caller's): the process runs at `level` and the host
    /// wrote that level into the entry.
    #[track_caller]
    fn door_started_at(&self, chat: &Chat, level: Access, why: &str) {
        assert_eq!(self.runs_at(chat), Some(level), "{why}: the process");
        assert_eq!(
            self.listed_at(chat).as_deref(),
            Some(level.as_env()),
            "{why}: the chat index"
        );
        chat.hears_no_level(why);
    }

    /// The chat has a process at `level`, which is what the next host
    /// resume starts from, and nothing was said about a level on the bus.
    /// For a chat whose index entry is its page's to save.
    #[track_caller]
    fn runs_as(&self, chat: &Chat, level: Access, why: &str) {
        assert_eq!(self.runs_at(chat), Some(level), "{why}: the process");
        assert_eq!(
            self.chats().test_start_access(&chat.key),
            Some(level),
            "{why}: what the next host resume starts from"
        );
        chat.hears_no_level(why);
    }

    fn end(&self, chat: &Chat) {
        self.chats().test_end(&chat.key);
    }
}

impl Chat {
    /// The host says nothing of a chat's level on the bus: not the event
    /// that was tried and taken out (review of a4d072b, R1), and no other
    /// of its kind. A page learns a level from the chat index and from the
    /// answers to its own commands.
    #[track_caller]
    fn hears_no_level(&self, why: &str) {
        let said: Vec<_> = self
            .said
            .heard()
            .into_iter()
            .filter(|(event, payload)| {
                event == "chat-access-changed" || payload.get("access").is_some()
            })
            .collect();
        assert_eq!(said, Vec::new(), "{why}: no event says a level");
    }
}

/// Every way a new process is started for a chat.
#[derive(Clone, Copy, Debug)]
enum Path {
    /// The page's `chat_start`.
    PageStart,
    /// `chat_complete` for a chat with no process: started with the wrap-up.
    CompleteWithStart,
    /// The run panel's Continue, for a coordinator with no live process.
    MasterStart,
    /// A queued message carried into the chat's next process.
    QueuedCarry,
    /// A host continuation (a gate's answer, a coordinator's message).
    CoordinatorContinue,
    /// The automatic resume after a usage limit.
    AutoResume,
    /// A run's notification to its coordinator, after a server restart.
    NotificationAfterRestart,
    /// A late answer told to the chat that asked, after a server restart.
    ContinueOriginAfterRestart,
}

impl Path {
    const ALL: [Self; 8] = [
        Self::PageStart,
        Self::CompleteWithStart,
        Self::MasterStart,
        Self::QueuedCarry,
        Self::CoordinatorContinue,
        Self::AutoResume,
        Self::NotificationAfterRestart,
        Self::ContinueOriginAfterRestart,
    ];

    /// Start `chat` this way, with read as the level asked or remembered.
    fn start(self, world: &mut World, chat: &Chat) -> Result<(), String> {
        let read = world.start(chat, Some(Access::Read));
        let chats = world.chats().clone();
        match self {
            Self::PageStart => world.page_starts(chat, Some("read")).map(drop),
            Self::CompleteWithStart => told(
                &world.svc,
                "chat_complete",
                json!({ "chatKey": chat.key, "start": {
                    "cwd": world.cwd(),
                    "agent": "claude",
                    "access": "read",
                    "resume": chat.session,
                }}),
            )
            .result
            .map(drop),
            Self::MasterStart => chat_start_master_impl(
                chats,
                chat.key.clone(),
                world.cwd(),
                ChatAgent::Claude,
                None,
                Some(Access::Read),
                "Continue the run.".into(),
                None,
                Some(chat.session.clone()),
                None,
                None,
                None,
                None,
            ),
            Self::QueuedCarry => {
                chats.remember_start(&chat.key, read);
                let turn = QueuedTurn {
                    text: "/the queued message".into(),
                    images: Vec::new(),
                    turn_id: Some(format!("user-{}", uuid::Uuid::new_v4())),
                    appended_turn_ids: Vec::new(),
                    recorded: false,
                    context: chats.queue_context(&chat.key),
                };
                start_queued_turn(chats, &chat.key, &chat.key, turn, false)
            }
            Self::CoordinatorContinue => {
                chats.remember_start(&chat.key, read);
                chat_continue_internal_impl(chats, chat.key.clone(), "A gate was answered.".into())
            }
            Self::AutoResume => {
                let now = crate::auto_resume::unix_now();
                let entry = chats
                    .auto_resumes
                    .schedule(&chat.key, now + 60, read, now)?
                    .expect("a resume is scheduled");
                run_scheduled_resume(chats, &entry)
            }
            Self::NotificationAfterRestart => {
                // The chat coordinates a run, so the ledger keeps its start
                // settings: read, like the index.
                let run = run(&world.svc.orchestrations);
                world
                    .svc
                    .orchestrations
                    .test_set_coordinator(&run.id, &chat.key)?;
                chats.remember_start(&chat.key, read);
                world.restart();
                assert_eq!(world.chats().test_start_access(&chat.key), None);
                let delivered = deliver_orchestration_notification(
                    world.chats().clone(),
                    &notification(&run.id, &chat.key),
                    Default::default(),
                )?;
                assert!(delivered, "the notification started the coordinator");
                Ok(())
            }
            Self::ContinueOriginAfterRestart => {
                // The chat asked something while it ran at read, and the
                // card was left unanswered: the settings it ran on are
                // saved with the question.
                let origin = QuestionOrigin {
                    chat_key: chat.key.clone(),
                    session_key: chat.key.clone(),
                    launch_id: "the-launch-that-asked".into(),
                    start: read,
                };
                world.restart();
                assert_eq!(world.chats().test_start_access(&chat.key), None);
                continue_origin(
                    world.chats().clone(),
                    &origin,
                    "Your question was answered.".into(),
                    format!("octiq-answer-{}", uuid::Uuid::new_v4()),
                )
            }
        }
    }
}

fn notification(run_id: &str, target: &str) -> Notification {
    Notification {
        id: format!("{RECEIPT_PREFIX}{}", uuid::Uuid::new_v4().simple()),
        run_id: run_id.into(),
        from_chat_key: "chat:a-worker".into(),
        target_chat_key: target.into(),
        source: "test".into(),
        kind: "status".into(),
        body: "A task settled.".into(),
        state: DeliveryState::Delivering,
        attempts: 0,
        coalesced: 0,
        created_at: 0,
        updated_at: 0,
        next_attempt_at: 0,
        last_error: None,
    }
}

/// The table: a chat an earlier discussion left at read, whose agent is
/// registered at Auto, is started at Auto down every path, the start
/// settings and the index say that level, and no event says it.
#[test]
fn every_start_path_starts_a_registered_agents_chat_at_its_registered_access() {
    for path in Path::ALL {
        let mut world = World::new();
        let agent = world.register(None, Access::Auto);
        let chat = world.chat_of(&agent, Some("read"));

        assert_eq!(path.start(&mut world, &chat), Ok(()), "{path:?}");

        world.started_at(&chat, Access::Auto, &format!("{path:?}"));
        if matches!(path, Path::NotificationAfterRestart) {
            // The ledger and the index agree, which is what the next
            // notification after a restart is delivered on.
            assert_eq!(
                world
                    .svc
                    .orchestrations
                    .saved_resume_context(&chat.key)
                    .and_then(|start| start.access_level()),
                Some(Access::Auto),
                "the level the ledger resumes the coordinator at"
            );
        }
        world.end(&chat);
    }
}

/// The sequence the first round's report left open: an old discussion chat
/// at read leaves a card unanswered, the page then starts the chat at its
/// agent's registered level, the server restarts, and the person answers
/// the old card. The settings saved with the question say read; the chat is
/// started at the registered level all the same.
#[test]
fn a_late_answer_after_a_restart_does_not_put_a_chat_back_to_read() {
    let mut world = World::new();
    let agent = world.register(None, Access::Auto);
    let chat = world.chat_of(&agent, Some("read"));

    // The page starts it, asking for the level it holds.
    assert_eq!(world.page_starts(&chat, Some("read")), Ok(Value::Null));
    world.started_at(&chat, Access::Auto, "the page's start");
    world.end(&chat);

    assert_eq!(
        Path::ContinueOriginAfterRestart.start(&mut world, &chat),
        Ok(())
    );
    world.started_at(&chat, Access::Auto, "the late answer");
    world.end(&chat);
}

/// It only ever raises, and only to the registered level.
#[test]
fn a_start_is_raised_to_the_registered_level_and_never_lowered() {
    let world = World::new();
    let agent = world.register(None, Access::Auto);

    // A level the person approved above the registered one is kept.
    let full = world.chat_of(&agent, Some("full"));
    assert_eq!(world.page_starts(&full, Some("full")), Ok(Value::Null));
    world.started_at(&full, Access::Full, "asked full, registered auto");
    world.end(&full);

    // No level asked at all: the registered one.
    let unasked = world.chat_of(&agent, None);
    assert_eq!(world.page_starts(&unasked, None), Ok(Value::Null));
    world.started_at(&unasked, Access::Auto, "nothing asked");
    world.end(&unasked);

    // The agent is moved down to Accept edits: a chat asked at Auto stays
    // at Auto, and one asked at read is raised to Accept edits, no further.
    world.register(Some(&agent.id), Access::Edits);
    let kept = world.chat_of(&agent, Some("auto"));
    assert_eq!(world.page_starts(&kept, Some("auto")), Ok(Value::Null));
    world.started_at(&kept, Access::Auto, "asked auto, registered edits");
    world.end(&kept);

    let raised = world.chat_of(&agent, Some("read"));
    assert_eq!(world.page_starts(&raised, Some("read")), Ok(Value::Null));
    world.started_at(&raised, Access::Edits, "asked read, registered edits");
    world.end(&raised);

    // Registered at read, a chat asked at read is a read-only chat.
    world.register(Some(&agent.id), Access::Read);
    let read = world.chat_of(&agent, Some("read"));
    assert_eq!(world.page_starts(&read, Some("read")), Ok(Value::Null));
    world.started_at(&read, Access::Read, "asked read, registered read");
    world.end(&read);
}

/// A chat that is not a registered agent's own conversation is started at
/// the level asked, each told apart by what lasts.
#[test]
fn a_chat_that_is_not_a_registered_agents_own_is_started_as_asked() {
    let world = World::new();
    let agent = world.register(None, Access::Auto);
    #[track_caller]
    fn as_asked(world: &World, chat: &Chat, started: Result<(), String>, why: &str) {
        assert_eq!(started, Ok(()), "{why}");
        assert_eq!(
            world.runs_at(chat),
            Some(Access::Read),
            "{why}: the process"
        );
        assert_eq!(world.listed_at(chat).as_deref(), Some("read"), "{why}");
        chat.hears_no_level(why);
        world.end(chat);
    }
    let page = |chat: &Chat| world.page_starts(chat, Some("read")).map(drop);
    // A worker's chat is the host's to start, with its task's level.
    let host = |chat: &Chat| world.host_starts(chat, Access::Read);

    // No identity: an ordinary chat, a PR dashboard's Study or Review chat.
    let plain = world.plain(Some("read"));
    as_asked(&world, &plain, page(&plain), "no lead record");

    // A worker's chat by its key, though a lead record names it (a worker
    // that manages reports of its own has one).
    let worker = world.listed(
        &format!("orch-{}", uuid::Uuid::new_v4().simple()),
        Some("read"),
    );
    world.is_of(&worker, &agent);
    as_asked(&world, &worker, host(&worker), "a worker's key");

    // A worker's chat by an attempt on record, whatever its key: one that
    // has settled is still a worker's.
    let settled = world.chat_of(&agent, Some("read"));
    let run = run(&world.svc.orchestrations);
    let attempt = running_worker_on(&world.svc.orchestrations, &run, ChatAgent::Claude);
    world
        .svc
        .orchestrations
        .test_set_worker_chat(&attempt.id, &settled.key)
        .unwrap();
    assert_eq!(
        world.svc.orchestrations.is_worker_chat(&settled.key),
        Ok(true)
    );
    as_asked(&world, &settled, host(&settled), "an attempt on record");

    // The agent the chat names was removed from the roster.
    let gone = world.register_as("Orrin", None, Access::Full);
    let orphan = world.chat_of(&gone, Some("read"));
    crate::team::delete(&world.team, &gone.id).expect("the agent is removed");
    as_asked(&world, &orphan, page(&orphan), "a removed agent");
}

/// A room seat is not the chat's own voice: it is started as asked, and it
/// changes neither the chat's index entry nor what a page is told.
#[test]
fn a_room_seat_is_started_as_asked_and_says_nothing_of_the_chat() {
    let world = World::new();
    let agent = world.register(None, Access::Auto);
    let chat = world.chat_of(&agent, Some("auto"));
    let seat = format!("{}#seat", chat.key);

    let started = start_session(
        world.chats().clone(),
        Voice {
            session_key: seat.clone(),
            stream_key: chat.key.clone(),
        },
        world.cwd(),
        ChatAgent::Claude,
        None,
        Some(Access::Read),
        Some("/join in".into()),
        None,
        None,
        None,
        None,
        None,
        None,
        Some("user-seat".into()),
        true,
        None,
    );
    assert_eq!(started, Ok(()));
    assert_eq!(world.chats().running_level(&seat), Some(Access::Read));
    assert_eq!(world.listed_at(&chat).as_deref(), Some("auto"));
    chat.hears_no_level("a seat");
    world.chats().test_end(&seat);
}

/// The front desk's launch stays read-only whatever its registration says:
/// the override at the door wins, and the rule adds nothing to it.
#[test]
fn a_front_desk_is_started_read_only_whatever_it_is_registered_at() {
    let world = World::new();
    let desk = crate::team::create_front_desk(&world.team, Default::default()).unwrap();
    // Its registration is moved up; its launch does not follow.
    let desk = world.register(Some(&desk.id), Access::Auto);
    let key = format!("chat:desk-{}", uuid::Uuid::new_v4().simple());
    crate::team::front_desk_brief(&world.team, &key, &desk.id, "Who should take this?", &[])
        .unwrap()
        .expect("the chat is a front desk's");
    // Even with a lead record that names it for the same chat.
    crate::team::record_lead(&world.team, &key, &desk, "p1", false).unwrap();
    assert!(crate::team::is_front_desk_chat(&world.team, &key));
    assert_eq!(
        crate::team::registered_access_of_chat(&world.team, &key),
        Ok(None),
        "a front desk's chat has no level to be raised to"
    );

    let said = Tap::on(&key);
    let started = start_session(
        world.chats().clone(),
        Voice::host(key.clone()),
        world.cwd(),
        ChatAgent::Claude,
        None,
        Some(Access::Auto),
        Some("/route this".into()),
        None,
        None,
        None,
        None,
        None,
        None,
        Some("user-desk".into()),
        true,
        None,
    );
    assert_eq!(started, Ok(()));
    assert_eq!(world.chats().running_level(&key), Some(Access::Read));
    assert_eq!(
        world.chats().registered_level(&key, &key),
        None,
        "and its index entry is nobody's to write: it has none"
    );
    assert!(
        !said.heard().iter().any(|(event, payload)| {
            event == "chat-access-changed" || payload.get("access").is_some()
        }),
        "no event says a level"
    );
    world.chats().test_end(&key);
}

/// A roster that cannot be read is not read as anything: not as "nobody is
/// registered" that would matter here, and not as a level.
#[test]
fn a_roster_that_cannot_be_read_leaves_the_level_as_asked() {
    let world = World::new();
    let agent = world.register(None, Access::Full);
    let chat = world.chat_of(&agent, Some("read"));
    std::fs::write(&world.team, b"{ not a roster").unwrap();
    assert!(crate::team::registered_access_of_chat(&world.team, &chat.key).is_err());

    // Through the door itself: the page's command reads the roster for
    // other things and refuses on its own.
    assert_eq!(world.host_starts(&chat, Access::Read), Ok(()));
    assert_eq!(world.runs_at(&chat), Some(Access::Read));
    assert_eq!(world.listed_at(&chat).as_deref(), Some("read"));
    chat.hears_no_level("an unreadable roster");
    world.end(&chat);
}

/// A process that is already running is never touched: not restarted, not
/// moved to another level, and its index entry is left as it is.
#[test]
fn a_running_chat_is_not_restarted_raised_or_told_anything() {
    let world = World::new();
    let agent = world.register(None, Access::Read);
    let chat = world.chat_of(&agent, Some("read"));
    assert_eq!(world.page_starts(&chat, Some("read")), Ok(Value::Null));
    world.started_at(&chat, Access::Read, "registered read");
    let process = world.chats().test_child(&chat.key);

    // Its agent is registered higher while it runs.
    world.register(Some(&agent.id), Access::Auto);

    // A second start is refused in the words a page answers by sending.
    assert_eq!(
        world.page_starts(&chat, Some("read")),
        Err(format!("chat '{}' is already running", chat.key))
    );
    // A send, a host continuation and the run panel's Continue all reach
    // the process that is there.
    let sent = told(
        &world.svc,
        "chat_send",
        json!({ "key": chat.key, "text": "/and this", "turnId": "user-next" }),
    );
    assert_eq!(sent.result, Ok(Value::Null));
    assert_eq!(
        chat_continue_internal_impl(world.chats().clone(), chat.key.clone(), "A note.".into()),
        Ok(())
    );

    assert!(process.alive(), "the same process");
    assert_eq!(world.runs_at(&chat), Some(Access::Read));
    assert_eq!(
        world.chats().test_start_access(&chat.key),
        Some(Access::Read),
        "what a host resume starts from is not moved by a refused start"
    );
    assert_eq!(world.listed_at(&chat).as_deref(), Some("read"));
    chat.hears_no_level("a running chat");

    // Its next process is the one that starts at the registered level.
    world.end(&chat);
    assert_eq!(world.page_starts(&chat, Some("read")), Ok(Value::Null));
    world.started_at(&chat, Access::Auto, "the next process");
    world.end(&chat);
}

/// Every pair of a level asked and a level registered: the start is at the
/// higher of the two by the host's own ranking, never below the registered
/// one and never below the one asked.
#[test]
fn every_pair_of_asked_and_registered_starts_at_the_higher() {
    use crate::access_request::rank;
    let world = World::new();
    let levels = [
        Access::Read,
        Access::Manual,
        Access::Edits,
        Access::Auto,
        Access::Full,
    ];
    let agent = world.register(None, Access::Read);
    for registered in levels {
        world.register(Some(&agent.id), registered);
        for asked in levels {
            let chat = world.chat_of(&agent, Some(asked.as_env()));
            assert_eq!(world.host_starts(&chat, asked), Ok(()));
            let higher = if rank(asked) >= rank(registered) {
                asked
            } else {
                registered
            };
            world.door_started_at(
                &chat,
                higher,
                &format!("asked {asked:?}, registered {registered:?}"),
            );
            world.end(&chat);
        }
    }
}

/// A ledger that cannot be read does not say "not a worker": the chat is
/// nobody's to raise, and the start fails closed with no process.
#[test]
fn a_ledger_that_cannot_be_read_raises_nothing_and_the_start_fails_closed() {
    let mut world = World::new();
    let agent = world.register(None, Access::Full);
    let chat = world.chat_of(&agent, Some("read"));
    assert_eq!(
        world.chats().registered_level(&chat.key, &chat.key),
        Some(Access::Full),
        "with a ledger that reads, the chat is its agent's"
    );

    std::fs::write(
        crate::profile::profile_dir().join("orchestrations.json"),
        b"{ not a ledger",
    )
    .unwrap();
    world.restart();
    assert!(world.svc.orchestrations.is_worker_chat(&chat.key).is_err());

    assert_eq!(
        world.chats().registered_level(&chat.key, &chat.key),
        None,
        "what is unknown is not read as not a worker"
    );
    let refused = world
        .host_starts(&chat, Access::Read)
        .expect_err("no process is started on a ledger that cannot be read");
    assert!(
        refused.contains("could not be read"),
        "the refusal says why: {refused}"
    );
    assert_eq!(world.runs_at(&chat), None, "no process");
    assert_eq!(
        world.listed_at(&chat).as_deref(),
        Some("read"),
        "and the index entry is as it was"
    );
    chat.hears_no_level("an unreadable ledger");
}

/// The raise is the agent's CURRENT scope's to give: a global agent, or one
/// whose project is the chat's. An agent moved to another project is no
/// authority for the chat it left there, which is started as asked and
/// saved by its page like any other chat. The chat is still that agent's
/// conversation.
#[test]
fn an_agent_moved_to_another_project_does_not_raise_the_chat_it_left() {
    let world = World::new();
    // The chat's lead record and its index entry both say p1.
    let agent = world.register(None, Access::Auto);
    let chat = world.chat_of(&agent, Some("read"));
    let moved = |project: Option<&str>| {
        world.register_in("Vesper", Some(&agent.id), Access::Auto, project);
    };

    // A global agent: raised.
    assert_eq!(world.host_starts(&chat, Access::Read), Ok(()));
    world.door_started_at(&chat, Access::Auto, "a global agent");
    world.end(&chat);

    // An agent of the chat's own project: raised.
    moved(Some("p1"));
    world.page_saves(&chat, "read");
    assert_eq!(world.host_starts(&chat, Access::Read), Ok(()));
    world.door_started_at(&chat, Access::Auto, "an agent of the chat's project");
    world.end(&chat);

    // Moved to p2: as asked, and the entry is the page's to save.
    moved(Some("p2"));
    assert_eq!(
        crate::team::lead_for_chat(&world.team, &chat.key)
            .unwrap()
            .expect("the lead record is kept")
            .project_id,
        "p1"
    );
    assert_eq!(
        crate::team::registered_access_of_chat(&world.team, &chat.key),
        Ok(None)
    );
    assert_eq!(world.page_starts(&chat, Some("read")), Ok(Value::Null));
    world.runs_as(&chat, Access::Read, "an agent moved to another project");
    assert_eq!(
        world.listed_at(&chat).as_deref(),
        Some("auto"),
        "the host does not write the entry of a chat it does not raise"
    );
    world.page_saves(&chat, "manual");
    assert_eq!(world.listed_at(&chat).as_deref(), Some("manual"));
    // Only the raise is scoped: it is still that agent's conversation.
    assert!(crate::team::identity(&world.team, &chat.key, None).is_ok());
    world.end(&chat);

    // Back in p1, with the index listing the chat under another project
    // than its lead record names: two sources that disagree raise nothing.
    moved(Some("p1"));
    world.page_saves_in(&chat, "read", "p2");
    assert_eq!(
        crate::team::registered_access_of_chat(&world.team, &chat.key)
            .unwrap()
            .map(|registered| registered.access),
        Some(Access::Auto),
        "the roster alone would raise it"
    );
    assert_eq!(world.host_starts(&chat, Access::Read), Ok(()));
    assert_eq!(
        world.runs_at(&chat),
        Some(Access::Read),
        "the index and the lead record disagree"
    );
    world.end(&chat);

    // A global agent's scope covers both, so neither project is asked.
    moved(None);
    assert_eq!(world.host_starts(&chat, Access::Read), Ok(()));
    world.door_started_at(&chat, Access::Auto, "a global agent, whatever the project");
    world.end(&chat);

    // An index that cannot be read is not "listed under the right project":
    // a scoped agent raises nothing, and a global one is not asked.
    moved(Some("p1"));
    world.page_saves_in(&chat, "auto", "p1");
    let level = || world.chats().registered_level(&chat.key, &chat.key);
    assert_eq!(level(), Some(Access::Auto));
    let index = crate::transcript::chats_dir().unwrap().join("index.json");
    let kept = std::fs::read(&index).unwrap();
    std::fs::write(&index, b"{ not an index").unwrap();
    assert_eq!(level(), None, "a scoped agent, with no index to ask");
    moved(None);
    assert_eq!(level(), Some(Access::Auto), "a global agent");
    std::fs::write(&index, kept).unwrap();
}

/// The host writes the level into the index entry of a registered agent's
/// own conversation, and into no other chat's.
#[test]
fn the_host_writes_the_index_level_of_an_agents_own_chat_and_of_no_other() {
    let world = World::new();
    // Nobody's chat, started as asked: its entry is its page's to save, and
    // goes on saying what the page last saved.
    let plain = world.plain(Some("auto"));
    assert_eq!(world.page_starts(&plain, Some("read")), Ok(Value::Null));
    world.runs_as(&plain, Access::Read, "an ordinary chat");
    assert_eq!(world.listed_at(&plain).as_deref(), Some("auto"));
    world.end(&plain);

    let agent = world.register(None, Access::Auto);
    // Raised: the entry says the level the process was started at.
    let raised = world.chat_of(&agent, Some("read"));
    assert_eq!(world.page_starts(&raised, Some("read")), Ok(Value::Null));
    world.started_at(&raised, Access::Auto, "raised");
    world.end(&raised);

    // Not raised, and the entry named another level: written all the same,
    // because the entry is the host's.
    let higher = world.chat_of(&agent, Some("read"));
    assert_eq!(world.page_starts(&higher, Some("full")), Ok(Value::Null));
    world.started_at(&higher, Access::Full, "asked above the registered level");
    world.end(&higher);

    // An entry with no level means read, and is not written to say so.
    world.register(Some(&agent.id), Access::Read);
    let bare = world.chat_of(&agent, None);
    assert_eq!(world.page_starts(&bare, Some("read")), Ok(Value::Null));
    assert_eq!(world.runs_at(&bare), Some(Access::Read));
    assert_eq!(world.listed_at(&bare), None);
    world.end(&bare);
}

/// For a registered agent's own conversation a page's save never changes
/// the entry's level: the host wrote it at the start and writes it again
/// when `chat_set_access` takes hold, with no page's save in between.
#[test]
fn a_page_save_never_changes_the_level_of_an_agents_own_chat() {
    let world = World::new();
    let agent = world.register(None, Access::Auto);
    let chat = world.chat_of(&agent, Some("read"));
    assert_eq!(world.page_starts(&chat, Some("read")), Ok(Value::Null));
    world.started_at(&chat, Access::Auto, "the raised start");

    // The save that was already on its way, with the level asked for.
    world.page_saves(&chat, "read");
    world.started_at(&chat, Access::Auto, "after the late save");
    // Everything else the save carries is taken.
    let entry = crate::chat_index::list()
        .into_iter()
        .find(|meta| meta.id == chat.id)
        .unwrap();
    assert_eq!(entry.updated_at, 200, "the save itself was made");

    // The person lowers the running chat: the host writes the entry, with
    // no save from any page.
    world.person_picks(&chat, "edits");
    assert_eq!(world.runs_at(&chat), Some(Access::Edits));
    assert_eq!(world.listed_at(&chat).as_deref(), Some("edits"));
    // A tab that still holds an older or a higher level changes nothing.
    world.page_saves(&chat, "full");
    assert_eq!(world.listed_at(&chat).as_deref(), Some("edits"));
    // The host's own writes are not made under the session's lock, so the
    // start's write of Auto may land after the lowering's write of Accept
    // edits. Each looks at the process again after it wrote, and the entry
    // ends at the level the process runs at.
    world.chats().index_follows_level(&chat.key, Access::Auto);
    assert_eq!(world.listed_at(&chat).as_deref(), Some("edits"));

    // The host's own write did not land (a disk that was full): the next
    // save of the entry while the process lives puts the process's level
    // there, whatever that save names.
    crate::chat_index::set_access(&chat.id, "read").unwrap();
    world.page_saves(&chat, "manual");
    assert_eq!(world.listed_at(&chat).as_deref(), Some("edits"));

    // The process is gone. A tab that held its old level all along saves
    // it: the entry keeps the level it has.
    world.end(&chat);
    world.page_saves(&chat, "read");
    assert_eq!(world.listed_at(&chat).as_deref(), Some("edits"));
    world.page_saves(&chat, "full");
    assert_eq!(world.listed_at(&chat).as_deref(), Some("edits"));
    chat.hears_no_level("a page's saves");

    // A save that MAKES the entry takes the level it carries: there is
    // nothing to keep.
    let fresh = world.unlisted();
    world.is_of(&fresh, &agent);
    world.page_saves(&fresh, "edits");
    assert_eq!(world.listed_at(&fresh).as_deref(), Some("edits"));

    // Unless a process is already running, started before its first save:
    // the entry it makes says the process's level.
    let started = world.unlisted();
    world.is_of(&started, &agent);
    assert_eq!(world.host_starts(&started, Access::Read), Ok(()));
    assert_eq!(world.runs_at(&started), Some(Access::Auto));
    world.page_saves(&started, "read");
    assert_eq!(world.listed_at(&started).as_deref(), Some("auto"));
    world.end(&started);
}

/// What the stale save used to cost (review of a4d072b, open item 2): a
/// coordinator's entry put back to read after its process ended, so that
/// the index and the ledger disagreed and the next notification after a
/// restart was refused. The entry is the host's, so it is delivered.
#[test]
fn a_stale_tab_cannot_put_a_coordinators_entry_back_after_its_process_ended() {
    let mut world = World::new();
    let agent = world.register(None, Access::Auto);
    let chat = world.chat_of(&agent, Some("read"));
    assert_eq!(
        Path::NotificationAfterRestart.start(&mut world, &chat),
        Ok(())
    );
    world.started_at(&chat, Access::Auto, "the first notification");
    world.end(&chat);

    world.page_saves(&chat, "read");
    assert_eq!(world.listed_at(&chat).as_deref(), Some("auto"));

    let run = world.svc.orchestrations.snapshot(None).unwrap().runs[0].clone();
    world.restart();
    assert_eq!(
        deliver_orchestration_notification(
            world.chats().clone(),
            &notification(&run.id, &chat.key),
            Default::default(),
        ),
        Ok(true),
        "the index and the ledger still agree"
    );
    world.started_at(&chat, Access::Auto, "the notification after the restart");
    world.end(&chat);
}

/// An ordinary chat is saved by its page exactly as before there was a rule
/// about levels, and the host says nothing about its level. This is the
/// sequence that failed the review of a4d072b (R1), on the host's side:
/// the chat runs at Auto, the person picks Plan, a save that was already on
/// its way names Auto, and the process ends.
#[test]
fn an_ordinary_chat_is_saved_by_its_page_as_before_and_no_level_is_said() {
    let world = World::new();
    let chat = world.plain(Some("auto"));
    assert_eq!(world.page_starts(&chat, Some("auto")), Ok(Value::Null));
    world.runs_as(&chat, Access::Auto, "started as asked");

    world.person_picks(&chat, "read");
    assert_eq!(world.runs_at(&chat), Some(Access::Read));
    assert_eq!(
        world.listed_at(&chat).as_deref(),
        Some("auto"),
        "the host does not write an ordinary chat's entry: its page does"
    );

    // The late save, naming the level the page held when it was queued.
    world.page_saves(&chat, "auto");
    assert_eq!(
        world.listed_at(&chat).as_deref(),
        Some("auto"),
        "the save stands, as it always did"
    );
    assert_eq!(
        world.runs_at(&chat),
        Some(Access::Read),
        "and the process keeps the level the person picked"
    );
    // Whatever a page saves is what the entry says, process or not: the
    // page orders its own writes.
    for level in ["full", "read", "manual"] {
        world.page_saves(&chat, level);
        assert_eq!(world.listed_at(&chat).as_deref(), Some(level));
    }
    world.page_saves(&chat, "auto");

    world.end(&chat);
    chat.hears_no_level("the whole sequence");
    assert_eq!(world.listed_at(&chat).as_deref(), Some("auto"));
    world.page_saves(&chat, "read");
    assert_eq!(world.listed_at(&chat).as_deref(), Some("read"));

    // Its next process is started exactly as asked, and the entry is left
    // to the page.
    assert_eq!(world.page_starts(&chat, Some("edits")), Ok(Value::Null));
    world.runs_as(&chat, Access::Edits, "the next process");
    assert_eq!(world.listed_at(&chat).as_deref(), Some("read"));
    world.end(&chat);

    // The same for a chat whose agent was removed: nobody's to raise, so
    // its page's to save.
    let gone = world.register_as("Orrin", None, Access::Full);
    let orphan = world.chat_of(&gone, Some("read"));
    crate::team::delete(&world.team, &gone.id).expect("the agent is removed");
    assert_eq!(world.page_starts(&orphan, Some("read")), Ok(Value::Null));
    world.page_saves(&orphan, "auto");
    assert_eq!(world.listed_at(&orphan).as_deref(), Some("auto"));
    orphan.hears_no_level("a removed agent's chat");
    world.end(&orphan);
}
