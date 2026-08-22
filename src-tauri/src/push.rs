//! Web Push — the banner that arrives with nothing open.
//!
//! The notifications in `web/src/lib/notify.ts` are raised by the PAGE, which
//! means the page has to be running. On a desktop that is usually true. On a
//! phone it almost never is: iOS suspends a backgrounded home-screen app within
//! seconds, and a locked phone is running nothing at all. So the moment worth
//! knowing about — a turn ending, a permission ask, a question — arrives
//! nowhere.
//!
//! Web Push turns that around. The BACKEND sends, the push service holds the
//! message, and the phone's own OS wakes a service worker to draw the banner.
//! Nothing of ours needs to be open.
//!
//! ```text
//!   permission.rs / question.rs / agent_chat.rs
//!            │  push::notify(Notice { … })
//!            ▼
//!        ┌────────┐   encrypted, VAPID-signed
//!        │  push  │ ─────────────────────────► fcm.googleapis.com
//!        └────────┘                            web.push.apple.com
//!                                                      │
//!                                                      ▼
//!                                         the phone wakes sw.js
//! ```
//!
//! **The body is end-to-end encrypted** (RFC 8291), so Apple and Google relay
//! it without being able to read it. That is the whole reason this is here
//! rather than a POST to ntfy: the body carries the agent's closing words, and
//! those are the user's code.
//!
//! Two things this deliberately does NOT do:
//!
//!   · Decide whether you were watching. The server has no idea which chat is
//!     on your screen. `sw.js` makes that call, where the answer lives.
//!   · Block. Sends go out on their own thread. A push service having a slow
//!     day must never hold up the agent that triggered it.
use std::fs;
use std::path::PathBuf;
use std::sync::Mutex;

use serde::{Deserialize, Serialize};
use web_push::{ContentEncoding, SubscriptionInfo, VapidSignatureBuilder, WebPushMessageBuilder};

/// How long the push service should hold a message for a phone that is off.
///
/// Four hours. A permission ask times out in three minutes and a question in
/// ten, so a banner older than that is pointing at something already gone —
/// but the "turn finished" one still means something the next morning, and it
/// is the same channel.
const TTL: u32 = 4 * 60 * 60;

/// Who is sending, as the VAPID `sub` claim.
///
/// Apple is the strict one here and it answers a bad value with a flat 403, no
/// explanation: `mailto:octiqflow@localhost` was refused outright, because
/// `localhost` is not a domain anyone could ever reach. The spec asks for a
/// `mailto:` or `https:` URL identifying whoever operates the server, so the
/// project's own page stands in — it is real, it resolves, and it carries no
/// personal address to Apple or Google on every send.
const CONTACT: &str = "https://github.com/kyson8101/octiq-flow";

/// One browser that asked to be told. Exactly the shape
/// `PushSubscription.toJSON()` produces, so the client posts it verbatim.
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
pub struct Subscription {
    pub endpoint: String,
    pub p256dh: String,
    pub auth: String,
}

/// What a banner says. Mirrors `Notice` in `web/src/lib/notify.ts`; `sw.js`
/// reads these fields straight off the decrypted payload.
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Notice {
    /// "done" | "permission" | "question".
    pub kind: String,
    #[serde(rename = "conversationId")]
    pub conversation_id: String,
    pub title: String,
    pub body: String,
    /// One live banner per chat per kind — a later one replaces the earlier.
    pub tag: String,
}

/// Long enough to say what happened, short enough that a phone does not clip
/// it mid-word. The same number `notify.ts` uses, so the two paths cut in the
/// same place.
const MAX_BODY: usize = 120;

/// One line of banner text out of however many lines of transcript.
fn preview(text: &str) -> String {
    let clean = text.split_whitespace().collect::<Vec<_>>().join(" ");
    if clean.chars().count() > MAX_BODY {
        // By CHARACTER, not by byte: a path or an answer with an accent in it
        // would panic a byte slice mid-codepoint.
        let cut: String = clean.chars().take(MAX_BODY).collect();
        format!("{cut}…")
    } else {
        clean
    }
}

/// The conversation a chat key belongs to. Keys are `chat:<id>`; anything else
/// is a terminal, which has no conversation to open.
fn conversation_of(chat_key: &str) -> Option<&str> {
    chat_key.strip_prefix("chat:")
}

