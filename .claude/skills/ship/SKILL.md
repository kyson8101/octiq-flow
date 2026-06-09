---
name: ship
description: >-
  Manually invoked as `/ship` (or by an explicit "ship it" / "ship this build"
  mention) to run the fixed release sequence for the OctiqFlow Tauri app:
  (1) commit every working-tree change to the current branch, (2) build the
  release installer with `npm run tauri build`, then (3) print the folder that
  holds the produced `.dmg`. Commits with a conventional message and no AI attribution;
  skips the commit step when the tree is already clean. Never pushes, never
  branches, never signs/notarizes, never opens a PR. Does NOT auto-trigger —
  only on the `/ship` slash command or an explicit "ship" mention; a finished
  task alone is not enough.
---

# Ship

Run the release sequence for this project end to end: **commit → build the
installer → show the dmg folder path**. The project is a Tauri 2 desktop app; the
frontend is served straight from `src/` (no bundler) and the installer is
produced by `npm run tauri build`.

Always run all three steps in order. Stop and report if any step fails.

## Step 1 — Commit

1. Run `git status --short` to see the working-tree changes.
2. If there is **nothing to commit**, say so in one line and continue to Step 2.
   "always commit" means "always run the sequence", not "create an empty commit".
3. Otherwise:
   - Stage everything: `git add -A`.
   - Read the staged diff (`git diff --cached --stat` and, for anything
     non-obvious, the full diff) so the message describes what actually changed.
   - Commit to the **current branch** with a **conventional-commit** message
     (`feat:` / `fix:` / `chore:` / `refactor:` …) that summarizes the change.
     **No AI attribution** in the message or trailer.
   - Do **not** push. Do **not** create or switch branches. Do **not** amend or
     run any destructive git command.

## Step 2 — Build the installer

1. From the repo root, run the release build:

   ```bash
   npm run tauri build
   ```

   This compiles the Rust in release mode and bundles the macOS `.app` and
   `.dmg`. It can take a few minutes on a cold build, so run it in the
   background and wait for it to finish.
2. If the build fails (non-zero exit, `error[...]`, or `failed to bundle`),
   **stop** and show the relevant tail of the build output. Do not continue.

## Step 3 — Show the dmg folder path

1. Confirm the build produced a `.dmg` — do **not** hardcode the version or
   architecture, they change:

   ```bash
   ls -t src-tauri/target/release/bundle/dmg/*.dmg 2>/dev/null | head -1
   ```

2. Print the **absolute path of the folder that holds the `.dmg`**:
   `/Users/kyson/Developer/personal/octiq-flow/src-tauri/target/release/bundle/dmg`,
   plus a clickable relative link to that folder. Still confirm a `.dmg` is on
   disk first — never report the folder without a real artifact in it.

## Rules

- This skill is **build + commit only**. It never pushes, opens a PR, signs, or
  notarizes. If the user wants any of those, they ask separately.
- The build is **unsigned**; on first open macOS Gatekeeper warns. Mention this
  once when reporting the artifact so the user is not surprised.
- Run every command from the project root
  (`/Users/kyson/Developer/personal/octiq-flow`).
- Report faithfully: if the build failed, say so with the output; never claim an
  artifact exists without confirming the file is on disk.
