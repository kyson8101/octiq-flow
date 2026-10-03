//! The lifecycle of orchestrated test environments (feedback caa2ca88, B3).
//!
//! Every attempt of a sandbox task used to build its own Compose stack, and
//! nothing stopped one: retries piled up stacks until someone pressed Stop on
//! each. Now:
//!
//! - **A retry takes over** its previous attempt's environment for the same
//!   worktree (`sandbox::Store::adopt`) — the same project and volumes.
//! - **What nothing needs is stopped**, volumes kept, by one reconciler
//!   thread woken by orchestration and sandbox changes (not on a timer). An
//!   environment is needed while its attempt is live; while a task that
//!   depends on its (passed) task is running; while the person holds it
//!   from its Sandbox panel; and — softly — while a dependant has still to
//!   run. Soft holds give way only when another task is waiting for a slot;
//!   the dependant's own dispatch starts it again (`dependencies`).
//! - **A stopped run stops its environments**, except those the person
//!   holds.
//!
//! The rules are one pure function (`plan_stops`); the thread only executes
//! them, through the frozen configuration each environment was built from.
use super::*;
use crate::sandbox::capacity;
use std::time::Duration;

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Stop {
    pub key: String,
    pub reason: String,
}

fn attempt_live(data: &Snapshot, attempt: &Attempt) -> bool {
    matches!(
        attempt.status,
        AttemptStatus::Preparing | AttemptStatus::Running
    ) || (attempt.status == AttemptStatus::Blocked
        && data.gates.iter().any(|g| {
            g.status == GateStatus::Open && g.task_id.as_deref() == Some(attempt.task_id.as_str())
        }))
}

fn task_live(data: &Snapshot, task: &Task) -> bool {
    task.active_attempt_id
        .as_deref()
        .and_then(|id| data.attempts.iter().find(|a| a.id == id))
        .is_some_and(|a| attempt_live(data, a))
}

/// Which started environments of orchestrated attempts nothing needs, and
/// why. `live` are the started (not stopped) environments; `protected` are
/// held or wanted by a start in progress; `pressure` is whether a start is
/// waiting for a slot.
pub fn plan_stops(
    data: &Snapshot,
    sandboxes: &crate::sandbox::Snapshot,
    live: &BTreeSet<String>,
    protected: &BTreeSet<String>,
    pressure: bool,
) -> Vec<Stop> {
    let mut stops = Vec::new();
    for attempt in &data.attempts {
        let key = &attempt.worker_chat_key;
        if !live.contains(key) || protected.contains(key) {
            continue;
        }
        let Some(env) = sandboxes.environments.get(key).filter(|e| e.enabled) else {
            continue;
        };
        if env.lease.is_some() || attempt_live(data, attempt) {
            continue;
        }
        let Some(task) = data.tasks.iter().find(|t| t.id == attempt.task_id) else {
            continue;
        };
        let Some(run) = data.runs.iter().find(|r| r.id == task.run_id) else {
            continue;
        };
        let stop = |reason: &str| Stop {
            key: key.clone(),
            reason: reason.into(),
        };
        if run.status == RunStatus::Stopped || run.archived_at.is_some() {
            stops.push(stop("Its run stopped. Volumes are kept."));
            continue;
        }
        if task.active_attempt_id.as_deref() != Some(attempt.id.as_str()) {
            stops.push(stop(
                "A newer attempt of its task owns the work. Volumes are kept.",
            ));
            continue;
        }
        if !releases_dependants(task) {
            stops.push(stop(&format!(
                "Its task is {}; nothing is using these services. Volumes are kept.",
                serde_json::to_value(task.status)
                    .ok()
                    .and_then(|v| v.as_str().map(str::to_owned))
                    .unwrap_or_default()
            )));
            continue;
        }
        let dependants: Vec<&Task> = data
            .tasks
            .iter()
            .filter(|t| t.depends_on.contains(&task.id) && t.status != TaskStatus::Cancelled)
            .collect();
        if dependants.iter().any(|t| task_live(data, t)) {
            continue;
        }
        let to_come = dependants.iter().any(|t| {
            matches!(
                t.status,
                TaskStatus::Pending | TaskStatus::Ready | TaskStatus::Running
            )
        });
        if to_come && !pressure {
            continue;
        }
        stops.push(stop(if to_come {
            "Stopped to free a slot for a waiting task. It is started again before a task that depends on it runs. Volumes are kept."
        } else {
            "Its task is done and nothing that depends on it is still to run. Volumes are kept."
        }));
    }
    stops
}

