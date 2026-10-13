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
