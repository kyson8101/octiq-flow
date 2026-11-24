# Plan approval, approvals, retries, agent removal and peer requests

Moved verbatim from AGENTS.md on 2026-11-24.

**Per-chat automatic plan approval is the person's standing consent.** Only
the browser socket exposes `orchestration_auto_plan_get { chatKey }` and
`orchestration_auto_plan_set { chatKey, enabled, includeFull? }`;
neither command has a hook action or MCP tool. The Details switch and plan-card
tick box share the ledger's `auto_plan_chats` setting, retained until switched
off. Enabling needs its record first (Conventions C); disabling acts at once
and owes a failed save. Full access stays excluded by default; only the person
can opt this chat in with `includeFull: true`. Omitting it retains the current
scope; disabling clears both settings. Including Full needs its record first;
excluding it acts immediately and owes a failed save, even if the profile/index
is away. Only existing consent can use that revocation exception; an enable
still needs its normal eligibility checks. Get, set and the
`orchestration-auto-plan` event return `{ chatKey, enabled, enabledAt?,
includeFull, includeFullAt? }`; the opt-in time is stored as optional
`auto_plan_chats.full_enabled_at`. Workers, front desks, room seats and
unlisted chats cannot enable it. A clean full stop of the chat's own writer, including a host
notification turn, captures its launch id, per-chat `stop_epoch`, turn sequence
and refusal latch under the existing writer session lock, then releases every
chat lock. Approval takes only the ledger; ordinary sends, starts and queued
handoffs continue through their existing admission and writer paths.
Every intentional Stop, interrupt, replacement, end, idle sweep and expired
grace increments the per-chat AtomicU64 epoch and revokes launch evidence;
natural one-shot reaping alone preserves them for buffered clean output.
Every real prompt start increments the per-chat AtomicU64 turn sequence under
its writer lock before writing, including person, queued, host notification
and Codex app-server turns. A new launch increments it before executing its
command-line prompt. A persistent writer refreshes its launch evidence at a
real turn start. Every Stop/interrupt of a retained persistent process also
sets an unattributed latch under the session lock, even while it reads idle.
Buffered init/result pairs, however many, cannot clear it. After a post-Stop
host write, Claude must replay that prompt's fresh native UUID and exact
content (`isReplay`, never synthetic); Codex must return that turn/start
request's native turn id and complete that same turn. Only that attributable
clean end clears the latch and can qualify in the same PID. A later Stop
resets it; another write replaces the target until recovery. Missing provider
correlation keeps it latched until a new process. Thus recovery need not occur
at the first real turn's end; manual plan-card approval remains available.
Consuming CutOff::Owed still moves the queue once, without clearing the latch.
A turn the host only observes advances the sequence, but never restores
evidence a Stop revoked or clears attribution. Its clean end can qualify only
while launch evidence and attribution remain intact.
Native Codex refusals are bound under the session lock to the prompt's
write identity and native turn id (or the written target when elicitation omits
the id), never `busy` or the idle clock. The matching turn remains refused even
if an older buffered end marks it idle. A late answer for another write/turn
cannot latch or clear the current turn. This includes command/file approvals,
MCP confirmations, unsupported/no-runtime elicitation and unanswered cards
cancelled at a full stop. Child-thread requests belong conservatively to the
parent's current write/correlated turn; an unknown turn remains refused when
correlation arrives. Attribution controls only auto-plan evidence: it never
changes which elicitation card is shown, its answer, cancellation or diagnostic.
Only a new real write resets this refusal ownership.
The epoch, turn-sequence and launches maps are leaves: their guards never span
acquisition of another lock. Launch identity/success is checked before the
ledger, under the own writer's lock; approval never reads these maps.
The first ledger snapshot pins the pending revision and waiting set only if
the captured epoch and turn sequence still match. Any next turn vetoes the old
full stop, even with no plan edits or if it ended before the snapshot. Its own
clean end retries. The staged clone, outbox and inbox commit together only if
consent, revision, waiting set, epoch and turn sequence still match after the
temporary write, immediately before rename/publication. The unchanged-epoch
CAS, bracketed by unchanged-sequence checks, is the decision point. Stop and
new turns can veto without waiting for ledger I/O or taking a chat lock there.
No chat lock is held while the auto-approval path takes the ledger, and the
ledger is never held while it takes a chat lock.
Lock audit: `start_session`'s final `admit_beside_writers` takes sessions → ledger
(read-only workspace admission), and report confirmation via `while_idle` takes
session → ledger. Access changes (`chat_set_access_impl`'s `record_raise`,
`remember_start`, `keep_access_for_resume`/`keep_resume_at`) also hold the
session across ledger resume-context saves; their starts guard is released
before the ledger is taken. `replaced_binary_keys` releases the table before its ledger
lookup. `require_workspace_available` releases its ledger snapshot before
sessions/starts. Ledger-held agent removal (`LeavingMark::look`,
`turn_may_be_in_flight`) uses only nonblocking try_lock. Auto approval must
never wait for ANY chat lock (sessions, session, queue, handoffs, launches)
under the ledger, nor wait for the ledger while holding one; no global chat
table spans its ledger persist I/O. Worker archive/dispatch, ended-worker
Stop/recovery, mission cleanup and workspace lifecycle checks take chat locks
only after ledger snapshots/mutations have returned. Auto approval approves
the whole pending revision through `decide_plan_in` only when every waiting
task's effective worker access is at most Auto (or this chat has opted in to
include Full) and none is a peer request. Peer requests always need the person.
The Full opt-in is read again under the ledger at the approval commit point,
so switching it off vetoes a Full approval that has not committed.
Stop, interrupt, failure, refusal or a replaced/ended process approves nothing.
`ConsentVia::Standing` keeps `enabledAt` and `includeFull`; a durable ledger
outbox records
`octiq_plan_auto_approved` in the transcript and the normal host notification
tells the lead whether automatic dispatch is paused (the coordinator starts
the workers) or the host dispatches through the normal gates. Snapshot-only
`run.autoPlan` reports `includeFull` and explains an access or peer-request
hold. With Full included, no `access` hold is produced; `peerRequest` still
holds. A task that names extra MCP servers (`workerServers`) counts as Full
here whatever its access (`auto_plan::held`): it is held as `access` unless the
chat included Full. This uses no provider plan mode and changes none of the task,
permission, safety or reserve gates.

