use super::*;

fn activity(chat: &str, id: &str, status: Status) -> Activity {
    Activity {
        id: id.into(),
        chat_key: chat.into(),
        request_id: "r1".into(),
        status,
        agent: Some(AgentRef {
            id: "agent_1".into(),
            name: "Mango Juice".into(),
        }),
        at: 1,
        note: Some("agent-zone/agents/mango/memory.md".into()),
        date: Some("2026-09-28".into()),
        text: Some("A decision and why.".into()),
        receipt_id: (status != Status::Failed).then(|| id.to_owned()),
        receipt_status: Some(
            match status {
                Status::Saved => "saved",
                Status::Uncertain => "needs_review",
                Status::Failed | Status::Refused => "none",
            }
            .into(),
        ),
        error: (status != Status::Saved).then(|| "boom".into()),
        owner: None,
        earlier: None,
    }
}

fn unique(prefix: &str) -> String {
    format!("chat:{prefix}-{}", uuid::Uuid::new_v4())
}

fn scratch_ledger() -> crate::test_dir::TestPath {
    crate::test_dir::TestPath::new("memact-ledger", "memory-activity.json")
}

fn fresh_id() -> String {
    digest(&json!(uuid::Uuid::new_v4().to_string()))
}

#[test]
fn storage_gate_waits_for_memory_intents_and_missing_delivered_lines() {
    let home = crate::test_dir::TestDir::new("storage-memory-debt");
    let _profile = crate::profile::started_in(&home);
    let key = "chat:storage-memory-debt";
    let path = crate::transcript::path_for(key).unwrap();
    let record = crate::transcript::record_claim(&path);
    // Other tests model separate profiles but share the production mutex.
    // Busy is a valid fail-closed answer, not evidence about this ledger.
    // Retry only that contention; every debt/parse assertion stays exact.
    let quiet = || {
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(5);
        loop {
            let answer = record_quiet(&record);
            if answer
                .as_ref()
                .err()
                .is_none_or(|e| e != "memory activity delivery is busy")
                || std::time::Instant::now() >= deadline
            {
                return answer;
            }
            std::thread::sleep(std::time::Duration::from_millis(1));
        }
    };
    let ledger_path = ledger_path().unwrap();
    let mut ledger = Ledger::default();
    ledger
        .entries
        .entry("activity".into())
        .or_default()
        .pending
        .insert(key.into(), Status::Saved);
    fs::write(&ledger_path, serde_json::to_vec(&ledger).unwrap()).unwrap();
    assert!(quiet().is_err());
    let manager = crate::agent_chat::ChatManager::default();
    crate::record_trim::assert_debt_blocks_compaction(&manager, key, "memory activity line");
    let event = json!({"type": EVENT,"id":"activity","status":"saved"});
    crate::transcript::append_synced(key, &event).unwrap();
    let entry = ledger.entries.get_mut("activity").unwrap();
    entry.pending.clear();
    entry.delivered.insert(key.into(), Status::Saved);
    fs::write(&ledger_path, serde_json::to_vec(&ledger).unwrap()).unwrap();
    assert!(quiet().is_ok());
    crate::transcript::forget(key);
    assert!(quiet().is_err());
    crate::record_trim::assert_debt_blocks_compaction(
        &manager,
        key,
        "recovered memory activity line",
    );
    crate::transcript::append_synced(key, &event).unwrap();
    assert!(quiet().is_ok());
    fs::write(&ledger_path, "torn ledger").unwrap();
    assert!(quiet().is_err());
    assert_eq!(fs::read_to_string(&ledger_path).unwrap(), "torn ledger");
}

type Seen = std::sync::Arc<Mutex<Vec<(String, Value)>>>;

/// Writes to the real (test) transcript and remembers what it wrote.
fn capture() -> (Seen, impl Fn(&str, Value) -> Option<u64>) {
    let seen: Seen = Default::default();
    let sink = seen.clone();
    (seen, move |chat: &str, event: Value| {
        sink.lock().unwrap().push((chat.to_owned(), event.clone()));
        crate::transcript::append(chat, &event)
    })
}

fn lines(chat: &str) -> Vec<Value> {
    crate::transcript::since(chat, 0)
        .into_iter()
        .map(|r| r.event)
        .filter(|e| e["type"] == EVENT)
        .collect()
}

#[test]
fn one_line_per_write_however_often_it_is_reported() {
    let ledger = scratch_ledger();
    let chat = unique("dup");
    let id = fresh_id();
    let (seen, emit) = capture();
    assert_eq!(
        record_at(&ledger, activity(&chat, &id, Status::Saved), &emit).shown,
        vec![chat.clone()]
    );
    // A retried call, a repeated MCP delivery, a restarted server: the
    // ledger is on disk, so each is a no-op.
    assert_eq!(
        record_at(&ledger, activity(&chat, &id, Status::Saved), &emit),
        Recorded::default()
    );
    assert_eq!(seen.lock().unwrap().len(), 1);
    assert_eq!(lines(&chat).len(), 1);
    assert_eq!(lines(&chat)[0]["text"], "A decision and why.");
}

#[test]
fn a_saved_line_is_never_undone_and_uncertain_moves_only_on_its_own_receipt() {
    let ledger = scratch_ledger();
    let chat = unique("fwd");
    let (seen, emit) = capture();
    let saved = fresh_id();
    record_at(&ledger, activity(&chat, &saved, Status::Saved), &emit);
    // A later failure or doubt under the same id changes nothing.
    record_at(&ledger, activity(&chat, &saved, Status::Failed), &emit);
    record_at(&ledger, activity(&chat, &saved, Status::Uncertain), &emit);

    let doubtful = fresh_id();
    record_at(
        &ledger,
        activity(&chat, &doubtful, Status::Uncertain),
        &emit,
    );
    // "Saved" for a DIFFERENT receipt is not evidence about this one.
    let mut other = activity(&chat, &doubtful, Status::Saved);
    other.receipt_id = Some(fresh_id());
    record_at(&ledger, other, &emit);
    record_at(&ledger, activity(&chat, &doubtful, Status::Saved), &emit);

    let statuses: Vec<_> = seen
        .lock()
        .unwrap()
        .iter()
        .map(|(_, e)| {
            (
                e["id"].as_str().unwrap() == saved,
                e["status"].as_str().unwrap().to_owned(),
            )
        })
        .collect();
    assert_eq!(
        statuses,
        [
            (true, "saved".to_owned()),
            (false, "uncertain".to_owned()),
            (false, "saved".to_owned()),
        ]
    );
}

#[test]
fn a_coordinator_hears_that_a_worker_saved_but_not_what() {
    let ledger = scratch_ledger();
    let worker = unique("orch-worker");
    let coordinator = unique("coord");
    let owner = Owner {
        coordinator_chat_key: coordinator.clone(),
        task_id: "task_1".into(),
        task_title: "Fix it".into(),
        run_id: "run_1".into(),
    };
    let (_, emit) = capture();
    // A failure stays in the worker chat.
    let mut failed = activity(&worker, &fresh_id(), Status::Failed);
    failed.owner = Some(owner.clone());
    assert_eq!(
        record_at(&ledger, failed, &emit).shown,
        vec![worker.clone()]
    );
    let mut saved = activity(&worker, &fresh_id(), Status::Saved);
    saved.owner = Some(owner.clone());
    assert_eq!(
        record_at(&ledger, saved.clone(), &emit).shown,
        vec![worker.clone(), coordinator.clone()]
    );
    // Deduplicated per destination.
    assert!(record_at(&ledger, saved.clone(), &emit).shown.is_empty());
    let noted = lines(&coordinator);
    assert_eq!(noted.len(), 1);
    assert_eq!(noted[0]["source"]["chatKey"], worker.as_str());
    assert_eq!(noted[0]["source"]["taskTitle"], "Fix it");
    assert_eq!(noted[0]["agent"]["name"], "Mango Juice");
    assert!(noted[0].get("text").is_none() && noted[0].get("note").is_none());
    assert!(!noted[0].to_string().contains("A decision and why."));

    // The coordinator is re-checked at delivery: a line not yet delivered
    // does not go to a coordinator the worker no longer belongs to.
    let id = fresh_id();
    let mut doubtful = activity(&worker, &id, Status::Uncertain);
    doubtful.owner = Some(owner.clone());
    assert_eq!(
        record_at(&ledger, doubtful, &emit).shown,
        vec![worker.clone()]
    );
    let settled = activity(&worker, &id, Status::Saved);
    assert_eq!(
        record_at(&ledger, settled, &emit).shown,
        vec![worker.clone()]
    );
    assert_eq!(lines(&coordinator).len(), 1);
}

