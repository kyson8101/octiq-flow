import { describe, expect, it } from "vitest";
import { briefRuns } from "./briefRuns";

const mono = (text: string) => briefRuns(text).filter((run) => run.mono).map((run) => run.text);
const joined = (text: string) => briefRuns(text).map((run) => run.text).join("");

describe("briefRuns", () => {
  it("leaves ordinary prose as one plain run, line breaks and all", () => {
    const text = "Draft chapter 3: the crossing.\nKeep Lyra's voice; 3,000 words.";
    expect(briefRuns(text)).toEqual([{ text, mono: false }]);
    expect(briefRuns("")).toEqual([{ text: "", mono: false }]);
  });

  it("sets host ids apart, without the punctuation round them", () => {
    const text = "Report to STAR LEAD (agent_ee96a6613d0c), then settle task_fb9ea8235e7b4aa795ade4564d1a1b0c.";
    expect(briefRuns(text)).toEqual([
      { text: "Report to STAR LEAD (", mono: false },
      { text: "agent_ee96a6613d0c", mono: true },
      { text: "), then settle ", mono: false },
      { text: "task_fb9ea8235e7b4aa795ade4564d1a1b0c", mono: true },
      { text: ".", mono: false },
    ]);
  });

  it("sets absolute paths apart: root, home and a Windows drive", () => {
    expect(mono("Work in /Users/kyson/03-projects/octiq-flow, not ~/scratch or C:\\work\\app.")).toEqual([
      "/Users/kyson/03-projects/octiq-flow", "~/scratch", "C:\\work\\app",
    ]);
    expect(mono("See /src/app/main.rs:42:7 and /tmp/shots/.")).toEqual(["/src/app/main.rs:42:7", "/tmp/shots/"]);
  });

  it("sets a relative path to a file apart, but not a bare word with a dot or a slash", () => {
    expect(mono("Edit web/src/components/HandoverCards.tsx:185 first.")).toEqual(["web/src/components/HandoverCards.tsx:185"]);
    expect(mono("Either/or, e.g. yes/no/maybe, at v1.2/v1.3 or 24/7.")).toEqual([]);
    // One name under a slash is a command or a figure of speech, not a folder.
    expect(mono("Run /release and/or wait.")).toEqual([]);
    expect(mono("Read https://example.com/docs/guide.html first.")).toEqual([]);
  });

  it("sets branch names apart by their prefix", () => {
    expect(mono("Base develop; commit on feature/mission-65cab78f, never origin/main or fix/login."))
      .toEqual(["feature/mission-65cab78f", "origin/main", "fix/login"]);
  });

  it("sets a commit apart, but not a year or a word that happens to be hex", () => {
    expect(mono("Base 81603b4c35b24789c0f885d8be4b2d16962f6cd9, was 81603b4 in 2026; defaced and 1234567 stay."))
      .toEqual(["81603b4c35b24789c0f885d8be4b2d16962f6cd9", "81603b4"]);
  });

  it("takes a span the agent put in backticks as code, without the ticks", () => {
    expect(briefRuns("Run `pnpm --dir web test` before `git commit`.")).toEqual([
      { text: "Run ", mono: false },
      { text: "pnpm --dir web test", mono: true },
      { text: " before ", mono: false },
      { text: "git commit", mono: true },
      { text: ".", mono: false },
    ]);
    // An unclosed tick is a character like any other.
    expect(briefRuns("Mind the ` key.")).toEqual([{ text: "Mind the ` key.", mono: false }]);
  });

  it("loses nothing: the runs joined are the brief, a code fence included", () => {
    const plain = "Fix (agent_ee96a6613d0c) in /src/app on fix/login.\n\n  Then stop.";
    expect(joined(plain)).toBe(plain);
    const fenced = "Run:\n```\ncargo test\n```\nin /src/app";
    expect(joined(fenced)).toBe(fenced);
    expect(mono(fenced)).toEqual(["/src/app"]);
  });
});
