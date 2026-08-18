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
  //
  // Three checks, not one: `__TAURI_INTERNALS__` is injected by Tauri v2 in
  // every case, and the protocol names the webview outright. If this shim ever
  // installed itself INSIDE the desktop window it would replace working IPC
  // with a socket to nowhere and take the whole app down with it, so the guard
  // errs heavily towards doing nothing.
  const insideTauri =
    !!window.__TAURI__ ||
    !!window.__TAURI_INTERNALS__ ||
    location.protocol === "tauri:" ||
    location.hostname === "tauri.localhost";
  if (insideTauri) return;

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

    socket.addEventListener("close", async () => {
      // A refused handshake closes exactly like an unreachable server, so ask
      // over plain HTTP which one it was. Retrying cannot fix a bad token, and
      // saying "reconnecting" when the real answer is "this browser was never
      // let in" sends the user looking for a network problem that is not there.
      if (await tokenRejected()) {
        askForToken();
        return;
      }
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

  /** True when the server answered and said this token is no good. A network
   *  failure answers false — that is the case worth retrying. */
  async function tokenRejected() {
    try {
      const res = await fetch(
        `${location.protocol}//${location.host}/auth?token=${encodeURIComponent(token)}`,
        { cache: "no-store" },
      );
      return res.status === 401;
    } catch (_) {
      return false;
    }
  }

  /** Ask for the token, since no amount of waiting will produce one. Plain DOM:
   *  this runs before the app's own modules and must not depend on them. */
  function askForToken() {
    setStatus("");
    if (document.getElementById("octiq-web-gate")) return;
    const gate = document.createElement("div");
    gate.id = "octiq-web-gate";
    gate.style.cssText =
      "position:fixed;inset:0;z-index:10000;display:flex;align-items:center;" +
      "justify-content:center;padding:20px;background:#1c1c1e;" +
      "font:14px/1.5 -apple-system,BlinkMacSystemFont,system-ui,sans-serif;color:#d8d8dc;";
    gate.innerHTML =
      '<div style="max-width:420px;width:100%;padding:22px;background:#2c2c2e;' +
      'border:1px solid rgba(84,84,88,.65);border-radius:14px;">' +
      '<h1 style="margin:0 0 8px;font-size:19px;color:#f5f5f7;">Connect to OctiqFlow</h1>' +
      '<p style="margin:0 0 14px;color:rgba(235,235,245,.6);">This browser needs the access ' +
      "token of the machine running OctiqFlow. It is printed in that machine's terminal at " +
      "startup.</p>" +
      '<form style="display:flex;gap:8px;">' +
      '<input id="octiq-gate-input" placeholder="Paste the token" spellcheck="false" ' +
      'autocapitalize="none" autocorrect="off" style="flex:1;min-width:0;padding:9px 11px;' +
      "background:#1c1c1e;color:#f5f5f7;border:1px solid rgba(84,84,88,.65);border-radius:10px;" +
      'font:16px ui-monospace,Menlo,monospace;outline:none;" />' +
      '<button type="submit" style="padding:9px 15px;border:0;border-radius:10px;' +
      'background:#0a84ff;color:#fff;font:inherit;cursor:pointer;">Connect</button>' +
      "</form></div>";
    document.body.append(gate);
    const input = gate.querySelector("#octiq-gate-input");
    gate.querySelector("form").addEventListener("submit", (e) => {
      e.preventDefault();
      const value = input.value.trim();
      if (!value) return;
      try {
        localStorage.setItem(TOKEN_KEY, value);
      } catch (_) {}
      // The whole app reads the token once at load, so the simplest correct
      // thing is to start over with it in place.
      location.reload();
    });
    input.focus();
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
