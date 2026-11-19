use super::*;

fn agent(id: &str, team: Option<&str>, project: Option<&str>) -> TeamAgent {
    TeamAgent {
        id: id.into(),
        name: id.to_uppercase(),
        role: format!("{id} role"),
        agent: ChatAgent::Claude,
        model: "sonnet".into(),
        effort: Some("high".into()),
        access: Access::Auto,
        project_id: project.map(Into::into),
        reports_to: None,
        memory_note: None,
        avatar: None,
        team_id: team.map(Into::into),
        created_at: 0,
        updated_at: 0,
        persistent_prompt: String::new(),
        desktop_tools: false,
    }
}

fn team(id: &str) -> AgentTeam {
    AgentTeam {
        id: id.into(),
        name: format!("Team {id}"),
        project_id: None,
        created_at: 0,
        updated_at: 0,
    }
}

fn roster() -> (Vec<TeamAgent>, Vec<AgentTeam>) {
    (
        vec![
            agent("ada", Some("t1"), None),
            agent("bo", Some("t1"), Some("p1")),
            agent("cy", Some("t2"), None),
            agent("di", Some("t1"), Some("p2")),
            agent("ed", None, None),
            TeamAgent {
                model: "fable".into(),
                ..agent("fa", Some("t1"), None)
            },
        ],
        vec![team("t1"), team("t2")],
    )
}

#[test]
fn only_a_registered_teammate_who_may_look_at_the_project_is_asked() {
    let (agents, teams) = roster();
    let pick = |asker: &str, who: &str| {
        choose_helper(&agents, &teams, asker, who, "p1").map(|a| a.id.clone())
    };
    assert_eq!(pick("ada", "bo").unwrap(), "bo");
    // By exact name too, whatever the case.
    assert_eq!(pick("ada", "Bo").unwrap(), "bo");
    // Fable may answer peer questions on its registered model.
    assert_eq!(pick("ada", "fa").unwrap(), "fa");
    assert_eq!(
        pick("ada", "ada").unwrap_err(),
        "You cannot ask yourself. Ask a teammate, or work it out."
    );
    let other_team = pick("ada", "cy").unwrap_err();
    assert!(
        other_team.starts_with("CY is not on your team (Team t1)"),
        "{other_team}"
    );
    assert!(other_team.contains("BO (`bo`)"));
    assert!(pick("ada", "ed")
        .unwrap_err()
        .starts_with("ED is not on your team"));
    assert!(pick("ada", "zed")
        .unwrap_err()
        .starts_with("No registered agent is called zed"));
    assert!(pick("ada", "di")
        .unwrap_err()
        .starts_with("DI works only in another project"));
    assert_eq!(
        pick("ed", "ada").unwrap_err(),
        "You are not on a team, so there is no teammate to ask. Carry on with the task yourself."
    );
    assert!(pick("gone", "ada").is_err());
    assert!(pick("ada", "  ").is_err());
    // A team that was removed is no team.
    assert!(choose_helper(&agents, &teams[1..], "ada", "bo", "p1").is_err());
}

#[test]
fn the_answer_runs_with_read_tools_only_and_no_mcp() {
    let turn = HelperTurn {
        agent: ChatAgent::Claude,
        model: "sonnet".into(),
        effort: Some("high".into()),
        cwd: "/w".into(),
        prompt: "it's a question".into(),
    };
    let claude = helper_command(&turn).unwrap();
    assert!(
        claude.starts_with("exec claude -p 'it'\\''s a question' "),
        "{claude}"
    );
    assert!(claude.contains("--model 'sonnet' --effort high"));
    assert!(claude.contains("--strict-mcp-config"));
    assert!(!claude.contains("--mcp-config"));
    assert!(claude.ends_with("--tools Read,Grep,Glob"));
    assert!(!claude.contains("dangerously") && !claude.contains("bypass"));
    let codex = helper_command(&HelperTurn {
        agent: ChatAgent::Codex,
        model: "gpt-5.6-sol".into(),
        effort: Some("bogus".into()),
        ..turn.clone()
    })
    .unwrap();
    assert!(codex.contains("-s read-only -c approval_policy=never"));
    assert!(
        codex.contains("--ignore-user-config"),
        "no configured MCP servers"
    );
    assert!(
        !codex.contains("model_reasoning_effort"),
        "an unknown effort is dropped"
    );
    assert!(codex.ends_with("-C '/w' 'it'\\''s a question'"));
    assert!(helper_command(&HelperTurn {
        model: "bad model".into(),
        ..turn.clone()
    })
    .is_err());
    let pi = helper_command(&HelperTurn {
        agent: ChatAgent::Pi,
        model: "anthropic/claude-sonnet-5-5".into(),
        ..turn
    })
    .unwrap();
    // Read tools only, none of the person's extensions, no session saved.
    assert!(pi.contains("pi --mode json --no-session -ne"), "{pi}");
    assert!(pi.contains("--tools read,grep,find,ls"), "{pi}");
    assert!(pi.contains("--model 'anthropic/claude-sonnet-5-5'"), "{pi}");
    assert!(!pi.contains("bash") && !pi.contains("mcp"), "{pi}");
}

