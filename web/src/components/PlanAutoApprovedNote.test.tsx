import { describe, expect, it, vi } from "vitest";
vi.mock("../lib/bridge", () => ({ bridge: { invoke: async () => [], on: () => () => {} } }));
import { renderToStaticMarkup } from "react-dom/server";
import { emptyChat, reduceChat } from "../lib/chat";
import { readPlanAutoApproved } from "../lib/planAutoApproved";
import { PlanAutoApprovedNote } from "./PlanAutoApprovedNote";
import { MessageList } from "./MessageList";
import { conversationMapTurns } from "./ConversationMap";
const event = { type: "octiq_plan_auto_approved", runId: "run_one", revision: 7, taskIds: ["a", "b", "c"],
  taskTitles: ["First task whole title", "Second <task>", "最后一个 task\nwith a second line"], at: 1234, enabledAt: 1200 };

describe("the host's automatic plan approval record", () => {
  it("reads once per run/revision, without becoming a person's turn", () => {
    const first = reduceChat(emptyChat(), event);
    expect(first.messages).toHaveLength(1);
    expect(reduceChat(first, event)).toBe(first);
    expect(first.messages[0].role).toBe("assistant");
    expect(conversationMapTurns([first.messages])).toEqual([]);
    const html = renderToStaticMarkup(<MessageList messages={first.messages} busy={false} />);
    expect(html).toContain("Plan auto-approved · revision 7 · 3 tasks");
    expect(html).not.toContain('class="msg-role"');
    expect(html).not.toContain('class="msg-actions"');
    expect(html).not.toContain('aria-label="Edit');
    expect(html).not.toContain('aria-label="Retry');
  });
  it("arrives folded and opens all task titles with the shared CardFold", () => {
    const record = readPlanAutoApproved(event)!;
    const shut = renderToStaticMarkup(<PlanAutoApprovedNote record={record} />);
    expect(shut).toContain('aria-expanded="false"');
    expect(shut).not.toContain("First task whole title");
    const open = renderToStaticMarkup(<PlanAutoApprovedNote record={record} startOpen />);
    expect(open).toContain('aria-expanded="true"');
    expect(open).toContain("First task whole title");
    expect(open).toContain("Second &lt;task&gt;");
    expect(open).toContain("最后一个 task\nwith a second line");
  });
  it("keeps revisions distinct and ignores malformed records", () => {
    expect(reduceChat(reduceChat(emptyChat(), event), { ...event, revision: 8 }).messages).toHaveLength(2);
    expect(readPlanAutoApproved({ ...event, runId: "" })).toBeNull();
    expect(readPlanAutoApproved({ ...event, taskTitles: [null] })).toBeNull();
  });
});
