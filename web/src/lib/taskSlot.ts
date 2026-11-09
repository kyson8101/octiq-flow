import type { OrchestrationTask } from "./orchestration";
import type { TaskHold } from "./taskHold";

/** Holds lead; a scheduling wait is neutral and asks nobody for a decision. */
export function taskSlot(task: Pick<OrchestrationTask, "slotWait" | "assignee">, hold: TaskHold | null = null): string | null {
  if (hold) return hold.label;
  const wait = task.slotWait;
  if (!wait) return null;
  if (wait.reason === "agent") return `Queued · ${task.assignee?.name ?? "Agent"} is busy · ${wait.ahead} ahead`;
  return `Queued · machine limit (${wait.running ?? "—"} of ${wait.limit ?? "—"} running)`;
}

/** Both a successful queued reply and the host's queued refusal mean wait. */
export function queuedStart(reply: unknown): string | null {
  const words = reply instanceof Error ? reply.message : typeof reply === "string" ? reply : null;
  if (words?.startsWith("QUEUED_FOR_SLOT")) return `Queued${words.slice("QUEUED_FOR_SLOT".length).replace(/^[:\s·-]+/, " · ")}`;
  if (reply && typeof reply === "object" && "queued" in reply && reply.queued === true) return "Queued · waiting for a worker slot";
  return null;
}
