# Local Performance sandbox

This kit runs SQL Server, the Performance API, Core API, Performance frontend,
SSO and a loopback gateway in a separate Docker Compose project for each chat.
Application services have an internal network with no outbound route. Only the
HTTP gateway joins the network used for its dynamically allocated loopback port.
No source database connection is used at runtime.

## Install a project recipe

Prerequisites: a local Docker runtime with Compose, the four application source
checkouts, the prepared `seed.bak` and its private `fixture.json`, and a GitHub
package token with access to the applications' NuGet/npm dependencies. SQL Server
2022 uses an amd64 image. The kit was exercised on an Apple Silicon MacBook with
Colima's emulation; Microsoft does not support SQL Server containers under CPU
emulation, so this is a development fixture, not a production deployment.

```sh
python3 sandboxes/performance/install.py \
  --project /path/to/Performance/frontend \
  --frontend /path/to/Performance/frontend \
  --api /path/to/Performance/api \
  --core /path/to/Core/api \
  --sso /path/to/SSO \
  --seed /private/path/seed.bak \
  --fixture /private/path/fixture.json \
  --package-token-file /private/path/package-token
```

The installer requires a verified fixture. It creates a host-local
`.octiq/sandbox.json` and copies this kit under `.octiq/performance/`. Credentials
and absolute source paths live in a private directory under
`~/.octiqflow/sandbox-recipes/`. It refuses to overwrite an existing recipe. The
package token is passed to builds as a BuildKit secret, never a build argument.

After the OctiqFlow build containing this feature is released, select **Use
sandbox** before starting a chat. **Settings → Sandbox** controls the default for
future chats. Existing chats retain their original choice. Selecting **New
worktree** builds the selected project's source from that worktree; a linked
worktree inherits the primary checkout's local recipe unless it defines its own.
The other three sources remain the paths selected at installation.

Readiness includes ordinary credentials login, profile/company selection,
authenticated appraisal access, anonymous denial and denial of another identity's
profile. Its dedicated `sandbox-check` identity avoids logging the person out
when checks repeat. User-facing test credentials are in the private fixture
manifest. All emails are synthetic `example.invalid` addresses.

## Ownership and lifecycle

Each chat gets its own project ID, database volume, networks, dynamic port, SQL
password and JWT signing key. Its `*.localhost` browser hostname isolates cookies
from other chats. These links open on the **OctiqFlow host computer**; browsing
OctiqFlow remotely does not move the containers to the browser's machine.

The chat's Sandbox panel provides **Start / check**, **Stop services** and
**Reset database…**. Start rebuilds the selected sources and runs readiness.
Stop retains the volume; resume retains both the environment ID and database.
Reset requires confirmation and removes only that environment's volumes before
restoring the seed. Services cannot be changed during a running turn or queued
work. A failed preparation prevents agent launch. Retry after correcting the
setup; start a new chat to choose a different sandbox mode.

The host freezes each environment's resolved Compose configuration so later
recipe changes cannot redirect a reset at different resources. Use a new chat
for recipe/configuration changes. Source code is rebuilt from its recorded
paths. The host records the selected checkout's revision/dirty state, fixture
version and last successful check time in a private `handoff.json`. Checks are
point-in-time evidence, not continuous monitoring or application acceptance.

For a manual preview, set the paths listed in `compose.yaml` in a private env
file, plus a fresh `OCTIQ_SANDBOX_DB_PASSWORD` and `OCTIQ_SANDBOX_JWT_KEY`.
Use a unique `octiq-sb-…` project name for every environment:

```sh
docker compose -p octiq-sb-example --env-file /private/sandbox.env -f sandboxes/performance/compose.yaml up -d --build --wait
docker compose -p octiq-sb-example --env-file /private/sandbox.env -f sandboxes/performance/compose.yaml run --rm --no-deps -T verify
docker compose -p octiq-sb-example --env-file /private/sandbox.env -f sandboxes/performance/compose.yaml port gateway 80
docker compose -p octiq-sb-example --env-file /private/sandbox.env -f sandboxes/performance/compose.yaml down
```

`down --volumes` deletes that manual environment's data. Use it only for an
explicit reset or disposal. The host-managed lifecycle generates and retains
its own runtime credentials automatically.

## Refreshing the seed

The supplied private fixture is derived from a COPY_ONLY, CHECKSUM backup of
`ihrms_tomei`, restored into an owned offline builder. Never run the pruning or
masking SQL against the source. The scripts intentionally require a local Docker
socket and a container named `octiq-seed-tomei-…`, labelled
`octiq.seed=ihrms-tomei-v1`, on `none` or a labelled internal builder network.

The builder record is private JSON containing `container` and `password`, beside
its artifacts. Restore the source as **octiq_seed** on an owned volume, with a
private output directory mounted at `/seed`. No source volumes may be mounted
writable. A temporary loopback proxy named `<builder-container>-export` is used
by SqlPackage; connect it to the internal builder network and a separate bridge,
and publish only `127.0.0.1::1433`. Remove the proxy after export.

1. `trim_seed.py --builder /private/builder.json` generates a private pruning
   plan. Review it, then repeat with `--apply`. It retains Performance rows and
   their FK/implicit application relationships, removes bulk attendance/payroll,
   queues, sessions and logs, and revalidates every foreign key. Source triggers
   are disabled in the fixture to prevent unrelated legacy side effects.
2. Build `password-tool/PasswordTool.csproj` with `/p:PplmPath=/path/to/plugins/Pplm.dll`.
   Run `anonymize_seed.py --builder … --password-tool /path/to/PasswordTool.dll`.
   It uses the application's password algorithm with a new fixture salt and
   password, masks personal/free text and financial values, and preserves
   technical enums and relationship keys. This is a schema-specific generator;
   review masking when the source schema changes.
3. Run `check_actor.py --builder …` to add the dedicated readiness identity.
4. Run `export_seed.py --builder … --sqlpackage /path/to/sqlpackage`. This
   logically exports masked rows to BACPAC, imports **octiq_fixture** into fresh
   files, then writes `seed.bak` and verifies its checksum. A physical backup of
   the trimmed original is deliberately not the distributable artifact because
   deleted source pages can remain in its files.
5. Restore the clean backup in the Compose stack. Run `verify`, browser login,
   database integrity checks and isolation/reset checks before setting the private
   manifest's `status` to `verified`. Record the backup SHA-256, size, row counts,
   check date and source revisions there. Keep seed artifacts and credentials out
   of Git. Remove the raw backup and disposable builder after verification.

The initial fixture contains 12 employees, 19 profiles, 19 synthetic identities
(including readiness), 6 active appraisals and 901 trusted foreign keys. Its
compressed backup is approximately 2.7 MB; data and log files are approximately
72 MB each. Old soft-deleted Performance rows are retained where useful for
relationship consistency. This fixture does not claim full payroll/attendance
coverage or migrate an older schema to match arbitrary future application code.

References: [SQL Server container requirements](https://learn.microsoft.com/en-us/sql/linux/quickstart-install-connect-docker)
and [SqlPackage installation](https://learn.microsoft.com/en-us/sql/tools/sqlpackage/sqlpackage-download).
