import { useRef, useState } from "react";
import { nowPlaying } from "../lib/nowPlaying";
import { bridge } from "../lib/bridge";
import { baseName } from "../lib/files";
import { playbackMs } from "../lib/mediaComments";
import { MediaComments } from "./MediaComments";
import { useMediaSlot } from "./MediaSlot";

/** Shared by the file dock and inline video previews, using the SAME player
 *  for playback, comment capture and seeks. Nothing downloads the whole clip.
 *
 *  The `<video>` is made by `lib/nowPlaying` and put into the slot below, so a
 *  playing one in a chat (`chat` set) goes on playing when the person goes to
 *  another chat. The file dock passes no chat and keeps its player to itself. */
export function ReviewVideo({ path, onError, chat = null, reply = "" }: { path: string; onError: () => void; chat?: string | null; reply?: string }) {
  const video = useRef<HTMLVideoElement | null>(null);
  const [comments, setComments] = useState(false);
  const [duration, setDuration] = useState(0);
  const failed = useRef(onError);
  failed.current = onError;
  const slot = useMediaSlot<HTMLVideoElement>({ chat, reply, path, kind: "video", name: baseName(path) }, bridge.fileUrl(path), (el) => {
    video.current = el;
    const meta = () => setDuration(el.duration || 0);
    const error = () => failed.current();
    if (el.readyState >= 1) meta();
    el.addEventListener("loadedmetadata", meta);
    el.addEventListener("error", error);
    if (nowPlaying.errorOf(el)) error();
    return () => {
      el.removeEventListener("loadedmetadata", meta);
      el.removeEventListener("error", error);
      if (video.current === el) video.current = null;
    };
  });
  const capture = () => { video.current?.pause(); return playbackMs(video.current); };
  const seek = (ms: number) => {
    const player = video.current;
    if (!player) return;
    player.pause();
    player.currentTime = Math.min(Number.isFinite(player.duration) ? player.duration : Infinity, Math.max(0, ms / 1000));
  };
  return <span className="media-review-video">
    <span className="media-slot" ref={slot} />
    <button type="button" className="media-comments-toggle" aria-expanded={comments} onClick={() => { if (!comments) video.current?.pause(); setComments(value => !value); }}>{comments ? "Hide comments" : "Comments"}</button>
    {comments && <MediaComments key={path} path={path} captureTime={capture} seekTime={seek} duration={duration} />}
  </span>;
}
