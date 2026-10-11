import { afterEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
vi.mock("../lib/bridge", () => ({ bridge: { invoke: vi.fn() } }));
import { PermissionAsk, askNote, askNoteParts, askShortParts } from "./PermissionAsk";

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
    expect(draw(ask)).toContain('<dt>Role</dt><dd class="is-folded"><span class="ask-change-size">changed · 2 lines</span></dd>');
    expect(drawOpen(ask)).toContain(
      `<dt>Role</dt><dd class="is-stacked"><span class="ask-change-was">${before}</span>`
      + `<span class="ask-change-arrow"> → </span><span class="ask-change-now">${after}</span></dd>`,
    );
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
      const html = drawOpen({
        id: "a7", toolName: "mcp__octiq__agent_update", once: true, toolInput: { change: text, changeFacts },
      });
      expect(html, JSON.stringify(changeFacts)).toContain(`<pre class="ask-card-body is-whole">${text}</pre>`);
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
      /<div class="ask-card-foot"><p class="ask-card-wait"[^>]*>[^<]*<\/p><div class="ask-card-actions"><button class="ask-btn is-quiet"[^>]*>Deny<\/button><button class="ask-btn"[^>]*title="Stop asking about this program for the rest of this chat"[^>]*>Always<\/button><button class="ask-btn is-primary"[^>]*>Allow once<\/button><\/div><\/div>/,
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
    expect(html).toContain(">Allow once<");
  });
});

