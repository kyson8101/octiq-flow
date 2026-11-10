# Recent chat window retention

Measured on 2026-11-10 before changing the policy. This extends the existing
`ChatWindowCache` / `CatchUp` / `ChatHistory` path; there is no second transcript store.

## Policy

- Keep up to **six offscreen reducer windows**, under **48 MiB total per tab**.
  Visible panes are outside this budget, as before. Four tabs can therefore
  retain up to 192 MiB of offscreen windows, plus visible panes and application overhead.
- Settings, Agents and Projects cover the chat without clearing its recent
  windows. Count, bytes, host provenance and deletion still evict them.
- Size accounting remains conservative UTF-16 plus object overhead. An
  indivisible 23 MiB ASCII turn can occupy roughly 46 MiB by itself and evict
  smaller, older windows. A window exceeding 48 MiB is skipped, leaving room
  for other windows. The existing 8 MiB paged-window trim is unchanged.
- Checkpoints remain 16 MiB total / 8 MiB each in IndexedDB. Partial windows
  remain memory-only and must not become complete checkpoints.
- Only visible panes subscribe to transcript deltas. Retained offscreen
  windows stay still; reopening shows their existing words and catches up
  from their tail. Retention must not widen `bridge.watchChats`.

The 48 MiB ceiling accommodates six windows near the existing 8 MiB window
target. The fixture's six ordinary windows cost about 22 MiB under the
conservative estimator. This cap bounds retained reducer data, not browser RSS.

## Measurement

`scripts/test-chat-window-cache.mjs` mounts the real App, reducers, rendering,
socket bridge and IndexedDB. Its isolated WebSocket fixture uses recorded
`file-edits.jsonl` event vocabulary, expanded into twelve actual pages per
chat: approximately **22.81 MiB per transcript**, **1.90 MiB per recent page**.
The original captures are unchanged. Each transcript reply has an intentional
120 ms fixture delay. These are local fixture transport measurements, not
production Rust `chat_page` latency or paid-agent runs.

Baseline means from a final reproducible run, in milliseconds:

| Stage | 1280 px | 390 px |
| --- | ---: | ---: |
| `chat_page` request to parsed reply, including the 120 ms fixture delay | 220.42 | 231.80 |
| JSON parse, included in the preceding row | 2.68 | 3.20 |
| Reducer replay | 1.20 | 1.57 |
| Publish to first DOM commit | 98.56 | 104.38 |
| Selection to first DOM commit, including subscription/checkpoint setup | 586.00 | 631.64 |

The original policy evicted c0 after opening six chats. Holding all transcript
replies then reproduced the empty `opening` surface. With the new policy,
all six chats and a Settings round trip displayed the retained words while
every transcript reply remained held. MutationObservers detected no intermediate
`opening` DOM commit. Scroll verification compares the same user turn and its
offset, because the rendered turn window can start elsewhere after reopening.

The final development run's selection-to-DOM averages were 324.22 / 344.17 ms
for retained returns. This removes network/replay dependency; it does not make
React rendering cost zero. A supplemental production-React Vite probe measured
59.6–387.9 ms for the same returns under varying host load. It is not a benchmark
of the minified production bundle.

A **3,856,602-byte estimated checkpoint** for a chat absent from recent memory
displayed with transcript replies held. IndexedDB reads took 74.8 / 99.8 ms;
selection-to-DOM took 423.6 / 544.4 ms in the development run. The checkpoint
path is independent of the network but remains asynchronous and includes
rendering work; no zero-latency claim is made for a cold checkpoint.

## Delta and memory checks

Four real App tabs each opened the six large chats. Deliberately over-delivering
1,000 offscreen delta frames to **each tab** produced **zero background reducer
folds and zero App renders in every tab**. The scoped host normally suppresses
these frames before transport. This is why increasing retention does not require
folding every retained chat in every tab. The older unscoped-server fallback is
unchanged and was not load-benchmarked here.

GC samples from the final development probe:

| Tab | Estimated held reducer windows | JS heap |
| --- | ---: | ---: |
| Main, also opened checkpoint chat | 25.76 MiB | 35.07 MiB |
| Second | 22.08 MiB | 32.63 MiB |
| Third | 22.08 MiB | 32.80 MiB |
| Fourth | 22.08 MiB | 32.45 MiB |

The fixture also verifies a missed host tail is applied once on return and
that a new visible update still renders after the background flood. These
samples are not whole-process memory ceilings or a production performance SLA.

## Reproduce

Run browser probes sharing a web root **serially**. `PLAYWRIGHT_MODULE` may name
an isolated Playwright installation; `OCTIQ_WEB_ROOT` selects the web root.

```sh
CHAT_CACHE_BASELINE=1 node scripts/test-chat-window-cache.mjs
node scripts/test-chat-window-cache.mjs
NODE_ENV=production CHAT_CACHE_PROFILE=1 CHAT_CACHE_DESKTOP_ONLY=1 node scripts/test-chat-window-cache.mjs
pnpm --dir web exec vitest run src/lib/chatWindowCache.test.ts src/lib/loadChat.test.ts src/lib/chatCache.test.ts src/lib/chatHistory.test.ts src/lib/catchUp.test.ts src/lib/chatRetention.test.ts src/lib/chatPlace.test.ts src/lib/replayChat.test.ts --maxWorkers=2
pnpm --dir web build
```

The baseline option reinstates the old two-window / 8 MiB / clear-on-cover
policy only through the probe's Vite transform. It never edits production source.
The probe prints its temporary evidence directory with `results.json`, screenshots
of all six retained returns at both widths, Settings returns and checkpoints.
The optional profile writes a Chrome CPU profile for the first retained return.

Evidence from this implementation session:

- Baseline: `octiq-chat-windows-dBOuly` in the system temporary directory.
- Full matrix: `octiq-chat-windows-q8WfKm` in the system temporary directory.
- Supplemental production React profile: `octiq-chat-windows-CM3uBZ` there.
