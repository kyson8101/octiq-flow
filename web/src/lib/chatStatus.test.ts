import { describe, expect, it } from "vitest";
import {
  filterVisibleChatNotices,
  isInternalCodexDiagnostic,
  shouldShowChatStatus,
} from "./chatStatus";

describe("chat status visibility", () => {
  it("keeps Codex's non-actionable missing-tool-output recovery in diagnostics", () => {
    const text = "2026-09-07T06:14:14.818956Z ERROR codex_core::util: Custom tool call output is missing for call id: call_CbLzI22sSJjAXpJ5ttjxlJ0x";

    expect(isInternalCodexDiagnostic(text)).toBe(true);
    expect(shouldShowChatStatus("stderr", text)).toBe(false);
  });

  it("hides a late write to a Codex tool process that has already exited", () => {
    const text = "2026-09-07T08:29:34.050136Z ERROR codex_core::tools::router: error=write_stdin failed: Unknown process id 29017";

    expect(isInternalCodexDiagnostic(text)).toBe(true);
    expect(shouldShowChatStatus("stderr", text)).toBe(false);
  });

  it("hides the stderr copy of a collaboration spawn failure", () => {
    const text = "2026-09-14T18:14:29.286752Z ERROR codex_core::tools::router: error=collab spawn failed: agent thread limit reached";

    expect(isInternalCodexDiagnostic(text)).toBe(true);
    expect(shouldShowChatStatus("stderr", text)).toBe(false);
  });

  it("hides a coloured exec failure that the agent can recover from", () => {
    const text = "\u001b[2m2026-09-19T23:56:22.037052Z\u001b[0m \u001b[31mERROR\u001b[0m \u001b[2mcodex_core::tools::router\u001b[0m\u001b[2m:\u001b[0m \u001b[3merror\u001b[0m\u001b[2m=\u001b[0mexec_command failed: CreateProcess { message: \"Rejected(\\\"Failed to create unified exec process: No such file or directory (os error 2)\\\")\" }";

    expect(isInternalCodexDiagnostic(text)).toBe(true);
    expect(shouldShowChatStatus("stderr", text)).toBe(false);
  });

  it("hides every Codex tool-router failure, including unfamiliar ones", () => {
    const text = "2026-09-20T02:00:00Z ERROR codex_core::tools::router: error=a future tool failed in a new way";

    expect(isInternalCodexDiagnostic(text)).toBe(true);
    expect(shouldShowChatStatus("stderr", text)).toBe(false);
  });

  it("hides source and command lines belonging to a router diagnostic", () => {
    const notices = [
      "2026-09-20T01:27:46Z ERROR codex_core::tools::router: error=apply_patch verification failed:",
      "fn codex_exec_rejection_without_a_printed_command_is_diagnostics_only() {",
      "2026-09-20T01:27:47Z ERROR codex_core::auth: token expired",
    ];

    expect(filterVisibleChatNotices(notices)).toEqual([notices[2]]);
  });

  it("keeps Codex's non-actionable rollout persistence race in diagnostics", () => {
    const raw = "2026-09-19T00:58:33.103466Z ERROR codex_core::session: failed to record rollout items: thread 01a0b6d4-ccd8-7cb1-be3d-407ccd10a162 not found";
    const legacy = "Codex could not save some conversation history because its session record was unavailable.";

    expect(shouldShowChatStatus("stderr", raw)).toBe(false);
    expect(shouldShowChatStatus("stderr", legacy)).toBe(false);
  });

  it("leaves real errors and process exits alone", () => {
    expect(shouldShowChatStatus("stderr", "write_stdin failed: Unknown process id 29017")).toBe(true);
    expect(shouldShowChatStatus("stderr", "Error loading config.toml")).toBe(true);
    expect(shouldShowChatStatus("exit", "")).toBe(true);
  });
});
