import { expect, it } from "vitest";
import { captureReadingAnchor, restoreReadingAnchor } from "./readingAnchor";

function documentAt(texts: string[], heights: number[], scrollTop: number) {
  const body = { scrollTop, getBoundingClientRect: () => ({ top: 50 }) };
  const prose = {
    children: texts.map((textContent, i) => ({
      textContent,
      getBoundingClientRect: () => ({
        top: 50 + heights.slice(0, i).reduce((a, b) => a + b, 0) - body.scrollTop,
        bottom: 50 + heights.slice(0, i + 1).reduce((a, b) => a + b, 0) - body.scrollTop,
      }),
    })),
  };
  return { body: body as HTMLElement, prose: prose as unknown as HTMLElement };
}

it("keeps a partly visible paragraph in place when content is inserted above it", () => {
  const before = documentAt(["intro", "reading", "next"], [100, 100, 100], 125);
  const anchor = captureReadingAnchor(before.body, before.prose);
  const after = documentAt(["new", "intro", "reading", "next"], [240, 100, 100, 100], 125);
  restoreReadingAnchor(after.body, after.prose, anchor);
  expect(after.body.scrollTop).toBe(365);
});

it("uses a neighbouring paragraph when the visible paragraph was amended", () => {
  const before = documentAt(["intro", "reading", "next"], [100, 100, 100], 125);
  const anchor = captureReadingAnchor(before.body, before.prose);
  const after = documentAt(["new intro", "amended", "next"], [180, 120, 100], 125);
  restoreReadingAnchor(after.body, after.prose, anchor);
  expect(after.body.scrollTop).toBe(225);
});

it("chooses the nearby occurrence of repeated text", () => {
  const before = documentAt(["repeat", "middle", "repeat", "last"], [100, 100, 100, 100], 225);
  const anchor = captureReadingAnchor(before.body, before.prose);
  const after = documentAt(["repeat", "middle", "repeat", "last"], [150, 100, 100, 100], 225);
  restoreReadingAnchor(after.body, after.prose, anchor);
  expect(after.body.scrollTop).toBe(275);
});

it("falls back to the saved scroll position if every captured block disappeared", () => {
  const before = documentAt(["old"], [400], 125);
  const anchor = captureReadingAnchor(before.body, before.prose);
  const after = documentAt(["replacement"], [500], 0);
  restoreReadingAnchor(after.body, after.prose, anchor);
  expect(after.body.scrollTop).toBe(125);
});
