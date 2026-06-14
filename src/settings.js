// Terminal appearance settings — font family, font size, line height — picked on
// the Settings page (the gear in the mode bar). Two parts in one file, matching
// the project style (see modes.js): a pure state layer at the top that knows
// nothing about the DOM, and a DOM-wiring block at the bottom that runs on
// DOMContentLoaded.
//
// State is saved to localStorage (the same store the mode router uses), so the
// pick survives a restart with no backend involved. On every change we fire a
// window event (TERMINAL_SETTINGS_CHANGED) so terminals.js can apply the new
// font to every OPEN terminal live — no need to reopen anything.
//
// The font catalog mixes two kinds of family:
//   - bundled — shipped with the app as woff2 + @font-face (styles.css), so it
//     always renders regardless of what is installed (Fira Code, JetBrains Mono).
//   - system — only renders if the font is installed on this machine; its CSS
//     stack falls back to a generic monospace otherwise.

const { invoke } = window.__TAURI__.core;

// ---- Pure state layer -----------------------------------------------------

/** The terminal font choices shown in the picker. `stack` is the CSS
 *  font-family value handed to xterm; it always ends in a generic monospace so
 *  a missing system font degrades instead of breaking. */
export const TERMINAL_FONTS = [
  { id: "fira-code", label: "Fira Code", kind: "bundled", stack: `"Fira Code", "Fira Mono", Menlo, monospace` },
  { id: "jetbrains-mono", label: "JetBrains Mono", kind: "bundled", stack: `"JetBrains Mono", Menlo, monospace` },
  { id: "sf-mono", label: "SF Mono", kind: "system", stack: `"SF Mono", ui-monospace, Menlo, monospace` },
  { id: "menlo", label: "Menlo", kind: "system", stack: `Menlo, Monaco, monospace` },
  { id: "monaco", label: "Monaco", kind: "system", stack: `Monaco, Menlo, monospace` },
  { id: "fira-mono", label: "Fira Mono", kind: "system", stack: `"Fira Mono", Menlo, monospace` },
  { id: "courier-new", label: "Courier New", kind: "system", stack: `"Courier New", Courier, monospace` },
];

/** The shell choices shown in the Windows-only picker. `id` is the value sent
 *  to the backend (pty_spawn -> resolve_shell). PowerShell is first and is the
 *  default: it handles modern CLI agents (claude, codex) far better than cmd.exe
 *  (ANSI, line editing). This picker is hidden on macOS/Linux, where the login
 *  shell is always used regardless of this value. */
export const WINDOWS_SHELLS = [
  { id: "powershell", label: "PowerShell" },
  { id: "cmd", label: "Command Prompt (cmd.exe)" },
];

/** Font weight choices for terminal text. The bundled fonts ship 400 and 700
 *  faces only, so for them 300/500 render with the regular face and 600 with
 *  the bold face (CSS nearest-face matching); system fonts use whichever
 *  weights are installed. Bold ANSI text keeps xterm's own fontWeightBold. */
export const FONT_WEIGHTS = [
  { value: 300, label: "Light (300)" },
  { value: 400, label: "Regular (400)" },
  { value: 500, label: "Medium (500)" },
  { value: 600, label: "Semi-bold (600)" },
  { value: 700, label: "Bold (700)" },
];

export const DEFAULT_TERMINAL_SETTINGS = {
  fontId: "fira-code",
  fontSize: 13,
  fontWeight: 400,
  lineHeight: 1.0,
  letterSpacing: 0,
  shell: "powershell",
};

/** The shell id if it is a known choice, else the default. Never returns an
 *  unknown value, so a corrupt or renamed saved pick can never reach the
 *  backend as a bad program name. */
export function shellById(id) {
  const found = WINDOWS_SHELLS.find((s) => s.id === id);
  return found ? found.id : DEFAULT_TERMINAL_SETTINGS.shell;
}

// Allowed numeric ranges. load() clamps to these, so a hand-edited or corrupt
// localStorage value can never push an absurd size/line-height into xterm.
export const FONT_SIZE_MIN = 8;
export const FONT_SIZE_MAX = 28;
export const LINE_HEIGHT_MIN = 1.0;
export const LINE_HEIGHT_MAX = 2.5;
// xterm letterSpacing is in whole pixels. 0 = the font's natural spacing.
export const LETTER_SPACING_MIN = 0;
export const LETTER_SPACING_MAX = 8;

/** The font weight if it is a known choice, else the default. Keeps a corrupt
 *  saved value from reaching xterm as a nonsense weight. */
