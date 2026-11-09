// One sender for a run decision, whichever surface the person uses.
import { bridge } from "./bridge";
import { gateFlight, taskFlight, IN_FLIGHT, once } from "./inFlight";
import { queuedStart } from "./taskSlot";
import type { GateDoor, OrchestrationAttempt, OrchestrationGate, OrchestrationRun, OrchestrationTask } from "./orchestration";

export async function resolveRunGate(run: OrchestrationRun, gate: OrchestrationGate, resolution: string, door: GateDoor,
  onOpenChat: (key: string, message: string) => void) {
  if (door === "none" || !resolution.trim()) return;
  const sent = await once(gateFlight(gate.id), async () => {
    if (door === "person") {
      await bridge.invoke("orchestration_gate_resolve", {
        actorChatKey: run.coordinatorChatKey, gateId: gate.id, resolution: resolution.trim(), resumeTarget: true,
      });
    } else {
      onOpenChat(run.coordinatorChatKey,
        `For orchestration gate ${gate.id}:\n\n${gate.question}\n\nMy answer: ${resolution.trim()}\n\nReview this answer and coordinate the next step through orchestration_gate_resolve.`);
    }
  });
  return sent;
}

export async function startRunTask(run: OrchestrationRun, task: OrchestrationTask, attempt: OrchestrationAttempt): Promise<string | null | undefined> {
  const sent = await once(taskFlight(task.id), async () => {
    try {
      return queuedStart(await bridge.invoke("orchestration_worker_start", {
        actorChatKey: run.coordinatorChatKey, ...retryLaunchArgs(task, attempt),
      }));
    } catch (problem) {
      const wait = queuedStart(problem);
      if (wait) return wait;
      throw problem;
    }
  });
  return sent === IN_FLIGHT ? undefined : sent;
}

export async function runWorkspaceAction(run: OrchestrationRun, command: string, args: Record<string, unknown>) {
  const send = () => bridge.invoke(command, { actorChatKey: run.coordinatorChatKey, ...args });
  return command === "orchestration_task_reopen" ? once(taskFlight(String(args.taskId)), send) : send();
}

export function retryLaunchArgs(task: OrchestrationTask, attempt: OrchestrationAttempt) {
  // A task that changed hands after this attempt is the new owner's: retrying
  // it on the old owner's provider and model would start the assignment the
  // handoff replaced.
  const handedOn = (task.handoffs ?? []).some((handoff) => handoff.at >= attempt.createdAt);
  const settings = handedOn && task.worker ? task.worker : attempt;
  return {
    taskId: task.id,
    agent: settings.agent,
    model: settings.model,
    effort: settings.effort,
    access: settings.access,
    // A prepared retry keeps the exact assigned checkout and its uncommitted
    // work. A preparation failure has no checkout to reuse, so isolate it anew.
    newWorktree: !attempt.cwd.trim(),
    // Which attempt this page showed. The host refuses it once the task has
    // been handed on and the new owner has started, so a page the handoff
    // overtook cannot launch the replaced settings under the new owner.
    retryOf: attempt.id,
  };
}
