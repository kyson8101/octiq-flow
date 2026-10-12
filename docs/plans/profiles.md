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
- **Fixed for the life of the process (2026-10-12).** The folder is resolved
  once, at launch, and that is the only moment the fallback applies. The
  server says which folder it is using when it is the fallback: on its log
  line, and to the page through `profile_status` (`fallbackFrom`, `notice`).
  A base that comes back later is not switched to; restart to use it.
  A folder that goes away while the server runs is an error to whoever
  asked, in words the page shows, and never a move to the default base:
  nothing is saved anywhere else, no empty profile is made where the drive
  was, and when the folder is back the same action works with no restart.
  Before this, `profile_dir()` read the config and tried to make the folder
  on every call and fell back whenever that failed, which split a running
  server across two folders (transcripts, chat index, roster and vault
  settings in one; ledger, project list and questions in the other).
- **Never made again, never mistaken, never read as empty (2026-10-12).**
  Three rules hold for a folder that goes while the server runs:
  - *Never made again.* After launch the profile folder is only found.
    Every folder the host makes goes through one function that, for a path
    in the profile, makes only what is below the profile folder, so nothing
    can put an empty profile where the real one was, however the moment is
    timed.
  - *Never mistaken.* The folder in use is the directory the server took,
    not whatever is at its path. The server leaves a mark for the run on
    the owner lock's line (`owner.lock`: `pid kind mark`) and every "is the
    folder there" reads it back. A folder made at the same path, or a link
    to another one, has no such mark: the host writes nothing into it and
    answers with its own sentence (`… is not the folder OctiqFlow started
    with …`). Put the original back and everything works again; restart to
    use the new one. A second server that starts in the new folder writes
    its own mark, and the first then stops writing. Known limits: a copy
    of the folder with its lock, made while the server runs and put at the
    path, passes; deleting `owner.lock` by hand reads as replaced until a
    restart.
  - *Never read as empty.* A store read from a folder that is not there is
    an error carrying the folder's sentence, not the value of a first run.
    Settings does not draw a blank form it would let the person save over
    their own rules: the preferences and agent-policy boxes are locked and
    the vault form is not drawn when their load failed.
- **What the page can ask: `profile_status`** (read-only, no arguments) →
  `{ dir, fallbackFrom, available, notice, owed }` (`owed` is described
  under *Stop and an answer never wait on a save* below). `dir` is the
  folder in use.
  `fallbackFrom` is the configured base when the server started on the
  default one, else `null`. `available` is whether the folder at that path
  is there right now AND is the one the server started with. `notice` is
  the sentence to show, or `null` when there is nothing to say: the
  fallback sentence while the folder is there, and otherwise the
  not-available or the replaced sentence (the same one a refused send or a
  failed read answers). The page does not draw it yet; today the words
  reach the person as the error of the action they tried, and on the
  server's log.
- **For the page (OCTIQ FE), not built:** a retry on the three Settings
  forms after a failed load (today: leave Settings and come back), the
  same lock on any future form that loads a whole value and saves it, and
  drawing `profile_status`.
