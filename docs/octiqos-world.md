# OctiqOS org world

OctiqOS `/os` is the org-based 2D agent office. It shares OctiqFlow's authenticated
Rust server and stores its durable state in PostgreSQL. The earlier mission
portal remains at `/os?view=legacy`; OctiqFlow's chat/workbench remains at `/`.

## Working in the office

1. Create an org, then register its projects and workspace folders in Setup.
   Project folders cannot overlap. Shared project context and test runner image
   can be edited later.
2. Register agents with a profession, worker/consultant role, provider/model,
   project scope, and appearance preference. PM, Developer, Tester and Infra
   templates are included; custom professions have their own guidance.
3. Create tasks using Auto PM or Direct assign. A worker's desk also has Give
   task and Invite to meeting. The board shows questions, pause, work, and Verify.
4. Auto PM plans and dispatches execution steps. A selected workflow fixes the
   ordered professions; workflows may contain 1–8 steps and repeat a profession.
5. Founder directions pause, redirect, resume, or cancel work. Each change fences
   the previous generation. CLI processes and active command containers stop
   when interrupted; previously completed file edits remain in the workspace.
6. Completion enters Verify. The founder records evidence before Done. An
   unresolved command failure blocks step completion and asks for founder input.
   Founder follow-up after a completed automatic workflow returns to PM planning
   with all previous results retained in the task history. Direct follow-up stays
   with its assigned worker and bypasses PM.

Clicking an agent opens its task list first. Active tasks put questions and
verification at the top; Closed and All retain past conversations. The list
includes direct assignments, assigned workflow steps and recorded participation,
including PM planning, rather than every task matching the agent's profession.

Selecting a task opens its own conversation on the left and its objective,
execution plan and evidence on the right. Opening a task does not start a new
run. Send uses the existing founder-direction action and continues work using
the message; Pause, Resume and Cancel remain under Task controls. Verification
lives beside the plan, and closed tasks are readable without a composer. Back
returns to the originating agent's task list, or the board for other entry paths.
On phones, switch between Conversation and Plan. Agent profile, role, memory,
scope and progress remain available from the agent details tabs.

`node scripts/test-agent-tasks.mjs` exercises office-to-task navigation against
an in-memory bridge using the real WorldPortal, including desktop/mobile layouts,
task-message isolation, send/retry, pause/resume, verification and closed history.
It accepts the same Playwright/browser environment overrides as the Secretary
browser script below and saves screenshots in a temporary directory.

## Discussion and context

### Secretary reception

Each org's Secretary opens a continuous conversation on the left and a live
blueprint on the right. Reply to questions in the same message box; Enter sends
and Shift+Enter adds a line. Previous turns remain visible when reception is
reopened. On small screens, switch between Conversation and Blueprint; the
blueprint's Reply in conversation button returns focus to the message box.

The last blueprint stays visible while a reply is being prepared. New or changed
cards are highlighted against the previous version. Stop cancels the active
reply, and failed submissions preserve the unsent message. Only the latest ready
blueprint with no unanswered questions can be confirmed in reception. Confirm
and apply blueprint applies the proposed organization configuration explicitly.

Folder access in the composer grants the Secretary read-only access to a specific
server-side directory, even before an org has a Project or workers. Pasted paths
only suggest the field value: the founder must click **Allow read-only access**.
The disclosure explains that inspected file contents go to the configured model.
Grants are org-scoped, persisted and removable. Removal stops any active Secretary
inspection and invalidates ready blueprints; already recorded conversation is not
erased, and separately confirmed Project/worker permissions are unchanged.

The Secretary can now request `list_files` and `read_file` through OctiqOS and use
the actual returned content to inspect `AGENTS.md`, workflow definitions and docs.
Read attempts and errors appear in the conversation. Each reply is bounded to 24
model turns and 180 KB of focused context; individual reads remain 48 KB UTF-8.
Cross-org paths, traversal, symlinks, hardlinks and excluded secret paths are
rejected. This is not a native CLI shell, and cannot write or run commands.

