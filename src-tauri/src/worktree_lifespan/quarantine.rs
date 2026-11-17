//! Quarantine before removal.
//!
//! Every check made before a worktree is removed is a look at a folder that
//! something else can still reach by its path. Enumerating the writers that
//! might (chats, jobs, terminals, a shell that later `cd`s) was tried three
//! times and each round found one more. So the last step is structural: after
//! every final check, still under the workspace lifecycle lock and the path
//! and start claims, the checkout is renamed to a sibling on the same volume
//! (`git worktree move`, which keeps Git's own record consistent). From then
//! on no process can reach it by the old path: a shell above it, a job whose
//! folder is above it, a child nobody registered. What can still touch it is
//! what already holds it open, and that is exactly what `lsof` is asked about
//! on the new name, before the content proof is made again there and Git
//! removes it.
//!
//! Anything wrong at any step puts the folder back, or keeps it and says so.
//! Nothing is ever overwritten or merged: Git's move refuses an occupied
//! destination.
use super::{git, now, real_dir, Failed, Services, Sweep, Usage};
use serde::{Deserialize, Serialize};
use std::{
    fs,
    path::{Path, PathBuf},
    sync::Mutex,
};

/// The name every quarantine carries, before its id.
pub(super) const PREFIX: &str = ".octiq-removing-";

/// The durable intent: written (and synced) before the rename and dropped
/// when the folder is removed or put back, so a server killed in between
/// leaves a record that names exactly where the folder is.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct Record {
    pub id: String,
    pub repo: String,
    pub original: String,
    pub quarantine: String,
    pub at: i64,
}

#[cfg(test)]
thread_local! {
    /// The id the next quarantine takes, so a test can occupy its name.
    pub(super) static NEXT_ID: std::cell::RefCell<Option<String>> = const { std::cell::RefCell::new(None) };
}

/// What a finished removal has to say beyond "removed": the old path was made
/// again while the folder was away. Drained by the sweep's report.
static NOTES: Mutex<Vec<(String, String)>> = Mutex::new(Vec::new());
pub(super) fn take_notes() -> Vec<(String, String)> {
    NOTES
        .lock()
        .map(|mut notes| std::mem::take(&mut *notes))
        .unwrap_or_default()
}

fn records_dir() -> PathBuf {
    crate::profile::profile_dir().join("lifespan-quarantine")
}
fn record_path(id: &str) -> PathBuf {
    records_dir().join(format!("{id}.json"))
}
pub(super) fn write_record(record: &Record) -> Result<(), String> {
    crate::profile::available()?;
    let dir = records_dir();
    crate::profile::make_dir(&dir)?;
    let temp = dir.join(format!(".{}.tmp", uuid::Uuid::new_v4().simple()));
    let result = (|| {
        use std::io::Write;
        let mut file = fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&temp)
            .map_err(|e| e.to_string())?;
        file.write_all(&serde_json::to_vec(record).map_err(|e| e.to_string())?)
            .map_err(|e| e.to_string())?;
        file.sync_all().map_err(|e| e.to_string())?;
        crate::profile::available()?;
        fs::rename(&temp, record_path(&record.id)).map_err(|e| e.to_string())?;
        #[cfg(unix)]
        fs::File::open(&dir)
            .and_then(|f| f.sync_all())
            .map_err(|e| e.to_string())?;
        Ok(())
    })();
    if result.is_err() {
        let _ = fs::remove_file(&temp);
    }
    result
}
fn drop_record(id: &str) {
    let _ = fs::remove_file(record_path(id));
}
fn present(path: &str) -> bool {
    fs::symlink_metadata(path).is_ok()
}

