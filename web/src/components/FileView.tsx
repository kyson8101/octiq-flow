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
// the rendered/source split for the files that have both, the truncation
// warning, and what a PDF says instead of nothing.
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
  /** Show a rendered file — markdown, or an html page — as its SOURCE. The
   *  frame owns this because the button that flips it lives in its own
   *  header. */
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
  // The frame's toggle only ever turns something RENDERED — prose, or a page —
  // into the source behind it. Nothing else has two ways to be shown.
  const as = raw && (drawn === "prose" || drawn === "page") ? "code" : drawn;

  if (as === "image") return <ImageDoc path={path} />;

  if (as === "none") {
    return (
      <div className="panel-note">
        {preview.kind === "pdf" ? "A PDF" : `Not a text file`} · {humanSize(preview.size)}. There is
        nothing here to edit.
      </div>
    );
  }

  if (as === "page") return <PageDoc path={path} html={draft} />;

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

/** An html file, drawn as the page it is.
 *
 *  The markup goes in as `srcdoc` rather than the frame being pointed at the
 *  file, because there is no route that would serve it: `/file` hands back
 *  bytes for one path and knows nothing about a page's own origin. It is fed
 *  the DRAFT and not what came off disk, so flipping back from the source view
 *  shows what you just typed.
 *
 *  `allow-scripts` WITHOUT `allow-same-origin` is deliberate and is the whole
 *  security of this. A sandboxed frame with no same-origin grant lives in an
 *  origin of its own, so a page an agent wrote can run its own charts and
 *  toggles but can never read this app's token or its storage. Granting both
 *  would hand it the lot, and is the one combination never to write here.
 *
 *  A page that pulls in a stylesheet or an image sitting NEXT to it on disk
 *  gets neither — a relative url has nothing to resolve against in a frame
 *  with no url. Self-contained pages, which is most of what an agent writes,
 *  draw whole.
 *
 *  White, not the app's background: an html document's canvas is white
 *  everywhere else, and a page that sets no background of its own would
 *  otherwise be dark grey with its own black text on it. */
function PageDoc({ path, html }: { path: string; html: string }) {
  return (
    <iframe
      className="panel-page"
      title={`${baseName(path)} — preview`}
      srcDoc={html}
      sandbox="allow-scripts allow-popups"
      referrerPolicy="no-referrer"
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
