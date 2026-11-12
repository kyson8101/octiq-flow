import { describe, expect, it } from "vitest";
import type { Message } from "./chat";
import { hostPreview, latestResponse, plainSnippet, previewMessages, readChatPreview } from "./chatPreview";

const message = (id: string, text: string, extra: Partial<Message> = {}): Message => ({
  id, role: "user", streaming: false, blocks: [{ kind: "text", text }], ...extra,
});

describe("chat preview", () => {
  it("shows the latest three readable messages in order, excluding internal activity", () => {
    const messages = [
      message("old", "Older turn"), message("ask", "What changed?"),
      message("answer", "The sidebar.", { role: "assistant", speaker: { id: "a", name: "Nova", agent: "codex" } }),
      message("child", "Internal report", { parent: "tool-1" }),
      message("relay", "Injected prompt", { relay: "Continue" }),
      message("thinking", "", { blocks: [{ kind: "thinking", text: "Private reasoning" }] }),
      message("last", "Show me."),
    ];
    expect(previewMessages(messages)).toEqual([
      { id: "ask", speaker: "You", text: "What changed?" },
      { id: "answer", speaker: "Nova", text: "The sidebar." },
      { id: "last", speaker: "You", text: "Show me." },
    ]);
  });

  it("bounds long messages without losing the latest turn", () => {
    expect(previewMessages([message("long", "a".repeat(1000))])[0].text).toBe("a".repeat(420) + "…");
  });

  it("finds the latest agent response beyond the three-message preview window", () => {
    const messages = [
      message("answer", "The durable answer", { role: "assistant" }),
      message("u1", "one"), message("u2", "two"), message("u3", "three"),
    ];
    expect(latestResponse(messages)?.text).toBe("The durable answer");
  });

  it("replays the recent server page and preserves imported chats with no server events", async () => {
    const fallback = [message("old", "Old local text")];
    const page = { context: [], before: 10, events: [{ seq: 10, event: {
      type: "user", uuid: "new", octiq_user_turn: true,
      message: { role: "user", content: [{ type: "text", text: "Latest server text" }] },
    } }] };
    const result = await readChatPreview(async () => page, fallback, () => false);
    expect(previewMessages(result)[0].text).toBe("Latest server text");
    expect(fallback[0].blocks).toEqual([{ kind: "text", text: "Old local text" }]);
    expect(await readChatPreview(async () => ({ context: [], events: [], before: null }), fallback, () => false)).toBe(fallback);
  });

  it("discards a response when the pointer has already left", async () => {
    expect(await readChatPreview(async () => ({ context: [], events: [], before: null }),
      [message("old", "Should not appear")], () => true)).toEqual([]);
  });
});

describe("plainSnippet", () => {
  // The rows these come from, as agents actually write them.
  it("drops Markdown markers from a one-line row preview", () => {
    expect(plainSnippet("- **Mango Juice** · octiq-flow project/repository — `feature/octiq-e3e9f701` is ready"))
      .toBe("Mango Juice · octiq-flow project/repository — feature/octiq-e3e9f701 is ready");
    expect(plainSnippet("Reviewed and accepted at `44c1fc0`:\n- Roles show two lines\n- **Toggle** only when clipped"))
      .toBe("Reviewed and accepted at 44c1fc0: Roles show two lines Toggle only when clipped");
    expect(plainSnippet("## Root cause\n\n```rust\nfn alive() {}\n```\nThe `kill -0` probe fails; see *profile_lock.rs*."))
      .toBe("Root cause fn alive() {} The kill -0 probe fails; see profile_lock.rs.");
  });

  it("keeps link and image text but not their addresses", () => {
    expect(plainSnippet("Each has a [role card](https://example.com/roles) and ![a chart](chart.png)."))
      .toBe("Each has a role card and a chart.");
    expect(plainSnippet("See <https://example.com/x>.")).toBe("See https://example.com/x.");
  });

  it("removes emphasis a 420-character cut left unclosed", () => {
    // latestResponse truncates mid-sentence, so the closing ** can be gone.
    expect(plainSnippet("**We fixed a confirmed app defect, but haven't…")).toBe("We fixed a confirmed app defect, but haven't…");
    expect(plainSnippet("```ts\nconst a = 1")).toBe("const a = 1");
  });

  it("leaves ordinary punctuation that only looks like Markdown", () => {
    expect(plainSnippet("snake_case_name and 2 * 3 * 4 stay; __init__.py too")).toBe("snake_case_name and 2 * 3 * 4 stay; __init__.py too");
    expect(plainSnippet("1. First step\n2. Second step")).toBe("1. First step 2. Second step");
    expect(plainSnippet("Costs 5 - 3 = 2, a > b, #42 fixed")).toBe("Costs 5 - 3 = 2, a > b, #42 fixed");
    expect(plainSnippet("Escaped \\*stars\\* stay")).toBe("Escaped *stars* stay");
  });

  it("flattens quotes, rules, task boxes and tables", () => {
    expect(plainSnippet("> Quoted\n\n---\n- [x] Done\n- [ ] Next")).toBe("Quoted Done Next");
    expect(plainSnippet("| Check | Result |\n| --- | :---: |\n| tests | ~~red~~ green |"))
      .toBe("Check · Result tests · red green");
  });
});

