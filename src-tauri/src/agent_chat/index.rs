use super::*;

/// The chats that exist, newest first.
pub fn chat_index_list() -> Vec<crate::chat_index::ChatMeta> {
    let _ = purge_deleted_chats();
    visible_chats(crate::chat_index::list())
}

/// Every chat but the front-desk ones (`team::FrontDeskChat`), which no list,
/// count or search ever shows. Keyed by the chat's identity on the host, so
/// a page that saved one anyway still never gets it back.
pub(crate) fn visible_chats(
    chats: Vec<crate::chat_index::ChatMeta>,
) -> Vec<crate::chat_index::ChatMeta> {
    let hidden: std::collections::HashSet<String> =
        crate::team::front_desk_chats(&crate::team::default_path())
            .into_iter()
            .map(|chat| chat.chat_key)
            .collect();
    if hidden.is_empty() {
        return chats;
    }
    chats
        .into_iter()
        .filter(|meta| !hidden.contains(&format!("chat:{}", meta.id)))
        .collect()
}

/// Chats in the one-day trash, newest deletion first.
pub fn chat_index_deleted() -> Vec<crate::chat_index::ChatMeta> {
    let _ = purge_deleted_chats();
    crate::chat_index::deleted()
}

impl HostPreview {
    /// A message that finished mid-turn is written within this long, with
    /// everything else pending by then.
    pub(super) const MID_TURN: Duration = Duration::from_secs(4);
    /// A turn's closing words are due at once (and written at once unless the
    /// index was just rewritten, see `PreviewBatch::MIN_GAP`).
    pub(super) const TURN_END: Duration = Duration::ZERO;

    /// The readable words of one stream event, if it carries any.
    pub(crate) fn words(event: &Value, spoken: Option<&str>) -> Option<String> {
        if let Some(text) = spoken.map(str::trim).filter(|t| !t.is_empty()) {
            return Some(text.to_owned());
        }
        if event.get("type").and_then(Value::as_str) != Some("assistant")
            || event
                .get("parent_tool_use_id")
                .is_some_and(|parent| !parent.is_null())
        {
            return None;
        }
        let text = event
            .get("message")
            .and_then(|message| message.get("content"))
            .and_then(Value::as_array)?
            .iter()
            .filter(|block| block.get("type").and_then(Value::as_str) == Some("text"))
            .filter_map(|block| block.get("text").and_then(Value::as_str))
            .collect::<Vec<_>>()
            .join("\n");
        let text = text.trim();
        (!text.is_empty()).then(|| text.to_owned())
    }

    /// A chat's own voice only; a worker's chat is not a row anyone lists.
    pub(super) fn chat_id<'a>(session_key: &str, key: &'a str) -> Option<&'a str> {
        key.strip_prefix("chat:")
            .filter(|id| session_key == key && !id.starts_with("orch-"))
    }

    /// A readable message finished mid-turn.
    pub(crate) fn heard(&mut self, session_key: &str, key: &str, text: String) {
        if let Some(id) = Self::chat_id(session_key, key) {
            PreviewBatch::global().submit(id, text, Instant::now(), Self::MID_TURN);
        }
    }

    /// The turn ended. A clean one writes its closing words; any other keeps
    /// the previous preview, so what this turn had submitted is withdrawn.
    pub(crate) fn turn_ended(&mut self, session_key: &str, key: &str, closing: Option<&str>) {
        let Some(id) = Self::chat_id(session_key, key) else {
            return;
        };
        match closing.map(str::trim).filter(|t| !t.is_empty()) {
            Some(text) => {
                let batch = PreviewBatch::global();
                batch.submit(id, text.to_owned(), Instant::now(), Self::TURN_END);
                // Written on this thread unless the index was rewritten in
                // the last second; then the writer thread does it with
                // whatever else has gathered.
                batch.write_due();
            }
            None => PreviewBatch::global().withdraw(id),
        }
    }
}

/// A pending preview: its text, when it must be written by, and the
/// `chat_index::clear_epoch` it was heard in.
pub(super) type PendingPreview = (String, Instant, u64);

/// One preview taken out of the queue for a write: id, text, clear epoch.
pub(super) type DuePreview = (String, String, u64);

