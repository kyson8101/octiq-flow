// The name a chat keeps.
//
// The shape these guard against is a real one: reloading the page with a chat
// still working folded that chat's LIVE events in before its transcript
// arrived, leaving the newest few messages with a hole under them. The
// debounced save re-derived the name from exactly that, found no user turn,
// and renamed the conversation `New chat` — in storage AND in the server's
// index, so every other device picked the placeholder up too.
import { describe, expect, it } from "vitest";

import { UNNAMED, chatName, titleFrom } from "./store";
import type { Message } from "./chat";

const said = (role: Message["role"], text: string): Message => ({
  id: `${role}-${text.slice(0, 6)}`,
  role,
  blocks: [{ kind: "text", text }],
  streaming: false,
});

describe("chatName", () => {
  it("names a chat that has no name yet after the first thing asked in it", () => {
    expect(chatName(undefined, [said("user", "why is this laggy?")])).toBe("why is this laggy?");
  });

  it("keeps the name it has, whatever is currently loaded", () => {
    // The whole point: the loaded messages say one thing, the row says another,
    // and the row wins. A chat is named once.
    expect(chatName("why is this laggy?", [said("user", "and now something else")])).toBe(
      "why is this laggy?",
    );
  });

  it("does not rename a chat whose start has not been read back yet", () => {
    // The failure, exactly: assistant turns with no user turn under them.
    const tail = [said("assistant", "…so the answer is yes.")];
    expect(titleFrom(tail)).toBe(UNNAMED);
    expect(chatName("why is this laggy?", tail)).toBe("why is this laggy?");
  });

  it("treats the placeholder as no name, so a clobbered row recovers", () => {
    expect(chatName(UNNAMED, [said("user", "why is this laggy?")])).toBe("why is this laggy?");
  });

  it("leaves the placeholder alone when there is still nothing to name it after", () => {
    expect(chatName(UNNAMED, [said("assistant", "working…")])).toBe(UNNAMED);
    expect(chatName(undefined, [])).toBe(UNNAMED);
  });

  it("ignores whitespace as a name", () => {
    expect(chatName("   ", [said("user", "why is this laggy?")])).toBe("why is this laggy?");
  });
});
