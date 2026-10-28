import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
const { invoke, refresh } = vi.hoisted(() => ({ invoke: vi.fn(), refresh: vi.fn(async () => {}) }));
vi.mock("./bridge", () => ({ bridge: { invoke, on: () => () => {} } }));
vi.mock("./orchestrationFeed", () => ({ orchestrationFeed: { refresh } }));
import { approveWithAutoPlan, autoPlanHeld, AUTO_PLAN_REFRESH_MS, setAutoPlan } from "./autoPlan";
import { IN_FLIGHT, inFlight } from "./inFlight";
import { AutoPlanSwitch } from "../components/AutoPlanSwitch";
import { PlanReview } from "../components/PlanReview";
import { chatPlans, approvalLabel } from "./chatPlans";
import { hostFacts } from "./__fixtures__/hostFacts";

describe("standing plan consent", () => {
  it("reads standing consent from the recorded host ledger", () => {
    const ledger = hostFacts.autoPlanApproved();
    const [plan] = chatPlans(ledger, ledger.runs[0].coordinatorChatKey);
    expect(plan.run.planApproval?.consent).toMatchObject({ via: "standing", enabledAt: expect.any(Number) });
    expect(approvalLabel(plan)).toBe("Plan auto-approved · revision 3");
    expect(plan.run.autoPlan).toEqual({ enabled: true, includeFull: false });
  });
  it("names the held Full tasks and offers the separate opt-in on the chat card", () => {
    const ledger = hostFacts.autoPlanHeldAccess();
    // Changed only the task's display identity from the recorded host fixture.
    ledger.tasks[0].assignee = { id: "video", name: "STAR VIDEO" };
    const run = ledger.runs[0];
    const held = "Waits for you: 1 task runs at Full access (STAR VIDEO: Implement). Auto-approve covers Auto or lower unless you turn on Full access tasks.";
    expect(autoPlanHeld(run, ledger.tasks)).toBe(held);
    const draw = (surface: "chat" | "panel") => renderToStaticMarkup(<PlanReview run={run} tasks={ledger.tasks} surface={surface} drafting={false} onRequestChanges={() => {}} />);
    expect(draw("chat")).toContain(held);
    expect(draw("chat")).toContain("Also auto-approve Full access tasks in this chat");
    expect(draw("chat")).not.toContain("Auto-approve this chat&#x27;s future plans");
    expect(draw("panel")).not.toContain("Also auto-approve");
  });
  it("reads Full scope and peer manual approval from the two new host recordings", () => {
    const included = hostFacts.autoPlanFullIncluded();
    const run = included.runs[0];
    expect(run.autoPlan).toEqual({ enabled: true, includeFull: true });
    expect(run.planApproval?.consent).toMatchObject({ via: "standing", includeFull: true });
    expect(autoPlanHeld(run, included.tasks)).toBeNull();
    const peer = hostFacts.autoPlanFullPeerRequest();
    expect(peer.runs[0].autoPlan?.includeFull).toBe(true);
    const html = renderToStaticMarkup(<PlanReview run={peer.runs[0]} tasks={peer.tasks} surface="chat" drafting={false} onRequestChanges={() => {}} />);
    expect(html).toContain("Waits for you: 1 peer request (Unassigned: Implement). Peer requests are always approved by you.");
    expect(html).not.toContain("Also auto-approve");
    expect(html).not.toContain('type="checkbox"');
  });
  it.each(["access", "peerRequest"] as const)("folds a long %s held list whole through the plan's one disclosure", (reason) => {
    const ledger = hostFacts.autoPlanHeldAccess();
    ledger.runs[0].autoPlan!.held!.reason = reason;
    // Changed for this test: two held tasks with long, distinct titles.
    const first = ledger.tasks[0];
    first.title = "First complete title " + "detail ".repeat(40);
    first.assignee = { id: "video", name: "STAR VIDEO" };
    ledger.tasks.push({ ...first, id: "second", title: "Second complete title", assignee: { id: "qa", name: "STAR QA" } });
    ledger.runs[0].autoPlan!.held!.taskIds.push("second");
    const draw = (startOpen: boolean) => renderToStaticMarkup(<PlanReview run={ledger.runs[0]} tasks={ledger.tasks} surface="chat" folds startOpen={startOpen} drafting={false} onRequestChanges={() => {}} />);
    const shut = draw(false);
    expect(shut).toContain(reason === "access" ? "Waits for you: 2 tasks run at Full access." : "Waits for you: 2 peer requests. Peer requests are always approved by you.");
    expect(shut).toMatch(/Held tasks · [\d,]+ characters/);
    expect(shut).not.toContain("First complete title");
    expect(shut).not.toContain("Second complete title");
    expect(shut.match(/class="card-fold-toggle"/g)).toHaveLength(1);
    const open = draw(true);
    expect(open).toContain(`STAR VIDEO: ${first.title}; STAR QA: Second complete title`);
  });
  it("offers future consent only on a pending chat card whose setting is off", () => {
    const ledger = hostFacts.autoPlanHeldAccess();
    // Changed for this component test: the setting is off.
    delete ledger.runs[0].autoPlan;
    const draw = (surface: "chat" | "panel") => renderToStaticMarkup(<PlanReview run={ledger.runs[0]} tasks={ledger.tasks} surface={surface} drafting={false} onRequestChanges={() => {}} />);
    expect(draw("chat")).toContain('type="checkbox"');
    expect(draw("chat")).toContain("Auto-approve this chat&#x27;s future plans");
    expect(draw("panel")).not.toContain("Auto-approve this chat");
  });
  it("draws the setting off while the host answers, and shows its refusal", () => {
    const html = renderToStaticMarkup(<AutoPlanSwitch enabled includeFull={false} busy ready onFullChange={() => {}} error="Only a chat's own agent can lead" onChange={() => {}} />);
    expect(html).toContain('role="switch" aria-checked="true" aria-disabled="true"');
    expect(html).not.toMatch(/\sdisabled="/);
    expect(html).toContain('role="alert"');
    expect(html).toContain("Full access workers run with no permission checks; plans with them are approved without you.");
    expect(html).toContain("A peer request always waits for you.");
    expect(html).toContain('role="switch" aria-checked="false" aria-disabled="true"');
    const off = renderToStaticMarkup(<AutoPlanSwitch enabled={false} includeFull={false} busy={false} ready onChange={() => {}} onFullChange={() => {}} />);
    expect(off).not.toContain("Include Full access tasks");
  });
  it("sends one setting change across duplicate presses and waits for the host", async () => {
    let answer!: (value: unknown) => void;
    invoke.mockImplementationOnce(() => new Promise((resolve) => { answer = resolve; }));
    const first = setAutoPlan("chat:one", true);
    expect(inFlight("auto-plan:chat:one")).toBe(true);
    expect(await setAutoPlan("chat:one", false)).toBe(IN_FLIGHT);
    answer({ chatKey: "chat:one", enabled: true, includeFull: false });
    await first;
    expect(inFlight("auto-plan:chat:one")).toBe(false);
  });
  it.each([true, false])("keeps Full=%s controls busy until the host ledger has been refreshed", async (includeFull) => {
    let read!: () => void;
    refresh.mockImplementationOnce(() => new Promise<void>((resolve) => { read = resolve; }));
    invoke.mockResolvedValueOnce({ chatKey: "chat:sync", enabled: true, includeFull });
    const saved = setAutoPlan("chat:sync", true, "details", includeFull);
    await vi.waitFor(() => expect(read).toBeTypeOf("function"));
    expect(inFlight("auto-plan:chat:sync")).toBe(true);
    expect(await setAutoPlan("chat:sync", true, "card", !includeFull)).toBe(IN_FLIGHT);
    read();
    await saved;
    expect(inFlight("auto-plan:chat:sync")).toBe(false);
  });
  it("does not call a saved setting a failed save when the ledger refresh fails", async () => {
    invoke.mockResolvedValueOnce({ chatKey: "chat:read-failed", enabled: true, includeFull: true });
    refresh.mockRejectedValueOnce(new Error("Ledger unavailable"));
    await expect(setAutoPlan("chat:read-failed", true, "card", true)).resolves.toBeUndefined();
    expect(inFlight("auto-plan:chat:read-failed")).toBe(false);
  });
  it("releases controls when the host saved the setting but the snapshot never answers", async () => {
    vi.useFakeTimers();
    try {
      invoke.mockResolvedValueOnce({ chatKey: "chat:silent", enabled: true, includeFull: true });
      refresh.mockImplementationOnce(() => new Promise(() => {}));
      const saved = setAutoPlan("chat:silent", true, "details", true);
      await vi.advanceTimersByTimeAsync(AUTO_PLAN_REFRESH_MS - 1);
      expect(inFlight("auto-plan:chat:silent")).toBe(true);
      await vi.advanceTimersByTimeAsync(1);
      await saved;
      expect(inFlight("auto-plan:chat:silent")).toBe(false);
      expect(vi.getTimerCount()).toBe(0);
    } finally { vi.useRealTimers(); }
  });
  it("approves before enabling, and keeps approval when enabling fails", async () => {
    const calls: string[] = [];
    const approve = vi.fn(async () => { calls.push("approve"); return true; });
    invoke.mockImplementationOnce(async (command) => { calls.push(command); throw new Error("Could not save setting"); });
    await expect(approveWithAutoPlan(approve, "chat:save-failed", true, true)).rejects.toThrow("Could not save setting");
    expect(calls).toEqual(["approve", "orchestration_auto_plan_set"]);
    expect(approve).toHaveBeenCalledTimes(1);
    expect(invoke).toHaveBeenLastCalledWith("orchestration_auto_plan_set", { chatKey: "chat:save-failed", enabled: true, includeFull: true });
  });
  it("keeps omitted scope distinct from explicit on and off", async () => {
    invoke.mockImplementation(async (_command, args) => args);
    for (const includeFull of [undefined, true, false]) {
      await setAutoPlan("chat:scope", true, "details", includeFull);
      expect(invoke).toHaveBeenLastCalledWith("orchestration_auto_plan_set", {
        chatKey: "chat:scope", enabled: true, ...(includeFull === undefined ? {} : { includeFull }),
      });
    }
    await setAutoPlan("chat:scope", false);
    expect(invoke).toHaveBeenLastCalledWith("orchestration_auto_plan_set", { chatKey: "chat:scope", enabled: false });
  });
  it("never enables after an approval refusal or a duplicate approval", async () => {
    invoke.mockClear();
    await expect(approveWithAutoPlan(async () => { throw new Error("revision changed"); }, "chat:no", true, true)).rejects.toThrow("revision changed");
    expect(await approveWithAutoPlan(async () => false, "chat:no", true, true)).toBe(false);
    expect(invoke).not.toHaveBeenCalled();
  });
});
