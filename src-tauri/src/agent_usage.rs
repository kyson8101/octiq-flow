// Per-session token + cost readout for agent tabs. Claude Code writes one JSONL
// transcript per session; each assistant line carries `message.usage` (exact
// token counts) and `message.model`. We already capture each tab's session in
// agent_resume's store, so this module locates the same transcript, sums the
// token buckets per model, and prices them.
//
// Tokens are EXACT (read straight from the transcript). Cost is an ESTIMATE from
// a small embedded price table; for any model we do not have an authoritative
// price for, the tokens still show but the cost is left out (the UI renders a
// dash) rather than guessing. Prices are USD per million tokens, sourced from
// the Anthropic pricing reference (claude-api skill, cached 2026-06-04). Cache
// write (5-minute TTL) is 1.25x the input price and cache read is 0.1x — the
// universal prompt-cache multipliers — so only the base input/output rate is
// stored per model and the cache rates are derived.
use std::collections::HashMap;
use std::fs;
use std::path::PathBuf;
use std::sync::{Mutex, OnceLock};
use std::time::SystemTime;

use serde::Serialize;
use serde_json::Value;

use crate::agent_resume::{load_store, transcript_path_for};

const MILLION: f64 = 1_000_000.0;
/// Cache-write (5-minute TTL) costs this multiple of the input price.
const CACHE_WRITE_5M_MULT: f64 = 1.25;
/// Cache-write (1-hour TTL) costs this multiple of the input price.
const CACHE_WRITE_1H_MULT: f64 = 2.0;
/// Cache-read costs this multiple of the input price.
const CACHE_READ_MULT: f64 = 0.1;

/// Authoritative input/output price (USD per million tokens) for a model, or
/// `None` when we have no published price for it (then cost is omitted, not
/// guessed). Matched on the exact model id Claude Code records in the transcript.
fn price_for(model: &str) -> Option<(f64, f64)> {
    match model {
        "claude-fable-5" | "claude-mythos-5" => Some((10.0, 50.0)),
        "claude-opus-4-8" | "claude-opus-4-7" | "claude-opus-4-6" => Some((5.0, 25.0)),
        "claude-sonnet-4-6" => Some((3.0, 15.0)),
        "claude-haiku-4-5" => Some((1.0, 5.0)),
        _ => None,
    }
}

/// Token totals for one model within a session. The four buckets are billed at
/// different rates, so they are kept apart (they match the transcript's own
/// fields and the four price tiers).
#[derive(Debug, Default, Clone, PartialEq)]
struct ModelTokens {
    input: u64,
    output: u64,
    cache_read: u64,
    cache_write_5m: u64,
    cache_write_1h: u64,
}

impl ModelTokens {
    fn total(&self) -> u64 {
        self.input + self.output + self.cache_read + self.cache_write_5m + self.cache_write_1h
    }
}

/// One tab's usage readout. Tokens are exact; `cost_usd` is `None` when the
/// session used a model we cannot price, and `cost_complete` is false when SOME
/// (but not all) of the tokens came from priced models — so the UI can show the
/// partial cost with a "+" marker instead of presenting it as the full total.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionUsage {
    /// The tab's stable persist key (the store key), so the frontend can match
    /// this readout to a tab if it wants to.
    pub key: String,
    pub agent: String,
    pub cwd: String,
    /// Distinct model ids seen in the transcript, in first-seen order.
    pub models: Vec<String>,
    pub input_tokens: u64,
    pub output_tokens: u64,
    pub cache_read_tokens: u64,
    pub cache_write_tokens: u64,
    pub total_tokens: u64,
    /// Estimated cost in USD over the priced models, or `None` when no model in
    /// the session is priced.
    pub cost_usd: Option<f64>,
    /// True when every model in the session had a known price (so `cost_usd` is
    /// the full cost, not a lower bound).
    pub cost_complete: bool,
}

