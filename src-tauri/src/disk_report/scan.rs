use super::*;
use std::{
    collections::{HashMap, HashSet},
    fs::{self, Metadata},
    io::Read,
    process::{Command, Stdio},
    time::{Duration, Instant},
};

#[derive(Clone, Default, Debug)]
pub(super) struct Size {
    pub bytes: u64,
    pub newest: u64,
    pub old: u64,
    pub recent: u64,
    pub complete: bool,
}
#[derive(Clone)]
struct Candidate {
    path: PathBuf,
    kind: String,
    group: String,
    label: String,
    effect: String,
    action: Option<Action>,
    chat: bool,
}
fn candidate(
    path: &Path,
    kind: &str,
    group: &str,
    label: &str,
    effect: &str,
    command: Option<&str>,
) -> Candidate {
    let action = if group == "work" {
        None
    } else {
        Some(
            command
                .map(|command| Action::Tool {
                    command: command.into(),
                })
                .unwrap_or_else(|| Action::Rm {
                    path: display(path),
                }),
        )
    };
    Candidate {
        path: path.into(),
        kind: kind.into(),
        group: group.into(),
        label: label.into(),
        effect: effect.into(),
        action,
        chat: false,
    }
}
// Data, not host cfg: all platform locations are exercised by the same tests.
fn cache_roots(platform: &str) -> Vec<(&'static str, &'static str, &'static str, &'static str)> {
    let mut roots = vec![
        (".npm", "npm-cache", "npm cache", "npm cache clean --force"),
        (
            ".cache/yarn",
            "yarn-cache",
            "Yarn cache",
            "yarn cache clean",
        ),
        (".cache/uv", "uv-cache", "uv cache", "uv cache clean"),
        (".cache/pip", "pip-cache", "pip cache", "pip cache purge"),
        (
            ".cache/go-build",
            "go-cache",
            "Go build cache",
            "go clean -cache",
        ),
        (
            ".local/share/pnpm/store",
            "pnpm-cache",
            "pnpm store",
            "pnpm store prune",
        ),
    ];
    if platform == "macos" {
        roots.extend([
            (
                "Library/Caches/Yarn",
                "yarn-cache",
                "Yarn cache",
                "yarn cache clean",
            ),
            (
                "Library/Caches/pip",
                "pip-cache",
                "pip cache",
                "pip cache purge",
            ),
            (
                "Library/Caches/uv",
                "uv-cache",
                "uv cache",
                "uv cache clean",
            ),
            (
                "Library/Caches/go-build",
                "go-cache",
                "Go build cache",
                "go clean -cache",
            ),
            (
                "Library/pnpm/store",
                "pnpm-cache",
                "pnpm store",
                "pnpm store prune",
            ),
            (
                "Library/Caches/Homebrew",
                "homebrew-cache",
                "Homebrew cache",
                "brew cleanup -s",
            ),
            (
                "Library/Caches/CocoaPods",
                "cocoapods-cache",
                "CocoaPods cache",
                "pod cache clean --all",
            ),
        ]);
    }
    if platform == "windows" {
        roots.extend([
            (
                "AppData/Local/npm-cache",
                "npm-cache",
                "npm cache",
                "npm cache clean --force",
            ),
            (
                "AppData/Local/Yarn/Cache",
                "yarn-cache",
                "Yarn cache",
                "yarn cache clean",
            ),
            (
                "AppData/Local/pnpm/store",
                "pnpm-cache",
                "pnpm store",
                "pnpm store prune",
            ),
            (
                "AppData/Local/uv/cache",
                "uv-cache",
                "uv cache",
                "uv cache clean",
            ),
            (
                "AppData/Local/pip/Cache",
                "pip-cache",
                "pip cache",
                "pip cache purge",
            ),
            (
                "AppData/Local/go-build",
                "go-cache",
                "Go build cache",
                "go clean -cache",
            ),
        ]);
    }
    roots
}
fn same_relative(path: &Path, text: &str, platform: &str) -> bool {
    if platform == "windows" {
        display(path).replace('\\', "/").eq_ignore_ascii_case(text)
    } else {
        path == Path::new(text)
    }
}
fn named_work(name: &str) -> bool {
    let n = name.to_lowercase();
    [
        ".fcpbundle",
        ".fcplibrary",
        ".prproj",
        ".drp",
        ".dra",
        ".rpp",
    ]
    .iter()
    .any(|x| n.ends_with(x))
        || [
            "exports",
            "photo exports",
            "photo-exports",
            "renders",
            "video projects",
            "premiere projects",
            "davinci projects",
        ]
        .contains(&n.as_str())
        || ["remotion", "premiere", "davinci", "final cut", "final-cut"]
            .iter()
            .any(|p| n.contains(p))
        || (n.contains("photo") && n.contains("export"))
}
fn classify(home: &Path, path: &Path, platform: &str, project: bool) -> Option<Candidate> {
    let relative = path.strip_prefix(home).ok()?;
    let name = path.file_name()?.to_string_lossy();
    let n = name.to_lowercase();
    if named_work(&name) {
        return Some(candidate(
            path,
            "personal-work",
            "work",
            &format!("Personal media / project: {name}"),
            "Personal work; never suggested for cleanup.",
            None,
        ));
    }
    for (p, kind, label, command) in cache_roots(platform) {
        if same_relative(relative, p, platform) {
            return Some(candidate(
                path,
                kind,
                "clean",
                label,
                "Clears downloaded or generated cache; the tool rebuilds it when needed.",
                Some(command),
            ));
        }
    }
    for (p, kind, label) in [
        (".cargo/registry", "cargo-registry", "Cargo registry cache"),
        (".cargo/git", "cargo-git", "Cargo git cache"),
        (".gradle/caches", "gradle-cache", "Gradle caches"),
        (".m2/repository", "maven-cache", "Maven local repository"),
        (
            "Library/Developer/Xcode/DerivedData",
            "xcode-derived-data",
            "Xcode DerivedData",
        ),
    ] {
        if same_relative(relative, p, platform) {
            return Some(candidate(path,kind,"clean",label,"Removes rebuildable dependency/build cache; the next build may download dependencies again.",None));
        }
    }
    for (p, kind, label) in [
        (".codex/sessions", "codex-history", "Codex chat history"),
        (
            ".codex/archived_sessions",
            "codex-archived-history",
            "Codex archived history",
        ),
        (
            ".claude/projects",
            "claude-history",
            "Claude Code chat history",
        ),
        (".gemini/tmp", "gemini-history", "Gemini chat history"),
        (
            ".local/share/opencode/storage/session",
            "opencode-history",
            "OpenCode chat history",
        ),
    ] {
        if same_relative(relative, p, platform) {
            let mut c = candidate(
                path,
                kind,
                "review",
                label,
                "Removes saved AI conversations; deleted conversations cannot be resumed.",
                None,
            );
            c.chat = true;
            return Some(c);
        }
    }
    for (p, kind, label) in [
        (".ollama", "ai-models", "Ollama models"),
        (".cache/huggingface", "ai-models", "Hugging Face models"),
        (".lmstudio", "ai-models", "LM Studio models"),
        (".cache/lm-studio", "ai-models", "LM Studio cache"),
        (
            "Library/Developer/CoreSimulator",
            "simulators",
            "Apple simulators",
        ),
        (".android/avd", "simulators", "Android virtual devices"),
        (".rustup/toolchains", "toolchains", "Rust toolchains"),
        (".nvm/versions", "toolchains", "Node toolchains"),
        (".pyenv/versions", "toolchains", "Python toolchains"),
        (".sdkman/candidates", "toolchains", "SDKMAN toolchains"),
        ("AppData/Local/Android/Sdk", "toolchains", "Android SDK"),
        ("Library/Android/sdk", "toolchains", "Android SDK"),
    ] {
        if same_relative(relative, p, platform) {
            return Some(candidate(path,kind,"review",label,"Removes installed models, simulators or toolchains; reinstalling may be expensive or lose local state.",None));
        }
    }
    if project
        && [
            "node_modules",
            "target",
            ".next",
            ".nuxt",
            ".svelte-kit",
            ".turbo",
            ".parcel-cache",
            "__pycache__",
            ".pytest_cache",
        ]
        .contains(&n.as_str())
    {
        return Some(candidate(path,&format!("project-{}",n.trim_start_matches('.')),"clean",&format!("Project {name}"),"Removes generated project dependencies/build output; the next install or build recreates it.",None));
    }
    None
}

