// A card diagram, read off what an agent wrote. The input is untrusted text:
// most of this file is what must NOT become a diagram.
import { describe, expect, it } from "vitest";

import host from "../../../src-tauri/src/agent_provider.rs?raw";
import mcp from "../../../scripts/mcp/octiq-ask.cjs?raw";

import {
  DIAGRAM_ICONS, DIAGRAM_LANG, DIAGRAM_LIMITS, diagramFence, diagramLabel, parseDiagram, partialRows,
} from "./cardDiagram";

const json = (value: unknown) => JSON.stringify(value);
const node = (title: string, over: Record<string, unknown> = {}) => ({ title, ...over });

const SLEEP = {
  rows: [
    [node("Too little sleep", { note: "Tiredness builds up", icon: "moon" })],
    [node("Caffeine", { icon: "coffee" }), node("Long screen time", { note: "Dry, tired eyes", icon: "screen" })],
    [node("Eyelid twitching", { plain: true })],
  ],
};

describe("a diagram that is one", () => {
  it("reads rows of nodes", () => {
    expect(parseDiagram(json(SLEEP))).toEqual(SLEEP);
  });

  it("needs only a title", () => {
    expect(parseDiagram('{"rows":[[{"title":"Alone"}]]}')).toEqual({ rows: [[{ title: "Alone" }]] });
  });

  it("accepts Windows line endings and any indentation", () => {
    const body = JSON.stringify(SLEEP, null, 2).replace(/\n/g, "\r\n") + "\r\n";
    expect(parseDiagram(body)).toEqual(SLEEP);
  });

  it("keeps a backslash, a path and markup as the text they are", () => {
    const title = "C:\\Users\\kyson\\<b>repo</b>";
    const read = parseDiagram(json({ rows: [[node(title, { note: "<img src=x onerror=alert(1)>" })]] }));
    expect(read?.rows[0][0]).toEqual({ title, note: "<img src=x onerror=alert(1)>" });
  });

  it("keeps CJK text, counted in characters", () => {
    const title = "睡".repeat(DIAGRAM_LIMITS.title);
    expect(parseDiagram(json({ rows: [[node(title)]] }))?.rows[0][0].title).toBe(title);
    // An emoji is one character, however many units it takes.
    expect(parseDiagram(json({ rows: [[node("😀".repeat(DIAGRAM_LIMITS.title))]] }))).not.toBeNull();
    expect(parseDiagram(json({ rows: [[node("😀".repeat(DIAGRAM_LIMITS.title + 1))]] }))).toBeNull();
  });

  it("writes a title on one line, whatever whitespace it came with", () => {
    expect(parseDiagram(json({ rows: [[node("  two\n\tlines  ")]] }))?.rows[0][0].title).toBe("two lines");
  });

  it("draws no icon for a name it does not know, and keeps the node", () => {
    expect(parseDiagram(json({ rows: [[node("A", { icon: "unicorn" })]] }))).toEqual({ rows: [[{ title: "A" }]] });
    expect(parseDiagram(json({ rows: [[node("A", { icon: "<svg onload=alert(1)>" })]] }))).toEqual({ rows: [[{ title: "A" }]] });
  });

  it("ignores a key it does not know, and an empty note", () => {
    expect(parseDiagram(json({ rows: [[node("A", { colour: "red", note: "  " })]], title: "x" }))).toEqual({ rows: [[{ title: "A" }]] });
  });

  it("takes plain only as a yes or a no", () => {
    expect(parseDiagram(json({ rows: [[node("A", { plain: false })]] }))).toEqual({ rows: [[{ title: "A" }]] });
    expect(parseDiagram(json({ rows: [[node("A", { plain: "true" })]] }))).toBeNull();
    expect(parseDiagram(json({ rows: [[node("A", { plain: 1 })]] }))).toBeNull();
  });

  it("is at its limits and no further", () => {
    const rows = (count: number, nodes: number) => Array.from({ length: count }, () => Array.from({ length: nodes }, (_, i) => node(`N${i}`)));
    expect(parseDiagram(json({ rows: rows(DIAGRAM_LIMITS.rows, DIAGRAM_LIMITS.nodes) }))).not.toBeNull();
    expect(parseDiagram(json({ rows: rows(DIAGRAM_LIMITS.rows + 1, 1) }))).toBeNull();
    expect(parseDiagram(json({ rows: rows(1, DIAGRAM_LIMITS.nodes + 1) }))).toBeNull();
    expect(parseDiagram(json({ rows: [[node("t".repeat(DIAGRAM_LIMITS.title))]] }))).not.toBeNull();
    expect(parseDiagram(json({ rows: [[node("t".repeat(DIAGRAM_LIMITS.title + 1))]] }))).toBeNull();
    expect(parseDiagram(json({ rows: [[node("A", { note: "n".repeat(DIAGRAM_LIMITS.note) })]] }))).not.toBeNull();
    expect(parseDiagram(json({ rows: [[node("A", { note: "n".repeat(DIAGRAM_LIMITS.note + 1) })]] }))).toBeNull();
  });

  it("fits the largest diagram the limits allow inside the size it reads", () => {
    const biggest = { rows: Array.from({ length: DIAGRAM_LIMITS.rows }, () => Array.from({ length: DIAGRAM_LIMITS.nodes },
      () => node("睡".repeat(DIAGRAM_LIMITS.title), { note: "眠".repeat(DIAGRAM_LIMITS.note), icon: "database", plain: true }))) };
    const pretty = JSON.stringify(biggest, null, 2);
    expect(pretty.length).toBeLessThan(DIAGRAM_LIMITS.source);
    expect(parseDiagram(pretty)).toEqual(biggest);
  });
});

