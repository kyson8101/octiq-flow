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
});
