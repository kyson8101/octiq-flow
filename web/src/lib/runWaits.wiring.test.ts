// The app hands every surface the SAME reading of what the page holds.
//
// `runWaits.surfaces.test.tsx` asks each surface's own function or component
// what it says of one ledger, given the cards the page holds. It builds that
// hand-off itself, so it cannot see the app forgetting it: a reviewer took
// `held={pendingHeld}` off the Agents page in `App.tsx` and all of it still
// passed, while a worker's permission card vanished from that page.
//
// This file is the other half. It does not render the app (there is no DOM
// here, and the app is one component of six thousand lines). It reads
// `App.tsx` as text and checks each place a surface is given the cards, by
// name, and it runs the same check on the reviewer's mutation and on three
// more to show it fails for them. The type of the Agents page's prop is the
// compiler's half: `held` is required there, so a caller without it does not
// build.
import { describe, expect, it } from "vitest";
import app from "../App.tsx?raw";
import agentsPage from "../components/AgentsDashboard.tsx?raw";

/** One hand-off: what it is, and the text that makes it. */
const SITES: { name: string; has: RegExp }[] = [
  // The reading itself: one call, and the cards out of it.
  { name: "one reading of the cards", has: /const pendingHeld = pendingRead\.held;/ },
  // The Agents page.
  { name: "the Agents page", has: /<AgentsDashboard\b[^>]*?\bheld=\{pendingHeld\}/s },
  // The line above the composer.
  { name: "the strip", has: /chatStrip\(currentWorkflow, Date\.now\(\), pendingHeld\)/ },
  // The top bar's Tasks button.
  { name: "the Tasks button", has: /taskColumnCounts\(runWorkflow, pendingHeld\)/ },
  // The chat list and the run panel, which take it from the context.
  { name: "the context's held", has: /useMemo<PendingActionsView>\(\(\) => \{[^}]*?return \{[^}]*?\bheld: pendingHeld,/s },
  { name: "the context is provided", has: /<PendingActionsContext\.Provider value=\{pendingView\}>/ },
  // The phone's Tasks tab says "plan awaiting approval" only of a plan with
  // something to approve (`planWaits`, through `pendingPlan(...).approvable`):
  // an empty pending plan is the lead still drafting (F3).
  { name: "the tab's plan label", has: /planPending=\{!!plan\?\.approvable\}/ },
];

/** What is missing from `source`, by name. */
const missing = (source: string) => SITES.filter((site) => !site.has.test(source)).map((site) => site.name);

describe("the app's hand-off of the cards the page holds", () => {
  it("gives every surface the one reading", () => {
    expect(missing(app)).toEqual([]);
    // Exactly one reading is made, and nothing else is called `held`.
    expect(app.match(/pendingReading\(/g)).toHaveLength(1);
    expect(app.match(/\bheld=\{/g)).toEqual(["held={", "held={"]);
  });

  it("fails for the reviewer's mutation, and for the others like it", () => {
    // The reviewer's: the Agents page is handed nothing.
    expect(missing(app.replace("held={pendingHeld}", "held={undefined}"))).toEqual(["the Agents page"]);
    // The prop is taken off altogether.
    expect(missing(app.replace(/\n\s*held=\{pendingHeld\}/, ""))).toEqual(["the Agents page"]);
    // A surface is handed a second, empty reading.
    expect(missing(app.replace("chatStrip(currentWorkflow, Date.now(), pendingHeld)", "chatStrip(currentWorkflow, Date.now())"))).toEqual(["the strip"]);
    expect(missing(app.replace("taskColumnCounts(runWorkflow, pendingHeld)", "taskColumnCounts(runWorkflow, new Map())"))).toEqual(["the Tasks button"]);
    expect(missing(app.replace("held: pendingHeld,", "held: new Map(),"))).toEqual(["the context's held"]);
    // The tab reads the run's approval itself again.
    expect(missing(app.replace("planPending={!!plan?.approvable}", "planPending={!!plan}"))).toEqual(["the tab's plan label"]);
  });

  it("makes the Agents page's cards a required prop, so dropping them does not compile", () => {
    expect(agentsPage).toMatch(/\n  held: Waiting;\n/);
    expect(agentsPage).not.toMatch(/\bheld\?: Waiting/);
    // And the page passes them on to the one function that reads the roster.
    expect(agentsPage).toMatch(/const rows = agentRoster\(\{[\s\S]{0,400}?\bwaitingOn, held, now,\n\s*\}\);/);
  });
});
