import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { bridge } from "../lib/bridge";
import { diskBytes, diskDate, diskGroupLabel, diskSection, diskSelectable, diskSelection, toggleDiskSection, type DiskGroup, type DiskItem, type DiskProgress, type DiskReport } from "../lib/diskReport";
import { aggregateDiskMap, diskLabelFit, diskTreemap, type DiskLabelFit, type DiskMapTile, type Tile } from "../lib/diskTreemap";
import { useDiskReport } from "../lib/useDiskReport";
import { FoldBody, FoldLine, useFold } from "./CardFold";
import { WorkspaceHeader } from "./WorkspaceHeader";
import "./DiskPage.css";

export default function DiskPage({ connected, onClose }: { connected: boolean; onClose: () => void }) {
  const feed = useDiskReport(connected);
  return <DiskReportPage {...feed} connected={connected} onScan={() => void feed.scan()} onClose={onClose} />;
}

const EMPTY_ITEMS: DiskItem[] = [];
const EMPTY_SELECTION: ReadonlySet<string> = new Set();

/** The presentation also accepts a fixture without a live socket. */
export function DiskReportPage({ report, running = null, error, pending = false, loading = false, connected = true, onScan, onClose }: {
  report: DiskReport | null; running?: DiskProgress | null; error?: string | null; pending?: boolean; loading?: boolean; connected?: boolean;
  onScan: () => void; onClose: () => void;
}) {
  const [selection, setSelection] = useState<{ scanId: string; ids: ReadonlySet<string> }>({ scanId: "", ids: EMPTY_SELECTION });
  const [rmConsentScan, setRmConsentScan] = useState<string | null>(null);
  const allowRm = !!report && rmConsentScan === report.scanId;
  const [download, setDownload] = useState<{ scanId: string; fileName: string } | null>(null);
  const [downloadError, setDownloadError] = useState<string | null>(null);
  const [downloading, setDownloading] = useState(false);
  const activeReport = useRef(report?.scanId);
  activeReport.current = report?.scanId;
  const alive = useRef(true);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  useEffect(() => { setDownload(null); setDownloadError(null); }, [report?.scanId]);
  const rows = useRef(new Map<string, HTMLElement>());
  const items = report?.items ?? EMPTY_ITEMS;
  const selected = selection.scanId === report?.scanId ? selection.ids : EMPTY_SELECTION;
  const summary = diskSelection(items, selected, allowRm);
  const tick = (ids: ReadonlySet<string>) => { if (report) setSelection({ scanId: report.scanId, ids }); };
  const [found, setFound] = useState<{ scanId: string; ids: ReadonlySet<string>; label: string } | null>(null);
  const foundRows = found?.scanId === report?.scanId ? found : null;
  const focusItem = (tile: DiskMapTile) => {
    setFound({ scanId: report!.scanId, ids: new Set(tile.items.map(item => item.id)), label: tile.label });
    const row = rows.current.get(tile.items[0].id);
    row?.scrollIntoView({ block: "center", behavior: "instant" });
    row?.focus({ preventScroll: true });
  };
  const disabledReason = !connected ? "Connect to the host to download a script." : running ? "Wait for the scan to finish before downloading a script." : !summary.count ? "Select at least one item to download a script." : null;
  const getScript = async () => {
    if (!report || disabledReason || downloading) return;
    const scanId = report.scanId;
    setDownloading(true); setDownloadError(null);
    try {
      const result = await bridge.invoke<{ fileName?: unknown; script?: unknown }>("disk_cleanup_script", { scanId, itemIds: summary.ids, allowRm });
      if (!alive.current || activeReport.current !== scanId) return;
      if (typeof result?.script !== "string" || typeof result?.fileName !== "string" || !result.fileName) throw new Error("The host did not return a cleanup script.");
      const fileName = result.fileName.split(/[\\/]/).pop() || (report.platform === "windows" ? "disk-cleanup.ps1" : "disk-cleanup.sh");
      const url = URL.createObjectURL(new Blob([result.script], { type: "text/plain;charset=utf-8" }));
      const link = document.createElement("a");
      link.href = url; link.download = fileName; document.body.append(link); link.click(); link.remove();
      window.setTimeout(() => URL.revokeObjectURL(url), 1000);
      setDownload({ scanId, fileName });
    } catch (reason) { if (alive.current && activeReport.current === scanId) setDownloadError(String((reason as Error)?.message ?? reason)); }
    finally { if (alive.current) setDownloading(false); }
  };
  const fileName = download?.scanId === report?.scanId ? download?.fileName : report?.platform === "windows" ? "disk-cleanup.ps1" : "disk-cleanup.sh";
  return <section className="disk-page" aria-label="Disk report">
    <WorkspaceHeader root title={<h1>Disk</h1>} back={{ label: "Chat", onClick: onClose }} actions={
      <button className={`disk-button${running ? " is-scanning" : ""}`} type="button" disabled={!connected || pending || loading} onClick={onScan}>
        {pending ? (running ? "Cancelling…" : "Starting…") : running ? "Cancel scan" : "Scan"}
      </button>
    } />
    <div className="disk-body">
      <div className="disk-intro"><div><h2>Development leftovers</h2><p>Manual scans of your home folder and system temp. Metadata, Git and open-file checks only.</p></div>
        {report && <div className="disk-total"><strong>{diskBytes(report.totalBytes)}</strong><span>{report.platform === "macos" ? "macOS" : report.platform === "windows" ? "Windows" : report.platform === "linux" ? "Linux" : "Unknown platform"} · Last scanned {diskDate(report.scannedAt)}</span></div>}
      </div>
      <p className="disk-promise">OctiqFlow never deletes anything. You choose items, download a cleanup script and run it yourself.</p>
      {!connected && <p className="disk-message" role="status">Connect to the host to scan.</p>}
      {error && <p className="disk-error" role="alert">{error}</p>}
      {running && <div className="disk-progress" role="status"><span className="disk-progress-mark" aria-hidden="true" /><span>Scanning {phaseLabel(running.phase)} · {running.entries.toLocaleString("en-US")} entries · {diskBytes(running.bytes)} counted</span></div>}
      {loading && !report && <p className="disk-message">Reading the last report…</p>}
      {!report && !loading && <div className="disk-empty"><h2>No scan yet</h2><p>Scan when you want to review large development leftovers. Nothing is selected automatically.</p></div>}
      {report && <>
        <p className="disk-threshold">Items ≥ {diskBytes(report.thresholdBytes)} · Size history: <code>~/disk-report/sizes.csv</code>{report.previousScanAt ? ` · Compared with ${diskDate(report.previousScanAt)}` : " · First recorded scan"}</p>
        <div className="disk-layout">
          <div className="disk-map-column"><DiskMap items={items} selected={selected} onFocus={focusItem} />
            <p className="disk-map-help">Area represents size. Choose a cleanup tile to highlight its rows. Your work is labelled only.</p>
          </div>
          <div className="disk-list-column">
            {foundRows && <div className="disk-found" role="status">{foundRows.label} · {foundRows.ids.size} {foundRows.ids.size === 1 ? "row" : "rows"} highlighted <button type="button" onClick={() => setFound(null)}>Clear highlight</button></div>}
            {(["clean", "review"] as const).map(group => {
              const section = diskSection(items, group);
              const selectable = section.filter(diskSelectable);
              return <section className={`disk-section disk-${group}`} key={group} aria-label={diskGroupLabel[group]}>
                <div className="disk-section-heading"><h2>{diskGroupLabel[group]} <span>{section.length}</span></h2>
                  <label className="disk-tick-all"><input type="checkbox" checked={selectable.length > 0 && selectable.every(item => selected.has(item.id))} disabled={!selectable.length} onChange={() => tick(toggleDiskSection(selected, section))} />Select all<span className="sr-only"> {diskGroupLabel[group]}</span></label>
                </div>
                {!section.length && <p className="disk-message">No items in this section.</p>}
                {section.map(item => <DiskRow key={`${report.scanId}:${item.id}`} item={item} highlighted={foundRows?.ids.has(item.id)} previousScanAt={report.previousScanAt} checked={selected.has(item.id)} onTick={() => {
                  if (!diskSelectable(item)) return;
                  const next = new Set(selected); if (next.has(item.id)) next.delete(item.id); else next.add(item.id); tick(next);
                }} rowRef={el => { if (el) rows.current.set(item.id, el); else rows.current.delete(item.id); }} />)}
              </section>;
            })}
            <SkippedFolders report={report} />
            <section className="disk-controls" aria-label="Cleanup script">
              <label className="disk-rm-switch"><input type="checkbox" role="switch" checked={allowRm} onChange={event => setRmConsentScan(event.target.checked ? report.scanId : null)} /><span>Use rm -rf for items with no tool command</span></label>
              <p>{allowRm ? (report.platform === "windows" ? "The script can use PowerShell Remove-Item for these items." : "The script can use rm -rf for these items.") : "Items with no tool command are printed as Skipped."}</p>
              <div className="disk-download-row"><strong>{summary.count} selected · {diskBytes(summary.bytes)}</strong><button className="disk-button" type="button" disabled={!!disabledReason || downloading} aria-describedby="disk-download-reason" onClick={() => void getScript()}>{downloading ? "Preparing script…" : "Download cleanup script"}</button></div>
              {summary.skippedCount > 0 && <p>{summary.skippedCount} selected {summary.skippedCount === 1 ? "item will" : "items will"} be printed as Skipped.</p>}
              <p id="disk-download-reason">{disabledReason ?? "Review the script before running it."}</p>
              {downloadError && <p className="disk-error" role="alert">{downloadError}</p>}
              <p className="disk-run-example">Run it in your terminal, for example: <code>{report.platform === "windows" ? `powershell -File "$HOME\\Downloads\\${fileName}"` : `bash ~/Downloads/${fileName}`}</code></p>
            </section>
          </div>
        </div>
      </>}
    </div>
  </section>;
}

