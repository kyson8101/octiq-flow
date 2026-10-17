//! Long-running jobs an agent started, and how far each has got
//! (`docs/jobs.md`).
//!
//! A job comes in two ways. `octiq-job` (`job_wrapper.rs`) wraps a command
//! and reports its start, its progress and its end over `/hook/job`. Or an
//! agent registers a process that is already running (`job_register`): the
//! host then watches its pid, and reads its log file or progress file when
//! it names one. Either way the page reads `chat_jobs` and hears `chat-job`.
//!
//! **Progress is the job's word and nothing else.** `done` and `total` are
//! set only from what the job printed or wrote (`job_progress`), never from
//! a rate or the time it has taken.
//!
//! **A finished job wakes its agent once.** Its end hands the chat's agent
//! one host turn under `octiq-job-<id>`, a function of the job, and the
//! chat's record is asked first (`agent_chat::host_turns`), so a turn that
//! was handed over is never handed over again, across a restart too. The
//! turn waits like any message behind a running turn, and a chat with no
//! process is started with it from the settings it last ran with. A worker
//! whose attempt has settled is not woken: its coordinator is, with the
//! task named.
//!
//! A running job holds off the idle reaper. A server restart cannot follow a
//! job it started (the wrapper's token and the pid watch are in memory), so
//! every job still running at load is marked interrupted, and its chat is
//! told.

use crate::job_progress::{Format, Parser, Progress, Splitter, Tail};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::{BTreeMap, BTreeSet};
use std::path::PathBuf;
use std::sync::Mutex;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

/// What `profile_status.owed` calls a jobs file that is behind.
pub(crate) const OWED: &str = "jobs";
/// The id of the host turn that wakes an agent: this, then the job's id.
pub(crate) const WAKE_PREFIX: &str = "octiq-job-";
/// The least time between two `chat-job` events of one job.
const EMIT_EVERY: Duration = Duration::from_millis(500);
/// How long `chat_jobs` with no chat keeps answering a job that ended.
const RECENT_MS: u64 = 10 * 60 * 1000;
/// How long a job that ended, and whose wake is told, stays in the file.
const KEEP_MS: u64 = 7 * 24 * 3600 * 1000;
/// How many jobs one chat may have running at once.
const RUNNING_MAX: usize = 32;
/// The longest label, command, reason and phase kept.
const LABEL_MAX: usize = 120;
const COMMAND_MAX: usize = 600;
const TEXT_MAX: usize = 400;
/// How much of a registered job's log is read in one look.
const LOG_READ_MAX: u64 = 256 * 1024;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub(crate) enum Source {
    Wrapper,
    Registered,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub(crate) enum Status {
    Running,
    Done,
    Failed,
    Ended,
    Interrupted,
}

/// Where the turn that wakes the agent stands.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub(crate) enum Wake {
    /// The job asked for none, or it has not ended.
    None,
    /// To be handed over.
    Owed,
    /// Handed over, or found in the record: never sent again.
    Told,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Job {
    id: String,
    chat_key: String,
    label: String,
    source: Source,
    status: Status,
    #[serde(flatten)]
    progress: Progress,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    exit_code: Option<i32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    signal: Option<i32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    command: Option<String>,
    wake: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    reason: Option<String>,
    /// Host clock, milliseconds since the epoch. Never sent to the page.
    started_at: u64,
    updated_at: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    ended_at: Option<u64>,
    /// The process the host watches: a registered job's own, or the
    /// wrapper's, whose going without an end report interrupts the job.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pid: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    log_file: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pattern: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    progress_file: Option<String>,
    /// The wrapper's last lines of output, for the wake turn.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    tail: Vec<String>,
    #[serde(default = "no_wake")]
    wake_turn: Wake,
}

fn no_wake() -> Wake {
    Wake::None
}

impl Job {
    fn running(&self) -> bool {
        self.status == Status::Running
    }

    /// The job as the page reads it (the contract in `docs/jobs.md`).
    /// `elapsedMs` and `sinceUpdateMs` are as of `now`, the moment the host
    /// sends; the page counts on from receipt on its own clock.
    pub(crate) fn view(&self, now: u64) -> Value {
        let end = self.ended_at.unwrap_or(now);
        let mut view = json!({
            "id": self.id,
            "chatKey": self.chat_key,
            "label": self.label,
            "source": self.source,
            "status": self.status,
            "elapsedMs": end.saturating_sub(self.started_at),
            "sinceUpdateMs": now.saturating_sub(self.updated_at),
            "wake": self.wake,
        });
        if let Some(phase) = &self.progress.phase {
            view["phase"] = json!(phase);
        }
        // Both or neither: a count with no total is not progress.
        if let (Some(done), Some(total)) = (self.progress.done, self.progress.total) {
            view["done"] = json!(done);
            view["total"] = json!(total);
            if let Some(unit) = self.progress.unit {
                view["unit"] = json!(unit);
            }
        }
        if !self.running() {
            view["exitCode"] = json!(self.exit_code);
        }
        if let Some(command) = &self.command {
            view["command"] = json!(command);
        }
        if let Some(reason) = &self.reason {
            view["reason"] = json!(reason);
        }
        view
    }
}

/// What the host keeps in memory only for a job it is following.
struct Follow {
    /// The wrapper's token, which carries its progress and its end.
    token: Option<String>,
    /// A registered job's log, read on from where the last look stopped.
    log: Option<LogWatch>,
    /// A progress file's text as last read.
    file_text: Option<String>,
    last_emit: Option<Instant>,
    /// Changed since the last `chat-job`.
    unsaid: bool,
}

struct LogWatch {
    offset: u64,
    parser: Parser,
    splitter: Splitter,
    tail: Tail,
}

#[derive(Default)]
struct Inner {
    jobs: BTreeMap<String, Job>,
    follow: BTreeMap<String, Follow>,
    /// The file is behind what is held here (`settle`).
    owes: bool,
    /// Wake turns this server handed over itself (`host_turns`' `here`).
    handed: BTreeSet<String>,
}

#[derive(Default)]
pub(crate) struct Store {
    path: Option<PathBuf>,
    inner: Mutex<Inner>,
    load_error: Option<String>,
    /// One delivery of wake turns at a time, so two never ask the record
    /// about the same turn at once.
    waking: Mutex<()>,
}

/// What a wrapper says as it starts.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Start {
    #[serde(default)]
    label: Option<String>,
    #[serde(default)]
    command: Option<String>,
    #[serde(default = "yes")]
    wake: bool,
    #[serde(default)]
    wrapper_pid: Option<u32>,
}

