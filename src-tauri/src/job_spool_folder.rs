//! A spool folder the host works in without ever following a link
//! (`job_spool.rs`).
//!
//! A sandboxed agent can write the temp folder, so anything in a spool
//! folder, the folder itself included, may have been put there by it. On
//! Unix every operation is made relative to a folder opened by descriptor
//! with `O_NOFOLLOW | O_DIRECTORY`, after checking it is a real folder of
//! this user's with mode 0700: names are opened with `O_NOFOLLOW`, statted
//! with `AT_SYMLINK_NOFOLLOW`, created with `O_EXCL | O_NOFOLLOW` and
//! removed with `unlinkat`, and only a regular file is ever removed. A link
//! anywhere is refused, never followed, and never removed through.
//!
//! On Windows the same checks are made by path (`symlink_metadata`, which
//! takes a junction for a link) before each operation: a link swapped in
//! between the check and the operation is not caught there. Stable Rust
//! has no folder handle to work relative to; that half is unverified.

use std::io;

/// What a name in the folder is, as the folder holds it now.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub(super) struct Meta {
    /// A regular file: not a link, a folder, a pipe or a device.
    pub regular: bool,
    pub len: u64,
    /// Modification time, (seconds, nanoseconds).
    pub mtime: (i64, i64),
    /// The file's inode number (0 where the platform gives none).
    pub ino: u64,
}

fn not_plain(name: &str) -> io::Error {
    io::Error::new(
        io::ErrorKind::InvalidInput,
        format!("{name} is not a plain file (a link, a folder or a pipe), so it is left alone"),
    )
}

/// A name the host made or listed: one component, nothing that walks.
fn check_name(name: &str) -> io::Result<()> {
    if name.is_empty() || name == "." || name == ".." || name.contains(['/', '\\', '\0']) {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            format!("{name:?} is not a name in the folder"),
        ));
    }
    Ok(())
}

#[cfg(test)]
thread_local! {
    /// Names a listing leaves out, as a `readdir` entry error would: a
    /// file that is there but was not listed.
    pub(super) static HIDDEN: std::cell::RefCell<std::collections::BTreeSet<String>> =
        Default::default();
}

#[cfg(test)]
fn hidden(name: &str) -> bool {
    HIDDEN.with(|hidden| hidden.borrow().contains(name))
}

#[cfg(unix)]
pub(super) use unix::Folder;
#[cfg(not(unix))]
pub(super) use windows::Folder;

#[cfg(unix)]
mod unix {
    use super::{check_name, not_plain, Meta};
    use std::ffi::{CStr, CString};
    use std::io;
    use std::os::fd::{AsRawFd, FromRawFd, OwnedFd};
    use std::os::unix::ffi::OsStrExt;
    use std::path::Path;

    /// A folder held open by descriptor.
    pub(in crate::job_spool) struct Folder {
        fd: OwnedFd,
        /// (device, inode) of the folder the descriptor holds.
        pub(in crate::job_spool) ident: (u64, u64),
    }

    fn cstring(name: &str) -> io::Result<CString> {
        check_name(name)?;
        CString::new(name).map_err(|e| io::Error::new(io::ErrorKind::InvalidInput, e))
    }

    fn last() -> io::Error {
        io::Error::last_os_error()
    }

    fn fstat(fd: i32) -> io::Result<libc::stat> {
        // SAFETY: an all-zero stat is a valid out-parameter; fstat fills it.
        let mut st: libc::stat = unsafe { std::mem::zeroed() };
        // SAFETY: fd is a descriptor this module holds open.
        if unsafe { libc::fstat(fd, &mut st) } != 0 {
            return Err(last());
        }
        Ok(st)
    }

    fn meta(st: &libc::stat) -> Meta {
        Meta {
            regular: st.st_mode & libc::S_IFMT == libc::S_IFREG,
            len: st.st_size as u64,
            mtime: (st.st_mtime as i64, st.st_mtime_nsec as i64),
            ino: st.st_ino as u64,
        }
    }