export function fontWeightOf(value) {
  const n = Number(value);
  return FONT_WEIGHTS.some((w) => w.value === n)
    ? n
    : DEFAULT_TERMINAL_SETTINGS.fontWeight;
}

const KEY = "octiq.terminal.settings";

/** Window event fired after settings change; detail is the new full settings.
 *  terminals.js listens for this to update open terminals. */
export const TERMINAL_SETTINGS_CHANGED = "terminal-settings-changed";

/** Clamp a value into [lo, hi]; fall back when it is not a finite number. */
function clamp(value, lo, hi, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(hi, Math.max(lo, n));
}

/** The catalog entry for a font id, or the default font when the id is unknown
 *  (e.g. a renamed/removed font in an old saved value). Never returns null. */
export function fontById(id) {
  return (
    TERMINAL_FONTS.find((f) => f.id === id) ||
    TERMINAL_FONTS.find((f) => f.id === DEFAULT_TERMINAL_SETTINGS.fontId)
  );
}

/** Current terminal settings, merged over the defaults and clamped to the safe
 *  ranges. A missing or corrupt store returns the defaults. Includes the
 *  resolved `fontFamily` stack so callers do not have to look it up. */
export function getTerminalSettings() {
  let saved = {};
  try {
    saved = JSON.parse(localStorage.getItem(KEY)) || {};
  } catch {
    saved = {};
  }
  const font = fontById(saved.fontId);
  return {
    fontId: font.id,
    fontFamily: font.stack,
    fontSize: clamp(saved.fontSize, FONT_SIZE_MIN, FONT_SIZE_MAX, DEFAULT_TERMINAL_SETTINGS.fontSize),
    fontWeight: fontWeightOf(saved.fontWeight),
    lineHeight: clamp(saved.lineHeight, LINE_HEIGHT_MIN, LINE_HEIGHT_MAX, DEFAULT_TERMINAL_SETTINGS.lineHeight),
    letterSpacing: Math.round(
      clamp(saved.letterSpacing, LETTER_SPACING_MIN, LETTER_SPACING_MAX, DEFAULT_TERMINAL_SETTINGS.letterSpacing),
    ),
    shell: shellById(saved.shell),
  };
}

/** Merge a partial change into the current settings, persist it, and fire the
 *  change event so open terminals update live. Returns the new full settings
 *  (re-read, so clamping/normalisation is reflected). */
export function saveTerminalSettings(partial) {
  const next = { ...getTerminalSettings(), ...partial };
  localStorage.setItem(
    KEY,
    JSON.stringify({
      fontId: next.fontId,
      fontSize: next.fontSize,
      fontWeight: next.fontWeight,
      lineHeight: next.lineHeight,
      letterSpacing: next.letterSpacing,
      shell: next.shell,
    }),
  );
  const settings = getTerminalSettings();
  window.dispatchEvent(new CustomEvent(TERMINAL_SETTINGS_CHANGED, { detail: settings }));
  return settings;
}

// ---- DOM wiring (Settings page) -------------------------------------------

/** Fill the font <select> with the catalog, grouped into bundled vs system so
 *  the user can tell which fonts are guaranteed to render. */
function buildFontOptions(select) {
  const groups = [
    { label: "Bundled with app", kind: "bundled" },
    { label: "Installed on this Mac", kind: "system" },
  ];
  for (const g of groups) {
    const optgroup = document.createElement("optgroup");
    optgroup.label = g.label;
    for (const font of TERMINAL_FONTS.filter((f) => f.kind === g.kind)) {
      const opt = document.createElement("option");
      opt.value = font.id;
      opt.textContent = font.label;
      optgroup.append(opt);
    }
    select.append(optgroup);
  }
}

/** Fill the font-weight <select> with the weight catalog. */
function buildWeightOptions(select) {
  for (const w of FONT_WEIGHTS) {
    const opt = document.createElement("option");
    opt.value = String(w.value);
    opt.textContent = w.label;
    select.append(opt);
  }
}

/** Paint the preview box with the given settings so it always matches the pick. */
function paintPreview(preview, settings) {
  if (!preview) return;
  preview.style.fontFamily = settings.fontFamily;
  preview.style.fontSize = `${settings.fontSize}px`;
  preview.style.fontWeight = String(settings.fontWeight);
  preview.style.lineHeight = String(settings.lineHeight);
  preview.style.letterSpacing = `${settings.letterSpacing}px`;
}

/** True when the app runs on Windows. The shell picker only makes sense there;
 *  macOS and Linux always use the login shell. */
