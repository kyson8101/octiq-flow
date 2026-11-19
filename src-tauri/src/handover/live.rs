use super::*;

/// The address the browser reaches this server on, for chat links.
fn live_base_url() -> Option<String> {
    crate::web::hook_port().map(|port| format!("http://127.0.0.1:{port}"))
}

/// Where the app keeps its handovers and its registry, and what starts their
/// chats: `Live` over the app's own services, unless a test stands a `Host`
/// of its own in.
#[derive(Clone)]
pub struct Wiring {
    pub store: PathBuf,
    pub team: PathBuf,
    pub host: Option<Arc<dyn Host + Send + Sync>>,
    /// Keeps a test's throwaway folder for as long as any copy is wired in.
    #[cfg(test)]
    pub _scratch: Option<Arc<crate::test_dir::TestDir>>,
}

impl Wiring {
    /// The profile's handovers over the running app.
    pub fn profile() -> Self {
        Self {
            store: default_path(),
            team: team::default_path(),
            host: None,
            #[cfg(test)]
            _scratch: None,
        }
    }

    /// Handovers and a registry of their own, in a throwaway folder.
    #[cfg(test)]
    pub fn scratch() -> Self {
        let dir = crate::test_dir::TestDir::new("handover");
        Self {
            store: dir.join("handovers.json"),
            team: dir.join("team.json"),
            host: None,
            _scratch: Some(Arc::new(dir)),
        }
    }
}

/// `Host` over the running app's services.
pub struct Live<'a>(pub &'a crate::dispatch::Services);

impl Host for Live<'_> {
    fn projects(&self) -> Result<Vec<Workspace>, String> {
        crate::workspaces::list_workspaces_impl(&self.0.workspaces)
    }

    fn team_path(&self) -> PathBuf {
        self.0.handovers.team.clone()
    }

    fn new_worktree(
        &self,
        repository: &str,
        branch: &str,
        prompt: &str,
        chat_id: &str,
    ) -> Result<crate::git_ops::PreparedWorkspace, String> {
        crate::git_ops::git_prepare_chat_workspace(
            repository.to_owned(),
            branch.to_owned(),
            true,
            prompt.to_owned(),
            chat_id.to_owned(),
        )
    }

    fn save_index(&self, meta: crate::chat_index::ChatMeta) -> Result<(), String> {
        crate::agent_chat::chat_index_save(meta)
    }

    fn start(&self, mut start: Start) -> Result<(), String> {
        let thread = crate::lead_threads::is_key(&start.key);
        if thread && self.0.chats.has_process(&start.key) {
            return crate::agent_chat::chat_send_user_impl(
                self.0.chats.clone(),
                start.key,
                start.prompt,
                Some(start.images),
                None,
                Some(start.turn_id),
                Some(true),
            );
        }
        let resume = if thread {
            let meta = crate::chat_index::find(start.key.trim_start_matches("chat:"))?
                .ok_or("The lead thread is not in the index.")?;
            let settings = crate::lead_threads::saved_settings(&meta)?;
            start.agent = settings.agent;
            start.model = settings.model;
            start.access = settings.access;
            start.effort = settings.effort;
            meta.session_id
        } else {
            None
        };
        let retry = thread.then(|| start.clone());
        match crate::agent_chat::chat_start_user_impl(
            self.0.chats.clone(),
            start.key,
            start.cwd,
            start.agent,
            start.model,
            Some(start.access),
            Some(start.prompt),
            None,
            resume,
            Some(start.extra_dirs),
            Some(start.env),
            start.effort,
            if thread { Some(start.images) } else { None },
            None,
            Some(start.turn_id),
        ) {
            // A retry after the start went through but the record did not:
            // the chat is there, which is all a confirm promises.
            Err(why) if why.contains("already running") && retry.is_some() => {
                let start = retry.unwrap();
                crate::agent_chat::chat_send_user_impl(
                    self.0.chats.clone(),
                    start.key,
                    start.prompt,
                    Some(start.images),
                    None,
                    Some(start.turn_id),
                    Some(true),
                )
            }
            Err(why) if why.contains("already running") => Ok(()),
            other => other,
        }
    }

    fn started(&self, key: &str, turn_id: &str) -> bool {
        crate::agent_chat::turn_was_started(key, turn_id)
    }

    fn chat_live(&self, key: &str) -> bool {
        self.0.chats.has_process(key)
    }

    fn checkout_free(&self, path: &str, except: &[&str]) -> Result<(), String> {
        // A worker writing here is no reason to refuse: the chat that starts
        // is told it writes beside it (`chat_workspace_access`). A workspace
        // being cleaned up still is.
        self.0
            .orchestrations
            .chat_workspace_access("handover", path, true)
            .map_err(|why| format!("{path} cannot be handed over: {why}"))?;
        if let Some(other) = self
            .0
            .chats
            .live_chats_in(path)
            .into_iter()
            .find(|key| !except.contains(&key.as_str()))
        {
            return Err(format!(
                "{path} is the working folder of another live chat ({other}). One writer at a time: stop that chat first, or name a different worktree."
            ));
        }
        Ok(())
    }

    fn turn_in_flight(&self, chat_key: &str) -> bool {
        self.0.chats.turn_in_flight(chat_key)
    }

    fn tell_source(
        &self,
        origin: &QuestionOrigin,
        text: String,
        turn_id: String,
    ) -> Result<(), String> {
        crate::agent_chat::continue_origin(self.0.chats.clone(), origin, text, turn_id)
    }

    fn base_url(&self) -> Option<String> {
        live_base_url()
    }

    fn session_of(&self, chat_key: &str) -> Option<String> {
        self.0.chats.provider_session(chat_key).or_else(|| {
            let id = chat_key.strip_prefix("chat:").unwrap_or(chat_key);
            crate::chat_index::list()
                .into_iter()
                .find(|c| c.id == id)
                .and_then(|c| c.session_id)
        })
    }

    fn answer(
        &self,
        turn: &back::AnswerTurn,
    ) -> Result<crate::orchestration::peer::HelperAnswer, String> {
        back::run(turn)
    }

    fn attachments_dir(&self) -> Result<PathBuf, String> {
        crate::agent_chat::attachments_dir()
    }

    fn remove_index(&self, chat_id: &str) -> Result<(), String> {
        crate::chat_index::remove(chat_id)?;
        crate::agent_chat::announce_index_change(chat_id, true);
        Ok(())
    }

    fn note_start_failed(&self, chat_key: &str, text: &str) {
        crate::agent_chat::record_start_failure(chat_key, text);
    }
}

