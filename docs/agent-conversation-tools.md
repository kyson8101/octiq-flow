# Agent conversation search and read

`search_conversations` and `read_conversation` call `POST /hook/conversations`
with `action: "search" | "read"` and the existing tool arguments in `args`.
The response is `{ "result": "<existing tool text>" }`. Errors use the normal
hook refusal/outcome envelope. There is no person-token or profile-file fallback:
these tools require a current launch capability, including a separately installed
MCP. Standalone artifact creation remains available.

The host derives the current project from the chat proved by `hook_caller`.
Search keeps current/all/project ID/name/slug scopes, `includeCurrent`, the
1–20 result limit and the existing JSON result shape, weights and excerpts.
Project/current exclusions run before ranking, so unrelated high-ranking chats
cannot crowd a scoped result out. MCP lexical matching preserves whole ASCII
words and non-ASCII bigrams without retaining corpus-wide postings.

Reads accept the existing ID/URL arguments, exclusive semantic-entry `before`
cursor, 1–100 entries (default 40) and 4,000–100,000 character body budget
(default 60,000). Tool activity is opt-in and individual tool details are capped
at 4,000 characters. Character budgets count UTF-16 units as the old Node tool
did, without splitting a Unicode character. The streaming reader keeps only the
bounded page, resolves storage-only init/commands references, uses logical event
numbers across merged delta ranges, and reads tool results from their surviving
`message.content`. Malformed physical lines remain counted and are skipped.
Headers/cursors and historical-data safety text retain the old tool format.
Deleted chats and front-desk records are absent from search/read.

Ordinary chats, orchestration workers (including ended attempts whose launch
still runs) and room seats retain these read-only tools. A room seat's current
project is its owning chat's project. Front desks remain route-only: the existing
MCP `tools/list` offers only `route_chat` and its `tools/call` refuses every other
name; the new hook enforces the same rule independently. These reads neither
speak for the registered agent nor perform user-authorized mutations.

The host checks `profile::available` before looking at stores and again after
reads. A missing/replaced profile returns that exact explanation. Work runs on
`spawn_blocking`, outside Tokio's async workers. Search shares the server's
per-chat segments and bounded candidate filters. Segment/filter semantic version
2 invalidates version-1 projections in place, because peer-origin/skill handling
and the fallback speaker now match the MCP. Existing segment filenames remain;
there is no second segment tree. Valid legacy cache imports retain their exact
stored speaker/role/text. No MCP code reads or recreates `search-index.json`.

## Verification

Normal checks:

```sh
node --test scripts/mcp/*.test.cjs
cargo test --manifest-path src-tauri/Cargo.toml --lib -j1 -- conversation_ chat_search::
```

The MCP transport test poisons every access to its profile path or
`search-index.json`, exercises the actual stdio process and checks description
limits, room/worker claims and host refusal metadata. Rust tests exercise live
loopback hooks with stand-in launches, expired/unknown/mismatched capabilities,
front desks, compact records, scopes, cursors, tools, and missing/replaced
profiles. Providers are never started.

The ignored equivalence/RSS test generates a synthetic scratch corpus in the
Rust test profile, copies only that corpus for the baseline Node process, then
compares parsed search results and exact read text against the old tool. Its
updated MCP receives an inaccessible profile path and can only use the test
server's launch capability. RSS comes from `ps` after requests, not heap estimates.
No real profile, service or conversation is discovered or read.

Export `scripts/mcp/octiq-ask.cjs`, `artifact.cjs` and `question-media.cjs` from
base `204a63c6` to one scratch folder, then run (through `octiq-job` for a long run):

```sh
OCTIQ_CONVERSATION_LEGACY=<scratch>/octiq-ask.cjs \
OCTIQ_CONVERSATION_CORPUS_CHATS=28 \
OCTIQ_CONVERSATION_CORPUS_ROWS=6000 \
OCTIQ_CONVERSATION_MEASUREMENT=<scratch>/measurement.json \
  cargo test --manifest-path src-tauri/Cargo.toml --lib -j1 \
  conversation_mcp_equivalence_and_rss -- --ignored --nocapture
```

The default corpus is tiny for a quick compatibility check. The optional scale
above approximates the reported legacy cache size; the measured byte count is
reported instead of assuming it equals the real corpus. End-to-end production memory remains unmeasured here.

