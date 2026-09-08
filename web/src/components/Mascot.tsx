import { useEffect, useRef } from "react";
import type { CSSProperties } from "react";
import type { ComposerStyle } from "../lib/agentProviders";
import { ROBOT_DESIGNS, robotBody } from "../lib/mascotDesign";
import type { MascotMood } from "../lib/mascotDesign";
import "./Mascot.css";

export type { MascotMood } from "../lib/mascotDesign";

/** Big-headed model companions. Animation stays inside a fixed layout slot. */
export function Mascot({
  robot = "sonnet", size = 28, alert = false, mood = "idle", asleep = false,
}: {
  robot?: ComposerStyle;
  size?: number;
  alert?: boolean;
  /** Idle dances, think ponders, work types; still is an explicit static pose. */
  mood?: MascotMood;
  /** A reaped session sleeps instead of dancing. */
  asleep?: boolean;
}) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const host = useRef<HTMLSpanElement>(null);
  const refresh = useRef<(() => void) | undefined>(undefined);
  const state = useRef({ mood, alert, asleep });
  state.current = { mood, alert, asleep };

  useEffect(() => {
    let cancelled = false;
    let detach: (() => void) | undefined;
    // Keep Three.js out of the initial application bundle and SSR path.
    void import("../lib/mascotRenderer").then(({ mountMascot }) => {
      if (!cancelled && canvas.current && host.current) {
        const handle = mountMascot(canvas.current, host.current, robot, () => state.current);
        detach = handle.dispose;
        refresh.current = handle.invalidate;
      }
    }).catch(() => { /* The full-body CSS placeholder also covers unavailable WebGL. */ });
    return () => { cancelled = true; refresh.current = undefined; detach?.(); };
  }, [robot]);

  useEffect(() => { refresh.current?.(); }, [mood, alert, asleep, size]);

  return (
    <span
      ref={host}
      className={`mascot${alert ? " is-alert" : ""}${asleep ? " is-asleep" : ""}`}
      data-robot={robot}
      data-mood={mood}
      style={{ width: size, height: size, "--mascot-size": `${size}px`, "--robot-accent": ROBOT_DESIGNS[robotBody(robot)].color } as CSSProperties}
      aria-hidden="true"
    >
      <span className="mascot-fallback">
        <span className="mascot-fallback-head"><i /><i /></span>
        <span className="mascot-fallback-torso" />
        <span className="mascot-fallback-arm is-left" /><span className="mascot-fallback-arm is-right" />
        <span className="mascot-fallback-leg is-left" /><span className="mascot-fallback-leg is-right" />
      </span>
      <canvas ref={canvas} width={size} height={size} />
      {robot.startsWith("pi") && <span className="mascot-provider-badge" data-provider-mark="pi">P</span>}
      {asleep && <span className="mascot-z">z</span>}
    </span>
  );
}
