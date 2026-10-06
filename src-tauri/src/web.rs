//! The front door: serve the client over HTTP and bridge a browser to this
//! machine's backend over one WebSocket.
//!
//! The point is a two-part setup: OctiqFlow runs on a machine that stays on (an
//! old Mac, a mini), owns every PTY, and a browser anywhere else — a laptop
//! whose lid you can close, a phone — drives it. The terminals never live in
//! the browser: they live here, so nothing dies when a client disconnects.
//!
//! ```text
//!   browser                    this process
//!   ───────                    ────────────
//!   GET /            ────────► the client in web/dist
//!   WS  /ws?token=…  ◄───────► command requests + event stream
//! ```
//!
//! A request names a command; `dispatch.rs` routes it by name and runs it here.
//! There was a time when it went the long way instead — handed to a desktop
//! window, which called `invoke` on our behalf and sent the answer back, so
//! that no dispatch table had to be written. That made the window
//! load-bearing: no window, no answers. The window is gone and the table is
//! what replaced it.
//!
//! Events never took that detour (`emit` below): straight from the Rust emitter
//! to every socket, because `pty-output` is the hot path.
//!
//! ## Turning it on
//!
//! Off by default — this endpoint can start shells. It reads `web.json` in the
//! active profile dir:
//!
//! ```json
//! { "enabled": true, "port": 1421, "bind": "0.0.0.0", "token": "…" }
//! ```
//!
//! A missing token is generated and written back on first start. The file is
//! written `0600` inside a `0700` folder, because what it holds is not a
//! password to a document: it opens the socket, and the socket can start a
//! shell. Static files are not gated (they are just the UI); the WebSocket —
//! the part that can do anything — requires the token.
//!
//! ## What guards what
//!
//! The token is the only thing standing between a request and this machine, so
//! three rules sit around it:
//!
//! * **The token is compared in constant time** (`ct_eq`). `==` stops at the
//!   first byte that differs, and that timing is an oracle.
//! * **`/token` answers only a Cloudflare Access sign-in.** It once answered
//!   any request that came from this machine and spelled its `Host` as
//!   loopback, which every local process can do — including the agents this
//!   server starts. A browser without the token now gets the Connect page, or
//!   opens the `?token=…` link printed at startup; either is remembered.
//! * **The socket refuses a page we did not serve** (`origin_ok`). A WebSocket
//!   handshake is exempt from the same-origin policy, so `Origin` is the only
//!   place the browser says who is calling. Clients that are not browsers send
//!   none and are unaffected — the token is what gates them.
//!
//! ## Two callers, two credentials
//!
//! * **The person** is whoever holds the token: `/ws`, `/file` and `/auth`,
//!   and `/token` hands it only to a Cloudflare Access sign-in. The socket acts as the person, so everything the person alone
//!   decides (accepting a result, approving a plan) is a socket command.
//! * **An agent** is one launch of one chat, and proves it with the
//!   capability the host minted for that launch (`OCTIQ_CHAT_CAPABILITY`,
//!   see `LaunchCapability`). That is the ONLY thing the `/hook/*` routes take:
//!   the token is neither needed nor enough there, the chat, session and
//!   launch come from the capability, and a body that names another is
//!   refused. An agent is never handed the token, and the capability opens
//!   none of the person's routes.
//!
//! That separates what OctiqFlow hands out: nothing the server gives an agent,
//! and no request from this machine on its own, carries the person's
//! authority. It is not an OS boundary: an agent runs as the person's own
//! user, so a process that goes looking can read `web.json` (or the server's
//! startup log, which prints the link) or another process's environment.
//! Nothing here claims otherwise; only OS-level isolation closes that.

use std::net::SocketAddr;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

use axum::body::Body;
use axum::extract::ws::{Message, WebSocket, WebSocketUpgrade};
use axum::extract::{Form, Query, State as AxumState};
use axum::http::{header, StatusCode, Uri};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use axum::{Json, Router};
use futures_util::{SinkExt, StreamExt};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tokio::sync::broadcast;

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WebConfig {
    #[serde(default)]
    pub enabled: bool,
    #[serde(default = "default_port")]
    pub port: u16,
    /// Which interface to listen on. Default is loopback: opening this to a
    /// network is a deliberate act, so it has to be typed out.
    #[serde(default = "default_bind")]
    pub bind: String,
    #[serde(default)]
    pub token: String,
    /// Signing in with Cloudflare Access instead of pasting the token. Empty
    /// means off, and the token stays the only way in.
    #[serde(default)]
    pub access: crate::access::AccessConfig,
}

fn default_port() -> u16 {
    1421
}

fn default_bind() -> String {
    "127.0.0.1".to_string()
}

/// The browser token is sufficient for a founder's own loopback service, but
/// it is not an internet-facing identity system. A non-loopback listener must
/// therefore be paired with a configured identity-verifying proxy gate. The
/// normal Cloudflare Tunnel shape still binds to loopback and is unaffected.
fn bind_has_access_control(addr: SocketAddr, cfg: &WebConfig) -> bool {
    addr.ip().is_loopback() || cfg.access.is_configured()
}

impl Default for WebConfig {
    fn default() -> Self {
        Self {
            enabled: false,
            port: default_port(),
            bind: default_bind(),
            token: String::new(),
            access: Default::default(),
        }
    }
}

fn config_path() -> PathBuf {
    crate::profile::profile_dir().join("web.json")
}

/// Read `web.json`, filling in a token on first use. Env vars win over the
/// file, so a server can be started without editing anything:
/// `OCTIQ_WEB=1 OCTIQ_WEB_PORT=1421 OCTIQ_WEB_BIND=0.0.0.0`.
pub fn load_config() -> WebConfig {
    let mut cfg: WebConfig = std::fs::read_to_string(config_path())
        .ok()
        .and_then(|raw| serde_json::from_str(&raw).ok())
        .unwrap_or_default();

    // Mint the token before the env overrides are applied, and persist only
    // this: an env var is meant for one run, so `OCTIQ_WEB=1` once must not
    // leave remote access switched on in the file forever.
    if cfg.token.trim().is_empty() {
        cfg.token = uuid::Uuid::new_v4().to_string();
        save_config(&cfg);
    } else {
        // An install made before the permissions were tightened still has a
        // world-readable token sitting there. Nothing rewrites this file on a
        // normal run, so the fix has to happen on the read.
        let path = config_path();
        if let Some(dir) = path.parent() {
            private_dir(dir);
        }
        private_file(&path);
    }

    if let Ok(v) = std::env::var("OCTIQ_WEB") {
        cfg.enabled = v == "1" || v.eq_ignore_ascii_case("true");
    }
    if let Ok(v) = std::env::var("OCTIQ_WEB_PORT") {
        if let Ok(p) = v.parse() {
            cfg.port = p;
        }
    }
    if let Ok(v) = std::env::var("OCTIQ_WEB_BIND") {
        cfg.bind = v;
    }
    if let Ok(v) = std::env::var("OCTIQ_WEB_TOKEN") {
        cfg.token = v;
    }
    cfg
}

pub fn save_config(cfg: &WebConfig) {
    let path = config_path();
    if let Some(dir) = path.parent() {
        let _ = std::fs::create_dir_all(dir);
        private_dir(dir);
    }
    if let Ok(raw) = serde_json::to_string_pretty(cfg) {
        if std::fs::write(&path, raw).is_ok() {
            private_file(&path);
        }
    }
}

/// Take the group and world bits off a file we just wrote.
///
/// `web.json` holds the token, and the token is not a password to a document —
/// it opens the socket, and the socket can start a shell. Written under the
/// default umask this file lands `0644`, so on a machine with more than one
/// account every one of them can read it. The point of this app is to run on a
/// machine that stays on; that is exactly the machine most likely to have other
/// logins on it.
///
/// Applied after the write rather than before: a file is only briefly readable
/// this way, and doing it in that order means a failed write leaves nothing
/// behind to tighten. No-op off Unix, where the ACL model is not this one.
#[cfg(unix)]
fn private_file(path: &std::path::Path) {
    use std::os::unix::fs::PermissionsExt;
    let _ = std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600));
}

#[cfg(not(unix))]
fn private_file(_path: &std::path::Path) {}

/// The same for the folder around it: a directory nobody else may list.
#[cfg(unix)]
fn private_dir(path: &std::path::Path) {
    use std::os::unix::fs::PermissionsExt;
    let _ = std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o700));
}

#[cfg(not(unix))]
fn private_dir(_path: &std::path::Path) {}

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

pub struct WebState {
    pub cfg: Mutex<WebConfig>,
}

impl WebState {
    pub fn new(cfg: WebConfig) -> Self {
        Self {
            cfg: Mutex::new(cfg),
        }
    }
}

// ---------------------------------------------------------------------------
// Running a command
// ---------------------------------------------------------------------------

/// Run one command on behalf of a browser without blocking Axum's async
/// workers. Dispatch includes synchronous terminal and filesystem work, so
/// calling it directly from a Tokio worker can starve the socket pump.
async fn run_command(ctx: &Ctx, cmd: String, args: Value) -> Result<Value, String> {
    let services = ctx.services.clone();
    gated(git_read_slots(), &cmd.clone(), async move {
        tokio::task::spawn_blocking(move || crate::dispatch::dispatch(&services, &cmd, args))
            .await
            .map_err(|error| format!("the backend command did not finish: {error}"))?
    })
    .await
}

/// `run_command` for an agent's hook call: a failure keeps the kind of
/// refusal the command named where it was made (`outcome::refuse`), read back
/// on the same blocking thread, so the agent's tool result can say whose
/// failure it was.
async fn run_hook_command(
    ctx: &Ctx,
    cmd: String,
    args: Value,
) -> Result<Value, crate::outcome::Refusal> {
    let services = ctx.services.clone();
    gated(git_read_slots(), &cmd.clone(), async move {
        tokio::task::spawn_blocking(move || {
            crate::outcome::noted(|| crate::dispatch::dispatch(&services, &cmd, args))
        })
        .await
        .map_err(|error| {
            crate::outcome::Refusal::from(format!("the backend command did not finish: {error}"))
        })?
    })
    .await
}

/// A failed hook call, as the MCP reads one: the words the agent is shown,
/// and whose failure it was (`outcome`), which the MCP hands on in the tool
/// result's `_meta`.
fn hook_failed(status: StatusCode, refusal: impl Into<crate::outcome::Refusal>) -> Response {
    (status, axum::Json(refusal.into().body())).into_response()
}

/// Commands that run `git` only to read, and that every open tab asks again on
/// each `git-status-changed`.
///
/// Every command runs on tokio's blocking pool, which stops at 512 threads and
/// queues the rest. A burst of these used to fill it: a project pointed at the
/// home folder turned each browser-cache write into a round of git per tab,
/// the rounds arrived faster than git could answer them, and `chat_send` then
/// waited behind hundreds of them — the chat said "Sending…" for good.
const GIT_READS: [&str; 5] = [
    "git_status_summary",
    "git_changed_files",
    "git_file_diff",
    "git_local_branches",
    "chat_task",
];

/// How many of `GIT_READS` may hold a blocking thread at once. The rest wait
/// here, on no thread at all, so a git backlog can only ever delay git.
const GIT_READ_SLOTS: usize = 4;

fn git_read_slots() -> &'static tokio::sync::Semaphore {
    static SLOTS: std::sync::OnceLock<tokio::sync::Semaphore> = std::sync::OnceLock::new();
    SLOTS.get_or_init(|| tokio::sync::Semaphore::new(GIT_READ_SLOTS))
}

/// Run `work`, first taking one of `slots` when `cmd` is a git read.
async fn gated<T>(
    slots: &tokio::sync::Semaphore,
    cmd: &str,
    work: impl std::future::Future<Output = T>,
) -> T {
    // `acquire` fails only on a closed semaphore, and this one is never closed.
    let _slot = if GIT_READS.contains(&cmd) {
        slots.acquire().await.ok()
    } else {
        None
    };
    work.await
}

// ---------------------------------------------------------------------------
// HTTP + WebSocket
// ---------------------------------------------------------------------------

#[derive(Clone)]
struct Ctx {
    state: Arc<WebState>,
    services: crate::dispatch::Services,
}

/// The port the hooks answer on, for agents to be told (`OCTIQ_HOOK_PORT`).
/// 0 until the server knows it.
static HOOK_PORT: std::sync::atomic::AtomicU16 = std::sync::atomic::AtomicU16::new(0);

/// Remember where the hooks are, before anything can start an agent.
pub(crate) fn remember_hook_port(port: u16) {
    HOOK_PORT.store(port, std::sync::atomic::Ordering::Relaxed);
}

/// Where an agent's MCP reaches the hooks: `127.0.0.1:<this>`. An agent is
/// told the port and never the token, so it no longer reads `web.json`.
pub(crate) fn hook_port() -> Option<u16> {
    Some(HOOK_PORT.load(std::sync::atomic::Ordering::Relaxed)).filter(|port| *port != 0)
}

#[derive(Deserialize)]
struct TokenQuery {
    token: Option<String>,
}

/// Serve the browser client and dispatch its commands.
pub async fn start_headless(cfg: WebConfig, services: crate::dispatch::Services) {
    let ctx = Ctx {
        state: Arc::new(WebState::new(cfg.clone())),
        services,
    };
    if let Some(fut) = serve(ctx, cfg) {
        fut.await;
    }
}

/// The server itself, shared by both. `None` when the address will not parse,
/// which is a config problem worth saying out loud rather than retrying.
fn serve(ctx: Ctx, cfg: WebConfig) -> Option<impl std::future::Future<Output = ()>> {
    let addr: SocketAddr = match format!("{}:{}", cfg.bind, cfg.port).parse() {
        Ok(a) => a,
        Err(e) => {
            eprintln!("[web] bad bind address {}:{} — {e}", cfg.bind, cfg.port);
            return None;
        }
    };
    if !bind_has_access_control(addr, &cfg) {
        eprintln!(
            "[web] refusing network bind at {addr}: configure Cloudflare Access in web.json first"
        );
        return None;
    }

    let token = cfg.token.clone();
    Some(async move {
        let router = router(ctx.clone());

        let listener = match tokio::net::TcpListener::bind(addr).await {
            Ok(l) => l,
            Err(e) => {
                eprintln!("[web] could not listen on {addr}: {e}");
                return;
            }
        };
        if let Ok(bound) = listener.local_addr() {
            remember_hook_port(bound.port());
        }
        // The whole URL, token and all. Without it the first thing a browser
        // does is fail to connect, and the token lives in a JSON file most
        // people would have to go hunting for. It is the user's own machine and
        // their own terminal; the usability is worth more than the secrecy of a
        // value that already sits in plain text on the same disk.
        println!("[web] OctiqFlow: http://{addr}/?token={token}");
        // The app is served here and nowhere else now. Said once so nobody has
        // to wonder whether the bookmark they kept went stale — it does not, it
        // lands here, token and all.
        println!("[web] (the older /v2/ URL redirects to this one)");
        crate::agent_chat::start_question_recovery(ctx.services.chats.clone());
        // A handover a restart cut off between its start and its record.
        let services = ctx.services.clone();
        std::thread::spawn(move || crate::handover::live_recover(&services));
        let service = router.into_make_service_with_connect_info::<SocketAddr>();
        if let Err(e) = axum::serve(listener, service).await {
            eprintln!("[web] server stopped: {e}");
        }
    })
}

/// Every route the server answers.
fn router(ctx: Ctx) -> Router {
    Router::new()
        .route("/healthz", get(health_handler))
        .route("/ws", get(ws_handler))
        .route("/auth", get(auth_handler))
        .route("/token", get(token_handler))
        .route("/file", get(file_handler).post(file_post_handler))
        .route("/hook/permission", post(permission_handler))
        .route("/hook/ask", post(ask_handler))
        .route("/hook/orchestration", post(orchestration_handler))
        .route("/hook/task", post(task_handler))
        .route("/hook/feedback", post(feedback_handler))
        .route("/hook/agents", post(agents_handler))
        .route("/hook/vault", post(vault_handler))
        .route("/hook/handover", post(handover_handler))
        .route("/hook/route", post(route_handler))
        .route("/hook/handover/ask", post(handover_ask_handler))
        .route("/hook/handover/outcome", post(handover_outcome_handler))
        .fallback(get(asset_handler))
        .with_state(ctx)
}

