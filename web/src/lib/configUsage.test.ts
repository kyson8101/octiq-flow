// Reading the CLI's own settings list, against the CLI's own words.
//
// The text here is copied verbatim from `__fixtures__/config-command.jsonl`,
// which is a real `claude -p` stream — so if Claude Code changes the shape of
// this answer, re-record that fixture and this goes red for the right reason.
import { describe, expect, it } from "vitest";
import { confirmedSetting, groupSettings, parseConfigUsage, settingLabel } from "./configUsage";

const USAGE = `Usage: /config key=value [key=value ...]
  artifacts=true|false
  autoCompact=true|false
  autoConnectIde=true|false
  editor=normal|vim
  language=<value>
  model=default|sonnet|opus|haiku|best|sonnet[1m]|opus[1m]|opusplan
  notifChannel=auto|iterm2|terminal_bell|kitty|ghostty|notifications_disabled
  permissionMode=default|plan|acceptEdits|auto|dontAsk
  theme=auto|dark|light|light-daltonized|dark-ansi
  verbose=true|false
  workflowSizeGuideline=unrestricted|small|medium|large`;

describe("the settings list a bare /config prints", () => {
  it("finds every setting on it", () => {
    const settings = parseConfigUsage(USAGE);
    expect(settings?.map((s) => s.key)).toEqual([
      "artifacts",
      "autoCompact",
      "autoConnectIde",
      "editor",
      "language",
      "model",
      "notifChannel",
      "permissionMode",
      "theme",
      "verbose",
      "workflowSizeGuideline",
    ]);
  });

  it("keeps the values the CLI listed, and only those", () => {
    const settings = parseConfigUsage(USAGE)!;
    expect(settings.find((s) => s.key === "editor")?.options).toEqual(["normal", "vim"]);
    // Square brackets and all — a model name is a string, not something to parse.
    expect(settings.find((s) => s.key === "model")?.options).toContain("sonnet[1m]");
  });

  it("leaves a free-text setting with nothing to click", () => {
    const settings = parseConfigUsage(USAGE)!;
    expect(settings.find((s) => s.key === "language")?.options).toEqual([]);
  });

  it("says no to a reply that is not a settings list", () => {
    expect(parseConfigUsage("Set Verbose output to true")).toBeNull();
    expect(parseConfigUsage("I ran `/config` and here is what key=value means")).toBeNull();
    expect(parseConfigUsage("")).toBeNull();
  });

  it("stops at the end of the block rather than eating the prose after it", () => {
    const settings = parseConfigUsage(`${USAGE}\nSomething else entirely=not a setting line`);
    // That last line IS shaped like a setting, so what stops it is the words
    // before the `=` not being one bare word.
    expect(settings?.map((s) => s.key)).not.toContain("Something");
    expect(settings).toHaveLength(11);
  });
});

describe("what the CLI says back when a setting takes", () => {
  const keys = ["verbose", "model", "autoCompact", "auto", "thinking"];

  it("matches its prose name back to the key", () => {
    expect(confirmedSetting("Set Verbose output to true", keys)).toEqual({
      key: "verbose",
      value: "true",
    });
    expect(confirmedSetting("Set Model to haiku", keys)).toEqual({ key: "model", value: "haiku" });
  });

  it("prefers the longer key when two could fit", () => {
    expect(confirmedSetting("Set Auto compact to false", keys)?.key).toBe("autoCompact");
  });

  it("says nothing rather than guessing", () => {
    expect(confirmedSetting("Set something nobody has heard of to 3", keys)).toBeNull();
    expect(confirmedSetting("The model is thinking", keys)).toBeNull();
  });
});

describe("drawing the list", () => {
  it("says a key the way a person would", () => {
    expect(settingLabel("verbose")).toBe("Verbose");
    expect(settingLabel("workflowSizeGuideline")).toBe("Workflow size guideline");
  });

  it("shouts an initialism rather than leaving it looking like a typo", () => {
    expect(settingLabel("autoConnectIde")).toBe("Auto connect IDE");
    expect(settingLabel("prStatus")).toBe("PR status");
  });

  it("groups what it knows and keeps the rest", () => {
    const groups = groupSettings(parseConfigUsage(USAGE)!);
    const titles = groups.map((g) => g.title);
    expect(titles).toContain("The model");
    expect(groups.flatMap((g) => g.rows)).toHaveLength(11);
  });

  it("puts a setting it has never seen at the end rather than losing it", () => {
    const groups = groupSettings([{ key: "somethingNew", options: ["true", "false"] }]);
    expect(groups).toEqual([
      { title: "Everything else", rows: [{ key: "somethingNew", options: ["true", "false"] }] },
    ]);
  });
});