A project card can propose a `workspacePath` copied from an authorized folder.
Only explicit blueprint confirmation creates/binds the Project and applies worker
scopes. Omitting that field preserves an existing binding. Setup also allows
editing an existing Project's Workspace folder, with overlap checks and a guard
against changing the directory while its work is in flight.

An opt-in smoke test uses the real Codex adapter against synthetic local files,
without modifying the running org database:
`OCTIQOS_TEST_SECRETARY_READ=codex cargo test --manifest-path src-tauri/Cargo.toml --lib world::workspace_access_tests::live_secretary_reads_authorized_folder_before_proposing_binding -- --ignored --nocapture`.

The isolated browser regression script `node scripts/test-secretary.mjs` uses
an in-memory backend and saves desktop/mobile screenshots to a temporary folder.
Set `OCTIQOS_PLAYWRIGHT_MODULE` to an installed Playwright module if needed, and
`OCTIQOS_CHROME_EXECUTABLE` to use an existing browser executable.

### Meeting Room

Meeting Room supports 1–8 workers/consultants. Creating a room does not start
work: send a topic/message to begin discussion. Participants answer sequentially
from their profession and permitted project context. Meeting replies never enter
an action interpreter. Only the founder's explicit Convert to task creates work,
using the selected outcome instead of the entire meeting transcript.

Each agent has independent project-tagged memory. Only its own confirmed memories
for the current project are loaded (up to 12 recent entries); model-proposed
lessons remain provisional until confirmed. The founder can add, confirm and
remove memories. Every task turn gets scoped identity, profession, project,
memories, task directions and prior-step evidence. No unrelated task or CLI
conversation history is inherited.

All-project permission covers present/future projects inside the same org.
Selected-project permission is enforced during assignment, meetings, context
retrieval, and every action. Revoking access pauses affected work. There is one
active turn per agent and three across the world; a meeting waits for a busy
participant. Offices show active task counts, direct-assignment queues and stopping states
from persisted work. Meeting participation appears separately as In meeting;
automatic work is assigned when its next step is claimed.

## Model accounts

New workers default to Codex CLI and model `default`. A specific account-supported
model ID can override the CLI default. Both CLIs must be installed and signed in
as the OS user running the service. They run in fresh private temporary folders.

| Provider | Connection |
| --- | --- |
| `codex` | Existing Codex/ChatGPT CLI login; ephemeral session, user config/rules, project documents, host skill discovery, plugins, memory, shell, browser and image tools disabled |
| `claude` | Existing Claude Code login; safe mode, no built-in tools, no inherited MCP/settings, no session persistence |
| `claude_api` | `OCTIQOS_CLAUDE_API_KEY` via tool-free Messages API |
| `deepseek` | `OCTIQOS_DEEPSEEK_API_KEY`, otherwise existing `DEEPSEEK_API_KEY` or `~/.config/deepseek.key` |

The CLIs produce text/JSON only. Codex also uses a read-only sandbox and never
approval policy; OctiqOS controls the actual file/command actions. Credentials
stay on the server and are never sent to the browser or execution containers.
Configured status confirms local configuration, not live account entitlement.

On 2026-09-06, Codex passed live validation. Claude login exists, but the remote
organization returned HTTP 403: Claude subscription access is disabled for
Claude Code. This requires the account administrator to enable it, or a Claude
API key. The task UI reports this actionable error; it never silently changes
provider. The Claude adapter is implemented, but successful live Claude execution
could not be validated under the current account restriction.

