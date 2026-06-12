# octiq bus — agent-to-agent messaging (proof-of-concept)

`octiq` lets two CLI agents in two OctiqFlow terminals hand work to each other
and wait for the answer. Claude can ask Codex to do something, block until Codex
replies, then continue — and vice versa. It is **bidirectional and symmetric**:
either side can ask, either side can serve.

It is a sibling of `octiq-notify` — a small standalone binary, no IPC with the
app. Everything flows through files under a shared bus directory
(`~/.octiqflow/bus` by default), so it works in any two terminals on the same
machine, which is what makes it a clean proof-of-concept.

## Why a "blocking" CLI

CLI agents are **turn-based, not daemons** — they only act when their stdin gets
a line, and they only "wait" by running a command that blocks. So:

- A worker that wants to receive work runs `octiq recv`. It **blocks** (the
  agent's turn waits) until a task arrives, then prints the task.
- The asker runs `octiq ask`. It **blocks** until the worker replies, then prints
  the reply — so the asker reads it as ordinary command output and keeps going.

No shared-file polling convention, no app/PTY changes: the block *is* the wait.

## Commands

```
octiq ask <target> <message...> [--as <name>] [--timeout <secs>]   # default 120s
octiq recv [--as <name>] [--timeout <secs>]                        # default 0 = forever
octiq reply <answer...> [--as <name>]
octiq names
```

**Identity** ("who am I") resolves from `--as`, then `$OCTIQ_BUS_NAME`, then
`$OCTIQ_TERM_KEY` (the stable per-tab key OctiqFlow exports into every shell).
The simplest setup is one `export` per terminal:

```bash
# Claude's terminal
export OCTIQ_BUS_NAME=claude
# Codex's terminal
export OCTIQ_BUS_NAME=codex
```

## The flow, end to end

1. **Codex sits ready for work.** In Codex's terminal, run a serve loop so it
   waits, does each task, replies, and waits again:
   ```bash
   while task=$(octiq recv); do
     # ... Codex does the task described in "$task" ...
     octiq reply "the answer"
   done
   ```
2. **Claude asks.** In Claude's terminal:
   ```bash
   octiq ask codex "Review src/auth.ts and reply with a bullet list of issues."
   ```
   This blocks. Codex's `recv` returns the task; Codex works; `octiq reply`
   sends the answer back.
3. **Claude continues.** The `octiq ask` command unblocks and prints Codex's
   reply, which Claude reads and acts on.

## Briefing the agents

The agents must be told the protocol — paste this into each agent's first prompt
(or a shared `CLAUDE.md` / `AGENTS.md`):

> You can talk to the other agent with the `octiq` CLI. To ask it to do
> something and wait for its answer: `octiq ask <name> "<task>"` (this blocks and
> prints the reply). If you are the worker, run `octiq recv` to wait for a task
> (it blocks and prints the task); do the task; then `octiq reply "<answer>"`.
> Your name is set via `OCTIQ_BUS_NAME`. End a back-and-forth when the task is
> done — do not keep pinging.

## Guardrails / limits (POC)

- **One in-flight request per worker.** `recv` records a single "current"
  request that `reply` consumes. Fine for a single pair of agents; not a queue.
- **No loop guard built in.** Two agents that auto-reply can ping-pong forever
  and burn tokens (now visible in the Dashboard cost readout). Give the agents a
  stop condition — a max number of rounds, or a `DONE` sentinel — in their
  briefing.
- **Agent command timeouts.** Some agent harnesses cap how long a single shell
  command may run. If `octiq recv` (which blocks) gets killed, have the worker
  loop (`while ... do ... done`) so it simply re-waits, or pass `--timeout`.
- **Same machine only.** The bus is a shared local directory.

## Files (for debugging)

Under `~/.octiqflow/bus/` (or `$OCTIQ_BUS_DIR`):

```
<name>/inbox/<ts>-<reqId>.json   a request waiting for <name>
<name>/current.json              the request <name> is currently answering
<name>/replies/<reqId>.json      an answer addressed to <name>
```

Writes are atomic (temp file + rename), so a poller never reads half-written
JSON. `octiq names` lists who has a presence on the bus.

**Path safety.** Every name and request id becomes a path segment under the bus
root, so all of them (`--as`/`OCTIQ_BUS_NAME`, the `ask` target, and the `from`/
`reqId` read back from a request or `current.json`) are validated as simple
identifiers — ASCII letters, digits, `-` and `_`, 1–128 chars. A value with a
slash or `..` is rejected, so a crafted request file or a mistyped
`octiq ask ../foo` can never write a reply outside the bus directory.

## Status

This is a proof-of-concept. The full version would let OctiqFlow itself broker
delivery (so the worker need not run a serve loop), route by tab name, show the
hand-offs on the mission-control board, and enforce a turn cap. The transport
and CLI here are the foundation.
