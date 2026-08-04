// File preview pane — a dedicated column to the right of the terminal area
// (card: 4-column project layout: sidebar | terminals | file preview | docked
// tree). Replaces the old content-tab model (filetabs.js, retired): browser.js's
// file clicks render here instead of as a tab in the terminal strip.
//
// card 52 — MULTI-FILE TABS. The pane used to hold ONE file: opening file B
// threw file A away (after a "discard changes?" nag). It now works like a VS
// Code editor group: every opened path becomes a TAB in #fp-tabs, and the pane
// keeps them all alive at once.
//   - `openFiles` (Map, keyed by absolute path) is the whole state; `activePath`
//     says which tab is showing.
//   - ONE shared Monaco editor is created lazily on the first text file and kept
//     for the pane's lifetime. Switching tabs swaps its MODEL
//     (saveViewState → setModel → restoreViewState), which is exactly how VS
//     Code editor groups work: undo history lives in the model, so it survives a
//     switch for free, and only one editor ever costs layout/DOM.
//   - Switching tabs NEVER asks to discard. The only confirms left are closing a
//     dirty tab and closing the whole pane while any tab is dirty.
//   - Non-text files (image / pdf / binary) are tabs too. They render into a
//     separate `altEl` box; the Monaco host is shown only for text tabs.
//
// card 53 — the editor is themed from the app's TERMINAL palette (settings.js)
// instead of stock `vs-dark`, and re-themed live when the terminal settings
// change, so the editor and the terminals never look like two different apps.
//
// Layout ownership: #file-preview is a plain child of #center-main (see
// index.html), NOT one of layout.js's registered panels — that manager only
// arbitrates the mutually-exclusive tree / web-preview / git-diff panels.
// #center-main wraps just .center-terms + this pane in a row that never
// flips direction, so the preview always sits to the terminals' right no
// matter which side layout.js docks the OTHER panel to (see the CSS comment
// on .center-main in styles.css). Sizing uses the same fixed-width +
// makeResizer() helper (card 26) as the canvas pane — the preview's right
// edge is the one that stays put during a drag, same shape of problem.
//
// browser.js dispatches `file-open` { path, name, line } for every file click
// (sidebar tree, center tree, search hits) — same event contract as before.
// card 55 — LIVE RELOAD. A tab used to show the bytes read when it was opened
// and nothing else: an agent rewriting the file two columns to the left left the
// pane stale until the tab was closed and re-opened. The open paths are now
// registered with a backend fs watcher (file_watch.rs), and a `file-changed`
// event re-reads them in place. A tab with UNSAVED edits is never overwritten —
// it is marked stale instead, so the user's typing always wins.
const { invoke, convertFileSrc } = window.__TAURI__.core;
const { listen } = window.__TAURI__.event;
import { closeMainPanel } from "/layout.js";
import { getTerminalSettings, TERMINAL_SETTINGS_CHANGED } from "/settings.js";
import { formatBytes, loadPaneWidth, makeResizer, textEl } from "/util.js";

// --- Monaco (lazy) -----------------------------------------------------------
// Resolves to the global `monaco` API, injecting the vendored AMD loader on
// first use. Lazy so the AMD `define`/`require` globals only exist after every
// startup UMD script (xterm, marked) has run, and so startup never pays the
// editor's load cost. editor.main.js injects its own stylesheet. Language
// workers may fail to start under the tauri:// protocol in release builds;
// Monaco then falls back to running language services on the main thread.
let monacoPromise = null;
function loadMonaco() {
  monacoPromise ??= new Promise((resolve, reject) => {
    const script = document.createElement("script");
    script.src = "/vendor/monaco/vs/loader.js";
    script.onload = () => {
      window.require.config({ paths: { vs: "/vendor/monaco/vs" } });
      window.require(["vs/editor/editor.main"], () => resolve(window.monaco), reject);
    };
    script.onerror = () => reject(new Error("Could not load the code editor."));
    document.head.append(script);
  });
  return monacoPromise;
}

