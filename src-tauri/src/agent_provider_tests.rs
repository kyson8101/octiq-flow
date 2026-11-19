thread_local! {
    /// Makes Codex the one-process-per-turn, command-line provider on this
    /// thread only, so a test of that path needs no process-wide variable.
    pub(crate) static FORCE_EXEC: std::cell::Cell<bool> = const { std::cell::Cell::new(false) };
}

/// Codex as a command-line agent for the life of the guard, on this thread.
pub(crate) struct CommandLineCodex;

impl CommandLineCodex {
    pub(crate) fn on() -> Self {
        FORCE_EXEC.with(|f| f.set(true));
        Self
    }
}

impl Drop for CommandLineCodex {
    fn drop(&mut self) {
        FORCE_EXEC.with(|f| f.set(false));
    }
}

use super::*;

#[test]
fn installed_mcp_starts_and_exposes_front_desk_tool() {
    use std::io::Write;
    let config = ask_mcp_config().expect("MCP bundle is installed in the test home");
    let mut child = std::process::Command::new("node")
        .arg(config.with_file_name("octiq-ask.cjs"))
        .env("OCTIQ_FRONT_DESK", "1")
        .env("OCTIQ_CHAT_KEY", "chat:bundle-test")
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .spawn()
        .expect("node starts the installed MCP, outside the source folder");
    child
        .stdin
        .take()
        .unwrap()
        .write_all(b"{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"tools/list\",\"params\":{}}\n")
        .unwrap();
    let output = child.wait_with_output().unwrap();
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    let reply: Value = serde_json::from_slice(&output.stdout).expect("MCP discovery reply");
    let tools = reply["result"]["tools"].as_array().unwrap();
    assert_eq!(tools.len(), 1);
    assert_eq!(tools[0]["name"], "route_chat");
}

/// Real `agy` 1.2.16 streams, captured on 2026-10-03 on this project's
/// Mac with the flags `AntigravityProvider::build_command` uses (no
/// OctiqFlow plugin). Recorded verbatim; re-record rather than edit.
/// Three turns in one process: a file read, a shell command accept-edits
/// refuses (the turn ends, `denied_actions`), then a recall.
pub(crate) const AGY_THREE_TURNS: &str =
    include_str!("../../web/src/lib/__fixtures__/antigravity-three-turns.jsonl");
/// `--mode plan`: even a read-only shell command is refused, as an ERROR step.
pub(crate) const AGY_PLAN_REFUSED: &str =
    include_str!("../../web/src/lib/__fixtures__/antigravity-plan-refused.jsonl");
/// An unknown `--model`: one failed `result` and exit 1, before any turn.
pub(crate) const AGY_BAD_MODEL: &str =
    include_str!("../../web/src/lib/__fixtures__/antigravity-bad-model.jsonl");
/// SIGINT mid-turn: a failed `result` saying `interrupted`, then exit 1.
pub(crate) const AGY_INTERRUPTED: &str =
    include_str!("../../web/src/lib/__fixtures__/antigravity-interrupted.jsonl");

pub(crate) fn agy_events(stream: &str) -> Vec<Value> {
    stream
        .lines()
        .map(|line| serde_json::from_str(line).expect("a captured line is JSON"))
        .collect()
}

/// The plainest launch of `prompt`: no model, access, effort, MCP config or
/// worker role. A test names only what it is about, after `..request(..)`.
fn request(prompt: &str) -> AgentCommand<'_> {
    AgentCommand {
        model: None,
        access: None,
        prompt,
        resume: None,
        extra_dirs: &[],
        sandbox_roots: &[],
        effort: None,
        images: &[],
        lite: false,
        mcp_config: None,
        persistent_authorizations: None,
        orchestration_worker: false,
        front_desk: false,
        codex_user_mcp: &[],
        codex_worker_playwright: None,
        codex_worker_desktop: false,
        worker_full_tools: false,
        claude_worker_mcp: None,
        preferences: None,
    }
}

fn command(kind: AgentKind, mcp_config: Option<&Path>) -> String {
    provider_for(kind).build_command(&AgentCommand {
        model: Some("model-x"),
        access: Some(Access::Auto),
        effort: Some("high"),
        mcp_config,
        ..request("hello")
    })
}

#[test]
fn factory_keeps_provider_identity_and_transport_together() {
    let claude = provider_for(AgentKind::Claude);
    assert_eq!(claude.kind(), AgentKind::Claude);
    assert_eq!(claude.display_name(), "Claude Code");
    assert_eq!(claude.capabilities().input, InputTransport::StreamJson);

    let codex = provider_for(AgentKind::Codex);
    assert_eq!(codex.kind(), AgentKind::Codex);
    assert_eq!(codex.display_name(), "Codex");
    assert_eq!(codex.capabilities().input, InputTransport::AppServer);

    let pi = provider_for(AgentKind::Pi);
    assert_eq!(pi.kind(), AgentKind::Pi);
    assert_eq!(pi.display_name(), "pi.dev");
    // One long-lived `pi --mode rpc` process, framed like Claude's stream.
    assert_eq!(pi.capabilities().input, InputTransport::StreamJson);
    assert!(pi.capabilities().uses_octiq_mcp);
    assert!(!pi.capabilities().interrupt_ends_process);
    assert!(pi.capabilities().access_change_relaunches);
    assert!(!pi.capabilities().supports_live_access_change);

    let agy = provider_for(AgentKind::Antigravity);
    assert_eq!(agy.kind(), AgentKind::Antigravity);
    assert_eq!(agy.display_name(), "Antigravity");
    assert_eq!(agy.bin(), "agy");
    assert_eq!(agy.capabilities().input, InputTransport::StreamJson);
    assert!(agy.capabilities().uses_octiq_mcp);
    assert!(agy.capabilities().interrupt_ends_process);
    assert_eq!(
        AgentKind::ALL.map(AgentKind::id),
        ["claude", "codex", "pi", "antigravity"],
        "the picker order"
    );
}

/// The common runtime conformance harness. A new provider is registered in
/// `AgentKind::ALL`, then must satisfy these lifecycle promises without
/// adding a name check to the chat manager's tests.
#[test]
fn every_registered_provider_satisfies_the_runtime_contract() {
    for kind in AgentKind::ALL {
        let provider = provider_for(kind);
        let capabilities = provider.capabilities();
        assert_eq!(provider.kind(), kind);
        assert!(!provider.display_name().is_empty());
        assert!(!provider.bin().is_empty());

        let command = command(kind, None);
        assert!(command.starts_with(provider.bin()));
        let provider_framed = capabilities.input == InputTransport::StreamJson;
        assert_eq!(
            provider.user_message_payload("hello", &[]).is_some(),
            provider_framed,
        );
        // A framed stdin either takes an interrupt or is stopped by
        // ending its process; never neither, never both.
        assert_eq!(
            provider.interrupt_payload().is_some(),
            provider_framed && !capabilities.interrupt_ends_process,
        );
        assert_eq!(
            provider.access_change_payload(Access::Auto).is_some(),
            provider_framed && capabilities.supports_live_access_change,
        );
        assert!(provider.effort("high").is_some());

        let unknown = json!({ "type": "unknown" });
        let observed = provider.observe_event(&unknown);
        assert!(observed.session_id.is_none());
        assert!(!observed.turn_finished);
    }
}

#[test]
fn each_adapter_owns_its_command_spelling() {
    let claude = command(AgentKind::Claude, Some(Path::new("octiq-ask.json")));
    assert!(claude.contains("--permission-mode auto"));
    assert!(claude.contains("--mcp-config"));
    assert!(claude.contains("mcp__octiq__ask_user"));
    assert!(!claude.contains("--disable-ask-user"));
    assert!(!claude.contains("--sandbox"));

    let codex = command(AgentKind::Codex, Some(Path::new("octiq-ask.json")));
    assert!(codex.starts_with("codex app-server --enable default_mode_request_user_input"));
    assert!(codex.contains("mcp_servers.octiq.command=\"node\""));
    assert!(codex.contains("mcp_servers.octiq.args=[\"octiq-ask.cjs\",\"--disable-ask-user\"]"));
    assert!(codex.contains("mcp_servers.octiq.env_vars=[\"OCTIQ_CHAT_KEY\",\"OCTIQ_ROOT\",\"OCTIQ_SESSION_KEY\",\"OCTIQ_LAUNCH_ID\",\"OCTIQ_CHAT_CAPABILITY\",\"OCTIQ_HOOK_PORT\"]"));
    assert!(!codex.contains("mcp_servers.octiq.tool_timeout_sec"));
    assert!(!codex.contains("--permission-mode"));

    let instructions = codex_developer_instructions(
        Some("model-x"),
        Some("high"),
        Some(Access::Auto),
        None,
        true,
        false,
    );
    assert!(instructions.contains("native `request_user_input`"));
    assert!(instructions.contains("legacy MCP `ask_user` tool is intentionally unavailable"));
    assert!(instructions.contains("Do not ask again in prose for that same blocked action"));
    assert!(!instructions.contains("mcp__octiq__ask_user"));
    assert!(instructions.contains("search_conversations"));
    assert!(instructions.contains("use `set_chat_title` if available"));
    assert!(claude.contains("mcp__octiq__set_chat_title"));
    // A handover only records a request the person then confirms on its
    // own card; a permission prompt in front of it would ask twice.
    assert!(claude.contains("mcp__octiq__handover"));
    // The same for a change to the registered agents: the host puts it on
    // its own one-off permission card (`team_tools`).
    for tool in [
        "agent_list",
        "agent_register",
        "agent_update",
        "agent_delete",
        "agent_policy_update",
        "team_create",
        "team_update",
        // An agent's own Lessons, likewise on the host's one-off card
        // (`memory_lessons`).
        "vault_agent_memory_lessons",
        // A raise of the chat's access is asked on its own card too.
        "request_access",
    ] {
        assert!(claude.contains(&format!("mcp__octiq__{tool}")), "{tool}");
    }
    // A peer ask only reads, and a peer request only records a task that
    // waits on the plan card: the person decides there, not on a prompt
    // in front of the call.
    for tool in ["orchestration_peer_ask", "orchestration_peer_request"] {
        assert!(claude.contains(&format!("mcp__octiq__{tool}")), "{tool}");
    }
    assert!(claude.contains("mcp__octiq__feedback_submit"));
    assert!(claude.contains("mcp__octiq__feedback_list"));
    // A status change is the inbox's own bookkeeping, like a report: no
    // card at any level (`permission::host_bookkeeping` covers plan mode).
    assert!(claude.contains("mcp__octiq__feedback_update"));
    assert!(instructions.contains("`feedback_submit`"));
    assert!(instructions.contains("`feedback_update`"));
    assert!(FEEDBACK_PROMPT.contains("merely written is not resolved"));
    assert!(instructions.contains("Docspace may contain shared preferences"));
    assert!(instructions.contains("model: model-x"));
    assert!(instructions.contains("effort: high"));
    assert!(instructions.contains("OctiqFlow label: Workspace write"));
    assert!(instructions.contains("it is not a request for grammar or wording changes"));
    assert!(instructions.contains("Do not browse official documentation"));
    assert!(instructions.contains("fewest useful tool or retrieval loops"));

    let pi = command(AgentKind::Pi, Some(Path::new("/m/octiq-ask.json")));
    assert!(pi.starts_with("pi --mode rpc"), "{pi}");
    // A bare id is Codex's upstream, named in the model, never pinned
    // with `--provider`.
    assert!(pi.contains("--model 'openai-codex/model-x'"), "{pi}");
    assert!(!pi.contains("--provider"), "{pi}");
    assert!(pi.contains("--thinking high"));
    assert!(pi.contains("--tools 'read,bash,edit,write,grep,find,ls,mcp__*'"));
    // Built with the platform's separator, as the launch builds it: on
    // Windows `/m/octiq-ask.json` gives `/m\pi\octiq-pi.ts`.
    let pi_dir = Path::new("/m").join("pi");
    let extension = pi_dir.join("octiq-pi.ts");
    assert!(
        pi.contains(&format!("-e '{}'", extension.display())),
        "{pi}"
    );
    let prompts = format!("{}", pi_dir.join("prompts").join("").display());
    assert!(
        pi.contains(&format!("--append-system-prompt '{prompts}")),
        "{pi}"
    );
    // The prompt goes on stdin, never on the command line.
    assert!(!pi.contains("hello"));
    assert!(!pi.contains(" -- "));
}

#[test]
fn codex_sandbox_guidance_names_the_least_access_and_the_workers_gate() {
    for access in [Access::Read, Access::Manual, Access::Edits, Access::Auto] {
        for worker in [false, true] {
            let prompt = codex_developer_instructions(None, None, Some(access), None, true, worker);
            assert!(prompt.contains("Network is off, including localhost"));
            assert!(prompt.contains("packed-refs.lock warning"));
            assert!(prompt.contains("does not create an OctiqFlow safety approval card"));
            if worker {
                assert!(prompt.contains("A worker cannot use `request_access`"));
                assert!(prompt.contains("authorized retry at Full"));
            } else {
                assert!(prompt.contains("use `request_access` with the least level"));
                assert!(prompt.contains("next turn"));
                if access == Access::Read {
                    assert!(prompt.contains("only needs Auto (`level: auto`)"));
                }
            }
        }
    }
    for access in [None, Some(Access::Full)] {
        assert!(codex_sandbox_guidance(access, false).is_none());
        assert!(codex_sandbox_guidance(access, true).is_none());
    }
}