function phaseLabel(phase: string) { return ({ home: "home folder", temp: "system temp", git: "Git worktrees", history: "size history" } as Record<string, string>)[phase] ?? phase; }
function rectangle(tile: Tile, width: number, height: number): CSSProperties {
  return { left: `${tile.x / width * 100}%`, top: `${tile.y / height * 100}%`, width: `${tile.width / width * 100}%`, height: `${tile.height / height * 100}%` };
}

export function DiskMap({ items, selected, onFocus }: { items: DiskItem[]; selected: ReadonlySet<string>; onFocus: (tile: DiskMapTile) => void }) {
  const container = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(480);
  const [inspected, setInspected] = useState<string | null>(null);
  useEffect(() => {
    if (!container.current) return;
    const observer = new ResizeObserver(entries => { const size = entries[0]?.contentRect.width; if (size > 0) setWidth(size); });
    observer.observe(container.current);
    return () => observer.disconnect();
  }, []);
  const height = Math.max(340, Math.min(520, width * 1.1));
  const overview = useMemo(() => aggregateDiskMap(items, selected), [items, selected]);
  const groups = useMemo(() => (["clean", "review", "work"] as const).map(group => ({ id: group, bytes: overview.filter(tile => tile.group === group).reduce((sum, tile) => sum + tile.bytes, 0) })), [overview]);
  const regions = diskTreemap(groups, width, height);
  const inspecting = overview.find(tile => tile.id === inspected);
  return <section className="disk-map-panel" aria-label="Disk size treemap"><h2>Where the space goes</h2>
    <div className="disk-map-legend">{groups.map(group => <span className={`disk-${group.id}`} key={group.id}><i aria-hidden="true" />{diskGroupLabel[group.id]} · {diskBytes(group.bytes)}</span>)}</div>
    <div className="disk-map" ref={container} style={{ height }}>
      {!regions.length && <p className="disk-message">No large development leftovers found.</p>}
      {regions.map(region => {
        const group = region.id as DiskGroup;
        const members = overview.filter(tile => tile.group === group);
        const tiles = diskTreemap(members, region.width, region.height);
        const byId = new Map(members.map(tile => [tile.id, tile]));
        return <div className={`disk-map-region disk-${group}`} key={group} style={rectangle(region, width, height)} aria-label={diskGroupLabel[group]}>
          {tiles.map(tile => {
            const entry = byId.get(tile.id)!;
            const description = mapTileDescription(entry);
            const content = <DiskTileLabel entry={entry} />;
            const style = rectangle(tile, region.width, region.height);
            const title = `${description}\n${entry.items.length === 1 ? entry.items[0].path : `${entry.items.length} items in ${diskGroupLabel[group]}`}`;
            const inspect = {
              // Scrolling to a keyboard-focused tile can move another tile under
              // a stationary pointer. Keep the inspector on the focused tile.
              onMouseEnter: () => { if (!container.current?.contains(document.activeElement)) setInspected(entry.id); },
              onFocus: () => setInspected(entry.id),
            };
            return group === "work" ? <div className="disk-tile is-work" key={entry.id} style={style} title={title} aria-label={`${description}. Your work is labelled only.`} tabIndex={0} {...inspect}>{content}</div>
              : <button type="button" className={`disk-tile${entry.selectedCount ? " is-selected" : ""}`} key={entry.id} style={style} title={title} aria-label={`${description}. Find in ${diskGroupLabel[group]}`} onClick={() => onFocus(entry)} {...inspect}>{content}</button>;
          })}
        </div>;
      })}
    </div>
    {overview.some(tile => tile.selectedCount > 0) && <p className="disk-map-ticked" aria-live="polite">{overview.filter(tile => tile.selectedCount > 0).map(tile => `${tile.label} · ${tile.selectedCount} ticked`).join("; ")}</p>}
    <div className="disk-map-inspector" aria-live="polite">{inspecting ? <><strong>{mapTileDescription(inspecting)}</strong><code>{inspecting.items.length === 1 ? inspecting.items[0].path : `${inspecting.items.length} items in ${diskGroupLabel[inspecting.group]}${inspecting.group === "work" ? " · Your work is labelled only." : " · Choose to highlight their rows."}`}</code></> : "Hover or focus a tile to see its full name, count and size."}</div>
  </section>;
}

