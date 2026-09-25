# Agents mode

Agents mode is a switch in **Settings → Agents**. When it is off, chats work
exactly as before. The idea follows [Paperclip](https://paperclip.ing/): you
manage a team of agents instead of prompting one.

When it is on:

- **New chat** becomes **New task**, in the top bar and the chat list.
- A new task's empty page asks **Hand this task to**, listing the registered
  agents this project can see. Picking one sets the chat's provider, model,
  effort and access to that agent's settings. The last pick is remembered.
- The first message goes to that agent, the **lead**, with a brief after it.
  The brief names the lead, gives its role, and lists its direct reports. The
  chat shows only what you typed, plus a "task for <name>" label. The brief is
  kept in the transcript, so a resumed chat still knows its team.
- The top bar gets **Talk to <name>** (see below) and an **Agents** button
  that opens the dashboard.
- The composer of a conversation with an agent is **compact**: the message
  box, attachments, the agent's avatar and name, and Send. It reads
  "Message <name>…". Role, provider and model are in the chip's tooltip and
  in Settings → Agents, which owns those settings. A new conversation starts on the
  registered settings; an existing one keeps the model it was recorded with,
  so reopening it never moves its history to another model. If the agent was
  removed, the name is struck through and the conversation keeps its last
  settings. Ordinary chats, and every chat when agents mode is off, keep the
  pickers and the location shelf exactly as before.

## Where a new task runs (automatic, with Advanced overrides)

The project, branch, worktree and sandbox controls are hidden on a new task.
They are still decided: `lib/agentExecution.ts` (`autoExecution`) chooses them,
and the send path applies exactly that plan:

- **The head** coordinates from the home workspace (below). No git is
  prepared and no sandbox is started for the conversation. Every task it hands
  out gets its own destination and environment from the host.
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
clears the setting. With none configured, the top-bar button reads **Choose
lead** and opens Settings.

**Talk to <name>** is in the top bar, so it is there whatever project is on
screen. It reopens the newest conversation handed to *that* agent, or starts a
new one. The conversation lives in the General project and is recorded as a
cross-project lead record (`crossProject: true`). A conversation keeps the lead
it was first handed to: when you configure a different head, the button starts
a new conversation with it, and the host refuses to hand an existing
conversation to anyone else (`team::record_lead`), so no history is silently
retargeted.

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
reply in the chat. The button stays disabled while the lead is still in its
turn.

Approval is for exactly the plan you saw:

- The browser sends the ids of the tasks it showed as awaiting approval; if the
  lead added a task in the meantime the host refuses ("The plan changed while
  you were reviewing it").
- Approving stamps each task `approvedAt`. A task's destination and assignee
  cannot be changed after creation — re-routing means a new task.
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
