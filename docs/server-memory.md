# Server memory

Chat search stores one disposable JSON segment per chat under
`chats/search-chats-v1/`. A query reads and drops each required segment; it never
keeps the archive's text, tokens or lowercase copies resident. A transcript's
size/mtime stamp invalidates its segment.

Migration imports a readable v2 `search-index.json`, preserving its text,
speaker and role. This matters because the MCP cache's fallback speaker is
`User`, while rebuilding the same transcript with Rust uses `You`. The original
file stays byte-for-byte intact until migration completes. Import writes
individual segments and the filter index before its completion marker. A failed
initial publication leaves no marker and is retried; canonical chat records are
never written. An absent, corrupt or unsupported legacy file is checked once per
server run. Missing, corrupt or unsupported segments rebuild from those records.
The one-time import still reads the old JSON file into memory; subsequent starts
use only the small filter index and the segments a query needs.

A startup background pass, serialized with queries, imports and reads back every
legacy segment, then builds and reads back segments for every `chat_*.jsonl`
record (including records absent or stale in the legacy cache). Only after all
of these succeed and filters and the completion marker are saved does it remove
`search-index.json`. An older completion marker alone is insufficient. The pass
resolves `chats` from the pinned profile, reads through `profile::read`, makes
folders through `profile::make_dir`, and calls `profile::available` immediately
before unlinking. Missing/replaced profiles, redirected cache directories or
legacy files, failed publication/readback, or a changed legacy file leave it untouched for a later
startup. Queries may import before the background pass acquires the search lock;
they never remove the legacy file. Markers also publish by sibling rename, so
an old marker symlink cannot redirect a write. Chat records are never rewritten.

Downgrade is safe: source inspection of the pre-branch binary's code at
`106dfe3` (`chat_search::load_cache`, `refresh_cache`, `save_cache`) confirms that
a missing legacy file starts with an empty cache; the next search indexes the
records and saves it again. The unchanged MCP reader does the same through
`loadSearchCache` and `refreshSearchIndex` in `scripts/mcp/octiq-ask.cjs`.
Downgrade or MCP search can therefore recreate the legacy disk cost; the next
new-server startup verifies migration again before retiring it. A canonical
rebuild may use `You` instead of the preserved MCP fallback `User`.

A bounded candidate index (`chats/search-filters-v1.json`) holds two/three-character
Bloom filters. A matching transcript stamp and a negative filter can exclude a
segment; a positive filter always runs the original substring scoring and
excerpt logic. Unknown, corrupt and stale filters are cache misses. The resident
map admits at most 4,096 entries, each with 2,048 bytes of bits, a key of at most
512 bytes and a stamp of at most 128 bytes. Its serialized input is limited to
32 MiB. Deleted and hidden chats' filter entries are dropped on the next search.

Metadata scores establish the result page's floor before any segment read. A
segment is skipped only when its maximum possible document score cannot enter
the requested page. Original input order breaks equal score/time ties. Within a
chat, the first exact-phrase document already has the maximum document score;
metadata weights are still applied afterwards.

Segments and filters are derived caches, not authoritative state. Cache write
failures leave source search available; a missing or replaced profile refuses
the query in the profile's own words. Reads use `profile::read`, directory writes
use `profile::make_dir`, and cache files publish through a sibling temporary
file. Cache failures do not acknowledge an authoritative change and therefore
create no owed-save obligation. Ledger persistence and its owed-save behavior
are unchanged.

The orchestration scheduler no longer builds a full UI snapshot every two
seconds. Monitoring copies only live attempts and their policy; recovery takes
a snapshot of runs with running or due attempts, without reading task reports.
Ready-wave polling copies only eligible run IDs and coordinator keys. It retains
all tasks, attempts and gates of a selected run for existing retry/approval
checks. Stops still act first, and all chat/roster/ledger lock ordering stays as
before. Public snapshot, summary and detail response contracts are unchanged.

## Measuring

Use a copied, sanitized profile and an independent loopback port. Never launch
a measurement server with the live profile, and never restart the live service.
Disable automatic starts and cleanup in the copy, rebase external paths into the
fixture, remove copied owner locks and use a shell that cannot launch agents.
Freeze record-compaction stamps so the measured corpus cannot change mid-run.

Measure idle, the browser WebSocket connection, index/summary reads, the first
search, repeated searches, a rare miss and idle after reads. Check response hashes
and record size/mtime stability alongside latency. A Node WebSocket harness
measures the server protocol; it does not measure browser rendering or agent/MCP
process memory.

On macOS record `ps` RSS, sampled peak RSS, `vmmap -summary` physical footprint and
live malloc bytes. Record `vm_stat` swap/pageout deltas and concurrent app compiler
PIDs. Under swapping a 1 GiB live heap can show only tens of MiB RSS: that is not
a memory reduction. Accept comparisons only without concurrent app compilation
or swapping where possible. If the host cannot reach zero Swapins, retain the
counts, obtain the coordinator’s acceptance of that limit, and do not claim a
perfect no-swap RSS comparison. Report the one-time legacy import separately
from a restart with the new disk cache already present.

## Measured results (2026-11-08)

[Raw numeric evidence](measurements/server-memory.json) contains three
back-to-back base/final pairs and one final restart with the disk cache already
present. Both binaries use `release-local`; the base is
`106dfe3d26584d44d34da851dd5aadcbb94fa63b`. The JSON pins each binary and the
four tested Rust sources by SHA-256. The frozen fixture has 2,514 records
(7,106,132,287 bytes); its legacy index is 247,847,456 bytes. This is a later,
updated scratch cache than the initial 221,746,560-byte source census.