#[test]
fn pi_output_is_read_for_the_last_answer_its_tokens_and_a_failed_call() {
    let answer = parse_pi(concat!(
            "{\"type\":\"session\",\"id\":\"s\"}\n",
            "{\"type\":\"message_end\",\"message\":{\"role\":\"user\",\"content\":[{\"type\":\"text\",\"text\":\"ask\"}]}}\n",
            "{\"type\":\"message_end\",\"message\":{\"role\":\"assistant\",\"stopReason\":\"toolUse\",\"usage\":{\"input\":10,\"cacheRead\":5,\"output\":2},\"content\":[{\"type\":\"text\",\"text\":\"looking\"}]}}\n",
            "{\"type\":\"message_end\",\"message\":{\"role\":\"assistant\",\"stopReason\":\"stop\",\"usage\":{\"input\":3,\"output\":4},\"content\":[{\"type\":\"text\",\"text\":\" Use the lock. \"}]}}\n",
        ))
        .unwrap();
    assert_eq!(answer.text, "Use the lock.");
    assert_eq!(
        answer.usage,
        Some(PeerUsage {
            input_tokens: 18,
            output_tokens: 6
        })
    );
    assert_eq!(
            parse_pi("{\"type\":\"message_end\",\"message\":{\"role\":\"assistant\",\"stopReason\":\"error\",\"errorMessage\":\"No API key found for anthropic.\",\"content\":[]}}")
                .unwrap_err(),
            "No API key found for anthropic."
        );
    assert!(parse_pi("garbage").is_err());
}

#[test]
fn provider_output_is_read_for_the_answer_and_its_tokens() {
    let claude = parse_claude(
            "{\"type\":\"result\",\"subtype\":\"success\",\"is_error\":false,\"result\":\" Use the lock. \",\"usage\":{\"input_tokens\":10,\"cache_read_input_tokens\":5,\"output_tokens\":7}}\n",
        )
        .unwrap();
    assert_eq!(claude.text, "Use the lock.");
    assert_eq!(
        claude.usage,
        Some(PeerUsage {
            input_tokens: 15,
            output_tokens: 7
        })
    );
    assert_eq!(
        parse_claude("{\"type\":\"result\",\"is_error\":true,\"result\":\"Not logged in\"}")
            .unwrap_err(),
        "Not logged in"
    );
    assert!(parse_claude("garbage").is_err());
    let codex = parse_codex(concat!(
        "{\"type\":\"thread.started\",\"thread_id\":\"t\"}\n",
        "{\"type\":\"item.completed\",\"item\":{\"type\":\"agent_message\",\"text\":\"first\"}}\n",
        "{\"type\":\"item.completed\",\"item\":{\"type\":\"agent_message\",\"text\":\"final\"}}\n",
        "{\"type\":\"turn.completed\",\"usage\":{\"input_tokens\":3,\"output_tokens\":4}}\n",
    ))
    .unwrap();
    assert_eq!(codex.text, "final");
    assert_eq!(codex.usage.unwrap().output_tokens, 4);
    assert_eq!(
        parse_codex("{\"type\":\"turn.failed\",\"error\":{\"message\":\"quota\"}}").unwrap_err(),
        "quota"
    );
}

#[test]
fn a_long_answer_is_cut_on_a_character_boundary() {
    let long = "é".repeat(MAX_ANSWER_CHARS + 3);
    let (cut, truncated) = clip_answer(&long);
    assert!(truncated);
    assert_eq!(cut.chars().count(), MAX_ANSWER_CHARS);
    assert_eq!(clip_answer("short"), ("short".into(), false));
}

#[test]
fn context_paths_stay_inside_the_workspace() {
    let root = crate::test_dir::TestDir::new("peer");
    fs::create_dir_all(root.join("src")).unwrap();
    fs::write(root.join("src/a.rs"), "").unwrap();
    let cwd = root.to_string_lossy().into_owned();
    assert_eq!(
        context_paths(&cwd, &["src/a.rs".into(), " src ".into()]).unwrap(),
        ["src/a.rs", "src"]
    );
    assert!(context_paths(&cwd, &["../".into()])
        .unwrap_err()
        .contains("outside your workspace"));
    assert!(context_paths(&cwd, &["/etc/hosts".into()]).is_err());
    assert!(context_paths(&cwd, &["missing.rs".into()])
        .unwrap_err()
        .contains("does not exist"));
    assert!(context_paths(&cwd, &vec!["src".to_string(); MAX_CONTEXT_PATHS + 1]).is_err());
}

fn worker_on_a_team(store: &OrchestrationStore) -> Attempt {
    let run = super::super::tests::run(store);
    let attempt = super::super::tests::running_worker(store, &run);
    store
        .mutate(|data| {
            let a = data.attempts.get_mut(&attempt.id).unwrap();
            a.assignee = Some(TaskAssignee {
                id: "ada".into(),
                name: "ADA".into(),
            });
            Ok(a.clone())
        })
        .unwrap()
}

fn ask(to: &str, words: &str) -> PeerQuestion {
    PeerQuestion {
        teammate_id: to.into(),
        question: words.into(),
        context_paths: Vec::new(),
    }
}

