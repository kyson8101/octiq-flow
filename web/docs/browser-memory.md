# Browser memory retention (2026-11-07)

## Finding

The tab retained old App renders. In V8, closures created during one render share a lexical context. App's mutually referencing memoized callbacks had different dependency lifetimes; a current callback could keep an earlier callback, its entire render context, and that render's ledger/transcripts alive. A fresh idle tab did not exercise the navigation/dependency changes that build this chain.

The live heap after ten recent/large chat selections showed old ledger objects retained through App contexts and callbacks, including `loadCodexSkills`. At the mid-soak GC snapshot, the union of reachable ledger data was 126,255,024 bytes across nine distinct run arrays; V8 self-size excluding native nodes was 166,880,401 bytes. These are unions, not a sum of overlapping snapshot views.

A controlled real-browser regression alternates two callback dependency lifetimes for 101 renders. Both Chrome and disposable Brave retain 101 ledger objects with React's native `useCallback`, versus two with the fix, after GC. The check also covers identity changes, old callback handles seeing the latest committed body, child layout effects, and an abandoned Suspense render.

## Changes

- App event/subscription callbacks use an isolated committed cell. Old function handles no longer own old App scopes. Dependency changes still replace the handle and re-run subscribing effects. Pure render-time readers are constructed outside App so they see the current render without retaining its scope.
- (Superseded 2026-11-12, see the end of this file: every opened chat now keeps its window under a 256 MiB safety budget.) Originally only the main and beside transcripts stayed loaded in RAM. Other durable chats become three text previews of at most 420 characters each, retaining status/session facts. Unacknowledged prompts and local-only/imported words are protected. Returning to a released chat replays the durable record; previews never become full checkpoints.
- In the initial retention fix, the 12-entry `chatCache` limit applied to IndexedDB storage, not App's live state. The screen-scoped integration below replaces that count cap with a byte budget. The previous-checkpoint marker uses weak keys. Sidebar transcript copies are released with the loaded chat. Short snippets detach their string backing storage.
- `ChatHistory` holds cursors and page provenance (ids/counts), with no raw transcript or message bodies. **Load earlier messages** reduces the incoming page and shares the already reduced window. See [the phone paging follow-up](load-earlier.md) for bounded work, scroll anchoring and validation.
- Finished-run detail text is leased by mounted panels. Closing the last panel releases both the text cache and its injected snapshot fields; a closed panel's late response cannot repopulate the cache.

## Verification

- `tsc --noEmit` and isolated production build: pass.
- Full Vitest: 332 files / 4,437 tests passed (2 workers, 15-second test timeout).
- Real App browser checks cover many chat switches, background tool streams, bounded preview state, weak checkpoint markers, cursor-only history, reopening, older history and split transcripts.
- Production-client live measurements use separate scratch browser profiles and the same ten recent/large chat IDs. The base control loads exact source from `eea5655c33e345cfcac6e7a4cffd83f20c59c2f6`; the worktree was never switched. Tokens are read in-process and never logged. Footprint peaks are read before heap snapshots, since snapshots inflate them.

| Instrumented run | Nominal soak | Final footprint | Peak before snapshots | GC V8 self-size | Ledger data union | Distinct run arrays | Raw history windows |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| Exact base `eea5655c` | 20 min | 394 MB | 846 MB | 196.0 MB | 154.9 MB | 11 | 8 |
| Fixed client | 25 min | 305 MB | 711 MB | 71.6 MB | 42.7 MB | 3 | 0 |

GC V8 self-size fell 63.5%; reachable ledger data fell 72.5%. Footprint values use the tool's MB labels; heap figures use decimal MB from snapshot self-sizes, excluding native nodes. The fixed run received 1,067.2 million ledger JSON characters versus 980.7 million for the base control. Wire-byte counts were not measured.

A separate live-client baseline without snapshots ran 20 minutes: final footprint 547 MB, peak 1,003 MB. The original live 25-minute run with interval snapshots ended at 170.9 MB GC V8 self-size, 126.3 MB ledger data, nine run arrays and eight raw history windows; its snapshot-inflated peak is deliberately excluded.

