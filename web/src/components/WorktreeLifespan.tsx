import { useCallback, useEffect, useRef, useState, type MouseEvent } from "react";
import { bridge } from "../lib/bridge";
import { diskBytes } from "../lib/diskReport";
import { once, useInFlight } from "../lib/inFlight";
import { dropHeld, notePress, repeatsAnother } from "../lib/pressGuard";
import { archiveQuestion, DEFAULT_LIFESPAN_SETTINGS, groupWorktrees, idleWords, lifespanDate, lifespanUnavailable, sweepWords, validateLifespanSettings, worktreeFact, worktreeFlight, worktreeStakes, worktreeTotal, type LifespanItem, type LifespanSettings, type WorktreeArchive, type WorktreeLifespan, type WorktreeSweep } from "../lib/worktreeLifespan";
import { FoldBody, FoldLine, useFold } from "./CardFold";
import { useConfirm } from "./Confirm";
import "./WorktreeLifespan.css";

const words = (reason: unknown) => String((reason as Error)?.message ?? reason);
type Action = (key: string, command: string, args: Record<string, unknown>, question?: LifespanItem) => Promise<void>;

/** Events and reconnects only. Lifespan belongs to the host, never a page timer. */
export function WorktreeLifespanSection({ connected }: { connected: boolean }) {
  const [data, setData] = useState<WorktreeLifespan | null>(null);
  const [unavailable, setUnavailable] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [restored, setRestored] = useState<Record<string, { path: string; branch: string | null }>>({});
  const alive = useRef(false), revision = useRef(0);
  const confirm = useConfirm();
  const reload = useCallback(async () => {
    const rev = ++revision.current;
    try {
      const next = await bridge.invoke<WorktreeLifespan>("worktree_lifespan_list", {});
      if (!alive.current || rev !== revision.current) return;
      setData(next); setUnavailable(false); setLoadError(null);
    } catch (reason) {
      if (!alive.current || rev !== revision.current) return;
      const message = words(reason);
      setUnavailable(lifespanUnavailable(message));
      if (lifespanUnavailable(message)) setData(null);
      setLoadError(lifespanUnavailable(message) ? null : message);
    }
  }, []);
  useEffect(() => {
    alive.current = true;
    if (!connected) return () => { alive.current = false; ++revision.current; };
    const offSweep = bridge.on("worktree-swept", () => void reload());
    const offChange = bridge.on("worktree-lifespan-changed", () => void reload());
    void reload();
    return () => { alive.current = false; ++revision.current; offSweep(); offChange(); };
  }, [connected, reload]);
  const action: Action = async (key, command, args, question) => {
    if (!connected) return;
    await once(worktreeFlight(key), async () => {
      if (question && !await confirm(archiveQuestion(question))) return;
      if (alive.current) setErrors(was => { const next = { ...was }; delete next[key]; return next; });
      try {
        const result = await bridge.invoke<{ path: string; branch: string | null }>(command, args);
        if (command === "worktree_lifespan_restore" && alive.current) setRestored(was => ({ ...was, [key]: result }));
      } catch (reason) {
        if (alive.current) setErrors(was => ({ ...was, [key]: words(reason) }));
      } finally { await reload(); }
    });
  };
  const total = data ? worktreeTotal(data.items) : null;
  const latest = data?.history.reduce<WorktreeSweep | null>((last, sweep) => !last || sweep.at > last.at ? sweep : last, null);
  return <section className="worktree-lifespan" aria-label="Worktrees">
    <div className="wt-head"><h2>Worktrees{data ? ` · ${data.items.length}` : ""}{total !== null && ` · ${diskBytes(total)}`}</h2>
      {data?.scanning && <span role="status">Scanning worktrees…</span>}
    </div>
    {unavailable ? <p className="wt-quiet">Worktree lifespan is not available on this backend.</p> : <>
      {!connected && <p className="wt-quiet">Connect to the host to review worktrees.</p>}
      {loadError && <p className="wt-error" role="alert">{loadError}</p>}
      {!data && connected && !loadError && <p className="wt-quiet">Reading worktrees…</p>}
      {data && <>
        <p className="wt-quiet">{latest ? sweepWords(latest, true) : data.lastSweepAt !== null ? `Last sweep ${lifespanDate(data.lastSweepAt)}` : "No sweep yet"}</p>
        <LifespanSettingsRow settings={data.settings} connected={connected} error={errors.settings} action={action} />
        {groupWorktrees(data.items).map(group => <section className={`wt-group${group.label === "Needs you" ? " wt-needs" : ""}`} aria-label={group.label} key={group.label}>
          <h3>{group.label} · {group.items.length}</h3>
          {group.items.map(item => <WorktreeRow key={item.key} item={item} enabled={data.settings.enabled} connected={connected} error={errors[item.key]} action={action} />)}
        </section>)}
        {!!data.archives.length && <section className="wt-group" aria-label="Archived"><h3>Archived · {data.archives.length}</h3>{data.archives.map(archive => <ArchiveRow key={archive.key} archive={archive} restored={restored[archive.key]} connected={connected} error={errors[archive.key]} action={action} />)}</section>}
        {!data.items.length && !data.archives.length && <p className="wt-quiet">No managed worktrees.</p>}
        {!!data.history.length && <SweepHistory history={data.history} />}
      </>}
    </>}
  </section>;
}