fn answered(text: &str) -> Result<HelperAnswer, String> {
    Ok(HelperAnswer {
        text: text.into(),
        usage: Some(PeerUsage {
            input_tokens: 100,
            output_tokens: 20,
        }),
    })
}

fn logged(store: &OrchestrationStore) -> Vec<PeerAsk> {
    store.snapshot(None).unwrap().peer_asks
}

#[test]
fn peer_ask_runs_fable_on_its_registered_model() {
    for model in ["fable", "claude-fable-5", "CLAUDE-FABLE-5-20260924"] {
        let store = OrchestrationStore::default();
        let attempt = worker_on_a_team(&store);
        let (mut agents, teams) = roster();
        agents.iter_mut().find(|a| a.id == "fa").unwrap().model = model.into();
        store
            .peer_ask(
                &attempt.worker_chat_key,
                None,
                ask("fa", "Which lock?"),
                &agents,
                &teams,
                "",
                |turn| {
                    assert_eq!(turn.agent, ChatAgent::Claude);
                    assert_eq!(turn.model, model);
                    assert_eq!(turn.effort.as_deref(), Some("high"));
                    answered("The store lock.")
                },
            )
            .unwrap();
        assert_eq!(logged(&store)[0].helper_model, model);
    }
}

#[test]
fn an_ask_runs_as_the_teammate_and_is_recorded_in_the_run() {
    let store = OrchestrationStore::default();
    let attempt = worker_on_a_team(&store);
    let (mut agents, teams) = roster();
    // The run's own project is "workspace": Bo is moved there.
    agents[1].project_id = Some("workspace".into());
    let mut seen = None;
    let reply = store
        .peer_ask(
            &attempt.worker_chat_key,
            None,
            ask("bo", "  Which lock guards the ledger?  "),
            &agents,
            &teams,
            "",
            |turn| {
                seen = Some(turn.clone());
                answered("The store's inner mutex.")
            },
        )
        .unwrap();
    assert_eq!(reply.teammate, "BO");
    assert_eq!(reply.answer, "The store's inner mutex.");
    assert_eq!(reply.asks_left, MAX_ASKS_PER_ATTEMPT - 1);
    let turn = seen.unwrap();
    assert_eq!(
        (
            turn.agent,
            turn.model.as_str(),
            turn.effort.as_deref(),
            turn.cwd.as_str()
        ),
        (ChatAgent::Claude, "sonnet", Some("high"), "/tmp")
    );
    assert!(turn
        .prompt
        .ends_with("ADA's question:\nWhich lock guards the ledger?"));
    let log = logged(&store);
    assert_eq!(log.len(), 1);
    let record = &log[0];
    assert_eq!(record.status, PeerAskStatus::Answered);
    assert_eq!(
        (record.asker.id.as_str(), record.helper.id.as_str()),
        ("ada", "bo")
    );
    assert_eq!(record.attempt_id, attempt.id);
    assert_eq!(record.task_id, attempt.task_id);
    assert_eq!(record.question, "Which lock guards the ledger?");
    assert_eq!(record.answer.as_deref(), Some("The store's inner mutex."));
    assert_eq!(record.usage.as_ref().unwrap().output_tokens, 20);
    assert!(record.answered_at.unwrap() >= record.asked_at);
    // Nothing else about the task moved: the ask is not a handoff.
    let task = store
        .snapshot(None)
        .unwrap()
        .tasks
        .into_iter()
        .find(|t| t.id == attempt.task_id)
        .unwrap();
    assert_eq!(task.active_attempt_id.as_deref(), Some(attempt.id.as_str()));
    assert_eq!(task.status, TaskStatus::Running);
    assert!(task.handoffs.is_empty());
}

#[test]
fn a_failed_answer_is_recorded_and_every_ask_counts_toward_the_limit() {
    let store = OrchestrationStore::default();
    let attempt = worker_on_a_team(&store);
    let (agents, teams) = roster();
    let err = store
        .peer_ask(
            &attempt.worker_chat_key,
            None,
            ask("fa", "Q?"),
            &agents,
            &teams,
            "",
            |_| Err("Not logged in".into()),
        )
        .unwrap_err();
    assert_eq!(err, "FA could not answer: Not logged in");
    assert_eq!(logged(&store)[0].status, PeerAskStatus::Failed);
    assert_eq!(logged(&store)[0].error.as_deref(), Some("Not logged in"));
    let long = "x".repeat(MAX_ANSWER_CHARS + 50);
    let reply = store
        .peer_ask(
            &attempt.worker_chat_key,
            None,
            ask("fa", "Q?"),
            &agents,
            &teams,
            "",
            |_| answered(&long),
        )
        .unwrap();
    assert!(reply.truncated);
    assert_eq!(reply.answer.len(), MAX_ANSWER_CHARS);
    for _ in 2..MAX_ASKS_PER_ATTEMPT {
        store
            .peer_ask(
                &attempt.worker_chat_key,
                None,
                ask("fa", "Q?"),
                &agents,
                &teams,
                "",
                |_| answered("ok"),
            )
            .unwrap();
    }
    let mut called = false;
    let over = store
        .peer_ask(
            &attempt.worker_chat_key,
            None,
            ask("fa", "Q?"),
            &agents,
            &teams,
            "",
            |_| {
                called = true;
                answered("no")
            },
        )
        .unwrap_err();
    assert!(over.contains("which is the limit"), "{over}");
    assert!(!called, "a refused ask never starts the teammate");
    assert_eq!(logged(&store).len(), MAX_ASKS_PER_ATTEMPT);
}

