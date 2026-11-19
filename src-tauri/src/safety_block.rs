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
    /// A Claude card with a rule to offer: the settings files an "Always
    /// allow" would write, when this chat reads them. None for a chat that
    /// ignores Claude's settings files (a lite chat), whose launch this server
    /// never saw, or (a judged card) whose call no exact rule can name.
    #[serde(skip_serializing_if = "Option::is_none")]
    allow: Option<AllowTargets>,
    /// A Claude card only: the scope an "Always allow" has already written
    /// while the turn that answers it is not yet queued. The card stays up
    /// until a chat has taken the turn that names it (`person_turn`), so a
    /// send that fails in between leaves it to be sent again rather than lost.
    #[serde(skip_serializing_if = "Option::is_none")]
    written: Option<crate::claude_allow::Scope>,
    /// An "Always allow" is writing this card's rule right now
    /// (`write_allow`). Nothing takes the card down meanwhile: a dismiss or a
    /// superseding turn is held in `close_after_write` and applied once the
    /// write ends, so a card can never close as dismissed while a lasting rule
    /// goes into a settings file behind it.
    #[serde(skip_serializing)]
    writing: bool,
    /// How the card was asked to close while its rule was being written.
    #[serde(skip_serializing)]
    close_after_write: Option<&'static str>,
    /// A judged Claude refusal only: the exact rules "Always allow" writes,
    /// one per segment of the refused line it is safe to name
    /// (`claude_allow::derive_judged_rules`). Empty: no allow is offered.
    #[serde(skip_serializing_if = "Vec::is_empty")]
    rules: Vec<String>,
    /// A judged Claude refusal only: the segments of the line no rule names.
    /// Claude judges a line holding any of them again.
    #[serde(skip_serializing_if = "Vec::is_empty")]
    uncovered: Vec<String>,
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
    pub fn id(&self) -> &str {
        &self.id
    }

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
/// "retried"; for a Claude card "allowed_project" or "allowed_user" (a
/// lasting allow rule the person wrote; a card whose rule was written closes
/// as that allow however it is closed). Nothing records "allowed_exact" any
/// more; see `EXACT_GRANT_WITHDRAWN`.
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

/// The two files an outage card may write, for this chat. A user file the
/// host would refuse (`claude_allow::user_settings_target`) is left out, so
/// the card never offers a button that can only fail.
fn allow_targets(chat_key: &str) -> Option<AllowTargets> {
    let launch = with_claude_launches(|launches| launches.get(chat_key).cloned())?;
    if launch.lite {
        return None;
    }
    let shown = |path: PathBuf| path.to_string_lossy().into_owned();
    let targets = AllowTargets {
        project: crate::claude_allow::project_settings_path(Path::new(&launch.cwd)).map(shown),
        user: user_target(&launch).ok().map(shown),
    };
    (targets.project.is_some() || targets.user.is_some()).then_some(targets)
}

/// The person's own settings file for this launch, resolved as Claude
/// resolves it. A chat with no folder runs in the home folder
/// (`agent_chat::start_session`'s `process_cwd`), so a relative
/// `CLAUDE_CONFIG_DIR` is read from there.
fn user_target(launch: &ClaudeLaunch) -> Result<PathBuf, String> {
    let home = crate::paths::home_dir();
    let project = Path::new(&launch.cwd);
    let launch_cwd = if launch.cwd.is_empty() {
        home.clone().unwrap_or_default()
    } else {
        project.to_path_buf()
    };
    crate::claude_allow::user_settings_target(
        launch.config_dir.as_deref(),
        &launch_cwd,
        home.as_deref(),
        Some(project),
    )
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
    /// Refused calls (or, on a judged card, segments of the refused line)
    /// no rule covers: they meet Claude's check again.
    uncovered: Vec<String>,
}

/// Only an outage card from Claude can be retried from here, and Codex's
/// cards have their own choices.
fn pending_outage(id: &str) -> Result<BlockedAction, String> {
    let block = with_pending(|pending| pending.get(id).cloned())
        .ok_or("This card is no longer pending.")?;
    is_outage(&block)?;
    Ok(block)
}

