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
//! { "enabled": true, "port": 1421, "bind": "0.0.0.0", "token": "…",
//!   "local_token": true }
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
//! * **`/token` answers only a browser that typed a loopback address**
//!   (`host_is_local`). A loopback peer address is not enough on its own: a page
//!   can point its own hostname at `127.0.0.1` and become same-origin with this
//!   server, at which point asking for the token is all it has to do. The `Host`
//!   header is the one part of that request the attacker cannot rewrite.
//! * **The socket refuses a page we did not serve** (`origin_ok`). A WebSocket
//!   handshake is exempt from the same-origin policy, so `Origin` is the only
//!   place the browser says who is calling. Clients that are not browsers send
//!   none and are unaffected — the token is what gates them.
//!
//! `local_token: false` switches the first of those off entirely, for a setup
//! where something forwards to this server WITHOUT adding a proxy header
//! (`ssh -L`, `socat`, an nginx `proxy_pass` with no `proxy_set_header`). Those
//! arrive indistinguishable from a browser on this desk, so the endpoint has to
//! be closed by hand rather than detected.

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
use axum::routing::{get, post};
use axum::{Json, Router};
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
    /// Whether a browser on this machine may ask for the token (`GET /token`).
    ///
    /// On by default, because the usual case is a browser on the same desk and
    /// the token is already readable on the same disk. Turn it OFF when
    /// something sits in front of this server that does NOT add a forwarding
    /// header — an `ssh -L` tunnel, `socat`, an nginx `proxy_pass` with no
    /// `proxy_set_header`. Those arrive looking exactly like a local browser,
    /// and `came_through_a_proxy` cannot see them, so the endpoint would hand
    /// the token to whoever reached the far end.
    #[serde(default = "default_local_token")]
    pub local_token: bool,
}

fn default_local_token() -> bool {
    true
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
            access: Default::default(),
            local_token: default_local_token(),
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
    /// Remote invokes waiting on the desktop webview, by request id.
    pending: Mutex<HashMap<u64, oneshot::Sender<Result<Value, String>>>>,
    next_id: AtomicU64,
    /// Connected browsers. Read by `pty.rs`: while a browser is watching, no
    /// terminal may be put in the "hidden, buffer it" state, because the
    /// desktop window's idea of what is on screen is not the browser's.
    clients: AtomicUsize,
}

impl WebState {
    pub fn new(cfg: WebConfig) -> Self {
        Self {
            cfg: Mutex::new(cfg),
            pending: Mutex::new(HashMap::new()),
            next_id: AtomicU64::new(1),
            clients: AtomicUsize::new(0),
        }
    }

    pub fn client_count(&self) -> usize {
        self.clients.load(Ordering::SeqCst)
    }
}

/// Whether any browser is attached right now. `false` when the web server was
/// never started, so the desktop-only path is untouched.

