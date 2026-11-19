// What an agent's chat runs on, and the way to change it: the sheet behind the
// settings text beside the agent's name (`AgentIdentityChip`).
//
// It is the composer's own settings sheet in another dress. The same shell
// (`.sheet.settings-sheet`: across the foot of a phone, a card at the foot of
// a wide window, so nothing of it is drawn past the composer's box), the same
// `ModelPicker` (grouped by provider, a limited provider's models stay
// pickable: the host decides) and the same effort list. There is no access
// page: access stays with `request_access` and its card.
//
// Both controls ask the host (`chat_switch_runtime`). Nothing here changes
// what the chat runs on; the page's own settings move on the host's word
// (`lib/useRuntimeSwitch`). A pick made during a turn is `pending` and the
// sheet says so in one quiet line; a refusal is the host's own sentence, here,
// where the press was made.
import { useState, type ReactNode } from "react";
import { providerFor, type AccessLevel, type Effort, type ModelChoice, type Provider } from "../lib/agentProviders";
import { antigravityHold, pendingLine, runtimeFlight, type RuntimeRef } from "../lib/runtimeSwitch";
import { dropHeld } from "../lib/pressGuard";
import { useInFlight } from "../lib/inFlight";
import { BackIcon, CloseIcon, EffortList, ModelPicker, SheetLink } from "./ComposerSettings";

/** The model catalog the composer already loads (`useProviderModels`) and
 *  what it knows of this machine: the sheet draws it, it never loads one. */
export type ModelPickerCatalog = {
  models: readonly ModelChoice[];
  status: Parameters<typeof ModelPicker>[0]["catalogStatus"];
  reload: (provider: Provider) => void;
  missing: (provider: Provider) => boolean;
  noAgents: boolean;
};

export type RuntimeControls = {
  /** What is waiting for this turn's full stop, if anything. */
  pending?: RuntimeRef;
  /** The host's sentence for a refusal of a press made in this sheet. */
  refusal?: string;
  /** Pick a model: asks the host for it at the chat's own effort. */
  onPick: (model: ModelChoice) => void;
  /** Pick an effort: asks the host for it on the chat's own model. */
  onEffort: (effort: Effort) => void;
  onDismissRefusal: () => void;
};

export function RuntimeSheet({
  id,
  chat,
  choice,
  effort,
  access,
  catalog,
  controls,
  receipt = [],
  onDone,
}: {
  id?: string;
  /** The chat's id: a request about it is held under it (`lib/inFlight`). */
  chat: string;
  choice: ModelChoice;
  effort: Effort;
  access: AccessLevel;
  catalog: ModelPickerCatalog;
  controls: RuntimeControls;
  receipt?: readonly string[];
  onDone: () => void;
}) {
  const [page, setPage] = useState<"root" | "effort">("root");
  const [back, setBack] = useState(false);
  const sending = useInFlight(runtimeFlight(chat));
  const provider = providerFor(choice.agent);
  const eff = provider.efforts.find((item) => item.id === effort);
  // Antigravity's effort is part of its model id: there is none to pick.
  const effortOffered = choice.agent !== "antigravity";
  const hold = (agent: Provider) => antigravityHold(agent, access);

  const note: ReactNode = (
    <>
      {controls.pending && (
        <p className="runtime-pending" role="status">{pendingLine(controls.pending)}</p>
      )}
      {controls.refusal && (
        <p className="runtime-refusal" role="alert">
          {controls.refusal}
          <button type="button" className="runtime-refusal-dismiss" onClick={controls.onDismissRefusal}>Dismiss</button>
        </p>
      )}
      <p className="runtime-note">
        This changes this chat only; the agent's registration stays as it is. Settings, Agents sets what its new chats open on.
        {" "}A change made during a turn waits for that turn to end.
      </p>
    </>
  );

  return (
    <div className="sheet settings-sheet runtime-sheet" id={id} role="dialog" aria-label="What this chat runs on"
      aria-busy={sending || undefined}
      onKeyDown={(event) => {
        dropHeld(event);
        if (event.key === "Escape") { event.stopPropagation(); onDone(); }
      }}>
      <div className="sheet-nav">
        <button type="button" className="sheet-nav-btn" aria-label={page === "root" ? "Close" : "Back"} title={page === "root" ? "Close" : "Back"}
          onClick={page === "root" ? onDone : () => { setBack(true); setPage("root"); }}>
          {page === "root" ? <CloseIcon /> : <BackIcon />}
        </button>
        <span className="sheet-title">{page === "root" ? "Model and effort" : "Effort"}</span>
      </div>
      <div key={page} className={`sheet-body sheet-page ${back ? "is-back" : ""}`}>
        {page === "root" && (
          <div className="sheet-group" aria-disabled={sending || undefined}>
            <ModelPicker
              rows
              choice={choice}
              models={catalog.models}
              catalogStatus={catalog.status}
              onReloadModels={catalog.reload}
              onChoice={(model) => { if (!sending) controls.onPick(model); }}
              missing={catalog.missing}
              noAgents={catalog.noAgents}
              started
              lite={false}
              holdProvider={hold}
              afterList={effortOffered ? (
                <div className="sheet-card">
                  <SheetLink label="Effort" value={eff?.label} onClick={() => { setBack(false); setPage("effort"); }} />
                </div>
              ) : <div className="sheet-foot-note">Antigravity's effort is part of its model.</div>}
            />
            {receipt.map((line) => <p key={line} className="runtime-receipt">{line}</p>)}
            {note}
          </div>
        )}
        {page === "effort" && (
          <div className="sheet-group" aria-disabled={sending || undefined}>
            <EffortList
              agent={choice.agent}
              effort={effort}
              onEffort={(next) => { if (!sending) controls.onEffort(next); }}
              started
              note=" A change waits for the turn to end when one is running."
            />
            {note}
          </div>
        )}
      </div>
    </div>
  );
}
