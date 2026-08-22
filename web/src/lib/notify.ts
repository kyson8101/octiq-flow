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

/** One line of banner text out of however many lines of transcript. */
export function preview(text: string): string {
  const clean = text.replace(/\s+/g, " ").trim();
  return clean.length > MAX_BODY ? `${clean.slice(0, MAX_BODY)}…` : clean;
}

/** The banner's words. Titled after the CHAT rather than the kind: on a desktop
 *  the title is the bold line, and which piece of work this is about is the
 *  thing you need first — what happened to it fits in the line below. */
export function noticeFor(input: {
  kind: NoticeKind;
  conversationId: string;
  chatTitle: string;
  detail: string;
}): Notice {
  const detail = preview(input.detail);
  const body =
    input.kind === "permission"
      ? `Needs permission: ${detail || "a tool call"}`
      : input.kind === "question"
        ? `Asked: ${detail || "a question"}`
        : detail || "Finished.";
  return {
    kind: input.kind,
    conversationId: input.conversationId,
    title: input.chatTitle.trim() || "OctiqFlow",
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
export function show(notice: Notice, onOpen: (conversationId: string) => void): void {
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
      onOpen(notice.conversationId);
    };
  } catch {
    // Android needs a service worker registration to raise one of these, and
    // throws from the constructor. Nothing else in the app depends on this.
  }
}
