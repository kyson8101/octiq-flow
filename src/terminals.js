// Shared terminal-tab-group primitive. This file is the SINGLE source of
// terminal management for the whole app. Project (card 04), Chat (card 07),
// and Utilities (card 09) all create groups through createTerminalGroup().
//
// One xterm per PTY. One global pty-output listener routes { id, chunk } to the
// right xterm across ALL groups. Terminals stay alive when their group is
// hidden (scrollback kept in memory); they refit when shown again.
//
// `Terminal`, `FitAddon` and `WebglAddon` come from the vendored scripts in
// index.html. We render with the WebGL renderer (one GPU canvas, full repaint
// each frame) instead of xterm's default DOM renderer. The DOM renderer draws
// one node per cell and leaves stale glyphs after a resize/reflow, which showed
// up as ghosted/overlapping text and a "stamped-on" look. WebGL repaints the
// whole grid every frame, so that breakage cannot build up. If the GPU context
// is lost (driver reset, tab backgrounded on some GPUs) we dispose the addon and
// fall back to the DOM renderer so the terminal keeps working.
const { invoke } = window.__TAURI__.core;
const { listen } = window.__TAURI__.event;

// Shared dark theme + font for every terminal in the app.
const TERM_THEME = {
  background: "#0d1117",
  foreground: "#c9d1d9",
  cursor: "#58a6ff",
  selectionBackground: "#264f78",
};

function makeTerminal() {
  return new Terminal({
    fontFamily: "Menlo, Monaco, 'Courier New', monospace",
    fontSize: 13,
    cursorBlink: true,
    theme: TERM_THEME,
  });
}

// Attach the WebGL renderer to an already-opened terminal. On GPU context loss
// the addon disposes itself; xterm then transparently falls back to the DOM
// renderer, so the terminal keeps working — no crash, just the slower path.
// If the addon throws (no WebGL2 at all), we swallow it and stay on DOM.
function attachWebgl(term) {
  try {
    const addon = new WebglAddon.WebglAddon();
    addon.onContextLoss(() => addon.dispose());
    term.loadAddon(addon);
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn("[octiq] WebGL renderer unavailable, using DOM renderer:", err);
  }
}

// Surface a PTY error into the terminal pane itself (red ANSI line) and the
// console, instead of swallowing it. Kept tiny: one visible line + a log.
// `term` may be undefined (e.g. spawn failed before the xterm existed) — then
// we only log.
function reportTermError(term, message) {
  // eslint-disable-next-line no-console
  console.error(`[octiq] ${message}`);
  // \x1b[31m = red, \x1b[0m = reset. Leading/trailing CRLF keep it on its own
  // line regardless of where the cursor was.
  term?.write(`\r\n\x1b[31m[octiq: ${message}]\x1b[0m\r\n`);
}

// ---- Global routing -------------------------------------------------------
// ptyId -> { term, group }. The ONE pty-output listener uses this to write each
// chunk into the matching xterm, no matter which group owns it.
const idToEntry = new Map();

// Subscribers that want the latest non-empty OUTPUT line of any terminal, by id
// (e.g. commands.js shows it on the footer). Each is called fn(id, line).
const lineSubscribers = new Set();

/** Subscribe to the latest output line of any terminal. Returns an unsubscribe
 *  function. Used by the footer command-status line. */
export function onTerminalLine(fn) {
  lineSubscribers.add(fn);
  return () => lineSubscribers.delete(fn);
}

/** Strip ANSI escape sequences so a chunk can be reduced to plain text. */
function stripAnsi(s) {
  return s
    .replace(/\x1B\[[0-9;?]*[ -/]*[@-~]/g, "")
    .replace(/\x1B\][^\x07\x1B]*(?:\x07|\x1B\\)/g, "");
}

/** The last non-empty line in a raw chunk, or null. CR is treated as a line
 *  break so progress-bar style output still yields a current line. */
function lastLine(chunk) {
  const parts = stripAnsi(chunk)
    .split(/\r\n|\r|\n/)
    .map((s) => s.trim())
    .filter(Boolean);
  return parts.length ? parts[parts.length - 1] : null;
}

// THE single pty-output listener for the whole app. Do not add another one
// anywhere else. Registered once at module load (modules load once).
listen("pty-output", (event) => {
  const { id, chunk } = event.payload;
  idToEntry.get(id)?.term.write(chunk);
  if (lineSubscribers.size && idToEntry.has(id)) {
    const line = lastLine(chunk);
    if (line) for (const fn of lineSubscribers) fn(id, line);
  }
});

