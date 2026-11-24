# Chat status bar and removed-folder recovery

Moved verbatim from AGENTS.md on 2026-11-24.

### A chat's status is half reported, half verified

The line above the chat (`ChatTaskBar`) answers three questions a chat picked
up an hour later cannot answer for itself: is anything happening, what is this
chat FOR, and which branch is it doing it on. The panel behind it answers the
fourth — did that work ever land.

The split in `chat_task.rs` is the whole design, and it exists because an LLM
forgets:

- **The agent REPORTS** the objective, the plan and the active step, through
  the `task_status` MCP tool (`scripts/mcp/octiq-ask.cjs` → `POST /hook/task`).
  Nothing infers it: a chat whose agent never reported says *not reported*
  rather than guessing from the transcript. Every report is stamped with the
  time and the agent, so a stale one looks stale.
- **The host VERIFIES** everything else with git, on request: branch, primary
  checkout vs linked worktree, changed files, commits ahead of the target,
  pushed, merged locally, merged on the remote, released. An agent saying
  "merged" changes nothing — only the merge does.

Three rules hold:

- **`released: null` is "unverified", never "no".** A project says how a
  release is recognised in the Release row itself, or with
  `chat_task_set_release_check`: a git ref only a release advances, or a
  command whose output names the running commit — the first 7–40 character hex
  string in its output is taken as that commit. Most projects have neither, and
  the release row says so. The check is not run at all until git says the
  commit is in the target branch, so an unmerged branch never shells out.
- **What is running is recorded at install, by `install-service.sh`.** It
  writes `~/.octiqflow/live-build.json` (`commit`, `branch`, `shippedAt`) next
  to the `cp` that makes a binary live, because nothing else knows: the binary
  carries no version of its source and mtimes only say "newer than".
  `octiq-check.sh` prints that commit on its `live build` line, and it is what
  this repo's own release check reads.
- **The record outlives the worktree.** Every verification stores its snapshot
  plus the repository's PRIMARY checkout and the head commit, so a chat whose
  directory has been deleted is re-verified from the primary checkout against
  the commit it remembers, marked `stale`. "Was that ever merged?" is asked
  precisely when the worktree is gone.
- **Nothing polls.** The bar refreshes when the chat opens, when a turn ends,
  on `git-status-changed`, and when the panel opens; verification is cached for
  four seconds so several open tabs cost one `git status`. The accent is for a
  turn in flight only — states the work is merely *owed* stay quiet.

The MCP server's instructions and each tool description stay under 4,096
characters (`scripts/mcp/instructions.test.cjs`): Claude Code drops text past
that limit. Put tool-specific guidance in that tool's description.

### A chat whose folder was removed is recovered before it starts

A chat remembers the exact folder it ran in, and a task chat's is a linked
worktree that gets removed once its work is merged. The chat outlives it, so
`chat_start` goes through `chat_recover.rs` first, and only when the folder is
missing. The order:

1. **Rebuild the worktree at the SAME path** (`git_ops::restore_worktree`):
   from its branch when the branch still exists, else by making the branch
   again at the commit remembered for it (`Delivery.head`). What the worktree
   was comes from git's own `worktree list` (a folder deleted by hand is still
   listed until the next prune) and from the last `chat_task` verification,
   because either can be the one that survived. The same path keeps the
   agent's own session folder.
2. **Else move the chat to a folder that exists**: the worktree's root when
   only a subfolder went and git still calls it that checkout, the
   repository's primary checkout as `chat_task` last verified it, then a
   folder registered for the chat's project.
   `chat_index::set_cwd` records it, and a Claude session is hard-linked into
   the new folder's `~/.claude/projects/<encoded cwd>/`
   (`carry_claude_session`). Claude Code 2.1.292 resumes by id from any
   folder, so that link is for older CLIs; Codex resumes by id regardless.
3. **Else say why** in words: `The chat's folder … was removed and could not
   be restored: …`, which the page shows under the unsent message.

- **It is refused before it changes anything** (`recover_from`). A chat that
  already has a process answers `already running`, the words the page falls
  back to sending on. A worker's chat, and a folder a task holds on a lease,
  is preparing or is cleaning up, are refused by
  `require_no_owner_of_removed`. What passed is then held until the chat has
  been started (`chat_recover::Held`): the workspace lifecycle lock, so no
  worker is handed the checkout and no cleanup begins, and a claim on the chat
  (`ChatManager::claim_start`), which makes `start_session` refuse every
  other start of it. Two tabs sending at once rebuild the worktree once.
- **A chat is moved only to a folder the host can vouch for**
  (`Remembered::vouched`): the recorded primary checkout, or a folder
  registered for the project its index entry names. The page's `fallbackCwd`
  and the planned folder only choose among those and add none. A filesystem
  root and the home folder are never moved into (`too_broad`), registered or
  not.
- **A folder that was a worktree's root is gone to only while git still calls
  it that repository's checkout, whichever list offers it** (`Former`,
  `still_checkout_of`). Three places say a folder was one: the worktree the
  missing folder was found in, the last `chat_task` verification
  (`is_worktree`), and git's `worktree list` for every vouched repository. A
  plain folder made where such a worktree was removed is a directory and
  nothing more, and the project registering it, or a folder inside it, does
  not bring it back: it is passed over for the next safe folder, and with
  none left the error says it `is no longer a checkout of the repository it
  belonged to`. A registered folder that never was a worktree needs no Git
  history. A folder that still exists never reaches recovery at all, so this
  is asked only of where a chat is being MOVED.
- **Nothing is overwritten.** A path that exists is never rebuilt over, and
  git refuses a branch another worktree holds, which falls through to step 2.
  Uncommitted and untracked files in the removed folder are gone, and both
  notices and the banner say so.

- **It is told twice, once each.** `Held::settle` runs after those
  refusals and is a method of what is held, so it cannot run outside it: a durable `octiq_chat_recovered` event
  draws a notice in the chat and moves the page's `cwd`, and the agent's next
  prompt carries a one-line note (`chat_recover::with_note`, taken in
  `start_session`) that stays out of the person's bubble.
- **Before any of that, the page says it is coming.** `RemovedFolderBanner`
  reads `chat_task`'s `workspace.exists` and shows one row above the
  composer (`removedFolderNote`). Folded it is a label and what the next
  message does, a few words each with a folder by its last name (`Worktree
  removed · next message rebuilds it from its branch`, `Folder removed ·
  next message moves this chat to <folder>`, on a POSIX or a Windows path).
  The whole path and the whole sentences (uncommitted and untracked files
  are not restored; where it falls back to) are behind the row's own
  disclosure, which is the row: a button, never a tooltip alone. It never
  blocks a send.
- Only `chat_start` recovers. Auto-resume, restart and a queued Codex turn
  reuse the remembered start context and are not covered.
