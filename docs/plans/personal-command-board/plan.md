# Personal Command Board — implementation plan

Status: planned. Date: 2026-09-16. Product: OctiqOS.
This document is the execution baseline, not a report of implemented features.

## Scope

Build projects, tasks, title-only Inbox, deliberate promotion, owner and human
attention, global Command, bounded Today, WIP, decisions and Decision Log,
delegated results and review, secondary Kanban, Someday, activity and basic search.
The default experience must answer "What actually needs me right now?"

Keep Office, existing managed execution and task conversations reachable.
New command-board tasks are tracked work by default; assigning an agent name
does not start a process. Do not require workers, a provider account or a local
workspace to manage personal work.

Do not add a planner, decomposition, spawning, routing, new execution adapters,
dependency graphs, Gantt, time tracking, analytics, chat, plugin marketplace,
workflow designer or DSL. Do not expand existing orchestration. Compatibility
changes to stop current execution bypassing new lifecycle rules are in scope.
Weekly Review and proactive notifications are deferred, as confirmed by the user.
There is no new cron, recurring task or external integration in this batch.

## Architecture and code entry points

Keep one Task identity and one Project identity in the existing world aggregate.
Do not create a parallel command-task database or synchronize duplicate cards.

| Concern | Existing entry point | Planned change |
| --- | --- | --- |
| World persistence and transactions | `src-tauri/src/world/mod.rs` | Versioned payload upgrade; atomic policies and durable events |
| Models and mutations | `src-tauri/src/world/model.rs` | Typed lifecycle, owner, attention, projects, result/review/decision records |
| Existing execution | `src-tauri/src/world/runtime.rs` | Separate execution state; eligibility and lifecycle compatibility |
| Shared dispatch | `src-tauri/src/dispatch.rs` | Preserve authenticated `world_*` command transport |
| Browser boundary | `src-tauri/src/web.rs` | Preserve authenticated WebSocket dispatch; new actions still require domain and worker-scope validation |
| World UI | `web/src/os/world/WorldPortal.tsx`, `types.ts`, `Forms.tsx` | Command navigation, tracked capture and consistent DTOs |
| Existing task UI | `AgentTasks.tsx`, `TaskWorkspace.tsx`, `Inspectors.tsx` | Preserve existing entry points, shared details and evidence |
| Attention/mobile | `web/src/os/world/MobileViews.tsx` | Shared attention projection and narrow-screen navigation |
| Design | `docs/design-system.md`, `web/src/design-system.css` | Reuse tokens/components, light/dark appearance |
| Tests | `src-tauri/src/world/tests.rs`, adjacent `*.test.tsx`, `scripts/test-agent-tasks.mjs` | Extend existing native harnesses |

The existing PostgreSQL singleton row lock can serialize WIP admission and review
transitions. Keep validation, update, event append and mutation receipt in one
transaction. Check limits inside that lock, never from an earlier UI snapshot.
Use expected task/result version for stale-edit protection in addition to
`requestId` replay protection. A rejected or stale command has no side effects.

A payload version upgrade is needed; a relational schema rewrite is not required.
Only add an ordered SQL migration if the implementation actually introduces a
SQL-level object. Do not invent a migration just to add a JSON field.

Prefer small Rust modules beneath `world/` for lifecycle, capacity, decisions,
reviews and queries, with domain functions independent of transport. Use existing
bridge commands; the example REST endpoints in the request are capabilities,
not a requirement to add a second HTTP transport. Preserve future adapter seams:
capture, clarify, activate, block, record_result, approve, request_changes,
resolve_decision. Agents cannot self-grant human approval via an adapter.

## State and ownership

Task lifecycle is the requested enum:
`inbox | ready | active | blocked | waiting | review | done | someday | cancelled`.

Execution is a separate optional record: mode `tracked | managed`, current
execution state, existing routing/steps, run references and a work-cycle identity.
Only explicit existing managed-dispatch actions can make a task runnable.
Task status and run status are distinct facts; do not maintain two editable
versions of the task's business status.

The minimal task retains the requested fields, and adds:
- Nullable project association for unfiled Inbox/Someday; derive org from project
  when assigned. Unfiled items belong to the authenticated founder's world.
