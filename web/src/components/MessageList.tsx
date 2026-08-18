// The conversation itself.
//
// Each assistant message is a stack of blocks in the order the agent produced
// them: prose, the tool calls it made along the way, more prose. Thinking is
// folded away — it is long, and it is not the answer.
import { useEffect, useRef, useState } from "react";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import type { Block, Message } from "../lib/chat";
import { ToolCard } from "./ToolCard";

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

function BlockView({ block }: { block: Block }) {
  if (block.kind === "text") {
    return (
      <div className="prose">
        <Markdown remarkPlugins={[remarkGfm]}>{block.text}</Markdown>
      </div>
    );
  }
  if (block.kind === "thinking") return <Thinking text={block.text} />;
  return <ToolCard tool={block} />;
}

/** One TURN on screen.
 *
 *  An agent answers with several messages in a row — think, call a tool, think
 *  again, answer — and one bubble per message reads as a stack of fragments
 *  rather than a reply. Consecutive messages from the same side are drawn as a
 *  single turn, so the label appears once and the blocks flow in order. */
function TurnView({ messages }: { messages: Message[] }) {
  const role = messages[0].role;
  const streaming = messages.some((m) => m.streaming);
  const blocks = messages.flatMap((m) => m.blocks);
  return (
    <article className={`msg msg-${role}`}>
      {role === "assistant" && <div className="msg-role">Claude</div>}
      <div className="msg-body">
        {blocks.map((block, i) => (
          <BlockView key={i} block={block} />
        ))}
        {streaming && blocks.length === 0 && <div className="dots" aria-label="working" />}
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

export function MessageList({ messages, busy }: { messages: Message[]; busy: boolean }) {
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
          <TurnView key={turn[0].id} messages={turn} />
        ))}
        {busy && !messages.some((m) => m.streaming) && <div className="dots" aria-label="working" />}
        <div ref={endRef} />
      </div>
    </div>
  );
}
