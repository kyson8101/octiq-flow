import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

// Importing Composer pulls the bridge in, and the bridge opens a socket off
// `location.href` the moment its module loads — there is no `location` in the
// node test environment. Nothing here talks to the server, so it is stubbed.
vi.mock("../lib/bridge", () => ({ bridge: { invoke: async () => [] } }));

import { ACCESS, EffortList, MODELS, SettingsSheet } from "./Composer";

/** The phone's settings sheet: a STACK OF PAGES, not one long scroll.
 *
 *  All three settings used to sit in one scroller with a Done under them, so
 *  reaching effort meant scrolling past two decisions you were not making.
 *  The root now asks the one question the button is named after — which model
 *  — and effort and access are rows that say what they are set to and open
 *  their own page.
 *
 *  These render the ROOT (the page a sheet opens on); the pages behind those
 *  rows are their own components, tested below.
 */
describe("SettingsSheet", () => {
  const html = (started = false) =>
    renderToStaticMarkup(
      <SettingsSheet
        choice={MODELS[0]}
        onChoice={() => {}}
        missing={() => false}
        noAgents={false}
        started={started}
        accessList={ACCESS.claude}
        access="auto"
        onAccess={() => {}}
        effort="high"
        onEffort={() => {}}
        lite={false}
        onLite={() => {}}
        onDone={() => {}}
      />,
    );

  it("keeps the way out above the part that scrolls", () => {
    const out = html();
    const nav = out.indexOf('class="sheet-nav"');
    const body = out.indexOf('class="sheet-body');
    expect(nav).toBeGreaterThan(-1);
    // The button that closes the sheet is in the bar, and the bar is before
    // the scroller — when Done sat at the END of the scroll, the one control
    // that closed the sheet was the one you had to scroll to reach.
    expect(nav).toBeLessThan(body);
    expect(out.slice(nav, body)).toContain('aria-label="Close"');
    expect(out.slice(body)).not.toContain("sheet-nav-btn");
  });

  /** The row is the point of the split: it answers the question where it
   *  stands, so the page behind it is for changing the answer, not reading
   *  it. */
  it("says what effort and access are on without opening either", () => {
    const out = html();
    const rows = out.slice(out.indexOf('class="sheet-card"'));
    expect(rows).toContain("Effort");
    expect(rows).toContain("High");
    expect(rows).toContain("Access");
    expect(rows).toContain("Auto");
  });

  it("asks the model question on the page it opens on", () => {
    const out = html();
    // Rows with their hints, not the dropdown's grid of bare names.
    expect(out).toContain("mp-list");
    expect(out).not.toContain("mp-grid");
    expect(out).toContain("Sonnet");
    expect(out).toContain("the everyday balance");
    // And the two that belong to the model, not to a page of their own.
    expect(out).toContain("Clean start");
  });

  /** Every row here takes effect on the tap that chooses it, so there is
   *  nothing left for a Done to do. Effort used to carry its own confirm —
   *  "Change to High" — stacked directly above it, two full-width buttons
   *  with neither saying which was which. */
  it("has no confirm button of any kind", () => {
    const out = html();
    expect(out).not.toContain("eff-apply");
    expect(out).not.toContain("sheet-done");
    expect(out).not.toContain("sheet-foot");
  });
});

describe("EffortList", () => {
  const html = (started = false) =>
    renderToStaticMarkup(
      <EffortList agent="claude" effort="high" onEffort={() => {}} started={started} />,
    );

  it("puts every level on its own row, and ticks the one in force", () => {
    const out = html();
    for (const level of ["Low", "Medium", "High", "Very high", "Max", "Ultracode"]) {
      expect(out).toContain(level);
    }
    // Auto is a row here rather than the switch it is on the desktop slider:
    // a scale has nowhere to put "stop deciding", a list has — the end of it.
    expect(out).toContain("Auto");
    expect(out.match(/picker-tick/g)).toHaveLength(1);
    expect(out).toContain('aria-checked="true"');
  });

  it("says what the scale costs, and when a change lands in a running chat", () => {
    expect(html()).toContain("uses your limits faster");
    expect(html()).not.toContain("Changes this chat straight away");
    expect(html(true)).toContain("Changes this chat straight away");
  });

  it("tells a Codex chat the level waits for its next message", () => {
    const out = renderToStaticMarkup(
      <EffortList agent="codex" effort="medium" onEffort={() => {}} started />,
    );
    // Codex takes the level on its command line, so the process has to go and
    // come back — which happens on the next message, not now.
    expect(out).toContain("Applies from your next message");
    // And it is offered only the levels it has: no Ultracode over there.
    expect(out).not.toContain("Ultracode");
  });
});