// --- DOM handles -------------------------------------------------------------
const previewEl = document.querySelector("#file-preview");
const resizerEl = document.querySelector("#file-preview-resizer");
const tabsEl = document.querySelector("#fp-tabs");
const nameEl = document.querySelector("#fp-name");
const statusEl = document.querySelector("#fp-status");
const saveBtn = document.querySelector("#fp-save");
const openBtn = document.querySelector("#fp-open-external");
const closeBtn = document.querySelector("#fp-close");
const bodyEl = document.querySelector("#fp-body");

// The body's three PERMANENT children (card 52). They are built once and only
// shown/hidden, never replaced: the Monaco host in particular must keep the same
// element for the pane's lifetime, because the shared editor is mounted in it
// and re-parenting a live editor is what makes it mis-measure.
//   noteEl — the truncated-read warning, above the editor, text tabs only.
//   altEl  — everything that is not Monaco (loading / error / image / pdf).
//   hostEl — the shared Monaco editor's mount point.
const noteEl = textEl("div", "ft-note hidden");
const altEl = textEl("div", "ft-alt hidden");
const hostEl = textEl("div", "ft-monaco hidden");
bodyEl.replaceChildren(noteEl, altEl, hostEl);

// --- Sizing: persisted width + a shared drag-handle helper (util.js, card 26) ---
const WIDTH_KEY = "octiq.filePreview.width";
const MIN_WIDTH = 280;
const DEFAULT_WIDTH = 480;

makeResizer({
  paneEl: previewEl,
  resizerEl,
  storageKey: WIDTH_KEY,
  minWidth: MIN_WIDTH,
  onResize: () => window.dispatchEvent(new Event("resize")), // nudge terminals to refit
});

// --- State: one entry per open tab (card 52) ---------------------------------
// openFiles: absolute path -> {
//   path, name, projectId,
//   kind: "loading" | "text" | "image" | "pdf" | "binary" | "error",
//   message,          // body text for the binary / error kinds
//   dirty, editable,  // editable is false for a TRUNCATED read (see loadContent)
//   truncatedNote,    // the read-only warning shown above the editor, or ""
//   model, viewState, // Monaco per-file state (undo history lives in the model)
//   pendingLine,      // a search hit's line, applied once the read lands
//   closed,           // guards an in-flight read landing after the tab is gone
// }
const openFiles = new Map();
let activePath = null;

// The ONE shared editor + the Monaco API once loaded (card 52/53). Both outlive
// individual tabs AND pane closes: only its model changes.
let sharedEditor = null;
let monacoApi = null;

/** The entry showing right now, or null when the pane is empty. */
function activeEntry() {
  return activePath ? openFiles.get(activePath) || null : null;
}

/** A single-line message node for the pane body (loading / error / binary). */
function bodyMessage(text) {
  return textEl("div", "ft-msg", text);
}

// --- card 53: a Monaco theme built from the terminal palette -----------------

const THEME_NAME = "octiq";

/** A `#rrggbb` string from a `#rgb` or `#rrggbb` one (settings.js allows both).
 *  Monaco's token-rule parser only accepts 6 hex digits. */
function hex6(color) {
  const s = String(color || "").replace("#", "");
  const full = s.length === 3 ? s[0] + s[0] + s[1] + s[1] + s[2] + s[2] : s;
  return /^[0-9a-fA-F]{6}$/.test(full) ? full : "000000";
}

/** `#rrggbb` — the form Monaco's `colors` map wants (its token rules want the
 *  same digits WITHOUT the hash, hence the two helpers). */
function cssHex(color) {
  return `#${hex6(color)}`;
}

/** True when `color` is dark enough that the editor should sit on the dark base
 *  theme. Rec. 601 luma, the same rough test the rest of the app uses by eye. */
function isDarkColor(color) {
  const n = parseInt(hex6(color), 16);
  const r = (n >> 16) & 255;
  const g = (n >> 8) & 255;
  const b = n & 255;
  return (0.299 * r + 0.587 * g + 0.114 * b) / 255 < 0.5;
}

