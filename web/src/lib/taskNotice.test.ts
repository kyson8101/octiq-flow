// The reports background work sends back, verbatim.
//
// Every string below is copied out of a real transcript
// (`~/.claude/projects/*/*.jsonl`, `type: "user"` with
// `origin.kind: "task-notification"`). Four shapes turn up there and they do
// not agree on which tags they carry, which is the whole reason this reader
// exists rather than one regex at the call site.
import { describe, expect, it } from "vitest";

import { parseTaskNotice } from "./taskNotice";

/** A `run_in_background` command that ran to the end. The common one, and the
 *  only shape that names the call it came from. */
const COMMAND = `<task-notification>
<task-id>ba0qlummq</task-id>
<tool-use-id>toolu_01KNjbrBrKQUxxmsv7oMQwBR</tool-use-id>
<output-file>/private/tmp/claude-501/-Users-kyson-03-projects-starfall/ad5f6005/tasks/ba0qlummq.output</output-file>
<status>completed</status>
<summary>Background command "Launch Codex to revise ch11 outline per author decisions" completed (exit code 0)</summary>
</task-notification>`;

/** The same, gone wrong. */
const FAILED = `<task-notification>
<task-id>b4s0cwfb7</task-id>
<tool-use-id>toolu_017bDS6iEmnjydcCNM67cvhW</tool-use-id>
<output-file>/private/tmp/claude-501/-Users-kyson-03-projects-octiq-flow/e34cc1bd/tasks/b4s0cwfb7.output</output-file>
<status>failed</status>
<summary>Background command "Wait for relaunch and confirm PTYs spawn" failed with exit code 144</summary>
</task-notification>`;

/** A Task subagent finishing. It names no call — the agent rail tracks these
 *  by task id — and it carries the agent's whole answer inside it. */
const AGENT = `<task-notification>
<task-id>aa78c1bd6c1ddba85</task-id>
<output-file>/private/tmp/claude-501/-Users-kyson/5519e8fe/tasks/aa78c1bd6c1ddba85.output</output-file>
<status>completed</status>
<summary>Agent "Find employee criteria evaluation logic" finished</summary>
<note>A task-notification fires each time this agent stops with no live background children of its own.</note>
<result>## Findings: Employee Criteria AND/OR semantics</result>
</task-notification>`;

/** A Monitor speaking up. Not an ending at all, so it has no status — and it
 *  ends with a line of plain instruction OUTSIDE any tag. */
const MONITOR = `<task-notification>
<task-id>bo9sgde65</task-id>
<summary>Monitor event: "integration test build + run progress and failures"</summary>
<event>Error Message:
Error Message:</event>
If this event is something the user would act on now, send a PushNotification. Routine or benign output doesn't need one.
</task-notification>`;

describe("a background task reporting back", () => {
  it("reads a finished command, and the call that started it", () => {
    expect(parseTaskNotice(COMMAND)).toEqual({
      taskId: "ba0qlummq",
      toolUseId: "toolu_01KNjbrBrKQUxxmsv7oMQwBR",
      outputFile:
        "/private/tmp/claude-501/-Users-kyson-03-projects-starfall/ad5f6005/tasks/ba0qlummq.output",
      status: "completed",
      summary:
        'Background command "Launch Codex to revise ch11 outline per author decisions" completed (exit code 0)',
    });
  });

  it("keeps the outcome word, which is the difference that matters", () => {
    expect(parseTaskNotice(FAILED)?.status).toBe("failed");
    expect(parseTaskNotice(FAILED)?.summary).toContain("exit code 144");
  });

  it("reads a subagent's, which names no call", () => {
    const notice = parseTaskNotice(AGENT);
    expect(notice?.taskId).toBe("aa78c1bd6c1ddba85");
    expect(notice?.toolUseId).toBeUndefined();
    expect(notice?.summary).toBe('Agent "Find employee criteria evaluation logic" finished');
  });

  it("reads a monitor's, which is news rather than an ending", () => {
    const notice = parseTaskNotice(MONITOR);
    expect(notice?.taskId).toBe("bo9sgde65");
    expect(notice?.status).toBeUndefined();
    expect(notice?.summary).toBe(
      'Monitor event: "integration test build + run progress and failures"',
    );
  });

  it("is not fooled by someone quoting one", () => {
    expect(parseTaskNotice("look at this: <task-notification>\n<task-id>x</task-id>")).toBeNull();
    expect(parseTaskNotice("what does <task-notification> mean")).toBeNull();
    expect(parseTaskNotice("")).toBeNull();
  });
});
