// The blocks of an assistant message and the small components beside them (moved verbatim from MessageList.tsx).
import { Prose } from "./MessageProse";
import { ReadingScope, useReadingState } from "../lib/useReadingState";
import { useContext, useEffect, useMemo, useState } from "react";
import type React from "react";
import type { Block, Message } from "../lib/chat";
import { ToolCard } from "./ToolCard";
import { ToolGroup } from "./ToolGroup";
import { MemoryNote } from "./MemoryNote";
import { PlanAutoApprovedNote } from "./PlanAutoApprovedNote";
import { ReopenedNote } from "./ReopenedNote";
import { AnsweredInline, AskInline, AskPlacesContext } from "./InlineQuestions";
import { askAnswer, isAskTool } from "../lib/askAnswer";
import { lateAnswerTo } from "../lib/questionBlock";
import { useLiveEntry } from "./Arrive";
import { useRunningCalls } from "./Background";
import { roughTokens } from "../lib/tokens";
import { groupRows, type Note } from "../lib/toolGroups";
import { turnFold } from "../lib/turnFold";
import { folderLabel, rowFolders } from "../lib/folderHead";
import { TerminalRunContext } from "./RunCommand";
import { clipMessage } from "../lib/clip";
import { ConfigPanel, isConfigUsage } from "./ConfigPanel";
import { RollingText } from "./RollingNumber";

/** Subagent messages, by the `tool_use` id of the Task call that owns them. */
export type Kids = Map<string, Message[]>;

function BlockView({
  block,
  animate,
  kids,
  agentByTool,
  onOpenAgent,
  note,
  folder,
  quietFailure,
}: {
  quietFailure?: boolean;
  block: Block;
  animate?: boolean;
  kids: Kids;
  /** Task call id → agent-run id. Only calls with a real agent run can open
   * the read-only focus screen. */
  agentByTool?: ReadonlyMap<string, string>;
  onOpenAgent?: (id: string) => void;
  /** Card 73 — a fenced block the reply wrote straight after this call, drawn
   *  inside the card rather than as a box of its own beneath it. `groupRows`
   *  decides which text that is; this only carries it. */
  note?: Note;
  /** The folder a header above this row has already named, so the card can show
   *  its file's name alone. Empty where no header applies. */
  folder?: string;
}) {
  // Absent wherever the person cannot answer (a worker's chat, a subagent's
  // view): an `ask_user` call there keeps its tool row.
  const places = useContext(AskPlacesContext);
  // The CLI's own settings list, drawn as settings rather than as the thirty
  // lines of `key=a|b|c` it arrives as. It is the whole of the message when it
  // is there, so nothing else on the turn is lost by replacing it.
  if (block.kind === "text" && isConfigUsage(block.text)) return <ConfigPanel text={block.text} />;
  if (block.kind === "text") return <Prose text={block.text} animate={!!animate} />;
  if (block.kind === "compacted") return <Compacted block={block} />;
  if (block.kind === "notice") return <Notice text={block.text} />;
  if (block.kind === "peer") return <PeerNote block={block} />;
  if (block.kind === "memory") return <MemoryNote activity={block.activity} />;
  if (block.kind === "planAutoApproved") return <PlanAutoApprovedNote record={block.record} />;
  if (block.kind === "reopened") return <ReopenedNote reopened={block.reopened} />;
  // A question whose answer was handed over while its call waited, from the
  // host's line in the record: drawn here unless a call above is its own.
  if (block.kind === "answered") return <AnsweredInline answered={block.answered} />;
  // Thinking is watched live above the composer and left out of the transcript;
  // `groupRows` drops it, so this is only ever the belt to that braces.
  if (block.kind === "thinking") return null;
  // A question put to the person is drawn where it was asked: its options
  // while it waits, the answer once there is one. A call that FAILED keeps its
  // tool row, which is where the failure can be read.
  if (places && block.state !== "error" && isAskTool(block.name)) {
    const asked = askAnswer(block.name, block.args, block.result);
    return <AskInline toolId={block.id} asked={asked} late={asked ? lateAnswerTo(places.late, asked) : null} />;
  }
  const agentId = agentByTool?.get(block.id);
  const own = kids.get(block.id);
  return (
    <ToolCard
      tool={block}
      quietFailure={quietFailure}
      note={note}
      folder={folder}
      agent={
        own?.length
          ? {
              steps: own.length,
              body: (
                <SubAgent
                  messages={own}
                  kids={kids}
                  agentByTool={agentByTool}
                  onOpenAgent={onOpenAgent}
                />
              ),
            }
          : undefined
      }
      onOpenAgent={agentId && onOpenAgent ? () => onOpenAgent(agentId) : undefined}
    />
  );
}

