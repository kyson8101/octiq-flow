// File preview pane — a SINGLE dedicated column to the right of the terminal
// area (card: 4-column project layout: sidebar | terminals | file preview |
// docked tree). Replaces the old content-tab model (filetabs.js, retired):
// browser.js's file clicks now render here instead of as a tab in the
// terminal strip. One file at a time — opening another file swaps this same
// pane's content in place (confirming first if the current file has unsaved
// edits). The read/save/Monaco plumbing below is the old content-tab pane's,
// unchanged in behavior.
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
// Text files edit in Monaco (⌘S or the head Save button saves; a tinted Save
// button flags unsaved edits; closing the pane or switching to a different
// file with unsaved edits confirms first). Images and PDFs render inline;
// other binaries offer "Open externally".
const { invoke, convertFileSrc } = window.__TAURI__.core;
import { closeMainPanel } from "/layout.js";
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
const nameEl = document.querySelector("#fp-name");
const statusEl = document.querySelector("#fp-status");
const saveBtn = document.querySelector("#fp-save");
const openBtn = document.querySelector("#fp-open-external");
const closeBtn = document.querySelector("#fp-close");
const bodyEl = document.querySelector("#fp-body");

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

// --- State: one file at a time -----------------------------------------------
// `current` is null while the pane is closed. `st.closed` guards a disposed
// pane/swapped file against an in-flight read_file_preview landing late.
let current = null;

/** A single-line message node for the pane body (loading / error / binary). */
function bodyMessage(text) {
  return textEl("div", "ft-msg", text);
}

/** Scroll the editor to `line` (1-based) and put the caret there. */
function gotoLine(st, line) {
  if (!st.editor || !line) return;
  st.editor.revealLineInCenter(line);
  st.editor.setPosition({ lineNumber: line, column: 1 });
}

/** Briefly show a save result ("Saved" or an error) beside the file name. */
function flashStatus(text, isError) {
  statusEl.textContent = text;
  statusEl.classList.toggle("err", !!isError);
}

/** Flag/clear unsaved edits: tinted Save button. */
function setDirty(on) {
  current.dirty = on;
  saveBtn.classList.toggle("dirty", on);
}

/** True when the pane holds unsaved edits — gates the discard confirm. */
function isDirty() {
  return !!current?.dirty;
}

/** Ask before losing unsaved edits; true when it is safe to proceed
 *  (nothing dirty, or the user confirmed the discard). */
function confirmDiscard() {
  return !isDirty() || confirm("You have unsaved changes. Discard them?");
}

/** Write the pane's current text back to disk via the backend. */
async function saveCurrent() {
  if (!current?.editable || !current.editor || saveBtn.disabled) return;
  saveBtn.disabled = true;
  try {
    const content = current.editor.getModel().getValue();
    await invoke("write_file", { path: current.path, content });
    if (current && !current.closed) {
      setDirty(false);
      flashStatus("Saved");
    }
  } catch (err) {
    if (current && !current.closed) flashStatus(String(err), true);
  } finally {
    saveBtn.disabled = false;
  }
}

/** Open the current file with the OS default app via the opener plugin. */
function openExternally() {
  if (!current) return;
  invoke("plugin:opener|open_path", { path: current.path, with: null }).catch((err) => {
    bodyEl.replaceChildren(bodyMessage(`Could not open file: ${err}`));
  });
}

/** Tear down a retired file's editor + model so its URI is free for a re-open. */
function disposeEditor(st) {
  st.closed = true;
  if (st.editor) {
    const model = st.editor.getModel();
    st.editor.dispose();
    model?.dispose();
    st.editor = null;
  }
}

/** Hide the pane and forget the current file (no confirm — callers that need
 *  one check confirmDiscard() first). */
function closePane() {
  if (current) disposeEditor(current);
  current = null;
  previewEl.classList.add("hidden");
  resizerEl.classList.add("hidden");
}

closeBtn.addEventListener("click", () => {
  if (!confirmDiscard()) return;
  closePane();
});
saveBtn.addEventListener("click", saveCurrent);
openBtn.addEventListener("click", openExternally);

// ⌘S / Ctrl+S saves while anything in the pane (the editor) is focused.
previewEl.addEventListener("keydown", (e) => {
  if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "s") {
    e.preventDefault();
    saveCurrent();
  }
});

/** Load `st`'s file into the pane body: Monaco for text, inline image/PDF, an
 *  "open externally" hint for other binaries. `line` jumps a text file to a
 *  1-based line (a content-search hit). */
