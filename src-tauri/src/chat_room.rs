//! Rooms: several agents under one chat.
//!
//! A chat has always been one agent and one process. A ROOM is a chat that has
//! been opened up to hold several — a host plus any number of SEATS — so a
//! conversation can have more than one voice in it, and every message says
//! which voice it was.
//!
//! ## Why this is a module and not part of `agent_chat`
//!
//! Only the FILE is split, not the ownership. `ChatManager` still holds the
//! sessions AND the rooms, because the two are genuinely entangled: a seat that
//! speaks needs a session, and a round needs both at once. Splitting the state
//! would buy a tidy diagram and cost a lock-ordering problem.
//!
//! What is split out is room bookkeeping, which has nothing to do with reading
//! an agent's JSON stream — the one thing `agent_chat` is for, in what was
//! already the largest file in this crate before rooms existed.
//!
//! ## The one rule everything here serves
//!
//! **A chat that is not a room must be byte-for-byte the chat that shipped
//! before rooms existed.** That is why a room is ABSENT from the map rather
//! than present-and-closed, why a host's events are never touched on their way
//! out, and why `add_seat_impl` refuses rather than quietly opening a room.
//!
//! Prior art for the shape of a room — who sits at it, what each seat is for,
//! and why the seat that cannot see the project is the most valuable one there
//! — is Starfall's round-table (`.claude/rules/roundtable.md` in that repo).
use std::sync::Arc;

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tauri::State;

use crate::agent_chat::{safe_model, ChatAgent, ChatManager};

/// What a seat is allowed to see.
///
/// Stored by card 66, USED by card 69. It is here from the start because a seat
/// that gains a field later has to be reshaped everywhere it is already
/// persisted, and because the choice is made when the seat is added — not when
/// the context policy finally reads it.
///
/// The names come from Starfall's round-table, where the point is made sharply:
/// a seat that cannot see the project is not a crippled seat, it is the only one
/// reading as a newcomer would. Give it everything and it becomes a second copy
/// of the host, and the second opinion it was added for is gone.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ContextMode {
    /// Only what has been said in this room. No project files.
    RoomOnly,
    /// The room AND the project — what every chat in this app has always had.
    /// The default, so a seat added without a thought about this behaves like
    /// the chat the user already knows.
    #[default]
    Project,
}

/// What kind of thing is behind a seat.
///
/// A RESIDENT is a CLI agent with a process of its own — Claude or Codex, started
/// when it is first spoken to and running until the room closes.
///
/// An ON-DEMAND seat has no process at all. It is an HTTP call: asked, answered,
/// gone. Nothing of it exists between questions, which is what makes it cheap
/// enough to keep around for the rare one. The trade is that it has no memory of
/// its own — it is told everything it needs every time, or it knows nothing.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SeatKind {
    /// A CLI agent with a process. The default, and what every seat was before
    /// card 71.
    #[default]
    Resident,
    /// An HTTP call with nothing behind it between questions.
    OnDemand,
}

/// One seat at the table: an agent that has been added to a room.
///
/// A seat is a RECORD, not a running process. This app has never started an
/// agent until someone actually says something to it (see the note in
/// `web/src/lib/store.ts`), and a seat nobody has spoken to yet is exactly that
/// case — spawning one on `add` would leave idle agents holding memory for a
/// conversation that may never involve them. Card 67 starts the process on the
/// first message.
#[derive(Debug, Clone, Serialize)]
pub struct Seat {
    /// Ours, never the browser's. It becomes part of a session key, so it is
    /// generated file-safe rather than validated after the fact.
    pub id: String,
    /// What the user sees on the message and in the rail.
    pub name: String,
    pub agent: ChatAgent,
    pub model: Option<String>,
    /// What this seat was added FOR, in the user's own words. Free text: it is
    /// shown to the user and given to the seat, never parsed.
    pub role: Option<String>,
    pub context: ContextMode,
    /// Whether there is a process behind this seat, or only an HTTP call.
    pub kind: SeatKind,
    /// Which service answers for an ON-DEMAND seat — `"deepseek"`, and more
    /// later. Absent for a resident seat, which is answered by its own process.
    ///
    /// Deliberately NOT folded into `agent`. That field is the allowlist of
    /// binaries this app may SPAWN, and putting a name there that is not a
    /// program would put it one bug away from being executed.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub provider: Option<String>,
}

/// A seat as the client asks for it, before the backend gives it an id.
#[derive(Debug, Clone, Deserialize)]
pub struct NewSeat {
    pub name: String,
    pub agent: ChatAgent,
    #[serde(default)]
    pub model: Option<String>,
    #[serde(default)]
    pub role: Option<String>,
    #[serde(default)]
    pub context: Option<ContextMode>,
    #[serde(default)]
    pub kind: Option<SeatKind>,
    #[serde(default)]
    pub provider: Option<String>,
}

impl NewSeat {
    /// The shape a test wants: a name and an agent, everything else defaulted.
    /// `for_test` is the same thing, reachable from another module's tests.
    #[cfg(test)]
    pub(crate) fn for_test(name: &str, agent: ChatAgent) -> Self {
        Self::named(name, agent)
    }