/// The environments of the sandbox tasks `task` depends on, as (title,
/// chat key): what its dispatch starts or rechecks alongside its own, in
/// one capacity request.
pub fn dependencies(
    data: &Snapshot,
    sandboxes: &crate::sandbox::Snapshot,
    task: &Task,
) -> Vec<(String, String)> {
    task.depends_on
        .iter()
        .filter_map(|id| data.tasks.iter().find(|t| &t.id == id))
        .filter(|dep| dep.environment == TaskEnvironment::Sandbox)
        .filter_map(|dep| {
            let key = dep
                .active_attempt_id
                .as_deref()
                .and_then(|id| data.attempts.iter().find(|a| a.id == id))
                .map(|a| a.worker_chat_key.clone())?;
            sandboxes
                .environments
                .get(&key)
                .filter(|e| e.enabled)
                .map(|_| (dep.title.clone(), key))
        })
        .collect()
}

/// The newest earlier attempt of the same task that owns an environment:
/// what a retry takes over.
pub fn previous_owner(
    data: &Snapshot,
    sandboxes: &crate::sandbox::Snapshot,
    attempt: &Attempt,
) -> Option<String> {
    let mut earlier: Vec<&Attempt> = data
        .attempts
        .iter()
        .filter(|a| a.task_id == attempt.task_id && a.id != attempt.id)
        .collect();
    earlier.sort_by_key(|a| std::cmp::Reverse(a.number));
    earlier
        .into_iter()
        .map(|a| a.worker_chat_key.clone())
        .find(|key| sandboxes.environments.get(key).is_some_and(|e| e.enabled))
}

/// One pass: stop what nothing needs. Environments of ordinary chats are
/// never touched — only those whose key belongs to an orchestrated attempt.
fn reconcile(
    store: &OrchestrationStore,
    sandboxes: &crate::sandbox::Store,
    backoff: &mut BTreeMap<String, u64>,
) -> Result<(), String> {
    let live = sandboxes.live_keys();
    if !live.iter().any(|key| key.starts_with("chat:orch-")) {
        return Ok(());
    }
    let data = store.snapshot(None)?;
    let envs = sandboxes.snapshot()?;
    let now = crate::sandbox::now();
    let stops = plan_stops(
        &data,
        &envs,
        &live,
        &capacity::protected(),
        capacity::pressure(),
    );
    for stop in stops {
        // A stop that failed is not retried on every wake-up.
        if backoff
            .get(&stop.key)
            .is_some_and(|at| now.saturating_sub(*at) < 300_000)
        {
            continue;
        }
        // Protected since the plan was read: a start just asked for it.
        if capacity::protected().contains(&stop.key) {
            continue;
        }
        match sandboxes.host_stop(&stop.key, &stop.reason) {
            Ok(_) => {
                backoff.remove(&stop.key);
            }
            Err(error) => {
                eprintln!(
                    "orchestration: stopping environment {} failed: {error}",
                    stop.key
                );
                backoff.insert(stop.key, now);
            }
        }
    }
    Ok(())
}

