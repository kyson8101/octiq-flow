// What an `ask_user` question shows: the host's snapshots of local images,
// video and sound beside the question when there is one, in a strip when
// there are several, and a picture on an option
// (`lib/questionMedia`, docs/question-delivery.md, Media).
//
// Three rules, the question block's own:
//
// - Every box has its size before anything arrives. A picture is drawn in a
//   fixed box and fitted inside it, a player in a box of a fixed shape, so
//   the button under the block is where it was when the picture lands.
// - Nothing is fetched until it is within a screen of being seen, as in a
//   reply (`ProseMedia.useNear`). A picture comes as a blob, so the token
//   stays out of the markup; a player streams from `/file` in ranges.
// - A file that will not load leaves its words: the caption and the name,
//   and in its place, which it keeps so nothing under it moves, that it
//   could not be shown. No frame, no broken picture.
//
// A press on a picture opens it full size in the shared viewer (Escape
// shuts it). Nothing here answers a question: a picture inside an option's
// row is part of the row, and its enlarge control sits beside the row,
// never inside the label, so it selects nothing.
import { useEffect, useRef, useState, type ReactNode } from "react";
import { bridge } from "../lib/bridge";
import { bytesLabel, mediaCount, type Media, type MediaKind, type Shown } from "../lib/questionMedia";
import { FoldBody, FoldToggle, useFold } from "./CardFold";
import { useOpenFile } from "./OpenFileContext";
import { useNear } from "./ProseMedia";
import { useHeldMedia, useMediaChat, useMediaReply, useMediaSlot } from "./MediaSlot";
import { nowPlaying } from "../lib/nowPlaying";

/** A picture's bytes as a blob URL, once it is near; `failed` when they
 *  will not come. */
function useShot(path: string, near: boolean): { url: string | null; failed: boolean } {
  const [url, setUrl] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    if (!near) return;
    let alive = true;
    let made: string | null = null;
    bridge.fetchFile(path).then((blob) => {
      if (!alive) return;
      made = URL.createObjectURL(blob);
      setUrl(made);
    }).catch(() => alive && setFailed(true));
    return () => {
      alive = false;
      if (made) URL.revokeObjectURL(made);
    };
  }, [near, path]);
  return { url, failed };
}

/** The name and size a control's words give a file. */
const described = (media: Media) => `${media.name}${media.bytes ? ` · ${bytesLabel(media.bytes)}` : ""}`;

/** One file, shared with media replies: its reserved box, then its words. */
export function MediaFigure({ media, reserveOnly = false }: { media: Shown; reserveOnly?: boolean }) {
  const [holder, near] = useNear<HTMLElement>();
  const open = useOpenFile();
  const shot = useShot(media.path, !reserveOnly && near && media.kind === "image");
  const chat = useMediaChat();
  const reply = useMediaReply();
  const held = useHeldMedia(chat, media.path, reply);
  const kept = useRef(false);
  if (held) kept.current = true;
  const [broken, setBroken] = useState(false);
  const failed = broken || shot.failed;
  let box: ReactNode;
  if (reserveOnly) {
    box = <span className={`qa-media-box is-${media.kind}`} />;
  } else if (failed) {
    box = (
      <span className={`qa-media-box is-${media.kind} is-failed`}>
        <KindIcon kind={media.kind} />Could not be shown
      </span>
    );
  } else if (media.kind === "image") {
    box = (
      <button type="button" className="qa-media-box is-image" title={`${media.name}: see it full size`}
        aria-label={`See ${media.name} full size`} onClick={() => open(media.path)}>
        {shot.url && <img src={shot.url} alt={media.caption ?? media.name} onError={() => setBroken(true)} />}
      </button>
    );
  } else {
    // Pointed at `/file`, as a reply's player is, so it streams and seeks.
    box = (
      <span className={`qa-media-box is-${media.kind}`}>
        {(near || kept.current) && <FigurePlayer media={media} onError={() => setBroken(true)} />}
      </span>
    );
  }
  return (
    <figure className={`qa-media-item is-${media.kind}${failed ? " is-failed" : ""}`} ref={holder} data-media={media.id}>
      {box}
      <figcaption className="qa-media-cap">
        {media.option && <span className="qa-media-option">Chosen · {media.option}</span>}
        {media.caption && <span className="qa-media-caption">{media.caption}</span>}
        <span className="qa-media-name">{described(media)}</span>
      </figcaption>
    </figure>
  );
}

/** Browser controls, preload="metadata", and the same nowPlaying ownership
 * as ProsePlayer: a playing file can leave the chat and come back. */
function FigurePlayer({ media, onError }: { media: Shown; onError: () => void }) {
  const chat = useMediaChat();
  const reply = useMediaReply();
  const failed = useRef(onError);
  failed.current = onError;
  const slot = useMediaSlot<HTMLMediaElement>({ chat, reply, path: media.path, kind: media.kind as "video" | "audio", name: media.name }, bridge.fileUrl(media.path), (el) => {
    const error = () => failed.current();
    el.addEventListener("error", error);
    if (nowPlaying.errorOf(el)) error();
    return () => el.removeEventListener("error", error);
  });
  return <span className="media-slot" ref={slot} />;
}

