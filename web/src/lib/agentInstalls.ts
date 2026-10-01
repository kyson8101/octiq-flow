import { bridge } from "./bridge";
import type { Provider } from "./agentProviders";

/** One agent the app can start, as the backend reports it. */
export type AgentInstall = {
  /** The id the chat backend takes — also the command: "claude" / "codex". */
  id: Provider;
  /** What the CLI is called on screen. */
  name: string;
  /** The command that starts it. */
  bin: string;
  installed: boolean;
  /** Where the login shell found it. Absent when it is missing — and also when
   *  it is installed but the path could not be read, so `installed` is what the
   *  UI trusts, never the presence of this. */
  path?: string | null;
};

/** Ask the backend what this machine has. Its answer is cached there for a few
 *  minutes behind the login-shell probe, so calling this often is cheap —
 *  `refresh` is what makes it ask the shell again after installing an agent. */
export async function loadAgents(refresh = false): Promise<AgentInstall[]> {
  return await bridge.invoke<AgentInstall[]>("agent_installs", { refresh });
}
