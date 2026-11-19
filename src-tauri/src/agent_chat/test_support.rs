use super::*;

/// Build one provider-owned command from the normalized chat request.
pub(super) fn build_command(
    agent: ChatAgent,
    model: Option<&str>,
    access: Option<Access>,
    prompt: &str,
    resume: Option<&str>,
    extra_dirs: &[String],
    effort: Option<&str>,
    images: &[String],
    lite: bool,
) -> String {
    let mcp = provider_for(agent)
        .capabilities()
        .uses_octiq_mcp
        .then(ask_mcp_config)
        .flatten();
    build_command_with_mcp(
        agent,
        model,
        access,
        prompt,
        resume,
        extra_dirs,
        effort,
        images,
        lite,
        mcp.as_deref(),
    )
}

/// The testable command-builder seam. Provider-specific syntax lives in the
/// selected adapter, while this function preserves the shared chat input shape.
#[allow(clippy::too_many_arguments)]
pub(super) fn build_command_with_mcp(
    agent: ChatAgent,
    model: Option<&str>,
    access: Option<Access>,
    prompt: &str,
    resume: Option<&str>,
    extra_dirs: &[String],
    effort: Option<&str>,
    images: &[String],
    lite: bool,
    mcp_config: Option<&std::path::Path>,
) -> String {
    let prompt = if mcp_config.is_some() {
        routed_prompt(agent, prompt)
    } else {
        Cow::Borrowed(prompt)
    };
    provider_for(agent).build_command(&AgentCommand {
        model,
        access,
        prompt: &prompt,
        resume,
        extra_dirs,
        sandbox_roots: &[],
        effort,
        images,
        lite,
        mcp_config,
        persistent_authorizations: None,
        orchestration_worker: false,
        front_desk: false,
        codex_user_mcp: &[],
        codex_worker_playwright: None,
        codex_worker_desktop: false,
        worker_full_tools: false,
        claude_worker_mcp: None,
        preferences: None,
    })
}

/// Deliver only between turns, and never ahead of a waiting user message.
/// The durable notification remains in-flight until the provider emits its receipt.
pub(crate) fn deliver_orchestration_notification(
    manager: Arc<ChatManager>,
    notification: &crate::orchestration::inbox::Notification,
    env: std::collections::BTreeMap<String, String>,
) -> Result<bool, String> {
    deliver_orchestration_notifications(manager, std::slice::from_ref(notification), env)
}

impl ChatManager {
    /// A stand-in agent under `key`, holding the capability a real launch
    /// is given. Returns that secret.
    pub(crate) fn test_launch(&self, key: &str) -> String {
        self.test_launch_in(key, key)
    }

    /// [`Self::test_launch`] for a process running under `key` in the chat
    /// `chat_key`: an additional agent in a room when the two differ.
    pub(crate) fn test_launch_in(&self, key: &str, chat_key: &str) -> String {
        let child = stand_in::still()
            .stdin(Stdio::null())
            .spawn()
            .expect("a stand-in agent");
        let launch_id = uuid::Uuid::new_v4().to_string();
        let mut sessions = self.sessions.lock().unwrap();
        let secret = self.grant_capability(&sessions, key, chat_key, &launch_id);
        sessions.insert(
            key.to_string(),
            Arc::new(Mutex::new(ChatSession {
                launch_id,
                user_turn_id: None,
                answering: None,
                child,
                stdin: None,
                codex: None,
                agent: ChatAgent::Claude,
                busy: false,
                last_active: Instant::now(),
                cut_off: CutOff::No,
                auto_plan_refused: false,
                auto_plan_turn: AutoPlanTurn::default(),
                auto_plan_attribution: AutoPlanAttribution::Ready,
                leaving: None,
                first_turn_held: false,
            })),
        );
        secret
    }

    /// The start settings a launched chat would have remembered, with a
    /// conversation id, so a stand-in can ask the way a real agent does.
    pub(crate) fn test_remember_start(&self, key: &str, cwd: &str) {
        self.test_remember_start_with_extra(key, cwd, None);
    }

