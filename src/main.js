// Frontend: manage one or more keyed PTYs with xterm.js.
// Card 01 boots a single "main" terminal; later cards add more by reusing
// the same spawn + route pattern set up here.
// `Terminal` and `FitAddon` come from the vendored scripts in index.html.
const { invoke } = window.__TAURI__.core;
const { listen } = window.__TAURI__.event;

const statusEl = document.querySelector("#status");

// Shared dark theme + font for every terminal we open.
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

// id -> { term, fitAddon } for every live PTY view. Card 01 only has "main",
// but the router and helpers are written so later cards just add entries.
const terminals = new Map();

/** Send raw text to the PTY with this id. The shell cannot tell it from typing. */
function inject(id, data) {
  invoke("pty_write", { id, data }).catch((err) => {
    statusEl.textContent = `write error: ${err}`;
  });
}

/** Resize the PTY with this id to match its visible terminal grid. */
function syncSize(id) {
  const entry = terminals.get(id);
  if (!entry) return;
  try {
    entry.fitAddon.fit();
    invoke("pty_resize", { id, rows: entry.term.rows, cols: entry.term.cols }).catch(
      () => {},
    );
  } catch (_) {
    // Terminal not mounted yet; ignore.
  }
}

/**
 * Open an xterm view bound to `mountEl`, spawn its backing PTY with `id`,
 * wire keystrokes + resize, and remember it in the map.
 * cwd "" => backend default (HOME). startCmd null => login shell only.
 */
async function openTerminal(id, mountEl, { cwd = "", startCmd = null } = {}) {
  const term = makeTerminal();
  const fitAddon = new FitAddon.FitAddon();
  term.loadAddon(fitAddon);
  term.open(mountEl);

  terminals.set(id, { term, fitAddon });
  syncSize(id);

  // Forward real keystrokes typed in this terminal to its PTY.
  term.onData((data) => inject(id, data));

  // Note the Tauri camelCase mapping: Rust `start_cmd` -> JS `startCmd`.
  await invoke("pty_spawn", { id, cwd, startCmd });
  return term;
}

window.addEventListener("DOMContentLoaded", async () => {
  // Card 01: one boot terminal with the fixed id "main".
  await openTerminal("main", document.querySelector("#terminal"), {
    cwd: "",
    startCmd: null,
  });

  // Route every PTY chunk to the matching terminal by id.
  // Payload is now an object { id, chunk } (was a bare string).
  listen("pty-output", (event) => {
    const { id, chunk } = event.payload;
    statusEl.textContent = "connected";
    terminals.get(id)?.term.write(chunk);
  });

  // Keep every open terminal sized to the window.
  window.addEventListener("resize", () => {
    for (const id of terminals.keys()) syncSize(id);
  });

  terminals.get("main")?.term.focus();
});