// ---- Attention flags ------------------------------------------------------
// Set of pty ids that currently need the user's attention (card 13). A tab is
// badged (class tg-tab-attention + a dot) while its id is in here. alerts.js
// reads this list and reacts to the "tg-attention-change" event to rebuild its
// banner. Insertion order is preserved (Set) so "jump to next" cycles in the
// order the attentions arrived.
const attention = new Set();

// Fire a DOM event so alerts.js (and anything else) can rebuild its UI whenever
// the attention set changes. Detail carries a fresh snapshot of the ids.
function emitAttentionChange() {
  window.dispatchEvent(
    new CustomEvent("tg-attention-change", { detail: [...attention] }),
  );
}

/** The pty ids that currently need attention, in arrival order. */
export function attentionList() {
  return [...attention];
}

/** Find the { term, group } entry for a pty id, or undefined. */
function entryFor(id) {
  return idToEntry.get(id);
}

/**
 * Badge a terminal's TAB so the user can see it needs attention (card 13).
 * Adds the id to the attention set and paints its tab. No-op if the id is
 * unknown (its terminal may have been closed). Safe to call repeatedly.
 */
export function badgeTab(id) {
  const entry = entryFor(id);
  if (!entry) return;
  attention.add(id);
  entry.group._paintAttention(id, true);
  emitAttentionChange();
}

/**
 * Clear a terminal's attention badge. Removes it from the set, un-paints the
 * tab, and tells the backend to clear its OSC attention state (card 12) so the
 * same alert does not re-fire. Safe to call when the id is already clear.
 */
export function clearAttention(id) {
  if (!attention.has(id)) return;
  attention.delete(id);
  entryFor(id)?.group._paintAttention(id, false);
  // Tell the backend this terminal no longer needs attention. Ignore errors
  // (the PTY may already be gone); this must never throw into the UI.
  invoke("pty_clear_attention", { id }).catch(() => {});
  emitAttentionChange();
}

// modes.js owns the top-level view router but does not export a setMode. We
// switch views by clicking the matching mode button, exactly as a user would.
// The mode of a group is read from the #view-<mode> section that contains its
// root element, so no other file needs to tell terminals.js where it lives.
function switchToMode(mode) {
  const btn = document.querySelector(`.modebtn[data-mode="${mode}"]`);
  if (btn && !btn.classList.contains("modebtn-active")) btn.click();
}

/**
 * Jump to a terminal by id (card 13): switch to its mode if needed, activate
 * its tab inside its group, and clear its attention flag. No-op if unknown.
 */
export function focusTerminal(id) {
  const entry = entryFor(id);
  if (!entry) return;
  const mode = entry.group._mode();
  if (mode) switchToMode(mode);
  entry.group.show();
  entry.group.activate(id);
  // Focusing a terminal is the user acknowledging the alert: clear it.
  clearAttention(id);
}

// Keep every visible group's active terminal sized to the window. Groups that
// are hidden are skipped (fit on a hidden element measures zero).
const groups = new Set();
window.addEventListener("resize", () => {
  for (const g of groups) g.refitActive();
});

/**
 * Create a terminal-tab-group mounted inside `mountEl`.
 * `idPrefix` namespaces this group's PTY ids so they are unique app-wide
 * (e.g. the project id for card 04, "chat" for card 07).
 *
 * Returns the group API:
 *   newTerminal({ cwd, startCmd, title }) -> ptyId (async)
 *   closeTerminal(ptyId)
 *   activate(ptyId)
 *   show()            // un-hide + refit active
 *   hide()            // keep terminals alive, just hide the DOM
 *   ids()             // current pty ids in tab order
 *   count()           // number of live terminals
 *   refitActive()     // refit the active terminal if the group is visible
 *   dispose()         // close all terminals + remove from registries
 *
 * createTerminalGroup(mountEl, idPrefix, { showAdd } = {})
 */
export function createTerminalGroup(mountEl, idPrefix, { showAdd = true } = {}) {
  return new TerminalGroup(mountEl, idPrefix, { showAdd });
}