- **Stop and an answer never wait on a save (2026-10-12).** The three
  rules above took away what an older order leaned on: Stop, interrupt, a
  task stop and a question's answer all saved first, and that save only
  ever worked with the folder gone because it made the folder again. With
  the folder away they then answered the profile's sentence with the agent
  still running. Now an action that ENDS work or ANSWERS a waiting agent
  happens whatever its save does:
  - *It acts.* The process is ended, the turn cut short, the answer handed
    to the call parked on it. The save is tried beside it.
  - *It says both things.* The command answers as it always does (the work
    was stopped, the answer was delivered), and what could not be recorded
    is listed beside that answer: `unsaved: [{ what, reason }]` on the
    socket's reply frame, the same list inside an agent's hook result, and
    the bus event `unsaved` for every open page. `reason` is the profile's
    own sentence. Nothing that happened is reported as failed.
  - *It is made good.* The store keeps what it could not write and a flag
    that it owes it. Every two seconds the server writes each such store
    again (`dispatch::settle_owed`), so the longest a save stays owed once
    the folder is back is two seconds; any other save of the same store
    that succeeds carries it too, since each write is the whole store.
    `profile_status` gains `owed`, the names of the stores still owing
    (`auto-resumes`, `questions`, `the ledger`), empty when the disk has
    caught up. Nothing is written into a folder that replaced the profile,
    and nothing makes the folder again. A cancelled auto-resume's line in
    its chat's record, which could not be written either, is written then,
    once, so a reloaded page reads no banner for it.

  What is covered, and what the caller is told when the record failed:

  | Action | Does | Says as not recorded |
  | --- | --- | --- |
  | `chat_stop`, `chat_interrupt` | ends the process, or cuts the turn short | `the cancelled auto-resume`, `the cancelled questions` |
  | `chat_cancel_auto_resume`, and every other path that cancels one (a new message, an access change, a retarget) | takes it off the schedule | `the cancelled auto-resume` |
  | `question_answer`, `question_answer_batch`, with a tool waiting | wakes the tool, which takes its answer | `the answer`, then `the delivered answer` |
  | `question_cancel` | tells the waiting tool it was cancelled | `the cancelled questions` |
  | `orchestration_task_stop`, `orchestration_run_stop` | cancels the attempts, ends the workers | `the stopped task`, `the stopped run` |
  | `orchestration_gate_resolve` (the person's, and a coordinator's) | takes the answer and queues it for the worker | `the gate's answer` |
  | `orchestration_message_send` with `interrupt` | keeps the message, cuts the worker's turn short | `the coordinator's message` |
  | `chat_retarget`, and `chat_set_access` LOWERING a run's chat (a raise is refused: rule C below) | ends the process, or lowers the level | `the forgotten start settings`, `the chat's access level` |
  | the Sandbox panel's Stop, and the host's stop of services nothing needs (rule A below) | asks Docker to take the project down | `the stopped sandbox` |
  | a peer request's time limit (the scheduler) | ends the attempt and stops its process | `the attempt ended at its time limit` |

  Keeps nothing in the profile, so was never held up: `permission_decide`
  (Allow, Deny and "Always" are in memory, for the chat),
  `access_request_answer`, `safety_block_dismiss`, `chat_start_queued`,
  `chat_cancel_queued`, the idle sweeper, a Stop's grace running out.

  Still refused whole while the folder is away, on purpose, because the
  record is the point and refusing leaves nothing half done: `chat_complete`
  (Stop still stops the process), mission Close and Abandon (they remove
  worktrees, and nothing irreversible goes ahead of its record; stop the
  run instead), moving a chat to the trash, an ordinary message to a
  worker, and an answer to a question no tool is waiting on (a record for a
  later turn). A Codex card's "Allow for this project" IS a stored
  authorization: it fails in the profile's sentence, the card stays up, and
  nothing is assumed once the folder is back. Allow once and Keep it local
  keep nothing and work.

  **What an answer that needs a new turn waits for.** A worker whose turn
  ended when it opened a gate is given the answer in a new turn, and a
  start is still refused while its record cannot be kept. So the answer is
  taken and kept at once, and reaches that worker within one scheduler pass
  (two seconds) of the folder coming back.

  **If the folder never comes back before a restart,** what was owed is
  lost with the process that held it, and what is true is what the disk
  says: a scheduled auto-resume that was cancelled is scheduled again and
  will run at its reset time, a task the person stopped reads as
  interrupted by the restart and is open to the host's ordinary recovery,
  a gate's answer has to be given again, and an answered question is asked
  again. The caller was told, at the time, that each was not recorded, and
  `profile_status.owed` said so until the end. Not built: a second place to
  keep these outside the profile, which would be a copy of the profile's
  data in another folder, the thing the rules above exist to prevent.
- **For the page (OCTIQ FE), not built:** drawing a reply's `unsaved` list
  (or the `unsaved` event) as a notice, and `profile_status.owed`. Until
  then the words are in the reply and on the server's log, and the page
  shows the action as done, which it is.
