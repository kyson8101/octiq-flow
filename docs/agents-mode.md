# Agents mode

Agents mode is a switch in **Settings → Agents**. When it is off, chats work
exactly as before. The idea follows [Paperclip](https://paperclip.ing/): you
manage a team of agents instead of prompting one.

When it is on:

- **New conversation** in the sidebar opens an empty conversation, the same
  page a first load shows. It reads **Talk to <name>** and starts on the
  configured head (see below). When more than one agent reports to you, a
  compact **Talk to** picker lists them (see **Who a new conversation is
  with**). Picking one sets the chat's provider, model, effort and access to
  that agent's settings, for this conversation only. The next new
  conversation starts on the head again.
- The first message goes to that agent, the **lead**, with a brief after it.
  The brief names the lead, gives its role, and lists its direct reports. The
  chat shows only what you typed, plus a "task for <name>" label. The brief is
  kept in the transcript, so a resumed chat still knows its team.
- The sidebar gets an **Agents** row that opens the dashboard.
- The composer of a conversation with an agent is **compact**: the message
  box, attachments, the agent's avatar and name, and Send. It reads
  "Message <name>…". Role, provider and model are in the chip's tooltip and
  in Settings → Agents, which owns those settings. A new conversation starts on the
  registered settings; an existing one keeps the model it was recorded with,
  so reopening it never moves its history to another model. If the agent was
  removed, the name is struck through and the conversation keeps its last
  settings. Ordinary chats, and every chat when agents mode is off, keep the
  pickers and the location shelf exactly as before.

## Who a new conversation is with

A new conversation can only be with an agent who **reports directly to you**:
one with no manager in the org chart, or one whose manager is no longer
registered (the chart draws those at the top too). It does not matter whether
the agent is global or belongs to one project, and no name is special.
Anyone's report is left out, global or not. You reach them through their
manager, who may pass the work on. An agent whose project is no longer an open
project has nowhere to work, so it is left out as well.

- The picker reads the whole roster (`team_list` with `all`), so a project
  agent at the top, such as the head of one website, is offered from any page.
  The configured head comes first, then the rest by name
  (`lib/agentsMode.ts`, `conversationRecipients`).
- The head is selected by default, however the page was reached, including a
  first load inside another agent's project. With no head configured, the
  default is the first global agent at the top, then one that works in the
  project on screen (`conversationRecipient`). Picking someone never changes
  **Settings → Agents → Talk to**.
- **The head** is always the cross-project conversation from the home
  workspace (below).
- **A project agent** only works in its own project, so picking one moves the
  draft to that project. Its repository, branch, worktree and sandbox are then
  chosen exactly as for any lead in that project, and **Advanced** offers no
  other project. If the draft is moved to another project anyway, the choice
  goes back to the default, which the page shows. A send that would still put
  a project agent in another project is refused, and nothing falls back to
  someone else.
- **Any other global agent at the top** leads in the project on screen, or
  from home when there is none. It is not the cross-project conversation.
- The host enforces the same rule: `team_brief` refuses to make someone's
  report the lead of a **new** conversation (`team::reports_to_person`). A
  conversation that already has a lead keeps it, even if the chart changes
  later. Delegation inside a run is unchanged: an assignee must still be a
  direct report of whoever assigns it.

## Where a new task runs (automatic, with Advanced overrides)

The project, branch, worktree and sandbox controls are hidden on a new task.
They are still decided: `lib/agentExecution.ts` (`autoExecution`) chooses them,
and the send path applies exactly that plan:

- **The head** coordinates from the home workspace (below), whichever page the
  conversation was started from. No git is prepared and no sandbox is started
  for the conversation. Every task it hands out gets its own destination and
  environment from the host.
- **A lead in a project** starts in a **new worktree** of that project, based
  on the branch the project is on. The host resolves the base and creates the
  worktree (`git_prepare_chat_workspace`). A folder that is not a repository
  runs in place. The primary checkout is where the person and other chats work,
  so a lead doing the work itself does not write there.
- **No code project** → the home workspace, no git.

The sliders button next to the agent opens **Advanced**, which is the
ordinary location shelf. Only the fields the person changes there override the
automatic plan, and the button is tinted while they do. The chosen plan is
recorded on the chat once, before its first turn (`ChatMeta.launch`,
write-once in `chat_index::upsert`). It is shown as the **planned**
environment and never as a verified fact.

## Home workspace

The head's conversations live in the **home workspace**, a registered workspace
chosen in **Settings → Agents → Home workspace** and stored as an id in
`team.json` (`home`, `team_home` / `team_home_set`; only a registered
workspace is accepted). With none chosen, or the chosen one removed, it is the
project named **General**, created lazily as before. No machine path is
hard-coded: on this machine General is simply the registered project at
whatever folder the person gave it. Entering the conversation never asks for a
project or a Git setup.

## Environment details (planned vs verified)

The task panel behind the status line (`ChatTaskBar`) has an **Environment**
section: the agent (avatar, name, state, provider/model), project, repository,
working directory, branch, base branch, target, checkout (primary checkout or
task worktree, and its path), sandbox and git state. Each path has a Copy
button. `lib/taskEnvironment.ts` merges two sources and labels every row:

- **Planned**: the chat's `launch` plan, or, for a worker chat, its orchestration
  task's destination and workspace plan (latest attempt, so retries show the
  one running).
