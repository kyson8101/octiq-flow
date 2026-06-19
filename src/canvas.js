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

const { invoke } = window.__TAURI__.core;
const { listen } = window.__TAURI__.event;

// localStorage keys: whether the pane is open, and its width in px. Both are
// global (not per project) — the canvas is a workspace-wide preference.
const OPEN_KEY = "octiq.canvas.open";
const WIDTH_KEY = "octiq.canvas.width";
const DEFAULT_WIDTH = 460;
const MIN_WIDTH = 280;

// DOM handles (all inside #view-project). Resolved once at init.
let pane, resizer, toggleBtn, docSelect, openBtn, refreshBtn, closeBtn, frame, emptyEl, headEl, bodyEl;
let emptyInstallBtn, emptyStatusEl, emptyPathEl;
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

/** Read the saved width, clamped to something sane. */
function loadWidth() {
  const n = Number(localStorage.getItem(WIDTH_KEY));
  if (!Number.isFinite(n) || n < MIN_WIDTH) return DEFAULT_WIDTH;
  return Math.min(n, Math.floor(window.innerWidth * 0.72));
}

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
    --bg-0:#141417; --bg-1:#1b1b1f; --bg-2:#232329; --bg-sunken:#0f0f12;
    --border:#28282e; --border-strong:#36363e;
    --fg-0:#ececea; --fg-1:#c9c9c5; --fg-2:#8f8f8a; --fg-3:#67675f;
    --accent:#8fbfa8; --accent-tint:rgba(143,191,168,.13); --accent-border:rgba(143,191,168,.35);
    --ok:#85c79a; --ok-tint:rgba(133,199,154,.14);
    --danger:#de8d85; --danger-tint:rgba(222,141,133,.12);
    --warn:#d4b06a; --warn-tint:rgba(212,176,106,.12);
    --r-sm:8px; --r-md:10px; --r-lg:14px;
  }
  html, body { margin: 0; }
  body {
    padding: 18px 20px 44px;
    color: var(--fg-1);
    background: var(--bg-0);
    font: 14px/1.65 -apple-system, BlinkMacSystemFont, "SF Pro Text", Inter, "Segoe UI", system-ui, sans-serif;
    word-wrap: break-word;
  }
  /* Typography */
  h1, h2, h3, h4 { line-height: 1.25; color: var(--fg-0); margin: 1.4em 0 .5em; font-weight: 600; }
  h1 { font-size: 1.55em; margin-top: 0; }
  h2 { font-size: 1.25em; border-bottom: 1px solid var(--border); padding-bottom: .3em; }
  h3 { font-size: 1.08em; }
  h4 { font-size: .9em; color: var(--fg-2); text-transform: uppercase; letter-spacing: .04em; }
  p, ul, ol, table, pre, blockquote { margin: .6em 0; }
  ul, ol { padding-left: 1.3em; } li { margin: .25em 0; }
  a { color: var(--accent); text-decoration: none; }
  a:hover { text-decoration: underline; }
  strong { color: var(--fg-0); }
  hr { border: none; border-top: 1px solid var(--border); margin: 1.4em 0; }
  img { max-width: 100%; height: auto; border-radius: var(--r-sm); }
  /* Code */
  code { font-family: ui-monospace, SFMono-Regular, "JetBrains Mono", Menlo, monospace; font-size: .88em;
         background: var(--bg-2); color: #d7d7d2; padding: 1px 5px; border-radius: 5px; }
  pre { background: var(--bg-sunken); border: 1px solid var(--border); padding: 12px 14px;
        border-radius: var(--r-md); overflow: auto; }
  pre code { background: none; padding: 0; font-size: .86em; }
  /* Tables */
  table { border-collapse: collapse; width: 100%; font-size: .92em; }
  th, td { border: 1px solid var(--border); padding: 7px 10px; text-align: left; vertical-align: top; }
  th { background: var(--bg-1); color: var(--fg-0); font-weight: 600; }
  tr:nth-child(even) td { background: rgba(255,255,255,.015); }
  blockquote { border-left: 3px solid var(--accent); margin-left: 0; padding: .2em 0 .2em 12px; color: var(--fg-2); }
  /* Components */
  .card { background: var(--bg-1); border: 1px solid var(--border); border-radius: var(--r-lg); padding: 14px 16px; margin: .7em 0; }
  .card > :first-child, .callout > :first-child { margin-top: 0; }
  .card > :last-child, .callout > :last-child { margin-bottom: 0; }
  .grid { display: grid; gap: 12px; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); margin: .7em 0; }
  .stat { background: var(--bg-1); border: 1px solid var(--border); border-radius: var(--r-md); padding: 12px 14px; }
  .stat .num { font-size: 1.6em; color: var(--fg-0); font-weight: 600; line-height: 1.1; }
  .stat .label { font-size: .78em; color: var(--fg-2); text-transform: uppercase; letter-spacing: .04em; margin-top: 2px; }
  .badge, .pill { display: inline-block; font-size: .78em; font-weight: 600; padding: 2px 9px; border-radius: 999px;
                  background: var(--bg-2); color: var(--fg-1); border: 1px solid var(--border-strong); }
  .badge.accent { background: var(--accent-tint); color: var(--accent); border-color: var(--accent-border); }
  .badge.ok { background: var(--ok-tint); color: var(--ok); border-color: rgba(133,199,154,.4); }
  .badge.warn { background: var(--warn-tint); color: var(--warn); border-color: rgba(212,176,106,.45); }
  .badge.danger { background: var(--danger-tint); color: var(--danger); border-color: rgba(222,141,133,.4); }
  .callout { border: 1px solid var(--border); border-left: 3px solid var(--accent); background: var(--accent-tint);
             border-radius: var(--r-sm); padding: 10px 14px; margin: .7em 0; }
  .callout.ok { border-left-color: var(--ok); background: var(--ok-tint); }
  .callout.warn { border-left-color: var(--warn); background: var(--warn-tint); }
  .callout.danger { border-left-color: var(--danger); background: var(--danger-tint); }
  kbd, .kbd { font-family: ui-monospace, monospace; font-size: .8em; background: var(--bg-2);
              border: 1px solid var(--border-strong); border-bottom-width: 2px; border-radius: 5px; padding: 1px 6px; color: var(--fg-0); }
  .eyebrow { font-size: .75em; text-transform: uppercase; letter-spacing: .08em; color: var(--accent); font-weight: 600; margin-bottom: .2em; }
  .meta, .muted, small { color: var(--fg-2); } .meta { font-size: .85em; }
  .row { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }
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

