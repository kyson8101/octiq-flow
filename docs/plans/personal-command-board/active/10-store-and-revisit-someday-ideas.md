---
title: "10 Store and deliberately revisit Someday / Lab ideas"
order: 10
created: 2026-09-16
status: active
execution_status: not-started
project: octiqos
layers: both
category: implementation
sensitivity: sensitive
depends_on: ["02", "04", "05"]
---

# 10 — Store and deliberately revisit Someday / Lab ideas

## Capability

Keep interesting ideas in a trusted quiet space and return them to defined work only through deliberate clarification.

## Prerequisites and execution contract

Complete cards 02, 04, 05.
Read [overview](../_overview.md) and [plan](../plan.md) before implementation.
Inspect current git status and preserve unrelated changes. This is a monorepo:
no BE deployment, API regeneration, per-card commit, release or live restart.
Append a Closed block and move to done only after required checks pass.

## Scope

- Add a dedicated Someday view with title, description, optional project, why interesting, future trigger and original capture date.
- Shelve captured Inbox/Ready ideas explicitly; leave active work through the existing pause action before shelving.
- Show project-scoped ideas in Project detail and allow global browsing without attention badges, automatic urgency or guilt counters.
- Promote through clarification to Ready; free-text future triggers are passive notes, not a scheduler.

## Code entry points

Existing unless explicitly marked new; inspect before editing. Native test paths
below are planned new files and must be registered in the existing harness.

- `src-tauri/src/world/model.rs`
- `web/src/os/world/WorldPortal.tsx`
- `web/src/os/world/Forms.tsx`
- `web/src/os/world/types.ts`

## L1 covered

- `PCB-041` — Store an idea in Someday deliberately
- `PCB-042` — Someday is quiet storage
- `PCB-043` — Revisit an idea through normal clarification

## L2 spec files — decided here, written during execution

- BE: `docs/plans/personal-command-board/specs/l2/backend/10-store-and-revisit-someday-ideas.feature`
- FE: `docs/plans/personal-command-board/specs/l2/frontend/10-store-and-revisit-someday-ideas.feature`

No .feature runner is installed. These contracts must map to executable tests:
- Rust: `src-tauri/src/world/command_someday_tests.rs` (register as a `#[cfg(test)]` module).
- Vitest: `web/src/os/world/Someday.test.tsx`.
- Browser: `scripts/test-command-board.mjs`; reuse existing synthetic/in-memory patterns.

## Sequence

- [ ] BE spec: write the L2 contract and map each scenario to named native Rust tests; add meaningful failing coverage before the behavior change.
- [ ] BE work: add interest/trigger metadata and explicit shelve/revisit actions with history and existing lifecycle validation.
- [ ] BE tests: unfiled idea storage, capture date preservation, shelving active work through pause, clarification requirements and no implicit trigger execution.
- [ ] BE code review: inspect all changed domain/transaction paths and resolve in-scope defects.
- [ ] BE security review (`/security-review`, scoped to this Rust work): Persistent idea content and transition restrictions.
- [ ] FE spec: write the L2 contract and map each scenario to Vitest/browser checks; use behavioral interactions where static markup cannot prove the outcome.
- [ ] FE work: build the dedicated idea pool and project-detail section with Shelve/Revisit controls and quiet empty states.
- [ ] FE tests: capture then shelve, revisit with missing project/outcome, no direct Active promotion and no overdue/urgent styling for stored ideas.
- [ ] FE code review: check failed/stale actions, truthful statuses, empty states, accessibility and responsive behavior.
- [ ] FE security review (`/security-review`, scoped): check content rendering, IDs, visible authority and server-side validation expectations.

- [ ] Verification: run this card's targeted checks plus the applicable project-wide Rust/web checks in plan.md; build web into a unique temporary directory. Record exact commands/results; missing required checks remain blockers.
- [ ] Acceptance: demonstrate every criterion below and update progress. Append dated Closed evidence, then move this card into done; do not commit or release.

## Acceptance

- [ ] Someday stores the idea, interest and trigger without creating an active commitment.
- [ ] A future trigger does not schedule, notify, promote or execute work.
- [ ] Revisit goes through Ready and the usual activation gates.
- [ ] Someday remains discoverable outside the main Kanban and personal attention queues.

## Sensitivity

Persistent idea content and transition restrictions.

## Out of scope

- Automated trigger detection, periodic idea resurfacing and backlog scoring.

## Execution record

Not started. No implementation, test execution or acceptance result is claimed.

