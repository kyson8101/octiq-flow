// A skill run, as the agent reports it.
//
// Two shapes arrive as USER messages and are not the user's words at all:
//
//   - the skill's own prompt, replayed after the Skill tool answers — it opens
//     with "Base directory for this skill: <dir>" and then carries the whole
//     SKILL.md (current CLI, `entrypoint: sdk-cli`);
//   - an older echo of a typed slash command, wrapped in
//     `<command-name>` / `<command-args>` tags (interactive CLI transcripts).
//
// Drawn as a bubble, the first reads as "I said all this" — which is the bug
// this module exists to stop.
import { describe, expect, it } from "vitest";

import { hasBriefHead, parseCommandEcho, parseSkillBrief } from "./skillRun";

const SHIP =
  "Base directory for this skill: /Users/kyson/03-projects/octiq-flow/.claude/skills/ship\n\n" +
  "# Ship\n\n" +
  "Deploy OctiqFlow end to end: **commit → test → build → restart the service →\nprint the URL**.\n\n" +
  "## What OctiqFlow is now\n\nA headless server.";

const SLICE =
  "Base directory for this skill: /Users/kyson/.claude/plugins/cache/pandahrms-skills/pandahrms/4.13.0/skills/slice\n\n" +
  "# Pandahrms Slice\n\n" +
  "Cut agreed work into independently-completable cards. Group by capability where it helps; strict vertical slicing is not required.\n";

describe("the prompt a skill puts in front of the agent", () => {
  it("is recognised by its first line, and nothing else is", () => {
    expect(hasBriefHead(SHIP)).toBe(true);
    expect(hasBriefHead("please ship it")).toBe(false);
    expect(hasBriefHead("")).toBe(false);
    // The same words deeper in a message are a quote, not a skill.
    expect(hasBriefHead("look:\nBase directory for this skill: /x/y")).toBe(false);
  });

  it("reads one that names no folder, for the caller that knows better", () => {
    // A skill bundled with the agent has no directory line — nothing in the
    // words says what it is, and the envelope it arrived in has already said
    // so (see the reducer). All that is left here is to read it.
    expect(parseSkillBrief("# Fewer Prompts\n\nLook through the logs. Then stop.")).toEqual({
      dir: "",
      name: "",
      scope: undefined,
      summary: "Look through the logs.",
      body: "# Fewer Prompts\n\nLook through the logs. Then stop.",
    });
    expect(parseSkillBrief("   ")).toBeNull();
  });

  it("names the skill after its folder", () => {
    expect(parseSkillBrief(SHIP)).toMatchObject({
      dir: "/Users/kyson/03-projects/octiq-flow/.claude/skills/ship",
      name: "ship",
      scope: undefined,
    });
  });

  it("reads the plugin a skill came from off the plugin cache path", () => {
    expect(parseSkillBrief(SLICE)).toMatchObject({ name: "slice", scope: "pandahrms" });
  });

  it("keeps the instructions without the directory line", () => {
    const brief = parseSkillBrief(SHIP)!;
    expect(brief.body.startsWith("# Ship")).toBe(true);
    expect(brief.body).not.toContain("Base directory");
  });

  it("summarises with the first sentence of prose, plain", () => {
    // Not the heading, which mostly repeats the name; no bold markers; the
    // line break inside the sentence closed up.
    expect(parseSkillBrief(SHIP)!.summary).toBe(
      "Deploy OctiqFlow end to end: commit → test → build → restart the service → print the URL.",
    );
    expect(parseSkillBrief(SLICE)!.summary).toBe("Cut agreed work into independently-completable cards.");
  });

  it("has nothing to say about a skill with no prose", () => {
    expect(parseSkillBrief("Base directory for this skill: /s/bare\n\n# Bare\n")!.summary).toBe("");
  });
});

describe("an old-style echo of a typed slash command", () => {
  it("reads as the command that was typed", () => {
    expect(
      parseCommandEcho("<command-message>ship</command-message>\n<command-name>/ship</command-name>"),
    ).toBe("/ship");
  });

  it("carries the arguments along", () => {
    expect(
      parseCommandEcho(
        "<command-name>/clear</command-name>\n            <command-message>clear</command-message>\n            <command-args>--all</command-args>",
      ),
    ).toBe("/clear --all");
  });

  it("puts the slash on when the echo left it off", () => {
    expect(parseCommandEcho("<command-name>ship</command-name>")).toBe("/ship");
  });

  it("leaves an ordinary message alone", () => {
    expect(parseCommandEcho("run /ship please")).toBeNull();
  });
});
