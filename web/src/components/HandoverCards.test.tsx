import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { briefLabels, briefOver, HandoverCards, HandoverLines } from "./HandoverCards";
import sheet from "./HandoverCards.css?raw";
import { WHOLE_MAX } from "../lib/cardFold";
import { handover } from "../lib/handover.fixture";
import { handoverPlaces, handoversFor, type Handover } from "../lib/handover";

const noop = async () => undefined;
/** What App draws for a chat: the cards at the end, and the settled lines. */
const render = (list: Handover[], chatKey: string) => {
  const { tail, settled, incoming } = handoverPlaces(handoversFor(list, chatKey));
  return {
    tail: renderToStaticMarkup(<HandoverCards outgoing={tail} onDecide={noop} />),
    lines: renderToStaticMarkup(<HandoverLines incoming={incoming} outgoing={settled} onOpen={() => {}} />),
  };
};
/** The card at the end of a chat with its one disclosure open. */
const opened = (list: Handover[], chatKey: string) => renderToStaticMarkup(
  <HandoverCards outgoing={handoverPlaces(handoversFor(list, chatKey)).tail} onDecide={noop} startOpen />);

describe("HandoverCards", () => {
  it("asks the person to confirm, with the recipient, settings and checkout from git", () => {
    const { tail: html, lines } = render([handover()], "chat:source");
    expect(lines).toBe("");
    expect(html).toContain('data-status="pending"');
    expect(html).toContain('data-pending-keys="handover:handover_1"');
    // A name card: the face and the name are the title. The question it
    // used to be headed with is still what the card is called, and the
    // primary answer says it.
    expect(html).toContain('aria-label="Hand this task to Mango?"');
    expect(html).toMatch(/<header class="handover-id"><span class="handover-face"><span class="agent-avatar" style="--agent-avatar-size:44px;[^"]*" aria-hidden="true">/);
    expect(html).toContain('<h3 class="handover-name"><span data-travel="name">Mango</span></h3>');
    // What will happen, as two sentences: the project, with its folder a
    // hover, focus or tap away and not on the card; then where it goes on.
    expect(html).toMatch(/<p class="handover-fact">Takes over this task · <span class="handover-place has-tip" tabindex="0" aria-describedby="([^"]+)">App<span class="handover-tip" role="tooltip" id="\1">\/src\/\.worktrees\/app\/fix-login<\/span><\/span><\/p>/);
    expect(html).toContain('<p class="handover-fact">Continues on <code>fix/login</code> · uncommitted changes travel with it</p>');
    // The chat's settings, as one line of small print.
    expect(html).toContain('<p class="handover-settings"><span class="handover-sr">Chat settings: </span>Sonnet latest · high · Accept edits</p>');
    expect(html).toContain("Hand over to Mango");
    expect(html).toContain("Keep it here");
    expect(html).toContain("Nothing starts until you choose");
    // The brief and the paths are folded away behind the card's one control,
    // named by what they are and how much: the agent's words stay unread
    // until asked for, the fact that there are some does not.
    expect(html).toContain('<span>Brief · 1 line</span><span>1 said to carry over</span><span>1 not authorized</span><span>Checkout</span>');
    expect(html).toMatch(/<button type="button" class="card-fold-toggle" aria-expanded="false" aria-controls="[^"]+" aria-describedby="[^"]+" aria-label="Show the brief" title="Show the brief">/);
    expect(html).not.toContain("Finish the login fix");
    expect(html).not.toContain("commit on the task branch");
    expect(html).not.toContain("<details");
  });

  it("opens the brief whole above the buttons, with the agent's words marked as such", () => {
    const html = opened([handover()], "chat:source");
    expect(html).toContain('aria-expanded="true"');
    expect(html).toContain("Finish the login fix");
    expect(html).toContain("Potato says these carry over");
    expect(html).toContain("“commit on the task branch”");
    expect(html).toContain("approvals stay with each chat");
    expect(html).toContain("Not authorized");
    expect(html).toContain("HEAD abc1234");
    // The facts and the answers are the same in both states.
    for (const drawn of [html, render([handover()], "chat:source").tail]) {
      expect(drawn).toContain("uncommitted changes travel with it");
      expect(drawn).toContain("Hand over to Mango");
      expect(drawn).toContain("Keep it here");
    }
    // The line, what it opens, then the answers.
    expect(html.indexOf("card-fold-line")).toBeLessThan(html.indexOf("handover-brief-body"));
    expect(html.indexOf("handover-brief-body")).toBeLessThan(html.indexOf("handover-actions"));
  });

  it("draws every section of a brief whole whatever its length: nothing beside Hand over is cut", () => {
    // The host stops a section at 8,000 characters; the page has no cap of
    // its own to cut one at, and this keeps one from being added.
    const remaining = `Finish it.\n${"r".repeat(329_000)}\nLAST LINE OF THE BRIEF`;
    const html = opened([handover({ brief: { objective: "Finish the login fix", remaining } })], "chat:source");
    expect(html).toContain(`<p>${remaining}</p>`);
    expect(html).not.toContain("not shown");
    expect(html).toContain('<button type="button" class="handover-go">Hand over to Mango</button>');
  });

  it("sizes a brief by every section of it", () => {
    expect(briefLabels(handover({
      brief: { objective: "Fix login.\nKeep the old flow.", doneSoFar: "Found it.", remaining: "a\nb\nc" },
    }))).toEqual(["Brief · 6 lines", "Checkout"]);
  });

  it("shows why a confirm failed, and keeps the card confirmable", () => {
    const { tail: html } = render([handover({ error: "Mango is no longer a registered agent." })], "chat:source");
    expect(html).toContain("Mango is no longer a registered agent.");
    expect(html).toContain("Hand over to Mango");
  });

  it("offers only a retry once a start is under way, never keeping it here", () => {
    const failed = render([handover({ status: "starting", targetChatKey: "chat:new", error: "CLI unavailable" })], "chat:source");
    expect(failed.lines).toBe("");
    expect(failed.tail).toContain('data-status="starting"');
    expect(failed.tail).toContain("Mango&#x27;s chat did not start");
    expect(failed.tail).toContain("CLI unavailable");
    expect(failed.tail).toContain("Try again");
    expect(failed.tail).toContain("it can only be tried again");
    expect(failed.tail).not.toContain("Keep it here");
    expect(failed.tail).not.toContain("Give up");
    const running = render([handover({ status: "starting", targetChatKey: "chat:new" })], "chat:source");
    expect(running.tail).toContain("Starting the new chat.");
    // No answer left to give; the brief still opens.
    expect(running.tail).not.toMatch(/handover-(go|quiet)/);
  });

  it("marks a failed start as waiting on the person, and a start under way as not", () => {
    const failed = render([handover({ status: "starting", targetChatKey: "chat:new", error: "CLI unavailable" })], "chat:source");
    expect(failed.tail).toContain('data-pending=""');
    expect(failed.tail).toContain('data-pending-keys="handover:handover_1"');
    expect(failed.tail).toContain('tabindex="-1"');
    const running = render([handover({ status: "starting", targetChatKey: "chat:new" })], "chat:source");
    expect(running.tail).toContain('data-status="starting"');
    expect(running.tail).not.toContain("data-pending");
    // The card itself takes no focus; the project's name on it still does.
    expect(running.tail).not.toContain('tabindex="-1"');
    expect(running.tail).not.toMatch(/<section[^>]*tabindex/);
  });

  it("tints a card that waits on the person, a failed start included, and never one under way", () => {
    const waiting = (html: string) => /<section class="handover-card is-\w+ is-waiting"/.test(html);
    expect(waiting(render([handover()], "chat:source").tail)).toBe(true);
    expect(waiting(render([handover({ status: "starting", targetChatKey: "chat:new", error: "CLI unavailable" })], "chat:source").tail)).toBe(true);
    const running = render([handover({ status: "starting", targetChatKey: "chat:new" })], "chat:source").tail;
    expect(waiting(running)).toBe(false);
    // Under way, the face is the one thing that moves; waiting, nothing does.
    expect(running).toContain('<span class="handover-face is-opening">');
    expect(render([handover()], "chat:source").tail).not.toContain("is-opening");
    expect(render([handover({ status: "starting", targetChatKey: "chat:new", error: "CLI unavailable" })], "chat:source").tail).not.toContain("is-opening");
    // Opening a chat is not a turn in flight: the ring is not the class the
    // accent's "working" rings are drawn with anywhere else.
    expect(running).not.toContain("is-working");
  });

  it("shows the folder's tip from a state, which is shut when the card is drawn", () => {
    const html = render([handover()], "chat:source").tail;
    // Drawn shut: nothing has asked for it yet.
    expect(html).toContain('<span class="handover-place has-tip" tabindex="0"');
    expect(html).not.toContain("data-open");
    // The sheet shows the tip for that state and for nothing else. A
    // pseudo-class would keep it up after Escape, for as long as the pointer
    // stayed over the word or the focus on it.
    const rules = [...sheet.replace(/\/\*[\s\S]*?\*\//g, "").matchAll(/([^{}]+)\{([^{}]*)\}/g)]
      .map((rule) => ({ selector: rule[1].trim(), body: rule[2] }));
    const shows = rules.filter((rule) => rule.selector.includes(".handover-tip") && /visibility:\s*visible|opacity:\s*1\b/.test(rule.body));
    expect(shows.map((rule) => rule.selector)).toEqual([".handover-place.has-tip[data-open] .handover-tip"]);
    const named = rules.filter((rule) => /\.handover-(place|tip)/.test(rule.selector));
    expect(named.length).toBeGreaterThanOrEqual(4);
    // (The keyboard's ring on the word is `:focus-visible`, and stays.)
    for (const rule of named) expect(rule.selector).not.toMatch(/:hover|:focus(?!-visible)/);
  });

  it("says where the task goes on for every kind of checkout", () => {
    const fact = (extra: Partial<Handover["workspace"]>) => {
      const html = render([handover({ workspace: { mode: "continue", path: "/src/.worktrees/app/fix-login", ...extra } })], "chat:source").tail;
      return [...html.matchAll(/<p class="handover-fact">(.*?)<\/p>/g)][1]?.[1];
    };
    expect(fact({ branch: "fix/login", uncommitted: false })).toBe("Continues on <code>fix/login</code> · nothing uncommitted");
    expect(fact({ branch: "fix/login" })).toBe("Continues on <code>fix/login</code>");
    expect(fact({})).toBe("Continues in <code>fix-login</code>");
    expect(fact({ mode: "worktree", branch: "main" })).toBe("New worktree from <code>main</code>");
    expect(fact({ mode: "worktree", branch: "main", preparedBranch: "task/login" })).toBe("New worktree on <code>task/login</code>");
    expect(fact({ mode: "worktree" })).toBe("New worktree");
    expect(fact({ mode: "folder", path: "/src/notes" })).toBe("Works in <code>notes</code>");
  });

  it("will not hand over a brief too long to show, and says why", () => {
    // The host stops each part of a brief at 8,000 characters, so this is
    // the page's own bound: a brief it would not open whole is not opened
    // in part, and cannot be agreed to from the card.
    const remaining = "r".repeat(WHOLE_MAX - 10);
    const long = { objective: "Finish the login fix", remaining, authorized: ["commit on the task branch"] };
    for (const html of [
      render([handover({ brief: long })], "chat:source").tail,
      opened([handover({ brief: long })], "chat:source"),
    ]) {
      const why = /<p class="handover-over" id="([^"]+)">This brief is too long to show in full \(5,000,035 characters\), so it cannot be handed over from here\. Keep it here and ask for a shorter one\.<\/p>/.exec(html);
      expect(why, "no reason on the card").not.toBeNull();
      // Off, not disabled and not gone: it points at the sentence above it.
      expect(html).toMatch(new RegExp(`<button type="button" class="handover-go" aria-disabled="true" aria-describedby="${why![1]}"[^>]*>Hand over to Mango</button>`));
      expect(html).not.toMatch(/<button[^>]*class="handover-go"[^>]* disabled=""/);
      expect(html.indexOf("handover-over")).toBeLessThan(html.indexOf("handover-actions"));
      // Keeping it here is an ordinary button, and none of the brief is drawn.
      expect(html).toContain('<button type="button" class="handover-quiet">Keep it here</button>');
      expect(html).not.toContain("rrrr");
      expect(html).not.toContain("card-fold-toggle");
      // The card still waits on the person, and is still found by its badge.
      expect(html).toContain('data-pending-keys="handover:handover_1"');
    }
    // A failed start offers no way round it, and giving up stays.
    const retry = render([handover({ status: "starting", targetChatKey: "chat:new", error: "CLI unavailable", abandonable: true, brief: long })], "chat:source").tail;
    expect(retry).toMatch(/<button type="button" class="handover-go" aria-disabled="true"[^>]*>Try again<\/button>/);
    expect(retry).toContain('<button type="button" class="handover-quiet">Give up</button>');
    // The bound is on the whole brief, counted in characters, and one
    // character short of it is an ordinary card.
    expect(briefOver(handover({ brief: { objective: "o".repeat(WHOLE_MAX) } }))).toBe("");
    expect(briefOver(handover({ brief: { objective: "o".repeat(WHOLE_MAX), openQuestions: "?" } })))
      .toContain("(5,000,001 characters)");
    expect(briefOver(handover({ brief: { objective: "😀".repeat(WHOLE_MAX / 2 + 1) } }))).toBe("");
    expect(briefOver(handover())).toBe("");
  });

  it("lets the person give up on a failed start only once the host ruled a chat out", () => {
    const { tail: stuck } = render([handover({
      status: "starting", targetChatKey: "chat:new", error: "CLI unavailable", abandonable: true,
    })], "chat:source");
    expect(stuck).toContain("No chat was started. Try again, or give up and keep the task here.");
    expect(stuck).toContain("Give up");
    expect(stuck).toContain("Try again");
  });

  it("draws nothing for a chat with no handovers", () => {
    expect(render([handover()], "chat:elsewhere")).toEqual({ tail: "", lines: "" });
  });
});

