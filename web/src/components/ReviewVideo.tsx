import { PlaybackSpeed } from "./PlaybackSpeed";
import { useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { ActionIcon } from "./ActionIcon";
import { popSize } from "../lib/videoPop";
import { nowPlaying } from "../lib/nowPlaying";
import { bridge } from "../lib/bridge";
import { baseName } from "../lib/files";
import { playbackMs } from "../lib/mediaComments";
import { MediaComments } from "./MediaComments";
import { useMediaSlot } from "./MediaSlot";
import "./MediaPop.css";

type Pop = { size: { width: number; height: number }; place: { width: number; height: number } };

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
  const [pop, setPop] = useState<Pop | null>(null);
  const popped = useRef(false);
  popped.current = pop !== null;
  const dialog = useRef<HTMLDialogElement>(null);
  const popHolder = useRef<HTMLSpanElement>(null);
  const failed = useRef(onError);
  failed.current = onError;
  const { slot, element } = useMediaSlot<HTMLVideoElement>({ chat, reply, path, kind: "video", name: baseName(path) }, bridge.fileUrl(path), (el) => {
    video.current = el;
    const meta = () => setDuration(el.duration || 0);
    const error = () => failed.current();
    if (el.readyState >= 1) meta();
    el.addEventListener("loadedmetadata", meta);
    el.addEventListener("error", error);
    if (nowPlaying.errorOf(el)) error();
    // A chat reply's video opens larger when it starts playing and the window
    // has room. The file dock (no chat) never pops.
    const play = () => {
      if (chat === null || popped.current) return;
      const rect = el.getBoundingClientRect();
      const aspect = el.videoHeight > 0 ? el.videoWidth / el.videoHeight : 0;
      const size = popSize({ width: window.innerWidth, height: window.innerHeight }, rect.width, aspect);
      if (size) setPop({ size, place: { width: rect.width, height: rect.height } });
    };
    el.addEventListener("play", play);
    return () => {
      el.removeEventListener("play", play);
      // The store moves the element itself; only forget the pop-up here.
      setPop(null);
      el.removeEventListener("loadedmetadata", meta);
      el.removeEventListener("error", error);
      if (video.current === el) video.current = null;
    };
  });
  useLayoutEffect(() => {
    const el = video.current;
    if (!pop || !el || !popHolder.current || !dialog.current) return;
    popHolder.current.appendChild(el);
    if (!dialog.current.open) dialog.current.showModal();
  }, [pop]);
  const closePop = () => {
    const el = video.current;
    if (el && slot.current && el.parentNode !== slot.current) slot.current.appendChild(el);
    setPop(null);
  };
  const capture = () => { video.current?.pause(); return playbackMs(video.current); };
  const seek = (ms: number) => {
    const player = video.current;
    if (!player) return;
    player.pause();
    player.currentTime = Math.min(Number.isFinite(player.duration) ? player.duration : Infinity, Math.max(0, ms / 1000));
  };
  return <span className="media-review-video">
    <span className="media-slot" ref={slot} />
    {pop && <span className="media-pop-place" style={{ width: pop.place.width, height: pop.place.height }}>Playing in the pop-up</span>}
    {pop && createPortal(
      <dialog ref={dialog} className="media-pop" aria-label={baseName(path)} onClose={closePop}
        onClick={(e) => { if (e.target === e.currentTarget) e.currentTarget.close(); }}>
        <span className="media-pop-bar">
          <span className="media-pop-name">{baseName(path)}</span>
          <button type="button" className="media-pop-close" aria-label="Close" title="Close, back to the reply" data-icon-action
            onClick={() => dialog.current?.close()}><ActionIcon name="dismiss" /></button>
        </span>
        <span className="media-pop-holder" ref={popHolder} style={{ width: pop.size.width, height: pop.size.height }} />
      </dialog>, document.body)}
    <span className="media-playback-tools">
      <PlaybackSpeed element={element} />
      <button type="button" className="media-comments-toggle" aria-expanded={comments} onClick={() => { if (!comments) video.current?.pause(); setComments(value => !value); }}>{comments ? "Hide comments" : "Comments"}</button>
    </span>
    {comments && <MediaComments key={path} path={path} captureTime={capture} seekTime={seek} duration={duration} />}
  </span>;
}