    #[cfg(test)]
    fn named(name: &str, agent: ChatAgent) -> Self {
        Self {
            name: name.to_string(),
            agent,
            model: None,
            role: None,
            context: None,
            kind: None,
            provider: None,
        }
    }
}

/// A chat that has been opened as a room, and who is sitting in it.
///
/// Absent from the map entirely for an ordinary chat — which is what makes "a
/// chat with room mode off is byte-for-byte the chat that exists today" true by
/// construction rather than by remembering to check a flag.
#[derive(Default)]
pub(crate) struct Room {
    seats: Vec<Seat>,
    /// Counts up for the life of the room, so a removed seat's id is never
    /// handed out again. Reusing one would attach a dead seat's messages to a
    /// live seat on a client that had not caught up.
    next: u64,
}

/// The session key a seat's own process runs under.
///
/// A seat is its own process, so it needs its own entry in the sessions map —
/// but its WORDS belong to the room's transcript, not to a record of its own.
/// Those are two different keys, and `Voice` in `agent_chat` is what keeps them
/// apart.
///
/// The shape has to stay inside what `transcript::path_for` accepts
/// (alphanumerics, `-`, `_`, `:`). The seat id is generated file-safe by
/// `add_seat_impl` for exactly this reason, so the only thing this adds is a
/// separator that cannot collide with the room's own key.
pub(crate) fn seat_session_key(room: &str, seat_id: &str) -> String {
    format!("{room}-seat-{seat_id}")
}

/// Where a seat runs, and what else it may reach.
///
/// A `Project` seat works where the chat works — the same folder, the same
/// extra folders — which is what every agent in this app has always had.
///
/// A `RoomOnly` seat is put somewhere the project is NOT, and given no extra
/// folders at all. This is the one place the context mode stops being a label
/// and becomes true: an agent merely TOLD to ignore the repository will read it
/// the moment the question gets hard, and then it is a second copy of the host
/// rather than the outside opinion it was added to be. Starfall solves it the
/// same way and says why — 关进一个空目录跑, *run it shut in an empty directory*,
/// after which it will tell you plainly that it cannot see the repo.
///
/// Each such seat gets its OWN folder. Sharing one would let two seats read each
/// other's scratch files, which is a side channel between two opinions that are
/// supposed to be independent.
pub fn seat_workspace(
    seat: &Seat,
    room_key: &str,
    project_cwd: &str,
    extra_dirs: &[String],
) -> (String, Vec<String>) {
    match seat.context {
        ContextMode::Project => (project_cwd.to_string(), extra_dirs.to_vec()),
        ContextMode::RoomOnly => (
            std::env::temp_dir()
                // Named by ROOM and seat, not by seat alone. Seat ids are
                // per-room counters, so every room has an `s1` — and naming the
                // folder after that gave two unrelated conversations' outside
                // seats the same scratch directory, which is a side channel
                // between two discussions that never met.
                .join(format!(
                    "octiq-outside-{}",
                    seat_session_key(room_key, &seat.id)
                ))
                .to_string_lossy()
                .into_owned(),
            Vec::new(),
        ),
    }
}

/// Who a message is addressed to.
#[derive(Debug, Clone)]
pub enum Target {
    /// The chat's own agent — every message of every chat that is not a room,
    /// and the default inside one.
    Host,
    /// One named seat.
    Seat(Seat),
}

/// Resolve "who is this for" before anything is sent.
///
/// An unknown seat is REFUSED, never quietly answered by the host. Falling back
/// would put a message meant for one agent in front of a different one — worse
/// than not sending it, because the sender would never know.
pub fn target_impl(manager: &ChatManager, key: &str, to: Option<&str>) -> Result<Target, String> {
    let Some(seat_id) = to else {
        return Ok(Target::Host);
    };
    let rooms = manager.rooms.lock().map_err(|e| e.to_string())?;
    let seat = rooms
        .get(key)
        .and_then(|room| room.seats.iter().find(|s| s.id == seat_id))
        .ok_or_else(|| format!("no seat '{seat_id}' in this chat"))?;
    Ok(Target::Seat(seat.clone()))
}

/// Turn room mode on or off for a chat.
///
/// Turning it OFF empties the room. A closed room that quietly kept its seats
/// would bring them all back on the next flick of the switch, which is not what
/// "off" looks like to the person who turned it off.
/// Returns the session key of every seat that was in it, so the caller can end
/// their processes. A seat is a running agent once it has spoken, and a room
/// that forgot its seats while they kept running would defeat `MAX_SEATS`
/// entirely: close and reopen eight times and there are sixty-four of them.
pub fn set_room_impl(manager: &ChatManager, key: &str, open: bool) -> Result<Vec<String>, String> {
    let mut rooms = manager.rooms.lock().map_err(|e| e.to_string())?;
    if open {
        rooms.entry(key.to_string()).or_default();
        return Ok(Vec::new());
    }
    Ok(rooms
        .remove(key)
        .map(|room| {
            room.seats
                .iter()
                .map(|s| seat_session_key(key, &s.id))
                .collect()
        })
        .unwrap_or_default())
}

