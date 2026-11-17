//! Non-interactive Git helpers with timeouts and process containment.
//! Each caller decides its network and branch policy.
use std::{
    io::Read,
    path::Path,
    process::{Command, Stdio},
    time::{Duration, Instant},
};

pub(crate) mod process;

// Every Git read while lifecycle is held shares the same final deadline.
// Nested helpers cannot silently restart a fixed 15-second timeout.
thread_local! {
    static FINAL_DEADLINE: std::cell::Cell<Option<Instant>> = const { std::cell::Cell::new(None) };
}
/// The one bound every final check runs inside: 10 seconds. Unit tests run
/// hundreds of real Git and `lsof` processes in parallel on a loaded machine,
/// where the same work takes several times longer, so a test build gives the
/// bound twelve times the room. A test that is about the bound itself names its
/// own (`FinalBudget::with_timeout`, `final_budget`'s explicit clock).
#[cfg(not(test))]
pub(crate) const FINAL_BOUND: Duration = Duration::from_secs(10);
#[cfg(test)]
pub(crate) const FINAL_BOUND: Duration = Duration::from_secs(120);

pub(crate) struct FinalBudget(Option<Instant>);
impl FinalBudget {
    pub(crate) fn start() -> Self {
        Self::with_timeout(FINAL_BOUND)
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
    let (status, bytes, errors) = command_run(cmd, timeout, input, limit)?;
    if !status.success() || strict_errors && !errors.is_empty() {
        return Err(format!(
            "Command failed: {}",
            String::from_utf8_lossy(&errors).trim()
        ));
    }
    Ok(bytes)
}
/// Runs the command to its end and hands back how it ended, with stdout and
/// stderr, so a caller that must tell an exit code from a failure to ask can.
fn command_run(
    cmd: &mut Command,
    timeout: Duration,
    input: Option<Vec<u8>>,
    limit: usize,
) -> Result<(std::process::ExitStatus, Vec<u8>, Vec<u8>), String> {
    let timeout = remaining(timeout)?;
    let start = Instant::now();
    cmd.stdin(if input.is_some() {
        Stdio::piped()
    } else {
        Stdio::null()
    })
    .stdout(Stdio::piped())
    .stderr(Stdio::piped());
    // One owner contains Git and every filter descendant on every return,
    // including timeout after the direct child exits with pipes still open.
    let mut process = process::Process::spawn(cmd)?;
    let child = &mut process.child;
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
            return Err("Command timed out; nothing is assumed about its outcome.".into());
        }
        match child.try_wait() {
            Ok(Some(s)) => break s,
            Ok(None) => std::thread::sleep(Duration::from_millis(2)),
            Err(e) => {
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
    Ok((status, bytes, errors))
}
/// Git's own answer, untouched: its exit code (None when a signal ended it),
/// stdout and stderr. Only a failure to run it at all is an `Err`.
pub(crate) fn git_exit(
    root: &str,
    args: &[&str],
) -> Result<(Option<i32>, Vec<u8>, Vec<u8>), String> {
    let (status, out, err) = command_run(
        &mut git_command(root, args),
        Duration::from_secs(15),
        None,
        32 * 1024 * 1024,
    )?;
    Ok((status.code(), out, err))
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
/// Whether the local branch `refs/heads/<branch>` exists, asked of the
/// repository at `root`. `Ok(true)` when git resolves it to a commit.
/// `Ok(false)` ONLY with positive proof of absence, every one of:
/// `rev-parse --verify --quiet` exits exactly 1 with nothing on stderr; a full
/// listing of `refs/heads` (success, nothing on stderr) has no name equal to it
/// ignoring case; and every directory that exists on its path under the
/// repository's ref folder can be read. Anything else is `Err`, which means
/// unknown: an empty successful listing is not absence (a case-insensitive
/// filesystem lists the real `FEATURE/X` as nothing for `feature/x`, and an
/// unreadable loose-ref folder lists as empty with exit 0). Refnames are
/// compared byte for byte, never through a trimming helper. A non-ASCII name
/// is unknown: Unicode-normalising filesystems fold names this does not.
pub(crate) fn local_branch_exists(root: &str, branch: &str) -> Result<bool, String> {
    let unknown = |why: String| {
        format!("Whether the branch {branch} exists could not be confirmed ({why}); nothing is assumed about it.")
    };
    if branch.is_empty() || !branch.is_ascii() {
        return Err(unknown("its name is empty or not plain ASCII".into()));
    }
    let wanted = format!("refs/heads/{branch}");
    let (code, out, err) = git_exit(
        root,
        &[
            "rev-parse",
            "--verify",
            "--quiet",
            &format!("{wanted}^{{commit}}"),
        ],
    )?;
    match code {
        Some(0) => return Ok(true),
        Some(1) if err.is_empty() && out.is_empty() => {}
        other => {
            return Err(unknown(format!(
                "rev-parse answered {other:?}: {}",
                String::from_utf8_lossy(&err).trim()
            )))
        }
    }
    let (code, out, err) = git_exit(root, &["for-each-ref", "--format=%(refname)", "refs/heads"])?;
    if code != Some(0) || !err.is_empty() {
        return Err(unknown(format!(
            "listing refs answered {code:?}: {}",
            String::from_utf8_lossy(&err).trim()
        )));
    }
    let listed = String::from_utf8(out).map_err(|e| unknown(e.to_string()))?;
    if listed.lines().any(|l| l.eq_ignore_ascii_case(&wanted)) {
        return Err(unknown(
            "a ref of that name exists but does not resolve to a commit, or differs only in case"
                .into(),
        ));
    }
    // Loose refs live under the repository's COMMON git dir, also for a
    // linked worktree. Every folder that exists on the branch's path must be
    // readable, or a ref inside it could be hidden from both git calls above.
    let (code, out, err) = git_exit(root, &["rev-parse", "--git-common-dir"])?;
    if code != Some(0) || !err.is_empty() {
        return Err(unknown("the git directory could not be found".into()));
    }
    let common = String::from_utf8(out).map_err(|e| unknown(e.to_string()))?;
    let common = common.strip_suffix('\n').unwrap_or(&common);
    let common = Path::new(root).join(common);
    let mut dir = common.join("refs").join("heads");
    let mut parts = branch.split('/');
    loop {
        match std::fs::symlink_metadata(&dir) {
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(false),
            Err(e) => return Err(unknown(format!("{} could not be read: {e}", dir.display()))),
            Ok(m) if m.is_dir() => {
                std::fs::read_dir(&dir)
                    .map_err(|e| unknown(format!("{} could not be read: {e}", dir.display())))?
                    .collect::<Result<Vec<_>, _>>()
                    .map_err(|e| unknown(format!("{} could not be read: {e}", dir.display())))?;
            }
            Ok(_) => {
                return Err(unknown(format!(
                    "{} exists and is not a folder",
                    dir.display()
                )))
            }
        }
        match parts.next() {
            Some(part) => dir.push(part),
            None => return Ok(false),
        }
    }
}
pub(crate) fn text(root: &str, args: &[&str]) -> Result<String, String> {
    String::from_utf8(git(root, args)?)
        .map(|s| s.trim_end().to_owned())
        .map_err(|e| e.to_string())
}
/// Runs `action` without the shared final deadline, which a caller that has
/// already used it up must not apply to its way back (an undo is a rename and
/// is never skipped for want of time). Every command still has its own bound.
pub(crate) fn unbudgeted<T>(action: impl FnOnce() -> T) -> T {
    let previous = FINAL_DEADLINE.with(|d| d.replace(None));
    let restore = FinalBudget(previous);
    let result = action();
    drop(restore);
    result
}
/// Moves a linked worktree and keeps Git's own record of it consistent.
/// Git refuses a destination that exists and renames in place, so a move
/// across volumes fails whole instead of copying.
pub(crate) fn move_worktree(repo: &str, from: &str, to: &str) -> Result<(), String> {
    git(repo, &["worktree", "move", "--", from, to]).map(|_| ())
}
/// Re-links a worktree whose folder was moved without Git being told.
pub(crate) fn repair_worktree(repo: &str, path: &str) -> Result<(), String> {
    git(repo, &["worktree", "repair", "--", path]).map(|_| ())
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

#[cfg(test)]
mod branch_proof_tests {
    use super::local_branch_exists;
    use crate::git_ops::workflow::tests::Repo;
    use std::path::Path;

    /// A path that answers to the other case is a case-folding filesystem
    /// (macOS and Windows by default): the one where an alias of a branch's
    /// name resolves to the real branch.
    fn case_insensitive(repo: &Repo) -> bool {
        let upper = repo.root.to_uppercase();
        upper != repo.root && Path::new(&upper).exists()
    }

    #[test]
    fn a_branch_that_is_there_is_found_and_one_that_is_not_is_proven_absent() {
        let repo = Repo::new();
        repo.git(&["branch", "feature/one"]);
        assert_eq!(local_branch_exists(&repo.root, "feature/one"), Ok(true));
        assert_eq!(local_branch_exists(&repo.root, "feature/two"), Ok(false));
        assert_eq!(local_branch_exists(&repo.root, "other/one"), Ok(false));
        // A packed branch is found too: no loose file is needed.
        repo.git(&["pack-refs", "--all"]);
        assert_eq!(local_branch_exists(&repo.root, "feature/one"), Ok(true));
        assert_eq!(local_branch_exists(&repo.root, "feature/two"), Ok(false));
    }

    #[test]
    fn a_name_is_never_compared_through_a_trimming_helper() {
        let repo = Repo::new();
        // `text` trims trailing white space, a no-break space included, so a
        // name ending in one used to read as the name without it.
        repo.git(&["branch", "feature/nbsp\u{a0}"]);
        assert!(local_branch_exists(&repo.root, "feature/nbsp\u{a0}").is_err());
        assert_ne!(local_branch_exists(&repo.root, "feature/nbsp"), Ok(true));
    }

    #[test]
    fn a_branch_differing_only_in_case_is_never_proven_absent() {
        // Packed, so the lookup is by exact name: the alias does not resolve,
        // but the listing names it.
        let repo = Repo::new();
        repo.git(&["branch", "Feature/Alias"]);
        repo.git(&["pack-refs", "--all"]);
        let alias = local_branch_exists(&repo.root, "feature/alias");
        assert!(
            alias.is_err(),
            "a case alias is unknown, not absent: {alias:?}"
        );
        // Loose: a case-folding filesystem resolves the alias to the real
        // branch although for-each-ref of the alias lists nothing.
        let repo = Repo::new();
        repo.git(&["branch", "Feature/Alias"]);
        let alias = local_branch_exists(&repo.root, "feature/alias");
        if case_insensitive(&repo) {
            assert_ne!(
                alias,
                Ok(false),
                "empty for-each-ref is not absence: {alias:?}"
            );
        } else {
            eprintln!("case-sensitive filesystem: a loose alias is a different file; skipped");
        }
    }

    #[cfg(unix)]
    #[test]
    fn an_unreadable_loose_ref_folder_is_unknown_not_absent() {
        use std::os::unix::fs::PermissionsExt;
        let repo = Repo::new();
        let hidden = Path::new(&repo.root).join(".git/refs/heads/hidden");
        std::fs::create_dir_all(&hidden).unwrap();
        std::fs::set_permissions(&hidden, std::fs::Permissions::from_mode(0o000)).unwrap();
        let unreadable = std::fs::read_dir(&hidden).is_err();
        let answer = local_branch_exists(&repo.root, "hidden/branch");
        std::fs::set_permissions(&hidden, std::fs::Permissions::from_mode(0o755)).unwrap();
        if !unreadable {
            eprintln!("modes are not enforced for this user; skipped");
            return;
        }
        assert!(answer.is_err(), "unreadable means unknown: {answer:?}");
    }

    #[test]
    fn a_failed_git_call_or_a_missing_repository_is_unknown() {
        let repo = Repo::new();
        let missing = format!("{}-does-not-exist", repo.root);
        assert!(local_branch_exists(&missing, "feature/one").is_err());
        assert!(local_branch_exists(&repo.root, "").is_err());
    }
}