/// Whether a quarantine record still names `original` with a folder at its
/// quarantine path: that checkout is not gone, it is aside. Anything this
/// cannot read is a yes (unknown keeps), and a record whose folder is gone
/// (the removal finished, the record was not dropped) is not one.
pub(crate) fn holds(original: &str) -> bool {
    let entries = match fs::read_dir(records_dir()) {
        Ok(entries) => entries,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return false,
        Err(_) => return true,
    };
    for entry in entries {
        let Ok(entry) = entry else { return true };
        let name = entry.file_name().to_string_lossy().into_owned();
        if name.starts_with('.') || !name.ends_with(".json") {
            continue;
        }
        let Ok(bytes) = fs::read(entry.path()) else {
            return true;
        };
        match serde_json::from_slice::<Record>(&bytes) {
            Ok(record) => {
                if Path::new(&record.original) == Path::new(original) && present(&record.quarantine)
                {
                    return true;
                }
            }
            Err(_) => return true,
        }
    }
    false
}

/// The name a quarantine record trusts: the one this host makes, either the
/// folder itself or (when something made that folder first and Git moved the
/// checkout into it) the checkout inside it.
fn name_is_ours(record: &Record) -> bool {
    let ours = format!("{PREFIX}{}", record.id);
    let path = Path::new(&record.quarantine);
    let leaf = |p: &Path| p.file_name().is_some_and(|n| n.to_string_lossy() == ours);
    leaf(path) || path.parent().is_some_and(leaf)
}

#[cfg(test)]
thread_local! {
    /// Runs after the quarantine name was found free and before the move, so
    /// a test can make that name between the two.
    pub(super) static BEFORE_MOVE: std::cell::RefCell<Option<fn(&str)>> = const { std::cell::RefCell::new(None) };
}

/// Whether anything holds the quarantined folder: a working folder or an open
/// file at or below it. Unknown is a yes. The scan runs inside the final
/// budget (`git::command` takes what is left of it), so a slow `lsof` ends in
/// "unknown" rather than in a longer hold of the lock.
fn held(quarantine: &str) -> Result<(), String> {
    // Windows refuses to rename a folder that has a handle open inside it, so
    // the move itself is that check there (and `lsof` does not exist).
    if cfg!(windows) {
        return Ok(());
    }
    let usage = Usage::capture(cfg!(windows));
    if !usage.known {
        return Err("Which processes hold the quarantined folder could not be read".into());
    }
    if usage.using(quarantine) {
        return Err(
            "A process holds the quarantined folder open (a working folder or an open file)".into(),
        );
    }
    Ok(())
}

/// Move `path` aside, prove it again there, and let Git remove it.
/// `verify` is the caller's content proof, asked of the quarantined folder.
/// Every failure puts the folder back (or keeps it where it is) and says what
/// happened; the caller holds the workspace lifecycle lock throughout.
pub(super) fn remove(
    repo: &str,
    path: &str,
    archived: bool,
    verify: &mut dyn FnMut(&str) -> Result<(), String>,
) -> Result<(), String> {
    let parent = Path::new(path)
        .parent()
        .ok_or("The checkout has no parent folder; it is kept.")?;
    real_dir(parent)?;
    #[cfg(test)]
    let id = NEXT_ID
        .with(|id| id.borrow_mut().take())
        .unwrap_or_else(|| uuid::Uuid::new_v4().simple().to_string()[..16].to_string());
    #[cfg(not(test))]
    let id = uuid::Uuid::new_v4().simple().to_string()[..16].to_string();
    let quarantine = parent.join(format!("{PREFIX}{id}"));
    let quarantine = quarantine.to_string_lossy().into_owned();
    if present(&quarantine) {
        return Err(format!(
            "The quarantine name {quarantine} is taken; the folder is kept."
        ));
    }
    let record = Record {
        id,
        repo: repo.into(),
        original: path.into(),
        quarantine,
        at: now(),
    };
    // Recorded before the rename. A record that cannot be written means no
    // rename: nothing may be left that nothing names.
    write_record(&record)
        .map_err(|e| format!("The quarantine could not be recorded ({e}); the folder is kept."))?;
    #[cfg(test)]
    if let Some(hook) = BEFORE_MOVE.with(|hook| hook.borrow_mut().take()) {
        hook(&record.quarantine);
    }
    if let Err(why) = git::move_worktree(repo, path, &record.quarantine) {
        return Err(failed_move(&record, &why));
    }
    // Git moves INTO a destination that is a folder already. If the name was
    // made between the look above and the move, the checkout is inside it:
    // carry on with the real path, never the folder that is not the checkout.
    let record = match inside_destination(record) {
        Ok(record) => record,
        Err(why) => return Err(why),
    };
    if let Err(why) = held(&record.quarantine).and_then(|()| verify(&record.quarantine)) {
        return Err(put_back(&record, &why));
    }
    // The undo has its own bound; so does Git's removal.
    if let Err(why) = git::remove(repo, &record.quarantine, archived) {
        return Err(put_back(
            &record,
            &format!("Git could not remove it: {why}"),
        ));
    }
    let recreated = present(path);
    drop_record(&record.id);
    if recreated {
        let why = format!(
            "Removed, but something made {path} again while the folder was away. It was not touched: look at what is there."
        );
        eprintln!("[worktree-lifespan] {why}");
        if let Ok(mut notes) = NOTES.lock() {
            notes.push((path.to_string(), why));
        }
    }
    Ok(())
}

