// A card diagram in a reply, drawn through the transcript itself.
import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

vi.mock("./Thumb", () => ({ SentFiles: () => null }));
vi.mock("../lib/bridge", () => ({ bridge: { invoke: async () => [] } }));
vi.mock("../lib/pathStore", () => ({
  knownPath: () => undefined,
  askPaths: () => {},
  subscribePaths: () => () => {},
}));

import sheet from "./CardDiagram.css?raw";
import source from "./CardDiagram.tsx?raw";
import { CardDiagram, DiagramPending } from "./CardDiagram";
import { DIAGRAM_ICONS, diagramBlock, parseDiagram } from "../lib/cardDiagram";
import type { Message } from "../lib/chat";
import { MessageList } from "./MessageList";

const SLEEP = {
  rows: [
    [{ title: "Too little sleep", note: "Tiredness builds up", icon: "moon" }],
    [{ title: "Caffeine", icon: "coffee" }, { title: "Long screen time", note: "Dry, tired eyes", icon: "screen" }],
    [{ title: "Eyelid twitching", plain: true }],
  ],
};

const fenced = (body: string) => "```octiq-diagram\n" + body + "\n```";

const reply = (text: string): Message =>
  ({ id: "m1", role: "assistant", streaming: false, blocks: [{ kind: "text", text }] });

const render = (text: string) =>
  renderToStaticMarkup(<MessageList messages={[reply(text)]} busy={false} />);

describe("a card diagram in a reply", () => {
  const html = render(`Why these affect each other:\n\n${fenced(JSON.stringify(SLEEP, null, 2))}\n\nStill, sleep may not be the only cause.`);

  it("is drawn in place of its code block, between the words around it", () => {
    expect(html).toContain('class="dgm"');
    expect(html).not.toContain('class="code"');
    expect(html).not.toContain("&quot;rows&quot;");
    expect(html.indexOf("Why these affect each other")).toBeLessThan(html.indexOf('class="dgm"'));
    expect(html.indexOf('class="dgm"')).toBeLessThan(html.indexOf("Still, sleep may not be the only cause."));
  });

  it("is a list, labelled with its titles in order", () => {
    expect(html).toContain('role="list" aria-label="Diagram: Too little sleep, then Caffeine and Long screen time, then Eyelid twitching"');
    expect(html.match(/role="listitem"/g)).toHaveLength(3);
  });

  it("puts an arrow between rows and none before the first", () => {
    expect(html.match(/class="dgm-arrow"/g)).toHaveLength(2);
    expect(html.indexOf('class="dgm-arrow"')).toBeGreaterThan(html.indexOf("Too little sleep"));
    // Decoration: a reader of the list is not told of arrows or icons.
    expect(html).toContain('<span class="dgm-arrow" aria-hidden="true">');
    expect(html).toContain('<span class="dgm-icon" aria-hidden="true">');
  });

  it("draws a row's nodes together, and a plain node without a frame", () => {
    const second = html.split('role="listitem"')[2];
    expect(second.match(/class="dgm-node"/g)).toHaveLength(2);
    expect(html).toContain('<div class="dgm-node is-plain"><span class="dgm-title">Eyelid twitching</span></div>');
    expect(html).toContain('<span class="dgm-title">Caffeine</span>');
    expect(html).toContain('<span class="dgm-note">Dry, tired eyes</span>');
  });

  it("draws at most the one icon a node names", () => {
    expect(html.match(/class="dgm-icon"/g)).toHaveLength(3);
  });
});

