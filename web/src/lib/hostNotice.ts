// Host turns use the provider's user transport, but are never the person's
// words. Keep their identity and wire-text reading together, including older
// Claude records whose uuid is the provider's, not the notification receipt.
import type { Block, Message } from "./chat";
import { parseConfigUsage } from "./configUsage";

const PREFIX = "octiq-notification-";
const SEPARATOR = "\n\n---\n\n";

export function isNoticeTurn(turnId?: string | null): boolean {
  return !!turnId?.startsWith(PREFIX);
}

export function noticeTurnId(event: Record<string, unknown>): string | undefined {
  const ids = Array.isArray(event.octiq_orchestration_notification_ids)
    ? event.octiq_orchestration_notification_ids : [event.octiq_orchestration_notification_id];
  const receipt = ids.filter((id): id is string => typeof id === "string" && isNoticeTurn(id)).join("|");
  return receipt || (typeof event.uuid === "string" && isNoticeTurn(event.uuid) ? event.uuid : undefined);
}

export type HostNotice = {
  id: string;
  kind: string;
  subject: string;
  from?: string;
  /** Full original notice, including its envelope; the last keeps the host's footer. */
  text: string;
};

/** Labels are from known protocol shapes, never an excerpt of report prose. */
function hostKind(text: string): string {
  if (/^(?:.*\n)?Worker reported /m.test(text)) return "report";
  if (/^(?:Worker|Task|Attempt) .*\b(?:failed|disconnected)\b/im.test(text)) return "failure";
  if (/^.*\bcapacity\b/im.test(text.split("\n")[0])) return "capacity";
  return "unknown";
}

export function readNoticeTurn(turnId: string | undefined, text: string): HostNotice[] {
  if (!isNoticeTurn(turnId)) return [];
  const ids = turnId!.split("|");
  const envelopes = [...text.matchAll(/^OctiqFlow notification (octiq-notification-[^\s]+) for run [^\n]+\.\n\n/gm)]
    .filter((match) => ids.includes(match[1]));
  // A changed/partial protocol still folds, but never folds the answer to it.
  if (envelopes.length !== ids.length || envelopes[0]?.index !== 0
    || envelopes.some((match, i) => match[1] !== ids[i]
      || (i > 0 && text.slice(match.index! - SEPARATOR.length, match.index) !== SEPARATOR))) {
    return [{ id: turnId!, kind: "unknown", subject: "update", text }];
  }
  return envelopes.map((match, i) => {
    const end = envelopes[i + 1]?.index;
    const whole = text.slice(match.index, end === undefined ? undefined : end - SEPARATOR.length);
    const body = whole.slice(match[0].length);
    const header = /^Orchestration message \[([\w-]+)\]\nSubject: ([^\n]*)\nFrom: ([^\n]+)\n\n/.exec(body);
    const kind = header?.[1] ?? hostKind(body);
    return { id: match[1], kind, subject: header?.[2].trim() || (kind === "unknown" ? "update" : kind),
      ...(header ? { from: header[3].trim() } : {}), text: whole };
  });
}

export function noticeText(messages: readonly Message[]): string {
  return messages.filter((m) => m.role === "user").flatMap((m) => m.blocks)
    .flatMap((b) => b.kind === "text" ? [b.text] : []).join("\n\n");
}

export function statusOnly(notices: readonly HostNotice[]): boolean {
  return notices.length > 0 && notices.every((n) => n.kind === "status" || n.kind === "progress");
}

/** The host turn owns only its consecutive assistant output, up to the next
 * user/host turn. Group before windowing so loading history cannot orphan it. */
export function foldNoticeReplies(turns: Message[][]): Message[][] {
  const out: Message[][] = [];
  for (const turn of turns) {
    const previous = out[out.length - 1];
    if (turn[0]?.role === "assistant" && previous?.[0].role === "user"
      && isNoticeTurn(previous[0].turnId)
      && statusOnly(readNoticeTurn(previous[0].turnId, noticeText(previous)))) {
      out[out.length - 1] = [...previous, ...turn];
    } else out.push(turn);
  }
  return out;
}

/** Tools and event blocks always remain outside the accordion. A text that
 * can draw a card, or asks a question, also stays visible, including during
 * streaming. The disclosure still contains the whole prose reply. */
export function noticeReply(messages: readonly Message[]): { text: string; visible: Block[] } {
  const reply = messages.filter((m) => m.role === "assistant");
  const blocks = reply.flatMap((m): Block[] => [
    ...(m.progress ?? []).map((text) => ({ kind: "text" as const, text })),
    ...(m.codexCandidate ? [{ kind: "text" as const, text: m.codexCandidate }] : []),
    ...m.blocks,
  ]);
  const visible = blocks.filter((b) => b.kind !== "thinking"
    && (b.kind !== "text" || /[?？]|`{3}|~{3}|octiq-|visualize/i.test(b.text) || parseConfigUsage(b.text) !== null));
  const text = blocks.flatMap((b) => b.kind === "text" ? [b.text] : []).join("\n\n").trim();
  return { text, visible };
}

export function noticeSender(notice: HostNotice, nameOf: (key: string) => { name: string } | null): string {
  return notice.from ? nameOf(notice.from)?.name || "Worker" : "Host";
}
