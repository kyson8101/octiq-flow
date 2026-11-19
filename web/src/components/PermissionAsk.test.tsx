import { afterEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
vi.mock("../lib/bridge", () => ({ bridge: { invoke: vi.fn() } }));
import { ChatReadingState } from "../lib/chatReadingState";
import { ReadingStateContext, readingStateKey } from "../lib/useReadingState";
import { WHOLE_MAX } from "../lib/cardFold";
import { PermissionAsk, permissionAgent, askNote, askNoteParts, askShortParts } from "./PermissionAsk";

const change = "Register a new agent, Nova.\n\nProvider: Codex\nAvailable in: Starfall";
// The same change as the host sends it beside the text (`changeFacts`).
const changeFacts = {
  lead: "Register a new agent, Nova.",
  rows: [{ label: "Provider", value: "Codex" }, { label: "Available in", value: "Starfall" }],
};

type AskProp = Parameters<typeof PermissionAsk>[0]["ask"];
const draw = (ask: AskProp) => renderToStaticMarkup(<PermissionAsk ask={ask} onAnswered={() => {}} />);
/** The same card with its one disclosure open, which static markup cannot press. */
const drawOpen = (ask: AskProp) => renderToStaticMarkup(<PermissionAsk ask={ask} onAnswered={() => {}} startOpen />);

describe("permission card provider", () => {
  it.each(["claude", "codex", "antigravity", "pi"])("names %s in every title branch", provider => {
    for (const [toolName, toolInput] of [
      ["Read", { file_path: "/p/a.ts" }],
      ["Bash", { command: "echo one\necho two" }],
      ["mcp__octiq__task_status", { objective: "Work" }],
    ] as const) {
      expect(draw({ id: "a", provider, toolName, toolInput })).toContain(`${permissionAgent(provider)} wants to use`);
    }
  });
  it("prefers the host's runtime provider to stale chat metadata, and falls back neutrally", () => {
    expect(permissionAgent("codex", "claude")).toBe("Codex");
    expect(permissionAgent(undefined, "pi")).toBe("Pi");
    expect(permissionAgent("unknown", "antigravity")).toBe("Antigravity");
    expect(draw({ id: "unknown", toolName: "Read" })).toContain("The agent wants to use");
    const html = renderToStaticMarkup(<PermissionAsk ask={{ id: "old-host", toolName: "Read" }} agent="codex" onAnswered={() => {}} />);
    expect(html).toContain("Codex wants to use");
  });
});

afterEach(() => {
  vi.useRealTimers();
});

describe("PermissionAsk", () => {
  it("names the host-stamped provider on native Codex cards", () => {
    for (const toolName of ["mcp__octiq__orchestration_validation_create", "Bash"]) {
      const html = draw({ id: "codex", provider: "codex", toolName, toolInput: { command: "git commit -m fix" } });
      expect(html).toContain("Codex wants to use");
      expect(html).not.toContain("The agent wants to use");
    }
  });

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
    expect(html).toContain("aria-label=\"Allow\"");
    // Read back with no arrival time: the wait in words, and no clock.
    expect(html).toContain(">No answer within 50 seconds counts as Deny</p>");
    expect(html).not.toContain("ask-card-clock");
    // Every row is a short fact, so there is nothing to open.
    expect(html).not.toContain("card-fold");
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
    expect(html).toContain('The agent wants to use <strong title="mcp__octiq__agent_update">Agent update</strong>');
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
      expect(html, toolName).toMatch(/<button(?=[^>]*aria-label="Deny") class="ask-btn is-quiet"[^>]*>[\s\S]*?<\/button>/);
      expect(html, toolName).toMatch(/<button(?=[^>]*aria-label="Always") class="ask-btn"[^>]*>[\s\S]*?<\/button>/);
      expect(html, toolName).toMatch(/<button(?=[^>]*aria-label="Allow once") class="ask-btn is-primary"[^>]*>[\s\S]*?<\/button>/);
    }
    // A built-in tool with such a name is one this app does not know.
    const plain = draw({ id: "p2", toolName: "constructor", toolInput: {} });
    expect(plain).toContain('data-kind="other"');
    expect(plain).toContain("The agent wants to use <strong>constructor</strong>");
    expect(plain).toContain("aria-label=\"Allow once\"");
  });

  it("shows an older host's change as the text it wrote, never read apart into rows", () => {
    // No `changeFacts`: an older host, or a saved question. Even a text that
    // is one sentence and tidy `Label: value` lines stays text.
    const ask: AskProp = { id: "a3", toolName: "mcp__octiq__agent_register", toolInput: { change }, once: true };
    // Folded: its first line, and how many more there are. Opened: all of it.
    const html = draw(ask);
    expect(html).toContain('<pre class="ask-card-body is-first"><span class="ask-card-first">Register a new agent, Nova.</span></pre>');
    expect(html).toContain("<span>3 more lines</span>");
    expect(html).not.toContain("Available in: Starfall");
    const open = drawOpen(ask);
    expect(open).toContain(`<pre class="ask-card-body is-whole">${change}</pre>`);
    for (const drawn of [html, open]) {
      expect(drawn).not.toContain("ask-change");
      expect(drawn).not.toContain("<dt>");
    }
  });

  it("draws a value over several lines as ONE row, whatever its lines look like", () => {
    // A role whose second line reads like a field. Read out of the text it
    // drew an `Access` change nobody proposed.
    const role = "New role.\nAccess: edits → danger";
    const ask: AskProp = {
      id: "a4", toolName: "mcp__octiq__agent_register", once: true,
      toolInput: {
        change: `Register a new agent, Nova.\n\nName: Nova\nRole: ${role}`,
        changeFacts: {
          lead: "Register a new agent, Nova.",
          rows: [{ label: "Name", value: "Nova" }, { label: "Role", value: role }],
        },
      },
    };
    // Folded, the row is its name and its size; its text is not on the card.
    const html = draw(ask);
    expect(html).toContain('<div><dt>Role</dt><dd class="is-folded"><span class="ask-change-size">2 lines</span></dd></div>');
    expect(html).not.toContain("Access: edits");
    expect(html.match(/<dt>/g)).toHaveLength(2);
    // Opened, it is one row again under the same name, whole.
    const open = drawOpen(ask);
    expect(open).toContain(`<div><dt>Role</dt><dd>${role}</dd></div>`);
    expect(open.match(/<dt>/g)).toHaveLength(3);
    expect(open.match(/<dt>Role<\/dt>/g)).toHaveLength(2);
    for (const drawn of [html, open]) {
      expect(drawn).not.toContain("<dt>Access</dt>");
      expect(drawn).not.toContain("ask-change-was");
      expect(drawn).not.toContain("<pre");
    }
  });

  it("stacks a move whose text is long, and keeps each side whole", () => {
    const before = "Writes notes.\nNever invents a fix.";
    const after = "Owns the notes.\nAccess: edits → full";
    const ask: AskProp = {
      id: "a5", toolName: "mcp__octiq__agent_update", once: true,
      toolInput: {
        change: "Change the agent Nova.\n\nRole: …",
        changeFacts: { lead: "Change the agent Nova.", rows: [{ label: "Role", before, after }] },
      },
    };
    expect(draw(ask)).toContain('<dt>Role</dt><dd class="is-folded"><span class="ask-change-size">changed · 2 lines → 2 lines</span></dd>');
    expect(drawOpen(ask)).toContain(
      `<dt>Role</dt><dd class="is-stacked"><span class="ask-change-was">${before}</span>`
      + `<span class="ask-change-arrow"> → </span><span class="ask-change-now">${after}</span></dd>`,
    );
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
      const html = drawOpen({
        id: "a7", toolName: "mcp__octiq__agent_update", once: true, toolInput: { change: text, changeFacts },
      });
      expect(html, JSON.stringify(changeFacts)).toContain(`<pre class="ask-card-body is-whole">${text}</pre>`);
      expect(html, JSON.stringify(changeFacts)).not.toContain("ask-change");
      expect(html, JSON.stringify(changeFacts)).toContain("aria-label=\"Allow\"");
    }
  });

  it("shows a change of more than fifty rows as the host's text, folded like an older host's", () => {
    const fields = Array.from({ length: 10_000 }, (_, i) => ({ label: `Field ${i}`, value: `v${i}` }));
    const text = `Change the agent Nova.\n\n${fields.map((row) => `${row.label}: ${row.value}`).join("\n")}`;
    const many: AskProp = {
      id: "a9", toolName: "mcp__octiq__agent_update", once: true,
      toolInput: { change: text, changeFacts: { lead: "Change the agent Nova.", rows: fields } },
    };
    const old: AskProp = { id: "a9", toolName: "mcp__octiq__agent_update", once: true, toolInput: { change: text } };
    // No rows at all: not ten thousand, and not the first fifty of them.
    const folded = draw(many);
    expect(folded).not.toContain("ask-change");
    // The same card an older host's text gets, to the character: its first
    // line, how much more there is, and the whole of it once opened.
    expect(folded).toBe(draw(old));
    expect(folded).toContain('<span class="ask-card-first">Change the agent Nova.</span>');
    expect(folded).toContain("<span>10,001 more lines</span>");
    expect(drawOpen(many)).toBe(drawOpen(old));
    expect(drawOpen(many)).toContain("Field 9999: v9999</pre>");
    expect(folded).toContain("aria-label=\"Allow\"");
  });

  it("draws no rows for a tool that sent rows and no change", () => {
    // The rows stand in for the `change` text and for nothing else: a command
    // is what is being approved here, and it is what the card shows.
    const html = draw({ id: "a8", toolName: "Bash", toolInput: { command: "rm -rf build", changeFacts } });
    expect(html).toContain('<pre class="ask-card-body is-command">rm -rf build</pre>');
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
    expect(html).toContain("The agent wants to use <strong>bash(pnpm)</strong>");
    expect(html).not.toContain("label-pill");
    expect(html).toContain('<pre class="ask-card-body is-command">pnpm test</pre>');
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
      /<div class="ask-card-foot"><p class="ask-card-wait"[^>]*>[\s\S]*?<\/p><div class="ask-card-actions"><button(?=[^>]*aria-label="Deny") class="ask-btn is-quiet"[^>]*>[\s\S]*?<\/button><button(?=[^>]*aria-label="Always") class="ask-btn"[^>]*title="Stop asking about this program for the rest of this chat"[^>]*>[\s\S]*?<\/button><button(?=[^>]*aria-label="Allow once") class="ask-btn is-primary"[^>]*>[\s\S]*?<\/button><\/div><\/div>/,
    );
  });

  it("counts down from when the page saw the question arrive", () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000_000);
    // Nineteen seconds into the usual three minutes.
    const html = draw({ id: "d1", toolName: "Bash", toolInput: { command: "ls" }, receivedAt: 1_000_000 - 19_000 });
    expect(html).toContain('>No answer in <span class="ask-card-clock">2:41</span> counts as Deny</p>');
    // The rest of the sentence is a hover away, with no clock of its own.
    expect(html).toContain(
      'title="Paused until you answer. No answer within three minutes counts as Deny. “Always” lasts until this chat is stopped."',
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
      .toContain('<span class="ask-card-clock">0:20</span> counts as Deny</p>');
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
      '<p class="ask-card-wait" title="Paused until you answer. No answer counts as Deny. “Always” lasts until this chat is stopped.">No answer counts as Deny</p>',
    );
    expect(html).toContain("aria-label=\"Allow once\"");
  });
});

