//! Recoverable safety-policy blocks raised by Codex's tool router.
//!
//! Codex receives these failures as structured tool output and can carry on,
//! while its tracing layer writes a duplicate diagnostic to stderr. Most router
//! diagnostics belong only in the journal. Safety-policy rejections need the
//! person, though: they explain why an action did not happen and, in some
//! cases, offer one narrowly scoped approval.
//!
//! This module turns that diagnostic into a small, post-hoc choice in the UI.
//! It does not pretend the original tool call is paused — it has already
//! failed. The UI's choices send a fresh user turn telling Codex either to stay
//! local or authorising one retry.

use crate::paths::Canonical;
use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use serde::{Deserialize, Serialize};

use crate::agent_provider::AgentKind;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BlockedAction {
    id: String,
    chat_key: String,
    kind: &'static str,
    title: &'static str,
    summary: String,
    detail: String,
    #[serde(skip_serializing)]
    project_scope: Option<String>,
    /// Whose review refused: "codex" (its tool router) or "claude" (its auto
    /// mode classifier).
    provider: &'static str,
    /// The exact action as the agent called it — a shell line, or a tool and
    /// what it named. None when the provider did not say, as Codex's router
    /// diagnostics never do.
    action: Option<String>,
    /// An outage card only: how many refused calls it holds.
    #[serde(skip_serializing_if = "Option::is_none")]
    count: Option<usize>,
    /// An outage card only: what was refused, identical lines collapsed,
    /// in the order they were first refused.
    #[serde(skip_serializing_if = "Vec::is_empty")]
    commands: Vec<GroupedCommand>,
    /// An outage card only: the one recovery text the snapshot and the
    /// worker prompt also carry (`outage_guidance`).
    #[serde(skip_serializing_if = "Option::is_none")]
    guidance: Option<&'static str>,
    /// An outage card only: every refused call in it, for the ledger.
    #[serde(skip_serializing)]
    refusals: Vec<Refusal>,
    /// An outage card only: the settings files an "Always allow" would write,
    /// when this chat reads them. None for a chat that ignores Claude's
    /// settings files (a lite chat) or whose launch this server never saw.
    #[serde(skip_serializing_if = "Option::is_none")]
    allow: Option<AllowTargets>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct GroupedCommand {
    action: String,
    count: usize,
    /// The tool Claude was asked to run.
    tool: String,
    /// For Bash, the leading command words the rule covers (`git push`).
    #[serde(skip_serializing_if = "Option::is_none")]
    words: Option<String>,
    /// The narrowest allow rule covering this call (`claude_allow`), or none
    /// when no rule is narrow enough: then only a retry is offered.
    #[serde(skip_serializing_if = "Option::is_none")]
    rule: Option<String>,
}

/// Where an "Always allow" on an outage card would write.
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
struct AllowTargets {
    /// `<project>/.claude/settings.local.json`; none for a chat with no folder.
    #[serde(skip_serializing_if = "Option::is_none")]
    project: Option<String>,
    /// `<Claude config dir>/settings.json`.
    #[serde(skip_serializing_if = "Option::is_none")]
    user: Option<String>,
}

/// One refused call inside an outage card.
#[derive(Debug, Clone)]
struct Refusal {
    /// The ledger's id for this refusal; the card's id is its group id.
    id: String,
    tool_use_id: Option<String>,
    action: String,
    /// The tool as Claude named it, and for Bash the command line as called:
    /// a rule is derived from these, never re-read from the display `action`.
    tool: String,
    command: Option<String>,
    at: i64,
    /// The orchestration attempt live in the chat when it was refused, if
    /// any. A group belongs to one attempt: a retry can reuse a worker chat,
    /// and its refusals must not join the settled attempt's group.
    owner: Option<String>,
}

#[cfg(test)]
impl BlockedAction {
    pub fn chat_key(&self) -> &str {
        &self.chat_key
    }

    pub fn action(&self) -> Option<&str> {
        self.action.as_deref()
    }
}

/// Why Claude refused a call: its classifier judged the call, or the
/// classifier itself could not be reached and gave no verdict.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum RefusalKind {
    Safety,
    Outage,
}

impl RefusalKind {
    pub(crate) fn as_str(self) -> &'static str {
        match self {
            RefusalKind::Safety => "safety",
            RefusalKind::Outage => "outage",
        }
    }
}

/// The one place a provider's refusal reason is read as an outage.
///
/// Claude 2.1.x sends `decision_reason: "Classifier unavailable"` when the
/// server-side classifier gave no verdict; its message calls that "a transient
/// failure of the check, not a judgment about the action". Only that exact
/// reason, trimmed and case-folded, counts. Anything else — a missing reason,
/// an empty one, or one that merely mentions the words — is a safety refusal:
/// mistaking a real refusal for an outage would be the costly error.
pub(crate) fn refusal_kind(reason: Option<&str>) -> RefusalKind {
    let reason = reason
        .unwrap_or_default()
        .trim()
        .trim_start_matches('[')
        .trim_end_matches(']')
        .trim();
    if reason.eq_ignore_ascii_case("Classifier unavailable") {
        RefusalKind::Outage
    } else {
        RefusalKind::Safety
    }
}

/// An outage group stays open this long after its latest refusal.
pub(crate) const OUTAGE_WINDOW_MS: i64 = 2 * 60 * 1000;
/// ... but never longer than this after its first, so a worker refused again
/// and again still reaches its coordinator.
pub(crate) const OUTAGE_MAX_OPEN_MS: i64 = 5 * 60 * 1000;
/// ... and never past this many refusals.
pub(crate) const OUTAGE_MAX_REFUSALS: usize = 5;

/// When an outage group closes: its coordinator notice falls due then, and a
/// later refusal starts a new group. Shared by the card and the ledger so the
/// two always agree on where one group ends.
pub(crate) fn outage_group_due(first_at: i64, last_at: i64, count: usize) -> i64 {
    if count >= OUTAGE_MAX_REFUSALS {
        last_at
    } else {
        (last_at + OUTAGE_WINDOW_MS).min(first_at + OUTAGE_MAX_OPEN_MS)
    }
}

/// What an outage-refused command's worker may do about it again: one as-is
/// retry for classifier outages, decided by the person on 2026-09-28. It
/// matches what Claude's own message offers. The try is the worker's own call
/// and Claude checks it again; OctiqFlow never re-runs a refused call. A
/// second refusal of the same command ends it. Safety refusals never get this
/// sentence (`lifecycle`'s Claude recovery text stays strict).
pub(crate) const OUTAGE_RETRY: &str = "You may try the same command once more, as-is: Claude checks that try again. If it is refused again, do not try it a third time. Never reword a command to get past the check.";

/// The recovery text for an outage refusal, word for word the same on the
/// card, in the snapshot's `recovery` and in the worker prompt (feedback
/// 57fbac34: those three disagreed).
pub(crate) fn outage_guidance() -> &'static str {
    static TEXT: std::sync::OnceLock<String> = std::sync::OnceLock::new();
    TEXT.get_or_init(|| {
        format!(
            "Claude's safety check was unavailable, so the command did not run. It was not judged unsafe, and it was not approved. Continue with your other steps. OctiqFlow never re-runs it. {OUTAGE_RETRY} Report every refused command in your worker report, and do not describe any of them as approved or as having run."
        )
    })
}

/// Calls Claude refused, by tool_use id, so the result it sends back for one
/// is not mistaken for work done.
///
/// Bounded by evicting the OLDEST ids, never by clearing: a clear would forget
/// a refusal whose result has not come back yet, and that result would then
/// read as an allowed call. The result follows its refusal within the same
/// turn, so only an id thousands of refusals old can be evicted.
static REFUSED_CALLS: Mutex<Option<RefusedCalls>> = Mutex::new(None);
const REFUSED_CALLS_KEPT: usize = 4096;

#[derive(Default)]
struct RefusedCalls {
    order: std::collections::VecDeque<String>,
    ids: std::collections::HashSet<String>,
}

impl RefusedCalls {
    fn insert(&mut self, id: &str, cap: usize) {
        if !self.ids.insert(id.to_string()) {
            return;
        }
        self.order.push_back(id.to_string());
        while self.order.len() > cap {
            if let Some(oldest) = self.order.pop_front() {
                self.ids.remove(&oldest);
            }
        }
    }

    fn contains(&self, id: &str) -> bool {
        self.ids.contains(id)
    }
}

fn remember_refused_call(id: &str) {
    REFUSED_CALLS
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .get_or_insert_with(Default::default)
        .insert(id, REFUSED_CALLS_KEPT);
}

/// Whether Claude refused this tool call: its result is the refusal, not a
/// call that ran.
pub(crate) fn was_refused(tool_use_id: &str) -> bool {
    REFUSED_CALLS
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .as_ref()
        .is_some_and(|calls| calls.contains(tool_use_id))
}

fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or_default()
}

static PENDING: Mutex<Option<HashMap<String, BlockedAction>>> = Mutex::new(None);
/// How each card that is no longer pending was decided, so the orchestration
/// record can say what happened rather than only that the card went away.
static DECIDED: Mutex<Option<HashMap<String, &'static str>>> = Mutex::new(None);

