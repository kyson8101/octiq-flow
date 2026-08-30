//! The contract between OctiqFlow's chat runtime and the CLI agents it starts.
//!
//! A chat is deliberately provider-agnostic: it has a selected `AgentKind`, a
//! model, a prompt, folders, and an access level. Claude Code and Codex turn
//! that shared request into very different processes, however. Claude keeps a
//! JSON conversation on stdin; Codex starts one `exec --json` process per turn.
//! Claude has a control channel; Codex puts its sandbox and approval policy on
//! the command line. Keeping those distinctions in the chat manager spread
//! provider checks through session startup, input, completion, and settings.
//!
//! This module is the seam instead. `provider_for` is the one factory: callers
//! select an `AgentKind`, then work through `AgentProvider`. Adding another CLI
//! agent means implementing this contract and registering it there, without
//! teaching the chat lifecycle its command syntax or stream vocabulary.

use std::path::Path;

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

/// The stable provider ids accepted on the wire.
///
/// This is intentionally a provider/agent choice rather than a model choice.
/// `opus` and `gpt-5.6-sol` are model names *within* distinct runtimes that
/// have different process and stream contracts.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum AgentKind {
    Claude,
    Codex,
}

impl AgentKind {
    /// The order everywhere an agent picker or probe presents providers.
    pub const ALL: [Self; 2] = [Self::Claude, Self::Codex];

    /// Stable lower-case id used in JSON, session records, and command probes.
    pub const fn id(self) -> &'static str {
        match self {
            Self::Claude => "claude",
            Self::Codex => "codex",
        }
    }

    /// The executable name stays behind the provider boundary. This small
    /// compatibility convenience lets older call sites ask an agent kind for
    /// its binary without duplicating the mapping.
    pub fn bin(self) -> &'static str {
        provider_for(self).bin()
    }
}

/// How a provider receives a user's next turn after it is launched.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum InputTransport {
    /// A process stays up and accepts JSON messages on stdin.
    StreamJson,
    /// Each prompt belongs in a new command invocation; stdin must stay closed.
    CommandLine,
}

impl InputTransport {
    pub const fn accepts_stdin(self) -> bool {
        matches!(self, Self::StreamJson)
    }
}

/// Features the chat lifecycle may rely on, without knowing a provider name.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct AgentCapabilities {
    pub input: InputTransport,
    /// Whether an already-running process can change its access level.
    pub supports_live_access_change: bool,
    /// Whether the provider has an OctiqFlow-specific clean-start mode.
    pub supports_lite_mode: bool,
    /// Whether its command needs OctiqFlow's MCP config generated before spawn.
    pub uses_octiq_mcp: bool,
}

/// How much the user has allowed an agent to do without an intervention.
///
/// The value stays semantic and provider-neutral here. Each adapter maps it to
/// its own native flags, which keeps CLI spelling out of the web client and the
/// shared chat lifecycle.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Access {
    Read,
    Manual,
    Edits,
    Auto,
    Full,
}

impl Access {
    /// What the permission hook reads. This is deliberately semantic rather
    /// than a provider's native flag name.
    pub(crate) const fn as_env(self) -> &'static str {
        match self {
            Self::Read => "read",
            Self::Manual => "manual",
            Self::Edits => "edits",
            Self::Auto => "auto",
            Self::Full => "full",
        }
    }
}

/// The normalized launch request handed to every CLI adapter.
pub struct AgentCommand<'a> {
    pub model: Option<&'a str>,
    pub access: Option<Access>,
    pub prompt: &'a str,
    pub resume: Option<&'a str>,
    pub extra_dirs: &'a [String],
    pub effort: Option<&'a str>,
    pub images: &'a [String],
    pub lite: bool,
    /// OctiqFlow's MCP config when the provider has opted into it.
    pub mcp_config: Option<&'a Path>,
}

/// A provider-specific permission request normalized for the shared responder.
pub struct PermissionRequest<'a> {
    pub id: &'a str,
    pub request: &'a Value,
}