#[test]
fn refused_asks_start_nothing_and_record_nothing() {
    let store = OrchestrationStore::default();
    let attempt = worker_on_a_team(&store);
    let (agents, teams) = roster();
    let refuse = |actor: &str, question: PeerQuestion| {
        let mut called = false;
        let err = store
            .peer_ask(actor, None, question, &agents, &teams, "", |_| {
                called = true;
                answered("no")
            })
            .unwrap_err();
        assert!(!called);
        err
    };
    let me = attempt.worker_chat_key.as_str();
    assert!(refuse(me, ask("cy", "Q?")).contains("not on your team"));
    assert!(refuse(me, ask("ada", "Q?")).contains("cannot ask yourself"));
    assert!(refuse(me, ask("nobody", "Q?")).contains("No registered agent"));
    assert!(refuse(me, ask("fa", "   ")).contains("Ask your teammate a question"));
    assert!(refuse(me, ask("fa", &"q".repeat(MAX_QUESTION_CHARS + 1))).contains("under"));
    assert!(refuse(
        me,
        PeerQuestion {
            context_paths: vec!["../../etc".into()],
            ..ask("fa", "Q?")
        }
    )
    .contains("outside your workspace"));
    // Only a running worker's own chat may ask: not its coordinator, and
    // not a helper, which has no chat at all.
    assert!(refuse("chat:master", ask("fa", "Q?")).contains("no running attempt"));
    assert!(refuse("chat:someone", ask("fa", "Q?")).contains("no running attempt"));
    assert!(logged(&store).is_empty());
}

#[test]
fn a_task_with_no_registered_agent_has_no_team() {
    let store = OrchestrationStore::default();
    let run = super::super::tests::run(&store);
    let attempt = super::super::tests::running_worker(&store, &run);
    let (agents, teams) = roster();
    let err = store
        .peer_ask(
            &attempt.worker_chat_key,
            None,
            ask("bo", "Q?"),
            &agents,
            &teams,
            "",
            |_| answered("no"),
        )
        .unwrap_err();
    assert!(err.contains("not handed to a registered agent"), "{err}");
}

fn lead_in(cwd: &str) -> LeadCaller {
    LeadCaller {
        agent_id: "ada".into(),
        project_id: "p1".into(),
        cwd: cwd.into(),
        cross_project: false,
    }
}

#[test]
fn a_lead_asks_from_its_own_chat_and_the_teammate_reads_that_chats_folder() {
    let root = crate::test_dir::TestDir::new("peer-lead");
    fs::write(root.join("notes.md"), "").unwrap();
    let cwd = root.to_string_lossy().into_owned();
    let store = OrchestrationStore::default();
    let (agents, teams) = roster();
    let mut seen = None;
    let reply = store
        .peer_ask(
            "chat:lead",
            Some(&lead_in(&cwd)),
            PeerQuestion {
                context_paths: vec!["notes.md".into()],
                ..ask("bo", "Which lock guards the ledger?")
            },
            &agents,
            &teams,
            "",
            |turn| {
                seen = Some(turn.clone());
                answered("The store's inner mutex.")
            },
        )
        .unwrap();
    assert_eq!(reply.teammate, "BO");
    assert_eq!(reply.asks_left, MAX_LEAD_ASKS_PER_HOUR - 1);
    // The same one-shot, read-only turn a worker's ask gets: the
    // teammate's identity, in the chat's folder, by the same command.
    let turn = seen.unwrap();
    assert_eq!(
        (turn.agent, turn.model.as_str(), turn.cwd.as_str()),
        (ChatAgent::Claude, "sonnet", cwd.as_str())
    );
    assert!(turn
        .prompt
        .contains("Your teammate ADA is leading a conversation with the person"));
    assert!(turn.prompt.contains("you may only read it"));
    assert!(turn.prompt.contains("- notes.md"));
    let line = helper_command(&turn).unwrap();
    assert!(line.contains("--strict-mcp-config") && line.ends_with("--tools Read,Grep,Glob"));
    // Recorded with no run, task or attempt, under the chat that asked,
    // and listed in the whole-ledger read.
    let log = logged(&store);
    assert_eq!(log.len(), 1);
    let record = &log[0];
    assert_eq!(record.asker_chat_key.as_deref(), Some("chat:lead"));
    assert_eq!(
        (
            record.run_id.as_str(),
            record.task_id.as_str(),
            record.attempt_id.as_str()
        ),
        ("", "", "")
    );
    assert_eq!(record.status, PeerAskStatus::Answered);
    assert_eq!(
        (record.asker.id.as_str(), record.helper.id.as_str()),
        ("ada", "bo")
    );
    let saved = serde_json::to_value(record).unwrap();
    assert!(saved.get("runId").is_none() && saved.get("attemptId").is_none());
    assert_eq!(saved["askerChatKey"], "chat:lead");
    // A worker's record reads back as before, with no chat on it.
    let worker: PeerAsk = serde_json::from_value(json!({
        "id": "peer_1", "runId": "run_1", "taskId": "task_1", "attemptId": "attempt_1",
        "asker": {"id": "ada", "name": "ADA"}, "helper": {"id": "bo", "name": "BO"},
        "helperAgent": "claude", "helperModel": "sonnet", "question": "Q?",
        "status": "answered", "answer": "A", "askedAt": 1,
    }))
    .unwrap();
    assert!(worker.asker_chat_key.is_none());
    assert_eq!(worker.attempt_id, "attempt_1");
}

