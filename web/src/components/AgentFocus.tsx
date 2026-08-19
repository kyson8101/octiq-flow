// One agent, read on its own.
//
// The rail lists what is running; this is what you get when you click a row.
// It is the browser equivalent of pressing `down` in the terminal to step into
// an agent — with several long runs going at once, reading them where they sit
// means scrolling past two to follow one.
//
// The two kinds of agent are not the same thing to show, and the difference is
// not cosmetic:
//
//   local_agent     a Task subagent. Its messages are on this stream, carrying
//                   `parent_tool_use_id`, so there is a real transcript.
//   local_workflow  a whole workflow. Its agents run in their own processes and
//                   send NO transcript — only the progress tree and a result
//                   preview. The full answer is a FILE the run wrote at the end.
//
// A Task subagent's transcript is not guaranteed either: one captured run sent
// none at all. Both kinds therefore need an honest empty state rather than a
// blank panel.
import { useEffect, useState } from "react";
import { bridge } from "../lib/bridge";
import type { AgentRun, Message } from "../lib/chat";
import { AgentTranscript } from "./MessageList";

import "./AgentFocus.css";

type Preview = { kind: string; content: string; truncated: boolean; size: number };

/** The run's saved output, read from disk on demand.
 *
 *  A workflow agent's whole answer only exists in this file, and it can be big,
 *  so it is fetched when the panel opens rather than held in the conversation. */
function useOutputFile(path: string | undefined): {
  text?: string;
  truncated?: boolean;
  error?: string;
  loading: boolean;
} {
  const [state, setState] = useState<{
    text?: string;
    truncated?: boolean;
    error?: string;
    loading: boolean;
  }>({ loading: false });

  useEffect(() => {
    if (!path) {
      setState({ loading: false });
      return;
    }
    let live = true;
    setState({ loading: true });
    bridge
      .invoke<Preview>("read_file_preview", { path })
      .then((res) => {
        if (!live) return;
        // A run's output is text. Anything else means the path is not what we
        // think it is, and showing bytes would help nobody.
        if (res.kind !== "text") {
          setState({ loading: false, error: `the run's output is ${res.kind}, not text` });
          return;
        }
        setState({ loading: false, text: res.content, truncated: res.truncated });
      })
      .catch((e: unknown) => {
        if (!live) return;
        setState({ loading: false, error: e instanceof Error ? e.message : String(e) });
      });
    return () => {
      live = false;
    };
  }, [path]);

  return state;
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="focus-stat">
      <span className="focus-stat-label">{label}</span>
      <span className="focus-stat-value">{value}</span>
    </div>
  );
}

/** What a workflow run can show: its script's own agents, and the file it
 *  wrote. There is no transcript to show, and pretending otherwise with an
 *  empty panel would read as a bug. */
function WorkflowBody({ run }: { run: AgentRun }) {
  const out = useOutputFile(run.outputFile);
  const workers = run.workers ?? [];

  return (
    <>
      <p className="focus-note">
        A workflow's agents run in their own processes, so their working is not
        on this conversation's stream. What they reported is below.
      </p>

      {workers.length > 0 && (
        <ul className="focus-workers">
          {workers.map((w) => (
            <li key={w.id} className={`focus-worker ${w.state === "done" ? "is-done" : "is-running"}`}>
              <div className="focus-worker-head">
                <span className="focus-worker-label">{w.label || `agent ${w.index}`}</span>
                {w.tokens !== undefined && (
                  <span className="focus-worker-cost">{w.tokens.toLocaleString()} tok</span>
                )}
              </div>
              {w.resultPreview && <div className="focus-worker-result">{w.resultPreview}</div>}
            </li>
          ))}
        </ul>
      )}

      <h4 className="focus-heading">Result</h4>
      {out.loading && <div className="focus-muted">reading the run's output…</div>}
      {out.error && <div className="focus-muted">could not read the output file — {out.error}</div>}
      {out.text !== undefined && (
        <>
          <pre className="focus-output">{out.text}</pre>
          {out.truncated && <div className="focus-muted">…output truncated</div>}
        </>
      )}
      {!run.outputFile && !out.loading && (
        <div className="focus-muted">
          {run.summary ?? "this run wrote no output file"}
        </div>
      )}
    </>
  );
}

/** A Task subagent: a real transcript, when it sent one. */
function SubagentBody({ run, messages }: { run: AgentRun; messages: Message[] }) {
  const transcript = run.toolUseId ? (
    <AgentTranscript messages={messages} parent={run.toolUseId} />
  ) : null;

  if (transcript) return transcript;

  // It ran, but its working never reached this stream. Say that, rather than
  // showing an empty box that looks broken.
  return (
    <div className="focus-muted">
      {run.status === "running"
        ? "this agent has not written anything yet"
        : "this agent sent no transcript — only its result came back"}
      {run.summary && <pre className="focus-output">{run.summary}</pre>}
    </div>
  );
}

export function AgentFocus({
  run,
  messages,
  onBack,
}: {
  run: AgentRun;
  messages: Message[];
  onBack: () => void;
}) {
  const stats = [
    run.detail ? { label: "kind", value: run.detail } : undefined,
    run.tokens !== undefined ? { label: "tokens", value: run.tokens.toLocaleString() } : undefined,
    run.toolCalls !== undefined ? { label: "tools", value: `${run.toolCalls}` } : undefined,
    run.durationMs !== undefined
      ? { label: "took", value: `${(run.durationMs / 1000).toFixed(1)}s` }
      : undefined,
  ].filter((s): s is { label: string; value: string } => !!s);

  return (
    <div className="focus">
      <div className="focus-bar">
        <button className="focus-back" onClick={onBack} type="button">
          ← conversation
        </button>
        <span className={`focus-status is-${run.status}`}>{run.status}</span>
      </div>

      <div className="focus-scroll">
        <h3 className="focus-title">{run.label}</h3>
        {stats.length > 0 && (
          <div className="focus-stats">
            {stats.map((s) => (
              <Stat key={s.label} label={s.label} value={s.value} />
            ))}
          </div>
        )}

        {run.kind === "local_workflow" ? (
          <WorkflowBody run={run} />
        ) : (
          <SubagentBody run={run} messages={messages} />
        )}
      </div>
    </div>
  );
}
