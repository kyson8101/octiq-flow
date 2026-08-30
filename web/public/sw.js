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
        data: {
          conversationId: id ?? null,
          projectId: (notice && notice.projectId) || null,
        },
        // Work that is BLOCKED on you should sit there until it is seen; a
        // turn that merely ended can go away by itself. Honoured on desktop
        // Chrome, ignored elsewhere, harmless either way.
        requireInteraction: !!notice && notice.kind !== "done",
      });
    })(),
  );
});

/** Where a tap is written down for the app to find on its way in.
 *
 *  `postMessage` only reaches a page that is RUNNING, and on a phone it usually
 *  is not: a home-screen app is suspended within seconds of going behind
 *  something, and killed outright soon after. So the chat that was asked for
 *  goes somewhere that outlives both the worker and the page, and whatever
 *  finally brings the app up reads it there — `openWindow`, the OS, or the
 *  person giving up on the banner and tapping the icon themselves.
 *
 *  Cache Storage because it is the one store both halves can reach from here.
 *  This is a mailbox, not the cache the top of the file swears off: one entry,
 *  written by the worker, taken by the page, and nothing ever fetches it. */
const TAPS = "octiq-tap";
const TAPPED = "./__octiq_tapped__";

async function rememberTap(conversationId, projectId) {
  if (!conversationId || !self.caches) return;
  try {
    const cache = await self.caches.open(TAPS);
    await cache.put(
      new Request(TAPPED),
      new Response(
        JSON.stringify({
          conversationId,
          projectId: projectId ?? null,
          at: Date.now(),
        }),
      ),
    );
  } catch {
    /* no store to write to; the message and the URL are the other two ways in */
  }
}

// Tapping the banner. Bring back the window that is already open rather than
// adding a second one — on a phone a duplicate tab is how you end up with two
// copies of a chat and no idea which is live.
self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const data = event.notification.data || {};
  const id = data.conversationId;
  const project = data.projectId;
  // The address, for the case where the app has to be started. It reads
  // `#/p/<project>/c/<chat>`, which is why the notice carries the project as
  // well as the chat; without both halves it launches and lands wherever it
  // left off, which is the one thing a tapped banner must not do. The token is
  // already in the page's own storage, so our own scope is enough to get back
  // in.
  const to =
    id && project
      ? `./#/p/${encodeURIComponent(project)}/c/${encodeURIComponent(id)}`
      : "./";

  event.waitUntil(
    (async () => {
      // Written down BEFORE anything is raised, because raising it is the part
      // that fails.
      await rememberTap(id, project);

      const windows = await self.clients.matchAll({
        type: "window",
        includeUncontrolled: true,
      });
      for (const client of windows) {
        // A page that is already running owns the conversation list and the
        // routing, so it only needs the chat id. Sent whether or not the window
        // can be brought forward: one that lands on a window the OS raised by
        // itself is worth more than a tap that said nothing at all.
        if (id) client.postMessage({ type: "open-chat", conversationId: id });
        let raised = null;
        try {
          raised = await client.focus();
        } catch {
          /* refused — `openWindow` below is the other way to raise it */
        }
        if (raised && raised.focused) return;
      }
      // Either nothing was open, or nothing could be RAISED — and on iOS the
      // second is the usual answer, which is what two earlier attempts at this
      // missed. `matchAll` lists a home-screen app that is merely suspended,
      // `focus()` cannot bring one of those back, and stopping at the refusal
      // left the tap doing nothing whatsoever. `openWindow` is the call that
      // launches it, so a window we could not raise has to fall through to
      // here rather than count as handled.
      if (self.clients.openWindow) {
        try {
          await self.clients.openWindow(to);
        } catch {
          /* not allowed to open one either; the note above is what is left */
        }
      }
    })(),
  );
});
