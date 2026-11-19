//! `chat_switch_runtime`: every rule of the contract, positive and negative,
//! against the real stores a server loads and stand-in processes. No
//! provider CLI is started: a queued message is "started" by a closure that
//! records it, and a chat is never started through `chat_start` here (the
//! real-server script `scripts/test-runtime-switch.mjs` does that with stub
//! CLIs).
use super::*;
use crate::profile::tests::Home;
use std::path::PathBuf;

/// Every test seeds the provider probe, which is one global.
static PROBE: Mutex<()> = Mutex::new(());

fn install(missing: &[ChatAgent]) {
    crate::agents::seed_probe_for_test(
        ChatAgent::ALL
            .into_iter()
            .filter(|agent| !missing.contains(agent))
            .map(|agent| (agent.id().to_string(), format!("/stub/{}", agent.id())))
            .collect(),
    );
}

struct World {
    _probe: std::sync::MutexGuard<'static, ()>,
    _pin: crate::profile::Started,
    _roster: crate::team::TestTeamPath,
    home: Home,
    path: PathBuf,
    manager: Arc<ChatManager>,
    _svc: crate::dispatch::Services,
}

/// A chat of a registered agent, listed, with the start context a launch
/// remembers.
struct Chat {
    key: String,
    id: String,
}

impl World {
    fn new() -> Self {
        let probe = PROBE.lock().unwrap_or_else(|e| e.into_inner());
        install(&[]);
        let home = Home::with_a_configured_base();
        let pin = crate::profile::started_in(&home.dir);
        let path = crate::profile::profile_dir().join("team.json");
        let roster = crate::team::use_test_path(path.clone());
        // The ledger and the chats as a server loads them from its profile.
        let svc = crate::dispatch::Services::at_profile();
        Self {
            _probe: probe,
            _pin: pin,
            _roster: roster,
            home,
            path,
            manager: svc.chats.clone(),
            _svc: svc,
        }
    }

    fn agent(&self, provider: &str, model: &str) -> crate::team::TeamAgent {
        crate::team::save(
            &self.path,
            serde_json::from_value(json!({
                "name": format!("Ada {}", uuid::Uuid::new_v4().simple()),
                "role": "Owns the backend and its tests.",
                "agent": provider, "model": model, "effort": "high", "access": "full"
            }))
            .unwrap(),
        )
        .unwrap()
    }

    /// A listed chat of a new registered agent on Claude opus, with a Claude
    /// session and no process.
    fn chat(&self) -> Chat {
        self.chat_of(&self.agent("claude", "claude-opus-5-5"))
    }

    fn chat_of(&self, agent: &crate::team::TeamAgent) -> Chat {
        let id = format!("rs-{}", uuid::Uuid::new_v4().simple());
        let key = format!("chat:{id}");
        crate::team::record_lead(&self.path, &key, agent, "workspace", false).unwrap();
        crate::chat_index::upsert(
            serde_json::from_value(json!({
                "id": id, "projectId": "workspace", "updatedAt": 100,
                "modelId": crate::orchestration::model_id(agent.agent, Some(&agent.model)),
                "effort": agent.effort, "access": "full", "sessionId": "claude-session-1",
            }))
            .unwrap(),
        )
        .unwrap();
        self.manager.remember_start(
            &key,
            StartContext {
                defaults: None,
                cwd: "/tmp/project".into(),
                agent: agent.agent,
                model: Some(agent.model.clone()),
                access: Some(Access::Full),
                extra_dirs: None,
                env: None,
                effort: agent.effort.clone(),
                lite: None,
                session_id: Some("claude-session-1".into()),
            },
        );
        Chat { key, id }
    }

    fn switch(
        &self,
        chat: &Chat,
        agent: ChatAgent,
        model: &str,
        effort: Option<&str>,
    ) -> Result<Answer, String> {
        chat_switch_runtime_impl(
            &self.manager,
            &chat.key,
            Request {
                agent,
                model: Some(model.into()),
                effort: effort.map(str::to_string),
            },
        )
    }

    /// The chat coordinates a run, so the ledger keeps its resume context
    /// (it keeps one only for a coordinator or a worker).
    fn coordinates(&self, chat: &Chat) {
        self.manager
            .orchestrations
            .create_run_with_mode(
                chat.key.clone(),
                "Coordinate".into(),
                "workspace".into(),
                "/tmp".into(),
                None,
                crate::git_ops::workflow::WorkspaceMode::Direct,
            )
            .unwrap();
        self.manager.remember_start(&chat.key, self.start(chat));
    }

    fn start(&self, chat: &Chat) -> StartContext {
        self.manager
            .start_context(&chat.key)
            .expect("a start context")
    }
}

impl Drop for Chat {
    fn drop(&mut self) {
        let _ = crate::chat_index::remove(&self.id);
        crate::transcript::forget(&self.key);
    }
}

fn events(chat: &Chat, kind: &str) -> Vec<Value> {
    crate::transcript::of_type(&chat.key, kind)
}

fn settings(agent: ChatAgent, model: &str, effort: Option<&str>) -> Settings {
    Settings {
        agent,
        model: Some(model.into()),
        effort: effort.map(str::to_string),
        access: Access::Full,
    }
}

// ---- the record ------------------------------------------------------------

fn record_event(chat: &Chat, event: Value) {
    record_chat_event_synced(&chat.key, event).unwrap();
}

fn auto_switch(chat: &Chat, from: &Settings, to: &Settings) {
    record_event(
        chat,
        json!({ "type": "octiq_provider_switched", "from": from.agent, "previousSettings": from,
            "agent": to.agent, "model": to.model, "effort": to.effort, "access": to.access,
            "message": "claude is unavailable." }),
    );
}

#[test]
fn an_automatic_chain_never_moves_the_baseline_and_a_person_pick_becomes_it() {
    let w = World::new();
    let chat = w.chat();
    let opus = settings(ChatAgent::Claude, "claude-opus-5-5", Some("high"));
    let codex = settings(ChatAgent::Codex, "gpt-5.6-sol", Some("high"));
    let pi = settings(ChatAgent::Pi, "anthropic/claude-opus-5-5", Some("high"));
    assert_eq!(recorded(&chat.key).unwrap(), Recorded::default());
    auto_switch(&chat, &opus, &codex);
    auto_switch(&chat, &codex, &pi);
    let found = recorded(&chat.key).unwrap();
    assert_eq!(
        found.baseline.as_ref(),
        Some(&opus),
        "the first runtime it left"
    );
    assert_eq!(found.current.as_ref(), Some(&pi));
    assert!(!found.last_by_person && !found.handoff_owed);
    // The person picks Codex: it is the new baseline, and the fallback is over.
    record_event(
        &chat,
        json!({ "type": "octiq_provider_switched", "byPerson": true, "handoffOwed": true,
            "agent": "codex", "model": "gpt-5.6-sol", "effort": "high", "access": "full" }),
    );
    let found = recorded(&chat.key).unwrap();
    assert_eq!(found.baseline.as_ref(), Some(&codex));
    assert_eq!(found.current_runtime(), Some(&codex));
    assert!(found.handoff_owed);
    // An automatic switch after it leaves that baseline alone and pays no debt.
    auto_switch(&chat, &codex, &opus);
    let found = recorded(&chat.key).unwrap();
    assert_eq!(found.baseline.as_ref(), Some(&codex));
    assert_eq!(
        found.current_runtime(),
        Some(&opus),
        "the host's current runtime is the automatic one"
    );
    assert!(!found.last_by_person, "the last change was automatic");
    assert!(
        !found.handoff_owed,
        "a change that builds its own handoff pays the debt"
    );
}

#[test]
fn pending_and_the_handoff_debt_are_read_back_from_the_record() {
    let w = World::new();
    let chat = w.chat();
    record_event(
        &chat,
        json!({ "type": "octiq_runtime_pending", "agent": "codex", "model": "gpt-5.6-sol", "effort": null }),
    );
    assert_eq!(
        recorded(&chat.key).unwrap().pending,
        Some(PendingRuntime {
            agent: ChatAgent::Codex,
            model: Some("gpt-5.6-sol".into()),
            effort: None
        })
    );
    record_event(&chat, json!({ "type": "octiq_runtime_pending_cleared" }));
    assert_eq!(recorded(&chat.key).unwrap().pending, None);
    record_event(
        &chat,
        json!({ "type": "octiq_runtime_pending", "agent": "codex", "model": "gpt-5.6-sol", "effort": null }),
    );
    // Applied: the person's switch clears it.
    record_event(
        &chat,
        json!({ "type": "octiq_provider_switched", "byPerson": true, "handoffOwed": true,
            "agent": "codex", "model": "gpt-5.6-sol", "effort": null, "access": "full" }),
    );
    let found = recorded(&chat.key).unwrap();
    assert_eq!(found.pending, None);
    assert!(found.handoff_owed);
    record_event(&chat, json!({ "type": "octiq_runtime_handoff_taken" }));
    assert!(!recorded(&chat.key).unwrap().handoff_owed);
}

