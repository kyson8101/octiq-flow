import { useEffect, useState } from "react";
import { bridge } from "../lib/bridge";
import { effortSteps, providerFor, type AccessLevel, type Provider } from "../lib/agentProviders";
import { loadTeam, teamModels, type TeamAgent } from "../lib/agentsMode";
import "./ProviderFallback.css";

type Selection = { agent: Provider; model: string; effort: string | null };
type Rule = { mode: "auto" | "ask"; backup: Selection | null };
type Policy = { global: Rule; agents: Record<string, Rule> };
type Settings = { agent: Provider; model: string | null; effort: string | null; access: AccessLevel };
type Choice = { id: string; key: string; label: string; source: Settings; preferred?: Settings; rememberLabel?: string; worker?: boolean; options: { agent: Provider; installed: boolean; limited: boolean; suggestion: Settings }[] };
const providers: Provider[] = ["claude", "codex", "antigravity"];

export function FallbackFields({ value, onChange, disabled = false, allowed = providers, worker = false }: { value: Selection; onChange: (value: Selection) => void; disabled?: boolean; allowed?: Provider[]; worker?: boolean }) {
  const models = (agent: Provider) => teamModels(agent).filter(m => !worker || !/astra|fable/i.test(m.flag));
  return <div className="fallback-fields">
    <label>Provider<select value={value.agent} disabled={disabled} onChange={e => {
      const agent = e.target.value as Provider;
      onChange({ agent, model: models(agent)[0]?.flag ?? "", effort: null });
    }}>{allowed.map(agent => <option key={agent} value={agent}>{providerFor(agent).name}</option>)}</select></label>
    <label>Model<select value={value.model} disabled={disabled} onChange={e => onChange({ ...value, model: e.target.value })}>
      {!models(value.agent).some(m => m.flag === value.model) && <option value={value.model}>{value.model || "Choose a model"}</option>}
      {models(value.agent).map(model => <option key={model.id} value={model.flag}>{model.model}</option>)}
    </select></label>
    <label>Effort<select value={value.effort ?? ""} disabled={disabled || value.agent === "antigravity"} onChange={e => onChange({ ...value, effort: e.target.value || null })}>
      <option value="">{value.agent === "antigravity" ? "Included in model" : "Model default"}</option>
      {value.agent !== "antigravity" && effortSteps(value.agent).map(e => <option key={e.id} value={e.id}>{e.label}</option>)}
    </select></label>
  </div>;
}

export function ChoiceCard({ choice, onDone }: { choice: Choice; onDone: () => void }) {
  const available = choice.options.filter(o => o.installed && !o.limited);
  const first = available.some(o => o.agent === choice.preferred?.agent) ? choice.preferred : available[0]?.suggestion;
  const [value, setValue] = useState<Selection>({ agent: first?.agent ?? "claude", model: first?.model ?? "", effort: first?.effort ?? null });
  const [remember, setRemember] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  async function answer(selection: Selection | null) {
    setBusy(true); setError("");
    try { await bridge.invoke("provider_fallback_choose", { key: choice.key, id: choice.id, selection, remember: selection ? remember : false }); onDone(); }
    catch (reason) { setError(String(reason)); }
    finally { setBusy(false); }
  }
  return <section className="provider-choice" aria-label="Choose a replacement provider">
    <header><span className="provider-choice-eyebrow">Usage limit reached</span><h3>{choice.label}</h3></header>
    <p>{providerFor(choice.source.agent).name} has reached its limit. Choose how to continue with the existing work and conversation.</p>
    {!!available.length && <FallbackFields value={value} onChange={setValue} disabled={busy} worker={choice.worker} allowed={available.map(o => o.agent)} />}
    {!available.length && <p role="status">No compatible provider is available right now. Install another provider or wait for its allowance to reset.</p>}
    <div className="provider-choice-footer"><span>Access stays <strong>{choice.source.access}</strong>.</span>
      <label><input type="checkbox" checked={remember} disabled={busy} onChange={e => setRemember(e.target.checked)} /> {choice.rememberLabel ?? "Save as this agent’s backup"}</label>
    </div>
    {error && <p className="set-warn" role="alert">{error}</p>}
    <div className="provider-choice-actions"><button type="button" className="vault-button" disabled={busy} onClick={() => void answer(null)}>Cancel</button>
      <button type="button" className="settings-primary" disabled={busy || !available.length || !value.model} onClick={() => void answer(value)}>{busy ? "Saving…" : "Continue with selection"}</button></div>
  </section>;
}

