---
title: "01 Preserve existing work and separate task lifecycle from execution"
order: 1
created: 2026-09-16
status: active
execution_status: not-started
project: octiqos
layers: both
category: data-migration
sensitivity: sensitive
depends_on: []
---

# 01 — Preserve existing work and separate task lifecycle from execution

## Capability

Upgrade existing work into one shared task model with separate business and execution state, keeping Office functional and ensuring tracked tasks are never claimable by the runtime.

## Prerequisites and execution contract

First executable card; no predecessor.
Read [overview](../_overview.md) and [plan](../plan.md) before implementation.
Inspect current git status and preserve unrelated changes. This is a monorepo:
no BE deployment, API regeneration, per-card commit, release or live restart.
Append a Closed block and move to done only after required checks pass.

## Scope

- Introduce a versioned world-payload upgrader and explicit task/project/owner/attention types using the compatibility table in plan.md. Preserve original IDs and all run/evidence/receipt/generation data.
- Separate runtime queued/planning/working/needs_input/paused/verifying state from the canonical task lifecycle. Update every existing runtime writer and every Office status consumer together.
- Add a non-runnable tracked mode and preserve already-authorized managed cycles. Existing projects become Background without cancelling work; old unassigned agent work must not become personal execution.
- Create the durable activity event primitive and idempotent mutation helper for later cards; do not fabricate historical events or new original timestamps.
- Retain legacy managed verification and XP exactly-once behavior. Preserve the separate mission-control portal/store untouched.

## Code entry points

Existing unless explicitly marked new; inspect before editing. Native test paths
below are planned new files and must be registered in the existing harness.

- `src-tauri/src/world/model.rs`
- `src-tauri/src/world/mod.rs`
- `src-tauri/src/world/runtime.rs`
- `web/src/os/world/types.ts`
- `web/src/os/world/AgentTasks.tsx`
- `web/src/os/world/TaskWorkspace.tsx`
- `web/src/os/world/MobileViews.tsx`
- `web/src/os/world/Inspectors.tsx`

## L1 covered

- `PCB-001` — Existing work remains the same work after upgrade
- `PCB-002` — Opening an upgraded board again changes nothing
- `PCB-003` — Tracked assignment does not authorize agent execution

## L2 spec files — decided here, written during execution

- BE: `docs/plans/personal-command-board/specs/l2/backend/01-preserve-work-and-separate-execution.feature`
- FE: `docs/plans/personal-command-board/specs/l2/frontend/01-preserve-work-and-separate-execution.feature`

No .feature runner is installed. These contracts must map to executable tests:
- Rust: `src-tauri/src/world/command_model_tests.rs` (register as a `#[cfg(test)]` module).
- Vitest: `web/src/os/world/commandCompatibility.test.ts`.
- Browser: `scripts/test-agent-tasks.mjs`; reuse existing synthetic/in-memory patterns.

## Sequence

- [ ] BE spec: write the L2 contract and map each scenario to named native Rust tests; add meaningful failing coverage before the behavior change.
- [ ] BE work: implement pure old-payload -> new-payload conversion and atomic persisted version upgrade before reads/writes; unsupported versions/states must retain recoverable original data.
- [ ] BE work: route runtime claim, completion, failure, directions, verification and meeting-conversion through the new lifecycle/execution distinction; preserve scope and generation checks.
- [ ] BE tests: cover each legacy state, empty world, repeated upgrade, unknown state failure, preserved receipts/evidence/XP, stopped generations and tracked tasks never claimed.
- [ ] BE code review: inspect all changed domain/transaction paths and resolve in-scope defects.
- [ ] BE security review (`/security-review`, scoped to this Rust work): Saved-data compatibility, generation fencing, worker project scopes and approval history.
- [ ] FE spec: write the L2 contract and map each scenario to Vitest/browser checks; use behavioral interactions where static markup cannot prove the outcome.
- [ ] FE work: migrate DTOs, Office state labels/actions and fixtures to shared lifecycle/execution helpers without changing the meaning of existing controls.
- [ ] FE tests: run compatibility and existing AgentTasks/MobileViews/TaskWorkspace regressions; open existing conversations, resume explicit managed work and verify an outcome.
- [ ] FE code review: check failed/stale actions, truthful statuses, empty states, accessibility and responsive behavior.
- [ ] FE security review (`/security-review`, scoped): check content rendering, IDs, visible authority and server-side validation expectations.

- [ ] Verification: run this card's targeted checks plus the applicable project-wide Rust/web checks in plan.md; build web into a unique temporary directory. Record exact commands/results; missing required checks remain blockers.
- [ ] Acceptance: demonstrate every criterion below and update progress. Append dated Closed evidence, then move this card into done; do not commit or release.

## Acceptance

- [ ] Each legacy status maps exactly as documented, with no duplicate task, execution, decision or reward on repeated upgrade.
- [ ] An already-authorized managed cycle retains its evidence and permission boundaries; an unapproved result never becomes Done.
- [ ] A tracked agent-owned task is ineligible for runtime claim in every lifecycle state.
- [ ] Existing Office controls and task navigation still refer to the same persisted IDs.

## Sensitivity

Saved-data compatibility, generation fencing, worker project scopes and approval history.

## Out of scope

- New Command screens and manual capture UI (02 onward).
- Importing the mission-control prototype or starting any new agent integration.

## Execution record

Not started. No implementation, test execution or acceptance result is claimed.

