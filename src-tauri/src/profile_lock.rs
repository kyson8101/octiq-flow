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
use std::path::PathBuf;
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
fn alive(pid: u32) -> bool {
    Command::new("kill")
        .args(["-0", &pid.to_string()])
        .output()
        .map(|o| o.status.success())
        .unwrap_or(false)
}

/// Read the lock, if a live process holds one.
pub fn current_owner() -> Option<Owner> {
    let text = fs::read_to_string(lock_path()).ok()?;
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
    if let Some(owner) = current_owner() {
        if owner.pid != std::process::id() {
            return Err(owner);
        }
    }
    let _ = fs::write(lock_path(), format!("{} {kind}", std::process::id()));
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
