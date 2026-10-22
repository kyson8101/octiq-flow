//! Git operation state for a linked worktree, without granting its shared git dir.
use std::path::{Path, PathBuf};
use std::process::Command;

use crate::agent_provider::Access;

fn linked_worktree(cwd: &Path, access: Option<Access>) -> Option<(PathBuf, PathBuf)> {
    if !matches!(access, Some(Access::Auto | Access::Edits)) {
        return None;
    }
    let mut command = Command::new("git");
    crate::proc::no_console(&mut command);
    let Ok(output) = command
        .current_dir(cwd)
        .args([
            "rev-parse",
            "--path-format=absolute",
            "--git-common-dir",
            "--git-dir",
            "--show-toplevel",
        ])
        .output()
    else {
        return None;
    };
    if !output.status.success() {
        return None;
    }
    let text = String::from_utf8_lossy(&output.stdout);
    let paths: Vec<_> = text.lines().map(PathBuf::from).collect();
    if paths.len() != 3 {
        return None;
    }
    let Ok(common) = crate::paths::canonicalize(&paths[0]) else {
        return None;
    };
    // Inspect Git's original admin path BEFORE canonicalizing it: following
    // a redirected worktrees/<name> would grant another worktree's files.
    let Ok(relative) = paths[1].strip_prefix(&paths[0]) else {
        return None;
    };
    let admin = relative
        .components()
        .fold(common.clone(), |path, part| path.join(part));
    if admin.parent() != Some(common.join("worktrees").as_path())
        || !unredirected(&common, &admin, true)
        || crate::paths::canonicalize(&admin).ok().as_ref() != Some(&admin)
        || !admin_points_back(&common, &admin, &paths[2])
    {
        return None;
    }
    Some((common, admin))
}

/// Only a validated linked worktree's existing, non-protected branch.
/// The host uses these parents to prepare empty folders, never ref contents.
pub(crate) fn branch_parents(
    cwd: &Path,
    access: Option<Access>,
) -> Option<(PathBuf, [PathBuf; 2])> {
    let (common, _) = linked_worktree(cwd, access)?;
    let branch = current_branch(cwd)?;
    let parents = [common.clone(), common.join("logs")].map(|base| {
        let file = branch.split('/').fold(base, |path, part| path.join(part));
        file.parent().unwrap().to_path_buf()
    });
    Some((common, parents))
}

pub(crate) fn commit_roots(cwd: &Path, access: Option<Access>) -> Vec<String> {
    let Some((common, admin)) = linked_worktree(cwd, access) else {
        return Vec::new();
    };
    let mut roots = vec![common.join("objects")];
    // Never grant refs/ or common logs/: either admits every other branch.
    // File roots include the lock separately, even for feature/x. Codex's
    // sandbox can create that lock without granting its parent directory.
    if let Some(branch) = current_branch(cwd) {
        for base in [common.clone(), common.join("logs")] {
            // Git prints slash-separated refs on every platform. Join each
            // component so Windows roots use native separators too.
            let path = branch.split('/').fold(base, |path, part| path.join(part));
            roots.push(path.with_file_name(format!(
                "{}.lock",
                path.file_name().unwrap().to_string_lossy()
            )));
            roots.push(path);
        }
    }
    // Pseudo-refs updated through the ref API need separate lock files.
    // MERGE_MSG is also locked by the sequencer; other merge files and
    // FETCH_HEAD are written directly by Git.
    for name in [
        "index",
        "HEAD",
        "AUTO_MERGE",
        "ORIG_HEAD",
        "CHERRY_PICK_HEAD",
        "REVERT_HEAD",
        "MERGE_MSG",
    ] {
        roots.push(admin.join(name));
        roots.push(admin.join(format!("{name}.lock")));
    }
    roots.extend(
        [
            "COMMIT_EDITMSG",
            "MERGE_HEAD",
            "MERGE_MODE",
            "SQUASH_MSG",
            "FETCH_HEAD",
        ]
        .map(|name| admin.join(name)),
    );
    // Codex 0.163 protects directory roots themselves from rmdir. Granting
    // rebase-merge/rebase-apply/sequencer would let Git rewrite HEAD and then
    // fail cleanup, leaving an in-progress operation. Refuse their creation
    // early instead of admitting the whole admin directory.
    let directories = [common.join("objects"), admin.join("logs")];
    roots.extend(directories.iter().skip(1).cloned());
    roots
        .into_iter()
        // Keep the grant at the path Git named, never a redirected target.
        .filter(|path| unredirected(&common, path, directories.contains(path)))
        .map(|path| path.to_string_lossy().into_owned())
        .collect()
}

fn admin_points_back(common: &Path, admin: &Path, worktree: &Path) -> bool {
    let back = admin.join("gitdir");
    let dotgit = worktree.join(".git");
    if !unredirected(common, &back, false)
        || !std::fs::symlink_metadata(&dotgit).is_ok_and(|m| m.is_file() && !m.is_symlink())
    {
        return false;
    }
    let Ok(back) = std::fs::read_to_string(back) else {
        return false;
    };
    let back = Path::new(back.trim_end_matches(['\r', '\n']));
    // Relative back-pointers are interpreted from the admin folder by Git.
    let back = if back.is_absolute() {
        back.to_path_buf()
    } else {
        admin.join(back)
    };
    match (
        crate::paths::canonicalize(back),
        crate::paths::canonicalize(dotgit),
    ) {
        (Ok(back), Ok(dotgit)) => back == dotgit,
        _ => false,
    }
}

fn current_branch(cwd: &Path) -> Option<String> {
    let mut command = Command::new("git");
    crate::proc::no_console(&mut command);
    let output = command
        .current_dir(cwd)
        .args(["symbolic-ref", "--quiet", "HEAD"])
        .output()
        .ok()?;
    if !output.status.success() {
        return None;
    }
    let branch = String::from_utf8(output.stdout).ok()?;
    let branch = branch.trim_end_matches(['\r', '\n']);
    // Task branches are ASCII; refuse Unicode case/normalization aliases on APFS/NTFS.
    if !branch.is_ascii() || !branch.starts_with("refs/heads/") {
        return None;
    }
    // show-ref can resolve a case alias through a loose ref on APFS/NTFS.
    // Require Git's listed spelling, and refuse even a listed spelling when
    // another ref would share its path on a case-insensitive filesystem.
    let branches = git_text(cwd, &["for-each-ref", "--format=%(refname)", "refs/heads/"])?;
    if !branches.lines().any(|listed| listed == branch)
        || branches
            .lines()
            .any(|listed| listed != branch && listed.eq_ignore_ascii_case(branch))
    {
        return None;
    }
    // HEAD is writable inside the worker's admin files. Switching it must
    // never turn a subsequent launch/resume into a protected-ref grant.
    if ["refs/heads/main", "refs/heads/master", "refs/heads/develop"]
        .iter()
        .any(|protected| branch.eq_ignore_ascii_case(protected))
    {
        return None;
    }
    // The first porcelain entry is the primary checkout, even when this
    // command runs from a linked worktree. Fail closed if it cannot be read.
    let worktrees = git_text(cwd, &["worktree", "list", "--porcelain"])?;
    if !worktrees.starts_with("worktree ")
        || worktrees
            .lines()
            .take_while(|line| !line.is_empty())
            .filter_map(|line| line.strip_prefix("branch "))
            .any(|primary| primary.eq_ignore_ascii_case(branch))
    {
        return None;
    }
    if let Some(default) = git_text(
        cwd,
        &["symbolic-ref", "--quiet", "refs/remotes/origin/HEAD"],
    ) {
        if default
            .strip_prefix("refs/remotes/origin/")
            .is_some_and(|default| branch["refs/heads/".len()..].eq_ignore_ascii_case(default))
        {
            return None;
        }
    }
    // Reject malformed and unborn refs rather than granting a path derived
    // from an arbitrary HEAD. Packed existing branches are valid too.
    for args in [
        vec!["check-ref-format", branch],
        vec!["show-ref", "--verify", "--quiet", branch],
    ] {
        let mut command = Command::new("git");
        crate::proc::no_console(&mut command);
        if !command
            .current_dir(cwd)
            .args(args)
            .output()
            .ok()?
            .status
            .success()
        {
            return None;
        }
    }
    Some(branch.to_owned())
}

