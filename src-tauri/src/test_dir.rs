//! A scratch directory under the OS temp dir that removes itself. Tests only.
//!
//! A test that needs somewhere on disk takes one of these rather than joining a
//! name onto `std::env::temp_dir()` by hand. The directory is deleted when the
//! guard drops, and a failed assertion still drops it while the panic unwinds,
//! so a failing test leaves nothing behind either. Cleanup written at the end
//! of a test body never ran on failure, and most tests had none at all: the
//! suite was leaving tens of thousands of `octiq-*` directories in `$TMPDIR`.
//!
//! Keep the guard alive for as long as anything uses the path. A struct that
//! carries a test's paths carries the guard too.

use std::ffi::OsStr;
use std::ops::Deref;
use std::path::{Path, PathBuf};

pub struct TestDir(pub(crate) PathBuf);

impl TestDir {
    /// Creates an empty `$TMPDIR/octiq-<label>-<uuid>`.
    pub fn new(label: &str) -> Self {
        let path =
            std::env::temp_dir().join(format!("octiq-{label}-{}", uuid::Uuid::new_v4().simple()));
        std::fs::create_dir_all(&path).expect("create a test directory");
        Self(path)
    }

    /// Hands the directory to the end of the process, for a module that keeps
    /// one in a static for the whole test binary. A static is never dropped,
    /// so the folder is removed by an exit hook instead, after the last test.
    /// Only Unix has the hook; elsewhere the folder outlives the run.
    pub fn remove_at_exit(self) -> PathBuf {
        static HOOK: std::sync::Once = std::sync::Once::new();
        let this = std::mem::ManuallyDrop::new(self);
        let path = this.0.clone();
        if let Ok(mut held) = AT_EXIT.lock() {
            held.push(path.clone());
        }
        HOOK.call_once(|| {
            #[cfg(unix)]
            // SAFETY: `atexit` only records a function pointer, and
            // `remove_held` is a plain `extern "C"` function that never unwinds.
            unsafe {
                atexit(remove_held);
            }
        });
        path
    }
}

static AT_EXIT: std::sync::Mutex<Vec<PathBuf>> = std::sync::Mutex::new(Vec::new());

#[cfg(unix)]
extern "C" {
    fn atexit(hook: extern "C" fn()) -> std::os::raw::c_int;
}

#[cfg(unix)]
extern "C" fn remove_held() {
    if let Ok(mut held) = AT_EXIT.lock() {
        for path in held.drain(..) {
            let _ = std::fs::remove_dir_all(path);
        }
    }
}

impl Deref for TestDir {
    type Target = Path;

    fn deref(&self) -> &Path {
        &self.0
    }
}

impl AsRef<Path> for TestDir {
    fn as_ref(&self) -> &Path {
        &self.0
    }
}

impl AsRef<OsStr> for TestDir {
    fn as_ref(&self) -> &OsStr {
        self.0.as_os_str()
    }
}

impl Drop for TestDir {
    fn drop(&mut self) {
        // A test may have removed it already, or left a read-only file behind
        // on purpose; neither is worth a second panic while one unwinds.
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

/// A path named `name` inside a `TestDir` of its own, for a test that wants a
/// file, or a folder whose siblings must be cleaned up with it (git puts a
/// repository's `.worktrees` beside it). Nothing is created at the path
/// itself; the folder it sits in is removed when this drops.
pub struct TestPath {
    path: PathBuf,
    _dir: TestDir,
}

impl TestPath {
    pub fn new(label: &str, name: &str) -> Self {
        let dir = TestDir::new(label);
        Self {
            path: dir.join(name),
            _dir: dir,
        }
    }
}

impl Deref for TestPath {
    type Target = Path;

    fn deref(&self) -> &Path {
        &self.path
    }
}

impl AsRef<Path> for TestPath {
    fn as_ref(&self) -> &Path {
        &self.path
    }
}

impl AsRef<OsStr> for TestPath {
    fn as_ref(&self) -> &OsStr {
        self.path.as_os_str()
    }
}

#[cfg(test)]
mod tests {
    use super::{TestDir, TestPath};

    #[test]
    fn removed_on_drop() {
        let dir = TestDir::new("test-dir-drop");
        std::fs::write(dir.join("file"), "x").unwrap();
        std::fs::create_dir_all(dir.join("nested/deeper")).unwrap();
        let path = dir.to_path_buf();
        assert!(path.is_dir());
        drop(dir);
        assert!(!path.exists());
    }

    #[test]
    fn removed_when_the_test_panics() {
        let path = std::sync::Mutex::new(None);
        let outcome = std::panic::catch_unwind(|| {
            let dir = TestDir::new("test-dir-panic");
            *path.lock().unwrap() = Some(dir.to_path_buf());
            panic!("a failing assertion");
        });
        assert!(outcome.is_err());
        let path = path.into_inner().unwrap().unwrap();
        assert!(!path.exists());
    }

    #[test]
    fn a_test_path_takes_its_folder_with_it() {
        let file = TestPath::new("test-dir-file", "store.json");
        std::fs::write(&file, "{}").unwrap();
        let folder = file.parent().unwrap().to_path_buf();
        drop(file);
        assert!(!folder.exists());
    }
}