/// Where the built client lives. Tried in order:
///   · next to the app bundle's resources (a shipped build)
///   · the repo's `web/dist` (running from a checkout)
/// Returns None when it has not been built, which is the one case where the
/// classic UI is still served at `/`.
fn v2_root() -> Option<PathBuf> {
    if let Ok(exe) = std::env::current_exe() {
        if let Some(dir) = exe.parent() {
            for rel in ["../Resources/v2", "v2"] {
                let candidate = dir.join(rel);
                if candidate.join("index.html").is_file() {
                    return Some(candidate);
                }
            }
        }
    }
    let dev = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../web/dist");
    dev.join("index.html").is_file().then_some(dev)
}

/// Serve one file of the client. Any unknown path falls back to its
/// index.html, the usual single-page-app rule.
fn serve_v2(rel: &str, accepts: &str) -> Response {
    let Some(root) = v2_root() else {
        return (
            StatusCode::NOT_FOUND,
            "the client is not built — run `pnpm --dir web build`",
        )
            .into_response();
    };

    // Refuse anything that tries to climb out of the served folder. The only
    // paths we serve are ones that stay inside it; everything else falls back
    // to the page, the same as any address this client does not have a file for.
    let file = match safe_relative_path(rel) {
        Some(safe) => {
            let candidate = root.join(safe);
            if candidate.is_file() {
                candidate
            } else {
                root.join("index.html")
            }
        }
        None => root.join("index.html"),
    };

    let mime = match file.extension().and_then(|e| e.to_str()) {
        Some("html") => "text/html; charset=utf-8",
        Some("js") => "text/javascript; charset=utf-8",
        Some("css") => "text/css; charset=utf-8",
        Some("json") => "application/json",
        Some("svg") => "image/svg+xml",
        Some("png") => "image/png",
        Some("woff2") => "font/woff2",
        // A manifest served as octet-stream is ignored rather than used, which
        // is how the app would fail to install to a home screen while every
        // file still returned 200.
        Some("webmanifest") => "application/manifest+json",
        Some("ico") => "image/x-icon",
        _ => "application/octet-stream",
    };

    // Vite names everything under `assets/` by a hash of its content, so a
    // file there never changes: a browser keeps it, and a new build is new
    // names in a fresh `index.html`, which is never kept. The page stays
    // `no-store` so a deploy reaches the next reload.
    let hashed = file.starts_with(root.join("assets"));
    let (body, encoding) = if hashed {
        precompressed(&file, accepts)
    } else {
        (file.clone(), None)
    };
    match std::fs::read(&body) {
        Ok(bytes) => {
            let mut response = Response::builder()
                .status(StatusCode::OK)
                .header(header::CONTENT_TYPE, mime);
            if hashed {
                response = response
                    .header(header::CACHE_CONTROL, "public, max-age=31536000, immutable")
                    .header(header::VARY, "Accept-Encoding");
            } else {
                response = response.header(header::CACHE_CONTROL, "no-store");
            }
            if let Some(encoding) = encoding {
                response = response.header(header::CONTENT_ENCODING, encoding);
            }
            response
                .body(Body::from(bytes))
                .unwrap_or_else(|_| StatusCode::INTERNAL_SERVER_ERROR.into_response())
        }
        Err(_) => (StatusCode::NOT_FOUND, "not found").into_response(),
    }
}

/// The `.br` or `.gz` the build wrote beside `file` (vite.config.ts
/// `precompress`), when the browser takes that encoding; otherwise `file`.
fn precompressed(file: &Path, accepts: &str) -> (PathBuf, Option<&'static str>) {
    for (encoding, extension) in [("br", "br"), ("gzip", "gz")] {
        if !accepts_encoding(accepts, encoding) {
            continue;
        }
        let mut name = file.as_os_str().to_owned();
        name.push(".");
        name.push(extension);
        let candidate = PathBuf::from(name);
        if candidate.is_file() {
            return (candidate, Some(encoding));
        }
    }
    (file.to_path_buf(), None)
}

/// Whether an `Accept-Encoding` header takes `encoding`. `q=0` refuses it.
fn accepts_encoding(header: &str, encoding: &str) -> bool {
    header.split(',').any(|part| {
        let mut params = part.split(';');
        let named = params
            .next()
            .is_some_and(|token| token.trim().eq_ignore_ascii_case(encoding));
        named
            && !params.any(|param| {
                param
                    .trim()
                    .strip_prefix("q=")
                    .and_then(|q| q.trim().parse::<f32>().ok())
                    .is_some_and(|q| q <= 0.0)
            })
    })
}

/// Where a request for the old `/v2` address belongs, if it is one.
///
/// The client is served at the root and nowhere else. `/v2/` was its address
/// for long enough to reach bookmarks and home-screen shortcuts, so those are
/// sent to the root rather than broken — and the query goes with them, because
/// what a saved link carries is the token. Only `/v2` and `/v2/…` count;
/// `v2x` and `assets/v2/…` are ordinary paths that merely start the same way.
fn legacy_root_redirect(raw: &str, query: Option<&str>) -> Option<String> {
    let rest = raw.strip_prefix("v2")?;
    if !rest.is_empty() && !rest.starts_with('/') {
        return None;
    }
    Some(match query {
        Some(q) if !q.is_empty() => format!("/?{q}"),
        _ => "/".to_string(),
    })
}

/// Serve the client.
///
/// The React client is THE client, and it answers at the root and only there:
/// someone given a URL should reach the app, not a path they have to know to
/// append. `/v2/` used to be that path; it now redirects to the root, so links
/// people already saved keep working without the app being served twice.
///
/// The client is read from `web/dist` on disk, so a build reaches the browser on
/// the next reload with no restart.
async fn asset_handler(
    AxumState(_ctx): AxumState<Ctx>,
    uri: Uri,
    headers: axum::http::HeaderMap,
) -> Response {
    let raw = uri.path().trim_start_matches('/');

    if let Some(target) = legacy_root_redirect(raw, uri.query()) {
        return Response::builder()
            .status(StatusCode::TEMPORARY_REDIRECT)
            .header(header::LOCATION, target)
            .body(Body::empty())
            .unwrap_or_else(|_| StatusCode::INTERNAL_SERVER_ERROR.into_response());
    }

    // Everything else is the client, whenever it is built. Its own routing is
    // in the URL's HASH (`#/p/…/c/…`), so every path that reaches here is
    // either an asset or a page, and `serve_v2` answers both.
    if v2_root().is_some() {
        let accepts = headers
            .get(header::ACCEPT_ENCODING)
            .and_then(|value| value.to_str().ok())
            .unwrap_or_default();
        return serve_v2(raw, accepts);
    }

    // The client is read off disk (`web/dist`). Nothing is embedded in this
    // binary, so with no build there is genuinely nothing to serve.
    (
        StatusCode::NOT_FOUND,
        "the client is not built — run `pnpm --dir web build`",
    )
        .into_response()
}

/// A load-balancer-safe process check. It reveals no configuration, token, or
/// operational data and stays available for a Flow-only install.
async fn health_handler() -> Response {
    Json(json!({ "status": "ok", "service": "octiq-flow" })).into_response()
}

/// The name out of a `host:port`, with an IPv6 literal's brackets removed.
/// `None` when there is nothing left, which is not a host.
fn hostname_of(value: &str) -> Option<String> {
    let value = value.trim();
    // `[::1]:1421` and `[::1]` — the colons inside the brackets are part of the
    // address, so the port can only be what follows the closing one.
    let name = if let Some(rest) = value.strip_prefix('[') {
        rest.split(']').next().unwrap_or_default()
    } else {
        value.split(':').next().unwrap_or_default()
    };
    (!name.is_empty()).then(|| name.to_ascii_lowercase())
}

/// Whether a browser page, if one sent this, is a page WE served.
///
/// A WebSocket handshake is not held to the same-origin policy: any page may
/// open a socket to any host, and the browser will attach the user's cookies
/// while it is at it. `Origin` is what the browser adds so a server can refuse,
/// and refusing is what this does — the socket runs commands, so a page from
/// somewhere else has no business on it even if it somehow learned the token.
///
/// No header at all means no browser: the permission hook, `curl`, the
/// desktop window. Those are allowed through, because Origin was never what
/// gated them — the token is.
///
/// A page already ON this machine is allowed even when its port differs. That
/// is not a concession, it is the dev server: `pnpm dev` serves the client from
/// `localhost:5273` and points it at the backend on `1421`, and the desktop
/// webview's own origin is not a port at all. What this rule is for is a page
/// somewhere ELSE, and no rebound hostname can spell itself `localhost` — the
/// browser writes Origin from the address it loaded, the same as Host.
fn origin_ok(headers: &axum::http::HeaderMap) -> bool {
    let Some(origin) = headers
        .get(axum::http::header::ORIGIN)
        .and_then(|v| v.to_str().ok())
    else {
        return true;
    };
    let origin_authority = origin
        .split("://")
        .nth(1)
        .unwrap_or(origin)
        .trim_end_matches('/');
    if origin_authority.is_empty() {
        return false;
    }
    let host = headers
        .get(axum::http::header::HOST)
        .and_then(|v| v.to_str().ok())
        .unwrap_or_default();
    if origin_authority.eq_ignore_ascii_case(host) {
        return true;
    }
    // Different port, same machine. Both ends have to be loopback for this to
    // apply, so it never widens anything for a request that arrived over a
    // network or through a tunnel.
    let loopback = |value: &str| {
        matches!(
            hostname_of(value).as_deref(),
            Some("localhost" | "127.0.0.1" | "::1")
        )
    };
    loopback(origin_authority) && loopback(host)
}

/// Compare two secrets in time that does not depend on where they differ.
///
/// `==` on a `str` stops at the first byte that differs, so the time it takes
/// says how much of the guess was right — feed it a token one byte at a time
/// and the answer falls out in a few hundred tries instead of 2^122. The margin
/// is tiny and the network noise is large, so this is not the likeliest way in;
/// it is simply not worth leaving open for the sake of one operator.
///
/// An empty expected value matches nothing: a config with no token must refuse
/// everyone rather than accept everyone.
fn ct_eq(a: &str, b: &str) -> bool {
    let (a, b) = (a.as_bytes(), b.as_bytes());
    if a.is_empty() || a.len() != b.len() {
        return false;
    }
    let mut diff = 0u8;
    for (x, y) in a.iter().zip(b) {
        diff |= x ^ y;
    }
    diff == 0
}

/// Turn a request path into a relative path that cannot leave the folder it is
/// joined to, or `None` when it was never going to be one.
///
/// The trap `Path::join` sets is that it does not join at all when handed
/// something absolute — it throws the base away and returns the argument, so
/// `root.join("/etc/passwd")` IS `/etc/passwd`. Splitting the string on `/` and
/// looking for `..` misses that, and misses `..\..` as well, because on Windows
/// the backslash is a separator too and a drive letter is its own kind of
/// absolute. Walking the parsed components instead asks the platform what the
/// path means rather than guessing from its spelling: anything that is not a
/// plain name — a root, a prefix, a parent — ends it.
fn safe_relative_path(rel: &str) -> Option<PathBuf> {
    use std::path::Component;
    let rel = rel.trim_start_matches('/');
    if rel.is_empty() {
        return None;
    }
    let mut out = PathBuf::new();
    for part in std::path::Path::new(rel).components() {
        let Component::Normal(name) = part else {
            // CurDir is harmless but only ever arrives as noise; the rest —
            // RootDir, Prefix, ParentDir — are the ways out.
            return None;
        };
        // Components are parsed for the platform this was COMPILED for, so a
        // Unix build reads `..\..\x` as one ordinary filename and a drive
        // letter as an ordinary folder. Both are traversals once the same
        // request reaches a Windows build, and neither spelling belongs in the
        // name of a bundled asset — so they are refused everywhere, and the
        // rule does not change shape depending on where it runs.
        let name = name.to_string_lossy();
        if name.contains('\\') || name.contains(':') {
            return None;
        }
        out.push(name.as_ref());
    }
    (!out.as_os_str().is_empty()).then_some(out)
}

/// Hand the token to someone Cloudflare Access has signed in, and to nobody
/// else.
///
/// This used to hand it to any request from this machine that spelled its
/// `Host` as loopback, so a browser opened on the same desk was let in without
/// asking. Every part of that request is written by the caller, so it could
/// not tell a browser from any other local process — an agent this server
/// started, say, which would come away holding the person's authority. Now a
/// browser without the token is shown the Connect page, where the person
/// pastes it, or opens the `?token=…` link the server prints at startup; both
/// are remembered, and reconnects use what was remembered.
async fn token_handler(AxumState(ctx): AxumState<Ctx>, headers: axum::http::HeaderMap) -> Response {
    // Someone Cloudflare Access has already identified. They got past a sign-in
    // to be here, so they are handed the token and every later request looks
    // like any other. This is what makes signing in replace pasting a token,
    // rather than sit on top of it.
    let cfg_access = ctx.state.cfg.lock().ok().map(|c| c.access.clone());
    if let Some(access) = cfg_access.filter(|a| a.is_configured()) {
        let assertion = headers
            .get(crate::access::ASSERTION_HEADER)
            .and_then(|v| v.to_str().ok())
            .unwrap_or_default();
        match crate::access::verify(&access, assertion) {
            Ok(who) => {
                println!("[web] token issued to {} via Access", who.email);
                return token_body(&ctx);
            }
            Err(why) if !assertion.is_empty() => {
                // A header that does not verify is not a near miss; it is the
                // shape an attempt takes.
                eprintln!("[web] Access assertion refused: {why}");
                return (StatusCode::FORBIDDEN, "not signed in").into_response();
            }
            Err(_) => {}
        }
    }
    (
        StatusCode::FORBIDDEN,
        "sign in with the access token: open the ?token= link the server printed, or paste it",
    )
        .into_response()
}

/// The token itself, for whichever of the two ways in got here.
fn token_body(ctx: &Ctx) -> Response {
    let token = ctx
        .state
        .cfg
        .lock()
        .ok()
        .map(|c| c.token.clone())
        .unwrap_or_default();
    if token.is_empty() {
        return (StatusCode::NOT_FOUND, "no token").into_response();
    }
    Response::builder()
        .status(StatusCode::OK)
        .header(header::CONTENT_TYPE, "text/plain; charset=utf-8")
        .header(header::CACHE_CONTROL, "no-store")
        .body(Body::from(token))
        .unwrap_or_else(|_| StatusCode::INTERNAL_SERVER_ERROR.into_response())
}

/// Serve one file off this machine, by absolute path.
///
/// The chat lists the files an answer touched, and an image among them should
/// be viewable rather than just named. Reading it over the WebSocket would mean
/// base64 inside a JSON frame; a plain URL lets the browser fetch and decode it
/// the way it is built to.
///
/// This reads anything the app's user can read, which sounds broad until you
/// remember what is next door: the same socket can start a shell. It is gated
/// on the same token, and on nothing else.
async fn file_handler(
    AxumState(ctx): AxumState<Ctx>,
    Query(q): Query<FileQuery>,
    headers: axum::http::HeaderMap,
) -> Response {
    serve_file(&ctx, q, &headers)
}

/// A top-level HTML navigation uses POST so its own address never contains the
/// command-socket token. The response body cannot inspect the POST fields; a
/// GET query would be visible to any script as `location.href` even inside the
/// unique-origin sandbox below.
async fn file_post_handler(
    AxumState(ctx): AxumState<Ctx>,
    headers: axum::http::HeaderMap,
    Form(q): Form<FileQuery>,
) -> Response {
    serve_file(&ctx, q, &headers)
}

