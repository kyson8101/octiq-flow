// Web preview pane (#project-web): an <iframe> that loads a project's dev URL
// (e.g. http://localhost:5173) side-by-side with the terminals. The URL, dock
// side, and pane size are saved PER PROJECT in localStorage.
//
// How it is driven (same pattern as browser.js / gitdiff.js):
//   * workspaces.js dispatches `project-web` { id } when the user picks
//     "Web preview". We take over the center: hide the file browser + git diff
//     and show this pane.
//   * `project-browse` / `project-gitdiff` from workspaces.js: those panes are
//     mutually exclusive with us, so we close when one of them opens.
//   * `project-selected`: switching to a DIFFERENT project closes the preview
//     (its saved URL belongs to the project we are leaving).
//
// ponytail: a cross-origin <iframe> (the app origin != the dev URL) cannot be
// scripted or read, so back/forward track only the URLs the user TYPED here, not
// in-page navigation, and the page's text selection is invisible to us. That is
// fine for a dev preview. Upgrade path for real nav tracking + selection-to-
// terminal: a native Tauri webview with an injected init script.

const { invoke } = window.__TAURI__.core;

// --- DOM handles -----------------------------------------------------------
const centerEl = document.querySelector("main.center");
const termsEl = document.querySelector(".center-terms");
const paneEl = document.querySelector("#project-web");
const resizerEl = document.querySelector("#web-resizer");
const headEl = document.querySelector("#web-head");
const frame = document.querySelector("#web-frame");
const emptyEl = document.querySelector("#web-empty");
const urlInput = document.querySelector("#web-url");
const backBtn = document.querySelector("#web-back");
const fwdBtn = document.querySelector("#web-fwd");
const reloadBtn = document.querySelector("#web-reload");
const dockBtn = document.querySelector("#web-dock");
const closeBtn = document.querySelector("#web-close");
const zonesEl = document.querySelector("#web-zones");

// Other center panes we hide when we take over (and that hide us via their own
// events). Looked up once.
const browserEl = document.querySelector("#project-browser");
const browserResizerEl = document.querySelector("#browser-resizer");
const gitdiffEl = document.querySelector("#project-gitdiff");

const DOCKS = ["right", "left", "bottom", "top"];
const isRow = (d) => d === "left" || d === "right";

// Size clamps. Width caps wider than height because a side preview is the common
// case; a px below MIN is treated as unset.
const MIN = 220;
const DEFAULT_W = 480;
const DEFAULT_H = 320;

// --- State -----------------------------------------------------------------
let projId = null; // project whose preview is open, or null when closed
let dock = "right";
let widthPx = DEFAULT_W; // size for row docks (left/right)
let heightPx = DEFAULT_H; // size for column docks (top/bottom)
let currentUrl = ""; // the URL showing now
let history = []; // URLs the user typed, oldest → newest
let histIdx = -1; // index into history of the URL showing now

// --- Per-project persistence (one JSON blob per project) -------------------
const KEY = (id) => `octiq.web.${id}`;

/** Load the saved {url, dock, w, h} for a project, or {} when none/corrupt. */
function loadState(id) {
  try {
    return JSON.parse(localStorage.getItem(KEY(id))) || {};
  } catch {
    return {};
  }
}

/** Save the current url/dock/size for the open project. */
function saveState() {
  if (!projId) return;
  localStorage.setItem(
    KEY(projId),
    JSON.stringify({ url: currentUrl, dock, w: widthPx, h: heightPx }),
  );
}

/** A px size clamped to [MIN, frac of the window], or the default when unset. */
function clampSize(n, fallback, axisMax) {
  const v = Number(n);
  if (!Number.isFinite(v) || v < MIN) return Math.min(fallback, axisMax);
  return Math.min(v, axisMax);
}

// --- URL helpers -----------------------------------------------------------
/** Add an http:// scheme when the user typed a bare host:port. Empty → "". */
function normalizeUrl(raw) {
  const s = (raw || "").trim();
  if (!s) return "";
  return /^[a-z][a-z0-9+.-]*:\/\//i.test(s) ? s : `http://${s}`;
}