describe("the permission card, folded and opened", () => {
  /** The three answers, in both states: opening must never cost a button. */
  const answers = (html: string) => {
    expect(html).toMatch(/<button class="ask-btn is-quiet"[^>]*>Deny<\/button>/);
    expect(html).toMatch(/<button class="ask-btn is-primary"[^>]*>Allow( once)?<\/button>/);
  };
  /** The control, and the box it names. */
  const control = (html: string) => {
    const button = /<button type="button" class="card-fold-toggle" aria-expanded="(true|false)" aria-controls="([^"]+)" aria-describedby="([^"]+)" aria-label="([^"]+)" title="([^"]+)">/.exec(html);
    expect(button, "no disclosure button").not.toBeNull();
    const [, expanded, controls, describedBy, label, title] = button!;
    // It names a box that is on the page, and the words that say what is in it.
    expect(html).toContain(`id="${controls}"`);
    expect(html).toContain(`<span class="card-fold-labels" id="${describedBy}">`);
    expect(label).toBe(title);
    return { expanded, controls, label };
  };

  const script = "cd web\npnpm install\npnpm test\nrm -rf dist";
  const bash: AskProp = { id: "f1", toolName: "Bash", toolInput: { command: script } };

  it("shows a one-line command whole, with nothing to open", () => {
    const html = draw({ id: "f0", toolName: "Bash", toolInput: { command: "pnpm test" } });
    expect(html).toContain('<pre class="ask-card-body">pnpm test</pre>');
    expect(html).not.toContain("card-fold");
    answers(html);
  });

  it("folds a command over several lines to its first, and says how many more", () => {
    const html = draw(bash);
    expect(html).toContain('<div class="ask-card-label">command</div><pre class="ask-card-body is-first"><span class="ask-card-first">cd web</span></pre>');
    expect(html).toContain('<span>3 more lines</span>');
    expect(html).not.toContain("rm -rf dist");
    const { expanded, controls, label } = control(html);
    expect(expanded).toBe("false");
    expect(label).toBe("Show details");
    // Shut, the box is there to be named and holds nothing.
    expect(html).toContain(`<div id="${controls}" class="card-fold" hidden=""></div>`);
    answers(html);
  });

  it("opens it whole, above the answers", () => {
    const html = drawOpen(bash);
    expect(html).toContain(`<pre class="ask-card-body is-whole">${script}</pre>`);
    const { expanded, controls, label } = control(html);
    expect(expanded).toBe("true");
    expect(label).toBe("Hide details");
    expect(html).toContain(`<div id="${controls}" class="card-fold"><div class="card-fold-in is-bounded">`);
    // The sentences the foot shortens are the last thing in it.
    expect(html).toContain('<p class="card-fold-note">Paused until you answer. No answer within three minutes counts as Deny. “Always” lasts until this chat is stopped.</p>');
    // The line, then what it opens, then the answers: a click on the line can
    // never be left over a button.
    const line = html.indexOf("card-fold-line");
    const box = html.indexOf('class="card-fold"');
    const foot = html.indexOf("ask-card-foot");
    expect(line).toBeGreaterThan(-1);
    expect(line).toBeLessThan(box);
    expect(box).toBeLessThan(foot);
    expect(html.indexOf(">Allow once<")).toBeGreaterThan(html.indexOf("card-fold-note"));
    answers(html);
  });

  it("never opens with an entry animation it was not asked for", () => {
    // The class is for a press. A card drawn open, or folded, has neither.
    expect(drawOpen(bash)).not.toMatch(/is-opening|is-closing/);
    expect(draw(bash)).not.toMatch(/is-opening|is-closing/);
  });

  it("shows a diff as its counts, and the diff itself on request", () => {
    const edit: AskProp = {
      id: "f2", toolName: "Edit",
      toolInput: { file_path: "/repo/web/src/lib/chat.ts", old_string: "one\ntwo\nthree", new_string: "one\n2\nthree\nfour" },
    };
    const html = draw(edit);
    // The tool and the path are never folded.
    expect(html).toContain('<div class="ask-card-path" title="/repo/web/src/lib/chat.ts">');
    expect(html).toContain("<span>+2 −1 in chat.ts</span>");
    expect(html).not.toContain("diff-row");
    answers(html);
    const open = drawOpen(edit);
    expect(open).toContain('<div class="ask-card-label">changing</div>');
    expect(open.match(/diff-row is-add/g)).toHaveLength(2);
    expect(open.match(/diff-row is-del/g)).toHaveLength(1);
    answers(open);
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
    expect(html).toContain('<dt>Role</dt><dd class="is-folded"><span class="ask-change-size">changed · 2 lines</span></dd>');
    expect(html).toContain('<dt>Persistent prompt</dt><dd class="is-folded"><span class="ask-change-size">cleared</span></dd>');
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

  it("never folds what a removal does to the chart", () => {
    const reports = Array.from({ length: 300 }, (_, i) => `Dev${i}`).join(", ");
    const ask: AskProp = {
      id: "f4", toolName: "mcp__octiq__agent_delete", once: true,
      toolInput: {
        change: "Remove the agent Cto.\n\n…",
        changeFacts: {
          lead: "Remove the agent Cto.",
          rows: [
            { label: "Role", value: "Leads Octiq.\nReviews every merge." },
            { label: "Head", value: "The cross-project conversation will have no head until another is chosen." },
            { label: "Direct reports", value: `${reports} will report to Potato.` },
            { label: "Memory note", value: "Kept in the vault." },
          ],
        },
      },
    };
    const html = draw(ask);
    // The seat that empties, whole, though it is longer than a short fact.
    expect(html).toContain("<dt>Head</dt><dd>The cross-project conversation will have no head until another is chosen.</dd>");
    // 300 names fold; that they move, and to whom, does not.
    expect(html).toMatch(/<dt>Direct reports<\/dt><dd class="is-folded"><span class="ask-change-tail">…[^<]*Dev299 will report to Potato\.<\/span><span class="ask-change-size">[\d,]+ characters<\/span><\/dd>/);
    expect(html).not.toContain("Dev0, Dev1,");
    expect(html).toContain('<dt>Role</dt><dd class="is-folded"><span class="ask-change-size">2 lines</span></dd>');
    expect(html).toContain("<dt>Memory note</dt><dd>Kept in the vault.</dd>");
    // Opened: every one of the 300, with no cut.
    const open = drawOpen(ask);
    expect(open).toContain(`<dt>Direct reports</dt><dd>${reports} will report to Potato.</dd>`);
    expect(open).not.toContain("card-fold-cut");
    answers(open);
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

  it("says exactly how much is left out past the hard cap, and only then", () => {
    const huge = "c".repeat(200_000 + 77);
    const open = drawOpen({ id: "f7", toolName: "Bash", toolInput: { command: huge } });
    expect(open).toContain(`<pre class="ask-card-body is-whole">${"c".repeat(200_000)}</pre>`);
    expect(open).toContain('<p class="card-fold-cut" role="note">The first 200,000 of 200,077 characters are shown. 77 characters are not shown.</p>');
    // Folded, the size is the whole size, not the capped one.
    expect(draw({ id: "f7", toolName: "Bash", toolInput: { command: huge } })).toContain("<span>200,077 characters</span>");
  });

  it("folds a plan to its opening and opens every line of it", () => {
    const plan = `## Step 1\n${"Add the flag.\n".repeat(900)}## Step 2\nPrint and exit.`;
    expect(plan.length).toBeGreaterThan(8000);
    const ask: AskProp = { id: "f8", toolName: "ExitPlanMode", toolInput: { plan } };
    expect(draw(ask)).toContain('<span class="ask-card-first">## Step 1</span>');
    expect(draw(ask)).toContain("<span>902 more lines</span>");
    expect(drawOpen(ask)).toContain(`<pre class="ask-card-body is-whole">${plan}</pre>`);
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
