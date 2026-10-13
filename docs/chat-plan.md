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
`started.told` stays false. **The page asks again with the same command.**
On a plan that is already started:

- `told` is false: the turn is tried again under a new turn id. When and on
  which revision the plan was started is not touched, so nothing is recorded
  twice. `revision` is not checked.
- `told` is true: nothing is sent. The answer is `delivered: true`,
  `state: "told"`.

The host does not retry by itself.

The ✕ on a queued Start turn (`chat_cancel_queued`) takes the turn back, not
the Start. There is no un-start.

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
`told` is saved. None for a change that changed nothing, and none when the
ledger moves.

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
