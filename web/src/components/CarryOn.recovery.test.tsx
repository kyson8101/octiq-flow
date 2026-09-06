import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { CarryOn } from "./CarryOn";
import type { RecoveryEvidence } from "../lib/recovery";

const evidence: RecoveryEvidence = { connected: true, rosterKnown: true, busy: true, live: false };
const render = (overrides: Partial<RecoveryEvidence> = {}) => renderToStaticMarkup(<CarryOn onCarryOn={() => {}} evidence={{ ...evidence, ...overrides }} />);

describe("recovery strip", () => {
  it("shows recorded checkpoint and queue without a save guarantee", () => {
    const html = render({ checkpointSeq: 42, queuedCount: 2 });
    expect(html).toContain("#42");
    expect(html).toContain("2 queued messages recorded");
    expect(html).toContain("does not confirm file saves");
    expect(html).toContain("<button");
    expect(html).not.toContain("Nothing was lost");
  });
  it("does not invent checkpoints or pending counts when unknown", () => {
    const html = render();
    expect(html).not.toContain("transcript event");
    expect(html).not.toContain("queued messages");
  });
  it("shows disconnected state without a recovery action", () => {
    const html = render({ connected: false });
    expect(html).toContain("may still be working");
    expect(html).not.toContain("<button");
    expect(html).not.toContain("server reports no active");
  });
  it("shows an observed exit code and suppresses itself for a live room", () => {
    expect(render({ exited: { code: 137 } })).toContain("exited with code 137");
    expect(render({ live: true })).toBe("");
  });
});
