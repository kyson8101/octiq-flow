// The front desk's screens: its confirm card, the "Talk to someone else"
// list, and its row in Settings. Rendered to static markup (no jsdom).
import { describe, expect, it, vi } from "vitest";

vi.mock("../lib/bridge", () => ({ bridge: { invoke: async () => null } }));
import { renderToStaticMarkup } from "react-dom/server";
import { HandoverCards, HandoverLines } from "./HandoverCards";
import { FrontDeskBlock, RecipientPicker } from "./AgentsSettings";
import { handover } from "../lib/handover.fixture";
import {
  handoverPlaces, handoversFor, isRoute, mergeHandover, routeHeadline, routePlaceLine, type Handover,
} from "../lib/handover";
import { pendingActions } from "../lib/pendingActions";
import type { TeamAgent } from "../lib/agentsMode";

const route = (extra: Partial<Handover> = {}): Handover => handover({
  id: "handover_r1",
  kind: "route",
  sourceChatKey: "chat:desk",
  sourceTitle: "",
  sourceProject: "",
  from: { agentId: "agent_desk", name: "Front desk" },
  to: { agentId: "agent_vesper", name: "Vesper" },
  destination: { projectId: "p-star", projectName: "starfall-novel", repository: "/src/starfall" },
  workspace: { mode: "worktree", path: "/src/starfall", branch: "main", chosen: "new" },
  brief: { objective: "Draft chapter 3: the crossing.\nKeep Lyra's voice; 3,000 words." },
  route: {
    message: "Draft chapter 3: the crossing.\nKeep Lyra's voice; 3,000 words.\n\nAttachments:\n- /h/.octiqflow/attachments/route-handover_r1/map.png (image)\n\n(Opened by Front desk, the person's front desk, once the person confirmed it.)",
    attachments: [{ name: "map.png", path: "/h/.octiqflow/attachments/route-handover_r1/map.png", image: true }],
    unreadable: [{ path: "/etc/hosts", problem: "not a file the person attached in OctiqFlow" }],
  },
  ...extra,
});
const noop = async () => undefined;
const cards = (list: Handover[], chatKey: string) => {
  const { tail, settled, incoming } = handoverPlaces(handoversFor(list, chatKey));
  return {
    tail: renderToStaticMarkup(<HandoverCards outgoing={tail} onDecide={noop} />),
    lines: renderToStaticMarkup(<HandoverLines incoming={incoming} outgoing={settled} onOpen={() => {}} />),
  };
};

describe("the front desk's confirm card", () => {
  it("shows the agent, the project and the whole brief, and creates nothing until the person chooses", () => {
    const { tail: html, lines } = cards([route()], "chat:desk");
    expect(lines).toBe("");
    expect(html).toContain('data-kind="route"');
    expect(html).toContain("Open a chat with Vesper?");
    expect(html).toContain("Sonnet latest · high · Accept edits");
    expect(html).toContain("starfall-novel · new worktree");
    expect(html).toContain("Draft chapter 3: the crossing.\nKeep Lyra&#x27;s voice; 3,000 words.");
    expect(html).toContain("map.png");
    expect(html).toContain("Not passed on: hosts (not a file the person attached in OctiqFlow)");
    // The exact first message, paths and all, is one click away.
    expect(html).toContain("Exact first message");
    expect(html).toContain("route-handover_r1/map.png (image)");
    expect(html).toContain("Nothing opens until you choose.");
    expect(html).toContain("Open chat with Vesper");
    expect(html).toContain(">Cancel<");
    // A hidden chat badges nothing.
    expect(html).not.toContain("data-pending-keys");
  });

  it("offers a retry and, when nothing started, a way to give up", () => {
    const { tail } = cards([route({ status: "starting", targetChatKey: "chat:new", error: "CLI unavailable", abandonable: true })], "chat:desk");
    expect(tail).toContain("Vesper&#x27;s chat did not start");
    expect(tail).toContain("Try again");
    expect(tail).toContain("Give up");
    expect(tail).not.toContain(">Cancel<");
  });

  it("leaves nothing behind once confirmed or cancelled, in either chat", () => {
    const confirmed = route({ status: "confirmed", targetChatKey: "chat:new" });
    expect(cards([confirmed], "chat:desk")).toEqual({ tail: "", lines: "" });
    // The routed chat starts from its own first message, not a handover line.
    expect(cards([confirmed], "chat:new")).toEqual({ tail: "", lines: "" });
    const list = mergeHandover([route()], route({ status: "declined" }));
    expect(list).toEqual([]);
    expect(mergeHandover([], route({ status: "abandoned" }))).toEqual([]);
  });

  it("names where the chat will work, as a person reads it", () => {
    expect(routeHeadline(route({ status: "starting" }))).toBe("Opening a chat with Vesper…");
    expect(routePlaceLine(route({ workspace: { mode: "folder", path: "/g" }, destination: { projectId: "g", projectName: "General", repository: "/g" } }))).toBe("General");
    expect(routePlaceLine(route({ route: { message: "x", crossProject: true }, workspace: { mode: "folder", path: "/g" }, destination: { projectId: "g", projectName: "General", repository: "/g" } })))
      .toBe("General · plans across every project");
    expect(isRoute(route())).toBe(true);
    expect(isRoute(handover())).toBe(false);
  });

  it("never raises a pending-action badge for a route", () => {
    const empty = { runs: [], tasks: [], attempts: [], gates: [], messages: [] };
    const actions = pendingActions({ orchestration: empty, parents: new Map(), handovers: [route()] } as never);
    expect(actions.some((action) => action.kind === "handover")).toBe(false);
    const ordinary = pendingActions({ orchestration: empty, parents: new Map(), handovers: [handover()] } as never);
    expect(ordinary.some((action) => action.kind === "handover")).toBe(true);
  });
});

