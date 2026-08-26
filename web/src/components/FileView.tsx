// Card 89 — one file, drawn one way, wherever it is docked.
//
// Showing a file was written twice. `FilePanel` drew it for the chat dock and
// `EditorMode` drew it for the editor, and the two had drifted in the place it
// showed most: the real editor — CodeMirror, with syntax colouring, search and
// undo — was wired into the editor mode ONLY, so the same file had highlighting
// in one half of this app and a bare `<textarea>` in the other. Nobody decided
// that; it is what two implementations become.
//
// This is the BODY of a file view and nothing else. What it deliberately does
// NOT own:
//
//   · LOADING and SAVING stay with the frames. They differ for real reasons —
//     the editor keeps a tab per file with its own draft and undo history, the
//     chat dock has one file and its own header — and collapsing that would be
//     merging two things that only look alike.
//   · The FILE WATCHER stays with the chat dock. The backend's watcher is a
//     single shared one, so several mounted views all pointing it somewhere
//     would take it off each other.
//
// What it does own is everything a reader can see: which surface a file gets,
// the markdown/raw split, the truncation warning, and what a PDF says instead
// of nothing.
import { useEffect, useRef, useState } from "react";
import Markdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";

import { bridge } from "../lib/bridge";
import { baseName } from "../lib/files";
import { drawAs, type Preview } from "../lib/fileView";
import { CodeEditor } from "./CodeEditor";
import { ProseTable } from "./ProseTable";

/** The same box the transcript puts a table in, for the same reason: a table
 *  is sized by its cells, so a wide one in a README stuck out of the pane and
 *  was cut off at the window edge with no way to reach the rest of it. Only
 *  the table needs it — a `<pre>` already scrolls inside its own frame. */
const PROSE_COMPONENTS = { table: ProseTable } as Components;

function humanSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} kB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function FileView({
  path,
  preview,
  draft,
  onDraft,
  onSave,
  raw,
  generation,
  onProseRef,
  onSelect,
}: {
  path: string;
  /** What `read_file_preview` returned, or null while it is still coming. */
  preview: Preview | null;
  draft: string;
  onDraft: (text: string) => void;
  /** Ctrl/Cmd-S from inside the editor. The frame owns what saving means. */
  onSave?: () => void;
  /** Show markdown as SOURCE rather than rendered. The frame owns this because
   *  the button that flips it lives in the frame's own header. */
  raw?: boolean;
  /** Bumped by the frame to force a fresh editor — a reload from disk has to
   *  replace the document rather than leave the old undo history pointing at
   *  text that is no longer there. */
  generation?: number;
  /** The rendered-prose element, for the chat dock's quote-to-prompt, which has
   *  to find a selection in the SOURCE that was made in the rendering. */
  onProseRef?: (el: HTMLDivElement | null) => void;
  /** What is highlighted in the EDITOR, in character offsets. Only the chat
   *  dock wants this — it offers to put a highlight into the prompt box with
   *  the lines it came from. See `CodeEditor`'s own note on why the editor has
   *  to be the one that says. */
  onSelect?: (sel: { from: number; to: number; text: string }) => void;
}) {
  if (!preview) return <div className="dots" aria-label="loading" />;

  const drawn = drawAs(path, preview);
  // The frame's toggle only ever turns rendered prose into source. Nothing else
  // has two ways to be shown.
  const as = drawn === "prose" && raw ? "code" : drawn;

  if (as === "image") return <ImageDoc path={path} />;

  if (as === "none") {
    return (
      <div className="panel-note">
        {preview.kind === "pdf" ? "A PDF" : `Not a text file`} · {humanSize(preview.size)}. There is
        nothing here to edit.
      </div>
    );
  }

  if (as === "prose") {
    return (
      <div className="prose panel-prose" ref={onProseRef}>
        <Markdown remarkPlugins={[remarkGfm]} components={PROSE_COMPONENTS}>
          {draft}
        </Markdown>
      </div>
    );
  }

  return (
    <CodeEditor
      key={`${path}:${generation ?? 0}`}
      path={path}
      initialDoc={preview.content}
      readOnly={preview.truncated}
      onChange={onDraft}
      onSave={() => onSave?.()}
      onSelect={onSelect}
    />
  );
}

/** An image. The bytes come over the backend's `/file` route rather than the
 *  WebSocket, the same way the chat's image viewer gets them: an image in a JSON
 *  frame would have to be base64, and this way the browser decodes it. */
function ImageDoc({ path }: { path: string }) {
  const [url, setUrl] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const revoke = useRef<string | null>(null);

  useEffect(() => {
    let alive = true;
    bridge
      .fetchFile(path)
      .then((blob) => {
        if (!alive) return;
        revoke.current = URL.createObjectURL(blob);
        setUrl(revoke.current);
      })
      .catch((e: Error) => alive && setError(e.message));
    return () => {
      alive = false;
      if (revoke.current) URL.revokeObjectURL(revoke.current);
    };
  }, [path]);

  if (error) return <div className="panel-error">{error}</div>;
  if (!url) return <div className="dots" aria-label="loading" />;
  return (
    <div className="ws-image">
      <img src={url} alt={baseName(path)} />
    </div>
  );
}