describe("a settled handover", () => {
  it("leaves the end of the chat that asked, as one line linking to the new chat", () => {
    const list = [handover({ status: "confirmed", targetChatKey: "chat:new", notice: "tool" })];
    const { tail, lines } = render(list, "chat:source");
    expect(tail).toBe("");
    expect(lines).toContain('class="handover-line is-confirmed"');
    // Who has it now, by face and by name: where the confirmed card's own
    // face and name land.
    expect(lines).toMatch(/<span class="handover-line-what"><span class="agent-avatar handover-line-face" style="--agent-avatar-size:16px;[^"]*" aria-hidden="true">/);
    expect(lines).toContain('<span class="handover-line-text">Handed over to <bdi data-travel="name">Mango</bdi></span>');
    expect(lines).not.toContain("handover-mark");
    expect(lines).toContain('data-open-chat="new"');
    expect(lines).toContain("Open Mango&#x27;s chat");
    expect(lines).not.toContain("Keep it here");
    expect(lines).not.toContain("data-pending");
    // The facts and the brief are still there, folded under the line.
    expect(lines).toMatch(/aria-expanded="false"[^>]*>Brief/);
    expect(lines).toMatch(/class="handover-line-body" hidden="">/);
    expect(lines).toContain("Sonnet latest · high · Accept edits");
    expect(lines).toContain("Finish the login fix");
    expect(lines).toContain("/src/.worktrees/app/fix-login");
    expect(lines).toContain("HEAD abc1234");
  });

  it("starts the new chat with one line back to where it came from", () => {
    const list = [handover({ status: "confirmed", targetChatKey: "chat:new", notice: "tool" })];
    const { tail, lines } = render(list, "chat:new");
    expect(tail).toBe("");
    expect(lines).toContain('data-status="incoming"');
    expect(lines).toContain("Handed over from Potato");
    expect(lines).toContain("Fix the login bug");
    expect(lines).toContain("Finish the login fix");
    expect(lines).toContain('data-open-chat="source"');
    expect(lines).toContain("Open the original chat");
  });

  it("is incoming in the new chat even while its start is still settling", () => {
    const { tail, lines } = render([handover({ status: "starting", targetChatKey: "chat:new" })], "chat:new");
    expect(tail).toBe("");
    expect(lines).toContain("Handed over from Potato");
  });

  const back = (extra: Partial<Handover> = {}) => handover({
    status: "confirmed", targetChatKey: "chat:new", notice: "tool",
    asks: [
      { id: "ask_1", requestId: "q1", question: "Which lock guards the ledger?", contextPaths: ["src/ledger.rs"], status: "answered", answer: "The store's inner mutex.", askedAt: 1, answeredAt: 2 },
      { id: "ask_2", requestId: "q2", question: "And the cache?", status: "failed", error: "Not logged in", askedAt: 3 },
    ],
    outcomes: [
      { requestId: "o1", status: "blocked", summary: "Needs a DB password.", at: 4 },
      { requestId: "o2", status: "done", summary: "Login fixed, tests pass.", at: 5 },
    ],
    ...extra,
  });

  it("shows the outcome and the questions asked back on the line in the chat that handed over", () => {
    const { tail, lines } = render([back()], "chat:source");
    expect(tail).toBe("");
    // One line for the outcome, the latest only, under the handover line.
    expect(lines).toContain('class="handover-outcome is-done" data-outcome="done"');
    expect(lines).toContain("Mango finished: Login fixed, tests pass.");
    expect(lines.match(/class="handover-outcome /g)).toHaveLength(1);
    // The questions sit behind a count, folded, never as a card.
    expect(lines).toMatch(/<details class="handover-asks" data-asks="2"><summary><span>2 questions asked back<\/span>/);
    expect(lines).not.toContain("<details class=\"handover-asks\" data-asks=\"2\" open");
    expect(lines).toContain("Which lock guards the ledger?");
    expect(lines).toContain("The store&#x27;s inner mutex.");
    expect(lines).toContain("<code>src/ledger.rs</code>");
    expect(lines).toContain("Not logged in");
    expect(lines).not.toContain("handover-card");
    // Earlier reports stay in the folded body, newest first.
    expect(lines).toMatch(/Outcome reports<\/h4><ul><li>Mango finished: Login fixed, tests pass.<\/li><li>Mango is blocked: Needs a DB password.<\/li>/);
  });

  it("shows the same outcome and questions on the incoming line in the new chat", () => {
    const { lines } = render([back({ outcomes: [{ requestId: "o1", status: "blocked", summary: "Needs a DB password.", at: 4 }] })], "chat:new");
    expect(lines).toContain('data-status="incoming"');
    expect(lines).toContain('class="handover-outcome is-blocked" data-outcome="blocked"');
    expect(lines).toContain("Mango is blocked: Needs a DB password.");
    expect(lines).toContain("2 questions asked back");
    expect(lines).not.toContain("Outcome reports");
  });

  it("draws the outcome as one row whose whole summary opens in place, not in a tooltip", () => {
    const summary = `Blocked on the staging database. ${"The migration needs a password nobody here has. ".repeat(20)}`.trim();
    const { lines } = render([back({ outcomes: [{ requestId: "o1", status: "blocked", summary, at: 4 }] })], "chat:source");
    const row = lines.match(/<div class="handover-outcome is-blocked" data-outcome="blocked">.*?<\/button><\/div>/)?.[0];
    expect(row).toBeTruthy();
    // The whole summary is in the row, never only in a title.
    expect(row).toContain(`Mango is blocked: ${summary}`);
    expect(row).not.toContain("title=");
    // Shut by default. The toggle names the text it opens and stays hidden
    // until a measurement says the line is cut short.
    const textId = row!.match(/<span class="handover-outcome-text" id="([^"]+)">/)?.[1];
    expect(textId).toBeTruthy();
    expect(row).toContain(`aria-expanded="false" aria-controls="${textId}" aria-label="Show the whole outcome"`);
    expect(row).toMatch(/<button type="button" class="handover-outcome-toggle" hidden=""/);
    expect(row).not.toContain("is-open");
    // The earlier reports keep their list in the Brief.
    expect(lines).not.toContain("Outcome reports");
  });

  it("draws no outcome or questions where nothing came back", () => {
    const { lines } = render([handover({ status: "confirmed", targetChatKey: "chat:new", notice: "tool" })], "chat:source");
    expect(lines).not.toContain("handover-outcome");
    expect(lines).not.toContain("handover-asks");
    const waiting = render([back({ asks: [{ id: "a", requestId: "q", question: "Q?", status: "asking", askedAt: 1 }], outcomes: [] })], "chat:source");
    expect(waiting.lines).toContain("1 question asked back · 1 waiting");
    expect(waiting.lines).toContain("Waiting for an answer");
  });

  // By design: a handover that went nowhere is a headline and nothing else.
  // No facts, no Brief and no Open, as on the base before these lines existed:
  // the task stayed in this chat, so there is nothing to look up or go to.
  it("keeps a declined handover a quiet headline, with no Brief and no Open, by design", () => {
    const { tail, lines } = render([handover({ status: "declined" })], "chat:source");
    expect(tail).toBe("");
    expect(lines).toContain("Kept here: handover to Mango declined");
    expect(lines).not.toContain("<button");
    expect(lines).not.toContain("handover-brief");
  });

  // A given-up handover still carries the key its chat was reserved under at
  // confirm (handover.rs `confirm`), but `abandon` is refused once that chat
  // may have started, so no chat exists to open.
  it("keeps a given-up handover quiet the same way by design, with no Open for the chat that never started", () => {
    const { tail, lines } = render([handover({
      status: "abandoned", targetChatKey: "chat:new", error: "CLI unavailable", notice: "failed", noticeError: "agent gone",
    })], "chat:source");
    expect(tail).toBe("");
    expect(lines).toContain("Kept here: Mango&#x27;s chat could not start");
    expect(lines).toContain("Potato could not be told: agent gone");
    expect(lines).not.toContain("<button");
    expect(lines).not.toContain("data-open-chat");
    expect(lines).not.toContain("handover-brief");
  });
});
