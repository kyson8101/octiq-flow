// The new-run form (moved verbatim from OrchestrationPanel.tsx).
import type { ProjectRef } from "./OrchestrationPanel";
import { type ReactNode } from "react";
import { WORKSPACE_MODES, type WorkspaceMode } from "../lib/orchestration";

function OrchestratorGlyph() {
  return <div className="orch-glyph" aria-hidden="true"><span /><span /><span /><i /><i /></div>;
}

export function NewRun({
  project,
  hasCoordinator,
  setupContext,
  objective,
  maxConcurrent,
  workspaceMode, onWorkspaceMode, automatic, onAutomatic,
  busy,
  onObjective,
  onConcurrency,
  onStart,
}: {
  project: ProjectRef | null;
  hasCoordinator: boolean;
  setupContext?: ReactNode;
  objective: string;
  maxConcurrent: number;
  workspaceMode: WorkspaceMode;
  onWorkspaceMode: (mode: WorkspaceMode) => void;
  automatic: boolean;
  onAutomatic: (automatic: boolean) => void;
  busy: boolean;
  onObjective: (value: string) => void;
  onConcurrency: (value: number) => void;
  onStart: () => void;
}) {
  const ready = !!project && hasCoordinator && !!objective.trim() && !busy;
  return (
    <section className="orch-start" aria-labelledby="orch-start-title">
      <div className="orch-start-intro">
        <OrchestratorGlyph />
        <div>
          <h2 id="orch-start-title">Give one agent the whole outcome.</h2>
          <p>The main agent plans the tasks. OctiqFlow prepares their workspaces and keeps progress through execution, review, and cleanup.</p>
        </div>
      </div>
      <fieldset className="orch-setup-context" disabled={busy}>{setupContext}</fieldset>
      <label className="orch-field">
        <span>Outcome</span>
        <textarea
          value={objective}
          disabled={busy}
          rows={6}
          autoFocus
          placeholder="Ship the feature, including tests and a review-ready branch…"
          onChange={(event) => onObjective(event.target.value)}
        />
      </label>
      <fieldset className="orch-workspace-modes">
        <legend>Workspace mode</legend>
        {WORKSPACE_MODES.map((mode) => <label key={mode.value} className={workspaceMode === mode.value ? "is-selected" : ""}>
          <input type="radio" name="workspace-mode" value={mode.value} checked={workspaceMode === mode.value}
            onChange={() => onWorkspaceMode(mode.value)} disabled={busy} />
          <span><strong>{mode.label}</strong><small>{mode.description}</small></span>
        </label>)}
      </fieldset>
      {workspaceMode === "direct" && <p className="orch-workspace-warning" role="note">
        This can modify the primary checkout and existing uncommitted work. Keep existing changes; this folder will never be removed by cleanup.
      </p>}
      <div className="orch-automation-options">
        <label><input type="checkbox" checked={automatic} disabled={busy} onChange={(event) => onAutomatic(event.target.checked)} /> Automatically start ready tasks</label>
      </div>
      <p>The main agent chooses a suitable worker and reasoning effort for each task. Astra is reserved for orchestration.</p>
      <div className="orch-start-row">
        <label className="orch-field orch-concurrency">
          <span>Worker limit</span>
          <select disabled={busy || workspaceMode === "direct"} value={workspaceMode === "direct" ? 1 : maxConcurrent} onChange={(event) => onConcurrency(Number(event.target.value))}>
            {[1, 2, 3, 4, 6, 8].map((value) => <option value={value} key={value}>{value}</option>)}
          </select>
        </label>
        <div className="orch-launch-copy">
          <strong>{project?.name ?? "Choose a project"}</strong>
          <span>{hasCoordinator ? "This chat becomes the master." : "Open a chat first; it becomes the master."}</span>
        </div>
        <button className="orch-primary" type="button" disabled={!ready} onClick={onStart}>
          {busy ? "Starting…" : "Start mission"}
        </button>
      </div>
    </section>
  );
}