fn git_text(cwd: &Path, args: &[&str]) -> Option<String> {
    let mut command = Command::new("git");
    crate::proc::no_console(&mut command);
    let output = command.current_dir(cwd).args(args).output().ok()?;
    output.status.success().then_some(())?;
    Some(
        String::from_utf8(output.stdout)
            .ok()?
            .trim_end_matches(['\r', '\n'])
            .to_owned(),
    )
}

pub(crate) fn unredirected(common: &Path, path: &Path, directory: bool) -> bool {
    let Ok(relative) = path.strip_prefix(common) else {
        return false;
    };
    let mut cursor = common.to_path_buf();
    for part in relative.components() {
        cursor.push(part);
        match std::fs::symlink_metadata(&cursor) {
            Ok(meta) if meta.is_symlink() => return false,
            Ok(meta) if cursor == path => {
                // A file replaced by a directory must not become a subtree grant.
                return if directory {
                    meta.is_dir()
                } else {
                    meta.is_file()
                };
            }
            Ok(meta) if !meta.is_dir() => return false,
            Ok(_) => {}
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return true,
            Err(_) => return false,
        }
    }
    false
}

#[cfg(test)]
mod tests {
    use super::*;

    fn git(cwd: &Path, args: &[&str]) {
        let out = Command::new("git")
            .current_dir(cwd)
            .args(args)
            .output()
            .unwrap();
        assert!(
            out.status.success(),
            "{}",
            String::from_utf8_lossy(&out.stderr)
        );
    }

    fn fixture() -> (crate::test_dir::TestDir, PathBuf) {
        let dir = crate::test_dir::TestDir::new("codex-commit-roots");
        git(&dir, &["init", "-q", "-b", "fixture"]);
        git(
            &dir,
            &[
                "-c",
                "user.name=Test",
                "-c",
                "user.email=test@example.invalid",
                "commit",
                "--allow-empty",
                "-qm",
                "fixture",
            ],
        );
        let work = dir.join("linked");
        git(
            &dir,
            &[
                "worktree",
                "add",
                "-qb",
                "feature/x",
                work.to_str().unwrap(),
            ],
        );
        (dir, work)
    }

    #[test]
    fn only_git_operation_storage_in_the_linked_worktree_is_added() {
        let (dir, work) = fixture();
        let common = crate::paths::canonicalize(dir.join(".git")).unwrap();
        let admin = common.join("worktrees").join("linked");
        for access in [Access::Auto, Access::Edits] {
            let roots = commit_roots(&work, Some(access));
            let expected = vec![
                common.join("objects"),
                common
                    .join("refs")
                    .join("heads")
                    .join("feature")
                    .join("x.lock"),
                common.join("refs").join("heads").join("feature").join("x"),
                common
                    .join("logs")
                    .join("refs")
                    .join("heads")
                    .join("feature")
                    .join("x.lock"),
                common
                    .join("logs")
                    .join("refs")
                    .join("heads")
                    .join("feature")
                    .join("x"),
                admin.join("index"),
                admin.join("index.lock"),
                admin.join("HEAD"),
                admin.join("HEAD.lock"),
                admin.join("AUTO_MERGE"),
                admin.join("AUTO_MERGE.lock"),
                admin.join("ORIG_HEAD"),
                admin.join("ORIG_HEAD.lock"),
                admin.join("CHERRY_PICK_HEAD"),
                admin.join("CHERRY_PICK_HEAD.lock"),
                admin.join("REVERT_HEAD"),
                admin.join("REVERT_HEAD.lock"),
                admin.join("MERGE_MSG"),
                admin.join("MERGE_MSG.lock"),
                admin.join("COMMIT_EDITMSG"),
                admin.join("MERGE_HEAD"),
                admin.join("MERGE_MODE"),
                admin.join("SQUASH_MSG"),
                admin.join("FETCH_HEAD"),
                admin.join("logs"),
            ];
            assert_eq!(
                roots.iter().map(PathBuf::from).collect::<Vec<_>>(),
                expected
            );
            for protected in [
                common.clone(),
                common.join("refs").join("heads").join("develop"),
                common.join("refs").join("heads").join("main"),
                common
                    .join("logs")
                    .join("refs")
                    .join("heads")
                    .join("develop"),
                common.join("packed-refs"),
                common.join("hooks").join("x"),
                common.join("config"),
                admin.join("config.worktree"),
                common.join("worktrees").join("other").join("index"),
                admin.join("rebase-merge"),
                admin.join("rebase-apply"),
                admin.join("sequencer"),
                admin.join("MERGE_AUTOSTASH"),
                admin.join("REBASE_HEAD"),
            ] {
                assert!(
                    !roots.iter().any(|root| protected.starts_with(root)),
                    "{protected:?}: {roots:?}"
                );
            }
            let workspace = vec![
                work.to_string_lossy().into_owned(),
                dir.join("docs").to_string_lossy().into_owned(),
            ];
            for resume in [None, Some("native-thread")] {
                let request = crate::codex_app_server::thread_request(
                    crate::codex_app_server::ThreadRequest {
                        cwd: work.to_str().unwrap(),
                        model: None,
                        effort: Some("high"),
                        access: Some(access),
                        resume,
                        workspace_roots: &workspace,
                        developer_instructions: "host",
                    },
                );
                let configured = request["params"]["config"]
                    ["sandbox_workspace_write.writable_roots"]
                    .as_array()
                    .unwrap();
                for root in &roots {
                    assert!(configured.contains(&serde_json::json!(root)));
                }
                assert_eq!(
                    request["params"]["runtimeWorkspaceRoots"],
                    serde_json::json!(workspace)
                );
                assert_eq!(
                    request["params"]["config"]["model_reasoning_effort"],
                    "high"
                );
            }
            let turn =
                crate::codex_app_server::turn_request(crate::codex_app_server::TurnRequest {
                    id: "turn",
                    thread_id: "native-thread",
                    text: "commit",
                    images: &[],
                    client_user_message_id: None,
                    cwd: work.to_str().unwrap(),
                    workspace_roots: &workspace,
                    model: None,
                    effort: None,
                    access: Some(access),
                    runtime_context: "host",
                });
            assert_eq!(turn["params"]["sandboxPolicy"]["networkAccess"], false);
            let configured = turn["params"]["sandboxPolicy"]["writableRoots"]
                .as_array()
                .unwrap();
            for root in &roots {
                assert!(configured.contains(&serde_json::json!(root)));
            }
            for root in &workspace {
                assert!(configured.contains(&serde_json::json!(root)));
            }
        }
        for access in [
            None,
            Some(Access::Read),
            Some(Access::Manual),
            Some(Access::Full),
        ] {
            assert!(commit_roots(&work, access).is_empty());
        }
        assert!(commit_roots(&dir, Some(Access::Auto)).is_empty());
        assert!(commit_roots(&dir.join("missing"), Some(Access::Auto)).is_empty());
    }

