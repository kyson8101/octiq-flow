import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { ReopenedLine, ReopenedNote } from "./ReopenedNote";
import { LiveArrivals } from "./Arrive";
import { emptyChat, reduceChat, type ChatState } from "../lib/chat";
import {
  readTaskReopened, reopenedFoldLabel, reopenedHeadline, stopConfirm, STOPPED_NOTE, type ReopenedStop,
} from "../lib/taskReopened";
import css from "./ReopenedNote.css?raw";
import source from "./ReopenedNote.tsx?raw";
import app from "../App.tsx?raw";

const SPEC = ["Fix the two findings below.", "", "1. The gate must be read from the ledger.", "2. Add the regression test.", "", "Do not touch the Allow gate."].join("\n");

const AT = Date.UTC(2026, 9, 11, 13, 5);

/** The event as the contract writes it. */
const event = (over: Record<string, unknown> = {}) => ({
  type: "octiq_task_reopened", runId: "run_1", taskId: "task_7", title: "L · Run progress", assignee: "OCTIQ FE",
  attempt: 2, spec: SPEC, previousSpecChars: 8000, at: AT, ...over,
});
const reopened = (over: Record<string, unknown> = {}) => readTaskReopened(event(over))!;
const draw = (over: Record<string, unknown> = {}, startOpen = false, live = false) => renderToStaticMarkup(
  <LiveArrivals.Provider value={{ current: live }}><ReopenedNote reopened={reopened(over)} startOpen={startOpen} /></LiveArrivals.Provider>);
/** The line as it is drawn for one reading of the ledger. */
const line = (stop: ReopenedStop, startOpen = true, over: { busy?: boolean; error?: string } = {}) => renderToStaticMarkup(
  <ReopenedLine reopened={reopened()} stop={stop} startOpen={startOpen} {...over} />);
/** What is between the tags. */
const words = (html: string) => html.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();

describe("the event a host writes when a coordinator reopens a task", () => {
  it("is read as the contract sends it", () => {
    expect(reopened()).toEqual({
      id: `reopened-task_7-2-${AT}`, runId: "run_1", taskId: "task_7", title: "L · Run progress", assignee: "OCTIQ FE", attempt: 2,
      spec: SPEC, previousSpecChars: 8000, at: Date.UTC(2026, 9, 11, 13, 5),
    });
  });

  it("takes the assignee and the attempt as the ledger says them too", () => {
    expect(reopened({ assignee: { id: "agent_1", name: "OCTIQ BE" }, attempt: { id: "attempt_x", number: 3 } }))
      .toMatchObject({ assignee: "OCTIQ BE", attempt: 3, id: `reopened-task_7-3-${AT}` });
    // The host's own test event (`orchestration/workspaces.rs`): a task
    // with no registered assignee is `null`, and the line names nobody.
    const sent = readTaskReopened({ type: "octiq_task_reopened", runId: "run_1", taskId: "task_1", title: "Implement", assignee: null,
      attempt: 2, spec: "Address review", previousSpecChars: 25, at: 1_700_000_000_000 })!;
    expect(sent).toMatchObject({ title: "Implement", assignee: null, attempt: 2, spec: "Address review", previousSpecChars: 25 });
    expect(reopenedHeadline(sent)).toBe("Reopened Implement · attempt 2");
    expect(reopenedFoldLabel(sent)).toBe("New instructions · 1 line · was 25 characters");
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
    expect(state.messages[0]).toMatchObject({ id: `reopened-task_7-2-${AT}`, role: "assistant", streaming: false });
    expect(lines(state)).toEqual([{ kind: "reopened", reopened: reopened() }]);
  });

  it("is drawn once however often the same event is read, and once more for the next attempt", () => {
    const once = fold(emptyChat(), event(), event(), event());
    expect(lines(once)).toHaveLength(1);
    // The very same state: nothing for the transcript to draw again.
    expect(reduceChat(once, event())).toBe(once);
    expect(lines(fold(once, event({ attempt: 3 })))).toHaveLength(2);
    // Reopened again before it was dispatched: the host numbers the attempt
    // the reopening will start, so both say attempt 2. The second set of
    // instructions is a second line, never folded into the first.
    const twice = fold(once, event({ at: AT + 60_000, spec: "And one more thing." }));
    expect(lines(twice)).toHaveLength(2);
    expect(lines(twice).map((block) => block.kind === "reopened" && block.reopened.spec)).toEqual([SPEC, "And one more thing."]);
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

  it("offers Stop on the opened line only, never on the folded one", () => {
    expect(draw(), "folded").not.toMatch(/Stop/);
    expect(line({ state: "can" }, false), "folded, with a worker to stop").not.toMatch(/Stop/);
    const opened = line({ state: "can" });
    expect(opened).toContain('<button type="button" class="reopened-note-stop">Stop this task…</button>');
    // Below what was opened: the instructions, then the control.
    expect(opened.indexOf("reopened-note-spec")).toBeLessThan(opened.indexOf("reopened-note-stop"));
    expect(opened).toContain('<div class="reopened-note-actions" data-stop="can">');
  });

  it("keeps Stop off, with the reason beside it, when there is no worker to stop", () => {
    const reason = "No worker is running on this task yet, so there is nothing to stop.";
    const html = line({ state: "cannot", reason });
    expect(html).toMatch(/<button type="button" class="reopened-note-stop" aria-disabled="true" aria-describedby="([^"]+)">Stop this task…<\/button><span id="\1" class="reopened-note-why">No worker is running on this task yet, so there is nothing to stop\.<\/span>/);
    // Before the ledger is read the line says so, and guesses nothing.
    expect(draw({}, true)).toContain("The run&#x27;s ledger has not been read yet.");
    expect(draw({}, true)).toContain('aria-disabled="true"');
  });

  it("says what a stop left, in place of the control", () => {
    const html = line({ state: "stopped", note: STOPPED_NOTE });
    expect(html).not.toContain("<button type=\"button\" class=\"reopened-note-stop\"");
    expect(words(html)).toContain("Stopped by you. Only your Start starts it again: Start is on its row in the run panel.");
    expect(html).toContain('<p class="reopened-note-held" role="status">');
  });

  it("shows the host's own words when a stop is refused, and says it is working while it asks", () => {
    const refused = line({ state: "can" }, true, { error: "No worker is running on this task, so there is nothing to stop." });
    expect(refused).toContain('<p class="reopened-note-error" role="alert">No worker is running on this task, so there is nothing to stop.</p>');
    expect(line({ state: "can" }, true, { busy: true })).toContain('<button type="button" class="reopened-note-stop" disabled="">Stopping…</button>');
  });

  it("asks before it stops, in the app's own dialog and in words that say what follows", () => {
    expect(stopConfirm(reopened())).toEqual({
      title: "Stop this task's worker?",
      body: "L · Run progress: its worker is stopped and the run goes on. The task is then held, and only your Start starts it again.",
      confirmLabel: "Stop worker", cancelLabel: "Keep it running", danger: true,
    });
    // Never the browser's own box.
    expect(source).not.toMatch(/window\.confirm|\bconfirm\(\s*["'`]/);
    expect(source).toContain("await confirm(stopConfirm(reopened))");
    // The command is the page's own, handed down by the app.
    expect(source).toContain("await stopTask(reopened.taskId)");
    expect(app).toContain('await bridge.invoke("orchestration_task_stop", { taskId });');
    expect(app).toContain("<TaskStopContext.Provider value={taskStopping}>");
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
