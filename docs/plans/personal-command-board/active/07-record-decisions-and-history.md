---
title: "07 Resolve decision tasks and preserve a searchable Decision Log"
order: 7
created: 2026-09-16
status: active
execution_status: not-started
project: octiqos
layers: both
category: implementation
sensitivity: sensitive
depends_on: ["04", "05"]
---

# 07 — Resolve decision tasks and preserve a searchable Decision Log

## Capability

Collect structured questions and record durable decisions with their context and rationale, independent of task completion.

## Prerequisites and execution contract

Complete cards 04, 05.
Read [overview](../_overview.md) and [plan](../plan.md) before implementation.
Inspect current git status and preserve unrelated changes. This is a monorepo:
no BE deployment, API regeneration, per-card commit, release or live restart.
Append a Closed block and move to done only after required checks pass.

## Scope

- Add decision details: question, context, options/pros/cons, recommendation, chosen option or explicit free-text choice, rationale, owner, project, related task and optional review date.
- Connect existing decision blockers to records using actual saved questions; do not invent missing options, recommendations or historical resolutions.
- Resolve transactionally into an immutable decision entry. Pure decision tasks can complete; execution blockers return to Ready without dispatch.
- Provide a Decision Log with basic text/project search now, plus superseding revisions that retain original rationale; 11 unifies it with global search.
- Refresh Command queues after resolution; a Background project stays Background.

## Code entry points

Existing unless explicitly marked new; inspect before editing. Native test paths
below are planned new files and must be registered in the existing harness.

- `src-tauri/src/world/model.rs`
- `src-tauri/src/world/mod.rs`
- `web/src/os/world/WorldPortal.tsx`
- `web/src/os/world/TaskWorkspace.tsx`
- `web/src/os/world/types.ts`

## L1 covered

- `PCB-027` — A decision carries enough context to answer
- `PCB-028` — Resolving a blocker records a decision without claiming execution finished
- `PCB-029` — Changing a decision preserves the original rationale
- `PCB-030` — A Background project can queue a decision quietly

## L2 spec files — decided here, written during execution

- BE: `docs/plans/personal-command-board/specs/l2/backend/07-record-decisions-and-history.feature`
- FE: `docs/plans/personal-command-board/specs/l2/frontend/07-record-decisions-and-history.feature`

No .feature runner is installed. These contracts must map to executable tests:
- Rust: `src-tauri/src/world/command_decision_tests.rs` (register as a `#[cfg(test)]` module).
- Vitest: `web/src/os/world/Decisions.test.tsx`.
- Browser: `scripts/test-command-board.mjs`; reuse existing synthetic/in-memory patterns.

## Sequence

- [ ] BE spec: write the L2 contract and map each scenario to named native Rust tests; add meaningful failing coverage before the behavior change.
- [ ] BE work: implement create/link/resolve/supersede decision commands and log queries with versioned choices and immutable resolved entries.
- [ ] BE tests: invalid selected option, explicit free-text choice, duplicate resolution, stale option set, superseded history and task deletion/archive visibility.
- [ ] BE tests: resolving a pure decision versus an execution blocker; preserve reviewRequired and owner, clear only the linked blocker, and never auto-activate or grant execution permission.
- [ ] BE code review: inspect all changed domain/transaction paths and resolve in-scope defects.
- [ ] BE security review (`/security-review`, scoped to this Rust work): Immutable audit history, actor attribution and decision-versus-execution authority.
- [ ] FE spec: write the L2 contract and map each scenario to Vitest/browser checks; use behavioral interactions where static markup cannot prove the outcome.
- [ ] FE work: build structured decision details, resolve form and durable log with related-task links and revision history.
- [ ] FE tests: options/recommendation display, required rationale, background project resolution, reload and finding an old decision after its task is Done.
- [ ] FE code review: check failed/stale actions, truthful statuses, empty states, accessibility and responsive behavior.
- [ ] FE security review (`/security-review`, scoped): check content rendering, IDs, visible authority and server-side validation expectations.

- [ ] Verification: run this card's targeted checks plus the applicable project-wide Rust/web checks in plan.md; build web into a unique temporary directory. Record exact commands/results; missing required checks remain blockers.
- [ ] Acceptance: demonstrate every criterion below and update progress. Append dated Closed evidence, then move this card into done; do not commit or release.

## Acceptance

- [ ] Decision context and actual options are visible without searching through a conversation.
- [ ] Resolve records one dated entry containing the choice, rationale, project, owner and task.
- [ ] A changed decision adds a superseding entry; the original remains searchable.
- [ ] Resolving a blocker does not finish execution, start an agent or activate a project.

## Sensitivity

Immutable audit history, actor attribution and decision-versus-execution authority.

## Out of scope

- Automatic extraction from meetings, docspace sync and review-date notifications.

## Execution record

Not started. No implementation, test execution or acceptance result is claimed.

