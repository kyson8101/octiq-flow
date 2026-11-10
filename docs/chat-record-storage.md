# Chat record storage

The application JSONL files are display/history records. Claude, Codex, Pi and
Antigravity resume their native sessions through `agent_provider.rs`; they do
not read these files as native session files. There is one important additional
consumer: `provider_switch::provider_history` builds bounded handoff evidence
from the application record when switching providers. Actual conversation text,
tool arguments/results, delivery identities and host events therefore remain.

## Readers

The socket-only `chat_record_head { key }` command returns
`{ lastSeq, generation }` so retained browser windows can detect a cleared or
replaced record. `lastSeq` uses the same logical positions as paging, including
compacted ranges and malformed lines; a missing record returns zero. It reuses
the writer's count, also populated by a complete latest-page index. A cold
record without a count needs one storage-line scan outside the global append
lock; publication checks its stamp and life, and later requests read metadata
only. Clear and every rewrite invalidate the cached count.

The wire generation uses creation time and, on Unix, device/inode; appending
does not change it. This stays stable across server restarts on filesystems
providing creation time. Filesystems without creation time use a process nonce
alongside Unix device/inode, so a restart conservatively invalidates retained
windows there. Missing records have the `missing` generation. These are
freshness tokens, not durability receipts (`transcript::Generation` below).
`chat_forget` broadcasts `chat-forgotten { key }` after successful deletion and
after releasing its locks; failed clears emit no such event. Neither the head
command nor this browser event adds an agent hook or MCP route. Profile
unavailability is returned in the profile's own words, never as an empty head.

The browser persists its native-session fallback with a string
`Conversation.recordGeneration`. It reconciles that identity on both checkpoint
restoration and head reads, independently of whether the displayed window is
invalidated. A current checkpoint written by another tab after `/clear` must
not leave a saved session from the prior record available for the next start.
This is browser metadata only; it neither changes `ChatMeta` nor the index's
numeric restore generation. See [retention](chat-window-retention.md) for legacy
row handling and the serial browser regression probes.

| Reader | Required data |
| --- | --- |
| `chat.ts`, live and replay | Messages, stream block text and original tool arguments, result text, errors/outcomes, model/session/cwd/commands, usage and host facts |
| `replayChat`, `CatchUp`, `loadChat` | Stable logical `seq`; a compacted marker whose `into <= checkpoint` forces a fresh page when merged text crossed the checkpoint |
| `chat_page` | Whole turns, source-resolved init context, stable exclusive cursors; indexes physical lines with their logical end numbers |
| `chat_since`, `every_line`, `of_type` | Source-resolved events and original sequence numbers; malformed/torn lines still occupy a position |
| Search | User/assistant text and provider final messages, not init lists, hooks or the structured tool-result copy |
| Provider switch | Bounded transcript evidence; never storage-only references |
| Question/answered and reopen receipts | Exact host event identities/content, generation, file sync and folder sync |
| Tool diff | `tool_use_result.filePath`, `structuredPatch`, `type`, and `content` for newly created files |
| Failure origin | `tool_use_result._meta`, including `octiq/outcome` |

## Clearing native sessions

