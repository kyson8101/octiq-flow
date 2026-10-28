// The small, explicit controls for a file mentioned in a conversation.
//
// A path itself remains the familiar thing to click. Hovering or focusing it
// reveals the two named actions without leaving a pair of unexplained icons in
// every paragraph: "Copy path" puts the canonical server path on the clipboard
// for sharing, and "Open in OctiqFlow" uses the app's usual file viewer.
import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { copyText } from "../lib/clipboard";
import { hideFileActionPopover, showFileActionPopover } from "../lib/fileActionPopover";
import { focusAt, keepsEscape } from "../lib/placeTip";
import { useOpenFile } from "./OpenFileContext";
import { CopyIcon, TickIcon } from "./CopyBit";

export function ConversationFileActions({
  path,
  children,
  code = false,
}: {
  /** The resolved path on the server, rather than the shorter words in the reply. */
  path: string;
  children: ReactNode;
  /** Inline-code paths keep their existing code-chip treatment. */
  code?: boolean;
}) {
  const open = useOpenFile();
  const [copied, setCopied] = useState(false);
  const root = useRef<HTMLSpanElement>(null);
  const menu = useRef<HTMLSpanElement>(null);
  const hoverLine = useRef(0);
  const hoverY = useRef<number | null>(null);
  const closing = useRef(false);
  const [hovered, setHovered] = useState(false);
  const [hoverReady, setHoverReady] = useState(false);
  const [focused, setFocused] = useState(false);
  const [dismissed, setDismissed] = useState(false);
  const engaged = !dismissed && ((hovered && hoverReady) || focused);
  const inside = (target: EventTarget | null) => target instanceof Node && root.current?.contains(target);

  useEffect(() => {
    if (!hovered || !matchMedia('(hover: hover)').matches) return;
    const timer = setTimeout(() => setHoverReady(true), 180);
    return () => clearTimeout(timer);
  }, [hovered]);

  const leave = (target: EventTarget | null) => {
    if (inside(target)) return;
    setHovered(false);
    setHoverReady(false);
  };

  useLayoutEffect(() => {
    const anchor = root.current;
    const popup = menu.current;
    if (!anchor || !popup || !engaged || !matchMedia('(hover: hover)').matches) return;
    // The phone chat pane has its own stacking context. A native top-layer
    // popover escapes both that context and the transcript's overflow without
    // breaking the DOM ancestry used by hover and focus-within. Touch never
    // gets this attribute and keeps its always-visible inline actions.
    const topLayer = showFileActionPopover(popup);
    const position = () => {
      const lines = [...anchor.querySelector('button')!.getClientRects()];
      if (hoverY.current !== null) {
        const y = hoverY.current;
        hoverLine.current = Math.max(0, lines.findIndex(r => y >= r.top && y <= r.bottom));
        hoverY.current = null;
      }
      const path = lines[hoverLine.current] ?? lines[0];
      if (!anchor.isConnected || !path) return;
      const scroller = anchor.closest('.msgs')?.getBoundingClientRect();
      if (scroller && (path.bottom < scroller.top || path.top > scroller.bottom)) {
        setDismissed(true);
        return;
      }
      const width = popup.offsetWidth, height = popup.offsetHeight;
      const left = Math.max(8, Math.min(path.left, innerWidth - width - 8));
      // Prefer above the path, but do not move the interception onto a player
      // above it. Fixed positioning escapes the transcript's overflow at its
      // first visible line; the menu remains a DOM child for hover/focus.
      const candidates = [
        { left, top: path.top - height },
        { left, top: path.bottom },
        { left: path.right, top: Math.max(8, Math.min(path.top, innerHeight - height - 8)) },
        { left: path.left - width, top: Math.max(8, Math.min(path.top, innerHeight - height - 8)) },
      ].filter(p => p.left >= 0 && p.left + width <= innerWidth && p.top >= 0 && p.top + height <= innerHeight
        // The in-flow fallback cannot escape the transcript's clipping box.
        && (topLayer || !scroller || (p.left >= scroller.left && p.left + width <= scroller.right
          && p.top >= scroller.top && p.top + height <= scroller.bottom)));
      const media = [...document.querySelectorAll('video, audio')].map(el => el.getBoundingClientRect());
      const overlap = (p: { left: number; top: number }) => media.reduce((sum, r) => sum
        + Math.max(0, Math.min(p.left + width, r.right) - Math.max(p.left, r.left))
        * Math.max(0, Math.min(p.top + height, r.bottom) - Math.max(p.top, r.top)), 0);
      const fallback = { left, top: !topLayer && scroller ? Math.max(scroller.top, Math.min(path.bottom, scroller.bottom - height)) : 0 };
      const best = candidates.reduce((best, p) => overlap(p) < overlap(best) ? p : best, candidates[0] ?? fallback);
      // The fallback stays in the path's original inline containing block.
      // Use its first fragment's origin when translating viewport placement.
      const origin = topLayer ? { left: 0, top: 0 } : anchor.getClientRects()[0];
      popup.style.left = `${best.left - origin.left}px`;
      popup.style.top = `${best.top - origin.top}px`;
    };
    position();
    // Keep it attached during scrolling and streaming; a path outside its
    // scroller dismisses it. Neither listener lives beyond engagement.
    document.addEventListener('scroll', position, true);
    window.addEventListener('resize', position);
    const observer = new ResizeObserver(position);
    observer.observe(anchor.closest('.msgs-inner') ?? anchor.parentElement!);
    return () => {
      document.removeEventListener('scroll', position, true);
      window.removeEventListener('resize', position);
      observer.disconnect();
      closing.current = true;
      hideFileActionPopover(popup);
      popup.style.removeProperty('left');
      popup.style.removeProperty('top');
      closing.current = false;
    };
  }, [engaged]);

  useEffect(() => {
    if (!engaged || !matchMedia('(hover: hover)').matches) return;
    const key = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      const ours = keepsEscape(true, focusAt<Node>(document.activeElement, root.current, document.body));
      if (ours) {
        event.preventDefault();
        event.stopPropagation();
        // Focus restoration must not immediately ask for the menu again.
        closing.current = true;
        root.current?.querySelector('button')?.focus({ preventScroll: true });
        closing.current = false;
      }
      setDismissed(true);
    };
    document.addEventListener('keydown', key, true);
    return () => document.removeEventListener('keydown', key, true);
  }, [engaged]);

  const copy = async () => {
    if (!await copyText(path)) return;
    setCopied(true);
    setTimeout(() => setCopied(false), 1400);
  };

  const openPath = () => {
    if (engaged && matchMedia('(hover: hover)').matches) setDismissed(true);
    open(path);
  };

  return (
    <span
      className="prose-file-actions"
      data-menu-open={engaged || undefined}
      data-menu-dismissed={dismissed || undefined}
      ref={root}
      onPointerEnter={event => {
        if (!engaged) {
          hoverY.current = event.clientY;
        }
        if (!hovered) setHoverReady(false);
        setDismissed(false);
        setHovered(true);
      }}
      onPointerMove={event => { if (!engaged) hoverY.current = event.clientY; }}
      onPointerLeave={event => leave(event.relatedTarget)}
      onFocus={() => {
        if (closing.current) return;
        if (!engaged) { hoverLine.current = 0; hoverY.current = null; }
        setDismissed(false);
        setFocused(true);
      }}
      onBlur={event => { if (!event.currentTarget.contains(event.relatedTarget)) setFocused(false); }}
    >
      <button
        className={`prose-path ${code ? "is-code" : ""}`}
        type="button"
        title={path}
        onClick={openPath}
      >
        {children}
      </button>
      <span
        className="prose-file-action-menu"
        ref={menu}
        onPointerEnter={() => setHovered(true)}
        onPointerLeave={event => leave(event.relatedTarget)}
        role="group"
        aria-label={`File actions for ${path}`}
      >
        <button
          className={`prose-file-action ${copied ? "is-copied" : ""}`}
          type="button"
          title={copied ? "Path copied" : `Copy path: ${path}`}
          aria-label={copied ? "Path copied" : `Copy path: ${path}`}
          onClick={() => void copy()}
        >
          {copied ? <TickIcon /> : <CopyIcon />}
          <span className="prose-file-action-label">
            {copied ? "Path copied" : "Copy path"}
          </span>
        </button>
        <button
          className="prose-file-action"
          type="button"
          title={`Open in OctiqFlow: ${path}`}
          aria-label={`Open in OctiqFlow: ${path}`}
          onClick={openPath}
        >
          <OpenIcon />
          <span className="prose-file-action-label">Open in OctiqFlow</span>
        </button>
      </span>
    </span>
  );
}

/** An arrow leaving a document: open this file in OctiqFlow's viewer. */
function OpenIcon() {
  return (
    <svg
      width="13"
      height="13"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M14 3h7v7" />
      <path d="m21 3-9 9" />
      <path d="M19 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2h6" />
    </svg>
  );
}