function isWindows() {
  return /win/i.test(navigator.userAgent) && !/darwin|mac/i.test(navigator.userAgent);
}

/** Fill the shell <select> with the Windows shell catalog. */
function buildShellOptions(select) {
  for (const shell of WINDOWS_SHELLS) {
    const opt = document.createElement("option");
    opt.value = shell.id;
    opt.textContent = shell.label;
    select.append(opt);
  }
}

/** Wire the Windows shell picker. The field is hidden on macOS/Linux, where the
 *  login shell is always used, so the control never confuses non-Windows users.
 *  Saving fires the settings event, but the shell only takes effect on NEWLY
 *  opened terminals (a running shell cannot be swapped live). Bails quietly when
 *  the controls are absent. */
function wireShellPicker() {
  const field = document.getElementById("term-shell-field");
  const select = document.getElementById("term-shell");
  if (!field || !select) return;
  if (!isWindows()) {
    field.hidden = true;
    return;
  }
  field.hidden = false;
  buildShellOptions(select);
  select.value = getTerminalSettings().shell;
  select.addEventListener("change", () => {
    saveTerminalSettings({ shell: select.value });
  });
}

document.addEventListener("DOMContentLoaded", () => {
  const fontSel = document.getElementById("term-font-family");
  const weightSel = document.getElementById("term-font-weight");
  const sizeInput = document.getElementById("term-font-size");
  const sizeVal = document.getElementById("term-font-size-val");
  const lineInput = document.getElementById("term-line-height");
  const lineVal = document.getElementById("term-line-height-val");
  const spacingInput = document.getElementById("term-letter-spacing");
  const spacingVal = document.getElementById("term-letter-spacing-val");
  const preview = document.getElementById("term-font-preview");
  // The settings page may not exist in every build; bail quietly if so.
  if (!fontSel || !sizeInput || !lineInput) return;

  buildFontOptions(fontSel);
  if (weightSel) buildWeightOptions(weightSel);

  // Seed every control from the saved settings.
  const reflect = (s) => {
    fontSel.value = s.fontId;
    if (weightSel) weightSel.value = String(s.fontWeight);
    sizeInput.value = String(s.fontSize);
    if (sizeVal) sizeVal.textContent = `${s.fontSize}px`;
    lineInput.value = String(s.lineHeight);
    if (lineVal) lineVal.textContent = s.lineHeight.toFixed(2);
    if (spacingInput) spacingInput.value = String(s.letterSpacing);
    if (spacingVal) spacingVal.textContent = `${s.letterSpacing}px`;
    paintPreview(preview, s);
  };
  reflect(getTerminalSettings());

  // Each control saves its slice; saveTerminalSettings fires the change event
  // that updates open terminals. We reflect the returned (clamped) value so the
  // readouts and preview always show what was actually stored.
  fontSel.addEventListener("change", () => reflect(saveTerminalSettings({ fontId: fontSel.value })));
  weightSel?.addEventListener("change", () => reflect(saveTerminalSettings({ fontWeight: Number(weightSel.value) })));
  sizeInput.addEventListener("input", () => reflect(saveTerminalSettings({ fontSize: Number(sizeInput.value) })));
  lineInput.addEventListener("input", () => reflect(saveTerminalSettings({ lineHeight: Number(lineInput.value) })));
  spacingInput?.addEventListener("input", () => reflect(saveTerminalSettings({ letterSpacing: Number(spacingInput.value) })));

  wireShellPicker();
  wireAgentHookSetup();
});

/** Wire the "Set up agent resume & alert hooks" button: install the OctiqFlow
 *  agent hook (resume capture + attention alert) into ~/.claude/settings.json and
 *  ~/.codex/hooks.json on click, and show the backend's status (or the error)
 *  next to the button. The button is disabled while it runs so a double-click
 *  cannot install twice. Bails quietly if the controls are absent. */
function wireAgentHookSetup() {
  const btn = document.getElementById("setup-agent-hooks");
  const status = document.getElementById("setup-agent-hooks-status");
  if (!btn) return;
  btn.addEventListener("click", async () => {
    btn.disabled = true;
    if (status) {
      status.textContent = "Setting up…";
      status.classList.remove("settings-status-error", "settings-status-ok");
    }
    try {
      const message = await invoke("setup_agent_hooks");
      if (status) {
        status.textContent = message || "Done.";
        status.classList.add("settings-status-ok");
      }
    } catch (err) {
      if (status) {
        status.textContent = `Could not set up the hook: ${err}`;
        status.classList.add("settings-status-error");
      }
    } finally {
      btn.disabled = false;
    }
  });
}