fn serve_file(ctx: &Ctx, q: FileQuery, headers: &axum::http::HeaderMap) -> Response {
    // This reads any file on the machine, so the same origin rule as the socket
    // applies. An `<img src>` sends no Origin at all and is unaffected.
    if !origin_ok(headers) {
        return (StatusCode::FORBIDDEN, "wrong origin").into_response();
    }
    if !token_ok(ctx, q.token.as_deref().unwrap_or_default()) {
        return (StatusCode::UNAUTHORIZED, "bad token").into_response();
    }
    let path = PathBuf::from(q.path.unwrap_or_default());
    if !path.is_absolute() || !path.is_file() {
        return (StatusCode::NOT_FOUND, "not a file").into_response();
    }
    // Bounded so a stray click on a multi-gigabyte log cannot pull it into a
    // phone's memory.
    match std::fs::metadata(&path) {
        Ok(meta) if meta.len() > 32 * 1024 * 1024 => {
            return (
                StatusCode::PAYLOAD_TOO_LARGE,
                "file is too large to preview",
            )
                .into_response();
        }
        Err(_) => return (StatusCode::NOT_FOUND, "not a file").into_response(),
        _ => {}
    }

    let mime = file_mime(&path);
    let html = matches!(mime, "text/html; charset=utf-8");

    match std::fs::read(&path) {
        Ok(bytes) => {
            let mut response = Response::builder()
                .status(StatusCode::OK)
                .header(header::CONTENT_TYPE, mime)
                .header(header::CACHE_CONTROL, "no-store")
                .header(header::X_CONTENT_TYPE_OPTIONS, "nosniff");
            // This is agent-authored HTML served beside an endpoint that can
            // start shells. A unique origin is non-negotiable: without this,
            // the page could read localStorage's token and call the command
            // socket. Popups may escape so links from the page still become
            // ordinary native-browser tabs.
            if html {
                response = response.header(header::CONTENT_SECURITY_POLICY, HTML_FILE_CSP);
            }
            response
                .body(Body::from(bytes))
                .unwrap_or_else(|_| StatusCode::INTERNAL_SERVER_ERROR.into_response())
        }
        Err(e) => (StatusCode::NOT_FOUND, e.to_string()).into_response(),
    }
}

const HTML_FILE_CSP: &str = "sandbox allow-scripts allow-forms allow-modals allow-popups allow-popups-to-escape-sandbox allow-downloads";

fn file_mime(path: &std::path::Path) -> &'static str {
    match path
        .extension()
        .and_then(|e| e.to_str())
        .map(|e| e.to_ascii_lowercase())
        .as_deref()
    {
        Some("png") => "image/png",
        Some("jpg") | Some("jpeg") => "image/jpeg",
        Some("gif") => "image/gif",
        Some("webp") => "image/webp",
        Some("svg") => "image/svg+xml",
        Some("mp4") => "video/mp4",
        Some("m4v") => "video/x-m4v",
        Some("mov") => "video/quicktime",
        Some("webm") => "video/webm",
        Some("ogv") => "video/ogg",
        Some("pdf") => "application/pdf",
        Some("html") | Some("htm") => "text/html; charset=utf-8",
        _ => "application/octet-stream",
    }
}

#[derive(Deserialize)]
struct FileQuery {
    token: Option<String>,
    path: Option<String>,
}

/// Is this token good? 200 yes, 401 no.
///
/// A rejected WebSocket handshake closes with the same code as a network
/// failure, so a client cannot tell "the server is down" from "you are not
/// allowed in" — and would sit there reconnecting forever over something no
/// amount of retrying can fix. This endpoint is how it tells the difference,
/// and therefore how it knows to ask for the token instead.
async fn auth_handler(AxumState(ctx): AxumState<Ctx>, Query(q): Query<TokenQuery>) -> Response {
    if token_ok(&ctx, q.token.as_deref().unwrap_or_default()) {
        (StatusCode::OK, "ok").into_response()
    } else {
        (StatusCode::UNAUTHORIZED, "bad token").into_response()
    }
}

/// Constant-time token check for the person's routes: /auth, /ws and /file.
/// Never the hooks — an agent is never given the token (see `hook_caller`).
fn token_ok(ctx: &Ctx, given: &str) -> bool {
    let expected = ctx
        .state
        .cfg
        .lock()
        .ok()
        .map(|c| c.token.clone())
        .unwrap_or_default();
    ct_eq(&expected, given)
}

async fn ws_handler(
    AxumState(ctx): AxumState<Ctx>,
    Query(q): Query<TokenQuery>,
    headers: axum::http::HeaderMap,
    upgrade: WebSocketUpgrade,
) -> Response {
    // A handshake is exempt from the same-origin policy, so "which page is
    // opening this" is a question only the Origin header answers. A page we did
    // not serve is refused before the token is even looked at: the socket runs
    // commands, and no other site has business on it.
    if !origin_ok(&headers) {
        return (StatusCode::FORBIDDEN, "wrong origin").into_response();
    }
    // The socket is the whole attack surface — it can start shells. Everything
    // past this line has already proved it knows the token.
    if !token_ok(&ctx, q.token.as_deref().unwrap_or_default()) {
        return (StatusCode::UNAUTHORIZED, "bad token").into_response();
    }
    upgrade.on_upgrade(move |socket| client(ctx, socket))
}

/// A hook asking whether the agent may use a tool.
///
/// Nothing in this repository calls it any more (`permission-ask.cjs` went
/// with the desktop app); it stays for an agent's own hook config. Like every
/// hook it answers only a running launch's capability, and asks for the chat
/// that capability proves.
async fn permission_handler(
    AxumState(ctx): AxumState<Ctx>,
    headers: axum::http::HeaderMap,
    Json(mut request): Json<crate::permission::Request>,
) -> Response {
    let claim = HookClaim {
        chat_key: request.chat_key.as_deref(),
        ..HookClaim::default()
    };
    let caller = match hook_caller(&ctx.services.chats, &headers, claim) {
        Ok(caller) => caller,
        Err(refused) => return hook_refusal(refused),
    };
    request.chat_key = Some(caller.chat_key);
    let answer = crate::permission::ask(request).await;
    axum::Json(json!({ "decision": answer.decision, "reason": answer.reason })).into_response()
}

/// The agent asking the user something, through its `ask_user` MCP tool.
///
/// The question is attached to the chat, process and launch the capability
/// proves — the same three `question_origin` checks the turn against.
async fn ask_handler(
    AxumState(ctx): AxumState<Ctx>,
    headers: axum::http::HeaderMap,
    Json(request): Json<crate::question::Request>,
) -> Response {
    let mut batch = match request {
        crate::question::Request::Many(batch) => batch,
        crate::question::Request::One(question) => crate::question::Batch {
            session_key: None,
            launch_id: None,
            chat_key: question.chat_key.clone(),
            questions: vec![question],
        },
    };
    let claim = HookClaim {
        chat_key: batch.chat_key.as_deref(),
        session_key: batch.session_key.as_deref(),
        launch_id: batch.launch_id.as_deref(),
    };
    let caller = match hook_caller(&ctx.services.chats, &headers, claim) {
        Ok(caller) => caller,
        Err(refused) => return hook_refusal(refused),
    };
    for question in &mut batch.questions {
        question.chat_key = Some(caller.chat_key.clone());
    }
    batch.chat_key = Some(caller.chat_key);
    batch.session_key = Some(caller.session_key);
    batch.launch_id = Some(caller.launch_id);
    let request = crate::question::Request::Many(batch);
    let answer = crate::question::ask_request(ctx.services.chats.clone(), request).await;
    axum::Json(json!({ "answer": answer })).into_response()
}

/// A `handover` call: the agent asking to pass its task on.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct HandoverHook {
    #[serde(default)]
    chat_key: Option<String>,
    #[serde(default)]
    session_key: Option<String>,
    #[serde(default)]
    launch_id: Option<String>,
    /// Hold the call open for the person's decision. Off for a provider that
    /// cannot keep a tool call waiting (Codex), which hears it as a
    /// continuation turn instead.
    #[serde(default)]
    wait: bool,
    args: crate::handover::Ask,
}

/// The agent asking to hand its task over. It can only RECORD a pending
/// handover for the chat its capability proves; the new chat is created by
/// the person's `handover_confirm`, never from here.
async fn handover_handler(
    AxumState(ctx): AxumState<Ctx>,
    headers: axum::http::HeaderMap,
    Json(request): Json<HandoverHook>,
) -> Response {
    let claim = HookClaim {
        chat_key: request.chat_key.as_deref(),
        session_key: request.session_key.as_deref(),
        launch_id: request.launch_id.as_deref(),
    };
    let caller = match hook_caller(&ctx.services.chats, &headers, claim)
        .and_then(|caller| not_front_desk(&ctx, caller))
    {
        Ok(caller) => caller,
        Err(refused) => return hook_refusal(refused),
    };
    let services = ctx.services.clone();
    let ask = request.args;
    let recorded = tokio::task::spawn_blocking(move || {
        crate::outcome::forget();
        let (record, fresh) = crate::handover::live_request(
            &services,
            &caller.chat_key,
            &caller.session_key,
            &caller.launch_id,
            ask,
        )
        .map_err(crate::outcome::classify)?;
        // Only for a new request: a retry with the same requestId is the
        // same card, already announced.
        if fresh {
            crate::push::notify_chat(
                Some(&caller.chat_key),
                "handover",
                &format!(
                    "Wants to hand this task to {}. Confirm or keep it.",
                    record.to.name
                ),
            );
        }
        Ok::<_, crate::outcome::Refusal>(record)
    })
    .await
    .map_err(|error| crate::outcome::Refusal::from(error.to_string()))
    .and_then(|result| result);
    let record = match recorded {
        Ok(record) => record,
        Err(refusal) => return hook_failed(StatusCode::BAD_REQUEST, refusal),
    };
    let wiring = &ctx.services.handovers;
    let told = if request.wait {
        crate::handover::live_wait(wiring, record.id.clone()).await
    } else {
        crate::handover::answer_now(wiring, &record.id)
    };
    match told {
        Ok(text) => {
            axum::Json(json!({ "result": { "id": record.id, "text": text } })).into_response()
        }
        Err(error) => hook_failed(StatusCode::BAD_REQUEST, error),
    }
}

/// A call back along a confirmed handover, from the chat that received it.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct HandoverBackHook<A> {
    #[serde(default)]
    chat_key: Option<String>,
    #[serde(default)]
    session_key: Option<String>,
    #[serde(default)]
    launch_id: Option<String>,
    args: A,
}

/// Run one handover-back call for the chat its capability proves. The other
/// chat comes from the handover record, never from the call.
async fn handover_back<A: Send + 'static>(
    ctx: Ctx,
    headers: axum::http::HeaderMap,
    request: HandoverBackHook<A>,
    act: fn(&crate::dispatch::Services, &str, &str, A) -> Result<String, String>,
) -> Response {
    let claim = HookClaim {
        chat_key: request.chat_key.as_deref(),
        session_key: request.session_key.as_deref(),
        launch_id: request.launch_id.as_deref(),
    };
    let caller = match hook_caller(&ctx.services.chats, &headers, claim)
        .and_then(|caller| not_front_desk(&ctx, caller))
    {
        Ok(caller) => caller,
        Err(refused) => return hook_refusal(refused),
    };
    let services = ctx.services.clone();
    let args = request.args;
    let done = tokio::task::spawn_blocking(move || {
        crate::outcome::forget();
        act(&services, &caller.chat_key, &caller.session_key, args)
            .map_err(crate::outcome::classify)
    })
    .await
    .map_err(|error| crate::outcome::Refusal::from(error.to_string()))
    .and_then(|result| result);
    match done {
        Ok(text) => axum::Json(json!({ "result": { "text": text } })).into_response(),
        Err(refusal) => hook_failed(StatusCode::BAD_REQUEST, refusal),
    }
}

/// `handover_ask`: one question to the original chat's agent, answered in a
/// read-only fork of its conversation.
async fn handover_ask_handler(
    AxumState(ctx): AxumState<Ctx>,
    headers: axum::http::HeaderMap,
    Json(request): Json<HandoverBackHook<crate::handover::back::Question>>,
) -> Response {
    handover_back(ctx, headers, request, crate::handover::back::live_ask).await
}

/// `handover_outcome`: done or blocked, shown on the original chat's line.
async fn handover_outcome_handler(
    AxumState(ctx): AxumState<Ctx>,
    headers: axum::http::HeaderMap,
    Json(request): Json<HandoverBackHook<crate::handover::back::Report>>,
) -> Response {
    handover_back(ctx, headers, request, crate::handover::back::live_report).await
}

/// A chat-bound MCP call into the orchestration kernel.
///
/// This is intentionally a whitelist rather than a generic HTTP-to-dispatch
/// bridge. The token can already open the command socket, but an agent gets a
/// far narrower contract: coordination state, never arbitrary browser commands.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct OrchestrationHook {
    /// What the caller says it is. Only ever checked against what its
    /// capability proves; never believed on its own.
    #[serde(default)]
    chat_key: Option<String>,
    /// Which of the chat's processes is calling, when it is not the chat's
    /// own (`OCTIQ_SESSION_KEY`). Defaults to `chat_key`.
    #[serde(default)]
    session_key: Option<String>,
    action: String,
    #[serde(default)]
    args: Value,
}

/// The header an agent's MCP proves its chat with (`OCTIQ_CHAT_CAPABILITY`).
const CHAT_CAPABILITY_HEADER: &str = "x-octiq-chat-capability";

/// One launch of one chat, as its capability proves it.
#[derive(Debug, Clone, PartialEq, Eq)]
struct HookCaller {
    chat_key: String,
    /// The process key the capability was issued to: the chat's own, or an
    /// additional agent's.
    session_key: String,
    launch_id: String,
}

/// What a hook call says about who is calling. Claims only: each is checked
/// against the capability, never believed on its own.
#[derive(Default)]
struct HookClaim<'a> {
    chat_key: Option<&'a str>,
    session_key: Option<&'a str>,
    launch_id: Option<&'a str>,
}

/// Which launch of which chat is calling a `/hook/*` route, from the
/// capability the host gave that launch, or why the call is refused.
///
/// The token says nothing about which chat is calling, and an agent is never
/// given it, so it counts for nothing here. The body's `chatKey` is only a
/// claim — with no capability behind it a worker could name its run's
/// coordinator and act as it: accept its own work, approve, stop the run —
/// and one that disagrees with the capability is refused rather than
/// silently corrected. A missing, made-up, ended or replaced capability is
/// 401; a claim of another chat, session or launch is 403.
fn hook_caller(
    chats: &crate::agent_chat::ChatManager,
    headers: &axum::http::HeaderMap,
    claim: HookClaim<'_>,
) -> Result<HookCaller, (StatusCode, &'static str)> {
    let secret = headers
        .get(CHAT_CAPABILITY_HEADER)
        .and_then(|value| value.to_str().ok())
        .unwrap_or_default();
    if secret.is_empty() {
        return Err((
            StatusCode::UNAUTHORIZED,
            "This call has no chat capability. OctiqFlow's agent tools work only from a chat OctiqFlow started.",
        ));
    }
    let claimed = present(claim.chat_key);
    let session_key = present(claim.session_key)
        .or(claimed)
        .ok_or((StatusCode::BAD_REQUEST, "This call names no chat."))?;
    let (chat_key, launch_id) = chats.caller_for_capability(session_key, secret).ok_or((
        StatusCode::UNAUTHORIZED,
        "This chat capability is not current: its agent is no longer running, or it was issued to another chat.",
    ))?;
    if claimed.is_some_and(|claimed| claimed != chat_key)
        || present(claim.launch_id).is_some_and(|claimed| claimed != launch_id)
    {
        return Err((
            StatusCode::FORBIDDEN,
            "The chat named in this call is not the chat its capability belongs to.",
        ));
    }
    Ok(HookCaller {
        chat_key,
        session_key: session_key.to_string(),
        launch_id,
    })
}

/// An empty claim is no claim.
fn present(value: Option<&str>) -> Option<&str> {
    value.filter(|value| !value.is_empty())
}

