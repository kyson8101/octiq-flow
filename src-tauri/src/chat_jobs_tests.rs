//! The job store (`chat_jobs.rs`): a wrapper's start, progress and end, a
//! registered pid and its log, the restart, and the wake turn told once.
use super::*;
use crate::agent_chat::{ChatAgent, ChatManager};
use crate::bus::tap::Tap;
use crate::job_progress::Unit;
use crate::test_dir::TestDir;
use std::io::BufRead;
use std::sync::Arc;

fn chat() -> String {
    format!("chat:job-test-{}", uuid::Uuid::new_v4().simple())
}

fn store_at(dir: &TestDir) -> Store {
    Store::load(dir.join("jobs.json"))
}

fn start(store: &Store, chat: &str, wake: bool) -> (String, String) {
    let (job, token) = store
        .start(
            chat,
            serde_json::from_value(json!({
                "label": "render", "command": "sh -c 'echo 1/3'", "wake": wake,
            }))
            .unwrap(),
        )
        .unwrap();
    (job["id"].as_str().unwrap().to_string(), token)
}

fn progress(done: f64, total: f64) -> Progress {
    Progress {
        phase: Some("Rendering".into()),
        done: Some(done),
        total: Some(total),
        unit: Some(Unit::Frames),
    }
}

fn end(code: Option<i32>) -> End {
    End {
        exit_code: code,
        signal: None,
        tail: vec!["1/3".into(), "2/3".into(), "3/3".into()],
    }
}

fn job_of(store: &Store, chat: &str) -> Value {
    store.list(Some(chat)).into_iter().next().expect("a job")
}

#[test]
fn a_wrapped_job_is_said_as_it_starts_moves_and_ends_in_the_contracts_shape() {
    let dir = TestDir::new("jobs");
    let store = store_at(&dir);
    let chat = chat();
    let tap = Tap::on(&chat);
    let (id, token) = start(&store, &chat, true);
    assert!(store.has_running(&chat));
    let job = job_of(&store, &chat);
    for (field, value) in [
        ("id", json!(id)),
        ("chatKey", json!(chat)),
        ("label", json!("render")),
        ("source", json!("wrapper")),
        ("status", json!("running")),
        ("command", json!("sh -c 'echo 1/3'")),
        ("wake", json!(true)),
    ] {
        assert_eq!(job[field], value, "{field}");
    }
    assert!(job["elapsedMs"].is_u64() && job["sinceUpdateMs"].is_u64());
    // Nothing the job has not said: no counts, no exit code while running.
    for absent in ["done", "total", "unit", "phase", "exitCode", "reason"] {
        assert!(job.get(absent).is_none(), "{absent}: {job}");
    }

    store.progress(&id, &token, progress(30.0, 90.0)).unwrap();
    let job = job_of(&store, &chat);
    assert_eq!(
        (&job["phase"], &job["done"], &job["total"], &job["unit"]),
        (
            &json!("Rendering"),
            &json!(30.0),
            &json!(90.0),
            &json!("frames")
        )
    );
    // Another job's token, or none, speaks for nothing.
    assert!(store
        .progress(&id, "not-the-token", progress(31.0, 90.0))
        .is_err());
    assert!(store.end("no-such-job", &token, end(Some(0))).is_err());

    store.end(&id, &token, end(Some(0))).unwrap();
    assert!(!store.has_running(&chat));
    let job = job_of(&store, &chat);
    assert_eq!(
        (&job["status"], &job["exitCode"]),
        (&json!("done"), &json!(0))
    );
    // An end said twice is one end.
    store.end(&id, &token, end(Some(1))).unwrap_or(());
    assert_eq!(job_of(&store, &chat)["status"], "done");

    let heard: Vec<String> = tap
        .heard()
        .into_iter()
        .filter(|(event, _)| event == "chat-job")
        .map(|(_, payload)| {
            assert_eq!(payload["chatKey"], json!(chat));
            payload["job"]["status"].as_str().unwrap().to_string()
        })
        .collect();
    assert_eq!(heard, ["running", "running", "done"]);
}