- **Verified**: `chat_task`'s git verification of the chat's own directory,
  with when it was checked. The sandbox is reported by its own state.

**Stale** (the directory is gone and git was read from the primary checkout),
**Removed** (a cleaned or deleted worktree) and **Not verified** are never
drawn as verified. A base branch is always Planned, because git keeps no record
of it.

## Persona: names and avatars

A chat handed to a registered agent speaks as that agent: its name and avatar
sign replies, the composer and its working indicator, the sidebar row, the task
board, the plan review and the Run panel. Web and push notifications say
"<name>: …". Identity is the registration id (`lib/agentPersona.ts`), so a
rename or a model change updates every label, and a removed agent keeps the
name the work was handed to. Ordinary chats keep the provider's name. A title
the person or the agent chose is never replaced.

Each agent can have an **avatar** (`team.json` `avatar`, a PNG/JPEG/WebP
`data:` URL that `agent_avatar::checked_data_url` checks by magic bytes, under
512 KB). Without one, initials on a stable tint are drawn, with an accessible
label. In the hire/edit form:

- **Upload image**: PNG, JPEG or WebP up to 8 MB. The browser crops it to a
  256px square (`lib/avatarImage.ts`) before it is stored.
- **Generate with ChatGPT**: runs `codex exec` with Codex's built-in image
  generation (`$imagegen`, gpt-image) through the person's own Codex CLI
  **ChatGPT sign-in**. It counts toward that account's Codex usage. There is no
  API key and no reading of credentials. `agent_avatar_status` says honestly
  when it is unavailable: Codex missing, not signed in, signed in with an API
  key, or the feature off. It also gives the fix, and upload still works. A job
  runs in its own folder with a 5-minute deadline. At most two run at once, and
  one can be cancelled. Leaving the form cancels it. The output is re-checked:
  a regular file, not a symlink, and a real image. The picture is previewed
  beside the current one. **Use this**, **Regenerate** or **Discard**; nothing
  is saved until **Save**.

The switch is stored per browser (`octiq.agentsMode`). Registered agents are
stored on the server, so every browser sees the same team.

## Talk to your lead (the CTO conversation)

**Settings → Agents → Talk to** picks one **global** agent as the lead you talk
to across projects — typically a CTO. It is configured, never inferred from a
name, and stored in `team.json` (`head`). Only a global agent qualifies; the
host refuses to move it into one project while it is the head, and removing it
clears the setting. With none configured, a new conversation starts on another
agent at the top of the chart (above). With no agent reporting to you at all,
**New conversation** opens Settings. A head that has been put under a manager
is someone's report, so it is not offered until it reports to you again.

