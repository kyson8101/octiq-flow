//! A clean porcelain status says nothing about ignored originals/renders.
//! Inventory metadata only: large media never needs to be read or archived.
use super::{git, real_dir, redirect};
use sha2::{Digest, Sha256};
use std::{
    collections::BTreeMap,
    fs,
    path::{Component, Path},
    time::{Duration, Instant, UNIX_EPOCH},
};

pub(super) struct Inventory {
    pub files: u64,
    pub bytes: u64,
    pub hash: String,
}

fn marker(parent: &Path, name: &str) -> bool {
    fs::symlink_metadata(parent.join(name)).is_ok_and(|m| m.is_file() && !redirect(&m))
}

fn rebuildable(root: &Path, relative: &Path) -> bool {
    // These trees may hold the only copy, even when a descendant is named
    // dist/target or has a generated-looking suffix. This overrides all rules.
    if relative.components().any(|c| {
        ["source", "works", "anime"].iter().any(|name| {
            c.as_os_str()
                .to_str()
                .is_some_and(|part| part.eq_ignore_ascii_case(name))
        })
    }) {
        return false;
    }
    let name = relative.file_name().unwrap_or_default().to_string_lossy();
    let Ok(meta) = fs::symlink_metadata(root.join(relative)) else {
        return false;
    };
    if !meta.is_file() && !meta.file_type().is_symlink() {
        return false;
    }
    let link = redirect(&meta);
    if !link && (name == ".DS_Store" || name.ends_with(".log")) {
        return true;
    }
    let parent = root.join(relative.parent().unwrap_or(Path::new("")));
    if name == "pnpm-workspace.yaml" && !link {
        let sibling = relative
            .parent()
            .unwrap_or(Path::new(""))
            .join("package.json");
        let manifest = marker(&parent, "package.json")
            || (fs::symlink_metadata(root.join(&sibling)).is_err()
                && sibling.to_str().is_some_and(|p| {
                    git::git_bounded(
                        root.to_str().unwrap_or(""),
                        &["ls-files", "--error-unmatch", "--", p],
                        Duration::from_millis(50),
                    )
                    .is_ok()
                }));
        return !link && manifest && pnpm_placeholder(&root.join(relative));
    }
    if !link && name.ends_with(".tsbuildinfo") && marker(&parent, "package.json") {
        return true;
    }
    relative
        .ancestors()
        .take_while(|p| !p.as_os_str().is_empty())
        .any(|p| {
            let parent = root.join(p.parent().unwrap_or(Path::new("")));
            if !fs::symlink_metadata(root.join(p)).is_ok_and(|m| m.is_dir() && !redirect(&m)) {
                return false;
            }
            match p.file_name().and_then(|n| n.to_str()) {
                Some("target") => marker(&parent, "Cargo.toml"),
                Some("node_modules") => marker(&parent, "package.json"),
                Some("dist" | ".astro") if !link => marker(&parent, "package.json"),
                _ => false,
            }
        })
}

// pnpm's generated allowBuilds placeholder, never a hand-written workspace.
fn pnpm_placeholder(path: &Path) -> bool {
    use std::io::Read;
    let Ok(file) = super::raw::open_regular(path) else {
        return false;
    };
    let mut bytes = Vec::new();
    if file.take(4097).read_to_end(&mut bytes).is_err() || bytes.len() > 4096 {
        return false;
    }
    let Ok(text) = std::str::from_utf8(&bytes) else {
        return false;
    };
    let mut lines = text.lines().filter(|line| !line.trim().is_empty());
    if lines.next() != Some("allowBuilds:") {
        return false;
    }
    lines.all(|line| {
        let Some(line) = line.strip_prefix("  ") else {
            return false;
        };
        let Some((name, value)) = line.rsplit_once(": ") else {
            return false;
        };
        !name.is_empty()
            && name
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || b"@/._-".contains(&b))
            && matches!(value, "true" | "false" | "set this to true or false")
    })
}