describe("the permission card, folded and opened", () => {
  /** The three answers, in both states: opening must never cost a button. */
  const answers = (html: string) => {
    expect(html).toMatch(/<button(?=[^>]*aria-label="Deny") class="ask-btn is-quiet"[^>]*>[\s\S]*?<\/button>/);
    expect(html).toMatch(/<button(?=[^>]*aria-label="Allow( once)?") class="ask-btn is-primary"[^>]*>[\s\S]*?<\/button>/);
  };
  /** The control, and the box it names. */
  const control = (html: string) => {
    const button = /<button type="button" class="card-fold-toggle" aria-expanded="(true|false)" aria-controls="([^"]+)" aria-describedby="([^"]+)" aria-label="([^"]+)" title="([^"]+)"[^>]*>/.exec(html);
    expect(button, "no disclosure button").not.toBeNull();
    const [, expanded, controls, describedBy, label, title] = button!;
    // It names a box that is on the page, and the words that say what is in it.
    expect(html).toContain(`id="${controls}"`);
    expect(html).toContain(`<span class="card-fold-labels" id="${describedBy}">`);
    expect(label).toBe(title);
    return { expanded, controls, label };
  };

  /** A long text that is not a command: an older host's change. */
  const prose = "Change the agent Nova.\n\nRole: Owns the notes.\nNever invents a fix.";
  const old: AskProp = { id: "f1", toolName: "mcp__octiq__agent_update", once: true, toolInput: { change: prose } };

  it("opens it whole, above the answers", () => {
    const html = drawOpen(old);
    expect(html).toContain(`<pre class="ask-card-body is-whole">${prose}</pre>`);
    const { expanded, controls, label } = control(html);
    expect(expanded).toBe("true");
    expect(label).toBe("Hide details");
    expect(html).toContain(`<div id="${controls}" class="card-fold"><div class="card-fold-in is-bounded">`);
    // The sentences the foot shortens are the last thing in it.
    expect(html).toContain('<p class="card-fold-note">Paused until you answer. No answer within three minutes counts as Deny.</p>');
    // The line, then what it opens, then the answers: a click on the line can
    // never be left over a button.
    const line = html.indexOf("card-fold-line");
    const box = html.indexOf('class="card-fold"');
    const foot = html.indexOf("ask-card-foot");
    expect(line).toBeGreaterThan(-1);
    expect(line).toBeLessThan(box);
    expect(box).toBeLessThan(foot);
    expect(html.indexOf("aria-label=\"Allow\"")).toBeGreaterThan(html.indexOf("card-fold-note"));
    answers(html);
  });

  it("never opens with an entry animation it was not asked for", () => {
    // The class is for a press. A card drawn open, or folded, has neither.
    expect(drawOpen(old)).not.toMatch(/is-opening|is-closing/);
    expect(draw(old)).not.toMatch(/is-opening|is-closing/);
  });

  it("names every folded row of a change, and says which of them change or go", () => {
    const role = "Owns the web client.\nDoes not push.";
    const prompt = "p".repeat(8000);
    const ask: AskProp = {
      id: "f3", toolName: "mcp__octiq__agent_update", once: true,
      toolInput: {
        change: "Change the agent Nova.\n\n…",
        changeFacts: {
          lead: "Change the agent Nova.",
          rows: [
            { label: "Access", before: "edits", after: "auto" },
            { label: "Role", before: "Writes notes.", after: role },
            { label: "Persistent prompt", before: prompt, after: "" },
          ],
        },
      },
    };
    const html = draw(ask);
    expect(html).toContain('<p class="ask-change-lead">Change the agent Nova.</p>');
    // A short move stays as it is.
    expect(html).toContain('<dt>Access</dt><dd><span class="ask-change-was">edits</span>');
    // Both sizes of a move, and the size of what a cleared field was.
    expect(html).toContain('<dt>Role</dt><dd class="is-folded"><span class="ask-change-size">changed · 13 characters → 2 lines</span></dd>');
    expect(html).toContain('<dt>Persistent prompt</dt><dd class="is-folded"><span class="ask-change-size">cleared · was 8,000 characters</span></dd>');
    expect(html).toContain("<span>2 long fields</span>");
    expect(html).not.toContain("Does not push.");
    expect(html).not.toContain(prompt);
    answers(html);
    const open = drawOpen(ask);
    expect(open).toContain(`<span class="ask-change-now">${role}</span>`);
    // What a cleared prompt was is whole too: all 8,000 characters of it.
    expect(open).toContain(`<span class="ask-change-was">${prompt}</span>`);
    expect(open).toContain('<em class="ask-change-now is-cleared">cleared</em>');
    answers(open);
  });

  describe("what a removal does to the chart", () => {
    // The reviewer's payload: 300 reports under a removed head.
    const reports = Array.from({ length: 300 }, (_, i) => `Report ${String(i + 1).padStart(3, "0")}`).join(", ");
    const moved = (to: string, summary?: unknown): AskProp => ({
      id: "f4", toolName: "mcp__octiq__agent_delete", once: true,
      toolInput: {
        change: "Remove the agent HEAD.\n\n…",
        changeFacts: {
          lead: "Remove the agent HEAD.",
          rows: [
            { label: "Role", value: "Leads Octiq.\nReviews every merge." },
            { label: "Head", value: "The cross-project conversation will have no head until another is chosen." },
            { label: "Front desk", value: "Incoming requests will have no front desk until another is chosen." },
            { label: "Direct reports", value: `${reports} will report to ${to}.`, ...(summary === undefined ? {} : { summary }) },
            { label: "Memory note", value: "Kept in the vault." },
          ],
        },
      },
    });

    it("draws the host's line for the reports whole, with the size of what it stands for", () => {
      const html = draw(moved("Potato Juice", "300 direct reports will report to Potato Juice"));
      // The seats that empty, whole, though each is longer than a short fact.
      expect(html).toContain("<dt>Head</dt><dd>The cross-project conversation will have no head until another is chosen.</dd>");
      expect(html).toContain("<dt>Front desk</dt><dd>Incoming requests will have no front desk until another is chosen.</dd>");
      expect(html).toContain(
        '<dt>Direct reports</dt><dd class="is-folded"><span class="ask-change-summary">300 direct reports will report to Potato Juice</span>'
        + '<span class="ask-change-size">3,627 characters</span></dd>',
      );
      expect(html).not.toContain("Report 300");
      expect(html).toContain('<dt>Role</dt><dd class="is-folded"><span class="ask-change-size">2 lines</span></dd>');
      expect(html).toContain("<dt>Memory note</dt><dd>Kept in the vault.</dd>");
      answers(html);
    });

    it("draws no piece of the names when the host sent no line for them", () => {
      for (const to of ["Potato Juice", `Manager ${"x".repeat(100)}`]) {
        const html = draw(moved(to));
        // The label, and how much there is. Not the last sixty characters,
        // which read as the fact and were only where the text happened to end.
        expect(html, to).toMatch(/<dt>Direct reports<\/dt><dd class="is-folded"><span class="ask-change-size">[\d,]+ characters<\/span><\/dd>/);
        expect(html, to).not.toContain("…");
        expect(html, to).not.toContain("Report 300");
        expect(html, to).not.toContain("xxxx");
        expect(html, to).toContain("<dt>Head</dt>");
        expect(html, to).toContain("<dt>Front desk</dt>");
      }
    });

    it("treats a line it cannot draw as no line, and keeps the rows", () => {
      const bad: unknown[] = ["a\nb", "s".repeat(161), 300, "   ", null, { text: "300" }];
      for (const summary of bad) {
        const html = draw(moved("Potato Juice", summary));
        expect(html, JSON.stringify(summary)).toContain('<dt>Direct reports</dt><dd class="is-folded"><span class="ask-change-size">3,627 characters</span></dd>');
        // Still rows, not the fallback text.
        expect(html, JSON.stringify(summary)).toContain('<p class="ask-change-lead">Remove the agent HEAD.</p>');
        expect(html, JSON.stringify(summary)).not.toContain("ask-change-summary");
      }
    });

    it("opens every one of the 300, with no cut", () => {
      const open = drawOpen(moved("Potato Juice", "300 direct reports will report to Potato Juice"));
      expect(open).toContain(`<dt>Direct reports</dt><dd>${reports} will report to Potato Juice.</dd>`);
      expect(open).not.toContain("card-fold-cut");
      answers(open);
    });
  });

  it("opens a 20,000-character change whole, as rows and as an older host's text", () => {
    const long = Array.from({ length: 400 }, (_, i) => `Line ${String(i).padStart(3, "0")} ${"x".repeat(41)}`).join("\n");
    expect(long.length).toBeGreaterThanOrEqual(20_000);
    // What the page used to do to it: stop at 16,000 and say nothing.
    expect(long.slice(0, 16_000)).not.toBe(long);
    const text = `Change the agent Nova.\n\nRole: ${long}`;
    const old = drawOpen({ id: "f5", toolName: "mcp__octiq__agent_update", once: true, toolInput: { change: text } });
    expect(old).toContain(`<pre class="ask-card-body is-whole">${text}</pre>`);
    expect(old).not.toContain("card-fold-cut");
    const rows = drawOpen({
      id: "f6", toolName: "mcp__octiq__agent_update", once: true,
      toolInput: { change: text, changeFacts: { lead: "Change the agent Nova.", rows: [{ label: "Role", value: long }] } },
    });
    expect(rows).toContain(`<dt>Role</dt><dd>${long}</dd>`);
    // Folded, each says how much there is.
    expect(draw({ id: "f5", toolName: "mcp__octiq__agent_update", once: true, toolInput: { change: text } }))
      .toContain("<span>401 more lines</span>");
    expect(draw({
      id: "f6", toolName: "mcp__octiq__agent_update", once: true,
      toolInput: { change: text, changeFacts: { lead: "Change the agent Nova.", rows: [{ label: "Role", value: long }] } },
    })).toContain('<span class="ask-change-size">400 lines</span>');
  });

  it("will not take an Allow for a change too long to show, as text or as rows", () => {
    const off = (html: string, size: string) => {
      const why = /<span class="ask-card-why" id="([^"]+)">This change is too long to show in full \(([\d,]+) characters\), so it cannot be allowed here\. Deny it and ask for it in smaller steps\.<\/span>/.exec(html);
      expect(why, "no reason on the card").not.toBeNull();
      expect(why![2]).toBe(size);
      // The answer points at the sentence, and the sentence is above it.
      expect(html).toMatch(new RegExp(`<button class="ask-btn is-primary"[^>]*aria-disabled="true" aria-describedby="${why![1]}"[^>]*aria-label="Allow"[^>]*>`));
      expect(html.indexOf("ask-card-why")).toBeLessThan(html.indexOf("ask-card-foot"));
      expect(html).toMatch(/<button(?=[^>]*aria-label="Deny") class="ask-btn is-quiet" type="button"[^>]*>[\s\S]*?<\/button>/);
      // None of it is drawn as if it were the change, and nothing opens.
      expect(html).not.toContain("cccc");
      expect(html).not.toContain("card-fold-toggle");
    };
    const huge = `Change the policy.\n${"c".repeat(WHOLE_MAX)}`;
    const text: AskProp = { id: "f8", toolName: "mcp__octiq__agent_policy_update", once: true, toolInput: { change: huge } };
    off(draw(text), "5,000,019");
    off(drawOpen(text), "5,000,019");
    const rows: AskProp = {
      id: "f9", toolName: "mcp__octiq__agent_update", once: true,
      toolInput: { change: "Change the agent Nova.", changeFacts: { lead: "Change the agent Nova.", rows: [
        { label: "Access", before: "edits", after: "danger" },
        { label: "Role", value: "c".repeat(WHOLE_MAX + 1) },
      ] } },
    };
    off(draw(rows), "5,000,001");
    off(drawOpen(rows), "5,000,001");
    // The rows it can draw are still there, the long one by its label and size.
    expect(draw(rows)).toContain("<dt>Access</dt>");
    expect(draw(rows)).toContain('<dt>Role</dt><dd class="is-folded"><span class="ask-change-size">5,000,001 characters</span></dd>');
    // One character less is a change like any other.
    const fits = drawOpen({ ...text, toolInput: { change: `x\n${"c".repeat(WHOLE_MAX - 2)}` } });
    expect(fits).not.toContain("too long to show");
    expect(fits).not.toContain('aria-disabled="true"');
  });

});

