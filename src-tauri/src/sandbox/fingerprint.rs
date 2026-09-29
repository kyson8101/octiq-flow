//! What a readiness check was run against (feedback caa2ca88, B1).
//!
//! A check proves the services built from particular sources, a particular
//! recipe and a particular fixture version answered correctly at `checkedAt`.
//! Any of those moving afterwards makes that proof stale, whatever the
//! containers say. So a passing check records all three, and a probe compares
//! them with what is on disk now:
//!
//! - **sources**: every repository the services are built from — the chat's
//!   own folder plus each Compose build context in the FROZEN configuration
//!   (a Performance recipe builds Core, the API, the frontend and SSO from
//!   four repositories). Per repository: `HEAD` and, when it is dirty, a
//!   digest of the uncommitted contents (tracked diff plus untracked files),
//!   so an edit that is never committed still counts.
//! - **recipe**: a digest over every file under the recipe's `.octiq/` and
//!   the bytes of its private env file. The env file's contents never leave
//!   this module; only the digest is kept.
//! - **fixtureVersion**: what the recipe declares its seeded data to be.
//!
//! Every git call is read-only and passes `--no-optional-locks`, so a probe
//! never takes the index lock out from under a worker committing in the
//! same worktree.
use crate::paths::Canonical;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::collections::BTreeMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;

/// Files under a recipe folder a digest will read before giving up; a
/// recipe is a handful of small files, not a source tree.
const RECIPE_FILES: usize = 4_000;
const RECIPE_BYTES: u64 = 64 * 1024 * 1024;

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Fingerprint {
    pub sources: Vec<Source>,
    #[serde(default)]
    pub recipe: Option<String>,
    #[serde(default)]
    pub fixture_version: Option<String>,
}

/// One repository (or plain folder) the services were built from.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Source {
    pub path: String,
    /// `HEAD`, or `None` for a folder that is not a git repository — which
    /// a probe then cannot tell apart from itself, and says so.
    #[serde(default)]
    pub revision: Option<String>,
    #[serde(default)]
    pub dirty: bool,
    /// Digest of the uncommitted contents; only when dirty.
    #[serde(default)]
    pub digest: Option<String>,
}

fn sha(bytes: &[u8]) -> String {
    let digest = Sha256::digest(bytes);
    digest.iter().map(|b| format!("{b:02x}")).collect()
}

fn git(cwd: &Path, args: &[&str]) -> Option<Vec<u8>> {
    let mut cmd = Command::new("git");
    cmd.current_dir(cwd)
        .arg("--no-optional-locks")
        .args(args)
        .stdin(std::process::Stdio::null());
    crate::proc::no_console(&mut cmd);
    let out = cmd.output().ok()?;
    out.status.success().then_some(out.stdout)
}

fn git_text(cwd: &Path, args: &[&str]) -> Option<String> {
    git(cwd, args).map(|out| String::from_utf8_lossy(&out).trim().to_owned())
}

/// The folders the services are built from: the chat's own folder first,
/// then every local build context of the frozen Compose configuration.
/// Remote contexts (a git URL) are not folders and are left out.
pub fn source_dirs(cwd: &Path, compose: &Value) -> Vec<PathBuf> {
    let mut dirs = vec![cwd.to_path_buf()];
    if let Some(services) = compose["services"].as_object() {
        for service in services.values() {
            let context = match &service["build"] {
                Value::String(path) => Some(path.as_str()),
                build => build["context"].as_str(),
            };
            if let Some(context) = context.filter(|c| !c.contains("://") && !c.starts_with("git@"))
            {
                let path = Path::new(context);
                let path = if path.is_absolute() {
                    path.to_path_buf()
                } else {
                    cwd.join(path)
                };
                dirs.push(path);
            }
        }
    }
    dirs
}

/// Each distinct repository under `dirs`, as it is now.
pub fn sources(dirs: &[PathBuf]) -> Vec<Source> {
    let mut seen: BTreeMap<String, Source> = BTreeMap::new();
    for dir in dirs {
        // Git answers "C:/x" on Windows. The canonical spelling ("C:\x") is
        // what the environment's own folder is kept in and matched against.
        let top = git_text(dir, &["rev-parse", "--show-toplevel"])
            .filter(|t| !t.is_empty())
            .map(|t| {
                let top = PathBuf::from(t);
                top.canonical().unwrap_or(top)
            });
        let key = top.as_deref().unwrap_or(dir).to_string_lossy().into_owned();
        if seen.contains_key(&key) {
            continue;
        }
        let source = match &top {
            Some(top) => repository(top, key.clone()),
            None => Source {
                path: key.clone(),
                revision: None,
                dirty: false,
                digest: None,
            },
        };
        seen.insert(key, source);
    }
    seen.into_values().collect()
}

