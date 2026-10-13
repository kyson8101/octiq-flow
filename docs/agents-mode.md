# Agents mode

Agents mode is a switch in **Settings → Agents**. When it is off, chats work
exactly as before. The idea follows [Paperclip](https://paperclip.ing/): you
manage a team of agents instead of prompting one.

When it is on:

- **New conversation** in the sidebar opens an empty conversation, the same
  page a first load shows. It reads **Talk to <name>** and starts on the
  configured head (see below). When more than one agent reports to you, a
  compact **Talk to** picker lists them (see **Who a new conversation is
  with**). Picking one sets the chat's provider, model, effort and access to
  that agent's settings, for this conversation only. The next new
  conversation starts on the head again.
- The first message goes to that agent, the **lead**, with a brief after it.
  The brief names the lead, gives its role, and lists its direct reports. The
  chat shows only what you typed, plus a "task for <name>" label. The brief is
  kept in the transcript, so a resumed chat still knows its team.
- The sidebar gets an **Agents** row that opens the dashboard.
- The composer of a conversation with an agent is **compact**: the message
  box, attachments, the agent's avatar and name, and Send. It reads
  "Message <name>…". Role, provider and model are in the chip's tooltip and
  in Settings → Agents, which owns those settings. A new conversation starts on the
  registered settings; an existing one keeps the model it was recorded with,
  so reopening it never moves its history to another model. If the agent was
  removed, the name is struck through and the conversation keeps its last
  settings. Ordinary chats, and every chat when agents mode is off, keep the
  pickers and the location shelf exactly as before.

## Who a new conversation is with

A new conversation can only be with an agent who **reports directly to you**:
one with no manager in the org chart, or one whose manager is no longer
registered (the chart draws those at the top too). It does not matter whether
the agent is global or belongs to one project, and no name is special.
Anyone's report is left out, global or not. You reach them through their
manager, who may pass the work on. An agent whose project is no longer an open
project has nowhere to work, so it is left out as well.

- The picker reads the whole roster (`team_list` with `all`), so a project
  agent at the top, such as the head of one website, is offered from any page.
  The configured head comes first, then the rest by name
  (`lib/agentsMode.ts`, `conversationRecipients`).
- The head is selected by default, however the page was reached, including a
  first load inside another agent's project. With no head configured, the
  default is the first global agent at the top, then one that works in the
  project on screen (`conversationRecipient`). Picking someone never changes
  **Settings → Agents → Talk to**.
- **The head** is always the cross-project conversation from the home
  workspace (below).
- **A project agent** only works in its own project, so picking one moves the
  draft to that project. Its repository, branch, worktree and sandbox are then
  chosen exactly as for any lead in that project, and **Advanced** offers no
  other project. If the draft is moved to another project anyway, the choice
  goes back to the default, which the page shows. A send that would still put
  a project agent in another project is refused, and nothing falls back to
  someone else.
- **Any other global agent at the top** leads in the project on screen, or
  from home when there is none. It is not the cross-project conversation.
- The host enforces the same rule: `team_brief` refuses to make someone's
  report the lead of a **new** conversation (`team::reports_to_person`). A
  conversation that already has a lead keeps it, even if the chart changes
  later. Delegation inside a run is unchanged: an assignee must still be a
  direct report of whoever assigns it.

## The front desk

**Settings → Agents → Front desk** designates one global agent that every new
conversation opens on, in every project and in General. **Create front desk**
registers one in a step, with the router role, on the provider's smallest
model at its lowest effort (Claude Haiku, low; Codex Luna, low). The same row
changes what it runs on, and the next new chat uses it. With no front desk
designated, the page is the plain picker above.

- The person says what they want. The front desk's brief
  (`team::front_desk_brief`) lists only the agents who **report to the
  person**, with their role, their project scope and the names of the team
  under each, plus every project. That is the rule a conversation the person
  starts already keeps: anyone lower down is reached through the manager at
  the top of their chain, so a request for one of them goes to that manager,
  who hands it on. It routes to one agent, asks when two fit and nothing
  tells them apart, and says so when none fits.
- To route, it calls `route_chat` (`/hook/route`). That records a **route**,
  a handover of kind `route` (`handover/route.rs`), and draws a card in its
  chat with the agent, the project and the brief. Nothing is created until the
  person confirms on that card. Confirm then starts an ordinary chat with
  that agent, on its registered provider, model, effort and access, exactly
  where a conversation the person started would run: a project agent in a new
  worktree of its project, the head as its cross-project conversation at
  home, any other global agent in the named project or at home. The brief,
  as the card showed it, is the first message, followed by the agent's usual
  lead brief, and the page goes into that chat. Attachments are copied to a
  folder of the route's own, which the new chat may read. A file that could
  not be given is named on the card. A newer proposal replaces a pending one.
  Cancel leaves no record and no file.
- **A discussion is worded as one, and nothing else.** When the person wants
  to talk something through rather than have it done, the front desk passes
  `purpose: "discuss"`. The route keeps that on its record (`route.discuss`),
  the card asks to discuss, and the first message ends with a line saying the
  person wants to talk it through first (`route::DISCUSSION_NOTE`). It opens
  in the same place and on the agent's registered provider, model, effort and
  access, like any route: `purpose` never changes a chat's settings, at the
  proposal or at confirm, where they are read from the registry again. A
  discussion recorded by an earlier build at read-only access confirms on the
  agent's registered settings too, with today's line in its first message.
- **A new process for a registered agent's own conversation is never
  started below that agent's registered access.** The host decides it, at
  the one door every process start goes through (`agent_chat::start_session`,
  `level_to_start_at`), from the roster as it is at that moment. So a chat an
  earlier read-only discussion left at read starts at its agent's level
  again whoever starts it: the page (`chat_start`, `chat_complete` with
  `start`, the run panel's Continue), or the host (a queued message carried
  into the next process, a continuation, the resume after a usage limit, a
  run's notification, a late answer told to the chat that asked).
  - **It only raises.** The level asked is compared with the registered one
    by the host's own ranking (`access_request::rank`), and no level asked
    counts as the lowest. A level asked at or above the registered one is
    kept as asked, so a raise the person approved is not lost, and moving an
    agent's registration down lowers no chat.
  - **A process that is already running is never touched.** The rule is
    about a start. A chat the person lowers with the access picker keeps
    that level for as long as its process runs, and is at its agent's
    registered level again in its next process.
  - **Which chats.** Only the chat's own voice, and only while the agent its
    lead record names (`team::registered_access_of_chat`) is on the roster.
    Started exactly as asked: a room seat; a worker's chat, told by its key
    or an attempt on record (`is_worker_chat`), whose level comes with its
    task; the front desk's own chat, whose launch is read-only (see **It
    only routes** below); a chat no lead record names, such as an ordinary
    chat or a PR dashboard's Study or Review chat; a chat whose agent was
    removed; and any chat while the roster or the ledger cannot be read,
    because what is unknown is not read as a level.
  - **The level is recorded as any start's is**: in the start settings the
    host resumes from, and in the ledger for a chat a run knows.
  - **The page is told, and the host keeps the chat index true.** When a
    chat's own process is started at a level that is not the one on its
    index entry, the host writes the entry (`chat_index::set_access`) and
    says `chat-access-changed` on the bus, with exactly `{ "chatKey":
    "chat:…", "access": "read" | "manual" | "edits" | "auto" | "full" }`.
    It says the same when the level started at is not the one that was
    asked. That is for any start, raised or not, and it is the one way a
    page learns the level a process really runs at. Nothing is said when
    nothing differs. An entry with no level means read.
  - **A page's save does not change the level of a running chat.** A page
    saves the level it holds, which may be the one it asked for a moment
    before the host raised it. For a chat with a live process
    `chat_index_save` writes the process's level instead (the session
    table and `ChatManager::levels`, which a start and `chat_set_access`
    both record), looks again after the save for a process that started in
    between, and tells the page with `chat-access-changed` when it named
    another level. With no process the save stands: it is the person's
    choice for the next start, which the rule above may raise.
  - **Not covered.** A late answer told to a chat after a server restart
    (`continue_origin`) starts from the settings saved with the question
    when nothing is in memory. For a chat the person had since LOWERED
    those are stale in the other direction: it is resumed at the older,
    higher level, which is at or above the registered one and so kept as
    asked. That is open. A page that never took `chat-access-changed` (a
    tab on an older build) and saves the level it holds once the process
    has ended puts the entry back to that level: the next start is raised
    again, and until then a run's notification to that chat after a server
    restart is refused, as for any chat whose index entry and ledger
    settings disagree (`The chat's saved settings changed. Continue it in
    Chat…`). And a level the chat's provider does not offer is handed to
    it as registered (a Claude agent registered at Accept edits whose chat
    runs on Codex): each provider maps the level itself, as it did before.
- **Nothing tells an agent or the person that a discussion is read-only**:
  not the host, its MCP server or the text they give an agent.
- **Writing beside a worker.** A chat the person drives is not refused for
  writing beside an orchestration worker (`chat_workspace_access`): the
  person often runs several chats in one direction, so the chat is let
  through and a line in it names the task writing there, once per task
  (`octiq_writer_beside`). Only an orchestration worker's own chat is still
  refused, so a Mission keeps one writer at a time, and the Git panel keeps
  the strict check (`require_workspace_access`). A worker's managed worktree
  is shared only by a chat working inside it, the same rule dispatch keeps
  (`shares_checkout`). A route whose start is refused all the same (a
  workspace being cleaned up, the agent's CLI failing) offers Try again and
  Give up, the second only while the host has made sure no chat started
  (`abandonable`). There is no read-only way out of a refusal: the command
  `handover_discuss` was removed, and a page that still sends it gets the
  ordinary answer for a command the backend does not have.
- The host checks scope at the proposal and again at confirm, and refuses a
  route to the front desk itself, to an agent who does not report to the
  person (naming the manager at the top of its chain,
  `route::not_a_direct_report`), or from any chat that is not a front-desk
  chat. An agent moved under a manager after the card was drawn is refused at
  confirm.
- **A front-desk chat is hidden** from the sidebar, Recent, project pages,
  search and the resume list, by its identity on the host
  (`team::FrontDeskChat`). It is never saved to the chat index, so the next
  start removes its transcript, and a pending route goes with it
  (`handover::recover`). A route already confirmed is finished at that start.
  If it cannot be, the failure and the brief are written into the chat it was
  meant to open.
- **The way back is on the new-chat screen.** A front-desk chat left before
  it routed anywhere (a tap on New conversation or another chat) is offered
  under the front desk's welcome as **Continue with <front desk>**, newest
  first, at most three, each named by the start of what the person first said
  (`FrontDeskChat.opening`). The host lists them (`front_desk_unfinished`,
  `handover::route::unfinished`): the transcript is still on disk and no route
  from it is confirmed. A pending card or a failed start still counts as
  unfinished. Only the designated front desk's own chats are offered. After
  the next start removes the transcript, nothing is offered for it.
- **It only routes.** Every launch runs read-only and lite. On Claude it has
  no built-in tools, only `mcp__octiq__route_chat`, and its own system prompt,
  in permission mode `dontAsk` (never `plan`, which asks about a tool the
  allow rules name; never Full). A live access change on it is ignored.
  Its MCP offers nothing else. Every other agent hook refuses it by identity
  (`web::not_front_desk`). Codex has no single tool switch, so a Codex front
  desk is launched with every feature that brings a tool turned off (shell,
  web search, apps, plugins, sub-agents, goals, images, browser and computer
  use, hooks, memories), each of the person's own MCP servers turned off by
  name (read from `codex mcp list --json` in the chat's folder; a list it
  cannot read stops the launch), only `OCTIQ_FRONT_DESK` added to what its MCP
  may see, `route_chat` approved (read-only is approval policy `never`, which
  fails an unapproved call), and the front desk's own host prompt. What
  Codex 0.158 still offers beside `route_chat` has no switch: its question
  card, `view_image` and the MCP resource readers.
- The head and any agent who manages others cannot be the front desk, and
  nobody can report to it. Designating an agent changes none of its earlier
  chats.

## Where a new task runs (automatic, with Advanced overrides)

The project, branch, worktree and sandbox controls are hidden on a new task.
They are still decided: `lib/agentExecution.ts` (`autoExecution`) chooses them,
and the send path applies exactly that plan:

- **The head** coordinates from the home workspace (below), whichever page the
  conversation was started from. No git is prepared and no sandbox is started
  for the conversation. Every task it hands out gets its own destination and
  environment from the host.
- **A lead in a project** starts in a **new worktree** of that project, based
  on the branch the project is on. The host resolves the base and creates the
  worktree (`git_prepare_chat_workspace`). A folder that is not a repository
  runs in place. The primary checkout is where the person and other chats work,
  so a lead doing the work itself does not write there.
- **No code project** → the home workspace, no git.

The sliders button next to the agent opens **Advanced**, which is the
ordinary location shelf. Only the fields the person changes there override the
automatic plan, and the button is tinted while they do. The chosen plan is
recorded on the chat once, before its first turn (`ChatMeta.launch`,
write-once in `chat_index::upsert`). It is shown as the **planned**
environment and never as a verified fact.

## Home workspace

The head's conversations live in the **home workspace**, a registered workspace
chosen in **Settings → Agents → Home workspace** and stored as an id in
`team.json` (`home`, `team_home` / `team_home_set`; only a registered
workspace is accepted). With none chosen, or the chosen one removed, it is the
project named **General**, created lazily as before. No machine path is
hard-coded: on this machine General is simply the registered project at
whatever folder the person gave it. Entering the conversation never asks for a
project or a Git setup.

## Environment details (planned vs verified)

The task panel behind the status line (`ChatTaskBar`) has an **Environment**
section: the agent (avatar, name, state, provider/model), project, repository,
working directory, branch, base branch, target, checkout (primary checkout or
task worktree, and its path), sandbox and git state. Each path has a Copy
button. `lib/taskEnvironment.ts` merges two sources and labels every row:

- **Planned**: the chat's `launch` plan, or, for a worker chat, its orchestration
  task's destination and workspace plan (latest attempt, so retries show the
  one running).
