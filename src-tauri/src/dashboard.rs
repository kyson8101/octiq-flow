// Dashboard mode backend (card 10). A read-only widget block framework; the
// first block is a git status summary. For each project path we shell out to
// `git -C <path> status --porcelain=v2 --branch` and parse the machine-readable
// output. No app state is needed — each call is a fresh, stateless read.
//
// porcelain=v2 --branch header lines we care about:
//   `# branch.head <name>`   -> current branch (or "(detached)" / a sha)
//   `# branch.ab +<A> -<B>`  -> commits ahead (+A) / behind (-B) of upstream
// Every other non-`#` line is a changed-entry line, so the changed-file count
// is simply the number of lines that do NOT start with `#`.
use std::fs;
use std::process::Command;

use serde::Serialize;

/// Per-path git summary returned to the frontend. A path that is missing, not a
/// repo, or whose git call fails comes back with `is_repo = false` and zeros —
/// never an error — so one bad path does not break the whole grid.
#[derive(Debug, Clone, Serialize)]
pub struct GitStatus {
    /// The folder path this summary is for (echoed back so the UI can match it).
    pub path: String,
    /// Current branch name, or empty when not a repo / detached with no name.
    pub branch: String,
    /// Number of changed entries (staged + unstaged + untracked).
    pub changed: usize,
    /// Lines added in the working tree vs HEAD (staged + unstaged tracked
    /// changes). Untracked files have no diff base, so they are not counted.
    pub insertions: u32,
    /// Lines removed in the working tree vs HEAD (staged + unstaged tracked
    /// changes).
    pub deletions: u32,
    /// Commits ahead of the upstream branch.
    pub ahead: u32,
    /// Commits behind the upstream branch.
    pub behind: u32,
    /// True only when `git status` ran cleanly and the folder is a git repo.
    pub is_repo: bool,
}

impl GitStatus {
    /// A "not a git repo" result for `path`: everything zeroed, `is_repo` false.
    fn not_repo(path: String) -> Self {
        Self {
            path,
            branch: String::new(),
            changed: 0,
            insertions: 0,
            deletions: 0,
            ahead: 0,
            behind: 0,
            is_repo: false,
        }
    }
}

/// Run a git status summary for every path. One folder per `GitStatus`, in the
/// same order as the input. Failures fall back to a `not_repo` entry.
#[tauri::command]
pub fn git_status_summary(paths: Vec<String>) -> Result<Vec<GitStatus>, String> {
    Ok(paths.into_iter().map(status_for_path).collect())
}

/// Run git for one path and parse the porcelain v2 `--branch` output. Any error
/// (folder gone, not a repo, git missing, non-zero exit) yields a `not_repo`
/// entry rather than propagating, so the grid always renders.
fn status_for_path(path: String) -> GitStatus {
    let output = Command::new("git")
        .arg("-C")
        .arg(&path)
        .args(["status", "--porcelain=v2", "--branch"])
        .output();

    let output = match output {
        Ok(out) if out.status.success() => out,
        // Spawn failed (git missing) or git exited non-zero (not a repo, bad path).
        _ => return GitStatus::not_repo(path),
    };

    let text = String::from_utf8_lossy(&output.stdout);
    let mut status = parse_status(path.clone(), &text);
    // A second, cheap git call adds the +/- line counts. Kept separate from the
    // porcelain status because porcelain v2 reports changed entries, not line
    // deltas. Any failure leaves the zeros set by parse_status.
    let (insertions, deletions) = diff_line_counts(&path);
    status.insertions = insertions;
    status.deletions = deletions;
    status
}