#[test]
fn progress_is_said_at_most_twice_a_second_and_what_was_held_back_is_said_on_the_next_look() {
    let dir = TestDir::new("jobs");
    let store = store_at(&dir);
    let chat = chat();
    let (id, token) = start(&store, &chat, false);
    let tap = Tap::on(&chat);
    for done in 1..=10 {
        store
            .progress(&id, &token, progress(done as f64, 90.0))
            .unwrap();
    }
    let said = |tap: &Tap| {
        tap.heard()
            .into_iter()
            .filter(|(event, _)| event == "chat-job")
            .map(|(_, p)| p["job"]["done"].as_f64().unwrap())
            .collect::<Vec<_>>()
    };
    assert_eq!(said(&tap), [1.0]);
    std::thread::sleep(EMIT_EVERY);
    store.look(&|_| true);
    assert_eq!(said(&tap), [1.0, 10.0]);
}

#[test]
fn a_job_never_carries_a_count_it_was_not_given_whole() {
    let dir = TestDir::new("jobs");
    let store = store_at(&dir);
    let chat = chat();
    let (id, token) = start(&store, &chat, false);
    for bad in [
        Progress {
            done: Some(5.0),
            total: None,
            ..progress(0.0, 1.0)
        },
        Progress {
            done: Some(9.0),
            total: Some(8.0),
            ..progress(0.0, 1.0)
        },
        Progress {
            done: Some(f64::NAN),
            total: Some(8.0),
            ..progress(0.0, 1.0)
        },
    ] {
        store.progress(&id, &token, bad).unwrap();
        let job = job_of(&store, &chat);
        assert!(
            job.get("done").is_none() && job.get("total").is_none(),
            "{job}"
        );
        assert_eq!(job["phase"], "Rendering");
    }
}

#[test]
fn every_chats_running_jobs_and_the_last_ten_minutes_ended() {
    let dir = TestDir::new("jobs");
    let store = store_at(&dir);
    let (a, b, c) = (chat(), chat(), chat());
    start(&store, &a, false);
    let (id, token) = start(&store, &b, false);
    store.end(&id, &token, end(Some(2))).unwrap();
    let (old, token) = start(&store, &c, false);
    store.end(&old, &token, end(Some(0))).unwrap();
    store
        .inner
        .lock()
        .unwrap()
        .jobs
        .get_mut(&old)
        .unwrap()
        .ended_at = Some(now_ms() - RECENT_MS - 1);
    let all = store.list(None);
    let chats: BTreeSet<&str> = all.iter().filter_map(|j| j["chatKey"].as_str()).collect();
    assert!(chats.contains(a.as_str()) && chats.contains(b.as_str()));
    assert!(
        !chats.contains(c.as_str()),
        "ended more than ten minutes ago"
    );
    assert_eq!(store.list(Some(&c)).len(), 1, "a chat's own list keeps it");
    let failed = &store.list(Some(&b))[0];
    assert_eq!(
        (&failed["status"], &failed["exitCode"]),
        (&json!("failed"), &json!(2))
    );
}

