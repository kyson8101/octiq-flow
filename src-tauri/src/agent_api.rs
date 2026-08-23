//! Seats with no process behind them.
//!
//! A RESIDENT seat is a CLI agent: its own process, its own session, its own
//! stdin. An ON-DEMAND seat is an HTTP call. It is asked something, it answers,
//! and nothing of it exists in between — no process, no memory, no cost while
//! it sits there.
//!
//! ## Why that difference is worth having
//!
//! It is what makes a seat cheap enough to keep around for the rare question.
//! A resident seat holds memory for as long as the room does; an on-demand one
//! holds nothing. The user put it plainly when this was designed: *for deepseek
//! kind of agents (via api), we will only send to them when we need.*
//!
//! ## What it costs
//!
//! It has no memory of its own. A resident seat remembers its side of the
//! conversation because its process is still running; an on-demand seat is told
//! everything it needs every single time, or it knows nothing. That is the
//! trade, and it is the right one for a second opinion asked twice a day.
//!
//! ## The events it produces
//!
//! The chat cannot tell the difference, and that is deliberate. One call becomes
//! the same shapes a real agent's stream produces — an `assistant` message and a
//! `result` — stamped with the seat that said it, recorded in the same
//! transcript. Everything downstream (card 66's rendering, card 68's rounds)
//! then works on it unchanged, because there is nothing special to know.
use std::sync::Arc;

use serde_json::{json, Value};

use crate::chat_room::Seat;

/// Somewhere an on-demand seat's words come from.
///
/// A trait so card 72 can drop DeepSeek in beside the stub without touching
/// anything that calls this.
pub trait Provider: Send + Sync {
    /// Ask it one thing and wait. Blocking: the caller is already on a thread
    /// that expects to wait for an agent.
    fn ask(&self, seat: &Seat, prompt: &str) -> Result<String, String>;
}

/// A provider that answers without going anywhere.
///
/// Card 71 ships this so the whole path — routing, event shapes, rendering — is
/// real and under test before a network call and an API key are added to it in
/// card 72. A stub that produced a DIFFERENT shape would prove nothing, so it
/// produces exactly the shape a real one must.
pub struct Stub;

impl Provider for Stub {
    fn ask(&self, seat: &Seat, prompt: &str) -> Result<String, String> {
        if prompt.trim().is_empty() {
            return Err("nothing was asked".into());
        }
        Ok(format!(
            "({} has no provider configured yet, so there is nothing behind it. \
             It was asked {} characters.)",
            seat.name,
            prompt.trim().chars().count()
        ))
    }
}

/// Which provider serves a seat.
///
/// One place, so card 72 adds DeepSeek by adding a line here rather than by
/// finding every caller.
pub fn provider_for(seat: &Seat) -> Arc<dyn Provider> {
    match seat.provider.as_deref() {
        Some("deepseek") => Arc::new(DeepSeek),
        // Anything unrecognised gets the stub rather than a guess. A seat named
        // after a service this build does not have must say so plainly, not
        // fail somewhere further in.
        _ => Arc::new(Stub),
    }
}

/// The events one on-demand answer becomes.
///
/// Deliberately the shapes a real agent's stream produces, because everything
/// downstream already understands those: an `assistant` message carrying the
/// text, then a `result` closing the turn. Both are stamped with the seat, so
/// they render under its name exactly as a resident's do.
///
/// `usage` is reported as zeroes rather than omitted. The chat reducer reads
/// usage to move the context meter, and a seat's numbers are not the host's —
/// card 66 already refuses a seat's `result`, and honest zeroes keep anything
/// that does look at them from inventing a total.
pub fn events_for(seat: &Seat, said: &str) -> Vec<Value> {
    let speaker = json!({ "id": seat.id, "name": seat.name, "agent": seat.agent.bin() });
    vec![
        json!({
            "type": "assistant",
            "message": {
                "id": format!("api_{}", seat.id),
                "type": "message",
                "role": "assistant",
                "model": seat.model.clone().unwrap_or_else(|| "api".into()),
                "content": [{ "type": "text", "text": said }],
                "usage": { "input_tokens": 0, "output_tokens": 0 },
            },
            "octiq_speaker": speaker,
        }),
        json!({
            "type": "result",
            "subtype": "success",
            "result": said,
            "octiq_speaker": speaker,
        }),
    ]
}

