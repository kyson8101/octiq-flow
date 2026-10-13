// The Plan panel, drawn from the plans the host's own tests answered
// (`lib/__fixtures__/host/chat_plan_*.json`), and the hand-offs round it
// read as source: who sends Start, what guards it, and where the panel is
// mounted. The source reads are an alarm on spelling, not a proof; what a
// press does in a browser is `scripts/test-plan-panel.mjs`.
import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

import { hostFacts } from "../lib/__fixtures__/hostFacts";
import type { ChatPlan, ChatPlanStartAnswer } from "../lib/chatPlan";
import type { Message } from "../lib/chat";
import { NOTHING_TO_START, planStart, TURN_NOT_SENT } from "../lib/planView";
import { isPlanStartTurn, startTurnLost } from "../lib/planTurn";
import { PlanButton, PlanPanel } from "./PlanPanel";
import panelSource from "./PlanPanel.tsx?raw";
import appSource from "../App.tsx?raw";
import hookSource from "../lib/useChatPlan.ts?raw";
import runPanelSource from "./OrchestrationPanel.tsx?raw";

const sources = import.meta.glob("../**/*.{ts,tsx}", { query: "?raw", import: "default", eager: true }) as Record<string, string>;

const never = () => new Promise<ChatPlanStartAnswer>(() => {});
const draw = (plan: ChatPlan | null, more: Partial<Parameters<typeof PlanPanel>[0]> = {}) => renderToStaticMarkup(
  <PlanPanel plan={plan} connected onClose={() => {}} onStart={never} onOpenTask={() => {}} {...more} />,
);
const text = (html: string) => html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
const items = (html: string) => html.split('<li class="cplan-item"').slice(1);
const foot = (html: string) => html.slice(html.indexOf('<footer class="cplan-foot"'));

describe("a chat with no plan", () => {
  it("says so in one line, with a hint, and offers no Start", () => {
    const html = draw(hostFacts.chatPlanNone());
    expect(html).toContain("<p>No plan yet</p>");
    expect(html).toContain("The agent keeps one when you ask it to plan.");
    expect(html).not.toContain("cplan-foot");
    expect(html).not.toContain("cplan-items");
  });

  it("says it is reading before the host has answered, never No plan yet", () => {
    const html = draw(null, { unread: true });
    expect(text(html)).toContain("Reading the plan…");
    expect(html).not.toContain("No plan yet");
  });

  it("says why a plan could not be read, in the host's words, and does not call that no plan", () => {
    const html = draw(null, { error: "The profile folder is not available right now." });
    expect(text(html)).toContain("The plan could not be read: The profile folder is not available right now.");
    expect(html).not.toContain("No plan yet");
  });
});

describe("a plan being discussed", () => {
  const html = draw(hostFacts.chatPlanDiscussing());

  it("has a header: how many items, not started, and who last changed it", () => {
    expect(html).toMatch(/<span class="cplan-head-state">Not started<\/span>/);
    expect(text(html)).toMatch(/2 items 3 open questions Updated .* by the agent/);
  });

  it("draws each item with its word, its decisions and its open questions", () => {
    const [first, second] = items(html);
    expect(first).toContain('data-status="discussing"');
    expect(first).toContain('<span class="cplan-item-title">A quieter composer</span>');
    expect(first).toContain(">Discussing</span>");
    expect(first).toContain("<li>Status rows are one line</li>");
    expect(first.match(/class="cplan-question-mark"/g)).toHaveLength(2);
    expect(first).toContain("<span>Do the rows fold on a phone?</span>");
    expect(second).toContain("<span>Desktop only?</span>");
  });

  it("keeps the note behind a disclosure that is a button", () => {
    const [, second] = items(html);
    expect(second).toMatch(/<button type="button" class="cplan-more" aria-expanded="false" aria-controls="[^"]+">.*Note<\/button>/);
    expect(second).toMatch(/<p class="cplan-note" id="[^"]+" hidden="">The person sent a screenshot of the old top bar\.<\/p>/);
  });

  it("offers Start, with the questions still open beside it: they do not block", () => {
    const end = foot(html);
    expect(end).toMatch(/<button type="button" class="cplan-start" aria-describedby="[^"]+">Start<\/button>/);
    expect(end).not.toContain("aria-disabled");
    expect(text(end)).toBe("Start 3 questions still open");
  });

  it("draws no progress for an item with no linked task", () => {
    expect(html).not.toContain("cplan-progress");
    expect(html).not.toContain("cplan-bar");
  });
});

