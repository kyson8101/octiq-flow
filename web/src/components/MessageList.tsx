// The conversation itself.
//
// Each assistant message is a stack of blocks in the order the agent produced
// them: prose, the tool calls it made along the way, more prose. Thinking is
// folded away — it is long, and it is not the answer.
import { useEffect, useRef, useState } from "react";
import type React from "react";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import type { Block, Message } from "../lib/chat";
import { ToolCard } from "./ToolCard";
import { closeOpenFences, useTypewriter } from "../lib/typewriter";
import { rehypeWordFade } from "../lib/wordfade";

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
            const text = ref.current?.innerText ?? "";
            try {
              await navigator.clipboard.writeText(text);
              setCopied(true);
              setTimeout(() => setCopied(false), 1400);
            } catch {
              /* clipboard blocked (insecure origin): leave the button quiet */
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
function TurnView({ messages, stopped }: { messages: Message[]; stopped?: boolean }) {
  const role = messages[0].role;
  const streaming = messages.some((m) => m.streaming);
  const blocks = messages.flatMap((m) => m.blocks);
  return (
    <article className={`msg msg-${role}`}>
      {role === "assistant" && <div className="msg-role">Claude</div>}
      <div className="msg-body">
        {blocks.map((block, i) => (
          <BlockView key={i} block={block} animate={streaming && i === blocks.length - 1} />
        ))}
        {streaming && blocks.length === 0 && <div className="dots" aria-label="working" />}
        {stopped && <div className="stopped">Stopped</div>}
      </div>
    </article>
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
}: {
  messages: Message[];
  busy: boolean;
  stoppedAt?: string;
}) {
  const endRef = useRef<HTMLDivElement>(null);
  const scrollerRef = useRef<HTMLDivElement>(null);
  // Only follow the stream while the reader is already at the bottom: yanking
  // the view down while someone is reading back is the worst thing a streaming
  // chat can do.
  const stick = useRef(true);

  useEffect(() => {
    const el = scrollerRef.current;
    if (!el) return;
    const onScroll = () => {
      stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
    };
    el.addEventListener("scroll", onScroll, { passive: true });
    return () => el.removeEventListener("scroll", onScroll);
  }, []);

  useEffect(() => {
    if (stick.current) endRef.current?.scrollIntoView({ block: "end" });
  });

  return (
    <div className="msgs" ref={scrollerRef}>
      <div className="msgs-inner">
        {groupTurns(messages).map((turn) => (
          <TurnView
            key={turn[0].id}
            messages={turn}
            stopped={!!stoppedAt && turn.some((m) => m.id === stoppedAt)}
          />
        ))}
        {busy && !messages.some((m) => m.streaming) && <div className="dots" aria-label="working" />}
        <div ref={endRef} />
      </div>
    </div>
  );
}