    #[test]
    fn host_prepares_only_empty_branch_parents_at_auto_and_edits() {
        let (dir, work) = fixture();
        let common = crate::paths::canonicalize(dir.join(".git")).unwrap();
        git(&dir, &["pack-refs", "--all"]);
        let parents = [
            common.join("refs").join("heads").join("feature"),
            common
                .join("logs")
                .join("refs")
                .join("heads")
                .join("feature"),
        ];
        for parent in &parents {
            if parent.exists() {
                std::fs::remove_dir_all(parent).unwrap();
            }
        }
        for access in [
            None,
            Some(Access::Read),
            Some(Access::Manual),
            Some(Access::Full),
        ] {
            crate::git_ops::prepare_codex_branch_parents(&work, access);
            assert!(parents.iter().all(|parent| !parent.exists()));
        }
        for access in [Access::Auto, Access::Edits] {
            let roots = commit_roots(&work, Some(access));
            assert!(
                parents.iter().all(|parent| !parent.exists()),
                "root lookup stays read-only"
            );
            crate::git_ops::prepare_codex_branch_parents(&work, Some(access));
            for parent in &parents {
                assert!(parent.is_dir());
                assert_eq!(std::fs::read_dir(parent).unwrap().count(), 0);
            }
            assert_eq!(commit_roots(&work, Some(access)), roots);
            for parent in &parents {
                std::fs::remove_dir(parent).unwrap();
            }
        }
    }

    #[cfg(unix)]
    #[test]
    fn host_branch_preparation_refuses_redirected_or_file_parents() {
        let (dir, work) = fixture();
        let common = crate::paths::canonicalize(dir.join(".git")).unwrap();
        git(&dir, &["pack-refs", "--all"]);
        let refs = common.join("refs").join("heads").join("feature");
        let logs = common
            .join("logs")
            .join("refs")
            .join("heads")
            .join("feature");
        for parent in [&refs, &logs] {
            if parent.exists() {
                std::fs::remove_dir_all(parent).unwrap();
            }
        }
        let outside = crate::test_dir::TestDir::new("codex-branch-parent-redirect");
        std::os::unix::fs::symlink(&outside, &refs).unwrap();
        std::fs::write(&logs, "not a directory").unwrap();
        crate::git_ops::prepare_codex_branch_parents(&work, Some(Access::Auto));
        assert_eq!(std::fs::read_dir(&outside).unwrap().count(), 0);
        assert_eq!(std::fs::read_to_string(logs).unwrap(), "not a directory");
    }

    fn assert_no_branch_grant(dir: &Path, roots: &[String]) {
        let common = crate::paths::canonicalize(dir.join(".git")).unwrap();
        // objects/ and all existing own-admin grants remain available.
        assert_eq!(roots.len(), 21, "{roots:?}");
        assert!(roots
            .iter()
            .any(|root| Path::new(root) == common.join("objects")));
        assert!(roots.iter().any(|root| {
            Path::new(root) == common.join("worktrees").join("linked").join("HEAD")
        }));
        assert!(
            !roots.iter().any(|root| {
                Path::new(root).starts_with(common.join("refs"))
                    || Path::new(root).starts_with(common.join("logs"))
            }),
            "{roots:?}"
        );
    }

    #[test]
    fn switching_head_to_protected_branches_gets_no_ref_or_reflog_grant() {
        let (dir, work) = fixture();
        for branch in ["main", "master", "develop", "trunk"] {
            git(&dir, &["branch", branch]);
        }
        git(
            &dir,
            &[
                "symbolic-ref",
                "refs/remotes/origin/HEAD",
                "refs/remotes/origin/trunk",
            ],
        );
        for branch in ["main", "master", "develop", "fixture", "trunk"] {
            git(&work, &["switch", "--ignore-other-worktrees", branch]);
            for access in [Access::Auto, Access::Edits] {
                let roots = commit_roots(&work, Some(access));
                assert_no_branch_grant(&dir, &roots);
                assert!(branch_parents(&work, Some(access)).is_none());
            }
        }
        git(&work, &["switch", "feature/x"]);
        assert_eq!(commit_roots(&work, Some(Access::Edits)).len(), 25);
    }

    fn assert_branch_refused(dir: &Path, work: &Path, branch: &str) {
        git(work, &["symbolic-ref", "HEAD", branch]);
        assert_eq!(current_branch(work), None, "{branch}");
        for access in [Access::Auto, Access::Edits] {
            assert_no_branch_grant(dir, &commit_roots(work, Some(access)));
            assert!(branch_parents(work, Some(access)).is_none(), "{branch}");
        }
    }

    #[test]
    fn unlisted_case_aliases_get_no_branch_grant_or_parent_preparation() {
        let (dir, work) = fixture();
        for branch in ["main", "master", "develop", "trunk", "feature/octiq-other"] {
            git(&dir, &["branch", branch]);
        }
        git(
            &dir,
            &[
                "symbolic-ref",
                "refs/remotes/origin/HEAD",
                "refs/remotes/origin/trunk",
            ],
        );
        let listed = git_text(
            &work,
            &["for-each-ref", "--format=%(refname)", "refs/heads/"],
        )
        .unwrap();
        for branch in [
            "refs/heads/MAIN",
            "refs/heads/Main",
            "refs/heads/mAster",
            "refs/heads/DEVELOP",
            "refs/heads/FIXTURE",
            "refs/heads/TRUNK",
            "refs/heads/FEATURE/octiq-other",
        ] {
            assert!(!listed.lines().any(|name| name == branch));
            assert_branch_refused(&dir, &work, branch);
        }
        // Even packed-only aliases must not make differently cased parents.
        git(&dir, &["pack-refs", "--all"]);
        let common = dir.join(".git");
        for base in [common.join("refs/heads"), common.join("logs/refs/heads")] {
            let parent = base.join("feature");
            if parent.exists() {
                std::fs::remove_dir_all(parent).unwrap();
            }
        }
        for access in [Access::Auto, Access::Edits] {
            crate::git_ops::prepare_codex_branch_parents(&work, Some(access));
            for base in [common.join("refs/heads"), common.join("logs/refs/heads")] {
                assert!(!base.join("feature").exists());
                assert!(!base.join("FEATURE").exists());
            }
        }
    }

