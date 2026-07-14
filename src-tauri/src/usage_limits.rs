// Rate-limit "usage" readout for the global footer bar: the 5-hour rolling
// window and the weekly window, for both Claude Code and Codex.
//
// Here we surface the plan limits the user cares about at a glance — "how much of
// my 5-hour / weekly allowance is gone".
//
// Two very different sources, because the two agents expose this differently:
//
//   * Claude — a live endpoint. `GET https://api.anthropic.com/api/oauth/usage`
//     with the Claude Code OAuth bearer token returns `five_hour` and `seven_day`
//     objects, each `{ utilization: <percent>, resets_at: <ISO-8601 UTC> }`. The
//     token is read from the macOS keychain item Claude Code stores it in (or the
//     `~/.claude/.credentials.json` fallback on other platforms). We never print
//     the token; it is piped to curl through a `--config` file on stdin so it
//     never lands in the process argv (where `ps` could see it).
//
//   * Codex — no simple GET. Codex delivers a `RateLimitSnapshot` inside each
//     turn's stream and writes it into the session rollout JSONL under
//     `~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl` as a `token_count` event's
//     `rate_limits` field: `{ primary: {used_percent, window_minutes, resets_at},
//     secondary: {...}, plan_type }`. `primary` used to be the 5-hour window and
//     `secondary` the weekly — but Codex dropped the 5-hour limit, and now sends
//     ONLY a weekly window, in `primary` (`window_minutes: 10080`, `secondary:
//     null`). So the slots carry no fixed meaning: we classify each window by its
//     own `window_minutes`. We read the most-recently-modified rollout file and
//     take its last `rate_limits` line — the latest known state, no network call.
//
// Everything here is read-only and best-effort: any failure (no token, offline,
// no Codex session yet) yields `available: false` for that provider so the footer
// shows a dash instead of breaking.
use std::path::PathBuf;
use std::process::{Command, Stdio};
use std::time::SystemTime;

use serde::Serialize;
use serde_json::Value;

/// One limit window as the footer needs it: a percent used (0–100) and the unix
/// epoch second the window resets. `resets_at` is normalised to unix seconds for
/// BOTH providers so the frontend formats one shape (Claude's source is ISO-8601,
/// Codex's is already unix seconds).
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UsageWindow {
    /// Percent of the window's allowance used, 0–100 (rounded to one decimal).
    pub percent: f64,
    /// Unix epoch second the window resets, or `None` when not reported.
    pub resets_at: Option<i64>,
}

/// One agent's usage: the two windows the user asked for, plus an `available`
/// flag and an optional plan label / note. When `available` is false the windows
/// are `None` and the footer renders a dash.
#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderUsage {
    pub available: bool,
    /// The 5-hour rolling window.
    pub five_hour: Option<UsageWindow>,
    /// The 7-day (weekly) window.
    pub weekly: Option<UsageWindow>,
    /// Plan label when known (Codex reports e.g. "plus"); empty otherwise.
    pub plan: String,
    /// Short reason the data is missing (e.g. "not signed in"); for a tooltip.
    pub note: String,
}

impl ProviderUsage {
    fn unavailable(note: &str) -> Self {
        Self {
            available: false,
            note: note.to_string(),
            ..Default::default()
        }
    }
}

/// Both providers, the shape the `usage_summary` command returns.
#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UsageSummary {
    pub claude: ProviderUsage,
    pub codex: ProviderUsage,
}

// ===================================================================== //
// === Time parsing ==================================================== //

