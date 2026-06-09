// Per-project git diff backend (GitHub-style "uncommitted changes" view).
//
// A project (workspace) can hold several folder paths, and two of them may live
// in the SAME git repo (e.g. the repo root and a subfolder). We resolve each
// path to its repo top-level and de-duplicate, so one repo shows once even if
// several of the project's paths point into it. Folders that are not git repos
// are skipped — they contribute no changes.
//
// Two commands, both read-only (every call shells out to `git`, never mutating):
//   * `git_changed_files(paths)` — the changed-file LIST per repo. "Changed"
//     means the working tree vs the last commit (HEAD): staged + unstaged
//     tracked changes (`git diff HEAD`) plus untracked files (`git ls-files
//     --others`). One repo with no commit yet (no HEAD) is handled too: every
//     file is treated as new.
//   * `git_file_diff(root, file, untracked)` — the unified diff for ONE file,
//     loaded lazily when the user clicks it (mirrors the file-browser preview).
//     For an untracked / brand-new file there is no HEAD side, so we synthesize
//     an all-additions diff from the file's current content.
//
// All git calls pass `-c core.quotePath=false` so unicode paths come back as raw
// UTF-8 instead of octal-escaped. The only unsupported case is a filename that
// contains a literal newline (git would still quote those); such paths are rare
// and treated as best-effort.
use std::collections::HashSet;
use std::path::Path;
use std::process::Command;

use serde::Serialize;

/// The uncommitted changes for one git repository.
#[derive(Debug, Clone, Serialize)]
pub struct RepoChanges {
    /// The repo top-level path (absolute). Used as the group title + diff root.
    pub root: String,
    /// Current branch name, or "(detached)" / "(<sha>)" when HEAD is not a branch.
    pub branch: String,
    /// Changed files in this repo, in git's order.
    pub files: Vec<ChangedFile>,
}

/// One changed file inside a repo.
#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct ChangedFile {
    /// Repo-relative path (the NEW path for a rename). The key passed back to
    /// `git_file_diff`.
    pub path: String,
    /// The OLD path for a rename (empty otherwise). Passed back to
    /// `git_file_diff` so the rename can be diffed against both paths.
    pub old_path: String,
    /// What to show in the list: the path, or "old → new" for a rename.
    pub display: String,
    /// One of "modified", "added", "deleted", "renamed", "untracked".
    pub status: String,
    /// True for a file with no HEAD version (untracked, or any file in a repo
    /// with no commit yet); its diff is synthesized from the file content.
    pub untracked: bool,
    /// Lines added / removed vs HEAD. Best-effort; 0 for untracked or binary.
    pub added: u32,
    pub removed: u32,
    /// True when git reports the file as binary (no textual diff).
    pub binary: bool,
}

