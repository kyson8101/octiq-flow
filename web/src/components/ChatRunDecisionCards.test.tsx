import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
vi.mock("../lib/bridge", () => ({ bridge: { invoke: async () => null, on: () => () => {}, onState: () => () => {} } }));
vi.mock("../lib/useOrchestrationSnapshot", async original => ({
  ...await original<typeof import("../lib/useOrchestrationSnapshot")>(),
  useRunDetail: (snapshot: unknown) => ({ snapshot, ready: true }),
}));
import { hostFacts } from "../lib/__fixtures__/hostFacts";
import { ChatRunDecisionCards } from "./ChatRunDecisionCards";
import { failureNote } from "../lib/runProgress";
import type { OrchestrationSnapshot } from "../lib/orchestration";
const draw = (snapshot: OrchestrationSnapshot, startOpen = false) => renderToStaticMarkup(
  <ChatRunDecisionCards snapshot={snapshot} chatKey={snapshot.runs[0].coordinatorChatKey} onOpenChat={() => {}} startOpen={startOpen} />);

describe("the coordinator's run decision cards", () => {
  it("names the failed task on its gate and draws that single decision, with the panel's answers", () => {
    const snapshot = hostFacts.failureEscalated();
    const html = draw(snapshot);
    expect(html).toContain(snapshot.tasks[0].title);
    expect(html).toContain(snapshot.gates[0].question);
    expect(html.match(/data-pending-keys=/g)).toHaveLength(1);
    expect(html).toContain(`data-pending-keys="gate:${snapshot.gates[0].id}"`);
    expect(html.match(/class="orch-gate-answer"/g)).toHaveLength(3);
    expect(html).not.toContain('class="task-start"');
    expect(html).toContain('aria-expanded="false"');
  });
  it("keeps a peer request's person gate, including an older host's unsaid ownership", () => {
    const snapshot = hostFacts.peerGate();
    delete snapshot.gates[0].awaits;
    expect(draw(snapshot)).toContain('Answered here as your own decision.');
  });
  it("carries the row's one retry, and folds the brief and worker report", () => {
    const snapshot = hostFacts.failureAwaitsPerson();
    snapshot.tasks[0].spec = "Full task detail behind the only fold.";
    expect(draw(snapshot)).toContain("aria-label=\"Start retry\"");
    expect(draw(snapshot)).not.toContain(snapshot.tasks[0].spec);
    expect(draw(snapshot, true)).toContain(snapshot.tasks[0].spec);
    expect(draw(snapshot, true)).toContain(snapshot.attempts[0].summary);
  });
  it("offers the person's reopen, with no worker start for a failed check", () => {
    const html = draw(hostFacts.failureCheckRetriesUsed());
    expect(html).toContain("aria-label=\"Continue after review\"");
    expect(html).not.toContain('class="task-start"');
  });
  it("shows the row's sentence when no start or kept workspace is available", () => {
    const snapshot = hostFacts.failureCheckRetriesUsed();
    delete snapshot.tasks[0].workspace;
    const note = failureNote(snapshot.tasks[0], null, null)?.note;
    expect(note).toBeTruthy();
    expect(draw(snapshot)).toContain(note);
    expect(draw(snapshot)).not.toContain('class="task-start"');
  });
  it.each(["stopped", "closed", "archived"])("leaves the chat when the run is %s", state => {
    const snapshot = hostFacts.failureEscalated();
    if (state === "archived") snapshot.runs[0].archivedAt = 10;
    else snapshot.runs[0].status = state as "stopped" | "closed";
    expect(draw(snapshot)).toBe("");
  });
  it("leaves only after the ledger settles its gate", () => {
    const snapshot = hostFacts.peerGate();
    expect(draw(snapshot)).toContain('data-pending-keys=');
    snapshot.gates[0].status = "resolved";
    expect(draw(snapshot)).toBe("");
  });
});
