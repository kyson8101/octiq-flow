//! Local project test services. This is not an agent permission sandbox.
//! A persisted Compose project owns each chat's volumes across process restarts.
use base64::Engine;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::{BTreeMap, BTreeSet};
use std::fs::{self, OpenOptions};
use std::io::Read;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

pub mod capacity;
pub mod fingerprint;
pub mod health;

static STORE_LOCK: Mutex<()> = Mutex::new(());
static OPERATIONS: Mutex<BTreeSet<String>> = Mutex::new(BTreeSet::new());
static INSTANCE: OnceLock<String> = OnceLock::new();

fn instance() -> &'static str {
    INSTANCE.get_or_init(|| uuid::Uuid::new_v4().to_string())
}
pub(crate) fn now() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Snapshot {
    #[serde(default)]
    pub default_enabled: bool,
    #[serde(default)]
    pub environments: BTreeMap<String, Environment>,
    /// Host-wide slots, as a read sees them. Never stored.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub capacity: Option<CapacityView>,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CapacityView {
    pub limit: usize,
    /// Chat keys of environments started and not stopped, or held by a start.
    pub live: Vec<String>,
    pub waiting: Vec<CapacityWaiter>,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CapacityWaiter {
    pub label: String,
    pub keys: Vec<String>,
    pub since: u64,
}

/// Why an environment that passed its check is no longer ready, found by a
/// probe rather than a new check: `stale` (its sources, recipe or fixture
/// moved) or `unhealthy` (its services did).
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Invalidation {
    pub kind: String,
    pub reason: String,
    pub at: u64,
}

/// Someone asked for these services to keep running although no task needs
/// them: the person started or checked a settled worker's environment to
/// look at it. Stopping it releases the hold.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Lease {
    pub by: String,
    pub at: u64,
}

/// Why and by whom the services were last stopped. Volumes are kept.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Stopped {
    pub by: String,
    pub reason: String,
    pub at: u64,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Environment {
    pub id: String,
    pub chat_key: String,
    pub enabled: bool,
    pub locked: bool,
    pub cwd: PathBuf,
    pub state: String,
    pub checked_at: Option<u64>,
    pub error: Option<String>,
    pub urls: BTreeMap<String, String>,
    pub source_revision: Option<String>,
    pub source_dirty: Option<bool>,
    pub fixture_version: Option<String>,
    pub host_instance: String,
    pub docker_endpoint: Option<String>,
    /// What the last passing check covered. See `fingerprint`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub fingerprint: Option<fingerprint::Fingerprint>,
    /// The recipe digest the frozen Compose configuration was made from.
    /// `None` on an environment frozen before digests were kept.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub frozen_recipe: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub invalidated: Option<Invalidation>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub lease: Option<Lease>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub stopped: Option<Stopped>,
    /// When a health probe last looked, as a read sees it. Never stored.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub probed_at: Option<u64>,
}