// ---- who may switch --------------------------------------------------------

#[test]
fn only_a_registered_agents_own_listed_chat_can_switch() {
    let w = World::new();
    let chat = w.chat();
    let refused = |key: &str| {
        chat_switch_runtime_impl(
            &w.manager,
            key,
            Request {
                agent: ChatAgent::Codex,
                model: Some("gpt-5.6-sol".into()),
                effort: None,
            },
        )
        .unwrap_err()
    };
    // A worker, by durable identity.
    assert!(refused("chat:orch-abc").contains("worker"));
    // Not a chat.
    assert!(refused("terminal-1").contains("Name a chat"));
    // A chat with no registered agent.
    let plain = format!("plain-{}", uuid::Uuid::new_v4().simple());
    crate::chat_index::upsert(
        serde_json::from_value(json!({ "id": plain, "projectId": "workspace", "updatedAt": 1 }))
            .unwrap(),
    )
    .unwrap();
    assert!(refused(&format!("chat:{plain}")).contains("registered agent"));
    let _ = crate::chat_index::remove(&plain);
    // A front desk only routes.
    let desk = crate::team::create_front_desk(&w.path, Default::default()).unwrap();
    let desk_chat = format!("rs-desk-{}", uuid::Uuid::new_v4().simple());
    let desk_key = format!("chat:{desk_chat}");
    crate::team::front_desk_brief(&w.path, &desk_key, &desk.id, "route me", &[]).unwrap();
    crate::chat_index::upsert(
        serde_json::from_value(
            json!({ "id": desk_chat, "projectId": "workspace", "updatedAt": 1 }),
        )
        .unwrap(),
    )
    .unwrap();
    assert!(refused(&desk_key).contains("front desk"));
    let _ = crate::chat_index::remove(&desk_chat);
    // A chat that is not in the chat list.
    let ghost = format!("chat:ghost-{}", uuid::Uuid::new_v4().simple());
    let agent = w.agent("claude", "claude-opus-5-5");
    crate::team::record_lead(&w.path, &ghost, &agent, "workspace", false).unwrap();
    assert!(refused(&ghost).contains("not in the chat list"));
    // An agent that was removed.
    let gone = w.agent("claude", "claude-opus-5-5");
    let gone_chat = w.chat_of(&gone);
    crate::team::delete(&w.path, &gone.id).unwrap();
    assert!(refused(&gone_chat.key).contains("registered agent"));
    // Nothing of the real chat moved.
    assert_eq!(w.start(&chat).agent, ChatAgent::Claude);
}

#[test]
fn a_chat_being_completed_is_not_switched() {
    let w = World::new();
    let chat = w.chat();
    w.manager
        .completing
        .lock()
        .unwrap()
        .insert(chat.key.clone(), "octiq-complete-1".into());
    let why = w
        .switch(&chat, ChatAgent::Codex, "gpt-5.6-sol", None)
        .unwrap_err();
    assert!(why.contains("wrap-up"), "{why}");
    assert_eq!(w.start(&chat).agent, ChatAgent::Claude);
    assert!(events(&chat, "octiq_runtime_change_prepared").is_empty());
}

#[test]
fn a_request_is_validated_before_anything_changes() {
    let w = World::new();
    let chat = w.chat();
    for (agent, model, effort, said) in [
        (ChatAgent::Codex, "claude-opus-5-5", None, "does not belong"),
        (ChatAgent::Codex, "../x", None, "does not belong"),
        (ChatAgent::Codex, "gpt-5.6-sol", Some("loud"), "effort"),
        (
            ChatAgent::Antigravity,
            "gemini-3.8-flash-high",
            Some("high"),
            "effort",
        ),
    ] {
        let why = w.switch(&chat, agent, model, effort).unwrap_err();
        assert!(why.contains(said), "{model}: {why}");
    }
    // Guarded Auto and Manual cannot move to Antigravity, which cannot ask.
    for access in [Access::Auto, Access::Manual] {
        let mut start = w.start(&chat);
        start.access = Some(access);
        w.manager.remember_start(&chat.key, start);
        let why = w
            .switch(&chat, ChatAgent::Antigravity, "gemini-3.8-flash-high", None)
            .unwrap_err();
        assert!(why.contains("cannot ask"), "{why}");
    }
    // Read keeps its mapping.
    let mut start = w.start(&chat);
    start.access = Some(Access::Read);
    w.manager.remember_start(&chat.key, start);
    assert_eq!(
        w.switch(&chat, ChatAgent::Antigravity, "gemini-3.8-flash-high", None)
            .unwrap()
            .state,
        "switched"
    );
    // A CLI that is not installed.
    install(&[ChatAgent::Codex]);
    let why = w
        .switch(&chat, ChatAgent::Codex, "gpt-5.6-sol", None)
        .unwrap_err();
    assert!(why.contains("unavailable"), "{why}");
    install(&[]);
    // Refused ones prepared nothing and changed nothing.
    assert_eq!(events(&chat, "octiq_runtime_change_prepared").len(), 1);
}

#[test]
fn a_switch_whose_intent_cannot_be_saved_is_refused_whole() {
    let w = World::new();
    let chat = w.chat();
    let before = w.start(&chat);
    w.home.move_away();
    let why = crate::profile::available().expect_err("the profile folder is away");
    let refused = w
        .switch(&chat, ChatAgent::Codex, "gpt-5.6-sol", None)
        .unwrap_err();
    assert_eq!(refused, why, "refused in the profile's own words");
    assert_eq!(w.start(&chat), before);
    w.home.move_back();
    assert!(events(&chat, "octiq_provider_switched").is_empty());
}

// ---- switched: nothing was running -----------------------------------------

#[test]
fn an_idle_chat_changes_provider_now_and_keeps_its_registration() {
    let w = World::new();
    let agent = w.agent("claude", "claude-opus-5-5");
    let chat = w.chat_of(&agent);
    w.coordinates(&chat);
    // Cooldown: Codex looks limited, and the person can see it is back.
    w.manager
        .failover
        .limited(ChatAgent::Codex, None, None, crate::auto_resume::unix_now());
    assert!(w
        .manager
        .failover
        .blocked(ChatAgent::Codex, None, crate::auto_resume::unix_now()));
    let process = w.manager.test_hold(&chat.key, ChatAgent::Claude, false);
    let answer = w
        .switch(&chat, ChatAgent::Codex, "gpt-5.6-sol", Some("high"))
        .unwrap();
    assert_eq!(
        answer,
        Answer {
            state: "switched",
            agent: ChatAgent::Codex,
            model: Some("gpt-5.6-sol".into()),
            effort: Some("high".into()),
            access: Access::Full
        }
    );
    assert!(process.gone(), "the idle process was ended");
    assert!(!w.manager.has_process(&chat.key));
    assert!(
        !w.manager
            .failover
            .blocked(ChatAgent::Codex, None, crate::auto_resume::unix_now()),
        "the person's pick overrides the cooldown"
    );
    // The start context and the ledger's resume context: replaced, never removed.
    let start = w.start(&chat);
    assert_eq!(
        (
            start.agent,
            start.model.as_deref(),
            start.session_id.clone()
        ),
        (ChatAgent::Codex, Some("gpt-5.6-sol"), None)
    );
    assert_eq!(start.access, Some(Access::Full));
    assert_eq!(
        start.defaults.as_ref().map(|d| d.agent),
        Some(ChatAgent::Codex),
        "the new baseline"
    );
    let saved = w
        .manager
        .orchestrations
        .saved_resume_context(&chat.key)
        .expect("a resume context");
    assert_eq!(
        (saved.agent, saved.session_id.clone()),
        (ChatAgent::Codex, None)
    );
    // The record.
    let prepared = events(&chat, "octiq_runtime_change_prepared");
    assert_eq!(prepared.len(), 1);
    assert!(prepared[0]["reason"].as_str().unwrap().contains("person"));
    let switched = events(&chat, "octiq_provider_switched");
    assert_eq!(switched.len(), 1);
    assert_eq!(switched[0]["byPerson"], true);
    assert_eq!(switched[0]["handoffOwed"], true);
    let message = switched[0]["message"].as_str().unwrap();
    assert!(
        message.contains("by your choice") && message.contains("registration is unchanged"),
        "{message}"
    );
    assert!(!message.contains("unavailable"));
    // The index row follows.
    let row = crate::chat_index::find(&chat.id).unwrap().unwrap();
    assert!(
        row.model_id.as_deref().unwrap().starts_with("codex:"),
        "{:?}",
        row.model_id
    );
    assert_eq!(row.session_id, None);
    // The registration, and so every new chat of the agent, did not change.
    let kept = crate::team::defaults_for_chat(&w.path, &chat.key)
        .unwrap()
        .unwrap();
    assert_eq!(
        (kept.agent, kept.model.as_str()),
        (ChatAgent::Claude, "claude-opus-5-5")
    );
    assert_eq!(kept.id, agent.id);
    // A fresh session owes the history and the brief.
    assert!(w.manager.handoff_owed(&chat.key));
}

