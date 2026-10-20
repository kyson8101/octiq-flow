export type MediaComment = { id: string; text: string; timeMs?: number; createdAt: number };
export type MediaThread = { target: { path: string; revision: string; kind: "image" | "video" }; comments: MediaComment[] };

/** Milliseconds remain visible: two notes either side of a cut must not look
 *  like the same time. Hours appear only for long recordings. */
export function mediaTime(ms: number): string {
  const safe = Math.max(0, Math.round(Number.isFinite(ms) ? ms : 0));
  const seconds = Math.floor(safe / 1000);
  const hours = Math.floor(seconds / 3600);
  return `${hours ? `${hours}:` : ""}${String(Math.floor(seconds / 60) % (hours ? 60 : Infinity)).padStart(2, "0")}:${String(seconds % 60).padStart(2, "0")}.${String(safe % 1000).padStart(3, "0")}`;
}

export function playbackMs(video: Pick<HTMLVideoElement, "currentTime" | "duration"> | null): number {
  if (!video || !Number.isFinite(video.currentTime)) return 0;
  const max = Number.isFinite(video.duration) ? Math.max(0, video.duration) : Infinity;
  return Math.round(Math.max(0, Math.min(video.currentTime, max)) * 1000);
}

export function orderedComments(comments: readonly MediaComment[]): MediaComment[] {
  return [...comments].sort((a, b) => (a.timeMs ?? 0) - (b.timeMs ?? 0) || a.createdAt - b.createdAt || a.id.localeCompare(b.id));
}

export function reviewQuote(thread: MediaThread, comment: MediaComment): string {
  return `${thread.target.kind === "video" ? `Video review at ${mediaTime(comment.timeMs ?? 0)}` : "Image review"}\nSource revision: ${thread.target.revision}\n${comment.text}`;
}