- `reviewRequired`, current output version and review records.
- `requiredAction`, `waitingFor`, optional decision reference.
- Versioned outputs (summary, text/link evidence, submitted-at, owner).
- Someday interest and future-trigger text.
- Updated/completed timestamps and append-only activity events.
- Today selection in a separate date-scoped record, never a task state.
- Decision entities and immutable resolved decision entries.

Every task has an owner: `me | human | agent`, name, optional stable reference.
A named human or external agent can be tracked without creating an account or
registering an executable worker. Registered-agent references must pass existing
project authorization; plain display names grant no execution permissions.
Priority remains independent from status and attention.

Human attention means what is required now:
- `decision`: an unresolved founder decision.
- `review`: an output is submitted and awaits founder review.
- `execution`: personal work has been identified for the founder.
- `none`: no current action from the founder.

A delegated task awaiting eventual review is `none` while executing, with
`reviewRequired = true`. Submission changes it to `review`.
For new tracked work, default reviewRequired to false for owner me and true for
delegated human/agent work. A deliberate no-review policy is allowed for tracked
work before it starts; legacy managed work keeps mandatory review. Changing an
owner must present the resulting review policy. Once a result is awaiting review,
turning off reviewRequired cannot be used to accept it or remove it from the queue.
A founder-owned ordinary task cannot stay Active with `none` to evade WIP.
A decision-only task uses the decision queue; it is not personal execution.

## Project rules and capacity

Limits are global across this authenticated founder's OctiqOS world, including
all organizations visible to that founder. Changing an org/project filter never
changes the count. Do not expose founder aggregates to worker context.

New projects default to Parked; creation does not activate them. Project records
also include goal, current milestone and owner; a filesystem folder is optional.

| Project state | Allowed behavior |
| --- | --- |
| Active | Personal execution and delegated work |
| Background | Defined delegated work; decisions/reviews may queue without activating the project |
| Parked | Capture/read and resolution of already-pending decisions/reviews; no new/resumed execution |
| Completed | Read/archive; explicit reopen required before new work |

Defaults: max Active projects 2; max personal Active execution 3; review threshold 5.
All settings are persisted and validated by the backend. Default project is
optional; stale/unavailable defaults fall back to unfiled capture.

Personal WIP counts tasks with `status = active` and
`humanAttention = execution`, regardless of which owner label they carry.
Owned-by-me ordinary active work must carry execution attention. Decisions,
reviews, waiting and blocked tasks are separate queues. Resuming personal work
must reacquire a slot. Delegated active work with no personal execution does not
use a slot; existing runtime resource concurrency remains separate.

Personal execution requires an Active project. When moving a project to
Background, show its personal active tasks and require the user to explicitly
select their disposition; moving them to Ready can be confirmed as one atomic
operation. Never hide still-active personal work by filtering out the project.
A swap explicitly identifies the displaced project/task and activates the new
one atomically; concurrent swaps cannot overfill a limit.

Parking presents the affected in-flight work, and confirmation fences its
generations, stops claiming new work and requests interruption through existing
controls. Show Stopping until processes settle; completed file writes are not
rolled back. Capture, decisions and historical results remain available.
Unparking does not resume paused work automatically. Completing a project requires
its nonterminal work to be resolved, cancelled or moved deliberately.

Lowering a hard WIP limit below current commitments requires the same explicit
disposition first. Raising a limit is an explicit settings change with activity;
there is no hidden force flag or automatic priority-based displacement.

## Lifecycle contract

- Capture -> Inbox, title only, owner me, attention none, no run or activation.
- Clarify Inbox/Someday -> Ready: project, owner, intended attention, sufficient
  outcome/acceptance description, and review policy are known.
- Activate Ready -> Active: validate project state, personal capacity and review
  backpressure atomically. This still does not dispatch a tracked task.
- Block: reason, required action and waiting-for party are required. If founder
  judgment is needed, create/link a decision and set attention decision.
- Waiting: a clear handoff/waiting-for value; no current personal execution.
- Resume Blocked/Waiting -> Active: explicit action and all current gates.
- Pause Active -> Ready: explicit action; managed work is fenced/stopped.
- Submit result -> Review when reviewRequired; otherwise Done. Legacy managed
  work retains its existing mandatory founder verification safety floor.
- Approve current result -> Done, preserving output separately from approval note.
- Request changes -> Active only if gates pass, otherwise Ready with rework
  recorded and the capacity reason visible. Owner and prior evidence are retained.