pub fn start_reconciler(store: Arc<OrchestrationStore>) {
    std::thread::spawn(move || {
        let sandboxes = crate::sandbox::Store::profile();
        let mut backoff = BTreeMap::new();
        let mut seen = u64::MAX;
        loop {
            seen = capacity::wait_changed(seen, Duration::from_secs(600));
            // Let a burst of changes land before reading them.
            std::thread::sleep(Duration::from_millis(750));
            if let Err(error) = reconcile(&store, &sandboxes, &mut backoff) {
                eprintln!("orchestration: environment lifecycle failed: {error}");
            }
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::sandbox::{Environment, Lease};

    fn env(key: &str) -> Environment {
        Environment {
            id: format!(
                "octiq-sb-{}",
                key.replace(['c', 'h', 'a', 't', ':', '-'], "")
            ),
            chat_key: key.into(),
            enabled: true,
            locked: true,
            cwd: "/tmp".into(),
            state: "ready".into(),
            checked_at: Some(1),
            error: None,
            urls: BTreeMap::new(),
            source_revision: None,
            source_dirty: None,
            fixture_version: None,
            host_instance: "h".into(),
            docker_endpoint: None,
            fingerprint: None,
            frozen_recipe: None,
            frozen_replays: false,
            invalidated: None,
            lease: None,
            stopped: None,
            probed_at: None,
            probing: None,
        }
    }

    struct World {
        data: Snapshot,
        envs: crate::sandbox::Snapshot,
        live: BTreeSet<String>,
    }

    impl World {
        fn stops(&self, pressure: bool) -> Vec<String> {
            plan_stops(
                &self.data,
                &self.envs,
                &self.live,
                &BTreeSet::new(),
                pressure,
            )
            .into_iter()
            .map(|s| s.key)
            .collect()
        }
    }

    /// Build (A: sandbox task, B: depends on A) with A's attempt settled,
    /// through the real store, then read it as the reconciler would.
    fn world(verdict_pass: bool) -> (OrchestrationStore, Run, Task, Task, Attempt) {
        let store = OrchestrationStore::default();
        let run = crate::orchestration::tests::run(&store);
        let a = store
            .create_task_full(
                "chat:master",
                run.id.clone(),
                "Build".into(),
                "Build it".into(),
                Vec::new(),
                None,
                None,
                None,
                None,
                None,
                TaskEnvironment::Sandbox,
                None,
                if verdict_pass {
                    TaskKind::Work
                } else {
                    TaskKind::Check
                },
            )
            .unwrap();
        let b = crate::orchestration::tests::task(&store, &run, vec![a.id.clone()]);
        let (_, _, attempt, _) = store
            .reserve_attempt(
                "chat:master",
                &crate::orchestration::tests::launch_for(&a.id),
            )
            .unwrap();
        let attempt = store
            .activate_attempt(&attempt.id, "/tmp".into(), "a".into(), true)
            .unwrap();
        (store, run, a, b, attempt)
    }

    fn read(store: &OrchestrationStore, keys: &[&str]) -> World {
        let mut envs = crate::sandbox::Snapshot::default();
        for key in keys {
            envs.environments.insert((*key).into(), env(key));
        }
        World {
            data: store.snapshot(None).unwrap(),
            envs,
            live: keys.iter().map(|k| k.to_string()).collect(),
        }
    }

    fn settle(store: &OrchestrationStore, attempt: &Attempt, verdict: Option<Verdict>) {
        store
            .report_worker(
                &attempt.worker_chat_key,
                WorkerReport {
                    attempt_id: attempt.id.clone(),
                    outcome: WorkerOutcome::Completed,
                    summary: "done".into(),
                    files_modified: vec![],
                    verdict,
                },
            )
            .unwrap();
    }

    #[test]
    fn a_live_attempt_keeps_its_environment_and_a_settled_one_is_kept_only_for_what_depends_on_it()
    {
        let (store, _run, _a, b, attempt) = world(true);
        let key = attempt.worker_chat_key.as_str();
        assert!(read(&store, &[key]).stops(false).is_empty(), "live attempt");

        settle(&store, &attempt, None);
        // B has still to run: a soft hold, given up only under pressure.
        let w = read(&store, &[key]);
        assert!(w.stops(false).is_empty());
        assert_eq!(w.stops(true), vec![key.to_string()]);

        // B running on it: a hard hold, even under pressure.
        let (_, _, b_attempt, _) = store
            .reserve_attempt(
                "chat:master",
                &crate::orchestration::tests::launch_for(&b.id),
            )
            .unwrap();
        let b_attempt = store
            .activate_attempt(&b_attempt.id, "/tmp".into(), "b".into(), true)
            .unwrap();
        assert!(read(&store, &[key]).stops(true).is_empty());

        // B done: nothing needs A's services any more.
        settle(&store, &b_attempt, None);
        assert_eq!(read(&store, &[key]).stops(false), vec![key.to_string()]);
    }

    #[test]
    fn a_failed_check_a_stopped_run_and_a_superseded_attempt_free_their_environments_but_a_person_hold_stands(
    ) {
        // A check that failed releases nothing, so nothing will use it.
        let (store, run, _a, _b, attempt) = world(false);
        let key = attempt.worker_chat_key.clone();
        settle(&store, &attempt, Some(Verdict::Fail));
        let w = read(&store, &[&key]);
        assert_eq!(w.stops(false), vec![key.clone()]);

        // Held from the Sandbox panel: left alone whatever the rules say.
        let mut held = read(&store, &[&key]);
        held.envs.environments.get_mut(&key).unwrap().lease = Some(Lease {
            by: "person".into(),
            at: 1,
        });
        assert!(held.stops(true).is_empty());

        // The run stops: everything not held goes, soft holds included.
        let (store, run2, _a, _b, attempt) = world(true);
        let key = attempt.worker_chat_key.clone();
        settle(&store, &attempt, None);
        store
            .stop_run("chat:master", run2.id.clone(), "done".into())
            .unwrap();
        assert_eq!(read(&store, &[&key]).stops(false), vec![key.clone()]);
        let _ = run;

        // An older attempt's environment that was never taken over.
        let (store, _run, a, _b, first) = world(true);
        store
            .report_worker(
                &first.worker_chat_key,
                WorkerReport {
                    attempt_id: first.id.clone(),
                    outcome: WorkerOutcome::Failed,
                    summary: "flaky".into(),
                    files_modified: vec![],
                    verdict: None,
                },
            )
            .unwrap();
        let (_, _, second, _) = store
            .reserve_attempt(
                "chat:master",
                &crate::orchestration::tests::launch_for(&a.id),
            )
            .unwrap();
        let w = read(&store, &[&first.worker_chat_key, &second.worker_chat_key]);
        assert_eq!(w.stops(false), vec![first.worker_chat_key.clone()]);
    }

    /// Wait until the attempt's environment work is over (ready or failed).
    fn environment_done(store: &OrchestrationStore, id: &str) -> Attempt {
        let deadline = std::time::Instant::now() + Duration::from_secs(600);
        loop {
            let attempt = store
                .snapshot(None)
                .unwrap()
                .attempts
                .into_iter()
                .find(|a| a.id == id)
                .unwrap();
            if !attempt
                .execution
                .pending_tools
                .contains_key(super::super::ENVIRONMENT_OPERATION)
            {
                return attempt;
            }
            assert!(
                std::time::Instant::now() < deadline,
                "environment never settled"
            );
            std::thread::sleep(Duration::from_millis(100));
        }
    }

    #[test]
    #[ignore = "requires local Docker; creates and removes only its own test project"]
    fn docker_a_retry_reuses_its_stack_and_a_settled_task_stack_is_stopped_with_data_kept() {
        let _serial = capacity::TEST_LOCK
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        let root = crate::test_dir::TestDir::new("life");
        let project = root.join("project");
        fs::create_dir_all(project.join(".octiq")).unwrap();
        fs::write(project.join(".octiq/sandbox.json"), r#"{"version":1,"composeFile":"compose.json","checkService":"verify","endpoints":{"app":{"service":"app","port":80,"path":"/"}}}"#).unwrap();
        fs::write(project.join(".octiq/compose.json"), serde_json::to_vec(&json!({"services":{
            "app":{"image":"nginx:1.27-alpine","ports":[{"target":80,"host_ip":"127.0.0.1"}],"volumes":["data:/data"]},
            "verify":{"image":"alpine:3.22","profiles":["check"],"command":["sh","-c","wget -q -O /dev/null http://app"]}
        },"volumes":{"data":{}}})).unwrap()).unwrap();
        let git = |args: &[&str]| {
            std::process::Command::new("git")
                .args(args)
                .current_dir(&project)
                .output()
                .unwrap()
        };
        git(&["init", "-q"]);
        fs::write(project.join(".gitignore"), ".octiq/\n").unwrap();
        git(&["add", ".gitignore"]);
        git(&[
            "-c",
            "user.email=t@t",
            "-c",
            "user.name=t",
            "commit",
            "-q",
            "-m",
            "fixture",
        ]);
        let cwd = project.to_str().unwrap().to_owned();
        let sandboxes = || crate::sandbox::Store::at(root.join("sandboxes"));

        let store = Arc::new(OrchestrationStore::default());
        let run = crate::orchestration::tests::run(&store);
        let task = store
            .create_task_full(
                "chat:master",
                run.id.clone(),
                "Build".into(),
                "Build it".into(),
                Vec::new(),
                None,
                None,
                None,
                None,
                None,
                TaskEnvironment::Sandbox,
                None,
                TaskKind::Work,
            )
            .unwrap();
        let start = |store: &Arc<OrchestrationStore>| {
            let (_, _, attempt, _) = store
                .reserve_attempt(
                    "chat:master",
                    &crate::orchestration::tests::launch_for(&task.id),
                )
                .unwrap();
            let attempt = store
                .activate_attempt(&attempt.id, cwd.clone(), "b".into(), true)
                .unwrap();
            OrchestrationStore::start_after_environment(
                store.clone(),
                sandboxes(),
                attempt.clone(),
                || Ok(()),
            )
            .unwrap();
            environment_done(store, &attempt.id)
        };
        let first = start(&store);
        let env = sandboxes().snapshot().unwrap().environments[&first.worker_chat_key].clone();
        assert_eq!(env.state, "ready");
        let id = env.id.clone();
        // The attempt fails; its retry takes the same stack over.
        store
            .report_worker(
                &first.worker_chat_key,
                WorkerReport {
                    attempt_id: first.id.clone(),
                    outcome: WorkerOutcome::Failed,
                    summary: "flaky".into(),
                    files_modified: vec![],
                    verdict: None,
                },
            )
            .unwrap();
        let second = start(&store);
        let envs = sandboxes().snapshot().unwrap();
        assert!(!envs.environments.contains_key(&first.worker_chat_key));
        assert_eq!(
            envs.environments[&second.worker_chat_key].id, id,
            "no second stack"
        );
        assert_eq!(envs.environments[&second.worker_chat_key].state, "ready");
        assert_eq!(sandboxes().live_keys().len(), 1);

        // While the attempt is live, the reconciler leaves it alone.
        let mut backoff = BTreeMap::new();
        reconcile(&store, &sandboxes(), &mut backoff).unwrap();
        assert_eq!(
            sandboxes().snapshot().unwrap().environments[&second.worker_chat_key].state,
            "ready"
        );
        // Settled with nothing depending on it: stopped, data kept.
        store
            .report_worker(
                &second.worker_chat_key,
                WorkerReport {
                    attempt_id: second.id.clone(),
                    outcome: WorkerOutcome::Completed,
                    summary: "done".into(),
                    files_modified: vec![],
                    verdict: None,
                },
            )
            .unwrap();
        reconcile(&store, &sandboxes(), &mut backoff).unwrap();
        let stopped = sandboxes().snapshot().unwrap().environments[&second.worker_chat_key].clone();
        assert_eq!(stopped.state, "stopped");
        assert_eq!(stopped.stopped.as_ref().unwrap().by, "host");
        assert!(sandboxes().live_keys().is_empty());
        let docker = crate::proc::find_executable("docker").unwrap();
        let volumes = std::process::Command::new(&docker)
            .args(["volume", "ls", "-q", "--filter", &format!("name={id}_data")])
            .output()
            .unwrap();
        assert!(
            String::from_utf8_lossy(&volumes.stdout).contains(&format!("{id}_data")),
            "volume kept"
        );
        let _ = std::process::Command::new(&docker)
            .args(["volume", "rm", &format!("{id}_data")])
            .output();
    }

    #[test]
    fn a_task_waits_visibly_for_a_slot_and_a_stopped_run_ends_the_wait_without_starting_it() {
        let _serial = capacity::TEST_LOCK
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        assert_eq!(capacity::limit(), capacity::DEFAULT_LIMIT);
        let root = crate::test_dir::TestDir::new("cap");
        let cwd = root.join("work");
        fs::create_dir_all(&cwd).unwrap();
        let sandboxes = crate::sandbox::Store::at(root.join("sandboxes"));
        // Every slot taken by other chats' started environments.
        for key in ["chat:full-1", "chat:full-2", "chat:full-3"] {
            sandboxes
                .select(key, cwd.to_str().unwrap(), Some(true), false)
                .unwrap();
            sandboxes.force_live_for_test(key);
        }
        assert_eq!(sandboxes.live_keys().len(), 3);

        let store = Arc::new(OrchestrationStore::default());
        let run = crate::orchestration::tests::run(&store);
        let task = store
            .create_task_full(
                "chat:master",
                run.id.clone(),
                "Browser check".into(),
                "Check it".into(),
                Vec::new(),
                None,
                None,
                None,
                None,
                None,
                TaskEnvironment::Sandbox,
                None,
                TaskKind::Check,
            )
            .unwrap();
        let (_, _, attempt, _) = store
            .reserve_attempt(
                "chat:master",
                &crate::orchestration::tests::launch_for(&task.id),
            )
            .unwrap();
        let attempt = store
            .activate_attempt(&attempt.id, cwd.to_str().unwrap().into(), "b".into(), true)
            .unwrap();
        let started = Arc::new(std::sync::atomic::AtomicBool::new(false));
        let flag = started.clone();
        OrchestrationStore::start_after_environment(
            store.clone(),
            crate::sandbox::Store::at(root.join("sandboxes")),
            attempt.clone(),
            move || {
                flag.store(true, std::sync::atomic::Ordering::SeqCst);
                Ok(())
            },
        )
        .unwrap();
        let read = || {
            store
                .snapshot(None)
                .unwrap()
                .attempts
                .into_iter()
                .find(|a| a.id == attempt.id)
                .unwrap()
        };
        let deadline = std::time::Instant::now() + Duration::from_secs(10);
        while !read()
            .execution
            .current_operation
            .unwrap_or_default()
            .starts_with("Waiting for environment capacity")
        {
            assert!(std::time::Instant::now() < deadline, "never queued");
            std::thread::sleep(Duration::from_millis(50));
        }
        let waiting = read();
        assert_eq!(
            waiting.execution.current_operation.as_deref(),
            Some("Waiting for environment capacity: 3 of 3 in use, position 1 in line")
        );
        assert_eq!(
            waiting.status,
            AttemptStatus::Running,
            "waiting is not failing"
        );
        assert!(waiting
            .execution
            .pending_tools
            .contains_key(super::super::ENVIRONMENT_OPERATION));
        assert_eq!(capacity::waiting().len(), 1);
        assert_eq!(capacity::waiting()[0].keys[0], attempt.worker_chat_key);

        store
            .stop_run("chat:master", run.id.clone(), "not needed".into())
            .unwrap();
        let deadline = std::time::Instant::now() + Duration::from_secs(10);
        while !capacity::waiting().is_empty() {
            assert!(std::time::Instant::now() < deadline, "the wait never ended");
            std::thread::sleep(Duration::from_millis(50));
        }
        std::thread::sleep(Duration::from_millis(200));
        assert!(!started.load(std::sync::atomic::Ordering::SeqCst));
        assert_eq!(read().status, AttemptStatus::Cancelled);
        assert!(capacity::held().is_empty());
    }

    #[test]
    fn a_retry_takes_over_the_newest_earlier_environment_and_a_dependant_asks_for_its_dependencies()
    {
        let (store, _run, a, b, first) = world(true);
        store
            .report_worker(
                &first.worker_chat_key,
                WorkerReport {
                    attempt_id: first.id.clone(),
                    outcome: WorkerOutcome::Failed,
                    summary: "flaky".into(),
                    files_modified: vec![],
                    verdict: None,
                },
            )
            .unwrap();
        let (_, _, second, _) = store
            .reserve_attempt(
                "chat:master",
                &crate::orchestration::tests::launch_for(&a.id),
            )
            .unwrap();
        let w = read(&store, &[&first.worker_chat_key]);
        assert_eq!(
            previous_owner(&w.data, &w.envs, &second).as_deref(),
            Some(first.worker_chat_key.as_str())
        );
        let b = w.data.tasks.iter().find(|t| t.id == b.id).unwrap();
        // A's active attempt is now `second`, which has no environment yet.
        assert!(dependencies(&w.data, &w.envs, b).is_empty());
        let w = read(&store, &[&second.worker_chat_key]);
        assert_eq!(
            dependencies(&w.data, &w.envs, b),
            vec![("Build".to_string(), second.worker_chat_key.clone())]
        );
    }
}
