//! Host-owned lifespan of linked worktrees. States are observations, never
//! persisted. Only recorded host allocations and octiq chat worktrees qualify.
//! Session/history folders are deliberately outside this module's reach.
use crate::{
    dispatch::Services,
    git_ops::{lifespan as git, workflow::DeliveryEvidence},
};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{
    collections::BTreeSet,
    fs,
    path::{Path, PathBuf},
    process::Command,
    sync::{
        atomic::{AtomicBool, Ordering},
        Mutex, OnceLock,
    },
    time::{Duration, SystemTime, UNIX_EPOCH},
};
mod ignored;
mod raw;

/// The same at-stake inventory used by every removal; unknown is never zero.
pub(crate) fn at_stake_ignored_count(path: &str) -> Option<u64> {
    ignored::inventory(path)
        .ok()
        .map(|inventory| inventory.files)
}

/// Validation cleanup also uses Git's non-force removal, which still deletes
/// ignored files. Keep unknown/original data until an explicit archive flow.
pub(crate) fn require_no_at_stake_ignored(path: &str) -> Result<(), String> {
    real_dir(Path::new(path))?;
    let inventory = ignored::inventory(path)
        .map_err(|e| format!("Ignored-file inventory is unavailable; the folder is kept: {e}"))?;
    if inventory.files > 0 {
        return Err(format!(
            "{} at-stake ignored files are not preserved by Git; the folder is kept.",
            inventory.files
        ));
    }
    #[cfg(windows)]
    {
        // Git for Windows can descend into an ignored junction during
        // worktree remove. Link classification never grants that traversal.
        let mut tree = Tree::default();
        walk(path, Path::new(path), false, &mut tree)?;
        if tree.reparse {
            return Err("A Windows validation checkout contains a reparse point; its folder is kept. Remove the link separately before retrying cleanup.".into());
        }
    }
    Ok(())
}

/// Every non-Archive removal prepares this outside workspace lifecycle. The
/// caller holds lifecycle plus path/start marks at the final removal door.
pub(crate) struct RemovalProof {
    stamps: raw::Stamps,
    head: String,
}
pub(crate) fn validation_removal_proof(path: &str) -> Result<Option<RemovalProof>, String> {
    match fs::symlink_metadata(path) {
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(e) => return Err(e.to_string()),
        _ => {}
    }
    require_unprotected(Path::new(path))?;
    real_dir(Path::new(path))?;
    raw::require_recreatable_config(path, Duration::from_secs(10))?;
    let stamps = raw::Stamps::capture(path)?;
    let head = git::text(path, &["rev-parse", "HEAD"])?;
    let proof = raw::verify(path, &head, false, cfg!(windows))?;
    if proof.unrestorable > 0 {
        return Err(proof.reason());
    }
    Ok(Some(RemovalProof { stamps, head }))
}
pub(crate) fn verify_validation_removal(path: &str, proof: &RemovalProof) -> Result<(), String> {
    require_unprotected(Path::new(path))?;
    real_dir(Path::new(path))?;
    raw::require_recreatable_config(path, git::remaining(Duration::from_secs(10))?)?;
    if git::text(path, &["rev-parse", "HEAD"])? != proof.head {
        return Err("Removal HEAD changed during comparison; folder kept.".into());
    }
    require_no_at_stake_ignored(path)?;
    proof.stamps.verify(path)
}
/// Sole non-Archive physical removal door. Lifecycle and path/start guards are
/// held by the caller; every call consumes an off-lock, full-path Restore proof.
pub(crate) fn remove_proven(repo: &str, path: &str, proof: &RemovalProof) -> Result<(), String> {
    let _budget = git::FinalBudget::start();
    crate::profile::available()?;
    require_unprotected(Path::new(path))?;
    real_dir(Path::new(path))?;
    raw::require_recreatable_config(path, git::remaining(Duration::from_secs(10))?)?;
    let root = git::text(path, &["rev-parse", "--show-toplevel"])?;
    let common = git::text(
        path,
        &["rev-parse", "--path-format=absolute", "--git-common-dir"],
    )?;
    real_dir(Path::new(repo))?;
    if Path::new(&root) != Path::new(path)
        || Path::new(&common).parent() != Some(Path::new(repo))
        || Path::new(path) == Path::new(repo)
    {
        return Err("Removal checkout path or repository changed; folder kept.".into());
    }
    verify_validation_removal(path, proof)?;
    crate::profile::available()?;
    git::remaining(Duration::from_secs(10))?;
    git::remove(repo, path, false)
}
/// Reused by task Cleanup/Abandon, mission Close/Abandon and validation.
/// Take under lifecycle, before dropping it for the long Restore comparison.
pub(crate) struct RemovalHold<'a> {
    _paths: Vec<crate::agent_chat::LifespanHold<'a>>,
    _starts: Vec<crate::agent_chat::StartClaim<'a>>,
}
pub(crate) fn hold_removal<'a>(
    chats: &'a crate::agent_chat::ChatManager,
    path: &str,
) -> Result<RemovalHold<'a>, String> {
    hold_removals(chats, &[path])
}
/// A multi-checkout operation owns all path marks before collecting any chat
/// keys. One stopped chat can cover several roots through cwd/extraDirs: claim
/// that key once, and keep the complete guard across every proof and removal.
pub(crate) fn hold_removals<'a>(
    chats: &'a crate::agent_chat::ChatManager,
    paths: &[&str],
) -> Result<RemovalHold<'a>, String> {
    let paths = paths
        .iter()
        .copied()
        .collect::<std::collections::BTreeSet<_>>();
    let marks = paths
        .iter()
        .map(|path| chats.hold_lifespan_checkout(path))
        .collect::<Result<Vec<_>, _>>()?;
    let mut keys = Vec::new();
    for path in &paths {
        keys.extend(chats.lifespan_chat_keys(path)?);
    }
    keys.extend(
        crate::chat_index::list()
            .into_iter()
            .filter(|c| {
                c.cwd
                    .as_ref()
                    .is_some_and(|cwd| paths.iter().any(|path| Path::new(cwd).starts_with(path)))
            })
            .map(|c| format!("chat:{}", c.id)),
    );
    keys.sort();
    keys.dedup();
    let claims = keys
        .iter()
        .map(|k| chats.claim_start(k))
        .collect::<Result<Vec<_>, _>>()?;
    for path in paths {
        chats.require_lifespan_idle(path)?;
    }
    Ok(RemovalHold {
        _paths: marks,
        _starts: claims,
    })
}