`chat_forget` (`/clear`) stops the provider first, reserves the chat against
concurrent starts, saves native-session revocations and clears the index session
(including a lead's session), clears the ledger and auto-resume native ids, then
clears the in-memory `StartContext` id. Only then does it forget the transcript
and emit `chat-forgotten`. Claude sessions, Codex threads, Pi sessions and
Antigravity conversations all use this same native-id boundary. Model, effort,
access, cwd, defaults, registered identity and `leadOf` remain intact. Host
notifications may start a fresh native session with those retained settings.

The index keeps host-only `forgotten_sessions`, keyed by chat and exact native
id. It includes the index, remembered/ledger/scheduled contexts, pending fallback
rollback contexts and all provider init ids in the record. It survives restart
and browser metadata saves without changing the public metadata shape or its
restore generation. Stale saves cannot restore a revoked id or overwrite a newer
session with one; stale `chat_start.resume`, registered recovery from transcript,
late init events and provider-switch rollback contexts cannot resume it.
Native init captures its launch and Stop epoch under the session lock, does
index/team/ledger I/O outside that lock, and checks the epoch again before
publishing its id in memory. If Stop overtakes I/O, the tentative id is revoked
in the index and ledger and is neither published nor appended. Init recording
also runs outside the session lock, as it did before f4f40e3. A separate per-chat
native-write gate serializes this work with `/clear`; clear waits on it only
after stopping, while Stop and interrupt never take it. This prevents an unknown
late init from repopulating a cleared history. Handover ask-back refuses to fork
a revoked id from its saved origin.

The browser's `chat_stop`, `chat_interrupt` and `chat_forget` admission guard
also stays off the ledger mutex. `require_user_chat` reads a separate in-memory
worker identity snapshot: reserved `chat:orch-` keys and all recorded attempts
(including settled legacy keys) remain read-only. Startup builds the snapshot
from the loaded ledger; every committed ledger replacement publishes both
values while holding the ledger mutex and the snapshot's short leaf write lock.
Snapshot construction, persistence and destruction happen outside that leaf
lock. An owed save publishes the retained in-memory state too; a refused
save-first mutation publishes neither. Readers release the leaf lock before
any chat operation. Thus an init paused on index I/O while holding the ledger
cannot delay Stop's epoch veto. The regression uses real `dispatch` admission
for all four providers and checks a response within 200 ms before releasing
both first-index and ledger-held index barriers; delayed ids never enter
starts, index, transcript or ledger after release. `/clear` bumps the epoch
before capturing any ids, and reads its saved ledger context only after Stop;
it may then wait for its required cleanup I/O.

Related entry-point audit: all callers of `require_user_chat` now use that
snapshot, including the chat replacement/cancel controls, question controls,
trash admission and cleanup-request admission; their existing action semantics
are unchanged. Trash remains save-first because its purpose is a durable
record. `orchestration_task_stop` and `orchestration_run_stop` do not use this
guard: they obtain targets through their own ledger transitions, and currently
wait for `mutate_regardless` (including its save) before ending processes. That
pre-existing Rule A gap remains a separate follow-up; changing their targeting,
authorization and stop transaction is outside this native-session fix. It is
not covered by the 200 ms chat Stop regression.

Revocation filtering must also preserve permission lowering when the profile
or index cannot be read. `remember_start` keeps the new settings but drops the
unverified native id; `keep_resume_context` does the same for an already-applied
lowering and retains it with `unsaved`/owed semantics if saving fails. This
deliberately prefers a fresh native conversation over trusting an unread
tombstone. Native init likewise publishes no id when revocations are unread.
The regression covers a missing profile and malformed index, then restores the
store and checks that the narrower settings survive reload without a revoked
id. Ordinary resume-context saves, common start/launch admission,
`registered_runtime::select` recovery, and handover ask-back all start new work;
their filtering remains save-first and refuses an unread store. Stop, cancel,
retarget's ledger removal and late-id cleanup add no revocation read before
their ending action.

A new provider-owned id remains usable. The final common launch boundary checks again
under the session-table lock, including notifications and cloned auto-resumes.

These stores are separate files, not a transaction. Each write is save-first:
a failure returns the original profile/store error, retains the transcript, and
emits no `chat-forgotten`. Stop still takes effect and can cancel queued work,
questions or schedules (including their normal cancellation records). Revocations
or stores already saved remain cleared on a later store failure; a retry finishes
the remaining work. If transcript deletion itself fails, native sessions have
already been revoked and settings retained, while history stays visible and the
command reports the deletion error. The next start is fresh even before retry.
Deleting history first would allow old native memory to return silently after a
failed session write. Tombstones contain ids only, not conversation text. They
retain the latest eight distinct revoked ids per chat (current contexts take
precedence over older init events), and purge/permanent deletion removes that
chat's tombstones. This bounds repeated clears; protection for tabs carrying
more than eight revoked native ids behind the current chat is not retained.

## Disk format

An unchanged init or commands list is omitted after its material source, and
`octiq_record_refs` maps each omitted field to the original logical sequence.
References point backwards to material lists, never to other references. Older
backend binaries cannot read this storage format; rollback needs a pre-migration
chats-folder backup. Scalar
init facts remain on every init event. A changed list is stored in full.
`transcript::for_each_line` decodes references for ordinary readers;
`LineIndex::read` fetches material source lines for random-access pages. The wire
format remains ordinary provider events. The writer keeps a bounded cache of
hashes and source numbers, not list contents, and reconstructs it after restart.

The displayed tool-result text stays in `message.content`. Structured copies
keep only diff fields and `_meta`; repeated stdout, MCP payloads, Read file
contents and originalFile are omitted. Hook output/stdout/stderr are omitted
because the reducer draws none of them. User-authored image attachments and
host question/answer/reopen events are preserved.

Finished stream pieces retain the first piece with the complete original block
text; redundant pieces become no-ops. Using the final assistant's arguments in
place of the stream is unsafe: Claude can normalize a Bash command in that copy
(the captured command-echo fixture exercises this). An unfinished stream stays
unchanged.

Adjacent no-ops use one physical line:

```json
{"type":"octiq_compacted","into":42,"count":200}
```

That line occupies 200 original logical sequence positions and is returned once
with the last position as its `seq`. `into` is the earliest destination of any
merged piece in the range; this may conservatively trigger a fresh page. Every
real event retains its original `seq`. A cursor inside the range receives its
end marker on catch-up. Invalid UTF-8/JSON still counts as one position. Only a
valid `octiq_compacted` range can span multiple positions.

## Atomic migration and recovery

`record_trim::compact_record` plans edits from a raw storage walk. Publication
goes through `transcript::rewrite_numbered`:

1. Capture source metadata/generation briefly under the append lock. Build and
   sync a replacement outside the lock; check logical count, reference resolution
   and a streaming digest of every host fact at its original sequence. A separate
   per-record rewrite reservation excludes competing replacement files.
2. Acquire the lifecycle/receipt gate only for publication, then take the append
   lock and reject a source whose metadata or generation changed. Hard-link the
   original inode as `.jsonl.compact-backup`, sync it and its folder, atomically
   rename the replacement, move generation and sync the folder.
3. Release both publication gates before readback. Verify the published prefix
   against the backup outside the lock, allowing later appends; briefly lock to
   check generation again before removing the backup and syncing its folder.

The backup sync opens a writable handle on Windows because
[FlushFileBuffers requires GENERIC_WRITE](https://learn.microsoft.com/en-us/windows/win32/api/fileapi/nf-fileapi-flushfilebuffers).
The Unix path keeps its read-only fsync handle.

A failure retains the backup. A fresh process verifies and removes an
interrupted backup before retrying; later appends are allowed if the old host
fact prefix and sequence boundary remain intact. `/clear` removes its record
and pending backup together, invalidates generation and forgets cached writer
state. No backup is restored into a cleared history.

Startup and post-process passes preflight the record through the chat start
claims door, then release that claim during preparation. A second claim at
publication refuses running processes, pending starts, handoffs and alias keys.
A chat starting during preparation wins; that file is retried later. Pending/native questions and unsynced answered-line debt also hold the
record: moving generation must not make an owed answer look like a cleared
history. Reopen notices, auto-plan approvals, not-sent lines, auto-resume cancels
and pending/restored memory activity deliveries also refuse migration. Existing
delivery locks are queried without waiting. During a reserved migration,
`generation` returns unavailable to new receipt flows; their existing retry
paths keep the debt, and the token/receipt rules stay unchanged. A source symlink or nonregular file is refused. Successful file sizes
are remembered in `.compacted-sizes-v2.json`; a failed file or one retaining a
backup is retried. Folder creation/read/error handling uses the pinned profile.

Compaction runs when the process is released/closed and on startup for records
that grew. It does not rewrite a long history after every assistant turn; that
would produce quadratic I/O. The startup pass runs in its own background thread, one record at a time.
Only source checks, backup/rename/sync and generation changes hold the global
append lock; bulk copying, parsing, recovery verification and post-publication
readback do not. A changed source is skipped rather than blocking a new turn. Storage savings do not imply equal wire or browser-memory
savings: list references are decoded before delivery.

## Offline verification

Never point the offline evidence harness at the live profile. Copy the chats
folder into `original` and `compacted` under an `octiq-record-storage-*` OS
scratch directory. The ignored test rejects destinations outside that scratch
boundary. It compacts only the preexisting copy and runs the exact Rust
compactor on captured JSONL fixtures too.

```sh
OCTIQ_RECORD_ORIGINAL=<scratch>/original \
OCTIQ_RECORD_COMPACTED=<scratch>/compacted \
  cargo test --manifest-path src-tauri/Cargo.toml --lib offline_storage_evidence -- --ignored --nocapture

OCTIQ_RECORD_EVIDENCE=<scratch> \
OCTIQ_RECORD_LARGE=<comma-separated-record-filenames> \
  pnpm --dir web exec vitest run --maxWorkers=1 tests/storedRecord.test.ts
```

The reducer comparison includes drawn messages, tool results/diffs/outcomes,
questions/answered host facts, other ChatState fields and logical sequence
positions. `write-growth.json` separately measures append-only bytes per turn
and per event category before any rewrite. Unit tests also cover range catch-up, page/since/append after restart,
list changes, generation receipts, alias start exclusion and fresh processes
stopped at both publication boundaries.

## Receipt consumer audit

| Consumer | Compaction gate |
| --- | --- |
| `QuestionStore::Note`, native handover, `append_in` | Pending/open questions, native_seen and owed notes; record reservation defers new generation captures |
| `orchestration::workspaces::notice_receipts` / `deliver_reopen_notices` | Busy workspace delivery or an undelivered reopen for this coordinator record |
| `orchestration::auto_plan::deliver_auto_plan_notices` | Busy delivery or an entry in auto_plan_notices |
| `memory_activity::show` / `recover_at` | Busy activity journal, pending intent, or a delivered line missing from the transcript |
| `ChatManager::record_unsent` / `settle_unsent` | Busy not-sent queue or an owed line for any alias of this record |
| Auto-resume cancellation | Busy/unreadable queue, an owed save, or a cancelled tombstone not finished yet |
| `record_chat_event_synced` | Its durability-waiting callers are memory activity and reopen notices above; `record_start_failure` has no waiting receipt/debt and does not gate an action |

All production `generation`/`confirm_synced`/`Held::Moved` consumers are in the
first four rows or the transcript's own mutation/receipt functions. Existing
receipts still invalidate on a migration; no history token is silently renewed.

Generation bookkeeping retains a weak reference for each observed record life;
a receipt/debt token owns that life until it is dropped. Batch cleanup removes
only entries with no live tokens, never a global generation floor. Thus 16,385
unrelated rewrites cannot invalidate an untouched record's debt. Each batch of
16,384 table growth discards expired weak entries and shrinks capacity; lives
still observed at the last sweep remain until a later sweep or a real mutation.
Live debt knowledge is never evicted to enforce that housekeeping batch size.
A storage rewrite still moves the life because it replaces the physical file:
logical content/seq equivalence alone is not the old file's durability receipt.
Both compaction entry and publication reject every owed-debt category above.
Only actual record mutation or a current-file synced receipt settles a debt;
no caller retakes a fresh token to bypass a clear.

The H1 regression uses a real `QuestionStore`, a mode-0400 victim file and
actual storage backup/fsync/rename/readback for other records in a scratch
profile. Measurements before/after the fix:

| Other storage moves | Before: receipt / debt | After: receipt / debt |
| --- | --- | --- |
| 16,384 | Unconfirmed / owed | Unconfirmed / owed |
| 16,385 | Moved / incorrectly paid | Unconfirmed / owed |

Restoring mode 0600 writes the owed answer once (two total answered facts,
including the no-migration control). A real clear after the permission failure
writes zero old answers into the new history. All six debt-category tests
reject both compaction entry and publication without changing bytes or life.
Full Rust default-thread suite: 2,112 lib + 31 binary passed, 23 ignored,
zero failures; `cargo fmt --check` passes. This is Unix permission/lifecycle
validation, not a Windows runtime or process RSS measurement.

The captured wire-adapter check tolerates only decimal parser ULP differences
for noninteger numbers; reducer output and sequence comparisons remain exact.
