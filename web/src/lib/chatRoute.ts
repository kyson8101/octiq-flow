/** Chat links accept both project slugs and legacy workspace IDs. */
export type ChatRoute = { project?: string; chat?: string };

export function readChatRoute(hash: string): ChatRoute {
  try {
    // Retired split links keep the selected chat, falling back to either target.
    if (hash.startsWith("#/split?")) {
      const params = new URLSearchParams(hash.slice(8));
      const chat = params.get(params.get("focus") === "right" ? "right" : "left") || params.get("left") || params.get("right");
      return chat ? { chat } : {};
    }
    const project = /^#\/p\/([^/]+)(?:\/c\/([^/?]+))?$/.exec(hash);
    if (project) return { project: decodeURIComponent(project[1]), ...(project[2] ? { chat: decodeURIComponent(project[2]) } : {}) };
    const chat = /^#\/c\/([^/?]+)$/.exec(hash);
    return chat ? { chat: decodeURIComponent(chat[1]) } : {};
  } catch { return {}; }
}
export function chatRouteHash(route: ChatRoute): string {
  if (route.project) return `#/p/${encodeURIComponent(route.project)}${route.chat ? `/c/${encodeURIComponent(route.chat)}` : ""}`;
  return route.chat ? `#/c/${encodeURIComponent(route.chat)}` : "";
}
