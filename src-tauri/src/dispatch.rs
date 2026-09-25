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

mod pull_requests;

use crate::agent_chat::ChatManager;
use crate::file_watch::FileWatchState;
use crate::git_watch::GitWatchState;
use crate::orchestration::OrchestrationStore;
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
    /// Durable runs, task DAGs, authoritative worker attempts and gates.
    pub orchestrations: Arc<OrchestrationStore>,
    pub ptys: Arc<PtyManager>,
}

impl Services {
    /// Load state from disk, as the app does at startup.
    pub fn load() -> Self {
        let question_path = crate::transcript::chats_dir()
            .unwrap_or_else(|| crate::profile::profile_dir().join("chats"))
            .join("questions.json");
        let orchestrations = Arc::new(OrchestrationStore::load_profile());
        let mut chats = ChatManager::with_saved_questions(question_path);
        chats.orchestrations = orchestrations.clone();
        let chats = Arc::new(chats);
        // A chat nobody has touched for a quarter of an hour is ended and
        // resumed on its next message. This is where it matters most: the
        // service runs for days, and every chat left open holds an agent and
        // its whole MCP fleet.
        crate::agent_chat::start_idle_reaper(chats.clone());
        crate::agent_chat::start_auto_resume_scheduler(chats.clone());
        let workspaces = Arc::new(WorkspaceState::load());
        crate::orchestration::automation::start_scheduler(
            orchestrations.clone(),
            chats.clone(),
            workspaces.clone(),
        );
        Self {
            workspaces,
            chats,
            watch: Arc::new(FileWatchState::default()),
            git_watch: Arc::new(GitWatchState::default()),
            orchestrations,
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
    let git_write_path = match cmd {
        "git_commit" | "git_push" | "git_pull" | "git_switch_branch" => {
            Some(arg::<String>(&args, "root")?)
        }
        "git_prepare_chat_workspace" if !arg::<bool>(&args, "newWorktree")? => {
            Some(arg::<String>(&args, "path")?)
        }
        _ => None,
    };
    let _workspace_git_guard = git_write_path
        .as_deref()
        .map(|path| svc.orchestrations.guard_git_operation(path))
        .transpose()?;

    // Browser-facing mutation routes never drive an orchestration worker.
    // The coordinator's internal launch/message/report paths call their
    // implementations directly, without a client-controlled bypass flag.
    match cmd {
        "chat_start"
        | "sandbox_action"
        | "chat_send"
        | "chat_cancel_auto_resume"
        | "chat_cancel_queued"
        | "chat_dismiss_unsent"
        | "chat_start_queued"
        | "chat_interrupt"
        | "chat_set_access"
        | "chat_stop"
        | "chat_retarget"
        | "chat_restart"
        | "chat_forget" => {
            svc.orchestrations
                .require_user_chat(&arg::<String>(&args, "key")?)?;
            if cmd == "chat_start" {
                if let Some(resume) = arg::<Option<String>>(&args, "resume")? {
                    svc.chats.require_user_resume(&resume)?;
                }
            }
        }
        "chat_index_remove" => {
            svc.orchestrations
                .require_user_chat(&format!("chat:{}", arg::<String>(&args, "id")?))?;
            svc.orchestrations
                .require_user_chat(&arg::<String>(&args, "key")?)?;
        }
        "question_answer" | "question_answer_batch" | "question_retry" | "question_cancel" => {
            let ids: Vec<String> = match cmd {
                "question_answer" => vec![arg(&args, "id")?],
                "question_answer_batch" => {
                    arg::<Vec<crate::question_store::Answer>>(&args, "answers")?
                        .into_iter()
                        .map(|answer| answer.id)
                        .collect()
                }
                _ => arg(&args, "ids")?,
            };
            for question in svc.chats.questions.pending()? {
                if ids.contains(&question.id) {
                    if let Some(key) = &question.question.chat_key {
                        svc.orchestrations.require_user_chat(key)?;
                    }
                }
            }
        }
        _ => {}
    }
    match cmd {
        // ---- projects -----------------------------------------------------
        "feedback_list" => crate::feedback::Store::profile().list(
            serde_json::from_value(args).map_err(|e| format!("Invalid feedback filter: {e}"))?,
        ),
        "feedback_get" => {
            to_value(crate::feedback::Store::profile().get(&arg::<String>(&args, "id")?))
        }
        "feedback_update" => to_value(crate::feedback::Store::profile().update(
            serde_json::from_value(args).map_err(|e| format!("Invalid feedback update: {e}"))?,
        )),
        "feedback_agent" => crate::feedback::agent_call(
            svc,
            &arg::<String>(&args, "chatKey")?,
            &arg::<String>(&args, "action")?,
            arg(&args, "args")?,
        ),
        "memory_vault_settings" => to_value(crate::memory_vault::Vault::profile().settings()),
        "memory_vault_configure" => {
            to_value(crate::memory_vault::Vault::profile().configure(arg(&args, "config")?))
        }
        "memory_vault_call" => crate::memory_vault::Vault::profile().call(
            "browser",
            &arg::<String>(&args, "action")?,
            &arg::<Value>(&args, "args")?,
        ),
        "memory_vault_agent" => {
            let key: String = arg(&args, "chatKey")?;
            let id = key.strip_prefix("chat:").unwrap_or(&key);
            if !crate::chat_index::list()
                .iter()
                .any(|chat| chat.id == id && chat.deleted_at.is_none())
            {
                return Err("This chat is not in the active chat index.".into());
            }
            let action: String = arg(&args, "action")?;
            // Agents mode: an agent's own memory. Identity comes from the chat,
            // never from the tool's arguments.
            if let Some(op) = action.strip_prefix("agent_memory_") {
                let actor = format!("chat:{id}");
                let team_path = crate::team::default_path();
                let (me, team) = crate::team::identity(
                    &team_path,
                    &actor,
                    svc.orchestrations.assignee_for_worker(&actor)?,
                )?;
                let tool: Value = arg(&args, "args")?;
                let text = |name: &str| tool.get(name).and_then(Value::as_str);
                let vault = crate::memory_vault::Vault::profile();
                return match op {
                    "read" => crate::team::memory_read(
                        &vault,
                        &actor,
                        &me,
                        &team,
                        text("agent"),
                        tool.get("startLine").and_then(Value::as_u64),
                    ),
                    "append" => crate::team::memory_append(
                        &vault,
                        &actor,
                        &me,
                        text("text").unwrap_or_default(),
                        text("date"),
                        text("requestId").ok_or("Pass a unique requestId.")?,
                    ),
                    _ => Err("Unknown agent memory operation.".into()),
                };
            }
            crate::memory_vault::Vault::profile().call(
                &format!("chat:{id}"),
                &arg::<String>(&args, "action")?,
                &arg::<Value>(&args, "args")?,
            )
        }
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
        "set_workspace_color" => unit(crate::workspaces::set_workspace_color_impl(
            &svc.workspaces,
            arg(&args, "id")?,
            arg(&args, "color")?,
        )),
        "set_workspace_initial" => unit(crate::workspaces::set_workspace_initial_impl(
            &svc.workspaces,
            arg(&args, "id")?,
            arg(&args, "initial")?,
        )),
        "set_workspace_icon" => unit(crate::workspaces::set_workspace_icon_impl(
            &svc.workspaces,
            arg(&args, "id")?,
            arg(&args, "icon")?,
        )),
        "set_workspace_env" => unit(crate::workspaces::set_workspace_env_impl(
            &svc.workspaces,
            arg(&args, "id")?,
            arg(&args, "env")?,
        )),
        "set_workspace_shelved" => unit(crate::workspaces::set_workspace_shelved_impl(
            &svc.workspaces,
            arg(&args, "id")?,
            arg(&args, "shelved")?,
        )),
        "reorder_workspaces" => unit(crate::workspaces::reorder_workspaces_impl(
            &svc.workspaces,
            arg(&args, "orderedIds")?,
        )),
        "set_workspace_sibling" => unit(crate::workspaces::set_workspace_sibling_impl(
            &svc.workspaces,
            arg(&args, "id")?,
            arg(&args, "siblingId")?,
            arg(&args, "linked")?,
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
        "sandbox_snapshot" => to_value(crate::sandbox::Store::profile().snapshot()),
        "sandbox_configure" => {
            to_value(crate::sandbox::Store::profile().configure(arg(&args, "enabled")?))
        }
        "sandbox_action" => {
            let key: String = arg(&args, "key")?;
            let action: String = arg(&args, "action")?;
            let confirmation: Option<String> = arg(&args, "confirmation")?;
            to_value(crate::sandbox::Store::profile().action_when_idle(
                &key,
                &action,
                confirmation.as_deref(),
                || crate::agent_chat::end_idle_for_sandbox(&svc.chats, &key),
            ))
        }
        "chat_start" => {
            crate::sandbox::Store::profile().select(
                &arg::<String>(&args, "key")?,
                &arg::<String>(&args, "cwd")?,
                arg(&args, "useSandbox")?,
                arg::<Option<String>>(&args, "resume")?.is_some(),
            )?;
            unit(crate::agent_chat::chat_start_user_impl(
                svc.chats.clone(),
                arg(&args, "key")?,
                arg(&args, "cwd")?,
                arg(&args, "agent")?,
                arg(&args, "model")?,
                arg(&args, "access")?,
                arg(&args, "prompt")?,
                arg(&args, "handoff")?,
                arg(&args, "resume")?,
                arg(&args, "extraDirs")?,
                arg(&args, "env")?,
                arg(&args, "effort")?,
                arg(&args, "images")?,
                arg(&args, "lite")?,
                arg(&args, "turnId")?,
            ))
        }
        "chat_send" => unit(crate::agent_chat::chat_send_user_impl(
            svc.chats.clone(),
            arg(&args, "key")?,
            arg(&args, "text")?,
            arg(&args, "images")?,
            arg(&args, "to")?,
            arg(&args, "turnId")?,
            arg(&args, "recordUser")?,
        )),
        "chat_cancel_auto_resume" => to_value(crate::agent_chat::chat_cancel_auto_resume_impl(
            &svc.chats,
            arg(&args, "key")?,
        )),
        // Take back a message the agent has not been given yet. Answers
        // `false` when it was already handed over, which the page needs: the
        // bubble stays, because an answer to it is on its way.
        "chat_cancel_queued" => to_value(crate::agent_chat::chat_cancel_queued_impl(
            &svc.chats,
            arg(&args, "key")?,
            arg(&args, "turnId")?,
        )),
        // Permanently hide a prompt that queue reconciliation established was
        // lost. This is distinct from taking back a live queued message: its
        // words stay out of the composer and the dismissal survives replay.
        "chat_dismiss_unsent" => to_value(crate::agent_chat::chat_dismiss_unsent_impl(
            &svc.chats,
            arg(&args, "key")?,
            arg(&args, "turnId")?,
        )),
        // Make one selected queued message the next turn, without discarding
        // anything else the person already sent.
        "chat_start_queued" => to_value(crate::agent_chat::chat_start_queued_impl(
            &svc.chats,
            arg(&args, "key")?,
            arg(&args, "turnId")?,
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
        // Replace the provider behind one user conversation. Unlike
        // `chat_stop`, a model switch keeps standing permissions; unlike
        // `chat_restart`, the old provider's start context must not be
        // resumable while the browser prepares its handoff.
        "chat_retarget" => unit(crate::agent_chat::chat_retarget_impl(
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
        "chat_queue_state" => to_value(crate::agent_chat::chat_queue_state_impl(
            &svc.chats,
            &arg::<String>(&args, "key")?,
        )),
        "chat_since" => Ok(json!(crate::agent_chat::chat_since(
            arg(&args, "key")?,
            arg(&args, "after")?,
        ))),
        "chat_page" => to_value(crate::transcript::page(
            &arg::<String>(&args, "key")?,
            arg(&args, "before")?,
        )),
        "chat_index_list" => Ok(json!(crate::agent_chat::chat_index_list())),
        "chat_index_deleted" => Ok(json!(crate::agent_chat::chat_index_deleted())),
        // Where this chat is and what became of its work. The report half is
        // whatever the agent last said; everything else is checked with git on
        // the way out (`chat_task.rs`).
        "chat_task" => to_value(crate::chat_task::chat_task_impl(
            arg(&args, "chatId")?,
            arg::<Option<bool>>(&args, "refresh")?.unwrap_or(false),
        )),
        "chat_task_report" => {
            let status = crate::chat_task::chat_task_report_impl(
                arg(&args, "chatId")?,
                arg(&args, "objective")?,
                arg::<Option<String>>(&args, "nextStep")?.unwrap_or_default(),
                arg::<Option<Vec<crate::chat_task::TaskStep>>>(&args, "steps")?.unwrap_or_default(),
                arg::<Option<String>>(&args, "reportedBy")?.unwrap_or_default(),
            )?;
            if let Some(report) = &status.report {
                let summary = report
                    .steps
                    .iter()
                    .find(|s| s.state == "active")
                    .map(|s| s.title.as_str())
                    .unwrap_or(&report.next_step);
                svc.orchestrations.observe_worker_event(
                    &format!("chat:{}", status.chat_id),
                    &json!({"type":"octiq.progress", "summary": summary}),
                )?;
            }
            to_value(Ok(status))
        }
        "chat_task_set_target" => to_value(crate::chat_task::chat_task_set_target_impl(
            arg(&args, "chatId")?,
            arg(&args, "branch")?,
            arg::<Option<String>>(&args, "setBy")?.unwrap_or_default(),
        )),
        "chat_task_set_release_check" => {
            to_value(crate::chat_task::chat_task_set_release_check_impl(
                arg(&args, "projectId")?,
                arg(&args, "reference")?,
                arg(&args, "command")?,
            ))
        }
        "chat_search" => to_value(crate::chat_search::search(
            &svc.workspaces,
            arg(&args, "query")?,
            arg(&args, "limit")?,
        )),
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
        "chat_set_agent_title" => to_value(crate::agent_chat::chat_set_agent_title(
            arg(&args, "chatId")?,
            arg(&args, "title")?,
        )),
        "chat_mark_read" => unit(crate::agent_chat::chat_mark_read(
            arg(&args, "id")?,
            arg(&args, "at")?,
        )),
        "chat_set_done" => unit(crate::agent_chat::chat_set_done(
            arg(&args, "id")?,
            arg(&args, "at")?,
        )),
        "chat_index_remove" => {
            let id: String = arg(&args, "id")?;
            crate::agent_chat::chat_index_remove(
                id.clone(),
                arg(&args, "key")?,
                arg(&args, "expectedGeneration")?,
                arg(&args, "meta")?,
            )?;
            // An old delete retried after restore is a no-op, including for
            // questions in the restored chat.
            if crate::chat_index::deleted()
                .iter()
                .any(|meta| meta.id == id)
            {
                crate::agent_chat::chat_stop_impl(&svc.chats, format!("chat:{id}"))?;
            }
            Ok(Value::Null)
        }
        "chat_index_restore" => to_value(crate::agent_chat::chat_index_restore(arg(&args, "id")?)),
        "chat_forget" => {
            let key: String = arg(&args, "key")?;
            crate::agent_chat::chat_stop_impl(&svc.chats, key.clone())?;
            crate::agent_chat::chat_forget(key);
            Ok(Value::Null)
        }
        "image_preview_list" => to_value(crate::image_preview::list(&arg::<String>(&args, "key")?)),
        "save_attachment" => to_value(crate::agent_chat::save_attachment(
            arg(&args, "dataBase64")?,
            arg(&args, "extension")?,
            arg(&args, "filename")?,
        )),

        // ---- files --------------------------------------------------------
        "list_dir" => to_value(crate::fsbrowse::list_dir(arg(&args, "path")?)),
        "read_file_preview" => to_value(crate::fsbrowse::read_file_preview(arg(&args, "path")?)),
        "open_file_native" => unit(crate::fsbrowse::open_file_native(arg(&args, "path")?)),
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
            arg(&args, "env")?,
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

        // Codex has no resumable permission channel. A safety-policy rejection
        // is therefore a post-hoc choice about the next user turn, kept long
        // enough to survive a browser reload.
        "safety_block_pending" => Ok(json!(crate::safety_block::pending())),
        "safety_block_dismiss" => Ok(json!(crate::safety_block::dismiss(&arg::<String>(
            &args, "id"
        )?,))),
        "safety_block_authorize_project" => {
            let id: String = arg(&args, "id")?;
            Ok(json!(crate::safety_block::authorize_for_project(&id)?))
        }

        // ---- questions ----------------------------------------------------
        "question_pending" => to_value(svc.chats.questions.pending()),
        "question_answer" => {
            svc.chats
                .questions
                .answer(&[crate::question_store::Answer {
                    id: arg(&args, "id")?,
                    answer: arg(&args, "answer")?,
                }])?;
            Ok(json!(true))
        }
        "question_answer_batch" => {
            svc.chats
                .questions
                .answer(&arg::<Vec<crate::question_store::Answer>>(
                    &args, "answers",
                )?)?;
            Ok(json!({ "saved": true }))
        }
        "question_cancel" => unit(crate::agent_chat::cancel_questions(
            &svc.chats,
            &arg::<Vec<String>>(&args, "ids")?,
        )),
        "question_retry" => {
            let _delivery = svc
                .chats
                .questions
                .delivery_lock
                .lock()
                .map_err(|e| e.to_string())?;
            svc.chats
                .questions
                .retry(&arg::<Vec<String>>(&args, "ids")?)?;
            Ok(json!({ "saved": true }))
        }

        // ---- orchestration -----------------------------------------------
        // The backend, not an agent transcript, owns run and task state. MCP
        // calls arrive through the same commands with actorChatKey injected by
        // the authenticated local hook; the browser supplies the coordinator
        // key when it resolves a visible gate or starts a run explicitly.
        "orchestration_snapshot" => {
            let run_id: Option<String> = arg(&args, "runId")?;
            let snapshot = svc.orchestrations.snapshot(run_id.as_deref());
            // An agent's read lands in its transcript and goes out to every
            // tab, so it gets the compact view; the browser, which names no
            // actor, keeps the whole store.
            let Some(actor) = arg::<Option<String>>(&args, "actorChatKey")? else {
                return to_value(snapshot);
            };
            let task_id: Option<String> = arg(&args, "taskId")?;
            let message_limit: Option<usize> = arg(&args, "messageLimit")?;
            crate::orchestration::agent_view::agent_snapshot(
                snapshot?,
                &crate::orchestration::agent_view::AgentRead {
                    actor: &actor,
                    run_id: run_id.as_deref(),
                    task_id: task_id.as_deref(),
                    message_limit: message_limit
                        .unwrap_or(crate::orchestration::agent_view::DEFAULT_MESSAGES),
                },
            )
        }
        "orchestration_service_register" => {
            let actor: String = arg(&args, "actorChatKey")?;
            let registration = serde_json::from_value(args).map_err(|e| e.to_string())?;
            to_value(svc.orchestrations.register_service(&actor, registration))
        }
        "orchestration_run_create" => {
            let actor: String = arg(&args, "actorChatKey")?;
            let start_master = arg::<Option<bool>>(&args, "startMaster")?.unwrap_or(false);
            if start_master && !crate::agent_chat::chat_can_continue_internal(&svc.chats, &actor)? {
                return Err("This chat has not run since OctiqFlow restarted. Send one message in it, then start the master run.".into());
            }
            let (workspace_id, root_path) = crate::orchestration::infer_context(
                &svc.workspaces,
                &actor,
                arg(&args, "workspaceId")?,
                arg(&args, "rootPath")?,
            )?;
            let defaults: Option<crate::orchestration::automation::WorkerDefaults> =
                arg(&args, "workerDefaults")?;
            let defaults = defaults.map(|d| d.normalized()).transpose()?;
            let run = svc.orchestrations.create_run_with_mode(
                actor.clone(),
                arg(&args, "objective")?,
                workspace_id,
                root_path,
                arg(&args, "maxConcurrent")?,
                arg::<Option<crate::git_ops::workflow::WorkspaceMode>>(&args, "workspaceMode")?
                    .unwrap_or_default(),
            )?;
            let run = if let Some(defaults) = defaults {
                svc.orchestrations
                    .configure_automation(&actor, &run.id, Some(defaults))?
            } else {
                run
            };
            // Agents mode: a lead's plan always waits for the person.
            let run = if crate::team::lead_for_chat(&crate::team::default_path(), &actor)?.is_some()
            {
                svc.orchestrations.require_plan_approval(&run.id)?
            } else {
                run
            };
            svc.chats.persist_orchestration_context(&actor)?;
            if start_master {
                crate::agent_chat::chat_continue_internal_impl(
                    svc.chats.clone(),
                    actor,
                    crate::orchestration::master_prompt(&run),
                )?;
            }
            // An agent that opened its own run (the MCP hook sets this) gets the
            // master brief back in the answer, since nothing else delivers it.
            if arg::<Option<bool>>(&args, "withBrief")?.unwrap_or(false) && !start_master {
                let brief = crate::orchestration::master_prompt(&run);
                let mut value = serde_json::to_value(&run).map_err(|e| e.to_string())?;
                if let Some(object) = value.as_object_mut() {
                    object.insert("masterBrief".into(), Value::String(brief));
                }
                return Ok(value);
            }
            to_value(Ok(run))
        }
        // Browser-only entry point: a chat need not have a live start context
        // to become a coordinator. Run creation and launch are separate so a
        // provider failure can retry this exact run without duplicating it.
        "orchestration_master_start" => {
            let actor: String = arg(&args, "actorChatKey")?;
            let (_guard, run) = svc
                .orchestrations
                .guard_master_start(&actor, &arg::<String>(&args, "runId")?)?;
            let meta = crate::chat_index::list()
                .into_iter()
                .find(|meta| format!("chat:{}", meta.id) == actor)
                .ok_or("Save the main chat before starting this run.")?;
            if meta.project_id != run.workspace_id || meta.cwd.as_deref() != Some(&run.root_path) {
                return Err(
                    "This chat's workspace changed. Start a new run from its current workspace."
                        .into(),
                );
            }
            let project = crate::workspaces::list_workspaces_impl(&svc.workspaces)?
                .into_iter()
                .find(|project| project.id == run.workspace_id)
                .ok_or("The run's project no longer exists.")?;
            let agent: crate::agent_chat::ChatAgent = arg(&args, "agent")?;
            if agent == crate::agent_chat::ChatAgent::Pi {
                return Err("Choose Codex or Claude as the main agent.".into());
            }
            let handoff: Option<String> = arg(&args, "handoff")?;
            // A provider switch always starts a fresh native session, even if
            // an older index save is still in flight in another browser.
            let resume = if handoff.is_some() {
                None
            } else {
                meta.session_id
            };
            unit(crate::agent_chat::chat_start_master_impl(
                svc.chats.clone(),
                actor,
                run.root_path.clone(),
                agent,
                arg(&args, "model")?,
                arg(&args, "access")?,
                crate::orchestration::master_prompt(&run),
                handoff,
                resume,
                Some(project.paths),
                Some(project.env),
                arg(&args, "effort")?,
                arg(&args, "lite")?,
            ))
        }
        "orchestration_task_create" => {
            let run_id: String = arg(&args, "runId")?;
            let mut worker: Option<crate::orchestration::automation::WorkerSettings> =
                arg(&args, "worker")?;
            // Agents mode: a lead names a registered agent and the host, not
            // the lead, turns it into worker settings.
            let actor: String = arg(&args, "actorChatKey")?;
            let parent: Option<String> = arg(&args, "parentTaskId")?;
            let team_path = crate::team::default_path();
            let (project, coordinator) = svc.orchestrations.run_owner(&run_id)?;
            // Whose direct reports this task may go to: the lead's when the
            // coordinator of an agents-mode run creates it, the manager's when
            // a second-level worker splits its own task.
            let (manager, cross_project, parent_destination) = if actor != coordinator {
                match parent.as_deref() {
                    Some(parent) => {
                        let (assignee, destination) = svc.orchestrations.task_route(parent)?;
                        (assignee.map(|a| a.id), false, destination)
                    }
                    None => (None, false, None),
                }
            } else {
                match crate::team::lead_for_chat(&team_path, &actor)? {
                    Some(lead) => (Some(lead.lead_id), lead.cross_project, None),
                    None => (None, false, None),
                }
            };
            let requested =
                arg::<Option<String>>(&args, "assignee")?.filter(|who| !who.trim().is_empty());
            if manager.is_some() && requested.is_none() {
                return Err(
                    "Assign this task to one of your direct reports with `assignee`.".into(),
                );
            }
            let project_arg: Option<String> = arg(&args, "project")?;
            let repository_arg: Option<String> = arg(&args, "repository")?;
            let routed = crate::orchestration::destination::route(
                &crate::team::list(&team_path, None, true)?,
                &crate::workspaces::list_workspaces_impl(&svc.workspaces)?,
                &crate::orchestration::destination::Route {
                    who: requested.as_deref(),
                    project: project_arg.as_deref(),
                    repository: repository_arg.as_deref(),
                    manager: manager.as_deref(),
                    cross_project,
                    run_project: &project,
                    parent: parent_destination.as_ref(),
                },
            )?;
            let assignee = match routed.assignee {
                Some(agent) => {
                    worker = Some(crate::orchestration::automation::WorkerSettings {
                        agent: agent.agent,
                        access: agent.access,
                        model: Some(agent.model.clone()),
                        effort: agent.effort.clone(),
                        recovery: worker.and_then(|w| w.recovery),
                    });
                    Some(crate::orchestration::TaskAssignee {
                        id: agent.id,
                        name: agent.name,
                    })
                }
                None => None,
            };
            to_value(svc.orchestrations.create_task_for(
                &actor,
                run_id,
                arg(&args, "title")?,
                arg(&args, "spec")?,
                arg(&args, "dependsOn")?,
                parent,
                worker,
                assignee,
                routed.destination,
            ))
        }
        // Where the caller may send work: registered projects, their
        // repositories, and which of its direct reports can work in each.
        // Identity comes from the chat, never from the arguments.
        "orchestration_destinations" => {
            let actor: String = arg(&args, "actorChatKey")?;
            let team_path = crate::team::default_path();
            let manager = match crate::team::lead_for_chat(&team_path, &actor)? {
                Some(lead) => Some(lead.lead_id),
                None => svc
                    .orchestrations
                    .active_task(&actor)?
                    .and_then(|task| task.assignee)
                    .map(|a| a.id),
            };
            Ok(crate::orchestration::destination::directory(
                &crate::team::list(&team_path, None, true)?,
                &crate::workspaces::list_workspaces_impl(&svc.workspaces)?,
                manager.as_deref(),
            ))
        }
        // Browser-only: the person approves an agents-mode lead's plan. Not in
        // the agent hook's whitelist, so no agent can approve its own plan.
        "orchestration_plan_approve" => to_value(svc.orchestrations.approve_plan(
            &arg::<String>(&args, "actorChatKey")?,
            &arg::<String>(&args, "runId")?,
            arg::<Option<Vec<String>>>(&args, "taskIds")?.as_deref(),
        )),
        "team_leads" => to_value(crate::team::leads(&crate::team::default_path())),
        "team_brief" => {
            let chat_key: String = arg(&args, "chatKey")?;
            if !chat_key.starts_with("chat:") || chat_key.starts_with("chat:orch-") {
                return Err("A task can only be handed out from a main chat.".into());
            }
            let projects: Vec<(String, String)> =
                crate::workspaces::list_workspaces_impl(&svc.workspaces)?
                    .into_iter()
                    .map(|p| (p.id, p.name))
                    .collect();
            to_value(crate::team::brief(
                &crate::team::default_path(),
                &chat_key,
                &arg::<String>(&args, "projectId")?,
                &arg::<String>(&args, "leadId")?,
                &arg::<String>(&args, "task")?,
                arg::<Option<bool>>(&args, "crossProject")?.unwrap_or(false),
                &projects,
            ))
        }
        // The lead the person talks to across projects. Browser-only, like the
        // rest of the team store.
        "team_head" => to_value(crate::team::head(&crate::team::default_path())),
        "team_head_set" => to_value(crate::team::set_head(
            &crate::team::default_path(),
            arg::<Option<String>>(&args, "id")?.as_deref(),
        )),
        "team_list" => {
            let project: Option<String> = arg(&args, "projectId")?;
            let all = arg::<Option<bool>>(&args, "all")?.unwrap_or(false);
            to_value(crate::team::list(
                &crate::team::default_path(),
                project.as_deref(),
                all,
            ))
        }
        "team_save" => {
            let saved = crate::team::save(&crate::team::default_path(), arg(&args, "agent")?)?;
            // Its memory note, when a writable vault is connected. The agent
            // is saved either way; the note is also made on first use.
            let memory = crate::team::ensure_memory(
                &crate::memory_vault::Vault::profile(),
                "octiq:team",
                &saved,
            )
            .err();
            let mut value = serde_json::to_value(&saved).map_err(|e| e.to_string())?;
            if let (Some(error), Some(object)) = (memory, value.as_object_mut()) {
                object.insert("memoryError".into(), Value::String(error));
            }
            Ok(value)
        }
        "team_delete" => unit(crate::team::delete(
            &crate::team::default_path(),
            &arg::<String>(&args, "id")?,
        )),

        "orchestration_worker_start" => {
            let actor: String = arg(&args, "actorChatKey")?;
            let launch = crate::orchestration::WorkerLaunch {
                task_id: arg(&args, "taskId")?,
                agent: arg(&args, "agent")?,
                model: arg(&args, "model")?,
                effort: arg(&args, "effort")?,
                access: arg(&args, "access")?,
                new_worktree: arg(&args, "newWorktree")?,
                base_branch: arg::<Option<String>>(&args, "baseBranch")?.unwrap_or_default(),
            };
            to_value(svc.orchestrations.start_worker(
                svc.chats.clone(),
                &svc.workspaces,
                &actor,
                launch,
            ))
        }
        "orchestration_automation_configure" => to_value(svc.orchestrations.configure_automation(
            &arg::<String>(&args, "actorChatKey")?,
            &arg::<String>(&args, "runId")?,
            arg(&args, "workerDefaults")?,
        )),
        "orchestration_dispatch_ready" => to_value(svc.orchestrations.dispatch_ready(
            svc.chats.clone(),
            &svc.workspaces,
            &arg::<String>(&args, "actorChatKey")?,
            &arg::<String>(&args, "runId")?,
        )),
        "orchestration_validation_create" => to_value(svc.orchestrations.create_validation(
            &arg::<String>(&args, "actorChatKey")?,
            &arg::<String>(&args, "taskId")?,
            &arg::<String>(&args, "baseSha")?,
            arg::<Option<Vec<String>>>(&args, "commits")?.unwrap_or_default(),
        )),
        "orchestration_validation_remove" => to_value(svc.orchestrations.remove_validation(
            &arg::<String>(&args, "actorChatKey")?,
            &arg::<String>(&args, "taskId")?,
            &arg::<String>(&args, "path")?,
        )),
        "orchestration_workspace_refresh" => to_value(svc.orchestrations.refresh_workspace(
            &arg::<String>(&args, "actorChatKey")?,
            &arg::<String>(&args, "taskId")?,
        )),
        "orchestration_task_reopen" => to_value(svc.orchestrations.reopen_task(
            &arg::<String>(&args, "actorChatKey")?,
            &arg::<String>(&args, "taskId")?,
            arg(&args, "spec")?,
        )),
        "orchestration_worker_archive" => to_value(svc.orchestrations.set_worker_archived(
            &svc.chats,
            &arg::<String>(&args, "actorChatKey")?,
            &arg::<String>(&args, "attemptId")?,
            arg(&args, "archived")?,
        )),
        "orchestration_workers_archive_merged" => {
            to_value(svc.orchestrations.archive_merged_workers(
                &svc.chats,
                &arg::<String>(&args, "actorChatKey")?,
                &arg::<String>(&args, "runId")?,
            ))
        }
        "orchestration_workspace_cleanup" => to_value(svc.orchestrations.cleanup_workspace(
            &svc.chats,
            &arg::<String>(&args, "actorChatKey")?,
            &arg::<String>(&args, "taskId")?,
            arg::<Option<bool>>(&args, "abandon")?.unwrap_or(false),
            &arg::<String>(&args, "expectedHead")?,
        )),
        "orchestration_worker_report" => {
            let actor: String = arg(&args, "actorChatKey")?;
            let task = svc.orchestrations.report_worker(
                &actor,
                crate::orchestration::WorkerReport {
                    attempt_id: arg(&args, "attemptId")?,
                    outcome: arg(&args, "outcome")?,
                    summary: arg(&args, "summary")?,
                    files_modified: arg(&args, "filesModified")?,
                },
            )?;
            to_value(Ok(task))
        }
        "orchestration_gate_create" => {
            let gate = svc.orchestrations.create_gate(
                &arg::<String>(&args, "actorChatKey")?,
                arg(&args, "runId")?,
                arg(&args, "taskId")?,
                arg(&args, "question")?,
                arg(&args, "options")?,
            )?;
            to_value(Ok(gate))
        }
        "orchestration_gate_resolve" => {
            let actor: String = arg(&args, "actorChatKey")?;
            let resolution: String = arg(&args, "resolution")?;
            let resume_target = arg::<Option<bool>>(&args, "resumeTarget")?.unwrap_or(false);
            let gate = svc.orchestrations.resolve_gate_and_resume(
                &actor,
                arg(&args, "gateId")?,
                resolution,
                resume_target,
            )?;
            to_value(Ok(gate))
        }
        "orchestration_message_send" => {
            let actor: String = arg(&args, "actorChatKey")?;
            let message = svc.orchestrations.record_message(
                &actor,
                arg(&args, "runId")?,
                arg(&args, "to")?,
                arg(&args, "kind")?,
                arg(&args, "subject")?,
                arg(&args, "body")?,
            )?;
            to_value(Ok(message))
        }
        "orchestration_run_stop" => {
            let actor: String = arg(&args, "actorChatKey")?;
            let workers =
                svc.orchestrations
                    .stop_run(&actor, arg(&args, "runId")?, arg(&args, "reason")?)?;
            for worker in workers {
                let _ = crate::agent_chat::chat_stop_impl(&svc.chats, worker);
            }
            Ok(Value::Null)
        }

        // ---- git ----------------------------------------------------------
        cmd if cmd.starts_with("pr_") => pull_requests::dispatch(svc, cmd, args),
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
        "git_prepare_chat_workspace" => to_value(crate::git_ops::git_prepare_chat_workspace(
            arg(&args, "path")?,
            arg(&args, "branch")?,
            arg(&args, "newWorktree")?,
            arg(&args, "prompt")?,
            arg(&args, "chatId")?,
        )),

        // ---- finding files ------------------------------------------------
        "search_files" => to_value(crate::fsbrowse::search_files(
            arg(&args, "roots")?,
            arg(&args, "query")?,
        )),
        "list_project_files" => to_value(crate::fsbrowse::list_project_files(arg(&args, "roots")?)),

        // ---- usage --------------------------------------------------------
        "usage_summary" => Ok(json!(crate::usage_limits::usage_summary())),

        // What this app is holding in RAM, and which chat or terminal is
        // holding it. Read-only, and cached for a few seconds so several open
        // browser tabs polling it share one `ps` sweep between them.
        "memory_usage" => Ok(json!(crate::memory::memory_usage(&svc.ptys, &svc.chats))),

        // ---- agents -------------------------------------------------------
        // Which agent CLIs this machine actually has. The browser needs it for
        // the same reason the desktop menu does: offering an agent that is not
        // installed only produces a chat that dies on its first line.
        "agent_installs" => Ok(json!(crate::agents::agent_installs(arg(&args, "refresh")?))),
        // Provider-owned model catalogs. Codex answers through app-server;
        // Claude uses its Models API when an API key is available and an
        // explicit versioned fallback for subscription OAuth.
        "agent_models" => to_value(crate::agents::agent_models(arg(&args, "agent")?)),
        // Codex's own cwd-aware catalog, loaded lazily when its composer opens
        // the slash menu. `codex exec --json` has no startup catalog event.
        "codex_skills" => to_value(crate::agents::codex_skills(arg(&args, "cwd")?)),

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
        assert_eq!(rows.len(), crate::agent_provider::AgentKind::ALL.len());
        // Every agent is named, installed or not — that IS the answer the page
        // renders, so a missing agent must not be a missing row.
        assert_eq!(rows[0]["id"], "claude");
        assert_eq!(rows[0]["installed"], false);
        assert_eq!(rows[1]["id"], "codex");
        assert_eq!(rows[1]["installed"], true);
        assert_eq!(rows[1]["path"], "/opt/bin/codex");
    }

    #[test]
    fn a_browser_can_ask_for_codex_skills_by_workspace() {
        let svc = Services::load();
        let err = dispatch(&svc, "codex_skills", json!({ "cwd": "relative" })).unwrap_err();
        assert!(
            err.contains("absolute directory"),
            "route reached loader: {err}"
        );
    }

    #[test]
    fn a_browser_can_ask_for_versioned_claude_models() {
        let svc = Services::load();
        let out = dispatch(&svc, "agent_models", json!({ "agent": "claude" })).expect("routed");
        let rows = out["models"].as_array().expect("a model catalog");
        assert!(
            rows.iter().any(|model| model["model"] == "claude-opus-4-6"),
            "the pinned model that motivated discovery is selectable"
        );
    }

    #[test]
    fn a_browser_can_set_a_project_color() {
        let svc = Services::load();
        let err = dispatch(
            &svc,
            "set_workspace_color",
            json!({ "id": "not-a-workspace", "color": "#12ab34" }),
        )
        .expect_err("the route should reach the store even when the id is unknown");
        assert_eq!(err, "workspace not found");
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