/// Sum the per-model token buckets in a transcript. One JSON object per line; we
/// pre-filter on the `usage` substring so only assistant lines that carry usage
/// are parsed. Top-level `usage` fields are used (not `usage.iterations`, which
/// would double-count a multi-iteration turn). Returns an ordered list so the
/// first-seen model order is stable for display.
fn aggregate(contents: &str) -> Vec<(String, ModelTokens)> {
    let mut order: Vec<String> = Vec::new();
    let mut by_model: HashMap<String, ModelTokens> = HashMap::new();

    for line in contents.lines() {
        if !line.contains("usage") {
            continue;
        }
        let Ok(obj) = serde_json::from_str::<Value>(line) else {
            continue;
        };
        let Some(message) = obj.get("message") else {
            continue;
        };
        let Some(usage) = message.get("usage").filter(|u| u.is_object()) else {
            continue;
        };
        let model = message
            .get("model")
            .and_then(|m| m.as_str())
            .unwrap_or("unknown")
            .to_string();

        let entry = by_model.entry(model.clone()).or_insert_with(|| {
            order.push(model.clone());
            ModelTokens::default()
        });

        entry.input += u64_at(usage, "input_tokens");
        entry.output += u64_at(usage, "output_tokens");
        entry.cache_read += u64_at(usage, "cache_read_input_tokens");

        // Prefer the 5m/1h split when present (priced differently); fall back to
        // the flat cache_creation_input_tokens at the 5m rate otherwise.
        let split = usage.get("cache_creation");
        let c5 = split.map(|s| u64_at(s, "ephemeral_5m_input_tokens"));
        let c1 = split.map(|s| u64_at(s, "ephemeral_1h_input_tokens"));
        match (c5, c1) {
            (Some(c5), Some(c1)) if c5 + c1 > 0 => {
                entry.cache_write_5m += c5;
                entry.cache_write_1h += c1;
            }
            _ => entry.cache_write_5m += u64_at(usage, "cache_creation_input_tokens"),
        }
    }

    order
        .into_iter()
        .map(|m| {
            let toks = by_model.remove(&m).unwrap_or_default();
            (m, toks)
        })
        .collect()
}

/// Read a non-negative integer field from a JSON object, defaulting to 0.
fn u64_at(obj: &Value, key: &str) -> u64 {
    obj.get(key).and_then(|v| v.as_u64()).unwrap_or(0)
}

/// Cost in USD for one model's tokens, or `None` when the model has no known
/// price. Cache write/read rates derive from the input price.
fn cost_of(model: &str, t: &ModelTokens) -> Option<f64> {
    let (in_rate, out_rate) = price_for(model)?;
    let cost = (t.input as f64) * in_rate
        + (t.output as f64) * out_rate
        + (t.cache_read as f64) * in_rate * CACHE_READ_MULT
        + (t.cache_write_5m as f64) * in_rate * CACHE_WRITE_5M_MULT
        + (t.cache_write_1h as f64) * in_rate * CACHE_WRITE_1H_MULT;
    Some(cost / MILLION)
}

/// Roll an aggregated transcript up into a SessionUsage for `key` (agent/cwd
/// come from the store entry). Cost sums only priced models; `cost_complete` is
/// false if any unpriced model contributed tokens.
fn summarize(
    key: String,
    agent: String,
    cwd: String,
    per_model: Vec<(String, ModelTokens)>,
) -> SessionUsage {
    let mut models = Vec::new();
    let mut input = 0u64;
    let mut output = 0u64;
    let mut cache_read = 0u64;
    let mut cache_write = 0u64;
    let mut cost = 0.0f64;
    let mut any_priced = false;
    let mut all_priced = true;

    for (model, toks) in &per_model {
        models.push(model.clone());
        input += toks.input;
        output += toks.output;
        cache_read += toks.cache_read;
        cache_write += toks.cache_write_5m + toks.cache_write_1h;
        match cost_of(model, toks) {
            Some(c) => {
                any_priced = true;
                cost += c;
            }
            // An unpriced model that actually used tokens makes the cost partial.
            None if toks.total() > 0 => all_priced = false,
            None => {}
        }
    }

    SessionUsage {
        key,
        agent,
        cwd,
        models,
        input_tokens: input,
        output_tokens: output,
        cache_read_tokens: cache_read,
        cache_write_tokens: cache_write,
        total_tokens: input + output + cache_read + cache_write,
        cost_usd: any_priced.then_some(cost),
        cost_complete: any_priced && all_priced,
    }
}

