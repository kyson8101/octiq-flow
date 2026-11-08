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

it("retains only bounded provenance ids and releases it with the cursor", () => {
  const history = new ChatHistory();
  history.set("chat", 50, undefined, [{ ids: ["user", "assistant"], end: 100 }]);
  expect(history.slices("chat")).toEqual([{ ids: ["user", "assistant"], end: 100 }]);
  expect(JSON.stringify(history.get("chat"))).toBe('{"before":50}');
  history.forget("chat");
  expect(history.slices("chat")).toEqual([]);
  history.set("chat", 50, undefined, [{ ids: ["older"], end: 49 }]);
  history.set("chat", null);
  expect(history.slices("chat")).toEqual([]);
});
