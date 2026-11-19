//! The person changes provider, model and effort from inside a registered
//! agent's chat (`chat_switch_runtime`), and returns to the chat's own
//! runtime after an automatic failover.
//!
//! The contract is in `docs/agents-mode.md`, *Switching a chat's runtime*.
//! The rules that shape this file:
//!
//! * **The registration never changes.** `team.json`, new chats of the agent
//!   and the workers a chat coordinates are untouched. The chat's own
//!   runtime (its *baseline*) is what the record says it is.
//! * **The record is the truth, memory is a mirror.** Every fact that must
//!   survive a restart is a line in the chat's record: the intent
//!   (`octiq_runtime_change_prepared`), a switch waiting for a full stop
//!   (`octiq_runtime_pending`, `octiq_runtime_pending_cleared`), the switch
//!   itself (`octiq_provider_switched` with `byPerson`, `handoffOwed`) and
//!   the first prompt that carried the history (`octiq_runtime_handoff_taken`).
//! * **A busy chat is never interrupted.** A switch asked for during a turn
//!   waits for that turn's full stop and is applied there, before the queue
//!   moves; the queued messages then go to the new runtime in order.
//! * **Whoever starts the chat next starts it on the new runtime**, because
//!   the start context and the ledger's resume context are replaced, never
//!   removed. A fresh session after a provider change carries the history
//!   and the agent's full brief (`with_switch_context`), whoever starts it.
use super::*;
use crate::provider_failover::Settings;

/// Opens every prompt `model_handoff_prompt` builds, so a prompt that already
/// carries the history is never wrapped twice.
pub(super) const HANDOFF_PREFIX: &str =
    "Continue this OctiqFlow conversation using the earlier turns below.";

const RECORD_KINDS: [&str; 5] = [
    "octiq_provider_switched",
    "octiq_registered_recovered",
    "octiq_runtime_pending",
    "octiq_runtime_pending_cleared",
    "octiq_runtime_handoff_taken",
];

/// The runtime a switch waits to apply.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub(crate) struct PendingRuntime {
    pub agent: ChatAgent,
    pub model: Option<String>,
    pub effort: Option<String>,
}

impl PendingRuntime {
    fn settings(&self, access: Access) -> Settings {
        Settings {
            agent: self.agent,
            model: self.model.clone(),
            effort: self.effort.clone(),
            access,
        }
    }
}

/// What the chat's record says about its runtime, read in order.
#[derive(Debug, Default, Clone, PartialEq, Eq)]
pub(crate) struct Recorded {
    /// Where the last runtime change put the chat.
    pub current: Option<Settings>,
    /// The chat's own runtime: where automatic failover returns to. The
    /// registration until the first change; then the first runtime an
    /// automatic failover left, or the person's last pick.
    pub baseline: Option<Settings>,
    /// The last runtime change was the person's.
    pub last_by_person: bool,
    /// A fresh session is owed the history and the agent's brief.
    pub handoff_owed: bool,
    /// A switch waits for a full stop (or the next start).
    pub pending: Option<PendingRuntime>,
}

impl Recorded {
    /// The runtime the person's last change decided, if that is the last
    /// change there was. A page that still names an older runtime does not
    /// undo it.
    pub(crate) fn persons_runtime(&self) -> Option<&Settings> {
        self.current.as_ref().filter(|_| self.last_by_person)
    }
}

fn runtime_of(event: &Value) -> Option<Settings> {
    serde_json::from_value::<Settings>(event.clone()).ok()
}

fn fold(found: &mut Recorded, event: &Value) {
    match event["type"].as_str() {
        Some(kind @ ("octiq_provider_switched" | "octiq_registered_recovered")) => {
            let Some(to) = runtime_of(event) else {
                return;
            };
            let by_person = event["byPerson"].as_bool() == Some(true);
            if by_person || kind == "octiq_registered_recovered" {
                found.baseline = Some(to.clone());
            } else if found.baseline.is_none() {
                found.baseline = event
                    .get("previousSettings")
                    .and_then(|settings| serde_json::from_value(settings.clone()).ok());
            }
            // Any change that builds its own handoff pays the debt; a
            // person's change may owe one.
            found.handoff_owed = by_person && event["handoffOwed"].as_bool() == Some(true);
            if by_person {
                found.pending = None;
            }
            found.last_by_person = by_person;
            found.current = Some(to);
        }
        Some("octiq_runtime_pending") => {
            found.pending = serde_json::from_value(event.clone()).ok();
        }
        Some("octiq_runtime_pending_cleared") => found.pending = None,
        Some("octiq_runtime_handoff_taken") => found.handoff_owed = false,
        _ => {}
    }
}

