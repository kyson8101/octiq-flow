import { describe, expect, it } from "vitest";
import { askDetail, changeFacts, isCommand, rowSummary, SUMMARY_MAX } from "./askDetail";

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
    // A summary a prototype lent the row is not the host's either.
    const lent = Object.assign(Object.create({ summary: "Nothing changes" }), { label: "Access", value: "auto" });
    expect(changeFacts({ lead, rows: [lent] })?.rows).toEqual([{ label: "Access", value: "auto" }]);
  });
});

describe("a row's summary", () => {
  const lead = "Remove the agent HEAD.";
  const value = `${Array.from({ length: 300 }, (_, i) => `Report ${i + 1}`).join(", ")} will report to Potato Juice.`;
  const summary = "300 direct reports will report to Potato Juice";
  const row = (extra: Record<string, unknown>) => changeFacts({ lead, rows: [{ label: "Direct reports", value, ...extra }] })?.rows;

  it("is kept when it is one line of at most 160 characters", () => {
    // The host's own example (`team_tools`, task K).
    expect(row({ summary })).toEqual([{ label: "Direct reports", value, summary }]);
    expect(rowSummary("s".repeat(SUMMARY_MAX))).toBe("s".repeat(SUMMARY_MAX));
    // Characters, as the host counts them: 160 emoji are 320 units and fit.
    expect(rowSummary("😀".repeat(SUMMARY_MAX))).toBe("😀".repeat(SUMMARY_MAX));
    // Whichever order the keys arrive in.
    expect(changeFacts(JSON.parse(JSON.stringify({ lead, rows: [{ summary, value, label: "Direct reports" }] })))?.rows)
      .toEqual([{ label: "Direct reports", value, summary }]);
  });

  it("is dropped when it is not, and the row is still a row", () => {
    const bad: unknown[] = [
      "s".repeat(SUMMARY_MAX + 1), "😀".repeat(SUMMARY_MAX + 1), "two\nlines", "two\r\nlines", "a\rb", "a b",
      "", "   ", 300, null, true, ["300 reports"], { text: "300 reports" },
    ];
    for (const item of bad) {
      // No summary, never no rows: the value it stood for is still there to open.
      expect(row({ summary: item }), JSON.stringify(item)).toEqual([{ label: "Direct reports", value }]);
      expect(rowSummary(item), JSON.stringify(item)).toBeUndefined();
    }
  });

  it("is absent on a host that sends none", () => {
    expect(row({})).toEqual([{ label: "Direct reports", value }]);
    expect(Object.keys(row({})![0])).toEqual(["label", "value"]);
  });

  it("is the only key a stated value may have besides its own", () => {
    expect(row({ summary, note: "also grants push" })).toBeUndefined();
    expect(changeFacts({ lead, rows: [{ label: "Role", summary }] })).toBeNull();
    expect(changeFacts({ lead, rows: [{ summary }] })).toBeNull();
  });

  it("is an unknown key on a move, which the host never puts one on", () => {
    // Unknown keys cost the rows: the card would draw the move and not the
    // line beside it, so it shows the text instead.
    expect(changeFacts({ lead, rows: [{ label: "Role", before: "a\nb", after: "c", summary: "Role shortened" }] })).toBeNull();
    expect(changeFacts({ lead, rows: [{ label: "Role", before: "a", after: "", summary: 3 }] })).toBeNull();
  });

  it("reads the rows the host really sends", () => {
    // `team_tools::delete_facts`, as its own tests print it (task K).
    const sent = JSON.parse('{"lead":"Remove the agent Lead.","rows":[{"label":"Role","value":"Writes code."},'
      + '{"label":"Reports to","value":"Manager"},'
      + '{"label":"Direct reports","value":"Report 000, Report 001 will report to Manager.","summary":"2 direct reports will report to Manager"},'
      + '{"label":"Memory note","value":"Kept in the vault."}]}');
    const facts = changeFacts(sent);
    expect(facts?.rows).toHaveLength(4);
    expect(facts?.rows[2]).toEqual({
      label: "Direct reports", value: "Report 000, Report 001 will report to Manager.", summary: "2 direct reports will report to Manager",
    });
  });
});

describe("what runs", () => {
  it("is a command under any of the names tools give it", () => {
    expect(askDetail({ command: "ls" })).toEqual({ label: "command", body: "ls" });
    expect(askDetail({ script: "make\nmake install" })).toEqual({ label: "script", body: "make\nmake install" });
    expect(askDetail({ code: "await page.goto(url)" })).toEqual({ label: "code", body: "await page.goto(url)" });
    for (const key of ["command", "script", "code"]) expect(isCommand(askDetail({ [key]: "x" })), key).toBe(true);
    // The command comes first when a call names more than one.
    expect(askDetail({ code: "x", command: "y" })?.label).toBe("command");
  });

  it("is not a plan, a change or what a write puts in a file", () => {
    for (const key of ["plan", "change", "content", "new_string"]) {
      expect(isCommand(askDetail({ [key]: "one\ntwo" })), key).toBe(false);
    }
    expect(isCommand(null)).toBe(false);
  });
});