const agent = (id: string, over: Partial<TeamAgent> = {}): TeamAgent => ({
  id, name: id[0].toUpperCase() + id.slice(1), role: "", agent: "claude", model: "sonnet", access: "auto",
  createdAt: 1, updatedAt: 1, ...over,
});
const names = new Map([["p-star", "starfall-novel"], ["p-app", "App"]]);

describe("Talk to someone else", () => {
  it("says the project once when every agent shares it", () => {
    const html = renderToStaticMarkup(
      <RecipientPicker
        agents={[agent("lyra", { projectId: "p-star" }), agent("vesper", { projectId: "p-star" })]}
        selectedId={null}
        projectName={(id) => names.get(id)}
        onPick={() => {}}
        onManage={() => {}}
        showManage={false}
        label="Talk to someone else"
      />,
    );
    expect(html).toContain("All in starfall-novel");
    expect(html).not.toContain("lead-chip-meta");
    expect(html).toContain('aria-label="Talk to someone else"');
    expect(html).not.toContain("Manage agents");
  });

  it("names each project when they differ", () => {
    const html = renderToStaticMarkup(
      <RecipientPicker
        agents={[agent("lyra", { projectId: "p-star" }), agent("mango", { projectId: "p-app" }), agent("potato")]}
        selectedId="mango"
        projectName={(id) => names.get(id)}
        onPick={() => {}}
        onManage={() => {}}
      />,
    );
    expect(html).not.toContain("All in");
    expect(html.match(/lead-chip-meta/g)?.length).toBe(2);
    expect(html).toContain("Manage agents");
  });
});

describe("the front desk in Settings", () => {
  const roster = [agent("potato"), agent("boss"), agent("worker", { reportsTo: "boss" }), agent("local", { projectId: "p-app" })];
  const block = (desk: TeamAgent | null, list = roster) => renderToStaticMarkup(
    <FrontDeskBlock desk={desk} roster={list} headId="potato" loading={false} busy={false}
      onPick={() => {}} onCreate={() => {}} onSettings={() => {}} />,
  );

  it("offers to create one in one step on the smallest model at its lowest effort", () => {
    const html = block(null);
    expect(html).toContain("Create front desk");
    expect(html).toContain("A router on Claude Haiku latest, low effort");
    expect(html).toContain('aria-label="Front desk"');
    // The head and a manager are offered but cannot be chosen.
    expect(html).toMatch(/<option value="potato" disabled="">Potato · not available<\/option>/);
    expect(html).toMatch(/<option value="boss" disabled="">Boss · not available<\/option>/);
    expect(html).not.toContain('value="local"');
    // And the page says why.
    expect(html).toContain("Not available: Potato, Boss.");
    expect(html).toContain("a front desk&#x27;s chats are hidden and it only routes");
  });

  it("shows what the front desk runs on, with the agent form's own provider, model and effort controls", () => {
    const desk = agent("desk", { model: "haiku", effort: "low", access: "read" });
    const html = block(desk, [...roster, desk]);
    expect(html).not.toContain("Create front desk");
    expect(html).toContain('aria-label="What Desk runs on"');
    expect(html).toContain("<span>Provider</span>");
    expect(html).toContain("<span>Model</span>");
    expect(html).toContain("<span>Effort</span>");
    expect(html).toMatch(/<option value="haiku" selected="">Haiku latest<\/option>/);
    expect(html).toMatch(/<option value="low" selected="">Low<\/option>/);
    expect(html).toContain("Now Claude Haiku latest · low. Used from the next new chat.");
    expect(html).toMatch(/<option value="desk" selected="">Desk<\/option>/);
  });
});
