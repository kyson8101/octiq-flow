# Installation-sized browser memory — 2026-11-08

This follow-up starts at `204a63c6eb68c1af9692066cb2c4362efb95bb87`, including the screen-scoped client and its lifecycle repairs. It changes source only: no push, deployment, production client build, live profile change or service restart.

## What changes

- `orchestration_summary` omits archived, closed and stopped runs. It retains candidates named by the page's held-card chat identities; `pendingReading` and `runWaits` remain the readers of who actually waits on the person. Lightweight worker-parent and coordinator identities remain available for read-only worker routing, card ownership and first-paint column placement.
- Visible run panels request historical summaries within their coordinator/project scope. Hiding or changing the panel releases those rows and their detail leases. History can supplement ended rows only; an old history reply cannot restore a formerly active run missing from the current global reading. Manual mission creation remains an explicit choice even when history arrives late.
- The chat list shares one initial reading per connection. `chat-index-changed` carries its canonical changed entry, or a removal and optional Trash row. Initial-reply races replay buffered changes; reconnects discard old replies. Local tombstones, restore generations, unsynced local conversations, pending prompts, deletion animation and `coordinatesRun` placement retain their existing rules.
- A notification that outruns its index event requests one `chat_index_entry`. A newer deletion wins over a late lookup. Older servers retain the coalesced full-list refresh and explicit command-unavailable fallback.
- Global task-report events no longer insert checklists for workers outside the loaded runs. This was the largest additional install-growing object found: an unrelated old worker report could repopulate the global `reports` object indefinitely.

The other inspected stores were smaller or already scoped: usage has two provider readings and one rate-limited poller; chat artifacts come from bounded transcript state; long run notifications are held by visible detail leases. No new artifact or usage cache was added.

## Measurement method

`test-install-memory.mjs` loads production App builds in separate disposable Brave processes at 1280×844 and 390×844. Its synthetic host has 1,500 chat metadata entries (1,798,813 bytes), 12 Active chats, 1,488 Done chats, and 300 archived/closed/stopped runs with 2,400 tasks, attempts and reports (6,710,385 bytes before filtering). Initial reads and subsequent events share one canonical fixture store per browser context.

Each context performs 18 chat switches, then runs for a real 20 minutes with 363 spaced index changes and 363 historical-worker reports. No clock acceleration is used. The large-record comparison separately uses the existing approximately 171.5 MB durable-transcript fixture and its 18 switches.

Received bytes are UTF-8 application JSON frames sent to the mocked WebSocket, including replies and events. They exclude HTTP assets, WebSocket framing, compression and TLS overhead. Heap is CDP `JSHeapUsedSize` after forced GC, in decimal MB; it is not RSS or physical footprint. There is no heap snapshot or duplicate browser-side WebSocket observer. The browser host protocol is mocked; Rust selection and canonical event emission are tested separately.

The [companion JSON](browser-memory-install.json) stores exact counts, artifact hashes and checks. Results are fixture measurements, not live-profile, real-phone, Safari/WebKit, tunnel, production-crash or long-endurance acceptance.

## Results

The 18-switch install table uses the final recovery-guarded artifact. Values include startup and all 18 switches.

| Width | JSON received: before → after | `chat_index_list`: before → after | Forced-GC heap: before → after |
| --- | --- | --- | --- |
| 1280 px | 48.13 → 1.91 MB | 23 → 1 | 21.02 → 12.02 MB |
| 390 px | 51.72 → 1.91 MB | 25 → 1 | 22.61 → 11.93 MB |

For the subsequent 20-minute interval, byte and call counts below exclude startup and switching; heap is measured at the end.

| Width | Interval JSON: before → after | Interval index re-reads | End forced-GC heap: before → after |
| --- | --- | --- | --- |
| 1280 px | 663.41 → 10.23 MB | 363 → 0 | 36.01 → 13.00 MB |
| 390 px | 663.41 → 10.23 MB | 363 → 0 | 35.87 → 12.78 MB |

