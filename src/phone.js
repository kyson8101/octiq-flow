// Phone layout: the drawer, the soft keyboard, and the key bar.
//
// The desktop window is never narrow, so all of this only ever runs for a
// BROWSER client (see tauriws.js / web.rs) on a small screen — the whole point
// of serving the app: the machine that owns the terminals stays on, and you
// drive it from your phone.
//
// Three problems a phone has that a desktop does not:
//
//   1. No room for three columns. The project sidebar becomes a slide-over
//      drawer behind a ☰ button, and picking a project or a terminal closes it.
//   2. The soft keyboard covers the composer. `100dvh` does not help — the
//      keyboard shrinks the VISUAL viewport, not the layout viewport — so the
//      shell is sized from `visualViewport` instead and the composer stays put
//      above the keyboard.
//   3. An agent's TUI wants keys a touch keyboard has no room for. The key bar
//      sends Esc / Tab / arrows / Ctrl-C straight to the focused terminal, so
//      you can answer a menu or stop a run with a tap.
const { invoke } = window.__TAURI__.core;

// Matches the CSS breakpoint. Anything wider keeps the desktop layout.
const PHONE_MAX = 760;

const shellEl = document.querySelector(".shell");
const sidebarEl = document.querySelector(".sidebar");

function isPhone() {
  return window.innerWidth <= PHONE_MAX;
}

// ---- The drawer -----------------------------------------------------------

let scrimEl = null;
let menuBtn = null;

function buildChrome() {
  if (menuBtn) return;

  // ☰ at the very start of the mode bar, before the brand.
  menuBtn = document.createElement("button");
  menuBtn.id = "phone-menu";
  menuBtn.className = "phone-menu";
  menuBtn.type = "button";
  menuBtn.setAttribute("aria-label", "Projects");
  menuBtn.innerHTML =
    '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" ' +
    'stroke-width="2" stroke-linecap="round" aria-hidden="true">' +
    '<path d="M4 7h16M4 12h16M4 17h16"/></svg>';
  menuBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    setDrawer(!document.body.classList.contains("phone-drawer-open"));
  });
  document.querySelector(".modebar")?.prepend(menuBtn);

  // Tap-anywhere-else to close.
  scrimEl = document.createElement("div");
  scrimEl.className = "phone-scrim";
  scrimEl.addEventListener("click", () => setDrawer(false));
  document.body.append(scrimEl);
}

function setDrawer(open) {
  document.body.classList.toggle("phone-drawer-open", open);
  menuBtn?.setAttribute("aria-expanded", open ? "true" : "false");
  // The terminal just changed width: let it re-fit once the slide has settled.
  setTimeout(() => window.dispatchEvent(new Event("resize")), 220);
}

// Picking something in the drawer means "take me there", so it closes. Both
// events come from the sidebar tree (workspaces.js / termtree.js).
window.addEventListener("project-selected", () => {
  if (isPhone()) setDrawer(false);
});
sidebarEl?.addEventListener("click", (e) => {
  if (!isPhone()) return;
  if (e.target.closest(".ws-term")) setDrawer(false);
});

// ---- The soft keyboard ----------------------------------------------------
//
// visualViewport.height is the part of the page NOT covered by the keyboard.
// Sizing the shell to it keeps the composer on screen; without it the composer
// sits under the keyboard and you cannot see what you are typing.
function syncViewport() {
  const vv = window.visualViewport;
  if (!vv) return;
  const h = Math.round(vv.height);
  document.documentElement.style.setProperty("--app-h", `${h}px`);
  // iOS scrolls the whole page up to reveal the focused field; pin it back.
  if (isPhone() && vv.offsetTop > 0) window.scrollTo(0, 0);
}

if (window.visualViewport) {
  window.visualViewport.addEventListener("resize", syncViewport);
  window.visualViewport.addEventListener("scroll", syncViewport);
}

// ---- The key bar ----------------------------------------------------------
//
// Bytes, not key events: the app's whole trick is writing to a PTY's stdin, so
// a tap sends exactly what the key would have.
const KEYS = [
  { label: "esc", data: "\x1b" },
  { label: "tab", data: "\t" },
  { label: "↑", data: "\x1b[A" },
  { label: "↓", data: "\x1b[B" },
  { label: "←", data: "\x1b[D" },
  { label: "→", data: "\x1b[C" },
  { label: "^C", data: "\x03", title: "Stop what is running" },
  { label: "↵", data: "\r" },
];

/** Send raw bytes to the terminal the user is looking at. Uses the same
 *  focused-tab rule as the composer, through the group registry.
 *
 *  The project id is read from the selected row rather than kept in a variable:
 *  workspaces.js may have announced the selection before this module loaded, so
 *  a listener alone would leave the bar dead until the next project switch. */
async function sendKey(data) {
  const { activeTabInfo } = await import("/terminals.js");
  const projectId = document.querySelector("#workspace-list .ws-item.selected")?.dataset.id;
  const tab = projectId ? activeTabInfo(projectId) : null;
  if (!tab) return;
  invoke("pty_write", { id: tab.id, data }).catch(() => {});
}

function buildKeyBar() {
  if (document.querySelector(".phone-keys")) return;
  const bar = document.createElement("div");
  bar.className = "phone-keys";
  for (const k of KEYS) {
    const b = document.createElement("button");
    b.className = "phone-key";
    b.type = "button";
    b.textContent = k.label;
    if (k.title) b.title = k.title;
    // pointerdown, not click: a click would first blur the composer and shut
    // the keyboard, which is exactly what these keys are meant to avoid.
    b.addEventListener("pointerdown", (e) => {
      e.preventDefault();
      sendKey(k.data);
    });
    bar.append(b);
  }
  document.querySelector("#project-composer")?.prepend(bar);
}

// ---- Wiring ---------------------------------------------------------------

function apply() {
  const phone = isPhone();
  document.body.classList.toggle("is-phone", phone);
  if (phone) {
    buildChrome();
    buildKeyBar();
  } else {
    setDrawer(false);
  }
  syncViewport();
}

window.addEventListener("resize", apply);
window.addEventListener("orientationchange", apply);
apply();