/// Feedback 8301d3b9: auto mode's classifier does not read tool results,
/// so an approval picked on an `ask_user` card cannot clear an action.
/// Only Claude has the tool, so only Claude is told the rule.
#[test]
fn only_claude_is_told_to_ask_permission_in_chat_not_on_a_card() {
    let rule = "Never use `ask_user` to ask permission for an action with side effects";
    let typed = "Only a typed reply from the person counts as approval";
    let claude = command(AgentKind::Claude, Some(Path::new("octiq-ask.json")));
    assert!(claude.contains(rule), "{claude}");
    assert!(claude.contains(typed));
    assert!(claude.contains("Keep using `ask_user` for ordinary decisions"));

    for worker in [false, true] {
        let codex = codex_developer_instructions(
            Some("model-x"),
            Some("high"),
            Some(Access::Auto),
            None,
            true,
            worker,
        );
        assert!(!codex.contains(rule));
        assert!(!codex.contains(typed));
    }
    // Pi's host gate reads the person's card, so the Claude-only reason
    // is not told to it: the question tool's first paragraph is.
    let dir = crate::test_dir::TestDir::new("pi-ask-rule");
    let mcp = dir.join("octiq-ask.json");
    let (_, prompt) = pi_launch(&AgentCommand {
        mcp_config: Some(&mcp),
        ..codex_request(false, &[])
    });
    assert!(!prompt.contains(rule), "{prompt}");
    assert!(!prompt.contains(typed));
    assert!(prompt.contains("call the `ask_user` tool"));
}

#[test]
fn codex_keeps_octiqflow_host_context_when_its_mcp_cannot_be_written() {
    let command = command(AgentKind::Codex, None);
    assert_eq!(
        command,
        "codex app-server --enable default_mode_request_user_input"
    );
    let instructions = codex_developer_instructions(
        Some("model-x"),
        Some("high"),
        Some(Access::Auto),
        None,
        true,
        false,
    );
    assert!(instructions.contains("native `request_user_input`"));
    assert!(instructions.contains("Docspace may contain shared preferences"));
    assert!(instructions.contains("model: model-x"));
}

#[test]
fn codex_receives_the_exact_octiqflow_runtime_selection() {
    let instructions = codex_developer_instructions(
        Some("gpt-5.6-sol"),
        Some("xhigh"),
        Some(Access::Auto),
        None,
        true,
        false,
    );
    assert!(instructions.contains("model: gpt-5.6-sol (OctiqFlow label: Sol)"));
    assert!(instructions.contains("effort: xhigh (OctiqFlow label: Very high)"));
    assert!(instructions.contains("OctiqFlow label: Workspace write"));
    assert!(instructions.contains("Report these values directly when asked about this session"));
}

#[test]
fn an_orchestration_worker_gets_the_structured_gate_and_report_protocol() {
    let instructions =
        codex_developer_instructions(None, None, Some(Access::Auto), None, true, true);
    assert!(instructions.contains("Do not use `request_user_input`"));
    assert!(instructions.contains("`orchestration_gate_create`"));
    assert!(instructions.contains("`orchestration_worker_report`"));
    assert!(instructions.contains("safety rejection"));
    assert!(instructions
        .contains("do not call `orchestration_gate_create` or `orchestration_worker_report`"));

    let claude = provider_for(AgentKind::Claude).build_command(&AgentCommand {
        access: Some(Access::Auto),
        mcp_config: Some(Path::new("octiq-ask.json")),
        orchestration_worker: true,
        ..request("work")
    });
    assert!(claude.contains("orchestration_gate_create"));
    assert!(claude.contains("orchestration_worker_report"));
}

#[test]
fn a_front_desk_gets_route_chat_and_no_other_tool() {
    let line = provider_for(AgentKind::Claude).build_command(&AgentCommand {
        model: Some("haiku"),
        // Whatever access it was given, the tools are what stop it.
        access: Some(Access::Full),
        extra_dirs: &["/tmp/extra".to_owned()],
        effort: Some("low"),
        lite: true,
        mcp_config: Some(Path::new("octiq-ask.json")),
        front_desk: true,
        ..request("where do I take this")
    });
    assert!(line.contains(" --tools ''"), "no built-in tool: {line}");
    assert!(line.contains(" --permission-mode dontAsk"), "{line}");
    assert_eq!(line.matches("--permission-mode").count(), 1, "{line}");
    assert!(!line.contains("--dangerously-skip-permissions"), "{line}");
    assert_eq!(line.matches("--allowedTools").count(), 1, "{line}");
    assert!(
        line.contains("--allowedTools mcp__octiq__route_chat --system-prompt"),
        "{line}"
    );
    assert!(line.contains("--strict-mcp-config --disable-slash-commands --setting-sources ''"));
    assert!(
        line.contains("--model 'haiku'") && line.contains("--effort low"),
        "{line}"
    );
    for absent in [
        "orchestration_run_create",
        "mcp__octiq__handover",
        "mcp__octiq__agent_register",
        "mcp__octiq__team_create",
        "vault_write",
        "--append-system-prompt",
        "--add-dir",
    ] {
        assert!(!line.contains(absent), "{absent} in {line}");
    }
}

fn codex_request<'a>(front_desk: bool, servers: &'a [CodexMcpServer]) -> AgentCommand<'a> {
    AgentCommand {
        model: Some("gpt-5.6-luna"),
        access: Some(Access::Read),
        effort: Some("low"),
        lite: true,
        mcp_config: Some(Path::new("octiq-ask.json")),
        front_desk,
        codex_user_mcp: servers,
        ..request("where do I take this")
    }
}

#[test]
fn codex_exec_keeps_all_roots_on_fresh_start_and_resume() {
    let folders = vec!["/repo/other side".into(), "/repo/docs".into()];
    let git = vec![
        "/repo/.git/objects".into(),
        "/repo/.git/worktrees/task/index.lock".into(),
    ];
    for resume in [None, Some("native-session")] {
        let request = AgentCommand {
            extra_dirs: &folders,
            sandbox_roots: &git,
            resume,
            access: Some(Access::Auto),
            ..codex_request(false, &[])
        };
        let command = codex_exec_command(&request, &CODEX);
        assert_eq!(
            command
                .matches("sandbox_workspace_write.writable_roots=")
                .count(),
            1
        );
        for root in folders.iter().chain(&git) {
            assert!(command.contains(root), "{command}");
        }
        assert!(!command.contains("--add-dir '/repo/.git"));
        assert_eq!(
            command.contains("--add-dir '/repo/other side'"),
            resume.is_none()
        );
        assert!(command.contains("approval_policy='on-request'"));
    }
}

fn person_servers() -> Vec<CodexMcpServer> {
    vec![
        CodexMcpServer {
            name: "node_repl".into(),
            remote: false,
            startup_timeout_secs: None,
            enabled: true,
        },
        CodexMcpServer {
            name: "sentry".into(),
            remote: true,
            startup_timeout_secs: None,
            enabled: true,
        },
    ]
}

/// Review of 7ca0e78: Codex forwards its MCP server only the variables
/// named in `env_vars`, and the front desk's marker was not one of them,
/// so a Codex front desk's MCP listed the ordinary tools and no
/// `route_chat`. Both transports build the same MCP config.
#[test]
fn a_codex_front_desk_hands_its_marker_to_the_mcp_and_an_ordinary_chat_does_not() {
    let servers = person_servers();
    let desk = codex_request(true, &servers);
    let ordinary = codex_request(false, &[]);
    let marker = "\"OCTIQ_HOOK_PORT\",\"OCTIQ_FRONT_DESK\"]";
    // Read-only is approval policy `never`, under which Codex fails an
    // MCP call that wants approval: a live probe's route_chat did. A
    // front desk has route_chat approved, an ordinary chat request_access;
    // each only puts a card up, and nothing else is approved.
    let approve = "-c 'mcp_servers.octiq.tools.route_chat.approval_mode=\"approve\"'";
    for line in [
        CODEX.build_command(&desk),
        codex_exec_command(&desk, &CODEX),
    ] {
        assert!(line.contains(marker), "{line}");
        assert!(line.contains(approve), "{line}");
        assert_eq!(line.matches("approval_mode").count(), 1, "{line}");
    }
    let ask_access = "-c 'mcp_servers.octiq.tools.request_access.approval_mode=\"approve\"'";
    for line in [
        CODEX.build_command(&ordinary),
        codex_exec_command(&ordinary, &CODEX),
    ] {
        assert!(!line.contains("OCTIQ_FRONT_DESK"), "{line}");
        assert!(!line.contains("route_chat"), "{line}");
        // Access requests use a card.
        assert!(line.contains(ask_access), "{line}");
        assert_eq!(
            line.matches("approval_mode").count(),
            crate::permission::HOST_BOOKKEEPING.len(),
            "{line}"
        );
        for tool in crate::permission::HOST_BOOKKEEPING {
            assert!(
                line.contains(&format!(
                    "mcp_servers.octiq.tools.{tool}.approval_mode=\"approve\""
                )),
                "{tool}: {line}"
            );
        }
        for tool in [
            "orchestration_validation_create",
            "orchestration_worker_start",
            "vault_write",
            "orchestration_run_create",
        ] {
            assert!(
                !line.contains(&format!("tools.{tool}.approval_mode")),
                "{tool}: {line}"
            );
        }
        assert!(line.contains("\"OCTIQ_HOOK_PORT\"]"), "{line}");
    }
    // With no MCP config written there is no server to approve a tool on;
    // a lone tools entry would be an invalid server to Codex.
    let bare = AgentCommand {
        mcp_config: None,
        ..codex_request(true, &[])
    };
    assert!(!CODEX.build_command(&bare).contains("mcp_servers.octiq"));
}

/// Codex has no `--tools ''` and no `--strict-mcp-config`: a front desk
/// turns off every feature that brings a tool, and each of the person's
/// own MCP servers by name. An ordinary Codex chat keeps all of them.
#[test]
fn a_codex_front_desk_turns_off_its_own_tools_and_the_persons_mcp_servers() {
    let servers = person_servers();
    let desk = codex_request(true, &servers);
    for line in [
        CODEX.build_command(&desk),
        codex_exec_command(&desk, &CODEX),
    ] {
        for feature in CODEX_FRONT_DESK_FEATURES_OFF {
            assert!(
                line.contains(&format!(" --disable {feature}")),
                "{feature}: {line}"
            );
        }
        assert!(line.contains("-c 'web_search=\"disabled\"'"), "{line}");
        assert!(
            line.contains("-c 'mcp_servers.node_repl={command=\"false\",enabled=false}'"),
            "{line}"
        );
        assert!(
            line.contains("-c 'mcp_servers.sentry={url=\"http://127.0.0.1:9/\",enabled=false}'"),
            "{line}"
        );
    }
    let ordinary = codex_request(false, &servers);
    for line in [
        CODEX.build_command(&ordinary),
        codex_exec_command(&ordinary, &CODEX),
    ] {
        assert!(!line.contains(" --disable "), "{line}");
        assert!(!line.contains("enabled=false"), "{line}");
        assert!(!line.contains("web_search"), "{line}");
    }
}

const PLAYWRIGHT_ENTRY: &str =
    "{command=\"npx\",args=[\"-y\",\"@playwright/mcp@latest\"],env_vars=[\"TOKEN\"]}";

fn browser() -> crate::worker_browser::CodexBrowser {
    crate::worker_browser::CodexBrowser {
        name: crate::worker_browser::CODEX_SERVER.into(),
        entry: PLAYWRIGHT_ENTRY.into(),
        env: vec![("TOKEN".into(), "s3cret-value".into())],
    }
}

fn browser_worker<'a>(
    servers: &'a [CodexMcpServer],
    playwright: Option<&'a crate::worker_browser::CodexBrowser>,
) -> AgentCommand<'a> {
    AgentCommand {
        orchestration_worker: true,
        access: Some(Access::Auto),
        lite: false,
        codex_worker_playwright: playwright,
        codex_worker_desktop: false,
        worker_full_tools: false,
        ..codex_request(false, servers)
    }
}

#[test]
fn workers_keep_host_and_execution_tools_without_inherited_mcp_servers() {
    let servers = person_servers();
    let worker = browser_worker(&servers, None);
    let claude = CLAUDE.build_command(&worker);
    assert!(claude.contains(" --strict-mcp-config"), "{claude}");
    assert!(!claude.contains("--setting-sources"), "settings/hooks stay");
    assert!(!claude.contains("--tools ''"), "execution tools stay");
    assert!(claude.contains("mcp__octiq__orchestration_worker_report"));
    let ordinary = AgentCommand {
        orchestration_worker: false,
        ..browser_worker(&servers, None)
    };
    assert!(!CLAUDE
        .build_command(&ordinary)
        .contains(" --strict-mcp-config"));
    for line in [
        CODEX.build_command(&worker),
        codex_exec_command(&worker, &CODEX),
    ] {
        assert!(
            line.contains("mcp_servers.node_repl={command=\"false\",enabled=false}"),
            "{line}"
        );
        assert!(
            line.contains("mcp_servers.sentry={url=\"http://127.0.0.1:9/\",enabled=false}"),
            "{line}"
        );
        assert!(line.contains(" --disable apps"), "{line}");
        assert!(line.contains(" --disable plugins"), "{line}");
        assert!(!line.contains(" --disable shell_tool"), "{line}");
        assert!(!line.contains(" --disable unified_exec"), "{line}");
        assert!(line.contains(
            "mcp_servers.octiq.tools.orchestration_worker_report.approval_mode=\"approve\""
        ));
        assert!(
            !line.contains("octiq_playwright"),
            "no definition, no browser: {line}"
        );
    }
}

fn desktop_servers() -> Vec<CodexMcpServer> {
    let server = |name: &str, remote: bool, secs: Option<u64>| CodexMcpServer {
        name: name.into(),
        remote,
        startup_timeout_secs: secs,
        enabled: true,
    };
    vec![
        server("codex_app", false, Some(10)),
        server("cua_repl", false, Some(120)),
        server("node_repl", false, Some(120)),
        server("sentry", true, None),
    ]
}

