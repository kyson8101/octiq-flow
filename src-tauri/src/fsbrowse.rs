// File-browser backend (Files / Documentation right-click actions). Lists the
// direct children of one folder for the center file browser. Unlike the
// dashboard's `list_docs` (which swallows errors so the grid always renders),
// this command MUST surface failures: a missing path, a non-directory, or a
// permission error comes back as `Err(message)` so the browser panel can show
// it to the user. The frontend opens a file with the opener plugin, not here.
use std::fs;
use std::path::{Path, PathBuf};

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

/// A preview descriptor for one file for the in-app preview pane. The frontend
/// renders it by `kind`:
///   * "text"   — show `content` (the capped UTF-8 text).
///   * "image"  — load the file itself via the asset protocol (convertFileSrc).
///   * "pdf"    — load the file itself via the asset protocol in an iframe.
///   * "binary" — offer "open externally" only (no inline preview).
/// For image/pdf/binary, `content` is empty: the bytes are not read here.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "snake_case")]
pub struct FilePreview {
    /// One of "text", "image", "pdf", "binary" (see the struct doc).
    pub kind: String,
    /// The file's text content, capped at PREVIEW_MAX_BYTES. Empty unless text.
    pub content: String,
    /// True when a text file was larger than the cap, so `content` is its start.
    pub truncated: bool,
    /// The file's real size in bytes (not the capped `content` length).
    pub size: u64,
}

/// File extensions (lower-case, no dot) shown inline as an image in the preview
/// pane. SVG is included here so it renders rather than showing its XML source.
const IMAGE_EXTS: &[&str] = &[
    "png", "jpg", "jpeg", "gif", "webp", "bmp", "ico", "svg", "avif", "apng",
];

/// Largest slice of a file we read for the preview pane. Keeps the webview
/// responsive and stops a huge log or blob from being loaded whole.
const PREVIEW_MAX_BYTES: usize = 512 * 1024;

/// Read up to PREVIEW_MAX_BYTES of `path` for the in-app preview pane. Returns
/// `Err(message)` when the path is missing, is a directory, or cannot be read.
/// A file that holds a NUL byte is reported as `kind = "binary"` with empty
/// content so the frontend shows an "open externally" hint instead of gibberish.
#[tauri::command]
pub fn read_file_preview(path: String) -> Result<FilePreview, String> {
    use std::io::Read;

    let file_path = Path::new(&path);
    if !file_path.exists() {
        return Err(format!("File not found: {path}"));
    }
    if file_path.is_dir() {
        return Err(format!("Not a file: {path}"));
    }

    let size = fs::metadata(file_path)
        .map_err(|e| format!("Cannot read file: {e}"))?
        .len();

    // Images and PDFs are shown by loading the file itself through the asset
    // protocol on the frontend, so classify them by extension and skip reading
    // their bytes here.
    let ext = file_path
        .extension()
        .and_then(|e| e.to_str())
        .map(str::to_lowercase)
        .unwrap_or_default();
    if IMAGE_EXTS.contains(&ext.as_str()) {
        return Ok(FilePreview {
            kind: "image".into(),
            content: String::new(),
            truncated: false,
            size,
        });
    }
    if ext == "pdf" {
        return Ok(FilePreview {
            kind: "pdf".into(),
            content: String::new(),
            truncated: false,
            size,
        });
    }

    let file = fs::File::open(file_path).map_err(|e| format!("Cannot open file: {e}"))?;
    // Read one byte past the cap so we can tell "exactly at the cap" from "larger".
    let mut buf = Vec::new();
    file.take(PREVIEW_MAX_BYTES as u64 + 1)
        .read_to_end(&mut buf)
        .map_err(|e| format!("Cannot read file: {e}"))?;

    let truncated = buf.len() > PREVIEW_MAX_BYTES;
    if truncated {
        buf.truncate(PREVIEW_MAX_BYTES);
    }

    // A NUL byte means binary (images, executables, archives). Plain text never
    // contains one, so this catches the common cases without false positives.
    if buf.contains(&0) {
        return Ok(FilePreview {
            kind: "binary".into(),
            content: String::new(),
            truncated: false,
            size,
        });
    }

    // Decode as UTF-8, keeping the valid prefix when the cap split a multi-byte
    // character (or a stray byte appears) rather than calling the whole file
    // binary.
    let content = match String::from_utf8(buf) {
        Ok(text) => text,
        Err(e) => {
            let valid = e.utf8_error().valid_up_to();
            String::from_utf8_lossy(&e.into_bytes()[..valid]).into_owned()
        }
    };

    Ok(FilePreview {
        kind: "text".into(),
        content,
        truncated,
        size,
    })
}

