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
//! Everything here calls the SAME `_impl` functions the Tauri commands call, so
//! there is one implementation of each and no second copy to drift.
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
use crate::pty::PtyManager;
use crate::workspaces::WorkspaceState;

/// Everything a request might need. The same values the Tauri app manages —
/// held by Arc so both can point at one set rather than each having its own.
#[derive(Clone)]
pub struct Services {
    pub workspaces: Arc<WorkspaceState>,
    pub chats: Arc<ChatManager>,
    pub watch: Arc<FileWatchState>,
    pub ptys: Arc<PtyManager>,
}

impl Services {
    /// Load state from disk, as the app does at startup.
    pub fn load() -> Self {
        Self {
            workspaces: Arc::new(WorkspaceState::load()),
            chats: Arc::new(ChatManager::default()),
            watch: Arc::new(FileWatchState::default()),
            ptys: Arc::new(PtyManager::default()),
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
        )),
        "chat_send" => unit(crate::agent_chat::chat_send_impl(
            &svc.chats,
            arg(&args, "key")?,
            arg(&args, "text")?,
            arg(&args, "images")?,
        )),
        "chat_interrupt" => unit(crate::agent_chat::chat_interrupt_impl(
            &svc.chats,
            arg(&args, "key")?,
        )),
        "chat_stop" => unit(crate::agent_chat::chat_stop_impl(
            &svc.chats,
            arg(&args, "key")?,
        )),
        "chat_list" => to_value(crate::agent_chat::chat_list_impl(&svc.chats)),
        "chat_since" => Ok(json!(crate::agent_chat::chat_since(
            arg(&args, "key")?,
            arg(&args, "after")?,
        ))),
        "chat_index_list" => Ok(json!(crate::agent_chat::chat_index_list())),
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

        // ---- permissions --------------------------------------------------
        // Answering a question an agent is currently blocked on.
        "permission_decide" => {
            let id: String = arg(&args, "id")?;
            let decision: crate::permission::Decision = arg(&args, "decision")?;
            Ok(json!(crate::permission::decide(&id, decision)))
        }

        // ---- questions ----------------------------------------------------
        "question_answer" => Ok(json!(crate::question::answer(
            &arg::<String>(&args, "id")?,
            arg(&args, "answer")?,
        ))),

        // ---- usage --------------------------------------------------------
        "usage_summary" => Ok(json!(crate::usage_limits::usage_summary())),

        // Anything else is a command the classic desktop UI owns. Saying so
        // beats a silent null, which would look like a bug in the client.
        _ => Err(format!(
            "'{cmd}' is not available from a browser — it needs the desktop app"
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

    #[test]
    fn a_desktop_only_command_is_refused_by_name() {
        let svc = Services::load();
        // pick_folder opens a NATIVE dialog, so it can only ever belong to the
        // desktop app — a dialog on the server would open where nobody is.
        let err = dispatch(&svc, "pick_folder", json!({})).unwrap_err();
        assert!(err.contains("pick_folder"), "{err}");
        assert!(err.contains("desktop app"), "{err}");
    }
}