const DAY: i64 = 86_400_000;
pub(crate) const OWED: &str = "worktree lifespan settings, pins and sweep outcomes";
fn now() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as i64
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Settings {
    pub enabled: bool,
    pub build_after_days: u32,
    pub remove_after_days: u32,
}
impl Default for Settings {
    fn default() -> Self {
        Self {
            enabled: true,
            build_after_days: 3,
            remove_after_days: 14,
        }
    }
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Owner {
    pub kind: String,
    pub label: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub run_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub task_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub chat_key: Option<String>,
}
impl Owner {
    fn unknown() -> Self {
        Self {
            kind: "unknown".into(),
            label: "Not created by OctiqFlow".into(),
            run_id: None,
            task_id: None,
            chat_key: None,
        }
    }
}
#[derive(Clone, Debug)]
pub(crate) struct Allocation {
    pub path: String,
    pub repo: String,
    pub branch: Option<String>,
    pub base: String,
    pub last_activity: i64,
    pub active: Option<String>,
    pub chats: Vec<String>,
    pub owner: Owner,
    pub swept_at: Option<i64>,
    pub reconcilable: bool,
}
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct Item {
    key: String,
    path: String,
    repo: String,
    branch: Option<String>,
    head: String,
    status_hash: String,
    owner: Owner,
    state: String,
    pinned: bool,
    idle_days: f64,
    bytes: Option<u64>,
    build_bytes: Option<u64>,
    dirty_files: usize,
    untracked_files: usize,
    ignored_files: Option<u64>,
    ignored_bytes: Option<u64>,
    unmerged_commits: Option<u64>,
    pushed: Option<bool>,
    strip_at: Option<i64>,
    remove_at: Option<i64>,
    why: String,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Archive {
    key: String,
    #[serde(rename = "ref")]
    reference: String,
    repo: String,
    branch: Option<String>,
    path: String,
    archived_at: i64,
    files: usize,
    restored_at: Option<i64>,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Removed {
    path: String,
    branch: Option<String>,
    owner: Owner,
    bytes: Option<u64>,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
struct Failed {
    path: String,
    why: String,
}
#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Sweep {
    at: i64,
    stripped: usize,
    removed: Vec<Removed>,
    freed_bytes: u64,
    failed: Vec<Failed>,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Intent {
    item: Removed,
    repo: String,
    at: i64,
    #[serde(default)]
    archive_key: Option<String>,
}
#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Saved {
    #[serde(default)]
    settings: Settings,
    #[serde(default)]
    pins: BTreeSet<String>,
    #[serde(default)]
    archives: Vec<Archive>,
    #[serde(default)]
    history: Vec<Sweep>,
    #[serde(default)]
    intents: Vec<Intent>,
    #[serde(default)]
    last_sweep_at: Option<i64>,
}
#[derive(Default)]
struct Cache {
    loaded: bool,
    saved: Saved,
    items: Vec<Item>,
    owed: bool,
    pending_disable: bool,
    pending_pins: BTreeSet<String>,
    pending_reports: Vec<Sweep>,
    raw_failures: std::collections::BTreeMap<String, RawFailure>,
}
#[derive(Clone)]
struct RawFailure {
    head: String,
    stamps: raw::Stamps,
    why: String,
    mismatch: bool,
}
fn apply_raw_failure(store: &Store, o: &mut Observation) -> Result<(), String> {
    let failure = store
        .inner
        .lock()
        .map_err(|e| e.to_string())?
        .raw_failures
        .get(&o.item.path)
        .cloned();
    if let Some(failure) = failure {
        if failure.head == o.item.head && failure.stamps == raw::Stamps::capture(&o.item.path)? {
            o.removable = false;
            o.item.remove_at = None;
            if o.item.state != "active" && !o.item.pinned {
                if failure.mismatch {
                    o.item.state = "abandoned".into();
                }
                o.item.why = failure.why;
            }
        } else {
            store
                .inner
                .lock()
                .map_err(|e| e.to_string())?
                .raw_failures
                .remove(&o.item.path);
        }
    }
    Ok(())
}
fn remember_raw_failure(
    store: &Store,
    o: &Observation,
    stamps: raw::Stamps,
    why: String,
    mismatch: bool,
) -> Result<(), String> {
    let mut cache = store.inner.lock().map_err(|e| e.to_string())?;
    cache.raw_failures.insert(
        o.item.path.clone(),
        RawFailure {
            head: o.item.head.clone(),
            stamps,
            why: why.clone(),
            mismatch,
        },
    );
    if let Some(item) = cache.items.iter_mut().find(|i| i.path == o.item.path) {
        if mismatch {
            item.state = "abandoned".into();
        }
        item.why = why;
        item.remove_at = None;
    }
    Ok(())
}
pub(crate) struct Store {
    inner: Mutex<Cache>,
    scanning: AtomicBool,
}
impl Default for Store {
    fn default() -> Self {
        Self {
            inner: Mutex::new(Cache::default()),
            scanning: AtomicBool::new(false),
        }
    }
}
static STORE: OnceLock<Store> = OnceLock::new();
fn store() -> &'static Store {
    STORE.get_or_init(Store::default)
}
fn path() -> PathBuf {
    crate::profile::profile_dir().join("worktree-lifespan.json")
}
fn save(saved: &Saved) -> Result<(), String> {
    let dest = path();
    let dir = dest.parent().ok_or("Lifespan store has no parent")?;
    crate::profile::make_dir(dir)?;
    let temp = dir.join(format!(".worktree-lifespan-{}.tmp", uuid::Uuid::new_v4()));
    let result = (|| {
        use std::io::Write;
        let mut file = fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&temp)
            .map_err(|e| e.to_string())?;
        file.write_all(&serde_json::to_vec_pretty(saved).map_err(|e| e.to_string())?)
            .map_err(|e| e.to_string())?;
        file.sync_all().map_err(|e| e.to_string())?;
        crate::profile::available()?;
        fs::rename(&temp, &dest).map_err(|e| e.to_string())?;
        #[cfg(unix)]
        fs::File::open(dir)
            .and_then(|f| f.sync_all())
            .map_err(|e| e.to_string())?;
        Ok(())
    })();
    if result.is_err() {
        let _ = fs::remove_file(temp);
    }
    result
}
impl Store {
    fn load(&self, cache: &mut Cache) -> Result<(), String> {
        if cache.loaded {
            return Ok(());
        }
        cache.saved = match crate::profile::read(&path(), |e| {
            format!("Worktree lifespan could not be read: {e}")
        })? {
            Some(bytes) => serde_json::from_slice(&bytes)
                .map_err(|e| format!("Worktree lifespan record is invalid: {e}"))?,
            None => Saved::default(),
        };
        if cache.pending_disable {
            cache.saved.settings.enabled = false;
        }
        cache.saved.pins.extend(cache.pending_pins.iter().cloned());
        cache.loaded = true;
        Ok(())
    }
    fn change<T>(
        &self,
        narrowing: bool,
        change: impl FnOnce(&mut Saved) -> Result<T, String>,
    ) -> Result<T, String> {
        let mut c = self.inner.lock().map_err(|e| e.to_string())?;
        if let Err(why) = self.load(&mut c) {
            if !narrowing {
                return Err(why);
            }
            // Never overwrite an unread file with defaults. Only remember
            // restrictions, then merge them into the actual file on retry.
            let mut restricted = c.saved.clone();
            let answer = change(&mut restricted)?;
            c.pending_disable |= !restricted.settings.enabled;
            c.pending_pins.extend(restricted.pins.iter().cloned());
            c.owed = true;
            crate::unsaved::say(OWED, why);
            crate::bus::emit("worktree-lifespan-changed", &json!({}));
            return Ok(answer);
        }
        let mut next = c.saved.clone();
        let answer = change(&mut next)?;
        match save(&next) {
            Ok(()) => {
                c.owed = false;
                c.pending_disable = false;
                c.pending_pins.clear();
            }
            Err(e) if narrowing => {
                c.owed = true;
                crate::unsaved::say(OWED, e);
            }
            Err(e) => return Err(e),
        }
        c.saved = next;
        crate::bus::emit("worktree-lifespan-changed", &json!({}));
        Ok(answer)
    }
    fn saved(&self) -> Result<Saved, String> {
        let mut c = self.inner.lock().map_err(|e| e.to_string())?;
        self.load(&mut c)?;
        Ok(c.saved.clone())
    }
    fn allowed(&self, key: &str) -> Result<bool, String> {
        let s = self.saved()?;
        Ok(s.settings.enabled && !s.pins.contains(key))
    }
}
pub(crate) fn settle_owed() -> Result<(), String> {
    settle_store(store())
}
fn settle_store(state: &Store) -> Result<(), String> {
    let mut c = state.inner.lock().map_err(|e| e.to_string())?;
    if c.owed {
        state.load(&mut c)?;
        save(&c.saved)?;
        c.pending_disable = false;
        c.pending_pins.clear();
        c.owed = false;
    }
    for report in c.pending_reports.drain(..) {
        crate::bus::emit("worktree-swept", &report);
    }
    Ok(())
}
fn publish_report(state: &Store, report: &Sweep) -> Result<(), String> {
    let mut c = state.inner.lock().map_err(|e| e.to_string())?;
    if c.owed {
        c.pending_reports.push(report.clone());
    } else {
        crate::bus::emit("worktree-swept", report);
    }
    Ok(())
}
pub(crate) fn owes() -> bool {
    store().inner.lock().is_ok_and(|c| c.owed)
}
pub(crate) fn list() -> Result<Value, String> {
    crate::profile::available()?;
    let mut c = store().inner.lock().map_err(|e| e.to_string())?;
    store().load(&mut c)?;
    let mut items = c.items.clone();
    for i in &mut items {
        i.pinned = c.saved.pins.contains(&i.key);
        if i.pinned {
            i.why = "The person pinned this worktree; it is never stripped or removed.".into();
        }
        if i.pinned || !c.saved.settings.enabled {
            i.strip_at = None;
            i.remove_at = None;
        }
    }
    Ok(
        json!({"settings":c.saved.settings,"lastSweepAt":c.saved.last_sweep_at,"scanning":store().scanning.load(Ordering::Acquire),"items":items,"archives":c.saved.archives,"history":c.saved.history}),
    )
}
pub(crate) fn set(
    enabled: Option<bool>,
    build: Option<u32>,
    remove: Option<u32>,
) -> Result<Settings, String> {
    store().change(enabled == Some(false), |s| {
        let next = Settings {
            enabled: enabled.unwrap_or(s.settings.enabled),
            build_after_days: build.unwrap_or(s.settings.build_after_days),
            remove_after_days: remove.unwrap_or(s.settings.remove_after_days),
        };
        if next.build_after_days < 1
            || next.remove_after_days < 1
            || next.build_after_days > next.remove_after_days
        {
            return Err(
                "Use at least one day, with build cleanup no later than folder removal.".into(),
            );
        }
        s.settings = next.clone();
        Ok(next)
    })
}
pub(crate) fn keep(key: &str, keep: bool) -> Result<(), String> {
    store().change(keep, |s| {
        if keep {
            s.pins.insert(key.to_owned());
        } else {
            s.pins.remove(key);
        }
        Ok(())
    })
}

/// Pure decision: unsupported/unknown observations always hold removal.
struct Decision<'a> {
    active: Option<&'a str>,
    idle_ms: i64,
    dirty: bool,
    operation: bool,
    named: bool,
    held: bool,
    validation: bool,
    known: bool,
    windows: bool,
    reparse: bool,
    managed: bool,
    complete: bool,
}
fn decide(d: Decision<'_>, settings: &Settings) -> (&'static str, String) {
    if let Some(why) = d.active {
        return ("active", why.into());
    }
    if d.idle_ms < i64::from(settings.remove_after_days) * DAY {
        return (
            "idle",
            "No active use was found; the folder retention period has not elapsed.".into(),
        );
    }
    if d.dirty || d.operation || (!d.named && !d.held) {
        return ("abandoned", if d.operation { "A Git operation is in progress; archive and removal need the person's decision." } else if d.dirty { "Uncommitted or untracked files need the person's archive decision; ignored files are excluded." } else { "Detached commits have no retaining ref; archive and removal need the person's decision." }.into());
    }
    let why = if !d.managed {
        "Ownership is unknown; this checkout is never changed."
    } else if d.windows && d.reparse {
        "A reparse point is inside the checkout; Git removal could follow it, so the folder is kept."
    } else if d.windows || !d.known {
        "Open-file and cwd usage is unknown; this folder is kept."
    } else if !d.complete {
        "The tree could not be fully inspected; this folder is kept."
    } else if !d.named && !d.validation {
        "The checkout has no named branch; this folder is kept."
    } else if !d.held {
        "No kept branch holds HEAD; this folder is kept."
    } else {
        "The clean, inactive checkout is recoverable from its kept ref and qualifies for removal."
    };
    ("finished", why.into())
}
fn redirect(meta: &fs::Metadata) -> bool {
    if meta.file_type().is_symlink() {
        return true;
    }
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        return meta.file_attributes() & (0x400 | 0x1000 | 0x40000) != 0;
    }
    #[cfg(not(windows))]
    false
}
/// Validate every component, before canonicalization, so a redirected ancestor
/// cannot grant cleanup in another folder. Discovery returns absolute paths.
fn protected(root: &Path, profile: &Path, home: Option<&Path>) -> bool {
    if profile.starts_with(root) {
        return true;
    }
    home.is_some_and(|home| {
        [".codex", ".claude", ".gemini"].iter().any(|name| {
            let history = home.join(name);
            root.starts_with(&history) || history.starts_with(root)
        })
    })
}
fn require_unprotected(root: &Path) -> Result<(), String> {
    let profile = crate::profile::profile_dir();
    let profile = crate::paths::canonical_target(&profile).unwrap_or(profile);
    let home =
        crate::paths::home_dir().map(|home| crate::paths::canonical_target(&home).unwrap_or(home));
    if protected(root, &profile, home.as_deref()) {
        return Err(
            "This path contains host state or agent history; worktree lifespan never changes it."
                .into(),
        );
    }
    Ok(())
}
fn real_dir(path: &Path) -> Result<(), String> {
    let mut p = PathBuf::new();
    for part in path.components() {
        if matches!(part, std::path::Component::ParentDir) {
            return Err("A parent path component is not safe for cleanup.".into());
        }
        p.push(part);
        if matches!(part, std::path::Component::Prefix(_)) {
            continue;
        }
        let m = fs::symlink_metadata(&p).map_err(|e| e.to_string())?;
        if redirect(&m) || !m.is_dir() {
            return Err(format!(
                "{} is redirected or is not a real directory.",
                p.display()
            ));
        }
    }
    Ok(())
}
fn directory_handle(path: &Path) -> Result<fs::File, String> {
    real_dir(path)?;
    let mut options = fs::OpenOptions::new();
    options.read(true);
    #[cfg(windows)]
    {
        use std::os::windows::fs::OpenOptionsExt;
        options.write(true).custom_flags(0x02200000);
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.custom_flags(libc::O_DIRECTORY | libc::O_NOFOLLOW | libc::O_NONBLOCK);
    }
    let file = options.open(path).map_err(|e| e.to_string())?;
    let m = file.metadata().map_err(|e| e.to_string())?;
    if !m.is_dir() || redirect(&m) {
        return Err("Directory handle changed type or is redirected".into());
    }
    Ok(file)
}
#[derive(Default)]
struct Tree {
    bytes: u64,
    newest: i64,
    build_bytes: u64,
    builds: Vec<PathBuf>,
    reparse: bool,
    entries: usize,
    started: Option<std::time::Instant>,
}
fn stamp(meta: &fs::Metadata) -> i64 {
    meta.modified()
        .ok()
        .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}