/** (Re)define the "octiq" Monaco theme from the current terminal palette
 *  (card 53). Token colors map onto the ANSI set the terminals already use — a
 *  One-Dark-ish assignment — so code in the editor is colored by the same
 *  palette as agent output two columns to the left. Safe to call repeatedly:
 *  defineTheme overwrites a theme of the same name. */
function defineOctiqTheme(monaco, settings) {
  const t = settings.theme;
  const dark = isDarkColor(t.background);
  monaco.editor.defineTheme(THEME_NAME, {
    base: dark ? "vs-dark" : "vs",
    inherit: true,
    rules: [
      { token: "", foreground: hex6(t.foreground), background: hex6(t.background) },
      { token: "comment", foreground: hex6(t.brightBlack), fontStyle: "italic" },
      { token: "string", foreground: hex6(t.green) },
      { token: "string.escape", foreground: hex6(t.cyan) },
      { token: "regexp", foreground: hex6(t.cyan) },
      { token: "keyword", foreground: hex6(t.magenta) },
      { token: "keyword.operator", foreground: hex6(t.cyan) },
      { token: "operator", foreground: hex6(t.cyan) },
      { token: "number", foreground: hex6(t.yellow) },
      { token: "constant", foreground: hex6(t.yellow) },
      { token: "type", foreground: hex6(t.cyan) },
      { token: "type.identifier", foreground: hex6(t.yellow) },
      { token: "identifier", foreground: hex6(t.red) },
      { token: "variable", foreground: hex6(t.red) },
      { token: "variable.predefined", foreground: hex6(t.yellow) },
      { token: "function", foreground: hex6(t.blue) },
      { token: "attribute.name", foreground: hex6(t.red) },
      { token: "attribute.value", foreground: hex6(t.green) },
      { token: "tag", foreground: hex6(t.red) },
      { token: "delimiter", foreground: hex6(t.white) },
      { token: "metatag", foreground: hex6(t.magenta) },
      { token: "key", foreground: hex6(t.red) },
      { token: "invalid", foreground: hex6(t.brightRed) },
    ],
    colors: {
      "editor.background": cssHex(t.background),
      "editor.foreground": cssHex(t.foreground),
      "editorCursor.foreground": cssHex(t.cursor),
      "editor.selectionBackground": cssHex(t.selectionBackground),
      "editor.inactiveSelectionBackground": cssHex(t.selectionBackground),
      "editor.lineHighlightBorder": cssHex(t.background),
      "editorLineNumber.foreground": cssHex(t.brightBlack),
      "editorLineNumber.activeForeground": cssHex(t.white),
      "editorIndentGuide.background1": cssHex(t.black),
      "editorIndentGuide.activeBackground1": cssHex(t.brightBlack),
      "editorWhitespace.foreground": cssHex(t.brightBlack),
      "editorGutter.background": cssHex(t.background),
      "editorWidget.background": cssHex(t.background),
      "editorSuggestWidget.background": cssHex(t.background),
      "input.background": cssHex(t.background),
      "scrollbarSlider.background": cssHex(t.black),
      "minimap.background": cssHex(t.background),
    },
  });
}

/** Re-theme + re-size the live editor when the terminal appearance changes
 *  (card 53). No-op until Monaco has actually been loaded by a text file. */
window.addEventListener(TERMINAL_SETTINGS_CHANGED, () => {
  if (!monacoApi) return;
  const settings = getTerminalSettings();
  defineOctiqTheme(monacoApi, settings);
  monacoApi.editor.setTheme(THEME_NAME);
  sharedEditor?.updateOptions({ fontSize: settings.fontSize || 12 });
});

/** The shared editor, created on first use (card 52/53). Options are set ONCE
 *  here: per-file state (the model, readOnly) is applied on activation instead.
 *  No keybindings are touched, so Monaco's built-ins — ⌘F find, ⌥-click
 *  multi-cursor, ⌘D, F1 command palette — all keep working. */
