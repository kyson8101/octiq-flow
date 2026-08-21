//! OctiqFlow as a background service.
//!
//! The desktop app and this share every line of backend code; the difference is
//! that this one has no window, so it can run under launchd, survive a logout,
//! and be reached from a browser without anything visible on screen.
//!
//! What it does NOT serve is the classic terminal UI: those assets live inside
//! the Tauri bundle, and its commands (PTYs above all) exist only inside Tauri.
//! This serves the chat client, at the root, and it needs neither.
//!
//!     cargo run --bin octiq-server
//!     OCTIQ_WEB_BIND=127.0.0.1 OCTIQ_WEB_PORT=1421 octiq-server

fn main() {
    let runtime = match tokio::runtime::Runtime::new() {
        Ok(rt) => rt,
        Err(e) => {
            eprintln!("[server] could not start the async runtime: {e}");
            std::process::exit(1);
        }
    };
    runtime.block_on(octiq_flow_lib::run_headless());
}
