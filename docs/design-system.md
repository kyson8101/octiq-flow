# OctiqFlow UI system

OctiqFlow follows the public [One Design System](https://www.spline.one/one)
reference: Inter, a 4 px spacing grid, neutral surfaces, softly bordered
controls, nested corner sizes and consistent light/dark appearance. The tokens
are authored for this application; they are not an official Figma token export.

## Foundations

`web/src/design-system.css` owns the default One Dark palette, spacing, type,
control sizes, shadows, focus and syntax colors. Use semantic variables rather
than literal UI colors. `--bg-0` is the workspace, `--bg-sunken` the navigation,
`--bg-1` a panel and `--bg-2` a hover or raised surface. `--fg-0` is a heading,
`--fg-1` body text, and `--fg-2` / `--fg-3` supporting text.

Use `--accent` / `--accent-fg` together for primary actions, `--link` for links,
and `--focus` for keyboard focus. Status colors (`--ok`, `--warn`, `--danger`)
retain their meaning in both appearances. Do not use the primary action color
as the color of a success or error message.

Inter is bundled through Fontsource under OFL-1.1. Chinese glyphs fall back to
the existing bundled LXGW WenKai Screen. Code and terminal text retain their
monospace stack. CodeMirror syntax colors use shared tokens; xterm resolves
the current palette when the theme changes.

## Components and layout

Use the existing shared control classes: `.icon-btn`, `.panel-btn`, `.set-input`,
`.picker-menu` / `.picker-item`, `.mode-switch` / `.mode-btn`, `.ask` / `.ask-btn`.
Default controls are 36 px, compact controls 32 px, and touch targets 44 px.
Use 8 px corners for small controls, 12 px for grouped controls, and 16 px for
panels and dialogs; pill corners are reserved for segmented tabs and primary
actions. Existing custom palettes may supply their own corner geometry.

Layout spacing uses `--space-1` through `--space-12` (4–48 px, with selected
steps). One-pixel borders, icon strokes, optical alignment and interaction
geometry such as resize handles are not rounded to the spacing grid.

The Flow workspace retains project navigation, the conversation column and
resizable file/preview panels. The composer is a neutral bordered field with
a focus ring. Settings, connection, dialogs, file lists, image/HTML Preview,
agent panels and both OS portals share the same tokens. The world's illustrated
buildings, office and avatar artwork keep their own material colors.

## Appearance

One Dark is the built-in default (the persisted `octiq` id remains compatible).
One Light is available in Settings, alongside the existing custom palettes.
Both OS headers have an appearance toggle. The choice persists across routes
and reloads. `data-color-scheme` controls native widgets and syntax colors;
switching back clears all palette overrides. Arbitrary user-authored HTML and
PDF/image contents retain their own presentation inside the Preview surface.

## Validation

Run `pnpm test` and `pnpm build` from `web/`. If the running backend serves
`web/dist`, direct the verification build to a temporary directory using
`pnpm build --outDir /private/tmp/<unique-directory>`.
Inspect Flow and both OS routes at desktop and narrow widths in both appearances;
check settings, a populated conversation, inputs, menus and file/preview panels.
