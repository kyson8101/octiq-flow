// Center layout manager — the ONE owner of what shows in <main class="center">
// beside the terminal tab area (cards: layout manager, 49 multi-side docking).
//
// Model:
//   * The MAIN slot is `.center-main` — the terminal area PLUS the file-preview
//     column (filepreview.js), wrapped together. It is always there; a
//     `mode: "main"` panel (git diff) temporarily takes its cell, hiding the
//     terminals and the preview as one unit. Side panels are NOT affected by
//     that swap. filepreview.js is not registered here — it manages its own
//     visibility/sizing inside that wrapper, independent of this panel set.
//   * Each of the four edges may hold ONE open side panel, and all four may be
//     filled at once (card 49 — it used to be one panel in total). Opening a
//     panel on an occupied side displaces only THAT side's panel.
//   * `.center` is a CSS grid whose middle cell is the main slot, with a track
//     per edge and a sash track between each edge and the middle. A closed side
//     leaves its tracks empty, so they collapse to zero width. This replaced the
//     old `lay-dock-*` axis-flip trick, which could only ever describe one open
//     panel.
//
// Modules register their panel once, then call openPanel/closePanel. A panel
// that stops being open — closed directly OR displaced by another panel opening
// on its side — always gets its `onHidden` callback, so each module resets its
// state in exactly one place. onHidden must therefore be idempotent.

const centerEl = document.querySelector("main.center");
const termsEl = document.querySelector(".center-main");

const SIDES = ["right", "left", "bottom", "top"];
const isRow = (s) => s === "left" || s === "right";
// A side panel may take at most this fraction of its axis.
const MAX_FRACTION = 0.85;
// Where the open set is remembered (per-panel sizes have their own keys).
const OPEN_KEY = "octiq.layout.open";

// key -> { el, mode, side, min, defaults: {w, h}, onHidden, onRestore }
const panels = new Map();
// side -> key, for the four side docks. A side missing from the map is closed.
const openBySide = new Map();
// The open `mode: "main"` panel (git diff), or null. Independent of the sides.
let openMainKey = null;

// One drag handle per side, created up front and shown only while that side has
// a panel. Each drags its OWN side, so four panels resize independently.
const resizers = new Map();
for (const side of SIDES) {
  const el = document.createElement("div");
  el.className = `lay-resizer lay-resizer-${side} hidden`;
  el.setAttribute("role", "separator");
  el.setAttribute("aria-orientation", isRow(side) ? "vertical" : "horizontal");
  el.title = "Drag to resize";
  el.addEventListener("pointerdown", (e) => beginResize(side, e));
  centerEl.append(el);
  resizers.set(side, el);
}

const sizeKey = (key, side) => `octiq.layout.${key}.${isRow(side) ? "w" : "h"}`;

function axisMax(side) {
  const span = isRow(side) ? window.innerWidth : window.innerHeight;
  return Math.floor(span * MAX_FRACTION);
}

/** The persisted size for a panel on `side`, clamped to [min, axis max]. */
function loadSize(p, key, side) {
  const fallback = isRow(side) ? p.defaults.w : p.defaults.h;
  const max = axisMax(side);
  const n = Number(localStorage.getItem(sizeKey(key, side)));
  if (!Number.isFinite(n) || n < p.min) return Math.min(fallback, max);
  return Math.min(n, max);
}

/** Remember which panels are open and on which side, so a restart can put them
 *  back. Sizes are stored separately, per panel + axis, by the resizer. */
function saveOpenSet() {
  try {
    const open = {};
    for (const [side, key] of openBySide) open[key] = side;
    localStorage.setItem(OPEN_KEY, JSON.stringify(open));
  } catch (_) {
    // Storage full or blocked — panels still work, they just won't come back.
  }
}