/// How many seats one room may hold.
///
/// A person clicking a button was never going to reach this. The host AGENT
/// gets the same power in card 70, and card 67 gives every seat a process of its
/// own — so an agent that decides more voices would help has, without this, a
/// way to spawn agents until the machine gives up. The limit belongs where seats
/// are created, not in the card that hands out the tool.
///
/// Eight is well past any round anyone would read and well short of anything
/// that hurts.
const MAX_SEATS: usize = 8;

/// Add a seat to a room. Refused when the chat is not a room.
///
/// The refusal is the BACKEND's. The client hides the control when room mode is
/// off, but a hidden button is a decision about drawing, not about what may
/// happen — and this is the one place that can actually hold the line.
pub fn add_seat_impl(manager: &ChatManager, key: &str, want: NewSeat) -> Result<Seat, String> {
    let name = want.name.trim();
    if name.is_empty() {
        return Err("a seat needs a name".into());
    }
    let mut rooms = manager.rooms.lock().map_err(|e| e.to_string())?;
    let room = rooms
        .get_mut(key)
        .ok_or("this chat is not a room, so it cannot take a seat")?;
    if room.seats.len() >= MAX_SEATS {
        return Err(format!("a room holds at most {MAX_SEATS} seats"));
    }
    room.next += 1;
    let seat = Seat {
        // Generated, not taken from the name: the name is the user's and can be
        // anything at all, and this ends up in a session key.
        id: format!("s{}", room.next),
        name: name.to_string(),
        agent: want.agent,
        model: want.model.and_then(|m| safe_model(&m)),
        role: want
            .role
            .map(|r| r.trim().to_string())
            .filter(|r| !r.is_empty()),
        context: want.context.unwrap_or_default(),
        kind: want.kind.unwrap_or_default(),
        provider: want
            .provider
            .map(|p| p.trim().to_ascii_lowercase())
            .filter(|p| !p.is_empty()),
    };
    room.seats.push(seat.clone());
    Ok(seat)
}

/// Remove one seat. A room that is not open, or a seat that is not in it, is
/// not an error worth shouting about — both mean "it is not there", which is
/// what the caller wanted.
/// Returns the session key of what was removed — empty when it was not there.
/// Dropping the record alone would leave the agent running.
pub fn remove_seat_impl(
    manager: &ChatManager,
    key: &str,
    seat_id: &str,
) -> Result<Vec<String>, String> {
    let mut rooms = manager.rooms.lock().map_err(|e| e.to_string())?;
    let Some(room) = rooms.get_mut(key) else {
        return Ok(Vec::new());
    };
    let before = room.seats.len();
    room.seats.retain(|s| s.id != seat_id);
    Ok(if room.seats.len() == before {
        Vec::new()
    } else {
        vec![seat_session_key(key, seat_id)]
    })
}

/// A room as the client needs to see it: whether it is one at all, and who is in
/// it.
///
/// `open` is not the same question as "are there seats", and the difference
/// matters after a restart. Rooms live in memory, so a backend that has been
/// restarted has forgotten every one of them — while the browser still has the
/// switch drawn on, from `localStorage`. An empty seat list alone cannot tell
/// "a room nobody has joined yet" from "a room this backend no longer knows
/// about"; `open` can.
#[derive(Debug, Clone, Serialize)]
pub struct RoomView {
    pub open: bool,
    pub seats: Vec<Seat>,
}

/// The Tauri-free half of `chat_room`.
///
/// ONE lock for both halves. Taking it twice would let a `set_room_impl(false)`
/// land in the gap and produce `open: true, seats: []` — which is the wrong
/// answer to the exact question this struct exists to answer, and a legal-looking
/// one, so nothing downstream could tell it was torn.
pub fn room_impl(manager: &ChatManager, key: &str) -> Result<RoomView, String> {
    let rooms = manager.rooms.lock().map_err(|e| e.to_string())?;
    Ok(match rooms.get(key) {
        Some(room) => RoomView {
            open: true,
            seats: room.seats.clone(),
        },
        None => RoomView {
            open: false,
            seats: Vec::new(),
        },
    })
}

/// Write who said this into the event, on its way to the record and the wire.
///
/// Two decisions are load-bearing here:
///
/// * **Inside the event, not on the envelope.** `transcript.rs` stores the event
///   alone and rebuilds `seq` from the line number, so a field left on the
///   envelope survives exactly as long as the socket does. Reopen the chat and
///   every message would come back anonymous.
/// * **`octiq_speaker`, not `speaker`.** This module's whole promise is that the
///   agent's JSON is passed through untouched, and `speaker` is an ordinary
///   enough word for an agent stream to claim one day. A namespaced key cannot
///   be mistaken for theirs, and the client renames it on the way in — the same
///   thing it already does to `parent_tool_use_id`.
///
/// A host event — `None` — is not touched at all, which is what keeps a chat
/// with no seats byte-for-byte the chat that shipped before this card.
pub(crate) fn stamp_speaker(event: &mut Value, seat: Option<&Seat>) {
    let Some(seat) = seat else { return };
    let Some(obj) = event.as_object_mut() else {
        return;
    };
    obj.insert(
        "octiq_speaker".into(),
        json!({ "id": seat.id, "name": seat.name, "agent": seat.agent.bin() }),
    );
}

