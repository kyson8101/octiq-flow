//! Which running services an `up` left pointing at containers that are gone
//! (feedback f6886885).
//!
//! `docker compose up` replaces or restarts only the services it has a
//! reason to: a rebuilt image, a changed configuration, a container that had
//! stopped. A service that depends on one of them and had no reason of its
//! own keeps running, and keeps whatever it resolved when it started. An
//! nginx gateway resolves its upstream names once, at start. After a
//! restart those names can point at other containers: on the recreated
//! network the Performance API and Core swapped addresses, so sign-in
//! reached the wrong service, while every container reported healthy.
//!
//! So after every `up` the host compares start times, whatever the reason
//! for the start. A running service that started BEFORE any service it
//! depends on (directly or through others, as the frozen configuration
//! declares) is recreated, and so is everything that depends on it. Nothing
//! else is touched: services with no newer dependency keep running, and
//! nothing outside the environment's own Compose project is ever named.
//! This is stateless, so a dependency restarted outside OctiqFlow is caught
//! by the next start just like one this host restarted.
use serde_json::Value;
use std::collections::{BTreeMap, BTreeSet};

/// A container start time, `(seconds, nanoseconds)` in UTC, comparable.
/// `None` when Docker reported one this does not understand.
type Start = Option<(String, u32)>;

/// When a service's running containers started: the oldest and the newest.
/// A scaled service is as stale as its oldest container, and as new as its
/// newest one.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Started {
    oldest: Start,
    newest: Start,
}

/// The `docker inspect` format `running` reads, one container per line.
pub const INSPECT_FORMAT: &str = "{{index .Config.Labels \"com.docker.compose.service\"}}|{{index .Config.Labels \"com.docker.compose.oneoff\"}}|{{.State.Running}}|{{.State.StartedAt}}";

/// Docker's RFC 3339 UTC time (`2026-09-27T14:06:48.417315308Z`) as a
/// comparable key. Go trims trailing zeros from the fraction, so it is
/// compared as a number, never as text.
fn start(text: &str) -> Start {
    let text = text.strip_suffix('Z')?;
    let (seconds, fraction) = text.split_once('.').unwrap_or((text, "0"));
    let bytes = seconds.as_bytes();
    let shaped = seconds.len() == 19
        && bytes.iter().enumerate().all(|(i, b)| match i {
            4 | 7 => *b == b'-',
            10 => *b == b'T',
            13 | 16 => *b == b':',
            _ => b.is_ascii_digit(),
        });
    if !shaped || fraction.is_empty() || fraction.len() > 9 {
        return None;
    }
    let nanos = format!("{fraction:0<9}").parse().ok()?;
    Some((seconds.to_owned(), nanos))
}

/// The running, non-one-off containers of an inspect in `INSPECT_FORMAT`,
/// by service.
pub fn running(output: &str) -> BTreeMap<String, Started> {
    let mut services: BTreeMap<String, Started> = BTreeMap::new();
    for line in output.lines() {
        let mut parts = line.trim().splitn(4, '|');
        let (Some(service), Some(oneoff), Some(running), Some(at)) =
            (parts.next(), parts.next(), parts.next(), parts.next())
        else {
            continue;
        };
        if service.is_empty() || oneoff.eq_ignore_ascii_case("true") || running != "true" {
            continue;
        }
        let at = start(at);
        services
            .entry(service.to_owned())
            .and_modify(|s| {
                s.oldest = earlier(&s.oldest, &at);
                s.newest = later(&s.newest, &at);
            })
            .or_insert(Started {
                oldest: at.clone(),
                newest: at,
            });
    }
    services
}

/// An unknown time is the earliest when judging a dependant (it may be
/// stale) and the latest when judging a dependency (it may be new).
fn earlier(a: &Start, b: &Start) -> Start {
    match (a, b) {
        (Some(x), Some(y)) => Some(x.min(y).clone()),
        _ => None,
    }
}

fn later(a: &Start, b: &Start) -> Start {
    match (a, b) {
        (Some(x), Some(y)) => Some(x.max(y).clone()),
        _ => None,
    }
}

/// `dependency` started after `dependant` did, or either time is unknown.
fn newer(dependency: &Start, dependant: &Start) -> bool {
    match (dependency, dependant) {
        (Some(d), Some(s)) => d > s,
        _ => true,
    }
}

/// Every service `service` depends on, directly or through others, as the
/// configuration declares (`depends_on`, list or map form).
fn dependencies(config: &Value, service: &str) -> BTreeSet<String> {
    let direct = |name: &str| -> Vec<String> {
        match &config["services"][name]["depends_on"] {
            Value::Object(map) => map.keys().cloned().collect(),
            Value::Array(list) => list
                .iter()
                .filter_map(|v| v.as_str().map(str::to_owned))
                .collect(),
            _ => Vec::new(),
        }
    };
    let mut seen = BTreeSet::new();
    let mut next = direct(service);
    while let Some(name) = next.pop() {
        if name != service && seen.insert(name.clone()) {
            next.extend(direct(&name));
        }
    }
    seen
}

