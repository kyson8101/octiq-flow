// A small, live map of the conversation.
//
// The map is deliberately keyed to the messages the person SENT, rather than
// every assistant block. One mark is one point to come back to: the prompt and
// the answer it started. Tool calls can make a reply very tall, but they never
// make the rail noisy.
import { useEffect, useMemo, useRef, useState, type RefObject } from "react";
import type { Message } from "../lib/chat";

import "./ConversationMap.css";

export type ConversationMapTurn = {
  id: string;
  prompt: string;
  reply: string;
};

type Spot = ConversationMapTurn & { offset: number; position: number };

type Viewport = { top: number; size: number };

const EMPTY_VIEWPORT: Viewport = { top: 0, size: 1 };

/** A readable, compact line for the map card. Markdown still belongs in the
 * transcript; this is only enough language to recognise a place at a glance. */
function previewText(messages: Message[]): string {
  const text = messages
    .flatMap((message) => message.blocks)
    .filter((block) => block.kind === "text")
    .map((block) => (block as { text: string }).text)
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();

  if (!text) return "";
  return text.length > 260 ? `${text.slice(0, 257).trimEnd()}…` : text;
}

/** Convert the existing visual turns into the map's point breaks.
 *
 * A user turn owns the next assistant turn, even if there are tool cards in
 * it. The pairing is a preview convention only — the browser's real source of
 * position remains the user-turn element in the rendered transcript. */
export function conversationMapTurns(turns: Message[][]): ConversationMapTurn[] {
  return turns.flatMap((turn, index) => {
    if (turn[0]?.role !== "user") return [];

    const answer = turns.slice(index + 1).find((next) => next[0]?.role === "assistant");
    return [
      {
        id: turn[0].id,
        prompt: previewText(turn) || "Message",
        reply: answer ? previewText(answer) : "",
      },
    ];
  });
}

function viewportFor(el: HTMLDivElement): Viewport {
  const height = Math.max(el.scrollHeight, 1);
  return {
    top: Math.max(0, Math.min(1, el.scrollTop / height)),
    size: Math.max(0, Math.min(1, el.clientHeight / height)),
  };
}

/** The user-message nearest the centre of the visible transcript. It is the
 * bright mark in the rail; the large preview waits for an explicit hover or
 * keyboard focus, so it never covers a reader's conversation by itself. */
function closestSpot(spots: Spot[], view: Viewport): Spot | undefined {
  const centre = view.top + view.size / 2;
  return spots.reduce<Spot | undefined>((nearest, spot) => {
    if (!nearest || Math.abs(spot.position - centre) < Math.abs(nearest.position - centre)) return spot;
    return nearest;
  }, undefined);
}

/** Short prompts should read as a small dash; a long prompt with a substantial
 * answer earns more of the minimap's width. The active point still gets the
 * full line, which is the fast way to find the place you are reading. */
function pointWidth(spot: Spot, current: boolean): number {
  if (current) return 52;
  const characters = spot.prompt.length + spot.reply.length;
  return Math.min(44, Math.max(12, 10 + Math.round(Math.log2(characters + 1) * 4.5)));
}

