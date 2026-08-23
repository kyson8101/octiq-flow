import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

// Importing Composer pulls the bridge in, and the bridge opens a socket off
// `location.href` the moment its module loads — there is no `location` in the
// node test environment. Nothing here talks to the server, so it is stubbed.
vi.mock("../lib/bridge", () => ({ bridge: { invoke: async () => [] } }));

import { ACCESS, MODELS, SettingsSheet } from "./Composer";

/** The phone's settings sheet: the three pickers of the wide bar, stacked.
 *
 *  All three plus their hints are taller than a phone, so the sheet is a
 *  COLUMN — a scrolling body and a foot that does not move. What is worth a
 *  test is not the pixel scale (a stylesheet's job) but that shape: Done has
 *  to sit outside the scroller, because when it sat at the end of the scroll
 *  the one button that closes the sheet was the one you had to scroll to
 *  reach. */
describe("SettingsSheet", () => {
  const html = () =>
    renderToStaticMarkup(
      <SettingsSheet
        choice={MODELS[0]}
        onChoice={() => {}}
        missing={() => false}
        noAgents={false}
        started={false}
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

  it("keeps Done out of the part that scrolls", () => {
    const out = html();
    const foot = out.indexOf('class="sheet-foot"');
    const done = out.indexOf("sheet-done");
    expect(foot).toBeGreaterThan(-1);
    // Done is inside the foot, so nothing in the scrolling body can carry it
    // off the screen.
    expect(done).toBeGreaterThan(foot);
    expect(out.slice(0, foot)).not.toContain("sheet-done");
  });

  it("still offers all three choices, hints and all", () => {
    const out = html();
    // Compacting is padding, never content: every row still says what it does.
    expect(out).toContain("Model");
    expect(out).toContain("Access");
    expect(out).toContain("Effort");
    expect(out).toContain("Bypass permissions");
    expect(out).toContain("create a plan before making changes");
  });

  it("puts every option in the scroller, so none of them push Done down", () => {
    const out = html();
    const body = out.slice(out.indexOf('class="sheet-body"'), out.indexOf('class="sheet-foot"'));
    expect(body).toContain("Bypass permissions");
    expect(body).toContain("mp-grid");
    expect(body).toContain("eff-slide");
  });
});
