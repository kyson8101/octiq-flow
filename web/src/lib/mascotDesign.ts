import type { ComposerStyle } from "./agentProviders";

export type MascotMood = "idle" | "still" | "think" | "work";
/** Pi and Antigravity wear another body and a provider badge rather than a
 *  design of their own (see `robotBody`). */
export type RobotBody = Exclude<ComposerStyle, `pi${string}` | "antigravity">;

/** Accent colours for the SVG portraits. */
export const ROBOT_DESIGNS = {
  opus:   { color: "#b99cff" },
  sonnet: { color: "#e07a59" },
  haiku:  { color: "#59c9c5" },
  fable:  { color: "#e48db7" },
  claude: { color: "#d97757" },
  astra:  { color: "#d76bf0" },
  sol:    { color: "#f1b84b" },
  terra:  { color: "#78c892" },
  luna:   { color: "#84a9ff" },
  codex:  { color: "#8eb3c3" },
} satisfies Record<RobotBody, { color: string }>;

export function robotBody(robot: ComposerStyle): RobotBody {
  if (robot === "pi") return "codex";
  // A placeholder until Antigravity has its own design: the blue body,
  // badged "A".
  if (robot === "antigravity") return "luna";
  return (robot.startsWith("pi-") ? robot.slice(3) : robot) as RobotBody;
}