/// Per-path git summary for the Dashboard grid and the sidebar line counts. A
/// path that is missing, not a repo, or whose git call fails comes back with
/// `is_repo = false` and zeros — never an error — so one bad path does not break
/// the whole grid. Unlike `RepoChanges` this is per-PATH (not de-duplicated by
/// repo), because both callers match results back to the path they sent.
#[derive(Debug, Clone, Serialize)]
pub struct GitStatus {
    /// The folder path this summary is for (echoed back so the UI can match it).
    pub path: String,
    /// Current branch name, or empty when not a repo / detached with no name.
    pub branch: String,
    /// Number of changed entries (staged + unstaged + untracked).
    pub changed: usize,
    /// Lines added in the working tree vs HEAD. Counted with the SAME
    /// `git diff HEAD --numstat -M` the diff panel uses, so this total equals the
    /// sum of the panel's per-file `added`. Untracked files have no HEAD side and
    /// are not counted; binary files contribute nothing.
    pub insertions: u32,
    /// Lines removed in the working tree vs HEAD (same source as `insertions`).
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

/// The unified diff for one file, served on demand.
#[derive(Debug, Clone, Serialize)]
pub struct FileDiff {
    /// Raw `git diff` text (or a synthesized all-additions diff for a new file).
    /// Empty when binary or too large.
    pub text: String,
    /// True when the file is binary — show a hint instead of a textual diff.
    pub binary: bool,
    /// True when the diff was larger than the cap and was not loaded.
    pub too_large: bool,
}

/// Largest diff we load into the webview. Keeps a huge generated-file change from
/// freezing the UI; the user can still open the file in their editor.
const DIFF_MAX_BYTES: usize = 1_500_000;

/// List the uncommitted changes for every given folder path, grouped by repo.
/// Paths that are not git repos are skipped, and several paths inside one repo
/// collapse to a single group (de-duplicated by repo top-level).
#[tauri::command]
pub fn git_changed_files(paths: Vec<String>) -> Result<Vec<RepoChanges>, String> {
    let mut seen: HashSet<String> = HashSet::new();
    let mut repos: Vec<RepoChanges> = Vec::new();
    for p in paths {
        let Some(root) = repo_root(&p) else { continue };
        if !seen.insert(root.clone()) {
            continue; // another of this project's paths already covered this repo
        }
        repos.push(changes_for_repo(root));
    }
    Ok(repos)
}

/// The unified diff for one file in one repo. `untracked` (passed from the list)
/// means there is no HEAD side, so we synthesize an all-additions diff from the
/// file's current content rather than calling `git diff`.
#[tauri::command]
pub fn git_file_diff(
    root: String,
    file: String,
    untracked: bool,
    old_path: String,
) -> Result<FileDiff, String> {
    if untracked {
        return untracked_diff(&root, &file);
    }

    // For a rename, pass BOTH the old and new paths so `-M` can pair the deletion
    // of the old path with the addition of the new one and show a real rename
    // diff (including any content change), not a spurious all-additions block.
    let mut args = vec!["-c", "core.quotePath=false", "diff", "HEAD", "-M", "--"];
    if !old_path.is_empty() {
        args.push(old_path.as_str());
    }
    args.push(file.as_str());
    let raw = run_git(&root, &args).unwrap_or_default();

    let binary = raw.lines().any(|l| l.starts_with("Binary files "));
    let too_large = raw.len() > DIFF_MAX_BYTES;
    Ok(FileDiff {
        text: if too_large { String::new() } else { raw },
        binary,
        too_large,
    })
}

/// Build the all-additions diff for an untracked / brand-new file by reading its
/// current content. A file holding a NUL byte is reported binary; an oversized
/// file is reported too-large; neither reads the whole thing into the webview.
fn untracked_diff(root: &str, file: &str) -> Result<FileDiff, String> {
    let full = Path::new(root).join(file);
    let size = std::fs::metadata(&full)
        .map_err(|e| format!("Cannot read file: {e}"))?
        .len() as usize;
    if size > DIFF_MAX_BYTES {
        return Ok(FileDiff {
            text: String::new(),
            binary: false,
            too_large: true,
        });
    }
    let bytes = std::fs::read(&full).map_err(|e| format!("Cannot read file: {e}"))?;
    if bytes.contains(&0) {
        return Ok(FileDiff {
            text: String::new(),
            binary: true,
            too_large: false,
        });
    }
    let content = String::from_utf8_lossy(&bytes);
    Ok(FileDiff {
        text: synthesize_untracked_diff(&content),
        binary: false,
        too_large: false,
    })
}

// --- Per-repo gathering -----------------------------------------------------

/// Resolve a folder path to its git repo top-level, or `None` when it is not a
/// repo (or git is missing / the folder is gone).
fn repo_root(path: &str) -> Option<String> {
    let out = run_git(path, &["rev-parse", "--show-toplevel"])?;
    let root = out.trim();
    if root.is_empty() {
        None
    } else {
        Some(root.to_string())
    }
}

/// Collect one repo's changed files. Tracked changes come from `git diff HEAD`
/// (staged + unstaged combined) and untracked files from `git ls-files
/// --others`. A repo with no commit yet has no HEAD, so every file is "new".
fn changes_for_repo(root: String) -> RepoChanges {
    let branch = branch_of(&root);
    let has_head = run_git(&root, &["rev-parse", "--verify", "-q", "HEAD"]).is_some();

    let mut files: Vec<ChangedFile> = Vec::new();
    if has_head {
        if let Some(ns) = run_git(
            &root,
            &[
                "-c",
                "core.quotePath=false",
                "diff",
                "HEAD",
                "--name-status",
                "-M",
            ],
        ) {
            files = parse_name_status(&ns);
        }
        if let Some(num) = run_git(
            &root,
            &[
                "-c",
                "core.quotePath=false",
                "diff",
                "HEAD",
                "--numstat",
                "-M",
            ],
        ) {
            apply_counts(&mut files, &parse_numstat(&num));
        }
        // Untracked files (not yet `git add`ed) are not in `git diff HEAD`.
        if let Some(others) = run_git(
            &root,
            &[
                "-c",
                "core.quotePath=false",
                "ls-files",
                "--others",
                "--exclude-standard",
            ],
        ) {
            for line in others.lines() {
                if line.is_empty() {
                    continue;
                }
                files.push(new_file(line, "untracked"));
            }
        }
    } else if let Some(st) = run_git(&root, &["-c", "core.quotePath=false", "status", "--porcelain"])
    {
        // Brand-new repo (no HEAD): every staged-or-untracked file is new.
        files = parse_porcelain_as_new(&st);
    }

    RepoChanges {
        root,
        branch,
        files,
    }
}

/// Run `git -C dir <args>`; `Some(stdout)` on a clean exit, `None` otherwise
/// (git missing, folder gone, not a repo, non-zero exit).
fn run_git(dir: &str, args: &[&str]) -> Option<String> {
    let out = Command::new("git")
        .arg("-C")
        .arg(dir)
        .args(args)
        .output()
        .ok()?;
    if out.status.success() {
        Some(String::from_utf8_lossy(&out.stdout).into_owned())
    } else {
        None
    }
}

/// Current branch name, or "(<short-sha>)" / "(detached)" for a detached HEAD.
fn branch_of(root: &str) -> String {
    if let Some(b) = run_git(root, &["branch", "--show-current"]) {
        let b = b.trim();
        if !b.is_empty() {
            return b.to_string();
        }
    }
    if let Some(sha) = run_git(root, &["rev-parse", "--short", "HEAD"]) {
        let sha = sha.trim();
        if !sha.is_empty() {
            return format!("({sha})");
        }
    }
    "(detached)".to_string()
}

// --- Pure parsing helpers (unit-tested below) -------------------------------

/// A fresh "new file" entry whose diff is synthesized from its content.
fn new_file(path: &str, status: &str) -> ChangedFile {
    ChangedFile {
        path: path.to_string(),
        old_path: String::new(),
        display: path.to_string(),
        status: status.to_string(),
        untracked: true,
        added: 0,
        removed: 0,
        binary: false,
    }
}

/// Parse `git diff HEAD --name-status -M` (tab-separated). A rename/copy line is
/// `R<score>\t<old>\t<new>`; every other line is `<code>\t<path>`.
fn parse_name_status(text: &str) -> Vec<ChangedFile> {
    let mut out = Vec::new();
    for line in text.lines() {
        if line.is_empty() {
            continue;
        }
        let mut parts = line.split('\t');
        let code = parts.next().unwrap_or("");
        let kind = code.chars().next().unwrap_or(' ');
        match kind {
            'R' | 'C' => {
                let old = parts.next().unwrap_or("");
                let new = parts.next().unwrap_or("");
                if new.is_empty() {
                    continue;
                }
                out.push(ChangedFile {
                    path: new.to_string(),
                    old_path: old.to_string(),
                    display: format!("{old} → {new}"),
                    status: if kind == 'R' { "renamed" } else { "added" }.to_string(),
                    untracked: false,
                    added: 0,
                    removed: 0,
                    binary: false,
                });
            }
            _ => {
                let p = parts.next().unwrap_or("");
                if p.is_empty() {
                    continue;
                }
                let status = match kind {
                    'A' => "added",
                    'D' => "deleted",
                    _ => "modified", // 'M', 'T' (type change), anything else
                };
                out.push(ChangedFile {
                    path: p.to_string(),
                    old_path: String::new(),
                    display: p.to_string(),
                    status: status.to_string(),
                    untracked: false,
                    added: 0,
                    removed: 0,
                    binary: false,
                });
            }
        }
    }
    out
}

/// Parse `git diff HEAD --numstat -M` into `(path, added, removed, binary)`. A
/// binary file shows `-\t-\t<path>`. Rename paths look like `old => new` or
/// `{a => b}/c`; `normalize_numstat_path` reduces them to the new path so they
/// match the name-status entries.
fn parse_numstat(text: &str) -> Vec<(String, u32, u32, bool)> {
    let mut out = Vec::new();
    for line in text.lines() {
        let mut parts = line.splitn(3, '\t');
        let a = parts.next().unwrap_or("");
        let d = parts.next().unwrap_or("");
        let path = parts.next().unwrap_or("");
        if path.is_empty() {
            continue;
        }
        let path = normalize_numstat_path(path);
        if a == "-" || d == "-" {
            out.push((path, 0, 0, true));
        } else {
            out.push((path, a.parse().unwrap_or(0), d.parse().unwrap_or(0), false));
        }
    }
    out
}

/// Reduce a numstat rename path to the new path:
///   "{src/a => src/b}/file" -> "src/b/file"
///   "old => new"            -> "new"
///   "plain/path"            -> unchanged
fn normalize_numstat_path(p: &str) -> String {
    if let Some(start) = p.find('{') {
        let rest = &p[start..];
        if let (Some(arrow), Some(end)) = (rest.find(" => "), rest.find('}')) {
            if arrow < end {
                let prefix = &p[..start];
                let new = &rest[arrow + 4..end];
                let suffix = &rest[end + 1..];
                return format!("{prefix}{new}{suffix}");
            }
        }
    }
    if let Some(arrow) = p.find(" => ") {
        return p[arrow + 4..].to_string();
    }
    p.to_string()
}

/// Copy `(added, removed, binary)` onto each file by matching its path.
fn apply_counts(files: &mut [ChangedFile], counts: &[(String, u32, u32, bool)]) {
    for f in files.iter_mut() {
        if let Some((_, a, d, bin)) = counts.iter().find(|(p, ..)| *p == f.path) {
            f.added = *a;
            f.removed = *d;
            f.binary = *bin;
        }
    }
}

/// Parse `git status --porcelain` for a repo with no commit yet: every entry is
/// a new file (staged add `A ` or untracked `??`), diffed by content synthesis.
fn parse_porcelain_as_new(text: &str) -> Vec<ChangedFile> {
    let mut out = Vec::new();
    for line in text.lines() {
        if line.len() < 4 {
            continue;
        }
        let xy = &line[..2];
        let path = line[3..].trim();
        if path.is_empty() {
            continue;
        }
        let status = if xy.contains('?') { "untracked" } else { "added" };
        out.push(new_file(path, status));
    }
    out
}

/// Build an all-additions unified diff (`@@ -0,0 +1,N @@` then `+`-prefixed
/// lines) for a new file from its content. Empty content yields empty text.
fn synthesize_untracked_diff(content: &str) -> String {
    let lines: Vec<&str> = content.lines().collect();
    if lines.is_empty() {
        return String::new();
    }
    let mut s = format!("@@ -0,0 +1,{} @@\n", lines.len());
    for l in lines {
        s.push('+');
        s.push_str(l);
        s.push('\n');
    }
    s
}

// --- Per-path summary (Dashboard grid + sidebar line counts) ----------------

/// Run a git summary for every path. One `GitStatus` per input path, in the same
/// order. Failures fall back to a `not_repo` entry so the grid always renders.
#[tauri::command]
pub fn git_status_summary(paths: Vec<String>) -> Result<Vec<GitStatus>, String> {
    Ok(paths.into_iter().map(status_for_path).collect())
}

/// Summarize one path: branch + ahead/behind + changed-entry count from
/// `git status --porcelain=v2 --branch`, then the +/- line totals from the shared
/// numstat (the same source the diff panel uses). Any error yields a `not_repo`
/// entry rather than propagating.
fn status_for_path(path: String) -> GitStatus {
    let Some(text) = run_git(&path, &["status", "--porcelain=v2", "--branch"]) else {
        return GitStatus::not_repo(path);
    };
    let mut status = parse_status(path.clone(), &text);
    let (insertions, deletions) = diff_line_counts(&path);
    status.insertions = insertions;
    status.deletions = deletions;
    status
}

/// Sum a repo's working-tree-vs-HEAD line changes using the SAME
/// `git diff HEAD --numstat -M` the file list uses, so this total equals the sum
/// of the panel's per-file counts. Falls back to a no-HEAD diff for a repo with
/// no commits yet. Untracked files are not counted (no HEAD side); binary files
/// contribute nothing.
fn diff_line_counts(path: &str) -> (u32, u32) {
    let text = run_git(
        path,
        &["-c", "core.quotePath=false", "diff", "HEAD", "--numstat", "-M"],
    )
    .or_else(|| run_git(path, &["-c", "core.quotePath=false", "diff", "--numstat", "-M"]))
    .unwrap_or_default();
    sum_numstat(&text)
}

/// Total the added / removed columns across all files of one numstat output,
/// reusing the shared per-file `parse_numstat` so both views count identically.
fn sum_numstat(text: &str) -> (u32, u32) {
    let mut insertions = 0u32;
    let mut deletions = 0u32;
    for (_, added, removed, _binary) in parse_numstat(text) {
        insertions += added;
        deletions += removed;
    }
    (insertions, deletions)
}

/// Parse porcelain v2 `--branch` text into a `GitStatus` (branch, ahead/behind,
/// changed-entry count). Line counts are filled in later by `status_for_path`.
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

