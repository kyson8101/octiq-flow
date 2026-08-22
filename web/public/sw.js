// The part of OctiqFlow that runs when OctiqFlow does not.
//
// A service worker outlives the page. The phone's OS wakes it on a push with
// nothing of ours open — no tab, no home-screen app, a locked screen — draws
// the banner, and lets it go again. That is the whole reason this file exists,
// and it is why the notification path moved to the server: `lib/notify.ts` can
// only raise a banner while the page is running, which on a phone is almost
// never.
//
// Deliberately not a cache. Every offline-first instinct is wrong here: the app
// is a window onto a machine at the end of a tunnel, and a cached shell that
// loads while the backend is unreachable is worse than a page that fails
// honestly. `fetch` is not handled at all, so the network is always the answer.

/** Where the reader is, as the last open page described it.
 *
 *  The rule "say nothing about the chat you are already looking at" needs to
 *  know which chat that is, and only the page knows. It tells us on every
 *  change; we keep the latest.
 *
 *  This is memory, and a service worker is killed and restarted freely — so it
 *  is routinely empty even though a page is open. That is why an empty value
 *  means SHOW: a banner you did not need is a smaller failure than a permission
 *  ask you never saw. */
let reading = null;

self.addEventListener("message", (event) => {
  const data = event.data;
  if (data && data.type === "reading") {
    reading = data.conversationId ?? null;
  }
});

self.addEventListener("install", () => {
  // Take over on the first load rather than waiting for every old page to go.
  // There is no old version to be careful of — nothing is cached.
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(self.clients.claim());
});

/** Is a window open, focused, AND showing this chat? */
async function watching(conversationId) {
  const windows = await self.clients.matchAll({
    type: "window",
    includeUncontrolled: true,
  });
  const focused = windows.some((c) => c.focused && c.visibilityState === "visible");
  // Reading a DIFFERENT chat in a focused window still counts as away: the news
  // is not in front of you either way. This mirrors `isWatching` in
  // lib/notify.ts, which is the same rule for the other route.
  return focused && reading !== null && reading === conversationId;
}

self.addEventListener("push", (event) => {
  event.waitUntil(
    (async () => {
      let notice = null;
      try {
        notice = event.data ? event.data.json() : null;
      } catch {
        // A push whose body we cannot read still means somebody wants you.
      }

      const title = (notice && notice.title) || "OctiqFlow";
      const body = (notice && notice.body) || "Something needs you.";
      const id = notice && notice.conversationId;

      // iOS revokes the permission of an app that takes pushes and shows
      // nothing, so the one case we stay silent for is the one that is
      // genuinely redundant: the chat is on screen in front of you.
      if (id && (await watching(id))) return;

      await self.registration.showNotification(title, {
        body,
        // One live banner per chat per kind — a later one takes the earlier
        // one's place instead of stacking under it.
        tag: (notice && notice.tag) || "octiq",
        icon: "./icon-192.png",
        badge: "./icon-192.png",
        data: { conversationId: id ?? null },
        // Work that is BLOCKED on you should sit there until it is seen; a
        // turn that merely ended can go away by itself. Honoured on desktop
        // Chrome, ignored elsewhere, harmless either way.
        requireInteraction: !!notice && notice.kind !== "done",
      });
    })(),
  );
});

// Tapping the banner. Bring back the window that is already open rather than
// adding a second one — on a phone a duplicate tab is how you end up with two
// copies of a chat and no idea which is live.
self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const id = event.notification.data && event.notification.data.conversationId;

  event.waitUntil(
    (async () => {
      const windows = await self.clients.matchAll({
        type: "window",
        includeUncontrolled: true,
      });
      if (windows.length > 0) {
        const client = windows[0];
        await client.focus();
        // The page opens the chat; it owns the conversation list and the
        // routing. Told after focus, so it acts on a window already in front.
        if (id) client.postMessage({ type: "open-chat", conversationId: id });
        return;
      }
      // Nothing open. Start the app, naming the chat in the URL — the token is
      // already in the page's own storage, so `openWindow` on our own scope is
      // enough to get back in.
      if (self.clients.openWindow) {
        await self.clients.openWindow(id ? `./?chat=${encodeURIComponent(id)}` : "./");
      }
    })(),
  );
});
