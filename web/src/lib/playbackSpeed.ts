export const PLAYBACK_RATES = [0.5, 1, 1.25, 1.5, 2] as const;

export const playbackRateLabel = (rate: number) => `${rate}×`;

/** Also handles a rate chosen in native controls outside our list. */
export function nextPlaybackRate(rate: number): number {
  return PLAYBACK_RATES.find((candidate) => candidate > rate) ?? PLAYBACK_RATES[0];
}
