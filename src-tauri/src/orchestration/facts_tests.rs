//! Facts the run panel reads and cannot work out for itself, through the
//! commands the page calls: what each attempt's worker has used and holds
//! (`orchestration_snapshot`), and which chats coordinate a run
//! (`chat_index_list`). Who a wait is for is tested where gates and native
//! decisions are (`lifecycle.rs`, `peer_request.rs`).

use super::tests::{run, running_worker};
use super::*;
use crate::agent_usage::{Attribution, ChatRole, ContextHeld, Reading, TokenUsage};

/// The host's services over `store`, with a roster of nobody.
fn services(store: Arc<OrchestrationStore>) -> crate::dispatch::Services {
    crate::dispatch::Services {
        workspaces: Arc::new(crate::workspaces::WorkspaceState::with_projects(vec![
            serde_json::from_value(json!({
                "id": "workspace", "name": "Project", "primary_path": "/tmp", "paths": [],
            }))
            .unwrap(),
        ])),
        chats: Arc::new(ChatManager::default()),
        watch: Arc::new(crate::file_watch::FileWatchState::default()),
        git_watch: Arc::new(crate::git_watch::GitWatchState::default()),
        orchestrations: store,
        ptys: Arc::new(crate::pty::PtyManager::default()),
        handovers: crate::handover::Wiring::scratch(),
    }
}

fn ask(
    svc: &crate::dispatch::Services,
    command: &str,
    args: serde_json::Value,
) -> serde_json::Value {
    crate::dispatch::dispatch(svc, command, args).unwrap()
}

/// An attempt carries what the host counted for its worker's chat, and an
/// attempt nothing was counted for carries neither field: no zeros, and no
/// context from a token count that came without its window.
#[test]
fn the_snapshot_puts_what_was_counted_on_an_attempt_and_nothing_on_the_rest() {
    let store = Arc::new(OrchestrationStore::default());
    let run = run(&store);
    let counted = running_worker(&store, &run);
    let silent = running_worker(&store, &run);
    let svc = services(store.clone());
    let used = TokenUsage {
        input: 41_000,
        cached_input: 39_500,
        cache_write: 0,
        output: 2_300,
        reasoning: 1_100,
    };
    svc.chats
        .usage
        .record(
            &counted.worker_chat_key,
            ChatAgent::Codex,
            &Reading {
                usage: used,
                thread_total: None,
            },
            1,
            || {
                Some(Attribution {
                    agent_id: "agent_dev".into(),
                    agent_name: "Dev".into(),
                    role: ChatRole::Worker,
                    task_id: Some(counted.task_id.clone()),
                    run_id: Some(run.id.clone()),
                })
            },
        )
        .unwrap();
    svc.chats.usage.note_context(
        &counted.worker_chat_key,
        ContextHeld {
            tokens: Some(41_000),
            window: Some(272_000),
        },
    );
    svc.chats.usage.note_context(
        &silent.worker_chat_key,
        ContextHeld {
            tokens: Some(5_000),
            window: None,
        },
    );

    let page = ask(&svc, "orchestration_snapshot", json!({ "runId": run.id }));
    let attempt = |id: &str| {
        page["attempts"]
            .as_array()
            .unwrap()
            .iter()
            .find(|attempt| attempt["id"] == id)
            .unwrap()
            .clone()
    };
    assert_eq!(
        attempt(&counted.id)["usage"],
        json!({
            "input": 41_000, "cachedInput": 39_500, "cacheWrite": 0,
            "output": 2_300, "reasoning": 1_100,
        })
    );
    assert_eq!(
        attempt(&counted.id)["context"],
        json!({ "tokens": 41_000, "window": 272_000 })
    );
    let nothing = attempt(&silent.id);
    assert!(nothing.get("usage").is_none(), "{nothing}");
    assert!(nothing.get("context").is_none(), "{nothing}");

    // Read for the answer, not kept in the ledger.
    assert!(store
        .inner
        .lock()
        .unwrap()
        .data
        .attempts
        .values()
        .all(|attempt| attempt.usage.is_none() && attempt.context.is_none()));
    // Nor believed from one: an attempt as a file would hold it has none.
    let mut forged = attempt(&counted.id);
    forged["usage"]["input"] = json!(1);
    let read: Attempt = serde_json::from_value(forged).unwrap();
    assert!(read.usage.is_none() && read.context.is_none());

    // The coordinator's read of one task in full carries them too.
    let agent = ask(
        &svc,
        "orchestration_snapshot",
        json!({ "actorChatKey": "chat:master", "runId": run.id, "taskId": counted.task_id }),
    );
    assert_eq!(agent["attempts"][0]["usage"]["input"], 41_000);
    assert_eq!(agent["attempts"][0]["context"]["window"], 272_000);
}

/// The chat list, which the page draws before it has the ledger, marks a
/// chat that coordinates a run the person has not archived. A stopped run
/// is still one; an archived one is not. Nothing of it is stored in the
/// index, and an entry saved back with it is taken without it.
#[test]
fn the_chat_list_says_which_chats_coordinate_a_run_that_is_not_archived() {
    let dir = crate::test_dir::TestDir::new("m2-coordinates");
    let _team = crate::team::use_test_path(dir.0.join("team.json"));
    let store = Arc::new(OrchestrationStore::default());
    let svc = services(store.clone());
    let (lead, plain) = (
        format!("m2-lead-{}", compact_id()),
        format!("m2-plain-{}", compact_id()),
    );
    for id in [&lead, &plain] {
        crate::chat_index::upsert(
            serde_json::from_value(json!({ "id": id, "projectId": "workspace" })).unwrap(),
        )
        .unwrap();
    }
    let entry = |id: &str| {
        ask(&svc, "chat_index_list", json!({}))
            .as_array()
            .unwrap()
            .iter()
            .find(|chat| chat["id"] == id)
            .unwrap_or_else(|| panic!("{id} is listed"))
            .clone()
    };
    let coordinates = |id: &str| entry(id).get("coordinatesRun").cloned();
    assert_eq!((coordinates(&lead), coordinates(&plain)), (None, None));

    let chat = format!("chat:{lead}");
    let run = store
        .create_run(
            chat.clone(),
            "Ship the feature".into(),
            "workspace".into(),
            "/tmp".into(),
            Some(2),
        )
        .unwrap();
    assert_eq!(
        (coordinates(&lead), coordinates(&plain)),
        (Some(json!(true)), None)
    );
    assert_eq!(store.coordinating_chats(), BTreeSet::from([chat.clone()]));
    store
        .stop_run(&chat, run.id.clone(), "Not now".into())
        .unwrap();
    assert_eq!(
        coordinates(&lead),
        Some(json!(true)),
        "stopped, not archived"
    );
    store.set_run_archived(&chat, &run.id, true).unwrap();
    assert_eq!(coordinates(&lead), None);
    store.set_run_archived(&chat, &run.id, false).unwrap();
    let marked = entry(&lead);
    assert_eq!(marked["coordinatesRun"], true);

    // The page saves the entry it was given: the mark is not kept.
    crate::dispatch::dispatch(&svc, "chat_index_save", json!({ "meta": marked })).unwrap();
    let stored = crate::chat_index::list()
        .into_iter()
        .find(|meta| meta.id == lead)
        .unwrap();
    assert!(serde_json::to_value(&stored)
        .unwrap()
        .get("coordinatesRun")
        .is_none());
    assert_eq!(coordinates(&lead), Some(json!(true)), "derived again");
}
