// The banner that reaches you when the app does not.
//
// Chats run in parallel and keep running while you read another one, or while
// the whole window is behind an editor. That is the point of them — but it also
// means the moment worth acting on (the turn ended, the agent wants permission,
// the agent asked you something) happens somewhere you are not looking. The
// permission and the question TIME OUT, three minutes and ten, so a moment you
// miss is not just a delay.
//
// So the browser is asked to put it on the desktop instead. Two rules keep it
// from becoming noise:
//
//   · Nothing is ever announced for the chat you are watching. "Watching" means
//     the tab is visible, the window has focus, AND that chat is the one on
//     screen — reading a different chat in the same window counts as away,
//     because the news is not in front of you either way.
//   · One live notification per chat per kind. A second one REPLACES it (that
//     is what `tag` does), so ten turns in a background chat leave one banner,
//     not ten.
//
// Off until switched on, and the switch is what asks the browser for
// permission: `Notification.requestPermission()` needs a real gesture, and a
// prompt on first load is the thing people click "Block" on.
import type { Message } from "./chat";
import type { NotificationTarget } from "./notificationOpen";
import { isWorkerChat, mainChatId } from "./orchestration";

/** What is being announced. */
export type NoticeKind = "done" | "permission" | "question";

/** Where you are, as far as one chat is concerned. */
export type Focus = {
  /** The tab is in the background, minimised, or on another Space. */
  hidden: boolean;
  /** The window has keyboard focus. */
  focused: boolean;
  /** The conversation on screen, or null when none is open. */
  reading: string | null;
};

/** Whether notifications are on, and whether the browser will allow them. */
export type Consent = {
  enabled: boolean;
  permission: NotificationPermission;
};

export type Notice = {
  kind: NoticeKind;
  /** The chat it belongs to. Clicking the banner opens this one. */
  conversationId: string;
  /** The chat's home. Needed when the banner launches a page from cold. */
  projectId: string | null;
  title: string;
  body: string;
  /** One banner per chat per kind — a later one takes the earlier one's place
   *  rather than stacking under it. */
  tag: string;
};

const KEY = "octiq.v2.notify";
/** Long enough to say what happened, short enough that macOS does not clip it
 *  mid-word. */
const MAX_BODY = 120;

/** Is this chat the one in front of you right now? */
export function isWatching(focus: Focus, conversationId: string): boolean {
  return !focus.hidden && focus.focused && focus.reading === conversationId;
}

/** Should this moment reach the desktop? */
export function owed(consent: Consent, focus: Focus, conversationId: string): boolean {
  if (!consent.enabled) return false;
  if (consent.permission !== "granted") return false;
  return !isWatching(focus, conversationId);
}

/** The chat a moment is announced on, or null for no banner at all.
 *
 *  Banners come from MAIN agents only. A run's workers are subagents of the
 *  chat that coordinates them: their turns ending and their questions (which
 *  reach you through a gate in the main chat anyway) say nothing. A worker's
 *  permission ask or safety refusal is still owed, because its card is drawn
 *  in the main chat and times out — so it is announced ON the main chat, where
 *  the click has to land. A worker whose main chat is not known yet stays
 *  silent rather than naming itself. Mirrors `announced_on` in push.rs. */
export function announcedOn(kind: NoticeKind, id: string, parents: ReadonlyMap<string, string>): string | null {
  if (!isWorkerChat(id, parents)) return id;
  if (kind !== "permission") return null;
  return mainChatId(id, parents);
}

/** One line of banner text out of however many lines of transcript. */
export function preview(text: string): string {
  const clean = text.replace(/\s+/g, " ").trim();
  return clean.length > MAX_BODY ? `${clean.slice(0, MAX_BODY)}…` : clean;
}

/** The bold line: the PROJECT first, then the chat.
 *
 *  Which piece of work this is about is what you need first, and a chat title
 *  alone does not say it — several projects are open at once and their chats
 *  are named after the task, not the codebase, so "Fix the top bar" could be
 *  any of them. The project is the coarser answer, so it goes in front where a
 *  clipped title still shows it.
 *
 *  Either half may be missing: a chat is untitled until its first turn, and a
 *  project the page does not know about yet has no name to give. Whatever is
 *  left stands alone, and "OctiqFlow" is what is left when nothing is. */
