// Frontend: render the PTY stream with xterm.js and inject text into it.
// `Terminal` and `FitAddon` come from the vendored scripts in index.html.
const { invoke } = window.__TAURI__.core;
const { listen } = window.__TAURI__.event;

const term = new Terminal({
  fontFamily: "Menlo, Monaco, 'Courier New', monospace",
  fontSize: 13,
  cursorBlink: true,
  // Dark theme to match the page.
  theme: {
    background: "#0d1117",
    foreground: "#c9d1d9",
    cursor: "#58a6ff",
    selectionBackground: "#264f78",
  },
});

const fitAddon = new FitAddon.FitAddon();
term.loadAddon(fitAddon);

const statusEl = document.querySelector("#status");
const injectInput = document.querySelector("#inject-input");

/** Send raw text to the PTY. The shell cannot tell this from real typing. */
function inject(data) {
  invoke("pty_write", { data }).catch((err) => {
    statusEl.textContent = `write error: ${err}`;
  });
}

/** Resize the PTY to match the visible terminal grid. */
function syncSize() {
  try {
    fitAddon.fit();
    invoke("pty_resize", { rows: term.rows, cols: term.cols }).catch(() => {});
  } catch (_) {
    // Terminal not mounted yet; ignore.
  }
}

window.addEventListener("DOMContentLoaded", () => {
  term.open(document.querySelector("#terminal"));
  syncSize();

  // Stream backend PTY output into the terminal view.
  listen("pty-output", (event) => {
    statusEl.textContent = "connected";
    term.write(event.payload);
  });

  // Forward real keystrokes typed in the terminal back to the PTY.
  term.onData((data) => inject(data));

  // Keep the PTY size in step with the window.
  window.addEventListener("resize", syncSize);

  // --- Injection buttons ---------------------------------------------------
  // "Launch Claude": type the command and press Enter.
  document.querySelector("#launch-claude").addEventListener("click", () => {
    inject("claude\r");
    term.focus();
  });

  // "Inject": put the text on the prompt line but do NOT submit.
  document.querySelector("#inject-text").addEventListener("click", () => {
    inject(injectInput.value);
    term.focus();
  });

  // "Inject + Enter": put the text on the line and submit it.
  document.querySelector("#inject-enter").addEventListener("click", () => {
    inject(injectInput.value + "\r");
    injectInput.value = "";
    term.focus();
  });

  // Enter inside the input box behaves like "Inject + Enter".
  injectInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      inject(injectInput.value + "\r");
      injectInput.value = "";
      term.focus();
    }
  });

  term.focus();
});
