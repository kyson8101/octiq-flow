//! Git equality runs clean filters. Only Restore's output proves raw preservation.
use super::{git, real_dir, redirect};
use sha2::{Digest, Sha256};
use std::{
    collections::{BTreeMap, BTreeSet},
    fs,
    io::Read,
    path::{Path, PathBuf},
    time::{Duration, Instant, SystemTime},
};

const LIMIT: u64 = 512 * 1024 * 1024;
const TIME: Duration = Duration::from_secs(120);

/// Refuse special files and redirects both before opening and on the handle.
/// NONBLOCK prevents a racing replacement with a FIFO from hanging open.
pub(super) fn open_regular(path: &Path) -> Result<fs::File, String> {
    real_dir(path.parent().ok_or("File has no parent")?)?;
    let m = fs::symlink_metadata(path).map_err(|e| e.to_string())?;
    if !m.is_file() || redirect(&m) {
        return Err("Not a regular, non-redirect file".into());
    }
    let mut options = fs::OpenOptions::new();
    options.read(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK);
    }
    #[cfg(windows)]
    {
        use std::os::windows::fs::OpenOptionsExt;
        options.custom_flags(0x00200000);
    }
    let file = options.open(path).map_err(|e| e.to_string())?;
    let m = file.metadata().map_err(|e| e.to_string())?;
    if !m.is_file() || redirect(&m) {
        return Err("Opened file is not a regular, non-redirect file".into());
    }
    Ok(file)
}

#[derive(Debug, PartialEq, Eq)]
struct Stamp {
    size: u64,
    modified: SystemTime,
    created: Option<SystemTime>,
    kind: (bool, bool, bool),
    #[cfg(unix)]
    changed: (i64, i64),
    #[cfg(windows)]
    changed: i64,
}
fn stamp(path: &Path) -> Result<Option<Stamp>, String> {
    let m = match fs::symlink_metadata(path) {
        Ok(m) => m,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(e) => return Err(e.to_string()),
    };
    real_dir(path.parent().ok_or("File has no parent")?)?;
    #[cfg(unix)]
    use std::os::unix::fs::MetadataExt;
    #[cfg(windows)]
    let changed = windows_change_time(path, &m)?;
    Ok(Some(Stamp {
        size: m.len(),
        modified: m.modified().map_err(|e| e.to_string())?,
        created: m.created().ok(),
        kind: (m.is_file(), m.is_dir(), redirect(&m)),
        #[cfg(unix)]
        changed: (m.ctime(), m.ctime_nsec()),
        #[cfg(windows)]
        changed,
    }))
}
// FILE_BASIC_INFO.ChangeTime is ctime, unlike std's Windows creation_time.
#[cfg(windows)]
fn windows_change_time(path: &Path, _: &fs::Metadata) -> Result<i64, String> {
    use std::os::windows::{fs::OpenOptionsExt, io::AsRawHandle};
    #[repr(C)]
    struct Basic {
        creation: i64,
        access: i64,
        write: i64,
        change: i64,
        attrs: u32,
    }
    #[link(name = "kernel32")]
    unsafe extern "system" {
        fn GetFileInformationByHandleEx(
            handle: *mut std::ffi::c_void,
            class: i32,
            info: *mut std::ffi::c_void,
            size: u32,
        ) -> i32;
    }
    let f = fs::OpenOptions::new()
        .access_mode(0x80)
        .share_mode(7)
        .custom_flags(0x02200000)
        .open(path)
        .map_err(|e| e.to_string())?;
    let mut b = Basic {
        creation: 0,
        access: 0,
        write: 0,
        change: 0,
        attrs: 0,
    };
    if unsafe {
        GetFileInformationByHandleEx(
            f.as_raw_handle(),
            0,
            (&mut b as *mut Basic).cast(),
            std::mem::size_of::<Basic>() as u32,
        )
    } == 0
    {
        return Err(std::io::Error::last_os_error().to_string());
    }
    Ok(b.change)
}