/// The small amount of a provider's raw stream the chat lifecycle needs.
///
/// The raw event is still recorded and sent to the browser untouched. These
/// fields are only lifecycle metadata: session identity, a full stop, optional
/// closing words, and the few control messages OctiqFlow itself owns.
#[derive(Default)]
pub struct AgentEvent<'a> {
    pub session_id: Option<&'a str>,
    pub turn_finished: bool,
    /// Text that must be carried until a later full-stop event.
    pub spoken_text: Option<&'a str>,
    /// Text carried directly by the full-stop event.
    pub final_text: Option<&'a str>,
    pub permission: Option<PermissionRequest<'a>>,
    pub is_initialize_response: bool,
    pub access_refusal: Option<&'a str>,
}

/// The contract each CLI runtime implements.
///
/// All methods return either a normalized value or `None` when the feature is
/// not part of that provider's protocol. The chat manager does not need a
/// Claude/Codex branch to discover that Codex has no stdin control channel.
pub trait AgentProvider: Send + Sync {
    fn kind(&self) -> AgentKind;
    fn display_name(&self) -> &'static str;
    fn bin(&self) -> &'static str;
    fn capabilities(&self) -> AgentCapabilities;

    fn build_command(&self, request: &AgentCommand<'_>) -> String;

    /// Normalize a requested effort level for this provider.
    fn effort(&self, requested: &str) -> Option<&'static str>;

    /// A startup control request, when this provider has an initialized stdin
    /// protocol. Its response is deliberately omitted from the transcript.
    fn initialize_payload(&self, _request_id: &str) -> Option<Value> {
        None
    }

    /// One persistent-stream user turn. `None` means turns belong on a command
    /// line instead of a running process.
    fn user_message_payload(&self, _text: &str, _images: &[String]) -> Option<Value> {
        None
    }

    /// Ask a running turn to stop while preserving the conversation.
    fn interrupt_payload(&self) -> Option<Value> {
        None
    }

    /// Change a running process's access level. One-shot providers pick this
    /// up on their next command instead.
    fn access_change_payload(&self, _access: Access) -> Option<Value> {
        None
    }

    /// Answer a provider-owned control request.
    fn control_response_payload(&self, _request_id: &str, _response: Value) -> Option<Value> {
        None
    }

    /// Extract lifecycle metadata from one untouched raw stream event.
    fn observe_event<'a>(&self, event: &'a Value) -> AgentEvent<'a>;

    /// Known stderr chatter that should not become a visible chat warning.
    fn is_expected_stderr(&self, _line: &str) -> bool {
        false
    }
}

struct ClaudeProvider;
struct CodexProvider;

static CLAUDE: ClaudeProvider = ClaudeProvider;
static CODEX: CodexProvider = CodexProvider;

/// The sole factory for agent-specific behavior.
pub fn provider_for(kind: AgentKind) -> &'static dyn AgentProvider {
    match kind {
        AgentKind::Claude => &CLAUDE,
        AgentKind::Codex => &CODEX,
    }
}

/// Single-quote a value for the login shell that launches an agent.
fn sh_quote(s: &str) -> String {
    format!("'{}'", s.replace('\'', r"'\''"))
}

/// One TOML basic string, quoted and escaped before it reaches Codex's parser.
fn toml_string(s: &str) -> String {
    format!("\"{}\"", s.replace('\\', r"\\").replace('"', "\\\""))
}

/// Model aliases reach a command line, so reject anything that is not a short
/// model-shaped token rather than merely escaping it.
pub(crate) fn safe_model(model: &str) -> Option<String> {
    let ok = model
        .chars()
        .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '.' || c == '_');
    if ok && !model.is_empty() && model.len() <= 64 {
        Some(model.to_string())
    } else {
        None
    }
}

/// Session ids are agent-owned identifiers that also reach a command line.
pub(crate) fn safe_session_id(id: &str) -> Option<String> {
    let ok = id.len() <= 64
        && !id.is_empty()
        && id.chars().all(|c| c.is_ascii_alphanumeric() || c == '-');
    ok.then(|| id.to_string())
}

