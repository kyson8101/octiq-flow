//! Tokens each registered agent has used, as the providers report them.
//!
//! Informational only: nothing here pays XP or ranks anyone.
//!
//! ## One normalized shape, subsets never added
//!
//! `input` is every token the model read, `output` every token it wrote. The
//! providers break those down differently, and the breakdowns OVERLAP the
//! totals rather than adding to them:
//!
//! - Claude reports fresh input, cache reads and cache writes as three
//!   disjoint numbers. Their sum is `input`; `cached_input` is the cache
//!   reads and `cache_write` the cache writes, both already inside `input`.
//! - Codex reports `input_tokens` with `cached_input_tokens` inside it, and
//!   `output_tokens` with `reasoning_output_tokens` inside it. Those are
//!   `input`/`cached_input` and `output`/`reasoning` as they stand.
//!
//! So `input + output` is the total, and the subsets are shown beside it.
//!
//! ## Counting each token once
//!
//! - Claude's `result.modelUsage` is CUMULATIVE for the process: every turn
//!   repeats the ones before it, and it includes Task subagents, which the
//!   per-turn `usage` block leaves out. A new process starts again from zero
//!   (checked against recorded chats: resuming never restores it). So the
//!   reader thread keeps one [`Meter`] per process and records each turn's
//!   difference. A turn that failed or was interrupted still ends in a
//!   `result`, so it is counted, once. Those subagents are the agent's own
//!   helpers inside its own chat; the provider does not report them apart,
//!   and the profile says they are included. A registered report always runs
//!   in a chat of its own, so it is never inside another agent's figures.
//! - Usage the provider never reported (a process killed mid-turn, before
//!   its `result`) is not counted and not guessed: every total is a floor.
//! - Codex app-server reports each model response as `last`, and repeats the
//!   notification without a new response (a rate-limit update, a resume). The
//!   thread total only moves with a real response, so a notification whose
//!   thread total equals the last one recorded for the chat is a repeat.
//!
//! ## Attribution is fixed when first seen
//!
//! A chat's usage belongs to the agent that chat was running as when its first
//! usage arrived: the assignee of a worker chat's task, or the lead a chat was
//! handed to. It is stored with the record and never recomputed, so a rename,
//! a model change or a later handoff moves nothing. That is sound because the
//! host never lets a chat change agent: every worker attempt gets a fresh chat
//! key, and `team::record_lead` refuses to hand a chat to a second lead. Every worker attempt has
//! its own chat, so a manager's total never includes its reports' work, and a
//! chat that is neither (an ordinary chat) is not recorded at all.
//!
//! Counting starts when this build first runs (`since`). Earlier chats are not
//! read back: their Claude totals cannot be told apart from a new process
//! reliably, and older Codex records carry no breakdown. The profile says so.
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::BTreeMap;
use std::fs;
use std::path::PathBuf;
use std::sync::Mutex;

use crate::agent_chat::ChatAgent;

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TokenUsage {
    /// Every input token, cached ones included.
    pub input: u64,
    /// Of `input`, served from cache.
    pub cached_input: u64,
    /// Of `input`, written to cache (Claude).
    pub cache_write: u64,
    /// Every output token, reasoning included.
    pub output: u64,
    /// Of `output`, reasoning (Codex; Claude does not report it apart).
    pub reasoning: u64,
}

impl TokenUsage {
    pub fn total(&self) -> u64 {
        self.input + self.output
    }

    fn is_zero(&self) -> bool {
        self.input == 0 && self.output == 0
    }

    fn add(&mut self, other: &TokenUsage) {
        self.input += other.input;
        self.cached_input += other.cached_input;
        self.cache_write += other.cache_write;
        self.output += other.output;
        self.reasoning += other.reasoning;
    }
}

/// One turn's (or one response's) usage, as read off the stream.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Reading {
    pub usage: TokenUsage,
    /// Codex app-server: the thread's running total after this response,
    /// which is how a repeated notification is recognised.
    pub thread_total: Option<u64>,
}

fn n(value: Option<&Value>) -> u64 {
    value.and_then(Value::as_u64).unwrap_or(0)
}

/// Claude's four counters for one model, in the order they are subtracted.
#[derive(Clone, Copy, Default, PartialEq, Eq, Debug)]
struct ClaudeCounters {
    input: u64,
    output: u64,
    cache_read: u64,
    cache_write: u64,
}

