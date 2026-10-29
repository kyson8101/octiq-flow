import { expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
vi.mock("../lib/bridge", () => ({ bridge: { invoke: async () => [], on: () => () => {} } }));
vi.mock("./Thumb", () => ({ SentFiles: () => null }));
import captured from "../lib/__fixtures__/host-notifications.jsonl?raw";
import { emptyChat, reduceChat, type Message } from "../lib/chat";
import { AgentRosterContext, ChatPersonaContext } from "../lib/agentRoster";
import { MessageList } from "./MessageList";
import { conversationMapTurns } from "./ConversationMap";
import { foldNoticeReplies } from "../lib/hostNotice";
import { HostNotice } from "./HostNotice";
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
  expect(html).not.toContain("&gt;&gt;&gt;");
  expect(html).toContain('class="host-notice-arrow"');
  expect(html).toContain("OCTIQ BE to OCTIQ HEAD, status: 方向已修正，验证进行中");
  expect(html).toContain('class="host-notice-sender">OCTIQ HEAD</span>');
  expect(html).toContain('class="host-notice-reply-text">检查已完成，等待其余结果。</span>');
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
  expect(sheet).not.toMatch(/var\(--(?:accent|decide)/);
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


it.each(["status", "reply", "question", "instruction", "escalation", "report", "failure", "capacity", "unknown", "future-kind"])("names %s in words while keeping its icon decorative", (kind) => {
  const html = renderToStaticMarkup(<HostNotice notices={[{ id: `kind-${kind}`, kind, subject: "Build passed", from: "chat:fe", body: "Body stays behind disclosure", text: "Host envelope" }]} coordinator="OCTIQ HEAD" nameOf={() => ({ name: "OCTIQ FE", id: "agent-fe", avatar: "data:image/png;base64,face" })} />);
  expect(html).toContain(`aria-label="OCTIQ FE to OCTIQ HEAD, ${kind}: Build passed"`);
  expect(html).toContain(`class="host-notice-kind host-notice-kind-${kind === "future-kind" ? "unknown" : kind}"`);
  expect(html).toMatch(/class="host-notice-kind[^>]+aria-hidden="true"/);
  expect(html).toContain('class="agent-avatar has-image"');
  expect(html).toContain('--agent-avatar-size:16px');
  expect(html).not.toContain("Body stays behind disclosure");
  expect(html).not.toContain("Host envelope");
});

it("uses neutral fallbacks for unknown senders and the coordinator's registered face on its reply", () => {
  const html = renderToStaticMarkup(<AgentRosterContext.Provider value={[{ id: "head", name: "OCTIQ HEAD", avatar: "data:image/png;base64,head" }]}><HostNotice notices={[{ id: "unknown", kind: "status", subject: "Update", from: "missing", body: "Body", text: "Raw" }, { id: "host", kind: "report", subject: "Done", body: "Body", text: "Raw" }]} coordinator="OCTIQ HEAD" nameOf={() => null} reply="Checked." /></AgentRosterContext.Provider>);
  expect(html).toContain('aria-label="Worker to OCTIQ HEAD, status: Update"');
  expect(html).toContain('aria-label="Host to OCTIQ HEAD, report: Done"');
  expect(html.match(/class="host-notice-face"/g)).toHaveLength(2);
  expect(html).toContain('src="data:image/png;base64,head"');
  expect(html).toContain('class="host-notice-reply-text">Checked.</span>');
});

it("reserves danger and warning ink for failure, escalation and capacity icons", () => {
  const coloured = [...sheet.matchAll(/([^{}]+)\{[^{}]*color: var\(--(danger|warn)\);[^{}]*\}/g)]
    .map((match) => [match[1].trim(), match[2]]);
  expect(coloured).toEqual([
    [".host-notice-kind-failure", "danger"],
    [".host-notice-kind-escalation, .host-notice-kind-capacity", "warn"],
  ]);
  expect(sheet).toContain(".host-notice-toggle:focus-visible");
  expect(sheet).toContain("min-height: 32px");
});
