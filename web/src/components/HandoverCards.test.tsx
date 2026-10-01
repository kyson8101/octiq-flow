import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { HandoverCards, HandoverLines } from "./HandoverCards";
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

describe("HandoverCards", () => {
  it("asks the person to confirm, with the recipient, settings and checkout from git", () => {
    const { tail: html, lines } = render([handover()], "chat:source");
    expect(lines).toBe("");
    expect(html).toContain('data-status="pending"');
    expect(html).toContain('data-pending-keys="handover:handover_1"');
    expect(html).toContain("Hand this task to Mango?");
    expect(html).toContain("Sonnet latest · high · Accept edits");
    expect(html).toContain("App · continues in fix-login on fix/login");
    expect(html).toContain("Uncommitted changes travel with it");
    expect(html).toContain("Hand over to Mango");
    expect(html).toContain("Keep it here");
    expect(html).toContain("Nothing starts until you choose.");
    // The brief and the paths are folded away, and carried permissions are
    // shown as the agent's words.
    expect(html).toContain("<details class=\"handover-brief\">");
    expect(html).toContain("Potato says these carry over");
    expect(html).toContain("“commit on the task branch”");
    expect(html).toContain("approvals stay with each chat");
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
    expect(running.tail).not.toContain("<button");
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
    expect(lines).toContain("Handed over to Mango");
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

  it("folds a declined handover to a quiet headline with no buttons", () => {
    const { tail, lines } = render([handover({ status: "declined" })], "chat:source");
    expect(tail).toBe("");
    expect(lines).toContain("Kept here: handover to Mango declined");
    expect(lines).not.toContain("<button");
    expect(lines).not.toContain("handover-brief");
  });

  it("folds a given-up handover the same way, and says when the agent could not be told", () => {
    const { tail, lines } = render([handover({
      status: "abandoned", targetChatKey: "chat:new", error: "CLI unavailable", notice: "failed", noticeError: "agent gone",
    })], "chat:source");
    expect(tail).toBe("");
    expect(lines).toContain("Kept here: Mango&#x27;s chat could not start");
    expect(lines).toContain("Potato could not be told: agent gone");
    expect(lines).not.toContain("<button");
    expect(lines).not.toContain("handover-brief");
  });
});
