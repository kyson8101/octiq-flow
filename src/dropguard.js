// Global guard against drags that come from OUTSIDE the app.
//
// The window runs with `dragDropEnabled: false` (tauri.conf.json) so the
// frontend can use the HTML5 drag-and-drop APIs — tab reorder/move between
// panes (terminals.js) and project reorder/shelve (workspaces.js) all depend on
// them. The cost of that switch is that the webview keeps its OWN default file
// handling: drop a file from Finder anywhere on the page and WKWebView NAVIGATES
// to it. The app is then gone — replaced by the webview's built-in preview of
// that file, with no back button and no way out short of restarting the app.
//
// So every external drag is swallowed here. An external drag is one carrying
// "Files" (dragged out of Finder) or "text/uri-list" (a link dragged out of a
// browser) — the two payloads that trigger that navigation. The app's own drags
// only ever set "text/plain", so they are ignored by this module and the
// existing per-element handlers keep working exactly as before.
//
// The listeners run in the CAPTURE phase, so the default is cancelled before any
// element handler can decide otherwise. Cancelling the default does not stop the
// event: handlers deeper in the tree still run, so a real "drop a file here"
// feature can be added later without fighting this guard.

/** dataTransfer payloads that make the webview navigate away from the app. */
const EXTERNAL_TYPES = ["Files", "text/uri-list"];

/** True when the drag came from another app (Finder, a browser), not from us. */
function isExternalDrag(e) {
  const types = e.dataTransfer?.types;
  if (!types) return false;
  const list = Array.from(types);
  return EXTERNAL_TYPES.some((t) => list.includes(t));
}

for (const type of ["dragenter", "dragover"]) {
  window.addEventListener(
    type,
    (e) => {
      if (!isExternalDrag(e)) return;
      // Claiming the drag is what keeps the drop from reaching the webview.
      e.preventDefault();
      // …and shows the "not allowed" cursor, so the drop reads as refused
      // rather than as something that silently did nothing.
      if (e.dataTransfer) e.dataTransfer.dropEffect = "none";
    },
    true,
  );
}

window.addEventListener(
  "drop",
  (e) => {
    if (!isExternalDrag(e)) return;
    e.preventDefault();
  },
  true,
);
