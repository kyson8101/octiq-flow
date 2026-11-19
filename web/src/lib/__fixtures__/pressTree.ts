// Press a component's real handlers without a DOM.
//
// The suite runs in node with no jsdom, and `react-dom/server` draws markup
// with no handlers in it. A control that starts, stops or deletes something
// is tested by what pressing it SENDS, so this calls the component function
// itself, with the hooks it uses answered by plain stand-ins, and hands back
// the element tree: the test finds the real `<button>`, calls its real
// `onClick` / `onKeyDown` with a fake event and checks what went out.
//
// Used with a hoisted mock of "react" in the test file:
//
//   vi.mock("react", async (original) =>
//     (await import("./__fixtures__/pressTree")).withStubbedHooks(await original<typeof import("react")>()));
//
// Limits, said so a test does not lean on them: effects never run, state is
// what the test says it is (`state`) and a setter only records the call
// (`sets`), and a child component is not drawn, only returned as an element
// whose props the test may call.
import type { ReactElement, ReactNode } from "react";
import { vi } from "vitest";

type Slot = { index: number };
const slot: Slot = { index: 0 };
let initial: Record<number, unknown> = {};
export const sets: { index: number; value: unknown }[] = [];

export function withStubbedHooks<T extends object>(actual: T): T {
  return {
    ...actual,
    useState: (init: unknown) => {
      const index = slot.index++;
      const value = index in initial ? initial[index] : typeof init === "function" ? (init as () => unknown)() : init;
      return [value, (next: unknown) => { sets.push({ index, value: next }); }];
    },
    useId: () => ":id:",
    useRef: (value: unknown) => ({ current: value }),
    useEffect: () => {},
    useLayoutEffect: () => {},
    useMemo: (make: () => unknown) => make(),
    useCallback: (fn: unknown) => fn,
    useSyncExternalStore: (_subscribe: unknown, read: () => unknown) => read(),
  } as T;
}

/** What a component function answers for these props. `state` says what its
 *  `useState` calls hold, by the order they are made in. */
export function draw<P>(component: (props: P) => ReactNode, props: P, state: Record<number, unknown> = {}): ReactNode {
  slot.index = 0;
  initial = state;
  sets.length = 0;
  return component(props);
}

type Props = Record<string, unknown> & { children?: ReactNode };
const isElement = (node: unknown): node is ReactElement<Props> => typeof node === "object" && node !== null && "props" in node;

/** Every element of a tree, a child component's element included (and not
 *  drawn). */
export function elements(node: ReactNode): ReactElement<Props>[] {
  if (Array.isArray(node)) return node.flatMap(elements);
  if (!isElement(node)) return [];
  return [node, ...elements(node.props.children)];
}

/** The one host element of a tree with this `aria-label`. */
export function byLabel(tree: ReactNode, label: string, tag = "button"): ReactElement<Props> {
  const found = elements(tree).filter((element) => element.type === tag && element.props["aria-label"] === label);
  if (found.length !== 1) throw new Error(`expected one <${tag}> labelled "${label}", found ${found.length}`);
  return found[0];
}

/** The one button whose only child is this text (a gate's option). */
export function byText(tree: ReactNode, text: string): ReactElement<Props> {
  const found = elements(tree).filter((element) => element.type === "button" && element.props.children === text);
  if (found.length !== 1) throw new Error(`expected one <button> reading "${text}", found ${found.length}`);
  return found[0];
}

/** The one host element of this tag. */
export function byTag(tree: ReactNode, tag: string): ReactElement<Props> {
  const found = elements(tree).filter((element) => element.type === tag);
  if (found.length !== 1) throw new Error(`expected one <${tag}>, found ${found.length}`);
  return found[0];
}

/** The aria-labels of every button in a tree, in order. */
export function buttonLabels(tree: ReactNode): string[] {
  return elements(tree).filter((element) => element.type === "button").map((element) => String(element.props["aria-label"]));
}

/** The first child component of this function in a tree. */
export function childOf<P>(tree: ReactNode, component: (props: P) => unknown): ReactElement<P & Props> {
  const found = elements(tree).find((element) => element.type === component);
  if (!found) throw new Error(`no <${component.name}> in the tree`);
  return found as unknown as ReactElement<P & Props>;
}

type Handler = ((event: never) => unknown) | undefined;

/** A pointer click, as a handler gets it. `detail` 0 is a key's click. */
export function click(over: Partial<{ detail: number; clientX: number; clientY: number }> = {}) {
  return { detail: 1, clientX: 10, clientY: 10, currentTarget: { contains: () => false }, preventDefault: vi.fn(), stopPropagation: vi.fn(), ...over };
}

/** A key, as `onKeyDown` gets it. */
export function key(name: string, repeat = false) {
  return { key: name, repeat, preventDefault: vi.fn(), stopPropagation: vi.fn() };
}

/** Press a control the way a pointer does, and answer whether it did not
 *  refuse (called `preventDefault`). A control with no `onClick` does nothing. */
export function press(element: ReactElement<Props>, event = click()) {
  (element.props.onClick as Handler)?.(event as never);
  return event;
}

/** Hold a key on a control, and whether its `onKeyDown` dropped the repeat. */
export function hold(element: ReactElement<Props>, name = "Enter") {
  const event = key(name, true);
  (element.props.onKeyDown as Handler)?.(event as never);
  return event.preventDefault.mock.calls.length > 0;
}
