//! A chat is started only once the record that says so is on disk: the
//! settings read from the roster and the mark that this build starts it, in
//! one write, before the start. A start whose record cannot be saved is
//! refused.
//!
//! Real `request`, `confirm`, `recover` and `lift::run` on the profile's own
//! stores. The agent's process is `FakeHost`, which also keeps what the
//! handover store held at the moment of each start (`watch_store`), and
//! breaks the store before the start (`break_store_at_check`) or after it
//! (`break_store`).
use super::*;
use crate::bus::tap::Tap;
use crate::handover::{INTERRUPTED, NOT_RECORDED};

/// Who starts the chat of a record left starting.
#[derive(Clone, Copy, Debug)]
enum By {
    /// The person's Try again on its card (`confirm`).
    TryAgain,
    /// The startup recovery (`finish_route`).
    Recovery,
}

impl By {
    fn starts(self, world: &World, desk: &Desk, id: &str) -> Result<(), String> {
        match self {
            By::TryAgain => confirm(&world.store, id, &desk.host).map(drop),
            By::Recovery => recover(&world.store, &desk.host).map(drop),
        }
    }
}

/// Where a routed chat works, which decides what `launch` saves on its way
/// to the start.
#[derive(Clone, Copy, Debug, PartialEq)]
enum Place {
    /// The home project's own folder. Nothing is made, and nothing was
    /// saved before the start.
    Folder,
    /// A worktree an attempt before this one made. Nothing is made, and
    /// nothing was saved before the start.
    WorktreeMade,
    /// A worktree still to make, saved with the record once it is made.
    WorktreeToMake,
}

const PLACES: [Place; 3] = [Place::Folder, Place::WorktreeMade, Place::WorktreeToMake];

impl Place {
    /// What a start that goes through announces: the record before the
    /// start, the record again with the worktree it made, then confirmed.
    fn said(self) -> &'static [&'static str] {
        match self {
            Place::WorktreeToMake => &["starting", "starting", "confirmed"],
            Place::Folder | Place::WorktreeMade => &["starting", "confirmed"],
        }
    }
}

impl World {
    /// A front desk and one project, `p1`, with a repository: the home
    /// project for a chat that works in its folder, a code project for one
    /// that gets a worktree.
    fn desk_for(&self, place: Place) -> Desk {
        let root = scratch("lift-route");
        let app = repo(&root, "app");
        let desk = team::create_front_desk(&self.team, team::FrontDeskDraft::default())
            .expect("a front desk");
        let name = if place == Place::Folder {
            "General"
        } else {
            "Project"
        };
        Desk {
            host: FakeHost {
                projects: vec![project("p1", name, &[&app])],
                team: self.team.clone(),
                root: root.to_path_buf(),
                ..FakeHost::default()
            },
            desk,
            _root: root,
        }
    }
}

impl Desk {
    /// The front desk proposes a discussion with `agent`, for a chat that
    /// works in `place`.
    fn asks_at(&self, world: &World, agent: &str, place: Place) -> Handover {
        let asked = self.asks(world, agent);
        let mode = if place == Place::Folder {
            "folder"
        } else {
            "worktree"
        };
        assert_eq!(asked.workspace.mode, mode, "{place:?}");
        assert_eq!(asked.workspace.prepared_cwd, None, "{place:?}");
        if place == Place::WorktreeMade {
            let made = self.host.root.join("made-before");
            world.rewrite(&asked.id, |record| {
                record["workspace"]["preparedCwd"] = json!(made.to_string_lossy());
            });
        }
        asked
    }

    /// A discussion with `agent` as the build before this one left it once
    /// the person had confirmed it: starting, at read, saying nothing of the
    /// lift, and its chat not started.
    fn left_unstarted(&self, world: &World, agent: &str, place: Place) -> Chat {
        let asked = self.asks_at(world, agent, place);
        let key = format!("chat:lift-{}", uuid::Uuid::new_v4().simple());
        world.as_an_earlier_build_left(&asked.id, |record| {
            record["status"] = json!("starting");
            record["decidedAt"] = json!(2);
            record["targetChatKey"] = json!(key);
        });
        self.chat_of(&get(&world.store, &asked.id).unwrap())
    }

    /// A handover of a task to `agent`, proposed and still pending.
    fn hands_over(&self, world: &World, agent: &str) -> Handover {
        request(
            &world.store,
            &self.host,
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
                recipient: agent.into(),
                project: None,
                repository: None,
                request_id: uuid::Uuid::new_v4().to_string(),
                brief: Brief {
                    objective: "Finish the login fix".into(),
                    done_so_far: "Found the bug".into(),
                    remaining: "Write the test".into(),
                    ..Brief::default()
                },
            },
        )
        .expect("the handover is proposed")
    }

    fn watches(&self, world: &World) {
        *self.host.watch_store.lock().unwrap() = Some(world.store.clone());
    }

    /// The record `id` as the disk held it when each chat was started.
    fn on_disk_at_start(&self, id: &str) -> Vec<Value> {
        let held = self.host.store_at_start.lock().unwrap();
        held.iter()
            .map(|bytes| {
                let stored: Value = serde_json::from_slice(bytes).unwrap();
                stored["handovers"][id].clone()
            })
            .collect()
    }

    fn starts(&self) -> usize {
        self.host.starts.lock().unwrap().len()
    }
}