These are workload observations, not a controlled production memory ceiling: the same ten chat IDs were selected, then a live chat available at each run's start; active chat/agent traffic differed. The observer also parses each WebSocket frame once in addition to the client, which can inflate transient peaks. Traffic counters labelled `bytes` in raw probe output are UTF-16 string lengths, not wire bytes. The soak bundle contains all memory-lifetime changes; final source additionally skips unchanged background reductions to avoid redundant preview clones/renders.

Chrome binary: `155.0.8059.85`. Disposable Brave bundle version: `156.1.98.60`. Final Brave production-App regression: 30 desktop / 8 narrow-layout chat selections, 20 background streams per layout, full IndexedDB checkpoint/sidebar-copy release and restore, older-history replay, exactly two split transcripts, zero page errors. Temporary browser profiles and all heap snapshots were deleted after analysis; only sanitized counts/logs remain in `/tmp/octiq-oom-evidence`.


## Reproduce the regressions

An installed Chromium/Brave and a Playwright module are required; Playwright is not added to web dependencies.

```sh
PLAYWRIGHT_MODULE=/absolute/path/to/playwright/index.mjs node web/scripts/test-callback-retention.mjs
PLAYWRIGHT_MODULE=/absolute/path/to/playwright/index.mjs node web/scripts/test-chat-retention.mjs
```

`PLAYWRIGHT_EXECUTABLE_PATH` selects a disposable Brave process. `OCTIQ_TEST_DIST` optionally points the real-App harness at an isolated production build. Without it, the harness starts its own Vite server and optimizer cache. The real-App harness mocks every command socket, so it never starts agents or changes live records.

## Initial retention fix: limits

The measurements above belong to `6f93e7d`. That fix alone still received the legacy brief ledger and global chat streams, and explicit older-history reads could download an unbounded raw tail. The integration below supersedes those limits. The original multi-GB crash itself was not reproduced; neither stage establishes real-phone, Safari/WebKit, tunnel, or 18-hour stability.

## Screen-scoped client integration (2026-11-07)

The client now opts into the server contract in `docs/browser-event-subscriptions.md`:

- `chat_subscribe` is every socket's first invoke. Pane changes replace the set derived from `chatShown` and `besideShown`; catch-up waits for the latest acknowledgement. Reconnect reuses the current selection. Covered, narrow-layout and closed chats release their transcripts/cursors, retaining small status/clock facts and local unacknowledged input. Reopening reads the window again.
- Unopened chats use global compact activity for host running/busy facts and the existing restored-park work signal. Activity sequences never advance transcript cursors, and activity timestamps never reorder sidebar rows. Cards, completion and jobs remain global. Background completion preserves the index preview and does not save a fabricated empty transcript/preview.
- Whole-app readers share `orchestration_summary`. Structural changes replace one run's summary; compact execution/report events patch only summary-sized facts. Changes during a read schedule a follow-up. Full detail is leased separately by the visible run panel, its inline plan review and the strip's own run, then refetched on that run's change. Hidden mounted subtrees release their leases. Detail evidence uses current summary status/wait facts, through `runWaits`; it cannot resurrect a cleared gate.
- IndexedDB checkpoints use a conservative UTF-16/object-size budget: 16 MiB total and 8 MiB per checkpoint (raised to 128 MiB / 32 MiB on 2026-11-12). A small metadata store drives eviction without materialising all transcript rows. The old count-capped v1 cache is invalidated on upgrade without loading its large rows; durable server records are untouched. The optional cache remains separate from drafts and live local/imported input.
- Recent records use `chat_page`. A long gap after a checkpoint resets to a recent page rather than downloading the entire missing `chat_since` tail. Earlier reads prepend reduced pages, targeting 8 MiB and at most 12 pages; on reaching the window limit, they drop whole pages from the newest end and offer **Return to latest messages**. A past window is never saved as a whole checkpoint. Live status/clock facts stay current while its historical messages remain still.
- The server preserves an indivisible turn. One such turn can exceed the 256 KiB page target. The client keeps the incoming page and its adjacent visible page to preserve the scroll anchor even if those two pages exceed the window target. This is not a strict cap on oversized tool results, a full visible run's detail, or local-only/imported words.
- Explicit `not available on this backend` replies keep the legacy subscription/brief-snapshot path. Network/profile errors keep the last reading and surface the error; they do not silently switch to an empty ledger or a full transcript download.

