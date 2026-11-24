# Lead threads

Moved verbatim from AGENTS.md on 2026-11-24.

### A lead's thread

The sidebar paints cached conversations before scheduling or index replies; only project identity waits for workspaces. Navigation orientation and the last host lead identities are remembered through `lib/remember` for refresh continuity, then reconciled with the host; cached orientation never supplies live scheduling lanes or start authority.
A cached lead identity is display-only until the host confirms its identity and orientation on this connection; a pending reply survives same-value refreshes and is dropped with a visible reason only if the latest confirmed roster no longer lists the lead, orientation changes, or the connection/feed resets or is disabled. Overlapping roster reads apply by start order: a success is never dropped because a later read is still in flight, and a failed read neither restores nor keeps a value older than the newest success.

In Settings → Orientation → Agents, the person talks to leads: registered
agents with no `reportsTo`, excluding the front desk. Each has one ongoing,
lazily created `chat:lead-<agentId>` thread. `leadOf` on its index row is
host-owned, save-first, and survives browser saves. The `lead-` prefix is
reserved; neither clients nor hooks can create or adopt it.

`lead_threads`, `lead_thread_open { agentId }` and `lead_history { agentId }`
are socket-only, with no MCP tool or hook route. List follows roster order;
history lists the lead's other active chats newest first, excluding worker
chats. Open uses the lead's scoped registered project, or the team home for
an all-projects lead (the usual General fallback). Its cwd is that project's
primary Git checkout, even when the registered path is a linked worktree;
non-Git home folders run in place. Its initial settings are the registration.

The thread never prepares a branch or worktree and is excluded from chat
worktree lifespan ownership and recovery. Missing home folders refuse start
in words; the host neither rebuilds nor moves them. Complete and Trash are
refused; `/clear` remains available. The idle reaper still ends the process,
and the next message resumes the provider session. Routes and handovers to
a lead in Agents orientation reuse this thread, including a running thread;
Tasks orientation keeps the existing new-chat behaviour. A run created from
the thread makes it the coordinator and sends notifications back normally.

Its registered Access is preserved. This host rule is appended to every
provider launch/resume: “You are in the project's main checkout: do not edit
source here; dispatch code changes to a worker.” This is conduct, not a
permission restriction. No proactive outreach is added. MCP server
instructions are unchanged and remain under 4,096 characters.

Claude and Codex keep native automatic compaction: OctiqFlow sets no
compaction-disable flag or host session rotation. A Claude launch does get a
compaction window (400,000 for a chat or lead thread; see
`idle-chats-and-worker-tools.md`, Token budget). Native settings/environment
can affect it. If compaction cannot free enough room,
the provider errors; the thread id and transcript remain, and the host does
not silently replace the conversation. See [agents mode](../agents-mode.md#long-context)
for the launch flags and provider references.
