// What an `ask_user` question shows, drawn where it was asked and on the
// line that keeps the answer. The question and the line are the ones the
// host's own test recorded (`__fixtures__/host/question_media_*.json`).
import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

vi.mock("./Thumb", () => ({ SentFiles: () => null }));
vi.mock("../lib/bridge", () => ({
  bridge: { invoke: async () => [], fetchFile: async () => new Blob(), fileUrl: (path: string) => `/file?path=${path}` },
}));
vi.mock("../lib/pathStore", () => ({ knownPath: () => undefined, askPaths: () => {}, subscribePaths: () => () => {} }));

import sheet from "./InlineQuestions.css?raw";
import source from "./QuestionMedia.tsx?raw";
import { hostFacts } from "../lib/__fixtures__/hostFacts";
import { emptyChat, reduceChat, type Block, type Message } from "../lib/chat";
import { readQuestionAnswered, type Question } from "../lib/question";
import { answeredItems } from "../lib/questionBlock";
import { ChatQuestionsContext } from "./InlineQuestions";
import { MessageList } from "./MessageList";
import { FoldedMedia, MediaStrip } from "./QuestionMedia";

const ASK = "mcp__octiq__ask_user";
const pending = hostFacts.questionMediaPending();
const line = hostFacts.questionAnsweredMedia();
const reply = (id: string, blocks: Block[]): Message => ({ id, role: "assistant", blocks, streaming: false });
/** The call as the agent made it: paths, which the host snapshots. */
const call = (result?: string): Block => ({
  kind: "tool", id: "t1", name: ASK, argsJson: "{}", result, state: result === undefined ? "running" : "done",
  args: { question: pending.question, media: [{ path: "/abs/home.png" }, { path: "/abs/take.mp4" }], options: [{ label: "Keep", image: "/abs/face.png" }, "Change"] },
}) as Block;

const chat = (messages: Message[], questions: Question[] = []) => renderToStaticMarkup(
  <ChatQuestionsContext.Provider value={{ questions, onDone: () => {} }}>
    <MessageList messages={messages} busy={false} conversationId="c1" />
  </ChatQuestionsContext.Provider>,
);

describe("media under a pending question", () => {
  const html = chat([reply("m1", [call()])], [pending]);
  const block = html.slice(html.indexOf('class="qa-block'));

  it("is a strip under the question's heading, above its options", () => {
    expect(block).toContain('class="qa-media"');
    expect(block.indexOf("qa-q-title")).toBeLessThan(block.indexOf('class="qa-media"'));
    expect(block.indexOf('class="qa-media"')).toBeLessThan(block.indexOf('class="qa-rows"'));
    expect(block).toContain('aria-label="1 image, 1 video"');
  });

  it("draws a picture as a button that opens it, in a box of its own size before anything arrives", () => {
    expect(block).toMatch(/<button type="button" class="qa-media-box is-image" title="home.png: see it full size" aria-label="See home.png full size">/);
    // Not fetched until it is near: the box is there, the picture is not.
    expect(block).not.toMatch(/<img[^>]*src=/);
  });

  it("draws a video in a box of a fixed shape, its player only once it is near", () => {
    expect(block).toContain('<span class="qa-media-box is-video">');
    expect(block).not.toContain("<video");
  });

  it("says the caption and the name in words", () => {
    expect(block).toContain('<span class="qa-media-caption">The home screen today</span>');
    expect(block).toContain("home.png · 316 B");
    expect(block).toContain("take.mp4 · 4 KB");
  });

  it("puts an option's picture inside its row, and the control that opens it beside the label", () => {
    const wrap = block.slice(block.indexOf('class="qa-row-wrap'), block.indexOf("Change"));
    const label = wrap.slice(wrap.indexOf("<label"), wrap.indexOf("</label>"));
    expect(label).toContain('class="qa-row-shot"');
    expect(label).toContain(">Keep<");
    // Nothing that opens a picture is inside the label, so it selects nothing.
    expect(label).not.toContain("<button");
    expect(wrap.slice(wrap.indexOf("</label>"))).toMatch(/<button type="button" class="qa-row-zoom" aria-label="See the picture for this option full size: face.png"/);
  });

  it("leaves the row with no picture as it was", () => {
    expect(block).toMatch(/<label class="qa-row"><input type="radio"[^>]*\/><span class="qa-mark" aria-hidden="true"><\/span><span class="qa-row-copy"><span class="qa-row-label">Change<\/span>/);
    expect(block.match(/qa-row-wrap/g)).toHaveLength(1);
  });

  it("keeps the block's rules: the recommended row selected, the button on, nothing focused, nothing folded", () => {
    expect(block.match(/checked=""/g)).toHaveLength(1);
    expect(block).toMatch(/class="qa-submit" aria-disabled="false">Send answer</);
    expect(block).not.toMatch(/autofocus|aria-expanded|<details/i);
  });

  it("still draws a question whose media will not read", () => {
    const broken = { ...pending, media: [{ kind: "image" }, "x"] } as unknown as Question;
    const drawn = chat([reply("m1", [call()])], [broken]);
    expect(drawn).toContain(pending.question);
    expect(drawn).not.toContain('class="qa-media"');
  });
});