- Reject review -> Cancelled with reason; comment alone changes no state.
- Cancel -> Cancelled, preserving history and fencing managed work.
- Reopen Done/Cancelled -> Ready after re-clarification, new work cycle and
  invalidated current approval; never reuse old approval for a new result.
- Someday promotion -> Ready via clarification, never directly Active.
- Generic metadata edits cannot mutate lifecycle, approval, run mode or capacity
  fields without the same domain validation.

## Decisions and review

A decision is first-class: question, context, options/pros/cons, recommendation,
selected option or explicit free-text choice, rationale, owner, project,
related task, resolved date and optional future review date.
Resolving creates an immutable searchable entry. Changing a past decision creates
a superseding entry; the original rationale remains readable. No meeting-text
mining, docspace synchronization or LLM summarizer is required.

Resolving a pure decision task can complete it. Resolving a blocker on execution
clears that blocker and returns work to Ready; it neither marks execution Done
nor starts/resumes an agent. An explicit subsequent activation must pass gates.
Existing managed founder-direction controls remain intentional actions with
existing permission boundaries. Do not interpret saved decisions as tool grants.

Reviews refer to a specific output version. Approval is human-authored and cannot
be reused after replacement output or reopen. Store comments and change requests
as separate durable records. Batch review is a focused sequence of items with
Approve, Request changes, Reject and Comment; preserve filters and position.
Do not approve unseen items or bypass stale-version checks for batch operations.

At pending reviews >= threshold, block new review-producing work cycles, including
rework and explicit managed dispatch. Existing admitted cycles can finish all
steps and submit output. Never drop, delay saving or conceal a completed result
to make the count look compliant. Show overflow and the reason new work is held.
At count < threshold, activation is available again; nothing auto-starts.
Changing review threshold can leave existing reviews over threshold without
deleting them. Review pressure and reminders are different; proactive reminders
are out of scope for this batch.

## Command, Today and other views

Command becomes the default /os view when the complete MVP passes acceptance.
Before that, expose the new views deliberately for local testing; preserve Office.

Queue precedence: Decisions, Reviews, My Active Work, other Blocked/Needs Attention,
Running Agents. Use disjoint primary attention placement, e.g. a blocked decision
appears in Decisions and is not repeated as another urgent card below.
`none` work can appear in the quiet running/blocked monitor, never the personal
attention queues. Background project questions remain visible without activating
the project. Parked execution is quiet, but existing unresolved decisions/results
remain discoverable; show any retained pending review rather than losing it.

Each main queue initially shows a small bounded list (default 5; My Work <= its
limit), a truthful total and Show all. Use a stable order with oldest pending first
and explicit critical attention elevated; priority cannot activate or notify.
Running work is collapsed by default. Show overdue/long-waiting badges quietly.
No push/toast interruption for an agent completion or routine decision arrival.

Today is a separate persisted selection for a local calendar date: 3 primary,
2 minor. Selecting does not activate a task or project. Ready/blocked/review
items can be selected and retain their status; Start remains guarded.
Store date/timezone deterministically, keep prior days readable, and do not
automatically roll unfinished selections into a new day's capacity.

Secondary Kanban: Inbox, Ready, Active, Blocked, Waiting, Review, Done.
Someday and Cancelled are separate filters/views. Drag-and-drop and keyboard/touch
alternatives issue the same domain actions, with required-field dialogs and
rollback on rejected/stale transitions. No local-only drag success.

Project detail shows status, goal, milestone, owner and active/blocked/review,
recent Done and Someday sections. Search tasks, projects, decisions and user
notes; filter project/status/owner/attention/priority/tag/due date as applicable.
Basic PostgreSQL/world queries suffice at MVP scale; no external search service.

Activity is recorded from the first mutation-bearing card, not bolted on at the
end. Preserve actor/time/action, relevant changes, decision/review references
and request identity. Do not synthesize old timestamps or expose secret runtime
payloads. Notes and imported result text are untrusted display content.

## Compatibility and migration

Card 01 introduces a versioned, atomic world-payload upgrader. Preserve IDs,
messages, evidence, runs, generations, receipts, workspaces, agent scopes and XP.
Do not import or mutate the older `/os?view=legacy` mission-control store.
The MVP's global view covers projects in the current org-world store; it does not
silently merge old mission cards or OctiqFlow chat/workspace lists.

