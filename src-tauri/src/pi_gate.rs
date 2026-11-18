//! The host's answer to every tool call a Pi launch makes.
//!
//! Pi has no permission modes and no approval protocol of its own. OctiqFlow's
//! Pi extension (`scripts/mcp/octiq-pi.ts`) sends each call here, from its
//! `tool_call` handler, before the tool runs; this module decides from the
//! level the chat runs at, asks the person on the ordinary approval card where
//! Claude would ask, and answers allow or deny. The extension blocks the call
//! unless the answer is allow, and blocks it too when no answer comes at all:
//! the gate fails closed. The decision is a pure function (`decide`), so the
//! levels are tested here without a process.
//!
//! What each level lets through (`access_prompt` in `agent_provider.rs` says
//! the same to the model):
//!
//! | level | read tools in the project | edit / write in the project | shell, anything else |
//! | --- | --- | --- | --- |
//! | Read | yes | refused | refused (OctiqFlow's own tools ask) |
//! | Manual | yes | asks | asks |
//! | Edits | yes | yes | asks |
//! | Auto | as Edits: Pi has no automatic safety review, so nothing is judged safe for the person | | |
//! | Full | yes | yes | yes |
//!
//! "Reads in the project" and "edits in the project" mean a path inside the
//! chat's working directory or one of its extra folders, resolved through
//! symlinks; a path outside asks, at every level but Full. OctiqFlow's own
//! bookkeeping tools (`permission::HOST_BOOKKEEPING`) run at every level, as
//! they do for Claude. A tool the server declared read-only (`readOnlyHint`)
//! runs without asking at the guarded levels. A front desk may call
//! `route_chat` and nothing else.

use std::path::{Path, PathBuf};

use serde::Deserialize;
use serde_json::{json, Value};

use crate::agent_provider::{Access, AgentKind};

/// One tool call, as the extension reports it. Only the capability proves who
/// is calling; the names in the body are claims the hook checks against it.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Call {
    #[serde(default)]
    pub chat_key: Option<String>,
    #[serde(default)]
    pub session_key: Option<String>,
    #[serde(default)]
    pub launch_id: Option<String>,
    pub tool_name: String,
    #[serde(default)]
    pub tool_input: Value,
    #[serde(default)]
    pub tool_use_id: Option<String>,
    /// Pi's working directory for this call.
    #[serde(default)]
    pub cwd: Option<String>,
    /// What the tool's own server declared (MCP annotations); unverified.
    #[serde(default)]
    pub read_only_hint: Option<bool>,
    /// Whether the extension itself registered this tool from OctiqFlow's own
    /// MCP server. The name alone proves nothing: a person's or a project's
    /// `mcp.json` can define a server called `octiq`, so a `mcp__octiq__*` tool
    /// gets the host's trust only when this is true. Absent means no.
    #[serde(default)]
    pub host_server: bool,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Verdict {
    Allow,
    Deny(String),
    /// Put a card in front of the person.
    Ask,
}

/// What the extension is told. `decision` is `allow` or `deny`.
pub struct Answer {
    pub decision: &'static str,
    pub reason: String,
}

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
enum Kind {
    /// `read`, `grep`, `find`, `ls`.
    Read,
    /// `edit`, `write`.
    Edit,
    /// `bash`, `powershell`.
    Shell,
    /// An OctiqFlow tool that is host bookkeeping.
    Bookkeeping,
    /// Any other `mcp__octiq__` tool: it has its own gates in the host.
    HostTool,
    /// Everything else: another MCP server's tool, a person's own extension's.
    Other,
    /// Named like one of OctiqFlow's tools (`mcp__octiq__*`) but not registered
    /// by the host's own extension: a configured server that took the name. It
    /// has none of the host's trust, whatever it says of itself.
    Impostor,
}

fn kind_of(tool: &str, host_server: bool) -> Kind {
    if tool.starts_with("mcp__octiq__") && !host_server {
        return Kind::Impostor;
    }
    match tool {
        "read" | "grep" | "find" | "ls" => Kind::Read,
        "edit" | "write" => Kind::Edit,
        "bash" | "powershell" => Kind::Shell,
        // Pi's MCP resource tools only read.
        "list_mcp_resources" | "list_mcp_resource_templates" | "read_mcp_resource" => Kind::Read,
        _ if crate::permission::host_bookkeeping(tool) => Kind::Bookkeeping,
        _ if tool.starts_with("mcp__octiq__") => Kind::HostTool,
        _ => Kind::Other,
    }
}