/// What `job_register` gives for a process already running.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Register {
    label: String,
    pid: u32,
    #[serde(default)]
    log_file: Option<String>,
    #[serde(default)]
    pattern: Option<String>,
    #[serde(default)]
    progress_file: Option<String>,
    #[serde(default = "yes")]
    wake: bool,
}

fn yes() -> bool {
    true
}

/// How a wrapper says its command ended.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct End {
    #[serde(default)]
    exit_code: Option<i32>,
    #[serde(default)]
    signal: Option<i32>,
    #[serde(default)]
    tail: Vec<String>,
}

pub(crate) fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or_default()
}

fn clean(text: &str, max: usize) -> String {
    let text: String = text
        .chars()
        .map(|c| if c.is_control() { ' ' } else { c })
        .collect();
    let text = text.trim();
    if text.chars().count() <= max {
        return text.to_string();
    }
    let mut cut: String = text.chars().take(max).collect();
    cut.push('…');
    cut
}

impl Store {
    /// Read the jobs file. A job still running is one this server cannot
    /// follow: it is marked interrupted, and its chat is told.
    pub(crate) fn load(path: PathBuf) -> Self {
        let mut store = Self {
            path: Some(path.clone()),
            ..Self::default()
        };
        let read = crate::profile::read(&path, |e| format!("the jobs file could not be read: {e}"))
            .and_then(|bytes| match bytes {
                Some(bytes) => serde_json::from_slice::<BTreeMap<String, Job>>(&bytes)
                    .map_err(|e| format!("the jobs file could not be understood: {e}")),
                None => Ok(BTreeMap::new()),
            });
        let mut jobs = match read {
            Ok(jobs) => jobs,
            Err(error) => {
                eprintln!("[jobs] {error}");
                store.load_error = Some(error);
                return store;
            }
        };
        let now = now_ms();
        // By chat: the ids and the labels of the jobs this server cannot follow.
        let mut interrupted = BTreeMap::<String, Vec<(String, String)>>::new();
        for job in jobs.values_mut().filter(|job| job.running()) {
            job.status = Status::Interrupted;
            job.reason = Some(
                "OctiqFlow restarted while this job was running, and cannot follow it any more. It may still be running, or have finished: check its output before starting it again.".into(),
            );
            job.ended_at = Some(now);
            job.updated_at = now;
            interrupted
                .entry(job.chat_key.clone())
                .or_default()
                .push((job.id.clone(), job.label.clone()));
        }
        // What is old and told is not kept for ever.
        jobs.retain(|_, job| {
            job.running()
                || job.wake_turn == Wake::Owed
                || job
                    .ended_at
                    .is_none_or(|ended| now.saturating_sub(ended) < KEEP_MS)
        });
        store
            .inner
            .get_mut()
            .unwrap_or_else(|e| e.into_inner())
            .jobs = jobs;
        if !interrupted.is_empty() {
            if let Err(error) = store.save_locked() {
                eprintln!("[jobs] {error}");
            }
            for (chat, jobs) in interrupted {
                let (ids, labels): (Vec<String>, Vec<String>) = jobs.into_iter().unzip();
                crate::agent_chat::record_chat_event(
                    &chat,
                    json!({
                        "type": "octiq_job_interrupted",
                        "job_ids": ids,
                        "message": format!(
                            "OctiqFlow restarted while {} job(s) ran and can no longer follow them: {}. Check their output before starting them again.",
                            labels.len(),
                            labels.join(", ")
                        ),
                    }),
                );
            }
        }
        store
    }

