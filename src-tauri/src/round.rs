//! A ROUND: the seats of a room answering one thing, in order, one at a time.
//!
//! The host says something, then each seat answers — and each one is shown what
//! the seats before it just said. That ordering is the whole point, and it is
//! copied from a system already in daily use: Starfall's round-table
//! (`.claude/rules/roundtable.md`, `lab/roundtable/turn.py` in that repo).
//!
//! ## Why in sequence, never at once
//!
//! `turn.py` puts it plainly: 顺序跑不并发：后讲的那一方要看得见前面刚讲的，否则
//! 同一轮出来的是几份独白 — *run them in order, not in parallel: whoever speaks
//! later has to be able to see what was just said, or one round produces several
//! monologues.* Fan the seats out concurrently and nobody is answering anybody;
//! you get N first drafts of the same reply and no discussion at all.
//!
//! ## Why the BACKEND drives it
//!
//! A round takes minutes. The obvious implementation — the client sends to seat
//! one, waits for its reply, sends to seat two — dies the moment a laptop lid
//! shuts. That is the exact failure `transcript.rs` was written to fix: an agent
//! here keeps working whether or not anyone is watching. So the sequence runs
//! here, and the client only watches it happen.
//!
//! ## What a seat is actually told
//!
//! Its brief is the host's message plus, attributed, whatever the earlier seats
//! answered THIS round. How much older history rides along with that is card
//! 69's question, not this module's.
use std::collections::HashMap;
use std::sync::mpsc::{channel, Receiver, Sender};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use crate::agent_chat::ChatManager;
use crate::chat_room::{seat_session_key, Seat};

/// How long one seat may take before the round gives up on it and moves on.
///
/// Long, because a real answer to a real question takes minutes and cutting one
/// off mid-thought is worse than waiting. Not unbounded, because a seat that has
/// silently died would otherwise hold the round open forever, and the user would
/// see a discussion that never ends and never says why.
const SEAT_TIMEOUT: Duration = Duration::from_secs(20 * 60);

/// How long `ask_agent` waits before handing the host back its turn.
///
/// Much shorter than `SEAT_TIMEOUT`, and for a different reason. A round runs in
/// the background with nobody watching it, so waiting out a considered answer
/// costs nothing. `ask_agent` is a tool call the HOST is blocked on: a host that
/// stops for twenty minutes is a chat that looks dead, which is how this was
/// first reported — a cold `codex exec` start with no sign of life.
///
/// Giving up here loses nothing. A seat has its own process and its own reader,
/// so whatever it eventually says still reaches the transcript and the screen.
/// Only the host's copy of the answer is missed, and the host is told so.
const ASK_TIMEOUT: Duration = Duration::from_secs(3 * 60);

/// What the host is told when the wait ends before the answer does.
fn gave_up_on(name: &str) -> String {
    format!(
        "{name} is still thinking. Its answer will appear in this chat when it \
         arrives — carry on without it, or ask the person to wait for it."
    )
}

/// The hardest a seat may think during a round.
///
/// A trap Starfall already paid for, in `lab/roundtable/turn.py`: 推理档必须在
/// 这里压掉 — *the reasoning tier has to be forced down here.* A round brief
/// grows with every seat that speaks, and a large prompt on the top tier hangs:
/// 0.0% CPU, pure waiting, indistinguishable from an API outage. Their measured
/// numbers are six seconds on a low tier against twenty-four minutes with no
/// output at all on `xhigh`.
///
/// So a round does not honour whatever the picker is set to. It is not the
/// user's setting being ignored for its own sake — it is the difference between
/// a discussion and a hang nobody can diagnose.
const ROUND_EFFORT: &str = "medium";

/// The effort a seat runs at during a round: the user's, unless theirs is
/// higher than a round can safely carry.
fn round_effort(chosen: &Option<String>) -> Option<String> {
    match chosen.as_deref() {
        // Anything at or below the cap is honoured as chosen.
        Some("minimal") | Some("low") => chosen.clone(),
        // Everything else — including `auto`, `high`, `xhigh`, `max` and an
        // unset picker — comes down to the cap.
        _ => Some(ROUND_EFFORT.to_string()),
    }
}

/// What one seat said when its turn came.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct Said {
    pub name: String,
    /// What it answered, or the reason it did not.
    pub text: String,
    /// False when the seat failed rather than answered. Starfall's rule:
    /// 一方挂了不该拖垮另一方 — *one side falling over should not drag the other
    /// down with it* — so the round carries on and this is reported in place.
    pub answered: bool,
}

/// How many exchanges a seat is shown by default, when the host says nothing.
///
/// Starfall's tested value. The reason for having a limit at all is the sharpest
/// line in their rules: 每轮重发整场 ＝ 成本随轮数平方增长 — *re-sending the whole
/// discussion every round makes cost grow with the SQUARE of the round count.*
/// The 30k characters pasted in round one are paid for again in round two, and
/// again in round three. It also makes the answers WORSE: a seat reads thirty
/// rounds about something else before reaching the question in front of it, and
/// its attention is spread over all of it.
pub const DEFAULT_WINDOW: usize = 24;

/// The part of the discussion a seat is shown: from the current topic, newest
/// first, at most `window` of them.
///
/// Two rules stacked. The TOPIC marker is the hard cut — everything before it is
/// gone for good, because the judgement Starfall uses is 这一轮要答的问题，需要上
/// 一个话题的哪一句？答不出来就 --fresh (*which line of the last topic does this
/// question need? If you cannot say, start fresh*). The WINDOW is the soft cut
/// inside what is left, because even one topic should not run forever.
///
/// A window of 0 means no limit, not "send nothing" — a config that quietly made
/// every seat answer blind would show up only as answers going strange, with
/// nothing on screen saying why.
pub fn discussion_window(record: &[Said], topic_start: usize, window: usize) -> &[Said] {
    // The marker can outrun the record when a topic is opened before anyone has
    // spoken in it. Nothing to send is the right answer; panicking here would
    // take the round down with it.
    let from = topic_start.min(record.len());
    let this_topic = &record[from..];
    if window == 0 || this_topic.len() <= window {
        return this_topic;
    }
    &this_topic[this_topic.len() - window..]
}

/// What a seat is told about what came before — the host's choice if it made
/// one, the mechanical window otherwise.
///
/// The host knows what a seat is FOR. A reviewer brought in to read one function
/// does not need forty rounds about something else, and sending them anyway is
/// both the expensive answer and the worse one.
///
/// `Some(&[])` is a real choice, not an absent one: "answer this cold". It must
/// not fall back to the window, because giving an outside opinion the whole
/// discussion is exactly how it stops being outside.
pub fn backdrop<'a>(
    record: &'a [Said],
    topic_start: usize,
    window: usize,
    chosen: Option<&'a [Said]>,
) -> &'a [Said] {
    match chosen {
        Some(chosen) => chosen,
        None => discussion_window(record, topic_start, window),
    }
}

/// The brief one seat is handed when its turn comes.
///
/// The host's message first, because that is the question. Then what the seats
/// before it said this round, each under its own name — a seat that cannot tell
/// who said what cannot answer anybody, it can only add another monologue.
///
/// A seat that FAILED is still named. Silently dropping it would let the next
/// seat believe the round had been quieter than it was, and a reader comparing
/// the brief against the screen would find them disagreeing.
pub fn round_brief(host: &str, said: &[Said]) -> String {
    let mut out = String::from(host.trim());
    if said.is_empty() {
        return out;
    }
    out.push_str("\n\n=== what has been said this round ===");
    for s in said {
        out.push_str(&format!("\n\n--- {} ---\n", s.name));
        out.push_str(if s.answered {
            s.text.trim()
        } else {
            "(did not answer this round)"
        });
    }
    out.push_str("\n\n=== over to you ===");
    out
}