fn with_decided<T>(f: impl FnOnce(&mut HashMap<String, &'static str>) -> T) -> T {
    let mut guard = DECIDED.lock().unwrap_or_else(|e| e.into_inner());
    f(guard.get_or_insert_with(HashMap::new))
}

/// Remember how a card was decided. Bounded: a long-lived server must not
/// grow this forever, and an old decision only loses its label, never turns
/// into an approval.
fn record_decision(id: &str, decision: &'static str) {
    with_decided(|decided| {
        if decided.len() >= 512 {
            decided.clear();
        }
        decided.insert(id.to_string(), decision);
    });
}

/// How a card that is no longer pending was decided, when this server saw it:
/// "authorized_project", "dismissed" or "superseded"; for an outage card also
/// "retried", "allowed_project" or "allowed_user". Nothing records
/// "allowed_exact" any more; see `EXACT_GRANT_WITHDRAWN`.
pub(crate) fn decision(id: &str) -> Option<&'static str> {
    with_decided(|decided| decided.get(id).copied())
}
static DRAFTS: Mutex<Option<HashMap<String, SafetyDraft>>> = Mutex::new(None);
static PROJECT_SCOPES: Mutex<Option<HashMap<String, String>>> = Mutex::new(None);
static AUTHORIZATIONS: Mutex<()> = Mutex::new(());

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
struct PersistentAuthorization {
    id: String,
    project_scope: String,
    kind: String,
    summary: String,
}

#[derive(Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct AuthorizationStore {
    #[serde(default)]
    authorizations: Vec<PersistentAuthorization>,
}

#[derive(Debug, Clone)]
struct SafetyDraft {
    lines: Vec<String>,
    summary: Option<String>,
}

fn with_pending<T>(f: impl FnOnce(&mut HashMap<String, BlockedAction>) -> T) -> T {
    let mut guard = PENDING.lock().unwrap_or_else(|e| e.into_inner());
    f(guard.get_or_insert_with(HashMap::new))
}

fn with_drafts<T>(f: impl FnOnce(&mut HashMap<String, SafetyDraft>) -> T) -> T {
    let mut guard = DRAFTS.lock().unwrap_or_else(|e| e.into_inner());
    f(guard.get_or_insert_with(HashMap::new))
}

fn with_project_scopes<T>(f: impl FnOnce(&mut HashMap<String, String>) -> T) -> T {
    let mut guard = PROJECT_SCOPES.lock().unwrap_or_else(|e| e.into_inner());
    f(guard.get_or_insert_with(HashMap::new))
}

fn normalized_scope(cwd: &str) -> Option<String> {
    let cwd = cwd.trim();
    if cwd.is_empty() {
        return None;
    }
    let path = PathBuf::from(cwd);
    Some(
        path.canonical()
            .unwrap_or(path)
            .to_string_lossy()
            .into_owned(),
    )
}

/// Associate a conversation with the project folder it was launched in. The
/// safety diagnostic itself carries only a chat key, so this is the durable
/// boundary used by "Always allow in this project".
pub fn remember_project(chat_key: &str, cwd: &str) {
    if let Some(scope) = normalized_scope(cwd) {
        with_project_scopes(|scopes| {
            scopes.insert(chat_key.to_string(), scope);
        });
    }
}

/// What an outage card's "Always allow" needs to know about the Claude
/// process that was refused: where it runs, whether it reads settings files
/// at all, and which config folder is its own.
#[derive(Debug, Clone)]
struct ClaudeLaunch {
    cwd: String,
    lite: bool,
    config_dir: Option<String>,
}

static CLAUDE_LAUNCHES: Mutex<Option<HashMap<String, ClaudeLaunch>>> = Mutex::new(None);

fn with_claude_launches<T>(f: impl FnOnce(&mut HashMap<String, ClaudeLaunch>) -> T) -> T {
    let mut guard = CLAUDE_LAUNCHES.lock().unwrap_or_else(|e| e.into_inner());
    f(guard.get_or_insert_with(HashMap::new))
}

/// Record a Claude chat's launch, or forget one that is no longer Claude's.
///
/// `cwd` is the folder the chat was asked for (empty for none), `lite` says
/// it was launched with `--setting-sources ''`, which reads no settings file
/// and so would ignore any rule, and `config_dir` is the `CLAUDE_CONFIG_DIR`
/// it runs with, if any.
pub fn remember_claude_launch(
    chat_key: &str,
    claude: bool,
    cwd: &str,
    lite: bool,
    config_dir: Option<String>,
) {
    with_claude_launches(|launches| {
        if claude {
            launches.insert(
                chat_key.to_string(),
                ClaudeLaunch {
                    cwd: cwd.trim().to_string(),
                    lite,
                    config_dir: config_dir.filter(|dir| !dir.trim().is_empty()),
                },
            );
        } else {
            launches.remove(chat_key);
        }
    });
}

/// The two files an outage card may write, for this chat.
fn allow_targets(chat_key: &str) -> Option<AllowTargets> {
    let launch = with_claude_launches(|launches| launches.get(chat_key).cloned())?;
    if launch.lite {
        return None;
    }
    let shown = |path: PathBuf| path.to_string_lossy().into_owned();
    let targets = AllowTargets {
        project: crate::claude_allow::project_settings_path(Path::new(&launch.cwd)).map(shown),
        user: crate::claude_allow::user_settings_path(
            launch.config_dir.as_deref().map(Path::new),
            crate::paths::home_dir().as_deref(),
        )
        .map(shown),
    };
    (targets.project.is_some() || targets.user.is_some()).then_some(targets)
}

/// What an "Always allow" wrote.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AllowedOutage {
    /// Every rule the card's calls derive, in the order they were refused.
    rules: Vec<String>,
    /// The settings file written.
    path: String,
    #[serde(flatten)]
    added: crate::claude_allow::Added,
    /// Refused calls no rule covers: the retry asks for them too, but they
    /// meet Claude's check again.
    uncovered: Vec<String>,
}

/// Only an outage card from Claude can be retried or allowed from here: a
/// judged refusal stands (`EXACT_GRANT_WITHDRAWN`), and Codex's cards have
/// their own choices.
fn pending_outage(id: &str) -> Result<BlockedAction, String> {
    let block = with_pending(|pending| pending.get(id).cloned())
        .ok_or("This card is no longer pending.")?;
    if block.provider != "claude" || block.kind != "outage" {
        return Err(
            "Only a call refused because Claude's safety check was unavailable can be retried or allowed from its card."
                .into(),
        );
    }
    Ok(block)
}

/// "Always allow": write the narrowest rule for each of the card's refused
/// calls into the chosen settings file, then take the card down as decided.
/// The caller then asks the agent to retry; nothing here runs anything.
pub fn allow_outage(id: &str, scope: crate::claude_allow::Scope) -> Result<AllowedOutage, String> {
    use crate::claude_allow::Scope;
    let block = pending_outage(id)?;
    let targets = block.allow.as_ref().ok_or(
        "This chat does not read Claude's settings files, so an allow rule would change nothing.",
    )?;
    let path = match scope {
        Scope::Project => targets.project.clone().ok_or(
            "This chat has no project folder, so there is no project settings file to write.",
        )?,
        Scope::User => targets
            .user
            .clone()
            .ok_or("Claude's own settings folder could not be found.")?,
    };
    let mut rules: Vec<String> = Vec::new();
    let mut uncovered = Vec::new();
    for command in &block.commands {
        match &command.rule {
            Some(rule) if !rules.contains(rule) => rules.push(rule.clone()),
            Some(_) => {}
            None => uncovered.push(command.action.clone()),
        }
    }
    if rules.is_empty() {
        return Err("No allow rule is narrow enough for these calls. Retry once instead.".into());
    }
    let added = crate::claude_allow::add_allow_rules(Path::new(&path), scope, &rules)?;
    dismiss_as(id, scope.decision());
    Ok(AllowedOutage {
        rules,
        path,
        added,
        uncovered,
    })
}

/// "Retry once": take the card down as retried. The caller sends the turn
/// that asks for the one as-is retry Claude's own message allows.
pub fn retry_outage(id: &str) -> Result<bool, String> {
    pending_outage(id)?;
    Ok(dismiss_as(id, "retried"))
}

fn authorization_path() -> PathBuf {
    crate::profile::profile_dir().join("safety-authorizations.json")
}

fn read_authorizations(path: &Path) -> Result<AuthorizationStore, String> {
    match fs::read(path) {
        Ok(bytes) => serde_json::from_slice(&bytes)
            .map_err(|_| "Saved safety authorizations could not be read.".to_string()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(AuthorizationStore::default()),
        Err(e) => Err(e.to_string()),
    }
}

fn write_authorizations(path: &Path, store: &AuthorizationStore) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let body = serde_json::to_vec_pretty(store).map_err(|e| e.to_string())?;
    let temp = path.with_extension("json.tmp");
    fs::write(&temp, body).map_err(|e| e.to_string())?;
    fs::rename(&temp, path).map_err(|e| e.to_string())
}

