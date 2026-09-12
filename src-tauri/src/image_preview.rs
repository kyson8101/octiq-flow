//! Immutable image and HTML snapshots published by the bundled MCP, scoped to a chat.
use serde::{Deserialize, Serialize};
use std::path::Path;

#[derive(Default, Deserialize, Serialize)]
#[serde(rename_all = "lowercase")]
enum PreviewKind {
    #[default]
    Image,
    Html,
}

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImagePreview {
    id: String,
    #[serde(default)]
    kind: PreviewKind,
    slot: String,
    title: String,
    created_at: u64,
    #[serde(default)]
    path: String,
    #[serde(skip_serializing)]
    file: String,
}

pub fn list(key: &str) -> Result<Vec<ImagePreview>, String> {
    list_at(&crate::profile::profile_dir(), key)
}

fn list_at(root: &Path, key: &str) -> Result<Vec<ImagePreview>, String> {
    let id = key
        .strip_prefix("chat:")
        .ok_or("Invalid conversation key")?;
    if id.is_empty()
        || id.len() > 160
        || !id
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
    {
        return Err("Invalid conversation key".into());
    }
    let dir = root.join("previews").join(id);
    if !dir.exists() {
        return Ok(vec![]);
    }
    let canonical = dir.canonicalize().map_err(|e| e.to_string())?;
    let expected = root
        .canonicalize()
        .map_err(|e| e.to_string())?
        .join("previews")
        .join(id);
    if canonical != expected {
        return Err("Preview directory must not be a symlink".into());
    }
    let mut out = Vec::new();
    for entry in std::fs::read_dir(&dir).map_err(|e| e.to_string())? {
        let entry = entry.map_err(|e| e.to_string())?;
        let p = entry.path();
        if p.extension().and_then(|s| s.to_str()) != Some("json") {
            continue;
        }
        let meta = std::fs::symlink_metadata(&p).map_err(|e| e.to_string())?;
        if !meta.is_file() || meta.len() > 4096 {
            continue;
        }
        let Ok(bytes) = std::fs::read(&p) else {
            continue;
        };
        let Ok(mut item) = serde_json::from_slice::<ImagePreview>(&bytes) else {
            continue;
        };
        let extensions: &[&str] = match item.kind {
            PreviewKind::Image => &["png", "jpg", "gif", "webp"],
            PreviewKind::Html => &["html"],
        };
        if uuid::Uuid::parse_str(&item.id).is_err()
            || p.file_stem().and_then(|s| s.to_str()) != Some(item.id.as_str())
            || !extensions
                .iter()
                .any(|ext| item.file == format!("{}.{ext}", item.id))
            || item.slot.is_empty()
            || item.slot.len() > 480
            || item.title.len() > 640
        {
            continue;
        }
        let image = dir.join(&item.file);
        let Ok(meta) = std::fs::symlink_metadata(&image) else {
            continue;
        };
        let max_bytes = match item.kind {
            PreviewKind::Image => 20 * 1024 * 1024,
            PreviewKind::Html => 2 * 1024 * 1024,
        };
        if !meta.is_file() || meta.len() == 0 || meta.len() > max_bytes {
            continue;
        }
        item.path = image.to_string_lossy().into_owned();
        out.push(item);
    }
    out.sort_by(|a, b| a.created_at.cmp(&b.created_at).then(a.id.cmp(&b.id)));
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn snapshots_are_scoped_and_untrusted_paths_are_ignored() {
        let root = std::env::temp_dir().join(format!("octiq-preview-{}", uuid::Uuid::new_v4()));
        let dir = root.join("previews/one");
        std::fs::create_dir_all(&dir).unwrap();
        let id = uuid::Uuid::new_v4().to_string();
        let file = format!("{id}.png");
        std::fs::write(dir.join(&file), b"image").unwrap();
        let manifest = serde_json::json!({"id": id, "file": file, "slot": "hero", "title": "Hero", "createdAt": 1, "path": "/etc/passwd"});
        std::fs::write(dir.join(format!("{id}.json")), manifest.to_string()).unwrap();
        let items = list_at(&root, "chat:one").unwrap();
        assert_eq!(items.len(), 1);
        assert_eq!(items[0].path, dir.join(&file).to_string_lossy());
        assert!(list_at(&root, "chat:two").unwrap().is_empty());
        assert!(list_at(&root, "chat:../one").is_err());
        let mut invalid = manifest;
        invalid["file"] = "../../secret.png".into();
        std::fs::write(dir.join(format!("{id}.json")), invalid.to_string()).unwrap();
        assert!(list_at(&root, "chat:one").unwrap().is_empty());
    }
    #[test]
    fn html_metadata_requires_a_matching_kind_and_remains_chat_scoped() {
        let root =
            std::env::temp_dir().join(format!("octiq-html-preview-{}", uuid::Uuid::new_v4()));
        let dir = root.join("previews/one");
        std::fs::create_dir_all(&dir).unwrap();
        let id = uuid::Uuid::new_v4().to_string();
        std::fs::write(dir.join(format!("{id}.html")), "<h1>Preview</h1>").unwrap();
        let meta_path = dir.join(format!("{id}.json"));
        let mut meta = serde_json::json!({"id": id, "file": format!("{id}.html"), "slot": "review", "title": "Review", "createdAt": 2, "kind": "html"});
        std::fs::write(&meta_path, meta.to_string()).unwrap();
        let items = list_at(&root, "chat:one").unwrap();
        assert_eq!(items.len(), 1);
        assert!(matches!(items[0].kind, PreviewKind::Html));
        assert!(list_at(&root, "chat:two").unwrap().is_empty());
        meta["kind"] = "image".into();
        std::fs::write(&meta_path, meta.to_string()).unwrap();
        assert!(list_at(&root, "chat:one").unwrap().is_empty());
        meta["kind"] = "html".into();
        std::fs::write(&meta_path, meta.to_string()).unwrap();
        std::fs::write(
            dir.join(format!("{id}.html")),
            vec![b'x'; 2 * 1024 * 1024 + 1],
        )
        .unwrap();
        assert!(list_at(&root, "chat:one").unwrap().is_empty());
    }
}
