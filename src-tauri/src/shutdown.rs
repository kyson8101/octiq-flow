//! A graceful stop for the headless server (SIGTERM, SIGINT).
//!
//! The server used to die at once on either signal, which lost whatever was
//! still queued in memory only: the closing preview of a turn that ended less
//! than a second before (`agent_chat::PreviewBatch`). Now the signal is
//! turned into a byte on a pipe (the only thing a handler may safely do), and
//! a thread reads it, flushes what is owed, and then lets the process die the
//! way the signal would have killed it, so the parent still sees the signal
//! in its exit status. A second signal while flushing kills at once.
//!
//! Only the preview batch is flushed. Every other store writes through at its
//! own boundary; SIGKILL and power loss skip this entirely.

#[cfg(unix)]
pub fn install() {
    use std::sync::atomic::{AtomicI32, Ordering};

    static WRITE_FD: AtomicI32 = AtomicI32::new(-1);

    extern "C" fn on_signal(signal: libc::c_int) {
        let fd = WRITE_FD.load(Ordering::Relaxed);
        if fd >= 0 {
            let byte = signal as u8;
            // Async-signal-safe; a full pipe just drops the repeat.
            unsafe {
                libc::write(fd, (&byte as *const u8).cast(), 1);
            }
        }
    }

    let mut fds = [0 as libc::c_int; 2];
    // SAFETY: plain libc calls on descriptors this function just made.
    unsafe {
        if libc::pipe(fds.as_mut_ptr()) != 0 {
            return;
        }
        for fd in fds {
            // Never inherited by the agents this server starts.
            libc::fcntl(fd, libc::F_SETFD, libc::FD_CLOEXEC);
        }
        libc::fcntl(fds[1], libc::F_SETFL, libc::O_NONBLOCK);
    }
    let (read_fd, write_fd) = (fds[0], fds[1]);
    let reader = std::thread::Builder::new()
        .name("shutdown-watch".into())
        .spawn(move || {
            let mut byte = 0u8;
            // SAFETY: reads one byte into a local.
            let got = unsafe { libc::read(read_fd, (&mut byte as *mut u8).cast(), 1) };
            if got != 1 {
                return;
            }
            let signal = libc::c_int::from(byte);
            // A second signal is the default's again.
            unsafe {
                libc::signal(signal, libc::SIG_DFL);
            }
            eprintln!("[server] stopping: writing what is still owed");
            crate::agent_chat::flush_previews();
            unsafe {
                libc::raise(signal);
            }
        });
    if reader.is_err() {
        return;
    }
    WRITE_FD.store(write_fd, Ordering::Relaxed);
    for signal in [libc::SIGTERM, libc::SIGINT] {
        // SAFETY: the handler only calls `write`.
        unsafe {
            let mut action: libc::sigaction = std::mem::zeroed();
            action.sa_sigaction = on_signal as usize;
            action.sa_flags = libc::SA_RESTART;
            libc::sigemptyset(&mut action.sa_mask);
            libc::sigaction(signal, &action, std::ptr::null_mut());
        }
    }
}

#[cfg(not(unix))]
pub fn install() {}
