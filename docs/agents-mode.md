# Agents mode

Agents mode is a switch in **Settings → Agents**. When it is off, chats work
exactly as before. When it is on:

- **New chat** becomes **New task**, in the top bar and the chat list.
- A new task's empty page asks **Hand this task to**, listing the registered
  agents this project can see. Picking one sets the chat's provider, model,
  effort and access to that agent's settings. The last pick is remembered.
- The first message goes to that agent, the **lead**, with a brief after it.
  The brief names the lead, gives its role, and lists the team. The chat shows
  only what you typed, plus a "task for <name>" label. The brief is kept in the
  transcript, so a resumed chat still knows its team.

The switch is stored per browser (`octiq.agentsMode`). Registered agents are
stored on the server, so every browser sees the same team.

## Registered agents

Each agent has a name, a role, a provider (Claude or Codex), an explicit model
(never the CLI default), an effort level and an access level. It is either
**global** (every project) or belongs to **one project**. Two agents that could
appear in the same project cannot share a name.

Fable and Astra agents are marked **lead only**. They can receive a task, but
orchestration rejects them as workers, so they cannot be assigned one.

Stored in `<profile dir>/team.json` (`team.rs`). Commands: `team_list`,
`team_save`, `team_delete`, `team_brief`.

## What the lead does

The brief tells the lead to choose one option and say which:

1. **Do it itself**, directly in its own chat. No run is created.
2. **Pass it on** to a better-suited agent, as a single task.
3. **Split it** into tasks for several agents. The lead may keep a part for
   itself.

To pass on or split, the lead uses the existing
[orchestration](orchestration.md) machinery. It calls
`orchestration_run_create` (Auto workspaces, automatic dispatch). When an agent
creates a run through the MCP hook, the host returns the master brief in the
response (`masterBrief`), because nothing else delivers it. The lead then calls
`orchestration_task_create` with `assignee` set to a registered agent's id (a
name also works). The **host** resolves that agent into the task's worker
settings (provider, model, effort, access), so the lead cannot misquote a
teammate. The task records `assignee { id, name }`, and the task board shows the
name.

Delegation is **one level deep**. Assigned agents run as ordinary orchestration
workers: they report through `orchestration_worker_report` and cannot create
runs of their own. If a worker's task turns out to need splitting, it tells the
lead, and the lead re-splits it.