#[test]
fn a_line_written_before_a_crash_is_confirmed_not_repeated() {
    let ledger = scratch_ledger();
    let chat = unique("crash");
    let id = fresh_id();
    let line = activity(&chat, &id, Status::Saved);
    // The process wrote the intent and the transcript line, then died
    // before confirming it.
    {
        let mut book = load(&ledger);
        let entry = book.entries.entry(id.clone()).or_default();
        entry.activity = Some(line.clone());
        entry.pending.insert(chat.clone(), Status::Saved);
        save(&ledger, &book).unwrap();
    }
    crate::transcript::append(&chat, &origin_event(&line));
    let (seen, emit) = capture();
    assert_eq!(record_at(&ledger, line.clone(), &emit), Recorded::default());
    assert!(seen.lock().unwrap().is_empty());
    assert_eq!(lines(&chat).len(), 1);
    assert!(load(&ledger).entries[&id].pending.is_empty());
    // And it stays confirmed.
    assert_eq!(record_at(&ledger, line, &emit), Recorded::default());
}

#[test]
fn a_line_the_transcript_refused_is_written_by_the_next_report_once() {
    let ledger = scratch_ledger();
    let chat = unique("refused-disk");
    let line = activity(&chat, &fresh_id(), Status::Saved);
    // The disk refused the line: it reached only the live stream, and
    // the answer says so rather than calling it shown.
    let dropped = |_: &str, _: Value| None;
    let first = record_at(&ledger, line.clone(), dropped);
    assert!(first.shown.is_empty());
    assert_eq!(first.pending, vec![chat.clone()]);
    assert!(first.problem().unwrap().contains("could not be synced"));
    assert!(lines(&chat).is_empty());
    let (_, emit) = capture();
    assert_eq!(
        record_at(&ledger, line.clone(), &emit).shown,
        vec![chat.clone()]
    );
    assert_eq!(record_at(&ledger, line, &emit), Recorded::default());
    assert_eq!(lines(&chat).len(), 1);
}

#[test]
fn different_chats_with_the_same_request_id_are_different_lines() {
    let ledger = scratch_ledger();
    let a = unique("a");
    let b = unique("b");
    let (seen, emit) = capture();
    record_at(&ledger, activity(&a, &fresh_id(), Status::Saved), &emit);
    record_at(&ledger, activity(&b, &fresh_id(), Status::Saved), &emit);
    let seen = seen.lock().unwrap();
    assert_eq!(seen.len(), 2);
    assert_eq!(seen[0].0, a);
    assert_eq!(seen[1].0, b);
    assert_ne!(seen[0].1["id"], seen[1].1["id"]);
}

#[test]
fn a_saved_receipt_check_settles_an_uncertain_line_of_the_same_chat_only() {
    let file = crate::test_dir::TestPath::new("memact", "orchestrations.json");
    let store = OrchestrationStore::load(file.to_path_buf());
    let ledger = scratch_ledger();
    let checked = |chat: &str, receipt: &Value| receipt_checked_at(&ledger, &store, chat, receipt);
    let chat = unique("unc");
    let other = unique("other");
    let id = fresh_id();
    record_at(&ledger, activity(&chat, &id, Status::Uncertain), deliver);
    let receipt = json!({"id": id, "status": "saved"});
    // Another chat cannot settle it, and a still-uncertain answer does not.
    assert_eq!(checked(&other, &receipt), Recorded::default());
    assert_eq!(
        checked(&chat, &json!({"id": id, "status": "needs_review"})),
        Recorded::default()
    );
    assert_eq!(checked(&chat, &receipt).shown, vec![chat.clone()]);
    assert_eq!(checked(&chat, &receipt), Recorded::default());
    let shown = lines(&chat);
    assert_eq!(shown.len(), 2);
    assert_eq!(shown[1]["status"], "saved");
    assert_eq!(shown[1]["id"], shown[0]["id"]);
    assert_eq!(shown[1]["text"], "A decision and why.");
    assert!(shown[1]["error"].is_null());
}

/// A disposable vault, team and orchestration ledger — nothing here
/// touches the person's own profile or memory.
struct World {
    base: crate::test_dir::TestDir,
    root: PathBuf,
    vault: crate::memory_vault::Vault,
    team: PathBuf,
    store: OrchestrationStore,
    /// This world's own activity ledger, so nothing another test does
    /// to its ledger (filling it past KEEP, say) can reach this one.
    ledger: PathBuf,
    /// The instant and zone calls are made at; the real clock if unset.
    clock: Mutex<Option<LocalNow>>,
}

impl World {
    fn new(writable: bool) -> Self {
        let base = crate::test_dir::TestDir::new("memory-activity");
        let root = base.join("vault");
        fs::create_dir_all(&root).unwrap();
        let vault = crate::memory_vault::Vault::at(base.join("profile"));
        vault
            .configure(crate::memory_vault::Config {
                path: root.to_string_lossy().into_owned(),
                writable,
            })
            .unwrap();
        let store = OrchestrationStore::load(base.join("orchestrations.json"));
        Self {
            team: base.join("team.json"),
            ledger: base.join("memory-activity.json"),
            base,
            root,
            vault,
            store,
            clock: Mutex::new(None),
        }
    }

    /// Stand at `ms` in a zone `offset_secs` from UTC.
    fn at(&self, ms: i64, offset_secs: i32) {
        *self.clock.lock().unwrap() = Some(LocalNow { ms, offset_secs });
    }

    /// A restart: whatever the ledger says is owed, checked against this
    /// world's orchestration ledger as it stands.
    fn recover(&self) -> Recorded {
        recover_at(&self.ledger, |c| current_owner(&self.store, c), deliver)
    }

    fn agent(&self, name: &str) -> TeamAgent {
        crate::team::save(
            &self.team,
            crate::team::TeamDraft {
                id: None,
                name: name.into(),
                role: "builds things".into(),
                agent: crate::agent_chat::ChatAgent::Claude,
                model: "sonnet".into(),
                effort: None,
                access: None,
                project_id: None,
                reports_to: None,
                avatar: None,
                team_id: None,
                persistent_prompt: None,
                desktop_tools: None,
                worker_servers: None,
            },
        )
        .unwrap()
    }

    /// A direct chat with `agent` as its lead.
    fn lead(&self, agent: &TeamAgent) -> String {
        let chat = unique("ordinary-lead");
        crate::team::brief(&self.team, &chat, "p1", &agent.id, "Do it", false, &[]).unwrap();
        index(&chat);
        chat
    }

    fn call(&self, chat: &str, op: &str, tool: Value) -> Result<Value, String> {
        self.call_as(&self.store, chat, op, tool)
    }

    fn call_as(
        &self,
        store: &OrchestrationStore,
        chat: &str,
        op: &str,
        tool: Value,
    ) -> Result<Value, String> {
        let now = self.clock.lock().unwrap().unwrap_or_else(LocalNow::system);
        agent_memory_in(
            Some(&self.ledger),
            &self.vault,
            &self.team,
            store,
            chat,
            op,
            &tool,
            now,
        )
    }

    /// The receipt file the vault keeps for `receipt`.
    fn receipt_file(&self, receipt: &Value) -> PathBuf {
        self.base
            .join("profile/memory-vault-receipts")
            .join(format!("{}.json", receipt["id"].as_str().unwrap()))
    }

    /// Rewrite a stored receipt, as time or a crash would have left it.
    fn edit_receipt(&self, receipt: &Value, edit: impl FnOnce(&mut Value)) {
        let file = self.receipt_file(receipt);
        let mut stored: Value = serde_json::from_slice(&fs::read(&file).unwrap()).unwrap();
        edit(&mut stored);
        fs::write(&file, serde_json::to_vec(&stored).unwrap()).unwrap();
    }

    fn note(&self, agent: &TeamAgent) -> String {
        fs::read_to_string(self.root.join(agent.memory_note.as_ref().unwrap())).unwrap_or_default()
    }

    /// A run coordinated from its own chat, with one task for `agent`
    /// and a worker attempt reserved for it. Returns (coordinator, worker).
    fn worker(&self, agent: &TeamAgent, title: &str) -> (String, String) {
        let coordinator = unique("coordinator");
        let run = self
            .store
            .create_run(
                coordinator.clone(),
                "Ship".into(),
                "ws".into(),
                "/tmp".into(),
                Some(2),
            )
            .unwrap();
        let task = self
            .store
            .create_task_for(
                &coordinator,
                run.id.clone(),
                title.into(),
                "Do it".into(),
                Vec::new(),
                None,
                None,
                Some(crate::orchestration::TaskAssignee {
                    id: agent.id.clone(),
                    name: agent.name.clone(),
                }),
                None,
            )
            .unwrap();
        let (_, _, attempt, _) = self
            .store
            .reserve_attempt(
                &coordinator,
                &crate::orchestration::tests::launch_for(&task.id),
            )
            .unwrap();
        index(&coordinator);
        index(&attempt.worker_chat_key);
        (coordinator, attempt.worker_chat_key)
    }
}

fn entry(text: &str, request: &str) -> Value {
    json!({"text": text, "date": "2026-09-28", "requestId": request})
}

