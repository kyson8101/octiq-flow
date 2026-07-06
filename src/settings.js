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
// The font catalog mixes three kinds of family:
//   - bundled — shipped with the app as woff2 + @font-face (styles.css), so it
//     always renders regardless of what is installed (Fira Code, JetBrains Mono).
//   - system — only renders if the font is installed on this machine; its CSS
//     stack falls back to a generic monospace otherwise.
//   - cjk — a monospace Latin face + a Chinese (CJK) face, so 中文 renders in a
//     real Chinese font instead of the OS generic monospace. macOS-installed.

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
  // Chinese (CJK) faces. Each keeps a crisp bundled monospace for Latin (so
  // commands and code stay aligned) and renders 中文 from a real Chinese family
  // via per-glyph CSS fallback — the OS generic monospace has no proper Chinese
  // face. These four are shipped with macOS (PingFang/Hiragino/Heiti sans,
  // Songti serif), so `kind: "cjk"` degrades to monospace if one is missing.
  { id: "cjk-pingfang", label: "PingFang SC 苹方", kind: "cjk", stack: `"JetBrains Mono", "PingFang SC", Menlo, monospace` },
  { id: "cjk-hiragino", label: "Hiragino Sans GB 冬青黑体", kind: "cjk", stack: `"JetBrains Mono", "Hiragino Sans GB", Menlo, monospace` },
  { id: "cjk-heiti", label: "Heiti SC 黑体", kind: "cjk", stack: `"JetBrains Mono", "Heiti SC", "STHeiti", Menlo, monospace` },
  { id: "cjk-songti", label: "Songti SC 宋体 (serif)", kind: "cjk", stack: `"JetBrains Mono", "Songti SC", "STSong", Menlo, monospace` },
  // Custom: the user types any font family name installed on their machine. The
  // stack is not fixed here — getTerminalSettings/resolveTerminalSettings build
  // it from the saved `customFont` string via customFontStack(). The stack below
  // is only the fallback used when the custom name is empty.
  { id: "custom", label: "Custom (type a font name)…", kind: "custom", stack: `Menlo, monospace` },
];

/** CSS font-family value for a user-typed custom font name. Quotes the name and
 *  always appends a monospace fallback, so an empty or bad name degrades to
 *  monospace instead of breaking xterm. Strips quotes/backslash/semicolon so the
 *  name can never break out of the CSS value. */
