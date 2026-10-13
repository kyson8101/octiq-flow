// A card diagram in a reply: rows of framed nodes, an arrow between rows.
//
// What it draws is already checked (`lib/cardDiagram.parseDiagram`); this
// only lays it out. Every string is drawn as text. It is a list to a screen
// reader, labelled with its titles in order, and the icons and arrows are
// decoration.
//
// While its block is still being written there is one quiet line in its
// place (`DiagramPending`), over the rows that are whole so far, drawn unseen:
// they hold the height, so nothing below moves when the block resolves.
import type { ReactNode } from "react";
import { diagramLabel, type Diagram, type DiagramIcon, type DiagramNode } from "../lib/cardDiagram";
import "./CardDiagram.css";

export function CardDiagram({ diagram }: { diagram: Diagram }) {
  return (
    <div className="dgm" role="list" aria-label={diagramLabel(diagram)}>
      {diagram.rows.map((row, at) => (
        <div className="dgm-row" role="listitem" key={at}>
          {at > 0 && (
            <span className="dgm-arrow" aria-hidden="true">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                <path d="M12 5v14" />
                <path d="m6 13 6 6 6-6" />
              </svg>
            </span>
          )}
          <div className="dgm-nodes">
            {row.map((node, n) => (
              <div className={node.plain ? "dgm-node is-plain" : "dgm-node"} key={n}>
                {node.icon && <span className="dgm-icon" aria-hidden="true"><Icon name={node.icon} /></span>}
                <span className="dgm-title">{node.title}</span>
                {node.note && <span className="dgm-note">{node.note}</span>}
              </div>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}

/** A diagram still being written: one line, and the height of the rows that
 *  are whole so far. */
export function DiagramPending({ rows }: { rows: DiagramNode[][] | null }) {
  return (
    <div className="dgm-pending" role="status">
      <span className="dgm-wait">Drawing a diagram…</span>
      {rows && rows.length > 0 && (
        <div className="dgm-ghost" aria-hidden="true">
          <CardDiagram diagram={{ rows }} />
        </div>
      )}
    </div>
  );
}

/* ---- The icons ------------------------------------------------------------
   A fixed set, by name: an agent names one, it never sends a drawing. */

const PATHS: Record<DiagramIcon, ReactNode> = {
  moon: <path d="M20.5 13.2A8.5 8.5 0 1 1 10.8 3.5a6.6 6.6 0 0 0 9.7 9.7z" />,
  coffee: <><path d="M17 9h1.2a3.3 3.3 0 0 1 0 6.6H17" /><path d="M4 9h13v7a4 4 0 0 1-4 4H8a4 4 0 0 1-4-4z" /><path d="M7.5 3v2.5M10.5 3v2.5M13.5 3v2.5" /></>,
  screen: <><rect x="3" y="4" width="18" height="12" rx="2" /><path d="M8.5 20h7M12 16v4" /></>,
  user: <><circle cx="12" cy="8" r="3.6" /><path d="M4.5 20.5a7.5 7.5 0 0 1 15 0" /></>,
  users: <><circle cx="9" cy="8" r="3.4" /><path d="M2.5 20.5a6.5 6.5 0 0 1 13 0" /><path d="M15.5 4.8a3.4 3.4 0 0 1 0 6.4M21.5 20.5a6.5 6.5 0 0 0-4.5-6.2" /></>,
  server: <><rect x="3" y="4" width="18" height="7" rx="2" /><rect x="3" y="13" width="18" height="7" rx="2" /><path d="M7 7.5h.01M7 16.5h.01" /></>,
  database: <><ellipse cx="12" cy="5.5" rx="8" ry="2.8" /><path d="M4 5.5v13c0 1.5 3.6 2.8 8 2.8s8-1.3 8-2.8v-13" /><path d="M4 12c0 1.5 3.6 2.8 8 2.8s8-1.3 8-2.8" /></>,
  file: <><path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z" /><path d="M14 3v5h5" /></>,
  folder: <path d="M4 20h16a2 2 0 0 0 2-2V8.5a2 2 0 0 0-2-2h-7.6a2 2 0 0 1-1.6-.8l-.9-1.4a2 2 0 0 0-1.6-.8H4a2 2 0 0 0-2 2V18a2 2 0 0 0 2 2z" />,
  code: <path d="m16 18 6-6-6-6M8 6l-6 6 6 6" />,
  terminal: <path d="m4 17 6-5-6-5M12.5 18.5H20" />,
  branch: <><path d="M6 3.5V15" /><circle cx="18" cy="6.5" r="2.8" /><circle cx="6" cy="18" r="2.8" /><path d="M18 9.3A8.7 8.7 0 0 1 8.8 18" /></>,
  check: <path d="M20 6.5 9.5 17l-5-5" />,
  cross: <path d="M18 6 6 18M6 6l12 12" />,
  alert: <><path d="M21.5 18 13.7 4.5a2 2 0 0 0-3.4 0L2.5 18a2 2 0 0 0 1.7 3h15.6a2 2 0 0 0 1.7-3z" /><path d="M12 9.5v4M12 17h.01" /></>,
  clock: <><circle cx="12" cy="12" r="8.5" /><path d="M12 7.5V12l3 2" /></>,
  lock: <><rect x="4.5" y="11" width="15" height="9.5" rx="2" /><path d="M8 11V7.5a4 4 0 0 1 8 0V11" /></>,
  key: <><circle cx="7.5" cy="15.5" r="4.2" /><path d="m10.6 12.4 9.4-9.4M16.5 6.5l3 3M13.5 9.5l2 2" /></>,
  globe: <><circle cx="12" cy="12" r="8.5" /><path d="M3.5 12h17M12 3.5c2.6 2.4 3.8 5.2 3.8 8.5s-1.2 6.1-3.8 8.5c-2.6-2.4-3.8-5.2-3.8-8.5s1.2-6.1 3.8-8.5z" /></>,
  cloud: <path d="M17.5 19h-9a6 6 0 1 1 5.7-8h3.3a4 4 0 1 1 0 8z" />,
  bolt: <path d="M13 2.5 4.5 14H11l-1 7.5L18.5 10H12z" />,
  search: <><circle cx="11" cy="11" r="6.5" /><path d="m20.5 20.5-4.8-4.8" /></>,
  message: <path d="M20.5 15a2 2 0 0 1-2 2h-10l-5 4V5.5a2 2 0 0 1 2-2h13a2 2 0 0 1 2 2z" />,
  box: <><path d="m12 3 8.5 4.8v8.4L12 21l-8.5-4.8V7.8z" /><path d="m3.8 7.9 8.2 4.6 8.2-4.6M12 12.5V21" /></>,
};

function Icon({ name }: { name: DiagramIcon }) {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
      {PATHS[name]}
    </svg>
  );
}