impl ClaudeCounters {
    fn usage(self) -> TokenUsage {
        TokenUsage {
            input: self.input + self.cache_read + self.cache_write,
            cached_input: self.cache_read,
            cache_write: self.cache_write,
            output: self.output,
            reasoning: 0,
        }
    }
}

/// Usage for ONE provider process. The reader thread owns one and drops it
/// with the process, which is exactly where Claude's running totals restart.
#[derive(Default)]
pub struct Meter {
    claude: BTreeMap<String, ClaudeCounters>,
}

impl Meter {
    /// The usage this event reports that was not reported before, if any.
    pub fn observe(&mut self, agent: ChatAgent, event: &Value) -> Option<Reading> {
        let kind = event.get("type").and_then(Value::as_str)?;
        let reading = match (agent, kind) {
            (ChatAgent::Claude, "result") => self.claude_result(event),
            (ChatAgent::Codex, "token_count") => codex_response(event),
            (ChatAgent::Codex, "turn.completed") => codex_exec_turn(event),
            _ => None,
        }?;
        (!reading.usage.is_zero()).then_some(reading)
    }

    fn claude_result(&mut self, event: &Value) -> Option<Reading> {
        let models = event.get("modelUsage").and_then(Value::as_object);
        let Some(models) = models.filter(|models| !models.is_empty()) else {
            // No per-model totals: the turn's own block is the best there is.
            // It is per turn already, so it needs no difference taken.
            let usage = event.get("usage")?;
            let counters = ClaudeCounters {
                input: n(usage.get("input_tokens")),
                output: n(usage.get("output_tokens")),
                cache_read: n(usage.get("cache_read_input_tokens")),
                cache_write: n(usage.get("cache_creation_input_tokens")),
            };
            return Some(Reading {
                usage: counters.usage(),
                thread_total: None,
            });
        };
        let mut usage = TokenUsage::default();
        for (model, totals) in models {
            let now = ClaudeCounters {
                input: n(totals.get("inputTokens")),
                output: n(totals.get("outputTokens")),
                cache_read: n(totals.get("cacheReadInputTokens")),
                cache_write: n(totals.get("cacheCreationInputTokens")),
            };
            let before = self.claude.insert(model.clone(), now).unwrap_or_default();
            // Totals only grow within a process. If one ever shrank, the
            // process was replaced under the same reader: count from zero.
            let restarted = now.input < before.input
                || now.output < before.output
                || now.cache_read < before.cache_read
                || now.cache_write < before.cache_write;
            let base = if restarted {
                ClaudeCounters::default()
            } else {
                before
            };
            usage.add(
                &ClaudeCounters {
                    input: now.input - base.input,
                    output: now.output - base.output,
                    cache_read: now.cache_read - base.cache_read,
                    cache_write: now.cache_write - base.cache_write,
                }
                .usage(),
            );
        }
        Some(Reading {
            usage,
            thread_total: None,
        })
    }
}

/// A Codex app-server response, as `codex_app_server` normalizes it. Older
/// records carry only a context figure (`total_token_usage`), which is not
/// usage and is ignored.
fn codex_response(event: &Value) -> Option<Reading> {
    let info = event.get("info")?;
    let last = info.get("last_token_usage")?;
    Some(Reading {
        usage: codex_usage(last),
        thread_total: info.get("thread_total_tokens").and_then(Value::as_u64),
    })
}

/// `codex exec` (the fallback transport): one process, one turn, and the
/// turn's usage on its full stop.
fn codex_exec_turn(event: &Value) -> Option<Reading> {
    Some(Reading {
        usage: codex_usage(event.get("usage")?),
        thread_total: None,
    })
}