#[test]
fn the_same_provider_keeps_its_native_session() {
    let w = World::new();
    let chat = w.chat();
    let answer = w
        .switch(&chat, ChatAgent::Claude, "sonnet", Some("low"))
        .unwrap();
    assert_eq!(answer.state, "switched");
    let start = w.start(&chat);
    assert_eq!(start.model.as_deref(), Some("sonnet"));
    assert_eq!(start.effort.as_deref(), Some("low"));
    assert_eq!(
        start.session_id.as_deref(),
        Some("claude-session-1"),
        "resumed with the new model"
    );
    assert!(!w.manager.handoff_owed(&chat.key));
    let switched = &events(&chat, "octiq_provider_switched")[0];
    assert_eq!(switched["handoffOwed"], false);
    assert_eq!(switched["sessionKept"], true);
    let row = crate::chat_index::find(&chat.id).unwrap().unwrap();
    assert_eq!(row.session_id.as_deref(), Some("claude-session-1"));
}

#[test]
fn picking_the_runtime_already_running_is_a_no_op() {
    let w = World::new();
    let chat = w.chat();
    let answer = w
        .switch(&chat, ChatAgent::Claude, "claude-opus-5-5", Some("high"))
        .unwrap();
    assert_eq!(answer.state, "switched");
    assert!(events(&chat, "octiq_runtime_change_prepared").is_empty());
    assert!(events(&chat, "octiq_provider_switched").is_empty());
}

// ---- pending: a turn is in flight ------------------------------------------

#[test]
fn a_busy_chat_is_never_interrupted_and_the_pick_waits() {
    let w = World::new();
    let chat = w.chat();
    let process = w.manager.test_hold(&chat.key, ChatAgent::Claude, true);
    let tap = crate::bus::tap::Tap::on(&chat.key);
    let answer = w
        .switch(&chat, ChatAgent::Codex, "gpt-5.6-sol", None)
        .unwrap();
    assert_eq!(answer.state, "pending");
    assert!(process.alive(), "nothing was interrupted");
    assert_eq!(
        w.start(&chat).agent,
        ChatAgent::Claude,
        "the runtime has not moved"
    );
    assert!(events(&chat, "octiq_provider_switched").is_empty());
    assert_eq!(events(&chat, "octiq_runtime_pending").len(), 1);
    assert!(tap
        .heard()
        .iter()
        .any(|(name, body)| name == "chat-runtime-pending" && body["agent"] == "codex"));
    let (pending, home, _) = queue_fields(&w.manager, &chat.key);
    assert_eq!(pending.map(|p| p.agent), Some(ChatAgent::Codex));
    assert!(home.is_none());
    // A second pick replaces it.
    let answer = w
        .switch(&chat, ChatAgent::Codex, "gpt-5.6-terra", None)
        .unwrap();
    assert_eq!(answer.state, "pending");
    assert_eq!(
        w.manager
            .pending_runtime(&chat.key)
            .unwrap()
            .model
            .as_deref(),
        Some("gpt-5.6-terra")
    );
    // Stop keeps it.
    chat_stop_impl(&w.manager, chat.key.clone()).unwrap();
    assert!(process.gone());
    assert_eq!(
        w.manager
            .pending_runtime(&chat.key)
            .unwrap()
            .model
            .as_deref(),
        Some("gpt-5.6-terra")
    );
    // Picking the runtime that is running takes it back.
    let answer = w
        .switch(&chat, ChatAgent::Claude, "claude-opus-5-5", Some("high"))
        .unwrap();
    assert_eq!(answer.state, "switched");
    assert!(w.manager.pending_runtime(&chat.key).is_none());
    assert_eq!(recorded(&chat.key).unwrap().pending, None);
    assert!(queue_fields(&w.manager, &chat.key).0.is_none());
    assert!(tap
        .heard()
        .iter()
        .any(|(name, body)| name == "chat-runtime-pending" && body["cleared"] == true));
}

#[test]
fn queued_work_or_a_stop_that_has_not_unwound_also_waits() {
    let w = World::new();
    let chat = w.chat();
    let _process = w.manager.test_hold(&chat.key, ChatAgent::Claude, false);
    // Idle but a message is queued.
    queue_waiting_turn(
        &w.manager,
        &chat.key,
        &chat.key,
        "queued one",
        &[],
        Some("user-1".into()),
    )
    .unwrap();
    assert_eq!(
        w.switch(&chat, ChatAgent::Codex, "gpt-5.6-sol", None)
            .unwrap()
            .state,
        "pending"
    );
    let _ = w.manager.cancel_queued_turn(&chat.key, "user-1");
    // A Stop whose full stop is still owed.
    w.manager.test_full_stop_owed(&chat.key, true);
    assert_eq!(
        w.switch(&chat, ChatAgent::Codex, "gpt-5.6-terra", None)
            .unwrap()
            .state,
        "pending"
    );
    assert!(w.manager.has_process(&chat.key));
}

#[test]
fn the_full_stop_applies_the_pick_before_the_queue_moves_and_keeps_fifo() {
    let w = World::new();
    let chat = w.chat();
    let (process, heard) = w
        .manager
        .test_hold_heard(&chat.key, ChatAgent::Claude, true);
    for (text, id) in [("first waiting", "queue-1"), ("second waiting", "queue-2")] {
        queue_waiting_turn(&w.manager, &chat.key, &chat.key, text, &[], Some(id.into())).unwrap();
    }
    assert_eq!(
        w.switch(&chat, ChatAgent::Codex, "gpt-5.6-sol", None)
            .unwrap()
            .state,
        "pending"
    );
    let session = w
        .manager
        .sessions
        .lock()
        .unwrap()
        .get(&chat.key)
        .cloned()
        .unwrap();
    {
        let mut guard = session.lock().unwrap();
        end_turn_locked(&w.manager, &chat.key, &chat.key, &mut guard, true);
        assert_eq!(
            guard.cut_off,
            CutOff::Ended,
            "nothing more is written to this process"
        );
    }
    assert!(is_due(&w.manager, &chat.key, "test-launch"));
    // Nothing was handed to the old process: the queue is whole.
    let queued = |manager: &ChatManager| -> Vec<String> {
        manager
            .queued_turns
            .lock()
            .unwrap()
            .get(&chat.key)
            .into_iter()
            .flatten()
            .map(|t| t.text.clone())
            .collect()
    };
    assert_eq!(queued(&w.manager), ["first waiting", "second waiting"]);
    let started = std::cell::RefCell::new(None);
    apply_with(&w.manager, &chat.key, &chat.key, &session, |turn| {
        // At the moment the first message starts, the chat is on the new runtime.
        *started.borrow_mut() = Some((turn.clone(), w.manager.start_context(&chat.key).unwrap()));
        Ok(())
    });
    let (turn, start) = started.into_inner().expect("the first message was started");
    assert_eq!(
        (turn.text.as_str(), turn.turn_id.as_deref()),
        ("first waiting", Some("queue-1"))
    );
    assert_eq!(start.agent, ChatAgent::Codex);
    assert_eq!(start.session_id, None);
    assert_eq!(
        queued(&w.manager),
        ["second waiting"],
        "FIFO, behind the first"
    );
    assert_eq!(
        w.manager
            .queued_turns
            .lock()
            .unwrap()
            .get(&chat.key)
            .unwrap()[0]
            .context
            .as_ref()
            .unwrap()
            .agent,
        ChatAgent::Codex,
        "queued messages run on the new runtime"
    );
    assert!(process.gone());
    drop(heard);
    assert_eq!(events(&chat, "octiq_provider_switched").len(), 1);
    assert!(w.manager.pending_runtime(&chat.key).is_none());
    assert!(w.manager.sessions.lock().unwrap().is_empty() || !w.manager.has_process(&chat.key));
}