#[derive(Debug, PartialEq, Eq)]
pub(super) struct Stamps(BTreeMap<PathBuf, Option<Stamp>>);
impl Stamps {
    pub fn capture(root: &str) -> Result<Self, String> {
        let start = Instant::now();
        let paths = git::git(
            root,
            &[
                "ls-files",
                "--cached",
                "--others",
                "--exclude-standard",
                "-z",
            ],
        )?;
        let mut result = BTreeMap::new();
        for name in paths.split(|b| *b == 0).filter(|b| !b.is_empty()) {
            if result.len() >= 100_000 || start.elapsed() >= Duration::from_secs(10) {
                return Err("File stamp inventory reached its final bound; folder kept.".into());
            }
            let p = Path::new(root).join(std::str::from_utf8(name).map_err(|e| e.to_string())?);
            result.insert(p.clone(), stamp(&p)?);
        }
        Ok(Self(result))
    }
    pub fn verify(&self, root: &str) -> Result<(), String> {
        let after = Self::capture(root)?;
        if after != *self {
            return Err("File inventory, size, mtime or ctime changed during comparison; the archive and folder are kept.".into());
        }
        Ok(())
    }
}

#[derive(Default)]
pub(super) struct Proof {
    pub hidden: usize,
    pub unrestorable: usize,
}

