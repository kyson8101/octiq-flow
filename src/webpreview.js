// Web preview pane (#project-web): an <iframe> that loads a project's dev URL
// (e.g. http://localhost:5173) side-by-side with the terminals. The URL and
// dock side are saved PER PROJECT in localStorage; the pane's SIZE is owned by
// the layout manager (layout.js), like every other center panel.
//
// How it is driven (same pattern as browser.js / gitdiff.js):
//   * workspaces.js dispatches `project-web` { id } when the user picks
//     "Web preview". We open through the layout manager, which also closes
//     whichever other center panel was open.
//   * `project-selected`: switching to a DIFFERENT project closes the preview
//     (its saved URL belongs to the project we are leaving).
//
// ponytail: a cross-origin <iframe> (the app origin != the dev URL) cannot be
// scripted or read, so back/forward track only the URLs the user TYPED here, not
// in-page navigation, and the page's text selection is invisible to us. That is
// fine for a dev preview. Upgrade path for real nav tracking + selection-to-
// terminal: a native Tauri webview with an injected init script.

const { invoke } = window.__TAURI__.core;
import { registerPanel, openPanel, closePanel, isOpen, setPanelSide } from "/layout.js";

// --- DOM handles -----------------------------------------------------------
const paneEl = document.querySelector("#project-web");
const headEl = document.querySelector("#web-head");
const frame = document.querySelector("#web-frame");
const emptyEl = document.querySelector("#web-empty");
const urlInput = document.querySelector("#web-url");
const backBtn = document.querySelector("#web-back");
const fwdBtn = document.querySelector("#web-fwd");
const reloadBtn = document.querySelector("#web-reload");
const dockBtn = document.querySelector("#web-dock");
const externalBtn = document.querySelector("#web-open-external");
const closeBtn = document.querySelector("#web-close");
const zonesEl = document.querySelector("#web-zones");

const DOCKS = ["right", "left", "bottom", "top"];

// --- State -----------------------------------------------------------------
let projId = null; // project whose preview is open, or null when closed
let dock = "right";
let currentUrl = ""; // the URL showing now
let history = []; // URLs the user typed, oldest → newest
let histIdx = -1; // index into history of the URL showing now

registerPanel("web", {
  el: paneEl,
  side: "right",
  min: 220,
  width: 480,
  height: 320,
  onHidden: () => {
    // Closed directly or displaced by another panel: blank the frame so the
    // dev site stops running off screen, and forget the project.
    zonesEl.classList.add("hidden");
    frame.removeAttribute("src");
    projId = null;
  },
});

// --- Per-project persistence (one JSON blob per project) -------------------
const KEY = (id) => `octiq.web.${id}`;

/** Load the saved {url, dock} for a project, or {} when none/corrupt. */
function loadState(id) {
  try {
    return JSON.parse(localStorage.getItem(KEY(id))) || {};
  } catch {
    return {};
  }
}

/** Save the current url/dock for the open project. */
function saveState() {
  if (!projId) return;
  localStorage.setItem(KEY(projId), JSON.stringify({ url: currentUrl, dock }));
}

// --- URL helpers -----------------------------------------------------------
/** Add an http:// scheme when the user typed a bare host:port. Empty → "". */
function normalizeUrl(raw) {
  const s = (raw || "").trim();
  if (!s) return "";
  return /^[a-z][a-z0-9+.-]*:\/\//i.test(s) ? s : `http://${s}`;
}

/** Open a URL in the system browser via the opener plugin. Returns false on an
 *  empty URL or a launch error, so callers can fall back. */
async function openInBrowser(raw) {
  const url = normalizeUrl(raw);
  if (!url) return false;
  try {
    await invoke("plugin:opener|open_url", { url });
    return true;
  } catch {
    return false;
  }
}

// --- Show / hide -----------------------------------------------------------
/** Swap the empty hint for the frame (or back) when there is no URL yet. */
function showEmpty(on) {
  emptyEl.classList.toggle("hidden", !on);
  frame.classList.toggle("hidden", on);
}

/** Open the preview for a project: restore its saved URL/dock and load it. */
function open(id) {
  if (!id) return;
  projId = id;
  const st = loadState(id);
  dock = DOCKS.includes(st.dock) ? st.dock : "right";
  currentUrl = normalizeUrl(st.url);
  history = currentUrl ? [currentUrl] : [];
  histIdx = history.length - 1;

  openPanel("web", { side: dock });
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

/** Dock the pane to `side` (a zone drop or the cycle button) and remember it. */
function applyDock(side) {
  dock = DOCKS.includes(side) ? side : "right";
  setPanelSide("web", dock);
  saveState();
}

// --- Navigation (over the typed-URL history) -------------------------------
/** Enable/disable back & forward against our typed-URL history position. */
function updateNavButtons() {
  backBtn.disabled = histIdx <= 0;
  fwdBtn.disabled = histIdx >= history.length - 1;
  externalBtn.disabled = !currentUrl; // nothing to launch until a URL is set
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
      if (zone) applyDock(zone.dataset.dock);
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
externalBtn.addEventListener("click", () => openInBrowser(currentUrl));
closeBtn.addEventListener("click", () => closePanel("web"));
dockBtn.addEventListener("click", () => {
  applyDock(DOCKS[(DOCKS.indexOf(dock) + 1) % DOCKS.length]);
});
wireHeadDrag();

window.addEventListener("project-web", (e) => open(e.detail?.id));
// "Open in browser" from the project menu: launch the project's saved URL in the
// system browser without opening the pane. No saved URL (or launch failed) → open
// the pane so the user can set one.
window.addEventListener("project-web-launch", async (e) => {
  const id = e.detail?.id;
  if (!id) return;
  if (!(await openInBrowser(loadState(id).url))) open(id);
});
// Switching to a DIFFERENT project closes our preview (its URL is per project).
window.addEventListener("project-selected", (e) => {
  const id = e.detail?.id ?? null;
  if (isOpen("web") && projId && id !== projId) closePanel("web");
});