/// Read the chat's runtime facts from its record. Filters on the bytes and
/// parses only the five kinds of line that matter.
pub(crate) fn recorded(key: &str) -> Result<Recorded, String> {
    let mut found = Recorded::default();
    crate::transcript::walk(key, |_, line| {
        let Ok(text) = std::str::from_utf8(line) else {
            return;
        };
        if !RECORD_KINDS.iter().any(|kind| text.contains(kind)) {
            return;
        }
        if let Ok(event) = serde_json::from_str::<Value>(text) {
            fold(&mut found, &event);
        }
    })?;
    Ok(found)
}

fn same_runtime(a: &Settings, b: &Settings) -> bool {
    a.agent == b.agent && a.model == b.model && a.effort == b.effort
}

/// What `chat_switch_runtime` asks for.
#[derive(Debug, Clone)]
pub struct Request {
    pub agent: ChatAgent,
    pub model: Option<String>,
    pub effort: Option<String>,
}

/// What the host did with it. `access` is the level the chat runs at, which
/// a switch never changes.
#[derive(Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Answer {
    pub state: &'static str,
    pub agent: ChatAgent,
    pub model: Option<String>,
    pub effort: Option<String>,
    pub access: Access,
}

impl Answer {
    fn of(state: &'static str, settings: &Settings) -> Self {
        Self {
            state,
            agent: settings.agent,
            model: settings.model.clone(),
            effort: settings.effort.clone(),
            access: settings.access,
        }
    }
}

/// The home runtime a chat on an automatic fallback can return to.
#[derive(Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct HomeRuntime {
    pub agent: ChatAgent,
    pub model: Option<String>,
    pub effort: Option<String>,
    pub limited: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub resets_at: Option<i64>,
}

/// A switch waiting for a full stop, as a page reads it.
#[derive(Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct PendingView {
    pub agent: ChatAgent,
    pub model: Option<String>,
    pub effort: Option<String>,
}

/// In-memory mirror of what is on the record, for the one thing that cannot
/// read it: the full stop of a turn, which decides under the session lock.
#[derive(Default)]
pub(crate) struct RuntimeBook {
    pending: HashMap<String, Waiting>,
    /// Chats a fresh session owes the history and the brief.
    owed: std::collections::HashSet<String>,
    /// Chats whose record has been read into this book.
    loaded: std::collections::HashSet<String>,
    /// The projects' names, for a global agent's roster in its brief.
    projects: Vec<(String, String)>,
}

struct Waiting {
    target: PendingRuntime,
    /// The launch whose full stop took this switch (`mark_due`).
    due: Option<String>,
}

impl ChatManager {
    /// The projects the person has, for the names in a global agent's brief.
    /// Told by the socket on every command that builds a brief.
    pub(crate) fn note_projects(&self, projects: Vec<(String, String)>) {
        if let Ok(mut book) = self.runtime.lock() {
            book.projects = projects;
        }
    }

    fn projects(&self) -> Vec<(String, String)> {
        self.runtime
            .lock()
            .map(|book| book.projects.clone())
            .unwrap_or_default()
    }

    /// Read the record into the book once per chat and server run.
    fn load_runtime(&self, key: &str) {
        if self
            .runtime
            .lock()
            .is_ok_and(|book| book.loaded.contains(key))
        {
            return;
        }
        let Ok(found) = recorded(key) else {
            return;
        };
        if let Ok(mut book) = self.runtime.lock() {
            if !book.loaded.insert(key.to_string()) {
                return;
            }
            if found.handoff_owed {
                book.owed.insert(key.to_string());
            }
            if let Some(target) = found.pending {
                book.pending
                    .entry(key.to_string())
                    .or_insert(Waiting { target, due: None });
            }
        }
    }

    fn pending_runtime(&self, key: &str) -> Option<PendingRuntime> {
        self.load_runtime(key);
        self.runtime
            .lock()
            .ok()?
            .pending
            .get(key)
            .map(|waiting| waiting.target.clone())
    }