function ensureEditor(monaco) {
  if (sharedEditor) return sharedEditor;
  monacoApi = monaco;
  const settings = getTerminalSettings();
  defineOctiqTheme(monaco, settings);
  sharedEditor = monaco.editor.create(hostEl, {
    theme: THEME_NAME,
    automaticLayout: true, // relayout on pane resize / dock drag
    fontSize: settings.fontSize || 12,
    scrollBeyondLastLine: false,
    folding: true,
    bracketPairColorization: { enabled: true },
    minimap: { enabled: false }, // the pane is narrow; a minimap eats a third of it
    readOnly: true, // the first activated model decides the real value
  });
  return sharedEditor;
}

// --- Head chrome -------------------------------------------------------------

/** Briefly show a save result ("Saved" or an error) beside the file name. */
function flashStatus(text, isError) {
  statusEl.textContent = text;
  statusEl.classList.toggle("err", !!isError);
}

/** Repaint the head for the active tab: full path, save button visibility and
 *  its unsaved tint. Called on every activation and dirty change. */
function renderHead() {
  const entry = activeEntry();
  nameEl.textContent = entry ? entry.path : "";
  nameEl.title = entry ? entry.path : "";
  saveBtn.classList.toggle("hidden", !entry?.editable);
  saveBtn.classList.toggle("dirty", !!entry?.dirty);
}

// --- Tab strip (card 52) -----------------------------------------------------

/** Rebuild the whole tab strip. Cheap (a handful of tabs) and it keeps tab DOM
 *  a pure function of `openFiles` + `activePath`, so there is no second place
 *  where a dirty dot or the active mark can drift out of sync.
 *
 *  STYLE: the active tab is marked by a background tint + brighter text ONLY.
 *  Never a left border / left accent bar — that pattern is banned app-wide. */
function renderTabs() {
  const tabs = [];
  for (const entry of openFiles.values()) {
    const tab = textEl("div", "fp-tab");
    if (entry.path === activePath) tab.classList.add("fp-tab-active");
    if (entry.dirty) tab.classList.add("fp-tab-dirty");
    tab.title = entry.path;
    tab.setAttribute("role", "tab");
    tab.append(textEl("span", "fp-tab-label", entry.name));

    const close = textEl("button", "fp-tab-close", "×");
    close.type = "button";
    close.title = "Close file";
    close.setAttribute("aria-label", `Close ${entry.name}`);
    close.addEventListener("click", (e) => {
      e.stopPropagation();
      closeTab(entry.path);
    });
    tab.append(close);

    tab.addEventListener("click", () => activate(entry.path, { focus: true }));
    // Middle-click closes, the same as in a browser / VS Code.
    tab.addEventListener("auxclick", (e) => {
      if (e.button !== 1) return;
      e.preventDefault();
      closeTab(entry.path);
    });
    tabs.push(tab);
  }
  tabsEl.replaceChildren(...tabs);
}

// --- Tab lifecycle -----------------------------------------------------------

/** Stash the active text tab's scroll + caret before its model leaves the
 *  editor, so restoreViewState puts it back exactly where it was. */
function stashViewState() {
  const entry = activeEntry();
  if (!entry || !sharedEditor || !entry.model) return;
  if (sharedEditor.getModel() !== entry.model) return;
  entry.viewState = sharedEditor.saveViewState();
}

/** Show `entry` in the body: the shared Monaco editor for text (model swap), a
 *  freshly built node for every other kind. Non-text bodies are rebuilt on each
 *  activation on purpose — an <img>/<iframe>/message costs nothing, and it keeps
 *  one place that knows how each kind renders. */
function renderBody(entry) {
  if (!entry) {
    noteEl.classList.add("hidden");
    altEl.classList.add("hidden");
    hostEl.classList.add("hidden");
    return;
  }

  const isText = entry.kind === "text" && !!entry.model;
  noteEl.textContent = isText ? entry.truncatedNote || "" : "";
  noteEl.classList.toggle("hidden", !isText || !entry.truncatedNote);
  hostEl.classList.toggle("hidden", !isText);
  altEl.classList.toggle("hidden", isText);

  if (isText) {
    const editor = sharedEditor;
    // Only swap when the model really changes: re-activating the tab that is
    // already showing must NOT restore a view state saved when the user last
    // switched away, or clicking the current tab would yank the scroll back.
    if (editor.getModel() !== entry.model) {
      editor.setModel(entry.model);
      if (entry.viewState) editor.restoreViewState(entry.viewState);
    }
    editor.updateOptions({ readOnly: !entry.editable });
    // The host was display:none a moment ago (or the pane was), so Monaco has a
    // stale size; automaticLayout would catch up a frame later, this is instant.
    editor.layout();
    return;
  }

  altEl.replaceChildren(buildAltBody(entry));
}

