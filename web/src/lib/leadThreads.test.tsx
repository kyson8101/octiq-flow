import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { AgentRosterContext } from "./agentRoster";
import { fromIndex } from "./notificationOpen";
import { sameIndex, type Conversation } from "./store";
import type { PendingAction } from "./pendingActions";
import { leadRowStatus, leadThreadAgent, leadsOnlyMode, newConversationLead, type LeadThread } from "./leadThreads";
import { openLeadThread, readLeadHistory } from "./leadThreadFeed";
import { Sidebar } from "../components/Sidebar";
import { LeadHistoryList } from "../components/LeadHistory";
import { lf } from "./sourceText";
import appRaw from "../App.tsx?raw";

const invoke = vi.hoisted(() => vi.fn());
vi.mock("./bridge", () => ({ bridge: { invoke } }));
const threads: LeadThread[] = [
  { agentId: "head", name: "OCTIQ HEAD", chatKey: "chat:lead-head", cwd: "/repo", exists: true },
  { agentId: "star", name: "STAR LEAD", chatKey: "chat:lead-star", cwd: "/star", project: "star", exists: false },
];
const chat = (id = "lead-head", extra: Partial<Conversation> = {}): Conversation => ({ id, projectId: "general", title: "Saved title", messages: [], createdAt: 1, updatedAt: 3, readAt: 1, ...extra });
const sidebar = (leadsOnly: boolean, leads: readonly LeadThread[] | null = threads, freshness: "host" | "cached" = "host") => renderToStaticMarkup(
  <AgentRosterContext.Provider value={[{ id: "head", name: "OCTIQ HEAD", avatar: "data:image/png;base64,face" }]}>
    <Sidebar leadsOnly={leadsOnly} leadReading={{ threads: leads, error: null, freshness }} projects={[]} shelved={[]}
      conversations={[chat(), chat("old-request", { title: "Request conversation" }), chat("orch-worker", { title: "Worker conversation" })]}
      currentConversation={null} busy={new Set()} running={new Set()} onNewChat={() => {}} onPickConversation={() => {}}
      onDelete={() => {}} onPin={() => {}} onRename={() => {}} onToggleDone={() => {}} onSearch={() => {}} />
  </AgentRosterContext.Provider>,
);

describe("lead navigation", () => {
  it("paints cached rows normally but names why their actions wait", () => {
    const cached = sidebar(true, threads, "cached");
    expect(cached).toContain('class="lead-row"');
    expect(cached).toContain('aria-disabled="true"');
    expect(cached).toContain('aria-description="Checking with the server"');
    expect(cached).toContain('title="Checking with the server"');
    expect(cached).toContain("OCTIQ HEAD");
    expect(sidebar(true)).not.toContain('aria-disabled="true"');
  });
  it.each([[false, "tasks", false], [false, "agents", false], [true, "tasks", false], [true, "agents", true]] as const)("Agents mode %s / orientation %s => leads only %s", (enabled, orientation, expected) => {
    expect(leadsOnlyMode(enabled, orientation)).toBe(expected);
    expect(sidebar(leadsOnlyMode(enabled, orientation)).includes('class="lead-row"')).toBe(expected);
  });
  it("replaces chats with lead faces/names in Agents, keeps search, and holds loading space", () => {
    const agents = sidebar(true);
    expect(agents).toContain('aria-label="Talk to OCTIQ HEAD, 1 unread"');
    expect(agents).toContain("data:image/png;base64,face");
    expect(agents).toContain("STAR LEAD");
    expect(agents).toContain("Search chats");
    expect(agents).not.toContain("Request conversation");
    expect(agents).not.toContain("Worker conversation");
    const loading = sidebar(true, null);
    expect(loading).toContain('class="sidebar-leads"');
    expect(loading).toContain('aria-busy="true"');
    expect(loading).not.toContain("Request conversation");
  });
  it("leaves Tasks orientation's chat list and filters in place", () => {
    const tasks = sidebar(false);
    expect(tasks).toContain("Request conversation");
    expect(tasks).toContain("Show chats: Active");
    expect(tasks).not.toContain('class="lead-row"');
    expect(tasks).not.toContain("Worker conversation");
  });
  it("reads busy, waiting and unread from shared App readings, with waits taking precedence", () => {
    const c = chat();
    expect(leadRowStatus(c, null, new Set([c.id]), new Map(), [])).toEqual({ needsYou: false, working: true, unread: 1 });
    expect(leadRowStatus(c, c.id, new Set([c.id]), new Map([[c.id, "answer"]]), [])).toEqual({ needsYou: true, working: false, unread: 0 });
    expect(leadRowStatus(c, null, new Set([c.id]), new Map([[c.id, "unknown"]]), []).working).toBe(false);
    expect(leadRowStatus(c, null, new Set([c.id]), new Map(), [{ kind: "plan" } as PendingAction]).needsYou).toBe(true);
    expect(leadRowStatus(chat(c.id, { readAt: 4 }), null, new Set(), new Map(), []).unread).toBe(0);
  });
  it("New conversation chooses team_head even when another lead sorts first", async () => {
    const target = newConversationLead([...threads].reverse(), "head");
    expect(target?.agentId).toBe("head");
    invoke.mockResolvedValue({ id: "lead-head" });
    await openLeadThread(target!.agentId);
    expect(invoke).toHaveBeenLastCalledWith("lead_thread_open", { agentId: "head" });
    expect(newConversationLead([], "head")).toBe(null);
  });
  it("opens History chats normally by their exact chatKey and carries the done tick", async () => {
    const entry = { chatKey: "chat:old-request", title: "Earlier request", updatedAt: 3, done: true };
    invoke.mockResolvedValue([entry]);
    expect(await readLeadHistory("head")).toEqual([entry]);
    expect(invoke).toHaveBeenLastCalledWith("lead_history", { agentId: "head" });
    const onOpen = vi.fn();
    const list = LeadHistoryList({ entries: [entry], onOpen });
    list.props.children[0].props.children.props.onClick();
    expect(onOpen).toHaveBeenCalledWith(entry);
    const html = renderToStaticMarkup(list);
    expect(html).toContain("Earlier request");
    expect(html).toContain('aria-label="Done"');
    expect(html).toContain("<time");
  });
  it("keeps leadOf through index conversion and compares it as host metadata", () => {
    const entry = { ...chat(), leadOf: "head", pinned: false, sessionId: null, modelId: null, access: null };
    const converted = fromIndex(entry);
    expect(converted.leadOf).toBe("head");
    expect(leadThreadAgent(converted)).toBe("head");
    expect(leadThreadAgent(chat())).toBe("head");
    expect(leadThreadAgent(chat("ordinary"))).toBe(null);
    expect(sameIndex([chat("ordinary")], [chat("ordinary", { leadOf: "head" })])).toBe(false);
  });
  it("guards Complete/Delete on every thread and adds History using act", () => {
    const app = lf(appRaw);
    expect(app).toContain('!threadAgentId && completeChatAction.shown && act("complete"');
    expect(app).toContain('!threadAgentId && !workerChat && act("delete"');
    expect(app).toContain('threadAgentId && act("history", 55, <LeadHistoryButton');
    expect(app).toContain('historyReturn?.chatId === conversationId && act("lead-back"');
    expect(app).toContain('const scheduling = useAgentLanes()');
  });
});
