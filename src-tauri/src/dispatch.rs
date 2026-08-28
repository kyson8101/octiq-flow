//! Calling the backend directly, with no webview in the middle.
//!
//! A browser's request used to be handed to the desktop window, which called
//! `invoke` on our behalf and sent the answer back (see the proxy in web.rs).
//! That worked and cost nothing to write, but it made the window load-bearing:
//! no window, no answers.
//!
//! This is the other half of that trade. It is the table the proxy avoided —
//! and it turned out to be a fifth of the size the "106 registered commands"
//! figure suggested, because the v2 client only ever calls twenty of them.
//!
//! Everything here calls the `_impl` functions directly. The split is a leftover
//! of the days when a Tauri command wrapper called the same body — the wrappers
//! are gone, this table is the only caller, and the names stayed because
//! renaming forty functions would say nothing new.
//!
//! ## Argument names
//!
//! The client speaks camelCase because that is what Tauri's own convention
//! taught it (`extraDirs` for a Rust `extra_dirs`). Tauri does the conversion
//! invisibly; here it has to be done on purpose, so `arg` tries the camelCase
//! spelling first and the snake_case one after.
use std::sync::Arc;

use serde::de::DeserializeOwned;
use serde_json::{json, Value};

use crate::agent_chat::ChatManager;
use crate::file_watch::FileWatchState;
use crate::git_watch::GitWatchState;
use crate::pty::PtyManager;
use crate::workspaces::WorkspaceState;

/// Everything a request might need. The same values the Tauri app manages —
/// held by Arc so both can point at one set rather than each having its own.
#[derive(Clone)]
pub struct Services {
    pub workspaces: Arc<WorkspaceState>,
    pub chats: Arc<ChatManager>,
    pub watch: Arc<FileWatchState>,
    /// The fs watcher behind the live git counts and branch chips.
    pub git_watch: Arc<GitWatchState>,
    pub ptys: Arc<PtyManager>,
    /// Rounds in flight (card 68). One per chat, at most.
    pub rounds: Arc<crate::round::Rounds>,
}

impl Services {
    /// Load state from disk, as the app does at startup.
    pub fn load() -> Self {
        // Card 83 — who was sitting in each chat when this last stopped. A seat
        // has no process to restore (it is spawned when it is asked), so the
        // roster is the whole of it. What does NOT come back is the discussion:
        // `round::Rounds` is in memory and is written nowhere, so a restored
        // seat's view of the room starts here.
        let chats = Arc::new(ChatManager::default());
        if let Some(path) = crate::chat_room::rooms_path() {
            crate::chat_room::load_rooms(&chats, &path);
        }
        // A chat nobody has touched for a quarter of an hour is ended and
        // resumed on its next message. This is where it matters most: the
        // service runs for days, and every chat left open holds an agent and
        // its whole MCP fleet.
        crate::agent_chat::start_idle_reaper(chats.clone());
        Self {
            workspaces: Arc::new(WorkspaceState::load()),
            chats,
            watch: Arc::new(FileWatchState::default()),
            git_watch: Arc::new(GitWatchState::default()),
            ptys: Arc::new(PtyManager::default()),
            rounds: Arc::new(crate::round::Rounds::default()),
        }
    }
}

/// `camelCase` → `snake_case`, for looking a name up both ways.
fn snake(name: &str) -> String {
    let mut out = String::with_capacity(name.len() + 4);
    for ch in name.chars() {
        if ch.is_ascii_uppercase() {
            out.push('_');
            out.push(ch.to_ascii_lowercase());
        } else {
            out.push(ch);
        }
    }
    out
}

/// One argument, by either spelling. Missing means `null`, which is how an
/// `Option<T>` argument arrives when the client simply left it out.
fn arg<T: DeserializeOwned>(args: &Value, name: &str) -> Result<T, String> {
    let value = args
        .get(name)
        .or_else(|| args.get(snake(name)))
        .cloned()
        .unwrap_or(Value::Null);
    serde_json::from_value(value).map_err(|e| format!("bad argument '{name}': {e}"))
}

/// A command that answers with nothing.
fn unit(r: Result<(), String>) -> Result<Value, String> {
    r.map(|_| Value::Null)
}