function mapTileDescription(tile: DiskMapTile) {
  return `${tile.label}, ${tile.items.length} ${tile.items.length === 1 ? "item" : "items"}, ${diskBytes(tile.bytes)}${tile.selectedCount ? `, ${tile.selectedCount} ticked` : ""}`;
}

function DiskTileLabel({ entry }: { entry: DiskMapTile }) {
  const box = useRef<HTMLSpanElement>(null);
  const labelProbe = useRef<HTMLSpanElement>(null), sizeProbe = useRef<HTMLSpanElement>(null);
  const [fit, setFit] = useState<DiskLabelFit>("none");
  const size = `${diskBytes(entry.bytes)}${entry.selectedCount ? ` · ${entry.selectedCount} ticked` : ""}`;
  const label = `${entry.label}${entry.items.length > 1 ? ` · ${entry.items.length} items` : ""}`;
  useLayoutEffect(() => {
    const node = box.current, name = labelProbe.current, amount = sizeProbe.current;
    if (!node || !name || !amount) return;
    let alive = true;
    const measure = () => {
      if (!alive) return;
      const gap = parseFloat(getComputedStyle(node).rowGap) || 0;
      setFit(diskLabelFit(node.getBoundingClientRect(), name.getBoundingClientRect(), amount.getBoundingClientRect(), gap));
    };
    const observer = new ResizeObserver(measure);
    [node, name, amount].forEach(el => observer.observe(el));
    measure();
    void document.fonts.ready.then(measure);
    return () => { alive = false; observer.disconnect(); };
  }, [label, size]);
  return <span className="disk-tile-content" ref={box} data-fit={fit} aria-hidden="true">
    {/* Measure the first word plus ellipsis as the minimum meaningful label.
        Actual labels ellipsize horizontally; both rows use whole line boxes. */}
    <span className="disk-tile-measure disk-tile-label" ref={labelProbe}>{entry.label.split(/\s+/)[0]}…</span>
    <span className="disk-tile-measure disk-tile-size" ref={sizeProbe}>{size}</span>
    <span className="disk-tile-label disk-tile-visible-label">{label}</span>
    <span className="disk-tile-size disk-tile-visible-size">{size}</span>
  </span>;
}

