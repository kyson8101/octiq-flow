// Shared terminal-tab-group primitive. This file is the SINGLE source of
// terminal management for the whole app. Project (card 04), Chat (card 07),
// and command terminals create groups through createTerminalGroup().
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

// Longest "last sent" line we keep for the bottom bar. Longer than a tab title
// because a prompt to an agent is usually a sentence, not one word; the bar
// ellipsizes anything past what fits, but the captured string is bounded.
const MAX_SENT_LEN = 200;

/**
 * Feed raw terminal INPUT (the bytes the user types, as xterm reports them via
 * onData) into a small line buffer and return the next completed line, or null
 * until one is entered (Enter). `state` is `{ buf, mode }`, carried across
 * calls; `maxLen` caps the returned string.
 *
 * Two callers use this: tab auto-naming keeps the FIRST line (capped to a short
 * title) and the bottom "last sent" bar keeps the LATEST line. Both rebuild the
 * typed line the same way — it handles the common edits (printable chars,
 * Backspace, Ctrl-U/Ctrl-C clear, Enter commits) and SKIPS escape sequences.
 *
 * The escape skip is the subtle part: onData carries not just keystrokes but
 * the terminal's own REPLIES (focus in/out `ESC[I`/`ESC[O`, device-attributes
 * `ESC[?1;2c`, cursor-position reports, bracketed-paste markers `ESC[200~`).
 * These must be dropped whole or their tail leaks into the captured line. So we
 * track the sequence kind: after `ESC`, a `[` opens a CSI run that ends only on
 * a final byte `@`–`~` (NOT the `[` itself); a `]`/`P`/`X`/`^`/`_` opens an
 * OSC/string run that ends on BEL or ST (`ESC \`); any other byte is a short
 * two-byte escape that ends immediately.
 *
 * It is still a heuristic, not a full TUI parser: tab-completion rewrites,
 * in-line cursor edits, and multi-line prompts may yield an imperfect line —
 * good enough to label a tab or remind the user what they just sent, never
 * treated as the exact submitted prompt.
 */
