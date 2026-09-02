// Getting this browser onto the server's list of phones to wake.
//
// `notify.ts` raises a banner from the page, which needs the page to be
// running. This is the other half: a subscription the SERVER can send to, so
// the banner arrives with nothing open — the case that actually matters on a
// phone, where a backgrounded app is suspended within seconds and a locked one
// is not running at all.
//
// The exchange, once, when the switch goes on:
//
//   1. ask the browser for permission           (needs a real click)
//   2. register sw.js                            (the thing that will be woken)
//   3. push_key                 → the server's VAPID public key
//   4. subscribe with that key                   (the browser talks to Apple
//                                                 or Google and returns an
//                                                 endpoint plus two secrets)
//   5. push_subscribe           → hand all three to the server
//
// Step 4 is where the encryption keys come from: everything the server sends is
// sealed with them, so the push service relays a body it cannot read.
import { fromBase64Url, toBase64Url } from "./base64url";
import { bridge } from "./bridge";

/** What the browser gives us to hand to the server. The shape
 *  `PushSubscription.toJSON()` produces, flattened — the server stores exactly
 *  these three fields. */
type Registration = {
  endpoint: string;
  p256dh: string;
  auth: string;
};

/** Web Push needs a service worker AND the Push API. Safari in a normal iOS tab
 *  has neither; the same Safari, once the app is on the home screen, has both.
 *  That is the difference the Settings sheet has to explain. */
export function supported(): boolean {
  return (
    typeof navigator !== "undefined" &&
    "serviceWorker" in navigator &&
    typeof window !== "undefined" &&
    "PushManager" in window
  );
}

/** Whether this is a home-screen app rather than a browser tab.
 *
 *  Only meaningful on iOS, and the single most useful thing to be able to say
 *  there: web push exists for an installed app and does not exist for a tab, so
 *  a user who has not installed it is not doing anything wrong — they are one
 *  step short, and no amount of tapping the switch will do it for them.
 *
 *  It lives in `lib/installed` now, because the top bar's reload asks the same
 *  question and importing it from a component pulled the socket bridge in
 *  behind it. Kept on this module's surface because every caller here reads it
 *  as part of the push story. Imported rather than re-exported straight
 *  through, since this module also calls it itself further down. */
import { installed } from "./installed";
export { installed };

/** iOS, where the home-screen rule applies. Used only to word the hint. */
export function isIOS(): boolean {
  if (typeof navigator === "undefined") return false;
  return (
    /iPad|iPhone|iPod/.test(navigator.userAgent) ||
    // iPadOS reports itself as a Mac; the touch points give it away.
    (navigator.userAgent.includes("Mac") && navigator.maxTouchPoints > 1)
  );
}

function flatten(sub: PushSubscription): Registration {
  const json = sub.toJSON() as { keys?: { p256dh?: string; auth?: string } };
  return {
    endpoint: sub.endpoint,
    // `toJSON` already base64urls them where it is implemented properly; the
    // raw buffers are the fallback for where it is not.
    p256dh: json.keys?.p256dh ?? toBase64Url(sub.getKey("p256dh")),
    auth: json.keys?.auth ?? toBase64Url(sub.getKey("auth")),
  };
}

/** Register the worker that will be woken. Idempotent — the browser keeps one
 *  registration per scope and hands the same one back. */
export async function register(): Promise<ServiceWorkerRegistration | null> {
  if (!supported()) return null;
  try {
    // Relative, like every other URL the client builds: the bundle has to work
    // wherever it is mounted. The scope follows the file's own folder, which is
    // the app root — so the worker controls the whole app.
    return await navigator.serviceWorker.register("./sw.js");
  } catch {
    return null;
  }
}

/** Turn it on. Returns what actually happened, because "the switch is on" and
 *  "the phone will ring" are not the same claim and only one of them is worth
 *  showing somebody. */
export async function enable(): Promise<
  "on" | "denied" | "unsupported" | "needs-install" | "failed"
