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
import {
  getTerminalSettings,
  resolveTerminalSettings,
  TERMINAL_SETTINGS_CHANGED,
} from "/settings.js";
import { ICONS } from "/icons.js";
import { openCtxMenu } from "/ctxmenu.js";
import { attachBlockOverlay } from "/termoverlay.js";

const { invoke } = window.__TAURI__.core;
const { listen } = window.__TAURI__.event;

// The terminal color theme is NOT fixed here — like the font it comes from the
// user's Settings (settings.js `theme`), resolved per group so a project can
// override it. The default theme's background/foreground/cursor mirror the CSS
// tokens in styles.css (:root) so the pane background blends with the terminal
// until the user recolors it.

// Visible text of the break banner drawn between a restored session and the
// fresh shell. Kept as a constant because we both WRITE it (on restore) and
// STRIP it (from the prior scrollback) — they must use the exact same text or
// banners would stack up across restarts.
const SESSION_BREAK_TEXT = "session restored · shell restarted";
const SESSION_BREAK_LINE = `\r\n\x1b[2m──────── ${SESSION_BREAK_TEXT} ────────\x1b[0m\r\n`;

// ---- Which agents can this machine launch? ---------------------------------
// The add menu offers a row per agent, but only for agents actually installed:
// a "Codex" row on a machine without codex just opens a tab printing "command
// not found". The backend probes the LOGIN shell's PATH (agents.rs), which is
// the same PATH a spawned terminal gets.
//
// Held as a plain array refreshed in the background, so building the menu stays
// synchronous. It starts with BOTH agents so the very first menu — opened before
// the first probe answers — is never emptier than the old fixed one; the probe
// then narrows it. Refreshed on every menu open, so installing an agent while
// the app runs shows up on the next-but-one open without a restart.
let installedAgents = ["claude", "codex"];

/// Smallest share of a split node either child may be dragged to. Below roughly
/// this, an xterm has too few columns to be readable and its fit math starts
/// proposing degenerate sizes.
const MIN_SPLIT_RATIO = 0.15;

/// Most leaf panes one group may hold (card 45).
///
/// Every visible pane keeps its own WebGL context for its active tab, and WebKit
/// caps live contexts at roughly 16 across the whole webview — past the cap it
/// silently kills the OLDEST, permanently downgrading that terminal to the slow
/// DOM renderer. Six panes per group leaves room for the other groups (chat, the
/// command drawers) to keep theirs, and is already more panes than a terminal
/// area this size can show usefully.
const MAX_PANES = 6;

/// Thickness of the drag bar between two sibling panes, px. Kept in JS because
/// the flex sizing has to subtract it to keep the pair filling the split
/// exactly; the matching `.tg-sash` rule in styles.css uses the same number.
const SASH_SIZE = 6;

/// How long the "you hit a limit" notice stays on screen, ms.
const NOTICE_MS = 2600;

function refreshInstalledAgents() {
  invoke("available_agents")
    .then((list) => {
      if (Array.isArray(list)) installedAgents = list;
    })
    .catch(() => {}); // keep the last known list
}
refreshInstalledAgents();

