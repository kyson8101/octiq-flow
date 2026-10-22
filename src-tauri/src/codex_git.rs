//! Commit storage for a linked worktree, without granting its shared git dir.
use std::path::{Path, PathBuf};
use std::process::Command;

use crate::agent_provider::Access;

pub(crate) fn commit_roots(cwd: &Path, access: Option<Access>) -> Vec<String> {
    if !matches!(access, Some(Access::Auto | Access::Edits)) {
        return Vec::new();
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
        return Vec::new();
    };
    if !output.status.success() {
        return Vec::new();
    }
    let text = String::from_utf8_lossy(&output.stdout);
    let paths: Vec<_> = text.lines().map(PathBuf::from).collect();
    if paths.len() != 3 {
        return Vec::new();
    }
    let Ok(common) = crate::paths::canonicalize(&paths[0]) else {
        return Vec::new();
    };
    // Inspect Git's original admin path BEFORE canonicalizing it: following
    // a redirected worktrees/<name> would grant another worktree's files.
    let Ok(relative) = paths[1].strip_prefix(&paths[0]) else {
        return Vec::new();
    };
    let admin = relative
        .components()
        .fold(common.clone(), |path, part| path.join(part));
    if admin.parent() != Some(common.join("worktrees").as_path())
        || !unredirected(&common, &admin, true)
        || crate::paths::canonicalize(&admin).ok().as_ref() != Some(&admin)
        || !admin_points_back(&common, &admin, &paths[2])
    {
        return Vec::new();
    }
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
    let files = [
        "index",
        "index.lock",
        "COMMIT_EDITMSG",
        "HEAD",
        "HEAD.lock",
        "AUTO_MERGE",
        "AUTO_MERGE.lock",
        "logs",
    ]
    .map(|name| admin.join(name));
    roots
        .into_iter()
        .chain(files)
        // Keep the grant at the path Git named, never a redirected target.
        .filter(|path| {
            unredirected(
                &common,
                path,
                *path == common.join("objects") || *path == admin.join("logs"),
            )
        })
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
    if !branch.starts_with("refs/heads/") {
        return None;
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

fn unredirected(common: &Path, path: &Path, directory: bool) -> bool {
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
    fn only_commit_storage_in_the_linked_worktree_is_added() {
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
                admin.join("COMMIT_EDITMSG"),
                admin.join("HEAD"),
                admin.join("HEAD.lock"),
                admin.join("AUTO_MERGE"),
                admin.join("AUTO_MERGE.lock"),
                admin.join("logs"),
            ];
            assert_eq!(
                roots.iter().map(PathBuf::from).collect::<Vec<_>>(),
                expected
            );
            for protected in [
                common.clone(),
                common.join("refs/heads/develop"),
                common.join("refs/heads/main"),
                common.join("logs/refs/heads/develop"),
                common.join("packed-refs"),
                common.join("hooks/x"),
                common.join("config"),
                admin.join("config.worktree"),
                common.join("worktrees/other/index"),
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
    fn detached_unborn_and_non_branch_heads_get_no_branch_grant() {
        let (dir, work) = fixture();
        let common = crate::paths::canonicalize(dir.join(".git")).unwrap();
        git(&work, &["checkout", "--detach", "-q"]);
        for head in [None, Some("refs/heads/unborn"), Some("refs/tags/odd")] {
            if let Some(head) = head {
                git(&work, &["symbolic-ref", "HEAD", head]);
            }
            assert_eq!(current_branch(&work), None);
            let roots = commit_roots(&work, Some(Access::Edits));
            assert_eq!(roots.len(), 9, "{head:?}: {roots:?}");
            assert!(!roots.iter().any(|root| {
                Path::new(root).starts_with(common.join("refs"))
                    || Path::new(root).starts_with(common.join("logs"))
            }));
        }
        std::fs::write(
            common.join("worktrees/linked/HEAD"),
            "ref: refs/heads/../main\n",
        )
        .unwrap();
        assert!(current_branch(&work).is_none());
        let roots = commit_roots(&work, Some(Access::Edits));
        assert_eq!(roots.len(), 9);
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
            common.join("worktrees/linked"),
            common.join("worktrees/held"),
        )
        .unwrap();
        std::os::unix::fs::symlink(
            common.join("worktrees/other"),
            common.join("worktrees/linked"),
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
        std::fs::remove_file(common.join("worktrees/linked")).unwrap();
        std::fs::rename(
            common.join("worktrees/held"),
            common.join("worktrees/linked"),
        )
        .unwrap();
        std::fs::write(
            common.join("worktrees/linked/gitdir"),
            dir.join("other/.git").to_str().unwrap(),
        )
        .unwrap();
        assert!(commit_roots(&work, Some(Access::Edits)).is_empty());
        // A redirect one level above the admin must be refused too.
        std::fs::write(
            common.join("worktrees/linked/gitdir"),
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
        let admin = common.join("worktrees/linked");
        let outside = crate::test_dir::TestDir::new("codex-roots-outside");
        symlink(
            outside.join("lock"),
            common.join("refs/heads/feature/x.lock"),
        )
        .unwrap();
        std::fs::rename(
            common.join("logs/refs/heads/feature"),
            outside.join("feature"),
        )
        .unwrap();
        symlink(
            outside.join("feature"),
            common.join("logs/refs/heads/feature"),
        )
        .unwrap();
        symlink(outside.join("message"), admin.join("COMMIT_EDITMSG")).unwrap();
        // A malicious directory at a file path must not turn into a subtree root.
        crate::profile::make_dir(&admin.join("AUTO_MERGE.lock")).unwrap();
        let roots = commit_roots(&work, Some(Access::Auto));
        for refused in [
            common.join("refs/heads/feature/x.lock"),
            common.join("logs/refs/heads/feature/x"),
            common.join("logs/refs/heads/feature/x.lock"),
            admin.join("COMMIT_EDITMSG"),
            admin.join("AUTO_MERGE.lock"),
        ] {
            assert!(
                !roots.contains(&refused.to_string_lossy().into_owned()),
                "{roots:?}"
            );
        }
        // Refusing a redirect must not discard the normal branch file itself.
        assert!(roots.contains(
            &common
                .join("refs/heads/feature/x")
                .to_string_lossy()
                .into_owned()
        ));
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
        let target = common.join("worktrees/other/COMMIT_EDITMSG");
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
    fn real_codex_sandbox_commits_without_admitting_other_branches_or_config() {
        let (dir, work) = fixture();
        git(&dir, &["branch", "develop"]);
        git(&dir, &["branch", "main"]);
        git(&dir, &["branch", "feature/other"]);
        let common = crate::paths::canonicalize(dir.join(".git")).unwrap();
        let targets = [
            common.join("refs/heads/develop"),
            common.join("refs/heads/main"),
            common.join("refs/heads/feature/other"),
            common.join("logs/refs/heads/develop"),
            common.join("logs/refs/heads/main"),
            common.join("logs/refs/heads/feature/other"),
            common.join("packed-refs"),
            common.join("hooks/x"),
            common.join("config"),
            common.join("worktrees/linked/config.worktree"),
        ];
        let before: Vec<_> = targets.iter().map(std::fs::read).collect();
        let probe = dir.join("probe.cjs");
        std::fs::write(&probe, format!(r#"
const fs = require('node:fs'), assert = require('node:assert/strict');
const run = require('node:child_process').execFileSync;
fs.writeFileSync('change.txt', 'sandbox commit\n');
run('git', ['add','change.txt'], {{stdio:'inherit'}});
run('git', ['-c','user.name=Test','-c','user.email=test@example.invalid','commit','-qm','sandbox'], {{stdio:'inherit'}});
console.log('Committed feature/x: ' + run('git', ['rev-parse', 'HEAD'], {{encoding:'utf8'}}).trim());
for (const path of {}) {{
  assert.throws(() => fs.writeFileSync(path, 'MUST BE REFUSED'), /EPERM|EACCES/);
  assert.throws(() => fs.writeFileSync(path + '.lock', 'MUST BE REFUSED'), /EPERM|EACCES/);
  console.log('REFUSED: ' + path + ' (and .lock)');
}}
console.log('PASS: real Codex sandbox feature/x commit; other branch refs/reflogs, packed-refs, hooks/config/config.worktree writes refused');
"#, serde_json::to_string(&targets).unwrap())).unwrap();
        let roots = commit_roots(&work, Some(Access::Auto));
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