/**
 * Register a panel once at module load.
 *   el        the panel's root element (a child of main.center)
 *   mode      "side" (docks at an edge) | "main" (replaces the terminals)
 *   side      default dock side for a side panel
 *   min       smallest allowed size, px
 *   width/height  default sizes for the row / column axes
 *   onHidden  called whenever the panel stops being open (must be idempotent)
 *   onRestore called at boot when this panel was open last time. The MODULE
 *             decides whether it can actually come back (it may need a selected
 *             project, a URL, …) and calls openPanel itself — layout.js must not
 *             force a panel open with no content behind it.
 *   head      the panel's header element. Given one, the panel can be dragged
 *             by it to another edge (card 50).
 *   onSideChange  called with the new side after such a drag, for a panel that
 *             keeps its own record of where it is docked.
 */
export function registerPanel(
  key,
  {
    el,
    mode = "side",
    side = "right",
    min = 220,
    width = 420,
    height = 320,
    onHidden = null,
    onRestore = null,
    head = null,
    onSideChange = null,
  },
) {
  panels.set(key, {
    el,
    mode,
    side,
    min,
    defaults: { w: width, h: height },
    onHidden,
    onRestore,
    onSideChange,
  });
  if (mode === "side" && head) wireHeadDrag(key, head);
}

/** Put a panel element in its grid cell and give it its size along its axis. */
function placeSide(p, key, side) {
  for (const s of SIDES) p.el.classList.remove(`lay-side-${s}`);
  p.el.classList.add(`lay-side-${side}`);
  const size = `${loadSize(p, key, side)}px`;
  // One axis only: the other is stretched by the grid cell.
  p.el.style.width = isRow(side) ? size : "";
  p.el.style.height = isRow(side) ? "" : size;
}

/** Hide whatever is open on `side` (if anything) and notify its owner. */
function hideSide(side, { persist = true } = {}) {
  const key = openBySide.get(side);
  if (!key) return;
  const p = panels.get(key);
  openBySide.delete(side);
  resizers.get(side).classList.add("hidden");
  p.el.classList.add("hidden");
  p.el.classList.remove("lay-open");
  p.el.classList.remove(`lay-side-${side}`);
  p.el.style.width = "";
  p.el.style.height = "";
  if (persist) saveOpenSet();
  p.onHidden?.();
}

/** Hide the open "main" panel (if any) and bring the terminal area back. */
function hideMain() {
  if (!openMainKey) return;
  const p = panels.get(openMainKey);
  openMainKey = null;
  p.el.classList.add("hidden");
  p.el.classList.remove("lay-open");
  termsEl.classList.remove("hidden");
  p.onHidden?.();
}

/** The side a panel is currently open on, or null. */
function sideOf(key) {
  for (const [side, k] of openBySide) if (k === key) return side;
  return null;
}

/** Open panel `key`. A side panel may pass a dock side; without one, the
 *  panel's last side is kept. Opening on an occupied side displaces only that
 *  side's panel — every other side stays exactly as it was. */
export function openPanel(key, { side } = {}) {
  const p = panels.get(key);
  if (!p) return;

  if (p.mode === "main") {
    if (openMainKey && openMainKey !== key) hideMain();
    openMainKey = key;
    // Side panels are deliberately untouched: the git diff replaces the
    // TERMINALS, not the whole workspace.
    termsEl.classList.add("hidden");
    p.el.classList.remove("hidden");
    p.el.classList.add("lay-open");
    return;
  }

  const want = SIDES.includes(side) ? side : p.side;
  const already = sideOf(key);
  // Moving to another side: leave the old one WITHOUT running onHidden — the
  // panel is not closing, it is relocating, and a module resetting its state
  // here would wipe the content we are about to show again.
  if (already && already !== want) {
    openBySide.delete(already);
    resizers.get(already).classList.add("hidden");
    p.el.classList.remove(`lay-side-${already}`);
  }
  if (openBySide.get(want) !== key) hideSide(want, { persist: false });

  p.side = want; // reopening without a side keeps the last one
  openBySide.set(want, key);
  termsEl.classList.remove("hidden");
  placeSide(p, key, want);
  p.el.classList.remove("hidden");
  p.el.classList.add("lay-open");
  resizers.get(want).classList.remove("hidden");
  saveOpenSet();
}