describe("what is not a diagram", () => {
  it.each([
    ["nothing", ""],
    ["not JSON", "rows: [[title]]"],
    ["half a block", '{"rows":[[{"title":"A"}'],
    ["a list", '[[{"title":"A"}]]'],
    ["a string", '"rows"'],
    ["null", "null"],
    ["a number", "42"],
    ["no rows", "{}"],
    ["rows that are not a list", '{"rows":{"0":[{"title":"A"}]}}'],
    ["no row at all", '{"rows":[]}'],
    ["an empty row", '{"rows":[[]]}'],
    ["a row that is a node", '{"rows":[{"title":"A"}]}'],
    ["a node that is a string", '{"rows":[["A"]]}'],
    ["a node that is a list", '{"rows":[[["A"]]]}'],
    ["a node that is null", '{"rows":[[null]]}'],
    ["no title", '{"rows":[[{"note":"A"}]]}'],
    ["an empty title", '{"rows":[[{"title":"   "}]]}'],
    ["a title that is a number", '{"rows":[[{"title":7}]]}'],
    ["a title that is an object", '{"rows":[[{"title":{"toString":"A"}}]]}'],
    ["a title that is a list", '{"rows":[[{"title":["A"]}]]}'],
    ["a note that is a number", '{"rows":[[{"title":"A","note":7}]]}'],
    ["a note that is null", '{"rows":[[{"title":"A","note":null}]]}'],
    ["an icon that is a list", '{"rows":[[{"title":"A","icon":["moon"]}]]}'],
    ["a control character in a title", '{"rows":[[{"title":"A\\u0000B"}]]}'],
    ["an escape character in a note", '{"rows":[[{"title":"A","note":"\\u001b[31mred"}]]}'],
  ])("%s", (_name, source) => {
    expect(parseDiagram(source)).toBeNull();
  });

  it("is anything longer than a diagram can be, before it is parsed", () => {
    const huge = `{"rows":[[{"title":"A","note":"${"n".repeat(5_000_000)}"}]]}`;
    const began = performance.now();
    expect(parseDiagram(huge)).toBeNull();
    // Refused on its length alone: no parse, no walk.
    expect(performance.now() - began).toBeLessThan(50);
    expect(parseDiagram(" ".repeat(DIAGRAM_LIMITS.source) + json(SLEEP))).toBeNull();
  });

  it("is a block nested deeper than any diagram, and never throws", () => {
    const deep = "[".repeat(7_000) + "]".repeat(7_000);
    expect(() => parseDiagram(deep)).not.toThrow();
    expect(parseDiagram(deep)).toBeNull();
    expect(parseDiagram(`{"rows":${deep}}`)).toBeNull();
    const nested = `{"rows":[[{"title":${'{"a":'.repeat(2_000)}1${"}".repeat(2_000)}}]]}`;
    expect(parseDiagram(nested)).toBeNull();
  });

  it("is a title far over its limit, without walking it", () => {
    expect(parseDiagram(json({ rows: [[node("t".repeat(10_000))]] }))).toBeNull();
  });

  it("is not made by a key that names the prototype", () => {
    const read = parseDiagram('{"rows":[[{"title":"A","__proto__":{"plain":true},"constructor":{"prototype":{"note":"x"}}}]]}');
    expect(read).toEqual({ rows: [[{ title: "A" }]] });
    expect(({} as Record<string, unknown>).plain).toBeUndefined();
    expect(parseDiagram('{"__proto__":{"rows":[[{"title":"A"}]]}}')).toBeNull();
  });

  it("is anything but a string", () => {
    for (const value of [undefined, null, 7, {}, []]) expect(parseDiagram(value as never)).toBeNull();
  });
});