**An approval fixes what a task runs as, and a time stamp or a parent id is
not that approval.** `approved_at` says a task was approved. `Task::approved`
(`orchestration/approval.rs`) says as what: the worker in effect when the
person approved (provider, model, effort, access, recovery policy with its
fallback model), the assignee, the destination, the base branch, the workspace mode
and the extra MCP servers its worker gets (`Approved::worker_servers`). Every
start is compared with it in `reserve_attempt_for`, the one door, before an
attempt is reserved: the coordinator's, the host's dispatch and recovery, the
page's. Nothing but an approval writes it. So:

- A new way to start a task goes through `reserve_attempt_for`, and a new
  thing an approval should fix is added to `Approved` and to
  `approval::keeps_to`, never checked at one caller.
- A task's MCP servers are the one thing of an approved task the coordinator
  may change (`orchestration_task_revise` with `taskId` and `workerServers`
  alone, `amend_servers`): only while no worker runs it, it is in no batch, the
  person has not stopped it (`STOPPED_NOT_AMENDED`) and `retry::allows` it, and
  the task goes back on the plan card like a reassignment (rollback kept for a
  rejection; the plan revision moves). While it is back on the card with that
  rollback the list can be corrected again under the same guards. The page shows the list on the task's
  row and on the stage line (`MCP servers: a, b`). A reopen that names them is
  refused (`REOPEN_SERVERS`); a manager's split takes its parent's APPROVED
  list and names none (`SPLIT_SERVERS`); a peer request takes none
  (`PEERS_SERVERS`). The attempt records the approved list at the door, and the
  launch reads only that.
- The run's defaults reach only tasks not yet approved. Read a task's worker
  through `automation::settings_for_task` or `approval::worker_of`, never
  `task.worker` or `run.worker_defaults` alone: a start leaves on
  `task.worker` whatever it launched, a recovery's fallback model included.