    #[test]
    fn exactly_listed_protected_names_are_matched_without_regard_to_ascii_case() {
        for branch in ["MAIN", "Main", "mAster", "DEVELOP"] {
            let (dir, work) = fixture();
            git(&dir, &["branch", branch]);
            let branch = format!("refs/heads/{branch}");
            let listed = git_text(
                &work,
                &["for-each-ref", "--format=%(refname)", "refs/heads/"],
            )
            .unwrap();
            assert!(listed.lines().any(|name| name == branch));
            assert_branch_refused(&dir, &work, &branch);
        }
    }

    #[test]
    fn exactly_listed_primary_and_origin_default_case_aliases_are_refused() {
        let (dir, work) = fixture();
        // The primary HEAD may itself use a different spelling from the list.
        git(&dir, &["symbolic-ref", "HEAD", "refs/heads/FIXTURE"]);
        assert_branch_refused(&dir, &work, "refs/heads/fixture");

        git(&work, &["branch", "trunk"]);
        git(
            &work,
            &[
                "symbolic-ref",
                "refs/remotes/origin/HEAD",
                "refs/remotes/origin/TRUNK",
            ],
        );
        assert_branch_refused(&dir, &work, "refs/heads/trunk");
    }

    #[test]
    fn listed_branches_with_ascii_case_collisions_are_both_refused() {
        let (dir, work) = fixture();
        git(&dir, &["branch", "feature/octiq-other"]);
        git(&dir, &["pack-refs", "--all"]);
        // Packed refs can represent both spellings even on APFS/NTFS.
        let packed = dir.join(".git").join("packed-refs");
        let text = std::fs::read_to_string(&packed).unwrap();
        let mut lines: Vec<_> = text
            .lines()
            .filter(|line| !line.starts_with('#'))
            .map(str::to_owned)
            .collect();
        let head = git_text(&work, &["rev-parse", "HEAD"]).unwrap();
        lines.push(format!("{head} refs/heads/FEATURE/octiq-other"));
        lines.sort_unstable_by(|a, b| {
            a.split_once(' ')
                .unwrap()
                .1
                .cmp(b.split_once(' ').unwrap().1)
        });
        std::fs::write(
            packed,
            format!(
                "# pack-refs with: peeled fully-peeled sorted \n{}\n",
                lines.join("\n")
            ),
        )
        .unwrap();
        let listed = git_text(
            &work,
            &["for-each-ref", "--format=%(refname)", "refs/heads/"],
        )
        .unwrap();
        for branch in [
            "refs/heads/feature/octiq-other",
            "refs/heads/FEATURE/octiq-other",
        ] {
            assert!(listed.lines().any(|name| name == branch));
            assert_branch_refused(&dir, &work, branch);
        }
        git(&work, &["symbolic-ref", "HEAD", "refs/heads/feature/x"]);
        assert_eq!(
            current_branch(&work).as_deref(),
            Some("refs/heads/feature/x")
        );
    }

    #[test]
    fn exactly_listed_non_ascii_kelvin_branch_is_refused() {
        let (dir, work) = fixture();
        let branch = "refs/heads/feature/\u{212a}elvin";
        git(&dir, &["branch", "feature/\u{212a}elvin"]);
        let listed = git_text(
            &work,
            &["for-each-ref", "--format=%(refname)", "refs/heads/"],
        )
        .unwrap();
        assert!(listed.lines().any(|name| name == branch));
        assert_branch_refused(&dir, &work, branch);
    }

    #[test]
    fn detached_unborn_and_non_branch_heads_get_no_branch_grant() {
        let (dir, work) = fixture();
        let common = crate::paths::canonicalize(dir.join(".git")).unwrap();
        git(&work, &["checkout", "--detach", "-q"]);
        for head in [None, Some("refs/heads/unborn"), Some("refs/tags/odd")] {
            if let Some(head) = head {
                git(&work, &["symbolic-ref", "HEAD", head]);
            }
            assert_eq!(current_branch(&work), None);
            assert!(branch_parents(&work, Some(Access::Edits)).is_none());
            let roots = commit_roots(&work, Some(Access::Edits));
            assert_eq!(roots.len(), 21, "{head:?}: {roots:?}");
            assert!(!roots.iter().any(|root| {
                Path::new(root).starts_with(common.join("refs"))
                    || Path::new(root).starts_with(common.join("logs"))
            }));
        }
        std::fs::write(
            common.join("worktrees").join("linked").join("HEAD"),
            "ref: refs/heads/../main\n",
        )
        .unwrap();
        assert!(current_branch(&work).is_none());
        let roots = commit_roots(&work, Some(Access::Edits));
        assert_eq!(roots.len(), 21);
        assert!(!roots.iter().any(|root| {
            Path::new(root).starts_with(common.join("refs"))
                || Path::new(root).starts_with(common.join("logs"))
        }));
    }

    #[cfg(unix)]
    fn redirect_admin(dir: &Path) -> PathBuf {
        let other = dir.join("other");
        git(
            dir,
            &["worktree", "add", "-qb", "other", other.to_str().unwrap()],
        );
        let common = crate::paths::canonicalize(dir.join(".git")).unwrap();
        std::fs::rename(
            common.join("worktrees").join("linked"),
            common.join("worktrees").join("held"),
        )
        .unwrap();
        std::os::unix::fs::symlink(
            common.join("worktrees").join("other"),
            common.join("worktrees").join("linked"),
        )
        .unwrap();
        common
    }

    #[cfg(unix)]
    #[test]
    fn redirected_admin_or_foreign_back_pointer_gets_no_roots() {
        let (dir, work) = fixture();
        let common = redirect_admin(&dir);
        assert!(commit_roots(&work, Some(Access::Auto)).is_empty());
        std::fs::remove_file(common.join("worktrees").join("linked")).unwrap();
        std::fs::rename(
            common.join("worktrees").join("held"),
            common.join("worktrees").join("linked"),
        )
        .unwrap();
        std::fs::write(
            common.join("worktrees").join("linked").join("gitdir"),
            dir.join("other").join(".git").to_str().unwrap(),
        )
        .unwrap();
        assert!(commit_roots(&work, Some(Access::Edits)).is_empty());
        // A redirect one level above the admin must be refused too.
        std::fs::write(
            common.join("worktrees").join("linked").join("gitdir"),
            work.join(".git").to_str().unwrap(),
        )
        .unwrap();
        assert!(!commit_roots(&work, Some(Access::Auto)).is_empty());
        std::fs::rename(common.join("worktrees"), dir.join("moved-admins")).unwrap();
        std::os::unix::fs::symlink(dir.join("moved-admins"), common.join("worktrees")).unwrap();
        assert!(commit_roots(&work, Some(Access::Auto)).is_empty());
    }