/** Close `key` if it is open (no-op otherwise). The panel's onHidden runs —
 *  modules do all their teardown there. */
export function closePanel(key) {
  const p = panels.get(key);
  if (!p) return;
  if (p.mode === "main") {
    if (openMainKey === key) hideMain();
    return;
  }
  const side = sideOf(key);
  if (side) hideSide(side);
}

export function isOpen(key) {
  const p = panels.get(key);
  if (!p) return false;
  return p.mode === "main" ? openMainKey === key : sideOf(key) !== null;
}

/** Close the open panel only when it REPLACES the terminal area ("main" mode).
 *  File tabs call this so an opened file is never hidden behind the git diff;
 *  side panels stay open. */
export function closeMainPanel() {
  hideMain();
}

/** Move an open side panel to another dock side. */
export function setPanelSide(key, side) {
  if (isOpen(key) && panels.get(key)?.mode === "side") openPanel(key, { side });
}

/** Every side that currently holds a panel. */
export function occupiedSides() {
  return [...openBySide.keys()];
}

/** The open side panels as `{ panelKey: side }` — what a layout preset saves. */
export function currentDocks() {
  const out = {};
  for (const [side, key] of openBySide) out[key] = side;
  return out;
}

/**
 * Make the open side panels match `docks` (`{ panelKey: side }`) — applying a
 * saved layout preset (card 51).
 *
 * A panel already open is simply moved; one that is closed is asked to reopen
 * through its own `onRestore`, because only the module knows whether it HAS
 * anything to show. Any open panel the preset does not name is closed, so
 * applying a preset lands on exactly the arrangement that was saved rather than
 * merging with whatever was on screen.
 */
export function applyDocks(docks) {
  const want = docks && typeof docks === "object" ? docks : {};
  for (const key of [...openBySide.values()]) {
    if (!(key in want)) closePanel(key);
  }
  for (const [key, side] of Object.entries(want)) {
    const p = panels.get(key);
    if (!p || p.mode !== "side" || !SIDES.includes(side)) continue;
    p.side = side;
    if (isOpen(key)) {
      openPanel(key, { side });
    } else {
      try {
        p.onRestore?.(side);
      } catch (_) {
        // One panel that cannot come back must not abort the rest of the preset.
      }
    }
  }
}

// --- Dragging a panel to another side (card 50) ------------------------------
// The web preview grew this first, with its own zones wired straight to its own
// dock state. It is the layout manager's job, not one panel's, so it lives here
// and EVERY panel that registers a `head` gets it — one overlay, one set of
// rules, no per-panel copies to drift apart.
//
// Pointer events rather than HTML5 drag-and-drop: the head holds buttons and an
// editable URL field, and a native drag would fight both. A 5px threshold keeps
// an ordinary click on the head a click.

const zonesEl = document.querySelector("#lay-zones");
const DRAG_THRESHOLD_PX = 5;

