---
title: "06 Choose a bounded Today list without changing task state"
order: 6
created: 2026-09-16
status: active
execution_status: not-started
project: octiqos
layers: both
category: implementation
sensitivity: sensitive
depends_on: ["04", "05"]
---

# 06 — Choose a bounded Today list without changing task state

## Capability

Persist a small daily selection of three primary and two minor tasks independently from their project and task lifecycle.

## Prerequisites and execution contract

Complete cards 04, 05.
Read [overview](../_overview.md) and [plan](../plan.md) before implementation.
Inspect current git status and preserve unrelated changes. This is a monorepo:
no BE deployment, API regeneration, per-card commit, release or live restart.
Append a Closed block and move to done only after required checks pass.

## Scope

- Store date/timezone, task references, primary/minor group and ordering separately from tasks; use an explicit persisted local timezone basis.
- Add/remove/reorder/swap selections atomically and enforce group sizes under retries and simultaneous sessions.
- Allow relevant Ready/Active/Blocked/Review items to be selected without activation; display status and use the normal guarded Start action.
- Keep prior days readable, handle cancelled/deleted references clearly, and do not roll yesterday's unfinished choices forward automatically.

## Code entry points

Existing unless explicitly marked new; inspect before editing. Native test paths
below are planned new files and must be registered in the existing harness.

- `src-tauri/src/world/model.rs`
- `src-tauri/src/world/mod.rs`
- `web/src/os/world/WorldPortal.tsx`
- `web/src/os/world/types.ts`

## L1 covered

- `PCB-024` — Today has three primary and two minor slots
- `PCB-025` — Selecting Today does not start the work
- `PCB-026` — Today survives reload without becoming tomorrow's backlog

## L2 spec files — decided here, written during execution

- BE: `docs/plans/personal-command-board/specs/l2/backend/06-choose-bounded-today.feature`
- FE: `docs/plans/personal-command-board/specs/l2/frontend/06-choose-bounded-today.feature`

No .feature runner is installed. These contracts must map to executable tests:
- Rust: `src-tauri/src/world/command_today_tests.rs` (register as a `#[cfg(test)]` module).
- Vitest: `web/src/os/world/Today.test.tsx`.
- Browser: `scripts/test-command-board.mjs`; reuse existing synthetic/in-memory patterns.

## Sequence

- [ ] BE spec: write the L2 contract and map each scenario to named native Rust tests; add meaningful failing coverage before the behavior change.
- [ ] BE work: add date-scoped Today records, reference validation and bounded selection mutations; prevent duplicate references within a day.
- [ ] BE tests: fourth-primary/third-minor refusal, atomic replacement, retry, concurrent adds, local date boundary and stale/deleted task references.
- [ ] BE code review: inspect all changed domain/transaction paths and resolve in-scope defects.
- [ ] BE security review (`/security-review`, scoped to this Rust work): Date-scoped persistence, global founder context and concurrency.
- [ ] FE spec: write the L2 contract and map each scenario to Vitest/browser checks; use behavioral interactions where static markup cannot prove the outcome.
- [ ] FE work: implement Today selection and status-preserving actions with small primary/minor groups and optional previous-day access.
- [ ] FE tests: reload, day change, moving between groups at capacity and selecting a blocked/review task without activating it.
- [ ] FE code review: check failed/stale actions, truthful statuses, empty states, accessibility and responsive behavior.
- [ ] FE security review (`/security-review`, scoped): check content rendering, IDs, visible authority and server-side validation expectations.

- [ ] Verification: run this card's targeted checks plus the applicable project-wide Rust/web checks in plan.md; build web into a unique temporary directory. Record exact commands/results; missing required checks remain blockers.
- [ ] Acceptance: demonstrate every criterion below and update progress. Append dated Closed evidence, then move this card into done; do not commit or release.

## Acceptance

- [ ] Today has at most three primary and two minor selections and survives reload.
- [ ] Selecting, moving or removing a Today item changes neither task nor project state.
- [ ] The same task cannot consume multiple Today slots; date rollover does not grow a backlog.
- [ ] Start from Today uses the same project, WIP and review guards.

## Sensitivity

Date-scoped persistence, global founder context and concurrency.

## Out of scope

- Calendar integrations, scheduling, auto-rollover and recurring reminders.

## Execution record

Not started. No implementation, test execution or acceptance result is claimed.

