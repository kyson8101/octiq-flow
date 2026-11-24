# Conventions and gotchas (moved part)

Moved verbatim from AGENTS.md on 2026-11-24.

- **An automatic cleanup test needs a safe control actually stripped or
  removed.** Any cargo/rustc on the machine holds the strip, so a
  no-strip result alone proves nothing. Every fixture agent CLI is a stub;
  never allow a test fixture to invoke a paid/live provider CLI.


- **A hook that can write refuses workers by durable identity, never by
  `active_task`.** `orchestrations.active_task(chat_key)` is `None` once an
  attempt has settled, while the worker's capability still works for its live
  launch, so a check built on it lets a worker that has reported, failed or
  been reopened through. Ask `orchestrations.is_worker_chat` /
  `require_user_chat` (a `chat:orch-` key, or an attempt on record:
  `worker_coordinator`), the way `access_handler` and `agents_hook` do. Hiding
  a tool in the MCP server is not authorization. A review of such a hook
  covers the window after a worker settles. A hook that speaks for the chat's
  registered agent refuses a room seat (`session_key != chat_key`) before any
  card, as `seat_refusal`, `roster_seat_refusal` and `memory_seat_refusal`
  do. Such a hook keeps the `HookCaller`: `task_hook_caller` hands back the
  chat key alone, which is how a seat was once taken for the chat's agent.
- **A durability receipt that gates a start or an approval covers the
  current file, its folder, and that file's identity and life.** All four,
  taken in one pass under the lock appends take: the file as it is now
  synced, then the folder it is in, for the file the line was seen in or
  written to (not another the same name has come to mean), in the record
  that file holds now (not one made after the first was removed).
  `transcript::generation` is taken before the look and
  `transcript::confirm_synced` is the only thing that answers yes. What is
  not a receipt, each of which was once taken for one: a line that can be
  read back (the OS holds it), an append's own answer (it syncs the folder
  only for a file it made), "the file existed", and a number two files
  share. A new step that waits on "the person was told" or "this is on
  disk" asks the same call; it does not adopt what it finds. **And a line
  that belongs to one history of a chat is written through
  `transcript::append_in`**: "is this still that record" and the append are
  one step under the append lock, or a `/clear` lands between them and the
  line goes into the history that follows. A generation checked before a
  read and an append made after it is the shape that failed. The reopen
  notice is not such a line: it is for the person, in whatever record the
  chat has.
- **Profile state is read from the folder fixed at startup.** Every path
  under the profile comes from `profile::profile_dir()`, and nothing reads
  `config.json`, falls back to another base, or makes the profile folder
  after `profile::pin` (see **Persistence locations**). A store pinned at
  load and a store resolved per call were once in two different folders at
  the same time. "The folder" is the directory the server took, told by
  its mark, not the path; a folder is made only through
  `profile::create_dir_all`; and a file read per call is read with
  `profile::read`, so a folder that is away is never an empty store. When
  a rule like these is fixed at one site, list every site it covers before
  changing one: the review that found the first hole found the next in a
  minute, twice. And nothing the host offers writes a file there behind the
  module that owns it: the file editor's `write_file` refuses everything in
  the profile folder but the person's own `notify-hook` and `canvas/`
  (`paths::host_owned`).
