//! A chat's plan as it is kept: the round trip, the bounds, a stale
//! revision, the gate, the Start, and a profile folder that is away.
//!
//! How a plan's linked tasks stand in the ledger is in
//! `orchestration/plan_link_tests.rs`, where a ledger can be made; the
//! commands and the Start turn are in `dispatch.rs`, and who may call the
//! tools in `web.rs`.

use super::*;

/// A chat with a plan of its own in the test binary's shared profile,
/// forgotten again when the test ends.
struct Chat(String);

impl Chat {
    fn new() -> Self {
        Self(format!("plan-{}", uuid::Uuid::new_v4().simple()))
    }

    fn key(&self) -> String {
        format!("chat:{}", self.0)
    }

    fn change(&self, change: serde_json::Value) -> Result<Updated, String> {
        update(
            &self.0,
            "OCTIQ BE",
            serde_json::from_value(change).unwrap(),
            |_| Ok(()),
        )
    }

    fn plan(&self) -> Plan {
        get(&self.0).unwrap().expect("a plan")
    }
}

impl Drop for Chat {
    fn drop(&mut self) {
        forget(&self.0);
    }
}

fn item(title: &str) -> serde_json::Value {
    serde_json::json!({ "title": title })
}

#[test]
fn a_plan_is_kept_item_by_item_and_read_back_as_it_was_written() {
    let chat = Chat::new();
    assert_eq!(get(&chat.0), Ok(None), "a chat starts with no plan");

    let first = chat
        .change(serde_json::json!({
            "baseRevision": 0,
            "add": [
                {
                    "title": "  Quieter   composer\nrows ",
                    "questions": ["Which rows fold?", "   "],
                    "note": "  From the screenshot.  ",
                },
                { "title": "Usage row", "status": "decided", "decisions": ["Desktop only"] },
            ],
        }))
        .unwrap();
    assert!(first.changed);
    let plan = first.plan;
    assert_eq!(plan.revision, 1);
    assert_eq!(plan.updated_by, "OCTIQ BE");
    assert!(plan.updated_at > 0);
    assert_eq!(plan.started, None);
    // A title is one line, an empty question is none, a note is trimmed.
    assert_eq!(plan.items[0].id, "i1");
    assert_eq!(plan.items[0].title, "Quieter composer rows");
    assert_eq!(plan.items[0].status, Status::Discussing);
    assert_eq!(plan.items[0].questions, ["Which rows fold?"]);
    assert_eq!(plan.items[0].note.as_deref(), Some("From the screenshot."));
    assert_eq!((plan.items[0].added_in, plan.items[0].changed_in), (1, 1));
    assert_eq!(plan.items[1].id, "i2");
    assert_eq!(plan.items[1].status, Status::Decided);
    assert_eq!(chat.plan(), plan, "what was answered is what was kept");

    // A change names an item: what it leaves out stays, a list it sends
    // replaces that item's list, an empty note clears it.
    let second = chat
        .change(serde_json::json!({
            "baseRevision": 1,
            "update": [{
                "id": "i1",
                "status": "decided",
                "questions": [],
                "decisions": ["Every row folds to one line"],
                "note": "",
            }],
            "add": [{ "title": "Plan panel", "before": "i2" }],
        }))
        .unwrap()
        .plan;
    assert_eq!(second.revision, 2);
    let ids: Vec<&str> = second.items.iter().map(|item| item.id.as_str()).collect();
    assert_eq!(ids, ["i1", "i3", "i2"]);
    let changed = &second.items[0];
    assert_eq!(changed.title, "Quieter composer rows", "left out, so kept");
    assert_eq!(changed.status, Status::Decided);
    assert!(changed.questions.is_empty());
    assert_eq!(changed.decisions, ["Every row folds to one line"]);
    assert_eq!(changed.note, None);
    assert_eq!((changed.added_in, changed.changed_in), (1, 2));
    assert_eq!(second.items[2].changed_in, 1, "an item nobody named");

    // The order names every item once.
    let third = chat
        .change(serde_json::json!({ "baseRevision": 2, "order": ["i2", "i1", "i3"] }))
        .unwrap()
        .plan;
    let ids: Vec<&str> = third.items.iter().map(|item| item.id.as_str()).collect();
    assert_eq!(ids, ["i2", "i1", "i3"]);
    assert_eq!(third.revision, 3);

    // An item leaves by being dropped, and its id is never given again.
    let fourth = chat
        .change(serde_json::json!({
            "baseRevision": 3,
            "update": [{ "id": "i3", "status": "dropped" }],
            "add": [item("One more")],
        }))
        .unwrap()
        .plan;
    assert_eq!(fourth.items.len(), 4, "a dropped item stays on the list");
    assert_eq!(fourth.items[2].status, Status::Dropped);
    assert_eq!(fourth.items[3].id, "i4");

    // A change that asks for what the plan already says writes nothing.
    let same = chat
        .change(serde_json::json!({
            "baseRevision": 4,
            "update": [{ "id": "i2", "status": "decided" }],
        }))
        .unwrap();
    assert!(!same.changed);
    assert_eq!(same.plan.revision, 4);
    assert_eq!(chat.plan(), fourth);

    forget(&chat.0);
    assert_eq!(get(&chat.0), Ok(None));
}

