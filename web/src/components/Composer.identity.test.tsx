import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

vi.mock("../lib/bridge", () => ({ bridge: { invoke: async () => [] } }));

import { AgentIdentityChip, Composer, MODELS } from "./Composer";
import { agentIdentity, type TeamAgent } from "../lib/agentsMode";
import styles from "../styles.css?raw";

const opus = MODELS.find((m) => m.agent === "claude" && m.flag === "opus")!;
const ryan: TeamAgent = {
  id: "agent_ryan", name: "Ryan", role: "CTO", agent: "claude", model: "opus",
  effort: "high", access: "auto", createdAt: 1, updatedAt: 1,
};

const composer = (
  identity: ReturnType<typeof agentIdentity> | null,
  extra: Partial<Parameters<typeof Composer>[0]> = {},
) => renderToStaticMarkup(
  <Composer
    choice={opus}
    onChoice={() => {}}
    access="auto"
    onAccess={() => {}}
    onSend={() => {}}
    onStop={() => {}}
    busy={false}
    effort="high"
    onEffort={() => {}}
    lite={false}
    onLite={() => {}}
    identity={identity}
    {...extra}
  />,
);

describe("the composer in agents mode", () => {
  it("names the agent instead of offering model, access and effort", () => {
    const html = composer(agentIdentity(ryan, "Ryan", opus));
    expect(html).toContain("composer-identity");
    expect(html).toContain(">Ryan<");
    // Role, provider and model are details: in the tooltip, not on the bar.
    expect(html).not.toContain(">CTO<");
    expect(html).not.toContain(`>${opus.model}<`);
    expect(html).toMatch(new RegExp(`title="Ryan\\nCTO\\nClaude ${opus.model}`));
    expect(html).toContain('placeholder="Message Ryan…"');
    expect(html).toContain("agent-avatar-initials");
    expect(html).not.toContain("model-trigger");
    expect(html).not.toContain("eff-btn");
    expect(html).not.toContain("settings-toggle");
    expect(html).not.toContain("perm-auto");
  });

  it("says which chat it is the composer of, where it names the agent", () => {
    // A confirmed route's face and name land on the composer of the chat it
    // opened (`lib/identityTravel.composerLanding`), found by this and never
    // by the name: the same agent has other chats.
    const html = composer(agentIdentity(ryan, "Ryan", opus), { session: "chat_new" });
    expect(html).toMatch(/<div class="composer-identity" title="[^"]*" data-chat="chat_new">/);
    // A conversation not saved yet is no chat, and says none.
    expect(composer(agentIdentity(ryan, "Ryan", opus))).not.toContain("data-chat");
  });

  it("draws the registered avatar when there is one", () => {
    const withFace = { ...ryan, avatar: "data:image/png;base64,AA==" };
    const html = composer(agentIdentity(withFace, "Ryan", opus));
    expect(html).toContain('src="data:image/png;base64,AA=="');
  });

  it("keeps where a new task runs behind Advanced until it is opened", () => {
    const identity = agentIdentity(ryan, "Ryan", opus);
    const location = { showWorkLocation: true, projects: [{ id: "p", name: "octiq-flow" }], projectId: "p" };
    const closed = composer(identity, { ...location, advanced: { open: false, onToggle: () => {}, summary: "New worktree from develop", overridden: false } });
    expect(closed).not.toContain("work-location");
    expect(closed).toContain('aria-label="Where this task runs (Advanced)"');
    expect(closed).toContain("Automatic: New worktree from develop");
    const open = composer(identity, { ...location, advanced: { open: true, onToggle: () => {}, summary: "x", overridden: true } });
    expect(open).toContain("work-location");
    expect(open).toContain("is-overridden");
    // An ordinary chat keeps the location shelf exactly as before.
    expect(composer(null, location)).toContain("work-location");
    expect(composer(null, location)).toContain('placeholder="Ask Claude to…"');
  });

  it("keeps every control in an ordinary chat", () => {
    const html = composer(null);
    expect(html).not.toContain("composer-identity");
    expect(html).toContain("model-trigger");
    expect(html).toContain("eff-btn");
    expect(html).toContain("settings-toggle");
    expect(html).toContain("perm-auto");
  });

  const RUNS = { model: "Opus", effort: "High", access: "Auto" };

  it("says what this chat runs at beside the name, in two parts, as a disclosure and not a picker", () => {
    const html = composer(agentIdentity(ryan, "Ryan", opus), { session: "chat_1", runsAt: RUNS });
    // After the name, which stays the name alone: it is what a confirmed
    // route's name lands on (`identityTravel.composerLanding`, `cutShort`).
    expect(html).toMatch(/<span class="composer-identity-name">Ryan<\/span><button type="button" class="composer-identity-runs" aria-expanded="false" aria-controls="[^"]+" aria-label="What this chat runs at: opus · high · Auto">/);
    // The model and the effort, then the access with its separator: the
    // first part is what a narrow composer cuts, the access what it keeps.
    expect(html).toContain('<span class="composer-identity-rest">opus · high</span><span class="composer-identity-access"> · Auto</span></button>');
    // Folded, it draws no sheet; and nothing in the chip is a picker.
    const chip = html.slice(html.indexOf('<div class="composer-identity"'), html.indexOf("</button>", html.indexOf("composer-identity-runs")));
    expect(chip).not.toMatch(/<a |aria-haspopup|role="menu"|picker-menu|<select|<input/);
    expect(chip.match(/<button/g)).toHaveLength(1);
    expect(html).not.toContain("model-trigger");
  });

  it("shows the three values whole when it is opened, read-only, with the receipt", () => {
    const identity = agentIdentity(ryan, "Ryan", opus);
    const html = renderToStaticMarkup(<AgentIdentityChip identity={identity} chat="chat_1" runsAt={{ model: "Opus latest", effort: "High", access: "Plan" }}
      receipt={["Last turn · 178.1s", "Cost · $9.526"]} initiallyOpen />);
    expect(html).toContain('aria-expanded="true"');
    const sheet = html.slice(html.indexOf('class="picker-menu composer-identity-sheet"'));
    expect(/aria-controls="([^"]+)"/.exec(html)![1]).toBe(/id="([^"]+)"/.exec(sheet)![1]);
    expect(sheet).toContain("<dt>Model</dt><dd>Opus latest</dd>");
    expect(sheet).toContain("<dt>Effort</dt><dd>High</dd>");
    expect(sheet).toContain("<dt>Access</dt><dd>Plan</dd>");
    expect(sheet).toContain("<p>Last turn · 178.1s</p><p>Cost · $9.526</p>");
    // Nothing in it changes anything: no button, no input, no link.
    expect(sheet).not.toMatch(/<button|<input|<select|<a |role="menu(item)?"/);
    // A press outside it shuts it.
    expect(html).toContain('<div class="picker-scrim"></div>');
    // The tooltip does not stand over the open sheet.
    expect(html).not.toMatch(/<div class="composer-identity" title=/);
  });

  it("shows only what the page knows of this chat, and never the registration's in its place", () => {
    const identity = agentIdentity(ryan, "Ryan", opus);
    // A saved chat whose record has no effort and no access: the model alone.
    const partial = renderToStaticMarkup(<AgentIdentityChip identity={identity} runsAt={{ model: "Sonnet" }} initiallyOpen />);
    expect(partial).toContain('<span class="composer-identity-rest">sonnet</span></button>');
    expect(partial).not.toContain("composer-identity-access");
    expect(partial).toContain("<dt>Model</dt><dd>Sonnet</dd>");
    expect(partial).not.toMatch(/<dt>(Effort|Access)<\/dt>/);
    // The registration's model is on its own line of the tooltip, named as
    // the registration's; the session's line is the session's.
    const folded = renderToStaticMarkup(<AgentIdentityChip identity={identity} runsAt={{ model: "Sonnet", access: "Plan" }} />);
    expect(folded).toMatch(new RegExp(`title="Ryan\\nCTO\\nClaude ${opus.model} · set in Settings, Agents\\nThis chat runs at sonnet · Plan"`));
    // The access alone carries no separator.
    expect(renderToStaticMarkup(<AgentIdentityChip identity={identity} runsAt={{ access: "Plan" }} />)).toContain('<span class="composer-identity-access">Plan</span>');
  });

  it("leaves the settings text out when the page knows none of it", () => {
    for (const runsAt of [undefined, {}]) {
      const html = composer(agentIdentity(ryan, "Ryan", opus), { runsAt });
      expect(html).not.toContain("composer-identity-runs");
      expect(html).not.toContain("This chat runs at");
    }
  });

  it("keeps the chip's tooltip, with what this chat runs at and the last turn's receipt", () => {
    const html = composer(agentIdentity(ryan, "Ryan", opus), { runsAt: RUNS, lastDurationMs: 178_100, lastCostUsd: 9.526 });
    expect(html).toMatch(new RegExp(`title="Ryan\\nCTO\\nClaude ${opus.model} · set in Settings, Agents\\nThis chat runs at opus · high · Auto\\nLast turn · 178.1s\\nCost · \\$9.526"`));
    // With no turn finished yet and nothing known the tooltip is what it was.
    expect(composer(agentIdentity(ryan, "Ryan", opus))).toMatch(new RegExp(`title="Ryan\\nCTO\\nClaude ${opus.model} · set in Settings, Agents"`));
  });

  it("draws no receipt and no model name on the eyebrow, in either kind of chat", () => {
    const receipt = { lastDurationMs: 178_100, lastCostUsd: 9.526 };
    for (const html of [composer(agentIdentity(ryan, "Ryan", opus), receipt), composer(null, receipt)]) {
      expect(html).not.toContain("composer-last");
      const eyebrow = html.slice(html.indexOf('<div class="composer-hint">'), html.indexOf('class="composer-history"'));
      expect(eyebrow).not.toContain("178.1s");
      expect(eyebrow).not.toContain("9.526");
      expect(eyebrow).not.toContain(opus.model);
    }
  });

  it("puts the receipt on the model picker's tooltip in an ordinary chat", () => {
    const html = composer(null, { lastDurationMs: 178_100, lastCostUsd: 9.526 });
    expect(html).toContain(`title="${opus.name} · ${opus.model}\nLast turn · 178.1s\nCost · $9.526"`);
    expect(composer(null)).toContain(`title="${opus.name} · ${opus.model}"`);
  });
});

