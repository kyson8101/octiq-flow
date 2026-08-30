import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { Todos } from "./Todos";

describe("Todos", () => {
  it("shows a compact next-step pill until the checklist is opened", () => {
    const html = renderToStaticMarkup(
      <Todos
        todos={[
          { content: "Inspect the boundary", status: "in_progress" },
          { content: "Complete the refactor", status: "pending" },
          { content: "Run checks", status: "pending" },
          { content: "Record the decision", status: "pending" },
        ]}
      />,
    );

    expect(html).toContain("Step 1 / 4");
    expect(html).toContain("plan-state");
    expect(html).not.toContain("plan-pop");
  });

  it("keeps a completed plan visible without presenting another step", () => {
    const html = renderToStaticMarkup(
      <Todos
        todos={[
          { content: "Inspect the boundary", status: "completed" },
          { content: "Complete the refactor", status: "completed" },
        ]}
      />,
    );

    expect(html).toContain("All 2 steps done");
  });
});
