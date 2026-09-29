// Filesystem boundaries for the commands a browser can reach (card 25).
//
// Anything that reaches `dispatch.rs` runs with this process's own filesystem
// rights, so a content injection into the client would arrive holding them.
// This module exists so the most powerful of those commands — the ones that
// WRITE — cannot be pointed at arbitrary paths.
//
// The threat model is a single-user backend on the user's own machine: these
// are hardening measures, not fixes for a known exploit.
//
// What is confined, and what deliberately is not:
//
//   * WRITES are confined. `fsbrowse::write_file` is the only command that
//     overwrites a caller-supplied path, and it now must resolve inside an
//     allowed root.
//   * READS stay broad. `list_dir` and `read_file_preview` back a general file
//     browser: the user expects to open any folder they can read, including one
//     outside every project. Confining them would break the feature to protect
//     data the same webview could ask a PTY to `cat` anyway. This is the
//     trade-off the card names, taken deliberately.
//
// The allowed roots are `$HOME`, every configured workspace folder, and the
// active profile's data dir (canvas + vault write there). A workspace folder
// outside `$HOME` — a mounted volume, say — is allowed because the user pointed
// a project at it.
use std::path::{Component, Path, PathBuf};

/// The user's home dir, from `HOME` (Unix) or `USERPROFILE` (Windows).
///
/// An empty value is treated as unset: an exported-but-blank `HOME` would
/// otherwise resolve to the relative path `""`, which joins into nonsense and
/// canonicalizes to the process's current directory.
pub fn home_dir() -> Option<PathBuf> {
    for var in ["HOME", "USERPROFILE"] {
        if let Ok(value) = std::env::var(var) {
            if !value.is_empty() {
                return Some(PathBuf::from(value));
            }
        }
    }
    None
}

/// Whether `candidate` is `root` itself or lies underneath it.
///
/// Both paths must ALREADY be canonical (symlinks resolved, no `..`). Comparing
/// components rather than string prefixes is what stops `/home/user-evil` from
/// matching the root `/home/user`.
fn is_under(candidate: &Path, root: &Path) -> bool {
    candidate == root || candidate.starts_with(root)
}

/// Whether a canonical `candidate` lies within any of the canonical `roots`.
/// No roots means nothing is allowed — a closed door, never an open one.
pub fn is_within(candidate: &Path, roots: &[PathBuf]) -> bool {
    roots.iter().any(|root| is_under(candidate, root))
}

/// `std::fs::canonicalize`, minus the verbatim prefix Windows puts on it.
///
/// On Windows the std call answers `\\?\C:\Works\x` for `C:\Works\x`. Win32
/// accepts that, but git, Node and most command-line tools do not, and it leaked
/// into every path this backend stored, showed or handed to a child process —
/// git refused to create task worktrees at all. Every canonical path in this
/// crate goes through here, so two of them always compare in the same form.
pub fn canonicalize(path: impl AsRef<Path>) -> std::io::Result<PathBuf> {
    std::fs::canonicalize(path).map(|p| simplified(&p))
}

/// The platform's unmodified canonical spelling.
///
/// Windows builds before `canonicalize` simplified verbatim paths used this
/// spelling in durable receipt IDs. Keep it available only for compatibility
/// lookups; filesystem comparisons and newly stored paths use `canonicalize`.
pub(crate) fn canonicalize_raw(path: impl AsRef<Path>) -> std::io::Result<PathBuf> {
    std::fs::canonicalize(path)
}

/// `.canonical()` on a path: `canonicalize` in method form, so a chain like
/// `Path::new(root).canonical()?` reads the way the std call did.
pub trait Canonical {
    fn canonical(&self) -> std::io::Result<PathBuf>;
}

impl Canonical for Path {
    fn canonical(&self) -> std::io::Result<PathBuf> {
        canonicalize(self)
    }
}

/// `path` without a removable verbatim prefix; unchanged anywhere but Windows.
///
/// Also what normalizes a path this backend STORED before the prefix was
/// dropped, so a record from an older build still compares equal.
pub fn simplified(path: &Path) -> PathBuf {
    if cfg!(windows) {
        if let Some(plain) = path.to_str().and_then(plain_windows_path) {
            return PathBuf::from(plain);
        }
    }
    path.to_path_buf()
}