- **Verified**: `chat_task`'s git verification of the chat's own directory,
  with when it was checked. The sandbox is reported by its own state.

**Stale** (the directory is gone and git was read from the primary checkout),
**Removed** (a cleaned or deleted worktree) and **Not verified** are never
drawn as verified. A base branch is always Planned, because git keeps no record
of it.

## Persona: names and avatars

A chat handed to a registered agent speaks as that agent: its name and avatar
sign replies, the composer and its working indicator, the sidebar row, the task
board, the plan review and the Run panel. Web and push notifications say
"<name>: …". Identity is the registration id (`lib/agentPersona.ts`), so a
rename or a model change updates every label, and a removed agent keeps the
name the work was handed to. Ordinary chats keep the provider's name. A title
the person or the agent chose is never replaced.

Each agent can have an **avatar** (`team.json` `avatar`, a PNG/JPEG/WebP
`data:` URL that `agent_avatar::checked_data_url` checks by magic bytes, under
512 KB). Without one, initials on a stable tint are drawn, with an accessible
label. In the hire/edit form:

- **Upload image**: PNG, JPEG or WebP up to 8 MB. The browser crops it to a
  256px square (`lib/avatarImage.ts`) before it is stored.
- **Generate with ChatGPT**: runs `codex exec` with Codex's built-in image
  generation (`$imagegen`, gpt-image) through the person's own Codex CLI
  **ChatGPT sign-in**. It counts toward that account's Codex usage. There is no
  API key and no reading of credentials. `agent_avatar_status` says honestly
  when it is unavailable: Codex missing, not signed in, signed in with an API
  key, or the feature off. It also gives the fix, and upload still works. A job
  runs in its own folder with a 5-minute deadline. At most two run at once, and
  one can be cancelled. Leaving the form cancels it. The output is re-checked:
  a regular file, not a symlink, and a real image. The picture is previewed
  beside the current one. **Use this**, **Regenerate** or **Discard**; nothing
  is saved until **Save**.

The switch is stored per browser (`octiq.agentsMode`). Registered agents are
stored on the server, so every browser sees the same team.

## Talk to your lead (the CTO conversation)

**Settings → Agents → Talk to** picks one **global** agent as the lead you talk
to across projects — typically a CTO. It is configured, never inferred from a
name, and stored in `team.json` (`head`). Only a global agent qualifies; the
host refuses to move it into one project while it is the head, and removing it
clears the setting. With none configured, a new conversation starts on another
agent at the top of the chart (above). With no agent reporting to you at all,
**New conversation** opens Settings. A head that has been put under a manager
is someone's report, so it is not offered until it reports to you again.

It is the default of every new conversation, whatever project is on screen.
Its conversations live in the home workspace and are recorded as cross-project
lead records (`crossProject: true`). A conversation keeps the lead it was first
handed to: when you configure a different head, the next new conversation
starts with it, and the host refuses to hand an existing conversation to anyone
else (`team::record_lead`), so no history is silently retargeted.

The head's brief lists its direct reports from every project, each marked
"works in any project" or "works only in project X", and tells it to:

1. call `orchestration_destinations` for the registered projects, their
   repositories, and which of its reports may work in each;
2. give every task a destination — `project` and, when the project has more
   than one repository, `repository` — on `orchestration_task_create`; one
   objective may span several projects and repositories, one task per
   destination;
3. ask you only when the destination is genuinely ambiguous, and otherwise say
   which it chose.

## Task destinations and scope

The host resolves every destination (`orchestration/destination.rs`); the
agent's word is never taken:

- Only a **registered project**, and only a **repository registered on it**
  (its main folder or one of its other folders), is a destination. Any other
  path is refused.
- A **global** agent may route anywhere. A **project** agent — manager or
  assignee — works only in its own project. So the head may give a
  project-scoped report work in that report's project and nowhere else, and a
  project-scoped lead cannot send work out of its project.
- The assignee must still be a **direct report** of whoever is assigning.
- An explicit destination that does not resolve is an error listing what is
  registered. Nothing falls back to the coordinator's checkout.
- In the head's conversation a task must have a destination. Naming a report
  who works in only one project is enough to name that project; a project with
  several repositories still needs `repository`.
- A task created in an ordinary project-bound lead chat without a destination
  runs in the run's own checkout, exactly as before destinations existed.
- A manager's subtask runs where its parent does unless it names another
  destination within its own scope.

The destination is stored on the task and carried through the worker chat
(which belongs to the destination project and gets its environment), the task
workspace and lease, execution, retries and review. It is checked again before
every worker start; a destination deleted since approval stops the task.
Worker provider, model, effort and access still come from the assignee's
registration.

## Registered agents and the org chart

Each agent has a name, a role, a provider (Claude or Codex), an explicit model
(never the CLI default), an effort level and an access level. It is either
**global** (every project) or belongs to **one project**. Two agents that could
appear in the same project cannot share a name.

Each agent may **report to** another agent. An agent with no manager reports to
you. The host refuses loops. It also refuses a manager that isn't available
everywhere its report is: a global agent reports only to a global one. Deleting
a manager moves its reports up to its own manager.

Fable and Astra agents are marked **lead only**. They can receive a task, but
orchestration rejects them as workers, so they cannot be assigned one.

Stored in `<profile dir>/team.json` (`team.rs`), together with a record of
which chats were handed a task and to whom (`leads`), and the configured head
(`head`). Commands: `team_list`, `team_save`, `team_delete`, `team_brief`
(`crossProject` for the head's conversation), `team_leads`, `team_head`,
`team_head_set`, `team_policy`, `team_policy_set`.

### Agent policy and persistent prompts

The **role** (2000 characters) says who an agent is and what it covers: it is
what other agents and the front desk read when they choose whom to ask. Two
more texts carry the rules an agent works BY, and only the agent itself reads
them:

- The **agent policy** (Settings → Agents, 4000 characters, `agent_policy` in
  `team.json`) is the person's shared rules for every registered agent.
- Each agent's **persistent prompt** (the agent form, 8000 characters,
  `persistentPrompt` on the agent) holds its standing instructions: runbooks,
  tool rules, build flows.

`team::standing_brief` puts them, in that order and each only when non-empty,
ahead of the agent's role in every brief it is launched with: a conversation
the person starts (`lead_brief`), a handover and a front-desk route (the same
brief), the front desk's own brief, an orchestration worker
(`team::assignee_brief`, after the task's dispatch and before its memory) and
a peer-help answer (`peer::helper_prompt`). Wherever an agent is LISTED to
another (a lead's roster, the front desk's roster, a peer roster,
`orchestration_destinations`, a route card) only its role is shown. An edit
reaches new chats and new attempts; a chat already running keeps the brief it
started with.

### Registering agents from a chat

An agent can be asked to hire, adjust or remove agents, and to make or change
a peer-help team, through seven MCP tools (`team_tools.rs`,
`POST /hook/agents`):

- `agent_list` reads the roster, the peer-help teams and the projects, with
  their ids, each agent's `persistentPrompt`, and the `agentPolicy`. It needs
  no approval. Each agent row carries `teamId` and `team`, its team's id and
  name, both `null` when it is on no team. Each entry of `teams` is
  `{ id, name, projectId, members }`, with `members` the names of the agents
  on it in registration order. A listing scoped to one project still names
  every member of a team.
- `agent_register` and `agent_update` only **propose** a change. Projects,
  managers and teams may be named by id or by name. An update keeps every
  field it does not name, and `""` clears one that may be empty.
- `agent_delete` only **proposes** removing one agent, by id or name. The
  card names the agent with its role, project and manager, says when it is
  the head or the front desk, lists the direct reports that will move up to
  its manager, and says that its memory note is kept. It is removed with
  `team::delete_unchanged`, which holds the person's Allow to everything the
  card said about the chart (`team::Removal`): the agent's version, its
  manager, the set of its direct reports, and whether it is the head or the
  front desk. If any of them changed while the card waited, nothing is
  removed and the agent is told to propose it again. A report that moves up
  becomes a new version of itself, so a card still waiting on that report is
  refused too.
- **An agent with work in progress is not removed** (decided 2026-10-11), by
  the tool or by the page's `team_delete`. Work in progress, read from the
  ledger by agent id (`orchestration/agent_work.rs`), is a task with an
  unsettled attempt of the agent's (being prepared, running, or blocked on an
  open decision), a task whose automatic retry the host has scheduled, a
  task of its whose workspace the host is preparing or cleaning up, and a
  peer request in flight that it asked for or is asked to do, from the plan
  card until it ends. The refusal names how many tasks and in which runs,
  and what to do: `Nova still has 2 tasks in progress in 1 run: 2 in "Ship
  the feature" (run_…). Nothing was removed. Stop them or wait for them to
  finish, then remove Nova.` A lease left on a settled task's retained
  workspace is not work in progress: it stays until cleanup.
- **Coordinating is work in progress too**, and so is answering. Neither is
  a task: a coordinator is not the assignee of anything in its own run. Both
  are asked of the conversations the agent speaks in as itself
  (`team::OwnChat`: the ones it leads, the head's cross-project one among
  them, and its front-desk chat). One of them coordinating a run that has
  neither finished nor been stopped refuses the removal: `Lead is
  coordinating "Ship the feature" (run_…), which has not finished. Nothing
  was removed. Stop that run from its chat or wait for it to finish, then
  remove Lead.` So does a turn in flight in one of them: `Lead is in the
  middle of a turn in a conversation it leads (chat:…). Nothing was removed.
  Stop that turn or wait for it to end, then remove Lead.` A front desk's
  says `its front-desk conversation`. A head or front desk that is merely
  idle is not held: the card already says the seat empties.