function makeTerminal(s) {
  const term = new Terminal({
    fontFamily: s.fontFamily,
    fontSize: s.fontSize,
    fontWeight: s.fontWeight,
    lineHeight: s.lineHeight,
    letterSpacing: s.letterSpacing,
    cursorBlink: true,
    theme: s.theme,
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
  // Command-block overlay (spike): a UI layer drawn over the grid, anchored to
  // the shell's OSC 133 marks. Registers one OSC handler and nothing else — a
  // terminal whose shell emits no marks never draws anything. See termoverlay.js.
  attachBlockOverlay(term);
  return term;
}

// Attach the WebGL renderer to an already-opened terminal and return the addon
// (or null when WebGL is unavailable — xterm then stays on the DOM renderer).
// On GPU context loss the addon disposes itself and `onLost` clears the owner's
// handle, so the NEXT activation attaches a fresh context instead of leaving
// the terminal on the slow DOM renderer forever.
function attachWebgl(term, onLost) {
  try {
    const addon = new WebglAddon.WebglAddon();
    addon.onContextLoss(() => {
      addon.dispose();
      onLost?.();
    });
    term.loadAddon(addon);
    return addon;
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn("[octiq] WebGL renderer unavailable, using DOM renderer:", err);
    return null;
  }
}

// ---- File-path links --------------------------------------------------------
// Paths printed in terminal output (by agents, builds, anything) become
// Cmd+click links (Ctrl+click off macOS) that open the file with the OS default
// app — Preview for an image, the editor for code, Finder for a folder. A
// candidate only becomes a link when the backend confirms it exists on disk
// (resolve_path), so prose that merely looks like a path ("and/or", URL tails)
// never underlines. Relative paths resolve against the tab's SPAWN cwd.
// ponytail: spawn cwd, not the shell's live cwd after a `cd` — read the
// foreground process cwd if that ever matters.

// Rooted (/, ~/, ./, ../) or bare path shapes; segments stop at whitespace,
// quotes, brackets and `:`, so `src/foo.js:12` links just the file part.
const PATH_RE = /(?:~\/|\.{1,2}\/|\/)?[\w.@+%~-]+(?:\/[\w.@+%-]+)*/g;

// PATH_RE matches every bare word; only these shapes earn an existence check:
// rooted, contains a slash, or a lone filename with an extension.
function isPathCandidate(s) {
  return s.includes("/") || s === "~" || /\.[A-Za-z][A-Za-z0-9]{0,7}$/.test(s);
}

// Cap the existence-check IPCs per hovered line so a pathological line (e.g. a
// minified dump full of slashes) cannot queue dozens of round-trips.
const MAX_LINKS_PER_LINE = 8;

/** Stitch the wrapped-line group containing 1-based buffer row `y` into one
 *  string. Rows before the last are kept UNTRIMMED so char index i maps back to
 *  cell (i % cols, i / cols) — exact for ASCII paths (wide CJK glyphs would
 *  shift the underline a little, never the opened path). */
function wrappedLineText(term, y) {
  const buf = term.buffer.active;
  let start = y - 1;
  while (start > 0 && buf.getLine(start)?.isWrapped) start--;
  let end = y - 1;
  while (end + 1 < buf.length && buf.getLine(end + 1)?.isWrapped) end++;
  let text = "";
  for (let i = start; i <= end; i++) {
    text += buf.getLine(i)?.translateToString(i === end) ?? "";
  }
  return { text, startLine: start };
}

/** Find the real file paths in the wrapped-line group at row `y` and return
 *  them as xterm link objects, or undefined when the line has none. */
async function detectFileLinks(term, cwd, y) {
  const { text, startLine } = wrappedLineText(term, y);
  const cols = term.cols;
  const cell = (idx) => ({
    x: (idx % cols) + 1,
    y: startLine + Math.floor(idx / cols) + 1,
  });
  // Collect the candidates first, then existence-check them all in ONE IPC
  // (resolve_paths). Awaiting a round-trip per candidate serialized up to
  // MAX_LINKS_PER_LINE invokes on every hovered line.
  const candidates = [];
  PATH_RE.lastIndex = 0;
  let m;
  while ((m = PATH_RE.exec(text)) !== null && candidates.length < MAX_LINKS_PER_LINE) {
    // Drop sentence punctuation stuck to the tail ("saved to /tmp/x.png.").
    const raw = m[0].replace(/[.,;:!?'")\]]+$/, "");
    if (raw.length < 3 || !isPathCandidate(raw)) continue;
    candidates.push({ raw, index: m.index });
  }
  if (!candidates.length) return undefined;
  const resolved = await invoke("resolve_paths", {
    paths: candidates.map((c) => c.raw),
    cwd,
  }).catch(() => null);
  if (!resolved) return undefined;
  const links = [];
  candidates.forEach(({ raw, index }, i) => {
    const target = resolved[i];
    if (!target) return;
    links.push({
      text: raw,
      range: { start: cell(index), end: cell(index + raw.length - 1) },
      decorations: { underline: true, pointerCursor: true },
      activate(ev) {
        // Cmd (mac) / Ctrl (elsewhere) + click — the terminal-link convention.
        // A plain click stays a click (focus, TUI mouse) and never opens files.
        if (!ev.metaKey && !ev.ctrlKey) return;
        invoke("plugin:opener|open_path", { path: target, with: null }).catch(() => {});
      },
    });
  });
  return links.length ? links : undefined;
}

/** Register the file-path link provider on a terminal. `cwd` (the tab's spawn
 *  dir, possibly "") anchors relative paths. Disposed with the terminal. */
function attachFileLinks(term, cwd) {
  term.registerLinkProvider({
    provideLinks(y, callback) {
      detectFileLinks(term, cwd, y).then(callback, () => callback(undefined));
    },
  });
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

/** Every live terminal's pty id, across all groups (project, chat, command).
 *  "Live" = the tab exists and its PTY is open; a hidden group's terminals are
 *  still live. working.js counts these per project for the sidebar badge. */
export function terminalIds() {
  return [...idToEntry.keys()];
}

/** Fire "tg-terminals-change" so the sidebar terminal-count badge recounts.
 *  Called on every open/close — the only two moments the live set changes. */
function emitTerminalsChange() {
  window.dispatchEvent(new CustomEvent("tg-terminals-change"));
}

// Every live group, keyed by its idPrefix (a project id, "chat", "cmd:<id>").
// idToEntry can only answer "which group owns this PTY", so it cannot find the
// group of a project that has no terminal open yet. The sidebar terminal tree
// (termtree.js) needs exactly that — a project row must be able to open its
// first terminal — so groups register themselves here.
const groupsByPrefix = new Map();

/** Fire "tg-tabs-change": a group's TABS changed in a way the sidebar tree
 *  mirrors — opened, closed, activated, renamed, moved to another pane, or its
 *  notification choice flipped. Separate from "tg-terminals-change" (open/close
 *  only), because the tree also repaints on the quieter changes. */
function emitTabsChange() {
  window.dispatchEvent(new CustomEvent("tg-tabs-change"));
}

/** Whether a group exists for this id prefix (i.e. the project has been opened
 *  at least once this session, so it owns a terminal group). */
export function hasGroup(prefix) {
  return groupsByPrefix.has(prefix);
}

/** One group's tabs, in pane-tree order, as plain data for the sidebar tree.
 *  Empty when the group does not exist yet. Everything the tab strip used to
 *  paint on a tab is in here, so the sidebar row can carry the same marks. */
export function groupTabs(prefix) {
  const group = groupsByPrefix.get(prefix);
  if (!group) return [];
  const focused = group.focusedId();
  const shown = new Set(group._shownIds());
  return [...group.tabs].map(([id, e]) => ({
    id,
    title: e.title,
    // A content tab (an editor, no PTY) has no terminal-only state.
    content: !e.term,
    active: id === focused,
    shown: shown.has(id),
    attention: attention.has(id),
    working: working.has(id),
    activity: activityTabs.has(id),
    agent: agentTabs.has(id),
    notify: e.notify ?? null,
    // Which half of a split it lives in — the tree groups its rows by pane so a
    // split project reads the way it looks on screen.
    paneId: e.paneId,
  }));
}

/** How many panes the group is split into (1 when it is not split). */
export function groupPaneCount(prefix) {
  return groupsByPrefix.get(prefix)?._leaves().length ?? 0;
}

/** The tab a group's keyboard is in, as plain data, or null when the group has
 *  no terminal. The composer reads it to decide whether the terminal in front
 *  of the user already runs the agent it is about to send to.
 *
 *  `startCmd` is what the tab was LAUNCHED with; `firstCmd` the first command
 *  typed into it — a tab that started as a plain shell and had `claude` typed
 *  into it is running an agent just as much as one launched with it. */
export function activeTabInfo(prefix) {
  const group = groupsByPrefix.get(prefix);
  const id = group?.focusedId();
  if (!id) return null;
  const e = group.tabs.get(id);
  if (!e) return null;
  return {
    id,
    title: e.title,
    content: !e.term,
    startCmd: e.startCmd || "",
    firstCmd: e.firstCmd || "",
    agent: agentTabs.has(id),
  };
}

/** How many tabs a group holds (0 when it does not exist yet). */
export function groupTabCount(prefix) {
  return groupsByPrefix.get(prefix)?.tabs.size ?? 0;
}

/** The agent binaries this machine can actually launch ("claude", "codex"),
 *  from the backend probe. A copy, so a caller cannot edit the live list. */
export function installedAgentList() {
  return [...installedAgents];
}

/** Close one tab by id (the sidebar row's × button). */
export function closeTab(id) {
  groupOfTab(id)?.closeTerminal(id);
}

/** Rename one tab. Pins the name (`titleManual`), exactly as the old in-strip
 *  rename did, so auto-titling leaves it alone, and persists it. */
export function renameTab(id, title) {
  const group = groupOfTab(id);
  const entry = group?.tabs.get(id);
  const next = (title || "").trim();
  if (!entry || !next || next === entry.title) return;
  entry.title = next;
  entry.labelEl.textContent = next;
  entry.titleManual = true;
  group.onLayoutChange?.();
  emitTabsChange();
}

/** Split the pane this tab lives in ("row" = beside, "col" = below). */
export function splitTab(id, dir) {
  groupOfTab(id)?._splitWith(id, dir);
}

/** Merge this tab's pane back into its sibling. Its tabs move across (nothing
 *  is closed). No-op for a pane with no sibling. */
export function closePaneOf(id) {
  const group = groupOfTab(id);
  const leaf = group?._leafOf(id);
  if (leaf?.parent) group._closeSplit(leaf.id);
}

/** Whether this tab's pane can be merged back (it has a sibling). */
export function canClosePaneOf(id) {
  return !!groupOfTab(id)?._leafOf(id)?.parent;
}

/** This tab's own notification choice: true / false / null (follow Settings). */
export function tabNotify(id) {
  return groupOfTab(id)?.tabs.get(id)?.notify ?? null;
}

/** Set this tab's notification choice (see _setNotify). */
export function setTabNotify(id, choice) {
  groupOfTab(id)?._setNotify(id, choice);
  emitTabsChange();
}

/** Whether the GLOBAL notification switch is on — the sidebar menu says what
 *  "follow the setting" currently means, the way the old tab menu did. */
export function notificationsMasterOn() {
  return masterOn;
}

/** Open the group's "+" menu (Terminal / Claude / Codex) under `btn`. Returns
 *  false when the group does not exist yet, so the caller can open the project
 *  first and try again. */
export function openAddMenu(prefix, btn) {
  const group = groupsByPrefix.get(prefix);
  if (!group) return false;
  group._toggleAddMenu(btn);
  return true;
}

/** The group a tab id belongs to. idToEntry covers PTY tabs; a content tab has
 *  no PTY, so fall back to a scan of the groups (there are only a handful). */
function groupOfTab(id) {
  const known = entryFor(id)?.group;
  if (known) return known;
  for (const group of groupsByPrefix.values()) {
    if (group.tabs.has(id)) return group;
  }
  return null;
}

// Subscribers that want the latest non-empty OUTPUT line of a terminal (e.g.
// commands.js shows it on the footer). Each is `{ fn, idPrefix }` and is called
// fn(id, line) only for terminals whose id starts with its prefix.
const lineSubscribers = new Set();

/**
 * Subscribe to the latest output line of a terminal. Returns an unsubscribe
 * function. Used by the footer command-status line.
 *
 * `idPrefix` narrows the subscription to one namespace of terminal ids (e.g.
 * "cmd:"). It is not a convenience — extracting a line means `stripAnsi()` over
 * the whole chunk, two regex passes across up to 64KB. The single subscriber
 * this app has only ever wanted `cmd:` terminals, yet that cost was being paid
 * for EVERY chunk of EVERY terminal, then thrown away. An empty prefix means
 * "every terminal", and pays accordingly.
 */
export function onTerminalLine(fn, idPrefix = "") {
  const sub = { fn, idPrefix };
  lineSubscribers.add(sub);
  return () => lineSubscribers.delete(sub);
}

/** Whether any subscriber wants lines from this terminal. Checked BEFORE the
 *  chunk is stripped, so an unwatched terminal costs one string compare. */
function anyLineSubscriberWants(id) {
  for (const sub of lineSubscribers) {
    if (!sub.idPrefix || id.startsWith(sub.idPrefix)) return true;
  }
  return false;
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

// Longest typed line the input tracker reconstructs before it stops appending.
// A bound, not a limit on what reaches the shell: every byte is still written to
// the PTY. This only caps the string we keep for the tab title / "last sent" bar.
const MAX_INPUT_LINE_LEN = 256;

// Scrollback lines serialized on a CLEAN QUIT (flushAll). Generous — this runs
// once, and it is what the user gets back when the app reopens.
const FULL_SCROLLBACK_LINES = 2000;

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
      if (state.buf.length < MAX_INPUT_LINE_LEN) state.buf += data[i]; // Printable.
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
    // The two opt-in monitors (card 15): mark a tab the user is not looking at,
    // and re-arm its silence timer. Both no-op when their setting is off.
    noteActivity(id);
  }
  // Only strip + split the chunk when a subscriber actually wants this
  // terminal's lines. See onTerminalLine.
  if (entry && anyLineSubscriberWants(id)) {
    const line = lastLine(chunk);
    if (line) {
      for (const sub of lineSubscribers) {
        if (!sub.idPrefix || id.startsWith(sub.idPrefix)) sub.fn(id, line);
      }
    }
  }
});

// A HIDDEN terminal printed something (card 16). The bytes stay in the
// backend's ring — nothing is written to xterm and nothing is parsed. All that
// crosses is this ping, so the output-driven UI state still advances: the
// working dot, the per-project busy count, the activity mark, and the silence
// monitor's timer. Without it, every agent in a background project would look
// idle the instant you switched away.
listen("pty-hidden-output", (event) => {
  const { id } = event.payload;
  if (!idToEntry.has(id)) return;
  noteOutput(id);
  noteActivity(id);
});

// A hidden terminal was revealed (card 16): write back everything it printed
// while off screen, in one go. `trimmed` means the ring overflowed and the
// oldest output was dropped — say so, rather than silently showing a gap.
//
// The terminal is NOT marked as having produced output here: this is old text
// being replayed, not the shell speaking now, and `pty-hidden-output` already
// advanced the timers while it was buffering.
listen("pty-restore", (event) => {
  const { id, data, trimmed } = event.payload;
  const entry = idToEntry.get(id);
  if (!entry) return;
  if (trimmed) {
    entry.term.write("\r\n\x1b[2m[octiq: output trimmed]\x1b[0m\r\n");
  }
  if (data) entry.term.write(data);
  // The xterm buffer changed, so the next scrollback flush must save it.
  entry.group.onOutput?.(id);
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

/** Whether a pty id is ON SCREEN in a currently-VISIBLE group — i.e. a terminal
 *  the user is looking at right now. alerts.js uses this to skip badging a
 *  terminal already in front of the user (the agent's prompt is right there),
 *  while still badging every other / hidden terminal. With a split, BOTH halves
 *  are in front, so both are skipped. */
export function isActiveVisible(id) {
  const entry = idToEntry.get(id);
  return !!entry && entry.group.isShown(id) && entry.group.visible();
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
  if (!notificationsOn(id)) return; // this terminal is not watched (card 43)
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
 * Clear a terminal's attention badge. Removes it from the set and un-paints the
 * tab. Safe to call when the id is already clear.
 *
 * There is nothing to tell the backend: attention lives entirely here. This used
 * to invoke `pty_clear_attention`, which lowered a per-session flag no code ever
 * read. Both are gone (card 22).
 */
function clearAttention(id) {
  if (!attention.has(id)) return;
  attention.delete(id);
  entryFor(id)?.group._paintAttention(id, false);
  emitAttentionChange();
}

// ---- Who is watched (card 43) ----------------------------------------------
// "Watching" a terminal covers everything the app does to report its state: the
// working dot, the activity mark, the silence alert, the attention badge, the
// banner entry and the OS notification — plus the two backend polls and the
// backend's OSC attention scan that feed them.
//
// Two levels decide it, and the terminal's own choice wins:
//
//   * the SETTINGS switch (`statusMonitoring`) is the default for every
//     terminal, and
//   * each terminal may OVERRIDE it from its tab's right-click menu: on, off,
//     or follow the setting (the default).
//
// So a terminal can be watched while the setting is off, and silenced while the
// setting is on. With the setting off and no terminal overriding it to on,
// nothing runs at all — the app stops watching, not just stops telling, and a
// terminal then costs nothing beyond drawing its output.
let masterOn = true;

// Ids of terminals explicitly set to ON, which is what keeps the machinery
// running while the settings switch is off. A Set (rather than a scan of every
// tab) because `monitoringActive` is asked on the per-chunk output path.
const forcedOn = new Set();

/** True when ANYTHING is being watched — the settings switch, or at least one
 *  terminal overriding it to on. The polls, the ticks and the backend scan all
 *  hang off this. */
function monitoringActive() {
  return masterOn || forcedOn.size > 0;
}

/** Whether THIS terminal is watched: its own override when it has one, else the
 *  settings switch. Exported because alerts.js asks before raising a badge or
 *  an OS notification, so an alert arriving from the backend is judged by the
 *  same rule as one raised here. An unknown id (closed terminal) follows the
 *  switch. */
export function notificationsOn(id) {
  const override = entryFor(id)?.notify;
  return override == null ? masterOn : override === true;
}

/** Drop everything one terminal has already raised. Called when it stops being
 *  watched, so a badge from a second ago cannot sit there with nothing left
 *  running to clear it. */
function silenceTerminal(id) {
  clearAttention(id);
  clearActivity(id);
  silenceArmed.delete(id);
  // Through setAgentTab so the idle-agent badge recounts without this terminal.
  setAgentTab(id, false);
  if (setWorking(id, false)) emitWorkingChange();
}

/** Bring the world in line with the current switches: clear every indicator on
 *  terminals that are no longer watched, and turn the backend's OSC scan on or
 *  off. Called after any change to the setting or to a terminal's override. */
function syncMonitoring() {
  for (const id of [...attention, ...working, ...activityTabs, ...silenceArmed]) {
    if (!notificationsOn(id)) silenceTerminal(id);
  }
  if (!monitoringActive()) {
    // Nothing is watched: drop the tracked sets too, so no stale membership
    // survives to be acted on if watching is turned back on later.
    agentTabs.clear();
    foregroundAgents = new Set();
    window.dispatchEvent(new CustomEvent("tg-agents-change"));
  }
  emitAttentionChange();
  emitWorkingChange();
  // The backend scans PTY output for OSC attention sequences on every reader
  // thread. Stop that too, so "nothing is watched" really is off all the way
  // down. It is process-wide, so it follows `monitoringActive`, not one tab.
  invoke("pty_set_status_scan", { enabled: monitoringActive() }).catch(() => {});
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

// id -> Set<fn> of one-shot callbacks fired when a terminal produces its FIRST
// PTY output. Restored scrollback is written straight into the term (not via the
// pty-output event), so the first event is the live shell/agent coming alive —
// project.js uses this to mark an agent tab "resumed" once claude/codex prints
// after a `--resume`.
const firstOutputWaiters = new Map();

/** Run `fn` once when terminal `id` next emits output; if it already has, run it
 *  now. One-shot — the waiter is dropped after firing. */
export function onceTerminalOutput(id, fn) {
  if (lastOutputAt.has(id)) {
    fn();
    return;
  }
  let s = firstOutputWaiters.get(id);
  if (!s) firstOutputWaiters.set(id, (s = new Set()));
  s.add(fn);
}

/** The pty ids whose agent is currently working, in insertion order. */
export function workingList() {
  return [...working];
}

/** A terminal's current tab title, or "" when the id is unknown (its terminal
 *  was closed, or the agent runs outside the app). The Agents screen labels each
 *  agent process with this so a row reads "auth refactor", not "proj-7:2". */
export function terminalTitle(id) {
  return entryFor(id)?.group.tabs.get(id)?.title || "";
}

// `terminalSnapshot()` used to live here: a full snapshot of every live terminal
// for an "Agent World" view that was never built. Nothing imported it. Removed
// in card 26 — the shape is in git history if the view ever lands.

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
  if (!notificationsOn(id)) return false; // not watched (card 43)
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
  const first = !lastOutputAt.has(id);
  lastOutputAt.set(id, performance.now());
  if (first) {
    const waiters = firstOutputWaiters.get(id);
    if (waiters) {
      firstOutputWaiters.delete(id);
      for (const fn of waiters) {
        try {
          fn();
        } catch (_) {
          /* a progress callback must never break output routing */
        }
      }
    }
  }
  // The stamp and the first-output waiters above are NOT monitoring — the
  // agent-resume progress mark rides on them — but the working dot is.
  if (!notificationsOn(id)) return;
  if (foregroundAgents.has(id) && !attention.has(id)) {
    if (setWorking(id, true)) emitWorkingChange();
  }
}

/** Recompute the working flag for the ids that could change — those already
 *  working plus the current foreground agents — and emit once if anything moved.
 *  This is what turns a dot OFF after its tab goes silent (WORKING_IDLE_MS),
 *  flips to waiting, or closes; noteOutput turns dots ON. */
function refreshWorking() {
  if (!monitoringActive()) return;
  // Nothing can be working when there are no agent tabs and no lit dots, so skip
  // the per-tick Set build entirely. This is the common idle case (a 300ms timer
  // that would otherwise wake forever doing nothing).
  if (foregroundAgents.size === 0 && working.size === 0) return;
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
  if (!monitoringActive()) return; // nothing watched: no per-PTY foreground read
  // No live terminals: drop any stale snapshot and skip the IPC entirely (e.g.
  // while the user sits on Dashboard/Settings with no project terminals open).
  if (idToEntry.size === 0) {
    foregroundAgents = new Set();
    return;
  }
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

// Pause both polls while the window is fully hidden (minimized / occluded / on
// another Space). Nobody can see the working dots then, so a frozen poll costs
// nothing and saves a CPU wakeup plus an IPC + foreground syscall-per-PTY every
// tick. Gate on document.hidden, NOT focus: a visible-but-unfocused window (e.g.
// on a second monitor) must keep its dots live so the at-a-glance status works.
setInterval(() => {
  if (!document.hidden) pollForeground();
}, FOREGROUND_POLL_MS);
setInterval(() => {
  if (!document.hidden) refreshWorking();
  // The silence monitor keeps running while the window is hidden — that is
  // exactly when the user is away and most wants to hear that their agent
  // finished. It costs a Map lookup per armed tab, no IPC and no syscall.
  refreshSilence();
}, WORKING_TICK_MS);
// On re-show, poll once right away so the dots are fresh without waiting a tick.
document.addEventListener("visibilitychange", () => {
  if (!document.hidden) pollForeground();
});

// ---- Terminal monitors (card 15) ------------------------------------------
// tmux's two window flags, rebuilt here because an agent that emits no escape
// sequence can otherwise only reach the user through the manual octiq-notify
// hook:
//
//   ACTIVITY — a tab printed while the user was not looking at it. A subtle
//     per-tab dot, no banner and no OS notification: it answers "did anything
//     happen over there", not "come here now". Cleared by looking at the tab.
//     OFF by default (tmux-style opt-in): left on, every streaming background
//     tab would light up.
//   SILENCE  — an AGENT tab (Claude/Codex, confirmed by the backend session
//     map, not merely a non-shell foreground) printed and then went quiet for
//     `silenceSeconds`. That is almost always the agent finishing its turn and
//     waiting, so this one raises a real attention alert through alerts.js.
//     ALWAYS ON — "your agent finished and is waiting" is the one notification
//     this app exists to give, so it needs no setting. False positives are
//     bounded by the agent-tab gate: a quiet `vim` or a paused build never
//     fires because only backend-confirmed agent sessions arm the timer.
//
// Detection is frontend-side on purpose: this file already owns tab visibility
// and sees every chunk in the single pty-output listener, while the backend
// knows nothing about which tab is focused.

// The monitor settings, cached so the pty-output hot path never rebuilds the
// whole settings object per chunk. Refreshed on the settings-change event.
let monitors = { activity: false, silenceMs: 15000 };

function readMonitorSettings(s) {
  monitors = {
    activity: !!s.monitorActivity,
    silenceMs: s.silenceSeconds * 1000,
  };
  const on = s.statusMonitoring !== false;
  if (on === masterOn) return;
  masterOn = on;
  // Turning the switch off has to clean up after itself: the timers that would
  // have cleared a lit dot are about to stop running. Terminals overriding the
  // switch to on keep theirs.
  syncMonitoring();
}
// First read, at module load. `masterOn` is set BEFORE the call so the branch
// inside sees no change and skips syncMonitoring: the sets it walks are
// declared further down this file and are still in their temporal dead zone
// here — and nothing is painted yet, so there is nothing to clean up. The
// backend gets its one boot-time sync right after.
const initialSettings = getTerminalSettings();
masterOn = initialSettings.statusMonitoring !== false;
readMonitorSettings(initialSettings);
invoke("pty_set_status_scan", { enabled: masterOn }).catch(() => {});
window.addEventListener(TERMINAL_SETTINGS_CHANGED, (e) => readMonitorSettings(e.detail));

// Custom event carrying a monitor-raised alert to alerts.js, which owns every
// badge + OS notification in the app. detail = { id, source, title, body }.
export const MONITOR_ALERT = "tg-monitor-alert";

// Tabs currently flagged with the activity dot.
const activityTabs = new Set();

// Tabs the BACKEND confirmed are running an agent session (fed by the
// pollAgentTabs sweep below). The silence monitor arms only for these, so an
// idle `vim` or a paused build never looks like an agent waiting for you.
const agentTabs = new Set();

// Tabs whose next quiet stretch should fire exactly one silence alert. Output
// arms an id; firing (or the user attending to the tab) disarms it. Without
// this the alert would re-fire on every tick for as long as the tab stayed
// quiet — the tmux rule: one alert per silent stretch, not one per tick.
const silenceArmed = new Set();

/** True when the user is demonstrably looking at this exact terminal: it is the
 *  active tab of a visible group AND the window has focus. Matches the same
 *  test alerts.js applies to OSC attention. */
function userIsWatching(id) {
  return document.hasFocus() && isActiveVisible(id);
}

/** Record that a terminal produced output, for both monitors: mark it with the
 *  activity dot when it is not the tab on screen, and (re-)arm its silence
 *  timer. Called for both live output and the hidden-output ping.
 *
 *  Activity keys off the TAB only, never window focus — tmux's flag means "this
 *  window printed while it was not the current window". Bringing the app
 *  forward does not re-activate the tab, so a focus-sensitive test would leave
 *  a dot on the tab the user is already reading with nothing to clear it. */
function noteActivity(id) {
  if (!notificationsOn(id)) return; // this terminal is not watched (card 43)
  silenceArmed.add(id);
  if (!monitors.activity || activityTabs.has(id) || isActiveVisible(id)) return;
  activityTabs.add(id);
  entryFor(id)?.group._paintActivity(id, true);
  emitTabsChange(); // the sidebar tree carries the same activity mark
}

/** Drop a terminal's activity dot. No-op when it carries none. Called when the
 *  user activates/reveals the tab, and on close. */
function clearActivity(id) {
  if (!activityTabs.delete(id)) return;
  entryFor(id)?.group._paintActivity(id, false);
  emitTabsChange();
}

/** Fire the silence alert for any armed AGENT tab that has now been quiet for
 *  `silenceMs`. Runs on the working tick. A tab the user is already watching is
 *  disarmed silently — its prompt is right in front of them. */
function refreshSilence() {
  if (!monitoringActive() || silenceArmed.size === 0) return;
  const now = performance.now();
  for (const id of [...silenceArmed]) {
    if (!idToEntry.has(id)) {
      silenceArmed.delete(id); // terminal closed
      continue;
    }
    if (!agentTabs.has(id)) continue; // only a confirmed agent tab can go "quiet"
    if (!notificationsOn(id)) {
      silenceArmed.delete(id); // not watched: disarm, never alert
      continue;
    }
    const last = lastOutputAt.get(id);
    if (last === undefined || now - last < monitors.silenceMs) continue;
    silenceArmed.delete(id);
    if (userIsWatching(id)) continue;
    window.dispatchEvent(
      new CustomEvent(MONITOR_ALERT, {
        detail: {
          id,
          source: "quiet",
          title: entryFor(id)?.group.tabs.get(id)?.title || "Agent",
          body: "went quiet — it is probably waiting for you.",
        },
      }),
    );
  }
}

/** Set whether a terminal is running an agent session. Fires "tg-agents-change"
 *  on a real change so the idle badge (working.js) recounts. Internal: fed by
 *  pollAgentTabs below and the close path — no module imports it anymore. */
function setAgentTab(id, isAgent) {
  if (isAgent === agentTabs.has(id)) return;
  if (isAgent) agentTabs.add(id);
  else agentTabs.delete(id);
  window.dispatchEvent(new CustomEvent("tg-agents-change"));
}

/** Agent sessions that are open but NOT streaming right now — idle, probably
 *  waiting for you. working.js counts these on the Agents mode button; the
 *  Agents screen lists them with click-to-jump rows. */
export function idleAgentList() {
  return [...agentTabs].filter((id) => idToEntry.has(id) && !working.has(id));
}

// Feed agentTabs for EVERY live tab — project, chat, and command groups alike —
// with one batched `agent_tab_infos` call (the backend read is mtime-cached).
// This used to ride project.js's title poll, which (a) never saw chat tabs, so
// a Chat-mode agent could never raise a silence alert, and (b) stopped while
// the window was hidden — exactly when the user most needs the notification.
// So it runs on its own timer here, hidden or not.
const AGENT_TAB_POLL_MS = 5000;
async function pollAgentTabs() {
  if (!monitoringActive()) return; // nothing watched: no agent-session tracking
  // Only watched terminals are tracked, so an unwatched one can never arm the
  // silence alert or be counted as an idle agent.
  const jobs = [...idToEntry].filter(([id, e]) => e.persistKey && notificationsOn(id));
  if (jobs.length === 0) return;
  let infos;
  try {
    infos = await invoke("agent_tab_infos", { keys: jobs.map(([, e]) => e.persistKey) });
  } catch {
    return; // backend hiccup: keep the last known values, retry next tick
  }
  jobs.forEach(([id], i) => {
    // A dropped read (null info) leaves the last known value alone.
    if (infos[i]) setAgentTab(id, !!infos[i].isAgent);
  });
}
setInterval(pollAgentTabs, AGENT_TAB_POLL_MS);

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
  // groupOfTab, not idToEntry: a content tab (an editor) has no PTY, and the
  // sidebar tree jumps to those through here too.
  const group = groupOfTab(id);
  if (!group) return;
  const mode = group._mode();
  if (mode) switchToMode(mode);
  group.show();
  group.activate(id);
  // Focusing a terminal is the user acknowledging the alert: clear it.
  clearAttention(id);
}

/**
 * Jump to a terminal by its stable persistKey rather than its per-run pty id.
 * The key is the only handle an outside tool can hold (it outlives a restart and
 * the agent-session store is keyed by it), so the external focus channel — see
 * focus.rs — routes through here. Returns false if no live tab has that key.
 */
export function focusTerminalByKey(key) {
  for (const [id, entry] of idToEntry) {
    if (entry.persistKey === key) {
      focusTerminal(id);
      return true;
    }
  }
  return false;
}

// The backend resolved an outside "focus this agent" request (focus.rs) to a tab
// key. Jump there, exactly as clicking its attention chip would.
listen("focus-terminal", (event) => {
  focusTerminalByKey(event.payload);
});

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
    if (group.idPrefix === prefix && group.focusedId()) {
      // With a split, the half the user is typing in is the one that should
      // receive the text — not always the primary pane.
      const id = group.focusedId();
      invoke("pty_write", { id, data: submit ? `${text}\r` : text }).catch(() => {});
      group.show();
      group.activate(id);
      return true;
    }
  }
  return false;
}

/**
 * Write `text` into the terminal the user is looking at right now — the active
 * tab of whichever group is currently VISIBLE (one view shows at a time, so at
 * most one group qualifies). With `submit` true, also send Enter ("\r"). Brings
 * that tab to the front and focuses it. Returns true if a terminal received the
 * text, or false if no terminal is visible (e.g. the user is on Settings or has
 * no terminal open). Used by the screenshot vault to paste image paths into the
 * terminal the user just left.
 */
export function sendToActiveTerminal(text, submit = false) {
  for (const [id, { group }] of idToEntry) {
    if (group.focusedId() === id && group.visible()) {
      invoke("pty_write", { id, data: submit ? `${text}\r` : text }).catch(() => {});
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

// Apply a GLOBAL font setting change to every OPEN terminal live. Each group
// re-resolves its own effective font (its per-project override overlaid on the
// new global settings), so a global change updates non-overriding groups and
// leaves an overriding group on its own font. applyFontSettings writes the
// options and refits the active tab; hidden groups re-fit when next shown.
window.addEventListener(TERMINAL_SETTINGS_CHANGED, () => {
  const liveGroups = new Set([...idToEntry.values()].map((e) => e.group));
  for (const g of liveGroups) g.applyFontSettings();
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
 * With `quickSpawn: true` the "+" add button becomes a dropdown with Terminal /
 * Claude / Codex rows; the agent rows call the owner's `onQuickSpawn(agent)` hook
 * so the owner can open a new terminal and launch that agent (project mode uses
 * this). Without it, "+" just opens a plain terminal via `onAdd`.
 *
 * `fontOverride` is the owning project's per-project font override (the raw
 * workspace `font_override`), or null to use the global app font. It is resolved
 * per group so a project can carry its own terminal font (see setFontOverride).
 *
 * `floodControl` (card 16) lets the backend buffer a terminal's output while it
 * is off screen instead of streaming it. Leave it on for any group whose
 * terminals are only ever read by looking at them. Turn it OFF for a group whose
 * output is consumed while hidden — the command drawer is the one such case: its
 * terminals normally sit in a CLOSED modal and the footer's live "last line" is
 * the only view of them, so their text must keep arriving.
 *
 * `tabBar: false` drops each pane's tab strip from the DOM. The group still has
 * tabs — it just shows them somewhere else. Project groups use this: their tabs
 * are the rows under the project folder in the sidebar (termtree.js), which also
 * owns the "+", close, rename, split and notification actions the strip had.
 *
 * createTerminalGroup(mountEl, idPrefix,
 *   { showAdd, quickSpawn, fontOverride, floodControl, tabBar } = {})
 */
export function createTerminalGroup(
  mountEl,
  idPrefix,
  {
    showAdd = true,
    quickSpawn = false,
    fontOverride = null,
    floodControl = true,
    tabBar = true,
    lastSentBar = true,
  } = {},
) {
  return new TerminalGroup(mountEl, idPrefix, {
    showAdd,
    quickSpawn,
    fontOverride,
    floodControl,
    tabBar,
    lastSentBar,
  });
}

class TerminalGroup {
  constructor(
    mountEl,
    idPrefix,
    {
      showAdd = true,
      quickSpawn = false,
      fontOverride = null,
      floodControl = true,
      tabBar = true,
      lastSentBar = true,
    } = {},
  ) {
    this.idPrefix = idPrefix;
    // Whether the thin "last sent" bar shows under the panes (see below).
    this.lastSentBar = lastSentBar;
    // Whether each pane shows its own tab strip. Project groups turn it OFF:
    // their tabs are listed in the sidebar tree under the project folder
    // (termtree.js), which is the only tab UI they have. The strip elements are
    // still BUILT either way and every tab still gets its `tabEl` — they are
    // simply left out of the pane DOM — so all the code that paints a tab's
    // state, label or rename box keeps working untouched.
    this.tabBar = tabBar;
    // Whether this group's hidden terminals buffer their output in the backend
    // rather than streaming it (card 16). See createTerminalGroup.
    this.floodControl = floodControl;
    // This group's per-project font override (raw workspace font_override), or
    // null for the global app font. resolveTerminalSettings overlays it on the
    // global settings when building each terminal's font.
    this.fontOverride = fontOverride;
    this.seq = 0;
    // Monotonic counter for DEFAULT tab titles ("term N"). Never decremented,
    // so closing a tab and opening a new one cannot reuse a number (P4).
    this.titleSeq = 0;
    // ptyId -> { term, fitAddon, paneEl, tabEl, title, paneId }
    // (`activeId` is no longer a field: it is a getter over the active pane —
    // each leaf of the pane tree owns which of ITS tabs is on screen.)
    this.tabs = new Map();

    // ---- Pane tree (card 45) ----------------------------------------------
    // The group's area is a recursive tree of panes, the way VS Code arranges
    // editor groups. Two node shapes:
    //
    //   leaf   { type: "pane", id, tabIds: [], activeId, el, stripEl, tabsEl,
    //            addBtn, panesEl, parent }
    //   split  { type: "split", dir: "row" | "col", ratio, children: [a, b],
    //            el, sashEl, parent }
    //
    // A leaf owns its OWN tab strip and its own active tab, so every leaf shows
    // exactly one tab and the strip above it lists only that leaf's tabs. Splits
    // are binary with a single `ratio` (the share given to the first child); a
    // three-pane arrangement is a split whose child is another split, which is
    // what makes any VS Code layout expressible.
    //
    // `this.tabs` stays the ONE owner of tab entries (so idToEntry, the alert /
    // working monitors and persistence are untouched); the tree only decides
    // WHERE each tab is shown. Each entry carries `paneId` back to its leaf.
    this.paneSeq = 0;
    // paneId -> leaf node, for O(1) lookup from a tab's `paneId`.
    this.panes = new Map();
    // Defaults for the NEXT split (remembered across splits, see _saveSplitPrefs).
    this.splitDir = "row";
    this.splitRatio = 0.5;

    // Group DOM: the pane tree fills the group, with the "last sent" bar below.
    this.root = document.createElement("div");
    this.root.className = "tg";

    // Options the leaf builder needs — read by _makeLeaf for every pane, not
    // just the first, so a pane created by a split gets the same "+" behavior.
    this.showAdd = showAdd;
    this.quickSpawn = quickSpawn;

    // The "+" callback is set by the owner via onAdd; default is a no-op so the
    // primitive does not assume any cwd/startCmd policy.
    this.onAdd = null;
    // Quick-spawn callback (quickSpawn groups only): onQuickSpawn(agent) fires
    // with "claude" | "codex" when the user picks that row of the add menu.
    // The owner decides cwd + launch command.
    this.onQuickSpawn = null;
    // Optional owner hooks for persistence. onLayoutChange fires after a
    // structural change (new/close/rename); onOutput(ptyId) fires when a
    // terminal in this group produces output. Both default to no-op — only a
    // group whose owner persists state (project.js) sets them.
    this.onLayoutChange = null;
    this.onOutput = null;
    // The open add menu's popup element (quickSpawn groups only), or null when
    // closed. It is mounted on <body>, so hide()/dispose() must close it.
    this.addMenuEl = null;
    // The "+" button the open add menu belongs to (each leaf has its own), so
    // the popup is positioned under the one that was actually clicked.
    this.addMenuBtn = null;
    // The old right-aligned "Claude | Codex" strip control is gone; its actions
    // are now rows in the add menu (quickSpawn groups only).
    this.agentsEl = null;

    // The pane tree lives in here. It starts as a single leaf — the plain
    // one-strip-one-terminal-area look every group had before splitting existed.
    this.bodyEl = document.createElement("div");
    this.bodyEl.className = "tg-body";
    this.layout = this._makeLeaf();
    this.bodyEl.append(this.layout.el);
    // The pane the keyboard belongs to. Everything that means "the terminal the
    // user is typing into" reads it through focusedId().
    this.activePaneId = this.layout.id;

    // Transient "you hit a limit" notice (the pane cap). Positioned over the
    // tree, pointer-events:none, so it never blocks a click.
    this.noticeEl = document.createElement("div");
    this.noticeEl.className = "tg-notice";
    this.noticeEl.hidden = true;
    this.bodyEl.append(this.noticeEl);
    this._noticeTimer = null;

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

    // A group whose owner shows its own composer (project mode) leaves the bar
    // out: the composer at the bottom of the view already says what was sent,
    // and two stacked bars just eat terminal height. The element itself still
    // exists, so _renderLastSent and friends need no guard.
    if (this.lastSentBar) this.root.append(this.bodyEl, this.lastSentEl);
    else this.root.append(this.bodyEl);
    mountEl.append(this.root);
    // Findable by id prefix, so the sidebar tree can reach a project's group
    // (and its "+" menu) without holding a reference to it.
    groupsByPrefix.set(idPrefix, this);

    // Reuse the direction + sash position this group was last split with.
    this._loadSplitPrefs();
  }

  ids() {
    return [...this.tabs.keys()];
  }

  /** The tab the keyboard belongs to, for callers outside this file. It is the
   *  active tab of the ACTIVE pane, so with several panes on screen it names the
   *  one being typed into rather than an arbitrary visible tab. */
  get activeId() {
    return this.panes.get(this.activePaneId)?.activeId ?? null;
  }

  // ---- Pane tree: shape helpers -------------------------------------------

  /** Every leaf pane, left-to-right / top-to-bottom in tree order. */
  _leaves(node = this.layout, out = []) {
    if (!node) return out;
    if (node.type === "pane") out.push(node);
    else for (const child of node.children) this._leaves(child, out);
    return out;
  }

  /** The leaf a tab lives in, or null. */
  _leafOf(ptyId) {
    const paneId = this.tabs.get(ptyId)?.paneId;
    return (paneId && this.panes.get(paneId)) || null;
  }

  /** Every tab id in pane-tree order (each leaf's tabs, leaves in tree order).
   *  This is the order serialize() saves, so a restored layout comes back
   *  reading left-to-right the way it looked. */
  _orderedIds() {
    return this._leaves().flatMap((leaf) => leaf.tabIds);
  }

  /** First non-dragged tab in `tabsEl` whose horizontal midpoint sits right of
   *  `x`, or null to drop at the end. Drives the live reorder during a drag. */
  _tabAfterX(tabsEl, x) {
    for (const el of tabsEl.querySelectorAll(".tg-tab:not(.tg-tab-dragging)")) {
      const r = el.getBoundingClientRect();
      if (x < r.left + r.width / 2) return el;
    }
    return null;
  }

  /** Rebuild ONE leaf's tab order from its strip's DOM order after a drag, then
   *  re-sort the tabs Map into pane-tree order and persist. serialize() reads
   *  that order, so this is what makes a reorder stick across a restart. */
  _syncTabOrder(leaf) {
    // The pane may have been collapsed while the drag was in flight.
    if (!leaf || !this.panes.has(leaf.id)) return;
    const reordered = [];
    for (const el of leaf.tabsEl.children) {
      const id = el.dataset.ptyId;
      if (this.tabs.has(id)) reordered.push(id);
    }
    if (reordered.length !== leaf.tabIds.length) return; // DOM/model mismatch
    leaf.tabIds = reordered;
    this._resortTabs();
    this.onLayoutChange?.();
  }

  /** Re-key the tabs Map into pane-tree order. The Map is insertion-ordered and
   *  serialize()/ids() walk it, so the saved order follows what is on screen. */
  _resortTabs() {
    const sorted = new Map();
    for (const id of this._orderedIds()) {
      if (this.tabs.has(id)) sorted.set(id, this.tabs.get(id));
    }
    // Anything the tree lost track of keeps its entry rather than vanishing.
    for (const [id, entry] of this.tabs) if (!sorted.has(id)) sorted.set(id, entry);
    this.tabs = sorted;
  }

  /** Show a short-lived message over the pane area (the pane cap is the only
   *  caller today). There is no app-wide toast, and writing into a terminal's
   *  buffer would pollute its saved scrollback, so the notice lives here. */
  _flashNotice(text) {
    this.noticeEl.textContent = text;
    this.noticeEl.hidden = false;
    // Restart the fade if a second notice lands while the first is showing.
    this.noticeEl.classList.remove("tg-notice-show");
    void this.noticeEl.offsetWidth;
    this.noticeEl.classList.add("tg-notice-show");
    clearTimeout(this._noticeTimer);
    this._noticeTimer = setTimeout(() => {
      this.noticeEl.classList.remove("tg-notice-show");
      this.noticeEl.hidden = true;
    }, NOTICE_MS);
  }

  // ---- Pane tree: building ------------------------------------------------

  /**
   * Build one leaf pane: its own tab strip (tabs + "+") above its own panes
   * area. Every leaf is built here — the group's first pane and every pane a
   * split creates — so a new pane behaves exactly like the original one.
   *
   * The panes area keeps `position: relative` with absolutely-inset `.tg-pane`
   * children, because FitAddon measures the xterm element's PARENT border box:
   * the pane must stay the exact drawable rectangle. Splitting resizes the
   * leaf's box through flex, never the pane insets, so that stays true at any
   * depth of the tree.
   */
  _makeLeaf() {
    const id = `pane-${this.paneSeq++}`;

    const el = document.createElement("div");
    el.className = "tg-pane-group";
    el.dataset.paneId = id;

    const stripEl = document.createElement("div");
    stripEl.className = "tg-strip";

    const tabsEl = document.createElement("div");
    tabsEl.className = "tg-tabs";
    // Live tab reorder while dragging: slide the dragged tab to wherever the
    // pointer sits. Same-strip only here; moving a tab BETWEEN panes is card 46.
    // Live tab reorder while dragging: slide the dragged tab to wherever the
    // pointer sits — in THIS strip or any other pane's strip (card 46). Only the
    // element moves here; the model catches up on drop (see _wireTabDrag), which
    // is what lets the same handler serve reorder and cross-pane move.
    tabsEl.addEventListener("dragover", (e) => {
      const dragEl = this._dragEl;
      if (!dragEl) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = "move";
      const after = this._tabAfterX(tabsEl, e.clientX);
      if (after == null) tabsEl.append(dragEl);
      else if (after !== dragEl) tabsEl.insertBefore(dragEl, after);
    });
    // A strip drop is handled by dragend (the element is already in place);
    // this only stops the browser treating it as an unhandled drag.
    tabsEl.addEventListener("drop", (e) => {
      if (this._dragEl) e.preventDefault();
    });

    const addBtn = this.showAdd ? this._makeAddButton(id) : null;
    if (addBtn) stripEl.append(tabsEl, addBtn);
    else stripEl.append(tabsEl); // drawer groups (P5) have no add behavior

    const panesEl = document.createElement("div");
    panesEl.className = "tg-panes";

    // Drop target covering this pane's terminal area, shown only while a tab
    // drag is in flight (card 46). It sits INSIDE .tg-panes (which is
    // position:relative) so it never covers the tab strips — a strip drop is a
    // reorder/move and must stay reachable.
    const dropEl = document.createElement("div");
    dropEl.className = "tg-dropzones";
    const hintEl = document.createElement("div");
    hintEl.className = "tg-drop-hint";
    dropEl.append(hintEl);
    panesEl.append(dropEl);

    dropEl.addEventListener("dragover", (e) => {
      if (!this._dragEl) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = "move";
      const zone = this._zoneAt(dropEl, e.clientX, e.clientY);
      this._paintDropHint(hintEl, zone);
    });
    dropEl.addEventListener("dragleave", (e) => {
      // Only when the pointer really left this pane, not on a child crossing.
      if (e.relatedTarget && dropEl.contains(e.relatedTarget)) return;
      hintEl.classList.remove("tg-drop-hint-on");
    });
    dropEl.addEventListener("drop", (e) => {
      if (!this._dragId) return;
      e.preventDefault();
      const zone = this._zoneAt(dropEl, e.clientX, e.clientY);
      hintEl.classList.remove("tg-drop-hint-on");
      this._dropTabOnPane(this._dragId, id, zone);
    });

    // A group with no tab bar (project groups) keeps its strip DETACHED: every
    // tab still gets its element and every paint/rename path still writes to
    // it, but nothing of it is on screen — the sidebar tree is that group's tab
    // UI. Attaching only `panesEl` also gives the terminals the strip's height.
    if (this.tabBar) el.append(stripEl, panesEl);
    else el.append(panesEl);

    // Anything that puts a pointer or the keyboard inside this pane makes it the
    // active pane. `pointerdown` in the capture phase runs before a tab's own
    // click handler, so a click lands in the right pane first; `focusin` covers
    // focus arriving without a click (xterm's hidden textarea, tabbing).
    el.addEventListener("pointerdown", () => this._setActivePane(id), true);
    el.addEventListener("focusin", () => this._setActivePane(id));

    const leaf = {
      type: "pane",
      id,
      el,
      stripEl,
      tabsEl,
      addBtn,
      panesEl,
      // Drop target + its highlight, armed only during a tab drag (card 46).
      dropEl,
      hintEl,
      // Ordered tab ids shown in this leaf's strip.
      tabIds: [],
      // The one tab of this leaf that is on screen, or null when it has none.
      activeId: null,
      parent: null,
    };
    this.panes.set(id, leaf);
    // The sheet must paint in the TERMINAL's own background, not the chrome's
    // --bg-0: .tg-pane is inset 10px inside it, so any difference between the
    // two turns that gutter into a visible box framing the terminal.
    this._applyPanesBackground(null, leaf);
    return leaf;
  }

  // ---- Tab drag and drop (card 46) ----------------------------------------

  /**
   * Make one tab draggable. A drag can end three ways:
   *   - dropped on a strip (this pane's or another's) -> the element is already
   *     where the pointer left it, so dragend reads the DOM back into the model;
   *   - dropped on a pane body -> the pane's own drop handler ran first and has
   *     already moved the tab (dragend then finds nothing left to do);
   *   - cancelled -> the element may sit in another strip, and the same dragend
   *     path adopts it, which is the behaviour a user who dragged it there
   *     expects anyway.
   */
  _wireTabDrag(tabEl, tabId) {
    tabEl.draggable = true;
    tabEl.dataset.ptyId = tabId;
    tabEl.addEventListener("dragstart", (e) => {
      this._dragEl = tabEl;
      this._dragId = tabId;
      tabEl.classList.add("tg-tab-dragging");
      e.dataTransfer.effectAllowed = "move";
      e.dataTransfer.setData("text/plain", tabId); // Firefox won't drag without data.
      this._setDropZones(true);
    });
    tabEl.addEventListener("dragend", () => {
      tabEl.classList.remove("tg-tab-dragging");
      this._dragEl = null;
      this._dragId = null;
      this._setDropZones(false);

      const from = this._leafOf(tabId);
      // Which strip is the element sitting in now?
      const paneId = tabEl.closest(".tg-pane-group")?.dataset.paneId;
      const target = paneId ? this.panes.get(paneId) : null;
      if (target && from && target !== from) {
        // Cross-pane strip drop: the element is already at the position the user
        // chose, so take the index from the DOM and let the one mover reconcile
        // the model (_moveTabToPane re-inserts it in the same spot, a no-op).
        const index = [...target.tabsEl.children].indexOf(tabEl);
        this._moveTabToPane(tabId, target, index < 0 ? null : index);
        this._collapseIfEmpty(from);
        this._applyPanes();
        this._paintLastSent(this.focusedId());
        requestAnimationFrame(() => {
          this.refitActive();
          this._focusActive();
        });
      }
      this._syncTabOrder(this._leafOf(tabId));
    });
  }

  /** Arm or disarm every pane's drop target for the duration of a tab drag. */
  _setDropZones(on) {
    for (const leaf of this._leaves()) {
      leaf.dropEl.classList.toggle("tg-dropzones-on", on);
      if (!on) leaf.hintEl.classList.remove("tg-drop-hint-on");
    }
  }

  /**
   * Which of the five drop zones the pointer is in: "left" | "right" | "top" |
   * "bottom" | "center". The outer EDGE_BAND of each side splits the pane in
   * that direction; the middle moves the tab in. In a corner both bands match,
   * so the side whose edge is nearest wins.
   */
  _zoneAt(el, clientX, clientY) {
    const EDGE_BAND = 0.3;
    const r = el.getBoundingClientRect();
    if (r.width <= 0 || r.height <= 0) return "center";
    const x = (clientX - r.left) / r.width;
    const y = (clientY - r.top) / r.height;
    // Distance to each edge, as a fraction of the pane. Smallest wins.
    const near = [
      { zone: "left", d: x },
      { zone: "right", d: 1 - x },
      { zone: "top", d: y },
      { zone: "bottom", d: 1 - y },
    ]
      .filter((c) => c.d < EDGE_BAND)
      .sort((a, b) => a.d - b.d);
    return near[0]?.zone ?? "center";
  }

  /** Draw the highlight for the zone under the pointer. The rectangle shows the
   *  space the tab would take, so an edge zone previews the half it would split
   *  off and the centre previews the whole pane. */
  _paintDropHint(hintEl, zone) {
    const G = "10px"; // matches the .tg-pane inset, so the hint lines up with it
    const HALF = "calc(50% - 10px)";
    const s = hintEl.style;
    s.left = s.right = s.top = s.bottom = G;
    s.width = s.height = "";
    if (zone === "left") s.width = HALF;
    else if (zone === "right") {
      s.left = "auto";
      s.width = HALF;
    } else if (zone === "top") s.height = HALF;
    else if (zone === "bottom") {
      s.top = "auto";
      s.height = HALF;
    }
    hintEl.classList.add("tg-drop-hint-on");
  }

  /**
   * Finish a drop on a pane body. The centre zone moves the tab into that pane;
   * an edge zone splits the pane in that direction and puts the tab in the new
   * half. A source pane left with nothing collapses into its sibling.
   *
   * Past MAX_PANES an edge drop cannot split, so it falls back to a plain move
   * and says why — losing the tab entirely would be the worse answer.
   */
  _dropTabOnPane(tabId, paneId, zone) {
    const target = this.panes.get(paneId);
    const from = this._leafOf(tabId);
    if (!target || !from) return;
    // Dropping a pane's only tab back onto its own pane changes nothing.
    if (from === target && (zone === "center" || from.tabIds.length < 2)) {
      if (zone !== "center") {
        this._flashNotice("That pane has only this tab — nothing to split off");
      }
      return;
    }

    let landing = target;
    if (zone !== "center") {
      if (this._leaves().length >= MAX_PANES) {
        this._flashNotice(`${MAX_PANES}-pane limit reached — moved the tab instead`);
      } else {
        const dir = zone === "left" || zone === "right" ? "row" : "col";
        // "left"/"top" put the new pane BEFORE the one dropped on, so the tab
        // lands on the side the user aimed at.
        const before = zone === "left" || zone === "top";
        this.splitDir = dir;
        landing = this._makeLeaf();
        this._insertSibling(target, landing, dir, before);
      }
    }

    this._moveTabToPane(tabId, landing);
    this._collapseIfEmpty(from);
    this.activePaneId = landing.id;
    this._applyPanes();
    this._paintLastSent(this.focusedId());
    this._saveSplitPrefs();
    this.onLayoutChange?.();
    requestAnimationFrame(() => {
      this.refitActive();
      this._focusActive();
    });
  }

  /** Remove a pane that a move left with no tabs, giving its space back to its
   *  sibling. The root leaf is kept — an empty group still needs one strip. */
  _collapseIfEmpty(leaf) {
    if (!leaf || leaf.tabIds.length || !leaf.parent) return;
    const heir = this._firstLeafOf(leaf.parent.children.find((c) => c !== leaf));
    const wasActive = this.activePaneId === leaf.id;
    this._removePane(leaf);
    if (wasActive) this.activePaneId = heir?.id ?? this._leaves()[0]?.id;
  }

  /** The "+" control for one leaf's strip. A quickSpawn group gets the caret
   *  menu (Terminal / Claude / Codex); a plain group gets a bare "+". Either
   *  way the click first makes THAT pane active, so the new tab opens in the
   *  pane whose "+" was pressed rather than wherever the keyboard last was. */
  _makeAddButton(paneId) {
    const btn = document.createElement("button");
    btn.className = "tg-add";
    if (this.quickSpawn) {
      // A "+" with a caret that opens a Terminal / Claude / Codex dropdown.
      // The agent rows replace the old right-aligned "Claude | Codex" control,
      // so everything that opens a tab in this group lives in one menu.
      btn.classList.add("tg-add--menu");
      btn.title = "New terminal or agent";
      btn.setAttribute("aria-haspopup", "menu");
      btn.setAttribute("aria-expanded", "false");
      const plus = document.createElement("span");
      plus.className = "tg-add-plus";
      plus.textContent = "+";
      const caret = document.createElement("span");
      caret.className = "tg-add-caret";
      caret.setAttribute("aria-hidden", "true");
      caret.textContent = "▾";
      btn.append(plus, caret);
      btn.addEventListener("click", (e) => {
        e.stopPropagation();
        this._setActivePane(paneId);
        this._toggleAddMenu(btn);
      });
    } else {
      // Plain groups (chat): "+" opens a new terminal directly, no menu.
      btn.title = "New terminal";
      btn.textContent = "+";
      btn.addEventListener("click", () => {
        this._setActivePane(paneId);
        this.onAdd?.();
      });
    }
    return btn;
  }

  /** The leaf new tabs open in: the active pane, falling back to the first leaf
   *  if the active one has gone (it cannot normally). */
  _activeLeaf() {
    return this.panes.get(this.activePaneId) || this._leaves()[0] || null;
  }

  /** Move the keyboard (and the "last sent" bar and the strong tab highlight) to
   *  another pane. No-op when it is already the active one, so the pointerdown /
   *  focusin handlers can fire freely. */
  _setActivePane(paneId) {
    if (!this.panes.has(paneId) || this.activePaneId === paneId) return;
    this.activePaneId = paneId;
    this._applyPanes();
    this._paintLastSent(this.focusedId());
  }

  // ---- Pane tree: splitting and collapsing --------------------------------

  /**
   * Wrap `leaf` in a new split node and put `sibling` beside it, cutting the
   * space `dir` ("row" = side by side, "col" = stacked). The new pane takes the
   * far half, so a "split right" appears to the right of what you were looking
   * at; `before` puts it in the near half instead, which is what a drop on a
   * pane's left or top edge means (card 46).
   */
  _insertSibling(leaf, sibling, dir, before = false) {
    const parent = leaf.parent;
    const el = document.createElement("div");
    el.className = `tg-split tg-split-${dir === "col" ? "col" : "row"}`;
    const sashEl = document.createElement("div");
    sashEl.className = `tg-sash tg-sash-${dir === "col" ? "col" : "row"}`;
    sashEl.setAttribute("role", "separator");
    sashEl.title = "Drag to resize";

    const split = {
      type: "split",
      dir: dir === "col" ? "col" : "row",
      ratio: this.splitRatio,
      children: before ? [sibling, leaf] : [leaf, sibling],
      el,
      sashEl,
      parent,
    };
    sashEl.addEventListener("pointerdown", (e) => this._beginSashDrag(split, e));

    // Splice the new node into the tree in the leaf's place...
    if (!parent) this.layout = split;
    else parent.children[parent.children.indexOf(leaf)] = split;
    leaf.parent = split;
    sibling.parent = split;

    // ...and mirror that in the DOM: the split element takes the leaf's spot,
    // then adopts the leaf, the sash and the new pane. The leaf is detached and
    // re-inserted on the way, so its terminals give up their GPU contexts first.
    this._dropWebglIn(leaf);
    leaf.el.replaceWith(el);
    if (before) el.append(sibling.el, sashEl, leaf.el);
    else el.append(leaf.el, sashEl, sibling.el);
    this._applyRatios();
    return split;
  }

  /**
   * Take `leaf` out of the tree and give its space to its sibling. The sibling
   * subtree replaces the whole split node, which is what makes closing a pane
   * feel like the space "falling back" into the neighbour.
   *
   * The root leaf is never removed: a group with no terminals still needs one
   * strip to put the next "+" in.
   */
  _removePane(leaf) {
    const split = leaf.parent;
    if (!split) return false; // the root leaf stays, even when empty
    const sibling = split.children.find((c) => c !== leaf);
    const grand = split.parent;

    if (!grand) this.layout = sibling;
    else grand.children[grand.children.indexOf(split)] = sibling;
    sibling.parent = grand;

    // The sibling element moves up into the split's place; the detached split
    // element takes the removed leaf and the sash with it. The sibling subtree
    // is reparented, so its terminals give up their GPU contexts first.
    this._dropWebglIn(sibling);
    split.el.replaceWith(sibling.el);
    split.el.remove();
    // Drop the size the sibling had INSIDE the removed split. _applyRatios gives
    // it a fresh one when its new parent is a split; when it has become the root
    // it must fall back to the stylesheet's "fill the group" instead.
    sibling.el.style.flex = "";
    this.panes.delete(leaf.id);
    this._applyRatios();
    return true;
  }

  /** Write every split node's ratio into its children's flex sizing. One place
   *  owns the geometry, so a resize, a new split and a collapse all lay out the
   *  same way. */
  _applyRatios(node = this.layout) {
    if (!node || node.type === "pane") return;
    const [a, b] = node.children;
    const pct = Math.round(node.ratio * 1000) / 10;
    // The first child is sized exactly; the second takes what is left, so the
    // pair always fills the split with no sub-pixel gap between them.
    a.el.style.flex = `0 0 calc(${pct}% - ${SASH_SIZE / 2}px)`;
    b.el.style.flex = "1 1 0";
    this._applyRatios(a);
    this._applyRatios(b);
  }

  count() {
    return this.tabs.size;
  }

  /**
   * Build the add-menu popup: Terminal / Claude / Codex rows. "Terminal" opens a
   * plain shell via onAdd; the agent rows forward a fixed name to onQuickSpawn —
   * the names are hard-coded here (never user-supplied), so nothing is
   * interpolated into a shell command downstream. The popup is appended to
   * <body> (not the strip) so the strip's overflow can never clip it.
   */
  _buildAddMenu() {
    const menu = document.createElement("div");
    menu.className = "tg-add-menu";
    menu.setAttribute("role", "menu");

    const agentRows = [
      { agent: "claude", label: "Claude", hint: "Claude Code agent" },
      { agent: "codex", label: "Codex", hint: "Codex agent" },
    ];
    const rows = [
      { label: "Terminal", hint: "Plain shell", run: () => this.onAdd?.() },
      // Only agents this machine can actually launch (see installedAgents).
      ...agentRows
        .filter((r) => installedAgents.includes(r.agent))
        .map((r) => ({
          label: r.label,
          hint: r.hint,
          run: () => this.onQuickSpawn?.(r.agent),
        })),
    ];
    for (const r of rows) {
      const item = document.createElement("button");
      item.className = "tg-add-item";
      item.setAttribute("role", "menuitem");
      const label = document.createElement("span");
      label.className = "tg-add-item-label";
      label.textContent = r.label;
      const hint = document.createElement("span");
      hint.className = "tg-add-item-hint";
      hint.textContent = r.hint;
      item.append(label, hint);
      item.addEventListener("click", (e) => {
        e.stopPropagation();
        this._closeAddMenu();
        r.run();
      });
      menu.append(item);
    }
    return menu;
  }

  /** Toggle the add menu open/closed under `btn` (quickSpawn groups only).
   *  Clicking a DIFFERENT pane's "+" while the menu is open moves the menu
   *  there rather than just closing it. */
  _toggleAddMenu(btn) {
    const wasOpenHere = this.addMenuEl && this.addMenuBtn === btn;
    this._closeAddMenu();
    if (!wasOpenHere) this._openAddMenu(btn);
  }

  /** Open the add menu, fixed-positioned just under the "+" button. */
  _openAddMenu(btn) {
    if (this.addMenuEl || !btn) return;
    this.addMenuBtn = btn;
    // Re-probe in the background: this menu is built from the list we already
    // have (so it opens instantly), and an agent installed since the last probe
    // appears the next time the menu opens.
    refreshInstalledAgents();
    const menu = this._buildAddMenu();
    document.body.append(menu);
    this.addMenuEl = menu;
    btn.setAttribute("aria-expanded", "true");

    // Place under the button; clamp to the viewport's right edge so a button
    // near the window edge never pushes the menu off-screen.
    const rect = btn.getBoundingClientRect();
    menu.style.top = `${Math.round(rect.bottom + 4)}px`;
    const left = Math.min(rect.left, window.innerWidth - 8 - menu.offsetWidth);
    menu.style.left = `${Math.round(Math.max(8, left))}px`;

    // Dismiss on outside mousedown or Escape. Ignore mousedown on the button —
    // its own click handler toggles the menu shut — and inside the menu.
    this._addMenuDismiss = (ev) => {
      if (ev.type === "keydown") {
        if (ev.key === "Escape") this._closeAddMenu();
        return;
      }
      if (menu.contains(ev.target) || btn.contains(ev.target)) return;
      this._closeAddMenu();
    };
    document.addEventListener("mousedown", this._addMenuDismiss, true);
    document.addEventListener("keydown", this._addMenuDismiss, true);
    // A scroll/resize underneath would strand the fixed menu; just close it.
    this._addMenuReposition = () => this._closeAddMenu();
    window.addEventListener("resize", this._addMenuReposition, true);
    window.addEventListener("scroll", this._addMenuReposition, true);
  }

  /** Close the add menu and remove its global listeners (idempotent). */
  _closeAddMenu() {
    if (!this.addMenuEl) return;
    if (this._addMenuDismiss) {
      document.removeEventListener("mousedown", this._addMenuDismiss, true);
      document.removeEventListener("keydown", this._addMenuDismiss, true);
      this._addMenuDismiss = null;
    }
    if (this._addMenuReposition) {
      window.removeEventListener("resize", this._addMenuReposition, true);
      window.removeEventListener("scroll", this._addMenuReposition, true);
      this._addMenuReposition = null;
    }
    this.addMenuEl.remove();
    this.addMenuEl = null;
    this.addMenuBtn?.setAttribute("aria-expanded", "false");
    this.addMenuBtn = null;
  }

  // ---- Persistence (session restore) --------------------------------------
  // The owner (project.js) reads these to save the group and writes them back
  // via newTerminal({ persistKey, restoreScrollback }) on the next launch.

  /** Ordered layout of this group: each terminal's stable key, current title,
   *  and the cwd it was spawned in. Tab order is pane-tree order, so a restored
   *  layout reads the way it looked. Content tabs (no PTY) are not persisted,
   *  so they are skipped. */
  serialize() {
    // Split state still rides on the two tabs it involves, the way it has since
    // card 42: the first pane's tab is marked `primary`, the second pane's tab
    // carries the direction in `split`. That on-disk shape only describes TWO
    // panes, so it is written only when the tree happens to be exactly two —
    // deeper trees save nothing here and come back as a single pane until the
    // tree itself is persisted (card 48 replaces this whole block).
    const leaves = this._leaves();
    const pair = leaves.length === 2 ? leaves : null;
    const splitDir = pair ? pair[0].parent?.dir ?? "row" : null;
    const firstId = pair?.[0].activeId ?? null;
    const secondId = pair?.[1].activeId ?? null;

    const ordered = this._orderedIds()
      .map((id) => this.tabs.get(id))
      .filter((e) => e && e.term);
    return ordered.map((e) => ({
      persistKey: e.persistKey,
      title: e.title,
      titleManual: !!e.titleManual,
      // true | false | null — null means "follow the Settings switch".
      notify: e.notify ?? null,
      cwd: e.cwd || "",
      // "row" | "col" on the second pane's tab, null on every other tab.
      split: secondId && e === this.tabs.get(secondId) ? splitDir : null,
      // The tab the split sits beside. Only meaningful alongside a `split` tab.
      primary: !!firstId && e === this.tabs.get(firstId),
    }));
  }

  /** Snapshot every terminal's scrollback (text + styles) for saving. The
   *  `scrollback` cap bounds how many lines are serialized; the backend caps
   *  bytes again as the hard limit. Content tabs have no buffer — skipped. */
  scrollbackEntries() {
    return [...this.tabs.values()].filter((e) => e.term).map((e) => ({
      persistKey: e.persistKey,
      data: e.serializeAddon
        ? e.serializeAddon.serialize({ scrollback: FULL_SCROLLBACK_LINES })
        : "",
    }));
  }

  /** One terminal's scrollback snapshot, by pty id (or "" if unknown).
   *  `lines` caps how much buffer is serialized. serialize() is synchronous on
   *  the main thread and its cost scales with the line count, so the frequent
   *  periodic flush passes a smaller cap (crash-recovery only) than the one-shot
   *  full save on quit. */
  scrollbackFor(ptyId, lines = FULL_SCROLLBACK_LINES) {
    const e = this.tabs.get(ptyId);
    return e?.serializeAddon ? e.serializeAddon.serialize({ scrollback: lines }) : "";
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
    // The sidebar tree shows the same title, so it repaints on the rename too.
    emitTabsChange();
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
    notify = null,
    persistKey = null,
    restoreScrollback = "",
    canvasKey = null,
    attachId = null,
  } = {}) {
    // No explicit title -> auto-number from the monotonic counter (P4). An
    // explicit title (command label, chat label) is used verbatim.
    if (title == null) title = `term ${++this.titleSeq}`;
    // Stable key for this terminal's saved scrollback. Generated once and kept
    // across restarts (the live ptyId is regenerated each session, so it cannot
    // be the key). On restore the owner passes the saved key back in.
    if (persistKey == null) persistKey = crypto.randomUUID();

    // ATTACH (web.rs / project.js): this tab adopts a PTY the backend ALREADY
    // owns instead of starting one. That is what makes a browser a second view
    // of the same machine rather than a second machine: it keeps the server's
    // id, spawns nothing, and picks up the live stream. The counter is pushed
    // past the adopted number so a terminal opened later cannot reuse the id.
    const ptyId = attachId || `${this.idPrefix}:${this.seq++}`;
    if (attachId) {
      const n = Number(attachId.slice(this.idPrefix.length + 1));
      if (Number.isFinite(n) && n >= this.seq) this.seq = n + 1;
    }

    // A new terminal opens in the ACTIVE pane. Splitting sets the new pane
    // active before it calls back into here, so a "split right" lands its
    // terminal in the pane it just made. (The leaf owns the focus handling —
    // its own `focusin`/`pointerdown` listeners make it the active pane.)
    const leaf = this._activeLeaf();
    const pane = document.createElement("div");
    pane.className = "tg-pane";
    leaf.panesEl.append(pane);

    const settings = resolveTerminalSettings(this.fontOverride);
    // Re-sync the sheet here too: a group built before the per-profile settings
    // finished loading only gets the change event once it HAS a terminal, so a
    // brand-new group would otherwise keep the constructor's stale color.
    this._applyPanesBackground(settings);
    const term = makeTerminal(settings);
    const fitAddon = new FitAddon.FitAddon();
    term.loadAddon(fitAddon);
    term.open(pane);
    // No WebGL here: activate() attaches it once this tab is the visible one.
    // Only the ACTIVE tab of a VISIBLE group keeps a WebGL context (see
    // _setWebgl) — a hidden pane is display:none and never painted anyway.
    // Cmd/Ctrl+click a printed file path to open it with the OS default app.
    attachFileLinks(term, cwd);
    // Serialize addon snapshots the buffer (text + styles) to a string we save
    // to disk and write back on the next launch (session persistence).
    const serializeAddon = new SerializeAddon.SerializeAddon();
    term.loadAddon(serializeAddon);
    // Follow the pane's real size. A ResizeObserver fires for layout changes the
    // window "resize" event misses (drawer toggles, panel collapse, tab show),
    // so the fit — and the rows/cols we report to the PTY — never drift out of
    // sync with what is painted. We refit only when this tab is the active one.
    const ro = new ResizeObserver(() => {
      if (this.isShown(ptyId)) this._fit(ptyId);
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
    // Right-click the tab title to turn this ONE terminal's notifications off
    // (card 43). Per-terminal, on top of the global switch in Settings.
    tabEl.addEventListener("contextmenu", (e) => {
      e.preventDefault();
      this._openTabMenu(ptyId, e.clientX, e.clientY);
    });
    this._wireTabDrag(tabEl, ptyId);
    leaf.tabsEl.append(tabEl);

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
      // This terminal's own notification choice (card 43), set by right-clicking
      // the tab: true = watched, false = silent, null = follow the Settings
      // switch (the default). Persisted with the layout, so a terminal the user
      // silenced — or singled out to keep watching — stays that way after a
      // restart.
      notify,
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
      // The tab's live WebGL addon, or null. Held only while this tab is the
      // active one of a visible group (see _setWebgl).
      webgl: null,
      // Whether the backend is currently streaming this terminal's output to us
      // (card 16). A fresh PTY starts visible on both sides, so this starts true
      // and _setLive only calls the backend when it actually flips.
      live: true,
      // Which leaf pane of the tree shows this tab (card 45).
      paneId: leaf.id,
    };
    this.tabs.set(ptyId, entry);
    leaf.tabIds.push(ptyId);
    // A terminal restored with a saved choice wears its mark from the start,
    // and an explicit "on" counts towards keeping the machinery running.
    if (notify != null) {
      if (notify === true) forcedOn.add(ptyId);
      this._paintNotify(ptyId);
    }

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
    emitTerminalsChange();

    // Spawn the backing PTY. Note Tauri maps start_cmd -> startCmd and
    // persist_key -> persistKey. The persist key is exported into the shell as
    // OCTIQ_TERM_KEY so an agent's capture hook can tag its session to this tab
    // (session resume on restart). `shell` is the Windows shell pick from
    // Settings (ignored on Unix); it is read at spawn time so a new terminal
    // always uses the current choice. If the spawn fails, the pane + tab already
    // exist, so show the error there (P3) rather than swallowing it; the tab
    // stays so the user sees what happened.
    if (attachId) {
      // Adopting a running terminal: nothing to spawn. Ask the backend to treat
      // it as on screen — it may have been put in the "hidden, buffer it" state
      // by the desktop window before this client attached, and revealing drains
      // that buffer to us as a pty-restore.
      invoke("pty_set_visible", { id: ptyId, visible: true }).catch(() => {});
    } else {
      const { shell } = getTerminalSettings();
      try {
        await invoke("pty_spawn", { id: ptyId, cwd, startCmd, persistKey, shell, canvasKey });
      } catch (err) {
        reportTermError(term, `failed to start terminal: ${err}`);
      }
    }

    this.activate(ptyId);
    // A tab was added: let the owner persist the new layout.
    this.onLayoutChange?.();
    return ptyId;
  }

  /**
   * Open (or reveal) a CONTENT tab: a tab in the same strip whose pane hosts
   * arbitrary DOM instead of a terminal (the VS Code editor-tab pattern — a
   * file, a diff, anything). `key` is stable: opening the same key again just
   * activates the existing tab. `mount(paneEl)` fills the pane once on create.
   *
   * Content tabs have NO PTY: serialize()/scrollbackEntries() skip them (they
   * do not survive a restart), and every PTY-side feature (WebGL, flood
   * control, working/attention dots, auto-title) ignores them.
   *
   * `beforeClose()` may return false to cancel a close (unsaved edits);
   * `onClose()` runs after the tab is removed (dispose editors); `onShow()`
   * runs whenever the tab becomes the active one.
   *
   * Returns { id, paneEl, existed, setTitle, setDirty, activate, close }.
   */
  newContentTab({ key, title, mount, beforeClose = null, onClose = null, onShow = null }) {
    const tabId = `${this.idPrefix}:content:${key}`;
    const handleFor = (entry, existed) => ({
      id: tabId,
      paneEl: entry.paneEl,
      existed,
      setTitle: (t) => {
        entry.title = t;
        entry.labelEl.textContent = t;
      },
      setDirty: (on) => entry.tabEl.classList.toggle("tg-tab-dirty", !!on),
      activate: () => this.activate(tabId),
      close: (force = false) => this.closeTerminal(tabId, force),
    });

    const existing = this.tabs.get(tabId);
    if (existing) {
      this.activate(tabId);
      return handleFor(existing, true);
    }

    // Like a terminal tab, a content tab opens in the ACTIVE pane.
    const leaf = this._activeLeaf();
    const pane = document.createElement("div");
    pane.className = "tg-pane tg-pane-content";
    leaf.panesEl.append(pane);

    const tabEl = document.createElement("div");
    tabEl.className = "tg-tab tg-tab-content";
    const label = document.createElement("span");
    label.className = "tg-tab-label";
    label.textContent = title;
    label.title = title;
    const closeBtn = document.createElement("button");
    closeBtn.className = "tg-tab-close";
    closeBtn.innerHTML = ICONS.x(11);
    closeBtn.title = "Close";
    closeBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      this.closeTerminal(tabId);
    });
    tabEl.append(label, closeBtn);
    tabEl.addEventListener("click", () => this.activate(tabId));
    // Content tabs join the same drag flow as terminal tabs.
    this._wireTabDrag(tabEl, tabId);
    leaf.tabsEl.append(tabEl);

    const entry = {
      term: null, // the "this is not a terminal" marker every guard checks
      paneEl: pane,
      tabEl,
      labelEl: label,
      title,
      beforeClose,
      onClose,
      onShow,
      paneId: leaf.id,
    };
    this.tabs.set(tabId, entry);
    leaf.tabIds.push(tabId);
    mount?.(pane);
    this.activate(tabId);
    return handleFor(entry, false);
  }

  /**
   * Attach or drop one tab's WebGL renderer. Only the ACTIVE tab of a VISIBLE
   * group keeps one: each addon holds a whole GPU context + glyph atlas, and
   * WebKit caps live WebGL contexts (~16) — past the cap it silently kills the
   * oldest, permanently downgrading that terminal to the slow DOM renderer.
   * A deactivated tab's pane is display:none (never painted), so it loses
   * nothing; re-attaching does a full repaint, which also erases any stale
   * DOM-rendered glyphs from the time without WebGL.
   */
  _setWebgl(entry, on) {
    if (on && !entry.webgl) {
      entry.webgl = attachWebgl(entry.term, () => (entry.webgl = null));
    } else if (!on && entry.webgl) {
      entry.webgl.dispose();
      entry.webgl = null;
    }
  }

  /**
   * Put one tab fully on or off screen: its WebGL context AND the backend's
   * output gate (card 16) move together, because "on screen" means the same
   * thing to both — the active tab of a shown group.
   *
   * The backend call is skipped when the value has not changed, so activating a
   * tab costs one IPC, not one per tab in the group.
   */
  _setLive(ptyId, entry, on) {
    if (!entry.term) return; // content tab: no renderer, no PTY gate
    this._setWebgl(entry, on);
    if (!this.floodControl || entry.live === on) return;
    entry.live = on;
    // A closed/failed PTY has no session; the backend no-ops and so do we.
    invoke("pty_set_visible", { id: ptyId, visible: on }).catch(() => {});
  }

  // ---- Pane tree: what is on screen ---------------------------------------

  /** The tabs on screen right now: the active tab of every leaf pane.
   *  Everything that means "on screen" — WebGL, the backend output gate,
   *  refits — asks this, so every pane is treated alike. */
  _shownIds() {
    const ids = [];
    for (const leaf of this._leaves()) {
      if (leaf.activeId && this.tabs.has(leaf.activeId)) ids.push(leaf.activeId);
    }
    return ids;
  }

  /** Whether a tab is the one its own pane is currently showing. */
  isShown(ptyId) {
    return this._leafOf(ptyId)?.activeId === ptyId;
  }

  /** The shown tab the keyboard belongs to: the active tab of the ACTIVE pane,
   *  falling back to any shown tab if that pane has none. Anything that means
   *  "the terminal the user is typing into" reads this. */
  focusedId() {
    return this._activeLeaf()?.activeId ?? this._shownIds()[0] ?? null;
  }

  /**
   * Repaint which tab each pane shows, mark the active pane's tab, and settle
   * every tab's WebGL context + backend output gate.
   *
   * There is no geometry here any more: a leaf's box is sized by the flex tree
   * (_applyRatios), and inside it every `.tg-pane` keeps the plain CSS inset, so
   * FitAddon still measures the exact drawable rectangle at any tree depth.
   */
  _applyPanes() {
    const activeLeafId = this._activeLeaf()?.id ?? null;

    for (const leaf of this._leaves()) {
      const isActiveLeaf = leaf.id === activeLeafId;
      leaf.el.classList.toggle("tg-pane-group-active", isActiveLeaf);
      for (const id of leaf.tabIds) {
        const e = this.tabs.get(id);
        if (!e) continue;
        const on = id === leaf.activeId;
        e.paneEl.classList.toggle("tg-pane-active", on);
        // The tab of the pane the keyboard is in gets the strong highlight; the
        // shown tab of every OTHER pane gets a lighter mark, so the strips say
        // both what is on screen and where typing goes.
        e.tabEl.classList.toggle("tg-tab-active", on && isActiveLeaf);
        e.tabEl.classList.toggle("tg-tab-shown", on && !isActiveLeaf);
      }
    }

    const shown = this._shownIds();
    const groupVisible = this.visible();
    for (const [id, e] of this.tabs) {
      this._setLive(id, e, shown.includes(id) && groupVisible);
    }
    // Every structural / active-tab change lands here (open, close, activate,
    // split, restore), so this is the one place the sidebar tree needs to hear
    // about to stay in step with the panes.
    emitTabsChange();
  }

  /**
   * Move a tab into a NEW pane beside the one it is in, cutting the space `dir`
   * ("row" = side by side, "col" = stacked).
   *
   * Splitting FROM the tab you are looking at means "give me another terminal
   * here", so a new one is spawned (through the owner's onAdd policy, which
   * knows the cwd and any per-project start command) and takes the new pane.
   * Splitting from a DIFFERENT tab of the same pane means "show that one too",
   * so that existing tab moves into the new pane instead.
   *
   * Refuses past MAX_PANES, and says so — an unbounded split would quietly cost
   * the user a terminal's WebGL renderer.
   */
  async _splitWith(ptyId, dir) {
    const leaf = this._leafOf(ptyId);
    if (!leaf) return;
    const spawning = ptyId === leaf.activeId;
    // A group with no add policy (the command drawers) can only split by moving
    // an existing tab across; there is nothing to spawn into the new pane. Say
    // so rather than letting the menu item look broken.
    if (spawning && !this.onAdd) {
      this._flashNotice("Split another tab of this pane — this one cannot open new terminals");
      return;
    }
    if (this._leaves().length >= MAX_PANES) {
      this._flashNotice(`${MAX_PANES}-pane limit reached — close a pane to split again`);
      return;
    }

    this.splitDir = dir === "col" ? "col" : "row";
    const created = this._makeLeaf();
    this._insertSibling(leaf, created, this.splitDir);
    // The new pane is where the user is going, so make it active FIRST: both
    // paths below (spawn / move) put their tab in the active pane.
    this.activePaneId = created.id;

    if (spawning) {
      const newId = await this.onAdd?.();
      if (!newId || !this.tabs.has(newId)) {
        // The spawn failed — undo the split rather than leaving an empty pane.
        this._removePane(created);
        this.activePaneId = leaf.id;
        this._applyPanes();
        return;
      }
    } else {
      this._moveTabToPane(ptyId, created);
    }

    this._applyPanes();
    this._paintLastSent(this.focusedId());
    this._saveSplitPrefs();
    this.onLayoutChange?.();
    // Every pane on this branch just changed size; fit them once the new
    // geometry is laid out.
    requestAnimationFrame(() => {
      this.refitActive();
      this._focusActive();
    });
  }

  /** Merge a pane back into its sibling: its tabs move across (they are NOT
   *  closed — they go back to being ordinary background tabs there) and the
   *  pane is removed. The root leaf has no sibling, so it is left alone. */
  _closeSplit(paneId) {
    const leaf = this.panes.get(paneId ?? this.activePaneId);
    if (!leaf || !leaf.parent) return;
    const target = this._firstLeafOf(leaf.parent.children.find((c) => c !== leaf));
    if (!target) return;
    const wasActive = leaf.activeId;
    for (const id of [...leaf.tabIds]) this._moveTabToPane(id, target);
    this._removePane(leaf);
    this.activePaneId = target.id;
    if (wasActive) target.activeId = wasActive;
    this._applyPanes();
    this._paintLastSent(this.focusedId());
    this.onLayoutChange?.();
    requestAnimationFrame(() => {
      this.refitActive();
      this._focusActive();
    });
  }

  /** The first leaf inside a subtree (its top-left pane). */
  _firstLeafOf(node) {
    return node ? this._leaves(node)[0] ?? null : null;
  }

  /**
   * Release the WebGL context of every terminal inside a subtree, ahead of a
   * reparent (splitting wraps a leaf in a new split element; collapsing lifts a
   * sibling up into its place — both detach and re-insert the subtree).
   *
   * A canvas that is detached and re-inserted can come back blank, and the addon
   * has no "the element moved" hook. Dropping the context first and letting
   * _applyPanes re-attach afterwards is the same drop/re-attach cycle a tab
   * activation already does, and it repaints the whole grid on the way back.
   */
  _dropWebglIn(node) {
    for (const leaf of this._leaves(node)) {
      for (const id of leaf.tabIds) {
        const entry = this.tabs.get(id);
        if (entry) this._setWebgl(entry, false);
      }
    }
  }

  /**
   * Move a tab into another leaf pane, optionally at a position in its strip.
   * Both the model (tabIds + entry.paneId) and the DOM (tab element, pane
   * element) move together, so the tree and what is painted cannot drift apart.
   *
   * The WebGL context is dropped first: reparenting the pane element detaches
   * and re-attaches its canvas, and _applyPanes gives the tab a fresh context
   * afterwards if it is still on screen.
   */
  _moveTabToPane(ptyId, target, index = null) {
    const entry = this.tabs.get(ptyId);
    const from = this._leafOf(ptyId);
    if (!entry || !target || !from || from === target) return false;

    this._setWebgl(entry, false);
    from.tabIds = from.tabIds.filter((id) => id !== ptyId);
    const at = index == null ? target.tabIds.length : Math.max(0, Math.min(index, target.tabIds.length));
    target.tabIds.splice(at, 0, ptyId);
    entry.paneId = target.id;

    const before = target.tabsEl.children[at] ?? null;
    target.tabsEl.insertBefore(entry.tabEl, before);
    target.panesEl.append(entry.paneEl);

    // The source pane promotes another tab; the target shows the arrival.
    if (from.activeId === ptyId) from.activeId = from.tabIds[0] ?? null;
    target.activeId = ptyId;
    this._resortTabs();
    return true;
  }

  // ---- Pane tree persistence (card 48) ------------------------------------

  /**
   * This group's pane tree, described by the tabs' STABLE persist keys — the
   * live pty id is regenerated every launch, so only the key can survive a
   * restart. Shape matches `PaneNode` in `terminal_layout.rs`.
   *
   * Content tabs (a Monaco file editor) have no persist key and do not survive a
   * restart, so they are left out; a pane holding only content tabs therefore
   * serializes to nothing and its space folds into its sibling on the next
   * launch, exactly as it would if the user had closed those tabs.
   *
   * Returns null when there is nothing worth saving (no terminals at all).
   */
  serializeLayout() {
    const build = (node) => {
      if (node.type === "pane") {
        const keys = node.tabIds
          .map((id) => this.tabs.get(id))
          .filter((e) => e?.term && e.persistKey)
          .map((e) => e.persistKey);
        if (!keys.length) return null;
        const activeKey = this.tabs.get(node.activeId)?.persistKey;
        return {
          type: "pane",
          keys,
          active: keys.includes(activeKey) ? activeKey : keys[0],
        };
      }
      const children = node.children.map(build).filter(Boolean);
      if (!children.length) return null;
      // A split that lost a side is no longer a split — same collapse rule the
      // UI and the Rust pruner apply, so all three agree on the shape.
      if (children.length === 1) return children[0];
      return { type: "split", dir: node.dir, ratio: node.ratio, children };
    };
    return build(this.layout);
  }

  /**
   * Collapse back to ONE pane holding every tab, without closing anything.
   *
   * Applying a saved arrangement (card 51) has to start from a known shape:
   * `restoreLayout` grows its panes out of the group's single leaf, so a group
   * that is already split must be flattened first.
   */
  resetPanes() {
    const leaves = this._leaves();
    if (leaves.length < 2) return;
    const [root, ...rest] = leaves;
    for (const leaf of rest) {
      for (const id of [...leaf.tabIds]) this._moveTabToPane(id, root);
    }
    // Remove deepest-first: each removal lifts a sibling up, and taking the
    // later leaves first keeps every remaining node's parent chain valid.
    for (const leaf of rest.reverse()) this._removePane(leaf);
    this.activePaneId = root.id;
    if (!root.activeId) root.activeId = root.tabIds[0] ?? null;
    this._resortTabs();
    this._applyPanes();
  }

  /**
   * Rebuild the pane tree from a saved one, AFTER every tab exists.
   *
   * Called once per project restore, when the group is still a single leaf
   * holding all the rebuilt tabs. Keys that no longer resolve to a tab are
   * skipped and a leaf left with none is dropped, so a tree naming a terminal
   * the user has since closed comes back as fewer panes rather than failing.
   */
  restoreLayout(tree) {
    const plan = this._planFromSaved(tree);
    if (!plan) return;

    // The group's one existing leaf becomes the plan's first pane; every other
    // pane is grown beside it. Collected as we go so tabs can be handed out
    // once the whole shape exists.
    const host = this._leaves()[0];
    if (!host) return;
    const seats = [];
    this._growPlan(plan, host, seats);

    for (const seat of seats) {
      for (const id of seat.ids) this._moveTabToPane(id, seat.leaf);
      seat.leaf.activeId = seat.ids.includes(seat.activeId) ? seat.activeId : seat.ids[0];
    }

    this.activePaneId = seats[0]?.leaf.id ?? host.id;
    this._resortTabs();
    this._applyPanes();
    this._paintLastSent(this.focusedId());
    requestAnimationFrame(() => {
      this.refitActive();
      this._focusActive();
    });
  }

  /**
   * Turn a saved tree into a plan of panes this group can actually build: keys
   * resolved to live tab ids, dead keys dropped, empty nodes folded away, and
   * any node with more than two children re-nested into binary splits (the tree
   * this class builds is always binary, and `_insertSibling` assumes it).
   * Returns null when nothing survives.
   */
  _planFromSaved(node) {
    if (!node || typeof node !== "object") return null;

    if (node.type === "pane") {
      const ids = (node.keys || [])
        .map((key) => this._idForPersistKey(key))
        .filter(Boolean);
      if (!ids.length) return null;
      const activeId = this._idForPersistKey(node.active);
      return { type: "pane", ids, activeId: ids.includes(activeId) ? activeId : ids[0] };
    }

    const kids = (node.children || []).map((c) => this._planFromSaved(c)).filter(Boolean);
    if (!kids.length) return null;
    if (kids.length === 1) return kids[0];

    const dir = node.dir === "col" ? "col" : "row";
    const ratio = Number.isFinite(node.ratio)
      ? Math.min(1 - MIN_SPLIT_RATIO, Math.max(MIN_SPLIT_RATIO, node.ratio))
      : 0.5;
    // Fold 3+ children into right-nested binary splits, sharing the ratio.
    const fold = (list) =>
      list.length === 2
        ? { type: "split", dir, ratio, children: list }
        : { type: "split", dir, ratio, children: [list[0], fold(list.slice(1))] };
    return fold(kids);
  }

  /** The live tab id for a stable persist key, or null. */
  _idForPersistKey(key) {
    if (!key) return null;
    for (const [id, e] of this.tabs) if (e.persistKey === key) return id;
    return null;
  }

  /**
   * Grow the pane structure for `plan`, using `host` as the subtree's first
   * leaf and creating a sibling for each further branch. Appends one
   * `{ leaf, ids, activeId }` seat per pane, in tree order, so the caller can
   * hand the tabs out afterwards.
   *
   * Stops creating panes at MAX_PANES: any remaining plan panes have their tabs
   * folded into the last seat, so a tree saved by some future version with more
   * panes still restores every terminal, just in fewer panes.
   */
  _growPlan(plan, host, seats) {
    if (plan.type === "pane") {
      seats.push({ leaf: host, ids: plan.ids, activeId: plan.activeId });
      return;
    }
    if (this._leaves().length >= MAX_PANES) {
      // No room to split: everything below here shares the host pane.
      const ids = [];
      const collect = (n) => {
        if (n.type === "pane") ids.push(...n.ids);
        else n.children.forEach(collect);
      };
      collect(plan);
      seats.push({ leaf: host, ids, activeId: ids[0] });
      return;
    }
    const second = this._makeLeaf();
    this._insertSibling(host, second, plan.dir);
    host.parent.ratio = plan.ratio;
    this._applyRatios();
    this._growPlan(plan.children[0], host, seats);
    this._growPlan(plan.children[1], second, seats);
  }

  /** Remember the direction + sash position for this group, so the NEXT split
   *  opens the way the user last left it. Kept in localStorage next to the
   *  other appearance choices: it is a UI preference, not session state, and a
   *  command-drawer group should not push it through the layout store. */
  _saveSplitPrefs() {
    try {
      localStorage.setItem(
        `octiq.split.${this.idPrefix}`,
        JSON.stringify({ dir: this.splitDir, ratio: this.splitRatio }),
      );
    } catch (_) {
      // Storage full or blocked — the split still works, it just won't be
      // remembered.
    }
  }

  _loadSplitPrefs() {
    try {
      const raw = localStorage.getItem(`octiq.split.${this.idPrefix}`);
      if (!raw) return;
      const { dir, ratio } = JSON.parse(raw) || {};
      if (dir === "row" || dir === "col") this.splitDir = dir;
      if (typeof ratio === "number" && ratio >= MIN_SPLIT_RATIO && ratio <= 1 - MIN_SPLIT_RATIO) {
        this.splitRatio = ratio;
      }
    } catch (_) {
      // Corrupt entry — keep the defaults.
    }
  }

  /** Drag ONE split node's sash to re-balance its two children. Pointer capture
   *  keeps the drag alive over the terminals (which would otherwise swallow the
   *  moves), and the refit is rAF-throttled: every ratio change resizes the
   *  xterms on that branch AND sends a PTY resize each, which is far too much to
   *  do per pointermove. */
  _beginSashDrag(split, ev) {
    ev.preventDefault();
    const sash = split.sashEl;
    sash.setPointerCapture?.(ev.pointerId);
    sash.classList.add("tg-sash-drag");
    let queued = false;

    const onMove = (e) => {
      const box = split.el.getBoundingClientRect();
      const span = split.dir === "row" ? box.width : box.height;
      if (span <= 0) return;
      const at = split.dir === "row" ? e.clientX - box.left : e.clientY - box.top;
      // Clamp so neither child can be squeezed to nothing (an xterm below a
      // couple of columns is useless and its fit math starts failing).
      split.ratio = Math.min(1 - MIN_SPLIT_RATIO, Math.max(MIN_SPLIT_RATIO, at / span));
      if (queued) return;
      queued = true;
      requestAnimationFrame(() => {
        queued = false;
        this._applyRatios(split);
        this.refitActive();
      });
    };

    const onUp = () => {
      sash.removeEventListener("pointermove", onMove);
      sash.removeEventListener("pointerup", onUp);
      sash.removeEventListener("pointercancel", onUp);
      sash.classList.remove("tg-sash-drag");
      this._applyRatios(split);
      this.refitActive();
      // The last position the user chose seeds the next split in this group.
      this.splitRatio = split.ratio;
      this._saveSplitPrefs();
      this.onLayoutChange?.();
    };

    sash.addEventListener("pointermove", onMove);
    sash.addEventListener("pointerup", onUp);
    sash.addEventListener("pointercancel", onUp);
  }

  activate(ptyId) {
    const leaf = this._leafOf(ptyId);
    if (!leaf) return;
    // Show the tab in its OWN pane and move the keyboard to that pane. Clicking
    // a tab already on screen in another pane is therefore just a pane switch —
    // nothing moves, which is what makes several panes feel stable.
    leaf.activeId = ptyId;
    this.activePaneId = leaf.id;
    this._applyPanes();
    // The bottom bar always tracks the terminal being typed into: repaint it for
    // the now-active tab's last sent line (or the placeholder if it has none).
    this._paintLastSent(ptyId);
    // Becoming the active tab counts as the user attending to this terminal, so
    // clear any attention flag on it (card 13). clearAttention is a no-op when
    // the id is not flagged, so this is cheap on normal tab switches.
    if (attention.has(ptyId)) clearAttention(ptyId);
    // Same for the quieter activity mark (card 15).
    clearActivity(ptyId);
    // Fit + focus on the next frame so the now-shown pane has a real size.
    requestAnimationFrame(() => {
      this._fit(ptyId);
      if (this.focusedId() === ptyId) this._focusActive();
    });
  }

  /**
   * Give the active tab keyboard focus.
   *
   * Why this is its own method and not just a line in activate(): a terminal
   * inside a `display:none` pane CANNOT take focus — the call silently does
   * nothing — so a group activated while its view is hidden ends up with no
   * focused terminal at all, and typing goes nowhere until the user clicks in
   * the pane. Chat hit this on every launch: chat.js seeds its first terminal
   * at module load, while Project mode is the visible view. So focusing is
   * skipped while hidden and run again from show(), when it can actually land.
   *
   * It also refuses to STEAL focus out of a form field elsewhere in the app (a
   * project rename box, a search input), because show() also fires on routine
   * re-selection. Another terminal's helper textarea is not treated as such a
   * field — moving focus from one terminal to the newly shown one is the whole
   * point.
   */
  _focusActive() {
    if (!this.visible()) return;
    // With a split, focus belongs to the half the user last typed in, not
    // always the primary pane.
    const id = this.focusedId();
    const e = id && this.tabs.get(id);
    if (!e) return;
    if (this._focusWouldSteal()) return;
    if (!e.term) e.onShow?.(); // content tab revealed (e.g. refocus an editor)
    else if (!e.renaming) e.term.focus();
  }

  /** True when focus currently sits in an editable control OUTSIDE this group,
   *  so taking it would interrupt someone mid-typing. */
  _focusWouldSteal() {
    const ae = document.activeElement;
    if (!ae || ae === document.body) return false;
    if (this.root.contains(ae)) return false; // already inside this group
    // xterm's own hidden input: another terminal, fine to take over from.
    if (ae.classList?.contains("xterm-helper-textarea")) return false;
    return !!ae.closest?.("input, textarea, select, [contenteditable='true']");
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
    // A draggable tab steals mouse-drag from the input (drags the tab instead of
    // selecting text). Turn it off while editing; finish() turns it back on.
    entry.tabEl.draggable = false;

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
      entry.tabEl.draggable = true;
      // Persist the renamed tab so the title survives a restart.
      if (changed) {
        this.onLayoutChange?.();
        emitTabsChange();
      }
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

  // Paint or un-paint a tab's "activity" mark (card 15) — the quietest of the
  // three tab states: this tab printed while you were elsewhere.
  _paintActivity(ptyId, on) {
    const entry = this.tabs.get(ptyId);
    if (!entry) return;
    entry.tabEl.classList.toggle("tg-tab-activity", on);
  }

  // ---- Per-terminal notification choice (card 43) -------------------------
  // A tab that OVERRIDES the Settings switch says so on the tab itself, not
  // only inside its right-click menu: a crossed-out bell when it is silenced, a
  // plain bell when it is watched while the switch is off. A tab that simply
  // follows the switch carries no mark — the common case stays clean.
  _paintNotify(ptyId) {
    const entry = this.tabs.get(ptyId);
    if (!entry) return;
    const choice = entry.notify; // true | false | null
    entry.tabEl.classList.toggle("tg-tab-muted", choice === false);
    entry.tabEl.querySelector(".tg-tab-mute-mark")?.remove();

    if (choice == null) {
      entry.tabEl.title = "";
      return;
    }
    entry.tabEl.title =
      choice === true
        ? "Notifications are on for this terminal"
        : "Notifications are off for this terminal";
    const el = document.createElement("span");
    el.className = "tg-tab-mute-mark";
    el.innerHTML = choice === true ? ICONS.bell(11) : ICONS.bellOff(11);
    entry.labelEl.after(el);
  }

  /** Set this ONE terminal's notification choice: true (watch it), false
   *  (silence it) or null (follow the Settings switch). Anything it has already
   *  raised is cleared when the change stops it being watched — a badge left
   *  behind would have nothing running to clear it. Persists with the layout. */
  _setNotify(ptyId, choice) {
    const entry = this.tabs.get(ptyId);
    if (!entry || entry.notify === choice) return;
    entry.notify = choice;
    if (choice === true) forcedOn.add(ptyId);
    else forcedOn.delete(ptyId);
    this._paintNotify(ptyId);
    syncMonitoring();
    this.onLayoutChange?.();
    emitTabsChange();
  }

  /** The right-click menu on a tab: this terminal's notifications. The choice
   *  in force is ticked, and "Follow the setting" names what the setting
   *  currently is, so the menu answers "what happens now?" on its own. */
  _openTabMenu(ptyId, x, y) {
    const entry = this.tabs.get(ptyId);
    if (!entry) return;
    const choice = entry.notify;
    // Non-breaking spaces: the menu item renders as text, and plain spaces
    // would collapse, leaving the three labels ragged.
    const tick = (mine) => (mine === choice ? "✓ " : "   ");
    // Split entries first — they are the layout actions; the notification
    // choices below are a settings block.
    const leaf = this._leafOf(ptyId);
    // From the tab its pane is showing, these open a NEW terminal in the new
    // pane; from any other tab of that pane, they move THAT tab into it.
    const splitItems = [
      { label: "Split right", onClick: () => this._splitWith(ptyId, "row") },
      { label: "Split down", onClick: () => this._splitWith(ptyId, "col") },
    ];
    // Only a pane that HAS a sibling can be merged back into one. Its tabs move
    // to the sibling rather than closing, so nothing is lost.
    if (leaf?.parent) {
      splitItems.push({
        label: "Close this pane",
        onClick: () => this._closeSplit(leaf.id),
      });
    }
    openCtxMenu(x, y, [
      ...splitItems,
      {
        label: `${tick(null)}Follow the setting (now ${masterOn ? "on" : "off"})`,
        onClick: () => this._setNotify(ptyId, null),
      },
      {
        label: `${tick(true)}Notifications on for this terminal`,
        onClick: () => this._setNotify(ptyId, true),
      },
      {
        label: `${tick(false)}Notifications off for this terminal`,
        onClick: () => this._setNotify(ptyId, false),
      },
    ]);
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
  // terminal is the one being typed into — with a split there are two on screen
  // and the bar follows the focused half. No-op for any other tab, so typing
  // never leaks across tabs.
  _paintLastSent(ptyId) {
    if (ptyId !== this.focusedId()) return;
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

  closeTerminal(ptyId, force = false) {
    const entry = this.tabs.get(ptyId);
    if (!entry) return;
    // Capture the pane before the entry goes: _afterTabRemoved settles that
    // pane (and may collapse it), and the entry is what points at it.
    const leaf = this._leafOf(ptyId);
    // Content tab: no PTY, no monitors — just ask its owner (unsaved edits may
    // cancel, unless forced by dispose), drop the DOM, and move to the next tab.
    if (!entry.term) {
      if (!force && entry.beforeClose && entry.beforeClose() === false) return;
      entry.tabEl.remove();
      entry.paneEl.remove();
      this.tabs.delete(ptyId);
      entry.onClose?.();
      this._afterTabRemoved(ptyId, leaf);
      return;
    }
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
    firstOutputWaiters.delete(ptyId);
    // Monitor state for a dead terminal (card 15). The DOM is about to go, so
    // drop the flags straight from the sets rather than repainting.
    activityTabs.delete(ptyId);
    // Through setAgentTab so tg-agents-change fires and the idle badge drops it.
    setAgentTab(ptyId, false);
    silenceArmed.delete(ptyId);
    // A closed terminal can no longer hold the machinery on by overriding the
    // Settings switch (card 43). When it was the last one doing so and the
    // switch is off, this is what stops the polls and the backend scan.
    if (forcedOn.delete(ptyId) && !monitoringActive()) syncMonitoring();
    invoke("pty_close", { id: ptyId }).catch(() => {});
    entry.ro?.disconnect();
    entry.term.dispose();
    entry.tabEl.remove();
    entry.paneEl.remove();
    this.tabs.delete(ptyId);
    idToEntry.delete(ptyId);
    emitTerminalsChange();
    this._afterTabRemoved(ptyId, leaf);
    // A tab was removed: let the owner persist the shrunken layout. The backend
    // reconciles and deletes the closed terminal's saved scrollback file.
    this.onLayoutChange?.();
  }

  /** Settle a pane after one of its tabs was removed. The pane promotes its
   *  next tab; a pane left with NO tabs is removed and its space falls back to
   *  its sibling. The root leaf is the exception — an empty group still needs
   *  one strip to put the next "+" in. */
  _afterTabRemoved(ptyId, leaf) {
    if (leaf && this.panes.has(leaf.id)) {
      const at = leaf.tabIds.indexOf(ptyId);
      if (at >= 0) leaf.tabIds.splice(at, 1);
      if (leaf.activeId === ptyId) {
        // Promote the tab that slid into the closed one's place, else the last.
        leaf.activeId = leaf.tabIds[Math.min(at, leaf.tabIds.length - 1)] ?? null;
      }
      // Emptied pane: give the space back to its sibling and move the keyboard
      // to whichever pane took over.
      if (!leaf.tabIds.length && leaf.parent) {
        const heir = this._firstLeafOf(leaf.parent.children.find((c) => c !== leaf));
        this._removePane(leaf);
        if (this.activePaneId === leaf.id) this.activePaneId = heir?.id ?? this._leaves()[0]?.id;
      }
    }
    this._resortTabs();
    this._applyPanes();
    if (this._shownIds().length) {
      // A tab promoted to the screen is now in front of the user, so its
      // attention badge and activity mark have been attended to — the same
      // clearing activate() does when a tab is clicked.
      for (const id of this._shownIds()) {
        if (attention.has(id)) clearAttention(id);
        clearActivity(id);
      }
      this._paintLastSent(this.focusedId());
      requestAnimationFrame(() => {
        this.refitActive();
        this._focusActive();
      });
    } else {
      // No terminals left on screen: clear the bar so it does not keep the
      // closed tab's last sent line.
      this._renderLastSent(null);
    }
  }

  show() {
    this.root.style.display = "";
    // Visible again: give every shown tab (both halves of a split) its WebGL
    // renderer back and re-open its backend output gate (hide() released both).
    // Attach after display flips so the canvas has a real size.
    for (const id of this._shownIds()) this._setLive(id, this.tabs.get(id), true);
    // The now-revealed tabs are being looked at: drop their activity mark
    // (card 15). activate() covers a tab CLICK; this covers a mode/project
    // switch that reveals the group without re-activating its tab.
    for (const id of this._shownIds()) clearActivity(id);
    // Refit the active terminal after the element is laid out and measurable,
    // then focus it. The focus MUST happen here and not only in activate(): a
    // terminal activated while this group was hidden could not take focus then
    // (display:none panes cannot), so without this the freshly shown terminal
    // ignores the keyboard until it is clicked. See _focusActive.
    requestAnimationFrame(() => {
      this.refitActive();
      this._focusActive();
    });
  }

  hide() {
    // Keep terminals alive; just hide the DOM subtree. Close the add menu too —
    // it lives on <body>, so it would otherwise float over the next view.
    this._closeAddMenu();
    // Nothing in this group can be seen: release every GPU context it holds
    // (normally just the active tab's) and close every backend output gate, so
    // an agent or build in here streams into the ring instead of the webview.
    // show()/activate() re-attach and replay.
    for (const [id, e] of this.tabs) this._setLive(id, e, false);
    this.root.style.display = "none";
  }

  refitActive() {
    if (!this.visible()) return;
    // Both halves of a split are on screen, so both need the fit.
    for (const id of this._shownIds()) this._fit(id);
  }

  /** Resolve this group's effective appearance (its per-project font/color
   *  override overlaid on the global settings) and apply it to every open
   *  terminal, then refit the active tab so rows/cols and the PTY size track the
   *  new glyph metrics. Called on a global settings change and whenever the
   *  project's override changes. */
  applyFontSettings() {
    const s = resolveTerminalSettings(this.fontOverride);
    for (const e of this.tabs.values()) {
      if (!e.term) continue; // content tab: no terminal to restyle
      e.term.options.fontFamily = s.fontFamily;
      e.term.options.fontSize = s.fontSize;
      e.term.options.fontWeight = s.fontWeight;
      e.term.options.lineHeight = s.lineHeight;
      e.term.options.letterSpacing = s.letterSpacing;
      e.term.options.theme = s.theme;
    }
    this._applyPanesBackground(s);
    this.refitActive();
  }

  /** Paint the panes sheet in this group's effective terminal background so the
   *  pane's 10px gutter blends into the terminal instead of ringing it. Takes an
   *  already-resolved settings object when the caller has one, and one leaf when
   *  only that pane needs it (a pane a split just created); otherwise every leaf
   *  is repainted, so all panes of a group stay the same colour. */
  _applyPanesBackground(settings, leaf = null) {
    const s = settings || resolveTerminalSettings(this.fontOverride);
    const bg = s.theme?.background || "";
    for (const l of leaf ? [leaf] : this._leaves()) l.panesEl.style.background = bg;
  }

  /** Set this group's per-project override (raw workspace font_override — the
   *  field name is historical; it now carries the font AND color-theme override)
   *  and apply it live to every open terminal. New terminals read it at spawn
   *  time via resolveTerminalSettings. */
  setFontOverride(fontOverride) {
    this.fontOverride = fontOverride || null;
    this.applyFontSettings();
  }

  _fit(ptyId) {
    const entry = this.tabs.get(ptyId);
    if (!entry || !entry.term || !this.visible()) return;
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
    this._closeAddMenu();
    clearTimeout(this._noticeTimer);
    // force=true: a dispose (project delete/shelve) must never be blocked by a
    // content tab's unsaved-edits prompt.
    for (const id of [...this.tabs.keys()]) this.closeTerminal(id, true);
    this.root.remove();
    // Only drop the registry slot when it still points at THIS group — a
    // replacement group for the same prefix must not be unregistered.
    if (groupsByPrefix.get(this.idPrefix) === this) groupsByPrefix.delete(this.idPrefix);
    emitTabsChange();
  }
}
