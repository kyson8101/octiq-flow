---
title: Personal Command Board
project: octiqos
type: enhancement
status: planned
created: 2026-09-16
work_folder: docs/plans/personal-command-board
l1_spec: docs/plans/personal-command-board/specs/behaviour.feature
---

# Personal Command Board — work overview

## Objective

Make OctiqOS the place where the founder controls what may consume personal
attention across projects, human work and agent work. Capture does not authorize
execution. A person can identify today's important work within ten seconds
without inspecting every project or agent conversation.

## Source and confirmed decisions

Source: the user's 35-section Personal Command Board requirements in this
conversation, followed by "plan and slice into executable cards".
On 2026-09-16 the user answered the scope questions:

1. The default three-task WIP limit applies to the founder's active execution;
   decisions and reviews have separate queues. Delegated concurrency is separate.
2. Five pending reviews is a backpressure threshold: block new review-producing
   work, preserve all in-flight completions, and display temporary overflow.
3. This batch is section 31's MVP plus a small Today view. Weekly Review,
   proactive notifications and new agent-execution integration are later work.

These decisions amend the ambiguous parts of the original requirements.
Other bounded implementation defaults and compatibility rules are explicit in
[the plan](plan.md); they are not represented as additional user approvals.

## Deliverables and navigation

- [Implementation plan and product rules](plan.md)
- [Progress and ordered card index](progress.md)
- [L1 behavior scenarios](specs/behaviour.feature)
- [Requirements coverage](requirements.md)
- [Execution cards](active/); completed cards move to `done/`

The L1 file is a planning contract derived from the supplied requirements and
confirmed answers. Gherkin is documentation here, not an installed test runner.
Each card decides its L2 contract paths and actual Rust/Vitest/browser checks.
Write L2 files while executing the card, not during slicing.

## Execution boundary

This work is planned, not implemented or released. All card checkboxes are open.
Execute one eligible card at a time in number order unless its dependencies and
shared-file risks justify another order. The word `active` in card metadata means
the work queue folder, not that all twelve cards are in progress.

Use the existing React/TypeScript/Vite + Rust/Axum + PostgreSQL monorepo.
Apply the slice skill's capability grouping and traceability, adapted to the
actual Rust/Vitest test layout. There is no Reqnroll, cucumber-vite, .NET,
cross-repo deployment or API regeneration step in this repository.

No automatic code implementation, branch creation, commit, push, release,
service restart, production migration or outside-account access is authorized
by this planning request. A future request to execute a card authorizes its
implementation and local checks, not these separate release actions.
Keep existing tool permissions, agent project scopes and verification gates.

## Completion criteria

All 12 cards must have their acceptance evidence, scoped review and applicable
security review recorded. The full Rust library suite, web suite and web build
must pass, plus the isolated DB concurrency/restart and browser day-flow tests
described in card 12. Do not call a missing or skipped required check a pass.

Before moving a completed card to `done/`, append a dated Closed block with
changed paths, commands/results, acceptance evidence and remaining limitations;
update progress and links. A blocker stays on its card.

## Working-tree baseline

At planning time, these unrelated changes were already present and were not edited:
- `web/src/components/MessageList.glide.test.ts`
- `web/src/components/MessageList.tsx`
- `web/src/components/MobileSidebar.css`

Reinspect git status before execution; do not overwrite, commit or reformat
unrelated work merely to satisfy a card.

