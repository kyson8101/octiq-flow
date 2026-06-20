# Plan: Profiles (per-profile data root)

A **profile** is a self-contained data root. Switching profile loads a different
set of projects, commands, settings, agents, canvas files, and screenshots.
Switch = change the active pointer + restart the app (restart already rebuilds
all state from disk; no live teardown).

## Decisions (locked)

- **Switch model:** write active profile → `app.restart()`. No live in-place switch.
- **Bootstrap pointer:** one fixed file `~/.octiqflow/config.json` = `{ base, active }`.
  It is the only thing that can't live inside a profile.
- **Base default:** `~/.octiqflow/profiles`. User can move `base` to any folder in Settings.
- **Active default:** `default`.
- **Agents:** per profile (own team + memories), moved out of the iCloud docspace path.
  The `default` profile starts with the built-in `DEFAULT_ROSTER` — no docspace copy.
- **Font/appearance:** moves to a file `<profile>/settings.json`, out of `localStorage`.
- **Tab layout + scrollback + agent-sessions:** ride along with the project list (same root).
- **Stays global:** orchestrator `runs/`, `bus/`; the hook script `~/.octiqflow/hooks/h.cjs`;
  the cosmetic "last mode" flag (`localStorage["octiq.mode"]`).
- **Safety:** if `base` is unreachable at launch (iCloud/USB offline), fall back to
  `~/.octiqflow/profiles`, warn, do not crash.

## Target layout

```
~/.octiqflow/config.json        # { "base": "...", "active": "A" }  — only fixed file
~/.octiqflow/hooks/h.cjs        # agent-capture hook, reads OCTIQ_ROOT env
~/.octiqflow/runs/  bus/        # orchestrator scratch, global

<base>/
  A/
    workspaces.json             # projects + commands
    terminal_layout.json
    scrollback/
    agent-sessions.json
    settings.json               # font/appearance
    agents/                     # roster team + memories
    canvas/<key>/
    vault/
  B/ ...
```

## Cards (ordered, each individually deployable)

### Card 1 — Profile bootstrap + route the app_data stores (Rust) — ✅ done 2026-06-19
Merges the old Card 1 + Card 2. Migration moves a store **in the same card that
routes it**, so the app never reads a moved-away file (see Migration above).
- New `src-tauri/src/profile.rs`:
  - Load/create `~/.octiqflow/config.json` → `{ base, active }` (defaults: base `~/.octiqflow/profiles`, active `default`).
  - `profile_dir() -> PathBuf` = `<base>/<active>/`, `create_dir_all`. Reads config; no `AppHandle` needed.
  - Base-unreachable fallback to `~/.octiqflow/profiles` + warn.
  - Reusable `migrate_once(dir, marker, items)` + `move_path` helpers (best-effort `fs::rename`).
  - `migrate_app_data_stores(old_app_data)` → moves `workspaces.json`,
    `terminal_layout.json`, `scrollback/` into the profile, guarded by `.migrated-appdata`.
- `workspaces.rs` + `terminal_layout.rs`: load from `profile_dir()` instead of `app_data_dir()`.
- `lib.rs`: register `profile`; run `migrate_app_data_stores(app_data_dir)` **before** the two stores load.
- **Acceptance:** config loads/creates; projects + commands + tab layout + scrollback load from the active profile; existing data migrates once; second launch is a no-op.
- **Test (`cargo test`):** `migrate_once` moves items once (rename, not copy) and is idempotent.

### Card 2 — Route canvas + vault through profile_dir + migrate (Rust) — ✅ done 2026-06-19
- `canvas.rs` + `vault.rs`: resolve root from `profile_dir()` instead of fixed `~/.octiqflow`.
- Move legacy `~/.octiqflow/{canvas,vault}` into the profile, guarded by `.migrated-canvas`.
- **Acceptance:** existing screenshots/canvas still show; new ones land under `<profile>/canvas|vault`.