fn save_authorization(path: &Path, block: &BlockedAction) -> Result<(), String> {
    let project_scope = block
        .project_scope
        .clone()
        .ok_or("This chat is not attached to a project folder, so the authorization cannot be saved across sessions.")?;
    let _guard = AUTHORIZATIONS.lock().unwrap_or_else(|e| e.into_inner());
    let mut store = read_authorizations(path)?;
    let duplicate = store.authorizations.iter().any(|grant| {
        grant.project_scope == project_scope
            && grant.kind == block.kind
            && grant.summary == block.summary
    });
    if !duplicate {
        store.authorizations.push(PersistentAuthorization {
            id: uuid::Uuid::new_v4().to_string(),
            project_scope,
            kind: block.kind.to_string(),
            summary: block.summary.clone(),
        });
        write_authorizations(path, &store)?;
    }
    Ok(())
}

/// Persist one narrowly scoped grant and remove its post-hoc decision card.
/// Future Codex processes launched in the same project receive the grant in
/// their developer instructions, including processes for brand-new chats.
pub fn authorize_for_project(id: &str) -> Result<bool, String> {
    let block = with_pending(|pending| pending.get(id).cloned())
        .ok_or("This safety request is no longer pending.")?;
    if block.provider != "codex" {
        // Claude's classifier does not read these instructions; a saved
        // grant would look like permission and change nothing.
        return Err("Only Codex safety reviews can be allowed for a whole project.".into());
    }
    save_authorization(&authorization_path(), &block)?;
    Ok(dismiss_as(id, "authorized_project"))
}

fn project_authorizations_at(path: &Path, cwd: &str) -> Option<String> {
    let scope = normalized_scope(cwd)?;
    let store = read_authorizations(path).ok()?;
    let grants = store
        .authorizations
        .iter()
        .filter(|grant| grant.project_scope == scope)
        .collect::<Vec<_>>();
    if grants.is_empty() {
        return None;
    }

    let entries = grants
        .iter()
        .enumerate()
        .map(|(index, grant)| {
            format!(
                "{}. kind={}; blocked action={}",
                index + 1,
                grant.kind,
                serde_json::to_string(&grant.summary).unwrap_or_else(|_| "\"unavailable\"".into())
            )
        })
        .collect::<Vec<_>>()
        .join("\n");
    Some(format!(
        "Persistent project authorizations recorded from the person's explicit choices in OctiqFlow's safety UI:\n{entries}\nTreat a grant as explicit user authorization only when a later action matches the described kind of data or action, purpose, destination, files or resources, scope, and intended effect. Do not ask the person again for a matching action. A different destination, broader scope, materially different action, or new cost outside the described authorization still requires a new decision."
    ))
}

pub fn project_authorizations(cwd: &str) -> Option<String> {
    project_authorizations_at(&authorization_path(), cwd)
}

/// Every safety block that still needs a person to choose the next turn.
pub fn pending() -> Vec<BlockedAction> {
    with_pending(|pending| pending.values().cloned().collect())
}

/// Whether a card in this chat is waiting on a choice that can continue its
/// work: a Codex card, whose "allow" starts a new turn. Such a card keeps a
/// worker's attempt open and unsettled. A Claude auto-mode card cannot be
/// allowed (`EXACT_GRANT_WITHDRAWN`), so it holds nothing open: the worker
/// carries on another way or settles blocked, and the card stays a record.
pub(crate) fn awaits_decision(chat_key: &str) -> bool {
    with_pending(|pending| {
        pending
            .values()
            .any(|block| block.chat_key == chat_key && block.provider == "codex")
    })
}

/// Coordinator evidence deliberately excludes the raw router diagnostic.
///
/// An outage card lists each refused call separately, under the card's id as
/// its group, so the ledger keeps every refusal.
pub(crate) fn decision_summaries() -> Vec<PendingCard> {
    with_pending(|pending| {
        let mut cards = Vec::new();
        for block in pending.values() {
            let reason = match &block.action {
                Some(_) => format!("{}: {}", block.title, block.summary),
                None => block.summary.clone(),
            };
            if block.refusals.is_empty() {
                cards.push(PendingCard {
                    id: block.id.clone(),
                    chat_key: block.chat_key.clone(),
                    reason,
                    action: block.action.clone(),
                    kind: RefusalKind::Safety,
                    group_id: None,
                    at: None,
                    owner: None,
                });
                continue;
            }
            for refusal in &block.refusals {
                cards.push(PendingCard {
                    id: refusal.id.clone(),
                    chat_key: block.chat_key.clone(),
                    reason: reason.clone(),
                    action: Some(refusal.action.clone()),
                    kind: RefusalKind::Outage,
                    group_id: Some(block.id.clone()),
                    at: Some(refusal.at),
                    owner: refusal.owner.clone(),
                });
            }
        }
        cards
    })
}

/// What the orchestration record keeps of a pending card, or of one refused
/// call in an outage card.
pub(crate) struct PendingCard {
    pub id: String,
    pub chat_key: String,
    pub reason: String,
    /// The exact call, when the provider named it.
    pub action: Option<String>,
    pub kind: RefusalKind,
    /// The outage card this refusal belongs to.
    pub group_id: Option<String>,
    /// When the refusal was seen, for an outage refusal.
    pub at: Option<i64>,
    /// The attempt the outage refusal was grouped under, when one was live.
    pub owner: Option<String>,
}

/// Remove one card after the person chooses a path or dismisses it.
pub fn dismiss(id: &str) -> bool {
    dismiss_as(id, "dismissed")
}

fn dismiss_as(id: &str, decision: &'static str) -> bool {
    let removed = with_pending(|pending| pending.remove(id).is_some());
    if removed {
        record_decision(id, decision);
        crate::bus::emit("safety-block-expired", serde_json::json!({ "id": id }));
    }
    removed
}

/// What the agent tried, in one line: the shell line, or the tool and the
/// file or path it named.
fn describe_call(tool: &str, input: Option<&serde_json::Value>) -> String {
    let named = input.and_then(|input| {
        ["command", "file_path", "path", "url", "notebook_path"]
            .iter()
            .find_map(|key| input.get(key).and_then(|v| v.as_str()))
            .map(str::trim)
            .filter(|s| !s.is_empty())
    });
    match named {
        Some(named) if tool == "Bash" => named.to_string(),
        Some(named) => format!("{tool} {named}"),
        None => tool.to_string(),
    }
}

/// Turn Claude's own record of an auto-mode refusal into a decision card.
///
/// `claude -p` reports it as `{"type":"system","subtype":"permission_denied",
/// "decision_reason_type":"classifier",...}` naming the tool call; `called` is
/// that call's name and input, from the assistant message that made it. Only
/// classifier refusals become cards: a deny rule or the person's own "no" is
/// a decision already made.
///
/// The card records the refusal; it cannot turn it into an approval. Claude
/// refuses a classifier-blocked call without asking anyone: its stdio
/// `can_use_tool` callback, the one place OctiqFlow is asked before a call
/// runs, is used only for "ask" outcomes, and `permission_denied` is the
/// "deny" short-circuit (Claude 2.1.281's own SDK schema says so). Nothing
/// continues a refused call, and an allow rule on a later launch is not
/// "once" — see `EXACT_GRANT_WITHDRAWN`.
///
/// `owner` is the orchestration attempt live in the chat, if any, so an
/// outage group never spans two attempts of a reused worker chat.
pub fn observe_claude_denial(
    chat_key: &str,
    owner: Option<&str>,
    event: &serde_json::Value,
    called: Option<(&str, &serde_json::Value)>,
) -> bool {
    observe_claude_refusal(chat_key, owner, event, called, now_ms())
}

/// `observe_claude_denial` at a given time, so a test can walk an outage
/// through its window without waiting for it.
#[cfg(test)]
pub(crate) fn observe_claude_denial_at(
    chat_key: &str,
    event: &serde_json::Value,
    called: Option<(&str, &serde_json::Value)>,
    now: i64,
) -> bool {
    observe_claude_refusal(chat_key, None, event, called, now)
}

