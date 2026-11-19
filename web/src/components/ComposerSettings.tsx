// The composer's settings stack: model, effort and access pickers and the sheet that holds them (moved verbatim from Composer.tsx).
import { ActionIcon } from "./ActionIcon";
import { Fragment, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { bridge } from "../lib/bridge";
import { Mascot } from "./Mascot";
import { AGENT_NAME, effortSteps, modelChoiceForFlag, piModelRef, piUpstreamHeading, PROVIDERS, providerFor, sameModelFlag, type AccessLevel, type Effort, type ModelChoice, type Provider } from "../lib/agentProviders";
import {
  choicesFromCatalog,
  type ModelCatalog,
} from "../lib/modelCatalog";

type ModelLoadState = {
  loading?: boolean;
  note?: string;
  error?: string;
};

/** Load catalogs only when a picker is opened. Claude may answer from its
 * Models API or the backend's active-model fallback; Codex answers from the
 * account-aware app-server `model/list`; Pi from
 * `pi --list-models` for the logins that are ready; Antigravity from `agy models`. Existing authored choices paint
 * immediately, so a cold CLI never turns the picker into a spinner. */
export function useProviderModels(open: boolean, installed?: readonly Provider[]) {
  const [choices, setChoices] = useState<Partial<Record<Provider, ModelChoice[]>>>({});
  const [status, setStatus] = useState<Partial<Record<Provider, ModelLoadState>>>({});
  const loaded = useRef(new Set<Provider>());

  const load = useCallback((provider: Provider, refresh = false) => {
    if (!refresh && loaded.current.has(provider)) return;
    loaded.current.add(provider);
    setStatus((current) => ({
      ...current,
      [provider]: { ...current[provider], loading: true, error: undefined },
    }));
    bridge
      .invoke<ModelCatalog>("agent_models", { agent: provider })
      .then((catalog) => {
        setChoices((current) => ({
          ...current,
          [provider]: choicesFromCatalog(provider, catalog),
        }));
        setStatus((current) => ({
          ...current,
          [provider]: { loading: false, note: catalog.note ?? undefined },
        }));
      })
      .catch((error) => {
        setStatus((current) => ({
          ...current,
          [provider]: {
            loading: false,
            error: String((error as Error)?.message ?? error),
          },
        }));
      });
  }, []);

  useEffect(() => {
    if (!open) return;
    for (const provider of ["claude", "codex", "pi", "antigravity"] as const) {
      if (installed && !installed.includes(provider)) continue;
      load(provider);
    }
  }, [open, installed, load]);

  const models = useMemo(
    () => PROVIDERS.flatMap((provider) => choices[provider.id] ?? provider.models),
    [choices],
  );
  const reload = useCallback((provider: Provider) => {
    loaded.current.delete(provider);
    load(provider, true);
  }, [load]);
  return { models, status, reload };
}

/** The access list: modes as rows, and `bypass` as the switch under them.
 *
 *  Drawn in two places — the dropdown on a wide screen and the settings sheet
 *  on a phone — and the switch has enough behaviour of its own (turning it OFF
 *  has to land somewhere) that keeping two copies of it was asking for them to
 *  drift. */
export function AccessList({
  list,
  access,
  onPick,
  note,
}: {
  list: readonly { id: AccessLevel; label: string; hint: string; bypass?: boolean }[];
  access: AccessLevel;
  onPick: (a: AccessLevel) => void;
  /** Said before the choice: what the levels cannot do for this provider. */
  note?: string;
}) {
  const modes = list.filter((p) => !p.bypass);
  const bypass = list.find((p) => p.bypass);
  // Where turning the switch off goes back to. The mode you were last ON, not a
  // fixed one: someone who was planning, flipped bypass to get one thing done,
  // and flipped it back meant to go back to planning.
  const before = useRef<AccessLevel>(access === bypass?.id ? modes[modes.length - 1].id : access);
  if (access !== bypass?.id) before.current = access;

  return (
    <>
      {note && <div className="picker-note">{note}</div>}
      {modes.map((p) => (
        <button
          key={p.id}
          type="button"
          role="menuitem"
          className={`picker-item ${p.id === access ? "is-on" : ""}`}
          onClick={() => onPick(p.id)}
        >
          <span className="picker-name">{p.label}</span>
          <span className="picker-model">{p.hint}</span>
          {/* The same mark the model list and the effort list use. A row that
              is merely tinted reads as hovered; a tick reads as chosen. */}
          {p.id === access && (
            <span className="picker-tick" aria-hidden="true">
              ✓
            </span>
          )}
        </button>
      ))}

      {bypass && (
        <button
          type="button"
          role="menuitemcheckbox"
          aria-checked={access === bypass.id}
          className={`picker-item is-bypass ${access === bypass.id ? "is-on" : ""}`}
          title={bypass.hint}
          onClick={() => onPick(access === bypass.id ? before.current : bypass.id)}
        >
          <span className="picker-name">{bypass.label}</span>
          <span className="picker-switch">{access === bypass.id ? "Enabled" : "Enable"}</span>
        </button>
      )}
    </>
  );
}

export function SlidersIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M4 7h10M18 7h2M4 17h4M12 17h8" />
      <circle cx="16" cy="7" r="2" />
      <circle cx="10" cy="17" r="2" />
    </svg>
  );
}