It is the default of every new conversation, whatever project is on screen.
Its conversations live in the home workspace and are recorded as cross-project
lead records (`crossProject: true`). A conversation keeps the lead it was first
handed to: when you configure a different head, the next new conversation
starts with it, and the host refuses to hand an existing conversation to anyone
else (`team::record_lead`), so no history is silently retargeted.

The head's brief lists its direct reports from every project, each marked
"works in any project" or "works only in project X", and tells it to:

1. call `orchestration_destinations` for the registered projects, their
   repositories, and which of its reports may work in each;
2. give every task a destination — `project` and, when the project has more
   than one repository, `repository` — on `orchestration_task_create`; one
   objective may span several projects and repositories, one task per
   destination;
3. ask you only when the destination is genuinely ambiguous, and otherwise say
   which it chose.

## Task destinations and scope

The host resolves every destination (`orchestration/destination.rs`); the
agent's word is never taken:

- Only a **registered project**, and only a **repository registered on it**
  (its main folder or one of its other folders), is a destination. Any other
  path is refused.
- A **global** agent may route anywhere. A **project** agent — manager or
  assignee — works only in its own project. So the head may give a
  project-scoped report work in that report's project and nowhere else, and a
  project-scoped lead cannot send work out of its project.
- The assignee must still be a **direct report** of whoever is assigning.
- An explicit destination that does not resolve is an error listing what is
  registered. Nothing falls back to the coordinator's checkout.
- In the head's conversation a task must have a destination. Naming a report
  who works in only one project is enough to name that project; a project with
  several repositories still needs `repository`.
- A task created in an ordinary project-bound lead chat without a destination
  runs in the run's own checkout, exactly as before destinations existed.
- A manager's subtask runs where its parent does unless it names another
  destination within its own scope.

The destination is stored on the task and carried through the worker chat
(which belongs to the destination project and gets its environment), the task
workspace and lease, execution, retries and review. It is checked again before
every worker start; a destination deleted since approval stops the task.
Worker provider, model, effort and access still come from the assignee's
registration.

## Registered agents and the org chart

Each agent has a name, a role, a provider (Claude or Codex), an explicit model
(never the CLI default), an effort level and an access level. It is either
**global** (every project) or belongs to **one project**. Two agents that could
appear in the same project cannot share a name.

Each agent may **report to** another agent. An agent with no manager reports to
you. The host refuses loops. It also refuses a manager that isn't available
everywhere its report is: a global agent reports only to a global one. Deleting
a manager moves its reports up to its own manager.

Fable and Astra agents are marked **lead only**. They can receive a task, but
orchestration rejects them as workers, so they cannot be assigned one.

Stored in `<profile dir>/team.json` (`team.rs`), together with a record of
which chats were handed a task and to whom (`leads`), and the configured head
(`head`). Commands: `team_list`, `team_save`, `team_delete`, `team_brief`
(`crossProject` for the head's conversation), `team_leads`, `team_head`,
`team_head_set`.

## Teams and peer help

A **team** is a named group of agents who may ask each other questions while
they work. It sits beside the org chart, not in it: joining or leaving a team
never changes who reports to whom, where an agent may work, its access, or
plan approval. Teams are managed in Settings → Agents (add, rename, remove),
and an agent is put on one from its own form (**Team**, with None). One team
per agent. A team is global or belongs to one project; a global agent may join
any team, a project agent only a global team or its own project's. Removing a
team leaves its members registered on no team; removing an agent takes it off
its team. The team shows as a badge on the org chart and on the Agents page.

Stored with the agents in `team.json` (`teams`, and `teamId` on each agent).
Commands: `agent_team_list`, `agent_team_save`, `agent_team_delete`. A
`team_save` with no `teamId` keeps the agent's team; `""` takes it off.

**Peer help is a question and an answer, not a handoff.** A worker whose task
was handed to a registered agent is told in its brief who its teammates are
(name, role, id, and those who may look at the task's project only) and that
peers answer questions and do not do the work. It asks with the MCP tool
`orchestration_peer_ask` (`teammateId`, `question`, optional `contextPaths`
inside its workspace). The host (`orchestration/peer.rs`):

- accepts the call only from the chat of a running attempt, and only for a
  registered member of the asker's own team who may work in the task's
  project; asking itself, someone off the team or an unknown agent is refused
  with a message naming who it can ask;
- allows 5 asks per attempt (answered or not) and questions of up to 4000
  characters, and cuts answers at 8000;
- runs the answer as the teammate's registered provider, model and effort
  (a Fable or Astra teammate may answer: answering is not working a task) in a
  one-shot process in the asker's workspace with read tools only (Claude:
  `--tools Read,Grep,Glob`, no MCP; Codex: `-s read-only`,
  `--ignore-user-config`), none of the chat's `OCTIQ_*` variables and a
  10-minute deadline, so it cannot write, reach the orchestration hook, or ask
  a peer of its own;
- records every ask in the run's ledger (`peerAsks` in the snapshot: question,
  answer or error, asker, helper, times, tokens) before the teammate starts,
  and settles it after; an ask cut off by a restart is marked failed on load.