    fn set_pending(&self, key: &str, target: PendingRuntime) {
        self.load_runtime(key);
        if let Ok(mut book) = self.runtime.lock() {
            book.pending
                .insert(key.to_string(), Waiting { target, due: None });
        }
    }

    fn drop_pending(&self, key: &str) -> bool {
        self.runtime
            .lock()
            .map(|mut book| book.pending.remove(key).is_some())
            .unwrap_or(false)
    }

    fn handoff_owed(&self, key: &str) -> bool {
        self.load_runtime(key);
        self.runtime
            .lock()
            .is_ok_and(|book| book.owed.contains(key))
    }

    /// A clear chat starts over: nothing waits and nothing is owed.
    pub(crate) fn forget_runtime(&self, key: &str) {
        if let Ok(mut book) = self.runtime.lock() {
            book.pending.remove(key);
            book.owed.remove(key);
            book.loaded.remove(key);
        }
    }

    /// The switch the full stop of `launch` took, if there is one. It stays
    /// in the book until it is applied (`settle`) or dropped, so the page is
    /// told once when it is gone.
    fn due_runtime(&self, key: &str, launch: &str) -> Option<PendingRuntime> {
        let book = self.runtime.lock().ok()?;
        let waiting = book.pending.get(key)?;
        (waiting.due.as_deref() == Some(launch)).then(|| waiting.target.clone())
    }

    /// The full stop could not apply it (the process was already gone): it
    /// waits for the next start again.
    fn not_due(&self, key: &str) {
        if let Ok(mut book) = self.runtime.lock() {
            if let Some(waiting) = book.pending.get_mut(key) {
                waiting.due = None;
            }
        }
    }
}

// ---- who may switch -------------------------------------------------------

/// The registered agent whose chat this is, or why it cannot be switched.
fn eligible(manager: &ChatManager, key: &str) -> Result<crate::team::TeamAgent, String> {
    let id = key
        .strip_prefix("chat:")
        .ok_or("Name a chat to change its runtime.")?;
    if key.starts_with("chat:orch-") || manager.orchestrations.is_worker_chat(key)? {
        return Err(
            "A worker's runtime comes with its task and is not changed from its chat.".into(),
        );
    }
    let path = crate::team::default_path();
    if crate::team::is_front_desk_chat(&path, key) {
        return Err("A front desk only routes. Its runtime is set in Settings, Agents.".into());
    }
    let agent = crate::team::defaults_for_chat(&path, key)?.ok_or(
        "Only a chat with a registered agent can change its runtime. This chat has none, or its agent was removed.",
    )?;
    if let Some(leaving) = manager.leaving_refusal(key) {
        return Err(leaving);
    }
    if !crate::chat_index::listed_ids()?.contains(id) {
        return Err("This chat is not in the chat list.".into());
    }
    Ok(agent)
}

/// What the chat runs on now, with the access it runs at: the live start
/// context, else the ledger's resume context, else the chat's index entry,
/// else the registration.
fn current_runtime(
    manager: &ChatManager,
    key: &str,
    agent: &crate::team::TeamAgent,
) -> Result<Settings, String> {
    if let Some(start) = manager.start_context(key) {
        return Ok(start.settings());
    }
    if let Some(saved) = manager.orchestrations.saved_resume_context(key) {
        return Ok(saved.settings());
    }
    if let Some(meta) = key
        .strip_prefix("chat:")
        .map(crate::chat_index::find)
        .transpose()?
        .flatten()
    {
        if let Ok(settings) = crate::lead_threads::saved_settings(&meta) {
            return Ok(settings);
        }
    }
    Ok(Settings {
        agent: agent.agent,
        model: Some(agent.model.clone()),
        effort: agent.effort.clone(),
        access: agent.access,
    })
}

