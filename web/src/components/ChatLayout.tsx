import { useEffect, useRef, useState, type CSSProperties } from "react";
import { beside, chatLayoutHash, chatRouteHash, paneMessage, readChatLayout, sameRoute, type ChatLayout as Layout, type ChatRoute, type PaneSide } from "../lib/chatLayout";
import { recall, remember } from "../lib/remember";
import "./ChatLayout.css";

const SAVED = "octiq.v2.lastSplit";
const WIDTH = "octiq.v2.splitWidth";
const clamp = (value: number) => Math.max(25, Math.min(75, value));

/** Each frame owns a full chat client, including DOM-scoped editors, shortcuts,
 * and project tools. The shell owns only navigation; closing a pane never stops
 * its server-owned agent. Frames stay mounted when leaving and returning. */
export default function ChatLayout() {
  const [layout, setLayout] = useState<Layout>(() => readChatLayout(location.hash));
  const current = useRef(layout);
  const frames = useRef<Partial<Record<PaneSide, HTMLIFrameElement | null>>>({});
  const loaded = useRef<Partial<Record<PaneSide, boolean>>>({});
  const pending = useRef<Partial<Record<PaneSide, ChatRoute>>>({});
  const initial = useRef({ left: layout.left, right: layout.right });
  const [rightSeen, setRightSeen] = useState(!!layout.right);
  const [titles, setTitles] = useState({ left: "Left chat", right: "Right chat" });
  const [saved, setSaved] = useState(() => {
    const hash = recall(SAVED);
    return hash && readChatLayout(hash).right ? hash : null;
  });
  const [width, setWidth] = useState(() => clamp(Number(recall(WIDTH)) || 50));
  const container = useRef<HTMLDivElement>(null);
  const [dragging, setDragging] = useState(false);

  function command(side: PaneSide, route: ChatRoute) {
    pending.current[side] = route;
    if (loaded.current[side]) frames.current[side]?.contentWindow?.postMessage({ type: "octiq-layout", action: "navigate", route }, location.origin);
  }
  function apply(next: Layout, mode: "push" | "replace" | "restore" = "push", source?: PaneSide) {
    const previous = current.current;
    current.current = next;
    setLayout(next);
    if (next.right) {
      setRightSeen(true);
      if (!initial.current.right) initial.current.right = next.right;
      const hash = chatLayoutHash(next);
      remember(SAVED, hash);
      setSaved(hash);
    }
    if (mode !== "restore") {
      const hash = chatLayoutHash(next);
      if (hash !== location.hash) history[mode === "push" ? "pushState" : "replaceState"](null, "", location.pathname + location.search + hash);
    }
    for (const side of ["left", "right"] as const) {
      const route = next[side];
      if (side !== source && route && (!previous[side] || !sameRoute(route, previous[side]!))) command(side, route);
    }
  }
  const applyRef = useRef(apply);
  applyRef.current = apply;

  useEffect(() => {
    function onMessage(event: MessageEvent) {
      if (event.origin !== location.origin || !paneMessage(event.data)) return;
      const side = event.source === frames.current.left?.contentWindow ? "left"
        : event.source === frames.current.right?.contentWindow ? "right" : null;
      if (!side) return;
      const data = event.data;
      const now = current.current;
      if (data.action === "ready") {
        loaded.current[side] = true;
        const target = pending.current[side] ?? now[side];
        if (target && (target.chat || target.project)) command(side, target);
      } else if (data.action === "focus") {
        if (now[side] && now.focus !== side) applyRef.current({ ...now, focus: side }, "replace");
      } else if (data.action === "beside" && data.chat) {
        applyRef.current(beside(now, side, data.chat));
      } else if (data.action === "route" && data.route) {
        if (!now[side]) return;
        const wanted = pending.current[side];
        if (wanted && !sameRoute(wanted, data.route)) return;
        delete pending.current[side];
        setTitles(previous => ({ ...previous, [side]: data.title! }));
        const other = side === "left" ? now.right : now.left;
        // Choosing the already-visible chat focuses it instead of mounting two composers for it.
        if (data.route.chat && other?.chat === data.route.chat) {
          command(side, now[side]!);
          applyRef.current({ ...now, focus: side === "left" ? "right" : "left" }, "replace");
          return;
        }
        const changed = !sameRoute(now[side]!, data.route);
        applyRef.current({ ...now, [side]: data.route }, changed && now[side]?.chat ? "push" : "replace", side);
      }
    }
    const restore = () => applyRef.current(readChatLayout(location.hash), "restore");
    const notification = (event: MessageEvent) => {
      if (event.data?.type === "open-chat" && typeof event.data.conversationId === "string") {
        const now = current.current;
        const chat = event.data.conversationId;
        const visible = now.left.chat === chat ? "left" : now.right?.chat === chat ? "right" : null;
        applyRef.current(visible ? { ...now, focus: visible } : { ...now, [now.focus]: { chat } });
      }
    };
    window.addEventListener("message", onMessage);
    window.addEventListener("popstate", restore);
    window.addEventListener("hashchange", restore);
    navigator.serviceWorker?.addEventListener("message", notification);
    return () => {
      window.removeEventListener("message", onMessage);
      window.removeEventListener("popstate", restore);
      window.removeEventListener("hashchange", restore);
      navigator.serviceWorker?.removeEventListener("message", notification);
    };
  }, []);

  useEffect(() => {
    document.title = layout.right ? `${titles.left} | ${titles.right} — OctiqFlow` : `${titles.left} — OctiqFlow`;
  }, [titles, layout.right]);

  useEffect(() => {
    if (layout.right && window.innerWidth <= 700) {
      frames.current[layout.focus]?.closest("section")?.scrollIntoView({ block: "nearest", inline: "nearest" });
    }
  }, [layout.focus, !!layout.right]);

  function source(side: PaneSide) {
    const url = new URL(location.href);
    url.searchParams.set("pane", "1");
    url.searchParams.set("side", side);
    url.hash = chatRouteHash(initial.current[side] ?? {});
    return url.pathname + url.search + url.hash;
  }
  // src must remain stable: setting it on every navigation would reload a frame and lose drafts.
  const sources = useRef<Partial<Record<PaneSide, string>>>({});
  function pane(side: PaneSide) {
    if (!sources.current[side]) sources.current[side] = source(side);
    return <section className={`layout-pane ${layout.focus === side ? "is-focused" : ""}`} hidden={side === "right" && !layout.right} aria-label={`${side} chat pane`}>
      {layout.right && <header className="layout-pane-heading">
        <button type="button" className="layout-pane-title" onClick={() => { apply({ ...layout, focus: side }, "replace"); frames.current[side]?.contentWindow?.focus(); }} title={titles[side]}>{titles[side]}</button>
        <button type="button" onClick={() => apply({ left: layout[side]!, focus: "left" })} title="Show only this chat">Only this chat</button>
      </header>}
      <iframe ref={node => { frames.current[side] = node; }} src={sources.current[side]} title={`${side === "left" ? "Left" : "Right"} chat workspace`} allow="clipboard-read; clipboard-write; fullscreen" />
    </section>;
  }

  return <div ref={container} className={`chat-layout ${layout.right ? "is-split" : ""} ${dragging ? "is-resizing" : ""}`} style={{ "--split-left": `${width}%` } as CSSProperties}>
    {!layout.right && saved && <div className="layout-return"><button type="button" onClick={() => apply(readChatLayout(saved))}>Return to split chat</button></div>}
    {layout.right && <nav className="layout-mobile-tabs" aria-label="Chat panes">
      {(["left", "right"] as const).map(side => <button type="button" key={side} aria-pressed={layout.focus === side} onClick={() => apply({ ...layout, focus: side }, "replace")}>{side === "left" ? "Left chat" : "Right chat"}</button>)}
    </nav>}
    <div className="layout-panes">
      {pane("left")}
      {layout.right && <div className="layout-divider" role="separator" aria-label="Resize chat panes" aria-orientation="vertical" aria-valuemin={25} aria-valuemax={75} aria-valuenow={Math.round(width)} tabIndex={0}
        onDoubleClick={() => { setWidth(50); remember(WIDTH, "50"); }}
        onKeyDown={event => {
          if (!["ArrowLeft", "ArrowRight", "Home"].includes(event.key)) return;
          event.preventDefault();
          const next = event.key === "Home" ? 50 : clamp(width + (event.key === "ArrowLeft" ? -5 : 5));
          setWidth(next); remember(WIDTH, String(next));
        }}
        onPointerDown={event => { event.preventDefault(); event.currentTarget.setPointerCapture(event.pointerId); setDragging(true); }}
        onPointerMove={event => {
          if (!event.currentTarget.hasPointerCapture(event.pointerId)) return;
          const box = container.current!.getBoundingClientRect();
          const next = clamp((event.clientX - box.left) / box.width * 100);
          setWidth(next); remember(WIDTH, String(next));
        }}
        onPointerUp={event => { event.currentTarget.releasePointerCapture(event.pointerId); setDragging(false); }}
        onLostPointerCapture={() => setDragging(false)} />}
      {rightSeen && pane("right")}
    </div>
  </div>;
}
