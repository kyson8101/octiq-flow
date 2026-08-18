// The browser shim: makes `window.__TAURI__` work over a WebSocket.
//
// OctiqFlow can run in two places at once — the desktop window on the machine
// that owns the terminals, and a browser anywhere else (a laptop, a phone)
// pointed at that machine (see src-tauri/src/web.rs). Every frontend module
// reads `window.__TAURI__.core.invoke` / `.event.listen` at load time, so the
// whole UI runs unchanged in a browser as long as those two functions exist.
// This file supplies them when the real Tauri IPC is absent.
//
// It MUST be a classic script in <head>, before every module tag: module
// scripts are deferred, so this runs first and the facade is already in place
// when the first `const { invoke } = window.__TAURI__.core` executes.
//
// The socket is not open yet at that point, so calls made during boot are
// QUEUED and flushed on open. Nothing has to know it is talking to a socket.
(function () {
  // The desktop app injects the real thing (withGlobalTauri). Leave it alone.
  if (window.__TAURI__) return;

  // The token gates the socket — it can start shells. It arrives once in the
  // URL (`/?token=…`), is kept for later visits, and is stripped from the
  // address bar so it does not sit in history or a screenshot.
  const TOKEN_KEY = "octiq.web.token";
  const url = new URL(window.location.href);
  const fromUrl = url.searchParams.get("token");
  if (fromUrl) {
    try {
      localStorage.setItem(TOKEN_KEY, fromUrl);
    } catch (_) {}
    url.searchParams.delete("token");
    history.replaceState(null, "", url.pathname + url.search + url.hash);
  }
  const token = fromUrl || localStorage.getItem(TOKEN_KEY) || "";

  // requestId -> { resolve, reject }
  const pending = new Map();
  // event name -> Set of handlers
  const listeners = new Map();
  // Calls made before the socket opened (or while it is reconnecting).
  let queue = [];
  let seq = 1;
  let socket = null;
  let retry = 0;

  function wsUrl() {
    const scheme = location.protocol === "https:" ? "wss" : "ws";
    return `${scheme}://${location.host}/ws?token=${encodeURIComponent(token)}`;
  }

  function connect() {
    socket = new WebSocket(wsUrl());

    socket.addEventListener("open", () => {
      retry = 0;
      setStatus("");
      const waiting = queue;
      queue = [];
      for (const frame of waiting) socket.send(frame);
    });

    socket.addEventListener("message", (ev) => {
      let frame;
      try {
        frame = JSON.parse(ev.data);
      } catch (_) {
        return;
      }
      if (frame.t === "reply") {
        const p = pending.get(frame.id);
        if (!p) return;
        pending.delete(frame.id);
        if (frame.ok) p.resolve(frame.result);
        else p.reject(new Error(frame.error || "command failed"));
        return;
      }
      if (frame.t === "event") {
        const set = listeners.get(frame.event);
        if (!set) return;
        // Same shape a Tauri event handler receives.
        const payload = { event: frame.event, payload: frame.payload, id: 0 };
        for (const fn of [...set]) {
          try {
            fn(payload);
          } catch (err) {
            console.error("[octiq-web] listener failed", frame.event, err);
          }
        }
      }
    });

    socket.addEventListener("close", () => {
      // The server is the machine that holds the terminals. Losing the socket
      // loses the VIEW, never the sessions, so reconnecting simply picks the
      // stream back up. Back off to a few seconds so a sleeping phone does not
      // hammer it.
      retry = Math.min(retry + 1, 6);
      const wait = Math.min(500 * 2 ** (retry - 1), 8000);
      setStatus(`Reconnecting to OctiqFlow… (${Math.round(wait / 1000)}s)`);
      setTimeout(connect, wait);
    });

    socket.addEventListener("error", () => {
      try {
        socket.close();
      } catch (_) {}
    });
  }

  /** A thin banner when the socket is down, so a stale-looking screen explains
   *  itself instead of just going quiet. */
  function setStatus(text) {
    let el = document.getElementById("octiq-web-status");
    if (!text) {
      el?.remove();
      return;
    }
    if (!el) {
      el = document.createElement("div");
      el.id = "octiq-web-status";
      el.style.cssText =
        "position:fixed;left:0;right:0;top:0;z-index:9999;padding:6px 10px;" +
        "font:12px system-ui,sans-serif;text-align:center;color:#111;" +
        "background:#f0b429;";
      (document.body || document.documentElement).append(el);
    }
    el.textContent = text;
  }

  function send(frame) {
    const text = JSON.stringify(frame);
    if (socket && socket.readyState === WebSocket.OPEN) socket.send(text);
    else queue.push(text);
  }

  function invoke(cmd, args) {
    return new Promise((resolve, reject) => {
      const id = seq++;
      pending.set(id, { resolve, reject });
      send({ t: "invoke", id, cmd, args: args ?? {} });
    });
  }

  async function listen(event, handler) {
    let set = listeners.get(event);
    if (!set) listeners.set(event, (set = new Set()));
    set.add(handler);
    return () => set.delete(handler);
  }

  async function once(event, handler) {
    const un = await listen(event, (e) => {
      un();
      handler(e);
    });
    return un;
  }

  window.__TAURI__ = {
    core: { invoke, convertFileSrc: (p) => p },
    event: { listen, once, emit: async () => {} },
    // Marker: the app is running as a remote client, not the desktop window.
    // Modules that must behave differently (attaching to existing terminals
    // rather than spawning fresh ones) read this.
    web: true,
  };
  window.OCTIQ_WEB = true;

  connect();
})();
