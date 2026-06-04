// Tauri backend: spawns a login shell inside a PTY, streams its output to the
// frontend as `pty-output` events, and exposes commands to write into and
// resize the PTY. The frontend renders the stream with xterm.js and uses
// `pty_write` to inject text (for example, when a button is clicked).
use std::io::{Read, Write};
use std::sync::Mutex;
use std::thread;

use portable_pty::{native_pty_system, CommandBuilder, MasterPty, PtySize};
use tauri::{Emitter, Manager, State};

/// Holds the live handles to the PTY master so commands can write and resize.
struct PtyState {
    writer: Mutex<Box<dyn Write + Send>>,
    master: Mutex<Box<dyn MasterPty + Send>>,
}

/// Write raw text into the PTY input. This is what a UI button calls to inject
/// text into the running session. Append "\r" to submit the line.
#[tauri::command]
fn pty_write(state: State<PtyState>, data: String) -> Result<(), String> {
    let mut writer = state.writer.lock().map_err(|e| e.to_string())?;
    writer
        .write_all(data.as_bytes())
        .map_err(|e| e.to_string())?;
    writer.flush().map_err(|e| e.to_string())?;
    Ok(())
}

/// Resize the PTY so the program inside knows the new terminal size.
#[tauri::command]
fn pty_resize(state: State<PtyState>, rows: u16, cols: u16) -> Result<(), String> {
    let master = state.master.lock().map_err(|e| e.to_string())?;
    master
        .resize(PtySize {
            rows,
            cols,
            pixel_width: 0,
            pixel_height: 0,
        })
        .map_err(|e| e.to_string())?;
    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .setup(|app| {
            let pty_system = native_pty_system();
            let pair = pty_system.openpty(PtySize {
                rows: 30,
                cols: 100,
                pixel_width: 0,
                pixel_height: 0,
            })?;

            // A login shell so PATH is fully populated. A GUI app does not
            // inherit the interactive shell PATH, so `claude` would not be
            // found if we spawned it directly. The shell resolves it instead.
            let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/zsh".to_string());
            let mut cmd = CommandBuilder::new(shell);
            cmd.arg("-l");
            cmd.env("TERM", "xterm-256color");
            if let Ok(home) = std::env::var("HOME") {
                cmd.cwd(home);
            }

            let reader = pair.master.try_clone_reader()?;
            let writer = pair.master.take_writer()?;
            let child = pair.slave.spawn_command(cmd)?;

            // Keep the child process alive and reap it when it exits.
            thread::spawn(move || {
                let mut child = child;
                let _ = child.wait();
            });

            // Stream PTY output to the frontend.
            let app_handle = app.handle().clone();
            let mut reader = reader;
            thread::spawn(move || {
                let mut buf = [0u8; 4096];
                loop {
                    match reader.read(&mut buf) {
                        Ok(0) => break, // EOF: shell exited
                        Ok(n) => {
                            let chunk = String::from_utf8_lossy(&buf[..n]).to_string();
                            let _ = app_handle.emit("pty-output", chunk);
                        }
                        Err(_) => break,
                    }
                }
            });

            app.manage(PtyState {
                writer: Mutex::new(writer),
                master: Mutex::new(pair.master),
            });

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![pty_write, pty_resize])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
