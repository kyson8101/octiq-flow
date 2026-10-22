//! Remove saved state of retired chat features once, before stores start.
//! Only fixed children of the pinned profile are considered; no Docker calls.

use std::io::ErrorKind;
use std::path::Path;

pub(crate) fn at_startup() {
    if let Err(why) = remove_saved_state() {
        eprintln!("[startup cleanup] {why}");
    }
}

fn remove_saved_state() -> Result<(), String> {
    let root = crate::profile::available()?;
    let mut errors = Vec::new();
    // The former preview publisher used <profile>/previews/<chat id>.
    for name in ["previews", "sandboxes"] {
        if let Err(why) = remove(&root.join(name)) {
            errors.push(why);
        }
    }
    let chats = root.join("chats");
    let plans = (|| {
        crate::profile::available()?;
        match std::fs::symlink_metadata(&chats) {
            Err(e) if e.kind() == ErrorKind::NotFound => return Ok(()),
            Err(e) => return Err(format!("{}: {e}", chats.display())),
            Ok(meta) if meta.file_type().is_symlink() || !meta.is_dir() => {
                return Err(format!(
                    "{} is not a regular directory; left untouched",
                    chats.display()
                ));
            }
            Ok(_) => {}
        }
        for entry in std::fs::read_dir(&chats).map_err(|e| format!("{}: {e}", chats.display()))? {
            let entry = entry.map_err(|e| e.to_string())?;
            let name = entry.file_name();
            let Some(name) = name.to_str() else { continue };
            if name.starts_with("plan_") && name.ends_with(".json") {
                if let Err(why) = remove(&entry.path()) {
                    errors.push(why);
                }
            }
        }
        Ok::<_, String>(())
    })();
    if let Err(why) = plans {
        errors.push(why);
    }
    if errors.is_empty() {
        Ok(())
    } else {
        Err(errors.join("; "))
    }
}

fn remove(path: &Path) -> Result<(), String> {
    crate::profile::available()?;
    // remove_dir_all does not traverse symlinks. A root symlink is unlinked
    // as a file so even a redirected old store cannot reach outside profile.
    let result = match std::fs::symlink_metadata(path) {
        Ok(meta) if meta.is_dir() && !meta.file_type().is_symlink() => {
            std::fs::remove_dir_all(path)
        }
        Ok(_) => std::fs::remove_file(path),
        Err(e) if e.kind() == ErrorKind::NotFound => return Ok(()),
        Err(e) => return Err(format!("{}: {e}", path.display())),
    };
    result
        .or_else(|e| {
            if e.kind() == ErrorKind::NotFound {
                Ok(())
            } else {
                Err(e)
            }
        })
        .map_err(|e| format!("{}: {e}", path.display()))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn removes_only_retired_state_and_is_safe_to_repeat() {
        let home = crate::test_dir::TestDir::new("retired-features");
        let _process = crate::profile::started_in(&home);
        let root = crate::profile::available().unwrap();
        for folder in ["chats", "previews/chat-a", "sandboxes/chat-a", "uploads"] {
            crate::profile::make_dir(&root.join(folder)).unwrap();
        }
        for file in [
            "chats/plan_a.json",
            "chats/plan_b.json",
            "previews/chat-a/image.png",
            "sandboxes/chat-a/state.json",
            "chats/chat_a.jsonl",
            "chats/task-status.json",
            "chats/plan_a.jsonl",
            "uploads/keep.png",
        ] {
            std::fs::write(root.join(file), b"keep or retire").unwrap();
        }
        remove_saved_state().unwrap();
        remove_saved_state().unwrap();
        for name in [
            "chats/plan_a.json",
            "chats/plan_b.json",
            "previews",
            "sandboxes",
        ] {
            assert!(!root.join(name).exists(), "{name}");
        }
        for name in [
            "chats/chat_a.jsonl",
            "chats/task-status.json",
            "chats/plan_a.jsonl",
            "uploads/keep.png",
        ] {
            assert_eq!(std::fs::read(root.join(name)).unwrap(), b"keep or retire");
        }
    }

    #[test]
    fn a_missing_or_replaced_profile_is_never_recreated_or_cleaned() {
        let home = crate::test_dir::TestDir::new("retired-profile-away");
        let _process = crate::profile::started_in(&home);
        let root = crate::profile::available().unwrap();
        let moved = home.join("original");
        std::fs::rename(&root, &moved).unwrap();
        assert!(remove_saved_state().is_err());
        assert!(!root.exists());
        crate::profile::make_dir(&root).unwrap_err();
        // Put another existing directory at the same path, without making
        // a directory outside the profile module's door.
        let replacement = crate::test_dir::TestDir::new("retired-replacement");
        std::fs::rename(&*replacement, &root).unwrap();
        std::fs::write(root.join("plan_keep.json"), b"untouched").unwrap();
        assert!(remove_saved_state().is_err());
        assert_eq!(
            std::fs::read(root.join("plan_keep.json")).unwrap(),
            b"untouched"
        );
    }

    #[cfg(unix)]
    #[test]
    fn redirected_store_paths_never_delete_external_data() {
        use std::os::unix::fs::symlink;
        let home = crate::test_dir::TestDir::new("retired-links");
        let outside = crate::test_dir::TestDir::new("retired-outside");
        let _process = crate::profile::started_in(&home);
        let root = crate::profile::available().unwrap();
        std::fs::write(outside.join("plan_a.json"), b"external").unwrap();
        for name in ["previews", "sandboxes", "chats"] {
            symlink(&*outside, root.join(name)).unwrap();
        }
        assert!(remove_saved_state().is_err());
        assert_eq!(
            std::fs::read(outside.join("plan_a.json")).unwrap(),
            b"external"
        );
        assert!(!root.join("previews").exists());
        assert!(!root.join("sandboxes").exists());
        assert!(std::fs::symlink_metadata(root.join("chats"))
            .unwrap()
            .file_type()
            .is_symlink());
    }
}