fn index(chat: &str) {
    crate::chat_index::upsert(
        serde_json::from_value(json!({
            "id": chat.strip_prefix("chat:").unwrap(), "projectId": "p1",
        }))
        .unwrap(),
    )
    .unwrap();
}

#[test]
fn a_saved_append_is_one_attributed_line_and_an_identical_retry_writes_nothing() {
    let w = World::new(true);
    let mango = w.agent("Mango Juice");
    let chat = w.lead(&mango);
    let saved = w
        .call(&chat, "append", entry("Use the receipt, not prose.", "r1"))
        .unwrap();
    assert_eq!(saved["receipt"]["status"], "saved");
    let shown = lines(&chat);
    assert_eq!(shown.len(), 1);
    let line = &shown[0];
    assert_eq!(line["status"], "saved");
    assert_eq!(line["id"], saved["receipt"]["id"], "keyed by the receipt");
    assert_eq!(line["agent"]["name"], "Mango Juice");
    assert_eq!(line["text"], "Use the receipt, not prose.");
    assert_eq!(line["note"], mango.memory_note.as_deref().unwrap());
    assert_eq!(line["receipt"]["id"], saved["receipt"]["id"]);
    assert_eq!(line["receipt"]["status"], "saved");
    // The vault's own folder is the person's business, not the chat's.
    assert!(!line.to_string().contains(&*w.root.to_string_lossy()));

    // The agent never heard back and asks again, word for word: the host
    // answers from the receipt. At 536ef33 this failed with "requestId was
    // already used for a different operation", because the retry re-read
    // the note's revision, which the first append had moved on.
    let again = w
        .call(&chat, "append", entry("Use the receipt, not prose.", "r1"))
        .unwrap();
    assert_eq!(again["alreadySaved"], true);
    assert_eq!(again["receipt"]["id"], saved["receipt"]["id"]);
    assert_eq!(
        w.note(&mango)
            .matches("Use the receipt, not prose.")
            .count(),
        1
    );
    assert_eq!(lines(&chat).len(), 1);

    // Different words — or a different date — under the same id are
    // refused, change nothing, and never touch the saved line. What they
    // say is that THIS call was refused and the earlier entry is saved:
    // two states, neither of them "not updated".
    for (text, date) in [
        ("Something else.", "2026-09-28"),
        ("Use the receipt, not prose.", "2026-09-29"),
    ] {
        let error = w
            .call(
                &chat,
                "append",
                json!({"text": text, "date": date, "requestId": "r1"}),
            )
            .unwrap_err();
        assert!(
            error.contains("This call was refused and wrote nothing"),
            "{error}"
        );
        assert!(error.contains("earlier entry is saved"), "{error}");
    }
    assert!(!w.note(&mango).contains("Something else."));
    assert_eq!(w.note(&mango).matches("## 2026-09-29").count(), 0);
    let shown = lines(&chat);
    assert_eq!(shown.len(), 3);
    assert_eq!(shown[0]["status"], "saved");
    for refused in &shown[1..] {
        assert_eq!(refused["status"], "refused");
        assert_ne!(refused["id"], shown[0]["id"]);
        assert_eq!(refused["earlier"]["id"], saved["receipt"]["id"]);
        assert_eq!(refused["earlier"]["status"], "saved");
        assert!(refused["receipt"].is_null(), "this call made no receipt");
    }

    // Reading is not writing.
    let before = lines(&chat).len();
    w.call(&chat, "read", json!({})).unwrap();
    assert_eq!(lines(&chat).len(), before);
}

#[test]
fn a_retry_without_a_date_repeats_the_first_calls_date() {
    let w = World::new(true);
    let mango = w.agent("Mango Juice");
    let chat = w.lead(&mango);
    w.call(&chat, "append", entry("Dated once.", "r1")).unwrap();
    // The retry leaves the date out, as if a day had passed: the host
    // repeats the date the write was made with instead of guessing.
    let again = w
        .call(
            &chat,
            "append",
            json!({"text": "Dated once.", "requestId": "r1"}),
        )
        .unwrap();
    assert_eq!(again["alreadySaved"], true);
    assert_eq!(w.note(&mango).matches("Dated once.").count(), 1);
    assert_eq!(lines(&chat).len(), 1);
}

#[test]
fn concurrent_identical_retries_append_once() {
    let w = std::sync::Arc::new(World::new(true));
    let mango = w.agent("Mango Juice");
    let chat = w.lead(&mango);
    let handles: Vec<_> = (0..6)
        .map(|_| {
            let (w, chat) = (w.clone(), chat.clone());
            std::thread::spawn(move || w.call(&chat, "append", entry("Only once.", "r1")))
        })
        .collect();
    for handle in handles {
        let result = handle.join().unwrap().unwrap();
        assert_eq!(result["receipt"]["status"], "saved");
    }
    assert_eq!(w.note(&mango).matches("Only once.").count(), 1);
    assert_eq!(lines(&chat).len(), 1);
}

#[test]
fn a_save_whose_line_was_never_drawn_is_drawn_by_its_retry() {
    let w = World::new(true);
    let mango = w.agent("Mango Juice");
    let chat = w.lead(&mango);
    // Saved by a server that died before it could draw the line...
    let first = crate::team::memory_append(
        &w.vault,
        &chat,
        &mango,
        "Crash gap.",
        Some("2026-09-28"),
        "r1",
    );
    let receipt = first.result(&mango).unwrap()["receipt"].clone();
    // ...and before the receipt itself said saved.
    let file = w
        .base
        .join("profile/memory-vault-receipts")
        .join(format!("{}.json", receipt["id"].as_str().unwrap()));
    let mut pending: Value = serde_json::from_slice(&fs::read(&file).unwrap()).unwrap();
    pending["status"] = "pending".into();
    fs::write(&file, serde_json::to_vec(&pending).unwrap()).unwrap();
    assert!(lines(&chat).is_empty());

    let again = w.call(&chat, "append", entry("Crash gap.", "r1")).unwrap();
    assert_eq!(again["alreadySaved"], true);
    assert_eq!(again["receipt"]["status"], "saved");
    assert_eq!(w.note(&mango).matches("Crash gap.").count(), 1);
    let shown = lines(&chat);
    assert_eq!(shown.len(), 1);
    assert_eq!(shown[0]["status"], "saved");
}

#[test]
fn the_same_request_in_another_vault_is_another_line() {
    let w = World::new(true);
    let mango = w.agent("Mango Juice");
    let chat = w.lead(&mango);
    let first = w
        .call(&chat, "append", entry("First vault.", "r1"))
        .unwrap();
    let elsewhere = w.base.join("vault-2");
    fs::create_dir_all(&elsewhere).unwrap();
    w.vault
        .configure(crate::memory_vault::Config {
            path: elsewhere.to_string_lossy().into_owned(),
            writable: true,
        })
        .unwrap();
    let second = w
        .call(&chat, "append", entry("First vault.", "r1"))
        .unwrap();
    assert_ne!(first["receipt"]["id"], second["receipt"]["id"]);
    assert!(second.get("alreadySaved").is_none());
    let shown = lines(&chat);
    assert_eq!(shown.len(), 2);
    assert_ne!(shown[0]["id"], shown[1]["id"]);
}

#[test]
fn a_refused_or_failed_append_is_never_drawn_as_saved() {
    let w = World::new(false);
    let mango = w.agent("Mango Juice");
    let chat = w.lead(&mango);
    let error = w.call(&chat, "append", entry("Nope.", "r1")).unwrap_err();
    assert!(error.contains("writes are off"), "{error}");
    let shown = lines(&chat);
    assert_eq!(shown.len(), 1);
    assert_eq!(shown[0]["status"], "failed");
    assert_eq!(shown[0]["agent"]["name"], "Mango Juice");
    assert!(shown[0]["receipt"].is_null());
    assert_eq!(shown[0]["error"], error.as_str());
    // The same failure reported twice is still one line.
    w.call(&chat, "append", entry("Nope.", "r1")).unwrap_err();
    assert_eq!(lines(&chat).len(), 1);
    // Nothing to remember is refused before the vault: its own line.
    w.call(&chat, "append", entry("   ", "r1")).unwrap_err();
    assert_eq!(lines(&chat).len(), 2);
    assert_eq!(lines(&chat)[1]["status"], "failed");

    // Writes turned on, the same requestId saves — as its own line; the
    // refusal above stays a refusal.
    w.vault
        .configure(crate::memory_vault::Config {
            path: w.root.to_string_lossy().into_owned(),
            writable: true,
        })
        .unwrap();
    w.call(&chat, "append", entry("Nope.", "r1")).unwrap();
    let shown = lines(&chat);
    assert_eq!(shown.len(), 3);
    assert_eq!(shown[0]["status"], "failed");
    assert_eq!(shown[2]["status"], "saved");

    // A chat no registered agent runs has no memory, and no name is made up.
    let stranger = unique("stranger");
    let error = w
        .call(&stranger, "append", entry("Who am I?", "r1"))
        .unwrap_err();
    assert!(error.contains("registered agent"), "{error}");
    let shown = lines(&stranger);
    assert_eq!(shown.len(), 1);
    assert_eq!(shown[0]["status"], "failed");
    assert!(shown[0]["agent"].is_null());
    // A read that fails draws nothing.
    w.call(&stranger, "read", json!({})).unwrap_err();
    assert_eq!(lines(&stranger).len(), 1);
}