#[test]
fn a_change_based_on_an_older_revision_is_refused_whole() {
    let chat = Chat::new();
    chat.change(serde_json::json!({ "baseRevision": 0, "add": [item("First")] }))
        .unwrap();
    let kept = chat.plan();
    // Two writers read revision 1; the second to write is refused, so it
    // cannot put its copy over what the first one wrote.
    chat.change(serde_json::json!({ "baseRevision": 1, "add": [item("Second")] }))
        .unwrap();
    let stale = chat
        .change(serde_json::json!({
            "baseRevision": 1,
            "update": [{ "id": "i1", "title": "Overwritten" }],
        }))
        .err()
        .unwrap();
    assert!(stale.contains("is at revision 2"), "{stale}");
    assert!(stale.contains("based on revision 1"), "{stale}");
    assert!(stale.contains("Nothing was changed"), "{stale}");
    assert!(stale.contains("plan_read"), "{stale}");
    assert_eq!(chat.plan().items[0], kept.items[0]);
    assert_eq!(chat.plan().revision, 2);
    // A first change that thinks there is a plan, and one that thinks there
    // is none where there is one.
    let other = Chat::new();
    let ahead = other
        .change(serde_json::json!({ "baseRevision": 3, "add": [item("x")] }))
        .err()
        .unwrap();
    assert!(ahead.contains("is at revision 0"), "{ahead}");
    assert_eq!(get(&other.0), Ok(None));
    let behind = chat
        .change(serde_json::json!({ "baseRevision": 0, "add": [item("x")] }))
        .err()
        .unwrap();
    assert!(behind.contains("is at revision 2"), "{behind}");
}