#[test]
fn a_lead_chats_ask_joins_the_run_it_coordinates() {
    let store = OrchestrationStore::default();
    let run = super::super::tests::run(&store);
    let (agents, teams) = roster();
    store
        .peer_ask(
            "chat:master",
            Some(&lead_in("/tmp")),
            ask("bo", "Q?"),
            &agents,
            &teams,
            "",
            |_| answered("A"),
        )
        .unwrap();
    let in_run = store.snapshot(Some(&run.id)).unwrap().peer_asks;
    assert_eq!(in_run.len(), 1);
    assert_eq!(in_run[0].run_id, run.id);
    assert!(in_run[0].task_id.is_empty());
}

#[test]
fn a_lead_chat_may_ask_five_times_in_any_hour() {
    let store = OrchestrationStore::default();
    let (agents, teams) = roster();
    let lead = lead_in("/tmp");
    let ask_once = |chat: &str| {
        let mut called = false;
        let result = store.peer_ask(
            chat,
            Some(&lead),
            ask("bo", "Q?"),
            &agents,
            &teams,
            "",
            |_| {
                called = true;
                // A failed answer counts like any other.
                Err("No answer came back.".into())
            },
        );
        (result, called)
    };
    for _ in 0..MAX_LEAD_ASKS_PER_HOUR {
        assert!(ask_once("chat:lead").1, "the teammate was started");
    }
    let (over, called) = ask_once("chat:lead");
    let over = over.unwrap_err();
    assert!(
        over.contains("5 times from this chat in the last hour"),
        "{over}"
    );
    assert!(!called, "a refused ask never starts the teammate");
    assert_eq!(logged(&store).len(), MAX_LEAD_ASKS_PER_HOUR);
    // The limit is each chat's own.
    assert!(ask_once("chat:another-lead").1);
    // And it rolls: an ask older than the window no longer counts.
    store
        .mutate(|data| {
            let oldest = data
                .peer_asks
                .values_mut()
                .filter(|a| a.asker_chat_key.as_deref() == Some("chat:lead"))
                .min_by_key(|a| (a.asked_at, a.id.clone()))
                .unwrap();
            oldest.asked_at -= LEAD_ASK_WINDOW_MS + 1;
            Ok(())
        })
        .unwrap();
    assert!(ask_once("chat:lead").1);
    assert!(!ask_once("chat:lead").1);
}

#[test]
fn a_lead_chats_ask_is_held_to_the_same_team_and_project_rules() {
    let store = OrchestrationStore::default();
    let run = super::super::tests::run(&store);
    let worker = super::super::tests::running_worker(&store, &run);
    let (agents, teams) = roster();
    let refuse = |chat: &str, lead: &LeadCaller, who: &str| {
        let mut called = false;
        let err = store
            .peer_ask(
                chat,
                Some(lead),
                ask(who, "Q?"),
                &agents,
                &teams,
                "",
                |_| {
                    called = true;
                    answered("no")
                },
            )
            .unwrap_err();
        assert!(!called);
        err
    };
    let lead = lead_in("/tmp");
    assert!(refuse("chat:lead", &lead, "cy").contains("not on your team"));
    assert!(refuse("chat:lead", &lead, "ada").contains("cannot ask yourself"));
    // Di works only in p2 and this chat is in p1.
    assert!(refuse("chat:lead", &lead, "di").contains("works only in another project"));
    // An agent that was removed, or is on no team, has no one to ask.
    let gone = LeadCaller {
        agent_id: "gone".into(),
        ..lead.clone()
    };
    assert!(refuse("chat:lead", &gone, "bo").contains("no longer a registered agent"));
    let alone = LeadCaller {
        agent_id: "ed".into(),
        ..lead.clone()
    };
    assert!(refuse("chat:lead", &alone, "bo").contains("not on a team"));
    // A worker's chat is never a lead's own chat.
    assert!(refuse(&worker.worker_chat_key, &lead, "bo")
        .contains("orchestration worker, not a lead's own chat"));
    assert!(logged(&store).is_empty());
}

#[test]
fn an_ask_cut_off_by_a_restart_is_failed_on_load() {
    let dir = crate::test_dir::TestDir::new("peer-store");
    let path = dir.join("orchestrations.json");
    let store = OrchestrationStore::load(path.clone());
    let attempt = worker_on_a_team(&store);
    let (agents, teams) = roster();
    // Stand in for a restart mid-answer: the record is written as
    // asking, and the answer never comes back.
    let _ = store.peer_ask(
        &attempt.worker_chat_key,
        None,
        ask("fa", "Q?"),
        &agents,
        &teams,
        "",
        |_| {
            let reloaded = OrchestrationStore::load(path.clone());
            let asks = reloaded.snapshot(None).unwrap().peer_asks;
            assert_eq!(asks[0].status, PeerAskStatus::Failed);
            assert!(asks[0].error.as_deref().unwrap().contains("restarted"));
            answered("late")
        },
    );
}