/// The media type for an image that Claude accepts as a content block.
fn image_media_type(path: &str) -> Option<&'static str> {
    let ext = path.rsplit('.').next()?.to_ascii_lowercase();
    match ext.as_str() {
        "png" => Some("image/png"),
        "jpg" | "jpeg" => Some("image/jpeg"),
        "gif" => Some("image/gif"),
        "webp" => Some("image/webp"),
        _ => None,
    }
}

/// Read an image as Claude's inline base64 content block. An unreadable image
/// is omitted so a bad attachment never prevents the text turn from sending.
fn image_block(path: &str) -> Option<Value> {
    use base64::Engine;

    let media_type = image_media_type(path)?;
    let bytes = std::fs::read(path).ok()?;
    if bytes.is_empty() || bytes.len() > 12 * 1024 * 1024 {
        return None;
    }
    let data = base64::engine::general_purpose::STANDARD.encode(bytes);
    Some(json!({
        "type": "image",
        "source": { "type": "base64", "media_type": media_type, "data": data }
    }))
}

// Kept private in production; the former chat-runtime tests exercise these
// security-sensitive transformations while the implementations now live here.
#[cfg(test)]
pub(crate) fn test_toml_string(value: &str) -> String {
    toml_string(value)
}

#[cfg(test)]
pub(crate) fn test_sh_quote(value: &str) -> String {
    sh_quote(value)
}

#[cfg(test)]
pub(crate) fn test_image_media_type(path: &str) -> Option<&'static str> {
    image_media_type(path)
}

const ACCESS_REQUEST_ID: &str = "octiq-access-";
const HELLO_REQUEST_ID: &str = "octiq-hello-";

impl AgentProvider for ClaudeProvider {
    fn kind(&self) -> AgentKind {
        AgentKind::Claude
    }

