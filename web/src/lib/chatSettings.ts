// What a chat runs at, said beside the agent's name in the composer, and the
// last turn's receipt, said in a tooltip.
//
// In an agent's chat the composer has no pickers: the agent's registration
// owns its settings. So what THIS chat runs at is said as small quiet text
// beside its name, `opus · high · Auto`: read-only, and only what the page
// knows of this chat. A value it does not know is left out, never guessed
// and never filled in from the roster: a chat can differ from its agent's
// registration (it keeps the model it was started on).
import { providerFor, type AccessLevel, type Effort, type ModelChoice } from "./agentProviders";

/** What the page was told about a saved chat. Each is absent in a record
 *  from before that setting was kept. */
export type RecordedSettings = {
  modelId?: string | null;
  permission?: string | null;
  effort?: string | null;
};

export type KnownSettings = { model?: string; effort?: string; access?: string };

/** The three settings of the chat on screen, each only where it is known.
 *
 *  The values are the page's own for this session (`choice`, `effort`,
 *  `access`: what it starts and resumes the agent with). Whether each is
 *  KNOWN is the chat's record's to say:
 *  - a conversation not saved yet runs at exactly what the page holds, which
 *    for an agent is its registration's settings, copied in as the page
 *    opened the new conversation;
 *  - a saved chat's model is known when its record names one, or the agent
 *    itself reported one; its effort and access when the record has them.
 *    Without that the page holds whatever the last chat left behind, which
 *    says nothing about this one.
 *  A level the chat's provider does not offer has no name and is left out. */
export function knownSettings(input: {
  /** The saved chat's record; `null` for a conversation not saved yet. */
  record: RecordedSettings | null | undefined;
  /** The model the agent reported for this chat, if it has. */
  reported?: string;
  choice: Pick<ModelChoice, "agent" | "model">;
  effort: Effort;
  access: AccessLevel;
}): KnownSettings {
  const { record, choice } = input;
  const provider = providerFor(choice.agent);
  const unsaved = record === null;
  const known = (recorded: unknown) => unsaved || (typeof recorded === "string" && recorded !== "");
  return {
    model: (unsaved || !!record?.modelId || !!input.reported) && choice.model ? choice.model : undefined,
    effort: known(record?.effort) ? provider.efforts.find((item) => item.id === input.effort)?.label : undefined,
    access: known(record?.permission) ? provider.access.find((item) => item.id === input.access)?.label : undefined,
  };
}

/** "opus · high · Auto": the model and the effort in small letters, as the
 *  running line says them, and the access by the name its picker gives it.
 *  Empty when nothing is known. */
export function runsAtLine(known: KnownSettings): string {
  return [known.model?.toLowerCase(), known.effort?.toLowerCase(), known.access]
    .filter((part): part is string => !!part)
    .join(" · ");
}

/** The same line in the two parts the composer draws: what gives way first
 *  on a narrow composer (the model and the effort) and what is cut last (the
 *  access, which is the part that says what the agent may do). The access
 *  carries the separator, so a line whose first part is cut short, or gone,
 *  still reads: `opus la… · Plan`, `· Plan`. Joined, the two are
 *  `runsAtLine`. */
export function runsAtParts(known: KnownSettings): { rest: string; access: string } {
  const rest = [known.model?.toLowerCase(), known.effort?.toLowerCase()].filter((part): part is string => !!part).join(" · ");
  return { rest, access: known.access ? `${rest ? " · " : ""}${known.access}` : "" };
}

/** What this chat runs at, a row each and whole, for the composer's
 *  disclosure: the values as their pickers name them. A value the page does
 *  not know of this chat has no row. */
export function runsAtRows(known: KnownSettings): { label: "Model" | "Effort" | "Access"; value: string }[] {
  const rows: { label: "Model" | "Effort" | "Access"; value: string | undefined }[] = [
    { label: "Model", value: known.model },
    { label: "Effort", value: known.effort },
    { label: "Access", value: known.access },
  ];
  return rows.filter((row): row is { label: "Model" | "Effort" | "Access"; value: string } => !!row.value);
}

/** The last turn's receipt, a line each, for a tooltip: how long it took and
 *  what it cost. Both arrive with the agent's `result`; a figure that has
 *  not arrived has no line. */
export function receiptLines(lastDurationMs?: number, lastCostUsd?: number): string[] {
  return [
    lastDurationMs !== undefined ? `Last turn · ${(lastDurationMs / 1000).toFixed(1)}s` : "",
    lastCostUsd !== undefined ? `Cost · $${lastCostUsd.toFixed(3)}` : "",
  ].filter(Boolean);
}