function ActionButton({ flightKey, connected, children, onClick, leading = false }: { flightKey: string; connected: boolean; children: React.ReactNode; onClick: () => void; leading?: boolean }) {
  const pending = useInFlight(worktreeFlight(flightKey));
  return <button type="button" className={`wt-button${leading ? " wt-answer" : ""}`} disabled={!connected || pending} onKeyDown={dropHeld} onClick={event => { if (repeatsAnother(event)) return; notePress(event); onClick(); }}>{children}</button>;
}
function WorktreeRow({ item, enabled, connected, error, action }: { item: LifespanItem; enabled: boolean; connected: boolean; error?: string; action: Action }) {
  const fold = useFold(item.key);
  const known = item.owner.kind !== "unknown";
  const needs = known && !item.pinned && item.state === "abandoned";
  return <article className={`wt-row${needs ? " wt-needs-row" : ""}`} aria-label={item.owner.label}>
    <div className="wt-row-head"><strong>{item.owner.label}</strong>{item.bytes !== null && <span>{diskBytes(item.bytes)}</span>}</div>
    <p>{item.repo}{item.branch !== null && ` · ${item.branch}`} · {idleWords(item.idleDays)}</p>
    <p className="wt-fact">{worktreeFact(item, enabled)}</p>
    {needs && worktreeStakes(item) && <p>{worktreeStakes(item)}</p>}
    <FoldLine fold={fold} labels={["Path and details"]} what={`details for ${item.owner.label}`} />
    <FoldBody fold={fold}><code className="wt-path">{item.path}</code><p>{item.why}</p>
      {item.unmergedCommits > 0 && <p>{item.unmergedCommits} {item.unmergedCommits === 1 ? "commit" : "commits"} not merged</p>}
      {item.pushed !== null && <p>{item.pushed ? "Pushed" : "Not pushed"}</p>}
      {item.buildBytes !== null && <p>Build output · {diskBytes(item.buildBytes)}</p>}
    </FoldBody>
    {known && (item.pinned || item.state !== "active") && <div className="wt-actions"><ActionButton flightKey={item.key} connected={connected} leading={needs} onClick={() => void action(item.key, "worktree_lifespan_keep", { key: item.key, keep: !item.pinned })}>{item.pinned ? "Stop keeping" : "Keep"}</ActionButton>
      {needs && <ActionButton flightKey={item.key} connected={connected} onClick={() => void action(item.key, "worktree_lifespan_archive", { key: item.key, expectedHead: item.head, expectedStatusHash: item.statusHash }, item)}>Archive and remove</ActionButton>}
    </div>}
    {error && <p className="wt-error" role="alert">{error}</p>}
  </article>;
}
function ArchiveRow({ archive, restored, connected, error, action }: { archive: WorktreeArchive; restored?: { path: string; branch: string | null }; connected: boolean; error?: string; action: Action }) {
  const fold = useFold(archive.key);
  return <article className="wt-row" aria-label={`Archive ${archive.branch ?? archive.ref}`}>
    <strong>{archive.repo}{archive.branch !== null && ` · ${archive.branch}`}</strong><p>Archived {lifespanDate(archive.archivedAt)}{archive.files > 0 && ` · ${archive.files} ${archive.files === 1 ? "file" : "files"}`}</p>
    <FoldLine fold={fold} labels={["Archive and original path"]} what={`archive details for ${archive.branch ?? archive.ref}`} />
    <FoldBody fold={fold}><code className="wt-path">{archive.path}</code><code className="wt-path">{archive.ref}</code></FoldBody>
    {restored ? <p role="status">Restored <code>{restored.path}</code>{restored.branch !== null && ` · ${restored.branch}`}</p> : archive.restoredAt !== null ? <p>Restored {lifespanDate(archive.restoredAt)}</p> : <ActionButton flightKey={archive.key} connected={connected} onClick={() => void action(archive.key, "worktree_lifespan_restore", { key: archive.key })}>Restore</ActionButton>}
    {error && <p className="wt-error" role="alert">{error}</p>}
  </article>;
}
function LifespanSettingsRow({ settings = DEFAULT_LIFESPAN_SETTINGS, connected, error, action }: { settings?: LifespanSettings; connected: boolean; error?: string; action: Action }) {
  const [draft, setDraft] = useState({ enabled: settings.enabled, build: String(settings.buildAfterDays), remove: String(settings.removeAfterDays) });
  useEffect(() => setDraft({ enabled: settings.enabled, build: String(settings.buildAfterDays), remove: String(settings.removeAfterDays) }), [settings.enabled, settings.buildAfterDays, settings.removeAfterDays]);
  const invalid = validateLifespanSettings(draft.build, draft.remove);
  const changed = draft.enabled !== settings.enabled || Number(draft.build) !== settings.buildAfterDays || Number(draft.remove) !== settings.removeAfterDays;
  const pending = useInFlight(worktreeFlight("settings"));
  const guard = (event: MouseEvent) => { if (repeatsAnother(event)) { event.preventDefault(); return false; } notePress(event); return true; };
  return <form className="wt-settings" aria-label="Worktree lifespan settings" onSubmit={event => { event.preventDefault(); if (!invalid && changed && connected) void action("settings", "worktree_lifespan_set", { enabled: draft.enabled, buildAfterDays: Number(draft.build), removeAfterDays: Number(draft.remove) }); }}>
    <label><input type="checkbox" role="switch" checked={draft.enabled} disabled={!connected || pending} onKeyDown={dropHeld} onClick={guard} onChange={event => setDraft(was => ({ ...was, enabled: event.target.checked }))} />Automatic clearing {draft.enabled ? "on" : "off"}</label>
    <label>Build output after <input aria-label="Build output idle days" type="number" min="1" step="1" value={draft.build} disabled={!connected || pending} onChange={event => setDraft(was => ({ ...was, build: event.target.value }))} /> idle days</label>
    <label>Folders after <input aria-label="Folder idle days" type="number" min="1" step="1" value={draft.remove} disabled={!connected || pending} onChange={event => setDraft(was => ({ ...was, remove: event.target.value }))} /> idle days</label>
    <button className="wt-button" type="submit" disabled={!connected || pending || !changed || !!invalid} onKeyDown={dropHeld} onClick={event => { guard(event); }}>Save settings</button>
    {invalid && <p className="wt-validation" role="status">{invalid}</p>}{error && <p className="wt-error" role="alert">{error}</p>}
  </form>;
}
function SweepHistory({ history }: { history: WorktreeSweep[] }) {
  const fold = useFold("worktree-sweep-history");
  return <div className="wt-history"><FoldLine fold={fold} labels={[`Past sweeps · ${history.length}`]} what="past sweeps" />
    <FoldBody fold={fold}>{[...history].sort((a, b) => b.at - a.at).map((sweep, index) => <div className="wt-sweep" key={`${sweep.at}:${index}`}><strong>{lifespanDate(sweep.at)}</strong><p>{sweepWords(sweep)}</p>
      {sweep.removed.map((removed, i) => <p key={i}><code className="wt-path">{removed.path}</code>{removed.owner.label}{removed.branch !== null && ` · ${removed.branch}`}{removed.bytes !== null && ` · ${diskBytes(removed.bytes)}`}</p>)}
      {sweep.failed.map((failure, i) => <p className="wt-error" key={i}><code className="wt-path">{failure.path}</code>{failure.why}</p>)}
    </div>)}</FoldBody>
  </div>;
}