async function loadContent(st, line) {
  bodyEl.replaceChildren(bodyMessage("Loading…"));

  let preview;
  try {
    preview = await invoke("read_file_preview", { path: st.path });
  } catch (err) {
    if (st.closed) return;
    bodyEl.replaceChildren(bodyMessage(String(err)));
    return;
  }
  if (st.closed) return; // pane closed or swapped to another file mid-read

  // Image: load the file itself via the asset protocol, centered + scaled.
  if (preview.kind === "image") {
    const img = document.createElement("img");
    img.className = "ft-img";
    img.alt = st.name;
    img.src = convertFileSrc(st.path);
    img.addEventListener("error", () => {
      bodyEl.replaceChildren(
        bodyMessage("Could not show this image. Use “Open externally” to view it."),
      );
    });
    const wrap = textEl("div", "ft-media");
    wrap.append(img);
    bodyEl.replaceChildren(wrap);
    return;
  }

  // PDF: the webview's built-in viewer in an iframe.
  if (preview.kind === "pdf") {
    const frame = document.createElement("iframe");
    frame.className = "ft-pdf";
    frame.title = st.name;
    frame.src = convertFileSrc(st.path);
    bodyEl.replaceChildren(frame);
    return;
  }

  if (preview.kind === "binary") {
    bodyEl.replaceChildren(
      bodyMessage(
        `This file is not text (${formatBytes(preview.size)}). Use “Open externally” to view it.`,
      ),
    );
    return;
  }

  // Text: a Monaco editor, editable unless the read was truncated (saving a
  // truncated buffer would drop the unread tail).
  let monaco;
  try {
    monaco = await loadMonaco();
  } catch (err) {
    if (!st.closed) bodyEl.replaceChildren(bodyMessage(String(err)));
    return;
  }
  if (st.closed) return;

  st.editable = !preview.truncated;
  const host = textEl("div", "ft-monaco");
  bodyEl.classList.add("monaco-host");
  if (st.editable) {
    bodyEl.replaceChildren(host);
  } else {
    const why = `Large file (${formatBytes(preview.size)}) — showing the first part only, read-only. Open externally for the full file.`;
    bodyEl.replaceChildren(textEl("div", "ft-note", why), host);
  }

  // A model per file: the file Uri makes Monaco pick the language from the
  // extension. A stray model with the same path (e.g. a crashed prior open)
  // is disposed first so createModel never throws on a taken Uri.
  const uri = monaco.Uri.file(st.path);
  monaco.editor.getModel(uri)?.dispose();
  const model = monaco.editor.createModel(preview.content, undefined, uri);
  st.editor = monaco.editor.create(host, {
    model,
    theme: "vs-dark",
    automaticLayout: true, // relayout on pane resize / dock drag
    readOnly: !st.editable,
    fontSize: 12,
    scrollBeyondLastLine: false,
  });

  if (st.editable) {
    model.onDidChangeContent(() => {
      if (current !== st) return; // a stale editor from a since-swapped file
      setDirty(true);
      statusEl.textContent = "";
    });
    saveBtn.classList.remove("hidden");
  }

  gotoLine(st, line);
}

/** Open `path` in the preview pane (or just jump the line if it is already
 *  the file showing). Confirms before discarding unsaved edits in a
 *  DIFFERENT file; cancelling keeps the current file untouched. */
function openFile({ path, name, line = 0 }) {
  if (!path) return;

  if (current?.path === path) {
    gotoLine(current, line);
    return;
  }
  if (!confirmDiscard()) return;

  // The git diff ("main" mode) would otherwise hide the terminal area — and
  // this pane along with it, since both live in #center-main. Give it back
  // so the newly opened file is actually visible.
  closeMainPanel();

  if (current) disposeEditor(current);
  const st = {
    path,
    name: name || path,
    projectId: activeProjectId,
    dirty: false,
    editable: false,
    closed: false,
    editor: null,
  };
  current = st;

  // Reset the shared head chrome for the new file — it is reused across
  // opens, unlike the old per-tab pane which built a fresh one each time.
  nameEl.textContent = st.name;
  nameEl.title = st.path;
  statusEl.textContent = "";
  statusEl.classList.remove("err");
  saveBtn.classList.add("hidden");
  saveBtn.classList.remove("dirty");
  bodyEl.classList.remove("monaco-host");

  previewEl.classList.remove("hidden");
  resizerEl.classList.remove("hidden");
  previewEl.style.width = `${loadPaneWidth(WIDTH_KEY, MIN_WIDTH, DEFAULT_WIDTH)}px`;

  loadContent(st, line);
}

window.addEventListener("file-open", (e) => openFile(e.detail || {}));

// The project a file was opened from, so switching AWAY from it (not just
// re-selecting the same project — selectWorkspace() re-emits unconditionally)
// closes the preview. Mirrors browsingProjectId / projId in browser.js and
// webpreview.js. A project switch has already happened by the time this event
// fires — there is no "current" project left to keep if a confirm were
// cancelled — so a genuine switch closes outright, without asking.
let activeProjectId = null;
window.addEventListener("project-selected", (e) => {
  const id = e.detail?.id ?? null;
  if (current && id !== current.projectId) closePane();
  activeProjectId = id;
});
