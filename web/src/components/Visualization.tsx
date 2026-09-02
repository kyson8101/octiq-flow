// A visualization link emitted by Codex.
//
// Codex writes these as a content reference in an otherwise ordinary answer:
//
//   visualize{"path":"/absolute/file.html"}
//
// React Markdown does not know that protocol, so without this component the
// private-use delimiters appear as square glyphs and the path detector turns
// only the JSON value into an unrelated file button. This owns the reference
// as one block and gives it one clean browser link.

import { bridge } from "../lib/bridge";
import { baseName } from "../lib/files";

export type VisualizationReference = {
  path: string;
  mode?: "wide";
  title?: string;
};

const OPEN = "visualize";
const CLOSE = "";

/** Parse a whole visualization content-reference block. Anything malformed is
 * left to Markdown verbatim; silently guessing a path would hide agent text. */
export function parseVisualizationReference(text: string): VisualizationReference | null {
  const value = text.trim();
  if (!value.startsWith(OPEN) || !value.endsWith(CLOSE)) return null;

  try {
    const raw = JSON.parse(value.slice(OPEN.length, -CLOSE.length)) as Record<string, unknown>;
    if (typeof raw.path !== "string" || !raw.path.startsWith("/")) return null;
    if (raw.mode !== undefined && raw.mode !== "wide") return null;
    if (raw.title !== undefined && typeof raw.title !== "string") return null;
    return {
      path: raw.path,
      ...(raw.mode === "wide" ? { mode: "wide" as const } : {}),
      ...(typeof raw.title === "string" ? { title: raw.title } : {}),
    };
  } catch {
    return null;
  }
}

export function VisualizationLink({ reference }: { reference: VisualizationReference }) {
  const label = reference.title || baseName(reference.path);
  return (
    <button
      className="visualization-link"
      type="button"
      title={reference.path}
      onClick={() => bridge.openFileInBrowser(reference.path)}
    >
      <span aria-hidden="true">↗</span>
      <span>{label}</span>
    </button>
  );
}
