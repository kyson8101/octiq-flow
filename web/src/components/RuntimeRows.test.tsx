import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

vi.mock("../lib/bridge", () => ({ bridge: { invoke: async () => [], on: () => () => {} } }));

import { RuntimeRows } from "./RuntimeRows";
import { RuntimeSheet, type RuntimeControls } from "./RuntimeSheet";
import { AgentIdentityChip, MODELS } from "./Composer";
import { agentIdentity, type TeamAgent } from "../lib/agentsMode";
import styles from "./ChatStatus.css?raw";
import type { HomeRuntime } from "../lib/runtimeSwitch";

const opus = MODELS.find((m) => m.id === "claude:opus")!;
const sol = MODELS.find((m) => m.id === "codex:sol")!;
const ryan: TeamAgent = { id: "agent_ryan", name: "Ryan", role: "CTO", agent: "claude", model: "opus", effort: "high", access: "auto", createdAt: 1, updatedAt: 1 };
const noop = () => {};

const home = (change: Partial<HomeRuntime> = {}): HomeRuntime => ({
  agent: "claude", model: "opus", effort: "high", limited: true, resetsAt: Math.floor(Date.now() / 1000) + 3600, ...change,
});

const rows = (props: Partial<Parameters<typeof RuntimeRows>[0]> = {}) => renderToStaticMarkup(
  <RuntimeRows chat="c" current="codex" runtime={{ rev: 1, home: home() }} onBack={noop} onDismissRefusal={noop} {...props} />,
);

describe("the way back, a row of the group above the composer", () => {
  it("draws nothing for a chat that is not on a fallback", () => {
    expect(rows({ runtime: undefined })).toBe("");
    expect(rows({ runtime: { rev: 1 } })).toBe("");
  });

  it("says where the chat runs, when the limit resets, and offers the one press back", () => {
    const html = rows();
    expect(html).toContain('class="runtime-row status-row"');
    expect(html).toContain("Running on Codex");
    expect(html).toMatch(/Opus limit resets \d{1,2}:\d{2}/);
    expect(html).toContain('aria-label="Back to Opus"');
    expect(html).toContain('<span class="action-label" aria-hidden="true">Back to Opus</span>');
    // An icon and a short word: the answer is a decision, not a bare icon.
    expect(html).toContain('data-action-icon="swap"');
  });

  it("is offered while the provider is limited, and after the reset has passed", () => {
    for (const change of [{ limited: true }, { limited: true, resetsAt: Math.floor(Date.now() / 1000) - 60 }, { limited: false, resetsAt: undefined }]) {
      const html = rows({ runtime: { rev: 1, home: home(change) } });
      expect(html).toContain('aria-label="Back to Opus"');
      expect(html).not.toMatch(/aria-disabled/);
    }
    expect(rows({ runtime: { rev: 1, home: home({ resetsAt: Math.floor(Date.now() / 1000) - 60 }) } })).toContain("Opus may be available again");
    expect(rows({ runtime: { rev: 1, home: home({ limited: false, resetsAt: undefined }) } })).toContain("Opus may be available again");
  });

  it("says a switch that waits for the turn, with nothing to press", () => {
    const html = rows({ runtime: { rev: 1, pending: { agent: "claude", model: "opus", effort: null } } });
    expect(html).toContain("Switches to Opus after this turn");
    expect(html).not.toContain("<button");
  });

  it("says the host's refusal in words on the row, with a dismiss", () => {
    const html = rows({ refusal: "Claude is not installed on this machine." });
    expect(html).toContain('<span class="runtime-row-refusal" role="alert">Claude is not installed on this machine.</span>');
    expect(html).toContain('aria-label="Dismiss"');
    // The press stays available to try again; nothing of the chat's settings moved.
    expect(html).toContain('aria-label="Back to Opus"');
  });
});