/// The running services to recreate: each one that started before a running
/// service it depends on, and each one that depends on a service being
/// recreated. Stopped and one-off services are never named.
pub fn stale(config: &Value, running: &BTreeMap<String, Started>) -> BTreeSet<String> {
    let deps: BTreeMap<&String, BTreeSet<String>> = running
        .keys()
        .map(|name| (name, dependencies(config, name)))
        .collect();
    let mut stale = BTreeSet::new();
    loop {
        let before = stale.len();
        for (name, own) in running {
            if stale.contains(name) {
                continue;
            }
            let behind = deps[name].iter().any(|d| {
                stale.contains(d)
                    || running
                        .get(d)
                        .is_some_and(|dep| newer(&dep.newest, &own.oldest))
            });
            if behind {
                stale.insert(name.clone());
            }
        }
        if stale.len() == before {
            return stale;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn performance() -> Value {
        // The shape of the bundled Performance recipe, as Compose prints it.
        let on = |names: &[&str]| -> Value {
            names
                .iter()
                .map(|n| (n.to_string(), json!({"condition": "service_started"})))
                .collect::<serde_json::Map<_, _>>()
                .into()
        };
        json!({"services": {
            "seed-copy": {},
            "db": {"depends_on": on(&["seed-copy"])},
            "restore": {"depends_on": on(&["db"])},
            "core": {"depends_on": on(&["restore"])},
            "api": {"depends_on": on(&["restore"])},
            "frontend": {},
            "sso": {},
            "gateway": {"depends_on": ["core", "api", "frontend", "sso"]},
            "verify": {"profiles": ["check"]}
        }})
    }

    fn line(service: &str, at: &str) -> String {
        format!("{service}||true|{at}\n")
    }

    #[test]
    fn start_times_compare_as_numbers_whatever_zeros_go_trimmed() {
        assert!(start("2026-09-27T14:06:48.4Z") > start("2026-09-27T14:06:48.39Z"));
        assert!(start("2026-09-27T14:06:48.417315308Z") > start("2026-09-27T14:06:48.4173153Z"));
        assert!(start("2026-09-27T14:06:49Z") > start("2026-09-27T14:06:48.999999999Z"));
        assert_eq!(start("2026-09-27T14:06:48+08:00"), None);
        assert_eq!(start("yesterday"), None);
    }

    #[test]
    fn a_gateway_older_than_a_restarted_upstream_is_recreated_and_nothing_else() {
        // Feedback f6886885: `up --build` recreated api, core, sso and
        // frontend and kept the gateway, which still routed by old addresses.
        let inspect = [
            line("db", "2026-09-27T10:00:00.1Z"),
            line("gateway", "2026-09-27T10:00:05Z"),
            line("core", "2026-09-27T11:00:01.5Z"),
            line("api", "2026-09-27T11:00:01.25Z"),
            line("frontend", "2026-09-27T11:00:00Z"),
            line("sso", "2026-09-27T11:00:00Z"),
            // One-offs and stopped services are never named.
            "verify|True|true|2026-09-27T11:00:09Z\n".into(),
            "restore||false|2026-09-27T11:00:00.9Z\n".into(),
        ]
        .concat();
        let running = running(&inspect);
        assert!(!running.contains_key("verify") && !running.contains_key("restore"));
        assert_eq!(
            stale(&performance(), &running),
            BTreeSet::from(["gateway".to_string()])
        );
    }

    #[test]
    fn a_fresh_or_untouched_stack_recreates_nothing() {
        // Compose starts dependencies first, so a full `up` is never stale;
        // an `up` that changed nothing leaves every time as it was.
        let inspect = [
            line("db", "2026-09-27T10:00:00Z"),
            line("core", "2026-09-27T10:00:30Z"),
            line("api", "2026-09-27T10:00:30.000000001Z"),
            line("frontend", "2026-09-27T10:00:00Z"),
            line("sso", "2026-09-27T10:00:00Z"),
            line("gateway", "2026-09-27T10:00:31Z"),
        ]
        .concat();
        assert!(stale(&performance(), &running(&inspect)).is_empty());
    }

    #[test]
    fn a_restarted_database_reaches_its_dependants_through_a_one_off_between() {
        // core and api depend on the one-shot restore, which depends on db.
        // A db restarted alone still leaves them, and so the gateway, behind.
        let inspect = [
            line("db", "2026-09-27T12:00:00Z"),
            line("core", "2026-09-27T10:00:30Z"),
            line("api", "2026-09-27T10:00:30Z"),
            line("frontend", "2026-09-27T10:00:00Z"),
            line("sso", "2026-09-27T10:00:00Z"),
            line("gateway", "2026-09-27T10:00:31Z"),
        ]
        .concat();
        assert_eq!(
            stale(&performance(), &running(&inspect)),
            BTreeSet::from(["api".into(), "core".into(), "gateway".into()])
        );
    }

    #[test]
    fn an_unknown_time_or_a_scaled_service_errs_towards_recreating() {
        let config = json!({"services": {"app": {}, "edge": {"depends_on": ["app"]}}});
        let unknown = [line("app", "garbled"), line("edge", "2026-09-27T10:00:00Z")].concat();
        assert_eq!(stale(&config, &running(&unknown)).len(), 1);
        // Two app replicas, one restarted after the edge started.
        let scaled = [
            line("app", "2026-09-27T09:00:00Z"),
            line("app", "2026-09-27T11:00:00Z"),
            line("edge", "2026-09-27T10:00:00Z"),
        ]
        .concat();
        assert_eq!(
            stale(&config, &running(&scaled)),
            BTreeSet::from(["edge".to_string()])
        );
        // A dependency cycle cannot loop.
        let cycle = json!({"services": {"a": {"depends_on": ["b"]}, "b": {"depends_on": ["a"]}}});
        let both = [
            line("a", "2026-09-27T10:00:00Z"),
            line("b", "2026-09-27T10:00:01Z"),
        ]
        .concat();
        assert_eq!(stale(&cycle, &running(&both)).len(), 2);
    }
}