#[cfg(unix)]
#[test]
fn a_write_that_may_or_may_not_have_landed_is_uncertain_not_saved_or_failed() {
    use std::os::unix::fs::PermissionsExt;
    let w = World::new(true);
    let mango = w.agent("Mango Juice");
    let chat = w.lead(&mango);
    // The note exists, then its folder stops taking writes, so the vault's
    // write fails after its receipt was recorded.
    crate::team::ensure_memory(&w.vault, &chat, &mango).unwrap();
    let folder = w
        .root
        .join(mango.memory_note.as_ref().unwrap())
        .parent()
        .unwrap()
        .to_owned();
    fs::set_permissions(&folder, fs::Permissions::from_mode(0o555)).unwrap();
    let error = w.call(&chat, "append", entry("Maybe.", "r1")).unwrap_err();
    let again = w.call(&chat, "append", entry("Maybe.", "r1")).unwrap_err();
    fs::set_permissions(&folder, fs::Permissions::from_mode(0o755)).unwrap();
    assert!(error.contains("needs review"), "{error}");
    assert!(again.contains("needs review"), "{again}");
    let shown = lines(&chat);
    assert_eq!(
        shown.len(),
        1,
        "a retry of an uncertain write is the same line"
    );
    assert_eq!(shown[0]["status"], "uncertain");
    assert_eq!(shown[0]["receipt"]["status"], "needs_review");
    assert!(!w.note(&mango).contains("Maybe."));
}

#[test]
fn a_workers_save_is_noted_in_its_coordinator_chat_and_nowhere_else() {
    let w = World::new(true);
    let mango = w.agent("Mango Juice");
    let (coordinator, worker) = w.worker(&mango, "Show memory updates");
    let bystander = unique("bystander");

    // Whatever the tool's arguments claim, the chat is the capability's.
    let mut spoofed = entry("Workers report through the host.", "r1");
    spoofed["chatKey"] = coordinator.clone().into();
    spoofed["agent"] = "Potato Juice".into();
    w.call(&worker, "append", spoofed.clone()).unwrap();
    w.call(&worker, "append", spoofed).unwrap();

    let own = lines(&worker);
    assert_eq!(own.len(), 1);
    assert_eq!(own[0]["agent"]["name"], "Mango Juice");
    assert_eq!(own[0]["text"], "Workers report through the host.");
    let noted = lines(&coordinator);
    assert_eq!(noted.len(), 1);
    assert_eq!(noted[0]["id"], own[0]["id"]);
    assert_eq!(noted[0]["source"]["chatKey"], worker.as_str());
    assert_eq!(noted[0]["source"]["taskTitle"], "Show memory updates");
    assert!(!noted[0]
        .to_string()
        .contains("Workers report through the host."));
    assert!(lines(&bystander).is_empty());

    // A coordinator chat that is gone gets nothing; the worker still does.
    crate::chat_index::remove(coordinator.strip_prefix("chat:").unwrap()).unwrap();
    w.call(&worker, "append", entry("Second.", "r2")).unwrap();
    assert_eq!(lines(&worker).len(), 2);
    assert_eq!(lines(&coordinator).len(), 1);
}

const DAY: i64 = 86_400_000;

/// 2026-09-29T00:00:00Z.
const MIDNIGHT_UTC: i64 = 1_790_640_000_000;

/// The zones the date is checked in, with their offset on 2026-09-28/29
/// (Los Angeles is on daylight time then). `team::tests` checks the same
/// offsets come out of the OS's own zone database.
const ZONES: [(&str, i32); 4] = [
    ("UTC", 0),
    ("Asia/Kuala_Lumpur", 8 * 3600),
    ("Pacific/Kiritimati", 14 * 3600),
    ("America/Los_Angeles", -7 * 3600),
];

/// Local midnight at the start of 2026-09-29 in a zone, in UTC ms.
fn local_midnight(offset_secs: i32) -> i64 {
    MIDNIGHT_UTC - i64::from(offset_secs) * 1000
}

fn undated(text: &str, request: &str) -> Value {
    json!({"text": text, "requestId": request})
}

/// Saved by a server that died before it recorded any activity: the note
/// and the receipt are on disk, the ledger and the transcript know nothing.
fn saved_then_crashed(w: &World, chat: &str, me: &TeamAgent, text: &str, date: &str) -> Value {
    let first = crate::team::memory_append(&w.vault, chat, me, text, Some(date), "r1");
    first.result(me).unwrap()["receipt"].clone()
}

#[test]
fn an_undated_entry_takes_the_local_date_on_either_side_of_local_midnight() {
    for (zone, offset) in ZONES {
        let w = World::new(true);
        let mango = w.agent("Mango Juice");
        let chat = w.lead(&mango);
        let midnight = local_midnight(offset);
        w.at(midnight - 30_000, offset);
        let late = w.call(&chat, "append", undated("Late.", "r1")).unwrap();
        w.at(midnight + 30_000, offset);
        w.call(&chat, "append", undated("Early.", "r2")).unwrap();
        let shown = lines(&chat);
        assert_eq!(shown.len(), 2, "{zone}");
        assert_eq!(shown[0]["date"], "2026-09-28", "{zone}");
        assert_eq!(shown[1]["date"], "2026-09-29", "{zone}");
        // The receipt keeps the date the entry was written under.
        assert_eq!(late["receipt"]["entryDate"], "2026-09-28", "{zone}");
        let note = w.note(&mango);
        assert!(note.contains("## 2026-09-28\n\nLate."), "{zone}: {note}");
        assert!(note.contains("## 2026-09-29\n\nEarly."), "{zone}: {note}");
    }
}

// F1 — at 12016c9 a retry across midnight failed with "different
// operation" and drew a "not updated" line over a saved write. Nothing
// here passes a date or edits a receipt: the clock is the only input.
#[test]
fn an_undated_retry_after_local_midnight_is_the_same_save_in_every_zone() {
    for (zone, offset) in ZONES {
        let w = World::new(true);
        let mango = w.agent("Mango Juice");
        let chat = w.lead(&mango);
        let midnight = local_midnight(offset);
        // Saved just before local midnight with the date left out, by a
        // server that died before it recorded any activity…
        let first = crate::team::memory_append_at(
            &w.vault,
            &chat,
            &mango,
            "Crossed midnight.",
            None,
            "r1",
            LocalNow {
                ms: midnight - 30_000,
                offset_secs: offset,
            },
        );
        assert_eq!(first.date.as_deref(), Some("2026-09-28"), "{zone}");
        let receipt = first.result(&mango).unwrap()["receipt"].clone();
        assert!(!w.ledger.exists(), "no activity was ever recorded");

        // …and retried just after it, still without one.
        w.at(midnight + 30_000, offset);
        let again = w
            .call(&chat, "append", undated("Crossed midnight.", "r1"))
            .unwrap();
        assert_eq!(again["alreadySaved"], true, "{zone}");
        assert_eq!(again["receipt"]["id"], receipt["id"], "{zone}");
        let shown = lines(&chat);
        assert_eq!(shown.len(), 1, "{zone}");
        assert_eq!(shown[0]["status"], "saved", "{zone}");
        assert_eq!(
            shown[0]["date"], "2026-09-28",
            "{zone}: the entry's own date"
        );
        let note = w.note(&mango);
        assert_eq!(note.matches("Crossed midnight.").count(), 1, "{zone}");
        assert_eq!(note.matches("## 2026-09-28").count(), 1, "{zone}");
        assert_eq!(note.matches("## 2026-09-29").count(), 0, "{zone}");

        // Restart after restart, with or without the ledger: still one line.
        for forget in [false, true, true] {
            if forget {
                fs::remove_file(&w.ledger).unwrap();
            }
            w.call(&chat, "append", undated("Crossed midnight.", "r1"))
                .unwrap();
        }
        assert_eq!(lines(&chat).len(), 1, "{zone}");

        // Other words under the same id: this call is refused, and the
        // line says the earlier entry is saved — never "not updated".
        let error = w
            .call(&chat, "append", undated("Something else.", "r1"))
            .unwrap_err();
        assert!(error.contains("refused and wrote nothing"), "{error}");
        assert!(error.contains("earlier entry is saved"), "{error}");
        assert!(!w.note(&mango).contains("Something else."));
        let shown = lines(&chat);
        assert_eq!(shown.len(), 2, "{zone}");
        assert_eq!(shown[0]["status"], "saved");
        assert_eq!(shown[1]["status"], "refused");
        assert_eq!(shown[1]["earlier"]["id"], receipt["id"]);
        assert_eq!(shown[1]["earlier"]["status"], "saved");
        assert!(shown[1]["date"].is_null(), "no date is guessed for it");
    }
}