    #[cfg(unix)]
    #[test]
    fn redirected_files_and_parent_directories_are_not_granted() {
        use std::os::unix::fs::symlink;
        let (dir, work) = fixture();
        let common = crate::paths::canonicalize(dir.join(".git")).unwrap();
        let admin = common.join("worktrees").join("linked");
        let outside = crate::test_dir::TestDir::new("codex-roots-outside");
        symlink(
            outside.join("lock"),
            common
                .join("refs")
                .join("heads")
                .join("feature")
                .join("x.lock"),
        )
        .unwrap();
        std::fs::rename(
            common
                .join("logs")
                .join("refs")
                .join("heads")
                .join("feature"),
            outside.join("feature"),
        )
        .unwrap();
        symlink(
            outside.join("feature"),
            common
                .join("logs")
                .join("refs")
                .join("heads")
                .join("feature"),
        )
        .unwrap();
        symlink(outside.join("message"), admin.join("COMMIT_EDITMSG")).unwrap();
        symlink(outside.join("merge-head"), admin.join("MERGE_HEAD")).unwrap();
        symlink(outside.join("rebase"), admin.join("rebase-merge")).unwrap();
        std::fs::write(admin.join("rebase-apply"), "not a directory").unwrap();
        // A malicious directory at a file path must not turn into a subtree root.
        crate::profile::make_dir(&admin.join("AUTO_MERGE.lock")).unwrap();
        assert!(!unredirected(&common, &admin.join("rebase-merge"), true));
        assert!(!unredirected(&common, &admin.join("rebase-apply"), true));
        let roots = commit_roots(&work, Some(Access::Auto));
        for refused in [
            common
                .join("refs")
                .join("heads")
                .join("feature")
                .join("x.lock"),
            common
                .join("logs")
                .join("refs")
                .join("heads")
                .join("feature")
                .join("x"),
            common
                .join("logs")
                .join("refs")
                .join("heads")
                .join("feature")
                .join("x.lock"),
            admin.join("COMMIT_EDITMSG"),
            admin.join("MERGE_HEAD"),
            admin.join("rebase-merge"),
            admin.join("rebase-apply"),
            admin.join("AUTO_MERGE.lock"),
        ] {
            assert!(
                !roots.iter().any(|root| Path::new(root) == refused),
                "{roots:?}"
            );
        }
        // Refusing a redirect must not discard the normal branch file itself.
        assert!(roots.iter().any(|root| {
            Path::new(root) == common.join("refs").join("heads").join("feature").join("x")
        }));
    }

    // Run explicitly on a machine with Codex and Node installed. No model
    // calls; the sandbox itself executes git and adversarial file writes.
    fn sandbox(work: &Path, roots: &[String], probe: &Path) -> std::process::Output {
        println!("Codex roots: {}", serde_json::to_string(roots).unwrap());
        Command::new("codex")
            .current_dir(work)
            .args([
                "sandbox",
                "-c",
                "sandbox_mode=\"workspace-write\"",
                "-c",
                "sandbox_workspace_write.exclude_tmpdir_env_var=true",
                "-c",
                "sandbox_workspace_write.exclude_slash_tmp=true",
                "-c",
                "sandbox_workspace_write.network_access=false",
                "-c",
            ])
            .arg(format!(
                "sandbox_workspace_write.writable_roots={}",
                serde_json::to_string(roots).unwrap()
            ))
            .arg("--")
            .arg("node")
            .arg(probe)
            .output()
            .unwrap()
    }

    #[cfg(unix)]
    #[test]
    #[ignore = "requires the real Codex OS sandbox and Node"]
    fn real_codex_sandbox_refuses_redirected_admin() {
        let (dir, work) = fixture();
        let common = redirect_admin(&dir);
        let target = common
            .join("worktrees")
            .join("other")
            .join("COMMIT_EDITMSG");
        std::fs::write(&target, "protected\n").unwrap();
        let roots = commit_roots(&work, Some(Access::Auto));
        assert!(roots.is_empty());
        let probe = dir.join("probe.cjs");
        std::fs::write(
            &probe,
            format!(
                r#"
const fs = require('node:fs'), assert = require('node:assert/strict');
assert.throws(() => fs.writeFileSync({}, 'MUST BE REFUSED'), /EPERM|EACCES/);
console.log('PASS: real Codex sandbox refuses another worktree admin via symlink');
"#,
                serde_json::to_string(&target).unwrap()
            ),
        )
        .unwrap();
        let out = sandbox(&work, &roots, &probe);
        println!("{}", String::from_utf8_lossy(&out.stdout));
        assert!(
            out.status.success(),
            "{}",
            String::from_utf8_lossy(&out.stderr)
        );
        assert_eq!(std::fs::read_to_string(target).unwrap(), "protected\n");
    }

    #[test]
    #[ignore = "requires the real Codex OS sandbox and Node"]
    fn real_codex_sandbox_refuses_protected_branches_after_switch() {
        let (dir, work) = fixture();
        let common = crate::paths::canonicalize(dir.join(".git")).unwrap();
        for branch in ["main", "master", "develop", "trunk"] {
            git(&dir, &["branch", branch]);
        }
        git(
            &dir,
            &[
                "symbolic-ref",
                "refs/remotes/origin/HEAD",
                "refs/remotes/origin/trunk",
            ],
        );
        let probe = dir.join("probe.cjs");
        for branch in ["main", "master", "develop", "fixture", "trunk"] {
            git(&work, &["switch", "--ignore-other-worktrees", branch]);
            let targets = [
                common.join("refs").join("heads").join(branch),
                common.join("logs").join("refs").join("heads").join(branch),
            ];
            let before: Vec<_> = targets
                .iter()
                .map(|path| std::fs::read(path).unwrap())
                .collect();
            std::fs::write(
                &probe,
                format!(
                    r#"
const fs = require('node:fs'), assert = require('node:assert/strict');
for (const path of {}) {{
  assert.throws(() => fs.writeFileSync(path, 'MUST BE REFUSED'), /EPERM|EACCES/);
  assert.throws(() => fs.writeFileSync(path + '.lock', 'MUST BE REFUSED'), /EPERM|EACCES/);
}}
console.log('PASS: protected branch ref/reflog and locks refused after HEAD switch');
"#,
                    serde_json::to_string(&targets).unwrap()
                ),
            )
            .unwrap();
            // Even without a task-plan pin, protected branches stay refused.
            let roots = commit_roots(&work, Some(Access::Auto));
            assert_no_branch_grant(&dir, &roots);
            let out = sandbox(&work, &roots, &probe);
            println!("{branch}: {}", String::from_utf8_lossy(&out.stdout));
            assert!(
                out.status.success(),
                "{}",
                String::from_utf8_lossy(&out.stderr)
            );
            for (target, before) in targets.iter().zip(before) {
                assert_eq!(std::fs::read(target).unwrap(), before);
                assert!(!target
                    .with_file_name(format!(
                        "{}.lock",
                        target.file_name().unwrap().to_string_lossy()
                    ))
                    .exists());
            }
        }
    }

