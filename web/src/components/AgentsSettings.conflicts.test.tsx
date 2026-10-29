import { Children, isValidElement, type ReactElement, type ReactNode } from "react";
import { beforeEach, expect, it, vi } from "vitest";
import type { TeamAgent, TeamDraft } from "../lib/agentsMode";

// A small hook runner exercises the actual Settings component's state and
// async handlers in Vitest's node environment. Native DOM/focus/key behaviour
// is covered by test-agent-roles-mobile.mjs in the real App.
const hooks = vi.hoisted(() => ({ slots: [] as unknown[], cursor: 0, effects: false }));
vi.mock("react", async (original) => ({
  ...await original<typeof import("react")>(),
  useState: (initial: unknown) => {
    const index = hooks.cursor++;
    if (!(index in hooks.slots)) hooks.slots[index] = initial;
    return [hooks.slots[index], (value: unknown) => {
      hooks.slots[index] = typeof value === "function" ? value(hooks.slots[index]) : value;
    }];
  },
  useRef: (initial: unknown) => {
    const index = hooks.cursor++;
    if (!(index in hooks.slots)) hooks.slots[index] = { current: initial };
    return hooks.slots[index];
  },
  useMemo: (make: () => unknown) => make(),
  useEffect: (effect: () => unknown) => { if (!hooks.effects) effect(); },
}));
const bridge = vi.hoisted(() => ({ invoke: vi.fn(), changed: () => {} }));
vi.mock("../lib/bridge", () => ({ bridge: {
  invoke: bridge.invoke,
  on: (event: string, listener: () => void) => {
    if (event === "team-changed") bridge.changed = listener;
    return () => {};
  },
} }));
import { AgentsSettings, AgentDetailsDialog, RegisteredAgentsTable } from "./AgentsSettings";

type Props = Record<string, any>; // Component event props inspected without a DOM renderer.
function nodes(node: ReactNode): ReactElement<Props>[] {
  return Children.toArray(node).flatMap((child) => isValidElement(child)
    ? [child as ReactElement<Props>, ...nodes((child.props as Props).children)] : []);
}
function render() {
  hooks.cursor = 0;
  const tree = AgentsSettings({ on: true, onToggle: () => {}, projects: [] });
  hooks.effects = true;
  const all = nodes(tree);
  return {
    table: all.find((node) => node.type === RegisteredAgentsTable)?.props,
    modal: all.find((node) => node.type === AgentDetailsDialog)?.props,
    errors: all.filter((node) => node.props.role === "alert").map((node) => node.props.children),
    add: all.find((node) => node.props.children === "Add agent")?.props,
  };
}
const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0));
let host: TeamAgent;
let heldList: Promise<TeamAgent[]> | null;
const conflict = "Newest remote name was changed somewhere else while you were editing, so nothing was saved. The list now shows the latest; check it and save again.";
beforeEach(async () => {
  hooks.slots = []; hooks.cursor = 0; hooks.effects = false;
  heldList = null;
  host = { id: "papaya", name: "Papaya", role: "Old role", agent: "claude", model: "sonnet", access: "full", createdAt: 1, updatedAt: 10 };
  bridge.invoke.mockReset().mockImplementation(async (cmd, args) => {
    if (cmd === "team_list") {
      const held = heldList; heldList = null;
      return held ?? [structuredClone(host)];
    }
    if (cmd === "team_policy") return { text: "", updatedAt: 1 };
    if (cmd === "team_save") {
      if (args.expected !== undefined && args.expected !== host.updatedAt) throw new Error(conflict);
      host = { ...host, ...args.agent, updatedAt: host.updatedAt + 1 };
      return structuredClone(host);
    }
    return null;
  });
  render(); await flush();
});

it("modal sends its opening version while team-changed refresh is held; refusal retains text and retry uses the refreshed base", async () => {
  render().table!.onDetails(host);
  const modal = render().modal!;
  modal.onChange({ ...modal.draft, role: "My unsaved role", persistentPrompt: "My unsaved prompt" });
  let release!: (team: TeamAgent[]) => void;
  heldList = new Promise((resolve) => { release = resolve; });
  host = { ...host, name: "Newest remote name", access: "read", updatedAt: 11 };
  bridge.changed();
  await flush();
  render().modal!.onSave();
  await flush();
  expect(bridge.invoke).toHaveBeenCalledWith("team_save", expect.objectContaining({ expected: 10, agent: expect.objectContaining({ name: "Papaya", access: "full" }) }));
  let current = render();
  expect(current.modal!.error).toBe(conflict);
  expect(current.modal!.draft).toMatchObject({ role: "My unsaved role", persistentPrompt: "My unsaved prompt" });
  expect(host).toMatchObject({ name: "Newest remote name", access: "read", updatedAt: 11 });
  release([structuredClone(host)]); await flush();
  current = render();
  current.modal!.onSave(); await flush();
  expect(bridge.invoke).toHaveBeenLastCalledWith("team_list", { projectId: null, all: true });
  expect(bridge.invoke.mock.calls.filter(([cmd]) => cmd === "team_save").at(-1)?.[1]).toMatchObject({ expected: 11, agent: { name: "Newest remote name", access: "read", role: "My unsaved role", persistentPrompt: "My unsaved prompt" } });
  expect(render().modal).toBeUndefined();
  expect(host).toMatchObject({ name: "Newest remote name", access: "read", role: "My unsaved role" });
});

it("row sends the Edit version across refresh; refusal keeps the whole draft and permits an explicit retry", async () => {
  const original = structuredClone(host);
  render().table!.onDraft(original);
  render().table!.onDraft({ ...original, name: "My row draft" });
  host = { ...host, name: "Newest remote name", access: "read", updatedAt: 11 };
  bridge.changed(); await flush();
  render().table!.onSave(); await flush();
  expect(bridge.invoke).toHaveBeenCalledWith("team_save", expect.objectContaining({ expected: 10 }));
  expect(host).toMatchObject({ name: "Newest remote name", access: "read" });
  const refused = render();
  expect(refused.errors).toContain(conflict);
  expect(refused.table!.draft).toMatchObject({ name: "My row draft", access: "full" });
  refused.table!.onSave(); await flush();
  expect(bridge.invoke.mock.calls.filter(([cmd]) => cmd === "team_save").at(-1)?.[1]).toMatchObject({ expected: 11, agent: { name: "My row draft" } });
  expect(render().table!.draft).toBeNull();
  render().add!.onClick();
  const blank: TeamDraft = render().table!.draft;
  render().table!.onDraft({ ...blank, name: "New agent" });
  render().table!.onSave(); await flush();
  expect(bridge.invoke.mock.calls.filter(([cmd]) => cmd === "team_save").at(-1)?.[1]).not.toHaveProperty("expected");
});
