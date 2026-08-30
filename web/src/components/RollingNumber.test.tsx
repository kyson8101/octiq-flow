import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { RollingNumber, RollingText, rollDirection } from "./RollingNumber";

describe("RollingNumber", () => {
  it("chooses a downward wheel for a metric that falls", () => {
    expect(rollDirection("10", "9")).toBe("down");
    expect(rollDirection("1", "0")).toBe("down");
  });

  it("keeps carries and larger metrics moving upward", () => {
    expect(rollDirection("9", "10")).toBe("up");
    expect(rollDirection("099", "100")).toBe("up");
  });

  it("leaves the first frame as ordinary readable text", () => {
    expect(renderToStaticMarkup(<RollingNumber value={42} />)).toBe("42");
    expect(renderToStaticMarkup(<RollingText>{"1:05 · $0.004"}</RollingText>)).toBe(
      "1:05 · $0.004",
    );
  });
});
