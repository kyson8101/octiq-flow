# Disk report host contract

Manual inventory of development leftovers, exposed only through the authenticated
browser socket's `dispatch.rs` command table. There is no hook route, MCP tool,
scheduler, automatic scan or host cleanup operation. The browser renders the
returned items as a treemap/list and downloads script text; it does not send paths
or commands for execution.

## Socket commands

- `disk_scan_start {}` → `{ scanId }`. One scan per server process, on a dedicated
  thread. A second start returns an error while the first is running.
- `disk_scan_cancel { scanId }` → `{ cancelled: bool }`. Cooperative cancellation
  during directory walking and subprocess waits. An unknown/completed id returns
  false. A cancelled/failed scan preserves the previous report.
- `disk_scan_state {}` → `{ running: { scanId, startedAt, phase, entries, bytes } | null,
  report: Report | null }`. `latest.json` is loaded lazily on first access, once
  per process. Malformed/unreadable history is an error, not a fresh report.
- `disk_cleanup_script { scanId, itemIds: string[], allowRm: bool }` →
  `{ fileName, script }`. Ids are resolved against the host's last report; unknown
  ids/stale scan ids fail the whole request. Duplicate ids are deduplicated. Work
  and actionless items are rejected. No script is executed or written by the host.

Events: `disk-scan-progress { scanId, phase: "home"|"temp"|"git"|"history",
entries, bytes, path? }`, globally throttled to at most four per second for the
scan; `disk-scan-done { scanId, ok, error? }`. A very fast phase may emit no event.
`entries` counts metadata entries, `bytes` counts observed regular-file and link-self lengths;
these are traversal progress, not reclaimable-space estimates.

```ts
type Report = {
  scanId: string; scannedAt: number; platform: 'macos'|'windows'|'linux'; home: string;
  thresholdBytes: number; totalBytes: number; items: Item[];
  skipped: {path: string; reason: string}[]; previousScanAt: number|null;
};
type Item = {
  id: string; key: string; group: 'clean'|'review'|'work'; kind: string;
  label: string; path: string; bytes: number; modifiedAt: number; effect: string;
  note?: string; notRecommended: boolean; action: Action|null;
  previousBytes: number|null; grew: boolean;
  worktree?: {repo: string; branch: string; clean: boolean; merged: boolean;
    mainline: string; idleDays: number; inUse: boolean; eligible: boolean; ignoredBytes: number};
};
type Action = {type:'tool'; command:string} | {type:'worktree'; repo:string; path:string}
  | {type:'rm'; path:string} | {type:'rmOlderThan'; path:string; days:number; exclude:string[]}
  | {type:'docker'; command:string};
```

Timestamps are milliseconds since Unix epoch. Items have at least 104857600 bytes
(100 MiB). `modifiedAt` is the newest observed mtime, including directory mtimes.
`key` is `kind + ':' + path`, stable across scans; `id` is opaque and scan-local.
`totalBytes` sums the disjoint listed items, including work labels, not all home
contents or guaranteed freed disk blocks. Logical sizes can differ from physical
allocation due to sparse files, compression, APFS clones or hard links.

## Privacy and traversal

Only `symlink_metadata`/`read_dir` inspect scanned data. No contents, manifests,
transcripts or `.git` pointer files are opened. Git is the explicit exception for
repository state. Docker's CLI is an explicit exception for Docker accounting;
container storage is never traversed. The only files read directly are this
feature's own CSV/JSON. Home comes from `paths::home_dir()`; folder creation uses
`profile::make_dir`.