> {
  if (!supported()) return isIOS() && !installed() ? "needs-install" : "unsupported";

  const decision =
    Notification.permission === "default"
      ? await Notification.requestPermission()
      : Notification.permission;
  if (decision !== "granted") return "denied";

  const registration = await register();
  if (!registration) return "failed";

  try {
    const { key } = await bridge.invoke<{ key: string }>("push_key");
    if (!key) return "failed";

    // An existing subscription is reused rather than replaced: it is already
    // the one the server has, and re-subscribing would hand back a different
    // endpoint for the same browser.
    const existing = await registration.pushManager.getSubscription();
    const sub =
      existing ??
      (await registration.pushManager.subscribe({
        // Every push must draw a banner. It is not a preference — iOS revokes
        // the permission of an app that takes silent pushes.
        userVisibleOnly: true,
        applicationServerKey: fromBase64Url(key),
      }));

    await bridge.invoke("push_subscribe", { ...flatten(sub) });
    return "on";
  } catch {
    return "failed";
  }
}

/** Turn it off at both ends. The server is told first: a subscription it still
 *  holds after the browser has dropped it is a send that fails every time. */
export async function disable(): Promise<void> {
  if (!supported()) return;
  try {
    const registration = await navigator.serviceWorker.getRegistration();
    const sub = await registration?.pushManager.getSubscription();
    if (!sub) return;
    await bridge.invoke("push_unsubscribe", { endpoint: sub.endpoint });
    await sub.unsubscribe();
  } catch {
    /* Already gone, or offline. The switch still reads off. */
  }
}

/** Whether this browser is subscribed right now.
 *
 *  Asked of the BROWSER rather than remembered in localStorage, because the
 *  browser is the one that can revoke it — clearing site data, or iOS dropping
 *  a home-screen app's subscription — and a remembered "on" that is no longer
 *  true is exactly the lie that costs somebody a missed permission ask. */
export async function isOn(): Promise<boolean> {
  if (!supported() || Notification.permission !== "granted") return false;
  try {
    const registration = await navigator.serviceWorker.getRegistration();
    return !!(await registration?.pushManager.getSubscription());
  } catch {
    return false;
  }
}

/** The worker's mailbox for a tapped banner. Named the same at both ends; see
 *  the comment over `rememberTap` in `public/sw.js` for why it exists. */
const TAPS = "octiq-tap";

/** How long a tap is still worth acting on.
 *
 *  It is read on the way in and every time the app comes back to the front, so
 *  it needs a limit: a banner tapped at breakfast must not drag you out of
 *  whatever you are doing at lunch. Long enough to cover a tap that failed to
 *  raise anything and the person opening the app themselves a moment later,
 *  which is the case this whole path is for. */
export const TAP_GOOD_FOR = 5 * 60 * 1000;

/** Whether a tap written down at `at` is still the thing you meant. */
export function stillWanted(at: number, now: number = Date.now()): boolean {
  return Number.isFinite(at) && now - at < TAP_GOOD_FOR;
}

/** The chat a tapped banner asked for, if one is waiting.
 *
 *  Taken, not read: the record is deleted as it is handed over, so one tap
 *  opens one chat once however many times the app is resumed afterwards. A tap
 *  older than `TAP_GOOD_FOR` is dropped the same way — cleared, and not acted
 *  on.
 *
 *  Found by walking the cache rather than by matching a URL: the two halves
 *  resolve a relative name against their own base, and the mailbox holds
 *  exactly one letter by construction. */
export async function takeTapped(now: number = Date.now()): Promise<string | null> {
  if (typeof caches === "undefined") return null;
  try {
    const cache = await caches.open(TAPS);
    const [key] = await cache.keys();
    if (!key) return null;
    let record: { conversationId?: string; at?: number } | null = null;
    try {
      // Read BEFORE the entry goes: a body is only guaranteed to be there while
      // the thing it came out of still is.
      const hit = await cache.match(key);
      record = hit ? ((await hit.json()) as { conversationId?: string; at?: number }) : null;
    } finally {
      // ...and gone whatever it turned out to say. A letter that cannot be read
      // is one this would otherwise trip over on every resume forever.
      await cache.delete(key);
    }
    if (typeof record?.conversationId !== "string" || !record.conversationId) return null;
    return stillWanted(record.at ?? 0, now) ? record.conversationId : null;
  } catch {
    /* no store, or a half-written record: the tap is simply lost */
    return null;
  }
}

/** Tell the worker which chat is on screen, so it can stay quiet about that one.
 *
 *  Cheap enough to send on every change, and it has to be: the worker is killed
 *  and restarted freely, so this is the only thing that refills it. */
export function setReading(conversationId: string | null): void {
  if (!supported()) return;
  navigator.serviceWorker.controller?.postMessage({
    type: "reading",
    conversationId,
  });
}
