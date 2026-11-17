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
    if let Err(why) = git::move_worktree(repo, path, &record.quarantine) {
        return Err(failed_move(&record, &why));
    }
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
        Ok(())
    })
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
        let name_ok = Path::new(&record.quarantine)
            .file_name()
            .is_some_and(|n| n.to_string_lossy() == format!("{PREFIX}{}", record.id));
        if !name_ok {
            sweep.failed.push(Failed {
                path: record.original.clone(),
                why:
                    "A quarantine record names a folder this host would not have made; it is kept."
                        .into(),
            });
            continue;
        }
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