#[test]
fn a_switch_that_cannot_be_applied_leaves_the_old_runtime_running_the_queue() {
    let w = World::new();
    let chat = w.chat();
    let _process = w.manager.test_hold(&chat.key, ChatAgent::Claude, true);
    queue_waiting_turn(
        &w.manager,
        &chat.key,
        &chat.key,
        "carry me",
        &[],
        Some("user-1".into()),
    )
    .unwrap();
    assert_eq!(
        w.switch(&chat, ChatAgent::Codex, "gpt-5.6-sol", None)
            .unwrap()
            .state,
        "pending"
    );
    // The CLI vanishes before the full stop.
    install(&[ChatAgent::Codex]);
    let session = w
        .manager
        .sessions
        .lock()
        .unwrap()
        .get(&chat.key)
        .cloned()
        .unwrap();
    end_turn_locked(
        &w.manager,
        &chat.key,
        &chat.key,
        &mut session.lock().unwrap(),
        true,
    );
    let started = std::cell::RefCell::new(None);
    apply_with(&w.manager, &chat.key, &chat.key, &session, |turn| {
        *started.borrow_mut() = Some(w.manager.start_context(&chat.key).unwrap().agent);
        let _ = turn;
        Ok(())
    });
    install(&[]);
    assert_eq!(
        started.into_inner(),
        Some(ChatAgent::Claude),
        "the queue still ran, on the old runtime"
    );
    assert!(
        w.manager.pending_runtime(&chat.key).is_none(),
        "the dropped switch is not retried forever"
    );
    assert_eq!(recorded(&chat.key).unwrap().pending, None);
    assert!(events(&chat, "octiq_provider_switched").is_empty());
}

#[test]
fn a_waiting_switch_applies_on_the_next_start_and_survives_a_restart() {
    let w = World::new();
    let chat = w.chat();
    w.coordinates(&chat);
    let _process = w.manager.test_hold(&chat.key, ChatAgent::Claude, true);
    assert_eq!(
        w.switch(&chat, ChatAgent::Codex, "gpt-5.6-sol", None)
            .unwrap()
            .state,
        "pending"
    );
    chat_stop_impl(&w.manager, chat.key.clone()).unwrap();
    // A server restart: memory is empty, the record is not.
    let restarted = crate::dispatch::Services::at_profile().chats.clone();
    assert!(restarted.start_context(&chat.key).is_none());
    assert_eq!(
        queue_fields(&restarted, &chat.key).0.map(|p| p.agent),
        Some(ChatAgent::Codex),
        "pendingRuntime is read from the record"
    );
    assert_eq!(
        restarted.pending_runtime(&chat.key).map(|p| p.agent),
        Some(ChatAgent::Codex)
    );
    // Whoever starts the chat next (a message, a wake, a queued turn) adopts it first.
    adopt_pending(&restarted, &chat.key);
    let start = restarted.start_context(&chat.key).unwrap();
    assert_eq!((start.agent, start.session_id), (ChatAgent::Codex, None));
    assert!(restarted.handoff_owed(&chat.key));
    assert_eq!(recorded(&chat.key).unwrap().pending, None);
    // The wake path reads the same context the ledger saved.
    let saved = restarted
        .orchestrations
        .saved_resume_context(&chat.key)
        .unwrap();
    assert_eq!(saved.agent, ChatAgent::Codex);
}

// ---- a fresh session carries history and identity ---------------------------

#[test]
fn a_fresh_session_carries_the_history_and_the_agents_full_brief_even_in_a_long_chat() {
    let w = World::new();
    let agent = w.agent("claude", "claude-opus-5-5");
    let chat = w.chat_of(&agent);
    // The original first message is far past the 160k window.
    record_chat_event(
        &chat.key,
        json!({ "type": "user", "uuid": "first", "message": { "content": "FIRST_MESSAGE_PAST_THE_WINDOW" } }),
    );
    for n in 0..30 {
        record_chat_event(
            &chat.key,
            json!({ "type": "assistant", "message": { "content": format!("{n} {}", "x".repeat(10_000)) } }),
        );
    }
    assert!(!provider_history(&chat.key)
        .unwrap()
        .contains("FIRST_MESSAGE_PAST_THE_WINDOW"));
    w.switch(&chat, ChatAgent::Codex, "gpt-5.6-sol", None)
        .unwrap();
    assert!(w.manager.handoff_owed(&chat.key));
    // A session being resumed owes nothing.
    let untouched = with_switch_context(
        &w.manager,
        &chat.key,
        Some("some-session"),
        Some("hi".into()),
        None,
    )
    .unwrap();
    assert_eq!(untouched, (Some("hi".into()), None, false));
    // The fresh one: history as data, the message last, the brief outside.
    let (prompt, visible, taken) = with_switch_context(
        &w.manager,
        &chat.key,
        None,
        Some("Please carry on".into()),
        None,
    )
    .unwrap();
    assert!(taken);
    let prompt = prompt.unwrap();
    assert!(prompt.starts_with(HANDOFF_PREFIX));
    assert_eq!(
        visible.as_deref(),
        Some("Please carry on"),
        "the person's bubble is their own words"
    );
    let (body, brief) = prompt
        .split_once(crate::team::BRIEF_MARK)
        .expect("a brief after the mark");
    assert!(body.contains("Please carry on") && body.contains("Earlier turns (JSON)"));
    assert!(
        brief.contains(&format!("You are {}", agent.name)),
        "{brief}"
    );
    assert!(brief.contains("Your role: Owns the backend and its tests."));
    assert!(
        !body.contains("You are "),
        "who the agent is is not in the history data"
    );
    // Paid once, after the process started.
    handoff_taken(&w.manager, &chat.key);
    assert!(!w.manager.handoff_owed(&chat.key));
    assert_eq!(events(&chat, "octiq_runtime_handoff_taken").len(), 1);
    let again =
        with_switch_context(&w.manager, &chat.key, None, Some("later".into()), None).unwrap();
    assert_eq!(again, (Some("later".into()), None, false));
}

#[test]
fn a_prompt_that_already_carries_the_history_is_not_wrapped_twice_and_gets_its_brief() {
    let w = World::new();
    let chat = w.chat();
    w.switch(&chat, ChatAgent::Codex, "gpt-5.6-sol", None)
        .unwrap();
    record_chat_event(
        &chat.key,
        json!({ "type": "user", "uuid": "u", "message": { "content": "earlier" } }),
    );
    let wrapped = model_handoff_prompt(&provider_history(&chat.key).unwrap(), "now");
    let (prompt, _, taken) =
        with_switch_context(&w.manager, &chat.key, None, Some(wrapped.clone()), None).unwrap();
    assert!(taken);
    let prompt = prompt.unwrap();
    assert_eq!(
        prompt
            .matches("Continue this OctiqFlow conversation")
            .count(),
        1
    );
    assert!(prompt.contains(crate::team::BRIEF_MARK));
    // A chat with no registered agent is left as it is.
    let plain = with_identity_brief(&w.manager, "chat:no-agent-here", "text".into()).unwrap();
    assert_eq!(plain, "text");
}

#[test]
fn the_automatic_paths_carry_the_brief_too() {
    // `run_provider_switch` and the switched/recovered branch of `chat_start`
    // both build a handoff; both put the agent's brief after it.
    let switch = include_str!("provider_switch.rs");
    assert!(switch.contains("runtime_switch::with_identity_brief"));
    let chat = include_str!("agent_chat.rs");
    let start = chat.split("fn chat_start_with_user_turn(").nth(1).unwrap();
    let start = start.split("fn model_handoff_prompt(").next().unwrap();
    assert!(start.contains("runtime_switch::with_identity_brief"));
    assert!(start.contains("runtime_switch::adopt_pending"));
    assert!(start.contains("runtime_switch::host_runtime("));
    assert!(start.contains("runtime_switch::host_session("));
}

// ---- home runtime ------------------------------------------------------------

