// The front desk on the new-chat screen (the host's `handover/route.rs`).
//
// With a front desk designated in Settings, every new conversation opens on
// it: the person says what they want, it proposes the right agent on a card,
// and their confirm opens that agent's chat. Picking an agent directly is
// still there, one tap further ("Talk to someone else"). With none, the
// screen is the plain picker it always was. Pure, so every rule is a test.
import type { ExecutionPlan } from "./agentExecution";
import type { TeamAgent } from "./agentsMode";

/** The line under "Talk to <front desk>", said to the person. Its role is
 *  written about the person, so it stays under Details. */
export const FRONT_DESK_GREETING = "Tell me what you need and I'll open the right agent's chat.";

/** The designated front desk as the roster has it now (a rename or a model
 *  change shows at once), or null when none is designated or it is gone. */
export function currentFrontDesk(
  desk: TeamAgent | null | undefined,
  roster: readonly TeamAgent[],
): TeamAgent | null {
  if (!desk) return null;
  return roster.find((agent) => agent.id === desk.id && !agent.projectId) ?? null;
}

/** Who a new conversation is with. The agent the person picked, while the
 *  project on screen is one it works in; else the front desk; else the
 *  usual default (`fallback`: the head, or the first that fits). */
export function newChatLead(input: {
  recipients: readonly TeamAgent[];
  pickedId: string | null | undefined;
  desk: TeamAgent | null;
  projectId: string | null | undefined;
  fallback: () => TeamAgent | null;
}): TeamAgent | null {
  const { recipients, pickedId, desk, projectId } = input;
  if (pickedId) {
    if (desk && pickedId === desk.id) return desk;
    const picked = recipients.find((agent) => agent.id === pickedId);
    if (picked && (!picked.projectId || picked.projectId === projectId)) return picked;
  }
  return desk ?? input.fallback();
}

/** The list behind "Talk to someone else": everyone the person can start a
 *  conversation with, the front desk left out (it is the default above). */
export function directRecipients(recipients: readonly TeamAgent[], desk: TeamAgent | null): TeamAgent[] {
  return desk ? recipients.filter((agent) => agent.id !== desk.id) : [...recipients];
}

/** The project every listed agent shares, when they all share one: the list
 *  then says it once instead of on every row. `null` when any is global or
 *  they differ. */
export function sharedProject(agents: readonly Pick<TeamAgent, "projectId">[]): string | null {
  if (agents.length < 2) return null;
  const first = agents[0].projectId;
  return first && agents.every((agent) => agent.projectId === first) ? first : null;
}

/** What the front desk is sent: the person's words, then every file they
 *  attached by path, pictures included, under the heading its brief tells it
 *  to pass on (`team::front_desk_brief`). It sees the pictures too; the paths
 *  are how it hands them to the agent it routes to. */
export function frontDeskText(
  text: string,
  attachments: readonly { path: string; isImage?: boolean }[],
): string {
  if (!attachments.length) return text;
  const lines = attachments.map((file) => `- ${file.path}${file.isImage ? " (image)" : ""}`);
  return `${text}\n\nAttachments:\n${lines.join("\n")}`.trim();
}

/** Where a front-desk conversation runs: home, with nothing prepared. It
 *  only routes, so it never gets a checkout, a worktree or a sandbox. */
export function frontDeskExecution(homeId: string | null | undefined): ExecutionPlan {
  return {
    target: "home",
    projectId: homeId ?? null,
    prepare: false,
    branch: "",
    newWorktree: false,
    useSandbox: false,
    chosenBy: "auto",
    reason: "The front desk only routes: it works from your home workspace and opens the right agent's chat.",
    crossProject: false,
  };
}
