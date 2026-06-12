// Schedule store. A schedule is a daily "cron job": at a chosen time of day it
// opens a terminal, runs a launch command (e.g. `claude`), and optionally types
// one line of input into it (e.g. `hi`). Schedules are user-scoped and not bound
// to any workspace, so they live in their own JSON file (schedules.json) in the
// app data dir, separate from the workspace and utilities stores. The store is
// owned by the Rust backend (not the web view) and persisted as pretty JSON, so
// it survives a restart.
//
// This module is the STORE only. The actual firing — checking the clock,
// spawning the terminal, and typing the input — is done in the frontend
// (scheduler.js), because only the frontend can open a PTY terminal and route
// its output to an xterm. The backend just keeps the saved jobs and records when
// each one last ran (`last_run`) so a restart inside the same minute cannot fire
// a job twice.
use std::fs;
use std::path::PathBuf;
use std::sync::Mutex;

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager, State};
use uuid::Uuid;

/// One daily schedule. `command` is the launch command run when the terminal
/// opens; `input` is optional text typed into that terminal a moment later
/// (empty means "type nothing"). `time` is the local time of day in 24-hour
/// "HH:MM" form. `last_run` is the "YYYY-MM-DD" date the job last fired, or empty
/// if it has never fired — the frontend reads it to fire each job once per day.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct Schedule {
    pub id: String,
    pub label: String,
    /// The command run when the terminal opens, e.g. "claude".
    pub command: String,
    /// Optional line typed into the terminal after the command starts, e.g. "hi".
    #[serde(default)]
    pub input: String,
    /// Optional working directory the terminal opens in. Empty means the default.
    #[serde(default)]
    pub cwd: String,
    /// Local time of day to run, 24-hour "HH:MM".
    pub time: String,
    /// Whether the schedule is active. A disabled job is kept but never fires.
    #[serde(default = "default_true")]
    pub enabled: bool,
    /// "YYYY-MM-DD" of the last fire, or "" if never fired. Set by mark_fired.
    #[serde(default)]
    pub last_run: String,
}

/// Default for `enabled` so a file written before the field existed loads as on.
fn default_true() -> bool {
    true
}

/// The full on-disk shape. Wrapped in a struct so the file format can grow later
/// without breaking older files.
#[derive(Debug, Default, Serialize, Deserialize)]
struct SchedulesData {
    #[serde(default)]
    schedules: Vec<Schedule>,
}

/// In-memory schedule list plus the file it is saved to.
pub struct SchedulesState {
    data: Mutex<SchedulesData>,
    file: PathBuf,
}

impl SchedulesState {
    /// Load the store from disk. A missing or unreadable file starts an empty
    /// store rather than failing the whole app.
    pub fn load(app: &AppHandle) -> Self {
        let dir = app
            .path()
            .app_data_dir()
            .expect("app data dir should resolve");
        let _ = fs::create_dir_all(&dir);
        Self::from_file(dir.join("schedules.json"))
    }

    /// Build a store backed by `file`, reading it if it already exists. Split out
    /// from `load` so tests can point the store at a temp file with no AppHandle.
    fn from_file(file: PathBuf) -> Self {
        let data = fs::read_to_string(&file)
            .ok()
            .and_then(|raw| serde_json::from_str::<SchedulesData>(&raw).ok())
            .unwrap_or_default();
        Self {
            data: Mutex::new(data),
            file,
        }
    }

    /// Write the current state back to disk as pretty JSON.
    fn save(&self, data: &SchedulesData) -> Result<(), String> {
        let raw = serde_json::to_string_pretty(data).map_err(|e| e.to_string())?;
        fs::write(&self.file, raw).map_err(|e| e.to_string())
    }

    // ---- Core operations (testable; the #[tauri::command] fns wrap these) ----

    /// All schedules in their stored order.
    pub fn list(&self) -> Result<Vec<Schedule>, String> {
        let data = self.data.lock().map_err(|e| e.to_string())?;
        Ok(data.schedules.clone())
    }

    /// Create a schedule from validated fields and return it.
    pub fn add(
        &self,
        label: String,
        command: String,
        input: String,
        cwd: String,
        time: String,
        enabled: bool,
    ) -> Result<Schedule, String> {
        let (label, command, input, cwd, time) = validate(label, command, input, cwd, time)?;
        let mut data = self.data.lock().map_err(|e| e.to_string())?;
        let schedule = Schedule {
            id: Uuid::new_v4().to_string(),
            label,
            command,
            input,
            cwd,
            time,
            enabled,
            last_run: String::new(),
        };
        data.schedules.push(schedule.clone());
        self.save(&data)?;
        Ok(schedule)
    }

    /// Update an existing schedule in place. Editing a job clears `last_run` so a
    /// changed time can fire again today. Errors if the id is unknown.
    pub fn update(
        &self,
        id: &str,
        label: String,
        command: String,
        input: String,
        cwd: String,
        time: String,
        enabled: bool,
    ) -> Result<(), String> {
        let (label, command, input, cwd, time) = validate(label, command, input, cwd, time)?;
        let mut data = self.data.lock().map_err(|e| e.to_string())?;
        let schedule = data
            .schedules
            .iter_mut()
            .find(|s| s.id == id)
            .ok_or("schedule not found")?;
        schedule.label = label;
        schedule.command = command;
        schedule.input = input;
        schedule.cwd = cwd;
        schedule.time = time;
        schedule.enabled = enabled;
        schedule.last_run = String::new();
        self.save(&data)
    }

