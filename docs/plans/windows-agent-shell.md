# Plan: Windows agent shell

Agent chats cannot start on a Windows machine that has no `SHELL` environment
variable. Every agent — Claude, Codex and Pi — is launched from one place,
`agent_chat.rs`, and that place falls back to a path that does not exist on
Windows:

```rust
// agent_chat.rs, today
let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/zsh".to_string());
let mut child = Command::new(&shell).args(["-lc", &format!("exec {line}")])
```

The failure is quiet in the worst way. The server starts, the client loads,
terminals work, and the agent picker correctly lists Claude as installed —
because the *probe* path in `agents.rs` already has a `#[cfg(windows)]` branch
that asks PowerShell. Only the launch is missing one, so the first click on a
chat fails with `The system cannot find the path specified. (os error 3)`,
which names nothing a user could act on.

## Evidence

Measured on Windows 11 against the published `octiqflow@0.1.52`
(`@kyson8101/octiqflow-win32-x64`), with an isolated profile via `HOME`. One
variable changed between the two runs:

| `SHELL` | `chat_start` |
| --- | --- |
| set (`C:\Program Files\Git\bin\bash.exe`) | **works** — Claude launched, streamed, replied |
| unset | **fails** — `could not start claude: The system cannot find the path specified. (os error 3)` |

Everything else on Windows already works and is deliberately untouched by this
plan: PowerShell PTYs (spawn, write, stream), the agent probe, `list_dir`, the
git reads, and the workspace store all passed in both runs.

Why this can go unnoticed: the machine these runs were measured on carries a
user-level `SHELL` pointing at Git's bash, so the fallback never fired there and
every agent chat worked. Windows itself sets no such variable, so whether a
given machine hits this depends on what happens to be in its environment — which
is why it needs a resolution step rather than a fallback.

## Decisions (locked)

- **Agents keep going through a POSIX shell.** `build_command` returns a
  POSIX-quoted command line (`sh_quote` emits `'\''`), which neither PowerShell
  nor `cmd.exe` parses the same way. Swapping the shell without rewriting the
  quoting would corrupt every argument, so the quoting — and all three
  providers — stay exactly as they are.
- **Git for Windows is an accepted prerequisite.** Its `bash.exe` reads the same
  quoting, so Windows differs only in WHERE the shell is found, not in how the
  command is built.
- **Resolution moves into a pure function**, `resolve_agent_shell`, taking
  `is_windows` as a parameter rather than a `#[cfg]`. This mirrors
  `pty.rs::resolve_shell` and is the point of the design: the Windows branch is
  then testable on macOS, which is the only machine the maintainer has.
- **`["-lc", "exec {line}"]` is unchanged.** `-l` is arguably unnecessary on
  Windows (its reason is a GUI service's incomplete `PATH`, which Windows does
  not have), but `-lc` was measured working with Git bash and this plan does not
  ship unverified changes.
- **A missing shell is an error, not a fallback.** Nothing tries `/bin/zsh` on
  Windows any more.

## The contract

```rust
/// Decide which POSIX shell launches an agent, and with what arguments.
fn resolve_agent_shell(
    shell_env: Option<String>,
    is_windows: bool,
    look_up: &dyn Fn(&str) -> Option<String>,   // executable lookup, injected in tests
) -> Result<ShellSpec, String>
```

Resolution order:

1. `SHELL`, when set and non-empty — unchanged, so macOS behaviour is untouched.
2. Not Windows: `/bin/zsh` — unchanged.
3. Windows: find Git's bash, cheapest lookup first —
   native `bash` on `PATH` (skipping WSL's System32, Sysnative and WindowsApps
   launchers); then `git` on `PATH` resolved to `<git>\..\bin\bash.exe`;
   then the fixed installer locations `C:\Program Files\Git\bin\bash.exe`,
   `C:\Program Files (x86)\Git\bin\bash.exe`, and
   `%LOCALAPPDATA%\Programs\Git\bin\bash.exe`.
4. Nothing found: `Err`, with text that names the fix.

The fixed locations are not redundant with the `PATH` lookups. The Git for
Windows installer offers "Use Git from Git Bash only", which deliberately keeps
`git` off `PATH` — and a user who chose that is exactly the user this plan is
for.

## Change boundary

| Site | Today | After |
| --- | --- | --- |
| `agent_chat.rs` (agent launch) | `SHELL` → `/bin/zsh` | `resolve_agent_shell()` |
| `agent_chat.rs` (process cwd) | `env::var("HOME")` → `"/"` | `paths::home_dir()`, which already reads `USERPROFILE` too |
| `chat_task.rs` (release check) | `Command::new("sh")` | `sh` on Unix, `resolve_agent_shell()` on Windows |

The `HOME` line is a one-word fix to use the helper that already exists; the
release check is the same bug in the same family, and splitting it into its own
change would be stranger than fixing it here.

The release check deliberately does NOT adopt the resolved shell on Unix. `sh`
is on every Unix and routing it through `$SHELL -lc` instead would swap both the
shell and its startup files on macOS — an unverified change to a platform this
work cannot test, in a change whose whole point is that Windows has no shell at
all. Unix keeps `sh -c`, byte for byte.

Explicitly untouched: `build_command`, `sh_quote`, all three providers, `pty.rs`,
and the `agents.rs` probe.

## Errors

```
could not start claude: no POSIX shell found. OctiqFlow runs agents through a
shell, and on Windows that means the bash shipped with Git for Windows. Install
it from https://git-scm.com/download/win, or set SHELL to a bash.
```

The resolver supplies the sentence; the caller wraps it in the existing
`could not start {bin}: {e}` text, so the client needs no change and the message
still names which agent failed.

## Tests

The resolver tests run on macOS and native Windows. Launcher tests also run
under Windows PowerShell 5.1 and PowerShell 7, with OS/process boundaries mocked;
native smoke checks verify the login shell and background job behavior.

- `resolve_agent_shell(None, true, …)` finds Git bash from a stubbed `git`
  lookup, and from each fixed location.
- `resolve_agent_shell(None, true, &|_| None)` returns an error naming
  "Git for Windows" — asserted on the text, since the whole point is that the
  message is actionable.
- `resolve_agent_shell(None, false, …)` still yields `/bin/zsh`, and a set
  `SHELL` still wins on both platforms. These two lock macOS against
  regression, which is what review should care about most.
- Windows path derivation handles both separators independently of the host OS.
  PATH lookup continues past WSL launchers to a native bash later on PATH.
- `pwsh -NoProfile -File scripts/start-octiqflow.test.ps1` exercises the actual
  Windows launcher with file/process boundaries mocked. It covers home/profile
  selection, first-run token creation, effective token overrides, bind addresses,
  and preserving unrelated jobs on normal exit, failure and `-NoOpen`.
- Windows profile locks query native process handles. A child-process test
  verifies that a live owner blocks a second claim and that an exited owner
  can be replaced on both platforms.
- Path tests preserve literal `..` components, including Windows verbatim
  paths. Missing directories cannot be normalized away before validation;
  traversal through existing directories and canonical root checks still work.
- Preview fixtures join path components separately so their expected paths
  use native separators on both systems.

## Out of scope

- Removing the shell layer entirely (an argv-based `build_command`). It would
  delete a class of quoting bugs, but it rewrites all three providers and is a
  separate decision.
- A Windows service or autostart. OctiqFlow on Windows is started by hand and
  stops when its window closes.
- The Windows build story (vendored OpenSSL needing a native perl, and the
  stale `web/node_modules` trap). Documentation, tracked separately.
