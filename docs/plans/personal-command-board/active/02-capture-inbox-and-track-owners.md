---
title: "02 Capture title-only Inbox ideas and track human or agent owners"
order: 2
created: 2026-09-16
status: active
execution_status: not-started
project: octiqos
layers: both
category: implementation
sensitivity: sensitive
depends_on: ["01"]
---

# 02 — Capture title-only Inbox ideas and track human or agent owners

## Capability

Capture an idea in seconds without a project, workspace or agent setup; store and edit it as tracked Inbox work with durable ownership.

## Prerequisites and execution contract

Complete cards 01.
Read [overview](../_overview.md) and [plan](../plan.md) before implementation.
Inspect current git status and preserve unrelated changes. This is a monorepo:
no BE deployment, API regeneration, per-card commit, release or live restart.
Append a Closed block and move to done only after required checks pass.

## Scope

- Add title-only capture, server-owned defaults and optional default-project fallback. Unfiled Inbox items belong to the founder's world; a later project association supplies the org.
- Support me/human/agent ownership with a required name and optional stable ID. Plain named agents are tracking labels, not executable worker registrations.
- Build Inbox list and reusable detail drawer with description/outcome, notes, tags, priority, due date and ownership; all new work remains Inbox until deliberate promotion exists.
- Add a global New task action and keyboard shortcut with typing/IME conflict protection; on narrow screens use the same accessible action.
- Record creation and edits from the beginning; retry a capture with the same request identity after uncertain network failure.

## Code entry points

Existing unless explicitly marked new; inspect before editing. Native test paths
below are planned new files and must be registered in the existing harness.

- `src-tauri/src/world/model.rs`
- `src-tauri/src/world/mod.rs`
- `web/src/os/world/WorldPortal.tsx`
- `web/src/os/world/Forms.tsx`
- `web/src/os/world/types.ts`

## L1 covered

- `PCB-004` — Capture an idea with only a title
- `PCB-005` — Captured ideas survive return and retry
- `PCB-006` — Track work without a configured agent or workspace

## L2 spec files — decided here, written during execution

- BE: `docs/plans/personal-command-board/specs/l2/backend/02-capture-inbox-and-track-owners.feature`
- FE: `docs/plans/personal-command-board/specs/l2/frontend/02-capture-inbox-and-track-owners.feature`

No .feature runner is installed. These contracts must map to executable tests:
- Rust: `src-tauri/src/world/command_capture_tests.rs` (register as a `#[cfg(test)]` module).
- Vitest: `web/src/os/world/Inbox.test.tsx`.
- Browser: `scripts/test-command-board.mjs`; reuse existing synthetic/in-memory patterns.

## Sequence

- [ ] BE spec: write the L2 contract and map each scenario to named native Rust tests; add meaningful failing coverage before the behavior change.
- [ ] BE work: add tracked capture/edit commands with explicit field validation, title limits, default owner and attention none; reject lifecycle/run/approval changes via metadata patches.
- [ ] BE tests: capture without projects/orgs/workers/folders, invalid title, stale default project, duplicate request and unauthorized registered-agent references.
- [ ] BE code review: inspect all changed domain/transaction paths and resolve in-scope defects.
- [ ] BE security review (`/security-review`, scoped to this Rust work): Unfiled-world ownership, content validation and activity/notes storage.
- [ ] FE spec: write the L2 contract and map each scenario to Vitest/browser checks; use behavioral interactions where static markup cannot prove the outcome.
- [ ] FE work: add Inbox, title-first capture and shared task drawer; maintain the draft on failure and focus the title control on open.
- [ ] FE tests: keyboard/IME behavior, mobile capture, save failure/retry and editing a named owner without any provider or folder setup.
- [ ] FE code review: check failed/stale actions, truthful statuses, empty states, accessibility and responsive behavior.
- [ ] FE security review (`/security-review`, scoped): check content rendering, IDs, visible authority and server-side validation expectations.

- [ ] Verification: run this card's targeted checks plus the applicable project-wide Rust/web checks in plan.md; build web into a unique temporary directory. Record exact commands/results; missing required checks remain blockers.
- [ ] Acceptance: demonstrate every criterion below and update progress. Append dated Closed evidence, then move this card into done; do not commit or release.

## Acceptance

- [ ] Title is the only initial input required; the task is saved as Inbox, owned by me, attention none, with no activation or run.
- [ ] Capture and subsequent edits survive reload; an uncertain retried request produces one task.
- [ ] Named humans/agents can own tracked work without new accounts, providers or filesystem bindings.
- [ ] Editing task text does not dispatch work or bypass lifecycle fields.

## Sensitivity

Unfiled-world ownership, content validation and activity/notes storage.

## Out of scope

- Quick syntax parsing.
- Ready/Active transition UI (04), Today (06) and executable agent registration.

## Execution record

Not started. No implementation, test execution or acceptance result is claimed.

