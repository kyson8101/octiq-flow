import { describe, expect, it } from "vitest";
import { RELAY_HEAD, readRelay } from "./relay";
import { emptyChat, reduceChat } from "./chat";

/** A brief as `round::followup_brief` writes it. */
function brief(...parts: [string, string][]): string {
  return [
    RELAY_HEAD,
    ...parts.map(([who, what]) => `\n--- ${who} ---\n${what}`),
    "\n=== over to you ===\nThose are the other agents sitting in this chat, not the person.",
  ].join("\n");
}

describe("a follow-up brief on screen", () => {
  it("is recognised by its first line and named by who spoke", () => {
    expect(readRelay(brief(["Dee", "The migration is not reversible."]))).toBe(
      "passed on what Dee said",
    );
  });

  it("reads every name as a list, in the order they spoke", () => {
    const line = readRelay(brief(["Dee", "no"], ["Codex", "agreed"], ["Ana", "ship it"]));
    expect(line).toBe("passed on what Dee, Codex and Ana said");
  });

  it("leaves an ordinary message alone", () => {
    // Everything anybody types goes through this, so a false positive would
    // hide a real message behind a one-line summary of nothing.
    expect(readRelay("what did the others say?")).toBeUndefined();
    expect(readRelay("")).toBeUndefined();
    // The head has to be the START of it. A message QUOTING a brief — pasted
    // back in, or asked about — is still the person talking.
    expect(readRelay(`look at this:\n${brief(["Dee", "no"])}`)).toBeUndefined();
  });

  it("still says something when the brief names nobody", () => {
    // Not a shape the backend writes, but a brief with no answers in it must
    // not come back as an empty line on screen.
    expect(readRelay(RELAY_HEAD)).toBe("passed the answers on");
  });
});

describe("a follow-up brief rebuilt from the record", () => {
  it("is still drawn as one line, because the flag is read off the words", () => {
    // Reopening a conversation replays the transcript. The optimistic bubble
    // this page put on screen was never written down — the agent's echo is the
    // only copy — so the mark has to be recoverable from the text alone, or a
    // reloaded room prints the whole discussion a second time.
    const said = brief(["Dee", "The migration is not reversible."]);
    const state = reduceChat(emptyChat(), {
      type: "user",
      uuid: "u-1",
      message: { role: "user", content: [{ type: "text", text: said }] },
    });

    const message = state.messages[state.messages.length - 1];
    expect(message.role).toBe("user");
    expect(message.relay).toBe("passed on what Dee said");
    expect(message.blocks).toEqual([{ kind: "text", text: said }]);
  });

  it("leaves a replayed message somebody typed as an ordinary bubble", () => {
    const state = reduceChat(emptyChat(), {
      type: "user",
      uuid: "u-2",
      message: { role: "user", content: [{ type: "text", text: "what did Dee say?" }] },
    });

    expect(state.messages[state.messages.length - 1].relay).toBeUndefined();
  });
});
