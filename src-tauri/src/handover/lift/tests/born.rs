//! A record this build makes, confirms or finishes is born looked at, and
//! only a record an earlier build left is the lift's.
//!
//! The route is asked for, confirmed and recovered by the real functions,
//! on the profile's own handovers, roster, chat index and ledger. Only the
//! agent's process is a stand-in (`FakeHost`), and what it would have saved
//! to the chat index is saved there (`Desk::index_follows`).
use super::*;
use crate::handover::tests::{mend_store, project, repo, scratch, FakeHost};
use crate::handover::{confirm, get, recover, request, route, Ask, Brief, Handover, Source, Start};

/// A front desk on the world's own roster, and a project with a repository.
struct Desk {
    host: FakeHost,
    desk: TeamAgent,
    _root: crate::test_dir::TestDir,
}

impl Desk {
    /// The front desk proposes a discussion with `agent`.
    fn asks(&self, world: &World, agent: &str) -> Handover {
        self.asks_for(world, agent, route::Purpose::Discuss)
    }

    fn asks_for(&self, world: &World, agent: &str, purpose: route::Purpose) -> Handover {
        route::request(
            &world.store,
            &self.host,
            route::RouteSource {
                chat_key: "chat:desk".into(),
                desk: self.desk.clone(),
                origin: crate::question_store::test_origin("chat:desk"),
            },
            route::RouteAsk {
                agent: agent.into(),
                project: None,
                brief: "Talk the next series through with me.".into(),
                attachments: Vec::new(),
                purpose,
                request_id: uuid::Uuid::new_v4().to_string(),
            },
        )
        .expect("the route is proposed")
    }

    /// What the host's own `save_index` does with each entry a start saved.
    fn index_follows(&self) {
        for meta in self.host.saved.lock().unwrap().drain(..) {
            crate::chat_index::upsert(meta).expect("the index is saved");
        }
    }

    /// The chat a record opened.
    fn chat_of(&self, record: &Handover) -> Chat {
        let key = record.target_chat_key.clone().expect("it names its chat");
        Chat {
            id: key.strip_prefix("chat:").unwrap().to_owned(),
            key,
            record: record.id.clone(),
        }
    }

    /// The person confirms the card, and the chat is started.
    fn confirms(&self, world: &World, id: &str) -> Chat {
        let opened = confirm(&world.store, id, &self.host).expect("the chat is opened");
        self.index_follows();
        self.chat_of(&opened)
    }

    /// The levels chats were started at, in order.
    fn started_at(&self) -> Vec<Access> {
        let starts = self.host.starts.lock().unwrap();
        starts.iter().map(|start| start.access).collect()
    }
}

impl World {
    fn desk(&self) -> Desk {
        let root = scratch("lift-route");
        let app = repo(&root, "app");
        let desk = team::create_front_desk(&self.team, team::FrontDeskDraft::default())
            .expect("a front desk");
        Desk {
            host: FakeHost {
                projects: vec![project("p1", "Project", &[&app])],
                team: self.team.clone(),
                root: root.to_path_buf(),
                ..FakeHost::default()
            },
            desk,
            _root: root,
        }
    }

    /// A record's own JSON, as the store holds it.
    fn raw(&self, id: &str) -> Value {
        let stored: Value = serde_json::from_slice(&fs::read(&self.store).unwrap()).unwrap();
        stored["handovers"][id].clone()
    }

    fn rewrite(&self, id: &str, edit: impl FnOnce(&mut Value)) {
        let mut stored: Value = serde_json::from_slice(&fs::read(&self.store).unwrap()).unwrap();
        edit(&mut stored["handovers"][id]);
        fs::write(&self.store, serde_json::to_vec_pretty(&stored).unwrap()).unwrap();
    }

    /// The record as the build before this one stored a discussion: read
    /// access whatever its agent was registered at, and no word on whether
    /// the lift had looked, then `edit`.
    fn as_an_earlier_build_left(&self, id: &str, edit: impl FnOnce(&mut Value)) {
        self.rewrite(id, |record| {
            record["settings"]["access"] = json!("read");
            record.as_object_mut().unwrap().remove("liftSettled");
            edit(record);
        });
    }

    /// Everything the lift asks of a chat holds for `chat`, so only its
    /// record's mark is left to decide.
    fn would_be_lifted_but_for_the_mark(&self, chat: &Chat, agent: &TeamAgent) {
        let record = get(&self.store, &chat.record).unwrap();
        assert_eq!(record.kind, Kind::Route);
        assert_eq!(record.status, Status::Confirmed);
        assert!(record.route.as_ref().unwrap().discuss);
        assert_eq!(record.settings.access, Access::Read);
        assert_eq!(record.to.agent_id.as_deref(), Some(agent.id.as_str()));
        let lead = team::lead_for_chat(&self.team, &chat.key).unwrap().unwrap();
        assert_eq!(lead.lead_id, agent.id);
        assert_eq!(self.listed_at(chat).as_deref(), Some("read"));
    }