fn is_outage(block: &BlockedAction) -> Result<(), String> {
    if block.provider != "claude" || block.kind != "outage" {
        return Err(
            "Only a call refused because Claude's safety check was unavailable can be retried or allowed from its card."
                .into(),
        );
    }
    Ok(())
}

/// A judged Claude refusal whose line has at least one segment an exact rule
/// can name. Nothing about the refusal itself is approved here: the only
/// thing such a card can do is write that lasting rule.
fn pending_judged(id: &str) -> Result<BlockedAction, String> {
    let block = with_pending(|pending| pending.get(id).cloned())
        .ok_or("This card is no longer pending.")?;
    is_judged(&block)?;
    Ok(block)
}

fn is_judged(block: &BlockedAction) -> Result<(), String> {
    if block.provider != "claude" || block.kind != "high-risk-action" || block.rules.is_empty() {
        return Err(
            "No exact allow rule can be written for this card: only a judged Claude refusal of a shell command that can be named exactly offers one."
                .into(),
        );
    }
    Ok(())
}

/// Write one card's "Always allow" as a single transition with the card's
/// own life: the card is claimed under the pending lock before anything is
/// written, so it cannot be dismissed or superseded between the decision and
/// the write.
///
/// - A card already gone, or of the wrong kind, writes nothing.
/// - While the claim is held, a dismiss or a superseding turn is held back
///   (`close_card`); the card closes the moment the write ends.
/// - A write that succeeds marks the card `written`, so however it closes
///   afterwards it is recorded as that allow (`allowed_project` /
///   `allowed_user`), never as dismissed or superseded.
/// - A write that fails releases the claim and leaves the card pending —
///   unless the person closed it meanwhile, which then takes effect as asked.
///
/// `rules` turns the claimed card into the rules to write and the calls or
/// segments they leave uncovered.
fn write_allow(
    id: &str,
    scope: crate::claude_allow::Scope,
    kind: fn(&BlockedAction) -> Result<(), String>,
    rules: fn(&BlockedAction) -> Result<(Vec<String>, Vec<String>), String>,
) -> Result<AllowedOutage, String> {
    let block = claim_write(id, kind)?;
    let written = allow_path(&block, scope).and_then(|path| {
        let (rules, uncovered) = rules(&block)?;
        let added = crate::claude_allow::add_allow_rules(Path::new(&path), scope, &rules)?;
        Ok(AllowedOutage {
            rules,
            path,
            added,
            uncovered,
        })
    });
    finish_write(id, scope, written.is_ok());
    written
}

/// Claim a pending card of this kind for one allow write.
fn claim_write(
    id: &str,
    kind: fn(&BlockedAction) -> Result<(), String>,
) -> Result<BlockedAction, String> {
    with_pending(|pending| {
        let block = pending
            .get_mut(id)
            .ok_or("This card is no longer pending. Nothing was written.")?;
        kind(block)?;
        if block.writing {
            return Err("This card's allow rule is already being written.".to_string());
        }
        block.writing = true;
        Ok(block.clone())
    })
}

/// Release the claim: mark the card written when the write succeeded, and
/// apply a close that was asked for meanwhile.
fn finish_write(id: &str, scope: crate::claude_allow::Scope, ok: bool) {
    let closed = with_pending(|pending| {
        let block = pending.get_mut(id)?;
        block.writing = false;
        if ok {
            block.written = Some(scope);
        }
        let asked = block.close_after_write.take()?;
        let decision = block.written.map_or(asked, |scope| scope.decision());
        pending.remove(id);
        Some(decision)
    });
    if let Some(decision) = closed {
        announce_closed(id, decision);
    }
}

/// "Always allow" on any Claude card: an outage card's narrowest rules, or a
/// judged card's exact ones. The page sends only the card and the scope.
pub fn allow_rule(id: &str, scope: crate::claude_allow::Scope) -> Result<AllowedOutage, String> {
    if pending_judged(id).is_ok() {
        allow_judged(id, scope)
    } else {
        allow_outage(id, scope)
    }
}

