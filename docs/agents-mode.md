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
- The top bar gets an **Agents** button that opens the dashboard.

The switch is stored per browser (`octiq.agentsMode`). Registered agents are
stored on the server, so every browser sees the same team.

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
which chats were handed a task and to whom (`leads`). Commands: `team_list`,
`team_save`, `team_delete`, `team_brief`, `team_leads`.

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
resolves `assignee` through `team::resolve` against the right manager: the lead
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
the plan as a short list, and ends its turn. A **Plan ready for your approval**
card above the composer lists each task and who it goes to. **Approve plan**
calls the browser-only `orchestration_plan_approve`, which is deliberately left
out of the agent hook so no agent can approve its own plan. To change the plan,
reply in the chat. The button stays disabled while the lead is still in its
turn.

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