fn overrides(name: &std::ffi::OsStr) -> bool {
    ["source", "works", "anime"]
        .iter()
        .any(|o| name.to_str().is_some_and(|n| n.eq_ignore_ascii_case(o)))
}

/// What a directory is to the walk below it. Inside a qualifying build folder
/// every regular file is rebuildable unless a `source`/`works`/`anime` folder
/// is on its way, which is exactly the answer `rebuildable` reaches by asking,
/// for every file, whether some ancestor qualifies. Knowing it once per
/// directory turns about a dozen stats per file into none, which is what lets
/// a several-hundred-thousand-entry `node_modules` be inspected in seconds.
#[derive(Clone, Copy, PartialEq)]
enum Under {
    /// Ordinary checkout content.
    Outside,
    /// `target` / `node_modules`: regular files and symlinks are rebuildable.
    Build,
    /// `dist` / `.astro`: regular files are rebuildable, symlinks are not.
    Output,
    /// An at-stake override (`source`, `works`, `anime`) is above: nothing
    /// below is rebuildable, whatever it is under.
    Held,
}
impl Under {
    /// The state of the directory `relative` itself, given its parent's.
    fn of(self, root: &Path, relative: &Path, m: &fs::Metadata) -> Self {
        let name = relative.file_name().unwrap_or_default();
        if self == Self::Held || overrides(name) {
            return Self::Held;
        }
        if self != Self::Outside || redirect(m) || !m.is_dir() {
            return self;
        }
        let parent = root.join(relative.parent().unwrap_or(Path::new("")));
        match name.to_str() {
            Some("target") if marker(&parent, "Cargo.toml") => Self::Build,
            Some("node_modules") if marker(&parent, "package.json") => Self::Build,
            Some("dist" | ".astro") if marker(&parent, "package.json") => Self::Output,
            _ => Self::Outside,
        }
    }
    fn is_build(self) -> bool {
        matches!(self, Self::Build | Self::Output)
    }
}

pub(super) fn repository_entry(path: &Path, relative: &Path, m: &fs::Metadata) -> bool {
    relative
        .file_name()
        .and_then(|n| n.to_str())
        .is_some_and(|n| n.eq_ignore_ascii_case(".git"))
        || (m.is_dir()
            && !redirect(m)
            && marker(path, "HEAD")
            && ["objects", "refs"].iter().all(|n| {
                fs::symlink_metadata(path.join(n)).is_ok_and(|m| m.is_dir() && !redirect(&m))
            }))
}

/// Counts what a walk has seen. Entries inside a qualifying build folder are
/// metadata the walk only has to classify, and are bounded far more widely than
/// the checkout's own files.
struct Limits {
    start: Instant,
    budget: Duration,
    max: usize,
    visited: usize,
    build_visited: usize,
}
impl Limits {
    fn new(start: Instant, budget: Duration, max: usize, visited: usize) -> Self {
        Self {
            start,
            budget,
            max,
            visited,
            build_visited: 0,
        }
    }
    fn count(&mut self, relative: &Path, in_build: bool, what: &str) -> Result<(), String> {
        if in_build {
            self.build_visited += 1;
        } else {
            self.visited += 1;
        }
        if self.visited > self.max
            || self.build_visited > super::BUILD_ENTRIES
            || relative.components().count() > 256
            || self.start.elapsed() >= self.budget
        {
            return Err(limit_message(what, in_build, self.budget, self.max));
        }
        Ok(())
    }
}
fn limit_message(what: &str, in_build: bool, budget: Duration, max: usize) -> String {
    if in_build {
        format!(
            "{what} reached its {} entry or {} second limit inside a build folder; the folder is kept. Delete that build folder (for example node_modules) or the worktree yourself, or retry when the machine is less busy.",
            super::BUILD_ENTRIES,
            budget.as_secs()
        )
    } else {
        format!(
            "{what} reached its {max} entry or {} second limit outside build folders; the folder is kept. It holds more files than automatic cleanup inspects; remove it yourself or clear the large folder.",
            budget.as_secs()
        )
    }
}

