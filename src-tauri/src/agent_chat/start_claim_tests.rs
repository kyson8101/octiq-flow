use super::*;

fn start(manager: Arc<ChatManager>, key: &str) -> Result<(), String> {
    start_session(
        manager,
        Voice::host(key.to_string()),
        "/tmp/project".into(),
        ChatAgent::Claude,
        None,
        None,
        Some("carry on".into()),
        None,
        None,
        None,
        None,
        None,
        None,
        Some("turn-1".into()),
        true,
        None,
    )
}

#[test]
fn lifespan_mark_refuses_a_racing_brand_new_chat_and_extra_directory() {
    let manager = Arc::new(ChatManager::default());
    let _lifecycle = manager.orchestrations.hold_workspace_lifecycle().unwrap();
    let mark = manager.hold_lifespan_checkout("/tmp/project").unwrap();
    let claim = manager.claim_start("chat:known").unwrap();
    // A new id wasn't in the scan's index. It must still see the mark.
    let other = manager.clone();
    let refusal = thread::spawn(move || start(other, "chat:brand-new"))
        .join()
        .unwrap()
        .unwrap_err();
    assert!(refusal.contains("lifespan cleanup"), "{refusal}");
    assert!(manager
        .lifespan_refusal("/tmp/elsewhere", Some(&vec!["/tmp/project/child".into()]))
        .is_err());
    assert!(manager.lifespan_refusal("/tmp/project-other", None).is_ok());
    assert!(!manager.has_process("chat:brand-new"));
    drop(claim);
    drop(mark);
    assert!(manager.lifespan_refusal("/tmp/project", None).is_ok());
}

#[test]
fn lifespan_mark_refuses_a_new_queue_entry_before_acknowledging_it() {
    let manager = ChatManager::default();
    let dir = crate::test_dir::TestDir::new("lifespan-queue").canonicalized();
    let cwd = dir.to_string_lossy().into_owned();
    let turn = || QueuedTurn {
        text: "keep this input".into(),
        images: vec![],
        turn_id: Some("user-racing".into()),
        appended_turn_ids: vec![],
        recorded: true,
        context: Some(QueueContext {
            cwd: cwd.clone(),
            agent: ChatAgent::Codex,
            model: None,
            access: None,
            extra_dirs: None,
            env: None,
            effort: None,
            lite: None,
        }),
    };
    let mark = manager.hold_lifespan_checkout(&cwd).unwrap();
    assert!(manager
        .queue_turn("chat:queued", turn())
        .unwrap_err()
        .contains("lifespan cleanup"));
    assert!(!manager.has_queued_turns("chat:queued"));
    drop(mark);
    manager.queue_turn("chat:queued", turn()).unwrap();
    assert!(manager.has_queued_turns("chat:queued"));
}

#[test]
fn a_claimed_chat_is_started_by_nobody_else() {
    let manager = Arc::new(ChatManager::default());
    let key = "chat:claimed";
    let claim = manager.claim_start(key).expect("nothing runs there");
    assert!(
        manager.hold_start(key).unwrap().is_none(),
        "recovery borrows its own claim"
    );
    assert!(!manager.claimed_elsewhere(key), "the claimant's own start");

    let other = manager.clone();
    let (refused, second) = thread::spawn(move || {
        (
            start(other.clone(), key),
            other.claim_start(key).map(|_| ()),
        )
    })
    .join()
    .unwrap();
    // In the words a page already falls back to sending on.
    assert_eq!(refused, Err(format!("chat '{key}' is already running")));
    assert_eq!(second, Err(format!("chat '{key}' is already running")));
    assert!(!manager.has_process(key), "nothing was started");

    drop(claim);
    let other = manager.clone();
    let free = thread::spawn(move || !other.claimed_elsewhere(key))
        .join()
        .unwrap();
    assert!(free, "the claim goes with its guard");
}

#[test]
fn a_chat_with_a_process_cannot_be_claimed() {
    let manager = ChatManager::default();
    let key = "chat:claim-live";
    manager.test_launch(key);
    assert_eq!(
        manager.claim_start(key).map(|_| ()),
        Err(format!("chat '{key}' is already running"))
    );
    manager.test_end(key);
    assert!(manager.claim_start(key).is_ok());

    // A one-shot process being replaced is as good as running.
    manager.handoffs.lock().unwrap().insert(key.to_string());
    assert!(manager.claim_start(key).is_err());
}

#[test]
fn m13_batch_removal_keeps_start_and_queue_guards_and_releases_every_refusal() {
    let dir = crate::test_dir::TestDir::new("m13-batch-holds").canonicalized();
    let a = dir.join("a").to_string_lossy().into_owned();
    let b = dir.join("b").to_string_lossy().into_owned();
    for starting in [true, false] {
        let manager = ChatManager::default();
        let key = "chat:m13-shared";
        manager.test_remember_start_with_extra(key, &a, Some(vec![b.clone()]));
        let claim = starting.then(|| manager.claim_start(key).unwrap());
        if !starting {
            manager
                .queue_turn(
                    key,
                    QueuedTurn {
                        text: "keep this input".into(),
                        images: vec![],
                        turn_id: None,
                        appended_turn_ids: vec![],
                        recorded: true,
                        context: Some(QueueContext {
                            cwd: a.clone(),
                            agent: ChatAgent::Codex,
                            model: None,
                            access: None,
                            extra_dirs: Some(vec![b.clone()]),
                            env: None,
                            effort: None,
                            lite: None,
                        }),
                    },
                )
                .unwrap();
        }
        let error = crate::worktree_lifespan::hold_removals(&manager, &[&a, &b])
            .err()
            .expect("starting/queued chat must refuse the entire batch");
        assert!(
            error.contains(if starting {
                "already running"
            } else {
                "queued turn"
            }),
            "{error}"
        );
        for path in [&a, &b] {
            assert!(manager.test_lifespan_admission(path).is_ok());
        }
        drop(claim);
        manager.forget_queued_turns(key);
        let held = crate::worktree_lifespan::hold_removals(&manager, &[&a, &b, &a])
            .expect("one claim for the shared stopped chat");
        for path in [&a, &b] {
            assert!(manager.test_lifespan_admission(path).is_err());
            assert!(manager.test_lifespan_queue(path).is_err());
        }
        assert!(manager.claim_start(key).is_err());
        drop(held);
        assert!(manager.claim_start(key).is_ok());
        for path in [&a, &b] {
            assert!(manager.test_lifespan_admission(path).is_ok());
        }
    }
}
