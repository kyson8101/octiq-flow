---
title: "09 Move work on a guarded secondary Kanban"
order: 9
created: 2026-09-16
status: active
execution_status: not-started
project: octiqos
layers: FE
category: implementation
sensitivity: standard
depends_on: ["04", "05", "07", "08"]
---

# 09 — Move work on a guarded secondary Kanban

## Capability

Offer a secondary Kanban view whose drag, keyboard and touch moves use the existing domain actions and cannot bypass focus or review rules.

## Prerequisites and execution contract

Complete cards 04, 05, 07, 08.
Read [overview](../_overview.md) and [plan](../plan.md) before implementation.
Inspect current git status and preserve unrelated changes. This is a monorepo:
no BE deployment, API regeneration, per-card commit, release or live restart.
Append a Closed block and move to done only after required checks pass.

## Scope

- Show the seven requested main columns using the shared task records and filters; keep Someday and Cancelled outside the main workflow.
- Map moves to domain commands, including clarification, blocker, waiting and result/review dialogs; moving to Done invokes the actual completion/approval flow.
- Support pointer drag plus accessible Move actions; show backend refusals without persisting an optimistic false state.
- Keep task details and board navigation consistent with Command and Today; do not introduce separate per-board task copies.

## Code entry points

Existing unless explicitly marked new; inspect before editing. Native test paths
below are planned new files and must be registered in the existing harness.

- `web/src/os/world/WorldPortal.tsx`
- `web/src/os/world/types.ts`
- `web/src/os/world/world.css`

## L1 covered

- `PCB-038` — Kanban reflects the shared lifecycle
- `PCB-039` — Dragging cannot bypass lifecycle checks
- `PCB-040` — Keyboard and touch can perform the same guarded moves

## L2 spec files — decided here, written during execution

- FE: `docs/plans/personal-command-board/specs/l2/frontend/09-move-work-on-guarded-kanban.feature`

No .feature runner is installed. These contracts must map to executable tests:
- Vitest: `web/src/os/world/Kanban.test.tsx`.
- Browser: `scripts/test-command-board.mjs`; reuse existing synthetic/in-memory patterns.

## Sequence

- [ ] FE spec: write the L2 contract and map each scenario to Vitest/browser checks; use behavioral interactions where static markup cannot prove the outcome.
- [ ] FE work: implement state columns and a single transition-intent mapping reused by drag, keyboard and touch actions.
- [ ] FE work: connect existing action dialogs/guards and rollback/refetch after rejected or stale transitions; retain scroll and selected task where possible.
- [ ] FE tests: rejected fourth Active move, incomplete clarification/block fields, Review-to-Done requiring current approval, stale response and keyboard/touch parity.
- [ ] FE code review: check failed/stale actions, truthful statuses, empty states, accessibility and responsive behavior.
- [ ] Browser checks: move representative items with pointer and keyboard at desktop/mobile widths and confirm Command/Today immediately reflect the same saved state.
- [ ] Verification: run this card's targeted checks plus the applicable project-wide Rust/web checks in plan.md; build web into a unique temporary directory. Record exact commands/results; missing required checks remain blockers.
- [ ] Acceptance: demonstrate every criterion below and update progress. Append dated Closed evidence, then move this card into done; do not commit or release.

## Acceptance

- [ ] All seven columns use canonical task state; no second board state is persisted.
- [ ] Drag cannot bypass WIP, project eligibility, required fields or review.
- [ ] Rejected/stale actions leave the card in its actual saved state with an actionable explanation.
- [ ] Keyboard/touch actions support the same transitions as drag.

## Sensitivity

UI transition consistency; backend authorization/capacity rules remain owned by prior cards.

## Out of scope

- A new workflow engine or configurable board columns.

## Execution record

Not started. No implementation, test execution or acceptance result is claimed.