### Reproduced memory growth and final-source measurements

`web/scripts/test-screen-memory.mjs` runs the real production App in a disposable Brave process with fixture command sockets. Both clients receive the same recorded real ledger and the same synthetic ~171.5 MB (163.6 MiB) durable transcript, 18 chat switches, eight unopened tool streams per switch, and identical run invalidations. The old v1 cache contains a valid 600-turn prefix below Chromium's per-value limit; the old client downloads the remaining 444-turn tail. The new client invalidates that optional cache and fetches three recent turns. No real agent, token or profile is used by the browser harness.

The control build loads exact `eea5655c33e345cfcac6e7a4cffd83f20c59c2f6` client source. Heap values below are decimal MB of CDP `JSHeapUsedSize` after forced GC, not RSS/physical footprint or a production ceiling. No heap snapshot or duplicate client-side WebSocket observer is used. Timing can alter the number of coalesced summary reads; the navigation/actions and synthetic event counts are fixed.

| Viewport | Open record: before → after | After 18 switches: before → after | Older window after |
| --- | ---: | ---: | ---: |
| 1280px | 207.98 → 13.40 MB | 477.02 → 18.94 MB | 27.15 MB; returned to latest |
| 390px | 207.61 → 13.34 MB | 462.91 → 18.83 MB | 27.07 MB; returned to latest |

All four cases have zero page errors. The after cases receive zero heavy background `chat-event` frames versus 432 before, and 144 compact activity frames. The client never issues a whole-ledger `orchestration_snapshot` or `chat_since` in the after workload. Initial real payloads are 30,996,850 B full, 13,184,305 B legacy brief and 3,891,296 B summary. Per-run invalidation reduces repeated ledger traffic further. Sanitized counters and fixture hashes are in `browser-memory-scoped.json`.

### Verification and reproduction

- Full Vitest: 335 files / 4,555 tests passed. `tsc -b`, isolated production build and `git diff --check` pass. The build retains the existing large-chunk warning.
- `runWaits.surfaces`, `finishedWell.surfaces`, wiring, restored-park, question placement, cache/window, subscription/reconnect and detail-in-flight tests pass. `capture-summary-fixtures.mjs` projects the existing host fixtures through the actual Rust `summary::project`; the status tables use their existing handwritten expectations for both transport shapes.
- Disposable Brave real-App checks cover 30 desktop and 30 phone-width chat selections, compact background activity, true two-pane geometry, Settings coverage/reopen, earlier history and legacy fallback. A final production-client pass additionally checks per-run detail invalidation/release and every reconnect's first invoke. The wider two-pane fixture uses 2200px: at 1280px the run column leaves only one transcript on screen.
- `test-composer-fit.mjs` passes in installed Chrome, including 1280/390/320 layouts, action-bar controls and the run/git columns. Its mock now explicitly rejects unavailable capabilities and supplies the existing provider-fallback choice list. The missing bundled Playwright browser and stale null choice fixture encountered initially were harness issues, not a production client failure.
- The callback GC regression still retains 101 historical contexts before versus two after in disposable Brave.

```sh
PLAYWRIGHT_MODULE=/absolute/path/to/playwright/index.mjs \
PLAYWRIGHT_EXECUTABLE_PATH=/absolute/path/to/Brave \
OCTIQ_TEST_DIST=/absolute/path/to/isolated/client/dist \
node web/scripts/test-chat-retention.mjs

# LEGACY_BACKEND=1 exercises explicit capability fallback.
# SCREEN_CONTROL_DIST adds an isolated exact-base control. SCREEN_LEDGER_DIR
# contains read-only full.json, brief.json and Rust-projected summary.json.
PLAYWRIGHT_MODULE=/absolute/path/to/playwright/index.mjs \
PLAYWRIGHT_EXECUTABLE_PATH=/absolute/path/to/Brave \
OCTIQ_TEST_DIST=/absolute/path/to/isolated/client/dist \
SCREEN_LEDGER_DIR=/absolute/path/to/private/captured-fixtures \
node web/scripts/test-screen-memory.mjs
```