/// The banner for one moment in one chat.
///
/// Worded exactly as `noticeFor` in `web/src/lib/notify.ts` words it, because
/// the same moment can arrive by either route and the two must not disagree
/// about what they say. Titled after the CHAT rather than the kind: on a phone
/// the title is the bold line, and which piece of work this is about is what
/// you need first.
pub fn notice_for(chat_key: Option<&str>, kind: &str, detail: &str) -> Option<Notice> {
    let id = conversation_of(chat_key?)?;
    let detail = preview(detail);
    let body = match kind {
        "permission" => format!(
            "Needs permission: {}",
            if detail.is_empty() {
                "a tool call"
            } else {
                &detail
            }
        ),
        "question" => format!(
            "Asked: {}",
            if detail.is_empty() {
                "a question"
            } else {
                &detail
            }
        ),
        _ if detail.is_empty() => "Finished.".to_string(),
        _ => detail,
    };
    let title = crate::chat_index::list()
        .into_iter()
        .find(|c| c.id == id)
        .map(|c| c.title.trim().to_string())
        .filter(|t| !t.is_empty())
        .unwrap_or_else(|| "OctiqFlow".to_string());

    Some(Notice {
        kind: kind.to_string(),
        conversation_id: id.to_string(),
        title,
        body,
        tag: format!("octiq:{id}:{kind}"),
    })
}

/// Send the banner for one moment, if the chat key names a conversation.
pub fn notify_chat(chat_key: Option<&str>, kind: &str, detail: &str) {
    if let Some(notice) = notice_for(chat_key, kind, detail) {
        notify(notice);
    }
}

/// The key and everyone subscribed with it, as it sits on disk.
#[derive(Default, Serialize, Deserialize)]
struct Store {
    /// The VAPID private key: the raw 32-byte scalar, base64url, no padding.
    /// This is the format `web-push generate-vapid-keys` prints, and what
    /// `VapidSignatureBuilder::from_base64` wants.
    #[serde(default)]
    key: String,
    #[serde(default)]
    subs: Vec<Subscription>,
}

/// Serialising every read-modify-write. Subscribing, unsubscribing and pruning
/// a dead endpoint all rewrite the same file, and the pruning happens on a
/// send thread while the user may be subscribing a second device.
static LOCK: Mutex<()> = Mutex::new(());

/// Beside the agent-session map, for the same reason it is there: a fixed path
/// under the home directory rather than the app-data dir, so it does not move
/// when the app is rebuilt or rebundled.
fn store_path() -> Option<PathBuf> {
    crate::paths::home_dir().map(|h| h.join(".octiqflow").join("push.json"))
}

fn load() -> Store {
    store_path()
        .and_then(|p| fs::read_to_string(p).ok())
        .and_then(|raw| serde_json::from_str(&raw).ok())
        .unwrap_or_default()
}

fn save(store: &Store) {
    let Some(path) = store_path() else { return };
    if let Some(parent) = path.parent() {
        let _ = fs::create_dir_all(parent);
    }
    if let Ok(raw) = serde_json::to_string_pretty(store) {
        let _ = fs::write(&path, raw);
    }
}

/// A fresh VAPID private key, base64url with no padding.
fn generate_key() -> String {
    use base64::Engine;
    use p256::elliptic_curve::rand_core::OsRng;
    let secret = p256::SecretKey::random(&mut OsRng);
    base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(secret.to_bytes())
}

/// The application server key the browser needs at subscribe time, base64url.
///
/// Generated on first ask and kept forever: it identifies this server to the
/// push service, and every subscription is bound to it. Replacing it silently
/// invalidates every device already subscribed, which is why nothing here ever
/// regenerates one that exists.
pub fn public_key() -> Option<String> {
    use base64::Engine;
    let _guard = LOCK.lock().ok()?;
    let mut store = load();
    if store.key.is_empty() {
        store.key = generate_key();
        save(&store);
    }
    let builder = VapidSignatureBuilder::from_base64_no_sub(&store.key).ok()?;
    Some(base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(builder.get_public_key()))
}

/// Remember a browser. Re-subscribing with the same endpoint replaces the old
/// row rather than adding a second — the browser may hand back a new key pair
/// for an endpoint it already gave us.
pub fn subscribe(sub: Subscription) {
    let Ok(_guard) = LOCK.lock() else { return };
    let mut store = load();
    store.subs.retain(|s| s.endpoint != sub.endpoint);
    store.subs.push(sub);
    save(&store);
}

pub fn unsubscribe(endpoint: &str) {
    let Ok(_guard) = LOCK.lock() else { return };
    let mut store = load();
    store.subs.retain(|s| s.endpoint != endpoint);
    save(&store);
}