/// Off, the worker's flags are what they were before the opt-in existed:
/// the exact text, not a property of it.
#[test]
fn without_desktop_tools_a_codex_workers_flags_are_unchanged() {
    let servers = desktop_servers();
    let mut off = String::new();
    append_codex_worker_mcp(&mut off, &servers, None, false);
    assert_eq!(
        off,
        " --disable apps --disable plugins \
             -c 'mcp_servers.codex_app={command=\"false\",enabled=false}' \
             -c 'mcp_servers.cua_repl={command=\"false\",enabled=false}' \
             -c 'mcp_servers.node_repl={command=\"false\",enabled=false}' \
             -c 'mcp_servers.sentry={url=\"http://127.0.0.1:9/\",enabled=false}'"
    );
    // And through both transports the flag is simply not there.
    let worker = browser_worker(&servers, None);
    for line in [
        CODEX.build_command(&worker),
        codex_exec_command(&worker, &CODEX),
    ] {
        assert!(line.contains(&off), "{line}");
    }
}

/// On, plugins stay (they carry the route: with `--disable plugins`,
/// checked against codex-cli 0.164, `cua_repl` is gone and `node_repl` is a
/// bare REPL), apps stay off, and every other inherited server is still off.
#[test]
fn with_desktop_tools_a_codex_worker_keeps_plugins_and_the_two_servers_only() {
    let servers = desktop_servers();
    let on = AgentCommand {
        codex_worker_desktop: true,
        worker_full_tools: false,
        ..browser_worker(&servers, None)
    };
    for line in [CODEX.build_command(&on), codex_exec_command(&on, &CODEX)] {
        assert!(line.contains(" --disable apps"), "{line}");
        assert!(!line.contains("--disable plugins"), "{line}");
        assert!(!line.contains("cua_repl"), "left to Codex: {line}");
        assert!(!line.contains("node_repl"), "left to Codex: {line}");
        assert!(
            line.contains("mcp_servers.codex_app={command=\"false\",enabled=false}"),
            "{line}"
        );
        assert!(
            line.contains("mcp_servers.sentry={url=\"http://127.0.0.1:9/\",enabled=false}"),
            "{line}"
        );
        // Nothing else about the worker changed.
        assert!(
            line.contains(
                "mcp_servers.octiq.tools.orchestration_worker_report.approval_mode=\"approve\""
            ),
            "{line}"
        );
    }
    // The person's own playwright still rides beside it.
    let browser = browser();
    let both = AgentCommand {
        codex_worker_desktop: true,
        worker_full_tools: false,
        ..browser_worker(&servers, Some(&browser))
    };
    let line = CODEX.build_command(&both);
    assert!(line.contains("mcp_servers.octiq_playwright="), "{line}");
    assert!(!line.contains("s3cret-value"), "no env value: {line}");
    // A front desk never gets it, whatever the flag says.
    let desk = AgentCommand {
        front_desk: true,
        codex_worker_desktop: true,
        worker_full_tools: false,
        ..browser_worker(&servers, None)
    };
    let line = CODEX.build_command(&desk);
    assert!(line.contains(" --disable plugins"), "{line}");
    assert!(
        line.contains("mcp_servers.cua_repl={command=\"false\",enabled=false}"),
        "{line}"
    );
}

#[test]
fn the_desktop_servers_are_found_by_name_and_carry_codexs_own_timeout() {
    let listed = r#"[
            {"name":"codex_app","enabled":false,"transport":{"type":"stdio","command":"x"},"startup_timeout_sec":10.0},
            {"name":"cua_repl","enabled":true,"transport":{"type":"stdio","command":"/bin/sh"},"startup_timeout_sec":120.0},
            {"name":"node_repl","enabled":true,"transport":{"type":"stdio","command":"node_repl"}},
            {"name":"sentry","enabled":true,"transport":{"type":"streamable_http","url":"https://x"}}
        ]"#;
    let servers = codex_front_desk_mcp_servers(listed).unwrap();
    let found: Vec<_> = codex_desktop_servers(&servers)
        .into_iter()
        .map(|s| (s.name.as_str(), s.startup_timeout_secs))
        .collect();
    assert_eq!(found, [("cua_repl", Some(120)), ("node_repl", None)]);
    assert!(codex_desktop_servers(&person_servers()[1..]).is_empty());
    // A remote server of the same name is not the local bridge.
    let remote = [CodexMcpServer {
        name: "cua_repl".into(),
        remote: true,
        startup_timeout_secs: None,
        enabled: true,
    }];
    assert!(codex_desktop_servers(&remote).is_empty());
}

/// A Codex worker gets the person's playwright as one whole entry under
/// the host's own name, on every transport and for a fresh start and a
/// resume alike; everything else stays off (all plugins, apps, every
/// inherited server). No env value is on the line.
#[test]
fn a_codex_worker_gets_the_persons_playwright_as_one_whole_entry() {
    let servers = person_servers();
    let browser = browser();
    let fresh = browser_worker(&servers, Some(&browser));
    let resumed = AgentCommand {
        resume: Some("native-session"),
        ..browser_worker(&servers, Some(&browser))
    };
    let want = format!("-c 'mcp_servers.octiq_playwright={PLAYWRIGHT_ENTRY}'");
    for line in [
        CODEX.build_command(&fresh),
        codex_exec_command(&fresh, &CODEX),
        CODEX.build_command(&resumed),
        codex_exec_command(&resumed, &CODEX),
    ] {
        assert_eq!(
            line.matches("mcp_servers.octiq_playwright=").count(),
            1,
            "{line}"
        );
        assert!(line.contains(&want), "{line}");
        assert!(line.contains(" --disable apps --disable plugins"), "{line}");
        assert!(
            line.contains("mcp_servers.sentry={url=\"http://127.0.0.1:9/\",enabled=false}"),
            "{line}"
        );
        assert!(!line.contains("cua_repl"), "{line}");
        assert!(!line.contains("plugins={"), "{line}");
        assert!(
            !line.contains("s3cret-value"),
            "no env value on argv: {line}"
        );
    }
}

/// Review round 1 (H1). Codex deep-merges a whole-table `-c` with the
/// person's own entry of the same name, so the host's entry has a name of
/// its own and the person's `playwright` is switched off like any other.
#[test]
fn the_hosts_browser_never_shares_a_name_with_the_persons_playwright() {
    let mut servers = person_servers();
    servers.push(CodexMcpServer {
        name: "playwright".into(),
        remote: false,
        startup_timeout_secs: None,
        enabled: true,
    });
    let browser = browser();
    let with = codex_exec_command(&browser_worker(&servers, Some(&browser)), &CODEX);
    assert!(
        with.contains("mcp_servers.playwright={command=\"false\",enabled=false}"),
        "the person's own is off: {with}"
    );
    assert_eq!(with.matches("mcp_servers.playwright=").count(), 1, "{with}");
    assert_eq!(
        with.matches("mcp_servers.octiq_playwright=").count(),
        1,
        "{with}"
    );
    // A remote entry of the person's is turned off by its own kind.
    servers.push(CodexMcpServer {
        name: "playwright".into(),
        remote: true,
        startup_timeout_secs: None,
        enabled: true,
    });
    // Without a definition of the person's, Codex's own stays off too.
    let without = codex_exec_command(&browser_worker(&servers, None), &CODEX);
    assert!(
        without.contains("mcp_servers.playwright={command=\"false\",enabled=false}"),
        "{without}"
    );
}

/// A full-access worker gets the person's whole tool set, as an ordinary
/// chat of its provider has it: no isolation flag, no per-server disable,
/// no host copy of the browser (the person's own is inherited). OctiqFlow's
/// own `octiq` server is on either way.
#[test]
fn a_full_access_worker_keeps_the_persons_whole_tool_set_on_both_providers() {
    let servers = desktop_servers();
    let browser = browser();
    let full = AgentCommand {
        access: Some(Access::Full),
        worker_full_tools: true,
        ..browser_worker(&servers, Some(&browser))
    };
    for line in [
        CODEX.build_command(&full),
        codex_exec_command(&full, &CODEX),
    ] {
        assert!(!line.contains("--disable apps"), "{line}");
        assert!(!line.contains("--disable plugins"), "{line}");
        assert!(!line.contains("enabled=false"), "{line}");
        assert!(!line.contains("octiq_playwright"), "{line}");
        for name in ["codex_app", "cua_repl", "node_repl", "sentry"] {
            assert!(
                !line.contains(&format!("mcp_servers.{name}=")),
                "{name}: {line}"
            );
        }
        assert!(
            line.contains(
                "mcp_servers.octiq.tools.orchestration_worker_report.approval_mode=\"approve\""
            ),
            "ours stays: {line}"
        );
    }
    let claude = CLAUDE.build_command(&full);
    assert!(!claude.contains("--strict-mcp-config"), "{claude}");
    assert!(
        claude.contains("--mcp-config 'octiq-ask.json'"),
        "ours stays: {claude}"
    );
    // The worker browser file stays beside it.
    let file = Path::new("/tmp/worker-browser.json");
    let with_file = AgentCommand {
        claude_worker_mcp: Some(file),
        ..full
    };
    let claude = CLAUDE.build_command(&with_file);
    assert!(
        claude.contains("--mcp-config '/tmp/worker-browser.json'"),
        "{claude}"
    );
    assert!(!claude.contains("--strict-mcp-config"), "{claude}");
}

/// Below Full nothing moves: the flag is simply false, so the text is the
/// one every worker had before.
#[test]
fn below_full_access_a_workers_flags_are_byte_identical_to_the_isolated_launch() {
    let servers = desktop_servers();
    let browser = browser();
    for access in [Access::Read, Access::Manual, Access::Edits, Access::Auto] {
        let base = AgentCommand {
            access: Some(access),
            ..browser_worker(&servers, Some(&browser))
        };
        for line in [
            CODEX.build_command(&base),
            codex_exec_command(&base, &CODEX),
        ] {
            assert!(line.contains(" --disable apps --disable plugins"), "{line}");
            assert!(line.contains("mcp_servers.octiq_playwright="), "{line}");
            assert!(
                line.contains("mcp_servers.cua_repl={command=\"false\",enabled=false}"),
                "{line}"
            );
        }
        assert!(CLAUDE.build_command(&base).contains(" --strict-mcp-config"));
    }
}

/// The flag is the host's to set for a worker alone: a front desk and a
/// lite chat stay isolated even when it is handed in.
#[test]
fn a_front_desk_or_lite_chat_stays_isolated_whatever_the_flag_says() {
    let servers = desktop_servers();
    let desk = AgentCommand {
        access: Some(Access::Full),
        worker_full_tools: true,
        orchestration_worker: true,
        ..codex_request(true, &servers)
    };
    for line in [
        CODEX.build_command(&desk),
        codex_exec_command(&desk, &CODEX),
    ] {
        assert!(line.contains(" --disable plugins"), "{line}");
        assert!(
            line.contains("mcp_servers.cua_repl={command=\"false\",enabled=false}"),
            "{line}"
        );
    }
    let claude = CLAUDE.build_command(&desk);
    assert!(claude.contains("--strict-mcp-config"), "{claude}");
    assert!(claude.contains("--tools ''"), "{claude}");
    let lite = AgentCommand {
        lite: true,
        access: Some(Access::Full),
        worker_full_tools: true,
        ..browser_worker(&servers, None)
    };
    assert!(CLAUDE.build_command(&lite).contains("--strict-mcp-config"));
}

#[test]
fn the_first_turn_gate_watches_what_a_launch_keeps() {
    use std::time::Duration;
    let mut servers = desktop_servers();
    servers[0].enabled = false; // codex_app: disabled, never reports
                                // Isolated, nothing kept: no gate.
    assert_eq!(
        codex_gate_servers(None, false, false, &servers),
        (Vec::<String>::new(), Duration::ZERO)
    );
    // Full: every enabled server, the longest timeout, no repeats.
    let (names, longest) = codex_gate_servers(Some("octiq_playwright"), true, true, &servers);
    assert_eq!(
        names,
        ["octiq_playwright", "cua_repl", "node_repl", "sentry"]
    );
    assert_eq!(longest, Duration::from_secs(120));
    // Desktop alone: the two desktop servers only.
    let (names, _) = codex_gate_servers(None, false, true, &servers);
    assert_eq!(names, ["cua_repl", "node_repl"]);
}

#[test]
fn the_listing_says_whether_a_server_is_enabled() {
    let json = r#"[{"name":"codex_app","enabled":false,"transport":{"type":"stdio"},"startup_timeout_sec":10.0},
            {"name":"cua_repl","enabled":true,"transport":{"type":"stdio"},"startup_timeout_sec":120.0},
            {"name":"old","transport":{"type":"stdio"}}]"#;
    let servers = codex_front_desk_mcp_servers(json).unwrap();
    assert_eq!(
        servers.iter().map(|s| s.enabled).collect::<Vec<_>>(),
        [false, true, true]
    );
}

/// A front desk keeps full isolation whatever it is handed, and an
/// ordinary chat is untouched.
#[test]
fn the_browser_reaches_workers_only() {
    let servers = person_servers();
    let entry = browser();
    let desk = AgentCommand {
        codex_worker_playwright: Some(&entry),
        codex_worker_desktop: false,
        worker_full_tools: false,
        ..codex_request(true, &servers)
    };
    for line in [
        CODEX.build_command(&desk),
        codex_exec_command(&desk, &CODEX),
    ] {
        assert!(!line.contains("octiq_playwright"), "{line}");
        assert!(line.contains(" --disable plugins"), "{line}");
    }
    let ordinary = AgentCommand {
        codex_worker_playwright: Some(&entry),
        codex_worker_desktop: false,
        worker_full_tools: false,
        ..codex_request(false, &servers)
    };
    for line in [
        CODEX.build_command(&ordinary),
        codex_exec_command(&ordinary, &CODEX),
    ] {
        assert!(!line.contains("playwright"), "{line}");
        assert!(!line.contains("enabled=false"), "{line}");
    }
}