/// Check a request against the chat's current runtime and build the
/// settings it would run at. The access level is the chat's own and never
/// moves.
fn validate(request: &Request, current: &Settings) -> Result<Settings, String> {
    let model = request
        .model
        .as_deref()
        .map(str::trim)
        .filter(|model| !model.is_empty())
        .map(str::to_string);
    let effort = request
        .effort
        .as_deref()
        .map(str::trim)
        .filter(|effort| !effort.is_empty())
        .map(str::to_string);
    if model
        .as_deref()
        .is_some_and(|m| crate::agent_provider::safe_model(m).is_none())
    {
        return Err("Choose a valid, explicit provider-native model.".into());
    }
    crate::agent_provider::validate_model(request.agent, model.as_deref())?;
    registered_runtime::require_installed(request.agent)?;
    if request.agent == ChatAgent::Antigravity
        && matches!(current.access, Access::Auto | Access::Manual)
    {
        return Err("Antigravity cannot ask for approval, so a chat at this access level cannot move to it. Choose another provider or change the access level first.".into());
    }
    if request.agent == ChatAgent::Antigravity && effort.is_some() {
        return Err("Antigravity's effort is part of its model. Choose model default.".into());
    }
    if let Some(effort) = effort.as_deref() {
        if provider_for(request.agent).effort(effort) != Some(effort) {
            return Err("This provider does not support that effort. Choose a supported effort or model default.".into());
        }
        // Claude's catalog is bundled and lists each model's efforts.
        if request.agent == ChatAgent::Claude {
            if let Some(listed) = crate::agents::agent_models(ChatAgent::Claude)
                .ok()
                .and_then(|catalog| {
                    catalog
                        .models
                        .into_iter()
                        .find(|row| Some(row.model.as_str()) == model.as_deref())
                })
                .filter(|row| !row.supported_efforts.is_empty())
            {
                if !listed.supported_efforts.iter().any(|e| e == effort) {
                    return Err("This model does not support that effort. Choose one of its efforts or model default.".into());
                }
            }
        }
    }
    Ok(Settings {
        agent: request.agent,
        model,
        effort,
        access: current.access,
    })
}

// ---- the command ----------------------------------------------------------

pub fn chat_switch_runtime_impl(
    manager: &Arc<ChatManager>,
    key: &str,
    request: Request,
) -> Result<Answer, String> {
    crate::profile::available()?;
    let agent = eligible(manager, key)?;
    let current = current_runtime(manager, key, &agent)?;
    let target = validate(&request, &current)?;
    let waiting = PendingRuntime {
        agent: target.agent,
        model: target.model.clone(),
        effort: target.effort.clone(),
    };
    // Picking what already runs takes a waiting switch back and is otherwise
    // nothing at all.
    if same_runtime(&target, &current) {
        if manager.pending_runtime(key).is_some() {
            clear_pending(manager, key)?;
        }
        return Ok(Answer::of("switched", &current));
    }
    if manager.completing_turn(key).is_some() {
        return Err("This chat is being completed. Wait for the wrap-up to end, or stop it, then change the runtime.".into());
    }
    let previous = manager.start_context(key).and_then(|s| s.session_id);
    // Saved first. Nothing below changes unless this is on disk.
    provider_switch::prepare_runtime_change(
        key,
        &current,
        &target,
        "person-selected runtime change inside the chat; the agent's registration is unchanged",
        previous.as_deref(),
    )?;
    // The person's pick supersedes a resume the quota failure scheduled: it
    // would only start the runtime they just left.
    cancel_auto_resume(manager, key, "superseded by a runtime change");
    if try_settle_now(manager, key, &agent, &current, &target)? {
        return Ok(Answer::of("switched", &target));
    }
    // A turn is in flight, parked on a card, unwinding after Stop, or
    // something is queued: it applies at that turn's full stop.
    record_chat_event_synced(
        key,
        json!({
            "type": "octiq_runtime_pending",
            "agent": waiting.agent, "model": waiting.model, "effort": waiting.effort,
        }),
    )
    .ok_or("The runtime change could not be saved. Nothing was changed.")?;
    manager
        .failover
        .clear(target.agent, target.model.as_deref());
    cancel_auto_resume(manager, key, "superseded by a runtime change");
    manager.set_pending(key, waiting.clone());
    crate::bus::emit(
        "chat-runtime-pending",
        json!({ "key": key, "agent": waiting.agent, "model": waiting.model, "effort": waiting.effort }),
    );
    Ok(Answer::of("pending", &target))
}

/// Take a waiting switch back. A failed write refuses whole: a switch that
/// stays on the record would apply at the next full stop.
fn clear_pending(manager: &ChatManager, key: &str) -> Result<(), String> {
    record_chat_event_synced(key, json!({ "type": "octiq_runtime_pending_cleared" }))
        .ok_or("The runtime change could not be taken back: its record could not be written.")?;
    manager.drop_pending(key);
    crate::bus::emit(
        "chat-runtime-pending",
        json!({ "key": key, "cleared": true }),
    );
    Ok(())
}