describe("what is drawn as the ordinary code block instead", () => {
  it.each([
    ["not JSON", "rows: nope"],
    ["over a limit", JSON.stringify({ rows: [[{ title: "t".repeat(61) }]] })],
    ["the wrong type", JSON.stringify({ rows: [[{ title: 7 }]] })],
    ["five nodes in a row", JSON.stringify({ rows: [[1, 2, 3, 4, 5].map((n) => ({ title: `N${n}` }))] })],
  ])("%s", (_name, body) => {
    const html = render(fenced(body));
    expect(html).toContain('class="code"');
    expect(html).toContain('<span class="code-lang">octiq-diagram</span>');
    expect(html).not.toContain('class="dgm"');
  });

  it("a finished reply whose block was never closed", () => {
    const html = render("```octiq-diagram\n" + JSON.stringify(SLEEP));
    expect(html).toContain('class="code"');
    expect(html).not.toMatch(/class="dgm/);
  });

  it("any other code block, untouched", () => {
    const html = render("```json\n" + JSON.stringify(SLEEP) + "\n```");
    expect(html).toContain('<span class="code-lang">json</span>');
    expect(html).not.toContain('class="dgm"');
  });
});

describe("strings are text", () => {
  it("never become markup, in a title, a note or an icon's name", () => {
    const hostile = { rows: [[{ title: "<img src=x onerror=alert(1)>", note: "<script>alert(1)</script>", icon: "\"><svg onload=alert(1)>" }]] };
    const html = render(fenced(JSON.stringify(hostile)));
    expect(html).toContain('class="dgm"');
    expect(html).toContain("&lt;img src=x onerror=alert(1)&gt;");
    expect(html).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
    expect(html).not.toMatch(/<img|<script|onload=/);
    // The label a screen reader is given is an attribute, escaped the same way.
    expect(html).toContain('aria-label="Diagram: &lt;img src=x onerror=alert(1)&gt;"');
  });

  it("draws a Windows path with its backslashes", () => {
    const html = render(fenced(JSON.stringify({ rows: [[{ title: "C:\\Users\\kyson\\repo" }]] })));
    expect(html).toContain('<span class="dgm-title">C:\\Users\\kyson\\repo</span>');
  });

  it("reads a reply written with Windows line endings, blank lines in the block and all", () => {
    // Split on a line feed, every line of such a reply ends in a return. The
    // block splitter did not know a fence that ended in one, so a blank line
    // inside the block cut it in two and neither half was a diagram.
    const body = JSON.stringify(SLEEP, null, 2).replace("],\n", "],\n\n");
    const html = render(`Before.\n\n${fenced(body)}\n\nAfter.`.replace(/\n/g, "\r\n"));
    expect(html.match(/class="dgm"/g)).toHaveLength(1);
    expect(html).not.toContain('class="code"');
    expect(html).toContain("Eyelid twitching");
    expect(html.indexOf("Before.")).toBeLessThan(html.indexOf('class="dgm"'));
    expect(html.indexOf('class="dgm"')).toBeLessThan(html.indexOf("After."));
  });

  it("is never set as HTML", () => {
    expect(source).not.toContain("dangerouslySetInnerHTML");
  });
});

describe("a diagram that is not a block of its own", () => {
  it("is drawn inside a list item too", () => {
    const html = render("- A flow:\n\n  ```octiq-diagram\n  " + JSON.stringify(SLEEP) + "\n  ```");
    expect(html).toContain('class="dgm"');
    expect(html).toContain("Eyelid twitching");
  });

  it("stays a code block there until the reply itself closes it", () => {
    const html = render("- A flow:\n\n  ```octiq-diagram\n  " + JSON.stringify(SLEEP));
    expect(html).toContain('class="code"');
    expect(html).not.toMatch(/class="dgm/);
  });
});

describe("while its block is still being written", () => {
  const body = JSON.stringify(SLEEP, null, 2);

  /** The block as the transcript reads it at one moment of the stream. A
   *  server render shows nothing of a reply still being typed out, so the
   *  decision is asked of the function the transcript asks. */
  const at = (cut: number) => diagramBlock("```octiq-diagram\n" + body.slice(0, cut), true);

  it("is one quiet line, and never a code block of half a diagram", () => {
    for (let cut = 0; cut <= body.length; cut += 1) expect(at(cut)?.kind, `after ${cut} characters`).toBe("pending");
    const html = renderToStaticMarkup(<DiagramPending rows={null} />);
    expect(html).toBe('<div class="dgm-pending" role="status"><span class="dgm-wait">Drawing a diagram…</span></div>');
  });

  it("is the diagram the moment its closing fence arrives, and not before", () => {
    expect(diagramBlock("```octiq-diagram\n" + body + "\n``", true)?.kind).toBe("pending");
    expect(diagramBlock("```octiq-diagram\n" + body + "\n```", true)).toEqual({ kind: "diagram", diagram: SLEEP });
  });

  it("is an ordinary code block in a reply that ended without closing it", () => {
    expect(diagramBlock("```octiq-diagram\n" + body, false)).toBeNull();
  });

  it("holds the height of the rows that are whole so far, unseen", () => {
    const twoRows = at(body.indexOf("Eyelid twitching") - 30);
    expect(twoRows).toEqual({ kind: "pending", rows: SLEEP.rows.slice(0, 2) });
    const rows = parseDiagram(JSON.stringify({ rows: SLEEP.rows.slice(0, 2) }))!.rows;
    const html = renderToStaticMarkup(<DiagramPending rows={rows} />);
    expect(html.match(/role="listitem"/g)).toHaveLength(2);
    expect(sheet).toMatch(/\.dgm-ghost \{ visibility: hidden; \}/);
    // The very markup the finished rows are, so the very layout.
    expect(html).toContain(`<div class="dgm-ghost" aria-hidden="true">${renderToStaticMarkup(<CardDiagram diagram={{ rows }} />)}</div>`);
  });
});

describe("the sheet", () => {
  const rules = sheet.replace(/\/\*[\s\S]*?\*\//g, "");

  it("draws a thin frame in the border token on the card background", () => {
    expect(rules).toMatch(/\.dgm-node \{[^}]*border: 1px solid var\(--border\);[^}]*background: var\(--bg-1\);/);
    expect(rules).toMatch(/\.dgm-node\.is-plain \{[^}]*border-color: transparent;[^}]*background: transparent;/);
  });

  it("takes token colours only, and none that is a state", () => {
    expect(rules).not.toMatch(/#[0-9a-f]{3,8}\b|rgb\(|oklch\(/i);
    expect(rules).not.toMatch(/--(accent|decide|warn|danger|ok)\b/);
  });

  it("casts no shadow and draws nothing behind the words", () => {
    expect(rules).not.toMatch(/box-shadow:(?!\s*none)/);
    expect(rules).not.toMatch(/background-image|::before|::after/);
  });

  it("stacks a row's nodes under about 480px of its own width", () => {
    expect(rules).toMatch(/\.dgm \{[^}]*container-type: inline-size;/);
    expect(rules).toMatch(/@container \(max-width: 480px\) \{\s*\.dgm-nodes \{[^}]*grid-auto-flow: row;/);
  });

  it("wraps a long title and a long note inside the frame, in any font", () => {
    for (const part of [".dgm-title", ".dgm-note"]) {
      expect(rules).toMatch(new RegExp(`\\${part} \\{[^}]*max-width: 100%;[^}]*overflow-wrap: anywhere;`));
    }
    expect(rules).toMatch(/\.dgm-nodes \{[^}]*grid-auto-columns: minmax\(0, 1fr\);/);
  });

  it("has a drawing for every icon an agent may name", () => {
    for (const name of DIAGRAM_ICONS) expect(source, name).toMatch(new RegExp(`\\n  ${name}: <`));
  });
});
