use super::tests::{capturing_claude_session, hold};
use super::*;
use crate::orchestration::agent_work::Departure;
use crate::orchestration::OrchestrationStore;

/// A lead registered in a roster of its own, with one conversation it
/// leads: a live stand-in Claude that is idle, and what it is sent.
struct Led {
    _dir: crate::test_dir::TestDir,
    roster: PathBuf,
    lead: crate::team::TeamAgent,
    manager: Arc<ChatManager>,
    store: OrchestrationStore,
    key: String,
    session: Arc<Mutex<ChatSession>>,
    written: std::io::BufReader<std::process::ChildStdout>,
}

impl Led {
    fn new() -> Self {
        let dir = crate::test_dir::TestDir::new("m2-leaving");
        let roster = dir.0.join("team.json");
        let lead = crate::team::save(
            &roster,
            serde_json::from_value(json!({
                "name": "Lead", "role": "Leads", "agent": "claude", "model": "sonnet",
            }))
            .unwrap(),
        )
        .unwrap();
        let key = format!("chat:leaving-{}", uuid::Uuid::new_v4().simple());
        crate::team::record_lead(&roster, &key, &lead, "workspace", false).unwrap();
        let (session, written) = capturing_claude_session();
        session.lock().unwrap().busy = false;
        let manager = Arc::new(ChatManager::default());
        hold(&manager, &key, session.clone());
        Self {
            _dir: dir,
            roster,
            lead,
            manager,
            store: OrchestrationStore::default(),
            key,
            session,
            written,
        }
    }

    fn departure(&self) -> Departure<'_> {
        Departure {
            store: &self.store,
            chats: &self.manager,
        }
    }

    fn send(&self, text: &str, id: &str) -> Result<(), String> {
        chat_send_user_impl(
            self.manager.clone(),
            self.key.clone(),
            text.into(),
            None,
            None,
            Some(id.into()),
            None,
        )
    }

    fn registered(&self) -> bool {
        !crate::team::list(&self.roster, None, true)
            .unwrap()
            .is_empty()
    }

    /// Every prompt the stand-in was ever sent. Its input is closed, not
    /// the process killed, so it echoes what it still holds and ends.
    fn sent(mut self) -> Vec<String> {
        drop(self.session.lock().unwrap().stdin.take());
        let mut texts = Vec::new();
        let mut line = String::new();
        while std::io::BufRead::read_line(&mut self.written, &mut line).unwrap_or(0) > 0 {
            if let Ok(sent) = serde_json::from_str::<Value>(&line) {
                if let Some(text) = sent.pointer("/message/content/0/text") {
                    texts.push(text.as_str().unwrap_or_default().to_owned());
                }
            }
            line.clear();
        }
        texts
    }
}

impl Drop for Led {
    fn drop(&mut self) {
        let _ = end_process(&self.manager, &self.key);
        crate::transcript::forget(&self.key);
    }
}

/// A removal that does something of the test's after the agent's chats
/// were looked at and found idle, and before the roster is written.
struct Midway<'a, F: Fn()> {
    departure: Departure<'a>,
    then: F,
}

impl<F: Fn()> crate::team::Leave for Midway<'_, F> {
    fn leave(
        &self,
        agent: &crate::team::TeamAgent,
        chats: &[crate::team::OwnChat],
        write: &mut dyn FnMut() -> Result<(), String>,
    ) -> Result<(), String> {
        crate::team::Leave::leave(&self.departure, agent, chats, &mut || {
            (self.then)();
            write()
        })
    }
}

