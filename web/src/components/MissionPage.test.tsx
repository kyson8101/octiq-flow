import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("../lib/bridge", () => ({
  bridge: {
    invoke: async () => null,
    on: () => () => {},
    onState: () => () => {},
  },
}));

import { AgentRosterContext, ChatPersonaContext } from "../lib/agentRoster";
import type { OrchestrationSnapshot, OrchestrationTask } from "../lib/orchestration";
import { OrchestrationPanel, retryLaunchArgs } from "./OrchestrationPanel";
import { submitReassign } from "./MissionPage";

const roster = [{ id: "cto", name: "Ada" }, { id: "maya", name: "Maya" }, { id: "noah", name: "Noah" }];

function task(id: string, extra: Partial<OrchestrationTask>): OrchestrationTask {
  return { id, runId: "run_m", title: id, spec: "", dependsOn: [], status: "pending", createdAt: 1, updatedAt: 1, ...extra };
}

const mission: OrchestrationSnapshot = {
  runs: [{
    id: "run_m", objective: "Ship the Mission page", coordinatorChatKey: "chat:lead", workspaceId: "proj",
    rootPath: "/repo", status: "running", maxConcurrent: 4, workspaceMode: "mission", createdAt: 1, updatedAt: 2,
  }],
  tasks: [
    task("Build the page", { assignee: { id: "maya", name: "Maya" }, status: "running", size: "large", activeAttemptId: "a1",
      card: { problem: "p", goal: "g", acceptance: ["Crew shows roles"] } }),
    task("Wire the server", { assignee: { id: "maya", name: "Maya" }, status: "ready", size: "medium",
      handoffs: [{ from: { id: "noah", name: "Noah" }, to: { id: "maya", name: "Maya" }, reason: "Noah is reviewing", at: 1 }] }),
    task("Review it", { assignee: { id: "noah", name: "Noah" }, kind: "review", size: "small" }),
  ],
  attempts: [{
    id: "a1", runId: "run_m", taskId: "Build the page", number: 1, workerChatKey: "chat:w1", agent: "claude", access: "auto",
    status: "running", cwd: "/repo", branch: "feature/mission-run_m", isWorktree: true, filesModified: [], createdAt: 5, updatedAt: 5,
  }],
  gates: [],
  messages: [],
};

function render(snapshot: OrchestrationSnapshot) {
  return renderToStaticMarkup(
    <AgentRosterContext.Provider value={roster}>
      <ChatPersonaContext.Provider value={(key) => key === "chat:lead" ? { id: "cto", name: "Ada" } : null}>
        <OrchestrationPanel project={null} coordinatorKey="chat:lead" onOpenChat={() => {}} onClose={() => {}} initialSnapshot={snapshot} />
      </ChatPersonaContext.Provider>
    </AgentRosterContext.Provider>,
  );
}

describe("mission page", () => {
  it("brings the board, goal, crew, where and tasks together for a mission", () => {
    const html = render(mission);
    expect(html).toContain('class="mission-track"');
    for (const section of [">Goal<", ">Crew<", ">Where<"]) expect(html).toContain(section);
    // Crew open, goal and where closed.
    expect(html.match(/<details class="mission-section"( open="")?>/g)).toEqual([
      '<details class="mission-section">', '<details class="mission-section" open="">', '<details class="mission-section">',
    ]);
    expect(html).toContain("Crew shows roles");
    // Lead first, then each owner with the role they hold here.
    const crew = html.slice(html.indexOf('aria-label="Crew"'));
    expect(crew.indexOf("Ada")).toBeLessThan(crew.indexOf("Maya"));
    expect(crew).toMatch(/Ada<\/span><span class="mission-crew-roles"><span class="mission-role" data-role="lead">Lead/);
    expect(crew).toMatch(/Maya<\/span><span class="mission-crew-roles"><span class="mission-role" data-role="developer">Developer/);
    expect(crew).toMatch(/Noah<\/span><span class="mission-crew-roles"><span class="mission-role" data-role="reviewer">Reviewer/);
    // Each task row names its owner, kind and size, and offers reassignment.
    expect(html).toContain('class="orch-task-owner"');
    expect(html).toContain(">Large<");
    expect(html).toContain(">Review<");
    expect(html.match(/class="orch-task-reassign"/g)).toHaveLength(3);
    // The running task cannot change hands; the button says why.
    expect(html).toMatch(/aria-label="Reassign task: Build the page" title="Maya is still working on it\. Stop that attempt first\."/);
    // Its change of hands is kept on the row.
    expect(html).toContain("Noah → Maya");
  });

  it("leaves a run that is not a mission exactly as it was", () => {
    const plain = structuredClone(mission);
    plain.runs[0].workspaceMode = "auto";
    const html = render(plain);
    for (const absent of ["mission-track", "mission-page", "orch-task-reassign", "orch-task-owner", "orch-task-size", "orch-task-handoffs"]) {
      expect(html).not.toContain(absent);
    }
  });

  it("hides reassignment where nobody can act on it", () => {
    const html = renderToStaticMarkup(
      <AgentRosterContext.Provider value={roster}>
        <OrchestrationPanel project={null} coordinatorKey="chat:lead" readOnly onOpenChat={() => {}} onClose={() => {}} initialSnapshot={mission} />
      </AgentRosterContext.Provider>,
    );
    expect(html).toContain("mission-page");
    expect(html).not.toContain("orch-task-reassign");
  });
});

