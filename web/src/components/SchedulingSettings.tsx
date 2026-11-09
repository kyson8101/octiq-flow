import { useState } from "react";
import { saveScheduling, useAgentLanes, type SchedulingSettings as Settings } from "../lib/agentLanes";
import "./SchedulingSettings.css";

export function SchedulingSettings() {
  const { data, error } = useAgentLanes();
  const [draft, setDraft] = useState<Settings | null>(null);
  const [busy, setBusy] = useState(false);
  const [refusal, setRefusal] = useState("");
  const [done, setDone] = useState(false);
  // Live counts never overwrite an edit. A successful save releases it.
  const settings = draft ?? data;
  const save = async () => {
    if (!settings || !data || busy) return;
    setBusy(true); setRefusal(""); setDone(false);
    try { await saveScheduling({ orientation: settings.orientation, hostCap: settings.hostCap }); setDraft(null); setDone(true); }
    catch (reason) { setRefusal(String((reason as Error).message ?? reason)); }
    finally { setBusy(false); }
  };
  return <SchedulingBlock settings={settings} unread={!data} loading={!data && !error} busy={busy}
    running={data?.live.total ?? null} error={error ?? refusal} done={done}
    changed={!!data && !!settings && (settings.orientation !== data.orientation || settings.hostCap !== data.hostCap)}
    onChange={value => { setDone(false); setRefusal(""); setDraft(value); }} onSave={() => void save()} />;
}

export function SchedulingBlock({ settings, unread, loading, busy, running, error, done, changed, onChange, onSave }: {
  settings: Settings | null; unread: boolean; loading: boolean; busy: boolean; running: number | null;
  error: string; done: boolean; changed: boolean; onChange: (value: Settings) => void; onSave: () => void;
}) {
  return <section className="scheduling-block" aria-labelledby="scheduling-title">
    <h3 id="scheduling-title">Scheduling</h3>
    {loading ? <p className="set-hint">Loading scheduling…</p> : unread ? <p className="set-hint">Scheduling could not be read.</p> : settings && <>
      <fieldset disabled={busy} className="scheduling-orientation"><legend>Orientation</legend>
        <div className="scheduling-segments">{(["tasks", "agents"] as const).map(value => <label key={value}>
          <input type="radio" name="orientation" checked={settings.orientation === value} onChange={() => onChange({ ...settings, orientation: value })} />
          <span>{value === "tasks" ? "Tasks" : "Agents"}</span>
        </label>)}</div>
        <p className="set-hint">{settings.orientation === "tasks" ? "Every task gets its own worker and worktree, up to each run's limit." : "Each agent works through its own queue one batch at a time, in one worktree per repository."}</p>
      </fieldset>
      <label className="scheduling-limit">Machine-wide limit<select aria-label="Machine-wide limit" value={settings.hostCap ?? "off"} disabled={busy}
        onChange={event => onChange({ ...settings, hostCap: event.target.value === "off" ? null : Number(event.target.value) })}>
        <option value="off">Off</option>{Array.from({ length: 32 }, (_, index) => <option key={index + 1} value={index + 1}>{index + 1}</option>)}
      </select></label>
      <p className="set-hint" aria-live="polite">{running ?? "—"} workers running now</p>
      <button className="settings-primary" type="button" disabled={busy || !changed} onClick={onSave}>{busy ? "Saving…" : "Save scheduling"}</button>
      {done && !error && <span role="status">Saved</span>}
    </>}
    {error && <details className="scheduling-refusal"><summary>{unread ? "Could not read scheduling" : "Not saved"}</summary><p>{error}</p></details>}
  </section>;
}