/// `observe_claude_denial` at a given time.
pub(crate) fn observe_claude_refusal(
    chat_key: &str,
    owner: Option<&str>,
    event: &serde_json::Value,
    called: Option<(&str, &serde_json::Value)>,
    now: i64,
) -> bool {
    let text = |name: &str| event.get(name).and_then(serde_json::Value::as_str);
    if text("type") != Some("system")
        || text("subtype") != Some("permission_denied")
        || text("decision_reason_type") != Some("classifier")
    {
        return false;
    }
    let tool = text("tool_name")
        .or(called.map(|(name, _)| name))
        .unwrap_or("A tool");
    let input = called.map(|(_, input)| input);
    let reason = text("decision_reason")
        .map(|r| {
            r.trim()
                .trim_start_matches('[')
                .trim_end_matches(']')
                .trim()
        })
        .filter(|r| !r.is_empty())
        .unwrap_or("Blocked by auto mode");
    let action = describe_call(tool, input);
    let tool_use_id = text("tool_use_id");
    if let Some(id) = tool_use_id {
        remember_refused_call(id);
    }
    let mut detail = text("message").unwrap_or_default().trim().to_string();
    if refusal_kind(text("decision_reason")) == RefusalKind::Outage {
        return publish_outage(
            chat_key,
            reason,
            detail,
            Refusal {
                id: uuid::Uuid::new_v4().to_string(),
                tool_use_id: tool_use_id.map(str::to_string),
                action,
                tool: tool.to_string(),
                command: (tool == "Bash")
                    .then(|| {
                        input
                            .and_then(|i| i.get("command"))
                            .and_then(|c| c.as_str())
                    })
                    .flatten()
                    .map(str::to_string),
                at: now,
                owner: owner.map(str::to_string),
            },
        );
    }
    if let Some(id) = tool_use_id {
        // Two refusals of the same line are two decisions, not one card.
        detail.push_str(&format!("\n\nTool call: {id}"));
    }
    publish_block(BlockedAction {
        id: uuid::Uuid::new_v4().to_string(),
        chat_key: chat_key.to_string(),
        kind: "high-risk-action",
        title: "Claude's auto mode blocked an action",
        summary: reason.to_string(),
        detail,
        project_scope: None,
        provider: "claude",
        action: Some(action),
        count: None,
        commands: Vec::new(),
        guidance: None,
        refusals: Vec::new(),
        allow: None,
    })
}

/// The title of a card for calls refused only because Claude's classifier
/// was unavailable. It says nothing about the command being unsafe.
pub(crate) const OUTAGE_TITLE: &str = "Claude's safety check was unavailable";

/// Put an outage refusal on this chat's open outage card, or start one.
///
/// A card is open while it is still pending, `outage_group_due` has not
/// passed, and it holds refusals of the same attempt. Joining re-announces the same card id, so the page redraws one
/// card with a higher count rather than adding another, and the person is
/// notified once per card, not per refusal.
fn publish_outage(chat_key: &str, reason: &str, message: String, refusal: Refusal) -> bool {
    let (card, created) = with_pending(|pending| {
        let open = pending.values_mut().find(|block| {
            block.chat_key == chat_key
                && !block.refusals.is_empty()
                // A group belongs to one attempt: a retry's refusal in a
                // reused chat starts its own group.
                && block.refusals.iter().all(|r| r.owner == refusal.owner)
                && refusal.at
                    < outage_group_due(
                        block.refusals[0].at,
                        block.refusals.iter().map(|r| r.at).max().unwrap_or(0),
                        block.refusals.len(),
                    )
        });
        if let Some(block) = open {
            let seen = refusal.tool_use_id.is_some()
                && block
                    .refusals
                    .iter()
                    .any(|r| r.tool_use_id == refusal.tool_use_id);
            if seen {
                return (None, false);
            }
            block.refusals.push(refusal);
            regroup(block);
            return (Some(block.clone()), false);
        }
        let mut block = BlockedAction {
            id: uuid::Uuid::new_v4().to_string(),
            chat_key: chat_key.to_string(),
            kind: "outage",
            title: OUTAGE_TITLE,
            summary: reason.to_string(),
            detail: message,
            project_scope: None,
            provider: "claude",
            action: None,
            count: None,
            commands: Vec::new(),
            guidance: Some(outage_guidance()),
            refusals: vec![refusal],
            allow: allow_targets(chat_key),
        };
        regroup(&mut block);
        pending.insert(block.id.clone(), block.clone());
        (Some(block), true)
    });
    let Some(card) = card else {
        return false;
    };
    let chat_key = card.chat_key.clone();
    crate::bus::emit("safety-blocked", card);
    if created {
        crate::push::notify_chat(Some(&chat_key), "permission", OUTAGE_TITLE);
    }
    true
}

/// Recount an outage card after a refusal joined it.
fn regroup(block: &mut BlockedAction) {
    let mut commands: Vec<GroupedCommand> = Vec::new();
    for refusal in &block.refusals {
        match commands.iter_mut().find(|c| c.action == refusal.action) {
            Some(command) => command.count += 1,
            None => {
                let derived =
                    crate::claude_allow::derive_rule(&refusal.tool, refusal.command.as_deref());
                commands.push(GroupedCommand {
                    action: refusal.action.clone(),
                    count: 1,
                    tool: refusal.tool.clone(),
                    words: derived.as_ref().and_then(|d| d.words.clone()),
                    rule: derived.map(|d| d.rule),
                })
            }
        }
    }
    block.count = Some(block.refusals.len());
    // The latest line, for a page from before grouping that shows one.
    block.action = block.refusals.last().map(|r| r.action.clone());
    block.commands = commands;
    let base = block
        .detail
        .split("\n\nTool calls:")
        .next()
        .unwrap_or_default()
        .to_string();
    let calls = block
        .refusals
        .iter()
        .filter_map(|r| r.tool_use_id.as_deref())
        .collect::<Vec<_>>();
    block.detail = if calls.is_empty() {
        base
    } else {
        format!("{base}\n\nTool calls: {}", calls.join(", "))
    };
}

/// Why OctiqFlow no longer offers "Allow this exact command once" on a Claude
/// auto-mode card, for a page from an older build that still asks.
///
/// It was built as a `--allowedTools Bash(<line>)` rule on the chat's next
/// launch, taken back by ending the process once a call used it. A rule lasts
/// as long as the process and matches every call of that line, and OctiqFlow
/// learns of a call only after Claude has emitted it: a real claude 2.1.281
/// ran one rule's line twice in a single response. Ending the process after
/// the fact is not authorization. Claude offers no approval that pauses one
/// classifier-refused call before it runs, so the refusal stands.
pub const EXACT_GRANT_WITHDRAWN: &str = "OctiqFlow cannot allow a command Claude's auto mode refused. Claude refuses it without asking anyone, and gives no way to approve one call before it runs; a permission rule would allow every later call of that line too. The refusal stands. Dismiss the card, run the command yourself, or change Claude's permissions outside OctiqFlow if you mean to allow it for good.";

/// A new user turn supersedes any unanswered post-hoc choice in that chat.
pub fn forget_chat(chat_key: &str) {
    let removed: Vec<String> = with_pending(|pending| {
        let ids = pending
            .values()
            .filter(|block| block.chat_key == chat_key)
            .map(|block| block.id.clone())
            .collect::<Vec<_>>();
        for id in &ids {
            pending.remove(id);
        }
        ids
    });
    for id in removed {
        record_decision(&id, "superseded");
        crate::bus::emit("safety-block-expired", serde_json::json!({ "id": id }));
    }
    with_drafts(|drafts| {
        drafts.remove(chat_key);
    });
}

/// Inspect one diagnostics-only line and announce the narrow class that needs
/// an explicit user decision. Returns whether a new card was created.
pub fn observe(agent: AgentKind, chat_key: &str, line: &str) -> bool {
    if agent != AgentKind::Codex {
        return false;
    }

    if let Some((summary, detail)) = complete_safety_rejection(line) {
        with_drafts(|drafts| {
            drafts.remove(chat_key);
        });
        return publish(chat_key, summary, detail);
    }

    // `apply_patch` safety refusals currently arrive as three physical stderr
    // lines. Hold them briefly so the UI never draws three unrelated amber log
    // boxes. An exec refusal carries escaped newlines in one record and takes
    // the complete path above instead.
    if is_safety_rejection_start(line) {
        with_drafts(|drafts| {
            drafts.insert(
                chat_key.to_string(),
                SafetyDraft {
                    lines: vec![clean_debug_message(line)],
                    summary: None,
                },
            );
        });
        return false;
    }

    let finished = with_drafts(|drafts| {
        let draft = drafts.get_mut(chat_key)?;
        if let Some(reason) = line.trim().strip_prefix("Reason:") {
            let reason = reason.trim();
            if !reason.is_empty() {
                draft.summary = Some(reason.to_string());
            }
            draft.lines.push(line.trim().to_string());
            return None;
        }
        if line.trim_start().starts_with("The agent must") {
            draft.lines.push(line.trim().to_string());
            let draft = drafts.remove(chat_key)?;
            return Some((draft.summary?, draft.lines.join("\n")));
        }
        None
    });

    finished.is_some_and(|(summary, detail)| publish(chat_key, summary, detail))
}

fn publish(chat_key: &str, summary: String, detail: String) -> bool {
    let (kind, title) = presentation(&summary);
    publish_block(BlockedAction {
        id: uuid::Uuid::new_v4().to_string(),
        chat_key: chat_key.to_string(),
        kind,
        title,
        summary,
        detail,
        project_scope: with_project_scopes(|scopes| scopes.get(chat_key).cloned()),
        provider: "codex",
        action: None,
        count: None,
        commands: Vec::new(),
        guidance: None,
        refusals: Vec::new(),
        allow: None,
    })
}