The answer comes back as the tool result. The task view shows the exchange
under the task's row (Peer help). No gate is involved: the ask sits inside a
task the person already approved. Read-only means no writes: a Codex
teammate's sandbox can still read outside the workspace.

## Chain of command

Delegation follows the chart, at most **three levels**: lead → manager → worker.

1. The lead **does it itself** in its own chat (no run), **passes it on** to
   one direct report, or **splits it** among its direct reports. A lead with no
   reports is told to do the task itself.
2. A direct report that manages agents is told, in its worker brief, that it may
   split its own task once more among **its** direct reports. It calls
   `orchestration_task_create` with `parentTaskId` set to its own task and an
   `assignee`, then settles its own attempt. Anything that depended on its task
   now also depends on the subtasks. Subtasks cannot be split again.
3. Everyone else only does their own task.

The host enforces each rule. In `dispatch.rs`, `orchestration_task_create`
resolves `assignee` and the destination together through
`orchestration::destination::route` (which uses `team::resolve_in` against the
destination project) and the right manager: the lead
when the coordinator of an agents-mode run creates the task, or the parent
task's assignee when a worker splits its own task. A task with no assignee in
an agents-mode run is refused. The store accepts a task from a non-coordinator
only from the active worker of the named parent, and only when the parent is
top-level and has an assignee. The assignee's provider, model, effort and
access become the task's worker settings, so a lead cannot misquote a teammate.

## Plan approval

Every run a lead opens waits for you (`run.planApproval`, always required).
Until you approve it, the host refuses every worker start, manual or automatic,
and the scheduler skips the run. The lead creates all its tasks, replies with
the plan as a short list, and ends its turn. The run's **Plan ready for
review** view lists each task with who it goes to and **where it runs** —
project and repository, the full path in its tooltip; a task without a
destination shows the run's own project and checkout. **Approve plan** calls
the browser-only `orchestration_plan_approve`, which is deliberately left out
of the agent hook so no agent can approve its own plan. To change the plan,
reply in the chat. The button is disabled only while the lead is still
drafting and there is nothing to review yet.

The same review is also drawn **at the end of the lead's own chat**
(`components/ChatPlanCards`, `lib/chatPlans.ts`). It is the same component,
reading the same ledger snapshot, so the chat and the run panel always show one
state. A click in either shows "Approving…" in both and sends once
(`lib/planApproving.ts`). Each card is named **Plan &lt;handle&gt;**, the first four
hex digits of the run id, and carries its **revision**. An approved plan folds
to one line, "Approved in chat · revision 4". A plan the lead changes after
approval comes back as a new, waiting revision. It is never the old card with
the new scope.

### Approving by chat

You can also approve by telling the lead, as in "approve this plan", or
"approve plan 2278" when several plans wait. The lead calls the agent tool
`orchestration_plan_approve` (hook action `plan_approve` →
`orchestration_plan_approve_in_chat`) with only the run id and the revision it
showed. **The lead never passes your words.** The host decides on evidence
that only it holds:

