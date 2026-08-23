// Card 81 — how big a conversation is, in the width a rule has for it.
//
// Lifted out of `MessageList` when the compaction row ran out of room on a
// phone and started truncating this number mid-digit — `889k → 1…`, which is
// the one fact the row exists to report.

/** 168345 → "168k", 1100000 → "1.1M".
 *
 *  The size of a conversation is only ever read as a rough one: the difference
 *  between 168k and 21k is the whole point, the digits under it are not, and
 *  each one costs width the row has not got.
 *
 *  The M tier is not decoration. `1100k` is both wider and slower to read than
 *  `1.1M`, and a million-token context is ordinary now — this number gets past
 *  a million in one afternoon's work. */
export function roughTokens(n: number): string {
  const k = Math.round(n / 1000);
  // Decided on the ROUNDED thousands, not the raw count: 999_600 renders as
  // `1000k` otherwise, which reads as a million without being one.
  if (k >= 1000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1000) return `${k}k`;
  return String(Math.max(0, Math.round(n)));
}
