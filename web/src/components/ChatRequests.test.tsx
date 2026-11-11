import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
vi.mock("../lib/bridge", () => ({ bridge: { invoke: vi.fn() } }));
import { ChatRequests } from "./ChatRequests";

const callbacks = {
  onPermissionAnswered: () => {}, onSafetyAnswered: () => {},
  onContinue: async () => {},
};

describe("ChatRequests", () => {
  it("adds no layout container when there is no request", () => {
    expect(renderToStaticMarkup(<ChatRequests asks={[]} safetyBlocks={[]} {...callbacks} />)).toBe("");
  });

  it("draws a permission, and no question: that is the transcript's", () => {
    // A question is drawn where it was asked (`InlineQuestions`); this takes
    // none, so a second copy cannot come back above the composer.
    const html = renderToStaticMarkup(<ChatRequests
      asks={[{ id: "permission", toolName: "Write", toolInput: { file_path: "/repo/app.ts" } }]}
      safetyBlocks={[]}
      {...callbacks}
    />);
    expect(html).toContain("Permission needed");
    expect(html).toContain("/repo/app.ts");
    expect(html).not.toContain("qa-");
  });
});

it.each([1280, 390])("keeps a worker's judged refusal compact with its pending key at %ipx", (width) => {
  const html = renderToStaticMarkup(<div style={{ width }}><ChatRequests asks={[]} safetyContext="OCTIQ FE: Quieter transcript"
    safetyBlocks={[{ id: "worker-refusal", provider: "claude", kind: "high-risk-action", title: "Claude's auto mode blocked an action",
      summary: "Safety Bypass Flag", detail: "classifier detail", action: "gh pr edit 201 --body-file /tmp/body" }]} {...callbacks} /></div>);
  expect(html).toContain('data-pending-keys="safety:worker-refusal"');
  expect(html).toContain("safety-refusal-context");
  expect(html).toContain("OCTIQ FE: Quieter transcript");
  expect(html).toContain("Auto mode blocked");
  expect(html).toContain("Safety Bypass Flag");
  expect(html).toContain("Use safer approach");
  expect(html).toContain('aria-label="Dismiss"');
  expect(html).not.toContain("Approval for");
  expect(html).not.toContain("gh pr edit");
});