    #[cfg(target_os = "macos")]
    #[test]
    #[ignore = "requires the real Codex OS sandbox, Node and a case-insensitive filesystem"]
    fn real_codex_sandbox_refuses_main_case_alias_after_root_refresh() {
        let (dir, work) = fixture();
        git(&dir, &["branch", "main"]);
        let common = crate::paths::canonicalize(dir.join(".git")).unwrap();
        let main = common.join("refs/heads/main");
        let main_log = common.join("logs/refs/heads/main");
        let before = std::fs::read(&main).unwrap();
        let log_before = std::fs::read(&main_log).unwrap();
        assert_eq!(
            std::fs::read(common.join("refs/heads/MAIN")).unwrap(),
            before,
            "this regression requires a case-insensitive filesystem"
        );
        let probe = dir.join("case-alias.cjs");
        std::fs::write(
            &probe,
            format!(
                "require('node:fs').writeFileSync({}, 'ref: refs/heads/MAIN\\n');",
                serde_json::to_string(&common.join("worktrees/linked/HEAD")).unwrap()
            ),
        )
        .unwrap();
        let out = sandbox(&work, &commit_roots(&work, Some(Access::Auto)), &probe);
        assert!(
            out.status.success(),
            "{}",
            String::from_utf8_lossy(&out.stderr)
        );
        assert_eq!(
            git_text(&work, &["symbolic-ref", "HEAD"]).as_deref(),
            Some("refs/heads/MAIN")
        );
        // Recompute exactly as a later launch/resume/turn does after the worker's HEAD write.
        let roots = commit_roots(&work, Some(Access::Auto));
        assert_no_branch_grant(&dir, &roots);
        assert!(branch_parents(&work, Some(Access::Auto)).is_none());
        crate::git_ops::prepare_codex_branch_parents(&work, Some(Access::Auto));
        std::fs::write(
            &probe,
            r#"
const fs = require('node:fs'), assert = require('node:assert/strict');
const run = require('node:child_process').spawnSync;
fs.writeFileSync('protected-marker.txt', 'MUST NOT REACH MAIN\n');
const add = run('git', ['add','protected-marker.txt'], {encoding:'utf8'});
assert.equal(add.status, 0, add.stderr);
const commit = run('git', ['-c','user.name=Test','-c','user.email=test@example.invalid',
  '-c','commit.gpgsign=false','commit','-qm','case alias must fail'], {encoding:'utf8'});
assert.notEqual(commit.status, 0, commit.stdout);
assert.match(commit.stderr, /cannot lock ref 'HEAD'/);
assert.match(commit.stderr, /MAIN.lock.*Operation not permitted/);
console.log(commit.stderr);
console.log('PASS: HEAD alias MAIN gets no refreshed branch grant; sandbox commit refused');
"#,
        )
        .unwrap();
        let out = sandbox(&work, &roots, &probe);
        println!("{}", String::from_utf8_lossy(&out.stdout));
        assert!(
            out.status.success(),
            "{}",
            String::from_utf8_lossy(&out.stderr)
        );
        assert_eq!(std::fs::read(main).unwrap(), before);
        assert_eq!(std::fs::read(main_log).unwrap(), log_before);
        assert!(!common.join("refs/heads/main.lock").exists());
        println!("PASS: protected main ref and reflog are byte-identical after refused commit");
    }

    #[test]
    #[ignore = "requires the real Codex OS sandbox and Node"]
    fn real_codex_sandbox_detached_head_can_switch_back_without_a_branch_grant() {
        let (dir, work) = fixture();
        let attached = commit_roots(&work, Some(Access::Auto));
        git(&work, &["checkout", "--detach", "-q"]);
        let roots = commit_roots(&work, Some(Access::Auto));
        assert_no_branch_grant(&dir, &roots);
        assert!(branch_parents(&work, Some(Access::Auto)).is_none());
        let probe = dir.join("recover-detached.cjs");
        std::fs::write(
            &probe,
            r#"
const run = require('node:child_process').execFileSync;
run('git', ['switch','feature/x'], {stdio:'inherit'});
console.log('PASS: detached HEAD recovers without a branch grant');
"#,
        )
        .unwrap();
        let out = sandbox(&work, &roots, &probe);
        println!("{}", String::from_utf8_lossy(&out.stdout));
        assert!(
            out.status.success(),
            "{}",
            String::from_utf8_lossy(&out.stderr)
        );
        assert_eq!(commit_roots(&work, Some(Access::Auto)), attached);
    }

    #[test]
    #[ignore = "requires the real Codex OS sandbox and Node"]
    fn real_codex_sandbox_state_directory_roots_cannot_be_removed() {
        let (dir, work) = fixture();
        let common = crate::paths::canonicalize(dir.join(".git")).unwrap();
        let admin = common.join("worktrees").join("linked");
        let states = ["rebase-merge", "rebase-apply", "sequencer"].map(|name| admin.join(name));
        let mut roots = commit_roots(&work, Some(Access::Auto));
        for path in &states {
            assert!(unredirected(&common, path, true));
            // A trailing separator is not an escape from root protection.
            roots.push(format!("{}/", path.to_string_lossy()));
        }
        let probe = dir.join("state-roots.cjs");
        std::fs::write(
            &probe,
            format!(
                r#"
const fs = require('node:fs'), assert = require('node:assert/strict');
for (const path of {}) {{
  fs.mkdirSync(path); fs.writeFileSync(path + '/state', 'state');
  fs.unlinkSync(path + '/state');
  assert.throws(() => fs.rmdirSync(path), /EPERM|EACCES/);
  console.log('REFUSED: file-write-unlink ' + path + ' (writable directory root)');
}}
"#,
                serde_json::to_string(&states).unwrap()
            ),
        )
        .unwrap();
        let out = sandbox(&work, &roots, &probe);
        println!("{}", String::from_utf8_lossy(&out.stdout));
        assert!(
            out.status.success(),
            "{}",
            String::from_utf8_lossy(&out.stderr)
        );
    }

    // Keep fixtures and their Git writes in TestDir, never the assigned checkout.
    fn commit_file(cwd: &Path, parent: &str, file: &str, contents: &str) -> String {
        git(cwd, &["reset", "--hard", parent]);
        std::fs::write(cwd.join(file), contents).unwrap();
        git(cwd, &["add", file]);
        git(
            cwd,
            &[
                "-c",
                "user.name=Test",
                "-c",
                "user.email=test@example.invalid",
                "-c",
                "commit.gpgsign=false",
                "commit",
                "-qm",
                file,
            ],
        );
        git_text(cwd, &["rev-parse", "HEAD"]).unwrap()
    }