/// Writes every preview still waiting (graceful shutdown).
pub(crate) fn flush_previews() {
    PreviewBatch::global().flush();
}

impl PreviewBatch {
    /// The index is rewritten for previews at most this often, however many
    /// chats are busy.
    pub(super) const MIN_GAP: Duration = Duration::from_secs(1);
    /// A shutdown flush gives up after this long (a stuck index lock must not
    /// hold the process open).
    pub(super) const FLUSH_LIMIT: Duration = Duration::from_secs(3);
}

impl PreviewBatch {
    /// The batch the host writes through; its writer thread starts with it.
    pub(crate) fn global() -> &'static PreviewBatch {
        static BATCH: std::sync::OnceLock<&'static PreviewBatch> = std::sync::OnceLock::new();
        BATCH.get_or_init(|| {
            let batch: &'static PreviewBatch = Box::leak(Box::default());
            std::thread::Builder::new()
                .name("chat-preview-writer".into())
                .spawn(move || batch.write_forever())
                .ok();
            batch
        })
    }

    /// The newest text for a chat replaces any older pending one; the time it
    /// is due is the earliest anything for this chat asked for. The clear
    /// epoch is read first, before the text is queued, so a `/clear` that
    /// completes after this read always outranks the text.
    pub(crate) fn submit(&self, id: &str, text: String, now: Instant, within: Duration) {
        let epoch = crate::chat_index::clear_epoch(id);
        let mut pending = self.pending.lock().unwrap_or_else(|e| e.into_inner());
        let due = now + within;
        let due = pending
            .get(id)
            .map_or(due, |(_, earlier, _)| due.min(*earlier));
        pending.insert(id.to_owned(), (text, due, epoch));
        // Newer text supersedes a failed write for the same chat: what is
        // waiting now is waiting for its due time, not for a retry.
        self.failed
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .remove(id);
        self.wake.notify_all();
    }

    /// Drop whatever is pending for a chat, and cancel what was taken for a
    /// write that has not finished from coming back after a failure (a failed
    /// turn, `/clear`). A write that is already past the index lock cannot be
    /// called back; `/clear` has the epoch for that.
    pub(crate) fn withdraw(&self, id: &str) {
        let mut pending = self.pending.lock().unwrap_or_else(|e| e.into_inner());
        pending.remove(id);
        self.in_flight
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .remove(id);
        self.failed
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .remove(id);
    }

    /// Everything pending, once anything in it is due; nothing otherwise.
    pub(crate) fn take_due(&self, now: Instant) -> Option<Vec<DuePreview>> {
        let mut pending = self.pending.lock().unwrap_or_else(|e| e.into_inner());
        if !pending.values().any(|(_, due, _)| *due <= now) {
            return None;
        }
        Some(self.drain_locked(&mut pending))
    }

    /// Everything pending, due or not (shutdown).
    pub(super) fn take_all(&self) -> Option<Vec<DuePreview>> {
        let mut pending = self.pending.lock().unwrap_or_else(|e| e.into_inner());
        if pending.is_empty() {
            return None;
        }
        Some(self.drain_locked(&mut pending))
    }

    pub(super) fn drain_locked(
        &self,
        pending: &mut HashMap<String, PendingPreview>,
    ) -> Vec<DuePreview> {
        let mut in_flight = self.in_flight.lock().unwrap_or_else(|e| e.into_inner());
        pending
            .drain()
            .map(|(id, (text, _, epoch))| {
                in_flight.insert(id.clone());
                (id, text, epoch)
            })
            .collect()
    }

    /// A write failed: what it took goes back, unless newer text arrived or
    /// the chat's words were withdrawn or cleared meanwhile.
    pub(super) fn requeue(&self, batch: Vec<DuePreview>, now: Instant) {
        let mut pending = self.pending.lock().unwrap_or_else(|e| e.into_inner());
        let mut in_flight = self.in_flight.lock().unwrap_or_else(|e| e.into_inner());
        let mut failed = self.failed.lock().unwrap_or_else(|e| e.into_inner());
        for (id, text, epoch) in batch {
            if in_flight.remove(&id)
                && !pending.contains_key(&id)
                && epoch >= crate::chat_index::clear_epoch(&id)
            {
                failed.insert(id.clone());
                pending.insert(id, (text, now, epoch));
            }
        }
    }

    /// Whether a FAILED write still has text to deliver: exactly the chats in
    /// `failed`. Text that is only waiting for its due time is never owed, and
    /// neither is text that newer text for the same chat replaced (the newer
    /// text is a new submission, not the failed write's debt; if it fails in
    /// turn it is owed again). Once nothing is left of a failure the failure
    /// run is over, so the next one is said again.
    pub(crate) fn owes(&self) -> bool {
        let owed = !self
            .failed
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .is_empty();
        if !owed {
            self.failing
                .store(false, std::sync::atomic::Ordering::Relaxed);
        }
        owed
    }

    /// `dispatch::settle_owed`'s door: with a failed write outstanding, try
    /// it through the same `write_due` the writer thread uses (one writer at
    /// a time, `MIN_GAP` apart), so there is one retry path, not two. Err
    /// while previews are still owed.
    pub(crate) fn settle(&self) -> Result<(), ()> {
        if self.owes() {
            self.write_due();
        }
        if self.owes() {
            Err(())
        } else {
            Ok(())
        }
    }

    pub(super) fn finished(&self, batch: &[DuePreview]) {
        let mut in_flight = self.in_flight.lock().unwrap_or_else(|e| e.into_inner());
        let mut failed = self.failed.lock().unwrap_or_else(|e| e.into_inner());
        for (id, _, _) in batch {
            in_flight.remove(id);
            failed.remove(id);
        }
    }

    /// When the next write may happen: the earliest due preview, but not
    /// within `MIN_GAP` of the last write. `None` with nothing pending.
    pub(super) fn next_write(
        pending: &HashMap<String, PendingPreview>,
        last_write: Option<Instant>,
        now: Instant,
    ) -> Option<Instant> {
        let earliest = pending.values().map(|(_, due, _)| *due).min()?;
        Some(earliest.max(last_write.map_or(now, |at| at + Self::MIN_GAP)))
    }

    /// One index write for what was taken; each changed row is announced. A
    /// failure puts the previews back to be tried again (said once).
    pub(super) fn write_batch(&self, batch: Vec<DuePreview>) {
        match crate::chat_index::set_host_previews_since(&batch) {
            Ok(changed) => {
                self.finished(&batch);
                // Ends the failure run when nothing failed is left.
                self.owes();
                for (id, _) in changed {
                    announce_index_change(&id, false);
                }
            }
            Err(error) => {
                // A run of failures nothing is left of is over (everything
                // withdrawn or replaced); this one is a new run and is said.
                self.owes();
                // Owed first, then said: `owes` must see the debt before the
                // flag that says it was announced.
                self.requeue(batch, Instant::now());
                if !self
                    .failing
                    .swap(true, std::sync::atomic::Ordering::Relaxed)
                {
                    crate::unsaved::say("the latest chat previews", error);
                }
            }
        }
    }

    /// Write everything pending if something is due and the gap since the
    /// last write has passed. The caller that is told "now" (a turn's end)
    /// writes on its own thread, so its words are on disk and announced
    /// before it returns; the writer thread does the rest.
    pub(crate) fn write_due(&self) {
        let mut last = self.last_write.lock().unwrap_or_else(|e| e.into_inner());
        let now = Instant::now();
        if last.is_some_and(|at| now < at + Self::MIN_GAP) {
            return;
        }
        let Some(batch) = self.take_due(now) else {
            return;
        };
        *last = Some(now);
        self.write_batch(batch);
    }

    /// Graceful shutdown: everything still pending is written now, due or
    /// not and gap or not, through the same index door. Gives up after
    /// `FLUSH_LIMIT`; what a hard kill (SIGKILL, power loss) or a flush that
    /// could not finish loses is the previews not yet written, never the
    /// transcript.
    pub(crate) fn flush(&'static self) {
        let (done, wait) = std::sync::mpsc::channel();
        let spawned = std::thread::Builder::new()
            .name("chat-preview-flush".into())
            .spawn(move || {
                let mut last = self.last_write.lock().unwrap_or_else(|e| e.into_inner());
                if let Some(batch) = self.take_all() {
                    *last = Some(Instant::now());
                    self.write_batch(batch);
                }
                let _ = done.send(());
            });
        if spawned.is_ok() {
            let _ = wait.recv_timeout(Self::FLUSH_LIMIT);
        }
    }

    pub(super) fn write_forever(&self) {
        loop {
            self.write_due();
            let last = *self.last_write.lock().unwrap_or_else(|e| e.into_inner());
            let pending = self.pending.lock().unwrap_or_else(|e| e.into_inner());
            let now = Instant::now();
            let wait = Self::next_write(&pending, last, now)
                .map_or(Duration::from_secs(3600), |at| {
                    at.saturating_duration_since(now)
                });
            // A submit wakes it early; the timeout wakes it when one is due.
            drop(
                self.wake
                    .wait_timeout(pending, wait.max(Duration::from_millis(10)))
                    .unwrap_or_else(|e| e.into_inner()),
            );
        }
    }
}