No production restart/deployment, real phone, Safari/WebKit or tunnel/endurance acceptance was performed. No 3 GB crash-free ceiling is claimed. Disposable browsers and scratch servers are closed after each run; captured private ledger payloads are not committed.

## Review lifecycle repairs (2026-11-08)

The independent review of `f507888` found three lifecycle regressions. This follow-up keeps the screen subscriptions, cache budgets and callback isolation, and repairs:

- **H1:** reopening seeds a sidebar/IndexedDB copy around the complete unconfirmed local messages, including attachments, delivery/queue feedback and failed messages that can still be restored. Empty or stale sidebar rows cannot acknowledge them. Replay reconciles identified delivery, pickup and cancellation facts; an unrelated historical echo of the same words cannot consume a new local prompt during a fresh replay.
- **H2:** invalidation immediately withdraws leased detail. A response invalidated while in flight is discarded and followed by another read. A summary-mode surface is ready only when its per-run token and plan revision match the detail. Until then the plan shows Reading (or its read error) and has no Approve action. The revision exposure clock starts when matching detail can actually be drawn.
- **M1:** detail fills an explicit list of omitted evidence/text fields from `orchestration/summary.rs`. State comes from the summary, including absent task failure/reopen/retry flags, nested execution fields, gate ownership and native-decision fields.

The regression-only commit `eff3262` was replayed in a host-created validation workspace on exact `f5078885586c243ac116f476c33fd54eec468fd4`: five regression cases failed as expected. The validation workspace was removed afterward. Final Vitest passes 335 files / 4,567 tests; `tsc -b`, isolated production build and diff checks pass. The build still reports its existing large-chunk warning. The disposable Brave callback GC check still measures 101 retained contexts with native callbacks versus two with the committed-cell implementation.

`test-pending-retention.mjs` and `test-plan-detail.mjs` preserve the independent review probes' held-RPC scenarios and assert the repaired behavior at 1280px and 390px. The pending probe checks retained local words, completed durable replay, queue controls, and returning the message to the composer without resending. It waits for the relevant visible prompt rather than requiring an older answer in the virtualized window. The plan probe withholds revision 2 detail after its summary arrives: the old brief and Approve disappear; only matching new detail enables an approval that submits revision 2. Unit tests also cover detail-first delivery, in-flight invalidation, failed refetch, attachments, host cancellation/pickup, and summary field removal.

```sh
PLAYWRIGHT_MODULE=/absolute/path/to/playwright/index.mjs \
PLAYWRIGHT_EXECUTABLE_PATH=/absolute/path/to/Brave \
OCTIQ_TEST_DIST=/absolute/path/to/isolated/client/dist \
node web/scripts/test-pending-retention.mjs

# Starts its own isolated Vite scene with the real PlanReview and feed.
PLAYWRIGHT_MODULE=/absolute/path/to/playwright/index.mjs \
PLAYWRIGHT_EXECUTABLE_PATH=/absolute/path/to/Brave \
node web/scripts/test-plan-detail.mjs
```

Final production-App regressions also pass modern 30 + 30 selections and legacy 8 + 8 selections at 1280px/390px, including background activity, reopening/earlier history, split panes, covered-surface release and reconnect. Every case reports zero page errors. Sanitized results and source hashes are in `browser-memory-review.json`; raw follow-up logs remain under `/tmp/octiq-review-f507888/`.

## Confirmed echo identity repair (H1-b, 2026-11-08)

The re-review of `49ad96e` exposed the confirmed side of H1: a Claude echo received while the chat was released had a native uuid different from the browser turn id. Cold replay dropped its `octiq_user_turn_id`, so the retained local prompt could not join it. Both copies were drawn, and the local one remained eligible for permanent unconfirmed-message retention.

Cold Claude replay now keeps the host-stamped turn id and dispatched receipt. Local reconciliation uses that identity (including source-id aliases), preserves the prompt's UI id and attachments, and clears stale delivery/queue actions and errors. The confirmed entry stays at its durable transcript position. Later history rebuilds preserve its attachments while it remains in the window; moving it outside the window or releasing the chat can drop it. Equal words with different ids stay separate. An absent queue entry still supplies no provider acknowledgement.