/** The asset URL for a media tab, with a cache-busting token (card 55). The
 *  WebView caches `asset://` responses by URL, so a re-render after the file
 *  changed on disk would otherwise redraw the OLD bytes; `mediaToken` is bumped
 *  on every reload to make the URL new. */
function mediaSrc(entry) {
  const url = convertFileSrc(entry.path);
  if (!entry.mediaToken) return url;
  return `${url}${url.includes("?") ? "&" : "?"}v=${entry.mediaToken}`;
}

/** The body node for a non-text tab. */
function buildAltBody(entry) {
  if (entry.kind === "image") {
    const img = document.createElement("img");
    img.className = "ft-img";
    img.alt = entry.name;
    img.src = mediaSrc(entry);
    img.addEventListener("error", () => {
      altEl.replaceChildren(
        bodyMessage("Could not show this image. Use “Open externally” to view it."),
      );
    });
    const wrap = textEl("div", "ft-media");
    wrap.append(img);
    return wrap;
  }

  if (entry.kind === "pdf") {
    const frame = document.createElement("iframe");
    frame.className = "ft-pdf";
    frame.title = entry.name;
    frame.src = mediaSrc(entry);
    return frame;
  }

  return bodyMessage(entry.message || "Loading…");
}

/** Make `path` the showing tab. Switching NEVER asks about unsaved edits — the
 *  edits simply stay in that file's model until it is saved or its tab closes. */
function activate(path, { focus = false } = {}) {
  const entry = openFiles.get(path);
  if (!entry) return;
  if (activePath !== path) {
    stashViewState();
    activePath = path;
  }
  renderTabs();
  renderHead();
  statusEl.textContent = "";
  statusEl.classList.remove("err");
  // A stale warning belongs to the TAB, not to a moment in time: re-show it
  // whenever that tab comes back up (card 55).
  if (entry.stale) flashStatus(STALE_MSG, true);
  renderBody(entry);
  // A search hit that landed while this tab was in the background (or still
  // loading) jumps now that its model is actually in the editor.
  if (entry.pendingLine) gotoLine(entry, entry.pendingLine);
  else if (focus && entry.kind === "text" && sharedEditor) sharedEditor.focus();
}

/** Close one tab. A dirty tab confirms first unless `force` (the project-switch
 *  sweep, which only ever force-closes CLEAN tabs). Returns true when the tab is
 *  gone. Disposing the model is what frees its Uri for a later re-open — and it
 *  must leave the editor first, or the editor is left holding a dead model. */
function closeTab(path, { force = false } = {}) {
  const entry = openFiles.get(path);
  if (!entry) return true;
  if (!force && entry.dirty && !confirm("You have unsaved changes. Discard them?")) return false;

  const order = [...openFiles.keys()];
  const index = order.indexOf(path);

  entry.closed = true; // a read still in flight must not touch the pane
  if (entry.model) {
    if (sharedEditor?.getModel() === entry.model) sharedEditor.setModel(null);
    entry.model.dispose();
    entry.model = null;
  }
  openFiles.delete(path);
  syncWatch();

  if (activePath !== path) {
    renderTabs();
    return true;
  }

  // The closed tab was showing: fall back to its right-hand neighbour, else its
  // left-hand one, else there is nothing left to show.
  activePath = null;
  const next = order[index + 1] && openFiles.has(order[index + 1]) ? order[index + 1] : order[index - 1];
  if (next && openFiles.has(next)) activate(next);
  else closePane();
  return true;
}

/** True while any open tab holds unsaved edits. */
function anyDirty() {
  for (const entry of openFiles.values()) if (entry.dirty) return true;
  return false;
}

