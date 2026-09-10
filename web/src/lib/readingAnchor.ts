/** Keep a visible paragraph at the same height even if earlier text changes.
 * Nearby blocks are fallbacks when the paragraph itself is rewritten. */
export type ReadingAnchor = {
  scrollTop: number;
  blocks: { text: string; index: number; offset: number }[];
};

export function captureReadingAnchor(body: HTMLElement, prose: HTMLElement): ReadingAnchor {
  const top = body.getBoundingClientRect().top;
  const children = Array.from(prose.children);
  const index = Math.max(0, children.findIndex((el) => el.getBoundingClientRect().bottom > top));
  const indices = [index, index + 1, index - 1];
  return {
    scrollTop: body.scrollTop,
    blocks: indices.flatMap((i) => {
      const el = children[i];
      return el ? [{ text: el.textContent ?? "", index: i, offset: el.getBoundingClientRect().top - top }] : [];
    }),
  };
}

export function restoreReadingAnchor(body: HTMLElement, prose: HTMLElement, anchor: ReadingAnchor) {
  const children = Array.from(prose.children);
  for (const block of anchor.blocks) {
    if (!block.text) continue;
    // Repeated paragraphs choose the closest original ordinal.
    const match = children
      .map((el, index) => ({ el, index }))
      .filter(({ el }) => el.textContent === block.text)
      .sort((a, b) => Math.abs(a.index - block.index) - Math.abs(b.index - block.index))[0];
    if (!match) continue;
    body.scrollTop += match.el.getBoundingClientRect().top - body.getBoundingClientRect().top - block.offset;
    return;
  }
  body.scrollTop = anchor.scrollTop;
}
