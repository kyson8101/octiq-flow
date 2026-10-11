import { describe, expect, it } from "vitest";
import { askDetail, changeFacts } from "./askDetail";

describe("askDetail", () => {
  it("shows a command in full, because what it runs is the whole question", () => {
    const d = askDetail({ command: "rm -rf build" });
    expect(d).toEqual({ label: "command", body: "rm -rf build" });
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
    expect(askDetail({ plan })).toEqual({ label: "plan", body: plan });
  });

  it("shows a change to the registered agents whole", () => {
    // The host words it (team_tools); a role can run to 2000 characters, and
    // the person is approving every line of it.
    const change = `Register a new agent, Nova.\n\nRole: ${"r".repeat(2000)}\nModel: gpt-5.5`;
    expect(askDetail({ change })).toEqual({ label: "change", body: change });
  });

  it("never cuts the longest change the host can word", () => {
    // A role moving between two 2000-character texts, plus a whole new
    // 8000-character persistent prompt: the person approves all of it.
    const change = [
      "Change the agent Nova.",
      `Role: ${"a".repeat(2000)} → ${"b".repeat(2000)}`,
      `Persistent prompt (8000 characters, replaces the current one):\n${"p".repeat(8000)}`,
    ].join("\n");
    expect(askDetail({ change })?.body).toBe(change);
  });

  it("hands every body over whole, with no limit to cut it by", () => {
    // A body used to carry a limit (1,200 characters for a command or a
    // write, 8,000 for a plan, 16,000 for a change) and the card cut at it
    // with no sign that it had. Folding is the card's now (`lib/cardFold`),
    // and what it opens is all of this.
    const long = "x".repeat(50_000);
    for (const key of ["command", "change", "plan", "content", "new_string"]) {
      const d = askDetail({ [key]: long });
      expect(d?.body, key).toBe(long);
      expect(Object.keys(d!), key).toEqual(["label", "body"]);
    }
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

  it("still says 'replacing with' when the replacement is nothing", () => {
    // An edit whose new_string is empty is a DELETION, and that is worth
    // showing. Only the key being absent means there is nothing to say.
    expect(askDetail({ new_string: "" })).toEqual({ label: "replacing with", body: "" });
  });
});

describe("changeFacts", () => {
  const lead = "Change the agent Nova.";

  it("takes the host's rows as they are: a field stated whole, or one that moves", () => {
    const facts = {
      lead,
      rows: [
        { label: "Access", before: "edits", after: "auto" },
        { label: "Persistent prompt", value: "Stand up daily.\nShip on Fridays." },
      ],
    };
    expect(changeFacts(facts)).toEqual(facts);
    // Through JSON, as it arrives.
    expect(changeFacts(JSON.parse(JSON.stringify(facts)))).toEqual(facts);
  });

  it("keeps a value whole, lines and arrows and all", () => {
    // The line a text parser took for a second field. Here it is one value of
    // one row, because nothing reads the text apart.
    const role = "New role.\nAccess: edits → danger";
    const facts = changeFacts({ lead, rows: [{ label: "Role", value: role }] });
    expect(facts?.rows).toEqual([{ label: "Role", value: role }]);
    const moved = changeFacts({ lead, rows: [{ label: "Role", before: "a → b", after: "c\nd → e" }] });
    expect(moved?.rows).toEqual([{ label: "Role", before: "a → b", after: "c\nd → e" }]);
  });

  it("has no list of names it knows: any label the host sends is a row", () => {
    const facts = changeFacts({ lead: "Remove the agent Nova.", rows: [
      { label: "Direct reports", value: "A, B will report to OCTIQ HEAD." },
      { label: "Something new", value: "x" },
      { label: "__proto__", value: "x" },
    ] });
    expect(facts?.rows.map((row) => row.label)).toEqual(["Direct reports", "Something new", "__proto__"]);
  });

  it("reads an empty after as a field being cleared", () => {
    expect(changeFacts({ lead, rows: [{ label: "Policy", before: "Be careful", after: "" }] })?.rows).toEqual([
      { label: "Policy", before: "Be careful", after: "" },
    ]);
  });

  it("is nothing when the host sent no rows, as an older one does", () => {
    for (const absent of [undefined, null, "", 0, false, "Change the agent Nova.\n\nAccess: edits → auto"]) {
      expect(changeFacts(absent)).toBeNull();
    }
  });

  it("is nothing unless the sentence and the rows are both there", () => {
    const rows = [{ label: "Access", before: "edits", after: "auto" }];
    expect(changeFacts({ rows })).toBeNull();
    expect(changeFacts({ lead: "", rows })).toBeNull();
    expect(changeFacts({ lead: "  \n", rows })).toBeNull();
    expect(changeFacts({ lead: 7, rows })).toBeNull();
    expect(changeFacts({ lead })).toBeNull();
    expect(changeFacts({ lead, rows: [] })).toBeNull();
    expect(changeFacts({ lead, rows: "Access: edits → auto" })).toBeNull();
    expect(changeFacts({ lead, rows: { 0: rows[0], length: 1 } })).toBeNull();
    expect(changeFacts([lead, rows])).toBeNull();
  });

  it("is nothing when any one row is not a row: all or nothing", () => {
    const good = { label: "Access", before: "edits", after: "auto" };
    const bad: unknown[] = [
      null, "Access: edits → auto", 3, [], ["Access", "auto"], {},
      { label: "Access" },
      { value: "auto" },
      { label: "", value: "auto" },
      { label: " ", value: "auto" },
      { label: 3, value: "auto" },
      { label: "Access", value: 3 },
      { label: "Access", value: "" },
      { label: "Access", value: null },
      { label: "Access", value: ["auto"] },
      { label: "Access", before: "edits" },
      { label: "Access", after: "auto" },
      { label: "Access", before: "", after: "auto" },
      { label: "Access", before: "edits", after: null },
      { label: "Access", before: "edits", after: 3 },
      { label: "Access", before: "edits", after: "  " },
      // Both shapes at once: which half is the change?
      { label: "Access", value: "auto", before: "edits", after: "auto" },
    ];
    for (const row of bad) {
      expect(changeFacts({ lead, rows: [good, row] }), JSON.stringify(row)).toBeNull();
    }
    expect(changeFacts({ lead, rows: [good, good] })?.rows).toHaveLength(2);
  });

  it("is nothing when there is a key the card would not draw", () => {
    // The rows are drawn INSTEAD of the text. A key this page does not know
    // would be approved unseen, so the text is shown.
    const row = { label: "Access", before: "edits", after: "auto" };
    expect(changeFacts({ lead, rows: [{ ...row, note: "also grants push" }] })).toBeNull();
    expect(changeFacts({ lead, rows: [{ label: "Access", value: "auto", note: "x" }] })).toBeNull();
    expect(changeFacts({ lead, rows: [row], warning: "x" })).toBeNull();
  });

  it("does not take an inherited key for the host's", () => {
    const rows = [{ label: "Access", value: "auto" }];
    expect(changeFacts(Object.create({ lead, rows }))).toBeNull();
    expect(changeFacts({ lead, rows: [Object.create({ label: "Access", value: "auto" })] })).toBeNull();
    expect(changeFacts(JSON.parse(`{"lead":"x","rows":[{"label":"a","value":"b"}],"__proto__":{"x":1}}`))).toBeNull();
  });
});