/// One round in flight, for one chat.
#[derive(Debug, Clone, Default)]
pub struct Round {
    /// The seats still to speak, in order. Drains from the front.
    pub waiting: Vec<String>,
    /// Who has spoken, and what they said.
    pub said: Vec<Said>,
    /// The user cut in. Nothing further runs, and nothing further is billed.
    pub hand: bool,
    /// The session key of the seat speaking RIGHT NOW, if any. Kept so cutting
    /// in can end the wait for it instead of sitting out `SEAT_TIMEOUT`.
    pub speaking: Option<String>,
}

/// A room's discussion so far, across rounds.
///
/// Separate from `Round`, which is one round in flight. A round ends; the
/// discussion does not, and the next round has to be able to show a seat what
/// the last one concluded.
#[derive(Debug, Clone, Default)]
struct Record {
    said: Vec<Said>,
    /// Where the current topic began. Everything before it is gone for good —
    /// see `discussion_window`.
    topic_start: usize,
}

/// Every round in flight, and what has been said in each room.
#[derive(Default)]
pub struct Rounds {
    live: Mutex<HashMap<String, Round>>,
    record: Mutex<HashMap<String, Record>>,
}

impl Rounds {
    /// Begin a round. Refused when one is already going in this chat — two
    /// rounds at once would interleave two conversations into one transcript
    /// and neither would read as a discussion.
    pub fn start(&self, key: &str, order: Vec<String>) -> Result<(), String> {
        if order.is_empty() {
            return Err("a round needs at least one seat".into());
        }
        let mut live = self.live.lock().map_err(|e| e.to_string())?;
        if live.contains_key(key) {
            return Err("a round is already running in this chat".into());
        }
        live.insert(
            key.to_string(),
            Round {
                waiting: order,
                said: Vec::new(),
                hand: false,
                speaking: None,
            },
        );
        Ok(())
    }

    /// Whose turn it is, and what to tell them — or `None` when the round is
    /// over, was never started, or the hand went up.
    ///
    /// Taking the next seat REMOVES it from the queue, so a round cannot ask the
    /// same seat twice however the driver is scheduled.
    pub fn next(&self, key: &str) -> Option<(String, Vec<Said>)> {
        let mut live = self.live.lock().ok()?;
        let round = live.get_mut(key)?;
        if round.hand || round.waiting.is_empty() {
            return None;
        }
        let seat = round.waiting.remove(0);
        Some((seat, round.said.clone()))
    }

    /// Write down what a seat said.
    pub fn record(&self, key: &str, said: Said) {
        if let Ok(mut live) = self.live.lock() {
            if let Some(round) = live.get_mut(key) {
                round.said.push(said);
            }
        }
    }

    /// The user cut in. The seats still waiting never run.
    ///
    /// And the one already speaking is stopped being WAITED ON. Dropping its
    /// listener makes the driver's `recv` fail at once instead of sitting out
    /// the full `SEAT_TIMEOUT` — without this the bar reads "stopped" while the
    /// round is still open, for up to twenty minutes.
    pub fn raise_hand(&self, key: &str) {
        let mut speaking = None;
        if let Ok(mut live) = self.live.lock() {
            if let Some(round) = live.get_mut(key) {
                round.hand = true;
                round.waiting.clear();
                speaking = round.speaking.take();
            }
        }
        if let Some(session) = speaking {
            with_listening(|l| l.remove(&session));
        }
    }

    /// Note who is speaking, so cutting in can end the wait for them.
    fn speaking(&self, key: &str, session: Option<String>) {
        if let Ok(mut live) = self.live.lock() {
            if let Some(round) = live.get_mut(key) {
                round.speaking = session;
            }
        }
    }

    /// The round as it stands, for the client to draw.
    pub fn peek(&self, key: &str) -> Option<Round> {
        self.live.lock().ok()?.get(key).cloned()
    }

    /// Add what a round concluded to the room's running discussion.
    pub fn remember(&self, key: &str, said: Vec<Said>) {
        if let Ok(mut record) = self.record.lock() {
            record.entry(key.to_string()).or_default().said.extend(said);
        }
    }

    /// Draw a line. Nothing said before now is shown to any seat again.
    ///
    /// The judgement is Starfall's: 这一轮要答的问题，需要上一个话题的哪一句？
    /// 答不出来就 --fresh — *which line of the last topic does this question
    /// need? If you cannot say, start fresh.*
    pub fn new_topic(&self, key: &str) {
        if let Ok(mut record) = self.record.lock() {
            let r = record.entry(key.to_string()).or_default();
            r.topic_start = r.said.len();
        }
    }

    /// What a seat is shown, given when it JOINED.
    ///
    /// Card 77 — WhatsApp's rule, because it is the one nobody has to be told:
    /// a seat sees the room from the moment it arrived, and never the backlog.
    ///
    /// THREE cuts stack here and the tightest wins:
    /// * the seat's join point — it was not there, so it does not see it;
    /// * the room's topic marker — the room has moved on, so nobody sees it;
    /// * the window — even one topic, seen from the start, is not resent whole
    ///   every round.
    ///
    /// The host's explicit choice still beats all three. It knows what a seat is
    /// FOR, and that outranks any rule about what it happens to have witnessed.
    pub fn backdrop_since(
        &self,
        key: &str,
        joined_at: usize,
        chosen: Option<&[Said]>,
    ) -> Vec<Said> {
        let Ok(record) = self.record.lock() else {
            // Cannot read the record, so the only honest backdrop is the host's
            // choice if it made one, and nothing otherwise.
            return chosen.unwrap_or_default().to_vec();
        };
        let empty = Record::default();
        let r = record.get(key).unwrap_or(&empty);
        // The LATER of the two floors: whichever of "you were not here" and
        // "the room has moved on" cuts more.
        let from = r.topic_start.max(joined_at);
        // `backdrop` owns the choice-beats-window rule; this only supplies the
        // record and the floor. Reimplementing it here is exactly the drift
        // card 69 already had to fix once.
        backdrop(&r.said, from, DEFAULT_WINDOW, chosen).to_vec()
    }

    /// How much has been said in this room. A seat joining now records this as
    /// its join point, and is shown nothing before it.
    pub fn said_so_far(&self, key: &str) -> usize {
        self.record
            .lock()
            .ok()
            .and_then(|r| r.get(key).map(|r| r.said.len()))
            .unwrap_or(0)
    }

    /// Forget a room's discussion entirely — the chat is gone.
    pub fn forget(&self, key: &str) {
        if let Ok(mut record) = self.record.lock() {
            record.remove(key);
        }
    }

    /// The round is over. Hands back what was said, so the caller can report it.
    pub fn finish(&self, key: &str) -> Option<Round> {
        self.live.lock().ok()?.remove(key)
    }
}

/// Who is waiting to hear that a turn ended, keyed by the seat's session key.
///
/// The reader thread in `agent_chat` is the only thing that knows a turn is
/// over — `result` is the agent's own full stop. It shouts down here; the round
/// driver is listening.
static LISTENING: Mutex<Option<HashMap<String, Sender<String>>>> = Mutex::new(None);

