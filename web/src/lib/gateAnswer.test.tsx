// A gate's answer is the person's decision the moment it is sent, and it
// has no question in front of it. So the controls that send one are guarded
// where they stand, and the page sends the person's own door only for a gate
// that waits on the person.
//
// What is tested here: the pure guards, which door a gate gets, what the
// panel draws for the host's own ledgers, and a scan of the panel for an
// answer sent without the guards. What a browser does with a real pointer
// and a real held key is `scripts/test-quiet-failures.mjs` (its gate
// section), which presses.
import { afterEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import actionsSourceRaw from "./runDecisionActions.ts?raw";
import chatSourceRaw from "../components/ChatRunDecisionCards.tsx?raw";
import panelSourceRaw from "../components/OrchestrationPanel.tsx?raw";
import newRunSourceRaw from "../components/NewRun.tsx?raw";
import runSummarySourceRaw from "../components/RunSummaryParts.tsx?raw";
import { lf } from "./sourceText";

// Read with one kind of line end, so a pattern may name `\n` on a CRLF checkout too.
const panelSource = lf([panelSourceRaw, newRunSourceRaw, runSummarySourceRaw, actionsSourceRaw, chatSourceRaw].join("\n"));

vi.mock("./bridge", () => ({
  bridge: { invoke: async () => null, on: () => () => {}, onState: () => () => {} },
}));

import { hostFacts } from "./__fixtures__/hostFacts";
import { STRAY_MS, STRAY_RADIUS } from "./cardFold";
import { gateFlight, IN_FLIGHT, inFlight, once } from "./inFlight";
import { gateDoor, type OrchestrationSnapshot } from "./orchestration";
import { dropHeld, strayOnto } from "./pressGuard";
import { GATE_DOOR_NOTE, OrchestrationPanel } from "../components/OrchestrationPanel";

afterEach(() => vi.useRealTimers());

const panel = (snapshot: OrchestrationSnapshot) => {
  vi.useFakeTimers();
  vi.setSystemTime(Math.max(...snapshot.tasks.map((task) => task.updatedAt)) + 5_000);
  const run = snapshot.runs[0];
  return renderToStaticMarkup(<OrchestrationPanel embedded allowManualRun={false} project={{ id: run.workspaceId, name: "Project" }}
    coordinatorKey={run.coordinatorChatKey} initialSnapshot={snapshot} onOpenChat={() => {}} onClose={() => {}} />);
};
/** The box under one heading of the panel, up to the next heading or the tabs. */
const box = (html: string, heading: "Needs you" | "Open decisions") => {
  const from = html.indexOf(`>${heading}</h3>`);
  if (from < 0) return "";
  const rest = html.slice(from + heading.length);
  const ends = [rest.indexOf("</h3>", 8), rest.indexOf('class="orch-tabs-row"')].filter((at) => at >= 0);
  return rest.slice(0, Math.min(...ends));
};
const buttons = (html: string) => [...html.matchAll(/<button[^>]*>([\s\S]*?)<\/button>/g)].map((match) => match[0]);

describe("a press on a control that answers where it stands", () => {
  const at = 10_000;
  const prior = { x: 400, y: 300, at };

  it("is dropped when it repeats a press just made on something else", () => {
    expect(strayOnto(prior, { x: 400, y: 300, at: at + 40, detail: 1 }, false)).toBe(true);
    // The second click of a double click, in the same spot.
    expect(strayOnto(prior, { x: 402, y: 301, at: at + 120, detail: 2 }, false)).toBe(true);
    expect(strayOnto(prior, { x: 400 + STRAY_RADIUS, y: 300, at: at + STRAY_MS, detail: 1 }, false)).toBe(true);
  });

  it("goes through when the pointer moved, when it was made later, or with no press before it", () => {
    expect(strayOnto(prior, { x: 400 + STRAY_RADIUS + 1, y: 300, at: at + 40, detail: 1 }, false)).toBe(false);
    expect(strayOnto(prior, { x: 400, y: 300, at: at + STRAY_MS + 1, detail: 1 }, false)).toBe(false);
    expect(strayOnto(null, { x: 400, y: 300, at, detail: 1 }, false)).toBe(false);
  });

  it("goes through when the press before it was on the control itself, and from the keyboard", () => {
    // The person's own second press: what is in flight decides that one.
    expect(strayOnto(prior, { x: 400, y: 300, at: at + 40, detail: 1 }, true)).toBe(false);
    // Tab to the control and Enter has no spot.
    expect(strayOnto(prior, { x: 0, y: 0, at: at + 40, detail: 0 }, false)).toBe(false);
  });

  it("answers nothing for the repeats of a held Enter or Space", () => {
    for (const key of ["Enter", " ", "Spacebar"]) {
      const held = { key, repeat: true, preventDefault: vi.fn() };
      dropHeld(held);
      expect(held.preventDefault, key).toHaveBeenCalledTimes(1);
      const pressed = { key, repeat: false, preventDefault: vi.fn() };
      dropHeld(pressed);
      expect(pressed.preventDefault, key).not.toHaveBeenCalled();
    }
  });
});

describe("a request that is out", () => {
  it("is one request for a key until it is answered, however it is asked again", async () => {
    let answer!: (value: string) => void;
    const sends = vi.fn(() => new Promise<string>((resolve) => { answer = resolve; }));
    const key = gateFlight("gate_once");
    const first = once(key, sends);
    expect(inFlight(key)).toBe(true);
    // A second press, a second control, a panel drawn again: nothing is sent.
    expect(await once(key, sends)).toBe(IN_FLIGHT);
    expect(await once(key, sends)).toBe(IN_FLIGHT);
    expect(sends).toHaveBeenCalledTimes(1);
    // Another gate is another request.
    expect(inFlight(gateFlight("gate_other"))).toBe(false);
    answer("done");
    expect(await first).toBe("done");
    expect(inFlight(key)).toBe(false);
    // Answered, the next press is a new request.
    const again = once(key, sends);
    answer("again");
    expect(await again).toBe("again");
    expect(sends).toHaveBeenCalledTimes(2);
  });

  it("is let go when the request fails", async () => {
    const key = gateFlight("gate-fails");
    await expect(once(key, async () => { throw new Error("refused"); })).rejects.toThrow("refused");
    expect(inFlight(key)).toBe(false);
  });
});

describe("where a gate's answer goes", () => {
  it("is the person's door only for a failure's gate or a peer request's that waits on the person", () => {
    const escalated = hostFacts.failureEscalated();
    const [gate] = escalated.gates;
    expect(gate).toMatchObject({ awaits: "person", aboutTaskId: escalated.tasks[0].id });
    expect(gateDoor(gate, escalated.tasks, true)).toBe("person");
    // The same gate where the reading does not call it the person's: a
    // message to the coordinator, never the person's decision.
    expect(gateDoor(gate, escalated.tasks, false)).toBe("chat");

    const peer = hostFacts.peerGate();
    expect(gateDoor(peer.gates[0], peer.tasks, true)).toBe("person");
    // No agent may answer a peer request: with it not the person's there is
    // nobody to send to.
    expect(gateDoor(peer.gates[0], peer.tasks, false)).toBe("none");

    // An ordinary gate goes to the coordinator's chat, the person's or not.
    const open = hostFacts.gatesOpen();
    for (const ordinary of open.gates) {
      expect(gateDoor(ordinary, open.tasks, true)).toBe("chat");
      expect(gateDoor(ordinary, open.tasks, false)).toBe("chat");
    }
  });

  it("is drawn as that door, with every control guarded and the door said in words", () => {
    const html = panel(hostFacts.failureEscalated());
    const mine = box(html, "Needs you");
    expect(buttons(mine).map((button) => (/aria-label="([^"]+)"/.exec(button)?.[1] ?? button.replace(/<[^>]+>/g, "")))).toEqual(["Start it again", "Leave it", "Answer"]);
    for (const button of buttons(mine)) expect(button).toContain('class="orch-gate-answer"');
    // Nothing is written yet, so the written answer is off: said, not removed.
    expect(buttons(mine)[2]).toContain('aria-disabled="true"');
    expect(buttons(mine)[0]).not.toContain("aria-disabled");
    expect(mine).not.toMatch(/<button[^>]* disabled=""/);
    expect(mine).toContain(`>${GATE_DOOR_NOTE.person.mine}</p>`);
    expect(box(html, "Open decisions")).toBe("");
  });

  it("offers no person's answer under Open decisions, and says where the words go", () => {
    // Changed for this test, as the reviewer changed it: the host's own
    // gate about a failed task, said to wait on the coordinator.
    const snapshot = hostFacts.failureEscalated();
    snapshot.gates[0].awaits = "coordinator";
    const html = panel(snapshot);
    const others = box(html, "Open decisions");
    expect(others).not.toBe("");
    expect(buttons(others).map((button) => (/aria-label="([^"]+)"/.exec(button)?.[1] ?? button.replace(/<[^>]+>/g, "")))).toEqual(["Start it again", "Leave it", "Send to main chat"]);
    expect(others).not.toContain("aria-label=\"Answer\"");
    expect(others).toContain(`>${GATE_DOOR_NOTE.chat.others}</p>`);

    // The host's own ledger with a worker's gate that waits on its coordinator.
    const open = panel(hostFacts.gatesOpen());
    expect(box(open, "Open decisions")).toContain(`>${GATE_DOOR_NOTE.chat.others}</p>`);
    expect(box(open, "Open decisions")).not.toContain("aria-label=\"Answer\"");
    expect(box(open, "Needs you")).toContain(`>${GATE_DOOR_NOTE.chat.mine}</p>`);

    // A peer request's gate that does not wait on the person: no control.
    const peer = hostFacts.peerGate();
    peer.gates[0].awaits = "nobody";
    const none = box(panel(peer), "Open decisions");
    expect(none).toContain(`>${GATE_DOOR_NOTE.none.others}</p>`);
    expect(buttons(none)).toEqual([]);
    expect(none).not.toContain("<input");
  });
});

/** A component of the panel's file: from its `function Name(` to the next
 *  thing declared at the start of a line. */
function local(source: string, name: string): string {
  const at = source.search(new RegExp(`^(?:export )?(?:async )?function ${name}\\(`, "m"));
  if (at < 0) return "";
  const rest = source.slice(at + 1);
  const end = rest.search(/^(?:export )?(?:async function|function|const|type) /m);
  return source.slice(at, end < 0 ? undefined : at + 1 + end);
}

/** Ways a gate's answer could be sent from somewhere the behaviour tests do
 *  not press (`components/OrchestrationPanel.controls.test.tsx` presses
 *  `GateAnswer` and `resolveRunGate`): a second sender of the person's door,
 *  or the gate's controls drawn outside the one component. Empty when there
 *  is none. No count is pinned: the rule is that nothing else exists. */
function strayGateSenders(source: string): string[] {
  const problems: string[] = [];
  const answer = local(source, "GateAnswer");
  if (!answer) return ["no GateAnswer component"];
  const outside = source.replace(answer, "");
  const sender = local(source, "resolveRunGate");
  if (!sender.includes('"orchestration_gate_resolve"')) problems.push("the person's door is not sent by resolveRunGate");
  if (source.replace(sender, "").includes('"orchestration_gate_resolve"')) problems.push("the person's door is sent outside resolveRunGate");
  if (/\bonResolve\(/.test(outside)) problems.push("onResolve is called outside GateAnswer");
  if (/className="orch-gate-(options|write)"/.test(outside)) problems.push("a gate's controls are drawn outside GateAnswer");
  return problems;
}

describe("every control that answers a gate", () => {
  it("is drawn by the one component, and the person's door has one sender", () => {
    expect(strayGateSenders(panelSource)).toEqual([]);
  });

  it("fails that scan for a second sender, or controls drawn outside the component", () => {
    const mutate = (from: string, to: string) => {
      const next = panelSource.replace(from, to);
      expect(next, from).not.toBe(panelSource);
      return strayGateSenders(next);
    };
    expect(mutate('<p className="orch-gate-door" id={noteId}>{note}</p>', '<p className="orch-gate-door" id={noteId}>{note}</p><button onClick={() => void bridge.invoke("orchestration_gate_resolve", {})}>Answer</button>'))
      .toEqual([expect.stringContaining("outside resolveRunGate")]);
    expect(mutate("{!readOnly && <GateAnswer gate={gate}", '{!readOnly && <div className="orch-gate-options"><button onClick={() => onResolve(gate, "x", "person")}>x</button></div>}{!readOnly && <GateAnswer gate={gate}'))
      .toEqual(expect.arrayContaining([expect.stringContaining("onResolve is called outside GateAnswer"), expect.stringContaining("drawn outside GateAnswer")]));
  });
});