/// Forget an endpoint the push service says is gone.
fn drop_dead(endpoint: &str) {
    eprintln!("[push] dropping a subscription the push service says is gone");
    unsubscribe(endpoint);
}

/// Send one banner to every subscribed browser.
///
/// Returns immediately: the work happens on its own thread, because this is
/// called from the middle of a permission ask that an agent is blocked on.
pub fn notify(notice: Notice) {
    let (key, subs) = {
        let store = load();
        (store.key.clone(), store.subs.clone())
    };
    if key.is_empty() || subs.is_empty() {
        return;
    }
    std::thread::spawn(move || {
        let Ok(body) = serde_json::to_vec(&notice) else {
            return;
        };
        for sub in subs {
            if let Err(e) = send_one(&key, &sub, &body) {
                eprintln!("[push] {e}");
            }
        }
    });
}

/// One encrypted, signed POST.
///
/// `web-push` does the RFC 8291 encryption and the VAPID JWT; the request goes
/// out through `ureq` rather than the crate's own client so this does not drag
/// a second HTTP stack into the binary. `ureq` is already here for Cloudflare
/// Access, blocking, and used exactly as rarely.
fn send_one(key: &str, sub: &Subscription, body: &[u8]) -> Result<(), String> {
    let info = SubscriptionInfo::new(sub.endpoint.clone(), sub.p256dh.clone(), sub.auth.clone());

    let mut sig = VapidSignatureBuilder::from_base64(key, &info)
        .map_err(|e| format!("bad VAPID key: {e}"))?;
    sig.add_claim("sub", CONTACT);
    let signature = sig.build().map_err(|e| format!("could not sign: {e}"))?;

    let mut builder = WebPushMessageBuilder::new(&info);
    builder.set_payload(ContentEncoding::Aes128Gcm, body);
    builder.set_ttl(TTL);
    builder.set_vapid_signature(signature);
    let message = builder
        .build()
        .map_err(|e| format!("could not build: {e}"))?;

    // Reuse the crate's own header assembly rather than restating which headers
    // a push service wants — it is the part most easily got subtly wrong.
    let request = web_push::request_builder::build_request::<Vec<u8>>(message);
    let (parts, payload) = request.into_parts();

    let mut call = ureq::post(&parts.uri.to_string());
    for (name, value) in parts.headers.iter() {
        if let Ok(v) = value.to_str() {
            call = call.set(name.as_str(), v);
        }
    }

    match call.send_bytes(&payload) {
        Ok(_) => Ok(()),
        // 404 and 410 are the push service saying this endpoint is finished:
        // the app was uninstalled, or the browser dropped it. Anything else is
        // this send failing, and the subscription is still good.
        Err(ureq::Error::Status(404 | 410, _)) => {
            drop_dead(&sub.endpoint);
            Ok(())
        }
        Err(ureq::Error::Status(code, _)) => Err(format!("push service said {code}")),
        Err(e) => Err(format!("could not reach the push service: {e}")),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_generated_key_is_a_usable_vapid_key() {
        // The round trip the browser depends on: the stored private key has to
        // yield a public key the push service will accept, or every
        // subscription made with it is silently worthless.
        let key = generate_key();
        let builder = VapidSignatureBuilder::from_base64_no_sub(&key)
            .expect("a generated key should parse back");
        // An uncompressed P-256 point: the 0x04 tag and two 32-byte halves.
        let public = builder.get_public_key();
        assert_eq!(public.len(), 65);
        assert_eq!(public[0], 0x04);
    }

    #[test]
    fn two_generated_keys_differ() {
        assert_ne!(generate_key(), generate_key());
    }

    /// Send a REAL banner to every device subscribed on this machine.
    ///
    /// Ignored, because it talks to Apple and Google and needs a subscription
    /// that only a browser can create. It exists because the failures here are
    /// invisible from the inside: the encryption can be perfect and the send
    /// still refused over a claim in the JWT, and the only thing that says so
    /// is the push service's status code. Nothing else in this file can tell
    /// you whether a push actually leaves the building.
    ///
    ///   cargo test --lib push::tests::send_a_real_push -- --ignored --nocapture
    #[test]
    #[ignore = "sends a real notification to a real device"]
    fn send_a_real_push() {
        let store = load();
        assert!(
            !store.key.is_empty(),
            "no VAPID key yet — open the app first"
        );
        assert!(
            !store.subs.is_empty(),
            "nothing subscribed — turn Notifications on in Settings first"
        );

        let notice = Notice {
            kind: "done".into(),
            conversation_id: "test".into(),
            title: "OctiqFlow".into(),
            body: "If you can read this, push works.".into(),
            tag: "octiq:test:done".into(),
        };
        let body = serde_json::to_vec(&notice).unwrap();

        let mut sent = 0;
        for sub in &store.subs {
            let host = sub.endpoint.split('/').nth(2).unwrap_or("?");
            match send_one(&store.key, sub, &body) {
                Ok(()) => {
                    println!("  {host}: accepted");
                    sent += 1;
                }
                Err(e) => println!("  {host}: {e}"),
            }
        }
        assert!(sent > 0, "every push service refused the send");
    }

    #[test]
    fn preview_collapses_the_whitespace_a_transcript_is_full_of() {
        assert_eq!(
            preview("Done.\n\n  Two files changed."),
            "Done. Two files changed."
        );
        assert_eq!(preview("   "), "");
    }

    #[test]
    fn preview_cuts_long_text_without_splitting_a_character() {
        // The reason this cuts by character and not by byte. An agent's closing
        // words routinely carry an em dash or an accent, and a byte slice
        // landing inside one panics — taking the send thread with it.
        let long = "é".repeat(300);
        let short = preview(&long);
        assert_eq!(
            short.chars().count(),
            MAX_BODY + 1,
            "120 characters and the ellipsis"
        );
        assert!(short.ends_with('…'));
    }

    #[test]
    fn only_a_chat_key_names_a_conversation() {
        assert_eq!(conversation_of("chat:abc-123"), Some("abc-123"));
        // A terminal. There is no conversation to open, so nothing is sent.
        assert_eq!(conversation_of("term:1"), None);
    }

    #[test]
    fn a_moment_with_no_words_still_says_what_happened() {
        // Each kind has to stand on its own: a turn can end saying nothing, and
        // a tool call can arrive before its name is known. A blank banner is
        // worse than a vague one, since it tells you to go and look for
        // something without saying what.
        let blank = |kind: &str| {
            notice_for(Some("chat:c1"), kind, "")
                .expect("a chat key names a conversation")
                .body
        };
        assert_eq!(blank("done"), "Finished.");
        assert_eq!(blank("permission"), "Needs permission: a tool call");
        assert_eq!(blank("question"), "Asked: a question");
    }

    #[test]
    fn one_banner_per_chat_per_kind() {
        // The tag is what makes a second banner REPLACE the first rather than
        // stack under it, so ten turns in a background chat leave one.
        let tag = |kind: &str, chat: &str| notice_for(Some(chat), kind, "x").unwrap().tag;
        assert_eq!(tag("done", "chat:c1"), tag("done", "chat:c1"));
        assert_ne!(tag("done", "chat:c1"), tag("permission", "chat:c1"));
        assert_ne!(tag("done", "chat:c1"), tag("done", "chat:c2"));
    }

    #[test]
    fn a_notice_serialises_the_way_sw_js_reads_it() {
        let notice = Notice {
            kind: "permission".into(),
            conversation_id: "c1".into(),
            title: "Fix the top bar".into(),
            body: "Needs permission: Edit".into(),
            tag: "octiq:c1:permission".into(),
        };
        let value: serde_json::Value = serde_json::to_value(&notice).unwrap();
        // camelCase on the wire, because the client half is TypeScript.
        assert_eq!(value["conversationId"], "c1");
        assert_eq!(value["kind"], "permission");
        assert_eq!(value["tag"], "octiq:c1:permission");
    }

    #[test]
    fn resubscribing_the_same_endpoint_replaces_it() {
        // Not a store test — the store is a real file in the real home dir, and
        // a test has no business writing there. This is the dedup rule itself,
        // which is the part worth being sure of: a browser handing back new
        // keys for an endpoint it already gave us must not end up listed twice,
        // or every banner arrives in duplicate.
        let mut subs = vec![Subscription {
            endpoint: "https://push.example/a".into(),
            p256dh: "old".into(),
            auth: "old".into(),
        }];
        let fresh = Subscription {
            endpoint: "https://push.example/a".into(),
            p256dh: "new".into(),
            auth: "new".into(),
        };
        subs.retain(|s| s.endpoint != fresh.endpoint);
        subs.push(fresh);

        assert_eq!(subs.len(), 1);
        assert_eq!(subs[0].p256dh, "new");
    }
}
