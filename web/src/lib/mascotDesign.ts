import type { ComposerStyle } from "./agentProviders";

export type MascotMood = "idle" | "still" | "think" | "work";
export type RobotBody = Exclude<ComposerStyle, `pi${string}`>;
export type MascotState = { mood: MascotMood; asleep: boolean; alert: boolean };

/** Shared by the lightweight placeholder and the lazily loaded Three.js rig. */
export const ROBOT_DESIGNS = {
  opus:   { color: "#b99cff", width: 1.42, roundness: .42, bodyWidth: .96, beat: 1.3 },
  sonnet: { color: "#e07a59", width: 1.46, roundness: .28, bodyWidth: .94, beat: 1.05 },
  haiku:  { color: "#59c9c5", width: 1.32, roundness: .24, bodyWidth: .76, beat: .8 },
  fable:  { color: "#e48db7", width: 1.38, roundness: .16, bodyWidth: .9, beat: 1.2 },
  claude: { color: "#d97757", width: 1.48, roundness: .38, bodyWidth: 1.02, beat: 1.15 },
  astra:  { color: "#d76bf0", width: 1.4, roundness: .12, bodyWidth: .88, beat: .95 },
  sol:    { color: "#f1b84b", width: 1.38, roundness: .45, bodyWidth: .98, beat: .9 },
  terra:  { color: "#78c892", width: 1.56, roundness: .12, bodyWidth: 1.12, beat: 1.25 },
  luna:   { color: "#84a9ff", width: 1.4, roundness: .4, bodyWidth: .8, beat: 1.4 },
  codex:  { color: "#8eb3c3", width: 1.44, roundness: .16, bodyWidth: .94, beat: 1.1 },
} satisfies Record<RobotBody, { color: string; width: number; roundness: number; bodyWidth: number; beat: number }>;

export function robotBody(robot: ComposerStyle): RobotBody {
  if (robot === "pi") return "codex";
  return (robot.startsWith("pi-") ? robot.slice(3) : robot) as RobotBody;
}
