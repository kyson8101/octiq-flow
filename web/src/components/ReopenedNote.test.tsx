import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { ReopenedNote } from "./ReopenedNote";
import { LiveArrivals } from "./Arrive";
import { emptyChat, reduceChat, type ChatState } from "../lib/chat";
import { readTaskReopened, reopenedFoldLabel, reopenedHeadline } from "../lib/taskReopened";
import css from "./ReopenedNote.css?raw";

const SPEC = ["Fix the two findings below.", "", "1. The gate must be read from the ledger.", "2. Add the regression test.", "", "Do not touch the Allow gate."].join("\n");

/** The event as the contract writes it. */
const event = (over: Record<string, unknown> = {}) => ({
  type: "octiq_task_reopened", runId: "run_1", taskId: "task_7", title: "L · Run progress", assignee: "OCTIQ FE",
  attempt: 2, spec: SPEC, previousSpecChars: 8000, at: Date.UTC(2026, 9, 11, 13, 5), ...over,
});
const reopened = (over: Record<string, unknown> = {}) => readTaskReopened(event(over))!;
const draw = (over: Record<string, unknown> = {}, startOpen = false, live = false) => renderToStaticMarkup(
  <LiveArrivals.Provider value={{ current: live }}><ReopenedNote reopened={reopened(over)} startOpen={startOpen} /></LiveArrivals.Provider>);
/** What is between the tags. */
const words = (html: string) => html.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();

describe("the event a host writes when a coordinator reopens a task", () => {
  it("is read as the contract sends it", () => {
    expect(reopened()).toEqual({
      id: "reopened-task_7-2", runId: "run_1", taskId: "task_7", title: "L · Run progress", assignee: "OCTIQ FE", attempt: 2,
      spec: SPEC, previousSpecChars: 8000, at: Date.UTC(2026, 9, 11, 13, 5),
    });
  });

  it("takes the assignee and the attempt as the ledger says them too", () => {
    expect(reopened({ assignee: { id: "agent_1", name: "OCTIQ BE" }, attempt: { id: "attempt_x", number: 3 } }))
      .toMatchObject({ assignee: "OCTIQ BE", attempt: 3, id: "reopened-task_7-3" });
    expect(readTaskReopened({ run_id: "r", task_id: "t", previous_spec_chars: 12 })).toMatchObject({ runId: "r", taskId: "t", previousSpecChars: 12 });
  });

  it("leaves out what the host did not send, and invents nothing", () => {
    const bare = readTaskReopened({ runId: "run_1", taskId: "task_7" })!;
    expect(bare).toMatchObject({ title: "a task", assignee: null, attempt: null, spec: "", previousSpecChars: null, at: null });
    expect(reopenedHeadline(bare)).toBe("Reopened a task");
    expect(reopenedFoldLabel(bare)).toBeNull();
    expect(reopened({ attempt: 0 }).attempt).toBeNull();
    expect(reopened({ attempt: "two", previousSpecChars: -4 })).toMatchObject({ attempt: null, previousSpecChars: null });
  });

  it("is nothing without a task to name", () => {
    expect(readTaskReopened({ runId: "run_1" })).toBeNull();
    expect(readTaskReopened({ taskId: "task_7" })).toBeNull();
    expect(readTaskReopened({})).toBeNull();
  });

  it("says which task, for whom and which attempt, and how much is behind the line", () => {
    expect(reopenedHeadline(reopened())).toBe("Reopened L · Run progress for OCTIQ FE · attempt 2");
    expect(reopenedHeadline(reopened({ assignee: undefined }))).toBe("Reopened L · Run progress · attempt 2");
    expect(reopenedFoldLabel(reopened())).toBe("New instructions · 6 lines · was 8,000 characters");
    expect(reopenedFoldLabel(reopened({ previousSpecChars: undefined, spec: "One line." }))).toBe("New instructions · 1 line");
  });
});