// --- Dock + size -----------------------------------------------------------
/** Apply a dock side: set the .center class and the pane's main-axis size. */
function applyDock(side) {
  dock = DOCKS.includes(side) ? side : "right";
  centerEl.classList.remove(
    "web-dock-right",
    "web-dock-left",
    "web-dock-top",
    "web-dock-bottom",
  );
  centerEl.classList.add(`web-dock-${dock}`);
  paneEl.style.flexBasis = `${isRow(dock) ? widthPx : heightPx}px`;
}

/** Drop every dock class from .center (so the row-based file/git panes are
 *  laid out normally once the preview is gone). */
function clearDock() {
  centerEl.classList.remove(
    "web-dock-right",
    "web-dock-left",
    "web-dock-top",
    "web-dock-bottom",
  );
}

// --- Show / hide -----------------------------------------------------------
/** Swap the empty hint for the frame (or back) when there is no URL yet. */
function showEmpty(on) {
  emptyEl.classList.toggle("hidden", !on);
  frame.classList.toggle("hidden", on);
}

/** Open the preview for a project: hide the other center panes, restore the
 *  project's saved URL/dock/size, and load it. */
function open(id) {
  if (!id) return;
  // Take over the center (mirror what browser.js / gitdiff.js do to each other).
  browserEl?.classList.add("hidden");
  browserResizerEl?.classList.add("hidden");
  gitdiffEl?.classList.add("hidden");
  termsEl?.classList.remove("hidden");

  projId = id;
  const st = loadState(id);
  const maxW = Math.floor(window.innerWidth * 0.85);
  const maxH = Math.floor(window.innerHeight * 0.85);
  widthPx = clampSize(st.w, DEFAULT_W, maxW);
  heightPx = clampSize(st.h, DEFAULT_H, maxH);
  currentUrl = normalizeUrl(st.url);
  history = currentUrl ? [currentUrl] : [];
  histIdx = history.length - 1;

  applyDock(st.dock || "right");
  paneEl.classList.remove("hidden");
  resizerEl.classList.remove("hidden");
  urlInput.value = currentUrl;

  if (currentUrl) {
    showEmpty(false);
    frame.src = currentUrl;
  } else {
    frame.removeAttribute("src");
    showEmpty(true);
  }
  updateNavButtons();
}

/** Close the preview: hide it + the handle, reset .center to row layout. */
function close() {
  paneEl.classList.add("hidden");
  resizerEl.classList.add("hidden");
  zonesEl.classList.add("hidden");
  clearDock();
  frame.removeAttribute("src");
  projId = null;
}

// --- Navigation (over the typed-URL history) -------------------------------
/** Enable/disable back & forward against our typed-URL history position. */
function updateNavButtons() {
  backBtn.disabled = histIdx <= 0;
  fwdBtn.disabled = histIdx >= history.length - 1;
}

/** Load a URL into the frame. `push` records it in history (a fresh navigation);
 *  back/forward pass push=false so they move within the existing history. */
function navigate(raw, push = true) {
  const url = normalizeUrl(raw);
  if (!url) return;
  currentUrl = url;
  urlInput.value = url;
  if (push) {
    history = history.slice(0, histIdx + 1);
    history.push(url);
    histIdx = history.length - 1;
  }
  showEmpty(false);
  frame.src = url;
  updateNavButtons();
  saveState();
}

/** Move `delta` steps through the typed-URL history (e.g. -1 = back). */
function go(delta) {
  const i = histIdx + delta;
  if (i < 0 || i >= history.length) return;
  histIdx = i;
  navigate(history[i], false);
}

/** Reload the frame. A cross-origin frame cannot call location.reload(), so we
 *  blank it and re-assign the URL, which forces a fresh load. */
function reload() {
  if (!currentUrl) return;
  const u = currentUrl;
  frame.src = "about:blank";
  requestAnimationFrame(() => {
    frame.src = u;
  });
}

