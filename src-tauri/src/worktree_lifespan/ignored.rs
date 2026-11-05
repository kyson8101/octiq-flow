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
    if name == ".DS_Store" || name.ends_with(".log") {
        return true;
    }
    let parent = root.join(relative.parent().unwrap_or(Path::new("")));
    if (name.ends_with(".tsbuildinfo") || name == "pnpm-workspace.yaml")
        && marker(&parent, "package.json")
    {
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
                Some("node_modules" | "dist" | ".astro") => marker(&parent, "package.json"),
                _ => false,
            }
        })
}

pub(super) fn inventory(root: &str) -> Result<Inventory, String> {
    bounded(root, Duration::from_secs(15), 100_000)
}

pub(super) fn bounded(
    root: &str,
    budget: Duration,
    max_entries: usize,
) -> Result<Inventory, String> {
    let start = Instant::now();
    let bytes = git::git(
        root,
        &[
            "status",
            "--porcelain=v1",
            "-z",
            "--ignored=traditional",
            "--untracked-files=all",
        ],
    )?;
    from_status(Path::new(root), &bytes, start, budget, max_entries)
}

fn from_status(
    root: &Path,
    status: &[u8],
    start: Instant,
    budget: Duration,
    max_entries: usize,
) -> Result<Inventory, String> {
    let mut entries = BTreeMap::new();
    let mut visited = 0usize;
    fn walk(
        root: &Path,
        relative: &Path,
        entries: &mut BTreeMap<Vec<u8>, (u64, Vec<u8>)>,
        visited: &mut usize,
        start: Instant,
        budget: Duration,
        max: usize,
    ) -> Result<(), String> {
        *visited += 1;
        if *visited > max || relative.components().count() > 256 || start.elapsed() >= budget {
            return Err(
                "Ignored-file inventory reached its time or entry limit; the folder is kept."
                    .into(),
            );
        }
        let path = root.join(relative);
        real_dir(path.parent().ok_or("Ignored path has no parent")?)?;
        let m = fs::symlink_metadata(&path).map_err(|e| e.to_string())?;
        if m.is_dir() && !redirect(&m) {
            for entry in fs::read_dir(&path).map_err(|e| e.to_string())? {
                let entry = entry.map_err(|e| e.to_string())?;
                walk(
                    root,
                    &relative.join(entry.file_name()),
                    entries,
                    visited,
                    start,
                    budget,
                    max,
                )?;
            }
        } else if redirect(&m) || !rebuildable(root, relative) {
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
            walk(
                root,
                path,
                &mut entries,
                &mut visited,
                start,
                budget,
                max_entries,
            )?;
        } else if row
            .get(..2)
            .is_some_and(|xy| xy.iter().any(|b| matches!(b, b'R' | b'C')))
        {
            rows.next();
        }
    }
    if start.elapsed() >= budget {
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
