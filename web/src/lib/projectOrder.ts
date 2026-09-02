/** Move one project to either edge of another project. Unknown ids and moves
 * onto the same row are ignored so a stale drag cannot damage a newer list. */
export function moveProjectAt(
  ids: readonly string[],
  moving: string,
  target: string,
  edge: "before" | "after",
): string[] {
  if (moving === target || !ids.includes(moving) || !ids.includes(target)) return [...ids];

  const next = ids.filter((id) => id !== moving);
  const targetIndex = next.indexOf(target);
  next.splice(targetIndex + (edge === "after" ? 1 : 0), 0, moving);
  return next;
}

/** Move one project one row. Used by the settings drawer and by the sidebar's
 * keyboard-accessible drag handle. */
export function moveProjectBy(
  ids: readonly string[],
  moving: string,
  direction: -1 | 1,
): string[] {
  const from = ids.indexOf(moving);
  const to = from + direction;
  if (from < 0 || to < 0 || to >= ids.length) return [...ids];

  const next = [...ids];
  [next[from], next[to]] = [next[to], next[from]];
  return next;
}
