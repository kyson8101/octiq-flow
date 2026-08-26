// A count that changes by rolling, not by being replaced.
//
// The group's row is the one thing on screen that holds still while a run
// grows, so the only news in it is the number: 13 becomes 14. That is what
// moves. The digit that changed rolls up to the next one like a wheel,
// overshoots, settles, and stays lit a beat longer so the eye is told where
// the change was. Nothing else in the box twitches — the box swelling and
// glowing was the whole row shouting about one character.
//
// Digits that did NOT change do not move: 13 → 14 rolls one wheel, 19 → 20
// rolls both, 9 → 10 rolls the new leading digit up out of nothing.
import { useEffect, useRef, useState } from "react";

/** Kept in step with `roll-digit-up` + `roll-flash` in styles.css: the roll
 *  itself, plus the beat the new number stays lit afterwards. It only decides
 *  when the stacked wheels come back off. */
const ROLL_MS = 560;
const FLASH_MS = 900;

/** How far apart the wheels start when more than one turns. The rightmost
 *  leads, because it is the one that rolled over and carried the others. */
const STAGGER_MS = 45;

type Roll = { from: string; run: number };

export function RollingNumber({ value }: { value: number }) {
  const to = String(value);
  const [roll, setRoll] = useState<Roll | null>(null);
  const seen = useRef(value);

  useEffect(() => {
    const was = seen.current;
    if (value === was) return;
    seen.current = value;
    // A wheel only turns forwards, and only while the number keeps its shape.
    // A count that fell, or lost a digit, is a different run being drawn — it
    // takes the new number outright rather than pretending to arrive at it.
    if (value < was || String(was).length > String(value).length) {
      setRoll(null);
      return;
    }
    setRoll((r) => ({ from: String(was), run: (r?.run ?? 0) + 1 }));
    const timer = setTimeout(() => setRoll(null), ROLL_MS + FLASH_MS);
    return () => clearTimeout(timer);
  }, [value]);

  const digits = to.split("");
  const before = roll ? roll.from.split("") : [];
  // Right-aligned: 9 → 10 lines the 9 up with the 0, and leaves the 1 with
  // nothing above it to have come from.
  const pad = digits.length - before.length;

  return (
    // Re-keyed on every change so a second call landing mid-roll restarts both
    // animations instead of finishing the first one's.
    <span className={`roll ${roll ? "is-fresh" : ""}`} key={roll?.run ?? 0}>
      <span className="roll-sr">{to}</span>
      {digits.map((digit, i) => {
        const was = roll ? (before[i - pad] ?? "") : digit;
        if (!roll || was === digit) {
          return (
            <span className="roll-digit" aria-hidden="true" key={i}>
              <span className="roll-cell">{digit}</span>
            </span>
          );
        }
        return (
          <span className="roll-digit" aria-hidden="true" key={i}>
            <span
              className="roll-stack"
              style={{ animationDelay: `${(digits.length - 1 - i) * STAGGER_MS}ms` }}
            >
              <span className="roll-cell">{was}</span>
              <span className="roll-cell">{digit}</span>
              {/* The face after the new one. The overshoot is a real wheel
                  going past its stop, so what comes into view past it has to
                  be the next number rather than a gap. */}
              <span className="roll-cell">{(Number(digit) + 1) % 10}</span>
            </span>
          </span>
        );
      })}
    </span>
  );
}
