//! Whether a ready environment's services are still up (feedback caa2ca88,
//! B2), and the one background thread that asks.
//!
//! A readiness check proves the services answered at `checkedAt`. A crashed
//! API, a stopped database or a Docker restart afterwards leaves the record
//! saying "ready" about containers that are gone. So a ready environment is
//! probed — its sources and recipe against the check's fingerprint, then its
//! containers — and a probe that finds either wrong demotes it, with the
//! reason, to `stale` or `unhealthy`. Only a fresh start or check makes it
//! ready again: a service that came back by itself has not been re-checked.
//!
//! Probes never run on a reader's thread. A read (the Sandbox panel, the run
//! panel, an agent's snapshot) queues the environments whose last probe is
//! older than `FRESH`, and returns at once with what is known; ONE thread
//! works the queue, one probe at a time, each Docker call bounded. Nothing
//! polls: an environment nobody is looking at is not probed, and the
//! dispatch path re-runs the real start and check anyway.
use serde_json::Value;
use std::collections::{BTreeMap, BTreeSet, VecDeque};
use std::path::PathBuf;
use std::sync::{Condvar, Mutex, OnceLock};
use std::time::Duration;

/// How long a probe's answer stands before a read asks again.
pub const FRESH_MS: u64 = 20_000;
/// Bound on the one Docker call a container probe makes.
pub const PROBE_SECONDS: u64 = 15;

#[derive(Default)]
struct Queue {
    /// (store root, chat key) → when it was last probed.
    probed: BTreeMap<(PathBuf, String), u64>,
    waiting: VecDeque<(PathBuf, String)>,
    queued: BTreeSet<(PathBuf, String)>,
}

static QUEUE: OnceLock<(Mutex<Queue>, Condvar)> = OnceLock::new();
static WORKER: OnceLock<()> = OnceLock::new();

fn queue() -> &'static (Mutex<Queue>, Condvar) {
    QUEUE.get_or_init(|| (Mutex::new(Queue::default()), Condvar::new()))
}

/// When this environment was last probed, if it has been.
pub fn probed_at(root: &std::path::Path, key: &str) -> Option<u64> {
    let (lock, _) = queue();
    lock.lock()
        .ok()?
        .probed
        .get(&(root.to_path_buf(), key.to_owned()))
        .copied()
}

/// Whether a probe of this environment is queued or running.
pub fn in_flight(root: &std::path::Path, key: &str) -> bool {
    let (lock, _) = queue();
    lock.lock()
        .map(|q| q.queued.contains(&(root.to_path_buf(), key.to_owned())))
        .unwrap_or(false)
}

/// Queue a probe of each of `keys` not probed within `FRESH_MS`. Returns at
/// once; the answer lands in the store and raises `sandbox-changed`.
pub fn request(root: &std::path::Path, keys: impl IntoIterator<Item = String>, now: u64) {
    let (lock, wake) = queue();
    let Ok(mut q) = lock.lock() else {
        return;
    };
    let mut any = false;
    for key in keys {
        let id = (root.to_path_buf(), key);
        let fresh = q
            .probed
            .get(&id)
            .is_some_and(|at| now.saturating_sub(*at) < FRESH_MS);
        if !fresh && q.queued.insert(id.clone()) {
            q.waiting.push_back(id);
            any = true;
        }
    }
    drop(q);
    if any {
        WORKER.get_or_init(|| {
            std::thread::spawn(work);
        });
        wake.notify_all();
    }
}

fn work() {
    let (lock, wake) = queue();
    loop {
        let next = {
            let Ok(mut q) = lock.lock() else {
                return;
            };
            loop {
                if let Some(next) = q.waiting.pop_front() {
                    break next;
                }
                q = match wake.wait_timeout(q, Duration::from_secs(600)) {
                    Ok((q, _)) => q,
                    Err(_) => return,
                };
            }
        };
        let store = super::Store {
            root: next.0.clone(),
        };
        if let Err(error) = store.probe(&next.1) {
            eprintln!("sandbox: probe of {} failed: {error}", next.1);
        }
        if let Ok(mut q) = lock.lock() {
            q.queued.remove(&next);
            q.probed.insert(next, super::now());
        }
    }
}