/// Whether the chat can change now without interrupting anything. If it can,
/// it did. The chat's lifecycle is fenced (`handoffs`) from the moment its
/// process is ended until the new runtime is saved, so a message sent in
/// between waits in the queue and a start is told the chat is busy.
fn try_settle_now(
    manager: &Arc<ChatManager>,
    key: &str,
    agent: &crate::team::TeamAgent,
    current: &Settings,
    target: &Settings,
) -> Result<bool, String> {
    {
        let mut sessions = manager.sessions.lock().map_err(|e| e.to_string())?;
        let mut handoffs = manager.handoffs.lock().map_err(|e| e.to_string())?;
        if handoffs.contains(key) || manager.start_in_progress(key) {
            return Ok(false);
        }
        if let Some(session) = sessions.get(key).cloned() {
            let mut old = session.lock().map_err(|e| e.to_string())?;
            let idle = !old.busy
                && old.cut_off == CutOff::No
                && !old.first_turn_held
                && !manager.has_queued_turns(key)
                && !manager.background.has_running(key)
                && !manager.jobs.has_running(key)
                && manager.waits_because(key).is_none();
            if !idle {
                return Ok(false);
            }
            manager.questions.detach_launch(&old.launch_id);
            manager.revoke_auto_plan(key);
            stop_process(manager, key, &mut old);
            drop(old);
            sessions.remove(key);
        } else if manager.has_queued_turns(key) || manager.waits_because(key).is_some() {
            return Ok(false);
        }
        handoffs.insert(key.to_string());
    }
    let waiting = PendingRuntime {
        agent: target.agent,
        model: target.model.clone(),
        effort: target.effort.clone(),
    };
    let settled = settle(manager, key, agent, current, &waiting);
    finish_fence(manager, key);
    settled.map(|()| true)
}

/// Lift the fence and start whatever a send queued behind it.
fn finish_fence(manager: &Arc<ChatManager>, key: &str) {
    let next = match manager.sessions.lock() {
        Ok(_sessions) => {
            let next = manager.take_queued_turn(key);
            if next.is_none() {
                if let Ok(mut handoffs) = manager.handoffs.lock() {
                    handoffs.remove(key);
                }
            }
            next
        }
        Err(_) => None,
    };
    match next {
        Some(turn) => carry(manager, key, turn),
        None => say_exited(manager, key, key),
    }
}

/// Start `turn` in the chat's next process, or say why not.
fn carry(manager: &Arc<ChatManager>, key: &str, turn: QueuedTurn) {
    carry_with(manager, key, turn, |turn| {
        start_queued_turn(manager.clone(), key, key, turn, false)
    });
}

/// `carry`, with how the turn is started left to the caller.
fn carry_with(
    manager: &Arc<ChatManager>,
    key: &str,
    turn: QueuedTurn,
    start: impl FnOnce(QueuedTurn) -> Result<(), String>,
) {
    match carry_queued_turn(manager, key, key, turn, start) {
        Ok(Carried::Started) => {}
        Ok(Carried::Waits(_)) => say_exited(manager, key, key),
        Err(why) => {
            for (kind, text) in [
                ("error", format!("could not resume queued message: {why}")),
                ("exit", String::new()),
            ] {
                if let Some(start) = manager.start_context(key) {
                    emit_status(
                        start.agent,
                        ChatStatus {
                            key: key.to_string(),
                            kind: kind.into(),
                            text,
                            code: None,
                        },
                    );
                }
            }
        }
    }
}

