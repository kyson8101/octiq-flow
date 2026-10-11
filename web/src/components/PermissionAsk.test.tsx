import { afterEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
vi.mock("../lib/bridge", () => ({ bridge: { invoke: vi.fn() } }));
import { PermissionAsk, askNote, askNoteParts } from "./PermissionAsk";

const change = "Register a new agent, Nova.\n\nProvider: Codex\nAvailable in: Starfall";
// The same change as the host sends it beside the text (`changeFacts`).
const changeFacts = {
  lead: "Register a new agent, Nova.",
  rows: [{ label: "Provider", value: "Codex" }, { label: "Available in", value: "Starfall" }],
};

type AskProp = Parameters<typeof PermissionAsk>[0]["ask"];
const draw = (ask: AskProp) => renderToStaticMarkup(<PermissionAsk ask={ask} onAnswered={() => {}} />);

afterEach(() => {
  vi.useRealTimers();
});

describe("PermissionAsk", () => {
  it("puts an agent's proposed roster change on a one-off card, shown whole", () => {
    // The host asks about this one change (team_tools): "Always" would wave
    // through the next agent the chat invents, so the card does not offer it.
    const html = draw({
      id: "a1", chatKey: "chat:lead", toolName: "mcp__octiq__agent_register",
      toolInput: { change, changeFacts }, once: true, answerWithinSecs: 50,
    });
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
    const html = draw({
      id: "a2", toolName: "mcp__octiq__agent_update", once: true,
      toolInput: {
        change: "Change the agent OCTIQ DEV.\n\nReports to: Potato Juice → OCTIQ HEAD",
        changeFacts: {
          lead: "Change the agent OCTIQ DEV.",
          rows: [{ label: "Reports to", before: "Potato Juice", after: "OCTIQ HEAD" }],
        },
      },
    });
    // The whole name stays on the label: it is what a grant would be about.
    expect(html).toContain('Claude wants to use <strong title="mcp__octiq__agent_update">Agent update</strong>');
    expect(html).toContain('<span class="label-pill">OctiqFlow</span><span class="label-pill is-mono">agent_update</span>');
    // A move is drawn as what it was and what it becomes.
    expect(html).toContain(
      '<dt>Reports to</dt><dd><span class="ask-change-was">Potato Juice</span>'
      + '<span class="ask-change-arrow"> → </span><span class="ask-change-now">OCTIQ HEAD</span></dd>',
    );
  });

  it("still draws the card, and its answers, for a server named like something every object has", () => {
    // `mcp(__proto__:x)` once made the server's label an object: React threw,
    // and the card went with its buttons. `constructor` left an empty chip.
    const named: [toolName: string, server: string][] = [
      ["mcp(__proto__:x)", "__proto__"],
      ["mcp__constructor__x", "constructor"],
      ["mcp(constructor:x)", "constructor"],
      ["mcp__toString__x", "toString"],
    ];
    for (const [toolName, server] of named) {
      const html = draw({ id: "p1", toolName, toolInput: { command: "ls" } });
      expect(html, toolName).toContain(`<span class="label-pill">${server}</span><span class="label-pill is-mono">x</span>`);
      expect(html, toolName).toContain(`<strong title="${toolName}">X</strong>`);
      expect(html, toolName).toMatch(/<button class="ask-btn is-quiet"[^>]*>Deny<\/button>/);
      expect(html, toolName).toMatch(/<button class="ask-btn"[^>]*>Always<\/button>/);
      expect(html, toolName).toMatch(/<button class="ask-btn is-primary"[^>]*>Allow once<\/button>/);
    }
    // A built-in tool with such a name is one this app does not know.
    const plain = draw({ id: "p2", toolName: "constructor", toolInput: {} });
    expect(plain).toContain('data-kind="other"');
    expect(plain).toContain("Claude wants to use <strong>constructor</strong>");
    expect(plain).toContain(">Allow once<");
  });

  it("shows an older host's change as the text it wrote, never read apart into rows", () => {
    // No `changeFacts`: an older host, or a saved question. Even a text that
    // is one sentence and tidy `Label: value` lines stays text.
    const html = draw({ id: "a3", toolName: "mcp__octiq__agent_register", toolInput: { change }, once: true });
    expect(html).toContain(`<pre class="ask-card-body">${change}</pre>`);
    expect(html).not.toContain("ask-change");
    expect(html).not.toContain("<dt>");
  });

  it("draws a value over several lines as ONE row, whatever its lines look like", () => {
    // A role whose second line reads like a field. Read out of the text it
    // drew an `Access` change nobody proposed.
    const role = "New role.\nAccess: edits → danger";
    const html = draw({
      id: "a4", toolName: "mcp__octiq__agent_register", once: true,
      toolInput: {
        change: `Register a new agent, Nova.\n\nName: Nova\nRole: ${role}`,
        changeFacts: {
          lead: "Register a new agent, Nova.",
          rows: [{ label: "Name", value: "Nova" }, { label: "Role", value: role }],
        },
      },
    });
    expect(html).toContain(`<div><dt>Role</dt><dd>${role}</dd></div>`);
    expect(html.match(/<dt>/g)).toHaveLength(2);
    expect(html.match(/<dt>Role<\/dt>/g)).toHaveLength(1);
    expect(html).not.toContain("<dt>Access</dt>");
    expect(html).not.toContain("ask-change-was");
    expect(html).not.toContain("<pre");
  });

  it("stacks a move whose text is long, and keeps each side whole", () => {
    const before = "Writes notes.\nNever invents a fix.";
    const after = "Owns the notes.\nAccess: edits → full";
    const html = draw({
      id: "a5", toolName: "mcp__octiq__agent_update", once: true,
      toolInput: {
        change: "Change the agent Nova.\n\nRole: …",
        changeFacts: { lead: "Change the agent Nova.", rows: [{ label: "Role", before, after }] },
      },
    });
    expect(html).toContain(
      `<dt>Role</dt><dd class="is-stacked"><span class="ask-change-was">${before}</span>`
      + `<span class="ask-change-arrow"> → </span><span class="ask-change-now">${after}</span></dd>`,
    );
    expect(html.match(/<dt>/g)).toHaveLength(1);
  });

  it("says a cleared field is cleared, not a blank", () => {
    const html = draw({
      id: "a6", toolName: "mcp__octiq__agent_policy_update", once: true,
      toolInput: {
        change: "Clear the shared agent policy that every agent's brief starts with.",
        changeFacts: {
          lead: "Clear the shared agent policy that every agent's brief starts with.",
          rows: [{ label: "Policy", before: "Be careful", after: "" }],
        },
      },
    });
    expect(html).toContain(
      '<dt>Policy</dt><dd><span class="ask-change-was">Be careful</span>'
      + '<span class="ask-change-arrow"> → </span><em class="ask-change-now is-cleared">cleared</em></dd>',
    );
    expect(html).not.toContain('<span class="ask-change-now"></span>');
  });

  it("falls back to the whole text when the rows are not exactly rows", () => {
    const text = "Change the agent Nova.\n\nAccess: edits → auto";
    const broken: unknown[] = [
      { lead: "Change the agent Nova.", rows: [] },
      { lead: "", rows: [{ label: "Access", before: "edits", after: "auto" }] },
      { lead: "Change the agent Nova.", rows: [{ label: "Access", before: "edits", after: "auto" }, { label: "Role" }] },
      { lead: "Change the agent Nova.", rows: [{ label: "Access", value: { now: "auto" } }] },
      { lead: "Change the agent Nova.", rows: [{ label: "Access", value: "auto", hidden: "and push" }] },
      "Access: edits → auto",
      null,
    ];
    for (const changeFacts of broken) {
      const html = draw({
        id: "a7", toolName: "mcp__octiq__agent_update", once: true, toolInput: { change: text, changeFacts },
      });
      expect(html, JSON.stringify(changeFacts)).toContain(`<pre class="ask-card-body">${text}</pre>`);
      expect(html, JSON.stringify(changeFacts)).not.toContain("ask-change");
      expect(html, JSON.stringify(changeFacts)).toContain(">Allow<");
    }
  });

  it("draws no rows for a tool that sent rows and no change", () => {
    // The rows stand in for the `change` text and for nothing else: a command
    // is what is being approved here, and it is what the card shows.
    const html = draw({ id: "a8", toolName: "Bash", toolInput: { command: "rm -rf build", changeFacts } });
    expect(html).toContain('<pre class="ask-card-body">rm -rf build</pre>');
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

  it("draws no clock for a question the host does not wait on", () => {
    // `answerWithinSecs: 0` is the host answering Deny at once, not the usual
    // three minutes: no 3:00 counting down, and no length of time in words.
    vi.useFakeTimers();
    vi.setSystemTime(1_000_000);
    const html = draw({ id: "z1", toolName: "Bash", toolInput: { command: "ls" }, answerWithinSecs: 0, receivedAt: 1_000_000 });
    expect(html).not.toContain("ask-card-clock");
    expect(html).not.toContain("3:00");
    expect(html).not.toContain("three minutes");
    expect(html).toContain(
      '<p class="ask-card-wait">Paused until you answer. No answer counts as Deny. “Always” lasts until this chat is stopped.</p>',
    );
    expect(html).toContain(">Allow once<");
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
    // The host's ceiling is three minutes, whatever larger number it is sent.
    expect(askNote({ id: "n7", once: true, answerWithinSecs: 600 })).toBe(
      "Paused until you answer. No answer within three minutes counts as Deny.",
    );
    expect(askNote({ id: "n8", once: true, answerWithinSecs: 1 })).toBe(
      "Paused until you answer. No answer within 1 second counts as Deny.",
    );
    expect(askNote({ id: "n9", once: true, answerWithinSecs: 0 })).toBe(
      "Paused until you answer. No answer counts as Deny.",
    );
    expect(askNoteParts({ id: "n6", once: true }, 75)).toEqual([
      "Paused until you answer. No answer in ", "1:15", " counts as Deny.",
    ]);
  });
});
