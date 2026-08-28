// Canvas folder resolution.
//
// The "canvas" is a per-project folder of HTML / Markdown documents that an
// agent writes into. The agent finds the folder through the `OCTIQ_CANVAS_DIR`
// env var that pty.rs exports into each PROJECT terminal — it points at
// `<profile>/canvas/<projectKey>/`. This module owns resolving that folder, and
// nothing else: it never writes a canvas document, and nothing here reads one.
//
// It used to do more. Listing, reading, deleting, watching for changes, and
// installing the agent skill all lived here to serve the desktop app's canvas
// pane; that pane went with the desktop app, and the browser client has no
// route to any of it. What survives is the one piece with a live caller.
use std::path::PathBuf;

/// Root of every project's canvas folder: `<profile>/canvas`. The agent finds
/// its own folder through the `OCTIQ_CANVAS_DIR` env var that pty.rs exports
/// (built via `canvas_dir_for`), so re-rooting per profile flows to the agent
/// without it knowing the path.
fn canvas_root() -> Option<PathBuf> {
    Some(crate::profile::profile_dir().join("canvas"))
}

/// Resolve a project's canvas folder: `<profile>/canvas/<safeKey>`. The key (a
/// client-supplied project id) is reduced to a single safe path segment so it
/// can never traverse out of the canvas root. `None` when the key sanitizes to
/// nothing.
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
}