fn with_listening<T>(f: impl FnOnce(&mut HashMap<String, Sender<String>>) -> T) -> T {
    let mut guard = LISTENING.lock().unwrap_or_else(|e| e.into_inner());
    f(guard.get_or_insert_with(HashMap::new))
}

/// Seat sessions whose turn was started by a round or by the host's own
/// `ask_agent` — as opposed to by the PERSON typing `@name`.
///
/// Deliberately NOT the same set as `LISTENING`, though they are written
/// together. Cutting in (`raise_hand`) drops the listener so the driver stops
/// waiting at once, and a seat whose answer arrives after that would otherwise
/// look exactly like one the person had asked directly — and would hand the
/// host a follow-up about a round the person had just stopped.
///
/// So this set survives the hand going up, and is cleared only when the turn
/// actually ends or when nothing was ever sent.
static DRIVEN: Mutex<Option<std::collections::HashSet<String>>> = Mutex::new(None);

fn with_driven<T>(f: impl FnOnce(&mut std::collections::HashSet<String>) -> T) -> T {
    let mut guard = DRIVEN.lock().unwrap_or_else(|e| e.into_inner());
    f(guard.get_or_insert_with(std::collections::HashSet::new))
}

/// Listen for one seat's turn to end. Registered BEFORE the seat is spoken to,
/// or a fast answer could land before anyone was listening for it.
fn listen_for(session_key: &str) -> Receiver<String> {
    let (tx, rx) = channel();
    with_listening(|l| l.insert(session_key.to_string(), tx));
    with_driven(|d| d.insert(session_key.to_string()));
    rx
}

/// Nothing was sent after all, so this seat is not answering anybody.
fn never_spoke(session_key: &str) {
    with_listening(|l| l.remove(session_key));
    with_driven(|d| d.remove(session_key));
}

/// A process is gone. Whatever it was in the middle of, it will not be
/// finishing it, so nothing may go on waiting for it or marking it as busy.
///
/// Without this a seat killed part-way through a round — the person stopped the
/// chat, the room was swept, the agent crashed — would leave its mark behind
/// for the life of the backend, and the follow-up on the very next thing it was
/// asked would be swallowed as though a round were still driving it.
pub fn session_gone(session_key: &str) {
    never_spoke(session_key);
}

/// A turn ended. Called from the reader thread on the agent's own full stop.
///
/// Two different things can be owed an answer here, and which one it is turns
/// on whether anything STARTED this turn:
///
/// * a round or the host's `ask_agent` is waiting for it — hand it over;
/// * nothing is, so the PERSON asked this seat directly with `@name`, and the
///   host has not heard a word of it. It is told, so it can answer.
///
/// Silent for the host's own turn and for every ordinary chat, which has no
/// seats at all.
pub fn turn_ended(manager: Arc<ChatManager>, room_key: &str, seat: Option<&Seat>, said: &str) {
    let Some(seat) = seat else { return };
    let key = seat_session_key(room_key, &seat.id);
    let driven = with_driven(|d| d.remove(&key));
    let tx = with_listening(|l| l.remove(&key));
    if let Some(tx) = tx {
        let _ = tx.send(said.to_string());
        return;
    }
    // Driven, but nobody is left waiting: the person cut in mid-round. The
    // round is over by the person's own decision, and telling the host about
    // the answer it stopped would be answering a question that was withdrawn.
    if driven {
        return;
    }
    ask_host(
        manager,
        room_key,
        &followup_brief(&[Said {
            name: seat.name.clone(),
            text: said.to_string(),
            answered: true,
        }]),
    );
}

/// What the host is handed once the other agents have spoken.
///
/// The host runs as its OWN process with its own conversation: a seat's words
/// go into the room's transcript, never down the host's stdin. So it has not
/// read any of this, and a brief that only said "answer them" would have it
/// answering something it cannot see.
///
/// Attributed by name, the same shape a seat gets in `round_brief`, and for the
/// same reason — an answer that cannot say who said what is not a reply to
/// anybody. The closing note is the part that matters most: without it the host
/// reads the whole thing as the PERSON talking, and replies to the wrong one.
pub fn followup_brief(said: &[Said]) -> String {
    let mut out = String::from("=== what the others in this chat just said ===");
    for s in said {
        out.push_str(&format!("\n\n--- {} ---\n", s.name));
        out.push_str(if s.answered {
            s.text.trim()
        } else {
            "(did not answer)"
        });
    }
    out.push_str(
        "\n\n=== over to you ===\nThose are the other agents sitting in this chat, \
         not the person. The person is waiting to hear what YOU make of it. Say so, \
         in your own words — agree, disagree, or carry on with the work it changes. \
         Do not repeat their answers back, and do not ask them anything unless the \
         person asked you to.",
    );
    out
}

/// Hand the host something to answer.
///
/// Sent from HERE rather than announced for the client to send, and on a thread
/// of its own, for the reason this whole module runs in the background: a
/// browser is not required for a room to work. It is also the only way to keep
/// it to one — two open tabs both acting on an announcement would ask the host
/// the same thing twice.
///
/// A thread because the caller is a reader thread part-way through the seat's
/// own stream, and starting a host means spawning a process and waiting on its
/// first bytes. Blocking there would stall the seat that just finished.
///
/// The client is still TOLD, after the fact — `chat-followup` is what puts the
/// line on screen saying the answers were passed on. It is a notice, not an
/// instruction: nothing acts on it, so however many tabs are watching, the host
/// is asked once.
fn ask_host(manager: Arc<ChatManager>, room_key: &str, text: &str) {
    let key = room_key.to_string();
    let text = text.to_string();
    std::thread::spawn(move || {
        if let Err(why) = crate::agent_chat::send_to_host(manager, &key, &text) {
            // Worth a line and nothing more. The seats' answers are on screen
            // and in the transcript; what is lost is the host's remark about
            // them, and the person can still ask for it themselves.
            eprintln!("[round] {key} could not be told what the room said: {why}");
            return;
        }
        crate::bus::emit(
            "chat-followup",
            serde_json::json!({ "key": key, "text": text }),
        );
    });
}