function wireHeadDrag(key, headEl) {
  if (!headEl || !zonesEl) return;
  headEl.classList.add("lay-draggable");
  headEl.addEventListener("pointerdown", (e) => {
    if (e.button !== 0) return;
    // Never start a drag from a control inside the head.
    if (e.target.closest("button, input, select, textarea, a")) return;
    if (!isOpen(key)) return;
    e.preventDefault();
    headEl.setPointerCapture(e.pointerId);
    const sx = e.clientX;
    const sy = e.clientY;
    let active = false;
    let hot = null;

    const hilite = (x, y) => {
      const el = document.elementFromPoint(x, y);
      const zone = el ? el.closest(".lay-zone") : null;
      if (zone === hot) return zone;
      if (hot) hot.classList.remove("lay-zone-hot");
      hot = zone || null;
      if (hot) hot.classList.add("lay-zone-hot");
      return zone;
    };
    const stop = () => {
      headEl.removeEventListener("pointermove", onMove);
      headEl.removeEventListener("pointerup", onUp);
      headEl.removeEventListener("pointercancel", onCancel);
      document.removeEventListener("keydown", onKey, true);
      if (hot) hot.classList.remove("lay-zone-hot");
      zonesEl.classList.add("hidden");
    };
    const onMove = (ev) => {
      if (!active) {
        if (Math.hypot(ev.clientX - sx, ev.clientY - sy) < DRAG_THRESHOLD_PX) return;
        active = true;
        zonesEl.classList.remove("hidden");
      }
      hilite(ev.clientX, ev.clientY);
    };
    const onUp = (ev) => {
      const wasActive = active;
      const zone = wasActive ? hilite(ev.clientX, ev.clientY) : null;
      stop();
      if (!wasActive || !zone) return; // a plain click, or dropped off-target
      const side = zone.dataset.side;
      if (!SIDES.includes(side)) return;
      setPanelSide(key, side);
      panels.get(key)?.onSideChange?.(side);
    };
    // Escape (and a cancelled pointer) leave the panel exactly where it was.
    const onCancel = () => stop();
    const onKey = (ev) => {
      if (ev.key !== "Escape") return;
      active = false;
      stop();
    };
    headEl.addEventListener("pointermove", onMove);
    headEl.addEventListener("pointerup", onUp);
    headEl.addEventListener("pointercancel", onCancel);
    document.addEventListener("keydown", onKey, true);
  });
}

// --- Restoring the open panels at boot ---------------------------------------
// Deferred to a task after load so EVERY module has registered its panel first
// (they register at import time, and this module is imported by them). Each
// module decides for itself whether it can come back — see `onRestore`.

function restoreOpenPanels() {
  let saved = null;
  try {
    saved = JSON.parse(localStorage.getItem(OPEN_KEY) || "null");
  } catch (_) {
    saved = null;
  }
  if (!saved || typeof saved !== "object") return;
  for (const [key, side] of Object.entries(saved)) {
    const p = panels.get(key);
    if (!p || p.mode !== "side" || !SIDES.includes(side)) continue;
    // Remember the side even when the module cannot reopen right now, so the
    // next manual open still lands where the user left it.
    p.side = side;
    try {
      p.onRestore?.(side);
    } catch (_) {
      // A panel that cannot come back must never break the others.
    }
  }
}
setTimeout(restoreOpenPanels, 0);

// --- The per-side resizers ---------------------------------------------------
// Each drags its own side's panel along that side's axis. The docked edge is
// anchored to the center's edge and does not move, so it is measured once at
// pointerdown and the new size is (that edge − pointer) on every move.
function beginResize(side, e) {
  const key = openBySide.get(side);
  const p = key ? panels.get(key) : null;
  if (!p) return;
  const el = resizers.get(side);
  e.preventDefault();
  el.setPointerCapture(e.pointerId);
  el.classList.add("dragging");
  const rect = p.el.getBoundingClientRect();
  const max = axisMax(side);
  let size = isRow(side) ? rect.width : rect.height;

  const onMove = (ev) => {
    if (side === "right") size = rect.right - ev.clientX;
    else if (side === "left") size = ev.clientX - rect.left;
    else if (side === "bottom") size = rect.bottom - ev.clientY;
    else size = ev.clientY - rect.top; // top
    size = Math.max(p.min, Math.min(size, max));
    if (isRow(side)) p.el.style.width = `${size}px`;
    else p.el.style.height = `${size}px`;
  };
  const onUp = () => {
    el.classList.remove("dragging");
    el.removeEventListener("pointermove", onMove);
    el.removeEventListener("pointerup", onUp);
    el.removeEventListener("pointercancel", onUp);
    localStorage.setItem(sizeKey(key, side), String(Math.round(size)));
  };
  el.addEventListener("pointermove", onMove);
  el.addEventListener("pointerup", onUp);
  el.addEventListener("pointercancel", onUp);
}
