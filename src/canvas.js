// Canvas pane: a togglable split beside the project terminals that renders a
// live HTML/Markdown document an agent writes.
//
// Flow (mirrors the rest of the app — no IPC socket, just files + a watcher):
//   agent writes a file into ~/.octiqflow/canvas/<projectKey>/  (it learns the
//   folder from the OCTIQ_CANVAS_DIR env var pty.rs exports into the terminal)
//        │
//   canvas.rs `notify` watcher  ──►  "canvas-changed" {key}  event
//        │
//   this module re-lists the folder (canvas_list) + re-reads the shown document
//   (canvas_read) and renders it in a SANDBOXED iframe.
//
// The iframe is sandboxed with allow-scripts but NOT allow-same-origin, so agent
// HTML runs in an isolated opaque origin: it can draw/animate but cannot reach
// the app, Tauri, the network, or the user's machine. Markdown is rendered to
// HTML with the vendored `marked` (window.marked) and wrapped in a dark theme.
//
// This module is the ONLY owner of the canvas pane. It listens for two window
// events it does not emit: `project-selected` (from workspaces.js, to know the
// active project key) and `canvas-changed` (from the Rust watcher).
import { sendToProjectTerminal } from "/terminals.js";
import { formatBytes, loadPaneWidth, makeResizer, timeAgo } from "/util.js";

const { invoke } = window.__TAURI__.core;
const { listen } = window.__TAURI__.event;

// localStorage keys: whether the pane is open, and its width in px. Both are
// global (not per project) — the canvas is a workspace-wide preference.
const OPEN_KEY = "octiq.canvas.open";
const WIDTH_KEY = "octiq.canvas.width";
const DEFAULT_WIDTH = 460;
const MIN_WIDTH = 280;

// DOM handles (all inside #view-project). Resolved once at init.
let pane, resizer, toggleBtn, docSelect, openBtn, refreshBtn, deleteBtn, deleteAllBtn, closeBtn, frame, emptyEl, headEl, bodyEl;
let emptyInstallBtn, emptyStatusEl, emptyPathEl;
// All-canvases manager (modal listing every project's canvas docs).
let allBtn, allModal, allListEl, allEmptyEl, allCloseBtn, allDoneBtn, allDeleteAllBtn;
// Highlight-to-ask controls.
let askBtn, askPanel, askQuote, askInput, askSend, askCancel, askStatus;
// The text the user last selected inside the frame (kept while they click out to
// the parent button/composer, since clicking the parent does not clear it).
let selectedText = "";

// The selected project's key (its workspace id), or null when none is selected.
let currentKey = null;
// Newest-first list of the current project's canvas documents (from canvas_list).
let currentDocs = [];
// The document name currently rendered in the frame (for scroll keying), or null.
let shownName = null;
// Remembered scroll position per document (`${key}::${name}` -> y), so a living
// doc the agent keeps updating does not jump back to the top on each re-render.
const scrollByDoc = new Map();
// When true, always show the most recently changed document (the common case:
// one living canvas the agent keeps updating). A manual pick from the dropdown
// turns this off and pins `pinnedName` until the user chooses "Auto" again.
let autoFollow = true;
let pinnedName = null;
// Whether the pane is open (shown). Restored from localStorage at init.
let canvasOpen = false;
let canvasWidth = DEFAULT_WIDTH;

/** Show or hide the pane (and its drag handle), persist the choice, and keep the
 *  toggle button's pressed state in sync. Opening reloads the current document
 *  so a freshly shown pane is never stale. A resize event nudges the terminals
 *  to refit to the new center width. */
function setOpen(open) {
  canvasOpen = open;
  localStorage.setItem(OPEN_KEY, open ? "1" : "0");
  pane.classList.toggle("hidden", !open);
  resizer.classList.toggle("hidden", !open);
  if (open) pane.style.width = `${canvasWidth}px`;
  if (toggleBtn) {
    toggleBtn.setAttribute("aria-pressed", open ? "true" : "false");
    toggleBtn.classList.toggle("active", open);
    toggleBtn.dataset.tip = open ? "Hide canvas" : "Show canvas";
  }
  if (open) reload();
  // Let the terminals refit to the changed width (their panes have a
  // ResizeObserver; this is a belt-and-braces nudge for any missed layout).
  requestAnimationFrame(() => window.dispatchEvent(new Event("resize")));
}