/// The host a call runs against: the test's, or the running app.
pub(super) fn with_host<R>(svc: &crate::dispatch::Services, act: impl FnOnce(&dyn Host) -> R) -> R {
    match &svc.handovers.host {
        Some(host) => act(host.as_ref()),
        None => act(&Live(svc)),
    }
}

/// The source of a `handover` call, from what the host knows of the calling
/// chat: its capability-proven key, its index entry, its lead record and its
/// running turn.
pub fn live_source(
    svc: &crate::dispatch::Services,
    chat_key: &str,
    session_key: &str,
    launch_id: &str,
) -> Result<Source, String> {
    if chat_key.starts_with("chat:orch-") || svc.orchestrations.require_user_chat(chat_key).is_err()
    {
        return Err(WORKER_REFUSAL.into());
    }
    let origin = svc
        .chats
        .question_origin(chat_key, Some(session_key), Some(launch_id))?;
    let id = chat_key.strip_prefix("chat:").unwrap_or(chat_key);
    let meta = crate::chat_index::list().into_iter().find(|c| c.id == id);
    let cwd = meta
        .as_ref()
        .and_then(|m| m.cwd.clone())
        .unwrap_or_else(|| origin.cwd().to_owned());
    Ok(Source {
        chat_key: chat_key.into(),
        title: meta.as_ref().map(|m| m.title.clone()).unwrap_or_default(),
        project_id: meta.map(|m| m.project_id),
        lead: team::lead_for_chat(&svc.handovers.team, chat_key)?,
        origin,
        worker: false,
        cwd: Some(cwd).filter(|cwd| !cwd.is_empty()),
        coordinating: svc.orchestrations.live_run_coordinated_by(chat_key)?,
    })
}

