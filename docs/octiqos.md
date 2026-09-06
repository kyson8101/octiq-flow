# OctiqOS — Mission control portal

> This page documents the earlier mission portal at `/os?view=legacy`. For the
> current org/office experience at `/os`, see [OctiqOS org world](octiqos-world.md).

OctiqOS is the `/os` portal in this repository. It is a founder-facing command
centre, separate from OctiqFlow's chat/workbench experience at `/`.

## Shared boundary

The portal does not run its own backend or invent a second agent system.

- The existing Rust/Axum server keeps authentication, browser WebSocket access,
  workspaces, and agent sessions.
- OctiqOS adds authenticated commands to that same dispatcher for durable
  operational state.
- PostgreSQL is the live control-plane store. Its objects live under the
  dedicated `octiqos` schema, avoiding generic table-name collisions with the
  rest of the platform.
- Docspace remains the durable, readable record for confirmed decisions,
  project context, and review outcomes.

## Current persisted loop

The first real loop is deliberately supervised:

1. Capture a Company, Personal, or Novel task from the **New task** action and
   optionally link an existing OctiqFlow workspace. The Kanban board is a
   direct view of the durable task state, rather than a separate copy.
2. Ask the read-only PM agent (Codex Terra initially) to return a concrete
   plan, risks, open founder decisions, and evidence of done.
3. OctiqOS records the completed PM response and waits at an explicit
   **Confirm & dispatch** gate.
4. The founder selects Codex or Claude. Dispatch is allowed only when the task
   has a linked workspace; the runner starts in `manual` access mode and must
   still request approval for tool-level effects.
5. A finished runner enters verification with its evidence trail visible in
   the task detail and operating events. The founder closes verification with
   a short evidence note; only then does the card enter **Done** and its active
   work cycle close.

Every card opens a task inspector with its current workflow, PM plans,
approvals, agent runs, and timeline. Abandoning work is a durable terminal
state: it preserves the record and stops attached PM/runner chats. Reopening a
completed, blocked, or abandoned card requires a new instruction, creates a
linked work cycle, and starts again at the read-only PM gate. A completed card
can also be dragged into the PM-planning lane to start that same reopen flow.

The PM chat result is durable PostgreSQL state, not browser-only text. The
private `mission-pm-*` and `mission-run-*` chat keys are the bridge between the
existing OctiqFlow agent runtime and the OctiqOS control plane.

## Founder setup and live control

The **Setup** section of `/os` registers the local folders that are valid
OctiqFlow workspaces. A domain profile can select one registered folder as its
default workspace; new manual and connector-captured tasks in that domain then
inherit that context, while task intake can still deliberately override it.
Workspace registration itself does not start an agent or change a folder.

The task inspector has a durable **Live control** channel. While work is in
flight, the founder can add a constraint, answer a question, or grant/decline a
proposed direction. OctiqOS writes that message to the task record and delivers
it to the same runner as a queued follow-up or a resumed session; it never
silently substitutes a different agent or workspace. Directions sent before a
runner exists are included in the next PM pass.

Runners are instructed to stop at a material decision and end with
`NEEDS FOUNDER DECISION: <precise question>`. OctiqOS records that as an agent
question, places the task in a founder-response state, and resumes only after a
founder direction. This is a conversational approval boundary, not authority
to commit, deploy, make a payment, or perform an external write; those actions
remain governed by the existing manual/tool permission rules and V0 safety
floor.

No provider-specific connector, financial action, NAS write, document deletion,
commit, or deployment is enabled by this slice.

## Workflow profiles

The **Workflow profiles** section of `/os` exposes the three policy envelopes
over the shared control plane:

- **Company** can declare manual, ticket, and feedback intake, then constrain
  its local runner choices and founder approval gates.
- **Personal** keeps financial changes, payments, deletion, and NAS writes as
  hard founder-confirmed gates. It may declare local-LLM work, but that adapter
  is not connected in V0.
- **Novel** can declare Docspace-aware intake and continuity-oriented planning
  without becoming a separate task system.

Editing a profile is durable PostgreSQL state and emits an operating signal.
The policy takes effect immediately at capture, PM-planning, and runner-dispatch
gates: a paused profile accepts no new work; the PM receives its planning style;
and only the profile's allowed runner adapters can dispatch. The V0 safety floor
is not configurable: every execution still needs founder confirmation and
verification evidence before it reaches Done. Codex and Claude are the only
local execution adapters currently installed; DeepSeek and local-LLM choices
are retained as future adapter policy, not silent fallbacks.

## Database setup

The server process must receive `DATABASE_URL` through its local service
environment; never put a production credential in this repository. On startup,
OctiqFlow applies the embedded, ordered OctiqOS migrations once and records
them in `octiqos.schema_migrations`. If the local service has an OctiqOS
environment file, a missing or unavailable database prevents it starting rather
than serving a new binary against an old schema.

The default workflow profiles are part of the migrations so a fresh store is
ready for Company, Personal, and Novel intake. The optional seed below adds
only illustrative tasks, approvals, runs, and events; it remains a deliberate
operator action and must not be used for production onboarding:

