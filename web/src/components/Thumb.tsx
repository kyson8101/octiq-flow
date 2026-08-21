// The little picture on a file chip.
//
// A name like `image.png` says nothing about which screenshot you attached, and
// when two are attached it says even less. So the chip carries the picture.
//
// Two sources, in this order: bytes already in the page (a paste or an upload
// keeps an object URL on the attachment), and otherwise the file itself off the
// server machine — through the bridge's `/file` route, so the access token
// stays out of the markup. Falls back to a plain icon when neither works.
//
// It lives here rather than in the composer because a message that has been
// SENT draws the same chips: the composer is where you attach a file, the
// transcript is where you look back at what you attached.
import { useEffect, useState } from "react";
import { bridge } from "../lib/bridge";
import type { Attached } from "../lib/chat";
import { isPdf } from "../lib/files";
import { Viewer } from "./Viewer";
import { FilePanel } from "./FilePanel";

/** What a message remembers about a file: enough to draw it and to name it.
 *  The composer's own attachments carry an object `url` as well, which is the
 *  page's copy of the bytes and is never written down. */
export type ThumbSource = Attached & { url?: string };

export function Thumb({ attachment }: { attachment: ThumbSource }) {
  const [url, setUrl] = useState<string | null>(attachment.url ?? null);

  useEffect(() => {
    if (attachment.url) {
      setUrl(attachment.url);
      return;
    }
    let alive = true;
    let made: string | null = null;
    bridge
      .fetchFile(attachment.path)
      .then((blob) => {
        if (!alive) return;
        made = URL.createObjectURL(blob);
        setUrl(made);
      })
      .catch(() => alive && setUrl(null));
    return () => {
      alive = false;
      // Only ours to revoke — the one on the attachment belongs to the composer.
      if (made) URL.revokeObjectURL(made);
    };
  }, [attachment.path, attachment.url]);

  if (!url) return <ImageIcon />;
  return <img className="chip-thumb" src={url} alt="" />;
}

/** The files that went WITH a message, under the words that came with them.
 *
 *  The same chips the composer shows while you are attaching them, minus the ✕:
 *  what you sent should look like what you were about to send. Without this a
 *  message sent with three screenshots read as an empty bubble — the pictures
 *  went to the agent and left no trace of themselves in the conversation. */
export function SentFiles({ files }: { files: Attached[] }) {
  // What is being looked at, if anything: a picture or a PDF full screen, and
  // anything else in the side panel — the same two answers the file list under
  // a reply gives, because it is the same question.
  const [viewing, setViewing] = useState<string | null>(null);
  const [opened, setOpened] = useState<string | null>(null);

  if (files.length === 0) return null;

  return (
    <div className="sent-files">
      {files.map((a) => (
        <button
          className={`chip ${a.isImage ? "is-image" : ""}`}
          type="button"
          key={a.path}
          title={`${a.path} — click to open`}
          onClick={() => (a.isImage || isPdf(a.path) ? setViewing(a.path) : setOpened(a.path))}
        >
          {a.isImage ? <Thumb attachment={a} /> : <PaperIcon />}
          <span className="chip-name">{a.name}</span>
        </button>
      ))}

      {viewing && <Viewer path={viewing} onClose={() => setViewing(null)} />}
      {opened && <FilePanel path={opened} onClose={() => setOpened(null)} />}
    </div>
  );
}

function ImageIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <rect x="3" y="4" width="18" height="16" rx="2.5" />
      <circle cx="8.5" cy="9.5" r="1.6" />
      <path d="m4 17 4.5-4.5a2 2 0 0 1 2.8 0L16 17" />
      <path d="m14 14 1.8-1.8a2 2 0 0 1 2.8 0L21 14.5" />
    </svg>
  );
}

function PaperIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8Z" />
      <path d="M14 3v5h5" />
    </svg>
  );
}