describe("media on the answered line", () => {
  const answered = readQuestionAnswered(line)!;

  it("is folded: small thumbnails, the count, and the line's one disclosure", () => {
    const state = reduceChat({ ...emptyChat(), messages: [reply("m1", [{ kind: "text", text: "Before I start." }])] }, line as Parameters<typeof reduceChat>[1]);
    const html = renderToStaticMarkup(<MessageList messages={state.messages} busy={false} />);
    const asked = html.slice(html.indexOf('class="qa-asked"'), html.indexOf('class="qa-said"'));
    expect(asked).toContain('class="card-fold-line qa-media-line"');
    expect(asked.match(/class="qa-thumb is-image"/g)).toHaveLength(2);
    expect(asked).toMatch(/class="qa-thumb is-named" title="take.mp4"><svg[^>]*>.*?<\/svg><span class="qa-thumb-name">take.mp4<\/span>/);
    expect(asked).toContain(">2 images, 1 video<");
    expect(asked.match(/aria-expanded/g)).toHaveLength(1);
    expect(asked).toContain('aria-expanded="false"');
    // The full media is behind it, not drawn.
    expect(asked).not.toContain("qa-media-opened");
    expect(asked).not.toContain('class="qa-media"');
  });

  it("opens to each file whole, the chosen option's picture said as chosen", () => {
    const html = renderToStaticMarkup(<FoldedMedia items={answeredItems(answered)} startOpen />);
    expect(html).toContain('aria-expanded="true"');
    expect(html).toContain('class="qa-media"');
    expect(html.match(/class="qa-media-item/g)).toHaveLength(3);
    expect(html).toContain('<span class="qa-media-option">Chosen · Keep</span>');
  });

  it("is drawn at the call when the line is the call's, from the call's own result too", () => {
    const state = reduceChat({ ...emptyChat(), messages: [reply("m1", [call("Keep")])] }, line as Parameters<typeof reduceChat>[1]);
    const html = chat(state.messages);
    // The line draws nothing where it stands: the call draws it, once.
    expect(html).not.toContain(`data-answered="${line.id}"`);
    expect(html.match(/class="qa-asked"/g)).toHaveLength(1);
    expect(html.match(/qa-media-line/g)).toHaveLength(1);
    expect(html.match(/class="qa-thumb is-image"/g)).toHaveLength(2);
  });

  it("draws nothing for questions that showed nothing", () => {
    expect(renderToStaticMarkup(<FoldedMedia items={[{ question: "Which?" }]} />)).toBe("");
    expect(renderToStaticMarkup(<MediaStrip media={[]} />)).toBe("");
  });
});

describe("the strip's sheet", () => {
  it("gives every box its size before anything arrives", () => {
    const rule = (selector: string) => sheet.match(new RegExp(`${selector.replace(/[.]/g, "\\.")} \\{([^}]*)\\}`))?.[1] ?? "";
    expect(rule(".qa-media-box.is-image")).toMatch(/width: 168px;[\s\S]*height: 112px;/);
    expect(rule(".qa-media-box.is-video")).toMatch(/aspect-ratio: 16 \/ 9;/);
    expect(rule(".qa-media-box.is-audio")).toMatch(/height: 40px;/);
    expect(rule(".qa-row-shot")).toMatch(/width: 64px;[\s\S]*height: 64px;/);
    expect(rule(".qa-thumb")).toMatch(/height: 28px;/);
  });

  it("has no colour of its own", () => {
    const media = sheet.slice(sheet.indexOf("What a question shows"), sheet.indexOf("The one button"));
    expect(media).not.toMatch(/#[0-9a-f]{3,8}\b|rgb\(|hsl\(|--accent|--warn|--danger|--decide/i);
  });

  it("fetches pictures as blobs and points players at /file, never the other way round", () => {
    expect(source).toMatch(/bridge\.fetchFile\(path\)/);
    expect(source).not.toMatch(/<img src=\{bridge/);
    expect(source).toMatch(/preload="metadata"/g);
  });
});