/// A command that answers with something worth serializing.
fn to_value<T: serde::Serialize>(r: Result<T, String>) -> Result<Value, String> {
    r.and_then(|x| serde_json::to_value(x).map_err(|e| e.to_string()))
}

/// Run one command. `Err` is the message the client shows, so it is written for
/// a person rather than a log.
pub fn dispatch(svc: &Services, cmd: &str, args: Value) -> Result<Value, String> {
    match cmd {
        // ---- projects -----------------------------------------------------
        "list_workspaces" => to_value(crate::workspaces::list_workspaces_impl(&svc.workspaces)),
        "add_workspace" => to_value(crate::workspaces::add_workspace_impl(
            &svc.workspaces,
            arg(&args, "name")?,
            arg(&args, "primaryPath")?,
        )),
        "rename_workspace" => unit(crate::workspaces::rename_workspace_impl(
            &svc.workspaces,
            arg(&args, "id")?,
            arg(&args, "name")?,
        )),
        "delete_workspace" => unit(crate::workspaces::delete_workspace_impl(
            &svc.workspaces,
            arg(&args, "id")?,
        )),
        "set_primary_path" => unit(crate::workspaces::set_primary_path_impl(
            &svc.workspaces,
            arg(&args, "id")?,
            arg(&args, "path")?,
        )),
        "add_workspace_path" => unit(crate::workspaces::add_workspace_path_impl(
            &svc.workspaces,
            arg(&args, "id")?,
            arg(&args, "path")?,
        )),
        "remove_workspace_path" => unit(crate::workspaces::remove_workspace_path_impl(
            &svc.workspaces,
            arg(&args, "id")?,
            arg(&args, "path")?,
        )),
        "set_description" => unit(crate::workspaces::set_description_impl(
            &svc.workspaces,
            arg(&args, "id")?,
            arg(&args, "description")?,
        )),
        "set_workspace_shelved" => unit(crate::workspaces::set_workspace_shelved_impl(
            &svc.workspaces,
            arg(&args, "id")?,
            arg(&args, "shelved")?,
        )),

        // ---- saved commands -----------------------------------------------
        // A project's own commands — `pnpm dev`, `cargo test` — kept on the
        // backend rather than in a browser's storage, because the folder they
        // run in is the backend's and the phone that opens the project later
        // should offer the same list as the laptop that wrote it. They come
        // back with the project itself, on `list_workspaces`.
        "add_action" => to_value(crate::workspaces::add_action_impl(
            &svc.workspaces,
            arg(&args, "workspaceId")?,
            arg(&args, "label")?,
            arg(&args, "command")?,
        )),
        "update_action" => unit(crate::workspaces::update_action_impl(
            &svc.workspaces,
            arg(&args, "workspaceId")?,
            arg(&args, "actionId")?,
            arg(&args, "label")?,
            arg(&args, "command")?,
        )),
        "delete_action" => unit(crate::workspaces::delete_action_impl(
            &svc.workspaces,
            arg(&args, "workspaceId")?,
            arg(&args, "actionId")?,
        )),

        // ---- chats --------------------------------------------------------
        "chat_start" => unit(crate::agent_chat::chat_start_impl(
            svc.chats.clone(),
            arg(&args, "key")?,
            arg(&args, "cwd")?,
            arg(&args, "agent")?,
            arg(&args, "model")?,
            arg(&args, "access")?,
            arg(&args, "prompt")?,
            arg(&args, "resume")?,
            arg(&args, "extraDirs")?,
            arg(&args, "effort")?,
            arg(&args, "images")?,
            arg(&args, "lite")?,
        )),
        "chat_send" => unit(crate::agent_chat::chat_send_impl(
            svc.chats.clone(),
            arg(&args, "key")?,
            arg(&args, "text")?,
            arg(&args, "images")?,
            arg(&args, "to")?,
        )),
        // Card 67 — a seat's own process, started by its first message. The
        // mirror of `chat_start`, and the same two-call shape the client
        // already uses for the host.
        "chat_seat_start" => unit(crate::agent_chat::chat_seat_start_impl(
            svc.chats.clone(),
            arg(&args, "key")?,
            arg(&args, "seatId")?,
            arg(&args, "cwd")?,
            arg(&args, "prompt")?,
            arg(&args, "access")?,
            arg(&args, "extraDirs")?,
            arg(&args, "effort")?,
            arg(&args, "images")?,
        )),
        "chat_interrupt" => unit(crate::agent_chat::chat_interrupt_impl(
            &svc.chats,
            arg(&args, "key")?,
        )),
        "chat_set_access" => unit(crate::agent_chat::chat_set_access_impl(
            &svc.chats,
            arg(&args, "key")?,
            arg(&args, "access")?,
        )),
        "chat_stop" => unit(crate::agent_chat::chat_stop_impl(
            &svc.chats,
            arg(&args, "key")?,
        )),
        // A fresh process for a conversation that carries on: the only way a
        // chat already open picks up an MCP server or a plugin added since it
        // started.
        "chat_restart" => to_value(crate::agent_chat::chat_restart_impl(
            &svc.chats,
            arg(&args, "key")?,
        )),
        "chat_list" => to_value(crate::agent_chat::chat_list_impl(&svc.chats)),
        // Card 68 — put one thing to every seat, in order, one at a time.
        "chat_round" => unit(crate::round::start_round_impl(
            svc.rounds.clone(),
            svc.chats.clone(),
            arg(&args, "key")?,
            arg(&args, "order")?,
            arg(&args, "text")?,
            arg(&args, "cwd")?,
            arg(&args, "access")?,
            arg(&args, "extraDirs")?,
            arg(&args, "effort")?,
            // Card 69 — what the host chose to show them. Absent means the
            // mechanical window.
            arg(&args, "history")?,
        )),
        // Card 70 — the HOST agent's own two tools, reached through the MCP
        // server it was handed at spawn.
        "chat_seat_ask" => to_value(crate::round::ask_seat_impl(
            svc.rounds.clone(),
            svc.chats.clone(),
            arg(&args, "key")?,
            arg(&args, "seatId")?,
            arg(&args, "prompt")?,
            arg(&args, "cwd")?,
        )),
        "chat_new_topic" => {
            svc.rounds.new_topic(&arg::<String>(&args, "key")?);
            Ok(json!(null))
        }
        "chat_round_stop" => {
            svc.rounds.raise_hand(&arg::<String>(&args, "key")?);
            Ok(json!(null))
        }
        "chat_round_state" => Ok(json!(crate::round::state_impl(
            &svc.rounds,
            &arg::<String>(&args, "key")?
        ))),
        // Card 66 — the room.
        // Card 82 removed `chat_set_room`: adding a seat is what makes a chat a
        // room, so there is nothing left to switch.
        "chat_add_agent" => {
            let key: String = arg(&args, "key")?;
            // Card 77 — a seat is shown the room from here on, never before.
            let joined_at = svc.rounds.said_so_far(&key);
            let added =
                crate::chat_room::add_seat_at(&svc.chats, &key, arg(&args, "seat")?, joined_at);
            // Card 83 — the roster has to survive this process.
            if added.is_ok() {
                crate::chat_room::remember_rooms(&svc.chats);
            }
            to_value(added)
        }
        "chat_remove_agent" => {
            let key: String = arg(&args, "key")?;
            unit(
                crate::chat_room::remove_seat_impl(
                    &svc.chats,
                    &key,
                    &arg::<String>(&args, "seatId")?,
                )
                .and_then(|ended| {
                    crate::chat_room::end_seats(&svc.chats, ended);
                    // Card 82 — the last one out takes the discussion too.
                    if crate::chat_room::is_empty(&svc.chats, &key)? {
                        crate::round::forget_room(&svc.rounds, &key);
                    }
                    crate::chat_room::remember_rooms(&svc.chats);
                    Ok(())
                }),
            )
        }
        // A deleted chat gives up its room, everyone in it, and what they said.
        "chat_forget_room" => {
            let key: String = arg(&args, "key")?;
            unit(
                crate::chat_room::forget_room_impl(&svc.chats, &key).map(|ended| {
                    crate::chat_room::end_seats(&svc.chats, ended);
                    crate::round::forget_room(&svc.rounds, &key);
                    crate::chat_room::remember_rooms(&svc.chats);
                }),
            )
        }
        "chat_room" => to_value(crate::chat_room::room_impl(
            &svc.chats,
            &arg::<String>(&args, "key")?,
        )),
        "chat_since" => Ok(json!(crate::agent_chat::chat_since(
            arg(&args, "key")?,
            arg(&args, "after")?,
        ))),
        "chat_index_list" => Ok(json!(crate::agent_chat::chat_index_list())),
        // The agents' OWN past sessions, for the search that resumes one.
        "agent_history_list" => Ok(json!(crate::agent_history::agent_history_list(arg(
            &args, "limit"
        )?))),
        // What was SAID in one of them, so it can be read before it is picked
        // up. The events come back in the shape the chat reducer already folds.
        "agent_history_read" => Ok(json!(crate::agent_history::agent_history_read(
            arg(&args, "agent")?,
            arg(&args, "sessionId")?,
        )?)),
        "chat_index_save" => unit(crate::agent_chat::chat_index_save(arg(&args, "meta")?)),
        "chat_index_remove" => unit(crate::agent_chat::chat_index_remove(
            arg(&args, "id")?,
            arg(&args, "key")?,
        )),
        "chat_forget" => {
            crate::agent_chat::chat_forget(arg(&args, "key")?);
            Ok(Value::Null)
        }
        "save_attachment" => to_value(crate::agent_chat::save_attachment(
            arg(&args, "dataBase64")?,
            arg(&args, "extension")?,
        )),

        // ---- files --------------------------------------------------------
        "list_dir" => to_value(crate::fsbrowse::list_dir(arg(&args, "path")?)),
        "read_file_preview" => to_value(crate::fsbrowse::read_file_preview(arg(&args, "path")?)),
        "write_file" => unit(crate::fsbrowse::write_file_impl(
            &svc.workspaces,
            arg(&args, "path")?,
            arg(&args, "content")?,
        )),
        "resolve_paths" => Ok(json!(crate::fsbrowse::resolve_paths(
            arg(&args, "paths")?,
            arg(&args, "cwd")?,
        ))),
        "stat_paths" => Ok(json!(crate::fsbrowse::stat_paths(arg(&args, "paths")?))),
        "file_watch_paths" => unit(crate::file_watch::file_watch_paths_impl(
            &svc.watch,
            arg(&args, "paths")?,
        )),

        // ---- terminals ----------------------------------------------------
        // A shell in the browser, in the project's own folder. The PTY streams
        // as `pty-output` events over the same socket the chat uses, so there
        // is nothing new to plumb — only these to call.
        "pty_spawn" => unit(crate::pty::pty_spawn_impl(
            svc.ptys.clone(),
            arg(&args, "id")?,
            arg(&args, "cwd")?,
            arg(&args, "startCmd")?,
            arg(&args, "persistKey")?,
            arg(&args, "shell")?,
            arg(&args, "canvasKey")?,
        )),
        "pty_write" => unit(crate::pty::pty_write_impl(
            &svc.ptys,
            arg(&args, "id")?,
            arg(&args, "data")?,
        )),
        // rows BEFORE cols — both are u16, so getting this the wrong way round
        // compiles perfectly and silently transposes every terminal.
        "pty_resize" => unit(crate::pty::pty_resize_impl(
            &svc.ptys,
            arg(&args, "id")?,
            arg(&args, "rows")?,
            arg(&args, "cols")?,
        )),
        "pty_close" => unit(crate::pty::pty_close_impl(&svc.ptys, arg(&args, "id")?)),
        "pty_list_active" => to_value(crate::pty::pty_list_active_impl(&svc.ptys)),
        "pty_active_sessions" => to_value(crate::pty::pty_active_sessions_impl(&svc.ptys)),
        "pty_set_visible" => unit(crate::pty::pty_set_visible_impl(
            &svc.ptys,
            arg(&args, "id")?,
            arg(&args, "visible")?,
        )),
        // Re-attaching: replay what this terminal already printed, so coming
        // back to a running dev server is not a blank pane (card 64).
        "pty_attach" => unit(crate::pty::pty_attach_impl(&svc.ptys, arg(&args, "id")?)),

        // ---- permissions --------------------------------------------------
        // What is waiting on a person right now. Asked by a browser as it
        // connects: a permission is announced once, over a broadcast with no
        // replay, so without this a reload lost the card and left the agent
        // waiting out its timeout on a question nobody could still see.
        "permission_pending" => Ok(json!(crate::permission::pending())),
        // Answering a question an agent is currently blocked on.
        "permission_decide" => {
            let id: String = arg(&args, "id")?;
            let decision: crate::permission::Decision = arg(&args, "decision")?;
            // "Always" is an allow that is kept for the rest of this chat.
            // Absent means once, which is what every older client sends.
            let remember = args
                .get("remember")
                .and_then(serde_json::Value::as_bool)
                .unwrap_or(false);
            Ok(json!(crate::permission::decide(&id, decision, remember)))
        }

        // ---- questions ----------------------------------------------------
        // The same, for `ask_user`. Its wait is ten minutes, so a question
        // stranded by a reload was the longest a chat could sit looking dead.
        "question_pending" => Ok(json!(crate::question::pending())),
        "question_answer" => Ok(json!(crate::question::answer(
            &arg::<String>(&args, "id")?,
            arg(&args, "answer")?,
        ))),

        // ---- git ----------------------------------------------------------
        // No `_impl` split here: git.rs and git_ops.rs never held managed state,
        // so they were already plain functions before the window went and there
        // was never a wrapper to strip.
        "git_status_summary" => to_value(crate::git::git_status_summary(arg(&args, "paths")?)),
        "git_changed_files" => to_value(crate::git::git_changed_files(arg(&args, "paths")?)),
        "git_file_diff" => to_value(crate::git::git_file_diff(
            arg(&args, "root")?,
            arg(&args, "file")?,
            arg(&args, "untracked")?,
            arg(&args, "oldPath")?,
        )),
        "git_local_branches" => to_value(crate::git::git_local_branches(arg(&args, "path")?)),
        // Live git state. Without this the browser only ever re-read on focus,
        // so an agent switching branch mid-turn left the toolbar naming the
        // branch you were on before it did.
        "git_watch_paths" => unit(crate::git_watch::git_watch_paths_impl(
            &svc.git_watch,
            arg(&args, "paths")?,
        )),

        // Writes. Reachable from a browser, deliberately — doing this from a
        // phone is the point of v2. Each is one git invocation whose own output
        // is handed back verbatim rather than summarised away.
        "git_commit" => to_value(crate::git_ops::git_commit(
            arg(&args, "root")?,
            arg(&args, "files")?,
            arg(&args, "message")?,
        )),
        "git_push" => to_value(crate::git_ops::git_push(arg(&args, "root")?)),
        "git_pull" => to_value(crate::git_ops::git_pull(
            arg(&args, "root")?,
            arg(&args, "mode")?,
        )),
        "git_switch_branch" => to_value(crate::git_ops::git_switch_branch(
            arg(&args, "root")?,
            arg(&args, "branch")?,
        )),

        // ---- finding files ------------------------------------------------
        "search_files" => to_value(crate::fsbrowse::search_files(
            arg(&args, "roots")?,
            arg(&args, "query")?,
        )),
        "list_project_files" => to_value(crate::fsbrowse::list_project_files(arg(&args, "roots")?)),

        // ---- usage --------------------------------------------------------
        "usage_summary" => Ok(json!(crate::usage_limits::usage_summary())),

        // ---- agents -------------------------------------------------------
        // Which agent CLIs this machine actually has. The browser needs it for
        // the same reason the desktop menu does: offering an agent that is not
        // installed only produces a chat that dies on its first line.
        "agent_installs" => Ok(json!(crate::agents::agent_installs(arg(&args, "refresh")?))),

        // ---- web push -----------------------------------------------------
        //
        // The notifications that arrive with nothing open. Only the browser
        // ever calls these — a desktop window raises its own banners and has no
        // push service to register with — so they live here and have no Tauri
        // command beside them.
        "push_key" => match crate::push::public_key() {
            Some(key) => Ok(json!({ "key": key })),
            None => Err("could not read or create the push key".into()),
        },
        "push_subscribe" => {
            crate::push::subscribe(crate::push::Subscription {
                endpoint: arg(&args, "endpoint")?,
                p256dh: arg(&args, "p256dh")?,
                auth: arg(&args, "auth")?,
            });
            Ok(Value::Null)
        }
        "push_unsubscribe" => {
            let endpoint: String = arg(&args, "endpoint")?;
            crate::push::unsubscribe(&endpoint);
            Ok(Value::Null)
        }

        // Anything else, this backend does not know. Saying so beats a silent
        // null, which would look like a bug in the client. In practice the
        // reason is almost always a server older than the page asking it.
        _ => Err(format!(
            "'{cmd}' is not available on this backend — it may be older than the page asking for it"
        )),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn argument_names_are_accepted_in_either_spelling() {
        let camel = json!({ "extraDirs": ["/a"] });
        let snake_case = json!({ "extra_dirs": ["/a"] });
        let a: Vec<String> = arg(&camel, "extraDirs").unwrap();
        let b: Vec<String> = arg(&snake_case, "extraDirs").unwrap();
        assert_eq!(a, b);
        assert_eq!(a, vec!["/a".to_string()]);
    }

    #[test]
    fn a_missing_optional_argument_is_none_not_an_error() {
        let empty = json!({});
        let missing: Option<String> = arg(&empty, "model").unwrap();
        assert!(missing.is_none());
    }

    #[test]
    fn a_missing_required_argument_says_which_one() {
        let empty = json!({});
        let err = arg::<String>(&empty, "key").unwrap_err();
        assert!(err.contains("key"), "{err}");
    }

    #[test]
    fn snake_conversion_matches_tauris_own() {
        assert_eq!(snake("extraDirs"), "extra_dirs");
        assert_eq!(snake("dataBase64"), "data_base64");
        assert_eq!(snake("path"), "path");
    }

    /// The browser can only call what this table lists. Writing the backend
    /// function and forgetting this row is the whole failure mode: the code
    /// reads as finished, `cargo test` is green, and the client gets "unknown
    /// command" for something that is sitting right there.
    #[test]
    fn a_browser_can_ask_which_agents_are_installed() {
        crate::agents::seed_probe_for_test(vec![("codex".into(), "/opt/bin/codex".into())]);
        let svc = Services::load();
        let out = dispatch(&svc, "agent_installs", json!({})).expect("routed");
        let rows = out.as_array().expect("an array of agents");
        assert_eq!(rows.len(), crate::agents::KNOWN_AGENTS.len());
        // Every agent is named, installed or not — that IS the answer the page
        // renders, so a missing agent must not be a missing row.
        assert_eq!(rows[0]["id"], "claude");
        assert_eq!(rows[0]["installed"], false);
        assert_eq!(rows[1]["id"], "codex");
        assert_eq!(rows[1]["installed"], true);
        assert_eq!(rows[1]["path"], "/opt/bin/codex");
    }

    /// Same failure mode as the row above, and the one the search on the empty
    /// chat page depends on: a phone with no route here shows no history at all.
    /// The machine running the test may have no agent sessions on it, so this
    /// asserts the SHAPE of the answer rather than anything in it.
    #[test]
    fn a_browser_can_ask_for_the_agents_own_past_sessions() {
        let svc = Services::load();
        let out = dispatch(&svc, "agent_history_list", json!({ "limit": 5 })).expect("routed");
        let rows = out.as_array().expect("an array of sessions");
        assert!(rows.len() <= 5, "the limit is respected: {}", rows.len());
    }

    #[test]
    fn a_command_this_backend_does_not_know_is_refused_by_name() {
        let svc = Services::load();
        // This used to be about `pick_folder` and the native dialog it opened,
        // which is a distinction the code stopped making when the window went:
        // there is no desktop app to route anything to, so a command that is
        // not in the table is simply not in the table.
        //
        // The arm is still worth a test, for the reason it exists. The two
        // halves deploy separately, so a page can be newer than the server
        // answering it, and this message is all the user gets when it is — it
        // has to name the command, or "something failed" is the whole report.
        let err = dispatch(&svc, "no_such_command", json!({})).unwrap_err();
        assert!(err.contains("no_such_command"), "{err}");
        assert!(err.contains("not available on this backend"), "{err}");
    }
}