    pub(crate) fn test_remember_start_with_extra(
        &self,
        key: &str,
        cwd: &str,
        extra_dirs: Option<Vec<String>>,
    ) {
        self.starts.lock().unwrap().insert(
            key.to_string(),
            StartContext {
                defaults: None,
                cwd: cwd.into(),
                agent: ChatAgent::Claude,
                model: Some("sonnet".into()),
                access: Some(Access::Auto),
                extra_dirs,
                env: None,
                effort: None,
                lite: None,
                session_id: Some(format!("session-{key}")),
            },
        );
    }

    /// The session table, held until the guard drops: what a look that
    /// waits for no lock meets while another thread is in the table.
    pub(crate) fn test_hold_table(&self) -> impl Drop + '_ {
        self.sessions.lock().unwrap()
    }

    /// Put a stand-in from `test_launch` in a turn, or end its turn.
    pub(crate) fn test_busy(&self, key: &str, busy: bool) {
        let session = self.sessions.lock().unwrap().get(key).cloned().unwrap();
        session.lock().unwrap().busy = busy;
    }

    /// Leave a stand-in from `test_launch` as a Stop leaves a chat whose turn
    /// it cut short: idle at once, that turn's full stop still owed. `false`
    /// is the full stop being read. No thread waits out a grace.
    pub(crate) fn test_full_stop_owed(&self, key: &str, owed: bool) {
        let session = self.sessions.lock().unwrap().get(key).cloned().unwrap();
        let mut session = session.lock().unwrap();
        session.busy = false;
        session.cut_off = if owed {
            CutOff::Owed(self.next_unwind())
        } else {
            CutOff::No
        };
    }

    /// A stand-in under `key` that takes what is written to it, in a turn
    /// or between two: what a Stop or an interrupt has something to do to.
    pub(crate) fn test_hold(&self, key: &str, agent: ChatAgent, busy: bool) -> TestChild {
        let mut child = stand_in::echo()
            .stdin(Stdio::piped())
            .stdout(Stdio::null())
            .spawn()
            .expect("a stand-in agent");
        let stdin = child.stdin.take();
        self.sessions.lock().unwrap().insert(
            key.to_string(),
            Arc::new(Mutex::new(ChatSession {
                launch_id: "test-launch".into(),
                user_turn_id: None,
                answering: None,
                child,
                stdin,
                codex: None,
                agent,
                busy,
                last_active: Instant::now(),
                cut_off: CutOff::No,
                auto_plan_refused: false,
                auto_plan_turn: AutoPlanTurn::default(),
                auto_plan_attribution: AutoPlanAttribution::Ready,
                leaving: None,
                first_turn_held: false,
            })),
        );
        self.test_child(key)
    }

    /// `test_hold`, with everything written to the stand-in kept to be read:
    /// a control message that should not have been sent has somewhere to
    /// show up.
    pub(crate) fn test_hold_heard(
        &self,
        key: &str,
        agent: ChatAgent,
        busy: bool,
    ) -> (TestChild, BufReader<ChildStdout>) {
        let mut child = stand_in::echo()
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .spawn()
            .expect("a stand-in agent");
        let stdin = child.stdin.take();
        let heard = stand_in::echoed(child.stdout.take().expect("the stand-in's stdout"));
        self.sessions.lock().unwrap().insert(
            key.to_string(),
            Arc::new(Mutex::new(ChatSession {
                launch_id: "test-launch".into(),
                user_turn_id: None,
                answering: None,
                child,
                stdin,
                codex: None,
                agent,
                busy,
                last_active: Instant::now(),
                cut_off: CutOff::No,
                auto_plan_refused: false,
                auto_plan_turn: AutoPlanTurn::default(),
                auto_plan_attribution: AutoPlanAttribution::Ready,
                leaving: None,
                first_turn_held: false,
            })),
        );
        (self.test_child(key), heard)
    }

    /// Make the stand-in under `key` a Codex app-server thread running at
    /// `access`, between turns.
    pub(crate) fn test_as_codex_thread(&self, key: &str, access: Access) {
        let session = self.sessions.lock().unwrap().get(key).cloned().unwrap();
        let mut session = session.lock().unwrap();
        session.agent = ChatAgent::Codex;
        session.codex = Some(CodexAppSession {
            thread_id: "thread-1".into(),
            active_turn_id: None,
            interrupt_when_started: false,
            next_request: 0,
            elicitations: HashMap::new(),
            mcp_calls: HashMap::new(),
            mcp_refusals: HashMap::new(),
            model: None,
            effort: None,
            access: Some(access),
            cwd: "/tmp".into(),
            workspace_roots: vec!["/tmp".into()],
            has_octiq_mcp: false,
        });
    }

    /// The level a Codex app-server stand-in would start its next turn at.
    pub(crate) fn test_codex_access(&self, key: &str) -> Option<Access> {
        let session = self.sessions.lock().unwrap().get(key).cloned().unwrap();
        let session = session.lock().unwrap();
        session.codex.as_ref().and_then(|codex| codex.access)
    }

    /// The start settings a chat launched as `agent` at `access` remembers,
    /// kept the way a launch keeps them: in memory, and in the ledger for a
    /// chat a run knows.
    pub(crate) fn test_start_at(&self, key: &str, agent: ChatAgent, access: Access) {
        let mut start = StartContext::for_test(agent, Some("native-session"));
        start.access = Some(access);
        self.remember_start(key, start);
    }

    /// The level the chat's remembered start settings name.
    pub(crate) fn test_start_access(&self, key: &str) -> Option<Access> {
        self.start_context(key).and_then(|start| start.access)
    }

    /// The process under `key`, to ask after once the chat has let go of it.
    pub(crate) fn test_child(&self, key: &str) -> TestChild {
        TestChild(self.sessions.lock().unwrap().get(key).cloned().unwrap())
    }

    /// Let a stand-in from `test_hold_heard` finish by itself: its stdin is
    /// closed and its exit waited for, so everything it was written has
    /// been echoed by the time its stdout is read. Ending it (`test_end`)
    /// kills it, and what it had not echoed yet is lost with it.
    pub(crate) fn test_finish(&self, key: &str) {
        let Some(session) = self.sessions.lock().unwrap().remove(key) else {
            return;
        };
        let mut session = session.lock().unwrap();
        session.stdin.take();
        let _ = session.child.wait();
    }

    pub(crate) fn test_clean_turn_end(&self, key: &str) -> CleanTurnEnd {
        let session = self.sessions.lock().unwrap().get(key).cloned().unwrap();
        let mut session = session.lock().unwrap();
        session.busy = true;
        end_turn_for_auto_plan(self, key, key, &mut session, true, false)
            .1
            .unwrap()
    }

    /// End a stand-in from `test_launch`, as the chat ending would.
    pub(crate) fn test_end(&self, key: &str) {
        end_process(self, key).expect("end the stand-in");
    }

    /// The launch record of a second voice: a process key whose capability
    /// names another chat. No process is started.
    pub(crate) fn test_seat(&self, session_key: &str, chat_key: &str) {
        let sessions = self.sessions.lock().unwrap();
        self.grant_capability(&sessions, session_key, chat_key, "test-launch");
    }
}

/// A stand-in's process, held past the session table (`test_child`).
pub(crate) struct TestChild(Arc<Mutex<ChatSession>>);

impl TestChild {
    /// Hold only this session, as a slow resume-context save can do.
    pub(crate) fn test_hold_lock(&self) -> impl Drop + '_ {
        self.0.lock().unwrap()
    }

    /// Whether the process is still running.
    pub(crate) fn alive(&self) -> bool {
        matches!(self.0.lock().unwrap().child.try_wait(), Ok(None))
    }

    /// `gone`, waiting only half a second: for a process that is expected
    /// to stay.
    pub(crate) fn gone_soon(&self) -> bool {
        for _ in 0..50 {
            if !self.alive() {
                return true;
            }
            thread::sleep(Duration::from_millis(10));
        }
        false
    }

    /// Whether the process ends within a few seconds: a kill is asked for,
    /// and the exit is seen a moment later.
    pub(crate) fn gone(&self) -> bool {
        for _ in 0..500 {
            if !self.alive() {
                return true;
            }
            thread::sleep(Duration::from_millis(10));
        }
        false
    }
}
