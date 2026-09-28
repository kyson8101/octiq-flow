# Runtime evidence after task completion

Task completion records finished work. It does not prove that a development
server is still running, that a background agent survived, or that a safety
decision remains actionable.

Workers starting a service needed by later tasks should call
`orchestration_service_register` before settling, with their attempt ID, a
service name, loopback IP, port and precise recovery guidance. Coordinators
can register an existing current attempt's service too. Re-registering the
same task/name replaces the previous record. No process is launched by this
tool, and recovery guidance is never executed automatically.

The host checks registered TCP listeners every ten seconds. Snapshots expose
`services` separately from completed tasks, with `state` (`unverified`,
`listening`, or `stopped`) and `checkedAt`. Reachability does not prove HTTP
health or the identity/version of the process listening on that port. Verify
application health before browser work. Restart invalidates earlier evidence;
listener changes notify the coordinator. Services from before registration
remain unverified regardless of what a worker previously wrote.

Snapshots also expose `nativeDecisions`, including the observed host card ID,
owning task/attempt/chat, provider reason, current card status, and continuation
viability. Raw diagnostic dumps are excluded. Exact tool arguments are not
present in Codex router diagnostics, so `blockedAction` remains null rather than
inventing them. An absent or closed card is not evidence of approval. A pending
Codex safety card prevents its worker from settling, preserving a continuation
into the same attempt. The rejected tool call itself has already ended.

A Claude auto-mode refusal is recorded too, with the exact call in
`blockedAction`, but nothing can approve it: Claude refuses without asking
OctiqFlow (its `can_use_tool` callback carries only "ask" outcomes), and an
allow rule on a later launch would cover every call of the line, not one. Its
continuation is `unavailable`; the worker carries on another way or settles
blocked, naming the command. An `allowed_exact` status from an earlier build is
history and authorizes nothing, and that build's queued "exact-grant" notices
are cancelled rather than delivered. Settled or
superseded attempts require an explicit retry, which does not grant permission.
Host restart expires earlier cards. Historical rejections that produced no host
card cannot be reconstructed from worker prose.

A Claude refusal whose `decision_reason` is exactly `Classifier unavailable`
(`safety_block::refusal_kind`, the only place that reads it) is an outage of the
check, not a judgment of the command, and is recorded with `kind: "outage"`.
Every other refusal, including one with a missing or empty reason, is
`kind: "safety"`, as is every decision stored before the field existed.
Outage refusals of one attempt in one chat share one card, and their decisions
share its id as `groupId`; each refused call keeps its own decision. A retry
that reuses the chat starts its own group. A group closes 2
minutes after its latest refusal, 5 minutes after its first, or at its 5th
refusal, whichever comes first (`outage_group_due`), and a later refusal starts
a new group. The coordinator gets one `native-outage:<groupId>` notice per
group, due when the group closes. It is cancelled at delivery, never sent, when
the attempt of the group's latest refusal has settled, or a tool call it was
allowed to run, STARTED after that refusal, has come back
(`Execution.lastAllowedToolStartedAt`: a call already running when the refusal
came, a refused call's own result, a result whose call was never seen starting,
and OctiqFlow's `mcp__octiq__*` tools do not count). The outage recovery
text is one string (`outage_guidance`) shown on the card, stored as the
decision's `recovery`, and appended to the worker prompt. It allows the worker
one as-is retry of an outage-refused command, which Claude checks again, and no
third try; the person decided that on 2026-09-28. OctiqFlow itself never re-runs
a refused call, and safety refusals keep the strict no-retry text.

Claude's native `task_started`, `task_updated`, and `task_notification` events
are tracked separately from its parent turn. A parent with outstanding native
background work is excluded from idle reaping. Explicit process termination,
model switching, exit or host restart records an interruption notice and keeps
the task and session IDs for the next launch. The new session is told to inspect
retained output and workspace changes before retrying. This does not promise
that a provider can resume a terminated native agent. Work not reported through
these native lifecycle events cannot be tracked by this mechanism.