- **The check and the removal are one step, and a start cannot land between
  them.** The tool is refused before any card. A card can wait while a task
  starts, so everything above is asked again when the person answers, and the
  page's `team_delete` asks it there too. That second asking is not a check
  followed by a write. The roster's `delete` hands its write to a guard
  (`team::Leave`), and the host's guard (`agent_work::Departure`) takes the
  ledger's lock, asks, saves the agent as removed in the ledger
  (`removed_agents`), writes the roster without the agent, and only then
  lets go. Every start takes that same lock to reserve its attempt
  (`reserve_attempt_for`). So one of the two always goes first, and the other
  is refused: a start that got there first is work in progress and the
  removal is refused; a removal that got there first has the start refused,
  `Nova is no longer a registered agent: it was removed, and nothing starts
  as an agent that is gone.` The lock order is the roster's lock, then the
  ledger's, and nothing takes them the other way round. The chats' locks
  come after both and are never waited for: each is tried, and one that is
  taken answers "working", so the removal is refused and can be asked again.
- **A removal is done only when its record is** (review of 931b5f0). Two
  files change, the ledger and the roster, and the order is the one whose
  every failure leaves the agent registered and working:
  1. The ledger is saved with the agent in `removed_agents`. If that fails,
     the removal is refused and nothing was changed: `Nova was not removed:
     the ledger could not record the removal, so nothing was changed (…).
     Nova is still registered and its work still starts. Fix what stops the
     ledger from being saved, then remove Nova again.`
  2. The roster is written without the agent. If that fails, the record is
     taken back and the removal is refused: `Nova was not removed: the
     roster could not be written (…). Nothing was changed, and Nova is still
     registered.` If the record cannot be taken back either, the refusal says
     that as well: the ledger on disk still calls Nova removed, this server
     goes on starting its work, and the record is dropped at the next save
     and the next start.
  3. Only then does the running server treat the agent as gone.

  So "removed" always means both: the roster no longer has the agent, and
  the ledger refuses its work, now and after a restart. A server killed
  between the two writes leaves the one state that disagrees, a ledger that
  calls gone an agent the roster still has. The roster is right: when the
  ledger is loaded, each such record is dropped and logged
  (`reconcile_removed`, from `Services::load`). A roster that cannot be read
  changes nothing: nobody is taken for gone, and no record is dropped.
- **A message and a removal never both go through** (review of 931b5f0).
  Looking at a chat and finding it idle is not enough: a message could be
  written to the agent between that look and the roster's write. So the
  removal marks first and looks second (`agent_chat::Leaving`). It puts a
  mark on every conversation the agent speaks in as itself, then asks each
  one whether it is working, and a live process takes the mark in the look
  that finds it idle, under its own lock. Every prompt is written under that
  lock by one function (`write_user_message_locked`: a message, a queued
  message handed over at a full stop, a host notification, a completion's
  wrap-up), which refuses a session that carries the mark; and a process is
  put in the session table by `start_session`, which refuses a chat the
  mark is on. Either the write came first and the removal saw its turn, or
  the removal came first and the write saw the mark: `Lead is being removed,
  so this conversation takes no message right now. Nothing was sent. Send it
  again in a moment: if the removal is refused, the conversation carries
  on.` Working, for that look, is a turn in flight, a stopped turn whose
  full stop is still owed, anything queued, and a one-shot process being
  replaced. A removal that is refused or fails takes the mark off again. One
  that is made leaves it: `Lead was removed, and this was Lead's
  conversation: it takes no more messages. Nothing was sent. Start a new
  conversation with another agent.` The mark is in memory only, so a restart
  forgets it; after one, such a chat is an ordinary chat with no registered
  agent, as it was before this rule.
- **Unfinished tasks do not stop a removal, and do not start afterwards.** A
  task of the agent's that is planned, ready, failed or blocked with nobody
  working on it keeps the agent's name (`TaskAssignee` is a copy). The card
  says how many there are, in an `Unfinished tasks` row with the count as its
  summary, so the person can reassign them first. Once the agent is gone no
  start of such a task is accepted, by anyone: it waits until the lead hands
  it to another agent (`orchestration_task_reassign`, which goes to the plan
  card). Before this rule such a task started with the agent's provider and
  model and none of its role, brief or memory. The count is not part of what
  the Allow is held to.
- `agent_policy_update` only **proposes** a whole new agent policy (`""`
  clears it), on the same card. It is saved with `team::set_policy_unchanged`,
  so a policy edited meanwhile is not overwritten.