fn codex_usage(usage: &Value) -> TokenUsage {
    let input = n(usage.get("input_tokens"));
    let output = n(usage.get("output_tokens"));
    TokenUsage {
        input,
        cached_input: n(usage.get("cached_input_tokens")).min(input),
        cache_write: 0,
        output,
        reasoning: n(usage.get("reasoning_output_tokens")).min(output),
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ChatRole {
    /// A chat a task was handed to (`team.json` leads).
    Lead,
    /// A worker attempt's chat.
    Worker,
}

/// Who a chat's usage belongs to, decided once.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Attribution {
    pub agent_id: String,
    pub agent_name: String,
    pub role: ChatRole,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub task_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub run_id: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChatUsage {
    #[serde(flatten)]
    pub attribution: Attribution,
    pub provider: ChatAgent,
    pub usage: TokenUsage,
    /// How many readings were counted.
    pub readings: u64,
    pub first_at: i64,
    pub last_at: i64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub thread_total: Option<u64>,
}

pub fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or_default()
}

/// Who `chat_key` runs as, from the host's own records: the assignee of the
/// task its latest worker attempt runs, or the lead it was handed to. Never
/// from anything the agent said.
pub(crate) fn attribute(
    orchestrations: &crate::orchestration::OrchestrationStore,
    chat_key: &str,
) -> Option<Attribution> {
    if let Ok(Some((assignee, task_id, run_id))) = orchestrations.worker_assignment(chat_key) {
        return Some(Attribution {
            agent_id: assignee.id,
            agent_name: assignee.name,
            role: ChatRole::Worker,
            task_id: Some(task_id),
            run_id: Some(run_id),
        });
    }
    let lead = crate::team::lead_for_chat(&crate::team::default_path(), chat_key).ok()??;
    Some(Attribution {
        agent_id: lead.lead_id,
        agent_name: lead.lead_name,
        role: ChatRole::Lead,
        task_id: None,
        run_id: None,
    })
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Stored {
    #[serde(default)]
    since: i64,
    #[serde(default)]
    chats: BTreeMap<String, ChatUsage>,
}

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentUsage {
    pub agent_id: String,
    pub usage: TokenUsage,
    pub total: u64,
    /// Chats counted: its own, never its reports'.
    pub chats: u64,
    pub lead_chats: u64,
    pub worker_chats: u64,
    /// When counting began; nothing before it is included.
    pub since: i64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub last_at: Option<i64>,
    /// Any of it came from Codex, which reports reasoning apart; Claude does
    /// not, so `reasoning` covers the Codex part only.
    pub reasoning_reported: bool,
}

#[derive(Default)]
pub struct Store {
    path: Option<PathBuf>,
    data: Mutex<Stored>,
    load_error: Option<String>,
}

impl Store {
    pub fn load(path: PathBuf) -> Self {
        let mut store = Self {
            path: Some(path.clone()),
            ..Self::default()
        };
        match fs::read(&path) {
            Ok(bytes) => match serde_json::from_slice::<Stored>(&bytes) {
                Ok(data) => store.data = Mutex::new(data),
                // Never write over a file that could not be read: its totals
                // would be lost. Counting pauses and the profile says why.
                Err(error) => {
                    store.load_error = Some(format!("Token usage could not be read: {error}"))
                }
            },
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => {
                store.load_error = Some(format!("Token usage could not be read: {error}"))
            }
        }
        store
    }

    fn persist(&self, data: &Stored) -> Result<(), String> {
        let Some(path) = &self.path else {
            return Ok(());
        };
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent).map_err(|e| e.to_string())?;
        }
        let bytes = serde_json::to_vec_pretty(data).map_err(|e| e.to_string())?;
        let temp = path.with_extension(format!("json.{}.tmp", std::process::id()));
        fs::write(&temp, bytes).map_err(|e| e.to_string())?;
        fs::rename(&temp, path).map_err(|e| e.to_string())
    }

    /// Add one reading to a chat. `attribute` is asked only for a chat seen
    /// for the first time; a chat it cannot attribute is not recorded. True
    /// when the reading was counted.
    pub fn record(
        &self,
        chat_key: &str,
        provider: ChatAgent,
        reading: &Reading,
        now: i64,
        attribute: impl FnOnce() -> Option<Attribution>,
    ) -> Result<bool, String> {
        if let Some(error) = &self.load_error {
            return Err(error.clone());
        }
        let mut data = self.data.lock().map_err(|e| e.to_string())?;
        let mut next = data.clone();
        if next.since == 0 {
            next.since = now;
        }
        match next.chats.get_mut(chat_key) {
            Some(chat) => {
                if reading.thread_total.is_some() && reading.thread_total == chat.thread_total {
                    return Ok(false);
                }
                chat.usage.add(&reading.usage);
                chat.readings += 1;
                chat.last_at = now;
                if reading.thread_total.is_some() {
                    chat.thread_total = reading.thread_total;
                }
            }
            None => {
                let Some(attribution) = attribute() else {
                    return Ok(false);
                };
                next.chats.insert(
                    chat_key.to_owned(),
                    ChatUsage {
                        attribution,
                        provider,
                        usage: reading.usage,
                        readings: 1,
                        first_at: now,
                        last_at: now,
                        thread_total: reading.thread_total,
                    },
                );
            }
        }
        self.persist(&next)?;
        *data = next;
        Ok(true)
    }

    /// Everything counted for one agent, across its own chats only.
    pub fn for_agent(&self, agent_id: &str) -> Result<AgentUsage, String> {
        if let Some(error) = &self.load_error {
            return Err(error.clone());
        }
        let data = self.data.lock().map_err(|e| e.to_string())?;
        let mut out = AgentUsage {
            agent_id: agent_id.to_owned(),
            since: data.since,
            ..AgentUsage::default()
        };
        for chat in data
            .chats
            .values()
            .filter(|chat| chat.attribution.agent_id == agent_id)
        {
            out.usage.add(&chat.usage);
            out.chats += 1;
            match chat.attribution.role {
                ChatRole::Lead => out.lead_chats += 1,
                ChatRole::Worker => out.worker_chats += 1,
            }
            out.last_at = Some(out.last_at.map_or(chat.last_at, |at| at.max(chat.last_at)));
            out.reasoning_reported |= chat.provider == ChatAgent::Codex;
        }
        out.total = out.usage.total();
        Ok(out)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use std::sync::Arc;

    fn claude_result(models: Value) -> Value {
        json!({ "type": "result", "subtype": "success", "usage": { "input_tokens": 1, "output_tokens": 1 }, "modelUsage": models })
    }

    fn model(input: u64, output: u64, read: u64, write: u64) -> Value {
        json!({ "inputTokens": input, "outputTokens": output, "cacheReadInputTokens": read, "cacheCreationInputTokens": write })
    }

    fn who(id: &str) -> Attribution {
        Attribution {
            agent_id: id.into(),
            agent_name: id.to_uppercase(),
            role: ChatRole::Worker,
            task_id: Some("task_1".into()),
            run_id: Some("run_1".into()),
        }
    }

    #[test]
    fn claude_counts_each_turn_once_from_its_running_totals() {
        let mut meter = Meter::default();
        // Turn one: 38 fresh + 74049 read + 34883 written, 892 out.
        let one = meter
            .observe(
                ChatAgent::Claude,
                &claude_result(json!({ "haiku": model(38, 892, 74049, 34883) })),
            )
            .unwrap();
        assert_eq!(
            one.usage,
            TokenUsage {
                input: 38 + 74049 + 34883,
                cached_input: 74049,
                cache_write: 34883,
                output: 892,
                reasoning: 0
            }
        );
        // Turn two repeats turn one inside its totals (the recorded
        // workflow.jsonl fixture): only the difference is new.
        let two = meter
            .observe(
                ChatAgent::Claude,
                &claude_result(json!({ "haiku": model(48, 972, 114205, 35855) })),
            )
            .unwrap();
        assert_eq!(two.usage.output, 80);
        assert_eq!(two.usage.cached_input, 114205 - 74049);
        assert_eq!(two.usage.input, 10 + (114205 - 74049) + (35855 - 34883));
        // The sum of the turns is the process's final total, never more.
        assert_eq!(one.usage.output + two.usage.output, 972);
        // A slash command that used nothing is not a reading.
        assert!(meter
            .observe(
                ChatAgent::Claude,
                &claude_result(json!({ "haiku": model(48, 972, 114205, 35855) }))
            )
            .is_none());
    }

    #[test]
    fn claude_counts_a_second_model_and_a_new_process_from_zero() {
        let mut meter = Meter::default();
        meter.observe(
            ChatAgent::Claude,
            &claude_result(json!({ "opus": model(10, 100, 0, 0) })),
        );
        // A Task subagent on another model appears in the totals.
        let with_sub = meter
            .observe(
                ChatAgent::Claude,
                &claude_result(
                    json!({ "opus": model(15, 150, 0, 0), "haiku": model(5, 20, 0, 0) }),
                ),
            )
            .unwrap();
        assert_eq!(with_sub.usage.output, 50 + 20);
        // A fresh process gets a fresh meter, so its first totals count whole.
        let mut fresh = Meter::default();
        let first = fresh
            .observe(
                ChatAgent::Claude,
                &claude_result(json!({ "opus": model(3, 30, 0, 0) })),
            )
            .unwrap();
        assert_eq!(first.usage.output, 30);
        // Totals that shrink under the same meter restarted: count from zero.
        let shrunk = meter
            .observe(
                ChatAgent::Claude,
                &claude_result(json!({ "opus": model(1, 7, 0, 0) })),
            )
            .unwrap();
        assert_eq!(shrunk.usage.output, 7);
    }

    #[test]
    fn an_interrupted_claude_turn_is_counted_and_a_missing_breakdown_falls_back() {
        let mut meter = Meter::default();
        let cut = json!({ "type": "result", "subtype": "error_during_execution",
            "modelUsage": { "opus": model(4, 40, 100, 0) } });
        assert_eq!(
            meter.observe(ChatAgent::Claude, &cut).unwrap().usage.output,
            40
        );
        let bare = json!({ "type": "result", "usage": {
            "input_tokens": 2, "output_tokens": 9, "cache_read_input_tokens": 50, "cache_creation_input_tokens": 5 } });
        let reading = Meter::default().observe(ChatAgent::Claude, &bare).unwrap();
        assert_eq!(reading.usage.input, 57);
        assert_eq!(reading.usage.cached_input, 50);
        // Claude's events never read as Codex's, nor the other way round.
        assert!(Meter::default().observe(ChatAgent::Codex, &cut).is_none());
    }

    #[test]
    fn codex_subsets_stay_inside_their_totals() {
        let exec = json!({ "type": "turn.completed", "usage": {
            "cached_input_tokens": 80896, "input_tokens": 103863, "output_tokens": 448, "reasoning_output_tokens": 157 } });
        let reading = Meter::default().observe(ChatAgent::Codex, &exec).unwrap();
        assert_eq!(reading.usage.total(), 103863 + 448);
        assert_eq!(reading.usage.cached_input, 80896);
        assert_eq!(reading.usage.reasoning, 157);
        // App-server's own turn.completed has no usage; old token_count
        // records carry only a context figure. Neither is a reading.
        assert!(Meter::default()
            .observe(
                ChatAgent::Codex,
                &json!({ "type": "turn.completed", "status": "completed" })
            )
            .is_none());
        let old = json!({ "type": "token_count", "info": { "total_token_usage": { "input_tokens": 12, "output_tokens": 3 } } });
        assert!(Meter::default().observe(ChatAgent::Codex, &old).is_none());
    }

    #[test]
    fn a_repeated_codex_notification_is_counted_once_even_across_restarts() {
        let root = std::env::temp_dir().join(format!("octiq-usage-{}", uuid::Uuid::new_v4()));
        let path = root.join("agent-usage.json");
        let response = |last_in: u64, total: u64| {
            json!({ "type": "token_count", "info": {
                "total_token_usage": { "input_tokens": last_in, "output_tokens": 1 },
                "last_token_usage": { "input_tokens": last_in, "cached_input_tokens": 1, "output_tokens": 1, "reasoning_output_tokens": 0 },
                "thread_total_tokens": total } })
        };
        let store = Store::load(path.clone());
        let mut meter = Meter::default();
        let first = meter
            .observe(ChatAgent::Codex, &response(100, 101))
            .unwrap();
        assert!(store
            .record("chat:w", ChatAgent::Codex, &first, 1, || Some(who("a")))
            .unwrap());
        let repeat = meter
            .observe(ChatAgent::Codex, &response(100, 101))
            .unwrap();
        assert!(!store
            .record("chat:w", ChatAgent::Codex, &repeat, 2, || None)
            .unwrap());
        // After a restart the thread's total is repeated on resume: still one.
        let reloaded = Store::load(path);
        assert!(!reloaded
            .record("chat:w", ChatAgent::Codex, &repeat, 3, || None)
            .unwrap());
        let next = Meter::default()
            .observe(ChatAgent::Codex, &response(50, 152))
            .unwrap();
        assert!(reloaded
            .record("chat:w", ChatAgent::Codex, &next, 4, || None)
            .unwrap());
        let usage = reloaded.for_agent("a").unwrap();
        assert_eq!(usage.usage.input, 150);
        assert_eq!(usage.total, 152);
        assert!(usage.reasoning_reported);
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn attribution_is_fixed_on_first_sight_and_children_stay_their_own() {
        let store = Store::default();
        let reading = Reading {
            usage: TokenUsage {
                input: 10,
                output: 5,
                ..TokenUsage::default()
            },
            thread_total: None,
        };
        // An ordinary chat nobody was handed is not recorded at all.
        assert!(!store
            .record("chat:plain", ChatAgent::Claude, &reading, 1, || None)
            .unwrap());
        store
            .record("chat:lead", ChatAgent::Claude, &reading, 1, || {
                Some(Attribution {
                    role: ChatRole::Lead,
                    task_id: None,
                    run_id: None,
                    ..who("lead")
                })
            })
            .unwrap();
        store
            .record("chat:child", ChatAgent::Claude, &reading, 1, || {
                Some(who("report"))
            })
            .unwrap();
        // A later reading never asks again: a handoff or rename cannot move it.
        store
            .record("chat:child", ChatAgent::Claude, &reading, 2, || {
                Some(who("lead"))
            })
            .unwrap();
        let lead = store.for_agent("lead").unwrap();
        assert_eq!((lead.total, lead.chats, lead.lead_chats), (15, 1, 1));
        let report = store.for_agent("report").unwrap();
        assert_eq!((report.total, report.worker_chats), (30, 1));
        assert!(!report.reasoning_reported);
        assert_eq!(store.for_agent("nobody").unwrap().total, 0);
    }

    #[test]
    fn missing_usage_stays_unknown_and_a_server_restart_between_turns_counts_each_once() {
        // A full stop with no usage at all is not a zero reading: nothing is
        // recorded, so the chat does not even appear.
        let bare = json!({ "type": "result", "subtype": "error_during_execution" });
        assert!(Meter::default().observe(ChatAgent::Claude, &bare).is_none());
        let store = Store::default();
        assert_eq!(store.for_agent("a").unwrap().chats, 0);

        let root = std::env::temp_dir().join(format!("octiq-usage-{}", uuid::Uuid::new_v4()));
        let path = root.join("agent-usage.json");
        let first = Store::load(path.clone());
        let mut before = Meter::default();
        let turn = before
            .observe(
                ChatAgent::Claude,
                &claude_result(json!({ "opus": model(5, 50, 0, 0) })),
            )
            .unwrap();
        first
            .record("chat:l", ChatAgent::Claude, &turn, 1, || Some(who("a")))
            .unwrap();
        drop(first);
        // The server restarted: a new process, a new meter, totals from zero.
        let second = Store::load(path);
        let mut after = Meter::default();
        let next = after
            .observe(
                ChatAgent::Claude,
                &claude_result(json!({ "opus": model(2, 20, 0, 0) })),
            )
            .unwrap();
        second
            .record("chat:l", ChatAgent::Claude, &next, 2, || None)
            .unwrap();
        let usage = second.for_agent("a").unwrap();
        assert_eq!((usage.usage.output, usage.usage.input), (70, 7));
        assert_eq!(usage.chats, 1);
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn concurrent_readings_all_land_and_survive_a_restart() {
        let root = std::env::temp_dir().join(format!("octiq-usage-{}", uuid::Uuid::new_v4()));
        let path = root.join("agent-usage.json");
        let store = Arc::new(Store::load(path.clone()));
        let reading = Reading {
            usage: TokenUsage {
                input: 3,
                output: 2,
                ..TokenUsage::default()
            },
            thread_total: None,
        };
        let threads: Vec<_> = (0..8)
            .map(|i| {
                let store = store.clone();
                let reading = reading.clone();
                std::thread::spawn(move || {
                    for turn in 0..5 {
                        store
                            .record(
                                &format!("chat:{}", i % 2),
                                ChatAgent::Claude,
                                &reading,
                                turn,
                                || Some(who("a")),
                            )
                            .unwrap();
                    }
                })
            })
            .collect();
        for thread in threads {
            thread.join().unwrap();
        }
        let reloaded = Store::load(path);
        assert_eq!(reloaded.for_agent("a").unwrap().total, 8 * 5 * 5);
        // An unreadable file pauses counting instead of being overwritten.
        fs::write(root.join("agent-usage.json"), b"{not json").unwrap();
        let broken = Store::load(root.join("agent-usage.json"));
        assert!(broken
            .record("chat:0", ChatAgent::Claude, &reading, 9, || Some(who("a")))
            .is_err());
        assert_eq!(
            fs::read(root.join("agent-usage.json")).unwrap(),
            b"{not json"
        );
        let _ = fs::remove_dir_all(root);
    }
}