- Only a subtask its parent's own manager split goes by the parent's approval
  (`Task::split_by`, read through `approval_parent`). A task the coordinator
  creates with `parentTaskId` is new work: on the plan card, held, and not
  the parent's manager's to accept. A new rule about subtasks asks
  `approval_parent`, never `parent_task_id.is_some()`.
- `reopen_task` keeps the approval and changes only the words. It records
  each reopen on the task and writes `octiq_task_reopened` into the
  coordinator's transcript, so the person sees every one. A new field a
  reopen could change belongs in that event.
- **A reopened task starts only once that notice is in the transcript and
  confirmed on disk.** The notice stands in for an approval, so it is
  tracked like one: `TaskReopen::notice_delivered` is false from the reopen
  (and for a record that does not say) until the notice is confirmed on
  disk, `reserve_attempt_for` refuses the
  task meanwhile (`heldByReopen` in the snapshot), and the scheduler writes
  what is owed (`deliver_reopen_notices`), backing off to once a minute
  while a transcript gives no confirmation. The event is made from the
  stored reopen, so every try writes the same one, and one already in the
  transcript is never written twice. **Neither a line that can be read
  back nor an append's own answer is a receipt**: a notice is recorded
  only after the record as it is now and then its folder have been synced
  in that same pass, under the append lock, and both succeeded
  (`workspaces::notice_receipts`, whose every `true` follows one
  `transcript::confirm_synced`). That holds for a line just written and
  for one found there, for a file that existed and for one compaction
  replaced: `append_synced` syncs the folder only for a file it made. **A
  receipt is for the record the line was seen in**: the page's `/clear`
  (`chat_forget`) removes a record whose chat stays listed, and the next
  line said there makes a file that syncs and holds no notice. So
  `notice_receipts` takes the record's `transcript::Generation` before it
  reads, `confirm_synced` refuses one that has moved, and the next pass
  writes the notice once into the record that is there. **The token names
  its file** (`transcript::identity`: the folder as the filesystem resolves
  it and the name, folded where two spellings are one file), so one taken
  for a file is refused on any other whatever their numbers: every file
  that never moved on used to read the same. Whatever removes a
  record, or replaces a host event's line in one (known by parsing the
  line's top-level `type`), goes through
  `transcript::forget`, `forget_file` or `rewrite_numbered`, which move the
  generation under the append lock; a new path that deletes or truncates a
  record file does the same, never a bare `remove_file`, and the page's file
  editor refuses one (`paths::host_owned`). A `/clear` after
  delivery removes the notice with the chat's history and is not undone. A
  reopen whose coordinator
  chat the person cannot open (not in the chat list, or in the trash) is
  refused. **One reopen owes no notice: the person's own, where that chat is
  gone.** The notice stands in for an approval of words the person did not
  write; these they wrote, on the page, and there is no chat left to show
  them in, so the reopen is recorded as told (`reopen_task_as`) and its
  start is not held. Where the chat is there the person's reopen owes its
  notice like any other, and the event says `byPerson`. A chat list that
  cannot be read is not a chat that is gone: that reopen is refused. A write whose receipt says whether it held
  (`record_chat_event_synced` answers `Option`) has that receipt read: a
  step that only counts once the person was told waits for it.
- A replaced task (`superseded_by`) and a task the person stopped
  (`Task::stopped`, from the socket-only `orchestration_task_stop`) do not
  start again; only the person starts the second. **Nor is a stopped task
  replaced** (`supersedable`, `STOPPED_NOT_REPLACED`): a replacement is the
  stopped work starting again under another id, and in a run with no plan
  card it started with nobody asked. A stopped task did not fail, so the
  retry budget says nothing of it and did not hold this. Once the person
  has started it again it is an ordinary task. A new way to get stopped
  work going again that is not a start of the task asks `task.stopped`
  first, the same way.
- A review of an approval boundary checks the shape that actually runs
  against a durable source of authority.