/// Run a whole round, one seat at a time, on a thread of its own.
///
/// Spawned rather than awaited because a round takes minutes and the call that
/// starts it is an HTTP request. Everything it needs is owned, so it outlives
/// the request, the browser, and a closed laptop — see this module's header.
#[allow(clippy::too_many_arguments)]
pub fn run_round(
    rounds: Arc<Rounds>,
    manager: Arc<ChatManager>,
    key: String,
    host_text: String,
    cwd: String,
    access: Option<crate::agent_chat::Access>,
    extra_dirs: Option<Vec<String>>,
    effort: Option<String>,
    // What the host chose to show the seats, or `None` for the window.
    chosen: Option<Vec<Said>>,
) {
    std::thread::spawn(move || {
        while let Some((seat_id, so_far)) = rounds.next(&key) {
            let Ok(crate::chat_room::Target::Seat(seat)) =
                crate::chat_room::target_impl(&manager, &key, Some(&seat_id))
            else {
                // Removed mid-round. Not an error worth stopping for — the
                // seats after it are still owed their turn.
                continue;
            };
            // What came before, then what this round has said so far. The
            // backdrop is the host's choice when it made one, and this topic's
            // newest few otherwise — see `backdrop`.
            let mut shown = rounds.backdrop_since(&key, seat.joined_at, chosen.as_deref());
            shown.extend(so_far);
            let brief = round_brief(&host_text, &shown);

            // The same fork as `ask_seat`: an on-demand seat is a call that
            // returns, not a process whose turn has to be waited for.
            if seat.kind == crate::chat_room::SeatKind::OnDemand {
                let said = match crate::agent_api::ask(&seat, &key, &brief) {
                    Ok(text) => Said {
                        name: seat.name.clone(),
                        text,
                        answered: true,
                    },
                    Err(why) => Said {
                        name: seat.name.clone(),
                        text: why,
                        answered: false,
                    },
                };
                rounds.record(&key, said);
                continue;
            }

            let session = seat_session_key(&key, &seat.id);
            // Listening BEFORE speaking: a fast answer that landed first would
            // otherwise be shouted into an empty room and the round would wait
            // out the whole timeout for something already said.
            let heard = listen_for(&session);
            rounds.speaking(&key, Some(session.clone()));

            let sent = speak_to(
                &manager,
                &key,
                &seat,
                &brief,
                &cwd,
                access,
                &extra_dirs,
                &effort,
            );
            let said = match sent {
                Err(why) => {
                    // Nothing was sent, so no turn will ever end for this. Both
                    // marks come off here or they would sit there for the life
                    // of the process, silencing the follow-up of whatever this
                    // seat is asked next.
                    never_spoke(&session);
                    Said {
                        name: seat.name.clone(),
                        text: why,
                        answered: false,
                    }
                }
                Ok(()) => match heard.recv_timeout(SEAT_TIMEOUT) {
                    Ok(text) => Said {
                        name: seat.name.clone(),
                        text,
                        answered: true,
                    },
                    Err(_) => {
                        // Only the LISTENER goes. The seat was spoken to and is
                        // still thinking; giving up on it does not stop it, and
                        // an answer that lands after this is still the round's
                        // — `turn_ended` clears the mark when it does.
                        with_listening(|l| l.remove(&session));
                        Said {
                            name: seat.name.clone(),
                            text: "did not answer in time".into(),
                            answered: false,
                        }
                    }
                },
            };
            // Whatever happened, it is written down and the round carries on —
            // 一方挂了不该拖垮另一方.
            rounds.speaking(&key, None);
            rounds.record(&key, said);
        }
        let over = rounds.finish(&key);
        // What this round concluded joins the room's running discussion, so the
        // NEXT round can show a seat what this one decided.
        if let Some(o) = over.as_ref() {
            rounds.remember(&key, o.said.clone());
        }
        crate::bus::emit(
            "chat-round",
            serde_json::json!({
                "key": key,
                "done": true,
                "hand": over.as_ref().map(|o| o.hand).unwrap_or(false),
                "said": over.as_ref()
                    .map(|o| o.said.iter().map(|s| serde_json::json!({
                        "name": s.name, "answered": s.answered,
                    })).collect::<Vec<_>>())
                    .unwrap_or_default(),
            }),
        );
        // The host has been sitting out its own room: every seat wrote to the
        // transcript and none of it went down the host's stdin. Now that the
        // last one has spoken it is handed the lot, ONCE — a host cutting in
        // between seats would break the ordering the round exists for.
        //
        // Not after a round the person STOPPED. Cutting in is a decision that
        // the answer is no longer wanted, and answering it anyway is the one
        // thing the button was pressed to prevent.
        if let Some(o) = over {
            if !o.hand && !o.said.is_empty() {
                ask_host(manager.clone(), &key, &followup_brief(&o.said));
            }
        }
    });
}

/// Put the brief to one seat: start its process if this is its first word,
/// otherwise write to the one it already has.
///
/// Caps the reasoning effort ITSELF rather than trusting the caller to have
/// done it. That is deliberate: the first version capped it at the call site,
/// `cargo fmt` reflowed that call, the edit silently missed — and the test went
/// on passing, because it exercised the pure function rather than the path.
/// A cap the caller cannot forget cannot be lost that way again.
#[allow(clippy::too_many_arguments)]
fn speak_to(
    manager: &Arc<ChatManager>,
    key: &str,
    seat: &Seat,
    brief: &str,
    cwd: &str,
    access: Option<crate::agent_chat::Access>,
    extra_dirs: &Option<Vec<String>>,
    effort: &Option<String>,
) -> Result<(), String> {
    let effort = &round_effort(effort);
    let send = crate::agent_chat::chat_send_impl(
        manager.clone(),
        key.to_string(),
        brief.to_string(),
        None,
        Some(seat.id.clone()),
    );
    match send {
        Ok(()) => Ok(()),
        // Never spoken before, so there is nothing to write to yet. The same
        // two-step the client does for the host's own first message.
        Err(why) if why.contains("not running") => crate::agent_chat::chat_seat_start_impl(
            manager.clone(),
            key.to_string(),
            seat.id.clone(),
            cwd.to_string(),
            Some(brief.to_string()),
            access,
            extra_dirs.clone(),
            effort.clone(),
            None,
        ),
        Err(why) => Err(why),
    }
}

/// Start a round, as the `chat_round` route asks for it.
///
/// Validates the whole order BEFORE anything runs. A round that discovered a bad
/// seat halfway through would already have spent money on the seats before it,
/// and the user asked for a discussion, not most of one.
#[allow(clippy::too_many_arguments)]
pub fn start_round_impl(
    rounds: Arc<Rounds>,
    manager: Arc<ChatManager>,
    key: String,
    order: Vec<String>,
    text: String,
    cwd: String,
    access: Option<crate::agent_chat::Access>,
    extra_dirs: Option<Vec<String>>,
    effort: Option<String>,
    // What to show the seats of what came before. `None` is the mechanical
    // window; `Some(vec![])` is "answer this cold" and is a real choice, not an
    // absent one.
    history: Option<Vec<Said>>,
) -> Result<(), String> {
    if text.trim().is_empty() {
        return Err("a round needs something to answer".into());
    }
    for seat_id in &order {
        crate::chat_room::target_impl(&manager, &key, Some(seat_id))?;
    }
    rounds.start(&key, order)?;
    run_round(
        rounds, manager, key, text, cwd, access, extra_dirs, effort, history,
    );
    Ok(())
}

/// The round in this chat as it stands, for the client to draw.
pub fn state_impl(rounds: &Rounds, key: &str) -> serde_json::Value {
    match rounds.peek(key) {
        None => serde_json::json!({ "running": false }),
        Some(round) => serde_json::json!({
            "running": true,
            "hand": round.hand,
            "waiting": round.waiting,
            "said": round.said.iter().map(|s| serde_json::json!({
                "name": s.name, "answered": s.answered,
            })).collect::<Vec<_>>(),
        }),
    }
}