class TerminalGroup {
  constructor(mountEl, idPrefix, { showAdd = true } = {}) {
    this.idPrefix = idPrefix;
    this.seq = 0;
    // Monotonic counter for DEFAULT tab titles ("term N"). Never decremented,
    // so closing a tab and opening a new one cannot reuse a number (P4).
    this.titleSeq = 0;
    this.activeId = null;
    // ptyId -> { term, fitAddon, paneEl, tabEl, title }
    this.tabs = new Map();

    // Group DOM: a tab strip on top, a panes area filling the rest.
    this.root = document.createElement("div");
    this.root.className = "tg";

    this.stripEl = document.createElement("div");
    this.stripEl.className = "tg-strip";

    this.tabsEl = document.createElement("div");
    this.tabsEl.className = "tg-tabs";

    // The "+" callback is set by the owner via onAdd; default is a no-op so the
    // primitive does not assume any cwd/startCmd policy.
    this.onAdd = null;
    if (showAdd) {
      this.addBtn = document.createElement("button");
      this.addBtn.className = "tg-add";
      this.addBtn.title = "New terminal";
      this.addBtn.textContent = "+";
      this.addBtn.addEventListener("click", () => this.onAdd?.());
      this.stripEl.append(this.tabsEl, this.addBtn);
    } else {
      // Drawer groups (P5) have no add behavior; do not render the button.
      this.addBtn = null;
      this.stripEl.append(this.tabsEl);
    }

    this.panesEl = document.createElement("div");
    this.panesEl.className = "tg-panes";

    this.root.append(this.stripEl, this.panesEl);
    mountEl.append(this.root);

    groups.add(this);
  }

  ids() {
    return [...this.tabs.keys()];
  }

  count() {
    return this.tabs.size;
  }

  visible() {
    // The group is visible when neither it nor any ancestor is display:none.
    return this.root.offsetParent !== null;
  }