/// Convert an ISO-8601 UTC timestamp (e.g. `2026-06-18T16:59:59.611686+00:00`
/// or `...Z`) to a unix epoch second. Returns `None` for anything we cannot
/// parse. Only the UTC forms Anthropic emits are supported — the fractional
/// seconds and the trailing offset are ignored (the offset is always +00:00).
///
/// Uses Howard Hinnant's days-from-civil algorithm so no date crate is needed.
fn iso_utc_to_unix(s: &str) -> Option<i64> {
    // Split "<date>T<time>" — require the 'T' separator.
    let (date, rest) = s.split_once('T')?;
    let mut dparts = date.split('-');
    let year: i64 = dparts.next()?.parse().ok()?;
    let month: i64 = dparts.next()?.parse().ok()?;
    let day: i64 = dparts.next()?.parse().ok()?;

    // Time is the run of digits/colons up to the first '.', '+', '-', or 'Z'.
    let time: &str = rest.split(['.', '+', 'Z']).next()?.trim_end_matches('-');
    let mut tparts = time.split(':');
    let hour: i64 = tparts.next()?.parse().ok()?;
    let minute: i64 = tparts.next().unwrap_or("0").parse().ok()?;
    let second: i64 = tparts.next().unwrap_or("0").parse().ok()?;

    if !(1..=12).contains(&month) || !(1..=31).contains(&day) {
        return None;
    }

    // days_from_civil: days since 1970-01-01 for the given y/m/d (proleptic
    // Gregorian). Shifts the year so March is the start, making leap-day the
    // last day of the cycle.
    let y = if month <= 2 { year - 1 } else { year };
    let era = if y >= 0 { y } else { y - 399 } / 400;
    let yoe = y - era * 400; // [0, 399]
    let doy = (153 * (if month > 2 { month - 3 } else { month + 9 }) + 2) / 5 + day - 1; // [0, 365]
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy; // [0, 146096]
    let days = era * 146097 + doe - 719468;

    Some(days * 86400 + hour * 3600 + minute * 60 + second)
}

// ===================================================================== //
// === Claude ========================================================== //

/// The Claude Code OAuth access token, or `None` when we cannot find a usable one.
/// macOS first (the keychain item Claude Code writes), then the
/// `~/.claude/.credentials.json` fallback used on other platforms. An expired
/// token is treated as absent so we do not waste a request that would 401.
fn claude_access_token() -> Option<String> {
    let raw = keychain_credentials().or_else(file_credentials)?;
    let json: Value = serde_json::from_str(&raw).ok()?;
    let oauth = json.get("claudeAiOauth")?;
    // expiresAt is epoch MILLISECONDS in the credential store.
    if let Some(expires_ms) = oauth.get("expiresAt").and_then(|v| v.as_i64()) {
        let now_ms = SystemTime::now()
            .duration_since(SystemTime::UNIX_EPOCH)
            .map(|d| d.as_millis() as i64)
            .unwrap_or(0);
        if expires_ms > 0 && expires_ms <= now_ms {
            return None; // expired — Claude Code will refresh on next use
        }
    }
    oauth
        .get("accessToken")
        .and_then(|v| v.as_str())
        .map(str::to_string)
}

/// Read the `Claude Code-credentials` generic password from the macOS keychain.
/// Always `None` off macOS. The token stays inside this process — only the JSON
/// blob is captured, never logged.
fn keychain_credentials() -> Option<String> {
    if !cfg!(target_os = "macos") {
        return None;
    }
    let out = Command::new("security")
        .args([
            "find-generic-password",
            "-s",
            "Claude Code-credentials",
            "-w",
        ])
        .output()
        .ok()?;
    if !out.status.success() {
        return None;
    }
    let s = String::from_utf8_lossy(&out.stdout).trim().to_string();
    (!s.is_empty()).then_some(s)
}

/// Read `~/.claude/.credentials.json` (the non-macOS credential store, same JSON
/// shape as the keychain blob).
fn file_credentials() -> Option<String> {
    let path = crate::paths::home_dir()?
        .join(".claude")
        .join(".credentials.json");
    std::fs::read_to_string(path).ok()
}

/// Parse the `/api/oauth/usage` response body into the two windows we show.
/// `five_hour.utilization` is the 5-hour percent; `seven_day.utilization` the
/// weekly percent. Each carries an ISO `resets_at` we normalise to unix seconds.
fn parse_claude_usage(body: &str) -> Option<ProviderUsage> {
    let json: Value = serde_json::from_str(body).ok()?;
    let window = |key: &str| -> Option<UsageWindow> {
        let obj = json.get(key)?;
        if obj.is_null() {
            return None;
        }
        let percent = obj.get("utilization").and_then(|v| v.as_f64())?;
        let resets_at = obj
            .get("resets_at")
            .and_then(|v| v.as_str())
            .and_then(iso_utc_to_unix);
        Some(UsageWindow {
            percent: round1(percent),
            resets_at,
        })
    };
    let five_hour = window("five_hour");
    let weekly = window("seven_day");
    // If neither window parsed, the body was not the shape we expect.
    if five_hour.is_none() && weekly.is_none() {
        return None;
    }
    Some(ProviderUsage {
        available: true,
        five_hour,
        weekly,
        plan: String::new(),
        note: String::new(),
    })
}