    #[test]
    #[ignore = "requires the real Codex OS sandbox and Node"]
    fn real_codex_sandbox_merge_rebase_cherry_pick_and_revert() {
        for access in [Access::Auto, Access::Edits] {
            let (dir, work) = fixture();
            let base = commit_file(&dir, "HEAD", "conflict.txt", "base\n");
            let upstream = commit_file(&dir, &base, "incoming.txt", "incoming\n");
            let local = commit_file(&dir, &base, "local.txt", "local\n");
            let conflict = commit_file(&dir, &base, "conflict.txt", "incoming\n");
            let local_conflict = commit_file(&dir, &base, "conflict.txt", "local\n");
            let pick1 = commit_file(&dir, &base, "pick1.txt", "one\n");
            let pick2 = commit_file(&dir, &pick1, "pick2.txt", "two\n");
            git(&work, &["reset", "--hard", &base]);
            let common = crate::paths::canonicalize(dir.join(".git")).unwrap();
            let admin = common.join("worktrees").join("linked");
            let probe = dir.join("workflows.cjs");
            let cases = serde_json::json!({
                "base": base, "upstream": upstream, "local": local, "conflict": conflict,
                "localConflict": local_conflict, "pick1": pick1, "pick2": pick2,
                "admin": admin, "source": common.parent().unwrap(),
            });
            std::fs::write(&probe, format!(r#"
const fs = require('node:fs'), assert = require('node:assert/strict');
const spawn = require('node:child_process').spawnSync;
const c = {cases};
const env = {{...process.env, GIT_AUTHOR_NAME:'Test', GIT_AUTHOR_EMAIL:'test@example.invalid',
  GIT_COMMITTER_NAME:'Test', GIT_COMMITTER_EMAIL:'test@example.invalid',
  GIT_EDITOR:'true', GIT_SEQUENCE_EDITOR:'true', GIT_CONFIG_NOSYSTEM:'1', GIT_CONFIG_GLOBAL:'/dev/null'}};
function git(args, expected = 0) {{
  const r = spawn('git', ['-c','commit.gpgsign=false','-c','gc.auto=0', ...args], {{env, encoding:'utf8'}});
  assert.equal(r.status, expected, args.join(' ') + '\n' + r.stdout + r.stderr);
  // Git's best-effort removal of absent pseudo-refs can try the protected
  // shared packed-refs lock even when the operation succeeds. Never grant it.
  const errors = r.stderr.replaceAll("error: Unable to create '" + c.source + "/.git/packed-refs.lock': Operation not permitted\n", '');
  assert.doesNotMatch(errors, /Operation not permitted|Permission denied|cannot lock/);
  return r.stdout.trim();
}}
const head = () => git(['rev-parse','HEAD']);
const file = name => c.admin + '/' + name;
function reset(to = c.base) {{ git(['reset','--hard',to]); }}
function clean() {{
  for (const name of ['MERGE_HEAD','MERGE_MSG','MERGE_MODE','MERGE_AUTOSTASH',
    'CHERRY_PICK_HEAD','REVERT_HEAD','REBASE_HEAD','rebase-merge','rebase-apply','sequencer'])
    assert.equal(fs.existsSync(file(name)), false, 'unclean: ' + name);
  assert.equal(git(['status','--porcelain']), '', 'worktree must be clean');
}}
function stage(text) {{ console.log('PASS: ' + text); }}
reset();
fs.writeFileSync('commit.txt', 'commit\n'); git(['add','commit.txt']); git(['commit','-qm','commit']);
assert.equal(git(['show','HEAD:commit.txt']), 'commit'); stage('commit');
reset(); git(['merge','--ff-only',c.upstream]); assert.equal(head(), c.upstream);
assert.equal(fs.readFileSync(file('ORIG_HEAD'),'utf8').trim(), c.base); clean(); stage('merge --ff-only');
reset(c.local); git(['merge','--no-ff','-m','merge',c.upstream]);
assert.equal(git(['rev-list','--parents','-n','1','HEAD']).split(' ').length, 3); clean(); stage('merge --no-ff');
reset(c.localConflict); git(['merge','--no-ff','-m','conflict',c.conflict], 1);
for (const name of ['MERGE_HEAD','MERGE_MSG','MERGE_MODE','AUTO_MERGE']) assert(fs.existsSync(file(name)), name);
fs.writeFileSync('conflict.txt','resolved\n'); git(['add','conflict.txt']); git(['commit','-qm','resolve']);
assert.equal(git(['rev-list','--parents','-n','1','HEAD']).split(' ').length, 3); clean(); stage('conflicting merge resolve + commit');
reset(c.localConflict); git(['merge','--no-ff','-m','abort',c.conflict], 1); git(['merge','--abort']);
assert.equal(head(), c.localConflict); assert.equal(fs.readFileSync('conflict.txt','utf8'), 'local\n'); clean(); stage('merge --abort');
reset(); git(['merge','--squash',c.upstream]); assert(fs.existsSync(file('SQUASH_MSG')));
git(['commit','-qm','squash']); assert.equal(git(['show','HEAD:incoming.txt']), 'incoming'); clean(); stage('merge --squash');
// Autostash uses index.stash.<pid> outside the enumerated file roots.
reset(); fs.writeFileSync('conflict.txt','dirty\n'); git(['merge','--autostash','--no-ff','-m','autostash',c.upstream], 128);
assert.equal(head(), c.base); assert.equal(fs.readFileSync('conflict.txt','utf8'), 'dirty\n');
stage('autostash temporary index refused; dirty file preserved');
// State directory roots cannot be removed by Codex; production refuses
// their creation before Git rewrites the branch or starts a sequence.
function refused(args, state) {{
  const before = head();
  const r = spawn('git', ['-c','gc.auto=0', ...args], {{env, encoding:'utf8'}});
  assert.notEqual(r.status, 0, args.join(' '));
  assert.match(r.stderr, /Operation not permitted|Permission denied/);
  assert(r.stderr.includes(state), r.stderr);
  assert.equal(head(), before, 'refusal must not rewrite HEAD'); clean();
  stage('early refusal: ' + args[0] + ' (' + state + ')');
}}
reset(c.local); refused(['rebase',c.upstream], 'rebase-merge');
reset(c.local);
const branchBeforeApply = git(['rev-parse','refs/heads/feature/x']);
const apply = spawn('git', ['rebase','--apply',c.upstream], {{env, encoding:'utf8'}});
assert.notEqual(apply.status, 0); assert.match(apply.stderr, /rebased-patches.*Operation not permitted/);
assert.equal(git(['rev-parse','refs/heads/feature/x']), branchBeforeApply, 'task branch ref stays intact');
assert.equal(head(), c.upstream, 'apply backend detaches before the denied temporary file');
git(['symbolic-ref','-q','HEAD'], 1); git(['switch','feature/x']); assert.equal(head(), branchBeforeApply); clean();
stage('rebase --apply refused after detach; task branch unchanged and switch recovers');
reset(); git(['cherry-pick','--no-commit',c.pick1]); git(['commit','-qm','picked without marker']);
clean(); stage('cherry-pick --no-commit + commit');
reset(); git(['cherry-pick',c.pick1]); assert.equal(git(['show','HEAD:pick1.txt']), 'one');
assert(fs.existsSync(file('CHERRY_PICK_HEAD')), 'Git ref cleanup is denied by packed-refs protection');
fs.unlinkSync(file('CHERRY_PICK_HEAD')); clean(); stage('single cherry-pick commit succeeds; direct own-file marker cleanup required');
reset(); refused(['cherry-pick',c.pick1,c.pick2], 'sequencer');
reset(c.localConflict); git(['cherry-pick',c.conflict], 1); assert(fs.existsSync(file('CHERRY_PICK_HEAD')));
fs.writeFileSync('conflict.txt','picked\n'); git(['add','conflict.txt']); git(['cherry-pick','--continue']);
assert(fs.existsSync(file('CHERRY_PICK_HEAD'))); fs.unlinkSync(file('CHERRY_PICK_HEAD'));
clean(); stage('cherry-pick conflict + continue; direct own-file marker cleanup required');
reset(c.pick1); git(['revert','--no-edit',c.pick1]);
assert.equal(fs.existsSync('pick1.txt'),false); clean(); stage('single revert');
reset(c.pick2); refused(['revert','--no-edit',c.pick2,c.pick1], 'sequencer');
reset(c.localConflict); git(['revert','--no-edit',c.conflict], 1); assert(fs.existsSync(file('REVERT_HEAD')));
fs.writeFileSync('conflict.txt','reverted\n'); git(['add','conflict.txt']); git(['revert','--continue']);
assert(fs.existsSync(file('REVERT_HEAD'))); fs.unlinkSync(file('REVERT_HEAD'));
clean(); stage('revert conflict + continue; direct own-file marker cleanup required');
// A local file transport exercises FETCH_HEAD without enabling network or writing remote refs.
reset(); git(['fetch','--no-auto-maintenance','--no-write-commit-graph',c.source,c.upstream]);
assert(fs.readFileSync(file('FETCH_HEAD'),'utf8').startsWith(c.upstream)); stage('local fetch writes FETCH_HEAD');
"#)).unwrap();
            let roots = commit_roots(&work, Some(access));
            let out = sandbox(&work, &roots, &probe);
            println!("{access:?}: {}", String::from_utf8_lossy(&out.stdout));
            assert!(
                out.status.success(),
                "{}",
                String::from_utf8_lossy(&out.stderr)
            );
        }
    }

    #[test]
    #[ignore = "requires the real Codex OS sandbox and Node"]
    fn real_codex_sandbox_commits_and_merges_on_a_packed_only_branch() {
        sandbox_commit(true);
    }

    #[test]
    #[ignore = "requires the real Codex OS sandbox and Node"]
    fn real_codex_sandbox_commits_without_admitting_other_branches_or_config() {
        sandbox_commit(false);
    }

    fn sandbox_commit(packed: bool) {
        let (dir, work) = fixture();
        git(&dir, &["branch", "develop"]);
        git(&dir, &["branch", "main"]);
        git(&dir, &["branch", "feature/other"]);
        let common = crate::paths::canonicalize(dir.join(".git")).unwrap();
        git(&dir, &["update-ref", "refs/remotes/origin/main", "HEAD"]);
        git(&dir, &["update-ref", "refs/stash", "HEAD"]);
        let other = dir.join("other");
        git(
            &dir,
            &["worktree", "add", "-qb", "other", other.to_str().unwrap()],
        );
        let admin = common.join("worktrees").join("linked");
        let targets = [
            common.join("refs").join("heads").join("fixture"),
            common
                .join("logs")
                .join("refs")
                .join("heads")
                .join("fixture"),
            common
                .join("refs")
                .join("remotes")
                .join("origin")
                .join("main"),
            common
                .join("logs")
                .join("refs")
                .join("remotes")
                .join("origin")
                .join("main"),
            common.join("refs").join("stash"),
            common.join("worktrees").join("other").join("index"),
            admin.join("gitdir"),
            admin.join("commondir"),
            common.join("refs").join("heads").join("develop"),
            common.join("refs").join("heads").join("main"),
            common
                .join("refs")
                .join("heads")
                .join("feature")
                .join("other"),
            common
                .join("logs")
                .join("refs")
                .join("heads")
                .join("develop"),
            common.join("logs").join("refs").join("heads").join("main"),
            common
                .join("logs")
                .join("refs")
                .join("heads")
                .join("feature")
                .join("other"),
            common.join("packed-refs"),
            common.join("hooks").join("x"),
            common.join("config"),
            common
                .join("worktrees")
                .join("linked")
                .join("config.worktree"),
        ];
        let merge = commit_file(&dir, "HEAD", "merge.txt", "merge\n");
        if packed {
            git(&dir, &["pack-refs", "--all"]);
            let parent = common.join("refs").join("heads").join("feature");
            assert!(!parent.join("x").exists());
            if parent.exists() {
                std::fs::remove_dir(&parent).unwrap();
            }
            assert!(!parent.exists(), "exercise a missing loose-ref parent");
            let log_parent = common
                .join("logs")
                .join("refs")
                .join("heads")
                .join("feature");
            std::fs::remove_dir_all(&log_parent).unwrap();
            assert!(!log_parent.exists(), "exercise a missing reflog parent");
            // Keep the unrelated remote-ref parent present so a failed write
            // proves sandbox refusal rather than merely a missing directory.
            crate::profile::make_dir(&common.join("refs").join("remotes").join("origin")).unwrap();
        }
        let before: Vec<_> = targets.iter().map(std::fs::read).collect();
        let probe = dir.join("probe.cjs");
        std::fs::write(&probe, format!(r#"
const fs = require('node:fs'), assert = require('node:assert/strict');
const run = require('node:child_process').execFileSync;
fs.writeFileSync('change.txt', 'sandbox commit\n');
run('git', ['add','change.txt'], {{stdio:'inherit'}});
run('git', ['-c','user.name=Test','-c','user.email=test@example.invalid','commit','-qm','sandbox'], {{stdio:'inherit'}});
console.log('Committed feature/x: ' + run('git', ['rev-parse', 'HEAD'], {{encoding:'utf8'}}).trim());
run('git', ['-c','user.name=Test','-c','user.email=test@example.invalid','merge','--no-ff','-m','sandbox merge',{}], {{stdio:'inherit'}});
assert.equal(fs.readFileSync('merge.txt','utf8'), 'merge\n');
console.log('Merged into feature/x');
for (const path of {}) {{
  assert.throws(() => fs.writeFileSync(path, 'MUST BE REFUSED'), /EPERM|EACCES/);
  assert.throws(() => fs.writeFileSync(path + '.lock', 'MUST BE REFUSED'), /EPERM|EACCES/);
  console.log('REFUSED: ' + path + ' (and .lock)');
}}
console.log('PASS: real Codex sandbox feature/x commit; other branch refs/reflogs, packed-refs, hooks/config/config.worktree writes refused');
"#, serde_json::to_string(&merge).unwrap(), serde_json::to_string(&targets).unwrap())).unwrap();
        let roots = commit_roots(&work, Some(Access::Auto));
        if packed {
            let out = sandbox(&work, &roots, &probe);
            assert!(
                !out.status.success(),
                "missing ref parents must not be writable"
            );
            let error = String::from_utf8_lossy(&out.stderr);
            assert!(error.contains("unable to create directory"), "{error}");
            println!("REFUSED: packed branch with missing loose-ref parent: {error}");
            // Prepare only empty parents on the host; no parent sandbox grant.
            let parent = common.join("refs").join("heads").join("feature");
            crate::git_ops::prepare_codex_branch_parents(&work, Some(Access::Auto));
            assert!(!parent.join("x").exists(), "branch is still packed-only");
            assert_eq!(commit_roots(&work, Some(Access::Auto)), roots);
        }
        let out = sandbox(&work, &roots, &probe);
        println!("{}", String::from_utf8_lossy(&out.stdout));
        println!("{}", String::from_utf8_lossy(&out.stderr));
        assert!(
            out.status.success(),
            "{}",
            String::from_utf8_lossy(&out.stderr)
        );
        for (target, before) in targets.iter().zip(before) {
            assert_eq!(std::fs::read(target).ok(), before.ok(), "{target:?}");
            assert!(!target
                .with_file_name(format!(
                    "{}.lock",
                    target.file_name().unwrap().to_string_lossy()
                ))
                .exists());
        }
        assert!(
            !String::from_utf8_lossy(&out.stderr).contains("cannot lock"),
            "{}",
            String::from_utf8_lossy(&out.stderr)
        );
    }
}