/// States in which an environment's services have been started and not
/// stopped since, whatever their readiness.
fn running_state(state: &str) -> bool {
    !matches!(state, "stopped")
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Recipe {
    version: u32,
    compose_file: String,
    check_service: String,
    #[serde(default)]
    env_file: Option<String>,
    #[serde(default)]
    fixture_version: Option<String>,
    #[serde(default)]
    endpoints: BTreeMap<String, Endpoint>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Endpoint {
    service: String,
    port: u16,
    #[serde(default)]
    path: String,
}

pub struct Store {
    root: PathBuf,
}

impl Store {
    pub fn profile() -> Self {
        Self {
            root: crate::profile::profile_dir().join("sandboxes"),
        }
    }

    /// A store kept under `root`, for other modules' tests.
    #[cfg(test)]
    pub(crate) fn at(root: PathBuf) -> Self {
        Self { root }
    }

    fn read(&self) -> Result<Snapshot, String> {
        match fs::read(self.root.join("state.json")) {
            Ok(bytes) => serde_json::from_slice(&bytes)
                .map_err(|_| "Sandbox state is unreadable; it has not been overwritten.".into()),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(Snapshot::default()),
            Err(e) => Err(format!("Could not read sandbox state: {e}")),
        }
    }

    fn mutate<T>(&self, f: impl FnOnce(&mut Snapshot) -> Result<T, String>) -> Result<T, String> {
        let _lock = STORE_LOCK.lock().map_err(|e| e.to_string())?;
        let mut data = self.read()?;
        let result = f(&mut data)?;
        private_write(
            &self.root.join("state.json"),
            &serde_json::to_vec_pretty(&data).map_err(|e| e.to_string())?,
        )?;
        crate::bus::emit("sandbox-changed", json!({}));
        capacity::changed();
        Ok(result)
    }

    pub fn snapshot(&self) -> Result<Snapshot, String> {
        let _lock = STORE_LOCK.lock().map_err(|e| e.to_string())?;
        let mut data = self.read()?;
        for env in data.environments.values_mut() {
            if env.host_instance != instance()
                && matches!(
                    env.state.as_str(),
                    "ready" | "preparing" | "stale" | "unhealthy"
                )
            {
                env.state = "unverified".into();
                env.checked_at = None;
            }
        }
        Ok(data)
    }

    pub fn configure(&self, enabled: bool) -> Result<Snapshot, String> {
        self.mutate(|data| {
            data.default_enabled = enabled;
            Ok(data.clone())
        })
    }

    /// Once launched, old clients and Settings changes cannot change a chat's mode.
    pub fn select(
        &self,
        key: &str,
        cwd: &str,
        requested: Option<bool>,
        resumed: bool,
    ) -> Result<(), String> {
        valid_key(key)?;
        let _operation = self.operation(key)?;
        let cwd = Path::new(cwd)
            .canonicalize()
            .map_err(|e| format!("Chat folder is unavailable: {e}"))?;
        self.mutate(|data| {
            if let Some(existing) = data.environments.get_mut(key) {
                if existing.enabled && existing.cwd != cwd { return Err("This chat's sandbox belongs to a different folder. Start a new chat for the new folder.".into()); }
                if !existing.locked {
                    if let Some(enabled) = requested { existing.enabled = enabled; }
                    existing.cwd = cwd;
                }
                return Ok(());
            }
            let enabled = requested.unwrap_or(!resumed && data.default_enabled);
            data.environments.insert(key.into(), Environment {
                id: format!("octiq-sb-{}", uuid::Uuid::new_v4().simple()), chat_key: key.into(), enabled,
                locked: true, cwd, state: "unverified".into(), checked_at: None, error: None,
                urls: BTreeMap::new(), source_revision: None, source_dirty: None, fixture_version: None,
                host_instance: instance().into(), docker_endpoint: None, fingerprint: None,
                frozen_recipe: None, invalidated: None, lease: None, stopped: None, probed_at: None,
            });
            Ok(())
        })
    }

    fn operation(&self, key: &str) -> Result<Operation, String> {
        let token = format!("{}:{key}", self.root.display());
        if !OPERATIONS
            .lock()
            .map_err(|e| e.to_string())?
            .insert(token.clone())
        {
            return Err(
                "This sandbox is already being prepared or changed. Wait for it to finish.".into(),
            );
        }
        Ok(Operation(token))
    }

    fn save(&self, env: &Environment) -> Result<(), String> {
        self.mutate(|data| {
            let mut env = env.clone();
            env.probed_at = None;
            data.environments.insert(env.chat_key.clone(), env);
            Ok(())
        })
    }

    fn directory(&self, env: &Environment) -> Result<PathBuf, String> {
        if !env.id.starts_with("octiq-sb-")
            || !env
                .id
                .chars()
                .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-')
        {
            return Err("Invalid sandbox ownership record.".into());
        }
        Ok(self.root.join(&env.id))
    }

    fn prepare(&self, key: &str, cwd: &str) -> Result<Option<StartGuard>, String> {
        let Some(mut env) = self
            .snapshot()?
            .environments
            .get(key)
            .filter(|e| e.enabled)
            .cloned()
        else {
            return Ok(None);
        };
        let operation = self.operation(key)?;
        if Path::new(cwd).canonicalize().ok().as_ref() != Some(&env.cwd) {
            return Err("Sandbox folder changed. Start a new chat for that folder.".into());
        }
        // An orchestrated worker's environment was built and checked just
        // before its chat starts (orchestration `start_after_environment`);
        // checking it again a moment later would only double the wait.
        if !just_checked(&env, now()) {
            self.execute(&mut env, "start", None)?;
        }
        env.locked = true;
        self.save(&env)?;
        let handoff = self.directory(&env)?.join("handoff.json");
        Ok(Some(StartGuard {
            _operation: operation,
            id: env.id,
            handoff,
        }))
    }

    #[cfg(test)]
    pub fn action(
        &self,
        key: &str,
        action: &str,
        confirmation: Option<&str>,
    ) -> Result<Environment, String> {
        self.action_when_idle(key, action, confirmation, || Ok(()))
    }

    #[cfg(test)]
    fn action_when_idle(
        &self,
        key: &str,
        action: &str,
        confirmation: Option<&str>,
        idle: impl FnOnce() -> Result<(), String>,
    ) -> Result<Environment, String> {
        let _operation = self.operation(key)?;
        idle()?;
        let mut env = self
            .snapshot()?
            .environments
            .get(key)
            .filter(|e| e.enabled)
            .cloned()
            .ok_or("This chat has no sandbox.")?;
        self.execute(&mut env, action, confirmation)?;
        Ok(env)
    }

    fn execute(
        &self,
        env: &mut Environment,
        action: &str,
        confirmation: Option<&str>,
    ) -> Result<(), String> {
        if !matches!(action, "start" | "check" | "stop" | "reset") {
            return Err("Unknown sandbox action.".into());
        }
        if action == "reset" && confirmation != Some(env.id.as_str()) {
            return Err("Confirm this sandbox's ID before resetting its database.".into());
        }
        env.state = if matches!(action, "start" | "reset") {
            "preparing"
        } else {
            "unverified"
        }
        .into();
        env.error = None;
        env.checked_at = None;
        env.invalidated = None;
        if action != "stop" {
            env.stopped = None;
        }
        env.host_instance = instance().into();
        self.save(env)?;
        let result = self.execute_inner(env, action);
        if let Err(error) = &result {
            env.state = "error".into();
            env.error = Some(error.clone());
            env.checked_at = None;
        }
        self.save(env)?;
        result
    }

    fn execute_inner(&self, env: &mut Environment, action: &str) -> Result<(), String> {
        let dir = self.directory(env)?;
        private_dir(&dir)?;
        runtime_secrets(&dir)?;
        let docker = crate::proc::find_executable("docker").ok_or(
            "Docker was not found. Install and start a local Docker runtime on the OctiqFlow host.",
        )?;
        let endpoint = docker_endpoint(&docker, &dir)?;
        if env
            .docker_endpoint
            .as_ref()
            .is_some_and(|saved| saved != &endpoint)
        {
            return Err("The Docker endpoint changed. Select this sandbox's original local Docker context before continuing.".into());
        }
        env.docker_endpoint = Some(endpoint.clone());
        self.save(env)?;
        let compose = dir.join("compose.json");
        let frozen_recipe = dir.join("recipe.json");
        let mut base = vec![
            "--host".into(),
            endpoint,
            "compose".into(),
            "--project-name".into(),
            env.id.clone(),
            "--project-directory".into(),
            env.cwd.to_string_lossy().into(),
            "--env-file".into(),
            dir.join("empty.env").to_string_lossy().into(),
            "-f".into(),
            compose.to_string_lossy().into(),
        ];
        private_write(&dir.join("empty.env"), b"")?;
        if compose.exists() && matches!(action, "start" | "reset") {
            // A recipe changed since this configuration was frozen (or was
            // frozen before digests were kept): take down what the OLD
            // configuration started, with the old configuration, so cleanup
            // never follows a changed recipe to other resources. Then the
            // new recipe is resolved and validated like a first start.
            let live = current_recipe_digest(&env.cwd)?;
            if env.frozen_recipe.as_deref() != Some(live.as_str()) {
                let mut args = base.clone();
                args.extend(["down".into(), "--remove-orphans".into()]);
                if action == "reset" {
                    args.push("--volumes".into());
                }
                run(&docker, &args, &dir, Some(env), 120).map_err(|e| {
                    format!("Could not stop the services built from the previous recipe: {e}")
                })?;
                fs::remove_file(&compose).map_err(|e| e.to_string())?;
                let _ = fs::remove_file(&frozen_recipe);
                env.frozen_recipe = None;
                env.fingerprint = None;
                env.urls.clear();
                self.save(env)?;
            }
        }
        if !compose.exists() {
            if matches!(action, "stop" | "reset") {
                return Err("No owned Compose configuration has been prepared yet.".into());
            }
            let (recipe, source) = read_recipe(&env.cwd)?;
            let digest = current_recipe_digest(&env.cwd)?;
            // Resolve once, validate ownership, then keep that exact configuration
            // for stop/reset even if the worktree or its recipe later changes.
            *base.last_mut().unwrap() = source.to_string_lossy().into();
            if let Some(file) = &recipe.env_file {
                let file = env
                    .cwd
                    .join(".octiq")
                    .join(file)
                    .canonicalize()
                    .map_err(|_| "Sandbox envFile is unavailable.")?;
                // An explicit private host file keeps credentials out of the
                // repository and Docker build context. Recipes are trusted
                // project setup, not an agent filesystem permission boundary.
                if !file.is_file() {
                    return Err("Sandbox envFile must name a file.".into());
                }
                base[8] = file.to_string_lossy().into();
            }
            let mut args = base.clone();
            args.extend([
                "--profile".into(),
                "*".into(),
                "config".into(),
                "--format".into(),
                "json".into(),
            ]);
            let text = run(&docker, &args, &dir, Some(env), 30)?;
            let mut config: Value = serde_json::from_str(&text)
                .map_err(|_| "Docker returned an invalid Compose configuration.")?;
            validate_compose(&config, &env.id, &recipe.check_service)?;
            // Compose parses interpolations again when reading a JSON model.
            escape_dollars(&mut config);
            private_write(
                &frozen_recipe,
                &serde_json::to_vec_pretty(&recipe).map_err(|e| e.to_string())?,
            )?;
            private_write(
                &compose,
                &serde_json::to_vec_pretty(&config).map_err(|e| e.to_string())?,
            )?;
            env.frozen_recipe = Some(digest);
            self.save(env)?;
            *base.last_mut().unwrap() = compose.to_string_lossy().into();
            base[8] = dir.join("empty.env").to_string_lossy().into();
        }
        let recipe: Recipe =
            serde_json::from_slice(&fs::read(&frozen_recipe).map_err(|e| e.to_string())?)
                .map_err(|_| "Saved sandbox recipe is unreadable.")?;
        env.fixture_version = recipe.fixture_version.clone();
        if matches!(action, "stop" | "reset") {
            let mut args = base.clone();
            args.push("down".into());
            if action == "reset" {
                args.push("--volumes".into());
            }
            run(&docker, &args, &dir, Some(env), 120)?;
            env.urls.clear();
            if action == "stop" {
                env.state = "stopped".into();
                return Ok(());
            }
        }
        let config: Value = serde_json::from_slice(&fs::read(&compose).map_err(|e| e.to_string())?)
            .map_err(|_| "Saved Compose configuration is unreadable.")?;
        if matches!(action, "start" | "reset") {
            // What the images are built from, read before the build: an
            // edit made while it runs is not what the check will prove.
            let built = fingerprint::sources(&fingerprint::source_dirs(&env.cwd, &config));
            env.fingerprint = Some(fingerprint::Fingerprint {
                sources: built,
                recipe: env.frozen_recipe.clone(),
                fixture_version: recipe.fixture_version.clone(),
            });
            let mut args = base.clone();
            args.extend(
                [
                    "up",
                    "--detach",
                    "--build",
                    "--wait",
                    "--wait-timeout",
                    "180",
                ]
                .map(str::to_string),
            );
            run(&docker, &args, &dir, Some(env), 900)?;
        }
        let mut args = base.clone();
        args.extend(["run", "--rm", "--no-deps", "-T"].map(str::to_string));
        args.push(recipe.check_service.clone());
        run(&docker, &args, &dir, Some(env), 180)?;
        env.urls.clear();
        for (name, target) in recipe.endpoints {
            let mut args = base.clone();
            args.extend(["port".into(), target.service, target.port.to_string()]);
            let published = run(&docker, &args, &dir, Some(env), 30)?;
            let port = published
                .trim()
                .strip_prefix("127.0.0.1:")
                .and_then(|p| p.parse::<u16>().ok())
                .filter(|p| *p > 0)
                .ok_or("Sandbox endpoint is not bound to host loopback.")?;
            if !target.path.starts_with('/') || target.path.contains(['\n', '\r']) {
                return Err("Sandbox endpoint paths must start with /.".into());
            }
            // Cookies are scoped to host, not port. Distinct localhost names
            // keep two normal browser sign-ins from sharing a session cookie.
            env.urls.insert(
                name,
                format!("http://{}.localhost:{port}{}", env.id, target.path),
            );
        }
        // A check alone rebuilds nothing, so it proves the sources of the
        // last build; one with no recorded build cannot say what it proved.
        let own = env.cwd.to_string_lossy().into_owned();
        let own = env
            .fingerprint
            .as_ref()
            .and_then(|f| f.sources.iter().find(|s| own.starts_with(&s.path)).cloned());
        env.source_revision = own.as_ref().and_then(|s| s.revision.clone());
        env.source_dirty = own.as_ref().map(|s| s.dirty);
        env.state = "ready".into();
        env.checked_at = Some(now());
        private_write(&dir.join("handoff.json"), &serde_json::to_vec_pretty(&json!({
            "environmentId": env.id, "cwd": env.cwd, "urls": env.urls, "checkedAt": env.checked_at,
            "sourceRevision": env.source_revision, "sourceDirty": env.source_dirty,
            "fixtureVersion": env.fixture_version, "fingerprint": env.fingerprint,
            "note": "Project test services on this OctiqFlow host. The recipe's readiness command passed at checkedAt. Recheck before testing; task completion is not application acceptance. This does not change agent tool permissions."
        })).map_err(|e| e.to_string())?)?;
        Ok(())
    }

    /// What a person or agent reads: the stored state, when each ready
    /// environment was last probed, and the host's slots. Queues a probe of
    /// every ready environment not probed lately (`health`) and returns
    /// without waiting for it.
    pub fn snapshot_probed(&self) -> Result<Snapshot, String> {
        let mut data = self.snapshot()?;
        let ready: Vec<String> = data
            .environments
            .values()
            .filter(|e| e.enabled && e.state == "ready")
            .map(|e| e.chat_key.clone())
            .collect();
        for env in data.environments.values_mut() {
            env.probed_at = health::probed_at(&self.root, &env.chat_key);
        }
        health::request(&self.root, ready, now());
        let mut live = self.live_in(&data);
        live.extend(capacity::held());
        data.capacity = Some(CapacityView {
            limit: capacity::limit(),
            live: live.into_iter().collect(),
            waiting: capacity::waiting()
                .into_iter()
                .map(|w| CapacityWaiter {
                    label: w.label,
                    keys: w.keys,
                    since: w.since,
                })
                .collect(),
        });
        Ok(data)
    }

    fn live_in(&self, data: &Snapshot) -> BTreeSet<String> {
        data.environments
            .values()
            .filter(|e| {
                e.enabled
                    && running_state(&e.state)
                    && self
                        .directory(e)
                        .is_ok_and(|d| d.join("compose.json").exists())
            })
            .map(|e| e.chat_key.clone())
            .collect()
    }

    /// Environments started and not stopped since: what holds a slot.
    pub fn live_keys(&self) -> BTreeSet<String> {
        self.snapshot()
            .map(|data| self.live_in(&data))
            .unwrap_or_default()
    }

    /// Record `key` as started (a frozen configuration, state ready)
    /// without Docker, for other modules' capacity tests.
    #[cfg(test)]
    pub(crate) fn force_live_for_test(&self, key: &str) {
        let env = self.snapshot().unwrap().environments[key].clone();
        private_write(&self.directory(&env).unwrap().join("compose.json"), b"{}").unwrap();
        self.mutate(|data| {
            let env = data.environments.get_mut(key).unwrap();
            env.state = "ready".into();
            env.host_instance = instance().into();
            Ok(())
        })
        .unwrap();
    }

    fn busy(&self, key: &str) -> bool {
        let token = format!("{}:{key}", self.root.display());
        OPERATIONS
            .lock()
            .map(|active| active.contains(&token))
            .unwrap_or(true)
    }

    /// `operation`, waiting up to `timeout` for another one on the same
    /// environment to finish rather than failing at once. For the host's
    /// own work, which must not fail because the lifecycle was mid-stop.
    fn operation_wait(&self, key: &str, timeout: Duration) -> Result<Operation, String> {
        let start = Instant::now();
        loop {
            match self.operation(key) {
                Ok(operation) => return Ok(operation),
                Err(error) if start.elapsed() >= timeout => return Err(error),
                Err(_) => std::thread::sleep(Duration::from_millis(250)),
            }
        }
    }

    /// The host's start or check of an orchestrated environment: like a
    /// person's, but it waits its turn behind another operation on it.
    pub fn host_action(&self, key: &str, action: &str) -> Result<Environment, String> {
        let _operation = self.operation_wait(key, Duration::from_secs(900))?;
        let mut env = self
            .snapshot()?
            .environments
            .get(key)
            .filter(|e| e.enabled)
            .cloned()
            .ok_or("This chat has no sandbox.")?;
        self.execute(&mut env, action, None)?;
        Ok(env)
    }

    /// Before a dependant runs on it: recheck a ready environment whose
    /// sources, recipe and fixture still match its build; rebuild any other
    /// (stale, unhealthy, stopped, or not checked by this server).
    pub fn host_refresh(&self, key: &str) -> Result<Environment, String> {
        let env = self
            .snapshot()?
            .environments
            .get(key)
            .filter(|e| e.enabled)
            .cloned()
            .ok_or("That task has no test environment.")?;
        let current = env.state == "ready" && matches!(self.stale_reason(&env), Ok(None));
        self.host_action(key, if current { "check" } else { "start" })
    }

    /// A person's action from the Sandbox panel. Starting, checking or
    /// resetting holds the services for them (`lease`), so the host's
    /// lifecycle does not stop what they are looking at; stopping releases
    /// the hold. Set under the same operation, so the lifecycle can never
    /// slip a stop in between.
    pub fn person_action(
        &self,
        key: &str,
        action: &str,
        confirmation: Option<&str>,
        idle: impl FnOnce() -> Result<(), String>,
    ) -> Result<Environment, String> {
        let _operation = self.operation(key)?;
        idle()?;
        let mut env = self
            .snapshot()?
            .environments
            .get(key)
            .filter(|e| e.enabled)
            .cloned()
            .ok_or("This chat has no sandbox.")?;
        env.lease = (action != "stop").then(|| Lease {
            by: "person".into(),
            at: now(),
        });
        self.execute(&mut env, action, confirmation)?;
        if action == "stop" {
            env.stopped = Some(Stopped {
                by: "person".into(),
                reason: "Stopped from the Sandbox panel.".into(),
                at: now(),
            });
            self.save(&env)?;
        }
        Ok(env)
    }

    /// Stop services nothing needs any more (the orchestration lifecycle),
    /// keeping their volumes, through the frozen configuration only.
    /// `Ok(false)` when there is nothing to stop, the person holds them, or
    /// another operation is changing them right now — the next pass looks
    /// again.
    pub fn host_stop(&self, key: &str, reason: &str) -> Result<bool, String> {
        let Ok(_operation) = self.operation(key) else {
            return Ok(false);
        };
        let Some(mut env) = self
            .snapshot()?
            .environments
            .get(key)
            .filter(|e| e.enabled)
            .cloned()
        else {
            return Ok(false);
        };
        if env.lease.is_some()
            || !running_state(&env.state)
            || !self.directory(&env)?.join("compose.json").exists()
        {
            return Ok(false);
        }
        self.execute(&mut env, "stop", None)?;
        env.stopped = Some(Stopped {
            by: "host".into(),
            reason: reason.into(),
            at: now(),
        });
        self.save(&env)?;
        Ok(true)
    }

    /// A retry takes over its previous attempt's environment for the same
    /// folder — the same Compose project and volumes — instead of building a
    /// second stack beside it. `Ok(false)` when there is none to take.
    pub fn adopt(&self, from: &str, to: &str, cwd: &str) -> Result<bool, String> {
        valid_key(to)?;
        let cwd = Path::new(cwd)
            .canonicalize()
            .map_err(|e| format!("Chat folder is unavailable: {e}"))?;
        let _from = self.operation_wait(from, Duration::from_secs(900))?;
        let _to = self.operation_wait(to, Duration::from_secs(900))?;
        self.mutate(|data| {
            if data.environments.contains_key(to) {
                return Ok(false);
            }
            let Some(mut env) = data
                .environments
                .get(from)
                .filter(|e| e.enabled && e.cwd == cwd)
                .cloned()
            else {
                return Ok(false);
            };
            data.environments.remove(from);
            env.chat_key = to.into();
            env.locked = true;
            data.environments.insert(to.into(), env);
            Ok(true)
        })
    }

    /// Look at one ready environment now: what it was built from against
    /// its check's fingerprint, then its containers. Demotes it, with the
    /// reason, when either is wrong. Runs on the probe thread (`health`).
    pub(crate) fn probe(&self, key: &str) -> Result<(), String> {
        let Some(env) = self
            .snapshot()?
            .environments
            .get(key)
            .filter(|e| e.enabled && e.state == "ready")
            .cloned()
        else {
            return Ok(());
        };
        if self.busy(key) {
            return Ok(());
        }
        if let Some(reason) = self.stale_reason(&env)? {
            return self.invalidate(key, env.checked_at, "stale", reason);
        }
        if let Some(reason) = self.container_problem(&env) {
            return self.invalidate(key, env.checked_at, "unhealthy", reason);
        }
        Ok(())
    }

    fn frozen_config(&self, env: &Environment) -> Result<Value, String> {
        let bytes = fs::read(self.directory(env)?.join("compose.json"))
            .map_err(|_| "No owned Compose configuration has been prepared yet.")?;
        serde_json::from_slice(&bytes)
            .map_err(|_| "Saved Compose configuration is unreadable.".into())
    }

    fn stale_reason(&self, env: &Environment) -> Result<Option<String>, String> {
        let Some(recorded) = &env.fingerprint else {
            return Ok(Some("Checked before OctiqFlow recorded what a check covers; start it again to confirm what it serves.".into()));
        };
        let recipe = match current_recipe_digest(&env.cwd) {
            Ok(digest) => Some(digest),
            Err(error) => return Ok(Some(format!("The sandbox recipe is unavailable: {error}"))),
        };
        let fixture_version = read_recipe(&env.cwd)
            .ok()
            .and_then(|(recipe, _)| recipe.fixture_version);
        let config = self.frozen_config(env)?;
        let live = fingerprint::Fingerprint {
            sources: fingerprint::sources(&fingerprint::source_dirs(&env.cwd, &config)),
            recipe,
            fixture_version,
        };
        Ok(fingerprint::difference(recorded, &live))
    }

    fn container_problem(&self, env: &Environment) -> Option<String> {
        let dir = self.directory(env).ok()?;
        let config = self.frozen_config(env).ok()?;
        let Some(docker) = crate::proc::find_executable("docker") else {
            return Some("Docker is no longer available on this host.".into());
        };
        let Some(endpoint) = env.docker_endpoint.clone() else {
            return Some("No Docker endpoint was recorded for this environment.".into());
        };
        let args: Vec<String> = vec![
            "--host".into(),
            endpoint,
            "compose".into(),
            "--project-name".into(),
            env.id.clone(),
            "--project-directory".into(),
            dir.to_string_lossy().into(),
            "--env-file".into(),
            dir.join("empty.env").to_string_lossy().into(),
            "-f".into(),
            dir.join("compose.json").to_string_lossy().into(),
            "ps".into(),
            "--all".into(),
            "--format".into(),
            "json".into(),
        ];
        match run(&docker, &args, &dir, None, health::PROBE_SECONDS) {
            Err(error) => Some(format!(
                "The health probe could not read its services: {error}"
            )),
            Ok(output) => health::judge(&config, &output).err(),
        }
    }

    /// Demote the check a probe looked at — only that one: a newer check,
    /// or an operation under way, stands.
    fn invalidate(
        &self,
        key: &str,
        checked_at: Option<u64>,
        kind: &str,
        reason: String,
    ) -> Result<(), String> {
        if self.busy(key) {
            return Ok(());
        }
        self.mutate(|data| {
            if let Some(env) = data.environments.get_mut(key) {
                if env.state == "ready"
                    && env.checked_at == checked_at
                    && env.host_instance == instance()
                {
                    env.state = kind.into();
                    env.invalidated = Some(Invalidation {
                        kind: kind.into(),
                        reason,
                        at: now(),
                    });
                }
            }
            Ok(())
        })
    }
}

/// Ready on this server within the last two minutes.
fn just_checked(env: &Environment, now: u64) -> bool {
    env.state == "ready"
        && env.host_instance == instance()
        && env
            .checked_at
            .is_some_and(|at| now.saturating_sub(at) < 120_000)
}

struct Operation(String);
impl Drop for Operation {
    fn drop(&mut self) {
        if let Ok(mut active) = OPERATIONS.lock() {
            active.remove(&self.0);
        }
    }
}
pub(crate) struct StartGuard {
    _operation: Operation,
    pub id: String,
    pub handoff: PathBuf,
}
pub(crate) fn prepare_for_start(key: &str, cwd: &str) -> Result<Option<StartGuard>, String> {
    Store::profile().prepare(key, cwd)
}

fn valid_key(key: &str) -> Result<(), String> {
    let id = key
        .strip_prefix("chat:")
        .ok_or("Sandbox requires a chat key.")?;
    if id.is_empty()
        || id.len() > 128
        || !id
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_'))
    {
        return Err("Invalid sandbox chat key.".into());
    }
    Ok(())
}

/// The digest of the recipe a start would freeze now. See `fingerprint`.
fn current_recipe_digest(cwd: &Path) -> Result<String, String> {
    let (recipe, _) = read_recipe(cwd)?;
    let root = recipe_root(cwd)?;
    fingerprint::recipe_digest(
        &root.join(".octiq"),
        recipe.env_file.as_deref().map(Path::new),
    )
}

/// The folder whose `.octiq/sandbox.json` applies to `cwd`.
fn recipe_root(cwd: &Path) -> Result<PathBuf, String> {
    let mut root = cwd
        .canonicalize()
        .map_err(|e| format!("Sandbox folder is unavailable: {e}"))?;
    // Host-local setup need not be committed just to use a linked worktree.
    // Explicit worktree recipes win; otherwise inherit from its primary repo.
    if !root.join(".octiq/sandbox.json").exists() {
        if let Some(common) = git(
            cwd,
            &["rev-parse", "--path-format=absolute", "--git-common-dir"],
        ) {
            let common = PathBuf::from(common);
            if common.file_name().is_some_and(|name| name == ".git") {
                if let Some(primary) = common
                    .parent()
                    .filter(|p| p.join(".octiq/sandbox.json").is_file())
                {
                    root = primary.canonicalize().map_err(|e| e.to_string())?;
                }
            }
        }
    }
    Ok(root)
}

fn read_recipe(cwd: &Path) -> Result<(Recipe, PathBuf), String> {
    let root = recipe_root(cwd)?;
    let path = root.join(".octiq/sandbox.json");
    let bytes = fs::read(&path).map_err(|_| format!("This project needs .octiq/sandbox.json and a Compose recipe before using a sandbox. Folder: {}", cwd.display()))?;
    if bytes.len() > 64 * 1024 {
        return Err("Sandbox recipe is too large.".into());
    }
    let mut recipe: Recipe =
        serde_json::from_slice(&bytes).map_err(|e| format!("Invalid sandbox recipe: {e}"))?;
    if recipe.version != 1
        || recipe.check_service.is_empty()
        || recipe.check_service.starts_with('-')
    {
        return Err("Sandbox recipe requires version 1 and a checkService.".into());
    }
    let source = path
        .parent()
        .unwrap()
        .join(&recipe.compose_file)
        .canonicalize()
        .map_err(|e| format!("Sandbox Compose file is unavailable: {e}"))?;
    if !source.starts_with(&root) {
        return Err("Sandbox Compose file must be inside the chat's project folder.".into());
    }
    if let Some(file) = &recipe.env_file {
        recipe.env_file = Some(path.parent().unwrap().join(file).to_string_lossy().into());
    }
    Ok((recipe, source))
}

fn local_endpoint(endpoint: &str) -> bool {
    endpoint.starts_with("unix:///") || endpoint.starts_with("npipe:////./pipe/")
}

fn docker_endpoint(docker: &str, dir: &Path) -> Result<String, String> {
    let endpoint = if let Ok(host) = std::env::var("DOCKER_HOST") {
        if std::env::var("DOCKER_CONTEXT").is_ok() {
            return Err(
                "Set only one local Docker context; DOCKER_HOST and DOCKER_CONTEXT conflict."
                    .into(),
            );
        }
        host
    } else {
        let mut args = vec!["context".into(), "inspect".into()];
        if let Ok(context) = std::env::var("DOCKER_CONTEXT") {
            args.push(context);
        }
        args.extend(["--format".into(), "{{.Endpoints.docker.Host}}".into()]);
        run(docker, &args, dir, None, 15)?.trim().into()
    };
    if !local_endpoint(&endpoint) {
        return Err("Sandbox requires a local Docker socket. Remote TCP/SSH Docker endpoints are not supported; choose a local context.".into());
    }
    Ok(endpoint)
}

fn validate_compose(config: &Value, project: &str, check: &str) -> Result<(), String> {
    let fail = || {
        "Sandbox Compose must use isolated project resources: no privileged containers, host namespaces, shared volumes or fixed container names; published ports must use 127.0.0.1 with dynamic allocation.".to_string()
    };
    for category in ["volumes", "networks", "secrets", "configs"] {
        if let Some(resources) = config[category].as_object() {
            for resource in resources.values() {
                if resource["external"].as_bool() == Some(true)
                    || resource.get("driver_opts").is_some()
                    || resource["driver"]
                        .as_str()
                        .is_some_and(|d| !matches!(d, "local" | "bridge"))
                    || resource["name"]
                        .as_str()
                        .is_some_and(|n| !n.starts_with(&format!("{project}_")))
                {
                    return Err(fail());
                }
            }
        }
    }
    let services = config["services"]
        .as_object()
        .ok_or("Compose recipe has no services.")?;
    let checker = services
        .get(check)
        .ok_or("Compose recipe is missing its checkService.")?;
    if !checker["profiles"]
        .as_array()
        .is_some_and(|p| p.iter().any(|v| v == "check"))
    {
        return Err(
            "The readiness service must use the check profile so it runs after startup.".into(),
        );
    }
    for service in services.values() {
        if service["privileged"].as_bool() == Some(true)
            || service.get("network_mode").is_some_and(|v| v != "none")
            || [
                "container_name",
                "pid",
                "ipc",
                "devices",
                "cap_add",
                "volumes_from",
                "external_links",
            ]
            .iter()
            .any(|k| service.get(k).is_some())
        {
            return Err(fail());
        }
        if let Some(volumes) = service["volumes"].as_array() {
            for volume in volumes {
                match volume["type"].as_str() {
                    Some("volume")
                        if volume["source"]
                            .as_str()
                            .is_some_and(|name| config["volumes"].get(name).is_some()) => {}
                    Some("bind") if volume["read_only"].as_bool() == Some(true) => {
                        let source = volume["source"].as_str().unwrap_or("");
                        if source.ends_with(".sock") || source.contains("docker_engine") {
                            return Err(fail());
                        }
                    }
                    Some("tmpfs") => {}
                    _ => return Err(fail()),
                }
            }
        }
        if let Some(ports) = service["ports"].as_array() {
            for port in ports {
                if port["host_ip"] != "127.0.0.1"
                    || port.get("published").is_some_and(|v| v != "0" && v != 0)
                {
                    return Err(fail());
                }
            }
        }
    }
    Ok(())
}

fn escape_dollars(value: &mut Value) {
    match value {
        Value::String(text) => *text = text.replace('$', "$$"),
        Value::Array(values) => values.iter_mut().for_each(escape_dollars),
        Value::Object(values) => values.values_mut().for_each(escape_dollars),
        _ => {}
    }
}

fn private_dir(path: &Path) -> Result<(), String> {
    fs::create_dir_all(path).map_err(|e| e.to_string())?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(path, fs::Permissions::from_mode(0o700)).map_err(|e| e.to_string())?;
    }
    Ok(())
}

fn private_write(path: &Path, bytes: &[u8]) -> Result<(), String> {
    use std::io::Write;
    private_dir(path.parent().ok_or("Missing parent folder.")?)?;
    let temp = path.with_extension(format!("{}.tmp", uuid::Uuid::new_v4().simple()));
    let mut options = OpenOptions::new();
    options.create_new(true).write(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let result = (|| {
        let mut file = options.open(&temp)?;
        file.write_all(bytes)?;
        file.sync_all()?;
        fs::rename(&temp, path)
    })();
    if result.is_err() {
        let _ = fs::remove_file(&temp);
    }
    result.map_err(|e| format!("Could not save sandbox state: {e}"))
}

fn runtime_secrets(dir: &Path) -> Result<BTreeMap<String, String>, String> {
    let path = dir.join("runtime-secrets.json");
    if path.exists() {
        return serde_json::from_slice(&fs::read(path).map_err(|e| e.to_string())?).map_err(|_| {
            "Sandbox runtime credentials are unreadable; they were not regenerated.".into()
        });
    }
    let key: Vec<u8> = (0..4)
        .flat_map(|_| uuid::Uuid::new_v4().into_bytes())
        .collect();
    let secrets = BTreeMap::from([
        (
            "OCTIQ_SANDBOX_DB_PASSWORD".into(),
            format!("Sb!{}", uuid::Uuid::new_v4().simple()),
        ),
        (
            "OCTIQ_SANDBOX_JWT_KEY".into(),
            base64::engine::general_purpose::STANDARD.encode(key),
        ),
    ]);
    private_write(
        &path,
        &serde_json::to_vec(&secrets).map_err(|e| e.to_string())?,
    )?;
    Ok(secrets)
}

/// File-backed output avoids a full pipe deadlock; secrets never enter errors/events.
fn run(
    program: &str,
    args: &[String],
    dir: &Path,
    env: Option<&Environment>,
    seconds: u64,
) -> Result<String, String> {
    private_dir(dir)?;
    let output = dir.join(format!("command-{}.log", uuid::Uuid::new_v4().simple()));
    private_write(&output, b"")?;
    let stdout = OpenOptions::new()
        .write(true)
        .open(&output)
        .map_err(|e| e.to_string())?;
    let stderr_path = output.with_extension("stderr.log");
    private_write(&stderr_path, b"")?;
    let stderr = OpenOptions::new()
        .write(true)
        .open(&stderr_path)
        .map_err(|e| e.to_string())?;
    let mut command = Command::new(program);
    command
        .args(args)
        .current_dir(dir)
        .stdin(Stdio::null())
        .stdout(stdout)
        .stderr(stderr);
    for (key, _) in std::env::vars().filter(|(k, _)| {
        k.starts_with("COMPOSE_")
            || matches!(
                k.as_str(),
                "DOCKER_HOST" | "DOCKER_CONTEXT" | "DOCKER_TLS_VERIFY" | "DOCKER_CERT_PATH"
            )
    }) {
        command.env_remove(key);
    }
    if let Some(env) = env {
        command
            .env("OCTIQ_SANDBOX_ID", &env.id)
            .env("OCTIQ_SANDBOX_DIR", dir)
            .env("OCTIQ_PROJECT_DIR", &env.cwd);
        command.envs(runtime_secrets(dir)?);
    }
    crate::proc::no_console(&mut command);
    let mut child = command
        .spawn()
        .map_err(|e| format!("Could not run Docker: {e}"))?;
    let start = Instant::now();
    let status = loop {
        if let Some(status) = child.try_wait().map_err(|e| e.to_string())? {
            break status;
        }
        if start.elapsed() > Duration::from_secs(seconds) {
            let _ = child.kill();
            let _ = child.wait();
            return Err(format!(
                "Sandbox command timed out. Private logs: {}",
                stderr_path.display()
            ));
        }
        std::thread::sleep(Duration::from_millis(100));
    };
    if !status.success() {
        return Err(format!(
            "Sandbox command failed ({}). Private logs: {}",
            status.code().unwrap_or(-1),
            stderr_path.display()
        ));
    }
    let mut text = String::new();
    fs::File::open(&output)
        .map_err(|e| e.to_string())?
        .take(2 * 1024 * 1024 + 1)
        .read_to_string(&mut text)
        .map_err(|e| e.to_string())?;
    if text.len() > 2 * 1024 * 1024 {
        return Err("Docker output exceeded the sandbox limit.".into());
    }
    let _ = fs::remove_file(output);
    let _ = fs::remove_file(stderr_path);
    Ok(text)
}

fn git(cwd: &Path, args: &[&str]) -> Option<String> {
    let mut cmd = Command::new("git");
    cmd.current_dir(cwd).args(args);
    crate::proc::no_console(&mut cmd);
    let out = cmd.output().ok()?;
    out.status
        .success()
        .then(|| String::from_utf8_lossy(&out.stdout).trim().into())
}

#[cfg(test)]
mod tests {
    use super::*;
    fn store() -> Store {
        Store {
            root: std::env::temp_dir().join(format!("octiq-sandbox-test-{}", uuid::Uuid::new_v4())),
        }
    }

    #[test]
    fn local_runtime_accepts_mac_linux_and_windows_sockets_but_no_remote_hosts() {
        for value in [
            "unix:///var/run/docker.sock",
            "unix:///Users/test/.colima/default/docker.sock",
            "npipe:////./pipe/docker_engine",
        ] {
            assert!(local_endpoint(value));
        }
        for value in [
            "ssh://macbook",
            "tcp://127.0.0.1:2375",
            "https://remote",
            "unix://remote/socket",
        ] {
            assert!(!local_endpoint(value));
        }
    }

    #[test]
    fn runtime_credentials_survive_resume_and_differ_between_sandboxes() {
        let store = store();
        let a = store.root.join("a");
        let b = store.root.join("b");
        let first = runtime_secrets(&a).unwrap();
        assert_eq!(first, runtime_secrets(&a).unwrap());
        let second = runtime_secrets(&b).unwrap();
        for key in first.keys() {
            assert_ne!(first[key], second[key]);
        }
        fs::remove_dir_all(store.root).unwrap();
    }

    #[test]
    fn linked_worktree_inherits_local_recipe_but_can_override_it() {
        let store = store();
        let primary = store.root.join("primary");
        let linked = store.root.join("linked");
        fs::create_dir_all(primary.join(".octiq")).unwrap();
        fs::create_dir_all(store.root.join("empty-hooks")).unwrap();
        assert!(git(&primary, &["init", "-q"]).is_some());
        assert!(git(
            &primary,
            &[
                "-c",
                "user.name=Sandbox test",
                "-c",
                "user.email=sandbox@example.invalid",
                "-c",
                "commit.gpgSign=false",
                "-c",
                &format!(
                    "core.hooksPath={}",
                    store.root.join("empty-hooks").display()
                ),
                "commit",
                "--allow-empty",
                "-qm",
                "fixture"
            ]
        )
        .is_some());
        assert!(git(
            &primary,
            &["worktree", "add", "--detach", linked.to_str().unwrap()]
        )
        .is_some());
        let recipe = r#"{"version":1,"composeFile":"compose.json","envFile":"private.env","checkService":"verify"}"#;
        fs::write(primary.join(".octiq/sandbox.json"), recipe).unwrap();
        fs::write(primary.join(".octiq/compose.json"), "{}").unwrap();
        let (inherited, compose) = read_recipe(&linked).unwrap();
        assert_eq!(
            compose,
            primary.join(".octiq/compose.json").canonicalize().unwrap()
        );
        assert_eq!(
            PathBuf::from(inherited.env_file.unwrap()),
            primary.canonicalize().unwrap().join(".octiq/private.env")
        );
        fs::create_dir_all(linked.join(".octiq")).unwrap();
        fs::write(linked.join(".octiq/sandbox.json"), recipe).unwrap();
        fs::write(linked.join(".octiq/compose.json"), "{}").unwrap();
        assert_eq!(
            read_recipe(&linked).unwrap().1,
            linked.join(".octiq/compose.json").canonicalize().unwrap()
        );
        assert!(git(
            &primary,
            &["worktree", "remove", "--force", linked.to_str().unwrap()]
        )
        .is_some());
        fs::remove_dir_all(store.root).unwrap();
    }

    #[test]
    fn setting_only_initializes_new_chats_and_resumes_keep_identity() {
        let store = store();
        let cwd = std::env::temp_dir();
        let cwd = cwd.to_str().unwrap();
        store.configure(true).unwrap();
        store.select("chat:new", cwd, None, false).unwrap();
        let first = store.snapshot().unwrap().environments["chat:new"].clone();
        assert!(first.enabled);
        store
            .mutate(|s| {
                s.environments.get_mut("chat:new").unwrap().locked = true;
                Ok(())
            })
            .unwrap();
        store.configure(false).unwrap();
        store.select("chat:new", cwd, Some(false), true).unwrap();
        let again = store.snapshot().unwrap().environments["chat:new"].clone();
        assert!(again.enabled);
        assert_eq!(first.id, again.id);
        store.configure(true).unwrap();
        store.select("chat:old", cwd, None, true).unwrap();
        assert!(!store.snapshot().unwrap().environments["chat:old"].enabled);
        fs::remove_dir_all(store.root).unwrap();
    }

    #[test]
    fn restart_invalidates_readiness_and_broken_state_is_not_overwritten() {
        let store = store();
        store
            .select(
                "chat:a",
                std::env::temp_dir().to_str().unwrap(),
                Some(true),
                false,
            )
            .unwrap();
        store
            .mutate(|s| {
                let e = s.environments.get_mut("chat:a").unwrap();
                e.state = "ready".into();
                e.checked_at = Some(1);
                e.host_instance = "old host".into();
                Ok(())
            })
            .unwrap();
        let snapshot = store.snapshot().unwrap();
        assert_eq!(snapshot.environments["chat:a"].state, "unverified");
        assert_eq!(snapshot.environments["chat:a"].checked_at, None);
        fs::write(store.root.join("state.json"), b"broken").unwrap();
        assert!(store.configure(true).is_err());
        assert_eq!(fs::read(store.root.join("state.json")).unwrap(), b"broken");
        fs::remove_dir_all(store.root).unwrap();
    }

    #[test]
    fn isolation_rejects_shared_resources_and_host_access() {
        let config = json!({"services":{"api":{"ports":[{"host_ip":"127.0.0.1","published":"0"}]},"verify":{"profiles":["check"]}},"volumes":{"data":{"name":"octiq-sb-test_data"}}});
        assert!(validate_compose(&config, "octiq-sb-test", "verify").is_ok());
        for (pointer, value) in [
            ("/volumes/data/name", json!("shared")),
            ("/services/api/ports/0/host_ip", json!("0.0.0.0")),
            ("/services/api/ports/0/published", json!("5432")),
            ("/services/verify/profiles", json!([])),
        ] {
            let mut invalid = config.clone();
            *invalid.pointer_mut(pointer).unwrap() = value;
            assert!(validate_compose(&invalid, "octiq-sb-test", "verify").is_err());
        }
        let mut invalid = config.clone();
        invalid["services"]["api"]["privileged"] = json!(true);
        assert!(validate_compose(&invalid, "octiq-sb-test", "verify").is_err());
    }

    #[test]
    #[ignore = "requires local Docker; creates and removes only its own test projects"]
    fn docker_lifecycle_preserves_chat_data_and_reset_is_isolated() {
        let store = store();
        let project = store.root.join("project");
        fs::create_dir_all(project.join(".octiq")).unwrap();
        fs::write(project.join(".octiq/sandbox.json"), r#"{"version":1,"composeFile":"compose.json","checkService":"verify","fixtureVersion":"test-v1","endpoints":{"app":{"service":"app","port":80,"path":"/"}}}"#).unwrap();
        let config = json!({"services":{
            "app":{"image":"nginx:1.27-alpine","ports":[{"target":80,"host_ip":"127.0.0.1"}],"volumes":["data:/data"]},
            "verify":{"image":"alpine:3.22","profiles":["check"],"command":["sh","-c","wget -q -O /dev/null http://app && test -d /data"],"volumes":["data:/data"]}
        },"volumes":{"data":{}}});
        fs::write(
            project.join(".octiq/compose.json"),
            serde_json::to_vec(&config).unwrap(),
        )
        .unwrap();
        let cwd = project.to_str().unwrap();
        for key in ["chat:a", "chat:b"] {
            store.select(key, cwd, Some(true), false).unwrap();
        }
        // Keep diagnostics on a failed test; successful checks clean their own resources.
        let a = store.action("chat:a", "start", None).unwrap();
        let b = store.action("chat:b", "start", None).unwrap();
        assert_ne!(a.id, b.id);
        assert_ne!(a.urls, b.urls);
        let docker = crate::proc::find_executable("docker").unwrap();
        let mark = |env: &Environment, write: bool| {
            let args = vec![
                "--host".into(),
                env.docker_endpoint.clone().unwrap(),
                "compose".into(),
                "-p".into(),
                env.id.clone(),
                "-f".into(),
                store
                    .directory(env)
                    .unwrap()
                    .join("compose.json")
                    .to_string_lossy()
                    .into(),
                "exec".into(),
                "-T".into(),
                "app".into(),
                "sh".into(),
                "-c".into(),
                if write {
                    "echo kept > /data/marker"
                } else {
                    "cat /data/marker"
                }
                .into(),
            ];
            run(
                &docker,
                &args,
                &store.directory(env).unwrap(),
                Some(env),
                20,
            )
        };
        mark(&a, true).unwrap();
        mark(&b, true).unwrap();
        store.action("chat:a", "stop", None).unwrap();
        let resumed = store.action("chat:a", "start", None).unwrap();
        assert_eq!(a.id, resumed.id);
        assert_eq!(mark(&resumed, false).unwrap().trim(), "kept");
        store.action("chat:a", "reset", Some(&a.id)).unwrap();
        assert!(mark(&a, false).is_err());
        assert_eq!(mark(&b, false).unwrap().trim(), "kept");
        for env in [&a, &b] {
            let args = vec![
                "--host".into(),
                env.docker_endpoint.clone().unwrap(),
                "compose".into(),
                "-p".into(),
                env.id.clone(),
                "-f".into(),
                store
                    .directory(env)
                    .unwrap()
                    .join("compose.json")
                    .to_string_lossy()
                    .into(),
                "down".into(),
                "--volumes".into(),
            ];
            run(
                &docker,
                &args,
                &store.directory(env).unwrap(),
                Some(env),
                60,
            )
            .unwrap();
        }
        fs::remove_dir_all(store.root).unwrap();
    }

    #[test]
    fn reset_requires_exact_ownership_confirmation_before_running_any_command() {
        let store = store();
        store
            .select(
                "chat:a",
                std::env::temp_dir().to_str().unwrap(),
                Some(true),
                false,
            )
            .unwrap();
        assert!(store
            .action("chat:a", "reset", Some("other environment"))
            .unwrap_err()
            .contains("Confirm"));
        let op = store.operation("chat:a").unwrap();
        assert!(store.operation("chat:a").is_err());
        drop(op);
        assert!(store.operation("chat:a").is_ok());
        fs::remove_dir_all(store.root).unwrap();
    }

    fn commit(dir: &Path, message: &str) {
        let hooks = dir.join(".git/no-hooks");
        let _ = fs::create_dir_all(&hooks);
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
                &format!("core.hooksPath={}", hooks.display()),
                "commit",
                "--allow-empty",
                "-qm",
                message
            ]
        )
        .is_some());
    }

    /// A project with a recipe, and a chat whose environment passed its
    /// check against it just now (no Docker: the record a check leaves).
    fn checked(store: &Store, fixture: &str) -> (PathBuf, Environment) {
        let project = store.root.join("project");
        fs::create_dir_all(project.join(".octiq")).unwrap();
        assert!(git(&project, &["init", "-q"]).is_some());
        fs::write(project.join(".gitignore"), ".octiq/\n").unwrap();
        assert!(git(&project, &["add", ".gitignore"]).is_some());
        commit(&project, "first");
        fs::write(
            project.join(".octiq/sandbox.json"),
            format!(r#"{{"version":1,"composeFile":"compose.json","checkService":"verify","fixtureVersion":"{fixture}"}}"#),
        )
        .unwrap();
        fs::write(project.join(".octiq/compose.json"), "{}").unwrap();
        let project = project.canonicalize().unwrap();
        store
            .select("chat:a", project.to_str().unwrap(), Some(true), false)
            .unwrap();
        let recipe = current_recipe_digest(&project).unwrap();
        let config = json!({"services":{}});
        store
            .mutate(|data| {
                let env = data.environments.get_mut("chat:a").unwrap();
                env.state = "ready".into();
                env.checked_at = Some(5);
                env.host_instance = instance().into();
                env.frozen_recipe = Some(recipe.clone());
                env.fingerprint = Some(fingerprint::Fingerprint {
                    sources: fingerprint::sources(&fingerprint::source_dirs(&env.cwd, &config)),
                    recipe: Some(recipe.clone()),
                    fixture_version: Some(fixture.into()),
                });
                Ok(())
            })
            .unwrap();
        let env = store.snapshot().unwrap().environments["chat:a"].clone();
        private_write(
            &store.directory(&env).unwrap().join("compose.json"),
            config.to_string().as_bytes(),
        )
        .unwrap();
        (project, env)
    }

    #[test]
    fn a_ready_environment_goes_stale_with_its_reason_when_its_source_moves_after_the_check() {
        // Feedback caa2ca88 B1: readiness was only ever reset by a restart;
        // a new commit left it "ready" for sources it never checked.
        let store = store();
        let (project, env) = checked(&store, "v1");
        assert_eq!(store.stale_reason(&env).unwrap(), None);
        commit(&project, "moved on");
        store.probe("chat:a").unwrap();
        let after = store.snapshot().unwrap().environments["chat:a"].clone();
        assert_eq!(after.state, "stale");
        let why = after.invalidated.clone().unwrap();
        assert_eq!(why.kind, "stale");
        assert!(why.reason.contains("HEAD moved"), "{}", why.reason);
        assert_eq!(after.checked_at, Some(5), "the last passing check is kept");
        // A stale record is not ready to anyone: not a slot's owner's
        // shortcut, and after a restart it is merely unverified.
        assert!(!just_checked(&after, 6));
        store
            .mutate(|d| {
                d.environments.get_mut("chat:a").unwrap().host_instance = "old".into();
                Ok(())
            })
            .unwrap();
        assert_eq!(
            store.snapshot().unwrap().environments["chat:a"].state,
            "unverified"
        );
        fs::remove_dir_all(store.root).unwrap();
    }

    #[test]
    fn uncommitted_edits_the_recipe_and_the_fixture_version_each_make_it_stale() {
        let store = store();
        let (project, env) = checked(&store, "v1");
        fs::write(project.join("edit.txt"), "not committed").unwrap();
        assert!(store
            .stale_reason(&env)
            .unwrap()
            .unwrap()
            .contains("uncommitted"));
        fs::remove_file(project.join("edit.txt")).unwrap();
        assert_eq!(store.stale_reason(&env).unwrap(), None);
        fs::write(project.join(".octiq/verify.mjs"), "changed check").unwrap();
        assert!(store
            .stale_reason(&env)
            .unwrap()
            .unwrap()
            .contains("recipe changed"));
        fs::remove_file(project.join(".octiq/verify.mjs")).unwrap();
        fs::write(
            project.join(".octiq/sandbox.json"),
            r#"{"version":1,"composeFile":"compose.json","checkService":"verify","fixtureVersion":"v2"}"#,
        )
        .unwrap();
        let fixture = store.stale_reason(&env).unwrap().unwrap();
        assert!(fixture.contains("v1 to v2"), "{fixture}");
        // Recorded before fingerprints existed: nothing can be confirmed.
        let mut legacy = env.clone();
        legacy.fingerprint = None;
        assert!(store
            .stale_reason(&legacy)
            .unwrap()
            .unwrap()
            .contains("Checked before"));
        fs::remove_dir_all(store.root).unwrap();
    }

    #[test]
    fn a_probe_only_demotes_the_check_it_looked_at() {
        let store = store();
        let (_project, _env) = checked(&store, "v1");
        // A newer check landed while the probe ran: it stands.
        store
            .invalidate("chat:a", Some(4), "unhealthy", "old news".into())
            .unwrap();
        assert_eq!(
            store.snapshot().unwrap().environments["chat:a"].state,
            "ready"
        );
        // An operation under way: nothing is written under it.
        let op = store.operation("chat:a").unwrap();
        store
            .invalidate("chat:a", Some(5), "unhealthy", "busy".into())
            .unwrap();
        assert_eq!(
            store.snapshot().unwrap().environments["chat:a"].state,
            "ready"
        );
        drop(op);
        store
            .invalidate(
                "chat:a",
                Some(5),
                "unhealthy",
                "Service api has no container.".into(),
            )
            .unwrap();
        let env = store.snapshot().unwrap().environments["chat:a"].clone();
        assert_eq!(env.state, "unhealthy");
        assert_eq!(
            env.invalidated.unwrap().reason,
            "Service api has no container."
        );
        fs::remove_dir_all(store.root).unwrap();
    }

    #[test]
    fn a_retry_takes_over_the_environment_of_the_same_folder_only_and_a_hold_is_never_stopped() {
        let store = store();
        let (project, env) = checked(&store, "v1");
        let other = store.root.join("elsewhere");
        fs::create_dir_all(&other).unwrap();
        assert!(!store
            .adopt("chat:a", "chat:b", other.to_str().unwrap())
            .unwrap());
        assert!(store
            .adopt("chat:a", "chat:b", project.to_str().unwrap())
            .unwrap());
        let data = store.snapshot().unwrap();
        assert!(!data.environments.contains_key("chat:a"));
        let taken = &data.environments["chat:b"];
        assert_eq!(taken.id, env.id, "same Compose project and volumes");
        assert_eq!(taken.chat_key, "chat:b");

        // Started and not stopped holds a slot; stopped or never frozen does not.
        assert_eq!(store.live_keys(), BTreeSet::from(["chat:b".to_string()]));
        store
            .mutate(|d| {
                d.environments.get_mut("chat:b").unwrap().lease = Some(Lease {
                    by: "person".into(),
                    at: 1,
                });
                Ok(())
            })
            .unwrap();
        // Held by the person: the host's lifecycle leaves it, without Docker.
        assert!(!store.host_stop("chat:b", "nothing needs it").unwrap());
        store
            .mutate(|d| {
                let e = d.environments.get_mut("chat:b").unwrap();
                e.lease = None;
                e.state = "stopped".into();
                Ok(())
            })
            .unwrap();
        assert!(store.live_keys().is_empty());
        assert!(!store.host_stop("chat:b", "already stopped").unwrap());
        fs::remove_dir_all(store.root).unwrap();
    }

    #[test]
    #[ignore = "requires local Docker; creates and removes only its own test project"]
    fn docker_health_recipe_change_and_host_stop_keep_ownership_and_data() {
        let store = store();
        let project = store.root.join("project");
        fs::create_dir_all(project.join(".octiq")).unwrap();
        assert!(git(&project, &["init", "-q"]).is_some());
        fs::write(project.join(".gitignore"), ".octiq/\n").unwrap();
        assert!(git(&project, &["add", ".gitignore"]).is_some());
        commit(&project, "first");
        fs::write(project.join(".octiq/sandbox.json"), r#"{"version":1,"composeFile":"compose.json","checkService":"verify","fixtureVersion":"t1"}"#).unwrap();
        let compose = |extra: &str| {
            json!({"services":{
                "app":{"image":"nginx:1.27-alpine","ports":[{"target":80,"host_ip":"127.0.0.1"}],"volumes":["data:/data"],"environment":{"EXTRA":extra}},
                "verify":{"image":"alpine:3.22","profiles":["check"],"command":["sh","-c","wget -q -O /dev/null http://app && test -d /data"],"volumes":["data:/data"]}
            },"volumes":{"data":{}}})
        };
        fs::write(
            project.join(".octiq/compose.json"),
            compose("one").to_string(),
        )
        .unwrap();
        let cwd = project.to_str().unwrap();
        store.select("chat:a", cwd, Some(true), false).unwrap();
        let a = store.host_action("chat:a", "start").unwrap();
        assert_eq!(a.state, "ready");
        assert!(a
            .fingerprint
            .as_ref()
            .is_some_and(|f| f.fixture_version.as_deref() == Some("t1")));
        let docker = crate::proc::find_executable("docker").unwrap();
        let dir = store.directory(&a).unwrap();
        let compose_cmd = |env: &Environment, tail: &[&str]| {
            let mut args: Vec<String> = vec![
                "--host".into(),
                env.docker_endpoint.clone().unwrap(),
                "compose".into(),
                "-p".into(),
                env.id.clone(),
                "-f".into(),
                dir.join("compose.json").to_string_lossy().into(),
            ];
            args.extend(tail.iter().map(|s| s.to_string()));
            run(&docker, &args, &dir, Some(env), 60)
        };
        compose_cmd(
            &a,
            &["exec", "-T", "app", "sh", "-c", "echo kept > /data/marker"],
        )
        .unwrap();

        // Healthy: a probe leaves it ready.
        store.probe("chat:a").unwrap();
        assert_eq!(
            store.snapshot().unwrap().environments["chat:a"].state,
            "ready"
        );
        // A service lost after the check: unhealthy, with the service named.
        compose_cmd(&a, &["stop", "app"]).unwrap();
        store.probe("chat:a").unwrap();
        let lost = store.snapshot().unwrap().environments["chat:a"].clone();
        assert_eq!(lost.state, "unhealthy");
        assert!(lost.invalidated.unwrap().reason.contains("app"));

        // Recipe changed: stale; the next start takes the OLD stack down with
        // the old configuration, then freezes and runs the new one.
        let restarted = store.host_action("chat:a", "start").unwrap();
        assert_eq!(restarted.state, "ready");
        fs::write(
            project.join(".octiq/compose.json"),
            compose("two").to_string(),
        )
        .unwrap();
        store.probe("chat:a").unwrap();
        assert!(store.snapshot().unwrap().environments["chat:a"]
            .invalidated
            .as_ref()
            .unwrap()
            .reason
            .contains("recipe changed"));
        let rebuilt = store.host_action("chat:a", "start").unwrap();
        assert_eq!(rebuilt.state, "ready");
        assert_eq!(rebuilt.id, a.id, "same owned project");
        assert_ne!(rebuilt.frozen_recipe, a.frozen_recipe);
        let frozen = fs::read_to_string(dir.join("compose.json")).unwrap();
        assert!(frozen.contains("two"), "the new recipe is what runs now");
        assert_eq!(
            compose_cmd(&rebuilt, &["exec", "-T", "app", "cat", "/data/marker"])
                .unwrap()
                .trim(),
            "kept",
            "volumes survive a rebuild"
        );

        // The host stops what nothing needs; data stays for the next start.
        assert!(store.host_stop("chat:a", "nothing needs it").unwrap());
        let stopped = store.snapshot().unwrap().environments["chat:a"].clone();
        assert_eq!(stopped.state, "stopped");
        assert_eq!(stopped.stopped.as_ref().unwrap().by, "host");
        assert!(store.live_keys().is_empty());
        let again = store.host_action("chat:a", "start").unwrap();
        assert_eq!(
            compose_cmd(&again, &["exec", "-T", "app", "cat", "/data/marker"])
                .unwrap()
                .trim(),
            "kept"
        );
        compose_cmd(&again, &["down", "--volumes"]).unwrap();
        fs::remove_dir_all(store.root).unwrap();
    }
}