/// End the processes named by `keys`.
///
/// Best-effort by design: a seat that never spoke has no process, and one whose
/// agent has already exited is gone too. Neither is an error — the point is that
/// nothing keeps running that the room no longer holds.
pub(crate) fn end_seats(manager: &ChatManager, keys: Vec<String>) {
    for key in keys {
        let _ = crate::agent_chat::chat_stop_impl(manager, key);
    }
}

/// Turn room mode on or off for a chat.
#[tauri::command]
pub fn chat_set_room(
    manager: State<Arc<ChatManager>>,
    rounds: State<Arc<crate::round::Rounds>>,
    key: String,
    open: bool,
) -> Result<(), String> {
    let ended = set_room_impl(&manager, &key, open)?;
    end_seats(&manager, ended);
    if !open {
        crate::round::forget_room(&rounds, &key);
    }
    Ok(())
}

/// Add a seat to a room.
#[tauri::command]
pub fn chat_add_agent(
    manager: State<Arc<ChatManager>>,
    key: String,
    seat: NewSeat,
) -> Result<Seat, String> {
    add_seat_impl(&manager, &key, seat)
}

/// Take a seat back out of a room.
#[tauri::command]
pub fn chat_remove_agent(
    manager: State<Arc<ChatManager>>,
    key: String,
    seat_id: String,
) -> Result<(), String> {
    let ended = remove_seat_impl(&manager, &key, &seat_id)?;
    end_seats(&manager, ended);
    Ok(())
}

/// Whether this chat is a room, and who is in it.
#[tauri::command]
pub fn chat_room(manager: State<Arc<ChatManager>>, key: String) -> Result<RoomView, String> {
    room_impl(&manager, &key)
}

#[cfg(test)]
mod room_tests {
    use super::*;

    /// Who is in this room. `room_impl` is the ONE reader — it takes the lock
    /// once and answers both halves together, so the tests go through it rather
    /// than round the side.
    fn seats_of(m: &ChatManager, key: &str) -> Vec<Seat> {
        room_impl(m, key).unwrap().seats
    }

    // ---- card 66: the room ----------------------------------------------

    #[test]
    fn a_chat_is_not_a_room_until_it_is_opened_as_one() {
        let m = ChatManager::default();
        // Room mode is OFF by default, and the refusal is the backend's, not
        // just the UI hiding a button: a client that calls this anyway on an
        // ordinary chat must not quietly turn it into a room.
        let err = add_seat_impl(&m, "chat-a", NewSeat::named("Codex", ChatAgent::Codex))
            .expect_err("a closed chat must refuse a seat");
        assert!(err.contains("not a room"), "unhelpful refusal: {err}");
        assert!(seats_of(&m, "chat-a").is_empty());
    }

    #[test]
    fn opening_a_room_lets_it_take_seats_and_give_them_up_again() {
        let m = ChatManager::default();
        set_room_impl(&m, "chat-a", true).unwrap();

        let one = add_seat_impl(&m, "chat-a", NewSeat::named("Codex", ChatAgent::Codex)).unwrap();
        let two = add_seat_impl(&m, "chat-a", NewSeat::named("Claude", ChatAgent::Claude)).unwrap();
        assert_ne!(one.id, two.id, "each seat needs its own id");

        let seats = seats_of(&m, "chat-a");
        assert_eq!(seats.len(), 2);
        // Order is the order they joined. A rail that reordered itself would
        // move rows under the reader — the same rule AgentRail already keeps.
        assert_eq!(seats[0].name, "Codex");
        assert_eq!(seats[1].name, "Claude");

        remove_seat_impl(&m, "chat-a", &one.id).unwrap();
        let seats = seats_of(&m, "chat-a");
        assert_eq!(seats.len(), 1);
        assert_eq!(seats[0].name, "Claude");
    }

    #[test]
    fn a_seat_remembers_what_it_was_added_for_and_what_it_may_see() {
        let m = ChatManager::default();
        set_room_impl(&m, "chat-a", true).unwrap();
        let mut want = NewSeat::named("Outside eye", ChatAgent::Codex);
        want.role = Some("read it as a new reader would".into());
        want.context = Some(ContextMode::RoomOnly);
        want.model = Some("sonnet".into());

        let seat = add_seat_impl(&m, "chat-a", want).unwrap();
        assert_eq!(seat.role.as_deref(), Some("read it as a new reader would"));
        // Stored now, USED in card 69. Keeping the field here is what stops
        // seats being reshaped once the context policy lands.
        assert_eq!(seat.context, ContextMode::RoomOnly);
        assert_eq!(seat.model.as_deref(), Some("sonnet"));
        // A seat with nothing said about it still has a usable default: it may
        // see what every chat in this app has always seen.
        let bare = add_seat_impl(&m, "chat-a", NewSeat::named("Codex", ChatAgent::Codex)).unwrap();
        assert_eq!(bare.context, ContextMode::Project);
        assert_eq!(bare.role, None);
    }