/// The path a file tool names, when it names one.
fn path_arg(input: &Value) -> Option<&str> {
    ["path", "file_path", "filePath"]
        .iter()
        .find_map(|key| input.get(key).and_then(Value::as_str))
        .filter(|path| !path.is_empty())
}

/// Whether the path a call names lies in one of the project's folders, with
/// symlinks resolved first. A call that names no path works in the working
/// directory. `~` is the home folder, as Pi reads it.
pub(crate) fn inside(raw: Option<&str>, cwd: &Path, roots: &[PathBuf]) -> bool {
    let Some(raw) = raw else { return true };
    let expanded = match raw.strip_prefix('~') {
        Some(rest) if rest.is_empty() || rest.starts_with(['/', '\\']) => {
            match crate::paths::home_dir() {
                Some(home) => home.join(rest.trim_start_matches(['/', '\\'])),
                None => return false,
            }
        }
        _ => PathBuf::from(raw),
    };
    let absolute = if expanded.is_absolute() {
        expanded
    } else {
        cwd.join(expanded)
    };
    match crate::paths::canonical_target(&absolute) {
        Some(target) => crate::paths::is_within(&target, roots),
        None => false,
    }
}

/// The canonical form of the folders a chat works in.
pub(crate) fn canonical_roots(folders: &[String]) -> Vec<PathBuf> {
    use crate::paths::Canonical;
    folders
        .iter()
        .filter(|folder| !folder.trim().is_empty())
        .filter_map(|folder| Path::new(folder).canonical().ok())
        .collect()
}

/// The decision, from the level alone. `roots` are canonical.
pub fn decide(
    access: Access,
    front_desk: bool,
    roots: &[PathBuf],
    cwd: &Path,
    call: &Call,
) -> Verdict {
    let tool = call.tool_name.as_str();
    if front_desk {
        return if tool == "mcp__octiq__route_chat" && call.host_server {
            Verdict::Allow
        } else {
            Verdict::Deny(
                "This is a front-desk chat: it only routes the person with route_chat, and every other tool is refused.".into(),
            )
        };
    }
    let kind = kind_of(tool, call.host_server);
    if kind == Kind::Bookkeeping || access == Access::Full {
        return Verdict::Allow;
    }
    let in_project = |what: Option<&str>| inside(what, cwd, roots);
    match kind {
        Kind::Bookkeeping => Verdict::Allow,
        Kind::Read => {
            // A resource tool names a server and a uri, never a path.
            if in_project(path_arg(&call.tool_input)) {
                Verdict::Allow
            } else {
                Verdict::Ask
            }
        }
        Kind::Edit => match access {
            Access::Edits | Access::Auto if in_project(path_arg(&call.tool_input)) => {
                Verdict::Allow
            }
            Access::Read => refused(access, tool),
            _ => Verdict::Ask,
        },
        Kind::Shell => match access {
            Access::Read => refused(access, tool),
            _ => Verdict::Ask,
        },
        // OctiqFlow's own tools beyond bookkeeping (starting a run, writing
        // the vault, publishing) have their own cards and gates; they ask at
        // every guarded level, as they do for Claude.
        Kind::HostTool => Verdict::Ask,
        // Not the host's, so not read-only on its own say-so either: refused
        // where the chat can only read, asked everywhere else short of Full.
        Kind::Impostor => match access {
            Access::Read => Verdict::Deny(format!(
                "{tool} is not OctiqFlow's tool: a configured MCP server took that name, so it is not trusted. Nothing runs under it at Read-only access."
            )),
            _ => Verdict::Ask,
        },
        Kind::Other => {
            if call.read_only_hint == Some(true) {
                Verdict::Allow
            } else if access == Access::Read {
                refused(access, tool)
            } else {
                Verdict::Ask
            }
        }
    }
}

