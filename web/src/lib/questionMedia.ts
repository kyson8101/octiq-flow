// What an `ask_user` question shows the person: local images, video and
// sound under the question, and an image on an option
// (docs/question-delivery.md, Media).
//
// The host snapshots each file when the question is asked and sends a
// record of it; `path` is the snapshot, served by `/file`. Every reader here
// is tolerant: an entry the page cannot read is dropped and the question
// still draws. The host refuses a call whose media it cannot show, so a
// dropped entry is an older or a newer host, never an agent's mistake to
// draw half of.

export type MediaKind = "image" | "video" | "audio";

export type Media = {
  id: string;
  kind: MediaKind;
  mime: string;
  /** The snapshot's absolute path on the server machine. */
  path: string;
  /** The source file's base name, as the agent had it. */
  name: string;
  caption?: string;
  bytes: number;
};

/** One thing the answered line shows: a question's own media, or the image
 *  of an option the person chose (`option` is its label). */
export type Shown = Media & { option?: string };

/** The most a question shows: the host refuses more. */
export const MEDIA_MAX = 4;

const KINDS: readonly MediaKind[] = ["image", "video", "audio"];
const text = (value: unknown): value is string => typeof value === "string" && value.trim() !== "";

/** One entry, or `null` for anything that is not one whole. */
export function readMedia(raw: unknown): Media | null {
  const bag = raw && typeof raw === "object" ? raw as Record<string, unknown> : null;
  if (!bag || !text(bag.id) || !text(bag.path) || !KINDS.includes(bag.kind as MediaKind)) return null;
  const name = text(bag.name) ? bag.name : bag.path.split(/[\\/]/).pop() || bag.path;
  const media: Media = {
    id: bag.id,
    kind: bag.kind as MediaKind,
    mime: text(bag.mime) ? bag.mime : "",
    path: bag.path,
    name,
    bytes: typeof bag.bytes === "number" && bag.bytes >= 0 ? bag.bytes : 0,
  };
  if (text(bag.caption)) media.caption = bag.caption;
  return media;
}

/** A question's media, in the order asked: the entries that read, at most
 *  `MEDIA_MAX`. Anything that is not a list is none. */
export function mediaList(raw: unknown): Media[] {
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((entry) => {
    const media = readMedia(entry);
    return media ? [media] : [];
  }).slice(0, MEDIA_MAX);
}

/** An option's image: an image or nothing (the host sends no other kind). */
export function optionImage(raw: unknown): Media | undefined {
  const media = readMedia(raw);
  return media?.kind === "image" ? media : undefined;
}

/** The labels an answer chose, of the labels on offer, read the way
 *  `questionAnswer.composeAnswer` writes them: one label, or the chosen
 *  labels in the order offered joined by ", ", then any typed words. */
export function chosenLabels(answer: string, labels: readonly string[], many: boolean): string[] {
  const said = answer.trim();
  if (!said) return [];
  if (!many) return labels.includes(said) ? [said] : [];
  const chosen: string[] = [];
  let rest = said;
  for (const label of labels) {
    if (rest === label) return [...chosen, label];
    if (rest.startsWith(`${label}, `)) {
      chosen.push(label);
      rest = rest.slice(label.length + 2);
    }
  }
  return chosen;
}

/** What the answered line shows of one question: its media, then the
 *  images of the options the answer chose. */
export function shownMedia(question: {
  media?: unknown;
  options?: readonly { label: string; image?: Media }[];
  multiple?: boolean;
}, answer: string): Shown[] {
  const own: Shown[] = mediaList(question.media);
  const options = question.options ?? [];
  if (!options.some((option) => option.image)) return own;
  const chosen = new Set(chosenLabels(answer, options.map((option) => option.label), !!question.multiple));
  for (const option of options) {
    if (option.image && chosen.has(option.label)) own.push({ ...option.image, option: option.label });
  }
  return own;
}

/** A size in words: `316 B`, `4 KB`, `2.5 MB`, `13 MB`. */
export function bytesLabel(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  const mb = bytes / (1024 * 1024);
  return `${mb < 10 ? mb.toFixed(1) : Math.round(mb)} MB`;
}

/** What a run of media is, in words: `1 image`, `2 images, 1 video`. */
export function mediaCount(media: readonly Pick<Media, "kind">[]): string {
  const words: Record<MediaKind, [string, string]> = { image: ["image", "images"], video: ["video", "videos"], audio: ["recording", "recordings"] };
  return KINDS.flatMap((kind) => {
    const n = media.filter((m) => m.kind === kind).length;
    return n ? [`${n} ${words[kind][n === 1 ? 0 : 1]}`] : [];
  }).join(", ");
}