    /// The same chat, its record no longer saying it was looked at, IS
    /// lifted: nothing but the mark held the pass back.
    fn only_the_mark_held_it(&self, chat: &Chat, to: &str) {
        self.rewrite(&chat.record, |record| {
            record.as_object_mut().unwrap().remove("liftSettled");
        });
        assert_eq!(self.pass().lifted, 1, "it was the lift's to take");
        assert_eq!(self.listed_at(chat).as_deref(), Some(to));
    }
}

/// The agent's first turn is on record under `key`, as a start that went
/// through leaves it.
fn first_turn(record: &Handover, key: &str, access: Access) -> Start {
    Start {
        key: key.into(),
        cwd: "/tmp/project".into(),
        agent: ChatAgent::Claude,
        model: Some("sonnet".into()),
        access,
        effort: None,
        prompt: "Talk the next series through with me.".into(),
        extra_dirs: Vec::new(),
        env: Default::default(),
        turn_id: record.start_turn_id(),
        images: Vec::new(),
    }
}

/// How a record left `Starting`, whose chat had started, becomes confirmed.
#[derive(Clone, Copy, Debug)]
enum Flip {
    /// The startup recovery.
    Recover,
    /// The person's Try again on its card.
    Confirm,
}

impl Flip {
    fn confirms(self, world: &World, desk: &Desk, id: &str) {
        match self {
            Flip::Recover => {
                let finished = recover(&world.store, &desk.host).unwrap();
                assert_eq!(finished, [id.to_owned()]);
            }
            Flip::Confirm => {
                confirm(&world.store, id, &desk.host).unwrap();
            }
        }
    }
}

/// N3. A discussion this build opens for an agent registered at read runs
/// at read because that is the agent's level: the product narrowed nothing.
/// Raising the agent later raises no chat.
#[test]
fn a_discussion_this_build_opens_at_its_agents_read_is_never_raised_later() {
    let mut world = World::new();
    let agent = world.register("Vesper", Access::Read, Some("p1"));
    let desk = world.desk();
    let asked = desk.asks(&world, "Vesper");
    let chat = desk.confirms(&world, &asked.id);
    assert_eq!(desk.started_at(), [Access::Read]);
    world.remembers_start(&chat, Access::Read);
    world.would_be_lifted_but_for_the_mark(&chat, &agent);
    assert_eq!(world.raw(&chat.record)["liftSettled"], true);

    // The person raises the agent, and the server is started again.
    world.save_agent(Some(&agent.id), "Vesper", Access::Auto, Some("p1"));
    world.restart();
    let entry = world.entry(&chat);
    let record = world.raw(&chat.record);
    let before = world.files();

    assert_eq!(
        world.pass(),
        Tally::default(),
        "the record is not looked at"
    );

    assert_eq!(world.files(), before, "and nothing is written");
    assert_eq!(world.entry(&chat), entry);
    assert_eq!(world.listed_at(&chat).as_deref(), Some("read"));
    assert_eq!(world.remembered_at(&chat), Some(Access::Read));
    assert_eq!(world.raw(&chat.record), record);
    // At every later start too.
    world.restart();
    world.is_done();

    world.only_the_mark_held_it(&chat, "auto");
}

#[test]
fn every_record_this_build_makes_is_stored_as_looked_at() {
    let world = World::new();
    world.register("Vesper", Access::Edits, Some("p1"));
    let desk = world.desk();

    // A route, whatever it is for.
    for purpose in [route::Purpose::Discuss, route::Purpose::Work] {
        let asked = desk.asks_for(&world, "Vesper", purpose);
        assert!(asked.lift_settled);
        assert_eq!(asked.status, Status::Pending);
        assert_eq!(world.raw(&asked.id)["liftSettled"], true);
        let shown = serde_json::to_value(asked.public()).unwrap();
        assert_eq!(shown.get("liftSettled"), None, "the page is not sent it");
    }

    // A handover from one chat to an agent.
    let handed = request(
        &world.store,
        &desk.host,
        Source {
            chat_key: "chat:source".into(),
            title: "Fix the login bug".into(),
            project_id: Some("p1".into()),
            lead: None,
            origin: crate::question_store::test_origin("chat:source"),
            worker: false,
            cwd: None,
            coordinating: None,
        },
        Ask {
            recipient: "Vesper".into(),
            project: None,
            repository: None,
            request_id: "r1".into(),
            brief: Brief {
                objective: "Finish the login fix".into(),
                done_so_far: "Found the bug".into(),
                remaining: "Write the test".into(),
                ..Brief::default()
            },
        },
    )
    .expect("the handover is proposed");
    assert_eq!(handed.kind, Kind::Handover);
    assert!(handed.lift_settled);
    assert_eq!(world.raw(&handed.id)["liftSettled"], true);
    let shown = serde_json::to_value(handed.public()).unwrap();
    assert_eq!(shown.get("liftSettled"), None);
}

