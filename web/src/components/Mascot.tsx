import type { CSSProperties } from "react";
import type { ComposerStyle } from "../lib/agentProviders";
import { ROBOT_DESIGNS, robotBody } from "../lib/mascotDesign";
import type { MascotMood } from "../lib/mascotDesign";
import "./Mascot.css";

export type { MascotMood } from "../lib/mascotDesign";

const MOUTHS = {
  idle: "M 42 64 Q 50 75 58 64 Q 50 67 42 64 Z",
  still: "M 45 66 Q 50 70 55 66",
  think: "M 49 68 Q 54 64 59 67",
  work: "M 45 67 Q 50 64 55 67",
  asleep: "M 47 68 C 47 63 53 63 53 68 C 53 73 47 73 47 68 Z",
} as const;

/** Soft, face-only portraits with expressions driven by the session state. */
export function Mascot({
  robot = "sonnet", size = 28, alert = false, mood = "idle", asleep = false,
}: {
  robot?: ComposerStyle;
  size?: number;
  alert?: boolean;
  mood?: MascotMood;
  asleep?: boolean;
}) {
  const body = robotBody(robot);
  const expression = asleep ? "asleep" : mood;
  const thinking = expression === "think";
  const working = expression === "work";
  const eyeY = thinking ? 48 : 51;
  const eyeHeight = working ? 6 : body === "haiku" || body === "luna" ? 9 : 8;
  return (
    <span
      className={`mascot${alert ? " is-alert" : ""}${asleep ? " is-asleep" : ""}`}
      data-robot={robot}
      data-mood={mood}
      data-expression={expression}
      style={{ width: size, height: size, "--mascot-size": `${size}px`, "--robot-accent": ROBOT_DESIGNS[body].color } as CSSProperties}
      aria-hidden="true"
    >
      <svg className="mascot-avatar" viewBox="0 0 100 100" width={size} height={size} fill="none" focusable="false">
        <circle className="mascot-avatar-base" cx="50" cy="50" r="49" />
        <path className="mascot-avatar-shade" d="M 3 59 C 16 92 76 100 97 59 A 49 49 0 0 1 3 59 Z" />
        <g className="mascot-avatar-mark">
          {body === "luna" ? <path d="M 56 15 A 9 9 0 1 0 61 29 A 10 10 0 0 1 56 15 Z" />
            : body === "astra" || body === "opus" ? <path d="M 50 14 Q 52 23 59 24 Q 52 26 50 33 Q 48 26 41 24 Q 48 23 50 14 Z" />
            : body === "sol" ? <><circle cx="50" cy="24" r="6" /><path d="M 50 13 V 15 M 50 33 V 35 M 39 24 H 41 M 59 24 H 61" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" /></>
            : body === "haiku" || body === "terra" ? <path d="M 50 30 Q 34 29 39 17 Q 51 17 50 30 Q 48 16 62 17 Q 63 28 50 30 Z" />
            : body === "fable" ? <path d="M 50 31 C 27 19 47 11 50 21 C 57 10 72 22 50 31 Z" />
            : <path d="M 39 27 Q 42 18 47 25 Q 50 14 55 25 Q 61 20 62 28" stroke="currentColor" strokeWidth="3" strokeLinecap="round" fill="none" />}
        </g>
        <g className="mascot-avatar-face" strokeLinecap="round" strokeLinejoin="round">
          <g className="mascot-avatar-cheeks">
            <ellipse cx="24" cy="63" rx="9" ry="5" />
            <ellipse cx="76" cy="63" rx="9" ry="5" />
          </g>
          <g className="mascot-avatar-eyes">
            {asleep ? <g className="mascot-avatar-ink" strokeWidth="3.5" fill="none">
              <path d="M 27 52 Q 33 58 39 52" /><path d="M 61 52 Q 67 58 73 52" />
            </g> : <>
              {[33, 67].map((x, i) => <g key={x}>
                <ellipse className="mascot-avatar-eye" cx={x + (thinking ? 2 : 0)} cy={eyeY + (thinking && i === 0 ? 2 : 0)} rx="5.5" ry={thinking && i === 0 ? 6 : eyeHeight} />
                <ellipse fill="#fffaf4" cx={x - 1.4 + (thinking ? 2 : 0)} cy={eyeY - 2.5 + (thinking && i === 0 ? 2 : 0)} rx="1.8" ry="2.2" />
              </g>)}
            </>}
          </g>
          {(thinking || working) && <g className="mascot-avatar-ink" strokeWidth="2.5" fill="none">
            <path d={thinking ? "M 27 38 Q 32 34 38 37" : "M 28 38 L 38 41"} />
            <path d={thinking ? "M 62 36 Q 67 31 72 34" : "M 62 41 L 72 38"} />
          </g>}
          <path className={`mascot-avatar-mouth${expression === "idle" || asleep ? " is-open" : ""}`} d={MOUTHS[expression]} strokeWidth="2.5" />
          {expression === "idle" && <path d="M 47 69 Q 50 67 53 69" stroke="#eb9b9e" strokeWidth="2.5" />}
        </g>
      </svg>
      {robot.startsWith("pi") && <span className="mascot-provider-badge" data-provider-mark="pi">P</span>}
      {asleep && <span className="mascot-z">z</span>}
      {alert && <span className="mascot-task-dot" />}
    </span>
  );
}
