# Browser memory retention (2026-11-07)

## Finding

The tab retained old App renders. In V8, closures created during one render share a lexical context. App's mutually referencing memoized callbacks had different dependency lifetimes; a current callback could keep an earlier callback, its entire render context, and that render's ledger/transcripts alive. A fresh idle tab did not exercise the navigation/dependency changes that build this chain.

The live heap after ten recent/large chat selections showed old ledger objects retained through App contexts and callbacks, including `loadCodexSkills`. At the mid-soak GC snapshot, the union of reachable ledger data was 126,255,024 bytes across nine distinct run arrays; V8 self-size excluding native nodes was 166,880,401 bytes. These are unions, not a sum of overlapping snapshot views.

A controlled real-browser regression alternates two callback dependency lifetimes for 101 renders. Both Chrome and disposable Brave retain 101 ledger objects with React's native `useCallback`, versus two with the fix, after GC. The check also covers identity changes, old callback handles seeing the latest committed body, child layout effects, and an abandoned Suspense render.

## Changes

- App event/subscription callbacks use an isolated committed cell. Old function handles no longer own old App scopes. Dependency changes still replace the handle and re-run subscribing effects. Pure render-time readers are constructed outside App so they see the current render without retaining its scope.
- Only the main and beside transcripts stay loaded in RAM. Other durable chats become three text previews of at most 420 characters each, retaining status/session facts. Unacknowledged prompts and local-only/imported words are protected. Returning to a released chat replays the durable record; previews never become full checkpoints.
- The 12-entry `chatCache` limit applies to IndexedDB storage, not App's live state. The previous-checkpoint marker uses weak keys. Sidebar transcript copies are released with the loaded chat. Short snippets detach their string backing storage.
- `ChatHistory` holds only a cursor. Explicit **Load earlier messages** re-reads the displayed raw window and replays it with the older page, preserving cross-page tool results, pending prompts, and racing live events.
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

## Limits and backend follow-up

No production deployment or restart is part of this work. The person's existing Brave profile/tabs are untouched. The reported multi-GB crash itself was not reproduced. Headless Chromium soaks and disposable Brave regressions do not establish real-phone, Safari/WebKit, tunnel, or 18-hour stability.

This is not a cap on an intentionally expanded visible transcript or on unacknowledged local input. Explicit older-history reads may still download a large raw window using the existing `chat_since` contract. The probe's brief-ledger replies contain about 12.2 million JSON characters per read (UTF-16 code units, not wire bytes). The feed shares one ledger among consumers; known execution events patch it, while other changes request non-overlapping reads, normally at least one second apart. It has no polling interval. Explicit refreshes can bypass that gap.

A scoped lightweight summary and per-run detail, plus socket chat subscriptions, remain useful backend contracts to avoid parsing broad broadcasts/whole-ledger replies. This patch adds no server API or subscription mechanism.
