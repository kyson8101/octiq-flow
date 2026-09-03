// One copy button, wherever a copy button is wanted.
//
// It began beside a pinned file (see SessionFiles) and is now also in the file
// panel's header, which is why it lives here rather than in either of them.
//
// Two things make it worth a component rather than an onClick:
//
//   · It says what actually HAPPENED. This app is reached over plain http from
//     a phone, where `navigator.clipboard` does not exist and the fallback can
//     be refused — "copied" over an unchanged clipboard is worse than being
//     told it did not work. So `copyText` reports, and the button's title and
//     colour follow: green for a copy that landed, amber for one that had
//     nothing to copy or only got half a file, red for one the browser refused.
//
//   · The reading can happen BEFORE the click. A clipboard write is only
//     allowed while the page still holds the gesture that asked for it, and an
//     `await` in front of it spends that gesture. `arm` is the hint that a
//     click looks likely — a hover, a focus, a pointer coming down — so a
//     caller that has to fetch what it copies can have it in hand by then.
import { useState } from "react";
import type React from "react";
import { copyText } from "../lib/clipboard";

/** What a copy button found to copy: the text, or `null` for "there is nothing
 *  here to put on a clipboard". `partial` when only the head of the file came
 *  back — the backend caps a preview read, and a silently half-copied file is
 *  exactly the kind of quiet lie a copy button must not tell. */
export type Copyable = { text: string | null; partial?: boolean };

export function CopyBit({
  icon,
  idle,
  done,
  empty,
  partial,
  arm,
  read,
  className = "sfp-act",
}: {
  icon: React.ReactNode;
  /** What the button offers, before it has been pressed. */
  idle: string;
  /** What it says after it worked. */
  done: string;
  /** What it says when there was nothing worth copying. */
  empty?: string;
  /** What it says when only part of the file came back. */
  partial?: string;
  /** Called when a click looks likely, to get any reading out of the way. */
  arm?: () => void;
  read: () => Copyable | Promise<Copyable>;
  /** The base class. The `is-done` / `is-warn` / `is-failed` modifiers are
   *  added to whatever this is, so a second home only needs its own resting
   *  style — see `.sfp-act` and `.panel-act`. */
  className?: string;
}) {
  const [state, setState] = useState<"idle" | "done" | "warn" | "failed">("idle");
  const [said, setSaid] = useState(idle);

  const settle = (next: "done" | "warn" | "failed", words: string) => {
    setState(next);
    setSaid(words);
    setTimeout(() => {
      setState("idle");
      setSaid(idle);
    }, 1600);
  };

  return (
    <button
      className={`${className} is-${state}`}
      type="button"
      title={said}
      aria-label={said}
      onPointerEnter={arm}
      onPointerDown={arm}
      onFocus={arm}
      onClick={async () => {
        const found = read();
        const { text, partial: cut } = found instanceof Promise ? await found : found;
        if (text === null || text === "") {
          settle("warn", empty ?? "Nothing to copy");
          return;
        }
        if (!(await copyText(text))) {
          settle("failed", "Could not copy");
          return;
        }
        settle(cut ? "warn" : "done", cut ? (partial ?? done) : done);
      }}
    >
      {state === "done" ? <TickIcon /> : icon}
    </button>
  );
}

/** Two sheets, one behind the other — an address, or anything else short. */
export function CopyIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <rect x="9" y="9" width="12" height="12" rx="2" />
      <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
    </svg>
  );
}

/** A page with words on it — the file's contents, as against its address. */
export function TextIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8Z" />
      <path d="M14 2v6h6" />
      <path d="M8 13h8" />
      <path d="M8 17h5" />
    </svg>
  );
}

export function TickIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="m20 6-11 11-5-5" />
    </svg>
  );
}