// Script injected into every rendered document (the frame is sandboxed, so the
// parent cannot read its scroll or selection across the opaque origin — the
// document must post them out). Two jobs:
//   1. Scroll sync — report scroll position (throttled) + accept a restore.
//   2. Selection — on mouse/key release, post the selected text and its rect so
//      canvas.js can float the "Ask about this" button by it.
const FRAME_SCRIPT = `
(function () {
  var el = document.scrollingElement || document.documentElement;
  var last = 0;
  addEventListener("scroll", function () {
    var now = Date.now();
    if (now - last < 120) return;
    last = now;
    parent.postMessage({ type: "octiq-canvas-scroll", y: el.scrollTop }, "*");
  }, { passive: true });
  addEventListener("message", function (e) {
    if (e.data && e.data.type === "octiq-canvas-restore") el.scrollTop = e.data.y || 0;
  });
  function sendSel() {
    var sel = window.getSelection ? getSelection() : null;
    var text = sel ? String(sel) : "";
    var rect = null;
    if (text.trim() && sel.rangeCount) {
      var r = sel.getRangeAt(0).getBoundingClientRect();
      rect = { left: r.left, top: r.top, right: r.right, bottom: r.bottom };
    }
    parent.postMessage({ type: "octiq-canvas-selection", text: text.trim(), rect: rect }, "*");
  }
  addEventListener("mouseup", function () { setTimeout(sendSel, 0); });
  addEventListener("keyup", function () { setTimeout(sendSel, 0); });
})();
`;

/** The ONE fixed canvas template. Every Markdown render and every HTML *fragment*
 *  is wrapped in this, so canvases look the same across sessions without the
 *  agent re-writing CSS each time. It is a small component system built from the
 *  app's zen tokens (styles.css :root) — keep the token values in sync with that
 *  sheet. A full HTML document (one with its own <!doctype>/<html>) bypasses this
 *  and styles itself; see buildSrcdoc.
 *
 *  Classes the agent can use in a fragment (documented in the canvas skill):
 *    .card .grid .stat(.num/.label) .badge(.accent/.ok/.warn/.danger)
 *    .callout(.ok/.warn/.danger) .eyebrow .meta .muted .row .spread kbd
 *  plus all plain HTML (h1–h4, p, ul/ol, table, pre/code, blockquote, hr, img). */
