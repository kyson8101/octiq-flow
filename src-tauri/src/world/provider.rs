//! Tool-free HTTP model calls. Project effects exist only in runtime's scoped
//! action interpreter; meeting responses never reach that interpreter.
use super::model::*;
use serde_json::{json, Value};
use std::{io::Read, time::Duration};

pub fn availability() -> Value {
    let image = super::avatar::config();
    json!({"claude":super::process::binary("claude").is_some(),"codex":super::process::binary("codex").is_some(),"claude_api":key("claude_api").is_ok(),"deepseek":key("deepseek").is_ok(),"image":image.is_ok(),"higgsfield":image.is_ok_and(|c| c.name() == "Higgsfield")})
}
fn key(provider: &str) -> Result<String> {
    let name = match provider {
        "claude" | "claude_api" => "OCTIQOS_CLAUDE_API_KEY",
        "deepseek" => "OCTIQOS_DEEPSEEK_API_KEY",
        _ => return Err("Unknown provider.".into()),
    };
    std::env::var(name)
        .ok()
        .filter(|s| !s.trim().is_empty())
        .or_else(|| {
            if provider == "deepseek" {
                crate::agent_api::deepseek_key().ok()
            } else {
                None
            }
        })
        .ok_or_else(|| {
            format!("Configure {name} in the private preview environment to run this agent.")
        })
}
pub fn configured(provider: &str) -> Result<()> {
    if ["claude", "codex"].contains(&provider) {
        return super::process::binary(provider)
            .map(|_| ())
            .ok_or_else(|| format!("Install and sign in to {provider} on the server."));
    }
    key(provider).map(|_| ())
}
pub struct Reply {
    pub text: String,
    pub input: Option<u64>,
    pub output: Option<u64>,
    pub cached: Option<u64>,
}

pub fn parse(provider: &str, value: &Value) -> Result<Reply> {
    let (text, input, output, cached) = if ["claude", "claude_api"].contains(&provider) {
        let blocks = value["content"]
            .as_array()
            .ok_or("Provider returned no content.")?;
        let text = blocks
            .iter()
            .filter(|b| b["type"] == "text")
            .filter_map(|b| b["text"].as_str())
            .collect::<Vec<_>>()
            .join("\n");
        let u = &value["usage"];
        // Anthropic reports cache creation/read separately from uncached input.
        let cached = u["cache_read_input_tokens"].as_u64();
        let input = u["input_tokens"].as_u64().map(|n| {
            n.saturating_add(cached.unwrap_or(0))
                .saturating_add(u["cache_creation_input_tokens"].as_u64().unwrap_or(0))
        });
        (text, input, u["output_tokens"].as_u64(), cached)
    } else {
        (
            value["choices"][0]["message"]["content"]
                .as_str()
                .ok_or("Provider returned no answer.")?
                .into(),
            value["usage"]["prompt_tokens"].as_u64(),
            value["usage"]["completion_tokens"].as_u64(),
            value["usage"]["prompt_cache_hit_tokens"].as_u64(),
        )
    };
    if text.trim().is_empty() {
        return Err("Provider returned an empty answer.".into());
    }
    Ok(Reply {
        text,
        input,
        output,
        cached,
    })
}
pub fn call(
    agent: &Agent,
    system: &str,
    messages: &[Value],
    active: impl FnMut() -> bool,
) -> Result<Reply> {
    if ["claude", "codex"].contains(&agent.provider.as_str()) {
        return super::cli::call(agent, system, messages, active);
    }
    let secret = key(&agent.provider)?;
    let http = ureq::AgentBuilder::new()
        .timeout(Duration::from_secs(90))
        .redirects(0)
        .build();
    let request = if agent.provider == "claude_api" {
        http.post("https://api.anthropic.com/v1/messages")
            .set("x-api-key", &secret)
            .set("anthropic-version", "2023-06-01")
            .send_json(
                json!({"model":agent.model,"max_tokens":4096,"system":system,"messages":messages}),
            )
    } else {
        let mut all = vec![json!({"role":"system","content":system})];
        all.extend_from_slice(messages);
        http.post("https://api.deepseek.com/chat/completions")
            .set("Authorization", &format!("Bearer {secret}"))
            .send_json(json!({"model":agent.model,"max_tokens":4096,"messages":all,"stream":false}))
    };
    let response = request.map_err(|e| match e {
        ureq::Error::Status(code, _) => format!(
            "{} returned HTTP {code}. Check the configured model and account.",
            agent.provider
        ),
        _ => "Provider connection failed or timed out.".into(),
    })?;
    let mut data = String::new();
    response
        .into_reader()
        .take(2_000_001)
        .read_to_string(&mut data)
        .map_err(|_| "Could not read provider response.")?;
    if data.len() > 2_000_000 {
        return Err("Provider response exceeded the size limit.".into());
    }
    parse(
        &agent.provider,
        &serde_json::from_str::<Value>(&data).map_err(|_| "Provider returned invalid JSON.")?,
    )
}
