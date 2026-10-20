//! Review notes beside media, never written into the source file. Each source
//! revision has its own thread, shared by previews and devices in this profile.
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    fs,
    path::{Path, PathBuf},
    sync::Mutex,
    time::{SystemTime, UNIX_EPOCH},
};

const TEXT_MAX: usize = 4000;
const COMMENTS_MAX: usize = 1000;
const BYTES_MAX: u64 = 20 * 1024 * 1024;
static LOCK: Mutex<()> = Mutex::new(());

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Target {
    path: String,
    revision: String,
    kind: String,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Comment {
    id: String,
    text: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    time_ms: Option<u64>,
    created_at: u64,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Thread {
    target: Target,
    comments: Vec<Comment>,
}

fn digest(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}

fn target(path: &str) -> Result<Target, String> {
    let path = crate::paths::canonicalize(path)
        .map_err(|e| format!("The media file is unavailable: {e}"))?;
    let meta = fs::metadata(&path).map_err(|e| format!("The media file is unavailable: {e}"))?;
    if !meta.is_file() {
        return Err("Comments require an image or video file.".into());
    }
    let kind = match path
        .extension()
        .and_then(|s| s.to_str())
        .unwrap_or("")
        .to_ascii_lowercase()
        .as_str()
    {
        "png" | "jpg" | "jpeg" | "gif" | "webp" | "svg" => "image",
        "mp4" | "m4v" | "mov" | "webm" | "ogv" => "video",
        _ => return Err("Comments are supported for images and videos.".into()),
    };
    // No hashing a multi-gigabyte video merely to open a review. An ordinary
    // replacement or edit changes this identity; immutable preview paths also
    // separate snapshots. This is file metadata identity, not a content SHA.
    let modified = meta
        .modified()
        .map_err(|e| e.to_string())?
        .duration_since(UNIX_EPOCH)
        .map_err(|e| e.to_string())?
        .as_nanos();
    Ok(Target {
        path: path.to_string_lossy().into_owned(),
        revision: digest(format!("{}:{modified}", meta.len()).as_bytes()),
        kind: kind.into(),
    })
}

fn store(root: &Path, target: &Target) -> PathBuf {
    root.join(format!(
        "{}.json",
        digest(format!("{}\n{}", target.path, target.revision).as_bytes())
    ))
}

fn read(root: &Path, target: Target) -> Result<Thread, String> {
    let path = store(root, &target);
    if fs::metadata(&path).is_ok_and(|meta| meta.len() > BYTES_MAX) {
        return Err("The saved media comments are too large to read.".into());
    }
    let bytes = crate::profile::read(&path, |e| format!("Media comments could not be read: {e}"))?;
    let Some(bytes) = bytes else {
        return Ok(Thread {
            target,
            comments: vec![],
        });
    };
    let thread: Thread = serde_json::from_slice(&bytes)
        .map_err(|e| format!("Media comments could not be read: {e}"))?;
    if thread.target != target {
        return Err("The saved comments belong to another media revision.".into());
    }
    Ok(thread)
}

fn write(root: &Path, thread: &Thread) -> Result<(), String> {
    crate::profile::make_dir(root)?;
    let bytes = serde_json::to_vec(thread).map_err(|e| e.to_string())?;
    if bytes.len() as u64 > BYTES_MAX {
        return Err("This media review is full.".into());
    }
    let path = store(root, &thread.target);
    let tmp = root.join(format!(".comments-{}.tmp", uuid::Uuid::new_v4()));
    fs::write(&tmp, bytes).map_err(|e| crate::profile::write_error(&tmp, e))?;
    fs::rename(&tmp, &path).map_err(|e| {
        let _ = fs::remove_file(&tmp);
        crate::profile::write_error(&path, e)
    })
}

fn root() -> PathBuf {
    crate::profile::profile_dir().join("media-comments")
}

pub fn list(path: &str) -> Result<Thread, String> {
    let _guard = LOCK.lock().unwrap_or_else(|e| e.into_inner());
    crate::profile::available()?;
    read(&root(), target(path)?)
}

pub fn add(
    path: &str,
    revision: &str,
    id: &str,
    text: &str,
    time_ms: Option<u64>,
) -> Result<Thread, String> {
    change(path, revision, |thread| {
        if uuid::Uuid::parse_str(id).is_err() {
            return Err("Invalid comment id.".into());
        }
        let text = text.trim();
        if text.is_empty() || text.chars().count() > TEXT_MAX {
            return Err(format!("Write a comment of 1–{TEXT_MAX} characters."));
        }
        if thread.target.kind == "image" && time_ms.is_some() {
            return Err("An image comment has no playback time.".into());
        }
        if time_ms.is_some_and(|time| time > 9_007_199_254_740_991) {
            return Err("Invalid playback time.".into());
        }
        if let Some(previous) = thread.comments.iter().find(|comment| comment.id == id) {
            return if previous.text == text && previous.time_ms == time_ms {
                Ok(())
            } else {
                Err("That comment id was already used.".into())
            };
        }
        if thread.comments.len() >= COMMENTS_MAX {
            return Err(format!("This review already has {COMMENTS_MAX} comments."));
        }
        thread.comments.push(Comment {
            id: id.into(),
            text: text.into(),
            time_ms,
            created_at: SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .map(|t| t.as_millis() as u64)
                .unwrap_or(0),
        });
        Ok(())
    })
}

pub fn remove(path: &str, revision: &str, id: &str) -> Result<Thread, String> {
    change(path, revision, |thread| {
        thread.comments.retain(|comment| comment.id != id);
        Ok(())
    })
}

fn change(
    path: &str,
    revision: &str,
    edit: impl FnOnce(&mut Thread) -> Result<(), String>,
) -> Result<Thread, String> {
    let _guard = LOCK.lock().unwrap_or_else(|e| e.into_inner());
    crate::profile::available()?;
    let target = target(path)?;
    if target.revision != revision {
        return Err("The media file changed. Reopen the preview before commenting on the new version. Your draft has not been saved.".into());
    }
    let mut thread = read(&root(), target)?;
    edit(&mut thread)?;
    if target_again(path, &thread.target).is_err() {
        return Err(
            "The media changed while saving. Your comment was not saved; reopen the preview."
                .into(),
        );
    }
    write(&root(), &thread)?;
    crate::bus::emit("media-comments-changed", &thread.target);
    Ok(thread)
}

fn target_again(path: &str, expected: &Target) -> Result<(), String> {
    if &target(path)? == expected {
        Ok(())
    } else {
        Err("media changed".into())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_dir::TestDir;

    #[test]
    fn notes_survive_rereads_and_retries_and_are_scoped_to_the_media_revision() {
        let home = TestDir::new("media-comments");
        let _profile = crate::profile::started_in(&home);
        let video = home.join("clip.mp4");
        fs::write(&video, b"video").unwrap();
        let path = video.to_str().unwrap();
        let first = list(path).unwrap();
        let id = uuid::Uuid::new_v4().to_string();
        add(
            path,
            &first.target.revision,
            &id,
            "fix the cut",
            Some(12345),
        )
        .unwrap();
        add(
            path,
            &first.target.revision,
            &id,
            "fix the cut",
            Some(12345),
        )
        .unwrap();
        let saved = list(path).unwrap();
        assert_eq!(saved.comments.len(), 1);
        assert_eq!(saved.comments[0].time_ms, Some(12345));
        assert_eq!(fs::read(&video).unwrap(), b"video");
        fs::write(&video, b"a new version").unwrap();
        assert!(add(
            path,
            &first.target.revision,
            &uuid::Uuid::new_v4().to_string(),
            "old frame",
            Some(0)
        )
        .is_err());
        assert!(list(path).unwrap().comments.is_empty());
        assert_eq!(read(&root(), first.target).unwrap().comments.len(), 1);
    }

    #[test]
    fn image_comments_have_created_times_but_no_playback_times_and_can_be_removed() {
        let home = TestDir::new("image-comments");
        let _profile = crate::profile::started_in(&home);
        let image = home.join("still.png");
        fs::write(&image, b"png").unwrap();
        let path = image.to_str().unwrap();
        let rev = list(path).unwrap().target.revision;
        let id = uuid::Uuid::new_v4().to_string();
        assert!(add(path, &rev, &id, "note", Some(1)).is_err());
        assert!(add(path, &rev, &id, "  ", None).is_err());
        assert!(add(path, &rev, &id, &"a".repeat(TEXT_MAX + 1), None).is_err());
        let saved = add(path, &rev, &id, "warmer light", None).unwrap();
        assert!(saved.comments[0].created_at > 0);
        assert_eq!(remove(path, &rev, &id).unwrap().comments.len(), 0);
    }

    #[test]
    fn an_unreadable_store_is_never_overwritten() {
        let home = TestDir::new("bad-media-comments");
        let _profile = crate::profile::started_in(&home);
        let video = home.join("clip.mp4");
        fs::write(&video, b"video").unwrap();
        let path = video.to_str().unwrap();
        let media = target(path).unwrap();
        crate::profile::make_dir(&root()).unwrap();
        let file = store(&root(), &media);
        fs::write(&file, b"broken").unwrap();
        assert!(list(path).is_err());
        assert!(add(
            path,
            &media.revision,
            &uuid::Uuid::new_v4().to_string(),
            "note",
            Some(0)
        )
        .is_err());
        assert_eq!(fs::read(&file).unwrap(), b"broken");
    }

    #[test]
    fn a_missing_or_replaced_profile_never_accepts_comments() {
        for replace in [false, true] {
            let home = crate::profile::tests::Home::with_a_configured_base();
            let _profile = crate::profile::started_in(&home.dir);
            let video = home.dir.join("clip.mp4");
            fs::write(&video, b"video").unwrap();
            let path = video.to_str().unwrap();
            let rev = list(path).unwrap().target.revision;
            if replace {
                home.replace();
            } else {
                home.move_away();
            }
            assert!(list(path).is_err());
            assert!(add(
                path,
                &rev,
                &uuid::Uuid::new_v4().to_string(),
                "note",
                Some(0)
            )
            .is_err());
            if !replace {
                assert!(!home.profile().exists());
                home.move_back();
            }
        }
    }
}
