// What is actually filling the context, at a glance.
//
// `/context` answers with a total, a table of nine categories, and a table of
// ninety-eight MCP tools. Every number is true and none of it is scannable:
// the question was "what is eating my context", and the answer is forty rows
// you have to add up yourself.
//
// So the categories become one bar, and the per-tool table is summed BY SERVER
// — because the decision it informs is "which server do I turn off", and that
// is per server, not per tool. On one real report that turned ninety-eight
// rows into "workspace-prod: 20.2k across 45 tools", which is the sentence
// worth having.
//
// Free space is deliberately not a slice. It is the space left, not something
// consuming it, and colouring it in makes the bar read as far fuller than it is.
import { useState } from "react";
import { byServer, type ContextReport as Report } from "../lib/contextReport";
import { RollingText } from "./RollingNumber";

/** Enough colours for the categories a report actually has. Ordered so the
 *  large, boring ones (prompt, tools) sit at the cool end and the ones you can
 *  do something about stand out. */
const COLOURS = [
  "#0a84ff",
  "#5e5ce6",
  "#bf5af2",
  "#ff375f",
  "#ff9f0a",
  "#ffd426",
  "#30d158",
  "#64d2ff",
  "#8e8e93",
];

function short(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1000) return `${(n / 1000).toFixed(n >= 10_000 ? 0 : 1)}k`;
  return String(n);
}

export function ContextReport({ report }: { report: Report }) {
  const [showServers, setShowServers] = useState(false);

  // Free space is the remainder, not a consumer.
  const used = report.categories.filter((c) => !/^free/i.test(c.label));
  const usedTotal = used.reduce((sum, c) => sum + c.tokens, 0) || 1;
  const servers = byServer(report);

  return (
    <div className="ctxr">
      <div className="ctxr-head">
        <span className="ctxr-total">
          <RollingText>
            {report.usedTokens !== undefined && report.totalTokens !== undefined
              ? `${short(report.usedTokens)} of ${short(report.totalTokens)}`
              : "Context"}
          </RollingText>
        </span>
        {report.usedPercent !== undefined && (
          <span className="ctxr-pct">
            <RollingText>{`${report.usedPercent}% full`}</RollingText>
          </span>
        )}
        {report.model && <span className="ctxr-model">{report.model}</span>}
      </div>

      {/* One bar, proportional to what is USED — so a nearly empty window does
          not draw a nearly full bar. */}
      <div className="ctxr-bar" role="img" aria-label="What is using the context">
        {used.map((slice, i) => (
          <span
            key={slice.label}
            className="ctxr-seg"
            style={{
              width: `${(slice.tokens / usedTotal) * 100}%`,
              background: COLOURS[i % COLOURS.length],
            }}
            title={`${slice.label}: ${short(slice.tokens)}`}
          />
        ))}
      </div>

      <ul className="ctxr-legend">
        {used.map((slice, i) => (
          <li key={slice.label}>
            <span className="ctxr-dot" style={{ background: COLOURS[i % COLOURS.length] }} />
            <span className="ctxr-label">{slice.label}</span>
            <span className="ctxr-tokens">
              <RollingText>{short(slice.tokens)}</RollingText>
            </span>
            <span className="ctxr-share">
              <RollingText>{`${Math.round((slice.tokens / usedTotal) * 100)}%`}</RollingText>
            </span>
          </li>
        ))}
      </ul>

      {servers.length > 0 && (
        <div className="ctxr-servers">
          <button className="ctxr-more" type="button" onClick={() => setShowServers((v) => !v)}>
            <RollingText>{`${showServers ? "Hide" : "Show"} MCP servers · ${report.tools.length} tools`}</RollingText>
          </button>
          {showServers && (
            <ul className="ctxr-legend">
              {servers.map((s) => (
                <li key={s.server}>
                  <span className="ctxr-label">{s.server}</span>
                  <span className="ctxr-tokens">
                    <RollingText>{short(s.tokens)}</RollingText>
                  </span>
                  <span className="ctxr-share">
                    <RollingText>{`${s.count} tools`}</RollingText>
                  </span>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}
