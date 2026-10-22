import { describe, expect, it } from "vitest";
import captured from "./__fixtures__/host-notifications.jsonl?raw";
import capturedReport from "./__fixtures__/host-notification-report.jsonl?raw";
import { emptyChat, reduceChat, type Message } from "./chat";
import { foldNoticeReplies, isNoticeTurn, noticeReply, noticeSender, noticeText, noticeTurnId, readNoticeTurn, statusOnly } from "./hostNotice";

// Three verbatim user records from chat_a85a79fc-96a6-405a-bff1-3799433b1c6f,
// 2026-10-22: status, reply, then a two-status batch. No provider re-recording
// or paid calls. Capture by selecting whole JSONL lines with receipt metadata.
export const noticeEvents = captured.trim().split("\n").map((line) => JSON.parse(line));
const read = (index: number) => {
  const state = reduceChat(emptyChat(), noticeEvents[index]);
  const message = state.messages[0];
  return { message, notices: readNoticeTurn(message.turnId, noticeText([message])) };
};
const reply = (text: string): Message => ({ id: text, role: "assistant", streaming: false, blocks: [{ kind: "text", text }] });

describe("host notification reader", () => {
  it("uses only host turn identity, never prose that happens to quote a notice", () => {
    expect(isNoticeTurn("octiq-notification-a|octiq-notification-b")).toBe(true);
    for (const id of [undefined, null, "person-1", "quoted-octiq-notification-a"]) expect(isNoticeTurn(id)).toBe(false);
    expect(readNoticeTurn("person-1", noticeText([read(0).message]))).toEqual([]);
  });

  it("reads captured provider UUID echoes using scalar and batched receipts", () => {
    for (const event of noticeEvents) {
      const receipt = (event.octiq_orchestration_notification_ids ?? [event.octiq_orchestration_notification_id]).join("|");
      expect(noticeTurnId(event)).toBe(receipt);
      const state = reduceChat(emptyChat(), event);
      expect(state.messages[0].turnId).toBe(receipt);
      expect(state.messages[0].echo).toBe(event.uuid);
      expect(reduceChat(state, event)).toBe(state);
    }
    expect(noticeTurnId({ uuid: "octiq-notification-new", octiq_user_turn: true })).toBe("octiq-notification-new");
  });

  it("reads each real notice and preserves every character of its original text", () => {
    const { message, notices } = read(2);
    expect(notices.map(({ kind, subject, from }) => ({ kind, subject, from }))).toEqual([
      { kind: "status", subject: "方向已修正，验证进行中", from: "chat:orch-554f9d02d67f426ea8f06a595e04b3d3" },
      { kind: "status", subject: "MCP 检查通过；Rust 正在首次编译", from: "chat:orch-094a29dfd1064e6c8e3c2b8ee2842ddd" },
    ]);
    expect(notices.map((n) => n.text).join("\n\n---\n\n")).toBe(noticeText([message]));
    expect(statusOnly(notices)).toBe(true);
    expect(statusOnly(read(1).notices)).toBe(false);
    expect(statusOnly([])).toBe(false);
  });

  it("folds unknown/malformed shapes while keeping their answer outside", () => {
    const notice = readNoticeTurn("octiq-notification-a", "A new host format with an arbitrarily long body");
    expect(notice).toEqual([{ id: "octiq-notification-a", kind: "unknown", subject: "update", text: "A new host format with an arbitrarily long body" }]);
    expect(statusOnly(notice)).toBe(false);
    expect(readNoticeTurn("octiq-notification-a|octiq-notification-b", noticeText([read(0).message]))[0].kind).toBe("unknown");
    const batch = read(2).message;
    const malformed = noticeText([batch]).replace("\n\n---\n\n", "\n\n");
    expect(readNoticeTurn(batch.turnId, malformed)).toEqual([{ id: batch.turnId, kind: "unknown", subject: "update", text: malformed }]);
  });

  it("uses registered names, with short identity fallbacks", () => {
    const notice = read(0).notices[0];
    expect(noticeSender(notice, () => ({ name: "OCTIQ FE" }))).toBe("OCTIQ FE");
    expect(noticeSender(notice, () => null)).toBe("Worker");
    expect(noticeSender({ ...notice, from: undefined }, () => null)).toBe("Host");
  });

  it("reads the real worker report as a host report, with its answer left visible", () => {
    const state = reduceChat(emptyChat(), JSON.parse(capturedReport.trim()));
    const message = state.messages[0];
    const notices = readNoticeTurn(message.turnId, noticeText([message]));
    expect(notices).toHaveLength(1);
    expect(notices[0]).toMatchObject({ kind: "report", subject: "report" });
    expect(noticeSender(notices[0], () => null)).toBe("Host");
    expect(statusOnly(notices)).toBe(false);
    expect(foldNoticeReplies([[message], [reply("Report answer")]])).toHaveLength(2);
  });

  it("collects all status output only until the next user or host boundary", () => {
    const a = read(0).message, b = read(1).message;
    const person: Message = { id: "person", role: "user", streaming: false, blocks: [] };
    const turns = [[a], [reply("First")], [reply("Second")], [person], [reply("Person's answer")], [b], [reply("Reply notice's answer")]];
    expect(foldNoticeReplies(turns).map((t) => t.map((m) => m.id))).toEqual([
      [a.id, "First", "Second"], [person.id], ["Person's answer"], [b.id], ["Reply notice's answer"],
    ]);
  });

  it("keeps calls, cards, questions and host events outside the reply fold", () => {
    const tool = { kind: "tool", id: "ask", name: "request_user_input", argsJson: "{}", args: {}, state: "running" } as const;
    const question = { kind: "text", text: "继续吗？" } as const;
    const card = { kind: "text", text: '```octiq-diagram\n{"rows":[[{"title":"Decision"}]]}\n```' } as const;
    const event = { kind: "notice", text: "Waiting for permission" } as const;
    const message = { ...reply("Status done"), blocks: [...reply("Status done").blocks, tool, question, card, event] };
    const result = noticeReply([message]);
    expect(result.visible).toEqual([tool, question, card, event]);
    expect(result.text).toBe(`Status done\n\n继续吗？\n\n${card.text}`);
  });

  it("keeps text that renders interactive controls visible", () => {
    const config = { kind: "text", text: "Usage: /config key=value [key=value ...]\n  theme=auto|dark|light" } as const;
    const visualization = { kind: "text", text: 'visualize{"path":"/tmp/report.html"}' } as const;
    expect(noticeReply([{ ...reply("Settings"), blocks: [config, visualization] }]).visible).toEqual([config, visualization]);
  });

  it("keeps a streaming commentary question visible as well", () => {
    const result = noticeReply([{ ...reply("Done"), progress: ["Checking", "Proceed?"], codexCandidate: "继续吗？" }]);
    expect(result.visible).toEqual([{ kind: "text", text: "Proceed?" }, { kind: "text", text: "继续吗？" }]);
    expect(result.text).toBe("Checking\n\nProceed?\n\n继续吗？\n\nDone");
  });
});