fn repository(top: &Path, path: String) -> Source {
    let revision = git_text(top, &["rev-parse", "HEAD"]).filter(|r| !r.is_empty());
    let status = git(
        top,
        &["status", "--porcelain=v1", "-z", "--untracked-files=all"],
    )
    .unwrap_or_default();
    if status.is_empty() {
        return Source {
            path,
            revision,
            dirty: false,
            digest: None,
        };
    }
    let mut hasher = Sha256::new();
    hasher.update(&status);
    hasher.update(b"\0diff\0");
    hasher.update(git(top, &["diff", "HEAD", "--binary", "--no-ext-diff"]).unwrap_or_default());
    // Untracked files: their contents, not only their names.
    let untracked =
        git(top, &["ls-files", "--others", "--exclude-standard", "-z"]).unwrap_or_default();
    for name in untracked.split(|b| *b == 0).filter(|n| !n.is_empty()) {
        let name = String::from_utf8_lossy(name);
        hasher.update(name.as_bytes());
        hasher.update(b"\0");
        if let Some(object) = git(top, &["hash-object", "--", &name]) {
            hasher.update(&object);
        }
    }
    Source {
        path,
        revision,
        dirty: true,
        digest: Some(
            hasher
                .finalize()
                .iter()
                .map(|b| format!("{b:02x}"))
                .collect(),
        ),
    }
}

/// A digest over the recipe folder (`<root>/.octiq`) and the env file's
/// bytes. Symlinks are named, never followed.
pub fn recipe_digest(octiq: &Path, env_file: Option<&Path>) -> Result<String, String> {
    let mut files = Vec::new();
    let mut stack = vec![octiq.to_path_buf()];
    let mut bytes = 0u64;
    while let Some(dir) = stack.pop() {
        let entries = fs::read_dir(&dir).map_err(|e| format!("Could not read the recipe: {e}"))?;
        for entry in entries {
            let entry = entry.map_err(|e| e.to_string())?;
            let kind = entry.file_type().map_err(|e| e.to_string())?;
            let path = entry.path();
            if kind.is_dir() {
                stack.push(path);
            } else {
                files.push((path, kind.is_symlink()));
            }
            if files.len() > RECIPE_FILES {
                return Err("The sandbox recipe folder is too large to fingerprint.".into());
            }
        }
    }
    files.sort();
    let mut hasher = Sha256::new();
    for (path, link) in files {
        let name = path.strip_prefix(octiq).unwrap_or(&path).to_string_lossy();
        hasher.update(name.as_bytes());
        hasher.update(b"\0");
        if link {
            let target = fs::read_link(&path).map_err(|e| e.to_string())?;
            hasher.update(b"link:");
            hasher.update(target.to_string_lossy().as_bytes());
        } else {
            let content = fs::read(&path).map_err(|e| e.to_string())?;
            bytes += content.len() as u64;
            if bytes > RECIPE_BYTES {
                return Err("The sandbox recipe folder is too large to fingerprint.".into());
            }
            hasher.update(sha(&content).as_bytes());
        }
        hasher.update(b"\n");
    }
    if let Some(file) = env_file {
        hasher.update(b"\0env\0");
        let content = fs::read(file).map_err(|_| "Sandbox envFile is unavailable.")?;
        hasher.update(sha(&content).as_bytes());
    }
    Ok(hasher
        .finalize()
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect())
}

fn short(revision: &Option<String>) -> String {
    revision
        .as_deref()
        .map(|r| r.chars().take(8).collect())
        .unwrap_or_else(|| "none".into())
}