    /// Write the file from what is held, and say whether it still owes.
    fn save_locked(&mut self) -> Result<(), String> {
        let inner = self.inner.get_mut().map_err(|e| e.to_string())?;
        let saved = write(self.path.as_ref(), self.load_error.as_deref(), &inner.jobs);
        inner.owes = saved.is_err();
        saved
    }

    fn save(&self, inner: &mut Inner) {
        let saved = write(self.path.as_ref(), self.load_error.as_deref(), &inner.jobs);
        inner.owes = saved.is_err();
        if let Err(why) = saved {
            crate::unsaved::say("jobs", why);
        }
    }

    /// Write again what could not be written (`dispatch::settle_owed`).
    pub(crate) fn settle(&self) -> Result<(), String> {
        let mut inner = self.inner.lock().map_err(|e| e.to_string())?;
        if !inner.owes {
            return Ok(());
        }
        let saved = write(self.path.as_ref(), self.load_error.as_deref(), &inner.jobs);
        inner.owes = saved.is_err();
        saved
    }

    pub(crate) fn owes(&self) -> bool {
        self.inner.lock().is_ok_and(|inner| inner.owes)
    }

    /// Whether this chat has a job running, which holds off the idle reaper.
    pub(crate) fn has_running(&self, chat: &str) -> bool {
        self.inner.lock().is_ok_and(|inner| {
            inner
                .jobs
                .values()
                .any(|job| job.chat_key == chat && job.running())
        })
    }

    /// A wrapper's start. Answers the job's id and the token its progress
    /// and its end carry.
    pub(crate) fn start(&self, chat: &str, start: Start) -> Result<(Value, String), String> {
        let command = start
            .command
            .as_deref()
            .map(|c| clean(c, COMMAND_MAX))
            .filter(|c| !c.is_empty());
        let label = start
            .label
            .as_deref()
            .map(|l| clean(l, LABEL_MAX))
            .filter(|l| !l.is_empty())
            .or_else(|| command.as_deref().map(|c| clean(c, LABEL_MAX)))
            .unwrap_or_else(|| "Job".into());
        let token = uuid::Uuid::new_v4().simple().to_string();
        let job = self.add(
            chat,
            label,
            Source::Wrapper,
            command,
            start.wake,
            start.wrapper_pid,
            Follow {
                token: Some(token.clone()),
                log: None,
                file_text: None,
                last_emit: None,
                unsaid: false,
            },
            |_| {},
        )?;
        Ok((job, token))
    }

    /// A process already running, which the host watches.
    pub(crate) fn register(&self, chat: &str, register: Register) -> Result<Value, String> {
        let label = clean(&register.label, LABEL_MAX);
        if label.is_empty() {
            return Err("job_register needs a label".into());
        }
        if register.pid == 0 {
            return Err("job_register needs the pid of the running process".into());
        }
        let format = Format::parse(register.pattern.as_deref().unwrap_or("auto"))?;
        let absolute = |path: &Option<String>, what: &str| -> Result<Option<String>, String> {
            match path.as_deref().map(str::trim).filter(|p| !p.is_empty()) {
                Some(path) if std::path::Path::new(path).is_absolute() => Ok(Some(path.into())),
                Some(_) => Err(format!("{what} must be an absolute path")),
                None => Ok(None),
            }
        };
        let log_file = absolute(&register.log_file, "logFile")?;
        let progress_file = absolute(&register.progress_file, "progressFile")?;
        // A log is read from where it ends now: what it already holds says
        // where the job was, not where it is going.
        let log = log_file.as_ref().map(|path| LogWatch {
            offset: std::fs::metadata(path).map(|m| m.len()).unwrap_or(0),
            parser: Parser::new(format),
            splitter: Splitter::default(),
            tail: Tail::new(crate::job_wrapper::TAIL_LINES),
        });
        let pattern = register.pattern.clone();
        self.add(
            chat,
            label,
            Source::Registered,
            None,
            register.wake,
            Some(register.pid),
            Follow {
                token: None,
                log,
                file_text: None,
                last_emit: None,
                unsaid: false,
            },
            move |job| {
                job.log_file = log_file;
                job.progress_file = progress_file;
                job.pattern = pattern;
            },
        )
    }

