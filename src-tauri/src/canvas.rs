// Canvas store + file watcher.
//
// The "canvas" is a per-project folder of HTML / Markdown documents that an
// agent writes into; OctiqFlow renders the live document in a pane beside the
// terminal. The agent finds the folder through the `OCTIQ_CANVAS_DIR` env var
// that pty.rs exports into each PROJECT terminal — it points at
// `~/.octiqflow/canvas/<projectKey>/`. This module owns resolving that folder,
// reading its documents, and watching it for changes. It never WRITES a canvas
// document itself — the agent does that.
//
// Channel shape mirrors the rest of the app: no IPC socket, just files on disk
// (like the agent-session store in agent_resume.rs) plus a `notify` watcher
// (like git_watch.rs) that emits a debounced `canvas-changed` event the frontend
// listens for. The folder lives in the active profile's data root (see
// profile.rs); the agent learns the exact path from the `OCTIQ_CANVAS_DIR` env
// var pty.rs exports, so it never needs to know where the profile keeps it.
use std::path::PathBuf;
use std::sync::{mpsc, Mutex};
use std::time::{Duration, Instant, UNIX_EPOCH};

use notify::{RecommendedWatcher, RecursiveMode, Watcher};
use serde::Serialize;
use tauri::{AppHandle, Emitter};

/// Trailing quiet period: emit once no fs event has arrived for this long.
const QUIET: Duration = Duration::from_millis(300);
/// Upper bound on coalescing: during a continuous burst, emit at least this
/// often instead of waiting for quiet that never comes.
const MAX_COALESCE: Duration = Duration::from_millis(1500);
/// Largest document we will read into the renderer. A multi-megabyte HTML file
/// would wedge the UI; past this we return an error the pane shows instead.
const MAX_DOC_BYTES: u64 = 5 * 1024 * 1024;

/// The canvas skill shipped in the repo, embedded so `install_canvas_skill` can
/// write it to the user's Claude skills folder. Kept in sync with this build.
const CANVAS_SKILL: &str = include_str!("../../scripts/skills/octiq-canvas/SKILL.md");

/// Home dir from the platform env: $HOME on Unix, %USERPROFILE% on Windows.
fn home_dir() -> Option<PathBuf> {
    std::env::var("HOME")
        .ok()
        .or_else(|| std::env::var("USERPROFILE").ok())
        .map(PathBuf::from)
}

/// Root of every project's canvas folder: `<profile>/canvas`. The agent still
/// finds its folder through the `OCTIQ_CANVAS_DIR` env var that pty.rs exports
/// (built via `canvas_dir_for`), so re-rooting per profile flows to the agent
/// without it knowing the path.
fn canvas_root() -> Option<PathBuf> {
    Some(crate::profile::profile_dir().join("canvas"))
}

/// Resolve a project's canvas folder: `~/.octiqflow/canvas/<safeKey>`. The key
/// (a frontend-supplied project id) is reduced to a single safe path segment so
/// it can never traverse out of the canvas root. `None` when the home dir is
/// unknown or the key sanitizes to nothing.
pub fn canvas_dir_for(key: &str) -> Option<PathBuf> {
    let safe = sanitize_key(key)?;
    canvas_root().map(|r| r.join(safe))
}

/// Reduce a project key to a safe single path segment: keep ASCII letters,
/// digits, dash, underscore and dot; drop everything else (including any path
/// separator). Leading/trailing dots are trimmed so the result can never be
/// `.` or `..`. Empty result -> `None`.
fn sanitize_key(key: &str) -> Option<String> {
    let kept: String = key
        .chars()
        .filter(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.'))
        .collect();
    let trimmed = kept.trim_matches('.').to_string();
    if trimmed.is_empty() {
        None
    } else {
        Some(trimmed)
    }
}

/// Whether `name` is a plain file name safe to join onto the canvas dir — no
/// path separator and no `..`, so a crafted name cannot read an arbitrary file.
fn is_safe_doc_name(name: &str) -> bool {
    !name.is_empty() && !name.contains('/') && !name.contains('\\') && !name.contains("..")
}

/// One canvas document, as the frontend lists/renders it.
#[derive(Serialize)]
pub struct CanvasDoc {
    /// File name inside the canvas folder (e.g. `canvas.md`).
    name: String,
    /// `"html"` | `"md"` | `"other"` — drives how the frontend renders it.
    kind: String,
    /// Last-modified time, milliseconds since the Unix epoch (0 if unknown).
    /// The frontend sorts by this to surface the most recently updated document.
    modified: u64,
    /// File size in bytes.
    size: u64,
}

/// Ensure a project's canvas folder exists and return its absolute path. The
/// frontend calls this to know where to watch; pty.rs calls `canvas_dir_for`
/// directly when exporting `OCTIQ_CANVAS_DIR`. Creating it up front means the
/// watcher always has a real directory even before the agent writes anything.
#[tauri::command]
pub fn canvas_dir(key: String) -> Result<String, String> {
    let dir = canvas_dir_for(&key).ok_or("invalid canvas key")?;
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir.to_string_lossy().into_owned())
}

