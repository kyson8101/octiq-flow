/** Public URLs describe a layout; pane URLs still accept all old project links. */
export type PaneSide = "left" | "right";
export type ChatRoute = { project?: string; chat?: string };
export type ChatLayout = { left: ChatRoute; right?: ChatRoute; focus: PaneSide };

export function readChatRoute(hash: string): ChatRoute {
  try {
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
export function readChatLayout(hash: string): ChatLayout {
  if (hash.startsWith("#/split?")) {
    const params = new URLSearchParams(hash.slice(8));
    const left = params.get("left");
    const right = params.get("right");
    if (left && right && left !== right) return { left: { chat: left }, right: { chat: right }, focus: params.get("focus") === "right" ? "right" : "left" };
    return { left: left ? { chat: left } : {}, focus: "left" };
  }
  return { left: readChatRoute(hash), focus: "left" };
}
export function chatLayoutHash(layout: ChatLayout): string {
  if (!layout.left.chat || !layout.right?.chat || layout.left.chat === layout.right.chat) return chatRouteHash(layout.left);
  return `#/split?${new URLSearchParams({ left: layout.left.chat, right: layout.right.chat, focus: layout.focus })}`;
}
export function sameRoute(a: ChatRoute, b: ChatRoute): boolean {
  return a.chat || b.chat ? a.chat === b.chat : a.project === b.project;
}
export function beside(layout: ChatLayout, source: PaneSide, chat: string): ChatLayout {
  if (layout.left.chat === chat) return { ...layout, focus: "left" };
  if (layout.right?.chat === chat) return { ...layout, focus: "right" };
  if (!layout.left.chat) return { left: { chat }, focus: "left" };
  const side = source === "right" ? "left" : "right";
  return { ...layout, [side]: { chat }, focus: side };
}
export function paneMessage(data: unknown): data is { type: "octiq-pane"; action: "ready" | "focus" | "route" | "beside"; route?: ChatRoute; title?: string; chat?: string } {
  if (!data || typeof data !== "object") return false;
  const value = data as Record<string, unknown>;
  if (value.type !== "octiq-pane") return false;
  if (value.action === "ready" || value.action === "focus") return true;
  if (value.action === "beside") return typeof value.chat === "string" && value.chat.length > 0;
  if (value.action !== "route" || !value.route || typeof value.route !== "object") return false;
  const route = value.route as Record<string, unknown>;
  return (route.chat === undefined || typeof route.chat === "string") && (route.project === undefined || typeof route.project === "string") && typeof value.title === "string";
}
export function isChatPane(): boolean {
  try {
    return typeof window !== "undefined" && window.parent !== window && window.parent.location.origin === window.location.origin && new URLSearchParams(window.location.search).get("pane") === "1";
  } catch { return false; }
}
export function tellLayout(message: Record<string, unknown>): void {
  if (isChatPane()) window.parent.postMessage({ type: "octiq-pane", ...message }, window.location.origin);
}
export function openBeside(chat: string): void { tellLayout({ action: "beside", chat }); }