describe("the chat's record of it", () => {
  const fold = (state: ChatState, ...events: object[]) => events.reduce<ChatState>((held, item) => reduceChat(held, item), state);
  const lines = (state: ChatState) => state.messages.flatMap((message) => message.blocks.filter((block) => block.kind === "reopened"));

  it("is one line of its own in the transcript, where it happened", () => {
    const state = fold(emptyChat(), event());
    expect(state.messages).toHaveLength(1);
    expect(state.messages[0]).toMatchObject({ id: "reopened-task_7-2", role: "assistant", streaming: false });
    expect(lines(state)).toEqual([{ kind: "reopened", reopened: reopened() }]);
  });

  it("is drawn once however often the same event is read, and once more for the next attempt", () => {
    const once = fold(emptyChat(), event(), event(), event());
    expect(lines(once)).toHaveLength(1);
    // The very same state: nothing for the transcript to draw again.
    expect(reduceChat(once, event())).toBe(once);
    expect(lines(fold(once, event({ attempt: 3 })))).toHaveLength(2);
    expect(lines(fold(emptyChat(), event({ taskId: "task_8" }), event()))).toHaveLength(2);
  });

  it("changes nothing for an event that names no task", () => {
    const state = emptyChat();
    expect(reduceChat(state, { type: "octiq_task_reopened", title: "x" })).toBe(state);
  });
});

describe("the reopened line", () => {
  it("is one folded line: what happened, how much is behind it, and the one control", () => {
    const html = draw();
    // Then the time it happened, in the reader's own clock.
    expect(words(html)).toMatch(/^Reopened L · Run progress for OCTIQ FE · attempt 2 New instructions · 6 lines · was 8,000 characters \d{1,2}:05( [AP]M)?$/);
    // The time is the last thing said before the control, never past it.
    expect(html).toMatch(/<span>\d{1,2}:05( [AP]M)?<\/span><\/span><button type="button" class="card-fold-toggle"/);
    // A host that sent no time: the line says none.
    expect(words(draw({ at: undefined }))).toBe("Reopened L · Run progress for OCTIQ FE · attempt 2 New instructions · 6 lines · was 8,000 characters");
    expect(html.match(/<button /g)).toHaveLength(1);
    expect(html).toMatch(/<button type="button" class="card-fold-toggle" aria-expanded="false" aria-controls="[^"]+" aria-describedby="[^"]+" aria-label="Show the new instructions"/);
    // Folded: not a word of the coordinator's prose is on the page.
    expect(html).not.toContain("Fix the two findings");
    expect(html).not.toContain("Allow gate");
    expect(html).toMatch(/<div id="[^"]+" class="card-fold reopened-note-body" hidden=""><\/div>/);
  });

  it("opens to the instructions whole, every line of them", () => {
    const html = draw({}, true);
    expect(html).toContain('aria-expanded="true"');
    expect(html).toContain(`<pre class="reopened-note-spec is-whole">${SPEC}</pre>`);
    // In the conversation's own scroll: no second one inside the line.
    expect(html).not.toContain("is-bounded");
    const long = Array.from({ length: 400 }, (_, index) => `Line ${index + 1} of the brief.`).join("\n");
    const opened = draw({ spec: long }, true);
    expect(opened).toContain("New instructions · 400 lines");
    expect(opened).toContain("Line 400 of the brief.");
    expect(opened.match(/Line \d+ of the brief\./g)).toHaveLength(400);
  });

  it("offers nothing to open when the host sent no instructions", () => {
    const html = draw({ spec: "" });
    expect(html).not.toContain("<button");
    expect(words(html)).toContain("Reopened L · Run progress for OCTIQ FE · attempt 2");
    expect(html).not.toContain("New instructions");
  });

  it("offers no Stop: the page has no command for it in the contract", () => {
    expect(draw({}, true)).not.toMatch(/>\s*Stop/);
  });

  it("enters once as it is said, and is drawn still when the chat is read back", () => {
    expect(draw({}, false, true)).toContain('class="reopened-note enter-rise"');
    expect(draw({}, false, false)).toContain('class="reopened-note"');
  });

  it("names its task to a screen reader in the line's own words", () => {
    expect(draw()).toContain('role="group" aria-label="Reopened L · Run progress for OCTIQ FE · attempt 2"');
  });

  it("takes no decision colour, no warning colour and no accent: nothing is asked", () => {
    const code = css.replace(/\/\*[\s\S]*?\*\//g, "");
    expect(code).not.toMatch(/--(decide|warn|danger|accent|ok)\b/);
    expect(code).not.toMatch(/#[0-9a-f]{3,8}\b/i);
    expect(code).not.toMatch(/animation|transition/);
  });
});