- **Whose message.** The browser's `chat_send` / `chat_start` record your words
  by turn id before they are dressed for the agent (`ChatManager::
  note_person_turn`). They also record the plans on your screen at that
  moment, as `seenPlans` [{runId, revision}]. The chat session remembers
  which turn it is answering (`ChatSession::answering`, set by every write to
  the agent). A notification, a gate answer, an internal continuation or any
  agent-to-agent text has no such record, so it can never approve. Coalesced
  follow-ups join one record, so "approve" then "but change X" is read as one
  turn.
- **What it says.** `orchestration/consent.rs` accepts only a WHOLE message
  that is a plain approval: *approve / approved / I approve*, at most one plan
  referent, and politeness words (*please, thanks, ok, go ahead*). Any other
  word, a `?`, a quote, a second line asking for a change, a negation or a
  condition means the message is not consent. Generic assent on its own ("ok",
  "go ahead") never approves.
- **Which plan.** With more than one plan waiting, or more than one on screen,
  the message must name the handle.
- **Which revision.** Every write to the ledger recomputes a digest of what an
  approval would cover. That covers each waiting task's title, spec, card,
  owner, worker, destination, planned workspace and dependencies, plus the
  run's worker defaults and mode (`refresh_plan_revisions`, run inside
  `mutate`). Any change moves `planApproval.revision`. An approval is refused
  unless the revision you saw, the revision the lead names and the ledger's
  current revision are the same. The button sends its revision too.
- **Once.** A message that approved a revision cannot approve again
  (`planApproval.consentTurns`).

The approval is recorded on `planApproval.consent` as `{via, revision, at,
turnId, words}`. Plan approval covers only the plan. It never answers a gate,
a permission card, a deploy or a restart.

To change a waiting plan, the lead uses `orchestration_task_revise`. It can
edit a task, re-route it through the same routing as task create, or withdraw
it. This only works while the plan waits and the task is unapproved. Each
revision is a new revision you see before approving.

Each task in the review, and in the Run panel's task details, opens to the
**standard plan card** (`components/TaskPlanCard`, `lib/taskPlanCard.ts`).
It shows the project, work directory, branch and base, worktree status, owner,
model and effort as short facts. Then comes one line of **problem**, one line
of **goal**, and 2–5 **acceptance** criteria. The lead supplies those three
when it creates the task (`problem`, `goal`, `acceptance` on
`orchestration_task_create`). They are checked by `TaskCard::checked` and fixed
once created, like the destination. A work directory and branch the host has
not allocated yet read **Pending**. The workspace plan reads **Planned**, and
the attempt the host prepared reads **Confirmed**. A removed worktree reads
**Removed**. The lead's full brief stays one disclosure further in.

Approval is for exactly the plan you saw:

- The browser sends the ids of the tasks it showed as awaiting approval; if the
  lead added a task in the meantime the host refuses ("The plan changed while
  you were reviewing it").
- Approving stamps each task `approvedAt`. An approved task's destination
  cannot be changed — re-routing means a new task. Before approval the lead
  may revise it (`orchestration_task_revise`), which moves the revision.
- A task nobody is working on can change hands: `orchestration_task_reassign`
  gives it to another of the lead's direct reports, for example a designated
  backup taking over from the primary. The new owner is routed like a new
  task, so the org chart holds. The task keeps its card, destination and any
  workspace a settled attempt left, and records the handoff on
  `task.handoffs`. A new owner is not what you approved, so the task waits for
  you again and nobody, including the old owner, starts it meanwhile. A task
  with a running attempt is refused; stop that attempt first.
- The Approve button sends the revision and tasks it showed, the card it was
  clicked on (`surface`) and how long that revision had been on it
  (`shownMs`). A revision that replaced another less than 1.5 s before the
  click is refused, and the card holds its button that long after a change.
  Once approved, the plan leaves the chat; its record stays in the run panel.
- A task the lead adds **after** approval puts the whole run back to waiting
  for you; it is marked **New** in the review, and no worker starts (retries
  included) until you approve again. Running workers carry on.

Only the top plan needs you. Managers split their tasks further without asking.

## Memory

Each registered agent has its own working memory: one note in the Memory Vault
at `agent-zone/agents/<name>/memory.md`, the roster folder the vault's schema
reserves. The note path is fixed the first time it is assigned and stored on the
agent (`memoryNote`), so renaming an agent keeps its memory. Saving an agent
creates the note when a writable vault is connected; otherwise the first write
creates it.

Agents reach it through two tools, `vault_agent_memory_read` and
`vault_agent_memory_append`. The host works out **which agent is calling from
the chat itself**: the lead a task was handed to (`team.json` `leads`), or the
assignee of the task a worker chat runs. Tool arguments never name the caller.
An agent may:

- read its own memory, and its **direct reports'** (managers see what their
  people know);
