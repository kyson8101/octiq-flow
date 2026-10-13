//! The one-time lift, on the stores a server loads from its profile folder:
//! the handovers, the roster, the chat index and the run ledger are the
//! real ones, in a profile of the test's own. A record is written the way
//! the build before this one left it: a confirmed discussion at read.
use std::fs;
use std::path::PathBuf;

use serde_json::{json, Value};

use super::*;
use crate::agent_chat::{ChatAgent, StartContext};
use crate::profile::tests::{everything_in, Home};
use crate::team::TeamDraft;

mod born;

struct World {
    ledger: OrchestrationStore,
    store: PathBuf,
    team: PathBuf,
    _process: crate::profile::Started,
    home: Home,
}

/// One chat a discussion opened, and the record that opened it.
struct Chat {
    id: String,
    key: String,
    record: String,
}

impl World {
    fn new() -> Self {
        let home = Home::with_a_configured_base();
        let process = crate::profile::started_in(&home.dir);
        let profile = crate::profile::profile_dir();
        Self {
            ledger: OrchestrationStore::load_profile(),
            store: super::super::default_path(),
            team: profile.join("team.json"),
            _process: process,
            home,
        }
    }

    /// The server is stopped and started again: the ledger is read back.
    fn restart(&mut self) {
        self.ledger = OrchestrationStore::load_profile();
    }

    fn register(&self, name: &str, access: Access, project: Option<&str>) -> TeamAgent {
        self.save_agent(None, name, access, project)
    }

