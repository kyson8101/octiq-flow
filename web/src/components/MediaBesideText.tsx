import { useId, type ReactElement, type ReactNode } from "react";
import type { MediaBlockData } from "../lib/mediaBlock";
import { baseName } from "../lib/files";
import { MediaFigure } from "./QuestionMedia";
import "./MediaBesideText.css";

/** Exactly one media figure. Its own width, never the window, picks the layout. */
export function MediaBesideText({ media, children }: { media: ReactElement; children: ReactNode }) {
  return <div className="media-beside"><div className="media-beside-grid">
    <div className="media-beside-file">{media}</div>
    <div className="media-beside-copy">{children}</div>
  </div></div>;
}

export function MediaReply({ media, reserveOnly = false }: { media: MediaBlockData; reserveOnly?: boolean }) {
  const titleId = useId();
  return <section className="media-reply" aria-labelledby={media.title ? titleId : undefined} aria-label={media.title ? undefined : "Media and description"}>
    <MediaBesideText media={<MediaFigure key={media.path} reserveOnly={reserveOnly} media={{ ...media, id: media.path, name: baseName(media.path), mime: "", bytes: 0 }} />}>
      {media.title && <p className="media-reply-title" id={titleId}>{media.title}</p>}
      <p className="media-reply-text">{media.text}</p>
    </MediaBesideText>
  </section>;
}

/** Same unseen markup and dimensions as the finished block, with no fetches
 * or interactive controls. Only the quiet status line is exposed. */
export function MediaPending({ media }: { media: MediaBlockData | null }) {
  return <div className="media-pending" role="status">
    <div className="media-ghost" aria-hidden="true" inert>
      <MediaReply reserveOnly media={media ?? { path: "/media.png", kind: "image", text: "…" }} />
    </div>
    <span className="media-wait">Preparing media…</span>
  </div>;
}
