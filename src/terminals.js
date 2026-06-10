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
import { getTerminalSettings, TERMINAL_SETTINGS_CHANGED } from "/settings.js";
import { ICONS } from "/icons.js";

const { invoke } = window.__TAURI__.core;
const { listen } = window.__TAURI__.event;

// Shared dark theme for every terminal in the app. The font (family, size, line
// height) is NOT fixed here — it comes from the user's Settings (settings.js).
// MUST stay in sync with the CSS tokens in styles.css (:root): background =
// --bg-0, foreground = --fg-1, cursor = --accent. The pane background blends
// with the terminal only while these match.
const TERM_THEME = {
  background: "#141417",
  foreground: "#c9c9c5",
  cursor: "#8fbfa8",
  selectionBackground: "#31443c",
};

// Visible text of the break banner drawn between a restored session and the
// fresh shell. Kept as a constant because we both WRITE it (on restore) and
// STRIP it (from the prior scrollback) — they must use the exact same text or
// banners would stack up across restarts.
const SESSION_BREAK_TEXT = "session restored · shell restarted";
const SESSION_BREAK_LINE = `\r\n\x1b[2m──────── ${SESSION_BREAK_TEXT} ────────\x1b[0m\r\n`;

function makeTerminal() {
  const s = getTerminalSettings();
  return new Terminal({
    fontFamily: s.fontFamily,
    fontSize: s.fontSize,
    fontWeight: s.fontWeight,
    lineHeight: s.lineHeight,
    letterSpacing: s.letterSpacing,
    cursorBlink: true,
    theme: TERM_THEME,
    // Scrolling feel. smoothScrollDuration animates each wheel scroll over N ms
    // instead of jumping line-by-line, so the viewport glides. scrollSensitivity
    // sets how many lines one wheel notch moves; fastScroll* is the Alt-held
    // boost for jumping long distances. These only affect user wheel scrolling —
    // programmatic scroll-to-bottom on new output stays instant.
    smoothScrollDuration: 100,
    scrollSensitivity: 3,
    fastScrollModifier: "alt",
    fastScrollSensitivity: 8,
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

// Longest first-command title we keep. The tab strip ellipsizes, but a bounded
// string keeps the saved layout small and the tab readable.
const MAX_CMD_TITLE_LEN = 60;

/**
 * Feed raw terminal INPUT (the bytes the user types, as xterm reports them via
 * onData) into a small line buffer and return the first completed command line,
 * or null until one is entered. `state` is `{ buf, esc }`, carried across calls.
 *
 * This reconstructs the typed line well enough to name a tab — it handles the
 * common edits (printable chars, Backspace, Ctrl-U/Ctrl-C clear, Enter commits)
 * and skips escape sequences (arrow keys, bracketed-paste markers). It is a
 * heuristic, not a shell parser: tab-completion rewrites and in-line cursor
 * edits may yield an imperfect name, which the user can always fix by hand.
 */
function nextTypedCommand(state, data) {
  for (let i = 0; i < data.length; i++) {
    const code = data.charCodeAt(i);
    if (state.esc) {
      // Inside an escape sequence (CSI etc.); a final byte in @-~ ends it.
      if (code >= 0x40 && code <= 0x7e) state.esc = false;
      continue;
    }
    if (code === 0x1b) {
      state.esc = true; // ESC: start skipping the sequence that follows.
    } else if (code === 0x0d || code === 0x0a) {
      // Enter: a non-empty line is the command we were waiting for.
      const cmd = state.buf.trim();
      state.buf = "";
      if (cmd) return cmd.slice(0, MAX_CMD_TITLE_LEN);
    } else if (code === 0x7f || code === 0x08) {
      state.buf = state.buf.slice(0, -1); // Backspace.
    } else if (code === 0x15 || code === 0x03) {
      state.buf = ""; // Ctrl-U (kill line) / Ctrl-C (abandon).
    } else if (code >= 0x20) {
      if (state.buf.length < 256) state.buf += data[i]; // Printable.
    }
    // Other control bytes (Tab, etc.) are ignored.
  }
  return null;
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
  const entry = idToEntry.get(id);
  if (entry) {
    entry.term.write(chunk);
    // Tell the owning group one of its terminals produced output. An owner that
    // persists scrollback (project.js) uses this to mark the terminal dirty so
    // the next save captures the new output.
    entry.group.onOutput?.(id);
  }
  if (lineSubscribers.size && entry) {
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

// Sizing: every pane has its own ResizeObserver (see newTerminal), so window
// resizes AND in-page layout shifts (alert banner, paths footer, panel
// collapse) all trigger a refit. There is no window "resize" listener — it
// would miss the in-page shifts anyway.

// Apply a font setting change (family / size / line height) to every OPEN
// terminal live, then refit so each group's rows/cols and PTY size track the
// new glyph metrics. xterm 5 applies option writes immediately and the WebGL
// renderer rebuilds its glyph atlas on a char-size change, so no reopen is
// needed. Non-active tabs and hidden groups re-fit themselves when next
// activated/shown, so refitting the active visible terminal here is enough.
window.addEventListener(TERMINAL_SETTINGS_CHANGED, (e) => {
  const s = e.detail || getTerminalSettings();
  for (const { term } of idToEntry.values()) {
    term.options.fontFamily = s.fontFamily;
    term.options.fontSize = s.fontSize;
    term.options.fontWeight = s.fontWeight;
    term.options.lineHeight = s.lineHeight;
    term.options.letterSpacing = s.letterSpacing;
  }
  const liveGroups = new Set([...idToEntry.values()].map((e) => e.group));
  for (const g of liveGroups) g.refitActive();
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
 * With `quickSpawn: true` the strip also renders a right-aligned "Claude | Codex"
 * control; clicking a side calls the owner's `onQuickSpawn(agent)` hook so the
 * owner can open a new terminal and launch that agent (project mode uses this).
 *
 * createTerminalGroup(mountEl, idPrefix, { showAdd, quickSpawn } = {})
 */
export function createTerminalGroup(
  mountEl,
  idPrefix,
  { showAdd = true, quickSpawn = false } = {},
) {
  return new TerminalGroup(mountEl, idPrefix, { showAdd, quickSpawn });
}

class TerminalGroup {
  constructor(mountEl, idPrefix, { showAdd = true, quickSpawn = false } = {}) {
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
    // Quick-spawn callback (quickSpawn groups only): onQuickSpawn(agent) fires
    // with "claude" | "codex" when the user clicks that side of the strip's
    // agents control. The owner decides cwd + launch command.
    this.onQuickSpawn = null;
    // Optional owner hooks for persistence. onLayoutChange fires after a
    // structural change (new/close/rename); onOutput(ptyId) fires when a
    // terminal in this group produces output. Both default to no-op — only a
    // group whose owner persists state (project.js) sets them.
    this.onLayoutChange = null;
    this.onOutput = null;
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

    // Right-aligned "Claude | Codex" quick-spawn control. Only rendered when the
    // owner opts in; its margin-left:auto pushes it to the strip's right end.
    if (quickSpawn) {
      this.agentsEl = this._buildQuickSpawn();
      this.stripEl.append(this.agentsEl);
    } else {
      this.agentsEl = null;
    }

    this.panesEl = document.createElement("div");
    this.panesEl.className = "tg-panes";

    this.root.append(this.stripEl, this.panesEl);
    mountEl.append(this.root);
  }

  ids() {
    return [...this.tabs.keys()];
  }

  count() {
    return this.tabs.size;
  }

  /**
   * Build the right-aligned "Claude | Codex" agents control. Each side is a
   * button whose click forwards a fixed agent name to onQuickSpawn — the names
   * are hard-coded here (never user-supplied), so nothing is interpolated into a
   * shell command downstream. A thin divider span sits between the two sides.
   */
  _buildQuickSpawn() {
    const wrap = document.createElement("div");
    wrap.className = "tg-agents";
    wrap.title = "Open a new terminal and start an agent";

    const makeBtn = (agent, text) => {
      const btn = document.createElement("button");
      btn.className = "tg-agent";
      btn.dataset.agent = agent;
      btn.textContent = text;
      btn.title = `New ${text} terminal`;
      btn.addEventListener("click", () => this.onQuickSpawn?.(agent));
      return btn;
    };

    const sep = document.createElement("span");
    sep.className = "tg-agent-sep";
    sep.setAttribute("aria-hidden", "true");

    wrap.append(makeBtn("claude", "Claude"), sep, makeBtn("codex", "Codex"));
    return wrap;
  }

  // ---- Persistence (session restore) --------------------------------------
  // The owner (project.js) reads these to save the group and writes them back
  // via newTerminal({ persistKey, restoreScrollback }) on the next launch.

  /** Ordered layout of this group: each terminal's stable key, current title,
   *  and the cwd it was spawned in. Tab order = insertion order of `tabs`. */
  serialize() {
    return [...this.tabs.values()].map((e) => ({
      persistKey: e.persistKey,
      title: e.title,
      titleManual: !!e.titleManual,
      cwd: e.cwd || "",
    }));
  }

  /** Snapshot every terminal's scrollback (text + styles) for saving. The
   *  `scrollback` cap bounds how many lines are serialized; the backend caps
   *  bytes again as the hard limit. */
  scrollbackEntries() {
    return [...this.tabs.values()].map((e) => ({
      persistKey: e.persistKey,
      data: e.serializeAddon ? e.serializeAddon.serialize({ scrollback: 2000 }) : "",
    }));
  }

  /** One terminal's scrollback snapshot, by pty id (or "" if unknown). */
  scrollbackFor(ptyId) {
    const e = this.tabs.get(ptyId);
    return e?.serializeAddon ? e.serializeAddon.serialize({ scrollback: 2000 }) : "";
  }

  /** Stable persist key for a pty id, or null. */
  persistKeyFor(ptyId) {
    return this.tabs.get(ptyId)?.persistKey ?? null;
  }

  /** The first command typed in a tab, or null if none captured yet. */
  firstCmdFor(ptyId) {
    return this.tabs.get(ptyId)?.firstCmd ?? null;
  }

  /**
   * Set a tab's title automatically. `fromAgent` marks the title as coming from
   * an agent session (vs the tab's first command). No-op when the tab is
   * unknown, the user has renamed it by hand (titleManual), the title is
   * unchanged, or a first-command title would overwrite a stickier agent title —
   * so a poll loop calling this every few seconds is cheap and never downgrades
   * or fights a name. Returns whether the title actually changed (so the caller
   * can persist only real changes).
   */
  setAutoTitle(ptyId, title, fromAgent = false) {
    const entry = this.tabs.get(ptyId);
    const next = (title || "").trim();
    if (!entry || entry.titleManual || !next || next === entry.title) {
      return false;
    }
    // An agent title outranks a first-command title: once an agent named the
    // tab, the first-command path must not rename it after the agent exits.
    if (!fromAgent && entry.titleFromAgent) return false;
    entry.title = next;
    entry.labelEl.textContent = next;
    entry.titleFromAgent = fromAgent;
    // Persist the new title so it survives a restart (debounced by the owner).
    this.onLayoutChange?.();
    return true;
  }

  visible() {
    // The group is visible when neither it nor any ancestor is display:none.
    return this.root.offsetParent !== null;
  }

  async newTerminal({
    cwd = "",
    startCmd = null,
    title = null,
    titleManual = false,
    persistKey = null,
    restoreScrollback = "",
  } = {}) {
    // No explicit title -> auto-number from the monotonic counter (P4). An
    // explicit title (command label, chat label) is used verbatim.
    if (title == null) title = `term ${++this.titleSeq}`;
    // Stable key for this terminal's saved scrollback. Generated once and kept
    // across restarts (the live ptyId is regenerated each session, so it cannot
    // be the key). On restore the owner passes the saved key back in.
    if (persistKey == null) persistKey = crypto.randomUUID();
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
    // Serialize addon snapshots the buffer (text + styles) to a string we save
    // to disk and write back on the next launch (session persistence).
    const serializeAddon = new SerializeAddon.SerializeAddon();
    term.loadAddon(serializeAddon);
    // Follow the pane's real size. A ResizeObserver fires for layout changes the
    // window "resize" event misses (drawer toggles, panel collapse, tab show),
    // so the fit — and the rows/cols we report to the PTY — never drift out of
    // sync with what is painted. We refit only when this tab is the active one.
    const ro = new ResizeObserver(() => {
      if (this.activeId === ptyId) this._fit(ptyId);
    });
    ro.observe(pane);
    // Also watch the rendered grid (.xterm-screen). Its height is rows × cell
    // height, so it changes when cell METRICS change with no layout resize at
    // all — WebGL context loss swapping in the DOM renderer, a display-DPI
    // move, a font swap. Without this, a grid that became taller than the pane
    // stays clipped by the pane's overflow:hidden (hiding the bottom rows,
    // e.g. an agent's input box) until the user resizes the window. Re-running
    // fit settles in one round: once rows/cols match the pane, fit no longer
    // changes the grid and the observer goes quiet.
    const screenEl = term.element?.querySelector(".xterm-screen");
    if (screenEl) ro.observe(screenEl);
    // Reconstruct the first command typed in this tab, so a plain (non-agent)
    // terminal can auto-name itself from it. State is carried across onData
    // calls; once a command is captured we stop tracking. `entry` is assigned
    // just below and always exists by the time the user types.
    const cmdState = { buf: "", esc: false };
    term.onData((data) => {
      if (entry && !entry.firstCmd) {
        const cmd = nextTypedCommand(cmdState, data);
        if (cmd) entry.firstCmd = cmd;
      }
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
    closeBtn.innerHTML = ICONS.x(11);
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
      serializeAddon,
      paneEl: pane,
      tabEl,
      labelEl: label,
      title,
      // True once the user renames the tab by hand: auto-rename then leaves it
      // alone. Restored from the saved layout so a manual name survives restart.
      titleManual,
      // True once an agent session title named this tab. It makes the agent
      // title "sticky": after the agent exits (its session mapping is pruned),
      // the first-command path must not downgrade the tab back to "claude".
      titleFromAgent: false,
      // The first command typed in this tab (null until one is entered). Used to
      // auto-name a plain terminal that never launched an agent.
      firstCmd: null,
      cwd,
      startCmd,
      persistKey,
      ro,
    };
    this.tabs.set(ptyId, entry);

    // Restore prior output BEFORE routing goes live (idToEntry.set) and before
    // the PTY spawns. The global pty-output listener only writes once the id is
    // in idToEntry, so writing the saved scrollback first guarantees the fresh
    // shell's first prompt lands AFTER the restored block, never interleaved.
    if (restoreScrollback) {
      // Earlier restores wrote their own break banner into the buffer, which
      // then got serialized into this saved scrollback. Drop those carried-over
      // banner lines so they do not stack up over many restarts — we add back
      // exactly one fresh banner below. The marker text is literal in the
      // serialized output, so a line-level includes() match is enough even
      // though the surrounding dim SGR codes may be re-encoded.
      const cleaned = restoreScrollback
        .split(/\r?\n/)
        .filter((line) => !line.includes(SESSION_BREAK_TEXT))
        .join("\r\n");
      term.write(cleaned);
      term.write(SESSION_BREAK_LINE);
    }
    idToEntry.set(ptyId, { term, group: this, persistKey });

    // Spawn the backing PTY. Note Tauri maps start_cmd -> startCmd and
    // persist_key -> persistKey. The persist key is exported into the shell as
    // OCTIQ_TERM_KEY so an agent's capture hook can tag its session to this tab
    // (session resume on restart). `shell` is the Windows shell pick from
    // Settings (ignored on Unix); it is read at spawn time so a new terminal
    // always uses the current choice. If the spawn fails, the pane + tab already
    // exist, so show the error there (P3) rather than swallowing it; the tab
    // stays so the user sees what happened.
    const { shell } = getTerminalSettings();
    try {
      await invoke("pty_spawn", { id: ptyId, cwd, startCmd, persistKey, shell });
    } catch (err) {
      reportTermError(term, `failed to start terminal: ${err}`);
    }

    this.activate(ptyId);
    // A tab was added: let the owner persist the new layout.
    this.onLayoutChange?.();
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
   * keeps a name. The new title lives in entry.title and is saved with the
   * group's layout (onLayoutChange), so a rename survives a restart.
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
      const changed = save && next && next !== entry.title;
      if (save && next) {
        entry.title = next;
        labelEl.textContent = next;
        // A hand-typed name pins the tab: auto-rename must not override it.
        entry.titleManual = true;
      }
      input.replaceWith(labelEl);
      entry.renaming = false;
      // Persist the renamed tab so the title survives a restart.
      if (changed) this.onLayoutChange?.();
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
    // A tab was removed: let the owner persist the shrunken layout. The backend
    // reconciles and deletes the closed terminal's saved scrollback file.
    this.onLayoutChange?.();
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
    this.root.remove();
  }
}