#[cfg(unix)]
#[test]
fn a_one_shot_process_gets_no_octiq_variable_from_anywhere() {
    // This suite usually runs inside an OctiqFlow chat, whose own
    // OCTIQ_* variables the child would otherwise inherit.
    let env = BTreeMap::from([
        ("KEPT".to_string(), "yes".to_string()),
        ("OCTIQ_CHAT_KEY".to_string(), "chat:leak".to_string()),
        ("OCTIQ_HOOK_PORT".to_string(), "1".to_string()),
    ]);
    let line = r#"printf '{"type":"result","is_error":false,"result":"octiq=%s kept=%s"}\n' "$(env | grep -c '^OCTIQ_')" "$KEPT""#;
    let answer = run_one_shot(
        ChatAgent::Claude,
        line,
        "/",
        &env,
        Duration::from_secs(30),
        "The stand-in",
    )
    .unwrap();
    assert_eq!(answer.text, "octiq=0 kept=yes");
    assert!(is_octiq_variable("OCTIQ_ANYTHING_NEW"));
    assert!(!is_octiq_variable("PATH"));
}

/// A prompt past the 8186 characters Git Bash keeps of one argument,
/// with Windows paths and the quotes a question carries.
fn long_windows_prompt() -> String {
    let prompt = "Why does C:\\Users\\me\\repo\\src\\main.rs fail? It's \\\\server\\share, \"quoted\", 中文.\n"
            .repeat(120);
    assert!(prompt.chars().count() > 8186);
    prompt
}

/// Every line both callers send, Claude and Codex: peer help's and ask
/// back's, with the long prompt and a Windows checkout.
fn every_one_shot_line(prompt: &str) -> Vec<(&'static str, String)> {
    let dir = r"C:\Users\me\repo with space";
    let helper = |agent| {
        helper_command(&HelperTurn {
            agent,
            model: "sonnet".into(),
            effort: None,
            cwd: dir.into(),
            prompt: prompt.into(),
        })
        .unwrap()
    };
    let fork = |agent| {
        crate::handover::back::fork_command(&crate::handover::back::AnswerTurn {
            agent,
            model: None,
            effort: None,
            session_id: "abc-123".into(),
            cwd: r"C:\Users\me\source".into(),
            read_dirs: vec![dir.into()],
            env: BTreeMap::new(),
            prompt: prompt.into(),
        })
        .unwrap()
    };
    vec![
        ("help claude", helper(ChatAgent::Claude)),
        ("help codex", helper(ChatAgent::Codex)),
        ("ask claude", fork(ChatAgent::Claude)),
        ("ask codex", fork(ChatAgent::Codex)),
    ]
}

/// The lines that name a folder as an argument: Codex's `-C` for peer
/// help, Claude's `--add-dir` for ask back. The others run in their cwd.
fn names_the_checkout(name: &str) -> bool {
    matches!(name, "help codex" | "ask claude")
}

#[test]
fn a_one_shot_line_reaches_git_bash_in_the_environment_never_as_an_argument() {
    let prompt = long_windows_prompt();
    let bash = crate::proc::AgentShell {
        program: r"C:\Program Files\Git\bin\bash.exe".into(),
        args: vec!["-lc".into()],
    };
    let env = BTreeMap::from([
        ("KEPT".to_string(), "yes".to_string()),
        (crate::proc::LINE_ENV.to_string(), "forged".to_string()),
        ("OCTIQ_CHAT_KEY".to_string(), "chat:leak".to_string()),
    ]);
    for (name, line) in every_one_shot_line(&prompt) {
        assert!(line.len() > 8186, "{name}");
        assert_eq!(
            line.contains(r"'C:\Users\me\repo with space'"),
            names_the_checkout(name),
            "{name}"
        );
        let cmd = one_shot_command(&bash, &line, r"C:\Users\me\source", &env, true);
        assert_eq!(cmd.get_program(), r"C:\Program Files\Git\bin\bash.exe");
        let args: Vec<_> = cmd.get_args().map(|a| a.to_str().unwrap()).collect();
        assert_eq!(args.len(), 2, "{name}");
        assert_eq!(args[0], "-lc");
        assert!(
            args[1].len() < 200 && !args[1].contains("claude") && !args[1].contains("codex"),
            "{name}: the argument must not carry the line: {}",
            args[1]
        );
        let envs: BTreeMap<_, _> = cmd
            .get_envs()
            .map(|(k, v)| (k.to_str().unwrap(), v.map(|v| v.to_str().unwrap())))
            .collect();
        assert_eq!(
            envs.get(crate::proc::LINE_ENV),
            Some(&Some(line.as_str())),
            "{name}: the line travels whole, backslashes and all"
        );
        assert_eq!(envs.get("KEPT"), Some(&Some("yes")));
        assert_eq!(envs.get("OCTIQ_CHAT_KEY"), Some(&None), "{name}");
        let set: Vec<_> = envs
            .iter()
            .filter(|(k, v)| k.starts_with("OCTIQ_") && v.is_some())
            .map(|(k, _)| *k)
            .collect();
        assert_eq!(set, [crate::proc::LINE_ENV], "{name}: no other OCTIQ_ set");
        assert_eq!(
            cmd.get_current_dir().and_then(|d| d.to_str()),
            Some(r"C:\Users\me\source")
        );
    }
}