/// A Claude worker keeps only the browser server the person chose, as a
/// second config file; every other launch names none.
#[test]
fn a_claude_worker_gets_the_browser_config_and_no_other_launch_does() {
    let browser = Path::new("worker-browser-1.json");
    let worker = AgentCommand {
        claude_worker_mcp: Some(browser),
        ..browser_worker(&[], None)
    };
    let line = CLAUDE.build_command(&worker);
    assert!(
        line.contains(
            " --mcp-config 'octiq-ask.json' --mcp-config 'worker-browser-1.json' --allowedTools"
        ),
        "{line}"
    );
    assert!(line.contains(" --strict-mcp-config"), "{line}");
    assert!(!line.contains("--allowedTools 'mcp__playwright"), "{line}");
    // The definition's env VALUES live in the 0600 file; the launch only
    // names the file (review round 1, M6).
    let dir = crate::test_dir::TestDir::new("claude-browser-argv");
    let servers = crate::worker_browser::allowlisted_servers(
        &json!({"mcpServers": {"playwright": {"command": "npx", "env": {"TOKEN": "s3cret-value"}}}}),
        "/a",
    );
    let file = crate::worker_browser::write_config(&dir, &servers).expect("file");
    let real = AgentCommand {
        claude_worker_mcp: Some(&file),
        ..browser_worker(&[], None)
    };
    let line = CLAUDE.build_command(&real);
    assert!(line.contains("worker-browser-"), "{line}");
    assert!(!line.contains("s3cret-value"), "{line}");
    for other in [
        AgentCommand {
            orchestration_worker: false,
            ..AgentCommand {
                claude_worker_mcp: Some(browser),
                ..browser_worker(&[], None)
            }
        },
        AgentCommand {
            front_desk: true,
            claude_worker_mcp: Some(browser),
            ..browser_worker(&[], None)
        },
    ] {
        let line = CLAUDE.build_command(&other);
        assert!(!line.contains("worker-browser"), "{line}");
    }
    assert!(!CLAUDE
        .build_command(&browser_worker(&[], None))
        .contains("worker-browser"));
}

/// The host prompt a Codex front desk gets is the front desk's, not the
/// one describing orchestration and the vault it cannot reach.
#[test]
fn a_codex_front_desk_is_told_it_only_routes() {
    let desk = codex_front_desk_instructions(Some("gpt-5.6-luna"), Some("low"), Some(Access::Read));
    assert!(desk.starts_with(FRONT_DESK_PROMPT), "{desk}");
    assert!(desk.contains("model: gpt-5.6-luna"), "{desk}");
    for absent in [ORCHESTRATION_PROMPT, MEMORY_VAULT_PROMPT, FEEDBACK_PROMPT] {
        assert!(!desk.contains(absent));
    }
    let servers = person_servers();
    let exec = codex_exec_command(&codex_request(true, &servers), &CODEX);
    assert!(exec.contains("You are an OctiqFlow front desk"), "{exec}");
    assert!(
        !exec.contains("orchestration tools are a host-owned"),
        "{exec}"
    );
    let ordinary = codex_exec_command(&codex_request(false, &[]), &CODEX);
    assert!(!ordinary.contains("You are an OctiqFlow front desk"));
    assert!(ordinary.contains("orchestration tools are a host-owned"));
}

