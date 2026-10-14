//! What became of a turn the host handed a chat's agent (`host_turns`):
//! the receipt a caller that must tell an agent something once reads
//! before it sends (`chat_plan_start`). Each state is made the way the
//! host makes it, through the functions that write the lines, in a record
//! of the test's own.
use super::*;

/// A chat with a record of its own, forgotten again when the test ends.
struct Record {
    manager: Arc<ChatManager>,
    key: String,
    prefix: String,
}

impl Record {
    fn new() -> Self {
        let id = uuid::Uuid::new_v4().simple().to_string();
        Self {
            manager: Arc::new(ChatManager::default()),
            key: format!("chat:host-turns-{id}"),
            prefix: format!("octiq-plan-start-{id}"),
        }
    }

    fn id(&self, name: &str) -> String {
        format!("{}-{name}", self.prefix)
    }

    /// The host takes the turn `name`: its line is in the record.
    fn accepted(&self, name: &str) -> String {
        let id = self.id(name);
        record_durable_user_turn(&self.key, &id, "The person pressed Start.", &[]);
        id
    }

    /// The turn `name` is put in the host's queue, as a send behind a
    /// running turn puts it there.
    fn queued(&self, name: &str) -> String {
        let id = self.id(name);
        let _sessions = self.manager.sessions.lock().unwrap();
        queue_waiting_turn(
            &self.manager,
            &self.key,
            &self.key,
            "The person pressed Start.",
            &[],
            Some(id.clone()),
        )
        .unwrap();
        id
    }

    fn fates(&self) -> Vec<(String, HostTurn)> {
        let all = host_turns(&self.manager, &self.key, &self.prefix, None).unwrap();
        all.into_iter()
            .map(|(id, fate)| (id[self.prefix.len() + 1..].to_string(), fate))
            .collect()
    }

    fn fate(&self, name: &str) -> Option<HostTurn> {
        self.fates()
            .into_iter()
            .find(|(id, _)| id == name)
            .map(|(_, fate)| fate)
    }
}

impl Drop for Record {
    fn drop(&mut self) {
        crate::transcript::forget(&self.key);
    }
}

/// Each line the host writes about a turn, and what it says became of it.
#[test]
fn a_turns_lines_say_what_became_of_it() {
    use HostTurn::{Gone, Handed};
    let record = Record::new();
    assert_eq!(record.fates(), [], "a turn that left nothing is not there");

    // Written to an agent between turns.
    let written = record.accepted("written");
    record_delivery(&record.key, Some(&written), "dispatched");
    // Its write failed: the turn's line is there, and so is "not sent".
    let failed = record.accepted("failed");
    record_delivery(&record.key, Some(&failed), "failed");
    // Its process ended before it said it had the prompt. The words may
    // have reached the agent, so they are not sent again.
    let unknown = record.accepted("unknown");
    record_delivery(&record.key, Some(&unknown), "dispatched");
    record_delivery(&record.key, Some(&unknown), "unknown");
    // The first message of a process: the line and no word of a delivery.
    record.accepted("first");
    // Waiting in the queue.
    record.queued("queued");
    // Queued, then handed over at the turn boundary.
    let taken = record.queued("taken");
    record
        .manager
        .cancel_queued_turn(&record.key, &taken)
        .unwrap();
    record_delivery(&record.key, Some(&taken), "dispatched");
    // Queued, then "send this one now".
    let promoted = record.queued("promoted");
    record
        .manager
        .cancel_queued_turn(&record.key, &promoted)
        .unwrap();
    record_delivery(&record.key, Some(&promoted), "starting");
    // Queued, and dropped when its process was ended on purpose.
    let dropped = record.queued("dropped");
    record
        .manager
        .cancel_queued_turn(&record.key, &dropped)
        .unwrap();
    record.manager.record_unsent(&record.key, &dropped);
    // Queued, and taken back by the person.
    let cancelled = record.queued("cancelled");
    let turn = record
        .manager
        .cancel_queued_turn(&record.key, &cancelled)
        .unwrap();
    announce_cancelled(&record.key, &turn);
    // Marked not sent, and then acknowledged by the provider after all:
    // the agent has it, whatever was said of its delivery.
    let received = record.accepted("received");
    record_delivery(&record.key, Some(&received), "failed");
    record_chat_event(
        &record.key,
        json!({ "type": "user", "octiq_user_turn_id": received }),
    );
    // A turn of another Start, or a person's own, is not in the answer.
    record_durable_user_turn(&record.key, "octiq-plan-start-another", "Another", &[]);
    record_durable_user_turn(&record.key, "user-1", "Hello", &[]);

    let mut expected = vec![
        ("cancelled", Gone),
        ("dropped", Gone),
        ("failed", Gone),
        ("first", Handed),
        ("promoted", Handed),
        ("queued", Handed),
        ("received", Handed),
        ("taken", Handed),
        ("unknown", Handed),
        ("written", Handed),
    ];
    expected.sort();
    let fates = record.fates();
    let fates: Vec<(&str, HostTurn)> = fates
        .iter()
        .map(|(id, fate)| (id.as_str(), *fate))
        .collect();
    assert_eq!(fates, expected);
}