Never follow symlinks or Windows reparse points/junctions/cloud placeholders.
Their own lstat length and mtime are counted; targets are never entered. A fully
measured link is not a skipped root or a partial scan. Only unreadable entries
and deliberately excluded/protected roots make their containing subtree partial.
Skip special files, Photos libraries, OctiqFlow host state/profile, report
history, job spools, Docker/container data and entries on another device than
home. Errors are never retried. Unreadable entries are counted under the nearest
active candidate/project root, with one representative error. Deliberately
excluded roots are deduplicated in `skipped`; it holds at most 500 roots plus
one summary row reporting additional skipped/unreadable entries. An older
oversized `latest.json` is capped and rewritten on load; this touches only the
report file and does not append CSV rows or start a scan. `.git` contents are excluded by definition
and checked only by Git; this is not a gap in measured worktree data. The host's in-memory ledger supplies every task checkout/validation path whose
workspace is not cleaned, plus every mission delivery whose `removed` is false.
Run completion/archival does not release a mission. Scanner never opens the ledger.

On macOS, `Desktop`, `Documents`, `Downloads`, `Pictures`, `Movies`, `Music`, Trash,
`Library/Mobile Documents`, `Library/CloudStorage`, `Library/{Mail,Messages,Safari,
Calendars,Reminders,HomeKit,Cookies,Suggestions,Biome,Metadata/CoreSpotlight,
Application Support/AddressBook,Application Support/CallHistoryDB,
Application Support/com.apple.TCC,Containers,Group Containers}` are never entered.
Known protected roots are reported even if absent, without probing them. All
other Library paths are denied by default except the cache/developer roots in
the table below and their ancestors. This deliberately sacrifices coverage to
avoid background TCC prompts. Apple documents Files and Folders protections and
other-app data access in [Controlling app access to files](https://support.apple.com/en-gb/guide/security/secddd1d86a6/web).
External/network volumes are excluded, including `/Volumes` and mount devices.
Windows additionally excludes OneDrive/iCloud roots and offline/recall entries.

## Kinds and actions

All locations below are relative to home. macOS adds Library paths; Windows adds
AppData paths. Shared dot-directory paths are supported on all three platforms.
Unknown data is not guessed to be rebuildable or suggested for cleanup.

| kind | roots / names | group and action |
| --- | --- | --- |
| `npm-cache` | `.npm`; Windows `AppData/Local/npm-cache` | clean, `npm cache clean --force` |
| `yarn-cache` | `.cache/yarn`; macOS `Library/Caches/Yarn`; Windows `AppData/Local/Yarn/Cache` | clean, `yarn cache clean` |
| `pnpm-cache` | `.local/share/pnpm/store`; macOS `Library/pnpm/store`; Windows `AppData/Local/pnpm/store` | clean, `pnpm store prune` |
| `uv-cache` | `.cache/uv`; macOS `Library/Caches/uv`; Windows `AppData/Local/uv/cache` | clean, `uv cache clean` |
| `pip-cache` | `.cache/pip`; macOS `Library/Caches/pip`; Windows `AppData/Local/pip/Cache` | clean, `pip cache purge` |
| `go-cache` | `.cache/go-build`; macOS `Library/Caches/go-build`; Windows `AppData/Local/go-build` | clean, `go clean -cache` |
| `homebrew-cache` | macOS `Library/Caches/Homebrew` | clean, `brew cleanup -s` |
| `cocoapods-cache` | macOS `Library/Caches/CocoaPods` | clean, `pod cache clean --all` |
| `cargo-registry`, `cargo-git` | `.cargo/registry`, `.cargo/git` | clean, rm |
| `gradle-cache`, `maven-cache` | `.gradle/caches`, `.m2/repository` | clean, rm |
| `xcode-derived-data` | macOS `Library/Developer/Xcode/DerivedData` | clean, rm |
| `project-node_modules`, `project-target`, `project-next`, `project-nuxt`, `project-svelte-kit`, `project-turbo`, `project-parcel-cache`, `project-__pycache__`, `project-pytest_cache` | matching directory names inside a project identified by `.git` or a manifest **name**, without reading it | clean, rm |
| `ai-models` | `.ollama`, `.cache/huggingface`, `.lmstudio`, `.cache/lm-studio` | review, rm |
| `simulators` | macOS `Library/Developer/CoreSimulator`; `.android/avd` | review, rm |
| `toolchains` | `.rustup/toolchains`, `.nvm/versions`, `.pyenv/versions`, `.sdkman/candidates`; macOS `Library/Android/sdk`; Windows `AppData/Local/Android/Sdk` | review, rm |
| `docker` | virtual path `docker://local`; `docker system df --format '{{json .}}'` sums CLI Size fields | review, `docker system prune` |
| `personal-work` | Media bundles/documents (`*.fcpbundle`, `*.fcplibrary`, `*.prproj`, `*.drp`, `*.dra`, `*.rpp`), folders with an immediate editor document or `remotion.config.*`, or a Remotion-named folder with its own `package.json`; qualified media/photo-export names (including `mv`, `film`, `footage`) also need media filenames. Generic `Exports`/`renders`/`out` require media filename evidence and must be outside a code project. Dependency/vendor/tool-cache trees never become personal work from these names or bundled markers. | work label only, action null; whole media project including out/renders is protected |
| `git-worktree` | linked worktrees discovered through Git; never primary checkout | clean only if every eligibility check passes; otherwise review; worktree action |
| `development-temp` | top-level `npm-*`, `yarn-*`, `pnpm-*`, `uv-cache-*`, `pip-cache-*`, `cargo-cache-*`, `rustc-*` | clean only if fully observed, older than 3 days and not in use; rm |
| `ai-session-temp` | top-level `claude-*`, `codex-*` | review only if older than 3 days and not in use; rmOlderThan 3 with memory exclusions |

AI history kinds each gain two suffixes: `-older-14-days` and `-last-14-days`:
`codex-history` (`.codex/sessions`), `codex-archived-history`
(`.codex/archived_sessions`), `claude-history` (`.claude/projects`),
`gemini-history` (`.gemini/tmp`), `opencode-history`
(`.local/share/opencode/storage/session`). Each age bucket independently meets
the threshold. Every nested `memory` directory (case insensitive) is excluded.
Older items use `rmOlderThan` with 14 days and `exclude: ['memory']`; recent items
are review, `notRecommended: true`, note `Not recommended to delete`, action null.
There is no contract action for deleting only recent files while preserving older
files and all memories; these items are informational and cannot be selected.

A named personal-work subtree suppresses any parent cache cleanup action, even
when nested inside dependencies or build output. Temp entries containing such
work are withheld entirely. Other parent items retain their full aggregate bytes and suppress all nested
child items; bytes are not subtracted. Duplicate items at one path are
suppressed, with work/worktree records taking priority. The only same-path
exception is a tool history's complementary old/recent age buckets, whose
file sets are disjoint. `totalBytes` sums exactly these final treemap items.
Worktree inventory replaces its
nested cache suggestions and suppresses containing cache cleanup actions, even
when the worktree itself is below the reporting threshold. A partial cache measurement is downgraded to review.

## Git and process checks

Git subprocesses have optional locks disabled, fsmonitor disabled and terminal
prompts disabled. No fetch, refresh-index write, maintenance or removal is run.
`git worktree list --porcelain -z` identifies linked checkouts. Eligibility requires:

1. `git status --porcelain=v1 -z --untracked-files=all` is empty.
2. `git merge-base --is-ancestor HEAD <mainline>` succeeds. Mainline is the local
   `refs/remotes/origin/HEAD` target, else `refs/heads/main`, else `refs/heads/master`.
3. Newest observed mtime is at least seven days old, with no incomplete walk.
4. No observed cwd/open file lies in the worktree (component-wise prefix match).
5. No host ledger allocation still records this path.
6. On Windows, no reparse point occurs inside the checkout. Git 2.45.2.windows.1
   was observed traversing a junction during `worktree remove`, deleting files in
   its external target. These items remain review with `action: null` and an
   explicit warning. Their metadata measurement is complete, not Partial.

Every failing check is explained in `note`. Ledger-managed checkouts say
`Managed by an OctiqFlow run: close it from the run panel`. Managed status always
wins over a personal-media worktree label: the group remains review; personal
media still has no cleanup action. Ignored output is
measured using `git status --ignored --porcelain=v1 -z` and walk sizes, not file
contents, and every worktree effect/script warns that ignored output is removed.

Unix uses one bounded `lsof -nP -F0n` pass for cwd and open files. If unavailable,
failed, timed out or empty, usage is unknown: worktrees remain review and temp
suggestions are withheld. Windows deliberately reports the same conservative
unknown because no bundled CLI provides a complete open-file/cwd inventory;
no extra software, registry writes, elevation or permission prompts are attempted.
Commands are bounded and cancellation terminates their child process. Git has a
15-second timeout, lsof 12 seconds and Docker 8 seconds.

The walk aggregates sizes, age buckets and newest mtime bottom-up. Directory
names are streamed in two metadata-only passes (flags, then traversal); no child
list or per-file tree is retained. Retained sizes are limited to threshold
candidates, linked worktree roots and their disjoint ignored roots. Small confirmed media
work roots are retained only as protection markers. Media filename evidence is
counted from metadata/extensions, excluding dependency/cache contents; no file
content is read. Generic output names and technical Remotion fixture names inside code projects
are not work; a media-project marker or explicit photo/video-export context is
required. Remotion-named code folders need their own package.json or config. Git worktree/ignored roots
are discovered before walking a repo's children; linked worktree lists are
reused across that repo's checkouts. The required skipped-root report is also
retained. Cancellation is checked in both passes and bounded subprocess waits;
progress stays throttled during the name pass as well as metadata traversal.

Git repository discovery is restricted to the home phase. Windows home traversal
skips its nested system-temp root for the separate age/in-use pass.

System temp roots: macOS `$TMPDIR` (Rust OS temp resolution), Linux `/tmp` and
`/var/tmp`, Windows `%TEMP%`. Trusted OS temp root aliases are resolved once;
symlinks/junctions encountered inside them are never followed. Unrecognized temp
entries are skipped; `octiqflow-job-spool-*` never becomes an item.

## History and scripts

Only `~/disk-report/sizes.csv` and `~/disk-report/latest.json` are written. Output
symlinks/reparse points are refused. CSV header is `scanned_at,key,path,bytes`,
with RFC-style double-quoted path/key fields and embedded newline support. Read
history at scan start; `previousBytes` is the latest earlier timestamp per key.
`grew` means an increase of at least `max(ceil(previousBytes/20), 10 MiB)`.
Completed scans append rows, flush, then save the JSON report. These two writes
are not a filesystem transaction; if JSON saving fails after CSV append, the
command reports failure and the CSV still retains those measurements. Files
larger than 128 MiB are refused on load to bound memory use.

The pure script generator takes `is_windows` explicitly. Bash scripts are named
`octiq-cleanup-YYYY-MM-DD.sh`; PowerShell scripts use `.ps1`. The script first
prints all selections and requires exactly lowercase `yes`, preserving input
whitespace (`IFS= read` / raw `Read-Host` with case-sensitive `-ceq`). PowerShell
text starts with a UTF-8 BOM so Windows PowerShell 5.1 preserves Unicode paths. All paths/labels are
quoted as data. Tool/Docker commands are fixed host strings. Worktrees use only
`git -C <repo> worktree remove <path>`, without force. `rm`/`rmOlderThan` print
`Skipped (no tool command): <path>` unless `allowRm` was explicitly selected.
With it enabled, rm uses `rm -rf --` / PowerShell LiteralPath; age cleanup deletes
only old regular files, prunes memory directories and explicit excludes, never
follows links, and leaves directories. No script download is permission to run it.
