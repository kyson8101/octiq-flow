import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

// Same reason as the clean-start test beside this one: importing Composer pulls
// the bridge in, and the bridge opens a socket off `location.href` as its module
// loads. There is no `location` in the node environment and nothing here talks
// to a server.
vi.mock("../lib/bridge", () => ({ bridge: { invoke: async () => [] } }));

import { ACCESS, MODELS, SettingsSheet } from "./Composer";

/** Restart agent.
 *
 *  An agent reads its MCP servers, its plugins and the tool list they add up to
 *  once, at spawn. Add one to a chat that is already open and that chat never
 *  sees it. This row ends the process so the next message spawns a new one —
 *  the idle sweeper's ending, fifteen minutes early and on purpose.
 *
 *  It is drawn inside the model picker, which one component renders in two
 *  places: the dropdown on a wide screen and this sheet on a phone. Rendering
 *  the sheet covers both.
 */
describe("the restart row", () => {
  const claude = MODELS.find((m) => m.agent === "claude")!;

  const sheet = (onRestart?: () => void) =>
    renderToStaticMarkup(
      <SettingsSheet
        choice={claude}
        onChoice={() => {}}
        missing={() => false}
        noAgents={false}
        started
        accessList={ACCESS[claude.agent]}
        access="auto"
        onAccess={() => {}}
        effort="high"
        onEffort={() => {}}
        lite={false}
        onLite={() => {}}
        onRestart={onRestart}
        onDone={() => {}}
      />,
    );

  it("promises the conversation before it says what it costs", () => {
    // "Restart" on a chat an hour deep reads as a threat until you know the
    // transcript is not the thing being restarted, so that is the first clause.
    const out = sheet(() => {});
    expect(out).toContain("Restart agent");
    expect(out).toContain("Keeps the conversation");
  });

  it("says WHY you would press it", () => {
    // Without this it is a button that stops something for no stated reason.
    expect(sheet(() => {})).toContain("picks up new MCP servers and plugins");
  });

  it("is not offered when nothing is running", () => {
    // With no process to end, the next message already spawns a fresh agent —
    // the button would take credit for something that happened anyway.
    expect(sheet(undefined)).not.toContain("Restart agent");
  });

  it("never wears the clean-start switch's lit state", () => {
    // It is an act, not a setting: there is no state for it to be left in.
    expect(sheet(() => {})).toContain("mp-restart");
    expect(sheet(() => {})).not.toContain("mp-restart is-on");
  });
});