/// A refused hook call, as the MCP reads one. A call with no chat in it is
/// malformed; every other refusal is about which chat may do this — scope.
fn hook_refusal((status, error): (StatusCode, &'static str)) -> Response {
    let reason = if status == StatusCode::BAD_REQUEST {
        crate::outcome::ReasonClass::Validation
    } else {
        crate::outcome::ReasonClass::ScopeRefused
    };
    hook_failed(status, crate::outcome::Refusal::new(reason, error))
}

const FRONT_DESK_ONLY: &str = "This is a front-desk chat: it only routes the person with route_chat, and every other OctiqFlow tool is refused.";

/// A front-desk chat routes and does nothing else (`handover::route`). Every
/// hook but `/hook/route` (and a question to the person) refuses it, by the
/// chat its capability proves, whatever its MCP offered.
fn not_front_desk(ctx: &Ctx, caller: HookCaller) -> Result<HookCaller, (StatusCode, &'static str)> {
    if crate::team::is_front_desk_chat(&ctx.services.handovers.team, &caller.chat_key) {
        return Err((StatusCode::FORBIDDEN, FRONT_DESK_ONLY));
    }
    Ok(caller)
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct RouteHook {
    #[serde(default)]
    chat_key: Option<String>,
    #[serde(default)]
    session_key: Option<String>,
    #[serde(default)]
    launch_id: Option<String>,
    args: crate::handover::route::RouteAsk,
}

/// The front desk proposing a chat with another agent. Like a handover it can
/// only RECORD a pending card for the person; it never waits, so the person
/// can talk on, and a newer proposal replaces the card.
async fn route_handler(
    AxumState(ctx): AxumState<Ctx>,
    headers: axum::http::HeaderMap,
    Json(request): Json<RouteHook>,
) -> Response {
    let claim = HookClaim {
        chat_key: request.chat_key.as_deref(),
        session_key: request.session_key.as_deref(),
        launch_id: request.launch_id.as_deref(),
    };
    let caller = match hook_caller(&ctx.services.chats, &headers, claim) {
        Ok(caller) => caller,
        Err(refused) => return hook_refusal(refused),
    };
    let services = ctx.services.clone();
    let ask = request.args;
    let recorded = tokio::task::spawn_blocking(move || {
        crate::outcome::forget();
        crate::handover::live_route_request(
            &services,
            &caller.chat_key,
            &caller.session_key,
            &caller.launch_id,
            ask,
        )
        .map_err(crate::outcome::classify)
    })
    .await
    .map_err(|error| crate::outcome::Refusal::from(error.to_string()))
    .and_then(|result| result);
    match recorded {
        Ok(record) => axum::Json(json!({
            "result": { "id": record.id, "text": crate::handover::route::proposed_text(&record) }
        }))
        .into_response(),
        Err(refusal) => hook_failed(StatusCode::BAD_REQUEST, refusal),
    }
}

/// Every action an agent may take on `/hook/orchestration`, and the command
/// each one runs. A whitelist, not a bridge: nothing the person alone decides
/// is on it (see the `the_hook_reaches_no_person_only_command` test).
const ORCHESTRATION_HOOK_ACTIONS: &[(&str, &str)] = &[
    ("run_create", "orchestration_run_create"),
    ("task_create", "orchestration_task_create"),
    ("task_revise", "orchestration_task_revise"),
    ("task_reassign", "orchestration_task_reassign"),
    // NOT the browser's `orchestration_plan_approve`: this one approves
    // only on the person's own message, which the host reads itself.
    ("plan_approve", "orchestration_plan_approve_in_chat"),
    ("destinations", "orchestration_destinations"),
    ("snapshot", "orchestration_snapshot"),
    ("worker_start", "orchestration_worker_start"),
    ("worker_report", "orchestration_worker_report"),
    // The run's coordinator settling a read-only worker from the words the
    // host held for it. Coordinator provenance is this capability's chat.
    ("report_confirm", "orchestration_report_confirm"),
    // A data-only notice to another run: same coordinator, or over a bridge
    // the person opened for exactly this pair and direction.
    ("relay_send", "orchestration_relay_send"),
    // A worker's question to a teammate on its own team. Read-only advice,
    // answered as that teammate; no handoff and no gate.
    ("peer_ask", "orchestration_peer_ask"),
    ("service_register", "orchestration_service_register"),
    ("workspace_refresh", "orchestration_workspace_refresh"),
    ("task_reopen", "orchestration_task_reopen"),
    // A lead accepting a report's result; never the person's acceptance.
    ("task_accept", "orchestration_task_accept_in_chat"),
    ("validation_create", "orchestration_validation_create"),
    ("validation_remove", "orchestration_validation_remove"),
    ("automation_configure", "orchestration_automation_configure"),
    ("dispatch_ready", "orchestration_dispatch_ready"),
    ("gate_create", "orchestration_gate_create"),
    ("gate_resolve", "orchestration_gate_resolve"),
    ("message_send", "orchestration_message_send"),
    ("run_stop", "orchestration_run_stop"),
];

fn orchestration_hook_command(action: &str) -> Option<&'static str> {
    ORCHESTRATION_HOOK_ACTIONS
        .iter()
        .find(|(name, _)| *name == action)
        .map(|(_, command)| *command)
}

async fn orchestration_handler(
    AxumState(ctx): AxumState<Ctx>,
    headers: axum::http::HeaderMap,
    Json(request): Json<OrchestrationHook>,
) -> Response {
    let claim = HookClaim {
        chat_key: request.chat_key.as_deref(),
        session_key: request.session_key.as_deref(),
        launch_id: None,
    };
    let actor = match hook_caller(&ctx.services.chats, &headers, claim)
        .and_then(|caller| not_front_desk(&ctx, caller))
    {
        Ok(caller) => caller.chat_key,
        Err(refused) => return hook_refusal(refused),
    };
    let invalid = |error: &str| {
        hook_failed(
            StatusCode::BAD_REQUEST,
            crate::outcome::Refusal::new(crate::outcome::ReasonClass::Validation, error),
        )
    };
    let Some(command) = orchestration_hook_command(&request.action) else {
        return invalid("Unknown orchestration action.");
    };
    let mut args = match request.args {
        Value::Object(args) => args,
        _ => return invalid("Orchestration arguments must be an object."),
    };
    args.insert("actorChatKey".into(), Value::String(actor));
    if command == "orchestration_run_create" {
        args.insert("withBrief".into(), Value::Bool(true));
    }
    match run_hook_command(&ctx, command.into(), Value::Object(args)).await {
        Ok(result) => axum::Json(json!({ "result": result })).into_response(),
        Err(refusal) => hook_failed(StatusCode::BAD_REQUEST, refusal),
    }
}

/// What an agent may say about its own task, and nothing else.
///
/// The chat is the one the caller's capability proves; this handler replaces
/// any supplied chatId with it. As with the
/// orchestration hook this is a whitelist, not a generic bridge to
/// the command table.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct TaskHook {
    /// A claim, checked against the capability like the orchestration hook's.
    #[serde(default)]
    chat_key: Option<String>,
    /// An additional agent's own process key (`OCTIQ_SESSION_KEY`).
    #[serde(default)]
    session_key: Option<String>,
    action: String,
    #[serde(default)]
    args: Value,
}

/// The chat a task, vault or feedback hook call acts for.
fn task_hook_caller(
    ctx: &Ctx,
    headers: &axum::http::HeaderMap,
    request: &TaskHook,
) -> Result<String, (StatusCode, &'static str)> {
    let claim = HookClaim {
        chat_key: request.chat_key.as_deref(),
        session_key: request.session_key.as_deref(),
        launch_id: None,
    };
    hook_caller(&ctx.services.chats, headers, claim)
        .and_then(|caller| not_front_desk(ctx, caller))
        .map(|caller| caller.chat_key)
}

/// Native vault operations only. Configuration is a browser setting, never an
/// agent tool; neither the root nor the write permission comes from tool args.
async fn vault_handler(
    AxumState(ctx): AxumState<Ctx>,
    headers: axum::http::HeaderMap,
    Json(request): Json<TaskHook>,
) -> Response {
    let chat_key = match task_hook_caller(&ctx, &headers, &request) {
        Ok(chat_key) => chat_key,
        Err(refused) => return hook_refusal(refused),
    };
    match run_hook_command(
        &ctx,
        "memory_vault_agent".into(),
        json!({
            "chatKey": chat_key, "action": request.action, "args": request.args,
        }),
    )
    .await
    {
        Ok(result) => axum::Json(json!({"result": result})).into_response(),
        Err(refusal) => hook_failed(StatusCode::BAD_REQUEST, refusal),
    }
}

async fn feedback_handler(
    AxumState(ctx): AxumState<Ctx>,
    headers: axum::http::HeaderMap,
    Json(request): Json<TaskHook>,
) -> Response {
    let chat_key = match task_hook_caller(&ctx, &headers, &request) {
        Ok(chat_key) => chat_key,
        Err(refused) => return hook_refusal(refused),
    };
    match run_hook_command(
        &ctx,
        "feedback_agent".into(),
        json!({
            "chatKey": chat_key, "action": request.action, "args": request.args,
        }),
    )
    .await
    {
        Ok(result) => axum::Json(json!({ "result": result })).into_response(),
        Err(refusal) => hook_failed(StatusCode::BAD_REQUEST, refusal),
    }
}

/// An agent reading the person's registered agents, or proposing to add or
/// change one (`team_tools`). A change is put to the person on the permission
/// card in the chat its capability proves, and saved only on their Allow; the
/// roster file stays the host's to validate and write.
async fn agents_handler(
    AxumState(ctx): AxumState<Ctx>,
    headers: axum::http::HeaderMap,
    Json(request): Json<TaskHook>,
) -> Response {
    let chat_key = match task_hook_caller(&ctx, &headers, &request) {
        Ok(chat_key) => chat_key,
        Err(refused) => return hook_refusal(refused),
    };
    match agents_hook(&ctx, &chat_key, &request.action, request.args).await {
        Ok(result) => axum::Json(json!({ "result": result })).into_response(),
        Err(refusal) => hook_failed(StatusCode::BAD_REQUEST, refusal),
    }
}

async fn agents_hook(
    ctx: &Ctx,
    chat_key: &str,
    action: &str,
    args: Value,
) -> Result<Value, crate::outcome::Refusal> {
    use crate::outcome::{ReasonClass, Refusal};
    use crate::team_tools::{Kind, Roster};
    let kind = match action {
        "list" | "policy_update" => None,
        "register" => Some(Kind::Register),
        "update" => Some(Kind::Update),
        _ => {
            return Err(Refusal::new(
                ReasonClass::Validation,
                "Unknown agents action.",
            ))
        }
    };
    let args = match args {
        Value::Null => json!({}),
        args => args,
    };
    let invalid = |error: serde_json::Error| {
        Refusal::new(
            ReasonClass::Validation,
            format!("Those arguments are not valid: {error}"),
        )
    };
    let team = ctx.services.handovers.team.clone();
    let roster = Roster::read(
        &team,
        crate::workspaces::list_workspaces_impl(&ctx.services.workspaces)?,
    )?;
    if action == "list" {
        return Ok(crate::team_tools::listing(
            &roster,
            serde_json::from_value(args).map_err(invalid)?,
        )?);
    }
    // A worker settles its own attempt; who is on the team is not its call.
    if ctx.services.orchestrations.active_task(chat_key)?.is_some() {
        return Err(Refusal::new(ReasonClass::ScopeRefused, "An orchestration worker cannot change the registered agents. Tell your coordinator what you need instead."));
    }
    let Some(kind) = kind else {
        let saved = crate::team_tools::propose_policy(
            &roster,
            &team,
            chat_key,
            serde_json::from_value(args).map_err(invalid)?,
            crate::permission::ask,
        )
        .await?;
        crate::bus::emit("team-changed", json!({ "policy": true }));
        return Ok(crate::team_tools::policy_saved_text(&saved));
    };
    let proposal = serde_json::from_value(args).map_err(invalid)?;
    let saved = crate::team_tools::propose(
        &roster,
        &team,
        chat_key,
        kind,
        proposal,
        crate::permission::ask,
    )
    .await?;
    let mut value = crate::team_tools::saved_text(kind, &saved);
    if let (Some(error), Some(object)) = (crate::team_tools::settle(&saved), value.as_object_mut())
    {
        object.insert("memoryError".into(), Value::String(error));
    }
    Ok(value)
}

/// A task hook's arguments, acting on `chat_key` whatever they say.
fn task_hook_args(
    chat_key: &str,
    args: Value,
) -> Result<serde_json::Map<String, Value>, &'static str> {
    let mut args = match args {
        Value::Object(args) => args,
        Value::Null => serde_json::Map::new(),
        _ => return Err("Task arguments must be an object."),
    };
    // `chat:<id>` is the key an agent knows itself by; the status store is
    // keyed by the chat id alone.
    let chat_id = chat_key.strip_prefix("chat:").unwrap_or(chat_key);
    args.insert("chatId".into(), Value::String(chat_id.into()));
    args.entry("setBy")
        .or_insert_with(|| Value::String("agent".into()));
    Ok(args)
}

async fn task_handler(
    AxumState(ctx): AxumState<Ctx>,
    headers: axum::http::HeaderMap,
    Json(request): Json<TaskHook>,
) -> Response {
    let chat_key = match task_hook_caller(&ctx, &headers, &request) {
        Ok(chat_key) => chat_key,
        Err(refused) => return hook_refusal(refused),
    };
    let command = match request.action.as_str() {
        "report" => "chat_task_report",
        "target" => "chat_task_set_target",
        "read" => "chat_task",
        "title" => "chat_set_agent_title",
        _ => {
            return hook_failed(
                StatusCode::BAD_REQUEST,
                crate::outcome::Refusal::new(
                    crate::outcome::ReasonClass::Validation,
                    "Unknown task action.",
                ),
            )
        }
    };
    let args = match task_hook_args(&chat_key, request.args) {
        Ok(args) => args,
        Err(error) => {
            return hook_failed(
                StatusCode::BAD_REQUEST,
                crate::outcome::Refusal::new(crate::outcome::ReasonClass::Validation, error),
            )
        }
    };
    match run_hook_command(&ctx, command.into(), Value::Object(args)).await {
        Ok(result) => axum::Json(json!({ "result": result })).into_response(),
        Err(refusal) => hook_failed(StatusCode::BAD_REQUEST, refusal),
    }
}

/// Commands that act as one particular lead chat, and so answer only that
/// chat's capability on `/hook/orchestration`. The socket is the person, who
/// has commands of their own for the same decisions; letting it run these
/// would record a lead's acceptance or approval that no lead gave.
const CHAT_ONLY_COMMANDS: &[&str] = &[
    "orchestration_task_accept_in_chat",
    "orchestration_plan_approve_in_chat",
    // Both record a coordinator as their author: a settled attempt's
    // confirmer, a relay's sender. Only that coordinator's capability says so.
    "orchestration_report_confirm",
    "orchestration_relay_send",
    // Starts a teammate's turn as the asking worker; only its capability
    // says which worker that is.
    "orchestration_peer_ask",
    // Acts as the chat's registered agent on its own memory, and what it
    // writes is shown in that chat as the agent's own update: only the
    // agent's capability, on /hook/vault, may say so.
    "memory_vault_agent",
];

/// Why the person's socket will not run `cmd`, if it will not.
fn socket_refusal(cmd: &str) -> Option<String> {
    CHAT_ONLY_COMMANDS.contains(&cmd).then(|| {
        format!("'{cmd}' is an agent's own command and only runs from its chat; use the person's command instead.")
    })
}