export function bannerTitle(projectName: string, chatTitle: string): string {
  return [projectName.trim(), chatTitle.trim()].filter(Boolean).join(" · ") || "OctiqFlow";
}

/** The banner's words. Titled after the WORK rather than the kind: on a desktop
 *  the title is the bold line, and which piece of work this is about is the
 *  thing you need first — what happened to it fits in the line below. */
export function noticeFor(input: {
  kind: NoticeKind;
  conversationId: string;
  projectId: string | null;
  projectName: string;
  chatTitle: string;
  detail: string;
  /** Agents mode: the registered agent the chat belongs to. An ordinary chat
   *  has none, and its banner never names a provider. Worded as `body_for`
   *  in push.rs words it. */
  agentName?: string;
}): Notice {
  const detail = preview(input.detail);
  const said =
    input.kind === "permission"
      ? `Needs permission: ${detail || "a tool call"}`
      : input.kind === "question"
        ? `Asked: ${detail || "a question"}`
        : detail || "Finished.";
  const who = input.agentName?.trim();
  const body = who ? `${who}: ${said}` : said;
  return {
    kind: input.kind,
    conversationId: input.conversationId,
    projectId: input.projectId,
    title: bannerTitle(input.projectName, input.chatTitle),
    body,
    tag: `octiq:${input.conversationId}:${input.kind}`,
  };
}

/** The agent's closing words, for the body of a "finished" banner.
 *
 *  Searched backwards for the last assistant turn that actually SAID something:
 *  a turn can end on a run of tool calls with no prose at all, and a blank
 *  banner is worse than a slightly older line. */
export function lastSaid(messages: Message[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m.role !== "assistant") continue;
    const text = m.blocks
      .map((b) => (b.kind === "text" ? b.text : ""))
      .filter(Boolean)
      .join(" ");
    if (text.trim()) return preview(text);
  }
  return "";
}

/** Where the app stands right now, for `owed` to read. */
export function focusNow(reading: string | null): Focus {
  if (typeof document === "undefined") return { hidden: true, focused: false, reading };
  return { hidden: document.hidden, focused: document.hasFocus(), reading };
}

/** Whether the browser can do this at all. A phone home-screen app on Android
 *  has the API but throws on the constructor, which `show` catches; a browser
 *  without the API at all should not be offered the switch. */
export function supported(): boolean {
  return typeof window !== "undefined" && "Notification" in window;
}

export function permissionNow(): NotificationPermission {
  return supported() ? Notification.permission : "denied";
}

export function isOn(): boolean {
  try {
    return localStorage.getItem(KEY) === "1";
  } catch {
    return false;
  }
}

export function setOn(on: boolean): void {
  try {
    localStorage.setItem(KEY, on ? "1" : "0");
  } catch {
    /* storage blocked: the switch holds for this page only */
  }
}

/** Ask the browser, from a click. Returns what it decided — including the case
 *  where it was already decided, since a second ask after "Block" is silently
 *  refused rather than re-prompted. */
export async function askPermission(): Promise<NotificationPermission> {
  if (!supported()) return "denied";
  if (Notification.permission !== "default") return Notification.permission;
  try {
    return await Notification.requestPermission();
  } catch {
    return "denied";
  }
}

/** Put it on the desktop. Clicking it brings the window forward and opens the
 *  chat it came from. */
export function show(notice: Notice, onOpen: (target: NotificationTarget) => void): void {
  if (!supported() || Notification.permission !== "granted") return;
  try {
    const banner = new Notification(notice.title, {
      body: notice.body,
      tag: notice.tag,
      icon: "./icon-192.png",
      // Ended work can go away by itself; work that is BLOCKED on you should
      // sit there until it is seen. Honoured on desktop Chrome, ignored
      // elsewhere, and harmless either way.
      requireInteraction: notice.kind !== "done",
    });
    banner.onclick = () => {
      window.focus();
      banner.close();
      onOpen({ conversationId: notice.conversationId, projectId: notice.projectId });
    };
  } catch {
    // Android needs a service worker registration to raise one of these, and
    // throws from the constructor. Nothing else in the app depends on this.
  }
}