/// Cache of `path -> (mtime, aggregated)` so an unchanged transcript is parsed
/// once. A finished agent's transcript never changes, and the dashboard re-reads
/// on every refresh, so this turns repeat reads into a cheap stat. Mirrors the
/// title cache in agent_resume.
fn usage_cache() -> &'static Mutex<HashMap<PathBuf, (SystemTime, Vec<(String, ModelTokens)>)>> {
    static CACHE: OnceLock<Mutex<HashMap<PathBuf, (SystemTime, Vec<(String, ModelTokens)>)>>> =
        OnceLock::new();
    CACHE.get_or_init(|| Mutex::new(HashMap::new()))
}

/// Aggregate a transcript, reading it only when its mtime changed since the last
/// read. Any IO error yields an empty aggregate (the session shows zero usage
/// rather than failing the whole readout).
fn aggregate_cached(path: &PathBuf) -> Vec<(String, ModelTokens)> {
    let Ok(mtime) = fs::metadata(path).and_then(|m| m.modified()) else {
        return Vec::new();
    };
    let mut cache = usage_cache()
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    if let Some((cached_mtime, cached)) = cache.get(path) {
        if *cached_mtime == mtime {
            return cached.clone();
        }
    }
    let agg = fs::read_to_string(path)
        .map(|raw| aggregate(&raw))
        .unwrap_or_default();
    cache.insert(path.clone(), (mtime, agg.clone()));
    agg
}

