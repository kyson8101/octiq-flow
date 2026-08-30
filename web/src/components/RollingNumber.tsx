// A changing metric, drawn as the same number turning rather than being
// replaced. Counts, durations, percentages, token usage, and sizes all use
// this one primitive so a live number always has the same little bit of motion.
import { useEffect, useRef, useState } from "react";

/** Kept in step with `roll-digit-up`, `roll-digit-down`, and `roll-flash` in
 * styles.css: the turn itself, plus the beat the new number stays noticed. */
const ROLL_MS = 560;
const FLASH_MS = 900;

/** The rightmost wheel leads, since it is normally where a carry happens. */
const STAGGER_MS = 45;

type Direction = "up" | "down";
type Roll = { from: string; direction: Direction; run: number };

/** Compare digit strings without losing precision on large token counts. */
function compareNumerals(a: string, b: string): number {
  const left = a.replace(/^0+(?=\d)/, "");
  const right = b.replace(/^0+(?=\d)/, "");
  if (left.length !== right.length) return left.length - right.length;
  return left.localeCompare(right);
}

export function rollDirection(from: string, to: string): Direction {
  return compareNumerals(to, from) >= 0 ? "up" : "down";
}

/** One number. Values must be decimal digits; use `RollingText` for signs,
 * units, punctuation, or sentences containing one or more metrics. */
export function RollingNumber({ value }: { value: number | string }) {
  const to = String(value);
  const [roll, setRoll] = useState<Roll | null>(null);
  const [ready, setReady] = useState(false);
  const seen = useRef(to);
  const numeric = /^\d+$/.test(to);

  // Keep the first frame literal. It avoids an initial-load flourish and keeps
  // server markup/hydration simple; only a metric that CHANGES gets wheels.
  useEffect(() => setReady(true), []);

  useEffect(() => {
    const from = seen.current;
    if (to === from) return;
    seen.current = to;

    // A value can legitimately fall: remaining quota, a filtered count, and a
    // timer's seconds all do. Give that change its own downward turn instead
    // of replacing it abruptly.
    const direction = rollDirection(from, to);
    setRoll((current) => ({ from, direction, run: (current?.run ?? 0) + 1 }));
    const timer = setTimeout(() => setRoll(null), ROLL_MS + FLASH_MS);
    return () => clearTimeout(timer);
  }, [to]);

  // This is deliberately forgiving for callers that pass an unexpected value.
  // `RollingText` only sends numeral fragments, but a plain readable value is
  // preferable to throwing while a status row is updating.
  if (!ready || !numeric) return <>{to}</>;

  const digits = to.split("");
  const before = roll ? roll.from.split("") : [];
  // Right-aligning preserves carries: 9 → 10 lines the old 9 up with the new
  // 0, while the new leading 1 turns in from an empty wheel.
  const pad = digits.length - before.length;

  return (
    // Re-keyed on every change so a second update during a turn restarts it.
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

        const beyond =
          roll.direction === "up" ? (Number(digit) + 1) % 10 : (Number(digit) + 9) % 10;
        return (
          <span className="roll-digit" aria-hidden="true" key={i}>
            <span
              className={`roll-stack is-${roll.direction}`}
              style={{ animationDelay: `${(digits.length - 1 - i) * STAGGER_MS}ms` }}
            >
              {/* An upward wheel starts at the old value then reaches the new
                  one. A downward wheel starts at the last cell and settles on
                  the middle one; its extra face supplies the overshoot. */}
              {roll.direction === "up" ? (
                <>
                  <span className="roll-cell">{was}</span>
                  <span className="roll-cell">{digit}</span>
                  <span className="roll-cell">{beyond}</span>
                </>
              ) : (
                <>
                  <span className="roll-cell">{beyond}</span>
                  <span className="roll-cell">{digit}</span>
                  <span className="roll-cell">{was}</span>
                </>
              )}
            </span>
          </span>
        );
      })}
    </span>
  );
}

/** A metric sentence or formatted value. It turns every decimal fragment but
 * keeps punctuation and units still: `1:05`, `$0.004`, and `3 of 5` remain
 * easy to scan while their live figures roll. */
export function RollingText({ children }: { children: string | number }) {
  const [ready, setReady] = useState(false);
  const parts = String(children).split(/(\d+)/);
  useEffect(() => setReady(true), []);
  if (!ready) return <>{children}</>;
  return (
    <span className="roll-text">
      {parts.map((part, index) =>
        /^\d+$/.test(part) ? (
          // Index, rather than the current digits, intentionally preserves the
          // wheel across updates (12 → 13 is one number changing, not two).
          <RollingNumber key={`number-${index}`} value={part} />
        ) : (
          <span className="roll-static" key={`text-${index}`}>
            {part}
          </span>
        ),
      )}
    </span>
  );
}