    #[allow(clippy::too_many_arguments)]
    fn add(
        &self,
        chat: &str,
        label: String,
        source: Source,
        command: Option<String>,
        wake: bool,
        pid: Option<u32>,
        follow: Follow,
        fill: impl FnOnce(&mut Job),
    ) -> Result<Value, String> {
        // A job is a record the person reads and the agent is woken from:
        // not started while it cannot be kept.
        crate::profile::available()?;
        let mut inner = self.inner.lock().map_err(|e| e.to_string())?;
        let running = inner
            .jobs
            .values()
            .filter(|job| job.chat_key == chat && job.running())
            .count();
        if running >= RUNNING_MAX {
            return Err(format!(
                "this chat already has {RUNNING_MAX} jobs running; wait for one to end"
            ));
        }
        let now = now_ms();
        let mut job = Job {
            id: uuid::Uuid::new_v4().simple().to_string(),
            chat_key: chat.into(),
            label,
            source,
            status: Status::Running,
            progress: Progress::default(),
            exit_code: None,
            signal: None,
            command,
            wake,
            reason: None,
            started_at: now,
            updated_at: now,
            ended_at: None,
            pid,
            log_file: None,
            pattern: None,
            progress_file: None,
            tail: Vec::new(),
            wake_turn: Wake::None,
        };
        fill(&mut job);
        let view = job.view(now);
        inner.follow.insert(job.id.clone(), follow);
        inner.jobs.insert(job.id.clone(), job);
        self.save(&mut inner);
        drop(inner);
        say(&view);
        Ok(view)
    }