/** A stack of blocks, with long runs of tool calls folded into one row.
 *
 *  Only the LAST row can still be arriving, so only it is allowed to animate —
 *  and a row knows where it ended in the original list, which is why grouping
 *  hands back that position rather than just the calls. */
export function Blocks({
  blocks,
  streaming,
  kids,
  agentByTool,
  onOpenAgent,
  danger,
  hidden,
}: {
  danger?: ReadonlySet<string>;
  hidden?: ReadonlySet<number>;
  blocks: Block[];
  streaming: boolean;
  kids: Kids;
  agentByTool?: ReadonlyMap<string, string>;
  onOpenAgent?: (id: string) => void;
}) {
  // A card that has picked up a subagent transcript is never folded away, even
  // when its name is not one of the ones that says so — nor is one whose
  // background work is still going, which is the same rule for the same reason.
  const running = useRunningCalls();
  const rows = useMemo(
    () => {
      // Group and attach notes in the original sequence. Hiding work must not
      // make a final fence newly adjacent to a retained question or Skill.
      const grouped = groupRows(blocks, (tool) => kids.has(tool.id) || running.has(tool.id));
      if (!hidden?.size) return grouped;
      const visible = new Set(blocks.filter((_, index) => !hidden.has(index)));
      // Rows are indivisible: retain a card/group if any of its source blocks
      // (including an originally attached note at row.index) remains visible.
      return grouped.filter((row) => !hidden.has(row.index) || (row.kind === "block"
        ? visible.has(row.block)
        : visible.has(row.newest) || row.tools.some((tool) => visible.has(tool))));
    },
    [blocks, kids, running, hidden],
  );
  // Where each row's files are. Two things read it: the header drawn above a
  // row whose folder is not the one above it, and the cards themselves, which
  // drop the folder from their detail once a header has said it.
  const folders = useMemo(() => rowFolders(rows), [rows]);
  const last = blocks.length - 1;
  return (
    <>
      {rows.map((row, i) => {
        const folder = folders[i];
        const heads = !!folder && folder !== folders[i - 1];
        const key = row.kind === "group" ? (row.tools[0]?.id ?? row.newest.id) : blocks.indexOf(row.block);
        return (
          <ReadingScope key={key} id={key}>
            {heads && <FolderHead dir={folder} />}
            {row.kind === "group" ? (
              <ToolGroup tools={row.tools} newest={row.newest} folder={folder} note={row.note} danger={danger} />
            ) : (
              <BlockView
                block={row.block}
                quietFailure={row.block.kind === "tool" && danger !== undefined && !danger.has(row.block.id)}
                animate={streaming && row.index === last}
                kids={kids}
                agentByTool={agentByTool}
                onOpenAgent={onOpenAgent}
                note={row.note}
                folder={folder}
              />
            )}
          </ReadingScope>
        );
      })}
    </>
  );
}

/** The folder the cards under this are in.
 *
 *  Not a card itself, and drawn as small and as quiet as it can be while still
 *  being read: it is a label on a run, not a thing that happened in it. It
 *  lines up with the NAMES on the rows below rather than with their left edge,
 *  so the column of names is unbroken and this hangs off the side of it. */
function FolderHead({ dir }: { dir: string }) {
  return (
    <div className="folder-head" title={dir}>
      <FolderIcon />
      <span className="folder-head-name">{folderLabel(dir)}</span>
    </div>
  );
}