- append only to its own memory, one dated entry at a time, never overwriting.

An entry with no date is dated with the server machine's **local** date, and
the vault receipt keeps the date used (`entryDate`), so a retry with the same
requestId is recognised however much later it comes. The host, not the agent,
then draws a line in the chat (`memory_activity.rs`): *saved* only on a saved
receipt, *unconfirmed* while the receipt needs review, *not updated* when
nothing was written, and *refused* when the requestId already belongs to an
earlier, different entry — shown beside that entry's own state, which is
usually saved. A worker's coordinator gets a line that it happened, while it is
still that worker's coordinator. Lines a crash left unwritten, or a transcript
lost, are written back at the next start.

Every lead and worker brief tells the agent to load its memory first, and to
record only what its future self needs: decisions and why, gotchas, how things
work, and what to pick up next. Routine steps don't go there. The generic
`vault_*` tools are still available to agents, so this read rule is a
convention for the agent-memory tools, not a lock on the vault.

## Dashboard

**Agents** in the top bar shows the org chart for the current project. Each row
shows how many tasks the agent has active, stuck (failed or blocked), done and
led. Expanding a row lists the chats it leads and the tasks it was given, and
each one opens its conversation.

## Levels, XP and token usage

Each registered agent has a level, earned from work someone **accepted**
(`orchestration/levels.rs`). The host computes every number; the browser only
words them.

- **Size.** Every task has a size: small (25 XP), medium (75 XP, the default)
  or large (150 XP). The lead gives it on `orchestration_task_create` or
  `orchestration_task_revise`, and the person can change it on the plan card
  (`orchestration_task_size`, browser only). It is part of the plan digest, so
  an approval covers it. Resizing a task the person already approved puts it,
  and the plan, back in front of them before any worker starts. Once the task
  has any attempt, the size is locked. A
  task that started before sizes existed has none and earns nothing.
- **Acceptance.** A worker reporting completed is not acceptance. The person
  accepts a completed task on its plan card or on the agent's profile
  (`orchestration_task_accept`, browser only). A lead accepts through the agent
  tool `orchestration_task_accept` (hook action `task_accept` →
  `orchestration_task_accept_in_chat`). The host allows that only from the
  run's coordinator chat (whose lead comes from `team.json`), or, for a
  subtask, from a worker chat of the parent task, where the manager is the
  parent's assignee. Nobody accepts their own work. Every accept names the
  completed attempt it reviewed; a newer result refuses it.