/// Ask an on-demand seat, and put what it says into the chat.
///
/// Records BEFORE it emits, the same order `agent_chat`'s reader uses, so a
/// client catching up later can never be told about something that was not
/// written down.
pub fn ask(seat: &Seat, room_key: &str, prompt: &str) -> Result<String, String> {
    let said = provider_for(seat).ask(seat, prompt)?;
    for event in events_for(seat, &said) {
        let seq = crate::transcript::append(room_key, &event);
        crate::bus::emit(
            "chat-event",
            json!({ "key": room_key, "seq": seq, "event": event }),
        );
    }
    Ok(said)
}

/// DeepSeek, over its OpenAI-shaped chat API.
///
/// Ported from Starfall's `lab/roundtable/turn.py`, which has been asking this
/// model real questions daily since 2026-08-20. The endpoint, the model name and
/// the message shaping are theirs; what is new here is where the key comes from
/// and what is refused before anything leaves the machine.
pub struct DeepSeek;

/// Where DeepSeek is asked.
const DEEPSEEK_URL: &str = "https://api.deepseek.com/chat/completions";

/// The model, unless the seat names another.
const DEEPSEEK_MODEL: &str = "deepseek-v4-pro";

/// How long one answer may take. Starfall uses 900s for the same calls, and a
/// considered answer to a real question genuinely takes minutes.
const DEEPSEEK_TIMEOUT_SECS: u64 = 900;

/// The API key, or a reason there is none.
///
/// Read from `~/.config/deepseek.key` — the file Starfall already uses, already
/// mode 600, already outside every repository. Deliberately NOT copied into this
/// app's profile store: a second copy of a live credential is a second place it
/// can leak from, and the first copy is already better protected than anything
/// this app would write.
///
/// `DEEPSEEK_API_KEY` overrides it, for a machine that keeps secrets elsewhere.
///
/// The value is never logged, never returned in an error, and never put in an
/// event. Every failure here says only that a key is missing or unreadable.
pub fn deepseek_key() -> Result<String, String> {
    if let Ok(from_env) = std::env::var("DEEPSEEK_API_KEY") {
        let key = from_env.trim().to_string();
        if !key.is_empty() {
            return Ok(key);
        }
    }
    let path = crate::paths::home_dir()
        .ok_or("no home directory, so there is nowhere to read a key from")?
        .join(".config")
        .join("deepseek.key");
    let raw = std::fs::read_to_string(&path)
        .map_err(|_| "no DeepSeek key — put one in ~/.config/deepseek.key".to_string())?;
    let key = raw.trim().to_string();
    if key.is_empty() {
        return Err("the DeepSeek key file is empty".into());
    }
    Ok(key)
}

/// The body one question becomes.
///
/// A single user turn. An on-demand seat has no memory, so everything it needs
/// is in the prompt the caller built — see this module's header, and card 69's
/// `backdrop`, which is what decides how much that is.
pub fn deepseek_body(seat: &Seat, prompt: &str) -> Value {
    let mut messages = Vec::new();
    // What this seat is FOR, if the user said. It is the one thing that makes an
    // outside opinion worth having rather than another general answer.
    if let Some(role) = seat.role.as_deref().filter(|r| !r.trim().is_empty()) {
        messages.push(json!({ "role": "system", "content": role }));
    }
    messages.push(json!({ "role": "user", "content": prompt }));
    json!({
        "model": seat.model.clone().unwrap_or_else(|| DEEPSEEK_MODEL.into()),
        "messages": messages,
        "max_tokens": 16000,
    })
}

/// What it said, or why it did not.
///
/// An error from the API is an ANSWER to give the user, not a panic: the model
/// is down, the key is wrong, the account is out of credit. Each has to reach
/// the chat as words, and none of them may carry the key.
pub fn deepseek_answer(body: &Value) -> Result<String, String> {
    if let Some(message) = body
        .get("error")
        .and_then(|e| e.get("message"))
        .and_then(Value::as_str)
    {
        return Err(format!("DeepSeek refused: {message}"));
    }
    let said = body
        .get("choices")
        .and_then(|c| c.get(0))
        .and_then(|c| c.get("message"))
        .and_then(|m| m.get("content"))
        .and_then(Value::as_str)
        .unwrap_or_default()
        .trim()
        .to_string();
    if said.is_empty() {
        return Err("DeepSeek answered with nothing".into());
    }
    Ok(said)
}

