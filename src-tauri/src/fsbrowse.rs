// File-browser backend (Files / Documentation right-click actions). Lists the
// direct children of one folder for the center file browser. Unlike the
// dashboard's `list_docs` (which swallows errors so the grid always renders),
// this command MUST surface failures: a missing path, a non-directory, or a
// permission error comes back as `Err(message)` so the browser panel can show
// it to the user. The frontend opens a file with the opener plugin, not here.
use std::fs;
use std::path::Path;

use serde::Serialize;

/// One entry (file or folder) directly inside a browsed directory.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "snake_case")]
pub struct DirEntry {
    /// The entry's own name (last path segment), e.g. "src" or "README.md".
    pub name: String,
    /// The entry's full absolute path, used to navigate in or to open a file.
    pub path: String,
    /// True for a directory (including a symlink that resolves to a directory).
    pub is_dir: bool,
}

/// List the direct children of `path`, directories first then files, each group
/// sorted case-insensitively by name. Returns `Err(message)` when `path` is
/// missing, is not a directory, or cannot be read (permission), so the frontend
/// can show the message in the browser panel.
#[tauri::command]
pub fn list_dir(path: String) -> Result<Vec<DirEntry>, String> {
    let dir = Path::new(&path);

    if !dir.exists() {
        return Err(format!("Folder not found: {path}"));
    }
    if !dir.is_dir() {
        return Err(format!("Not a folder: {path}"));
    }

    let read = fs::read_dir(dir).map_err(|e| format!("Cannot read folder: {e}"))?;

    let mut entries: Vec<DirEntry> = Vec::new();
    for item in read {
        // Skip entries we cannot stat rather than failing the whole listing.
        let Ok(item) = item else { continue };
        // Use the resolved path (follows symlinks) so a symlinked directory is
        // navigable, matching the doc comment. A broken link resolves to false.
        let is_dir = item.path().is_dir();
        let name = item.file_name().to_string_lossy().to_string();
        let full = item.path().to_string_lossy().to_string();
        entries.push(DirEntry {
            name,
            path: full,
            is_dir,
        });
    }

    // Directories first, then files; within each group, case-insensitive A→Z.
    entries.sort_by(|a, b| match (a.is_dir, b.is_dir) {
        (true, false) => std::cmp::Ordering::Less,
        (false, true) => std::cmp::Ordering::Greater,
        _ => a.name.to_lowercase().cmp(&b.name.to_lowercase()),
    });

    Ok(entries)
}