/// Put ONE thing to ONE seat and wait for its answer.
///
/// The host agent's own tool (card 70), and deliberately narrower than a round:
/// the host says exactly what this seat is told, and gets exactly what it said
/// back, as the tool result. No window, no backdrop, no other seats — when the
/// host wants a discussion it starts a round instead.
///
/// Blocking on purpose. A tool that returned "I asked, check later" would leave
/// the host with nothing to reason about, which is the whole reason it asked.
pub fn ask_seat(
    rounds: &Rounds,
    manager: &Arc<ChatManager>,
    key: &str,
    seat_id: &str,
    prompt: &str,
    cwd: &str,
) -> Result<String, String> {
    if prompt.trim().is_empty() {
        return Err("a seat needs something to answer".into());
    }
    let crate::chat_room::Target::Seat(seat) =
        crate::chat_room::target_impl(manager, key, Some(seat_id))?
    else {
        return Err("that is the host, not a seat".into());
    };
    // A round already owns this chat's seats. Two things driving the same seat
    // would interleave two conversations in one transcript.
    if rounds.peek(key).is_some() {
        return Err("a round is running in this chat — wait for it, or stop it".into());
    }
    // A seat with no process behind it is a CALL, not a turn to wait for.
    // Nothing is spawned, nothing is listened for, and the answer is already
    // here by the time this returns.
    if seat.kind == crate::chat_room::SeatKind::OnDemand {
        let said = crate::agent_api::ask(&seat, key, prompt)?;
        rounds.remember(
            key,
            vec![Said {
                name: seat.name.clone(),
                text: said.clone(),
                answered: true,
            }],
        );
        return Ok(said);
    }
    let session = seat_session_key(key, &seat.id);
    let heard = listen_for(&session);
    let sent = speak_to(manager, key, &seat, prompt, cwd, None, &None, &None);
    if let Err(why) = sent {
        never_spoke(&session);
        return Err(why);
    }
    // The TOOL's cap, not the round's — see `ASK_TIMEOUT`.
    let answer = heard
        .recv_timeout(ASK_TIMEOUT)
        .map_err(|_| gave_up_on(&seat.name));
    // Only the LISTENER goes. Giving up here does not stop the seat, and its
    // answer still arrives — driven, so it is not mistaken for one the person
    // asked for, and `turn_ended` clears the mark when it lands.
    with_listening(|l| l.remove(&session));
    let answer = answer?;
    // What one seat said still joins the room's record, so a later round can
    // show the others what was already established.
    rounds.remember(
        key,
        vec![Said {
            name: seat.name.clone(),
            text: answer.clone(),
            answered: true,
        }],
    );
    Ok(answer)
}

/// The Tauri-free half of the host's `ask_agent` tool.
pub fn ask_seat_impl(
    rounds: Arc<Rounds>,
    manager: Arc<ChatManager>,
    key: String,
    seat_id: String,
    prompt: String,
    cwd: String,
) -> Result<String, String> {
    ask_seat(&rounds, &manager, &key, &seat_id, &prompt, &cwd)
}

/// The room is empty, so its discussion goes with it.
///
/// Card 82 removed "close the room", so the trigger is now the LAST SEAT
/// LEAVING — but the reason is unchanged: keeping the discussion while dropping
/// every person who had it is the same mistake in a quieter place. The next seat
/// to join would be shown a conversation nobody in the room remembers having.
pub fn forget_room(rounds: &Rounds, key: &str) {
    rounds.forget(key);
}

#[cfg(test)]
mod tests {
    use super::*;

    fn said(name: &str, text: &str) -> Said {
        Said {
            name: name.into(),
            text: text.into(),
            answered: true,
        }
    }

    #[test]
    fn the_first_seat_is_told_only_the_question() {
        let brief = round_brief("  Is this safe to ship?  ", &[]);

        assert_eq!(brief, "Is this safe to ship?");
        assert!(
            !brief.contains("==="),
            "nothing has been said yet, so there is no record to head"
        );
    }

    #[test]
    fn a_later_seat_is_shown_what_came_before_it_and_who_said_it() {
        // The whole reason a round runs in order. Without the attribution a seat
        // cannot answer anybody, it can only add another monologue.
        let brief = round_brief(
            "Is this safe to ship?",
            &[
                said("Codex", "The migration is not reversible."),
                said("Claude", "Agreed, and untested."),
            ],
        );

        assert!(brief.starts_with("Is this safe to ship?"));
        assert!(brief.contains("--- Codex ---"));
        assert!(brief.contains("The migration is not reversible."));
        assert!(brief.contains("--- Claude ---"));
        assert!(brief.contains("Agreed, and untested."));
        assert!(
            brief.find("Codex").unwrap() < brief.find("Claude").unwrap(),
            "the record has to read in the order it was said"
        );
        assert!(brief.trim_end().ends_with("=== over to you ==="));
    }

    #[test]
    fn a_seat_that_failed_is_still_named_in_the_brief() {
        // Dropping it silently would let the next seat believe the round had
        // been quieter than it was, and the brief would disagree with the screen.
        let brief = round_brief(
            "Is this safe to ship?",
            &[Said {
                name: "Codex".into(),
                text: "boom".into(),
                answered: false,
            }],
        );

        assert!(brief.contains("--- Codex ---"));
        assert!(brief.contains("did not answer"));
        assert!(
            !brief.contains("boom"),
            "the failure's innards are not the discussion"
        );
    }

    #[test]
    fn a_round_hands_out_its_seats_in_order_and_never_twice() {
        let r = Rounds::default();
        r.start("chat-a", vec!["s1".into(), "s2".into()]).unwrap();

        let (first, before) = r.next("chat-a").expect("someone must be first");
        assert_eq!(first, "s1");
        assert!(before.is_empty());

        r.record("chat-a", said("Codex", "it is not reversible"));
        let (second, before) = r.next("chat-a").expect("and someone second");
        assert_eq!(second, "s2");
        assert_eq!(
            before.len(),
            1,
            "the second seat sees the first one's answer"
        );
        assert_eq!(before[0].text, "it is not reversible");

        assert!(r.next("chat-a").is_none(), "the round is over");
    }

    #[test]
    fn two_rounds_at_once_in_one_chat_are_refused() {
        // Two would interleave two conversations into one transcript and neither
        // would read as a discussion.
        let r = Rounds::default();
        r.start("chat-a", vec!["s1".into()]).unwrap();
        assert!(r.start("chat-a", vec!["s2".into()]).is_err());
        // A different chat is a different room.
        assert!(r.start("chat-b", vec!["s1".into()]).is_ok());
    }

    #[test]
    fn a_round_with_nobody_in_it_is_refused() {
        assert!(Rounds::default().start("chat-a", vec![]).is_err());
    }

    #[test]
    fn a_raised_hand_stops_the_round_before_the_next_seat() {
        // Nothing further runs, so nothing further is billed. This is the
        // difference between cutting in and waiting out three more agents.
        let r = Rounds::default();
        r.start("chat-a", vec!["s1".into(), "s2".into(), "s3".into()])
            .unwrap();
        assert_eq!(r.next("chat-a").unwrap().0, "s1");
        r.record("chat-a", said("Codex", "one"));

        r.raise_hand("chat-a");

        assert!(
            r.next("chat-a").is_none(),
            "a seat ran after the hand went up"
        );
        // The queue is EMPTIED, not just skipped. `next` short-circuits on the
        // hand either way, so without this the clear is uncovered — and a round
        // still reporting two seats as "waiting" would draw a UI promising
        // answers that are never coming.
        assert!(
            r.peek("chat-a").unwrap().waiting.is_empty(),
            "the seats that will never run are still listed as waiting"
        );
        let over = r.finish("chat-a").unwrap();
        assert!(over.hand);
        assert_eq!(over.said.len(), 1, "what WAS said is kept");
    }

    /// A room with one seat in it, ready to be asked something.
    fn one_seat() -> (Arc<Rounds>, Arc<ChatManager>, String) {
        let rounds = Arc::new(Rounds::default());
        let m = Arc::new(ChatManager::default());
        let seat = crate::chat_room::add_seat_impl(
            &m,
            "chat-a",
            crate::chat_room::NewSeat::for_test("Codex", crate::agent_chat::ChatAgent::Codex),
        )
        .unwrap();
        (rounds, m, seat.id)
    }