/// Change the chat's runtime. No process is running under it: the caller has
/// ended it, or fenced the chat, or is about to start it. Replaces the start
/// context and the ledger's resume context, never removes them.
fn settle(
    manager: &ChatManager,
    key: &str,
    agent: &crate::team::TeamAgent,
    current: &Settings,
    wanted: &PendingRuntime,
) -> Result<(), String> {
    let to = validate(
        &Request {
            agent: wanted.agent,
            model: wanted.model.clone(),
            effort: wanted.effort.clone(),
        },
        current,
    )?;
    let old = manager
        .start_context(key)
        .or_else(|| manager.orchestrations.saved_resume_context(key));
    let same_provider = current.agent == to.agent;
    // The session the chat holds: the start context's, else the index's.
    let held_session = old
        .as_ref()
        .and_then(|start| start.session_id.clone())
        .or_else(|| {
            key.strip_prefix("chat:")
                .and_then(|id| crate::chat_index::find(id).ok().flatten())
                .and_then(|meta| meta.session_id)
        });
    // The native session follows the model while the provider is the same
    // (each CLI takes `--model` / `--effort` with its resume flag). It never
    // crosses to another provider: that is a fresh session and the history.
    let keep_session = same_provider && held_session.is_some();
    let handoff_owed = !keep_session;
    let new_start = old.clone().map(|mut start| {
        start.defaults = Some(to.clone());
        start.agent = to.agent;
        start.model = to.model.clone();
        start.effort = to.effort.clone();
        if !keep_session {
            start.session_id = None;
        }
        start
    });
    let previous_session = held_session.clone();
    if let Some(start) = &new_start {
        manager.remember_start(key, start.clone());
        // Messages already queued go to the new runtime, in the same order.
        if let Ok(mut queues) = manager.queued_turns.lock() {
            if let Some(queue) = queues.get_mut(key) {
                for turn in queue {
                    turn.context = Some(QueueContext::from(start.clone()));
                }
            }
        }
    }
    manager.failover.clear(to.agent, to.model.as_deref());
    let message = format!(
        "Switched to {} / {} at {} effort by your choice. {}'s registration is unchanged.",
        to.agent.id(),
        to.model.as_deref().unwrap_or("default"),
        to.effort.as_deref().unwrap_or("model default"),
        agent.name
    );
    let announced = provider_switch::announce_runtime_change_with(
        manager,
        key,
        current,
        &to,
        "octiq_provider_switched",
        &message,
        previous_session.as_deref(),
        json!({ "byPerson": true, "handoffOwed": handoff_owed, "sessionKept": keep_session }),
        Some(if keep_session { held_session } else { None }),
    );
    if let Err(why) = announced {
        // Not on the record: the chat goes on as it was.
        if let Some(start) = old {
            manager.remember_start(key, start);
        }
        return Err(why);
    }
    if let Ok(mut book) = manager.runtime.lock() {
        book.loaded.insert(key.to_string());
        if handoff_owed {
            book.owed.insert(key.to_string());
        } else {
            book.owed.remove(key);
        }
    }
    // A switch that was waiting is replaced by this one.
    if manager.drop_pending(key) {
        crate::bus::emit(
            "chat-runtime-pending",
            json!({ "key": key, "cleared": true }),
        );
    }
    Ok(())
}

// ---- applying a waiting switch ---------------------------------------------

/// Called under the session lock at a turn's full stop, before the queue
/// moves. When a switch waits and nothing forbids applying it now, the
/// process is marked ended and the caller hands the stop to
/// `apply_at_full_stop` once the lock is let go. Answers whether it did.
pub(super) fn mark_due(
    manager: &ChatManager,
    session_key: &str,
    stream_key: &str,
    session: &mut ChatSession,
    wrap_up_decided: bool,
) -> bool {
    // Every full stop of every chat asks: the cheap answer first.
    if manager
        .runtime
        .lock()
        .map_or(true, |book| !book.pending.contains_key(session_key))
    {
        return false;
    }
    if session_key != stream_key
        || wrap_up_decided
        || session.cut_off != CutOff::No
        || !provider_for(session.agent)
            .capabilities()
            .input
            .accepts_stdin()
        || manager.background.has_running(session_key)
        || manager.jobs.has_running(session_key)
        || manager.auto_resumes.waits(session_key)
        || crate::profile::available().is_err()
    {
        return false;
    }
    let Ok(mut book) = manager.runtime.lock() else {
        return false;
    };
    let Some(waiting) = book.pending.get_mut(session_key) else {
        return false;
    };
    waiting.due = Some(session.launch_id.clone());
    // From here nothing is written to this process: a message waits in the
    // queue and goes to the new runtime.
    session.cut_off = CutOff::Ended;
    true
}

/// Whether `mark_due` took this launch's full stop.
#[cfg(test)]
pub(super) fn is_due(manager: &ChatManager, session_key: &str, launch: &str) -> bool {
    manager.runtime.lock().is_ok_and(|book| {
        book.pending
            .get(session_key)
            .is_some_and(|waiting| waiting.due.as_deref() == Some(launch))
    })
}

