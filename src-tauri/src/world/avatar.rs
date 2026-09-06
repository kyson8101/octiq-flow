//! Avatar generation is separate from task execution and never receives project context.
use super::{model::*, read, update};
use base64::Engine;
use serde_json::{json, Value};
use std::{
    io::{Read, Write},
    path::PathBuf,
    process::{Command, Stdio},
    thread,
    time::{Duration, Instant},
};

pub enum Config {
    Higgsfield { binary: PathBuf, model: String },
    OpenAi { key: String, model: String },
}
fn setting(name: &str) -> Option<String> {
    std::env::var(name).ok().filter(|v| !v.trim().is_empty())
}
fn higgsfield_binary() -> Option<PathBuf> {
    if let Some(path) = setting("OCTIQOS_HIGGSFIELD_BIN") {
        let path = PathBuf::from(path);
        return (path.is_absolute() && path.is_file()).then_some(path);
    }
    let mut paths: Vec<_> = std::env::var_os("PATH")
        .map(|v| std::env::split_paths(&v).collect())
        .unwrap_or_default();
    paths.extend([
        PathBuf::from("/opt/homebrew/bin"),
        PathBuf::from("/usr/local/bin"),
    ]);
    paths
        .into_iter()
        .filter(|p| p.is_absolute())
        .map(|p| p.join("higgsfield"))
        .find(|p| p.is_file())
}
pub fn config() -> Result<Config> {
    let choice = setting("OCTIQOS_AVATAR_PROVIDER").unwrap_or_else(|| "auto".into());
    if !["auto", "higgsfield", "openai"].contains(&choice.as_str()) {
        return Err("OCTIQOS_AVATAR_PROVIDER must be auto, higgsfield, or openai.".into());
    }
    // The CLI owns OAuth credentials and refresh. Never copy them into world state.
    let credentials = setting("XDG_CONFIG_HOME")
        .map(PathBuf::from)
        .or_else(|| std::env::var_os("HOME").map(|p| PathBuf::from(p).join(".config")))
        .is_some_and(|p| p.join("higgsfield/credentials.json").is_file());
    if choice != "openai" && credentials {
        if let Some(binary) = higgsfield_binary() {
            let model =
                setting("OCTIQOS_HIGGSFIELD_MODEL").unwrap_or_else(|| "nano_banana_flash".into());
            if !model
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || b == b'_')
            {
                return Err("Invalid Higgsfield avatar model ID.".into());
            }
            return Ok(Config::Higgsfield { binary, model });
        }
    }
    if choice == "higgsfield" {
        return Err(
            "Install Higgsfield and run higgsfield auth login as the preview service user.".into(),
        );
    }
    if let (Some(key), Some(model)) = (
        setting("OCTIQOS_IMAGE_API_KEY"),
        setting("OCTIQOS_IMAGE_MODEL"),
    ) {
        return Ok(Config::OpenAi { key, model });
    }
    Err("Connect Higgsfield, or configure an OpenAI image account, on the preview service.".into())
}
impl Config {
    pub fn name(&self) -> &'static str {
        match self {
            Self::Higgsfield { .. } => "Higgsfield",
            Self::OpenAi { .. } => "OpenAI",
        }
    }
}
pub struct Generated {
    pub data: String,
    pub input: Option<u64>,
    pub output: Option<u64>,
    pub job_id: Option<String>,
}
fn bounded(mut source: impl Read, max: u64) -> Result<Vec<u8>> {
    let mut bytes = Vec::new();
    source
        .by_ref()
        .take(max + 1)
        .read_to_end(&mut bytes)
        .map_err(|_| "Could not read avatar response.")?;
    if bytes.len() as u64 > max {
        return Err("Avatar response exceeded the size limit.".into());
    }
    Ok(bytes)
}
pub fn image_data(bytes: &[u8]) -> Result<String> {
    let mime = if bytes.starts_with(b"\x89PNG\r\n\x1a\n") {
        "image/png"
    } else if bytes.starts_with(b"\xff\xd8\xff") {
        "image/jpeg"
    } else if bytes.starts_with(b"RIFF") && bytes.get(8..12) == Some(b"WEBP") {
        "image/webp"
    } else {
        return Err("Image provider returned an unsupported image.".into());
    };
    Ok(format!(
        "data:{mime};base64,{}",
        base64::engine::general_purpose::STANDARD.encode(bytes)
    ))
}
pub fn result_url(value: &Value) -> Result<(&str, Option<&str>)> {
    let job = value.as_array().and_then(|a| a.first()).unwrap_or(value);
    if job["status"] != "completed" {
        return Err(
            "Higgsfield did not complete the avatar. Check its generation history before retrying."
                .into(),
        );
    }
    let url = job["result_url"]
        .as_str()
        .ok_or("Higgsfield returned no avatar image.")?;
    // No user-provided download hosts or redirects; credentials never accompany CDN requests.
    let host = url
        .strip_prefix("https://")
        .and_then(|s| s.split_once('/'))
        .map(|p| p.0)
        .ok_or("Higgsfield returned an invalid image URL.")?;
    if !host
        .bytes()
        .all(|c| c.is_ascii_alphanumeric() || c == b'.' || c == b'-')
        || !(host.ends_with(".cloudfront.net") || host.ends_with(".higgsfield.ai"))
    {
        return Err("Higgsfield returned an unrecognized image host.".into());
    }
    Ok((url, job["id"].as_str()))
}
fn cli_json(
    binary: &std::path::Path,
    model: &str,
    prompt: &str,
    timeout: Duration,
) -> Result<Value> {
    let mut child = Command::new(binary)
        .args([
            "generate",
            "create",
            model,
            "--aspect_ratio",
            "1:1",
            "--resolution",
            "1k",
            "--wait",
            "--wait-timeout",
            "9m",
            "--json",
            "--no-color",
        ])
        .current_dir(std::env::temp_dir())
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|_| "Could not start Higgsfield. Check the configured CLI path.")?;
    let stdout = child.stdout.take().unwrap();
    let stderr = child.stderr.take().unwrap();
    let output = thread::spawn(move || bounded(stdout, 2_000_000));
    let errors = thread::spawn(move || bounded(stderr, 16_000));
    let written = child.stdin.take().unwrap().write_all(prompt.as_bytes());
    let start = Instant::now();
    let status = loop {
        match child.try_wait() {
            Ok(Some(status)) => break Some(status),
            Ok(None) if start.elapsed() < timeout && written.is_ok() => {
                thread::sleep(Duration::from_millis(100))
            }
            _ => {
                let _ = child.kill();
                let _ = child.wait();
                break None;
            }
        }
    };
    let bytes = output
        .join()
        .map_err(|_| "Could not read Higgsfield output.")??;
    let _ = errors.join(); // CLI diagnostics may contain account details; do not return them to clients.
    if !status.is_some_and(|s| s.success()) {
        return Err("Higgsfield generation failed or timed out. Check login and generation history before retrying; the remote job may still finish.".into());
    }
    serde_json::from_slice(&bytes)
        .map_err(|_| "Higgsfield returned invalid generation data.".into())
}
pub fn generate(config: &Config, prompt: &str) -> Result<Generated> {
    let http = ureq::AgentBuilder::new()
        .timeout(Duration::from_secs(180))
        .redirects(0)
        .build();
    match config {
        Config::Higgsfield { binary, model } => {
            let value = cli_json(binary, model, prompt, Duration::from_secs(600))?;
            let (url, job) = result_url(&value)?;
            let response = http.get(url).call().map_err(|_| "Could not download the Higgsfield avatar. Check generation history before retrying.")?;
            let bytes = bounded(response.into_reader(), 6_000_000)?;
            Ok(Generated {
                data: image_data(&bytes)?,
                input: None,
                output: None,
                job_id: job.map(str::to_owned),
            })
        }
        Config::OpenAi { key, model } => {
            let response = http.post("https://api.openai.com/v1/images/generations")
                .set("Authorization", &format!("Bearer {key}"))
                .send_json(json!({"model":model,"prompt":prompt,"n":1,"size":"1024x1024","output_format":"png"}))
                .map_err(|_| "Avatar generation failed. Check the image provider configuration.")?;
            let value: Value = serde_json::from_slice(&bounded(response.into_reader(), 8_000_000)?)
                .map_err(|_| "Image provider returned invalid JSON.")?;
            let bytes = base64::engine::general_purpose::STANDARD
                .decode(
                    value["data"][0]["b64_json"]
                        .as_str()
                        .ok_or("Image provider returned no image.")?,
                )
                .map_err(|_| "Image provider returned invalid image data.")?;
            Ok(Generated {
                data: image_data(&bytes)?,
                input: value["usage"]["input_tokens"].as_u64(),
                output: value["usage"]["output_tokens"].as_u64(),
                job_id: None,
            })
        }
    }
}
pub fn reserve(w: &mut World, agent_id: &str, request_id: &str, provider: &str) -> Result<bool> {
    if w.receipts.iter().any(|r| r.id == request_id) {
        return Ok(false);
    }
    if w.agents
        .iter()
        .filter(|a| {
            a.avatar_generation.as_ref().is_some_and(|g| {
                g.status == "generating" && now().saturating_sub(g.started_at) < 840
            })
        })
        .count()
        >= 2
    {
        return Err("Two avatars are already generating. Wait for one to finish.".into());
    }
    let agent = w
        .agents
        .iter_mut()
        .find(|a| a.id == agent_id)
        .ok_or("Agent not found.")?;
    if agent
        .avatar_generation
        .as_ref()
        .is_some_and(|g| g.status == "generating" && now().saturating_sub(g.started_at) < 840)
    {
        return Err("This agent's avatar is already generating.".into());
    }
    agent.avatar_generation = Some(AvatarGeneration {
        request_id: request_id.into(),
        provider: provider.into(),
        status: "generating".into(),
        error: None,
        started_at: now(),
    });
    w.receipts.push(Receipt {
        id: request_id.into(),
        result: json!({"id":agent_id,"status":"generating"}),
    });
    Ok(true)
}
pub fn finish(
    w: &mut World,
    agent_id: &str,
    request_id: &str,
    result: std::result::Result<Generated, String>,
) -> Result<()> {
    let agent = w
        .agents
        .iter_mut()
        .find(|a| a.id == agent_id)
        .ok_or("Agent no longer exists.")?;
    let generation = agent
        .avatar_generation
        .as_mut()
        .filter(|g| g.request_id == request_id && g.status == "generating")
        .ok_or("Avatar generation was superseded.")?;
    match result {
        Ok(image) => {
            agent.avatar = Some(image.data);
            generation.status = "completed".into();
            let run_id = format!("avatar:{request_id}");
            w.runs.push(Run {
                id: run_id.clone(),
                agent_id: agent_id.into(),
                project_id: String::new(),
                target_id: agent_id.into(),
                kind: "avatar".into(),
                generation: 0,
                status: "completed".into(),
                result: format!(
                    "{} office avatar{}",
                    generation.provider,
                    image
                        .job_id
                        .map(|id| format!(" (job {id})"))
                        .unwrap_or_default()
                ),
                started_at: generation.started_at,
                finished_at: Some(now()),
            });
            w.usage(Usage {
                id: run_id.clone(),
                run_id,
                agent_id: agent_id.into(),
                input: image.input,
                output: image.output,
                cached: None,
            })?;
        }
        Err(error) => {
            generation.status = "failed".into();
            generation.error = Some(error);
        }
    }
    if let Some(receipt) = w.receipts.iter_mut().find(|r| r.id == request_id) {
        receipt.result = json!({"id":agent_id,"status":w.agents.iter().find(|a|a.id==agent_id).unwrap().avatar_generation.as_ref().unwrap().status});
    }
    Ok(())
}
pub fn dispatch(args: Value) -> Result<Value> {
    let agent_id = args["agentId"]
        .as_str()
        .ok_or("Agent is required.")?
        .to_owned();
    let request_id = args["requestId"]
        .as_str()
        .ok_or("A request ID is required.")?
        .to_owned();
    uuid::Uuid::parse_str(&request_id).map_err(|_| "Invalid request ID.")?;
    let agent = read()?.agent(&agent_id)?.clone();
    let config = config()?;
    if update(|w| reserve(w, &agent_id, &request_id, config.name()))? {
        thread::spawn(move || {
            let prompt = format!("Create a single friendly 2D pixel-art office character avatar, full body, centered, plain light background, consistent clean game sprite proportions, no lettering. Character preference: {}. Name: {}.", agent.appearance, agent.name);
            let result = generate(&config, &prompt);
            let _ = update(|w| finish(w, &agent_id, &request_id, result));
        });
    }
    Ok(json!({"result":{"id":agent.id},"snapshot":super::snapshot()?}))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn higgsfield_rejects_failed_jobs_and_unsafe_downloads() {
        for url in [
            "http://d8j0ntlcm91z4.cloudfront.net/a.png",
            "https://127.0.0.1/a",
            "https://evil.test/a",
            "https://x.cloudfront.net@127.0.0.1/a",
            "https://x.cloudfront.net:443/a",
        ] {
            assert!(result_url(&json!([{"status":"completed","result_url":url}])).is_err());
        }
        let v = json!([{"id":"job", "status":"completed","result_url":"https://d8j0ntlcm91z4.cloudfront.net/image.webp"}]);
        assert_eq!(result_url(&v).unwrap().1, Some("job"));
        assert!(result_url(&json!([{"status":"failed"}])).is_err());
        assert!(image_data(b"<svg onload='bad()'></svg>").is_err());
        assert!(bounded(&b"12345"[..], 4).is_err());
        assert!(image_data(b"\xff\xd8\xffsample")
            .unwrap()
            .starts_with("data:image/jpeg;"));
    }
    #[test]
    #[ignore = "explicit live Higgsfield avatar generation; requires OCTIQOS_TEST_HIGGSFIELD_OUTPUT"]
    fn live_higgsfield_avatar() {
        let path =
            std::env::var("OCTIQOS_TEST_HIGGSFIELD_OUTPUT").expect("Explicit output path required");
        let config = Config::Higgsfield {
            binary: higgsfield_binary().unwrap(),
            model: "nano_banana_flash".into(),
        };
        let image = generate(&config, "A single friendly 2D pixel-art office character, full body centered, a thoughtful fox developer wearing a sage green cardigan, clean game sprite proportions, plain warm off-white background, no lettering, square composition.").unwrap();
        let bytes = base64::engine::general_purpose::STANDARD
            .decode(image.data.split_once(',').unwrap().1)
            .unwrap();
        std::fs::write(&path, bytes).unwrap();
        assert!(image.job_id.is_some());
        assert!(image.input.is_none() && image.output.is_none());
    }
}
