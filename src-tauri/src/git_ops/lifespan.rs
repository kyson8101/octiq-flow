//! Bounded, non-interactive Git operations for the host lifespan. No hooks,
//! network, branch deletion, or global worktree prune.
use std::{
    io::Read,
    path::Path,
    process::{Command, Stdio},
    time::{Duration, Instant},
};

pub(crate) fn command(cmd: &mut Command, timeout: Duration) -> Result<Vec<u8>, String> {
    crate::proc::no_console(cmd);
    let mut child = cmd
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| e.to_string())?;
    let stdout = child.stdout.take().ok_or("Missing command output")?;
    let stderr = child.stderr.take().ok_or("Missing command errors")?;
    fn reader(pipe: impl Read + Send + 'static) -> std::sync::mpsc::Receiver<Vec<u8>> {
        let (tx, rx) = std::sync::mpsc::channel();
        std::thread::spawn(move || {
            let mut bytes = Vec::new();
            let _ = pipe.take(32 * 1024 * 1024 + 1).read_to_end(&mut bytes);
            let _ = tx.send(bytes);
        });
        rx
    }
    let out = reader(stdout);
    let err = reader(stderr);
    let start = Instant::now();
    let status = loop {
        if start.elapsed() >= timeout {
            let _ = child.kill();
            let _ = child.wait();
            return Err("Command timed out; nothing is assumed about its outcome.".into());
        }
        match child.try_wait() {
            Ok(Some(s)) => break s,
            Ok(None) => std::thread::sleep(Duration::from_millis(20)),
            Err(e) => {
                let _ = child.kill();
                let _ = child.wait();
                return Err(e.to_string());
            }
        }
    };
    let bytes = out
        .recv_timeout(Duration::from_secs(1))
        .map_err(|e| e.to_string())?;
    let errors = err
        .recv_timeout(Duration::from_secs(1))
        .map_err(|e| e.to_string())?;
    if !status.success() {
        return Err(format!(
            "Command failed: {}",
            String::from_utf8_lossy(&errors).trim()
        ));
    }
    if bytes.len() > 32 * 1024 * 1024 {
        return Err("Command output exceeded the safety limit.".into());
    }
    Ok(bytes)
}
fn git_command(root: &str, args: &[&str]) -> Command {
    let mut cmd = Command::new("git");
    cmd.args([
        "-c",
        "core.fsmonitor=false",
        "-c",
        "core.hooksPath=/dev/null",
        "-C",
        root,
    ])
    .args(args)
    .env("GIT_OPTIONAL_LOCKS", "0")
    .env("GIT_TERMINAL_PROMPT", "0");
    if std::env::var_os("GIT_SSH_COMMAND").is_none() {
        cmd.env("GIT_SSH_COMMAND", "ssh -o BatchMode=yes");
    }
    cmd
}
pub(crate) fn git(root: &str, args: &[&str]) -> Result<Vec<u8>, String> {
    command(&mut git_command(root, args), Duration::from_secs(15))
}
pub(crate) fn text(root: &str, args: &[&str]) -> Result<String, String> {
    String::from_utf8(git(root, args)?)
        .map(|s| s.trim_end().to_owned())
        .map_err(|e| e.to_string())
}
pub(crate) fn remove(repo: &str, path: &str, archived: bool) -> Result<(), String> {
    let mut args = vec!["worktree", "remove"];
    if archived {
        args.push("--force");
    }
    args.extend(["--", path]);
    git(repo, &args).map(|_| ())
}
/// Index is copied from HEAD into a new temporary index. The real index,
/// branch and hooks are untouched. Ignored files deliberately stay out.
pub(crate) fn archive(
    path: &str,
    head: &str,
    reference: &str,
    index: &Path,
) -> Result<(String, usize), String> {
    let run = |args: &[&str]| -> Result<String, String> {
        let mut cmd = git_command(path, args);
        cmd.env("GIT_INDEX_FILE", index)
            .env("GIT_AUTHOR_NAME", "OctiqFlow archive")
            .env("GIT_AUTHOR_EMAIL", "archive@octiqflow.local")
            .env("GIT_COMMITTER_NAME", "OctiqFlow archive")
            .env("GIT_COMMITTER_EMAIL", "archive@octiqflow.local");
        command(&mut cmd, Duration::from_secs(15))
            .map(|b| String::from_utf8_lossy(&b).trim().to_owned())
    };
    let result = (|| {
        run(&["read-tree", head])?;
        run(&["add", "-A", "--", "."])?;
        let tree = run(&["write-tree"])?;
        // A gitlink keeps a commit id, not the submodule/embedded repo's
        // working files or objects. Force-removing it would lose data that
        // this archive did not keep, so no archive/removal is offered.
        let entries = git(path, &["ls-tree", "-r", "-z", &tree])?;
        if entries
            .split(|b| *b == 0)
            .any(|entry| entry.starts_with(b"160000 "))
        {
            return Err("Submodules or embedded repositories need separate preservation; the folder was kept.".into());
        }
        let commit = run(&[
            "commit-tree",
            &tree,
            "-p",
            head,
            "-m",
            "OctiqFlow worktree archive (ignored files excluded)",
        ])?;
        run(&[
            "update-ref",
            reference,
            &commit,
            "0000000000000000000000000000000000000000",
        ])?;
        if text(path, &["rev-parse", &format!("{reference}^{{tree}}")])? != tree {
            return Err("Archive tree verification failed; folder was kept.".into());
        }
        let files = git(path, &["ls-tree", "-r", "-z", "--name-only", reference])?
            .split(|b| *b == 0)
            .filter(|b| !b.is_empty())
            .count();
        Ok((tree, files))
    })();
    let _ = std::fs::remove_file(index);
    let _ = std::fs::remove_file(index.with_extension("lock"));
    result
}
pub(crate) fn restore(repo: &str, path: &str, branch: &str, reference: &str) -> Result<(), String> {
    if std::fs::symlink_metadata(path).is_ok() {
        return Err("Restore path already exists; nothing was overwritten.".into());
    }
    crate::profile::make_dir(
        Path::new(path)
            .parent()
            .ok_or("Restore path has no parent")?,
    )?;
    git(
        repo,
        &[
            "worktree",
            "add",
            "--no-track",
            "-b",
            branch,
            path,
            reference,
        ],
    )
    .map(|_| ())
}
