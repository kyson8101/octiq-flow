//! Manual, metadata-only disk inventory. No cleanup is executed by the host.
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{
    collections::HashSet,
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex, OnceLock,
    },
    time::{SystemTime, UNIX_EPOCH},
};
mod history;
mod scan;
mod script;

pub const THRESHOLD: u64 = 104_857_600;
pub(super) const DAY: u64 = 86_400_000;
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Report {
    pub scan_id: String,
    pub scanned_at: u64,
    pub platform: String,
    pub home: String,
    pub threshold_bytes: u64,
    pub total_bytes: u64,
    pub items: Vec<Item>,
    pub skipped: Vec<Skipped>,
    pub previous_scan_at: Option<u64>,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Item {
    pub id: String,
    pub key: String,
    pub group: String,
    pub kind: String,
    pub label: String,
    pub path: String,
    pub bytes: u64,
    pub modified_at: u64,
    pub effect: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub note: Option<String>,
    pub not_recommended: bool,
    pub action: Option<Action>,
    pub previous_bytes: Option<u64>,
    pub grew: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub worktree: Option<Worktree>,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum Action {
    Tool {
        command: String,
    },
    Worktree {
        repo: String,
        path: String,
    },
    Rm {
        path: String,
    },
    RmOlderThan {
        path: String,
        days: u32,
        exclude: Vec<String>,
    },
    Docker {
        command: String,
    },
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Worktree {
    pub repo: String,
    pub branch: String,
    pub clean: bool,
    pub merged: bool,
    pub mainline: String,
    pub idle_days: u64,
    pub in_use: bool,
    pub eligible: bool,
    pub ignored_bytes: u64,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Skipped {
    pub path: String,
    pub reason: String,
}
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct Running {
    scan_id: String,
    started_at: u64,
    phase: String,
    entries: u64,
    bytes: u64,
}
#[derive(Default)]
struct State {
    running: Option<Running>,
    cancel: Option<Arc<AtomicBool>>,
    report: Option<Report>,
    loaded: bool,
}
#[derive(Default)]
struct Manager {
    state: Mutex<State>,
}
static MANAGER: OnceLock<Arc<Manager>> = OnceLock::new();
fn manager() -> &'static Arc<Manager> {
    MANAGER.get_or_init(|| Arc::new(Manager::default()))
}
pub(super) fn now() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}
pub(super) fn display(path: &Path) -> String {
    path.to_string_lossy().into_owned()
}
fn platform() -> &'static str {
    if cfg!(windows) {
        "windows"
    } else if cfg!(target_os = "macos") {
        "macos"
    } else {
        "linux"
    }
}

impl Manager {
    fn load(&self, state: &mut State, home: &Path) -> Result<(), String> {
        if !state.loaded {
            state.report = history::load(home)?;
            state.loaded = true;
        }
        Ok(())
    }
    fn state(&self, home: &Path) -> Result<Value, String> {
        let mut state = self.state.lock().map_err(|e| e.to_string())?;
        self.load(&mut state, home)?;
        Ok(json!({"running":state.running,"report":state.report}))
    }
    fn start(self: &Arc<Self>, home: PathBuf, managed: HashSet<PathBuf>) -> Result<Value, String> {
        let scan_id = uuid::Uuid::new_v4().to_string();
        let cancel = Arc::new(AtomicBool::new(false));
        {
            let mut state = self.state.lock().map_err(|e| e.to_string())?;
            if state.running.is_some() {
                return Err("A disk scan is already running".into());
            }
            self.load(&mut state, &home)?;
            state.running = Some(Running {
                scan_id: scan_id.clone(),
                started_at: now(),
                phase: "home".into(),
                entries: 0,
                bytes: 0,
            });
            state.cancel = Some(cancel.clone());
        }
        let manager = self.clone();
        let id = scan_id.clone();
        let spawned = std::thread::Builder::new().name("disk-report".into()).spawn(move || {
            let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                let mut scanner = scan::Scanner::new(home.clone(), platform(), id.clone(), cancel.clone(), managed);
                let mut report = scanner.run(|phase, entries, bytes, path| {
                    if let Ok(mut state) = manager.state.lock() {
                        if let Some(r) = &mut state.running { r.phase=phase.into();r.entries=entries;r.bytes=bytes; }
                    }
                    crate::bus::emit("disk-scan-progress",json!({"scanId":id,"phase":phase,"entries":entries,"bytes":bytes,"path":path}));
                })?;
                if cancel.load(Ordering::Relaxed) { return Err("Disk scan cancelled".into()); }
                history::save(&home, &mut report)?;
                Ok::<_,String>(report)
            })).unwrap_or_else(|_|Err("Disk scan thread panicked".into()));
            let error = result.as_ref().err().cloned();
            if let Ok(mut state) = manager.state.lock() {
                if let Ok(report) = result {state.report=Some(report);}
                state.running=None; state.cancel=None;
            }
            crate::bus::emit("disk-scan-done",json!({"scanId":id,"ok":error.is_none(),"error":error}));
        });
        if let Err(error) = spawned {
            let mut state = self.state.lock().map_err(|e| e.to_string())?;
            state.running = None;
            state.cancel = None;
            return Err(error.to_string());
        }
        Ok(json!({"scanId":scan_id}))
    }
}
pub fn start(store: &crate::orchestration::OrchestrationStore) -> Result<Value, String> {
    manager().start(
        crate::paths::home_dir().ok_or("Home folder is unavailable")?,
        store.disk_report_workspaces()?,
    )
}
pub fn state() -> Result<Value, String> {
    manager().state(&crate::paths::home_dir().ok_or("Home folder is unavailable")?)
}
pub fn cancel(scan_id: &str) -> Result<Value, String> {
    let state = manager().state.lock().map_err(|e| e.to_string())?;
    let matching = state.running.as_ref().is_some_and(|r| r.scan_id == scan_id);
    if matching {
        if let Some(cancel) = &state.cancel {
            cancel.store(true, Ordering::Relaxed);
        }
    }
    Ok(json!({"cancelled":matching}))
}
pub fn cleanup(scan_id: &str, ids: &[String], allow_rm: bool) -> Result<Value, String> {
    let mut state = manager().state.lock().map_err(|e| e.to_string())?;
    manager().load(
        &mut state,
        &crate::paths::home_dir().ok_or("Home folder is unavailable")?,
    )?;
    let report = state.report.as_ref().ok_or("Unknown or stale disk scan")?;
    let selected = select(report, scan_id, ids)?;
    let windows = report.platform == "windows";
    let date = chrono::Local::now().format("%Y-%m-%d");
    Ok(
        json!({"fileName":format!("octiq-cleanup-{date}.{}",if windows {"ps1"} else {"sh"}),"script":script::generate(&selected,windows,allow_rm)}),
    )
}

fn select<'a>(report: &'a Report, scan_id: &str, ids: &[String]) -> Result<Vec<&'a Item>, String> {
    if report.scan_id != scan_id {
        return Err("Unknown or stale disk scan".into());
    }
    let mut selected = Vec::new();
    let mut seen = HashSet::new();
    for id in ids {
        let item = report
            .items
            .iter()
            .find(|i| &i.id == id)
            .ok_or("Unknown disk report item")?;
        if item.group == "work" {
            return Err("Work items cannot be included in cleanup scripts".into());
        }
        if item.action.is_none() {
            return Err("This item has no supported cleanup action".into());
        }
        if seen.insert(id) {
            selected.push(item);
        }
    }
    Ok(selected)
}
