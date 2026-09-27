# Performance sandbox MVP

Implemented: host-local Compose lifecycle, a Settings default, a new-chat **Use
sandbox** checkbox, persistent per-chat environments, and a reusable
[Performance kit](../sandboxes/performance/README.md) with a reduced `ihrms_tomei`
fixture. Building this branch does not deploy it to the running OctiqFlow server.
The server and client must be released together before these controls are live.

## Host and chat behavior

Sandboxes always run on the OctiqFlow server's host. A local Docker socket is
required; remote TCP/SSH Docker endpoints are refused. The browser's location
never selects the deployment host. Local VM-backed Docker runtimes count as local.

**Settings → Sandbox → Use sandbox for new chats** is off initially and persisted
in the host profile. The new-chat checkbox overrides that default. The selection
is saved with the chat, survives browser reload and agent resume, and is independent
of tool permissions and **New worktree**. Old chats remain unchanged.

A selected sandbox is built and checked before its agent starts. Missing Docker,
recipe, seed or a failed check prevents launch with an actionable error or private
diagnostic path. Correct the setup and retry the same environment; a new chat is
needed to change its selected mode. Resumes retain the database and environment ID.

The Sandbox panel reports last checked readiness, app links, fixture version and
selected source revision. Start/check rebuilds and verifies; stop preserves data;
confirmed reset deletes only that environment's volumes and restores its seed.
These operations refuse active turns and queued/background work. Readiness is
timestamped evidence, not acceptance of every application feature.

## When "ready" stops being true

A passing check records what it covered (`fingerprint`): `HEAD` and, when dirty,
a digest of the uncommitted contents of every repository the services are built
from — the chat's own folder plus each build context in the frozen Compose
configuration — a digest of the recipe folder and its private env file, and the
fixture version. Digests never leave the host's private state; reads show only
that one was recorded.

Reading the Sandbox panel, the run panel or an agent's snapshot queues a probe of
each ready environment not looked at in the last 20 seconds. One background
thread works the queue; readers never wait for it and nothing polls. A probe that
finds a source, recipe or fixture change marks the environment **stale**; a
service with no container, exited, or reporting unhealthy (a one-shot seed or
restore must have exited 0) marks it **unhealthy**; a probe that cannot finish
marks it unhealthy too. Each keeps `checkedAt`, the last check that passed, and
says why in `invalidated`. Only a new start or check makes it ready again. A
server restart makes earlier readiness `unverified`.

A start after the recipe changed first takes the old stack down with the OLD
frozen configuration, then freezes and validates the new recipe, so cleanup
never follows an altered recipe to other resources. A start whose sources moved
takes the whole stack down before rebuilding (volumes kept), so a service that
would otherwise stay up — a gateway — cannot keep addresses of replaced
containers.

