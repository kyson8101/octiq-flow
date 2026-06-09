// Dashboard mode backend (card 11). The docs widget block: a shallow listing of
// the file names directly under each project's docs folder. No app state is
// needed — each call is a fresh, stateless read.
//
// The git status summary that used to live here now shares the one git backend
// in `git.rs` (see `git::git_status_summary`), so the Dashboard grid, the
// sidebar line counts, and the per-project diff panel all read git the same way.
use std::fs;

use serde::Serialize;

/// A docs block (card 11): the file names found directly under one docs folder.
/// A missing or unreadable folder comes back with an empty `files` list — never
/// an error — so one bad path does not break the docs grid.
#[derive(Debug, Clone, Serialize)]
pub struct DocsEntry {
    /// The docs folder path this listing is for (echoed back so the UI matches).
    pub path: String,
    /// File names (not full paths) directly under `path`, sorted. Subfolders are
    /// skipped — this is a shallow listing of files only.
    pub files: Vec<String>,
}

/// List the file names directly under each docs path. One `DocsEntry` per input
/// path, in the same order. Only regular files at the top level are listed
/// (markdown and others alike); subdirectories are skipped. A path that is
/// missing, not a directory, or unreadable yields an entry with no files rather
/// than an error, so the grid always renders.
#[tauri::command]
pub fn list_docs(paths: Vec<String>) -> Result<Vec<DocsEntry>, String> {
    Ok(paths.into_iter().map(docs_for_path).collect())
}

/// Read one docs folder and collect its top-level file names, sorted. Any error
/// (folder gone, not a directory, no read permission) yields an empty list.
fn docs_for_path(path: String) -> DocsEntry {
    let mut files: Vec<String> = match fs::read_dir(&path) {
        Ok(entries) => entries
            .filter_map(|entry| entry.ok())
            // Keep regular files only; skip subdirectories and symlinked dirs.
            .filter(|entry| entry.file_type().map(|t| t.is_file()).unwrap_or(false))
            .map(|entry| entry.file_name().to_string_lossy().to_string())
            .collect(),
        // Missing dir / not a dir / permission error: an empty listing, never an error.
        Err(_) => Vec::new(),
    };
    files.sort();
    DocsEntry { path, files }
}
