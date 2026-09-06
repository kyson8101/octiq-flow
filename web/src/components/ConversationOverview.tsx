import { useEffect, useMemo, useRef, useState } from "react";
import type { ChatState } from "../lib/chat";
import { deriveTaskEvidence, type TaskStatus } from "../lib/taskEvidence";
import type { WorkspacePeer } from "../lib/workspaceContext";
import { bridge } from "../lib/bridge";
import { useOpenFile } from "./OpenFileContext";
import { TaskStatusCard } from "./TaskStatusCard";
import { DeliveryCard } from "./DeliveryCard";
import { WorkspaceContext } from "./WorkspaceContext";
import "./ConversationOverview.css";

const statusLabel: Record<TaskStatus, string> = {
  empty: "No task", waiting: "Waiting", running: "Working", blocked: "Needs you",
  settled: "Turn finished", stopping: "Stopping", stopped: "Stopped",
  interrupted: "Interrupted", failed: "Failed", unknown: "Status unconfirmed",
};

/** One bounded disclosure keeps the task reachable without displacing the
 * transcript or the composer on a phone. Evidence remains derived from events. */
export function ConversationOverview({
  chatId, chat, fallbackPath, connected, liveKnown, interrupted, blocker, peers, onOpenGit,
}: {
  chatId: string;
  chat: ChatState;
  fallbackPath?: string;
  connected: boolean;
  liveKnown: boolean;
  interrupted: boolean;
  blocker?: string;
  peers: WorkspacePeer[];
  onOpenGit: () => void;
}) {
  const evidence = useMemo(() => deriveTaskEvidence(chat, {
    blocker, interrupted, connected, liveKnown,
  }), [chat, blocker, interrupted, connected, liveKnown]);
  const openFile = useOpenFile();
  const [fileError, setFileError] = useState<string>();
  const cwd = chat.cwd || fallbackPath || "";
  const fileRequest = useRef(0);
  useEffect(() => {
    fileRequest.current++;
    setFileError(undefined);
    return () => { fileRequest.current++; };
  }, [cwd]);

  const openRecordedFile = async (path: string) => {
    const request = ++fileRequest.current;
    setFileError(undefined);
    try {
      const resolved = await bridge.invoke<(string | null)[]>("resolve_paths", { paths: [path], cwd });
      if (request !== fileRequest.current) return;
      if (resolved?.[0]) openFile(resolved[0]);
      else setFileError(`File is no longer available: ${path}`);
    } catch {
      if (request !== fileRequest.current) return;
      setFileError("Could not open this file. Check the connection and try again.");
    }
  };

  if (!evidence.objective && !chat.cwd && !fallbackPath) return null;
  return (
    <details className="conversation-overview">
      <summary>
        <span className="conversation-overview-label">Task &amp; review</span>
        <span className="conversation-overview-objective" title={evidence.objective}>
          {evidence.step || evidence.objective || "Workspace details"}
        </span>
        <span className={`conversation-overview-status is-${evidence.status}`}>{statusLabel[evidence.status]}</span>
      </summary>
      <div className="conversation-overview-body">
        <TaskStatusCard evidence={evidence} />
        <WorkspaceContext chatId={chatId} cwd={chat.cwd} fallbackPath={fallbackPath}
          connected={connected && liveKnown} peers={peers} />
        <DeliveryCard evidence={evidence} onOpenFile={(path) => void openRecordedFile(path)} onOpenGit={onOpenGit} />
        {fileError && <p className="conversation-overview-error" role="alert">{fileError}</p>}
      </div>
    </details>
  );
}