// F1 — a receipt an earlier build left kept no date. Its entry was dated
// that build's way (UTC) or the local way, so it may be the receipt's UTC
// day, the one before or the one after; only the stored request hash says
// which, and nothing else is ever taken.
#[test]
fn a_receipt_that_kept_no_date_is_matched_only_by_its_request_hash() {
    for (zone, offset) in ZONES {
        let midnight = local_midnight(offset);
        let made = midnight - 30_000;
        for date in ["2026-09-28".to_owned(), crate::team::utc_date(made)] {
            let w = World::new(true);
            let mango = w.agent("Mango Juice");
            let chat = w.lead(&mango);
            let receipt = saved_then_crashed(&w, &chat, &mango, "Old build.", &date);
            w.edit_receipt(&receipt, |r| {
                r.as_object_mut().unwrap().remove("entryDate").unwrap();
                r["createdAt"] = json!(made);
            });
            w.at(midnight + 30_000, offset);
            let again = w
                .call(&chat, "append", undated("Old build.", "r1"))
                .unwrap();
            assert_eq!(again["alreadySaved"], true, "{zone} {date}");
            let shown = lines(&chat);
            assert_eq!(shown.len(), 1, "{zone} {date}");
            assert_eq!(shown[0]["status"], "saved");
            assert_eq!(shown[0]["date"], date.as_str());
            assert_eq!(w.note(&mango).matches("Old build.").count(), 1);
        }

        // A date the receipt cannot prove is not guessed into success, and
        // the saved entry is not called unsaved either.
        let w = World::new(true);
        let mango = w.agent("Mango Juice");
        let chat = w.lead(&mango);
        let receipt = saved_then_crashed(&w, &chat, &mango, "Dated long ago.", "2026-01-02");
        w.edit_receipt(&receipt, |r| {
            r.as_object_mut().unwrap().remove("entryDate").unwrap();
            r["createdAt"] = json!(made);
        });
        w.at(midnight + 30_000, offset);
        let error = w
            .call(&chat, "append", undated("Dated long ago.", "r1"))
            .unwrap_err();
        assert!(error.contains("refused and wrote nothing"), "{error}");
        assert!(error.contains("earlier entry is saved"), "{error}");
        assert!(!error.contains("no date its receipt allows"), "{error}");
        let shown = lines(&chat);
        assert_eq!(shown.len(), 1, "{zone}");
        assert_eq!(shown[0]["status"], "refused");
        assert_ne!(shown[0]["id"], receipt["id"]);
        assert_eq!(shown[0]["earlier"]["id"], receipt["id"]);
        assert_eq!(shown[0]["earlier"]["status"], "saved");
        assert_eq!(w.note(&mango).matches("Dated long ago.").count(), 1);

        // Asked with its real date, the same write is recognised and shown.
        let again = w
            .call(
                &chat,
                "append",
                json!({"text": "Dated long ago.", "date": "2026-01-02", "requestId": "r1"}),
            )
            .unwrap();
        assert_eq!(again["alreadySaved"], true);
        let shown = lines(&chat);
        assert_eq!(shown.len(), 2);
        assert_eq!(shown[1]["status"], "saved");
        assert_eq!(shown[1]["id"], receipt["id"]);
        assert_eq!(shown[0]["status"], "refused", "the refusal stays a refusal");
    }
}

/// Key `receipt` under the id the vault's legacy root spelling gave it,
/// as a Windows vault saved before paths were simplified left it.
fn move_to_legacy_id(w: &World, chat: &str, receipt: &Value, legacy_root: &Path) -> String {
    let legacy_id = crate::memory_vault::receipt_id_under(chat, legacy_root, "r1");
    assert_ne!(receipt["id"], legacy_id.as_str());
    let file = w.receipt_file(receipt);
    let mut stored: Value = serde_json::from_slice(&fs::read(&file).unwrap()).unwrap();
    stored["id"] = json!(legacy_id);
    fs::write(
        file.with_file_name(format!("{legacy_id}.json")),
        serde_json::to_vec(&stored).unwrap(),
    )
    .unwrap();
    fs::remove_file(file).unwrap();
    legacy_id
}

const LEGACY_ROOT: &str = r"\\?\C:\Works\Obsidian\Pandaworks-docspace";

// After the upgrade that simplified Windows vault paths, a memory entry
// saved before it is found under its old receipt id by the retry check as
// well as by the write, so an undated retry is the same save — not a new
// entry and not a "different operation" refusal.
#[test]
fn an_undated_retry_finds_a_save_kept_under_the_legacy_root_id() {
    let w = World::new(true);
    let mango = w.agent("Mango Juice");
    let chat = w.lead(&mango);
    let receipt = saved_then_crashed(&w, &chat, &mango, "Before the upgrade.", "2026-09-28");
    assert_eq!(receipt["entryDate"], "2026-09-28");
    let legacy_id = move_to_legacy_id(&w, &chat, &receipt, Path::new(LEGACY_ROOT));

    w.at(MIDNIGHT_UTC + 86_400_000, 0);
    let again = crate::memory_vault::with_legacy_root(Path::new(LEGACY_ROOT), || {
        w.call(&chat, "append", undated("Before the upgrade.", "r1"))
    })
    .unwrap();
    assert_eq!(again["alreadySaved"], true);
    assert_eq!(again["receipt"]["id"], legacy_id.as_str());
    assert_eq!(again["receipt"]["entryDate"], "2026-09-28");
    let note = w.note(&mango);
    assert_eq!(note.matches("Before the upgrade.").count(), 1, "{note}");
    assert_eq!(note.matches("## 2026-09-28").count(), 1, "{note}");
    let shown = lines(&chat);
    assert_eq!(shown.len(), 1);
    assert_eq!(shown[0]["status"], "saved");
    assert_eq!(shown[0]["id"], legacy_id.as_str());
    assert_eq!(shown[0]["date"], "2026-09-28", "the stored entry date");
}

// A receipt from before both changes — no entry date, and keyed under the
// legacy root id — is still recognised only by its request hash.
#[test]
fn a_legacy_receipt_that_kept_no_date_is_matched_only_by_its_request_hash() {
    let made = MIDNIGHT_UTC - 30_000;
    for (date, same) in [
        (crate::team::utc_date(made), true),
        ("2026-01-02".to_owned(), false),
    ] {
        let w = World::new(true);
        let mango = w.agent("Mango Juice");
        let chat = w.lead(&mango);
        let receipt = saved_then_crashed(&w, &chat, &mango, "Old build.", &date);
        w.edit_receipt(&receipt, |r| {
            r.as_object_mut().unwrap().remove("entryDate").unwrap();
            r["createdAt"] = json!(made);
        });
        let legacy_id = move_to_legacy_id(&w, &chat, &receipt, Path::new(LEGACY_ROOT));
        w.at(MIDNIGHT_UTC + 30_000, 0);
        let result = crate::memory_vault::with_legacy_root(Path::new(LEGACY_ROOT), || {
            w.call(&chat, "append", undated("Old build.", "r1"))
        });
        let shown = lines(&chat);
        assert_eq!(shown.len(), 1, "{date}");
        assert_eq!(w.note(&mango).matches("Old build.").count(), 1, "{date}");
        if same {
            let again = result.unwrap();
            assert_eq!(again["alreadySaved"], true, "{date}");
            assert_eq!(again["receipt"]["id"], legacy_id.as_str());
            assert_eq!(shown[0]["status"], "saved");
            assert_eq!(shown[0]["id"], legacy_id.as_str());
            assert_eq!(shown[0]["date"], date.as_str());
        } else {
            // Not guessed into success, and the saved entry is not called
            // unsaved: this call is refused, the earlier entry stands.
            let error = result.unwrap_err();
            assert!(error.contains("refused and wrote nothing"), "{error}");
            assert!(error.contains("earlier entry is saved"), "{error}");
            assert_eq!(shown[0]["status"], "refused");
            assert_eq!(shown[0]["earlier"]["id"], legacy_id.as_str());
            assert_eq!(shown[0]["earlier"]["status"], "saved");
        }
    }
}