/// Sum the inserted/deleted lines of a repo's working tree vs HEAD via
/// `git diff --numstat HEAD` (staged + unstaged tracked changes). Falls back to
/// the plain `git diff --numstat` when HEAD does not resolve (a repo with no
/// commits yet). Any failure yields (0, 0) so a clean-looking row never breaks.
fn diff_line_counts(path: &str) -> (u32, u32) {
    let run = |rev: Option<&str>| {
        let mut cmd = Command::new("git");
        cmd.arg("-C").arg(path).args(["diff", "--numstat"]);
        if let Some(r) = rev {
            cmd.arg(r);
        }
        cmd.output().ok().filter(|out| out.status.success())
    };

    match run(Some("HEAD")).or_else(|| run(None)) {
        Some(out) => parse_numstat(&String::from_utf8_lossy(&out.stdout)),
        None => (0, 0),
    }
}

/// Sum the added/deleted columns of `git diff --numstat` output. Each line is
/// "<added>\t<deleted>\t<path>"; a binary file shows "-" in both number columns
/// and is skipped (its non-numeric tokens fail to parse and add nothing).
fn parse_numstat(text: &str) -> (u32, u32) {
    let mut insertions: u32 = 0;
    let mut deletions: u32 = 0;
    for line in text.lines() {
        let mut cols = line.split('\t');
        if let Some(n) = cols.next().and_then(|c| c.parse::<u32>().ok()) {
            insertions += n;
        }
        if let Some(n) = cols.next().and_then(|c| c.parse::<u32>().ok()) {
            deletions += n;
        }
    }
    (insertions, deletions)
}

/// Parse porcelain v2 `--branch` text into a `GitStatus`. Pulls the branch name
/// and ahead/behind from the `# branch.*` header lines and counts every other
/// non-header line as one changed entry.
fn parse_status(path: String, text: &str) -> GitStatus {
    let mut branch = String::new();
    let mut ahead: u32 = 0;
    let mut behind: u32 = 0;
    let mut changed: usize = 0;

    for line in text.lines() {
        if let Some(rest) = line.strip_prefix("# branch.head ") {
            branch = rest.trim().to_string();
        } else if let Some(rest) = line.strip_prefix("# branch.ab ") {
            // Shape: "+<ahead> -<behind>". Tolerate missing/garbled tokens.
            for token in rest.split_whitespace() {
                if let Some(n) = token.strip_prefix('+') {
                    ahead = n.parse().unwrap_or(0);
                } else if let Some(n) = token.strip_prefix('-') {
                    behind = n.parse().unwrap_or(0);
                }
            }
        } else if !line.starts_with('#') && !line.trim().is_empty() {
            // Any non-header, non-blank line is a changed/untracked entry.
            changed += 1;
        }
    }

    // git reports a detached HEAD as the literal "(detached)"; keep it as-is so
    // the UI can show it. An empty branch only happens on parse trouble.
    GitStatus {
        path,
        branch,
        changed,
        // Filled in by status_for_path via diff_line_counts; zero here.
        insertions: 0,
        deletions: 0,
        ahead,
        behind,
        is_repo: true,
    }
}

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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn numstat_sums_added_and_deleted_columns() {
        let text = "1\t10\tsrc/a.rs\n124\t14\tsrc/b.rs\n";
        assert_eq!(parse_numstat(text), (125, 24));
    }

    #[test]
    fn numstat_skips_binary_dash_rows() {
        // Binary files report "-" for both counts; they must add nothing.
        let text = "-\t-\timg.png\n5\t2\tsrc/c.rs\n";
        assert_eq!(parse_numstat(text), (5, 2));
    }

    #[test]
    fn numstat_empty_output_is_zero() {
        assert_eq!(parse_numstat(""), (0, 0));
    }

    #[test]
    fn parse_status_zeroes_line_counts() {
        // parse_status only reads porcelain; line counts come later, so it must
        // leave them at zero rather than guess from the changed-entry count.
        let text = "# branch.head main\n1 .M N... 100644 100644 100644 aaa bbb file.rs\n";
        let status = parse_status("/tmp/x".into(), text);
        assert_eq!(status.changed, 1);
        assert_eq!((status.insertions, status.deletions), (0, 0));
    }
}