Interval JSON falls 98.46%. The optimized connection performs one initial index read and no further full-list reads. Both contexts ran for at least 1,201 seconds.

**Artifact boundary:** the 20-minute after artifact predates one final error-path change: retrying an initially failed index read when the next canonical event arrives. That branch is not entered by the performance scene. Its hash is separate from the final artifact in the JSON. The final artifact passes the 18-switch confirmation, the new failure/retry regression and the full suite; a final-SHA 20-minute acceptance is not claimed.

The separate 171.5 MB transcript scene uses the final artifact and complete reply/event byte accounting. The base already includes the earlier transcript-memory fix.

| Width | JSON received: before → after | Index calls | Forced-GC heap after 18 switches |
| --- | --- | --- | --- |
| 1280 px | 9.403 → 9.403 MB | 1 → 1 | 12.38 → 11.97 MB |
| 390 px | 9.403 → 9.403 MB | 1 → 1 | 11.78 → 11.79 MB |

## Guards and validation

The final validation passes TypeScript, 339 Vitest files / 4,653 tests, and four focused Rust summary/index tests (one opt-in capture measurement is ignored), plus the single-wait-reader scans and surface matrix, restored-park tests, pending prompt/Restore browser cases on modern and legacy protocols, automatic/manual all-archived history lifecycles, and actual historical-only cold-open geometry.

The historical-only cold-open keeps the composer width unchanged: 640 px at 1280 and 390 px at 390. Desktop CLS is 0.00118 before versus 0.00106 after. Phone-width CLS is 0.074425 on both builds: the existing workflow-header arrival remains. The ordinary composer-fit harness passes. The older top-chrome harness fails while reading a missing action-bar rectangle; that run is not counted as a pass.

## Limits and non-green attempts

- Two initial controls with all 1,500 chats in Active became unresponsive before completing the navigation scene. The final reproducible scene uses the Active/Done distribution above. It does not establish responsiveness with 1,500 simultaneously Active rows.
- The large-record harness's additional Return-to-latest paging phase times out on both the final client and the unchanged `204a63c` control. The requested 18-switch measurements complete separately; this work does not claim a passing end-to-end paging acceptance. The default paging assertions remain enabled; `SCREEN_SKIP_PAGING=1` selects the measurement-only scene.
- Provisional after scenes were stopped when guards changed, and are excluded from final comparisons. Interim type/SSR checks caught an import-alias error and automatic empty-state creation behavior; these were corrected before final verification. The Rust event test initially used permanent removal to test Trash; it now uses the actual Trash transition.
- Several detached job wrappers reported completion-hook timeouts after their child finished. Child results, logs and job receipts are recorded independently. The host issue was reported as feedback `243db2ee-f29c-4c2e-8e99-801644e7255a`.

## Reproduce

Build the control from `204a63c` and the candidate into isolated output folders; never use the live `web/dist`. With `PLAYWRIGHT_MODULE` and `PLAYWRIGHT_EXECUTABLE_PATH` pointing to installed tools:

```sh
SCREEN_CONTROL_DIST=/isolated/control INSTALL_VARIANTS=before INSTALL_RESULT=/tmp/before.json node web/scripts/test-install-memory.mjs
OCTIQ_TEST_DIST=/isolated/candidate INSTALL_VARIANTS=after INSTALL_RESULT=/tmp/after.json node web/scripts/test-install-memory.mjs
OCTIQ_TEST_DIST=/isolated/candidate SCREEN_SKIP_PAGING=1 node web/scripts/test-screen-memory.mjs
OCTIQ_TEST_DIST=/isolated/candidate INSTALL_VARIANTS=after INSTALL_SWITCHES_ONLY=1 node web/scripts/test-install-memory.mjs
OCTIQ_TEST_DIST=/isolated/candidate node web/scripts/test-history-layout.mjs
node web/scripts/test-run-history.mjs
```

The before/after install jobs may run concurrently; each creates isolated browser contexts and closes its preview server. `INSTALL_MINUTES` and `SCREEN_WIDTHS` are diagnostic controls; the recorded install comparison uses the default 20 minutes and both widths.