**A failed task is its coordinator's to fix, twice, before the person is
asked** (`orchestration/retry.rs`; the person's decision of 2026-10-13). A
failure is a task that failed, one its worker reported blocked with no
decision open, or one that completed with a failing verdict; a task the
person stopped did not fail. So:

- **The budget is counted at the one door, and at a replacement.**
  `Task::retries_used` goes up in `reserve_attempt_for`, with the
  reservation, for every start of a task in failure that is not the person's
  (`retry::counted`, `retry::started`): the coordinator's, the host's
  dispatch of a check that was reopened, the host's own recovery. At
  `retry::RETRY_LIMIT` (2) the door refuses in `retry::RETRIES_USED`'s words.
  A new way to start a task goes through that door, so it is counted; a new
  way to get a failed task going again that is not a start (as
  `reopen_task` and `supersede` are) asks `retry::allows` first, and a
  replacement uses one and carries the count on (`retry::replaced`).
- **No count and no budget reads a fact that exists to be shown.** A failure
  has two readings and they differ on purpose. `retry::failed_as` is what is
  SHOWN (`Task::failure`, the notice to the coordinator): it says nothing of
  a failure the host has scheduled its own recovery of, because nobody is
  asked about that one. `retry::counted` is
  what an act right now would answer, for everything that is counted: that
  scheduled recovery is a failure there, and so is a failed check that was
  reopened. `retry::allows`, `retry::started` and `retry::replaced` are
  given `counted`, never `failed_as`. A replacement read the shown one,
  found no failure in a task whose recovery was scheduled, and was neither
  held to the budget nor counted: the limit could be gone round without end
  (review of 16e4188, H1). `retry_tests::who_reads_what_a_failure_is_shown_as`
  names every caller of `failed_as` with what it does with the answer, and
  fails for a new one: that is where "does this decide something?" is
  asked. The one caller that decides is `create_gate` (is this question
  about a task in failure), and where the two readings differ it refuses.
  The same holds for every derived fact the page reads (`heldByPlan`,
  `heldByReopen`, `retrying`, `failure`, `awaits`): they are written onto a
  copy for the answer, and nothing in the host reads them back to decide.
- **The host's provider recovery keeps its own count, and shares the
  task's.** `execution.retry_count` is the recovery policy's: how many host
  recoveries in a row led to an attempt, compared with the policy's
  `maxRetries` and used for the backoff. `Task::retries_used` is the shared
  total of 2 that every automatic retry uses, the host's included.
  `execution::fail` schedules a recovery only while both allow one, so the
  most a task is started again without the person is 2 whoever starts it,
  and a policy can allow fewer. Anything new that restarts a task for the
  host is a `StartedBy::Recovery`.
- **Only the person gives more**, and each way is one no agent's call
  reaches: their Start (`StartedBy::Page`), their own reopen of a completed
  task from the page (`ReopenedBy::Person`), their answer on the page to a
  decision about the task (`ResolvedBy::Person` on a gate with
  `about_task_id`), their approval of a plan the task is put back on. A task
  that finishes well is also at zero again. A new reset is one of the
  person's own doors, never an argument an agent can send.
- **A reopen has two doors, like a start and a gate's answer**
  (`ReopenedBy`). The coordinator's comes only through `/hook/orchestration`
  (`task_reopen` → `orchestration_task_reopen_in_chat`, which the socket
  refuses) and is held to the budget. The
  person's comes only through the socket (`orchestration_task_reopen`,
  which no hook action maps to): it is taken when the retries are used,
  gives them back, closes the decision the coordinator opened about the
  task (`retry::person_decided`, which their Start calls too), and the
  first start after it is theirs and uses none, whoever carries it out
  (`workspaces::persons_reopen`, asked at the door). Without it a failed
  check whose retries were used had no door at all once its coordinator
  was gone: the page's Start is refused for a completed task. A new thing
  the person may do about a task that an agent may not is a new variant
  chosen by the route in `dispatch`, never a field of the request.