export function ProviderFallbackChoices({ chatKey }: { chatKey: string }) {
  const [choices, setChoices] = useState<Choice[]>([]);
  const [revision, setRevision] = useState(0);
  useEffect(() => {
    let live = true;
    let sequence = 0;
    const reload = async () => {
      const current = ++sequence;
      try { const next = await bridge.invoke<Choice[]>("provider_fallback_choices", { key: chatKey }); if (live && current === sequence) setChoices(next); }
      catch { /* Keep pending choices until the host can be read again. */ }
    };
    const off = bridge.on("provider-fallback-changed", () => void reload());
    const offChat = bridge.on<{ key: string; event: { type?: string } }>("chat-event", payload => {
      if (payload.key === chatKey && payload.event?.type?.startsWith("octiq_auto_resume_")) void reload();
    });
    const offState = bridge.onState(state => { if (state === "open") void reload(); });
    void reload();
    return () => { live = false; off(); offChat(); offState(); };
  }, [chatKey, revision]);
  return <>{choices.map(choice => <ChoiceCard key={choice.id} choice={choice} onDone={() => { setChoices(old => old.filter(c => c.id !== choice.id)); setRevision(r => r + 1); }} />)}</>;
}

export function ProviderFallbackSettings() {
  const [policy, setPolicy] = useState<Policy>();
  const [agents, setAgents] = useState<TeamAgent[]>([]);
  const [scope, setScope] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);
  useEffect(() => {
    let alive = true;
    Promise.all([bridge.invoke<Policy>("provider_fallback_policy"), loadTeam(null, true)])
      .then(([next, roster]) => { if (alive) { setPolicy(next); setAgents(roster); } })
      .catch(reason => { if (alive) setError(String(reason)); });
    return () => { alive = false; };
  }, []);
  const own = scope ? policy?.agents[scope] : policy?.global;
  const rule = own ?? policy?.global;
  function change(next: Rule | undefined) {
    setDone(false);
    setPolicy(old => {
      if (!old) return old;
      if (!scope) return { ...old, global: next ?? old.global };
      const agents = { ...old.agents }; if (next) agents[scope] = next; else delete agents[scope];
      return { ...old, agents };
    });
  }
  async function save() {
    setBusy(true); setError(""); setDone(false);
    try { await bridge.invoke("provider_fallback_policy_set", { owner: scope || null, rule: own ?? null }); setDone(true); }
    catch (reason) { setError(String(reason)); }
    finally { setBusy(false); }
  }
  return <section className="settings-section provider-fallback-settings">
    <header className="settings-section-head"><div><h2>When a provider reaches its limit</h2><p>Choose automatically or pause and pick a replacement. Agent defaults and access stay unchanged.</p></div></header>
    {error && <p className="set-warn" role="alert">{error}</p>}
    {policy && rule && <>
      <label>Applies to<select value={scope} disabled={busy} onChange={e => { setScope(e.target.value); setDone(false); }}><option value="">All agents · global default</option>{agents.map(a => <option key={a.id} value={a.id}>{a.name}</option>)}</select></label>
      {scope && <label className="fallback-inherit"><input type="checkbox" disabled={busy} checked={!own} onChange={e => change(e.target.checked ? undefined : { ...policy.global })} /> Use global default</label>}
      <label>When limited<select disabled={busy || (!!scope && !own)} value={rule.mode} onChange={e => change({ ...rule, mode: e.target.value as Rule["mode"] })}>
        <option value="auto">Switch automatically</option><option value="ask">Let me choose</option>
      </select></label>
      <label className="fallback-inherit"><input type="checkbox" checked={!!rule.backup} disabled={busy || (!!scope && !own)} onChange={e => change({ ...rule, backup: e.target.checked ? { agent: "claude", model: "sonnet", effort: null } : null })} /> Preferred backup configuration</label>
      {rule.backup && <FallbackFields value={rule.backup} onChange={backup => change({ ...rule, backup })} disabled={busy || (!!scope && !own)} />}
      <p className="settings-note">Automatic mode uses a compatible backup, then equivalent available providers. “Let me choose” waits for your selection. For Antigravity, effort is part of the model. Ordinary chats use the global policy; registered agents can override it.</p>
      <div className="provider-choice-actions">{done && <span role="status">Saved</span>}<button className="settings-primary" disabled={busy} onClick={() => void save()}>{busy ? "Saving…" : "Save fallback preferences"}</button></div>
    </>}
  </section>;
}