/** Open the shown document with the OS default app (e.g. a browser for HTML). */
async function openExternally() {
  const name = docSelect.value || currentDocs[0]?.name;
  if (!currentKey || !name) return;
  try {
    const dir = await invoke("canvas_dir", { key: currentKey });
    const sep = dir.includes("\\") && !dir.includes("/") ? "\\" : "/";
    await invoke("plugin:opener|open_path", { path: `${dir}${sep}${name}`, with: null });
  } catch {
    // Best-effort: opening externally is a convenience, never critical.
  }
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

/** Drag the handle to resize the pane. The pane's right edge is fixed (it sits
 *  left of the command panel), so the width is that edge minus the pointer x.
 *  Clamped, and saved on release. */
function wireResizer() {
  resizer.addEventListener("pointerdown", (e) => {
    e.preventDefault();
    const rightEdge = pane.getBoundingClientRect().right;
    resizer.setPointerCapture(e.pointerId);
    resizer.classList.add("dragging");
    const onMove = (ev) => {
      const max = Math.floor(window.innerWidth * 0.72);
      canvasWidth = Math.max(MIN_WIDTH, Math.min(rightEdge - ev.clientX, max));
      pane.style.width = `${canvasWidth}px`;
    };
    const onUp = () => {
      resizer.classList.remove("dragging");
      resizer.removeEventListener("pointermove", onMove);
      resizer.removeEventListener("pointerup", onUp);
      localStorage.setItem(WIDTH_KEY, String(canvasWidth));
      window.dispatchEvent(new Event("resize"));
    };
    resizer.addEventListener("pointermove", onMove);
    resizer.addEventListener("pointerup", onUp);
  });
}

function init() {
  pane = document.getElementById("canvas-pane");
  resizer = document.getElementById("canvas-resizer");
  toggleBtn = document.getElementById("canvas-toggle");
  docSelect = document.getElementById("canvas-doc");
  openBtn = document.getElementById("canvas-open");
  refreshBtn = document.getElementById("canvas-refresh");
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

  canvasWidth = loadWidth();

  toggleBtn.addEventListener("click", () => setOpen(!canvasOpen));
  closeBtn?.addEventListener("click", () => setOpen(false));
  refreshBtn?.addEventListener("click", () => reload());
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