/// The reviewer's probe. The removal has looked at the lead's chat and
/// found it idle; before the roster is written, the person's message
/// arrives on another thread through the real send. It is refused in
/// words that say why, nothing reaches the agent, and no turn is in
/// flight in a conversation whose agent is gone.
#[test]
fn a_message_that_arrives_inside_a_removal_is_refused_and_nothing_is_written() {
    let led = Led::new();
    let answer = Mutex::new(None);
    let midway = Midway {
        departure: led.departure(),
        then: || {
            let sent = thread::scope(|scope| {
                scope
                    .spawn(|| led.send("Previously prepared turn", "user-1"))
                    .join()
                    .unwrap()
            });
            *answer.lock().unwrap() = Some(sent);
        },
    };
    crate::team::delete_idle(&led.roster, &led.lead.id, &midway)
        .expect("the chat was idle when the removal looked");
    let refused = answer
        .lock()
        .unwrap()
        .take()
        .expect("the message was sent inside the removal")
        .expect_err("a prompt written inside a removal");
    assert_eq!(
            refused,
            "Lead is being removed, so this conversation takes no message right now. Nothing was sent. Send it again in a moment: if the removal is refused, the conversation carries on."
        );
    assert!(!led.registered(), "the removal went through");
    assert!(!led.manager.turn_in_flight(&led.key));
    assert!(!led.session.lock().unwrap().busy);
    // Gone, the conversation is the agent's no longer: nothing more is
    // written to it, and no process is started for it.
    let gone = "Lead was removed, and this was Lead's conversation: it takes no more messages. Nothing was sent. Start a new conversation with another agent.";
    assert_eq!(led.send("And another", "user-2"), Err(gone.into()));
    assert_eq!(led.manager.leaving_refusal(&led.key).as_deref(), Some(gone));
    assert_eq!(led.sent(), Vec::<String>::new());
}

/// The other order: the message first. Its turn is in flight when the
/// removal looks, so the removal is the one refused, the agent stays,
/// and the conversation goes on taking messages.
#[test]
fn a_turn_that_started_first_refuses_the_removal_and_the_chat_carries_on() {
    let led = Led::new();
    led.send("Do this", "user-1").unwrap();
    let refused =
        crate::team::delete_idle(&led.roster, &led.lead.id, &led.departure()).unwrap_err();
    assert_eq!(
            refused,
            format!(
                "Lead is in the middle of a turn in a conversation it leads ({}). Nothing was removed. Stop that turn or wait for it to end, then remove Lead.",
                led.key
            )
        );
    assert!(led.registered());
    assert_eq!(led.manager.leaving_refusal(&led.key), None, "called off");
    // The turn ends; the next message is written like any other.
    {
        let mut running = led.session.lock().unwrap();
        end_turn_locked(&led.manager, &led.key, &led.key, &mut running, true);
    }
    led.send("And this", "user-2").unwrap();
    assert_eq!(led.sent(), ["Do this", "And this"]);
}

/// A removal that fails after it marked and looked (here the roster
/// cannot be written) calls the mark off: the idle chat it had marked
/// takes the next message.
#[test]
fn a_removal_that_fails_leaves_the_chat_taking_messages() {
    struct Failing<'a>(Departure<'a>);
    impl crate::team::Leave for Failing<'_> {
        fn leave(
            &self,
            agent: &crate::team::TeamAgent,
            chats: &[crate::team::OwnChat],
            _write: &mut dyn FnMut() -> Result<(), String>,
        ) -> Result<(), String> {
            crate::team::Leave::leave(&self.0, agent, chats, &mut || {
                Err("No space left on device".into())
            })
        }
    }
    let led = Led::new();
    let refused =
        crate::team::delete_idle(&led.roster, &led.lead.id, &Failing(led.departure())).unwrap_err();
    assert!(
        refused.starts_with("Lead was not removed: the roster could not be written"),
        "{refused}"
    );
    assert!(led.registered());
    assert_eq!(led.manager.leaving_refusal(&led.key), None);
    led.send("Still here", "user-1").unwrap();
    assert!(led.manager.turn_in_flight(&led.key));
    assert_eq!(led.sent(), ["Still here"]);
}

/// What the removal's look calls working, beyond a turn in flight: a
/// stopped turn whose full stop is owed, and anything queued. In doubt
/// the agent is working and stays.
#[test]
fn a_stopped_turn_or_a_queued_message_counts_as_working() {
    let led = Led::new();
    led.send("Do this", "user-1").unwrap();
    led.send("Then this", "user-2").unwrap();
    chat_interrupt_impl(&led.manager, led.key.clone()).expect("Stop");
    assert!(!led.session.lock().unwrap().busy, "a Stop reads idle");
    let mark = led.manager.mark_leaving("Lead", &[led.key.clone()]);
    assert!(mark.working(&led.key));
    drop(mark);
    assert_eq!(led.manager.leaving_refusal(&led.key), None);
    let refused =
        crate::team::delete_idle(&led.roster, &led.lead.id, &led.departure()).unwrap_err();
    assert!(
        refused.starts_with("Lead is in the middle of a turn"),
        "{refused}"
    );
    assert!(led.registered());
}

