// File tabs (card: layout manager) — a clicked file opens INSIDE the terminal
// tab strip as a content tab (the VS Code editor-tab pattern), replacing the
// old side preview pane.
//
// browser.js dispatches `file-open` { path, name, line } for every file click
// (sidebar tree, center tree, search hits). The tab mounts in the CURRENT
// project's terminal group; re-opening the same path reveals its existing tab
// (and a search hit jumps it to the matching line). Text files edit in Monaco
// — save with ⌘S or the head button, a dirty dot on the tab, a confirm before
// closing unsaved edits. Images and PDFs render inline; other binary files
// offer "Open externally". File tabs are not persisted across restarts.
const { invoke, convertFileSrc } = window.__TAURI__.core;
import { currentProjectGroup } from "/project.js";
import { closeMainPanel } from "/layout.js";
import { formatBytes, textEl } from "/util.js";

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

// tabId -> per-tab state. One state object per open file tab; the group itself
// dedupes tabs by path, this map lets a re-open find the live editor.
const states = new Map();

/** A single-line message node for a tab body (loading / error / binary). */
function bodyMessage(text) {
  return textEl("div", "ft-msg", text);
}

/** Scroll a tab's editor to `line` (1-based) and put the caret there. */
function gotoLine(st, line) {
  if (!st.editor || !line) return;
  st.editor.revealLineInCenter(line);
  st.editor.setPosition({ lineNumber: line, column: 1 });
}

/** Briefly show a save result ("Saved" or an error) beside the file name. */
function flashStatus(st, text, isError) {
  st.statusEl.textContent = text;
  st.statusEl.classList.toggle("err", !!isError);
}

/** Flag/clear unsaved edits: tab dot + tinted Save button. */
function setDirty(st, on) {
  st.dirty = on;
  st.handle?.setDirty(on);
  st.saveBtn.classList.toggle("dirty", on);
}

/** Write the tab's current text back to disk via the backend. */
async function saveTab(st) {
  if (!st.editable || !st.editor || st.saveBtn.disabled) return;
  st.saveBtn.disabled = true;
  try {
    const content = st.editor.getModel().getValue();
    await invoke("write_file", { path: st.path, content });
    if (!st.closed) {
      setDirty(st, false);
      flashStatus(st, "Saved");
    }
  } catch (err) {
    if (!st.closed) flashStatus(st, String(err), true);
  } finally {
    st.saveBtn.disabled = false;
  }
}

/** Open a file with the OS default app via the opener plugin. */
function openExternally(st) {
  invoke("plugin:opener|open_path", { path: st.path, with: null }).catch((err) => {
    st.bodyEl.replaceChildren(bodyMessage(`Could not open file: ${err}`));
  });
}

/** Tear down a closed tab's editor + model so its URI is free for a re-open. */
function disposeEditor(st) {
  st.closed = true;
  if (st.editor) {
    const model = st.editor.getModel();
    st.editor.dispose();
    model?.dispose();
    st.editor = null;
  }
}

/** Build the tab pane: a slim head (name · status · save / open-externally)
 *  over the content body. */
function buildPane(paneEl, st) {
  const head = textEl("div", "ft-head");
  const nameEl = textEl("span", "ft-name", st.name);
  nameEl.title = st.path;
  st.statusEl = textEl("span", "ft-status");

  const actions = textEl("span", "ft-actions");
  st.saveBtn = document.createElement("button");
  st.saveBtn.type = "button";
  st.saveBtn.className = "icon-btn ft-save hidden";
  st.saveBtn.dataset.tip = "Save (⌘S)";
  st.saveBtn.innerHTML =
    '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z"/><path d="M17 21v-8H7v8"/><path d="M7 3v5h8"/></svg>';
  st.saveBtn.addEventListener("click", () => saveTab(st));

  const openBtn = document.createElement("button");
  openBtn.type = "button";
  openBtn.className = "icon-btn";
  openBtn.dataset.tip = "Open with the default app";
  openBtn.innerHTML =
    '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M15 3h6v6"/><path d="M10 14 21 3"/><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/></svg>';
  openBtn.addEventListener("click", () => openExternally(st));

  actions.append(st.saveBtn, openBtn);
  head.append(nameEl, st.statusEl, actions);

  st.bodyEl = textEl("div", "ft-body");

  const wrap = textEl("div", "ft");
  wrap.append(head, st.bodyEl);
  paneEl.append(wrap);

  // ⌘S / Ctrl+S saves while anything in this pane (the editor) is focused.
  paneEl.addEventListener("keydown", (e) => {
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "s") {
      e.preventDefault();
      saveTab(st);
    }
  });
}

