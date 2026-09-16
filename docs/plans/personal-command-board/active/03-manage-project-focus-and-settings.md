---
title: "03 Manage project commitments, project detail and focus settings"
order: 3
created: 2026-09-16
status: active
execution_status: not-started
project: octiqos
layers: both
category: implementation
sensitivity: sensitive
depends_on: ["01", "02"]
---

# 03 — Manage project commitments, project detail and focus settings

## Capability

Create and inspect projects while limiting focused projects to two and making Background/Parked behavior operationally meaningful.

## Prerequisites and execution contract

Complete cards 01, 02.
Read [overview](../_overview.md) and [plan](../plan.md) before implementation.
Inspect current git status and preserve unrelated changes. This is a monorepo:
no BE deployment, API regeneration, per-card commit, release or live restart.
Append a Closed block and move to done only after required checks pass.

## Scope

- Add Active/Background/Parked/Completed, goal, milestone and owner to project management. New projects are Parked and do not require a workspace.
- Add persisted focus settings with defaults 2/3/5 and optional default project; expose only settings whose rules are implemented, adding task/review controls in 04/08.
- Implement global Active-project admission, explicit atomic project swap and validated limit changes inside the same world transaction.
- Require an explicit disposition for personal Active tasks when backgrounding a project; fence/interrupt existing managed work when parking. Existing managed dispatch and claim paths must honor Parked/Completed.
- Project detail includes active/blocked/review/recent Done/Someday groups; empty groups are valid before later cards populate them. Completing a project refuses unresolved work until explicitly disposed.

## Code entry points

Existing unless explicitly marked new; inspect before editing. Native test paths
below are planned new files and must be registered in the existing harness.

- `src-tauri/src/world/model.rs`
- `src-tauri/src/world/runtime.rs`
- `src-tauri/src/world/mod.rs`
- `web/src/os/world/WorldPortal.tsx`
- `web/src/os/world/Forms.tsx`

## L1 covered

- `PCB-007` — A third focused project requires an explicit swap
- `PCB-008` — Background does not hide personal commitments
- `PCB-009` — Parking stops execution without deleting its evidence
- `PCB-010` — Project detail describes its outcome and work
- `PCB-011` — Focus settings apply globally and persist

## L2 spec files — decided here, written during execution

- BE: `docs/plans/personal-command-board/specs/l2/backend/03-manage-project-focus-and-settings.feature`
- FE: `docs/plans/personal-command-board/specs/l2/frontend/03-manage-project-focus-and-settings.feature`

No .feature runner is installed. These contracts must map to executable tests:
- Rust: `src-tauri/src/world/command_project_tests.rs` (register as a `#[cfg(test)]` module).
- Real DB: introduce `src-tauri/src/world/command_store_tests.rs` with an explicitly opt-in, disposable test database; later cards extend this harness.
- Vitest: `web/src/os/world/Projects.test.tsx`.
- Browser: `scripts/test-command-board.mjs`; reuse existing synthetic/in-memory patterns.

## Sequence

- [ ] BE spec: write the L2 contract and map each scenario to named native Rust tests; add meaningful failing coverage before the behavior change.
- [ ] BE work: implement project state actions, settings validation and atomic focus swaps without force flags or automatic project selection.
- [ ] BE work: connect park/background transitions to task disposition and generation fencing; block runtime eligibility while a project cannot execute.
- [ ] BE tests: third project refusal across orgs, competing final-slot mutations, swap rollback, lowering a limit, in-flight park, completed-project reopen and missing default-project fallback.
- [ ] BE integration test: introduce the isolated PostgreSQL harness and prove competing final-project-slot actions and atomic swap rollback against the real transaction boundary. Use a dedicated test-only DSN and reject installed preview/production targets; a sequential model test is insufficient.
- [ ] BE code review: inspect all changed domain/transaction paths and resolve in-scope defects.
- [ ] BE security review (`/security-review`, scoped to this Rust work): Project authorization, global capacity transaction, runtime interruption and stored settings.
- [ ] FE spec: write the L2 contract and map each scenario to Vitest/browser checks; use behavioral interactions where static markup cannot prove the outcome.
- [ ] FE work: build project list/detail and focus settings with current commitments, explicit displacement selection and Stopping feedback.
- [ ] FE tests: project creation with no folder, full-capacity swap, backgrounding personal work, park confirmation and retained historical results.
- [ ] FE code review: check failed/stale actions, truthful statuses, empty states, accessibility and responsive behavior.
- [ ] FE security review (`/security-review`, scoped): check content rendering, IDs, visible authority and server-side validation expectations.

- [ ] Verification: run this card's targeted checks plus the applicable project-wide Rust/web checks in plan.md; build web into a unique temporary directory. Record exact commands/results; missing required checks remain blockers.
- [ ] Acceptance: demonstrate every criterion below and update progress. Append dated Closed evidence, then move this card into done; do not commit or release.

## Acceptance

- [ ] A third Active project is refused globally, including direct commands and concurrent starts.
- [ ] Backgrounding cannot hide personal Active work; the person chooses its disposition.
- [ ] Parked projects cannot execute; stopping is truthful and prior file changes/results remain visible.
- [ ] Project detail and settings persist; completion and reopen are deliberate.

## Sensitivity

Project authorization, global capacity transaction, runtime interruption and stored settings.

## Out of scope

- Automatically stopping work based on priority or choosing a project to pause.
- Weekly Review and production service restart.

## Execution record

Not started. No implementation, test execution or acceptance result is claimed.