References: [Codex configuration](https://developers.openai.com/codex/config-reference/),
[Claude CLI](https://code.claude.com/docs/en/cli-reference),
[Claude Messages](https://platform.claude.com/docs/en/api/http/messages/create),
[DeepSeek chat](https://api-docs.deepseek.com/api/create-chat-completion/).

## File and command execution

Workers can list folders, read UTF-8 files, and write authorized project files.
Writes require the exact prior content, preventing accidental overwrite of a
concurrent edit. Developer, Infra and custom execution professions can write;
PM planning does not execute file actions; Tester task access is read-only. File actions are bounded
to 48 KB. Traversal, symlinks, hardlinks, `.git`, `.env*`, `.pem`, `.key`,
`node_modules` and `target` are excluded.

`run_command` runs shell/test/build commands using Docker against a filtered copy
of the current project. The copy is sent as a tar stream into a private `/workspace`
tmpfs, avoiding Colima/Docker Desktop host-mount differences. No host directory,
Docker socket, account credentials, or other project is mounted. The container
has no network, a read-only root, no Linux capabilities, no privilege escalation,
and limits of 120 seconds, 1 GB RAM, 2 CPUs and 128 processes. Project snapshots
are limited to 10,000 files/100 MB. Command changes affect only the disposable copy;
use `write_file` for actual source edits. Output, exit code and interruption status
are recorded on the task. Temporary copies are private and removed afterwards.

The default runner is `node:22-alpine`. Preinstall an appropriate image for each
project; images must provide `/bin/sh` and `tar`, and the tools/dependencies needed
by its commands. Runtime uses `--pull=never` and does not install packages over the
network. Host `node_modules` are not copied. Missing tooling/dependencies or a
failed command appear as real task evidence and require correction; no tests are
claimed to have run merely because a model described them. Deployments and
external writes are outside agent task execution.

## Avatars, tokens and levels

Higgsfield is preferred when its CLI and local OAuth credentials are present.
Agent profiles offer Generate with Higgsfield, using only the agent's name and
appearance preference. The default `nano_banana_flash` (Nano Banana 2 in the live
catalog) requests one square 1K pixel office character. It uses the CLI account,
not a separate Higgsfield Cloud API key. OpenAI image generation remains optional.

| Setting | Purpose |
| --- | --- |
| `OCTIQOS_AVATAR_PROVIDER` | `auto` (default), `higgsfield`, or `openai` |
| `OCTIQOS_HIGGSFIELD_MODEL` | Default `nano_banana_flash`; custom models must support square 1K output |
| `OCTIQOS_HIGGSFIELD_BIN` | Optional absolute CLI path |
| `OCTIQOS_IMAGE_API_KEY` / `OCTIQOS_IMAGE_MODEL` | Optional OpenAI image account/model |

Avatar jobs run independently of task work. Progress survives page refresh;
failed jobs keep the prior image and do not retry automatically. One avatar per
agent and two across the world can generate concurrently. Timeout/restart states
advise checking provider history before retrying. Images are validated, copied
into saved state and fetched once per image version. Only expected HTTPS CDN
hosts are accepted; CDN requests have no account headers. Provider job references
are retained. [Official Higgsfield CLI](https://github.com/higgsfield-ai/cli).

Input/output/cache tokens are attributed to the correct agent without double
counting cache tokens. Missing usage is unknown, including Higgsfield CLI image
usage. Verified task contributors receive 100 XP once per task. Level N begins
at `100 * (N - 1)^2` XP; consuming tokens never awards XP.

## Persistence and preview

World state is a transactional PostgreSQL aggregate (`octiqos.world_state`), with
row locking, mutation receipts and a monotonic revision. Duplicate requests and
usage/XP events are deduplicated. Stale browser responses cannot replace newer
state. A stopped/expired worker requires founder review before resuming uncertain
work. Filesystem edits cannot be rolled back with a database transaction; inspect
recorded changes after an uncertain database failure.

The independent preview uses port 1422, launchd label
`com.kyson.octiqos.preview`, and `~/.octiqos-preview`. Its private environment file
contains `DATABASE_URL`. The installer preserves provider settings and separates
the preview from production OctiqFlow on port 1421:

```sh
./scripts/install-octiqos-preview.sh
```

No production restart is part of this feature. Release 0.1.3 is installed at
`http://127.0.0.1:1422/os`. A pre-upgrade database dump is retained under
`~/.octiqos-preview/backups/` with mode 0600.

## Validation — 2026-09-06

- Rust library: 470 passed, 4 opt-in tests ignored; web: 1,116 passed.
- TypeScript and optimized server/frontend builds passed. Installed preview/browser
  connection, runner settings, desktop/mobile layouts passed with no page errors.
  Production OctiqFlow remained HTTP 200. Installed code/data sections match the
  release build after accounting for installer code signing.
- Live Codex and DeepSeek transports returned real input/output usage. The DeepSeek
  smoke test sent only a fixed, non-sensitive request; no project context was sent.
- Real PM → Dev → Tester workflow reproduced a failing Node test, fixed the
  source, independently passed tests twice, reached founder verification/Done,
  and recorded per-agent token/XP contributions.
- A real multi-agent meeting completed without executing or creating tasks.
- Pausing an actual running 30-second command stopped its container and released
  its worker promptly; the task stayed paused with no stale completion.
- Higgsfield previously generated and downloaded one 1024×1024 PNG fox developer
  avatar, which was visually inspected. This was a real account call.
- Final browser regression: 15 flows passed on an isolated PostgreSQL-backed
  service, including meeting conversion, scope rejection, mutation replay,
  persistence and mobile layout, with zero page errors.
- Final regressions also cover founder follow-up after Verify, direct follow-up
  bypassing PM, and task workload accounting separate from meetings.
- Scope rejection, secret/alias filtering, independent context, failed-command
  gating, mutation replay, memory, avatar restoration and old-state decoding have
  regression coverage. Database migration was tested on disposable PostgreSQL.

Regular checks: `cargo test --lib` in `src-tauri`, `pnpm test` and
`pnpm exec tsc -p tsconfig.json --noEmit --incremental false` in `web`.
The explicit live test is `scripts/test-octiqos-live.mjs`; set `OCTIQOS_LIVE_TEST=1`,
`OCTIQOS_LIVE_TEST_URL` to an isolated loopback service and
`OCTIQOS_LIVE_TEST_OUTPUT` to a fresh temporary directory. It requires an empty
world, Codex login and a preinstalled Node image. It never uses/reset production.
`scripts/test-octiqos-world.mjs` covers browser workflows without live API calls.

Implementation was committed on `codex/octiqos-mission-control` and integrated
into `v2` in `/Users/kyson/03-projects/octiq-flow`. The independent preview remains
available during the production release transition. The canonical docspace update
remains pending because filesystem and Obsidian access returned EPERM; this
document is the local implementation record.

## Confirmed v1 acceptance

The agreed org-world implementation is complete. The table distinguishes code and
workflow acceptance from external account availability; it does not claim that
an unavailable provider was tested successfully.

| Requirement | Implemented behavior and evidence |
| --- | --- |
| Organizations and projects | Map buildings, independent offices, setup and project ownership; browser and Rust coverage |
| Professions and consultants | Built-in PM/Dev/Tester/Infra, custom professional guidance, worker/consultant distinction |
| Auto PM and workflows | Scoped PM plans ordered execution; real PM → Dev → Tester run completed |
| Direct task assignment | Board assignment and desk Give task bypass PM; browser and regression coverage |
| Founder input and interruption | Needs your input, pause/resume/redirect/cancel; real running container stopped promptly |
| Follow-up after verification | Finished Auto workflow replans from founder direction, retains evidence; direct work retains worker |
| 2D office and workloads | Map → office, individual desks/avatars; active tasks, queues and meeting status are distinct |
| Meeting Room | 1–8 specialists/consultants discuss with profession context; no tools/actions or implicit execution |
| Discussion handoff | Only explicit Convert to task dispatches selected outcome; browser and Rust coverage |
| Agent context and memory | Independent confirmed project memories and bounded scoped context; unrelated context excluded |
| Project restrictions | All projects within org or selected projects; enforced on assignment, discussion, retrieval and actions |
| Generated avatars | Persistent Higgsfield jobs, explicit retry, retained image on failure; real 1024px avatar generated |
| Token usage and levels | Agent-attributed usage, unknown usage shown honestly; XP only from founder-verified contributions |
| Durable operation | PostgreSQL transactions, replay receipts, revisions, restart-safe stored state and worker expiry |
| Providers | Codex live workflow; DeepSeek fixed-payload live transport; Higgsfield live generation; Claude adapter complete, account access blocked |

External setup still required where applicable: Claude Code organization access
(or a Claude API key), and a preinstalled project runner image containing that
project's test dependencies. These are visible configuration boundaries, not
silent provider fallback or invented successful tests.


## Recruiter and individual role prompts — 2026-09-06

From Welcome a new member, choose the profession and describe the intended role.
Polish with Recruiter uses the selected recruiter provider/model (Codex CLI with
model `default` initially). The first request adds a Recruiter consultant with a
desk to this org; later requests reuse it. The candidate's provider/model and
project access are configured separately. PM and Recruiter profiles also have a
Hire a teammate entry into the same flow.

The recruiter reads only the supplied role brief, the selected profession's
name/guidance and its own role instructions. It receives no project context,
workspace files, memories, or unrelated agent/task history. It returns a focused
prompt covering responsibilities, expertise, methods, evidence, collaboration,
and escalation. The generated text appears in Agent role prompt and remains
editable. Welcome to the team stores that prompt on the newly created agent.
Polishing alone does not create a candidate or dispatch tasks.

Existing agents have a Role tab: edit directly or ask the recruiter to polish a
new description, then Save role prompt. The saved prompt supplements their
profession guidance in new task and meeting turns. Other agents using the same
profession retain their own instructions. A role prompt cannot grant project
access, tools, or permissions; the normal scope checks remain authoritative.

Drafts persist through refresh and closing the dialog. Reopen a pending draft or
select a completed one from Saved recruiter drafts. Only one recruitment request
per org can be queued/generating, and the recruiter obeys the same worker/global
concurrency limits. Cancel polishing fences stale results and releases the worker
when its provider call returns. Provider failures are visible and require an
explicit new attempt. Usage is attributed to the Recruiter; prompt generation
awards no XP. The office shows Recruiting separately from active project tasks.

Recruiters are consultants and cannot be assigned execution workflows. They start
without project access; recruitment does not require it. The PM hiring button is
a founder-operated entry, not autonomous authority for PM to create staff.

Implementation: `world/recruitment.rs`, per-agent `rolePrompt`, durable
`recruitmentDrafts`, and the shared `RoleEditor` UI. Existing saved worlds decode
with empty role prompts and draft lists; no destructive data migration is needed.

Recruiter validation: 470 Rust tests and 1,116 web tests passed; the final world
regression suite passed 37 tests, including cancellation, project-scope changes,
context isolation, token attribution, old-state decoding and no execution/hiring
from a generation response. A real Codex call polished a fixed mobile QA brief.
Browser validation restored that saved draft, edited and applied it to a new
agent, updated the existing agent's role, rejected an unauthorized project,
verified recruiter token usage/zero XP, and exercised the hiring entry/mobile
layout with zero page errors. Existing preview data was backed up before update.

The requested Recruiter consultant was added to the existing Pandaworks org on
2026-09-06, using Codex/default with its own desk and no project access. No model
request or business task was started by registration. The installed Hire a
teammate form is the entry point for the founder's first role brief.


## v2 integration — 2026-09-06

The merged client opens the workbench at `/`, the org world at `/os`, and the
legacy mission portal at `/os?view=legacy`. The workbench sidebar and office header
provide navigation in both directions. Each portal loads its own UI module on
demand. The merge retains v2's memory module and HTTP form handling, and adapts
the legacy mission runner to v2's project-environment argument.

Validation uses an export of the merge index, so existing uncommitted work in the
v2 workspace is not a hidden dependency: 521 Rust tests and 1,262 web tests pass,
and both production build targets compile. The original v2 work in progress is
preserved outside the merge commit.

A branch merge does not restart the live service. For the production release,
configure its private `~/.octiqflow/octiqos.env` with the same existing OctiqOS
`DATABASE_URL` and required provider settings; do not copy the preview chat profile
or reset/seed the live database. The installer reads that private environment
file, and startup applies only missing migrations. Pandaworks data remains in
its current PostgreSQL database. Use the project release workflow to deploy both
client and server together and coordinate the restart with active chats.

The merged browser also passed the 15-flow org-world regression and actual
v2 → OctiqOS → v2 navigation, with no page errors. The office module is not
loaded on the workbench until the office is opened. These checks used an
isolated profile/database, leaving the live Pandaworks store unchanged.

## Mobile workspace

At widths up to 760px, OctiqOS opens on an Inbox instead of the map. The bottom
navigation provides Inbox, Tasks, Office, and Meetings. Organization and project
filters scope the lists; the Inbox includes questions, verification, and paused
work. Tasks default to active work, with completed and cancelled tasks reachable
through the status filter. Office retains the building map and agent desks.

Details and creation forms use full-screen native dialogs on phones, with focus
containment and nested dialogs for assigning work from an agent. Task details
provide quick access to answering questions, reviewing outcomes, and pausing.
Creating work across organizations requires choosing its organization first;
direct assignment and discussion-only meetings retain their existing commands.
The desktop map, office, and eight-column task board remain available.

Validation: mobile list scope and priority unit tests, production web build, and
isolated browser flows at 320px, 390px, and 760px. Browser checks cover full-screen
details, task direction, status filters, direct assignment, nested agent dialogs,
meeting discussion, and desktop map/board navigation with no page errors. Browser
commands use synthetic data, so validation does not dispatch live agent work.

## Founder-directed role conversations

New members start with an empty role prompt and description under an Unassigned
profession. Project access remains an explicit, separate setting. In an agent
profile, **Talk about role** opens a saved conversation with the agent itself or
an org-local PM/Recruiter.

**Discuss only** requests a response without permission to change the role.
**Update role from this message** grants one request permission to automatically
save a complete role description and prompt. Permission is carried by the
request mode, never inferred from model output or earlier conversation text.
The updated role is used by future task and meeting turns. Profession membership,
project access and runtime permissions are not changed by role conversations.

Requests persist as queued/generating/discussed/applied/failed/cancelled entries.
They can be cancelled, survive reload, attribute token usage to the responding
agent, and grant no task XP. Completion checks the request is still active and
that the saved role has not changed since the request; a stale response cannot
overwrite a subsequent founder edit. Discussion output cannot execute project
actions, and prior update permission cannot be reused by a later message.

Context consists of the target role, professional guidance, the helper's own
role when applicable, the latest six completed exchanges for this target, and
the current founder message. Project files, project contexts, memories and other
agents' conversations are excluded. Backend tests cover consent, org boundaries,
cancellation, stale writes, blank onboarding, malformed responses and bounded
history. Browser fixture checks exercise self/PM updates, reload and cancellation.

## Simple agent onboarding

**Welcome a new member** asks only for an optional name. Leaving it empty assigns
the first unused `Agent N` name within that org. **Join and talk about role**
opens the new member's role conversation immediately, without sending a message
or granting role-update permission. Provider, model, profession, prompt and avatar
preferences are absent from the creation form.

The backend defaults to a worker with blank instructions, a desk, and the starter
avatar. It copies only provider/model from the org's PM, or another member if no
PM exists, and falls back to Codex CLI's `default` model for an empty org. Explicit
provider/model values remain supported for existing callers. API providers need
a concrete model ID. No role, profession or project access is copied from another
member, and avatar generation remains an explicit action.

Project access appears as a collapsed summary with a Change control. An existing
project filter can select that org's current project; otherwise new agents have
no project access. Selecting individual projects or all current/future projects
requires changing that setting. Role conversation works without project access.

The profile's collapsed **Advanced settings** can change name, provider/model,
workflow profession, member type and avatar preference. Workflow profession is
separate from the individual role defined through conversation. Settings cannot
alter prompts or project permissions. The backend rejects settings changes while
the agent's response, role draft or avatar is pending, and rejects profession or
member-type changes while unfinished assigned tasks exist. Failed validation
does not partially update the agent. Existing profiles, scopes and role records
remain compatible without a migration.

Validation: 46 world backend tests and 17 world frontend tests passed; the web
production build passed. Isolated browser checks cover 320/390/760px and desktop
creation, blank names, immediate role chat, explicit role updates, persistent
advanced settings and project selection. Browser checks use synthetic responses,
with no live model calls or changes to the production world.