describe("a plan whose questions are all answered", () => {
  const html = draw(hostFacts.chatPlanDecided());

  it("has no question on it and nothing beside Start", () => {
    expect(html).not.toContain("cplan-question-mark");
    expect(html).not.toContain("cplan-meta-open");
    expect(text(foot(html))).toBe("Start");
  });

  it("shows three decisions, and more only behind a line that says how many", () => {
    expect(items(html)[0].match(/<li>/g)).toHaveLength(3);
    const plan = hostFacts.chatPlanDecided();
    plan.items[0].decisions.push("A fourth", "A fifth");
    const [first] = items(draw(plan));
    expect(first).toMatch(/<button type="button" class="cplan-more" aria-expanded="false" aria-controls="[^"]+">.*2 more decisions<\/button>/);
    expect(first).toMatch(/<ul class="cplan-decisions" id="[^"]+" hidden="" aria-label="More decisions"><li>A fourth<\/li><li>A fifth<\/li><\/ul>/);
  });

  it("switches Start off with the reason while the page is not connected", () => {
    const end = foot(draw(hostFacts.chatPlanDecided(), { connected: false }));
    expect(end).toMatch(/class="cplan-start" aria-disabled="true"/);
    expect(text(end)).toBe("Start Not connected.");
  });
});

describe("a started plan", () => {
  const html = draw(hostFacts.chatPlanStarted());

  it("says Started and when in place of the button", () => {
    expect(html).toMatch(/<span class="cplan-head-state" data-started="true"[^>]*>Started [^<]+<\/span>/);
    const end = foot(html);
    expect(end).toMatch(/<p class="cplan-started" role="status">Started [^<]+<\/p>/);
    expect(end).not.toContain("<button");
  });

  it("lists the dropped item last, muted", () => {
    const all = items(html);
    expect(all).toHaveLength(7);
    expect(all[6]).toContain('data-status="dropped"');
    expect(all[6]).toContain("A sound on finish");
    expect(all.slice(0, 6).every((item) => !item.includes('data-status="dropped"'))).toBe(true);
  });

  it("shows the host's count beside the agent's word, and does not colour a done the count contradicts", () => {
    const [first] = items(html);
    // The agent calls it done; one of its two tasks failed its check.
    expect(first).toContain('data-status="done" data-mark="quiet"');
    expect(first).toContain(">Done</span>");
    expect(first).toContain('<span class="cplan-progress-count">1/2</span>');
    expect(first).toContain('<span style="width:50%"></span>');
    expect(first).toContain('<span class="cplan-progress-parts">1 failed</span>');
    expect(first).not.toContain('data-mark="done"');
  });

  it("lists an item's tasks behind its count, each a way to its row in the run panel", () => {
    const fourth = items(html)[3];
    expect(fourth).toMatch(/<button type="button" class="cplan-progress" aria-expanded="false" aria-controls="[^"]+" aria-label="2 tasks: 0 of 1 task done, 1 waiting, 1 closed"/);
    expect(fourth).toMatch(/<ul class="cplan-tasks" id="[^"]+" hidden="" aria-label="Tasks">/);
    expect(fourth).toContain('aria-label="Open in the run panel: Inline questions, first try, closed"');
    expect(fourth).toContain('aria-label="Open in the run panel: Inline questions, waiting"');
  });

  it("puts the accent on nothing without a turn in flight, and on the item and its task with one", () => {
    expect(html).not.toContain('data-mark="live"');
    expect(html).not.toContain("data-live");
    const live = draw(hostFacts.chatPlanStarted(), { flying: new Set(["task_b86c71821a754178bdd37d078dd2acb1"]) });
    const marked = items(live).filter((item) => item.includes('data-mark="live"'));
    expect(marked).toHaveLength(1);
    expect(marked[0]).toContain("Action bar and usage row");
    expect(live.match(/data-live="true"/g)).toHaveLength(1);
  });

  it("says both halves apart while the agent was not told, with one control that asks again", () => {
    const plan = hostFacts.chatPlanStarted();
    plan.started!.told = false;
    const end = foot(draw(plan));
    expect(text(end)).toMatch(/^Started .+? · the agent has not been told yet Tell the agent$/);
    expect(end.match(/<button/g)).toHaveLength(1);
    expect(end).toMatch(/class="cplan-start"[^>]*>Tell the agent<\/button>/);
  });
});

describe("a plan the host would not start", () => {
  it("says Nothing to start and draws no button", () => {
    const plan = hostFacts.chatPlanDecided();
    for (const item of plan.items) item.status = "dropped";
    plan.awaitsStart = false;
    const end = foot(draw(plan));
    expect(text(end)).toBe(NOTHING_TO_START);
    expect(end).not.toContain("<button");
  });
});