    fn display_name(&self) -> &'static str {
        "Claude Code"
    }

    fn bin(&self) -> &'static str {
        "claude"
    }

    fn capabilities(&self) -> AgentCapabilities {
        AgentCapabilities {
            input: InputTransport::StreamJson,
            supports_live_access_change: true,
            supports_lite_mode: true,
            uses_octiq_mcp: true,
        }
    }

    fn effort(&self, requested: &str) -> Option<&'static str> {
        match requested {
            "low" => Some("low"),
            "medium" => Some("medium"),
            "high" => Some("high"),
            "xhigh" => Some("xhigh"),
            "max" => Some("max"),
            "ultracode" => Some("ultracode"),
            _ => None,
        }
    }

    fn build_command(&self, request: &AgentCommand<'_>) -> String {
        let mut cmd = String::from(
            "claude -p --output-format stream-json --input-format stream-json \\
             --include-partial-messages --replay-user-messages --verbose",
        );
        if let Some(id) = request.resume.and_then(safe_session_id) {
            cmd.push_str(&format!(" --resume {}", sh_quote(&id)));
        }
        if let Some(model) = request.model.and_then(safe_model) {
            cmd.push_str(&format!(" --model {}", sh_quote(&model)));
        }
        if let Some(access) = request.access {
            // Claude refuses a live switch TO `bypassPermissions` unless the
            // process itself was launched in bypass mode. Starting Full this
            // way makes the requested level real, and a later switch up is
            // handled by the chat runtime as a clean restart instead.
            if matches!(access, Access::Full) {
                cmd.push_str(" --dangerously-skip-permissions");
            } else {
                cmd.push_str(&format!(
                    " --permission-mode {}",
                    claude_permission_mode(access)
                ));
            }
        }
        if let Some(effort) = request.effort.and_then(|e| self.effort(e)) {
            cmd.push_str(&format!(" --effort {effort}"));
        }

        // Claude's stdio permission protocol is the channel OctiqFlow owns.
        // It also exposes AskUserQuestion, which print mode cannot answer, so
        // that built-in tool is removed in favour of OctiqFlow's MCP tool.
        cmd.push_str(" --permission-prompt-tool stdio");
        cmd.push_str(" --disallowedTools AskUserQuestion");
        if let Some(mcp) = request.mcp_config {
            cmd.push_str(&format!(
                " --mcp-config {} --allowedTools {} --append-system-prompt {}",
                sh_quote(&mcp.to_string_lossy()),
                sh_quote(
                    "mcp__octiq__ask_user mcp__octiq__todo_write \\
                     mcp__octiq__add_agent mcp__octiq__ask_agent",
                ),
                sh_quote(ASK_PROMPT),
            ));
        }
        // A clean Claude chat keeps its login and OctiqFlow's own tools while
        // dropping user/project settings, slash commands, and extra MCPs.
        if request.lite {
            cmd.push_str(" --strict-mcp-config --disable-slash-commands --setting-sources ''");
        }
        for dir in request.extra_dirs {
            cmd.push_str(&format!(" --add-dir {}", sh_quote(dir)));
        }
        cmd
    }

    fn initialize_payload(&self, request_id: &str) -> Option<Value> {
        Some(json!({
            "type": "control_request",
            "request_id": request_id,
            "request": { "subtype": "initialize" }
        }))
    }

    fn user_message_payload(&self, text: &str, images: &[String]) -> Option<Value> {
        let mut content: Vec<Value> = images.iter().filter_map(|path| image_block(path)).collect();
        content.push(json!({ "type": "text", "text": text }));
        Some(json!({
            "type": "user",
            "message": { "role": "user", "content": content }
        }))
    }

    fn interrupt_payload(&self) -> Option<Value> {
        Some(json!({
            "type": "control_request",
            "request_id": format!("int-{}", uuid::Uuid::new_v4()),
            "request": { "subtype": "interrupt" }
        }))
    }

    fn access_change_payload(&self, access: Access) -> Option<Value> {
        Some(json!({
            "type": "control_request",
            "request_id": format!("{ACCESS_REQUEST_ID}{}", uuid::Uuid::new_v4()),
            "request": {
                "subtype": "set_permission_mode",
                "mode": claude_permission_mode(access),
            }
        }))
    }

    fn control_response_payload(&self, request_id: &str, response: Value) -> Option<Value> {
        Some(json!({
            "type": "control_response",
            "response": {
                "subtype": "success",
                "request_id": request_id,
                "response": response,
            }
        }))
    }

    fn observe_event<'a>(&self, event: &'a Value) -> AgentEvent<'a> {
        let mut observed = AgentEvent::default();
        let kind = event.get("type").and_then(Value::as_str);

        if kind == Some("system") && event.get("subtype").and_then(Value::as_str) == Some("init") {
            observed.session_id = event.get("session_id").and_then(Value::as_str);
        }
        if kind == Some("result") {
            observed.turn_finished = true;
            observed.final_text = event.get("result").and_then(Value::as_str);
        }
        if kind == Some("control_request") {
            let request = event.get("request");
            if request
                .and_then(|r| r.get("subtype"))
                .and_then(Value::as_str)
                == Some("can_use_tool")
            {
                if let Some(id) = event.get("request_id").and_then(Value::as_str) {
                    if let Some(request) = request {
                        observed.permission = Some(PermissionRequest { id, request });
                    }
                }
            }
        }
        if kind == Some("control_response") {
            let response = event.get("response");
            let request_id = response
                .and_then(|r| r.get("request_id"))
                .and_then(Value::as_str);
            observed.is_initialize_response =
                request_id.is_some_and(|id| id.starts_with(HELLO_REQUEST_ID));
            if response
                .and_then(|r| r.get("subtype"))
                .and_then(Value::as_str)
                == Some("error")
                && request_id.is_some_and(|id| id.starts_with(ACCESS_REQUEST_ID))
            {
                observed.access_refusal = response
                    .and_then(|r| r.get("error"))
                    .and_then(Value::as_str);
            }
        }
        observed
    }
}

impl AgentProvider for CodexProvider {
    fn kind(&self) -> AgentKind {
        AgentKind::Codex
    }

