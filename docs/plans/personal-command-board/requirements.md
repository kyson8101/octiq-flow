# Requirements coverage and MVP boundary

Source numbering refers to the user's Personal Command Board requirements.
The user confirmed section 31's MVP plus a small Today view on 2026-09-16.
No row marked deferred is included in the executable MVP queue.

| Requirement | Disposition | Cards / rule |
| --- | --- | --- |
| 1 Product goal | MVP | 02–08; integrated day-flow 12 |
| 2 Core principles / WIP | MVP, clarified | 02–04, 08; human execution cap separate from delegated concurrency |
| 3 Project states | MVP | 03; operational pause/fencing for Parked |
| 4 Task states | MVP | 01, 04, 08–10 |
| 5 Human attention | MVP, clarified | 04–05; current attention separate from reviewRequired |
| 6 Ownership | MVP, brought forward | 01–02; me/human/agent without needing executable registrations |
| 7 Global Command | MVP | 05; default entry after 12 |
| 8 Today | Explicitly included | 06; three primary and two minor, no lifecycle change |
| 9 Kanban | MVP | 09; shared transitions and keyboard/touch alternative |
| 10 Project view | MVP | 03; final Someday content from 10 |
| 11 Project activation | MVP | 03; explicit swap or intentional settings change |
| 12 Task model | MVP, extended | 01–04; nullable Inbox project, blocking metadata, separate execution/review |
| 13 Decision tasks | MVP | 07 |
| 14 Decision Log | MVP | 07, 11; append-only resolutions and superseding entries |
| 15 Agent work | MVP tracking; existing runtime compatibility | 01, 04, 07–08; no new executor or automatic integration |
| 16 Batch review | MVP | 08; per-item explicit outcomes and stale-output checks |
| 17 Execution boundary | Preserved | Tracked mode never starts agents; future adapter seam only |
| 18 Inbox capture | MVP | 02; global shortcut/action; optional quick syntax deferred |
| 19 Someday / Lab | MVP | 10 |
| 20 Focus Guard | MVP | 03–04, 08; show commitments before explicit swap |
| 21 Task promotion | MVP | 04, 10; no priority-based activation |
| 22 Priority vs attention | MVP | 04–05 |
| 23 Search and filters | MVP | 07 initial Decision Log search; 11 unified search/all requested task filters |
| 24 Activity history | MVP from first mutation | Primitive in 01, append in each card, full timeline in 11 |
| 25 Minimal notifications | Quiet behavior now; delivery deferred | 05, 08; no routine completion interruptions, no push/reminder system |
| 26 Weekly Review | Deferred by confirmed scope | No card in this batch |
| 27 UI | MVP | 02–11; Command/sidebar/drawer, desktop/mobile, existing design tokens |
| 28 Suggested technology | Adapted to existing repo | React/TS/Vite + Rust/Axum/PostgreSQL; no stack replacement |
| 29 API shape / backend rules | Capability-equivalent existing transport | Authenticated world commands with atomic domain rules; no duplicate REST surface |
| 30 Settings | MVP relevant settings | 03–04, 08; project/task caps, review threshold and default project; reminder setting deferred with delivery |
| 31 MVP scope | Included | 01–12; no new planner/spawning/DSL/chat/workflow engine |
| 32 Product constraint | Acceptance rule | No feature admitted solely for monitoring/administration; bounded Command |
| 33 Main experience | MVP | 05–08; full day-flow in 12 |
| 34 Success criteria | Release-readiness evidence | Table below; all required before declaring MVP ready |
| 35 Build order | Deliberately adapted | Compatibility first; owner/attention/WIP early, then decisions/review; execution integration remains deferred |

## Ten success criteria

| User criterion | Evidence owner | Observable acceptance |
| --- | --- | --- |
| 1 Capture ideas without acting | 02, 12 | Title-only Inbox, no run or activation |
| 2 See all projects, actively push at most two | 03, 12 | Global project gate and explicit swap, including concurrent requests |
| 3 See what needs personal judgment | 05, 07, 12 | Cross-project structured Decisions queue with no duplicate urgent cards |
| 4 Agents work without constant interruptions | 01, 05, 08, 12 | Existing authorized work continues; tracked work stays independent; routine progress is quiet |
| 5 Agent outputs enter batch review | 08, 12 | Saved versioned results, sequence of explicit review outcomes |
| 6 Decisions remain searchable later | 07, 11, 12 | Dated immutable decisions found after task completion/supersession |
| 7 Know today's work within ten seconds | 05–06, 12 | Bounded screen and recorded manual usability walkthrough; automated checks alone are insufficient |
| 8 Starting forces a conscious pause | 03–04, 08, 12 | Full capacity refuses start and explicit swap records the selected displacement |
| 9 Reduce context switching | 05–09, 12 | Day-flow completed through shared queues/drawer without touring project/agent screens |
| 10 Trust unfinished work is preserved | 01–02, 07–08, 11–12 | Reload/restart/retry preserve ideas, decisions, output, approval and history |

## L1 and L2 traceability

There are 51 tagged L1 scenarios in [behaviour.feature](specs/behaviour.feature).
Each is assigned to exactly one primary card; card 12 also performs integrated
verification of earlier behaviors. L2 contract paths are declared per touched
layer on the cards and are intentionally not created until execution.
Native Rust/Vitest/browser test mappings must accompany those contracts.

## Deferred work, visible by design

Weekly Review; proactive notifications and reminders; optional capture syntax;
new execution adapters/orchestration/result ingestion; docspace synchronization
and cross-store imports. These are not prerequisites for the selected MVP and
must not be silently pulled into an execution card.