// --- Resizer (drags the docked edge along the main axis) -------------------
function wireResizer() {
  resizerEl.addEventListener("pointerdown", (e) => {
    e.preventDefault();
    resizerEl.setPointerCapture(e.pointerId);
    resizerEl.classList.add("dragging");
    // The pane's DOCKED edge is anchored to the center edge and does not move,
    // so capture it once and measure the new size from the pointer each move.
    const rect = paneEl.getBoundingClientRect();
    const maxW = Math.floor(window.innerWidth * 0.85);
    const maxH = Math.floor(window.innerHeight * 0.85);
    const onMove = (ev) => {
      let size;
      if (dock === "right") size = rect.right - ev.clientX;
      else if (dock === "left") size = ev.clientX - rect.left;
      else if (dock === "bottom") size = rect.bottom - ev.clientY;
      else size = ev.clientY - rect.top; // top
      const max = isRow(dock) ? maxW : maxH;
      size = Math.max(MIN, Math.min(size, max));
      if (isRow(dock)) widthPx = size;
      else heightPx = size;
      paneEl.style.flexBasis = `${size}px`;
    };
    const onUp = () => {
      resizerEl.classList.remove("dragging");
      resizerEl.removeEventListener("pointermove", onMove);
      resizerEl.removeEventListener("pointerup", onUp);
      saveState();
    };
    resizerEl.addEventListener("pointermove", onMove);
    resizerEl.addEventListener("pointerup", onUp);
  });
}

// --- Drag the head onto a drop zone to dock (left / right / top / bottom) ---
function wireHeadDrag() {
  headEl.addEventListener("pointerdown", (e) => {
    // Let the toolbar controls work normally; only a bare-head drag docks.
    if (e.target.closest("button, input")) return;
    e.preventDefault();
    headEl.setPointerCapture(e.pointerId);
    const sx = e.clientX;
    const sy = e.clientY;
    let active = false; // becomes true once the pointer moves past the threshold
    let hot = null;

    const hilite = (x, y) => {
      const el = document.elementFromPoint(x, y);
      const zone = el ? el.closest(".web-zone") : null;
      if (zone === hot) return zone;
      if (hot) hot.classList.remove("web-zone-hot");
      hot = zone || null;
      if (hot) hot.classList.add("web-zone-hot");
      return zone;
    };
    const onMove = (ev) => {
      if (!active) {
        if (Math.hypot(ev.clientX - sx, ev.clientY - sy) < 5) return;
        active = true;
        zonesEl.classList.remove("hidden");
      }
      hilite(ev.clientX, ev.clientY);
    };
    const onUp = (ev) => {
      headEl.removeEventListener("pointermove", onMove);
      headEl.removeEventListener("pointerup", onUp);
      if (!active) return; // a plain click, not a drag — leave the dock as-is
      const zone = hilite(ev.clientX, ev.clientY);
      if (hot) hot.classList.remove("web-zone-hot");
      zonesEl.classList.add("hidden");
      if (zone) {
        applyDock(zone.dataset.dock);
        saveState();
      }
    };
    headEl.addEventListener("pointermove", onMove);
    headEl.addEventListener("pointerup", onUp);
  });
}

// --- Wiring ----------------------------------------------------------------
urlInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter") {
    e.preventDefault();
    navigate(urlInput.value);
  }
});
backBtn.addEventListener("click", () => go(-1));
fwdBtn.addEventListener("click", () => go(1));
reloadBtn.addEventListener("click", reload);
closeBtn.addEventListener("click", close);
dockBtn.addEventListener("click", () => {
  applyDock(DOCKS[(DOCKS.indexOf(dock) + 1) % DOCKS.length]);
  saveState();
});
wireResizer();
wireHeadDrag();

window.addEventListener("project-web", (e) => open(e.detail?.id));
// The file browser or git diff opening means we yield the center.
window.addEventListener("project-browse", () => {
  if (projId) close();
});
window.addEventListener("project-gitdiff", () => {
  if (projId) close();
});
// Switching to a DIFFERENT project closes our preview (its URL is per project).
window.addEventListener("project-selected", (e) => {
  const id = e.detail?.id ?? null;
  if (projId && id !== projId) close();
});
