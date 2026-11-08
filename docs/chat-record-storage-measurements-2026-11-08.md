# Chat record storage evidence — 2026-11-08

All record changes in this experiment were made to copies under the OS scratch
folder `octiq-record-storage-gm2zs62h`. The live profile, native agent session
files and service were not changed. This is a logical disk-byte measurement,
not a production RAM measurement or a released migration.

## Whole copied chats folder

All 2,528 top-level JSONL records completed the actual optimized compactor pass.
1,456 changed; 1,072 were unchanged. Every changed record retained the same host
facts at their logical sequence numbers; unchanged records were compared byte
for byte. No `.rewrite` or `.compact-backup` sidecars remained.

| Scope | Original bytes | Compacted bytes | Saved |
| --- | ---: | ---: | ---: |
| 2,528 records | 7,106,864,530 | 4,854,135,390 | 2,252,729,140 (31.7%) |
| Whole folder, including other files | 7,484,762,192 | 5,232,033,052 | 2,252,729,140 (30.1%) |
| Largest record (`chat_76954dc9…`) | 170,989,128 | 69,779,086 | 101,210,042 (59.2%) |
| Second largest (`chat_12b38231…`) | 79,321,441 | 45,503,551 | 33,817,890 (42.6%) |
| Third largest (`chat_b2913c8c…`) | 71,017,822 | 71,017,822 | 0 |

The 54 other files total 377,897,662 bytes and are byte-for-byte unchanged,
including the legacy search index and nested attachments. These totals are
logical lengths, not newly freed live-profile space or APFS physical blocks;
both original and compacted evidence copies are retained.

## Append-only growth

Re-encoded the largest original record with the actual append encoder, without
rewriting earlier turns. It contains 2,170 completed turns. The result is a
projection from captured events, not a live post-deployment observation.

| Measurement | Original bytes | New bytes |
| --- | ---: | ---: |
| Median turn | 43,362 | 17,134 |
| 90th percentile turn | 179,035 | 73,903 |
| Init events | 57,399,209 | 4,960,622 |
| Commands changed | 13,501,405 | 9,448,911 |
| Hook responses | 9,815,332 | 209,896 |
| User tool-result events | 34,076,044 | 6,987,100 |

Changed lists remain material events. Finished typing-delta merging happens on
process release/idle reaping or startup, so these append-only numbers do not
claim those later savings.

## Replay and durability

The optional web evidence suite passed 26 tests: 22 captured provider streams,
three largest record copies and one range/catch-up check. It replays the actual
Rust compactor's output through the web reducer/replayChat and compares drawn
messages, tool diffs/outcomes, questions and answered facts, other ChatState
fields and sequence positions. Actual Rust-decoded fixture frames are also
compared with the raw-storage adapter; only noninteger decimal parser ULP
differences are normalized in that adapter comparison. Reducer outputs and all
integer/sequence comparisons are exact.

Focused Rust verification passed 63 tests (four ignored), including concurrent
append, clear, chat-start and post-publication readback races. A further three-test
run passed the legacy rewritten-record receipt case, the storage generation
move before a receipt, and the canonicalization source guard. The tests cover
all audited receipt-debt gates and fresh child-process exits before and after
atomic publication; generation moves are not silently accepted as old receipts.

## Complete checks

Final checks completed on 2026-11-09 MYT; the disk/lock measurements above were
taken on 2026-11-08. Final real-record replay passed all 26 evidence tests again.

- `cargo test -j 1 --manifest-path src-tauri/Cargo.toml -- --test-threads=2`:
  2,092 library tests and 31 binary tests passed; zero failed, 20 ignored.
  Doc-tests completed with zero tests.
- `pnpm --dir web test --maxWorkers=2 --testTimeout=15000`:
  338 files / 4,625 tests passed.
- `pnpm --dir web exec tsc -b --pretty false`: passed.
- `cargo fmt --manifest-path src-tauri/Cargo.toml -- --check`: passed.

## Append lock on a release build

After the server-memory benchmark driver exited, the `release-local` test binary
compacted a fresh 170,989,128-byte copy. Total processing took 6.8537 seconds;
the longest single global append-lock hold was **34.03 ms** (0.034028042 s).
The timing runner polled for other `rustc` processes and observed none.
The output was 69,779,086 bytes and matched the large reducer-tested copy
byte for byte. Bulk preparation, verification and recovery readback ran outside
the global append lock. This measures the macOS path; the Windows-only writable
backup-handle guard does not change that path. Windows runtime was not tested.

## Evidence and limits

Evidence root on the measurement machine:
`/var/folders/mr/fjhr8lkn5nzdnhfy9knz04k00000gn/T/octiq-record-storage-gm2zs62h`.
`write-growth.json`, `receipt-regressions.log`, the shard size ledgers and final
validation logs contain machine-readable results. Private conversation bodies
are retained only in scratch copies, not committed in this repository.

The new disk format requires the new backend. A rollback needs a pre-migration
chats-folder backup. Migration reserves only quiet records and keeps a per-file
backup until verification. Bulk preparation/readback stays outside the global
transcript append lock.
Publication rechecks source metadata/generation before backup/rename/sync; a new
chat start or changed source cancels that file for a later retry. Reference
lists are expanded before wire delivery; disk savings are not equivalent wire
or browser-memory savings. Whole-history rewrite after every turn is avoided;
segmented tail storage is a separate follow-up.

See [the storage contract](chat-record-storage.md) for the reader audit, atomic
recovery rules, receipt consumer matrix and reproducible offline commands.