- `team_create` and `team_update` only **propose** a peer-help team or a
  change to one, on the same card. See
  [Teams from a chat](#teams-from-a-chat).

The card lists an agent's role with its other fields, never its persistent
prompt, except when the proposal itself sets or clears it: then the card shows
the exact text that would be saved.

The host turns a proposal into the draft the Settings form would send, and
runs it through the same rules (`team::check`, the dry run of `team::save`). A
proposal those rules refuse never reaches you. One that passes goes on the
ordinary permission card in the chat that made it, worded as the change:
every field of a new agent, or `field: before → after` for an existing one.
That card is **one-off**: it has no Always, and an earlier Always does not
answer it.

Only Allow saves the change. An update is saved with `team::save_unchanged`,
so an agent edited in Settings while the card was up is not overwritten. A
decline, no answer, or nobody having OctiqFlow open saves nothing, and the
agent is told which of these happened. The card stays up for three minutes in
a Claude chat. In a Codex chat it stays up for 50 seconds, because Codex gives
an MCP call about a minute; a longer wait could save a change the agent had
already been told failed. An orchestration worker may list agents but not
change them, and stays a worker for this after its attempt has settled: the
host refuses by the chat's worker identity, before any card is put up. An
additional agent in a room (a seat: its capability proves the chat, not the
chat's registered agent) may list them too, and is refused every change the
same way: register, update, delete, the policy and both team tools
(`web.rs` `roster_seat_refusal`). A front desk may do neither. Every save,
from a chat or from
Settings, sends `team-changed`, and every open page reads the roster again.

### The card's change as rows (`changeFacts`)

The card's `tool_input` carries the change twice: `change`, the text above,
and `changeFacts`, the same change as data. A page draws its rows from
`changeFacts` and never reads `change` back apart, because a role, a prompt
or a policy may itself hold a line that reads `Access: edits → full`.
`change` is unchanged, and it is all an older page or a saved transcript has.

```json
"changeFacts": {
  "lead": "Change the agent Nova.",
  "rows": [
    { "label": "Access", "before": "edits", "after": "auto" },
    { "label": "Persistent prompt", "value": "Stand up daily.\nShip on Fridays." }
  ]
}
```

- `lead` is the card's first sentence: what is being done, and to whom.
- A **plain row** is `label` and `value`: a field stated whole.
- A **move** is `label`, `before` and `after`: a field that changes. `before`
  is never empty. An empty `after` means the field is cleared, which only
  `Persistent prompt` and `Policy` can be.
- Every value is the whole text with its newlines. A label is one of a fixed
  set and appears once in a card.
- A plain row may also carry **`summary`**: what the row comes to, as one
  line of at most 160 characters (`team_tools::SUMMARY_MAX`), with no line
  break in it. It is for a card too folded to show the value: the page shows
  the summary whole there and never cuts a piece out of `value`, whose end
  need not say anything (the last 60 characters of 300 names are names). The
  key is absent, never empty or `null`, when the host has nothing shorter to
  say than the value, and a row without it is sent exactly as it was before
  the key existed. `value` is unchanged by it and still whole.

Four rows carry a summary today. The first is the reports row of
`agent_delete`:

```json
{
  "label": "Direct reports",
  "value": "Dev, Ops will report to Potato.",
  "summary": "2 direct reports will report to Potato"
}
```

It reads `N direct reports will report to X`, or `1 direct report will report
to X` (`team_tools.rs` `reports_summary`). `N` is counted from the roster and
`X` is the manager as the `change` text words it, `the person` included;
neither is read out of `value`. A manager's name too long for the line keeps
its start and ends in `…`, and the count and `will report to` are never cut;
a name saved through OctiqFlow is at most 60 characters and always fits. A
removal that moves nobody has no reports row.

The other three are counts of what their value lists or says at length:

| Card | Row | Summary |
| --- | --- | --- |
| `agent_delete` | `Unfinished tasks` | `3 unfinished tasks in 2 runs still name it` (`1 unfinished task in 1 run still names it`), the ledger's own count. |
| `team_create`, `team_update` | `Other teams` | `2 agents leave another team` (`1 agent leaves another team`). The row says what the change does to teams the card is not about, which a folded card would otherwise show as a size. |
| `team_create` | `Members` | `5 members` (`1 member`), when the team starts with any. |

A summary is one line whatever it is made from. A character that ends a line
is a space in it: a line feed, a carriage return or any other control
character, and Unicode's own line and paragraph separators (U+2028, U+2029),
which are not control characters and which the page refuses a summary for
(`askDetail.rowSummary`). `Head`, `Front desk` and `Memory note` are short
sentences and carry none. A row that moves never carries one: a changed
team's `Members` is a move, and who joins and who leaves are the `Added` and
`Removed` rows beside it.

A page's check of `changeFacts` is all or nothing, an unknown key included
(`web/src/lib/askDetail.ts`), so a page that does not know `summary` shows the
`change` text for a card that carries one, never rows with a part left out.

Which rows each card carries (`team_tools.rs`: `facts`, `delete_facts`,
`policy_facts`, built from the same values as the text):

| Card | Rows |
| --- | --- |
| `agent_register` | A plain row for each of `Name`, `Role`, `Provider`, `Model`, `Effort`, `Access`, `Available in`, `Reports to`, `Team`, then `Persistent prompt` when one is proposed. |
| `agent_update` | A move for each of those fields that changes, and no row for one that stays. `Persistent prompt` comes last when the change touches it: plain when it is set where there was none, a move when it is replaced or cleared. |
| `agent_delete` | A plain row for each field but `Name`, which the lead carries. Then what the removal does to the chart, each a plain row holding a sentence: `Head` or `Front desk` when that seat empties, `Direct report` or `Direct reports` naming who moves up and to whom (with a summary), `Unfinished tasks` when tasks nobody is working on still name it (with a summary), and `Memory note` last. |
| `agent_policy_update` | One `Policy` row: plain when a policy is set where there was none, a move when it is replaced or cleared. |
| `team_create` | Plain rows `Available in` (always `every project`) and `Members` (the names, with how many as its summary, or `none`), then `Other teams` when a member is on another team (with a summary), then `Membership`. |
| `team_update` | `Name` as a move when the team is renamed. When its members change: plain rows `Added` and `Removed`, each only when there are any, then `Members` as a move from every member before to every member after (`none` for an empty team). `Other teams` when an agent it adds is on another team (with a summary), then `Membership`. |

`Other teams` holds one sentence for each agent that leaves a team to join
this one: `Bo leaves Ops. Cy leaves Web.` `Membership` closes every team card
with the same fixed sentence (`team_tools::MEMBERSHIP_GRANTS`), because the
card moves who is on a team and this is what being on one grants: `Teammates
may ask each other questions and request bounded work, and each request for
work is approved separately.` The team rows are `team_tools.rs` `team_rows`,
and the `change` text is those rows, one to a line.

A replaced or cleared prompt or policy carries the current text in `before`.
The `change` text leaves that out, so this is the one place the rows say more
than the text.

`changeFacts` is all or nothing. A card whose change cannot be told whole as
rows is sent without the key, and the page shows `change` as text. The
Lessons card (`vault_agent_memory_lessons`) is sent that way today.

## Teams and peer help

A **team** is a named group of agents who may ask each other questions while
they work. It sits beside the org chart, not in it: joining or leaving a team
never changes who reports to whom, where an agent may work, its access, or
plan approval. Teams are managed in Settings → Agents (add, rename, remove),
and an agent is put on one from its own form (**Team**, with None). One team
per agent. A team is global or belongs to one project; a global agent may join
any team, a project agent only a global team or its own project's. Removing a
team leaves its members registered on no team; removing an agent takes it off
its team. The team shows as a badge on the org chart and on the Agents page.

Stored with the agents in `team.json` (`teams`, and `teamId` on each agent).
Commands: `agent_team_list`, `agent_team_save`, `agent_team_delete`. A
`team_save` with no `teamId` keeps the agent's team; `""` takes it off.

### Teams from a chat

An agent that may propose an agent may propose a team, with two MCP tools on
the same hook and the same one-off card as `agent_register`
([Registering agents from a chat](#registering-agents-from-a-chat)):

- `team_create` takes `name` and optional `members`, each an agent id or
  name. The new team is global, so it can hold any agent. It may start empty.
- `team_update` takes `team` (id or name) and any of `name` (a rename),
  `addMembers` and `removeMembers`.

What they can and cannot do:

- **Membership only.** They never change an agent's manager, access, provider,
  model or project, and `team_update` cannot change the project a team belongs
  to; neither tool has a field for any of these, and an unknown field is
  refused. A team's project, and removing a team, stay in Settings.
- **One team per agent, and a move is said on the card.** Adding an agent that
  is on another team takes it off that team. The proposal is not refused; the
  card's `Other teams` row names the agent and the team it leaves, and that is
  part of what the person approves.
- **The rules of Settings apply before anyone is asked.** An empty or
  over-long name, a name another team has where the two overlap, an agent
  nobody is called, an agent already on the team, one to remove that is not on
  it, and a project agent on another project's team are each refused without
  a card. So is an update that names nothing to change.
- **The card is the only gate, at every access level.** The call changes
  nothing. `permission::host_bookkeeping` lists both tools, which only keeps
  Claude's plan mode from putting its own card in front of the host's. A
  decline, no answer, or nobody having OctiqFlow open saves nothing.
- **Allow is held to what the card said.** `team::team_change` works out
  everything the card states (`team::TeamChange`: the team's name before and
  after, its members before and after, and the team each added agent leaves),
  from the roster the agent's call read. On Allow,
  `team::change_team_unchanged` works it out again under the store's lock and
  saves only when the two are equal. A member who joined or left in Settings
  meanwhile, an added agent that changed teams or was renamed or removed, a
  renamed or removed team, or a name taken meanwhile each refuse it, and the
  agent is told to read `agent_list` and propose again.
- **A saved change is one write.** The team and every agent that joined or
  left are written together. Each of those agents becomes a new version of
  itself, so an `agent_update` or `agent_delete` card still waiting on one is
  refused. The reply is `{ status: "saved", text, team }`, with `team` as
  `agent_list` shows it, and every open page is sent `team-changed`.
- **Who may call.** The same chats as `agent_register`: an orchestration
  worker is refused by its worker identity, also after its attempt has
  settled, before any card is put up, and its MCP does not offer the tools. A
  front desk is refused at the hook.

A teammate helps in two ways, with two tools: a **question**
(`orchestration_peer_ask`) and one bounded piece of **work**
(`orchestration_peer_request`). Neither changes who reports to whom.

**Who may use them.** Two kinds of chat, by what the chat's capability proves
and never by an argument:

- the chat of a **running attempt** whose task was handed to a registered
  agent (a worker);
- a **registered lead's own agents-mode chat** (the chat `team.json` records a
  lead for).

A chat with no registered agent, a front desk, and an additional agent in a
room (a seat: its capability proves the chat, not the chat's agent) are
refused both tools. A lead is told who its peers are in its first brief and
again on every later turn (`team::lead_peer_brief`), a worker in its task
brief (`team::peer_brief`).

### A question: `orchestration_peer_ask`

**Peer help is a question and an answer, not a handoff.** The asker's brief
lists its teammates (name, role, id; for a worker, those who may look at the
task's project) and says that peers answer questions and do not do the work.
It asks with `teammateId`, `question` and optional `contextPaths` inside its
workspace. The host (`orchestration/peer.rs`):

- accepts the call only for a registered member of the asker's own team who
  may work in the project (the task's, or a lead chat's); asking itself,
  someone off the team or an unknown agent is refused with a message naming
  who it can ask;
- allows 5 asks per worker attempt (`MAX_ASKS_PER_ATTEMPT`) and 5 from a lead
  chat in any rolling hour (`MAX_LEAD_ASKS_PER_HOUR`), answered or not, takes
  questions of up to 4000 characters, and cuts answers at 8000;
- runs the answer as the teammate's registered provider, model and effort
  (a Fable or Astra teammate may answer: answering is not working a task) in a
  one-shot process in the asker's workspace, or a lead chat's folder, with
  read tools only (Claude: `--tools Read,Grep,Glob`, no MCP; Codex:
  `-s read-only`, `--ignore-user-config`), none of the chat's `OCTIQ_*`
  variables and a 10-minute deadline, so it cannot write, reach the
  orchestration hook, or ask a peer of its own. A lead's ask gets exactly the
  same process;
- records every ask in the ledger (`peerAsks` in the snapshot: question,
  answer or error, asker, helper, times, tokens) before the teammate starts,
  and settles it after; an ask cut off by a restart is marked failed on load.
  A worker's record names its run, task and attempt. A lead chat has no
  attempt: its record names the chat (`askerChatKey`) and, when the chat
  coordinates a live run, that run; `taskId` and `attemptId` are absent, and
  `runId` too when it coordinates none (the whole-ledger read still lists it).

The answer comes back as the tool result. The task view shows a worker's
exchange under the task's row (Peer help); a lead chat's ask has no task row
to sit under yet. No gate is involved: an ask reads and advises. Read-only
means no writes: a Codex teammate's sandbox can still read outside the
workspace.

### A piece of work: `orchestration_peer_request`

**A peer request is bounded delegation between teammates, approved by the
person.** It is how a lead hands a peer one piece of work without becoming its
manager. Arguments: `peer` (id or name), `title`, `request` (the work, at most
4000 characters), `output` (the result expected back, at most 1000), optional
`project` / `repository`, and `maxMinutes` (default 30, at most 120): N
minutes of working time; waiting for a decision does not count; it is not
extended. The host (`orchestration/peer_request.rs`):

- **records one ordinary task and starts nothing.** The task is assigned to
  the teammate and carries `peerRequest` (`requestedBy`, `requesterChatKey`,
  `requesterAttemptId` for a worker, `output`, `maxMinutes`). It waits on the
  **normal plan card**, like any task added to an approved plan: the plan goes
  back to pending, its revision covers who asked and the bounds, and the
  request does not start before the person approves. Tasks they had already
  approved keep starting (see **What a waiting plan holds**). A run that never
  asked for approval asks from then on. There is no new card type.
- **puts the task where the requester's work is.** A worker's request joins
  the worker's own run, and that run's coordinator is told. A lead chat's
  joins the live run the chat coordinates; when it coordinates none, the host
  opens one for it ("Peer requests from <lead>", a mission like any run a lead
  opens, with automatic dispatch on) in the same write as the task.
- **asks only a teammate.** Anyone off the requester's team, the requester
  itself, or an unknown agent is refused with a reason naming its teammates.
- **sends work only where it may go** (`destination::route_lateral`): a
  registered project and repository, where the teammate may work and where the
  requester may send work. With no `project`, it is the requester's task
  destination or chat project; a teammate confined to one project works in
  that one. A teammate that cannot work there, an unregistered project, and a
  teammate on a lead-only model are each refused with the reason. This is the
  one path a task takes to an agent that does not report to whoever asked;
  `orchestration_task_create` keeps its direct-report rule untouched.
- **runs the teammate as itself**, under the destination's ordinary workspace
  policy: its registered provider, model, effort and access are copied onto
  the task, and any start with other settings (a coordinator's manual start, a
  page retry, a recovery with a fallback model) is refused.
- **bounds it** (named constants): 2 requests per worker attempt
  (`MAX_REQUESTS_PER_ATTEMPT`), 3 open at once per lead chat
  (`MAX_OPEN_REQUESTS_PER_LEAD_CHAT`), and `maxMinutes`. The scheduler's own
  pass (`expire_peer_requests`, no timer per request) ends an attempt that has
  used its time as **failed** with the reason `peer request time limit`, never
  retried; the same pass stops its process. See
  [The time limit](#the-time-limit) below.
- **keeps it one level deep.** A peer-request task cannot be split (no
  `parentTaskId` under it, by its worker or the coordinator), revised or
  reassigned (it can be withdrawn), and its worker cannot make a peer request.
  It may still ask a question. The lead → report → report's report rule is
  otherwise unchanged.
- **is one approved job.** A finished request is not reopened
  (`orchestration_task_reopen` is refused, from a chat and from the page): a
  follow-up is a new request, which the person approves.
- **gives whoever asked no instruction channel.** The requester is the
  worker's teammate, not its manager, so no agent's words reach the worker
  once it runs: `orchestration_message_send` to its attempt is refused for
  every kind of message, from a chat and from the page acting as the
  coordinator, and a coordinator opens no gate on the task. The teammate still
  writes to its coordinator, and its report comes back as before.
- **leaves its gates to the person.** A gate the teammate opens is answered
  only by the person, on the task board: the page sends the socket's
  `orchestration_gate_resolve`, which no hook action maps to, and a
  coordinator's `gate_resolve` (`orchestration_gate_resolve_in_chat`) is
  refused for it. The coordinator, and a requesting worker (`peer_waiting`),
  are told that it waits on the person. The teammate's brief states both
  rules as fact, and what reaches the teammate in the answer to a host call
  is carried as `hostNotices`, not `coordinatorMessages`: the person's answer
  to its gate, or a notice the host wrote.
- **shows it its own task and nothing else of the run.** The worker's
  `orchestration_snapshot` holds its task with its spec and card, that task's
  attempts and gates, the messages it sent, the notices addressed to it and
  the services registered for it; the run's objective is replaced by a fixed
  host line, and another `runId` or `taskId` is refused with the reason. It
  is held by the attempt on record (`OrchestrationStore::snapshot_for_agent`),
  so it still holds once the worker has reported or been ended; the
  coordinator, every other worker and the page read what they always did.
  What the requester wrote that the teammate can still read is whatever is in
  the shared Memory Vault, in the files of the workspace it works in, and in
  other chats' transcripts, which `search_conversations` and
  `read_conversation` read off the profile for any agent.
- **lets nobody but the teammate, the host and the person write what it
  reads there.** Everything in that view was written by the teammate itself
  (its report, messages, gates, status reports, services, validation
  checkouts), by the host from what it observed or in its own fixed words, or
  by the person. The run's coordinator is the teammate that asked, or speaks
  for it, so the writes it could make there are refused, from a chat and from
  the page acting as the coordinator: `orchestration_service_register` on the
  task (a service's name and recovery guidance are free text, and a
  registration replaces the one of the same name), `orchestration_validation_create`
  for it (the coordinator removes a leftover checkout only once the
  teammate's attempt has settled), and a `orchestration_worker_start` that
  names a `baseBranch`. The run's worker defaults
  (`orchestration_automation_configure`) are the coordinator's to change at
  any time, and their recovery policy names a fallback model in up to 64
  characters of its choosing, so a peer request takes nothing from them: it
  recovers under what was approved with the task, or the host's own default,
  as the identity it has. What the coordinator can still do to the task changes
  a status, a time or an id and carries no words: start or stop it, confirm
  the teammate's own held closing words with an outcome and a verdict, accept
  the result, refresh what git says of its branch, replace it with a new
  task.
- **never touches the roster.** Nothing in it reads `reportsTo` as changed or
  writes `team.json`; the store method is not given the file.

**The report comes back to the requester.** When the teammate's attempt
settles, the run's coordinator gets the ordinary durable report notice, which
for a lead requester is the requester; the notice says it is a peer request. A
requesting **worker** gets a `peer_report` notice of its own, delivered
between its turns or in the answer to its next call to the host
(`coordinatorMessages`), only while its attempt is still running; it also
hears when the person rejects the request, when the time limit ends it, and
when the host's automatic retry of a failed attempt cannot start (a fallback
model that is not the teammate's registered one, say), with the failure and
what stopped the retry. Either
way the report stays on the task (`result`, with `peerRequest.requestedBy` and
`status`) in `orchestration_snapshot`, and the run's coordinator accepts the
task as usual.

#### The time limit

**`maxMinutes` is N minutes of working time; waiting for a decision does not
count, while the host can see that nothing is running; it is not extended.**
The plan row says it (`requested by <agent> · N
min working time`), and so do the teammate's brief and the coordinator's
notice.

- **What counts.** The attempt's life, from the moment it is reserved to the
  moment it settles, less every stretch the host SAW it waiting with nothing
  running (`used_ms`). A wait is free only while the host can verify that, and
  every estimate errs toward charging. An answered decision gives nothing
  back: a peer that asks a question every 59 seconds of a one-minute request
  is ended at 60 seconds of work.
- **What a wait is.** The scheduler looks at each live attempt every two
  seconds. A look sees a wait when the attempt's chat is on a card only the
  person can answer (a permission question, or a Codex safety approval that
  continues the work), or a gate of its task is open, **and** the host sees
  nothing of the attempt running. Neither a card nor a gate stops a clock by
  itself, and both rest on that one answer (`Look::nothing_running`):
  - **A full stop that is owed is something running.** A turn that a Stop cut
    short counts until its own full stop has been read
    (`ChatManager::unwinding`): the chat is marked idle at once, but the agent
    has not said it stopped, so the window is charged until the full stop
    arrives or the process is ended for not stopping. A card that is up in
    that window does not change it.
  - **With no turn in flight, nothing is.** That is the `busy` the idle
    reaper trusts, read through `ChatManager::turn_in_flight`: from a write to
    the agent's stdin until that turn's own full stop. An open gate, or a
    Codex safety approval, is a wait from here on. Opening a gate under a
    running turn stops nothing: the attempt is working, is charged, and is
    ended at its limit with the gate open. The teammate's brief says to end
    the turn after opening a gate.
  - **A turn in flight is working, unless it is parked on the person.** It is
    parked when every card names a tool call that the attempt's ledger of
    started, unreturned calls holds (`execution.pendingTools`), and that
    ledger holds no other call. Any other pending call makes the look working
    time: `permission` knows that one call waits on the person, not that
    another has stopped.
  - **How the host tells the card's call from another.** By the provider's
    own id for the call, which the card and the ledger both carry. Claude: the
    `tool_use` block's id, which its `can_use_tool` request repeats as
    `tool_use_id`, and which its stream announced before asking. Codex
    app-server: the item's id, which `item/started` carries and the approval
    request repeats as `itemId`. A Codex safety approval names no call at
    all, because the call it is about was refused, so it is a wait only once
    the turn is over. Antigravity cannot ask and raises no card. Every worker
    is one of those three (`worker_model` refuses any other agent), so every
    worker has a ledger.
  - **Where the host cannot place a call, it charges.** A card that names no
    call, or one the ledger does not hold (a provider or a hook with no tool
    ledger), is not proof of anything, and the look is working time. So is a
    call the ledger shows beside the card's own even when it is only queued
    behind it, and the call of a sub-agent that waits on a card of its own
    inner call: the ledger says a call started and has not returned, not
    whether it is running. This errs toward the limit the person approved. It
    costs them nothing while they decide, because an attempt is never ended in
    front of a card; what it can cost is that an attempt which sat on their
    card past its limit is ended once they answer, with the reason, and
    starting it again is theirs (Start retry).
- **Bounds, not guesses.** Free time is only the time between two looks in a
  row that both saw the wait, with no line of the agent's stream arriving
  between them (`Wait`, `{from, to}`). The clock is read before and after each
  look; a wait opens at the later reading and is extended to the earlier one.
  Nothing is counted back to the look before the first sighting or on to the
  look after the last, so a wait seen by one look is no time at all.
- **It never goes down.** `peerClock.usedMs` is the most the attempt was ever
  found to have used, what it carried in included. A wall clock that steps
  back leaves it there, and the next attempt carries it.
- **Where it is kept.** In the ledger: the attempt's `createdAt` and
  `finishedAt`, and its `peerClock` (`waits`, `usedMs`, `carriedMs`). A wait's
  end and `usedMs` move in memory on every look and are written every fifteen
  looks (about thirty seconds), and at once when a wait ends, the wall clock
  steps back or the attempt is ended. After a restart a wait counts up to its
  last write; the rest of it, and the time the server was down, is charged.
- **What it does not count.** The limit is on the attempt's life as the host
  can see it, not on every process the agent started. A background process
  the agent left running after its turn ended goes on under an open gate
  without being charged, because the chat has no turn in flight and its stream
  is silent. A tool call running beside a pending card IS counted: the ledger
  shows it. A turn that begins and ends between two looks is noticed only by
  the lines it writes to the stream. Ending the attempt stops the agent's
  process, not what that process detached.
- **It is never ended under the person.** Charging and ending are two things.
  An attempt a look sees waiting is not ended, even past its limit, and
  neither is one whose chat shows a card, whether that look was free or
  charged. It is ended by the first look that sees neither, and the reason
  says the limit was reached and that the host held it: until the wait was
  over, or, when something ran on beside the card, until the card was
  answered. A permission card expires after three minutes; a Codex safety
  approval stays until the person answers it, so an attempt that works on
  under one is charged all the while and ended when they do.
- **Nothing extends it.** There is no tool, argument or message that adds
  time. A longer job is a new request, which the person approves like the
  first.
- **A later attempt carries on; only the person starts a new limit.** The
  limit belongs to the request, not to one attempt of it. The host's own
  recovery after a provider failure, and a start the run's coordinator makes
  (an agent: a lead chat coordinates its own requests), begin with what the
  attempts before them used (`peerClock.carriedMs`) and are refused once
  nothing is left. A restart ends every live attempt, so the attempt after it
  carries on the same way; the time the server was down before the restart
  counts as used. The page's **Start retry** on the task is the person's own
  decision, as approving the request was: that attempt has the whole N
  minutes. No hook reaches it (`StartedBy::Page`).

A mission has one writer per repository at a time, so a writing worker's
request into its own repository starts only after that worker settles; the
tool's result says so, and the report then goes to the coordinator.

## Chain of command

Delegation follows the chart, at most **three levels**: lead → manager → worker.

1. The lead **does it itself** in its own chat (no run), **passes it on** to
   one direct report, or **splits it** among its direct reports. A lead with no
   reports is told to do the task itself.
2. A direct report that manages agents is told, in its worker brief, that it may
   split its own task once more among **its** direct reports. It calls
   `orchestration_task_create` with `parentTaskId` set to its own task and an
   `assignee`, then settles its own attempt. Anything that depended on its task
   now also depends on the subtasks. Subtasks cannot be split again. The host
   stamps such a subtask `splitBy` with the manager's attempt, and that stamp,
   never the parent id, is what lets it go by its parent's approval.
3. Everyone else only does their own task.

The host enforces each rule. In `dispatch.rs`, `orchestration_task_create`
resolves `assignee` and the destination together through
`orchestration::destination::route` (which uses `team::resolve_in` against the
destination project) and the right manager: the lead
when the coordinator of an agents-mode run creates the task, or the parent
task's assignee when a worker splits its own task. A task with no assignee in
an agents-mode run is refused. The store accepts a task from a non-coordinator
only from the active worker of the named parent, and only when the parent is
top-level and has an assignee. A coordinator may put `parentTaskId` on a task
of its own, and that makes it nothing but a task with a parent named on it: it
is routed as the lead's direct report, waits on the plan card and is approved
on its own. The assignee's provider, model, effort and
access become the task's worker settings, so a lead cannot misquote a teammate.

## Plan approval

Every run a lead opens waits for you (`run.planApproval`, always required).
The host starts a task only once you have approved it: until then it refuses
every start of that task, manual or automatic, and the scheduler leaves it out
(see **What a waiting plan holds** below). The lead creates all its tasks, replies with
the plan as a short list, and ends its turn. The run's **Plan ready for
review** view lists each task with who it goes to and **where it runs** —
project and repository, the full path in its tooltip; a task without a
destination shows the run's own project and checkout. **Approve plan** calls
the browser-only `orchestration_plan_approve`, which is deliberately left out
of the agent hook so no agent can approve its own plan. **Reject** opens a
confirmation with an optional one-line reason and calls the likewise
browser-only `orchestration_plan_reject`. To change the plan, reply in the
chat. Both decision buttons are disabled only while the lead is still drafting
and there is nothing to review yet.

The same review is also drawn **at the end of the lead's own chat**
(`components/ChatPlanCards`, `lib/chatPlans.ts`). It is the same component,
reading the same ledger snapshot, so the chat and the run panel always show one
state. A click in either shows "Approving…" in both and sends once
(`lib/planApproving.ts`). Each card is named **Plan &lt;handle&gt;**, the first four
hex digits of the run id, and carries its **revision**. An approved plan folds
to one line, "Approved in chat · revision 4". A plan the lead changes after
approval comes back as a new, waiting revision. It is never the old card with
the new scope. A rejection also leaves the transcript tail and folds to one
quiet **Plan rejected** line in run history, with its reason when one was given.

Approve and Reject enter the same store-locked decision transition, so only
the first wins. An identical retry returns that recorded decision; trying the
opposite decision says what the person already chose and changes nothing.
Rejecting the first, never-approved plan cancels its pending tasks and ends the
run as `stopped`; `stoppedReason` says the person rejected that revision, and
open gates or attempts are cancelled through the same transition as Stop.
Rejecting an amendment cancels only tasks that were never approved. A resize
or reassignment of an approved task keeps its prior approved state with the
ledger: rejection restores that size or assignment and its approval, while
other approved, running and completed work and their workspaces remain
untouched and the run stays live. `planApproval.rejection` records `{by,
revision, at, reason, taskIds, restoredTaskIds, surface, shownMs}` durably. The
host queues one `plan_rejected` continuation to the coordinator naming the
revision, reason, withdrawn new tasks and restored approved tasks; its wording
states that it is a decision record, not an instruction to make another plan.

### Approving by chat

You can also approve by telling the lead, as in "approve this plan", or
"approve plan 2278" when several plans wait. The lead calls the agent tool
`orchestration_plan_approve` (hook action `plan_approve` →
`orchestration_plan_approve_in_chat`) with only the run id and the revision it
showed. **The lead never passes your words.** The host decides on evidence
that only it holds:

- **Whose message.** The browser's `chat_send` / `chat_start` record your words
  by turn id before they are dressed for the agent (`ChatManager::
  note_person_turn`). They also record the plans on your screen at that
  moment, as `seenPlans` [{runId, revision}]. The chat session remembers
  which turn it is answering (`ChatSession::answering`, set by every write to
  the agent). A notification, a gate answer, an internal continuation or any
  agent-to-agent text has no such record, so it can never approve. Coalesced
  follow-ups join one record, so "approve" then "but change X" is read as one
  turn.
- **What it says.** `orchestration/consent.rs` accepts only a WHOLE message
  that is a plain approval: *approve / approved / I approve*, at most one plan
  referent, and politeness words (*please, thanks, ok, go ahead*). Any other
  word, a `?`, a quote, a second line asking for a change, a negation or a
  condition means the message is not consent. Generic assent on its own ("ok",
  "go ahead") never approves.
- **Which plan.** With more than one plan waiting, or more than one on screen,
  the message must name the handle.
- **Which revision.** Every write to the ledger recomputes a digest of what an
  approval would cover. That covers each waiting task's title, spec, card,
  owner, worker, destination, planned workspace and dependencies, plus the
  run's worker defaults and mode (`refresh_plan_revisions`, run inside
  `mutate`). Any change moves `planApproval.revision`. An approval is refused
  unless the revision you saw, the revision the lead names and the ledger's
  current revision are the same. The button sends its revision too.
- **Once.** A message that approved a revision cannot approve again
  (`planApproval.consentTurns`).

The approval is recorded on `planApproval.consent` as `{via, revision, at,
turnId, words}`. Plan approval covers only the plan. It never answers a gate,
a permission card, a deploy or a restart.

To change a waiting plan, the lead uses `orchestration_task_revise`. It can
edit a task, re-route it through the same routing as task create, or withdraw
it. This only works while the plan waits and the task is unapproved. Each
revision is a new revision you see before approving.

Each task in the review, and in the Run panel's task details, opens to the
**standard plan card** (`components/TaskPlanCard`, `lib/taskPlanCard.ts`).
It shows the project, work directory, branch and base, worktree status, owner,
model and effort as short facts. Then comes one line of **problem**, one line
of **goal**, and 2–5 **acceptance** criteria. The lead supplies those three
when it creates the task (`problem`, `goal`, `acceptance` on
`orchestration_task_create`). They are checked by `TaskCard::checked` and fixed
once created, like the destination. A work directory and branch the host has
not allocated yet read **Pending**. The workspace plan reads **Planned**, and
the attempt the host prepared reads **Confirmed**. A removed worktree reads
**Removed**. The lead's full brief stays one disclosure further in.

Approval is for exactly the plan you saw:

- The browser sends the ids of the tasks it showed as awaiting approval; if the
  lead added a task in the meantime the host refuses ("The plan changed while
  you were reviewing it").
- Approving stamps each task `approvedAt`. An approved task's destination
  cannot be changed — re-routing means a new task. Before approval the lead
  may revise it (`orchestration_task_revise`), which moves the revision.
- A task nobody is working on can change hands: `orchestration_task_reassign`
  gives it to another of the lead's direct reports, for example a designated
  backup taking over from the primary. The new owner is routed like a new
  task, so the org chart holds. The task keeps its card, destination and any
  workspace a settled attempt left, and records the handoff on
  `task.handoffs`. A new owner is not what you approved, so the task waits for
  you again and nobody, including the old owner, starts it meanwhile. A task
  with a running attempt is refused; stop that attempt first.
- The Approve button sends the revision and tasks it showed, the card it was
  clicked on (`surface`) and how long that revision had been on it
  (`shownMs`). A revision that replaced another less than 1.5 s before the
  click is refused, and the card holds its button that long after a change.
  Once approved, the plan leaves the chat; its record stays in the run panel.
- A task the lead adds **after** approval puts the plan back in front of you;
  it is marked **New** in the review. Running workers carry on, and so does
  every task you had already approved.

Only the top plan needs you. Managers split their tasks further without
asking, and only a manager's own split does (see **What an approval fixes**).

### What an approval fixes

`approvedAt` says that you approved a task. It does not say as what, and
until 2026-10-11 nothing held a start to it: an approved Manual task could be
started with Full access, and the run's defaults could change under a task
that had none of its own. An approval now records what it fixed, on the task
as `approved` (`orchestration/approval.rs`), from the values **in effect**
when you approved, so a task with no worker of its own takes the run's
defaults as they were:

| Fixed | What it is |
| --- | --- |
| `worker.agent`, `worker.model` | The provider and its model. |
| `worker.effort` | The effort, or none. |
| `worker.access` | The access level. |
| `worker.recovery` | The recovery policy, with its fallback model. |
| `assignee` | The registered agent the task was handed to. |
| `destination` | The project and the repository. |
| `baseBranch` | The base of the workspace the host planned. |

Every start is compared with it in `reserve_attempt_for`, the one door every
start goes through, before an attempt is reserved or anything is written: the
coordinator's `orchestration_worker_start`, the host's dispatch and its
automatic recovery, and the page's Start. A start that asks for anything else
is refused in words that name each difference, and nothing is started:

> The person approved this task as codex:terra at manual access for Dev in
> the run's own folder. This start asks for the worker codex:sol instead of
> codex:terra, and full access instead of manual. Nothing was started. Start
> it as approved; a change to what a task runs as goes back to the person on
> the plan card (orchestration_task_reassign, or a new task).

One model besides the approved one passes: the fallback the approved recovery
policy names, which you approved with it. A start that names no base branch
asks for the planned one. The record is never written by a start, a retry, a
recovery or `orchestration_automation_configure`; it is cleared with
`approvedAt` when a task goes back to the plan card (a new owner, a new size),
restored if you reject that amendment, and taken again when you approve it.

- **The run's defaults reach only what you have not approved.**
  `orchestration_automation_configure` after an approval changes the defaults
  and nothing about an approved task: its dispatch, its recovery policy and
  every start of it read `approved`. A task you approve later is fixed under
  the defaults of that later approval.
- **The page's Start is you, and changes nothing an approval fixed.** It
  retries an attempt with that attempt's settings and is held to the same
  comparison. What it may do that no agent's start may: start a task you
  stopped, and say the base branch of a peer request. A changed shape goes
  back to the plan card from the page too.
- **A task approved with no worker chosen** (none of its own and no run
  defaults, which only a run outside agents mode allows) has nothing of a
  worker for the approval to fix. Its first start chooses, as it always did
  there, and fixes it for every later one.
- **A ledger from before this record** gets one for each approved task on its
  first write, from what the ledger holds then (`by: "ledger"`).

**A parent id is not an approval.** Only a subtask its parent's own manager
split off goes by the parent's approval: the split path checks that the caller
is the live worker of that parent, routes the subtask to one of that
manager's direct reports, and stamps it `splitBy` with the manager's attempt.
Such a subtask is never on the plan card, and it runs only as the worker it
was routed to (`approved.by: "split"`). A task the **coordinator** creates
with `parentTaskId` is ordinary new work with a label on it: `approvedAt` is
null, the plan goes back to you with it on the card, `heldByPlan` is true, and
the parent's manager cannot accept it. The page reads the same stamp
(`planReview.awaitingApproval`, `taskAccess`, `missionPage.reassignBlocker`),
because the host refuses an approval whose task set is not exactly the one it
would approve. A subtask split before the stamp existed has none, so it is
treated as ordinary by both: under a pending plan it is on the card.

**A reopened task keeps its approval, and its shape** (your decision of
2026-10-11). `orchestration_task_reopen` gives a completed task new
instructions and makes it ready again without a new plan card. It changes
only the words: the next start is held to `approved` like any other, so a
reopened task runs as the same worker, for the same assignee, in the same
place, or not at all. The words are never changed out of sight. The task
keeps each reopen in `reopens` (`byChatKey`, `at`, `attempt`, `previousSpec`,
`spec`; the newest twelve), and the host writes one durable event into the
coordinator's chat transcript, which the page draws as a folded line you can
open to read the new instructions:

```json
{
  "type": "octiq_task_reopened",
  "runId": "run_7dc2e15caa264c52a440ceaeb8d71636",
  "taskId": "task_4f1bc81246b94af4b1bd512f87e9487a",
  "title": "Three host rules",
  "assignee": { "id": "agent_eb4c4db810a5", "name": "OCTIQ BE" },
  "attempt": 2,
  "spec": "Address the review: …",
  "previousSpecChars": 5210,
  "at": 1791720931688
}
```

`attempt` is the number of the attempt the instructions are for, the next
one. `assignee` is the task's, or `null`. `at` is the host's clock, and
`previousSpecChars` counts characters. A reopen that is refused writes
nothing. A peer request is still never reopened.

**A reopened task starts only once you have been shown the reopen** (review
of 931b5f0). The notice is the one thing that stands in for an approval
here, so the task waits for it:

- Each entry of `reopens` carries `noticeDelivered`. It is `false` from the
  reopen until that event is in the coordinator's transcript and the host
  holds a confirmed sync of it to disk. An entry that does not say reads as
  `false` too, and is confirmed like any other.
- While any is `false`, no start of the task is accepted, by the
  coordinator, the host's own dispatch and recovery, or the page: `This task
  was reopened with new instructions, and the notice of that in the
  coordinator's chat has not been confirmed as saved to disk yet, so it does
  not start: …`. The line may already show in that chat: it is sent to the
  page as it is written, before it is confirmed. The ready wave passes it
  over, and the task says `heldByReopen: true` in `orchestration_snapshot`,
  in every view. The key is left out otherwise. The page says it wherever
  it names the task's state (its row in the run panel, the Agents page):
  `Reopened · notice not yet saved`, with this refusal's words behind it,
  and never `Ready to start`. It asks nothing of you, so it is no "Needs
  you". If it has stayed that way for a minute, which is where the back-off
  below has run out, the row takes the warning colour and adds what the
  refusal says of a hold that lasts. The minute is counted on the page's
  own clock from when the page first saw the hold, never by comparing the
  reopen's stamp (the host's clock) with the browser's: a page reloaded
  starts it over, unless the ledger's own later stamps show it has passed.
  Its details say `Task: Reopened · notice not yet saved · ledger status:
  Ready`, and `Start next attempt` is there switched off with this refusal
  beside it.
- The host writes the notice right after the ledger, and again on every pass
  of the scheduler (about every two seconds) until it holds
  (`deliver_reopen_notices`). A transcript that gives no confirmation is
  asked again after 4 seconds, then 8, doubling to a minute, so a fault
  that lasts costs one read a minute. A restart changes nothing: the ledger
  remembers what is owed.
- It is exactly one event. Every try writes the same one, made from the
  entry in `reopens`, so `taskId`, `attempt` and `at` never change; and a
  notice already in the transcript is never written again.
- A notice counts only after the host has, in that same pass, synced the
  transcript's file as it is now and then the folder it is in, and both
  succeeded. No path is exempt: a line written in this pass, a line found
  already there (one that can be read back is not yet a confirmed one), a
  file that existed before, a file that compaction replaced. While either
  sync fails the task stays held, and no other notice is written into a
  transcript that holds an unconfirmed one. On Windows there is no folder
  sync to ask for, so the file's own sync is the whole confirmation there.
- That confirmation is for the transcript the notice was seen in. Clearing
  the coordinator's chat (`/clear`) removes its transcript, and the next
  thing said there starts a new one under the same name, which syncs and
  holds no notice. So the host notes which transcript the chat has before it
  reads it (`transcript::generation`, moved whenever the host removes one),
  and a confirmation asked for after that transcript was removed is refused:
  the task stays held for that pass, and the next try (after the same wait
  as any pass that got no confirmation: 4 seconds after the first, then 8,
  16, 32, and a minute from there on) writes the notice, once, into
  the transcript you now see. A compaction keeps every notice
  and costs nothing. What this does not promise: once a notice has been
  delivered, clearing the chat removes it with the rest of that chat's
  history, which is your own act and is not undone; the task stays as it
  is and the notice is not written again. The host also does not see a
  transcript file removed by another program, or by an agent's own file
  tools or a terminal.
- That confirmation is also for the file the notice went into. What the
  host notes names the transcript's file as the filesystem tells files
  apart, so a confirmation is refused on any other file, including one that
  has the same name in another folder and one reached under another
  spelling of its name. The folder your chats are kept in is fixed when the
  server starts and does not change while it runs, so a chat's name does
  not come to mean another file; if a drive holding that folder goes away,
  nothing is confirmed and nothing starts until it is back.
- The file editor in the page does not save over a transcript, or over any
  other file OctiqFlow keeps in the profile folder (the roster, the run
  ledger, the server's settings): `OctiqFlow keeps its own state in the
  profile folder, and … is a chat's record. The file editor does not write
  there: …`. Opening and reading them is unchanged. Your own `notify-hook`
  and anything under `canvas/` are still yours to edit there.
- A notice is written only into a chat you can open: one the chat list has
  and that is not in the trash. When the coordinator's chat is not such a
  chat, the reopen is refused outright and nothing is recorded: `The
  coordinator's chat no longer exists, so the person could not be shown this
  reopen. Nothing was reopened. …`. A chat deleted after its reopen was
  recorded gets no notice and its task stays held; restoring the chat lets
  both through.

**You can stop one task and leave the run going.** `orchestration_task_stop
{ taskId, reason? }` is the page's command and no hook action maps to it. It
cancels the task's unsettled attempt, with any decision it was waiting on,
stops that worker's process, leaves the task failed with `Stopped by the
person.` as its result and its workspace kept, and tells the coordinator
once. The task then carries `stopped { at, attemptId, reason? }`, and while
it does no agent and no host recovery starts it: your Start on its row
(`orchestration_worker_start` with `retryOf` the stopped attempt) does, and so
does your approval of a plan it is put back on. Before this the only stop the
page had was the whole run (`orchestration_run_stop`).

On the page, Stop is on the reopening's own line in the coordinator's chat,
once you have opened it to read the new instructions: `Stop this task…`, then
a confirm. It is off, with the reason beside it, while no worker is on the
task (not started yet, finished, or reopened again since: Stop is then on
the later line), and when the line is not the task's own: its event names
another run than the task is in, or the chat it is drawn in does not
coordinate that run. After it the line and the task's row say `Stopped by you`,
the row's detail gives the sentence above and your reason, and `Start it
again` on that row is your Start. A stopped task is not shown as failed or
as needing attention anywhere: you held it.

The confirm opens with the keyboard on `Keep it running`: Enter or Space
again cancels, a key held down answers nothing, and Tab to `Stop worker`
then Enter stops. `Start it again` asks nothing first, like the page's
other Starts; a held key presses it once, and a press that repeats the one
that opened its row does not land on it. While the plan holds the task, or
a reopen of it is not told yet, `Start it again` is switched off with that
reason beside it, as `Start next attempt` and `Start retry` are.

**A plan back with you does not hide what went wrong.** When a task you
approved failed, is blocked, failed its check or was stopped by you, and
the plan then comes back for a task added since, the run panel draws the
plan and the rows and totals together. `No worker starts until you approve`
is said only while the host would refuse every start: a retry of an
approved task that failed, or your Start of one you stopped, is not held by
the plan, and the card then says `What you approved before goes on. The
rest waits for this.`

**A replaced task does not start again.** Superseding a blocked or failed
task (`supersedes` on `orchestration_task_create`) takes back the retry the
host had scheduled for it and leaves it failed, and every later start or
recovery of it is refused by name: `This task was replaced by "Do it another
way" (task_…) and no longer starts.`

### What a waiting plan holds

A plan back in front of you holds only what you have not approved (decided
2026-10-11; before that it froze the whole run, and approved tasks sat ready
behind a card that was about other work). A task may start when you approved
**that task as it stands** (`task.approvedAt`, stamped by the plan decision and
cleared by every change to what it covered: a new owner, a new size) and no
task it depends on, however far down, is still waiting for you. So a task the
lead created, revised, re-routed or resized since your last approval waits, and
so does whatever depends on it; a manager's own split is never on the card and
goes by its parent's approval, and a task the coordinator put under a parent
is not one (`approval_parent`). The rule is one function,
`orchestration::held_by_plan`, read by every way a task comes to run: the
single door every start goes through (`reserve_attempt_for`: a first dispatch,
a reopened task, a coordinator's retry, the page's Start, the host's automatic
recovery, `orchestration_worker_start`), the scheduler's and
`orchestration_dispatch_ready`'s wave (`ready_wave`, where a held task takes no
slot), and the recovery pass, which keeps a held task's retry instead of
dropping it. Each task in a snapshot says whether a start of it would be
refused for this reason, so the page and the coordinator can say "waiting for
plan approval" apart from "ready": `heldByPlan` is `true` or `false` on every
task of a run that has a plan approval (`run.planApproval`, pending or
decided), finished tasks included, in the page's full read and in the
coordinator's compact and one-task reads. It is left out only for a run with
no plan approval at all, where there is nothing to be held by. `false` is said
outright because a reader has to tell "not held" from "this host does not
say": with a plan pending and nothing held (approve A, add B, withdraw B), a
page sent nothing read A as held. It is derived on every read and never
stored. Unchanged: a task you have not approved never starts; rejecting
an amendment withdraws the new work and leaves the earlier approved plan in
force; stopping a run, closing or abandoning a mission and `maxConcurrent`
behave as before; a peer request still waits for its own approval on the card.
A run that asked for no approval until a peer request put a plan in front of
you has no approved task at all, so everything in it not already running waits
with that card.

`orchestration_task_reopen` puts new follow-up instructions in a completed
task's spec and keeps its approval, as it always has: the reopened task starts
without the new words going on the plan card, as what was approved and
nothing else, and you are shown each reopen
(see **What an approval fixes** above).

## What the run panel reads from the host

Three facts the page needs and cannot work out. Each is derived from what the
host already holds when it answers, like `heldByPlan`: none is stored, so none
goes stale, and none is an agent's to set (a value sent in for one is not
read).

**Who a wait is for.** Every open gate and every pending native decision in
`orchestration_snapshot` carries `awaits`: `"person"`, `"coordinator"` or
`"nobody"`. A gate that has settled, and a decision whose card is no longer
up, carry no such key.

| `awaits` | When |
| --- | --- |
| `person` | The decision is yours. A gate on a peer-request task, which no agent resolves. A gate the run's coordinator opened itself, which is that coordinator asking for a decision it will not make alone (see the note below). A provider's safety card still up on an attempt that is still its task's and unsettled: being prepared, running, or blocked on an open gate. |
| `coordinator` | A worker's gate on an ordinary task. The coordinator may resolve it; whether it asks you first is its own judgment, which the host cannot see. |
| `nobody` | Nothing waits on it. A Claude auto-mode refusal, which no one can approve; an outage refusal, which the worker was told to carry on past; a card whose attempt is over, because it settled or was replaced. |

Who must decide is one fact and whether the attempt can go on right now is
another, and they are said apart. A safety card whose attempt is blocked on
an open gate still has `awaits: "person"`: you have to answer it. Its
`continuation` is `"unavailable"` and its `recovery` says why: nothing
continues the attempt until the gate is answered too. Once it is, the same
card reads `continuation: "new_turn_same_attempt"`.

A gate the coordinator opened itself says `person`, and the coordinator can
still resolve it: today your answer to such a gate travels through the
coordinator, which is the one that calls `orchestration_gate_resolve`. So
`person` on that gate says whose decision it is, not that the host refuses
everyone else. Only a peer-request gate is refused to every agent.

A plan revision waiting for you is not a gate: it is `run.planApproval` with
`status: "pending"`, and always yours.

```json
{
  "id": "gate_3f0c9a51b7de4c1b",
  "runId": "run_7dc2e15caa264c52a440ceaeb8d71636",
  "taskId": "task_1b8ece4b05a04885b70e5fc9cf394e2b",
  "createdByChatKey": "chat:orch-43c6f761cfbe4b47be55a9f8fd818f47",
  "targetChatKey": "chat:9eb9909a-fc30-4307-889e-4622ab14630b",
  "question": "Which sprite size?",
  "options": [],
  "status": "open",
  "createdAt": 1791724600000,
  "updatedAt": 1791724600000,
  "awaits": "coordinator"
}
```

```json
{
  "id": "block_81c2",
  "runId": "run_7dc2e15caa264c52a440ceaeb8d71636",
  "taskId": "task_1b8ece4b05a04885b70e5fc9cf394e2b",
  "attemptId": "attempt_6a76b069e5724acb8cdc2e4bd2a7489b",
  "chatKey": "chat:orch-43c6f761cfbe4b47be55a9f8fd818f47",
  "reason": "Upload requires a decision.",
  "blockedAction": null,
  "status": "pending",
  "continuation": "new_turn_same_attempt",
  "recovery": "Use the existing safety card in the main chat. The rejected call already ended; a decision can authorize a new turn in this attempt, not resume that call.",
  "observedAt": 1791724600000,
  "kind": "safety",
  "groupId": null,
  "awaits": "person"
}
```

**What a worker has used and holds.** Each attempt may carry `usage` and
`context`, both optional and absent until known, never a row of zeros and
never worked out from anything else.

- `usage` is what the host has counted for that attempt's worker chat
  (`agent_usage.rs`): `input`, `cachedInput`, `cacheWrite`, `output`,
  `reasoning`, with the subsets inside their totals as that file explains. It
  is absent until the provider has reported any usage for the chat, and for a
  chat that runs as no registered agent, which that store does not record.
- `context` is what the worker's session holds of its model's context
  (`tokens`) and how much that model can hold (`window`), each as the
  provider last reported it and read by the rules the meter beside Send uses.
  It is there only once both are known: a count without a window is not
  shown. Antigravity reports no window, so its attempts never have one. It
  describes a live session and is kept in memory, so it is gone after a
  server restart.

Both are as of the read. A peer request's worker, whose snapshot holds its
own task alone, reads its own attempts' figures and nobody else's.

```json
{
  "id": "attempt_6a76b069e5724acb8cdc2e4bd2a7489b",
  "taskId": "task_1b8ece4b05a04885b70e5fc9cf394e2b",
  "number": 1,
  "workerChatKey": "chat:orch-43c6f761cfbe4b47be55a9f8fd818f47",
  "agent": "codex",
  "model": "gpt-5.6-terra",
  "access": "auto",
  "status": "running",
  "usage": {
    "input": 41000,
    "cachedInput": 39500,
    "cacheWrite": 0,
    "output": 2300,
    "reasoning": 1100
  },
  "context": { "tokens": 41000, "window": 272000 }
}
```

(An attempt has more fields than these; the two at the end are the new ones.)

**Which chats coordinate a run.** The page draws the chat list before it has
the ledger. A chat's entry in `chat_index_list` carries `coordinatesRun: true`
while that chat coordinates a run you have not archived, finished or not, so
the page can hold the run column open from its first paint. A chat that
coordinates none has no such key. It is worked out from the ledger for each
answer; the index stores nothing of it, and an entry saved back with it
(`chat_index_save`) is taken without it. It is for that first paint: once the
ledger is read, the ledger is the truth, and `chat-index-changed` does not
fire when a run is created or archived.

```json
{
  "id": "9eb9909a-fc30-4307-889e-4622ab14630b",
  "projectId": "fa08eadd-cfe5-4314-8eae-47b185abfe39",
  "title": "Five handed-over items",
  "createdAt": 1791680900000,
  "updatedAt": 1791724600000,
  "coordinatesRun": true
}
```

### Completed is not finished well

`completed` is the host's word for a task whose worker settled it. It is not
"done": a check, review or acceptance task that completed with `verdict:
"fail"` still holds every task that depends on it (`releases_dependants`).
A run whose every task has completed is `completed`, failed checks included
(`recompute_run`). Accepting such a result (`orchestration_task_accept`) pays
the reviewer and does not release the dependants.

So the page asks three questions of a task and never compares its status with
the word anywhere else (`web/src/lib/orchestration.ts`):

| Question | True when | Used for |
| --- | --- | --- |
| `isSettled` | `status` is `completed` | what is true of any settled task: it takes no worker, its result can be accepted, its worker can be archived, `Tasks settled N of M` |
| `checkFailed` | settled, `verdict` is `fail`, and not replaced (`supersededBy`) | a failure, wherever a failure is shown |
| `finishedWell` | settled and not `checkFailed` | the only thing that is called or counted "done" |

A task whose check failed is shown the way a task that failed is: on its row
in the run panel (`Check failed`, the danger colour, first under Running), in
the strip above the composer and the chat list's line (`1 failed`, and not in
`N/M done`), in the run's totals, under its agent on the Agents page (the
agent's state is `Failed`), in a mission's crew, and in a mission's stage,
which is `In review`, waiting, and never `Ready to merge` or `Draft` while an
approved check has failed. A check that was replaced is history, like a
replaced task that failed. A check that completed with no verdict (only an
older or hand-edited record holds one) did not fail and reads as done; the
host still holds its dependants, which the acceptance line says (`1 without a
verdict`).

## Memory

Each registered agent has its own working memory: one note in the Memory Vault
at `agent-zone/agents/<name>/memory.md`, the roster folder the vault's schema
reserves. The note path is fixed the first time it is assigned and stored on the
agent (`memoryNote`), so renaming an agent keeps its memory. Saving an agent
creates the note when a writable vault is connected; otherwise the first write
creates it.

Agents reach it through three tools, `vault_agent_memory_read`,
`vault_agent_memory_append` and `vault_agent_memory_lessons`. The host works
out **which agent is calling from the chat itself**: the lead a task was handed
to (`team.json` `leads`), or the assignee of the task a worker chat runs. Tool
arguments never name the caller. An agent may:

- read its own memory, and its **direct reports'** (managers see what their
  people know);
- append only to its own memory, one dated entry at a time, never overwriting;
- propose a new **Lessons** section for its own memory, which the person
  approves on a card.

Both writes are the chat's **own agent's**. An additional agent in a room
(a seat, `session_key != chat_key`) holds a capability that proves the chat,
not the chat's registered agent, so the host refuses it
`vault_agent_memory_append` and `vault_agent_memory_lessons` before reading
their arguments (`web.rs` `memory_seat_refusal`): `Only the chat's own agent
can add to its working memory. An additional agent in a room is one voice in
the chat, not its registered agent.` The person decided the append on
2026-10-11 although `vault_patch` and `vault_write` can reach the same note,
and those two are unchanged: only an agent's own chat writes its working
memory through the tool that names it, the one whose saved entry OctiqFlow
draws in the chat. A seat may still read. A worker's chat is its own voice,
and appends to its assignee's memory as before.

### Lessons and the newest entries (`memory_lessons.rs`)

A note has two parts: a curated `## Lessons` section under its header, and the
dated `## YYYY-MM-DD` entries appended below it. There is no separate
`lessons.md`: the lessons belong in the note the agent already loads, not in a
second file it has to know to read and decide which one to write.

- **A read loads the right end.** Without `startLine`, `vault_agent_memory_read`
  gathers the whole note and answers with the header, the Lessons section whole
  and the newest dated entries (at most 12, about 16,000 characters; the newest
  is always shown). It says how many entries it left out and where they start
  (`olderEntriesFrom`). The vault's own read pages from the top, 200 lines by
  default, so before this an append-only note past 200 lines loaded its OLDEST
  entries; one ran to 962 lines. `startLine` still pages the raw note.
- **Only the Lessons section is ever rewritten**, and only on the person's
  Allow. `vault_agent_memory_lessons` takes the whole new section (6,000
  characters at most, no `#`/`##` headings). The host shows it beside the text
  it replaces on a one-off permission card, then writes it as one exact vault
  patch of that section against the note as it is after the Allow: an entry
  appended while the card was up is kept, and a section changed meanwhile is
  refused rather than overwritten. The dated entries are never touched, so
  everything an agent once recorded stays recoverable. A note with no section
  gets one above its first entry.
- **A worker cannot rewrite its Lessons.** Its attempt is not paused for a
  card, so the MCP does not offer the tool to a worker and the host refuses one.
  It records entries, and curates them the next time it leads a chat.
- **An additional agent in a room cannot propose them.** Its capability proves
  the chat, not the chat's registered agent, so the host refuses it before
  any card (`web.rs` `memory_seat_refusal`).
- **The read nudges.** With no Lessons and more than 8 entries, or with
  entries left out, the read carries a `lessonsHint` to propose some.
- **A lesson for every agent goes up, not sideways.** The brief tells an agent
  that a lesson holding for every agent in the project (a tool quirk, a repo
  rule) is proposed as a change to the project's `AGENTS.md` in its reply or
  report, for the person or its lead to accept, rather than kept in one
  agent's memory or copied into several.

An entry with no date is dated with the server machine's **local** date, and
the vault receipt keeps the date used (`entryDate`), so a retry with the same
requestId is recognised however much later it comes. The host, not the agent,
then draws a line in the chat (`memory_activity.rs`): *saved* only on a saved
receipt, *unconfirmed* while the receipt needs review, *not updated* when
nothing was written, and *refused* when the requestId already belongs to an
earlier, different entry — shown beside that entry's own state, which is
usually saved. A worker's coordinator gets a line that it happened, while it is
still that worker's coordinator. Lines a crash left unwritten, or a transcript
lost, are written back at the next start.

Every lead and worker brief tells the agent to load its memory first, and to
record only what its future self needs: decisions and why, gotchas, how things
work, and what to pick up next. Routine steps don't go there. The generic
`vault_*` tools are still available to agents, so this read rule is a
convention for the agent-memory tools, not a lock on the vault.

## Dashboard

**Agents** in the sidebar shows every registered agent in chart order, with
what each is doing now: one state word (Working, Needs you, Failed, Blocked,
Stalled, Queued, Idle), counts of its other current items, and the items
themselves, each opening its conversation or its task. Failed is a task of
the agent's that failed, is blocked with no decision open, or completed with a
failed check, in the danger colour; Blocked is a wait, in the warning colour.
Work that finished well is not listed, and nor is anything in a run that is
over or archived (see **Completed is not finished well** above).

## Levels, XP and token usage

Each registered agent has a level, earned from work someone **accepted**
(`orchestration/levels.rs`). The host computes every number; the browser only
words them.

- **Size.** Every task has a size: small (25 XP), medium (75 XP, the default)
  or large (150 XP). The lead gives it on `orchestration_task_create` or
  `orchestration_task_revise`, and the person can change it on the plan card
  (`orchestration_task_size`, browser only). It is part of the plan digest, so
  an approval covers it. Resizing a task the person already approved puts it,
  and the plan, back in front of them before any worker starts. Once the task
  has any attempt, the size is locked. A
  task that started before sizes existed has none and earns nothing.
- **Acceptance.** A worker reporting completed is not acceptance. The person
  accepts a completed task on its plan card or on the agent's profile
  (`orchestration_task_accept`, browser only). A lead accepts through the agent
  tool `orchestration_task_accept` (hook action `task_accept` →
  `orchestration_task_accept_in_chat`). The host allows that only from the
  run's coordinator chat (whose lead comes from `team.json`), or, for a
  subtask its manager split (`splitBy`), from a worker chat of the parent
  task, where the manager is the parent's assignee. A task the coordinator
  put under that parent is not the manager's to accept. Nobody accepts their own work. Every accept names the
  completed attempt it reviewed; a newer result refuses it.
- **Who is calling.** Two callers, two credentials. The person holds the
  server token, which opens the browser's routes (`/ws`, `/file`, `/auth`):
  the socket acts as the person, so the person's own decisions (accepting a
  result, approving a plan, sizing a task) are socket commands. An agent is
  one launch of one chat: each launch gets a fresh secret,
  `OCTIQ_CHAT_CAPABILITY`, and the MCP sends it as the
  `x-octiq-chat-capability` header on every hook call, to `127.0.0.1` on the
  port the host passes as `OCTIQ_HOOK_PORT`. That capability is the only
  thing every `/hook/*` route takes: the server token is neither needed nor
  enough there, and an agent is never given it (the MCP does not read
  `web.json`, and a server started with `OCTIQ_WEB_TOKEN` does not pass it to
  agents). A hook refuses a call with no current capability (401) and one
  whose body names another chat, session or launch (403), and acts for the
  chat, session and launch the capability belongs to. The capability dies
  with its process and is replaced on relaunch, and it opens none of the
  person's routes. The socket in turn refuses the lead-only commands
  (`orchestration_task_accept_in_chat`, `orchestration_plan_approve_in_chat`),
  so a lead's acceptance on record always came from that lead's chat.
  Nor does a request from this machine on its own: `GET /token` hands the
  token only to a Cloudflare Access sign-in (it used to answer any request
  whose `Host` said loopback, which any local process can send). A new
  browser opens the `?token=…` link the server prints at startup or pastes
  the token on the Connect page; `local_token` in an old `web.json` is
  ignored.
  Limits: this separates what OctiqFlow hands out; it is not an OS boundary.
  Agents run as the person's own OS user, so a process that goes looking can
  read `web.json`, the server's startup log, or another process's
  environment. Only OS-level isolation (another user, a sandbox with no read
  access to the profile) closes that.
- **Ledgers.** Two, in `orchestrations.json`, both written in the same write
  as the acceptance. `acceptances` records every acceptance as it was made:
  task, accepted attempt, the agent it ran as, who accepted and when, the size,
  and what it paid (0 with the reason when nothing). It is appended once per
  accepted attempt and never edited. `xp_awards` records what was paid, keyed
  by task id. One task pays once: a repeated or racing accept, a retry, or a
  reopen never pays again. A reopened task's new result must be accepted
  again; that adds a line to `acceptances` with 0 XP, and the award stays.
  "Accepted tasks" counts distinct task ids in the agent's acceptances, paid
  or not, for good, and the XP history lists every acceptance. A store
  written before `acceptances` existed has it rebuilt on load from its awards
  and each task's current acceptance. XP goes to the agent the accepted attempt ran as, recorded on the
  attempt when it started. A manager is never paid for its reports' subtasks. Awards copy the
  agent id, name, title and size, so renames, model changes and deleted runs
  change nothing. `scoring_since` records when scoring began. Nothing earlier
  is backfilled.
- **Levels.** Level 1 starts at 0 XP. Going from level L to L+1 costs 100 × L,
  so level L starts at 50 × L × (L − 1): 0, 100, 300, 600…
- **Token usage** (`agent_usage.rs`, `<chats dir>/agent-usage.json`) is shown
  for information only and never affects XP. Every chat's usage goes to the
  agent it ran as when its first usage arrived: a worker attempt's assignee, or
  the lead a chat was handed to. That attribution is stored and never
  recomputed. Each worker attempt has its own chat, so a manager's total never
  includes its reports' work. Ordinary chats are not counted. Claude's
  `modelUsage` is cumulative per process and includes subagents, so the reader
  keeps a per-process meter and records each turn's difference. Interrupted
  and failed turns are counted once, when the provider reports them. A turn
  killed before its report is not counted, so every total is a floor. Claude's
  figures include the helper subagents it runs inside its own chat, which the
  provider does not report apart; a registered report always has its own
  chat. Codex app-server usage is each response's
  `last` block. A notification whose thread total matches the last one
  recorded is a repeat. Cached input is part of input, and reasoning is part of
  output; they are shown as subsets and never added. Counting starts with this
  build, and earlier chats are not read back.

The Agents page shows a level chip on each row. The chip opens the agent's
profile: level and progress, accepted tasks, tokens used, what waits for
acceptance, the XP history (20 per page, each row opening its run), and the
rules.

## Relation to orchestration

Passing on and splitting use the existing [orchestration](orchestration.md)
machinery unchanged: runs, tasks, attempts, worktrees, retries, gates and the
durable inbox. When an agent creates a run through the MCP hook, the host
returns the master brief in the response (`masterBrief`), because nothing else
delivers it. Tasks record `assignee { id, name }`, which the task board and the
Run view show.