/// Automatic checks only attributes/autocrlf and hidden index bits. Archive
/// checks every tree entry (including every changed/untracked file captured).
/// One check-attr pass covers all tracked paths; an ordinary worktree performs
/// no per-file content/Git reads here.
pub(super) fn verify(root: &str, reference: &str, archive: bool) -> Result<Proof, String> {
    let start = Instant::now();
    let run = |args: &[&str]| git::git_bounded(root, args, TIME.saturating_sub(start.elapsed()));
    let listed = run(&["ls-files", "-v", "-z"])?;
    let mut tracked = BTreeSet::new();
    let mut hidden = BTreeSet::new();
    let mut input = Vec::new();
    for row in listed.split(|b| *b == 0).filter(|b| !b.is_empty()) {
        if row.len() < 3 || row[1] != b' ' {
            return Err("Unknown ls-files index flags; folder kept.".into());
        }
        let name = std::str::from_utf8(&row[2..])
            .map_err(|e| e.to_string())?
            .to_owned();
        if row[0].is_ascii_lowercase() || row[0] == b'S' {
            hidden.insert(name.clone());
        }
        input.extend_from_slice(&row[2..]);
        input.push(0);
        tracked.insert(name);
    }
    let attrs = git::git_io(
        root,
        &["check-attr", "-z", "--stdin", "filter", "text", "eol"],
        TIME.saturating_sub(start.elapsed()),
        Some(input),
        32 * 1024 * 1024,
    )?;
    let config = run(&["config", "--list", "--null"])?;
    let autocrlf = config
        .split(|b| *b == 0)
        .filter_map(|v| std::str::from_utf8(v).ok())
        .filter_map(|v| v.split_once('\n'))
        .filter(|(k, _)| k.eq_ignore_ascii_case("core.autocrlf"))
        .last()
        .is_some_and(|(_, v)| !v.eq_ignore_ascii_case("false"));
    let mut selected = hidden.clone();
    if archive {
        let tree = run(&["ls-tree", "-r", "--name-only", "-z", reference])?;
        for name in tree.split(|b| *b == 0).filter(|b| !b.is_empty()) {
            selected.insert(
                std::str::from_utf8(name)
                    .map_err(|e| e.to_string())?
                    .to_owned(),
            );
        }
    } else if autocrlf {
        selected.extend(tracked);
    }
    let fields: Vec<_> = attrs.split(|b| *b == 0).filter(|b| !b.is_empty()).collect();
    if fields.len() % 3 != 0 {
        return Err("Incomplete check-attr output; folder kept.".into());
    }
    for a in fields.chunks(3) {
        if a[2] != b"unspecified" {
            selected.insert(
                std::str::from_utf8(a[0])
                    .map_err(|e| e.to_string())?
                    .to_owned(),
            );
        }
    }
    if archive {
        // Deleted tracked paths have no on-disk bytes in the archive; neither
        // attributes nor old hidden index bits turn a deletion into a file.
        let tree = run(&["ls-tree", "-r", "--name-only", "-z", reference])?;
        let names: BTreeSet<_> = tree
            .split(|b| *b == 0)
            .filter_map(|n| std::str::from_utf8(n).ok())
            .collect();
        selected.retain(|n| names.contains(n.as_str()));
    }
    let mut bytes = 0u64;
    let mut proof = Proof::default();
    for name in selected {
        if start.elapsed() >= TIME {
            return Err(
                "Raw Restore comparison reached its 512 MiB / 120 s bound; folder kept.".into(),
            );
        }
        let p = Path::new(root).join(&name);
        // Missing sparse entries have no on-disk bytes to lose.
        let metadata = fs::symlink_metadata(&p);
        if !archive
            && metadata
                .as_ref()
                .is_err_and(|e| e.kind() == std::io::ErrorKind::NotFound)
        {
            continue;
        }
        let equal = (|| -> Result<bool, String> {
            let m = metadata.map_err(|e| e.to_string())?;
            real_dir(p.parent().ok_or("Missing file parent")?)?;
            let mut disk = Sha256::new();
            let mut disk_len = 0u64;
            if m.file_type().is_symlink() {
                let link = fs::read_link(&p).map_err(|e| e.to_string())?;
                let link = link.to_str().ok_or("Link is not UTF-8")?.as_bytes();
                disk.update(link);
                disk_len = link.len() as u64;
                bytes = bytes.saturating_add(disk_len);
                if bytes > LIMIT {
                    return Err(
                        "Raw Restore comparison reached its 512 MiB / 120 s bound; folder kept."
                            .into(),
                    );
                }
            } else {
                let mut f = open_regular(&p)?;
                if bytes.saturating_add(m.len()) > LIMIT {
                    return Err(
                        "Raw Restore comparison reached its 512 MiB / 120 s bound; folder kept."
                            .into(),
                    );
                }
                let mut buffer = [0; 65536];
                loop {
                    if start.elapsed() >= TIME || bytes > LIMIT {
                        return Err("Raw Restore comparison reached its 512 MiB / 120 s bound; folder kept.".into());
                    }
                    let n = f.read(&mut buffer).map_err(|e| e.to_string())?;
                    if n == 0 {
                        break;
                    }
                    disk.update(&buffer[..n]);
                    disk_len += n as u64;
                    bytes += n as u64;
                }
            }
            let spec = format!("{reference}:{name}");
            let filter_path = format!("--path={name}");
            let args = if m.file_type().is_symlink() {
                vec!["cat-file", "blob", &spec]
            } else {
                vec!["cat-file", "--filters", &filter_path, &spec]
            };
            let output = git::git_io(
                root,
                &args,
                TIME.saturating_sub(start.elapsed()),
                None,
                LIMIT.saturating_sub(bytes) as usize,
            )?;
            bytes += output.len() as u64;
            if bytes > LIMIT || start.elapsed() >= TIME {
                return Err(
                    "Raw Restore comparison reached its 512 MiB / 120 s bound; folder kept.".into(),
                );
            }
            Ok(disk_len == output.len() as u64
                && disk.finalize()[..] == Sha256::digest(&output)[..])
        })();
        match equal {
            Ok(true) => {}
            Err(e)
                if e.contains("bound") || e.contains("timed out") || e.contains("safety limit") =>
            {
                return Err(format!(
                    "Raw Restore comparison incomplete: {e}; folder kept."
                ))
            }
            _ => {
                proof.unrestorable += 1;
                if hidden.contains(&name) {
                    proof.hidden += 1;
                }
            }
        }
    }
    Ok(proof)
}
