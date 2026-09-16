---
title: "04 Promote defined tasks and enforce personal WIP"
order: 4
created: 2026-09-16
status: active
execution_status: not-started
project: octiqos
layers: both
category: implementation
sensitivity: sensitive
depends_on: ["02", "03"]
---

# 04 — Promote defined tasks and enforce personal WIP

## Capability

Move work deliberately through Ready, Active, Blocked and Waiting while enforcing three personal execution slots and recording actionable blockers.

## Prerequisites and execution contract

Complete cards 02, 03.
Read [overview](../_overview.md) and [plan](../plan.md) before implementation.
Inspect current git status and preserve unrelated changes. This is a monorepo:
no BE deployment, API regeneration, per-card commit, release or live restart.
Append a Closed block and move to done only after required checks pass.

## Scope

- Implement the lifecycle transition table in plan.md, clarification fields, humanAttention and reviewRequired; retain existing managed mandatory verification.
- Default new tracked personal work to no review and delegated work to review required; make any deliberate pre-start exception explicit. Pending review cannot be bypassed by changing owner or disabling the review flag.
- Count Active execution attention globally, enforce personal work in Active projects, and validate owner/attention/project edits against the same invariants.
- Add explicit task pause and atomic swap, waiting/block reasons and requiredAction/waitingFor. A judgment blocker stores a precise decision question; 07 supplies its structured resolution UI.
- Implement safe ordinary completion, cancellation and reopen; review-required work cannot be completed without the current result's approval. 08 supplies the full tracked review flow.
- Provide shared guards reusable by old managed controls and new command actions; add the review-pressure predicate here, including existing Review items, so it cannot be bypassed before 08 adds batch UI.

## Code entry points

Existing unless explicitly marked new; inspect before editing. Native test paths
below are planned new files and must be registered in the existing harness.

- `src-tauri/src/world/model.rs`
- `src-tauri/src/world/runtime.rs`
- `src-tauri/src/world/mod.rs`
- `web/src/os/world/Forms.tsx`
- `web/src/os/world/TaskWorkspace.tsx`

## L1 covered

- `PCB-012` — Clarification precedes activation
- `PCB-013` — A fourth personal execution task cannot start
- `PCB-014` — Delegated work uses separate execution capacity
- `PCB-015` — Simultaneous starts and swaps cannot overfill focus
- `PCB-016` — A blocker states how it can be removed
- `PCB-017` — Waiting and paused work must reacquire capacity
- `PCB-018` — Editing metadata cannot bypass focus rules
- `PCB-019` — Closing and reopening preserve the acceptance boundary

## L2 spec files — decided here, written during execution

- BE: `docs/plans/personal-command-board/specs/l2/backend/04-promote-tasks-and-enforce-personal-wip.feature`
- FE: `docs/plans/personal-command-board/specs/l2/frontend/04-promote-tasks-and-enforce-personal-wip.feature`

No .feature runner is installed. These contracts must map to executable tests:
- Rust: `src-tauri/src/world/command_lifecycle_tests.rs` (register as a `#[cfg(test)]` module).
- Real DB: extend `src-tauri/src/world/command_store_tests.rs` from card 03.
- Vitest: `web/src/os/world/TaskLifecycle.test.tsx`.
- Browser: `scripts/test-command-board.mjs`; reuse existing synthetic/in-memory patterns.

## Sequence

- [ ] BE spec: write the L2 contract and map each scenario to named native Rust tests; add meaningful failing coverage before the behavior change.
- [ ] BE work: build centralized transition/capacity functions with current-version checks, event append and structured conflict detail; keep metadata edits from mutating guarded fields.
- [ ] BE work: call the same guards from managed dispatch/direction/claim entry points. Count only new review-producing cycles for backpressure; admitted cycles retain completion ability.
- [ ] BE tests: final-slot races, owner/attention/project changes, swap atomicity, malformed blockers, resume at capacity, generic completion bypass, reopen stale approvals and review-pressure admission.
- [ ] BE integration test: extend the disposable PostgreSQL harness to race the final personal slot and a competing swap/edit; assert transactional limits and exactly-once event/receipt persistence.
- [ ] BE code review: inspect all changed domain/transaction paths and resolve in-scope defects.
- [ ] BE security review (`/security-review`, scoped to this Rust work): Capacity races, generic-edit bypasses, review approval boundary and runtime fencing.
- [ ] FE spec: write the L2 contract and map each scenario to Vitest/browser checks; use behavioral interactions where static markup cannot prove the outcome.
- [ ] FE work: add Clarify, Activate, Pause, Block, Wait, Cancel and Reopen actions to the shared task drawer with current commitments and explicit swap selection.
- [ ] FE tests: capture-to-ready-to-active, fourth-task refusal, delegated parallelism, blocker fields, stopped work and a stale activation retaining its original UI state.
- [ ] FE code review: check failed/stale actions, truthful statuses, empty states, accessibility and responsive behavior.
- [ ] FE security review (`/security-review`, scoped): check content rendering, IDs, visible authority and server-side validation expectations.

- [ ] Verification: run this card's targeted checks plus the applicable project-wide Rust/web checks in plan.md; build web into a unique temporary directory. Record exact commands/results; missing required checks remain blockers.
- [ ] Acceptance: demonstrate every criterion below and update progress. Append dated Closed evidence, then move this card into done; do not commit or release.

## Acceptance

- [ ] A fourth personal execution task is refused across all entry points; defined delegated work uses separate capacity.
- [ ] Waiting/Blocked releases current execution attention, but resume reacquires capacity.
- [ ] Missing blocker fields and inconsistent owner/attention changes are rejected without partial effects.
- [ ] Priority never promotes work; review-required completion and stale approvals cannot be bypassed.
- [ ] Every successful transition produces one durable activity event; refusal changes nothing.

## Sensitivity

Capacity races, generic-edit bypasses, review approval boundary and runtime fencing.

## Out of scope

- Automatically resuming after decisions or review capacity clears.
- Batch result/review UI (08) and complex dependency graphs.

## Execution record

Not started. No implementation, test execution or acceptance result is claimed.
