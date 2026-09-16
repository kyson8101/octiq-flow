---
title: "11 Search all work, combine filters and read activity history"
order: 11
created: 2026-09-16
status: active
execution_status: not-started
project: octiqos
layers: both
category: implementation
sensitivity: sensitive
depends_on: ["03", "04", "07", "08", "09", "10"]
---

# 11 — Search all work, combine filters and read activity history

## Capability

Find tasks, projects, decisions and notes in one place, and understand the durable history behind each task's current state.

## Prerequisites and execution contract

Complete cards 03, 04, 07, 08, 09, 10.
Read [overview](../_overview.md) and [plan](../plan.md) before implementation.
Inspect current git status and preserve unrelated changes. This is a monorepo:
no BE deployment, API regeneration, per-card commit, release or live restart.
Append a Closed block and move to done only after required checks pass.

## Scope

- Add bounded global search across titles/descriptions/notes, project name/goal/milestone and decision question/context/choice/rationale; include completed and superseded history when requested.
- Combine project/status/owner/attention/priority/tag/due-date filters on task views, with clear active-filter and empty-state behavior.
- Render the activity timeline already recorded by prior cards, including assignment, transition, blocker, decision, result, change request and approval references.
- Keep result text safely rendered; do not index private credentials, arbitrary runtime internals or unrelated chat transcripts. Preserve worker project boundaries.

## Code entry points

Existing unless explicitly marked new; inspect before editing. Native test paths
below are planned new files and must be registered in the existing harness.

- `src-tauri/src/world/mod.rs`
- `src-tauri/src/world/model.rs`
- `web/src/os/world/WorldPortal.tsx`
- `web/src/os/world/TaskWorkspace.tsx`

## L1 covered

- `PCB-044` — Search finds durable work and decisions
- `PCB-045` — Filters combine without changing capacity
- `PCB-046` — History explains how work reached its current state
- `PCB-047` — Search and history respect context boundaries

## L2 spec files — decided here, written during execution

- BE: `docs/plans/personal-command-board/specs/l2/backend/11-search-filter-and-read-activity.feature`
- FE: `docs/plans/personal-command-board/specs/l2/frontend/11-search-filter-and-read-activity.feature`

No .feature runner is installed. These contracts must map to executable tests:
- Rust: `src-tauri/src/world/command_search_tests.rs` (register as a `#[cfg(test)]` module).
- Vitest: `web/src/os/world/SearchAndHistory.test.tsx`.
- Browser: `scripts/test-command-board.mjs`; reuse existing synthetic/in-memory patterns.

## Sequence

- [ ] BE spec: write the L2 contract and map each scenario to named native Rust tests; add meaningful failing coverage before the behavior change.
- [ ] BE work: implement scoped, bounded search and filter composition with stable pagination/order; reuse immutable decision/result/activity records.
- [ ] BE tests: matching notes and resolved rationale, combined filters, timezone-aware due-date boundaries, pagination stability, stale entity references and worker-scope exclusions.
- [ ] BE code review: inspect all changed domain/transaction paths and resolve in-scope defects.
- [ ] BE security review (`/security-review`, scoped to this Rust work): Stored notes/evidence, cross-context search, audit retention and untrusted rendering.
- [ ] FE spec: write the L2 contract and map each scenario to Vitest/browser checks; use behavioral interactions where static markup cannot prove the outcome.
- [ ] FE work: build global search, reusable task filters and the chronological timeline in shared task details.
- [ ] FE tests: find a completed task's decision, filter by owner/attention/tag/due date, clear filters, inspect linked history and render malicious text as text.
- [ ] FE code review: check failed/stale actions, truthful statuses, empty states, accessibility and responsive behavior.
- [ ] FE security review (`/security-review`, scoped): check content rendering, IDs, visible authority and server-side validation expectations.

- [ ] Verification: run this card's targeted checks plus the applicable project-wide Rust/web checks in plan.md; build web into a unique temporary directory. Record exact commands/results; missing required checks remain blockers.
- [ ] Acceptance: demonstrate every criterion below and update progress. Append dated Closed evidence, then move this card into done; do not commit or release.

## Acceptance

- [ ] Search finds tasks, projects, decisions and notes, including old completed work.
- [ ] All requested task filters combine correctly without changing global WIP counts.
- [ ] History explains the saved sequence with real actors/times and no duplicate retry events or invented past data.
- [ ] Search/history are bounded, safe to render and honor existing scope boundaries.

## Sensitivity

Stored notes/evidence, cross-context search, audit retention and untrusted rendering.

## Out of scope

- External search infrastructure, semantic/LLM search and transcript ingestion.

## Execution record

Not started. No implementation, test execution or acceptance result is claimed.