/// Fetch + parse Claude usage. Shells out to `curl`, passing the bearer token via
/// a `--config` file on stdin (`-K -`) so the secret never appears in argv. Any
/// failure (no token, offline, non-2xx) becomes an `unavailable` readout.
fn fetch_claude_usage() -> ProviderUsage {
    let Some(token) = claude_access_token() else {
        return ProviderUsage::unavailable("not signed in to Claude");
    };
    let mut cmd = Command::new("curl");
    cmd.args([
        "-sS",
        "--max-time",
        "10",
        "-H",
        "anthropic-beta: oauth-2025-04-20",
        "-H",
        "anthropic-version: 2023-06-01",
        "--config",
        "-", // read the rest of the config (the auth header) from stdin
        "https://api.anthropic.com/api/oauth/usage",
    ])
    .stdin(Stdio::piped())
    .stdout(Stdio::piped())
    .stderr(Stdio::null());
    // No console window flash on Windows when polling usage.
    crate::proc::no_console(&mut cmd);
    let mut child = match cmd.spawn() {
        Ok(c) => c,
        Err(_) => return ProviderUsage::unavailable("curl not available"),
    };

    // Write the auth header to curl's stdin so the token is not a process arg.
    if let Some(mut stdin) = child.stdin.take() {
        use std::io::Write;
        let _ = writeln!(stdin, "header = \"Authorization: Bearer {token}\"");
        // stdin drops here, closing the pipe so curl proceeds.
    }

    let Ok(out) = child.wait_with_output() else {
        return ProviderUsage::unavailable("usage request failed");
    };
    if !out.status.success() {
        return ProviderUsage::unavailable("usage request failed");
    }
    let body = String::from_utf8_lossy(&out.stdout);
    parse_claude_usage(&body)
        .unwrap_or_else(|| ProviderUsage::unavailable("could not read Claude usage"))
}

// ===================================================================== //
// === Codex =========================================================== //

/// The `~/.codex/sessions` root where rollout JSONL files live.
fn codex_sessions_dir() -> Option<PathBuf> {
    crate::paths::home_dir().map(|h| h.join(".codex").join("sessions"))
}

/// Collect rollout file paths with their mtimes, newest first. Walks the
/// date-nested `sessions/YYYY/MM/DD/` tree. Bounded by what exists on disk; only
/// stats are taken here (file contents are read later, for the newest only).
fn rollout_files_newest_first(dir: &PathBuf) -> Vec<PathBuf> {
    let mut found: Vec<(SystemTime, PathBuf)> = Vec::new();
    collect_rollouts(dir, &mut found, 0);
    found.sort_by(|a, b| b.0.cmp(&a.0));
    found.into_iter().map(|(_, p)| p).collect()
}

/// Recursively gather `rollout-*.jsonl` files under `dir`. Depth-capped so a
/// surprising directory shape can never make this walk run away.
fn collect_rollouts(dir: &PathBuf, out: &mut Vec<(SystemTime, PathBuf)>, depth: usize) {
    if depth > 6 {
        return;
    }
    let Ok(entries) = std::fs::read_dir(dir) else {
        return;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        let Ok(ft) = entry.file_type() else { continue };
        if ft.is_dir() {
            collect_rollouts(&path, out, depth + 1);
        } else if is_rollout_file(&path) {
            if let Ok(mtime) = entry.metadata().and_then(|m| m.modified()) {
                out.push((mtime, path));
            }
        }
    }
}

/// True for a `rollout-*.jsonl` file.
fn is_rollout_file(path: &PathBuf) -> bool {
    let name = path.file_name().and_then(|n| n.to_str()).unwrap_or("");
    name.starts_with("rollout-") && name.ends_with(".jsonl")
}