describe("hostPreview", () => {
  it("takes the host's text when its version is newer than the row's", () => {
    expect(hostPreview({ latestResponse: "old", latestResponseVersion: 2 }, { latestResponse: "new", latestResponseVersion: 3 }))
      .toEqual({ latestResponse: "new", latestResponseVersion: 3 });
  });
  it("takes the host's text for a row that never heard a version", () => {
    expect(hostPreview({ latestResponse: "local" }, { latestResponse: "host", latestResponseVersion: 1 }))
      .toEqual({ latestResponse: "host", latestResponseVersion: 1 });
  });
  it("keeps a newer row over an out-of-order older index answer", () => {
    expect(hostPreview({ latestResponse: "newer", latestResponseVersion: 5 }, { latestResponse: "older", latestResponseVersion: 4 }))
      .toEqual({ latestResponse: "newer", latestResponseVersion: 5 });
  });
  it("leaves the row as last known for a host that sends no version", () => {
    expect(hostPreview({ latestResponse: "known", latestResponseVersion: undefined }, { latestResponse: undefined }))
      .toEqual({ latestResponse: "known", latestResponseVersion: undefined });
    expect(hostPreview({ latestResponse: "known" }, { latestResponse: "indexed" }))
      .toEqual({ latestResponse: "indexed", latestResponseVersion: undefined });
    expect(hostPreview({ latestResponse: "known", latestResponseVersion: 2 }, { latestResponse: "x", latestResponseVersion: 0 }).latestResponseVersion).toBe(2);
  });
  it("M3: a versionless host row never overwrites a held versioned preview", () => {
    expect(hostPreview({ latestResponse: "held", latestResponseVersion: 10 }, { latestResponse: "VERSIONLESS OLD RESPONSE" }))
      .toEqual({ latestResponse: "held", latestResponseVersion: 10 });
    expect(hostPreview({ latestResponse: "held", latestResponseVersion: 10 }, { latestResponse: "x", latestResponseVersion: 0 }))
      .toEqual({ latestResponse: "held", latestResponseVersion: 10 });
    expect(hostPreview({ latestResponse: "held", latestResponseVersion: 10 }, { latestResponse: "x", latestResponseVersion: Number.NaN }))
      .toEqual({ latestResponse: "held", latestResponseVersion: 10 });
  });
  it("M3: only a row with nothing versioned held takes versionless host text", () => {
    expect(hostPreview(undefined, { latestResponse: "host" })).toEqual({ latestResponse: "host", latestResponseVersion: undefined });
    expect(hostPreview({}, { latestResponse: "host" })).toEqual({ latestResponse: "host", latestResponseVersion: undefined });
  });
  it("M4: a new or equal version with no text is an authoritative empty preview", () => {
    expect(hostPreview({ latestResponse: "old", latestResponseVersion: 10 }, { latestResponseVersion: 11 }))
      .toEqual({ latestResponse: undefined, latestResponseVersion: 11 });
    expect(hostPreview({ latestResponse: "old", latestResponseVersion: 11 }, { latestResponseVersion: 11 }))
      .toEqual({ latestResponse: undefined, latestResponseVersion: 11 });
    expect(hostPreview({ latestResponse: "local" }, { latestResponseVersion: 1 }))
      .toEqual({ latestResponse: undefined, latestResponseVersion: 1 });
  });
  it("M4: an older version with no text is still an out-of-order answer and changes nothing", () => {
    expect(hostPreview({ latestResponse: "fresh", latestResponseVersion: 12 }, { latestResponseVersion: 11 }))
      .toEqual({ latestResponse: "fresh", latestResponseVersion: 12 });
  });
  it("clear then fresh then late: 10 -> 11 cleared -> 12 -> late 10", () => {
    let held = hostPreview(undefined, { latestResponse: "ten", latestResponseVersion: 10 });
    held = hostPreview(held, { latestResponseVersion: 11 });
    expect(held).toEqual({ latestResponse: undefined, latestResponseVersion: 11 });
    held = hostPreview(held, { latestResponse: "twelve", latestResponseVersion: 12 });
    held = hostPreview(held, { latestResponse: "ten", latestResponseVersion: 10 });
    expect(held).toEqual({ latestResponse: "twelve", latestResponseVersion: 12 });
  });
});
