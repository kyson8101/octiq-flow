import { useRef, useState } from "react";
import { bridge } from "../lib/bridge";
import { baseName } from "../lib/files";
import { playbackMs } from "../lib/mediaComments";
import { MediaComments } from "./MediaComments";

/** Shared by the file dock and inline video previews, using the SAME player
 *  for playback, comment capture and seeks. Nothing downloads the whole clip. */
export function ReviewVideo({ path, onError }: { path: string; onError: () => void }) {
  const video = useRef<HTMLVideoElement>(null);
  const [comments, setComments] = useState(false);
  const [duration, setDuration] = useState(0);
  const capture = () => { video.current?.pause(); return playbackMs(video.current); };
  const seek = (ms: number) => {
    const player = video.current;
    if (!player) return;
    player.pause();
    player.currentTime = Math.min(Number.isFinite(player.duration) ? player.duration : Infinity, Math.max(0, ms / 1000));
  };
  return <span className="media-review-video">
    <video ref={video} src={bridge.fileUrl(path)} controls playsInline preload="metadata" aria-label={baseName(path)}
      onLoadedMetadata={() => setDuration(video.current?.duration ?? 0)} onError={onError} />
    <button type="button" className="media-comments-toggle" aria-expanded={comments} onClick={() => { if (!comments) video.current?.pause(); setComments(value => !value); }}>{comments ? "Hide comments" : "Comments"}</button>
    {comments && <MediaComments key={path} path={path} captureTime={capture} seekTime={seek} duration={duration} />}
  </span>;
}
