//! A Grant starts its own background conversation. The island stays open;
//! the normal chat lifecycle owns the process, record and permission cards.
use super::*;
use crate::agent_provider::AgentKind;
use std::sync::Mutex;

// Two tabs cannot spend two turns on the same wish. Held through admission
// and launch; the chat manager owns the turn once this is released.
static START: Mutex<()> = Mutex::new(());

fn preferred(mut providers: Vec<AgentKind>) -> Vec<AgentKind> {
    providers.sort_by_key(|kind| *kind != AgentKind::Codex);
    providers
}

fn chat_id(id: &str) -> String {
    format!("island-wish-{id}")
}

pub(super) fn get(svc: &Services) -> Result<Value, String> {
    let mut answer = crate::island::get(
        &crate::island::default_path(),
        island_roster(svc).as_deref(),
        crate::island::now_ms(),
    )?;
    for wish in answer["island"]["wishes"]
        .as_array_mut()
        .into_iter()
        .flatten()
    {
        if wish["state"] != "open" {
            continue;
        }
        let id = chat_id(wish["id"].as_str().unwrap_or_default());
        if let Some(chat) = crate::chat_index::find(&id)? {
            let key = format!("chat:{id}");
            wish["execution"] = json!({
                "chatKey": key,
                "state": if svc.chats.turn_in_flight(&key) { "building" } else { "unfinished" },
                "provider": chat.model_id.as_deref().and_then(|s| s.split(':').next()),
            });
        }
    }
    Ok(answer)
}

pub(super) fn start(svc: &Services, id: &str) -> Result<Value, String> {
    // Resolve installed providers on the host, independently of the chat
    // composer's selected model or whether the wisher is a registered agent.
    let providers = preferred(
        crate::agents::agent_installs(None)
            .into_iter()
            .filter(|row| row.installed)
            .filter_map(|row| AgentKind::ALL.into_iter().find(|kind| kind.id() == row.id))
            .collect(),
    );
    begin(svc, id, &providers, |key, args, prompt| {
        super::start_chat(
            svc,
            key,
            args,
            FirstTurn::Person(Some(prompt.to_owned())),
            format!("island-grant-{}", uuid::Uuid::new_v4().simple()),
        )
    })
}