    /// The job a wrapper's token speaks for, if it is that job's.
    fn by_token<'a>(inner: &'a mut Inner, id: &str, token: &str) -> Result<&'a mut Job, String> {
        let matches = inner
            .follow
            .get(id)
            .and_then(|follow| follow.token.as_deref())
            .is_some_and(|known| crate::web::same_secret(known, token));
        if !matches {
            return Err("unknown job, or not this caller's".into());
        }
        inner
            .jobs
            .get_mut(id)
            .ok_or_else(|| "unknown job, or not this caller's".into())
    }

    /// A wrapper's progress report.
    pub(crate) fn progress(&self, id: &str, token: &str, progress: Progress) -> Result<(), String> {
        let mut inner = self.inner.lock().map_err(|e| e.to_string())?;
        let job = Self::by_token(&mut inner, id, token)?;
        if !job.running() {
            return Ok(());
        }
        let progress = checked(progress);
        let view = update(job, progress);
        Self::said(&mut inner, id, view);
        Ok(())
    }

    /// A wrapper's end report: how its command ended and its last lines.
    pub(crate) fn end(&self, id: &str, token: &str, end: End) -> Result<(), String> {
        let mut inner = self.inner.lock().map_err(|e| e.to_string())?;
        let job = Self::by_token(&mut inner, id, token)?;
        if !job.running() {
            return Ok(());
        }
        job.status = if end.exit_code == Some(0) {
            Status::Done
        } else {
            Status::Failed
        };
        job.exit_code = end.exit_code;
        job.signal = end.signal.filter(|_| end.exit_code.is_none());
        job.tail = end
            .tail
            .iter()
            .rev()
            .take(crate::job_wrapper::TAIL_LINES)
            .rev()
            .map(|line| clean(line, TEXT_MAX))
            .collect();
        self.finish(&mut inner, id);
        Ok(())
    }

    /// Mark a job that is over as ended and owe its wake, say it, save it.
    fn finish(&self, inner: &mut Inner, id: &str) {
        let now = now_ms();
        let Some(job) = inner.jobs.get_mut(id) else {
            return;
        };
        job.ended_at = Some(now);
        job.updated_at = now;
        if job.wake {
            job.wake_turn = Wake::Owed;
        }
        let view = job.view(now);
        inner.follow.remove(id);
        self.save(inner);
        say(&view);
    }

    /// Note a change, and say it unless one was said too lately.
    fn said(inner: &mut Inner, id: &str, view: Value) {
        let Some(follow) = inner.follow.get_mut(id) else {
            return;
        };
        if follow
            .last_emit
            .is_some_and(|last| last.elapsed() < EMIT_EVERY)
        {
            follow.unsaid = true;
            return;
        }
        follow.last_emit = Some(Instant::now());
        follow.unsaid = false;
        say(&view);
    }

    /// One look over what the host follows: registered pids that ended,
    /// wrappers that went without an end, logs and progress files that grew,
    /// and changes not said yet. `alive` asks after a pid.
    pub(crate) fn look(&self, alive: &dyn Fn(u32) -> bool) {
        let Ok(mut inner) = self.inner.lock() else {
            return;
        };
        let running: Vec<String> = inner
            .jobs
            .values()
            .filter(|job| job.running())
            .map(|job| job.id.clone())
            .collect();
        for id in running {
            let Some(job) = inner.jobs.get(&id).cloned() else {
                continue;
            };
            // Progress first, so a job's last lines are read before its end.
            let mut read = None;
            if let Some(path) = &job.progress_file {
                let text = std::fs::read_to_string(path).ok();
                let follow = inner.follow.get_mut(&id);
                if let (Some(text), Some(follow)) = (text, follow) {
                    if follow.file_text.as_deref() != Some(text.as_str()) {
                        read = crate::job_progress::progress_file(&text);
                        follow.file_text = Some(text);
                    }
                }
            }
            if let (Some(path), Some(watch)) = (
                &job.log_file,
                inner.follow.get_mut(&id).and_then(|f| f.log.as_mut()),
            ) {
                let from_log = read_log(path, watch);
                if job.progress_file.is_none() {
                    read = from_log.or(read);
                }
            }
            if let Some(progress) = read {
                if let Some(job) = inner.jobs.get_mut(&id) {
                    let view = update(job, checked(progress));
                    Self::said(&mut inner, &id, view);
                }
            }
            if job.pid.is_some_and(|pid| !alive(pid)) {
                let tail = inner
                    .follow
                    .get(&id)
                    .and_then(|f| f.log.as_ref())
                    .map(|watch| watch.tail.lines())
                    .unwrap_or_default();
                if let Some(job) = inner.jobs.get_mut(&id) {
                    match job.source {
                        Source::Registered => {
                            job.status = Status::Ended;
                            job.reason = Some("The process exited; OctiqFlow did not start it, so its exit code is unknown.".into());
                            job.tail = tail;
                        }
                        Source::Wrapper => {
                            job.status = Status::Interrupted;
                            job.reason = Some("octiq-job stopped without saying how the command ended: it was killed, or could not reach OctiqFlow. The command may still be running.".into());
                        }
                    }
                }
                self.finish(&mut inner, &id);
            }
        }
        // What a throttle held back.
        let now = now_ms();
        let unsaid: Vec<String> = inner
            .follow
            .iter()
            .filter(|(_, f)| f.unsaid && f.last_emit.is_none_or(|t| t.elapsed() >= EMIT_EVERY))
            .map(|(id, _)| id.clone())
            .collect();
        for id in unsaid {
            if let Some(view) = inner.jobs.get(&id).map(|job| job.view(now)) {
                Self::said(&mut inner, &id, view);
            }
        }
    }

    /// `chat_jobs`: one chat's jobs, or, with no chat, every chat's running
    /// jobs and those that ended in the last ten minutes. Newest first.
    pub(crate) fn list(&self, chat: Option<&str>) -> Vec<Value> {
        let now = now_ms();
        let Ok(inner) = self.inner.lock() else {
            return Vec::new();
        };
        let mut jobs: Vec<&Job> = inner
            .jobs
            .values()
            .filter(|job| match chat {
                Some(chat) => job.chat_key == chat,
                None => {
                    job.running()
                        || job
                            .ended_at
                            .is_some_and(|ended| now.saturating_sub(ended) < RECENT_MS)
                }
            })
            .collect();
        jobs.sort_by(|a, b| b.started_at.cmp(&a.started_at));
        jobs.into_iter().map(|job| job.view(now)).collect()
    }

    /// The jobs whose wake is owed, oldest end first.
    fn owed_wakes(&self) -> Vec<Job> {
        let Ok(inner) = self.inner.lock() else {
            return Vec::new();
        };
        let mut owed: Vec<Job> = inner
            .jobs
            .values()
            .filter(|job| job.wake_turn == Wake::Owed)
            .cloned()
            .collect();
        owed.sort_by_key(|job| job.ended_at);
        owed
    }

    fn handed_here(&self, id: &str) -> bool {
        self.inner
            .lock()
            .is_ok_and(|inner| inner.handed.contains(id))
    }

    /// The wake of `id` is told: handed over now or found in a record.
    fn told(&self, id: &str, here: bool) {
        let Ok(mut inner) = self.inner.lock() else {
            return;
        };
        if here {
            inner.handed.insert(id.to_string());
        }
        if let Some(job) = inner.jobs.get_mut(id) {
            job.wake_turn = Wake::Told;
            self.save(&mut inner);
        }
    }
}