fn build_dir(root: &str, p: &Path) -> bool {
    let marker = match p.file_name().and_then(|n| n.to_str()) {
        Some("target") => "Cargo.toml",
        Some("node_modules") => "package.json",
        _ => return false,
    };
    let Some(parent) = p.parent() else {
        return false;
    };
    let Ok(m) = fs::symlink_metadata(parent.join(marker)) else {
        return false;
    };
    if !m.is_file() || redirect(&m) {
        return false;
    }
    let Ok(relative) = p.strip_prefix(root) else {
        return false;
    };
    let relative = format!("{}/", relative.to_string_lossy().replace('\\', "/"));
    if !fs::symlink_metadata(p).is_ok_and(|m| m.is_dir() && !redirect(&m)) {
        return false;
    }
    git::git(root, &["check-ignore", "--quiet", "--", &relative]).is_ok()
        && git::git(root, &["ls-files", "-z", "--", &relative]).is_ok_and(|b| b.is_empty())
}
fn walk(root: &str, path: &Path, in_build: bool, tree: &mut Tree) -> Result<(), String> {
    tree.entries += 1;
    let started = *tree.started.get_or_insert_with(std::time::Instant::now);
    if tree.entries > 100_000 || started.elapsed() > Duration::from_secs(15) {
        return Err(
            "Worktree walk reached its 100,000 entry or 15 second limit; this worktree is kept."
                .into(),
        );
    }
    let m = fs::symlink_metadata(path).map_err(|e| e.to_string())?;
    if redirect(&m) {
        tree.reparse = true;
        tree.bytes = tree.bytes.saturating_add(m.len());
        if !in_build {
            tree.newest = tree.newest.max(stamp(&m));
        }
        return Ok(());
    }
    if path != Path::new(root) && ignored::repository_entry(path, path, &m) {
        // Repository metadata is opaque here as well as in ignored inventory.
        // Only the shared inventory predicate decides whether it is at stake.
        tree.bytes = tree.bytes.saturating_add(m.len());
        if !in_build {
            tree.newest = tree.newest.max(stamp(&m));
        }
        return Ok(());
    }
    if m.is_dir() {
        let is_build = !in_build && build_dir(root, path);
        let ignored = in_build || is_build;
        if is_build {
            tree.builds.push(path.to_owned());
        }
        if !ignored {
            tree.newest = tree.newest.max(stamp(&m));
        }
        for entry in fs::read_dir(path).map_err(|e| e.to_string())? {
            let entry = entry.map_err(|e| e.to_string())?;
            if path == Path::new(root) && entry.file_name() == ".git" {
                continue;
            }
            walk(root, &entry.path(), ignored, tree)?;
        }
    } else if m.is_file() {
        tree.bytes = tree.bytes.saturating_add(m.len());
        if in_build {
            tree.build_bytes = tree.build_bytes.saturating_add(m.len());
        } else {
            tree.newest = tree.newest.max(stamp(&m));
        }
    }
    Ok(())
}
#[derive(Default)]
struct Usage {
    known: bool,
    paths: Vec<PathBuf>,
}
impl Usage {
    fn capture(windows: bool) -> Self {
        if windows {
            return Self::default();
        }
        let mut cmd = Command::new("lsof");
        cmd.args(["-nP", "-F0n"]);
        let Ok(bytes) = git::command(&mut cmd, Duration::from_secs(12)) else {
            return Self::default();
        };
        let paths: Vec<_> = bytes
            .split(|b| *b == 0 || *b == b'\n')
            .filter_map(|p| p.strip_prefix(b"n"))
            .filter_map(|p| std::str::from_utf8(p).ok())
            .filter(|p| p.starts_with('/'))
            .map(PathBuf::from)
            .collect();
        Self {
            known: !paths.is_empty(),
            paths,
        }
    }
    fn using(&self, path: &str) -> bool {
        self.paths.iter().any(|p| p.starts_with(path))
    }
}
fn building() -> bool {
    let mut cmd = if cfg!(windows) {
        let mut c = Command::new("tasklist");
        c.args(["/FO", "CSV", "/NH"]);
        c
    } else {
        let mut c = Command::new("ps");
        c.args(["-A", "-o", "comm="]);
        c
    };
    git::command(&mut cmd, Duration::from_secs(5))
        .map(|b| {
            String::from_utf8_lossy(&b).lines().any(|l| {
                let l = l.trim().trim_matches('"');
                let name = l
                    .split('"')
                    .next()
                    .unwrap_or(l)
                    .rsplit(['/', '\\'])
                    .next()
                    .unwrap_or(l);
                matches!(name, "cargo" | "rustc" | "cargo.exe" | "rustc.exe")
            })
        })
        .unwrap_or(true)
}
fn key(repo: &str, path: &str) -> String {
    format!("{repo}:{path}")
}
fn status_hash(
    path: &str,
    status: &[u8],
    ignored: Option<&ignored::Inventory>,
) -> Result<String, String> {
    // Include index/worktree content and untracked content, so editing a dirty
    // file without changing its porcelain row invalidates the person's preview.
    use sha2::{Digest, Sha256};
    let started = std::time::Instant::now();
    const MAX_BYTES: u64 = 2 * 1024 * 1024 * 1024;
    let mut read_bytes = 0u64;
    let mut h = Sha256::new();
    h.update(status);
    h.update(ignored.map_or("ignored inventory unavailable", |i| i.hash.as_str()));
    let diff = git::git_bounded(
        path,
        &[
            "diff",
            "--no-ext-diff",
            "--no-textconv",
            "--raw",
            "--no-abbrev",
            "HEAD",
            "--",
        ],
        Duration::from_secs(120).saturating_sub(started.elapsed()),
    )?;
    read_bytes += diff.len() as u64;
    if read_bytes > MAX_BYTES || started.elapsed() > Duration::from_secs(120) {
        return Err(
            "Status content check reached its 2 GiB or 120 second limit; this worktree is kept."
                .into(),
        );
    }
    h.update(diff);
    let diff = git::git_bounded(
        path,
        &[
            "diff",
            "--cached",
            "--no-ext-diff",
            "--no-textconv",
            "--raw",
            "--no-abbrev",
            "HEAD",
            "--",
        ],
        Duration::from_secs(120).saturating_sub(started.elapsed()),
    )?;
    read_bytes += diff.len() as u64;
    if read_bytes > MAX_BYTES || started.elapsed() > Duration::from_secs(120) {
        return Err(
            "Status content check reached its 2 GiB or 120 second limit; this worktree is kept."
                .into(),
        );
    }
    h.update(diff);
    let files = git::git_bounded(
        path,
        &[
            "ls-files",
            "--cached",
            "--others",
            "--exclude-standard",
            "-z",
        ],
        Duration::from_secs(120).saturating_sub(started.elapsed()),
    )?;
    for file in files.split(|b| *b == 0).filter(|b| !b.is_empty()) {
        if started.elapsed() > Duration::from_secs(120) {
            return Err(
                "Status content check reached its 120 second limit; this worktree is kept.".into(),
            );
        }
        let relative = std::str::from_utf8(file).map_err(|e| e.to_string())?;
        h.update(file);
        let p = Path::new(path).join(relative);
        let m = match fs::symlink_metadata(&p) {
            Ok(m) => m,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
                h.update(b"missing");
                continue;
            }
            Err(e) => return Err(e.to_string()),
        };
        if redirect(&m) {
            h.update(
                fs::read_link(&p)
                    .map_err(|e| e.to_string())?
                    .to_string_lossy()
                    .as_bytes(),
            );
        } else if m.is_file() {
            if read_bytes.saturating_add(m.len()) > MAX_BYTES {
                return Err(
                    "Status content check reached its 2 GiB total limit; this worktree is kept."
                        .into(),
                );
            }
            use std::io::Read;
            let mut f = raw::open_regular(&p)?;
            let mut buf = [0u8; 65536];
            loop {
                if started.elapsed() > Duration::from_secs(120) {
                    return Err(
                        "Status content check reached its 120 second limit; this worktree is kept."
                            .into(),
                    );
                }
                let n = f.read(&mut buf).map_err(|e| e.to_string())?;
                if n == 0 {
                    break;
                }
                read_bytes = read_bytes.saturating_add(n as u64);
                if read_bytes > MAX_BYTES {
                    return Err("Status content check reached its 2 GiB total limit; this worktree is kept.".into());
                }
                h.update(&buf[..n]);
            }
        } else if !m.is_dir() {
            return Err("A tracked/untracked path is a special file; content verification is incomplete and the folder is kept.".into());
        }
    }
    Ok(format!("{:x}", h.finalize()))
}
#[derive(Clone)]
struct Checkout {
    path: String,
    branch: Option<String>,
    head: String,
    primary: bool,
}
fn checkouts(repo: &str) -> Result<Vec<Checkout>, String> {
    let bytes = git::git(repo, &["worktree", "list", "--porcelain", "-z"])?;
    let mut found = Vec::new();
    let mut current: Option<Checkout> = None;
    for field in bytes.split(|b| *b == 0) {
        let field = std::str::from_utf8(field).map_err(|e| e.to_string())?;
        if let Some(p) = field.strip_prefix("worktree ") {
            if let Some(c) = current.take() {
                found.push(c);
            }
            current = Some(Checkout {
                path: crate::paths::canonicalize(p)
                    .unwrap_or_else(|_| crate::paths::simplified(Path::new(p)))
                    .to_string_lossy()
                    .into_owned(),
                branch: None,
                head: String::new(),
                primary: found.is_empty(),
            });
        } else if let Some(c) = &mut current {
            if let Some(h) = field.strip_prefix("HEAD ") {
                c.head = h.into();
            }
            if let Some(b) = field.strip_prefix("branch refs/heads/") {
                c.branch = Some(b.into());
            }
        }
    }
    if let Some(c) = current {
        found.push(c);
    }
    Ok(found)
}
fn project_repos(svc: &Services, allocations: &[Allocation]) -> Result<BTreeSet<String>, String> {
    let mut repos: BTreeSet<String> = allocations
        .iter()
        .map(|a| a.repo.clone())
        .filter(|p| !p.is_empty())
        .collect();
    let projects = crate::workspaces::list_workspaces_impl(&svc.workspaces)?;
    for project in projects {
        for root in std::iter::once(project.primary_path).chain(project.paths) {
            if root.trim().is_empty() {
                continue;
            }
            let mut pending = vec![(PathBuf::from(root), 0)];
            while let Some((p, depth)) = pending.pop() {
                let Ok(m) = fs::symlink_metadata(&p) else {
                    continue;
                };
                if !m.is_dir() || redirect(&m) {
                    continue;
                }
                if let Ok(primary) = git::text(
                    &p.to_string_lossy(),
                    &["rev-parse", "--path-format=absolute", "--git-common-dir"],
                ) {
                    if let Some(primary) = Path::new(&primary).parent() {
                        repos.insert(
                            crate::paths::canonicalize(primary)
                                .unwrap_or_else(|_| primary.to_path_buf())
                                .to_string_lossy()
                                .into_owned(),
                        );
                    }
                    continue;
                }
                if depth >= 2 {
                    continue;
                }
                if let Ok(entries) = fs::read_dir(&p) {
                    for entry in entries.flatten() {
                        let name = entry.file_name();
                        let name = name.to_string_lossy();
                        if name.starts_with('.')
                            || matches!(
                                name.as_ref(),
                                "target" | "node_modules" | "renders" | "source"
                            )
                        {
                            continue;
                        }
                        if entry
                            .file_type()
                            .is_ok_and(|t| t.is_dir() && !t.is_symlink())
                        {
                            pending.push((entry.path(), depth + 1));
                        }
                    }
                }
            }
        }
    }
    Ok(repos)
}
fn chats_in(path: &str) -> Vec<crate::chat_index::ChatMeta> {
    crate::chat_index::list()
        .into_iter()
        .chain(crate::chat_index::deleted())
        .filter(|c| {
            c.cwd
                .as_ref()
                .is_some_and(|p| Path::new(p).starts_with(path))
        })
        .collect()
}
fn allocation_for(checkout: &Checkout, repo: &str, allocations: &[Allocation]) -> Allocation {
    let mut owned: Vec<_> = allocations
        .iter()
        .filter(|a| a.path == checkout.path)
        .cloned()
        .collect();
    let mut a = owned.pop().unwrap_or_else(|| Allocation {
        path: checkout.path.clone(),
        repo: repo.into(),
        branch: checkout.branch.clone(),
        base: String::new(),
        last_activity: 0,
        active: None,
        chats: Vec::new(),
        owner: Owner::unknown(),
        swept_at: None,
        reconcilable: false,
    });
    for other in owned {
        a.last_activity = a.last_activity.max(other.last_activity);
        a.active = a.active.or(other.active);
        a.chats.extend(other.chats);
        if other.owner.kind == "unknown" {
            a.owner = other.owner;
        }
    }
    let chats = chats_in(&checkout.path);
    for chat in &chats {
        a.last_activity = a.last_activity.max(chat.updated_at);
        a.chats.push(format!("chat:{}", chat.id));
    }
    if a.owner.kind == "unknown"
        && !allocations.iter().any(|a| a.path == checkout.path)
        && !checkout.primary
        && checkout
            .branch
            .as_deref()
            .is_some_and(|b| b.starts_with("octiq/"))
        && Path::new(&checkout.path)
            .components()
            .any(|c| c.as_os_str() == ".worktrees")
    {
        if let Some(chat) = chats.first() {
            a.owner = Owner {
                kind: "chat".into(),
                label: chat.title.clone(),
                chat_key: Some(format!("chat:{}", chat.id)),
                run_id: None,
                task_id: None,
            };
            a.base = chat
                .launch
                .as_ref()
                .map(|p| p.base_branch.clone())
                .unwrap_or_default();
        }
    }
    if checkout.primary {
        a.owner = Owner::unknown();
    }
    if a.owner.kind != "unknown" && a.branch != checkout.branch {
        a.active =
            Some("The branch differs from its host allocation; the checkout is kept.".into());
    }
    a.chats.sort();
    a.chats.dedup();
    a
}
struct Observation {
    item: Item,
    tree: Tree,
    removable: bool,
    ignored_hash: Option<String>,
}
fn observe(
    a: &Allocation,
    checkout: &Checkout,
    settings: &Settings,
    pins: &BTreeSet<String>,
    usage: &Usage,
    chats: &crate::agent_chat::ChatManager,
    at: i64,
    windows: bool,
    inventory: fn(&str) -> Result<ignored::Inventory, String>,
) -> Result<Observation, String> {
    require_unprotected(Path::new(&checkout.path))?;
    real_dir(Path::new(&checkout.path))?;
    let root = &checkout.path;
    let ignored = inventory(root);
    let head = git::text(root, &["rev-parse", "HEAD"])?;
    let status = git::git(
        root,
        &[
            "status",
            "--porcelain=v1",
            "-z",
            "--untracked-files=all",
            "--ignore-submodules=none",
        ],
    )?;
    let mut dirty_files = 0;
    let mut untracked_files = 0;
    let mut rows = status.split(|b| *b == 0).filter(|r| !r.is_empty());
    while let Some(row) = rows.next() {
        if row.starts_with(b"??") {
            untracked_files += 1;
        } else {
            dirty_files += 1;
        }
        if row
            .get(..2)
            .is_some_and(|xy| xy.iter().any(|b| matches!(b, b'R' | b'C')))
        {
            rows.next();
        }
    }
    let git_dir = git::text(root, &["rev-parse", "--absolute-git-dir"])?;
    let operation = [
        "MERGE_HEAD",
        "CHERRY_PICK_HEAD",
        "REVERT_HEAD",
        "rebase-merge",
        "rebase-apply",
        "sequencer",
    ]
    .iter()
    .any(
        |name| match fs::symlink_metadata(Path::new(&git_dir).join(name)) {
            Ok(_) => true,
            Err(e) => e.kind() != std::io::ErrorKind::NotFound,
        },
    );
    let mut tree = Tree::default();
    walk(root, Path::new(root), false, &mut tree)?;
    let last_commit = git::text(root, &["show", "-s", "--format=%ct", "HEAD"])?
        .parse::<i64>()
        .map_err(|e| e.to_string())?
        .saturating_mul(1000);
    let last = tree.newest.max(last_commit).max(a.last_activity).min(at);
    let idle_ms = at.saturating_sub(last);
    let mut active = a.active.clone();
    if usage.using(root) {
        active = Some("An observed process cwd or open file is inside this checkout.".into());
    }
    if let Err(e) = chats.require_checkout_idle(root, true) {
        active = Some(e);
    }
    if a.chats
        .iter()
        .chain(chats.lifespan_chat_keys(root)?.iter())
        .any(|k| chats.has_queued_turns(k))
    {
        active = Some("A queued turn still needs this checkout.".into());
    }
    let named = checkout.branch.is_some();
    let held = if let Some(branch) = &checkout.branch {
        git::text(
            root,
            &[
                "rev-parse",
                "--verify",
                &format!("refs/heads/{branch}^{{commit}}"),
            ],
        )
        .is_ok_and(|s| s == head)
    } else {
        git::text(
            root,
            &[
                "for-each-ref",
                "--format=%(refname)",
                "--contains",
                &head,
                "refs/heads",
                "refs/remotes",
                "refs/octiq/archive",
            ],
        )
        .is_ok_and(|s| !s.is_empty())
    };
    let base = if a.base.is_empty() {
        git::text(
            root,
            &["symbolic-ref", "--quiet", "refs/remotes/origin/HEAD"],
        )
        .ok()
        .or_else(|| {
            ["develop", "main", "master"]
                .into_iter()
                .find(|b| git::git(root, &["rev-parse", "--verify", b]).is_ok())
                .map(str::to_owned)
        })
    } else {
        Some(a.base.clone())
    };
    let unmerged_commits = base.as_ref().and_then(|base| {
        git::text(root, &["rev-list", "--count", &format!("{base}..{head}")])
            .ok()?
            .parse::<u64>()
            .ok()
    });
    let pushed = checkout.branch.as_ref().and_then(|b| {
        let remote = git::text(root, &["rev-parse", "--symbolic-full-name", "@{upstream}"])
            .ok()
            .or_else(|| {
                let r = format!("refs/remotes/origin/{b}");
                git::git(root, &["rev-parse", "--verify", &r])
                    .ok()
                    .map(|_| r)
            })?;
        if !remote.starts_with("refs/remotes/") {
            return None;
        }
        git::git(root, &["rev-parse", "--verify", &remote]).ok()?;
        Some(git::git(root, &["merge-base", "--is-ancestor", &head, &remote]).is_ok())
    });
    let (mut state, mut why) = decide(
        Decision {
            active: active.as_deref(),
            idle_ms,
            dirty: !status.is_empty(),
            operation,
            named,
            held,
            validation: a.owner.kind == "validation",
            known: usage.known,
            windows,
            reparse: tree.reparse,
            managed: a.owner.kind != "unknown",
            complete: true,
        },
        settings,
    );
    // Git's clean status (and non-force remove) permits deleting ignored
    // files. Unknown inventories must hold removal just like known originals.
    if active.is_none() {
        match &ignored {
            Ok(i) if i.files > 0 => {
                state = "abandoned";
                why = format!("{} at-stake ignored files need the person's decision; archive-and-remove deletes them without archiving them.", i.files);
            }
            Err(e) => {
                state = "abandoned";
                why = format!("Ignored-file inventory is unavailable: {e} No folder removal or archive is allowed.");
            }
            _ => {}
        }
    }
    let raw_proof = raw::observe_hidden(root, &head, windows);
    match &raw_proof {
        Ok(p) if p.unrestorable > 0 && active.is_none() => {
            state = "abandoned";
            dirty_files += p.hidden;
            why = p.reason();
        }
        Err(e) if active.is_none() => {
            why = format!("Raw Restore verification is unknown: {e}");
        }
        _ => {}
    }
    let status_hash = status_hash(root, &status, ignored.as_ref().ok());
    if let Err(error) = &status_hash {
        if active.is_none() {
            state = "abandoned";
        }
        why = format!("{error} Content verification is incomplete; automatic cleanup and archive are withheld.");
    }
    let key = key(&a.repo, root);
    let pinned = pins.contains(&key);
    let removable = raw_proof.as_ref().is_ok_and(|p| p.unrestorable == 0)
        && status_hash.is_ok()
        && state == "finished"
        && a.owner.kind != "unknown"
        && usage.known
        && !windows
        && (!windows || !tree.reparse)
        && held
        && (named || a.owner.kind == "validation");
    if pinned {
        why = "The person pinned this worktree; it is never stripped or removed.".into();
    }
    let qualified = a.owner.kind != "unknown"
        && !pinned
        && active.is_none()
        && usage.known
        && !windows
        && status_hash.is_ok();
    let item = Item {
        key,
        path: root.clone(),
        repo: a.repo.clone(),
        branch: checkout.branch.clone(),
        head,
        status_hash: status_hash.unwrap_or_default(),
        owner: a.owner.clone(),
        state: state.into(),
        pinned,
        idle_days: idle_ms as f64 / DAY as f64,
        bytes: Some(tree.bytes),
        build_bytes: Some(tree.build_bytes),
        dirty_files,
        untracked_files,
        ignored_files: ignored.as_ref().ok().map(|i| i.files),
        ignored_bytes: ignored.as_ref().ok().map(|i| i.bytes),
        unmerged_commits,
        pushed,
        strip_at: qualified.then_some(last + i64::from(settings.build_after_days) * DAY),
        remove_at: (qualified && state == "finished" && removable)
            .then_some(last + i64::from(settings.remove_after_days) * DAY),
        why,
    };
    Ok(Observation {
        item,
        tree,
        removable,
        ignored_hash: ignored.ok().map(|i| i.hash),
    })
}
fn current(svc: &Services, state: &Store, path: &str) -> Result<(Allocation, Checkout), String> {
    let allocations = svc.orchestrations.lifespan_allocations()?;
    let repo = allocations
        .iter()
        .find(|a| a.path == path)
        .map(|a| a.repo.clone())
        .or_else(|| {
            state
                .inner
                .lock()
                .ok()?
                .items
                .iter()
                .find(|i| i.path == path)
                .map(|i| i.repo.clone())
        })
        .ok_or("This worktree is no longer known to the host.")?;
    let checkout = checkouts(&repo)?
        .into_iter()
        .find(|c| c.path == path)
        .ok_or("Git no longer records this checkout.")?;
    let a = allocation_for(&checkout, &repo, &allocations);
    Ok((a, checkout))
}
fn verify_delivery(svc: &Services, a: &Allocation, item: &Item) -> Result<(), String> {
    for chat in chats_in(&item.path) {
        crate::chat_task::verify_before_sweep(&chat.id, &item.head)?;
    }
    if a.owner.kind == "task" || a.owner.kind == "mission" {
        let evidence = DeliveryEvidence {
            head_sha: item.head.clone(),
            dirty: item.dirty_files + item.untracked_files > 0,
            has_commits: item.unmerged_commits.is_some_and(|n| n > 0),
            pushed: item.pushed == Some(true),
            merged: item.unmerged_commits == Some(0),
            checked_at: now(),
            ..Default::default()
        };
        svc.orchestrations
            .lifespan_delivery(&item.path, &evidence)?;
    }
    Ok(())
}
fn history(s: &mut Saved, sweep: Sweep) {
    s.last_sweep_at = Some(sweep.at);
    s.history.insert(0, sweep);
    s.history.truncate(50);
}
fn record_intent(
    store: &Store,
    item: &Item,
    archive_key: Option<String>,
    at: i64,
) -> Result<(), String> {
    store.change(false, |s| {
        if s.pins.contains(&item.key) || !s.settings.enabled && archive_key.is_none() {
            return Err("The worktree was pinned or automatic cleanup was disabled.".into());
        }
        s.intents.retain(|i| i.item.path != item.path);
        s.intents.push(Intent {
            repo: item.repo.clone(),
            item: Removed {
                path: item.path.clone(),
                branch: item.branch.clone(),
                owner: item.owner.clone(),
                bytes: item.bytes,
            },
            at,
            archive_key,
        });
        Ok(())
    })
}
fn gone(path: &str) -> bool {
    matches!(fs::symlink_metadata(path),Err(e) if e.kind()==std::io::ErrorKind::NotFound)
}
fn parents_present(repo: &str, path: &str, validation: bool) -> bool {
    if real_dir(Path::new(repo)).is_err() {
        return false;
    }
    if validation {
        return Path::new(path)
            .parent()
            .is_some_and(|p| real_dir(p).is_ok());
    }
    // Require the original .worktrees/<repo> container, rather than making it
    // on a missing volume. There is deliberately no global Git prune here.
    Path::new(path).ancestors().any(|p| {
        p.parent()
            .and_then(|p| p.file_name())
            .is_some_and(|n| n == ".worktrees")
            && real_dir(p).is_ok()
    })
}
struct LifecycleGuard<'a> {
    _guard: std::sync::MutexGuard<'a, ()>,
    #[cfg(test)]
    started: std::time::Instant,
    _budget: git::FinalBudget,
}
#[cfg(test)]
thread_local! {
    static LOCK_MAX: std::cell::Cell<Duration> = const { std::cell::Cell::new(Duration::ZERO) };
}
#[cfg(test)]
impl Drop for LifecycleGuard<'_> {
    fn drop(&mut self) {
        LOCK_MAX.with(|max| max.set(max.get().max(self.started.elapsed())));
    }
}
fn hold_lifecycle(svc: &Services) -> Result<LifecycleGuard<'_>, String> {
    Ok(LifecycleGuard {
        _guard: svc.orchestrations.hold_workspace_lifecycle()?,
        _budget: git::FinalBudget::start(),
        #[cfg(test)]
        started: std::time::Instant::now(),
    })
}
fn reconcile(svc: &Services, store: &Store, at: i64, sweep: &mut Sweep) -> Result<(), String> {
    for a in svc.orchestrations.lifespan_allocations()? {
        let _lifecycle = hold_lifecycle(svc)?;
        if a.owner.kind == "unknown"
            || a.swept_at.is_some()
            || !a.reconcilable
            || !gone(&a.path)
            || !parents_present(&a.repo, &a.path, a.owner.kind == "validation")
        {
            continue;
        }
        svc.orchestrations.lifespan_record_swept(&a.path, at)?;
        // Reconciliation changes the ledger, not the filesystem. Do not
        // report a manually missing folder as a host deletion.
    }
    // A restart may have happened on either side of git worktree remove.
    // Existing folders are re-verified by a later sweep, never blindly replayed.
    for intent in store.saved()?.intents {
        let _lifecycle = hold_lifecycle(svc)?;
        let repo = Some(intent.repo.clone());
        if !gone(&intent.item.path)
            || !repo.is_some_and(|r| {
                parents_present(
                    &r,
                    &intent.item.path,
                    intent.item.owner.kind == "validation",
                )
            })
        {
            continue;
        }
        svc.orchestrations
            .lifespan_record_swept(&intent.item.path, at)?;
        if !sweep.removed.iter().any(|r| r.path == intent.item.path) {
            sweep.freed_bytes = sweep
                .freed_bytes
                .saturating_add(intent.item.bytes.unwrap_or(0));
            sweep.removed.push(intent.item.clone());
        }
        // Keep the intent until the same save that records the sweep's
        // outcome. A crash before that save must be able to report it again.
    }
    Ok(())
}
struct Checks {
    windows: bool,
    usage: fn() -> Usage,
    building: fn() -> bool,
    inventory: fn(&str) -> Result<ignored::Inventory, String>,
}
fn runtime_usage() -> Usage {
    Usage::capture(cfg!(windows))
}
fn runtime_checks() -> Checks {
    Checks {
        windows: cfg!(windows),
        usage: runtime_usage,
        building,
        inventory: ignored::inventory,
    }
}
// Heavy disk/usage checks run with only the path/start marks. Once the
// lifecycle is reacquired, a newly admitted worker/owner must withhold cleanup.
fn final_allocation(svc: &Services, before: &Allocation) -> Result<(), String> {
    for a in svc.orchestrations.lifespan_allocations()? {
        if Path::new(&a.path).starts_with(&before.path)
            || Path::new(&before.path).starts_with(&a.path)
        {
            if a.active.is_some() || a.repo != before.repo || a.last_activity > before.last_activity
            {
                return Err(
                    "Workspace ownership or activity changed during cleanup; the folder was kept."
                        .into(),
                );
            }
        }
    }
    Ok(())
}
fn final_budget(start: std::time::Instant) -> Result<Duration, String> {
    let remaining = Duration::from_secs(10).saturating_sub(start.elapsed());
    if remaining.is_zero() {
        return Err("Final cleanup checks reached their 10 second bound; folder kept.".into());
    }
    Ok(remaining)
}
fn final_ready(
    svc: &Services,
    state: &Store,
    a: &Allocation,
    preview: &Item,
    usage: &Usage,
) -> Result<(), String> {
    final_allocation(svc, a)?;
    if !state.allowed(&preview.key)? {
        return Err("Cleanup is disabled or the checkout is pinned; the folder is kept.".into());
    }
    crate::profile::available()?;
    require_unprotected(Path::new(&preview.path))?;
    real_dir(Path::new(&preview.path))?;
    if !usage.known || usage.using(&preview.path) {
        return Err("Usage is unknown or the checkout is in use; folder kept.".into());
    }
    svc.chats.require_lifespan_idle(&preview.path)?;
    if git::text(&preview.path, &["rev-parse", "HEAD"])? != preview.head {
        return Err("HEAD changed; folder kept.".into());
    }
    Ok(())
}
#[derive(Default)]
struct StripProgress {
    count: usize,
    bytes: u64,
}
#[cfg(test)]
fn operate(
    svc: &Services,
    store: &Store,
    preview: &Item,
    at: i64,
    strip: bool,
    checks: &Checks,
) -> Result<Option<Observation>, String> {
    operate_progress(
        svc,
        store,
        preview,
        at,
        strip,
        checks,
        &mut StripProgress::default(),
    )
}
fn operate_progress(
    svc: &Services,
    store: &Store,
    preview: &Item,
    at: i64,
    strip: bool,
    checks: &Checks,
    progress: &mut StripProgress,
) -> Result<Option<Observation>, String> {
    let _lifecycle = hold_lifecycle(svc)?;
    let _marked = svc.chats.hold_lifespan_checkout(&preview.path)?;
    drop(_lifecycle);
    let (mut a, c) = current(svc, store, &preview.path)?;
    a.chats.extend(svc.chats.lifespan_chat_keys(&preview.path)?);
    a.chats.sort();
    a.chats.dedup();
    let claims = a
        .chats
        .iter()
        .map(|key| svc.chats.claim_start(key))
        .collect::<Result<Vec<_>, _>>()?;
    let settings = store.saved()?;
    let usage = (checks.usage)();
    let mut observed = observe(
        &a,
        &c,
        &settings.settings,
        &settings.pins,
        &usage,
        &svc.chats,
        at,
        checks.windows,
        checks.inventory,
    )?;
    apply_raw_failure(store, &mut observed)?;
    if observed.item.status_hash.is_empty() {
        return Err(observed.item.why.clone());
    }
    if observed.item.state == "active"
        || observed.item.pinned
        || a.owner.kind == "unknown"
        || !store.allowed(&preview.key)?
    {
        return Ok(None);
    }
    if strip {
        if !usage.known
            || checks.windows
            || observed.item.idle_days < f64::from(settings.settings.build_after_days)
            || (checks.building)()
        {
            return Ok(None);
        }
        // Refuse the whole strip before deleting any candidate when any
        // build subtree contains originals. Recheck each at its final door.
        for build in &observed.tree.builds {
            let relative = build
                .strip_prefix(&preview.path)
                .map_err(|e| e.to_string())?;
            let inventory =
                ignored::subtree(&preview.path, relative, Duration::from_secs(15), 100_000)?;
            if inventory.files > 0 {
                return Err(format!(
                    "{} at-stake ignored files in a build folder; all build folders were kept.",
                    inventory.files
                ));
            }
        }
        for build in &observed.tree.builds {
            require_unprotected(build)?;
            real_dir(build)?;
            if !build_dir(&preview.path, build) {
                return Err("Build folder no longer qualifies; it was kept.".into());
            }
            let mut deleted = Tree::default();
            walk(&preview.path, build, true, &mut deleted)?;
            let usage = (checks.usage)();
            let _lifecycle = hold_lifecycle(svc)?;
            let final_started = std::time::Instant::now();
            final_ready(svc, store, &a, preview, &usage)?;
            require_unprotected(build)?;
            real_dir(build)?;
            if !build_dir(&preview.path, build) {
                return Err("Build folder no longer qualifies; it was kept.".into());
            }
            let mut c = store.inner.lock().map_err(|e| e.to_string())?;
            store.load(&mut c)?;
            if !c.saved.settings.enabled || c.saved.pins.contains(&preview.key) {
                return Ok(None);
            }
            crate::profile::available()?;
            let relative = build
                .strip_prefix(&preview.path)
                .map_err(|e| e.to_string())?;
            let inventory = ignored::subtree(
                &preview.path,
                relative,
                final_budget(final_started)?,
                100_000,
            )?;
            if inventory.files > 0 {
                return Err(format!(
                    "{} at-stake ignored files in this build folder; it was kept.",
                    inventory.files
                ));
            }
            let parent = build.parent().ok_or("Build folder has no parent")?;
            let modified = fs::metadata(parent)
                .and_then(|m| m.modified())
                .map_err(|e| e.to_string())?;
            let parent_handle = directory_handle(parent)?;
            crate::profile::available()?;
            final_budget(final_started)?;
            fs::remove_dir_all(build).map_err(|e| e.to_string())?;
            progress.count += 1;
            progress.bytes = progress.bytes.saturating_add(deleted.bytes);
            parent_handle
                .set_times(fs::FileTimes::new().set_modified(modified))
                .map_err(|e| e.to_string())?;
        }
    } else {
        if !observed.removable {
            return Ok(None);
        }
        verify_delivery(svc, &a, &observed.item)?;
        record_intent(store, &observed.item, None, at)?;
        let stamps = raw::Stamps::capture(&preview.path)?;
        let proof = raw::verify(&preview.path, &observed.item.head, false, checks.windows);
        match proof {
            Ok(proof) if proof.unrestorable > 0 => {
                let why = proof.reason();
                remember_raw_failure(store, &observed, stamps, why.clone(), true)?;
                return Err(why);
            }
            Err(why) => {
                remember_raw_failure(store, &observed, stamps, why.clone(), false)?;
                return Err(why);
            }
            _ => {}
        }
        let check = observe(
            &a,
            &c,
            &settings.settings,
            &settings.pins,
            &(checks.usage)(),
            &svc.chats,
            now(),
            checks.windows,
            checks.inventory,
        )?;
        if !check.removable
            || check.item.head != observed.item.head
            || check.item.status_hash != observed.item.status_hash
        {
            return Err("The checkout changed before removal; it was kept.".into());
        }
        let ignored = (checks.inventory)(&preview.path)?;
        if ignored.files > 0 {
            return Err(
                "New at-stake ignored files arrived before removal; the folder was kept.".into(),
            );
        }
        {
            let final_usage = (checks.usage)();
            let _lifecycle = hold_lifecycle(svc)?;
            final_ready(svc, store, &a, preview, &final_usage)?;
            let mut cache = store.inner.lock().map_err(|e| e.to_string())?;
            store.load(&mut cache)?;
            if !cache.saved.settings.enabled || cache.saved.pins.contains(&preview.key) {
                return Ok(None);
            }
            crate::profile::available()?;
            remove_proven(
                &preview.repo,
                &preview.path,
                &RemovalProof {
                    stamps,
                    head: observed.item.head.clone(),
                },
            )?;
        }
        let _lifecycle = hold_lifecycle(svc)?;
        svc.orchestrations
            .lifespan_record_swept(&preview.path, at)?;
    }
    drop(claims);
    Ok(Some(observed))
}
fn sweep(svc: &Services, store: &Store) -> Result<(), String> {
    sweep_checked(svc, store, &runtime_checks())
}
fn sweep_checked(svc: &Services, store: &Store, checks: &Checks) -> Result<(), String> {
    if store.scanning.swap(true, Ordering::AcqRel) {
        return Ok(());
    }
    struct Scanning<'a>(&'a AtomicBool);
    impl Drop for Scanning<'_> {
        fn drop(&mut self) {
            self.0.store(false, Ordering::Release);
        }
    }
    let _scanning = Scanning(&store.scanning);
    crate::profile::available()?;
    let saved = store.saved()?;
    if !saved.settings.enabled {
        return Ok(());
    }
    let at = now();
    let mut report = Sweep {
        at,
        ..Default::default()
    };
    let builds_running = (checks.building)();
    if saved.settings.enabled && !builds_running {
        reconcile(svc, store, at, &mut report)?;
    }
    let allocations = svc.orchestrations.lifespan_allocations()?;
    let usage = (checks.usage)();
    let mut items = Vec::new();
    let mut stripped_paths = std::collections::BTreeMap::<String, u64>::new();
    for repo in project_repos(svc, &allocations)? {
        let checkouts = match checkouts(&repo) {
            Ok(c) => c,
            Err(e) => {
                report.failed.push(Failed { path: repo, why: e });
                continue;
            }
        };
        for checkout in checkouts {
            if gone(&checkout.path) {
                continue;
            }
            let a = allocation_for(&checkout, &repo, &allocations);
            match observe(
                &a,
                &checkout,
                &saved.settings,
                &saved.pins,
                &usage,
                &svc.chats,
                at,
                checks.windows,
                checks.inventory,
            ) {
                Ok(mut o) => {
                    apply_raw_failure(store, &mut o)?;
                    items.push(o.item);
                }
                Err(e) => {
                    report.failed.push(Failed {
                        path: checkout.path,
                        why: e,
                    });
                }
            }
        }
    }
    // Make fresh identity available to manual commands without persisting any
    // derived states, usage observations or size estimates.
    store.inner.lock().map_err(|e| e.to_string())?.items = items.clone();
    if saved.settings.enabled && !builds_running {
        for item in &items {
            if item.owner.kind == "unknown" || item.pinned || item.state == "active" {
                continue;
            }
            let strip = item.build_bytes.is_some_and(|b| b > 0)
                && item.idle_days >= f64::from(saved.settings.build_after_days);
            if strip {
                let mut progress = StripProgress::default();
                match operate_progress(svc, store, item, at, true, checks, &mut progress) {
                    Ok(_) => {}
                    Err(why) => report.failed.push(Failed {
                        path: item.path.clone(),
                        why,
                    }),
                }
                if progress.count > 0 {
                    report.stripped += progress.count;
                    report.freed_bytes = report.freed_bytes.saturating_add(progress.bytes);
                    stripped_paths.insert(item.path.clone(), progress.bytes);
                }
            }
            if item.state == "finished" && item.remove_at.is_some_and(|t| t <= at) {
                match operate_progress(
                    svc,
                    store,
                    item,
                    at,
                    false,
                    checks,
                    &mut StripProgress::default(),
                ) {
                    Ok(Some(o)) => {
                        report.freed_bytes =
                            report.freed_bytes.saturating_add(o.item.bytes.unwrap_or(0));
                        report.removed.push(Removed {
                            path: item.path.clone(),
                            branch: item.branch.clone(),
                            owner: item.owner.clone(),
                            bytes: o.item.bytes,
                        });
                    }
                    Ok(None) => {}
                    Err(why) => report.failed.push(Failed {
                        path: item.path.clone(),
                        why,
                    }),
                }
            }
        }
    }
    let changed = report.stripped > 0 || !report.removed.is_empty();
    store.change(true, |s| {
        for r in &report.removed {
            s.intents.retain(|i| i.item.path != r.path);
        }
        history(s, report.clone());
        Ok(())
    })?;
    {
        let mut c = store.inner.lock().map_err(|e| e.to_string())?;
        c.items
            .retain(|i| !report.removed.iter().any(|r| r.path == i.path));
        for removed in &report.removed {
            c.raw_failures.remove(&removed.path);
        }
        for item in &mut c.items {
            if let Some(deleted) = stripped_paths.get(&item.path) {
                item.bytes = item.bytes.map(|all| all.saturating_sub(*deleted));
                item.build_bytes = item.build_bytes.map(|build| build.saturating_sub(*deleted));
            }
            if item.build_bytes.is_some_and(|b| b > 0) && !Path::new(&item.path).exists() {
                item.bytes = None;
                item.build_bytes = None;
            }
        }
    }
    if changed {
        publish_report(store, &report)?;
    }
    crate::bus::emit("worktree-lifespan-changed", &json!({}));
    Ok(())
}
#[cfg(not(test))]
pub(crate) fn start(svc: Services) {
    static STARTED: AtomicBool = AtomicBool::new(false);
    if STARTED.swap(true, Ordering::AcqRel) {
        return;
    }
    std::thread::spawn(move || {
        std::thread::sleep(Duration::from_secs(180));
        loop {
            if let Err(e) = sweep(&svc, store()) {
                eprintln!("worktree lifespan: {e}");
            }
            std::thread::sleep(Duration::from_secs(3600));
        }
    });
}
pub(crate) fn archive(
    svc: &Services,
    key: &str,
    expected_head: &str,
    expected_status_hash: &str,
) -> Result<Archive, String> {
    archive_checked(
        svc,
        store(),
        &runtime_checks(),
        key,
        expected_head,
        expected_status_hash,
    )
}
fn archive_checked(
    svc: &Services,
    state: &Store,
    checks: &Checks,
    key: &str,
    expected_head: &str,
    expected_status_hash: &str,
) -> Result<Archive, String> {
    let preview = state
        .inner
        .lock()
        .map_err(|e| e.to_string())?
        .items
        .iter()
        .find(|i| i.key == key)
        .cloned()
        .ok_or("This worktree is not in the current inventory; wait for its next scan.")?;
    let _lifecycle = hold_lifecycle(svc)?;
    let _marked = svc.chats.hold_lifespan_checkout(&preview.path)?;
    drop(_lifecycle);
    let (mut a, c) = current(svc, state, &preview.path)?;
    a.chats.extend(svc.chats.lifespan_chat_keys(&preview.path)?);
    a.chats.sort();
    a.chats.dedup();
    let _claims = a
        .chats
        .iter()
        .map(|key| svc.chats.claim_start(key))
        .collect::<Result<Vec<_>, _>>()?;
    let settings = state.saved()?;
    let usage = (checks.usage)();
    let mut o = observe(
        &a,
        &c,
        &settings.settings,
        &settings.pins,
        &usage,
        &svc.chats,
        now(),
        checks.windows,
        checks.inventory,
    )?;
    apply_raw_failure(state, &mut o)?;
    if o.item.status_hash.is_empty() {
        return Err(o.item.why.clone());
    }
    if o.item.ignored_files.is_none() {
        return Err("Ignored-file inventory is unavailable; archive and removal are refused. Wait for a complete scan.".into());
    }
    if o.item.head != expected_head {
        return Err(
            "HEAD changed since the preview. Review the worktree again before archiving.".into(),
        );
    }
    if o.item.status_hash != expected_status_hash {
        return Err("Files or staging changed since the preview. Review the worktree again before archiving.".into());
    }
    if o.item.state != "abandoned" || o.item.owner.kind == "unknown" {
        return Err("Only an abandoned, host-owned worktree can be archived and removed.".into());
    }
    if o.item.pinned {
        return Err("This worktree is pinned; unpin it before archiving and removing it.".into());
    }
    if !usage.known || checks.windows {
        return Err("Complete cwd/open-file usage is unavailable or a redirect is present; the folder is kept.".into());
    }
    verify_delivery(svc, &a, &o.item)?;
    let slug = uuid::Uuid::new_v4().simple().to_string();
    let reference = format!("refs/octiq/archive/{slug}");
    let index = crate::profile::profile_dir().join(format!(".archive-index-{slug}"));
    crate::profile::available()?;
    let (_, files) = git::archive(&preview.path, &o.item.head, &reference, &index)?;
    let archive = Archive {
        key: slug,
        reference,
        repo: preview.repo.clone(),
        branch: o.item.branch.clone(),
        path: preview.path.clone(),
        archived_at: now(),
        files,
        restored_at: None,
    };
    // Save the verified ref before removal, so a crash leaves a restorable
    // archive. Ignored output is deliberately not part of the archive.
    state.change(false, |s| {
        s.archives.push(archive.clone());
        Ok(())
    })?;
    record_intent(
        state,
        &o.item,
        Some(archive.key.clone()),
        archive.archived_at,
    )?;
    let final_usage = (checks.usage)();
    let check = observe(
        &a,
        &c,
        &settings.settings,
        &state.saved()?.pins,
        &final_usage,
        &svc.chats,
        now(),
        checks.windows,
        checks.inventory,
    )?;
    if check.item.ignored_files.is_none()
        || check.item.head != expected_head
        || check.item.status_hash != expected_status_hash
        || check.item.state != "abandoned"
        || check.item.pinned
        || !final_usage.known
        || checks.windows && check.tree.reparse
    {
        return Err("The checkout changed after archiving; the archive is kept and the folder was not removed.".into());
    }
    let ignored = (checks.inventory)(&preview.path).map_err(|e| {
        format!("Ignored-file inventory is unavailable; archive and folder are kept: {e}")
    })?;
    if Some(&ignored.hash) != check.ignored_hash.as_ref() {
        return Err(
            "Ignored files changed after the archive preview; the archive and folder are kept."
                .into(),
        );
    }
    // Snapshot immediately before both long comparisons. No final answer made
    // before releasing lifecycle is reused after these steps.
    let stamps = raw::Stamps::capture(&preview.path)?;
    let fresh_index =
        crate::profile::profile_dir().join(format!(".verify-archive-{}", uuid::Uuid::new_v4()));
    git::verify_archive_disk(&preview.path, &archive.reference, &fresh_index)?;
    let proof =
        raw::verify(&preview.path, &archive.reference, true, checks.windows).map_err(|e| {
            format!(
                "Raw Restore verification incomplete: {e}; archive ref {} and folder are kept.",
                archive.reference
            )
        })?;
    if proof.unrestorable > 0 {
        return Err(format!(
            "{} Archive ref {} and folder are kept.",
            proof.reason(),
            archive.reference
        ));
    }
    let final_usage = (checks.usage)();
    {
        let _lifecycle = hold_lifecycle(svc)?;
        let final_started = std::time::Instant::now();
        final_ready(svc, state, &a, &preview, &final_usage)?;
        let cache = state.inner.lock().map_err(|e| e.to_string())?;
        if !cache.saved.settings.enabled || cache.saved.pins.contains(key) {
            return Err(
                "Cleanup is disabled or the checkout was pinned; the archive and folder are kept."
                    .into(),
            );
        }
        let ignored = ignored::bounded(&preview.path, final_budget(final_started)?, 100_000)
            .map_err(|e| {
                format!("Ignored-file inventory unavailable; archive and folder kept: {e}")
            })?;
        if Some(&ignored.hash) != check.ignored_hash.as_ref() {
            return Err(
                "Ignored files changed after the archive preview; the archive and folder are kept."
                    .into(),
            );
        }
        stamps.verify(&preview.path)?;
        crate::profile::available()?;
        final_budget(final_started)?;
        git::remove(&preview.repo, &preview.path, true)?;
    }
    {
        let _lifecycle = hold_lifecycle(svc)?;
        svc.orchestrations
            .lifespan_record_swept(&preview.path, now())?;
    }
    let report = Sweep {
        at: now(),
        removed: vec![Removed {
            path: preview.path.clone(),
            branch: o.item.branch,
            owner: o.item.owner,
            bytes: o.item.bytes,
        }],
        freed_bytes: o.item.bytes.unwrap_or(0),
        ..Default::default()
    };
    state.change(true, |s| {
        s.intents.retain(|i| i.item.path != preview.path);
        history(s, report.clone());
        Ok(())
    })?;
    state
        .inner
        .lock()
        .map_err(|e| e.to_string())?
        .items
        .retain(|i| i.key != key);
    publish_report(state, &report)?;
    Ok(archive)
}
pub(crate) fn restore(svc: &Services, key: &str) -> Result<Value, String> {
    restore_from(svc, store(), key)
}
fn restore_from(svc: &Services, state: &Store, key: &str) -> Result<Value, String> {
    let _lifecycle = hold_lifecycle(svc)?;
    let saved = state.saved()?;
    let a = saved
        .archives
        .iter()
        .find(|a| a.key == key)
        .ok_or("That archive is not known to this host.")?;
    // Archive keys are generated by the host. Do not turn corrupted records
    // into arbitrary refs, branch names or restore paths.
    if a.key.len() != 32
        || !a.key.bytes().all(|b| b.is_ascii_hexdigit())
        || a.reference != format!("refs/octiq/archive/{}", a.key)
    {
        return Err("The archive record has an invalid identity.".into());
    }
    real_dir(Path::new(&a.repo))?;
    git::git(
        &a.repo,
        &[
            "rev-parse",
            "--verify",
            &format!("{}^{{commit}}", a.reference),
        ],
    )?;
    let repo = Path::new(&a.repo);
    let parent = repo.parent().ok_or("Repository has no parent")?;
    let name = repo.file_name().ok_or("Repository has no name")?;
    let branch = format!("octiq/restored-{}", a.key);
    let target = parent.join(".worktrees").join(name).join(&branch);
    // Refuse redirects in every existing ancestor before creating parents.
    let existing = target
        .ancestors()
        .find(|p| fs::symlink_metadata(p).is_ok())
        .ok_or("Restore has no existing parent")?;
    real_dir(existing)?;
    require_unprotected(&target)?;
    let target = target.to_string_lossy().into_owned();
    git::restore(&a.repo, &target, &branch, &a.reference)?;
    state.change(false, |s| {
        s.archives
            .iter_mut()
            .find(|a| a.key == key)
            .ok_or("Archive disappeared")?
            .restored_at = Some(now());
        Ok(())
    })?;
    Ok(json!({"path":target,"branch":branch}))
}

#[cfg(test)]
mod tests;