export function customFontStack(name) {
  const clean = String(name || "").trim().replace(/["\\;]/g, "");
  return clean ? `"${clean}", Menlo, monospace` : `Menlo, monospace`;
}

/** The terminal color theme. Each entry maps an xterm ITheme key to a label and
 *  a default `#rrggbb` (the app's dark palette + a One-Dark-ish ANSI set). The
 *  four non-ANSI keys come first (they matter most), then the 8 ANSI + 8 bright
 *  colors. Exported so the global Settings page and the per-project override
 *  editor build the same set of color inputs. */
export const THEME_COLORS = [
  { key: "background", label: "Background", def: "#141417" },
  { key: "foreground", label: "Text", def: "#c9c9c5" },
  { key: "cursor", label: "Cursor", def: "#8fbfa8" },
  { key: "selectionBackground", label: "Selection", def: "#31443c" },
  { key: "black", label: "Black", def: "#1c1c1c" },
  { key: "red", label: "Red", def: "#e06c75" },
  { key: "green", label: "Green", def: "#98c379" },
  { key: "yellow", label: "Yellow", def: "#e5c07b" },
  { key: "blue", label: "Blue", def: "#61afef" },
  { key: "magenta", label: "Magenta", def: "#c678dd" },
  { key: "cyan", label: "Cyan", def: "#56b6c2" },
  { key: "white", label: "White", def: "#abb2bf" },
  { key: "brightBlack", label: "Bright black", def: "#5c6370" },
  { key: "brightRed", label: "Bright red", def: "#e06c75" },
  { key: "brightGreen", label: "Bright green", def: "#98c379" },
  { key: "brightYellow", label: "Bright yellow", def: "#e5c07b" },
  { key: "brightBlue", label: "Bright blue", def: "#61afef" },
  { key: "brightMagenta", label: "Bright magenta", def: "#c678dd" },
  { key: "brightCyan", label: "Bright cyan", def: "#56b6c2" },
  { key: "brightWhite", label: "Bright white", def: "#ffffff" },
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
  customFont: "",
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

/** `v` when it is a `#rgb` or `#rrggbb` hex color, else `fallback`. Keeps a
 *  hand-edited or corrupt saved color from reaching xterm as a bad value. */
function validHex(v, fallback) {
  const s = String(v || "").trim();
  return /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/.test(s) ? s : fallback;
}

/** A full xterm theme object: every THEME_COLORS key, taken from `saved` when it
 *  holds a valid hex there, else the catalog default. Always returns all keys,
 *  so callers can hand it straight to xterm. `saved` may be a partial object,
 *  null, or corrupt — each missing/bad key degrades to its default. */
export function resolveTheme(saved) {
  const src = saved && typeof saved === "object" ? saved : {};
  const theme = {};
  for (const c of THEME_COLORS) theme[c.key] = validHex(src[c.key], c.def);
  return theme;
}

/** The catalog entry for a font id, or the default font when the id is unknown
 *  (e.g. a renamed/removed font in an old saved value). Never returns null. */
export function fontById(id) {
  return (
    TERMINAL_FONTS.find((f) => f.id === id) ||
    TERMINAL_FONTS.find((f) => f.id === DEFAULT_TERMINAL_SETTINGS.fontId)
  );
}

// In-memory cache of the raw saved settings, populated by initTerminalSettings()
// from the active profile's settings.json. getTerminalSettings() reads it
// synchronously so the existing sync callers (terminals.js) need no change; until
// init resolves it falls back to the legacy localStorage value, which is also the
// one-time import source the first time a profile has no settings file.
let savedCache = null;

/** The raw saved settings object: the per-profile cache once loaded, else the
 *  legacy localStorage value. */
function readSaved() {
  if (savedCache) return savedCache;
  try {
    return JSON.parse(localStorage.getItem(KEY)) || {};
  } catch {
    return {};
  }
}

/** Current terminal settings, merged over the defaults and clamped to the safe
 *  ranges. A missing or corrupt store returns the defaults. Includes the
 *  resolved `fontFamily` stack so callers do not have to look it up. */
export function getTerminalSettings() {
  const saved = readSaved();
  const font = fontById(saved.fontId);
  const customFont = String(saved.customFont || "");
  return {
    fontId: font.id,
    customFont,
    fontFamily: font.id === "custom" ? customFontStack(customFont) : font.stack,
    fontSize: clamp(saved.fontSize, FONT_SIZE_MIN, FONT_SIZE_MAX, DEFAULT_TERMINAL_SETTINGS.fontSize),
    fontWeight: fontWeightOf(saved.fontWeight),
    lineHeight: clamp(saved.lineHeight, LINE_HEIGHT_MIN, LINE_HEIGHT_MAX, DEFAULT_TERMINAL_SETTINGS.lineHeight),
    letterSpacing: Math.round(
      clamp(saved.letterSpacing, LETTER_SPACING_MIN, LETTER_SPACING_MAX, DEFAULT_TERMINAL_SETTINGS.letterSpacing),
    ),
    theme: resolveTheme(saved.theme),
    shell: shellById(saved.shell),
  };
}

/** Resolve terminal appearance for one project, overlaying its per-project
 *  override on the global settings. `override` is the raw object saved on a
 *  workspace (its `font_override` — the field name is historical; the object now
 *  carries BOTH the font override, gated by `enabled`, AND the color-theme
 *  override, gated by `themeEnabled`), or null/undefined. The two gates are
 *  independent: a project can override just the font, just the colors, both, or
 *  neither. Each overridden field is clamped/validated to the same safe ranges,
 *  so a corrupt/partial override degrades to the global value. Always returns a
 *  full, resolved settings object, so callers can hand it straight to xterm. */
export function resolveTerminalSettings(override) {
  const base = getTerminalSettings();
  const ov = override && typeof override === "object" ? override : {};

  let font = base;
  if (ov.enabled) {
    const f = fontById(ov.fontId || base.fontId);
    const customFont = ov.customFont != null ? String(ov.customFont) : base.customFont;
    font = {
      fontId: f.id,
      customFont,
      fontFamily: f.id === "custom" ? customFontStack(customFont) : f.stack,
      fontSize: clamp(ov.fontSize, FONT_SIZE_MIN, FONT_SIZE_MAX, base.fontSize),
      fontWeight: ov.fontWeight != null ? fontWeightOf(ov.fontWeight) : base.fontWeight,
      lineHeight: clamp(ov.lineHeight, LINE_HEIGHT_MIN, LINE_HEIGHT_MAX, base.lineHeight),
      letterSpacing: Math.round(
        clamp(ov.letterSpacing, LETTER_SPACING_MIN, LETTER_SPACING_MAX, base.letterSpacing),
      ),
    };
  }

  // Theme override overlays per key on the global theme (each valid override
  // color wins; missing/bad ones keep the global value).
  let theme = base.theme;
  if (ov.themeEnabled) {
    theme = { ...base.theme };
    for (const c of THEME_COLORS) theme[c.key] = validHex(ov.theme?.[c.key], theme[c.key]);
  }

  return {
    fontId: font.fontId,
    customFont: font.customFont,
    fontFamily: font.fontFamily,
    fontSize: font.fontSize,
    fontWeight: font.fontWeight,
    lineHeight: font.lineHeight,
    letterSpacing: font.letterSpacing,
    theme,
    shell: base.shell,
  };
}

/** Merge a partial change into the current settings, persist it, and fire the
 *  change event so open terminals update live. Returns the new full settings
 *  (re-read, so clamping/normalisation is reflected). */
export function saveTerminalSettings(partial) {
  const next = { ...getTerminalSettings(), ...partial };
  const raw = {
    fontId: next.fontId,
    customFont: next.customFont,
    fontSize: next.fontSize,
    fontWeight: next.fontWeight,
    lineHeight: next.lineHeight,
    letterSpacing: next.letterSpacing,
    theme: resolveTheme(next.theme),
    shell: next.shell,
  };
  savedCache = raw;
  // localStorage stays as a fast cache/fallback; the durable per-profile store is
  // the settings.json written by the backend. The file write is fire-and-forget —
  // a write error must never block the live font update.
  localStorage.setItem(KEY, JSON.stringify(raw));
  invoke("write_profile_settings", { json: JSON.stringify(raw) }).catch(() => {});
  const settings = getTerminalSettings();
  window.dispatchEvent(new CustomEvent(TERMINAL_SETTINGS_CHANGED, { detail: settings }));
  return settings;
}

/** Load the active profile's settings.json into the cache, then fire the change
 *  event so open terminals and the Settings page apply the per-profile values.
 *  When the profile has no file yet, seed it once from the legacy localStorage
 *  value (so the default profile keeps the user's current font). Best-effort:
 *  any backend error falls back to localStorage, so settings never block boot. */
export async function initTerminalSettings() {
  try {
    const raw = await invoke("read_profile_settings");
    if (raw) {
      savedCache = JSON.parse(raw) || {};
    } else {
      savedCache = readSaved();
      invoke("write_profile_settings", { json: JSON.stringify(savedCache) }).catch(() => {});
    }
  } catch {
    savedCache = readSaved();
  }
  localStorage.setItem(KEY, JSON.stringify(savedCache));
  window.dispatchEvent(
    new CustomEvent(TERMINAL_SETTINGS_CHANGED, { detail: getTerminalSettings() }),
  );
}

// Kick off the per-profile load as the module evaluates. Terminals that open
// before it resolves render with the localStorage/default font and are corrected
// by the change event init fires.
initTerminalSettings();

// ---- DOM wiring (Settings page) -------------------------------------------

/** Fill the font <select> with the catalog, grouped into bundled vs system so
 *  the user can tell which fonts are guaranteed to render. Exported so the
 *  per-project font-override editor (workspaces.js) reuses the same catalog. */
export function buildFontOptions(select) {
  const groups = [
    { label: "Bundled with app", kind: "bundled" },
    { label: "Installed on this Mac", kind: "system" },
    { label: "Chinese (CJK) — mono Latin + Chinese face", kind: "cjk" },
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

// All installed system font family names, fetched from the backend (fonts.rs
// `list_fonts`) once per session. The backend caches the OS scan too, so this is
// doubly cheap; the promise cache here just avoids a second IPC round-trip.
let fontListPromise = null;

/** The installed system fonts, loaded once and reused. Resolves to [] on any
 *  backend error, so a caller can always iterate the result. */
export function loadSystemFonts() {
  if (!fontListPromise) {
    fontListPromise = invoke("list_fonts").catch(() => []);
  }
  return fontListPromise;
}

/** Fill a <datalist> with the installed system fonts, once. Called lazily when
 *  the custom-font box is first shown, so the OS font scan only runs if the user
 *  actually reaches the custom option. Safe to call repeatedly (guarded). */
export async function fillFontDatalist(datalist) {
  if (!datalist || datalist.dataset.filled) return;
  datalist.dataset.filled = "1"; // set first so concurrent calls don't double-fill
  const fonts = await loadSystemFonts();
  const opts = fonts.map((name) => {
    const opt = document.createElement("option");
    opt.value = name;
    return opt;
  });
  datalist.replaceChildren(...opts);
}

/** Fill the font-weight <select> with the weight catalog. Exported so the
 *  per-project font-override editor (workspaces.js) reuses it. */
export function buildWeightOptions(select) {
  for (const w of FONT_WEIGHTS) {
    const opt = document.createElement("option");
    opt.value = String(w.value);
    opt.textContent = w.label;
    select.append(opt);
  }
}

/** Paint the preview box with the given settings so it always matches the pick.
 *  Colors (background + text) come from the resolved theme so the preview shows
 *  the terminal colors too. Exported so the per-project override editor
 *  (workspaces.js) reuses it. */
export function paintPreview(preview, settings) {
  if (!preview) return;
  preview.style.fontFamily = settings.fontFamily;
  preview.style.fontSize = `${settings.fontSize}px`;
  preview.style.fontWeight = String(settings.fontWeight);
  preview.style.lineHeight = String(settings.lineHeight);
  preview.style.letterSpacing = `${settings.letterSpacing}px`;
  if (settings.theme) {
    preview.style.background = settings.theme.background;
    preview.style.color = settings.theme.foreground;
  }
}

/** Fill `container` with one native `<input type="color">` per THEME_COLORS
 *  entry, each labelled and tagged `data-theme-key` so readThemeInputs can pull
 *  the values back out. `idPrefix` namespaces the input ids (the global Settings
 *  page and the per-project editor use different prefixes). Native color inputs
 *  give a picker for free and can only ever hold a valid `#rrggbb`. */
export function buildThemeInputs(container, idPrefix) {
  if (!container) return;
  container.replaceChildren();
  for (const c of THEME_COLORS) {
    const field = document.createElement("label");
    field.className = "theme-color-field";
    const input = document.createElement("input");
    input.type = "color";
    input.className = "theme-color-input";
    input.id = `${idPrefix}-${c.key}`;
    input.dataset.themeKey = c.key;
    const span = document.createElement("span");
    span.className = "theme-color-label";
    span.textContent = c.label;
    field.append(input, span);
    container.append(field);
  }
}

/** Read the color inputs in `container` back into a full, validated theme. */
export function readThemeInputs(container) {
  const raw = {};
  for (const input of container.querySelectorAll("input[data-theme-key]")) {
    raw[input.dataset.themeKey] = input.value;
  }
  return resolveTheme(raw);
}

/** Set the color inputs in `container` from a theme (defaults fill any gaps). */
export function fillThemeInputs(container, theme) {
  const full = resolveTheme(theme);
  for (const input of container.querySelectorAll("input[data-theme-key]")) {
    input.value = full[input.dataset.themeKey];
  }
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
  const customField = document.getElementById("term-custom-font-field");
  const customInput = document.getElementById("term-custom-font");
  const themeGrid = document.getElementById("term-theme-grid");
  const themeReset = document.getElementById("term-theme-reset");
  // The settings page may not exist in every build; bail quietly if so.
  if (!fontSel || !sizeInput || !lineInput) return;

  buildFontOptions(fontSel);
  if (weightSel) buildWeightOptions(weightSel);
  if (themeGrid) buildThemeInputs(themeGrid, "term-theme");

  // Seed every control from the saved settings.
  const reflect = (s) => {
    fontSel.value = s.fontId;
    if (customInput) customInput.value = s.customFont;
    if (customField) {
      customField.hidden = s.fontId !== "custom";
      if (s.fontId === "custom") fillFontDatalist(document.getElementById("term-custom-font-list"));
    }
    if (weightSel) weightSel.value = String(s.fontWeight);
    sizeInput.value = String(s.fontSize);
    if (sizeVal) sizeVal.textContent = `${s.fontSize}px`;
    lineInput.value = String(s.lineHeight);
    if (lineVal) lineVal.textContent = s.lineHeight.toFixed(2);
    if (spacingInput) spacingInput.value = String(s.letterSpacing);
    if (spacingVal) spacingVal.textContent = `${s.letterSpacing}px`;
    if (themeGrid) fillThemeInputs(themeGrid, s.theme);
    paintPreview(preview, s);
  };
  reflect(getTerminalSettings());

  // Re-reflect when settings change from elsewhere — the per-profile file load at
  // boot (initTerminalSettings), or another tab/control — so the page always
  // matches the stored values. reflect() does not save, so this cannot loop.
  window.addEventListener(TERMINAL_SETTINGS_CHANGED, (e) => reflect(e.detail));

  // Each control saves its slice; saveTerminalSettings fires the change event
  // that updates open terminals. We reflect the returned (clamped) value so the
  // readouts and preview always show what was actually stored.
  fontSel.addEventListener("change", () => reflect(saveTerminalSettings({ fontId: fontSel.value })));
  customInput?.addEventListener("input", () => reflect(saveTerminalSettings({ customFont: customInput.value })));
  weightSel?.addEventListener("change", () => reflect(saveTerminalSettings({ fontWeight: Number(weightSel.value) })));
  sizeInput.addEventListener("input", () => reflect(saveTerminalSettings({ fontSize: Number(sizeInput.value) })));
  lineInput.addEventListener("input", () => reflect(saveTerminalSettings({ lineHeight: Number(lineInput.value) })));
  spacingInput?.addEventListener("input", () => reflect(saveTerminalSettings({ letterSpacing: Number(spacingInput.value) })));
  // Color inputs: save the whole grid on any change (native color inputs fire
  // 'input' live while dragging in the picker).
  themeGrid?.addEventListener("input", () => reflect(saveTerminalSettings({ theme: readThemeInputs(themeGrid) })));
  themeReset?.addEventListener("click", () => reflect(saveTerminalSettings({ theme: resolveTheme(null) })));

  wireShellPicker();
  wireAgentHookSetup();
  wireInstallButton("install-canvas-skill", "install-canvas-skill-status", "install_canvas_skill");
  wireInstallButton("install-canvas-codex", "install-canvas-codex-status", "install_canvas_codex_guide");
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

/** Wire a one-shot "install" button to a backend command that returns the path
 *  it wrote. Shows the path (or an error) in `statusId`, and disables the button
 *  while it runs so a double-click cannot install twice. Bails quietly if the
 *  controls are absent. Used by the canvas skill (Claude) + guide (Codex). */
function wireInstallButton(btnId, statusId, command) {
  const btn = document.getElementById(btnId);
  const status = document.getElementById(statusId);
  if (!btn) return;
  btn.addEventListener("click", async () => {
    btn.disabled = true;
    if (status) {
      status.textContent = "Installing…";
      status.classList.remove("settings-status-error", "settings-status-ok");
    }
    try {
      const path = await invoke(command);
      if (status) {
        status.textContent = path ? `Installed at ${path}` : "Done.";
        status.classList.add("settings-status-ok");
      }
    } catch (err) {
      if (status) {
        status.textContent = `Could not install: ${err}`;
        status.classList.add("settings-status-error");
      }
    } finally {
      btn.disabled = false;
    }
  });
}