/// Say that the list of chats has changed, so every OTHER browser can pick the
/// change up without being reloaded.
///
/// Until this event existed a browser read the list when it connected and never
/// again, which made the sidebar a snapshot: a chat started on the phone reached
/// the laptop at the next reload and not before.
///
/// New pages apply this one canonical row; older pages still re-read the list.
/// Read failures stay invalidations, never an invented deletion.
pub(crate) fn announce_index_change(id: &str, gone: bool) {
    // Serialize read + broadcast. Writers may finish in either order, but a
    // later event always reads at least the state of the previous event.
    static ANNOUNCE: std::sync::Mutex<()> = std::sync::Mutex::new(());
    let _announce = ANNOUNCE.lock().unwrap_or_else(|e| e.into_inner());
    let mut payload = serde_json::json!({ "id": id, "gone": gone });
    if let Ok(entry) = crate::chat_index::find(id) {
        let entry = visible_chats(entry.into_iter().collect())
            .into_iter()
            .next();
        payload["entry"] = serde_json::json!(entry);
        if gone {
            payload["deleted"] = serde_json::json!(crate::chat_index::deleted()
                .into_iter()
                .find(|row| row.id == id));
        }
    }
    crate::bus::emit("chat-index-changed", payload);
}

/// Record a chat, or update what is known about it.
pub fn chat_index_save(meta: crate::chat_index::ChatMeta) -> Result<(), String> {
    let id = meta.id.clone();
    // A front-desk chat is never recorded: nothing lists it, and its
    // transcript goes at the next start like any chat no row points at.
    if crate::team::is_front_desk_chat(&crate::team::default_path(), &format!("chat:{id}")) {
        return Ok(());
    }
    registered_runtime::audit_index_change(&meta)?;
    crate::chat_index::upsert(meta)?;
    // Only once it is actually on disk. Announcing a write that failed would
    // send every other device to fetch a list that has not changed.
    announce_index_change(&id, false);
    Ok(())
}