#[test]
fn a_restart_interrupts_what_was_running_says_so_and_keeps_no_token() {
    let dir = TestDir::new("jobs");
    let chat = chat();
    let (id, token) = {
        let store = store_at(&dir);
        start(&store, &chat, true)
    };
    let file = std::fs::read_to_string(dir.join("jobs.json")).unwrap();
    assert!(
        !file.contains(&token),
        "the token is the server's, in memory only"
    );
    let tap = Tap::on(&chat);
    let store = store_at(&dir);
    let job = job_of(&store, &chat);
    assert_eq!(job["status"], "interrupted");
    assert!(job["reason"].as_str().unwrap().contains("restarted"));
    assert_eq!(job["exitCode"], Value::Null);
    assert!(!store.has_running(&chat));
    // The old token speaks for nothing now.
    assert!(store.progress(&id, &token, progress(1.0, 2.0)).is_err());
    let said: Vec<Value> = tap
        .heard()
        .into_iter()
        .filter(|(event, p)| event == "chat-event" && p["event"]["type"] == "octiq_job_interrupted")
        .map(|(_, p)| p["event"].clone())
        .collect();
    assert_eq!(said.len(), 1, "{:?}", tap.heard());
    assert_eq!(said[0]["job_ids"], json!([id]));
    // On disk too.
    let saved: Value =
        serde_json::from_slice(&std::fs::read(dir.join("jobs.json")).unwrap()).unwrap();
    assert_eq!(saved[&id]["status"], "interrupted");
}

#[test]
fn a_registered_pid_that_exits_ends_its_job_with_no_exit_code_and_its_log_is_read() {
    let dir = TestDir::new("jobs");
    let store = store_at(&dir);
    let chat = chat();
    let log = dir.join("render.log");
    std::fs::write(&log, "Rendered 1/90, earlier\n").unwrap();
    let registered = store
        .register(
            &chat,
            serde_json::from_value(json!({
                "label": "remotion", "pid": 4242, "logFile": log, "pattern": "remotion",
            }))
            .unwrap(),
        )
        .unwrap();
    assert_eq!(registered["source"], "registered");
    // What the log held before is not this job's progress.
    store.look(&|_| true);
    assert!(job_of(&store, &chat).get("done").is_none());
    std::fs::write(
        &log,
        "Rendered 1/90, earlier\nRendered 45/90, time remaining: 3s\n",
    )
    .unwrap();
    std::thread::sleep(EMIT_EVERY);
    store.look(&|_| true);
    let job = job_of(&store, &chat);
    assert_eq!(
        (&job["done"], &job["total"], &job["phase"]),
        (&json!(45.0), &json!(90.0), &json!("Rendering"))
    );
    store.look(&|pid| pid != 4242);
    let job = job_of(&store, &chat);
    assert_eq!(job["status"], "ended");
    assert_eq!(job["exitCode"], Value::Null);
    assert!(job["reason"]
        .as_str()
        .unwrap()
        .contains("exit code is unknown"));
    assert_eq!(
        store.inner.lock().unwrap().jobs[registered["id"].as_str().unwrap()].wake_turn,
        Wake::Owed
    );

    for bad in [
        json!({ "label": "x", "pid": 0 }),
        json!({ "label": " ", "pid": 7 }),
        json!({ "label": "x", "pid": 7, "logFile": "relative.log" }),
        json!({ "label": "x", "pid": 7, "pattern": "x264" }),
    ] {
        assert!(
            store
                .register(&chat, serde_json::from_value(bad.clone()).unwrap())
                .is_err(),
            "{bad}"
        );
    }
}

