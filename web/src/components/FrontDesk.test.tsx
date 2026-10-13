// The front desk's screens: its confirm card, the "Talk to someone else"
// list, and its row in Settings. Rendered to static markup (no jsdom).
import { describe, expect, it, vi } from "vitest";

vi.mock("../lib/bridge", () => ({ bridge: { invoke: async () => null } }));
import { renderToStaticMarkup } from "react-dom/server";
import { HandoverCards, HandoverLines } from "./HandoverCards";
import { FrontDeskBlock, RecipientPicker } from "./AgentsSettings";
import { AgentWelcome } from "./AgentRole";
import { ContinueDesk } from "./ContinueDesk";
import { WHOLE_MAX } from "../lib/cardFold";
import { FRONT_DESK_GREETING } from "../lib/frontDesk";
import { handover } from "../lib/handover.fixture";
import {
  handoverPlaces, handoversFor, handoverTail, homeShort, isRoute, mergeHandover, routeFact, routeHeadline, routePlaceLine, settingsLine, type Handover,
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
/** The confirm card with its one disclosure open. */
const opened = (list: Handover[], chatKey: string) => renderToStaticMarkup(
  <HandoverCards outgoing={handoverPlaces(handoversFor(list, chatKey)).tail} onDecide={noop} startOpen />);

describe("the front desk's confirm card", () => {
  it("shows the agent and the project, names the brief by its size, and creates nothing until the person chooses", () => {
    const { tail: html, lines } = cards([route()], "chat:desk");
    expect(lines).toBe("");
    expect(html).toContain('data-kind="route"');
    // The card is called by the question it asks; its title is the name.
    expect(html).toContain('aria-label="Open a chat with Vesper?"');
    // Who: the agent's face, large, and the name beside it.
    expect(html).toMatch(/<header class="handover-id"><span class="handover-face"><span class="agent-avatar" style="--agent-avatar-size:44px;[^"]*" aria-hidden="true"/);
    expect(html).toContain('<h3 class="handover-name"><span data-travel="name">Vesper</span></h3>');
    // What kind of chat and where, as one sentence: the project, then what
    // is worth knowing about the place. The folder is not on the card: it is
    // on the project's name, a hover, a focus or a tap away.
    expect(html).toMatch(/<p class="handover-fact">New chat · <span class="handover-place has-tip" tabindex="0" aria-describedby="([^"]+)">starfall-novel<span class="handover-tip" role="tooltip" id="\1">\/src\/starfall<\/span><\/span> · new worktree<\/p>/);
    // The chat's settings as one line of small print, the same three.
    expect(html).toContain('<p class="handover-settings"><span class="handover-sr">Chat settings: </span>Sonnet latest · high · Accept edits</p>');
    expect(html).not.toContain("handover-chip");
    // What: a brief over several lines is folded, named with its size, and
    // so is the exact first message. Neither is on the card until asked for.
    expect(html).toContain('<span>Brief · 2 lines</span><span>Exact first message · 7 lines</span>');
    expect(html).toMatch(/<button type="button" class="card-fold-toggle" aria-expanded="false" aria-controls="[^"]+"/);
    expect(html.match(/aria-expanded=/g)).toHaveLength(1);
    expect(html).not.toContain("Draft chapter 3");
    expect(html).not.toContain("route-handover_r1/map.png (image)");
    // The files it carries, as a sentence of their names.
    expect(html).toContain('<p class="handover-files">With 1 file: <code>map.png</code></p>');
    // A file that was not passed on is a warning, and is never folded.
    expect(html).toMatch(/<ul class="handover-unpassed" role="alert" aria-label="Not passed on"><li><svg[^>]*aria-hidden="true">.*?<\/svg><span>Not passed on: hosts \(not a file the person attached in OctiqFlow\)<\/span><\/li><\/ul>/);
    expect(html).toContain("Nothing opens until you choose");
    expect(html).toContain("Open chat with Vesper");
    expect(html).toContain(">Cancel<");
    // A hidden chat badges nothing.
    expect(html).not.toContain("data-pending-keys");
  });

  it("opens the whole brief and the exact first message above the buttons", () => {
    const html = opened([route()], "chat:desk");
    expect(html).toContain('aria-expanded="true"');
    // The whole brief as prose, and who wrote it.
    expect(html).toContain('<h4>Brief<span class="route-brief-from"> · from Front desk</span></h4>');
    expect(html).toContain("Draft chapter 3: the crossing.\nKeep Lyra&#x27;s voice; 3,000 words.");
    // The message to the letter, paths and all.
    expect(html).toContain("<h4>Exact first message</h4>");
    expect(html).toContain("route-handover_r1/map.png (image)");
    expect(html).toContain("once the person confirmed it.)</pre>");
    // The folder, whole, for a screen with no pointer to hover with.
    expect(html).toContain('<div class="handover-section route-opens"><h4>Opens in</h4><p class="handover-mono">/src/starfall</p></div>');
    expect(html.indexOf("route-message-text")).toBeLessThan(html.indexOf("route-opens"));
    expect(html.indexOf("route-opens")).toBeLessThan(html.indexOf("handover-actions"));
    expect(html).not.toContain("card-fold-cut");
    expect(html.indexOf("card-fold-line")).toBeLessThan(html.indexOf("route-message-text"));
    expect(html.indexOf("route-message-text")).toBeLessThan(html.indexOf("handover-actions"));
    expect(html).toContain("Open chat with Vesper");
    expect(html).toContain(">Cancel<");
  });

  it("opens a first message whole past the 200,000 characters it used to stop at", () => {
    const message = `Brainstorm the series.\n${"m".repeat(329_000)}\nLAST LINE OF THE MESSAGE`;
    const html = opened([route({ brief: { objective: "Brainstorm the series." }, route: { message } })], "chat:desk");
    expect(html).toContain(`<pre class="route-message-text is-whole">${message}</pre>`);
    expect(html).not.toContain("not shown");
    expect(html).not.toContain('aria-disabled="true"');
  });

  it("will not open a chat on a first message too long to show, and says why", () => {
    const message = `Brainstorm the series.\n${"m".repeat(WHOLE_MAX)}`;
    for (const html of [
      cards([route({ brief: { objective: "Brainstorm the series." }, route: { message } })], "chat:desk").tail,
      opened([route({ brief: { objective: "Brainstorm the series." }, route: { message } })], "chat:desk"),
    ]) {
      const why = /<p class="handover-over" id="([^"]+)">This first message is too long to show in full \(5,000,023 characters\), so it cannot be sent from here\. Cancel it and ask for a shorter one\.<\/p>/.exec(html);
      expect(why, "no reason on the card").not.toBeNull();
      // The answer that would send it is off and points at the sentence above it.
      expect(html).toMatch(new RegExp(`<button type="button" class="handover-go" aria-disabled="true" aria-describedby="${why![1]}"[^>]*>Open chat with Vesper</button>`));
      expect(html.indexOf("handover-over")).toBeLessThan(html.indexOf("handover-actions"));
      // Cancel is an ordinary button, and none of the message is drawn.
      expect(html).toContain('<button type="button" class="handover-quiet">Cancel</button>');
      expect(html).not.toContain("mmmm");
      expect(html).not.toContain("card-fold-toggle");
    }
    // A failed start offers no way round it either.
    const retry = cards([route({ status: "starting", targetChatKey: "chat:new", error: "CLI unavailable", abandonable: true, route: { message } })], "chat:desk").tail;
    expect(retry).toMatch(/<button type="button" class="handover-go" aria-disabled="true"[^>]*>Try again<\/button>/);
    expect(retry).toContain('<button type="button" class="handover-quiet">Give up</button>');
  });

  it("leaves a one-line brief on the card: it is a short fact", () => {
    const { tail } = cards([route({ brief: { objective: "Brainstorm the series." }, route: { message: "Brainstorm the series." } })], "chat:desk");
    expect(tail).toContain('<p class="route-brief-text">Brainstorm the series.</p>');
    // Only the first message is behind the control.
    expect(tail).toContain("<span>Exact first message · 22 characters</span>");
    expect(tail).not.toContain("<span>Brief ·");
  });

  it("offers a retry and, when nothing started, a way to give up", () => {
    const { tail } = cards([route({ status: "starting", targetChatKey: "chat:new", error: "CLI unavailable", abandonable: true })], "chat:desk");
    expect(tail).toContain("Vesper&#x27;s chat did not start");
    expect(tail).toContain("Try again");
    expect(tail).toContain("Give up");
    expect(tail).not.toContain(">Cancel<");
  });

  // The page never opens a chat read-only of its own accord: a start a
  // writer refused is a failed start like any other, with the host's words.
  it("offers no read-only way out when a writer kept the chat from opening", () => {
    const writer = "This checkout has an active writer for task Storyboard. Wait or use a separate worktree.";
    const stuck = route({ status: "starting", targetChatKey: "chat:new", error: writer, abandonable: true });
    const { tail } = cards([stuck], "chat:desk");
    expect(tail).toContain(writer);
    expect(tail).toContain("No chat was opened. Try again, or give up.");
    expect(tail).toContain("Try again");
    expect(tail).toContain("Give up");
    expect(tail.match(/<button/g)).toHaveLength(3); // the fold's control, Give up, Try again
    expect(tail).not.toMatch(/read-only|Discuss/i);
    // Nor when the chat may exist.
    const maybe = cards([route({ status: "starting", error: writer, abandonable: false })], "chat:desk").tail;
    expect(maybe).toContain("Its chat may already have started, so it can only be tried again.");
    expect(maybe).not.toMatch(/read-only|Discuss/i);
  });

  // `discuss` is wording: the chat it opens runs on its agent's registered
  // settings, which are the ones the card prints.
  it("asks to discuss when the front desk proposes a discussion, and calls nothing read-only", () => {
    const talk = route({
      settings: { agent: "claude", model: "opus", effort: "high", access: "auto" },
      route: { message: "Brainstorm the series.", discuss: true },
    });
    const { tail } = cards([talk], "chat:desk");
    expect(tail).toContain('aria-label="Discuss with Vesper?"');
    // A discussion is said first and once, then the project and its place.
    expect(tail).toMatch(/<p class="handover-fact">Discussion · <span class="handover-place has-tip"[^>]*>starfall-novel<span class="handover-tip"[^>]*>\/src\/starfall<\/span><\/span> · new worktree<\/p>/);
    expect(tail).not.toMatch(/· discussion/);
    expect(tail).toContain("</span>Opus latest · high · Auto</p>");
    expect(tail).toContain("Discuss with Vesper<");
    expect(tail).not.toMatch(/read-only/i);
    // A discussion that could not start has the same two answers.
    const stuck = cards([route({ status: "starting", error: "CLI unavailable", abandonable: true, route: { message: "x", discuss: true } })], "chat:desk").tail;
    expect(stuck).toContain("No chat was opened. Try again, or give up.");
    expect(stuck).not.toMatch(/read-only/i);
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

  it("keeps the card of a route this page confirmed until the page has gone to its chat, and no other", () => {
    const confirmed = route({ status: "confirmed", targetChatKey: "chat:new" });
    const ordinary = handover({ id: "handover_h", sourceChatKey: "chat:desk", status: "confirmed", targetChatKey: "chat:h" });
    const waiting = route({ id: "handover_r2" });
    const outgoing = handoversFor([confirmed, ordinary, waiting], "chat:desk").outgoing;
    // Any page: a confirmed route is not a card. The page that confirmed it:
    // its card stays, in the list's own order.
    expect(handoverTail(outgoing, null).map((item) => item.id)).toEqual(["handover_r2"]);
    expect(handoverTail(outgoing, "handover_r1").map((item) => item.id)).toEqual(["handover_r1", "handover_r2"]);
    // Never a handover (it becomes a line), never a route that is not
    // confirmed, never one from another chat.
    expect(handoverTail(outgoing, "handover_h").map((item) => item.id)).toEqual(["handover_r2"]);
    expect(handoverTail(outgoing, "handover_r2").map((item) => item.id)).toEqual(["handover_r2"]);
    expect(handoverTail(handoversFor([confirmed], "chat:new").outgoing, "handover_r1")).toEqual([]);
    expect(handoverTail([route({ status: "declined" })], "handover_r1")).toEqual([]);
    // Kept, the card says the chat is opening and asks nothing: no answer,
    // no tint, and the face is the one thing that moves.
    const html = renderToStaticMarkup(<HandoverCards outgoing={handoverTail(outgoing, "handover_r1").slice(0, 1)} onDecide={noop} />);
    expect(html).toContain('<section class="handover-card route-card is-confirmed" data-handover="handover_r1" data-status="confirmed" data-kind="route" aria-label="Opening a chat with Vesper…">');
    expect(html).toContain('<span class="handover-face is-opening">');
    expect(html).toContain('<footer class="handover-actions"><span class="handover-hint">Opening the chat.</span></footer>');
    expect(html).not.toContain("<button type=\"button\" class=\"handover-");
    expect(html).not.toContain("is-waiting");
    expect(html).not.toContain("data-pending");
    // An error an earlier try left on the record is not said of a chat that opened.
    const retried = renderToStaticMarkup(<HandoverCards outgoing={[route({ status: "confirmed", targetChatKey: "chat:new", error: "CLI unavailable" })]} onDecide={noop} />);
    expect(retried).not.toContain("CLI unavailable");
    expect(retried).not.toContain("handover-error");
  });

  it("sets the ids, paths and branches of a brief in mono, and leaves its words alone", () => {
    const tail = opened([route({
      brief: { objective: "Ask STAR LEAD (agent_ee96a6613d0c) to review /src/starfall/ch3.md on feature/ch3 & co.\nRun `pnpm test` <first>." },
    })], "chat:desk");
    expect(tail).toContain('<p class="route-brief-text">Ask STAR LEAD (<code>agent_ee96a6613d0c</code>) to review '
      + "<code>/src/starfall/ch3.md</code> on <code>feature/ch3</code> &amp; co.\nRun <code>pnpm test</code> &lt;first&gt;.</p>");
  });

  it("gives a head's cross-project chat no folder, and a home folder its short name", () => {
    const head = route({
      route: { message: "x", crossProject: true },
      workspace: { mode: "folder", path: "/Users/kyson/general" },
      destination: { projectId: "g", projectName: "General", repository: "/Users/kyson/general" },
    });
    const across = cards([head], "chat:desk").tail;
    expect(across).toContain('<p class="handover-fact">New chat · <span class="handover-place">General</span> · plans across every project</p>');
    expect(across).not.toContain("handover-tip");
    expect(opened([head], "chat:desk")).not.toContain("Opens in");
    const one = cards([route({ ...head, route: { message: "x" } })], "chat:desk").tail;
    expect(one).toMatch(/<p class="handover-fact">New chat · <span class="handover-place has-tip"[^>]*>General<span class="handover-tip" role="tooltip" id="[^"]+">~\/general<\/span><\/span><\/p>/);
    expect(opened([route({ ...head, route: { message: "x" } })], "chat:desk")).toContain('<h4>Opens in</h4><p class="handover-mono">~/general</p>');
    expect(homeShort("C:\\Users\\kyson\\work\\app")).toBe("~\\work\\app");
    expect(homeShort("/home/kyson")).toBe("~");
    expect(homeShort("/srv/app")).toBe("/srv/app");
  });

  it("names where the chat will work, as a person reads it", () => {
    expect(routeHeadline(route({ status: "starting" }))).toBe("Opening a chat with Vesper…");
    expect(routePlaceLine(route({ workspace: { mode: "folder", path: "/g" }, destination: { projectId: "g", projectName: "General", repository: "/g" } }))).toBe("General");
    expect(routePlaceLine(route({ route: { message: "x", crossProject: true }, workspace: { mode: "folder", path: "/g" }, destination: { projectId: "g", projectName: "General", repository: "/g" } })))
      .toBe("General · plans across every project");
    expect(routePlaceLine(route({ route: { message: "x", discuss: true } }))).toBe("starfall-novel · new worktree · discussion");
    // The card's own sentence says a discussion first, and once.
    expect(routeFact(route())).toEqual({ lead: "New chat", project: "starfall-novel", notes: ["new worktree"] });
    expect(routeFact(route({ route: { message: "x", discuss: true } })))
      .toEqual({ lead: "Discussion", project: "starfall-novel", notes: ["new worktree"] });
    expect(routeFact(route({ route: { message: "x", crossProject: true, discuss: true } })).notes).toEqual(["plans across every project"]);
    // The settings the card prints, on one line.
    expect(settingsLine(route().settings)).toBe("Sonnet latest · high · Accept edits");
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

describe("Talk to the front desk", () => {
  const role = "Listens to what the person wants, works out which registered agent should handle it.";
  it("speaks to the person under the title and keeps its role under Details", () => {
    const html = renderToStaticMarkup(
      <AgentWelcome name="Front desk" role={role} scope="Your front desk" how="Say what you need." greeting={FRONT_DESK_GREETING} />,
    );
    const summary = html.match(/<span class="agent-welcome-summary">(.*?)<\/span>/)?.[1];
    expect(summary).toBe("Tell me what you need and I&#x27;ll open the right agent&#x27;s chat.");
    expect(html).toContain(`<p class="agent-welcome-role">${role}</p>`);
    expect(html).toContain('aria-label="Details about Front desk"');
  });

  it("offers the way back to a conversation left before it routed", () => {
    const now = 10 * 60_000;
    const html = renderToStaticMarkup(
      <ContinueDesk
        name="Front desk"
        now={now}
        onContinue={() => undefined}
        chats={[
          { chatKey: "chat:a", agentId: "agent_desk", createdAt: now - 5 * 60_000, opening: "Draft chapter 3" },
          { chatKey: "chat:b", agentId: "agent_desk", createdAt: now - 20_000 },
        ]}
      />,
    );
    expect(html).toContain('aria-label="Continue with Front desk"');
    expect(html).toContain('<span class="hero-continue-text">Draft chapter 3</span>');
    expect(html).toContain('<span class="hero-continue-time">5m ago</span>');
    // A chat recorded before its opening words were kept still has a row.
    expect(html).toContain('<span class="hero-continue-text">Your earlier conversation</span>');
    expect(html.match(/<button type="button" class="hero-continue-row"/g)).toHaveLength(2);
  });

  it("draws nothing when there is nothing to go back to", () => {
    expect(renderToStaticMarkup(
      <ContinueDesk name="Front desk" now={1} chats={[]} onContinue={() => undefined} />,
    )).toBe("");
  });

  it("leaves every other agent's line as its role and scope", () => {
    const html = renderToStaticMarkup(
      <AgentWelcome name="Vesper" role="Writes Starfall prose." scope="Works only in starfall" how="Does the work." />,
    );
    expect(html).toContain('<span class="agent-welcome-summary">Writes Starfall prose · Works only in starfall</span>');
  });
});
