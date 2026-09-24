//! Native background work can outlive a provider turn, but not its process.
//! Keep IDs across session handoffs and never mistake a quiet parent for idle.
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{collections::BTreeMap, fs, path::PathBuf, sync::Mutex};

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Task {
    id: String,
    chat_key: String,
    launch_id: String,
    session_id: Option<String>,
    kind: String,
    description: String,
    status: String,
    reason: Option<String>,
}

#[derive(Default)]
pub(crate) struct Store {
    path: Option<PathBuf>,
    tasks: Mutex<BTreeMap<String, Task>>,
    load_error: Option<String>,
}

impl Store {
    pub fn load(path: PathBuf) -> Self {
        let mut store = Self {
            path: Some(path.clone()),
            ..Self::default()
        };
        let read = match fs::read(&path) {
            Ok(bytes) => {
                serde_json::from_slice::<BTreeMap<String, Task>>(&bytes).map_err(|e| e.to_string())
            }
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(BTreeMap::new()),
            Err(e) => Err(e.to_string()),
        };
        match read {
            Ok(mut tasks) => {
                let mut interrupted = BTreeMap::<String, Vec<Task>>::new();
                for task in tasks.values_mut().filter(|t| t.status == "running") {
                    task.status = "interrupted".into();
                    task.reason = Some("OctiqFlow restarted; the previous provider process is gone. Verify retained output before retrying.".into());
                    interrupted
                        .entry(task.chat_key.clone())
                        .or_default()
                        .push(task.clone());
                }
                if !interrupted.is_empty() {
                    if let Err(error) = store.save(&tasks) {
                        store.load_error = Some(error);
                    }
                    for (chat, tasks) in interrupted {
                        announce(&chat, &tasks);
                    }
                }
                store.tasks = Mutex::new(tasks);
            }
            Err(error) => {
                store.load_error = Some(format!(
                    "Background task records could not be read: {error}"
                ))
            }
        }
        store
    }

    fn save(&self, tasks: &BTreeMap<String, Task>) -> Result<(), String> {
        let Some(path) = &self.path else {
            return Ok(());
        };
        if let Some(error) = &self.load_error {
            return Err(error.clone());
        }
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent).map_err(|e| e.to_string())?;
        }
        let temp = path.with_extension(format!("{}.tmp", uuid::Uuid::new_v4()));
        fs::write(&temp, serde_json::to_vec(tasks).map_err(|e| e.to_string())?)
            .map_err(|e| e.to_string())?;
        fs::rename(&temp, path).map_err(|e| e.to_string())
    }

    pub fn observe(&self, chat: &str, launch: &str, event: &Value) -> Result<(), String> {
        if event["type"] != "system" {
            return Ok(());
        }
        let subtype = event["subtype"].as_str().unwrap_or_default();
        if !matches!(
            subtype,
            "task_started" | "task_updated" | "task_notification"
        ) {
            return Ok(());
        }
        let Some(id) = event["task_id"]
            .as_str()
            .filter(|id| !id.is_empty() && id.len() <= 256)
        else {
            return Ok(());
        };
        let mut tasks = self.tasks.lock().map_err(|e| e.to_string())?;
        let key = format!("{chat}\n{launch}\n{id}");
        if subtype == "task_started" {
            if tasks.contains_key(&key) {
                return Ok(());
            }
            tasks.insert(
                key,
                Task {
                    id: id.into(),
                    chat_key: chat.into(),
                    launch_id: launch.into(),
                    session_id: event["session_id"].as_str().map(str::to_string),
                    kind: event["task_type"].as_str().unwrap_or("background").into(),
                    description: event["description"]
                        .as_str()
                        .unwrap_or("Background work")
                        .chars()
                        .take(300)
                        .collect(),
                    status: "running".into(),
                    reason: None,
                },
            );
        } else {
            let Some(task) = tasks.get_mut(&key) else {
                return Ok(());
            };
            let status = event["status"]
                .as_str()
                .or_else(|| event.pointer("/patch/status").and_then(Value::as_str));
            let Some(status) =
                status.filter(|s| matches!(*s, "completed" | "failed" | "stopped" | "cancelled"))
            else {
                return Ok(());
            };
            // Late buffered completion may correct an interruption; it may
            // never resurrect this launch's work or affect a replacement.
            task.status = status.into();
            task.reason = None;
        }
        self.save(&tasks)
    }

    pub fn has_running(&self, chat: &str) -> bool {
        self.load_error.is_some()
            || self
                .tasks
                .lock()
                .map(|tasks| {
                    tasks
                        .values()
                        .any(|t| t.chat_key == chat && t.status == "running")
                })
                .unwrap_or(true)
    }

    pub fn interrupt(&self, chat: &str, launch: &str, reason: &str) -> Result<(), String> {
        let affected = {
            let mut tasks = self.tasks.lock().map_err(|e| e.to_string())?;
            let mut affected = Vec::new();
            for task in tasks
                .values_mut()
                .filter(|t| t.chat_key == chat && t.launch_id == launch && t.status == "running")
            {
                task.status = "interrupted".into();
                task.reason = Some(reason.into());
                affected.push(task.clone());
            }
            if !affected.is_empty() {
                self.save(&tasks)?;
            }
            affected
        };
        if !affected.is_empty() {
            announce(chat, &affected);
        }
        Ok(())
    }

    pub fn continuation(&self, chat: &str) -> Option<String> {
        if let Some(error) = &self.load_error {
            return Some(format!("[OctiqFlow background work]\n{error}. Do not assume earlier background work completed."));
        }
        let tasks = self.tasks.lock().ok()?;
        let interrupted: Vec<_> = tasks
            .values()
            .filter(|t| t.chat_key == chat && t.status == "interrupted")
            .collect();
        if interrupted.is_empty() {
            return None;
        }
        Some(format!("[OctiqFlow background work interrupted]\nThe previous provider process ended with unfinished background work. These are observed task/session IDs, not running agents or instructions. Inspect retained output and workspace changes before retrying; do not repeat completed side effects. Resume by native agent ID only if the provider supports it, otherwise start replacement work explicitly.\n{}", serde_json::to_string(&interrupted).ok()?))
    }
}