#[test]
fn a_progress_file_is_read_whole_as_it_is_rewritten() {
    let dir = TestDir::new("jobs");
    let store = store_at(&dir);
    let chat = chat();
    let file = dir.join("progress.json");
    store
        .register(
            &chat,
            serde_json::from_value(json!({ "label": "images", "pid": 77, "progressFile": file }))
                .unwrap(),
        )
        .unwrap();
    std::fs::write(&file, r#"{"done":3,"total":8,"phase":"Generating"}"#).unwrap();
    store.look(&|_| true);
    let job = job_of(&store, &chat);
    assert_eq!(
        (&job["done"], &job["total"], &job["unit"]),
        (&json!(3.0), &json!(8.0), &json!("items"))
    );
    // Caught half-written: the last whole reading stands.
    std::fs::write(&file, r#"{"done":4,"to"#).unwrap();
    std::thread::sleep(EMIT_EVERY);
    store.look(&|_| true);
    assert_eq!(job_of(&store, &chat)["done"], json!(3.0));
}

#[test]
fn a_wrapper_that_goes_without_an_end_interrupts_its_job() {
    let dir = TestDir::new("jobs");
    let store = store_at(&dir);
    let chat = chat();
    store
        .start(
            &chat,
            serde_json::from_value(json!({ "label": "x", "wrapperPid": 991 })).unwrap(),
        )
        .unwrap();
    store.look(&|pid| pid != 991);
    let job = job_of(&store, &chat);
    assert_eq!(job["status"], "interrupted");
    assert!(job["reason"]
        .as_str()
        .unwrap()
        .contains("octiq-job stopped"));
}

/// A manager with this store and a stand-in agent between turns, whose
/// every input is kept.
fn manager_with(store: Store) -> Arc<ChatManager> {
    let mut manager = ChatManager::default();
    manager.jobs = store;
    Arc::new(manager)
}

fn wake_lines(chat: &str, turn_id: &str) -> usize {
    crate::transcript::since(chat, 0)
        .into_iter()
        .filter(|item| item.event["type"] == "user" && item.event["uuid"] == turn_id)
        .count()
}

#[test]
fn a_job_that_ends_wakes_its_agent_once_across_passes_and_a_restart() {
    let dir = TestDir::new("jobs");
    let chat = chat();
    let manager = manager_with(store_at(&dir));
    let (_child, heard) = manager.test_hold_heard(&chat, ChatAgent::Claude, false);
    let (id, token) = start(&manager.jobs, &chat, true);
    manager.jobs.end(&id, &token, end(Some(1))).unwrap();
    deliver_wakes(&manager);
    deliver_wakes(&manager);
    let turn_id = format!("{WAKE_PREFIX}{id}");
    assert_eq!(wake_lines(&chat, &turn_id), 1);
    let saved: Value =
        serde_json::from_slice(&std::fs::read(dir.join("jobs.json")).unwrap()).unwrap();
    assert_eq!(saved[&id]["wakeTurn"], "told");

    // A server that restarts before it could note the wake as told finds it
    // in the record, and sends nothing.
    manager
        .jobs
        .inner
        .lock()
        .unwrap()
        .jobs
        .get_mut(&id)
        .unwrap()
        .wake_turn = Wake::Owed;
    let mut inner = manager.jobs.inner.lock().unwrap();
    manager.jobs.save(&mut inner);
    drop(inner);
    let restarted = manager_with(store_at(&dir));
    restarted.test_hold(&chat, ChatAgent::Claude, false);
    deliver_wakes(&restarted);
    assert_eq!(wake_lines(&chat, &turn_id), 1);
    assert_eq!(
        restarted.jobs.inner.lock().unwrap().jobs[&id].wake_turn,
        Wake::Told
    );

    manager.test_finish(&chat);
    let written: Vec<String> = heard
        .lines()
        .map_while(Result::ok)
        .filter(|line| line.starts_with('{'))
        .collect();
    assert_eq!(written.len(), 1, "{written:?}");
    let text = written[0].clone();
    assert!(
        text.contains("[OctiqFlow job ended]") && text.contains("render"),
        "{text}"
    );
    assert!(
        text.contains("failed: exit code 1") && text.contains("3/3"),
        "{text}"
    );
}

#[test]
fn a_wake_waits_behind_a_running_turn_and_none_is_sent_when_none_was_asked() {
    let dir = TestDir::new("jobs");
    let chat = chat();
    let manager = manager_with(store_at(&dir));
    manager.test_hold(&chat, ChatAgent::Claude, true);
    let (id, token) = start(&manager.jobs, &chat, true);
    manager.jobs.end(&id, &token, end(Some(0))).unwrap();
    deliver_wakes(&manager);
    let turn_id = format!("{WAKE_PREFIX}{id}");
    let turns = crate::agent_chat::host_turns(&manager, &chat, &turn_id, None).unwrap();
    assert_eq!(
        turns.get(&turn_id),
        Some(&crate::agent_chat::HostTurn::Handed)
    );
    assert!(
        manager.has_queued_turns(&chat),
        "queued behind the turn in flight"
    );

    let (quiet, token) = start(&manager.jobs, &chat, false);
    manager.jobs.end(&quiet, &token, end(Some(0))).unwrap();
    deliver_wakes(&manager);
    assert_eq!(wake_lines(&chat, &format!("{WAKE_PREFIX}{quiet}")), 0);
    manager.test_end(&chat);
}

/// A chat the index lists, as every chat the person can open is.
fn listed_chat() -> String {
    let key = chat();
    crate::chat_index::upsert(
        serde_json::from_value(json!({
            "id": key.strip_prefix("chat:").unwrap(), "projectId": "p1", "title": "a chat", "updatedAt": 100,
        }))
        .unwrap(),
    )
    .unwrap();
    key
}

#[test]
fn a_chat_that_is_gone_is_not_woken_and_its_wake_is_not_owed_for_ever() {
    let dir = TestDir::new("jobs");
    let chat = chat();
    let manager = manager_with(store_at(&dir));
    let (id, token) = start(&manager.jobs, &chat, true);
    manager.jobs.end(&id, &token, end(Some(0))).unwrap();
    deliver_wakes(&manager);
    assert_eq!(
        manager.jobs.inner.lock().unwrap().jobs[&id].wake_turn,
        Wake::Told
    );
    assert_eq!(wake_lines(&chat, &format!("{WAKE_PREFIX}{id}")), 0);
}

#[test]
fn a_chat_with_no_process_and_nothing_to_start_it_from_is_woken_later() {
    let dir = TestDir::new("jobs");
    let chat = listed_chat();
    let manager = manager_with(store_at(&dir));
    let (id, token) = start(&manager.jobs, &chat, true);
    manager.jobs.end(&id, &token, end(Some(0))).unwrap();
    deliver_wakes(&manager);
    assert_eq!(
        manager.jobs.inner.lock().unwrap().jobs[&id].wake_turn,
        Wake::Owed
    );
    // It runs again: the next pass hands the wake over.
    manager.test_hold(&chat, ChatAgent::Claude, false);
    deliver_wakes(&manager);
    assert_eq!(
        manager.jobs.inner.lock().unwrap().jobs[&id].wake_turn,
        Wake::Told
    );
    assert_eq!(wake_lines(&chat, &format!("{WAKE_PREFIX}{id}")), 1);
    manager.test_end(&chat);
}

#[test]
fn a_settled_workers_job_wakes_its_coordinator_with_the_task_named() {
    use crate::orchestration::tests::{run, running_worker, settled_worker};
    let store = Arc::new(crate::orchestration::OrchestrationStore::default());
    let live = running_worker(&store, &run(&store));
    let settled = settled_worker(&store, &run(&store), None);
    let (to, about) = wake_target(&store, &live.worker_chat_key).unwrap();
    assert_eq!((to.as_str(), about), (live.worker_chat_key.as_str(), None));
    let (to, about) = wake_target(&store, &settled.worker_chat_key).unwrap();
    assert_eq!(to, "chat:master");
    let about = about.unwrap();
    assert!(
        about.contains(&settled.task_id) && about.contains("settled"),
        "{about}"
    );
    let mine = chat();
    assert_eq!(wake_target(&store, &mine).unwrap(), (mine.clone(), None));
}

#[test]
fn the_launcher_runs_the_server_binary_that_wrote_it() {
    assert_eq!(
        sh_launcher("/opt/octiq/octiq-server", false),
        "#!/bin/sh\n# Written by OctiqFlow: octiq-job, run by the server that wrote it.\nexec '/opt/octiq/octiq-server' job \"$@\"\n"
    );
    assert!(sh_launcher("/it's/octiq-server", false).contains("exec '/it'\\''s/octiq-server' job"));
    assert!(sh_launcher("C:\\Users\\Dev\\octiq-server.exe", true)
        .contains("exec '/c/Users/Dev/octiq-server.exe' job"));
    assert_eq!(
        cmd_launcher("C:\\Program Files\\octiq-server.exe"),
        "@echo off\r\nrem Written by OctiqFlow: octiq-job, run by the server that wrote it.\r\n\"C:\\Program Files\\octiq-server.exe\" job %*\r\n"
    );
    let env = agent_env("chat:a", Some("/usr/bin".into()));
    let get = |name: &str| env.iter().find(|(n, _)| n == name).map(|(_, v)| v.clone());
    let launcher = get("OCTIQ_JOB").unwrap();
    assert!(launcher.ends_with("octiq-job"));
    assert!(std::path::Path::new(&launcher).is_file());
    assert_eq!(get("OCTIQ_JOB_SESSION").as_deref(), Some("chat:a"));
    let dir = std::path::Path::new(&launcher)
        .parent()
        .unwrap()
        .to_string_lossy()
        .into_owned();
    assert!(get("PATH").unwrap().starts_with(&dir) && get("PATH").unwrap().ends_with("/usr/bin"));
}

#[test]
fn a_wake_turns_first_line_names_the_job_in_one_line_of_json_and_says_the_same_every_try() {
    let dir = TestDir::new("jobs");
    let chat = chat();
    let store = store_at(&dir);
    let label = "render · \"final\"\ncut";
    let open = |code: Option<i32>| {
        let (job, token) = store
            .start(
                &chat,
                serde_json::from_value(json!({ "label": label, "wake": true })).unwrap(),
            )
            .unwrap();
        let id = job["id"].as_str().unwrap().to_string();
        store.end(&id, &token, end(code)).unwrap();
        id
    };
    for (code, status, exit) in [
        (Some(0), "done", json!(0)),
        (Some(3), "failed", json!(3)),
        (None, "failed", Value::Null),
    ] {
        let id = open(code);
        let job = store.inner.lock().unwrap().jobs[&id].clone();
        let text = wake_text(&job, None);
        assert_eq!(text, wake_text(&job, None), "every try says the same");
        let (first, rest) = text.split_once('\n').unwrap();
        let facts = first
            .strip_prefix("[OctiqFlow job ended] ")
            .unwrap_or_else(|| panic!("{first}"));
        let facts: Value = serde_json::from_str(facts).unwrap();
        assert_eq!(
            facts,
            json!({ "id": id, "label": job.label, "status": status, "exitCode": exit })
        );
        assert_eq!(facts.as_object().unwrap().len(), 4);
        assert!(
            first.starts_with(&format!("{WAKE_TAG} {{\"id\":")),
            "{first}"
        );
        assert!(rest.starts_with("The job \"render"), "{rest}");
    }
    let mut interrupted = store
        .inner
        .lock()
        .unwrap()
        .jobs
        .values()
        .next()
        .unwrap()
        .clone();
    // The store makes a label one line, but a newline that reached the job
    // some other way is escaped by serde and still leaves one line of JSON.
    assert_eq!(interrupted.label, "render · \"final\" cut");
    interrupted.label = label.to_string();
    interrupted.status = Status::Interrupted;
    interrupted.exit_code = None;
    let text = wake_text(&interrupted, None);
    let first = text.lines().next().unwrap();
    assert!(
        first.ends_with(
            ",\"label\":\"render · \\\"final\\\"\\ncut\",\"status\":\"interrupted\",\"exitCode\":null}"
        ),
        "{first}"
    );
    let facts: Value =
        serde_json::from_str(first.strip_prefix(WAKE_TAG).unwrap().trim_start()).unwrap();
    assert_eq!(facts["label"], label);
}
