---
title: "05 Show the global Command dashboard and shared task context"
order: 5
created: 2026-09-16
status: active
execution_status: not-started
project: octiqos
layers: both
category: implementation
sensitivity: sensitive
depends_on: ["04"]
---

# 05 — Show the global Command dashboard and shared task context

## Capability

Provide one bounded cross-project view of decisions, reviews and personal execution, with quiet blocked/running monitors and accessible task details.

## Prerequisites and execution contract

Complete cards 04.
Read [overview](../_overview.md) and [plan](../plan.md) before implementation.
Inspect current git status and preserve unrelated changes. This is a monorepo:
no BE deployment, API regeneration, per-card commit, release or live restart.
Append a Closed block and move to done only after required checks pass.

## Scope

- Build one authoritative attention projection for the founder across all visible orgs/projects; filters affect presentation, not capacity.
- Render Decisions, Reviews, My Active Work, other Blocked/Needs Attention and collapsed Running Agents with disjoint primary placement.
- Use bounded initial lists, truthful totals, stable aging-aware ordering and Show all; keep critical priority distinct from activation and notifications.
- Integrate the shared task drawer, desktop sidebar and mobile navigation using existing design tokens and both appearances.
- Expose Command as an explicit view during implementation. Do not switch the global default until the complete MVP passes card 12.

## Code entry points

Existing unless explicitly marked new; inspect before editing. Native test paths
below are planned new files and must be registered in the existing harness.

- `src-tauri/src/world/mod.rs`
- `src-tauri/src/world/model.rs`
- `web/src/os/world/WorldPortal.tsx`
- `web/src/os/world/MobileViews.tsx`
- `web/src/os/world/world.css`

## L1 covered

- `PCB-020` — Command collects personal needs across projects
- `PCB-021` — Delegation stays quiet and attention is not duplicated
- `PCB-022` — Large queues stay bounded without hiding their size
- `PCB-023` — Task context is usable on desktop and phone

## L2 spec files — decided here, written during execution

- BE: `docs/plans/personal-command-board/specs/l2/backend/05-show-global-command.feature`
- FE: `docs/plans/personal-command-board/specs/l2/frontend/05-show-global-command.feature`

No .feature runner is installed. These contracts must map to executable tests:
- Rust: `src-tauri/src/world/command_query_tests.rs` (register as a `#[cfg(test)]` module).
- Vitest: `web/src/os/world/CommandDashboard.test.tsx`.
- Browser: `scripts/test-command-board.mjs`; reuse existing synthetic/in-memory patterns.

## Sequence

- [ ] BE spec: write the L2 contract and map each scenario to named native Rust tests; add meaningful failing coverage before the behavior change.
- [ ] BE work: define bounded attention response and ordering; expose current counts and commitment identifiers through authenticated world commands.
- [ ] BE tests: cross-project/org aggregation for the founder, worker-scope exclusion, duplicate decision suppression, none-attention exclusion and totals under filters.
- [ ] BE code review: inspect all changed domain/transaction paths and resolve in-scope defects.
- [ ] BE security review (`/security-review`, scoped to this Rust work): Founder-versus-worker projection boundaries and untrusted task content.
- [ ] FE spec: write the L2 contract and map each scenario to Vitest/browser checks; use behavioral interactions where static markup cannot prove the outcome.
- [ ] FE work: implement Command sections, quiet monitors, view navigation and task-drawer handoff; preserve Office and existing task conversation entry.
- [ ] FE tests: large queues, mixed ownership/priority, background questions, desktop/mobile light/dark layouts, keyboard focus and returning to a queue.
- [ ] FE code review: check failed/stale actions, truthful statuses, empty states, accessibility and responsive behavior.
- [ ] FE security review (`/security-review`, scoped): check content rendering, IDs, visible authority and server-side validation expectations.

- [ ] Verification: run this card's targeted checks plus the applicable project-wide Rust/web checks in plan.md; build web into a unique temporary directory. Record exact commands/results; missing required checks remain blockers.
- [ ] Acceptance: demonstrate every criterion below and update progress. Append dated Closed evidence, then move this card into done; do not commit or release.

## Acceptance

- [ ] The founder sees all relevant project needs without visiting per-project boards.
- [ ] A blocked decision appears once; running work with attention none does not enter personal queues.
- [ ] Large queues stay bounded on entry with accurate totals and access to all items.
- [ ] Opening or returning from task detail never starts a run or loses queue context.

## Sensitivity

Founder-versus-worker projection boundaries and untrusted task content.

## Out of scope

- Automatic ranking by an LLM, proactive notifications and charts.
- Final default-entry switch (12).

## Execution record

Not started. No implementation, test execution or acceptance result is claimed.