fn write(
    path: Option<&PathBuf>,
    load_error: Option<&str>,
    jobs: &BTreeMap<String, Job>,
) -> Result<(), String> {
    let Some(path) = path else {
        return Ok(());
    };
    // A file that could not be read is not written over.
    if let Some(error) = load_error {
        return Err(error.to_string());
    }
    if let Some(parent) = path.parent() {
        crate::profile::make_dir(parent)?;
    }
    let temp = path.with_extension(format!("{}.tmp", uuid::Uuid::new_v4().simple()));
    let bytes = serde_json::to_vec(jobs).map_err(|e| e.to_string())?;
    std::fs::write(&temp, bytes).map_err(|e| crate::profile::write_error(&temp, e))?;
    std::fs::rename(&temp, path).map_err(|e| {
        let _ = std::fs::remove_file(&temp);
        crate::profile::write_error(path, e)
    })
}

/// Only what a page can draw: a phase of words, and counts that hold.
fn checked(progress: Progress) -> Progress {
    let phase = progress
        .phase
        .map(|phase| clean(&phase, 80))
        .filter(|phase| !phase.is_empty());
    let counted = match (progress.done, progress.total) {
        (Some(done), Some(total))
            if done.is_finite()
                && total.is_finite()
                && total > 0.0
                && (0.0..=total).contains(&done) =>
        {
            Some((done, total))
        }
        _ => None,
    };
    Progress {
        phase,
        done: counted.map(|c| c.0),
        total: counted.map(|c| c.1),
        unit: counted.and(progress.unit),
    }
}

/// Take a reading into a job. A reading with no counts keeps the counts the
/// job last gave unless its phase changed: a new phase's counts are its own.
fn update(job: &mut Job, progress: Progress) -> Value {
    let now = now_ms();
    let phase_changed = progress.phase.is_some() && progress.phase != job.progress.phase;
    if progress.done.is_some() || phase_changed {
        job.progress.done = progress.done;
        job.progress.total = progress.total;
        job.progress.unit = progress.unit;
    }
    if progress.phase.is_some() {
        job.progress.phase = progress.phase;
    }
    job.updated_at = now;
    job.view(now)
}

/// Read what a registered job's log gained since the last look.
fn read_log(path: &str, watch: &mut LogWatch) -> Option<Progress> {
    use std::io::{Read, Seek, SeekFrom};
    let mut file = std::fs::File::open(path).ok()?;
    let len = file.metadata().ok()?.len();
    if len < watch.offset {
        // Truncated or replaced: read it from the start.
        watch.offset = 0;
    }
    if len == watch.offset {
        return None;
    }
    file.seek(SeekFrom::Start(watch.offset)).ok()?;
    let mut bytes = Vec::new();
    file.take(LOG_READ_MAX).read_to_end(&mut bytes).ok()?;
    watch.offset += bytes.len() as u64;
    let mut last = None;
    for segment in watch.splitter.feed(&bytes) {
        watch.tail.push(&segment);
        if let Some(progress) = watch.parser.line(&segment.text) {
            last = Some(progress);
        }
    }
    last
}

/// Tell every open page a job changed.
fn say(view: &Value) {
    crate::bus::emit(
        "chat-job",
        json!({ "chatKey": view["chatKey"], "job": view }),
    );
}

/// What the first line of a wake turn starts with.
pub(crate) const WAKE_TAG: &str = "[OctiqFlow job ended]";

/// The facts on a wake turn's first line, after the tag and one space: one
/// line of JSON, in this order, so the page can name a job it no longer
/// holds. Made from the stored job alone, so every try says the same.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct WakeFacts<'a> {
    id: &'a str,
    label: &'a str,
    status: Status,
    exit_code: Option<i32>,
}

fn wake_facts(job: &Job) -> String {
    serde_json::to_string(&WakeFacts {
        id: &job.id,
        label: &job.label,
        status: job.status,
        exit_code: job.exit_code,
    })
    .expect("a job's facts serialise")
}