    fn display_name(&self) -> &'static str {
        "Codex"
    }

    fn bin(&self) -> &'static str {
        "codex"
    }

    fn capabilities(&self) -> AgentCapabilities {
        AgentCapabilities {
            input: InputTransport::CommandLine,
            supports_live_access_change: false,
            supports_lite_mode: false,
            uses_octiq_mcp: false,
        }
    }

    fn effort(&self, requested: &str) -> Option<&'static str> {
        match requested {
            "low" => Some("low"),
            "medium" => Some("medium"),
            "high" => Some("high"),
            "xhigh" => Some("xhigh"),
            "max" => Some("max"),
            _ => None,
        }
    }

    fn build_command(&self, request: &AgentCommand<'_>) -> String {
        // Codex is one-shot. Continuing a conversation is a new `resume`
        // invocation, not another write to a live stdin.
        let resuming = request.resume.and_then(safe_session_id);
        let mut cmd = match &resuming {
            Some(id) => format!("codex exec resume --json {}", sh_quote(id)),
            None => String::from("codex exec --json"),
        };
        // OctiqFlow deliberately controls the process cwd, including isolated
        // room-only seats, so Codex's git-repo trust check adds no protection.
        cmd.push_str(" --skip-git-repo-check");
        if let Some(model) = request.model.and_then(safe_model) {
            cmd.push_str(&format!(" -m {}", sh_quote(&model)));
        }
        if let Some(access) = request.access {
            if resuming.is_some() {
                cmd.push_str(&format!(
                    " -c sandbox_mode={}",
                    sh_quote(codex_sandbox(access))
                ));
            } else {
                cmd.push_str(&format!(" --sandbox {}", codex_sandbox(access)));
            }
            cmd.push_str(&format!(
                " -c approval_policy={}",
                sh_quote(codex_approval(access))
            ));
        }
        if let Some(effort) = request.effort.and_then(|e| self.effort(e)) {
            cmd.push_str(&format!(" -c model_reasoning_effort={}", sh_quote(effort)));
        }
        for dir in request.extra_dirs {
            if resuming.is_some() {
                cmd.push_str(&format!(
                    " -c sandbox_workspace_write.writable_roots={}",
                    sh_quote(&format!("[{}]", toml_string(dir)))
                ));
            } else {
                cmd.push_str(&format!(" --add-dir {}", sh_quote(dir)));
            }
        }
        for path in request.images {
            cmd.push_str(&format!(" -i {}", sh_quote(path)));
        }
        // The composer deliberately permits sending just an image. Codex
        // treats an empty positional prompt as absent, then reads stdin for
        // one; command-line chats close stdin immediately, so that otherwise
        // fails with "No prompt provided via stdin." Give such a turn the
        // smallest useful instruction while leaving typed prompts untouched.
        let prompt = if request.prompt.trim().is_empty() && !request.images.is_empty() {
            "Please inspect the attached image."
        } else {
            request.prompt
        };
        cmd.push(' ');
        cmd.push_str(&sh_quote(prompt));
        cmd
    }

    fn observe_event<'a>(&self, event: &'a Value) -> AgentEvent<'a> {
        let mut observed = AgentEvent::default();
        match event.get("type").and_then(Value::as_str) {
            Some("thread.started") => {
                observed.session_id = event.get("thread_id").and_then(Value::as_str);
            }
            Some("item.completed") => {
                let item = event.get("item");
                if item.and_then(|i| i.get("type")).and_then(Value::as_str) == Some("agent_message")
                {
                    observed.spoken_text = item.and_then(|i| i.get("text")).and_then(Value::as_str);
                }
            }
            Some("turn.completed") | Some("turn.failed") => {
                observed.turn_finished = true;
            }
            _ => {}
        }
        observed
    }

    fn is_expected_stderr(&self, line: &str) -> bool {
        let line = line.trim();
        line.starts_with("Reading additional input from stdin")
            // Codex can continue normally using its cached model catalogue
            // when this background cache-TTL renewal fails. It is an internal
            // compatibility warning, not a failure of the chat or its turn.
            || (line.contains("codex_models_manager::manager: failed to renew cache TTL")
                && line.contains("supports_parallel_tool_calls"))
    }
}

