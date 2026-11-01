import { useLayoutEffect, useState } from "react";
import { nextPlaybackRate, playbackRateLabel } from "../lib/playbackSpeed";
import "./PlaybackSpeed.css";

/** The element keeps the rate through floating/PiP and adoption. Never reset
 * it on bind, or override the browser's default preservesPitch=true. */
export function PlaybackSpeed({ element }: { element: HTMLMediaElement | null }) {
  const [rate, setRate] = useState(1);
  useLayoutEffect(() => {
    if (!element) return;
    const read = () => setRate(element.playbackRate);
    read();
    element.addEventListener("ratechange", read);
    return () => element.removeEventListener("ratechange", read);
  }, [element]);
  const label = playbackRateLabel(element ? rate : 1);
  return <button type="button" className="playback-speed" disabled={!element}
    aria-label={`Playback speed, ${label}`}
    title="Playback speed: 0.5×, 1×, 1.25×, 1.5×, 2×. Press to cycle."
    onClick={() => {
      if (!element) return;
      element.playbackRate = nextPlaybackRate(element.playbackRate);
      setRate(element.playbackRate);
    }}>{label}</button>;
}
