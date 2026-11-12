# Scoped reads, coalesced reads and host-kept previews

Source: OCTIQ DEV BACKUP's measurement (`/tmp/octiq-perf-2026-11-12/REPORT.md`,
findings 2 and 3; feedback 09761dd5 for the preview).

## Reads: scope before build, share overlapping asks

- **`orchestration_summary` chooses its runs before anything is built.**
  `OrchestrationStore::summary_scope` works out, from the ledger's rows under
  one short hold of its lock, which runs the arguments (`runId`, `includeEnded`,
  `heldChatKeys`, `coordinatorChatKey`, `workspaceId`) show, plus the routing
  facts that cover every run the read was asked about (`runCoordinators`,
  `workerParents`). `snapshot_scoped` then clones, derives (retry, slot wait,
  git capability, plan holds) and serialises only those runs. It used to build
  the whole ledger's snapshot and `to_value` it, and narrow afterwards.
  `summary::scope_tests` asserts the old route and the new one give an equal
  view for every combination of the arguments. The ledger lock rules are
  unchanged: the scope is copied under the lock, git and chat work stay
  outside it.
- **Overlapping identical reads share a run** (`coalesce.rs`). At most one run
  is in flight per key and one more queued behind it; a caller that arrives
  while a run is going waits for the NEXT run, so every answer is from a run
  that began after the ask. Nothing is cached between runs. Used by
  `orchestration_summary` (key: command + arguments), `git_status_summary`
  (key: the paths) and the verification half of `chat_task`.
- **`git_status_summary`** resolves its repositories, and runs each
  repository's `status` and `numstat`, in parallel (six at a time) instead of
  one after another.
- **`chat_task` for the page (`refresh: false`) answers from what was stored
  when the chat was verified before**, and asks git on a background thread
  (`chat_task_for_page`, `revalidate_in_background`). The result reaches the
  page as the existing `chat-task` event when something moved. A chat never
  verified, and `refresh: true`, still wait for git. Host decisions
  (`pr_workflow`, `chat_complete`, the report tool) keep calling
  `chat_task_impl` and its freshness rule. The page already listens for
  `chat-task`.
- `failover_policy::choices` no longer reads the ledger for a chat with no
  worker choice waiting (develop `2a548698`); it still takes a full snapshot
  when one is waiting, which is rare.

Output of every command is identical for the same arguments.

## Previews: the host keeps them

`chat_index` rows gain **`latestResponseVersion`** (u64, host-owned, omitted
when 0).

- **Written by the host** (`chat_index::set_host_previews`, driven by
  `agent_chat::HostPreview` and `PreviewBatch`) at the agent's readable-output
  boundary, for every chat whether or not a browser has it open: each readable
  message the agent finishes (Claude `assistant` text of the main
  conversation, Codex `agent_message`, Pi `message_end`) and the closing words
  of every cleanly ended turn.
- **Writes are batched, because every write rewrites the whole index.**
  Nothing writes the index on its own: a submitted preview waits in
  `PreviewBatch` (the newest text per chat replaces an older pending one) and
  is due 4 s after the first mid-turn message and at once when a turn ends.
  When anything is due, EVERY pending preview goes out in one read/write of
  the index, and the index is not rewritten for previews more than once a
  second: a turn's end writes on its own thread when the index has been quiet
  for a second, otherwise the writer thread writes it, with whatever else has
  gathered, as the second runs out. Each changed row is announced with
  `chat-index-changed` after the write, so an event means the text is on disk.
  Latency: up to 4 s mid-turn, none to 1 s after a turn.
- **A failed, refused or interrupted turn leaves the previous preview.** It
  submits nothing and withdraws what it had submitted that was not written
  yet. A message of that turn the batch had already written stays (it was
  what the agent said last); the 4 s window keeps that rare.
- **`/clear` and `chat_forget` reset it.** The row's `latestResponse` is
  removed and `latestResponseVersion` is bumped (always, so a stale save
  cannot match it), pending previews for the chat are withdrawn, and
  `chat-index-changed` announces the row. A browser that still carries the
  old text with the old (or no) version is refused by `upsert`, and so is one
  that carries it at the cleared version itself (a Pin save made before the
  page heard the clear): once the host holds "no preview" at a version above
  zero, a browser's text is never taken, only the host's next write moves it.
  For OCTIQ FE: a row that arrives with a higher version and no
  `latestResponse` means "no preview", not "unknown": drop the local text.
- **A clear beats text the writer already took.** Withdrawing reaches only
  what is still queued. Each chat has a clear epoch
  (`chat_index::clear_epoch`), bumped inside `clear_host_preview` under the
  index lock after its write succeeded. A text carries the epoch it was heard
  in (read before it is queued), and `set_host_previews_since` drops an item
  whose epoch is older than the chat's, under the same lock as the write: the
  check and the write are one step, so text a writer had drained and was
  about to write when `/clear` ran never lands after it
  (`a_clear_wins_over_text_already_taken_out_of_the_queue`). Epochs are in
  memory; after a restart no text from before it exists either.
- **Previews are owed, in memory.** A write that fails (the profile folder is
  away, the index cannot be read or written; `set_host_previews` answers an
  error, never "nothing to write") puts what it took back in the queue,
  except text a newer one, a withdrawal or a clear replaced meanwhile, and
  the writer tries again about once a second until it goes through (said once
  per run of failures). This is the "Owe it" rule with a memory-only debt:
  a restart before the folder is back loses it, and the transcript and the
  next turn's words stand.
- **A stop writes what is owed.** SIGTERM and SIGINT (`shutdown.rs`) flush
  the batch, due or not, through the same index door
  (`PreviewBatch::flush`, at most 3 s), then the process dies of the signal
  as before. Not covered: SIGKILL, a crash, power loss, a flush that could
  not finish (the folder away, a stuck index lock): previews pending in
  memory then are lost, up to the last second of a turn's closing words or
  4 s of a mid-turn message. The transcript always keeps the words; the row's
  preview is the older one until the chat's next preview.
- **Bounded and ordered**: trimmed, at most 420 characters plus `…` (what the
  page draws today), the version increments by one on every change and never
  on identical words. `updatedAt` is not touched.
- **A browser save can never rewind it.** `chat_index::upsert` takes a save's
  `latestResponse` only when the save's `latestResponseVersion` equals the
  host's (a page that has heard the current preview may refine its text) and,
  once the host has written one, only when the save carries text. A save
  without a version, with an older one, or claiming one the host never wrote
  keeps the host's text and version. A new row's version is forced to 0.
- **Not covered**: a worker's chat (`orch-…`), a room seat, a chat the index
  does not list. A turn the process dies in mid-way leaves what it had
  submitted pending; the writer still writes it.

### For OCTIQ FE (nothing here is required to ship)

Without FE changes the sidebar already gets the host's text through
`chat_index_list` / `chat-index-changed`, and a page that never sends the
version simply loses its own `latestResponse` saves once the host has written
one. What would finish the job on the page:

1. Carry `latestResponseVersion` on `Conversation` (`lib/store.ts`,
   `fromIndex`, `entryFromConversation`, `saveIndexEntry` call sites in
   `App.tsx`) so a refined local text is still accepted.
2. When an index row arrives with a higher `latestResponseVersion` than the
   local conversation's, adopt its `latestResponse` instead of the cached
   local one (`Sidebar.tsx:337–341` prefers loaded messages, then the row).
3. Keep showing the old text while a newer one loads; do not blank it.

`lib/chatIndex.ts` has the type field.
