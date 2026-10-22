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
    expect(notice).toEqual([{ id: "octiq-notification-a", kind: "unknown", subject: "update", text: "A new host format with an arbitrarily long body", body: "A new host format with an arbitrarily long body" }]);
    expect(statusOnly(notice)).toBe(false);
    expect(readNoticeTurn("octiq-notification-a|octiq-notification-b", noticeText([read(0).message]))[0].kind).toBe("unknown");
    const batch = read(2).message;
    const malformed = noticeText([batch]).replace("\n\n---\n\n", "\n\n");
    expect(readNoticeTurn(batch.turnId, malformed)).toEqual([{ id: batch.turnId, kind: "unknown", subject: "update", text: malformed, body: malformed }]);
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
      [a.id, "First"], ["Second"], [person.id], ["Person's answer"], [b.id], ["Reply notice's answer"],
    ]);
  });

  it("folds only a whole short plain paragraph, without semantic question guessing", () => {
    expect(noticeReply([reply("检查已完成，等待其余结果。")])).toBe("检查已完成，等待其余结果。");
    expect(noticeReply([reply("继续吗？")])).toBe("继续吗？");
    expect(noticeReply([reply("x".repeat(160))])).toBe("x".repeat(160));
    expect(noticeReply([reply("x".repeat(161))])).toBeNull();
    for (const text of ["状态已收到。\n\n请选择继续检查或暂停，收到选择后才会继续。",
      "Status received.\n\nPlease choose continue or pause before I proceed.",
      "First\nSecond", "- Item", "1. Item", "# Heading", "**Bold**", "[Link](https://example.com)",
      '```octiq-diagram\n{"rows":[[{"title":"Decision"}]]}\n```',
      'visualize{"path":"/tmp/report.html"}']) {
      const message = reply(text);
      expect(noticeReply([message])).toBeNull();
      expect(foldNoticeReplies([[read(0).message], [message]])).toEqual([[read(0).message], [message]]);
    }
  });

  it("leaves tools, events, thinking and progress in their original reply", () => {
    const tool = { kind: "tool", id: "read", name: "Read", argsJson: "{}", args: {}, state: "done" } as const;
    const prose = { kind: "text", text: "状态汇总如下。" } as const;
    const card = { kind: "text", text: '```octiq-diagram\n{"rows":[[{"title":"Decision"}]]}\n```' } as const;
    const message = { ...reply(""), blocks: [tool, prose, card] };
    expect(noticeReply([message])).toBeNull();
    expect(foldNoticeReplies([[read(0).message], [message]])[1]).toBeDefined();
    for (const change of [{ streaming: true }, { progress: ["Checking"] }, { codexCandidate: "Proceed" },
      { blocks: [{ kind: "notice" as const, text: "Waiting for permission" }] },
      { blocks: [{ kind: "thinking" as const, text: "Thinking" }, prose] }, { blocks: [prose, prose] }]) {
      expect(noticeReply([{ ...reply("Done"), ...change }])).toBeNull();
    }
  });

  it("separates message bodies from raw host text, including batch and report footers", () => {
    const notices = read(2).notices;
    expect(notices[0].body).toBe("已反转 gradient 为左淡右实。现有 Usage.test.tsx 对 width:42% 的字符串断言需同步 max(3px, 42%)，已修改。tsc/full Vitest 和 real App screenshot harness 仍运行中；当前机器运行偏慢。");
    expect(notices[1].body).toContain("instructions.test.cjs 8/8 PASS");
    for (const n of notices) {
      expect(n.body).not.toMatch(/OctiqFlow notification|Subject:|From:|This is a batch/);
      expect(n.text).toContain("OctiqFlow notification");
    }
    const state = reduceChat(emptyChat(), JSON.parse(capturedReport.trim()));
    const report = readNoticeTurn(state.messages[0].turnId, noticeText(state.messages))[0];
    expect(report.body).toMatch(/^完成并 commit/);
    expect(report.body).not.toMatch(/Worker reported|Read orchestration_snapshot|This is a batch/);
    expect(report.text).toContain("Read orchestration_snapshot");
  });
});