function FolderIcon() {
  return (
    <svg
      width="13"
      height="13"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.9"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z" />
    </svg>
  );
}

/** A subagent's own working, shown inside the card that started it.
 *
 *  The same blocks as any reply — prose, thinking, its own tool cards, and its
 *  own subagents if it started any. Not grouped into turns and not labelled with
 *  a role: it is one agent working through one job, and the card above it
 *  already says whose job. */
export function SubAgent({
  messages,
  kids,
  agentByTool,
  onOpenAgent,
}: {
  messages: Message[];
  kids: Kids;
  agentByTool?: ReadonlyMap<string, string>;
  onOpenAgent?: (id: string) => void;
}) {
  const blocks = messages.flatMap((m) => m.blocks);
  const streaming = messages.some((m) => m.streaming);
  return (
    <TerminalRunContext.Provider value={null}>
    <div className="subagent">
      <Blocks
        blocks={blocks}
        danger={turnFold(messages, { live: streaming }).danger}
        streaming={streaming}
        kids={kids}
        agentByTool={agentByTool}
        onOpenAgent={onOpenAgent}
      />
      {streaming && blocks.length === 0 && <div className="dots" aria-label="working" />}
    </div>
    </TerminalRunContext.Provider>
  );
}

/** Card 80 — the CLI reporting on a slash command it answered itself.
 *
 *  `/model` and its like never reach the model at all, so this is neither a
 *  reply nor anything anybody typed: it is the tool the agent is running
 *  inside, saying what it did. Quiet, and set apart from both bubbles, because
 *  drawn as either it would claim a speaker that does not exist. */
function Notice({ text }: { text: string }) {
  const entry = useLiveEntry();
  return <div className={`cli-note${entry ? ` ${entry}` : ""}`}>{text}</div>;
}

/** How much of somebody else's message is short enough to simply read.
 *
 *  A session asking a question is a paragraph and shutting it away would hide
 *  the whole point of it. A subagent's report is pages, and pages between two
 *  turns bury the conversation they belong to. One length tells them apart. */
const AT_A_GLANCE = 400;

/** The opening line, flattened to sit on one row beside the sender's name.
 *  List and heading marks come off: `**Verdict**` on a summary line reads as
 *  punctuation rather than as emphasis. */