    #[test]
    fn closing_a_room_empties_it_so_reopening_does_not_resurrect_old_seats() {
        let m = ChatManager::default();
        set_room_impl(&m, "chat-a", true).unwrap();
        add_seat_impl(&m, "chat-a", NewSeat::named("Codex", ChatAgent::Codex)).unwrap();
        set_room_impl(&m, "chat-a", false).unwrap();
        assert!(seats_of(&m, "chat-a").is_empty());
        set_room_impl(&m, "chat-a", true).unwrap();
        assert!(
            seats_of(&m, "chat-a").is_empty(),
            "a reopened room must start empty, not with the seats it had before"
        );
    }

    #[test]
    fn an_open_room_with_nobody_in_it_is_not_the_same_as_no_room() {
        // The two look identical if you only ask for the seat list, and they
        // are not: after a restart the browser still draws the switch on, from
        // localStorage, while this backend has forgotten every room it had.
        let m = ChatManager::default();
        let forgotten = room_impl(&m, "chat-a").unwrap();
        assert!(!forgotten.open);
        assert!(forgotten.seats.is_empty());

        set_room_impl(&m, "chat-a", true).unwrap();
        let empty = room_impl(&m, "chat-a").unwrap();
        assert!(empty.open, "an opened room says so before anyone joins");
        assert!(empty.seats.is_empty());
    }

    #[test]
    fn a_room_stops_taking_seats_before_it_can_spawn_a_fleet() {
        // Card 70 hands `add_agent` to the HOST AGENT, and card 67 gives every
        // seat a process. Without a cap here, an agent that decides more voices
        // would help has a way to spawn agents until the machine gives up.
        let m = ChatManager::default();
        set_room_impl(&m, "chat-a", true).unwrap();
        for i in 0..MAX_SEATS {
            add_seat_impl(
                &m,
                "chat-a",
                NewSeat::named(&format!("seat {i}"), ChatAgent::Codex),
            )
            .unwrap_or_else(|e| panic!("seat {i} should fit: {e}"));
        }
        let err = add_seat_impl(
            &m,
            "chat-a",
            NewSeat::named("one too many", ChatAgent::Codex),
        )
        .expect_err("the cap must hold");
        assert!(err.contains("at most"), "unhelpful refusal: {err}");
        assert_eq!(seats_of(&m, "chat-a").len(), MAX_SEATS);

        // Making room lets the next one in — the cap is a ceiling, not a
        // lifetime quota.
        remove_seat_impl(&m, "chat-a", "s1").unwrap();
        add_seat_impl(
            &m,
            "chat-a",
            NewSeat::named("now it fits", ChatAgent::Codex),
        )
        .unwrap();
    }

    #[test]
    fn a_seats_session_key_names_its_room_and_survives_the_transcript() {
        // Card 66 generated the id file-safe; card 67 is what turns it into a
        // session key, and `transcript::path_for` only accepts alphanumerics,
        // '-', '_' and ':'. A key outside that becomes a silent hole in the
        // record rather than an error.
        let key = seat_session_key("chat-a", "s1");
        assert!(
            key.chars()
                .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_' || c == ':'),
            "would not survive transcript::path_for: {key}"
        );
        assert!(key.starts_with("chat-a"), "a seat key must name its room");
        assert_ne!(key, "chat-a", "a seat must not collide with its host");
        assert_ne!(
            seat_session_key("chat-a", "s1"),
            seat_session_key("chat-a", "s2"),
            "two seats in one room need two keys"
        );
        assert_ne!(
            seat_session_key("chat-a", "s1"),
            seat_session_key("chat-b", "s1"),
            "the same seat id in two rooms is two different processes"
        );
    }

    #[test]
    fn addressing_nobody_in_particular_is_the_host() {
        let m = ChatManager::default();
        // Not a room at all — which is every chat today, and the send path that
        // has always existed.
        assert!(matches!(
            target_impl(&m, "chat-a", None).unwrap(),
            Target::Host
        ));
        set_room_impl(&m, "chat-a", true).unwrap();
        assert!(matches!(
            target_impl(&m, "chat-a", None).unwrap(),
            Target::Host
        ));
    }

    #[test]
    fn addressing_a_seat_by_name_resolves_to_that_seat() {
        let m = ChatManager::default();
        set_room_impl(&m, "chat-a", true).unwrap();
        let one = add_seat_impl(&m, "chat-a", NewSeat::named("Codex", ChatAgent::Codex)).unwrap();
        let two = add_seat_impl(&m, "chat-a", NewSeat::named("Claude", ChatAgent::Claude)).unwrap();

        match target_impl(&m, "chat-a", Some(&two.id)).unwrap() {
            Target::Seat(seat) => {
                assert_eq!(seat.id, two.id);
                assert_eq!(seat.name, "Claude");
                assert_ne!(seat.id, one.id, "the wrong seat would get the message");
            }
            Target::Host => panic!("addressed a seat and got the host"),
        }
    }