/// Services a healthy environment must have running, and the one-shot
/// services it must have finished cleanly: those another service waits on
/// with `service_completed_successfully` (a seed copy, a restore).
fn expected(compose: &Value) -> (Vec<String>, BTreeSet<String>) {
    let mut one_shot = BTreeSet::new();
    let mut all = Vec::new();
    if let Some(services) = compose["services"].as_object() {
        for (name, service) in services {
            // A profiled service (the readiness checker) is not part of
            // what `up` starts.
            if service["profiles"]
                .as_array()
                .is_some_and(|p| !p.is_empty())
            {
                continue;
            }
            all.push(name.clone());
            if let Some(deps) = service["depends_on"].as_object() {
                for (dep, spec) in deps {
                    if spec["condition"] == "service_completed_successfully" {
                        one_shot.insert(dep.clone());
                    }
                }
            }
        }
    }
    all.sort();
    (all, one_shot)
}

/// `docker compose ps --all --format json` prints an array on some
/// versions and one object per line on others.
fn rows(output: &str) -> Vec<Value> {
    if let Ok(Value::Array(rows)) = serde_json::from_str::<Value>(output.trim()) {
        return rows;
    }
    output
        .lines()
        .filter_map(|line| serde_json::from_str::<Value>(line.trim()).ok())
        .filter(Value::is_object)
        .collect()
}

/// `Ok` when every expected service is as a healthy environment has it,
/// otherwise the first thing wrong, in words.
pub fn judge(compose: &Value, ps: &str) -> Result<(), String> {
    let (services, one_shot) = expected(compose);
    let rows = rows(ps);
    for name in services {
        let mine: Vec<&Value> = rows
            .iter()
            .filter(|r| r["Service"] == name.as_str())
            .collect();
        let exit = |row: &Value| row["ExitCode"].as_i64().unwrap_or(0);
        if one_shot.contains(&name) {
            if let Some(row) = mine.iter().find(|r| r["State"] == "exited" && exit(r) != 0) {
                return Err(format!(
                    "One-shot service {name} exited with code {}.",
                    exit(row)
                ));
            }
            continue;
        }
        let Some(row) = mine
            .iter()
            .find(|r| r["State"] == "running")
            .or_else(|| mine.first())
        else {
            return Err(format!("Service {name} has no container."));
        };
        let state = row["State"].as_str().unwrap_or("unknown");
        if state != "running" {
            return Err(match state {
                "exited" => format!("Service {name} exited with code {}.", exit(row)),
                other => format!("Service {name} is {other}."),
            });
        }
        if row["Health"] == "unhealthy" {
            return Err(format!("Service {name} reports unhealthy."));
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn compose() -> Value {
        json!({"services":{
            "seed":{"image":"alpine"},
            "db":{"image":"mssql","depends_on":{"seed":{"condition":"service_completed_successfully"}}},
            "api":{"image":"api","depends_on":{"db":{"condition":"service_healthy"}}},
            "verify":{"image":"node","profiles":["check"]}
        }})
    }

    #[test]
    fn a_healthy_stack_passes_whatever_format_compose_prints() {
        let lines = [
            r#"{"Service":"seed","State":"exited","ExitCode":0}"#,
            r#"{"Service":"db","State":"running","Health":"healthy"}"#,
            r#"{"Service":"api","State":"running","Health":""}"#,
        ];
        assert_eq!(judge(&compose(), &lines.join("\n")), Ok(()));
        let array = format!("[{}]", lines.join(","));
        assert_eq!(judge(&compose(), &array), Ok(()));
    }

    #[test]
    fn a_lost_stopped_or_unhealthy_service_is_named() {
        let seed = r#"{"Service":"seed","State":"exited","ExitCode":0}"#;
        let db = r#"{"Service":"db","State":"running","Health":"healthy"}"#;
        let cases = [
            (vec![seed, db], "api has no container"),
            (
                vec![
                    seed,
                    db,
                    r#"{"Service":"api","State":"exited","ExitCode":137}"#,
                ],
                "api exited with code 137",
            ),
            (
                vec![
                    seed,
                    db,
                    r#"{"Service":"api","State":"running","Health":"unhealthy"}"#,
                ],
                "api reports unhealthy",
            ),
            (
                vec![
                    r#"{"Service":"seed","State":"exited","ExitCode":1}"#,
                    db,
                    r#"{"Service":"api","State":"running"}"#,
                ],
                "seed exited with code 1",
            ),
            (vec![], "has no container"),
        ];
        for (rows, expected) in cases {
            let error = judge(&compose(), &rows.join("\n")).unwrap_err();
            assert!(error.contains(expected), "{error} / {expected}");
        }
    }
}
