# A chat's plan

A plan is the list a person and an agent agree on before work starts. The
person sends several things one by one, answers the scoping questions on
each, and says "start" at the end. The chat keeps that list: an ordered set
of items, each with a status, the decisions made and the questions still
open. The person reads it in the Plan panel beside the chat and presses
Start when it is right.

This page is the host half: `src-tauri/src/chat_plan.rs`, the hook in
`web.rs`, the commands in `dispatch.rs`, the two tools in
`scripts/mcp/octiq-ask.cjs`. It is also the contract the page is built on.

It is **not** the orchestration plan card (`docs/agents-mode.md`, Plan
approval). That card approves the tasks of a run, and still has to be
approved after Start. A chat's plan comes before any run exists.

## Three owners

| What | Whose | How |
| --- | --- | --- |
| The list: titles, statuses, decisions, open questions, notes, linked task ids | The chat's own agent | `plan_update`, through `/hook/plan` |
| Start | The person | `chat_plan_start`, the page's command. No hook routes to it and the MCP server has no such tool |
| How an item's tasks stand (`progress`, `linked`) | The host | Counted from the ledger for each answer. Never stored, never taken from the agent |

The person only reads the list in this version. They change it by saying so
in the chat.

An item's own `in_progress` or `done` is the agent's word and is shown as
that. The host's count stands beside it and can disagree: the recorded
fixture has an item the agent calls `done` whose review failed.

## The plan

One per chat, kept in `<chats dir>/plan_<chat id>.json`.

| Field | Meaning |
| --- | --- |
| `revision` | Goes up by one on every change to the list. `0` is a chat with no plan. Start does not move it |
| `items` | In order |
| `updatedAt`, `updatedBy` | When, and who: the chat's registered agent by name, else `agent` |
| `started` | `{ at, revision, turnId, told }`, written by the person's Start and nothing else |

An item:

| Field | Meaning |
| --- | --- |
| `id` | The host's: `i1`, `i2`, … Never reused |
| `title` | One line |
| `status` | `discussing`, `decided`, `in_progress`, `done`, `dropped` |
| `decisions` | Short lines |
| `questions` | Questions still open, short lines |
| `note` | Optional |
| `tasks` | Ids of the orchestration tasks the item became, as the agent linked them |
| `addedIn`, `changedIn` | The revision it was added in, and last changed in |

Limits, refused in words when over: 60 items (dropped ones included), 12
decisions and 12 open questions an item, a title 120 characters, a decision
or question 240, a note 600, 24 linked tasks an item. Characters are Unicode
characters, not bytes. A title, a decision and a question are one line: runs
of spaces and line breaks become one space, and an empty line is left out.

### A change patches items by id

`plan_update` carries `baseRevision` and any of `add`, `update` and `order`.
It never replaces the list, and nothing is ever removed.

- **Why not the whole list.** A plan is built one item at a time over a long
  conversation. Replacing it would have the agent retype up to sixty items
  to answer one question, which is where an earlier item gets reworded or
  lost. A stable id also has to be the host's, and a replacement would have
  the agent echo every id back correctly.
- **Why no remove.** The person can only read the list, so nothing should
  vanish from it. An item leaves by `dropped` and stays visible.
- **In `update`** a field left out stays as it is; a list that is sent
  (`decisions`, `questions`, `tasks`) replaces that item's whole list; an
  empty `note` clears it.
- **`baseRevision`** is the revision the agent last read (`0` for a chat
  with no plan). A change based on an older revision is refused whole, so
  two writers cannot overwrite each other.
- **A change that asks for what the plan already says** writes nothing: the
  revision stands, the answer says `changed: false`, no event.
- **`in_progress` is refused before Start.** Nothing is in progress before
  the person started it.
- **A linked task** has to be in the ledger, in a run this chat coordinates.
  Only a task linked anew is checked: one an item already names may since
  have left the ledger.

### What the host derives

For an item with linked tasks, on every answer:

| `progress` | Counts |
| --- | --- |
| `done` | Settled, and its check did not fail |
| `running` | An attempt is being prepared or is running |
| `failed` | Failed, blocked with no decision open, or settled with a failed check. A task the person stopped did not fail |
| `waiting` | Still owed and not running: not started, held, waiting on a decision, stopped by the person |
| `total` | `done + running + failed + waiting` |
| `closed` | Cancelled, replaced, or unfinished in a run the person stopped, closed or archived. Counted nowhere else |
| `unknown` | An id the ledger no longer holds |

`linked` lists the tasks the ledger holds, in the item's order, each
`{ id, runId, title, state }` with `state` one of `done`, `running`,
`failed`, `waiting`, `closed`.