// Startup restore — a line the ledger confirmed that its transcript has
// since lost (truncated, deleted, restored from an older backup) is
// written back at the next start, once, in the worker chat and in the
// coordinator chat, with no retry from the agent.
#[test]
fn a_restart_writes_back_each_confirmed_line_a_transcript_lost_and_nothing_twice() {
    let w = World::new(true);
    let mango = w.agent("Mango Juice");
    let (coordinator, worker) = w.worker(&mango, "Restore lines");
    let saved = w.call(&worker, "append", entry("Keep me.", "r1")).unwrap();
    let id = saved["receipt"]["id"].as_str().unwrap().to_owned();
    // Both lines are there: a restart writes nothing.
    assert_eq!(w.recover(), Recorded::default());
    assert_eq!(lines(&worker).len(), 1);
    assert_eq!(lines(&coordinator).len(), 1);

    // The worker's transcript is truncated and the coordinator's deleted.
    fs::write(crate::transcript::path_for(&worker).unwrap(), "").unwrap();
    fs::remove_file(crate::transcript::path_for(&coordinator).unwrap()).unwrap();
    crate::transcript::forget_count(&worker);
    crate::transcript::forget_count(&coordinator);
    let mut restored = w.recover().shown;
    restored.sort();
    let mut both = vec![worker.clone(), coordinator.clone()];
    both.sort();
    assert_eq!(restored, both);
    let own = lines(&worker);
    assert_eq!(own.len(), 1);
    assert_eq!(own[0]["id"], id.as_str());
    assert_eq!(own[0]["text"], "Keep me.");
    let noted = lines(&coordinator);
    assert_eq!(noted.len(), 1);
    assert_eq!(noted[0]["source"]["chatKey"], worker.as_str());
    assert!(noted[0].get("text").is_none());

    // Present again: another restart, and the agent's retry, add nothing.
    assert_eq!(w.recover(), Recorded::default());
    w.call(&worker, "append", entry("Keep me.", "r1")).unwrap();
    assert_eq!(lines(&worker).len(), 1);
    assert_eq!(lines(&coordinator).len(), 1);
    let record = &load(&w.ledger).entries[&id];
    assert!(record.pending.is_empty());
    assert_eq!(record.delivered.get(&worker), Some(&Status::Saved));
    assert_eq!(record.delivered.get(&coordinator), Some(&Status::Saved));
}

fn task_of(w: &World) -> crate::orchestration::Task {
    w.store.snapshot(None).unwrap().tasks.remove(0)
}

// The coordinator is read again after the vault has saved. In this host
// a run's coordinator chat never changes (Run.coordinator_chat_key is set
// at create_run and nothing writes it) and a task cannot change hands
// while its worker runs (reassign_task refuses a Preparing or Running
// attempt), so the case that happens is a coordinator chat deleted
// mid-save. The re-pointed run is forced through a test-only setter.
#[test]
fn a_chat_that_stops_being_the_coordinator_during_the_save_is_told_nothing() {
    let w = std::sync::Arc::new(World::new(true));
    let mango = w.agent("Mango Juice");
    let potato = w.agent("Potato Juice");
    let (coordinator, worker) = w.worker(&mango, "Moves");
    let task = task_of(&w);

    // A handoff tried during the save is refused, so the coordinator is
    // still this worker's and is told.
    let handoff: std::sync::Arc<Mutex<Option<Result<(), String>>>> = Default::default();
    {
        let (w, coordinator, task, handoff) = (
            w.clone(),
            coordinator.clone(),
            task.id.clone(),
            handoff.clone(),
        );
        let to = crate::orchestration::TaskAssignee {
            id: potato.id.clone(),
            name: potato.name.clone(),
        };
        faults::after_save(move || {
            let result = w.store.reassign_task(
                &coordinator,
                &task,
                (None, Some(to), None),
                "Hand on.".into(),
            );
            *handoff.lock().unwrap() = Some(result.map(|_| ()));
        });
    }
    w.call(&worker, "append", entry("Handoff tried.", "r1"))
        .unwrap();
    let tried = handoff.lock().unwrap().take().expect("the hook ran");
    assert!(tried.unwrap_err().contains("still working"));
    assert_eq!(task_of(&w).assignee.unwrap().id, mango.id);
    assert_eq!(lines(&coordinator).len(), 1);

    // The run is re-pointed while the vault writes: the old coordinator
    // hears nothing, the one it points at now does.
    let next = unique("next-coordinator");
    index(&next);
    {
        let (w, run, next) = (w.clone(), task.run_id.clone(), next.clone());
        faults::after_save(move || w.store.test_set_coordinator(&run, &next).unwrap());
    }
    w.call(&worker, "append", entry("Re-pointed.", "r2"))
        .unwrap();
    assert_eq!(
        lines(&coordinator).len(),
        1,
        "the old coordinator is not told"
    );
    assert_eq!(lines(&next).len(), 1);
    assert_eq!(lines(&worker).len(), 2);

    // The coordinator chat is deleted while the vault writes.
    {
        let next = next.clone();
        faults::after_save(move || {
            crate::chat_index::remove(next.strip_prefix("chat:").unwrap()).unwrap();
        });
    }
    w.call(&worker, "append", entry("Deleted.", "r3")).unwrap();
    assert_eq!(lines(&next).len(), 1);
    assert_eq!(lines(&worker).len(), 3);
}

// The same link is checked before a restart delivers or writes back a
// coordinator's line: owed to a chat that is no longer the coordinator,
// the intent is dropped and nothing is delivered.
#[test]
fn a_restart_gives_a_coordinator_its_line_only_while_it_still_is_one() {
    let w = World::new(true);
    let mango = w.agent("Mango Juice");
    let (coordinator, worker) = w.worker(&mango, "Owed lines");
    let run = task_of(&w).run_id;
    // Died right after the intents were stored: no line drawn anywhere.
    faults::crash_after(Some(1));
    let saved = w.call(&worker, "append", entry("Owed.", "r1")).unwrap();
    faults::crash_after(None);
    let id = saved["receipt"]["id"].as_str().unwrap().to_owned();
    let record = &load(&w.ledger).entries[&id];
    assert_eq!(record.pending.len(), 2);
    assert!(lines(&worker).is_empty() && lines(&coordinator).is_empty());

    let elsewhere = unique("elsewhere");
    index(&elsewhere);
    w.store.test_set_coordinator(&run, &elsewhere).unwrap();
    assert_eq!(w.recover().shown, vec![worker.clone()]);
    assert!(lines(&coordinator).is_empty());
    assert!(lines(&elsewhere).is_empty());
    let record = &load(&w.ledger).entries[&id];
    assert!(record.pending.is_empty(), "the stale intent is dropped");
    assert!(!record.delivered.contains_key(&coordinator));

    // A delivered line lost from a chat that has since stopped being the
    // coordinator is not written back, and not asked about again.
    w.store.test_set_coordinator(&run, &coordinator).unwrap();
    let second = w
        .call(&worker, "append", entry("Delivered.", "r2"))
        .unwrap();
    let second = second["receipt"]["id"].as_str().unwrap().to_owned();
    assert_eq!(lines(&coordinator).len(), 1);
    fs::write(crate::transcript::path_for(&coordinator).unwrap(), "").unwrap();
    crate::transcript::forget_count(&coordinator);
    w.store.test_set_coordinator(&run, &elsewhere).unwrap();
    assert_eq!(w.recover(), Recorded::default());
    assert!(lines(&coordinator).is_empty());
    assert!(!load(&w.ledger).entries[&second]
        .delivered
        .contains_key(&coordinator));
    assert_eq!(lines(&worker).len(), 2);
}

// Fault injection: the process dies after each durable step in turn —
// the intents stored, the worker's line written, its confirmation stored,
// the coordinator's line written, the final ledger stored — and restarts.
// Every time, each chat ends with exactly one line and nothing owed.
#[test]
fn a_crash_after_any_step_is_finished_by_the_restart_exactly_once() {
    let steps = {
        let w = World::new(true);
        let mango = w.agent("Mango Juice");
        let (_, worker) = w.worker(&mango, "Count steps");
        faults::crash_after(None);
        w.call(&worker, "append", entry("Counted.", "r1")).unwrap();
        faults::steps()
    };
    assert_eq!(steps, 5, "intents, line, confirmation, line, confirmation");
    for n in 1..=steps {
        let w = World::new(true);
        let mango = w.agent("Mango Juice");
        let (coordinator, worker) = w.worker(&mango, "Crash");
        faults::crash_after(Some(n));
        let saved = w.call(&worker, "append", entry("Crashed.", "r1")).unwrap();
        faults::crash_after(None);
        assert_eq!(saved["receipt"]["status"], "saved", "step {n}");
        let id = saved["receipt"]["id"].as_str().unwrap().to_owned();

        // Restart: the transcripts are counted afresh, the ledger reread.
        crate::transcript::forget_count(&worker);
        crate::transcript::forget_count(&coordinator);
        w.recover();
        assert_eq!(lines(&worker).len(), 1, "step {n}");
        assert_eq!(lines(&coordinator).len(), 1, "step {n}");
        let record = &load(&w.ledger).entries[&id];
        assert!(record.pending.is_empty(), "step {n}");
        assert_eq!(
            record.delivered.get(&worker),
            Some(&Status::Saved),
            "step {n}"
        );
        assert_eq!(
            record.delivered.get(&coordinator),
            Some(&Status::Saved),
            "step {n}"
        );
        // Another restart and the agent's retry change nothing.
        assert_eq!(w.recover(), Recorded::default(), "step {n}");
        w.call(&worker, "append", entry("Crashed.", "r1")).unwrap();
        assert_eq!(lines(&worker).len(), 1, "step {n}");
        assert_eq!(lines(&coordinator).len(), 1, "step {n}");
    }
}