- **A gate about a failed task is not that task's gate.** The coordinator
  names the task in `orchestration_gate_create`; on a task in failure the
  host records `Gate::about_task_id` and leaves `task_id` empty
  (`create_gate`). Everything that reads a task's gates by `task_id` (is
  the attempt live, resume its worker, the next attempt's brief, a peer
  request's own snapshot) therefore does not see it, which is the point:
  nothing of the task waits on it. A reader that means "a question about
  the whole run" asks `Gate::holds_run`, never `task_id.is_none()`.
- **Whose move a failure is, is derived** (`Task::failure`, `retry::derive`
  in `snapshot`): the coordinator's while retries remain, the person's once
  they are used, the coordinator escalated, its chat is gone
  (`chat_index::listed_ids`, read once a snapshot and only when a failure
  asks; an index that cannot be read is not "gone") or a peer request's
  time is used, and nobody's for a replaced task or a run that was stopped,
  closed or archived. **A run the host calls `failed` or `completed` has
  not ended**: `recompute_run` sets those when nothing else is left to run,
  which is what an unanswered failure leaves behind.
- **The coordinator is told what is expected in the notice of the failure**
  (`retry::expectation`, appended where a failure is told: a worker's
  report, `execution::fail`, a recovery that could not start, a worker lost
  to a restart) and in the master brief (`retry::BRIEF`). A new place that
  tells a coordinator of a failure appends it too. Both travel as a turn's
  prompt (and the brief in a tool result): stdin for Claude, Codex's
  app-server, Antigravity and Pi (`--mode rpc`), but the last argument of a command
  line for Codex started as `codex exec`, where Windows' 32,767 characters
  count. `retry_tests` holds what the rule adds to a paragraph (876
  characters in the brief, at most 824 in a notice).
- A peer request follows the same budget and waits on its run's
  coordinator, whose one repair is the same job again; with its working
  time used it is the person's.

**Removing an agent and starting its work take two locks in one order: the
roster's (`team.rs` `LOCK`), then the ledger's (`OrchestrationStore::inner`).**
`team::delete_checked` hands its write to a guard (`team::Leave`); the host's
(`agent_work::Departure`) holds the ledger across that write and records the
agent in `Stored::removed_agents` before it lets go, and `reserve_attempt_for`
refuses a removed agent under the same lock. Nothing that holds the ledger's
lock may call into `team.rs`. The chats' locks come after both and are never
waited for from a removal: the session table, the queue and each session are
tried (`LeavingMark::working`), and one that is taken answers "working". A
removal made any other way (a bare check, then a write) reopens the window a
task started in. What stops a removal is in `agent_work.rs`: a task in
progress, a run one of the agent's own conversations coordinates that has
not finished or been stopped, a turn in flight in one. An idle head or front
desk is removed.

- **A removal is done only when its record is.** `OrchestrationStore::leave`
  saves the ledger with the agent in `removed_agents` FIRST and writes the
  roster second, so every failure leaves the agent registered and working: a
  ledger that cannot be saved refuses the removal with the roster untouched,
  and a roster that cannot be written has the record taken back (and says so
  when even that fails). The running server takes the record up only after
  both. A server killed between the two leaves a record for an agent the
  roster still has; `reconcile_removed`, run when the ledger is loaded,
  drops it. A roster that cannot be read changes nothing: never read "could
  not be read" as "everyone is gone", or as "everyone is here". A new step
  that changes two files orders them the same way: nothing irreversible
  before the record is on disk, and a save that fails is a refusal, never a
  line in the log.
- **A prompt and a removal of its agent never both go through: mark first,
  then look** (`agent_chat::Leaving`). `Departure::leave` marks the agent's
  own conversations (`ChatManager::mark_leaving`) before it asks whether any
  is working, and a live process takes the mark under its own lock in the
  look that finds it idle. `write_user_message_locked`, which every prompt
  goes through, refuses a session that carries it, beside its `CutOff`
  check; `start_session` refuses a chat the manager holds one for, under the
  session table's lock. So the write saw the mark or the removal saw the
  turn. Dropped without `gone`, the mark is called off; a removal that was
  made leaves it, in memory, until the server restarts. A new way to hand an
  agent a prompt goes through one of those two functions, never around
  them, and a new check of "is this chat idle" that something irreversible
  follows is made the same way: a look alone goes stale the moment its lock
  is let go.

