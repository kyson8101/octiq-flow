import { expect, it } from "vitest";
import { ChatHistory } from "./chatHistory";

it("holds only replay cursors, without retaining a second raw transcript", () => {
  const history = new ChatHistory();
  history.set("chat", 100);
  expect(history.get("chat")).toEqual({ before: 100 });
  history.set("chat", 50);
  expect(history.get("chat")).toEqual({ before: 50 });
  history.set("chat", null);
  expect(history.hasEarlier("chat")).toBe(false);
});
