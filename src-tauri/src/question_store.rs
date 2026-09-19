//! Durable questions and their delivery outbox. A tool's lifetime is not a
//! question's lifetime: answers can arrive after its process or server is gone.
use std::collections::BTreeMap;
use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use serde::{Deserialize, Serialize};
use tokio::sync::oneshot;

use crate::agent_chat::QuestionOrigin;
use crate::question::{Asked, Question};

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) enum Delivery {
    Pending,
    Ready,
    Dispatching,
    Queued,
    Delivered,
    Cancelled,
    Failed,
    Uncertain,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub(crate) struct Record {
    pub id: String,
    pub origin: QuestionOrigin,
    pub questions: Vec<Question>,
    pub ids: Vec<String>,
    pub answers: Vec<Option<String>>,
    pub delivery: Delivery,
    pub error: Option<String>,
}

impl Record {
    pub fn turn_id(&self) -> String {
        format!("octiq-question-{}", self.id)
    }

    pub fn complete(&self) -> bool {
        self.answers.iter().all(Option::is_some)
    }

    pub fn open(&self) -> bool {
        !matches!(self.delivery, Delivery::Delivered | Delivery::Cancelled)
    }

    pub fn report(&self) -> String {
        crate::question::report(
            &self.questions,
            &self
                .answers
                .iter()
                .map(|a| a.clone().ok_or("Not answered"))
                .collect::<Vec<_>>(),
        )
    }

    pub fn continuation(&self) -> String {
        let pairs = self
            .questions
            .iter()
            .zip(&self.answers)
            .enumerate()
            .map(|(i, (q, a))| {
                format!(
                    "Q{}: {}\nA{}: {}",
                    i + 1,
                    q.question,
                    i + 1,
                    a.as_deref().unwrap_or("Not answered")
                )
            })
            .collect::<Vec<_>>()
            .join("\n\n");
        format!("The user answered your saved OctiqFlow questions (request {}).\n\n{}\n\nContinue the original task using these answers and the conversation context. Check what is already complete before acting; do not repeat completed actions. These answers apply to the questions above, not to unrelated later requests.", self.id, pairs)
    }

    fn views(&self) -> Vec<Asked> {
        self.questions
            .iter()
            .enumerate()
            .map(|(i, q)| Asked {
                id: self.ids[i].clone(),
                question: q.clone(),
                batch: (self.questions.len() > 1).then(|| self.id.clone()),
                batch_size: (self.questions.len() > 1).then_some(self.questions.len()),
                answer: self.answers[i].clone(),
                status: if matches!(self.delivery, Delivery::Failed | Delivery::Uncertain) {
                    "failed"
                } else if self.complete() {
                    "saved"
                } else {
                    "pending"
                }
                .into(),
                error: self.error.clone(),
                retryable: self.delivery == Delivery::Failed,
            })
            .collect()
    }
}

#[derive(Default)]
struct State {
    records: BTreeMap<String, Record>,
    waiters: BTreeMap<String, Option<oneshot::Sender<()>>>,
    load_error: Option<String>,
}

#[derive(Default)]
pub(crate) struct QuestionStore {
    path: Option<PathBuf>,
    state: Mutex<State>,
    // Submit/recovery and explicit cancellation share this lock. A Stop cannot
    // fall between a dispatch decision and starting the replacement process.
    pub delivery_lock: Mutex<()>,
}

#[derive(Clone, Debug, Deserialize)]
pub(crate) struct Answer {
    pub id: String,
    pub answer: String,
}

impl QuestionStore {
    pub fn load(path: PathBuf) -> Self {
        let mut state = State::default();
        match fs::read(&path) {
            Ok(bytes) => match serde_json::from_slice::<BTreeMap<String, Record>>(&bytes) {
                Ok(records)
                    if records.iter().all(|(id, r)| {
                        id == &r.id
                            && !r.questions.is_empty()
                            && r.questions.len() == r.ids.len()
                            && r.ids.len() == r.answers.len()
                    }) =>
                {
                    state.records = records
                }
                Ok(_) => state.load_error = Some("Saved questions have an invalid shape".into()),
                Err(e) => state.load_error = Some(format!("Cannot read saved questions: {e}")),
            },
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
            Err(e) => state.load_error = Some(format!("Cannot read saved questions: {e}")),
        }
        Self {
            path: Some(path),
            state: Mutex::new(state),
            delivery_lock: Mutex::new(()),
        }
    }

    fn persist(&self, records: &BTreeMap<String, Record>) -> Result<(), String> {
        let Some(path) = &self.path else {
            return Ok(());
        };
        write_atomic(
            path,
            &serde_json::to_vec(records).map_err(|e| e.to_string())?,
        )
    }

    fn check(state: &State) -> Result<(), String> {
        state.load_error.clone().map_or(Ok(()), Err)
    }

    pub fn pending(&self) -> Result<Vec<Asked>, String> {
        let state = self.state.lock().map_err(|e| e.to_string())?;
        Self::check(&state)?;
        Ok(state
            .records
            .values()
            .filter(|r| r.open())
            .flat_map(Record::views)
            .collect())
    }

    pub fn insert(
        &self,
        origin: QuestionOrigin,
        mut questions: Vec<Question>,
    ) -> Result<(String, oneshot::Receiver<()>), String> {
        if questions.is_empty() {
            return Err("No question was given".into());
        }
        for q in &mut questions {
            q.chat_key = Some(origin.chat_key.clone());
        }
        let id = uuid::Uuid::new_v4().to_string();
        let record = Record {
            id: id.clone(),
            origin,
            ids: questions
                .iter()
                .map(|_| uuid::Uuid::new_v4().to_string())
                .collect(),
            answers: vec![None; questions.len()],
            questions,
            delivery: Delivery::Pending,
            error: None,
        };
        let mut state = self.state.lock().map_err(|e| e.to_string())?;
        Self::check(&state)?;
        let mut next = state.records.clone();
        next.insert(id.clone(), record.clone());
        self.persist(&next)?;
        state.records = next;
        let (tx, rx) = oneshot::channel();
        state.waiters.insert(id.clone(), Some(tx));
        // Ordered with submit/cancel so a late announcement cannot resurrect a
        // question that another device has already closed.
        for asked in record.views() {
            crate::bus::emit("user-question", asked);
        }
        Ok((id, rx))
    }

    /// Atomic across the entire card, including cards containing several calls.
    /// Retrying the same answers is idempotent; conflicting answers are refused.
    pub fn answer(&self, answers: &[Answer]) -> Result<(), String> {
        if answers.is_empty() {
            return Err("No answers were submitted".into());
        }
        let mut state = self.state.lock().map_err(|e| e.to_string())?;
        Self::check(&state)?;
        let mut next = state.records.clone();
        let mut changed = std::collections::BTreeSet::new();
        for answer in answers {
            if answer.answer.trim().is_empty() {
                return Err("An answer cannot be empty".into());
            }
            let record = next
                .values_mut()
                .find(|r| r.ids.contains(&answer.id))
                .ok_or("This question is no longer available. Your answer was not sent.")?;
            if record.delivery == Delivery::Cancelled {
                return Err("This question was cancelled. Your answer was not sent.".into());
            }
            let i = record.ids.iter().position(|id| id == &answer.id).unwrap();
            if let Some(old) = &record.answers[i] {
                if old != &answer.answer {
                    return Err(
                        "This question already has a different saved answer. Refresh to see it."
                            .into(),
                    );
                }
            } else {
                record.answers[i] = Some(answer.answer.clone());
                changed.insert(record.id.clone());
            }
            if record.delivery == Delivery::Pending && record.complete() {
                record.delivery = Delivery::Ready;
            }
        }
        self.persist(&next)?;
        state.records = next;
        for id in changed {
            let record = &state.records[&id];
            let complete = record.complete();
            publish(record);
            if complete {
                // Keep an entry after notification: its presence owns the
                // original tool path until take_tool or detach wins the lock.
                if let Some(tx) = state.waiters.get_mut(&id).and_then(Option::take) {
                    let _ = tx.send(());
                }
            }
        }
        Ok(())
    }

    /// Commit ownership to the live tool before returning its answer. A late
    /// submit and a timeout race under this same lock, never dispatching twice.
    pub fn take_tool(&self, id: &str) -> Result<Option<String>, String> {
        let mut state = self.state.lock().map_err(|e| e.to_string())?;
        Self::check(&state)?;
        let record = state.records.get(id).ok_or("Unknown question")?;
        if record.delivery == Delivery::Cancelled {
            return Ok(Some("The user cancelled this question or stopped the task. Do not assume an answer or resume the cancelled work.".into()));
        }
        if !state.waiters.contains_key(id) || record.delivery != Delivery::Ready {
            return Ok(None);
        }
        let answer = record.report();
        let mut next = state.records.clone();
        next.get_mut(id).unwrap().delivery = Delivery::Delivered;
        self.persist(&next)?;
        state.records = next;
        state.waiters.remove(id);
        publish(&state.records[id]);
        Ok(Some(answer))
    }

    /// Commit a completed card to a live native provider request.
    ///
    /// Unlike the MCP tool path, app-server needs each answer separately so it
    /// can map them back to Codex's question ids. An empty vector means the
    /// person cancelled the card; `None` means it was not answered while this
    /// live request still owned it.
    pub fn take_native(&self, id: &str) -> Result<Option<Vec<String>>, String> {
        let mut state = self.state.lock().map_err(|e| e.to_string())?;
        Self::check(&state)?;
        let record = state.records.get(id).ok_or("Unknown question")?;
        if record.delivery == Delivery::Cancelled {
            state.waiters.remove(id);
            return Ok(Some(Vec::new()));
        }
        if !state.waiters.contains_key(id) || record.delivery != Delivery::Ready {
            return Ok(None);
        }
        let answers = record.answers.iter().flatten().cloned().collect::<Vec<_>>();
        let mut next = state.records.clone();
        next.get_mut(id).unwrap().delivery = Delivery::Delivered;
        self.persist(&next)?;
        state.records = next;
        state.waiters.remove(id);
        publish(&state.records[id]);
        Ok(Some(answers))
    }

    pub fn detach(&self, id: &str) {
        if let Ok(mut state) = self.state.lock() {
            state.waiters.remove(id);
        }
    }

    pub fn detach_launch(&self, launch_id: &str) {
        if let Ok(mut state) = self.state.lock() {
            let ids = state
                .records
                .values()
                .filter(|r| r.origin.launch_id == launch_id)
                .map(|r| r.id.clone())
                .collect::<Vec<_>>();
            for id in ids {
                state.waiters.remove(&id);
            }
        }
    }

    pub fn outbox(&self) -> Result<Vec<Record>, String> {
        let state = self.state.lock().map_err(|e| e.to_string())?;
        Self::check(&state)?;
        Ok(state
            .records
            .values()
            .filter(|r| {
                r.complete()
                    && matches!(
                        r.delivery,
                        Delivery::Ready | Delivery::Dispatching | Delivery::Queued
                    )
                    && !state.waiters.contains_key(&r.id)
            })
            .cloned()
            .collect())
    }

    pub fn set_delivery(
        &self,
        id: &str,
        delivery: Delivery,
        error: Option<String>,
    ) -> Result<(), String> {
        let mut state = self.state.lock().map_err(|e| e.to_string())?;
        Self::check(&state)?;
        let mut next = state.records.clone();
        let record = next.get_mut(id).ok_or("Unknown question")?;
        if record.delivery == Delivery::Cancelled {
            return Ok(());
        }
        record.delivery = delivery;
        record.error = error;
        self.persist(&next)?;
        state.records = next;
        publish(&state.records[id]);
        Ok(())
    }

    pub fn cancel(&self, ids: &[String]) -> Result<(), String> {
        let mut state = self.state.lock().map_err(|e| e.to_string())?;
        Self::check(&state)?;
        let mut next = state.records.clone();
        let mut changed = Vec::new();
        for record in next
            .values_mut()
            .filter(|r| r.open() && r.ids.iter().any(|id| ids.contains(id)))
        {
            record.delivery = Delivery::Cancelled;
            changed.push(record.id.clone());
        }
        if changed.is_empty() {
            return Ok(());
        }
        // Stop remains effective in this process even if the disk fails. The
        // error is still returned so no caller claims durable cancellation.
        let saved = self.persist(&next);
        state.records = next;
        for id in changed {
            state.waiters.remove(&id);
            publish(&state.records[&id]);
        }
        saved
    }

    pub fn cancel_chat(&self, chat_key: &str) -> Result<(), String> {
        let ids = {
            let state = self.state.lock().map_err(|e| e.to_string())?;
            Self::check(&state)?;
            state
                .records
                .values()
                .filter(|r| r.origin.chat_key == chat_key || r.origin.session_key == chat_key)
                .flat_map(|r| r.ids.clone())
                .collect::<Vec<_>>()
        };
        self.cancel(&ids)
    }

    pub fn retry(&self, ids: &[String]) -> Result<(), String> {
        let mut state = self.state.lock().map_err(|e| e.to_string())?;
        Self::check(&state)?;
        let mut next = state.records.clone();
        for record in next
            .values_mut()
            .filter(|r| r.delivery == Delivery::Failed && r.ids.iter().any(|id| ids.contains(id)))
        {
            record.delivery = Delivery::Ready;
            record.error = None;
        }
        self.persist(&next)?;
        state.records = next;
        for record in state
            .records
            .values()
            .filter(|r| r.ids.iter().any(|id| ids.contains(id)))
        {
            publish(record);
        }
        Ok(())
    }
}

#[cfg(test)]
pub(crate) fn test_origin(key: &str) -> QuestionOrigin {
    serde_json::from_value(serde_json::json!({
        "chat_key": key, "session_key": key, "launch_id": "launch-1",
        "start": { "cwd": "/tmp", "agent": "codex", "model": "gpt-test", "access": "manual",
            "extra_dirs": ["/tmp/extra"], "env": {}, "effort": "high", "lite": false, "session_id": "session-1" },
    })).unwrap()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn path() -> PathBuf {
        std::env::temp_dir()
            .join(format!("octiq-question-{}", uuid::Uuid::new_v4()))
            .join("questions.json")
    }
    fn questions() -> Vec<Question> {
        ["Which database?", "Which region?"]
            .into_iter()
            .map(|text| serde_json::from_value(serde_json::json!({ "question": text })).unwrap())
            .collect()
    }
    fn answers(store: &QuestionStore) -> Vec<Answer> {
        store
            .pending()
            .unwrap()
            .iter()
            .enumerate()
            .map(|(i, q)| Answer {
                id: q.id.clone(),
                answer: ["SQLite", "Asia"][i].into(),
            })
            .collect()
    }

    #[tokio::test]
    async fn offline_questions_survive_restart_and_a_late_answer() {
        let path = path();
        let store = QuestionStore::load(path.clone());
        let (id, _rx) = store
            .insert(test_origin("chat:offline"), questions())
            .unwrap();
        store.detach(&id); // Same transition as a timed-out or cancelled HTTP future.
        assert_eq!(store.pending().unwrap().len(), 2);
        drop(store);
        let restored = QuestionStore::load(path.clone());
        restored.answer(&answers(&restored)).unwrap();
        let ready = restored.outbox().unwrap();
        assert_eq!(ready.len(), 1);
        assert!(ready[0]
            .continuation()
            .contains("Q1: Which database?\nA1: SQLite"));
        assert!(ready[0]
            .continuation()
            .contains("Q2: Which region?\nA2: Asia"));
        let after_answer_restart = QuestionStore::load(path);
        assert_eq!(
            after_answer_restart.outbox().unwrap()[0].turn_id(),
            ready[0].turn_id()
        );
        assert_eq!(after_answer_restart.pending().unwrap()[0].status, "saved");
    }

    #[tokio::test]
    async fn live_answers_return_once_and_never_enter_the_resume_outbox() {
        let store = QuestionStore::load(path());
        let (id, rx) = store.insert(test_origin("chat:live"), questions()).unwrap();
        let answers = answers(&store);
        store.answer(&answers).unwrap();
        rx.await.unwrap();
        assert!(store.outbox().unwrap().is_empty());
        assert_eq!(
            store.take_tool(&id).unwrap().unwrap(),
            "Q1: Which database?\nA1: SQLite\n\nQ2: Which region?\nA2: Asia"
        );
        store.answer(&answers).unwrap(); // Lost submission acknowledgement / repeated tap.
        assert!(store.take_tool(&id).unwrap().is_none());
        assert!(store.outbox().unwrap().is_empty());
        assert!(store.pending().unwrap().is_empty());
        let mut conflicting = answers;
        conflicting[0].answer = "Postgres".into();
        assert!(store.answer(&conflicting).is_err());
    }

    #[tokio::test]
    async fn native_answers_keep_question_order_and_return_only_once() {
        let store = QuestionStore::load(path());
        let (id, rx) = store
            .insert(test_origin("chat:native"), questions())
            .unwrap();
        let submitted = answers(&store);
        store.answer(&submitted).unwrap();
        rx.await.unwrap();
        assert_eq!(
            store.take_native(&id).unwrap().unwrap(),
            vec!["SQLite".to_string(), "Asia".to_string()]
        );
        assert!(store.take_native(&id).unwrap().is_none());
        assert!(store.outbox().unwrap().is_empty());
    }

    #[tokio::test]
    async fn partial_answers_never_resume_a_half_answered_batch() {
        let store = QuestionStore::default();
        let (id, _rx) = store
            .insert(test_origin("chat:partial"), questions())
            .unwrap();
        let answers = answers(&store);
        store.answer(&answers[..1]).unwrap();
        store.detach(&id);
        assert!(store.outbox().unwrap().is_empty());
        store.answer(&answers[1..]).unwrap();
        assert_eq!(store.outbox().unwrap().len(), 1);
    }

    #[tokio::test]
    async fn a_bad_batch_submission_does_not_save_any_of_it() {
        let store = QuestionStore::default();
        store
            .insert(test_origin("chat:atomic"), questions())
            .unwrap();
        let mut replies = answers(&store);
        replies[1].id = "unknown".into();
        assert!(store.answer(&replies).is_err());
        assert!(store.pending().unwrap().iter().all(|q| q.answer.is_none()));
    }

    #[tokio::test]
    async fn failed_storage_keeps_the_question_and_refuses_a_false_receipt() {
        let path = path();
        let store = QuestionStore::load(path.clone());
        store.insert(test_origin("chat:disk"), questions()).unwrap();
        let answers = answers(&store);
        // Make the final atomic rename impossible without changing permissions
        // or touching any real profile data.
        fs::rename(&path, path.with_extension("backup")).unwrap();
        fs::create_dir(&path).unwrap();
        assert!(store.answer(&answers).is_err());
        assert!(store.pending().unwrap().iter().all(|q| q.answer.is_none()));
    }

    #[tokio::test]
    async fn manual_cancellation_survives_restart_and_rejects_late_answers() {
        let path = path();
        let store = QuestionStore::load(path.clone());
        let (id, rx) = store
            .insert(test_origin("chat:stopped"), questions())
            .unwrap();
        let answers = answers(&store);
        store.cancel_chat("chat:stopped").unwrap();
        assert!(rx.await.is_err());
        assert!(store.take_tool(&id).unwrap().unwrap().contains("cancelled"));
        let restored = QuestionStore::load(path);
        assert!(restored.answer(&answers).is_err());
        assert!(restored.pending().unwrap().is_empty());
        assert!(restored.outbox().unwrap().is_empty());
    }

    #[tokio::test]
    async fn native_cancellation_returns_an_empty_answer_set() {
        let store = QuestionStore::load(path());
        let (id, rx) = store
            .insert(test_origin("chat:native-cancelled"), questions())
            .unwrap();
        store.cancel_chat("chat:native-cancelled").unwrap();
        assert!(rx.await.is_err());
        assert_eq!(store.take_native(&id).unwrap(), Some(Vec::new()));
    }

    #[test]
    fn corrupt_storage_is_not_replaced_with_an_empty_store() {
        let path = path();
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(&path, "broken").unwrap();
        let store = QuestionStore::load(path.clone());
        assert!(store.pending().is_err());
        assert!(store
            .insert(test_origin("chat:broken"), questions())
            .is_err());
        assert_eq!(fs::read_to_string(path).unwrap(), "broken");
    }

    #[test]
    fn timeout_and_live_return_cannot_both_own_the_same_answer() {
        for _ in 0..25 {
            let store = std::sync::Arc::new(QuestionStore::default());
            let (id, _rx) = store.insert(test_origin("chat:race"), questions()).unwrap();
            store.answer(&answers(&store)).unwrap();
            let race = store.clone();
            let timed_out = id.clone();
            let thread = std::thread::spawn(move || race.detach(&timed_out));
            let live = store.take_tool(&id).unwrap().is_some();
            thread.join().unwrap();
            assert_eq!(usize::from(live) + store.outbox().unwrap().len(), 1);
        }
    }
}

fn publish(record: &Record) {
    if record.open() {
        for asked in record.views() {
            crate::bus::emit("question-updated", asked);
        }
    } else {
        for id in &record.ids {
            crate::bus::emit("question-expired", serde_json::json!({ "id": id }));
        }
    }
}

fn write_atomic(path: &Path, bytes: &[u8]) -> Result<(), String> {
    let dir = path.parent().ok_or("Questions have no storage directory")?;
    fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    let tmp = dir.join(format!(".questions-{}.tmp", uuid::Uuid::new_v4()));
    let mut options = fs::OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let mut file = options.open(&tmp).map_err(|e| e.to_string())?;
    file.write_all(bytes)
        .and_then(|_| file.sync_all())
        .map_err(|e| e.to_string())?;
    fs::rename(tmp, path).map_err(|e| e.to_string())?;
    Ok(())
}