/// Before any lock is held (the sweep's own look, the pre-removal recheck).
pub(super) fn inventory(root: &str) -> Result<Inventory, String> {
    bounded(root, super::WALK_TIME, super::WALK_ENTRIES)
}

/// At the final door, with the workspace lifecycle held: short, so it never
/// blocks the others for long. A checkout too large for it is kept.
pub(super) fn final_inventory(root: &str) -> Result<Inventory, String> {
    bounded(root, Duration::from_secs(15), super::WALK_ENTRIES)
}

pub(super) fn bounded(
    root: &str,
    budget: Duration,
    max_entries: usize,
) -> Result<Inventory, String> {
    let start = Instant::now();
    let mut bytes = git::git_bounded(
        root,
        &[
            "status",
            "--porcelain=v1",
            "-z",
            "--ignored=matching",
            "--untracked-files=all",
            "--ignore-submodules=none",
        ],
        budget,
    )?;
    let mut limits = Limits::new(start, budget, max_entries, 0);
    special_entries(
        Path::new(root),
        Path::new(""),
        Under::Outside,
        &mut bytes,
        &mut limits,
    )?;
    from_status(Path::new(root), &bytes, limits)
}

// Git omits FIFOs/sockets from porcelain entirely. Discover those metadata-only,
// without opening them; otherwise even a safe open could still classify them
// as absent and permit whole-folder removal. Repository entries stay opaque.
fn special_entries(
    root: &Path,
    relative: &Path,
    under: Under,
    rows: &mut Vec<u8>,
    limits: &mut Limits,
) -> Result<(), String> {
    let path = root.join(relative);
    real_dir(&path)?;
    for entry in fs::read_dir(&path).map_err(|e| e.to_string())? {
        limits.count(relative, under.is_build(), "Special-file inventory")?;
        let entry = entry.map_err(|e| e.to_string())?;
        let name = relative.join(entry.file_name());
        if relative.as_os_str().is_empty() && entry.file_name() == ".git" {
            continue;
        }
        let m = fs::symlink_metadata(entry.path()).map_err(|e| e.to_string())?;
        if redirect(&m) || repository_entry(&entry.path(), &name, &m) {
            continue;
        }
        if m.is_dir() {
            let below = under.of(root, &name, &m);
            special_entries(root, &name, below, rows, limits)?;
        } else if !m.is_file() {
            rows.extend_from_slice(b"!! ");
            rows.extend_from_slice(
                name.to_str()
                    .ok_or("Special-file path is not UTF-8")?
                    .as_bytes(),
            );
            rows.push(0);
        }
    }
    Ok(())
}

fn walk(
    root: &Path,
    relative: &Path,
    under: Under,
    entries: &mut BTreeMap<Vec<u8>, (u64, Vec<u8>)>,
    limits: &mut Limits,
) -> Result<(), String> {
    limits.count(relative, under.is_build(), "Ignored-file inventory")?;
    let path = root.join(relative);
    real_dir(path.parent().ok_or("Ignored path has no parent")?)?;
    let m = fs::symlink_metadata(&path).map_err(|e| e.to_string())?;
    let repository = repository_entry(&path, relative, &m);
    if m.is_dir() && !redirect(&m) && !repository {
        let below = under.of(root, relative, &m);
        for entry in fs::read_dir(&path).map_err(|e| e.to_string())? {
            let entry = entry.map_err(|e| e.to_string())?;
            walk(
                root,
                &relative.join(entry.file_name()),
                below,
                entries,
                limits,
            )?;
        }
    } else if repository || !rebuildable_under(root, relative, under, &m) {
        let name = relative
            .to_str()
            .ok_or("Ignored path is not valid UTF-8")?
            .as_bytes()
            .to_vec();
        let mut h = Sha256::new();
        h.update(m.len().to_le_bytes());
        h.update([
            u8::from(m.is_file()),
            u8::from(m.is_dir()),
            u8::from(redirect(&m)),
        ]);
        let modified = m
            .modified()
            .map_err(|e| e.to_string())?
            .duration_since(UNIX_EPOCH)
            .map_err(|e| e.to_string())?;
        h.update(modified.as_nanos().to_le_bytes());
        #[cfg(unix)]
        {
            use std::os::unix::fs::MetadataExt;
            h.update(m.ctime().to_le_bytes());
            h.update(m.ctime_nsec().to_le_bytes());
        }
        if m.file_type().is_symlink() {
            h.update(
                fs::read_link(&path)
                    .map_err(|e| e.to_string())?
                    .to_string_lossy()
                    .as_bytes(),
            );
        }
        entries.insert(name, (m.len(), h.finalize().to_vec()));
    }
    Ok(())
}