`chat.confirmedEcho.test.ts` covers cold replay, release/reopen, checkpoint prefixes and confirmed checkpoints, history context, Load earlier, buffered live echoes, repeated wording with different ids, aliases, stale unstamped previews, attachment preservation and release. It also replays the existing verbatim `command-echo.jsonl` capture with the stamp `agent_chat::stamp_user_turn_id` adds in production; the capture itself is unchanged. The regression-only commit `465e936` fails eight of its thirteen cases on `49ad96e`, both in the task tree before the fix and in a host-created exact-base validation workspace.

```sh
PLAYWRIGHT_MODULE=/absolute/path/to/playwright/index.mjs \
PLAYWRIGHT_EXECUTABLE_PATH=/absolute/path/to/Brave \
OCTIQ_TEST_DIST=/absolute/path/to/isolated/client/dist \
node web/scripts/test-confirmed-echo-retention.mjs
```

The browser harness derives from the independent review probe and exercises both ordinary and `isReplay: true, parent_tool_use_id: null` envelopes at 1280px and 390px. It checks one visible confirmed copy after reopen and Load earlier, no Restore action, no resend and no retained local copy after release. The reviewer's ten-prompt growth probe reports zero retained locals on every iteration (`[]` serializes to two bytes), replacing its previous 1-to-10 / approximately 2 MB accumulation. These are retained-content measurements, not a heap or RSS ceiling.

Final verification passes 336 Vitest files / 4,584 tests, 43 targeted lifecycle cases, `tsc -b`, an isolated production build and `git diff --check`. The build retains its existing large-chunk warning. Disposable production Brave passes all four confirmed-echo cases on both modern and legacy backends, the original reviewer's two-width echo probe, the two-width pending/take-back probe, modern 30 + 30 and legacy 8 + 8 chat regressions. The original plan probe and expanded summary/detail/in-flight/refetch matrix pass at both widths; callback GC remains 101 → 2. Sanitized counters and source hashes are in `browser-memory-confirmed-echo.json`; raw evidence is under `/tmp/octiq-h1b-fix/`.

This verifies fixture behavior in disposable Brave, including a 390px viewport. Real phone, Safari/WebKit, tunnel and endurance acceptance remain untested. No production restart or deployment was performed.

These are fixture/browser lifecycle checks, not a new production memory ceiling or real-phone, Safari/WebKit, tunnel or endurance acceptance. No production deployment or restart is part of this repair.

## Historical unstamped echo repair (H1-c, 2026-11-08)

The independent review of `f70f90e` found a pre-existing confirmation error, also reproduced on `eea5655`: a checkpoint seed already containing a new local prompt let an unrelated old unstamped Claude echo claim that prompt by equal words. The false acknowledgement removed Restore and allowed release to discard local-only words and attachments. Cold replay from zero happened to avoid that seed, so cold-only tests missed the error.

`replayChat` and imported session replay now pass explicit historical provenance to the reducer. An unstamped historical echo becomes its own durable message; equal words cannot acknowledge a local prompt. This covers checkpoint tails (including empty prefixes and checkpoints containing the local prompt), page context, Load earlier and catch-up. The CLI's `isReplay` flag does not decide provenance: both ordinary and `isReplay: true, parent_tool_use_id: null` envelopes can arrive through either transport. Stamped echoes still reconcile by host identity, including unknown/failed local prompts, aliases and attachments.

Older hosts retain a narrow live fallback: the chat must be busy, with exactly one unacknowledged dispatch candidate (`sending` or `dispatched`; or an old local message with neither turn id nor delivery field). Already echoed or picked-up messages and lost queue entries are excluded. Only that candidate can match equal words or the existing slash-command namespace equivalence. Queued, unknown, failed, idle or ambiguous concurrent sends supply no such acknowledgement. Buffered live events beyond a replay's tail retain this rule; an overlapping event already folded historically cannot use it a second time.

`chat.unstampedEcho.test.ts` covers both envelopes, the replay/seed matrix, complete recovery metadata, scoped release, the live fallback and its negative cases, buffered overlap, and later identified echo/pickup/cancel evidence. Regression-only commit `822fa2d` fails 18 of 30 cases on exact `f70f90e`, independently repeated in a host-created validation workspace. Ten further cases protect buffered overlap and previously picked-up prompts. The existing Load earlier confirmation fixture now carries the real host stamp rather than treating an unstamped historical echo as acknowledgement. Final checks pass 337 Vitest files / 4,624 tests, 185 targeted tests, `tsc -b`, isolated production build and diff checks; the existing large-chunk warning remains.

