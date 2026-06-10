// Terminal management lives in terminals.js (the shared terminal-tab
// primitive) and project.js (Project-mode integration); the single pty-output
// listener lives in terminals.js.
//
// This file hosts the app-wide chrome helpers — currently the shared hover
// tooltip. Icon buttons + tooltips are the app's main control pattern, so the
// tooltip is global: one floating element, fixed-positioned (never clipped by
// overflow containers), fed by [data-tip] attributes.
//
// Native `title` attributes are converted to data-tip lazily on first hover.
// That keeps every module's existing `el.title = ...` code working without
// touching it: the conversion happens before the OS tooltip would appear, so
// only the styled tooltip is ever shown.

const SHOW_DELAY_MS = 350;
const EDGE_MARGIN = 8;
const GAP = 8;

const tip = document.createElement("div");
tip.id = "app-tooltip";
document.body.append(tip);

let showTimer = 0;
let currentEl = null;

function hideTip() {
  clearTimeout(showTimer);
  showTimer = 0;
  currentEl = null;
  tip.classList.remove("show");
}

function positionTip(el) {
  const rect = el.getBoundingClientRect();
  // Render off-screen first so we can measure the tip's real size.
  tip.style.left = "0px";
  tip.style.top = "-9999px";
  const tw = tip.offsetWidth;
  const th = tip.offsetHeight;

  let x = rect.left + rect.width / 2 - tw / 2;
  x = Math.max(EDGE_MARGIN, Math.min(x, window.innerWidth - tw - EDGE_MARGIN));

  // Prefer above the element; flip below when there is no room.
  let y = rect.top - th - GAP;
  if (y < EDGE_MARGIN) y = rect.bottom + GAP;
  y = Math.min(y, window.innerHeight - th - EDGE_MARGIN);

  tip.style.left = `${Math.round(x)}px`;
  tip.style.top = `${Math.round(y)}px`;
}

function showTip(el) {
  const text = el.getAttribute("data-tip");
  if (!text) return;
  currentEl = el;
  tip.textContent = text;
  positionTip(el);
  tip.classList.add("show");
}

document.addEventListener(
  "mouseover",
  (e) => {
    if (!(e.target instanceof Element)) return;
    const el = e.target.closest("[title], [data-tip]");
    if (!el) return;

    // Lazy migration: move title -> data-tip so the native tooltip never fires.
    const title = el.getAttribute("title");
    if (title) {
      el.setAttribute("data-tip", title);
      el.removeAttribute("title");
    }
    if (el === currentEl) return;

    clearTimeout(showTimer);
    showTimer = setTimeout(() => showTip(el), SHOW_DELAY_MS);

    el.addEventListener("mouseleave", hideTip, { once: true });
  },
  true
);

// Any interaction that changes layout or focus dismisses the tooltip.
document.addEventListener("mousedown", hideTip, true);
document.addEventListener("scroll", hideTip, true);
window.addEventListener("resize", hideTip);
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") hideTip();
});
