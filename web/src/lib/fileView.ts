// Card 89 — the decisions both file frames were making, separately.
//
// Showing a file was written twice: `FilePanel` for the chat dock and
// `EditorMode` for the editor. Both read through `read_file_preview`, both save
// through `write_file`, both make a truncated file read-only, both branch on
// text/image/pdf — and, inevitably, they drifted. The one that mattered: the
// real editor (CodeMirror, with syntax colouring, search and undo) was wired
// into the editor mode ONLY, so the same file had highlighting in one half of
// this app and none in the other. Nobody decided that.
//
// The two judgements live here, apart from either component, because they are
// the half that can be WRONG — a file wrongly judged saveable is a large file
// truncated on disk, and there is no undo for that.

/** `read_file_preview`'s answer. Snake_case on the wire; the bridge hands it
 *  back in this shape. */
export type Preview = {
  /** `text` | `image` | `pdf` | `binary`, decided by the backend having opened
   *  the thing — which beats guessing from the name. */
  kind: string;
  content: string;
  /** The backend returned only the head of a large file. */
  truncated: boolean;
  size: number;
};

/** How a file should be drawn.
 *
 *  `prose` is markdown rendered; `code` is the editor; `image` is the bytes;
 *  `none` is a size and a plain statement that there is nothing here to edit. */
export type Drawn = "prose" | "code" | "image" | "none";

const MARKDOWN = /\.(md|markdown|mdx)$/i;

/** What to draw, given the path and what came back for it.
 *
 *  The backend's `kind` WINS over the extension every time. It has opened the
 *  file; the name is a claim about it. A `.md` that came back binary is binary.
 *
 *  The one exception is inside `text`: an empty markdown file opens in the
 *  editor rather than rendered, because a rendered empty file is a blank page
 *  with nowhere to start typing. */
export function drawAs(path: string, preview: Preview): Drawn {
  if (preview.kind === "image") return "image";
  if (preview.kind !== "text") return "none";
  if (MARKDOWN.test(path) && preview.content.trim()) return "prose";
  return "code";
}

export type SaveState = {
  /** Changed since it was read. True even when it cannot be written — closing
   *  should still ask about work that would be lost. */
  dirty: boolean;
  /** May actually be written to disk. */
  can: boolean;
  /** Why not, when `can` is false and the reason is not simply "unchanged". */
  why?: string;
};

/** Whether what is on screen may be written back.
 *
 *  A TRUNCATED file is refused outright rather than warned about. The backend
 *  returned the head of it; writing that back would cut the rest of the real
 *  file away, and that is not a thing to let somebody click past. */
export function saveState(preview: Preview | null, draft: string): SaveState {
  if (!preview) return { dirty: false, can: false };

  const dirty = draft !== preview.content;
  if (preview.kind !== "text") return { dirty: false, can: false, why: "This is not a text file." };
  if (preview.truncated) {
    return {
      dirty,
      can: false,
      why: "Only the start of this file was read. Saving would cut the rest of it away.",
    };
  }
  return { dirty, can: dirty };
}
