import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
const { invoke } = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("./bridge", () => ({ bridge: { invoke, on: () => () => {} } }));
import { approveWithAutoPlan, autoPlanHeld, setAutoPlan } from "./autoPlan";
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
    expect(plan.run.autoPlan).toEqual({ enabled: true });
  });
  it("draws the actual host's Full hold and hides future consent when already on", () => {
    const ledger = hostFacts.autoPlanHeldAccess();
    const run = ledger.runs[0];
    expect(autoPlanHeld(run)).toBe("Not auto-approved: 1 task runs at Full access");
    const html = renderToStaticMarkup(<PlanReview run={run} tasks={ledger.tasks} surface="chat" drafting={false} onRequestChanges={() => {}} />);
    expect(html).toContain("Not auto-approved: 1 task runs at Full access");
    expect(html).not.toContain("Auto-approve this chat");
    // Changed for this test: a host peer-request hold instead of an access hold.
    expect(autoPlanHeld({ autoPlan: { enabled: true, held: { reason: "peerRequest", taskIds: ["p"] } } })).toBe("Not auto-approved: it holds a peer request");
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
    const html = renderToStaticMarkup(<AutoPlanSwitch enabled busy ready error="Only a chat's own agent can lead" onChange={() => {}} />);
    expect(html).toContain('role="switch" aria-checked="true" disabled=""');
    expect(html).toContain('role="alert"');
    expect(html).toContain("Full access tasks and peer requests still wait for you.");
  });
  it("sends one setting change across duplicate presses and waits for the host", async () => {
    let answer!: (value: unknown) => void;
    invoke.mockImplementationOnce(() => new Promise((resolve) => { answer = resolve; }));
    const first = setAutoPlan("chat:one", true);
    expect(inFlight("auto-plan:chat:one")).toBe(true);
    expect(await setAutoPlan("chat:one", false)).toBe(IN_FLIGHT);
    answer({ chatKey: "chat:one", enabled: true });
    await first;
    expect(inFlight("auto-plan:chat:one")).toBe(false);
  });
  it("approves before enabling, and keeps approval when enabling fails", async () => {
    const calls: string[] = [];
    const approve = vi.fn(async () => { calls.push("approve"); return true; });
    invoke.mockImplementationOnce(async (command) => { calls.push(command); throw new Error("Could not save setting"); });
    await expect(approveWithAutoPlan(approve, "chat:save-failed", true)).rejects.toThrow("Could not save setting");
    expect(calls).toEqual(["approve", "orchestration_auto_plan_set"]);
    expect(approve).toHaveBeenCalledTimes(1);
  });
  it("never enables after an approval refusal or a duplicate approval", async () => {
    invoke.mockClear();
    await expect(approveWithAutoPlan(async () => { throw new Error("revision changed"); }, "chat:no", true)).rejects.toThrow("revision changed");
    expect(await approveWithAutoPlan(async () => false, "chat:no", true)).toBe(false);
    expect(invoke).not.toHaveBeenCalled();
  });
});
