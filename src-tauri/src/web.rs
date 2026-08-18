//! Remote access: serve this app's own UI over HTTP and bridge a browser to
//! this machine's backend over one WebSocket.
//!
//! The point is a two-part setup: OctiqFlow runs on a machine that stays on (an
//! old Mac, a mini), owns every PTY, and a browser anywhere else — a laptop
//! whose lid you can close, a phone — drives it. The terminals never live in
//! the browser: they live here, so nothing dies when a client disconnects.
//!
//! ```text
//!   browser                    this process
//!   ───────                    ────────────
//!   GET /            ────────► the same files the desktop window loads
//!   WS  /ws?token=…  ◄───────► invoke requests + event stream
//! ```
//!
//! ## Why the invokes go back through the desktop webview
//!
//! There are 96 `#[tauri::command]` functions. Writing a second dispatch table
//! for them (and keeping it in step forever) is the obvious design and the
//! wrong one. Instead a remote `invoke` is handed to the app's OWN webview,
//! which already has full IPC access:
//!
//! ```text
//!   WS  {invoke,id,cmd,args} ──► emit "web-invoke" ──► webbridge.js in the
//!                                                      desktop window
//!                                                          │ invoke(cmd,args)
//!   WS  {reply,id,result}    ◄── web_reply command ◄───────┘
//! ```
//!
//! So every command the desktop UI can call, a browser can call, with no
//! per-command code here. The cost is that the desktop window must be running —
//! which it is: it is the server.
//!
//! Events go the short way instead (`emit` below): straight from the Rust
//! emitter to every socket, no JS hop, because `pty-output` is the hot path.
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
//! A missing token is generated and written back on first start. Static files
//! are not gated (they are just the UI); the WebSocket — the part that can do
//! anything — requires the token.

use std::collections::HashMap;
use std::net::SocketAddr;
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use axum::body::Body;
use axum::extract::ws::{Message, WebSocket, WebSocketUpgrade};
use axum::extract::{ConnectInfo, Query, State as AxumState};
use axum::http::{header, StatusCode, Uri};
use axum::response::{IntoResponse, Response};
use axum::routing::get;
use axum::Router;
use futures_util::{SinkExt, StreamExt};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tauri::{AppHandle, Emitter, Manager};
use tokio::sync::{broadcast, oneshot};

/// How long a remote invoke waits for the desktop webview to answer before it
/// gives up. Long enough for a slow command (a git scan over a big repo), short
/// enough that a wedged webview cannot leak pending entries forever.
const INVOKE_TIMEOUT: Duration = Duration::from_secs(45);

/// Backlog of the event fan-out channel. A client that falls this far behind is
/// dropped from the stream rather than stalling the emitter — terminals must
/// never block on a slow socket.
const EVENT_BACKLOG: usize = 1024;

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
}

fn default_port() -> u16 {
    1421
}

fn default_bind() -> String {
    "127.0.0.1".to_string()
}

impl Default for WebConfig {
    fn default() -> Self {
        Self {
            enabled: false,
            port: default_port(),
            bind: default_bind(),
            token: String::new(),
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
    }
    if let Ok(raw) = serde_json::to_string_pretty(cfg) {
        let _ = std::fs::write(path, raw);
    }
}

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

pub struct WebState {
    pub cfg: Mutex<WebConfig>,
    /// Remote invokes waiting on the desktop webview, by request id.
    pending: Mutex<HashMap<u64, oneshot::Sender<Result<Value, String>>>>,
    next_id: AtomicU64,
    /// Connected browsers. Read by `pty.rs`: while a browser is watching, no
    /// terminal may be put in the "hidden, buffer it" state, because the
    /// desktop window's idea of what is on screen is not the browser's.
    clients: AtomicUsize,
    events: broadcast::Sender<String>,
}

impl WebState {
    pub fn new(cfg: WebConfig) -> Self {
        let (events, _) = broadcast::channel(EVENT_BACKLOG);
        Self {
            cfg: Mutex::new(cfg),
            pending: Mutex::new(HashMap::new()),
            next_id: AtomicU64::new(1),
            clients: AtomicUsize::new(0),
            events,
        }
    }