fn begin(
    svc: &Services,
    id: &str,
    providers: &[AgentKind],
    mut launch: impl FnMut(&str, &Value, &str) -> Result<(), String>,
) -> Result<Value, String> {
    let _claim = START.lock().unwrap_or_else(|e| e.into_inner());
    crate::profile::available()?;
    let answer = crate::island::get(
        &crate::island::default_path(),
        island_roster(svc).as_deref(),
        crate::island::now_ms(),
    )?;
    // Only a stored, open wish supplies the task. Neither a prompt nor a
    // directory nor an agent identity is taken from the browser.
    let wish = answer["island"]["wishes"]
        .as_array()
        .and_then(|wishes| wishes.iter().find(|wish| wish["id"] == id))
        .ok_or("That wish is no longer on the island.")?;
    if wish["state"] != "open" {
        return Err("That wish is already closed.".into());
    }
    let brief = wish["brief"]
        .as_str()
        .filter(|s| !s.is_empty())
        .ok_or("The robot that made this wish is no longer available.")?;
    let id = chat_id(id);
    let key = format!("chat:{id}");
    if svc.chats.turn_in_flight(&key) {
        return Ok(json!({ "chatKey": key, "state": "building" }));
    }
    if providers.is_empty() {
        return Err("No agent provider is installed. Install and sign in to Claude, Codex, pi or Antigravity to grant wishes.".into());
    }
    // Check the index before saving, so an unreadable store is never reset.
    let previous = crate::chat_index::find(&id)?;
    if svc.chats.has_process(&key) {
        crate::agent_chat::chat_stop_impl(&svc.chats, key.clone())?;
    }
    let cwd = crate::profile::profile_dir().join("island-workshop");
    crate::profile::make_dir(&cwd)?;
    let prompt = format!("{brief}\n\nThe person pressed Grant on the island. Execute this request now using the island tools, without asking them to send another message or returning them to a chat. This is only an island present: do not modify project files or run unrelated work. If the wish is already closed when you look, stop. If building is refused, correct the design using the guide and try again. Only report success after island_grant succeeds.");
    let mut errors = Vec::new();
    for provider in providers {
        let now = crate::island::now_ms();
        let meta = serde_json::from_value(json!({
            "id": id, "projectId": "island", "title": format!("Island · {}", wish["text"].as_str().unwrap_or("Grant a wish")),
            "cwd": cwd.to_string_lossy(), "modelId": format!("{}:default", provider.id()),
            "access": "edits", "createdAt": previous.as_ref().map_or(now, |chat| chat.created_at), "updatedAt": now,
        })).map_err(|e| format!("The island task could not be recorded: {e}"))?;
        crate::agent_chat::chat_index_save(meta)?;
        let args = json!({ "cwd": cwd.to_string_lossy(), "agent": provider, "access": "edits" });
        match launch(&key, &args, &prompt) {
            Ok(()) => {
                return Ok(
                    json!({ "chatKey": key, "state": "building", "provider": provider.id() }),
                )
            }
            Err(error) => {
                // A launch that did hand over a turn must never be followed
                // by another provider doing that same work.
                if svc.chats.turn_in_flight(&key) {
                    return Err(error);
                }
                errors.push(format!("{}: {error}", provider.id()));
                if svc.chats.has_process(&key) {
                    crate::agent_chat::chat_stop_impl(&svc.chats, key.clone())?;
                }
            }
        }
    }
    Err(format!(
        "No provider could start the island task. {}",
        errors.join("; ")
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn codex_is_the_default_and_other_installed_providers_remain_fallbacks() {
        assert_eq!(
            preferred(vec![AgentKind::Claude, AgentKind::Codex, AgentKind::Pi]),
            vec![AgentKind::Codex, AgentKind::Claude, AgentKind::Pi]
        );
        assert_eq!(preferred(vec![AgentKind::Pi]), vec![AgentKind::Pi]);
    }

    fn wish(svc: &Services) -> String {
        crate::team::save(
            &svc.handovers.team,
            serde_json::from_value(json!({
                "name":"Maya", "agent":"codex", "model":"gpt-6.1-sol"
            }))
            .unwrap(),
        )
        .unwrap();
        get(svc).unwrap()["island"]["wishes"][0]["id"]
            .as_str()
            .unwrap()
            .into()
    }

    #[test]
    fn grant_launches_immediately_falls_back_and_deduplicates_the_running_turn() {
        let home = crate::test_dir::TestDir::new("island-background");
        let _profile = crate::profile::started_in(&home);
        let svc = Services::load();
        let id = wish(&svc);
        let mut attempts = Vec::new();
        let answer = begin(
            &svc,
            &id,
            &[AgentKind::Claude, AgentKind::Codex],
            |key, args, prompt| {
                attempts.push(args["agent"].clone());
                assert!(prompt.contains(&id));
                assert!(prompt.contains("island_grant"));
                assert_eq!(args["access"], "edits");
                assert!(args["cwd"].as_str().unwrap().ends_with("island-workshop"));
                assert!(crate::chat_index::listed(key.strip_prefix("chat:").unwrap()).unwrap());
                if args["agent"] == "claude" {
                    return Err("cannot launch".into());
                }
                svc.chats.test_launch(key);
                svc.chats.test_busy(key, true);
                Ok(())
            },
        )
        .unwrap();
        assert_eq!(attempts, vec![json!("claude"), json!("codex")]);
        assert_eq!(answer["provider"], "codex");
        let key = answer["chatKey"].as_str().unwrap();
        let duplicate = begin(&svc, &id, &[], |_, _, _| panic!("duplicate launch")).unwrap();
        assert_eq!(duplicate["chatKey"], key);
        let building = get(&svc).unwrap();
        assert_eq!(
            building["island"]["wishes"][0]["execution"]["state"],
            "building"
        );
        svc.chats.test_busy(key, false);
        assert_eq!(
            get(&svc).unwrap()["island"]["wishes"][0]["execution"]["state"],
            "unfinished"
        );
        svc.chats.test_end(key);
    }

    #[test]
    fn a_missing_provider_or_closed_wish_never_launches_or_marks_a_gift_granted() {
        let home = crate::test_dir::TestDir::new("island-no-provider");
        let _profile = crate::profile::started_in(&home);
        let svc = Services::load();
        let id = wish(&svc);
        let before = std::fs::read(crate::island::default_path()).unwrap();
        assert!(begin(&svc, &id, &[], |_, _, _| panic!("no provider"))
            .unwrap_err()
            .contains("No agent provider"));
        assert_eq!(
            std::fs::read(crate::island::default_path()).unwrap(),
            before
        );
        assert!(crate::chat_index::find(&chat_id(&id)).unwrap().is_none());
        crate::island::dismiss_wish(
            &crate::island::default_path(),
            None,
            &id,
            crate::island::now_ms(),
        )
        .unwrap();
        assert!(
            begin(&svc, &id, &[AgentKind::Pi], |_, _, _| panic!("closed wish"))
                .unwrap_err()
                .contains("closed")
        );
    }

    #[test]
    fn an_absent_profile_never_starts_a_background_task() {
        let home = crate::profile::tests::Home::with_a_configured_base();
        let _profile = crate::profile::started_in(&home.dir);
        let svc = Services::load();
        let id = wish(&svc);
        home.move_away();
        assert!(begin(&svc, &id, &[AgentKind::Claude], |_, _, _| panic!(
            "profile gone"
        ))
        .is_err());
        assert!(!home.profile().exists());
        home.move_back();
    }
}