/// A `handover` call from an agent's MCP: validate and record it, and say
/// whether it is new (a retry of the same requestId is not). The caller then
/// waits on it (`live_wait`) or answers at once (`answer_now`).
pub fn live_request(
    svc: &crate::dispatch::Services,
    chat_key: &str,
    session_key: &str,
    launch_id: &str,
    ask: Ask,
) -> Result<(Handover, bool), String> {
    let source = live_source(svc, chat_key, session_key, launch_id)?;
    let path = &svc.handovers.store;
    let known = {
        let _guard = LOCK.lock().map_err(|e| e.to_string())?;
        read(path)?
            .handovers
            .values()
            .any(|h| h.source_chat_key == chat_key && h.request_id == ask.request_id.trim())
    };
    let record = with_host(svc, |host| request(path, host, source, ask))?;
    Ok((record, !known))
}

/// A `route_chat` call from a front-desk chat. The caller has checked that
/// the chat IS one; this checks the rest and records the card.
pub fn live_route_request(
    svc: &crate::dispatch::Services,
    chat_key: &str,
    session_key: &str,
    launch_id: &str,
    ask: route::RouteAsk,
) -> Result<Handover, String> {
    let chat = team::front_desk_chat(&svc.handovers.team, chat_key)
        .ok_or("Only the front desk routes conversations.")?;
    let desk = team::list(&svc.handovers.team, None, true)?
        .into_iter()
        .find(|a| a.id == chat.agent_id)
        .ok_or("This front desk is no longer a registered agent. Start a new chat.")?;
    let origin = svc
        .chats
        .question_origin(chat_key, Some(session_key), Some(launch_id))?;
    let path = &svc.handovers.store;
    with_host(svc, |host| {
        route::request(
            path,
            host,
            route::RouteSource {
                chat_key: chat_key.to_owned(),
                desk,
                origin,
            },
            ask,
        )
    })
}

/// What a tool that does not wait is told: the decision when there is one
/// (and it now owns telling it), else that the decision will follow.
pub fn answer_now(wiring: &Wiring, id: &str) -> Result<String, String> {
    take(&wiring.store, id, live_base_url().as_deref())
}

pub async fn live_wait(wiring: &Wiring, id: String) -> Result<String, String> {
    wait(
        wiring.store.clone(),
        id,
        crate::question::ANSWER_TIMEOUT,
        live_base_url(),
    )
    .await
}

/// After a decision: wake the waiting tool, or send the decision to the
/// asking chat as a continuation turn and record how that went. `None` when
/// the tool has it or it was already told.
fn tell(path: &Path, id: &str, host: &dyn Host) -> Result<Option<Public>, String> {
    let Some(record) = hand_off_notice(path, id)? else {
        return Ok(None);
    };
    // The front desk's call returned at once and its chat is hidden: a
    // continuation would only wake it to say what the person already saw.
    if record.kind == Kind::Route {
        return Ok(None);
    }
    let outcome = match &record.origin {
        Some(origin) => {
            let (text, turn_id) = continuation(&record, host.base_url().as_deref());
            host.tell_source(origin, text, turn_id)
        }
        None => Err("The asking agent left no way back to it.".into()),
    };
    noticed(path, id, outcome)?;
    Ok(Some(get(path, id)?.public()))
}

/// What the person decided on a card.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Decision {
    Confirm,
    Decline,
    /// Give up on a confirmed handover whose chat could not be started.
    Abandon,
}

/// The person's decision, from their socket. Then the calling agent is told:
/// by its waiting tool, or by a continuation turn.
pub fn decide(
    svc: &crate::dispatch::Services,
    id: &str,
    decision: Decision,
) -> Result<Public, String> {
    let path = &svc.handovers.store;
    with_host(svc, |host| {
        let record = match decision {
            Decision::Confirm => confirm(path, id, host)?,
            Decision::Decline => decline(path, id)?,
            Decision::Abandon => abandon(path, id, host)?,
        };
        // A route tells nobody, and a cancelled one is already gone.
        if record.kind == Kind::Route {
            return Ok(record.public());
        }
        Ok(tell(path, id, host)?.unwrap_or_else(|| record.public()))
    })
}

/// At startup: finish the handovers a restart cut off after their chat had
/// started, and tell their asking agents (`recover`).
pub fn live_recover(svc: &crate::dispatch::Services) {
    let path = &svc.handovers.store;
    with_host(svc, |host| {
        let finished = match recover(path, host) {
            Ok(finished) => finished,
            Err(why) => return eprintln!("[handover] recovery: {why}"),
        };
        for id in finished {
            if let Err(why) = tell(path, &id, host) {
                eprintln!("[handover] {id}: {why}");
            }
        }
    });
}