describe("what a diagram is called to a reader who cannot see it", () => {
  it("is its titles, in order", () => {
    expect(diagramLabel(parseDiagram(json(SLEEP))!)).toBe("Diagram: Too little sleep, then Caffeine and Long screen time, then Eyelid twitching");
  });
});

describe("the fence", () => {
  const body = json(SLEEP);

  it("is a block opened with the info string, closed or not yet", () => {
    expect(diagramFence("```" + DIAGRAM_LANG + "\n" + body + "\n```")).toEqual({ body, closed: true });
    expect(diagramFence("```" + DIAGRAM_LANG + "\n" + body)).toEqual({ body, closed: false });
    expect(diagramFence("```" + DIAGRAM_LANG)).toEqual({ body: "", closed: false });
    expect(diagramFence("~~~~" + DIAGRAM_LANG + "  \n" + body + "\n~~~~")).toEqual({ body, closed: true });
  });

  it("is read the same with Windows line endings", () => {
    const pretty = JSON.stringify(SLEEP, null, 2);
    const block = ("```" + DIAGRAM_LANG + "\n" + pretty + "\n```").replace(/\n/g, "\r\n");
    const read = diagramFence(block);
    expect(read?.closed).toBe(true);
    expect(parseDiagram(read!.body)).toEqual(SLEEP);
    // Still open while its closer has not arrived, `\r` or not.
    const open = diagramFence(block.slice(0, block.lastIndexOf("```")));
    expect(open?.closed).toBe(false);
    expect(partialRows(open!.body)).toEqual(SLEEP.rows);
  });

  it("is closed only by its own kind of fence, at least as long", () => {
    expect(diagramFence("````" + DIAGRAM_LANG + "\n" + body + "\n```")?.closed).toBe(false);
    expect(diagramFence("```" + DIAGRAM_LANG + "\n" + body + "\n~~~")?.closed).toBe(false);
  });

  it("is no other block", () => {
    expect(diagramFence("A paragraph about " + DIAGRAM_LANG)).toBeNull();
    expect(diagramFence("```json\n" + body + "\n```")).toBeNull();
    expect(diagramFence("```" + DIAGRAM_LANG + " extra\n" + body + "\n```")).toBeNull();
    expect(diagramFence("```" + DIAGRAM_LANG + "x\n" + body + "\n```")).toBeNull();
    expect(diagramFence("")).toBeNull();
    // Words after the closer make it more than a diagram's block.
    expect(diagramFence("```" + DIAGRAM_LANG + "\n" + body + "\n```\nand more")).toBeNull();
  });
});