For an authorized real-corpus copy, the separate ignored test
`conversation_real_corpus_equivalence_and_rss` requires
`OCTIQ_CONVERSATION_CORPUS` to name an OS scratch folder whose name begins
`octiq-record-storage-`. It accepts no live source path. `original` and
`compacted` are sibling copied chats folders; the ignored
`conversation_compact_corpus_sample` test compacts only the four largest and
20 filename-SHA256-selected records in the latter.
`baseline/chats` is a separate clone of `original`, with `workspaces.json`
beside it and at the scratch root. The test clones only the compacted copy
into a new test profile and launches no providers. It checks English/Chinese,
current/project/all scopes, and three pages on each of the three largest
active chats. Committed evidence contains only hashes, counts, sizes and RSS;
private mismatch bodies, if any, stay in the scratch folder.

## Measured result — 2026-11-09

The read-only APFS snapshot held **2,532 records / 7,161,556,338 bytes** and a
221,746,560-byte legacy cache. Only 24 copied records were compacted: the four
largest plus 20 records selected deterministically by filename SHA-256. Fourteen
changed, from 459,623,909 to 314,881,596 bytes across that sample. The rest of the
frozen corpus remained unchanged. These are scratch-copy measurements, not
live-profile savings.

All **8 real search requests** were equal, including full ordered IDs,
speakers/roles/excerpts and scope, for English, Chinese, current, named/ID project
and all-project queries. All **12 read results** were equal: nine full pages on
three large readable chats, plus three matching refusals for the actual third
largest chat, whose project no longer exists. The next largest readable chat
provided the third content comparison. Search equality uses canonical JSON
hashes; reads compare the complete tool text/error flag, without normalization
of the content. The synthetic regression also passed 12 searches and six reads.

| Node MCP RSS (bytes) | Legacy local reader | Host-backed reader |
| --- | ---: | ---: |
| Before search | 46,743,552 | 46,497,792 |
| After eight searches | 339,099,648 | 39,469,056 |
| After reads | 1,454,669,824 | 43,270,144 |

Post-search RSS fell **299,630,592 bytes (88.4%)** in this pair. The old MCP's
scratch legacy cache grew to 249,356,497 bytes during refresh. The new MCP was
given an inaccessible profile path throughout and retained only HTTP results;
the separate poisoned-FS test proves it makes no profile/index accesses.
These are `ps` resident-set snapshots during a busy machine's validation run,
not peak heap, statistical timing results, or a production-wide memory claim.
Server import/rebuild memory and storage savings after deployment are separate.

[Search/read hashes and RSS](measurements/agent-conversations-real.json) and
[per-record compaction hashes and byte counts](measurements/agent-conversations-compaction.json)
contain no conversation text. The source/corpus copies are removed after
validation; the original profile and running service are never written.

## Final checks and first-run failures

- `cargo test --manifest-path src-tauri/Cargo.toml -j1` with default test
  threads: **2,109 library tests + 31 binary tests passed**, zero failed,
  23 manual tests ignored; doc-tests completed with zero tests.
- `node --test scripts/mcp/*.test.cjs`: **66 passed**, zero failed.
- Rust formatting and `git diff --check`: passed.
- Manual real-corpus comparison and 24-record compaction: passed; synthetic
  comparison: 12 searches + six reads passed. The private corpus clones were
  removed after saving the hash/count evidence.

The first full run (`--test-threads=2`) exited 101: 2,107 passed, two failed,
23 ignored. `memory_activity::tests::storage_gate_waits_for_memory_intents_and_missing_delivered_lines`
failed at `memory_activity.rs:1199` with
`assertion failed: record_quiet(&record).is_ok()`. Its simulated profiles shared
the production delivery mutex with other tests. The test now retries only the
exact busy refusal, for at most five seconds; all debt/parse assertions and the
production nonblocking, fail-closed `record_quiet` remain unchanged. The isolated
test, 36-test module and final default-thread full suite passed.

The other first-run failure was the unchanged
`worktree_lifespan::tests::h5_reversible_autocrlf_and_explicit_eol_restore_exact_raw_bytes`,
at `worktree_lifespan/tests.rs:1934`:
`Command failed: fatal: crlf: clean filter 'offline' failed`.
It did not recur alone on this branch, alone with the already-built records and
server branch test binaries, or in the final default-thread full suite (Git
2.45.1). No h5 fixture or production lifecycle code was changed. The failure
occurred during Git's commit/index work before the intended offline-smudge
verification; the reason it refreshed that path only in the first run remains
unconfirmed.