/// Apply the switch a full stop took. Ends that process, changes the chat's
/// runtime and starts the first queued message on it. Whatever goes wrong,
/// the old process is gone and the queue still runs: on the old runtime.
pub(super) fn apply_at_full_stop(
    manager: &Arc<ChatManager>,
    session_key: &str,
    stream_key: &str,
    asking: &Arc<Mutex<ChatSession>>,
) {
    apply_with(manager, session_key, stream_key, asking, |turn| {
        start_queued_turn(manager.clone(), session_key, stream_key, turn, false)
    });
}

/// `apply_at_full_stop`, with how the first queued message is started in the
/// new process left to the caller.
fn apply_with(
    manager: &Arc<ChatManager>,
    session_key: &str,
    stream_key: &str,
    asking: &Arc<Mutex<ChatSession>>,
    start: impl FnOnce(QueuedTurn) -> Result<(), String>,
) {
    let Some(launch) = asking.lock().ok().map(|s| s.launch_id.clone()) else {
        return;
    };
    let Some(waiting) = manager.due_runtime(session_key, &launch) else {
        return;
    };
    let ended = {
        let Ok(mut sessions) = manager.sessions.lock() else {
            manager.not_due(session_key);
            return;
        };
        if !sessions
            .get(session_key)
            .is_some_and(|current| Arc::ptr_eq(current, asking))
        {
            // The process is gone already (a completion, a Stop): the next
            // start of the chat applies it.
            drop(sessions);
            manager.not_due(session_key);
            return;
        }
        let Ok(mut old) = asking.lock() else {
            manager.not_due(session_key);
            return;
        };
        manager.questions.detach_launch(&old.launch_id);
        manager.revoke_auto_plan(session_key);
        let next = manager.take_queued_turn(session_key);
        if let Ok(mut handoffs) = manager.handoffs.lock() {
            handoffs.insert(session_key.to_string());
        }
        sessions.remove(session_key);
        stop_process(manager, session_key, &mut old);
        next
    };
    let applied = (|| -> Result<(), String> {
        let agent = eligible(manager, session_key)?;
        let current = current_runtime(manager, session_key, &agent)?;
        if same_runtime(&waiting.settings(current.access), &current) {
            return Ok(());
        }
        settle(manager, session_key, &agent, &current, &waiting)
    })();
    if let Err(why) = applied {
        // The old runtime carries on, and says why the switch did not happen.
        let _ = record_chat_event_synced(
            session_key,
            json!({ "type": "octiq_runtime_pending_cleared", "failed": why }),
        );
        manager.drop_pending(session_key);
        crate::bus::emit(
            "chat-runtime-pending",
            json!({ "key": stream_key, "cleared": true }),
        );
        if let Some(start) = manager.start_context(session_key) {
            emit_status(
                start.agent,
                ChatStatus {
                    key: stream_key.to_string(),
                    kind: "error".into(),
                    text: format!("The runtime change could not be applied: {why}"),
                    code: None,
                },
            );
        }
    }
    match ended {
        Some(turn) => carry_with(manager, session_key, turn, start),
        None => finish_fence(manager, session_key),
    }
}

/// A chat with no process is about to start (a message, a wake, a queued
/// turn): a switch that waits for it applies first, so whoever starts the
/// chat starts it on the new runtime. A failure leaves the chat as it was and
/// takes the waiting switch back.
pub(super) fn adopt_pending(manager: &ChatManager, key: &str) {
    if key.starts_with("chat:orch-") {
        return;
    }
    let Some(waiting) = manager.pending_runtime(key) else {
        return;
    };
    if manager
        .sessions
        .lock()
        .map(|sessions| sessions.contains_key(key))
        .unwrap_or(true)
    {
        return;
    }
    let applied = (|| -> Result<(), String> {
        let agent = eligible(manager, key)?;
        let current = current_runtime(manager, key, &agent)?;
        if same_runtime(&waiting.settings(current.access), &current) {
            return Ok(());
        }
        settle(manager, key, &agent, &current, &waiting)
    })();
    if let Err(why) = applied {
        eprintln!("[chat] a waiting runtime change was dropped for {key}: {why}");
        let _ = record_chat_event_synced(
            key,
            json!({ "type": "octiq_runtime_pending_cleared", "failed": why }),
        );
        manager.drop_pending(key);
        crate::bus::emit(
            "chat-runtime-pending",
            json!({ "key": key, "cleared": true }),
        );
    }
}

// ---- reading it back ---------------------------------------------------------