/** Round again: an arrow that comes back to where it set off. An open circle
 *  rather than a closed one, because the gap is what stops it reading as a
 *  loading spinner frozen mid-spin. */
function RestartIcon() {
  return (
    <svg
      width="15"
      height="15"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.9"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M20 11a8 8 0 1 0-2.3 6" />
      <path d="M20 4.5V11h-6.5" />
    </svg>
  );
}

/** Phone only: the same settings as the pickers in the wide bar — but as a
 *  STACK OF PAGES rather than one long scroll.
 *
 *  All three lived in one scroller, in the order the toolbar happened to put
 *  them: the model grid, then five access rows, then effort at the bottom, and
 *  a Done under all of it. Reaching effort meant scrolling past two decisions
 *  you were not making, and the sheet was the only surface in the app where
 *  three questions were asked at once.
 *
 *  So the root asks the one question the button is named after — which model —
 *  and effort and access become ROWS that say what they are set to and open
 *  their own page. A row that reads "Effort · High" answers the question
 *  without being opened at all, which the old sheet could only do by drawing
 *  the whole control.
 *
 *  The chrome is one bar rather than two: a title, and one button at its left
 *  that closes the sheet on the root and goes back on a page. The old Done sat
 *  in a foot under the scroller — a second commit surface for a sheet where
 *  every row already takes effect on the tap that chooses it.
 */