    #[test]
    fn addressing_a_seat_that_is_not_there_is_refused_rather_than_sent_to_the_host() {
        // Falling back to the host would put a message meant for one agent in
        // front of a different one, which is worse than not sending it.
        let m = ChatManager::default();
        set_room_impl(&m, "chat-a", true).unwrap();
        let err = target_impl(&m, "chat-a", Some("s99")).expect_err("an unknown seat must refuse");
        assert!(err.contains("no seat"), "unhelpful refusal: {err}");

        // And the same on a chat that is not a room at all.
        assert!(target_impl(&m, "chat-b", Some("s1")).is_err());
    }

    #[test]
    fn a_removed_seat_can_no_longer_be_addressed() {
        let m = ChatManager::default();
        set_room_impl(&m, "chat-a", true).unwrap();
        let seat = add_seat_impl(&m, "chat-a", NewSeat::named("Codex", ChatAgent::Codex)).unwrap();
        remove_seat_impl(&m, "chat-a", &seat.id).unwrap();
        assert!(target_impl(&m, "chat-a", Some(&seat.id)).is_err());
    }

    #[test]
    fn a_seat_that_has_never_spoken_has_no_process_to_send_to() {
        // A seat is a RECORD until someone talks to it (card 66). Sending to one
        // that has not started must say THAT, not "no such chat" — the client
        // reads the difference and starts it, exactly as it already does for the
        // host's own first message.
        let m = std::sync::Arc::new(ChatManager::default());
        set_room_impl(&m, "chat-a", true).unwrap();
        let seat = add_seat_impl(&m, "chat-a", NewSeat::named("Codex", ChatAgent::Codex)).unwrap();

        let err = crate::agent_chat::chat_send_impl(
            m.clone(),
            "chat-a".into(),
            "hello".into(),
            None,
            Some(seat.id.clone()),
        )
        .expect_err("a seat with no process cannot be written to");
        assert!(
            err.contains("not running"),
            "the client cannot tell this from a missing chat: {err}"
        );
    }

    #[test]
    fn sending_to_a_seat_that_is_not_there_never_reaches_the_host() {
        let m = std::sync::Arc::new(ChatManager::default());
        set_room_impl(&m, "chat-a", true).unwrap();
        let err = crate::agent_chat::chat_send_impl(
            m,
            "chat-a".into(),
            "meant for somebody else".into(),
            None,
            Some("s99".into()),
        )
        .expect_err("an unknown seat must refuse");
        assert!(err.contains("no seat"), "unhelpful refusal: {err}");
    }

    #[test]
    fn a_seat_never_moves_the_permission_level_the_host_is_on() {
        // The permission channel is keyed by the CONVERSATION, because
        // `OCTIQ_CHAT_KEY` has to name the chat for `ask_user` to reach the
        // right one. So the host and every seat share ONE entry — and a seat
        // that wrote its own level into it would answer the host's questions at
        // that level, with nothing on screen to say so.
        crate::agent_chat::remember_access("chat-a", crate::agent_chat::Access::Full);
        crate::agent_chat::record_access_for("chat-a", Some(crate::agent_chat::Access::Read), true);
        assert_eq!(
            crate::agent_chat::access_now("chat-a"),
            Some(crate::agent_chat::Access::Full),
            "a seat rewrote the level the host is on"
        );
        // The HOST still sets it, which is how the picker works at all.
        crate::agent_chat::record_access_for(
            "chat-a",
            Some(crate::agent_chat::Access::Read),
            false,
        );
        assert_eq!(
            crate::agent_chat::access_now("chat-a"),
            Some(crate::agent_chat::Access::Read)
        );
    }

    #[test]
    fn a_seat_that_is_removed_is_named_so_its_process_can_go_with_it() {
        // Dropping the record alone leaves the agent running: add eight, remove
        // eight, add eight more and there are sixteen. That is exactly what
        // MAX_SEATS exists to prevent, so removal has to hand back the session
        // key of what it removed.
        let m = ChatManager::default();
        set_room_impl(&m, "chat-a", true).unwrap();
        let seat = add_seat_impl(&m, "chat-a", NewSeat::named("Codex", ChatAgent::Codex)).unwrap();

        let gone = remove_seat_impl(&m, "chat-a", &seat.id).unwrap();
        assert_eq!(gone, vec![seat_session_key("chat-a", &seat.id)]);

        // Removing something that is not there ends nothing.
        assert!(remove_seat_impl(&m, "chat-a", &seat.id).unwrap().is_empty());
    }

    #[test]
    fn closing_a_room_names_every_seat_in_it() {
        let m = ChatManager::default();
        set_room_impl(&m, "chat-a", true).unwrap();
        let one = add_seat_impl(&m, "chat-a", NewSeat::named("Codex", ChatAgent::Codex)).unwrap();
        let two = add_seat_impl(&m, "chat-a", NewSeat::named("Claude", ChatAgent::Claude)).unwrap();

        let mut gone = set_room_impl(&m, "chat-a", false).unwrap();
        gone.sort();
        let mut want = vec![
            seat_session_key("chat-a", &one.id),
            seat_session_key("chat-a", &two.id),
        ];
        want.sort();
        assert_eq!(gone, want, "a closed room must give up every process in it");

        // Opening one ends nothing, and a chat that was never a room has
        // nothing to end either.
        assert!(set_room_impl(&m, "chat-a", true).unwrap().is_empty());
        assert!(set_room_impl(&m, "chat-b", false).unwrap().is_empty());
    }