/// Token + cost readout for every captured agent session, one per tab. The store
/// is pruned to live tabs elsewhere, so this reflects the agent tabs that exist
/// now. Sessions with no readable transcript are skipped. Read-only.
#[tauri::command]
pub fn agent_usage_all() -> Vec<SessionUsage> {
    let mut out = Vec::new();
    for (key, entry) in load_store() {
        let Some(path) = transcript_path_for(&entry) else {
            continue;
        };
        let per_model = aggregate_cached(&path);
        if per_model.is_empty() {
            continue; // no transcript yet / unreadable — nothing to show
        }
        out.push(summarize(
            key,
            entry.agent.clone(),
            entry.cwd.clone(),
            per_model,
        ));
    }
    // Most expensive session first, so the dashboard leads with what matters.
    out.sort_by(|a, b| b.total_tokens.cmp(&a.total_tokens));
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn priced_models_have_expected_rates() {
        assert_eq!(price_for("claude-fable-5"), Some((10.0, 50.0)));
        assert_eq!(price_for("claude-opus-4-8"), Some((5.0, 25.0)));
        assert_eq!(price_for("claude-sonnet-4-6"), Some((3.0, 15.0)));
        assert_eq!(price_for("claude-haiku-4-5"), Some((1.0, 5.0)));
        // An unknown / future model has no price (cost is omitted, not guessed).
        assert_eq!(price_for("claude-something-9"), None);
    }

    #[test]
    fn cost_uses_input_output_and_derived_cache_rates() {
        // 1M input + 1M output on Fable 5 = $10 + $50 = $60.
        let t = ModelTokens {
            input: 1_000_000,
            output: 1_000_000,
            ..Default::default()
        };
        assert_eq!(cost_of("claude-fable-5", &t), Some(60.0));

        // Cache read is 0.1x input; cache write 5m is 1.25x input. On Fable 5
        // ($10 input): 1M cache read = $1, 1M cache write 5m = $12.50.
        let cache = ModelTokens {
            cache_read: 1_000_000,
            cache_write_5m: 1_000_000,
            ..Default::default()
        };
        assert_eq!(cost_of("claude-fable-5", &cache), Some(13.5));

        // Unpriced model -> no cost.
        assert_eq!(cost_of("claude-something-9", &t), None);
    }

    #[test]
    fn aggregate_sums_buckets_per_model_from_top_level_usage() {
        let jsonl = concat!(
            r#"{"type":"user","message":{"content":"hi"}}"#,
            "\n",
            r#"{"type":"assistant","message":{"model":"claude-fable-5","usage":{"input_tokens":100,"output_tokens":20,"cache_read_input_tokens":50,"cache_creation_input_tokens":10}}}"#,
            "\n",
            r#"{"type":"assistant","message":{"model":"claude-fable-5","usage":{"input_tokens":5,"output_tokens":3,"cache_read_input_tokens":0,"cache_creation":{"ephemeral_5m_input_tokens":4,"ephemeral_1h_input_tokens":2}}}}"#,
            "\n",
        );
        let agg = aggregate(jsonl);
        assert_eq!(agg.len(), 1);
        let (model, t) = &agg[0];
        assert_eq!(model, "claude-fable-5");
        assert_eq!(t.input, 105);
        assert_eq!(t.output, 23);
        assert_eq!(t.cache_read, 50);
        // 10 (flat, first line) + 4 (5m split, second line).
        assert_eq!(t.cache_write_5m, 14);
        assert_eq!(t.cache_write_1h, 2);
    }

    #[test]
    fn aggregate_keeps_models_separate_and_in_first_seen_order() {
        let jsonl = concat!(
            r#"{"message":{"model":"claude-haiku-4-5","usage":{"input_tokens":10,"output_tokens":1}}}"#,
            "\n",
            r#"{"message":{"model":"claude-fable-5","usage":{"input_tokens":20,"output_tokens":2}}}"#,
            "\n",
            r#"{"message":{"model":"claude-haiku-4-5","usage":{"input_tokens":5,"output_tokens":1}}}"#,
            "\n",
        );
        let agg = aggregate(jsonl);
        assert_eq!(agg.len(), 2);
        assert_eq!(agg[0].0, "claude-haiku-4-5"); // first seen
        assert_eq!(agg[0].1.input, 15);
        assert_eq!(agg[1].0, "claude-fable-5");
        assert_eq!(agg[1].1.input, 20);
    }

    #[test]
    fn summarize_marks_partial_cost_when_a_model_is_unpriced() {
        let per_model = vec![
            (
                "claude-fable-5".to_string(),
                ModelTokens {
                    input: 1_000_000,
                    ..Default::default()
                },
            ),
            (
                "claude-future-9".to_string(),
                ModelTokens {
                    input: 500_000,
                    ..Default::default()
                },
            ),
        ];
        let s = summarize("k".into(), "claude".into(), "/w".into(), per_model);
        assert_eq!(s.input_tokens, 1_500_000);
        assert_eq!(s.cost_usd, Some(10.0)); // only the Fable tokens are priced
        assert!(!s.cost_complete); // the unpriced model makes it partial
        assert_eq!(s.models, vec!["claude-fable-5", "claude-future-9"]);
    }

    #[test]
    fn summarize_is_complete_when_all_models_priced() {
        let per_model = vec![(
            "claude-opus-4-8".to_string(),
            ModelTokens {
                input: 1_000_000,
                output: 1_000_000,
                ..Default::default()
            },
        )];
        let s = summarize("k".into(), "claude".into(), "/w".into(), per_model);
        // 1M input @ $5 + 1M output @ $25 = $30.
        assert_eq!(s.cost_usd, Some(30.0));
        assert!(s.cost_complete);
    }
}
