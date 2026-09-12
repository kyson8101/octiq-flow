import { useId } from "react";
import type { CSSProperties } from "react";
import type { ComposerStyle } from "../lib/agentProviders";
import { ROBOT_DESIGNS, robotBody } from "../lib/mascotDesign";
import { MASCOT_PORTRAITS } from "../lib/mascotPortraits";
import type { MascotMood } from "../lib/mascotDesign";
import "./Mascot.css";

export type { MascotMood } from "../lib/mascotDesign";

const MOUTHS = {
  idle: "M 43 75 Q 50 78 57 75 Q 56 84 50 84 Q 44 84 43 75 Z",
  still: "M 45 78 Q 50 81 55 78",
  think: "M 48 79 Q 53 76 58 78",
  work: "M 44 78 Q 49 81 56 76",
  asleep: "M 48 79 C 48 75 53 75 53 79 C 53 83 48 83 48 79 Z",
} as const;

/** Anime familiar portraits; expressions follow the existing session state. */
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
  const portrait = MASCOT_PORTRAITS[body];
  const irisId = `mascot-iris-${useId()}`;
  const expression = asleep ? "asleep" : mood;
  const thinking = expression === "think";
  const working = expression === "work";
  const eyeHeight = working ? 8 : body === "haiku" || body === "luna" || body === "fable" ? 12 : 11;
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
        <defs>
          <linearGradient id={irisId} x1="0" y1="0" x2="0" y2="1">
            <stop className="mascot-iris-dark" offset="0" />
            <stop className="mascot-iris-color" offset=".65" />
            <stop className="mascot-iris-light" offset="1" />
          </linearGradient>
        </defs>
        <g className="mascot-avatar-character">
          <path className="mascot-fur mascot-ears" d={portrait.ears} />
          <path className="mascot-ear-inner" d={portrait.inner} />
          <path className="mascot-collar" d="M 33 81 Q 50 77 67 81 L 74 94 Q 51 101 26 94 Z" />
          <path className="mascot-collar-fold" d="M 32 84 L 48 92 L 41 97 L 28 92 Z M 68 84 L 52 92 L 59 97 L 72 92 Z" />
          <path className="mascot-collar-gem" d="M 50 87 L 54 92 L 50 97 L 46 92 Z" />
          <path className="mascot-avatar-base" d="M 16 49 C 14 28 29 20 50 20 C 71 20 86 28 84 49 L 89 63 L 82 65 L 85 73 L 77 73 C 72 85 61 91 50 91 C 39 91 28 85 23 73 L 15 73 L 18 65 L 11 63 Z" />
          <path className="mascot-face-shadow" d="M 14 61 L 20 64 L 18 70 L 26 70 Q 34 84 50 85 Q 68 85 78 71 L 83 72 L 77 73 C 72 85 61 91 50 91 C 39 91 28 85 23 73 L 15 73 L 18 65 L 11 63 Z" />
          <path className="mascot-brow-shadow" d="M 19 47 Q 25 34 50 34 Q 75 34 82 48 L 73 47 Q 62 49 55 42 Q 43 52 32 47 L 25 51 Z" />
          <path className="mascot-fur mascot-fringe" d={portrait.fringe} />
          <path className="mascot-hair-shine" d={portrait.shine} />
          <g className={`mascot-avatar-mark${body === "claude" || body === "codex" ? " mascot-mark-lines" : ""}`}>
            <path d={portrait.mark} />
          </g>
          <g className="mascot-avatar-face" strokeLinecap="round" strokeLinejoin="round">
            <g className="mascot-avatar-cheeks">
              <ellipse cx="23" cy="71" rx="7" ry="3.5" />
              <ellipse cx="77" cy="71" rx="7" ry="3.5" />
              <path className="mascot-blush-lines" d="M 20 70 L 19 72 M 24 70 L 23 72 M 76 70 L 75 72 M 80 70 L 79 72" />
            </g>
            <g className="mascot-avatar-eyes">
              {asleep ? <g className="mascot-sleep-eyes">
                <path d="M 25 59 Q 33 67 41 59 M 59 59 Q 67 67 75 59" />
                <path className="mascot-lower-lash" d="M 26 61 L 24 63 M 74 61 L 76 63" />
              </g> : [33, 67].map((x, i) => {
                const eyeY = thinking ? 57 + i * 2 : 59;
                const pupilX = x + (thinking ? 2 : 0);
                return <g key={x}>
                  <ellipse className="mascot-eye-white" cx={x} cy={eyeY} rx="10" ry={eyeHeight + 1} />
                  <ellipse className="mascot-avatar-eye" cx={pupilX} cy={eyeY + 1} rx="7.7" ry={eyeHeight} fill={`url(#${irisId})`} />
                  <ellipse className="mascot-pupil" cx={pupilX} cy={eyeY} rx="3.4" ry={eyeHeight * .66} />
                  <path className="mascot-iris-glow" d={`M ${pupilX - 4.5} ${eyeY + eyeHeight - 3} Q ${pupilX} ${eyeY + eyeHeight} ${pupilX + 4.5} ${eyeY + eyeHeight - 3}`} />
                  <ellipse className="mascot-eye-glint" cx={pupilX - 2.7} cy={eyeY - eyeHeight * .43} rx="3" ry="3.4" />
                  <circle className="mascot-eye-glint mascot-eye-glint-small" cx={pupilX + 3.5} cy={eyeY + 4} r="1.4" />
                  <path className="mascot-upper-lash" d={`M ${x - 10} ${eyeY - 3} Q ${x - 8} ${eyeY - eyeHeight - 3} ${x + 1} ${eyeY - eyeHeight - 1} Q ${x + 7} ${eyeY - eyeHeight} ${x + 10} ${eyeY - 4}`} />
                  <path className="mascot-lower-lash" d={`M ${x - 6} ${eyeY + eyeHeight} Q ${x} ${eyeY + eyeHeight + 2} ${x + 5} ${eyeY + eyeHeight}`} />
                </g>;
              })}
            </g>
            {(thinking || working) && <g className="mascot-eyebrows">
              <path d={thinking ? "M 26 43 Q 32 39 39 42" : "M 26 45 L 39 48"} />
              <path d={thinking ? "M 61 45 Q 67 42 74 44" : "M 61 48 L 74 45"} />
            </g>}
            <path className="mascot-nose" d="M 48.5 71 Q 50 70 51.5 71 L 50 72 Z" />
            <path className="mascot-avatar-mouth" d={MOUTHS[expression]} />
            {expression === "idle" && <path className="mascot-tongue" d="M 47 81 Q 50 78 53 81 Q 50 84 47 81 Z" />}
          </g>
        </g>
      </svg>
      {robot.startsWith("pi") && <span className="mascot-provider-badge" data-provider-mark="pi">P</span>}
      {asleep && <span className="mascot-z">z</span>}
      {alert && <span className="mascot-task-dot" />}
    </span>
  );
}