function DiskRow({ item, checked, highlighted, onTick, previousScanAt, rowRef }: { item: DiskItem; checked: boolean; highlighted?: boolean; onTick: () => void; previousScanAt: number | null; rowRef: (el: HTMLElement | null) => void }) {
  const fold = useFold(item.id);
  const reasonId = useId();
  const selectable = diskSelectable(item);
  const longEffect = item.effect.length > 200, longNote = (item.note?.length ?? 0) > 200;
  const wt = item.worktree;
  const facts: { label: string; pass: boolean | undefined }[] = wt ? [
    { label: "Working tree clean", pass: wt.clean }, { label: "Merged to mainline", pass: wt.merged },
    { label: "Not a mainline worktree", pass: wt.mainline === undefined ? undefined : !wt.mainline }, { label: "Not in use", pass: wt.inUse === undefined ? undefined : !wt.inUse },
  ] : [];
  return <article ref={rowRef} tabIndex={-1} className={`disk-item${checked ? " is-selected" : ""}${highlighted ? " is-found" : ""}`} aria-label={item.label}>
    <div className="disk-item-heading"><label><input type="checkbox" checked={selectable && checked} aria-disabled={!selectable || undefined} aria-describedby={!selectable || item.notRecommended ? reasonId : undefined} onChange={() => { if (selectable) onTick(); }} /><strong>{item.label}</strong></label><strong className="disk-item-size">{diskBytes(item.bytes)}</strong></div>
    <code className="disk-path" title={item.path}>{item.path}</code>
    {(!selectable || item.notRecommended) && <p id={reasonId} className="disk-not-recommended">{item.notRecommended ? "Not recommended to delete" : "No safe cleanup command for this item"}</p>}
    {!longEffect && item.effect && <p>{item.effect}</p>}
    {!longNote && item.note && <p className="disk-note">{item.note}</p>}
    {item.grew && item.previousBytes !== null && item.bytes > item.previousBytes && <p className="disk-growth">+{((item.bytes - item.previousBytes) / 1e6).toLocaleString("en-US", { maximumFractionDigits: 1 })} MB since {diskDate(previousScanAt)}</p>}
    {wt && <><ul className="disk-worktree-facts">{facts.map(fact => <li key={fact.label} className={fact.pass === true ? "is-pass" : "is-fail"}><span>{fact.pass === true ? "✓ Pass" : fact.pass === false ? "✕ Fail" : "? Unknown"}</span> {fact.label}</li>)}</ul>
      {!!wt.ignoredBytes && <p className="disk-not-recommended">Includes {diskBytes(wt.ignoredBytes)} of ignored files. Git does not protect these files.</p>}
    </>}
    <FoldLine fold={fold} labels={["Full path", longEffect && `Effect · ${item.effect.length} characters`, longNote && `Note · ${item.note!.length} characters`, wt && "Worktree details"]} what={`details for ${item.label}`} />
    <FoldBody fold={fold} bounded={false}><code className="disk-full-path">{item.path}</code>{longEffect && <p>{item.effect}</p>}{longNote && <p>{item.note}</p>}{wt && <p>Repository: <code>{wt.repo || "Unknown"}</code><br />Branch: <code>{wt.branch || "Unknown"}</code><br />Idle: {wt.idleDays ?? "Unknown"} days · Eligible: {wt.eligible === undefined ? "Unknown" : wt.eligible ? "Yes" : "No"}</p>}</FoldBody>
  </article>;
}
function SkippedFolders({ report }: { report: DiskReport }) {
  const fold = useFold(`${report.scanId}:skipped`);
  return <div className="disk-skipped"><FoldLine fold={fold} labels={[`${report.skipped.length} folders skipped`]} what="skipped folders" /><FoldBody fold={fold} bounded={false}><ul>{report.skipped.map((item, i) => <li key={i}><code>{item.path}</code><p>{item.reason}</p></li>)}</ul>{!report.skipped.length && <p>No folders were skipped.</p>}</FoldBody></div>;
}
