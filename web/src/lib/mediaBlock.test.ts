import { describe, expect, it } from "vitest";
import hostRaw from "../../../src-tauri/src/agent_provider.rs?raw";
import mcpRaw from "../../../scripts/mcp/octiq-ask.cjs?raw";
import { lf } from "./sourceText";
import { MEDIA_LANG, MEDIA_LIMITS, mediaBlock, mediaFence, parseMediaBlock, partialMedia } from "./mediaBlock";

const host = lf(hostRaw);
const mcp = lf(mcpRaw);

const data = { path: "/abs/picture.png", title: "A design", text: "Why this works", caption: "The home screen" };
const json = JSON.stringify;
const fence = (body: string) => `\`\`\`${MEDIA_LANG}\n${body}\n\`\`\``;

describe("one media block", () => {
  it.each([["png", "image"], ["MP4", "video"], ["m4a", "audio"], ["wav", "audio"], ["webm", "video"]])("infers %s", (ext, kind) => {
    expect(parseMediaBlock(json({ ...data, path: `/abs/file.${ext}` }))).toEqual({ ...data, path: `/abs/file.${ext}`, kind });
  });
  it("accepts minimal input, line endings, Unicode and explicit matching kind", () => {
    expect(parseMediaBlock(json({ path: "/a.png", text: "Line one\r\nLine two 😀", kind: "image" }))).toEqual({ path: "/a.png", text: "Line one\r\nLine two 😀", kind: "image" });
    expect(parseMediaBlock(json({ path: "C:\\art\\file.png", text: "Windows" }))?.kind).toBe("image");
    expect(parseMediaBlock(json({ path: "\\\\server\\share\\file.mp4", text: "UNC" }))?.kind).toBe("video");
  });
  it.each([null, [], [data], "x", 1, true, {}, { ...data, path: ["/a.png", "/b.png"] },
    { ...data, paths: ["/a.png"] }, { ...data, secondPath: "/b.png" }, { ...data, kind: "pdf" },
    { ...data, kind: "video" }, { ...data, title: 1 }, { ...data, caption: null }, { ...data, text: {} },
    { ...data, text: "  " }, { ...data, path: "/a.pdf" }, { ...data, path: "a.png" },
    { ...data, path: "https://site/a.png" }, { ...data, path: "file:///a.png" },
    { ...data, path: "/a\n.png" }, { ...data, text: "\u0000" }, { ...data, media: data },
  ])("rejects invalid shape %j", (value) => expect(parseMediaBlock(json(value))).toBeNull());
  it("rejects duplicate or escaped duplicate path keys instead of picking one", () => {
    expect(parseMediaBlock('{"path":"/a.png","path":"/b.png","text":"x"}')).toBeNull();
    expect(parseMediaBlock('{"path":"/a.png","pa\\u0074h":"/b.png","text":"x"}')).toBeNull();
    expect(parseMediaBlock(json({ ...data, text: 'A string naming "path": is still text' }))).not.toBeNull();
  });
  it.each(["title", "text", "caption", "path"] as const)("refuses %s over its limit, never truncates", (key) => {
    const limit = MEDIA_LIMITS[key];
    const value = key === "path" ? "/" + "a".repeat(limit - 5) + ".png" : "😀".repeat(limit);
    expect(parseMediaBlock(json({ ...data, [key]: value }))).not.toBeNull();
    expect(parseMediaBlock(json({ ...data, [key]: value + "a" }))).toBeNull();
  });
  it("refuses malformed or oversized input before parsing", () => {
    for (const input of ["", "{", json(data) + "x", "[".repeat(20_000), " ".repeat(MEDIA_LIMITS.source + 1)]) expect(parseMediaBlock(input)).toBeNull();
  });
});

describe("the fence while streaming", () => {
  it("requires its own complete fence and supports tilde fences and CRLF", () => {
    expect(mediaBlock(fence(json(data)), false)).toEqual({ kind: "media", media: { ...data, kind: "image" } });
    expect(mediaFence(`  ~~~~octiq-media\r\n${json(data)}\r\n  ~~~~~\r\n`)).toEqual({ body: json(data) + "\r", closed: true });
    for (const block of ["```other\nx\n```", fence(json(data)) + "\nafter", "```octiq-media extra\n{}\n```", fence("{}")]) expect(mediaBlock(block, false)).toBeNull();
  });
  it("stays one pending block at every cut, draws only after closing, falls back when stopped", () => {
    const body = json(data);
    for (let cut = 0; cut <= body.length; cut++) expect(mediaBlock(`\`\`\`${MEDIA_LANG}\n${body.slice(0, cut)}`, true)?.kind).toBe("pending");
    expect(mediaBlock(`\`\`\`${MEDIA_LANG}\n${body}\n\`\``, true)?.kind).toBe("pending");
    expect(mediaBlock(`\`\`\`${MEDIA_LANG}\n${body}`, false)).toBeNull();
    expect(mediaBlock(fence("{}"), true)).toBeNull();
  });
  it("reserves the current words as they arrive, and the exact final layout before the fence closes", () => {
    expect(partialMedia('{"path":"/a.png","text":"Two lines\\nAnd')).toMatchObject({ path: "/a.png", text: "Two lines\nAnd" });
    expect(partialMedia(json(data))).toEqual({ ...data, kind: "image" });
    for (const tail of ["\\", "\\u", "\\u00"]) expect(() => partialMedia('{"text":"x' + tail)).not.toThrow();
    expect(partialMedia(" ".repeat(MEDIA_LIMITS.source + 1))).toBeNull();
  });
});

describe("the instructions match the reader", () => {
  const inMcp = /^const MEDIA_INSTRUCTIONS = '([^'\n]+)';$/m.exec(mcp)?.[1] ?? "";
  const inHost = /const MEDIA_PROMPT: &str = r#"([^\n]+)"#;/.exec(host)?.[1] ?? "";
  it("uses identical words in Rust and MCP", () => { expect(inMcp.length).toBeGreaterThan(200); expect(inHost).toBe(inMcp); });
  it("names the format, one file, limits, and restrained use", () => {
    expect(inMcp).toContain(`info string ${MEDIA_LANG} `);
    expect(inMcp).toContain(`Limits: title ${MEDIA_LIMITS.title} characters, text ${MEDIA_LIMITS.text}, caption ${MEDIA_LIMITS.caption}.`);
    expect(inMcp).toContain("One local absolute path to an image, video or audio file");
    expect(inMcp).toContain("never by default, and at most a few per reply");
    const example = /whose body is JSON (\{.*?\})\./.exec(inMcp)?.[1] ?? "";
    expect(parseMediaBlock(example)).not.toBeNull();
  });
});