describe("a command on the permission card", () => {
  const lines = (n: number) => Array.from({ length: n }, (_, i) => `step ${i + 1}`).join("\n");
  const bash = (command: string): AskProp => ({ id: "c1", toolName: "Bash", toolInput: { command } });
  /** The allow buttons as drawn: whether each is held back. */
  const allows = (html: string) => {
    const always = /<button(?=[^>]*aria-label="Always") class="ask-btn"([^>]*)[^>]*>[\s\S]*?<\/button>/.exec(html);
    const once = /<button(?=[^>]*aria-label="Allow once") class="ask-btn is-primary"([^>]*)[^>]*>[\s\S]*?<\/button>/.exec(html);
    expect(always, "no Always").not.toBeNull();
    expect(once, "no Allow once").not.toBeNull();
    return { always: always![1].includes('aria-disabled="true"'), once: once![1].includes('aria-disabled="true"') };
  };
  const deny = (html: string) => /<button(?=[^>]*aria-label="Deny") class="ask-btn is-quiet"([^>]*)[^>]*>[\s\S]*?<\/button>/.exec(html)![1];

  it("never names a script by its first command, and shows every line of it", () => {
    // The reviewer's two: a harmless first line over the one that matters.
    for (const [first, second] of [['echo "Routine check"', "rm -rf /tmp/example-review-data"], ["pwd", "git push origin main"]]) {
      const html = draw(bash(`${first}\n${second}`));
      expect(html).toContain('The agent wants to use <strong>Bash</strong><span class="ask-card-script">2-line script</span>');
      expect(html).not.toMatch(/bash\(|git\(|shell\(/);
      // Both lines, in one block, with nothing of it clamped or behind a control.
      const drawn = `${first}\n${second}`.replace(/"/g, "&quot;");
      expect(html).toContain(`<pre class="ask-card-body is-command">${drawn}</pre>`);
      expect(html).toContain(">command · 2 lines<");
      expect(html).not.toContain("card-fold");
      expect(html).not.toContain("ask-card-first");
      expect(html).not.toContain("more line");
      // Nothing is unseen, so nothing is held.
      expect(allows(html)).toEqual({ always: false, once: false });
      // Its icon is a thing that runs, whatever the first line reads like.
      expect(html).toContain('<span class="tool-icon" data-kind="run"');
    }
  });

  it("past twelve lines shows the first twelve, says what it does not, and holds Allow until it is opened", () => {
    const html = draw(bash(lines(13)));
    // The first twelve, each whole; the thirteenth is not on the card.
    expect(html).toContain(`<pre class="ask-command-text">${lines(12)}</pre>`);
    expect(html).not.toContain("step 13");
    // Said at full strength, with what to do about it.
    expect(html).toMatch(/<p class="ask-command-unseen"><strong>1 more line not shown<\/strong><span class="ask-card-why" id="[^"]+"> Open the full command to allow it\.<\/span><\/p>/);
    // Under the lines it shows and above the answers: the last thing read.
    expect(html.lastIndexOf("ask-command-text")).toBeLessThan(html.indexOf("ask-command-unseen"));
    expect(html.indexOf("ask-command-unseen")).toBeLessThan(html.indexOf("ask-card-foot"));
    // The control is a button in words, above the command it opens.
    const button = /<button(?=[^>]*aria-label="Open the full command") type="button" class="card-fold-button ask-btn is-primary" aria-expanded="false" aria-controls="([^"]+)" aria-describedby="([^"]+)"[^>]*>[\s\S]*?<\/button>/.exec(html);
    expect(button, "no open button").not.toBeNull();
    for (const id of button![1].split(" ")) expect(html).toContain(`id="${id}"`);
    expect(html).toContain(`id="${button![2]}">command · 13 lines<`);
    expect(html.indexOf("card-fold-button")).toBeLessThan(html.indexOf("ask-command-text"));
    expect(html.indexOf("ask-command-text")).toBeLessThan(html.indexOf("ask-card-foot"));
    // Both allows are held, each pointing at the reason; Deny is not.
    expect(allows(html)).toEqual({ always: true, once: true });
    const reason = /<span class="ask-card-why" id="([^"]+)"> Open the full command to allow it\.<\/span>/.exec(html)![1];
    expect(html).toMatch(new RegExp(`<button class="ask-btn is-primary"[^>]*aria-describedby="${reason}"[^>]*aria-label="Allow once"[^>]*>`));
    expect(html).toMatch(new RegExp(`<button class="ask-btn"[^>]*aria-describedby="${reason}"[^>]*aria-label="Always"[^>]*>`));
    expect(deny(html)).not.toContain("aria-disabled");
    expect(deny(html)).not.toContain("disabled");
    // Held is not `disabled`: the button keeps its place in the tab order.
    expect(html).not.toMatch(/<button class="ask-btn is-primary" type="button" disabled/);
  });

  it("opened, it is every line in one scroll, and the answers work", () => {
    const html = drawOpen(bash(lines(50)));
    expect(html).toContain('<div class="ask-card-body is-command is-long" data-open="true">');
    // The first twelve, then the other thirty-eight under them: all fifty.
    const rest = Array.from({ length: 38 }, (_, i) => `step ${i + 13}`).join("\n");
    expect(html).toContain(`<pre class="ask-command-text">${lines(12)}</pre>`);
    expect(html).toContain(`<pre class="ask-command-text">${rest}</pre>`);
    expect(html).toContain('aria-expanded="true"');
    expect(html).toContain("aria-label=\"Fold the command\"");
    expect(html).not.toContain("not shown");
    expect(allows(html)).toEqual({ always: false, once: false });
    // The sentences the foot shortens are still the last thing it opens.
    expect(html).toContain('<p class="card-fold-note">Paused until you answer.');
    expect(html.indexOf("card-fold-note")).toBeLessThan(html.indexOf("ask-card-foot"));
  });

  it("draws no part of a line too long to draw whole, and holds Allow the same", () => {
    const html = draw(bash(`echo ${"A".repeat(5000)} | base64 -d | sh`));
    expect(html).not.toContain("AAAA");
    expect(html).not.toContain("base64");
    expect(html).toMatch(/<strong>5,022 characters not shown<\/strong>/);
    expect(allows(html)).toEqual({ always: true, once: true });
  });

  it("titles a command it cannot draw on one line by its size, never by its first command", () => {
    const piped = `echo ${"A".repeat(4990)} | base64 -d | sh`;
    for (const html of [draw(bash(piped)), drawOpen(bash(piped))]) {
      expect(html).toContain('The agent wants to use <strong>Bash</strong><span class="ask-card-script">5,012-character command</span>');
      expect(html).not.toContain("bash(echo)");
      expect(html).toContain('<span class="tool-icon" data-kind="run"');
    }
    // Whole on one line of the card: the title it had.
    const whole = draw(bash("echo safe; rm -rf /tmp/review-danger"));
    expect(whole).toContain("The agent wants to use <strong>bash(echo)</strong>");
    expect(whole).toContain('<pre class="ask-card-body is-command">echo safe; rm -rf /tmp/review-danger</pre>');
    expect(whole).not.toContain("ask-card-script");
    expect(allows(whole)).toEqual({ always: false, once: false });
  });

  // The reviewer's: 4,999 harmless lines, then the one that matters. 329,959
  // characters, of which the card drew 200,000 and let Allow go.
  const reviewer = Array.from({ length: 5000 }, (_, i) => i === 4999 ? "rm -rf /tmp/review-danger" : "echo safe " + "x".repeat(55)).join("\n");

  it("opens a command of 329,959 characters whole, and lets Allow go only then", () => {
    expect(reviewer).toHaveLength(329_959);
    const shut = draw(bash(reviewer));
    expect(shut).not.toContain("rm -rf /tmp/review-danger");
    expect(shut).toContain("<strong>4,988 more lines not shown</strong>");
    expect(shut).toContain("aria-label=\"Open the full command\"");
    expect(allows(shut)).toEqual({ always: true, once: true });
    const open = drawOpen(bash(reviewer));
    // Every character of it is in the two blocks the card draws.
    const drawn = [...open.matchAll(/<pre class="ask-command-text">([^<]*)<\/pre>/g)].map((block) => block[1]);
    expect(drawn).toHaveLength(2);
    expect(drawn.join("\n")).toBe(reviewer);
    expect(drawn[1].endsWith("\nrm -rf /tmp/review-danger")).toBe(true);
    expect(open).not.toContain("not shown");
    expect(open).not.toContain("card-fold-cut");
    expect(allows(open)).toEqual({ always: false, once: false });
  });

  it("never lets Allow go for a command too long to show, opened or not", () => {
    const line = "echo safe " + "x".repeat(55);
    const over = `${(line + "\n").repeat(Math.ceil(WHOLE_MAX / 66))}rm -rf /tmp/review-danger`;
    const size = over.length.toLocaleString("en-US");
    const count = Math.ceil(WHOLE_MAX / 66) + 1;
    expect(count).toBe(75_759);
    for (const html of [draw(bash(over)), drawOpen(bash(over))]) {
      // No control promises the full command, and none of the rest is drawn.
      expect(html).not.toContain("Open the full");
      expect(html).not.toContain("card-fold-button");
      expect(html).not.toContain("rm -rf /tmp/review-danger");
      expect(html.match(/echo safe/g)).toHaveLength(12);
      // How much is not shown, then why it cannot be allowed and what to do.
      const why = new RegExp(`<p class="ask-command-unseen"><strong>75,747 more lines not shown</strong><span class="ask-card-why" id="([^"]+)"> This command is too long to show in full \\(${size} characters\\), so it cannot be allowed here\\. Deny it and ask for it in smaller steps\\.</span></p>`).exec(html);
      expect(why, "no reason on the card").not.toBeNull();
      expect(html.indexOf("ask-command-unseen")).toBeLessThan(html.indexOf("ask-card-foot"));
      expect(allows(html)).toEqual({ always: true, once: true });
      expect(html).toMatch(new RegExp(`<button class="ask-btn is-primary"[^>]*aria-describedby="${why![1]}"[^>]*aria-label="Allow once"[^>]*>`));
      // Deny is an ordinary button.
      expect(deny(html)).toContain('type="button"');
      expect(deny(html)).not.toContain("aria-disabled");
      expect(html).toContain('<span class="ask-card-script">75,759-line script</span>');
    }
  });

  const marked = (hex: string) => `<span class="ask-command-mark">\\u{${hex}}</span>`;

  it("marks them in a script or code an MCP tool runs, and calls it that", () => {
    const html = draw({ id: "c9", toolName: "mcp__sandbox__exec", toolInput: { script: 'print("a\u200Bb")' } });
    expect(html).toContain(`print(&quot;a${marked("200B")}b&quot;)`);
    expect(html).toContain("</strong> is in this script, drawn as its code: ");
  });

  it("treats a script or code an MCP tool runs as a command too", () => {
    const html = draw({ id: "c3", toolName: "mcp__playwright__browser_run_code_unsafe", toolInput: { code: lines(13) } });
    expect(html).toContain(">code · 13 lines<");
    expect(html).toContain("aria-label=\"Open the full code\"");
    expect(html).toContain("Open the full code to allow it.");
    expect(html).toMatch(/<button(?=[^>]*aria-label="Allow once") class="ask-btn is-primary"[^>]*aria-disabled="true"[^>]*>[\s\S]*?<\/button>/);
    const short = draw({ id: "c4", toolName: "mcp__sandbox__exec", toolInput: { script: "make\nmake install" } });
    expect(short).toContain('<pre class="ask-card-body is-command">make\nmake install</pre>');
  });

  it("says how much an MCP tool's script is in its title, like any other tool's", () => {
    // The reviewer's: thirteen lines down the MCP title, with no word of it.
    const html = draw({ id: "c7", toolName: "mcp__sandbox__run_script", toolInput: { script: lines(13) } });
    expect(html).toMatch(/The agent wants to use <strong title="mcp__sandbox__run_script">[^<]+<\/strong><span class="ask-card-chips">.*?<\/span><span class="ask-card-script">13-line script<\/span><\/span>/);
    expect(html).toContain('<span class="tool-icon" data-kind="run"');
    expect(draw({ id: "c8", toolName: "mcp__playwright__browser_run_code_unsafe", toolInput: { code: lines(2) } }))
      .toContain('<span class="ask-card-script">2-line script</span>');
    // One line it cannot draw: by its size.
    expect(draw({ id: "c9", toolName: "mcp__sandbox__run_script", toolInput: { code: `print("${"A".repeat(4991)}")` } }))
      .toContain('<span class="ask-card-script">5,000-character script</span>');
    // One line it draws whole: no badge, as before.
    expect(draw({ id: "c10", toolName: "mcp__sandbox__run_script", toolInput: { script: "make" } })).not.toContain("ask-card-script");
  });

  it("opens a diff of 600 rows whole in one step, and counts what it leaves of a longer one", () => {
    const lines = (n: number) => Array.from({ length: n }, (_, i) => `line ${i}`).join("\n");
    const whole = drawOpen({ id: "c5", toolName: "Write", toolInput: { file_path: "/repo/big.txt", content: lines(600) } });
    expect(whole.match(/diff-row is-add/g)).toHaveLength(600);
    expect(whole).not.toContain("diff-more");
    // 5,000 rows at once hold the page for about 0.4 s, so past 600 the rest
    // stays one press away, and says exactly how much it is.
    const long = drawOpen({ id: "c6", toolName: "Write", toolInput: { file_path: "/repo/big.txt", content: lines(5000) } });
    expect(long.match(/diff-row is-add/g)).toHaveLength(600);
    expect(long).toContain("Show 4400 more lines");
    // Those rows are a press away on a control that says how many, not cut:
    // nothing of the file is beyond reach, so the answers are not held.
    expect(long).toMatch(/<button class="diff-more" type="button">/);
    expect(long).not.toContain('aria-disabled="true"');
    expect(long).not.toContain("too long to show");
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

describe("the line beside the answers", () => {
  it("keeps the one consequence, and nothing that is not one", () => {
    expect(askShortParts({ id: "s1" }, 161)).toEqual(["No answer in ", "2:41", " counts as Deny"]);
    expect(askShortParts({ id: "s2", answerWithinSecs: 50 })).toEqual(["No answer within 50 seconds counts as Deny", null, ""]);
    expect(askShortParts({ id: "s3" })).toEqual(["No answer within three minutes counts as Deny", null, ""]);
    expect(askShortParts({ id: "s4", answerWithinSecs: 0 }, null)).toEqual(["No answer counts as Deny", null, ""]);
  });
});

describe("a command disclosure restored from page memory", () => {
  const command = Array.from({ length: 13 }, (_, i) => `echo command line ${i + 1}`).join("\n");
  const renderRestored = (text: string, state: ChatReadingState) => renderToStaticMarkup(
    <ReadingStateContext.Provider value={{ state, path: "permission" }}>
      <PermissionAsk ask={{ id: "restored", toolName: "Bash", toolInput: { command: text } }} onAnswered={() => {}} />
    </ReadingStateContext.Provider>,
  );
  const bothHeld = (html: string) => {
    for (const label of ["Always", "Allow once"]) {
      const button = html.match(/<button[^>]*>/g)?.find(button => button.includes(`aria-label="${label}"`));
      expect(button).toContain('aria-disabled="true"');
    }
  };
  it("restores the open choice but keeps both Allows held before this mount's post-draw proof", () => {
    const state = new ChatReadingState();
    state.set(readingStateKey("permission", "fold:restored"), true);
    const html = renderRestored(command, state);
    expect(html).toContain('aria-label="Fold the command"');
    expect(html).toContain("echo command line 13");
    expect(html).toContain("Wait for the full command to be drawn.");
    bothHeld(html);
    // A second render is another mount. An earlier card's local drawnWhole
    // evidence must never have been persisted with the open choice.
    bothHeld(renderRestored(command, state));
  });
  it("holds a replaced command under the same id, even though its restored fold draws it whole", () => {
    const state = new ChatReadingState();
    state.set(readingStateKey("permission", "fold:restored"), true);
    renderRestored(command, state);
    const html = renderRestored(command + "\necho replacement", state);
    expect(html).toContain("echo replacement");
    bothHeld(html);
  });
});