/// What a tap on a record heard, as the status each announcement gave.
fn statuses(tap: &Tap) -> Vec<String> {
    tap.heard()
        .into_iter()
        .map(|(event, payload)| {
            assert_eq!(event, "handover-changed");
            payload["status"].as_str().unwrap().to_owned()
        })
        .collect()
}

/// N3-F. An earlier build left a route starting with its chat not started,
/// and this build starts it at its agent's own read. The save after the
/// start fails, and the record is completed by whichever comes next. It was
/// on disk as this build's before the start, so it is never the lift's.
#[test]
fn a_chat_this_build_starts_is_recorded_as_its_own_before_the_start() {
    for (place, by) in PLACES
        .into_iter()
        .flat_map(|place| [By::TryAgain, By::Recovery].map(|by| (place, by)))
    {
        for flip in [Flip::Confirm, Flip::Recover] {
            let case = format!("{place:?}: {by:?}, then {flip:?}");
            let mut world = World::new();
            let agent = world.register("Vesper", Access::Read, Some("p1"));
            let desk = world.desk_for(place);
            let chat = desk.left_unstarted(&world, "Vesper", place);
            assert_eq!(world.raw(&chat.record).get("liftSettled"), None);
            desk.watches(&world);

            // This build starts the chat, and the save after it fails.
            *desk.host.break_store.lock().unwrap() = Some(world.store.clone());
            by.starts(&world, &desk, &chat.record)
                .expect_err("the save after the start fails");
            mend_store(&world.store);
            desk.index_follows();
            assert_eq!(desk.started_at(), [Access::Read], "{case}");

            // The disk said so before the chat was started.
            let at_start = desk.on_disk_at_start(&chat.record);
            assert_eq!(at_start.len(), 1, "{case}");
            assert_eq!(at_start[0]["status"], "starting", "{case}");
            assert_eq!(at_start[0]["settings"]["access"], "read", "{case}");
            assert_eq!(at_start[0]["liftSettled"], true, "{case}");
            assert_eq!(world.raw(&chat.record), at_start[0], "{case}");

            // The restart: the pass, then the record is confirmed.
            world.restart();
            let before = world.files();
            assert_eq!(world.pass(), Tally::default(), "{case}");
            assert_eq!(world.files(), before, "{case}");
            flip.confirms(&world, &desk, &chat.record);

            let stored = world.raw(&chat.record);
            assert_eq!(stored["status"], "confirmed", "{case}");
            assert_eq!(stored["liftSettled"], true, "{case}");
            assert_eq!(desk.started_at(), [Access::Read], "{case}: one start");

            // The agent is raised: no later start lifts the chat.
            world.save_agent(Some(&agent.id), "Vesper", Access::Auto, Some("p1"));
            world.restart();
            world.is_done();
            assert_eq!(world.listed_at(&chat).as_deref(), Some("read"), "{case}");

            world.would_be_lifted_but_for_the_mark(&chat, &agent);
            world.only_the_mark_held_it(&chat, "auto");
        }
    }
}