/// List a project's canvas documents, newest first. Flat — only files directly
/// in the canvas folder (hidden/dot files skipped). A missing folder yields an
/// empty list, never an error, so the pane can render before the agent writes.
#[tauri::command]
pub fn canvas_list(key: String) -> Result<Vec<CanvasDoc>, String> {
    let Some(dir) = canvas_dir_for(&key) else {
        return Ok(vec![]);
    };
    let mut docs: Vec<CanvasDoc> = vec![];
    let Ok(entries) = std::fs::read_dir(&dir) else {
        return Ok(docs); // folder not created yet
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if !path.is_file() {
            continue;
        }
        let Some(name) = path.file_name().map(|n| n.to_string_lossy().into_owned()) else {
            continue;
        };
        if name.starts_with('.') {
            continue; // hidden / editor temp files are not documents
        }
        let kind = match path
            .extension()
            .and_then(|e| e.to_str())
            .map(|e| e.to_ascii_lowercase())
            .as_deref()
        {
            Some("html") | Some("htm") => "html",
            Some("md") | Some("markdown") => "md",
            _ => "other",
        }
        .to_string();
        let meta = entry.metadata().ok();
        let modified = meta
            .as_ref()
            .and_then(|m| m.modified().ok())
            .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
            .map(|d| d.as_millis() as u64)
            .unwrap_or(0);
        let size = meta.as_ref().map(|m| m.len()).unwrap_or(0);
        docs.push(CanvasDoc {
            name,
            kind,
            modified,
            size,
        });
    }
    // Newest first so the frontend can default to the most recently updated doc.
    docs.sort_by(|a, b| b.modified.cmp(&a.modified));
    Ok(docs)
}

/// Read one canvas document's raw text. `name` must be a plain file name inside
/// the project's canvas folder — any separator or `..` is rejected, and the
/// resolved path is verified to stay inside the canvas dir, so a crafted name can
/// never read an arbitrary file (path-traversal guard). Over-large files are
/// refused so a huge document cannot wedge the UI.
#[tauri::command]
pub fn canvas_read(key: String, name: String) -> Result<String, String> {
    let dir = canvas_dir_for(&key).ok_or("invalid canvas key")?;
    if !is_safe_doc_name(&name) {
        return Err("invalid canvas document name".into());
    }
    let path = dir.join(&name);
    // Defence in depth: the canonical path must resolve inside the canvas dir.
    let canon = path.canonicalize().map_err(|e| e.to_string())?;
    let root = dir.canonicalize().map_err(|e| e.to_string())?;
    if !canon.starts_with(&root) {
        return Err("canvas document escapes the canvas folder".into());
    }
    let meta = std::fs::metadata(&canon).map_err(|e| e.to_string())?;
    if meta.len() > MAX_DOC_BYTES {
        return Err("canvas document is too large to render (over 5 MB)".into());
    }
    std::fs::read_to_string(&canon).map_err(|e| e.to_string())
}

/// Install the OctiqFlow canvas skill into `~/.claude/skills/octiq-canvas/SKILL.md`
/// so Claude knows how to drive the canvas. OPT-IN only — called from the Settings
/// button, never automatically. OctiqFlow does not touch the user's agent config
/// unless they ask (same rule the resume/alert hooks follow). Returns the path
/// written, for the Settings status line.
#[tauri::command]
pub fn install_canvas_skill() -> Result<String, String> {
    let home = home_dir().ok_or("could not find your home folder")?;
    let dir = home.join(".claude").join("skills").join("octiq-canvas");
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let path = dir.join("SKILL.md");
    std::fs::write(&path, CANVAS_SKILL).map_err(|e| e.to_string())?;
    Ok(path.to_string_lossy().into_owned())
}

