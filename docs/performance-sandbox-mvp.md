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
These operations refuse active turns and queued/background work. Server restarts
invalidate readiness. Readiness is explicitly timestamped evidence, not a liveness
monitor or acceptance of every application feature.

## Isolation and seed

Each environment owns its Compose resources, random SQL password/JWT key and
loopback port. Distinct `*.localhost` hostnames prevent browser cookie collisions.
The host retains a validated resolved configuration for safe stop/reset. Recipes
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
SSO availability. The checker has a separate identity, so it does not revoke a
person's ordinary sandbox session. Database integrity and reset isolation are
separate checks; a reachable port alone cannot mark an environment ready.

## Scope boundary

This MVP prepares an environment before a sandbox-enabled chat starts and gives
the agent its private handoff path. Automatic provisioning per orchestrated task,
coordinator dependency gates and product acceptance workflows remain future work.
Existing progress UI now says **Tasks completed** and **Acceptance: unverified**;
completed tasks or reviews do not establish product acceptance. The broader two
feedback reports remain open until their remaining acceptance criteria are handled.