#[test]
fn home_runtime_is_present_only_on_an_automatic_fallback_and_survives_a_restart() {
    let w = World::new();
    let chat = w.chat();
    let (pending, home, _) = queue_fields(&w.manager, &chat.key);
    assert_eq!((pending, home), (None, None), "on its own runtime: no home");
    // The failover to Codex.
    let opus = settings(ChatAgent::Claude, "claude-opus-5-5", Some("high"));
    let codex = settings(ChatAgent::Codex, "gpt-5.6-sol", Some("high"));
    auto_switch(&chat, &opus, &codex);
    let mut start = w.start(&chat);
    start.agent = ChatAgent::Codex;
    start.model = Some("gpt-5.6-sol".into());
    start.session_id = None;
    w.manager.remember_start(&chat.key, start);
    let now = crate::auto_resume::unix_now();
    // A guessed reset is a guess: limited, with no time.
    w.manager
        .failover
        .limited(ChatAgent::Claude, None, None, now);
    let home = queue_fields(&w.manager, &chat.key)
        .1
        .expect("a home runtime");
    assert_eq!(
        (
            home.agent,
            home.model.as_deref(),
            home.limited,
            home.resets_at
        ),
        (ChatAgent::Claude, Some("claude-opus-5-5"), true, None)
    );
    // The provider said when.
    w.manager.failover.clear(ChatAgent::Claude, None);
    w.manager
        .failover
        .limited(ChatAgent::Claude, None, Some(now + 5_000), now);
    let home = queue_fields(&w.manager, &chat.key).1.unwrap();
    assert_eq!((home.limited, home.resets_at), (true, Some(now + 5_000)));
    // After a restart the cooldowns are empty and the home runtime is still right.
    let restarted = ChatManager::default();
    let home = queue_fields(&restarted, &chat.key).1;
    assert_eq!(
        home.as_ref().map(|h| (h.agent, h.limited, h.resets_at)),
        Some((ChatAgent::Claude, false, None))
    );
    // Switching back to the home runtime ends the fallback.
    let answer = w
        .switch(&chat, ChatAgent::Claude, "claude-opus-5-5", Some("high"))
        .unwrap();
    assert_eq!(answer.state, "switched");
    assert_eq!(queue_fields(&w.manager, &chat.key).1, None);
    assert!(
        !w.manager.failover.blocked(ChatAgent::Claude, None, now),
        "the stale cooldown was cleared"
    );
    // Claude after Codex is a fresh session with the history.
    assert!(w.manager.handoff_owed(&chat.key));
    assert_eq!(w.start(&chat).session_id, None);
}

#[test]
fn picking_something_other_than_home_makes_that_the_baseline() {
    let w = World::new();
    let chat = w.chat();
    let opus = settings(ChatAgent::Claude, "claude-opus-5-5", Some("high"));
    let codex = settings(ChatAgent::Codex, "gpt-5.6-sol", Some("high"));
    auto_switch(&chat, &opus, &codex);
    let mut start = w.start(&chat);
    start.agent = ChatAgent::Codex;
    start.model = Some("gpt-5.6-sol".into());
    start.session_id = None;
    w.manager.remember_start(&chat.key, start);
    // Opus is home. The person picks Sonnet instead.
    w.switch(&chat, ChatAgent::Claude, "sonnet", None).unwrap();
    assert_eq!(
        queue_fields(&w.manager, &chat.key).1,
        None,
        "no fallback: Sonnet is the chat's own runtime now"
    );
    assert_eq!(
        recorded(&chat.key)
            .unwrap()
            .baseline
            .unwrap()
            .model
            .as_deref(),
        Some("sonnet")
    );
    // And failover later returns to Sonnet, not to Opus.
    let after = w.start(&chat);
    assert_eq!(after.default_settings().model.as_deref(), Some("sonnet"));
    // The roster still says Opus.
    assert_eq!(
        crate::team::defaults_for_chat(&w.path, &chat.key)
            .unwrap()
            .unwrap()
            .model,
        "claude-opus-5-5"
    );
}

// ---- the cooldown ---------------------------------------------------------------

#[test]
fn a_cooldown_is_cleared_by_the_person_and_marked_again_by_the_provider() {
    let state = crate::provider_failover::State::default();
    let now = 1_000;
    state.limited(ChatAgent::Claude, None, None, now);
    assert!(state.blocked(ChatAgent::Claude, None, now + 1));
    assert_eq!(
        state.resets_at(ChatAgent::Claude, None, now + 1),
        None,
        "the 15-minute guess is not a time"
    );
    state.clear(ChatAgent::Claude, None);
    assert!(!state.blocked(ChatAgent::Claude, None, now + 1));
    state.limited(ChatAgent::Claude, None, Some(now + 600), now);
    assert_eq!(
        state.resets_at(ChatAgent::Claude, None, now + 1),
        Some(now + 600)
    );
    // A later failure that names no time stands for longer than the real
    // reset: the limit still stands, and no time is claimed for it.
    state.limited(ChatAgent::Claude, None, None, now);
    assert!(state.blocked(ChatAgent::Claude, None, now + 700));
    assert_eq!(state.resets_at(ChatAgent::Claude, None, now + 1), None);
    state.clear(ChatAgent::Claude, None);
    state.limited(ChatAgent::Claude, None, Some(now + 600), now);
    // Past its time it says nothing.
    assert_eq!(state.resets_at(ChatAgent::Claude, None, now + 601), None);
    // Pi on Anthropic is its own account.
    state.limited(
        ChatAgent::Pi,
        Some("anthropic/claude-opus-5-5"),
        Some(now + 900),
        now,
    );
    assert_eq!(
        state.resets_at(ChatAgent::Pi, Some("anthropic/claude-sonnet-5-5"), now + 1),
        Some(now + 900)
    );
    state.clear(ChatAgent::Pi, Some("anthropic/claude-opus-5-5"));
    assert!(!state.blocked(ChatAgent::Pi, Some("anthropic/claude-opus-5-5"), now + 1));
}

#[test]
fn the_hosts_current_runtime_is_what_a_page_cannot_undo() {
    let w = World::new();
    let chat = w.chat();
    w.switch(&chat, ChatAgent::Codex, "gpt-5.6-sol", Some("low"))
        .unwrap();
    let found = recorded(&chat.key).unwrap();
    let wins = found.current_runtime().expect("the record holds it");
    assert_eq!(
        (wins.agent, wins.model.as_deref(), wins.effort.as_deref()),
        (ChatAgent::Codex, Some("gpt-5.6-sol"), Some("low"))
    );
    // An automatic change after it is the host's own, and decides the same way.
    let opus = settings(ChatAgent::Claude, "claude-opus-5-5", None);
    auto_switch(&chat, wins, &opus);
    assert_eq!(recorded(&chat.key).unwrap().current_runtime(), Some(&opus));
}

/// A stale tab's start, the way a page that never heard of the change sends it.
fn stale_start(
    w: &World,
    chat: &Chat,
    agent: ChatAgent,
    model: &str,
    handoff: Option<&str>,
    resume: Option<&str>,
) -> Result<(), String> {
    chat_start_user_impl(
        w.manager.clone(),
        chat.key.clone(),
        NO_SPAWN.into(),
        agent,
        Some(model.into()),
        Some(Access::Full),
        Some("stale tab message".into()),
        handoff.map(str::to_string),
        resume.map(str::to_string),
        None,
        None,
        Some("high".into()),
        None,
        None,
        None,
    )
}

/// Provider CLIs that start, read stdin and say nothing (a Codex that also
/// lists no MCP servers): a start succeeds without a model, so what a
/// successful start records can be read. The folder holds the scripts.
fn clis_that_start(dir: &crate::test_dir::TestDir) {
    use std::os::unix::fs::PermissionsExt;
    let found = ChatAgent::ALL
        .into_iter()
        .map(|agent| {
            let script = dir.join(agent.id());
            std::fs::write(
                &script,
                "#!/bin/sh\ncase \"$*\" in *\"mcp list\"*|*--version*) echo '[]'; exit 0;; esac\nexec cat > /dev/null\n",
            )
            .unwrap();
            std::fs::set_permissions(&script, std::fs::Permissions::from_mode(0o755)).unwrap();
            (agent.id().to_string(), script.to_string_lossy().into_owned())
        })
        .collect();
    crate::agents::seed_probe_for_test(found);
}

fn started_as(w: &World, chat: &Chat) -> (ChatAgent, Option<String>) {
    let start = w.start(chat);
    (start.agent, start.model)
}

/// End what the start began: the stand-in reads stdin until it is told to go.
fn wait_idle(w: &World, chat: &Chat) {
    let _ = end_process(&w.manager, &chat.key);
}