#[test]
fn what_is_over_a_bound_is_refused_in_words_and_changes_nothing() {
    let chat = Chat::new();
    chat.change(serde_json::json!({ "baseRevision": 0, "add": [item("Kept")] }))
        .unwrap();
    let kept = chat.plan();
    let lines = |count: usize| vec!["a line"; count];
    // Characters, not bytes: exactly the bound in a multi-byte letter fits.
    let wide = |count: usize| "é".repeat(count);
    let refused: Vec<(serde_json::Value, &str)> = vec![
        (
            serde_json::json!({ "add": [item(&wide(MAX_TITLE + 1))] }),
            "A title can be 120 characters at most",
        ),
        (
            serde_json::json!({ "add": [item("   ")] }),
            "An item needs a title",
        ),
        (
            serde_json::json!({ "add": [{ "title": "t", "decisions": lines(MAX_LINES + 1) }] }),
            "An item can hold 12 decisions at most",
        ),
        (
            serde_json::json!({ "update": [{ "id": "i1", "questions": lines(MAX_LINES + 1) }] }),
            "An item can hold 12 open questions at most",
        ),
        (
            serde_json::json!({ "add": [{ "title": "t", "decisions": [wide(MAX_LINE + 1)] }] }),
            "A decision can be 240 characters at most",
        ),
        (
            serde_json::json!({ "update": [{ "id": "i1", "questions": [wide(MAX_LINE + 1)] }] }),
            "A open question can be 240 characters at most",
        ),
        (
            serde_json::json!({ "update": [{ "id": "i1", "note": wide(MAX_NOTE + 1) }] }),
            "A note can be 600 characters at most",
        ),
        (
            serde_json::json!({ "update": [{ "id": "i1", "tasks": (0..=MAX_TASKS).map(|n| format!("task_{n}")).collect::<Vec<_>>() }] }),
            "An item can be linked to 24 tasks at most",
        ),
        (
            serde_json::json!({ "add": (0..MAX_ITEMS).map(|n| item(&format!("Item {n}"))).collect::<Vec<_>>() }),
            "A plan holds 60 items at most",
        ),
        (
            serde_json::json!({ "update": [{ "id": "i9", "title": "t" }] }),
            "This plan has no item i9. Its items are: i1.",
        ),
        (
            serde_json::json!({ "update": [{ "id": "i1", "title": "a" }, { "id": "i1", "title": "b" }] }),
            "Item i1 is changed twice in one call",
        ),
        (
            serde_json::json!({ "add": [{ "title": "t", "before": "i7" }] }),
            "which is not an item of this plan",
        ),
        (
            serde_json::json!({ "order": [] }),
            "The order has to name every item once. It leaves out: i1.",
        ),
        (
            serde_json::json!({ "order": ["i1", "i1"] }),
            "is named twice",
        ),
        (
            serde_json::json!({}),
            "names nothing to add, update or reorder",
        ),
        // An item is in progress only after the person's Start.
        (
            serde_json::json!({ "update": [{ "id": "i1", "status": "in_progress" }] }),
            "An item is in progress only once the person has started the plan",
        ),
    ];
    for (mut change, words) in refused {
        change["baseRevision"] = serde_json::json!(1);
        let why = chat.change(change.clone()).err().unwrap_or_else(|| {
            panic!("this went through: {change}");
        });
        assert!(why.contains(words), "{words}: {why}");
        assert!(why.ends_with("Nothing was changed."), "{why}");
        assert_eq!(chat.plan(), kept, "{words}");
    }
    // What is exactly at each bound fits, in one change.
    let fits = chat
        .change(serde_json::json!({
            "baseRevision": 1,
            "update": [{
                "id": "i1",
                "title": wide(MAX_TITLE),
                "decisions": vec![wide(MAX_LINE); MAX_LINES],
                "questions": vec![wide(MAX_LINE); MAX_LINES],
                "note": wide(MAX_NOTE),
            }],
            "add": (1..MAX_ITEMS).map(|n| item(&format!("Item {n}"))).collect::<Vec<_>>(),
        }))
        .unwrap()
        .plan;
    assert_eq!(fits.items.len(), MAX_ITEMS);
    // A field the tool does not have is refused where it is read.
    let unknown: Result<Change, _> =
        serde_json::from_value(serde_json::json!({ "baseRevision": 0, "remove": ["i1"] }));
    assert!(unknown.unwrap_err().to_string().contains("remove"));
}

