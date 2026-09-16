---
title: "12 Qualify the complete attention workflow and make Command the default"
order: 12
created: 2026-09-16
status: active
execution_status: not-started
project: octiqos
layers: both
category: testing
sensitivity: sensitive
depends_on: ["01", "02", "03", "04", "05", "06", "07", "08", "09", "10", "11"]
---

# 12 — Qualify the complete attention workflow and make Command the default

## Capability

Prove the complete manual command-board workflow and existing Office compatibility, then set the tested Command view as the source-code default without deploying.

## Prerequisites and execution contract

Complete cards 01, 02, 03, 04, 05, 06, 07, 08, 09, 10, 11.
Read [overview](../_overview.md) and [plan](../plan.md) before implementation.
Inspect current git status and preserve unrelated changes. This is a monorepo:
no BE deployment, API regeneration, per-card commit, release or live restart.
Append a Closed block and move to done only after required checks pass.

## Scope

- Finish synthetic cross-project browser fixtures and integrated tests for the ideal daily workflow, full queues, quiet delegation and deliberate new-work friction.
- Exercise real PostgreSQL transactions in a disposable test database: competing last slots, swaps, output/version races, retries and interruption/restart durability.
- Validate versioned upgrade against a synthetic old-world fixture, repeat it, and rehearse restore in isolation; do not read or migrate production data.
- Run existing Office/task navigation regressions and scoped auth/project-boundary checks; document any required browser/DB prerequisite explicitly.
- After acceptance passes, change the /os default entry to Command, retaining Office navigation and legacy route behavior; update product docs.

## Code entry points

Existing unless explicitly marked new; inspect before editing. Native test paths
below are planned new files and must be registered in the existing harness.

- `src-tauri/src/world/command_store_tests.rs` (introduced in 03, extended in 04/08)
- `src-tauri/src/world/mod.rs`
- `scripts/test-command-board.mjs (introduced by 02, completed here)`
- `scripts/test-agent-tasks.mjs`
- `web/src/os/world/WorldPortal.tsx`
- `docs/octiqos-world.md`

## L1 covered

- `PCB-048` — Complete the daily attention loop
- `PCB-049` — Concurrent and interrupted actions preserve commitments
- `PCB-050` — The existing office workflow remains usable
- `PCB-051` — A full board can recover through deliberate review and pausing

## L2 spec files — decided here, written during execution

- BE: `docs/plans/personal-command-board/specs/l2/backend/12-qualify-mvp-and-default-command.feature`
- FE: `docs/plans/personal-command-board/specs/l2/frontend/12-qualify-mvp-and-default-command.feature`

No .feature runner is installed. These contracts must map to executable tests:
- Rust: `src-tauri/src/world/command_store_tests.rs` (register as a `#[cfg(test)]` module).
- Vitest: `web/src/os/world/CommandAcceptance.test.tsx`.
- Browser: `scripts/test-command-board.mjs`; reuse existing synthetic/in-memory patterns.
- Use the real isolated database harness for transaction proof, not only the browser mock.

## Sequence

- [ ] BE spec: write the L2 contract and map each scenario to named native Rust tests; add meaningful failing coverage before the behavior change.
- [ ] BE test work: extend the explicitly opt-in disposable-PostgreSQL harness from 03/04/08 with restart/upgrade/restore fixtures and deterministic mutation barriers; retain its dedicated test-only DSN and production/preview refusal.
- [ ] BE checks: race the final project/task slot, swap with conflicting edit, review threshold with simultaneous results, stale approvals and replay after interrupted response; restart and verify persisted truth.
- [ ] BE checks: migrate a synthetic legacy payload twice, preserve IDs/history/authorization, handle unknown states safely and demonstrate isolated restore.
- [ ] BE code review: inspect all changed domain/transaction paths and resolve in-scope defects.
- [ ] BE security review (`/security-review`, scoped to this Rust work): Migration recovery, transaction races, permission regressions and misleading readiness claims.
- [ ] FE spec: write the L2 contract and map each scenario to Vitest/browser checks; use behavioral interactions where static markup cannot prove the outcome.
- [ ] FE test work: complete the day-flow fixture and browser scenario covering capture, decisions, five reviews, Today, pause/swap, blocked resume, Someday and search.
- [ ] FE checks: desktop and narrow/mobile, light/dark, keyboard/touch and one bounded-screen walkthrough; record a real manual ten-second next-work check instead of claiming automation proves cognitive load.
- [ ] FE code review: check failed/stale actions, truthful statuses, empty states, accessibility and responsive behavior.
- [ ] FE security review (`/security-review`, scoped): check content rendering, IDs, visible authority and server-side validation expectations.
- [ ] Integration work: set Command as /os default only after the core flow passes; update current-world docs and retain explicit Office/legacy paths.
- [ ] Regression: run existing managed-task browser script plus full Rust library tests, web tests, type-check and isolated-output production build; record exact results and environment-independent limitations.
- [ ] Review: verify each of the ten user success criteria against recorded evidence; leave any missing required test or usability check open.
- [ ] Verification: run this card's targeted checks plus the applicable project-wide Rust/web checks in plan.md; build web into a unique temporary directory. Record exact commands/results; missing required checks remain blockers.
- [ ] Acceptance: demonstrate every criterion below and update progress. Append dated Closed evidence, then move this card into done; do not commit or release.

## Acceptance

- [ ] The complete daily loop works with two active projects, three personal tasks, quiet delegated work and a saved review backlog.
- [ ] Real concurrent transactions preserve hard WIP, event uniqueness and every completed output; mocks alone are insufficient.
- [ ] Existing managed tasks, permission boundaries and verification remain functional after upgrade.
- [ ] The default route opens Command in source after acceptance; no deployment, live restart or production data migration is performed.
- [ ] Every success criterion has evidence or an explicit unresolved blocker, and readiness is not claimed until required checks pass.

## Sensitivity

Migration recovery, transaction races, permission regressions and misleading readiness claims.

## Out of scope

- Release/commit/push/service restart and real-data migration.
- New execution orchestration, Weekly Review and proactive notifications.

## Execution record

Not started. No implementation, test execution or acceptance result is claimed.
