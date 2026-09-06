import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
vi.mock("../lib/bridge", () => ({ bridge: { invoke: vi.fn() } }));
import { ChatRequests } from "./ChatRequests";

const callbacks = {
  onPermissionAnswered: () => {}, onSafetyAnswered: () => {},
  onQuestionsAnswered: () => {}, onContinue: async () => {},
};

describe("ChatRequests", () => {
  it("adds no layout container when there is no request", () => {
    expect(renderToStaticMarkup(<ChatRequests asks={[]} safetyBlocks={[]} questions={[]} {...callbacks} />)).toBe("");
  });

  it("keeps permissions and the question batch visible together", () => {
    const html = renderToStaticMarkup(<ChatRequests
      asks={[{ id: "permission", toolName: "Write", toolInput: { file_path: "/repo/app.ts" } }]}
      safetyBlocks={[]} questions={[{ id: "question", question: "Which layout?" }]}
      {...callbacks}
    />);
    expect(html).toContain("Permission needed");
    expect(html).toContain("/repo/app.ts");
    expect(html).toContain("Which layout?");
  });
});
