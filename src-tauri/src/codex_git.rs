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
    if paths.len() != 2 {
        return Vec::new();
    }
    let (Ok(common), Ok(admin)) = (
        crate::paths::canonicalize(&paths[0]),
        crate::paths::canonicalize(&paths[1]),
    ) else {
        return Vec::new();
    };
    // A primary checkout needs a separate policy. In particular, never add
    // common itself (that would admit hooks, config and every other worktree).
    if admin == common || admin.parent() != Some(common.join("worktrees").as_path()) {
        return Vec::new();
    }
    let roots = ["objects", "refs", "logs"].map(|name| common.join(name));
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
            std::fs::symlink_metadata(path).is_ok_and(|m| !m.is_symlink())
                || std::fs::symlink_metadata(path)
                    .is_err_and(|e| e.kind() == std::io::ErrorKind::NotFound)
        })
        .map(|path| path.to_string_lossy().into_owned())
        .collect()
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

    #[test]
    fn only_commit_storage_in_the_linked_worktree_is_added() {
        let dir = crate::test_dir::TestDir::new("codex-commit-roots");
        git(&dir, &["init", "-q"]);
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
            &["worktree", "add", "-qb", "task", work.to_str().unwrap()],
        );
        let common = crate::paths::canonicalize(dir.join(".git")).unwrap();
        let admin = common.join("worktrees/linked");
        for access in [Access::Auto, Access::Edits] {
            let roots = commit_roots(&work, Some(access));
            for path in [
                common.join("objects"),
                common.join("refs"),
                common.join("logs"),
                admin.join("index.lock"),
                admin.join("COMMIT_EDITMSG"),
            ] {
                assert!(
                    roots.contains(&path.to_string_lossy().into_owned()),
                    "{path:?}"
                );
            }
            for protected in [
                common.clone(),
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

    // Run explicitly on a machine with Codex and Node installed. No model
    // calls; the sandbox itself executes git and adversarial file writes.
    #[test]
    #[ignore = "requires the real Codex OS sandbox and Node"]
    fn real_codex_sandbox_commits_without_admitting_hooks_or_config() {
        let dir = crate::test_dir::TestDir::new("codex-real-sandbox");
        git(&dir, &["init", "-q"]);
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
            &["worktree", "add", "-qb", "task", work.to_str().unwrap()],
        );
        let common = crate::paths::canonicalize(dir.join(".git")).unwrap();
        let targets = [
            common.join("hooks/x"),
            common.join("config"),
            common.join("worktrees/linked/config.worktree"),
        ];
        let probe = dir.join("probe.cjs");
        std::fs::write(&probe, format!(r#"
const fs = require('node:fs'), assert = require('node:assert/strict');
const run = require('node:child_process').execFileSync;
fs.writeFileSync('change.txt', 'sandbox commit\n');
run('git', ['add','change.txt'], {{stdio:'inherit'}});
run('git', ['-c','user.name=Test','-c','user.email=test@example.invalid','commit','-qm','sandbox'], {{stdio:'inherit'}});
for (const path of {}) assert.throws(() => fs.writeFileSync(path, 'MUST BE REFUSED'), /EPERM|EACCES/);
console.log('PASS: real Codex sandbox commit; hooks/config/config.worktree writes refused');
"#, serde_json::to_string(&targets).unwrap())).unwrap();
        let roots = commit_roots(&work, Some(Access::Auto));
        let out = Command::new("codex")
            .current_dir(&work)
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
                serde_json::to_string(&roots).unwrap()
            ))
            .arg("--")
            .arg("node")
            .arg(probe)
            .output()
            .unwrap();
        println!("{}", String::from_utf8_lossy(&out.stdout));
        assert!(
            out.status.success(),
            "{}",
            String::from_utf8_lossy(&out.stderr)
        );
        assert!(
            !String::from_utf8_lossy(&out.stderr).contains("cannot lock"),
            "{}",
            String::from_utf8_lossy(&out.stderr)
        );
    }
}
