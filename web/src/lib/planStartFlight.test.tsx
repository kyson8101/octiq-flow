// One Start is out for a chat at a time, whatever becomes of the control
// that was pressed.
//
// The Plan panel unmounts when it is shut, and its control used to keep
// "a Start is out" in its own state: shut the panel on a Start the host had
// not answered, open it, and the new control sent the same Start again. The
// hold is the sender's now (`useChatPlan.askPlanStart`, `lib/inFlight`), by
// the chat. The sender is run here against a bridge that holds its first
// answer back, the way the reviewer's probe held it.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

type Call = { command: string; args: Record<string, unknown>; resolve: (value: unknown) => void; reject: (error: unknown) => void };
const calls: Call[] = [];

vi.mock("./bridge", () => ({
  bridge: {
    invoke: (command: string, args: Record<string, unknown>) => new Promise((resolve, reject) => { calls.push({ command, args, resolve, reject }); }),
    on: () => () => {},
    onState: () => () => {},
  },
}));

import { hostFacts } from "./__fixtures__/hostFacts";
import type { ChatPlan } from "./chatPlan";
import { IN_FLIGHT, inFlight, planFlight } from "./inFlight";
import { askPlanStart } from "./useChatPlan";
import { PlanPanel } from "../components/PlanPanel";

beforeEach(() => { calls.length = 0; });

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
const startButton = (html: string) => /<button type="button" class="cplan-start"[^>]*>[^<]*<\/button>/.exec(html)?.[0] ?? "";
const draw = (plan: ChatPlan, chatId: string) => renderToStaticMarkup(
  <PlanPanel plan={plan} chatId={chatId} connected onClose={() => {}} onStart={async () => {}} />,
);

describe("a Start that the host has not answered", () => {
  it("is the only one sent for its chat, however often it is asked again", async () => {
    const first = askPlanStart("chat-a", 2, { agent: "claude" });
    await tick();
    expect(calls.map((call) => call.command)).toEqual(["chat_plan_start"]);
    expect(inFlight(planFlight("chat-a"))).toBe(true);
    // The panel was shut and opened, the control pressed again; a second
    // surface asked too. Nothing more is sent.
    expect(await askPlanStart("chat-a", 2, { agent: "claude" })).toBe(IN_FLIGHT);
    expect(await askPlanStart("chat-a", 3, { agent: "claude" })).toBe(IN_FLIGHT);
    expect(calls).toHaveLength(1);
    // Another chat's Start is its own.
    const other = askPlanStart("chat-b", 1, {});
    await tick();
    expect(calls.map((call) => call.args.chatId)).toEqual(["chat-a", "chat-b"]);

    const plan = hostFacts.chatPlanStarted();
    calls[0].resolve({ plan, turnId: "octiq-plan-start-1", delivered: true, state: "started" });
    calls[1].resolve({ plan, turnId: "octiq-plan-start-2", delivered: true, state: "started" });
    expect(await first).toMatchObject({ delivered: true, turnId: "octiq-plan-start-1" });
    await other;
    expect(inFlight(planFlight("chat-a"))).toBe(false);
  });

  it("holds Tell the agent the same way: it is the same command", async () => {
    // A recorded Start whose agent was not told: the control says Tell the
    // agent, and sends `chat_plan_start` again.
    const untold = askPlanStart("chat-tell", 2, {});
    await tick();
    expect(await askPlanStart("chat-tell", 2, {})).toBe(IN_FLIGHT);
    expect(calls).toHaveLength(1);
    calls[0].resolve({ plan: hostFacts.chatPlanStarted(), turnId: "octiq-plan-start-1", delivered: false, notDelivered: "The chat is not running." });
    expect(await untold).toMatchObject({ delivered: false });
    // Answered: the next press is a new request.
    const again = askPlanStart("chat-tell", 2, {});
    await tick();
    expect(calls).toHaveLength(2);
    calls[1].resolve({ plan: hostFacts.chatPlanStarted(), turnId: "octiq-plan-start-1", delivered: true, state: "told" });
    await again;
  });

  it("keeps the chat held across the one retry after `already running`, and lets go on a refusal", async () => {
    const asked = askPlanStart("chat-race", 2, {});
    await tick();
    calls[0].reject(new Error("chat 'chat-race' is already running"));
    await tick();
    // The second ask of the same request is out, and the chat is still held.
    expect(calls).toHaveLength(2);
    expect(await askPlanStart("chat-race", 2, {})).toBe(IN_FLIGHT);
    calls[1].reject(new Error("The plan changed: it is at revision 3."));
    await expect(asked).rejects.toThrow("The plan changed: it is at revision 3.");
    expect(inFlight(planFlight("chat-race"))).toBe(false);
  });

  it("draws a panel that is mounted while it is out with its control off", async () => {
    const plan = hostFacts.chatPlanDecided();
    expect(plan.awaitsStart).toBe(true);
    const chat = "chat-remount";
    // Before any Start the control is on.
    expect(startButton(draw(plan, chat))).not.toContain("aria-disabled");
    const asked = askPlanStart(chat, plan.revision, {});
    await tick();
    // A panel drawn now is a new mount: it has no state of its own, and is off.
    const during = draw(plan, chat);
    expect(startButton(during)).toContain('aria-disabled="true"');
    expect(during).toContain("Sending…");
    // The same plan under another chat is not held.
    expect(startButton(draw(plan, "chat-elsewhere"))).not.toContain("aria-disabled");
    calls[0].reject(new Error("refused"));
    await expect(asked).rejects.toThrow("refused");
    expect(startButton(draw(plan, chat))).not.toContain("aria-disabled");
  });

  it("says what the host said of the last Start from what the sender kept, for the revision it was said of", () => {
    const plan = hostFacts.chatPlanDecided();
    const said = { revision: plan.revision, text: "The plan changed while you were reading it." };
    const html = renderToStaticMarkup(<PlanPanel plan={plan} chatId="chat-said" said={said} connected onClose={() => {}} onStart={async () => {}} />);
    expect(html).toContain('<p class="cplan-refusal" role="alert">The plan changed while you were reading it.</p>');
    // Said of another revision, it is another plan's.
    const stale = renderToStaticMarkup(<PlanPanel plan={plan} chatId="chat-said" said={{ ...said, revision: plan.revision - 1 }} connected onClose={() => {}} onStart={async () => {}} />);
    expect(stale).not.toContain("cplan-refusal");
  });
});