describe("what the agent wrote", () => {
  it("is text: never markup, never a link, never markdown", () => {
    const plan = hostFacts.chatPlanDiscussing();
    plan.items[0].title = "<b>Bold</b> [a link](https://example.com) **strong**";
    plan.items[0].decisions = ["<img src=x onerror=alert(1)>"];
    plan.items[0].questions = ["<a href=\"https://example.com\">here</a>?"];
    plan.items[1].note = "# Heading\n<script>alert(1)</script>";
    const whole = draw(plan);
    // The list, which is where everything the agent wrote is drawn.
    const html = whole.slice(whole.indexOf('<ol class="cplan-items"'), whole.indexOf("</ol>"));
    expect(html).not.toMatch(/<(b|a|img|script|strong|h1|em)[\s>]/);
    expect(html).toContain("&lt;b&gt;Bold&lt;/b&gt; [a link](https://example.com) **strong**");
    expect(html).toContain("&lt;img src=x onerror=alert(1)&gt;");
    expect(html).toContain("# Heading\n&lt;script&gt;alert(1)&lt;/script&gt;");
    expect(panelSource).not.toMatch(/dangerouslySetInnerHTML|Markdown|<a\s/);
  });
});

describe("the panel is read-only", () => {
  it("has no field and no control that edits, reorders or deletes", () => {
    for (const plan of [hostFacts.chatPlanDiscussing(), hostFacts.chatPlanDecided(), hostFacts.chatPlanStarted()]) {
      const html = draw(plan);
      expect(html).not.toMatch(/<(input|textarea|select)\b|contenteditable|draggable/);
      const labels = [...html.matchAll(/<button[^>]*>(.*?)<\/button>/g)].map((match) => text(match[1]));
      for (const label of labels) expect(label).not.toMatch(/edit|delete|remove|reorder|move|drop/i);
    }
  });

  it("is a page in the chat's place on a phone, with a way back", () => {
    const html = draw(hostFacts.chatPlanDiscussing(), { page: true });
    expect(html).toContain('class="cplan-panel is-page"');
    expect(html).toContain('aria-label="Back to the chat"');
    expect(draw(hostFacts.chatPlanDiscussing())).toContain('aria-label="Close the plan"');
  });
});

describe("the action bar's button", () => {
  const button = (questions: number, open = false) => renderToStaticMarkup(<PlanButton questions={questions} open={open} onToggle={() => {}} />);

  it("has an icon and the word Plan", () => {
    const html = button(0);
    expect(html).toContain("<svg");
    expect(html).toContain('<span class="topbar-action-label">Plan</span>');
  });

  it("carries the open questions, and nothing when there are none", () => {
    expect(button(0)).not.toContain("cplan-toggle-open");
    expect(button(3)).toContain('<span class="cplan-toggle-open" aria-hidden="true">3</span>');
    expect(button(3)).toContain('aria-label="Show the plan, 3 questions still open"');
    expect(button(1, true)).toContain('aria-label="Hide the plan, 1 question still open"');
    expect(button(0, true)).toContain('aria-expanded="true"');
  });
});

