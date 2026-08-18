// Fade each word in as it arrives.
//
// A rehype plugin that wraps every word of the rendered markdown in its own
// span, so CSS can fade it. The reason this works without any "which words are
// new?" bookkeeping is React's reconciliation: the words already on screen keep
// their existing DOM nodes across a re-render, so their animation does not
// restart, while a word that has just been revealed mounts a NEW node — and a
// fresh node runs its animation once. New text fades, settled text sits still.
//
// Code is left alone. Splitting a `<pre>` into word spans would mangle the
// whitespace that is the whole point of it, and code arrives as one block
// anyway.
type HastNode = {
  type: string;
  tagName?: string;
  value?: string;
  properties?: Record<string, unknown>;
  children?: HastNode[];
};

/** Words, each keeping the whitespace that follows it so the text still wraps
 *  and copies normally. */
function splitWords(value: string): HastNode[] {
  const parts = value.match(/\S+\s*|\s+/g);
  if (!parts) return [];
  return parts.map((part) => ({
    type: "element",
    tagName: "span",
    properties: { className: ["w"] },
    children: [{ type: "text", value: part }],
  }));
}

function walk(node: HastNode): void {
  if (!node.children?.length) return;
  const out: HastNode[] = [];
  for (const child of node.children) {
    if (child.type === "text" && child.value) {
      out.push(...splitWords(child.value));
      continue;
    }
    // Whitespace in code is content, not layout.
    if (child.tagName === "pre" || child.tagName === "code") {
      out.push(child);
      continue;
    }
    walk(child);
    out.push(child);
  }
  node.children = out;
}

export function rehypeWordFade() {
  return (tree: HastNode) => walk(tree);
}