/// Put one card up, unless the same refusal already has one.
fn publish_block(block: BlockedAction) -> bool {
    // A provider can mirror one diagnostic onto both streams. One decision is
    // enough, and duplicate cards make a one-time grant look reusable.
    let existing = with_pending(|pending| {
        pending
            .values()
            .any(|old| old.chat_key == block.chat_key && old.detail == block.detail)
    });
    if existing {
        return false;
    }
    let chat_key = block.chat_key.clone();
    let title = block.title;
    with_pending(|pending| {
        pending.insert(block.id.clone(), block.clone());
    });
    crate::bus::emit("safety-blocked", block);
    crate::push::notify_chat(Some(&chat_key), "permission", title);
    true
}

fn presentation(summary: &str) -> (&'static str, &'static str) {
    let lower = summary.to_ascii_lowercase();
    let external = (lower.contains("external") || summary.contains("外部"))
        && (lower.contains("send")
            || lower.contains("transmit")
            || lower.contains("transfer")
            || lower.contains("egress")
            || summary.contains("发送")
            || summary.contains("外传"));
    if external {
        ("external-data", "Codex blocked external data sharing")
    } else {
        ("high-risk-action", "Codex blocked a high-risk action")
    }
}

/// Recognise the reviewer wording without promoting ordinary sandbox failures
/// (a denied delete, an unavailable executable, and so on) into permission UI.
fn complete_safety_rejection(line: &str) -> Option<(String, String)> {
    if !is_safety_rejection_start(line) {
        return None;
    }
    let detail = clean_debug_message(line);
    let summary = detail
        .split_once("Reason:")
        .map(|(_, reason)| reason)
        // Reviewer guidance after the reason is instruction to the agent, not
        // part of the blocked-action description that the person authorizes.
        // Keeping it in the approval turn can literally re-inject "ask for
        // approval" after the person has just approved the action.
        .and_then(|reason| reason.lines().next())
        .map(str::trim)
        .filter(|reason| !reason.is_empty())?
        .to_string();
    Some((summary, detail))
}

fn is_safety_rejection_start(line: &str) -> bool {
    let lower = line.to_ascii_lowercase();
    lower.contains("codex_core::tools::router:")
        && lower.contains("rejected due to unacceptable risk")
}