pub fn chat_set_agent_title(
    chat_id: String,
    title: String,
) -> Result<crate::chat_index::ChatTitleUpdate, String> {
    let result = crate::chat_index::set_agent_title(&chat_id, &title)?;
    if result.updated {
        announce_index_change(&chat_id, false);
    }
    Ok(result)
}

/// A chat was opened; move its shared "last read" mark forward and tell every
/// other browser so an unread dot there clears too. Its own command rather
/// than a `chat_index_save` — this fires on every open, and a save carries a
/// FULL entry that can be stale by the time it lands (see
/// `chat_index::mark_read`).
pub fn chat_mark_read(id: String, at: i64) -> Result<(), String> {
    crate::chat_index::mark_read(&id, at)?;
    announce_index_change(&id, false);
    Ok(())
}

/// Tick a chat off by hand, or take the tick back. Narrow for the same reason
/// as `chat_mark_read`: it answers one question, and a full save cannot be
/// trusted to carry an answer it was assembled before hearing (see
/// `chat_index::set_done`). Announced, so the other devices' lists move too —
/// a chat ticked off on the phone should not still be sitting in the laptop's
/// active list.
pub fn chat_set_done(id: String, at: Option<i64>) -> Result<(), String> {
    crate::chat_index::set_done(&id, at)?;
    announce_index_change(&id, false);
    Ok(())
}

