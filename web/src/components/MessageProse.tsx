// Markdown prose, fenced code and progress logs for the transcript (moved verbatim from MessageList.tsx).
import { useReadingState } from "../lib/useReadingState";
import { createContext, memo, useContext, useMemo, useRef, useState } from "react";
import type React from "react";
import Markdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import { CardDiagram, DiagramPending } from "./CardDiagram";
import { DIAGRAM_LANG, diagramBlock, parseDiagram } from "../lib/cardDiagram";
import { MEDIA_LANG, mediaBlock, parseMediaBlock } from "../lib/mediaBlock";
import { MediaPending, MediaReply } from "./MediaBesideText";
import { useTypewriter } from "../lib/typewriter";
import { closeFence, splitBlocks } from "../lib/blocks";
import { rehypeWordFade } from "../lib/wordfade";
import { ContextReport } from "./ContextReport";
import { parseContextReport } from "../lib/contextReport";
import { RunCommand } from "./RunCommand";
import { fencedCodeClosed, isShellFence, shellCommand } from "../lib/shellRun";
import { copyText } from "../lib/clipboard";
import { ProseLink } from "./ProseLink";
import { ProsePath } from "./ProsePath";
import { ProseTable } from "./ProseTable";
import { PATH_TAG, rehypeFilePaths } from "../lib/filepaths";
import { parseVisualizationReference, VisualizationLink } from "./Visualization";

/** Original source, before closeFence appends a synthetic closer. Each code
 * node's parser positions identify its own fence, including list/quote nesting. */
const FenceSource = createContext("");

/** A fenced code block, with Copy and an optional confirmed shell Run.
 *  react-markdown hands us the <code> child, whose className carries the fence
 *  language ("language-rust"). */
function CodeBlock({ children, node }: {
  children?: React.ReactNode;
  node?: { position?: { start: { offset?: number }; end: { offset?: number } } };
}) {
  const [copied, setCopied] = useState(false);
  const ref = useRef<HTMLPreElement>(null);
  const child = children as { props?: { className?: string; children?: unknown } } | undefined;
  const lang = /language-([\w-]+)/.exec(child?.props?.className ?? "")?.[1] ?? "";

  // A card diagram that is not a block of its own (inside a list, a quote):
  // `MarkdownBlock` never saw its fence, so it is read here. Anything that is
  // not a closed, whole, valid diagram stays the code block it also is.
  const source = useContext(FenceSource);
  const closed = typeof child?.props?.children === "string" &&
    fencedCodeClosed(source, child.props.children, node?.position?.start.offset, node?.position?.end.offset);
  if (closed && lang === DIAGRAM_LANG && typeof child?.props?.children === "string") {
    const diagram = parseDiagram(child.props.children);
    if (diagram) return <CardDiagram diagram={diagram} />;
  }
  if (closed && lang === MEDIA_LANG && typeof child?.props?.children === "string") {
    const media = parseMediaBlock(child.props.children);
    if (media) return <MediaReply media={media} />;
  }

  return (
    <div className="code">
      <div className="code-head">
        <span className="code-lang">{lang || "text"}</span>
        <div className="code-actions">
          {closed && isShellFence(lang) && typeof child?.props?.children === "string" &&
            <RunCommand command={shellCommand(lang, child.props.children)} />}
          <button
            className="code-copy"
            type="button"
            onClick={async () => {
              // Through the shared helper, which falls back to the old copy API
              // where `navigator.clipboard` does not exist — reaching this app
              // from a phone means a plain-http origin, and this button used to
              // do nothing at all there.
              if (await copyText(ref.current?.innerText ?? "")) {
                setCopied(true);
                setTimeout(() => setCopied(false), 1400);
              }
            }}
          >
            {copied ? "copied" : "copy"}
          </button>
        </div>
      </div>
      <pre ref={ref}>{children}</pre>
    </div>
  );
}

/** Prose that types itself out while it is still arriving.
 *
 *  Only the block currently being written animates. Anything already finished —
 *  every earlier message, and this one once it ends — renders whole, so
 *  scrolling back never replays the conversation. */
export function Prose({ text, animate }: { text: string; animate: boolean }) {
  const shown = useTypewriter(text, animate);

  // `/context` answers in a shape worth drawing rather than reading. Only once
  // it has finished arriving: a half-parsed table would redraw the chart on
  // every delta. Anything that does not parse falls through to the markdown it
  // already was — a wrong chart is worse than an honest table.
  const report = useMemo(
    () => (animate ? null : parseContextReport(text)),
    [text, animate],
  );
  if (report) return <ContextReport report={report} />;

  const caret = animate && shown.length < text.length;

  // Rendered a block at a time. Only the last one is still being written, so
  // everything above it is memoised and stops re-rendering — which is the
  // whole cost of a long streaming reply.
  const blocks = useMemo(() => splitBlocks(shown), [shown]);

  return (
    <div className={`prose ${caret ? "is-typing" : ""}`}>
      {blocks.map((block, i) => (
        <MarkdownBlock
          key={i}
          text={block}
          // Only the block currently arriving fades its words in; doing it to
          // settled blocks would replay the whole reply on every tick.
          animate={animate && i === blocks.length - 1}
          // Still being written: arriving, or arrived and not typed out yet.
          // A fence left open is then a block in progress, not a broken one.
          writing={(animate || shown.length < text.length) && i === blocks.length - 1}
        />
      ))}
    </div>
  );
}

