import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { TaskLifecycleEvidence } from "./TaskLifecycleEvidence";
import { EMPTY_ORCHESTRATION, type RuntimeService } from "../lib/orchestration";

const service: RuntimeService = { id: "service", runId: "run", taskId: "task", attemptId: "attempt", name: "Frontend", host: "127.0.0.1", port: 3001, state: "stopped", checkedAt: 1000, recovery: "Restore retained frontend workspace." };

describe("TaskLifecycleEvidence", () => {
  it("shows stopped services and recovery separately from task completion", () => {
    const html = renderToStaticMarkup(<TaskLifecycleEvidence now={2000} taskId="task" snapshot={{ ...EMPTY_ORCHESTRATION, services: [service, { ...service, id: "other", taskId: "other", name: "Hidden" }] }} />);
    expect(html).toContain("Frontend: Service stopped");
    expect(html).toContain(service.recovery);
    expect(html).not.toContain("Hidden");
  });
  it("limits listener evidence to reachability and never claims application health", () => {
    const html = renderToStaticMarkup(<TaskLifecycleEvidence now={2000} taskId="task" snapshot={{ ...EMPTY_ORCHESTRATION, services: [{ ...service, state: "listening" }] }} />);
    expect(html).toContain("Listener reachable");
    expect(html).toContain("Verify application health before use");
  });
  it("shows the exact decision reference and unavailable continuation", () => {
    const html = renderToStaticMarkup(<TaskLifecycleEvidence now={2000} taskId="task" snapshot={{ ...EMPTY_ORCHESTRATION, nativeDecisions: [{ id: "decision-42", runId: "run", taskId: "task", attemptId: "attempt-9", chatKey: "chat:worker", reason: "Upload requires a decision", blockedAction: null, status: "expired", continuation: "unavailable", recovery: "The old card cannot resume this attempt.", observedAt: 1000 }] }} />);
    expect(html).toContain("decision-42");
    expect(html).toContain("attempt-9");
    expect(html).toContain("Safety decision: expired");
    expect(html).toContain("cannot resume this attempt");
  });
  it("draws an outage group as one row listing every refused call, and safety refusals one each", () => {
    const base = { runId: "run", taskId: "task", attemptId: "attempt-9", chatKey: "chat:worker", status: "pending", continuation: "unavailable" };
    const outage = (id: string, action: string, observedAt: number) => ({
      ...base, id, kind: "outage" as const, groupId: "group-7", reason: "Claude's safety check was unavailable: Classifier unavailable",
      blockedAction: action, recovery: "Continue with your other steps.", observedAt,
    });
    const html = renderToStaticMarkup(<TaskLifecycleEvidence now={2000} taskId="task" snapshot={{ ...EMPTY_ORCHESTRATION, nativeDecisions: [
      outage("o2", "git fetch", 20), outage("o1", "git fetch", 10), outage("o3", "ls docs", 30),
      { ...base, id: "s1", reason: "Production Deploy", blockedAction: "eas update", recovery: "Claude's auto mode refused this call.", observedAt: 40 },
      { ...base, id: "s2", reason: "Production Deploy", blockedAction: "eas update", recovery: "Claude's auto mode refused this call.", observedAt: 50 },
    ] }} />);
    expect(html.match(/Safety check unavailable/g)?.length).toBe(1);
    expect(html).toContain("3 refused calls");
    expect(html).toContain("<code>git fetch</code> ×2");
    expect(html).toContain("<code>ls docs</code>");
    expect(html).toContain("group-7");
    expect(html.match(/Safety decision: pending/g)?.length).toBe(2);
  });
});