describe("a mission whose plan waits for approval", () => {
  // After a change of hands the host sends the plan back for approval. One
  // task failed before it, so a retry would otherwise be offered.
  function pending(status: "pending" | "approved"): OrchestrationSnapshot {
    const next = structuredClone(mission);
    next.runs[0].planApproval = { status, requestedAt: 30, revision: 2 };
    next.tasks[0] = { ...next.tasks[0], status: "failed" };
    next.attempts[0] = { ...next.attempts[0], status: "failed", createdAt: 5 };
    next.tasks[2] = { ...next.tasks[2], handoffs: [{ from: { id: "maya", name: "Maya" }, to: { id: "noah", name: "Noah" }, reason: "x", at: 20 }] };
    return next;
  }
  const rows = (html: string) => html.match(/<article class="orch-task /g)?.length ?? 0;

  it("keeps every row, its owner, kind and size, and its reassign control", () => {
    const html = render(pending("pending"));
    expect(html).toContain("The tasks start once the plan above is approved.");
    expect(rows(html)).toBe(3);
    expect(html.match(/class="orch-task-reassign"/g)).toHaveLength(3);
    expect(html.match(/class="orch-task-owner"/g)).toHaveLength(3);
    expect(html).toContain(">Large<");
    expect(html).toContain(">Review<");
    // The host's rules still decide: an unstarted task can be handed on again.
    expect(html).toMatch(/aria-label="Reassign task: Review it" title="Hand &quot;Review it&quot; to another crew member"/);
  });

  it("holds every start until the plan is approved", () => {
    const html = render(pending("pending"));
    expect(html).not.toContain("Start retry");
    expect(html).not.toContain("Start next attempt");
    // Progress stages and filters belong to a running plan.
    expect(html).not.toContain("orch-task-filters");
  });

  it("is unchanged once approved", () => {
    const html = render(pending("approved"));
    expect(html).not.toContain("The tasks start once the plan above is approved.");
    expect(rows(html)).toBe(3);
    expect(html).toContain("Start retry");
  });

  it("leaves a run that is not a mission showing only the notice", () => {
    const plain = pending("pending");
    plain.runs[0].workspaceMode = "auto";
    const html = render(plain);
    expect(html).toContain("The tasks start once the plan above is approved.");
    expect(rows(html)).toBe(0);
  });
});

describe("reassigning from the page", () => {
  const run = mission.runs[0];

  it("goes through the lead's own reassignment and re-reads the ledger", async () => {
    const invoke = vi.fn(async () => ({}));
    const refresh = vi.fn(async () => {});
    await submitReassign(invoke, run, { id: "Review it" }, "zed", "Noah is out", refresh);
    expect(invoke).toHaveBeenCalledWith("orchestration_task_reassign", {
      actorChatKey: "chat:lead", taskId: "Review it", assignee: "zed",
      reason: "Noah is out (reassigned by the person from the Mission page)",
    });
    expect(refresh).toHaveBeenCalled();
  });

  it("asks for who and why before calling, and passes the host's refusal on", async () => {
    const invoke = vi.fn(async () => { throw new Error("Zed does not report to you."); });
    await expect(submitReassign(invoke, run, { id: "t" }, "", "why", async () => {})).rejects.toThrow(/Choose who/);
    await expect(submitReassign(invoke, run, { id: "t" }, "zed", "  ", async () => {})).rejects.toThrow(/why/);
    expect(invoke).not.toHaveBeenCalled();
    await expect(submitReassign(invoke, run, { id: "t" }, "zed", "why", async () => {})).rejects.toThrow(/does not report/);
  });

  it("never restarts the replaced assignment: a retry after a handoff runs as the new owner", () => {
    const attempt = { ...mission.attempts[0], status: "failed" as const, createdAt: 10, model: "opus", agent: "claude" as const };
    const handed = task("t", {
      worker: { agent: "codex", access: "auto", model: "gpt-5.5" },
      handoffs: [{ from: { id: "maya", name: "Maya" }, to: { id: "noah", name: "Noah" }, reason: "x", at: 20 }],
    });
    expect(retryLaunchArgs(handed, attempt)).toMatchObject({ agent: "codex", model: "gpt-5.5" });
    // It names the attempt it showed, so the host can refuse it once the new
    // owner has started and this page's snapshot is out of date.
    expect(retryLaunchArgs(handed, attempt).retryOf).toBe(attempt.id);
    // A handoff before this attempt changes nothing: it is this owner's retry.
    const earlier = { ...handed, handoffs: [{ ...handed.handoffs![0], at: 5 }] };
    expect(retryLaunchArgs(earlier, attempt)).toMatchObject({ agent: "claude", model: "opus" });
  });
});
