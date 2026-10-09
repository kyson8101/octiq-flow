import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
// ChatRequests' other cards answer through the bridge, which needs a page.
vi.mock("../lib/bridge", () => ({ bridge: { invoke: vi.fn() } }));
import { AccessRequestCard } from "./AccessRequestCard";
import { ChatRequests } from "./ChatRequests";
import {
  accessCovers, accessRequestNote, accessRequestTitle, leastOffered, raiseRestarts, type AccessRequest,
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
    expect(html).toContain("It applies at once");
    expect(html).toContain("The agent is waiting for your answer; none within three minutes leaves the level as it is.");
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
    expect(html).toContain("raising it ends the turn now");
    // A fresh agent is not a change "at once".
    expect(html).not.toContain("It applies at once");
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