/// The field is new: a record that does not say is an earlier build's, and
/// that is the only way a record reads as not looked at.
#[test]
fn a_record_that_does_not_say_is_an_earlier_builds() {
    let world = World::new();
    let agent = world.register("Vesper", Access::Auto, None);
    let chat = world.discussion(&agent);
    assert_eq!(world.raw(&chat.record).get("liftSettled"), None);

    let record = get(&world.store, &chat.record).unwrap();
    assert!(!record.lift_settled);
    // Not looked at is never written, so the record stays as it was left.
    let written = serde_json::to_value(&record).unwrap();
    assert_eq!(written.get("liftSettled"), None);
    let mut looked = record;
    looked.lift_settled = true;
    assert_eq!(serde_json::to_value(&looked).unwrap()["liftSettled"], true);
}

/// A card an earlier build drew, confirmed under this one: `prepare` reads
/// the settings from the roster, so the chat is this build's to have opened.
#[test]
fn an_earlier_builds_pending_discussion_confirmed_by_this_build_is_never_looked_at() {
    for registered in [Access::Read, Access::Edits] {
        let mut world = World::new();
        let agent = world.register("Vesper", registered, Some("p1"));
        let desk = world.desk();
        let asked = desk.asks(&world, "Vesper");
        world.as_an_earlier_build_left(&asked.id, |_| {});
        let left = world.raw(&asked.id);
        assert_eq!(left["status"], "pending");
        assert_eq!(left["settings"]["access"], "read");
        assert_eq!(left.get("liftSettled"), None);

        let chat = desk.confirms(&world, &asked.id);

        let level = crate::orchestration::access_id(registered);
        assert_eq!(desk.started_at(), [registered], "the registered level");
        let stored = world.raw(&chat.record);
        assert_eq!(stored["status"], "confirmed");
        assert_eq!(stored["settings"]["access"], level);
        assert_eq!(stored["liftSettled"], true, "stored as looked at");
        assert_eq!(world.listed_at(&chat).as_deref(), Some(level));

        // No later start looks at it, whatever the agent is registered at.
        world.restart();
        world.is_done();
        world.save_agent(Some(&agent.id), "Vesper", Access::Full, Some("p1"));
        world.restart();
        world.is_done();
        assert_eq!(world.listed_at(&chat).as_deref(), Some(level));
        assert_eq!(world.raw(&chat.record), stored);

        if registered == Access::Read {
            world.would_be_lifted_but_for_the_mark(&chat, &agent);
            world.only_the_mark_held_it(&chat, "full");
        }
    }
}

/// A route an earlier build's person confirmed, cut by the restart before
/// its chat started: `recover` starts it (`finish_route`), on the roster's
/// settings, so it is this build's too.
#[test]
fn an_earlier_builds_route_this_build_finishes_starting_is_never_looked_at() {
    let mut world = World::new();
    let agent = world.register("Vesper", Access::Read, Some("p1"));
    let desk = world.desk();
    let asked = desk.asks(&world, "Vesper");
    let key = format!("chat:lift-{}", uuid::Uuid::new_v4().simple());
    world.as_an_earlier_build_left(&asked.id, |record| {
        record["status"] = json!("starting");
        record["decidedAt"] = json!(2);
        record["targetChatKey"] = json!(key);
    });

    // This start's pass runs first: a record that is starting is not its.
    let before = world.files();
    assert_eq!(world.pass(), Tally::default());
    assert_eq!(world.files(), before);

    Flip::Recover.confirms(&world, &desk, &asked.id);
    desk.index_follows();

    assert_eq!(desk.started_at(), [Access::Read]);
    let stored = world.raw(&asked.id);
    assert_eq!(stored["status"], "confirmed");
    assert_eq!(stored["liftSettled"], true, "stored as looked at");
    let chat = desk.chat_of(&get(&world.store, &asked.id).unwrap());
    assert_eq!(chat.key, key);

    world.save_agent(Some(&agent.id), "Vesper", Access::Auto, Some("p1"));
    world.restart();
    world.is_done();
    assert_eq!(world.listed_at(&chat).as_deref(), Some("read"));

    world.would_be_lifted_but_for_the_mark(&chat, &agent);
    world.only_the_mark_held_it(&chat, "auto");
}