/** Hide the pane and drop every tab. The shared editor SURVIVES (only its model
 *  is detached): it is the pane's editor, not the file's, and rebuilding it per
 *  open would re-pay Monaco's create cost for nothing. Callers that need a
 *  confirm do it first — this one just tears down. */
function closePane() {
  for (const entry of openFiles.values()) {
    entry.closed = true;
    if (entry.model) {
      if (sharedEditor?.getModel() === entry.model) sharedEditor.setModel(null);
      entry.model.dispose();
      entry.model = null;
    }
  }
  openFiles.clear();
  syncWatch(); // nothing open: stop watching
  activePath = null;
  sharedEditor?.setModel(null);
  renderTabs();
  renderHead();
  renderBody(null);
  altEl.replaceChildren();
  statusEl.textContent = "";
  statusEl.classList.remove("err");
  previewEl.classList.add("hidden");
  resizerEl.classList.add("hidden");
}

// --- Save / open externally --------------------------------------------------

/** Flag or clear unsaved edits on ONE tab: its dirty dot, plus the head's Save
 *  tint when it is the tab showing. */
function setDirty(entry, on) {
  if (entry.dirty === on) return;
  entry.dirty = on;
  renderTabs();
  if (entry.path === activePath) renderHead();
}

/** Write the ACTIVE tab's text back to disk. Only that tab's dirty dot clears —
 *  every other tab keeps its edits and its dot. A truncated read is never
 *  editable (`entry.editable`), so a partial buffer can never overwrite a file.*/
async function saveActive() {
  const entry = activeEntry();
  if (!entry?.editable || !entry.model || saveBtn.disabled) return;
  saveBtn.disabled = true;
  try {
    const content = entry.model.getValue();
    await invoke("write_file", { path: entry.path, content });
    if (entry.closed) return;
    setDirty(entry, false);
    entry.stale = false; // this buffer IS the file on disk again
    if (activePath === entry.path) flashStatus("Saved");
  } catch (err) {
    if (!entry.closed && activePath === entry.path) flashStatus(String(err), true);
  } finally {
    saveBtn.disabled = false;
  }
}

/** Open the active file with the OS default app via the opener plugin. */
function openExternally() {
  const entry = activeEntry();
  if (!entry) return;
  invoke("plugin:opener|open_path", { path: entry.path, with: null }).catch((err) => {
    altEl.replaceChildren(bodyMessage(`Could not open file: ${err}`));
    hostEl.classList.add("hidden");
    altEl.classList.remove("hidden");
  });
}

closeBtn.addEventListener("click", () => {
  if (anyDirty() && !confirm("You have unsaved changes. Discard them?")) return;
  closePane();
});
saveBtn.addEventListener("click", saveActive);
openBtn.addEventListener("click", openExternally);

// ⌘S / Ctrl+S saves while anything in the pane (the editor) is focused.
previewEl.addEventListener("keydown", (e) => {
  if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "s") {
    e.preventDefault();
    saveActive();
  }
});

// --- Reading a file ----------------------------------------------------------

/** Scroll the editor to `line` (1-based) and put the caret there. Only the
 *  ACTIVE text tab can be scrolled — the editor shows one model at a time — so
 *  a line for a still-loading tab is stashed and applied by loadContent. */
function gotoLine(entry, line) {
  if (!entry || !line) return;
  if (entry.kind !== "text" || !entry.model || activePath !== entry.path || !sharedEditor) {
    entry.pendingLine = line;
    return;
  }
  entry.pendingLine = 0;
  sharedEditor.revealLineInCenter(line);
  sharedEditor.setPosition({ lineNumber: line, column: 1 });
  sharedEditor.focus();
}

/** Read `entry`'s file and fill in its kind + content. Every await is followed
 *  by an `entry.closed` check: the tab can be closed (or the whole pane can be)
 *  while the read is in flight, and a late chunk must not resurrect it. */