describe("Start is never fired by the press or the key that brought it on screen", () => {
  it("drops a held key and a press that repeats the one the panel was opened with", () => {
    expect(panelSource).toMatch(/className="cplan-start"[^>]*\n?\s*onKeyDown=\{dropHeld\} onClick=\{press\}/);
    expect(panelSource).toMatch(/if \(off\) return;\s*if \(strayAnswer\(opener, \{ x: event\.clientX, y: event\.clientY, at: performance\.now\(\), detail: event\.detail \}\)\) return;/);
    expect(panelSource).toMatch(/const opener = useRef<Press \| null>\(lastPointerPress\(\)\)/);
  });

  it("is off from the press until its answer, by the chat and not by the control that was pressed", () => {
    expect(panelSource).toMatch(/const off = busy \? "Sending…" : start\.off;/);
    // What is out is the sender's to say (`lib/inFlight`): a control that
    // kept it in its own state forgot it when the panel was shut.
    expect(panelSource).toMatch(/const busy = useInFlight\(chatId \? planFlight\(chatId\) : null\);/);
    expect(panelSource).not.toMatch(/setBusy|useState\(false\);\s*\/\*\* The host's words/);
    expect(panelSource).toMatch(/if \(off\) return;[\s\S]{0,400}?void onStart\(start\.revision\)\.catch\(\(\) => \{\}\);/);
    // The sender takes the chat before it asks, for Start and Tell alike.
    expect(hookSource).toMatch(/return once\(planFlight\(id\), async \(\) => \{\s*const ask = \(\) => bridge\.invoke<ChatPlanStartAnswer>\("chat_plan_start"/);
    expect(hookSource.match(/"chat_plan_start"/g)).toHaveLength(1);
    expect(appSource).toMatch(/<PlanPanel key=\{planFor\} page=\{page\}\s+plan=\{planFeed\.plan\} chatId=\{planFor\} said=\{planFeed\.said\}/);
  });

  it("has the button that opens the panel, and every disclosure in it, remembered by the cards' guard", () => {
    expect(panelSource).toMatch(/className=\{`icon-btn cplan-toggle\$\{open \? " is-on" : ""\}`\}[^>]*\n?\s*onClick=\{\(event\) => \{ notePress\(event\); onToggle\(\); \}\}/);
    const disclosures = [...panelSource.matchAll(/aria-expanded=\{(\w+)\} aria-controls=\{\w+\}[^>]*?onClick=\{\(event\) => \{ notePress\(event\); set\w+\(!\1\); \}\}/g)];
    // More decisions, the tasks, the note, and why a Start's turn was not handed over.
    expect(disclosures.map((match) => match[1]).sort()).toEqual(["more", "note", "tasks", "why"]);
    expect(panelSource.match(/aria-expanded=\{/g)).toHaveLength(disclosures.length + 1); // + the bar's button
  });

  it("asks through no confirm: the page's other Starts have none", () => {
    expect(panelSource).not.toMatch(/useConfirm|window\.confirm|<Confirm\b/);
  });
});

describe("a Start turn that was handed over and is gone", () => {
  // The host leaves `started.told` true when the Start's turn was marked
  // not sent, or was queued by a server that did not live to hand it over,
  // and puts it right on the next ask. The page offers that ask for a turn
  // it can see is gone (`docs/chat-plan.md`).
  const started = () => hostFacts.chatPlanStarted();
  const turn = (over: Partial<Message>): Message => ({ id: "u1", role: "user", streaming: false, blocks: [], turnId: started().started!.turnId, ...over });

  it("is known from the turn's own line, and only when the page holds that turn", () => {
    const id = started().started!.turnId;
    expect(isPlanStartTurn(id)).toBe(true);
    // Marked not sent, or queued and no longer in the host's queue.
    expect(startTurnLost([turn({ delivery: "failed", queueLost: true })], id)).toBe(true);
    expect(startTurnLost([turn({ delivery: "queued", queueLost: true })], id)).toBe(true);
    // Handed over: written, acknowledged, taken up, or its process ended
    // before saying so. Never told twice.
    for (const over of [{ delivery: "dispatched" as const }, { delivery: "unknown" as const }, { echo: "e1" }, { takenUp: true }, { delivery: "queued" as const }, { delivery: "starting" as const }]) {
      expect(startTurnLost([turn(over)], id), JSON.stringify(over)).toBe(false);
    }
    // Not held: behind Load earlier messages, or cleared. Nothing is known.
    expect(startTurnLost([], id)).toBe(false);
    expect(startTurnLost([turn({ turnId: "turn-of-the-persons", delivery: "failed", queueLost: true })], id)).toBe(false);
    // No Start, or a plan with none.
    expect(startTurnLost([turn({ delivery: "failed" })], undefined)).toBe(false);
    // The latest try is the one that counts.
    const first = turn({ id: "u1", delivery: "failed", queueLost: true });
    const second = turn({ id: "u2", turnId: `${id}-try2`, delivery: "dispatched" });
    expect(startTurnLost([first, second], id)).toBe(false);
    expect(startTurnLost([first, second], `${id}-try2`)).toBe(false);
    expect(startTurnLost([first, { ...second, delivery: "failed", queueLost: true }], `${id}-try2`)).toBe(true);
    // Another Start's turn is not this one's try.
    expect(startTurnLost([turn({ turnId: `${id}0`, delivery: "failed" })], id)).toBe(false);
  });

  it("offers Tell the agent again, and says the turn was not sent", () => {
    const plan = started();
    expect(plan.started).toMatchObject({ told: true });
    expect(planStart(plan, Date.now(), { connected: true })).toMatchObject({ kind: "started" });
    expect(planStart(plan, Date.now(), { connected: true, turnLost: true })).toMatchObject({
      kind: "tell", label: "Tell the agent", note: TURN_NOT_SENT, revision: plan.revision, off: null,
    });
    const html = draw(plan, { startTurnLost: true });
    expect(text(foot(html))).toMatch(/^Started .+ · the turn that tells the agent was not sent Tell the agent$/);
    expect(foot(html)).toContain('class="cplan-start"');
    // Without it, a told plan has nothing to press.
    expect(foot(draw(plan))).not.toContain('class="cplan-start"');
    // A plan that was never started is not this.
    expect(planStart(hostFacts.chatPlanDecided(), Date.now(), { connected: true, turnLost: true })).toMatchObject({ kind: "start" });
    expect(appSource).toMatch(/startTurnLost=\{startTurnLost\(chat\.messages, planFeed\.plan\?\.started\?\.turnId\)\}/);
  });
});

describe("Start is the page's command, sent from one place", () => {
  it("only the plan hook names chat_plan_start, and nothing on the page sends chat_plan_update", () => {
    const code = Object.entries(sources).filter(([path]) => !/\.test\.tsx?$/.test(path) && !path.includes("__fixtures__"));
    // As a string a command is sent with; a comment names it in backticks.
    const senders = code.filter(([, source]) => /["']chat_plan_start["']/.test(source)).map(([path]) => path.replace(/^.*\//, ""));
    expect(senders).toEqual(["useChatPlan.ts"]);
    expect(code.filter(([, source]) => /["']chat_plan_update["']/.test(source))).toEqual([]);
    expect(hookSource).toMatch(/bridge\.invoke<ChatPlanStartAnswer>\("chat_plan_start", \{ chatId: id, revision, start: settings \}\)/);
  });

  it("is sent with the revision on screen and the settings a completion would start the chat with", () => {
    expect(appSource).toMatch(/planFeed\.start\(id, revision, startSettingsOf\(id\)\)/);
    expect(appSource).toMatch(/completions\.complete\(id, startSettingsOf\(id\), preview\)/);
    expect(appSource).toMatch(/onStart=\{\(revision\) => startPlan\(planFor, revision\)\}/);
  });

  it("reads the plan when the chat opens and when the panel does, then the event: nothing polls", () => {
    expect(hookSource).toMatch(/bridge\.on<ChatPlanEvent>\("chat-plan"/);
    expect(hookSource.match(/"chat_plan_get"/g)).toHaveLength(1);
    expect(hookSource).not.toMatch(/setInterval|setTimeout/);
  });
});

describe("where the panel is mounted", () => {
  it("is offered to a chat's own agent only: not a worker, a front desk or a seat", () => {
    expect(appSource).toMatch(/const planFor = conversationId && !unavailableChat\s*&& planOffered\(chatKindOf\(\{ key: keyFor\(conversationId\), worker: workerChat, frontDesk: frontDeskChats\.has\(conversationId\) \}\)\)\s*\? conversationId : null;/);
    // The button, the panel and the reads all hang on that one value.
    expect(appSource).toMatch(/onChat && planFor && act\("plan", 95, <PlanButton/);
    expect(appSource).toMatch(/const planPanel = \(page: boolean\) => planFor && <PlanPanel/);
    expect(appSource).toMatch(/useChatPlan\(conn, planFor, planOpen, orchestrationState\.snapshot\)/);
  });

  it("is a page in the chat's place on a phone, and the chat is then not what the page shows", () => {
    expect(appSource).toMatch(/const planInPlace = isMobile && !!planFor && planPage === planFor;/);
    expect(appSource).toMatch(/const chatShown = !showingProjects && !mainPage && !planInPlace && !runInPlace && mainShown;/);
    expect(appSource).toMatch(/\{!mainPage && planInPlace && planPanel\(true\)\}/);
    expect(appSource).toMatch(/className=\{`chat-app-surface \$\{entryClass\(identity\)\}`\} hidden=\{mainPage \|\| planInPlace\}/);
  });

  it("is a column beside the chat on a desktop, remembered through lib/remember", () => {
    expect(appSource).toMatch(/\{!mainPage && planColumnShown && planPanel\(false\)\}/);
    expect(appSource).toMatch(/useState\(\(\) => recall\(PLAN_KEY\) === "1"\)/);
    expect(appSource).toMatch(/rememberFlag\(PLAN_KEY, next\)/);
    expect(appSource).not.toMatch(/localStorage\.setItem\(PLAN_KEY/);
  });

  it("opens the run panel at the task an item links, and the row is not left behind a fold", () => {
    expect(appSource).toMatch(/setRunFocus\(\{ chatKey: keyFor\(planFor\), runId: task\.runId, taskId: task\.id, nonce \}\)/);
    expect(runPanelSource).toMatch(/focusTaskId=\{focusRun\?\.runId === run\.id \? focusRun\.taskId \?\? null : null\}/);
    expect(runPanelSource).toMatch(/\|\| row\.task\.id === focusTaskId\)\}>/);
    expect(runPanelSource).toMatch(/data-task-id=\{task\.id\}/);
  });
});