| Old task state | Canonical task lifecycle | Execution/attention |
| --- | --- | --- |
| queued/planning/working | active | Preserve already-authorized managed cycle; attention none |
| needs_input | blocked | Preserve actual question/context; decision attention |
| paused | ready | Managed execution remains paused; no automatic resume |
| verifying | review | Review required; preserve original evidence |
| done | done | Preserve accepted outcome and original evidence |
| cancelled | cancelled | Preserve terminal history |

Existing projects default to Background during upgrade because their previous
model did not record a personal focus commitment; do not invent Active projects.
Do not cancel or dispatch work merely to perform migration. Existing authorized
managed cycles retain their authorization and review requirement. If an old
task has no assigned worker yet, retain the pending agent assignment rather than
assigning it to the founder. Known current questions can be linked into the
decision model without inventing options, recommendations or historical rationale.

Unknown persisted states fail with an actionable compatibility error and preserve
the original payload. Preflight on synthetic/restored test data before any rollout.
Retain a recoverable pre-upgrade payload in the isolated migration validation.
Do not downgrade a migrated payload into an older binary without a tested restore
procedure. Rollout/backups for real data require a later explicit release task.

## Card order and integration milestones

1. Compatibility and lifecycle separation.
2. Safe Inbox and tracked ownership.
3. Project commitments and settings.
4. Task lifecycle, blockers and personal WIP.
5. Global Command dashboard.
6. Bounded Today.
7. Decisions and durable Decision Log.
8. Delegated results, batch review and backpressure.
9. Guarded Kanban.
10. Someday / Lab.
11. Search, filters and activity timeline.
12. Integrated acceptance and readiness evidence.

After 01–06, manually use capture, focus limits, Command and Today while the
remaining review/decision capabilities are completed. This is not full MVP
readiness. Only after 12 does the new Command experience become the default.
Card 12 is testing/qualification with the final default-entry switch; it does
not run a release or restart the installed service.

No effort estimate is treated as a deadline. Card 01 and 08 carry the highest
integration risk because old runtime writers must obey the same lifecycle.

## Tests and execution gates

No Gherkin runner exists in this repo. Planned L2 contracts go under
`specs/l2/backend/` and `specs/l2/frontend/` in this work folder. Each scenario
must be mapped to an actual native test; a .feature file alone is not test proof.
Do not install Reqnroll/cucumber merely to match the slicing template.

Each card: contract and failing regression where meaningful -> implementation
-> targeted native tests -> scoped code review -> scoped security review when
sensitive -> project verification and recorded results. Use one main agent;
no parallel agent/review dispatch is authorized by this plan.

Applicable existing commands:
- `cargo test --manifest-path src-tauri/Cargo.toml --lib`
- `pnpm --dir web test`
- `pnpm --dir web exec tsc -b`
- Build via the existing web build script with `--outDir` pointing at a unique
  temporary directory, to avoid replacing the web bundle served by the live app.
- `node scripts/test-agent-tasks.mjs` for managed-task UI compatibility, after
  updating fixtures when the domain model changes.
- New `node scripts/test-command-board.mjs` for browser flow against an in-memory
  bridge using the existing browser harness pattern.
- Isolated real-PostgreSQL transaction/restart coverage in
  `src-tauri/src/world/command_store_tests.rs`, introduced with card 03 and
  extended by 04/08/12, with an explicit test-only DSN, disposable database
  and opt-in command documented when implemented.

Unit models/mocked browser responses do not prove concurrent transaction safety.
The real DB race tests are required for WIP/review readiness. Never point tests
at the installed preview/production database, ports 1421/1422 or live providers.
Missing external prerequisites are recorded as blockers, not passes.

Respect monorepo sequencing: no BE deployment or API regeneration between layers.
Keep each card's changes uncommitted unless separately requested. Do not run
Pandahrms-specific .NET tooling or access its services/spec repositories.

## Deferred scope

- Weekly Review and optional reconsideration/reminder scheduling.
- Proactive notification delivery, channels and preferences.
- New agent execution/orchestration and external task/result ingestion adapters.
- Cross-store import/export, docspace synchronization and team membership/auth.
- Optional capture syntax and advanced dependencies/search.

Keep these visible here; they are not hidden promises inside MVP cards.