- **Four rules that follow, each found as a site the rule above did not
  list (2026-10-12, review of b894867).** With the folder only moved away:
  the Sandbox panel's Stop left its services running; a Stop with messages
  queued behind it answered an error and forgot them; a raise of a
  coordinator's access level went through with nothing on disk; an answer
  that was not saved was answered `saved: true` and drawn as "Answers
  saved".

  **A. Nothing that stops something running reads or saves the profile
  first.** What a stop needs to find its target is in memory or is asked of
  the system itself, never of a file in the profile.
  - The sandbox store keeps what it last read or wrote of its state
    (`sandbox::Store::known`). The panel's Stop, the host's stop
    (`host_stop`, from the lifecycle pass and from a workspace cleanup) and
    `live_keys` go by it; start, check, reset, select and configure read
    the file and are refused while it cannot be read.
  - Docker is asked first. With the sandbox's own folder there, through the
    frozen Compose file as before. With it away, `docker --host <endpoint
    on record> compose --project-name <id> down`: no file, Docker finds the
    project's containers and networks by their Compose labels, volumes are
    kept. Checked against Docker 29.2 / Compose 5.1.
  - Then it is written down. The outcome (stopped, by whom and why; or in
    error, with Docker's words) is kept whether or not it can be written,
    said as `unsaved` (`the stopped sandbox`), and owed: `sandboxes` in
    `profile_status.owed`, written by `settle_owed`. A state file that
    cannot be read is never written over.
  - Limit: a server STARTED with the folder away has read nothing, so it
    knows no sandbox to stop until the folder is back.

  **B. An action that fails for a missing profile never discards the
  person's input.** A queued message whose turn cannot start is not a
  failed message.
  - A start refused because its record cannot be kept puts the message back
    at the front of its queue and lists the chat as waiting. Nothing is
    marked failed, nothing behind it is touched, the order is kept.
  - The Stop answers `{ stopped: true, waiting: N, notStarted: <the
    profile's sentence> }`. `chat_queue_state` gains `held` (that sentence,
    absent otherwise) and the bus says `chat-queue-waiting { chatKey,
    reason }`.
  - **When the folder is back the first queued message starts by itself**,
    within two seconds, which is what each provider's Stop does at once:
    Claude and Codex, which keep their process, are written it; Antigravity
    and every command-line agent are started with it in a new process. The
    person does nothing. The rest follow the ordinary way.
  - The same for the reaper's carry-over when a command-line turn ends
    with a message waiting, for a Stop the agent did not honour (its
    process is ended after the grace), and for "send this one now" (the
    chosen message is first, the others behind it in their order).
  - Claude and Codex were written the next message on the stopped turn's
    full stop even with the folder away: a turn with nothing able to record
    it. That handover waits now, like a send and like a start.
  - Meanwhile: a send is refused while the folder is away and joins the
    back of the waiting queue once it is there; the ✕ takes a message back;
    the chat is not ended as idle.
  - Closing the chat (`chat_stop`) still drops its queue: that is the
    person ending everything that waited on it. The "not sent" line of each
    dropped message, which could not be written, is said as `unsaved` (`the
    messages that were not sent`) and written when the folder is back
    (`unsent messages` in `owed`).
  - A waiting queue is in memory, like every queue: a restart loses it,
    and the messages read as not sent, which the page offers again.

  **C. Widening that outlives the moment it is given needs its record;
  narrowing never waits on a save.**
  - `chat_set_access` asks which way the level moves. A raise is recorded
    before the agent is told anything; while it cannot be, it is refused:
    `The access level was not raised, and nothing was changed: <why>`.
    Nothing is said as `unsaved`, because nothing happened; the agent is
    told nothing; nothing is assumed when the folder is back.
  - A lowering, or the level the chat already has, takes hold at once, is
    said as `unsaved` (`the chat's access level`), and is written on the
    retry. On all four paths: Claude's control message, a Codex thread's
    next turn, Antigravity's next process, a command-line agent's next
    command.
  - The page keeps the card that asked open (the agent goes on waiting and
    is told nothing), and the access picker goes back to the level the chat
    still runs at with the reason as a notice. It no longer restarts the
    agent for this refusal (`lib/accessRaise`).
  - Unchanged, on purpose: the permission card's Always lasts only while
    the chat runs (memory only, as the card says), and Claude's Always is
    recorded in Claude's own settings file, outside the profile.
  - Plan and roster settings (a task's access, a run's worker defaults, an
    agent's registered access, the shared policy, a chat's index entry, a
    sandbox's configuration) are record-first in both directions and are
    refused whole with the folder away. None of them changes anything that
    is running: they are read by a later start, and every start is itself
    refused then.
  - **Known limit, not built:** a lowering made with the folder away and
    followed by a restart before the folder returns comes back at the
    disk's older, higher level. The person was told at the time that it was
    not recorded, and `profile_status.owed` said so until the end.

  **D. No reply and no page says "saved" for what was not recorded.**
  - `question_answer_batch` answers `{ saved: true }` only for answers on
    disk, and `{ saved: false, delivered: true, unsaved: <why> }` for
    answers that reached the waiting tool and could not be written. An
    answered question the store still owes reads `status: "delivered"` with
    `unsaved` in `question_pending` and in `question-updated`, and is said
    again as `saved` once the store has caught up.
  - The card says `Answers sent · not saved` and `Your answers reached the
    agent and could not be saved.`, with the profile's sentence behind
    `Why`. It is not an error.
  - Everything else that says "saved" was checked and writes first:
    `question_retry`, the delivery notes on a question (`set_delivery`),
    memory receipts, roster and policy changes, preferences, feedback, the
    file editor. The reply frame's `ok: true` beside an `unsaved` list means
    the command ran, and no reader takes it for a save.
- **Recorded follow-ups, not built:** drawing `unsaved`, `held` and
  `profile_status.owed` on the page in general; handover Decline and
  Abandon, which read the profile first and so leave the parked tool to its
  600 s wait; the Codex safety card, where dismissing is not delivering and
  the turn that would deliver is a start; a sandbox known only to a server
  that has not read its state yet.

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
    (As built then. Since 2026-10-12 it answers the path `profile::pin` fixed
    at launch and makes nothing; see **Safety** above.)
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
