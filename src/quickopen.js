// Card 54 — ⌘P quick-open palette.
//
// A centered overlay that fuzzy-filters every file under the selected
// project's roots (via the backend `list_project_files` command, which shells
// out to `rg --files` — gitignore-aware, capped + truncation-flagged) and
// opens the pick as an editor tab through the SAME `file-open` CustomEvent
// browser.js already dispatches for tree/search clicks (filepreview.js is the
// one listener; this module never touches it directly).
//
// Ownership: this file owns the palette only — DOM markup lives in
// index.html (#qo-*), styling in styles.css. Project context is mirrored from
// the `project-selected` event exactly like browser.js does (currentProjectId
// / currentPaths), so ⌘P is a no-op until a project is selected.
import { textEl } from "/util.js";

const { invoke } = window.__TAURI__.core;

// --- Project context ---------------------------------------------------------
// Mirrors browser.js's own tracking of the same event (browser.js:433-436) so
// this module needs no import from it — modules talk via window events, not
// direct imports (see CLAUDE.md).
let currentProjectId = null;
let currentPaths = [];

window.addEventListener("project-selected", (e) => {
  currentProjectId = e.detail?.id ?? null;
  currentPaths = (e.detail?.paths || []).map((p) => p.replace(/[/\\]+$/, ""));
  // Switching projects mid-palette would show stale results against the new
  // project's roots, so just close it — reopening re-fetches fresh.
  if (isOpen()) closePalette();
});

// --- DOM handles ---------------------------------------------------------------
let overlayEl, inputEl, listEl, footEl;

document.addEventListener("DOMContentLoaded", () => {
  overlayEl = document.getElementById("qo-overlay");
  inputEl = document.getElementById("qo-input");
  listEl = document.getElementById("qo-list");
  footEl = document.getElementById("qo-foot");

  overlayEl?.addEventListener("click", (e) => {
    if (e.target === overlayEl) closePalette(); // click the dark backdrop
  });
  // A new query reorders the results, so the highlight restarts at the top.
  inputEl?.addEventListener("input", () => {
    highlighted = 0;
    renderResults();
  });
  inputEl?.addEventListener("keydown", onInputKeydown);
});

// --- State -----------------------------------------------------------------
let allFiles = []; // absolute paths, fetched fresh on every open
let filtered = []; // [{ path, name, rel }] currently rendered, in order
let highlighted = 0; // index into `filtered`
let loading = false;
let loadError = "";
let truncated = false;

const MAX_ROWS = 50;

function isOpen() {
  return !!overlayEl && !overlayEl.classList.contains("hidden");
}

/** Open the palette: reset state, fetch the file list fresh, focus the box.
 *  "Fresh" (no cache across opens) is deliberate — rg is fast, and a stale
 *  list would miss files created/removed since the last open. */
async function openPalette() {
  if (!overlayEl || !currentProjectId || currentPaths.length === 0) return;
  overlayEl.classList.remove("hidden");
  inputEl.value = "";
  allFiles = [];
  filtered = [];
  highlighted = 0;
  loading = true;
  loadError = "";
  truncated = false;
  renderResults();
  inputEl.focus();

  try {
    const res = await invoke("list_project_files", { roots: currentPaths });
    allFiles = res?.files || [];
    truncated = !!res?.truncated;
  } catch (err) {
    loadError = String(err?.message || err || "Failed to list files");
  } finally {
    loading = false;
    renderResults();
  }
}

function closePalette() {
  if (!overlayEl) return;
  overlayEl.classList.add("hidden");
}

function togglePalette() {
  if (isOpen()) closePalette();
  else openPalette();
}

// --- Fuzzy filter + scoring -------------------------------------------------
/** Case-insensitive subsequence test: every char of `query` appears in `text`
 *  in order (not necessarily contiguous). Returns the index of the LAST
 *  matched char (used for the "earlier match" tiebreak), or -1 on no match. */
function subsequenceEnd(text, query) {
  let ti = 0;
  let lastMatch = -1;
  for (let qi = 0; qi < query.length; qi++) {
    const ch = query[qi];
    let found = -1;
    for (let i = ti; i < text.length; i++) {
      if (text[i] === ch) {
        found = i;
        break;
      }
    }
    if (found === -1) return -1;
    lastMatch = found;
    ti = found + 1;
  }
  return lastMatch;
}

/** Score one file against the query: lower is better. Prefers a basename
 *  match over a full-path-only match, then a shorter path, then an earlier
 *  match position within whichever string matched. Returns null on no match. */
function scoreFile(path, name, query) {
  if (!query) return { basenameMatch: true, tier: 0, len: path.length, pos: 0 };
  const lowerName = name.toLowerCase();
  const lowerPath = path.toLowerCase();

  const nameEnd = subsequenceEnd(lowerName, query);
  if (nameEnd !== -1) {
    return { tier: 0, len: path.length, pos: nameEnd };
  }
  const pathEnd = subsequenceEnd(lowerPath, query);
  if (pathEnd !== -1) {
    return { tier: 1, len: path.length, pos: pathEnd };
  }
  return null;
}

