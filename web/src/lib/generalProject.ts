import { projectSlug } from "./projectSlug";

export const GENERAL_PROJECT_NAME = "General";

export type GeneralProject = {
  id: string;
  name: string;
  primary_path?: string;
  shelved?: boolean;
};

type Invoke = (command: string, args?: Record<string, unknown>) => Promise<unknown>;

export type GeneralProjectResult<T extends GeneralProject> = {
  project: T;
  active: T[];
  shelved: T[];
};

/** Find or lazily create the persisted fallback workspace for unbound tasks.
 *
 * Creation is race-safe across clients: if another device wins the name first,
 * read the shared list back and use that same project. A shelved General is
 * restored because it is the explicit fallback destination. */
export async function ensureGeneralProject<T extends GeneralProject>(
  active: readonly T[],
  shelved: readonly T[],
  invoke: Invoke,
): Promise<GeneralProjectResult<T>> {
  const isGeneral = (project: T) => projectSlug(project.name) === "general";
  const current = active.find(isGeneral);
  if (current) return { project: current, active: [...active], shelved: [...shelved] };

  const away = shelved.find(isGeneral);
  if (away) {
    await invoke("set_workspace_shelved", { id: away.id, shelved: false });
    const restored = { ...away, shelved: false };
    return {
      project: restored,
      active: active.some((project) => project.id === away.id)
        ? [...active]
        : [...active, restored],
      shelved: shelved.filter((project) => project.id !== away.id),
    };
  }

  try {
    const created = (await invoke("add_workspace", {
      name: GENERAL_PROJECT_NAME,
      // The backend resolves an empty project path to the person's home.
      primaryPath: "",
    })) as T;
    return { project: created, active: [...active, created], shelved: [...shelved] };
  } catch (error) {
    const listed = (await invoke("list_workspaces")) as T[];
    const found = listed.find(isGeneral);
    if (!found) throw error;
    if (found.shelved) {
      await invoke("set_workspace_shelved", { id: found.id, shelved: false });
    }
    const restored = { ...found, shelved: false };
    return {
      project: restored,
      active: [
        ...listed.filter((project) => !project.shelved && project.id !== found.id),
        restored,
      ],
      shelved: listed.filter((project) => project.shelved && project.id !== found.id),
    };
  }
}