    #[test]
    fn a_round_naming_a_seat_that_is_not_there_is_refused_before_anything_runs() {
        // Validating halfway through would already have spent money on the
        // seats before the bad one, and the user asked for a discussion, not
        // most of one.
        let (rounds, m, good) = one_seat();

        let err = start_round_impl(
            rounds.clone(),
            m,
            "chat-a".into(),
            vec![good, "s99".into()],
            "is this safe?".into(),
            "/tmp".into(),
            None,
            None,
            None,
            None,
        )
        .expect_err("an unknown seat must refuse the whole round");

        assert!(err.contains("no seat"), "unhelpful refusal: {err}");
        assert!(
            !rounds.peek("chat-a").is_some(),
            "a refused round must not be left open"
        );
    }

    #[test]
    fn a_round_with_nothing_to_answer_is_refused() {
        let (rounds, m, seat) = one_seat();

        assert!(start_round_impl(
            rounds.clone(),
            m,
            "chat-a".into(),
            vec![seat],
            "   ".into(),
            "/tmp".into(),
            None,
            None,
            None,
            None,
        )
        .is_err());
        assert!(!rounds.peek("chat-a").is_some());
    }

    fn a_seat() -> Seat {
        Seat {
            id: "s1".into(),
            name: "Dee".into(),
            agent: crate::agent_chat::ChatAgent::Claude,
            model: None,
            role: None,
            context: crate::chat_room::ContextMode::Project,
            kind: crate::chat_room::SeatKind::Resident,
            joined_at: 0,
            provider: None,
        }
    }

    #[test]
    fn the_hosts_own_full_stop_is_simply_ignored() {
        // Every turn of every ordinary chat goes through this — no seat, so
        // nothing is owed an answer. It has to be silent and it must not panic.
        turn_ended(Arc::new(ChatManager::default()), "chat-a", None, "done");
    }

    #[test]
    fn a_seat_in_a_room_that_is_gone_is_reported_rather_than_panicking() {
        // The follow-up path on a manager that has never heard of this chat.
        // Nothing can be sent, and the only right answer is to say so and carry
        // on: the seat's words are in the transcript whatever happens here.
        let seat = a_seat();
        turn_ended(
            Arc::new(ChatManager::default()),
            "chat-a",
            Some(&seat),
            "a seat nobody is waiting on",
        );
        // `ask_host` works on a thread of its own, so give it a moment to fail
        // where a panic would still take the test down with it.
        std::thread::sleep(Duration::from_millis(200));
    }

    #[test]
    fn a_chat_with_no_round_says_so_rather_than_nothing() {
        let rounds = Rounds::default();
        assert_eq!(state_impl(&rounds, "chat-a")["running"], false);
        rounds.start("chat-a", vec!["s1".into()]).unwrap();
        let live = state_impl(&rounds, "chat-a");
        assert_eq!(live["running"], true);
        assert_eq!(live["waiting"][0], "s1");
    }

    #[test]
    fn a_round_never_thinks_harder_than_it_can_safely_carry() {
        // Starfall measured this one: six seconds on a low tier against
        // twenty-four minutes with no output on xhigh, for the same prompt.
        assert_eq!(
            round_effort(&Some("xhigh".into())).as_deref(),
            Some("medium")
        );
        assert_eq!(
            round_effort(&Some("high".into())).as_deref(),
            Some("medium")
        );
        assert_eq!(round_effort(&Some("max".into())).as_deref(), Some("medium"));
        // `auto` is not a level, it is "the agent picks" — which could be the
        // top tier, so it comes down too.
        assert_eq!(
            round_effort(&Some("auto".into())).as_deref(),
            Some("medium")
        );
        // Nothing chosen at all still gets the cap rather than the default.
        assert_eq!(round_effort(&None).as_deref(), Some("medium"));
        // At or below the cap, the choice stands.
        assert_eq!(round_effort(&Some("low".into())).as_deref(), Some("low"));
        assert_eq!(
            round_effort(&Some("minimal".into())).as_deref(),
            Some("minimal")
        );
    }

    #[test]
    fn cutting_in_stops_the_wait_for_whoever_is_speaking() {
        // Without this the driver sits in `recv_timeout` for the seat already
        // going, so the bar reads "stopped" while the round stays open — for up
        // to SEAT_TIMEOUT, which is twenty minutes.
        let r = Rounds::default();
        r.start("chat-a", vec!["s1".into(), "s2".into()]).unwrap();
        let (seat, _) = r.next("chat-a").unwrap();
        let session = seat_session_key("chat-a", &seat);
        let heard = listen_for(&session);
        r.speaking("chat-a", Some(session.clone()));

        r.raise_hand("chat-a");

        // The sender is gone, so the driver's wait ends NOW rather than at the
        // timeout.
        assert!(
            heard.recv_timeout(Duration::from_millis(50)).is_err(),
            "the round is still waiting on a seat nobody wants to hear from"
        );
        assert!(r.peek("chat-a").unwrap().speaking.is_none());
    }

    // ---- card 69: how much of the discussion a seat is sent ----------------

    #[test]
    fn a_short_discussion_is_sent_whole() {
        let record: Vec<Said> = (0..3)
            .map(|i| said("Codex", &format!("point {i}")))
            .collect();

        let sent = discussion_window(&record, 0, 24);

        assert_eq!(sent.len(), 3);
        assert_eq!(sent[0].text, "point 0");
    }

    #[test]
    fn a_long_discussion_is_cut_to_the_window_keeping_the_newest() {
        // Starfall: 每轮重发整场 ＝ 成本随轮数平方增长 — re-sending the whole
        // thing every round makes cost grow with the SQUARE of the round count,
        // and the answers get worse as attention spreads over old rounds.
        let record: Vec<Said> = (0..40)
            .map(|i| said("Codex", &format!("point {i}")))
            .collect();

        let sent = discussion_window(&record, 0, 24);

        assert_eq!(sent.len(), 24, "the window is not being applied");
        assert_eq!(
            sent[0].text, "point 16",
            "the window kept the OLDEST, not the newest"
        );
        assert_eq!(sent[23].text, "point 39");
    }

    #[test]
    fn a_new_topic_sends_nothing_from_before_it() {
        // The judgement, in one line from Starfall: 这一轮要答的问题，需要上一个
        // 话题的哪一句？答不出来就 --fresh. Everything before the marker is gone
        // for good, not merely deprioritised.
        let record: Vec<Said> = (0..10)
            .map(|i| said("Codex", &format!("point {i}")))
            .collect();

        let sent = discussion_window(&record, 7, 24);

        assert_eq!(sent.len(), 3);
        assert_eq!(sent[0].text, "point 7");
        assert!(
            !sent.iter().any(|s| s.text == "point 6"),
            "a new topic still sent the old one"
        );
    }

    #[test]
    fn the_window_applies_inside_a_topic_not_across_it() {
        // Both rules at once: start from the topic, then keep the newest N of
        // what is left.
        let record: Vec<Said> = (0..40)
            .map(|i| said("Codex", &format!("point {i}")))
            .collect();

        let sent = discussion_window(&record, 30, 5);

        assert_eq!(sent.len(), 5);
        assert_eq!(sent[0].text, "point 35");
    }

    #[test]
    fn a_topic_marker_past_the_end_sends_nothing_rather_than_panicking() {
        // A marker can outrun the record when a topic is started before anyone
        // has spoken in it. Nothing to send is the right answer; a panic here
        // would take the whole round down.
        let record: Vec<Said> = vec![said("Codex", "one")];

        assert!(discussion_window(&record, 5, 24).is_empty());
        assert!(discussion_window(&[], 0, 24).is_empty());
    }