/// Move a chat into the one-day trash. The old command name is kept so an
/// already-open browser gets the safer behaviour as soon as the backend is
/// updated. `expected_generation` makes a delayed retry from before a restore
/// harmless.
pub fn chat_index_remove(
    id: String,
    _key: String,
    expected_generation: Option<u64>,
    meta: Option<crate::chat_index::ChatMeta>,
) -> Result<(), String> {
    if crate::chat_index::trash(&id, expected_generation, meta)? {
        announce_index_change(&id, true);
    }
    Ok(())
}

/// Bring a soft-deleted chat back while its restore window is still open.
pub fn chat_index_restore(id: String) -> Result<Option<crate::chat_index::ChatMeta>, String> {
    let restored = crate::chat_index::restore(&id)?;
    if restored.is_some() {
        announce_index_change(&id, false);
    } else {
        // If the request arrived just past the deadline, finish the hard delete
        // now rather than waiting for the next minute sweep.
        let _ = purge_deleted_chats();
    }
    Ok(restored)
}

/// Remove expired index rows and transcripts, and tell open browsers so a
/// Trash panel can discard them immediately.
pub(super) fn purge_deleted_chats() -> Result<usize, String> {
    let expired = crate::chat_index::purge_expired()?;
    for id in &expired {
        // The task record goes with the chat it describes. It is kept through
        // the trash window, so a restore brings back a chat that still knows
        // where its work went.
        crate::chat_task::forget(id);
        // And the pictures, recordings and sounds its questions showed.
        crate::question_media::forget(id);
        announce_index_change(id, true);
    }
    if !expired.is_empty() {
        println!(
            "[chats] permanently removed {} expired chat(s)",
            expired.len()
        );
    }
    Ok(expired.len())
}

/// Stop, revoke native continuations durably, then remove the display record.
/// A failed store write leaves the transcript intact and emits no success.
pub fn chat_forget_impl(manager: &ChatManager, key: String) -> Result<(), String> {
    // Veto native init before even the memory snapshots: starts may be busy
    // with I/O, and saved_resume_context takes the ledger. Neither may delay
    // the epoch bump. Only the scheduled ids must precede Stop, whose normal
    // cancellation removes that entry; the other contexts survive Stop.
    manager.revoke_auto_plan(&key);
    let scheduled_ids = manager.auto_resumes.session_ids(&key);
    chat_stop_impl(manager, key.clone())?;
    // A cleared chat starts over: no switch waits and no history is owed.
    manager.forget_runtime(&key);
    let mut ids = Vec::new();
    if let Some(start) = manager.start_context(&key) {
        ids.extend(start.session_id);
    }
    if let Some(start) = manager.orchestrations.saved_resume_context(&key) {
        ids.extend(start.session_id);
    }
    ids.extend(scheduled_ids?);
    let _claim = manager.hold_start(&key)?;
    let write = manager.native_write(&key);
    let _write = write.lock().map_err(|e| e.to_string())?;
    if let Some(start) = manager.start_context(&key) {
        ids.extend(start.session_id);
    }
    // Include previous providers, since registered recovery can consult init
    // events when the remembered runtime differs from the current preset.
    let mut recorded_ids = Vec::new();
    for line in crate::transcript::every_line(&key)? {
        for provider in ChatAgent::ALL {
            if let Some(id) = provider_for(provider).observe_event(&line.event).session_id {
                recorded_ids.push(id.into());
            }
        }
    }
    // Current contexts take precedence over earlier init events at the bound.
    recorded_ids.extend(ids);
    crate::chat_index::forget_sessions(&key, recorded_ids)?;
    manager.orchestrations.clear_resume_session(&key)?;
    manager.auto_resumes.clear_session(&key)?;
    if let Some(start) = manager
        .starts
        .lock()
        .map_err(|e| e.to_string())?
        .get_mut(&key)
    {
        start.forget_session();
    }
    // The row's preview is the host's and describes a conversation that is
    // about to have no history: clear it first (a failed write leaves the
    // transcript intact like every other store here), withdrawing anything
    // the writer was about to put back.
    let own_chat = key.strip_prefix("chat:").map(str::to_owned);
    if let Some(id) = &own_chat {
        PreviewBatch::global().withdraw(id);
        crate::chat_index::clear_host_preview(id)?;
    }
    chat_forget(key.clone())?;
    if let Some(id) = &own_chat {
        // A line the reader thread submitted while this ran.
        PreviewBatch::global().withdraw(id);
        announce_index_change(id, false);
    }
    drop(_claim);
    crate::bus::emit("chat-forgotten", &json!({"key":key}));
    Ok(())
}