pub(super) fn redirect(meta: &Metadata) -> bool {
    if meta.file_type().is_symlink() {
        return true;
    }
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        if meta.file_attributes() & (0x400 | 0x1000 | 0x40000) != 0 {
            return true;
        }
    }
    false
}
fn modified(meta: &Metadata) -> u64 {
    meta.modified()
        .ok()
        .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
        .map(|d| d.as_millis() as u64)
        .unwrap_or_else(now)
}
fn device(meta: &Metadata) -> u64 {
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        meta.dev()
    }
    #[cfg(not(unix))]
    {
        let _ = meta;
        0
    }
}
fn mac_allowed(relative: &Path) -> bool {
    // Deny Library by default. Do not probe unknown apps' data to find out if TCC protects it.
    let mut allowed: Vec<&str> = cache_roots("macos")
        .into_iter()
        .map(|x| x.0)
        .filter(|p| p.starts_with("Library/"))
        .collect();
    allowed.extend([
        "Library/Developer/Xcode/DerivedData",
        "Library/Developer/CoreSimulator",
        "Library/Android/sdk",
    ]);
    allowed
        .iter()
        .any(|p| relative.starts_with(p) || Path::new(p).starts_with(relative))
}
fn protected(home: &Path, path: &Path, platform: &str, profile: &Path) -> Option<String> {
    if path.starts_with(profile) || path.starts_with(home.join(".octiqflow")) {
        return Some("OctiqFlow profile / host state is excluded".into());
    }
    if path.starts_with(home.join("disk-report")) {
        return Some("Disk report history is excluded".into());
    }
    let relative = path.strip_prefix(home).ok();
    let name = path
        .file_name()
        .unwrap_or_default()
        .to_string_lossy()
        .to_lowercase();
    if name.ends_with(".photoslibrary") {
        return Some("Photos library is protected".into());
    }
    if name.starts_with("octiqflow-job-spool-") {
        return Some("OctiqFlow job spool is excluded".into());
    }
    if name == ".git" {
        return Some("Git internals: inspected only through read-only git commands".into());
    }
    if name == "docker"
        || name == ".docker"
        || name == "com.docker.docker"
        || name == "containers"
        || name == "containerd"
    {
        return Some("Container data is never traversed; Docker size uses docker system df".into());
    }
    if platform == "macos" {
        if path.starts_with("/Volumes") {
            return Some("External / network volumes are excluded".into());
        }
        if let Some(relative) = relative {
            for p in [
                "Desktop",
                "Documents",
                "Downloads",
                "Pictures",
                "Movies",
                "Music",
                ".Trash",
            ] {
                if relative.starts_with(p) {
                    return Some("macOS privacy / TCC protected root (never entered)".into());
                }
            }
            if relative.starts_with("Library") && !mac_allowed(relative) {
                return Some("macOS Library: privacy / other app data skipped by default".into());
            }
        }
    }
    if platform == "windows"
        && relative.is_some_and(|r| {
            ["OneDrive", "iCloudDrive", "iCloudPhotos"]
                .iter()
                .any(|p| r.starts_with(p))
        })
    {
        return Some("Cloud managed folder is excluded".into());
    }
    None
}