/// Marker comments bounding OctiqFlow's block in `~/.codex/AGENTS.md`, so the
/// guide can be re-installed (replaced) without disturbing the user's own
/// content above or below it.
const CODEX_MARK_START: &str = "<!-- octiqflow-canvas:start -->";
const CODEX_MARK_END: &str = "<!-- octiqflow-canvas:end -->";

/// Codex-facing version of the canvas convention. Codex has no skills, so this
/// is written as a guidance block into its instructions file instead.
const CODEX_GUIDE_BODY: &str = "## OctiqFlow canvas

When the environment variable `OCTIQ_CANVAS_DIR` is set, you are in an OctiqFlow \
project terminal that has a live canvas pane beside you. To show or update a \
visual document, write a single file named `canvas.html` into `$OCTIQ_CANVAS_DIR` \
and keep updating it. OctiqFlow renders the most recently changed file and \
refreshes it whenever you save, so keep one living document and update it as \
decisions are made.

Write only the BODY content — headings, tables, and the ready-made components. \
Do NOT write `<!doctype>`, `<html>`, `<head>`, `<style>`, or pick colors: \
OctiqFlow wraps your fragment in a fixed OctiqFlow template (dark theme, sage \
accent) that is the same in every session. Components you can use as classes: \
`.card` (raised panel), `.grid` (auto-fit columns), `.stat` with `.num`/`.label` \
(a metric block), `.badge` (a pill; add `.accent`/`.ok`/`.warn`/`.danger`), \
`.callout` (a highlighted note; add `.ok`/`.warn`/`.danger`), `.eyebrow` (a small \
uppercase label), `.meta`/`.muted` (secondary text), and `<kbd>`. Plain HTML \
(h1–h4, tables, lists, pre/code, blockquote) is themed for you too. Keep it \
scannable — favour tables, cards, and short lists over long prose.

If you need full control, write a COMPLETE HTML document starting with \
`<!doctype html>`; OctiqFlow detects that and renders it as-is, skipping the \
template. Then you own all styling — use a dark-friendly palette and inline all \
CSS/JS, because the render frame is sandboxed and cannot load external resources \
or reach the network. If `OCTIQ_CANVAS_DIR` is empty or unset, there is no canvas \
in this terminal.";

/// Install the Codex canvas guide into `~/.codex/AGENTS.md`. OPT-IN only, like
/// the Claude skill. The guide is written inside a marked block so re-installing
/// replaces just that block and the user's own AGENTS.md content is preserved.
/// Returns the path written, for the Settings status line.
#[tauri::command]
pub fn install_canvas_codex_guide() -> Result<String, String> {
    let home = home_dir().ok_or("could not find your home folder")?;
    let dir = home.join(".codex");
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let path = dir.join("AGENTS.md");
    let block = format!("{CODEX_MARK_START}\n{CODEX_GUIDE_BODY}\n{CODEX_MARK_END}");
    let existing = std::fs::read_to_string(&path).unwrap_or_default();
    std::fs::write(&path, merge_codex_block(&existing, &block)).map_err(|e| e.to_string())?;
    Ok(path.to_string_lossy().into_owned())
}

/// Merge our marked `block` into `existing` AGENTS.md text: replace the block in
/// place if its markers are present (preserving everything around it), otherwise
/// append it (or be the whole file when `existing` is empty). Pure + testable.
fn merge_codex_block(existing: &str, block: &str) -> String {
    match (
        existing.find(CODEX_MARK_START),
        existing.find(CODEX_MARK_END),
    ) {
        (Some(s), Some(e)) if e >= s => {
            let end = e + CODEX_MARK_END.len();
            format!("{}{}{}", &existing[..s], block, &existing[end..])
        }
        _ if existing.trim().is_empty() => format!("{block}\n"),
        _ => format!("{}\n\n{}\n", existing.trim_end(), block),
    }
}

/// The currently installed canvas watcher (replaced wholesale when the watched
/// project changes). Dropping the old watcher disconnects its event channel,
/// which ends its debounce thread.
#[derive(Default)]
pub struct CanvasWatchState(Mutex<Option<RecommendedWatcher>>);