describe("a chat that waits on the person does not look like it is running", () => {
  const T = Date.now();
  const running = { busy: true, turnStartedAt: T - 300_000, turnTokens: 754, thinking: true } as const;
  const eyebrow = (html: string) => html.slice(html.indexOf('<div class="composer-hint">'), html.indexOf('class="composer-history"'));

  it("says thinking, under the working face, while nothing waits", () => {
    const html = eyebrow(composer(agentIdentity(ryan, "Ryan", opus), running));
    expect(html).toContain("thinking with high effort");
    expect(html).toContain("is-working");
    expect(html).toContain("Ryan is working");
    expect(html).not.toContain("working-waits");
  });

  it("says it waits for an answer in place of what the agent was doing, in the decision colour", () => {
    const html = eyebrow(composer(agentIdentity(ryan, "Ryan", opus), { ...running, waiting: "answer" }));
    expect(html).toContain('<span class="working-waits enter-fade">Waiting for your answer</span>');
    expect(html).not.toContain("thinking");
    expect(html).not.toContain("working…");
    // The face is still: no working ring, which is the accent.
    expect(html).not.toContain("is-working");
    expect(html).toContain("Ryan is waiting for you");
    // The stopped clock, then the words: nothing else is news while it waits.
    expect(html).toMatch(/<span class="working-clock">[^<]+<\/span> · <span class="working-waits/);
    expect(html).not.toContain("tokens");
  });

  it("says it waits for an approval on a permission card, and stills the robot of an ordinary chat", () => {
    const html = eyebrow(composer(null, { ...running, waiting: "approval" }));
    expect(html).toContain(">Waiting for your approval</span>");
    expect(html).toContain('data-mood="still"');
    expect(eyebrow(composer(null, running))).toContain('data-mood="think"');
  });

  it("stops the clock at the work done before the wait, and leaves waits that are over out of it", () => {
    // Five minutes in: one minute of work, then waiting ever since.
    const waits = { turn: running.turnStartedAt, waited: 0, since: running.turnStartedAt + 60_000 };
    expect(eyebrow(composer(null, { ...running, waiting: "answer", turnWaits: waits })))
      .toContain('<span class="working-clock">1m 00s</span>');
    // Answered: four minutes waited are not the turn's.
    const over = { turn: running.turnStartedAt, waited: 240_000, since: null };
    expect(eyebrow(composer(null, { ...running, turnWaits: over }))).toMatch(/<span class="working-clock">1m 0\ds<\/span>/);
    // Another turn's waits are not this one's.
    expect(eyebrow(composer(null, { ...running, turnWaits: { ...over, turn: 1 } }))).toMatch(/<span class="working-clock">5m 0\ds<\/span>/);
  });

  it("says it is checking, in grey and still, while the page cannot yet say whether the chat waits", () => {
    // A reload: the lists of what waits have not answered. Not `thinking`,
    // no working face, and nothing asked of the person.
    const waits = { turn: running.turnStartedAt, waited: 0, since: running.turnStartedAt + 90_000, restored: true as const };
    const html = eyebrow(composer(agentIdentity(ryan, "Ryan", opus), { ...running, waiting: "unknown", turnWaits: waits }));
    expect(html).toContain('<span class="working-waits enter-fade is-unknown">Checking what waits on you</span>');
    expect(html).toContain('<span class="working-clock">1m 30s</span>');
    expect(html).not.toContain("thinking");
    expect(html).not.toContain("is-working");
    expect(html).not.toContain("is working");
    expect(html).not.toContain("is waiting for you");
    expect(html).not.toContain("tokens");
    expect(eyebrow(composer(null, { ...running, waiting: "unknown" }))).toContain('data-mood="still"');
    // Grey: not the decision colour (nothing is asked) and not the accent.
    const rule = /\.working-waits\.is-unknown \{([^}]*)\}/.exec(styles)?.[1] ?? "";
    expect(rule).toMatch(/color: var\(--fg-2\);/);
    expect(rule).not.toMatch(/--decide|--accent/);
  });

  it("says nothing of waiting on an idle composer", () => {
    expect(composer(null, { waiting: "answer" })).not.toContain("Waiting for your");
  });

  it("draws the waiting words from the decision colour and nothing from the accent", () => {
    const rule = /\.working-waits \{([^}]*)\}/.exec(styles)?.[1] ?? "";
    expect(rule).toMatch(/color: var\(--decide\);/);
    expect(rule).not.toMatch(/--accent/);
  });
});

