// The conversation itself.
//
// Each assistant message is a stack of blocks in the order the agent produced
// them: prose, the tool calls it made along the way, more prose. Thinking is
// folded away — it is long, and it is not the answer.
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type React from "react";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import type { Block, Message } from "../lib/chat";
import { ToolCard } from "./ToolCard";
import { closeOpenFences, useTypewriter } from "../lib/typewriter";
import { rehypeWordFade } from "../lib/wordfade";
import { FileList } from "./FileList";
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
  const caret = animate && shown.length < text.length;
  return (
    <div className={`prose ${caret ? "is-typing" : ""}`}>
      <Markdown
        remarkPlugins={[remarkGfm]}
        rehypePlugins={animate ? [rehypeWordFade] : []}
        components={{ pre: CodeBlock }}
      >
        {closeOpenFences(shown)}
      </Markdown>
    </div>
  );
}

function BlockView({ block, animate }: { block: Block; animate?: boolean }) {
  if (block.kind === "text") return <Prose text={block.text} animate={!!animate} />;
  if (block.kind === "thinking") return <Thinking text={block.text} />;
  return <ToolCard tool={block} />;
}

/** One TURN on screen.
 *
 *  An agent answers with several messages in a row — think, call a tool, think
 *  again, answer — and one bubble per message reads as a stack of fragments
 *  rather than a reply. Consecutive messages from the same side are drawn as a
 *  single turn, so the label appears once and the blocks flow in order. */
function TurnView({
  messages,
  stopped,
  cwd,
}: {
  messages: Message[];
  stopped?: boolean;
  cwd?: string;
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

  return (
    <article className={`msg msg-${role}`}>
      {role === "assistant" && <div className="msg-role">Claude</div>}
      <div className="msg-body">
        {blocks.map((block, i) => (
          <BlockView key={i} block={block} animate={streaming && i === blocks.length - 1} />
        ))}
        {streaming && blocks.length === 0 && <div className="dots" aria-label="working" />}
        {stopped && <div className="stopped">Stopped</div>}
        {/* Only once the turn is done, and only when there is prose to take. */}
        {role === "assistant" && !streaming && answer && <CopyAnswer text={answer} />}
        {/* Only once the turn is done: a list that grows while the agent is
            still working would rearrange itself under the reader. */}
        {role === "assistant" && !streaming && cwd !== undefined && (
          <FileList messages={messages} cwd={cwd} />
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
      stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
    };
    el.addEventListener("scroll", onScroll, { passive: true });
    el.addEventListener("wheel", mark, { passive: true });
    el.addEventListener("touchmove", mark, { passive: true });
    el.addEventListener("pointerdown", mark, { passive: true });
    el.addEventListener("keydown", mark);
    return () => {
      window.clearTimeout(until);
      el.removeEventListener("scroll", onScroll);
      el.removeEventListener("wheel", mark);
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

  useEffect(() => {
    if (stick.current) endRef.current?.scrollIntoView({ block: "end" });
  });

  return (
    <div className="msgs" ref={scrollerRef}>
      <div className="msgs-inner" ref={innerRef}>
        {groupTurns(messages).map((turn) => (
          <TurnView
            key={turn[0].id}
            messages={turn}
            stopped={!!stoppedAt && turn.some((m) => m.id === stoppedAt)}
            cwd={cwd}
          />
        ))}
        {busy && !messages.some((m) => m.streaming) && <div className="dots" aria-label="working" />}
        <div ref={endRef} />
      </div>
    </div>
  );
}