#[test]
fn only_newly_linked_tasks_are_asked_about_and_a_refused_link_changes_nothing() {
    let chat = Chat::new();
    let asked = std::cell::RefCell::new(Vec::new());
    let link = |change: serde_json::Value, allowed: bool| {
        update(
            &chat.0,
            "agent",
            serde_json::from_value(change).unwrap(),
            |ids| {
                asked.borrow_mut().push(ids.to_vec());
                if allowed {
                    Ok(())
                } else {
                    Err("task_x is not a task in the ledger.".to_string())
                }
            },
        )
    };
    link(
        serde_json::json!({ "baseRevision": 0, "add": [{ "title": "A", "tasks": ["task_a"] }] }),
        true,
    )
    .unwrap();
    assert_eq!(asked.take(), [vec!["task_a".to_string()]]);
    // Saying a linked task again is no new link; only task_b is asked about.
    link(
        serde_json::json!({ "baseRevision": 1, "update": [{ "id": "i1", "tasks": ["task_a", " task_b ", "task_b"] }] }),
        true,
    )
    .unwrap();
    assert_eq!(
        asked.take(),
        [vec!["task_b".to_string(), "task_b".to_string()]]
    );
    assert_eq!(chat.plan().items[0].tasks, ["task_a", "task_b"]);
    let kept = chat.plan();
    let refused = link(
        serde_json::json!({ "baseRevision": 2, "update": [{ "id": "i1", "tasks": ["task_x"] }] }),
        false,
    )
    .err()
    .unwrap();
    assert_eq!(refused, "task_x is not a task in the ledger.");
    assert_eq!(asked.take(), [vec!["task_x".to_string()]]);
    assert_eq!(chat.plan(), kept);
    // A change that links nothing asks nothing.
    link(
        serde_json::json!({ "baseRevision": 2, "update": [{ "id": "i1", "tasks": ["task_a"] }] }),
        false,
    )
    .unwrap();
    assert!(asked.take().is_empty());
}

#[test]
fn the_gate_holds_from_the_first_item_to_the_persons_start_and_never_again() {
    let chat = Chat::new();
    // No plan: nothing is asked of this chat, and nothing of a key that is
    // no chat's.
    assert_eq!(gate(&chat.key()), Ok(()));
    assert_eq!(gate("chat:has/a/slash"), Ok(()));
    assert_eq!(gate("not-a-chat-key"), Ok(()));

    chat.change(serde_json::json!({ "baseRevision": 0, "add": [item("A"), item("B")] }))
        .unwrap();
    let held = gate(&chat.key()).unwrap_err();
    assert!(held.starts_with(NOT_STARTED), "{held}");
    assert!(held.contains("2 items at revision 1"), "{held}");
    assert!(held.contains("only the person starts it"), "{held}");
    assert!(held.contains("Nothing was created or started"), "{held}");
    assert!(chat.plan().awaits_start());

    // Every item dropped: there is nothing to start, and nothing is held.
    chat.change(serde_json::json!({
        "baseRevision": 1,
        "update": [{ "id": "i1", "status": "dropped" }, { "id": "i2", "status": "dropped" }],
    }))
    .unwrap();
    assert_eq!(gate(&chat.key()), Ok(()));
    assert_eq!(
        start(&chat.0, 2, "octiq-plan-start-x").unwrap_err(),
        NOTHING_TO_START
    );
    // One more item and it holds again: the plan was never started.
    chat.change(serde_json::json!({ "baseRevision": 2, "add": [item("C")] }))
        .unwrap();
    let held = gate(&chat.key()).unwrap_err();
    assert!(held.contains("1 item at revision 3"), "{held}");

    let started = start(&chat.0, 3, "octiq-plan-start-x").unwrap();
    assert_eq!(gate(&chat.key()), Ok(()));
    assert!(!started.awaits_start());
    // Items added after Start do not gate again, and may be in progress.
    let after = chat
        .change(serde_json::json!({
            "baseRevision": 3,
            "add": [item("Added later")],
            "update": [{ "id": "i3", "status": "in_progress" }],
        }))
        .unwrap()
        .plan;
    assert_eq!(after.revision, 4);
    assert_eq!(after.started, started.started, "a change keeps the Start");
    assert_eq!(gate(&chat.key()), Ok(()));
}