describe("the rows written so far while a block is still being written", () => {
  const body = JSON.stringify(SLEEP, null, 2);

  it("grows a node at a time and ends at the diagram", () => {
    const shapes = new Set<string>();
    let last = 0;
    for (let cut = 0; cut <= body.length; cut += 1) {
      const rows = partialRows(body.slice(0, cut)) ?? [];
      const nodes = rows.reduce((sum, row) => sum + row.length, 0);
      // Never fewer than before: the height held only ever grows.
      expect(nodes).toBeGreaterThanOrEqual(last);
      last = nodes;
      shapes.add(rows.map((row) => row.length).join("+"));
    }
    expect([...shapes]).toEqual(["", "1", "1+1", "1+2", "1+2+1"]);
    expect(partialRows(body)).toEqual(SLEEP.rows);
  });

  it("holds the last row from its last node, before the row and the fence close", () => {
    // The row closes a few characters before the fence. Held only then, its
    // height would arrive in the same delta as the diagram.
    const lastNode = body.lastIndexOf("}", body.lastIndexOf("}") - 1) + 1;
    expect(body.slice(lastNode).trim()).toBe("]\n  ]\n}");
    expect(partialRows(body.slice(0, lastNode))).toEqual(SLEEP.rows);
    expect(partialRows(body.slice(0, lastNode - 1))).toEqual(SLEEP.rows.slice(0, 2));
  });

  it("is not thrown by a bracket inside a title", () => {
    const tricky = '{"rows":[[{"title":"a ] b [ c \\" ] d"}],[{"title":"next"}';
    expect(partialRows(tricky)).toEqual([[{ title: 'a ] b [ c " ] d' }], [{ title: "next" }]]);
    expect(partialRows(tricky.slice(0, tricky.indexOf("],") + 2))).toEqual([[{ title: 'a ] b [ c " ] d' }]]);
  });

  it("counts only the rows of rows", () => {
    expect(partialRows('{"other":[[{"title":"A"}]],"rows":[[{"title":"B"}]')).toEqual([[{ title: "B" }]]);
    expect(partialRows('{"other":[[{"title":"A"}]]')).toBeNull();
  });

  it("holds nothing once a whole node or row is not a valid one", () => {
    expect(partialRows('{"rows":[[{"title":"A"}],[{"note":"no title"}]')).toBeNull();
    expect(partialRows('{"rows":[[{"title":"A"}],[{"note":"no title"}')).toBeNull();
    expect(partialRows('{"rows":[' + '[{"title":"A"}],'.repeat(DIAGRAM_LIMITS.rows + 1))).toBeNull();
    expect(partialRows('{"rows":[[' + '{"title":"A"},'.repeat(DIAGRAM_LIMITS.nodes + 1))).toBeNull();
    // A row holds nodes and nothing else.
    for (const row of ['["A"', "[[", '[{"title":"A"},"B"', "[]"]) expect(partialRows('{"rows":[' + row), row).toBeNull();
    expect(partialRows('{"rows":[{"title":"A"}')).toBeNull();
  });

  it("never throws, whatever is cut wherever", () => {
    const hostile = ['{"rows":[[{"title":"A","note":{"a":[1,[2,{"b":"]}"}]]}}]]}', "]]]]}}}}", '{"rows":[[{"title":"\\', '"rows":[[{"title":"A"}]]', "[".repeat(5_000)];
    for (const text of hostile) {
      for (let cut = 0; cut <= Math.min(text.length, 80); cut += 1) expect(() => partialRows(text.slice(0, cut))).not.toThrow();
    }
  });

  it("is nothing for a body past the size a diagram can be", () => {
    expect(partialRows('{"rows":[[{"title":"A"}]' + " ".repeat(DIAGRAM_LIMITS.source))).toBeNull();
  });
});

describe("the rules agents are given", () => {
  // The paragraph is written twice, word for word: in the MCP server's
  // instructions and in the host's prompt. Both are read here against what
  // the page actually accepts, so the three cannot drift.
  const inMcp = /^const DIAGRAM_INSTRUCTIONS = '([^'\n]+)';$/m.exec(mcp)?.[1] ?? "";
  const inHost = /const DIAGRAM_PROMPT: &str = r#"([^\n]+)"#;/.exec(host)?.[1] ?? "";

  it("are the same words in both places", () => {
    expect(inMcp.length).toBeGreaterThan(200);
    expect(inHost).toBe(inMcp);
  });

  it("name the info string, the limits and every icon the page draws", () => {
    expect(inMcp).toContain(`info string ${DIAGRAM_LANG} `);
    expect(inMcp).toContain(
      `Limits: ${DIAGRAM_LIMITS.rows} rows, ${DIAGRAM_LIMITS.nodes} nodes a row, title ${DIAGRAM_LIMITS.title} characters, note ${DIAGRAM_LIMITS.note}.`,
    );
    expect(inMcp).toContain(`Icons: ${DIAGRAM_ICONS.join(", ")}.`);
  });

  it("give an example the page reads once it is filled in", () => {
    const example = /whose body is JSON (\{.*?\}\]\]\})\./.exec(inMcp)?.[1] ?? "";
    expect(parseDiagram(example.replace('"icon":"..."', '"icon":"moon"'))).toEqual({
      rows: [[{ title: "...", note: "...", icon: "moon", plain: true }]],
    });
  });

  it("say when to draw one, and how many", () => {
    expect(inMcp).toMatch(/only when a relation or a flow is clearer as a picture than as a sentence, never by default, and at most one per reply\.$/);
  });
});