/// Every way a prompt reaches an agent meets the mark: the one function
/// they all write through, a message, a queued message handed over at a
/// full stop, a host notification, a completion's wrap-up, and the start
/// of a process. Nothing is written by any of them.
#[test]
fn every_writer_of_a_prompt_meets_the_mark() {
    use crate::orchestration::inbox::{DeliveryState, Notification, RECEIPT_PREFIX};

    let led = Led::new();
    let mark = led.manager.mark_leaving("Lead", &[led.key.clone()]);
    assert!(!mark.working(&led.key), "idle, so it is marked");
    let leaving = "Lead is being removed, so this conversation takes no message right now. Nothing was sent. Send it again in a moment: if the removal is refused, the conversation carries on.";

    // The write point itself.
    {
        let mut session = led.session.lock().unwrap();
        assert_eq!(
            write_user_message_locked(
                &led.manager,
                &mut session,
                &led.key,
                "anything",
                &[],
                Some("user-0")
            ),
            Err(leaving.into())
        );
        assert!(!session.busy);
        assert_eq!(session.answering, None);
    }
    // A message from the person.
    assert_eq!(led.send("A message", "user-1"), Err(leaving.into()));
    assert!(
        !durable_user_turn_exists(&led.key, "user-1").unwrap(),
        "refused before it was written down"
    );
    // A message that was already waiting when a turn reached its full
    // stop: handed over there, and refused there.
    led.manager
        .queue_turn(
            &led.key,
            QueuedTurn {
                text: "A queued message".into(),
                images: Vec::new(),
                turn_id: Some("user-2".into()),
                appended_turn_ids: Vec::new(),
                recorded: false,
                context: led.manager.queue_context(&led.key),
            },
        )
        .unwrap();
    {
        let mut session = led.session.lock().unwrap();
        let (_, refused) = end_turn_locked(&led.manager, &led.key, &led.key, &mut session, true);
        assert_eq!(refused.as_deref(), Some(leaving));
        assert!(!session.busy);
    }
    // A host notification.
    let note = Notification {
        id: format!("{RECEIPT_PREFIX}leaving"),
        run_id: "run_1".into(),
        from_chat_key: "chat:other".into(),
        target_chat_key: led.key.clone(),
        source: "test".into(),
        kind: "instruction".into(),
        body: "Something happened.".into(),
        state: DeliveryState::Delivering,
        attempts: 0,
        coalesced: 0,
        sequence: None,
        created_at: 0,
        updated_at: 0,
        next_attempt_at: 0,
        last_error: None,
    };
    assert_eq!(
        deliver_orchestration_notification(led.manager.clone(), &note, Default::default()),
        Err(leaving.into())
    );
    // A completion's wrap-up: the completion ends with the reason.
    assert_eq!(
        chat_complete_impl(&led.manager, &led.key, "wrap up").map(|_| ()),
        Err(leaving.into())
    );
    assert_eq!(led.manager.completing_turn(&led.key), None);
    // The start of a process for it, which a carried queue rides after
    // a Stop that was not honoured: refused before anything is spawned.
    let _ = end_process(&led.manager, &led.key);
    let started = start_session(
        led.manager.clone(),
        Voice {
            session_key: led.key.clone(),
            stream_key: led.key.clone(),
        },
        "/tmp".into(),
        ChatAgent::Claude,
        None,
        None,
        Some("A carried message".into()),
        None,
        None,
        None,
        None,
        None,
        None,
        Some("user-3".into()),
        true,
        None,
    );
    assert_eq!(started, Err(leaving.into()));
    assert!(!led.manager.has_process(&led.key));

    // Called off, all of it goes through again.
    drop(mark);
    assert_eq!(led.manager.leaving_refusal(&led.key), None);
    assert_eq!(led.sent(), Vec::<String>::new());
}
