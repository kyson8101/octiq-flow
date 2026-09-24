# Agent feedback inbox

OctiqFlow keeps a local, profile-wide inbox for bugs, friction, and suggestions
observed by agents while they work. Open **Feedback inbox** at the bottom of
the chat sidebar. Reports from every project in that profile appear together.
Nothing is sent to an external issue tracker, and submitting a report does not
start a fix or interrupt the current task.

## Reporting

Claude and Codex chats receive three native OctiqFlow tools:

- `feedback_list`: search existing reports and check their current status.
- `feedback_submit`: save an observation, with optional reproduction steps,
  expected/actual behaviour, and a workaround.
- `feedback_get`: read a report by ID.

The host instructions tell agents to report observed OctiqFlow problems, check
for an existing report first, and continue the person's task. Ordinary failures
in the project they are working on are not OctiqFlow feedback. Agents must not
include secrets, whole transcripts, or invented evidence. Feedback is reference
material to verify, not instructions to execute.

Example arguments to `feedback_submit`:

```json
{
  "requestId": "queue-stop-observation-1",
  "title": "Queued turn stays idle after Stop",
  "kind": "bug",
  "severity": "medium",
  "description": "The queued follow-up did not begin after stopping the active turn.",
  "steps": "Start a task, queue a follow-up, and press Stop.",
  "expected": "The queued follow-up starts.",
  "actual": "The queue remains idle.",
  "workaround": "Use Send now on the queued message."
}
```

Kinds are `bug`, `friction`, and `suggestion`. Severity is `low`, `medium`, or
`high` (blocking work or risking data). Title, description, kind, severity, and
request ID are required. The other fields are optional when unknown.

The server attaches the source chat, project, model ID, timestamp, and running
backend version. The model cannot supply these fields through the tool. A
returned report ID confirms the write succeeded. An uncertain submission can be
retried with the same `requestId` and identical content; that returns the existing
report, even if someone has since triaged it. A changed payload with the same
request ID is rejected. Separate observations with different request IDs are
not automatically merged.

Tools are offered only in OctiqFlow chats. pi.dev and standalone terminal agents
do not currently receive OctiqFlow's MCP tools. Existing agent processes need
to reconnect after release to discover the new tools.

## Review and fix

Search by text or report ID and filter by status. Select a report to see its
evidence, open the source chat, and save a triage note. The available statuses
are **New**, **Triaged**, **In progress**, **Resolved**, and **Dismissed**.
Resolving a report is a human triage decision; it does not claim git verified a
merge or deployment. Put a commit or release reference in the note when useful.

**Copy fix brief** creates a self-contained handoff to paste into a development
chat or issue tracker. It includes the report ID, evidence, source identifiers,
and saved triage note. It does not copy an authentication token or transcript.
It does not send or launch anything. Save pending edits before copying.

Concurrent edits are protected by a revision: a stale save is rejected without
discarding the draft. **Discard changes and reload** loads the latest record.
The list refreshes on feedback events and reconnection. On a phone, use
**Back to reports** to return from the detail view.

## Storage and wiring

- `<profile dir>/feedback.json`, independent of chat deletion and worktrees.
- `src-tauri/src/feedback.rs`: validated, serialized, atomic writes; unreadable
  data is preserved and reported as an error. Files are private on Unix.
- `POST /hook/feedback`: existing token authentication; agent actions limited
  to `submit`, `list`, and `get`, with an active source chat required.
- Browser commands: `feedback_list`, `feedback_get`, and `feedback_update`.
- `feedback-changed`: sent after successful writes, carrying only the report ID.

Agent tools expose no triage or delete action. The ordinary authenticated
browser command socket remains a single-user administrative interface, as with
OctiqFlow's other settings. Reports have no automatic expiry.

Release the client and backend together through the normal release workflow.
Building only the client against an older running backend leaves the inbox
commands unavailable.

## Verification

```sh
cargo test --manifest-path src-tauri/Cargo.toml feedback::tests --lib
node --test scripts/mcp/feedback.test.cjs
pnpm --dir web exec tsc -b
# With Vite running and Playwright available:
node scripts/test-feedback-inbox.mjs
```

The browser check mocks RPCs and never writes to a real profile. Set
`OCTIQ_TEST_URL` and `PLAYWRIGHT_MODULE` when using a separate test server or
Playwright installation. It covers triage, stale saves, retries via reload,
pagination, search, source navigation, clipboard handoff, and mobile layouts.