    // ---- card 69: what a seat can actually see -----------------------------

    #[test]
    fn a_project_seat_works_where_the_chat_works() {
        let m = ChatManager::default();
        set_room_impl(&m, "chat-a", true).unwrap();
        let seat = add_seat_impl(&m, "chat-a", NewSeat::named("Codex", ChatAgent::Codex)).unwrap();
        assert_eq!(seat.context, ContextMode::Project);

        let (cwd, dirs) = seat_workspace(&seat, "chat-a", "/work/api", &["/work/web".into()]);

        assert_eq!(cwd, "/work/api");
        assert_eq!(dirs, vec!["/work/web".to_string()]);
    }

    #[test]
    fn a_room_only_seat_is_put_somewhere_the_project_is_not() {
        // The whole value of this seat is what it CANNOT see. Starfall makes the
        // same point and solves it the same way — 关进一个空目录跑, run it in an
        // empty directory — because an agent told to ignore the repo will read
        // it anyway the moment the question gets hard.
        let m = ChatManager::default();
        set_room_impl(&m, "chat-a", true).unwrap();
        let mut want = NewSeat::named("Outside eye", ChatAgent::Codex);
        want.context = Some(ContextMode::RoomOnly);
        let seat = add_seat_impl(&m, "chat-a", want).unwrap();

        let (cwd, dirs) = seat_workspace(&seat, "chat-a", "/work/api", &["/work/web".into()]);

        assert!(
            dirs.is_empty(),
            "a room-only seat was handed the project's other folders: {dirs:?}"
        );
        assert_ne!(
            cwd, "/work/api",
            "a room-only seat starts inside the project"
        );
        assert!(
            !cwd.starts_with("/work"),
            "a room-only seat can still reach the project from {cwd}"
        );
        assert!(!cwd.is_empty(), "a seat still needs somewhere to run");
    }

    #[test]
    fn two_rooms_outside_seats_do_not_share_a_working_folder() {
        // Seat ids are per-room counters, so EVERY room has an `s1`. Naming the
        // scratch folder after the seat alone handed two unrelated
        // conversations the same directory. The original test compared two
        // seats in ONE room and so never saw it.
        let m = ChatManager::default();
        let mut outside = || {
            let mut want = NewSeat::named("Outside eye", ChatAgent::Codex);
            want.context = Some(ContextMode::RoomOnly);
            want
        };
        set_room_impl(&m, "chat-a", true).unwrap();
        set_room_impl(&m, "chat-b", true).unwrap();
        let a = add_seat_impl(&m, "chat-a", outside()).unwrap();
        let b = add_seat_impl(&m, "chat-b", outside()).unwrap();
        assert_eq!(a.id, b.id, "the ids really are the same — that is the trap");

        let (cwd_a, _) = seat_workspace(&a, "chat-a", "/work/api", &[]);
        let (cwd_b, _) = seat_workspace(&b, "chat-b", "/work/api", &[]);

        assert_ne!(
            cwd_a, cwd_b,
            "two rooms' outside seats share a scratch folder"
        );
    }

    #[test]
    fn two_room_only_seats_do_not_share_a_working_folder() {
        // Sharing one would let them read each other's scratch files, which is
        // a side channel between two opinions that are supposed to be separate.
        let m = ChatManager::default();
        set_room_impl(&m, "chat-a", true).unwrap();
        let mut a = NewSeat::named("One", ChatAgent::Codex);
        a.context = Some(ContextMode::RoomOnly);
        let mut b = NewSeat::named("Two", ChatAgent::Codex);
        b.context = Some(ContextMode::RoomOnly);
        let one = add_seat_impl(&m, "chat-a", a).unwrap();
        let two = add_seat_impl(&m, "chat-a", b).unwrap();

        let (cwd_one, _) = seat_workspace(&one, "chat-a", "/work/api", &[]);
        let (cwd_two, _) = seat_workspace(&two, "chat-a", "/work/api", &[]);

        assert_ne!(cwd_one, cwd_two);
    }

    #[test]
    fn sending_straight_to_an_on_demand_seat_reaches_it_with_no_process() {
        // The user picking that seat in the target picker has to work the same
        // way as picking a resident one — the kind is an implementation detail
        // of where the words go, not of who you can talk to.
        let m = std::sync::Arc::new(ChatManager::default());
        set_room_impl(&m, "chat-a", true).unwrap();
        let mut want = NewSeat::named("Outside eye", ChatAgent::Codex);
        want.kind = Some(SeatKind::OnDemand);
        let seat = add_seat_impl(&m, "chat-a", want).unwrap();

        crate::agent_chat::chat_send_impl(
            m.clone(),
            "chat-a".into(),
            "what do you think?".into(),
            None,
            Some(seat.id.clone()),
        )
        .expect("an on-demand seat has no process, and needs none");

        assert!(
            crate::agent_chat::chat_list_impl(&m).unwrap().is_empty(),
            "a process was started for a seat that should never have one"
        );
    }