/** A question's media, in the order asked. Nothing when there is none. */
export function MediaStrip({ media }: { media: readonly Shown[] }) {
  if (!media.length) return null;
  return (
    <div className="qa-media" role="group" aria-label={mediaCount(media)}>
      {media.map((each) => <MediaFigure key={`${each.id}${each.option ? `:${each.option}` : ""}`} media={each} />)}
    </div>
  );
}

/** An option's row that has a picture: the row, with the picture inside it
 *  (a press on it selects, as on the row's words), and beside the label the
 *  control that opens the picture full size. `row` is the label, handed the
 *  picture to put between its mark and its words. */
export function PictureRow({ image, row }: { image: Media; row: (shot: ReactNode) => ReactNode }) {
  const [holder, near] = useNear<HTMLDivElement>();
  const open = useOpenFile();
  const shot = useShot(image.path, near);
  const [broken, setBroken] = useState(false);
  const failed = broken || shot.failed;
  return (
    <div className="qa-row-wrap has-shot" ref={holder}>
      {/* A picture that will not load keeps its square, empty, so the rows
          under it stay where they were. */}
      {row(
        <span className={`qa-row-shot${failed ? " is-failed" : ""}`} aria-hidden="true">
          {!failed && shot.url && <img src={shot.url} alt="" onError={() => setBroken(true)} />}
        </span>,
      )}
      {!failed && (
        <button type="button" className="qa-row-zoom" aria-label={`See the picture for this option full size: ${image.name}`}
          title={`${image.name}: see it full size`} onClick={() => open(image.path)}>
          <ZoomIcon />
        </button>
      )}
    </div>
  );
}

/** One small mark of the answered line, folded: a picture's thumbnail, or a
 *  player's kind and name. */
function Thumb({ media }: { media: Shown }) {
  const [holder, near] = useNear<HTMLSpanElement>();
  const shot = useShot(media.path, near && media.kind === "image");
  const [broken, setBroken] = useState(false);
  if (media.kind === "image" && !shot.failed && !broken) {
    return (
      <span className="qa-thumb is-image" ref={holder} title={media.option ? `${media.option}: ${media.name}` : media.name}>
        {shot.url && <img src={shot.url} alt={media.name} onError={() => setBroken(true)} />}
      </span>
    );
  }
  return (
    <span className="qa-thumb is-named" ref={holder} title={media.name}>
      <KindIcon kind={media.kind} />
      <span className="qa-thumb-name">{media.name}</span>
    </span>
  );
}

/** What the answered questions showed: folded, a row of small thumbnails
 *  and the count, on the block's one disclosure; opened, each question's
 *  media whole. Nothing when they showed none. */
export function FoldedMedia({ items, startOpen = false }: {
  items: readonly { question: string; media?: Shown[] }[];
  startOpen?: boolean;
}) {
  const shown = items.filter((item) => item.media?.length);
  const all = shown.flatMap((item) => item.media!);
  const fold = useFold(`qa-media:${all.map((m) => `${m.id}${m.option ?? ""}`).join(",")}`, { startOpen });
  if (!all.length) return null;
  const count = mediaCount(all);
  return (
    <div className="qa-media-fold">
      <div className="card-fold-line qa-media-line" data-open={fold.open || undefined}>
        <span className="qa-thumbs" aria-hidden="true">
          {all.map((media) => <Thumb key={`${media.id}${media.option ?? ""}`} media={media} />)}
        </span>
        <span className="card-fold-labels qa-media-count">{count}</span>
        <FoldToggle fold={fold} what={all.length === 1 ? "the file" : "the files"} />
      </div>
      <FoldBody fold={fold} bounded={false}>
        <div className="qa-media-opened">
          {shown.map((item, index) => (
            <div className="qa-media-of" key={index}>
              {shown.length > 1 && <p className="qa-media-of-q">{item.question}</p>}
              <MediaStrip media={item.media!} />
            </div>
          ))}
        </div>
      </FoldBody>
    </div>
  );
}

function KindIcon({ kind }: { kind: MediaKind }) {
  return (
    <svg className="qa-kind" viewBox="0 0 16 16" width="12" height="12" aria-hidden="true">
      {kind === "video" ? <path d="M3 3.5v9l9-4.5z" fill="currentColor" />
        : kind === "audio" ? <path d="M6 3v7.3a2.2 2.2 0 1 0 1.5 2.1V6h4V3z" fill="currentColor" />
          : <path d="M2.5 3.5h11v9h-11zM4 11l3-3.5 2 2.2 1.5-1.5L12.5 11z" fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinejoin="round" />}
    </svg>
  );
}

function ZoomIcon() {
  return (
    <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">
      <path d="M9.5 2.5h4v4M13.5 2.5 9 7M6.5 13.5h-4v-4M2.5 13.5 7 9" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}