    fn save_agent(
        &self,
        id: Option<&str>,
        name: &str,
        access: Access,
        project: Option<&str>,
    ) -> TeamAgent {
        team::save(
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
        .expect("the agent is saved")
    }

    /// The index lists the chat `id` at `access`.
    fn list_chat(&self, id: &str, access: Option<&str>) {
        crate::chat_index::upsert(
            serde_json::from_value(json!({
                "id": id,
                "projectId": "p1",
                "title": "A discussion",
                "updatedAt": 100,
                "cwd": "/tmp/project",
                "sessionId": format!("session-{id}"),
                "access": access,
            }))
            .unwrap(),
        )
        .unwrap();
    }

    /// A record as the build before this one wrote it, changed by `edit`.
    fn write_record(
        &self,
        key: Option<&str>,
        agent: &TeamAgent,
        edit: impl FnOnce(&mut Value),
    ) -> String {
        let id = format!("handover_{}", uuid::Uuid::new_v4().simple());
        let mut record = json!({
            "kind": "route",
            "route": { "message": "Let us talk it through.", "discuss": true },
            "id": id,
            "requestId": format!("request-{id}"),
            "sourceChatKey": "chat:front-desk",
            "from": { "name": "Front desk" },
            "to": { "agentId": agent.id, "name": agent.name },
            "settings": { "agent": "claude", "model": "sonnet", "access": "read" },
            "destination": {
                "projectId": "p1", "projectName": "Project", "repository": "/tmp/project",
            },
            "workspace": { "mode": "folder", "path": "/tmp/project" },
            "brief": { "objective": "Talk it through" },
            "status": "confirmed",
            "createdAt": 1,
            "decidedAt": 2,
            "targetChatKey": key,
            "notice": "tool",
            "requestDigest": "digest",
        });
        edit(&mut record);
        let mut stored: Value = fs::read(&self.store)
            .ok()
            .map(|bytes| serde_json::from_slice(&bytes).unwrap())
            .unwrap_or_else(|| json!({ "handovers": {} }));
        stored["handovers"][&id] = record;
        fs::write(&self.store, serde_json::to_vec_pretty(&stored).unwrap()).unwrap();
        id
    }

    /// What an earlier discussion left: `agent`'s own conversation, listed
    /// at read, opened by a confirmed discussion whose settings say read.
    fn discussion(&self, agent: &TeamAgent) -> Chat {
        self.discussion_with(agent, |_| {})
    }

    fn discussion_with(&self, agent: &TeamAgent, edit: impl FnOnce(&mut Value)) -> Chat {
        let id = format!("lift-{}", uuid::Uuid::new_v4().simple());
        let key = format!("chat:{id}");
        self.list_chat(&id, Some("read"));
        team::record_lead(&self.team, &key, agent, "p1", false).expect("the chat is the agent's");
        let record = self.write_record(Some(&key), agent, edit);
        Chat { id, key, record }
    }

    /// The chat coordinates a run, so the ledger keeps how it was started.
    fn remembers_start(&self, chat: &Chat, access: Access) {
        self.ledger
            .create_run(
                chat.key.clone(),
                "Ship it".into(),
                "p1".into(),
                "/tmp/project".into(),
                None,
            )
            .expect("a run");
        self.ledger
            .save_resume_context(
                &chat.key,
                StartContext::for_test(ChatAgent::Claude, Some("session")).at(access),
            )
            .expect("the start is saved");
    }

    fn pass(&self) -> Tally {
        self.pass_with(&|_| false).expect("the pass ran")
    }

    fn pass_with(&self, running: &dyn Fn(&str) -> bool) -> Result<Tally, String> {
        run(&self.store, &self.team, &self.ledger, running)
    }

    /// The index entry, in or out of the trash.
    fn entry(&self, chat: &Chat) -> Option<Value> {
        crate::chat_index::list()
            .into_iter()
            .chain(crate::chat_index::deleted())
            .find(|c| c.id == chat.id)
            .map(|c| serde_json::to_value(c).unwrap())
    }

    fn listed_at(&self, chat: &Chat) -> Option<String> {
        self.entry(chat)?["access"].as_str().map(str::to_string)
    }

    fn remembered_at(&self, chat: &Chat) -> Option<Access> {
        self.ledger
            .saved_resume_context(&chat.key)
            .and_then(|start| start.access_level())
    }

    /// The record as it is stored, every field of it, in the form the
    /// store writes one.
    fn record(&self, chat: &Chat) -> Value {
        let stored: Value = serde_json::from_slice(&fs::read(&self.store).unwrap()).unwrap();
        let record: super::super::Handover =
            serde_json::from_value(stored["handovers"][&chat.record].clone()).unwrap();
        serde_json::to_value(record).unwrap()
    }

    /// The record is marked as looked at, and nothing else of it moved: its
    /// settings are what it was confirmed with.
    fn is_marked(&self, chat: &Chat, before: &Value) {
        assert_eq!(before.get("liftSettled"), None, "absent until it is set");
        let mut marked = before.clone();
        marked["liftSettled"] = json!(true);
        assert_eq!(self.record(chat), marked);
        assert_eq!(marked["settings"]["access"], "read");
        // And it reads back as the record it is.
        let record = super::super::get(&self.store, &chat.record).unwrap();
        assert!(record.lift_settled);
        assert_eq!(record.settings.access, Access::Read);
        // The mark is the host's own: the page is not sent it.
        let shown = serde_json::to_value(record.public()).unwrap();
        assert_eq!(shown.get("liftSettled"), None);
        assert_eq!(shown["settings"], marked["settings"]);
    }

    fn files(&self) -> Vec<(String, Vec<u8>)> {
        everything_in(&self.home.profile())
    }

    /// A second pass looks at nothing and writes nothing.
    fn is_done(&self) {
        let before = self.files();
        assert_eq!(self.pass(), Tally::default(), "a second pass does nothing");
        assert_eq!(self.files(), before, "and writes nothing");
    }
}

fn one(why: Left) -> Tally {
    Tally {
        left: [(why, 1)].into(),
        ..Tally::default()
    }
}

fn again(why: Again) -> Tally {
    Tally {
        again: [(why, 1)].into(),
        ..Tally::default()
    }
}

/// The chat is left exactly as it is, its record is marked as looked at
/// and is otherwise as it was confirmed, and the lift never looks again.
fn left_alone(world: &World, chat: &Chat, why: Left) {
    let entry = world.entry(chat);
    let remembered = world.ledger.saved_resume_context(&chat.key);
    let record = world.record(chat);
    assert_eq!(world.pass(), one(why));
    assert_eq!(world.entry(chat), entry, "the chat's entry is untouched");
    assert_eq!(
        world.ledger.saved_resume_context(&chat.key),
        remembered,
        "and so is how it was started"
    );
    world.is_marked(chat, &record);
    world.is_done();
}

#[test]
fn a_discussion_left_at_read_goes_back_to_the_registered_access() {
    for registered in [Access::Manual, Access::Edits, Access::Auto, Access::Full] {
        let mut world = World::new();
        let agent = world.register("Vesper", registered, None);
        let chat = world.discussion(&agent);
        world.remembers_start(&chat, Access::Read);
        let entry = world.entry(&chat).unwrap();
        let record = world.record(&chat);

        assert_eq!(
            world.pass(),
            Tally {
                lifted: 1,
                ..Tally::default()
            }
        );

        let level = crate::orchestration::access_id(registered);
        assert_eq!(world.listed_at(&chat).as_deref(), Some(level));
        assert_eq!(world.remembered_at(&chat), Some(registered));
        world.is_marked(&chat, &record);
        // Nothing else of the entry moved: not its activity, not its title.
        let mut expected = entry;
        expected["access"] = json!(level);
        assert_eq!(world.entry(&chat).unwrap(), expected);
        world.is_done();

        // And all three are on disk: a restart reads the same.
        world.restart();
        assert_eq!(world.remembered_at(&chat), Some(registered));
        assert_eq!(world.listed_at(&chat).as_deref(), Some(level));
        world.is_done();
    }
}

#[test]
fn a_chat_no_run_knows_is_lifted_and_the_ledger_is_not_written() {
    let world = World::new();
    let agent = world.register("Vesper", Access::Auto, None);
    let chat = world.discussion(&agent);
    let ledger = world.home.profile().join("orchestrations.json");
    let before = fs::read(&ledger).ok();

    assert_eq!(world.pass().lifted, 1);

    assert_eq!(world.listed_at(&chat).as_deref(), Some("auto"));
    assert_eq!(world.remembered_at(&chat), None);
    assert_eq!(
        fs::read(&ledger).ok(),
        before,
        "nothing to move, nothing saved"
    );
}

#[test]
fn saved_start_settings_at_another_level_are_not_the_lifts_to_move() {
    let world = World::new();
    let agent = world.register("Vesper", Access::Auto, None);
    let chat = world.discussion(&agent);
    world.remembers_start(&chat, Access::Edits);

    assert_eq!(world.pass().lifted, 1);

    assert_eq!(world.listed_at(&chat).as_deref(), Some("auto"));
    assert_eq!(world.remembered_at(&chat), Some(Access::Edits));
}

#[test]
fn each_chat_is_decided_by_its_own_record() {
    let world = World::new();
    let auto = world.register("Vesper", Access::Auto, None);
    let full = world.register("Orrin", Access::Full, None);
    let reader = world.register("Quill", Access::Read, None);
    let lifted = world.discussion(&auto);
    let higher = world.discussion(&full);
    let changed = world.discussion(&auto);
    world.list_chat(&changed.id, Some("full"));
    let at_read = world.discussion(&reader);

    assert_eq!(
        world.pass(),
        Tally {
            lifted: 2,
            left: [(Left::LevelChanged, 1), (Left::RegisteredAtRead, 1)].into(),
            again: Default::default(),
        }
    );

    assert_eq!(world.listed_at(&lifted).as_deref(), Some("auto"));
    assert_eq!(world.listed_at(&higher).as_deref(), Some("full"));
    assert_eq!(world.listed_at(&changed).as_deref(), Some("full"));
    assert_eq!(world.listed_at(&at_read).as_deref(), Some("read"));
    world.is_done();
}

#[test]
fn a_chat_whose_agent_was_removed_is_left() {
    let world = World::new();
    let agent = world.register("Vesper", Access::Auto, None);
    let chat = world.discussion(&agent);
    team::delete(&world.team, &agent.id).expect("the agent is removed");

    left_alone(&world, &chat, Left::AgentRemoved);

    // One time: an agent of that name registered later lifts nothing.
    world.register("Vesper", Access::Full, None);
    world.is_done();
    assert_eq!(world.listed_at(&chat).as_deref(), Some("read"));
}

#[test]
fn a_chat_whose_lead_record_names_another_agent_is_left() {
    let world = World::new();
    let agent = world.register("Vesper", Access::Auto, None);
    let other = world.register("Orrin", Access::Full, None);
    let id = format!("lift-{}", uuid::Uuid::new_v4().simple());
    let key = format!("chat:{id}");
    world.list_chat(&id, Some("read"));
    team::record_lead(&world.team, &key, &other, "p1", false).unwrap();
    let record = world.write_record(Some(&key), &agent, |_| {});
    let chat = Chat { id, key, record };

    left_alone(&world, &chat, Left::AnotherAgents);
}

#[test]
fn a_chat_with_no_lead_record_is_left() {
    let world = World::new();
    let agent = world.register("Vesper", Access::Auto, None);
    let id = format!("lift-{}", uuid::Uuid::new_v4().simple());
    let key = format!("chat:{id}");
    world.list_chat(&id, Some("read"));
    let record = world.write_record(Some(&key), &agent, |_| {});
    let chat = Chat { id, key, record };

    left_alone(&world, &chat, Left::AnotherAgents);
}

#[test]
fn a_chat_whose_agent_now_works_in_another_project_is_left() {
    let world = World::new();
    let agent = world.register("Vesper", Access::Auto, Some("p1"));
    let chat = world.discussion(&agent);
    world.save_agent(Some(&agent.id), "Vesper", Access::Auto, Some("p2"));

    left_alone(&world, &chat, Left::OutOfScope);
}

#[test]
fn an_agent_of_the_chats_own_project_is_in_scope() {
    let world = World::new();
    let agent = world.register("Vesper", Access::Auto, Some("p1"));
    let chat = world.discussion(&agent);

    assert_eq!(world.pass().lifted, 1);
    assert_eq!(world.listed_at(&chat).as_deref(), Some("auto"));
}

#[test]
fn a_chat_whose_agent_is_registered_at_read_is_left() {
    let world = World::new();
    let agent = world.register("Vesper", Access::Read, None);
    let chat = world.discussion(&agent);

    left_alone(&world, &chat, Left::RegisteredAtRead);

    // One time: a registered level raised later lifts nothing.
    world.save_agent(Some(&agent.id), "Vesper", Access::Full, None);
    world.is_done();
    assert_eq!(world.listed_at(&chat).as_deref(), Some("read"));
}

#[test]
fn a_chat_whose_level_was_changed_since_is_left() {
    for level in [
        Some("manual"),
        Some("edits"),
        Some("auto"),
        Some("full"),
        None,
    ] {
        let world = World::new();
        let agent = world.register("Vesper", Access::Auto, None);
        let chat = world.discussion(&agent);
        world.list_chat(&chat.id, level);
        world.remembers_start(&chat, Access::Read);

        left_alone(&world, &chat, Left::LevelChanged);
        assert_eq!(world.listed_at(&chat).as_deref(), level);
    }
}

#[test]
fn a_chat_in_the_trash_is_left() {
    let world = World::new();
    let agent = world.register("Vesper", Access::Auto, None);
    let chat = world.discussion(&agent);
    assert!(crate::chat_index::trash(&chat.id, None, None).unwrap());

    left_alone(&world, &chat, Left::NotListed);
    assert_eq!(world.listed_at(&chat).as_deref(), Some("read"));
}

#[test]
fn a_chat_the_index_does_not_list_is_left() {
    let world = World::new();
    let agent = world.register("Vesper", Access::Auto, None);
    let chat = world.discussion(&agent);
    crate::chat_index::remove(&chat.id).unwrap();

    left_alone(&world, &chat, Left::NotListed);
    assert_eq!(world.entry(&chat), None, "and no entry is made for it");
}

#[test]
fn a_chat_with_a_process_is_left() {
    let world = World::new();
    let agent = world.register("Vesper", Access::Auto, None);
    let chat = world.discussion(&agent);
    world.remembers_start(&chat, Access::Read);

    let entry = world.entry(&chat);
    let tally = world.pass_with(&|key| key == chat.key).unwrap();

    assert_eq!(tally, one(Left::Running));
    assert_eq!(world.entry(&chat), entry);
    assert_eq!(world.remembered_at(&chat), Some(Access::Read));
    assert_eq!(world.record(&chat)["liftSettled"], true);
    world.is_done();
}

/// The index is asked again as it is written: a level that moved after the
/// first look is the person's, and the chat is counted as left, not lifted.
#[test]
fn a_level_that_moves_under_the_pass_is_left_as_it_is() {
    let world = World::new();
    let agent = world.register("Vesper", Access::Auto, None);
    let chat = world.discussion(&agent);
    let record = world.record(&chat);

    let tally = world
        .pass_with(&|_| {
            world.list_chat(&chat.id, Some("manual"));
            false
        })
        .unwrap();

    assert_eq!(tally, one(Left::LevelChanged));
    assert_eq!(world.listed_at(&chat).as_deref(), Some("manual"));
    world.is_marked(&chat, &record);
    world.is_done();
}

#[test]
fn a_workers_chat_and_a_front_desks_are_left() {
    let world = World::new();
    let agent = world.register("Vesper", Access::Auto, None);

    let id = format!("orch-{}", uuid::Uuid::new_v4().simple());
    let key = format!("chat:{id}");
    world.list_chat(&id, Some("read"));
    team::record_lead(&world.team, &key, &agent, "p1", false).unwrap();
    let record = world.write_record(Some(&key), &agent, |_| {});
    let worker = Chat { id, key, record };
    left_alone(&world, &worker, Left::Worker);

    let desk = world.discussion(&agent);
    let mut roster: Value = serde_json::from_slice(&fs::read(&world.team).unwrap()).unwrap();
    roster["front_desk_chats"] = json!([
        { "chatKey": desk.key, "agentId": agent.id, "createdAt": 1 }
    ]);
    fs::write(&world.team, serde_json::to_vec_pretty(&roster).unwrap()).unwrap();
    left_alone(&world, &desk, Left::FrontDesk);
}

/// Every record that is not a confirmed discussion at read with a chat to
/// its name is not looked at: nothing is counted and nothing is written.
#[test]
fn a_record_that_is_not_a_confirmed_discussion_at_read_is_not_looked_at() {
    let edits: Vec<(&str, Box<dyn Fn(&mut Value)>)> = vec![
        (
            "not a discussion",
            Box::new(|r| r["route"]["discuss"] = json!(false)),
        ),
        (
            "no discuss field",
            Box::new(|r| r["route"] = json!({ "message": "Hello" })),
        ),
        ("pending", Box::new(|r| r["status"] = json!("pending"))),
        ("starting", Box::new(|r| r["status"] = json!("starting"))),
        ("declined", Box::new(|r| r["status"] = json!("declined"))),
        ("abandoned", Box::new(|r| r["status"] = json!("abandoned"))),
        (
            "at manual",
            Box::new(|r| r["settings"]["access"] = json!("manual")),
        ),
        (
            "at edits",
            Box::new(|r| r["settings"]["access"] = json!("edits")),
        ),
        (
            "at auto",
            Box::new(|r| r["settings"]["access"] = json!("auto")),
        ),
        (
            "at full",
            Box::new(|r| r["settings"]["access"] = json!("full")),
        ),
        (
            "a handover",
            Box::new(|r| {
                r.as_object_mut().unwrap().remove("kind");
            }),
        ),
        (
            "no chat",
            Box::new(|r| {
                r.as_object_mut().unwrap().remove("targetChatKey");
            }),
        ),
        (
            "looked at before",
            Box::new(|r| r["liftSettled"] = json!(true)),
        ),
    ];
    for (what, edit) in edits {
        let world = World::new();
        let agent = world.register("Vesper", Access::Auto, None);
        let chat = world.discussion_with(&agent, edit);
        world.remembers_start(&chat, Access::Read);
        let before = world.files();

        assert_eq!(world.pass(), Tally::default(), "{what}");

        assert_eq!(world.files(), before, "{what}: nothing was written");
        assert_eq!(world.listed_at(&chat).as_deref(), Some("read"), "{what}");
    }
}

/// A chat with no route record at all: an ordinary chat at read, a PR
/// chat, one the old "Discuss read-only" retry narrowed.
#[test]
fn a_chat_no_record_opened_as_a_discussion_is_never_lifted() {
    let world = World::new();
    let agent = world.register("Vesper", Access::Auto, None);
    let lifted = world.discussion(&agent);
    let id = format!("lift-{}", uuid::Uuid::new_v4().simple());
    world.list_chat(&id, Some("read"));
    team::record_lead(&world.team, &format!("chat:{id}"), &agent, "p1", false).unwrap();

    assert_eq!(world.pass().lifted, 1);

    assert_eq!(world.listed_at(&lifted).as_deref(), Some("auto"));
    let other = crate::chat_index::list().into_iter().find(|c| c.id == id);
    assert_eq!(other.unwrap().access.as_deref(), Some("read"));
}

#[test]
fn an_index_that_cannot_be_saved_leaves_the_record_for_the_next_start() {
    let world = World::new();
    let agent = world.register("Vesper", Access::Auto, None);
    let chat = world.discussion(&agent);
    world.remembers_start(&chat, Access::Read);
    let handovers = fs::read(&world.store).unwrap();

    let tally = crate::chat_index::tests::while_writes_fail(|| world.pass());

    assert_eq!(tally, again(Again::Index));
    assert_eq!(world.listed_at(&chat).as_deref(), Some("read"));
    assert_eq!(
        fs::read(&world.store).unwrap(),
        handovers,
        "the record is unmarked"
    );
    // The step before it was made, and is not made twice.
    assert_eq!(world.remembered_at(&chat), Some(Access::Auto));

    assert_eq!(world.pass().lifted, 1, "the next start does the rest");
    assert_eq!(world.listed_at(&chat).as_deref(), Some("auto"));
    assert_eq!(world.remembered_at(&chat), Some(Access::Auto));
    assert_eq!(world.record(&chat)["liftSettled"], true);
    world.is_done();
}

/// The profile folder takes no new file, so neither the ledger nor the
/// handovers can be saved; the chat index, in a folder of its own, can.
#[cfg(unix)]
fn while_the_profile_folder_takes_no_file<T>(world: &World, work: impl FnOnce() -> T) -> T {
    use std::os::unix::fs::PermissionsExt;
    let profile = world.home.profile();
    fs::set_permissions(&profile, fs::Permissions::from_mode(0o555)).unwrap();
    let done = work();
    fs::set_permissions(&profile, fs::Permissions::from_mode(0o755)).unwrap();
    done
}

#[cfg(unix)]
#[test]
fn a_ledger_that_cannot_be_saved_stops_before_anything_is_lifted() {
    let world = World::new();
    let agent = world.register("Vesper", Access::Auto, None);
    let chat = world.discussion(&agent);
    world.remembers_start(&chat, Access::Read);
    let before = world.files();

    let tally = while_the_profile_folder_takes_no_file(&world, || world.pass());

    assert_eq!(tally, again(Again::Ledger));
    assert_eq!(world.files(), before, "nothing was written");
    assert_eq!(
        world.remembered_at(&chat),
        Some(Access::Read),
        "nor kept in memory"
    );

    assert_eq!(world.pass().lifted, 1, "the next start does it all");
    assert_eq!(world.listed_at(&chat).as_deref(), Some("auto"));
    assert_eq!(world.remembered_at(&chat), Some(Access::Auto));
    assert_eq!(world.record(&chat)["liftSettled"], true);
}

#[cfg(unix)]
#[test]
fn a_record_that_cannot_be_saved_is_marked_at_the_next_start() {
    let world = World::new();
    let agent = world.register("Vesper", Access::Auto, None);
    let chat = world.discussion(&agent);
    let other = world.discussion(&agent);
    let handovers = fs::read(&world.store).unwrap();

    let tally = while_the_profile_folder_takes_no_file(&world, || world.pass());

    assert_eq!(
        tally,
        Tally {
            again: [(Again::Record, 2)].into(),
            ..Tally::default()
        }
    );
    assert_eq!(
        fs::read(&world.store).unwrap(),
        handovers,
        "no record is marked"
    );
    assert_eq!(
        world.listed_at(&chat).as_deref(),
        Some("auto"),
        "its chat was lifted"
    );
    assert_eq!(world.listed_at(&other).as_deref(), Some("auto"));

    // The chats are where the lift put them, so there is nothing to lift:
    // the records are marked as looked at.
    assert_eq!(
        world.pass(),
        Tally {
            left: [(Left::LevelChanged, 2)].into(),
            ..Tally::default()
        }
    );
    assert_eq!(world.record(&chat)["liftSettled"], true);
    assert_eq!(world.record(&other)["liftSettled"], true);
    assert_eq!(world.record(&chat)["settings"]["access"], "read");
    assert_eq!(world.listed_at(&chat).as_deref(), Some("auto"));
    world.is_done();
}

#[test]
fn a_ledger_that_could_not_be_loaded_is_never_read_as_holding_nothing() {
    let mut world = World::new();
    let agent = world.register("Vesper", Access::Auto, None);
    let chat = world.discussion(&agent);
    world.remembers_start(&chat, Access::Read);
    let ledger = world.home.profile().join("orchestrations.json");
    let whole = fs::read(&ledger).unwrap();
    fs::write(&ledger, b"{ not a ledger").unwrap();
    world.restart();
    let before = world.files();

    assert_eq!(world.pass(), again(Again::Ledger));
    assert_eq!(world.files(), before, "nothing was written");

    fs::write(&ledger, whole).unwrap();
    world.restart();
    assert_eq!(world.pass().lifted, 1);
    assert_eq!(world.remembered_at(&chat), Some(Access::Auto));
    assert_eq!(world.listed_at(&chat).as_deref(), Some("auto"));
}

/// With no record to look at the roster is not read: one that cannot be is
/// not this pass's to fail on.
#[test]
fn with_nothing_to_lift_the_roster_is_not_read() {
    let world = World::new();
    let agent = world.register("Vesper", Access::Auto, None);
    world.discussion_with(&agent, |r| r["route"]["discuss"] = json!(false));
    fs::write(&world.team, b"{ not json").unwrap();
    let before = world.files();

    assert_eq!(world.pass(), Tally::default());
    assert_eq!(world.files(), before);
}

/// The index's own door: a listed chat at exactly read moves, and nothing
/// else of it does; any other chat is not its to touch.
#[test]
fn the_index_moves_only_a_listed_chat_at_exactly_read() {
    let world = World::new();
    let agent = world.register("Vesper", Access::Auto, None);
    let lift = |chat: &Chat| crate::chat_index::lift_read(&chat.id, "auto");

    for level in [
        Some("manual"),
        Some("edits"),
        Some("auto"),
        Some("full"),
        None,
    ] {
        let chat = world.discussion(&agent);
        world.list_chat(&chat.id, level);
        let entry = world.entry(&chat);
        assert_eq!(lift(&chat), Ok(false), "{level:?}");
        assert_eq!(world.entry(&chat), entry, "{level:?}");
    }

    let trashed = world.discussion(&agent);
    crate::chat_index::trash(&trashed.id, None, None).unwrap();
    let entry = world.entry(&trashed);
    assert_eq!(lift(&trashed), Ok(false));
    assert_eq!(world.entry(&trashed), entry);

    let unlisted = world.discussion(&agent);
    crate::chat_index::remove(&unlisted.id).unwrap();
    assert_eq!(lift(&unlisted), Ok(false));
    assert_eq!(world.entry(&unlisted), None);

    let chat = world.discussion(&agent);
    let mut entry = world.entry(&chat).unwrap();
    assert_eq!(lift(&chat), Ok(true));
    entry["access"] = json!("auto");
    assert_eq!(world.entry(&chat).unwrap(), entry);
    assert_eq!(lift(&chat), Ok(false), "once");

    let unread = world.discussion(&agent);
    let index = world.home.profile().join("chats").join("index.json");
    fs::write(&index, b"{ not an index").unwrap();
    let before = world.files();
    lift(&unread).expect_err("an index that cannot be read is not an empty one");
    assert_eq!(world.files(), before);
}

/// The ledger's own door: saved start settings at exactly read move, and
/// nothing else of them does.
#[test]
fn the_ledger_moves_only_saved_start_settings_at_exactly_read() {
    let mut world = World::new();
    let agent = world.register("Vesper", Access::Auto, None);
    let file = world.home.profile().join("orchestrations.json");

    let unknown = world.discussion(&agent);
    assert_eq!(
        world.ledger.lift_resume_context(&unknown.key, Access::Auto),
        Ok(false)
    );

    for level in [Access::Manual, Access::Edits, Access::Auto, Access::Full] {
        let chat = world.discussion(&agent);
        world.remembers_start(&chat, level);
        let before = fs::read(&file).unwrap();
        assert_eq!(
            world.ledger.lift_resume_context(&chat.key, Access::Auto),
            Ok(false)
        );
        assert_eq!(world.remembered_at(&chat), Some(level));
        assert_eq!(fs::read(&file).unwrap(), before, "{level:?}: nothing saved");
    }

    let chat = world.discussion(&agent);
    world.remembers_start(&chat, Access::Read);
    let started = world.ledger.saved_resume_context(&chat.key).unwrap();
    assert_eq!(
        world.ledger.lift_resume_context(&chat.key, Access::Edits),
        Ok(true)
    );
    assert_eq!(
        world.ledger.saved_resume_context(&chat.key),
        Some(started.at(Access::Edits)),
        "only the level moved"
    );
    assert_eq!(
        world.ledger.lift_resume_context(&chat.key, Access::Full),
        Ok(false),
        "once"
    );
    world.restart();
    assert_eq!(
        world.remembered_at(&chat),
        Some(Access::Edits),
        "and it is on disk"
    );

    fs::write(&file, b"{ not a ledger").unwrap();
    world.restart();
    world
        .ledger
        .lift_resume_context(&chat.key, Access::Auto)
        .expect_err("a ledger that could not be loaded does not hold nothing");
}

#[test]
fn an_index_that_cannot_be_read_is_never_read_as_not_listing_the_chat() {
    let world = World::new();
    let agent = world.register("Vesper", Access::Auto, None);
    let chat = world.discussion(&agent);
    world.remembers_start(&chat, Access::Read);
    let index = world.home.profile().join("chats").join("index.json");
    let whole = fs::read(&index).unwrap();
    fs::write(&index, b"{ not an index").unwrap();
    let before = world.files();

    assert_eq!(world.pass(), again(Again::Index));
    assert_eq!(world.files(), before, "nothing was written");

    fs::write(&index, whole).unwrap();
    assert_eq!(world.pass().lifted, 1);
    assert_eq!(world.listed_at(&chat).as_deref(), Some("auto"));
}

#[test]
fn a_roster_or_a_store_that_cannot_be_read_refuses_the_whole_pass() {
    for file in ["team.json", "handovers.json"] {
        let world = World::new();
        let agent = world.register("Vesper", Access::Auto, None);
        let chat = world.discussion(&agent);
        world.remembers_start(&chat, Access::Read);
        let path = world.home.profile().join(file);
        let whole = fs::read(&path).unwrap();
        fs::write(&path, b"{ not json").unwrap();
        let before = world.files();

        world.pass_with(&|_| false).expect_err(file);
        assert_eq!(world.files(), before, "{file}: nothing was written");

        fs::write(&path, whole).unwrap();
        assert_eq!(world.pass().lifted, 1, "{file}");
        assert_eq!(world.listed_at(&chat).as_deref(), Some("auto"), "{file}");
    }
}

/// Away three ways (`profile::tests::Home`): each is an error for the
/// pass, nothing is written where the folder was or into the folder that
/// went, and the start after it is back lifts the chat.
#[test]
fn a_profile_folder_that_is_away_is_an_error_and_nothing_is_written() {
    type Way = (&'static str, fn(&Home), fn(&Home));
    let ways: [Way; 3] = [
        ("unplugged", Home::unplug, Home::plug_back),
        ("moved away", Home::move_away, Home::move_back),
        ("replaced", Home::replace, Home::move_back),
    ];
    for (what, away, back) in ways {
        let mut world = World::new();
        let agent = world.register("Vesper", Access::Auto, None);
        let chat = world.discussion(&agent);
        world.remembers_start(&chat, Access::Read);
        let before = world.files();
        away(&world.home);
        let kept = if what == "unplugged" {
            world.home.dir.join("drive-away")
        } else {
            world.home.kept()
        };
        let elsewhere = everything_in(&kept);
        let in_its_place = fs::symlink_metadata(world.home.profile())
            .is_ok()
            .then(|| everything_in(&world.home.profile()));

        let refused = world.pass_with(&|_| false).expect_err(what);

        assert_eq!(
            Err(refused),
            crate::profile::available(),
            "{what}: the profile's words"
        );
        assert_eq!(
            everything_in(&kept),
            elsewhere,
            "{what}: the folder that went"
        );
        assert_eq!(
            fs::symlink_metadata(world.home.profile())
                .is_ok()
                .then(|| everything_in(&world.home.profile())),
            in_its_place,
            "{what}: where it was"
        );

        back(&world.home);
        assert_eq!(world.files(), before, "{what}: put back as it went");
        world.restart();
        assert_eq!(world.pass().lifted, 1, "{what}");
        assert_eq!(world.listed_at(&chat).as_deref(), Some("auto"), "{what}");
    }
}

#[test]
fn the_pass_over_the_profiles_own_stores_is_what_a_start_runs() {
    let world = World::new();
    let _roster = team::use_test_path(world.team.clone());
    let agent = world.register("Vesper", Access::Auto, None);
    let chat = world.discussion(&agent);

    at_startup(&world.ledger, &|_| false);

    assert_eq!(world.listed_at(&chat).as_deref(), Some("auto"));
    assert_eq!(world.record(&chat)["liftSettled"], true);
}

/// The lift runs in `Services::load` before anything there can start a
/// chat: the idle reaper, the auto-resume scheduler and the run scheduler.
#[test]
fn a_start_lifts_before_anything_can_start_a_chat() {
    let source = include_str!("../../dispatch.rs");
    let load = source
        .find("pub fn load() -> Self")
        .expect("Services::load");
    let body = &source[load..];
    let at = |what: &str| {
        body.find(what)
            .unwrap_or_else(|| panic!("{what} in Services::load"))
    };
    let lift = at("crate::handover::lift::at_startup(");
    assert!(
        at("OrchestrationStore::load_profile()") < lift,
        "the ledger is loaded first"
    );
    for starter in [
        "start_idle_reaper(",
        "start_auto_resume_scheduler(",
        "automation::start_scheduler(",
        "start_owed_saves(",
    ] {
        assert!(lift < at(starter), "the lift is before {starter}");
    }
    assert_eq!(
        source.matches("lift::at_startup(").count(),
        1,
        "and it is called from nowhere else"
    );
}

#[test]
fn the_line_counts_and_names_no_chat() {
    let world = World::new();
    let auto = world.register("Vesper", Access::Auto, None);
    let reader = world.register("Quill", Access::Read, None);
    let lifted = world.discussion(&auto);
    let changed = world.discussion(&auto);
    world.list_chat(&changed.id, Some("full"));
    let at_read = world.discussion(&reader);
    let second = world.discussion(&auto);

    let tally = world.pass();
    assert_eq!(
        tally.line(),
        "2 lifted to their agent's registered access, \
         2 (1 agent registered at read, 1 level changed since) left"
    );
    let mut with_retry = tally;
    with_retry.again = [(Again::Index, 1), (Again::Record, 2)].into();
    let line = with_retry.line();
    assert!(
        line.ends_with(
            ", 3 (1 the chat index could not be read or saved, \
             2 the route's record could not be saved) to try again at the next start"
        ),
        "{line}"
    );
    assert_eq!(
        Tally::default().line(),
        "0 lifted to their agent's registered access, 0 left"
    );
    for chat in [&lifted, &changed, &at_read, &second] {
        assert!(
            !line.contains(&chat.id) && !line.contains(&chat.record),
            "{line}"
        );
    }
}
