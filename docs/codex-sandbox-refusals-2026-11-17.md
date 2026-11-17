# Codex Auto/Edits refusals: 14-day measurement

Window: 2026-11-03 05:39:13 UTC to 2026-11-17 05:39:13 UTC.
All numbers below are observed counts, not estimates. The input scan streamed
846 recently modified JSONL files (2.365 GB), identifying 299 Codex records
and 16,434 command events. It also read 338 Codex diagnostics in the window
and 24 nonempty Codex attempt `execution.latestError` values. These last two
sources added no matching runtime refusal events; they are not extra failures.

The table counts direct command events showing a refusal, once per class per
event. A command may hit several classes, so rows must not be summed. Access
is the attempt's recorded setting, or the latest chat index setting; the
records do not provide a complete historical access timeline. All matched
below-Full cases were recorded as Auto; there was no separate Edits sample.

| Rank | Refused operation | Direct events | Kind | Example chat ID | Classification and next step |
| --- | --- | ---: | --- | --- | --- |
| 1 | DNS / outbound network | 17 | 14 worker, 3 ordinary | `orch-2eb31b1b48574a9e8f7efbc267c7d15c` | Deliberate network-off. Use an authorized host tool when available; otherwise Full through the proper access/gate route. |
| 2 | `ps` | 14 | 12 worker, 2 ordinary | `orch-0636452d9bbd44528b0b8ccb3c016da1` | Codex OS sandbox restriction; use host metadata or Full when required. |
| 3 | Simulator / ADB / native browser services | 9 | worker | `orch-2017a42b7778474284cb14e62284ed11` | OS sandbox restriction; device/native validation requires Full. |
| 4 | `octiq-job` hook connection before successful spool fallback | 8 | worker, 2 chats | `orch-f2c3940be97a404cbd489c76f843dd8a` | Avoidable OctiqFlow transport attempt. Start directly in the existing scoped spool when Codex signals disabled network. |
| 5 | Process `kill` | 6 | worker | `orch-2017a42b7778474284cb14e62284ed11` | OS sandbox restriction; use host Stop or authorized Full work. |
| 6 | Write another branch ref | 4 | worker, 1 chat | `orch-be8daa75bb5d4a49b04d362b32f9f53a` | Deliberate boundary. The command committed on the task branch, then tried `branch -f` on a different branch. Leave that update to authorized Full/coordinator work. |
| 7 | `sysctl` | 3 | worker | `orch-f9e20ccc85c6423bb2999bdaf764ad9a` | OS sandbox restriction; use supplied runtime facts or Full when required. |
| 8 | Local listener/connect or SSH | 3 | worker | `orch-5e5e11d6e54a4868ae30e9eb3d3277e4` | Deliberate network-off, including localhost. Full is required for network integration checks. |
| 9 | External cache write / protected daemon directory read | 3 | worker | `orch-8237d28b0a864a6e9ad6d8b03b7ccc53` | External write boundary / OS restriction. Prefer a project-local cache; otherwise request the necessary access. |
| 10 | Multi-commit `sequencer` creation | 1 | ordinary | `bc239ced-2914-40ac-a799-05fa15920e77` | Deliberate boundary plus CLI directory-root cleanup limitation. Use merge/supported single-commit operations, or Full. |
| 11 | Permission failure in a Rust test | 1 | ordinary | `bc239ced-2914-40ac-a799-05fa15920e77` | Sandbox-limited test execution; do not call the test passed. Run the required fixture at sufficient access. |

The 17 Auto network events were: `git fetch` 10, `git push` 2,
`git ls-remote` 1, `gh` 1, dependency/build commands 3. There was no observed
`request_access` MCP call and no confirmed `--add-dir`/current-branch grant gap.
This is absence in the measured records, not proof that no such gap exists.
No shared ref/config/hook/network grant was expanded.

Additional observations, kept out of the direct-refusal ranking:

- 22 `packed-refs.lock` warning events (19 worker, 3 ordinary) all had command
  exit **0**. These are protected cleanup writes, not 22 failed commits.
  Example: `orch-2eb31b1b48574a9e8f7efbc267c7d15c`.
- The candidate scan found 178 job warning displays, but 170 were log/launcher
  readbacks. Only 8 were directly observed job invocations. More invocations
  can be hidden by redirected logs; their exact total is unknown.
- 9 Watchman permission-warning readbacks in 5 worker chats and 4 socket-error
  readbacks were excluded. For tests supporting it, `--watchman=false` avoids
  the Watchman service dependency. Example: `orch-2017a42b7778474284cb14e62284ed11`.
- Full-tagged candidates included test controls and log/source excerpts;
  they are not evidence that Full still has OctiqFlow's Codex sandbox.

## Collection and limits

Sources: the default profile's `chats/*.jsonl`, `chats/index.json`,
`orchestrations.json`, and `~/.octiqflow/logs/agent-diagnostics.jsonl`.
`item.completed` command/tool results were streamed, with item-ID de-duplication;
reasoning, user prompts and assistant prose were excluded. Source/search
excerpts were filtered, then candidate event numbers were checked against
commands to remove log readbacks and intentional test controls. Neither the
collector's JSON nor this report contains commands, tool output, file contents
or credentials. The measurement chat itself was excluded.

The records mostly lack per-event timestamps. Every Codex file in this cohort
was created within the window; old chats spanning the cutoff would be reported
separately rather than presented as precisely dated events. The sources were
live during collection, so the byte total is a scan observation, not an archived
snapshot. Appends and later access/provider changes can alter a rerun.

Re-run the metadata-only candidate collection (then review readbacks):

```sh
python3 scripts/measure-codex-refusals.py \
  --end 2026-11-17T05:39:13.504610+00:00 \
  --exclude-chat orch-084c96f40028453f9939967a6f49daf3 \
  --output /tmp/octiq-codex-refusal-candidates.json
```

The original local evidence is `/tmp/octiq-codex-refusals/measurement-v3.json`;
its rows carry only chat/event IDs, access, category and exit code. The manual
review above supersedes its raw candidate counts.

## Resulting behavior and verification

`job_wrapper` reads Codex's `CODEX_SANDBOX_NETWORK_DISABLED=1`. With the launch's
existing spool directory/capability it writes the job's start, progress and end
there directly. No loopback permission failure is needed first. Full and
launches without that signal keep the hook route; a host refusal is still not
a reason to fall back. Missing/unwritable spool reporting remains an error,
and the command retains its exit code.

Codex host instructions distinguish an OS denial from a pending safety card,
explain the protected boundaries and successful Git cleanup warnings, and give
the least-access route: ordinary chat `request_access` (Auto for a Read chat's
project write, Full for network/external/protected operations); worker task
gate for coordinator action or an authorized retry. A worker cannot change
its assigned access through `request_access`.

Validation commands and actual results are recorded in the task completion
report. The real CLI fixture is `scripts/test-codex-sandbox-jobs.mjs`; it uses
only a loopback stub model/hook and an isolated temporary Codex home, never a
paid turn. Existing `codex_git::real_codex_sandbox_*` tests exercise current
branch commits and protected refs/config/hooks in the real OS sandbox.