function compareScores(a, b) {
  if (a.tier !== b.tier) return a.tier - b.tier; // basename hits first
  if (a.len !== b.len) return a.len - b.len; // shorter paths first
  return a.pos - b.pos; // earlier match position first
}

/** Strip whichever currentPaths root prefixes `path`, for the dimmed
 *  relative-path label. Falls back to the full path if no root matches. */
function relativeTo(path) {
  for (const root of currentPaths) {
    if (path === root) return "";
    if (path.startsWith(root + "/") || path.startsWith(root + "\\")) {
      return path.slice(root.length + 1);
    }
  }
  return path;
}

function baseNameOf(path) {
  const trimmed = path.replace(/[/\\]+$/, "");
  const parts = trimmed.split(/[/\\]/);
  return parts[parts.length - 1] || path;
}

function computeFiltered() {
  const query = (inputEl?.value || "").trim().toLowerCase();
  if (!query) {
    return allFiles.slice(0, MAX_ROWS).map((path) => ({
      path,
      name: baseNameOf(path),
      rel: relativeTo(path),
    }));
  }
  const scored = [];
  for (const path of allFiles) {
    const name = baseNameOf(path);
    const score = scoreFile(path, name, query);
    if (score) scored.push({ path, name, rel: relativeTo(path), score });
  }
  scored.sort((a, b) => compareScores(a.score, b.score));
  return scored.slice(0, MAX_ROWS);
}

// --- Rendering ---------------------------------------------------------------
function renderResults() {
  if (!listEl) return;
  listEl.replaceChildren();

  if (loading) {
    listEl.append(textEl("li", "qo-msg", "Loading…"));
    setFoot("");
    return;
  }
  if (loadError) {
    listEl.append(textEl("li", "qo-msg qo-msg-error", loadError));
    setFoot("");
    return;
  }

  filtered = computeFiltered();
  if (highlighted >= filtered.length) highlighted = 0;

  if (filtered.length === 0) {
    listEl.append(textEl("li", "qo-msg", "No matches"));
    setFoot(truncated ? "File list truncated" : "");
    return;
  }

  filtered.forEach((item, i) => {
    const row = document.createElement("li");
    row.className = "qo-row" + (i === highlighted ? " active" : "");
    row.append(
      textEl("span", "qo-row-name", item.name),
      textEl("span", "qo-row-rel", item.rel),
    );
    row.addEventListener("mouseenter", () => setHighlighted(i, false));
    row.addEventListener("click", () => openHighlighted(i));
    listEl.append(row);
  });

  const shown = filtered.length;
  const parts = [`Showing ${shown} of ${allFiles.length}`];
  if (truncated) parts.push("file list truncated");
  setFoot(parts.join(" · "));
}

function setFoot(text) {
  if (footEl) footEl.textContent = text;
}

function setHighlighted(i, scroll = true) {
  highlighted = i;
  const rows = listEl.querySelectorAll(".qo-row");
  rows.forEach((r, idx) => r.classList.toggle("active", idx === i));
  if (scroll) rows[i]?.scrollIntoView({ block: "nearest" });
}

function openHighlighted(i) {
  const item = filtered[i];
  if (!item) return;
  window.dispatchEvent(
    new CustomEvent("file-open", { detail: { path: item.path, name: item.name } }),
  );
  closePalette();
}

// --- Keyboard inside the palette --------------------------------------------
function onInputKeydown(e) {
  if (e.key === "ArrowDown") {
    e.preventDefault();
    if (filtered.length === 0) return;
    setHighlighted((highlighted + 1) % filtered.length);
  } else if (e.key === "ArrowUp") {
    e.preventDefault();
    if (filtered.length === 0) return;
    setHighlighted((highlighted - 1 + filtered.length) % filtered.length);
  } else if (e.key === "Enter") {
    e.preventDefault();
    openHighlighted(highlighted);
  } else if (e.key === "Escape") {
    e.preventDefault();
    closePalette();
  }
}

// --- Global shortcut: ⌘P (macOS) / Ctrl+P (elsewhere) -----------------------
// Capture phase + preventDefault/stopPropagation BEFORE xterm's hidden helper
// textarea sees the keystroke, same precedent as the ⌘. attention-cycle
// handler (alerts.js:178-186). ⌘⇧P is left alone (Shift excluded) so it stays
// free for a future command palette.
function onGlobalKeydown(e) {
  if (e.key.toLowerCase() !== "p") return;
  const mod = navigator.platform.toUpperCase().includes("MAC") ? e.metaKey : e.ctrlKey;
  if (!mod || e.shiftKey || e.altKey) return;
  e.preventDefault();
  e.stopPropagation();
  togglePalette();
}

window.addEventListener("keydown", onGlobalKeydown, true);