/// Pull the LAST `rate_limits` snapshot out of a rollout file's contents and map
/// each reported window to the slot its OWN `window_minutes` says it is — the
/// `primary`/`secondary` slots no longer mean 5-hour/weekly (Codex dropped the
/// 5-hour limit and now reports the weekly window in `primary`). Anything longer
/// than a day counts as the weekly window. When `window_minutes` is missing we
/// fall back to the old positional meaning.
/// Returns `None` when the file carries no usable snapshot.
fn parse_codex_rollout(contents: &str) -> Option<ProviderUsage> {
    // Scan from the end for the most recent line that holds a rate_limits object.
    let line = contents
        .lines()
        .rev()
        .find(|l| l.contains("\"rate_limits\""))?;
    let obj: Value = serde_json::from_str(line).ok()?;
    let rate = obj.get("payload")?.get("rate_limits")?;
    if rate.is_null() {
        return None;
    }
    let mut five_hour = None;
    let mut weekly = None;
    for (slot, key) in ["primary", "secondary"].iter().enumerate() {
        let Some(w) = rate.get(key) else { continue };
        let Some(percent) = w.get("used_percent").and_then(|v| v.as_f64()) else {
            continue;
        };
        let win = UsageWindow {
            percent: round1(percent),
            resets_at: w.get("resets_at").and_then(|v| v.as_i64()),
        };
        let minutes = w
            .get("window_minutes")
            .and_then(|v| v.as_i64())
            .unwrap_or(0);
        let is_weekly = if minutes > 0 {
            minutes > 1440
        } else {
            slot == 1
        };
        if is_weekly {
            weekly = Some(win);
        } else {
            five_hour = Some(win);
        }
    }
    if five_hour.is_none() && weekly.is_none() {
        return None;
    }
    let plan = rate
        .get("plan_type")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();
    Some(ProviderUsage {
        available: true,
        five_hour,
        weekly,
        plan,
        note: String::new(),
    })
}

/// Read the most-recent Codex rate-limit snapshot from disk. Tries rollout files
/// newest-first and stops at the first that holds a snapshot (a brand-new session
/// may not have one yet). Reads only as many files as needed, capped low.
fn read_codex_usage() -> ProviderUsage {
    let Some(dir) = codex_sessions_dir() else {
        return ProviderUsage::unavailable("no Codex sessions");
    };
    if !dir.exists() {
        return ProviderUsage::unavailable("Codex not used yet");
    }
    for path in rollout_files_newest_first(&dir).into_iter().take(8) {
        let Ok(contents) = std::fs::read_to_string(&path) else {
            continue;
        };
        if let Some(usage) = parse_codex_rollout(&contents) {
            return usage;
        }
    }
    ProviderUsage::unavailable("no Codex usage yet")
}

/// Round a percent to one decimal place so the footer shows e.g. `11.0` not
/// `11.000001`.
fn round1(v: f64) -> f64 {
    (v * 10.0).round() / 10.0
}