/// The server stops as the chat starts, before anything after the start is
/// saved: the disk is what it held at that moment. The record there is
/// already starting on the roster's settings and marked.
#[test]
fn a_server_that_stops_as_the_chat_starts_leaves_a_record_that_is_this_builds() {
    for place in PLACES {
        for (by, registered) in [
            (By::TryAgain, Access::Read),
            (By::Recovery, Access::Edits),
            (By::TryAgain, Access::Edits),
            (By::Recovery, Access::Read),
        ] {
            for flip in [Flip::Recover, Flip::Confirm] {
                let case = format!("{place:?}: {by:?} at {registered:?}, then {flip:?}");
                let mut world = World::new();
                let agent = world.register("Vesper", registered, Some("p1"));
                let desk = world.desk_for(place);
                let chat = desk.left_unstarted(&world, "Vesper", place);
                assert_eq!(world.raw(&chat.record)["settings"]["access"], "read");
                desk.watches(&world);

                by.starts(&world, &desk, &chat.record)
                    .expect("the chat is started");
                desk.index_follows();
                let held = desk.host.store_at_start.lock().unwrap().clone();
                assert_eq!(held.len(), 1, "{case}");
                fs::write(&world.store, &held[0]).unwrap();

                let level = crate::orchestration::access_id(registered);
                let cut = world.raw(&chat.record);
                assert_eq!(cut["status"], "starting", "{case}");
                assert_eq!(cut["settings"]["access"], level, "{case}: the roster's");
                assert_eq!(cut["liftSettled"], true, "{case}");
                assert_eq!(desk.started_at(), [registered], "{case}");

                // The next start of the server.
                world.restart();
                let before = world.files();
                assert_eq!(world.pass(), Tally::default(), "{case}");
                assert_eq!(world.files(), before, "{case}");
                flip.confirms(&world, &desk, &chat.record);

                let stored = world.raw(&chat.record);
                assert_eq!(stored["status"], "confirmed", "{case}");
                assert_eq!(stored["settings"]["access"], level, "{case}");
                assert_eq!(stored["liftSettled"], true, "{case}");
                assert_eq!(desk.starts(), 1, "{case}: one start");

                if registered == Access::Read {
                    world.save_agent(Some(&agent.id), "Vesper", Access::Auto, Some("p1"));
                    world.restart();
                    world.is_done();
                    assert_eq!(world.listed_at(&chat).as_deref(), Some("read"), "{case}");
                    world.would_be_lifted_but_for_the_mark(&chat, &agent);
                    world.only_the_mark_held_it(&chat, "auto");
                }
            }
        }
    }
}

/// The record cannot be saved before the start: nothing is started, made or
/// announced, the disk is as it was, and the refusal says why. With the
/// store back, the same step starts the chat once.
#[test]
fn a_start_whose_record_cannot_be_saved_first_is_refused_and_starts_nothing() {
    for (place, by) in PLACES
        .into_iter()
        .flat_map(|place| [By::TryAgain, By::Recovery].map(|by| (place, by)))
    {
        let case = format!("{place:?}: {by:?}");
        let world = World::new();
        world.register("Vesper", Access::Edits, Some("p1"));
        let desk = world.desk_for(place);
        let chat = desk.left_unstarted(&world, "Vesper", place);
        let left = world.raw(&chat.record);
        let tap = Tap::on(&chat.record);

        *desk.host.break_store_at_check.lock().unwrap() = Some(world.store.clone());
        let refused = by
            .starts(&world, &desk, &chat.record)
            .expect_err("the start is refused");
        mend_store(&world.store);

        assert_eq!(desk.starts(), 0, "{case}: nothing is started");
        assert_eq!(*desk.host.worktrees.lock().unwrap(), 0, "{case}");
        assert_eq!(world.raw(&chat.record), left, "{case}: unchanged on disk");
        assert!(statuses(&tap).is_empty(), "{case}: nothing is announced");
        match by {
            By::TryAgain => {
                // The card's own answer says it, and no chat row is made.
                assert!(refused.starts_with(NOT_RECORDED), "{refused}");
                assert!(desk.host.saved.lock().unwrap().is_empty());
                assert!(desk.host.failures.lock().unwrap().is_empty());
            }
            By::Recovery => {
                // Nobody sees a route's card after a restart: it is said in
                // the chat the route was to open, as any failed start is.
                let failures = desk.host.failures.lock().unwrap().clone();
                assert_eq!(failures.len(), 1);
                assert_eq!(failures[0].0, chat.key);
                assert!(failures[0].1.contains(NOT_RECORDED), "{}", failures[0].1);
            }
        }

        // The store is back: the same step starts the chat, once.
        by.starts(&world, &desk, &chat.record)
            .expect("the chat is started");
        desk.index_follows();
        assert_eq!(desk.started_at(), [Access::Edits], "{case}");
        let stored = world.raw(&chat.record);
        assert_eq!(stored["status"], "confirmed", "{case}");
        assert_eq!(stored["settings"]["access"], "edits", "{case}");
        assert_eq!(stored["liftSettled"], true, "{case}");
        assert_eq!(world.listed_at(&chat).as_deref(), Some("edits"), "{case}");
        assert_eq!(statuses(&tap), place.said(), "{case}");
    }
}