function nextTypedLine(state, data, maxLen = MAX_CMD_TITLE_LEN) {
  for (let i = 0; i < data.length; i++) {
    const code = data.charCodeAt(i);
    switch (state.mode) {
      case "esc":
        // The byte right after ESC decides the sequence kind.
        if (code === 0x5b) {
          state.mode = "csi"; // ESC [  -> CSI (arrows, focus, DA, paste markers)
        } else if (
          code === 0x5d || // ESC ]  OSC
          code === 0x50 || // ESC P  DCS
          code === 0x58 || // ESC X  SOS
          code === 0x5e || // ESC ^  PM
          code === 0x5f // ESC _  APC
        ) {
          state.mode = "str";
        } else {
          state.mode = null; // a short two-byte escape (e.g. ESC O x): done.
        }
        continue;
      case "csi":
        // Parameter (0x30–0x3f) and intermediate (0x20–0x2f) bytes continue the
        // run; a final byte @–~ (0x40–0x7e) ends it. The introducer `[` is
        // never the final byte, so its tail no longer leaks.
        if (code >= 0x40 && code <= 0x7e) state.mode = null;
        continue;
      case "str":
        // OSC/DCS/SOS/PM/APC end on BEL or ST (ESC \). On ESC, hop to "esc" so
        // the following `\` resolves the ST and ends the run.
        if (code === 0x07) state.mode = null;
        else if (code === 0x1b) state.mode = "esc";
        continue;
      default:
        break; // mode === null: normal text handling below.
    }
    if (code === 0x1b) {
      state.mode = "esc"; // ESC: start classifying the sequence that follows.
    } else if (code === 0x0d || code === 0x0a) {
      // Enter: a non-empty line is the one we were waiting for.
      const line = state.buf.trim();
      state.buf = "";
      if (line) return line.slice(0, maxLen);
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
    // Output activity drives the "working" dot (tmux monitor-activity style):
    // stamp the time, and if this is an agent tab that is not waiting for input,
    // light the dot at once. refreshWorking() (a timer) turns it back off once
    // output goes silent for WORKING_IDLE_MS. See the Working flags section.
    noteOutput(id);
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

/** Whether a pty id is the ACTIVE tab of a currently-VISIBLE group — i.e. the
 *  terminal the user is looking at right now. alerts.js uses this to skip
 *  badging a terminal that is already in front of the user (the agent's prompt
 *  is right there), while still badging every other / hidden terminal. */
export function isActiveVisible(id) {
  const entry = idToEntry.get(id);
  return !!entry && entry.group.activeId === id && entry.group.visible();
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
  // A tab waiting for input is, by definition, not "working" — drop its working
  // dot at once so the two indicators never show together (the poll would
  // otherwise leave the working dot up until its next tick).
  if (setWorking(id, false)) emitWorkingChange();
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

// ---- Working flags --------------------------------------------------------
// Set of pty ids whose AGENT IS WORKING right now. "Working" is driven by the
// OUTPUT STREAM, tmux monitor-activity style: a thinking agent streams output
// (spinner frames, tokens) many times a second, while an agent sitting at its
// prompt is silent. A tab is working when ALL of these hold:
//   - a non-shell process is the PTY's foreground (backend `pty_agent_running`)
//     — i.e. it is an agent tab, not the bare shell prompt;
//   - it produced output within the last WORKING_IDLE_MS (still streaming);
//   - it is NOT flagged "waiting for you" (not in the attention set).
// This replaces the old foreground-only check, which stayed true for the WHOLE
// agent session (a TUI agent holds the foreground even while idle at its prompt)
// and so pulsed forever, telling the user nothing. A tab in here shows a sage
// dot; working.js counts them per project for the sidebar.
const working = new Set();

// A tab counts as working only while output keeps flowing: the dot drops this
// many ms after the last output chunk. ~700ms keeps a thinking agent lit (its
// spinner updates several times a second) and clears an idle prompt fast.
const WORKING_IDLE_MS = 700;

// How often to re-check for silence (turn the dot OFF once output stops) and to
// settle a waiting/closed flip. Output turns the dot ON instantly (noteOutput),
// so this tick only ever needs to handle turn-OFFs.
const WORKING_TICK_MS = 300;

// How often to poll the backend for the per-tab foreground state — the "is this
// an agent tab" gate. Not event-driven (unlike output), so it is polled; ~1.5s
// is snappy without being heavy (one cheap foreground-pgid read per live PTY).
const FOREGROUND_POLL_MS = 1500;

// Latest backend foreground snapshot: ids whose foreground is a non-shell
// process (an agent tab). Set by pollForeground; read by isWorkingNow.
let foregroundAgents = new Set();

// id -> performance.now() of its last output chunk. Stamped by noteOutput; read
// by isWorkingNow to tell streaming apart from silence.
const lastOutputAt = new Map();

/** The pty ids whose agent is currently working, in insertion order. */
export function workingList() {
  return [...working];
}

/**
 * Snapshot of EVERY live terminal across the whole app, for the Agent World
 * view. One plain object per terminal so a consumer never touches a group's
 * internals:
 *   - id         the pty id (also the key alerts/working use)
 *   - prefix     the group id prefix ("<projectId>", "cmd:<projectId>",
 *                "chat", "util", "sched") — Agent World maps this to a room
 *   - title      the tab's current title (agent name / first command / "term N")
 *   - lastSent   the latest line the user typed + sent in the tab, or null
 *   - working    true while the agent streams output (sage "working" dot)
 *   - attention  true while the tab is flagged waiting-for-you
 * Order follows idToEntry insertion (terminals appear as they were opened).
 */
export function terminalSnapshot() {
  return [...idToEntry.entries()].map(([id, { group }]) => {
    const tab = group.tabs.get(id);
    return {
      id,
      prefix: group.idPrefix,
      title: tab?.title || id,
      lastSent: tab?.lastSent || null,
      working: working.has(id),
      attention: attention.has(id),
    };
  });
}

// Fire a DOM event so working.js (and anything else) can rebuild its UI when
// the working set changes. Detail carries a fresh snapshot of the ids.
function emitWorkingChange() {
  window.dispatchEvent(
    new CustomEvent("tg-working-change", { detail: [...working] }),
  );
}

/** Whether a tab is working RIGHT NOW: an agent tab (non-shell foreground), not
 *  waiting for input, and still streaming output (a chunk within the last
 *  WORKING_IDLE_MS). */
function isWorkingNow(id) {
  if (!foregroundAgents.has(id) || attention.has(id)) return false;
  const last = lastOutputAt.get(id);
  return last !== undefined && performance.now() - last < WORKING_IDLE_MS;
}

/** Set or clear a tab's working flag and repaint its tab, returning whether the
 *  set actually changed. A no-op when the value is unchanged or the id is
 *  unknown (its terminal was closed). Does NOT emit — the caller batches one
 *  emit per change so a sweep that moves many tabs fires a single event. */
function setWorking(id, on) {
  if (on === working.has(id)) return false;
  if (on) working.add(id);
  else working.delete(id);
  entryFor(id)?.group._paintWorking(id, on);
  return true;
}

/** A tab just produced output: stamp the time and, if it is an agent tab not
 *  waiting for input, light its working dot immediately. Called from the single
 *  pty-output listener, so the dot reacts the instant an agent starts thinking;
 *  refreshWorking() handles the turn-off once it goes quiet. */
function noteOutput(id) {
  lastOutputAt.set(id, performance.now());
  if (foregroundAgents.has(id) && !attention.has(id)) {
    if (setWorking(id, true)) emitWorkingChange();
  }
}

/** Recompute the working flag for the ids that could change — those already
 *  working plus the current foreground agents — and emit once if anything moved.
 *  This is what turns a dot OFF after its tab goes silent (WORKING_IDLE_MS),
 *  flips to waiting, or closes; noteOutput turns dots ON. */
function refreshWorking() {
  let changed = false;
  for (const id of new Set([...foregroundAgents, ...working])) {
    if (setWorking(id, idToEntry.has(id) && isWorkingNow(id))) changed = true;
  }
  if (changed) emitWorkingChange();
}

// Poll the backend for which tabs have a non-shell foreground process (the
// "agent tab" gate), refresh the snapshot, then recompute. A backend hiccup
// keeps the last snapshot and tries again next tick.
async function pollForeground() {
  let running;
  try {
    running = await invoke("pty_agent_running");
  } catch {
    return; // backend hiccup: keep the current snapshot, try again next tick
  }
  foregroundAgents = new Set(
    Object.keys(running).filter((id) => running[id] === true),
  );
  refreshWorking();
}

setInterval(pollForeground, FOREGROUND_POLL_MS);
setInterval(refreshWorking, WORKING_TICK_MS);

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

/**
 * Write `text` into the ACTIVE terminal of the project group whose id prefix is
 * `prefix` (the project id), exactly as if the user typed it (the app's core
 * pty_write trick). With `submit` true, also send Enter ("\r") so an agent runs
 * it. Brings that terminal to the front so the user sees the reply. Returns true
 * if a terminal received the text, or false if the project has no open terminal.
 * Used by the canvas "ask about this" composer (canvas.js).
 */
export function sendToProjectTerminal(prefix, text, submit = false) {
  for (const { group } of idToEntry.values()) {
    if (group.idPrefix === prefix && group.activeId) {
      const id = group.activeId;
      invoke("pty_write", { id, data: submit ? `${text}\r` : text }).catch(() => {});
      group.show();
      group.activate(id);
      return true;
    }
  }
  return false;
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

    // Thin bottom bar showing the last line the user typed and sent (Enter) in
    // the ACTIVE terminal — a reminder of "what did I just send to Claude/Codex".
    // A sibling of the panes (not a child of any pane), so it never affects the
    // xterm fit math, which measures the pane box. Always present so its height
    // is baked into the first fit and no refit churns on every Enter.
    this.lastSentEl = document.createElement("div");
    this.lastSentEl.className = "tg-lastsent";
    this.lastSentEl.title = "The last line you typed and sent (Enter) in this terminal";
    this.lastSentLabelEl = document.createElement("span");
    this.lastSentLabelEl.className = "tg-lastsent-label";
    this.lastSentLabelEl.textContent = "sent";
    this.lastSentTextEl = document.createElement("span");
    this.lastSentTextEl.className = "tg-lastsent-text";
    this.lastSentEl.append(this.lastSentLabelEl, this.lastSentTextEl);
    this._renderLastSent(null);

    this.root.append(this.stripEl, this.panesEl, this.lastSentEl);
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
    canvasKey = null,
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
    // Reconstruct the lines the user types in this tab. The FIRST line names a
    // plain (non-agent) terminal; the LATEST line feeds the bottom "last sent"
    // bar. Both read the same rebuilt line, so one tracker serves both. State is
    // carried across onData calls. `entry` is assigned just below and always
    // exists by the time the user types.
    const inputState = { buf: "", mode: null };
    term.onData((data) => {
      const line = nextTypedLine(inputState, data, MAX_SENT_LEN);
      if (line && entry) {
        if (!entry.firstCmd) entry.firstCmd = line.slice(0, MAX_CMD_TITLE_LEN);
        entry.lastSent = line;
        this._paintLastSent(ptyId);
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
      // The latest line the user typed and sent (Enter) in this tab (null until
      // one is sent). Shown in the bottom "last sent" bar when this tab is
      // active. In memory only — not persisted across restart.
      lastSent: null,
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
      await invoke("pty_spawn", { id: ptyId, cwd, startCmd, persistKey, shell, canvasKey });
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
    // The bottom bar always tracks the visible terminal: repaint it for the
    // now-active tab's last sent line (or the placeholder if it has none).
    this._paintLastSent(ptyId);
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

  // Paint or un-paint a tab's "working" badge (a sage dot before the label).
  // Called by the module-level setWorking so the Set and the DOM stay in step.
  _paintWorking(ptyId, on) {
    const entry = this.tabs.get(ptyId);
    if (!entry) return;
    entry.tabEl.classList.toggle("tg-tab-working", on);
  }

  // ---- Last-sent bar ------------------------------------------------------
  // Write `text` into the bottom bar, or show the dim placeholder when it is
  // null/empty (no line sent yet in the active terminal). Kept tiny: one text
  // node + a class toggle, so paint-on-every-Enter is cheap.
  _renderLastSent(text) {
    const has = !!(text && text.trim());
    this.lastSentTextEl.textContent = has ? text : "nothing sent yet";
    this.lastSentEl.classList.toggle("tg-lastsent-empty", !has);
  }

  // Repaint the bar to reflect a terminal's last sent line, but only when that
  // terminal is the active one — the bar always shows the visible terminal.
  // No-op for a background tab, so typing never leaks across tabs.
  _paintLastSent(ptyId) {
    if (ptyId !== this.activeId) return;
    this._renderLastSent(this.tabs.get(ptyId)?.lastSent ?? null);
  }

  // Which top-level mode this group lives in, read from the enclosing
  // #view-<mode> section. Returns null
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
    // Likewise drop the working flag so the per-project count never includes a
    // closed terminal (refreshWorking would catch it, but not before the next
    // tick). Also drop its output timestamp so the map never holds dead ids.
    if (working.has(ptyId)) {
      working.delete(ptyId);
      emitWorkingChange();
    }
    lastOutputAt.delete(ptyId);
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
      // No terminals left: clear the bar so it does not keep the closed tab's
      // last sent line.
      else this._renderLastSent(null);
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
      // FitAddon's row count comes from the fractional CSS cell height
      // (fontSize × lineHeight, e.g. 15.6px), but the renderer rounds each
      // cell UP to whole device pixels, so the painted grid is slightly
      // taller than the math assumes. Over a tall pane that adds up to whole
      // rows, which the pane's overflow:hidden then clips at the bottom
      // (hiding e.g. an agent's input box). So don't trust the math alone:
      // cap rows by the PAINTED cell height (current .xterm-screen height ÷
      // current rows) and take the smaller. A stale measurement (font just
      // changed) self-corrects: the screen ResizeObserver re-runs this after
      // the next paint, and the bound is idempotent once paint catches up.
      const dims = entry.fitAddon.proposeDimensions();
      if (!dims || !isFinite(dims.cols) || !isFinite(dims.rows)) return;
      let rows = dims.rows;
      let cols = dims.cols;
      const screenEl = entry.term.element?.querySelector(".xterm-screen");
      const paneH = entry.paneEl.clientHeight;
      const paneW = entry.paneEl.clientWidth;
      if (screenEl && entry.term.rows > 0 && entry.term.cols > 0) {
        const rect = screenEl.getBoundingClientRect();
        const cellH = rect.height / entry.term.rows;
        const cellW = rect.width / entry.term.cols;
        if (paneH > 0 && cellH > 0) rows = Math.min(rows, Math.floor(paneH / cellH));
        // Same rounding overflow exists horizontally (clips the right edge of
        // full-width TUI boxes). min() against the math keeps this shrink-only,
        // so the scrollbar gutter FitAddon already subtracted stays respected.
        if (paneW > 0 && cellW > 0) cols = Math.min(cols, Math.floor(paneW / cellW));
      }
      rows = Math.max(rows, 1);
      cols = Math.max(cols, 2);
      if (entry.term.cols !== cols || entry.term.rows !== rows) {
        // A real resize is the only path that force-syncs xterm's viewport
        // scroll area (its internal _afterResize calls viewport.syncScrollArea).
        entry.term.resize(cols, rows);
      } else {
        // Dims unchanged, so xterm's resize path did NOT run — and its viewport
        // scroll area can be stale. A terminal keeps receiving output while its
        // pane is display:none (background tab / hidden group). Each hidden write
        // makes xterm record the pane's offsetHeight as 0 and compute a scroll
        // area that is one viewport too SHORT, so on re-show the bottom rows sit
        // past the scrollable height: the view looks scrolled up and the bottom
        // (e.g. an agent's input box) is unreachable until a window resize forces
        // a real resize. Re-running fit here finds the same rows/cols, so resize
        // is skipped and nothing fixes it. Force the same scroll-area resync a
        // resize would do, so re-showing a tab self-heals. Guarded + best-effort:
        // the internal shape is stable in the vendored, pinned xterm, and any
        // miss must never break the terminal.
        try {
          entry.term._core?.viewport?.syncScrollArea?.(true);
        } catch (_) {
          // Internal API moved/absent — ignore; worst case is the old behaviour.
        }
      }
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