/// "Always allow" on a judged refusal: write the card's exact rules — the
/// ones it showed, derived when the refusal was seen — into the chosen
/// settings file. Nothing is run and nothing is retried here: the page then
/// tells the agent the rule exists, in a turn that names this card, and the
/// card closes as this allow once that turn is taken (`person_turn`). From
/// then on Claude runs matching commands without its safety check; that is
/// the lasting rule `EXACT_GRANT_WITHDRAWN` says a one-time grant could never
/// avoid being, offered here as exactly that.
pub fn allow_judged(id: &str, scope: crate::claude_allow::Scope) -> Result<AllowedOutage, String> {
    write_allow(id, scope, is_judged, |block| {
        Ok((block.rules.clone(), block.uncovered.clone()))
    })
}

/// The settings file an "Always allow" on this card writes for `scope`, or
/// why it may not.
fn allow_path(block: &BlockedAction, scope: crate::claude_allow::Scope) -> Result<String, String> {
    use crate::claude_allow::Scope;
    let targets = block.allow.as_ref().ok_or(
        "This chat does not read Claude's settings files, so an allow rule would change nothing.",
    )?;
    Ok(match scope {
        Scope::Project => targets.project.clone().ok_or(
            "This chat has no project folder, so there is no project settings file to write.",
        )?,
        Scope::User => {
            let shown = targets
                .user
                .clone()
                .ok_or("This chat's Claude settings folder is not your own, so OctiqFlow will not write an allow rule everywhere.")?;
            // Resolved again at the click: the folder may have changed (a
            // symlink swapped, a relaunch with another CLAUDE_CONFIG_DIR)
            // since the card was drawn, and it is the file written NOW that
            // must be the person's own.
            let launch = with_claude_launches(|launches| launches.get(&block.chat_key).cloned())
                .ok_or("This chat's launch is no longer known. Nothing was written.")?;
            let now = user_target(&launch)?;
            if now.to_string_lossy() != shown {
                return Err(format!(
                    "Claude's settings folder changed since this card was shown ({shown}). Nothing was written."
                ));
            }
            shown
        }
    })
}

/// "Always allow" on an outage card: write the narrowest rule for each of
/// the card's refused calls into the chosen settings file. The caller then
/// asks the agent to retry; nothing here runs anything.
pub fn allow_outage(id: &str, scope: crate::claude_allow::Scope) -> Result<AllowedOutage, String> {
    // The card stays up: it is decided only once the retry turn is queued
    // (`retry_outage`). Writing the rule again is harmless — it is then
    // `present`, not added twice.
    write_allow(id, scope, is_outage, |block| {
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
            return Err(
                "No allow rule is narrow enough for these calls. Retry once instead.".into(),
            );
        }
        Ok((rules, uncovered))
    })
}

/// The retry turn is queued: take the card down as decided. `person_turn`
/// calls this only AFTER the chat took the turn that asks for the one as-is
/// retry Claude's own message allows — "Retry once" straight away, an
/// "Always allow" once its rule is written — so a send that fails first
/// leaves the card pending and the decision unrecorded. A card whose rule was
/// written is recorded as that allow, any other as retried. The page from
/// 2f71bc6 called it itself after the send; it stays a command for that page.
pub fn retry_outage(id: &str) -> Result<bool, String> {
    let block = pending_outage(id)?;
    let decision = block.written.map_or("retried", |scope| scope.decision());
    Ok(dismiss_as(id, decision))
}

/// How a pending card closes when a turn that names it is taken, or None
/// when no turn answers it: an outage card closes as retried or as the allow
/// it wrote; a judged card only as the allow it wrote — a turn naming a
/// judged card before its rule exists answers nothing, and supersedes it.
fn answered_as(id: &str) -> Option<&'static str> {
    with_pending(|pending| {
        let block = pending.get(id)?;
        if block.provider != "claude" {
            return None;
        }
        match block.kind {
            "outage" => Some(block.written.map_or("retried", |scope| scope.decision())),
            "high-risk-action" if !block.rules.is_empty() => {
                block.written.map(|scope| scope.decision())
            }
            _ => None,
        }
    })
}

