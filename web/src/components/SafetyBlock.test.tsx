import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

vi.mock("../lib/bridge", () => ({
  bridge: { invoke: async () => true },
}));

import {
  allowOnceReply,
  LOCAL_ONLY_REPLY,
  SAFER_APPROACH_REPLY,
  saferReply,
  SafetyBlock,
  type SafetyBlockNotice,
} from "./SafetyBlock";

const block: SafetyBlockNotice = {
  id: "blocked-1",
  chatKey: "chat:c1",
  kind: "external-data",
  title: "Codex blocked external data sharing",
  summary: "This would send outline and constraints to DeepSeek/OpenCode.",
  detail: "The safety reviewer requires explicit approval before this external transfer.",
};

const draw = (startOpen = false) =>
  renderToStaticMarkup(
    <SafetyBlock block={block} onContinue={() => {}} onAnswered={() => {}} startOpen={startOpen} />,
  );

describe("SafetyBlock", () => {
  it("states that the rejected command did not run and offers the two safe next turns", () => {
    const html = draw();

    expect(html).toContain("Codex safety review");
    expect(html).toContain("OctiqFlow is okay");
    expect(html).toContain("Codex blocked external data sharing");
    expect(html).toContain("OctiqFlow is still running. The command did not run, and no data was sent.");
    expect(html).toContain("Keep it local");
    expect(html).toContain("Technical details");
    expect(html).toContain("Allow once");
    expect(html).not.toContain(block.detail);
  });

  it("shows the reviewer reason only when details are opened", () => {
    const html = draw(true);

    expect(html).toContain("Hide technical details");
    expect(html).toContain(block.detail);
  });

  it("makes an allow explicit, narrow, and single-use", () => {
    const reply = allowOnceReply(block);

    expect(reply).toContain("explicitly authorize one retry");
    expect(reply).toContain(block.summary);
    expect(reply).toContain("single retry");
    expect(reply).toContain("same content and destination only");
  });

  it("keeps the safer continuation fully local", () => {
    expect(LOCAL_ONLY_REPLY).toContain("without sending any local data");
    expect(LOCAL_ONLY_REPLY).toContain("only local tools and local reasoning");
    expect(saferReply(block)).toBe(LOCAL_ONLY_REPLY);
  });

  it("explains a general safety refusal without making OctiqFlow look broken", () => {
    const generic = { ...block, kind: "high-risk-action" as const, title: "Codex blocked a high-risk action" };
    const html = renderToStaticMarkup(
      <SafetyBlock block={generic} onContinue={() => {}} onAnswered={() => {}} />,
    );

    expect(html).toContain("Codex blocked a high-risk action");
    expect(html).toContain("OctiqFlow is still running. The blocked action made no changes.");
    expect(html).toContain("Use safer approach");
    expect(saferReply(generic)).toBe(SAFER_APPROACH_REPLY);
  });
});