#[test]
fn start_is_recorded_once_on_the_revision_the_person_saw() {
    let chat = Chat::new();
    assert_eq!(startable(&chat.0, 0).unwrap_err(), NO_PLAN);
    assert_eq!(start(&chat.0, 0, "t").unwrap_err(), NO_PLAN);
    assert_eq!(get(&chat.0), Ok(None), "a refused Start makes no plan");

    chat.change(serde_json::json!({ "baseRevision": 0, "add": [item("A")] }))
        .unwrap();
    chat.change(serde_json::json!({ "baseRevision": 1, "add": [item("B")] }))
        .unwrap();
    // The person pressed Start on revision 1; the agent has written since.
    let stale = start(&chat.0, 1, "t").unwrap_err();
    assert!(stale.contains("is at revision 2"), "{stale}");
    assert!(stale.contains("pressed on revision 1"), "{stale}");
    assert!(stale.contains("Nothing was started"), "{stale}");
    assert_eq!(chat.plan().started, None);
    assert!(gate(&chat.key()).is_err());

    let turn_id = start_turn_id();
    assert!(turn_id.starts_with(START_TURN_PREFIX));
    let before = now_ms();
    let plan = start(&chat.0, 2, &turn_id).unwrap();
    let started = plan.started.clone().unwrap();
    assert_eq!(started.revision, 2);
    assert_eq!(started.turn_id, turn_id);
    assert!(started.at >= before);
    assert_eq!(plan.revision, 2, "Start changes no item, so no revision");
    assert_eq!(chat.plan(), plan);

    let again = start(&chat.0, 2, "another").unwrap_err();
    assert_eq!(
        again,
        "This plan was already started, at revision 2. It is started once."
    );
    assert_eq!(startable(&chat.0, 2).unwrap_err(), again);
    assert_eq!(chat.plan().started.unwrap().turn_id, turn_id);
    let started = chat.plan().started.unwrap();

    // Whether the agent was handed its turn is kept apart from the Start:
    // false until it was, and marking it moves neither when the plan was
    // started nor on which revision. The turn is the one handed over.
    assert!(!started.told);
    let told_plan = told(&chat.0, "octiq-plan-start-second-try").unwrap();
    let after = told_plan.started.clone().unwrap();
    assert!(after.told);
    assert_eq!(after.turn_id, "octiq-plan-start-second-try");
    assert_eq!((after.at, after.revision), (started.at, started.revision));
    assert_eq!(chat.plan(), told_plan);
    assert_eq!(told(&chat.0, "octiq-plan-start-second-try"), Ok(told_plan));
    // A plan nobody started is not marked told, and no plan is not made.
    let unstarted = Chat::new();
    assert_eq!(told(&unstarted.0, "t").unwrap_err(), NO_PLAN);
    unstarted
        .change(serde_json::json!({ "baseRevision": 0, "add": [item("A")] }))
        .unwrap();
    assert_eq!(told(&unstarted.0, "t").unwrap().started, None);
    // A record from before the mark existed reads as not told.
    let old: Started =
        serde_json::from_value(serde_json::json!({ "at": 1, "revision": 1, "turnId": "t" }))
            .unwrap();
    assert!(!old.told);

    // The host's words to the agent name the revision and what to do now.
    let said = start_message(&plan);
    assert!(said.starts_with("The person pressed Start on this chat's plan, at revision 2."));
    for word in [
        "plan_read",
        "plan_update",
        "decided items",
        "do not wait for another Start",
    ] {
        assert!(said.contains(word), "{word}: {said}");
    }
}