// Storage failures are said in the answer and never confirmed.
#[test]
fn a_ledger_the_disk_refuses_is_said_and_nothing_is_confirmed_on_it() {
    let w = World::new(true);
    let mango = w.agent("Mango Juice");
    let chat = w.lead(&mango);

    // The intent cannot be stored: no line is drawn without one.
    faults::saves(&[false]);
    let saved = w.call(&chat, "append", entry("No intent.", "r1")).unwrap();
    faults::saves(&[]);
    assert_eq!(saved["receipt"]["status"], "saved");
    let said = saved["chatLine"].as_str().unwrap();
    assert!(said.contains("could not store the intent"), "{said}");
    assert!(lines(&chat).is_empty());
    // The retry finishes it.
    let again = w.call(&chat, "append", entry("No intent.", "r1")).unwrap();
    assert!(again.get("chatLine").is_none(), "{again}");
    assert_eq!(lines(&chat).len(), 1);

    // The line is written but its confirmation cannot be stored: the line
    // stands, the answer says so, and the ledger still says owed.
    faults::saves(&[true, false, false]);
    let saved = w
        .call(&chat, "append", entry("No confirmation.", "r2"))
        .unwrap();
    faults::saves(&[]);
    let said = saved["chatLine"].as_str().unwrap();
    assert!(
        said.contains("could not store that the line was shown"),
        "{said}"
    );
    let id = saved["receipt"]["id"].as_str().unwrap().to_owned();
    let record = &load(&w.ledger).entries[&id];
    assert_eq!(record.pending.get(&chat), Some(&Status::Saved));
    assert!(record.delivered.is_empty());
    assert_eq!(lines(&chat).len(), 2);
    // A restart confirms it without a second line.
    assert_eq!(w.recover(), Recorded::default());
    assert_eq!(
        load(&w.ledger).entries[&id].delivered.get(&chat),
        Some(&Status::Saved)
    );
    assert_eq!(lines(&chat).len(), 2);

    // The ledger's folder cannot be synced: that is a failed save too.
    crate::transcript::FAIL_DIR_SYNC.with(|f| f.set(true));
    let saved = w.call(&chat, "append", entry("No folder.", "r3")).unwrap();
    crate::transcript::FAIL_DIR_SYNC.with(|f| f.set(false));
    let said = saved["chatLine"].as_str().unwrap();
    assert!(said.contains("the ledger's folder"), "{said}");
    assert_eq!(lines(&chat).len(), 2);

    // A failure on a call that failed anyway is said after its error.
    let w = World::new(false);
    let mango = w.agent("Mango Juice");
    let chat = w.lead(&mango);
    faults::saves(&[false]);
    let error = w.call(&chat, "append", entry("Off.", "r1")).unwrap_err();
    faults::saves(&[]);
    assert!(error.contains("writes are off"), "{error}");
    assert!(error.contains("could not store the intent"), "{error}");
}

// A new transcript whose folder cannot be synced holds the line but is
// not proven: the line is owed, not confirmed — and the next look finds
// it and only confirms it. (On Windows the folder sync is skipped, see
// transcript::sync_dir_on, so it never fails there in the first place.)
#[test]
fn a_line_in_a_new_file_that_could_not_be_proven_is_confirmed_by_the_next_look() {
    let ledger = scratch_ledger();
    let chat = unique("new-file");
    index(&chat);
    let line = activity(&chat, &fresh_id(), Status::Saved);
    let unproven = |c: &str, e: Value| {
        crate::transcript::FAIL_DIR_SYNC.with(|f| f.set(true));
        let seq = crate::transcript::append_synced(c, &e);
        crate::transcript::FAIL_DIR_SYNC.with(|f| f.set(false));
        seq
    };
    let first = record_at(&ledger, line.clone(), unproven);
    assert!(first.shown.is_empty());
    assert_eq!(first.pending, vec![chat.clone()]);
    assert_eq!(lines(&chat).len(), 1, "the line is on disk all the same");
    assert_eq!(
        load(&ledger).entries[&line.id].pending.get(&chat),
        Some(&Status::Saved)
    );
    assert_eq!(
        recover_at(&ledger, |_| Ok(None), deliver),
        Recorded::default()
    );
    let record = &load(&ledger).entries[&line.id];
    assert!(record.pending.is_empty());
    assert_eq!(record.delivered.get(&chat), Some(&Status::Saved));
    assert_eq!(lines(&chat).len(), 1);
}

/// Fill the ledger past `KEEP` with writes newer than everything a test
/// made, so the next record forgets the test's own.
fn crowd(ledger: &Path) {
    let mut book = load(ledger);
    let base = now_ms() + DAY as u64;
    for i in 0..KEEP {
        let mut other = activity("chat:crowd", &fresh_id(), Status::Saved);
        other.at = base + i as u64;
        book.entries.insert(
            other.id.clone(),
            Entry {
                activity: Some(other),
                ..Default::default()
            },
        );
    }
    save(ledger, &book).unwrap();
}

// F2 — at 12016c9 a write the ledger had forgotten drew a second line.
#[test]
fn a_write_the_ledger_forgot_past_keep_is_still_one_line() {
    let w = std::sync::Arc::new(World::new(true));
    let mango = w.agent("Mango Juice");
    let chat = w.lead(&mango);
    let first = w.call(&chat, "append", entry("Old write.", "r1")).unwrap();
    let old = first["receipt"]["id"].as_str().unwrap().to_owned();
    // An old uncertain write and an unconfirmed intent must survive the trim.
    let mut doubtful = activity("chat:crowd", &fresh_id(), Status::Uncertain);
    doubtful.at = 0;
    let mut unfinished = activity("chat:crowd", &fresh_id(), Status::Saved);
    unfinished.at = 0;
    {
        let mut book = load(&w.ledger);
        for (a, pending) in [(&doubtful, false), (&unfinished, true)] {
            let entry = book.entries.entry(a.id.clone()).or_default();
            entry.activity = Some(a.clone());
            if pending {
                entry.pending.insert("chat:crowd".into(), Status::Saved);
            }
        }
        save(&w.ledger, &book).unwrap();
    }
    crowd(&w.ledger);
    // The next write trims the ledger back to KEEP, oldest first.
    w.call(&chat, "append", entry("Newer write.", "r2"))
        .unwrap();
    let book = load(&w.ledger);
    assert_eq!(book.entries.len(), KEEP);
    assert!(
        !book.entries.contains_key(&old),
        "the first write was forgotten"
    );
    assert!(book.entries.contains_key(&doubtful.id));
    assert!(book.entries.contains_key(&unfinished.id));
    assert_eq!(lines(&chat).len(), 2);

    // Retried, alone and all at once: still one line per write.
    w.call(&chat, "append", entry("Old write.", "r1")).unwrap();
    let handles: Vec<_> = (0..6)
        .map(|i| {
            let (w, chat) = (w.clone(), chat.clone());
            std::thread::spawn(move || {
                let (text, id) = [("Old write.", "r1"), ("Newer write.", "r2")][i % 2];
                w.call(&chat, "append", entry(text, id))
            })
        })
        .collect();
    for handle in handles {
        assert_eq!(handle.join().unwrap().unwrap()["alreadySaved"], true);
    }
    let shown = lines(&chat);
    assert_eq!(shown.len(), 2);
    assert_eq!(shown[0]["id"], old.as_str());
    assert_eq!(w.note(&mango).matches("Old write.").count(), 1);
}

// F3 — at 12016c9 a line the ledger called delivered was never written
// back once the transcript had lost it.
#[test]
fn a_line_confirmed_but_lost_from_the_transcript_is_written_back_once() {
    let w = World::new(true);
    let mango = w.agent("Mango Juice");
    let chat = w.lead(&mango);
    let saved = w.call(&chat, "append", entry("Lost line.", "r1")).unwrap();
    let id = saved["receipt"]["id"].as_str().unwrap().to_owned();
    assert_eq!(
        load(&w.ledger).entries[&id].delivered.get(&chat),
        Some(&Status::Saved)
    );
    // Written but never synced when the power went: the platter lost the
    // line the ledger had already confirmed. (A restore from backup looks
    // the same.)
    fs::write(crate::transcript::path_for(&chat).unwrap(), "").unwrap();
    for _ in 0..3 {
        w.call(&chat, "append", entry("Lost line.", "r1")).unwrap();
    }
    let shown = lines(&chat);
    assert_eq!(shown.len(), 1);
    assert_eq!(shown[0]["id"], id.as_str());
    assert_eq!(shown[0]["status"], "saved");
}