`test-unstamped-echo-retention.mjs` preserves the reviewer's production-App scenario and asserts the repaired outcome at 1280px/390px with both envelopes: two visible messages, the new prompt still local with Restore, one retained local after release, and actual Restore without resend. It supports the same modern/legacy fixture switch as the confirmed-echo harness.

Final production Brave passes all eight modern/legacy unstamped cases and all eight confirmed-echo cases. The original reviewer growth probe passes all 40 iterations with zero retained locals and two serialized background-message bytes; the independent module matrix passes all 12 stamped lifecycles and both envelopes of the empty/cached-local prefix cases. Pending/take-back, the plan detail/order/in-flight/refetch matrix, callback GC (101 → 2), modern 30 + 30 and legacy 8 + 8 selections also pass. A first growth run under concurrent validation load read before its echo was visible at a fixed 200ms; a 1500ms timing control and the final serial original 200ms probe both passed all 40 iterations without changing product code or assertions. The initial failure remains in the raw evidence.

```sh
PLAYWRIGHT_MODULE=/absolute/path/to/playwright/index.mjs \
PLAYWRIGHT_EXECUTABLE_PATH=/absolute/path/to/Brave \
OCTIQ_TEST_DIST=/absolute/path/to/isolated/client/dist \
node web/scripts/test-unstamped-echo-retention.mjs
```

Sanitized results and source hashes are recorded in `browser-memory-unstamped-echo.json`; raw evidence is under `/tmp/octiq-h1c-fix/`. These checks use disposable desktop Brave, including a 390px viewport. Real phone, Safari/WebKit, tunnel, endurance and a new RSS/heap ceiling remain untested. No push, deployment or restart is part of this repair; feedback `9c3b3024` remains for the independent review to settle.


## Legacy live echo queue-order repair (H1-d, 2026-11-08)

The review of `106dfe3` found that a successful older-host send was confirmed only when its unstamped live echo beat the RPC response. App's post-send `syncQueue` changed the optimistic `sending` prompt to `unknown` when the persistent process was live but its queue was empty. The H1-c live filter then excluded that same prompt. This left two bubbles, Restore and retained local content even after the provider acknowledged it.

Queue reconciliation now preserves that transition's provenance in `queueUnconfirmedSend`. Delivery remains `unknown`, with the original words, attachments and Restore, until actual acknowledgement. The existing unique, busy, live-only fallback includes this specific queue-demoted candidate. Other unknown prompts remain excluded. A known queue entry, a non-live queue snapshot or a send failure removes eligibility; echoed, picked-up and lost prompts remain excluded. Two concurrent candidates still cannot be matched by words. No timer or delayed matching was added.

This preserves H1-c's historical boundary instead of treating RPC success or queue absence as a provider acknowledgement. Checkpoint tails, page context, Load earlier, catch-up and buffered overlap remain historical even when the prompt carries this provenance. Host-stamped reconciliation remains identity-based.

Regression-only commit `5d8acb7` fails six of 52 unstamped-echo cases on exact `106dfe3` in a host-created validation checkout: both envelopes of RPC-before-echo, buffered live after queue sync and retained-content growth. The production-App regression also fails on the reviewer's exact `106dfe3` build after RPC success. `test-legacy-live-echo-retention.mjs` preserves that older-host contract (no `chat_page` or subscription capability; working `chat_since` and `chat_queue_state`) and both RPC/echo orders. The strict after-RPC case observes the actual `unknown` queue demotion before emitting the echo; the separate original reviewer contract probe keeps its 100ms interval unchanged. It asserts both RPC/echo orders at 1280px and 390px with ordinary and `isReplay` envelopes, including the actual post-RPC `unknown` state before the live echo.

The independent actual-module legacy control reproduces ten 200KB sends retaining one to ten locals (2,002,111 serialized bytes at ten) on `106dfe3`, for both envelopes. With this repair, every iteration retains zero locals and two serialized bytes. The independent historical matrix passes 40 cases: the previous 30 plus ten queue-demoted unknown cases across all five replay paths. Stamped lifecycles (12), legacy guards (16) and stamped growth (ten) also pass.