#[test]
fn an_answer_says_what_the_agent_wrote_and_counts_only_what_the_ledger_holds() {
    let chat = Chat::new();
    // No plan: revision 0, nothing to start, and no stamp made up for it.
    let none = serde_json::to_value(view(&chat.0, None, None)).unwrap();
    assert_eq!(
        none,
        serde_json::json!({ "chatId": chat.0, "revision": 0, "items": [], "awaitsStart": false })
    );

    chat.change(serde_json::json!({
        "baseRevision": 0,
        "add": [
            { "title": "Linked", "tasks": ["done", "running", "failed", "waiting", "closed", "gone"] },
            { "title": "Not linked" },
        ],
    }))
    .unwrap();
    let task = |id: &str, state| {
        (
            id.to_string(),
            LinkedTask {
                id: id.into(),
                run_id: "run_1".into(),
                title: format!("Task {id}"),
                state,
                coordinator: chat.key(),
            },
        )
    };
    let ledger: BTreeMap<String, LinkedTask> = [
        task("done", LinkedState::Done),
        task("running", LinkedState::Running),
        task("failed", LinkedState::Failed),
        task("waiting", LinkedState::Waiting),
        task("closed", LinkedState::Closed),
    ]
    .into();
    let said = serde_json::to_value(view(&chat.0, get(&chat.0).unwrap(), Some(&ledger))).unwrap();
    assert_eq!(said["awaitsStart"], true);
    assert_eq!(said["updatedBy"], "OCTIQ BE");
    assert_eq!(
        said["items"][0]["progress"],
        serde_json::json!({
            "total": 4, "done": 1, "running": 1, "failed": 1, "waiting": 1,
            "closed": 1, "unknown": 1,
        })
    );
    // The tasks the ledger holds, in the item's order; who coordinates a
    // task is the host's own check and is not said.
    let linked = said["items"][0]["linked"].as_array().unwrap();
    assert_eq!(linked.len(), 5);
    assert_eq!(
        linked[0],
        serde_json::json!({ "id": "done", "runId": "run_1", "title": "Task done", "state": "done" })
    );
    // The agent's own list of ids is still there, the missing one included.
    assert_eq!(said["items"][0]["tasks"].as_array().unwrap().len(), 6);
    // An item with no linked task has no progress, not a row of zeros.
    assert!(said["items"][1].get("progress").is_none(), "{said}");
    assert!(said["items"][1].get("linked").is_none(), "{said}");
    // A ledger that could not be read: the progress is left out.
    let unread = serde_json::to_value(view(&chat.0, get(&chat.0).unwrap(), None)).unwrap();
    assert!(unread["items"][0].get("progress").is_none(), "{unread}");
    assert_eq!(unread["items"][0]["tasks"].as_array().unwrap().len(), 6);
}

/// Progress is the host's for each answer: nothing of it is kept, and
/// nothing an agent sends as progress is read.
#[test]
fn progress_is_never_stored_and_never_taken_from_the_agent() {
    let chat = Chat::new();
    let sent: Result<Change, _> = serde_json::from_value(serde_json::json!({
        "baseRevision": 0,
        "add": [{ "title": "A", "progress": { "done": 9 } }],
    }));
    assert!(sent.unwrap_err().to_string().contains("progress"));
    chat.change(
        serde_json::json!({ "baseRevision": 0, "add": [{ "title": "A", "tasks": ["t1"] }] }),
    )
    .unwrap();
    let kept = std::fs::read_to_string(path(&chat.0).unwrap()).unwrap();
    for word in ["progress", "linked", "awaitsStart", "chatId"] {
        assert!(!kept.contains(word), "{word} is kept: {kept}");
    }
    // Nor does a kept file that says so start a plan or count for one.
    let mut forged: serde_json::Value = serde_json::from_str(&kept).unwrap();
    forged["awaitsStart"] = serde_json::json!(false);
    forged["items"][0]["progress"] = serde_json::json!({ "done": 9 });
    std::fs::write(path(&chat.0).unwrap(), forged.to_string()).unwrap();
    assert!(chat.plan().awaits_start());
    let said = serde_json::to_value(view(&chat.0, get(&chat.0).unwrap(), None)).unwrap();
    assert!(said["items"][0].get("progress").is_none(), "{said}");
}