/// `simplified` for a path kept as a string.
pub fn simplified_str(path: &str) -> String {
    simplified(Path::new(path)).to_string_lossy().into_owned()
}

/// Serde `deserialize_with` for a stored path: a record written while
/// `canonicalize` still answered `\\?\C:\...` reads back in today's form, so it
/// compares equal to a path resolved now instead of looking "moved".
pub fn de_simplified<'de, D: serde::Deserializer<'de>>(d: D) -> Result<String, D::Error> {
    <String as serde::Deserialize>::deserialize(d).map(|p| simplified_str(&p))
}

/// `de_simplified` for a `PathBuf` field.
pub fn de_simplified_buf<'de, D: serde::Deserializer<'de>>(d: D) -> Result<PathBuf, D::Error> {
    <PathBuf as serde::Deserialize>::deserialize(d).map(|p| simplified(&p))
}

/// `de_simplified` for a list of paths.
pub fn de_simplified_vec<'de, D: serde::Deserializer<'de>>(d: D) -> Result<Vec<String>, D::Error> {
    <Vec<String> as serde::Deserialize>::deserialize(d)
        .map(|v| v.iter().map(|p| simplified_str(p)).collect())
}

/// The ordinary spelling of a Windows verbatim path, when one means the same.
///
/// `\\?\C:\x` becomes `C:\x` and `\\?\UNC\server\share\x` becomes
/// `\\server\share\x`. A verbatim path skips Win32's name parsing, so it can
/// name things the plain form cannot: past `MAX_PATH`, a component ending in a
/// dot or space, a device name like `NUL`. Those keep the prefix (`None`).
///
/// A `/` is turned into `\`. Inside a verbatim path it is a literal character,
/// which no Windows file name may hold, so such a path never named anything:
/// it is one this backend built by joining `feature/octiq-x` onto a canonical
/// root, and the separator is what was meant.
/// Pure string logic, so it is tested on every platform.
pub fn plain_windows_path(path: &str) -> Option<String> {
    let rest = path.strip_prefix(r"\\?\")?.replace('/', r"\");
    let (plain, tail) = if let Some(unc) = rest.strip_prefix(r"UNC\") {
        (format!(r"\\{unc}"), unc)
    } else {
        let bytes = rest.as_bytes();
        let is_drive = bytes.len() >= 3
            && bytes[0].is_ascii_alphabetic()
            && bytes[1] == b':'
            && bytes[2] == b'\\';
        if !is_drive {
            return None;
        }
        (rest.clone(), &rest[3..])
    };
    const MAX_PATH: usize = 260;
    if plain.len() >= MAX_PATH {
        return None;
    }
    let plain_names = tail.split('\\').filter(|c| !c.is_empty()).all(|name| {
        let stem = name.split('.').next().unwrap_or("").to_ascii_uppercase();
        let port = stem
            .strip_prefix("COM")
            .or_else(|| stem.strip_prefix("LPT"));
        let reserved = matches!(stem.as_str(), "CON" | "PRN" | "AUX" | "NUL")
            || matches!(
                port,
                Some("1" | "2" | "3" | "4" | "5" | "6" | "7" | "8" | "9" | "¹" | "²" | "³")
            );
        name != "." && name != ".." && !name.ends_with(['.', ' ']) && !reserved
    });
    plain_names.then_some(plain)
}

/// Resolve `path` to a canonical location, following symlinks.
///
/// A path that does not exist yet (saving a file the browser just named) has no
/// canonical form, so its deepest existing ancestor is canonicalized and the
/// remaining names are re-attached. Those trailing names are checked to be plain
/// file/dir names: a `..` among them would climb back out of the resolved root
/// and defeat the whole check.
///
/// Returns `None` when the path is empty, when no ancestor exists, or when the
/// unresolved tail contains anything other than normal names.
pub fn canonical_target(path: &Path) -> Option<PathBuf> {
    // Windows normalizes `missing\..` before opening a path, even if the
    // target exists. Check the directory being traversed before the OS can
    // erase an unresolved parent segment. Existing-directory traversal stays
    // valid and is still canonicalized (including symlinks) below.
    let mut checked_path = None;
    if path.components().any(|part| part == Component::ParentDir) {
        let mut prefix = PathBuf::new();
        for part in path.components() {
            if part == Component::ParentDir {
                let parent = if prefix.as_os_str().is_empty() {
                    Path::new(".")
                } else {
                    prefix.as_path()
                };
                if !parent.is_dir() {
                    return None;
                }
            }
            prefix.push(part);
        }
        // PathBuf normalizes parents in Windows verbatim paths. Only use that
        // normalized form after checking every directory it traversed above.
        checked_path = Some(prefix);
    }
    let path = checked_path.as_deref().unwrap_or(path);
    // The common case: it exists, so the OS resolves every symlink for us.
    if let Ok(resolved) = path.canonical() {
        return Some(resolved);
    }

    // Walk up to the deepest ancestor that exists, remembering the tail.
    let mut tail: Vec<&std::ffi::OsStr> = Vec::new();
    let mut cursor = path;
    loop {
        match cursor.canonical() {
            Ok(resolved) => {
                let mut out = resolved;
                // Re-attach in the order they appeared.
                for name in tail.iter().rev() {
                    out.push(name);
                }
                return Some(out);
            }
            Err(_) => {
                // Only a plain name may be re-attached. `..` would escape the
                // root we are about to validate against; `.` is meaningless
                // here; a root/prefix component means we ran out of ancestors.
                let name = match cursor.components().next_back()? {
                    Component::Normal(name) => name,
                    _ => return None,
                };
                tail.push(name);
                cursor = cursor.parent()?;
                if cursor.as_os_str().is_empty() {
                    return None; // a bare relative name: no ancestor to anchor it
                }
            }
        }
    }
}

/// The roots a webview-supplied path is allowed to be WRITTEN inside: `$HOME`,
/// every configured workspace folder, and the active profile's data dir.
///
/// Each is canonicalized; any that cannot be resolved (a stale project folder on
/// an unmounted volume) is dropped rather than compared un-resolved, which would
/// let a symlink under it slip a write outside.
pub fn write_roots(workspace_paths: impl IntoIterator<Item = String>) -> Vec<PathBuf> {
    let mut roots: Vec<PathBuf> = Vec::new();
    let mut push = |p: PathBuf| {
        if let Ok(canon) = p.canonical() {
            if !roots.contains(&canon) {
                roots.push(canon);
            }
        }
    };
    if let Some(home) = home_dir() {
        push(home);
    }
    push(crate::profile::profile_dir());
    for path in workspace_paths {
        if !path.trim().is_empty() {
            push(PathBuf::from(path));
        }
    }
    roots
}

/// Resolve `path` and confirm it is inside `roots`, or explain why not.
///
/// Canonicalization happens BEFORE any `is_dir` / open / write, so a symlink
/// pointing out of an allowed root is rejected on the resolved target, not on
/// the name the caller handed us.
pub fn resolve_writable(path: &Path, roots: &[PathBuf]) -> Result<PathBuf, String> {
    let target =
        canonical_target(path).ok_or_else(|| format!("Cannot resolve path: {}", path.display()))?;
    if !is_within(&target, roots) {
        return Err(format!(
            "Refusing to write outside your projects and home folder: {}",
            path.display()
        ));
    }
    Ok(target)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tmp(name: &str) -> PathBuf {
        let dir =
            std::env::temp_dir().join(format!("octiq-paths-test-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        // The temp dir itself may be a symlink (/tmp -> /private/tmp on macOS),
        // so hand back the canonical form — the same thing write_roots stores.
        canonicalize(&dir).unwrap()
    }

    // ---- is_within ---------------------------------------------------------

    #[test]
    fn a_path_inside_a_root_is_allowed() {
        let root = PathBuf::from("/home/user");
        assert!(is_within(Path::new("/home/user"), &[root.clone()]));
        assert!(is_within(Path::new("/home/user/a/b.txt"), &[root]));
    }

    #[test]
    fn a_sibling_with_the_same_prefix_is_not_inside() {
        // The bug a naive `starts_with` on STRINGS would have.
        let root = PathBuf::from("/home/user");
        assert!(!is_within(Path::new("/home/user-evil/x"), &[root.clone()]));
        assert!(!is_within(Path::new("/home/username"), &[root]));
    }

    #[test]
    fn no_roots_allows_nothing() {
        assert!(!is_within(Path::new("/anything"), &[]));
    }

    #[test]
    fn any_matching_root_allows_it() {
        let roots = vec![PathBuf::from("/a"), PathBuf::from("/b")];
        assert!(is_within(Path::new("/b/deep/file"), &roots));
        assert!(!is_within(Path::new("/c/file"), &roots));
    }

    // ---- canonical_target --------------------------------------------------

    #[test]
    fn an_existing_file_resolves_to_itself() {
        let dir = tmp("existing");
        let file = dir.join("f.txt");
        std::fs::write(&file, "x").unwrap();
        assert_eq!(canonical_target(&file), Some(file.clone()));
    }

    #[test]
    fn a_new_file_resolves_against_its_existing_parent() {
        let dir = tmp("new-file");
        let target = dir.join("not-created-yet.txt");
        assert_eq!(canonical_target(&target), Some(target));
    }

    #[test]
    fn a_new_file_several_levels_deep_reattaches_every_name() {
        let dir = tmp("deep-new");
        let target = dir.join("a").join("b").join("c.txt");
        assert_eq!(canonical_target(&target), Some(target));
    }

    #[test]
    fn traversal_is_resolved_away_not_preserved() {
        let dir = tmp("traversal");
        std::fs::create_dir_all(dir.join("sub")).unwrap();
        let sneaky = dir.join("sub").join("..").join("..");
        // `..` collapses, so the result is the parent of `dir`, NOT inside it.
        let resolved = canonical_target(&sneaky).unwrap();
        assert!(!is_within(&resolved, &[dir.clone()]));
        assert_eq!(resolved, dir.parent().unwrap().canonical().unwrap());
    }

    #[test]
    fn a_dotdot_in_the_unresolved_tail_is_refused() {
        // The dangerous shape: `<real dir>/nope/../../../etc/passwd`. Nothing
        // below `nope` exists, so the tail is re-attached by hand — and a `..`
        // there would climb straight back out of the root we just validated.
        let dir = tmp("tail-dotdot");
        // PathBuf::push normalizes `..` for Windows verbatim paths (the form
        // canonicalize returns). Preserve the actual caller-supplied input.
        let mut raw = dir.as_os_str().to_os_string();
        raw.push(format!(
            "{sep}nope{sep}..{sep}escaped.txt",
            sep = std::path::MAIN_SEPARATOR
        ));
        let sneaky = PathBuf::from(raw);
        assert_eq!(canonical_target(&sneaky), None);
    }

    #[test]
    fn an_unresolved_parent_segment_cannot_be_hidden_by_an_existing_target() {
        let dir = tmp("tail-dotdot-existing");
        std::fs::write(dir.join("existing.txt"), "keep").unwrap();
        let mut raw = dir.as_os_str().to_os_string();
        raw.push(format!(
            "{sep}missing{sep}..{sep}existing.txt",
            sep = std::path::MAIN_SEPARATOR
        ));
        assert_eq!(canonical_target(Path::new(&raw)), None);
    }

    #[test]
    fn an_existing_directory_can_be_traversed_before_a_new_file() {
        let dir = tmp("existing-parent-new-file");
        std::fs::create_dir(dir.join("sub")).unwrap();
        let mut raw = dir.as_os_str().to_os_string();
        raw.push(format!(
            "{sep}sub{sep}..{sep}new.txt",
            sep = std::path::MAIN_SEPARATOR
        ));
        assert_eq!(canonical_target(Path::new(&raw)), Some(dir.join("new.txt")));
    }

    #[cfg(windows)]
    #[test]
    fn ordinary_windows_paths_cannot_normalize_away_a_missing_directory() {
        let dir = tmp("ordinary-tail-dotdot");
        std::fs::write(dir.join("existing.txt"), "keep").unwrap();
        let ordinary = dir
            .to_string_lossy()
            .trim_start_matches(r"\\?\")
            .to_string();
        for name in ["existing.txt", "new.txt"] {
            let sneaky = PathBuf::from(format!(r"{ordinary}\missing\..\{name}"));
            assert_eq!(canonical_target(&sneaky), None, "{}", sneaky.display());
        }
    }

    #[test]
    fn a_bare_relative_name_has_no_anchor() {
        assert_eq!(canonical_target(Path::new("relative.txt")), None);
        assert_eq!(canonical_target(Path::new("")), None);
    }

    // ---- resolve_writable: the security boundary ---------------------------

    #[test]
    fn a_write_inside_a_root_is_accepted() {
        let dir = tmp("write-ok");
        let roots = vec![dir.clone()];
        assert!(resolve_writable(&dir.join("new.txt"), &roots).is_ok());
        assert!(resolve_writable(&dir.join("sub/deep.txt"), &roots).is_ok());
    }

    #[test]
    fn a_write_outside_every_root_is_refused() {
        let dir = tmp("write-outside");
        let other = tmp("write-outside-other");
        let err = resolve_writable(&other.join("f.txt"), &[dir]).unwrap_err();
        assert!(err.contains("Refusing to write outside"), "{err}");
    }

    #[test]
    fn a_traversal_out_of_a_root_is_refused() {
        let dir = tmp("write-traversal");
        std::fs::create_dir_all(dir.join("sub")).unwrap();
        let escape = dir.join("sub").join("..").join("..").join("stolen.txt");
        assert!(resolve_writable(&escape, &[dir]).is_err());
    }

    #[cfg(unix)]
    #[test]
    fn a_symlink_pointing_out_of_a_root_is_refused() {
        // The reason canonicalization must happen BEFORE the write: the NAME is
        // inside the root, the TARGET is not.
        let root = tmp("symlink-root");
        let outside = tmp("symlink-outside");
        let secret = outside.join("secret.txt");
        std::fs::write(&secret, "old").unwrap();

        let link = root.join("innocent.txt");
        std::os::unix::fs::symlink(&secret, &link).unwrap();

        let err = resolve_writable(&link, &[root]).unwrap_err();
        assert!(err.contains("Refusing to write outside"), "{err}");
        // And the file it pointed at is untouched.
        assert_eq!(std::fs::read_to_string(&secret).unwrap(), "old");
    }

    #[cfg(unix)]
    #[test]
    fn a_symlinked_directory_pointing_out_of_a_root_is_refused() {
        // Same hop, one level up: the DIRECTORY is a symlink out of the root.
        let root = tmp("symdir-root");
        let outside = tmp("symdir-outside");
        std::os::unix::fs::symlink(&outside, root.join("escape")).unwrap();

        let target = root.join("escape").join("new.txt");
        assert!(resolve_writable(&target, &[root]).is_err());
    }

    #[cfg(unix)]
    #[test]
    fn a_symlink_staying_inside_a_root_is_allowed() {
        // Confinement, not symlink-phobia: a link that resolves back inside the
        // root is a legitimate thing to write through.
        let root = tmp("symlink-inner");
        let real = root.join("real.txt");
        std::fs::write(&real, "x").unwrap();
        let link = root.join("alias.txt");
        std::os::unix::fs::symlink(&real, &link).unwrap();

        assert_eq!(resolve_writable(&link, &[root]).unwrap(), real);
    }

    // ---- home_dir ----------------------------------------------------------

    #[test]
    fn home_dir_reads_the_environment() {
        // HOME is set in every environment these tests run in.
        assert!(home_dir().is_some());
    }

    // ---- plain_windows_path ------------------------------------------------

    #[test]
    fn a_verbatim_drive_path_loses_its_prefix() {
        assert_eq!(
            plain_windows_path(r"\\?\C:\Works\Obsidian\Pandaworks-docspace").as_deref(),
            Some(r"C:\Works\Obsidian\Pandaworks-docspace")
        );
        assert_eq!(plain_windows_path(r"\\?\D:\").as_deref(), Some(r"D:\"));
    }

    #[test]
    fn a_stored_worktree_path_with_a_slashed_branch_reads_back_whole() {
        // What `plan` stored before the prefix was dropped: the branch
        // `feature/octiq-x` joined onto a canonical root in one piece.
        assert_eq!(
            plain_windows_path(r"\\?\C:\Works\.worktrees\app\feature/octiq-x").as_deref(),
            Some(r"C:\Works\.worktrees\app\feature\octiq-x")
        );
    }

    #[test]
    fn a_verbatim_unc_path_becomes_an_ordinary_share_path() {
        assert_eq!(
            plain_windows_path(r"\\?\UNC\server\share\repo").as_deref(),
            Some(r"\\server\share\repo")
        );
    }

    #[test]
    fn a_path_without_the_prefix_is_left_to_the_caller() {
        assert_eq!(plain_windows_path(r"C:\Works"), None);
        assert_eq!(plain_windows_path("/home/user"), None);
        // A volume GUID path has no ordinary spelling.
        assert_eq!(plain_windows_path(r"\\?\Volume{1234}\x"), None);
    }

    #[test]
    fn names_only_a_verbatim_path_can_hold_keep_the_prefix() {
        let long = format!(r"\\?\C:\{}", "a".repeat(300));
        assert_eq!(plain_windows_path(&long), None);
        assert_eq!(plain_windows_path(r"\\?\C:\dir\trailing."), None);
        assert_eq!(plain_windows_path(r"\\?\C:\dir\trailing "), None);
        assert_eq!(plain_windows_path(r"\\?\C:\dir\NUL"), None);
        assert_eq!(plain_windows_path(r"\\?\C:\dir\com1.txt"), None);
        assert_eq!(plain_windows_path(r"\\?\C:\dir\..\x"), None);
        // Close to a device name is still an ordinary name.
        assert!(plain_windows_path(r"\\?\C:\dir\CONSOLE").is_some());
        assert!(plain_windows_path(r"\\?\C:\dir\COM").is_some());
    }

    #[test]
    fn documented_superscript_port_names_keep_the_verbatim_prefix() {
        for name in [
            "COM¹",
            "com².txt",
            "CoM³.tar.gz",
            "LPT¹",
            "lpt².log",
            "LpT³.more.txt",
        ] {
            let path = format!(r"\\?\C:\dir\{name}");
            assert_eq!(plain_windows_path(&path), None, "{path}");
        }
    }

    #[test]
    fn names_outside_microsofts_reserved_file_list_are_simplified() {
        for name in [
            "COM0",
            "com0.txt",
            "LPT0",
            "lpt0.log",
            "COM10",
            "com10.txt",
            "COMX",
            "comx.log",
            "COM¹x",
            "com¹x.txt",
            "CONIN$",
            "conin$.txt",
            "CONOUT$",
            "conout$.log",
        ] {
            let path = format!(r"\\?\C:\dir\{name}");
            assert_eq!(
                plain_windows_path(&path).as_deref(),
                Some(path.trim_start_matches(r"\\?\")),
                "{path}"
            );
        }
    }

    #[test]
    fn canonicalize_never_answers_a_verbatim_path() {
        let dir = tmp("verbatim");
        assert!(!dir.to_string_lossy().starts_with(r"\\?\"));
        assert_eq!(simplified(&dir), dir);
    }

    #[test]
    fn no_module_calls_the_std_canonicalize_directly() {
        // The std call answers `\\?\C:\...` on Windows; everything must go
        // through `paths::canonicalize` / `.canonical()` instead.
        let src = Path::new(env!("CARGO_MANIFEST_DIR")).join("src");
        let mut stack = vec![src];
        let mut offenders = Vec::new();
        while let Some(dir) = stack.pop() {
            for entry in std::fs::read_dir(&dir).unwrap() {
                let path = entry.unwrap().path();
                if path.is_dir() {
                    stack.push(path);
                } else if path.extension().is_some_and(|e| e == "rs") && !path.ends_with("paths.rs")
                {
                    let text = std::fs::read_to_string(&path).unwrap();
                    if text.contains(concat!(".canon", "icalize()"))
                        || text.contains(concat!("fs::canon", "icalize("))
                    {
                        offenders.push(path.display().to_string());
                    }
                }
            }
        }
        assert!(
            offenders.is_empty(),
            "use paths::canonicalize in {offenders:?}"
        );
    }
}