fn refused(access: Access, tool: &str) -> Verdict {
    Verdict::Deny(format!(
        "{tool} is not allowed at {} access: this chat can only read. If the task needs it, ask for more access with request_access (a worker records the need with orchestration_gate_create) and end the turn.",
        match access {
            Access::Read => "Read-only",
            _ => "this",
        }
    ))
}

/// The card's tool name and arguments in the shapes the page draws best
/// (`Bash` with its command, `Write`/`MultiEdit` as a diff): Pi's own names
/// and argument spellings differ from Claude's.
pub(crate) fn card(tool: &str, input: &Value) -> (String, Value) {
    let path = path_arg(input).map(str::to_owned);
    match tool {
        "bash" | "powershell" => ("Bash".into(), input.clone()),
        "write" => (
            "Write".into(),
            json!({ "file_path": path, "content": input.get("content").cloned().unwrap_or(Value::Null) }),
        ),
        "edit" => {
            let edits: Vec<Value> = input
                .get("edits")
                .and_then(Value::as_array)
                .map(|edits| {
                    edits
                        .iter()
                        .map(|edit| {
                            json!({
                                "old_string": edit.get("oldText").cloned().unwrap_or(Value::Null),
                                "new_string": edit.get("newText").cloned().unwrap_or(Value::Null),
                            })
                        })
                        .collect()
                })
                .unwrap_or_default();
            (
                "MultiEdit".into(),
                json!({ "file_path": path, "edits": edits }),
            )
        }
        "read" => ("Read".into(), {
            let mut shown = input.clone();
            if let (Some(path), Some(object)) = (path, shown.as_object_mut()) {
                object.insert("file_path".into(), Value::String(path));
            }
            shown
        }),
        "grep" => ("Grep".into(), input.clone()),
        "find" => ("Glob".into(), input.clone()),
        "ls" => ("LS".into(), input.clone()),
        _ => (tool.to_owned(), input.clone()),
    }
}

/// Decide, and when the answer is a card, wait for the person.
pub async fn gate(
    chats: &crate::agent_chat::ChatManager,
    front_desk: bool,
    chat_key: &str,
    session_key: &str,
    call: Call,
) -> Answer {
    // The level the chat runs at NOW, as the host holds it. A chat the host
    // has no record of is the most cautious level, never the most permissive.
    let access = crate::agent_chat::access_now(chat_key).unwrap_or(Access::Read);
    let folders = chats.launch_folders(session_key);
    let cwd = folders
        .first()
        .map(PathBuf::from)
        .or_else(|| call.cwd.as_deref().map(PathBuf::from))
        .unwrap_or_default();
    let roots = canonical_roots(&folders);
    let verdict = decide(access, front_desk, &roots, &cwd, &call);
    // Where this call stands in the turn, taken before anything is awaited.
    let turn = chats.pi_call_begin(
        session_key,
        call.launch_id.as_deref(),
        matches!(verdict, Verdict::Ask),
    );
    // A request dropped while it waits (the extension went away, the server
    // stopped listening) is an unanswered call: it refuses.
    let mut open = OpenCall {
        chats,
        session_key,
        turn,
    };
    let answer = answer_for(chats, verdict, chat_key, access, &call).await;
    open.finish(answer.decision != "allow");
    answer
}

struct OpenCall<'a> {
    chats: &'a crate::agent_chat::ChatManager,
    session_key: &'a str,
    turn: Option<crate::agent_chat::PiCallTurn>,
}

impl OpenCall<'_> {
    fn finish(&mut self, refused: bool) {
        if let Some(turn) = self.turn.take() {
            self.chats.pi_call_end(self.session_key, &turn, refused);
        }
    }
}

impl Drop for OpenCall<'_> {
    fn drop(&mut self) {
        self.finish(true);
    }
}