    pub fn client_count(&self) -> usize {
        self.clients.load(Ordering::SeqCst)
    }
}

/// Whether any browser is attached right now. `false` when the web server was
/// never started, so the desktop-only path is untouched.
pub fn clients_connected(app: &AppHandle) -> bool {
    app.try_state::<WebState>()
        .map(|st| st.client_count() > 0)
        .unwrap_or(false)
}

/// Emit an event to the desktop window AND every attached browser.
///
/// Every `app.emit` in this app goes through here instead, so a browser sees
/// exactly what the desktop window sees. Serialization for the sockets happens
/// once, and only when someone is actually listening.
pub fn emit<S: Serialize + Clone>(app: &AppHandle, event: &str, payload: S) {
    let _ = app.emit(event, payload.clone());
    let Some(st) = app.try_state::<WebState>() else {
        return;
    };
    if st.events.receiver_count() == 0 {
        return;
    }
    let Ok(value) = serde_json::to_value(&payload) else {
        return;
    };
    let frame = json!({ "t": "event", "event": event, "payload": value });
    if let Ok(text) = serde_json::to_string(&frame) {
        let _ = st.events.send(text);
    }
}

// ---------------------------------------------------------------------------
// The invoke proxy
// ---------------------------------------------------------------------------

#[derive(Clone, Serialize)]
struct WebInvoke {
    id: u64,
    cmd: String,
    args: Value,
}

/// Run one command on behalf of a browser by handing it to the desktop
/// webview (see the module docs) and waiting for its answer.
async fn proxy_invoke(app: &AppHandle, cmd: String, args: Value) -> Result<Value, String> {
    let st = app
        .try_state::<WebState>()
        .ok_or_else(|| "web bridge is not running".to_string())?;

    let id = st.next_id.fetch_add(1, Ordering::SeqCst);
    let (tx, rx) = oneshot::channel();
    st.pending.lock().map_err(|_| "bridge lock")?.insert(id, tx);

    if let Err(e) = app.emit("web-invoke", WebInvoke { id, cmd, args }) {
        st.pending.lock().ok().and_then(|mut p| p.remove(&id));
        return Err(format!("could not reach the app window: {e}"));
    }

    match tokio::time::timeout(INVOKE_TIMEOUT, rx).await {
        Ok(Ok(result)) => result,
        // The window answered nothing (reloaded mid-call), or the wait expired.
        Ok(Err(_)) => Err("the app window dropped the request".into()),
        Err(_) => {
            st.pending.lock().ok().and_then(|mut p| p.remove(&id));
            Err("timed out waiting for the app window".into())
        }
    }
}

/// The desktop webview's answer to a `web-invoke` (webbridge.js calls this).
#[tauri::command]
pub fn web_reply(
    state: tauri::State<WebState>,
    id: u64,
    ok: bool,
    result: Option<Value>,
    error: Option<String>,
) {
    let Some(tx) = state.pending.lock().ok().and_then(|mut p| p.remove(&id)) else {
        return; // already timed out; nothing is waiting
    };
    let _ = tx.send(if ok {
        Ok(result.unwrap_or(Value::Null))
    } else {
        Err(error.unwrap_or_else(|| "command failed".into()))
    });
}

/// What the Settings screen needs to show a "open this on your phone" URL.
#[tauri::command]
pub fn web_info(app: AppHandle) -> Value {
    let cfg = app
        .try_state::<WebState>()
        .and_then(|st| st.cfg.lock().ok().map(|c| c.clone()))
        .unwrap_or_else(load_config);
    let clients = app
        .try_state::<WebState>()
        .map(|st| st.client_count())
        .unwrap_or(0);
    json!({
        "enabled": cfg.enabled,
        "port": cfg.port,
        "bind": cfg.bind,
        "token": cfg.token,
        "clients": clients,
        "running": app.try_state::<WebState>().is_some(),
    })
}

/// Turn remote access on or off and persist it. A change needs a restart to
/// take effect (the listener is bound once at startup), which the UI says.
#[tauri::command]
pub fn web_set_config(
    app: AppHandle,
    enabled: bool,
    port: u16,
    bind: String,
) -> Result<Value, String> {
    let mut cfg = load_config();
    cfg.enabled = enabled;
    cfg.port = port;
    cfg.bind = bind;
    save_config(&cfg);
    if let Some(st) = app.try_state::<WebState>() {
        if let Ok(mut held) = st.cfg.lock() {
            *held = cfg.clone();
        }
    }
    Ok(json!({ "enabled": cfg.enabled, "port": cfg.port, "bind": cfg.bind, "token": cfg.token }))
}

// ---------------------------------------------------------------------------
// HTTP + WebSocket
// ---------------------------------------------------------------------------

#[derive(Clone)]
struct Ctx {
    app: AppHandle,
}

#[derive(Deserialize)]
struct TokenQuery {
    token: Option<String>,
}

/// Start the server if `web.json` enables it. Never fails the app: a port
/// already in use logs and leaves the desktop app working as before.
pub fn start(app: &AppHandle, cfg: WebConfig) {
    let addr: SocketAddr = match format!("{}:{}", cfg.bind, cfg.port).parse() {
        Ok(a) => a,
        Err(e) => {
            eprintln!("[web] bad bind address {}:{} — {e}", cfg.bind, cfg.port);
            return;
        }
    };
    let ctx = Ctx { app: app.clone() };

    let token = cfg.token.clone();
    tauri::async_runtime::spawn(async move {
        let router = Router::new()
            .route("/ws", get(ws_handler))
            .route("/auth", get(auth_handler))
            .route("/token", get(token_handler))
            .fallback(get(asset_handler))
            .with_state(ctx);

        let listener = match tokio::net::TcpListener::bind(addr).await {
            Ok(l) => l,
            Err(e) => {
                eprintln!("[web] could not listen on {addr}: {e}");
                return;
            }
        };
        // The whole URL, token and all. Without it the first thing a browser
        // does is fail to connect, and the token lives in a JSON file most
        // people would have to go hunting for. It is the user's own machine and
        // their own terminal; the usability is worth more than the secrecy of a
        // value that already sits in plain text on the same disk.
        println!("[web] OctiqFlow v2:      http://{addr}/v2/?token={token}");
        println!("[web] OctiqFlow classic: http://{addr}/?token={token}");
        let service = router.into_make_service_with_connect_info::<SocketAddr>();
        if let Err(e) = axum::serve(listener, service).await {
            eprintln!("[web] server stopped: {e}");
        }
    });
}

/// Where the built v2 client lives. Tried in order:
///   · next to the app bundle's resources (a shipped build)
///   · the repo's `web/dist` (running from a checkout)
/// Returns None when v2 has not been built, which simply means `/v2` 404s and
/// the classic UI at `/` is unaffected.
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

/// Serve one file of the v2 client. Any unknown path inside `/v2/` falls back
/// to its index.html, the usual single-page-app rule.
fn serve_v2(rel: &str) -> Response {
    let Some(root) = v2_root() else {
        return (
            StatusCode::NOT_FOUND,
            "the v2 client is not built — run `pnpm --dir web build`",
        )
            .into_response();
    };

    // Refuse anything that tries to climb out of the served folder. The only
    // paths we serve are ones that stay inside it.
    let clean = rel.trim_start_matches('/');
    let unsafe_path = clean.split('/').any(|seg| seg == ".." || seg == ".");
    let file = if clean.is_empty() || unsafe_path {
        root.join("index.html")
    } else {
        let candidate = root.join(clean);
        if candidate.is_file() {
            candidate
        } else {
            root.join("index.html")
        }
    };

    let mime = match file.extension().and_then(|e| e.to_str()) {
        Some("html") => "text/html; charset=utf-8",
        Some("js") => "text/javascript; charset=utf-8",
        Some("css") => "text/css; charset=utf-8",
        Some("json") => "application/json",
        Some("svg") => "image/svg+xml",
        Some("png") => "image/png",
        Some("woff2") => "font/woff2",
        _ => "application/octet-stream",
    };

    match std::fs::read(&file) {
        Ok(bytes) => Response::builder()
            .status(StatusCode::OK)
            .header(header::CONTENT_TYPE, mime)
            .header(header::CACHE_CONTROL, "no-store")
            .body(Body::from(bytes))
            .unwrap_or_else(|_| StatusCode::INTERNAL_SERVER_ERROR.into_response()),
        Err(_) => (StatusCode::NOT_FOUND, "not found").into_response(),
    }
}

/// Serve the app's own frontend — the very files the desktop window loads, read
/// through Tauri's asset resolver, so there is one copy of the UI and no build
/// step to keep in step.
///
/// `/v2` and below come from the built React client instead (web/dist).
async fn asset_handler(AxumState(ctx): AxumState<Ctx>, uri: Uri) -> Response {
    let raw = uri.path().trim_start_matches('/');

    // The v2 bundle's asset URLs are RELATIVE (vite `base: "./"`), so the page
    // must be served from a path ending in a slash or the browser resolves
    // `./assets/…` against the parent and misses.
    if raw == "v2" {
        return Response::builder()
            .status(StatusCode::TEMPORARY_REDIRECT)
            .header(header::LOCATION, "/v2/")
            .body(Body::empty())
            .unwrap_or_else(|_| StatusCode::INTERNAL_SERVER_ERROR.into_response());
    }
    if let Some(rest) = raw.strip_prefix("v2/") {
        return serve_v2(rest);
    }

    let path = if raw.is_empty() { "index.html" } else { raw };

    let resolver = ctx.app.asset_resolver();
    let asset = resolver
        .get(path.to_string())
        .or_else(|| resolver.get("index.html".to_string()));

    match asset {
        Some(asset) => Response::builder()
            .status(StatusCode::OK)
            .header(header::CONTENT_TYPE, asset.mime_type)
            // The UI is served from the app binary and changes with it; never
            // let a phone cache a stale build.
            .header(header::CACHE_CONTROL, "no-store")
            .body(Body::from(asset.bytes))
            .unwrap_or_else(|_| StatusCode::INTERNAL_SERVER_ERROR.into_response()),
        None => (StatusCode::NOT_FOUND, "not found").into_response(),
    }
}

/// Hand the token to a browser running on THIS machine.
///
/// A request from 127.0.0.1 already comes from something with the run of the
/// machine — it can read `web.json` itself, where the token sits in plain text.
/// Making a local browser type it in buys nothing and costs a gate every time,
/// so loopback gets it for the asking. Every other address still has to know
/// it: a phone, another laptop, anything across Tailscale.
async fn token_handler(
    AxumState(ctx): AxumState<Ctx>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
) -> Response {
    if !peer.ip().is_loopback() {
        return (StatusCode::FORBIDDEN, "not local").into_response();
    }
    let token = ctx
        .app
        .try_state::<WebState>()
        .and_then(|st| st.cfg.lock().ok().map(|c| c.token.clone()))
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

/// Constant-ish token check shared by /auth and /ws.
fn token_ok(ctx: &Ctx, given: &str) -> bool {
    let expected = ctx
        .app
        .try_state::<WebState>()
        .and_then(|st| st.cfg.lock().ok().map(|c| c.token.clone()))
        .unwrap_or_default();
    !expected.is_empty() && given == expected
}

async fn ws_handler(
    AxumState(ctx): AxumState<Ctx>,
    Query(q): Query<TokenQuery>,
    upgrade: WebSocketUpgrade,
) -> Response {
    // The socket is the whole attack surface — it can start shells. Everything
    // past this line has already proved it knows the token.
    if !token_ok(&ctx, q.token.as_deref().unwrap_or_default()) {
        return (StatusCode::UNAUTHORIZED, "bad token").into_response();
    }
    upgrade.on_upgrade(move |socket| client(ctx, socket))
}

/// One connected browser: forward its invokes, stream events back.
async fn client(ctx: Ctx, socket: WebSocket) {
    let Some(st) = ctx.app.try_state::<WebState>() else {
        return;
    };
    st.clients.fetch_add(1, Ordering::SeqCst);
    let mut events = st.events.subscribe();

    let (sink, mut stream) = socket.split();
    let sink = Arc::new(tokio::sync::Mutex::new(sink));

    // Events -> this browser.
    let out = sink.clone();
    let pump = tauri::async_runtime::spawn(async move {
        loop {
            match events.recv().await {
                Ok(text) => {
                    if out.lock().await.send(Message::Text(text.into())).await.is_err() {
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
        let app = ctx.app.clone();
        let out = sink.clone();
        tauri::async_runtime::spawn(async move {
            let reply = match proxy_invoke(&app, cmd, args).await {
                Ok(result) => json!({ "t": "reply", "id": id, "ok": true, "result": result }),
                Err(error) => json!({ "t": "reply", "id": id, "ok": false, "error": error }),
            };
            if let Ok(text) = serde_json::to_string(&reply) {
                let _ = out.lock().await.send(Message::Text(text.into())).await;
            }
        });
    }

    pump.abort();
    if let Some(st) = ctx.app.try_state::<WebState>() {
        st.clients.fetch_sub(1, Ordering::SeqCst);
    }
}