describe("the rows are neutral: the accent is a turn in flight and the warning a problem", () => {
  const block = styles.slice(styles.indexOf("What the chat runs on"), styles.indexOf("runtime-row-in") + 200);
  it("is in the sheet at all", () => {
    expect(block).toContain(".runtime-back");
    expect(block).toContain(".runtime-row-refusal");
  });
  it("uses neither", () => {
    expect(block).not.toMatch(/var\(--(accent|warn|danger|decide|composer-accent)\b/);
  });
  it("gives the button 44px on a phone or a coarse pointer, and never lets it shrink", () => {
    expect(block).toMatch(/\.runtime-back \{[^}]*flex: 0 0 auto;/);
    expect(block).toMatch(/@media \(max-width: 859\.98px\), \(any-pointer: coarse\) \{\s*\.runtime-back \{ min-height: 44px; min-width: 44px; \}/);
  });
});

const controls = (change: Partial<RuntimeControls> = {}): RuntimeControls => ({ onPick: noop, onEffort: noop, onDismissRefusal: noop, ...change });
const catalog = { models: MODELS, status: {}, reload: noop, missing: () => false, noAgents: false };
const sheet = (props: Partial<Parameters<typeof RuntimeSheet>[0]> = {}) => renderToStaticMarkup(
  <RuntimeSheet chat="c" choice={sol} effort="high" access="edits" catalog={catalog} controls={controls()} onDone={noop} {...props} />,
);

describe("the sheet behind the settings text", () => {
  it("holds the model picker grouped by provider and the effort control, and no access control", () => {
    const html = sheet();
    expect(html).toContain('class="mp-tabs"');
    for (const name of ["Claude", "Codex", "pi.dev", "Antigravity"]) expect(html).toContain(`>${name}<`);
    expect(html).toContain("Effort");
    expect(html).not.toMatch(/Access|role="menuitemcheckbox"|Clean start|Restart agent/);
    expect(html).toContain('class="sheet settings-sheet runtime-sheet"');
  });

  it("says this changes this chat only, and where new chats are set", () => {
    const html = sheet();
    expect(html).toContain("This changes this chat only");
    expect(html).toContain("Settings, Agents sets what its new chats open on");
    expect(html).not.toContain("Read-only here");
  });

  it("says a waiting switch in one quiet line, and the host's refusal where the press was made", () => {
    const html = sheet({ controls: controls({ pending: { agent: "claude", model: "opus", effort: null }, refusal: "Opus is not available on this account." }) });
    expect(html).toContain('<p class="runtime-pending" role="status">Switches to Opus after this turn</p>');
    expect(html).toContain('role="alert">Opus is not available on this account.');
  });

  it("keeps a limited provider's models pickable: the sheet holds nothing for a limit", () => {
    const html = sheet({ choice: sol });
    expect(html).not.toMatch(/aria-disabled="true"/);
  });

  it("holds Antigravity at guarded Auto or Manual in words, tiles still drawn and off", () => {
    const agy = MODELS.find((m) => m.agent === "antigravity" && m.flag)!;
    const html = sheet({ choice: agy, access: "auto" });
    expect(html).toContain("Antigravity cannot ask for permission");
    expect(html).toMatch(/aria-disabled="true"/);
    // Read, Edits and Full keep their mapping.
    expect(sheet({ choice: agy, access: "edits" })).not.toContain("cannot ask for permission");
  });

  it("offers no effort for Antigravity: it is part of its model", () => {
    const agy = MODELS.find((m) => m.agent === "antigravity" && m.flag)!;
    const html = sheet({ choice: agy, access: "edits" });
    expect(html).toContain("Antigravity&#x27;s effort is part of its model.");
    expect(html).not.toContain("sheet-link");
  });
});

describe("the chip", () => {
  const identity = agentIdentity(ryan, "Ryan", opus);
  const chip = (extra: Partial<Parameters<typeof AgentIdentityChip>[0]> = {}) => renderToStaticMarkup(
    <AgentIdentityChip identity={identity} chat="c" runsAt={{ model: "Opus latest", effort: "High", access: "Auto" }} initiallyOpen {...extra} />,
  );
  const runtime = { chat: "c", choice: opus, effort: "high" as const, access: "auto" as const, controls: controls() };

  it("stays read-only where nothing is offered, without the old Read-only wording", () => {
    const html = chip();
    expect(html).toContain("This chat keeps what it runs at. Settings, Agents sets what an agent&#x27;s new chats open on.");
    expect(html).not.toContain("Read-only here");
    expect(html).not.toContain("runtime-sheet");
  });

  it("opens the pickers where the person may change it, with the name alone untouched", () => {
    const html = chip({ runtime });
    expect(html).toContain("runtime-sheet");
    expect(html).toContain('<span class="composer-identity-name">Ryan</span>');
    expect(/aria-controls="([^"]+)"/.exec(html)![1]).toBe(/class="sheet settings-sheet runtime-sheet" id="([^"]+)"/.exec(html)![1]);
  });

  it("says a waiting switch in the tooltip too", () => {
    const html = chip({ runtime: { ...runtime, controls: controls({ pending: { agent: "claude", model: "opus", effort: null } }) }, initiallyOpen: false });
    expect(html).toContain("Switches to Opus after this turn");
  });
});