    /// Delete a schedule by id. Unknown ids are a no-op.
    pub fn delete(&self, id: &str) -> Result<(), String> {
        let mut data = self.data.lock().map_err(|e| e.to_string())?;
        data.schedules.retain(|s| s.id != id);
        self.save(&data)
    }

    /// Turn a schedule on or off without editing its other fields. Errors if the
    /// id is unknown.
    pub fn set_enabled(&self, id: &str, enabled: bool) -> Result<(), String> {
        let mut data = self.data.lock().map_err(|e| e.to_string())?;
        let schedule = data
            .schedules
            .iter_mut()
            .find(|s| s.id == id)
            .ok_or("schedule not found")?;
        schedule.enabled = enabled;
        self.save(&data)
    }

    /// Record that a schedule fired on `date` ("YYYY-MM-DD"). The frontend calls
    /// this right after it opens the terminal, so the next tick in the same
    /// minute (and any restart that minute) sees the job as already run today.
    /// Unknown ids are a no-op.
    pub fn mark_fired(&self, id: &str, date: String) -> Result<(), String> {
        let mut data = self.data.lock().map_err(|e| e.to_string())?;
        if let Some(schedule) = data.schedules.iter_mut().find(|s| s.id == id) {
            schedule.last_run = date;
            self.save(&data)?;
        }
        Ok(())
    }
}

/// Validate and normalise the shared fields used by add and update. Trims the
/// fields and requires a non-empty label and command, and a valid 24-hour time.
/// `input` and `cwd` are optional, so they are only trimmed.
fn validate(
    label: String,
    command: String,
    input: String,
    cwd: String,
    time: String,
) -> Result<(String, String, String, String, String), String> {
    let label = label.trim().to_string();
    let command = command.trim().to_string();
    let time = time.trim().to_string();
    if label.is_empty() {
        return Err("schedule label cannot be empty".into());
    }
    if command.is_empty() {
        return Err("schedule command cannot be empty".into());
    }
    if !is_valid_time(&time) {
        return Err("time must be a 24-hour HH:MM value, e.g. 05:00".into());
    }
    Ok((
        label,
        command,
        input.trim().to_string(),
        cwd.trim().to_string(),
        time,
    ))
}

/// True if `time` is a 24-hour "HH:MM" string: two-digit hour 00–23, a colon,
/// two-digit minute 00–59. Kept pure so the format rule is unit-tested directly.
fn is_valid_time(time: &str) -> bool {
    let bytes = time.as_bytes();
    if bytes.len() != 5 || bytes[2] != b':' {
        return false;
    }
    let digits = [bytes[0], bytes[1], bytes[3], bytes[4]];
    if !digits.iter().all(|b| b.is_ascii_digit()) {
        return false;
    }
    let hour = (bytes[0] - b'0') * 10 + (bytes[1] - b'0');
    let minute = (bytes[3] - b'0') * 10 + (bytes[4] - b'0');
    hour < 24 && minute < 60
}

// ---- Tauri command wrappers ----------------------------------------------
// Thin adapters so the web view can call the store. Each forwards to the matching
// SchedulesState method above; the methods hold the logic and the tests.

/// Return all schedules in their stored order.
#[tauri::command]
pub fn list_schedules(state: State<SchedulesState>) -> Result<Vec<Schedule>, String> {
    state.list()
}

/// Create a new schedule and return it. Label, command, and a valid HH:MM time
/// are required; input and cwd are optional. A uuid id is generated.
#[tauri::command]
pub fn add_schedule(
    state: State<SchedulesState>,
    label: String,
    command: String,
    input: String,
    cwd: String,
    time: String,
    enabled: bool,
) -> Result<Schedule, String> {
    state.add(label, command, input, cwd, time, enabled)
}

/// Update an existing schedule in place. Validates the same way as add.
#[tauri::command]
pub fn update_schedule(
    state: State<SchedulesState>,
    id: String,
    label: String,
    command: String,
    input: String,
    cwd: String,
    time: String,
    enabled: bool,
) -> Result<(), String> {
    state.update(&id, label, command, input, cwd, time, enabled)
}

/// Delete a schedule by id.
#[tauri::command]
pub fn delete_schedule(state: State<SchedulesState>, id: String) -> Result<(), String> {
    state.delete(&id)
}

/// Turn a schedule on or off.
#[tauri::command]
pub fn set_schedule_enabled(
    state: State<SchedulesState>,
    id: String,
    enabled: bool,
) -> Result<(), String> {
    state.set_enabled(&id, enabled)
}

