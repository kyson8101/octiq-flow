import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { HandoverCards } from "./HandoverCards";
import { handover } from "../lib/handover.fixture";
import { handoversFor, type Handover } from "../lib/handover";

const noop = async () => undefined;
const render = (list: Handover[], chatKey: string) => {
  const { outgoing, incoming } = handoversFor(list, chatKey);
  return renderToStaticMarkup(
    <HandoverCards outgoing={outgoing} incoming={incoming} onDecide={noop} onOpen={() => {}} />,
  );
};

describe("HandoverCards", () => {
  it("asks the person to confirm, with the recipient, settings and checkout from git", () => {
    const html = render([handover()], "chat:source");
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

  it("links a confirmed handover to the new chat, and the new chat back", () => {
    const list = [handover({ status: "confirmed", targetChatKey: "chat:new", notice: "tool" })];
    const source = render(list, "chat:source");
    expect(source).toContain("Handed over to Mango");
    expect(source).toContain('data-open-chat="new"');
    expect(source).not.toContain("Keep it here");
    expect(source).not.toContain("data-pending-keys");
    const target = render(list, "chat:new");
    expect(target).toContain("Handed over from Potato");
    expect(target).toContain("Fix the login bug");
    expect(target).toContain('data-open-chat="source"');
  });

  it("folds a declined handover to one quiet line with no buttons", () => {
    const html = render([handover({ status: "declined" })], "chat:source");
    expect(html).toContain("Kept here: handover to Mango declined");
    expect(html).not.toContain("<button");
    expect(html).not.toContain("handover-brief");
  });

  it("shows why a confirm failed, and keeps the card confirmable", () => {
    const html = render([handover({ error: "Mango is no longer a registered agent." })], "chat:source");
    expect(html).toContain("Mango is no longer a registered agent.");
    expect(html).toContain("Hand over to Mango");
  });

  it("draws nothing for a chat with no handovers", () => {
    expect(render([handover()], "chat:elsewhere")).toBe("");
  });
});
