import { describe, expect, it } from "vitest";

import { commandToken, replaceCommandToken, withCommandTrigger } from "./commandMenu";

describe("composer command triggers", () => {
  it("opens Codex skills for slash and dollar tokens", () => {
    expect(commandToken("/rel", "codex")).toEqual({
      trigger: "/", query: "rel", start: 0, end: 4,
    });
    expect(commandToken("$rel", "codex")).toEqual({
      trigger: "$", query: "rel", start: 0, end: 4,
    });
  });

  it("finds a Codex skill at the caret in the middle of a sentence", () => {
    expect(commandToken("please use $rel now", "codex", 15)).toEqual({
      trigger: "$", query: "rel", start: 11, end: 15,
    });
    expect(commandToken("please /rel now", "codex", 11)).toEqual({
      trigger: "/", query: "rel", start: 7, end: 11,
    });
    expect(commandToken("please\t$rel now", "codex", 11)).toEqual({
      trigger: "$", query: "rel", start: 7, end: 11,
    });
  });

  it("keeps the nearest earlier Codex skill active after more words are typed", () => {
    expect(commandToken("abc edg  /release cccc ", "codex")).toEqual({
      trigger: "/", query: "release", start: 9, end: 17,
    });
    expect(commandToken("abc $code-review this please", "codex")).toEqual({
      trigger: "$", query: "code-review", start: 4, end: 16,
    });
  });

  it("keeps Claude commands slash-only and whole-input", () => {
    expect(commandToken("/compact", "claude")).toEqual({
      trigger: "/", query: "compact", start: 0, end: 8,
    });
    expect(commandToken("$compact", "claude")).toBeUndefined();
    expect(commandToken("please /compact", "claude")).toBeUndefined();
  });

  it("does not claim a prefix embedded inside another word", () => {
    expect(commandToken("price$rel", "codex")).toBeUndefined();
    expect(commandToken("path/to", "codex")).toBeUndefined();
  });

  it("preserves the typed trigger in labels and completions", () => {
    expect(withCommandTrigger("/release", "$")).toBe("$release");
    expect(withCommandTrigger("/release ", "$")).toBe("$release ");
    expect(withCommandTrigger("/release ", "/")).toBe("/release ");
  });

  it("completes only the active token and preserves sentence whitespace", () => {
    const middle = commandToken("please use $rel now", "codex", 15)!;
    expect(replaceCommandToken("please use $rel now", middle, "$release ")).toEqual({
      text: "please use $release now",
      caret: 19,
    });

    const end = commandToken("please use $rel", "codex")!;
    expect(replaceCommandToken("please use $rel", end, "$release ")).toEqual({
      text: "please use $release ",
      caret: 20,
    });

    const earlier = commandToken("abc /rel cccc ", "codex")!;
    expect(replaceCommandToken("abc /rel cccc ", earlier, "/release ")).toEqual({
      text: "abc /release cccc ",
      caret: 12,
    });
  });
});