const CANVAS_CSS = `
  :root {
    color-scheme: dark;
    --bg-0:#141417; --bg-2:#232329; --bg-sunken:#0f0f12;
    --border:#26262b; --border-strong:#34343c;
    --fg-0:#f0f0ee; --fg-1:#cfcfca; --fg-2:#8f8f8a;
    --accent:#8fbfa8; --ok:#85c79a; --danger:#de8d85; --warn:#d4b06a;
    --r-sm:6px;
  }
  html, body { margin: 0; }
  body {
    padding: 26px 28px 60px;
    max-width: 760px;
    color: var(--fg-1);
    background: var(--bg-0);
    font: 14.5px/1.75 -apple-system, BlinkMacSystemFont, "SF Pro Text", Inter, "Segoe UI", system-ui, sans-serif;
    word-wrap: break-word;
  }
  /* Typography — plain and airy, no chrome */
  h1, h2, h3, h4 { line-height: 1.3; color: var(--fg-0); font-weight: 600; }
  h1 { font-size: 1.6em; margin: 0 0 .6em; letter-spacing: -.01em; }
  h2 { font-size: 1.24em; margin: 1.9em 0 .5em; }
  h3 { font-size: 1.05em; margin: 1.5em 0 .4em; }
  h4 { font-size: .82em; color: var(--fg-2); text-transform: uppercase; letter-spacing: .06em; margin: 1.4em 0 .3em; }
  p, ul, ol, table, pre, blockquote { margin: .9em 0; }
  ul, ol { padding-left: 1.25em; } li { margin: .35em 0; }
  a { color: var(--accent); text-decoration: none; border-bottom: 1px solid transparent; }
  a:hover { border-bottom-color: currentColor; }
  strong { color: var(--fg-0); font-weight: 600; }
  hr { border: none; border-top: 1px solid var(--border); margin: 2.2em 0; }
  img { max-width: 100%; height: auto; }
  /* Code — minimal, no boxed block border */
  code { font-family: ui-monospace, SFMono-Regular, "JetBrains Mono", Menlo, monospace; font-size: .88em; color: var(--fg-0); }
  :not(pre) > code { background: var(--bg-2); padding: 1px 5px; border-radius: 4px; }
  pre { background: var(--bg-sunken); padding: 14px 16px; border-radius: var(--r-sm); overflow: auto; }
  pre code { font-size: .86em; }
  /* Tables — horizontal rules only, no surrounding box */
  table { border-collapse: collapse; width: 100%; font-size: .94em; }
  th, td { padding: 8px 14px 8px 0; text-align: left; vertical-align: top; border-bottom: 1px solid var(--border); }
  th { color: var(--fg-0); font-weight: 600; }
  /* Blockquote — a single hairline rule, never a colored bar */
  blockquote { border-left: 1px solid var(--border-strong); margin-left: 0; padding: .1em 0 .1em 14px; color: var(--fg-2); }
  /* Components — flattened: no panels, no tinted boxes, no colored bars. The
     classes are kept so canvases written for the old template still render. */
  .card { margin: 1.2em 0; }
  .card > :first-child, .callout > :first-child { margin-top: 0; }
  .card > :last-child, .callout > :last-child { margin-bottom: 0; }
  .grid { display: grid; gap: 18px 28px; grid-template-columns: repeat(auto-fit, minmax(140px, 1fr)); margin: 1.2em 0; }
  .stat { padding: 0; }
  .stat .num { font-size: 1.7em; color: var(--fg-0); font-weight: 600; line-height: 1.15; }
  .stat .label { font-size: .76em; color: var(--fg-2); text-transform: uppercase; letter-spacing: .05em; margin-top: 2px; }
  /* Callout — a plain block; status variants only tint its lead text, no bar/box. */
  .callout { margin: 1.2em 0; color: var(--fg-1); }
  .callout.ok strong, .callout.ok b { color: var(--ok); }
  .callout.warn strong, .callout.warn b { color: var(--warn); }
  .callout.danger strong, .callout.danger b { color: var(--danger); }
  /* Badge — a flat hairline pill (no fill); variants recolor text + outline only. */
  .badge, .pill { display: inline-block; font-size: .75em; font-weight: 600; padding: 1px 8px; border-radius: 999px;
                  background: none; color: var(--fg-2); border: 1px solid var(--border-strong); }
  .badge.accent { color: var(--accent); border-color: rgba(143,191,168,.5); }
  .badge.ok { color: var(--ok); border-color: rgba(133,199,154,.5); }
  .badge.warn { color: var(--warn); border-color: rgba(212,176,106,.5); }
  .badge.danger { color: var(--danger); border-color: rgba(222,141,133,.5); }
  kbd, .kbd { font-family: ui-monospace, monospace; font-size: .8em; background: var(--bg-2);
              border: 1px solid var(--border-strong); border-radius: 4px; padding: 1px 6px; color: var(--fg-0); }
  .eyebrow { font-size: .74em; text-transform: uppercase; letter-spacing: .08em; color: var(--fg-2); font-weight: 600; margin-bottom: .2em; }
  .meta, .muted, small { color: var(--fg-2); } .meta { font-size: .88em; }
  .row { display: flex; gap: 10px; align-items: center; flex-wrap: wrap; }
  .spread { display: flex; justify-content: space-between; align-items: center; gap: 10px; }
  .right { text-align: right; } .center { text-align: center; }
`;

/** Wrap inner HTML (rendered Markdown, a plain-text fallback, or an agent HTML
 *  fragment) in the fixed canvas template so it reads as part of OctiqFlow. */
function wrapHtml(inner) {
  return `<!doctype html><html><head><meta charset="utf-8">
<style>${CANVAS_CSS}</style></head><body>${inner}
<script>${FRAME_SCRIPT}</script>
</body></html>`;
}

/** Escape text so a plain-text or unsupported file renders literally (no markup
 *  injection) inside the wrapper. */