### Card 3 — Per-profile agent-sessions + hook OCTIQ_ROOT (Rust + hook) — ✅ done 2026-06-19
- `agent_resume.rs`: read/prune `<profile>/agent-sessions.json`.
- Inject `OCTIQ_ROOT=<base>/<active>` into every spawned shell (next to existing `OCTIQ_TERM_KEY`).
- Embedded hook (`agent-session-capture.cjs`): write `${OCTIQ_ROOT}/agent-sessions.json`,
  fall back to `~/.octiqflow/agent-sessions.json` if unset. Hook install stays one-time.
- Migrate legacy `~/.octiqflow/agent-sessions.json` into the profile, guarded by `.migrated-agentsessions`.
- **Acceptance:** after restart, agent resume re-attaches within the same profile; hook never breaks the agent (exit 0 on any error).

### Card 4 — Font/appearance settings to profile file (Rust + FE) — ✅ done 2026-06-20 (commit skipped — blast mode)
- Small Rust get/set commands for `<profile>/settings.json`.
- `settings.js`: read/write via `invoke` instead of `localStorage`; one-time import of the existing `localStorage` value into the file.
- **Acceptance:** font/size/line-height persist per profile and survive restart.

### Card 5 — Agents re-root to profile (FE) — ✅ done 2026-06-20 (commit skipped — blast mode)
- `roster.js`: set `rootPath = <profile>/agents` (expose `profile_dir` via a command) instead of the iCloud docspace path. Empty profile → `DEFAULT_ROSTER`.
- No migration (default profile starts with the built-in roster, per the locked decision).
- **Acceptance:** agents created in profile A do not appear in profile B.

### Card 6 — Profile switch UI (FE, Settings) — ✅ done 2026-06-20 (commit skipped — blast mode)
- List profiles, create profile, switch (write `active` → `app.restart()`), pick `base` folder (native dialog).
- **Acceptance:** user switches profile and the window reloads into the other profile's projects/settings/agents.

## Build order note
Card 1 lands first (bootstrap + the app_data stores). Cards 2–5 each route +
migrate their own store on top of it, independently. Card 6 is the last slice —
the visible switch UI — once the data layer reads per profile.

## Blast run 2026-06-20

Ran cards 4, 5, 6 back to back in blast mode (no stop-gates, no commit).

**Cards done (commit skipped — blast mode):**
- Card 4 — settings → `<profile>/settings.json`. Rust `read/write_profile_settings`; `settings.js` now keeps a sync cache backed by the profile file, loads it at boot (`initTerminalSettings`), and fires the change event so terminals self-correct. localStorage kept as legacy import source.
- Card 5 — agents re-rooted. Rust `profile_dir_path`; `roster.js resolveRoot()` → `<profile>/agents` (dropped the hardcoded iCloud docspace path). Empty profile → built-in `DEFAULT_ROSTER`.
- Card 6 — switch UI. Rust `get_profile_config`, `list_profiles`, `create_profile`, `switch_profile` (writes active → `app.restart()`), `set_profile_base` (reuses `pick_folder`). New `profiles.js` + a Profiles panel in the Settings page (reuses themed classes → dark mode handled).

**Cards blocked:** none.

**Decisions made:**
- Card 4 store: keep the sync settings API backed by an in-memory cache + the profile file (async boot load self-corrects via the existing change event), rather than making every caller async.
- FE verification: no JS test runner in the repo, so cards 4–6 frontend is verified by Rust build + code reading only.
- `set_profile_base`: only re-points where OctiqFlow looks; existing profiles stay in the old folder (no copy/move). Surfaced in the panel help text.

**Verify:** PASS — 137 Rust tests, clean build, formatted (project-scoped; FE not test-covered).

**Nothing was committed.** All of cards 4–6 sit uncommitted in the working tree on `feat/profiles` (cards 1–3 already committed). Next: review the working tree, then `/commit` or `/pr` to ship.