/** Codex commentary is a live instrument readout, not the answer.
 *
 * The newest update is always open, and earlier ones are one disclosure away.
 * Someone coming back to a finished turn should not have to unfold anything
 * to see where the work last stood. While the turn runs, that update is the
 * live status. Once the turn is over it stays as a quiet card, with no pulse
 * and no live region, so the final prose still takes the foreground. */
export function ProgressLog({
  updates,
  candidate,
  streaming,
}: {
  updates: string[];
  candidate?: string;
  streaming: boolean;
}) {
  const [open, setOpen] = useReadingState<boolean>("progress", false);
  const all = [...updates, ...(candidate ? [candidate] : [])];
  if (!all.length) return null;

  const latest = all[all.length - 1];
  const earlier = all.slice(0, -1);
  const countLabel = `${earlier.length} earlier progress ${earlier.length === 1 ? "update" : "updates"}`;

  return (
    <div className={`agent-progress ${streaming ? "is-live" : "is-settled"}`}>
      {earlier.length > 0 && (
        <details className="agent-progress-log" open={open} onToggle={event => setOpen(event.currentTarget.open)}>
          <summary>
            <span>{countLabel}</span>
            <span className="agent-progress-order">Oldest first</span>
          </summary>
          <div
            className="agent-progress-items"
            role="region"
            aria-label="Progress history, oldest first"
            tabIndex={0}
          >
            <ol className="agent-progress-list">
              {earlier.map((update, index) => (
                <li className="agent-progress-item" key={`${index}:${update.slice(0, 24)}`}>
                  <Prose text={update} animate={false} />
                </li>
              ))}
            </ol>
          </div>
        </details>
      )}
      <div
        className="agent-progress-live"
        {...(streaming ? { role: "status", "aria-live": "polite" as const } : {})}
      >
        <span className="agent-progress-pulse" aria-hidden="true" />
        <div className="agent-progress-live-copy">
          <span className="agent-progress-live-label">Latest update</span>
          <Prose text={latest} animate={false} />
        </div>
      </div>
    </div>
  );
}

/** How far back the `/config` panel looks for the CLI's `Set … to …` answers.
 *
 *  Far enough to cover a run of settings changed one after another, short
 *  enough that the walk is nothing: it is redone on every streaming delta. */
export const CONFIRM_WINDOW = 40;

/** What the reply's markdown renders as. `PATH_TAG` is not an HTML element —
 *  it is the marker `rehypeFilePaths` leaves behind, and this is what turns it
 *  into something clickable. */
const PROSE_COMPONENTS = {
  pre: CodeBlock,
  table: ProseTable,
  a: ProseLink,
  [PATH_TAG]: ProsePath,
} as Components;

/** One top-level markdown block.
 *
 *  Memoised on its own text: a settled block's text never changes again, so
 *  React skips it entirely once the stream has moved past it. This is the
 *  difference between re-parsing the whole answer on every delta and
 *  re-parsing one paragraph. */
const MarkdownBlock = memo(function MarkdownBlock({
  text,
  animate,
  writing,
}: {
  text: string;
  animate: boolean;
  writing: boolean;
}) {
  const visualization = parseVisualizationReference(text);
  if (visualization) return <VisualizationLink reference={visualization} />;

  // A card diagram (`lib/cardDiagram`). Only a block that is closed, parses
  // and validates is drawn. While it is still being written it is one quiet
  // line holding the height of the rows written so far; anything else falls
  // through to the code block below.
  const drawn = diagramBlock(text, writing);
  if (drawn?.kind === "diagram") return <CardDiagram diagram={drawn.diagram} />;
  if (drawn) return <DiagramPending rows={drawn.rows} />;

  const media = mediaBlock(text, writing);
  if (media?.kind === "media") return <MediaReply media={media.media} />;
  if (media) return <MediaPending media={media.media} />;

  const whole = closeFence(text);
  return (
    <FenceSource.Provider value={text}>
      <Markdown
        remarkPlugins={[remarkGfm]}
        // Paths first: the word fade cuts text into one span per word, and a
        // path cut up that way is no longer there to find.
        rehypePlugins={animate ? [rehypeFilePaths, rehypeWordFade] : [rehypeFilePaths]}
        components={PROSE_COMPONENTS}
      >
        {whole}
      </Markdown>
    </FenceSource.Provider>
  );
});