pub(super) struct Scanner {
    home: PathBuf,
    platform: String,
    id: String,
    cancel: Arc<AtomicBool>,
    managed: HashSet<PathBuf>,
    profile: PathBuf,
    pub(super) sizes: HashMap<PathBuf, Size>,
    candidates: Vec<Candidate>,
    repos: Vec<PathBuf>,
    skipped: Vec<Skipped>,
    entries: u64,
    bytes: u64,
    last: Instant,
    at: u64,
    home_device: u64,
}
impl Scanner {
    pub(super) fn new(
        home: PathBuf,
        platform: &str,
        id: String,
        cancel: Arc<AtomicBool>,
        managed: HashSet<PathBuf>,
    ) -> Self {
        Self {
            home,
            platform: platform.into(),
            id,
            cancel,
            managed,
            profile: crate::profile::profile_dir(),
            sizes: HashMap::new(),
            candidates: Vec::new(),
            repos: Vec::new(),
            skipped: Vec::new(),
            entries: 0,
            bytes: 0,
            last: Instant::now() - Duration::from_secs(1),
            at: now(),
            home_device: 0,
        }
    }
    fn check(&self) -> Result<(), String> {
        if self.cancel.load(Ordering::Relaxed) {
            Err("Disk scan cancelled".into())
        } else {
            Ok(())
        }
    }
    fn skip(&mut self, path: &Path, reason: impl Into<String>) {
        self.skipped.push(Skipped {
            path: display(path),
            reason: reason.into(),
        });
    }
    fn progress(
        &mut self,
        phase: &str,
        path: Option<String>,
        emit: &mut impl FnMut(&str, u64, u64, Option<String>),
    ) {
        if self.last.elapsed() >= Duration::from_millis(250) {
            emit(phase, self.entries, self.bytes, path);
            self.last = Instant::now();
        }
    }
    fn walk(
        &mut self,
        path: &Path,
        project: bool,
        chat: bool,
        listed: bool,
        phase: &str,
        emit: &mut impl FnMut(&str, u64, u64, Option<String>),
    ) -> Result<Size, String> {
        self.check()?;
        if phase == "home" && self.platform == "windows" && path == std::env::temp_dir() {
            self.skip(
                path,
                "System temp is scanned separately with age and process checks",
            );
            return Ok(Size::default());
        }
        if let Some(reason) = protected(&self.home, path, &self.platform, &self.profile) {
            self.skip(path, reason);
            return Ok(Size {
                complete: path.file_name().is_some_and(|n| n == ".git"),
                ..Size::default()
            });
        }
        if chat
            && path
                .file_name()
                .is_some_and(|n| n.to_string_lossy().eq_ignore_ascii_case("memory"))
        {
            self.skip(path, "AI memory is excluded from measurement and cleanup");
            return Ok(Size::default());
        }
        let meta = match fs::symlink_metadata(path) {
            Ok(m) => m,
            Err(e) => {
                self.skip(path, e.to_string());
                return Ok(Size::default());
            }
        };
        if redirect(&meta) {
            self.skip(
                path,
                "Symlink, junction, reparse point or cloud placeholder (not followed)",
            );
            return Ok(Size::default());
        }
        if device(&meta) != self.home_device {
            self.skip(
                path,
                "Different device from home (external / mounted volume)",
            );
            return Ok(Size::default());
        }
        self.entries += 1;
        self.progress(phase, Some(display(path)), emit);
        let mut size = Size {
            newest: modified(&meta),
            complete: true,
            ..Size::default()
        };
        if meta.is_file() {
            size.bytes = meta.len();
            self.bytes = self.bytes.saturating_add(size.bytes);
            if size.newest < self.at.saturating_sub(14 * DAY) {
                size.old = size.bytes;
            } else {
                size.recent = size.bytes;
            }
        } else if meta.is_dir() {
            let read = match fs::read_dir(path) {
                Ok(r) => r,
                Err(e) => {
                    self.skip(path, e.to_string());
                    return Ok(Size::default());
                }
            };
            // Read names only; never open manifests or .git files.
            let mut children = Vec::new();
            for entry in read {
                self.check()?;
                match entry {
                    Ok(e) => children.push(e.path()),
                    Err(e) => {
                        size.complete = false;
                        self.skip(path, e.to_string());
                    }
                }
            }
            let is_repo = children.iter().any(|p| {
                p.file_name().is_some_and(|n| n == ".git")
                    && fs::symlink_metadata(p)
                        .is_ok_and(|meta| !redirect(&meta) && device(&meta) == self.home_device)
            });
            if is_repo && phase == "home" {
                self.repos.push(path.into());
            }
            let project = project
                || is_repo
                || children.iter().any(|p| {
                    p.file_name().is_some_and(|n| {
                        [
                            "package.json",
                            "Cargo.toml",
                            "pyproject.toml",
                            "go.mod",
                            "pom.xml",
                            "build.gradle",
                        ]
                        .iter()
                        .any(|x| n == *x)
                    })
                });
            let personal = children.iter().any(|p| {
                p.file_name().is_some_and(|n| {
                    let n = n.to_string_lossy().to_lowercase();
                    n.ends_with(".prproj")
                        || n.ends_with(".drp")
                        || n.starts_with("remotion.config.")
                })
            });
            let c = if personal
                || named_work(&path.file_name().unwrap_or_default().to_string_lossy())
            {
                Some(candidate(
                    path,
                    "personal-work",
                    "work",
                    "Personal media project and outputs",
                    "Personal work; never suggested for cleanup.",
                    None,
                ))
            } else if listed {
                None
            } else {
                classify(&self.home, path, &self.platform, project)
            };
            let chat = chat || c.as_ref().is_some_and(|c| c.chat);
            let listed = listed || c.is_some();
            if let Some(c) = c {
                self.candidates.push(c);
            }
            for child in children {
                let child_size = self.walk(&child, project, chat, listed, phase, emit)?;
                size.bytes = size.bytes.saturating_add(child_size.bytes);
                size.old = size.old.saturating_add(child_size.old);
                size.recent = size.recent.saturating_add(child_size.recent);
                size.newest = size.newest.max(child_size.newest);
                size.complete &= child_size.complete;
            }
        } else {
            self.skip(path, "Special file (metadata only)");
            size.complete = false;
        }
        if meta.is_file() && named_work(&path.file_name().unwrap_or_default().to_string_lossy()) {
            if let Some(c) = classify(&self.home, path, &self.platform, project) {
                self.candidates.push(c);
            }
        }
        self.sizes.insert(path.into(), size.clone());
        Ok(size)
    }
    pub(super) fn run(
        &mut self,
        mut emit: impl FnMut(&str, u64, u64, Option<String>),
    ) -> Result<Report, String> {
        self.home_device = device(&fs::symlink_metadata(&self.home).map_err(|e| e.to_string())?);
        let history = history::previous(&self.home, self.at)?;
        // Record all known protected roots even when absent, without probing them.
        if self.platform == "macos" {
            for p in [
                "Desktop",
                "Documents",
                "Downloads",
                "Pictures",
                "Movies",
                "Music",
                ".Trash",
                "Library/Mobile Documents",
                "Library/CloudStorage",
                "Library/Mail",
                "Library/Messages",
                "Library/Safari",
                "Library/Calendars",
                "Library/Reminders",
                "Library/HomeKit",
                "Library/Cookies",
                "Library/Suggestions",
                "Library/Biome",
                "Library/Metadata/CoreSpotlight",
                "Library/Application Support/AddressBook",
                "Library/Application Support/CallHistoryDB",
                "Library/Application Support/com.apple.TCC",
                "Library/Containers",
                "Library/Group Containers",
            ] {
                self.skip(
                    &self.home.join(p),
                    "macOS privacy / cloud / TCC protected root (never entered)",
                );
            }
        }
        self.walk(&self.home.clone(), false, false, false, "home", &mut emit)?;
        let in_use = InUse::capture(&self.cancel);
        if let Some(reason) = &in_use.error {
            self.skip(Path::new("process-usage"), reason.clone());
        }
        let mut items = self.items();
        self.progress("temp", None, &mut emit);
        self.temp(&in_use, &mut items, &mut emit)?;
        self.progress("git", None, &mut emit);
        self.worktrees(&in_use, &mut items, &mut emit)?;
        self.docker(&mut items)?;
        self.check()?;
        self.progress("history", None, &mut emit);
        // Keep work/worktree/cache roots disjoint; chat's two age buckets share a path intentionally.
        items.sort_by_key(|i| Path::new(&i.path).components().count());
        let mut selected: Vec<Item> = Vec::new();
        for item in items {
            if selected.iter().any(|parent| {
                parent.path != item.path && Path::new(&item.path).starts_with(&parent.path)
            }) {
                continue;
            }
            selected.push(item);
        }
        selected.sort_by_key(|i| std::cmp::Reverse(i.bytes));
        self.skipped.sort_by(|a, b| a.path.cmp(&b.path));
        self.skipped
            .dedup_by(|a, b| a.path == b.path && a.reason == b.reason);
        let mut report = Report {
            scan_id: self.id.clone(),
            scanned_at: self.at,
            platform: self.platform.clone(),
            home: display(&self.home),
            threshold_bytes: THRESHOLD,
            total_bytes: selected.iter().map(|i| i.bytes).sum(),
            items: selected,
            skipped: self.skipped.clone(),
            previous_scan_at: None,
        };
        history::compare(&mut report, &history);
        Ok(report)
    }
    fn item(&self, c: &Candidate, size: &Size) -> Item {
        let key = format!("{}:{}", c.kind, display(&c.path));
        Item {
            id: uuid::Uuid::new_v4().to_string(),
            key,
            group: c.group.clone(),
            kind: c.kind.clone(),
            label: c.label.clone(),
            path: display(&c.path),
            bytes: size.bytes,
            modified_at: size.newest,
            effect: c.effect.clone(),
            note: None,
            not_recommended: false,
            action: c.action.clone(),
            previous_bytes: None,
            grew: false,
            worktree: None,
        }
    }
    fn items(&self) -> Vec<Item> {
        let mut items = Vec::new();
        for c in &self.candidates {
            if c.group != "work"
                && self.candidates.iter().any(|work| {
                    work.group == "work" && work.path != c.path && work.path.starts_with(&c.path)
                })
            {
                continue;
            }
            let Some(size) = self.sizes.get(&c.path) else {
                continue;
            };
            if c.chat {
                for (suffix, bytes, recent) in [
                    ("older-14-days", size.old, false),
                    ("last-14-days", size.recent, true),
                ] {
                    if bytes < THRESHOLD {
                        continue;
                    }
                    let mut i = self.item(c, size);
                    i.bytes = bytes;
                    i.kind = format!("{}-{suffix}", c.kind);
                    i.key = format!("{}:{}", i.kind, i.path);
                    i.label = format!(
                        "{} — {}",
                        c.label,
                        if recent {
                            "last 14 days"
                        } else {
                            "older than 14 days"
                        }
                    );
                    i.not_recommended = recent;
                    if recent {
                        i.note = Some("Not recommended to delete".into());
                        // A recent selection has no age-safe deletion primitive in the contract; skip it in scripts.
                        i.action = None;
                    } else {
                        i.action = Some(Action::RmOlderThan {
                            path: i.path.clone(),
                            days: 14,
                            exclude: vec!["memory".into()],
                        });
                    }
                    if !size.complete && i.note.is_none() {
                        i.note = Some("Partial measurement: see skipped paths".into());
                    }
                    items.push(i);
                }
            } else if size.bytes >= THRESHOLD {
                let mut i = self.item(c, size);
                if !size.complete && i.group == "clean" {
                    i.group = "review".into();
                    i.note = Some("Partial measurement: see skipped paths".into());
                }
                items.push(i);
            }
        }
        items
    }
    fn temp(
        &mut self,
        in_use: &InUse,
        items: &mut Vec<Item>,
        emit: &mut impl FnMut(&str, u64, u64, Option<String>),
    ) -> Result<(), String> {
        let roots = if self.platform == "linux" {
            vec![PathBuf::from("/tmp"), PathBuf::from("/var/tmp")]
        } else {
            vec![std::env::temp_dir()]
        };
        self.temp_roots(&roots, in_use, items, emit)
    }
    fn temp_roots(
        &mut self,
        roots: &[PathBuf],
        in_use: &InUse,
        items: &mut Vec<Item>,
        emit: &mut impl FnMut(&str, u64, u64, Option<String>),
    ) -> Result<(), String> {
        let mut roots_seen = HashSet::new();
        for root in roots {
            // Temp's OS path can itself be an alias (/tmp -> /private/tmp). Resolve only this trusted root.
            let root = match crate::paths::canonicalize(&root) {
                Ok(p) => p,
                Err(e) => {
                    self.skip(&root, e.to_string());
                    continue;
                }
            };
            if !roots_seen.insert(root.clone()) {
                continue;
            }
            let meta = match fs::symlink_metadata(&root) {
                Ok(m) => m,
                Err(e) => {
                    self.skip(&root, e.to_string());
                    continue;
                }
            };
            if device(&meta) != self.home_device {
                self.skip(&root, "System temp is on a different device from home");
                continue;
            }
            let read = match fs::read_dir(&root) {
                Ok(r) => r,
                Err(e) => {
                    self.skip(&root, e.to_string());
                    continue;
                }
            };
            for entry in read {
                self.check()?;
                let path = match entry {
                    Ok(e) => e.path(),
                    Err(e) => {
                        self.skip(&root, e.to_string());
                        continue;
                    }
                };
                let name = path
                    .file_name()
                    .unwrap_or_default()
                    .to_string_lossy()
                    .to_lowercase();
                if name.starts_with("octiqflow-job-spool-") {
                    self.skip(&path, "OctiqFlow job spool is excluded");
                    continue;
                }
                let ai = name.starts_with("claude-") || name.starts_with("codex-");
                let cache = [
                    "npm-",
                    "yarn-",
                    "pnpm-",
                    "uv-cache-",
                    "pip-cache-",
                    "cargo-cache-",
                    "rustc-",
                ]
                .iter()
                .any(|p| name.starts_with(p));
                if !ai && !cache {
                    self.skip(&path, "Unrecognized temp entry; never a cleanup suggestion");
                    continue;
                }
                let size = self.walk(&path, false, ai, false, "temp", emit)?;
                let personal = self
                    .candidates
                    .iter()
                    .any(|c| c.group == "work" && c.path.starts_with(&path));
                if size.bytes < THRESHOLD
                    || personal
                    || !size.complete
                    || self.at.saturating_sub(size.newest) <= 3 * DAY
                    || in_use.contains(&path)
                {
                    continue;
                }
                let mut c = candidate(
                    &path,
                    if ai {
                        "ai-session-temp"
                    } else {
                        "development-temp"
                    },
                    if ai { "review" } else { "clean" },
                    if ai {
                        "Old AI session temp"
                    } else {
                        "Old development temp cache"
                    },
                    "Removes old temporary data; inspect any session output before deleting.",
                    None,
                );
                c.chat = false;
                if ai {
                    c.action = Some(Action::RmOlderThan {
                        path: display(&path),
                        days: 3,
                        exclude: vec!["memory".into()],
                    });
                }
                items.push(self.item(&c, &size));
            }
        }
        Ok(())
    }
    fn git(&self, path: &Path, args: &[&str]) -> Option<Vec<u8>> {
        let mut cmd = Command::new("git");
        cmd.arg("--no-optional-locks")
            .args([
                "-c",
                "core.fsmonitor=false",
                "-c",
                "core.untrackedCache=false",
                "-C",
            ])
            .arg(path)
            .args(args)
            .env("GIT_OPTIONAL_LOCKS", "0")
            .env("GIT_TERMINAL_PROMPT", "0")
            .env("GIT_NO_LAZY_FETCH", "1");
        command(&mut cmd, &self.cancel, Duration::from_secs(15))
    }
    fn worktrees(
        &mut self,
        in_use: &InUse,
        items: &mut Vec<Item>,
        emit: &mut impl FnMut(&str, u64, u64, Option<String>),
    ) -> Result<(), String> {
        let mut seen = HashSet::new();
        for repo in self.repos.clone() {
            self.check()?;
            self.progress("git", Some(display(&repo)), emit);
            let Some(output) = self.git(&repo, &["worktree", "list", "--porcelain", "-z"]) else {
                self.skip(&repo, "git worktree list unavailable / timed out");
                continue;
            };
            let mut first = true;
            let mut primary = repo.clone();
            for block in output
                .split(|c| *c == 0)
                .filter(|x| x.starts_with(b"worktree "))
            {
                let Ok(path) = std::str::from_utf8(&block[9..]) else {
                    continue;
                };
                let path = PathBuf::from(path);
                if first {
                    first = false;
                    primary = path;
                    continue;
                } // primary is always first
                if !seen.insert(path.clone()) {
                    continue;
                }
                if !path.starts_with(&self.home) || !self.sizes.contains_key(&path) {
                    self.skip(&path, "Worktree outside safely scanned home paths");
                    continue;
                }
                // Even a small worktree must prevent an ancestor cache's rm action.
                // A worktree can be removed only through Git, never through its parent.
                items.retain(|item| {
                    item.group == "work" || !path.starts_with(Path::new(&item.path))
                });
                let size = self.sizes[&path].clone();
                if size.bytes < THRESHOLD {
                    continue;
                }
                let clean = self
                    .git(
                        &path,
                        &["status", "--porcelain=v1", "-z", "--untracked-files=all"],
                    )
                    .is_some_and(|o| o.is_empty());
                let branch = self
                    .git(&path, &["symbolic-ref", "--quiet", "--short", "HEAD"])
                    .map(|o| String::from_utf8_lossy(&o).trim().to_string())
                    .unwrap_or_else(|| "(detached)".into());
                let mainline = self
                    .git(
                        &repo,
                        &["symbolic-ref", "--quiet", "refs/remotes/origin/HEAD"],
                    )
                    .map(|o| String::from_utf8_lossy(&o).trim().to_string())
                    .or_else(|| {
                        ["refs/heads/main", "refs/heads/master"]
                            .iter()
                            .find(|r| self.git(&primary, &["rev-parse", "--verify", r]).is_some())
                            .map(|s| s.to_string())
                    })
                    .unwrap_or_default();
                let merged = !mainline.is_empty()
                    && self
                        .git(&path, &["merge-base", "--is-ancestor", "HEAD", &mainline])
                        .is_some();
                let idle_days = self.at.saturating_sub(size.newest) / DAY;
                let in_use = in_use.contains(&path);
                let managed = self.managed.iter().any(|p| p == &path);
                let personal = self.candidates.iter().any(|c| {
                    c.group == "work" && (c.path.starts_with(&path) || path.starts_with(&c.path))
                });
                let ignored = self.ignored(&path);
                let eligible = !personal
                    && ignored.is_some()
                    && clean
                    && merged
                    && idle_days >= 7
                    && !in_use
                    && !managed
                    && size.complete;
                let mut reasons = Vec::new();
                if personal {
                    reasons.push("Contains personal media work; label only");
                }
                if !clean {
                    reasons.push("Uncommitted/untracked changes or git status unavailable");
                }
                if !merged {
                    reasons.push("HEAD is not verified merged into mainline");
                }
                if idle_days < 7 {
                    reasons.push("Files changed within 7 days");
                }
                if in_use {
                    reasons.push("In use or process usage could not be verified");
                }
                if managed {
                    reasons.push("Managed by an OctiqFlow run: close it from the run panel");
                }
                if !size.complete {
                    reasons.push("Partial scan: skipped paths prevent eligibility");
                }
                if ignored.is_none() {
                    reasons.push("Ignored-output size could not be measured");
                }
                let ignored_bytes = ignored.unwrap_or(0);
                let mut c=candidate(&path,"git-worktree",if eligible {"clean"} else {"review"},"Linked Git worktree","Removing this worktree also deletes .gitignore-ignored output that exists only there.",None);
                if personal {
                    c.group = "work".into();
                    c.label = "Personal media worktree (label only)".into();
                    c.action = None;
                } else {
                    c.action = Some(Action::Worktree {
                        repo: display(&primary),
                        path: display(&path),
                    });
                }
                let mut i = self.item(&c, &size);
                if !reasons.is_empty() {
                    i.note = Some(reasons.join("; "));
                }
                i.worktree = Some(Worktree {
                    repo: display(&primary),
                    branch,
                    clean,
                    merged,
                    mainline,
                    idle_days,
                    in_use,
                    eligible,
                    ignored_bytes,
                });
                items.retain(|i| !Path::new(&i.path).starts_with(&path));
                items.push(i);
            }
        }
        Ok(())
    }
    fn ignored(&self, path: &Path) -> Option<u64> {
        let Some(output) = self.git(
            path,
            &[
                "status",
                "--ignored",
                "--porcelain=v1",
                "-z",
                "--untracked-files=normal",
            ],
        ) else {
            return None;
        };
        let mut roots = Vec::new();
        for entry in output.split(|c| *c == 0).filter(|e| e.starts_with(b"!! ")) {
            if let Ok(name) = std::str::from_utf8(&entry[3..]) {
                roots.push(path.join(name.trim_end_matches('/')));
            }
        }
        roots.sort_by_key(|p| p.components().count());
        let mut seen: Vec<PathBuf> = Vec::new();
        let mut total = 0u64;
        for root in roots {
            if !seen.iter().any(|p| root.starts_with(p)) {
                total = total.saturating_add(self.sizes.get(&root).map(|s| s.bytes).unwrap_or(0));
                seen.push(root);
            }
        }
        Some(total)
    }
    fn docker(&mut self, items: &mut Vec<Item>) -> Result<(), String> {
        self.check()?;
        let mut cmd = Command::new("docker");
        cmd.args(["system", "df", "--format", "{{json .}}"]);
        if let Some(output) = command(&mut cmd, &self.cancel, Duration::from_secs(8)) {
            let mut bytes = 0u64;
            for line in String::from_utf8_lossy(&output).lines() {
                if let Ok(v) = serde_json::from_str::<Value>(line) {
                    if let Some(s) = v.get("Size").and_then(Value::as_str) {
                        bytes = bytes.saturating_add(docker_bytes(s));
                    }
                }
            }
            if bytes >= THRESHOLD {
                let mut c=candidate(Path::new("docker://local"),"docker","review","Docker storage","docker system prune removes unused Docker data; inspect images, containers and build cache first.",None);
                c.action = Some(Action::Docker {
                    command: "docker system prune".into(),
                });
                items.push(self.item(
                    &c,
                    &Size {
                        bytes,
                        newest: self.at,
                        complete: true,
                        ..Size::default()
                    },
                ));
            }
        } else {
            self.skip(
                Path::new("docker://local"),
                "Docker CLI unavailable, daemon did not answer or command timed out",
            );
        }
        Ok(())
    }
}
fn docker_bytes(s: &str) -> u64 {
    let split = s
        .find(|c: char| !c.is_ascii_digit() && c != '.')
        .unwrap_or(s.len());
    let number = s[..split].parse::<f64>().unwrap_or(0.0);
    let unit = s[split..].trim().to_ascii_lowercase();
    (number
        * match unit.as_str() {
            "kb" => 1e3,
            "mb" => 1e6,
            "gb" => 1e9,
            "tb" => 1e12,
            "kib" => 1024.0,
            "mib" => 1048576.0,
            "gib" => 1073741824.0,
            _ => 1.0,
        }) as u64
}
/// Bounded read-only subprocess, killed on cancellation or timeout. No shell.
fn command(cmd: &mut Command, cancel: &AtomicBool, timeout: Duration) -> Option<Vec<u8>> {
    let mut child = cmd
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .ok()?;
    let stdout = child.stdout.take()?;
    let (sender, receiver) = std::sync::mpsc::channel();
    std::thread::spawn(move || {
        let mut bytes = Vec::new();
        let result = stdout
            .take(32 * 1024 * 1024 + 1)
            .read_to_end(&mut bytes)
            .ok()
            .map(|_| bytes);
        let _ = sender.send(result);
    });
    let started = Instant::now();
    let status = loop {
        if cancel.load(Ordering::Relaxed) || started.elapsed() > timeout {
            let _ = child.kill();
            let _ = child.wait();
            return None;
        }
        match child.try_wait() {
            Ok(Some(s)) => break s,
            Ok(None) => std::thread::sleep(Duration::from_millis(20)),
            Err(_) => {
                let _ = child.kill();
                let _ = child.wait();
                return None;
            }
        }
    };
    if !status.success() {
        return None;
    }
    let bytes = receiver.recv_timeout(Duration::from_millis(500)).ok()??;
    if bytes.len() > 32 * 1024 * 1024 {
        None
    } else {
        Some(bytes)
    }
}
#[derive(Clone)]
struct InUse {
    paths: Vec<PathBuf>,
    error: Option<String>,
}
impl InUse {
    fn capture(_cancel: &AtomicBool) -> Self {
        #[cfg(unix)]
        {
            let mut cmd = Command::new("lsof");
            cmd.args(["-nP", "-F0n"]);
            if let Some(output) = command(&mut cmd, _cancel, Duration::from_secs(12)) {
                let paths = output
                    .split(|b| *b == 0 || *b == b'\n')
                    .filter_map(|field| field.strip_prefix(b"n"))
                    .filter_map(|name| std::str::from_utf8(name).ok())
                    .filter(|p| p.starts_with('/'))
                    .map(PathBuf::from)
                    .collect::<Vec<_>>();
                if !paths.is_empty() {
                    return Self { paths, error: None };
                }
            }
        }
        // Windows has no bundled API/CLI that proves every process's open file/cwd.
        // Fail closed instead of guessing from executable paths (and never prompt for elevation).
        Self{paths:Vec::new(),error:Some("Complete process open-file/cwd inventory unavailable; worktrees stay review and temp cleanup is withheld".into())}
    }
    fn contains(&self, path: &Path) -> bool {
        self.error.is_some() || self.paths.iter().any(|p| p.starts_with(path))
    }
}

#[cfg(test)]
#[path = "tests.rs"]
mod tests;
