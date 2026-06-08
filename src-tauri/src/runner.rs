// Dev-space process runner. Runs an action's command as a separate process and
// streams its output to the frontend. The command runs through an interactive
// login shell (`$SHELL -i -c "<cmd>"`) so the user's zsh aliases (for example
// `deploy-performance-api`) resolve. Each run has its own process group so a
// long-running command (like `pnpm dev:all`) can be stopped as a whole tree.
use std::collections::HashMap;
use std::io::Read;
use std::os::unix::process::CommandExt;
use std::process::{Command, Stdio};
use std::sync::Mutex;
use std::thread;

use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager, State};

/// Tracks running processes by run id, storing each process-group id so a run
/// can be killed as a whole tree.
#[derive(Default)]
pub struct RunnerState {
    running: Mutex<HashMap<String, u32>>,
}

#[derive(Clone, Serialize)]
struct OutputEvent {
    run_id: String,
    chunk: String,
}

#[derive(Clone, Serialize)]
struct ExitEvent {
    run_id: String,
    code: Option<i32>,
}

/// Stream one piped output (stdout or stderr) to the frontend as it arrives.
fn pump<R: Read + Send + 'static>(app: AppHandle, run_id: String, mut reader: R) {
    thread::spawn(move || {
        let mut buf = [0u8; 4096];
        loop {
            match reader.read(&mut buf) {
                Ok(0) => break,
                Ok(n) => {
                    let chunk = String::from_utf8_lossy(&buf[..n]).to_string();
                    let _ = app.emit(
                        "action-output",
                        OutputEvent {
                            run_id: run_id.clone(),
                            chunk,
                        },
                    );
                }
                Err(_) => break,
            }
        }
    });
}

/// Run a Dev-space action command as a separate process. `run_id` is generated
/// by the frontend so it can subscribe to this run's output and exit events.
#[tauri::command]
pub fn run_action(
    app: AppHandle,
    state: State<RunnerState>,
    run_id: String,
    command: String,
    cwd: String,
) -> Result<(), String> {
    let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/zsh".to_string());
    let mut cmd = Command::new(shell);
    cmd.arg("-i").arg("-c").arg(&command);
    if !cwd.trim().is_empty() {
        cmd.current_dir(&cwd);
    }
    cmd.env("TERM", "xterm-256color");
    cmd.stdin(Stdio::null());
    cmd.stdout(Stdio::piped());
    cmd.stderr(Stdio::piped());
    // Own process group so stop_action can kill the whole tree.
    cmd.process_group(0);

    let mut child = cmd.spawn().map_err(|e| e.to_string())?;
    let pid = child.id();
    state
        .running
        .lock()
        .map_err(|e| e.to_string())?
        .insert(run_id.clone(), pid);

    if let Some(out) = child.stdout.take() {
        pump(app.clone(), run_id.clone(), out);
    }
    if let Some(err) = child.stderr.take() {
        pump(app.clone(), run_id.clone(), err);
    }

    // Wait for exit on a thread, then tell the frontend and drop the record.
    let app_exit = app.clone();
    let run_id_exit = run_id.clone();
    thread::spawn(move || {
        let code = child.wait().ok().and_then(|s| s.code());
        let _ = app_exit.emit(
            "action-exit",
            ExitEvent {
                run_id: run_id_exit.clone(),
                code,
            },
        );
        if let Some(state) = app_exit.try_state::<RunnerState>() {
            if let Ok(mut running) = state.running.lock() {
                running.remove(&run_id_exit);
            }
        }
    });

    Ok(())
}

/// Stop a running action by killing its whole process group.
#[tauri::command]
pub fn stop_action(state: State<RunnerState>, run_id: String) -> Result<(), String> {
    let pid = state
        .running
        .lock()
        .map_err(|e| e.to_string())?
        .get(&run_id)
        .copied();
    if let Some(pid) = pid {
        // Negative pid targets the process group (set via process_group above).
        let _ = Command::new("kill")
            .arg("-TERM")
            .arg(format!("-{pid}"))
            .status();
    }
    Ok(())
}
