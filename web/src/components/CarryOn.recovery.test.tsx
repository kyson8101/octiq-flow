import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { CarryOn } from "./CarryOn";
import type { RecoveryEvidence } from "../lib/recovery";

const evidence: RecoveryEvidence = { connected: true, rosterKnown: true, busy: true, live: false };
const render = (overrides: Partial<RecoveryEvidence> = {}) => renderToStaticMarkup(<CarryOn onCarryOn={() => {}} evidence={{ ...evidence, ...overrides }} />);

describe("recovery strip", () => {
  it("compacts checkpoint, queue, and save uncertainty into metadata", () => {
    const html = render({ exited: { code: null }, checkpointSeq: 42, queuedCount: 2 });
    expect(html).toContain("Agent is no longer running");
    expect(html).toContain("Last event #42");
    expect(html).toContain("2 messages queued");
    expect(html).toContain("File saves unverified");
    expect(html).toContain("<button");
    expect(html).toContain('aria-label="Carry on. Check completed actions before resuming."');
    expect(html).not.toContain("Nothing was lost");
  });
  it("keeps the checkpoint but omits zero-value queue noise", () => {
    const html = render({ exited: { code: null }, checkpointSeq: 1479, queuedCount: 0 });
    expect(html).toContain("Last event #1479");
    expect(html).not.toContain("message queued");
    expect(html).not.toContain("messages queued");
  });
  it("shows disconnected state without a recovery action", () => {
    const html = render({ connected: false });
    expect(html).toContain("may still be working");
    expect(html).not.toContain("<button");
    expect(html).not.toContain("server reports no active");
  });
  it("shows an observed exit code and suppresses itself for a live chat", () => {
    expect(render({ exited: { code: 137 } })).toContain("Exit code 137");
    expect(render({ live: true })).toBe("");
  });
});
