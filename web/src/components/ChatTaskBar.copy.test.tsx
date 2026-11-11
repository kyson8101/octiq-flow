import { Children, isValidElement, type ReactElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, expect, it, vi } from "vitest";

// Run the actual field and async click handler in the node test environment.
const hooks = vi.hoisted(() => ({ value: "idle" as unknown }));
vi.mock("react", async (original) => ({
  ...await original<typeof import("react")>(),
  useRef: (current: unknown) => ({ current }),
  useCallback: (callback: unknown) => callback,
  useLayoutEffect: () => {},
  useState: () => [hooks.value, (value: unknown) => { hooks.value = value; }],
}));
vi.mock("../lib/useArrival", () => ({ useEntry: () => "ready", entryClass: () => "" }));
vi.mock("../lib/bridge", () => ({ bridge: { invoke: vi.fn(), on: vi.fn(() => () => {}) } }));
vi.mock("../lib/clipboard", () => ({ copyText: vi.fn() }));
import { copyText } from "../lib/clipboard";
import { ChatTaskBarView } from "./ChatTaskBar";

type Props = Record<string, any>;
function nodes(node: ReactNode): ReactElement<Props>[] {
  return Children.toArray(node).flatMap(child => isValidElement(child)
    ? [child as ReactElement<Props>, ...nodes((child.props as Props).children)] : []);
}
function field() {
  const tree = ChatTaskBarView({ status: { chatId: "c1", workspace: {
    cwd: "/repo/task", exists: true, isRepo: true, repoRoot: "/repo/task", primaryRoot: "/repo",
    branch: "feature/task", isWorktree: true, changed: 0, ahead: 0, behind: 0, hasUpstream: false,
  } }, open: true, now: 0, onToggle: () => {} });
  const panel = nodes(tree).find(node => typeof node.type === "function" && node.type.name === "ChatTaskPanel")!;
  const fields = nodes((panel.type as (props: Props) => ReactNode)(panel.props));
  const env = fields.find(node => typeof node.type === "function" && node.type.name === "EnvField" && node.props.row.path)!;
  return () => (env.type as (props: Props) => ReactNode)(env.props);
}
afterEach(() => { vi.useRealTimers(); vi.clearAllMocks(); });
it.each([true, false])("shows the real path copy result when clipboard success is %s, then resets", async success => {
  vi.useFakeTimers(); hooks.value = "idle";
  vi.mocked(copyText).mockResolvedValue(success);
  const render = field();
  const button = nodes(render()).find(node => node.type === "button")!;
  expect(button.props["aria-label"]).toMatch(/^Copy .* path$/);
  expect(button.props.title).toMatch(/^Copy \/repo/);
  await button.props.onClick();
  expect(copyText).toHaveBeenCalledWith(expect.stringMatching(/^\/repo/));
  const html = renderToStaticMarkup(render());
  const result = success ? "Path copied" : "Could not copy path";
  expect(html).toContain(`aria-label="${result}"`);
  expect(html).toContain(`title="${result}"`);
  expect(html).toContain(`data-action-icon="${success ? "allow" : "copy"}"`);
  vi.advanceTimersByTime(1600);
  expect(nodes(render()).find(node => node.type === "button")!.props["aria-label"]).toMatch(/^Copy .* path$/);
});
