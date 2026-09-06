use super::{model::*, process, provider::Reply};
use serde_json::{json, Value};
use std::time::Duration;

pub fn parse_claude(text: &str) -> Result<Reply> {
    let v: Value = serde_json::from_str(text).map_err(|_| "Claude returned invalid output.")?;
    if v["api_error_status"] == 403
        && v["result"]
            .as_str()
            .is_some_and(|s| s.contains("disabled Claude subscription access"))
    {
        return Err("Claude subscription access is disabled by the account organization (HTTP 403). Ask its administrator to enable access, or use Claude API.".into());
    }
    if v["is_error"].as_bool().unwrap_or(false) {
        return Err("Claude could not complete this turn. Check its account/model and retry with a direction.".into());
    }
    let result = v["result"]
        .as_str()
        .filter(|s| !s.trim().is_empty())
        .ok_or("Claude returned no answer.")?;
    let mut reply = super::provider::parse(
        "claude",
        &json!({"content":[{"type":"text","text":result}],"usage":v["usage"]}),
    )?;
    reply.text = result.into();
    Ok(reply)
}
pub fn parse_codex(text: &str) -> Result<Reply> {
    let mut answer = None;
    let mut usage = Value::Null;
    for line in text.lines() {
        let Ok(v) = serde_json::from_str::<Value>(line) else {
            continue;
        };
        match v["type"].as_str() {
            Some("item.completed") if v["item"]["type"]=="agent_message" => answer=v["item"]["text"].as_str().map(str::to_owned),
            Some("turn.completed") => usage=v["usage"].clone(),
            Some("turn.failed" | "error") => return Err("Codex could not complete this turn. Check its account/model and provide a direction to retry.".into()),
            _ => {},
        }
    }
    Ok(Reply {
        text: answer
            .filter(|s| !s.trim().is_empty())
            .ok_or("Codex returned no answer.")?,
        input: usage["input_tokens"].as_u64(),
        output: usage["output_tokens"].as_u64(),
        cached: usage["cached_input_tokens"].as_u64(),
    })
}
pub fn call(
    agent: &Agent,
    system: &str,
    messages: &[Value],
    active: impl FnMut() -> bool,
) -> Result<Reply> {
    let name = if agent.provider == "codex" {
        "codex"
    } else {
        "claude"
    };
    let binary = process::binary(name).ok_or("Install and sign in to this CLI on the server.")?;
    let cwd = process::empty_workspace()?;
    let _cleanup = process::Cleanup(cwd.clone());
    let mut command = process::command(&binary, &cwd);
    if name == "claude" {
        command.args([
            "-p",
            "--safe-mode",
            "--tools",
            "",
            "--strict-mcp-config",
            "--setting-sources",
            "",
            "--no-session-persistence",
            "--output-format",
            "json",
            "--system-prompt",
            system,
        ]);
        if agent.model != "default" {
            command.args(["--model", &agent.model]);
        }
        command.env_remove("CLAUDECODE");
    } else {
        command.args([
            "exec",
            "--ignore-user-config",
            "--ignore-rules",
            "--ephemeral",
            "--skip-git-repo-check",
            "--sandbox",
            "read-only",
            "--json",
            "--color",
            "never",
        ]);
        for feature in [
            "shell_tool",
            "unified_exec",
            "view_image",
            "apps",
            "plugins",
            "hooks",
            "memories",
            "multi_agent",
            "browser_use",
            "browser_use_external",
            "computer_use",
            "image_generation",
            "in_app_browser",
            "code_mode",
            "code_mode_host",
            "skill_search",
            "workspace_dependencies",
            "shell_snapshot",
            "tool_suggest",
        ] {
            command.args(["--disable", feature]);
        }
        command.args([
            "--enable",
            "skip_host_skill_discovery",
            "-c",
            "project_doc_max_bytes=0",
            "-c",
            "web_search=\"disabled\"",
            "-c",
            "tools.update_plan.enabled=false",
            "-c",
            "approval_policy=\"never\"",
        ]);
        command.args(["-c", &format!("developer_instructions={}", json!(system))]);
        if agent.model != "default" {
            command.args(["--model", &agent.model]);
        }
        command.arg("-");
    }
    let result = process::run(
        command,
        json!({"conversation":messages}).to_string(),
        Duration::from_secs(240),
        active,
    )?;
    if result.interrupted {
        return Err("The CLI turn was interrupted or timed out.".into());
    }
    if name == "claude" && result.code != Some(0) && result.stdout.trim_start().starts_with('{') {
        return parse_claude(&result.stdout);
    }
    if result.code != Some(0) {
        return Err(format!(
            "{name} could not run. Check CLI login and model availability on the server."
        ));
    }
    if name == "claude" {
        parse_claude(&result.stdout)
    } else {
        parse_codex(&result.stdout)
    }
}
