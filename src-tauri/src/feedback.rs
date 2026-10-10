//! Profile-wide feedback, separate from project work and chat lifetimes.
//! Only a completed atomic write acknowledges a report. Agents submit, read
//! and may move a report's status; the browser triages too, and every update
//! records who made it. Reports never launch work on their own.
use std::{fs, io::Write, path::PathBuf, sync::Mutex};

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

static LOCK: Mutex<()> = Mutex::new(());

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Status {
    New,
    Triaged,
    InProgress,
    Resolved,
    Dismissed,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Kind {
    Bug,
    Friction,
    Suggestion,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Severity {
    Low,
    Medium,
    High,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Submission {
    pub request_id: String,
    pub title: String,
    pub kind: Kind,
    pub severity: Severity,
    pub description: String,
    #[serde(default)]
    pub steps: String,
    #[serde(default)]
    pub expected: String,
    #[serde(default)]
    pub actual: String,
    #[serde(default)]
    pub workaround: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Source {
    pub chat_id: String,
    pub chat_title: String,
    pub project_id: String,
    pub project_name: String,
    pub model_id: Option<String>,
    pub app_version: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum UpdaterKind {
    Agent,
    Person,
}

/// Who last changed a report's status or note. The host fills it in: an agent
/// is named by the chat its launch proves, and the page's own command is the
/// person. Neither can supply it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdatedBy {
    pub kind: UpdaterKind,
    #[serde(default)]
    pub chat_id: String,
    #[serde(default)]
    pub chat_title: String,
}

impl UpdatedBy {
    pub fn person() -> Self {
        Self {
            kind: UpdaterKind::Person,
            chat_id: String::new(),
            chat_title: String::new(),
        }
    }

    pub fn agent(chat_id: String, chat_title: String) -> Self {
        Self {
            kind: UpdaterKind::Agent,
            chat_id,
            chat_title,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Report {
    pub id: String,
    #[serde(flatten)]
    pub submission: Submission,
    pub source: Source,
    pub status: Status,
    pub note: String,
    pub created_at: i64,
    pub updated_at: i64,
    pub revision: u64,
    /// Absent on a report nobody has updated, and on every report saved
    /// before updates were attributed.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub updated_by: Option<UpdatedBy>,
}

#[derive(Default, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Filter {
    pub status: Option<Status>,
    pub query: Option<String>,
    pub offset: Option<usize>,
    pub limit: Option<usize>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Update {
    pub id: String,
    pub expected_revision: u64,
    pub status: Status,
    pub note: String,
}

/// What an agent may send. The note and the revision are optional: an omitted
/// note keeps the one saved, and an omitted revision updates whatever is
/// current, both read under the same lock as the write.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AgentUpdate {
    pub id: String,
    pub status: Status,
    #[serde(default)]
    pub note: Option<String>,
    #[serde(default)]
    pub expected_revision: Option<u64>,
}

#[derive(Default, Serialize, Deserialize)]
struct Inbox {
    reports: Vec<Report>,
}

pub struct Store {
    path: PathBuf,
}

impl Store {
    pub fn profile() -> Self {
        Self {
            path: crate::profile::profile_dir().join("feedback.json"),
        }
    }

    fn read(&self) -> Result<Inbox, String> {
        match fs::read(&self.path) {
            Ok(bytes) => serde_json::from_slice(&bytes).map_err(|e| {
                format!("Feedback inbox could not be read: {e}. Its data has been preserved.")
            }),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(Inbox::default()),
            Err(e) => Err(format!("Feedback inbox could not be read: {e}")),
        }
    }

    fn save(&self, inbox: &Inbox) -> Result<(), String> {
        let dir = self
            .path
            .parent()
            .ok_or("Feedback has no storage directory")?;
        fs::create_dir_all(dir).map_err(|e| e.to_string())?;
        let tmp = dir.join(format!(".feedback-{}.tmp", uuid::Uuid::new_v4()));
        let result = (|| {
            let bytes = serde_json::to_vec_pretty(inbox).map_err(|e| e.to_string())?;
            let mut options = fs::OpenOptions::new();
            options.write(true).create_new(true);
            #[cfg(unix)]
            {
                use std::os::unix::fs::OpenOptionsExt;
                options.mode(0o600);
            }
            let mut file = options.open(&tmp).map_err(|e| e.to_string())?;
            file.write_all(&bytes)
                .and_then(|_| file.sync_all())
                .map_err(|e| e.to_string())?;
            fs::rename(&tmp, &self.path).map_err(|e| e.to_string())
        })();
        if result.is_err() {
            let _ = fs::remove_file(tmp);
        }
        result.map_err(|e| format!("Feedback was not saved: {e}"))
    }

    pub fn submit(&self, mut submission: Submission, source: Source) -> Result<Report, String> {
        submission.request_id = required(&submission.request_id, "Request ID", 120)?;
        submission.title = required(&submission.title, "Title", 160)?;
        submission.description = required(&submission.description, "Description", 12_000)?;
        for (name, value) in [
            ("Steps", &submission.steps),
            ("Expected behaviour", &submission.expected),
            ("Actual behaviour", &submission.actual),
            ("Workaround", &submission.workaround),
        ] {
            bounded(value, name, 4_000)?;
        }
        let _guard = LOCK.lock().map_err(|_| "Feedback inbox is unavailable")?;
        let mut inbox = self.read()?;
        if let Some(existing) = inbox.reports.iter().find(|r| {
            r.source.chat_id == source.chat_id && r.submission.request_id == submission.request_id
        }) {
            return if existing.submission == submission {
                Ok(existing.clone())
            } else {
                Err("This requestId already belongs to a different report. Reuse it only for an identical retry.".into())
            };
        }
        let now = now();
        let report = Report {
            id: uuid::Uuid::new_v4().to_string(),
            submission,
            source,
            status: Status::New,
            note: String::new(),
            created_at: now,
            updated_at: now,
            revision: 1,
            updated_by: None,
        };
        inbox.reports.push(report.clone());
        self.save(&inbox)?;
        crate::bus::emit("feedback-changed", json!({ "id": report.id }));
        Ok(report)
    }

    pub fn list(&self, filter: Filter) -> Result<Value, String> {
        let query = filter.query.unwrap_or_default().trim().to_lowercase();
        bounded(&query, "Search", 200)?;
        let _guard = LOCK.lock().map_err(|_| "Feedback inbox is unavailable")?;
        let inbox = self.read()?;
        let new_count = inbox
            .reports
            .iter()
            .filter(|r| r.status == Status::New)
            .count();
        let mut reports: Vec<_> = inbox
            .reports
            .into_iter()
            .filter(|r| {
                filter.status.is_none_or(|status| r.status == status)
                    && (query.is_empty()
                        || [
                            &r.id,
                            &r.submission.title,
                            &r.submission.description,
                            &r.source.project_name,
                            &r.submission.steps,
                            &r.submission.actual,
                            &r.submission.expected,
                            &r.submission.workaround,
                            &r.note,
                        ]
                        .iter()
                        .any(|s| s.to_lowercase().contains(&query)))
            })
            .collect();
        reports.sort_by(|a, b| {
            b.created_at
                .cmp(&a.created_at)
                .then_with(|| a.id.cmp(&b.id))
        });
        let total = reports.len();
        let offset = filter.offset.unwrap_or(0).min(total);
        let limit = filter.limit.unwrap_or(30).clamp(1, 100);
        let next = offset.saturating_add(limit).min(total);
        Ok(
            json!({ "items": reports.into_iter().skip(offset).take(limit).collect::<Vec<_>>(),
            "total": total, "newCount": new_count, "nextOffset": (next < total).then_some(next) }),
        )
    }

    pub fn get(&self, id: &str) -> Result<Report, String> {
        let _guard = LOCK.lock().map_err(|_| "Feedback inbox is unavailable")?;
        self.read()?
            .reports
            .into_iter()
            .find(|r| r.id == id)
            .ok_or("Feedback report not found".into())
    }

    /// The page's save: the person, always against the revision they read.
    pub fn update(&self, update: Update) -> Result<Report, String> {
        self.change(
            AgentUpdate {
                id: update.id,
                status: update.status,
                note: Some(update.note),
                expected_revision: Some(update.expected_revision),
            },
            UpdatedBy::person(),
        )
    }

    /// An agent's `feedback_update`, attributed to the chat that sent it.
    pub fn update_as_agent(&self, update: AgentUpdate, chat: UpdatedBy) -> Result<Report, String> {
        self.change(update, chat)
    }

    fn change(&self, update: AgentUpdate, by: UpdatedBy) -> Result<Report, String> {
        if let Some(note) = &update.note {
            bounded(note, "Triage note", 8_000)?;
        }
        let _guard = LOCK.lock().map_err(|_| "Feedback inbox is unavailable")?;
        let mut inbox = self.read()?;
        let report = inbox
            .reports
            .iter_mut()
            .find(|r| r.id == update.id)
            .ok_or("Feedback report not found")?;
        if update
            .expected_revision
            .is_some_and(|expected| expected != report.revision)
        {
            return Err(match by.kind {
                UpdaterKind::Person => {
                    "This report changed in another window. Reload the report before saving again."
                        .into()
                }
                UpdaterKind::Agent => format!(
                    "This report is at revision {}, not the expected one. Read it again with feedback_get before updating.",
                    report.revision
                ),
            });
        }
        report.status = update.status;
        if let Some(note) = update.note {
            report.note = note;
        }
        report.updated_at = now();
        report.revision += 1;
        report.updated_by = Some(by);
        let saved = report.clone();
        self.save(&inbox)?;
        crate::bus::emit("feedback-changed", json!({ "id": saved.id }));
        Ok(saved)
    }
}

fn bounded(value: &str, field: &str, max: usize) -> Result<(), String> {
    if value.chars().count() > max {
        Err(format!("{field} must be at most {max} characters."))
    } else {
        Ok(())
    }
}

fn required(value: &str, field: &str, max: usize) -> Result<String, String> {
    let value = value.trim();
    if value.is_empty() {
        return Err(format!("{field} is required."));
    }
    bounded(value, field, max)?;
    Ok(value.into())
}

fn now() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as i64
}

/// The identity comes from the MCP's process environment and the host's index,
/// never from model-supplied source/version fields. An update is stamped with
/// that chat the same way.
pub fn agent_call(
    svc: &crate::dispatch::Services,
    chat_key: &str,
    action: &str,
    args: Value,
) -> Result<Value, String> {
    let id = chat_key
        .strip_prefix("chat:")
        .ok_or("Feedback requires an OctiqFlow chat")?;
    let chat = crate::chat_index::list()
        .into_iter()
        .find(|c| c.id == id && c.deleted_at.is_none())
        .ok_or("This chat is not in the active chat index.")?;
    let store = Store::profile();
    match action {
        "submit" => {
            let project_name = crate::workspaces::list_workspaces_impl(&svc.workspaces)?
                .into_iter()
                .find(|p| p.id == chat.project_id)
                .map(|p| p.name)
                .unwrap_or_default();
            let source = Source {
                chat_id: chat.id,
                chat_title: chat.title,
                project_id: chat.project_id,
                project_name,
                model_id: chat.model_id,
                app_version: env!("CARGO_PKG_VERSION").into(),
            };
            let submission =
                serde_json::from_value(args).map_err(|e| format!("Invalid feedback: {e}"))?;
            serde_json::to_value(store.submit(submission, source)?).map_err(|e| e.to_string())
        }
        "list" => store.list(
            serde_json::from_value(args).map_err(|e| format!("Invalid feedback filter: {e}"))?,
        ),
        "get" => {
            #[derive(Deserialize)]
            #[serde(deny_unknown_fields)]
            struct Get {
                id: String,
            }
            let request: Get =
                serde_json::from_value(args).map_err(|e| format!("Invalid feedback ID: {e}"))?;
            serde_json::to_value(store.get(&request.id)?).map_err(|e| e.to_string())
        }
        "update" => agent_update(&store, args, UpdatedBy::agent(chat.id, chat.title)),
        _ => {
            Err("Unknown feedback action. Agents may submit, list, get, or update reports.".into())
        }
    }
}

/// The `update` action, apart from finding the chat: only the documented
/// fields are read, so a model cannot name another chat as the one updating.
fn agent_update(store: &Store, args: Value, chat: UpdatedBy) -> Result<Value, String> {
    let update: AgentUpdate =
        serde_json::from_value(args).map_err(|e| format!("Invalid feedback update: {e}"))?;
    serde_json::to_value(store.update_as_agent(update, chat)?).map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    /// A store in a folder of its own; the folder goes with the fixture.
    struct Fixture(Store, #[allow(dead_code)] crate::test_dir::TestDir);
    impl Fixture {
        fn new() -> Self {
            let dir = crate::test_dir::TestDir::new("feedback");
            Self(
                Store {
                    path: dir.join("feedback.json"),
                },
                dir,
            )
        }
    }
    fn submission() -> Submission {
        Submission {
            request_id: "retry-one".into(),
            title: "Queue stalls".into(),
            kind: Kind::Bug,
            severity: Severity::High,
            description: "A queued turn never starts after Stop.".into(),
            steps: "Send two turns, then Stop".into(),
            expected: "Next turn starts".into(),
            actual: "Queue stays idle".into(),
            workaround: "Resume manually".into(),
        }
    }
    fn source(chat: &str) -> Source {
        Source {
            chat_id: chat.into(),
            chat_title: "Investigation".into(),
            project_id: "p1".into(),
            project_name: "Example".into(),
            model_id: Some("codex:test".into()),
            app_version: "test".into(),
        }
    }
    #[test]
    fn submission_survives_reload_and_retries_without_duplicates() {
        let f = Fixture::new();
        let first = f.0.submit(submission(), source("one")).unwrap();
        let reloaded = Store {
            path: f.0.path.clone(),
        };
        assert_eq!(
            reloaded.submit(submission(), source("one")).unwrap().id,
            first.id
        );
        let mut changed = submission();
        changed.actual = "Different".into();
        assert!(reloaded
            .submit(changed, source("one"))
            .unwrap_err()
            .contains("requestId"));
        assert_ne!(
            reloaded.submit(submission(), source("two")).unwrap().id,
            first.id
        );
        assert_eq!(reloaded.list(Filter::default()).unwrap()["total"], 2);
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(
                fs::metadata(&f.0.path).unwrap().permissions().mode() & 0o777,
                0o600
            );
        }
    }
    #[test]
    fn triage_preserves_report_and_rejects_stale_updates() {
        let f = Fixture::new();
        let original = f.0.submit(submission(), source("one")).unwrap();
        let edit = || Update {
            id: original.id.clone(),
            expected_revision: 1,
            status: Status::Resolved,
            note: "Fixed in commit abc1234".into(),
        };
        let saved = f.0.update(edit()).unwrap();
        assert_eq!(saved.submission, original.submission);
        assert_eq!(saved.revision, 2);
        assert!(f.0.update(edit()).unwrap_err().contains("another window"));
        assert_eq!(f.0.get(&original.id).unwrap().status, Status::Resolved);
        assert_eq!(
            f.0.submit(submission(), source("one")).unwrap().status,
            Status::Resolved
        );
    }
    fn agent() -> UpdatedBy {
        UpdatedBy::agent("fixer".into(), "Fix the queue".into())
    }
    #[test]
    fn an_agent_update_moves_the_status_and_names_its_chat() {
        let f = Fixture::new();
        let original = f.0.submit(submission(), source("one")).unwrap();
        assert!(original.updated_by.is_none());
        let saved = agent_update(
            &f.0,
            json!({ "id": original.id, "status": "resolved", "note": "Fixed in abc1234" }),
            agent(),
        )
        .unwrap();
        assert_eq!(saved["status"], "resolved");
        assert_eq!(saved["note"], "Fixed in abc1234");
        assert_eq!(saved["revision"], 2);
        assert_eq!(
            saved["updatedBy"],
            json!({ "kind": "agent", "chatId": "fixer", "chatTitle": "Fix the queue" })
        );
        let stored = f.0.get(&original.id).unwrap();
        assert_eq!(stored.submission, original.submission);
        assert_eq!(stored.source.chat_id, "one");
        assert_eq!(stored.updated_by, Some(agent()));
        // The page's save is the person's, whoever touched the report before.
        let by_person =
            f.0.update(Update {
                id: original.id.clone(),
                expected_revision: 2,
                status: Status::Triaged,
                note: "Reopened".into(),
            })
            .unwrap();
        assert_eq!(by_person.updated_by, Some(UpdatedBy::person()));
    }
    #[test]
    fn an_agent_update_without_a_note_keeps_the_saved_one() {
        let f = Fixture::new();
        let id = f.0.submit(submission(), source("one")).unwrap().id;
        agent_update(
            &f.0,
            json!({ "id": id, "status": "triaged", "note": "Needs a repro" }),
            agent(),
        )
        .unwrap();
        let kept =
            agent_update(&f.0, json!({ "id": id, "status": "in_progress" }), agent()).unwrap();
        assert_eq!(kept["status"], "in_progress");
        assert_eq!(kept["note"], "Needs a repro");
        assert_eq!(kept["revision"], 3);
        // A note that is sent replaces the whole of it, the empty one too.
        let cleared = agent_update(
            &f.0,
            json!({ "id": id, "status": "in_progress", "note": "" }),
            agent(),
        )
        .unwrap();
        assert_eq!(cleared["note"], "");
    }
    #[test]
    fn an_agent_update_against_a_stale_revision_changes_nothing() {
        let f = Fixture::new();
        let id = f.0.submit(submission(), source("one")).unwrap().id;
        f.0.update(Update {
            id: id.clone(),
            expected_revision: 1,
            status: Status::Triaged,
            note: "The person's note".into(),
        })
        .unwrap();
        let stale = agent_update(
            &f.0,
            json!({ "id": id, "status": "dismissed", "note": "Duplicate", "expectedRevision": 1 }),
            agent(),
        )
        .unwrap_err();
        assert!(
            stale.contains("revision 2") && stale.contains("feedback_get"),
            "{stale}"
        );
        let untouched = f.0.get(&id).unwrap();
        assert_eq!(untouched.status, Status::Triaged);
        assert_eq!(untouched.note, "The person's note");
        assert_eq!(untouched.revision, 2);
        assert_eq!(untouched.updated_by, Some(UpdatedBy::person()));
        // The current revision goes through, and so does none at all.
        let current = agent_update(
            &f.0,
            json!({ "id": id, "status": "in_progress", "expectedRevision": 2 }),
            agent(),
        )
        .unwrap();
        assert_eq!(current["revision"], 3);
        let unguarded =
            agent_update(&f.0, json!({ "id": id, "status": "resolved" }), agent()).unwrap();
        assert_eq!(unguarded["revision"], 4);
    }
    #[test]
    fn an_agent_update_reads_only_its_documented_fields() {
        let f = Fixture::new();
        let id = f.0.submit(submission(), source("one")).unwrap().id;
        for extra in [
            json!({ "chatKey": "chat:other" }),
            json!({ "source": { "chatId": "other" } }),
            json!({ "updatedBy": { "kind": "person" } }),
            json!({ "title": "Rewritten" }),
        ] {
            let mut args = json!({ "id": id, "status": "resolved" });
            args.as_object_mut()
                .unwrap()
                .extend(extra.as_object().unwrap().clone());
            let refused = agent_update(&f.0, args, agent()).unwrap_err();
            assert!(refused.contains("Invalid feedback update"), "{refused}");
        }
        for invalid in [
            json!({ "id": id }),
            json!({ "id": id, "status": "fixed" }),
            json!({ "status": "resolved" }),
        ] {
            assert!(agent_update(&f.0, invalid, agent()).is_err());
        }
        let long = "x".repeat(8_001);
        assert!(agent_update(
            &f.0,
            json!({ "id": id, "status": "resolved", "note": long }),
            agent()
        )
        .unwrap_err()
        .contains("at most 8000"));
        assert!(agent_update(
            &f.0,
            json!({ "id": "missing", "status": "resolved" }),
            agent()
        )
        .unwrap_err()
        .contains("not found"));
        assert_eq!(f.0.get(&id).unwrap().revision, 1);
    }
    #[test]
    fn an_inbox_saved_before_updates_were_attributed_still_reads() {
        let f = Fixture::new();
        fs::write(
            &f.0.path,
            r#"{ "reports": [ {
                "id": "old-one", "requestId": "r1", "title": "Queue stalls", "kind": "bug",
                "severity": "high", "description": "After Stop", "steps": "", "expected": "",
                "actual": "", "workaround": "",
                "source": { "chatId": "one", "chatTitle": "Investigation", "projectId": "p1",
                    "projectName": "Example", "modelId": null, "appVersion": "0.3.5" },
                "status": "triaged", "note": "Seen twice", "createdAt": 10, "updatedAt": 20,
                "revision": 4
            } ] }"#,
        )
        .unwrap();
        let old = f.0.get("old-one").unwrap();
        assert!(old.updated_by.is_none());
        assert_eq!(old.note, "Seen twice");
        assert_eq!(f.0.list(Filter::default()).unwrap()["total"], 1);
        // A report nobody has updated is written back without the field.
        f.0.submit(submission(), source("two")).unwrap();
        assert!(!fs::read_to_string(&f.0.path).unwrap().contains("updatedBy"));
        let saved = agent_update(
            &f.0,
            json!({ "id": "old-one", "status": "resolved", "expectedRevision": 4 }),
            agent(),
        )
        .unwrap();
        assert_eq!(saved["note"], "Seen twice");
        assert_eq!(saved["revision"], 5);
        let reread = Store {
            path: f.0.path.clone(),
        }
        .get("old-one")
        .unwrap();
        assert_eq!(reread.updated_by, Some(agent()));
        assert_eq!(reread.submission.request_id, "r1");
    }
    #[test]
    fn filters_and_pagination_keep_reports_reachable() {
        let f = Fixture::new();
        f.0.submit(submission(), source("one")).unwrap();
        f.0.submit(submission(), source("two")).unwrap();
        let page =
            f.0.list(Filter {
                query: Some("EXAMPLE".into()),
                limit: Some(1),
                ..Filter::default()
            })
            .unwrap();
        assert_eq!(page["total"], 2);
        assert_eq!(page["nextOffset"], 1);
        assert_eq!(page["newCount"], 2);
        let next =
            f.0.list(Filter {
                offset: Some(1),
                limit: Some(1),
                ..Filter::default()
            })
            .unwrap();
        assert_ne!(page["items"][0]["id"], next["items"][0]["id"]);
        assert!(next["nextOffset"].is_null());
        assert_eq!(
            f.0.list(Filter {
                status: Some(Status::Resolved),
                ..Filter::default()
            })
            .unwrap()["total"],
            0
        );
    }
    #[test]
    fn invalid_or_unwritable_inbox_never_acknowledges_or_overwrites() {
        let f = Fixture::new();
        let mut invalid = submission();
        invalid.title = " ".into();
        assert!(f.0.submit(invalid, source("one")).is_err());
        assert!(!f.0.path.exists());
        fs::create_dir_all(f.0.path.parent().unwrap()).unwrap();
        fs::write(&f.0.path, "broken").unwrap();
        assert!(f.0.submit(submission(), source("one")).is_err());
        assert_eq!(fs::read_to_string(&f.0.path).unwrap(), "broken");
        fs::remove_file(&f.0.path).unwrap();
        fs::create_dir(&f.0.path).unwrap();
        assert!(f.0.submit(submission(), source("one")).is_err());
    }
    #[test]
    fn simultaneous_reports_are_not_lost() {
        let f = Fixture::new();
        std::thread::scope(|scope| {
            for i in 0..8 {
                let store = &f.0;
                scope.spawn(move || store.submit(submission(), source(&i.to_string())).unwrap());
            }
        });
        assert_eq!(f.0.list(Filter::default()).unwrap()["total"], 8);
    }
}