    GitStatus {
        path,
        branch,
        changed,
        insertions: 0, // filled by status_for_path via diff_line_counts
        deletions: 0,
        ahead,
        behind,
        is_repo: true,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn name_status_parses_modify_add_delete() {
        let files = parse_name_status("M\tsrc/a.rs\nA\tsrc/b.rs\nD\tsrc/c.rs\n");
        assert_eq!(files.len(), 3);
        assert_eq!(files[0].status, "modified");
        assert_eq!(files[0].path, "src/a.rs");
        assert_eq!(files[1].status, "added");
        assert_eq!(files[2].status, "deleted");
        assert!(!files[0].untracked);
    }

    #[test]
    fn name_status_parses_rename_with_old_new_display() {
        let files = parse_name_status("R096\told/name.rs\tnew/name.rs\n");
        assert_eq!(files.len(), 1);
        assert_eq!(files[0].status, "renamed");
        assert_eq!(files[0].path, "new/name.rs"); // the NEW path is the key
        assert_eq!(files[0].old_path, "old/name.rs"); // OLD path kept for the diff
        assert_eq!(files[0].display, "old/name.rs → new/name.rs");
    }

    #[test]
    fn name_status_skips_blank_lines() {
        assert!(parse_name_status("\n\n").is_empty());
    }

    #[test]
    fn numstat_parses_counts_and_binary() {
        let counts = parse_numstat("12\t3\tsrc/a.rs\n-\t-\tassets/logo.png\n");
        assert_eq!(counts[0], ("src/a.rs".to_string(), 12, 3, false));
        assert_eq!(counts[1], ("assets/logo.png".to_string(), 0, 0, true));
    }

    #[test]
    fn numstat_normalizes_rename_paths() {
        assert_eq!(normalize_numstat_path("old.rs => new.rs"), "new.rs");
        assert_eq!(
            normalize_numstat_path("{src/a => src/b}/file.rs"),
            "src/b/file.rs"
        );
        assert_eq!(normalize_numstat_path("plain/path.rs"), "plain/path.rs");
    }

    #[test]
    fn apply_counts_matches_by_path() {
        let mut files = parse_name_status("M\tsrc/a.rs\n");
        apply_counts(&mut files, &[("src/a.rs".to_string(), 5, 2, false)]);
        assert_eq!(files[0].added, 5);
        assert_eq!(files[0].removed, 2);
        assert!(!files[0].binary);
    }

    #[test]
    fn porcelain_as_new_splits_staged_and_untracked() {
        let files = parse_porcelain_as_new("A  staged.rs\n?? untracked.rs\n");
        assert_eq!(files.len(), 2);
        assert_eq!(files[0].status, "added");
        assert!(files[0].untracked); // diffed by content synthesis
        assert_eq!(files[1].status, "untracked");
    }

    #[test]
    fn synthesize_untracked_builds_all_additions() {
        let diff = synthesize_untracked_diff("line one\nline two\n");
        assert_eq!(diff, "@@ -0,0 +1,2 @@\n+line one\n+line two\n");
    }

    #[test]
    fn synthesize_untracked_empty_is_empty() {
        assert_eq!(synthesize_untracked_diff(""), "");
    }

    #[test]
    fn sum_numstat_totals_added_and_deleted() {
        assert_eq!(sum_numstat("1\t10\tsrc/a.rs\n124\t14\tsrc/b.rs\n"), (125, 24));
    }

    #[test]
    fn sum_numstat_skips_binary_dash_rows() {
        // Binary files report "-" for both counts; they must add nothing.
        assert_eq!(sum_numstat("-\t-\timg.png\n5\t2\tsrc/c.rs\n"), (5, 2));
    }

    #[test]
    fn sum_numstat_empty_output_is_zero() {
        assert_eq!(sum_numstat(""), (0, 0));
    }

    #[test]
    fn parse_status_reads_branch_ahead_behind_and_changed() {
        let text = "# branch.head main\n# branch.ab +2 -1\n1 .M N... 100644 100644 100644 aaa bbb file.rs\n";
        let status = parse_status("/tmp/x".into(), text);
        assert_eq!(status.branch, "main");
        assert_eq!(status.ahead, 2);
        assert_eq!(status.behind, 1);
        assert_eq!(status.changed, 1);
        // Line counts are filled later, not by parse_status.
        assert_eq!((status.insertions, status.deletions), (0, 0));
    }
}