function escapeHtml(s) {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

/** Whether `content` is a COMPLETE HTML document (starts with a doctype or an
 *  <html> root) rather than a body fragment. A full document brings its own
 *  styles, so it renders as-is; a fragment is wrapped in the fixed OctiqFlow
 *  template so every canvas shares one look. Tolerates leading whitespace. */
function isFullHtmlDoc(content) {
  return /^\s*<(!doctype\b|html[\s>])/i.test(content);
}

/** Build the iframe `srcdoc` for a document of the given kind + raw content.
 *  A full HTML document is shown as-is (the escape hatch for custom styling);
 *  an HTML *fragment* and rendered Markdown both go through the fixed template;
 *  anything else falls back to escaped preformatted text. */
function buildSrcdoc(kind, content) {
  if (kind === "html") {
    // Full doc → as-is (append the helper script so scroll-keep + highlight-to-ask
    // still work). Fragment → wrap in the shared template.
    return isFullHtmlDoc(content)
      ? `${content}\n<script>${FRAME_SCRIPT}</script>`
      : wrapHtml(content);
  }
  if (kind === "md") {
    const html = window.marked?.parse ? window.marked.parse(content) : escapeHtml(content);
    return wrapHtml(html);
  }
  return wrapHtml(`<pre>${escapeHtml(content)}</pre>`);
}

/** Swap the empty-state for the rendered frame (or back). */
function showFrame(on) {
  frame.classList.toggle("hidden", !on);
  emptyEl.classList.toggle("hidden", on);
}

/** Render one document by name into the sandboxed iframe. Errors (missing/too
 *  large) surface as a themed message rather than a blank pane. */
async function renderDoc(name) {
  const doc = currentDocs.find((d) => d.name === name);
  if (!doc) {
    showFrame(false);
    return;
  }
  let content;
  try {
    content = await invoke("canvas_read", { key: currentKey, name });
  } catch (err) {
    shownName = null;
    frame.onload = null;
    frame.srcdoc = wrapHtml(`<p style="color:#d98c8c">Could not read “${escapeHtml(name)}”: ${escapeHtml(String(err))}</p>`);
    showFrame(true);
    return;
  }
  shownName = name;
  // After the new content loads, ask the frame to restore the scroll position we
  // remembered for this document (markdown/text frames honour the message; raw
  // HTML ignores it). Set the handler BEFORE assigning srcdoc so it fires.
  const y = scrollByDoc.get(`${currentKey}::${name}`) || 0;
  frame.onload = () => {
    if (y) frame.contentWindow?.postMessage({ type: "octiq-canvas-restore", y }, "*");
  };
  frame.srcdoc = buildSrcdoc(doc.kind, content);
  showFrame(true);
}

/** Fill the document dropdown: an "Auto (latest)" entry plus one per document,
 *  newest first. Keeps the current selection if it still exists. */
function populateSelect() {
  docSelect.replaceChildren();
  const auto = document.createElement("option");
  auto.value = "";
  auto.textContent = "Auto (latest)";
  docSelect.append(auto);
  for (const d of currentDocs) {
    const opt = document.createElement("option");
    opt.value = d.name;
    opt.textContent = d.name;
    docSelect.append(opt);
  }
  docSelect.value = autoFollow ? "" : pinnedName && currentDocs.some((d) => d.name === pinnedName) ? pinnedName : "";
  const none = !currentDocs.length;
  if (deleteBtn) deleteBtn.disabled = none;
  if (deleteAllBtn) deleteAllBtn.disabled = none;
}

/** Flash a short sage pulse so a change is noticed: the header while the pane is
 *  open, or the toggle button while it is closed. Re-triggering restarts the
 *  animation (remove → reflow → add). */
function pulse(el) {
  if (!el) return;
  el.classList.remove("canvas-pulse");
  void el.offsetWidth;
  el.classList.add("canvas-pulse");
}

/** Show the canvas folder path in the empty state (so the user knows where the
 *  agent should write), or clear it when no project is selected. */
async function updateEmptyMeta() {
  if (!emptyPathEl) return;
  if (!currentKey) {
    emptyPathEl.textContent = "";
    return;
  }
  try {
    const dir = await invoke("canvas_dir", { key: currentKey });
    emptyPathEl.textContent = dir;
  } catch {
    emptyPathEl.textContent = "";
  }
}

/** Re-list the current project's canvas folder and render the right document.
 *  No-op (shows empty) when no project is selected or the folder is empty.
 *  Skips the network round-trip entirely while the pane is closed. `pulse:true`
 *  flashes the header after rendering (used on a live, watcher-driven change). */
async function reload({ pulse: doPulse = false } = {}) {
  if (!canvasOpen) return;
  // The previous selection's position is stale once content reloads; hide the
  // floating button (leave an open composer alone so typing is not lost).
  askBtn?.classList.add("hidden");
  if (!currentKey) {
    currentDocs = [];
    shownName = null;
    showFrame(false);
    if (docSelect) docSelect.replaceChildren();
    if (deleteBtn) deleteBtn.disabled = true;
    if (deleteAllBtn) deleteAllBtn.disabled = true;
    updateEmptyMeta();
    return;
  }
  try {
    currentDocs = (await invoke("canvas_list", { key: currentKey })) || [];
  } catch {
    currentDocs = [];
  }
  populateSelect();
  if (!currentDocs.length) {
    shownName = null;
    showFrame(false);
    updateEmptyMeta();
    return;
  }
  // Pick the document to show: the newest when following, else the pinned one
  // (falling back to newest if it has gone away). currentDocs is newest-first.
  let target;
  if (autoFollow || !currentDocs.some((d) => d.name === pinnedName)) {
    target = currentDocs[0].name;
  } else {
    target = pinnedName;
  }
  await renderDoc(target);
  if (doPulse) pulse(headEl);
}

/** Delete the currently shown canvas document (after a confirm). The watcher
 *  also fires on the removal, but we reload right away so the pane updates even
 *  if the watcher event is missed. */
async function deleteCurrent() {
  const name = shownName || docSelect.value || currentDocs[0]?.name;
  if (!currentKey || !name) return;
  if (!confirm(`Delete the canvas “${name}”? This removes the file from disk.`)) return;
  try {
    await invoke("canvas_delete", { key: currentKey, name });
  } catch (err) {
    console.error("canvas_delete failed", err);
  }
  // Stop pinning a doc we just removed; fall back to following the latest.
  if (pinnedName === name) {
    autoFollow = true;
    pinnedName = null;
  }
  reload();
}

/** Delete every canvas document in the current project (after a confirm). */
async function deleteAll() {
  if (!currentKey || !currentDocs.length) return;
  if (!confirm(`Delete all ${currentDocs.length} canvas documents in this project? This removes the files from disk.`)) return;
  try {
    await invoke("canvas_delete_all", { key: currentKey });
  } catch (err) {
    console.error("canvas_delete_all failed", err);
  }
  autoFollow = true;
  pinnedName = null;
  reload();
}

/** Open one project's canvas document with the OS default app (e.g. a browser
 *  for HTML). Best-effort — opening externally is a convenience, never critical. */
async function openDocExternally(key, name) {
  if (!key || !name) return;
  try {
    const dir = await invoke("canvas_dir", { key });
    const sep = dir.includes("\\") && !dir.includes("/") ? "\\" : "/";
    await invoke("plugin:opener|open_path", { path: `${dir}${sep}${name}`, with: null });
  } catch {
    // Best-effort.
  }
}

/** Open the shown document with the OS default app. */
function openExternally() {
  openDocExternally(currentKey, docSelect.value || currentDocs[0]?.name);
}

/** Fetch every project's canvases + the workspace list, then render the manager.
 *  Keys map to project names via the workspace store; an unmatched key is an
 *  orphan folder from a deleted project (shown as such so it can be cleaned up). */
async function renderAllList() {
  if (!allListEl) return;
  let projects = [];
  let names = new Map();
  try {
    projects = (await invoke("canvas_list_all")) || [];
  } catch (err) {
    console.error("canvas_list_all failed", err);
  }
  try {
    for (const w of (await invoke("list_workspaces")) || []) names.set(w.id, w.name);
  } catch {
    // No names → fall back to keys; the list still works.
  }
  allListEl.replaceChildren();
  const empty = !projects.length;
  allEmptyEl?.classList.toggle("hidden", !empty);
  if (allDeleteAllBtn) allDeleteAllBtn.disabled = empty;
  for (const proj of projects) {
    allListEl.append(buildProjectGroup(proj, names.get(proj.key)));
  }
}

/** Build one project's group: a header (name + count + delete-all) and a row per
 *  document (name/meta + open + delete). `name` is undefined for an orphan key. */
function buildProjectGroup(proj, name) {
  const group = document.createElement("div");
  group.className = "canvas-all-group";

  const head = document.createElement("div");
  head.className = "canvas-all-group-head";
  const title = document.createElement("span");
  title.className = "canvas-all-project";
  title.textContent = name || "Unknown project";
  if (!name) title.classList.add("orphan");
  const count = document.createElement("span");
  count.className = "canvas-all-count";
  count.textContent = `${proj.docs.length} doc${proj.docs.length === 1 ? "" : "s"}`;
  const delAll = document.createElement("button");
  delAll.className = "btn btn-sm btn-danger";
  delAll.type = "button";
  delAll.textContent = "Delete all";
  delAll.addEventListener("click", () => deleteProjectAll(proj.key, name || proj.key));
  head.append(title, count, delAll);
  group.append(head);

  for (const doc of proj.docs) {
    group.append(buildDocRow(proj.key, doc));
  }
  return group;
}

/** Build one document row inside a project group. */
function buildDocRow(key, doc) {
  const row = document.createElement("div");
  row.className = "canvas-all-row";
  const info = document.createElement("div");
  info.className = "canvas-all-info";
  const nameEl = document.createElement("span");
  nameEl.className = "canvas-all-name";
  nameEl.textContent = doc.name;
  const meta = document.createElement("span");
  meta.className = "canvas-all-meta";
  meta.textContent = [timeAgo(doc.modified), formatBytes(doc.size)].filter(Boolean).join(" · ");
  info.append(nameEl, meta);

  const open = document.createElement("button");
  open.className = "icon-btn";
  open.type = "button";
  open.dataset.tip = "Open with the default app";
  open.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M15 3h6v6"/><path d="M10 14 21 3"/><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/></svg>';
  open.addEventListener("click", () => openDocExternally(key, doc.name));

  const del = document.createElement("button");
  del.className = "icon-btn";
  del.type = "button";
  del.dataset.tip = "Delete this canvas";
  del.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 6h18"/><path d="M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6"/><path d="M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2"/></svg>';
  del.addEventListener("click", async () => {
    if (!confirm(`Delete the canvas “${doc.name}”? This removes the file from disk.`)) return;
    try {
      await invoke("canvas_delete", { key, name: doc.name });
    } catch (err) {
      console.error("canvas_delete failed", err);
    }
    if (key === currentKey) reload();
    renderAllList();
  });

  row.append(info, open, del);
  return row;
}

/** Delete every canvas in one project from the manager, then re-render. */
async function deleteProjectAll(key, label) {
  if (!confirm(`Delete all canvases in “${label}”? This removes the files from disk.`)) return;
  try {
    await invoke("canvas_delete_all", { key });
  } catch (err) {
    console.error("canvas_delete_all failed", err);
  }
  if (key === currentKey) reload();
  renderAllList();
}

/** Delete every canvas in every project (after a confirm), then re-render. */
async function deleteAllEverywhere() {
  let projects = [];
  try {
    projects = (await invoke("canvas_list_all")) || [];
  } catch {
    return;
  }
  if (!projects.length) return;
  if (!confirm(`Delete ALL canvases in all ${projects.length} projects? This removes the files from disk.`)) return;
  for (const proj of projects) {
    try {
      await invoke("canvas_delete_all", { key: proj.key });
    } catch (err) {
      console.error("canvas_delete_all failed", err);
    }
  }
  reload();
  renderAllList();
}

/** Show / hide the all-canvases manager. Opening renders the current list. */
function setAllOpen(open) {
  if (!allModal) return;
  allModal.classList.toggle("hidden", !open);
  if (open) renderAllList();
}

/** A text selection inside the frame changed. Float the ask button by it, or
 *  hide it when the selection is empty. Ignored while the composer is open so it
 *  does not jump around as focus moves to the parent UI. */
function onSelection(text, rect) {
  if (askPanel && !askPanel.classList.contains("hidden")) return; // composer open
  selectedText = text || "";
  if (selectedText && rect) showAskBtn(rect);
  else askBtn?.classList.add("hidden");
}

/** Position the floating ask button just below the selection, clamped to the
 *  pane. rect is in the frame's viewport, which maps 1:1 onto the canvas body
 *  (the iframe fills it with no offset). */
function showAskBtn(rect) {
  if (!askBtn || !bodyEl) return;
  const w = bodyEl.clientWidth;
  const h = bodyEl.clientHeight;
  const btnW = 132;
  const left = Math.max(6, Math.min(rect.left, w - btnW - 6));
  // Below the selection, unless that falls off the bottom — then place above.
  let top = rect.bottom + 6;
  if (top > h - 40) top = Math.max(6, rect.top - 34);
  askBtn.style.left = `${left}px`;
  askBtn.style.top = `${top}px`;
  askBtn.classList.remove("hidden");
}

/** Open the composer for the current selection: show the quote, focus the box. */
function openComposer() {
  if (!askPanel || !selectedText) return;
  askBtn?.classList.add("hidden");
  const snippet = selectedText.replace(/\s+/g, " ").trim();
  askQuote.textContent = snippet.length > 200 ? `${snippet.slice(0, 200)}…` : snippet;
  if (askStatus) askStatus.textContent = "";
  askInput.value = "";
  askPanel.classList.remove("hidden");
  askInput.focus();
}

/** Hide the composer and the floating button. */
function closeComposer() {
  askPanel?.classList.add("hidden");
  askBtn?.classList.add("hidden");
}

/** Compose a SINGLE-LINE message (safe for a TUI agent — stray newlines would
 *  submit early) quoting the selection, and write it into the project's active
 *  terminal with Enter (auto-submit). Surfaces a hint if no terminal is open. */
function sendAsk() {
  const question = (askInput?.value || "").replace(/\s+/g, " ").trim();
  if (!question) {
    askInput?.focus();
    return;
  }
  const snippet = selectedText.replace(/\s+/g, " ").trim().slice(0, 240);
  const message = `About "${snippet}" on the canvas: ${question}`;
  if (sendToProjectTerminal(currentKey, message, true)) {
    closeComposer();
    selectedText = "";
  } else if (askStatus) {
    askStatus.textContent = "No open terminal in this project to send to.";
  }
}

/** Drag the handle to resize the pane (shared helper, card 26). On release the
 *  terminals need a nudge to refit to the new center width. */
function wireResizer() {
  makeResizer({
    paneEl: pane,
    resizerEl: resizer,
    storageKey: WIDTH_KEY,
    minWidth: MIN_WIDTH,
    onResize: (width) => {
      canvasWidth = width;
      window.dispatchEvent(new Event("resize"));
    },
  });
}

function init() {
  pane = document.getElementById("canvas-pane");
  resizer = document.getElementById("canvas-resizer");
  toggleBtn = document.getElementById("canvas-toggle");
  docSelect = document.getElementById("canvas-doc");
  openBtn = document.getElementById("canvas-open");
  refreshBtn = document.getElementById("canvas-refresh");
  deleteBtn = document.getElementById("canvas-delete");
  deleteAllBtn = document.getElementById("canvas-delete-all");
  allBtn = document.getElementById("canvas-all");
  allModal = document.getElementById("canvas-all-modal");
  allListEl = document.getElementById("canvas-all-list");
  allEmptyEl = document.getElementById("canvas-all-empty");
  allCloseBtn = document.getElementById("canvas-all-close");
  allDoneBtn = document.getElementById("canvas-all-done");
  allDeleteAllBtn = document.getElementById("canvas-all-delete-all");
  closeBtn = document.getElementById("canvas-close");
  frame = document.getElementById("canvas-frame");
  emptyEl = document.getElementById("canvas-empty");
  headEl = pane?.querySelector(".canvas-head");
  bodyEl = document.getElementById("canvas-body");
  emptyInstallBtn = document.getElementById("canvas-empty-install");
  emptyStatusEl = document.getElementById("canvas-empty-status");
  emptyPathEl = document.getElementById("canvas-empty-path");
  askBtn = document.getElementById("canvas-ask-btn");
  askPanel = document.getElementById("canvas-ask");
  askQuote = document.getElementById("canvas-ask-quote");
  askInput = document.getElementById("canvas-ask-input");
  askSend = document.getElementById("canvas-ask-send");
  askCancel = document.getElementById("canvas-ask-cancel");
  askStatus = document.getElementById("canvas-ask-status");
  // Bail quietly if the project view is not present (defensive).
  if (!pane || !toggleBtn) return;

  askBtn?.addEventListener("click", () => openComposer());
  askSend?.addEventListener("click", () => sendAsk());
  askCancel?.addEventListener("click", () => closeComposer());
  // Enter sends (auto-submit); Shift+Enter adds a newline; Escape cancels.
  askInput?.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      sendAsk();
    } else if (e.key === "Escape") {
      e.preventDefault();
      closeComposer();
    }
  });

  canvasWidth = loadPaneWidth(WIDTH_KEY, MIN_WIDTH, DEFAULT_WIDTH);

  toggleBtn.addEventListener("click", () => setOpen(!canvasOpen));
  closeBtn?.addEventListener("click", () => setOpen(false));
  refreshBtn?.addEventListener("click", () => reload());
  deleteBtn?.addEventListener("click", () => deleteCurrent());
  deleteAllBtn?.addEventListener("click", () => deleteAll());
  allBtn?.addEventListener("click", () => setAllOpen(true));
  allCloseBtn?.addEventListener("click", () => setAllOpen(false));
  allDoneBtn?.addEventListener("click", () => setAllOpen(false));
  allDeleteAllBtn?.addEventListener("click", () => deleteAllEverywhere());
  // Click the dim backdrop (outside the dialog) to close.
  allModal?.addEventListener("click", (e) => {
    if (e.target === allModal) setAllOpen(false);
  });
  openBtn?.addEventListener("click", () => openExternally());
  // Empty-state shortcut: install the Claude skill without leaving the pane.
  emptyInstallBtn?.addEventListener("click", async () => {
    emptyInstallBtn.disabled = true;
    if (emptyStatusEl) {
      emptyStatusEl.textContent = "Installing…";
      emptyStatusEl.classList.remove("settings-status-error", "settings-status-ok");
    }
    try {
      const path = await invoke("install_canvas_skill");
      if (emptyStatusEl) {
        emptyStatusEl.textContent = path ? "Skill installed. Ask Claude to use the canvas." : "Done.";
        emptyStatusEl.classList.add("settings-status-ok");
      }
    } catch (err) {
      if (emptyStatusEl) {
        emptyStatusEl.textContent = `Could not install: ${err}`;
        emptyStatusEl.classList.add("settings-status-error");
      }
    } finally {
      emptyInstallBtn.disabled = false;
    }
  });
  // Messages from the sandboxed frame: scroll position (to remember per doc) and
  // text selection (to float the ask button). Only trust OUR frame.
  window.addEventListener("message", (e) => {
    if (e.source !== frame?.contentWindow) return;
    const d = e.data;
    if (!d) return;
    if (d.type === "octiq-canvas-scroll" && currentKey && shownName) {
      scrollByDoc.set(`${currentKey}::${shownName}`, d.y || 0);
    } else if (d.type === "octiq-canvas-selection") {
      onSelection(d.text || "", d.rect || null);
    }
  });
  docSelect?.addEventListener("change", () => {
    const val = docSelect.value;
    if (val === "") {
      autoFollow = true;
      pinnedName = null;
    } else {
      autoFollow = false;
      pinnedName = val;
    }
    reload();
  });
  wireResizer();

  // Restore the saved open state (default closed — the user opts in).
  setOpen(localStorage.getItem(OPEN_KEY) === "1");

  // Track the active project. A new project resets the follow/selection state
  // and re-points the Rust watcher at that project's canvas folder.
  window.addEventListener("project-selected", (e) => {
    const id = e.detail?.id || null;
    if (id !== currentKey) {
      autoFollow = true;
      pinnedName = null;
      // Different project: drop any in-progress ask + selection.
      closeComposer();
      selectedText = "";
    }
    currentKey = id;
    invoke("canvas_watch", { key: id || "" }).catch(() => {});
    reload();
  });

  // The watcher fired: only react when the change is for the active project.
  // Open pane → re-render and pulse the header. Closed pane → pulse the toggle
  // so the user notices the canvas moved without watching it. payload is the
  // project key (a plain string).
  listen("canvas-changed", (event) => {
    if (event.payload !== currentKey) return;
    if (canvasOpen) reload({ pulse: true });
    else pulse(toggleBtn);
  });
}

init();