/// Where the checkout really is after a move whose destination may already
/// have been a folder. The record is rewritten to the real path before any
/// further step, so a crash leaves a record that names the checkout; if that
/// cannot be written the checkout goes back. Nothing is deleted or overwritten
/// and the folder someone made is left as it is.
fn inside_destination(record: Record) -> Result<Record, String> {
    if present(&format!("{}/.git", record.quarantine)) {
        return Ok(record);
    }
    let Some(leaf) = Path::new(&record.original).file_name() else {
        return Ok(record);
    };
    let nested = Path::new(&record.quarantine).join(leaf);
    let nested = nested.to_string_lossy().into_owned();
    if !present(&format!("{nested}/.git")) {
        return Ok(record);
    }
    let inside = Record {
        quarantine: nested,
        ..record
    };
    match write_record(&inside) {
        Ok(()) => Ok(inside),
        Err(e) => Err(put_back(
            &inside,
            &format!("The quarantine name was made just before the move and the new record could not be written ({e})"),
        )),
    }
}

/// Git's move failed (a different volume, an occupied name, a locked
/// worktree, a handle the system will not let go of, a timeout): find out
/// where the folder is rather than guess.
fn failed_move(record: &Record, why: &str) -> String {
    match (present(&record.original), present(&record.quarantine)) {
        (true, false) => {
            drop_record(&record.id);
            format!("The folder could not be moved aside ({why}); it is kept where it was.")
        }
        (false, true) => put_back(record, &format!("The move did not finish cleanly ({why})")),
        _ => format!(
            "The folder could not be moved aside ({why}) and its place could not be confirmed; it is kept, and the quarantine record {} names it.",
            record.id
        ),
    }
}

/// Put a quarantined folder back at its original path, never over anything.
/// Always answers the sentence the caller returns.
fn put_back(record: &Record, why: &str) -> String {
    match restore(record) {
        Ok(()) => format!("{why}; the folder was put back and kept."),
        Err(e) => format!(
            "{why}; the folder could not be put back ({e}). It stays at {} and the host tries again at its next sweep; nothing was removed.",
            record.quarantine
        ),
    }
}

/// `git worktree move` back. An occupied original is never overwritten or
/// merged into: the quarantine stays where it is.
fn restore(record: &Record) -> Result<(), String> {
    if present(&record.original) {
        return Err(format!(
            "{} was made again and is not touched",
            record.original
        ));
    }
    // The undo is not skipped for want of final-budget time.
    git::unbudgeted(|| {
        let moved = git::move_worktree(&record.repo, &record.quarantine, &record.original).or_else(
            |first| {
                // The folder was renamed but Git's record still points at the
                // old place (a kill between the two): re-link, then move.
                git::repair_worktree(&record.repo, &record.quarantine)
                    .and_then(|()| {
                        git::move_worktree(&record.repo, &record.quarantine, &record.original)
                    })
                    .map_err(|second| format!("{first}; after a repair: {second}"))
            },
        );
        moved?;
        drop_record(&record.id);
        // Git moves INTO a destination that is a folder already (as `mv`
        // does) instead of refusing it. If the original path was made again
        // between the look above and the move, the checkout is now inside it:
        // nothing is lost or merged, and the sentence says where it went.
        if !present(&format!("{}/.git", record.original)) {
            let nested = Path::new(&record.original)
                .join(format!("{PREFIX}{}", record.id))
                .to_string_lossy()
                .into_owned();
            if present(&nested) {
                return Err(format!(
                    "{} was made again just as the folder was put back, so it is now at {nested}; nothing was removed or merged",
                    record.original
                ));
            }
        }
        Ok(())
    })
}