#[test]
fn a_stale_start_after_an_automatic_failover_stays_on_the_host_runtime() {
    let w = World::new();
    let stub = crate::test_dir::TestDir::new("runtime-stale-clis");
    clis_that_start(&stub);
    let chat = w.chat();
    let opus = settings(ChatAgent::Claude, "claude-opus-5-5", Some("high"));
    let codex = settings(ChatAgent::Codex, "gpt-5.6-sol", Some("high"));
    auto_switch(&chat, &opus, &codex);
    // The server restarted: no cooldown, no start context. The tab still says Opus.
    w.manager.starts.lock().unwrap().remove(&chat.key);
    let _ = stale_start(&w, &chat, ChatAgent::Claude, "claude-opus-5-5", None, None);
    wait_idle(&w, &chat);
    assert_eq!(
        started_as(&w, &chat),
        (ChatAgent::Codex, Some("gpt-5.6-sol".into())),
        "the host's runtime, not the page's"
    );
    let found = recorded(&chat.key).unwrap();
    assert_eq!(
        found.baseline.as_ref(),
        Some(&opus),
        "going back stays an explicit choice"
    );
    assert_eq!(
        found.current.as_ref().map(|c| c.agent),
        Some(ChatAgent::Codex)
    );
}

#[test]
fn a_stale_start_after_a_persons_switch_stays_on_it_and_a_foreign_session_is_dropped() {
    let w = World::new();
    let stub = crate::test_dir::TestDir::new("runtime-stale-clis");
    clis_that_start(&stub);
    let chat = w.chat();
    w.switch(&chat, ChatAgent::Codex, "gpt-5.6-sol", Some("low"))
        .unwrap();
    let _ = stale_start(
        &w,
        &chat,
        ChatAgent::Claude,
        "claude-opus-5-5",
        None,
        Some("claude-session-1"),
    );
    wait_idle(&w, &chat);
    let (agent, model) = started_as(&w, &chat);
    assert_eq!(
        (agent, model.as_deref()),
        (ChatAgent::Codex, Some("gpt-5.6-sol"))
    );
    assert_eq!(w.start(&chat).effort.as_deref(), Some("low"));
    assert_ne!(
        w.start(&chat).session_id.as_deref(),
        Some("claude-session-1"),
        "a session of another provider is never resumed"
    );
    // The chat's own runtime (what Back to Opus returns to) did not move.
    let found = recorded(&chat.key).unwrap();
    assert_eq!(
        found.baseline.as_ref().map(|b| b.agent),
        Some(ChatAgent::Codex)
    );
}

#[test]
fn a_dropped_session_on_the_held_runtime_keeps_the_chats_own_baseline() {
    let w = World::new();
    let chat = w.chat();
    let opus = settings(ChatAgent::Claude, "claude-opus-5-5", Some("high"));
    let codex = settings(ChatAgent::Codex, "gpt-5.6-sol", Some("high"));
    auto_switch(&chat, &opus, &codex);
    // The line a stale tab's start writes when only its foreign session was
    // dropped on the runtime the record already holds.
    record_event(
        &chat,
        json!({ "type": "octiq_registered_recovered", "keepsBaseline": true,
            "agent": "codex", "model": "gpt-5.6-sol", "effort": "high", "access": "full" }),
    );
    let found = recorded(&chat.key).unwrap();
    assert_eq!(
        found.baseline.as_ref(),
        Some(&opus),
        "a recovered line for a dropped session must not make the fallback the baseline"
    );
    assert_eq!(found.current.as_ref(), Some(&codex));
    // The preset recovery of an invalid tuple still restores the registration.
    record_event(
        &chat,
        json!({ "type": "octiq_registered_recovered",
            "agent": "claude", "model": "claude-opus-5-5", "effort": "high", "access": "full" }),
    );
    assert_eq!(recorded(&chat.key).unwrap().baseline.as_ref(), Some(&opus));
}

#[test]
fn a_start_with_a_page_handoff_and_an_older_runtime_changes_nothing_and_records_nothing() {
    // H2: a tab picked Codex with the ordinary picker, then another tab
    // switched the chat to Opus. The first tab's Send carries a non-empty
    // `handoff`. A start never carries a choice: the chat stays on Opus,
    // nothing is recorded as the person's, and the page's history is unused.
    let w = World::new();
    let stub = crate::test_dir::TestDir::new("runtime-picker-claude");
    clis_that_start(&stub);
    let chat = w.chat();
    w.switch(&chat, ChatAgent::Codex, "gpt-5.6-sol", Some("high"))
        .unwrap();
    w.switch(&chat, ChatAgent::Claude, "claude-opus-5-5", Some("high"))
        .unwrap();
    let switched = events(&chat, "octiq_provider_switched").len();
    let recovered = events(&chat, "octiq_registered_recovered").len();
    let started = stale_start(
        &w,
        &chat,
        ChatAgent::Codex,
        "gpt-5.6-sol",
        Some("[{\"role\":\"assistant\",\"text\":\"Ready.\"}]"),
        None,
    );
    assert!(started.is_err(), "no provider is started: {started:?}");
    assert_eq!(
        started_as(&w, &chat),
        (ChatAgent::Claude, Some("claude-opus-5-5".into())),
        "the recorded runtime, whatever the start carries"
    );
    assert_eq!(
        events(&chat, "octiq_provider_switched").len(),
        switched,
        "a start records no change of runtime"
    );
    assert_eq!(events(&chat, "octiq_registered_recovered").len(), recovered);
    let found = recorded(&chat.key).unwrap();
    assert_eq!(
        found.current.as_ref().map(|c| c.agent),
        Some(ChatAgent::Claude)
    );
    // The same with a handoff and the page agreeing with a Codex record.
    end_process(&w.manager, &chat.key).unwrap();
    w.switch(&chat, ChatAgent::Codex, "gpt-5.6-sol", Some("high"))
        .unwrap();
    let switched = events(&chat, "octiq_provider_switched").len();
    w.manager.starts.lock().unwrap().remove(&chat.key);
    let _ = stale_start(
        &w,
        &chat,
        ChatAgent::Claude,
        "claude-opus-5-5",
        Some("[{\"role\":\"user\",\"text\":\"earlier\"}]"),
        None,
    );
    assert_eq!(started_as(&w, &chat).0, ChatAgent::Codex);
    assert_eq!(events(&chat, "octiq_provider_switched").len(), switched);
    end_process(&w.manager, &chat.key).unwrap();
}

// ---- the host decides a registered chat's runtime and session --------------

/// A folder that does not exist: a start there reaches the launch decision
/// (`start_seam`) and then fails, so no provider CLI is ever started.
const NO_SPAWN: &str = "/nonexistent/octiq-runtime-switch-no-spawn";

/// What a stale tab's start makes the host decide to launch, with nothing
/// started.
fn planned(
    w: &World,
    chat: &Chat,
    agent: ChatAgent,
    model: &str,
    handoff: Option<&str>,
    resume: Option<&str>,
) -> crate::agent_chat::start_seam::Plan {
    let _ = crate::agent_chat::start_seam::take();
    let started = chat_start_user_impl(
        w.manager.clone(),
        chat.key.clone(),
        NO_SPAWN.into(),
        agent,
        Some(model.into()),
        Some(Access::Full),
        Some("stale tab message".into()),
        handoff.map(str::to_string),
        resume.map(str::to_string),
        None,
        None,
        Some("high".into()),
        None,
        None,
        None,
    );
    assert!(started.is_err(), "nothing may be started: {started:?}");
    crate::agent_chat::start_seam::take().expect("the start reached the launch decision")
}

/// A chat whose record has history and a Claude session, from before launches
/// were recorded: no receipt, no launch line, and no start context.
fn chat_from_before_launches_were_recorded(w: &World) -> Chat {
    let chat = w.chat();
    w.manager.starts.lock().unwrap().remove(&chat.key);
    let _ = w.manager.orchestrations.forget_resume_context(&chat.key);
    record_chat_event(
        &chat.key,
        json!({ "type": "system", "subtype": "init", "session_id": "claude-own-session",
            "model": "claude-opus-5-5" }),
    );
    record_chat_event(
        &chat.key,
        json!({ "type": "user", "uuid": "u1", "message": { "content": "ORIGINAL_IDENTITY_CONTEXT" } }),
    );
    chat
}