#[test]
fn the_persons_codex_mcp_servers_are_read_from_codex_mcp_list() {
    let listed = r#"[
            {"name":"chatgpt-bridge","enabled":true,"transport":{"type":"stdio","command":"node"}},
            {"name":"codex_app","enabled":false,"transport":{"type":"stdio","command":"x"}},
            {"name":"octiq","enabled":true,"transport":{"type":"stdio","command":"node"}},
            {"name":"sentry","enabled":true,"transport":{"type":"streamable_http","url":"https://mcp.sentry.dev/mcp"}}
        ]"#;
    assert_eq!(
        codex_front_desk_mcp_servers(listed).unwrap(),
        vec![
            CodexMcpServer {
                name: "chatgpt-bridge".into(),
                remote: false,
                startup_timeout_secs: None,
                enabled: true,
            },
            CodexMcpServer {
                name: "codex_app".into(),
                remote: false,
                startup_timeout_secs: None,
                enabled: false,
            },
            CodexMcpServer {
                name: "sentry".into(),
                remote: true,
                startup_timeout_secs: None,
                enabled: true,
            },
        ],
        "ours is set on the command line; a disabled one is turned off all the same"
    );
    assert_eq!(codex_front_desk_mcp_servers("[]").unwrap(), vec![]);
    // A list it cannot read, or a name it cannot write as a config key,
    // stops the launch rather than leave a server on.
    assert!(codex_front_desk_mcp_servers("Not logged in").is_err());
    assert!(
        codex_front_desk_mcp_servers(r#"[{"name":"a.b","transport":{"type":"stdio"}}]"#).is_err()
    );
    assert!(
        codex_front_desk_mcp_servers(r#"[{"name":"x' -c y","transport":{"type":"stdio"}}]"#)
            .is_err()
    );
    assert!(codex_front_desk_mcp_servers(r#"[{"transport":{"type":"stdio"}}]"#).is_err());
}

/// Feedback 57fbac34: the worker prompt, the card and the snapshot gave
/// an outage-refused worker three different instructions. They carry one
/// text now, and the worker prompt says which refusals it is for.
#[test]
fn a_worker_is_told_the_same_outage_guidance_as_the_card_and_the_snapshot() {
    let guidance = crate::safety_block::outage_guidance();
    let codex = codex_developer_instructions(None, None, Some(Access::Auto), None, true, true);
    assert!(codex.contains(guidance), "{codex}");
    assert!(codex.contains("classifier was unavailable is an outage of the check"));
    assert!(
        !codex_developer_instructions(None, None, Some(Access::Auto), None, true, false)
            .contains(guidance)
    );

    let claude = provider_for(AgentKind::Claude).build_command(&AgentCommand {
        access: Some(Access::Auto),
        mcp_config: Some(Path::new("octiq-ask.json")),
        orchestration_worker: true,
        ..request("work")
    });
    // Quoted for the shell, so look for a stretch without apostrophes.
    let tail = guidance
        .split("OctiqFlow never re-runs it.")
        .nth(1)
        .unwrap();
    assert!(claude.contains(tail.trim()), "{claude}");
}

/// Feedback 2adec4d5: on Windows no Claude worker ever started. The
/// worker's line is longer than Git Bash keeps of one argument, so it was
/// cut off inside the system prompt. This is the real line through the
/// real shell, with `printf` standing in for `claude`.
#[test]
fn a_worker_launch_line_reaches_the_agent_whole() {
    let line = provider_for(AgentKind::Claude).build_command(&AgentCommand {
        access: Some(Access::Auto),
        mcp_config: Some(Path::new("octiq-ask.json")),
        orchestration_worker: true,
        ..request("work")
    });
    let shell = crate::proc::resolve_agent_shell(
        std::env::var("SHELL").ok(),
        std::env::var("LOCALAPPDATA").ok(),
        cfg!(windows),
        &crate::proc::find_executable,
    )
    .expect("a shell to launch agents through");
    let output = shell
        .command(&line.replacen("claude", "printf '%s\\n'", 1))
        .output()
        .expect("the shell starts");
    let printed = String::from_utf8_lossy(&output.stdout);
    // The system prompt is the last argument, and the outage guidance its
    // last words: the first thing lost when the line is cut short.
    assert!(
        printed
            .trim_end()
            .ends_with(crate::safety_block::outage_guidance().trim_end()),
        "a {} character line did not arrive whole; stderr: {}",
        line.len(),
        String::from_utf8_lossy(&output.stderr)
    );
}

#[test]
fn providers_share_exact_host_bookkeeping_rules_and_keep_work_gated() {
    use std::collections::BTreeSet;
    let expected: BTreeSet<_> = crate::permission::HOST_BOOKKEEPING
        .iter()
        .copied()
        .collect();
    assert_eq!(expected.len(), crate::permission::HOST_BOOKKEEPING.len());
    let claude = command(AgentKind::Claude, Some(Path::new("octiq-ask.json")));
    let actual: BTreeSet<_> = claude
        .split(" --allowedTools '")
        .nth(1)
        .unwrap()
        .split('\'')
        .next()
        .unwrap()
        .split_whitespace()
        .map(|tool| tool.strip_prefix("mcp__octiq__").unwrap())
        .collect();
    assert_eq!(actual, expected);
    for line in [
        CODEX.build_command(&codex_request(false, &[])),
        codex_exec_command(&codex_request(false, &[]), &CODEX),
    ] {
        let actual: BTreeSet<_> = line
            .split("mcp_servers.octiq.tools.")
            .skip(1)
            .map(|part| part.split('.').next().unwrap())
            .collect();
        assert_eq!(actual, expected);
    }
    for tool in [
        "orchestration_worker_start",
        "orchestration_validation_create",
        "orchestration_run_create",
        "orchestration_task_create",
        "orchestration_gate_resolve",
        "orchestration_dispatch_ready",
        "vault_write",
    ] {
        assert!(!expected.contains(tool), "{tool} must still ask");
        assert!(!crate::permission::host_bookkeeping(&format!(
            "mcp__octiq__{tool}"
        )));
    }
}

/// A Claude launch allows OctiqFlow's own tools and nothing else, at
/// every access level, worker or not. An allow rule for a shell line
/// would outlive any "once": it covers every matching call the process
/// makes, and a real claude 2.1.281 ran one rule's line twice in a turn.
#[test]
fn a_claude_launch_carries_no_allow_rule_beyond_octiqflows_own_tools() {
    for access in [Access::Read, Access::Manual, Access::Edits, Access::Auto] {
        for worker in [false, true] {
            let line = provider_for(AgentKind::Claude).build_command(&AgentCommand {
                access: Some(access),
                resume: Some("session-1"),
                lite: true,
                mcp_config: Some(Path::new("octiq-ask.json")),
                orchestration_worker: worker,
                ..request("work")
            });
            assert_eq!(line.matches("--allowedTools").count(), 1, "{line}");
            let rules = line
                .split(" --allowedTools '")
                .nth(1)
                .and_then(|rest| rest.split('\'').next())
                .unwrap();
            assert!(
                rules
                    .split_whitespace()
                    .filter(|w| *w != "\\")
                    .all(|w| w.starts_with("mcp__octiq__")),
                "{rules}"
            );
            assert!(!line.contains("Bash("), "{line}");
        }
    }
}

#[test]
fn codex_receives_persistent_project_authorizations_as_host_context() {
    let grant = "Persistent project authorizations:\n1. Send the same references to Higgsfield.";
    let instructions =
        codex_developer_instructions(None, None, Some(Access::Auto), Some(grant), true, false);
    assert!(instructions.contains("Persistent project authorizations"));
    assert!(instructions.contains("same references to Higgsfield"));
}

#[test]
fn codex_runtime_context_does_not_claim_rejected_settings() {
    let instructions = codex_developer_instructions(
        Some("gpt-5.6-sol; echo nope"),
        Some("unlimited"),
        None,
        None,
        true,
        false,
    );
    assert!(!instructions.contains("echo nope"));
    assert!(instructions.contains("OctiqFlow did not select an explicit model"));
    assert!(instructions.contains("OctiqFlow did not select an explicit effort"));
    assert!(instructions.contains("OctiqFlow did not select explicit access"));
}

/// Prepare a Pi launch in a scratch folder and read back what it wrote:
/// the command line, and the system prompt file it names.
pub(crate) fn pi_launch(request: &AgentCommand<'_>) -> (String, String) {
    let line = provider_for(AgentKind::Pi).build_command(request);
    provider_for(AgentKind::Pi)
        .prepare_launch(request)
        .expect("a Pi launch with MCP files can be prepared");
    let marker = "--append-system-prompt '";
    let from = line.find(marker).expect("a system prompt file") + marker.len();
    let path = &line[from..from + line[from..].find('\'').unwrap()];
    (
        line.clone(),
        std::fs::read_to_string(path).expect("the prompt file is written"),
    )
}

fn pi_request<'a>(mcp: &'a Path) -> AgentCommand<'a> {
    AgentCommand {
        model: Some("gpt-5.6-terra"),
        access: Some(Access::Read),
        prompt: "inspect it",
        effort: Some("minimal"),
        lite: false,
        mcp_config: Some(mcp),
        ..codex_request(false, &[])
    }
}

/// A chat `chat_recover` moved to another folder: its conversation is in
/// the old folder's session directory, and real pi 1.5.2 asks to fork it
/// when `--session <id>` is run from the new one (headless: it gives up).
/// The session FILE opens from anywhere with the same id and messages
/// (`scripts/test-pi-harness.mjs`, scenes 7), so that is what is named.
#[test]
fn a_pi_conversation_in_another_folder_is_resumed_by_its_file() {
    let sessions = crate::test_dir::TestDir::new("pi-sessions");
    let id = "01a1ecd7-77d1-778b-a182-7332c4831657";
    let old = sessions.join("--old-folder--");
    let other = sessions.join("--other-folder--");
    crate::profile::make_dir(&old).unwrap();
    crate::profile::make_dir(&other).unwrap();
    let header = |of: &str| format!("{{\"type\":\"session\",\"version\":3,\"id\":\"{of}\"}}\n");
    let file = old.join(format!("2026-11-18T04-00-00-000Z_{id}.jsonl"));
    std::fs::write(&file, header(id)).unwrap();
    // Another conversation whose id merely ends the same way, a stray
    // file, and a plain file at the top: none of them is this one.
    std::fs::write(
        other.join(format!("2026-11-18T04-00-00-000Z_x{id}.jsonl")),
        header(&format!("x{id}")),
    )
    .unwrap();
    std::fs::write(other.join("notes.txt"), "x").unwrap();
    std::fs::write(sessions.join(format!("a_{id}.jsonl")), header(id)).unwrap();
    assert_eq!(
        pi_session_ref(&sessions, id),
        file.to_str().unwrap(),
        "the file, wherever Pi saved it"
    );
    // The newest copy wins when a conversation is saved in two folders.
    std::thread::sleep(std::time::Duration::from_millis(30));
    let newer = other.join(format!("2026-11-18T05-00-00-000Z_{id}.jsonl"));
    std::fs::write(&newer, header(id)).unwrap();
    assert_eq!(pi_session_ref(&sessions, id), newer.to_str().unwrap());
    // Nothing saved yet, or no sessions folder at all: the id, as before.
    assert_eq!(
        pi_session_ref(&sessions, "no-such-session"),
        "no-such-session"
    );
    assert_eq!(
        pi_session_ref(&sessions.join("missing"), id),
        id,
        "an unreadable folder falls back to the id"
    );
    // And it is quoted onto the command line like the id was.
    assert_eq!(
        sh_quote(&pi_session_ref(&sessions, id)),
        format!("'{}'", newer.to_str().unwrap())
    );
}

/// A file NAMED for a conversation is not that conversation: its header's
/// id is. Each way a newer candidate can lie is skipped, and the older
/// honest file (or the bare id) is what is resumed.
#[test]
fn a_pi_session_file_counts_only_when_its_header_names_the_id() {
    let sessions = crate::test_dir::TestDir::new("pi-sessions-identity");
    let id = "01a1ed61-d818-70c0-83c7-52897fa2ebb3";
    let other_id = "01a1ed61-ecca-717c-b7d7-c790f8b15aa8";
    let folder = sessions.join("--f--");
    crate::profile::make_dir(&folder).unwrap();
    let header = |of: &str| format!("{{\"type\":\"session\",\"id\":\"{of}\"}}\nmore\n");
    // Nothing honest yet: every liar below falls back to the bare id.
    let name = |n: u32| folder.join(format!("2026-11-18T0{n}-00-00-000Z_{id}.jsonl"));
    let lies: Vec<(&str, Box<dyn Fn(&Path)>)> = vec![
        (
            "another conversation's file renamed",
            Box::new(|p| std::fs::write(p, header(other_id)).unwrap()),
        ),
        (
            "corrupt header",
            Box::new(|p| std::fs::write(p, "not json\n").unwrap()),
        ),
        ("empty file", Box::new(|p| std::fs::write(p, "").unwrap())),
        (
            "first line is not a session",
            Box::new(|p| {
                std::fs::write(p, format!("{{\"type\":\"message\",\"id\":\"{id}\"}}\n")).unwrap()
            }),
        ),
        (
            "header past the bound",
            Box::new(|p| {
                let mut text =
                    format!("{{\"type\":\"session\",\"pad\":\"{}\",", "x".repeat(20_000));
                text.push_str(&format!("\"id\":\"{id}\"}}\n"));
                std::fs::write(p, text).unwrap()
            }),
        ),
        (
            "a directory by that name",
            Box::new(|p| crate::profile::make_dir(p).unwrap()),
        ),
    ];
    for (n, (why, make)) in lies.iter().enumerate() {
        make(&name(n as u32 + 1));
        assert_eq!(pi_session_ref(&sessions, id), id, "{why} is not resumed");
    }
    #[cfg(unix)]
    {
        // A link to a genuine file, a link as a folder: both redirects.
        let real = sessions.join("elsewhere.jsonl");
        std::fs::write(&real, header(id)).unwrap();
        std::os::unix::fs::symlink(&real, name(7)).unwrap();
        assert_eq!(
            pi_session_ref(&sessions, id),
            id,
            "a symlinked file is skipped"
        );
        // The real folder is outside the sessions folder: only the link
        // inside it leads there.
        let outside = crate::test_dir::TestDir::new("pi-sessions-outside");
        let behind = outside.join("behind");
        crate::profile::make_dir(&behind).unwrap();
        std::fs::write(behind.join(format!("2026-11-18T08_{id}.jsonl")), header(id)).unwrap();
        std::os::unix::fs::symlink(&behind, sessions.join("--linked--")).unwrap();
        assert_eq!(
            pi_session_ref(&sessions, id),
            id,
            "a symlinked folder is skipped"
        );
    }
    // The honest file is chosen over every newer liar.
    let honest = folder.join(format!("2026-11-17T00-00-00-000Z_{id}.jsonl"));
    std::fs::write(&honest, header(id)).unwrap();
    std::thread::sleep(std::time::Duration::from_millis(30));
    std::fs::write(name(9), header(other_id)).unwrap();
    assert_eq!(pi_session_ref(&sessions, id), honest.to_str().unwrap());
    // An id that could reach a path or a command line is not looked up.
    assert_eq!(pi_session_ref(&sessions, "../x"), "../x");
    assert_eq!(pi_session_ref(&sessions, ""), "");
}

#[test]
fn pi_names_its_upstream_in_the_model_and_resumes_by_session() {
    let dir = crate::test_dir::TestDir::new("pi-command");
    let mcp = dir.join("octiq-ask.json");
    let line = |request: AgentCommand<'_>| provider_for(AgentKind::Pi).build_command(&request);

    let bare = line(AgentCommand {
        resume: Some("pi-session-123"),
        ..pi_request(&mcp)
    });
    assert!(bare.starts_with("pi --mode rpc --session 'pi-session-123' --model 'openai-codex/gpt-5.6-terra' --thinking minimal"), "{bare}");
    assert!(!bare.contains("--provider"));

    // Claude through the Anthropic API: the model says so, as-is.
    let api = line(AgentCommand {
        model: Some("anthropic/claude-sonnet-5-5"),
        ..pi_request(&mcp)
    });
    assert!(
        api.contains("--model 'anthropic/claude-sonnet-5-5'"),
        "{api}"
    );
    assert!(!api.contains("--provider"));
    // An upstream is lower-cased; nothing else about the model changes.
    let upper = line(AgentCommand {
        model: Some("Anthropic/claude-opus-5-5"),
        ..pi_request(&mcp)
    });
    assert!(
        upper.contains("--model 'anthropic/claude-opus-5-5'"),
        "{upper}"
    );

    // No model: Pi keeps picking Codex's default, as it always did.
    let none = line(AgentCommand {
        model: None,
        ..pi_request(&mcp)
    });
    assert!(none.contains("--provider openai-codex"), "{none}");
    assert!(!none.contains("--model"));

    // A model that is not model-shaped never reaches the command line.
    for bad in ["x; id", "a/b/c", "/x", "x/", "$(id)", "a b"] {
        let refused = line(AgentCommand {
            model: Some(bad),
            ..pi_request(&mcp)
        });
        assert!(!refused.contains("--model"), "{bad}: {refused}");
        assert!(!refused.contains(bad), "{bad}: {refused}");
    }
    // The prompt and images ride stdin: a long prompt never meets
    // Windows' 32,767-character command line.
    let long = "x".repeat(100_000);
    let heavy = line(AgentCommand {
        prompt: &long,
        images: &["/tmp/screen shot.png".into()],
        ..pi_request(&mcp)
    });
    assert!(heavy.len() < 2_000, "{}", heavy.len());
    assert!(!heavy.contains("screen shot"));
}

#[test]
fn pi_tool_lists_follow_access_and_role() {
    let dir = crate::test_dir::TestDir::new("pi-tools");
    let mcp = dir.join("octiq-ask.json");
    let line = |request: AgentCommand<'_>| provider_for(AgentKind::Pi).build_command(&request);
    let read = line(pi_request(&mcp));
    assert!(
        read.contains("--tools 'read,grep,find,ls,mcp__*'"),
        "{read}"
    );
    assert!(!read.contains("bash,edit,write"));
    for access in [Access::Manual, Access::Edits, Access::Auto, Access::Full] {
        let chat = line(AgentCommand {
            access: Some(access),
            ..pi_request(&mcp)
        });
        assert!(
            chat.contains("--tools 'read,bash,edit,write,grep,find,ls,mcp__*'"),
            "{access:?}: {chat}"
        );
        // An ordinary chat keeps the person's own extensions and servers.
        assert!(!chat.contains(" -ne "), "{chat}");
    }
    // A worker below Full gets OctiqFlow's MCP tools and none of the
    // person's extensions; at Full it gets the whole set, as Claude's and
    // Codex's workers do.
    let worker = line(AgentCommand {
        access: Some(Access::Edits),
        orchestration_worker: true,
        ..pi_request(&mcp)
    });
    assert!(
        worker.contains("--tools 'read,bash,edit,write,grep,find,ls,mcp__octiq__*'"),
        "{worker}"
    );
    assert!(worker.contains(" -ne --no-mcp "), "{worker}");
    assert!(!worker.contains("builtin:mcp"), "{worker}");
    let full_worker = line(AgentCommand {
        access: Some(Access::Full),
        orchestration_worker: true,
        worker_full_tools: true,
        ..pi_request(&mcp)
    });
    assert!(full_worker.contains("mcp__*'"), "{full_worker}");
    assert!(!full_worker.contains(" -ne "), "{full_worker}");
    // A front desk is read-only whatever it was asked for, with one tool.
    let desk = line(AgentCommand {
        access: Some(Access::Full),
        front_desk: true,
        ..pi_request(&mcp)
    });
    assert!(desk.contains("--tools 'mcp__octiq__route_chat'"), "{desk}");
    assert!(desk.contains("-ne --no-mcp"));
    assert!(!desk.contains("builtin:mcp"), "{desk}");
    assert!(desk.contains("--no-skills --no-prompt-templates --no-context-files"));
}

#[test]
fn a_pi_launch_writes_its_extension_and_its_whole_system_prompt() {
    let dir = crate::test_dir::TestDir::new("pi-prepare");
    let mcp = dir.join("octiq-ask.json");
    let words = crate::personal_preferences::prompt("Reply in Malay.").unwrap();
    let (line, prompt) = pi_launch(&AgentCommand {
        access: Some(Access::Edits),
        extra_dirs: &["/repo/docs".to_string()],
        preferences: Some(&words),
        ..pi_request(&mcp)
    });
    // The extension is the one in the repository, next to the MCP files.
    let extension = std::fs::read_to_string(dir.join("pi").join("octiq-pi.ts")).unwrap();
    assert_eq!(extension, PI_EXTENSION);
    // The host's server is reached by the extension itself, never through
    // Pi's MCP registry (a configured `octiq` entry would replace it), and
    // every call says whether the tool is the extension's own.
    assert!(!extension.contains("pi.registerMcpServer("));
    assert!(extension.contains("pi.registerTool("));
    assert!(extension.contains("/hook/pi-tool"));
    assert!(extension.contains("hostServer"));
    // What Claude reads from MCP instructions and its system prompt.
    for part in [
        PI_HOST_PROMPT,
        DIAGRAM_PROMPT,
        MEDIA_PROMPT,
        READ_CONVERSATION_PROMPT,
        HISTORY_PROMPT,
        CHAT_TITLE_PROMPT,
        FEEDBACK_PROMPT,
        ORCHESTRATION_PROMPT,
        MEMORY_VAULT_PROMPT,
        DOCSPACE_PROMPT,
    ] {
        assert!(prompt.contains(part), "{part}");
    }
    assert!(prompt.contains(
        "upstream provider openai-codex; model gpt-5.6-terra; effort minimal; access edits."
    ));
    assert!(prompt.contains("/repo/docs"));
    assert!(prompt.contains("Accept edits access"));
    // The person has the last word.
    assert!(prompt.find("Docspace may contain").unwrap() < prompt.find("Reply in Malay.").unwrap());
    // Content-addressed: the same launch names the same file, a different
    // access another.
    assert!(line.contains(&format!(
        "--append-system-prompt '{}",
        dir.join("pi").join("prompts").display()
    )));
    let (again, _) = pi_launch(&AgentCommand {
        access: Some(Access::Edits),
        extra_dirs: &["/repo/docs".to_string()],
        preferences: Some(&words),
        ..pi_request(&mcp)
    });
    assert_eq!(line, again);
    let (other, _) = pi_launch(&AgentCommand {
        access: Some(Access::Manual),
        ..pi_request(&mcp)
    });
    assert_ne!(line, other);
    // The preferences are in a file, never on the command line.
    assert!(!line.contains("Reply in Malay."));
}

#[test]
fn a_pi_launch_says_what_each_access_level_does_and_never_widens_auto() {
    let dir = crate::test_dir::TestDir::new("pi-access-words");
    let mcp = dir.join("octiq-ask.json");
    for (access, words) in [
        (Access::Read, "Read-only access"),
        (Access::Manual, "Manual access"),
        (Access::Edits, "Accept edits access"),
        (Access::Auto, "Pi has no automatic safety review"),
        (Access::Full, "Full access"),
    ] {
        for worker in [false, true] {
            let (_, prompt) = pi_launch(&AgentCommand {
                access: Some(access),
                orchestration_worker: worker,
                ..pi_request(&mcp)
            });
            assert!(prompt.contains(words), "{access:?}: {prompt}");
            let can_ask = prompt.contains("call `request_access`");
            let gates = prompt.contains("`orchestration_gate_create`");
            assert_eq!(
                (can_ask, gates),
                match (access, worker) {
                    (Access::Full, _) => (false, worker),
                    (_, false) => (true, false),
                    (_, true) => (false, true),
                },
                "{access:?} worker={worker}"
            );
        }
    }
}

#[test]
fn a_front_desk_pi_is_told_only_what_it_is() {
    let dir = crate::test_dir::TestDir::new("pi-front-desk");
    let mcp = dir.join("octiq-ask.json");
    let (_, prompt) = pi_launch(&AgentCommand {
        front_desk: true,
        ..pi_request(&mcp)
    });
    assert!(
        prompt.starts_with("You are an OctiqFlow front desk."),
        "{prompt}"
    );
    assert!(!prompt.contains("octiq-diagram"));
    assert!(!prompt.contains("mcp__octiq__"));
}

#[test]
fn a_pi_launch_without_its_mcp_files_is_refused_not_run_ungated() {
    let refused = provider_for(AgentKind::Pi)
        .prepare_launch(&AgentCommand {
            mcp_config: None,
            ..codex_request(false, &[])
        })
        .unwrap_err();
    assert!(refused.contains("no approval gate"), "{refused}");
}

#[test]
fn pi_takes_prompts_images_and_stop_as_rpc_commands() {
    let pi = provider_for(AgentKind::Pi);
    let hello = pi.initialize_payload("octiq-hello-1").unwrap();
    assert_eq!(hello, json!({ "id": "octiq-hello-1", "type": "get_state" }));
    let prompt = pi.user_message_payload("hi there", &[]).unwrap();
    assert_eq!(prompt["type"], "prompt");
    assert_eq!(prompt["message"], "hi there");
    assert!(prompt["id"].as_str().unwrap().starts_with("octiq-prompt-"));
    assert!(prompt.get("images").is_none());
    let dir = crate::test_dir::TestDir::new("pi-image");
    let picture = dir.join("dot.png");
    std::fs::write(&picture, [0x89, b'P', b'N', b'G', 1, 2, 3]).unwrap();
    let with = pi
        .user_message_payload(
            "look",
            &[
                picture.to_string_lossy().into_owned(),
                "/no/such/file.png".into(),
                "/not/an/image.txt".into(),
            ],
        )
        .unwrap();
    let images = with["images"].as_array().unwrap();
    assert_eq!(images.len(), 1, "an unreadable or foreign file is left out");
    assert_eq!(images[0]["type"], "image");
    assert_eq!(images[0]["mimeType"], "image/png");
    assert!(!images[0]["data"].as_str().unwrap().is_empty());
    assert_eq!(pi.interrupt_payload().unwrap(), json!({ "type": "abort" }));
    assert!(pi.access_change_payload(Access::Auto).is_none());
}

#[test]
fn pi_rpc_answers_become_a_session_a_failed_turn_or_nothing() {
    let pi = provider_for(AgentKind::Pi);
    // The session id, spoken as JSON mode's `session` header.
    let mut state = json!({ "id": "octiq-hello-1", "type": "response", "command": "get_state", "success": true,
            "data": { "sessionId": "01a1ec71-d92b", "model": { "baseUrl": "http://x" } } });
    pi.adapt_event(&mut state);
    assert_eq!(state["type"], "session");
    assert_eq!(pi.observe_event(&state).session_id, Some("01a1ec71-d92b"));
    assert!(
        state.get("data").is_none(),
        "nothing else of the state is kept"
    );
    // A prompt Pi refused is a failed assistant message and a full stop.
    let mut refused = json!({ "id": "octiq-prompt-1", "type": "response", "command": "prompt", "success": false,
            "error": "No API key found for anthropic.\n\nUse /login" });
    pi.adapt_event(&mut refused);
    let observed = pi.observe_event(&refused);
    assert!(observed.turn_finished);
    assert_eq!(refused["message"]["stopReason"], "error");
    assert!(refused["message"]["errorMessage"]
        .as_str()
        .unwrap()
        .starts_with("No API key found for anthropic."));
    assert!(crate::outcome::of_provider_event(AgentKind::Pi, &refused).is_some());
    // Every other answer is not conversation.
    for answer in [
        json!({ "type": "response", "command": "abort", "success": true }),
        json!({ "type": "response", "command": "prompt", "success": true, "data": { "disposition": "started" } }),
    ] {
        let mut answer = answer;
        pi.adapt_event(&mut answer);
        let observed = pi.observe_event(&answer);
        assert!(observed.suppress && !observed.turn_finished && observed.session_id.is_none());
    }
}

#[test]
fn pi_says_what_needs_attention_and_cancels_dialogs_nobody_can_answer() {
    let pi = provider_for(AgentKind::Pi);
    let notice = json!({ "type": "extension_ui_request", "id": "n1", "method": "notify",
            "message": "MCP servers need attention:\n  octiq: failed: MCP connection closed\nRun /mcp to fix.", "notifyType": "warning" });
    let observed = pi.observe_event(&notice);
    assert!(observed.suppress);
    assert!(observed.host_notice.unwrap().contains("octiq: failed"));
    assert!(observed.cancel_ui_request.is_none());
    for method in ["select", "confirm", "input", "editor"] {
        let dialog = json!({ "type": "extension_ui_request", "id": "d1", "method": method });
        let observed = pi.observe_event(&dialog);
        assert!(observed.suppress, "{method}");
        assert_eq!(observed.cancel_ui_request, Some("d1"), "{method}");
    }
    let status = json!({ "type": "extension_ui_request", "id": "s1", "method": "setStatus" });
    let observed = pi.observe_event(&status);
    assert!(
        observed.suppress && observed.cancel_ui_request.is_none() && observed.host_notice.is_none()
    );
}

#[test]
fn a_pi_turn_ends_once_on_agent_settled_and_nothing_else_ends_it() {
    let pi = provider_for(AgentKind::Pi);
    for (name, event) in [
        (
            "agent_end",
            json!({ "type": "agent_end", "willRetry": false, "messages": [] }),
        ),
        (
            "agent_end with no willRetry",
            json!({ "type": "agent_end" }),
        ),
        ("turn_end", json!({ "type": "turn_end" })),
        (
            "message_end",
            json!({ "type": "message_end", "message": { "role": "assistant", "content": [] } }),
        ),
    ] {
        assert!(!pi.observe_event(&event).turn_finished, "{name}");
    }
    for aborted in [false, true] {
        assert!(
            pi.observe_event(&json!({ "type": "agent_settled", "aborted": aborted }))
                .turn_finished
        );
    }
    // The system prompt Pi announces and the turn's closing copy are not shown.
    let system = json!({ "type": "message_start", "message": { "role": "system", "content": "" } });
    assert!(pi.observe_event(&system).suppress);
    let user = json!({ "type": "message_start", "message": { "role": "user", "content": [] } });
    assert!(!pi.observe_event(&user).suppress);
    // `agent_end` keeps only what says whether the last call failed.
    let mut end = json!({ "type": "agent_end", "willRetry": false, "messages": [
        { "role": "system", "content": "huge" },
        { "role": "assistant", "stopReason": "error", "errorMessage": "429 rate limit", "content": [{"type":"text","text":"big"}] },
    ]});
    pi.adapt_event(&mut end);
    assert_eq!(end["messages"].as_array().unwrap().len(), 1);
    assert_eq!(end["messages"][0]["stopReason"], "error");
    assert!(end["messages"][0].get("content").is_none());
    assert!(crate::auto_resume::is_quota_failure(
        AgentKind::Pi,
        &json!({ "type": "message_end", "message": { "role": "assistant", "stopReason": "error", "errorMessage": "429 rate limit" } })
    ));
}

const PI_RPC_TURN: &str = include_str!("../../web/src/lib/__fixtures__/pi-rpc-turn.jsonl");
const PI_RPC_ABORT: &str = include_str!("../../web/src/lib/__fixtures__/pi-rpc-abort.jsonl");
const PI_RPC_NO_LOGIN: &str = include_str!("../../web/src/lib/__fixtures__/pi-rpc-no-login.jsonl");
const PI_RPC_MCP_FAILURE: &str =
    include_str!("../../web/src/lib/__fixtures__/pi-rpc-mcp-failure.jsonl");

/// What the reader does with each line of a recorded stream: adapt, then
/// observe. Answers the stream as it is shown, and what each line meant.
fn through_the_reader(stream: &str) -> Vec<(Value, bool, bool, Option<String>, Option<String>)> {
    let pi = provider_for(AgentKind::Pi);
    stream
        .lines()
        .filter(|line| !line.trim().is_empty())
        .map(|line| {
            let mut event: Value = serde_json::from_str(line).expect("a recorded line");
            pi.adapt_event(&mut event);
            let seen = pi.observe_event(&event);
            (
                event.clone(),
                seen.suppress,
                seen.turn_finished,
                seen.session_id.map(str::to_string),
                seen.host_notice.map(str::to_string),
            )
        })
        .collect()
}

/// Real `pi --mode rpc` 1.5.2 streams from `scripts/test-pi-harness.mjs`,
/// verbatim; the web tests read the same files. Four prompts and four full
/// stops, whatever `agent_end`, `turn_end` and the answers say.
#[test]
fn recorded_pi_rpc_streams_end_each_prompt_exactly_once() {
    let turn = through_the_reader(PI_RPC_TURN);
    assert_eq!(turn.iter().filter(|(_, _, done, ..)| *done).count(), 4);
    assert_eq!(
        turn.iter()
            .filter_map(|(.., session, _)| session.clone())
            .count(),
        1,
        "the session id comes from the get_state answer"
    );
    // Answers, the system prompt's messages and the turn copies are not shown.
    for (event, suppressed, ..) in &turn {
        let kind = event["type"].as_str().unwrap_or("");
        let system = event.pointer("/message/role").and_then(Value::as_str) == Some("system");
        let hidden = matches!(kind, "response" | "turn_end" | "extension_ui_request")
            || (system && matches!(kind, "message_start" | "message_end"));
        assert_eq!(*suppressed, hidden, "{kind}: {event}");
    }
    // The last agent_end carries no message bodies, only the stop reasons.
    for (event, ..) in turn.iter().filter(|(e, ..)| e["type"] == "agent_end") {
        for message in event["messages"].as_array().unwrap() {
            assert!(message.get("content").is_none(), "{message}");
        }
    }
    // A full stop is `agent_settled` and nothing before it.
    for (event, _, done, ..) in &turn {
        assert_eq!(*done, event["type"] == "agent_settled", "{event}");
    }

    let abort = through_the_reader(PI_RPC_ABORT);
    let stops: Vec<_> = abort.iter().filter(|(_, _, done, ..)| *done).collect();
    assert_eq!(stops.len(), 2);
    assert_eq!(stops[0].0["aborted"], true);
    let types: Vec<&str> = abort
        .iter()
        .filter_map(|(e, ..)| e["type"].as_str())
        .collect();
    assert!(
        types.iter().position(|t| *t == "agent_end")
            < types.iter().position(|t| *t == "agent_settled"),
        "agent_end precedes the full stop"
    );
}

#[test]
fn a_recorded_pi_prompt_with_no_login_is_a_failed_turn_and_a_recorded_mcp_failure_a_notice() {
    let refused = through_the_reader(PI_RPC_NO_LOGIN);
    assert_eq!(refused.len(), 1);
    let (event, suppressed, done, ..) = &refused[0];
    assert!(!suppressed && *done, "{event}");
    assert_eq!(event["octiq_rejected_prompt"], true);
    assert_eq!(event["message"]["stopReason"], "error");
    assert!(event["message"]["errorMessage"]
        .as_str()
        .unwrap()
        .starts_with("No API key found for anthropic."));
    assert!(crate::outcome::of_provider_event(AgentKind::Pi, event).is_some());

    let broken = through_the_reader(PI_RPC_MCP_FAILURE);
    let notices: Vec<_> = broken
        .iter()
        .filter_map(|(.., notice)| notice.clone())
        .collect();
    assert_eq!(notices.len(), 1, "{broken:?}");
    assert!(
        notices[0].contains("MCP servers need attention"),
        "{}",
        notices[0]
    );
    assert!(notices[0].contains("octiq"), "{}", notices[0]);
}

#[test]
fn a_pi_login_that_is_missing_is_said_with_the_way_out() {
    let words = PiProvider::rejection_words(
        "No API key found for anthropic.\n\nUse /login to log into a provider",
        Some("anthropic/claude-opus-5-5"),
    );
    assert!(words.contains("pi auth login anthropic"), "{words}");
    assert!(words.contains("--api-key"));
    let codex = PiProvider::rejection_words("No API key found for openai-codex.", None);
    assert!(codex.contains("pi auth login openai-codex"), "{codex}");
    let other = PiProvider::rejection_words("Model not found: nope/x", None);
    assert!(
        other.starts_with("pi.dev did not take the turn:"),
        "{other}"
    );
}

const PI_RPC_ERROR_RECOVERED: &str =
    include_str!("../../web/src/lib/__fixtures__/pi-rpc-error-recovered.jsonl");

/// What the reader does with `turn_opened` and `turn_finished`: a turn
/// opens only when the session reads idle (`agent_chat`:
/// `observed.turn_opened && !busy`). With `host_writes_prompts` the host
/// marks the session busy at each recorded `prompt` command, as writing
/// one does; without it nobody wrote a prompt and Pi started every run.
fn pi_turns_opened(stream: &str, host_writes_prompts: bool) -> usize {
    let mut busy = false;
    let pi = provider_for(AgentKind::Pi);
    let mut opened = 0;
    for line in stream.lines().filter(|l| !l.trim().is_empty()) {
        let mut event: Value = serde_json::from_str(line).expect("a recorded line");
        // The host marks the session busy when it WRITES a prompt, which
        // is before Pi's answer to that command and before its first run.
        if host_writes_prompts
            && event.get("type").and_then(Value::as_str) == Some("response")
            && event.get("command").and_then(Value::as_str) == Some("prompt")
        {
            busy = true;
        }
        pi.adapt_event(&mut event);
        let seen = pi.observe_event(&event);
        if seen.turn_opened && !busy {
            opened += 1;
            busy = true;
        }
        if seen.turn_finished {
            busy = false;
        }
    }
    opened
}

/// M4: a run Pi starts by itself after a settled turn (a person's own
/// extension sending a message) must read as a turn in flight, or a send
/// goes straight to a Pi that refuses it and the idle reaper ends the chat.
#[test]
fn pi_agent_start_opens_a_turn_and_the_host_never_opens_one_twice() {
    let pi = provider_for(AgentKind::Pi);
    assert!(
        pi.observe_event(&json!({ "type": "agent_start" }))
            .turn_opened
    );
    for other in [
        json!({ "type": "turn_start" }),
        json!({ "type": "turn_end" }),
        json!({ "type": "agent_end", "messages": [] }),
        json!({ "type": "agent_settled", "aborted": false }),
        json!({ "type": "message_start", "message": { "role": "user", "content": [] } }),
        json!({ "type": "auto_retry_start", "attempt": 1 }),
    ] {
        assert!(!pi.observe_event(&other).turn_opened, "{other}");
    }
    // A turn the host wrote the prompt for: the session is busy already,
    // so nothing opens, retries inside the turn included (real pi 1.5.2).
    for stream in [PI_RPC_TURN, PI_RPC_ABORT, PI_RPC_ERROR_RECOVERED] {
        assert_eq!(pi_turns_opened(stream, true), 0);
    }
    // The same streams with nobody having written a prompt: Pi started
    // every turn itself and each opens exactly once, however many runs it
    // took (the recovered one has two runs, a retry, and is one turn; the
    // other streams hold four and two turns).
    assert_eq!(pi_turns_opened(PI_RPC_ERROR_RECOVERED, false), 1);
    assert_eq!(pi_turns_opened(PI_RPC_ABORT, false), 2);
    assert_eq!(pi_turns_opened(PI_RPC_TURN, false), 4);
}

/// Feedback 5fd9b781 / 4c7f5647: the turn Claude opens by itself after a
/// background `task_notification` is announced by `init`, as every turn is.
#[test]
fn claude_init_opens_a_turn_and_nothing_else_does() {
    let claude = provider_for(AgentKind::Claude);
    let init = json!({ "type": "system", "subtype": "init", "session_id": "s-1" });
    let opened = claude.observe_event(&init);
    assert!(opened.turn_opened);
    assert_eq!(opened.session_id, Some("s-1"));
    for other in [
        json!({ "type": "system", "subtype": "task_notification", "task_id": "b1" }),
        json!({ "type": "system", "subtype": "status" }),
        json!({ "type": "result", "result": "done" }),
    ] {
        assert!(!claude.observe_event(&other).turn_opened, "{other}");
    }
}

#[test]
fn event_contract_normalizes_different_full_stops() {
    let claude_event = json!({
        "type": "result",
        "result": "done",
    });
    let claude = provider_for(AgentKind::Claude).observe_event(&claude_event);
    assert!(claude.turn_finished);
    assert_eq!(claude.final_text, Some("done"));

    let codex_message = json!({
        "type": "item.completed",
        "item": { "type": "agent_message", "text": "done" },
    });
    let carried = provider_for(AgentKind::Codex).observe_event(&codex_message);
    assert_eq!(carried.spoken_text, Some("done"));
    let completed_event = json!({
        "type": "turn.completed",
    });
    let completed = provider_for(AgentKind::Codex).observe_event(&completed_event);
    assert!(completed.turn_finished);

    let pi_session = json!({ "type": "session", "id": "pi-session" });
    let opened = provider_for(AgentKind::Pi).observe_event(&pi_session);
    assert_eq!(opened.session_id, Some("pi-session"));
    let pi_message = json!({
        "type": "message_end",
        "message": {
            "role": "assistant",
            "content": [{ "type": "text", "text": "done through Pi" }]
        }
    });
    let carried = provider_for(AgentKind::Pi).observe_event(&pi_message);
    assert_eq!(carried.spoken_text, Some("done through Pi"));
    let pi_settled = json!({ "type": "agent_settled" });
    let pi_completed = provider_for(AgentKind::Pi).observe_event(&pi_settled);
    assert!(pi_completed.turn_finished);
}

/// The person's preferences end every provider's system prompt — the
/// front desk's and a clean chat's too — and nothing changes without them.
#[test]
fn every_provider_carries_the_persons_preferences() {
    let words = crate::personal_preferences::prompt("Reply in Malay.").unwrap();
    let prefs = Some(words.as_str());
    let quoted = sh_quote(&words);
    let claude = |front_desk: bool, mcp: Option<&'static Path>, preferences| {
        provider_for(AgentKind::Claude).build_command(&AgentCommand {
            mcp_config: mcp,
            front_desk,
            preferences,
            ..codex_request(false, &[])
        })
    };
    let mcp = Some(Path::new("octiq-ask.json"));

    let chat = claude(false, mcp, prefs);
    assert_eq!(chat.matches("--append-system-prompt").count(), 1, "{chat}");
    assert!(chat.contains("Reply in Malay."), "{chat}");
    // After the host's own rules, so the person has the last word.
    assert!(chat.find("Docspace may contain").unwrap() < chat.find("Reply in Malay.").unwrap());
    assert!(!claude(false, mcp, None).contains("personal preferences"));

    let desk = claude(true, mcp, prefs);
    let system = desk.split("--system-prompt ").nth(1).unwrap();
    assert!(
        system.contains("You are an OctiqFlow front desk."),
        "{desk}"
    );
    assert!(system.contains("Reply in Malay."), "{desk}");

    // No OctiqFlow MCP at all: the preferences still go in, on their own.
    let bare = claude(false, None, prefs);
    assert!(
        bare.contains(&format!("--append-system-prompt {quoted}")),
        "{bare}"
    );

    // Pi reads them from the file its launch writes, last in the prompt.
    let dir = crate::test_dir::TestDir::new("pi-preferences");
    let pi_mcp = dir.join("octiq-ask.json");
    let (line, prompt) = pi_launch(&AgentCommand {
        preferences: prefs,
        mcp_config: Some(&pi_mcp),
        ..codex_request(false, &[])
    });
    assert!(prompt.contains("Reply in Malay."));
    assert!(prompt.find("Docspace may contain").unwrap() < prompt.find("Reply in Malay.").unwrap());
    assert!(!line.contains("Reply in Malay."), "{line}");
    let (_, desk) = pi_launch(&AgentCommand {
        preferences: prefs,
        mcp_config: Some(&pi_mcp),
        ..codex_request(true, &[])
    });
    assert!(
        desk.starts_with("You are an OctiqFlow front desk."),
        "{desk}"
    );
    assert!(desk.contains("Reply in Malay."), "{desk}");

    let exec = codex_exec_command(
        &AgentCommand {
            preferences: prefs,
            ..codex_request(false, &[])
        },
        &CODEX,
    );
    assert!(exec.contains("developer_instructions="), "{exec}");
    assert!(exec.contains("Reply in Malay."), "{exec}");
    let desk_exec = codex_exec_command(
        &AgentCommand {
            preferences: prefs,
            ..codex_request(true, &[])
        },
        &CODEX,
    );
    assert!(desk_exec.contains("Reply in Malay."), "{desk_exec}");

    for role in [
        AntigravityRole::Chat(Access::Edits),
        AntigravityRole::Worker(Access::Auto),
        AntigravityRole::FrontDesk,
    ] {
        let rules = antigravity_rules_with(role, prefs);
        assert!(rules.ends_with("Reply in Malay.\n"), "{rules}");
        assert!(rules.starts_with(&antigravity_rules(role).trim_end().to_string()));
        let plain = antigravity_rules_with(role, None);
        assert!(plain.ends_with('\n') && !plain.contains("Reply in Malay."));
    }
    assert_eq!(
        antigravity_rules_with(AntigravityRole::Chat(Access::Edits), None),
        antigravity_rules(AntigravityRole::Chat(Access::Edits)),
        "without preferences the plugin file is unchanged, so nothing is rewritten"
    );

    assert_eq!(with_preferences("host", None), "host");
    assert_eq!(with_preferences("host\n\n", Some("  ")), "host\n\n");
    assert_eq!(with_preferences("host\n", Some("mine")), "host\n\nmine");
    assert_eq!(with_preferences("", Some("mine")), "mine");
}

