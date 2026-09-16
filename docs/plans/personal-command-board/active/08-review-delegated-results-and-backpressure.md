---
title: "08 Review delegated results in batches and apply review backpressure"
order: 8
created: 2026-09-16
status: active
execution_status: not-started
project: octiqos
layers: both
category: implementation
sensitivity: sensitive
depends_on: ["04", "05", "07"]
---

# 08 — Review delegated results in batches and apply review backpressure

## Capability

Track delegated outputs, review a small batch with explicit outcomes, and protect attention by holding new review-producing work when the queue is full.

## Prerequisites and execution contract

Complete cards 04, 05, 07.
Read [overview](../_overview.md) and [plan](../plan.md) before implementation.
Inspect current git status and preserve unrelated changes. This is a monorepo:
no BE deployment, API regeneration, per-card commit, release or live restart.
Append a Closed block and move to done only after required checks pass.

## Scope

- Record versioned output/evidence for tracked human or agent work without executing it. Existing managed completions use the same result/review records while keeping mandatory verification.
- Implement Approve, Request changes, Reject and Comment; preserve current owner, prior outputs, approval notes and actor/timestamps.
- Compare expected task/output version for each approval and deduplicate retries; reopened/replaced output never inherits a stale approval.
- Expose review threshold setting (default 5), truthful overflow and admission reason. Add current-cycle identity so backpressure blocks new cycles, not the remaining steps of admitted work.
- Provide focused sequential batch review with stable position/filters and no routine completion interruption.

## Code entry points

Existing unless explicitly marked new; inspect before editing. Native test paths
below are planned new files and must be registered in the existing harness.

- `src-tauri/src/world/model.rs`
- `src-tauri/src/world/runtime.rs`
- `src-tauri/src/world/mod.rs`
- `web/src/os/world/TaskWorkspace.tsx`
- `web/src/os/world/WorldPortal.tsx`

## L1 covered

- `PCB-031` — Record delegated results without starting an agent
- `PCB-032` — A submitted review remains unaccepted until I approve it
- `PCB-033` — Process a batch of outputs with explicit outcomes
- `PCB-034` — Requested changes respect current capacity
- `PCB-035` — An approval belongs to the output I actually saw
- `PCB-036` — Review pressure prevents new work but never loses completed work
- `PCB-037` — Admitted work can finish while review pressure is high

## L2 spec files — decided here, written during execution

- BE: `docs/plans/personal-command-board/specs/l2/backend/08-review-delegated-results-and-backpressure.feature`
- FE: `docs/plans/personal-command-board/specs/l2/frontend/08-review-delegated-results-and-backpressure.feature`

No .feature runner is installed. These contracts must map to executable tests:
- Rust: `src-tauri/src/world/command_review_tests.rs` (register as a `#[cfg(test)]` module).
- Real DB: extend `src-tauri/src/world/command_store_tests.rs` from cards 03–04.
- Vitest: `web/src/os/world/Reviews.test.tsx`.
- Browser: `scripts/test-command-board.mjs`; reuse existing synthetic/in-memory patterns.

## Sequence

- [ ] BE spec: write the L2 contract and map each scenario to named native Rust tests; add meaningful failing coverage before the behavior change.
- [ ] BE work: implement output versions and review commands; preserve evidence separately from acceptance notes and maintain existing exactly-once contributor rewards.
- [ ] BE work: complete review admission checks across Activate, resume, rework, direct managed dispatch and runtime claim; allow already-admitted cycles to finish and save all results.
- [ ] BE tests: 4-to-6 concurrent completions, threshold at start, ongoing multi-step workflow, stale/replayed approval, no-review tracked completion, legacy mandatory review and changes requested at full capacity.
- [ ] BE tests: changing owner or reviewRequired after submission cannot remove a pending result from the review queue or make it accepted.
- [ ] BE integration test: use the disposable PostgreSQL harness for simultaneous result submissions, approval-versus-replacement races and replayed acceptance; preserve both results, enforce expected versions and append one review event.
- [ ] BE code review: inspect all changed domain/transaction paths and resolve in-scope defects.
- [ ] BE security review (`/security-review`, scoped to this Rust work): Human approval authority, output-version races, backpressure admission and legacy runtime safety.
- [ ] FE spec: write the L2 contract and map each scenario to Vitest/browser checks; use behavioral interactions where static markup cannot prove the outcome.
- [ ] FE work: add result recording and batch Review screens with explicit per-item outcomes, overflow counts, comments and queued-rework explanations.
- [ ] FE tests: review five outputs in sequence, changed output while open, failed/retried approval and retaining position after approve/request changes/reject.
- [ ] FE code review: check failed/stale actions, truthful statuses, empty states, accessibility and responsive behavior.
- [ ] FE security review (`/security-review`, scoped): check content rendering, IDs, visible authority and server-side validation expectations.

- [ ] Verification: run this card's targeted checks plus the applicable project-wide Rust/web checks in plan.md; build web into a unique temporary directory. Record exact commands/results; missing required checks remain blockers.
- [ ] Acceptance: demonstrate every criterion below and update progress. Append dated Closed evidence, then move this card into done; do not commit or release.

## Acceptance

- [ ] Tracked assignment/result recording never starts an agent; reviewRequired determines its acceptance path.
- [ ] At five pending reviews, new review-producing work is held; all in-flight results are saved even if the count becomes six or more.
- [ ] Request changes uses current gates and becomes Ready when blocked; clearing pressure never auto-starts work.
- [ ] Only the current output can be approved, once; new output/reopen invalidates prior acceptance.
- [ ] Approve/changes/reject/comment retain actor, history, evidence and review-session position.

## Sensitivity

Human approval authority, output-version races, backpressure admission and legacy runtime safety.

## Out of scope

- New automatic result ingestion, agent execution, bulk unseen approval and external notifications.

## Execution record

Not started. No implementation, test execution or acceptance result is claimed.