fn authorization_path() -> PathBuf {
    crate::profile::profile_dir().join("safety-authorizations.json")
}

fn read_authorizations(path: &Path) -> Result<AuthorizationStore, String> {
    match crate::profile::read(path, |e| e.to_string())? {
        Some(bytes) => serde_json::from_slice(&bytes)
            .map_err(|_| "Saved safety authorizations could not be read.".to_string()),
        // No file, in a profile that is there: nothing authorized yet.
        None => Ok(AuthorizationStore::default()),
    }
}

fn write_authorizations(path: &Path, store: &AuthorizationStore) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        crate::profile::make_dir(parent)?;
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
    // The answer IS the stored authorization, so one that cannot be stored
    // grants nothing and is not assumed later: the card stays up, to be
    // answered again or another way (Allow once and Keep it local keep
    // nothing, and work with the profile folder away).
    save_authorization(&authorization_path(), &block).map_err(|why| {
        format!("Nothing was allowed for the project, and the card is still open: {why}")
    })?;
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
                    can_continue: block.provider == "codex",
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
                    can_continue: block.provider == "codex",
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
    /// Whether answering the card can continue the work (`awaits_decision`).
    pub can_continue: bool,
}

/// Remove one card after the person chooses a path or dismisses it.
pub fn dismiss(id: &str) -> bool {
    dismiss_as(id, "dismissed")
}

fn dismiss_as(id: &str, decision: &'static str) -> bool {
    match with_pending(|pending| close_card(pending, id, decision)) {
        Closing::Now(decision) => {
            announce_closed(id, decision);
            true
        }
        Closing::AfterWrite => true,
        Closing::Gone => false,
    }
}

enum Closing {
    /// Taken down, as this decision.
    Now(&'static str),
    /// Its allow rule is being written: it closes when the write ends.
    AfterWrite,
    /// Not pending.
    Gone,
}

/// Take one card down as `decision`, under the pending lock. A card whose
/// allow rule was written closes as that allow whatever closed it, since the
/// rule outlives the card; one whose rule is being written right now closes
/// when the write ends (`write_allow`).
fn close_card(
    pending: &mut HashMap<String, BlockedAction>,
    id: &str,
    decision: &'static str,
) -> Closing {
    let Some(block) = pending.get_mut(id) else {
        return Closing::Gone;
    };
    if block.writing {
        block.close_after_write.get_or_insert(decision);
        return Closing::AfterWrite;
    }
    let decision = block.written.map_or(decision, |scope| scope.decision());
    pending.remove(id);
    Closing::Now(decision)
}

fn announce_closed(id: &str, decision: &'static str) {
    record_decision(id, decision);
    crate::bus::emit(
        "safety-block-expired",
        serde_json::json!({ "id": id, "decision": decision }),
    );
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
/// What the card CAN offer, for a shell line, is the lasting kind: exact
/// rules the person writes to their settings (`allow_judged`), which Claude
/// then honours without asking its classifier, for this call and every later
/// one that matches. The agent is told the rule exists and retries itself.
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
    let command = (tool == "Bash")
        .then(|| {
            input
                .and_then(|i| i.get("command"))
                .and_then(|c| c.as_str())
        })
        .flatten()
        .map(str::to_string);
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
                command,
                at: now,
                owner: owner.map(str::to_string),
            },
        );
    }
    if let Some(id) = tool_use_id {
        // Two refusals of the same line are two decisions, not one card.
        detail.push_str(&format!("\n\nTool call: {id}"));
    }
    // The exact rules are derived from the line as Claude was asked to run
    // it, never re-read from the display `action`, and fixed now: the card
    // writes what it showed.
    let judged = crate::claude_allow::derive_judged_rules(tool, command.as_deref());
    let allow = judged.as_ref().and_then(|_| allow_targets(chat_key));
    let (rules, uncovered) = match (judged, &allow) {
        (Some(judged), Some(_)) => (judged.rules, judged.uncovered),
        _ => (Vec::new(), Vec::new()),
    };
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
        allow,
        written: None,
        writing: false,
        close_after_write: None,
        rules,
        uncovered,
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
            written: None,
            writing: false,
            close_after_write: None,
            rules: Vec::new(),
            uncovered: Vec::new(),
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
pub const EXACT_GRANT_WITHDRAWN: &str = "OctiqFlow cannot allow a command Claude's auto mode refused. Claude refuses it without asking anyone, and gives no way to approve one call before it runs; a permission rule would allow every later call of that line too. The refusal stands. Dismiss the card, run the command yourself, or, if you mean to allow it for good, add a lasting allow rule with the card's Always allow where it offers one.";