/// Send every event this app emits to the desktop window as well.
///
/// Called once at startup. Producers emit through `bus::emit`, which knows
/// nothing about Tauri; this is the part that puts those events in front of the
/// window too. Headless, nobody calls it and the events go only to sockets.
pub fn mirror_events_to_desktop(app: &AppHandle) {
    let app = app.clone();
    crate::bus::set_desktop_sink(move |event, value| {
        let _ = app.emit(event, value);
    });
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
async fn run_command(ctx: &Ctx, cmd: String, args: Value) -> Result<Value, String> {
    let app = match &ctx.invoke {
        // No window in the way: call the backend directly.
        Invoker::Local(svc) => return crate::dispatch::dispatch(svc, &cmd, args),
        Invoker::Webview(app) => app,
    };
    let st = &ctx.state;

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
    state: tauri::State<Arc<WebState>>,
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
        .try_state::<Arc<WebState>>()
        .and_then(|st| st.cfg.lock().ok().map(|c| c.clone()))
        .unwrap_or_else(load_config);
    let clients = app
        .try_state::<Arc<WebState>>()
        .map(|st| st.client_count())
        .unwrap_or(0);
    json!({
        "enabled": cfg.enabled,
        "port": cfg.port,
        "bind": cfg.bind,
        "token": cfg.token,
        "clients": clients,
        "running": app.try_state::<Arc<WebState>>().is_some(),
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
    if let Some(st) = app.try_state::<Arc<WebState>>() {
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
    state: Arc<WebState>,
    invoke: Invoker,
}

/// Who actually runs a command a browser asked for.
///
/// The desktop app hands it to its own window, because the classic UI's
/// commands — PTYs above all — only exist inside Tauri. A headless server runs
/// it here, which is the whole point: no window to hand it to.
#[derive(Clone)]
enum Invoker {
    Webview(AppHandle),
    Local(crate::dispatch::Services),
}

#[derive(Deserialize)]
struct TokenQuery {
    token: Option<String>,
}

/// Start the server if `web.json` enables it. Never fails the app: a port
/// already in use logs and leaves the desktop app working as before.
pub fn start(app: &AppHandle, state: Arc<WebState>, cfg: WebConfig) {
    let ctx = Ctx {
        state,
        invoke: Invoker::Webview(app.clone()),
    };
    let Some(fut) = serve(ctx, cfg) else { return };
    tauri::async_runtime::spawn(fut);
}

/// Serve with no Tauri app at all: commands run through the dispatch table and
/// the client comes from `web/dist`, because the classic UI's assets live in
/// the bundle this process does not have.
pub async fn start_headless(cfg: WebConfig, services: crate::dispatch::Services) {
    let ctx = Ctx {
        state: Arc::new(WebState::new(cfg.clone())),
        invoke: Invoker::Local(services),
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

    let token = cfg.token.clone();
    Some(async move {
        let router = Router::new()
            .route("/ws", get(ws_handler))
            .route("/auth", get(auth_handler))
            .route("/token", get(token_handler))
            .route("/file", get(file_handler))
            .route("/hook/permission", post(permission_handler))
            .route("/hook/ask", post(ask_handler))
            .route("/hook/room", post(room_handler))
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
        println!("[web] OctiqFlow: http://{addr}/?token={token}");
        // The app is served here and nowhere else now. Said once so nobody has
        // to wonder whether the bookmark they kept went stale — it does not, it
        // lands here, token and all.
        println!("[web] (the older /v2/ URL redirects to this one)");
        let service = router.into_make_service_with_connect_info::<SocketAddr>();
        if let Err(e) = axum::serve(listener, service).await {
            eprintln!("[web] server stopped: {e}");
        }
    })
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
fn serve_v2(rel: &str) -> Response {
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
/// The classic UI (the desktop window's own files, read through Tauri's asset
/// resolver) is now only a fallback, for a checkout where the client has not
/// been built. A headless server has no bundle to read it from at all.
async fn asset_handler(AxumState(ctx): AxumState<Ctx>, uri: Uri) -> Response {
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
        return serve_v2(raw);
    }

    let path = if raw.is_empty() { "index.html" } else { raw };

    let Invoker::Webview(app) = &ctx.invoke else {
        // Headless with no v2 build: there is nothing to serve. The classic
        // UI's assets live inside the Tauri bundle, which this process does
        // not have.
        return (
            StatusCode::NOT_FOUND,
            "the client is not built — run `pnpm --dir web build`",
        )
            .into_response();
    };
    let resolver = app.asset_resolver();
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

/// Whether this request reached us through a reverse proxy.
///
/// The peer address stops meaning anything the moment something sits in front:
/// `cloudflared` runs on this machine and connects to 127.0.0.1, so a request
/// from the other side of the planet arrives looking exactly like a browser on
/// this desk. Anything deciding trust from the peer address has to ask this
/// first.
///
/// Presence is what matters, not the value — these headers can say anything,
/// and none of them is here at all on a request that really came straight from
/// a local browser.
fn came_through_a_proxy(headers: &axum::http::HeaderMap) -> bool {
    const FORWARDED: [&str; 5] = [
        "cf-connecting-ip",
        "x-forwarded-for",
        "x-forwarded-host",
        "x-real-ip",
        "forwarded",
    ];
    FORWARDED.iter().any(|h| headers.contains_key(*h))
}

/// Whether the browser typed OUR OWN address into the bar, rather than a name
/// that merely points here.
///
/// This is the DNS-rebinding gate, and it exists because the peer address
/// cannot answer the question. A page on `evil.example` can give its own
/// hostname a second DNS answer of `127.0.0.1`, wait for the browser to switch
/// to it, and from then on its scripts are same-origin with this server: it can
/// read replies, so `GET /token` hands it the token and the socket behind it.
/// Nothing about that request looks remote — the connection really does come
/// from loopback.
///
/// The one thing the attacker cannot forge is this header. A browser writes
/// `Host` from the URL it was given, so a rebound request still says
/// `evil.example`. Insisting the header spells a loopback address is therefore
/// the whole defence, and it costs a real local browser nothing: it got here by
/// typing one.
fn host_is_local(headers: &axum::http::HeaderMap) -> bool {
    let Some(host) = headers
        .get(axum::http::header::HOST)
        .and_then(|v| v.to_str().ok())
    else {
        // Every browser sends one. Something that does not is not the local
        // browser this rule is here to recognise.
        return false;
    };
    matches!(
        hostname_of(host).as_deref(),
        Some("localhost" | "127.0.0.1" | "::1")
    )
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
    headers: axum::http::HeaderMap,
) -> Response {
    // Someone Cloudflare Access has already identified. They got past a sign-in
    // to be here, which is a stronger claim than "this request came from
    // 127.0.0.1" ever was — so they are handed the token and every later
    // request looks like any other. This is what makes signing in replace
    // pasting a token, rather than sit on top of it.
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
            // No header at all: not an Access request. Fall through to the
            // local-browser rule below.
            Err(_) => {}
        }
    }

    // Turned off for the setups this cannot see: a tunnel that adds no
    // forwarding header arrives indistinguishable from a browser on this desk.
    if !ctx.state.cfg.lock().map(|c| c.local_token).unwrap_or(true) {
        return (StatusCode::FORBIDDEN, "not local").into_response();
    }

    // Order matters: the proxy check comes FIRST, because a forwarded request
    // passes the loopback test. Exposing this through a tunnel without it would
    // publish the token to anyone who asked for it.
    //
    // The host check is the other half. A loopback peer address proves the
    // connection came from this machine and NOT that the browser meant to talk
    // to this machine — a rebound hostname gives an attacker's page both. Only
    // an address typed as loopback gets an answer.
    if came_through_a_proxy(&headers) || !peer.ip().is_loopback() || !host_is_local(&headers) {
        return (StatusCode::FORBIDDEN, "not local").into_response();
    }
    token_body(&ctx)
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
    // This reads any file on the machine, so the same origin rule as the socket
    // applies. An `<img src>` sends no Origin at all and is unaffected.
    if !origin_ok(&headers) {
        return (StatusCode::FORBIDDEN, "wrong origin").into_response();
    }
    if !token_ok(&ctx, q.token.as_deref().unwrap_or_default()) {
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

    let mime = match path
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
        Some("pdf") => "application/pdf",
        _ => "application/octet-stream",
    };

    match std::fs::read(&path) {
        Ok(bytes) => Response::builder()
            .status(StatusCode::OK)
            .header(header::CONTENT_TYPE, mime)
            .header(header::CACHE_CONTROL, "no-store")
            .body(Body::from(bytes))
            .unwrap_or_else(|_| StatusCode::INTERNAL_SERVER_ERROR.into_response()),
        Err(e) => (StatusCode::NOT_FOUND, e.to_string()).into_response(),
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

/// Constant-time token check shared by /auth, /ws, /file and the hooks.
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
/// Called from `permission-ask.cjs`, which is holding a tool call open until
/// this answers. It is on the same token as everything else, and only reachable
/// from this machine in practice — the hook and the server are always the same
/// host.
async fn permission_handler(
    AxumState(ctx): AxumState<Ctx>,
    Query(q): Query<TokenQuery>,
    Json(request): Json<crate::permission::Request>,
) -> Response {
    if !token_ok(&ctx, q.token.as_deref().unwrap_or_default()) {
        return (StatusCode::UNAUTHORIZED, "bad token").into_response();
    }
    let answer = crate::permission::ask(request).await;
    axum::Json(json!({ "decision": answer.decision, "reason": answer.reason })).into_response()
}

/// The agent asking the user something, through its `ask_user` MCP tool.
async fn ask_handler(
    AxumState(ctx): AxumState<Ctx>,
    Query(q): Query<TokenQuery>,
    Json(question): Json<crate::question::Question>,
) -> Response {
    if !token_ok(&ctx, q.token.as_deref().unwrap_or_default()) {
        return (StatusCode::UNAUTHORIZED, "bad token").into_response();
    }
    let answer = crate::question::ask(question).await;
    axum::Json(json!({ "answer": answer })).into_response()
}

/// What the host agent wants done to its room (card 70).
#[derive(Deserialize)]
struct RoomCall {
    /// Which chat is asking. The MCP server reads it from `OCTIQ_CHAT_KEY`.
    #[serde(rename = "chatKey")]
    chat_key: String,
    /// "add" or "ask".
    action: String,
    #[serde(default)]
    name: Option<String>,
    #[serde(default)]
    agent: Option<String>,
    #[serde(default)]
    role: Option<String>,
    #[serde(default)]
    context: Option<String>,
    /// Card 72 — `resident` or `on_demand`. An on-demand seat is an outside
    /// service, and the MCP server has already asked the person before this
    /// arrives; the backend does not re-ask.
    #[serde(default)]
    kind: Option<String>,
    /// Which outside service answers an on-demand seat.
    #[serde(default)]
    provider: Option<String>,
    #[serde(default)]
    seat: Option<String>,
    #[serde(default)]
    prompt: Option<String>,
    #[serde(default)]
    cwd: Option<String>,
}

/// The host agent adding a seat, or putting something to one.
///
/// Routed through the SAME dispatch table the browser uses, so there is one
/// implementation of each and no second copy to drift. Every refusal the client
/// would get, the agent gets too — the seat cap, an unknown seat id, an outside
/// service that cannot be reached. See card 70.
async fn room_handler(
    AxumState(ctx): AxumState<Ctx>,
    Query(q): Query<TokenQuery>,
    Json(call): Json<RoomCall>,
) -> Response {
    if !token_ok(&ctx, q.token.as_deref().unwrap_or_default()) {
        return (StatusCode::UNAUTHORIZED, "bad token").into_response();
    }
    let (cmd, args) = match call.action.as_str() {
        "add" => (
            "chat_add_agent",
            json!({
                "key": call.chat_key,
                "seat": {
                    "name": call.name.unwrap_or_default(),
                    "agent": call.agent.unwrap_or_else(|| "codex".into()),
                    "role": call.role,
                    "context": call.context,
                    "kind": call.kind,
                    "provider": call.provider,
                },
            }),
        ),
        "ask" => (
            "chat_seat_ask",
            json!({
                "key": call.chat_key,
                "seatId": call.seat.unwrap_or_default(),
                "prompt": call.prompt.unwrap_or_default(),
                "cwd": call.cwd.unwrap_or_default(),
            }),
        ),
        other => {
            return axum::Json(json!({ "error": format!("unknown room action '{other}'") }))
                .into_response()
        }
    };
    // On a BLOCKING thread, never the runtime's own.
    //
    // `run_command` reaches `dispatch`, which is synchronous — and `ask` waits
    // on a whole agent turn, up to twenty minutes. Doing that on a tokio worker
    // parks one of a handful of threads that serve every browser, every socket
    // and every other hook; two agents asking at once could stall the server for
    // everybody. The other hooks in this file never had the problem because
    // they await properly.
    let joined = tokio::task::spawn_blocking({
        let ctx = ctx.clone();
        let cmd = cmd.to_string();
        move || tauri::async_runtime::block_on(run_command(&ctx, cmd, args))
    })
    .await;
    let outcome = match joined {
        Ok(outcome) => outcome,
        Err(e) => Err(format!("the room call did not finish: {e}")),
    };
    match outcome {
        Ok(value) => axum::Json(json!({ "ok": value })).into_response(),
        // An error is an ANSWER here, not a failure of the request: the agent
        // has to be told what went wrong so it can say so or try something
        // else, and an HTTP error would reach it as a dead tool instead.
        Err(why) => axum::Json(json!({ "error": why })).into_response(),
    }
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
            let reply = match run_command(&ctx, cmd, args).await {
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

    // ---- host_is_local: the DNS-rebinding gate ----------------------------

    #[test]
    fn the_loopback_spellings_a_browser_can_send_are_local() {
        for host in [
            "localhost",
            "localhost:1421",
            "127.0.0.1",
            "127.0.0.1:1421",
            "[::1]",
            "[::1]:1421",
        ] {
            assert!(
                host_is_local(&headers(&[("host", host)])),
                "{host} should count as local"
            );
        }
    }

    #[test]
    fn a_rebound_hostname_is_not_local_however_it_resolves() {
        // The whole DNS-rebinding trick: `rebind.evil.com` is made to resolve to
        // 127.0.0.1, so the request arrives on loopback and the peer address
        // says nothing. What the attacker CANNOT change is the Host header —
        // the browser copies it from the URL, and that still names their domain.
        for host in [
            "rebind.evil.com",
            "rebind.evil.com:1421",
            "octiq.example.com",
            "127.0.0.1.nip.io:1421",
        ] {
            assert!(
                !host_is_local(&headers(&[("host", host)])),
                "{host} must not count as local"
            );
        }
    }

    #[test]
    fn a_request_with_no_host_header_is_not_local() {
        // Every browser sends one. Something that does not is not the local
        // browser this endpoint exists for.
        assert!(!host_is_local(&headers(&[])));
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
        // What stops it is that the address was never ours, which is the rule
        // /token is guarded by.
        assert!(!host_is_local(&rebound));
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
        // The desktop webview's own origin, which has no port at all.
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

    #[test]
    fn a_request_forwarded_by_a_proxy_is_not_treated_as_local() {
        // cloudflared runs on this machine and connects to 127.0.0.1, so every
        // request through a tunnel arrives with a loopback peer address.
        // Trusting that address would hand the token to the whole internet.
        for header in [
            "cf-connecting-ip",
            "x-forwarded-for",
            "x-forwarded-host",
            "x-real-ip",
            "forwarded",
        ] {
            let mut headers = axum::http::HeaderMap::new();
            headers.insert(header, "203.0.113.7".parse().unwrap());
            assert!(
                came_through_a_proxy(&headers),
                "{header} should mark the request as forwarded"
            );
        }
    }

    #[test]
    fn a_direct_request_carries_no_proxy_headers() {
        let mut headers = axum::http::HeaderMap::new();
        headers.insert("user-agent", "curl".parse().unwrap());
        assert!(!came_through_a_proxy(&headers));
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
}