fn claude_permission_mode(access: Access) -> &'static str {
    match access {
        Access::Read => "plan",
        Access::Manual => "manual",
        Access::Edits => "acceptEdits",
        Access::Auto => "auto",
        Access::Full => "bypassPermissions",
    }
}

fn codex_sandbox(access: Access) -> &'static str {
    match access {
        Access::Read => "read-only",
        Access::Manual | Access::Edits | Access::Auto => "workspace-write",
        Access::Full => "danger-full-access",
    }
}

fn codex_approval(access: Access) -> &'static str {
    match access {
        Access::Read => "never",
        Access::Manual | Access::Edits | Access::Auto => "on-request",
        Access::Full => "never",
    }
}

/// An MCP server carrying the tools print mode cannot otherwise answer.
const ASK_MCP: &str = include_str!("../../scripts/mcp/octiq-ask.cjs");

/// Told to Claude so the tools it was given are used at the right moments.
const ASK_PROMPT: &str = "When a decision is the user's to make rather than yours — which of several approaches to take, what something should be called, whether an assumption you are about to build on is right — call the `ask_user` tool and wait for their answer. Prefer it over guessing and over stopping to ask in prose: they may be on a phone, and it puts the question in front of them wherever they are.\n\nWhen you take on work that runs to more than a step or two, call the `todo_write` tool straight away with the whole plan, and call it again whenever an item starts or finishes. The list is pinned on their screen: it is how they see that you understood the request, and how far through it you are. Keep exactly one item in_progress, and send the whole list each time.\n\nThis chat can hold other agents beside you. `add_agent` puts one in it and `ask_agent` puts a question to one and waits for the answer — you choose exactly what it is told, so a seat sees nothing of this conversation unless you put it in the prompt. A seat added with `room_only` cannot see the project at all, which is the point of it: an agent that can read the files ends up agreeing with you. Do NOT reach for either unasked. Bring someone in when the person asks for another opinion, or when you are genuinely stuck and say so first. Adding the first seat is what turns a chat into a group, so there is nothing to switch on first — but adding an outside service always asks the person before anything this room said leaves the machine.";

/// Write Claude's OctiqFlow MCP config and return its path. Best effort: a
/// provider without it still starts, just without the extra tools.
pub(crate) fn ask_mcp_config() -> Option<std::path::PathBuf> {
    let dir = crate::paths::home_dir()?.join(".octiqflow").join("mcp");
    std::fs::create_dir_all(&dir).ok()?;

    let script = dir.join("octiq-ask.cjs");
    std::fs::write(&script, ASK_MCP).ok()?;

    let config = dir.join("octiq-ask.json");
    let body = json!({
        "mcpServers": {
            "octiq": {
                "command": "node",
                "args": [script.to_string_lossy()],
            }
        }
    });
    std::fs::write(&config, serde_json::to_vec_pretty(&body).ok()?).ok()?;
    Some(config)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn command(kind: AgentKind, mcp_config: Option<&Path>) -> String {
        provider_for(kind).build_command(&AgentCommand {
            model: Some("model-x"),
            access: Some(Access::Auto),
            prompt: "hello",
            resume: None,
            extra_dirs: &[],
            effort: Some("high"),
            images: &[],
            lite: false,
            mcp_config,
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
        assert_eq!(codex.capabilities().input, InputTransport::CommandLine);
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
            assert_eq!(
                provider.user_message_payload("hello", &[]).is_some(),
                capabilities.input.accepts_stdin(),
            );
            assert_eq!(
                provider.interrupt_payload().is_some(),
                capabilities.input.accepts_stdin(),
            );
            assert_eq!(
                provider.access_change_payload(Access::Auto).is_some(),
                capabilities.supports_live_access_change,
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
        assert!(!claude.contains("--sandbox"));

        let codex = command(AgentKind::Codex, None);
        assert!(codex.contains("--sandbox workspace-write"));
        assert!(codex.contains("approval_policy='on-request'"));
        assert!(!codex.contains("--permission-mode"));
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
    }
}