  async newTerminal({ cwd = "", startCmd = null, title = null } = {}) {
    // No explicit title -> auto-number from the monotonic counter (P4). An
    // explicit title (command label, chat label) is used verbatim.
    if (title == null) title = `term ${++this.titleSeq}`;
    const ptyId = `${this.idPrefix}:${this.seq++}`;

    const pane = document.createElement("div");
    pane.className = "tg-pane";
    this.panesEl.append(pane);

    const term = makeTerminal();
    const fitAddon = new FitAddon.FitAddon();
    term.loadAddon(fitAddon);
    term.open(pane);
    // WebGL renderer must load AFTER open() — it needs the live DOM element.
    attachWebgl(term);
    // Follow the pane's real size. A ResizeObserver fires for layout changes the
    // window "resize" event misses (drawer toggles, panel collapse, tab show),
    // so the fit — and the rows/cols we report to the PTY — never drift out of
    // sync with what is painted. We refit only when this tab is the active one.
    const ro = new ResizeObserver(() => {
      if (this.activeId === ptyId) this._fit(ptyId);
    });
    ro.observe(pane);
    term.onData((data) => {
      invoke("pty_write", { id: ptyId, data }).catch((err) => {
        reportTermError(term, `write failed: ${err}`);
      });
    });

    const tabEl = document.createElement("div");
    tabEl.className = "tg-tab";
    const label = document.createElement("span");
    label.className = "tg-tab-label";
    label.textContent = title;
    label.title = "Double-click to rename";
    // Double-click the label to rename the tab inline (card: rename tab).
    label.addEventListener("dblclick", (e) => {
      e.stopPropagation();
      this._beginRename(ptyId);
    });
    const closeBtn = document.createElement("button");
    closeBtn.className = "tg-tab-close";
    closeBtn.textContent = "✕";
    closeBtn.title = "Close terminal";
    closeBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      this.closeTerminal(ptyId);
    });
    tabEl.append(label, closeBtn);
    tabEl.addEventListener("click", () => this.activate(ptyId));
    this.tabsEl.append(tabEl);

    const entry = {
      term,
      fitAddon,
      paneEl: pane,
      tabEl,
      labelEl: label,
      title,
      ro,
    };
    this.tabs.set(ptyId, entry);
    idToEntry.set(ptyId, { term, group: this });

    // Spawn the backing PTY. Note Tauri maps start_cmd -> startCmd. If the
    // spawn fails, the pane + tab already exist, so show the error there (P3)
    // rather than swallowing it; the tab stays so the user sees what happened.
    try {
      await invoke("pty_spawn", { id: ptyId, cwd, startCmd });
    } catch (err) {
      reportTermError(term, `failed to start terminal: ${err}`);
    }

    this.activate(ptyId);
    return ptyId;
  }

  activate(ptyId) {
    if (!this.tabs.has(ptyId)) return;
    this.activeId = ptyId;
    for (const [id, e] of this.tabs) {
      const on = id === ptyId;
      e.tabEl.classList.toggle("tg-tab-active", on);
      e.paneEl.classList.toggle("tg-pane-active", on);
    }
    // Becoming the active tab counts as the user attending to this terminal, so
    // clear any attention flag on it (card 13). clearAttention is a no-op when
    // the id is not flagged, so this is cheap on normal tab switches.
    if (attention.has(ptyId)) clearAttention(ptyId);
    // Fit + focus on the next frame so the now-shown pane has a real size.
    // Skip focusing the terminal while the tab is being renamed, or the rAF
    // would steal focus from the inline rename input.
    requestAnimationFrame(() => {
      this._fit(ptyId);
      const e = this.tabs.get(ptyId);
      if (e && !e.renaming) e.term.focus();
    });
  }

  /**
   * Start inline rename of a tab (double-click its label). Swaps the label span
   * for a text input seeded with the current title. Enter or blur commits;
   * Escape cancels. An empty/whitespace title is rejected so the tab always
   * keeps a name. The new title lives in entry.title for the session — terminals
   * are not persisted across restarts, so neither is the rename.
   */
  _beginRename(ptyId) {
    const entry = this.tabs.get(ptyId);
    if (!entry || entry.renaming) return;
    entry.renaming = true;
    const { labelEl } = entry;

    const input = document.createElement("input");
    input.className = "tg-tab-rename";
    input.value = entry.title;
    // Pointer events inside the field must not bubble to the tab (which would
    // re-activate it and pull focus back to the terminal).
    input.addEventListener("click", (e) => e.stopPropagation());
    input.addEventListener("mousedown", (e) => e.stopPropagation());
    input.addEventListener("dblclick", (e) => e.stopPropagation());

    let done = false;
    const finish = (save) => {
      if (done) return;
      done = true;
      const next = input.value.trim();
      if (save && next) {
        entry.title = next;
        labelEl.textContent = next;
      }
      input.replaceWith(labelEl);
      entry.renaming = false;
    };

    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        finish(true);
      } else if (e.key === "Escape") {
        e.preventDefault();
        finish(false);
      }
    });
    input.addEventListener("blur", () => finish(true));

    labelEl.replaceWith(input);
    input.focus();
    input.select();
  }

  // ---- Attention helpers (card 13) ----------------------------------------
  // Paint or un-paint a tab's attention badge. Called by the module-level
  // badgeTab / clearAttention so the Set and the DOM stay in lock-step.
  _paintAttention(ptyId, on) {
    const entry = this.tabs.get(ptyId);
    if (!entry) return;
    entry.tabEl.classList.toggle("tg-tab-attention", on);
  }

  // Which top-level mode this group lives in ("project" | "chat" | "utilities"
  // | "dashboard"), read from the enclosing #view-<mode> section. Returns null
  // if the group is not (yet) inside a view. Used by focusTerminal to switch
  // modes before activating a tab in another mode.
  _mode() {
    const view = this.root.closest(".view");
    if (!view || !view.id?.startsWith("view-")) return null;
    return view.id.slice("view-".length);
  }

  closeTerminal(ptyId) {
    const entry = this.tabs.get(ptyId);
    if (!entry) return;
    // Drop any attention flag so the banner does not list a dead terminal
    // (card 13). Done before deleting the entry so the change event is clean.
    if (attention.has(ptyId)) {
      attention.delete(ptyId);
      emitAttentionChange();
    }
    invoke("pty_close", { id: ptyId }).catch(() => {});
    entry.ro?.disconnect();
    entry.term.dispose();
    entry.tabEl.remove();
    entry.paneEl.remove();
    this.tabs.delete(ptyId);
    idToEntry.delete(ptyId);
    if (this.activeId === ptyId) {
      const next = this.tabs.keys().next();
      this.activeId = next.done ? null : next.value;
      if (this.activeId) this.activate(this.activeId);
    }
  }

  show() {
    this.root.style.display = "";
    // Refit the active terminal after the element is laid out and measurable.
    requestAnimationFrame(() => this.refitActive());
  }

  hide() {
    // Keep terminals alive; just hide the DOM subtree.
    this.root.style.display = "none";
  }

  refitActive() {
    if (this.activeId && this.visible()) this._fit(this.activeId);
  }

  _fit(ptyId) {
    const entry = this.tabs.get(ptyId);
    if (!entry || !this.visible()) return;
    try {
      entry.fitAddon.fit();
      invoke("pty_resize", {
        id: ptyId,
        rows: entry.term.rows,
        cols: entry.term.cols,
      }).catch(() => {});
    } catch (_) {
      // Not mounted / zero size yet; ignore.
    }
  }

  dispose() {
    for (const id of [...this.tabs.keys()]) this.closeTerminal(id);
    groups.delete(this);
    this.root.remove();
  }
}