That alone did not cover every start. `up --build` also replaces or restarts
services when nothing was stale: a rebuild that yields new images (the
Performance recipe's .NET, Next.js and Vite builds do), a lost container, or a
restart outside OctiqFlow. The gateway stayed up with the addresses it resolved
at its own start, and on the recreated network Core and the API traded addresses.
Sign-in through the host-issued URL reached the API and got a 404, while the host
said ready (feedback f6886885). So after every `up`, for any reason, the host
reads each running service's start time through the frozen configuration. It
recreates, with `--no-deps --force-recreate` and no build, every running service
that started before a service it depends on (directly or through others in
`depends_on`, one-shots included), and every service that depends on one of
those. Dependencies are never restarted to do it, volumes are kept, and nothing
outside the environment's own Compose project is named. Because this is
stateless, a dependency restarted outside OctiqFlow is repaired by the next
start too. Endpoint ports are read after this, so a recreated gateway's new
loopback port is what the URLs carry. Services a recipe does not declare with
`depends_on` are not refreshed; the readiness check through the gateway, below,
is what catches those.

## Isolation and seed

Each environment owns its Compose resources, random SQL password/JWT key and
loopback port. Distinct `*.localhost` hostnames prevent browser cookie collisions.
The host retains a validated resolved configuration for safe stop/reset.

That frozen configuration is Compose's own `config --format json` output, kept
as printed: Compose reads a JSON model through interpolation again, and its
`config` output already writes every `$` as `$$` for exactly that (checked in
Compose 2.16 through 5.1.0). So a recipe's `$$VAR` healthcheck reaches the shell
as `$VAR`, and a resolved value holding `$` or `$$` stays literal. Before freezing,
the host reads the file back through Compose and refuses to start unless it
reads back as the model it validated. An environment frozen before this check
had every dollar escaped once more (a `$$VAR` healthcheck ran as `$$`, the
shell's PID); its next start or reset freezes it again from the same recipe in
place, keeping the stack and its volumes, and stop keeps working from the old
file until then.

Recipes
cannot use external/shared volumes, privileged/host namespaces, writable host
binds, Docker sockets, fixed container names or fixed/public published ports.
Recipes are trusted setup, not a security boundary around agent tools.

The first recipe builds the real Performance frontend/API, Core API and SSO. App
services use an internal network to prevent external email/integration traffic;
only the HTTP gateway has a loopback publication. A linked worktree inherits the
primary checkout's host-local recipe, with its selected source built from that
worktree. The other application repositories remain configured local paths.

The fixture was prepared from an isolated COPY_ONLY backup of `ihrms_tomei` from
the Mac mini, copied to the MacBook at the person's request. Business rows in the
source were not pruned, masked or otherwise edited. Trimming and masking happened
only in the disposable local copy; a logical export/import creates fresh physical
files before backing up the distributable seed. Private artifacts stay outside Git.

Readiness exercises normal login, selected actor/company, an authenticated
appraisal read, anonymous rejection, an unrelated-profile rejection, frontend and
SSO availability. Every one of those requests goes through the gateway, by the
paths a browser on the host-issued URL uses. Core and the API answering on the
internal network proved nothing about the routes a person takes: the checker used
to call them directly and passed while sign-in through the gateway failed. The
permitted appraisal read runs before the denials, so a refusal is the API
refusing, not a route that is missing. The checker has a separate identity, so it
does not revoke a person's ordinary sandbox session. Database integrity and reset
isolation are separate checks; a reachable port alone cannot mark an environment
ready.

## Scope boundary

This MVP prepares an environment before a sandbox-enabled chat starts and gives
the agent its private handoff path.

**Orchestrated tasks.** A task created with `environment: "sandbox"` gets its
own environment at dispatch. The environment is owned by that attempt's worker
chat and built from that task's worktree. The host builds and checks it off
the scheduler thread; meanwhile the attempt shows the pending host operation
**Preparing test environment**. The worker starts only after the recipe's
readiness check passes, and its chat start hands over the environment ID,
URLs and handoff file. If the environment cannot be made ready (no recipe,
no Docker, a failed build or check), the attempt fails with kind
`environment` and is never retried on its own. The coordinator is told why,
and nothing that depends on the task starts. A task with `environment:
"none"` (the default) starts without one, so a review, a docs task or the
task that repairs the recipe is never blocked by it. Every dispatch builds and
checks the environment again, so readiness is fresh for each dependent job.
A server restart makes earlier readiness `unverified`.
`orchestration_snapshot` lists `environments` (state, `checkedAt`,
`probedAt`, `invalidated`, `stopped`, `heldBy`, URLs, sources) and
`environmentCapacity` separately from task status. The plan card says
**Environment: Test environment, checked before the worker starts**, so the
person approves the requirement too.

**Lifecycle** (`orchestration/environments.rs`). A retry takes over its previous
attempt's environment for the same worktree — same Compose project and volumes —
instead of building a second stack. One reconciler thread, woken by orchestration
and sandbox changes, stops (volumes kept) orchestrated environments nothing
needs. An environment is kept while its attempt is live, while a task that
depends on its passed task is running, while the person holds it (starting or
checking a settled worker's environment from its Sandbox panel holds it; Stop
releases it), and — softly — while a dependant has still to run. Soft holds give
way only when another task is waiting for a slot. A stopped run stops its
environments except held ones; cleaning up a task's workspace stops its
environment first. Ordinary chats' sandboxes are never touched.

**Capacity.** At most `OCTIQ_SANDBOX_LIMIT` (default 3) environments run or
build at once on the host. A sandbox task asks for its own environment and those
of the sandbox tasks it depends on in ONE request: it gets all of them or waits,
in order, as **Waiting for environment capacity** — never half of them, so two
validations that each need two environments cannot deadlock. A request larger
than the limit fails at once with that cause. Leaving the queue (the run stops,
the attempt is replaced) frees nothing it never had. Before its worker starts,
each dependency environment is rechecked, or rebuilt if it went stale, stopped
or unhealthy.

## Checks and acceptance

A task's `kind` is `work` (the default), `check`, `review` or `acceptance`. The
last three judge something: their worker must settle `completed` with a `pass` or
`fail` verdict (a completed report without one is refused), and only a pass
releases their dependants. The kind is part of the plan the person approves.
Tasks created before kinds existed are `work`; no verdict is inferred for them.

The run panel keeps the evidence apart: tasks settled; checks passed, failed and
awaiting (from explicit check tasks, plus verdicts other tasks reported); task
branches merged; sandbox runtime states; deployed runtime (not tracked per run);
and acceptance, which is never inferred from counts — "every planned check
passed" is reported as exactly that. Each sandbox task shows its environment's
state, age, revision and reason beside, not inside, its status.
