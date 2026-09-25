// The registered agents, for the places that name one by id — a task's
// assignee, a plan row — so they can draw its face without each asking the
// server. App provides it; outside agents mode it is empty, and those places
// keep the provider mark they always had.
import { createContext, useContext } from "react";
import type { Persona, PersonaAgent } from "./agentPersona";

export const AgentRosterContext = createContext<readonly PersonaAgent[]>([]);

/** Who a chat (by key) belongs to, for lists that show many chats at once.
 *  Answers null for an ordinary chat, and always outside agents mode. */
export const ChatPersonaContext = createContext<(chatKey: string) => Persona | null>(() => null);

/** The registered agent with this id, when there is one. */
export function useRosterAgent(id: string | undefined): PersonaAgent | undefined {
  const roster = useContext(AgentRosterContext);
  return id ? roster.find((agent) => agent.id === id) : undefined;
}
