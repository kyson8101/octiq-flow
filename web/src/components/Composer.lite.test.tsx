import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

// Importing Composer pulls the bridge in, and the bridge opens a socket off
// `location.href` the moment its module loads — there is no `location` in the
// node test environment. Nothing here talks to the server, so it is stubbed.
vi.mock("../lib/bridge", () => ({ bridge: { invoke: async () => [] } }));

import { ACCESS, MODELS, SettingsSheet } from "./Composer";

/** The clean-start switch.
 *
 *  A chat on this machine starts with ten MCP servers, every installed skill
 *  and the SessionStart hooks loaded into it — 60.4k of context before anyone
 *  has said anything. The switch is the same chat without them.
 *
 *  It lives in the model picker, which is drawn in two places from one
 *  component: the dropdown on a wide screen and this sheet on a phone. The
 *  sheet is what these render, so a phone is covered too.
 */
describe("the clean-start switch", () => {
  const sheet = (choice: (typeof MODELS)[number], lite: boolean) =>
    renderToStaticMarkup(
      <SettingsSheet
        choice={choice}
        onChoice={() => {}}
        missing={() => false}
        noAgents={false}
        started={false}
        accessList={ACCESS[choice.agent]}
        access="auto"
        onAccess={() => {}}
        effort="high"
        onEffort={() => {}}
        lite={lite}
        onLite={() => {}}
        onDone={() => {}}
      />,
    );

  const claude = MODELS.find((m) => m.agent === "claude")!;
  const codex = MODELS.find((m) => m.agent === "codex")!;

  it("says what it takes away, not just its name", () => {
    // "Clean start" alone does not tell you that the skills you installed will
    // not be there, which is the whole thing you are agreeing to.
    const out = sheet(claude, false);
    expect(out).toContain("Clean start");
    expect(out).toContain("No skills, hooks or other MCP");
  });

  it("reads back the state it is in", () => {
    expect(sheet(claude, false)).toContain('aria-checked="false"');
    expect(sheet(claude, true)).toContain('aria-checked="true"');
    expect(sheet(claude, true)).toContain("mp-lite is-on");
  });

  it("is not offered for Codex", () => {
    // Codex loads its skills from a folder rather than the config it can be
    // told to skip, so the same flags saved about 2% there. A switch that did
    // almost nothing would still look like it did something.
    expect(sheet(codex, false)).not.toContain("Clean start");
  });
});