    #[test]
    fn a_window_of_zero_is_read_as_no_limit_rather_than_no_history() {
        // A config that meant "send nothing" would silently make every seat
        // answer with no idea what was being discussed, and nothing on screen
        // would say why the answers went strange.
        let record: Vec<Said> = (0..5)
            .map(|i| said("Codex", &format!("point {i}")))
            .collect();

        assert_eq!(discussion_window(&record, 0, 0).len(), 5);
    }

    #[test]
    fn with_no_instruction_the_backdrop_is_the_mechanical_window() {
        let record: Vec<Said> = (0..40)
            .map(|i| said("Codex", &format!("point {i}")))
            .collect();

        let sent = backdrop(&record, 0, 24, None);

        assert_eq!(sent.len(), 24);
        assert_eq!(sent[23].text, "point 39");
    }

    #[test]
    fn the_host_can_send_a_seat_exactly_what_it_chooses() {
        // The host knows what this seat is FOR. A reviewer brought in to read
        // one function does not need forty rounds about something else, and
        // sending them anyway is both the expensive answer and the worse one.
        let record: Vec<Said> = (0..40)
            .map(|i| said("Codex", &format!("point {i}")))
            .collect();
        let chosen = vec![said("Claude", "only this matters")];

        let sent = backdrop(&record, 0, 24, Some(&chosen));

        assert_eq!(sent.len(), 1);
        assert_eq!(sent[0].text, "only this matters");
        assert!(
            !sent.iter().any(|s| s.text.starts_with("point")),
            "the mechanical window leaked in on top of the host's choice"
        );
    }

    #[test]
    fn the_host_can_send_a_seat_nothing_at_all() {
        // An EMPTY choice is a choice — "answer this cold" — and must not fall
        // back to the window. That distinction is the whole point of an outside
        // opinion: give it the discussion and it stops being outside.
        let record: Vec<Said> = (0..40)
            .map(|i| said("Codex", &format!("point {i}")))
            .collect();

        assert!(backdrop(&record, 0, 24, Some(&[])).is_empty());
    }

    #[test]
    fn what_was_said_outlives_the_round_that_said_it() {
        // A round ends; the discussion does not. The next round has to be able
        // to show a seat what the last one concluded.
        let r = Rounds::default();
        r.remember("chat-a", vec![said("Codex", "it is not reversible")]);
        r.remember("chat-a", vec![said("Claude", "agreed")]);

        assert_eq!(r.backdrop_since("chat-a", 0, None).len(), 2);
        assert_eq!(r.backdrop_since("chat-a", 0, None)[1].text, "agreed");
    }

    #[test]
    fn a_new_topic_draws_a_line_the_window_cannot_reach_back_over() {
        let r = Rounds::default();
        r.remember("chat-a", vec![said("Codex", "about the migration")]);

        r.new_topic("chat-a");
        assert!(
            r.backdrop_since("chat-a", 0, None).is_empty(),
            "a fresh topic still sent the old one"
        );

        r.remember("chat-a", vec![said("Codex", "about the parser")]);
        let now = r.backdrop_since("chat-a", 0, None);
        assert_eq!(now.len(), 1);
        assert_eq!(now[0].text, "about the parser");
    }

    #[test]
    fn a_chat_that_has_never_had_a_round_has_nothing_to_show() {
        assert!(Rounds::default()
            .backdrop_since("chat-a", 0, None)
            .is_empty());
    }

    #[test]
    fn the_hosts_choice_beats_the_record_here_too() {
        let r = Rounds::default();
        r.remember(
            "chat-a",
            vec![said("Codex", "forty rounds about something else")],
        );

        let chosen = vec![said("Claude", "only this")];
        assert_eq!(r.backdrop_since("chat-a", 0, Some(&chosen)).len(), 1);
        assert!(r.backdrop_since("chat-a", 0, Some(&[])).is_empty());
    }

    // ---- card 71: a seat with no process behind it -------------------------

    /// A room holding one ON-DEMAND seat. Nothing is spawned for it, which is
    /// what lets this be tested at all.
    fn one_api_seat() -> (Arc<Rounds>, Arc<ChatManager>, String) {
        let rounds = Arc::new(Rounds::default());
        let m = Arc::new(ChatManager::default());
        let mut want =
            crate::chat_room::NewSeat::for_test("Outside eye", crate::agent_chat::ChatAgent::Codex);
        want.kind = Some(crate::chat_room::SeatKind::OnDemand);
        want.context = Some(crate::chat_room::ContextMode::RoomOnly);
        let seat = crate::chat_room::add_seat_impl(&m, "chat-a", want).unwrap();
        (rounds, m, seat.id)
    }

    #[test]
    fn an_on_demand_seat_answers_without_anything_being_spawned() {
        // The whole point of the kind. A resident seat needs a process, a
        // session and a turn to come back; this one is a call that returns.
        let (rounds, m, seat) = one_api_seat();

        let said = ask_seat(&rounds, &m, "chat-a", &seat, "is this safe?", "/tmp")
            .expect("an on-demand seat should answer with no process at all");

        assert!(!said.is_empty());
        assert!(
            crate::agent_chat::chat_list_impl(&m).unwrap().is_empty(),
            "something was spawned for a seat that has no process"
        );
    }

    #[test]
    fn what_an_on_demand_seat_says_joins_the_rooms_record() {
        // So a later round can show the others what it established. Nothing
        // about the kind should change that.
        let (rounds, m, seat) = one_api_seat();

        ask_seat(&rounds, &m, "chat-a", &seat, "is this safe?", "/tmp").unwrap();

        let record = rounds.backdrop_since("chat-a", 0, None);
        assert_eq!(record.len(), 1);
        assert_eq!(record[0].name, "Outside eye");
        assert!(record[0].answered);
    }

    #[test]
    fn an_on_demand_seat_asked_nothing_is_refused() {
        let (rounds, m, seat) = one_api_seat();

        assert!(ask_seat(&rounds, &m, "chat-a", &seat, "   ", "/tmp").is_err());
    }

    // ---- card 77: a seat sees the room from when it joined -----------------

    #[test]
    fn a_newcomer_is_not_shown_what_was_said_before_it_arrived() {
        // WhatsApp's rule, and the reason for borrowing it: nobody has to be
        // told what a seat knows, because everyone already knows this one.
        let r = Rounds::default();
        r.remember(
            "chat-a",
            (0..5)
                .map(|i| said("Codex", &format!("point {i}")))
                .collect(),
        );

        // Joined after five things had been said.
        let sent = r.backdrop_since("chat-a", 5, None);

        assert!(
            sent.is_empty(),
            "a newcomer was handed the backlog: {sent:?}"
        );
    }

    #[test]
    fn a_seat_that_was_there_throughout_sees_the_room_as_it_always_did() {
        let r = Rounds::default();
        r.remember(
            "chat-a",
            (0..5)
                .map(|i| said("Codex", &format!("point {i}")))
                .collect(),
        );

        let sent = r.backdrop_since("chat-a", 0, None);

        assert_eq!(sent.len(), 5);
        assert_eq!(sent[0].text, "point 0");
    }

