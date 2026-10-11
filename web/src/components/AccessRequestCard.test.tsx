import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
// ChatRequests' other cards answer through the bridge, which needs a page.
vi.mock("../lib/bridge", () => ({ bridge: { invoke: vi.fn() } }));
import { AccessRequestCard } from "./AccessRequestCard";
import { ChatRequests } from "./ChatRequests";
import {
  accessCovers, accessRequestNote, accessRequestShort, accessRequestTitle, leastOffered, raiseRestarts, type AccessRequest,
} from "../lib/accessRequest";
import { pendingActions } from "../lib/pendingActions";
import { EMPTY_ORCHESTRATION } from "../lib/orchestration";

/** What the host announces for a Claude chat on Plan that asks for edits. */
const claude: AccessRequest = {
  id: "r1", chatKey: "chat:c1", agent: "claude", current: "read", requested: "edits",
  reason: "Write the fix to src/lib/chat.ts.", takes: "now", wait: true, answerWithinSecs: 180,
};

describe("the access card", () => {
  it("shows the level now, the level asked for, and why, in the picker's own words", () => {
    const html = renderToStaticMarkup(<AccessRequestCard request={claude} onAnswer={async () => {}} />);
    expect(html).toContain("Raise this chat&#x27;s access to Accept edits?");
    expect(html).toContain(">Plan<");
    expect(html).toContain(">Accept edits<");
    expect(html).toContain("Write the fix to src/lib/chat.ts.");
    expect(html).toContain("Raise to Accept edits");
    expect(html).toContain("Not now");
    // Folded: when a raise takes hold, on one short line beside the answers.
    expect(html).toMatch(/<p class="ask-card-wait" title="[^"]*">Applies at once<\/p>/);
    // A reason of one short line is a fact: whole, with nothing of it folded.
    expect(html).toContain('<p class="access-card-reason">Write the fix to src/lib/chat.ts.</p>');
    expect(html).toContain('<span>How it applies</span>');
    expect(html).not.toContain("<span>Why ·");
    expect(html).toMatch(/<button type="button" class="card-fold-toggle" aria-expanded="false" aria-controls="[^"]+"/);
    expect(html).not.toContain("card-fold-note");
  });

  it("opens to all of what a raise does, above the answers", () => {
    const html = renderToStaticMarkup(<AccessRequestCard request={claude} onAnswer={async () => {}} startOpen />);
    expect(html).toContain('aria-expanded="true"');
    expect(html).toContain(
      '<p class="card-fold-note">It applies at once, to the work the agent is doing now. '
      + "The agent is waiting for your answer; none within three minutes leaves the level as it is.</p>",
    );
    expect(html.indexOf("card-fold-note")).toBeLessThan(html.indexOf("ask-card-foot"));
    expect(html).toContain("Raise to Accept edits");
    expect(html).toContain("Not now");
  });

  it("holds a reason that runs on to one line, names its size, and opens it whole", () => {
    const reason = "The fix touches three files outside the folder this chat may write to:\n"
      + "web/src/lib/chat.ts, web/src/lib/chat.test.ts and the fixture beside them.";
    const long: AccessRequest = { ...claude, reason };
    const html = renderToStaticMarkup(<AccessRequestCard request={long} onAnswer={async () => {}} />);
    expect(html).toContain(`<p class="access-card-reason is-first">${reason}</p>`);
    expect(html).toContain("<span>Why · 2 lines</span><span>How it applies</span>");
    const open = renderToStaticMarkup(<AccessRequestCard request={long} onAnswer={async () => {}} startOpen />);
    expect(open).toContain(`<div class="ask-card-label">Why</div><p class="access-card-reason">${reason}</p>`);
    for (const drawn of [html, open]) {
      expect(drawn).toContain(">Plan<");
      expect(drawn).toContain(">Accept edits<");
      expect(drawn).toContain("Raise to Accept edits");
    }
  });

  it("says in a few words when a raise takes hold", () => {
    expect(accessRequestShort(claude)).toBe("Applies at once");
    expect(accessRequestShort({ ...claude, takes: "next-turn" })).toBe("Applies from the agent's next turn");
    expect(accessRequestShort({ ...claude, takes: "between-turns" })).toBe("Applies from your next message");
    // A raise that restarts the agent ends the turn, and that is never folded.
    expect(accessRequestShort({ ...claude, requested: "full" })).toBe("Raising ends the turn now");
  });

  it("names Codex's levels as Codex's picker does", () => {
    const codex: AccessRequest = { ...claude, agent: "codex", requested: "auto", takes: "next-turn", answerWithinSecs: 50 };
    const html = renderToStaticMarkup(<AccessRequestCard request={codex} onAnswer={async () => {}} />);
    expect(html).toContain(">Read-only<");
    expect(html).toContain("Raise to Workspace write");
    expect(accessRequestNote(codex)).toBe(
      "It applies from the agent's next turn; the one running now keeps its level. The agent is waiting for your answer; none within 50 seconds leaves the level as it is.",
    );
  });

  it("tells the person when nobody waits on the card and when a raise restarts the agent", () => {
    const agy: AccessRequest = { ...claude, agent: "antigravity", takes: "between-turns", wait: false, local: true };
    expect(accessRequestNote(agy)).toBe(
      "It applies from your next message: the agent takes a new level only between turns. Not now leaves the level as it is.",
    );
    expect(raiseRestarts(agy)).toBe(false);
    const bypass = { ...claude, requested: "full" as const };
    expect(raiseRestarts(bypass)).toBe(true);
    const html = renderToStaticMarkup(<AccessRequestCard request={bypass} onAnswer={async () => {}} />);
    // On the folded card, beside the button that does it.
    expect(html).toContain(">Raising ends the turn now</p>");
    expect(renderToStaticMarkup(<AccessRequestCard request={bypass} onAnswer={async () => {}} startOpen />))
      .toContain('<p class="card-fold-note">This level needs a fresh agent: raising it ends the turn now');
    // A fresh agent is not a change "at once".
    expect(html).not.toContain("pplies at once");
    expect(accessRequestTitle(bypass)).toBe("Raise this chat's access to Bypass permissions?");
  });

  it("is drawn in the chat only with a way to answer it, and badged only when the host keeps it", () => {
    const local: AccessRequest = { ...claude, id: "refusal:c1", agent: "antigravity", wait: false, local: true };
    const props = {
      asks: [], safetyBlocks: [], questions: [], onPermissionAnswered: () => {}, onSafetyAnswered: () => {},
      onQuestionsAnswered: () => {}, onContinue: () => {}, accessRequests: [claude, local],
    };
    expect(renderToStaticMarkup(<ChatRequests {...props} />)).not.toContain("access-card");
    const html = renderToStaticMarkup(<ChatRequests {...props} onAccessAnswer={async () => {}} />);
    expect(html.match(/access-card"/g)).toHaveLength(2);
    expect(html).toContain('data-pending-keys="access:r1"');
    expect(html).not.toContain("access:refusal:c1");
    const actions = pendingActions({ orchestration: EMPTY_ORCHESTRATION, parents: new Map(), accessRequests: { c1: [claude] } });
    expect(actions).toEqual([expect.objectContaining({ key: "access:r1", kind: "permission", rowId: "c1", openChatId: "c1" })]);
  });
});

describe("access levels", () => {
  it("orders the levels and covers a request at or below the current one", () => {
    expect(accessCovers("auto", "edits")).toBe(true);
    expect(accessCovers("edits", "edits")).toBe(true);
    expect(accessCovers("read", "manual")).toBe(false);
    expect(accessCovers("auto", "full")).toBe(false);
  });

  it("asks a provider only for a level its picker offers", () => {
    expect(leastOffered("codex", "edits")).toBe("auto");
    expect(leastOffered("pi", "edits")).toBe("full");
    expect(leastOffered("antigravity", "manual")).toBe("edits");
    expect(leastOffered("claude", "manual")).toBe("manual");
  });
});