#[test]
fn a_chat_id_that_is_not_a_file_name_has_no_plan_and_gets_none() {
    for id in [
        "",
        "a/b",
        "..",
        "a\\b",
        "con:1",
        "x y",
        "ünï",
        &"a".repeat(129),
    ] {
        assert_eq!(get(id).unwrap_err(), BAD_CHAT, "{id:?}");
        let refused = update(
            id,
            "agent",
            serde_json::from_value(serde_json::json!({ "baseRevision": 0, "add": [item("A")] }))
                .unwrap(),
            |_| Ok(()),
        )
        .err()
        .unwrap();
        assert_eq!(refused, BAD_CHAT, "{id:?}");
        // The gate asks nothing of a key no plan can be kept for.
        assert_eq!(gate(&format!("chat:{id}")), Ok(()), "{id:?}");
    }
    // The name is the chat's id behind a prefix, in the chats folder.
    let chat = Chat::new();
    let path = path(&chat.0).unwrap();
    assert_eq!(
        path.file_name().unwrap().to_string_lossy(),
        format!("plan_{}.json", chat.0)
    );
    assert_eq!(
        path.parent().unwrap(),
        crate::profile::profile_dir().join("chats")
    );
}

#[test]
fn a_plan_that_cannot_be_understood_is_an_error_and_holds_the_gate() {
    let chat = Chat::new();
    chat.change(serde_json::json!({ "baseRevision": 0, "add": [item("A")] }))
        .unwrap();
    let file = path(&chat.0).unwrap();
    std::fs::write(&file, b"{ not a plan").unwrap();
    let why = get(&chat.0).unwrap_err();
    assert!(why.contains("could not be understood"), "{why}");
    assert!(why.contains(&format!("plan_{}.json", chat.0)), "{why}");
    // Never read as "no plan": that would lift the gate, and the next
    // change would start the list again from nothing.
    assert_eq!(gate(&chat.key()).unwrap_err(), why);
    let refused = chat
        .change(serde_json::json!({ "baseRevision": 0, "add": [item("B")] }))
        .err()
        .unwrap();
    assert_eq!(refused, why);
    assert_eq!(std::fs::read(&file).unwrap(), b"{ not a plan");
}

/// The profile rules, for this store: with the folder away a read is the
/// profile's sentence and never "no plan", a change and a Start are refused
/// whole in the same words, nothing makes the folder again, and all of it
/// goes through unchanged once the folder is back.
#[test]
fn a_profile_folder_that_is_away_is_an_error_never_no_plan() {
    use crate::profile::tests::{everything_in, Home};
    let home = Home::with_a_configured_base();
    let _process = crate::profile::started_in(&home.dir);
    let dir = crate::profile::profile_dir();
    crate::profile_lock::acquire("server").unwrap();
    let chat = Chat::new();
    chat.change(serde_json::json!({ "baseRevision": 0, "add": [item("A")] }))
        .unwrap();
    let kept = chat.plan();
    let add = || chat.change(serde_json::json!({ "baseRevision": 1, "add": [item("B")] }));

    // Its drive is gone.
    home.unplug();
    let away = crate::profile::available().unwrap_err();
    assert!(away.contains("nothing was saved"), "{away}");
    assert_eq!(get(&chat.0).unwrap_err(), away);
    assert_eq!(add().err().unwrap(), away);
    assert_eq!(startable(&chat.0, 1).unwrap_err(), away);
    assert_eq!(start(&chat.0, 1, "t").unwrap_err(), away);
    // The gate is not lifted by a folder that is away.
    assert_eq!(gate(&chat.key()).unwrap_err(), away);
    forget(&chat.0);
    home.plug_back();
    assert_eq!(
        chat.plan(),
        kept,
        "nothing was written, forgotten or started"
    );

    // The folder itself is moved away, with its base still there: whatever
    // made a folder and its parents would make the profile again.
    home.move_away();
    let away = crate::profile::available().unwrap_err();
    assert_eq!(get(&chat.0).unwrap_err(), away);
    assert_eq!(add().err().unwrap(), away);
    assert_eq!(start(&chat.0, 1, "t").unwrap_err(), away);
    assert_eq!(gate(&chat.key()).unwrap_err(), away);
    forget(&chat.0);
    assert!(!dir.exists(), "the plan made the profile folder again");
    home.move_back();
    assert_eq!(chat.plan(), kept);

    // Another folder stands at the path: it is not this server's, so it is
    // not read as a chat with no plan and nothing is written into it.
    home.replace();
    let put_there = everything_in(&home.profile());
    let replaced = crate::profile::available().unwrap_err();
    assert!(
        replaced.contains("is not the folder OctiqFlow started with"),
        "{replaced}"
    );
    assert_eq!(get(&chat.0).unwrap_err(), replaced);
    assert_eq!(add().err().unwrap(), replaced);
    assert_eq!(start(&chat.0, 1, "t").unwrap_err(), replaced);
    assert_eq!(gate(&chat.key()).unwrap_err(), replaced);
    forget(&chat.0);
    assert_eq!(everything_in(&home.profile()), put_there);
    home.move_back();

    // Back: the same calls go through, from the plan as it was.
    assert_eq!(chat.plan(), kept);
    assert_eq!(add().unwrap().plan.revision, 2);
    assert!(start(&chat.0, 2, "t").unwrap().started.is_some());
    assert_eq!(gate(&chat.key()), Ok(()));
}

