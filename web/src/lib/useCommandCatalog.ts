import { useCallback, useEffect, useRef, useState } from "react";
import { bridge } from "./bridge";
import { modelFromId, parseCommandCache, type CommandCache, type Provider } from "./agentProviders";
import type { ChatState } from "./chat";
import { remember } from "./remember";

const CMDS_KEY = "octiq.v2.commands";

export function useCommandCatalog({
  chats,
  meta,
  agent,
  projectId,
  project,
}: {
  chats: Record<string, ChatState>;
  meta: { current: Record<string, { projectId: string; modelId: string }> };
  agent: Provider;
  projectId: string | null;
  project: { primary_path?: string } | null;
}): {
  commands: CommandCache;
  codexSkillsStatus: Record<string, string>;
  loadCodexSkills: (force?: boolean) => void;
} {
  // The commands a session reports at startup, kept per PROJECT AND PROVIDER.
  // A provider owns its command syntax: Claude's `/compact` must not show up
  // after the same project is switched to Codex (or a future provider).
  const [commands, setCommands] = useState<CommandCache>(() => {
    try {
      return parseCommandCache(JSON.parse(localStorage.getItem(CMDS_KEY) || "{}"));
    } catch {
      return {};
    }
  });
  /** Codex has no command catalog in its exec stream. Remember which projects
   * this page has already asked its app-server about, while still refreshing
   * once after a browser reload even when localStorage can draw an old list. */
  const codexSkillsLoaded = useRef(new Set<string>());
  const codexSkillsPending = useRef(new Set<string>());
  const [codexSkillsStatus, setCodexSkillsStatus] = useState<Record<string, string>>({});

  // Claude's command list comes from the session's startup announcement and is
  // cached per provider from then on. Codex has no corresponding exec event;
  // `loadCodexSkills` below fills its side lazily from the app-server instead.
  // Read startup lists from every loaded chat, not only the visible one — a
  // chat working in the background is just as good a source.
  useEffect(() => {
    setCommands((prev) => {
      let next = prev;
      for (const [id, s] of Object.entries(chats)) {
        const pid = meta.current[id]?.projectId;
        const agent = modelFromId(meta.current[id]?.modelId ?? null)?.agent;
        if (!pid || !agent || !s.commands?.length) continue;
        const before = prev[pid]?.[agent];
        if (before?.length === s.commands.length && before.every((command, i) => command === s.commands![i])) {
          continue;
        }
        next = { ...next, [pid]: { ...next[pid], [agent]: s.commands } };
      }
      if (next === prev) return prev;
      remember(CMDS_KEY, JSON.stringify(next));
      return next;
    });
  }, [chats]);

  const loadCodexSkills = useCallback((force = false) => {
    if (agent !== "codex" || !projectId || !project?.primary_path) return;
    const key = `${projectId}:codex`;
    if (codexSkillsPending.current.has(key) || (!force && codexSkillsLoaded.current.has(key))) return;
    codexSkillsLoaded.current.add(key);
    codexSkillsPending.current.add(key);
    setCodexSkillsStatus((previous) => ({ ...previous, [key]: "loading" }));

    bridge
      .invoke<unknown>("codex_skills", { cwd: project.primary_path })
      .then((value) => {
        const skills = Array.isArray(value)
          ? value.filter((skill): skill is string => typeof skill === "string")
          : [];
        setCommands((previous) => {
          const next = {
            ...previous,
            [projectId]: { ...previous[projectId], codex: skills },
          };
          remember(CMDS_KEY, JSON.stringify(next));
          return next;
        });
      })
      .then(() => {
        setCodexSkillsStatus((previous) => ({ ...previous, [key]: "" }));
      })
      .catch(() => {
        setCodexSkillsStatus((previous) => ({ ...previous, [key]: "Could not load skills. Try again." }));
        // A reconnect or a newly installed Codex should get another chance the
        // next time the slash menu is opened.
        codexSkillsLoaded.current.delete(key);
      })
      .finally(() => codexSkillsPending.current.delete(key));
  }, [agent, project, projectId]);

  return { commands, codexSkillsStatus, loadCodexSkills };
}