export function SettingsSheet({
  choice,
  models = PROVIDERS.flatMap((provider) => provider.models),
  catalogStatus = {},
  onReloadModels = () => {},
  onChoice,
  missing,
  noAgents,
  started,
  accessList,
  access,
  onAccess,
  effort,
  onEffort,
  lite,
  onLite,
  onRestart,
  onDone,
}: {
  choice: ModelChoice;
  models?: readonly ModelChoice[];
  catalogStatus?: Partial<Record<Provider, ModelLoadState>>;
  onReloadModels?: (provider: Provider) => void;
  onChoice: (m: ModelChoice) => void;
  missing: (p: Provider) => boolean;
  noAgents: boolean;
  started: boolean;
  accessList: readonly { id: AccessLevel; label: string; hint: string; bypass?: boolean }[];
  access: AccessLevel;
  onAccess: (a: AccessLevel) => void;
  effort: Effort;
  onEffort: (e: Effort) => void;
  lite: boolean;
  onLite: (on: boolean) => void;
  onRestart?: () => void;
  onDone: () => void;
}) {
  const [page, setPage] = useState<"root" | "effort" | "access">("root");
  /** Which way the last move went. The page coming in slides from the side it
   *  is arriving from, so going back is visibly the reverse of going in. */
  const [back, setBack] = useState(false);

  const open = (p: "effort" | "access") => {
    setBack(false);
    setPage(p);
  };
  const pop = () => {
    setBack(true);
    setPage("root");
  };

  // Off the list rather than off the id, so the word in the row is the same
  // word the page shows. Both can be absent for a moment while a provider
  // switch is in flight — the level or mode belongs to the OTHER agent until
  // the fallback lands.
  const eff = providerFor(choice.agent).efforts.find((e) => e.id === effort);
  const acc = accessList.find((a) => a.id === access);

  const title = page === "root" ? "Chat settings" : page === "effort" ? "Effort" : "Access";

  return (
    <div className="sheet settings-sheet" role="dialog" aria-label="Chat settings">
      {/* Fixed, and above the scroller: the way out of the sheet must never be
          the thing you have to scroll to reach. That was the whole point of
          the foot this replaces. */}
      <div className="sheet-nav">
        <button
          type="button"
          className="sheet-nav-btn"
          aria-label={page === "root" ? "Close" : "Back"}
          title={page === "root" ? "Close" : "Back"}
          onClick={page === "root" ? onDone : pop}
        >
          {page === "root" ? <CloseIcon /> : <BackIcon />}
        </button>
        <span className="sheet-title">{title}</span>
      </div>

      {/* Keyed on the page so React swaps the subtree rather than reusing it:
          the slide restarts, and a page opened after scrolling the root starts
          at its own top instead of inheriting how far down you were. */}
      <div key={page} className={`sheet-body sheet-page ${back ? "is-back" : ""}`}>
        {page === "root" && (
          <div className="sheet-group">
            <div className="sheet-head">Model</div>
            <ModelPicker
              rows
              choice={choice}
              models={models}
              catalogStatus={catalogStatus}
              onReloadModels={onReloadModels}
              onChoice={onChoice}
              missing={missing}
              noAgents={noAgents}
              started={started}
              lite={lite}
              onLite={onLite}
              onRestart={onRestart}
              afterList={
                <div className="sheet-card">
                  <SheetLink label="Effort" value={eff?.label} onClick={() => open("effort")} />
                  <SheetLink label="Access" value={acc?.label} onClick={() => open("access")} />
                </div>
              }
            />
          </div>
        )}

        {page === "effort" && (
          <div className="sheet-group">
            <EffortList
              agent={choice.agent}
              effort={effort}
              onEffort={onEffort}
              started={started}
            />
          </div>
        )}

        {page === "access" && (
          <div className="sheet-group">
            <div className="sheet-card">
              <AccessList list={accessList} access={access} onPick={onAccess} note={providerFor(choice.agent).accessNote} />
            </div>
            <div className="sheet-foot-note">
              A chat has no way to answer a permission prompt, so this is what
              {" "}{AGENT_NAME[choice.agent]} will do unattended.
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

/** A row that says what a setting is on, and opens the page that changes it.
 *
 *  The value is the point of it: a settings list you have to open to read is a
 *  list of questions, and this one answers two of them where it stands. */
export function SheetLink({
  label,
  value,
  onClick,
}: {
  label: string;
  /** Absent only while a provider switch is in flight and the chosen level
   *  belongs to the agent being left. */
  value?: string;
  onClick: () => void;
}) {
  return (
    <button type="button" className="sheet-link" onClick={onClick}>
      <span className="sheet-link-name">{label}</span>
      <span className="sheet-link-value">{value ?? "—"}</span>
      <ChevronIcon />
    </button>
  );
}

/** Effort on a phone: one row per level, the chosen one ticked.
 *
 *  The desktop keeps the slider — it has a mouse, and the scale is worth
 *  drawing when there is room for it. A phone does not: six rungs across
 *  360px is a 55px target for a drag, and the labels under them shrink to
 *  11px to fit. A row is the whole width, says the level in full with the
 *  sentence that explains it, and takes one tap.
 *
 *  Auto is a row here rather than the switch it is on the slider. It was only
 *  ever a switch because a scale has nowhere to put "stop deciding" — a list
 *  has: the end of it. */
export function EffortList({
  agent,
  effort,
  onEffort,
  started,
  note,
}: {
  agent: Provider;
  effort: Effort;
  onEffort: (e: Effort) => void;
  /** This conversation already has turns in it, so when the new level takes
   *  hold is worth saying. */
  started: boolean;
  /** Says when the change lands, in place of the ordinary sentence (the
   *  runtime sheet applies a change after the turn, not straight away). */
  note?: ReactNode;
}) {
  return (
    <>
      <div className="sheet-card">
        {providerFor(agent).efforts.map((e) => (
          <button
            key={e.id}
            type="button"
            role="menuitemradio"
            aria-checked={e.id === effort}
            className={`picker-item ${e.id === effort ? "is-on" : ""}`}
            onClick={() => {
              // A tap on the level already on is not a change, and putting it
              // through would restart a Codex process to arrive where it is.
              if (e.id === effort) return;
              if (e.id === "ultracode") quake();
              onEffort(e.id);
            }}
          >
            <span className="picker-name">{e.label}</span>
            <span className="picker-model">{e.hint}</span>
            {e.id === effort && (
              <span className="picker-tick" aria-hidden="true">
                ✓
              </span>
            )}
          </button>
        ))}
      </div>

      {/* What the whole scale costs, and — once there is a chat to change —
          when the change lands in it. */}
      <div className="sheet-foot-note">
        Higher effort means more thorough answers, but takes longer and uses your limits faster.
        {note ?? (started &&
          (providerFor(agent).capabilities.liveSettings.effort
            ? " Changes this chat straight away."
            : " Applies from your next message."))}
      </div>
    </>
  );
}

/** Back, close, and into a page: the three moves this sheet can make. Drawn
 *  here rather than pulled from the toolbar's icons because these are chrome,
 *  and chrome is thinner than a control. */
export function BackIcon() {
  return (
    <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.1" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="m15 18-6-6 6-6" />
    </svg>
  );
}

export function CloseIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.1" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M18 6 6 18M6 6l12 12" />
    </svg>
  );
}

function ChevronIcon() {
  return (
    <svg className="sheet-link-caret" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="m9 18 6-6-6-6" />
    </svg>
  );
}

/** Choosing a model: one tab per agent, then a tile each.
 *
 *  This was a flat list of seven rows, five of them starting with the word
 *  "Claude" — the agent's name written out over and over, and the model's name
 *  pushed to the right of it. The agent moves up into a tab, so it is written
 *  twice instead of seven times, and what is left is the only thing being
 *  chosen: the model, as a grid of tiles you read in one pass.
 *
 *  Picking a TAB changes nothing — it only looks. A model tile commits, while
 *  the application-level conversation stays the same even across providers.
 */
export function ModelPicker({
  choice,
  models,
  catalogStatus,
  onReloadModels,
  onChoice,
  missing,
  noAgents,
  started,
  lite,
  onLite,
  onRestart,
  rows,
  afterList,
  holdProvider,
}: {
  choice: ModelChoice;
  models: readonly ModelChoice[];
  catalogStatus: Partial<Record<Provider, ModelLoadState>>;
  onReloadModels: (provider: Provider) => void;
  onChoice: (m: ModelChoice) => void;
  /** True when this machine is known NOT to have that agent. */
  missing: (agent: Provider) => boolean;
  /** Asked, and nothing at all resolved. */
  noAgents: boolean;
  /** This conversation already has turns in it. */
  started: boolean;
  /** New chats start without this machine's skills, hooks and other MCP. */
  lite: boolean;
  /** Absent: no Clean start switch. A chat that is already running has no
   *  use for it (the runtime sheet of an agent's chat). */
  onLite?: (on: boolean) => void;
  /** End the running agent, keeping the conversation. Absent when there is no
   *  process to end. */
  onRestart?: () => void;
  /** A provider whose models are shown and cannot be picked right now, and
   *  why, in words (Antigravity cannot ask, so a chat at guarded Auto or
   *  Manual may not move to it). The tiles stay, off (`aria-disabled`), and
   *  the reason stands under the list. Undefined: nothing is held. */
  holdProvider?: (provider: Provider) => string | undefined;
  /** Draw the models as full-width rows with their hints, rather than as the
   *  grid of name tiles the dropdown uses. The phone's sheet sets it. */
  rows?: boolean;
  /** Dropped in straight under the model list, above clean-start and restart.
   *  The sheet puts its effort and access rows here: they are the next thing
   *  you would look for after the model, and clean-start and restart are about
   *  the PROCESS rather than the choice, so they belong under both. The slot
   *  exists because which agent's shelf is showing is this component's own
   *  state, and the rows above it have to move with it. */
  afterList?: ReactNode;
}) {
  const [tab, setTab] = useState<Provider>(choice.agent);
  const [exactId, setExactId] = useState("");
  const [exactError, setExactError] = useState(false);
  // Choosing elsewhere — the Agents page, or restoring a chat — moves the tab
  // to whatever is now in use, so reopening this never shows the wrong shelf.
  useEffect(() => setTab(choice.agent), [choice.agent]);
  useEffect(() => {
    setExactId("");
    setExactError(false);
  }, [tab]);

  const agents = PROVIDERS.map((provider) => provider.id);
  // Keep CLI defaults in the registry for restored sessions and history, but
  // offer only explicit model choices in both the dropdown and phone sheet.
  const offered = models.filter((model) => model.agent === tab && model.flag);
  const list = choice.agent === tab && choice.flag && !offered.some((model) => sameModelFlag(tab, model.flag, choice.flag))
    ? [choice, ...offered]
    : offered;
  const gone = missing(tab);
  const held = holdProvider?.(tab);
  const modelStatus = catalogStatus[tab];

  const useExactId = () => {
    if (held) return;
    const exact = exactId.trim();
    const model = modelChoiceForFlag(tab, exact);
    if (!model) {
      setExactError(true);
      return;
    }
    setExactError(false);
    onChoice(model);
  };

  return (
    <div className="mp">
      <div className="mp-tabs" role="tablist" aria-label="Agent">
        {agents.map((p) => (
          <button
            key={p}
            type="button"
            role="tab"
            aria-selected={tab === p}
            className={`mp-tab ${tab === p ? "is-on" : ""}`}
            disabled={missing(p)}
            onClick={() => setTab(p)}
          >
            <span className={`mp-dot ${missing(p) ? "is-off" : ""}`} aria-hidden="true" />
            <span className="mp-tab-name">{AGENT_NAME[p]}</span>
            {choice.agent === p && <span className="mp-tab-now">in use</span>}
          </button>
        ))}
      </div>

      {/* Tiles in a dropdown, rows on a phone. A 300px menu can hold four
          names in a grid you read in one pass; a sheet has the width for the
          line that says what each model is FOR, and the height to spend on
          targets a thumb can hit. Same choice, same order, same tick. */}
      <div className={rows ? "mp-list" : "mp-grid"} role="tabpanel" aria-label={AGENT_NAME[tab]}>
        {list.map((m, at) => {
          const on = m.id === choice.id;
          // A Pi model is billed by its upstream, so the list says whose
          // account each stretch of it is (the API key, the ChatGPT login).
          const upstream = tab === "pi" && m.flag ? piModelRef(m.flag).upstream : "";
          const heading = upstream && (at === 0 || piModelRef(list[at - 1].flag).upstream !== upstream || !list[at - 1].flag);
          return (
            <Fragment key={m.id}>
            {heading && <div className="mp-group" role="presentation">{piUpstreamHeading(upstream)}</div>}
            <button
              type="button"
              className={`${rows ? "picker-item has-robot" : "mp-card"} ${on ? "is-on" : ""}`}
              aria-pressed={on}
              disabled={gone}
              aria-disabled={held ? true : undefined}
              title={held ? `${m.model} · ${held}` : `${m.model} · ${m.flag}`}
              onClick={() => { if (!held) onChoice(m); }}
            >
              {/* Show the complete cast while choosing the next model. */}
              <Mascot robot={m.composerStyle} mood="idle" size={rows ? 32 : 44} />
              <span className={rows ? "picker-name" : "mp-card-name"}>{m.model}</span>
              {rows && <span className="picker-model">{m.hint}</span>}
              {on && (
                <span className={rows ? "picker-tick" : "mp-card-tick"} aria-hidden="true">
                  ✓
                </span>
              )}
            </button>
            </Fragment>
          );
        })}
      </div>

      <form
        className={`mp-exact ${exactError ? "is-error" : ""}`}
        onSubmit={(event) => {
          event.preventDefault();
          useExactId();
        }}
      >
        <input
          id={`exact-model-${tab}`}
          aria-label="Exact model ID"
          value={exactId}
          disabled={gone || !!held}
          spellCheck={false}
          autoCapitalize="none"
          autoCorrect="off"
          placeholder={tab === "claude" ? "claude-opus-4-6" : tab === "codex" ? "gpt-5.5" : tab === "antigravity" ? "gemini-3.8-flash-high" : tab === "pi" ? "anthropic/claude-sonnet-5-5" : "model id"}
          onChange={(event) => {
            setExactId(event.target.value);
            setExactError(false);
          }}
        />
        <button type="submit" disabled={gone || !!held || !exactId.trim()}>Use exact ID</button>
      </form>
      {exactError && (
        <div className="mp-catalog is-warn">{tab === "pi"
          ? "Use model or upstream/model (for example anthropic/claude-sonnet-5-5): letters, numbers, dots, dashes or underscores, 64 characters at most."
          : "Use 1–64 letters, numbers, dots, dashes, or underscores."}</div>
      )}

      {modelStatus?.loading && <div className="mp-catalog">Refreshing available models…</div>}
      {!modelStatus?.loading && modelStatus?.error && (
        <div className="mp-catalog is-warn" title={modelStatus.error}>
          Could not refresh models. Showing built-in choices.
          {tab === "pi" && modelStatus.error && <span className="mp-catalog-why"> {modelStatus.error}</span>}
          <button type="button" onClick={() => onReloadModels(tab)} data-icon-action title="Try again" aria-label="Try again">
            <ActionIcon name="retry" label="Try again" />
          </button>
        </div>
      )}
      {!modelStatus?.loading && !modelStatus?.error && modelStatus?.note && (
        <div className="mp-catalog">{modelStatus.note}</div>
      )}

      {held && <div className="mp-note" role="note">{held}</div>}

      {afterList}

      {/* Under the tiles because it is the same decision as the model: what
          this chat is made of, chosen before it starts. Claude only — Codex
          keeps its skills in a folder rather than in the config it can be told
          to skip, so the same flags there saved about 2% and are not worth a
          switch that would look like it did something. */}
      {onLite && providerFor(tab).capabilities.cleanStart && (
        <button
          type="button"
          role="menuitemcheckbox"
          aria-checked={lite}
          className={`mp-lite ${lite ? "is-on" : ""}`}
          title="Start without this machine's skills, hooks or other MCP servers"
          onClick={() => onLite(!lite)}
        >
          <span className="mp-lite-text">
            <span className="mp-lite-name">Clean start</span>
            <span className="mp-lite-hint">
              No skills, hooks or other MCP — about half the context
            </span>
          </span>
          <span className="picker-switch">{lite ? "On" : "Off"}</span>
        </button>
      )}

      {/* Under the clean-start switch because it answers the same question from
          the other end: that one decides what a chat is made of BEFORE it
          starts, this one is how a chat already running gets made again.

          Both live in the model menu rather than beside the terminal button
          because neither is a thing you do — they are what the agent in this
          chat IS. And here it reaches a phone for free: the menu is drawn from
          this one component in two places, the dropdown and the sheet. */}
      {onRestart && (
        <button type="button" className="mp-restart" onClick={onRestart}>
          <span className="mp-lite-text">
            <span className="mp-lite-name">Restart agent</span>
            {/* What it keeps first. The word "restart" on a chat you have been
                talking to for an hour reads as a threat until you know the
                conversation is not the thing being restarted. */}
            <span className="mp-lite-hint">
              Keeps the conversation — your next message picks up new MCP servers and plugins
            </span>
          </span>
          <RestartIcon />
        </button>
      )}

      <ModelNote
        tab={tab}
        choice={choice}
        gone={gone}
        noAgents={noAgents}
        started={started}
        lite={lite}
      />
    </div>
  );
}

/** The one line under the tiles. There is always at most one thing worth
 *  saying, and saying two of them at once is how the old menu ended up with a
 *  paragraph sitting on top of a list. */
function ModelNote({
  tab,
  choice,
  gone,
  noAgents,
  started,
  lite,
}: {
  tab: Provider;
  choice: ModelChoice;
  gone: boolean;
  noAgents: boolean;
  started: boolean;
  lite: boolean;
}) {
  if (noAgents) {
    return <div className="mp-note is-warn">No agent CLI on this machine — a chat cannot start</div>;
  }
  if (gone) {
    return (
      <div className="mp-note is-warn">
        {AGENT_NAME[tab]} is not on this machine — install it to use these
      </div>
    );
  }
  // The flags are read once, when the agent starts. Said here rather than on
  // the switch itself, because it is only true of a chat already running.
  if (started && lite && providerFor(tab).capabilities.cleanStart && choice.agent === tab) {
    return <div className="mp-note">Clean start applies to your next new chat</div>;
  }
  if (!started) return null;
  return (
    <div className="mp-note">
      Switching models keeps this chat — the next model receives the conversation so far
    </div>
  );
}

/** How full this session's context is, next to the send button.
 *
 *  A conversation has a ceiling, and running into it is the thing that ends a
 *  session — so it belongs where you decide whether to keep going, not in a
 *  settings page. Both numbers arrive with the turn's `result`, so this shows
 *  nothing until the first answer has landed rather than guessing.
 *
 *  The ring fills as the context does, and turns amber then red. That is the
 *  whole message; the exact numbers are in the tooltip for when you want them. */
/** The meter itself: bars rising left to right, lit up to the chosen level.
 *
 *  It sits ON the button, so how hard the agent is set to think is readable
 *  from the composer bar without opening anything — which a word alone never
 *  was. "High" tells you nothing about whether anything sits above it.
 *
 *  Auto lights every bar at half strength: not a level, but not off either. */
export function EffortBars({ at, of, auto }: { at: number; of: number; auto?: boolean }) {
  const PITCH = 3.4;
  const BAR = 2.2;
  const H = 11;
  const w = of * PITCH - (PITCH - BAR);
  return (
    <svg
      className={`eff-bars ${auto ? "is-auto" : ""}`}
      width={w}
      height={H}
      viewBox={`0 0 ${w} ${H}`}
      aria-hidden="true"
    >
      {Array.from({ length: of }, (_, i) => {
        const h = 3 + (i * (H - 3)) / Math.max(1, of - 1);
        return (
          <rect
            key={i}
            className={auto || i <= at ? "is-lit" : ""}
            x={i * PITCH}
            y={H - h}
            width={BAR}
            height={h}
            rx={1}
          />
        );
      })}
    </svg>
  );
}

/** How long the ultracode quake runs. The CSS animation is the same length,
 *  and the two have to agree: taking the class off is what ends it. */
const QUAKE_MS = 2000;

let quakeTimer = 0;

/** Ultracode sits at the top of the scale, so landing on it is an event, not
 *  one more step: for two seconds the app shakes and its colours run.
 *
 *  The class goes on `body` and the CSS moves everything under it EXCEPT the
 *  slider — the control under your finger has to hold still, or the level you
 *  were aiming at becomes a moving target. */
function quake(): void {
  const body = document.body;
  body.classList.remove("is-ultra");
  // A reflow between off and on, so arriving again restarts the animation
  // instead of being ignored as "that class is already there".
  void body.offsetWidth;
  body.classList.add("is-ultra");
  window.clearTimeout(quakeTimer);
  quakeTimer = window.setTimeout(() => body.classList.remove("is-ultra"), QUAKE_MS);
}

/** Effort as a slider along its rungs, with Auto as its own switch.
 *
 *  This was a dropdown, which is the one control that hides a scale: you saw
 *  the word you were on and nothing about what lay above or below it, and
 *  moving two levels meant opening a menu and aiming at a row. Effort is
 *  ordered — that is its whole shape — so it is a slider: one drag crosses the
 *  range, arrow keys step it, and the rungs are on screen the entire time.
 *
 *  Every level names itself under the track. The one you are on is spelled out
 *  in full above it, with the sentence saying what it costs you, because that
 *  is the part a short tick label cannot carry.
 *
 *  A drag crosses every rung on the way, and each one used to reach the agent
 *  — one decision left five `/effort` turns in the transcript and restarted
 *  the process five times. So the level is sent when the gesture ENDS, not
 *  while it moves: one drag, one change; a tap on a rung or on Auto is its own
 *  whole gesture and lands at once.
 *
 *  It used to be a button UNDER the slider that sent it, which inside the
 *  settings sheet put a second commit button above Done — every other row in
 *  that sheet takes effect on the tap that chooses it, and this one alone
 *  asked twice, with the two buttons stacked and neither saying which was
 *  which. Letting go is the confirmation now, and the hollow fill under your
 *  thumb is what says it has not been sent yet. */
export function EffortSlider({
  agent,
  effort,
  onEffort,
  started,
}: {
  agent: Provider;
  effort: Effort;
  onEffort: (e: Effort) => void;
  /** This conversation already has turns in it, so when the new level takes
   *  hold is worth saying. */
  started: boolean;
}) {
  const steps = effortSteps(agent);
  const autoRow = providerFor(agent).efforts.find((e) => e.id === "auto");
  /** The middle when the level belongs to the OTHER agent — the same fallback
   *  the button makes, so the two never disagree while a switch is in flight. */
  const idxOf = (id: Effort) => {
    const i = steps.findIndex((e) => e.id === id);
    return i < 0 ? Math.floor(steps.length / 2) : i;
  };

  /** What the slider is showing, which is not yet what the chat is running. */
  const [draft, setDraft] = useState<Effort>(effort);
  /** The same value, readable the instant it changes. React batches state, so
   *  two moves in one tick would both see the OLD draft — and the quake, which
   *  fires on ARRIVING at Ultracode, would miss or repeat. */
  const shown = useRef<Effort>(effort);
  // The chosen level can change from outside — another agent, a resumed
  // session, the confirm below landing. The draft follows it back.
  useEffect(() => {
    setDraft(effort);
    shown.current = effort;
  }, [effort, agent]);

  const isAuto = draft === "auto";
  /** Where the slider rests while Auto is on. Auto has no rung, and leaving the
   *  thumb wherever it happened to be would make turning Auto off a surprise —
   *  this is the level it goes back to, shown the whole time. */
  const [held, setHeld] = useState(() => idxOf(effort));
  const at = isAuto ? held : idxOf(draft);
  useEffect(() => {
    if (draft !== "auto") setHeld(idxOf(draft));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [draft, agent]);

  const cur = isAuto && autoRow ? autoRow : steps[at];
  /** Moved, but not let go of yet. The fill goes hollow while this is true, so
   *  a slider under your thumb is never read as the level in force. */
  const dirty = draft !== effort;
  const last = steps.length - 1;
  const pct = (i: number) => (i / Math.max(1, last)) * 100;

  /** Dragging while Auto is on turns Auto off at that level, rather than
   *  refusing to move: a dead control is a worse answer than an obvious one. */
  const pickAt = (i: number) => {
    const id = steps[i].id;
    if (id === "ultracode" && shown.current !== "ultracode") quake();
    shown.current = id;
    setHeld(i);
    setDraft(id);
  };

  /** The one place a level reaches the agent: the end of the gesture that chose
   *  it. Off `shown` rather than `draft` because a release lands in the same
   *  tick as the move before it, and state would still hold the old value. */
  const release = () => {
    if (shown.current !== effort) onEffort(shown.current);
  };

  /** A drag can end anywhere — past the end of the track, off the sheet, out of
   *  the window — so the release is listened for on the window rather than on
   *  the input, which only hears the ones that end on top of it. */
  const armRelease = () => {
    const up = () => {
      window.removeEventListener("pointerup", up);
      window.removeEventListener("pointercancel", up);
      release();
    };
    window.addEventListener("pointerup", up);
    window.addEventListener("pointercancel", up);
  };

  return (
    <div className={`eff ${isAuto ? "is-auto" : ""} ${dirty ? "is-draft" : ""}`}>
      {/* Belongs to the control, not to one of the two things that hold it:
          the dropdown said when a change lands and the phone's sheet did not,
          which is the same control answering the same question twice. */}
      {started && (
        <div className="picker-note">
          {providerFor(agent).capabilities.liveSettings.effort
            ? "Changes this chat straight away"
            : "Applies from your next message"}
        </div>
      )}

      <div className="eff-head">
        <span className="eff-name">{cur.label}</span>
        <span className="eff-hint">{cur.hint}</span>
      </div>

      <div className="eff-slide">
        <div className="eff-track" aria-hidden="true">
          <span className="eff-fill" style={{ width: `${pct(at)}%` }} />
          {steps.map((e, i) => (
            <span
              key={e.id}
              className={`eff-stop ${!isAuto && i <= at ? "is-past" : ""}`}
              style={{ left: `${pct(i)}%` }}
            />
          ))}
        </div>
        <input
          className="eff-range"
          type="range"
          min={0}
          max={last}
          step={1}
          value={at}
          aria-label="Effort"
          aria-valuetext={cur.label}
          onChange={(ev) => pickAt(Number(ev.target.value))}
          onPointerDown={armRelease}
          /* Arrow keys step it one rung at a time, and a held key repeats —
             so the keyboard's end of the gesture is the key coming back up. */
          onKeyUp={release}
        />
      </div>

      {/* Also the click targets: the ends of a scale are where you most often
          want to land, and dragging to one is slower than saying so. */}
      <div className="eff-marks">
        {steps.map((e, i) => (
          <button
            key={e.id}
            type="button"
            className={`eff-mark ${!isAuto && i === at ? "is-on" : ""}`}
            style={
              i === 0
                ? { left: 0 }
                : i === last
                  ? { right: 0 }
                  : { left: `${pct(i)}%`, transform: "translateX(-50%)" }
            }
            title={`${e.label} — ${e.hint}`}
            onClick={() => {
              pickAt(i);
              release();
            }}
          >
            {e.short}
          </button>
        ))}
      </div>

      {autoRow && (
        <button
          type="button"
          className={`eff-auto ${isAuto ? "is-on" : ""}`}
          role="switch"
          aria-checked={isAuto}
          onClick={() => {
            const id = isAuto ? steps[held].id : "auto";
            shown.current = id;
            setDraft(id);
            release();
          }}
        >
          <span className="eff-auto-text">
            <span className="picker-name">{autoRow.label}</span>
            {/* Off, it has to say what it does. On, the line above already
                said that — so it answers the question the greyed-out slider
                raises instead: what happens when you switch this back. */}
            <span className="picker-model">
              {isAuto ? `on — off goes back to ${steps[held].label}` : autoRow.hint}
            </span>
          </span>
          <span className="eff-switch" aria-hidden="true" />
        </button>
      )}
    </div>
  );
}