/// A Start is save-first: when its save does not happen, in a profile that
/// is there, it is refused in the save's words and the plan is as it was,
/// not started and still holding the gate. A change is refused the same way.
#[test]
fn a_start_that_cannot_be_saved_is_refused_and_the_plan_stays_unstarted() {
    let chat = Chat::new();
    chat.change(serde_json::json!({ "baseRevision": 0, "add": [item("A")] }))
        .unwrap();
    let kept = chat.plan();
    let (started, changed) = while_writes_fail(|| {
        (
            start(&chat.0, 1, "octiq-plan-start-x"),
            chat.change(serde_json::json!({ "baseRevision": 1, "add": [item("B")] }))
                .map(|updated| updated.plan),
        )
    });
    let why = started.unwrap_err();
    assert_eq!(why, "The plan could not be saved: the disk is full");
    assert_eq!(changed.unwrap_err(), why);
    assert_eq!(chat.plan(), kept);
    assert_eq!(chat.plan().started, None);
    assert!(gate(&chat.key()).unwrap_err().starts_with(NOT_STARTED));
    // The same Start goes through once a save can happen.
    assert!(start(&chat.0, 1, "octiq-plan-start-x")
        .unwrap()
        .started
        .is_some());
}

/// A save goes through a temporary of its own and a rename, so a save that
/// fails leaves the plan as it was and no half-written file beside it.
#[test]
fn a_failed_save_leaves_the_plan_as_it_was_and_nothing_beside_it() {
    let chat = Chat::new();
    chat.change(serde_json::json!({ "baseRevision": 0, "add": [item("A")] }))
        .unwrap();
    // A folder where the file is: a rename onto it fails on every system.
    let file = path(&chat.0).unwrap();
    let aside = file.with_extension("kept");
    std::fs::rename(&file, &aside).unwrap();
    crate::profile::make_dir(&file.join("in-the-way")).unwrap();
    let why = write(&chat.0, &Plan::default()).unwrap_err();
    assert!(!why.is_empty());
    let left: Vec<String> = std::fs::read_dir(file.parent().unwrap())
        .unwrap()
        .flatten()
        .map(|entry| entry.file_name().to_string_lossy().into_owned())
        // This chat's own: other tests save into the same folder meanwhile.
        .filter(|name| name.starts_with(&format!(".plan_{}.", chat.0)))
        .collect();
    assert!(left.is_empty(), "a half-written plan was left: {left:?}");
    std::fs::remove_dir_all(&file).unwrap();
    std::fs::rename(&aside, &file).unwrap();
    assert_eq!(chat.plan().items.len(), 1);
}
