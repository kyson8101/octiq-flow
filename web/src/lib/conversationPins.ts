// Small, durable bookmarks into a conversation.
//
// A pin keeps the words it was made from as well as the turn it came from. The
// words make the sidebar useful on their own; the turn id makes the label a way
// back to the full surrounding conversation.

export type ConversationPin = {
  id: string;
  /** A compact, scannable name made from the opening of the selected passage. */
  label: string;
  /** The selected passage, kept so it still reads when its source is offscreen. */
  text: string;
  /** The first turn touched by the selection — the place a sidebar click returns to. */
  turnId: string;
  createdAt: number;
};

/** A pin is a reference, not a second copy of a whole transcript. */
const MAX_TEXT = 12_000;
const MAX_LABEL = 52;

type NewConversationPin = {
  text: string;
  turnId: string;
  /** Supplied by tests and migrations; normally generated in the browser. */
  id?: string;
  createdAt?: number;
};

/** Make a pin from a browser selection. */
export function newConversationPin({
  text,
  turnId,
  id = pinId(),
  createdAt = Date.now(),
}: NewConversationPin): ConversationPin {
  const kept = pinText(text);
  return { id, label: pinLabel(kept), text: kept, turnId: turnId.trim(), createdAt };
}

/** Add a passage once. Selecting the same words twice should not grow a second
 * identical bookmark, while two different passages in one reply remain fully
 * independent pins. */
export function appendConversationPin(
  pins: readonly ConversationPin[],
  pin: ConversationPin,
): ConversationPin[] {
  return pins.some((held) => held.turnId === pin.turnId && held.text === pin.text)
    ? [...pins]
    : [...pins, pin];
}

/** Read old or untrusted browser storage without letting one bad pin spoil the
 * rest of a saved conversation. */
export function readConversationPins(raw: unknown): ConversationPin[] {
  if (!Array.isArray(raw)) return [];
  const out: ConversationPin[] = [];
  const seen = new Set<string>();

  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const row = item as {
      id?: unknown;
      label?: unknown;
      text?: unknown;
      turnId?: unknown;
      createdAt?: unknown;
    };
    const id = typeof row.id === "string" ? row.id.trim() : "";
    const turnId = typeof row.turnId === "string" ? row.turnId.trim() : "";
    const text = typeof row.text === "string" ? pinText(row.text) : "";
    if (!id || !turnId || !text || seen.has(id)) continue;
    seen.add(id);

    const proposed = typeof row.label === "string" ? row.label : "";
    const label = normaliseLabel(proposed) || pinLabel(text);
    const createdAt =
      typeof row.createdAt === "number" && Number.isFinite(row.createdAt) && row.createdAt >= 0
        ? row.createdAt
        : 0;
    out.push({ id, label, text, turnId, createdAt });
  }

  return out;
}

/** A label is deliberately the first thought, not a generated summary: making
 * a pin should be one click, and the selected words are already the user’s
 * language for the thing they wanted to remember. */
export function pinLabel(text: string): string {
  const flat = text.replace(/\s+/g, " ").trim();
  if (!flat) return "Pinned passage";
  return cut(flat, MAX_LABEL);
}

function pinText(raw: string): string {
  const clean = raw.replace(/\r\n?/g, "\n").trim();
  if (clean.length <= MAX_TEXT) return clean;
  return `${clean.slice(0, MAX_TEXT).trimEnd()}\n…`;
}

function normaliseLabel(raw: string): string {
  const clean = raw.replace(/\s+/g, " ").trim();
  return clean ? cut(clean, MAX_LABEL) : "";
}

function cut(text: string, limit: number): string {
  return text.length <= limit ? text : `${text.slice(0, limit).trimEnd()}…`;
}

function pinId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return `pin-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}