/// A pending card's confirm saves the record before the start, as it always
/// did, and `launch` does not save it a second time. A record left starting
/// is saved once before its start too. Where a worktree is made, the record
/// is saved again with it, as before.
#[test]
fn the_record_is_saved_once_before_the_start() {
    for place in PLACES {
        let world = World::new();
        world.register("Vesper", Access::Edits, Some("p1"));
        let desk = world.desk_for(place);
        desk.watches(&world);

        let asked = desk.asks_at(&world, "Vesper", place);
        let tap = Tap::on(&asked.id);
        desk.confirms(&world, &asked.id);
        assert_eq!(statuses(&tap), place.said(), "{place:?}: pending");
        let at_start = desk.on_disk_at_start(&asked.id);
        assert_eq!(at_start.len(), 1, "{place:?}");
        assert_eq!(at_start[0]["status"], "starting", "{place:?}");
        assert_eq!(at_start[0]["liftSettled"], true, "{place:?}");

        let chat = desk.left_unstarted(&world, "Vesper", place);
        let tap = Tap::on(&chat.record);
        confirm(&world.store, &chat.record, &desk.host).expect("the chat is started");
        assert_eq!(statuses(&tap), place.said(), "{place:?}: starting");
        let at_start = desk.on_disk_at_start(&chat.record);
        assert_eq!(at_start.len(), 2, "{place:?}: one more start");
        assert_eq!(at_start[1]["status"], "starting", "{place:?}");
        assert_eq!(at_start[1]["settings"]["access"], "edits", "{place:?}");
        assert_eq!(at_start[1]["liftSettled"], true, "{place:?}");
        let made = *desk.host.worktrees.lock().unwrap();
        let expected = if place == Place::WorktreeToMake { 2 } else { 0 };
        assert_eq!(made, expected, "{place:?}");
    }
}

/// A handover of a task, not a route: the same save, whether its worktree
/// is still to be made or was made by an attempt before.
#[test]
fn a_handover_left_starting_is_recorded_before_its_chat_starts() {
    for prepared in [false, true] {
        let world = World::new();
        world.register("Vesper", Access::Edits, Some("p1"));
        let desk = world.desk();
        let handed = desk.hands_over(&world, "Vesper");
        assert_eq!(handed.kind, Kind::Handover);
        assert_eq!(handed.workspace.mode, "worktree");
        let made = desk.host.root.join("made-before");
        world.as_an_earlier_build_left(&handed.id, |record| {
            record["status"] = json!("starting");
            record["decidedAt"] = json!(2);
            record["targetChatKey"] = json!("chat:handed-over");
            if prepared {
                record["workspace"]["preparedCwd"] = json!(made.to_string_lossy());
            }
        });
        desk.watches(&world);

        confirm(&world.store, &handed.id, &desk.host).expect("the chat is started");

        let made_now = *desk.host.worktrees.lock().unwrap();
        assert_eq!(made_now, usize::from(!prepared), "prepared: {prepared}");
        let at_start = desk.on_disk_at_start(&handed.id);
        assert_eq!(at_start.len(), 1);
        assert_eq!(at_start[0]["status"], "starting");
        assert_eq!(at_start[0]["settings"]["access"], "edits");
        assert_eq!(at_start[0]["liftSettled"], true);
        assert!(at_start[0]["workspace"]["preparedCwd"].is_string());
        assert_eq!(world.raw(&handed.id)["status"], "confirmed");
    }
}

/// What the person sees when the start is refused: the card as it was, so
/// Try again and Give up are still on it, and Try again goes through the
/// same save.
#[test]
fn a_refused_start_leaves_the_card_its_try_again_and_give_up() {
    let world = World::new();
    world.register("Vesper", Access::Edits, Some("p1"));
    let desk = world.desk();
    let handed = desk.hands_over(&world, "Vesper");
    world.as_an_earlier_build_left(&handed.id, |record| {
        record["status"] = json!("starting");
        record["decidedAt"] = json!(2);
        record["targetChatKey"] = json!("chat:handed-over");
    });
    // This build's start of the server: the card says it was interrupted.
    assert!(recover(&world.store, &desk.host).unwrap().is_empty());
    let card = world.raw(&handed.id);
    assert_eq!(card["status"], "starting");
    assert_eq!(card["error"], INTERRUPTED);
    assert_eq!(card["abandonable"], true);
    assert_eq!(card.get("liftSettled"), None, "nothing started it yet");

    *desk.host.break_store_at_check.lock().unwrap() = Some(world.store.clone());
    let refused = confirm(&world.store, &handed.id, &desk.host).unwrap_err();
    mend_store(&world.store);

    assert!(refused.starts_with(NOT_RECORDED), "{refused}");
    assert_eq!(desk.starts(), 0);
    assert_eq!(
        *desk.host.worktrees.lock().unwrap(),
        0,
        "no worktree is made"
    );
    assert!(desk.host.saved.lock().unwrap().is_empty(), "no chat row");
    assert_eq!(world.raw(&handed.id), card, "the card is as it was");

    // Try again, with the store back.
    desk.watches(&world);
    confirm(&world.store, &handed.id, &desk.host).expect("the chat is started");
    assert_eq!(desk.starts(), 1);
    let at_start = desk.on_disk_at_start(&handed.id);
    assert_eq!(at_start[0]["liftSettled"], true);
    assert_eq!(at_start[0]["settings"]["access"], "edits");
    assert_eq!(world.raw(&handed.id)["status"], "confirmed");
}
