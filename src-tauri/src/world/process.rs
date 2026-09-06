use super::model::Result;
use std::{
    io::{Read, Write},
    path::{Path, PathBuf},
    process::{Command, Stdio},
    thread,
    time::{Duration, Instant},
};

pub fn binary(name: &str) -> Option<PathBuf> {
    let mut dirs: Vec<_> = std::env::var_os("PATH")
        .map(|p| std::env::split_paths(&p).collect())
        .unwrap_or_default();
    dirs.extend([
        PathBuf::from("/opt/homebrew/bin"),
        PathBuf::from("/usr/local/bin"),
    ]);
    if let Some(home) = crate::paths::home_dir() {
        dirs.push(home.join(".local/bin"));
    }
    dirs.into_iter()
        .filter(|p| p.is_absolute())
        .map(|p| p.join(name))
        .find(|p| p.is_file())
}
pub struct Output {
    pub code: Option<i32>,
    pub stdout: String,
    pub stderr: String,
    pub interrupted: bool,
}
fn drain(mut pipe: impl Read, cap: usize) -> String {
    let mut saved = Vec::new();
    let mut buf = [0; 8192];
    while let Ok(n) = pipe.read(&mut buf) {
        if n == 0 {
            break;
        }
        let keep = n.min(cap.saturating_sub(saved.len()));
        saved.extend_from_slice(&buf[..keep]);
    }
    String::from_utf8_lossy(&saved).into_owned()
}
pub fn run(
    mut command: Command,
    input: impl Into<Vec<u8>>,
    limit: Duration,
    mut active: impl FnMut() -> bool,
) -> Result<Output> {
    command
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        command.process_group(0);
    }
    let mut child = command
        .spawn()
        .map_err(|_| "Could not start the configured worker process.")?;
    let mut stdin = child.stdin.take().unwrap();
    let input = input.into();
    let input_thread = thread::spawn(move || stdin.write_all(&input));
    let stdout = child.stdout.take().unwrap();
    let stderr = child.stderr.take().unwrap();
    let out = thread::spawn(move || drain(stdout, 2_000_000));
    let err = thread::spawn(move || drain(stderr, 32_000));
    let start = Instant::now();
    let mut interrupted = false;
    let status = loop {
        if let Ok(Some(status)) = child.try_wait() {
            break Some(status);
        }
        if start.elapsed() >= limit || !active() {
            interrupted = true;
            #[cfg(unix)]
            {
                let _ = Command::new("/bin/kill")
                    .args(["-KILL", "--", &format!("-{}", child.id())])
                    .stdout(Stdio::null())
                    .stderr(Stdio::null())
                    .status();
            }
            let _ = child.kill();
            break child.wait().ok();
        }
        thread::sleep(Duration::from_millis(200));
    };
    let _ = input_thread.join();
    Ok(Output {
        code: status.and_then(|s| s.code()),
        stdout: out.join().unwrap_or_default(),
        stderr: err.join().unwrap_or_default(),
        interrupted,
    })
}
pub fn empty_workspace() -> Result<PathBuf> {
    let path = std::env::temp_dir().join(format!("octiqos-turn-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir(&path).map_err(|_| "Could not create an isolated turn folder.")?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o700))
            .map_err(|_| "Could not secure the temporary turn folder.")?;
    }
    Ok(path)
}
pub struct Cleanup(pub PathBuf);
impl Drop for Cleanup {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

pub fn command(binary: &Path, cwd: &Path) -> Command {
    let mut c = Command::new(binary);
    c.current_dir(cwd);
    c
}