/// A route an earlier build confirmed and started at read, its record cut
/// at `Starting` by the restart. Nothing reads the roster for it: it is
/// only confirmed, still saying nothing, and the pass of the start after
/// that lifts it.
#[test]
fn an_earlier_builds_started_route_is_confirmed_unlooked_at_and_lifted_at_the_next_start() {
    for flip in [Flip::Recover, Flip::Confirm] {
        let mut world = World::new();
        let agent = world.register("Vesper", Access::Auto, Some("p1"));
        let desk = world.desk();
        let asked = desk.asks(&world, "Vesper");
        let id = format!("lift-{}", uuid::Uuid::new_v4().simple());
        let key = format!("chat:{id}");
        world.as_an_earlier_build_left(&asked.id, |record| {
            record["status"] = json!("starting");
            record["decidedAt"] = json!(2);
            record["targetChatKey"] = json!(key);
        });
        // That build had started the chat, at read.
        let record = get(&world.store, &asked.id).unwrap();
        let started = first_turn(&record, &key, Access::Read);
        desk.host.starts.lock().unwrap().push(started);
        world.list_chat(&id, Some("read"));
        team::record_lead(&world.team, &key, &agent, "p1", false).unwrap();
        let chat = desk.chat_of(&record);
        world.remembers_start(&chat, Access::Read);

        // This start's pass comes first, and the record is not confirmed.
        let before = world.files();
        assert_eq!(world.pass(), Tally::default(), "{flip:?}");
        assert_eq!(world.files(), before, "{flip:?}");

        flip.confirms(&world, &desk, &asked.id);

        let stored = world.raw(&asked.id);
        assert_eq!(stored["status"], "confirmed", "{flip:?}");
        assert_eq!(stored["settings"]["access"], "read", "{flip:?}");
        assert_eq!(stored.get("liftSettled"), None, "{flip:?}: still unsaid");
        assert_eq!(desk.started_at(), [Access::Read], "{flip:?}: one start");
        assert!(desk.host.saved.lock().unwrap().is_empty(), "{flip:?}");
        assert_eq!(world.listed_at(&chat).as_deref(), Some("read"), "{flip:?}");

        // The next start.
        world.restart();
        assert_eq!(world.pass().lifted, 1, "{flip:?}");
        assert_eq!(world.listed_at(&chat).as_deref(), Some("auto"), "{flip:?}");
        assert_eq!(world.remembered_at(&chat), Some(Access::Auto), "{flip:?}");
        assert_eq!(world.raw(&asked.id)["liftSettled"], true, "{flip:?}");
        world.is_done();
    }
}

/// A route this build confirmed and started, its record cut at `Starting`
/// (the save after the start failed, then a restart): it is confirmed with
/// the mark it was born with, and is never lifted.
#[test]
fn a_route_this_build_started_and_a_restart_cut_is_confirmed_as_looked_at() {
    for flip in [Flip::Recover, Flip::Confirm] {
        let mut world = World::new();
        let agent = world.register("Vesper", Access::Read, Some("p1"));
        let desk = world.desk();
        let asked = desk.asks(&world, "Vesper");
        *desk.host.break_store.lock().unwrap() = Some(world.store.clone());
        confirm(&world.store, &asked.id, &desk.host).expect_err("its record is not saved");
        mend_store(&world.store);
        desk.index_follows();
        assert_eq!(desk.started_at(), [Access::Read]);
        let cut = world.raw(&asked.id);
        assert_eq!(cut["status"], "starting", "{flip:?}");
        assert_eq!(cut["liftSettled"], true, "{flip:?}");

        // The restart: the pass, then the record is confirmed.
        world.restart();
        let before = world.files();
        assert_eq!(world.pass(), Tally::default(), "{flip:?}");
        assert_eq!(world.files(), before, "{flip:?}");
        flip.confirms(&world, &desk, &asked.id);

        let stored = world.raw(&asked.id);
        assert_eq!(stored["status"], "confirmed", "{flip:?}");
        assert_eq!(stored["liftSettled"], true, "{flip:?}: as it was born");
        assert_eq!(desk.started_at(), [Access::Read], "{flip:?}: one start");
        let chat = desk.chat_of(&get(&world.store, &asked.id).unwrap());

        // The agent is raised: no later start lifts the chat.
        world.save_agent(Some(&agent.id), "Vesper", Access::Auto, Some("p1"));
        world.restart();
        world.is_done();
        assert_eq!(world.listed_at(&chat).as_deref(), Some("read"), "{flip:?}");

        world.would_be_lifted_but_for_the_mark(&chat, &agent);
        world.only_the_mark_held_it(&chat, "auto");
    }
}
