/** Read an unknown JSON value as an object, or an empty one. */
export const obj = (v: unknown): Record<string, unknown> =>
  v && typeof v === "object" ? (v as Record<string, unknown>) : {};

/** Read an unknown JSON value as a string, or an empty one. */
export const str = (v: unknown): string => (typeof v === "string" ? v : "");