/** Load the file into the tab body: Monaco for text, inline image/PDF, an
 *  "open externally" hint for other binaries. `line` jumps a text file to a
 *  1-based line (a content-search hit). */
async function loadContent(st, line) {
  st.bodyEl.replaceChildren(bodyMessage("Loading…"));

  let preview;
  try {
    preview = await invoke("read_file_preview", { path: st.path });
  } catch (err) {
    if (st.closed) return;
    st.bodyEl.replaceChildren(bodyMessage(String(err)));
    return;
  }
  if (st.closed) return; // tab closed while the read was in flight

  // Image: load the file itself via the asset protocol, centered + scaled.
  if (preview.kind === "image") {
    const img = document.createElement("img");
    img.className = "ft-img";
    img.alt = st.name;
    img.src = convertFileSrc(st.path);
    img.addEventListener("error", () => {
      st.bodyEl.replaceChildren(
        bodyMessage("Could not show this image. Use “Open externally” to view it."),
      );
    });
    const wrap = textEl("div", "ft-media");
    wrap.append(img);
    st.bodyEl.replaceChildren(wrap);
    return;
  }

  // PDF: the webview's built-in viewer in an iframe.
  if (preview.kind === "pdf") {
    const frame = document.createElement("iframe");
    frame.className = "ft-pdf";
    frame.title = st.name;
    frame.src = convertFileSrc(st.path);
    st.bodyEl.replaceChildren(frame);
    return;
  }

  if (preview.kind === "binary") {
    st.bodyEl.replaceChildren(
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
    if (!st.closed) st.bodyEl.replaceChildren(bodyMessage(String(err)));
    return;
  }
  if (st.closed) return;

  st.editable = !preview.truncated;
  const host = textEl("div", "ft-monaco");
  st.bodyEl.classList.add("monaco-host");
  if (st.editable) {
    st.bodyEl.replaceChildren(host);
  } else {
    const why = `Large file (${formatBytes(preview.size)}) — showing the first part only, read-only. Open externally for the full file.`;
    st.bodyEl.replaceChildren(textEl("div", "ft-note", why), host);
  }

  // A model per file: the file Uri makes Monaco pick the language from the
  // extension. A stray model with the same path (e.g. a crashed prior tab) is
  // disposed first so createModel never throws on a taken Uri.
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
      setDirty(st, true);
      st.statusEl.textContent = "";
    });
    st.saveBtn.classList.remove("hidden");
  }

  gotoLine(st, line);
}

/** Open `path` as a tab in the current project's group (or reveal its tab). */
function openFile({ path, name, line = 0 }) {
  if (!path) return;
  const group = currentProjectGroup();
  if (!group) return; // no project open — the tree is not visible then anyway

  // If the git diff has taken over the terminal area, give it back — the new
  // tab must be visible. A side panel (the tree just clicked) stays open.
  closeMainPanel();

  const st = {
    path,
    name: name || path,
    dirty: false,
    editable: false,
    closed: false,
    editor: null,
    handle: null,
    bodyEl: null,
    statusEl: null,
    saveBtn: null,
  };
  const handle = group.newContentTab({
    key: path,
    title: st.name,
    mount: (paneEl) => buildPane(paneEl, st),
    beforeClose: () => !st.dirty || confirm("You have unsaved changes. Discard them?"),
    onClose: () => {
      disposeEditor(st);
      states.delete(handle.id);
    },
    onShow: () => states.get(handle.id)?.editor?.focus(),
  });

  if (handle.existed) {
    // Already open: the group revealed it; just jump a search hit to its line.
    const live = states.get(handle.id);
    if (live && line) gotoLine(live, line);
    return;
  }

  st.handle = handle;
  states.set(handle.id, st);
  loadContent(st, line);
}

window.addEventListener("file-open", (e) => openFile(e.detail || {}));
