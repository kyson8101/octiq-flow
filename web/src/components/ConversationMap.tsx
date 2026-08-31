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

type Spot = ConversationMapTurn & { offset: number; rank: number };

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

/** The user-message nearest the centre of the visible transcript. It is the
 * bright mark in the rail and the default preview. The rail itself is ordered
 * by turn, not document pixels — a tall tool result must not leave a canyon
 * between two neighbouring conversation points. */
function closestSpot(spots: Spot[], centre: number): Spot | undefined {
  return spots.reduce<Spot | undefined>((nearest, spot) => {
    if (!nearest || Math.abs(spot.offset - centre) < Math.abs(nearest.offset - centre)) return spot;
    return nearest;
  }, undefined);
}

/** Each point owns the next slice of the map. The full slice stays clickable,
 * while its dash is deliberately smaller so neighbouring turns stay distinct. */
export function conversationMapRank(index: number, total: number): number {
  if (total <= 1) return 0;
  return index / total;
}

/** Marks are deliberately content-blind. A map is a rhythm of return points,
 * not a bar chart of which replies happened to be long; the only expansion is
 * the direct hover/focus affordance. */
export function conversationMapPointWidth(pointedAt: boolean): number {
  return pointedAt ? 52 : 12;
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
  const [scrollCentre, setScrollCentre] = useState(0);
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
      const measured = turns.flatMap((turn) => {
        const anchor = anchors.get(turn.id);
        if (!anchor) return [];
        const offset = scroller.scrollTop + anchor.getBoundingClientRect().top - box.top;
        return [{ ...turn, offset }];
      });
      // An anchor can be temporarily absent while the transcript is changing.
      // Pack only the marks that actually rendered, so a missing one never
      // leaves a blank slice in the visual stack.
      setSpots(
        measured.map((spot, index) => ({
          ...spot,
          rank: conversationMapRank(index, measured.length),
        })),
      );
      setScrollCentre(scroller.scrollTop + scroller.clientHeight / 2);
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
      frame.current = requestAnimationFrame(() => setScrollCentre(scroller.scrollTop + scroller.clientHeight / 2));
    };
    scroller.addEventListener("scroll", onScroll, { passive: true });
    return () => {
      cancelAnimationFrame(frame.current);
      scroller.removeEventListener("scroll", onScroll);
    };
  }, [scrollerRef]);

  const selected = useMemo(() => spots.find((spot) => spot.id === pointedAt), [pointedAt, spots]);
  const current = useMemo(() => closestSpot(spots, scrollCentre), [scrollCentre, spots]);
  // Give the normal two-pixel dash three pixels of air before the next turn.
  // At the cap, the dash scales down with its slot rather than turning the map
  // into one dense, continuous line.
  const mapHeight = Math.min(360, Math.max(5, spots.length * 5));
  const mapSlotHeight = mapHeight / Math.max(spots.length, 1);

  if (turns.length === 0) return null;

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
      <div className="conversation-map-body" style={{ height: `${mapHeight}px` }}>
        <div className="conversation-map-points">
          {spots.map((spot) => (
            <button
              key={spot.id}
              className={`conversation-map-point ${current?.id === spot.id ? "is-current" : ""}`}
              type="button"
              style={{
                top: `${spot.rank * mapHeight}px`,
                height: `${mapSlotHeight}px`,
                width: `${conversationMapPointWidth(pointedAt === spot.id)}px`,
              }}
              aria-label={`Jump to message: ${spot.prompt}`}
              aria-current={current?.id === spot.id ? "location" : undefined}
              onPointerEnter={() => setPointedAt(spot.id)}
              onPointerLeave={() => setPointedAt(null)}
              onFocus={() => setPointedAt(spot.id)}
              onBlur={() => setPointedAt(null)}
              onClick={() => jumpTo(spot)}
            />
          ))}
        </div>
        {selected && (
          <div
            className="conversation-map-preview"
            aria-hidden="true"
            // Lifted by half the card's height so it sits centred on its dash.
            style={{ top: `${selected.rank * mapHeight + mapSlotHeight / 2 - 54}px` }}
          >
            <div className="conversation-map-preview-title">{selected.prompt}</div>
            {selected.reply && <div className="conversation-map-preview-body">{selected.reply}</div>}
          </div>
        )}
      </div>
    </aside>
  );
}
