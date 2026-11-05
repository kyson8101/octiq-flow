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

const LIMIT: u64 = 2 * 1024 * 1024 * 1024;
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

#[derive(Clone, Debug, PartialEq, Eq)]
struct Stamp {
    size: u64,
    modified: SystemTime,
    created: Option<SystemTime>,
    kind: (bool, bool, bool),
    executable: bool,
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
        executable: executable(&m),
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

#[derive(Debug, PartialEq, Eq, Clone)]
pub(super) struct Stamps(BTreeMap<PathBuf, Option<Stamp>>);
impl Stamps {
    pub fn capture(root: &str) -> Result<Self, String> {
        let start = Instant::now();
        let budget = git::remaining(Duration::from_secs(10))?;
        let paths = git::git_bounded(
            root,
            &[
                "ls-files",
                "--cached",
                "--others",
                "--exclude-standard",
                "-z",
            ],
            Duration::from_secs(10),
        )?;
        let mut result = BTreeMap::new();
        for name in paths.split(|b| *b == 0).filter(|b| !b.is_empty()) {
            if result.len() >= 100_000 || start.elapsed() >= budget {
                return Err("File stamp inventory reached its final bound; folder kept.".into());
            }
            let p = Path::new(root).join(std::str::from_utf8(name).map_err(|e| e.to_string())?);
            result.insert(p.clone(), stamp(&p)?);
        }
        let config = config_path(root, budget.saturating_sub(start.elapsed()))?;
        result.insert(config.clone(), stamp(&config)?);
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

fn config_path(root: &str, timeout: Duration) -> Result<PathBuf, String> {
    let started = Instant::now();
    let budget = git::remaining(timeout)?;
    let dot_git = Path::new(root).join(".git");
    let meta = fs::symlink_metadata(&dot_git).map_err(|e| {
        format!("Cannot inspect Git admin path for config.worktree: {e}; folder kept.")
    })?;
    // rev-parse --git-path can resolve the final symlink, and Git may read
    // config.worktree before answering any command. Read the regular gitdir
    // pointer directly so the guard precedes Git and never follows a redirect.
    let admin = if meta.is_dir() && !redirect(&meta) {
        dot_git
    } else {
        let file = open_regular(&dot_git).map_err(|e| {
            format!("Cannot safely read Git pointer for config.worktree: {e}; folder kept.")
        })?;
        let mut bytes = Vec::new();
        file.take(65537)
            .read_to_end(&mut bytes)
            .map_err(|e| e.to_string())?;
        if bytes.len() > 65536 {
            return Err("Git pointer for config.worktree exceeded its bound; folder kept.".into());
        }
        let text = std::str::from_utf8(&bytes).map_err(|e| e.to_string())?;
        let text = text.strip_suffix('\n').unwrap_or(text);
        let text = text.strip_suffix('\r').unwrap_or(text);
        let path = text
            .strip_prefix("gitdir: ")
            .ok_or("Unknown Git pointer for config.worktree; folder kept.")?;
        if path.is_empty() || path.contains(['\n', '\r']) {
            return Err("Cannot carry Git pointer for config.worktree; folder kept.".into());
        }
        let path = PathBuf::from(path);
        if path.is_absolute() {
            path
        } else {
            Path::new(root).join(path)
        }
    };
    real_dir(&admin)?;
    if started.elapsed() >= budget {
        return Err("Config metadata reached its remaining bound; folder kept.".into());
    }
    Ok(admin.join("config.worktree"))
}
fn require_recreatable_config(root: &str, timeout: Duration) -> Result<(), String> {
    let path = config_path(root, timeout)?;
    match fs::symlink_metadata(&path) {
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(e) => return Err(format!("Cannot inspect config.worktree: {e}; folder kept.")),
        Ok(_) => {}
    }
    let mut file = open_regular(&path)
        .map_err(|e| format!("Cannot safely read config.worktree: {e}; folder kept."))?;
    let mut byte = [0u8];
    if file
        .read(&mut byte)
        .map_err(|e| format!("Cannot read config.worktree: {e}; folder kept."))?
        != 0
    {
        return Err("Non-empty config.worktree settings cannot be recreated by Restore and were not proven; folder kept.".into());
    }
    Ok(())
}

#[derive(Clone, Default)]
pub(super) struct Proof {
    pub hidden: usize,
    pub unrestorable: usize,
    pub path: Option<String>,
}
impl Proof {
    fn mismatch(name: &str, hidden: &BTreeSet<String>) -> Self {
        Self {
            unrestorable: 1,
            hidden: usize::from(hidden.contains(name)),
            path: Some(name.to_owned()),
        }
    }
    pub fn reason(&self) -> String {
        format!("At least 1 tracked file cannot be restored byte for byte with its effective mode: {:?} ({} edited assume-unchanged/skip-worktree files); the folder is kept.", self.path.as_deref().unwrap_or("unknown"), self.hidden)
    }
}
fn executable(m: &fs::Metadata) -> bool {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        m.permissions().mode() & 0o111 != 0
    }
    #[cfg(not(unix))]
    {
        let _ = m;
        false
    }
}
fn mode_matches(mode: &str, m: &fs::Metadata, is_windows: bool, symlinks: bool) -> bool {
    match mode {
        "100644" | "100755" => {
            m.is_file() && !redirect(m) && (is_windows || executable(m) == (mode == "100755"))
        }
        "120000" => {
            m.file_type().is_symlink()
                || (!symlinks && m.is_file() && !redirect(m) && (is_windows || !executable(m)))
        }
        _ => false, // A gitlink with anything on disk is never proven.
    }
}
fn supports_restore_attributes(version: &[u8]) -> bool {
    let version = std::str::from_utf8(version)
        .ok()
        .and_then(|v| v.strip_prefix("git version "))
        .unwrap_or("");
    let parts: Vec<_> = version.split('.').take(2).map(str::parse::<u32>).collect();
    matches!(parts.as_slice(), [Ok(major), Ok(minor)] if (*major, *minor) >= (2, 41))
}
struct Entry {
    name: String,
    oid: String,
    raw: bool,
    len: u64,
    link: Option<Vec<u8>>,
}
fn bound() -> String {
    "Raw Restore comparison reached its 2 GiB / 120 s bound; folder kept.".into()
}

/// Every non-Archive removal proves EVERY kept-tree path, without attributes,
/// autocrlf or hidden-bit selection: raw disk bytes must equal Restore's filters
/// output (raw blob for 120000), and effective type/Unix executable bit must
/// equal the tree mode, ignoring core.filemode. Missing sparse entries are OK;
/// extra/unmerged index entries are not. Archive checks all its captured paths
/// with the same mode rule. One streaming filtered batch and, when needed, one
/// raw symlink batch replace per-file processes. The total input/output budget
/// is 2 GiB / 120 s, outside lifecycle. Only observe_hidden selects hidden paths;
/// the full proof runs exclusively when a folder is about to be removed.
pub(super) fn verify(
    root: &str,
    reference: &str,
    archive: bool,
    is_windows: bool,
) -> Result<Proof, String> {
    verify_selected(root, reference, archive, is_windows, false)
}
pub(super) fn observe_hidden(
    root: &str,
    reference: &str,
    is_windows: bool,
) -> Result<Proof, String> {
    verify_selected(root, reference, false, is_windows, true)
}
#[cfg(test)]
thread_local! { pub(super) static TEST_LIMIT: std::cell::Cell<Option<u64>> = const {std::cell::Cell::new(None)}; }
fn verify_selected(
    root: &str,
    reference: &str,
    archive: bool,
    is_windows: bool,
    hidden_only: bool,
) -> Result<Proof, String> {
    #[cfg(test)]
    let limit = TEST_LIMIT.with(|v| v.get().unwrap_or(LIMIT));
    #[cfg(not(test))]
    let limit = LIMIT;
    verify_with_budget(
        root,
        reference,
        archive,
        is_windows,
        hidden_only,
        TIME,
        limit,
    )
}
fn verify_with_budget(
    root: &str,
    reference: &str,
    archive: bool,
    is_windows: bool,
    hidden_only: bool,
    timeout: Duration,
    limit: u64,
) -> Result<Proof, String> {
    let start = Instant::now();
    let remaining = || timeout.checked_sub(start.elapsed()).ok_or_else(bound);
    let run = |args: &[&str]| git::git_bounded(root, args, remaining()?);
    require_recreatable_config(root, remaining()?)?;
    let listed = run(&["ls-files", "-v", "--stage", "-z"])?;
    let mut hidden = BTreeSet::new();
    let mut index = Vec::new();
    for row in listed.split(|b| *b == 0).filter(|b| !b.is_empty()) {
        let (header, name) = row.split_at(
            row.iter()
                .position(|b| *b == b'\t')
                .ok_or("Unknown index output; folder kept.")?,
        );
        let fields: Vec<_> = header.split(|b| *b == b' ').collect();
        if fields.len() != 4 || fields[0].len() != 1 {
            return Err("Unknown index flags; folder kept.".into());
        }
        let name = std::str::from_utf8(&name[1..])
            .map_err(|e| e.to_string())?
            .to_owned();
        if fields[0][0].is_ascii_lowercase() || fields[0] == b"S" {
            hidden.insert(name.clone());
        }
        index.push((name, fields[3] != b"0"));
    }
    if hidden_only && hidden.is_empty() {
        return Ok(Proof::default());
    }
    let version = run(&["--version"])?;
    if !supports_restore_attributes(&version) {
        return Err(format!("Cannot confirm kept-ref attributes with {}; Git 2.41+ is required for Restore proof; folder kept.", String::from_utf8_lossy(&version).trim()));
    }
    let tree = run(&["ls-tree", "-r", "-z", reference])?;
    let mut entries = BTreeMap::new();
    for row in tree.split(|b| *b == 0).filter(|b| !b.is_empty()) {
        let tab = row
            .iter()
            .position(|b| *b == b'\t')
            .ok_or("Unknown tree output; folder kept.")?;
        let header = std::str::from_utf8(&row[..tab]).map_err(|e| e.to_string())?;
        let fields: Vec<_> = header.split(' ').collect();
        if fields.len() != 3 {
            return Err("Unknown tree entry; folder kept.".into());
        }
        let name = std::str::from_utf8(&row[tab + 1..])
            .map_err(|e| e.to_string())?
            .to_owned();
        entries.insert(name, (fields[0].to_owned(), fields[2].to_owned()));
    }
    if !archive {
        for (name, unmerged) in index {
            if (!hidden_only || hidden.contains(&name))
                && (unmerged || !entries.contains_key(&name))
            {
                return Ok(Proof::mismatch(&name, &hidden));
            }
        }
    }
    let symlinks = run(&["config", "--bool", "core.symlinks"])
        .map(|v| v != b"false\n")
        .unwrap_or(true);
    let mut filtered = Vec::new();
    let mut links = Vec::new();
    let mut bytes = 0u64;
    for (name, (mode, oid)) in entries {
        remaining()?;
        if hidden_only && !hidden.contains(&name) {
            continue;
        }
        // Batch splits oid from the path on whitespace. Never silently carry
        // a different filter path when Git strips leading whitespace.
        if name.as_bytes().first().is_some_and(u8::is_ascii_whitespace) {
            return Err(format!(
                "Batch cannot carry the leading-whitespace filter path {name:?}; folder kept."
            ));
        }
        let p = Path::new(root).join(&name);
        let m = match fs::symlink_metadata(&p) {
            Ok(m) => m,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound && !archive => continue,
            Err(e) => return Err(format!("Cannot read {name:?}: {e}; folder kept.")),
        };
        real_dir(p.parent().ok_or("Missing file parent")?)?;
        if !mode_matches(&mode, &m, is_windows, symlinks) {
            return Ok(Proof::mismatch(&name, &hidden));
        }
        let link = if m.file_type().is_symlink() {
            let target = fs::read_link(&p).map_err(|e| e.to_string())?;
            #[cfg(unix)]
            {
                use std::os::unix::ffi::OsStrExt;
                Some(target.as_os_str().as_bytes().to_vec())
            }
            #[cfg(not(unix))]
            {
                Some(
                    target
                        .to_str()
                        .ok_or("Link is not UTF-8; folder kept.")?
                        .as_bytes()
                        .to_vec(),
                )
            }
        } else {
            None
        };
        let len = link.as_ref().map_or(m.len(), |v| v.len() as u64);
        bytes = bytes
            .checked_add(len.checked_mul(2).ok_or_else(bound)?)
            .ok_or_else(bound)?;
        if bytes > limit {
            return Err(bound());
        }
        let entry = Entry {
            name,
            oid,
            raw: mode == "120000",
            len,
            link,
        };
        if entry.raw {
            links.push(entry);
        } else {
            filtered.push(entry);
        }
    }
    for (entries, filters) in [(filtered, true), (links, false)] {
        if entries.is_empty() {
            continue;
        }
        if let Some(name) = batch(root, reference, entries, filters, remaining()?)? {
            return Ok(Proof::mismatch(&name, &hidden));
        }
    }
    Ok(Proof::default())
}

// --batch --filters reports the ORIGINAL blob size even for converted output
// (Git 2.45.1 and 2.54.0). Do not trust that size or scan for a later marker.
// Read exactly the disk length, streaming both sides, then the framing LF and
// the nonce's missing-object response at that exact offset. Stop/kill on the
// first mismatch; no resynchronisation can prove another file after it.
fn batch(
    root: &str,
    reference: &str,
    entries: Vec<Entry>,
    filters: bool,
    timeout: Duration,
) -> Result<Option<String>, String> {
    use std::io::{BufRead, BufReader, Write};
    let started = Instant::now();
    let attr_source = format!("--attr-source={reference}");
    let mut args = vec![attr_source.as_str(), "cat-file", "--batch", "-z"];
    if filters {
        args.push("--filters");
    }
    let mut cmd = git::git_command(root, &args);
    // A sparse/missing attributes file on disk is not what Restore reads.
    // The recognized global option also makes unsupported Git fail explicitly,
    // rather than silently ignoring an unfamiliar GIT_ATTR_SOURCE variable.
    cmd.env("GIT_ATTR_SOURCE", reference);
    let mut process = BatchProcess::spawn(&mut cmd)?;
    let mut input = process.child.stdin.take().ok_or("Missing batch stdin")?;
    let output = process.child.stdout.take().ok_or("Missing batch stdout")?;
    let errors = process.child.stderr.take().ok_or("Missing batch stderr")?;
    let (err_tx, err_rx) = std::sync::mpsc::sync_channel(1);
    std::thread::spawn(move || {
        let mut data = Vec::new();
        let result = errors.take(65537).read_to_end(&mut data);
        let _ = err_tx.send((result.is_ok(), data));
    });
    let root = root.to_owned();
    let (tx, rx) = std::sync::mpsc::sync_channel(1);
    std::thread::spawn(move || {
        let result = (|| -> Result<Option<String>, String> {
            let mut out = BufReader::with_capacity(65536, output);
            let nonce = format!("octiq-proof-{}", uuid::Uuid::new_v4().simple());
            let marker = format!("\n{nonce} missing\n");
            for entry in entries {
                let request = if filters {
                    format!("{} {}\0{nonce}\0", entry.oid, entry.name)
                } else {
                    format!("{}\0{nonce}\0", entry.oid)
                };
                input
                    .write_all(request.as_bytes())
                    .map_err(|e| e.to_string())?;
                input.flush().map_err(|e| e.to_string())?;
                let mut header = Vec::new();
                out.by_ref()
                    .take(1024)
                    .read_until(b'\n', &mut header)
                    .map_err(|e| e.to_string())?;
                if !header.starts_with(format!("{} blob ", entry.oid).as_bytes())
                    || !header.ends_with(b"\n")
                {
                    return Err(format!(
                        "Restore filter/batch protocol failed for {:?}; folder kept.",
                        entry.name
                    ));
                }
                let mut disk: Box<dyn Read> = if let Some(link) = entry.link {
                    Box::new(std::io::Cursor::new(link))
                } else {
                    Box::new(open_regular(&Path::new(&root).join(&entry.name))?)
                };
                let mut left = entry.len;
                let (mut actual_hash, mut disk_hash) = (Sha256::new(), Sha256::new());
                let (mut actual, mut expected) = ([0u8; 65536], [0u8; 65536]);
                while left > 0 {
                    let n = out
                        .read(&mut actual[..left.min(65536) as usize])
                        .map_err(|e| e.to_string())?;
                    if n == 0
                        || disk.read_exact(&mut expected[..n]).is_err()
                        || actual[..n] != expected[..n]
                    {
                        return Ok(Some(entry.name));
                    }
                    actual_hash.update(&actual[..n]);
                    disk_hash.update(&expected[..n]);
                    left -= n as u64;
                }
                let mut frame = vec![0; marker.len()];
                if out.read_exact(&mut frame).is_err() || frame != marker.as_bytes() {
                    return Ok(Some(entry.name));
                }
                if actual_hash.finalize() != disk_hash.finalize()
                    || disk.read(&mut expected[..1]).map_err(|e| e.to_string())? != 0
                {
                    return Ok(Some(entry.name));
                }
            }
            drop(input);
            let mut tail = [0];
            if out.read(&mut tail).map_err(|e| e.to_string())? != 0 {
                return Err("Unexpected trailing batch output; folder kept.".into());
            }
            Ok(None)
        })();
        let _ = tx.send(result);
    });
    let result = rx
        .recv_timeout(timeout.saturating_sub(started.elapsed()))
        .map_err(|_| bound())?;
    // A mismatch ends the proof now. Drop kills Git and all filter children.
    if matches!(result, Ok(Some(_)) | Err(_)) {
        return result;
    }
    let (ok, errors) = err_rx
        .recv_timeout(timeout.saturating_sub(started.elapsed()))
        .map_err(|_| bound())?;
    let status = loop {
        if let Some(status) = process.child.try_wait().map_err(|e| e.to_string())? {
            break Some(status);
        }
        if started.elapsed() >= timeout {
            return Err(bound());
        }
        std::thread::sleep(Duration::from_millis(2));
    };
    if !ok || !errors.is_empty() || !status.is_some_and(|s| s.success()) {
        return Err(format!(
            "Restore filter/batch failed: {}; folder kept.",
            String::from_utf8_lossy(&errors)
        ));
    }
    result
}

/// Own the child AND its filter descendants from spawn to every exit path.
struct BatchProcess {
    child: std::process::Child,
    #[cfg(windows)]
    job: *mut std::ffi::c_void,
}
impl BatchProcess {
    fn spawn(cmd: &mut std::process::Command) -> Result<Self, String> {
        use std::process::Stdio;
        crate::proc::no_console(cmd);
        #[cfg(unix)]
        {
            use std::os::unix::process::CommandExt;
            cmd.process_group(0);
        }
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            cmd.creation_flags(0x08000004);
        } // suspended, no console
        #[allow(unused_mut)] // Windows may kill a suspended child on job setup failure.
        let mut child = cmd
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .map_err(|e| e.to_string())?;
        #[cfg(windows)]
        {
            use std::os::windows::io::AsRawHandle;
            let job = unsafe { win_batch::CreateJobObjectW(std::ptr::null(), std::ptr::null()) };
            if job.is_null()
                || unsafe { win_batch::AssignProcessToJobObject(job, child.as_raw_handle()) } == 0
                || unsafe { win_batch::NtResumeProcess(child.as_raw_handle()) } < 0
            {
                let error = std::io::Error::last_os_error().to_string();
                let _ = child.kill();
                let _ = child.wait();
                if !job.is_null() {
                    unsafe {
                        win_batch::TerminateJobObject(job, 1);
                        win_batch::CloseHandle(job);
                    }
                }
                return Err(format!(
                    "Cannot contain Restore filter process: {error}; folder kept."
                ));
            }
            return Ok(Self { child, job });
        }
        #[cfg(not(windows))]
        Ok(Self { child })
    }
}
impl Drop for BatchProcess {
    fn drop(&mut self) {
        #[cfg(unix)]
        unsafe {
            libc::kill(-(self.child.id() as i32), libc::SIGKILL);
        }
        #[cfg(windows)]
        unsafe {
            win_batch::TerminateJobObject(self.job, 1);
            win_batch::CloseHandle(self.job);
        }
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}
#[cfg(windows)]
mod win_batch {
    use std::ffi::c_void;
    #[link(name = "kernel32")]
    unsafe extern "system" {
        pub fn CreateJobObjectW(attributes: *const c_void, name: *const u16) -> *mut c_void;
        pub fn AssignProcessToJobObject(job: *mut c_void, process: *mut c_void) -> i32;
        pub fn TerminateJobObject(job: *mut c_void, exit_code: u32) -> i32;
        pub fn CloseHandle(handle: *mut c_void) -> i32;
    }
    #[link(name = "ntdll")]
    unsafe extern "system" {
        pub fn NtResumeProcess(process: *mut c_void) -> i32;
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::git_ops::workflow::tests::Repo;

    #[test]
    fn raw_budget_is_two_gib_and_a_bound_is_an_unknown_keep() {
        assert_eq!(LIMIT, 2 * 1024 * 1024 * 1024);
        let r = Repo::new();
        let error = verify_with_budget(&r.root, "HEAD", false, cfg!(windows), false, TIME, 1)
            .err()
            .unwrap();
        assert!(error.contains("2 GiB / 120 s bound") && error.contains("kept"));
    }

    #[test]
    fn oversized_filtered_output_must_not_find_a_marker_at_a_later_offset() {
        let r = Repo::new();
        fs::write(
            Path::new(&r.root).join(".gitattributes"),
            "source.txt filter=overflow\n",
        )
        .unwrap();
        // The expected bytes are an exact prefix. Accepting a later marker
        // would incorrectly call this restorable. No large Vec is allocated.
        r.git(&["add", ".gitattributes"]);
        r.git(&["commit", "-m", "kept overflow attributes"]);
        r.git(&[
            "config",
            "filter.overflow.smudge",
            "cat; yes X | head -c 4194304",
        ]);
        let start = Instant::now();
        let proof = verify_with_budget(
            &r.root,
            "HEAD",
            false,
            cfg!(windows),
            false,
            Duration::from_secs(10),
            LIMIT,
        )
        .unwrap();
        assert_eq!(proof.path.as_deref(), Some("source.txt"));
        assert_eq!(proof.unrestorable, 1);
        assert!(start.elapsed() < Duration::from_secs(5));
    }

    #[test]
    fn hung_filter_and_its_child_are_killed_at_the_remaining_deadline() {
        let r = Repo::new();
        let escaped = r.dir.join("escaped-child");
        fs::write(
            Path::new(&r.root).join(".gitattributes"),
            "source.txt filter=hung\n",
        )
        .unwrap();
        r.git(&["add", ".gitattributes"]);
        r.git(&["commit", "-m", "kept hung attributes"]);
        let script = format!(
            "(sleep 4; echo escaped > '{}') & wait; cat",
            escaped.to_string_lossy().replace('\\', "/")
        );
        r.git(&["config", "filter.hung.smudge", &script]);
        let started = Instant::now();
        let error = verify_with_budget(
            &r.root,
            "HEAD",
            false,
            cfg!(windows),
            false,
            Duration::from_secs(1),
            LIMIT,
        )
        .err()
        .unwrap();
        assert!(error.contains("bound"), "{error}");
        assert!(started.elapsed() < Duration::from_secs(2));
        std::thread::sleep(Duration::from_millis(4500));
        assert!(
            !escaped.exists(),
            "a descendant escaped the filter watchdog"
        );
    }
}

#[cfg(test)]
#[test]
#[ignore = "explicit exact-SHA timing on a fresh disposable clone"]
fn time_full_proof_on_fresh_clone() {
    use crate::test_dir::TestDir;
    let source = std::env::var("OCTIQ_RAW_PROOF_SOURCE").expect("source checkout for timing");
    let home = TestDir::new("raw-timing").canonicalized();
    let target = home.join("clone");
    let status = std::process::Command::new("git")
        .args([
            "clone",
            "--quiet",
            "--no-local",
            "--depth=1",
            &source,
            target.to_str().unwrap(),
        ])
        .status()
        .unwrap();
    assert!(status.success());
    let root = target.to_str().unwrap();
    let head = git::text(root, &["rev-parse", "HEAD"]).unwrap();
    let paths = git::git(root, &["ls-tree", "-r", "-z", "--name-only", "HEAD"]).unwrap();
    let start = Instant::now();
    let proof = verify(root, &head, false, cfg!(windows)).unwrap();
    println!(
        "FULL_PROOF_TIMING sha={head} paths={} seconds={:.6}",
        paths.split(|b| *b == 0).filter(|p| !p.is_empty()).count(),
        start.elapsed().as_secs_f64()
    );
    assert_eq!(proof.unrestorable, 0);
}