/// The words of the turn that wakes an agent when a job ends.
fn wake_text(job: &Job, about_task: Option<&str>) -> String {
    let seconds = job
        .ended_at
        .unwrap_or(job.updated_at)
        .saturating_sub(job.started_at)
        / 1000;
    let took = if seconds >= 3600 {
        format!("{}h {}m", seconds / 3600, (seconds % 3600) / 60)
    } else if seconds >= 60 {
        format!("{}m {}s", seconds / 60, seconds % 60)
    } else {
        format!("{seconds}s")
    };
    let how = match job.status {
        Status::Done => "finished: exit code 0".to_string(),
        Status::Failed => match (job.exit_code, job.signal) {
            (Some(code), _) => format!("failed: exit code {code}"),
            (None, Some(signal)) => format!("failed: ended by signal {signal}, no exit code"),
            (None, None) => "failed: no exit code".to_string(),
        },
        Status::Ended => "ended: its process exited, exit code unknown".to_string(),
        Status::Interrupted => "was interrupted".to_string(),
        Status::Running => "is still running".to_string(),
    };
    let mut text = format!(
        "{} {}\nThe job \"{}\" {how}, after {took}.",
        WAKE_TAG,
        wake_facts(job),
        job.label
    );
    if let Some(task) = about_task {
        text.push_str(&format!("\n{task}"));
    }
    if let Some(command) = &job.command {
        text.push_str(&format!("\nCommand: {command}"));
    }
    if let Some(log) = &job.log_file {
        text.push_str(&format!("\nLog: {log}"));
    }
    if let Some(reason) = &job.reason {
        text.push_str(&format!("\n{reason}"));
    }
    if !job.tail.is_empty() {
        text.push_str(&format!(
            "\nLast {} line(s) of output:\n```\n{}\n```",
            job.tail.len(),
            job.tail.join("\n").replace("```", "'''")
        ));
    }
    text.push_str("\nThis is a host notification, not a new instruction from the person. Check the job's result, then carry on with what you were doing.");
    text
}

/// Where a job's wake goes, and what it says of the task: the chat that
/// started it, unless that is a worker whose attempt has settled, when it
/// is that worker's coordinator, with the task named.
fn wake_target(
    orchestrations: &crate::orchestration::OrchestrationStore,
    chat: &str,
) -> Result<(String, Option<String>), String> {
    if !orchestrations.is_worker_chat(chat)? || orchestrations.active_task(chat)?.is_some() {
        return Ok((chat.to_string(), None));
    }
    let Some(coordinator) = orchestrations
        .worker_coordinator(chat)?
        .filter(|key| !key.is_empty())
    else {
        return Ok((chat.to_string(), None));
    };
    let task = orchestrations
        .worker_task(chat)
        .map(|(task_id, run_id, title)| {
            format!(
                "It was started by the worker of task \"{title}\" ({task_id}, run {run_id}), whose attempt has since settled, so you are told instead."
            )
        })
        .unwrap_or_else(|| {
            "It was started by a worker of yours whose attempt has since settled, so you are told instead.".into()
        });
    Ok((coordinator, Some(task)))
}

/// Hand every owed wake over, each once. A wake that cannot be handed over
/// yet (no process and no settings to start one, the profile folder away)
/// stays owed for the next pass.
pub(crate) fn deliver_wakes(manager: &std::sync::Arc<crate::agent_chat::ChatManager>) {
    use crate::agent_chat::HostTurn;
    let store = &manager.jobs;
    let Ok(_one) = store.waking.try_lock() else {
        return;
    };
    for job in store.owed_wakes() {
        let turn_id = format!("{WAKE_PREFIX}{}", job.id);
        let (target, about) = match wake_target(&manager.orchestrations, &job.chat_key) {
            Ok(target) => target,
            Err(_) => continue,
        };
        let here = store.handed_here(&turn_id).then_some(turn_id.as_str());
        // Asked of the chat that started the job too, when the turn goes
        // elsewhere: a wake it was handed before its attempt settled is
        // still a wake that was handed.
        let mut seen: Option<HostTurn> = None;
        let mut unread = false;
        for chat in
            std::iter::once(&target).chain((target != job.chat_key).then_some(&job.chat_key))
        {
            match crate::agent_chat::host_turns(manager, chat, &turn_id, here) {
                Ok(turns) => {
                    if let Some(fate) = turns.get(&turn_id) {
                        seen = Some(*fate);
                        break;
                    }
                }
                Err(_) => unread = true,
            }
        }
        // A record that could not be read is not a turn never handed over.
        if unread && seen.is_none() {
            continue;
        }
        if seen.is_some() {
            // Handed over, or taken back by the person or lost: either way
            // it was told once, and is not told again.
            store.told(&job.id, false);
            continue;
        }
        let text = wake_text(&job, about.as_deref());
        match crate::agent_chat::wake_chat(manager, &target, &turn_id, &text) {
            Ok(crate::agent_chat::Woken::Handed) => store.told(&job.id, true),
            Ok(crate::agent_chat::Woken::Gone) => store.told(&job.id, false),
            Ok(crate::agent_chat::Woken::Later(_)) | Err(_) => {}
        }
    }
}