async fn answer_for(
    chats: &crate::agent_chat::ChatManager,
    verdict: Verdict,
    chat_key: &str,
    access: Access,
    call: &Call,
) -> Answer {
    match verdict {
        Verdict::Allow => Answer {
            decision: "allow",
            reason: String::new(),
        },
        Verdict::Deny(reason) => Answer {
            decision: "deny",
            reason,
        },
        Verdict::Ask => {
            // The worker's card is the coordinator's to see; until it is
            // answered the worker is parked on it, not stalled.
            chats.note_waiting_for_approval(chat_key);
            let (tool_name, tool_input) = card(&call.tool_name, &call.tool_input);
            let answer = crate::permission::ask(crate::permission::Request {
                provider: Some(AgentKind::Pi),
                chat_key: Some(chat_key.to_string()),
                tool_name: Some(tool_name),
                tool_input: Some(tool_input),
                tool_use_id: call.tool_use_id.clone(),
                cwd: call.cwd.clone(),
                access: Some(access.as_env().to_string()),
                ..Default::default()
            })
            .await;
            match answer.decision {
                "allow" => Answer {
                    decision: "allow",
                    reason: String::new(),
                },
                "deny" => Answer {
                    decision: "deny",
                    reason: if answer.reason.is_empty() {
                        "The person did not allow this call.".into()
                    } else {
                        answer.reason
                    },
                },
                // Nobody was watching: Claude's headless chain refuses too.
                _ => Answer {
                    decision: "deny",
                    reason: format!(
                        "This call needs the person's approval and nobody was watching OctiqFlow to give it ({}). It did not run.",
                        answer.reason
                    ),
                },
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_dir::TestDir;

    fn call(tool: &str, input: Value) -> Call {
        Call {
            chat_key: None,
            session_key: None,
            launch_id: None,
            tool_name: tool.into(),
            tool_input: input,
            tool_use_id: None,
            cwd: None,
            read_only_hint: None,
            // OctiqFlow's own tools come from the host's server unless a test
            // says otherwise (`impostor`).
            host_server: tool.starts_with("mcp__octiq__"),
        }
    }

    /// A tool named like OctiqFlow's, from a server the person or the project
    /// configured as `octiq`: the extension does not attest it.
    fn impostor(tool: &str) -> Call {
        Call {
            host_server: false,
            read_only_hint: Some(true),
            ..call(tool, json!({}))
        }
    }

    struct Project {
        _dir: TestDir,
        cwd: PathBuf,
        roots: Vec<PathBuf>,
    }

    fn project() -> Project {
        let dir = TestDir::new("pi-gate");
        let cwd = dir.join("project");
        std::fs::create_dir_all(&cwd).unwrap();
        let roots = canonical_roots(&[cwd.to_string_lossy().into()]);
        Project {
            cwd: roots[0].clone(),
            roots,
            _dir: dir,
        }
    }

    fn decide_at(project: &Project, access: Access, call: &Call) -> Verdict {
        decide(access, false, &project.roots, &project.cwd, call)
    }

    fn within(project: &Project, name: &str) -> String {
        project.cwd.join(name).to_string_lossy().into()
    }

    #[test]
    fn full_allows_everything_and_read_allows_only_reads() {
        let p = project();
        for tool in [
            "bash",
            "write",
            "edit",
            "mcp__server__tool",
            "mcp__octiq__orchestration_run_create",
        ] {
            let c = call(tool, json!({ "path": within(&p, "a"), "command": "ls" }));
            assert_eq!(decide_at(&p, Access::Full, &c), Verdict::Allow, "{tool}");
        }
        let read = call("read", json!({ "path": within(&p, "a.txt") }));
        assert_eq!(decide_at(&p, Access::Read, &read), Verdict::Allow);
        for tool in ["bash", "powershell", "write", "edit", "mcp__server__tool"] {
            let c = call(tool, json!({ "path": within(&p, "a"), "command": "ls" }));
            assert!(
                matches!(decide_at(&p, Access::Read, &c), Verdict::Deny(_)),
                "{tool} must be refused at Read"
            );
        }
    }

    #[test]
    fn manual_asks_for_every_change_and_edits_allows_only_project_files() {
        let p = project();
        let write = call(
            "write",
            json!({ "path": within(&p, "a.rs"), "content": "x" }),
        );
        assert_eq!(decide_at(&p, Access::Manual, &write), Verdict::Ask);
        assert_eq!(decide_at(&p, Access::Edits, &write), Verdict::Allow);
        // Pi has no automatic safety review: Auto is Accept edits, never wider.
        assert_eq!(decide_at(&p, Access::Auto, &write), Verdict::Allow);
        let outside = call("write", json!({ "path": "/etc/hosts-not", "content": "x" }));
        for access in [Access::Manual, Access::Edits, Access::Auto] {
            assert_eq!(decide_at(&p, access, &outside), Verdict::Ask, "{access:?}");
        }
        let bash = call("bash", json!({ "command": "cargo test" }));
        for access in [Access::Manual, Access::Edits, Access::Auto] {
            assert_eq!(decide_at(&p, access, &bash), Verdict::Ask, "{access:?}");
        }
    }

    #[test]
    fn a_relative_path_and_dot_dot_are_resolved_before_judging() {
        let p = project();
        let relative = call("write", json!({ "path": "src/new.rs", "content": "x" }));
        assert_eq!(decide_at(&p, Access::Edits, &relative), Verdict::Allow);
        let escape = call(
            "write",
            json!({ "path": "../elsewhere.rs", "content": "x" }),
        );
        assert_eq!(decide_at(&p, Access::Edits, &escape), Verdict::Ask);
        let escape = call("edit", json!({ "path": "src/../../x", "edits": [] }));
        assert_eq!(decide_at(&p, Access::Edits, &escape), Verdict::Ask);
    }

    #[cfg(unix)]
    #[test]
    fn a_symlink_out_of_the_project_is_judged_by_where_it_leads() {
        let p = project();
        let outside = TestDir::new("pi-gate-outside");
        std::os::unix::fs::symlink(&*outside, p.cwd.join("link")).unwrap();
        let via = call(
            "write",
            json!({ "path": within(&p, "link/x.txt"), "content": "x" }),
        );
        assert_eq!(decide_at(&p, Access::Edits, &via), Verdict::Ask);
        let read = call("read", json!({ "path": within(&p, "link/x.txt") }));
        assert_eq!(decide_at(&p, Access::Read, &read), Verdict::Ask);
    }

    #[test]
    fn a_read_outside_the_project_asks_even_at_read_only() {
        let p = project();
        for tool in ["read", "grep", "find", "ls"] {
            let c = call(tool, json!({ "path": "/etc" }));
            for access in [Access::Read, Access::Manual, Access::Edits, Access::Auto] {
                assert_eq!(
                    decide_at(&p, access, &c),
                    Verdict::Ask,
                    "{tool} at {access:?}"
                );
            }
            // No path: the working directory.
            assert_eq!(
                decide_at(&p, Access::Read, &call(tool, json!({ "pattern": "x" }))),
                Verdict::Allow
            );
        }
    }

    #[test]
    fn host_bookkeeping_runs_at_every_level_and_other_host_tools_ask() {
        let p = project();
        for access in Access::ALL_FOR_TESTS {
            let c = call("mcp__octiq__task_status", json!({}));
            assert_eq!(decide_at(&p, access, &c), Verdict::Allow, "{access:?}");
        }
        for access in [Access::Read, Access::Manual, Access::Edits, Access::Auto] {
            let c = call("mcp__octiq__orchestration_run_create", json!({}));
            assert_eq!(decide_at(&p, access, &c), Verdict::Ask, "{access:?}");
        }
    }

    #[test]
    fn a_server_that_took_the_name_octiq_gets_none_of_the_hosts_trust() {
        let p = project();
        // Bookkeeping runs at every level for the host's own tool; for a
        // tool the extension did not register it is judged like a stranger,
        // and its own claim to be read-only counts for nothing.
        for tool in [
            "mcp__octiq__task_status",
            "mcp__octiq__orchestration_worker_report",
            "mcp__octiq__ask_user",
            "mcp__octiq__anything",
        ] {
            let c = impostor(tool);
            assert!(
                matches!(decide_at(&p, Access::Read, &c), Verdict::Deny(_)),
                "{tool} at Read"
            );
            for access in [Access::Manual, Access::Edits, Access::Auto] {
                assert_eq!(
                    decide_at(&p, access, &c),
                    Verdict::Ask,
                    "{tool} at {access:?}"
                );
            }
            // Full is unguarded for every tool, as it always was.
            assert_eq!(decide_at(&p, Access::Full, &c), Verdict::Allow);
        }
        // A front desk routes only through the host's own route_chat.
        let fake_route = impostor("mcp__octiq__route_chat");
        for access in Access::ALL_FOR_TESTS {
            assert!(
                matches!(
                    decide(access, true, &p.roots, &p.cwd, &fake_route),
                    Verdict::Deny(_)
                ),
                "{access:?}"
            );
        }
        // The extension that sent nothing (an older one) is not trusted either.
        let body: Call =
            serde_json::from_value(json!({ "toolName": "mcp__octiq__task_status" })).unwrap();
        assert!(!body.host_server);
        assert!(matches!(
            decide_at(&p, Access::Read, &body),
            Verdict::Deny(_)
        ));
        // And `hostServer: true` is read from the request body.
        let body: Call = serde_json::from_value(
            json!({ "toolName": "mcp__octiq__task_status", "hostServer": true }),
        )
        .unwrap();
        assert_eq!(decide_at(&p, Access::Read, &body), Verdict::Allow);
    }

    #[test]
    fn another_servers_tool_runs_only_when_it_says_it_reads() {
        let p = project();
        let mut hinted = call("mcp__docs__search", json!({}));
        hinted.read_only_hint = Some(true);
        for access in [Access::Read, Access::Manual, Access::Edits, Access::Auto] {
            assert_eq!(decide_at(&p, access, &hinted), Verdict::Allow, "{access:?}");
            let plain = call("mcp__docs__search", json!({}));
            assert_ne!(decide_at(&p, access, &plain), Verdict::Allow, "{access:?}");
        }
        hinted.read_only_hint = Some(false);
        assert!(matches!(
            decide_at(&p, Access::Read, &hinted),
            Verdict::Deny(_)
        ));
    }

    #[test]
    fn a_front_desk_may_route_and_nothing_else_at_any_level() {
        let p = project();
        for access in Access::ALL_FOR_TESTS {
            let route = call("mcp__octiq__route_chat", json!({}));
            assert_eq!(
                decide(access, true, &p.roots, &p.cwd, &route),
                Verdict::Allow
            );
            for tool in [
                "read",
                "bash",
                "mcp__octiq__task_status",
                "mcp__octiq__ask_user",
            ] {
                assert!(
                    matches!(
                        decide(access, true, &p.roots, &p.cwd, &call(tool, json!({}))),
                        Verdict::Deny(_)
                    ),
                    "{tool} at {access:?}"
                );
            }
        }
    }

    #[test]
    fn no_roots_means_nothing_is_inside_and_a_missing_chat_is_read_only() {
        let cwd = PathBuf::from("/definitely/not/here");
        let c = call(
            "write",
            json!({ "path": "/definitely/not/here/x", "content": "x" }),
        );
        assert_eq!(decide(Access::Edits, false, &[], &cwd, &c), Verdict::Ask);
        assert!(crate::agent_chat::access_now("chat:never-started").is_none());
    }

    #[test]
    fn the_card_uses_the_names_and_shapes_the_page_draws() {
        let (tool, input) = card("bash", &json!({ "command": "ls -la" }));
        assert_eq!(
            (tool.as_str(), input["command"].as_str()),
            ("Bash", Some("ls -la"))
        );
        let (tool, input) = card(
            "write",
            &json!({ "path": "/p/a.rs", "content": "fn main(){}" }),
        );
        assert_eq!(tool, "Write");
        assert_eq!(input["file_path"], "/p/a.rs");
        let (tool, input) = card(
            "edit",
            &json!({ "path": "/p/a.rs", "edits": [{ "oldText": "a", "newText": "b" }] }),
        );
        assert_eq!(tool, "MultiEdit");
        assert_eq!(input["edits"][0]["old_string"], "a");
        assert_eq!(input["edits"][0]["new_string"], "b");
        // The "Always" grant for a shell command is keyed by the lower-cased tool.
        let (tool, _) = card("powershell", &json!({ "command": "dir" }));
        assert_eq!(tool, "Bash");
        let (tool, _) = card("mcp__x__y", &json!({ "a": 1 }));
        assert_eq!(tool, "mcp__x__y");
    }
}