// F3 — the order on disk: the intent before the line, the confirmation
// only after the line is synced; a line the disk refused stays an intent.
#[test]
fn the_intent_precedes_the_line_and_the_confirmation_follows_it() {
    let ledger = scratch_ledger();
    let chat = unique("order");
    let line = activity(&chat, &fresh_id(), Status::Saved);
    let during = Mutex::new(None);
    let written = record_at(&ledger, line.clone(), |c: &str, event: Value| {
        let entry = &load(&ledger).entries[&line.id];
        *during.lock().unwrap() = Some((
            entry.pending.get(c).copied(),
            entry.delivered.get(c).copied(),
        ));
        deliver(c, event)
    });
    assert_eq!(written.shown, vec![chat.clone()]);
    assert_eq!(
        during.into_inner().unwrap(),
        Some((Some(Status::Saved), None)),
        "the intent was on disk, the confirmation not yet"
    );
    let entry = &load(&ledger).entries[&line.id];
    assert!(entry.pending.is_empty());
    assert_eq!(entry.delivered.get(&chat), Some(&Status::Saved));

    let refused = activity(&chat, &fresh_id(), Status::Saved);
    record_at(&ledger, refused.clone(), |_: &str, _: Value| None);
    let entry = &load(&ledger).entries[&refused.id];
    assert_eq!(entry.pending.get(&chat), Some(&Status::Saved));
    assert!(entry.delivered.is_empty());
}

// F3 — the real save succeeded and its line did not: a restart finishes
// it without waiting for a retry, and never writes it twice.
#[test]
fn a_restart_finishes_every_line_a_crash_left_unconfirmed() {
    let w = World::new(true);
    let mango = w.agent("Mango Juice");
    let (coordinator, worker) = w.worker(&mango, "Recover lines");
    let blocked = crate::transcript::path_for(&worker).unwrap();
    // The worker's transcript cannot be written (a directory stands where
    // the file goes): the save is real, its line is not.
    fs::create_dir_all(blocked.join("in-the-way")).unwrap();
    let saved = w
        .call(&worker, "append", entry("Saved, line lost.", "r1"))
        .unwrap();
    assert_eq!(saved["receipt"]["status"], "saved");
    let id = saved["receipt"]["id"].as_str().unwrap().to_owned();
    let recorded = &load(&w.ledger).entries[&id];
    assert_eq!(recorded.pending.get(&worker), Some(&Status::Saved));
    assert_eq!(recorded.delivered.get(&coordinator), Some(&Status::Saved));
    fs::remove_dir_all(&blocked).unwrap();

    // A chat deleted meanwhile is not written to.
    let gone = unique("gone");
    let mut orphan = activity(&gone, &fresh_id(), Status::Saved);
    orphan.at = 1;
    {
        let mut book = load(&w.ledger);
        let entry = book.entries.entry(orphan.id.clone()).or_default();
        entry.activity = Some(orphan.clone());
        entry.pending.insert(gone.clone(), Status::Saved);
        save(&w.ledger, &book).unwrap();
    }

    assert_eq!(w.recover().shown, vec![worker.clone()]);
    assert_eq!(w.recover(), Recorded::default(), "twice is once");
    let own = lines(&worker);
    assert_eq!(own.len(), 1);
    assert_eq!(own[0]["text"], "Saved, line lost.");
    assert_eq!(lines(&coordinator).len(), 1);
    assert!(lines(&gone).is_empty());
    let book = load(&w.ledger);
    assert!(book.entries[&id].pending.is_empty());
    assert!(book.entries[&orphan.id].pending.is_empty());
    // And the agent's own retry afterwards changes nothing.
    w.call(&worker, "append", entry("Saved, line lost.", "r1"))
        .unwrap();
    assert_eq!(lines(&worker).len(), 1);
}

// F3 — a restart that finds the line already written only confirms it.
#[test]
fn a_restart_confirms_a_line_written_just_before_the_crash() {
    let ledger = scratch_ledger();
    let chat = unique("written");
    index(&chat);
    let line = activity(&chat, &fresh_id(), Status::Saved);
    {
        let mut book = load(&ledger);
        let entry = book.entries.entry(line.id.clone()).or_default();
        entry.activity = Some(line.clone());
        entry.pending.insert(chat.clone(), Status::Saved);
        save(&ledger, &book).unwrap();
    }
    crate::transcript::append(&chat, &origin_event(&line));
    let (seen, emit) = capture();
    assert_eq!(
        recover_at(&ledger, |_| Ok(None), &emit),
        Recorded::default()
    );
    assert!(seen.lock().unwrap().is_empty());
    assert_eq!(lines(&chat).len(), 1);
    assert_eq!(
        load(&ledger).entries[&line.id].delivered.get(&chat),
        Some(&Status::Saved)
    );
}

#[test]
fn a_reassigned_tasks_old_chat_keeps_speaking_for_its_own_agent() {
    let w = World::new(true);
    let mango = w.agent("Mango Juice");
    let potato = w.agent("Potato Juice");
    let (_, worker) = w.worker(&mango, "Reassigned later");
    // The task moves to Potato (written into the disposable ledger, as a
    // handoff leaves it); the chat that was reserved for Mango is still
    // Mango's, and writes Mango's memory, not Potato's.
    let file = w.base.join("orchestrations.json");
    let mut data: Value = serde_json::from_slice(&fs::read(&file).unwrap()).unwrap();
    for task in data["tasks"].as_object_mut().unwrap().values_mut() {
        task["assignee"] = json!({"id": potato.id, "name": potato.name});
    }
    fs::write(&file, serde_json::to_vec(&data).unwrap()).unwrap();
    let store = OrchestrationStore::load(file);
    let tasks = store.snapshot(None).unwrap().tasks;
    assert_eq!(tasks[0].assignee.as_ref().unwrap().id, potato.id);
    w.call_as(&store, &worker, "append", entry("Still Mango.", "r1"))
        .unwrap();
    assert_eq!(lines(&worker)[0]["agent"]["name"], "Mango Juice");
    assert!(w.note(&mango).contains("Still Mango."));
    assert!(!w.note(&potato).contains("Still Mango."));
}

/// Review of bf9d8cd, the carried Medium: both readers of a transcript
/// here ended at the first line that is not UTF-8, so a memory line
/// after one was never found and was written a second time.
#[test]
fn a_line_that_is_not_utf8_hides_no_memory_line_after_it() {
    let chat = unique("damaged");
    let id = fresh_id();
    let mut bytes = b"{\"type\":\"assistant\",\"text\":\"\xE4\xBD\n".to_vec();
    let line = json!({ "type": EVENT, "id": id, "status": "saved" });
    bytes.extend_from_slice(line.to_string().as_bytes());
    bytes.push(b'\n');
    fs::write(crate::transcript::path_for(&chat).unwrap(), bytes).unwrap();

    assert!(in_transcript(&chat, &id, Status::Saved));
    assert_eq!(shown_in(&chat).get(&id), Some(&Status::Saved));
    crate::transcript::forget(&chat);
}

/// The same review: a line found in the transcript was recorded as
/// delivered because it could be read. Nothing waits on that record,
/// but it is a receipt, and a readable line is not one: it is adopted
/// once the record and its folder are confirmed on disk, as a reopen's
/// notice is, and until then it stays an intent. Never written twice.
#[test]
fn a_line_found_in_the_transcript_is_delivered_only_once_confirmed_on_disk() {
    let ledger = scratch_ledger();
    let chat = unique("found-unconfirmed");
    let line = activity(&chat, &fresh_id(), Status::Saved);
    assert!(crate::transcript::append(&chat, &origin_event(&line)).is_some());

    // The record can be read and cannot be synced: it will not open for
    // writing, on any platform.
    let record = crate::transcript::path_for(&chat).unwrap();
    let read_only = |yes: bool| {
        let mut permissions = fs::metadata(&record).unwrap().permissions();
        permissions.set_readonly(yes);
        fs::set_permissions(&record, permissions).unwrap();
    };
    read_only(true);
    let first = record_at(&ledger, line.clone(), deliver);
    #[allow(clippy::permissions_set_readonly_false)]
    read_only(false);
    let entry = |ledger: &Path| load(ledger).entries.remove(&line.id).unwrap();
    assert!(
        entry(&ledger).delivered.is_empty(),
        "delivered on a line that could only be read"
    );
    assert_eq!(entry(&ledger).pending.get(&chat), Some(&Status::Saved));
    assert_eq!(first.pending, vec![chat.clone()]);
    assert!(first.shown.is_empty());
    assert!(first.problem().unwrap().contains("confirmed on disk"));
    assert_eq!(lines(&chat).len(), 1);

    // The fault is over: the line that is there is confirmed, not repeated.
    assert_eq!(
        record_at(&ledger, line.clone(), deliver),
        Recorded::default()
    );
    assert_eq!(entry(&ledger).delivered.get(&chat), Some(&Status::Saved));
    assert!(entry(&ledger).pending.is_empty());
    assert_eq!(lines(&chat).len(), 1);
    crate::transcript::forget(&chat);
}
