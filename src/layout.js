// Center layout manager — the ONE owner of what shows in <main class="center">
// beside the terminal tab area (card: layout manager).
//
// Model (deliberately small):
//   * The MAIN slot is `.center-main` — the terminal area PLUS the file-preview
//     column (filepreview.js), wrapped together in their own fixed row (see
//     styles.css). It is always there; a `mode: "main"` panel (git diff)
//     temporarily takes its place, hiding the terminals and the preview as
//     one unit. filepreview.js is not registered here — it manages its own
//     visibility/sizing inside that wrapper, independent of this panel set.
//   * At most ONE registered panel is open at a time (file tree, web preview,
//     git diff) — the same mutual exclusivity the modules used to enforce by
//     hiding each other's elements, now in one place.
//   * A `mode: "side"` panel docks to any of the four edges: a lay-dock-*
//     class on .center flips the flex axis, the panel's size is a flex-basis
//     (one property serves both axes), and ONE shared drag handle resizes it.
//     Sizes persist per panel + axis in localStorage.
//
// Modules register their panel once, then call openPanel/closePanel. A panel
// that stops being open — closed directly OR displaced by another panel
// opening — always gets its `onHidden` callback, so each module resets its
// state in exactly one place. onHidden must therefore be idempotent.

const centerEl = document.querySelector("main.center");
const termsEl = document.querySelector(".center-main");

const SIDES = ["right", "left", "bottom", "top"];
const isRow = (s) => s === "left" || s === "right";
// A side panel may take at most this fraction of its axis.
const MAX_FRACTION = 0.85;

// The one shared drag handle. Flex `order` (CSS) puts it between the terminal
// area and the open panel; the dock class flips which side that visually is.
const resizerEl = document.createElement("div");
resizerEl.className = "lay-resizer hidden";
resizerEl.setAttribute("role", "separator");
resizerEl.title = "Drag to resize";
centerEl.append(resizerEl);

// key -> { el, mode, side, min, defaults: {w, h}, onHidden }
const panels = new Map();
let openKey = null;
let openSide = "right";

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

/**
 * Register a panel once at module load.
 *   el       the panel's root element (a child of main.center)
 *   mode     "side" (docks beside the terminals) | "main" (replaces them)
 *   side     default dock side for a side panel
 *   min      smallest allowed size, px
 *   width/height  default sizes for the row / column axes
 *   onHidden called whenever the panel stops being open (must be idempotent)
 */
export function registerPanel(
  key,
  { el, mode = "side", side = "right", min = 220, width = 420, height = 320, onHidden = null },
) {
  panels.set(key, { el, mode, side, min, defaults: { w: width, h: height }, onHidden });
}

function clearDockClasses() {
  for (const s of SIDES) centerEl.classList.remove(`lay-dock-${s}`);
}

/** Hide the open panel (if any), restore the terminal area, notify the owner. */
function hideOpen() {
  if (!openKey) return;
  const p = panels.get(openKey);
  openKey = null;
  clearDockClasses();
  resizerEl.classList.add("hidden");
  p.el.classList.add("hidden");
  p.el.classList.remove("lay-open");
  p.el.style.flexBasis = "";
  termsEl.classList.remove("hidden");
  p.onHidden?.();
}

/** Open panel `key`, closing whatever else is open. Side panels may pass a
 *  dock side; without one, the panel's last side is kept. */
export function openPanel(key, { side } = {}) {
  const p = panels.get(key);
  if (!p) return;
  if (openKey && openKey !== key) hideOpen();
  openKey = key;

  if (p.mode === "main") {
    clearDockClasses();
    resizerEl.classList.add("hidden");
    termsEl.classList.add("hidden");
    p.el.style.flexBasis = "";
  } else {
    openSide = SIDES.includes(side) ? side : p.side;
    p.side = openSide; // reopening without a side keeps the last one
    termsEl.classList.remove("hidden");
    clearDockClasses();
    centerEl.classList.add(`lay-dock-${openSide}`);
    p.el.style.flexBasis = `${loadSize(p, key, openSide)}px`;
    resizerEl.classList.remove("hidden");
  }
  p.el.classList.remove("hidden");
  p.el.classList.add("lay-open");
}

/** Close `key` if it is the open panel (no-op otherwise). The panel's
 *  onHidden runs — modules do all their teardown there. */
export function closePanel(key) {
  if (openKey === key) hideOpen();
}

export function isOpen(key) {
  return openKey === key;
}

/** Close the open panel only when it REPLACES the terminal area ("main"
 *  mode). File tabs call this so an opened file is never hidden behind the
 *  git diff; a side panel (the file tree it was clicked in) stays open. */
export function closeMainPanel() {
  if (openKey && panels.get(openKey)?.mode === "main") hideOpen();
}

/** Move the open side panel to another dock side. */
export function setPanelSide(key, side) {
  if (openKey === key && panels.get(key)?.mode === "side") openPanel(key, { side });
}

// --- The shared resizer ------------------------------------------------------
// Drags the open side panel's free edge along the dock axis. The docked edge is
// anchored to the center's edge and does not move, so it is measured once at
// pointerdown and the new size is (that edge − pointer) on every move.
resizerEl.addEventListener("pointerdown", (e) => {
  const p = openKey ? panels.get(openKey) : null;
  if (!p || p.mode !== "side") return;
  e.preventDefault();
  resizerEl.setPointerCapture(e.pointerId);
  resizerEl.classList.add("dragging");
  const key = openKey;
  const side = openSide;
  const rect = p.el.getBoundingClientRect();
  const max = axisMax(side);
  let size = isRow(side) ? rect.width : rect.height;

  const onMove = (ev) => {
    if (side === "right") size = rect.right - ev.clientX;
    else if (side === "left") size = ev.clientX - rect.left;
    else if (side === "bottom") size = rect.bottom - ev.clientY;
    else size = ev.clientY - rect.top; // top
    size = Math.max(p.min, Math.min(size, max));
    p.el.style.flexBasis = `${size}px`;
  };
  const onUp = () => {
    resizerEl.classList.remove("dragging");
    resizerEl.removeEventListener("pointermove", onMove);
    resizerEl.removeEventListener("pointerup", onUp);
    localStorage.setItem(sizeKey(key, side), String(Math.round(size)));
  };
  resizerEl.addEventListener("pointermove", onMove);
  resizerEl.addEventListener("pointerup", onUp);
});