/// Whether `dir` is a checkout whose Git record points back at it: its `.git`
/// file names an admin folder whose `gitdir` file names this `.git`.
///
/// `Ok(false)` only for a folder with no `.git` at all, or one whose `.git` is
/// plainly not a `gitdir:` pointer. Every other failure to read or resolve is
/// `Err`: a child that cannot be read is not a child that is not a checkout.
/// `Ok(true)` also needs the admin folder's `commondir` to resolve to `repo`'s
/// own common git directory, so a checkout of some other repository is never
/// taken for this record's.
fn is_checkout_at(dir: &Path, repo_common: &Path) -> Result<bool, String> {
    let dot_git = dir.join(".git");
    let text = match fs::read_to_string(&dot_git) {
        Ok(text) => text,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(false),
        // A `.git` directory (a plain repository) is not a pointer file.
        Err(_) if fs::symlink_metadata(&dot_git).is_ok_and(|m| m.is_dir()) => return Ok(false),
        Err(e) => return Err(format!("{} could not be read: {e}", dot_git.display())),
    };
    let Some(admin) = text.trim().strip_prefix("gitdir:") else {
        return Ok(false);
    };
    let admin = PathBuf::from(admin.trim());
    let back = fs::read_to_string(admin.join("gitdir"))
        .map_err(|e| format!("{} could not be read: {e}", admin.join("gitdir").display()))?;
    let back = fs::canonicalize(back.trim())
        .map_err(|e| format!("{} could not be resolved: {e}", back.trim()))?;
    let own = fs::canonicalize(&dot_git)
        .map_err(|e| format!("{} could not be resolved: {e}", dot_git.display()))?;
    if back != own {
        return Ok(false);
    }
    let common = fs::read_to_string(admin.join("commondir")).map_err(|e| {
        format!(
            "{} could not be read: {e}",
            admin.join("commondir").display()
        )
    })?;
    let common = fs::canonicalize(admin.join(common.trim())).map_err(|e| {
        format!(
            "The common directory of {} could not be resolved: {e}",
            dir.display()
        )
    })?;
    Ok(common == repo_common)
}

/// The record's repository's common git directory, resolved. An error keeps
/// everything: with no identity for the repository nothing can be matched.
fn repo_common_dir(repo: &str) -> Result<PathBuf, String> {
    let out = git::text(repo, &["rev-parse", "--git-common-dir"])?;
    fs::canonicalize(Path::new(repo).join(out.trim()))
        .map_err(|e| format!("The repository {repo} has no resolvable git directory: {e}"))
}

