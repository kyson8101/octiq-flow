// The conversation itself.
//
// Each assistant message is a stack of blocks in the order the agent produced
// them: prose, the tool calls it made along the way, more prose. Thinking is
// not here at all: it is watched live above the composer while it happens (see
// Composer), and a transcript of what the agent said to itself is not what
// anybody scrolls back through — `groupRows` drops those blocks.
//
// A subagent's messages are not part of that stack. They belong to the Task
// call that started them, and they are drawn INSIDE its card — so they are
// lifted out of the conversation here and handed to the card by id. The
// alternative, which is what this did before it knew about them, is a reply
// where a subagent's thinking, tool calls and prose all read as the main
// agent's own.
import { Fragment, memo, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type React from "react";
import Markdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import type { Attached, Block, Message } from "../lib/chat";
import { AgentLogo } from "./AgentLogo";
import { ToolCard } from "./ToolCard";
import { ToolGroup } from "./ToolGroup";
import { SentFiles } from "./Thumb";
import { roughTokens } from "../lib/tokens";
import { groupRows, type Note } from "../lib/toolGroups";
import { useTypewriter } from "../lib/typewriter";
import { closeFence, splitBlocks } from "../lib/blocks";
import { rehypeWordFade } from "../lib/wordfade";
import { ContextReport } from "./ContextReport";
import { parseContextReport } from "../lib/contextReport";
import { copyText } from "../lib/clipboard";
import { clipMessage } from "../lib/clip";
import { ProseLink } from "./ProseLink";
import { ProsePath } from "./ProsePath";
import { PATH_TAG, rehypeFilePaths } from "../lib/filepaths";
import { seatKey, seatTints } from "../lib/seatTint";

/** A table, in a box that scrolls sideways on its own.
 *
 *  The transcript deliberately scrolls one way only — `.msgs` is
 *  `overflow-x: hidden`, because one over-wide child used to drag the whole
 *  app across on a phone and take the header and composer with it. So a table
 *  with more columns than the message column is wide has nowhere to go: it is
 *  cut off at the edge, with nothing to say the rest of it is there.
 *
 *  The box is what gives it somewhere to go. Inside it the table keeps its own
 *  width and is scrolled to; outside it the transcript never moves. */
function ProseTable({ children }: { children?: React.ReactNode }) {
  return (
    <div className="prose-table">
      <table>{children}</table>
    </div>
  );
}

/** A fenced code block, with the one control that matters: copy.
 *  react-markdown hands us the <code> child, whose className carries the fence
 *  language ("language-rust"). */
function CodeBlock({ children }: { children?: React.ReactNode }) {
  const [copied, setCopied] = useState(false);
  const ref = useRef<HTMLPreElement>(null);
  const child = children as { props?: { className?: string } } | undefined;
  const lang = /language-(\w+)/.exec(child?.props?.className ?? "")?.[1] ?? "";

  return (
    <div className="code">
      <div className="code-head">
        <span className="code-lang">{lang || "text"}</span>
        <button
          className="code-copy"
          type="button"
          onClick={async () => {
            // Through the shared helper, which falls back to the old copy API
            // where `navigator.clipboard` does not exist — reaching this app
            // from a phone means a plain-http origin, and this button used to
            // do nothing at all there.
            if (await copyText(ref.current?.innerText ?? "")) {
              setCopied(true);
              setTimeout(() => setCopied(false), 1400);
            }
          }}
        >
          {copied ? "copied" : "copy"}
        </button>
      </div>
      <pre ref={ref}>{children}</pre>
    </div>
  );
}

/** Prose that types itself out while it is still arriving.
 *
 *  Only the block currently being written animates. Anything already finished —
 *  every earlier message, and this one once it ends — renders whole, so
 *  scrolling back never replays the conversation. */
function Prose({ text, animate }: { text: string; animate: boolean }) {
  const shown = useTypewriter(text, animate);

  // `/context` answers in a shape worth drawing rather than reading. Only once
  // it has finished arriving: a half-parsed table would redraw the chart on
  // every delta. Anything that does not parse falls through to the markdown it
  // already was — a wrong chart is worse than an honest table.
  const report = useMemo(
    () => (animate ? null : parseContextReport(text)),
    [text, animate],
  );
  if (report) return <ContextReport report={report} />;

  const caret = animate && shown.length < text.length;

  // Rendered a block at a time. Only the last one is still being written, so
  // everything above it is memoised and stops re-rendering — which is the
  // whole cost of a long streaming reply.
  const blocks = useMemo(() => splitBlocks(shown), [shown]);

  return (
    <div className={`prose ${caret ? "is-typing" : ""}`}>
      {blocks.map((block, i) => (
        <MarkdownBlock
          key={i}
          text={block}
          // Only the block currently arriving fades its words in; doing it to
          // settled blocks would replay the whole reply on every tick.
          animate={animate && i === blocks.length - 1}
        />
      ))}
    </div>
  );
}

/** What the reply's markdown renders as. `PATH_TAG` is not an HTML element —
 *  it is the marker `rehypeFilePaths` leaves behind, and this is what turns it
 *  into something clickable. */
const PROSE_COMPONENTS = {
  pre: CodeBlock,
  table: ProseTable,
  a: ProseLink,
  [PATH_TAG]: ProsePath,
} as Components;

/** One top-level markdown block.
 *
 *  Memoised on its own text: a settled block's text never changes again, so
 *  React skips it entirely once the stream has moved past it. This is the
 *  difference between re-parsing the whole answer on every delta and
 *  re-parsing one paragraph. */
const MarkdownBlock = memo(function MarkdownBlock({
  text,
  animate,
}: {
  text: string;
  animate: boolean;
}) {
  return (
    <Markdown
      remarkPlugins={[remarkGfm]}
      // Paths first: the word fade cuts text into one span per word, and a
      // path cut up that way is no longer there to find.
      rehypePlugins={animate ? [rehypeFilePaths, rehypeWordFade] : [rehypeFilePaths]}
      components={PROSE_COMPONENTS}
    >
      {closeFence(text)}
    </Markdown>
  );
});

/** Subagent messages, by the `tool_use` id of the Task call that owns them. */
type Kids = Map<string, Message[]>;

function BlockView({
  block,
  animate,
  kids,
  note,
}: {
  block: Block;
  animate?: boolean;
  kids: Kids;
  /** Card 73 — a fenced block the reply wrote straight after this call, drawn
   *  inside the card rather than as a box of its own beneath it. `groupRows`
   *  decides which text that is; this only carries it. */
  note?: Note;
}) {
  if (block.kind === "text") return <Prose text={block.text} animate={!!animate} />;
  if (block.kind === "compacted") return <Compacted block={block} />;
  if (block.kind === "notice") return <Notice text={block.text} />;
  // Thinking is watched live above the composer and left out of the transcript;
  // `groupRows` drops it, so this is only ever the belt to that braces.
  if (block.kind === "thinking") return null;
  const own = kids.get(block.id);
  return (
    <ToolCard
      tool={block}
      note={note}
      agent={own?.length ? { steps: own.length, body: <SubAgent messages={own} kids={kids} /> } : undefined}
    />
  );
}

/** A stack of blocks, with long runs of tool calls folded into one row.
 *
 *  Only the LAST row can still be arriving, so only it is allowed to animate —
 *  and a row knows where it ended in the original list, which is why grouping
 *  hands back that position rather than just the calls. */
function Blocks({ blocks, streaming, kids }: { blocks: Block[]; streaming: boolean; kids: Kids }) {
  // A card that has picked up a subagent transcript is never folded away, even
  // when its name is not one of the ones that says so.
  const rows = useMemo(() => groupRows(blocks, (tool) => kids.has(tool.id)), [blocks, kids]);
  const last = blocks.length - 1;
  return (
    <>
      {rows.map((row) =>
        row.kind === "group" ? (
          <ToolGroup key={row.tools[0].id} tools={row.tools} newest={row.newest} />
        ) : (
          <BlockView
            key={row.index}
            block={row.block}
            animate={streaming && row.index === last}
            kids={kids}
            note={row.note}
          />
        ),
      )}
    </>
  );
}

/** A subagent's own working, shown inside the card that started it.
 *
 *  The same blocks as any reply — prose, thinking, its own tool cards, and its
 *  own subagents if it started any. Not grouped into turns and not labelled with
 *  a role: it is one agent working through one job, and the card above it
 *  already says whose job. */
function SubAgent({ messages, kids }: { messages: Message[]; kids: Kids }) {
  const blocks = messages.flatMap((m) => m.blocks);
  const streaming = messages.some((m) => m.streaming);
  return (
    <div className="subagent">
      <Blocks blocks={blocks} streaming={streaming} kids={kids} />
      {streaming && blocks.length === 0 && <div className="dots" aria-label="working" />}
    </div>
  );
}

/** Card 80 — the CLI reporting on a slash command it answered itself.
 *
 *  `/model` and its like never reach the model at all, so this is neither a
 *  reply nor anything anybody typed: it is the tool the agent is running
 *  inside, saying what it did. Quiet, and set apart from both bubbles, because
 *  drawn as either it would claim a speaker that does not exist. */
function Notice({ text }: { text: string }) {
  return <div className="cli-note">{text}</div>;
}

/** Where the agent summarised its own history to make room.
 *
 *  Worth showing rather than hiding: everything above this line is a summary
 *  now, which is the explanation when the agent no longer recalls a detail
 *  from earlier exactly. The line says what it cost — what the conversation
 *  weighed before and after, and who asked — and OPENS onto the summary
 *  itself, which is the one place the reader can check what survived.
 *
 *  Shut by default. The summary is a page of text nobody wants between two
 *  turns, and it is only ever read when something has gone missing. */
function Compacted({ block }: { block: Extract<Block, { kind: "compacted" }> }) {
  const [open, setOpen] = useState(false);
  const has = !!block.text.trim();
  const facts = [
    block.trigger === "manual" ? "you asked" : block.trigger ? "context filled up" : "",
    block.preTokens && block.postTokens
      ? `${roughTokens(block.preTokens)} → ${roughTokens(block.postTokens)} tokens`
      : block.preTokens
        ? `${roughTokens(block.preTokens)} tokens summarised`
        : "",
    block.durationMs ? `${Math.max(1, Math.round(block.durationMs / 1000))}s` : "",
  ].filter(Boolean);

  return (
    <div className={`compacted ${open ? "is-open" : ""}`}>
      <CompactRule>
        {has ? (
          <button
            type="button"
            className="compacted-label is-button"
            aria-expanded={open}
            onClick={() => setOpen(!open)}
          >
            <Chevron open={open} />
            history summarised to make room
            {/* The separator ahead of these is drawn in CSS, not written here: on a
                narrow screen the facts take a line of their own, and a line
                opening with a stray bullet reads as a list item. */}
            {facts.length > 0 && <span className="compacted-facts">{facts.join(" · ")}</span>}
          </button>
        ) : (
          <span className="compacted-label">
            history summarised to make room
            {/* The separator ahead of these is drawn in CSS, not written here: on a
                narrow screen the facts take a line of their own, and a line
                opening with a stray bullet reads as a list item. */}
            {facts.length > 0 && <span className="compacted-facts">{facts.join(" · ")}</span>}
          </span>
        )}
      </CompactRule>
      {open && has && (
        <div className="compacted-body">
          <Prose text={block.text} animate={false} />
        </div>
      )}
    </div>
  );
}

/** The rule a compaction draws across the conversation.
 *
 *  Shared by the compaction that is RUNNING and the one that has finished, on
 *  purpose: it is one event, and it should look like one thing that settles
 *  rather than a bar in one place that disappears and a rule in another that
 *  appears. Same row, same position, same type — only the words change, and
 *  the movement stops. */
function CompactRule({
  children,
  running,
}: {
  children: React.ReactNode;
  running?: boolean;
}) {
  const line = `compacted-line ${running ? "is-running" : ""}`;
  return (
    <div className="compacted-bar">
      <span className={line} aria-hidden="true" />
      {children}
      <span className={line} aria-hidden="true" />
    </div>
  );
}

/** A compaction while it is still running.
 *
 *  The longest wait in the app with nothing to show for it: the agent is
 *  rewriting its own history, and none of that writing reaches the stream. The
 *  CLI tracks its progress internally but drops those events before the JSON we
 *  read, so there is no percentage to draw and none is invented — the rule
 *  simply moves, which answers the only question anyone has ("is this still
 *  going?"), and the seconds beside it are the honest number.
 *
 *  It keeps its own clock: nothing arrives while a compaction runs, so no
 *  re-render would ever come. */
function Compacting({ since }: { since: number }) {
  const [, tick] = useState(0);
  useEffect(() => {
    const timer = setInterval(() => tick((n) => n + 1), 1000);
    return () => clearInterval(timer);
  }, []);
  const secs = Math.max(0, Math.round((Date.now() - since) / 1000));

  return (
    <div className="compacted is-running" role="status">
      <CompactRule running>
        <span className="compacted-label">
          summarising history to make room
          <span className="compacted-facts">{secs}s</span>
        </span>
      </CompactRule>
    </div>
  );
}

function Chevron({ open }: { open: boolean }) {
  return (
    <svg
      className={`compacted-chev ${open ? "is-open" : ""}`}
      width="10"
      height="10"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="3"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="m9 6 6 6-6 6" />
    </svg>
  );
}

/** What you said, cut down when it is long.
 *
 *  A pasted log or a whole file makes a bubble you have to scroll past every
 *  time you come back to the conversation — and what you are coming back for
 *  is the answer under it. So a long message shows its head and offers the
 *  rest. Nothing is hidden for good: the button puts the whole thing back, and
 *  a message that already fits is drawn exactly as before, with no button. */
function UserText({ text }: { text: string }) {
  const [open, setOpen] = useState(false);
  const { head, clipped } = useMemo(() => clipMessage(text), [text]);

  if (!clipped) return <Prose text={text} animate={false} />;

  return (
    <div className={`clip ${open ? "is-open" : "is-cut"}`}>
      <Prose text={open ? text : head} animate={false} />
      <button
        className="clip-more"
        type="button"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
      >
        {open ? "show less" : "show more"}
      </button>
    </div>
  );
}

/** Where an answer stops, because the reader stopped it.
 *
 *  The agent reports a stop by injecting `[Request interrupted by user]` as a
 *  user turn — a shape, not a speaker. Drawn as a bubble it reads as the reader
 *  typing a bracketed sentence at their own agent, and drawn as nothing at all
 *  the reply above simply trails off mid-sentence with no reason given. So it
 *  is drawn as what it is: the line the conversation stops on, across the full
 *  width, quiet enough to scroll past and clear enough to explain the silence
 *  above it.
 *
 *  Muted, not red. Stopping is something the reader chose, not something that
 *  went wrong. */
function StopMark() {
  return (
    <div className="stopmark" role="separator">
      <span className="stopmark-rule" aria-hidden="true" />
      <span className="stopmark-label">
        <svg width="11" height="11" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
          <rect x="5" y="5" width="14" height="14" rx="3" />
        </svg>
        You stopped this
      </span>
      <span className="stopmark-rule" aria-hidden="true" />
    </div>
  );
}

/** One TURN on screen.
 *
 *  An agent answers with several messages in a row — think, call a tool, think
 *  again, answer — and one bubble per message reads as a stack of fragments
 *  rather than a reply. Consecutive messages from the same side are drawn as a
 *  single turn, so the label appears once and the blocks flow in order. */
function TurnView({
  messages,
  kids,
  last,
  busy,
  tints,
}: {
  messages: Message[];
  kids: Kids;
  /** The turn at the bottom — the only one a running agent can still add to. */
  last?: boolean;
  /** Whether the chat is working. A turn can only be waiting its turn while
   *  something else is having one. */
  busy?: boolean;
  /** Which colour each seat in this room speaks in. Empty in an ordinary chat,
   *  which has no seats — see lib/seatTint. */
  tints?: Map<string, number>;
}) {
  const role = messages[0].role;
  // One turn is one voice — `groupTurns` breaks on the seat, so every message
  // here has the same one.
  const speaker = messages[0].speaker;
  // And, on a turn you typed, the seat you addressed it to. Absent for the
  // whole room, which is where every message has always gone.
  const to = messages[0].to;
  // The follow-up brief the host was handed once the others had spoken. Drawn
  // as one line rather than as its words: the brief QUOTES every answer above
  // it in full, so printing it would show the whole discussion twice — see
  // lib/relay.
  const relay = messages[0].relay;
  // Card 75 — the skill a typed command actually resolved to. Drawn as a badge
  // rather than as text in the bubble: it is the system's resolution, not
  // something the person said, and it used to appear as a second line of their
  // own message.
  const ranSkill = messages[0].ranSkill;
  const streaming = messages.some((m) => m.streaming);
  const blocks = messages.flatMap((m) => m.blocks);
  // The answer as it reads on screen. Thinking is left out — it is folded away
  // here for the same reason, it is not the answer — and so are tool calls,
  // whose arguments and results are machinery rather than something you would
  // paste anywhere.
  const answer = blocks
    .filter((b) => b.kind === "text")
    .map((b) => (b as { text: string }).text)
    .join("\n\n")
    .trim();

  // A user turn the agent has not picked up yet. It echoes a message back when
  // it STARTS on it, not when it receives it — measured: a second message sent
  // mid-answer is echoed only after the first turn's result. So an un-echoed
  // bubble is one sitting in the queue, and saying so is the difference between
  // "it is ignoring me" and "it will get to it".
  // Only while the chat is actually working. A slash command like /context is
  // answered locally and is never echoed back at all, so "no echo" on its own
  // would leave it marked queued forever — which is how this was first wrong.
  const queued = !!busy && role === "user" && messages.every((m) => !m.echo);

  // Cards 80 and 81 — a turn made ENTIRELY of things that HAPPENED takes no
  // name. A compaction is not something Claude said, and a `/model` answered by
  // the CLI never reached Claude at all; a name over either one attributes it to
  // someone who did not do it. A reply with prose in it is still somebody
  // talking, event blocks beside the prose or not.
  const allEvent =
    blocks.length > 0 && blocks.every((b) => b.kind === "compacted" || b.kind === "notice");

  // What was attached to this turn. Taken across the messages the turn is made
  // of, and de-duplicated by path: the agent echoes a user turn back, so the
  // same file can arrive twice by two routes.
  const files = useMemo(() => {
    const seen = new Map<string, Attached>();
    for (const m of messages) for (const a of m.attachments ?? []) seen.set(a.path, a);
    return [...seen.values()];
  }, [messages]);

  if (relay) {
    return (
      <article className="msg msg-relay">
        <span aria-hidden="true">↳</span> {relay}
      </article>
    );
  }

  // A guest's turn, drawn as its own block. The host keeps the plain full-width
  // prose every chat has always had — it is the voice a room never has to
  // identify, and marking it too would make a one-seat room read as two
  // strangers talking.
  const tint = speaker ? tints?.get(seatKey(speaker)) : undefined;

  return (
    <article
      className={`msg msg-${role} ${speaker ? "msg-seat" : ""} ${queued ? "is-queued" : ""}`}
      data-tint={tint}
    >
      {/* Above your own words, because it changes how they read: "check this"
          means something different said to the room than said to one agent. */}
      {role === "user" && to && <div className="msg-to">to {to.name}</div>}
      {role === "user" && ranSkill && (
        <div className="msg-ran" title="The skill this command resolved to">
          {ranSkill}
        </div>
      )}
      {role === "assistant" && !allEvent && (
        <div className="msg-role">
          {/* Whoever wrote it. The host has no seat and keeps the plain word it
              has always had; a seat says its own name, with its mark, because
              in a room "which of these is talking" is the first question the
              eye asks. */}
          {speaker ? (
            <>
              <AgentLogo agent={speaker.agent === "claude" ? "claude" : "codex"} size={13} />
              {speaker.name}
            </>
          ) : (
            "Claude"
          )}
        </div>
      )}
      <div className="msg-body">
        {/* Above the words, the way they sit above the box while you attach
            them — and because a message whose words are "look at this" makes no
            sense until you have seen the picture it came with. */}
        <SentFiles files={files} />
        {/* Each message you sent is cut on its own — two long pastes in a row
            are two messages, and one "show more" over both would open the pair.
            Anything else in a user turn (there is nothing today) still goes the
            ordinary way. */}
        {role === "user" && blocks.every((b) => b.kind === "text") ? (
          blocks.map((b, i) => <UserText key={i} text={(b as { text: string }).text} />)
        ) : (
          <Blocks blocks={blocks} streaming={streaming} kids={kids} />
        )}
        {streaming && blocks.length === 0 && <div className="dots" aria-label="working" />}
        {queued && <div className="queued">queued</div>}
        {/* Copy, once the turn is over and there is prose worth taking.
            (The files the turn touched used to sit on this row too. They are a
            whole-session question now — see components/SessionFiles.)

            "Over" is not the same as "not streaming", and getting that wrong is
            what made this blink. A turn is a RUN of assistant messages, and the
            agent ends one message and starts another at every tool call — so
            mid-turn there are gaps, several a minute, where nothing is
            streaming and the footer would draw itself and then vanish again. A
            permission dialog holds one of those gaps open for as long as it
            takes to answer, which is how the flicker became impossible to
            miss. The bottom turn is the only one a working agent can still add
            to, so that is the one that has to wait for it to stop. */}
        {role === "assistant" && !streaming && !(busy && last) && answer && (
          <div className="msg-foot">
            <CopyAnswer text={answer} what="reply" />
          </div>
        )}
      </div>
      {/* Your own words, on the same terms — but UNDER the bubble rather than
          in it. The bubble is `.msg-body`, and a row inside the tint reads as
          one more thing you said.

          None of the assistant's timing guards apply here: a turn of yours is
          whole the moment it is on screen, so there is no gap to flicker in.
          What it copies is `answer`, taken from the blocks themselves — so a
          message long enough to be cut down to a head still copies whole,
          which is the case worth having a button for at all. A long press
          still selects part of it, the way it always did; this is the
          shortcut, not the replacement. */}
      {role === "user" && answer && (
        <div className="msg-foot">
          <CopyAnswer text={answer} what="message" />
        </div>
      )}
    </article>
  );
}

/** Copy a whole turn — a reply, or something you said.
 *
 *  Says whether it worked rather than always claiming success: on a plain-http
 *  origin the copy goes through a fallback that can fail outright, and "copied"
 *  over an unchanged clipboard is worse than being told it did not. */
function CopyAnswer({ text, what }: { text: string; what: "reply" | "message" }) {
  const [state, setState] = useState<"idle" | "done" | "failed">("idle");

  return (
    <div className="msg-actions">
      <button
        className={`msg-copy ${state === "done" ? "is-done" : ""}`}
        type="button"
        title={`Copy this ${what}`}
        onClick={async () => {
          const ok = await copyText(text);
          setState(ok ? "done" : "failed");
          setTimeout(() => setState("idle"), 1600);
        }}
      >
        {state === "done" ? <TickIcon /> : <CopyIcon />}
        {state === "done" ? "copied" : state === "failed" ? "could not copy" : "copy"}
      </button>
    </div>
  );
}

function CopyIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <rect x="9" y="9" width="12" height="12" rx="2" />
      <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
    </svg>
  );
}

function TickIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="m20 6-11 11-5-5" />
    </svg>
  );
}

/** Split the conversation into runs of one speaker. */
function groupTurns(messages: Message[]): Message[][] {
  const turns: Message[][] = [];
  for (const m of messages) {
    const last = turns[turns.length - 1];
    // Same side AND same voice. Role alone was right while a conversation had
    // one agent in it: think, call a tool, answer again is one reply and wants
    // one label. In a room it is wrong the moment two seats are consecutive —
    // the second seat's words would be drawn under the first seat's name.
    // A follow-up brief never joins anything, in either direction. It is drawn
    // as one line instead of as its words (see lib/relay), and a line that had
    // swallowed the message you typed just before it would put your words
    // nowhere on screen.
    const alone = !!m.relay || !!last?.[0].relay;
    if (!alone && last && last[0].role === m.role && last[0].speaker?.id === m.speaker?.id)
      last.push(m);
    else turns.push([m]);
  }
  return turns;
}

export function MessageList({
  messages,
  busy,
  stoppedAt,
  compactingSince,
  conversationId,
}: {
  messages: Message[];
  busy: boolean;
  stoppedAt?: string;
  /** When a compaction started, or absent when none is running. It is drawn
   *  at the foot of the conversation, in the SAME line the finished boundary
   *  leaves behind — one thing that starts, runs, and settles in place, rather
   *  than a bar somewhere else that vanishes and is replaced by a rule here. */
  compactingSince?: number;
  /** Which conversation is on screen. This component is REUSED across chats
   *  rather than remounted — a remount would restart the typewriter on a chat
   *  that is still streaming — so it needs telling when the content underneath
   *  it has been swapped for a different conversation. */
  conversationId?: string;
}) {
  const endRef = useRef<HTMLDivElement>(null);
  const scrollerRef = useRef<HTMLDivElement>(null);
  const innerRef = useRef<HTMLDivElement>(null);
  // Only follow the stream while the reader is already at the bottom: yanking
  // the view down while someone is reading back is the worst thing a streaming
  // chat can do.
  const stick = useRef(true);

  // Whether a scroll event came from the READER. Not every scroll event does:
  // pinning to the bottom fires one, and so does content reflowing. Judging
  // "have they scrolled away?" from those was the bug — a file list appearing
  // below the fold looked exactly like the reader scrolling up, so sticking
  // switched itself off and the view stopped short of the bottom.
  //
  // A real gesture always announces itself first (wheel, touch, key, or a grab
  // of the scrollbar), so only scroll events that follow one are believed.
  const gesture = useRef(false);

  useEffect(() => {
    const el = scrollerRef.current;
    if (!el) return;
    let until = 0;
    const mark = () => {
      gesture.current = true;
      window.clearTimeout(until);
      // Long enough to cover the scroll events one flick produces, short
      // enough that it cannot be mistaken for the next thing that happens.
      until = window.setTimeout(() => (gesture.current = false), 400);
    };
    const onScroll = () => {
      if (!gesture.current) return;
      // A flick on a phone keeps scrolling long after the finger is gone —
      // momentum runs for seconds, while the window above is 400ms. Letting it
      // expire mid-glide was the mobile bug: the rest of the glide arrived
      // unbelieved, `stick` never turned off, and the next height change yanked
      // the reader back to the bottom they had just scrolled away from. The
      // glide is still the reader's gesture, so it keeps the window open.
      mark();
      stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
    };
    el.addEventListener("scroll", onScroll, { passive: true });
    el.addEventListener("wheel", mark, { passive: true });
    el.addEventListener("touchstart", mark, { passive: true });
    el.addEventListener("touchmove", mark, { passive: true });
    el.addEventListener("pointerdown", mark, { passive: true });
    el.addEventListener("keydown", mark);
    return () => {
      window.clearTimeout(until);
      el.removeEventListener("scroll", onScroll);
      el.removeEventListener("wheel", mark);
      el.removeEventListener("touchstart", mark);
      el.removeEventListener("touchmove", mark);
      el.removeEventListener("pointerdown", mark);
      el.removeEventListener("keydown", mark);
    };
  }, []);

  // Opening a different chat starts at the bottom, which is where a
  // conversation is read from. Two things have to be reset, and neither happens
  // on its own: the scroller keeps the pixel offset of the chat you left, and
  // `stick` keeps its answer to a question about that chat — scroll up in one
  // conversation and every one you opened afterwards would stay pinned to the
  // top. Before paint, so there is no flash of the first message.
  useLayoutEffect(() => {
    const el = scrollerRef.current;
    if (!el) return;
    stick.current = true;
    // Whatever gesture opened this chat was aimed at the sidebar, not at the
    // transcript; letting it carry over would judge the new chat by it.
    gesture.current = false;
    el.scrollTop = el.scrollHeight;
  }, [conversationId]);

  // Scrolling to the bottom ONCE is not enough, because the bottom moves
  // afterwards. A turn's file list is fetched from the backend and appears a
  // moment later; a code block reflows; a font finishes loading. Each grows the
  // content below where we just scrolled to — and none of it re-renders this
  // component, so no effect here would fire again.
  //
  // So watch the content itself. Every time it changes height, if the reader is
  // meant to be at the bottom, put them there.
  useEffect(() => {
    const el = scrollerRef.current;
    const inner = innerRef.current;
    if (!el || !inner || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => {
      if (stick.current) el.scrollTop = el.scrollHeight;
    });
    observer.observe(inner);
    return () => observer.disconnect();
  }, []);

  // There is deliberately no `scrollIntoView` pass here.
  //
  // One used to run after EVERY render, which during a stream means once per
  // chunk — and it raced the observer above, two different scroll APIs writing
  // the same position several times a frame. That is what made a reply look
  // jumpy rather than smooth.
  //
  // `scrollIntoView` is also the wrong tool on a phone: it scrolls every
  // scrollable ANCESTOR to bring the target into view, not just this list, so
  // it would drag the whole app shell and take the composer off screen with it.
  // Setting `scrollTop` moves this one element and nothing else, and the
  // observer already fires on every height change the stream produces.

  // The conversation, minus the subagents — and the subagents, filed under the
  // Task call each one belongs to. A subagent message never appears at this
  // level: it is drawn inside that card, by `BlockView`.
  const { turns, kids } = useMemo(() => {
    const kids: Kids = new Map();
    const top: Message[] = [];
    for (const m of messages) {
      if (!m.parent) {
        top.push(m);
        continue;
      }
      const own = kids.get(m.parent);
      if (own) own.push(m);
      else kids.set(m.parent, [m]);
    }
    return { turns: groupTurns(top), kids };
  }, [messages]);

  // Which colour each seat speaks in. Computed over the WHOLE conversation
  // rather than per turn, because the colours are handed out in order of first
  // appearance and a turn cannot see who came before it.
  const tints = useMemo(() => seatTints(messages), [messages]);

  return (
    <div className="msgs" ref={scrollerRef}>
      <div className="msgs-inner" ref={innerRef}>
        {turns.map((turn, i) => (
          <Fragment key={turn[0].id}>
            <TurnView
              messages={turn}
              kids={kids}
              last={i === turns.length - 1}
              busy={busy}
              tints={tints}
            />
            {/* Under the turn, not inside it: what it marks is where the answer
                ENDS, and the reader's own next message reads differently once
                they can see the one above it never finished. */}
            {!!stoppedAt && turn.some((m) => m.id === stoppedAt) && <StopMark />}
          </Fragment>
        ))}
        {compactingSince !== undefined && <Compacting since={compactingSince} />}
        {/* The dots come and go SEVERAL TIMES A MINUTE — the agent stops
            streaming at every tool call and starts again after it — so the row
            they live in is held open whether they are showing or not. Drawn
            only when working, it would add its own height and the gap above it
            each time, and the whole transcript would step up and down under
            the reader for the length of a turn.

            Not while compacting: the line above already says what the silence
            is, and two "something is happening" marks under each other say it
            twice. */}
        <div className="dots-slot">
          {busy && compactingSince === undefined && !messages.some((m) => m.streaming) && (
            <div className="dots" aria-label="working" />
          )}
        </div>
        <div ref={endRef} />
      </div>
    </div>
  );
}

/** One subagent's whole transcript, on its own.
 *
 *  The agent rail's focus view: the same blocks the Task card nests, lifted out
 *  and shown alone so several long runs can be read one at a time. It reuses
 *  `SubAgent` rather than re-rendering blocks itself — a second block renderer
 *  is a second place for prose, thinking and tool cards to drift apart.
 *
 *  `parent` is the `tool_use` id of the Task call. Returns null when that call
 *  produced no transcript, which happens: a subagent's messages are not
 *  guaranteed to reach this stream at all. */
export function AgentTranscript({ messages, parent }: { messages: Message[]; parent: string }) {
  const kids: Kids = new Map();
  for (const m of messages) {
    if (!m.parent) continue;
    const own = kids.get(m.parent);
    if (own) own.push(m);
    else kids.set(m.parent, [m]);
  }
  const own = kids.get(parent);
  if (!own?.length) return null;
  return <SubAgent messages={own} kids={kids} />;
}