All eight search replies in every pair and the restart have identical complete
JSON hashes, including the Unicode query `内存`. Record sizes/mtimes and the
legacy index SHA were unchanged throughout each pair; the third pair's check
also covers its restart child. No measured stage overlapped active Rust
compilers or tests. All stages had zero Swapouts, but some had 4–44 global
Swapins pages (16 KiB/page). With live agents still on the Mac, the coordinator
accepted that limit and requested malloc/footprint as the main evidence. The
strict-zero-swap driver exited 1 after its three pairs; its original false flags
and every counter remain in the evidence. These are **not** perfect no-swap RSS
comparisons.

| Measurement | Base, three runs | Final, first import | Final, cache restart |
| --- | --- | --- | --- |
| vmmap live malloc | 1.0G in each | 78.9M in each | 78.9M |
| vmmap physical footprint after reads | 1.5G in each | 180.8–243.7M | 177.3M |
| vmmap peak footprint | 1.5G in each | 522.6–538.5M | 257.7M |
| Sampled cold-search peak RSS, KiB | 994,784 / 1,137,520 / 1,229,664 | 409,456 / 606,432 / 554,816 | 219,520 |
| RSS after reads, KiB | 172,032 / 125,376 / 124,848 | 27,968 / 368,384 / 160,032 | 207,152 |

Live malloc falls about 92%; median cold-search peak RSS falls about 51%.
Post-read RSS varies with page residency and compression, and does not provide
a reliable reduction by itself. The footprint and live allocation counts
(15,752,722 to 369,295) substantiate the removed corpus heap.

The required RSS checkpoints are retained below. Each cell lists the three
sequential runs in KiB; all reads use the same frozen input. Before search, the
search archive has not loaded, so these checkpoints also expose the background
polling change without attributing its allocator noise to search.

| RSS checkpoint | Base | Final |
| --- | --- | --- |
| Idle | 160,400 / 135,344 / 191,712 | 155,072 / 155,552 / 27,088 |
| Browser WebSocket connected | 122,032 / 150,048 / 204,320 | 91,872 / 155,984 / 48,160 |
| `chat_index_list` | 170,720 / 163,984 / 222,096 | 40,144 / 165,200 / 55,968 |
| `orchestration_summary` | 209,712 / 208,320 / 241,632 | 198,240 / 230,080 / 203,232 |

Polling and search changes ship together; no separate causal heap saving is
claimed for polling. The earlier segment-only prototype reached 398,000 KiB
cold-search peak RSS under a swapping/busy machine, but regressed hot queries
to 11–19 seconds and was rejected. The bounded filters and result-floor pruning
are part of the final measured implementation.

| Search latency, excluding settle | Base | Final |
| --- | --- | --- |
| First `memory`, median of three | 3,600 ms | 5,171 ms for one-time import; 104 ms after cache restart |
| Hot `memory`, median of nine | 345 ms | 46 ms; restart median 42 ms |
| Hot `profile`, median of three | 355 ms | 59 ms; restart 66 ms |
| Hot `内存`, range | 266–556 ms | 685–906 ms; restart 952 ms |
| Rare miss and repeat, range | 237–447 ms | 259–446 ms; restart 303–348 ms |

Unicode search retains a subsecond disk-read cost compared with the resident
index. The first import also costs time and transient heap. These tradeoffs are
reported alongside the common-query improvement, rather than hidden in a
single average. The 2,457 derived segments occupy 120,814,893 bytes; the largest
is 3,601,457 bytes. Filters occupy 11,335,391 bytes on disk. At the time of those
measurements the legacy index was retained. The retirement follow-up removes
its 247,847,456 bytes after verification. For that measured segment/filter set,
cache storage is 132,150,284 bytes instead of 379,997,740 bytes, 115,697,172 bytes
below the original legacy-only cache. These are arithmetic totals from the
measured file sizes, not a new live-profile measurement. The background pass
also fills any records absent from the old cache (the fixture had 2,514 records
and 2,457 segments); their additional segment/filter bytes are not measured here.
The isolated profile
copies and their private response payloads are removed after exporting numeric
evidence; no measurement service is left running.

## Remaining holders and measurement limits

The ledger remains resident, including finished runs and their approval and
reopen history. The captured profile's first size census put it at about 36 MB,
versus 222 MB for the legacy search index. Chat task status, chat index, usage
and job files were each about 1–4 MB. These are serialized store sizes, not
per-store heap measurements. The final vmmap also reports 102.2–157.5M of
malloc-zone fragmentation after import, and 83.1M on the cache restart, beyond
the 78.9M of live allocations. That allocator cost is a remaining holder.
Public full snapshot/summary construction still
has a temporary allocation cost; this change narrows the background readers.

The process-memory overview keeps one five-second sweep result, not all past
sweeps. Task verification remembers an `Instant` per verified chat. Usage is
accounting state rather than a disposable cache. Neither was comparable to the
search archive in the captured profile.

An idle Codex session clears MCP call/refusal/elicitation maps at turn end, and
stdout is read through per-line owned values. Person-turn evidence has a
256-entry count bound. Queued input and in-flight provider payloads are retained
for delivery and permission correctness; their live bytes were not measured by
the zero-agent fixture. The benchmark does not claim a bound for pasted user
input, live queues, agent processes or MCP processes.

## Validation

The frozen implementation passed `cargo test --manifest-path src-tauri/Cargo.toml
-- --test-threads=2`: 2,081 library tests and 31 binary tests passed, none failed;
18 explicitly ignored tests stayed ignored. Profile absence/replacement and
source-scan tests passed. The two existing large-file/worktree tests that timed
out during the initial busy-machine run passed in this run with their original
deadlines and size bounds. `cargo fmt -- --check` and `git diff --check` passed.
