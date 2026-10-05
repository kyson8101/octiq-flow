import { bridge } from "./bridge";

/** The person's own preferences (personal_preferences.rs): text every agent
 *  chat OctiqFlow starts ends its system prompt with. */
export type PersonalPreferences = { text: string; updatedAt: number };

/** The host's cap, in characters (`personal_preferences::MAX_CHARS`). */
export const PERSONAL_PREFERENCES_MAX = 4000;

export async function loadPersonalPreferences(): Promise<PersonalPreferences> {
  return (await bridge.invoke<PersonalPreferences>("personal_preferences", {})) ?? { text: "", updatedAt: 0 };
}

export async function savePersonalPreferences(text: string): Promise<PersonalPreferences> {
  return await bridge.invoke<PersonalPreferences>("personal_preferences_set", { text });
}