fn agy_request<'a>(access: Option<Access>, mcp: Option<&'a Path>) -> AgentCommand<'a> {
    AgentCommand {
        model: Some("gemini-3.8-flash-high"),
        access,
        effort: Some("high"),
        mcp_config: mcp,
        ..request("fix it")
    }
}

#[test]
fn antigravity_keeps_one_stream_json_process_with_its_own_flags() {
    let dirs = ["/repo/other side".to_owned(), "/repo/docs".to_owned()];
    let line = ANTIGRAVITY.build_command(&AgentCommand {
        resume: Some("bb35e2e1-d2c3-4b8b-913d-7554783273ff"),
        extra_dirs: &dirs,
        sandbox_roots: &[],
        ..agy_request(Some(Access::Full), None)
    });
    assert!(
        line.starts_with("agy --input-format stream-json --output-format stream-json"),
        "{line}"
    );
    assert!(line.contains(" --conversation 'bb35e2e1-d2c3-4b8b-913d-7554783273ff'"));
    assert!(line.contains(" --model 'gemini-3.8-flash-high'"));
    assert!(line.contains(" --dangerously-skip-permissions"));
    assert!(line.contains(" --add-dir '/repo/other side' --add-dir '/repo/docs'"));
    // The prompt goes down stdin: `-p` is dropped in streaming mode.
    assert!(!line.contains("fix it") && !line.contains(" -p"), "{line}");

    // A model or conversation id that is not a plain token never reaches
    // the shell, and a first turn resumes nothing.
    let first = ANTIGRAVITY.build_command(&AgentCommand {
        model: Some("flash; rm -rf ~"),
        resume: Some("x' --dangerously-skip-permissions"),
        ..agy_request(Some(Access::Edits), None)
    });
    assert!(!first.contains("--conversation"), "{first}");
    assert!(!first.contains("--model"), "{first}");
    assert!(!first.contains("--dangerously"), "{first}");

    // The person's words are one NDJSON line of text blocks; an image is
    // named by its path, since Antigravity takes text blocks only.
    let images = ["/tmp/shot one.png".to_owned()];
    let payload = ANTIGRAVITY
        .user_message_payload("what is this?", &images)
        .unwrap();
    assert_eq!(
        payload,
        json!({ "event": "user", "message": { "content": [
                { "type": "text", "text": "[Attached image: /tmp/shot one.png]" },
                { "type": "text", "text": "what is this?" },
            ] } })
    );
    assert!(ANTIGRAVITY.interrupt_payload().is_none());
    assert!(ANTIGRAVITY.access_change_payload(Access::Full).is_none());
}

