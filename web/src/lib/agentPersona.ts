// Agents mode: WHO a conversation is with, as the person registered them.
//
// A chat handed to a registered agent speaks as that agent — its name and its
// picture — wherever the app would otherwise say "Claude" or "Codex". The
// provider and model are settings of the agent, shown in details, never the
// voice. Identity is the registration's id, so a rename or a change of model
// moves every label at once, and a removed agent keeps the name it was
// handed the work under.
//
// Pure, so every fallback is a test: an ordinary chat and a chat from before
// agents mode have no persona and keep exactly the labels they always had.
import type { LeadRecord } from "./agentsDashboard";

export type PersonaAgent = {
  id: string;
  name: string;
  role?: string;
  avatar?: string;
  agent?: string;
  model?: string;
};

export type Persona = {
  /** The registration, when it still exists. */
  id?: string;
  name: string;
  role?: string;
  /** A checked `data:` URL, or absent for the initials tile. */
  avatar?: string;
  /** The registration is gone; the conversation keeps the name it had. */
  removed?: boolean;
};

/** Who a chat belongs to: the lead it was handed to, or — for a worker chat —
 *  the assignee of the task it runs. `null` for an ordinary chat. */
export function personaFor(
  chatKey: string | null | undefined,
  leads: readonly LeadRecord[],
  roster: readonly PersonaAgent[],
  workerAssignees?: ReadonlyMap<string, { id: string; name: string }>,
): Persona | null {
  if (!chatKey) return null;
  const record = leads.find((lead) => lead.chatKey === chatKey);
  const handed = record
    ? { id: record.leadId, name: record.leadName }
    : workerAssignees?.get(chatKey);
  if (!handed) return null;
  const agent = roster.find((candidate) => candidate.id === handed.id);
  if (!agent) return { name: handed.name, removed: true };
  return {
    id: agent.id,
    name: agent.name,
    ...(agent.role ? { role: agent.role } : {}),
    ...(agent.avatar ? { avatar: agent.avatar } : {}),
  };
}

/** Up to two letters for the fallback tile: "Potato Juice" → "PJ". */
export function personaInitials(name: string): string {
  const words = name.trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return "?";
  const letters = words.length === 1
    ? [...words[0]].slice(0, 2)
    : [[...words[0]][0], [...words[words.length - 1]][0]];
  return letters.join("").toLocaleUpperCase();
}

/** A stable hue per agent, so the same initials tile is the same colour on
 *  every screen and after every reload. */
export function personaHue(key: string): number {
  let hash = 0;
  for (const char of key) hash = (hash * 31 + (char.codePointAt(0) ?? 0)) >>> 0;
  return hash % 360;
}

/** The name over a reply: the persona's, else the provider's (the label an
 *  ordinary chat has always had). */
export function senderName(persona: Persona | null | undefined, providerName: string): string {
  return persona?.name || providerName;
}

/** A chat's title when it has none of its own yet. A title the person chose,
 *  or one the agent or the first message gave it, always wins. */
export function personaTitle(
  title: string | undefined,
  persona: Persona | null | undefined,
  fallback: string,
): string {
  const own = title?.trim();
  if (own) return own;
  return persona ? `Conversation with ${persona.name}` : fallback;
}

/** "Message Maya…", or the provider prompt an ordinary chat keeps. */
export function composerPlaceholder(persona: { name: string } | null | undefined, providerName: string): string {
  return persona ? `Message ${persona.name}…` : `Ask ${providerName} to…`;
}