describe("the settings text gives way before the name does", () => {
  const body = (selector: string) => new RegExp(`\\n${selector.replace(/[.[\]]/g, "\\$&")} \\{([^}]*)\\}`).exec(styles)?.[1] ?? "";
  const shrink = (rule: string) => Number(/flex: 0 (\d+) auto;/.exec(rule)?.[1]);

  it("is cut short, and then gone, before the name loses a letter", () => {
    const runs = body(".composer-identity-runs");
    const name = body(".composer-identity-name");
    expect(shrink(runs)).toBeGreaterThan(shrink(name) * 1000);
    expect(runs).toMatch(/min-width: 0;/);
    for (const rule of [name, body(".composer-identity-rest, .composer-identity-access")]) {
      expect(rule).toMatch(/min-width: 0;/);
      expect(rule).toMatch(/overflow: hidden;/);
      expect(rule).toMatch(/text-overflow: ellipsis;/);
    }
  });

  it("loses the access last of its parts", () => {
    // The model and the effort give way a hundred thousand times sooner.
    expect(shrink(body(".composer-identity-rest"))).toBeGreaterThan(shrink(body(".composer-identity-access")) * 1000);
    // The separator the access carries is kept at its start.
    expect(body(".composer-identity-rest, .composer-identity-access")).toMatch(/white-space: pre;/);
  });

  it("can be pressed at any width: its target is the whole chip", () => {
    expect(body(".composer-identity")).toMatch(/position: relative;/);
    expect(body(".composer-identity-runs::before")).toMatch(/position: absolute;\s*inset: 0;/);
    // The button itself is not positioned and does not clip, or its target
    // would be cut with its text.
    expect(body(".composer-identity-runs")).not.toMatch(/position:|overflow:/);
  });
});

describe("a removed agent", () => {
  it("says when the conversation's agent is no longer registered", () => {
    const identity = agentIdentity(undefined, "Ryan", opus);
    expect(identity.removed).toBe(true);
    const html = composer(identity);
    expect(html).toContain("data-removed");
    expect(html).toContain("No longer registered");
  });
});
