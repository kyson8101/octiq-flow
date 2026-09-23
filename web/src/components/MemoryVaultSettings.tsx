import { useEffect, useRef, useState } from "react";
import { bridge } from "../lib/bridge";
import { FolderPicker } from "./FolderPicker";

type VaultConfig = { path: string; writable: boolean };
type Match = { path: string; line: number; snippet: string; revision: string };
type SearchResult = { matches: Match[]; total: number; nextOffset: number | null; truncated: boolean; skipped: number };
type Note = { path: string; content: string; startLine: number; totalLines: number; nextLine: number | null; revision: string };
const emptyConfig: VaultConfig = { path: "", writable: false };

export function MemoryVaultSettings() {
  const [config, setConfig] = useState<VaultConfig>(emptyConfig);
  const [path, setPath] = useState("");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [finding, setFinding] = useState(false);
  const [picker, setPicker] = useState(false);
  const [error, setError] = useState("");
  const [query, setQuery] = useState("");
  const [folder, setFolder] = useState("");
  const [results, setResults] = useState<SearchResult | null>(null);
  const [searched, setSearched] = useState({ query: "", path: "" });
  const [note, setNote] = useState<Note | null>(null);
  const request = useRef(0);

  useEffect(() => {
    let alive = true;
    bridge.invoke<VaultConfig>("memory_vault_settings").then((value) => {
      if (alive) { setConfig(value); setPath(value.path); }
    }).catch((reason) => { if (alive) setError(String(reason)); })
      .finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; request.current++; };
  }, []);

  async function configure(next: VaultConfig) {
    request.current++;
    setSaving(true); setFinding(false); setError(""); setResults(null); setNote(null);
    try {
      const saved = await bridge.invoke<VaultConfig>("memory_vault_configure", { config: next });
      setConfig(saved); setPath(saved.path);
    } catch (reason) { setError(String(reason)); }
    finally { setSaving(false); }
  }

  async function search(offset = 0) {
    const params = offset ? searched : { query: query.trim(), path: folder.trim() };
    if (!params.query) return;
    const id = ++request.current;
    setFinding(true); setError("");
    if (!offset) { setResults(null); setNote(null); setSearched(params); }
    try {
      const found = await bridge.invoke<SearchResult>("memory_vault_call", { action: "search", args: { ...params, offset, limit: 30 } });
      if (id === request.current) setResults((old) => ({ ...found, matches: offset && old ? [...old.matches, ...found.matches] : found.matches }));
    } catch (reason) { if (id === request.current) setError(String(reason)); }
    finally { if (id === request.current) setFinding(false); }
  }

  async function read(path: string, startLine = 1) {
    const id = ++request.current;
    setFinding(true); setError(""); setNote(null);
    try {
      const result = await bridge.invoke<Note>("memory_vault_call", { action: "read", args: { path, startLine, lineCount: 100 } });
      if (id === request.current) setNote(result);
    } catch (reason) { if (id === request.current) setError(String(reason)); }
    finally { if (id === request.current) setFinding(false); }
  }

  return <section className="settings-section memory-vault" aria-labelledby="memory-vault-title">
    <header className="settings-section-head"><div>
      <h2 id="memory-vault-title">Shared Memory Vault</h2>
      <p>One place for Claude, Codex, and your other agents to share knowledge.</p>
    </div></header>
    {loading ? <p role="status">Loading vault settings…</p> : <>
      <form className="vault-connect" onSubmit={(event) => { event.preventDefault(); void configure({ path: path.trim(), writable: path.trim() === config.path && config.writable }); }}>
        <label htmlFor="vault-path">Vault folder on the server</label>
        <div className="vault-input-row">
          <input id="vault-path" value={path} placeholder="Absolute folder path" disabled={saving} onChange={(event) => setPath(event.target.value)} autoComplete="off" />
          <button type="button" className="vault-button" disabled={saving} onClick={() => setPicker(true)}>Browse</button>
          <button type="submit" className="settings-primary" disabled={saving || !path.trim() || path.trim() === config.path}>{saving ? "Saving…" : "Connect"}</button>
        </div>
        <p className="vault-help">Use your existing Obsidian vault or any folder of Markdown notes. Files stay where they are.</p>
      </form>
      {config.path ? <>
        <div className="vault-access">
          <label className="vault-write-toggle"><input type="checkbox" checked={config.writable} disabled={saving} onChange={(event) => void configure({ ...config, writable: event.target.checked })} /><span>Allow agents to update notes</span></label>
          <p className="vault-help">Updates check the current revision and return a saved receipt. Archived notes remain recoverable. Private preference notes stay excluded.</p>
          <button type="button" className="vault-button" disabled={saving} onClick={() => void configure(emptyConfig)}>Disconnect vault</button>
        </div>
        <form className="vault-search" onSubmit={(event) => { event.preventDefault(); void search(); }}>
          <h3>Find a memory</h3>
          <label htmlFor="vault-query">Search notes</label>
          <div className="vault-input-row"><input id="vault-query" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="A decision, project, or phrase" /><button type="submit" className="settings-primary" disabled={finding || saving || !query.trim()}>Search</button></div>
          <label htmlFor="vault-search-folder">Within folder <span className="vault-help">(optional)</span></label>
          <input id="vault-search-folder" value={folder} onChange={(event) => setFolder(event.target.value)} placeholder="For example, agent-zone/projects" />
        </form>
        {finding && <p role="status">Reading the vault…</p>}
        {results && <div className="vault-results" aria-label="Vault search results">
          <p className="vault-help">{results.total} matching {results.total === 1 ? "note" : "notes"}{results.truncated ? " in this partial search. Narrow the folder to search further." : "."}{results.skipped > 0 ? ` ${results.skipped} unreadable or oversized entries skipped.` : ""}</p>
          {results.matches.map((match) => <button className="vault-result" type="button" key={match.path} disabled={saving || finding} onClick={() => void read(match.path, Math.max(1, match.line - 5))}>
            <strong>{match.path}</strong><small>Line {match.line}</small><span>{match.snippet}</span>
          </button>)}
          {results.nextOffset !== null && <button type="button" className="vault-button" disabled={finding || saving} onClick={() => void search(results.nextOffset!)}>Show more</button>}
        </div>}
        {note && <article className="vault-note" aria-label={`Note: ${note.path}`}>
          <h3>{note.path}</h3><p className="vault-help">From line {note.startLine} · {note.totalLines} lines</p>
          <pre>{note.content}</pre>
          {note.nextLine !== null && <button className="vault-button" type="button" disabled={finding || saving} onClick={() => void read(note.path, note.nextLine!)}>Read next section</button>}
        </article>}
      </> : <p className="vault-help">Connect a folder to make its notes available through OctiqFlow’s own vault tools.</p>}
    </>}
    {error && <p className="set-warn" role="alert">{error}</p>}
    {picker && <FolderPicker title="Choose a memory vault" start={path || config.path} onClose={() => setPicker(false)} onPick={(selected) => { setPicker(false); void configure({ path: selected, writable: selected === config.path && config.writable }); }} />}
  </section>;
}