/// A turn whose last word is `queued` is the agent's while the host's
/// queue holds it or it is being carried into the next process, and gone
/// when neither is so: the queue is in memory, and that is what a server
/// that stopped leaves in the record.
#[test]
fn a_queued_turn_is_handed_while_the_queue_holds_it_or_it_is_being_carried() {
    use HostTurn::{Gone, Handed};
    let record = Record::new();
    let id = record.queued("one");
    assert_eq!(record.fate("one"), Some(Handed), "in the queue");

    // A one-shot agent's reaper has taken it and is starting the next
    // process with it: out of the queue, and its "dispatched" line not
    // written yet.
    let turn = record.manager.cancel_queued_turn(&record.key, &id).unwrap();
    record
        .manager
        .handoffs
        .lock()
        .unwrap()
        .insert(record.key.clone());
    assert_eq!(record.fate("one"), Some(Handed), "being carried");

    // Nothing holds it and nothing is carrying it: lost with its queue.
    record.manager.handoffs.lock().unwrap().remove(&record.key);
    assert_eq!(record.fate("one"), Some(Gone));
    // To another server the same record reads the same.
    let another = ChatManager::default();
    assert_eq!(
        host_turns(&another, &record.key, &record.prefix, None).unwrap()[&id],
        Gone
    );

    // A turn the person took back is gone even while its chat's queue is
    // being carried: the carry is of whatever else was waiting.
    announce_cancelled(&record.key, &turn);
    record
        .manager
        .handoffs
        .lock()
        .unwrap()
        .insert(record.key.clone());
    assert_eq!(record.fate("one"), Some(Gone), "taken back");
    record.manager.handoffs.lock().unwrap().remove(&record.key);
}

/// A turn this server handed over itself (`here`) is not asked of the
/// record whether it was: its lines are written best effort, and a record
/// that took none of them, or `queued` and not what followed, says less
/// than happened (review 2b, H2b). Only a line that says the turn is gone
/// makes it so.
#[test]
fn a_turn_this_server_handed_over_is_gone_only_by_a_line_that_says_so() {
    use HostTurn::{Gone, Handed};
    let record = Record::new();
    let fate = |name: &str, here: bool| {
        let id = record.id(name);
        host_turns(
            &record.manager,
            &record.key,
            &record.prefix,
            here.then_some(id.as_str()),
        )
        .unwrap()
        .get(&id)
        .copied()
    };

    // No line at all.
    assert_eq!(fate("silent", false), None, "never handed over");
    assert_eq!(fate("silent", true), Some(Handed));

    // Queued, and the queue no longer holds it: a server that is gone lost
    // it; this server's own queue let it go, to the agent for all the
    // record says.
    let id = record.queued("let-go");
    record.manager.cancel_queued_turn(&record.key, &id).unwrap();
    assert_eq!(fate("let-go", false), Some(Gone));
    assert_eq!(fate("let-go", true), Some(Handed));

    // A line that says it is gone is believed, whoever handed it over.
    record_delivery(&record.key, Some(&id), "failed");
    assert_eq!(fate("let-go", true), Some(Gone));
    let id = record.queued("taken-back");
    let _sessions = record.manager.sessions.lock().unwrap();
    let taken = record.manager.cancel_queued_turn(&record.key, &id).unwrap();
    announce_cancelled(&record.key, &taken);
    drop(_sessions);
    assert_eq!(fate("taken-back", true), Some(Gone));

    // A turn of another chain is not this one's.
    assert_eq!(
        host_turns(
            &record.manager,
            &record.key,
            &record.prefix,
            Some("octiq-plan-start-another")
        )
        .unwrap()
        .get("octiq-plan-start-another"),
        None
    );
}