    /// The descriptor holds a folder, of this user's. With `fix`, its mode
    /// is made 0700; without, a mode that is not 0700 is refused.
    fn checked(fd: OwnedFd, what: &str, fix: bool) -> io::Result<Folder> {
        let st = fstat(fd.as_raw_fd())?;
        if st.st_mode & libc::S_IFMT != libc::S_IFDIR {
            return Err(io::Error::other(format!("{what} is not a folder")));
        }
        // SAFETY: geteuid has no preconditions.
        if st.st_uid != unsafe { libc::geteuid() } {
            return Err(io::Error::other(format!("{what} belongs to another user")));
        }
        if fix {
            // SAFETY: fd is a folder descriptor held open here.
            if unsafe { libc::fchmod(fd.as_raw_fd(), 0o700) } != 0 {
                return Err(last());
            }
        } else if st.st_mode & 0o777 != 0o700 {
            return Err(io::Error::other(format!(
                "{what} is mode {:o}, not 0700",
                st.st_mode & 0o777
            )));
        }
        Ok(Folder {
            fd,
            ident: (st.st_dev as u64, st.st_ino as u64),
        })
    }

    const DIR_FLAGS: i32 = libc::O_RDONLY | libc::O_DIRECTORY | libc::O_NOFOLLOW | libc::O_CLOEXEC;

    impl Folder {
        /// The folder at `path`, made 0700. Its last component must not be
        /// a link (the folders above it are the system's own).
        pub(in crate::job_spool) fn adopt(path: &Path) -> io::Result<Folder> {
            let c = CString::new(path.as_os_str().as_bytes())
                .map_err(|e| io::Error::new(io::ErrorKind::InvalidInput, e))?;
            // SAFETY: c is a valid C string.
            let fd = unsafe { libc::open(c.as_ptr(), DIR_FLAGS) };
            if fd < 0 {
                return Err(last());
            }
            // SAFETY: fd was just opened and is owned from here on.
            checked(
                unsafe { OwnedFd::from_raw_fd(fd) },
                &path.display().to_string(),
                true,
            )
        }

        fn open_dir(&self, name: &str) -> io::Result<OwnedFd> {
            let c = cstring(name)?;
            // SAFETY: self.fd is open; c is a valid C string.
            let fd = unsafe { libc::openat(self.fd.as_raw_fd(), c.as_ptr(), DIR_FLAGS) };
            if fd < 0 {
                return Err(last());
            }
            // SAFETY: fd was just opened and is owned from here on.
            Ok(unsafe { OwnedFd::from_raw_fd(fd) })
        }

        /// The folder `name` in this one, made 0700: for a folder the host
        /// has just made.
        pub(in crate::job_spool) fn adopt_in(&self, name: &str) -> io::Result<Folder> {
            checked(self.open_dir(name)?, name, true)
        }

        /// The folder `name` in this one, which must be a real folder of
        /// this user's with mode 0700.
        pub(in crate::job_spool) fn open_in(&self, name: &str) -> io::Result<Folder> {
            checked(self.open_dir(name)?, name, false)
        }

        /// Every name in the folder but `.` and `..`.
        pub(in crate::job_spool) fn names(&self) -> io::Result<Vec<String>> {
            // fdopendir takes the descriptor it is given: hand it its own.
            // SAFETY: self.fd is open.
            let dup = unsafe { libc::fcntl(self.fd.as_raw_fd(), libc::F_DUPFD_CLOEXEC, 0) };
            if dup < 0 {
                return Err(last());
            }
            // SAFETY: dup is a folder descriptor owned by nobody else.
            let dir = unsafe { libc::fdopendir(dup) };
            if dir.is_null() {
                let error = last();
                // SAFETY: fdopendir failed, so dup is still ours to close.
                unsafe { libc::close(dup) };
                return Err(error);
            }
            // SAFETY: dir is a fresh stream at the folder's start.
            unsafe { libc::rewinddir(dir) };
            let mut names = Vec::new();
            loop {
                // SAFETY: dir is open until closedir below.
                let entry = unsafe { libc::readdir(dir) };
                if entry.is_null() {
                    break;
                }
                // SAFETY: readdir returned an entry whose name is NUL-ended.
                let name = unsafe { CStr::from_ptr((*entry).d_name.as_ptr()) };
                let name = String::from_utf8_lossy(name.to_bytes()).into_owned();
                if name == "." || name == ".." {
                    continue;
                }
                #[cfg(test)]
                if super::hidden(&name) {
                    continue;
                }
                names.push(name);
            }
            // SAFETY: dir is open; this closes it and dup with it.
            unsafe { libc::closedir(dir) };
            Ok(names)
        }

