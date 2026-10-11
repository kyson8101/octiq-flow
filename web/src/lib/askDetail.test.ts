import { describe, expect, it } from "vitest";
import { askDetail, changeFacts } from "./askDetail";

describe("askDetail", () => {
  it("shows a command in full, because what it runs is the whole question", () => {
    const d = askDetail({ command: "rm -rf build" });
    expect(d).toEqual({ label: "command", body: "rm -rf build", limit: 1200 });
  });

  it("shows what a write is about to put in the file", () => {
    expect(askDetail({ content: "hello" })?.label).toBe("content");
    expect(askDetail({ new_string: "after" })?.label).toBe("replacing with");
  });

  it("shows the plan ExitPlanMode is asking you to approve", () => {
    // Plan mode reaches this card and nowhere else. `ExitPlanMode` arrives as
    // an ordinary permission question whose only argument is the plan, so a
    // card that cannot read `plan` shows three buttons and no plan — approval
    // for something you were never shown.
    const plan = "## Step 1\nAdd the flag.\n\n## Step 2\nPrint and exit.";
    expect(askDetail({ plan })).toEqual({ label: "plan", body: plan, limit: 8000 });
  });

  it("shows a change to the registered agents whole", () => {
    // The host words it (team_tools); a role can run to 2000 characters, and
    // the person is approving every line of it.
    const change = `Register a new agent, Nova.\n\nRole: ${"r".repeat(2000)}\nModel: gpt-5.5`;
    expect(askDetail({ change })).toEqual({ label: "change", body: change, limit: 16000 });
  });

  it("never cuts the longest change the host can word", () => {
    // A role moving between two 2000-character texts, plus a whole new
    // 8000-character persistent prompt: the person approves all of it.
    const change = [
      "Change the agent Nova.",
      `Role: ${"a".repeat(2000)} → ${"b".repeat(2000)}`,
      `Persistent prompt (8000 characters, replaces the current one):\n${"p".repeat(8000)}`,
    ].join("\n");
    const d = askDetail({ change });
    expect(d && d.body.slice(0, d.limit)).toBe(change);
  });

  it("does not trim a plan to the length of a file preview", () => {
    // A preview is a sample and may stop early. A plan is the thing being
    // decided, and one cut off part-way cannot be judged at all.
    const long = "x".repeat(5000);
    const d = askDetail({ plan: long });
    expect(d!.limit).toBeGreaterThan(long.length);
    expect(askDetail({ content: long })!.limit).toBeLessThan(long.length);
  });

  it("says nothing rather than dumping arguments it does not understand", () => {
    expect(askDetail({ file_path: "/tmp/a" })).toBeNull();
    expect(askDetail({})).toBeNull();
    expect(askDetail(null)).toBeNull();
    expect(askDetail(undefined)).toBeNull();
  });

  it("ignores an argument that is present but empty", () => {
    // Arguments stream in as JSON fragments, so an empty string is a value that
    // has not arrived yet, not a value of its own.
    expect(askDetail({ command: "" })).toBeNull();
    expect(askDetail({ plan: "" })).toBeNull();
  });

  it("reads a short change as a sentence and its fields", () => {
    expect(changeFacts("Change the agent OCTIQ DEV.\n\nReports to: Potato Juice → OCTIQ HEAD")).toEqual({
      lead: "Change the agent OCTIQ DEV.",
      rows: [{ label: "Reports to", value: "Potato Juice → OCTIQ HEAD", before: "Potato Juice", after: "OCTIQ HEAD" }],
    });
    // A new agent is every field, none of them a move.
    const fresh = "Register a new agent, Nova.\n\nName: Nova\nRole: (none)\nProvider: Codex\nModel: gpt-5.5\n"
      + "Effort: default\nAccess: edits\nAvailable in: Starfall\nReports to: STAR LEAD\nTeam: (none)";
    const facts = changeFacts(fresh);
    expect(facts?.lead).toBe("Register a new agent, Nova.");
    expect(facts?.rows.map((row) => row.label)).toEqual([
      "Name", "Role", "Provider", "Model", "Effort", "Access", "Available in", "Reports to", "Team",
    ]);
    expect(facts?.rows.every((row) => row.before === undefined && row.after === undefined)).toBe(true);
    expect(changeFacts("Change the agent Nova.\n\nPersistent prompt: cleared")?.rows).toEqual([
      { label: "Persistent prompt", value: "cleared" },
    ]);
  });

  it("keeps every character of a change it reads as fields", () => {
    // The card draws the fields INSTEAD of the text, so the fields must be
    // the text: the sentence, a blank line, then each `Label: value` line.
    const change = "Change the agent Nova.\n\nModel: sonnet → opus\nRole: a: b → c\nTeam: (none) → Core";
    const facts = changeFacts(change)!;
    expect([facts.lead, "", ...facts.rows.map((row) => `${row.label}: ${row.value}`)].join("\n")).toBe(change);
    for (const row of facts.rows) expect(`${row.before} → ${row.after}`).toBe(row.value);
  });

  it("leaves a value with more than one arrow as the host wrote it", () => {
    // `a → b → c` is a move with an arrow inside one side, and nothing says
    // which: guessing would put words on the wrong side of the change.
    expect(changeFacts("Change the agent Nova.\n\nRole: a → b → c")?.rows).toEqual([
      { label: "Role", value: "a → b → c" },
    ]);
  });

  it("does not read as fields a change with a line no field claims", () => {
    // A role over two lines: the second belongs to the first and names no
    // field. Shown as text, it loses nothing.
    expect(changeFacts("Change the agent Nova.\n\nRole: Writes notes. → Owns the notes.\nMust not push.")).toBeNull();
    // A persistent prompt, and a policy: a heading, then free text.
    expect(changeFacts(
      "Change the agent Nova.\n\nModel: sonnet → opus\n\nPersistent prompt (12 characters):\nYou are Nova",
    )).toBeNull();
    expect(changeFacts(
      "Set the shared agent policy that every agent's brief starts with.\n\nNew policy (10 characters):\nBe careful",
    )).toBeNull();
    expect(changeFacts("Clear the shared agent policy that every agent's brief starts with.")).toBeNull();
    // No blank line after the sentence, or nothing after it.
    expect(changeFacts("Change the agent Nova.\nModel: sonnet → opus")).toBeNull();
    expect(changeFacts("Change the agent Nova.\n")).toBeNull();
    expect(changeFacts("")).toBeNull();
  });

  it("does not read as fields anything that is not a change", () => {
    expect(changeFacts("rm -rf build")).toBeNull();
    expect(changeFacts('{\n\n"name": "Nova"\n}')).toBeNull();
    expect(changeFacts("## Step 1\n\nAdd the flag.\n\n## Step 2\nPrint and exit.")).toBeNull();
    expect(changeFacts("export const a = 1;\n\nexport const b = 2;")).toBeNull();
  });

  it("does not read as fields a change too long to take in as a list", () => {
    const rows = Array.from({ length: 11 }, (_, i) => `Field ${"abcdefghijk"[i]}: value`).join("\n");
    expect(changeFacts(`Change the agent Nova.\n\n${rows}`)).toBeNull();
    expect(changeFacts(`Change the agent Nova.\n\nRole: ${"r".repeat(2000)}`)).toBeNull();
    // Ten fields, the most the host words, still fit.
    expect(changeFacts(`Change the agent Nova.\n\n${rows.split("\n").slice(0, 10).join("\n")}`)?.rows).toHaveLength(10);
  });

  it("still says 'replacing with' when the replacement is nothing", () => {
    // An edit whose new_string is empty is a DELETION, and that is worth
    // showing. Only the key being absent means there is nothing to say.
    expect(askDetail({ new_string: "" })).toEqual({
      label: "replacing with",
      body: "",
      limit: 1200,
    });
  });
});