/// Why `recorded` no longer describes `live`, or `None` when it still does.
/// The most specific cause first: a fixture change is also a recipe change.
pub fn difference(recorded: &Fingerprint, live: &Fingerprint) -> Option<String> {
    if recorded.fixture_version != live.fixture_version {
        return Some(format!(
            "Fixture version changed from {} to {} since the last check; a reset reseeds the data.",
            recorded.fixture_version.as_deref().unwrap_or("none"),
            live.fixture_version.as_deref().unwrap_or("none"),
        ));
    }
    if recorded.recipe != live.recipe {
        return Some("The sandbox recipe changed since this environment was built; start it again to rebuild from the new recipe.".into());
    }
    for was in &recorded.sources {
        let Some(now) = live.sources.iter().find(|s| s.path == was.path) else {
            return Some(format!("{} is no longer available.", was.path));
        };
        if was.revision != now.revision {
            return Some(format!(
                "{}: HEAD moved from {} to {} since the last check.",
                was.path,
                short(&was.revision),
                short(&now.revision)
            ));
        }
        if was.dirty != now.dirty || was.digest != now.digest {
            return Some(format!(
                "{}: uncommitted changes differ from what was checked.",
                was.path
            ));
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::paths::Canonical;

    fn repo() -> PathBuf {
        let dir = std::env::temp_dir().join(format!("octiq-fp-{}", uuid::Uuid::new_v4().simple()));
        fs::create_dir_all(&dir).unwrap();
        assert!(git(&dir, &["init", "-q"]).is_some());
        commit(&dir, "first");
        dir.canonical().unwrap()
    }

    fn commit(dir: &Path, message: &str) {
        let hooks = dir.join(".no-hooks");
        let _ = fs::create_dir_all(&hooks);
        let hooks = format!("core.hooksPath={}", hooks.display());
        assert!(git(
            dir,
            &[
                "-c",
                "user.name=Sandbox test",
                "-c",
                "user.email=sandbox@example.invalid",
                "-c",
                "commit.gpgSign=false",
                "-c",
                &hooks,
                "commit",
                "--allow-empty",
                "-qm",
                message
            ]
        )
        .is_some());
    }

    fn now(dir: &Path) -> Fingerprint {
        Fingerprint {
            sources: sources(&[dir.to_path_buf()]),
            recipe: Some("r".into()),
            fixture_version: Some("v1".into()),
        }
    }

    #[test]
    fn a_commit_an_edit_or_a_new_file_each_make_the_record_stale() {
        let dir = repo();
        let checked = now(&dir);
        assert_eq!(difference(&checked, &now(&dir)), None);

        commit(&dir, "second");
        let moved = difference(&checked, &now(&dir)).unwrap();
        assert!(moved.contains("HEAD moved"), "{moved}");

        let checked = now(&dir);
        fs::write(dir.join("new.txt"), "a").unwrap();
        let untracked = difference(&checked, &now(&dir)).unwrap();
        assert!(untracked.contains("uncommitted"), "{untracked}");

        // The same untracked name with different contents is a change too.
        let checked = now(&dir);
        fs::write(dir.join("new.txt"), "b").unwrap();
        assert!(difference(&checked, &now(&dir)).is_some());
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn recipe_and_fixture_changes_name_their_cause() {
        let dir = repo();
        let checked = now(&dir);
        let mut live = checked.clone();
        live.recipe = Some("other".into());
        assert!(difference(&checked, &live)
            .unwrap()
            .contains("recipe changed"));
        live.fixture_version = Some("v2".into());
        let fixture = difference(&checked, &live).unwrap();
        assert!(fixture.contains("v1 to v2"), "{fixture}");
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn build_contexts_in_other_repositories_are_sources_too() {
        let own = repo();
        let api = repo();
        let compose = serde_json::json!({"services":{
            "api":{"build":{"context": api.to_string_lossy()}},
            "web":{"build": own.join("sub").to_string_lossy()},
            "remote":{"build":{"context":"https://example.invalid/repo.git"}},
            "db":{"image":"postgres"}
        }});
        fs::create_dir_all(own.join("sub")).unwrap();
        let found = sources(&source_dirs(&own, &compose));
        let paths: Vec<_> = found.iter().map(|s| s.path.clone()).collect();
        assert_eq!(found.len(), 2, "{paths:?}");
        assert!(paths.contains(&api.to_string_lossy().into_owned()));
        // Spelled as a canonical folder is, which is how a check finds the
        // environment's own source among them.
        assert!(
            paths.contains(&own.to_string_lossy().into_owned()),
            "{paths:?}"
        );
        let checked = Fingerprint {
            sources: found,
            recipe: None,
            fixture_version: None,
        };
        commit(&api, "api moved");
        let live = Fingerprint {
            sources: sources(&source_dirs(&own, &compose)),
            ..checked.clone()
        };
        assert!(difference(&checked, &live)
            .unwrap()
            .starts_with(&api.to_string_lossy().into_owned()));
        fs::remove_dir_all(own).unwrap();
        fs::remove_dir_all(api).unwrap();
    }

    #[test]
    fn the_recipe_digest_covers_every_recipe_file_and_the_env_file() {
        let dir = std::env::temp_dir().join(format!("octiq-rd-{}", uuid::Uuid::new_v4().simple()));
        let octiq = dir.join(".octiq");
        fs::create_dir_all(octiq.join("kit")).unwrap();
        fs::write(octiq.join("sandbox.json"), "{}").unwrap();
        fs::write(octiq.join("kit/verify.mjs"), "one").unwrap();
        let env = dir.join("private.env");
        fs::write(&env, "TOKEN=a").unwrap();
        let first = recipe_digest(&octiq, Some(&env)).unwrap();
        assert_eq!(first, recipe_digest(&octiq, Some(&env)).unwrap());
        fs::write(octiq.join("kit/verify.mjs"), "two").unwrap();
        let second = recipe_digest(&octiq, Some(&env)).unwrap();
        assert_ne!(first, second);
        fs::write(&env, "TOKEN=b").unwrap();
        assert_ne!(second, recipe_digest(&octiq, Some(&env)).unwrap());
        fs::remove_dir_all(dir).unwrap();
    }
}