/// `rebuildable`, with the answer for a regular file or symlink under a
/// qualifying build folder known from the walk instead of asked again. Every
/// other case, and every doubt, goes to the full predicate.
fn rebuildable_under(root: &Path, relative: &Path, under: Under, m: &fs::Metadata) -> bool {
    let name = relative.file_name().unwrap_or_default();
    if under == Under::Held || overrides(name) {
        return false;
    }
    let link = redirect(m);
    match under {
        Under::Build if m.is_file() || link => true,
        Under::Output if m.is_file() && !link => true,
        _ => rebuildable(root, relative),
    }
}

/// Strip and whole-folder removal share exactly the same at-stake predicate.
/// No Git ignore traversal can hide a nested repository or source override.
pub(super) fn subtree(
    root: &str,
    relative: &Path,
    budget: Duration,
    max: usize,
) -> Result<Inventory, String> {
    let name = relative.to_str().ok_or("Build path is not UTF-8")?;
    let status = format!("!! {name}\0");
    from_status(
        Path::new(root),
        status.as_bytes(),
        Limits::new(Instant::now(), budget, max, 0),
    )
}

fn from_status(root: &Path, status: &[u8], mut limits: Limits) -> Result<Inventory, String> {
    let mut entries = BTreeMap::new();
    let mut rows = status.split(|b| *b == 0).filter(|r| !r.is_empty());
    while let Some(row) = rows.next() {
        if row.starts_with(b"!! ") {
            let path = std::str::from_utf8(&row[3..]).map_err(|e| e.to_string())?;
            let path = Path::new(path);
            if path.as_os_str().is_empty()
                || !path.components().all(|c| matches!(c, Component::Normal(_)))
            {
                return Err(
                    "Ignored inventory contains an unsafe path; the folder is kept.".into(),
                );
            }
            // The status row names the folder itself, so the walk must learn
            // what its ancestors are (a `source` folder above, a build folder
            // in the middle) before it takes its first step.
            let mut under = Under::Outside;
            let mut walked = Path::new("").to_path_buf();
            if let Some(parent) = path.parent() {
                for part in parent.components() {
                    walked.push(part);
                    let Ok(m) = fs::symlink_metadata(root.join(&walked)) else {
                        under = Under::Outside;
                        break;
                    };
                    under = under.of(root, &walked, &m);
                }
            }
            walk(root, path, under, &mut entries, &mut limits)?;
        } else if row
            .get(..2)
            .is_some_and(|xy| xy.iter().any(|b| matches!(b, b'R' | b'C')))
        {
            rows.next();
        }
    }
    if limits.start.elapsed() >= limits.budget {
        return Err("Ignored-file inventory timed out; the folder is kept.".into());
    }
    let files = entries.len() as u64;
    let mut bytes = 0u64;
    let mut h = Sha256::new();
    for (name, (size, metadata)) in entries {
        h.update((name.len() as u64).to_le_bytes());
        h.update(name);
        h.update(metadata);
        bytes = bytes
            .checked_add(size)
            .ok_or("Ignored-file sizes overflowed")?;
    }
    Ok(Inventory {
        files,
        bytes,
        hash: format!("{:x}", h.finalize()),
    })
}
