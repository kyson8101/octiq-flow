// Desktop side of the remote-access bridge (see src-tauri/src/web.rs).
//
// A browser attached to this machine sends `invoke(cmd, args)` over its
// WebSocket. Rather than keep a second dispatch table for all 96 backend
// commands, the server hands the call to THIS window — which already has full
// IPC access — and we call it here and post the answer back:
//
//   web.rs  ──emit "web-invoke" {id,cmd,args}──►  this file
//   web.rs  ◄──invoke web_reply {id,ok,result}──  this file
//
// So a browser can call anything the desktop UI can, and a new backend command
// needs no work here at all.
//
// Only ever active in the desktop window: a browser client has no real Tauri
// IPC, and its shim never emits `web-invoke`.
const { invoke } = window.__TAURI__.core;
const { listen } = window.__TAURI__.event;

if (!window.OCTIQ_WEB) {
  listen("web-invoke", async (e) => {
    const { id, cmd, args } = e.payload || {};
    if (typeof id !== "number" || !cmd) return;
    try {
      const result = await invoke(cmd, args || {});
      // `undefined` is not JSON: send null so the waiting side always resolves.
      await invoke("web_reply", { id, ok: true, result: result ?? null });
    } catch (err) {
      await invoke("web_reply", {
        id,
        ok: false,
        error: String(err?.message || err || "command failed"),
      });
    }
  });
}