    #[test]
    fn a_seat_sees_only_what_happened_after_it_joined() {
        let r = Rounds::default();
        r.remember(
            "chat-a",
            (0..5)
                .map(|i| said("Codex", &format!("point {i}")))
                .collect(),
        );
        r.remember("chat-a", vec![said("Claude", "after you arrived")]);

        let sent = r.backdrop_since("chat-a", 5, None);

        assert_eq!(sent.len(), 1);
        assert_eq!(sent[0].text, "after you arrived");
    }

    #[test]
    fn the_topic_marker_still_cuts_above_an_older_join_point() {
        // Three cuts stack and the TIGHTEST wins. A seat present from the start
        // is still not shown a topic the room has moved on from.
        let r = Rounds::default();
        r.remember(
            "chat-a",
            (0..5)
                .map(|i| said("Codex", &format!("point {i}")))
                .collect(),
        );
        r.new_topic("chat-a");
        r.remember("chat-a", vec![said("Codex", "the new topic")]);

        let sent = r.backdrop_since("chat-a", 0, None);

        assert_eq!(
            sent.len(),
            1,
            "the topic marker was overridden by the join point"
        );
        assert_eq!(sent[0].text, "the new topic");
    }

    #[test]
    fn the_window_still_caps_a_seat_that_has_been_there_throughout() {
        // Without a ceiling, a seat present for 200 exchanges is sent all 200
        // every round — the squared cost card 69 exists to prevent.
        let r = Rounds::default();
        r.remember(
            "chat-a",
            (0..40)
                .map(|i| said("Codex", &format!("point {i}")))
                .collect(),
        );

        let sent = r.backdrop_since("chat-a", 0, None);

        assert_eq!(sent.len(), DEFAULT_WINDOW);
        assert_eq!(sent[0].text, "point 16");
    }

    #[test]
    fn the_hosts_choice_still_beats_all_three_cuts() {
        let r = Rounds::default();
        r.remember(
            "chat-a",
            (0..40)
                .map(|i| said("Codex", &format!("point {i}")))
                .collect(),
        );
        let chosen = vec![said("Claude", "only this")];

        assert_eq!(r.backdrop_since("chat-a", 39, Some(&chosen)).len(), 1);
        assert!(r.backdrop_since("chat-a", 0, Some(&[])).is_empty());
    }

    #[test]
    fn a_tool_call_does_not_wait_as_long_as_a_round_does() {
        // A round runs in the background and nobody is watching it, so twenty
        // minutes for a considered answer is right. `ask_agent` is a tool call
        // the HOST is blocked on, and a host that stops for twenty minutes is a
        // chat that looks dead — which is exactly how this was reported.
        assert!(
            ASK_TIMEOUT < SEAT_TIMEOUT,
            "a blocked tool must give up sooner than a background round"
        );
        assert!(
            ASK_TIMEOUT >= Duration::from_secs(60),
            "a cold agent start alone can take most of a minute"
        );
    }

    #[test]
    fn giving_up_on_a_seat_says_the_answer_is_still_coming() {
        // The answer is NOT lost when the wait ends. A resident seat has its own
        // process and its own reader, so whatever it says still reaches the
        // transcript and the screen — only the host's copy is missed. Saying
        // "it did not answer" would be false and would send the host looking
        // for a failure that never happened.
        let said = gave_up_on("Codex");

        assert!(said.contains("Codex"));
        assert!(
            said.contains("still") || said.contains("appear"),
            "it must say the answer is on its way: {said}"
        );
        assert!(
            !said.to_lowercase().contains("failed"),
            "nothing failed: {said}"
        );
    }

    #[test]
    fn the_host_is_shown_who_said_what_and_told_they_are_not_the_person() {
        // The host runs as its own process and has read NONE of this. A brief
        // that only said "answer them" would have it answering something it
        // cannot see, and one that did not say whose words these are would have
        // it replying to the seats as though they were the person.
        let brief = followup_brief(&[
            said("Dee", "  The migration is not reversible.  "),
            Said {
                name: "Codex".into(),
                text: "timed out".into(),
                answered: false,
            },
        ]);

        assert!(brief.starts_with("=== what the others in this chat just said ==="));
        assert!(brief.contains("--- Dee ---\nThe migration is not reversible."));
        assert!(
            brief.contains("--- Codex ---\n(did not answer)"),
            "a seat that failed is still named: {brief}"
        );
        assert!(
            brief.contains("not the person"),
            "the host must be told whose words these are: {brief}"
        );
    }

    #[test]
    fn the_brief_head_is_the_one_the_client_draws_a_line_for() {
        // web/src/lib/relay.ts recognises a brief by this exact first line and
        // draws it as ONE LINE instead of quoting the whole discussion twice.
        // Changing it here without changing it there is silent: the brief still
        // works, it just arrives on screen as a wall of text.
        let head = followup_brief(&[said("Dee", "yes")])
            .lines()
            .next()
            .unwrap()
            .to_string();
        let ts = include_str!("../../web/src/lib/relay.ts");

        assert!(
            ts.contains(&format!("\"{head}\"")),
            "relay.ts does not know this head: {head}"
        );
    }

    #[test]
    fn a_seat_the_person_asked_directly_is_not_mistaken_for_a_driven_one() {
        // The whole rule `turn_ended` turns on. A round and `ask_agent` both
        // register before they speak; nothing registers for `@dee look at
        // this`, and that absence is what says the host has not heard it.
        let session = seat_session_key("chat-a", "s1");
        assert!(!with_driven(|d| d.contains(&session)));

        let _heard = listen_for(&session);
        assert!(with_driven(|d| d.contains(&session)));

        never_spoke(&session);
        assert!(!with_driven(|d| d.contains(&session)));
    }

    #[test]
    fn cutting_in_leaves_the_mark_so_a_late_answer_is_still_a_round_s() {
        // `raise_hand` drops the LISTENER so the driver stops waiting at once.
        // The seat is not stopped by that, and its answer still lands — and
        // must not then look like one the person asked for, or the host would
        // be handed a follow-up about the round they had just stopped.
        let r = Rounds::default();
        r.start("chat-b", vec!["s1".into()]).unwrap();
        let session = seat_session_key("chat-b", "s1");
        let _heard = listen_for(&session);
        r.speaking("chat-b", Some(session.clone()));

        r.raise_hand("chat-b");

        assert!(
            !with_listening(|l| l.contains_key(&session)),
            "the driver must stop waiting at once"
        );
        assert!(
            with_driven(|d| d.contains(&session)),
            "a late answer must still be known as the round's"
        );
        never_spoke(&session);
    }

    #[test]
    fn a_dead_process_stops_being_waited_on_and_stops_being_marked() {
        // A seat killed part-way through — the chat was stopped, the room was
        // swept, the agent crashed. Left marked, the follow-up on the very next
        // thing it was asked would be swallowed as though a round still had it.
        let session = seat_session_key("chat-c", "s1");
        let heard = listen_for(&session);

        session_gone(&session);

        assert!(!with_driven(|d| d.contains(&session)));
        assert!(
            heard.recv_timeout(Duration::from_millis(100)).is_err(),
            "a driver must not go on waiting twenty minutes for a dead process"
        );
    }

    #[test]
    fn a_finished_round_is_no_longer_running() {
        let r = Rounds::default();
        assert!(!r.peek("chat-a").is_some());
        r.start("chat-a", vec!["s1".into()]).unwrap();
        assert!(r.peek("chat-a").is_some());
        r.finish("chat-a");
        assert!(!r.peek("chat-a").is_some());
        // And a second start is fine once the first is done.
        assert!(r.start("chat-a", vec!["s1".into()]).is_ok());
    }
}
