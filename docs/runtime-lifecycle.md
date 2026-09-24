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
present in router diagnostics, so `blockedAction` remains null rather than
inventing them. An absent or closed card is not evidence of approval. A pending
safety card prevents its worker from settling, preserving a continuation into
the same attempt. The rejected tool call itself has already ended. Settled or
superseded attempts require an explicit retry, which does not grant permission.
Host restart expires earlier cards. Historical rejections that produced no host
card cannot be reconstructed from worker prose.

Claude's native `task_started`, `task_updated`, and `task_notification` events
are tracked separately from its parent turn. A parent with outstanding native
background work is excluded from idle reaping. Explicit process termination,
model switching, exit or host restart records an interruption notice and keeps
the task and session IDs for the next launch. The new session is told to inspect
retained output and workspace changes before retrying. This does not promise
that a provider can resume a terminated native agent. Work not reported through
these native lifecycle events cannot be tracked by this mechanism.