/// One connected browser: forward its invokes, stream events back.
async fn client(ctx: Ctx, socket: WebSocket) {
    crate::bus::client_joined();
    let mut events = crate::bus::events().subscribe();

    let (sink, mut stream) = socket.split();
    let sink = Arc::new(tokio::sync::Mutex::new(sink));

    // Events -> this browser.
    let out = sink.clone();
    let pump = tokio::spawn(async move {
        loop {
            match events.recv().await {
                Ok(text) => {
                    if out
                        .lock()
                        .await
                        .send(Message::Text(text.into()))
                        .await
                        .is_err()
                    {
                        break;
                    }
                }
                // Lagged: this client fell behind the backlog. Its terminals
                // will look like they skipped output, which is better than
                // holding up every other client — carry on from the newest.
                Err(broadcast::error::RecvError::Lagged(_)) => continue,
                Err(broadcast::error::RecvError::Closed) => break,
            }
        }
    });

    // Invokes -> the backend.
    while let Some(Ok(msg)) = stream.next().await {
        let Message::Text(text) = msg else {
            continue; // binary/ping frames carry nothing we read
        };
        let Ok(frame) = serde_json::from_str::<Value>(&text) else {
            continue;
        };
        if frame.get("t").and_then(Value::as_str) != Some("invoke") {
            continue;
        }
        let id = frame.get("id").and_then(Value::as_u64).unwrap_or(0);
        let cmd = frame
            .get("cmd")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_string();
        let args = frame.get("args").cloned().unwrap_or(Value::Null);

        // Each request runs on its own task: a slow command must not hold up
        // the keystrokes queued behind it.
        let ctx = ctx.clone();
        let out = sink.clone();
        tokio::spawn(async move {
            let outcome = match socket_refusal(&cmd) {
                Some(refused) => Err(refused),
                None => run_command(&ctx, cmd, args).await,
            };
            let reply = match outcome {
                Ok(result) => json!({ "t": "reply", "id": id, "ok": true, "result": result }),
                Err(error) => json!({ "t": "reply", "id": id, "ok": false, "error": error }),
            };
            if let Ok(text) = serde_json::to_string(&reply) {
                let _ = out.lock().await.send(Message::Text(text.into())).await;
            }
        });
    }

    pump.abort();
    crate::bus::client_left();
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn an_encoding_is_taken_unless_refused() {
        assert!(accepts_encoding("gzip, deflate, br, zstd", "br"));
        assert!(accepts_encoding("gzip;q=0.8, BR;q=1", "br"));
        assert!(!accepts_encoding("gzip, br;q=0", "br"));
        assert!(!accepts_encoding("gzip", "br"));
        assert!(!accepts_encoding("", "gzip"));
        assert!(!accepts_encoding("x-gzip", "gzip"));
    }

    #[test]
    fn a_precompressed_copy_is_sent_only_to_a_browser_that_takes_it() {
        let dir = crate::test_dir::TestDir::new("precompressed");
        let file = dir.join("index-abc.js");
        std::fs::write(&file, "x").unwrap();
        std::fs::write(dir.join("index-abc.js.gz"), "g").unwrap();
        assert_eq!(
            precompressed(&file, "gzip, br"),
            (dir.join("index-abc.js.gz"), Some("gzip"))
        );
        std::fs::write(dir.join("index-abc.js.br"), "b").unwrap();
        assert_eq!(
            precompressed(&file, "gzip, br"),
            (dir.join("index-abc.js.br"), Some("br"))
        );
        assert_eq!(precompressed(&file, "identity"), (file.clone(), None));
    }

    /// With every git slot taken, a git read waits and anything else does not.
    #[tokio::test]
    async fn a_git_backlog_never_holds_up_other_commands() {
        let slots = tokio::sync::Semaphore::new(GIT_READ_SLOTS);
        let _all = slots.acquire_many(GIT_READ_SLOTS as u32).await.unwrap();
        let wait = std::time::Duration::from_millis(50);

        let send = tokio::time::timeout(wait, gated(&slots, "chat_send", async { 1 })).await;
        assert_eq!(send, Ok(1), "chat_send waited on the git slots");

        for cmd in GIT_READS {
            let read = tokio::time::timeout(wait, gated(&slots, cmd, async { 1 })).await;
            assert!(read.is_err(), "{cmd} ran without a git slot");
        }
    }

    /// Build a HeaderMap from `(name, value)` pairs, for the tests below.
    fn headers(pairs: &[(&str, &str)]) -> axum::http::HeaderMap {
        use axum::http::header::HeaderName;
        let mut map = axum::http::HeaderMap::new();
        for (name, value) in pairs {
            map.insert(
                HeaderName::from_bytes(name.as_bytes()).unwrap(),
                value.parse().unwrap(),
            );
        }
        map
    }

    // ---- origin_ok: no cross-site page may open the socket -----------------

    #[test]
    fn a_client_that_sends_no_origin_is_allowed() {
        // curl, the permission hook, any non-browser caller. They still have to
        // know the token; Origin is not what gates them.
        assert!(origin_ok(&headers(&[("host", "localhost:1421")])));
    }

    #[test]
    fn a_page_on_our_own_origin_is_allowed() {
        assert!(origin_ok(&headers(&[
            ("host", "localhost:1421"),
            ("origin", "http://localhost:1421"),
        ])));
        assert!(origin_ok(&headers(&[
            ("host", "octiq.example.com"),
            ("origin", "https://octiq.example.com"),
        ])));
    }

    #[test]
    fn a_page_on_another_origin_is_refused() {
        assert!(!origin_ok(&headers(&[
            ("host", "localhost:1421"),
            ("origin", "http://evil.example"),
        ])));
        // A page served through the tunnel may not reach for another host.
        assert!(!origin_ok(&headers(&[
            ("host", "octiq.example.com"),
            ("origin", "http://localhost:5273"),
        ])));
    }

    #[test]
    fn a_rebound_page_is_stopped_by_the_host_rule_not_the_origin_one() {
        // Worth stating because the two rules answer different questions. Once
        // rebound, the attacker's page IS same-origin with this server — Origin
        // and Host both say `rebind.evil.com`, so the origin rule sees nothing
        // wrong and should not pretend otherwise.
        let rebound = headers(&[
            ("host", "rebind.evil.com:1421"),
            ("origin", "http://rebind.evil.com:1421"),
        ]);
        assert!(origin_ok(&rebound), "same origin is same origin");
        // What stops it is that nothing here hands a token to a request that
        // does not already carry one (see
        // `a_request_from_this_machine_alone_is_never_handed_the_token`), and
        // the socket asks for it.
    }

    #[test]
    fn the_dev_server_on_another_local_port_is_allowed() {
        // `pnpm dev` serves the client from 5273 and points it at the backend
        // on 1421. Both ends are loopback, so this is a page already on this
        // machine — which is not what the origin rule is guarding against.
        assert!(origin_ok(&headers(&[
            ("host", "127.0.0.1:1421"),
            ("origin", "http://localhost:5273"),
        ])));
        // An origin with no port at all. The desktop webview used to send this
        // one; the rule it exercises — a loopback authority is judged on the
        // host, not the port it omitted — outlived it.
        assert!(origin_ok(&headers(&[
            ("host", "127.0.0.1:1421"),
            ("origin", "tauri://localhost"),
        ])));
    }

    // ---- ct_eq: the token compare must not leak its answer in time ---------

    #[test]
    fn ct_eq_matches_only_an_identical_string() {
        assert!(ct_eq("a-token", "a-token"));
        assert!(!ct_eq("a-token", "a-tokeN"));
        assert!(!ct_eq("a-token", "a-token-longer"));
        assert!(!ct_eq("", ""), "an empty expected token matches nothing");
    }

    // ---- safe_relative_path: no climbing out of the served folder ----------

    #[test]
    fn an_ordinary_asset_path_is_kept() {
        assert_eq!(
            safe_relative_path("assets/index-abc123.js"),
            Some(std::path::PathBuf::from("assets/index-abc123.js"))
        );
    }

    #[test]
    fn nothing_that_climbs_or_reroots_survives() {
        for bad in [
            "../secrets",
            "a/../../secrets",
            // `\` is a separator on Windows, so a guard that splits on `/`
            // alone lets this through and `join` then climbs.
            r"..\..\secrets",
            // A drive letter is its own kind of absolute, and an absolute path
            // REPLACES the base in `Path::join` rather than joining to it.
            r"C:\Windows\win.ini",
            "C:/Windows/win.ini",
        ] {
            assert_eq!(safe_relative_path(bad), None, "{bad} must be refused");
        }
    }

    #[test]
    fn a_leading_slash_is_url_shape_not_an_escape() {
        // `GET /etc/passwd` asks for `etc/passwd` INSIDE the served folder,
        // which is an ordinary miss, not a traversal. The leading slash is how
        // every URL path is spelled; stripping it is not a concession.
        assert_eq!(
            safe_relative_path("/etc/passwd"),
            Some(std::path::PathBuf::from("etc/passwd"))
        );
    }

    // ---- network binds: a token is not a public identity system ----------

    #[test]
    fn a_loopback_bind_needs_no_external_access_layer() {
        let addr: SocketAddr = "127.0.0.1:1421".parse().unwrap();
        assert!(bind_has_access_control(addr, &WebConfig::default()));
    }

    #[test]
    fn a_network_bind_requires_a_complete_access_configuration() {
        let addr: SocketAddr = "0.0.0.0:1421".parse().unwrap();
        assert!(!bind_has_access_control(addr, &WebConfig::default()));
        let mut cfg = WebConfig::default();
        cfg.access.team_domain = "team.cloudflareaccess.com".into();
        cfg.access.aud = "audience-tag".into();
        assert!(bind_has_access_control(addr, &cfg));
    }

    // ---- legacy_root_redirect: the old /v2 address ------------------------

    #[test]
    fn the_old_v2_address_lands_on_the_root_with_its_query_intact() {
        assert_eq!(legacy_root_redirect("v2", None).as_deref(), Some("/"));
        assert_eq!(legacy_root_redirect("v2/", None).as_deref(), Some("/"));
        // The token rides along. Dropping it would send a saved link to a page
        // that immediately asks for a token the link was carrying all along.
        assert_eq!(
            legacy_root_redirect("v2/", Some("token=abc")).as_deref(),
            Some("/?token=abc")
        );
        assert_eq!(
            legacy_root_redirect("v2/assets/index.js", Some("token=abc")).as_deref(),
            Some("/?token=abc")
        );
    }

    #[test]
    fn a_path_that_merely_starts_with_v2_is_not_the_old_address() {
        for raw in ["", "v2x", "v20/thing", "assets/v2/index.js", "index.html"] {
            assert_eq!(
                legacy_root_redirect(raw, Some("token=abc")),
                None,
                "{raw} should be served, not redirected"
            );
        }
    }

    // ---- /file: browser pages are pages, but never our origin -------------

    #[test]
    fn html_files_are_served_as_browser_pages() {
        assert_eq!(
            file_mime(std::path::Path::new("report.html")),
            "text/html; charset=utf-8"
        );
        assert_eq!(
            file_mime(std::path::Path::new("REPORT.HTM")),
            "text/html; charset=utf-8"
        );
    }

    #[test]
    fn video_files_are_served_with_playable_content_types() {
        for (name, expected) in [
            ("preview.mp4", "video/mp4"),
            ("preview.webm", "video/webm"),
            ("preview.mov", "video/quicktime"),
        ] {
            assert_eq!(file_mime(std::path::Path::new(name)), expected);
        }
    }

    #[test]
    fn html_file_sandbox_never_grants_our_origin() {
        assert!(HTML_FILE_CSP.starts_with("sandbox"));
        assert!(!HTML_FILE_CSP.contains("allow-same-origin"));
        assert!(HTML_FILE_CSP.contains("allow-popups-to-escape-sandbox"));
    }

    // ---- /hook/orchestration: the caller is its capability, not its body ---

    /// POST to one of the running server's hooks. `token` goes in the query
    /// the way the MCP used to send the person's token; the MCP sends none.
    async fn post_hook(
        base: &str,
        route: &str,
        token: Option<&str>,
        capability: Option<&str>,
        body: Value,
    ) -> (u16, Value) {
        let url = match token {
            Some(token) => format!("{base}/hook/{route}?token={token}"),
            None => format!("{base}/hook/{route}"),
        };
        let capability = capability.map(str::to_owned);
        tokio::task::spawn_blocking(move || {
            let mut request = ureq::post(&url);
            if let Some(capability) = &capability {
                request = request.set(CHAT_CAPABILITY_HEADER, capability);
            }
            match request.send_json(body) {
                Ok(response) => (
                    response.status(),
                    response.into_json().unwrap_or(Value::Null),
                ),
                Err(ureq::Error::Status(code, response)) => {
                    (code, response.into_json().unwrap_or(Value::Null))
                }
                Err(error) => panic!("the hook could not be reached: {error}"),
            }
        })
        .await
        .unwrap()
    }

    /// POST to `/hook/orchestration` as an agent's MCP does: its capability
    /// and nothing else.
    async fn hook(base: &str, capability: Option<&str>, body: Value) -> (u16, Value) {
        post_hook(base, "orchestration", None, capability, body).await
    }

    /// GET a person surface with extra headers; the status is all that counts.
    async fn get_status(url: String, headers: Vec<(&'static str, String)>) -> u16 {
        tokio::task::spawn_blocking(move || {
            let mut request = ureq::get(&url);
            for (name, value) in &headers {
                request = request.set(name, value);
            }
            match request.call() {
                Ok(response) => response.status(),
                Err(ureq::Error::Status(code, _)) => code,
                Err(error) => panic!("{url} could not be reached: {error}"),
            }
        })
        .await
        .unwrap()
    }

    /// A server with the web token `hook-token`, on an ephemeral loopback
    /// port, over the given chats and store.
    async fn test_server(
        chats: Arc<crate::agent_chat::ChatManager>,
        store: Arc<crate::orchestration::OrchestrationStore>,
    ) -> (Ctx, String) {
        let cfg = WebConfig {
            token: "hook-token".into(),
            ..WebConfig::default()
        };
        test_server_with(cfg, chats, store).await
    }

    async fn test_server_with(
        cfg: WebConfig,
        chats: Arc<crate::agent_chat::ChatManager>,
        store: Arc<crate::orchestration::OrchestrationStore>,
    ) -> (Ctx, String) {
        test_server_handing_over(cfg, chats, store, crate::handover::Wiring::scratch()).await
    }

    /// `test_server_with`, keeping handovers where `handovers` says.
    async fn test_server_handing_over(
        cfg: WebConfig,
        chats: Arc<crate::agent_chat::ChatManager>,
        store: Arc<crate::orchestration::OrchestrationStore>,
        handovers: crate::handover::Wiring,
    ) -> (Ctx, String) {
        let ctx = Ctx {
            state: Arc::new(WebState::new(cfg)),
            services: crate::dispatch::Services {
                workspaces: Arc::new(crate::workspaces::WorkspaceState::load()),
                chats,
                watch: Arc::new(crate::file_watch::FileWatchState::default()),
                git_watch: Arc::new(crate::git_watch::GitWatchState::default()),
                orchestrations: store,
                ptys: Arc::new(crate::pty::PtyManager::default()),
                handovers,
            },
        };
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let base = format!("http://{}", listener.local_addr().unwrap());
        let service = router(ctx.clone()).into_make_service_with_connect_info::<SocketAddr>();
        tokio::spawn(async move { axum::serve(listener, service).await });
        (ctx, base)
    }

    // ---- two principals: a launch's capability is not the person ----------

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn a_launch_capability_opens_no_person_surface() {
        let store = Arc::new(crate::orchestration::OrchestrationStore::default());
        let chats = Arc::new(crate::agent_chat::ChatManager::default());
        let cap = chats.test_launch("chat:worker");
        let (_ctx, base) = test_server(chats.clone(), store).await;
        let file = crate::test_dir::TestPath::new("person-surface", "surface.txt");
        std::fs::write(&file, "person only").unwrap();
        let path = file.to_string_lossy().into_owned();

        // The person's token opens each of them — the control.
        assert_eq!(
            get_status(format!("{base}/auth?token=hook-token"), vec![]).await,
            200
        );
        assert_eq!(
            get_status(format!("{base}/file?token=hook-token&path={path}"), vec![]).await,
            200
        );
        // A running agent's capability, handed over as if it were the token,
        // or in the header the hooks read, opens none of them.
        for (given, header) in [
            (cap.as_str(), vec![]),
            ("", vec![(CHAT_CAPABILITY_HEADER, cap.clone())]),
        ] {
            assert_eq!(
                get_status(format!("{base}/auth?token={given}"), header.clone()).await,
                401,
                "/auth"
            );
            assert_eq!(
                get_status(
                    format!("{base}/file?token={given}&path={path}"),
                    header.clone()
                )
                .await,
                401,
                "/file"
            );
            let mut upgrade = header.clone();
            upgrade.extend([
                ("Connection", "Upgrade".to_string()),
                ("Upgrade", "websocket".to_string()),
                ("Sec-WebSocket-Version", "13".to_string()),
                ("Sec-WebSocket-Key", "dGhlIHNhbXBsZSBub25jZQ==".to_string()),
            ]);
            assert_eq!(
                get_status(format!("{base}/ws?token={given}"), upgrade).await,
                401,
                "/ws"
            );
        }
        chats.test_end("chat:worker");
    }

    /// GET a route and read the body too.
    async fn get_body(url: String, headers: Vec<(&'static str, String)>) -> (u16, String) {
        tokio::task::spawn_blocking(move || {
            let mut request = ureq::get(&url);
            for (name, value) in &headers {
                request = request.set(name, value);
            }
            match request.call() {
                Ok(response) => (
                    response.status(),
                    response.into_string().unwrap_or_default(),
                ),
                Err(ureq::Error::Status(code, response)) => {
                    (code, response.into_string().unwrap_or_default())
                }
                Err(error) => panic!("{url} could not be reached: {error}"),
            }
        })
        .await
        .unwrap()
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn a_request_from_this_machine_alone_is_never_handed_the_token() {
        // A web.json from before: the server wrote `local_token: true` into
        // every one, so it is not a choice anyone made and changes nothing.
        let cfg: WebConfig =
            serde_json::from_value(json!({ "token": "person-token", "local_token": true }))
                .unwrap();
        let store = Arc::new(crate::orchestration::OrchestrationStore::default());
        let chats = Arc::new(crate::agent_chat::ChatManager::default());
        let (_ctx, base) = test_server_with(cfg, chats, store).await;
        let port = base.rsplit(':').next().unwrap().to_string();
        // Loopback peer, loopback Host, no proxy header: everything the old
        // rule asked for, and all of it said by the caller.
        for host in [
            format!("127.0.0.1:{port}"),
            format!("localhost:{port}"),
            "[::1]".into(),
        ] {
            let (status, body) =
                get_body(format!("{base}/token"), vec![("Host", host.clone())]).await;
            assert_eq!(status, 403, "{host}");
            assert!(!body.contains("person-token"), "{host}: {body}");
        }
        // Nor does anything an agent holds open it.
        let (status, body) = get_body(
            format!("{base}/token"),
            vec![(CHAT_CAPABILITY_HEADER, "any".into())],
        )
        .await;
        assert_eq!(status, 403);
        assert!(!body.contains("person-token"));
        // The token itself still opens the person's routes: a browser that has
        // it, from a link or the Connect page, is in.
        assert_eq!(
            get_status(format!("{base}/auth?token=person-token"), vec![]).await,
            200
        );
        assert_eq!(get_status(format!("{base}/auth?token="), vec![]).await, 401);
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn with_access_configured_only_a_verified_sign_in_is_handed_the_token() {
        let mut cfg = WebConfig {
            token: "person-token".into(),
            ..WebConfig::default()
        };
        cfg.access.team_domain = "example.cloudflareaccess.com".into();
        cfg.access.aud = "aud-tag".into();
        assert!(cfg.access.is_configured());
        let store = Arc::new(crate::orchestration::OrchestrationStore::default());
        let chats = Arc::new(crate::agent_chat::ChatManager::default());
        let (_ctx, base) = test_server_with(cfg, chats, store).await;
        for headers in [
            vec![],
            vec![(crate::access::ASSERTION_HEADER, "not-a-jwt".to_string())],
        ] {
            let (status, body) = get_body(format!("{base}/token"), headers).await;
            assert_eq!(status, 403);
            assert!(!body.contains("person-token"), "{body}");
        }
    }

    /// A memory update is drawn in a chat only by that chat's own capability:
    /// naming another chat is refused before anything is written or drawn.
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn a_memory_line_cannot_be_drawn_in_another_chat() {
        let store = Arc::new(crate::orchestration::OrchestrationStore::default());
        let chats = Arc::new(crate::agent_chat::ChatManager::default());
        let worker = format!("chat:mem-worker-{}", uuid::Uuid::new_v4().simple());
        let victim = format!("chat:mem-victim-{}", uuid::Uuid::new_v4().simple());
        let cap = chats.test_launch(&worker);
        let (_ctx, base) = test_server(chats.clone(), store).await;
        let append = |chat: &str| {
            json!({
                "chatKey": chat, "sessionKey": worker, "action": "agent_memory_append",
                "args": { "text": "Forged.", "requestId": "r1", "chatKey": chat },
            })
        };
        let (status, answer) = post_hook(&base, "vault", None, Some(&cap), append(&victim)).await;
        assert_eq!(status, 403, "{answer}");
        let (status, answer) = post_hook(&base, "vault", None, None, append(&victim)).await;
        assert_eq!(status, 401, "{answer}");
        // Its own chat reaches the command (which refuses a chat the index
        // does not hold, before any vault is opened).
        let (status, answer) = post_hook(&base, "vault", None, Some(&cap), append(&worker)).await;
        assert_eq!(status, 400, "{answer}");
        assert!(
            answer["error"].as_str().unwrap().contains("chat index"),
            "{answer}"
        );
        assert!(crate::transcript::since(&victim, 0).is_empty());
        chats.test_end(&worker);
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn every_hook_takes_its_chat_from_the_capability_and_never_from_the_token() {
        let store = Arc::new(crate::orchestration::OrchestrationStore::default());
        let chats = Arc::new(crate::agent_chat::ChatManager::default());
        let worker = chats.test_launch("chat:worker");
        let ended = chats.test_launch("chat:ended");
        chats.test_end("chat:ended");
        let (_ctx, base) = test_server(chats.clone(), store).await;
        let question = json!([{ "question": "Which one?", "header": "Pick" }]);
        // Actions no hook knows: a call that got past authentication would
        // fail on them without touching anything, so a 400 here means the
        // credential check was passed.
        let bodies = |chat: &str| {
            [
                (
                    "orchestration",
                    json!({ "chatKey": chat, "action": "not-an-action", "args": {} }),
                ),
                (
                    "task",
                    json!({ "chatKey": chat, "action": "not-an-action", "args": {} }),
                ),
                (
                    "vault",
                    json!({ "chatKey": chat, "action": "not-an-action", "args": {} }),
                ),
                (
                    "feedback",
                    json!({ "chatKey": chat, "action": "not-an-action", "args": {} }),
                ),
                (
                    "agents",
                    json!({ "chatKey": chat, "action": "not-an-action", "args": {} }),
                ),
                ("ask", json!({ "chatKey": chat, "questions": question })),
                ("permission", json!({ "chatKey": chat, "toolName": "Bash" })),
                (
                    "handover",
                    json!({ "chatKey": chat, "args": {
                        "recipient": "self", "requestId": "r1",
                        "brief": { "objective": "carry on" },
                    } }),
                ),
            ]
        };

        for (route, body) in bodies("chat:worker") {
            // The person's token, with no capability: not an agent at all.
            let (status, answer) =
                post_hook(&base, route, Some("hook-token"), None, body.clone()).await;
            assert_eq!(status, 401, "/hook/{route} on the person's token: {answer}");
            // A made-up capability, and the capability of an ended launch.
            for cap in ["0123456789abcdef", ended.as_str()] {
                let (status, _) =
                    post_hook(&base, route, Some("hook-token"), Some(cap), body.clone()).await;
                assert_eq!(status, 401, "/hook/{route} on a dead capability");
            }
        }
        // A live capability naming another chat is refused, not corrected:
        // looked up as that chat it is nobody's (401), looked up under its
        // own session it is not that chat's (403).
        for (route, body) in bodies("chat:master") {
            let (status, answer) = post_hook(&base, route, None, Some(&worker), body.clone()).await;
            assert_eq!(status, 401, "/hook/{route} as another chat: {answer}");
            if route == "permission" {
                continue; // it names no session
            }
            let mut own_session = body;
            own_session["sessionKey"] = json!("chat:worker");
            let (status, answer) = post_hook(&base, route, None, Some(&worker), own_session).await;
            assert_eq!(status, 403, "/hook/{route} naming another chat: {answer}");
        }
        // Nor may a question claim another launch of its own chat.
        let (status, _) = post_hook(
            &base,
            "ask",
            None,
            Some(&worker),
            json!({ "chatKey": "chat:worker", "launchId": "not-this-launch", "questions": question }),
        )
        .await;
        assert_eq!(status, 403, "a question claiming another launch");
        // Its own capability, no token: the question reaches the chat the
        // capability proves, whose turn is not running, and says so.
        let (status, answer) = post_hook(
            &base,
            "ask",
            None,
            Some(&worker),
            json!({ "chatKey": "chat:worker", "questions": question }),
        )
        .await;
        assert_eq!(status, 200, "{answer}");
        assert!(
            answer["answer"]
                .as_str()
                .unwrap()
                .contains("turn has already ended"),
            "{answer}"
        );
        chats.test_end("chat:worker");
    }

    #[tokio::test]
    async fn a_handover_hook_records_at_most_and_never_from_a_worker() {
        let store = Arc::new(crate::orchestration::OrchestrationStore::default());
        let chats = Arc::new(crate::agent_chat::ChatManager::default());
        let worker = chats.test_launch("chat:orch-worker");
        let plain = chats.test_launch("chat:plain");
        let (_ctx, base) = test_server(chats.clone(), store).await;
        let body = |chat: &str| {
            json!({ "chatKey": chat, "wait": true, "args": {
                "recipient": "self", "requestId": "r1",
                "brief": { "objective": "carry on" },
            } })
        };
        // A worker on an attempt settles through its report instead.
        let (status, answer) = post_hook(
            &base,
            "handover",
            None,
            Some(&worker),
            body("chat:orch-worker"),
        )
        .await;
        assert_eq!(status, 400, "{answer}");
        assert!(
            answer["error"]
                .as_str()
                .unwrap()
                .contains("orchestration_worker_report"),
            "{answer}"
        );
        // An ordinary chat whose turn is not running cannot ask either.
        let (status, answer) =
            post_hook(&base, "handover", None, Some(&plain), body("chat:plain")).await;
        assert_eq!(status, 400, "{answer}");
        assert!(
            answer["error"]
                .as_str()
                .unwrap()
                .contains("turn has already ended"),
            "{answer}"
        );
        // And no hook names the person's decision: there is no action to
        // pass, and the orchestration whitelist has neither command.
        for command in [
            "handover_confirm",
            "handover_decline",
            "handover_abandon",
            "handover_discuss",
        ] {
            assert_eq!(orchestration_hook_command(command), None);
            assert!(!ORCHESTRATION_HOOK_ACTIONS
                .iter()
                .any(|(_, c)| *c == command));
        }
        chats.test_end("chat:orch-worker");
        chats.test_end("chat:plain");
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn an_agent_reads_the_roster_but_changes_nothing_the_person_did_not_approve() {
        let store = Arc::new(crate::orchestration::OrchestrationStore::default());
        let chats = Arc::new(crate::agent_chat::ChatManager::default());
        let wiring = crate::handover::Wiring::scratch();
        let team = wiring.team.clone();
        crate::team::save(
            &team,
            crate::team::TeamDraft {
                id: None,
                name: "Potato".into(),
                role: "Leads.".into(),
                agent: crate::agent_chat::ChatAgent::Claude,
                model: "opus".into(),
                effort: None,
                access: None,
                project_id: None,
                reports_to: None,
                avatar: None,
                team_id: None,
                persistent_prompt: None,
            },
        )
        .unwrap();
        let lead = chats.test_launch("chat:lead");
        let cfg = WebConfig {
            token: "hook-token".into(),
            ..WebConfig::default()
        };
        let (_ctx, base) = test_server_handing_over(cfg, chats.clone(), store, wiring).await;
        let call = |action: &str, args: Value| json!({ "chatKey": "chat:lead", "action": action, "args": args });

        let (status, answer) =
            post_hook(&base, "agents", None, Some(&lead), call("list", json!({}))).await;
        assert_eq!(status, 200, "{answer}");
        assert_eq!(answer["result"]["agents"][0]["name"], "Potato");

        // The Settings form's rules answer before anyone is asked…
        let clash = json!({ "name": "potato", "provider": "codex", "model": "gpt-5.5" });
        let (status, answer) =
            post_hook(&base, "agents", None, Some(&lead), call("register", clash)).await;
        assert_eq!(status, 400);
        assert_eq!(answer["error"], "Another agent is already called potato.");
        assert_eq!(answer["outcome"]["origin"], "octiqflow");
        assert_eq!(answer["outcome"]["reasonClass"], "validation");
        // …and a valid change with nobody there to approve it saves nothing.
        let nova = json!({ "name": "Nova", "provider": "codex", "model": "gpt-5.5" });
        let (status, answer) =
            post_hook(&base, "agents", None, Some(&lead), call("register", nova)).await;
        assert_eq!(status, 400);
        assert!(
            answer["error"]
                .as_str()
                .unwrap()
                .starts_with("Nobody has OctiqFlow open to approve this"),
            "{answer}"
        );
        assert_eq!(answer["outcome"]["origin"], "octiqflow", "{answer}");
        assert_eq!(crate::team::list(&team, None, true).unwrap().len(), 1);
        chats.test_end("chat:lead");
    }

    /// Every hook failure says it is OctiqFlow's, and what kind, so the agent's
    /// failed tool call is never drawn as the provider's.
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn a_hook_failure_says_it_is_octiqflows_and_what_kind() {
        let store = Arc::new(crate::orchestration::OrchestrationStore::default());
        let chats = Arc::new(crate::agent_chat::ChatManager::default());
        let lead = chats.test_launch("chat:outcomes");
        let (_ctx, base) = test_server(chats.clone(), store).await;
        let call = |action: &str, args: Value| json!({ "chatKey": "chat:outcomes", "action": action, "args": args });
        let kind = |answer: &Value| {
            assert_eq!(answer["outcome"]["origin"], "octiqflow", "{answer}");
            answer["outcome"]["reasonClass"]
                .as_str()
                .unwrap()
                .to_string()
        };

        // No capability: which chat may do this is the host's refusal.
        let (status, answer) = hook(&base, None, call("snapshot", json!({}))).await;
        assert_eq!(status, 401);
        assert_eq!(kind(&answer), "scope-refused");
        // An action no hook knows, and arguments of the wrong shape.
        let (status, answer) = hook(&base, Some(&lead), call("not-an-action", json!({}))).await;
        assert_eq!(status, 400);
        assert_eq!(kind(&answer), "validation");
        let (_, answer) = hook(&base, Some(&lead), call("snapshot", json!([1]))).await;
        assert_eq!(kind(&answer), "validation");
        // A bad argument refused deep inside the command keeps its kind on
        // the way out (`outcome::refuse` → `classify`).
        let (status, answer) =
            hook(&base, Some(&lead), call("snapshot", json!({ "runId": 5 }))).await;
        assert_eq!(status, 400, "{answer}");
        assert!(answer["error"]
            .as_str()
            .unwrap()
            .contains("bad argument 'runId'"));
        assert_eq!(kind(&answer), "validation");
        // Anything the host has not named is still OctiqFlow's.
        let (_, answer) = post_hook(
            &base,
            "task",
            None,
            Some(&lead),
            json!({ "chatKey": "chat:outcomes", "action": "not-an-action", "args": {} }),
        )
        .await;
        assert_eq!(kind(&answer), "validation");
        chats.test_end("chat:outcomes");
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn a_front_desk_chat_may_only_route_and_only_a_front_desk_may() {
        let store = Arc::new(crate::orchestration::OrchestrationStore::default());
        let chats = Arc::new(crate::agent_chat::ChatManager::default());
        let wiring = crate::handover::Wiring::scratch();
        let desk = crate::team::create_front_desk(&wiring.team, Default::default()).unwrap();
        crate::team::brief(&wiring.team, "chat:desk", "p1", &desk.id, "Hi", false, &[]).unwrap();
        let desk_cap = chats.test_launch("chat:desk");
        let plain = chats.test_launch("chat:plain");
        let cfg = WebConfig {
            token: "hook-token".into(),
            ..WebConfig::default()
        };
        let (_ctx, base) = test_server_handing_over(cfg, chats.clone(), store, wiring).await;
        // Every agent hook but a question to the person refuses it outright,
        // whatever its MCP offered.
        for (route, body) in [
            (
                "orchestration",
                json!({ "chatKey": "chat:desk", "action": "run_create", "args": {} }),
            ),
            (
                "task",
                json!({ "chatKey": "chat:desk", "action": "report", "args": {} }),
            ),
            (
                "vault",
                json!({ "chatKey": "chat:desk", "action": "write", "args": {} }),
            ),
            (
                "feedback",
                json!({ "chatKey": "chat:desk", "action": "submit", "args": {} }),
            ),
            (
                "agents",
                json!({ "chatKey": "chat:desk", "action": "register", "args": {} }),
            ),
            (
                "handover",
                json!({ "chatKey": "chat:desk", "args": {
                    "recipient": "self", "requestId": "r1", "brief": { "objective": "x" },
                } }),
            ),
            (
                "handover/outcome",
                json!({ "chatKey": "chat:desk", "args": {
                    "requestId": "o1", "status": "done", "summary": "x",
                } }),
            ),
        ] {
            let (status, answer) = post_hook(&base, route, None, Some(&desk_cap), body).await;
            assert_eq!(status, 403, "/hook/{route}: {answer}");
            assert!(
                answer["error"]
                    .as_str()
                    .unwrap()
                    .contains("front-desk chat"),
                "{answer}"
            );
        }
        let route = |chat: &str| {
            json!({ "chatKey": chat, "args": {
                "agent": "Anyone", "brief": "help", "requestId": "r1",
            } })
        };
        // /hook/route takes the front desk past its identity check: what
        // stops this call is only that its turn is not running.
        let (status, answer) =
            post_hook(&base, "route", None, Some(&desk_cap), route("chat:desk")).await;
        assert_eq!(status, 400, "{answer}");
        assert!(
            !answer["error"]
                .as_str()
                .unwrap()
                .contains("Only the front desk"),
            "{answer}"
        );
        // Any other chat is refused by identity.
        let (status, answer) =
            post_hook(&base, "route", None, Some(&plain), route("chat:plain")).await;
        assert_eq!(status, 400, "{answer}");
        assert!(
            answer["error"]
                .as_str()
                .unwrap()
                .contains("Only the front desk routes"),
            "{answer}"
        );
        chats.test_end("chat:desk");
        chats.test_end("chat:plain");
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn handover_back_hooks_take_the_chat_from_the_capability_and_refuse_workers() {
        let store = Arc::new(crate::orchestration::OrchestrationStore::default());
        let chats = Arc::new(crate::agent_chat::ChatManager::default());
        let worker = chats.test_launch("chat:orch-worker");
        let plain = chats.test_launch("chat:plain");
        let (_ctx, base) = test_server(chats.clone(), store).await;
        let ask = |chat: &str| {
            json!({ "chatKey": chat, "args": {
                "requestId": "q1", "question": "Which lock?",
                // Not a field: the other chat is never the caller's word.
                "sourceChatKey": "chat:plain",
            } })
        };
        let outcome = |chat: &str| {
            json!({ "chatKey": chat, "args": {
                "requestId": "o1", "status": "done", "summary": "Shipped.",
            } })
        };
        // No capability, no call.
        let (status, _) = post_hook(&base, "handover/ask", None, None, ask("chat:plain")).await;
        assert_eq!(status, 401);
        // A capability speaks for its own chat only.
        let (status, _) = post_hook(
            &base,
            "handover/ask",
            None,
            Some(&plain),
            ask("chat:orch-worker"),
        )
        .await;
        assert_eq!(status, 401);
        for (route, body) in [
            ("handover/ask", ask as fn(&str) -> Value),
            ("handover/outcome", outcome),
        ] {
            let (status, answer) =
                post_hook(&base, route, None, Some(&worker), body("chat:orch-worker")).await;
            assert_eq!(status, 400, "{answer}");
            assert!(
                answer["error"]
                    .as_str()
                    .unwrap()
                    .contains("orchestration_worker_report"),
                "{answer}"
            );
            // A chat no handover started has no one to ask or report to.
            let (status, answer) =
                post_hook(&base, route, None, Some(&plain), body("chat:plain")).await;
            assert_eq!(status, 400, "{answer}");
            assert!(
                answer["error"]
                    .as_str()
                    .unwrap()
                    .contains("not started by a confirmed handover"),
                "{answer}"
            );
        }
        chats.test_end("chat:orch-worker");
        chats.test_end("chat:plain");
    }

    /// The person's socket running one command, as `client` does for an
    /// `invoke` frame.
    async fn socket_invoke(ctx: &Ctx, cmd: &str, args: Value) -> Result<Value, String> {
        if let Some(refused) = socket_refusal(cmd) {
            return Err(refused);
        }
        run_command(ctx, cmd.to_string(), args).await
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn a_handover_hook_records_it_pending_and_only_the_persons_confirm_starts_its_chat() {
        use crate::handover::tests::{
            git, is_waiting, mend_store, project, register, repo, scratch, FakeHost,
        };
        use crate::handover::Status;
        let root = scratch("hook");
        let app = repo(&root, "app");
        let tree = root.join("app-work");
        git(
            &app,
            &[
                "worktree",
                "add",
                "-q",
                "-b",
                "work",
                &tree.to_string_lossy(),
            ],
        );
        let team = root.join("team.json");
        register(
            &team,
            "Mango",
            Some("p-app"),
            "sonnet",
            crate::agent_chat::Access::Edits,
        );
        let host = Arc::new(FakeHost {
            projects: vec![project("p-app", "App", &[&app])],
            team: team.clone(),
            root: root.to_path_buf(),
            ..FakeHost::default()
        });
        let store_path = root.join("handovers.json");
        let wiring = crate::handover::Wiring {
            store: store_path.clone(),
            team,
            host: Some(host.clone()),
            _scratch: None,
        };
        let chats = Arc::new(crate::agent_chat::ChatManager::default());
        // A source chat working in the worktree, mid-turn, as an agent
        // calling the tool is.
        let launch = |key: &str| {
            let capability = chats.test_launch(key);
            chats.test_remember_start(key, &tree.to_string_lossy());
            chats.test_busy(key, true);
            capability
        };
        let cfg = WebConfig {
            token: "hook-token".into(),
            ..WebConfig::default()
        };
        let orchestrations = Arc::new(crate::orchestration::OrchestrationStore::default());
        let (ctx, base) =
            test_server_handing_over(cfg, chats.clone(), orchestrations, wiring).await;
        let body = |chat: &str, wait: bool| {
            json!({ "chatKey": chat, "wait": wait, "args": {
                "recipient": "Mango", "project": "App", "requestId": "r1",
                "brief": { "objective": "Finish the login fix" },
            } })
        };
        let status_of = |id: &str| {
            crate::handover::list(&store_path)
                .unwrap()
                .into_iter()
                .find(|h| h.id == id)
                .map(|h| h.status)
        };

        // The agent asks, and its call waits for the person.
        let first = launch("chat:handing");
        let asking = {
            let (base, body) = (base.clone(), body("chat:handing", true));
            tokio::spawn(
                async move { post_hook(&base, "handover", None, Some(&first), body).await },
            )
        };
        let mut recorded = Vec::new();
        for _ in 0..300 {
            recorded = crate::handover::list(&store_path).unwrap();
            if recorded.first().is_some_and(|h| is_waiting(&h.id)) {
                break;
            }
            tokio::time::sleep(std::time::Duration::from_millis(10)).await;
        }
        assert_eq!(recorded.len(), 1, "one handover recorded");
        let id = recorded[0].id.clone();
        assert!(is_waiting(&id), "the call is held open");
        // Pending, on disk, and nothing exists for it yet.
        let raw: Value = serde_json::from_slice(&std::fs::read(&store_path).unwrap()).unwrap();
        assert_eq!(raw["handovers"][&id]["status"], json!("pending"));
        assert_eq!(
            raw["handovers"][&id]["workspace"]["mode"],
            json!("continue")
        );
        assert!(raw["handovers"][&id].get("targetChatKey").is_none());
        assert!(host.starts.lock().unwrap().is_empty(), "no chat started");
        assert!(host.saved.lock().unwrap().is_empty(), "no chat indexed");
        assert!(!asking.is_finished());

        // The person's socket confirms it: exactly one chat.
        let confirmed = socket_invoke(&ctx, "handover_confirm", json!({ "id": id }))
            .await
            .unwrap();
        assert_eq!(confirmed["status"], json!("confirmed"), "{confirmed}");
        let (status, answer) = asking.await.unwrap();
        assert_eq!(status, 200, "{answer}");
        let told = answer["result"]["text"].as_str().unwrap();
        assert!(told.contains("confirmed handover"), "{told}");
        socket_invoke(&ctx, "handover_confirm", json!({ "id": id }))
            .await
            .unwrap();
        let starts = host.starts.lock().unwrap().clone();
        assert_eq!(starts.len(), 1, "a second confirm starts nothing");
        assert_eq!(confirmed["targetChatKey"], json!(starts[0].key));
        assert!(
            starts[0]
                .prompt
                .contains("was still waiting on its handover call"),
            "{}",
            starts[0].prompt
        );

        // The checkout's branch switches before the person confirms.
        let second = launch("chat:second");
        let (status, answer) = post_hook(
            &base,
            "handover",
            None,
            Some(&second),
            body("chat:second", false),
        )
        .await;
        assert_eq!(status, 200, "{answer}");
        let second_id = answer["result"]["id"].as_str().unwrap().to_owned();
        git(&tree, &["checkout", "-q", "-b", "elsewhere"]);
        let refused = socket_invoke(&ctx, "handover_confirm", json!({ "id": second_id }))
            .await
            .unwrap_err();
        assert!(
            refused.contains("now has branch elsewhere checked out, not branch work"),
            "{refused}"
        );
        assert_eq!(host.starts.lock().unwrap().len(), 1);
        assert_eq!(status_of(&second_id), Some(Status::Pending));
        let declined = socket_invoke(&ctx, "handover_decline", json!({ "id": second_id }))
            .await
            .unwrap();
        assert_eq!(declined["status"], json!("declined"));

        // Started, then its record cannot be saved: never declined, and a
        // restart finishes it without a second start.
        let third = launch("chat:third");
        let (status, answer) = post_hook(
            &base,
            "handover",
            None,
            Some(&third),
            body("chat:third", false),
        )
        .await;
        assert_eq!(status, 200, "{answer}");
        let third_id = answer["result"]["id"].as_str().unwrap().to_owned();
        chats.test_busy("chat:third", false);
        *host.break_store.lock().unwrap() = Some(store_path.clone());
        socket_invoke(&ctx, "handover_confirm", json!({ "id": third_id }))
            .await
            .unwrap_err();
        assert_eq!(host.starts.lock().unwrap().len(), 2, "the chat did start");
        mend_store(&store_path);
        assert_eq!(status_of(&third_id), Some(Status::Starting));
        let refused = socket_invoke(&ctx, "handover_decline", json!({ "id": third_id }))
            .await
            .unwrap_err();
        assert!(refused.contains("can no longer be declined"), "{refused}");
        crate::handover::live_recover(&ctx.services);
        assert_eq!(status_of(&third_id), Some(Status::Confirmed));
        assert_eq!(host.starts.lock().unwrap().len(), 2, "never started twice");
        // Both callers that let go are told by a continuation, once each.
        let told = host.told.lock().unwrap().clone();
        let chats_told: Vec<&str> = told.iter().map(|(chat, _)| chat.as_str()).collect();
        assert_eq!(chats_told, ["chat:second", "chat:third"], "{told:?}");
        assert!(told[0].1.contains("declined handover"), "{}", told[0].1);
        assert!(told[1].1.contains("confirmed handover"), "{}", told[1].1);

        // A start that keeps failing, where no chat was started: the person
        // gives up on it from the socket, and nothing is created.
        let fourth = launch("chat:fourth");
        let (status, answer) = post_hook(
            &base,
            "handover",
            None,
            Some(&fourth),
            body("chat:fourth", false),
        )
        .await;
        assert_eq!(status, 200, "{answer}");
        let fourth_id = answer["result"]["id"].as_str().unwrap().to_owned();
        chats.test_busy("chat:fourth", false);
        *host.fail_start.lock().unwrap() = true;
        socket_invoke(&ctx, "handover_confirm", json!({ "id": fourth_id }))
            .await
            .unwrap_err();
        let given_up = socket_invoke(&ctx, "handover_abandon", json!({ "id": fourth_id }))
            .await
            .unwrap();
        assert_eq!(given_up["status"], json!("abandoned"), "{given_up}");
        assert_eq!(host.starts.lock().unwrap().len(), 2, "nothing more started");
        let told = host.told.lock().unwrap().clone();
        assert_eq!(
            told.last().map(|(chat, _)| chat.as_str()),
            Some("chat:fourth")
        );

        for key in ["chat:handing", "chat:second", "chat:third", "chat:fourth"] {
            chats.test_end(key);
        }
    }

    #[test]
    fn a_task_hook_acts_on_the_proven_chat() {
        let args =
            task_hook_args("chat:worker", json!({ "chatId": "master", "branch": "x" })).unwrap();
        assert_eq!(args["chatId"], json!("worker"));
        assert_eq!(args["setBy"], json!("agent"));
        assert_eq!(args["branch"], json!("x"));
        assert!(task_hook_args("chat:worker", json!("nope")).is_err());
    }

    /// Commands only the person gives. Nothing on a hook may reach them.
    const PERSON_ONLY: &[&str] = &[
        "orchestration_task_accept",
        "orchestration_task_size",
        "orchestration_plan_approve",
        "orchestration_plan_reject",
        "orchestration_run_archive",
        "orchestration_master_start",
        "orchestration_bridge_open",
        "orchestration_bridge_close",
        "orchestration_task_access",
        "team_head_set",
        // An agent only proposes these, on a card (`team_tools`).
        "team_save",
        "team_policy_set",
        // Every chat's system prompt carries these; only Settings writes them.
        "personal_preferences_set",
        // What makes a chat a front desk (hidden, route-only) is the
        // person's: the brief that records it and who the front desk is.
        "team_brief",
        "team_front_desk_set",
        "team_front_desk_create",
        // A handover is created by an agent but only the person decides it.
        "handover_confirm",
        "handover_decline",
        "handover_abandon",
        "handover_discuss",
    ];

    #[test]
    fn the_hook_reaches_no_person_only_command() {
        for (action, command) in ORCHESTRATION_HOOK_ACTIONS {
            assert!(
                !PERSON_ONLY.contains(command),
                "hook action {action} reaches the person's {command}"
            );
            assert_eq!(orchestration_hook_command(action), Some(*command));
        }
        for command in PERSON_ONLY {
            assert_eq!(orchestration_hook_command(command), None);
        }
        assert_eq!(
            orchestration_hook_command("task_accept"),
            Some("orchestration_task_accept_in_chat")
        );
    }

    #[test]
    fn the_socket_refuses_what_only_a_proven_lead_chat_may_do() {
        for command in [
            "orchestration_task_accept_in_chat",
            "orchestration_plan_approve_in_chat",
            "orchestration_report_confirm",
            "orchestration_relay_send",
            "orchestration_peer_ask",
            "memory_vault_agent",
        ] {
            assert!(socket_refusal(command).is_some(), "{command}");
        }
        for command in [
            "orchestration_task_accept",
            "orchestration_plan_approve",
            "orchestration_plan_reject",
            "orchestration_bridge_open",
            "orchestration_bridge_close",
            "chat_send",
            "memory_vault_call",
        ] {
            assert!(socket_refusal(command).is_none(), "{command}");
        }
    }

    fn accept(chat_key: &str, session_key: Option<&str>, task: &str, attempt: &str) -> Value {
        let mut body = json!({
            "chatKey": chat_key,
            "action": "task_accept",
            "args": { "taskId": task, "attemptId": attempt },
        });
        if let Some(session_key) = session_key {
            body["sessionKey"] = json!(session_key);
        }
        body
    }

    fn agent(id: &str) -> crate::team::TeamAgent {
        crate::team::TeamAgent {
            id: id.into(),
            name: id.to_uppercase(),
            role: String::new(),
            agent: crate::agent_chat::ChatAgent::Claude,
            model: "opus".into(),
            effort: None,
            access: crate::agent_provider::Access::Auto,
            project_id: None,
            reports_to: None,
            memory_note: None,
            avatar: None,
            team_id: None,
            created_at: 0,
            updated_at: 0,
            persistent_prompt: String::new(),
        }
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn only_a_chats_own_capability_can_accept_and_only_as_that_chat() {
        use crate::orchestration::levels::tests::{ada, assigned, settle, start};
        use crate::orchestration::{OrchestrationStore, TaskAssignee, WorkerOutcome};

        // Leads live in team.json; this test's are in a throwaway one.
        let root = crate::test_dir::TestDir::new("hook");
        let team = root.join("team.json");
        let _team = crate::team::use_test_path(team.clone());
        crate::team::record_lead(&team, "chat:master", &agent("agent_lead"), "project", false)
            .unwrap();
        crate::team::record_lead(&team, "chat:other", &agent("agent_other"), "project", false)
            .unwrap();

        let store = Arc::new(OrchestrationStore::default());
        let run = crate::orchestration::tests::run(&store);
        store
            .create_run(
                "chat:other".into(),
                "Another run".into(),
                "workspace".into(),
                "/tmp".into(),
                Some(1),
            )
            .unwrap();
        // Ada's finished task, and one the coordinator's own lead did.
        let task = assigned(&store, &run, "chat:master", ada(), None);
        let attempt = start(&store, "chat:master", &task);
        settle(&store, &attempt, WorkerOutcome::Completed);
        let lead_self = TaskAssignee {
            id: "agent_lead".into(),
            name: "Lead".into(),
        };
        let own = assigned(&store, &run, "chat:master", lead_self, None);
        let own_attempt = start(&store, "chat:master", &own);
        settle(&store, &own_attempt, WorkerOutcome::Completed);
        let for_person = assigned(&store, &run, "chat:master", ada(), None);
        let person_attempt = start(&store, "chat:master", &for_person);
        settle(&store, &person_attempt, WorkerOutcome::Completed);

        let mut chats = crate::agent_chat::ChatManager::default();
        chats.orchestrations = store.clone();
        let chats = Arc::new(chats);
        let worker = attempt.worker_chat_key.clone();
        let worker_cap = chats.test_launch(&worker);
        let stale_cap = chats.test_launch("chat:master");
        let other_cap = chats.test_launch("chat:other");
        let (ctx, base) = test_server(chats.clone(), store.clone()).await;

        let nothing_accepted = |store: &OrchestrationStore| {
            let snapshot = store.snapshot(None).unwrap();
            assert!(snapshot.tasks.iter().all(|t| t.acceptance.is_none()));
            assert!(store.level_summaries().unwrap().is_empty());
        };

        // The worker names its coordinator, with its own capability: the
        // capability is not the coordinator's, whichever key it is read under.
        let (status, _) = hook(
            &base,
            Some(&worker_cap),
            accept("chat:master", None, &task.id, &attempt.id),
        )
        .await;
        assert_eq!(
            status, 401,
            "forged coordinator, looked up as the coordinator"
        );
        let (status, answer) = hook(
            &base,
            Some(&worker_cap),
            accept("chat:master", Some(&worker), &task.id, &attempt.id),
        )
        .await;
        assert_eq!(
            status, 403,
            "forged coordinator, looked up as itself: {answer}"
        );
        // The person's token alone, naming the coordinator.
        let (status, _) = post_hook(
            &base,
            "orchestration",
            Some("hook-token"),
            None,
            accept("chat:master", None, &task.id, &attempt.id),
        )
        .await;
        assert_eq!(status, 401, "no capability");
        // A made-up capability.
        let (status, _) = hook(
            &base,
            Some("0123456789abcdef"),
            accept("chat:master", None, &task.id, &attempt.id),
        )
        .await;
        assert_eq!(status, 401);
        // Its own capability, as itself: the hook lets it through and the
        // store says no — a worker is not the lead.
        let (status, answer) = hook(
            &base,
            Some(&worker_cap),
            accept(&worker, None, &task.id, &attempt.id),
        )
        .await;
        assert_eq!(status, 400);
        assert!(
            answer["error"]
                .as_str()
                .unwrap()
                .contains("Only the person"),
            "{answer}"
        );
        // The other run's coordinator, a real lead, but not this run's.
        let (status, answer) = hook(
            &base,
            Some(&other_cap),
            accept("chat:other", None, &task.id, &attempt.id),
        )
        .await;
        assert_eq!(status, 400, "wrong run");
        assert!(
            answer["error"]
                .as_str()
                .unwrap()
                .contains("Only the person"),
            "{answer}"
        );
        // The coordinator's lead did the work itself.
        let (status, answer) = hook(
            &base,
            Some(&stale_cap),
            accept("chat:master", None, &own.id, &own_attempt.id),
        )
        .await;
        assert_eq!(status, 400, "self");
        assert!(
            answer["error"].as_str().unwrap().contains("own work"),
            "{answer}"
        );
        // The person's own command is not on the hook at all.
        let (status, _) = hook(
            &base,
            Some(&stale_cap),
            json!({ "chatKey": "chat:master", "action": "orchestration_task_accept",
                    "args": { "taskId": task.id, "attemptId": attempt.id } }),
        )
        .await;
        assert_eq!(status, 400, "no person acceptance through the hook");
        nothing_accepted(&store);

        // The coordinator's process ends and it is started again: the old
        // launch's capability is dead, the new one works.
        chats.test_end("chat:master");
        let (status, _) = hook(
            &base,
            Some(&stale_cap),
            accept("chat:master", None, &task.id, &attempt.id),
        )
        .await;
        assert_eq!(status, 401, "an ended launch's capability");
        let master_cap = chats.test_launch("chat:master");
        assert_ne!(master_cap, stale_cap);
        let (status, _) = hook(
            &base,
            Some(&stale_cap),
            accept("chat:master", None, &task.id, &attempt.id),
        )
        .await;
        assert_eq!(status, 401, "a replaced launch's capability");
        nothing_accepted(&store);

        let (status, answer) = hook(
            &base,
            Some(&master_cap),
            accept("chat:master", None, &task.id, &attempt.id),
        )
        .await;
        assert_eq!(status, 200, "the scoped lead: {answer}");
        assert_eq!(answer["result"]["awarded"], json!(true));
        assert_eq!(
            answer["result"]["award"]["acceptedBy"]["agentId"],
            json!("agent_lead")
        );
        // The person's token is neither needed nor enough on a hook: the MCP
        // is never given it, and a wrong one beside a good capability is the
        // same call.
        let (status, answer) = post_hook(
            &base,
            "orchestration",
            Some("wrong"),
            Some(&master_cap),
            accept("chat:master", None, &task.id, &attempt.id),
        )
        .await;
        assert_eq!(status, 200, "{answer}");
        assert_eq!(
            answer["result"]["awarded"],
            json!(false),
            "XP once per task"
        );

        // The person, through the command the browser's socket runs.
        let accepted = run_command(
            &ctx,
            "orchestration_task_accept".into(),
            json!({ "taskId": for_person.id, "attemptId": person_attempt.id }),
        )
        .await
        .unwrap();
        assert_eq!(accepted["award"]["acceptedBy"]["kind"], json!("person"));
        let profile = store.level_profile("agent_ada", 0).unwrap();
        assert_eq!((profile.accepted_tasks, profile.history_total), (2, 2));

        for key in [worker.as_str(), "chat:master", "chat:other"] {
            chats.test_end(key);
        }
    }

    fn confirm(chat_key: &str, session_key: Option<&str>, args: Value) -> Value {
        let mut body = json!({ "chatKey": chat_key, "action": "report_confirm", "args": args });
        if let Some(session_key) = session_key {
            body["sessionKey"] = json!(session_key);
        }
        body
    }

    fn relay(
        chat_key: &str,
        session_key: Option<&str>,
        from: &str,
        to: &str,
        words: &str,
    ) -> Value {
        let mut body = json!({ "chatKey": chat_key, "action": "relay_send", "args": {
            "fromRunId": from, "toRunId": to, "subject": "Shared file", "body": words } });
        if let Some(session_key) = session_key {
            body["sessionKey"] = json!(session_key);
        }
        body
    }

    fn error(answer: &Value) -> &str {
        answer["error"].as_str().unwrap_or_default()
    }

    /// A read-only worker's proposed report is settled only by its run's
    /// coordinator, proven by that coordinator's own live capability, naming
    /// the current attempt and proposal, with its own verdict, while the
    /// worker is not in a turn.
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn only_the_coordinators_live_capability_confirms_a_proposed_report() {
        use crate::orchestration::OrchestrationStore;
        let store = Arc::new(OrchestrationStore::default());
        let run = crate::orchestration::tests::run(&store);
        store
            .create_run(
                "chat:other".into(),
                "Another run".into(),
                "workspace".into(),
                "/tmp".into(),
                Some(1),
            )
            .unwrap();
        let (review, after, attempt, proposal) = crate::orchestration::tests::proposed_review(
            &store,
            &run,
            "README reviewed. No blocking problems.",
        );
        let mut chats = crate::agent_chat::ChatManager::default();
        chats.orchestrations = store.clone();
        let chats = Arc::new(chats);
        let worker = attempt.worker_chat_key.clone();
        let worker_cap = chats.test_launch(&worker);
        let other_cap = chats.test_launch("chat:other");
        let stale_cap = chats.test_launch("chat:master");
        let (_ctx, base) = test_server(chats.clone(), store.clone()).await;
        let good = json!({ "attemptId": attempt.id, "proposalId": proposal.id,
                           "outcome": "completed", "verdict": "pass" });
        let unsettled = |store: &OrchestrationStore| {
            let snapshot = store.snapshot(Some(&run.id)).unwrap();
            let task = snapshot.tasks.iter().find(|t| t.id == review.id).unwrap();
            assert_eq!(task.status, crate::orchestration::TaskStatus::Running);
        };

        // The person's token alone, naming the coordinator: no capability.
        let (status, _) = post_hook(
            &base,
            "orchestration",
            Some("hook-token"),
            None,
            confirm("chat:master", None, good.clone()),
        )
        .await;
        assert_eq!(
            status, 401,
            "token plus a body chatKey is not the coordinator"
        );
        // The worker naming its coordinator, with its own capability.
        let (status, _) = hook(
            &base,
            Some(&worker_cap),
            confirm("chat:master", None, good.clone()),
        )
        .await;
        assert_eq!(status, 401);
        let (status, _) = hook(
            &base,
            Some(&worker_cap),
            confirm("chat:master", Some(&worker), good.clone()),
        )
        .await;
        assert_eq!(status, 403, "a worker claiming its coordinator");
        // The worker as itself, and another run's coordinator: proven, but
        // not this run's coordinator.
        let (status, answer) = hook(
            &base,
            Some(&worker_cap),
            confirm(&worker, None, good.clone()),
        )
        .await;
        assert_eq!(status, 400);
        assert!(
            error(&answer).contains("Only this run's coordinator"),
            "{answer}"
        );
        let (status, answer) = hook(
            &base,
            Some(&other_cap),
            confirm("chat:other", None, good.clone()),
        )
        .await;
        assert_eq!(status, 400);
        assert!(
            error(&answer).contains("Only this run's coordinator"),
            "{answer}"
        );
        unsettled(&store);

        // The coordinator's launch ends and it starts again: the old
        // capability is dead.
        chats.test_end("chat:master");
        let master_cap = chats.test_launch("chat:master");
        let (status, _) = hook(
            &base,
            Some(&stale_cap),
            confirm("chat:master", None, good.clone()),
        )
        .await;
        assert_eq!(status, 401, "a replaced launch's capability");

        // The coordinator, but not the exact current attempt and proposal, or
        // with no verdict for a review.
        for (args, expect) in [
            (
                json!({ "attemptId": "attempt_nope", "proposalId": proposal.id, "outcome": "completed", "verdict": "pass" }),
                "does not exist",
            ),
            (
                json!({ "attemptId": attempt.id, "proposalId": "proposal_forged", "outcome": "completed", "verdict": "pass" }),
                "not this attempt's current proposed report",
            ),
            (
                json!({ "attemptId": attempt.id, "proposalId": proposal.id, "outcome": "completed" }),
                "verdict",
            ),
        ] {
            let (status, answer) =
                hook(&base, Some(&master_cap), confirm("chat:master", None, args)).await;
            assert_eq!(status, 400, "{answer}");
            assert!(error(&answer).contains(expect), "{expect}: {answer}");
        }
        // A new worker turn is in flight: nothing is decided under it.
        chats.test_busy(&worker, true);
        let (status, answer) = hook(
            &base,
            Some(&master_cap),
            confirm("chat:master", None, good.clone()),
        )
        .await;
        assert_eq!(status, 400);
        assert!(error(&answer).contains("in a turn again"), "{answer}");
        chats.test_busy(&worker, false);
        unsettled(&store);

        // The coordinator's own live capability, the exact proposal, its own
        // verdict: settled once.
        let (status, answer) = hook(
            &base,
            Some(&master_cap),
            confirm("chat:master", None, good.clone()),
        )
        .await;
        assert_eq!(status, 200, "{answer}");
        let snapshot = store.snapshot(Some(&run.id)).unwrap();
        let settled = snapshot.tasks.iter().find(|t| t.id == review.id).unwrap();
        assert_eq!(settled.verdict, Some(crate::orchestration::Verdict::Pass));
        let held = snapshot
            .attempts
            .iter()
            .find(|a| a.id == attempt.id)
            .unwrap();
        assert_eq!(
            held.proposed_report
                .as_ref()
                .unwrap()
                .confirmed_by
                .as_deref(),
            Some("chat:master")
        );
        assert_eq!(
            snapshot
                .tasks
                .iter()
                .find(|t| t.id == after.id)
                .unwrap()
                .status,
            crate::orchestration::TaskStatus::Ready
        );
        let (status, _) = hook(&base, Some(&master_cap), confirm("chat:master", None, good)).await;
        assert_eq!(status, 400, "a repeat changes nothing");

        for key in [worker.as_str(), "chat:master", "chat:other"] {
            chats.test_end(key);
        }
    }

    /// Between two coordinators a note goes only over the person's bridge,
    /// only from the source coordinator's own live capability, and stops the
    /// moment the person closes it.
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn a_relay_between_coordinators_needs_the_persons_bridge_and_the_senders_capability() {
        use crate::orchestration::OrchestrationStore;
        let store = Arc::new(OrchestrationStore::default());
        let source = crate::orchestration::tests::run(&store);
        let target = store
            .create_run(
                "chat:other".into(),
                "The other team's run".into(),
                "workspace".into(),
                "/tmp".into(),
                Some(1),
            )
            .unwrap();
        let mut chats = crate::agent_chat::ChatManager::default();
        chats.orchestrations = store.clone();
        let chats = Arc::new(chats);
        let master_cap = chats.test_launch("chat:master");
        let other_cap = chats.test_launch("chat:other");
        let (ctx, base) = test_server(chats.clone(), store.clone()).await;
        let notes = |store: &OrchestrationStore| {
            store
                .snapshot(None)
                .unwrap()
                .messages
                .into_iter()
                .filter(|m| m.kind == "relay")
                .count()
        };

        let (status, answer) = hook(
            &base,
            Some(&master_cap),
            relay(
                "chat:master",
                None,
                &source.id,
                &target.id,
                "Both edit README.md.",
            ),
        )
        .await;
        assert_eq!(status, 400);
        assert!(error(&answer).contains("No bridge is open"), "{answer}");

        // The agent cannot open its own bridge: the hook has no such action.
        let (status, _) = hook(
            &base,
            Some(&master_cap),
            json!({ "chatKey": "chat:master", "action": "bridge_open", "args": {
                "fromRunId": source.id, "toRunId": target.id,
                "fromCoordinator": "chat:master", "toCoordinator": "chat:other" } }),
        )
        .await;
        assert_eq!(status, 400);
        // The person, through the command the browser's socket runs.
        let bridge = run_command(
            &ctx,
            "orchestration_bridge_open".into(),
            json!({ "fromRunId": source.id, "toRunId": target.id,
                    "fromCoordinator": "chat:master", "toCoordinator": "chat:other" }),
        )
        .await
        .unwrap();

        // Not the token, not the target coordinator claiming the source, not
        // the target back the other way.
        let (status, _) = post_hook(
            &base,
            "orchestration",
            Some("hook-token"),
            None,
            relay("chat:master", None, &source.id, &target.id, "Forged"),
        )
        .await;
        assert_eq!(status, 401);
        let (status, _) = hook(
            &base,
            Some(&other_cap),
            relay(
                "chat:master",
                Some("chat:other"),
                &source.id,
                &target.id,
                "Forged",
            ),
        )
        .await;
        assert_eq!(status, 403);
        let (status, answer) = hook(
            &base,
            Some(&other_cap),
            relay("chat:other", None, &target.id, &source.id, "Reply"),
        )
        .await;
        assert_eq!(status, 400);
        assert!(error(&answer).contains("No bridge is open"), "{answer}");
        assert_eq!(notes(&store), 0);

        let (status, answer) = hook(
            &base,
            Some(&master_cap),
            relay(
                "chat:master",
                None,
                &source.id,
                &target.id,
                "Both edit README.md.",
            ),
        )
        .await;
        assert_eq!(status, 200, "{answer}");
        assert_eq!(answer["result"]["fromChatKey"], json!("chat:master"));
        assert_eq!(answer["result"]["toChatKey"], json!("chat:other"));
        assert_eq!(answer["result"]["relay"]["bridgeId"], bridge["id"]);
        assert_eq!(notes(&store), 1);

        // A stale capability, then the person closing the bridge.
        chats.test_end("chat:master");
        let (status, _) = hook(
            &base,
            Some(&master_cap),
            relay(
                "chat:master",
                None,
                &source.id,
                &target.id,
                "After the relaunch",
            ),
        )
        .await;
        assert_eq!(status, 401);
        let master_cap = chats.test_launch("chat:master");
        run_command(
            &ctx,
            "orchestration_bridge_close".into(),
            json!({ "bridgeId": bridge["id"] }),
        )
        .await
        .unwrap();
        let (status, answer) = hook(
            &base,
            Some(&master_cap),
            relay(
                "chat:master",
                None,
                &source.id,
                &target.id,
                "After the close",
            ),
        )
        .await;
        assert_eq!(status, 400);
        assert!(error(&answer).contains("No bridge is open"), "{answer}");
        assert_eq!(notes(&store), 1);

        for key in ["chat:master", "chat:other"] {
            chats.test_end(key);
        }
    }
}
