import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { UsageFeed } from "../lib/usageFeed";
import { UsageRowView } from "./Usage";

vi.mock("../lib/bridge", () => ({ bridge: { invoke: vi.fn() } }));

const NOW = 1_800_000_000_000;
const feed = (over: Partial<UsageFeed> = {}): UsageFeed => ({
  data: {
    claude: {
      available: true,
      plan: "max",
      fiveHour: { percent: 42, resetsAt: NOW / 1000 + 9600 },
      weekly: { percent: 61 },
      models: [{ name: "opus", percent: 88 }],
    },
    codex: { available: true, weekly: { percent: 30 } },
  },
  stale: { claude: false, codex: false },
  asked: true,
  ...over,
});
const row = (given: UsageFeed, extra: { initiallyOpen?: boolean } = {}) =>
  renderToStaticMarkup(<UsageRowView feed={given} now={NOW} {...extra} />);

describe("the desktop usage row", () => {
  it("draws every window as a label, a bar and the percent, with its reset in the tooltip", () => {
    const html = row(feed());
    for (const label of ["Claude 5h", "Claude week", "Opus week", "Codex week"]) {
      expect(html).toContain(`<span class="usage-cell-label">${label}</span>`);
    }
    expect(html.match(/class="usage-cell"/g)).toHaveLength(4);
    expect(html.match(/class="usage-fill"/g)).toHaveLength(4);
    expect(html).toContain('title="Claude 5-hour window: 42% used · resets in 2h 40m"');
    expect(html).toContain('style="width:max(3px, 42%)"');
  });

  it("is calm below 60, the warning colour from 60 and hot from 85", () => {
    const html = row(feed());
    const cell = (label: string) => {
      const at = html.indexOf(`>${label}</span>`);
      return html.slice(at, html.indexOf("</span></span></span>", at));
    };
    expect(cell("Claude 5h")).toContain('class="usage-track "');
    expect(cell("Claude week")).toContain('class="usage-track is-warn"');
    expect(cell("Claude week")).toContain('class="usage-val is-warn"');
    expect(cell("Opus week")).toContain('class="usage-track is-danger"');
    expect(cell("Codex week")).toContain('class="usage-track "');
  });

  it("never draws Antigravity, in the row or in the breakdown it opens", () => {
    expect(row(feed())).not.toMatch(/antigravity/i);
    expect(row(feed(), { initiallyOpen: true })).not.toMatch(/antigravity/i);
  });

  it("shows an agent the host cannot read as its name and a dash, the note in the tooltip", () => {
    const html = row(feed({ data: { claude: feed().data.claude, codex: { available: false, note: "Codex has not run yet." } } }));
    expect(html).toContain('title="Codex: Codex has not run yet."');
    expect(html).toContain('<span class="usage-cell-label">Codex</span><span class="usage-cell-none">—</span>');
  });

  it("marks the last good reading when the newest ask failed", () => {
    const html = row(feed({ stale: { claude: true, codex: false } }));
    expect(html.match(/class="usage-cell is-stale"/g)).toHaveLength(3);
    expect(html).toContain("resets in 2h 40m · last known");
  });

  it("holds its height with nothing in it before the first answer, and names no agent unread", () => {
    const html = row({ data: { claude: null, codex: null }, stale: { claude: true, codex: true }, asked: false });
    expect(html).toContain('class="usage-strip gate-held"');
    expect(html).toContain('<div class="usage-strip-scroll"></div>');
    expect(html).not.toContain("Claude");
  });

  it("says so when the first answer has no reading at all", () => {
    const html = row({ data: { claude: null, codex: null }, stale: { claude: true, codex: true }, asked: true });
    expect(html).toContain('title="Claude: No reading yet."');
    expect(html).toContain('title="Codex: No reading yet."');
  });

  it("is one button that opens the full breakdown, so a reset time is never behind a hover alone", () => {
    const shut = row(feed());
    expect(shut.match(/<button/g)).toHaveLength(1);
    expect(shut).toContain('aria-haspopup="dialog"');
    expect(shut).toContain('aria-expanded="false"');
    expect(shut).toContain('aria-label="Plan usage. Claude 5-hour window: 42% used · resets in 2h 40m.');
    expect(shut).not.toContain('role="dialog"');
    const open = row(feed(), { initiallyOpen: true });
    expect(open).toContain('role="dialog"');
    expect(open).toContain("resets in 2h 40m");
    expect(open).toContain("Week · opus");
  });
});