#[test]
fn off_windows_a_one_shot_line_is_the_argument_and_no_octiq_variable_is_set() {
    let prompt = long_windows_prompt();
    let sh = crate::proc::AgentShell {
        program: "/bin/zsh".into(),
        args: vec!["-lc".into()],
    };
    let env = BTreeMap::from([
        ("KEPT".to_string(), "yes".to_string()),
        (crate::proc::LINE_ENV.to_string(), "forged".to_string()),
        ("OCTIQ_CHAT_KEY".to_string(), "chat:leak".to_string()),
    ]);
    for (name, line) in every_one_shot_line(&prompt) {
        let cmd = one_shot_command(&sh, &line, "/", &env, false);
        let args: Vec<_> = cmd.get_args().map(|a| a.to_str().unwrap()).collect();
        assert_eq!(args, ["-lc", line.as_str()], "{name}");
        let envs: BTreeMap<_, _> = cmd
            .get_envs()
            .map(|(k, v)| (k.to_str().unwrap(), v.map(|v| v.to_str().unwrap())))
            .collect();
        assert_eq!(envs.get("KEPT"), Some(&Some("yes")), "{name}");
        let set: Vec<_> = envs
            .iter()
            .filter(|(k, v)| is_octiq_variable(k) && v.is_some())
            .collect();
        assert!(set.is_empty(), "{name}: {set:?}");
        // Removed outright, whatever this process inherited: the carrier
        // and every variable that ties a process to a chat.
        for removed in CHAT_VARIABLES.iter().chain([&crate::proc::LINE_ENV]) {
            assert_eq!(envs.get(removed), Some(&None), "{name}: {removed}");
        }
    }
}

/// Set by `an_inherited_octiq_variable_never_reaches_a_one_shot_process`
/// on the copy of this test binary it starts.
const INHERITING_RUN: &str = "PEER_TEST_INHERITED_OCTIQ";

/// The suite's own environment decides nothing here: this test starts
/// a copy of itself with a forged launch line and chat key really in its
/// environment, and that copy runs the one-shot checks. No other test's
/// environment is touched.
#[cfg(unix)]
#[test]
fn an_inherited_octiq_variable_never_reaches_a_one_shot_process() {
    if std::env::var_os(INHERITING_RUN).is_some() {
        assert_eq!(
            std::env::var(crate::proc::LINE_ENV).as_deref(),
            Ok("inherited-forged")
        );
        // Off Windows: the agent sees no OCTIQ_ variable at all.
        a_one_shot_process_gets_no_octiq_variable_from_anywhere();
        // On Windows' delivery: the shell runs OUR line, not the forged
        // one, and the agent again sees no OCTIQ_ variable.
        the_windows_delivery_hands_every_one_shot_line_over_whole();
        return;
    }
    let name =
        "orchestration::peer::tests::an_inherited_octiq_variable_never_reaches_a_one_shot_process";
    let out = Command::new(std::env::current_exe().unwrap())
        .args([name, "--exact", "--nocapture", "--test-threads=1"])
        .env(INHERITING_RUN, "1")
        .env(crate::proc::LINE_ENV, "inherited-forged")
        .env("OCTIQ_CHAT_CAPABILITY", "inherited-forged")
        .stdin(Stdio::null())
        .output()
        .unwrap();
    let printed = format!(
        "{}{}",
        String::from_utf8_lossy(&out.stdout),
        String::from_utf8_lossy(&out.stderr)
    );
    assert!(out.status.success(), "{printed}");
    assert!(printed.contains("1 passed"), "the copy ran it: {printed}");
}

