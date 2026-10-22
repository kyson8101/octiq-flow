import { expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
vi.mock("../lib/bridge", () => ({ bridge: { invoke: async () => [], on: () => () => {} } }));
vi.mock("./Thumb", () => ({ SentFiles: () => null }));
import captured from "../lib/__fixtures__/host-notifications.jsonl?raw";
import { emptyChat, reduceChat, type Message } from "../lib/chat";
import { ChatPersonaContext } from "../lib/agentRoster";
import { MessageList } from "./MessageList";
import { conversationMapTurns } from "./ConversationMap";
import { foldNoticeReplies } from "../lib/hostNotice";
import sheet from "./HostNotice.css?raw";

const events = captured.trim().split("\n").map((line) => JSON.parse(line));
const notice = (index: number) => reduceChat(emptyChat(), events[index]).messages[0];
const reply: Message = { id: "a", role: "assistant", streaming: false, blocks: [{ kind: "text", text: "检查已完成，等待其余结果。" }] };
const draw = (messages: Message[]) => renderToStaticMarkup(<ChatPersonaContext.Provider value={() => ({ name: "OCTIQ BE" })}>
  <MessageList messages={messages} busy={false} hostPersona={{ name: "OCTIQ HEAD" }} /></ChatPersonaContext.Provider>);

it("draws one shut button per notice and the whole short reply without a disclosure", () => {
  const html = draw([notice(2), reply]);
  expect(html.match(/class="host-notice-toggle"/g)).toHaveLength(2);
  expect(html.match(/aria-expanded="false"/g)).toHaveLength(2);
  expect(html).toContain("OCTIQ BE");
  expect(html).toContain("&gt;&gt;&gt;");
  expect(html).toContain("OCTIQ HEAD: 方向已修正，验证进行中");
  expect(html).toContain("OCTIQ HEAD: 检查已完成，等待其余结果。");
  expect(html).toContain('class="host-notice-reply"');
  for (const absent of ["msg-user", "message-bubble", "message-delivery", "msg-copy", "data-map-turn="]) expect(html).not.toContain(absent);
});

it("keeps non-status answers and status questions/cards visible", () => {
  expect(draw([notice(1), reply])).toContain("等待其余结果。");
  const html = draw([notice(0), { ...reply, blocks: [...reply.blocks, { kind: "text", text: "要继续吗？" },
    { kind: "text", text: '```octiq-diagram\n{"rows":[[{"title":"Visible card"}]]}\n```' }] }]);
  expect(html).toContain("要继续吗？");
  expect(html).toContain("Visible card");
});

it("keeps notices and their answer out of the person's map points", () => {
  const person: Message = { ...notice(0), id: "person", turnId: "person-1", blocks: [{ kind: "text", text: "My instruction" }] };
  expect(conversationMapTurns([[person], [notice(1)], [reply]])).toEqual([{ id: "person", prompt: "My instruction", reply: "" }]);
  expect(conversationMapTurns(foldNoticeReplies([[notice(0)], [reply]]))).toEqual([]);
});

it("uses neutral ink and real one-line buttons with touch targets", () => {
  expect(sheet).not.toMatch(/var\(--(?:accent|decide|warn|danger)/);
  expect(sheet).toContain("text-overflow: ellipsis");
  expect(sheet).toContain("min-height: 44px");
});

it.each([
  "检查状态已收到。\n\n请选择继续检查或暂停，收到选择后才会继续。",
  "Status received.\n\nPlease choose continue or pause before I proceed.",
])("keeps every paragraph of a choice without a question mark visible: %s", (text) => {
  const html = draw([notice(0), { ...reply, blocks: [{ kind: "text", text }] }]);
  for (const paragraph of text.split("\n\n")) expect(html).toContain(paragraph);
  expect(html).not.toContain('class="host-notice-reply"');
  expect(html).toContain('msg-assistant');
});

it("preserves tool/prose/card boundaries through the normal reply renderer", () => {
  const html = draw([notice(0), { ...reply, blocks: [
    { kind: "tool", id: "read", name: "Read", argsJson: "{}", args: { file_path: "/tmp/check.txt" }, result: "Checked", state: "done" },
    { kind: "text", text: "状态汇总如下。" },
    { kind: "text", text: '```octiq-diagram\n{"rows":[[{"title":"Card stays a card"}]]}\n```' },
  ] }]);
  expect(html).toContain("状态汇总如下。");
  expect(html).toContain("Card stays a card");
  expect(html).toContain('class="dgm"');
  expect(html.indexOf("tool-group")).toBeLessThan(html.indexOf("状态汇总如下。"));
  expect(html.indexOf("状态汇总如下。")).toBeLessThan(html.indexOf("Card stays a card"));
});

it("keeps a 161-character reply on its normal path", () => {
  const text = "a".repeat(161);
  const html = draw([notice(0), { ...reply, blocks: [{ kind: "text", text }] }]);
  expect(html).toContain(text);
  expect(html).not.toContain('class="host-notice-reply"');
});
