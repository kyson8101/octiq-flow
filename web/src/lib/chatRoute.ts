/** Chat links accept both project slugs and legacy workspace IDs. `beside` is
 *  the task chat open beside this (main) chat — see lib/chatBeside. */
export type ChatRoute = { project?: string; chat?: string; beside?: string };

export function readChatRoute(hash: string): ChatRoute {
  try {
    // Retired split links keep the selected chat, falling back to either target.
    if (hash.startsWith("#/split?")) {
      const params = new URLSearchParams(hash.slice(8));
      const chat = params.get(params.get("focus") === "right" ? "right" : "left") || params.get("left") || params.get("right");
      return chat ? { chat } : {};
    }
    const project = /^#\/p\/([^/]+)(?:\/c\/([^/?]+)(?:\/beside\/([^/?]+))?)?$/.exec(hash);
    if (project) return {
      project: decodeURIComponent(project[1]),
      ...(project[2] ? { chat: decodeURIComponent(project[2]) } : {}),
      ...(project[2] && project[3] ? { beside: decodeURIComponent(project[3]) } : {}),
    };
    const chat = /^#\/c\/([^/?]+)(?:\/beside\/([^/?]+))?$/.exec(hash);
    return chat ? { chat: decodeURIComponent(chat[1]), ...(chat[2] ? { beside: decodeURIComponent(chat[2]) } : {}) } : {};
  } catch { return {}; }
}
export function chatRouteHash(route: ChatRoute): string {
  const beside = route.chat && route.beside ? `/beside/${encodeURIComponent(route.beside)}` : "";
  if (route.project) return `#/p/${encodeURIComponent(route.project)}${route.chat ? `/c/${encodeURIComponent(route.chat)}${beside}` : ""}`;
  return route.chat ? `#/c/${encodeURIComponent(route.chat)}${beside}` : "";
}

/** Keep the address bar linkable without turning chat selections into browser
 *  history. In particular, a system edge gesture must never walk through old
 *  conversations when it escapes the app's drawer gesture. */
export function replaceChatRoute(
  location: Pick<Location, "hash" | "pathname" | "search">,
  history: Pick<History, "replaceState">,
  route: ChatRoute,
): boolean {
  const next = chatRouteHash(route);
  if (next === location.hash) return false;
  history.replaceState(null, "", `${location.pathname}${location.search}${next}`);
  return true;
}