#[test]
fn antigravity_maps_each_access_level_to_its_mode() {
    let flags = |access| ANTIGRAVITY.build_command(&agy_request(access, None));
    assert!(flags(Some(Access::Read)).contains(" --mode plan"));
    let manual = flags(Some(Access::Manual));
    assert!(
        !manual.contains("--mode ") && !manual.contains("--dangerously"),
        "{manual}"
    );
    assert!(flags(Some(Access::Edits)).contains(" --mode accept-edits"));
    // Auto has no guarded form here (see `antigravity_access_flag`).
    assert!(flags(Some(Access::Auto)).contains(" --dangerously-skip-permissions"));
    assert!(flags(Some(Access::Full)).contains(" --dangerously-skip-permissions"));
    // Unset is the most cautious, as `OCTIQ_ACCESS` is.
    assert!(flags(None).contains(" --mode plan"));
    for access in [Access::Read, Access::Manual, Access::Edits] {
        assert!(!flags(Some(access)).contains("--dangerously"), "{access:?}");
    }
    for access in Access::ALL_FOR_TESTS {
        assert!(!flags(Some(access)).contains("--sandbox"), "{access:?}");
    }
}

/// Antigravity refuses `--effort` beside a model id that names its own
/// level, and beside its Claude and GPT ids (live, agy 1.2.16):
/// `--model gemini-3.8-flash-low --effort max` "conflicts", and
/// `--model claude-sonnet-4-6 --effort high` "is not supported".
#[test]
fn antigravity_passes_effort_only_where_the_model_takes_one() {
    let with = |model: Option<&'static str>| {
        ANTIGRAVITY.build_command(&AgentCommand {
            model,
            ..agy_request(Some(Access::Edits), None)
        })
    };
    for model in [
        "gemini-3.8-flash-high",
        "gemini-3.1-pro-low",
        "claude-sonnet-4-6",
        "claude-opus-4-6-thinking",
        "gpt-oss-120b-medium",
    ] {
        assert!(!with(Some(model)).contains("--effort"), "{model}");
    }
    assert!(with(Some("gemini-3.8-flash")).contains(" --effort high"));
    assert!(with(None).contains(" --effort high"));
    assert_eq!(ANTIGRAVITY.effort("max"), Some("max"));
    assert_eq!(ANTIGRAVITY.effort("ultracode"), None);
}

