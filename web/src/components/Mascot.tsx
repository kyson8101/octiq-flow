import type { CSSProperties } from "react";
import type { ComposerStyle } from "../lib/agentProviders";
import { ROBOT_DESIGNS, robotBody } from "../lib/mascotDesign";
import type { MascotMood } from "../lib/mascotDesign";
import "./Mascot.css";

export type { MascotMood } from "../lib/mascotDesign";

const EXPRESSIONS = {
  idle: { left: "M 29 44 Q 34 36 39 44", right: "M 61 44 Q 66 36 71 44", mouth: "M 40 61 Q 50 70 60 61" },
  still: { left: "M 34 39 L 34 46", right: "M 66 39 L 66 46", mouth: "M 44 63 L 56 63" },
  think: { left: "M 32 39 L 32 44", right: "M 64 37 L 64 42", mouth: "M 48 64 Q 54 60 59 63" },
  work: { left: "M 29 40 L 39 43 L 34 48", right: "M 71 40 L 61 43 L 66 48", mouth: "M 43 62 Q 50 66 57 62" },
  asleep: { left: "M 28 44 Q 34 49 40 44", right: "M 60 44 Q 66 49 72 44", mouth: "M 47 63 Q 50 66 53 63" },
} as const;

/** Circular model portraits; expressions follow the existing session state. */
export function Mascot({
  robot = "sonnet", size = 28, alert = false, mood = "idle", asleep = false,
}: {
  robot?: ComposerStyle;
  size?: number;
  alert?: boolean;
  /** Idle smiles, think ponders, work focuses; still is a static neutral face. */
  mood?: MascotMood;
  /** A reaped session closes its eyes. */
  asleep?: boolean;
}) {
  const expression = asleep ? "asleep" : mood;
  const face = EXPRESSIONS[expression];
  return (
    <span
      className={`mascot${alert ? " is-alert" : ""}${asleep ? " is-asleep" : ""}`}
      data-robot={robot}
      data-mood={mood}
      data-expression={expression}
      style={{ width: size, height: size, "--mascot-size": `${size}px`, "--robot-accent": ROBOT_DESIGNS[robotBody(robot)].color } as CSSProperties}
      aria-hidden="true"
    >
      <svg className="mascot-avatar" viewBox="0 0 100 100" width={size} height={size} fill="none" focusable="false">
        <circle className="mascot-avatar-base" cx="50" cy="50" r="48" />
        <circle className="mascot-avatar-ring" cx="50" cy="50" r="46" strokeWidth="2" />
        <g className="mascot-avatar-face" strokeWidth="4.5" strokeLinecap="round" strokeLinejoin="round">
          <g className="mascot-avatar-eyes"><path d={face.left} /><path d={face.right} /></g>
          <path className="mascot-avatar-mouth" d={face.mouth} strokeWidth="3" />
        </g>
      </svg>
      {robot.startsWith("pi") && <span className="mascot-provider-badge" data-provider-mark="pi">P</span>}
      {asleep && <span className="mascot-z">z</span>}
    </span>
  );
}