/// Record that a schedule fired on `date` ("YYYY-MM-DD").
#[tauri::command]
pub fn mark_schedule_fired(
    state: State<SchedulesState>,
    id: String,
    date: String,
) -> Result<(), String> {
    state.mark_fired(&id, date)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A store backed by a fresh temp file, so each test is isolated.
    fn temp_store() -> SchedulesState {
        let file = std::env::temp_dir().join(format!("octiq-sched-test-{}.json", Uuid::new_v4()));
        SchedulesState::from_file(file)
    }

    #[test]
    fn valid_times_are_accepted() {
        for t in ["00:00", "05:00", "09:30", "23:59", "12:34"] {
            assert!(is_valid_time(t), "{t} should be valid");
        }
    }

    #[test]
    fn invalid_times_are_rejected() {
        for t in [
            "", "5:00", "24:00", "23:60", "0500", "05-00", "5am", "05:0", "005:00", "ab:cd",
        ] {
            assert!(!is_valid_time(t), "{t} should be rejected");
        }
    }

    #[test]
    fn add_requires_label_command_and_valid_time() {
        let store = temp_store();
        assert!(store
            .add(
                "".into(),
                "claude".into(),
                "".into(),
                "".into(),
                "05:00".into(),
                true
            )
            .is_err());
        assert!(store
            .add(
                "Daily".into(),
                "  ".into(),
                "".into(),
                "".into(),
                "05:00".into(),
                true
            )
            .is_err());
        assert!(store
            .add(
                "Daily".into(),
                "claude".into(),
                "".into(),
                "".into(),
                "5am".into(),
                true
            )
            .is_err());
    }

    #[test]
    fn add_trims_fields_and_defaults_last_run_empty() {
        let store = temp_store();
        let s = store
            .add(
                "  Morning  ".into(),
                "  claude  ".into(),
                "  hi  ".into(),
                "  /tmp  ".into(),
                " 05:00 ".into(),
                true,
            )
            .unwrap();
        assert_eq!(s.label, "Morning");
        assert_eq!(s.command, "claude");
        assert_eq!(s.input, "hi");
        assert_eq!(s.cwd, "/tmp");
        assert_eq!(s.time, "05:00");
        assert!(s.enabled);
        assert_eq!(s.last_run, "");
        // It is persisted and reloads identically.
        let reloaded = SchedulesState::from_file(store.file.clone());
        assert_eq!(reloaded.list().unwrap(), vec![s]);
    }

    #[test]
    fn update_changes_fields_and_clears_last_run() {
        let store = temp_store();
        let s = store
            .add(
                "A".into(),
                "claude".into(),
                "hi".into(),
                "".into(),
                "05:00".into(),
                true,
            )
            .unwrap();
        store.mark_fired(&s.id, "2026-06-12".into()).unwrap();
        store
            .update(
                &s.id,
                "B".into(),
                "codex".into(),
                "yo".into(),
                "/work".into(),
                "06:15".into(),
                false,
            )
            .unwrap();
        let got = store.list().unwrap();
        assert_eq!(got.len(), 1);
        assert_eq!(got[0].label, "B");
        assert_eq!(got[0].command, "codex");
        assert_eq!(got[0].input, "yo");
        assert_eq!(got[0].cwd, "/work");
        assert_eq!(got[0].time, "06:15");
        assert!(!got[0].enabled);
        // Editing clears last_run so the new time can fire again today.
        assert_eq!(got[0].last_run, "");
    }

    #[test]
    fn update_unknown_id_errors() {
        let store = temp_store();
        assert!(store
            .update(
                "nope".into(),
                "X".into(),
                "claude".into(),
                "".into(),
                "".into(),
                "05:00".into(),
                true
            )
            .is_err());
    }

    #[test]
    fn set_enabled_toggles_without_touching_other_fields() {
        let store = temp_store();
        let s = store
            .add(
                "A".into(),
                "claude".into(),
                "hi".into(),
                "".into(),
                "05:00".into(),
                true,
            )
            .unwrap();
        store.set_enabled(&s.id, false).unwrap();
        let got = store.list().unwrap();
        assert!(!got[0].enabled);
        assert_eq!(got[0].command, "claude");
        assert_eq!(got[0].input, "hi");
    }

    #[test]
    fn mark_fired_records_the_date() {
        let store = temp_store();
        let s = store
            .add(
                "A".into(),
                "claude".into(),
                "".into(),
                "".into(),
                "05:00".into(),
                true,
            )
            .unwrap();
        store.mark_fired(&s.id, "2026-06-12".into()).unwrap();
        assert_eq!(store.list().unwrap()[0].last_run, "2026-06-12");
        // An unknown id is a no-op, not an error.
        assert!(store.mark_fired("nope", "2026-06-12".into()).is_ok());
    }

    #[test]
    fn delete_removes_only_the_matching_schedule() {
        let store = temp_store();
        let a = store
            .add(
                "A".into(),
                "claude".into(),
                "".into(),
                "".into(),
                "05:00".into(),
                true,
            )
            .unwrap();
        let b = store
            .add(
                "B".into(),
                "codex".into(),
                "".into(),
                "".into(),
                "06:00".into(),
                true,
            )
            .unwrap();
        store.delete(&a.id).unwrap();
        let got = store.list().unwrap();
        assert_eq!(got.len(), 1);
        assert_eq!(got[0].id, b.id);
    }
}
