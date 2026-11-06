/** Conservative retained-size budget. Never stringify the payload to measure
 * it: doing that to an old 163 MB checkpoint makes another giant heap copy.
 * UTF-16 plus object/key overhead intentionally overcounts ASCII/one-byte V8. */
export function valueBytes(value: unknown, stopAt = Infinity): number {
  const pending: unknown[] = [value];
  const seen = new WeakSet<object>();
  let bytes = 0;
  while (pending.length && bytes <= stopAt) {
    const item = pending.pop();
    if (typeof item === "string") bytes += 24 + item.length * 2;
    else if (item && typeof item === "object") {
      if (seen.has(item)) continue;
      seen.add(item); bytes += 32;
      for (const [key, child] of Object.entries(item)) { bytes += 16 + key.length * 2; pending.push(child); }
    } else bytes += 8;
  }
  return bytes;
}
