# Appearance modes

Moved verbatim from AGENTS.md on 2026-11-24.

### Appearance modes (browser client)

The client offers exactly seven modes in Settings: **Light**, **Dark**,
**Fun**, **Manga**, **中国风**, **Windows XP** and **Cyberpunk**. Their
persisted ids are `light`, `dark`, `fun`, `manga`, `guofeng`, `xp` and
`cyberpunk`; `themeStore.ts` migrates the retired
`one-light`, `octiq`, `candyland` and `comic` ids and sends every other
retired palette back to Dark.

- Dark is the default palette in `design-system.css`. Light, Fun, Manga,
  中国风, Windows XP and Cyberpunk are the palette files under
  `web/src/lib/themes/`.
- `web/src/lib/theme.ts` translates their shadcn-shaped tokens (`--primary`,
  `--card`, `--muted-foreground`) into the app's semantic variables
  (`--accent`, `--bg-1`, `--fg-2`). Palettes set colours and corner radii only —
  never fonts or shadows. A palette may name its radius rungs outright
  (`--radius-sm/md/lg/pill`), which is how Manga gets uneven hand-cut corners.
- **Manga, 中国风, Windows XP and Cyberpunk change more than colour.** Each has its own
  sheet next to `styles.css`, every rule scoped to its `:root[data-theme=…]`,
  so no other mode picks any of it up. The one exception is each sheet's own
  tile in Settings' appearance picker (`.thm[data-theme-id=…]`), which draws
  that mode's look in every mode so it can be found. All four follow one rule: **readability wins over
  effect** — reading text stays in a real reading face, nothing is drawn
  behind words, and display lettering is for the few biggest headings.
- **Manga** (`web/src/manga.css`): thin, slightly uneven panel
  frames, solid-black (beta) marks, speech balloons, faint focus lines on the
  empty page and Dela Gothic One on the biggest headings live in
  `web/src/manga.css`, every rule scoped to `:root[data-theme="manga"]`. It is
  monochrome: the accent is ink, and only the meaning colours (ok, warn,
  danger) keep a hue. No drop shadows — a floating thing gets a white gutter
  round its frame. Frames stay 1.5–2px; a louder version (display type
  everywhere, screentone, 3px frames) was tried and rejected as too much to
  work in.
- **中国风** (`web/src/guofeng.css`): dark and cinematic. Ink-black night with
  a lens vignette at the edges only and faint film grain, 霞鹜文楷 (LXGW WenKai)
  for reading, Ma Shan Zheng brush lettering on the biggest headings, and
  cinnabar seals with pressed edges (the 流 stamp, the agent's name tag, quote
  rules). The ink is real brushwork drawn as SVG in `web/src/assets/ink/`
  (飞白 dry-brush streaks cut by turbulence noise): the stroke behind the empty
  page's question, gold brush rules, the sidebar's ink edge, the open chat's
  mark, and ink-wash mountains in mist — full strength on the empty page,
  veiled to half behind a chat so replies stay legible. The accent
  is gold, not cinnabar, because ~90 rules draw text in `--accent` and red
  text reads as an error; cinnabar is `--seal`, used by name.
- **Windows XP** (`web/src/xp.css`): the Luna look, drawn with gradients
  only (no picture, logo or flag). Royal-blue title-bar strips on the top bar,
  the sidebar's head and the heads of panels, sheets and dialogs, with white
  bold titles on the bar's darker middle; the strip turns `--fg-*`, `--bg-1/2`
  and `--accent` white for what is in it, and a menu that opens from one takes
  them back from `--xp-*`. White content panes on beige (`#ECE9D8`) faces,
  raised tool buttons with a dark blue-grey edge and an orange-gold rim under
  the pointer, edit boxes with the thin blue-grey edge, and the composer's
  Send in a Start-button green. Tahoma for the UI. The accent is Luna's blue
  `#0054e3`; `--decide` is a steel blue of its own (`#1a6a8a`).
  **An answer to a question (`.ask-btn`, wherever it is drawn) gets XP's shape
  and never its colour**: the leading answer keeps the fill, edge and ink its
  component gives it (the decision tint on a card that waits on the person
  and on the Complete question, the accent or red on Confirm) and only takes
  the corners and a colourless light from the top; the other answers are
  raised beige faces rimmed in `--decide` under the pointer, never orange.
  Orange is a tool button's hover and never means anything. This is one rule
  on the button, not a list of the cards that ask: a list missed the
  Complete question (review 1), and `decideColour.test.ts` plus
  `scripts/test-appearance-mode.mjs` check it. A sky over a green hill on the
  empty page only, clear of the question.
- **Cyberpunk** (`web/src/cyberpunk.css`): a neon city at night, dark. A
  near-black blue-violet base (`#0a0a14`), a thin violet glow round the
  frames of panels, sheets, dialogs and menus, a magenta-to-violet rule under
  the top bar, a lilac focus ring with a halo (`--neon-lilac`, never the
  cyan: an idle box with the focus must not read as a turn in flight), and a
  faint perspective grid
  along the foot of the empty page only (gone on a phone, where that page
  holds the picker and the message box). Orbitron (`@fontsource/orbitron`,
  700 only) on the empty page's question and the Settings headings; the
  question is the one heading that glows, and reading text has no glow. The
  accent is neon cyan `#29e3f5`; magenta (`--neon-magenta`) and violet
  (`--neon-violet`) are decoration used by name and mean nothing, like
  中国风's `--seal`. `--decide` is an electric blue of its own (`#6fb6ff`),
  and a card that asks glows in it (`.ask-card`), a safety card in `--warn`.
  The sheet never draws in `--accent`, touches no `.ask-btn`, has no
  animation, and `decideColour.test.ts` checks all of that, that every rule
  is scoped, and, resolving the sheet's aliases to colours, that no focus or
  ring value is the accent or within 20° of its hue.
  **The base sheets draw most focus cues in `var(--accent)`** (an outline on
  the element, on its `::before` as a sidebar row's "…" does, a field's
  border), so the sheet does not chase them one by one: a focused element
  (`:focus-visible`, and a text field or select on `:focus`) is given
  `--accent: var(--neon-lilac)`, which its pseudo-elements inherit, and its
  children get back the accent its parent had (`--cp-ink`), so a "Running"
  line or a live run strip inside a focused control stays cyan and the
  composer's controls keep their model's colour. A `:focus-within` frame is
  not reached that way and is named (`.chat-search-form`, `.composer-box`).
  `scripts/test-appearance-mode.mjs` with `OCTIQ_THEME=cyberpunk` Tabs
  through the chat page, the sidebar, chat search and Settings' appearance
  at 1280 and 390 and fails for any outline, border or box-shadow in the
  accent on the focused element, its `::before` and `::after`, or a frame
  round it that is the accent only while the focus is inside it.
- The terminal cannot read a `var()` — xterm hands its palette to WebGL. So
  `web/src/lib/xtermTheme.ts` resolves variables through hidden elements and a
  1×1 canvas: one element per colour, never one element given each colour in
  turn, which Chrome 155 read back stale (every colour after the first was the
  first, so the terminal's text was its background colour). Magenta and cyan
  are fixed values with a deeper pair for a light mode.
- Text on a fill uses `--accent-fg` / `--danger-fg`, not hardcoded white.
- `vite.config.ts` keeps `test: { css: true }`; otherwise Vitest stubs raw CSS
  imports to an empty string and alternate modes silently use fallback colours.
