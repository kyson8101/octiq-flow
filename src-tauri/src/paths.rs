// Filesystem boundaries for the commands the webview can reach (card 25).
//
// CSP is currently disabled (`csp: null` in tauri.conf.json), so a content
// injection into the webview would run with the full IPC surface. This module
// exists so the most powerful of those commands — the ones that WRITE — cannot
// be pointed at arbitrary paths.
//
// The threat model is a local, single-user desktop app: these are hardening
// measures, not fixes for a known exploit.
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
    // The common case: it exists, so the OS resolves every symlink for us.
    if let Ok(resolved) = path.canonicalize() {
        return Some(resolved);
    }

    // Walk up to the deepest ancestor that exists, remembering the tail.
    let mut tail: Vec<&std::ffi::OsStr> = Vec::new();
    let mut cursor = path;
    loop {
        match cursor.canonicalize() {
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
        if let Ok(canon) = p.canonicalize() {
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
        let dir = std::env::temp_dir().join(format!("octiq-paths-test-{name}"));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        // The temp dir itself may be a symlink (/tmp -> /private/tmp on macOS),
        // so hand back the canonical form — the same thing write_roots stores.
        dir.canonicalize().unwrap()
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
        assert_eq!(resolved, dir.parent().unwrap().canonicalize().unwrap());
    }

    #[test]
    fn a_dotdot_in_the_unresolved_tail_is_refused() {
        // The dangerous shape: `<real dir>/nope/../../../etc/passwd`. Nothing
        // below `nope` exists, so the tail is re-attached by hand — and a `..`
        // there would climb straight back out of the root we just validated.
        let dir = tmp("tail-dotdot");
        let sneaky = dir.join("nope").join("..").join("escaped.txt");
        assert_eq!(canonical_target(&sneaky), None);
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
}