/// What `chat_queue_state` says about a chat's runtime. A chat with no
/// registered agent says nothing, and a record that cannot be read says
/// nothing rather than something wrong.
pub(crate) fn queue_fields(
    manager: &ChatManager,
    key: &str,
) -> (Option<PendingView>, Option<HomeRuntime>) {
    let path = crate::team::default_path();
    if key.starts_with("chat:orch-")
        || !matches!(crate::team::defaults_for_chat(&path, key), Ok(Some(_)))
    {
        return (None, None);
    }
    let Ok(found) = recorded(key) else {
        return (None, None);
    };
    let pending = found.pending.clone().map(|p| PendingView {
        agent: p.agent,
        model: p.model,
        effort: p.effort,
    });
    let current = manager
        .start_context(key)
        .map(|start| start.settings())
        .or(found.current.clone());
    let home = home_runtime(manager, found.baseline.as_ref(), current.as_ref());
    (pending, home)
}

/// The runtime to return to, only while the chat runs on something else.
fn home_runtime(
    manager: &ChatManager,
    baseline: Option<&Settings>,
    current: Option<&Settings>,
) -> Option<HomeRuntime> {
    let (home, current) = (baseline?, current?);
    if same_runtime(home, current) {
        return None;
    }
    let now = crate::auto_resume::unix_now();
    Some(HomeRuntime {
        agent: home.agent,
        model: home.model.clone(),
        effort: home.effort.clone(),
        limited: manager
            .failover
            .blocked(home.agent, home.model.as_deref(), now),
        resets_at: manager
            .failover
            .resets_at(home.agent, home.model.as_deref(), now),
    })
}

/// `home` as the `chat-provider-switch` event carries it.
pub(super) fn home_after(manager: &ChatManager, key: &str, to: &Settings) -> Option<Value> {
    let found = recorded(key).ok()?;
    let home = home_runtime(manager, found.baseline.as_ref(), Some(to))?;
    serde_json::to_value(home).ok()
}

// ---- a fresh session carries who the agent is ------------------------------

/// The prompt with the agent's full current brief after it, in the form the
/// page hides from the person's bubble. A chat with no registered agent is
/// returned as it is.
pub(super) fn with_identity_brief(
    manager: &ChatManager,
    key: &str,
    prompt: String,
) -> Result<String, String> {
    crate::team::identity_brief(
        &crate::team::default_path(),
        key,
        prompt,
        &manager.projects(),
    )
}

/// The first prompt of a fresh session after a runtime change the person
/// made. `prompt` is what the provider is about to be given; `visible` what
/// the person sees. Both come back changed when the chat owes a handoff:
/// the history as data, the new message last, and the agent's brief
/// outside the data. Taken from the debt only after the process started
/// (`handoff_taken`).
pub(super) fn with_switch_context(
    manager: &ChatManager,
    key: &str,
    resume: Option<&str>,
    prompt: Option<String>,
    visible: Option<String>,
) -> Result<(Option<String>, Option<String>, bool), String> {
    let Some(text) = prompt.clone().filter(|text| !text.trim().is_empty()) else {
        return Ok((prompt, visible, false));
    };
    // Only a registered agent's chat has a brief to carry, and reading its
    // record for a debt is not worth doing for any other chat.
    if resume.is_some()
        || key.starts_with("chat:orch-")
        || !matches!(
            crate::team::lead_for_chat(&crate::team::default_path(), key),
            Ok(Some(_))
        )
        || !manager.handoff_owed(key)
    {
        return Ok((prompt, visible, false));
    }
    let mut text = text;
    let mut visible = visible;
    if !text.starts_with(HANDOFF_PREFIX) {
        let history = provider_history(key)?;
        if history != "[]" {
            visible = visible.or_else(|| Some(text.clone()));
            text = model_handoff_prompt(&history, &text);
        }
    }
    if text.starts_with(HANDOFF_PREFIX) && !text.contains(crate::team::BRIEF_MARK) {
        text = with_identity_brief(manager, key, text)?;
    }
    Ok((Some(text), visible, true))
}

/// The process that took the history started: the debt is paid.
pub(super) fn handoff_taken(manager: &ChatManager, key: &str) {
    let owed = manager
        .runtime
        .lock()
        .map(|mut book| book.owed.remove(key))
        .unwrap_or(false);
    if owed {
        record_chat_event(key, json!({ "type": "octiq_runtime_handoff_taken" }));
    }
}

#[cfg(test)]
#[path = "runtime_switch_tests.rs"]
mod tests;