        /// What `name` is, never through a link.
        pub(in crate::job_spool) fn stat(&self, name: &str) -> io::Result<Meta> {
            let c = cstring(name)?;
            // SAFETY: an all-zero stat is a valid out-parameter.
            let mut st: libc::stat = unsafe { std::mem::zeroed() };
            // SAFETY: self.fd is open; c is a valid C string.
            let result = unsafe {
                libc::fstatat(
                    self.fd.as_raw_fd(),
                    c.as_ptr(),
                    &mut st,
                    libc::AT_SYMLINK_NOFOLLOW,
                )
            };
            if result != 0 {
                return Err(last());
            }
            Ok(meta(&st))
        }

        /// A regular file to read. A link is refused (`O_NOFOLLOW`), and so
        /// is a pipe or a device (opened without blocking, then refused).
        pub(in crate::job_spool) fn open_file(
            &self,
            name: &str,
        ) -> io::Result<(std::fs::File, Meta)> {
            let c = cstring(name)?;
            let flags = libc::O_RDONLY | libc::O_NOFOLLOW | libc::O_NONBLOCK | libc::O_CLOEXEC;
            // SAFETY: self.fd is open; c is a valid C string.
            let fd = unsafe { libc::openat(self.fd.as_raw_fd(), c.as_ptr(), flags) };
            if fd < 0 {
                let error = last();
                return Err(if error.raw_os_error() == Some(libc::ELOOP) {
                    not_plain(name)
                } else {
                    error
                });
            }
            // SAFETY: fd was just opened and is owned from here on.
            let fd = unsafe { OwnedFd::from_raw_fd(fd) };
            let meta = meta(&fstat(fd.as_raw_fd())?);
            if !meta.regular {
                return Err(not_plain(name));
            }
            Ok((std::fs::File::from(fd), meta))
        }

        /// Remove `name` if it is a regular file. `unlinkat` removes the
        /// name and never what a link points at; anything else is left.
        pub(in crate::job_spool) fn remove_file(&self, name: &str) -> io::Result<()> {
            if !self.stat(name)?.regular {
                return Err(not_plain(name));
            }
            let c = cstring(name)?;
            // SAFETY: self.fd is open; c is a valid C string.
            if unsafe { libc::unlinkat(self.fd.as_raw_fd(), c.as_ptr(), 0) } != 0 {
                return Err(last());
            }
            Ok(())
        }

        /// Write a new file: never one that is there, never through a link.
        pub(in crate::job_spool) fn write_new(&self, name: &str, bytes: &[u8]) -> io::Result<()> {
            use std::io::Write as _;
            let c = cstring(name)?;
            let flags =
                libc::O_WRONLY | libc::O_CREAT | libc::O_EXCL | libc::O_NOFOLLOW | libc::O_CLOEXEC;
            // SAFETY: self.fd is open; c is a valid C string.
            let fd = unsafe {
                libc::openat(
                    self.fd.as_raw_fd(),
                    c.as_ptr(),
                    flags,
                    0o600 as libc::c_uint,
                )
            };
            if fd < 0 {
                return Err(last());
            }
            // SAFETY: fd was just made and is owned from here on.
            let mut file = std::fs::File::from(unsafe { OwnedFd::from_raw_fd(fd) });
            file.write_all(bytes)
        }

        /// Rename within the folder. A link at `to` is replaced, as a name;
        /// what it pointed at is not touched.
        pub(in crate::job_spool) fn rename(&self, from: &str, to: &str) -> io::Result<()> {
            let (f, t) = (cstring(from)?, cstring(to)?);
            let fd = self.fd.as_raw_fd();
            // SAFETY: fd is open; both are valid C strings.
            if unsafe { libc::renameat(fd, f.as_ptr(), fd, t.as_ptr()) } != 0 {
                return Err(last());
            }
            Ok(())
        }

        /// Remove the folder `name` in this one if it is empty.
        pub(in crate::job_spool) fn remove_dir_in(&self, name: &str) -> io::Result<()> {
            let c = cstring(name)?;
            // SAFETY: self.fd is open; c is a valid C string. AT_REMOVEDIR
            // refuses a link (ENOTDIR) and a folder that holds anything.
            if unsafe { libc::unlinkat(self.fd.as_raw_fd(), c.as_ptr(), libc::AT_REMOVEDIR) } != 0 {
                return Err(last());
            }
            Ok(())
        }
    }
}

#[cfg(not(unix))]
mod windows {
    use super::{check_name, not_plain, Meta};
    use std::io;
    use std::path::{Path, PathBuf};