/// Everything a chat said after `after`.
///
/// How a client catches up. It remembers the highest seq it has seen and asks
/// for the rest — after a reconnect, a reload, or on a second device that has
/// never seen this conversation at all.
pub fn chat_since(key: String, after: u64) -> Vec<crate::transcript::Recorded> {
    crate::transcript::since(&key, after)
}

/// Throw away a chat's record. Deleting a conversation should leave nothing.
pub fn chat_forget(key: String) -> Result<(), String> {
    crate::transcript::forget_checked(&key)
}

/// The keys of every running chat. A reconnecting browser uses this the way it
/// uses pty_active_sessions: to find what is already going.
pub fn chat_list_impl(manager: &ChatManager) -> Result<Vec<String>, String> {
    let sessions = manager.sessions.lock().map_err(|e| e.to_string())?;
    Ok(sessions.keys().cloned().collect())
}

/// Every running chat with its turn state. The Agents page asks this for a
/// lead's conversation, which a freshly loaded page has seen no events from
/// and so cannot tell working from sitting idle. A session whose lock is
/// poisoned says not busy rather than guessing.
pub fn chat_activity_impl(manager: &ChatManager) -> Result<Vec<ChatActivity>, String> {
    let sessions = manager.sessions.lock().map_err(|e| e.to_string())?;
    Ok(sessions
        .iter()
        .map(|(key, session)| ChatActivity {
            key: key.clone(),
            busy: session.lock().map(|s| s.busy).unwrap_or(false),
            completing: manager.completing_turn(key).is_some(),
        })
        .collect())
}

/// One socket's small background-chat update, without waiting for any chat
/// lock, reading a process list or parsing a provider/transcript. Clone only
/// the session Arc under the table guard; never hold both locks together.
/// `None` means contention: the socket must defer without sending a state.
/// A missing session is stopped/idle; poisoned locks give unknown fields.
pub(crate) fn chat_stream_state(
    manager: &ChatManager,
    key: &str,
) -> Option<crate::bus::activity::State> {
    use std::sync::TryLockError;

    let session = match manager.sessions.try_lock() {
        Ok(sessions) => sessions.get(key).cloned(),
        Err(TryLockError::WouldBlock) => return None,
        Err(TryLockError::Poisoned(_)) => return Some(Default::default()),
    };
    let Some(session) = session else {
        return Some(crate::bus::activity::State {
            running: Some(false),
            busy: Some(false),
            turn_id: None,
        });
    };
    let state = match session.try_lock() {
        Ok(session) => crate::bus::activity::State {
            running: Some(true),
            busy: Some(session.busy),
            turn_id: session.answering.clone(),
        },
        Err(TryLockError::WouldBlock) => return None,
        Err(TryLockError::Poisoned(_)) => crate::bus::activity::State {
            running: Some(true),
            // The table proved existence, but the turn fields are unknown.
            ..Default::default()
        },
    };
    Some(state)
}

pub fn chat_queue_state_impl(manager: &ChatManager, key: &str) -> Result<ChatQueueState, String> {
    // Read before the chat's locks are taken: it reads the record.
    let (pending_runtime, home_runtime, runtime) = runtime_switch::queue_fields(manager, key);
    let registered = is_registered_chat(key).unwrap_or(false);
    // Match the send/reaper lock order, so an enqueue cannot cross this read.
    let sessions = manager.sessions.lock().map_err(|e| e.to_string())?;
    let handoffs = manager.handoffs.lock().map_err(|e| e.to_string())?;
    let queues = manager.queued_turns.lock().map_err(|e| e.to_string())?;
    Ok(ChatQueueState {
        registered,
        runtime,
        pending_runtime,
        home_runtime,
        held: manager.waits_because(key),
        completing_turn_id: manager.completing_turn(key),
        live: sessions.contains_key(key) || handoffs.contains(key),
        queued_turn_ids: queues
            .get(key)
            .into_iter()
            .flat_map(|turns| {
                turns
                    .iter()
                    .flat_map(QueuedTurn::turn_ids)
                    .map(str::to_string)
            })
            .collect(),
    })
}