- **An action that ends work or answers a waiting agent never waits on a
  save.** Stop, interrupt, a task or run stop, a cancel, a limit the host
  enforces, and an answer to a call an agent is parked on all ACT first, or
  act whatever the save answers. The save is tried; when it fails the
  action has still happened, so the command answers as it always does and
  the failure is said beside it, never instead of it. Three parts, and a
  new ending or answering path needs all three:
  - *No `?` on a save ahead of the act.* `cancel_auto_resume(…)?` at the
    top of `chat_stop_impl` returned the schedule's write error and never
    reached `end_process`: with the profile folder away a person could not
    stop a running agent (review of 205bca2, H5). The order had always
    been there and had only worked because `create_dir_all` made the
    folder again. Ask of every `?` above the kill, the interrupt or the
    `tx.send`: is this a save? The same goes for a pass that both writes
    and stops (`recover_due_workers` stops ended workers before the part
    that writes).
  - *Say it with `unsaved::say(what, reason)`, where the save failed.*
    `dispatch::told` collects what one command said on its thread; the
    socket puts it beside the result (`unsaved: [{ what, reason }]`), an
    agent's hook result carries the same list, and every page gets the
    `unsaved` event. Do not return the save's error from a command whose
    action happened, and do not swallow it.
  - *Owe it.* The store keeps the change in memory and a flag that its file
    is behind (`auto_resume::Store::cancel`, `QuestionStore::keep`,
    `OrchestrationStore::mutate_regardless`), and
    `dispatch::settle_owed` writes every such store again, every two
    seconds while the server runs and through the same door as any save,
    so nothing is written into a missing or a replaced profile folder.
    `profile_status.owed` names what is still behind. A new store that an
    ending or answering action writes joins `settle_owed` and `owed`.

  What it does NOT cover, so these stay save-first and are refused whole
  when they cannot be recorded: an action whose point is the record
  (`chat_complete`, moving a chat to the trash, an answer to a question no
  tool is waiting on), anything irreversible (mission Close and Abandon
  remove worktrees), and anything durable a card offers. On a card, Deny
  denies and Allow allows THAT call with the save failing; an "always" or a
  stored authorization that could not be stored is refused in words and
  never assumed later (`safety_block::authorize_for_project` leaves its
  card up). Starting work is not ending it: a new turn still waits for a
  folder its record can be kept in, so an answer that reaches its agent
  only in a new turn (a gate's, to a worker whose turn ended) is taken at
  once and delivered when that turn can start. What is owed lives in
  memory: a restart before the folder is back loses it, and the disk's
  word stands (`docs/plans/profiles.md`).

  Four rules that follow from it, each found as a site the rule above did
  not list (review of b894867). They are general: check a new path against
  all four.
  - **A. Nothing that stops something running reads or saves the profile
    first.** What a stop needs to find its target is in memory, or is asked
    of the system itself (the process table), never of a file in the profile.
    Stop acts, then saves, says `unsaved`, and owes the write. A sweep for
    this rule lists everything that kills or ends, and everything each of
    them reads on the way there.
  - **B. An action that fails for a missing profile never discards the
    person's input.** A refusal is not a failure of the thing refused. A
    Stop on an agent that goes on only in a new process starts the first
    queued message in that process; the missing folder refuses the start,
    and the Stop then forgot the whole queue. A start refused because its
    record cannot be kept puts the message back at the FRONT of the queue,
    touches nothing behind it, and lists the chat as waiting
    (`ChatManager::keep_waiting`); the action that stopped the agent answers
    what happened (`chat_interrupt`: `{ stopped, waiting, notStarted }`),
    not an error; and the host hands the first message over itself once the
    folder is back (`start_waiting_queues`, beside the owed saves), which is
    what that provider's Stop does at once. Every path that takes a message
    off a queue to start it goes through `carry_queued_turn`, which is
    where this lives; a new one does too. Before a failure path calls
    `forget_queued_turns`, ask what refused: a deliberate ending (closing
    the chat) drops its queue by design, and even then the "not sent" line
    each bubble folds by is owed when it cannot be written
    (`record_unsent`).
  - **C. Widening that outlives the moment it is given needs its record;
    narrowing never waits on a save.** The exception above is for ENDING
    work. It was read as "an access change never waits", and a raise went
    through with nothing on disk. Ask which way a level or a grant moves. A
    raise of a chat's, worker's or run's level, a project or stored
    authorization, anything a later start or another chat reads back: the
    record comes first, and while it cannot be written the change is
    refused in words (`agent_chat::NOT_RAISED`), the card that asked stays
    open, and nothing is assumed when the folder is back. A lowering, a
    revocation, a stop: at once, said `unsaved`, written on the retry
    (`chat_set_access_impl` decides by `access_request::rank`;
    `keep_resume_context` keeps a level without its record only when it is
    no higher than the one on record). Not this rule's: the permission
    card's Always, which by design and by what the card says lasts only
    while the chat runs (memory only), and Claude's Always, whose record is
    Claude's own settings file outside the profile.
  - **D. No reply and no page says "saved" for what was not recorded.**
    `saved: true`, `status: "saved"` and the words "Saved" and "Answers
    saved" mean on disk and nothing else. An action that happened without
    its record says both halves apart (`question_answer_batch`: `{ saved:
    false, delivered: true, unsaved }`; an answered question the store
    still owes reads `status: "delivered"`), and the page says that, with
    the reason behind a disclosure and not as an error. Do not bend a
    receipt to get past a reader that throws without it: change the reader.
- **Every reader of a chat record walks it with `transcript::for_each_line`
  or a reader built on it** (`since`, `of_type`, `page`). Real events retain
  their original logical `seq`; a disk-only `octiq_compacted` range occupies
  its original positions and is returned once at its end. Disk-only list
  references are resolved before ordinary readers see an event. Raw storage
  walks are only for encoders/rewriters. A storage migration moves generation:
  reserve publication against starts and every pending receipt debt, while
  keeping bulk preparation/readback outside the global append lock. See
  [chat record storage](../chat-record-storage.md).
  A line that cannot be decoded is skipped by the reader and still counted:
  `lines().map_while(Result::ok)` ends a read at the
  first line that is not UTF-8 and shifts every number after it.
- **Carry a session or history file to a second name without ever writing
  over what is there, and promise no more wholeness than the path gives.**
  `hard_link` answering `AlreadyExists` is success, not a reason to copy: the
  loser of a race that then copies writes through its own link, which opens
  the file it is reading and empties the conversation under both names (24
  threads reproduced it in `chat_recover`). A carry that must copy, across
  devices, writes a whole copy under a temporary name and publishes it with a
  hard link, so the name appears whole and only if nothing has it; a target
  that is already there is kept unless the source is newer, and then it is
  swapped by a rename. Only a filesystem with no links at all falls to
  `create_new` plus a copy (`chat_recover::write_new`), and there the
  guarantee is narrower: no file is overwritten or truncated, but the name
  exists before the file is whole, because `std` has no publish that needs
  neither a link nor a replace. What keeps that from being read as the
  conversation: carries run one at a time (`Carrying`, a guard every carry
  function takes, made only by `carrying()` and not lendable to another
  thread), a copy that fails removes its own file before the next carry's
  turn, and the agent is started by the thread that settled, after the carry
  returned, under the claim on the chat (`Held::settle`). Another program
  reading the folder in that moment, and a server killed mid-copy, can still
  meet the partial file. Two tests pin it: one asserts that BOTH the source
  and the target are intact and byte-identical to the original after 24
  carries at once, the other pauses a last-resort copy and asserts that a
  second carry does not answer until the file is whole.
- **A presence re-check before a durable Closed/Cleaned write does every
  external Git call first and reads the folder last, immediately before the
  write.** A folder read followed by a Git query misses a folder made again
  during that query (`mission::presence_last` and the close loop's final pass); nothing that takes time may sit between the folder read and the write.
- **A ref is absent only with positive proof, and an empty successful
  enumeration is not proof.** A review or code path that treats a branch as
  absent before a delete or a Close must cover case aliases (a case-folding
  filesystem resolves `feature/x` to a real `FEATURE/X` while `for-each-ref`
  of the alias lists nothing) and unreadable loose-ref directories (exit 0,
  empty). Use `git_ops::lifespan::local_branch_exists`: anything but its
  `Ok(false)` is unknown and keeps the item; never compare a refname through
  `lifespan::text`, which trims.
- **A test that reads source as text reads it through `lib/sourceText.lf`.**
  Git for Windows checks files out with CRLF line ends by default and the
  repository has no `.gitattributes`, so a pattern or a replacement that
  names `\n` finds nothing on a Windows checkout: `taskStart.test.tsx` threw
  on a tree that was right. Normalise once, where the file is imported, or
  write `\s+` between lines. A clock's words differ by locale too (`9:05
  PM`, `09:05 pm` in en-MY, `21:05`): a pattern on one allows all three.
- **A browser script takes its paths with `fileURLToPath` and imports a
  module named by a path through `pathToFileURL`.** A URL's `pathname` is
  `/C:/…` on Windows, which `resolve` makes `C:\C:\…`, and Node's loader
  refuses a drive path as a specifier. Every script takes `OCTIQ_WEB_ROOT`.
  A wait in a script is on something that stays true: text a
  `RollingText` draws is every digit its wheels turn through, so a pattern
  on it holds for the first frame only (`test-top-chrome.mjs` timed out in
  Edge and Chrome on Windows on exactly that).
- **A probe of a control that waits on a request holds the request and then
  takes the control away.** Review 3 found four highs that every ordinary
  check passed: a Start not yet answered with its panel shut and opened, a
  batch's questions arriving one event at a time, a delivered question
  after `question-expired` and after a reload, and a press repeated where a
  button was about to be. Test the lifecycle, not only the press.
- **A matrix of orders is not a matrix of combinations.** Three findings
  passed every order of arrival and failed the first mix of two facts
  (review 3b): two cards waiting where the orders had one, and one answered
  while the other's list was still out; a durable line beside an older
  call that asked the same words and has only its result; a fallback for
  an older host, after a part of it went through and the page reloaded.
  When a rule reads several sources, or two generations of the host, vary
  what each HOLDS as well as when it answers. And run a reviewer's older
  probes against a new rule before the loop: one of theirs
  (`failed-other`) passed only because of the bug the next review found.
  Which matrices to write, and which to run only in CI, is in **Which tests
  to write**.
- **A mutation check of a script section switches off the one thing the
  section claims to prove, and sees that section fail.** A mock that sends
  two signals for one fact proves neither: with the first switched off the
  section goes on passing on the second. Section G of
  `scripts/test-front-desk-discussion.mjs` claims the page listens for no
  level event, and it fails when a listener for one is put back.

- **Features the desktop UI owned were deleted, not kept.** Removing the window
  orphaned several backends, and rather than leave them rotting they went too:
  the canvas document store (`canvas.rs` is now just `canvas_dir_for`, which
  `pty.rs` uses for `OCTIQ_CANVAS_DIR`), profile switching and the one-time data
  migrations (`profile.rs`), the agent process/RAM overview and its kill
  (`agents.rs`), the notify-hook alert filter for frontend-raised alerts
  (`notify_hook.rs`), the PTY foreground/agent-running probes (`pty.rs`),
  "open in VS Code" (`fsbrowse.rs`), and the workspace setters for colour, icon,
  initial, docs path, startup layout, terminal command and font override. **They
  are recoverable from git history** — each was working, tested code, not junk.
  To bring one back: restore it and add a `dispatch.rs` route.
- The full brand set lives in top-level `brand/`, the (currently unused) agent
  artwork in `assets/agents/`.
- `scripts/generate_brand_assets.py` regenerates the brand/icon assets into
  `brand/` — not part of the app build.
- `scripts/hooks/agent-session-capture.cjs` is **orphaned**: it was installed by
  the deleted `agent_resume.rs`. Users may still have it wired into
  `~/.claude/settings.json`, so it was left on disk rather than deleted.