Both are absent, not zero, for an item with no linked task and when the
ledger could not be read. `awaitsStart` on the plan is derived too.

The count moves with the ledger and no `chat-plan` event says so: the page
reads `chat_plan_get` again when the ledger changes.

## Who may write

`/hook/plan` takes the chat from the caller's capability, never from its
arguments. A change is refused, before anything is read, for:

- a **front desk** (it only routes),
- a **room seat** (`session_key != chat_key`: one voice in the chat, not the
  agent the person is planning with). A seat may read,
- a **worker**, by what the chat is (`is_worker_chat`): it stays one after
  its attempt settled, while its capability still works. Its task is its
  plan.

The socket refuses `chat_plan_update` (`CHAT_ONLY_COMMANDS`): a change is
recorded as the agent's, and only its capability says so.

## The Start gate

While a plan is not started and has at least one item that is not dropped
(`awaitsStart`), the chat's agent is refused, on `/hook/orchestration`:

- `orchestration_run_create`
- `orchestration_task_create`
- `orchestration_worker_start` (the hook's `orchestration_worker_start_in_chat`)
- `orchestration_dispatch_ready`
- `orchestration_task_reopen` (the hook's `orchestration_task_reopen_in_chat`)

The refusal begins `This chat's plan has not been started.` and says that
only the person's Start does that.

- **A chat with no plan is never asked anything.** Every existing flow is
  as it was.
- **Every item dropped**: nothing is held, and there is nothing to start.
  One more item and the plan holds again.
- **Once started a plan never gates again**, whatever is added to it. Items
  added after Start do not wait for another Start in this version.
- **A plan that cannot be read holds the gate**: with the profile folder
  away, or a file that cannot be understood, the refusal is that reason. A
  missing folder never reads as "no plan".
- **The person's own commands are not gated.** The run panel's New run and
  its Start come through the socket, not the hook.

### What the gate does not cover

- **Work in the chat itself.** The gate covers work started through the
  host. It cannot stop an agent editing files or running commands in its own
  chat. The tool description and the rules text tell it not to.
- **The peer tools** (`orchestration_peer_ask`, `orchestration_peer_request`).
  The person approves each peer request on its own card.
- **The host's own scheduler**, for a run that existed before the plan: its
  approved tasks go on being dispatched.
- **An agent that drops every item** lifts the gate. It is visible: the
  items stay on the list, dropped.

## Start

`chat_plan_start { chatId, revision, start? }`. Its point is the record, so
it is save-first.

1. Refused for a worker's chat, a front desk and a chat in the trash.
2. Refused when there is no plan, nothing on it is live, or `revision` is not
   the plan's revision (the agent wrote since the person looked).
3. A chat with no process needs `start`, the settings the page would start
   the chat with. Without them the answer is `chat '<key>' is not running`
   and nothing is recorded: the page asks again with `start`. This is
   `chat_complete`'s protocol.
4. `started` is saved. A save that fails refuses the Start whole: nothing is
   sent, nothing is announced, the plan still waits.
5. The host hands the agent one turn in its own words
   (`chat_plan::start_message`), under a turn id that starts
   `octiq-plan-start-`. It waits behind a running turn like any message
   (`state: "queued"`), or is written to an agent between turns
   (`state: "started"`), or is the first message of a chat that had no
   process.
6. `started.told` is saved once the turn was handed over.

**When the turn cannot be handed over the Start stands.** The answer is not
an error: `delivered: false` with the reason in `notDelivered`, and
`started.told` stays false. **The page asks again with the same command**
(`revision` is not checked then), and the host does not retry by itself.

### One Start, one turn

However often the command is asked, and from however many tabs at once, the
agent is handed the Start's turn once. When and on which revision the plan
was started is recorded once, by the first ask, and never touched again.
Three things hold it:

- **A claim.** From reading whether the agent was told to noting that it
  was, one ask at a time has the chat's plan. Two asks at once are one after
  the other, and the second finds what the first did: its answer is
  `delivered: true`, `state: "told"`, with the same `turnId`.
- **A receipt that is not the note.** `started.told` is a note, and a note
  can fail to be saved. The receipt is the turn itself, in the chat's
  record, under an id that belongs to the Start: `started.turnId` is made
  with the Start and saved with it, and every try at telling the agent is
  under that id or one counted on from it (`…`, `…-try2`, `…-try3`). Each ask
  of a started plan first reads what became of those turns
  (`agent_chat::host_turns`):

| What the record says of the Start's turn | The ask |
| --- | --- |
| nothing: no try left a line, and this server did not hand it over | hands the turn over, under the same id |
| handed over (written to the agent, in the host's queue or being carried into the next process, acknowledged, or its process ended before saying so) | sends nothing. If `told` was false it saves it. `state: "told"` |
| envelope alone, with no delivery line, provider receipt, queue or host-memory evidence | refuses in words as uncertain; neither marks told nor resends |
| gone (below) | hands over the next try, under the next id |

- **What the server did, kept by the server.** Both receipts above are
  files. The turn's line is written best effort before the turn goes to the
  agent, and the note after it; when the chat's record takes no line and
  the plan's file no save (a chats folder that refuses writes), the turn is
  with the agent and nothing on disk says so. So the server remembers each
  hand-over it made for as long as it runs (`chat_plan::StartTurns`, one for
  a chat, beside the claim), and an ask reads that before the record. For a
  turn it handed over itself only a line that says the turn is gone makes
  it so: no line at all is **handed over**, and so is `queued` last with
  the queue no longer holding it, which is this server's queue having let
  it go, to the agent for all the record says. The note is owed:
  `profile_status.owed` names `plan starts told`, the host saves it on its
  next pass (every two seconds, under the claim, with a `chat-plan` event),
  and so does the next ask. A turn the server took back from its queue is
  remembered too, and is **gone** (below).

So a turn that was handed over and whose note could not be saved
(`delivered: true` with `started.told: false`, and the failure in `unsaved`
beside the answer) is not handed over again: the next ask finds it, saves
the note and answers `state: "told"`. Before the fix of 2026-10-14 every ask
made a fresh turn id, so nothing tied two asks to the one Start: two asks at
once queued two turns, and so did an ask after a note that failed to save.
And until the second fix of that day a turn whose line and note had BOTH
failed was handed over again by the next ask, under the same id (the
review's probe: chats folder mode 0500, record 0400, then the modes put
back and `Tell the agent` pressed).

**A turn that is gone can be told again, and that is how it is told apart
from one that was delivered.** A Start's turn is gone when its line in the
record says so, and each of these is a line the host already wrote:

- the person took it back from the queue (✕, `chat_cancel_queued`:
  `octiq_user_turn_cancelled`), or dismissed it;
- it was marked not sent (`octiq_user_turn_delivery`, `state: "failed"`):
  the write to the agent failed, or its chat's process was ended on purpose
  with the turn still queued;
- its last word is `queued` and no queue holds it: the host's queue is in
  memory, so that is a turn a server queued and did not live to hand over.

A turn that was written to the agent has `dispatched` (or `starting`, or the
provider's acknowledgement) after `queued`, and is never gone. One whose
process ended before it said it had the prompt (`unknown`) counts as handed
over: the words may have reached the agent, so the host does not send them a
second time.

The ✕ on a queued Start turn takes the turn back, not the Start: there is no
un-start. It sets `started.told` back to false (the `chat-plan` event says
so), so the page offers `Tell the agent` again; that ask hands over the next
try. The other two ways a turn goes leave `told` true until the next ask,
which reads the record whatever the note says, sets `told` to false and
hands over the next try. The page does not offer that ask today (it offers
`Tell the agent` only while `told` is false): it can, for a Start turn its
transcript shows as not sent.

The server remembers a taking back the same way it remembers a hand-over:
a turn taken back from its own queue is over, whatever line the record
took of that, so a turn taken back while the record refused every line is
told again by the next ask, under the next id (a page that heard it taken
back has dropped its bubble by the old one). The note that the agent no
longer has the turn is owed like the other when it could not be saved,
and the host's pass saves it, so the page comes to offer `Tell the agent`
without anyone asking first. Read from the files alone, a plan saying
`told` for a turn that left no line was handed over for good.

**What is not covered, and it is a restart.** What the server remembers is
in memory, and so is the note it owes.

- A server that stops after a hand-over and before either the turn's line
  or the note was saved leaves nothing that says the turn was handed over.
  The next server's first ask hands it over again, under the same id: the
  agent is told of the Start twice. It needs both files to refuse a write
  and the server to stop inside the time they do (the note is tried again
  every two seconds).
- `/clear` removes the chat's record and keeps the plan. The server that
  handed the turn over still knows it did and sends nothing. A server
  started after the clear, for a plan whose note was never saved, reads it
  as never told, and an ask then hands the turn over again.
- A turn this server queued, of which the record took no line, and which
  then left the queue with the record refusing that line too, reads as
  handed over until the server restarts, whether it went to the agent or
  was dropped. The words may be with the agent, so they are not sent twice;
  if they are not, the person's own message tells it.

The other choice was to refuse the tell while no receipt could be kept. It
was not taken: the hand-over is made in three places (written to a running
agent, joined to the queue, the first message of a new process), the turn's
line in the third is written once the process exists, and a receipt written
ahead of a hand-over that then fails has to be taken back by a second write
that can fail too, which leaves a plan saying `told` of an agent that was
not.

The turn is not the person's own message: its id is not a person's turn id,
so the queue never folds a message into it, and it is no evidence for
`orchestration_plan_approve_in_chat`.

## When the chat goes

A plan follows the chat's task status. It is kept through the trash window,
so a restored chat still has its plan, and removed when the chat is purged.
`/clear` keeps it. While a chat is in the trash its plan is neither changed
nor started.

## Contract

### Commands (the page's socket)

| Command | Arguments | Answer |
| --- | --- | --- |
| `chat_plan_get` | `{ chatId }` | The plan (below). A chat with no plan answers `revision: 0`, `items: []`, `awaitsStart: false` |
| `chat_plan_start` | `{ chatId, revision, start? }` | `{ plan, turnId, delivered: true, state: "started" \| "queued" \| "told" }` or `{ plan, turnId, delivered: false, notDelivered }`. An error means nothing was recorded |

`chat_plan_update { chatId, change }` exists and the socket refuses it.

The plan as answered:

```json
{
  "chatId": "…",
  "revision": 2,
  "items": [{
    "id": "i1", "title": "…", "status": "done",
    "decisions": ["…"], "questions": [], "note": "…",
    "tasks": ["task_…"], "addedIn": 1, "changedIn": 2,
    "progress": { "total": 2, "done": 1, "running": 0, "failed": 1, "waiting": 0, "closed": 0, "unknown": 0 },
    "linked": [{ "id": "task_…", "runId": "run_…", "title": "…", "state": "done" }]
  }],
  "updatedAt": 1791885679074,
  "updatedBy": "OCTIQ HEAD",
  "started": { "at": 1791885679072, "revision": 1, "turnId": "octiq-plan-start-…", "told": true },
  "awaitsStart": false
}
```

Left out when there is nothing to say: `note`, `progress`, `linked`,
`updatedAt` and `updatedBy` (no plan), `started`.

### Event

`chat-plan { chatId, plan }`, with `plan` as `chat_plan_get` answers it.
One on every change to the list, one when a Start is recorded, one when
`told` is saved, and one when it is set back to false (the Start's turn was
taken back, or found gone by an ask). None for a change that changed
nothing, and none when the ledger moves.

### Tools (the agent)

| Tool | Arguments | Answer |
| --- | --- | --- |
| `plan_read` | none | The plan, plus `note`: one line on where it stands with Start |
| `plan_update` | `{ baseRevision, add?, update?, order? }` | The plan after the change, plus `changed` and `note` |

`add[]`: `{ title, status?, decisions?, questions?, note?, tasks?, before? }`.
`update[]`: `{ id, title?, status?, decisions?, questions?, note?, tasks? }`.
`order`: every existing item's id.

Offered to a chat's own agent only: not to a worker, a front desk, or a
process with no chat. The host refuses the same callers whatever the script
offered.

Neither tool raises a permission card (the person's decision of 2026-10-13):
both are in `permission::host_bookkeeping`, beside `task_status`. They are
not on Claude's `--allowedTools`, which is a command line; that list answers
the permission request at every access level.

### The Start turn

A recorded user turn whose id starts `octiq-plan-start-`. The page knows it
by that prefix, as it knows a wrap-up by `octiq-complete-`. Its words are
the host's.

### Where the rules text travels

| Text | Route | On a command line |
| --- | --- | --- |
| How to keep a plan | The `plan_read` and `plan_update` tool descriptions, over stdio | No |
| When to keep one (one sentence) | Claude: the MCP server's instructions, over stdio. Codex app-server: developer instructions, a message on stdin. Antigravity: the plugin's rules file | No |

`codex exec` and Pi are not told the sentence: `codex exec` takes its
instructions as an argument, and Pi has no host rules. `codex exec` still
has the tool descriptions. A worker and a front desk are not told.

The MCP server's instructions are held under 4,096 characters, which is all
Claude Code keeps of them (`scripts/mcp/instructions.test.cjs`).

### Fixtures

`web/src/lib/__fixtures__/host/chat_plan_{none,discussing,decided,started}.json`
are answers the host's own tests gave; the README there says which. Types:
`web/src/lib/chatPlan.ts`.
