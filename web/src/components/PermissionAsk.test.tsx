import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
vi.mock("../lib/bridge", () => ({ bridge: { invoke: vi.fn() } }));
import { PermissionAsk, askNote } from "./PermissionAsk";

const change = "Register a new agent, Nova.\n\nProvider: Codex\nAvailable in: Starfall";

describe("PermissionAsk", () => {
  it("puts an agent's proposed roster change on a one-off card, shown whole", () => {
    // The host asks about this one change (team_tools): "Always" would wave
    // through the next agent the chat invents, so the card does not offer it.
    const html = renderToStaticMarkup(<PermissionAsk
      ask={{
        id: "a1", chatKey: "chat:lead", toolName: "mcp__octiq__agent_register",
        toolInput: { change }, once: true, answerWithinSecs: 50,
      }}
      onAnswered={() => {}}
    />);
    expect(html).toContain("Register a new agent, Nova.");
    expect(html).toContain("Available in: Starfall");
    expect(html).not.toContain("Always");
    expect(html).toContain(">Allow<");
    expect(html).toContain("No answer within 50 seconds counts as Deny.");
  });

  it("keeps Always on an ordinary tool question", () => {
    const html = renderToStaticMarkup(<PermissionAsk
      ask={{ id: "b1", toolName: "Bash", toolInput: { command: "pnpm test" } }}
      onAnswered={() => {}}
    />);
    expect(html).toContain("Always");
    expect(html).toContain("Allow once");
    expect(askNote({ id: "b1" })).toBe(
      "The agent is paused until you answer. No answer within three minutes counts as Deny. “Always” lasts until this chat is stopped.",
    );
    expect(askNote({ id: "c1", once: true, answerWithinSecs: 180 })).toBe(
      "The agent is paused until you answer. No answer within three minutes counts as Deny.",
    );
  });
});
