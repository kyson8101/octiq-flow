//! Profile-wide feedback, separate from project work and chat lifetimes.
//! Only a completed atomic write acknowledges a report. Agents submit/read;
//! the browser owns triage. Reports never launch work on their own.
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

    pub fn update(&self, update: Update) -> Result<Report, String> {
        bounded(&update.note, "Triage note", 8_000)?;
        let _guard = LOCK.lock().map_err(|_| "Feedback inbox is unavailable")?;
        let mut inbox = self.read()?;
        let report = inbox
            .reports
            .iter_mut()
            .find(|r| r.id == update.id)
            .ok_or("Feedback report not found")?;
        if report.revision != update.expected_revision {
            return Err(
                "This report changed in another window. Reload the report before saving again."
                    .into(),
            );
        }
        report.status = update.status;
        report.note = update.note;
        report.updated_at = now();
        report.revision += 1;
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
/// never from model-supplied source/version fields. Triage is not an agent action.
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
        _ => Err("Unknown feedback action. Agents may submit, list, or get reports.".into()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    struct Fixture(Store);
    impl Fixture {
        fn new() -> Self {
            Self(Store {
                path: std::env::temp_dir()
                    .join(format!("octiq-feedback-{}", uuid::Uuid::new_v4()))
                    .join("feedback.json"),
            })
        }
    }
    impl Drop for Fixture {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(self.0.path.parent().unwrap());
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
