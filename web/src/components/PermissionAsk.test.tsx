import { afterEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
vi.mock("../lib/bridge", () => ({ bridge: { invoke: vi.fn() } }));
import { PermissionAsk, askNote, askNoteParts } from "./PermissionAsk";

const change = "Register a new agent, Nova.\n\nProvider: Codex\nAvailable in: Starfall";

afterEach(() => {
  vi.useRealTimers();
});

describe("PermissionAsk", () => {
  it("puts an agent's proposed roster change on a one-off card, shown whole", () => {
    // The host asks about this one change (team_tools): "Always" would wave
    // through the next agent the chat invents, so the card does not offer it.
    const html = renderToStaticMarkup(<PermissionAsk
      ask={{
        id: "a1", chatKey: "chat:lead", toolName: "mcp__octiq__agent_register",
        toolInput: { change }, once: true, answerWithinSecs: 50,
      }}
      onAnswered={() => {}}
    />);
    // The sentence, then every field of it as a name and a value.
    expect(html).toContain('<p class="ask-change-lead">Register a new agent, Nova.</p>');
    expect(html).toContain("<div><dt>Provider</dt><dd>Codex</dd></div>");
    expect(html).toContain("<div><dt>Available in</dt><dd>Starfall</dd></div>");
    expect(html).not.toContain("<pre");
    expect(html).not.toContain("Always");
    expect(html).toContain(">Allow<");
    // Read back with no arrival time: the wait in words, and no clock.
    expect(html).toContain("No answer within 50 seconds counts as Deny.");
    expect(html).not.toContain("ask-card-clock");
  });

  it("names an MCP tool in words, with its server and its id beside them", () => {
    const html = renderToStaticMarkup(<PermissionAsk
      ask={{
        id: "a2", toolName: "mcp__octiq__agent_update", once: true,
        toolInput: { change: "Change the agent OCTIQ DEV.\n\nReports to: Potato Juice → OCTIQ HEAD" },
      }}
      onAnswered={() => {}}
    />);
    // The whole name stays on the label: it is what a grant would be about.
    expect(html).toContain('Claude wants to use <strong title="mcp__octiq__agent_update">Agent update</strong>');
    expect(html).toContain('<span class="label-pill">OctiqFlow</span><span class="label-pill is-mono">agent_update</span>');
    // A move is drawn as what it was and what it becomes.
    expect(html).toContain(
      '<dt>Reports to</dt><dd><span class="ask-change-was">Potato Juice</span>'
      + '<span class="ask-change-arrow"> → </span><span class="ask-change-now">OCTIQ HEAD</span></dd>',
    );
  });

  it("keeps a change that is not a list of fields as the text the host wrote", () => {
    // A role over several lines has lines no field claims. Every one of them
    // is being approved, so the card shows the text and drops nothing.
    const long = "Change the agent Nova.\n\nRole: Writes notes. → Owns the notes.\nNever invents a fix.\nMust not push.";
    const html = renderToStaticMarkup(<PermissionAsk
      ask={{ id: "a3", toolName: "mcp__octiq__agent_update", toolInput: { change: long }, once: true }}
      onAnswered={() => {}}
    />);
    expect(html).toContain(`<pre class="ask-card-body">${long}</pre>`);
    expect(html).not.toContain("ask-change");
  });

  it("keeps Always on an ordinary tool question", () => {
    const html = renderToStaticMarkup(<PermissionAsk
      ask={{ id: "b1", toolName: "Bash", toolInput: { command: "pnpm test" } }}
      onAnswered={() => {}}
    />);
    expect(html).toContain("Always");
    expect(html).toContain("Allow once");
    // A built-in tool keeps the name the chat's own cards give it, and no chips.
    expect(html).toContain("Claude wants to use <strong>bash(pnpm)</strong>");
    expect(html).not.toContain("label-pill");
    expect(html).toContain('<pre class="ask-card-body">pnpm test</pre>');
    expect(askNote({ id: "b1" })).toBe(
      "Paused until you answer. No answer within three minutes counts as Deny. “Always” lasts until this chat is stopped.",
    );
    expect(askNote({ id: "c1", once: true, answerWithinSecs: 180 })).toBe(
      "Paused until you answer. No answer within three minutes counts as Deny.",
    );
  });

  it("answers in the order Deny, Always, Allow, with the note before them", () => {
    const html = renderToStaticMarkup(<PermissionAsk
      ask={{ id: "b2", toolName: "Bash", toolInput: { command: "pnpm test" } }}
      onAnswered={() => {}}
    />);
    expect(html).toMatch(
      /<div class="ask-card-foot"><p class="ask-card-wait">[^<]*<\/p><div class="ask-card-actions"><button class="ask-btn is-quiet"[^>]*>Deny<\/button><button class="ask-btn"[^>]*title="Stop asking about this program for the rest of this chat"[^>]*>Always<\/button><button class="ask-btn is-primary"[^>]*>Allow once<\/button><\/div><\/div>/,
    );
  });

  it("counts down from when the page saw the question arrive", () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000_000);
    const draw = (ask: Parameters<typeof PermissionAsk>[0]["ask"]) =>
      renderToStaticMarkup(<PermissionAsk ask={ask} onAnswered={() => {}} />);
    // Nineteen seconds into the usual three minutes.
    const html = draw({ id: "d1", toolName: "Bash", toolInput: { command: "ls" }, receivedAt: 1_000_000 - 19_000 });
    expect(html).toContain(
      'No answer in <span class="ask-card-clock">2:41</span> counts as Deny. “Always” lasts until this chat is stopped.',
    );
    // The clock is words on the card, never a region read out each second.
    expect(html).not.toContain("aria-live");
    expect(html).not.toContain('role="timer"');
    // Drawn again later (another chat, then back): the same clock, further on.
    vi.setSystemTime(1_000_000 + 60_000);
    expect(draw({ id: "d1", toolName: "Bash", receivedAt: 1_000_000 - 19_000 }))
      .toContain('<span class="ask-card-clock">1:41</span>');
    // A shorter wait is the host's, and past it the clock stops at nothing.
    expect(draw({ id: "d2", toolName: "Bash", once: true, answerWithinSecs: 50, receivedAt: 1_000_000 + 30_000 }))
      .toContain('<span class="ask-card-clock">0:20</span> counts as Deny.</p>');
    expect(draw({ id: "d3", toolName: "Bash", answerWithinSecs: 50, receivedAt: 1_000_000 - 500_000 }))
      .toContain('<span class="ask-card-clock">0:00</span>');
  });
});

describe("askNote", () => {
  it("says what happens at zero, and how long Always lasts when it is offered", () => {
    expect(askNote({ id: "n1" }, 161)).toBe(
      "Paused until you answer. No answer in 2:41 counts as Deny. “Always” lasts until this chat is stopped.",
    );
    expect(askNote({ id: "n2", once: true }, 9)).toBe(
      "Paused until you answer. No answer in 0:09 counts as Deny.",
    );
    expect(askNote({ id: "n3", once: true }, 0)).toBe(
      "Paused until you answer. No answer in 0:00 counts as Deny.",
    );
  });

  it("falls back to the wait in words when the time left is unknown", () => {
    expect(askNote({ id: "n4", answerWithinSecs: 50 }, null)).toBe(
      "Paused until you answer. No answer within 50 seconds counts as Deny. “Always” lasts until this chat is stopped.",
    );
    expect(askNoteParts({ id: "n5", once: true })).toEqual([
      "Paused until you answer. No answer within three minutes counts as Deny.", null, "",
    ]);
    expect(askNoteParts({ id: "n6", once: true }, 75)).toEqual([
      "Paused until you answer. No answer in ", "1:15", " counts as Deny.",
    ]);
  });
});