/// Watch one project's canvas folder and emit a debounced `canvas-changed` event
/// (payload: the project key) whenever a document is written, added, or removed.
/// Replaces any previous watcher, so switching projects re-points it. The folder
/// is created first so there is always a real directory to watch. An empty key
/// stops watching (e.g. when no project is selected).
#[tauri::command]
pub fn canvas_watch(
    app: AppHandle,
    state: tauri::State<CanvasWatchState>,
    key: String,
) -> Result<(), String> {
    let mut guard = state.0.lock().map_err(|e| e.to_string())?;
    *guard = None; // drop the old watcher first; its debounce thread ends
    let trimmed = key.trim();
    if trimmed.is_empty() {
        return Ok(());
    }
    let dir = canvas_dir_for(trimmed).ok_or("invalid canvas key")?;
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;

    let (tx, rx) = mpsc::channel::<()>();
    let mut watcher = notify::recommended_watcher(move |res: notify::Result<notify::Event>| {
        if res.is_ok() {
            let _ = tx.send(());
        }
    })
    .map_err(|e| e.to_string())?;
    // Non-recursive: canvas documents are flat files directly in the folder.
    watcher
        .watch(&dir, RecursiveMode::NonRecursive)
        .map_err(|e| e.to_string())?;

    let emit_key = trimmed.to_string();
    std::thread::spawn(move || debounce_loop(app, rx, emit_key));
    *guard = Some(watcher);
    Ok(())
}

/// Collapse bursts of raw fs events into sparse `canvas-changed` emits: wait for
/// the first event, then keep absorbing until QUIET passes with no event (or
/// MAX_COALESCE total), then emit once carrying the project key. Ends when the
/// watcher is dropped and the channel disconnects.
fn debounce_loop(app: AppHandle, rx: mpsc::Receiver<()>, key: String) {
    while rx.recv().is_ok() {
        let first = Instant::now();
        loop {
            if first.elapsed() >= MAX_COALESCE {
                break;
            }
            match rx.recv_timeout(QUIET) {
                Ok(_) => continue,
                Err(mpsc::RecvTimeoutError::Timeout) => break,
                Err(mpsc::RecvTimeoutError::Disconnected) => {
                    let _ = app.emit("canvas-changed", &key);
                    return;
                }
            }
        }
        let _ = app.emit("canvas-changed", &key);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sanitize_key_strips_separators_and_dots() {
        // A traversal attempt collapses to a single safe segment (or None).
        assert_eq!(sanitize_key("../../etc"), Some("etc".to_string()));
        assert_eq!(sanitize_key("a/b\\c"), Some("abc".to_string()));
        assert_eq!(sanitize_key(".."), None);
        assert_eq!(sanitize_key("."), None);
        assert_eq!(sanitize_key(""), None);
        // A normal project id (uuid-ish) is kept verbatim.
        assert_eq!(
            sanitize_key("proj_12-34.ab"),
            Some("proj_12-34.ab".to_string())
        );
    }

    #[test]
    fn unsafe_doc_names_are_rejected() {
        assert!(!is_safe_doc_name(""));
        assert!(!is_safe_doc_name("../secret"));
        assert!(!is_safe_doc_name("a/b.md"));
        assert!(!is_safe_doc_name("a\\b.md"));
        assert!(!is_safe_doc_name("..hidden"));
        assert!(is_safe_doc_name("canvas.md"));
        assert!(is_safe_doc_name("plan.html"));
    }

    #[test]
    fn codex_block_appends_then_replaces_idempotently() {
        let block = format!("{CODEX_MARK_START}\nv1\n{CODEX_MARK_END}");
        // Empty file: the block becomes the whole content.
        assert_eq!(merge_codex_block("", &block), format!("{block}\n"));
        // Non-empty file: the block is appended, the user's text kept.
        let user = "# My Codex notes\n- be terse";
        let appended = merge_codex_block(user, &block);
        assert!(appended.starts_with(user));
        assert!(appended.contains(&block));
        // Re-install with a new body replaces the block in place (no duplication)
        // and still keeps the surrounding user text.
        let block2 = format!("{CODEX_MARK_START}\nv2\n{CODEX_MARK_END}");
        let replaced = merge_codex_block(&appended, &block2);
        assert!(replaced.contains("v2"));
        assert!(!replaced.contains("v1"));
        assert_eq!(replaced.matches(CODEX_MARK_START).count(), 1);
        assert!(replaced.contains("# My Codex notes"));
    }
}