```sh
PLAYWRIGHT_MODULE=/absolute/path/to/playwright/index.mjs \
PLAYWRIGHT_EXECUTABLE_PATH=/absolute/path/to/Brave \
OCTIQ_TEST_DIST=/absolute/path/to/isolated/client/dist \
node web/scripts/test-legacy-live-echo-retention.mjs
```

Final validation of the exact `f1c56cc` implementation tree passes 337 Vitest files / 4,636 tests, 96 targeted tests, `tsc -b`, isolated production build and diff checks. The build retains its existing large-chunk warning. A first two-worker full-suite run reported timeouts in unchanged `turnClock.unread` and `diskTreemap` cases and was stopped with exit 143; the complete isolated single-worker run passes all cases with unchanged assertions and timeouts. The original logs remain available.

Disposable production Brave passes all eight strict legacy-live cases and all eight original reviewer contract cases, H1-c modern/legacy eight cases, H1-b modern/legacy eight cases, pending/take-back at both widths, the plan order/exposure/in-flight/refetch matrix, callback GC (101 → 2), modern 30 + 30 and legacy 8 + 8 chat regressions. Harness-only commit `44f106a` replaced the strict probe's assumed 100ms queue demotion with observation of the real state. Its first run failed that precondition while the prompt still read `sending`; all confirmation/release assertions had passed. The original 100ms reviewer probe is unchanged and passes. The corrected strict harness also fails as expected on the exact `106dfe3` production build.

The original fixed-200ms stamped growth probe does **not** pass in this environment: two fix runs read an echo before it arrived (iterations four and one); an unchanged `106dfe3` production control fails the same way on iteration one. No further fix rerun or product delay was added. The independent reviewer's existing convergence probe passes all 40 sends on each version, with one confirmed copy, zero retained locals and two serialized background-message bytes at every release. Observed acknowledgement latency is baseline median 348.91 / max 922.26ms versus fix median 235.75 / max 556.36ms; these are fixture observations, not a speed claim or a 200ms guarantee. Sanitized results, source hashes and every non-green attempt are recorded in `browser-memory-legacy-live-echo.json`.

Raw evidence is under `/tmp/octiq-h1d-fix/`. These are disposable desktop Brave and module checks, including a 390px viewport; real phone, Safari/WebKit, tunnel, endurance and a new RSS/heap ceiling remain untested. No push, deployment or restart is part of this repair.

## Installation-sized follow-up (2026-11-08)

[Historical runs, index deltas and reports](browser-memory-install.md) records the 20-minute and 18-switch measurements, compatibility guards, artifact hashes and validation limits for the next memory reduction.

## Keep everything on a chat switch (2026-11-12)

The person reported waiting, missing chat content and lost reading place on every
switch. The six-window / 48 MiB cap made returning to any chat older than the
sixth reload from the host (and reload could restore only two chats from a 16 MiB
IndexedDB). Policy now, with the details in [`docs/chat-window-retention.md`](../../docs/chat-window-retention.md):

- Every opened chat keeps its window; **256 MiB per tab** (the `valueBytes` estimate of
  retained reducer values, lowered from 512 MiB after the independent review) is only a
  safety budget, oldest first, never a window with an unechoed local prompt (the one
  exception). **It does not bound process memory**: the review measured 22 MiB running
  turns at the 512 MiB estimate at 336-359 MiB GC heap and 1.6-2.1 GiB renderer
  footprint per tab (7.25-7.40 GiB across four tabs). The leak fixes
  above (isolated callback cells, no retained App renders) are untouched, and
  offscreen windows still receive no deltas (zero folds / renders in four tabs).
- Reading state (disclosures, tabs) lives exactly as long as its window; scroll places
  keep 500 chats.
- Sidebar line and hover preview never use a window that is behind the host.
- IndexedDB checkpoints: 128 MiB / 32 MiB each, quota failure shrinks and retries.
- Heap: 8 chats retained = 38.1 MiB at 1280px (was 33.4 MiB with two), so retention costs about
  the estimated window size once, not more.
