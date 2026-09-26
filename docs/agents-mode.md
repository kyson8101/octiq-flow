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
- Approving stamps each task `approvedAt`. An approved task's destination and
  assignee cannot be changed — re-routing means a new task. Before approval
  the lead may revise it (`orchestration_task_revise`), which moves the
  revision.
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

## Relation to orchestration

Passing on and splitting use the existing [orchestration](orchestration.md)
machinery unchanged: runs, tasks, attempts, worktrees, retries, gates and the
durable inbox. When an agent creates a run through the MCP hook, the host
returns the master brief in the response (`masterBrief`), because nothing else
delivers it. Tasks record `assignee { id, name }`, which the task board and the
Run view show.