/// The record with `quarantine` set to where the checkout is. When
/// `<q>/.git` exists that is `<q>`. When it does not, exactly one child of
/// `<q>` must be a checkout of THIS record's repository whose Git record
/// points back at it; none, several or anything unreadable (any child, not
/// only the one that would match) is an error, and the caller keeps
/// everything.
fn locate(record: &Record) -> Result<Record, String> {
    if present(&format!("{}/.git", record.quarantine)) {
        return Ok(record.clone());
    }
    let kept = |why: String| {
        format!(
            "The quarantined folder {} holds no checkout of its own ({why}); it is kept, and the record {} still names it.",
            record.quarantine, record.id
        )
    };
    let repo_common = repo_common_dir(&record.repo).map_err(&kept)?;
    let entries = fs::read_dir(&record.quarantine).map_err(|e| kept(e.to_string()))?;
    let mut found = Vec::new();
    for entry in entries {
        let entry = entry.map_err(|e| kept(e.to_string()))?;
        let meta = fs::symlink_metadata(entry.path()).map_err(|e| kept(e.to_string()))?;
        if meta.is_dir() && is_checkout_at(&entry.path(), &repo_common).map_err(&kept)? {
            found.push(entry.path());
        }
    }
    match found.as_slice() {
        [one] => Ok(Record {
            quarantine: one.to_string_lossy().into_owned(),
            ..record.clone()
        }),
        [] => Err(kept("no checkout of this repository inside".into())),
        _ => Err(kept("more than one checkout inside".into())),
    }
}

/// A quarantine left by a server that was killed mid-removal. Each record is
/// looked at under the workspace lifecycle lock, like the removal it belongs
/// to: put back when the original path is free, kept and reported otherwise,
/// and never removed here.
pub(super) fn recover(svc: &Services, sweep: &mut Sweep) -> Result<(), String> {
    crate::profile::available()?;
    let entries = match fs::read_dir(records_dir()) {
        Ok(entries) => entries,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(e) => return Err(format!("Quarantine records could not be read: {e}")),
    };
    let mut records = Vec::new();
    for entry in entries {
        let entry = entry.map_err(|e| e.to_string())?;
        let name = entry.file_name().to_string_lossy().into_owned();
        if name.starts_with('.') || !name.ends_with(".json") {
            continue;
        }
        let bytes = fs::read(entry.path()).map_err(|e| e.to_string())?;
        match serde_json::from_slice::<Record>(&bytes) {
            Ok(record) => records.push(record),
            Err(e) => sweep.failed.push(Failed {
                path: entry.path().to_string_lossy().into_owned(),
                why: format!("A quarantine record could not be read ({e}); it is kept."),
            }),
        }
    }
    for record in records {
        let _lifecycle = super::hold_lifecycle(svc)?;
        // The record is only trusted for the name this host makes.
        if !name_is_ours(&record) {
            sweep.failed.push(Failed {
                path: record.original.clone(),
                why:
                    "A quarantine record names a folder this host would not have made; it is kept."
                        .into(),
            });
            continue;
        }
        // Where the checkout really is: a crash after `inside_destination`
        // moved it into a folder made first, before the rewritten record was
        // in place, leaves a record naming the outer folder.
        let record = if present(&record.quarantine) {
            match locate(&record) {
                Ok(record) => record,
                Err(why) => {
                    eprintln!("[worktree-lifespan] {why}");
                    sweep.failed.push(Failed {
                        path: record.original.clone(),
                        why,
                    });
                    continue;
                }
            }
        } else {
            record
        };
        match (present(&record.original), present(&record.quarantine)) {
            // Removed (or never moved): nothing is quarantined any more.
            (_, false) => drop_record(&record.id),
            (false, true) => {
                if let Err(e) = real_dir(Path::new(&record.quarantine)) {
                    sweep.failed.push(Failed {
                        path: record.original.clone(),
                        why: format!(
                            "A quarantined folder {} is not a plain folder ({e}); it is kept.",
                            record.quarantine
                        ),
                    });
                    continue;
                }
                let why = match restore(&record) {
                    Ok(()) => format!(
                        "A removal was interrupted: the folder was in quarantine at {} and has been put back here. Nothing was removed."
                    , record.quarantine),
                    Err(e) => format!(
                        "A removal was interrupted and the folder is still in quarantine at {} ({e}); it is kept."
                    , record.quarantine),
                };
                sweep.failed.push(Failed {
                    path: record.original.clone(),
                    why,
                });
            }
            (true, true) => sweep.failed.push(Failed {
                path: record.original.clone(),
                why: format!(
                    "A removal was interrupted and both {} and the quarantined folder {} exist; neither is touched.",
                    record.original, record.quarantine
                ),
            }),
        }
    }
    Ok(())
}