#[test]
fn the_hosts_runtime_is_read_from_the_record_then_the_start_context_then_the_transcript_then_the_registration(
) {
    let w = World::new();
    let chat = w.chat();
    w.manager.starts.lock().unwrap().remove(&chat.key);
    let _ = w.manager.orchestrations.forget_resume_context(&chat.key);
    let registration = settings(ChatAgent::Claude, "claude-opus-5-5", Some("high"));
    let decide = || {
        host_runtime(
            &w.manager,
            &chat.key,
            &recorded(&chat.key).unwrap(),
            &registration,
        )
        .unwrap()
    };
    // Nothing at all: the registration. The index row (the browser writes
    // it) says Codex and a session, and is not asked.
    crate::chat_index::upsert(
        serde_json::from_value(json!({
            "id": chat.id, "projectId": "workspace", "updatedAt": 101,
            "modelId": "codex-gpt-5.6-sol", "effort": "low", "access": "full",
            "sessionId": "codex-from-the-index",
        }))
        .unwrap(),
    )
    .unwrap();
    let found = decide();
    assert_eq!(found.source, RuntimeSource::Registration);
    assert_eq!(found.settings, registration);
    // Only its transcript shows it: the provider that announced the latest
    // session. Codex names no model, and the registration is Claude's.
    record_chat_event(
        &chat.key,
        json!({ "type": "thread.started", "thread_id": "codex-thread-1" }),
    );
    let found = decide();
    assert_eq!(found.source, RuntimeSource::Transcript);
    assert_eq!(
        (
            found.settings.agent,
            found.settings.model,
            found.settings.effort
        ),
        (ChatAgent::Codex, None, None)
    );
    // A Claude `init` names its model; the registration's effort is kept
    // only for the registration's own model.
    record_chat_event(
        &chat.key,
        json!({ "type": "system", "subtype": "init", "session_id": "claude-s", "model": "claude-opus-5-5" }),
    );
    let found = decide();
    assert_eq!(found.source, RuntimeSource::Transcript);
    assert_eq!(found.settings, registration);
    // A session /clear revoked is not evidence.
    crate::chat_index::forget_sessions(&chat.key, vec!["claude-s".into()]).unwrap();
    assert_eq!(decide().settings.agent, ChatAgent::Codex);
    // The start context beats the transcript.
    w.manager.remember_start(
        &chat.key,
        StartContext {
            defaults: None,
            cwd: "/tmp/project".into(),
            agent: ChatAgent::Pi,
            model: Some("anthropic/claude-opus-5-5".into()),
            access: Some(Access::Full),
            extra_dirs: None,
            env: None,
            effort: None,
            lite: None,
            session_id: None,
        },
    );
    let found = decide();
    assert_eq!(found.source, RuntimeSource::StartContext);
    assert_eq!(found.settings.agent, ChatAgent::Pi);
    // The record beats both: a launch line, then a receipt after it.
    let launched = settings(ChatAgent::Codex, "gpt-5.6-sol", Some("low"));
    let mut line = serde_json::to_value(&launched).unwrap();
    line["type"] = json!(LAUNCHED);
    record_event(&chat, line);
    let found = decide();
    assert_eq!(found.source, RuntimeSource::Record);
    assert_eq!(found.settings, launched);
    let opus = settings(ChatAgent::Claude, "claude-opus-5-5", Some("high"));
    auto_switch(&chat, &launched, &opus);
    assert_eq!(decide().settings, opus, "the later line wins");
}

#[test]
fn a_session_is_the_hosts_own_for_the_runtime_and_never_the_pages() {
    let w = World::new();
    let chat = chat_from_before_launches_were_recorded(&w);
    let claude = settings(ChatAgent::Claude, "claude-opus-5-5", Some("high"));
    let codex = settings(ChatAgent::Codex, "gpt-5.6-sol", None);
    // No start context: the latest session its transcript shows, and only
    // for the provider that announced it.
    assert_eq!(
        host_session(&w.manager, &chat.key, &claude).unwrap(),
        Some("claude-own-session".into())
    );
    assert_eq!(host_session(&w.manager, &chat.key, &codex).unwrap(), None);
    // A start context that holds no session owes a fresh one.
    let mut start = w
        .manager
        .start_context(&chat.key)
        .unwrap_or_else(|| StartContext {
            defaults: None,
            cwd: "/tmp/project".into(),
            agent: ChatAgent::Claude,
            model: Some("claude-opus-5-5".into()),
            access: Some(Access::Full),
            extra_dirs: None,
            env: None,
            effort: Some("high".into()),
            lite: None,
            session_id: None,
        });
    start.session_id = None;
    w.manager.remember_start(&chat.key, start.clone());
    assert_eq!(host_session(&w.manager, &chat.key, &claude).unwrap(), None);
    start.session_id = Some("claude-live".into());
    w.manager.remember_start(&chat.key, start);
    assert_eq!(
        host_session(&w.manager, &chat.key, &claude).unwrap(),
        Some("claude-live".into())
    );
    assert_eq!(host_session(&w.manager, &chat.key, &codex).unwrap(), None);
}

#[test]
fn an_existing_chat_with_no_switch_receipt_keeps_its_runtime_against_a_stale_start() {
    // H3: the chat ran on Claude and was never switched. A stale tab asks
    // for Codex, with a handoff and a session of its own. Nothing but
    // `chat_switch_runtime` changes the runtime.
    let w = World::new();
    let chat = chat_from_before_launches_were_recorded(&w);
    let plan = planned(
        &w,
        &chat,
        ChatAgent::Codex,
        "gpt-5.6-sol",
        Some("[{\"role\":\"assistant\",\"text\":\"page history\"}]"),
        Some("codex-session-of-the-page"),
    );
    assert_eq!(
        (plan.agent, plan.model.as_deref(), plan.effort.as_deref()),
        (ChatAgent::Claude, Some("claude-opus-5-5"), Some("high"))
    );
    assert_eq!(
        plan.resume.as_deref(),
        Some("claude-own-session"),
        "the host's own session, never the page's"
    );
    let prompt = plan.prompt.unwrap();
    assert!(prompt.contains("stale tab message") && !prompt.contains("page history"));
    assert!(events(&chat, "octiq_provider_switched").is_empty());
    assert!(events(&chat, "octiq_registered_recovered").is_empty());
    // The coordinator's start (`orchestration_master_start`) is the same door.
    let _ = crate::agent_chat::start_seam::take();
    let master = chat_start_master_impl(
        w.manager.clone(),
        chat.key.clone(),
        NO_SPAWN.into(),
        ChatAgent::Codex,
        Some("gpt-5.6-sol".into()),
        Some(Access::Full),
        "Coordinate".into(),
        Some("[{\"role\":\"user\",\"text\":\"page history\"}]".into()),
        Some("codex-session-of-the-page".into()),
        None,
        None,
        Some("high".into()),
        None,
    );
    assert!(master.is_err(), "nothing may be started");
    let plan = crate::agent_chat::start_seam::take().expect("the master start reached the launch");
    assert_eq!(plan.agent, ChatAgent::Claude);
    assert_eq!(plan.resume.as_deref(), Some("claude-own-session"));
    assert!(!plan.prompt.unwrap().contains("page history"));
    assert_eq!(started_as(&w, &chat).0, ChatAgent::Claude);
}

#[test]
fn a_launch_leaves_one_line_saying_the_runtime_it_ran_on() {
    let w = World::new();
    let chat = chat_from_before_launches_were_recorded(&w);
    let opus = settings(ChatAgent::Claude, "claude-opus-5-5", Some("high"));
    note_launch(&w.manager, &chat.key, &opus);
    assert_eq!(events(&chat, LAUNCHED).len(), 1);
    assert_eq!(recorded(&chat.key).unwrap().latest, Some(opus.clone()));
    // The same runtime again adds nothing, and a new one adds a line.
    note_launch(&w.manager, &chat.key, &opus);
    assert_eq!(events(&chat, LAUNCHED).len(), 1);
    let codex = settings(ChatAgent::Codex, "gpt-5.6-sol", Some("low"));
    note_launch(&w.manager, &chat.key, &codex);
    assert_eq!(events(&chat, LAUNCHED).len(), 2);
    assert_eq!(recorded(&chat.key).unwrap().latest, Some(codex));
    // A launch never touches the chat's own runtime (what failover returns to).
    let found = recorded(&chat.key).unwrap();
    assert_eq!((found.baseline, found.current), (None, None));
    // A chat of no registered agent leaves none.
    let plain = format!("chat:plain-{}", uuid::Uuid::new_v4().simple());
    note_launch(&w.manager, &plain, &opus);
    assert!(crate::transcript::of_type(&plain, LAUNCHED).is_empty());
}

