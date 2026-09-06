import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
vi.mock("../lib/bridge", () => ({ bridge: { invoke: vi.fn(), on: vi.fn() } }));
import { emptyChat, type ChatState } from "../lib/chat";
import { ConversationOverview } from "./ConversationOverview";

const chat: ChatState = { ...emptyChat(), cwd: "/repo", messages: [
  { id: "u", role: "user", streaming: false, echo: "u", blocks: [{ kind: "text", text: "Fix save" }] },
  { id: "a", role: "assistant", streaming: false, blocks: [{ kind: "text", text: "Changed the handler" }] },
] };
const render = (connected = true, blocker?: string) => renderToStaticMarkup(
  <ConversationOverview chatId="chat" chat={chat} connected={connected} liveKnown={connected}
    interrupted={false} blocker={blocker} peers={[]} onOpenGit={() => {}} />,
);

describe("integrated conversation overview", () => {
  it("offers task status, workspace and settled delivery in one compact disclosure", () => {
    const html = render();
    expect(html).toContain("Task &amp; review");
    expect(html).toContain("Fix save");
    expect(html).toContain("Conversation directory");
    expect(html).toContain("Review this turn");
    expect(html).toContain("Checks may not have run");
    expect(html).toContain('aria-label="Dismiss task &amp; review"');
    expect(html).not.toContain('class="conversation-overview" open');
  });
  it("surfaces a pending decision and suppresses delivery while blocked", () => {
    const html = render(true, "Choose the layout");
    expect(html).toContain("Needs you");
    expect(html).toContain("Choose the layout");
    expect(html).not.toContain("Review this turn");
  });
  it("does not call disconnected state finished", () => {
    const html = render(false);
    expect(html).toContain("Status unconfirmed");
    expect(html).not.toContain("Turn finished");
  });
});