/// Both providers' 5-hour + weekly usage for the footer. Read-only; each provider
/// fails independently (one being unavailable never blocks the other).
#[tauri::command]
pub fn usage_summary() -> UsageSummary {
    UsageSummary {
        claude: fetch_claude_usage(),
        codex: read_codex_usage(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn iso_utc_to_unix_parses_known_timestamps() {
        // 1970-01-01T00:00:00Z is epoch 0.
        assert_eq!(iso_utc_to_unix("1970-01-01T00:00:00Z"), Some(0));
        // A fixed reference: 2021-01-01T00:00:00Z = 1609459200.
        assert_eq!(iso_utc_to_unix("2021-01-01T00:00:00Z"), Some(1609459200));
        // The fractional seconds + explicit +00:00 offset are ignored.
        assert_eq!(
            iso_utc_to_unix("2026-06-18T16:59:59.611686+00:00"),
            Some(1781801999)
        );
    }

    #[test]
    fn iso_utc_to_unix_rejects_garbage() {
        assert_eq!(iso_utc_to_unix("not-a-date"), None);
        assert_eq!(iso_utc_to_unix("2026-13-01T00:00:00Z"), None); // bad month
        assert_eq!(iso_utc_to_unix(""), None);
    }

    #[test]
    fn parse_claude_usage_reads_both_windows() {
        let body = r#"{
            "five_hour": {"utilization": 4.0, "resets_at": "2026-06-18T16:59:59.611686+00:00"},
            "seven_day": {"utilization": 11.0, "resets_at": "2026-06-24T21:59:59.611711+00:00"},
            "seven_day_opus": null
        }"#;
        let u = parse_claude_usage(body).expect("should parse");
        assert!(u.available);
        assert_eq!(u.five_hour.as_ref().unwrap().percent, 4.0);
        assert_eq!(u.weekly.as_ref().unwrap().percent, 11.0);
        assert_eq!(u.five_hour.as_ref().unwrap().resets_at, Some(1781801999));
    }

    #[test]
    fn parse_claude_usage_rejects_unexpected_body() {
        // An error body (no windows) is not a usable readout.
        assert!(parse_claude_usage(r#"{"error":"unauthorized"}"#).is_none());
        assert!(parse_claude_usage("not json").is_none());
    }

    #[test]
    fn parse_codex_rollout_reads_primary_and_secondary() {
        let line = r#"{"timestamp":"2026-06-17T15:47:46.611Z","type":"event_msg","payload":{"type":"token_count","rate_limits":{"limit_id":"codex","primary":{"used_percent":6.0,"window_minutes":300,"resets_at":1781729071},"secondary":{"used_percent":27.0,"window_minutes":10080,"resets_at":1781801323},"plan_type":"plus"}}}"#;
        let u = parse_codex_rollout(line).expect("should parse");
        assert!(u.available);
        assert_eq!(u.five_hour.as_ref().unwrap().percent, 6.0);
        assert_eq!(u.five_hour.as_ref().unwrap().resets_at, Some(1781729071));
        assert_eq!(u.weekly.as_ref().unwrap().percent, 27.0);
        assert_eq!(u.plan, "plus");
    }

    #[test]
    fn parse_codex_rollout_takes_the_last_snapshot() {
        // Two snapshots; the later (last) line must win.
        let contents = concat!(
            r#"{"payload":{"type":"token_count","rate_limits":{"primary":{"used_percent":1.0,"resets_at":1},"secondary":{"used_percent":2.0,"resets_at":2}}}}"#,
            "\n",
            r#"{"payload":{"type":"other"}}"#,
            "\n",
            r#"{"payload":{"type":"token_count","rate_limits":{"primary":{"used_percent":9.0,"resets_at":3},"secondary":{"used_percent":8.0,"resets_at":4}}}}"#,
            "\n",
        );
        let u = parse_codex_rollout(contents).expect("should parse");
        assert_eq!(u.five_hour.as_ref().unwrap().percent, 9.0);
        assert_eq!(u.weekly.as_ref().unwrap().percent, 8.0);
    }

    #[test]
    fn parse_codex_rollout_maps_weekly_in_the_primary_slot() {
        // Codex dropped the 5-hour limit: the only window it sends now is the
        // weekly one, and it sends it in `primary`. window_minutes decides.
        let line = r#"{"payload":{"type":"token_count","rate_limits":{"limit_id":"codex","primary":{"used_percent":9.0,"window_minutes":10080,"resets_at":1784514218},"secondary":null,"plan_type":"plus"}}}"#;
        let u = parse_codex_rollout(line).expect("should parse");
        assert!(u.five_hour.is_none());
        assert_eq!(u.weekly.as_ref().unwrap().percent, 9.0);
        assert_eq!(u.weekly.as_ref().unwrap().resets_at, Some(1784514218));
    }

    #[test]
    fn parse_codex_rollout_handles_no_snapshot() {
        assert!(parse_codex_rollout(r#"{"payload":{"type":"other"}}"#).is_none());
        let null_limits = r#"{"payload":{"type":"token_count","rate_limits":null}}"#;
        assert!(parse_codex_rollout(null_limits).is_none());
    }

    #[test]
    fn round1_rounds_to_one_decimal() {
        assert_eq!(round1(11.04), 11.0);
        assert_eq!(round1(11.06), 11.1);
    }
}