    /// A folder known by its path, checked before each operation.
    pub(in crate::job_spool) struct Folder {
        path: PathBuf,
        /// No folder identity on stable Rust here.
        pub(in crate::job_spool) ident: (u64, u64),
    }

    fn meta(m: &std::fs::Metadata) -> Meta {
        let mtime = m
            .modified()
            .ok()
            .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
            .map(|d| (d.as_secs() as i64, d.subsec_nanos() as i64))
            .unwrap_or((0, 0));
        Meta {
            regular: m.file_type().is_file(),
            len: m.len(),
            mtime,
            ino: 0,
        }
    }

    fn real_dir(path: &Path) -> io::Result<()> {
        let m = std::fs::symlink_metadata(path)?;
        if m.file_type().is_symlink() || !m.is_dir() {
            return Err(io::Error::other(format!(
                "{} is not a folder (or is a link)",
                path.display()
            )));
        }
        Ok(())
    }

    impl Folder {
        pub(in crate::job_spool) fn adopt(path: &Path) -> io::Result<Folder> {
            real_dir(path)?;
            Ok(Folder {
                path: path.into(),
                ident: (0, 0),
            })
        }

        fn at(&self, name: &str) -> io::Result<PathBuf> {
            check_name(name)?;
            Ok(self.path.join(name))
        }

        pub(in crate::job_spool) fn adopt_in(&self, name: &str) -> io::Result<Folder> {
            Self::adopt(&self.at(name)?)
        }

        pub(in crate::job_spool) fn open_in(&self, name: &str) -> io::Result<Folder> {
            Self::adopt(&self.at(name)?)
        }

        pub(in crate::job_spool) fn names(&self) -> io::Result<Vec<String>> {
            real_dir(&self.path)?;
            let mut names = Vec::new();
            for entry in std::fs::read_dir(&self.path)? {
                let name = entry?.file_name().to_string_lossy().into_owned();
                #[cfg(test)]
                if super::hidden(&name) {
                    continue;
                }
                names.push(name);
            }
            Ok(names)
        }

        pub(in crate::job_spool) fn stat(&self, name: &str) -> io::Result<Meta> {
            Ok(meta(&std::fs::symlink_metadata(self.at(name)?)?))
        }

        pub(in crate::job_spool) fn open_file(
            &self,
            name: &str,
        ) -> io::Result<(std::fs::File, Meta)> {
            if !self.stat(name)?.regular {
                return Err(not_plain(name));
            }
            let file = std::fs::File::open(self.at(name)?)?;
            let m = meta(&file.metadata()?);
            if !m.regular {
                return Err(not_plain(name));
            }
            Ok((file, m))
        }

        pub(in crate::job_spool) fn remove_file(&self, name: &str) -> io::Result<()> {
            if !self.stat(name)?.regular {
                return Err(not_plain(name));
            }
            std::fs::remove_file(self.at(name)?)
        }

        pub(in crate::job_spool) fn write_new(&self, name: &str, bytes: &[u8]) -> io::Result<()> {
            use std::io::Write as _;
            std::fs::OpenOptions::new()
                .write(true)
                .create_new(true)
                .open(self.at(name)?)?
                .write_all(bytes)
        }

        pub(in crate::job_spool) fn rename(&self, from: &str, to: &str) -> io::Result<()> {
            std::fs::rename(self.at(from)?, self.at(to)?)
        }

        pub(in crate::job_spool) fn remove_dir_in(&self, name: &str) -> io::Result<()> {
            let path = self.at(name)?;
            real_dir(&path)?;
            std::fs::remove_dir(path)
        }
    }
}

/// Whether a process is there. Only the system's own "no such process"
/// says it is gone: a question that could not be asked, or a process of
/// another user's, is not an answer that it is gone.
pub(crate) fn process_alive(pid: u32) -> bool {
    #[cfg(unix)]
    {
        let Ok(pid) = libc::pid_t::try_from(pid) else {
            return true;
        };
        if pid <= 0 {
            // 0 and below name process groups, not a process.
            return true;
        }
        // SAFETY: signal 0 checks for the process and sends nothing.
        if unsafe { libc::kill(pid, 0) } == 0 {
            return true;
        }
        io::Error::last_os_error().raw_os_error() != Some(libc::ESRCH)
    }
    #[cfg(not(unix))]
    {
        crate::profile_lock::alive(pid)
    }
}