/// The Windows delivery, run by this machine's own agent shell (Git Bash
/// on Windows, where it matters; the same one-liner runs in zsh): the
/// stand-in for the agent writes back every argument it got, and what
/// OCTIQ_ variables it saw.
#[test]
fn the_windows_delivery_hands_every_one_shot_line_over_whole() {
    // Forward slashes, which Git Bash reads as readily as `\`.
    let posix = |p: &Path| p.display().to_string().replace('\\', "/");
    let dir = crate::test_dir::TestDir::new("oneshot");
    let stub = dir.join("agent");
    fs::write(
            &stub,
            "#!/bin/sh\nfor a in \"$@\"; do printf '%s\\0' \"$a\"; done > \"$OUT\"\nenv | grep -c '^OCTIQ_' > \"$OUT.env\"\nexit 0\n",
        )
        .unwrap();
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(&stub, fs::Permissions::from_mode(0o755)).unwrap();
    }
    let shell = crate::proc::resolve_agent_shell(
        std::env::var("SHELL").ok(),
        std::env::var("LOCALAPPDATA").ok(),
        cfg!(windows),
        &crate::proc::find_executable,
    )
    .unwrap();
    let prompt = long_windows_prompt();
    let stub = crate::agent_provider::sh_quote(&posix(&stub));
    for (name, line) in every_one_shot_line(&prompt) {
        let out = dir.join(name.replace(' ', "-"));
        // The same quoting, with the stand-in in the agent's place.
        let line = line
            .replacen("exec claude ", &format!("exec {stub} "), 1)
            .replacen("exec codex ", &format!("exec {stub} "), 1);
        let env = BTreeMap::from([("OUT".to_string(), posix(&out))]);
        let status = one_shot_command(&shell, &line, "/", &env, true)
            .status()
            .unwrap();
        assert!(status.success(), "{name}");
        let got = fs::read(&out).unwrap();
        let args: Vec<String> = got
            .split(|b| *b == 0)
            .filter(|a| !a.is_empty())
            .map(|a| String::from_utf8(a.to_vec()).unwrap())
            .collect();
        assert!(args.contains(&prompt), "{name}: the prompt arrived whole");
        if names_the_checkout(name) {
            assert!(
                args.iter().any(|a| a == r"C:\Users\me\repo with space"),
                "{name}: {:?}",
                &args.iter().filter(|a| a.len() < 200).collect::<Vec<_>>()
            );
        }
        let leaked = fs::read_to_string(format!("{}.env", out.display())).unwrap();
        assert_eq!(
            leaked.trim(),
            "0",
            "{name}: no OCTIQ_ variable, the line's included"
        );
    }
}

#[cfg(unix)]
#[test]
fn a_one_shot_process_that_overruns_is_ended() {
    let error = run_one_shot(
        ChatAgent::Claude,
        "exec sleep 30",
        "/",
        &BTreeMap::new(),
        Duration::from_millis(300),
        "The stand-in",
    )
    .unwrap_err();
    assert_eq!(error, "The stand-in did not answer within 1s.");
}

#[test]
fn the_prompt_quotes_the_question_under_the_hosts_rules() {
    let (agents, _) = roster();
    let prompt = helper_prompt(
        "",
        &agents[1],
        "ADA",
        Some("Fix login"),
        "Why does it 401?",
        &["src/a.rs".into()],
    );
    assert!(prompt.starts_with("You are BO, a registered OctiqFlow agent. Your role: bo role."));
    assert!(prompt.contains("working on the task \"Fix login\""));
    assert!(prompt.contains("not doing the work"));
    assert!(prompt.contains("cannot ask anyone else"));
    assert!(prompt.contains("- src/a.rs"));
    assert!(prompt.ends_with("ADA's question:\nWhy does it 401?"));
}

/// A teammate answers as itself: the shared policy, its standing
/// instructions, then its role, ahead of the host's peer rules.
#[test]
fn a_teammate_answers_under_the_policy_and_its_standing_instructions() {
    let (agents, _) = roster();
    let mut bo = agents[1].clone();
    bo.persistent_prompt = "Check the auth middleware first.".into();
    let prompt = helper_prompt(
        "Never push.",
        &bo,
        "ADA",
        Some("Fix login"),
        "Why does it 401?",
        &[],
    );
    let policy = prompt.find("Never push.").unwrap();
    let standing = prompt.find("Check the auth middleware first.").unwrap();
    let role = prompt
        .find("You are BO, a registered OctiqFlow agent. Your role: bo role.")
        .unwrap();
    assert!(prompt.starts_with("Shared agent policy"), "{prompt}");
    assert!(policy < standing && standing < role, "{prompt}");
}

#[test]
fn an_antigravity_teammate_answers_read_only_from_its_stream() {
    let turn = HelperTurn {
        agent: ChatAgent::Antigravity,
        model: "gemini-3.8-flash-high".into(),
        effort: Some("high".into()),
        prompt: "it's a question".into(),
        cwd: "/w".into(),
    };
    let line = helper_command(&turn).unwrap();
    assert!(
        line.starts_with("exec agy -p 'it'\\''s a question"),
        "{line}"
    );
    assert!(line.contains("--output-format stream-json --mode plan --disable-slash-commands"));
    assert!(line.ends_with("--model 'gemini-3.8-flash-high'"), "{line}");
    assert!(
        !line.contains("--effort"),
        "the model names its own: {line}"
    );
    assert!(!line.contains("--add-dir"), "no OctiqFlow plugin: {line}");

    // The real stream's first turn, cut where `-p` would stop.
    let stream = crate::agent_provider::tests::AGY_THREE_TURNS;
    let first: String = stream
        .lines()
        .take_while(|line| !line.contains("\"step_index\":4"))
        .map(|line| format!("{line}\n"))
        .collect();
    let answer = parse_antigravity(&first).unwrap();
    assert!(answer.text.contains("4471"));
    let usage = answer.usage.unwrap();
    assert!(usage.input_tokens > 0 && usage.output_tokens > 0);
    assert!(
        parse_antigravity(crate::agent_provider::tests::AGY_BAD_MODEL)
            .unwrap_err()
            .contains("is not recognized")
    );
    assert!(parse_antigravity("").is_err());
}