- **Who is calling.** Two callers, two credentials. The person holds the
  server token, which opens the browser's routes (`/ws`, `/file`, `/auth`):
  the socket acts as the person, so the person's own decisions (accepting a
  result, approving a plan, sizing a task) are socket commands. An agent is
  one launch of one chat: each launch gets a fresh secret,
  `OCTIQ_CHAT_CAPABILITY`, and the MCP sends it as the
  `x-octiq-chat-capability` header on every hook call, to `127.0.0.1` on the
  port the host passes as `OCTIQ_HOOK_PORT`. That capability is the only
  thing every `/hook/*` route takes: the server token is neither needed nor
  enough there, and an agent is never given it (the MCP does not read
  `web.json`, and a server started with `OCTIQ_WEB_TOKEN` does not pass it to
  agents). A hook refuses a call with no current capability (401) and one
  whose body names another chat, session or launch (403), and acts for the
  chat, session and launch the capability belongs to. The capability dies
  with its process and is replaced on relaunch, and it opens none of the
  person's routes. The socket in turn refuses the lead-only commands
  (`orchestration_task_accept_in_chat`, `orchestration_plan_approve_in_chat`),
  so a lead's acceptance on record always came from that lead's chat.
  Nor does a request from this machine on its own: `GET /token` hands the
  token only to a Cloudflare Access sign-in (it used to answer any request
  whose `Host` said loopback, which any local process can send). A new
  browser opens the `?token=…` link the server prints at startup or pastes
  the token on the Connect page; `local_token` in an old `web.json` is
  ignored.
  Limits: this separates what OctiqFlow hands out; it is not an OS boundary.
  Agents run as the person's own OS user, so a process that goes looking can
  read `web.json`, the server's startup log, or another process's
  environment. Only OS-level isolation (another user, a sandbox with no read
  access to the profile) closes that.
- **Ledgers.** Two, in `orchestrations.json`, both written in the same write
  as the acceptance. `acceptances` records every acceptance as it was made:
  task, accepted attempt, the agent it ran as, who accepted and when, the size,
  and what it paid (0 with the reason when nothing). It is appended once per
  accepted attempt and never edited. `xp_awards` records what was paid, keyed
  by task id. One task pays once: a repeated or racing accept, a retry, or a
  reopen never pays again. A reopened task's new result must be accepted
  again; that adds a line to `acceptances` with 0 XP, and the award stays.
  "Accepted tasks" counts distinct task ids in the agent's acceptances, paid
  or not, for good, and the XP history lists every acceptance. A store
  written before `acceptances` existed has it rebuilt on load from its awards
  and each task's current acceptance. XP goes to the agent the accepted attempt ran as, recorded on the
  attempt when it started. A manager is never paid for its reports' subtasks. Awards copy the
  agent id, name, title and size, so renames, model changes and deleted runs
  change nothing. `scoring_since` records when scoring began. Nothing earlier
  is backfilled.
- **Levels.** Level 1 starts at 0 XP. Going from level L to L+1 costs 100 × L,
  so level L starts at 50 × L × (L − 1): 0, 100, 300, 600…
- **Token usage** (`agent_usage.rs`, `<chats dir>/agent-usage.json`) is shown
  for information only and never affects XP. Every chat's usage goes to the
  agent it ran as when its first usage arrived: a worker attempt's assignee, or
  the lead a chat was handed to. That attribution is stored and never
  recomputed. Each worker attempt has its own chat, so a manager's total never
  includes its reports' work. Ordinary chats are not counted. Claude's
  `modelUsage` is cumulative per process and includes subagents, so the reader
  keeps a per-process meter and records each turn's difference. Interrupted
  and failed turns are counted once, when the provider reports them. A turn
  killed before its report is not counted, so every total is a floor. Claude's
  figures include the helper subagents it runs inside its own chat, which the
  provider does not report apart; a registered report always has its own
  chat. Codex app-server usage is each response's
  `last` block. A notification whose thread total matches the last one
  recorded is a repeat. Cached input is part of input, and reasoning is part of
  output; they are shown as subsets and never added. Counting starts with this
  build, and earlier chats are not read back.

The Agents page shows a level chip on each row. The chip opens the agent's
profile: level and progress, accepted tasks, tokens used, what waits for
acceptance, the XP history (20 per page, each row opening its run), and the
rules.

## Relation to orchestration

Passing on and splitting use the existing [orchestration](orchestration.md)
machinery unchanged: runs, tasks, attempts, worktrees, retries, gates and the
durable inbox. When an agent creates a run through the MCP hook, the host
returns the master brief in the response (`masterBrief`), because nothing else
delivers it. Tasks record `assignee { id, name }`, which the task board and the
Run view show.