/// A new user turn supersedes any unanswered post-hoc choice in that chat.
pub fn forget_chat(chat_key: &str) {
    let removed: Vec<(String, &'static str)> = with_pending(|pending| {
        let ids = pending
            .values()
            .filter(|block| block.chat_key == chat_key)
            .map(|block| block.id.clone())
            .collect::<Vec<_>>();
        ids.into_iter()
            .filter_map(|id| match close_card(pending, &id, "superseded") {
                Closing::Now(decision) => Some((id, decision)),
                Closing::AfterWrite | Closing::Gone => None,
            })
            .collect()
    });
    for (id, decision) in removed {
        announce_closed(&id, decision);
    }
    with_drafts(|drafts| {
        drafts.remove(chat_key);
    });
}

/// Offer a turn the person sent to a chat (`send`), superseding that chat's
/// unanswered cards as `forget_chat` does.
///
/// `answering` names the card this turn answers: an outage card's retry, or
/// the message telling the agent a judged card's allow rule now exists.
/// Then nothing is superseded until the chat has TAKEN the turn: a send that
/// fails — no process, a refused workspace, a start that never happens —
/// leaves every card up and undecided, to be answered again. Once it is
/// taken, the card is closed as its own decision (`answered_as`: retried,
/// or the allow it wrote), and only the cards that were already up beside
/// it are superseded; one the new turn raised in the meantime stays. Any
/// other turn, or one naming a card no turn answers (`answered_as` is None),
/// supersedes first, exactly as before.
pub fn person_turn<T>(
    chat_key: &str,
    answering: Option<&str>,
    send: impl FnOnce() -> Result<T, String>,
) -> Result<T, String> {
    let Some(card) = answering.filter(|id| answered_as(id).is_some()) else {
        forget_chat(chat_key);
        return send();
    };
    let beside: Vec<String> = with_pending(|pending| {
        pending
            .values()
            .filter(|block| block.chat_key == chat_key && block.id != card)
            .map(|block| block.id.clone())
            .collect()
    });
    let taken = send()?;
    // Another tab may have closed it since; the turn is taken either way.
    if let Some(decision) = answered_as(card) {
        dismiss_as(card, decision);
    }
    for id in beside {
        dismiss_as(&id, "superseded");
    }
    with_drafts(|drafts| {
        drafts.remove(chat_key);
    });
    Ok(taken)
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
        written: None,
        writing: false,
        close_after_write: None,
        rules: Vec::new(),
        uncovered: Vec::new(),
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

/// A Codex safety card for a chat in the project at `cwd`, as a refused
/// command leaves one. Answers the card's id.
#[cfg(test)]
pub(crate) fn test_codex_card(chat_key: &str, cwd: &str) -> String {
    remember_project(chat_key, cwd);
    let detail = format!("refused for {chat_key}");
    assert!(publish(
        chat_key,
        "This command reads credentials.".into(),
        detail.clone()
    ));
    with_pending(|pending| {
        pending
            .values()
            .find(|block| block.chat_key == chat_key && block.detail == detail)
            .map(|block| block.id.clone())
            .expect("the card just published")
    })
}

/// Whether the card `id` is still waiting for an answer.
#[cfg(test)]
pub(crate) fn test_is_pending(id: &str) -> bool {
    with_pending(|pending| pending.contains_key(id))
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
#[path = "safety_block_tests.rs"]
mod tests;