export function ConversationMap({
  turns,
  scrollerRef,
  innerRef,
  onJump,
}: {
  turns: ConversationMapTurn[];
  scrollerRef: RefObject<HTMLDivElement | null>;
  innerRef: RefObject<HTMLDivElement | null>;
  /** The transcript owns follow-to-bottom; a map jump hands scrolling back to
   * the reader before moving them away from the end. */
  onJump?: () => void;
}) {
  const [spots, setSpots] = useState<Spot[]>([]);
  const [viewport, setViewport] = useState<Viewport>(EMPTY_VIEWPORT);
  const [pointedAt, setPointedAt] = useState<string | null>(null);
  const frame = useRef(0);

  // The transcript changes height while an answer streams, fonts settle, and
  // a tool card opens. Measure from actual message elements rather than from
  // message data, so the marks remain truthful through all three.
  useEffect(() => {
    const scroller = scrollerRef.current;
    const inner = innerRef.current;
    if (!scroller || !inner) return;

    const measure = () => {
      const box = scroller.getBoundingClientRect();
      const anchors = new Map(
        [...scroller.querySelectorAll<HTMLElement>("[data-map-turn]")].map((element) => [
          element.dataset.mapTurn,
          element,
        ]),
      );
      const height = Math.max(scroller.scrollHeight, 1);
      setSpots(
        turns.flatMap((turn) => {
          const anchor = anchors.get(turn.id);
          if (!anchor) return [];
          const offset = scroller.scrollTop + anchor.getBoundingClientRect().top - box.top;
          return [{ ...turn, offset, position: Math.max(0, Math.min(1, offset / height)) }];
        }),
      );
      setViewport(viewportFor(scroller));
    };

    const scheduleMeasure = () => {
      cancelAnimationFrame(frame.current);
      frame.current = requestAnimationFrame(measure);
    };

    measure();
    const observer = typeof ResizeObserver === "undefined" ? undefined : new ResizeObserver(scheduleMeasure);
    observer?.observe(scroller);
    observer?.observe(inner);
    window.addEventListener("resize", scheduleMeasure);
    return () => {
      cancelAnimationFrame(frame.current);
      observer?.disconnect();
      window.removeEventListener("resize", scheduleMeasure);
    };
  }, [innerRef, scrollerRef, turns]);

  useEffect(() => {
    const scroller = scrollerRef.current;
    if (!scroller) return;
    const onScroll = () => {
      cancelAnimationFrame(frame.current);
      frame.current = requestAnimationFrame(() => setViewport(viewportFor(scroller)));
    };
    scroller.addEventListener("scroll", onScroll, { passive: true });
    return () => {
      cancelAnimationFrame(frame.current);
      scroller.removeEventListener("scroll", onScroll);
    };
  }, [scrollerRef]);

  const selected = useMemo(() => spots.find((spot) => spot.id === pointedAt), [pointedAt, spots]);
  const current = useMemo(() => closestSpot(spots, viewport), [spots, viewport]);

  if (turns.length === 0) return null;

  const viewTop = Math.min(1 - viewport.size, viewport.top);
  const jumpTo = (spot: Spot) => {
    const scroller = scrollerRef.current;
    if (!scroller) return;
    onJump?.();
    const prefersReducedMotion = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
    scroller.scrollTo({
      top: Math.max(0, spot.offset - scroller.clientHeight * 0.2),
      behavior: prefersReducedMotion ? "auto" : "smooth",
    });
  };

  return (
    <aside className="conversation-map" aria-label="Conversation map">
      <div className="conversation-map-body">
        <div className="conversation-map-track" aria-hidden="true">
          <span
            className="conversation-map-viewport"
            style={{ top: `${viewTop * 100}%`, height: `${viewport.size * 100}%` }}
          />
        </div>
        <div className="conversation-map-points">
          {spots.map((spot) => (
            <button
              key={spot.id}
              className={`conversation-map-point ${current?.id === spot.id ? "is-current" : ""}`}
              type="button"
              style={{ top: `${spot.position * 100}%`, width: `${pointWidth(spot, current?.id === spot.id)}px` }}
              aria-label={`Jump to message: ${spot.prompt}`}
              aria-current={current?.id === spot.id ? "location" : undefined}
              title={spot.prompt}
              onPointerEnter={() => setPointedAt(spot.id)}
              onPointerLeave={() => setPointedAt(null)}
              onFocus={() => setPointedAt(spot.id)}
              onBlur={() => setPointedAt(null)}
              onClick={() => jumpTo(spot)}
            />
          ))}
        </div>
        {selected && (
          <div className="conversation-map-preview" aria-hidden="true">
            <div className="conversation-map-preview-title">{selected.prompt}</div>
            {selected.reply && <div className="conversation-map-preview-body">{selected.reply}</div>}
          </div>
        )}
      </div>
    </aside>
  );
}