```sh
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f db/seeds/0001_octiqos_control_plane.sql
```

The seed is only illustrative startup state. It is idempotent and should not
be used as production onboarding data.

For a fresh development database when no shared PostgreSQL instance is already
available:

```sh
export OCTIQOS_POSTGRES_PASSWORD="choose-a-local-password"
docker compose -f infra/postgres/compose.local.yaml up -d
export DATABASE_URL="postgres://octiqos:${OCTIQOS_POSTGRES_PASSWORD}@127.0.0.1:5438/octiqos"
```

Set `OCTIQOS_POSTGRES_PORT` before starting it if loopback port `5438` is in
use. This compose file is a local-development convenience only.

## Local development

```sh
# Browser portal
pnpm --dir web dev

# Browser production bundle
pnpm --dir web build

# Rust service tests
cd src-tauri && cargo test --lib
```

In development, the Vite client connects to the local OctiqFlow server at
`127.0.0.1:1421`. The running service needs rebuilding/restarting after a
backend command changes; the frontend bundle is picked up after a reload.

For the macOS launchd service, pass `OCTIQOS_DATABASE_URL` only during an
install/reinstall. The installer writes a private `0600` local environment file
and keeps the credential out of the launchd plist and repository:

```sh
OCTIQOS_DATABASE_URL="postgresql://..." \
OCTIQOS_PM_CWD="/path/to/default/planning-context" \
./scripts/install-service.sh
```

An ordinary later `./scripts/install-service.sh` preserves that local store
configuration while replacing the service binary. The installer always rebuilds
the browser bundle before restart, so the WebSocket client and service binary
stay in sync.

### Isolated local preview

Do not install this branch through the production OctiqFlow service. Use the
dedicated preview installer instead:

```sh
OCTIQOS_DATABASE_URL="postgresql://..." ./scripts/install-octiqos-preview.sh
```

It installs `com.kyson.octiqos.preview` on `127.0.0.1:1422` by default, with a
separate `~/.octiqos-preview/` binary, logs, private environment file, browser
token, workspace/chat profile, and owner lock. The script refuses port `1421`.
The OctiqOS PostgreSQL objects stay in their dedicated `octiqos` schema; the
production V2 server neither reads nor writes that control-plane schema.

## Connector intake boundary

The service includes one connector boundary for a future PandaHRMS, calendar,
email, folder, or Docspace adapter. It is off until a long random
`OCTIQOS_INGEST_TOKEN` is placed in the private service environment during an
install/reinstall:

```sh
OCTIQOS_INGEST_TOKEN="$(openssl rand -hex 32)" ./scripts/install-service.sh
```

When enabled, `POST /intake` accepts only a `Bearer` token and an envelope no
larger than 16 KiB:

```json
{
  "source": "ticket",
  "externalId": "pandahrms:ticket:1234",
  "title": "Short founder-visible outcome",
  "detail": "Optional bounded context, not a raw provider payload.",
  "domain": "company"
}
```

The source must already be declared by that domain's workflow profile. An
accepted signal becomes a guarded **Captured** task with a provenance note and
an operating event. The source plus external ID is idempotent, so a provider
retry returns the existing task instead of creating duplicate work. It never
starts a PM or runner, and it never sends data or writes back to the source.

The actual PandaHRMS/calendar/email connector remains a separate opt-in adapter
because it needs an authenticated account, source-specific field mapping, and
an explicit choice of which events should enter the founder's board. Do not use
this endpoint as a raw webhook archive.

## Deployment checks

The service exposes two unauthenticated, data-free checks for a local reverse
proxy or monitor:

- `GET /healthz` confirms that the OctiqFlow process is serving HTTP.
- `GET /readyz` additionally confirms that PostgreSQL is reachable and every
  embedded OctiqOS migration has been applied. It returns `503` until ready.

Keep the server loopback-only unless Cloudflare Access is deliberately
configured in `web.json`. The service refuses a non-loopback bind without that
complete Access configuration; a shared browser token is not a production
access-control model. A Cloudflare Tunnel still uses the normal loopback bind.

## Safety invariants

- Treat ticket, email, calendar, and file content as untrusted input.
- Personal finance stays review-only until the founder explicitly confirms a
  policy and a specific action.
- Workflow profiles configure the same task/run/event/audit kernel rather than
  splitting Company, Personal, and Novel into three orchestration systems.
- An integration runner may schedule or receive low-risk events later, but it
  may not bypass the control-plane approval and evidence trail.
- A confirmed PM plan is not a deployment authorization. Runners do not commit
  or deploy under the initial policy, and financial workflows remain review-only.
- A verifier or founder must record closeout evidence before a task reaches
  Done; a runner completing does not silently declare its own work complete.
- Founder directions and agent questions are concise, durable task messages;
  raw provider transcripts and tool payloads are not copied into the control
  plane.

## Org world redesign

The new `/os` org/office experience is documented in [octiqos-world.md](octiqos-world.md). The supervised mission portal described above remains at `/os?view=legacy`. The new org runtime has separate project scope enforcement, discussion-only meetings, direct delegation, individual memory, token usage, and contribution-based levels. See the new document for provider configuration and current execution boundaries.