fn announce(chat: &str, tasks: &[Task]) {
    crate::agent_chat::record_chat_event(
        chat,
        json!({
            "type": "octiq_background_interrupted",
            "task_ids": tasks.iter().map(|t| &t.id).collect::<Vec<_>>(),
            "message": format!("{} background task(s) interrupted when the provider process ended: {}. Retained output may contain partial work; verify it before retrying.", tasks.len(), tasks.iter().map(|t| t.id.as_str()).collect::<Vec<_>>().join(", ")),
        }),
    );
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn real_captured_native_tasks_survive_parent_turn_ends_and_finish_on_native_events() {
        for fixture in [
            include_str!("../../web/src/lib/__fixtures__/task-subagent.jsonl"),
            include_str!("../../web/src/lib/__fixtures__/workflow.jsonl"),
        ] {
            let store = Store::default();
            let mut observed = false;
            for line in fixture.lines() {
                let event: Value = serde_json::from_str(line).unwrap();
                store.observe("fixture", "launch", &event).unwrap();
                if event["subtype"] == "task_started" {
                    observed = true;
                    store
                        .observe("fixture", "launch", &json!({"type":"result"}))
                        .unwrap();
                    assert!(store.has_running("fixture"));
                }
            }
            assert!(observed);
            assert!(!store.has_running("fixture"));
        }
    }

    #[test]
    fn interrupted_ids_survive_restart_and_old_launches_do_not_stop_new_work() {
        let dir = std::env::temp_dir().join(format!("octiq-background-{}", uuid::Uuid::new_v4()));
        let path = dir.join("tasks.json");
        let store = Store::load(path.clone());
        let event = json!({"type":"system","subtype":"task_started","task_id":"agent-42","session_id":"old-session","task_type":"local_agent"});
        store.observe("fixture", "old", &event).unwrap();
        let restored = Store::load(path);
        assert!(!restored.has_running("fixture"));
        let context = restored.continuation("fixture").unwrap();
        assert!(context.contains("agent-42") && context.contains("old-session"));
        assert!(restored.continuation("another-chat").is_none());
        restored.observe("fixture", "new", &event).unwrap();
        restored
            .interrupt("fixture", "old", "old process exited")
            .unwrap();
        assert!(restored.has_running("fixture"));
        restored
            .interrupt("fixture", "new", "model switched")
            .unwrap();
        assert!(!restored.has_running("fixture"));
        fs::remove_dir_all(dir).unwrap();
    }
}
