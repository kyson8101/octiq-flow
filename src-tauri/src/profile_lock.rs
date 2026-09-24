//! One owner per profile.
//!
//! The desktop app and the headless server both keep the project list in
//! memory and write it back on change. Run both at once and the loser's copy
//! silently reverts the winner's: add a project on your phone, open the app,
//! and the project is gone. Nothing crashes, which is what makes it nasty.
//!
//! That was survivable while both were started by hand. A launchd service means
//! the server is ALWAYS up, so opening the app is the collision rather than an
//! unlucky coincidence — it needs to be visible.
//!
//! So the profile directory carries a lock naming its owner. It is advisory:
//! nothing here can stop a determined second process, and it is not meant to.
//! It exists so the second process can SAY something instead of quietly
//! corrupting a file.
//!
//! A stale lock — from a process that was killed rather than closed — is
//! ignored, because a service that refuses to start after a crash is worse than
//! the problem it was guarding against.
use std::fs;
use std::path::{Path, PathBuf};
#[cfg(not(windows))]
use std::process::Command;

/// Who is holding a profile, as recorded in the lock.
#[derive(Debug, Clone, PartialEq)]
pub struct Owner {
    pub pid: u32,
    /// "desktop" or "server" — enough to tell the user what to close.
    pub kind: String,
}

fn lock_path() -> PathBuf {
    crate::profile::profile_dir().join("owner.lock")
}

/// Whether a process is still alive. `kill -0` asks exactly that and changes
/// nothing; no signal is delivered.
#[cfg(not(windows))]
fn alive(pid: u32) -> bool {
    Command::new("kill")
        .args(["-0", &pid.to_string()])
        .output()
        .map(|o| o.status.success())
        .unwrap_or(false)
}

/// A native process handle avoids depending on Unix tools or confusing MSYS
/// process IDs with Windows PIDs. Only a confirmed exit releases the lock.
#[cfg(windows)]
fn alive(pid: u32) -> bool {
    use windows_sys::Win32::Foundation::{
        CloseHandle, GetLastError, ERROR_INVALID_PARAMETER, WAIT_OBJECT_0,
    };
    use windows_sys::Win32::System::Threading::{
        OpenProcess, WaitForSingleObject, PROCESS_SYNCHRONIZE,
    };

    // SAFETY: OpenProcess creates a non-inherited handle with only wait
    // access. The handle remains valid through the non-blocking wait and is
    // closed exactly once. No caller-owned handle or memory is accessed.
    unsafe {
        let handle = OpenProcess(PROCESS_SYNCHRONIZE, 0, pid);
        if handle.is_null() {
            // A missing PID yields INVALID_PARAMETER. Access denied (or any
            // other uncertainty) must not let us overwrite a live owner's data.
            return GetLastError() != ERROR_INVALID_PARAMETER;
        }
        let state = WaitForSingleObject(handle, 0);
        CloseHandle(handle);
        state != WAIT_OBJECT_0
    }
}

/// Read the lock, if a live process holds one.
fn current_owner_at(path: &Path) -> Option<Owner> {
    let text = fs::read_to_string(path).ok()?;
    let (pid, kind) = text.trim().split_once(' ')?;
    let pid: u32 = pid.parse().ok()?;
    // Our own lock from a previous run, left behind by a kill -9.
    if !alive(pid) {
        return None;
    }
    Some(Owner {
        pid,
        kind: kind.to_string(),
    })
}

/// Claim the profile. `Err(owner)` when someone else already has it.
pub fn acquire(kind: &str) -> Result<(), Owner> {
    acquire_at(&lock_path(), kind)
}

fn acquire_at(path: &Path, kind: &str) -> Result<(), Owner> {
    if let Some(owner) = current_owner_at(path) {
        if owner.pid != std::process::id() {
            return Err(owner);
        }
    }
    let _ = fs::write(path, format!("{} {kind}", std::process::id()));
    Ok(())
}

/// What to tell the user, in words that name the fix.
pub fn conflict_message(owner: &Owner) -> String {
    let other = match owner.kind.as_str() {
        "server" => "the OctiqFlow background service",
        "desktop" => "the OctiqFlow app",
        other => other,
    };
    format!(
        "{other} is already using this profile (pid {}). \
         Two of them would overwrite each other's project list, so only one should run at a time.",
        owner.pid
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn our_own_pid_is_alive_and_a_absurd_one_is_not() {
        assert!(alive(std::process::id()));
        // Above the default pid ceiling, so it cannot be a real process.
        assert!(!alive(4_000_000));
    }

    #[test]
    fn a_live_child_holds_the_profile_until_it_exits() {
        use std::io::Read;
        use std::process::{Command, Stdio};
        const CHILD_MARKER: &str = "OCTIQ_PROFILE_LOCK_TEST_CHILD";
        if std::env::var_os(CHILD_MARKER).is_some() {
            // A portable stand-in process: stay alive until the parent closes
            // stdin. No shell, cat, sleep, or platform-specific tool required.
            std::io::stdin().read_to_end(&mut Vec::new()).unwrap();
            return;
        }
        let mut child = Command::new(std::env::current_exe().unwrap())
            .args([
                "--exact",
                "profile_lock::tests::a_live_child_holds_the_profile_until_it_exits",
            ])
            .env(CHILD_MARKER, "1")
            .stdin(Stdio::piped())
            .stdout(Stdio::null())
            .spawn()
            .unwrap();
        let path = std::env::temp_dir().join(format!(
            "octiq-owner-test-{}-{}.lock",
            std::process::id(),
            child.id()
        ));
        let owner = Owner {
            pid: child.id(),
            kind: "server".into(),
        };
        fs::write(&path, format!("{} server", owner.pid)).unwrap();
        // Capture results before cleaning up the child, so even a failed
        // assertion below cannot leave the stand-in running.
        let live_owner = current_owner_at(&path);
        let live_claim = acquire_at(&path, "server");
        drop(child.stdin.take());
        assert!(child.wait().unwrap().success());
        let exited_owner = current_owner_at(&path);
        let new_claim = acquire_at(&path, "server");
        let _ = fs::remove_file(&path);

        assert_eq!(live_owner, Some(owner.clone()));
        assert_eq!(live_claim, Err(owner));
        assert_eq!(exited_owner, None);
        assert_eq!(new_claim, Ok(()));
    }

    #[test]
    fn a_conflict_names_the_process_to_close() {
        let owner = Owner {
            pid: 4321,
            kind: "server".into(),
        };
        let msg = conflict_message(&owner);
        assert!(msg.contains("background service"), "{msg}");
        assert!(msg.contains("4321"), "{msg}");
        // It must say what goes wrong, not just that something is wrong.
        assert!(msg.contains("project list"), "{msg}");
    }

    #[test]
    fn an_unknown_kind_is_passed_through_rather_than_hidden() {
        let owner = Owner {
            pid: 1,
            kind: "something-new".into(),
        };
        assert!(conflict_message(&owner).contains("something-new"));
    }
}