async function loadContent(entry, line) {
  let preview;
  try {
    preview = await invoke("read_file_preview", { path: entry.path });
  } catch (err) {
    if (entry.closed) return;
    entry.kind = "error";
    entry.message = String(err);
    if (activePath === entry.path) renderBody(entry);
    return;
  }
  if (entry.closed) return;

  if (preview.kind === "image" || preview.kind === "pdf") {
    entry.kind = preview.kind;
    if (activePath === entry.path) renderBody(entry);
    return;
  }

  if (preview.kind === "binary") {
    entry.kind = "binary";
    entry.message = `This file is not text (${formatBytes(preview.size)}). Use “Open externally” to view it.`;
    if (activePath === entry.path) renderBody(entry);
    return;
  }

  // Text: a Monaco model, editable unless the read was truncated (saving a
  // truncated buffer would drop the unread tail).
  let monaco;
  try {
    monaco = await loadMonaco();
  } catch (err) {
    if (entry.closed) return;
    entry.kind = "error";
    entry.message = String(err);
    if (activePath === entry.path) renderBody(entry);
    return;
  }
  if (entry.closed) return;

  ensureEditor(monaco);
  entry.stale = false;
  entry.editable = !preview.truncated;
  entry.truncatedNote = entry.editable
    ? ""
    : `Large file (${formatBytes(preview.size)}) — showing the first part only, read-only. Open externally for the full file.`;

  // A model per file: the file Uri makes Monaco pick the language from the
  // extension. A stray model with the same path (e.g. a crashed prior open) is
  // disposed first so createModel never throws on a taken Uri.
  const uri = monaco.Uri.file(entry.path);
  monaco.editor.getModel(uri)?.dispose();
  entry.model = monaco.editor.createModel(preview.content, undefined, uri);
  entry.kind = "text";

  if (entry.editable) {
    entry.model.onDidChangeContent(() => {
      if (entry.closed) return;
      if (entry.reloading) return; // a disk reload writing the model, not the user
      setDirty(entry, true);
      if (activePath === entry.path) statusEl.textContent = "";
    });
  }

  if (activePath === entry.path) {
    renderTabs(); // the tab may need its first dirty-dot slot / active repaint
    renderHead();
    renderBody(entry);
  }
  gotoLine(entry, line || entry.pendingLine);
}

// --- card 54: live reload when a file changes on disk ------------------------

/** Shown when a tab the user has EDITED changed underneath them. Their buffer is
 *  left exactly as it is; saving overwrites the newer file on disk. */
const STALE_MSG = "Changed on disk — your unsaved edits are kept";

/** Tell the backend which files to watch: exactly the open tabs. Called after
 *  every change to `openFiles`. Best-effort — a watcher that fails to install
 *  only costs the live refresh, so it must never surface an error at the user. */
function syncWatch() {
  invoke("file_watch_paths", { paths: [...openFiles.keys()] }).catch(() => {});
}

/** Re-read one tab's file after the watcher says it changed.
 *
 *  A DIRTY tab is never overwritten — it is flagged stale and left alone. A
 *  clean text tab keeps its model (so its Uri/language and the editor's scroll
 *  survive) and only swaps the text in; anything else — including a file that
 *  changed KIND, e.g. a text file replaced by a binary — is rebuilt through the
 *  normal load path. */
