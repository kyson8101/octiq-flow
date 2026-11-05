//! Bounded, non-interactive Git operations for the host lifespan. No hooks,
//! network, branch deletion, or global worktree prune.
use std::{
    io::Read,
    path::Path,
    process::{Command, Stdio},
    time::{Duration, Instant},
};

// Every Git read while lifecycle is held shares the same final deadline.
// Nested helpers cannot silently restart a fixed 15-second timeout.
thread_local! {
    static FINAL_DEADLINE: std::cell::Cell<Option<Instant>> = const { std::cell::Cell::new(None) };
}
pub(crate) struct FinalBudget(Option<Instant>);
impl FinalBudget {
    pub(crate) fn start() -> Self {
        Self::with_timeout(Duration::from_secs(10))
    }
    pub(crate) fn with_timeout(timeout: Duration) -> Self {
        let deadline = Instant::now() + timeout;
        Self(
            FINAL_DEADLINE.with(|d| d.replace(Some(d.get().map_or(deadline, |v| v.min(deadline))))),
        )
    }
}
impl Drop for FinalBudget {
    fn drop(&mut self) {
        FINAL_DEADLINE.with(|d| d.set(self.0));
    }
}
pub(crate) fn remaining(timeout: Duration) -> Result<Duration, String> {
    let timeout = FINAL_DEADLINE.with(|d| {
        d.get().map_or(timeout, |v| {
            timeout.min(v.saturating_duration_since(Instant::now()))
        })
    });
    if timeout.is_zero() {
        Err("Final cleanup checks reached their 10 second bound; folder kept.".into())
    } else {
        Ok(timeout)
    }
}

pub(crate) fn command(cmd: &mut Command, timeout: Duration) -> Result<Vec<u8>, String> {
    command_io(cmd, timeout, None, 32 * 1024 * 1024, false)
}
fn command_io(
    cmd: &mut Command,
    timeout: Duration,
    input: Option<Vec<u8>>,
    limit: usize,
    strict_errors: bool,
) -> Result<Vec<u8>, String> {
    let timeout = remaining(timeout)?;
    let start = Instant::now();
    crate::proc::no_console(cmd);
    let mut child = cmd
        .stdin(if input.is_some() {
            Stdio::piped()
        } else {
            Stdio::null()
        })
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| e.to_string())?;
    if let Some(input) = input {
        let mut stdin = child.stdin.take().ok_or("Missing command input")?;
        std::thread::spawn(move || {
            use std::io::Write;
            let _ = stdin.write_all(&input);
        });
    }
    let stdout = child.stdout.take().ok_or("Missing command output")?;
    let stderr = child.stderr.take().ok_or("Missing command errors")?;
    fn reader(
        pipe: impl Read + Send + 'static,
        limit: usize,
    ) -> std::sync::mpsc::Receiver<Vec<u8>> {
        let (tx, rx) = std::sync::mpsc::channel();
        std::thread::spawn(move || {
            let mut bytes = Vec::new();
            let _ = pipe.take(limit as u64 + 1).read_to_end(&mut bytes);
            let _ = tx.send(bytes);
        });
        rx
    }
    let out = reader(stdout, limit);
    let err = reader(stderr, 32 * 1024 * 1024);
    let status = loop {
        if start.elapsed() >= timeout {
            let _ = child.kill();
            let _ = child.wait();
            return Err("Command timed out; nothing is assumed about its outcome.".into());
        }
        match child.try_wait() {
            Ok(Some(s)) => break s,
            Ok(None) => std::thread::sleep(Duration::from_millis(2)),
            Err(e) => {
                let _ = child.kill();
                let _ = child.wait();
                return Err(e.to_string());
            }
        }
    };
    let bytes = out
        .recv_timeout(timeout.saturating_sub(start.elapsed()))
        .map_err(|e| e.to_string())?;
    let errors = err
        .recv_timeout(timeout.saturating_sub(start.elapsed()))
        .map_err(|e| e.to_string())?;
    if bytes.len() > limit {
        return Err("Command output exceeded the safety limit.".into());
    }
    if !status.success() || strict_errors && !errors.is_empty() {
        return Err(format!(
            "Command failed: {}",
            String::from_utf8_lossy(&errors).trim()
        ));
    }
    Ok(bytes)
}
#[cfg(test)]
thread_local! {
    pub(crate) static TEST_GIT: std::cell::RefCell<Option<std::path::PathBuf>> = const { std::cell::RefCell::new(None) };
}
pub(crate) fn git_command(root: &str, args: &[&str]) -> Command {
    #[cfg(test)]
    let executable = TEST_GIT
        .with(|p| p.borrow().clone())
        .unwrap_or_else(|| "git".into());
    #[cfg(not(test))]
    let executable = "git";
    let mut cmd = Command::new(executable);
    cmd.args([
        "-c",
        "core.fsmonitor=false",
        "-c",
        "core.untrackedCache=false",
        "-c",
        "status.showUntrackedFiles=all",
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
pub(crate) fn git_bounded(root: &str, args: &[&str], timeout: Duration) -> Result<Vec<u8>, String> {
    command(&mut git_command(root, args), timeout)
}
pub(crate) fn git_io(
    root: &str,
    args: &[&str],
    timeout: Duration,
    input: Option<Vec<u8>>,
    limit: usize,
) -> Result<Vec<u8>, String> {
    command_io(&mut git_command(root, args), timeout, input, limit, true)
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
    // Removal itself has its own documented 15-second bound. Final checks
    // have already passed, and lifecycle remains held throughout the mutation.
    let previous = FINAL_DEADLINE.with(|d| d.replace(None));
    let restore = FinalBudget(previous);
    let result = git(repo, &args).map(|_| ());
    drop(restore);
    result
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
        command(&mut cmd, Duration::from_secs(120))
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
/// A brand new index has no stat-cache entries: compare disk with the
/// archived tree even when the real index thinks the bytes are clean.
pub(crate) fn verify_archive_disk(path: &str, reference: &str, index: &Path) -> Result<(), String> {
    let result = (|| {
        let run = |args: &[&str]| {
            let mut cmd = git_command(path, args);
            cmd.env("GIT_INDEX_FILE", index);
            command(&mut cmd, Duration::from_secs(120))
        };
        run(&["read-tree", reference])?;
        // status also compares this index to the checkout's original HEAD,
        // which is deliberately different for a dirty archive. diff checks
        // disk against this fresh index; ls-files checks the extra paths.
        run(&[
            "diff",
            "--no-ext-diff",
            "--no-textconv",
            "--exit-code",
            "--ignore-submodules=none",
            "--",
        ])?;
        if !run(&["ls-files", "--others", "--exclude-standard", "-z"])?.is_empty() {
            return Err("Disk has files outside the archive tree".into());
        }
        Ok(())
    })();
    let _ = std::fs::remove_file(index);
    let _ = std::fs::remove_file(index.with_extension("lock"));
    result.map_err(|e: String| format!("{e}; the archive and folder are kept."))
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