    #[test]
    fn there_is_nothing_to_start_for_an_on_demand_seat() {
        // Refused rather than quietly doing nothing: a caller that thinks it
        // started something would then wait for a turn that never comes.
        let m = std::sync::Arc::new(ChatManager::default());
        set_room_impl(&m, "chat-a", true).unwrap();
        let mut want = NewSeat::named("Outside eye", ChatAgent::Codex);
        want.kind = Some(SeatKind::OnDemand);
        let seat = add_seat_impl(&m, "chat-a", want).unwrap();

        let err = crate::agent_chat::chat_seat_start_impl(
            m,
            "chat-a".into(),
            seat.id,
            "/tmp".into(),
            Some("hello".into()),
            None,
            None,
            None,
            None,
        )
        .expect_err("there is no process to start");
        assert!(err.contains("no process"), "unhelpful refusal: {err}");
    }

    #[test]
    fn rooms_do_not_leak_into_each_other() {
        let m = ChatManager::default();
        set_room_impl(&m, "chat-a", true).unwrap();
        set_room_impl(&m, "chat-b", true).unwrap();
        add_seat_impl(&m, "chat-a", NewSeat::named("Codex", ChatAgent::Codex)).unwrap();
        assert_eq!(seats_of(&m, "chat-a").len(), 1);
        assert!(seats_of(&m, "chat-b").is_empty());
    }

    #[test]
    fn a_seat_name_is_trimmed_and_cannot_be_blank() {
        let m = ChatManager::default();
        set_room_impl(&m, "chat-a", true).unwrap();
        let seat =
            add_seat_impl(&m, "chat-a", NewSeat::named("  Codex  ", ChatAgent::Codex)).unwrap();
        assert_eq!(seat.name, "Codex");
        assert!(add_seat_impl(&m, "chat-a", NewSeat::named("   ", ChatAgent::Codex)).is_err());
    }

    #[test]
    fn a_seat_id_is_generated_file_safe_whatever_the_seat_is_called() {
        // The name is the user's and can be anything at all. The id is OURS,
        // and card 67 makes it part of a session key — which `transcript.rs`
        // turns into a filename. Generating it rather than deriving it from the
        // name is what stops a seat called "../../etc/passwd" ever reaching a
        // path.
        let m = ChatManager::default();
        set_room_impl(&m, "chat-a", true).unwrap();
        let seat = add_seat_impl(
            &m,
            "chat-a",
            NewSeat::named("../../etc/passwd", ChatAgent::Codex),
        )
        .unwrap();
        assert_eq!(seat.name, "../../etc/passwd", "the name is shown as given");
        assert!(
            seat.id.chars().all(|c| c.is_ascii_alphanumeric()),
            "seat id is not file-safe: {}",
            seat.id
        );
    }

    // ---- card 66: who wrote this ----------------------------------------

    #[test]
    fn a_hosts_event_is_passed_through_completely_untouched() {
        // The whole "a chat with no seats behaves exactly as it does today"
        // promise lives here. No seat, no stamp, not one extra byte.
        let before = json!({"type": "assistant", "message": {"content": []}});
        let mut after = before.clone();
        stamp_speaker(&mut after, None);
        assert_eq!(after, before);
    }

    #[test]
    fn a_seats_event_carries_who_wrote_it_into_the_record() {
        // Stamped INTO the event, not onto the envelope: transcript.rs stores
        // only the event and rebuilds `seq` from the line number, so anything
        // left on the envelope is lost the moment someone reconnects.
        let m = ChatManager::default();
        set_room_impl(&m, "chat-a", true).unwrap();
        let seat = add_seat_impl(&m, "chat-a", NewSeat::named("Codex", ChatAgent::Codex)).unwrap();

        let mut event = json!({"type": "assistant", "message": {"content": []}});
        stamp_speaker(&mut event, Some(&seat));
        let who = &event["octiq_speaker"];
        assert_eq!(who["id"], seat.id);
        assert_eq!(who["name"], "Codex");
        assert_eq!(who["agent"], "codex");
        // The agent's own shape is left exactly as it arrived.
        assert_eq!(event["type"], "assistant");
        assert!(event["message"]["content"].is_array());
    }

    #[test]
    fn the_speaker_field_is_namespaced_so_an_agent_can_never_collide_with_it() {
        // `speaker` is a word an agent stream could plausibly start using one
        // day. `octiq_speaker` is ours and cannot be mistaken for theirs.
        let m = ChatManager::default();
        set_room_impl(&m, "chat-a", true).unwrap();
        let seat = add_seat_impl(&m, "chat-a", NewSeat::named("Codex", ChatAgent::Codex)).unwrap();
        let mut event = json!({"type": "assistant", "speaker": "an agent's own field"});
        stamp_speaker(&mut event, Some(&seat));
        assert_eq!(event["speaker"], "an agent's own field");
        assert_eq!(event["octiq_speaker"]["id"], seat.id);
    }
}
