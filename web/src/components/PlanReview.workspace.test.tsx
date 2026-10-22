import { describe, expect, it, vi } from "vitest";
vi.mock("../lib/bridge", () => ({ bridge: { invoke: async () => [] } }));
import { renderToStaticMarkup } from "react-dom/server";
import { hostFacts } from "../lib/__fixtures__/hostFacts";
import { CHECKOUT_WRITER_NOTE } from "../lib/workspaceChoice";
import { PlanReview } from "./PlanReview";
import { TaskPlanCard } from "./TaskPlanCard";

describe("the plan card's workspace decision on host fixtures", () => {
  it("preselects each host recommendation in native radio groups", () => {
    const snapshot = hostFacts.workspaceChoicePending();
    const html = renderToStaticMarkup(<PlanReview run={snapshot.runs[0]} tasks={snapshot.tasks} drafting={false} folds startOpen onRequestChanges={() => {}} />);
    expect(html.match(/role="radiogroup"/g)).toHaveLength(2);
    expect(html.match(/type="radio"/g)).toHaveLength(4);
    expect(html.match(/Recommended/g)).toHaveLength(2);
    expect(html).toMatch(/checked="" value="worktree"/);
    expect(html).toMatch(/checked="" value="checkout"/);
    // The reader in the current checkout is not a writer.
    expect(html).not.toContain("one writer at a time.");
  });

  it("shows approved modes read-only on every standard task card", () => {
    const { runs: [run], tasks } = hostFacts.workspaceChoiceApproved();
    for (const [index, task] of tasks.entries()) {
      const html = renderToStaticMarkup(<TaskPlanCard task={task} run={run} workspaceDecision={{ value: "worktree", disabled: false, onChange: () => {} }} />);
      expect(html).not.toContain('type="radio"');
      expect(html).toContain(index === 0 ? "Current checkout" : "New worktree");
    }
    const html = renderToStaticMarkup(<PlanReview run={run} tasks={tasks} approved drafting={false} onRequestChanges={() => {}} />);
    expect(html).not.toContain('role="radiogroup"');
    expect(html).not.toContain("Recommended");
    expect(html).toContain(CHECKOUT_WRITER_NOTE.replace("'", "&#x27;"));
  });

  it("keeps the only-checkout row and host reason read-only", () => {
    const { runs: [run], tasks } = hostFacts.workspaceChoiceOnlyCheckout();
    const html = renderToStaticMarkup(<PlanReview run={run} tasks={tasks} drafting={false} onRequestChanges={() => {}} />);
    expect(html).not.toContain('role="radiogroup"');
    expect(html).toContain("Current checkout");
    expect(html).toContain(tasks[0].workspaceChoice!.onlyCheckoutBecause);
  });

  it("leaves an older host's proposal as today's read-only row", () => {
    const { runs: [run], tasks } = hostFacts.workspaceChoicePending();
    // Same recorded moment, with the new field removed for an older host.
    for (const task of tasks) delete task.workspaceChoice;
    const html = renderToStaticMarkup(<PlanReview run={run} tasks={tasks} drafting={false} onRequestChanges={() => {}} />);
    expect(html).not.toContain('role="radiogroup"');
    expect(html).not.toContain("Recommended");
    expect(html).toContain("New worktree");
    expect(html).toContain("Current checkout");
  });
});
