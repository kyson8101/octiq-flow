import { describe, expect, it } from "vitest";
import { opensBlank, type Conversation } from "./store";
import { emptyChat, type Message } from "./chat";

const said = (text: string): Message => ({
  id: "u0",
  role: "user",
  blocks: [{ kind: "text", text }],
  streaming: false,
});

const stored = (messages: Message[] = []): Conversation => ({
  id: "c1",
  projectId: "p1",
  title: "yesterday's work",
  messages,
  createdAt: 0,
  updatedAt: 0,
});

describe("opensBlank", () => {
  it("is true for a chat this device has never seen", () => {
    // No stored messages and nothing loaded: the page will sit empty until the
    // replay lands, which is exactly when something has to say so.
    expect(opensBlank(stored(), undefined)).toBe(true);
  });

  it("is false when the stored copy already has the conversation in it", () => {
    expect(opensBlank(stored([said("hello")]), undefined)).toBe(false);
  });

  it("is false when the chat is already loaded and talking", () => {
    const loaded = { ...emptyChat(), messages: [said("still going")] };

    expect(opensBlank(stored(), loaded)).toBe(false);
  });

  it("is true when a loaded chat is loaded but still empty", () => {
    // A conversation opened, then reloaded on a device that has no record of
    // it: the state exists, with nothing in it yet.
    expect(opensBlank(stored(), emptyChat())).toBe(true);
  });
});