#[test]
fn antigravity_gets_octiqflows_plugin_through_an_added_folder() {
    let mcp = Path::new("/home/me/.octiqflow/mcp/octiq-ask.json");
    let plugin_arg = |role: &str| {
        sh_quote(
            &Path::new("/home/me/.octiqflow/mcp")
                .join("antigravity")
                .join(role)
                .to_string_lossy(),
        )
    };
    let chat = ANTIGRAVITY.build_command(&agy_request(Some(Access::Edits), Some(mcp)));
    assert!(
        chat.ends_with(&format!(" --add-dir {}", plugin_arg("chat-edits"))),
        "{chat}"
    );
    let worker = ANTIGRAVITY.build_command(&AgentCommand {
        orchestration_worker: true,
        ..agy_request(Some(Access::Edits), Some(mcp))
    });
    assert!(worker.contains(&format!(" --add-dir {}", plugin_arg("worker-edits"))));
    // Unset is Read, in the folder name as in the flag.
    let unset = ANTIGRAVITY.build_command(&agy_request(None, Some(mcp)));
    assert!(
        unset.contains(" --mode plan") && unset.ends_with(&plugin_arg("chat-read")),
        "{unset}"
    );
    // A front desk is read-only, gets no folder of the chat's, and none
    // of the person's slash commands.
    let dirs = ["/repo".to_owned()];
    let desk = ANTIGRAVITY.build_command(&AgentCommand {
        front_desk: true,
        extra_dirs: &dirs,
        sandbox_roots: &[],
        ..agy_request(Some(Access::Full), Some(mcp))
    });
    assert!(desk.contains(" --mode plan"), "{desk}");
    assert!(!desk.contains("'/repo'"), "{desk}");
    assert!(desk.contains(&format!(" --add-dir {}", plugin_arg("front-desk"))));
    assert!(desk.ends_with(" --disable-slash-commands"), "{desk}");
    // No MCP config, no plugin and nothing to prepare.
    let bare = ANTIGRAVITY.build_command(&agy_request(Some(Access::Edits), None));
    assert!(!bare.contains("antigravity/"), "{bare}");
    assert!(ANTIGRAVITY
        .prepare_launch(&agy_request(Some(Access::Edits), None))
        .is_ok());

    // The plugin: OctiqFlow's server under the name its rule allows, and
    // the host rules every chat follows; a worker's carry its protocol.
    let files = antigravity_plugin_files(
        Path::new("/home/me/.octiqflow/mcp/octiq-ask.cjs"),
        AntigravityRole::Worker(Access::Auto),
        None,
    );
    let file = |name: &str| {
        files
            .iter()
            .find(|(path, _)| path == &format!(".agents/plugins/octiqflow/{name}"))
            .map(|(_, body)| String::from_utf8(body.clone()).unwrap())
            .unwrap_or_else(|| panic!("{name}"))
    };
    assert_eq!(
        serde_json::from_str::<Value>(&file("plugin.json")).unwrap(),
        json!({ "name": "octiqflow" })
    );
    assert_eq!(
        serde_json::from_str::<Value>(&file("mcp_config.json")).unwrap(),
        json!({ "mcpServers": { "octiq": {
                "command": "node",
                "args": ["/home/me/.octiqflow/mcp/octiq-ask.cjs"],
            } } })
    );
    let rules = file("rules/AGENTS.md");
    assert!(rules.contains("`octiqflow_octiq`"));
    assert!(rules.contains("`orchestration_worker_report`"));
    assert!(rules.contains("call the `ask_user` tool"));
    assert!(ANTIGRAVITY_MCP_RULE.starts_with("mcp(octiqflow_octiq/"));
    assert!(rules.contains("This chat runs at Auto access: every call runs without asking"));
    assert!(!antigravity_rules(AntigravityRole::Chat(Access::Edits))
        .contains("This chat is an OctiqFlow orchestration worker"));
    assert_eq!(
        antigravity_rules(AntigravityRole::FrontDesk),
        FRONT_DESK_PROMPT
    );
}

/// The card diagram is one paragraph, said the same way wherever a chat
/// agent gets its host rules, and never to a front desk, which writes no
/// reply of that kind.
#[test]
fn every_chat_agent_is_told_the_card_diagram_in_the_same_words() {
    // The MCP server's instructions hold the paragraph word for word.
    // That is where Claude reads it, over stdio.
    assert!(ASK_MCP.contains(DIAGRAM_PROMPT));
    // No command line carries it: not Claude's appended prompt, and not
    // the instructions `codex exec` takes as an argument.
    for kind in [AgentKind::Claude, AgentKind::Codex, AgentKind::Pi] {
        let line = command(kind, Some(Path::new("/tmp/octiq-ask.json")));
        assert!(!line.contains("octiq-diagram"), "{line}");
    }
    let said = |app_server: bool| {
        codex_developer_instructions(
            Some("model-x"),
            Some("high"),
            Some(Access::Auto),
            None,
            app_server,
            false,
        )
    };
    // Codex's app-server takes its instructions as a message on stdin.
    assert!(said(true).contains(DIAGRAM_PROMPT));
    assert!(!said(false).contains("octiq-diagram"));
    assert!(antigravity_rules(AntigravityRole::Chat(Access::Auto)).contains(DIAGRAM_PROMPT));
    assert!(antigravity_rules(AntigravityRole::Worker(Access::Auto)).contains(DIAGRAM_PROMPT));
    assert!(!antigravity_rules(AntigravityRole::FrontDesk).contains("octiq-diagram"));
    assert!(!FRONT_DESK_PROMPT.contains("octiq-diagram"));
    // Short all the same: every chat reads it at every launch.
    assert!(DIAGRAM_PROMPT.chars().count() <= 760);
    assert!(DIAGRAM_PROMPT.is_ascii());
    // One line, and nothing a POSIX or a JavaScript quote has to escape.
    assert!(!DIAGRAM_PROMPT.contains(['\n', '\'', '\\']));
}

#[test]
fn every_chat_agent_is_told_the_media_block_in_the_same_words() {
    // The MCP server's instructions hold the paragraph word for word.
    // That is where Claude reads it, over stdio.
    assert!(ASK_MCP.contains(MEDIA_PROMPT));
    // No command line carries it: not Claude's appended prompt, and not
    // the instructions `codex exec` takes as an argument.
    for kind in [AgentKind::Claude, AgentKind::Codex, AgentKind::Pi] {
        let line = command(kind, Some(Path::new("/tmp/octiq-ask.json")));
        assert!(!line.contains("octiq-media"), "{line}");
    }
    let said = |app_server: bool| {
        codex_developer_instructions(
            Some("model-x"),
            Some("high"),
            Some(Access::Auto),
            None,
            app_server,
            false,
        )
    };
    // Codex's app-server takes its instructions as a message on stdin.
    assert!(said(true).contains(MEDIA_PROMPT));
    assert!(!said(false).contains("octiq-media"));
    assert!(antigravity_rules(AntigravityRole::Chat(Access::Auto)).contains(MEDIA_PROMPT));
    assert!(antigravity_rules(AntigravityRole::Worker(Access::Auto)).contains(MEDIA_PROMPT));
    assert!(!antigravity_rules(AntigravityRole::FrontDesk).contains("octiq-media"));
    assert!(!FRONT_DESK_PROMPT.contains("octiq-media"));
    // Short all the same: every chat reads it at every launch.
    assert!(MEDIA_PROMPT.chars().count() <= 560);
    assert!(MEDIA_PROMPT.is_ascii());
    // One line, and nothing a POSIX or a JavaScript quote has to escape.
    assert!(!MEDIA_PROMPT.contains(['\n', '\'', '\\']));
}

#[test]
fn the_antigravity_plugin_is_written_once_and_a_failure_names_its_path() {
    let root = crate::test_dir::TestDir::new("agy");
    let mcp = root.join("mcp").join("octiq-ask.json");
    std::fs::create_dir_all(mcp.parent().unwrap()).unwrap();
    write_antigravity_plugin(&mcp, AntigravityRole::Chat(Access::Edits), None).unwrap();
    let manifest =
        root.join("mcp/antigravity/chat-edits/.agents/plugins/octiqflow/mcp_config.json");
    let written: Value = serde_json::from_slice(&std::fs::read(&manifest).unwrap()).unwrap();
    assert_eq!(
        written["mcpServers"]["octiq"]["args"][0],
        json!(root.join("mcp").join("octiq-ask.cjs").to_string_lossy())
    );
    // Unchanged content is not rewritten.
    let before = std::fs::metadata(&manifest).unwrap().modified().unwrap();
    std::thread::sleep(std::time::Duration::from_millis(20));
    write_antigravity_plugin(&mcp, AntigravityRole::Chat(Access::Edits), None).unwrap();
    assert_eq!(
        std::fs::metadata(&manifest).unwrap().modified().unwrap(),
        before
    );

    // A folder that cannot be made refuses the launch, naming the file.
    let blocked = root.join("blocked").join("octiq-ask.json");
    std::fs::create_dir_all(blocked.parent().unwrap()).unwrap();
    std::fs::write(root.join("blocked").join("antigravity"), "a file").unwrap();
    let why =
        write_antigravity_plugin(&blocked, AntigravityRole::Chat(Access::Edits), None).unwrap_err();
    let plugin_file = blocked
        .parent()
        .unwrap()
        .join("antigravity")
        .join("chat-edits")
        .join(".agents")
        .join("plugins")
        .join("octiqflow")
        .join("plugin.json");
    let named_path = why
        .strip_prefix("OctiqFlow's Antigravity plugin could not be written to ")
        .and_then(|rest| rest.split_once(": "))
        .map(|(path, _)| Path::new(path))
        .unwrap_or_else(|| panic!("{why}"));
    // The plugin's relative filename uses forward slashes even when its
    // parent is a native Windows path. Compare path components, not text.
    assert_eq!(named_path, plugin_file.as_path(), "{why}");
}

/// The same folding the chat runtime's reader does, over the real stream.
#[test]
fn antigravity_streams_name_their_conversation_and_stop_each_turn() {
    let mut session = None;
    let mut said = Vec::new();
    for event in agy_events(AGY_THREE_TURNS) {
        let observed = ANTIGRAVITY.observe_event(&event);
        if let Some(id) = observed.session_id {
            session = Some(id.to_owned());
        }
        if observed.turn_finished {
            said.push(observed.final_text.map(str::to_owned));
        }
    }
    assert_eq!(
        session.as_deref(),
        Some("bb35e2e1-d2c3-4b8b-913d-7554783273ff")
    );
    assert_eq!(said.len(), 3, "one full stop per turn");
    assert!(said[0].as_deref().is_some_and(|text| text.contains("4471")));
    // The refused command ended its turn with nothing said.
    assert_eq!(said[1], None);
    assert_eq!(said[2].as_deref(), Some("HERON\n"));

    // A failure before any turn stops all the same, and says why; it
    // names no conversation, so nothing is kept to resume.
    let bad = agy_events(AGY_BAD_MODEL);
    let observed = ANTIGRAVITY.observe_event(&bad[0]);
    assert!(observed.turn_finished);
    assert!(observed.session_id.is_none());
    assert!(observed
        .final_text
        .is_some_and(|why| why.contains("gemini-0-nonexistent is not recognized")));
    let stopped = agy_events(AGY_INTERRUPTED);
    let last = ANTIGRAVITY.observe_event(stopped.last().unwrap());
    assert!(last.turn_finished);
    assert_eq!(last.final_text, Some("interrupted"));
}

#[test]
fn antigravity_tolerates_events_and_lines_it_does_not_know() {
    for unknown in [
        json!({ "event": "checkpoint" }),
        json!({ "event": "step_update", "step_update": { "step_type": "system_message" } }),
        json!({ "event": "init" }),
        json!({ "type": "result", "result": "a Claude result is not ours" }),
        json!("not an object"),
    ] {
        let observed = ANTIGRAVITY.observe_event(&unknown);
        assert!(observed.session_id.is_none(), "{unknown}");
        assert!(!observed.turn_finished, "{unknown}");
    }
    let notice = "jetski: no output produced — a tool required the \"command\" permission that headless mode cannot prompt for, so it was auto-denied.";
    assert_eq!(
        ANTIGRAVITY.output_disposition(notice),
        OutputDisposition::DiagnosticsOnly
    );
    assert_eq!(
        ANTIGRAVITY.output_disposition("error: invalid model selection"),
        OutputDisposition::Visible
    );
    assert_eq!(
        ANTIGRAVITY.output_disposition("  --add-dir   Add a directory"),
        OutputDisposition::DiagnosticsOnly
    );
    assert_eq!(
        ANTIGRAVITY.output_disposition("Some new status line"),
        OutputDisposition::Visible
    );
}

#[test]
fn a_refused_antigravity_turn_names_the_access_that_refused_it() {
    let events = agy_events(AGY_THREE_TURNS);
    let mut results: Vec<Value> = events
        .into_iter()
        .filter(|e| e["event"] == "result")
        .collect();
    for result in &mut results {
        mark_refusal_access(AgentKind::Antigravity, result, Some(Access::Edits));
    }
    assert!(results[0].get("octiq_access").is_none(), "nothing refused");
    assert_eq!(results[1]["octiq_access"], json!("edits"));
    let mut unset = results[1].clone();
    mark_refusal_access(AgentKind::Antigravity, &mut unset, None);
    assert_eq!(unset["octiq_access"], json!("read"));
    // Another provider's events are left alone.
    let mut claude = json!({ "event": "result", "result": { "denied_actions": [{}] } });
    mark_refusal_access(AgentKind::Claude, &mut claude, Some(Access::Edits));
    assert!(claude.get("octiq_access").is_none());
}