/// The background thread that follows jobs: pids, logs and progress files,
/// held-back events, and owed wakes. Once a second.
#[cfg(not(test))]
pub(crate) fn start_watcher(manager: std::sync::Arc<crate::agent_chat::ChatManager>) {
    std::thread::spawn(move || loop {
        std::thread::sleep(Duration::from_secs(1));
        manager.jobs.look(&crate::profile_lock::alive);
        deliver_wakes(&manager);
    });
}

/// What the agent's environment is given so its shells reach `octiq-job`:
/// `OCTIQ_JOB` (the launcher's path), `OCTIQ_JOB_SESSION` (the session the
/// capability was issued to, under a name Codex does not hide from the
/// commands it runs), and `PATH` with the launcher's folder first. Empty
/// when the launcher could not be written; a chat starts all the same.
pub(crate) fn agent_env(session_key: &str, path: Option<String>) -> Vec<(String, String)> {
    let Some(launcher) = launcher() else {
        return Vec::new();
    };
    let mut env = vec![
        (
            "OCTIQ_JOB".to_string(),
            launcher.to_string_lossy().into_owned(),
        ),
        ("OCTIQ_JOB_SESSION".to_string(), session_key.to_string()),
    ];
    if let Some(dir) = launcher.parent() {
        let mut dirs = vec![dir.to_path_buf()];
        dirs.extend(std::env::split_paths(&path.unwrap_or_default()));
        if let Ok(joined) = std::env::join_paths(dirs) {
            env.push(("PATH".into(), joined.to_string_lossy().into_owned()));
        }
    }
    env
}

/// `~/.octiqflow/bin/octiq-job`: a script that runs `octiq-server job` from
/// the binary of the server that wrote it (and `octiq-job.cmd` beside it on
/// Windows). Written when missing or out of date, so a server moved or
/// rebuilt elsewhere points its agents at itself.
pub(crate) fn launcher() -> Option<PathBuf> {
    static WRITING: Mutex<()> = Mutex::new(());
    let _one = WRITING.lock().ok()?;
    let exe = std::env::current_exe().ok()?;
    let dir = crate::paths::home_dir()?.join(".octiqflow").join("bin");
    let script = dir.join("octiq-job");
    let mut files = vec![(
        script.clone(),
        sh_launcher(&exe.to_string_lossy(), cfg!(windows)),
    )];
    if cfg!(windows) {
        files.push((
            dir.join("octiq-job.cmd"),
            cmd_launcher(&exe.to_string_lossy()),
        ));
    }
    for (path, text) in files {
        if std::fs::read_to_string(&path).ok().as_deref() == Some(text.as_str()) {
            continue;
        }
        if let Err(why) = crate::profile::make_dir(&dir).and_then(|()| {
            std::fs::write(&path, &text).map_err(|e| format!("{}: {e}", path.display()))
        }) {
            eprintln!("[jobs] the octiq-job launcher could not be written: {why}");
            return None;
        }
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let _ = std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o755));
        }
    }
    Some(script)
}

/// The POSIX launcher. On Windows it is run by Git Bash, which reads a
/// drive path as `/c/…`.
pub(crate) fn sh_launcher(exe: &str, windows: bool) -> String {
    let exe = if windows {
        let forward = exe.replace('\\', "/");
        match forward.as_bytes() {
            [drive, b':', b'/', ..] if drive.is_ascii_alphabetic() => {
                format!(
                    "/{}{}",
                    (*drive as char).to_ascii_lowercase(),
                    &forward[2..]
                )
            }
            _ => forward,
        }
    } else {
        exe.to_string()
    };
    format!(
        "#!/bin/sh\n# Written by OctiqFlow: octiq-job, run by the server that wrote it.\nexec '{}' job \"$@\"\n",
        exe.replace('\'', "'\\''")
    )
}

/// The `cmd` launcher, for PowerShell and cmd on Windows.
pub(crate) fn cmd_launcher(exe: &str) -> String {
    format!("@echo off\r\nrem Written by OctiqFlow: octiq-job, run by the server that wrote it.\r\n\"{exe}\" job %*\r\n")
}

#[cfg(test)]
#[path = "chat_jobs_tests.rs"]
mod tests;
