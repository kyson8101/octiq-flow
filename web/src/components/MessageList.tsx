// The conversation itself.
//
// Each assistant message is a stack of blocks in the order the agent produced
// them: prose, the tool calls it made along the way, more prose. Thinking is
// folded away — it is long, and it is not the answer.
//
// A subagent's messages are not part of that stack. They belong to the Task
// call that started them, and they are drawn INSIDE its card — so they are
// lifted out of the conversation here and handed to the card by id. The
// alternative, which is what this did before it knew about them, is a reply
// where a subagent's thinking, tool calls and prose all read as the main
// agent's own.
import { memo, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type React from "react";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import type { Block, Message } from "../lib/chat";
import { ToolCard } from "./ToolCard";
import { useTypewriter } from "../lib/typewriter";
import { closeFence, splitBlocks } from "../lib/blocks";
import { rehypeWordFade } from "../lib/wordfade";
import { FileList } from "./FileList";
import { ContextReport } from "./ContextReport";
import { parseContextReport } from "../lib/contextReport";
import { copyText } from "../lib/clipboard";

function Thinking({ text }: { text: string }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="thinking">
      <button className="thinking-head" onClick={() => setOpen((v) => !v)} type="button">
        <span className={`tool-caret ${open ? "is-open" : ""}`} aria-hidden="true">
          ▸
        </span>
        thought for a moment
      </button>
      {open && <div className="thinking-body">{text}</div>}
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
      rehypePlugins={animate ? [rehypeWordFade] : []}
      components={{ pre: CodeBlock }}
    >
      {closeFence(text)}
    </Markdown>
  );
});

/** Subagent messages, by the `tool_use` id of the Task call that owns them. */
type Kids = Map<string, Message[]>;

function BlockView({ block, animate, kids }: { block: Block; animate?: boolean; kids: Kids }) {
  if (block.kind === "text") return <Prose text={block.text} animate={!!animate} />;
  if (block.kind === "thinking") return <Thinking text={block.text} />;
  if (block.kind === "compacted") return <Compacted />;
  const own = kids.get(block.id);
  return (
    <ToolCard
      tool={block}
      agent={own?.length ? { steps: own.length, body: <SubAgent messages={own} kids={kids} /> } : undefined}
    />
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
      {blocks.map((block, i) => (
        <BlockView
          key={i}
          block={block}
          animate={streaming && i === blocks.length - 1}
          kids={kids}
        />
      ))}
      {streaming && blocks.length === 0 && <div className="dots" aria-label="working" />}
    </div>
  );
}

/** A turn's messages plus every subagent message underneath them.
 *
 *  For the file list, which asks what this turn touched — and a file a subagent
 *  edited was still edited by this turn. Nothing else wants this: the reply on
 *  screen, and the text the copy button takes, are the main agent's alone. */
function withDescendants(messages: Message[], kids: Kids): Message[] {
  const out: Message[] = [];
  const walk = (list: Message[]) => {
    for (const m of list) {
      out.push(m);
      for (const b of m.blocks) if (b.kind === "tool") walk(kids.get(b.id) ?? []);
    }
  };
  walk(messages);
  return out;
}

/** Where the agent summarised its own history to make room.
 *
 *  Worth showing rather than hiding: everything above this line is a summary
 *  now, which is the explanation when the agent no longer recalls a detail
 *  from earlier exactly. */
function Compacted() {
  return (
    <div className="compacted">
      <span className="compacted-line" aria-hidden="true" />
      <span className="compacted-label">history summarised to make room</span>
      <span className="compacted-line" aria-hidden="true" />
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
  stopped,
  cwd,
  busy,
}: {
  messages: Message[];
  kids: Kids;
  stopped?: boolean;
  cwd?: string;
  /** Whether the chat is working. A turn can only be waiting its turn while
   *  something else is having one. */
  busy?: boolean;
}) {
  const role = messages[0].role;
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

  return (
    <article className={`msg msg-${role} ${queued ? "is-queued" : ""}`}>
      {role === "assistant" && <div className="msg-role">Claude</div>}
      <div className="msg-body">
        {blocks.map((block, i) => (
          <BlockView key={i} block={block} animate={streaming && i === blocks.length - 1} kids={kids} />
        ))}
        {streaming && blocks.length === 0 && <div className="dots" aria-label="working" />}
        {stopped && <div className="stopped">Stopped</div>}
        {queued && <div className="queued">queued</div>}
        {/* Only once the turn is done, and only when there is prose to take. */}
        {role === "assistant" && !streaming && answer && <CopyAnswer text={answer} />}
        {/* Only once the turn is done: a list that grows while the agent is
            still working would rearrange itself under the reader. */}
        {role === "assistant" && !streaming && cwd !== undefined && (
          <FileList messages={withDescendants(messages, kids)} cwd={cwd} />
        )}
      </div>
    </article>
  );
}

/** Copy a whole reply.
 *
 *  Says whether it worked rather than always claiming success: on a plain-http
 *  origin the copy goes through a fallback that can fail outright, and "copied"
 *  over an unchanged clipboard is worse than being told it did not. */
function CopyAnswer({ text }: { text: string }) {
  const [state, setState] = useState<"idle" | "done" | "failed">("idle");

  return (
    <div className="msg-actions">
      <button
        className={`msg-copy ${state === "done" ? "is-done" : ""}`}
        type="button"
        title="Copy this reply"
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
    if (last && last[0].role === m.role) last.push(m);
    else turns.push([m]);
  }
  return turns;
}

export function MessageList({
  messages,
  busy,
  stoppedAt,
  cwd,
  conversationId,
}: {
  messages: Message[];
  busy: boolean;
  stoppedAt?: string;
  /** The project folder, for turning a relative path in the reply into a real
   *  one. Without it only absolute paths can be listed. */
  cwd?: string;
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

  return (
    <div className="msgs" ref={scrollerRef}>
      <div className="msgs-inner" ref={innerRef}>
        {turns.map((turn) => (
          <TurnView
            key={turn[0].id}
            messages={turn}
            kids={kids}
            stopped={!!stoppedAt && turn.some((m) => m.id === stoppedAt)}
            cwd={cwd}
            busy={busy}
          />
        ))}
        {busy && !messages.some((m) => m.streaming) && <div className="dots" aria-label="working" />}
        <div ref={endRef} />
      </div>
    </div>
  );
}