function opener(text: string): string {
  const line = text.split("\n").find((l) => l.trim()) ?? "";
  return line
    .replace(/^\s*(?:#+|[-*+]|\d+[.)])\s+/, "")
    .replace(/[*_`]/g, "")
    .trim();
}

/** A subagent's task id is sixteen hex characters and nobody reads sixteen.
 *  Enough of it to tell two reports apart, which is all it is ever used for. */
function shortId(id: string): string {
  return id.length > 8 ? id.slice(0, 8) : id;
}

/** Somebody else's words, handed to this agent by the harness.
 *
 *  A subagent handing its final report back, or another Claude session on this
 *  machine talking to this one. The conversation has two sides and this belongs
 *  to neither: drawn on the user's side it was the reader pasting a wall of XML
 *  at their own agent, with "Sent" stamped underneath; drawn as a reply it
 *  would be this agent claiming work it did not do.
 *
 *  So it says WHO first — the one thing the turns around it cannot show — and
 *  opens onto what they said. See lib/peerMessage for the frame and the
 *  boilerplate that come off on the way in. */
function PeerNote({ block }: { block: Extract<Block, { kind: "peer" }> }) {
  const [open, setOpen] = useReadingState<boolean>("peer", block.text.length <= AT_A_GLANCE);
  const who =
    block.source === "handback"
      ? `subagent ${shortId(block.from)} reported back`
      : `${block.from || "another session"} sent a message`;
  const opening = opener(block.text);
  const entry = useLiveEntry();

  return (
    <div className={`peer-note ${open ? "is-open" : ""}${entry ? ` ${entry}` : ""}`} data-peer={block.source}>
      <button
        type="button"
        className="peer-note-head"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
      >
        <Chevron open={open} />
        <span className="peer-note-who">{who}</span>
        {/* Only while it is shut. Open, the line is the first thing under it,
            and the row would be saying it twice. */}
        {!open && opening && <span className="peer-note-opening">{opening}</span>}
      </button>
      {open && (
        <div className="peer-note-body">
          <Prose text={block.text} animate={false} />
        </div>
      )}
    </div>
  );
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
  const [open, setOpen] = useReadingState<boolean>("open", false);
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
            {facts.length > 0 && (
              <span className="compacted-facts">
                <RollingText>{facts.join(" · ")}</RollingText>
              </span>
            )}
          </button>
        ) : (
          <span className="compacted-label">
            history summarised to make room
            {/* The separator ahead of these is drawn in CSS, not written here: on a
                narrow screen the facts take a line of their own, and a line
                opening with a stray bullet reads as a list item. */}
            {facts.length > 0 && (
              <span className="compacted-facts">
                <RollingText>{facts.join(" · ")}</RollingText>
              </span>
            )}
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
      {/* The truck rides the FIRST rule, which is the one rule both layouts
          keep: on a phone the row restacks and the second rule goes away
          entirely (see the 700px block in styles.css). */}
      <span className={line} aria-hidden="true">
        {running && <HaulTruck />}
      </span>
      {children}
      <span className={line} aria-hidden="true" />
    </div>
  );
}

/** The goods, on their way.
 *
 *  A compaction is the longest wait in the app with nothing to report — the
 *  agent is packing everything said so far into a smaller space, and none of
 *  that work reaches the stream. The rule already says "still going"; this says
 *  what is going ON, in the one picture the job actually is: a load being
 *  carted off, crate by crate.
 *
 *  It is decoration and nothing else — no progress is claimed by where the
 *  truck happens to be, because none is reported. Hidden from the reader that
 *  cannot see it (the row's own `role="status"` carries the words), and parked
 *  rather than driven when the machine asks for less movement. */
function HaulTruck() {
  return (
    <span className="compacting-truck" aria-hidden="true">
      <svg className="compacting-truck-art" viewBox="0 0 32 16" width="28" height="14">
        {/* The crates stand TALLER than the cab, and are drawn first: at 28px
            a truck and its load compete for the same few pixels, and the load
            is the half that means something here. They ride a little loose over
            the bumps — the only part of this that moves on its own, because a
            bouncing crate is what makes the rest read as a road rather than a
            drawing. */}
        <g className="compacting-truck-load" fill="currentColor">
          <rect x="1.8" y="4.6" width="7.2" height="5.8" rx="0.7" opacity="0.62" />
          <rect x="9.6" y="6.6" width="6" height="3.8" rx="0.6" opacity="0.85" />
        </g>
        {/* The flatbed under them, then the cab: back, roof, windscreen, bonnet. */}
        <rect x="0.8" y="10.4" width="15.8" height="1.5" rx="0.5" fill="currentColor" />
        <path d="M16.2 11.9V6.2h5l4.4 4v1.7z" fill="currentColor" />
        {/* Glass and hubs are a theme colour rather than a hole: the row sits on
            whatever the transcript's background is, and a hole punched with
            `transparent` would show the moving rule through the cab. */}
        <path d="M20.2 7.4h.9l2.9 2.6h-3.8z" fill="var(--bg-1)" />
        <circle cx="6.4" cy="13.2" r="1.8" fill="currentColor" />
        <circle cx="21.4" cy="13.2" r="1.8" fill="currentColor" />
        <circle cx="6.4" cy="13.2" r="0.65" fill="var(--bg-1)" />
        <circle cx="21.4" cy="13.2" r="0.65" fill="var(--bg-1)" />
      </svg>
    </span>
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
export function Compacting({ since }: { since: number }) {
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
          <span className="compacted-facts">
            <RollingText>{`${secs}s`}</RollingText>
          </span>
        </span>
      </CompactRule>
    </div>
  );
}

export function Chevron({ open }: { open: boolean }) {
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
export function UserText({ text }: { text: string }) {
  const [open, setOpen] = useReadingState<boolean>("open", false);
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
export function StopMark() {
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