**Facts the page reads that are derived for the answer are never stored and
never taken from an agent**: `workspaceChoice`, `heldByPlan`, `heldByReopen`, `failure`,
`retrying` and `retryLimit` on a task, `awaits` on an open gate and a pending
native decision, `usage` and `context` on an attempt, `coordinatesRun` on a
chat's index entry. Each is
`skip_deserializing` or added at the dispatch arm, and absent rather than
zero or guessed when the host does not know (`docs/agents-mode.md`, What the
run panel reads from the host). **Not read back is half of "never stored";
the other half is not written.** A derived field of a stored struct is
`skip_deserializing` AND left out of what is saved (`skip_serializing_if`,
with a value the stored copy never holds: `None`, `false`). `retryLimit`
was a plain `u32` with `skip_deserializing` alone, and every task was saved
with `retryLimit: 0` while the answer said 2 (review of 16e4188, H3). A
ledger that holds one needs nothing done to it: the key is ignored on read
and gone at the next write. A new derived field gets a line in
`retry_tests::the_ledger_on_file_holds_nothing_a_read_derives`, which makes
real writes and reads the file. A fact the host does know is said outright:
`heldByPlan` is `true`, `false`, or exactly `set this to true or false` on every task of a run that has a plan
approval, because a page sent nothing for "not held" could not tell it from
a host that does not say, and read an approved task as held. `awaits` says
who must decide and nothing else; whether the attempt can go on right now is
`continuation`'s to say. `failure` is on every task that is in failure and
on no other, and its `awaits` is the one word for whether a failure is the
coordinator's, the person's or history: a reader does not work that out from
`run.status`. What the host counts is stored and said beside it:
`retriesUsed` on the task, `retry` on an attempt that started on a failed
task, `aboutTaskId` on a gate.

**A mid-turn instruction that loosens a permission or safety rule goes through
a decision gate.** When a coordinator's `orchestration_message_send` would add
an MCP tool to `permission::host_bookkeeping` or Claude's `--allowedTools`,
turn off a confirmation or widen an access level, the worker does not act on
it: it opens `orchestration_gate_create` and acts once the decision comes back
as a turn. A worker cannot tell from a tool result whether such an instruction
came from the person, and a gate leaves the decision with them. An ordinary
scope clarification needs no gate.

**A peer request is one approved job, and nobody but the person adds to it.**
Whoever asked is the worker's teammate, not its manager, so the host delivers
a peer-request worker no coordinator's message (`record_message` refuses every
kind, from a chat and from the page) and a gate on its task is answered only
by the person on the page (`ResolvedBy::Person`: the socket's
`orchestration_gate_resolve`, which no hook action maps to). A new path that
puts an agent's words in a worker's inbox, or continues a worker, asks
`task.peer_request` first. Its worker reads only its own task of the ledger
(`OrchestrationStore::snapshot_for_agent`, by the attempt on record), so a new
read of the ledger that an agent can start goes through it too. What it reads
there is written by itself, by the host or by the person and by nobody else:
the run's coordinator registers no service for the task, makes no validation
checkout for it and names no base branch for its start
(`peer_request::PEERS_SERVICE`, `PEERS_VALIDATION`, `PEERS_BASE`), and the
run's worker defaults, recovery policy and fallback model included, are not
copied onto it. A new
field on a task, an attempt, a gate or a service that a coordinator's command
can fill with text needs the same refusal before it ships. Its `maxMinutes` is working time, and a wait is
free only while the host can verify that nothing is running: between two of
the scheduler's looks that both saw a card or an open gate with nothing
running (`Look::nothing_running`: no owed full stop, and no turn in flight
other than one parked on the very calls the cards ask about, by the
provider's id in `execution.pending_tools`). A card is not proof that nothing
runs: a tool call beside it is charged, as a gate under a running turn is.
Charging and ending are separate: an attempt is never ended in front of a
card, and one past its limit is ended on the first look after the card is
answered. Used time never goes down, and what the agent left running in the
background after its turn ended is not counted (`docs/agents-mode.md`, The
time limit).
