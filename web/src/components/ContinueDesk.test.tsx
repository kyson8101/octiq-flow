import { expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { ContinueDesk } from "./ContinueDesk";

it("names each continuation dismiss button by its conversation, including the fallback", () => {
  const html = renderToStaticMarkup(<ContinueDesk name="Desk" now={1000}
    chats={["First request", "Second request", "  "].map((opening, i) => ({
      chatKey: `chat:${i}`, agentId: "desk", createdAt: 0, opening,
    }))} onContinue={() => {}} onCancel={async () => {}} />);
  for (const words of ["First request", "Second request", "Your earlier conversation"]) {
    const label = `Cancel continuing &quot;${words}&quot;`;
    expect(html).toContain(`aria-label="${label}" title="${label}"`);
  }
});