/// The user's home dir, from HOME (Unix) or USERPROFILE (Windows). Same helper
/// as agent_resume.rs / canvas.rs keep privately.
fn home_dir() -> Option<PathBuf> {
    std::env::var("HOME")
        .or_else(|_| std::env::var("USERPROFILE"))
        .ok()
        .map(PathBuf::from)
}

/// Resolve every path-looking string a terminal printed into an absolute path
/// that EXISTS on disk (`None` per miss), in one call. Backs the terminal's
/// file-link provider, which checks a whole hovered line's candidates at once —
/// one IPC per line instead of a round-trip per candidate.
#[tauri::command]
pub fn resolve_paths(paths: Vec<String>, cwd: String) -> Vec<Option<String>> {
    paths.into_iter().map(|p| resolve_path(p, &cwd)).collect()
}

/// Resolve ONE path-looking string into an absolute path that EXISTS on disk,
/// or `None`. `~`/`~/…` expand to the user's home; a relative path resolves
/// against `cwd` (the tab's spawn directory; empty cwd resolves absolute paths
/// only). A candidate only becomes a clickable link when this confirms it is
/// real, so prose that merely looks like a path never underlines.
fn resolve_path(path: String, cwd: &str) -> Option<String> {
    let expanded = if path == "~" {
        home_dir()?
    } else if let Some(rest) = path.strip_prefix("~/") {
        home_dir()?.join(rest)
    } else {
        PathBuf::from(&path)
    };
    let abs = if expanded.is_absolute() {
        expanded
    } else if cwd.is_empty() {
        return None;
    } else {
        Path::new(cwd).join(expanded)
    };
    if abs.exists() {
        Some(abs.to_string_lossy().into_owned())
    } else {
        None
    }
}

#[cfg(test)]
mod tests {
    use super::resolve_path;

    #[test]
    fn resolve_path_handles_absolute_relative_tilde_and_missing() {
        let dir = std::env::temp_dir().join("octiq-resolve-path-test");
        std::fs::create_dir_all(&dir).unwrap();
        let file = dir.join("hit.txt");
        std::fs::write(&file, "x").unwrap();
        let dir_s = dir.to_string_lossy().into_owned();
        let file_s = file.to_string_lossy().into_owned();

        // Absolute path found regardless of cwd.
        assert_eq!(resolve_path(file_s.clone(), ""), Some(file_s.clone()));
        // Relative path resolves against cwd; without a cwd it cannot.
        assert!(resolve_path("hit.txt".into(), &dir_s).is_some());
        assert_eq!(resolve_path("hit.txt".into(), ""), None);
        // Missing file is None, not a link.
        assert_eq!(resolve_path("nope.txt".into(), &dir_s), None);
        // Tilde expands to home (home itself always exists).
        assert!(resolve_path("~".into(), "").is_some());
        // The batched command maps each candidate independently.
        assert_eq!(
            super::resolve_paths(vec![file_s.clone(), "nope.txt".into()], dir_s),
            vec![Some(file_s), None]
        );
    }
}

/// Overwrite `path` with `content` from the in-app preview editor (Save). Returns
/// `Err(message)` when the path is a directory or the write fails. The frontend
/// only enables Save for text files it read in full (never a truncated one), so a
/// large file can't be saved back as just its first chunk and lose the tail.
#[tauri::command]
pub fn write_file(path: String, content: String) -> Result<(), String> {
    let file_path = Path::new(&path);
    if file_path.is_dir() {
        return Err(format!("Not a file: {path}"));
    }
    fs::write(file_path, content).map_err(|e| format!("Cannot save file: {e}"))
}