async function reloadFromDisk(entry) {
  if (entry.closed || entry.reloading) return;
  if (entry.dirty) {
    entry.stale = true;
    if (activePath === entry.path) flashStatus(STALE_MSG, true);
    return;
  }

  entry.reloading = true;
  try {
    let preview;
    try {
      preview = await invoke("read_file_preview", { path: entry.path });
    } catch (err) {
      if (entry.closed) return;
      // Deleted or unreadable now: say so instead of showing stale content.
      if (entry.model) {
        if (sharedEditor?.getModel() === entry.model) sharedEditor.setModel(null);
        entry.model.dispose();
        entry.model = null;
      }
      entry.kind = "error";
      entry.message = String(err);
      if (activePath === entry.path) renderBody(entry);
      return;
    }
    if (entry.closed) return;

    if (preview.kind === "text" && entry.kind === "text" && entry.model) {
      // Our own save echoes back through the watcher; nothing changed then.
      if (entry.model.getValue() === preview.content) return;
      const live = activePath === entry.path && sharedEditor?.getModel() === entry.model;
      const view = live ? sharedEditor.saveViewState() : entry.viewState;
      entry.model.setValue(preview.content);
      if (live) sharedEditor.restoreViewState(view);
      else entry.viewState = view;
      entry.editable = !preview.truncated;
      entry.truncatedNote = entry.editable
        ? ""
        : `Large file (${formatBytes(preview.size)}) — showing the first part only, read-only. Open externally for the full file.`;
      if (activePath === entry.path) {
        renderHead();
        renderBody(entry);
      }
      return;
    }

    // Kind changed, or a media/binary tab: rebuild it from scratch. The media
    // token makes the WebView fetch the new bytes instead of its cached copy.
    if (entry.model) {
      if (sharedEditor?.getModel() === entry.model) sharedEditor.setModel(null);
      entry.model.dispose();
      entry.model = null;
    }
    entry.mediaToken = (entry.mediaToken || 0) + 1;
    entry.kind = "loading";
    entry.reloading = false; // loadContent installs its own change handler
    await loadContent(entry, 0);
  } finally {
    entry.reloading = false;
  }
}

// One watcher event can name several files (a git checkout, a formatter pass).
listen("file-changed", (e) => {
  for (const path of e.payload || []) {
    const entry = openFiles.get(path);
    if (entry) reloadFromDisk(entry);
  }
});

/** Open `path` as a tab (card 52). An already-open path just activates its tab —
 *  and still honours `line`, so a content-search hit jumps inside a file that is
 *  already open. Nothing is ever discarded here: other tabs keep their edits. */
function openFile({ path, name, line = 0 }) {
  if (!path) return;

  showPane();

  const existing = openFiles.get(path);
  if (existing) {
    activate(path, { focus: true });
    gotoLine(existing, line);
    return;
  }

  const entry = {
    path,
    name: name || path,
    projectId: activeProjectId,
    kind: "loading",
    message: "Loading…",
    dirty: false,
    editable: false,
    truncatedNote: "",
    model: null,
    viewState: null,
    pendingLine: line,
    closed: false,
    reloading: false, // true while a disk reload writes the model (card 55)
    stale: false, // the file changed on disk under unsaved edits
    mediaToken: 0, // cache-buster for image/pdf reloads
  };
  openFiles.set(path, entry);
  syncWatch();
  activate(path);
  loadContent(entry, line);
}

/** Reveal the pane (and its drag handle) at the persisted width. */
function showPane() {
  // The git diff ("main" mode) would otherwise hide the terminal area — and this
  // pane along with it, since both live in #center-main. Give it back so the
  // newly opened file is actually visible.
  closeMainPanel();
  previewEl.classList.remove("hidden");
  resizerEl.classList.remove("hidden");
  previewEl.style.width = `${loadPaneWidth(WIDTH_KEY, MIN_WIDTH, DEFAULT_WIDTH)}px`;
}

window.addEventListener("file-open", (e) => openFile(e.detail || {}));

// The project each tab was opened from, so switching AWAY from it (not just
// re-selecting the same project — selectWorkspace() re-emits unconditionally)
// clears the pane. Mirrors browsingProjectId / projId in browser.js and
// webpreview.js.
//
// card 52: a project switch has already happened by the time this event fires,
// so there is nothing to cancel back to — CLEAN tabs from the old project close
// outright, without asking. DIRTY ones are kept instead of silently dropped:
// the pane stays open showing only them, with a note saying where they came
// from. Nothing the user typed is ever thrown away behind their back.
let activeProjectId = null;
window.addEventListener("project-selected", (e) => {
  const id = e.detail?.id ?? null;
  const previousId = activeProjectId;
  activeProjectId = id;
  if (id === previousId || !openFiles.size) return;

  for (const entry of [...openFiles.values()]) {
    if (entry.projectId !== id && !entry.dirty) closeTab(entry.path, { force: true });
  }
  if (!openFiles.size) return; // closeTab already closed the pane

  if (!activePath || !openFiles.has(activePath)) activate([...openFiles.keys()][0]);
  flashStatus("Unsaved file from the previous project");
});