#[test]
fn a_same_runtime_stale_start_after_the_handoff_debt_was_paid_still_gets_the_earlier_context() {
    // H4: switched Codex -> Opus, the first message after it paid the debt,
    // the process stopped. A stale start with no session (and no history)
    // must not open a session that has forgotten everything.
    let w = World::new();
    let chat = w.chat();
    record_chat_event(
        &chat.key,
        json!({ "type": "user", "uuid": "u1", "message": { "content": "ORIGINAL_IDENTITY_CONTEXT" } }),
    );
    w.switch(&chat, ChatAgent::Codex, "gpt-5.6-sol", Some("high"))
        .unwrap();
    w.switch(&chat, ChatAgent::Claude, "claude-opus-5-5", Some("high"))
        .unwrap();
    handoff_taken(&w.manager, &chat.key);
    assert!(!w.manager.handoff_owed(&chat.key));
    assert_eq!(w.start(&chat).session_id, None, "a fresh session is owed");
    let plan = planned(&w, &chat, ChatAgent::Claude, "claude-opus-5-5", None, None);
    assert_eq!(plan.agent, ChatAgent::Claude);
    assert_eq!(plan.resume, None, "no session of its own to resume");
    let prompt = plan.prompt.unwrap();
    assert!(prompt.starts_with(HANDOFF_PREFIX), "{prompt}");
    assert!(prompt.contains("ORIGINAL_IDENTITY_CONTEXT"), "{prompt}");
    assert!(prompt.contains("stale tab message"), "{prompt}");
    assert!(prompt.contains(crate::team::BRIEF_MARK), "{prompt}");
    // The page's own history is not what was handed over.
    let page = planned(
        &w,
        &chat,
        ChatAgent::Claude,
        "claude-opus-5-5",
        Some("[{\"role\":\"assistant\",\"text\":\"Ready.\"}]"),
        None,
    );
    assert!(!page.prompt.unwrap().contains("Ready."));
}

#[test]
fn a_chat_started_before_launches_were_recorded_resolves_from_its_transcript() {
    let w = World::new();
    let chat = chat_from_before_launches_were_recorded(&w);
    assert!(events(&chat, LAUNCHED).is_empty());
    let registration = settings(ChatAgent::Claude, "claude-opus-5-5", Some("high"));
    let found = host_runtime(
        &w.manager,
        &chat.key,
        &recorded(&chat.key).unwrap(),
        &registration,
    )
    .unwrap();
    assert_eq!(found.source, RuntimeSource::Transcript);
    assert_eq!(found.settings.agent, ChatAgent::Claude);
    let queue =
        serde_json::to_value(chat_queue_state_impl(&w.manager, &chat.key).unwrap()).unwrap();
    assert_eq!(queue["runtime"]["agent"], "claude");
    assert_eq!(queue["runtime"]["model"], "claude-opus-5-5");
    // The same chat whose transcript shows a Codex session (it ran there
    // before launches were recorded): that is the runtime, and a Claude
    // session is not resumed under it.
    let codex_chat = w.chat();
    w.manager.starts.lock().unwrap().remove(&codex_chat.key);
    let _ = w
        .manager
        .orchestrations
        .forget_resume_context(&codex_chat.key);
    record_chat_event(
        &codex_chat.key,
        json!({ "type": "thread.started", "thread_id": "codex-thread-1" }),
    );
    let plan = planned(
        &w,
        &codex_chat,
        ChatAgent::Claude,
        "claude-opus-5-5",
        None,
        Some("claude-session-1"),
    );
    assert_eq!(plan.agent, ChatAgent::Codex);
    assert_eq!(plan.resume.as_deref(), Some("codex-thread-1"));
}

#[test]
fn the_retarget_of_a_registered_chat_is_refused_in_words_that_name_the_switch() {
    let w = World::new();
    let chat = w.chat();
    let before = w.start(&chat);
    let refused = chat_retarget_impl(&w.manager, chat.key.clone()).unwrap_err();
    assert!(
        refused.contains("chat_switch_runtime") && refused.contains("registered"),
        "{refused}"
    );
    assert_eq!(
        w.start(&chat).session_id,
        before.session_id,
        "nothing was ended or forgotten"
    );
}

#[test]
fn an_unregistered_chats_picker_still_retargets_and_its_start_carries_the_choice() {
    let w = World::new();
    let stub = crate::test_dir::TestDir::new("runtime-plain-clis");
    clis_that_start(&stub);
    let key = format!("chat:plain-{}", uuid::Uuid::new_v4().simple());
    w.manager.remember_start(
        &key,
        StartContext {
            defaults: None,
            cwd: "/tmp/project".into(),
            agent: ChatAgent::Claude,
            model: Some("claude-opus-5-5".into()),
            access: Some(Access::Full),
            extra_dirs: None,
            env: None,
            effort: Some("high".into()),
            lite: None,
            session_id: Some("claude-session-1".into()),
        },
    );
    assert!(!is_registered_chat(&key).unwrap());
    chat_retarget_impl(&w.manager, key.clone()).unwrap();
    assert!(w.manager.start_context(&key).is_none());
    // The picker's next start (the page's agent and history) runs as asked.
    let chat = Chat {
        key: key.clone(),
        id: key.trim_start_matches("chat:").into(),
    };
    let started = stale_start(
        &w,
        &chat,
        ChatAgent::Codex,
        "gpt-5.6-sol",
        Some("[{\"role\":\"user\",\"text\":\"earlier\"}]"),
        None,
    );
    assert!(started.is_err(), "no provider is started: {started:?}");
    assert_eq!(started_as(&w, &chat).0, ChatAgent::Codex);
    wait_idle(&w, &chat);
}

#[test]
fn the_queue_state_says_whether_a_chat_belongs_to_a_registered_agent() {
    let w = World::new();
    let chat = w.chat();
    let state =
        serde_json::to_value(chat_queue_state_impl(&w.manager, &chat.key).unwrap()).unwrap();
    assert_eq!(state["registered"], true);
    let plain =
        serde_json::to_value(chat_queue_state_impl(&w.manager, "chat:not-registered").unwrap())
            .unwrap();
    assert_eq!(plain["registered"], false);
}

#[test]
fn a_recorded_runtime_that_is_limited_or_invalid_is_not_forced() {
    let w = World::new();
    let stub = crate::test_dir::TestDir::new("runtime-stale-clis");
    clis_that_start(&stub);
    // Limited: normal failover routing decides, never the limited provider.
    let chat = w.chat();
    w.switch(&chat, ChatAgent::Codex, "gpt-5.6-sol", Some("high"))
        .unwrap();
    w.manager.failover.limited(
        ChatAgent::Codex,
        Some("gpt-5.6-sol"),
        Some(crate::auto_resume::unix_now() + 600),
        crate::auto_resume::unix_now(),
    );
    let _ = stale_start(&w, &chat, ChatAgent::Claude, "claude-opus-5-5", None, None);
    wait_idle(&w, &chat);
    assert_ne!(
        started_as(&w, &chat).0,
        ChatAgent::Codex,
        "the limited recorded runtime is routed around"
    );
    // Invalid: the preset recovery decides.
    let chat = w.chat();
    record_event(
        &chat,
        json!({ "type": "octiq_provider_switched", "byPerson": true, "handoffOwed": false,
            "agent": "codex", "model": "claude-opus-5-5", "effort": "high", "access": "full" }),
    );
    let _ = stale_start(&w, &chat, ChatAgent::Claude, "claude-opus-5-5", None, None);
    wait_idle(&w, &chat);
    assert_eq!(started_as(&w, &chat).0, ChatAgent::Claude);
}

#[test]
fn a_clear_chat_forgets_what_waited_and_what_was_owed() {
    let w = World::new();
    let chat = w.chat();
    w.switch(&chat, ChatAgent::Codex, "gpt-5.6-sol", None)
        .unwrap();
    assert!(w.manager.handoff_owed(&chat.key));
    w.manager.forget_runtime(&chat.key);
    crate::transcript::forget(&chat.key);
    assert!(!w.manager.handoff_owed(&chat.key));
}

#[test]
fn the_command_is_socket_only() {
    let mcp = include_str!("../../scripts/mcp/octiq-ask.cjs");
    assert!(!mcp.contains("chat_switch_runtime"));
    let web = include_str!("web.rs");
    assert!(
        !web.contains("chat_switch_runtime"),
        "no hook route reaches it"
    );
    let dispatch = include_str!("dispatch.rs");
    assert_eq!(
        dispatch.matches("\"chat_switch_runtime\" =>").count(),
        1,
        "one dispatch arm"
    );
}
