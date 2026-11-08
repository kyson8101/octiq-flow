# Load earlier on phone

This follow-up builds on `f70f90e`. It changes only the web client; it does not change the server's whole-turn page contract or the separate legacy no-stamp echo limitation (H1-c).

## Behavior

- Both the local `TURN_BATCH` reveal and server-page prepend wait until the finger is up, scroll events have been quiet for 120 ms, and two animation frames are quiet. A delivered button click can commit immediately unless scrolling continues after that press. The download runs during the gesture. The final anchor is measured immediately before publication.
- The server's new messages and the visible turn window render in one commit. A scroll event can update the pending anchor only while the old first turn is still drawn. Programmatic correction events do not become reading input. A six-second resize hold covers late media/font layout; new reading input releases that hold.
- A normal earlier read downloads one older page, plus one recent page while the window still includes the newest messages. Only genuinely new recent events are reduced. Once viewing a past window, it downloads only the older page. Legacy split tool calls may need one additional adjoining page; only matching tool results are reduced from that page.
- Already loaded message bodies are shared. Page provenance retains only message/agent/outcome ids, a notice count and an end cursor. Immutable projected bodies are measured through weak keys. The client keeps at most 12 pages and targets 8 MiB, evicting newest whole pages while preserving local unconfirmed prompts. It keeps the incoming page and its adjacent visible page even if those two indivisible pages exceed the target, so byte eviction cannot remove the reader's anchor. Historical agent and unmatched outcome projections leave with their page.
- A bounded recent read cannot silently bridge an unseen reconnect gap. A gap beyond that page fails with a reopen message instead of downloading an unbounded tail. Host identity, confirmed echo metadata, pending input, and current runtime/clock facts remain authoritative.

## Reproducing the browser check

`web/scripts/test-load-earlier.mjs` opens the real App in a disposable browser, replaces only the command socket, and reads a synthetic 1,200-turn record. Each turn has four events and a 64 KiB tool result. It exercises button presses (including repeats), scrolling near the top, continued scrolling while the response is in flight, window eviction and late height growth above the reader. Each fixture page response waits 80 ms. No live profile, server agent or credentials are used.

```sh
PLAYWRIGHT_MODULE=/path/to/playwright/index.mjs \
PLAYWRIGHT_EXECUTABLE_PATH=/path/to/chromium \
OCTIQ_TEST_DIST=/absolute/isolated/dist \
node web/scripts/test-load-earlier.mjs

HISTORY_ENGINE=webkit \
PLAYWRIGHT_MODULE=/path/to/playwright/index.mjs \
OCTIQ_TEST_DIST=/absolute/isolated/dist \
node web/scripts/test-load-earlier.mjs
```

`OCTIQ_WEB_ROOT` selects another checkout. `HISTORY_PAGE_TURNS=18` exercises the local window path before server pagination. `HISTORY_BASELINE=1` records the unfixed control without applying fix assertions. `HISTORY_RESULTS` writes JSON. `HISTORY_WEBKIT_EXECUTABLE_PATH` selects a separately installed Playwright WebKit binary.

Assertions cover anchor drift ≤2 px, ≤2 normal page requests per press, a two-page wire budget independent of loaded history, bounded DOM turns, a Chromium post-GC heap plateau, late layout stability and a generous five-second wall-time ceiling (including gesture waits and fixture RTT). Unit tests separately count reducer calls, assert shared message identity, check window projection eviction and protect identified echoes/cancellation.

## Validation and limits

The final production-App matrix passed at 1280 and 390 px in Chromium 156.0.8078.48 and Playwright WebKit 26.6: 16 presses per case, with both 3-turn server pages and 18-turn initial pages exercising local window reveals. All 128 after-fix presses retained their anchor; maximum drift was 0.5 px and every late layout check drifted 0 px. The unfixed WebKit control drifted 5 px during continued scrolling, and both engines removed the visible anchor entirely on press 13. Raw per-press numbers, source hashes and fixture details are in [load-earlier-results.json](load-earlier-results.json).

| 390 px, 3-turn pages | f70f90e control | Fixed |
| --- | ---: | ---: |
| Chromium button press 10 | 1,216 ms | 328 ms |
| WebKit button press 10 | 1,297 ms | 617 ms |
| Page requests on press 12, both engines | 13 | 2 |
| Reply bytes on press 12, both engines | 2,639,637 | 406,098 |
| Chromium post-GC heap on press 12 | 16,904,108 bytes | 14,114,752 bytes |
| Chromium fixed heap at press 16 | — | 14,450,320 bytes |

The old control's smaller heap after press 13 came from throwing away the visible window, so its final heap is not a valid like-for-like comparison. Auto/momentum elapsed time includes waiting for the simulated gesture to end; it is not reducer CPU time and can exceed the old immediate-publication time. Normal page work and wire bytes remain constant as history fills. Tests pass: 336 Vitest files / 4,593 cases, 46 targeted cases, `tsc -b`, and the production build (existing chunk-size warning only). The existing production confirmed-echo release/reopen/history probe passes all four envelope/width cases with one visible copy and zero retained local copies.

The continued-scrolling case is a deterministic DOM gesture/frame sequence. Desktop Playwright WebKit with a mobile viewport is not a real iPhone compositor or Safari touch-inertia acceptance test. Chromium heap values are post-GC JS heap, not peak allocations or whole-process RSS. WebKit heap measurement is unavailable and recorded as `null`. Tunnel latency, production traffic and real iPhone behavior were not tested. Wall time includes the artificial fixture RTT and host scheduling; it is not a phone-speed prediction.