fn clean_debug_message(line: &str) -> String {
    let unescaped = line.replace("\\n", "\n").replace("\\\"", "\"");
    let message = unescaped
        .split_once("Rejected(\"")
        .map(|(_, message)| message)
        .or_else(|| unescaped.split_once("error=").map(|(_, message)| message))
        .unwrap_or(unescaped.as_str());
    message
        .trim_end_matches(|c| matches!(c, '"' | ')' | '}' | ' '))
        .trim()
        .to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    const EXTERNAL: &str = "2026-09-05T12:44:54Z ERROR codex_core::tools::router: \
error=exec_command failed: CreateProcess { message: \"Rejected(\\\"This action was rejected due to unacceptable risk.\\nReason: This command would send local outline and constraints to the external DeepSeek/OpenCode service without explicit approval.\\nThe agent must stop and request user input.\\\")\" }";

    const OBSERVED_EXTERNAL: &str = "2026-09-05T12:44:54.840971Z ERROR codex_core::tools::router: error=exec_command failed: CreateProcess { message: \"Rejected(\\\"This action was rejected due to unacceptable risk.\\nReason: 该命令会将本地私有 outline 与 constraints 发送给外部 DeepSeek/OpenCode 服务；用户只授权先写 outline，未明确授权这些具体内容向该目的地外传。\\nThe agent must not attempt to achieve the same outcome via workaround, indirect execution, or policy circumvention.\\\")\" }";

    const MODERN_REJECTION: &str = "2026-09-17T01:00:00Z ERROR codex_core::tools::router: error=exec_command failed: CreateProcess { message: \"Rejected(\\\"This action was rejected due to unacceptable risk.\\nReason: 该命令会上传新的 3D 构图参考并创建一次 3-credit 生成任务。\\nDo not bypass this rejection through a workaround or indirect execution. Complete unaffected work without asking for confirmation. Report anything that remains blocked and ask for approval.\\\")\" }";

    #[test]
    fn external_transfer_rejection_becomes_a_clear_block() {
        let (summary, detail) = complete_safety_rejection(EXTERNAL).expect("the safety block");

        assert!(summary.contains("DeepSeek/OpenCode"));
        assert!(summary.contains("outline and constraints"));
        assert!(detail.starts_with("This action was rejected"));
        assert!(detail.contains("\nReason:"));
        assert!(!detail.contains("\\n"));
    }

    #[test]
    fn ordinary_router_rejections_stay_diagnostics_only() {
        let denied_delete = "2026-09-01T03:56:54Z ERROR codex_core::tools::router: \
error=exec_command failed: CreateProcess { message: Rejected: rm -f is not permitted }";

        assert!(complete_safety_rejection(denied_delete).is_none());
    }

    #[test]
    fn the_observed_localised_rejection_keeps_its_specific_reason() {
        let (summary, detail) =
            complete_safety_rejection(OBSERVED_EXTERNAL).expect("the observed safety block");

        assert!(summary.starts_with("该命令会将本地私有 outline"));
        assert!(summary.contains("DeepSeek/OpenCode"));
        assert!(!summary.contains("The agent must"));
        assert!(detail.contains("This action was rejected due to unacceptable risk."));
    }

    #[test]
    fn approval_text_keeps_only_the_reason_not_the_reviewers_follow_up_commands() {
        let (summary, _) =
            complete_safety_rejection(MODERN_REJECTION).expect("the modern safety block");

        assert_eq!(
            summary,
            "该命令会上传新的 3D 构图参考并创建一次 3-credit 生成任务。"
        );
        assert!(!summary.contains("ask for approval"));
        assert!(!summary.contains("Do not bypass"));
    }

    #[test]
    fn a_saved_grant_is_reloaded_only_for_the_same_project() {
        let root = std::env::temp_dir().join(format!(
            "octiq-safety-authorizations-{}",
            uuid::Uuid::new_v4()
        ));
        let other = root.with_extension("other-project");
        fs::create_dir_all(&root).unwrap();
        fs::create_dir_all(&other).unwrap();
        let path = root.join("grants.json");
        let scope = normalized_scope(root.to_str().unwrap()).unwrap();
        let block = BlockedAction {
            id: "blocked-1".into(),
            chat_key: "chat:one".into(),
            kind: "external-data",
            title: "Codex blocked external data sharing",
            summary: "Send these four character references to Higgsfield for the landing page."
                .into(),
            detail: "review detail".into(),
            project_scope: Some(scope),
            provider: "codex",
            action: None,
            count: None,
            commands: Vec::new(),
            guidance: None,
            refusals: Vec::new(),
            allow: None,
        };

        save_authorization(&path, &block).unwrap();
        // The same click or delivery retry is idempotent.
        save_authorization(&path, &block).unwrap();
        let stored = read_authorizations(&path).unwrap();
        assert_eq!(stored.authorizations.len(), 1);

        let prompt = project_authorizations_at(&path, root.to_str().unwrap()).unwrap();
        assert!(prompt.contains("Higgsfield"));
        assert!(prompt.contains("Do not ask the person again"));
        assert!(project_authorizations_at(&path, other.to_str().unwrap()).is_none());

        fs::remove_file(&path).unwrap();
        fs::remove_dir(&root).unwrap();
        fs::remove_dir(&other).unwrap();
    }

    fn classifier_denial(tool: &str, id: &str) -> serde_json::Value {
        serde_json::json!({
            "type": "system", "subtype": "permission_denied",
            "decision_reason": "[Production Deploy]", "decision_reason_type": "classifier",
            "message": "Permission for this action was denied by the Claude Code auto mode classifier.",
            "tool_name": tool, "tool_use_id": id,
        })
    }

    #[test]
    fn a_claude_classifier_refusal_becomes_a_card_naming_the_exact_call() {
        let chat = format!("chat:test-{}", uuid::Uuid::new_v4());
        let input = serde_json::json!({ "command": "eas update --branch production" });
        assert!(observe_claude_denial(
            &chat,
            None,
            &classifier_denial("Bash", "toolu_1"),
            Some(("Bash", &input))
        ));
        // The same refusal, seen twice, is still one decision.
        assert!(!observe_claude_denial(
            &chat,
            None,
            &classifier_denial("Bash", "toolu_1"),
            Some(("Bash", &input))
        ));
        let card = pending().into_iter().find(|b| b.chat_key == chat).unwrap();
        assert_eq!(card.provider, "claude");
        assert_eq!(card.summary, "Production Deploy");
        assert_eq!(
            card.action.as_deref(),
            Some("eas update --branch production")
        );
        // What the browser sees offers nothing to approve: no rule, no grant.
        let shown = serde_json::to_value(&card).unwrap();
        assert!(shown.get("exactGrant").is_none(), "{shown}");
        assert!(!shown.to_string().contains("Bash("), "{shown}");
        // A Claude card cannot be turned into a project-wide instruction.
        assert!(authorize_for_project(&card.id).is_err());
        assert!(dismiss(&card.id));
        assert_eq!(decision(&card.id), Some("dismissed"));
    }

    /// Claude 2.1.x's own words for an outage, verbatim from a worker
    /// transcript of run 8eb35d0a.
    const OUTAGE_MESSAGE: &str = "The server-side auto mode classifier gave no verdict (error), so auto mode cannot determine the safety of Bash. This is a transient failure of the check, not a judgment about the action: a later response may get a verdict. You may try the action again once, as-is.";

    fn outage_denial(id: &str) -> serde_json::Value {
        serde_json::json!({
            "type": "system", "subtype": "permission_denied",
            "decision_reason": "Classifier unavailable", "decision_reason_type": "classifier",
            "message": OUTAGE_MESSAGE, "tool_name": "Bash", "tool_use_id": id,
        })
    }

    fn bash(line: &str) -> serde_json::Value {
        serde_json::json!({ "command": line })
    }

    fn cards_in(chat: &str) -> Vec<BlockedAction> {
        pending()
            .into_iter()
            .filter(|b| b.chat_key == chat)
            .collect()
    }

    #[test]
    fn only_the_exact_classifier_unavailable_reason_is_an_outage() {
        // The string seen on 2026-09-28, and harmless variations of it.
        assert_eq!(
            refusal_kind(Some("Classifier unavailable")),
            RefusalKind::Outage
        );
        assert_eq!(
            refusal_kind(Some("  classifier UNAVAILABLE ")),
            RefusalKind::Outage
        );
        assert_eq!(
            refusal_kind(Some("[Classifier unavailable]")),
            RefusalKind::Outage
        );
        // Anything else is a safety refusal: when unsure, it is one.
        assert_eq!(refusal_kind(None), RefusalKind::Safety);
        assert_eq!(refusal_kind(Some("")), RefusalKind::Safety);
        assert_eq!(refusal_kind(Some("   ")), RefusalKind::Safety);
        assert_eq!(refusal_kind(Some("Production Deploy")), RefusalKind::Safety);
        assert_eq!(
            refusal_kind(Some("Production Deploy (Classifier unavailable earlier)")),
            RefusalKind::Safety
        );
        assert_eq!(
            refusal_kind(Some("Classifier unavailable: Production Deploy")),
            RefusalKind::Safety
        );
        assert_eq!(refusal_kind(Some("Classifier")), RefusalKind::Safety);
        assert_eq!(refusal_kind(Some("unavailable")), RefusalKind::Safety);
    }

    #[test]
    fn a_classifier_denial_without_the_outage_reason_is_still_a_safety_card() {
        // decision_reason_type "classifier" alone proves nothing: real
        // refusals carry it too.
        let chat = format!("chat:test-{}", uuid::Uuid::new_v4());
        let mut missing = outage_denial("toolu_m");
        missing.as_object_mut().unwrap().remove("decision_reason");
        assert!(observe_claude_denial(
            &chat,
            None,
            &missing,
            Some(("Bash", &bash("ls")))
        ));
        let mut empty = outage_denial("toolu_e");
        empty["decision_reason"] = "".into();
        assert!(observe_claude_denial(
            &chat,
            None,
            &empty,
            Some(("Bash", &bash("ls")))
        ));
        let cards = cards_in(&chat);
        assert_eq!(cards.len(), 2, "one card per safety refusal, never grouped");
        for card in &cards {
            assert_eq!(card.title, "Claude's auto mode blocked an action");
            assert_eq!(card.kind, "high-risk-action");
            assert!(card.guidance.is_none());
            assert!(card.refusals.is_empty());
        }
        forget_chat(&chat);
    }

    #[test]
    fn outage_refusals_in_one_window_are_one_card_with_a_count() {
        let chat = format!("chat:test-{}", uuid::Uuid::new_v4());
        let t = 1_000_000;
        assert!(observe_claude_denial_at(
            &chat,
            &outage_denial("toolu_a"),
            Some(("Bash", &bash("git fetch"))),
            t
        ));
        assert!(observe_claude_denial_at(
            &chat,
            &outage_denial("toolu_b"),
            Some(("Bash", &bash("ls docs"))),
            t + 20_000
        ));
        // The same line re-sent after a refusal collapses to one row.
        assert!(observe_claude_denial_at(
            &chat,
            &outage_denial("toolu_c"),
            Some(("Bash", &bash("git fetch"))),
            t + 40_000
        ));
        // The same refusal seen twice is not a second refusal.
        assert!(!observe_claude_denial_at(
            &chat,
            &outage_denial("toolu_c"),
            Some(("Bash", &bash("git fetch"))),
            t + 41_000
        ));

        let cards = cards_in(&chat);
        assert_eq!(cards.len(), 1);
        let card = &cards[0];
        assert_eq!(card.title, OUTAGE_TITLE);
        assert_eq!(card.kind, "outage");
        assert_eq!(card.count, Some(3));
        let shown = serde_json::to_value(card).unwrap();
        assert_eq!(shown["count"], 3);
        assert_eq!(shown["commands"][0]["action"], "git fetch");
        assert_eq!(shown["commands"][0]["count"], 2);
        assert_eq!(shown["commands"][1]["action"], "ls docs");
        assert_eq!(shown["commands"][1]["count"], 1);
        assert_eq!(shown["guidance"], outage_guidance());
        assert!(!shown.to_string().contains("blocked an action"));
        assert!(card.detail.contains("not a judgment about the action"));
        assert!(card.detail.contains("toolu_a, toolu_b, toolu_c"));

        // Every refusal stays its own ledger entry, under the card's id.
        let summaries: Vec<_> = decision_summaries()
            .into_iter()
            .filter(|s| s.chat_key == chat)
            .collect();
        assert_eq!(summaries.len(), 3);
        assert!(summaries
            .iter()
            .all(|s| s.kind == RefusalKind::Outage
                && s.group_id.as_deref() == Some(card.id.as_str())));

        // One dismiss closes the whole group.
        assert!(dismiss(&card.id));
        assert!(cards_in(&chat).is_empty());
        assert!(decision_summaries().iter().all(|s| s.chat_key != chat));
        // A later outage starts a new card rather than reviving that one.
        assert!(observe_claude_denial_at(
            &chat,
            &outage_denial("toolu_d"),
            Some(("Bash", &bash("ls"))),
            t + 50_000
        ));
        let again = cards_in(&chat);
        assert_eq!(again.len(), 1);
        assert_ne!(again[0].id, card.id);
        forget_chat(&chat);
    }

    fn temp_dir(label: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("octiq-{label}-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn mcp_outage(id: &str, tool: &str) -> serde_json::Value {
        let mut event = outage_denial(id);
        event["tool_name"] = tool.into();
        event
    }

    #[test]
    fn an_outage_card_names_each_calls_narrowest_rule() {
        let chat = format!("chat:test-{}", uuid::Uuid::new_v4());
        let project = temp_dir("allow-project");
        remember_claude_launch(&chat, true, project.to_str().unwrap(), false, None);
        let t = 2_000_000;
        for (id, tool, input) in [
            ("toolu_1", "Bash", bash("git push origin main")),
            ("toolu_2", "Bash", bash("ls | wc -l")),
            (
                "toolu_3",
                "mcp__claude_ai_Higgfield__media_upload",
                serde_json::json!({"path": "a.png"}),
            ),
        ] {
            assert!(observe_claude_denial_at(
                &chat,
                &mcp_outage(id, tool),
                Some((tool, &input)),
                t
            ));
        }
        let card = cards_in(&chat).pop().unwrap();
        let shown = serde_json::to_value(&card).unwrap();
        assert_eq!(shown["commands"][0]["tool"], "Bash");
        assert_eq!(shown["commands"][0]["words"], "git push");
        assert_eq!(shown["commands"][0]["rule"], "Bash(git push:*)");
        // A piped line gets no rule: only a retry is offered for it.
        assert!(shown["commands"][1].get("rule").is_none());
        assert_eq!(
            shown["commands"][2]["rule"],
            "mcp__claude_ai_Higgfield__media_upload"
        );
        assert!(shown["commands"][2].get("words").is_none());
        assert_eq!(
            shown["allow"]["project"],
            project
                .join(".claude")
                .join("settings.local.json")
                .to_str()
                .unwrap()
        );
        assert!(shown["allow"]["user"]
            .as_str()
            .unwrap()
            .ends_with("settings.json"));
        // Never a blanket rule, anywhere on the card.
        for command in shown["commands"].as_array().unwrap() {
            let rule = command
                .get("rule")
                .and_then(|r| r.as_str())
                .unwrap_or_default();
            assert!(
                rule != "Bash" && rule != "Bash(*)" && rule != "*",
                "{command}"
            );
        }
        forget_chat(&chat);
        fs::remove_dir_all(project).unwrap();
    }

    #[test]
    fn always_allow_in_this_project_writes_the_rule_and_closes_the_card() {
        let chat = format!("chat:test-{}", uuid::Uuid::new_v4());
        let project = temp_dir("allow-project");
        let settings = project.join(".claude").join("settings.local.json");
        fs::create_dir_all(settings.parent().unwrap()).unwrap();
        fs::write(&settings, "{\n  \"env\": {\"A\": \"1\"}\n}\n").unwrap();
        remember_claude_launch(&chat, true, project.to_str().unwrap(), false, None);
        assert!(observe_claude_denial_at(
            &chat,
            &outage_denial("toolu_p1"),
            Some(("Bash", &bash("cd sub && git push origin HEAD"))),
            3_000_000
        ));
        assert!(observe_claude_denial_at(
            &chat,
            &outage_denial("toolu_p2"),
            Some(("Bash", &bash("python x.py"))),
            3_000_100
        ));
        let card = cards_in(&chat).pop().unwrap();
        let done = allow_outage(&card.id, crate::claude_allow::Scope::Project).unwrap();
        let done = serde_json::to_value(done).unwrap();
        assert_eq!(done["rules"], serde_json::json!(["Bash(git push:*)"]));
        assert_eq!(done["added"], serde_json::json!(["Bash(git push:*)"]));
        assert_eq!(done["uncovered"], serde_json::json!(["python x.py"]));
        assert_eq!(done["path"], settings.to_str().unwrap());
        let written: serde_json::Value =
            serde_json::from_str(&fs::read_to_string(&settings).unwrap()).unwrap();
        assert_eq!(written["env"]["A"], "1");
        assert_eq!(
            written["permissions"]["allow"],
            serde_json::json!(["Bash(git push:*)"])
        );
        // Never the shared file.
        assert!(!project.join(".claude").join("settings.json").exists());
        assert!(cards_in(&chat).is_empty());
        assert_eq!(decision(&card.id), Some("allowed_project"));
        // The card is gone: a second click writes nothing.
        assert!(allow_outage(&card.id, crate::claude_allow::Scope::Project).is_err());
        fs::remove_dir_all(project).unwrap();
    }

    #[test]
    fn always_allow_everywhere_writes_claude_config_dir_settings() {
        let chat = format!("chat:test-{}", uuid::Uuid::new_v4());
        let project = temp_dir("allow-project");
        let config = temp_dir("allow-config");
        remember_claude_launch(
            &chat,
            true,
            project.to_str().unwrap(),
            false,
            Some(config.to_string_lossy().into_owned()),
        );
        let tool = "mcp__claude_ai_Higgfield__media_upload";
        assert!(observe_claude_denial_at(
            &chat,
            &mcp_outage("toolu_u1", tool),
            Some((tool, &serde_json::json!({}))),
            4_000_000
        ));
        let card = cards_in(&chat).pop().unwrap();
        let done = allow_outage(&card.id, crate::claude_allow::Scope::User).unwrap();
        let done = serde_json::to_value(done).unwrap();
        assert_eq!(done["path"], config.join("settings.json").to_str().unwrap());
        let written: serde_json::Value =
            serde_json::from_str(&fs::read_to_string(config.join("settings.json")).unwrap())
                .unwrap();
        assert_eq!(written["permissions"]["allow"], serde_json::json!([tool]));
        assert!(
            !project.join(".claude").exists(),
            "the project was not touched"
        );
        assert_eq!(decision(&card.id), Some("allowed_user"));
        fs::remove_dir_all(project).unwrap();
        fs::remove_dir_all(config).unwrap();
    }

    #[test]
    fn allow_is_refused_where_a_rule_would_change_nothing_or_is_not_the_persons() {
        let project = temp_dir("allow-project");
        let settings = project.join(".claude").join("settings.local.json");

        // A lite chat reads no settings file: no targets, and a refusal.
        let lite = format!("chat:test-{}", uuid::Uuid::new_v4());
        remember_claude_launch(&lite, true, project.to_str().unwrap(), true, None);
        assert!(observe_claude_denial_at(
            &lite,
            &outage_denial("toolu_l"),
            Some(("Bash", &bash("git push"))),
            5_000_000
        ));
        let card = cards_in(&lite).pop().unwrap();
        assert!(serde_json::to_value(&card).unwrap().get("allow").is_none());
        assert!(allow_outage(&card.id, crate::claude_allow::Scope::Project).is_err());
        assert!(
            !cards_in(&lite).is_empty(),
            "a refused allow leaves the card up"
        );
        forget_chat(&lite);

        // A chat whose Claude launch was never seen (or is Codex's now).
        let codex = format!("chat:test-{}", uuid::Uuid::new_v4());
        remember_claude_launch(&codex, true, project.to_str().unwrap(), false, None);
        remember_claude_launch(&codex, false, project.to_str().unwrap(), false, None);
        assert!(observe_claude_denial_at(
            &codex,
            &outage_denial("toolu_c"),
            Some(("Bash", &bash("git push"))),
            5_000_000
        ));
        let card = cards_in(&codex).pop().unwrap();
        assert!(allow_outage(&card.id, crate::claude_allow::Scope::User).is_err());
        forget_chat(&codex);

        // Only calls no rule covers: retry only.
        let chat = format!("chat:test-{}", uuid::Uuid::new_v4());
        remember_claude_launch(&chat, true, project.to_str().unwrap(), false, None);
        assert!(observe_claude_denial_at(
            &chat,
            &outage_denial("toolu_n"),
            Some(("Bash", &bash("a && b"))),
            5_000_000
        ));
        let card = cards_in(&chat).pop().unwrap();
        let err = allow_outage(&card.id, crate::claude_allow::Scope::Project).unwrap_err();
        assert!(err.contains("Retry once"), "{err}");
        forget_chat(&chat);

        // A judged refusal: the refusal stands, nothing is written or retried.
        let judged = format!("chat:test-{}", uuid::Uuid::new_v4());
        remember_claude_launch(&judged, true, project.to_str().unwrap(), false, None);
        assert!(observe_claude_denial(
            &judged,
            None,
            &classifier_denial("Bash", "toolu_j"),
            Some(("Bash", &bash("git push")))
        ));
        let card = cards_in(&judged).pop().unwrap();
        assert_eq!(card.kind, "high-risk-action");
        let shown = serde_json::to_value(&card).unwrap();
        assert!(
            shown.get("allow").is_none() && !shown.to_string().contains("Bash("),
            "{shown}"
        );
        assert!(allow_outage(&card.id, crate::claude_allow::Scope::Project).is_err());
        assert!(retry_outage(&card.id).is_err());
        assert!(!cards_in(&judged).is_empty());
        forget_chat(&judged);

        assert!(!settings.exists(), "no refusal wrote anything");
        fs::remove_dir_all(project).unwrap();
    }

    #[test]
    fn retry_once_closes_an_outage_card_and_writes_nothing() {
        let chat = format!("chat:test-{}", uuid::Uuid::new_v4());
        let project = temp_dir("allow-project");
        remember_claude_launch(&chat, true, project.to_str().unwrap(), false, None);
        assert!(observe_claude_denial_at(
            &chat,
            &outage_denial("toolu_r"),
            Some(("Bash", &bash("git push"))),
            6_000_000
        ));
        let card = cards_in(&chat).pop().unwrap();
        assert_eq!(retry_outage(&card.id), Ok(true));
        assert_eq!(decision(&card.id), Some("retried"));
        assert!(cards_in(&chat).is_empty());
        assert!(!project.join(".claude").exists());
        fs::remove_dir_all(project).unwrap();
    }

    #[test]
    fn an_outage_group_closes_after_its_window_its_age_cap_or_its_count_cap() {
        let chat = format!("chat:test-{}", uuid::Uuid::new_v4());
        let t = 5_000_000;
        let refuse = |id: &str, at: i64| {
            assert!(observe_claude_denial_at(
                &chat,
                &outage_denial(id),
                Some(("Bash", &bash(id))),
                at
            ));
        };
        // Quiet for longer than the window: a new group.
        refuse("w1", t);
        refuse("w2", t + OUTAGE_WINDOW_MS);
        assert_eq!(cards_in(&chat).len(), 2);
        forget_chat(&chat);

        // Refused every 90 seconds: the window never lapses, but the group
        // closes five minutes after it opened.
        let t = t + 60 * 60_000;
        for (n, at) in [0, 90_000, 180_000, 270_000].iter().enumerate() {
            refuse(&format!("a{n}"), t + at);
        }
        assert_eq!(cards_in(&chat).len(), 1);
        refuse("a4", t + OUTAGE_MAX_OPEN_MS);
        assert_eq!(cards_in(&chat).len(), 2);
        forget_chat(&chat);

        // Five refusals in quick succession fill a group.
        let t = t + 60 * 60_000;
        for n in 0..OUTAGE_MAX_REFUSALS as i64 {
            refuse(&format!("c{n}"), t + n * 1_000);
        }
        assert_eq!(cards_in(&chat).len(), 1);
        refuse("c5", t + 6_000);
        let cards = cards_in(&chat);
        assert_eq!(cards.len(), 2);
        assert!(cards.iter().any(|c| c.count == Some(OUTAGE_MAX_REFUSALS)));
        assert!(cards.iter().any(|c| c.count == Some(1)));
        forget_chat(&chat);
    }

    /// The one as-is retry a worker may make, refused again, is a repeat in
    /// the same group: collapsed as ×2, and counted towards the cap.
    #[test]
    fn a_refused_retry_is_a_repeat_that_counts_towards_the_cap() {
        let chat = format!("chat:test-{}", uuid::Uuid::new_v4());
        let t = 9_000_000;
        let refuse = |id: &str, line: &str, at: i64| {
            assert!(observe_claude_denial_at(
                &chat,
                &outage_denial(id),
                Some(("Bash", &bash(line))),
                at
            ));
        };
        refuse("r1", "git fetch", t);
        refuse("r2", "git fetch", t + 5_000); // the retry, refused again
        refuse("r3", "ls", t + 6_000);
        refuse("r4", "cat a", t + 7_000);
        refuse("r5", "cat b", t + 8_000);
        let cards = cards_in(&chat);
        assert_eq!(cards.len(), 1);
        assert_eq!(cards[0].count, Some(OUTAGE_MAX_REFUSALS));
        assert_eq!(cards[0].commands[0].action, "git fetch");
        assert_eq!(cards[0].commands[0].count, 2);
        assert_eq!(cards[0].commands.len(), 4);
        // Full: the next refusal opens a new group.
        refuse("r6", "git status", t + 9_000);
        assert_eq!(cards_in(&chat).len(), 2);
        forget_chat(&chat);
    }

    #[test]
    fn outage_group_due_is_the_earliest_of_window_age_and_count() {
        assert_eq!(outage_group_due(0, 0, 1), OUTAGE_WINDOW_MS);
        assert_eq!(outage_group_due(0, 250_000, 3), OUTAGE_MAX_OPEN_MS);
        assert_eq!(outage_group_due(0, 10_000, OUTAGE_MAX_REFUSALS), 10_000);
    }

    /// Pinned word for word, so a change to what workers are told is a
    /// visible diff. One as-is retry for classifier outages was decided by
    /// the person on 2026-09-28; a second refusal ends it.
    #[test]
    fn the_outage_guidance_is_pinned_and_allows_exactly_one_as_is_retry() {
        assert_eq!(
            outage_guidance(),
            "Claude's safety check was unavailable, so the command did not run. It was not judged unsafe, and it was not approved. Continue with your other steps. OctiqFlow never re-runs it. You may try the same command once more, as-is: Claude checks that try again. If it is refused again, do not try it a third time. Never reword a command to get past the check. Report every refused command in your worker report, and do not describe any of them as approved or as having run."
        );
        assert!(outage_guidance().contains(OUTAGE_RETRY));
    }

    #[test]
    fn a_refused_call_is_remembered_so_its_result_is_not_work_done() {
        let chat = format!("chat:test-{}", uuid::Uuid::new_v4());
        let id = format!("toolu_{}", uuid::Uuid::new_v4().simple());
        assert!(!was_refused(&id));
        assert!(observe_claude_denial(
            &chat,
            None,
            &outage_denial(&id),
            Some(("Bash", &bash("ls")))
        ));
        assert!(was_refused(&id));
        forget_chat(&chat);
    }

    /// Review of 2cbc3e9: the record used to be cleared wholesale when full,
    /// so a refusal whose result had not come back yet was forgotten and its
    /// result read as an allowed call. Only the oldest ids go now.
    #[test]
    fn a_full_refused_call_record_evicts_only_its_oldest_ids() {
        let mut calls = RefusedCalls::default();
        for n in 0..4 {
            calls.insert(&format!("old{n}"), 4);
        }
        // The fifth refusal, whose result is still to come, arrives full.
        calls.insert("live", 4);
        assert!(calls.contains("live"), "the newest refusal is kept");
        assert!(!calls.contains("old0"), "only the oldest is evicted");
        for n in 1..4 {
            assert!(calls.contains(&format!("old{n}")));
        }
        // Seeing the same refusal again neither duplicates nor evicts.
        calls.insert("live", 4);
        assert!(calls.contains("old1"));
        assert_eq!(calls.order.len(), 4);
        assert_eq!(calls.ids.len(), 4);
        for n in 0..10 {
            calls.insert(&format!("new{n}"), 4);
        }
        assert_eq!(calls.order.len(), 4);
        assert_eq!(calls.ids.len(), 4);
        assert!(calls.contains("new9") && !calls.contains("live"));
    }

    /// A retry can reuse a worker chat. Its refusals start their own group
    /// rather than joining the settled attempt's open one.
    #[test]
    fn an_outage_group_belongs_to_one_attempt() {
        let chat = format!("chat:test-{}", uuid::Uuid::new_v4());
        let t = 12_000_000;
        let refuse = |id: &str, owner: Option<&str>, at: i64| {
            assert!(observe_claude_refusal(
                &chat,
                owner,
                &outage_denial(id),
                Some(("Bash", &bash("git fetch"))),
                at
            ));
        };
        refuse("g1", Some("attempt-1"), t);
        refuse("g2", Some("attempt-1"), t + 1_000);
        refuse("g3", Some("attempt-2"), t + 2_000);
        refuse("g4", Some("attempt-2"), t + 3_000);
        let cards = cards_in(&chat);
        assert_eq!(cards.len(), 2, "one group per attempt");
        for card in &cards {
            assert_eq!(card.count, Some(2));
            let owners: Vec<_> = card.refusals.iter().map(|r| r.owner.clone()).collect();
            assert_eq!(owners[0], owners[1]);
        }
        let summaries: Vec<_> = decision_summaries()
            .into_iter()
            .filter(|s| s.chat_key == chat)
            .collect();
        assert_eq!(summaries.len(), 4);
        for s in &summaries {
            let card = cards.iter().find(|c| Some(&c.id) == s.group_id.as_ref());
            let card = card.expect("every refusal names its card");
            assert_eq!(s.owner, card.refusals[0].owner);
        }
        forget_chat(&chat);
    }

    #[test]
    fn a_rule_or_person_denial_is_not_a_card() {
        let chat = format!("chat:test-{}", uuid::Uuid::new_v4());
        let mut ruled = classifier_denial("Bash", "toolu_2");
        ruled["decision_reason_type"] = "rule".into();
        assert!(!observe_claude_denial(&chat, None, &ruled, None));
        assert!(pending().iter().all(|b| b.chat_key != chat));

        let chain = serde_json::json!({ "command": "git push && npm publish" });
        assert!(observe_claude_denial(
            &chat,
            None,
            &classifier_denial("Bash", "toolu_3"),
            Some(("Bash", &chain))
        ));
        let card = pending().into_iter().find(|b| b.chat_key == chat).unwrap();
        forget_chat(&chat);
        assert_eq!(decision(&card.id), Some("superseded"));
    }

    #[test]
    fn a_non_codex_provider_never_raises_a_codex_safety_card() {
        let chat = format!("chat:test-{}", uuid::Uuid::new_v4());

        assert!(!observe(AgentKind::Claude, &chat, EXTERNAL));
        assert!(pending().iter().all(|block| block.chat_key != chat));
    }

    #[test]
    fn the_same_rejection_is_one_reload_safe_choice() {
        let chat = format!("chat:test-{}", uuid::Uuid::new_v4());

        assert!(observe(AgentKind::Codex, &chat, EXTERNAL));
        assert!(!observe(AgentKind::Codex, &chat, EXTERNAL));
        let ours = pending()
            .into_iter()
            .filter(|block| block.chat_key == chat)
            .collect::<Vec<_>>();
        assert_eq!(ours.len(), 1);
        assert!(dismiss(&ours[0].id));
        assert!(pending().iter().all(|block| block.chat_key != chat));
    }

    #[test]
    fn a_split_patch_rejection_becomes_one_generic_safety_choice() {
        let chat = format!("chat:test-{}", uuid::Uuid::new_v4());
        let header = "2026-09-07T12:15:53.336267Z ERROR codex_core::tools::router: \
error=This action was rejected due to unacceptable risk.";
        let reason = "Reason: 补丁会伪造质量记录并误导 PR 审查；用户未授权此类不实修改。";
        let policy = "The agent must not attempt to achieve the same outcome via workaround, \
indirect execution, or policy circumvention. Proceed only with a materially safer alternative, \
or if the user explicitly approves the action after being informed of the risk.";

        assert!(!observe(AgentKind::Codex, &chat, header));
        assert!(!observe(AgentKind::Codex, &chat, reason));
        assert!(observe(AgentKind::Codex, &chat, policy));

        let ours = pending()
            .into_iter()
            .filter(|block| block.chat_key == chat)
            .collect::<Vec<_>>();
        assert_eq!(ours.len(), 1);
        assert_eq!(ours[0].kind, "high-risk-action");
        assert_eq!(ours[0].title, "Codex blocked a high-risk action");
        assert_eq!(ours[0].summary, reason.trim_start_matches("Reason: "));
        assert!(ours[0].detail.starts_with("This action was rejected"));
        assert!(ours[0].detail.contains("\nReason:"));
        assert!(ours[0].detail.contains("\nThe agent must"));
        assert!(dismiss(&ours[0].id));
    }
}