/// What a transport failure is allowed to say.
///
/// Its own function so it can be TESTED with a key in scope. The version this
/// replaced mapped the error inline, and the test that claimed to prove no
/// failure carries the key only ever exercised functions that never held one —
/// so an edit here to `{e:?}` would have leaked the `Authorization` header into
/// a chat message with every test still green.
///
/// The ureq error is discarded ENTIRELY rather than summarised. It is built from
/// the request, and the request carries the header.
pub fn transport_failure(_e: &ureq::Transport) -> String {
    "could not reach DeepSeek".to_string()
}

impl Provider for DeepSeek {
    fn ask(&self, seat: &Seat, prompt: &str) -> Result<String, String> {
        if prompt.trim().is_empty() {
            return Err("nothing was asked".into());
        }
        let key = deepseek_key()?;
        let response = ureq::post(DEEPSEEK_URL)
            .set("Authorization", &format!("Bearer {key}"))
            .set("Content-Type", "application/json")
            .timeout(std::time::Duration::from_secs(DEEPSEEK_TIMEOUT_SECS))
            .send_json(deepseek_body(seat, prompt));
        let body: Value = match response {
            Ok(ok) => ok
                .into_json()
                .map_err(|e| format!("DeepSeek sent something unreadable: {e}"))?,
            // A non-2xx still has a body worth reading — that is where the API
            // puts WHY. Anything else is the network, and says so without
            // mentioning the request, which carries the key.
            Err(ureq::Error::Status(_, res)) => res
                .into_json()
                .map_err(|_| "DeepSeek refused, and gave no reason".to_string())?,
            Err(ureq::Error::Transport(e)) => return Err(transport_failure(&e)),
        };
        deepseek_answer(&body)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::agent_chat::ChatAgent;
    use crate::chat_room::{ContextMode, SeatKind};

    fn seat() -> Seat {
        Seat {
            id: "s1".into(),
            name: "Outside eye".into(),
            agent: ChatAgent::Codex,
            model: None,
            role: None,
            context: ContextMode::RoomOnly,
            kind: SeatKind::OnDemand,
            provider: Some("deepseek".into()),
        }
    }

    // ---- card 72: the DeepSeek seat ----------------------------------------

    #[test]
    fn what_it_sends_is_one_turn_because_the_seat_has_no_memory() {
        let body = deepseek_body(&seat(), "is this safe?");

        assert_eq!(body["model"], "deepseek-v4-pro");
        assert_eq!(body["messages"][0]["role"], "user");
        assert_eq!(body["messages"][0]["content"], "is this safe?");
    }

    #[test]
    fn a_seats_role_is_sent_as_what_it_is_there_to_do() {
        // The one thing that makes an outside opinion worth having rather than
        // another general answer.
        let mut s = seat();
        s.role = Some("read it as a newcomer would".into());
        let body = deepseek_body(&s, "is this safe?");

        assert_eq!(body["messages"][0]["role"], "system");
        assert_eq!(
            body["messages"][0]["content"],
            "read it as a newcomer would"
        );
        assert_eq!(body["messages"][1]["role"], "user");
    }

    #[test]
    fn a_seat_may_name_its_own_model() {
        let mut s = seat();
        s.model = Some("deepseek-chat".into());

        assert_eq!(deepseek_body(&s, "hi")["model"], "deepseek-chat");
    }

    #[test]
    fn a_normal_reply_is_read_the_way_the_api_actually_shapes_it() {
        // The shape is Starfall's, taken from a client that has been reading
        // real replies from this endpoint daily.
        let body = json!({
            "choices": [{ "message": { "role": "assistant", "content": "  it is not reversible  " } }]
        });

        assert_eq!(deepseek_answer(&body).unwrap(), "it is not reversible");
    }

    #[test]
    fn an_api_error_becomes_words_rather_than_a_panic() {
        // Wrong key, no credit, model down — each has to reach the chat as
        // something the person can read and act on.
        let body = json!({ "error": { "message": "Insufficient Balance", "type": "insufficient_balance" } });

        let err = deepseek_answer(&body).unwrap_err();
        assert!(
            err.contains("Insufficient Balance"),
            "the reason was lost: {err}"
        );
    }

    #[test]
    fn an_empty_reply_is_an_error_rather_than_an_empty_bubble() {
        assert!(deepseek_answer(&json!({ "choices": [] })).is_err());
        assert!(
            deepseek_answer(&json!({ "choices": [{ "message": { "content": "" } }] })).is_err()
        );
        assert!(deepseek_answer(&json!({})).is_err());
    }

    #[test]
    fn a_transport_failure_says_nothing_about_the_request_that_carried_the_key() {
        // The one error path that is built FROM the request, and so the one that
        // could carry the Authorization header. The ureq error is discarded
        // entirely rather than summarised.
        let e = ureq::get("https://127.0.0.1:1/nowhere")
            .timeout(std::time::Duration::from_millis(50))
            .call()
            .expect_err("a closed port must fail");
        let ureq::Error::Transport(transport) = e else {
            panic!("expected a transport failure");
        };

        let said = transport_failure(&transport);
        assert_eq!(said, "could not reach DeepSeek");
        assert!(!said.contains("Bearer"));
        assert!(!said.contains("Authorization"));
        assert!(!said.contains("127.0.0.1"), "it named the request: {said}");
    }

    #[test]
    fn no_failure_here_can_carry_the_key() {
        // The card's whole reason for being tagged sensitive. Every error this
        // module produces is checked for the shape of a credential — INCLUDING
        // the transport path, which is the only one built from the request.
        let errors = [
            deepseek_answer(&json!({ "error": { "message": "bad key sk-SECRET" } })).unwrap_err(),
            deepseek_answer(&json!({})).unwrap_err(),
            Stub.ask(&seat(), "  ").unwrap_err(),
            deepseek_key()
                .err()
                .unwrap_or_else(|| "a key was found".into()),
        ];
        for e in errors {
            assert!(
                !e.contains("Bearer"),
                "an error carried an auth header: {e}"
            );
            assert!(
                !e.contains("Authorization"),
                "an error named the auth header: {e}"
            );
        }
    }

    #[test]
    fn a_seat_named_after_a_service_we_do_not_have_gets_the_stub_not_a_guess() {
        // It has to say plainly that there is nothing behind it, rather than
        // fail somewhere further in where the reason is gone.
        let mut s = seat();
        s.provider = Some("some-model-we-never-added".into());

        let said = provider_for(&s).ask(&s, "is this safe?").unwrap();
        assert!(said.contains("no provider configured"), "{said}");
    }

    #[test]
    fn a_seat_with_no_provider_named_gets_the_stub() {
        let mut s = seat();
        s.provider = None;

        assert!(provider_for(&s)
            .ask(&s, "hi")
            .unwrap()
            .contains("no provider"));
    }

    #[test]
    fn the_stub_answers_rather_than_pretending_to_be_a_real_provider() {
        let said = Stub.ask(&seat(), "is this safe?").unwrap();

        assert!(
            said.contains("no provider configured"),
            "the stub must not read as a real answer: {said}"
        );
        assert!(
            said.contains("Outside eye"),
            "it should say which seat: {said}"
        );
    }

    #[test]
    fn asking_nothing_is_refused_rather_than_sent() {
        assert!(Stub.ask(&seat(), "   ").is_err());
    }

    #[test]
    fn one_answer_becomes_the_shapes_the_chat_already_understands() {
        // The whole point: nothing downstream should need to know an on-demand
        // seat is different. If these shapes drift from a real agent's, card
        // 66's rendering and card 68's rounds both stop working on them.
        let events = events_for(&seat(), "it is not reversible");

        assert_eq!(events.len(), 2, "a turn is a message AND its end");
        assert_eq!(events[0]["type"], "assistant");
        assert_eq!(
            events[0]["message"]["content"][0]["text"],
            "it is not reversible"
        );
        assert_eq!(events[1]["type"], "result");
        assert_eq!(events[1]["result"], "it is not reversible");
    }

    #[test]
    fn every_event_it_produces_says_which_seat_said_it() {
        // Without this the words land under the host's name — the exact failure
        // card 66 exists to prevent.
        for event in events_for(&seat(), "something") {
            assert_eq!(event["octiq_speaker"]["id"], "s1");
            assert_eq!(event["octiq_speaker"]["name"], "Outside eye");
        }
    }

    #[test]
    fn it_reports_no_tokens_rather_than_inventing_some() {
        // A seat's numbers are not the host's. Zeroes are honest; omitting the
        // field would let anything reading usage fall back to a guess.
        let events = events_for(&seat(), "something");

        assert_eq!(events[0]["message"]["usage"]["input_tokens"], 0);
        assert_eq!(events[0]["message"]["usage"]["output_tokens"], 0);
    }
}
