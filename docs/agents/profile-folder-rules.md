# Profile folder rules

Moved verbatim from AGENTS.md on 2026-11-24.


`profile.rs` decides the profile dir; `profile_lock.rs` makes sure only one
process owns a profile at a time (a second one refuses to start rather than
overwrite the first's project list).

**The profile dir is fixed when the server starts.** `profile::pin` is the
first thing `run_headless` does: `<base>/<active>/` is resolved once from
`~/.octiqflow/config.json`, and `profile::profile_dir` answers that one path
until the process exits. It makes nothing and looks nothing up again.

- **The fallback is at startup only.** A configured base that cannot be made
  then gives way to `~/.octiqflow/profiles`, as before, and the server says
  so: on its log line, and in `profile_status`'s `fallbackFrom` and `notice`.
  It stays on that folder when the configured one comes back; only a restart
  looks again.
- **A folder that goes away under a running server is an error, never
  another folder.** `profile::available` answers why in words (`The profile
  folder … is not available right now: … OctiqFlow keeps to the folder it
  started with and has not switched to another, so nothing was saved. …`).
  `chat_send`, `chat_start`, `chat_complete` and `chat_index_list` answer
  with it first, and no agent is started on a turn whose record cannot be
  kept. When the folder is back the same calls go through; nothing is
  restarted. What ran meanwhile: a turn already in flight goes on streaming
  to the page and its lines are not recorded.
- **Nothing the host does makes the profile folder after startup.** Folders
  are made through one door, `profile::create_dir_all` (`make_dir` is the
  same, in words). For a path in the profile it makes only what is BELOW
  the profile folder, one `create_dir` each from the profile folder down,
  so a profile that is gone fails in the filesystem whenever it went. A
  look followed by a create was tried and was the hole: the folder went
  between the two and came back empty, and a chat's next line became line
  2 of a record whose line 1 was in the folder that moved. **No module
  calls the standard library's `create_dir_all` or `create_dir`**; a
  source scan fails the suite
  (`profile::tests::no_module_makes_a_folder_but_through_the_profile`,
  whose allow-list is `profile.rs` itself and the standalone `bin/octiq.rs`,
  each with its reason). Whether a path can lie in the profile is not for
  the caller to judge: a vault, a worktree or `~/.octiqflow/mcp` is inside
  it when the profile base is set that way. A script the host starts keeps
  the same rule.
- **The folder a server started with is that directory, not whatever is at
  its path.** A path still answers after its folder is removed and another
  is made there, or after it is pointed somewhere else. So a process leaves
  a mark in the folder it takes: a word made up for the run, on the owner
  lock's line (`pid kind mark`). It is left by the first question a process
  asks of the profile (`profile::started`, which `pin` reaches first), so
  the guarantee does not wait on the owner lock; `profile_lock::acquire`
  writes the line again with the process's kind. A lock another live
  process holds is never written over: that process keeps its mark, and
  the one being refused knows the folder by its path alone for the moment
  it has left. Every "is the profile there" is `Pinned::missing`: the
  folder at the path holds this run's mark, or it is *gone* (the sentence
  above) or *replaced* (`… is not the folder OctiqFlow started with: … has
  not written into it, so nothing was saved. Put the original folder back
  …, or restart OctiqFlow to use the folder that is there now.`). A new
  question about the folder asks `profile::available`, never `is_dir` or
  `exists` on the path.
  - A replaced folder gets nothing: no folder made in it, no store saved,
    no line appended, no hook run from it. A second server that starts in
    a folder made at the path writes its own mark, and the first reads
    that it is no longer in its folder and stops writing.
  - `transcript::chats_dir` asks on every call, so a record's count,
    generation and resolved folder name are never used against a folder
    that only shares the path, and `confirm_synced` asks again after the
    sync: a token is confirmed only in the directory it was made for.
  - Why a mark and not the platform's file identity: device and inode
    numbers change on a remount and are reused by some filesystems, a held
    handle blocks an eject and dies with the drive, and stable Rust cannot
    ask Windows for a directory's identity. The mark is one question with
    one answer on macOS, Linux and Windows.
  - What it cannot tell: a copy of the folder, lock and all, made while
    this process runs and put at the same path, is the folder. A lock that
    is deleted by hand reads as replaced until a restart. A profile folder
    that could not be written at startup has no mark and is known by its
    path alone, which the server says on its log.
- **A read from a profile that is gone is an error, never a first run's
  value.** "No file" in a profile that is there is the store's default; "no
  file" because the folder is away says nothing about what is saved. Read
  as a default, Settings drew a blank form over the person's saved rules
  and an ordinary Save wrote the blank form's text over them once the
  folder was back. A store that reads its file per call reads it with
  `profile::read`, which answers the bytes, `None` for no file in a
  profile that is there, or the profile's sentence (asked after the read,
  never wrapped in the store's own words): preferences, the roster,
  handovers, the vault's settings and receipts, safety authorizations,
  feedback, PR workflows, chat task status, the memory
  activity ledger. What answers the page from a record or the index asks
  `profile::available` first (`chat_since`, `chat_page`,
  `chat_index_deleted`, `chat_search`). A store kept
  in memory (ledger, projects, questions, usage, background tasks,
  auto-resumes) goes on answering and never reloads while the server
  runs: its save fails in the profile's words and, once the folder is
  back, writes what it holds. **There is no global guard in front of
  every command**: Stop, interrupt and the answer to a card work while the
  folder is away, whatever they would have saved (Conventions, *An action
  that ends work or answers a waiting agent never waits on a save*). A page that loads a whole value into a form and saves it
  back offers no Save when the load failed (`unread` on
  `PreferencesBlock` and `AgentPolicyBlock`; the vault form is not drawn).
- **A new store reads `profile::profile_dir()`, makes folders with
  `profile::make_dir` before every write, and reads its file with
  `profile::read`.** Never `create_dir_all` on any path, never
  `NotFound => default` on a path in the profile, never the config read
  again, never a base worked out by the module.
- **In tests `profile_dir()` is a scratch profile**, one `TestDir` shared by
  the test binary and never this machine's own. A test that needs a profile
  to itself (it takes the folder away, or runs something that sweeps the
  chats folder, as `chat_index::reconcile` does) stands its thread in one
  with `profile::started_in(home)`, which resolves from the config under
  that home exactly as the server does, and takes the folder (leaves its
  mark) on its first question, as `run_headless` does. A second thread
  started in the same home is a second server: it takes the folder from
  the first. `profile::tests::Home` takes the folder away three ways:
  `unplug` (a file where its drive was), `move_away` (nothing left at the
  path, so anything that makes a folder and its parents would remake it)
  and `replace` (another folder at the path); `everything_in(dir)` is what
  a test compares to show nothing was written.
