// The one disclosure of a card that waits on the person.
//
// A decision card arrives folded: the ask, its short facts, the buttons
// (`lib/cardFold` says what is short). Everything else is behind this, and a
// card has exactly one: a line naming what is folded, with its size, and a
// chevron at the end of it. The chevron is the control; the line is its hit
// area.
//
// Where it sits is part of the contract. The line is above what it opens, and
// what it opens is above the card's buttons, so however the card is anchored
// the pointer that opened it is never left over an answer: opening moves what
// is above the detail up, or what is below it down, and the footer is on the
// far side of the detail either way.
//
// That covers the card's own answers. What it cannot cover is everything
// else the move slides about: a card stacked above this one comes down as
// this one shuts, and its Allow can arrive under a pointer that has not
// moved. So a press on a disclosure is remembered for a moment, and a second
// press in the same spot that would land on anything but that disclosure is
// dropped (`lib/cardFold.strayPress`).
//
// Folded is the state a card starts in. A card the person opened stays open
// while it is on screen, by the id of what it asks; nothing is kept past that.
import { useEffect, useId, useState, type AnimationEvent, type ReactNode } from "react";
import {
  capped, cutNote, foldIsOpen, foldPhase, foldPressed, foldSettled, foldStart, strayPress,
  type FoldPhase, type FoldState, type Press,
} from "../lib/cardFold";
import "./CardFold.css";

export type Fold = {
  /** Open, or on its way there: what `aria-expanded` says. */
  open: boolean;
  /** Whether the detail is drawn at all (it still is while it closes). */
  shown: boolean;
  phase: FoldPhase;
  /** The ids of the regions this opens, for `aria-controls`. */
  controls: string;
  /** The id of region `part`. */
  partId: (part?: number) => string;
  toggle: () => void;
  /** A region's own animation ended. */
  settled: () => void;
};

const calm = (): boolean =>
  typeof window !== "undefined" && !!window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;

/** The fold of the card that asks `id`. `parts` is how many regions the one
 *  control opens (a plan opens one under each stage). `startOpen` is for the
 *  tests, which draw static markup and cannot press the control. */
export function useFold(id: string, { parts = 1, startOpen = false }: { parts?: number; startOpen?: boolean } = {}): Fold {
  const base = useId();
  const [state, setState] = useState<FoldState>(() => foldStart(id, startOpen));
  const phase = foldPhase(state, id);
  const open = foldIsOpen(phase);
  // A close with nothing to animate would never hear its animation end.
  useEffect(() => {
    if (phase !== "closing") return;
    const timer = window.setTimeout(() => setState((was) => foldSettled(was, id)), 260);
    return () => window.clearTimeout(timer);
  }, [phase, id]);
  const partId = (part = 0) => `${base}-fold-${part}`;
  return {
    open,
    shown: phase !== "shut",
    phase,
    controls: Array.from({ length: Math.max(1, parts) }, (_, part) => partId(part)).join(" "),
    partId,
    toggle: () => setState((was) => foldPressed(was, id, calm())),
    settled: () => setState((was) => foldSettled(was, id)),
  };
}

/** The last pointer press on a disclosure, and the control it was on. */
let lastPress: (Press & { on: Element }) | null = null;
let guarding = false;

/** Drops a press that repeats the one on a disclosure and would land
 *  somewhere else. On the document, in the capture phase, so it is ahead of
 *  every handler on the page, whichever card the press slid onto. */
function dropStray(event: MouseEvent) {
  if (!lastPress || event.detail === 0) return;
  const next = { x: event.clientX, y: event.clientY, at: performance.now() };
  if (!strayPress(lastPress, next)) return;
  // The same control again is a second press on it: let it close what it opened.
  if (event.target instanceof Node && lastPress.on.contains(event.target)) return;
  event.preventDefault();
  event.stopPropagation();
}

/** A press on a disclosure, as the guard remembers it. A key press has no
 *  spot: focus stays on the control, and nothing slides under a key. */
function notePress(event: { detail: number; clientX: number; clientY: number; currentTarget: Element }) {
  if (event.detail === 0) return;
  lastPress = { x: event.clientX, y: event.clientY, at: performance.now(), on: event.currentTarget };
  if (guarding || typeof document === "undefined") return;
  guarding = true;
  document.addEventListener("click", dropStray, true);
}

/** The control: a chevron, with what it does in its tooltip. `describedBy`
 *  is the id of the words beside it that say what is folded. */
export function FoldToggle({ fold, describedBy, what = "details" }: {
  fold: Fold;
  describedBy?: string;
  /** What it opens, in the tooltip's words: "details", "the tasks". */
  what?: string;
}) {
  const label = `${fold.open ? "Hide" : "Show"} ${what}`;
  return (
    <button
      type="button"
      className="card-fold-toggle"
      aria-expanded={fold.open}
      aria-controls={fold.controls}
      aria-describedby={describedBy}
      aria-label={label}
      title={label}
      onClick={(event) => {
        notePress(event);
        fold.toggle();
      }}
    >
      <span className="card-fold-chevron" aria-hidden="true" />
    </button>
  );
}

/** What is folded, by name and size, and the control at the end of it. A card
 *  with nothing folded draws no line. */
export function FoldLine({ fold, labels, what }: {
  fold: Fold;
  /** One entry per folded part: "Brief · 12 lines". Empty ones are skipped. */
  labels: (string | null | undefined | false)[];
  what?: string;
}) {
  const id = useId();
  const said = labels.filter((label): label is string => !!label);
  if (!said.length) return null;
  return (
    <div className="card-fold-line" data-open={fold.open || undefined}>
      <span className="card-fold-labels" id={id}>
        {said.map((label, index) => <span key={index}>{label}</span>)}
      </span>
      <FoldToggle fold={fold} describedBy={id} what={what} />
    </div>
  );
}

/** What the control opens. The box is always there, so the control always
 *  names something; its content is drawn only while open, and is bounded: a
 *  long detail scrolls inside the card. */
export function FoldBody({ fold, part = 0, className, bounded = true, children }: {
  fold: Fold;
  part?: number;
  className?: string;
  /** Scroll inside the card past a fixed height. Off where the card is in
   *  the conversation's own scroll and has no reason for a second one. */
  bounded?: boolean;
  children: ReactNode;
}) {
  const ended = (event: AnimationEvent<HTMLDivElement>) => {
    if (event.target === event.currentTarget) fold.settled();
  };
  const moving = fold.phase === "opening" || fold.phase === "closing" ? ` is-${fold.phase}` : "";
  return (
    <div
      id={fold.partId(part)}
      className={`card-fold${moving}${className ? ` ${className}` : ""}`}
      hidden={!fold.shown}
      onAnimationEnd={ended}
    >
      {fold.shown && <div className={`card-fold-in${bounded ? " is-bounded" : ""}`}>{children}</div>}
    </div>
  );
}

/** A text opened whole: every character of it, or up to the cap with exactly
 *  how much the cap left out said under it. */
export function WholeText({ text, className = "ask-card-body" }: { text: string; className?: string }) {
  const { shown, hidden } = capped(text);
  return (
    <>
      <pre className={`${className} is-whole`}>{shown}</pre>
      {hidden > 0 && <p className="card-fold-cut" role="note">{cutNote(text.length, hidden)}</p>}
    </>
  );
}
