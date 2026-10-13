// The agent's questions, drawn in the transcript where they were asked.
//
// Rendered through the transcript itself, so what is tested is what the page
// draws: the block at its `ask_user` call, the answer as the person's bubble,
// and nothing of a message on that bubble.
import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

vi.mock("./Thumb", () => ({ SentFiles: () => null }));
vi.mock("../lib/bridge", () => ({ bridge: { invoke: async () => [] } }));
vi.mock("../lib/pathStore", () => ({
  knownPath: () => undefined,
  askPaths: () => {},
  subscribePaths: () => () => {},
}));

import source from "./InlineQuestions.tsx?raw";
import sheet from "./InlineQuestions.css?raw";
import chatRequests from "./ChatRequests.tsx?raw";
import app from "../App.tsx?raw";
import type { Block, Message } from "../lib/chat";
import type { Question } from "../lib/question";
import { ChatQuestionsContext } from "./InlineQuestions";
import { MessageList } from "./MessageList";

const ASK = "mcp__octiq__ask_user";
const NOT_IN_TIME = "The questions are saved and still waiting for the user. End this turn without assuming an answer or repeating the questions. OctiqFlow will continue this conversation when the answers arrive.";

const call = (id: string, args: unknown, result?: string, state = result === undefined ? "running" : "done"): Block =>
  ({ kind: "tool", id, name: ASK, argsJson: "{}", args, result, state }) as Block;

const reply = (id: string, blocks: Block[]): Message => ({ id, role: "assistant", blocks, streaming: false });

const q = (id: string, question: string, over: Partial<Question> = {}): Question =>
  ({ id, chatKey: "chat:c1", question, ...over });

/** The transcript of a chat the person can answer in. */
const chat = (messages: Message[], questions: Question[] = []) => renderToStaticMarkup(
  <ChatQuestionsContext.Provider value={{ questions, onDone: () => {} }}>
    <MessageList messages={messages} busy={false} conversationId="c1" />
  </ChatQuestionsContext.Provider>,
);

/** The same transcript where nobody can answer: a worker's chat, the task
 *  chat beside a run. */
const readOnly = (messages: Message[]) => renderToStaticMarkup(<MessageList messages={messages} busy={false} />);

const DB = {
  question: "Which database?",
  options: [{ label: "Postgres", description: "A server to run" }, { label: "SQLite" }],
  recommended: 1,
};

/** One row of the block, by the words on it. */
const row = (html: string, label: string) => {
  const rows = html.split('<label class="qa-row').slice(1).map((part) => part.split("</label>")[0]);
  const found = rows.find((part) => part.includes(`>${label}<`));
  if (!found) throw new Error(`no row ${label}`);
  return found;
};

describe("a pending question, at the call that asked it", () => {
  const messages = [reply("m1", [{ kind: "text", text: "One thing first." }, call("t1", DB)])];
  const html = chat(messages, [q("a", DB.question, { options: DB.options, recommended: 1 })]);

  it("is drawn in the reply, in place of the call's tool row", () => {
    expect(html).toContain('class="qa-block');
    expect(html).toContain('<p class="qa-q-title"');
    expect(html).toContain("Which database?");
    expect(html).not.toContain("tool-head");
    // After the prose that led to it, inside the same reply.
    expect(html.indexOf("One thing first.")).toBeLessThan(html.indexOf("qa-block"));
    expect(html.indexOf("qa-block")).toBeLessThan(html.indexOf("</article>"));
  });

  it("has no card round it and nothing folded in it", () => {
    const block = html.slice(html.indexOf('class="qa-block'), html.indexOf("Dismiss without answering"));
    expect(block).not.toMatch(/ask-card|qa-card|<details|aria-expanded/);
  });

  it("draws radio rows, the description under the label, and a quiet Recommended", () => {
    expect(html).toContain('role="radiogroup"');
    expect(row(html, "Postgres")).toContain('type="radio"');
    expect(row(html, "Postgres")).toContain('<span class="qa-row-desc">A server to run</span>');
    // In words on the row, never a tooltip: nothing is reachable by hover alone.
    expect(row(html, "SQLite")).toContain('<span class="qa-tip">Recommended</span>');
    expect(row(html, "Postgres")).not.toContain("Recommended");
    expect(html).not.toMatch(/qa-row[^>]*title=/);
  });

  it("arrives with the recommended option selected, and only that one", () => {
    expect(row(html, "SQLite")).toMatch(/<input[^>]*checked=""/);
    expect(row(html, "Postgres")).not.toMatch(/checked=""/);
    expect(html.match(/checked=""/g)).toHaveLength(1);
  });

  it("ends every question that has options with Other, its text box not yet shown", () => {
    const rows = html.split('<label class="qa-row').slice(1);
    expect(rows[rows.length - 1]).toContain(">Other…<");
    expect(html).not.toContain("qa-input");
  });

  it("has one full-width button, on because the recommended option answers it", () => {
    expect(html.match(/class="qa-submit"/g)).toHaveLength(1);
    expect(html).toMatch(/<button type="button" class="qa-submit" aria-disabled="false">Send answer<\/button>/);
    expect(html).toContain('<p class="qa-why" id=');
  });

  it("never takes the focus as it arrives", () => {
    expect(html).not.toMatch(/autofocus/i);
    expect(source).not.toMatch(/autoFocus/);
  });

  it("carries the key a badge in the chat list finds it by", () => {
    expect(html).toContain('<div class="pending-target" data-pending-keys="question:a"><div class="qa-turn">');
  });
});

describe("what a question can be", () => {
  it("starts with nothing selected and its button off when the agent recommends nothing", () => {
    const html = chat([reply("m1", [call("t1", { question: "Ship it?", options: ["Yes", "No"] })])],
      [q("a", "Ship it?", { options: ["Yes", "No"] })]);
    expect(html).not.toContain('checked=""');
    expect(html).toContain('class="qa-submit" aria-disabled="true"');
    // The reason is in words on the page, and the button points at it.
    expect(html).toMatch(/aria-describedby="([^"]+)"[^>]*>Send answer<\/button><div class="qa-foot"><p class="qa-why" id="\1">Choose an answer to send it\.<\/p>/);
    // Off for a reader, not removed from the keyboard's way.
    expect(html).not.toMatch(/class="qa-submit"[^>]* disabled/);
  });

  it("draws checkbox rows for a question that takes a set", () => {
    const html = chat([reply("m1", [call("t1", { question: "Which checks?", options: ["Unit", "Lint"], multiple: true })])],
      [q("a", "Which checks?", { options: ["Unit", "Lint"], multiple: true, recommended: 0 })]);
    expect(html).toContain('role="group" aria-labelledby=');
    expect(html.match(/type="checkbox"/g)).toHaveLength(3);
    expect(html).not.toContain('type="radio"');
    expect(row(html, "Unit")).toContain('checked=""');
    expect(row(html, "Other…")).toContain('type="checkbox"');
  });

  it("shows the text box directly for a question with no options", () => {
    const html = chat([reply("m1", [call("t1", { question: "What should it be called?" })])], [q("a", "What should it be called?")]);
    expect(html).toContain('class="qa-input"');
    expect(html).toContain('aria-label="Answer to: What should it be called?"');
    expect(html).not.toContain("qa-row");
    expect(html).toContain("Type your answer to send it.");
  });

  it("draws every question of one call in one block with one button", () => {
    const args = { questions: [{ question: "One?", options: ["a", "b"] }, { question: "Two?" }, { question: "Three?", options: ["c"], recommended: 0 }] };
    const html = chat([reply("m1", [call("t1", args)])], [
      q("a", "One?", { batch: "b1", batchSize: 3, options: ["a", "b"] }),
      q("b", "Two?", { batch: "b1", batchSize: 3 }),
      q("c", "Three?", { batch: "b1", batchSize: 3, options: ["c"], recommended: 0 }),
    ]);
    expect(html.match(/class="qa-block/g)).toHaveLength(1);
    expect(html.match(/class="qa-q-title"/g)).toHaveLength(3);
    expect(html.match(/class="qa-submit"/g)).toHaveLength(1);
    expect(html).toContain(">Send 3 answers<");
    expect(html).toContain("2 of 3 questions still need an answer.");
    expect(html).toContain('aria-label="The agent has 3 questions"');
    expect(html).toContain('data-pending-keys="question:b1"');
  });

  it("draws an option's words as text", () => {
    const html = chat([reply("m1", [call("t1", { question: "Pick?", options: ["<b>bold</b>"] })])],
      [q("a", "Pick?", { options: [{ label: "<b>bold</b>", description: "<img src=x onerror=alert(1)>" }] })]);
    expect(html).toContain("&lt;b&gt;bold&lt;/b&gt;");
    expect(html).not.toContain("<img src=x");
  });
});

describe("a pending question with no call in the transcript the page holds", () => {
  it("is drawn at the end of the transcript", () => {
    const html = chat([reply("m1", [{ kind: "text", text: "Working on it." }])], [q("a", "Which database?", { options: ["Postgres"] })]);
    expect(html).toContain('<div class="qa-turn is-loose">');
    expect(html.indexOf("</article>")).toBeLessThan(html.indexOf("qa-turn is-loose"));
    expect(html).toContain("Which database?");
  });

  it("is each call's own block when there are two", () => {
    const html = chat([reply("m1", [{ kind: "text", text: "Working on it." }])], [q("a", "One?"), q("b", "Two?")]);
    expect(html.match(/class="qa-block/g)).toHaveLength(2);
    expect(html).toContain('data-pending-keys="question:a"');
    expect(html).toContain('data-pending-keys="question:b"');
  });
});

describe("answered", () => {
  it("folds to a quiet line and draws the answer as the person's bubble, from the call's result", () => {
    // No record of the question is left: this is what a reload and a second
    // tab draw.
    const html = chat([reply("m1", [call("t1", DB, "SQLite"), { kind: "text", text: "SQLite it is." }])]);
    expect(html).not.toContain("qa-block");
    expect(html).toContain('<span class="qa-asked-label">Asked</span><p class="qa-asked-q">Which database?</p>');
    expect(html).toContain('<div class="qa-said-body" role="note" aria-label="Your answer"><p class="qa-said-line">SQLite</p></div>');
    // Right after the questions, and before the reply goes on.
    expect(html.indexOf("qa-asked")).toBeLessThan(html.indexOf("qa-said"));
    expect(html.indexOf("qa-said")).toBeLessThan(html.indexOf("SQLite it is."));
  });

  it("gives each answer of several its question", () => {
    const args = { questions: [{ question: "Which database?" }, { question: "Name" }] };
    const html = chat([reply("m1", [call("t1", args, "Q1: Which database?\nA1: SQLite\n\nQ2: Name\nA2: octiq")])]);
    expect(html).toContain("Asked 2 questions");
    expect(html).toContain('<p class="qa-said-line"><span class="qa-said-q">Which database? </span>SQLite</p>');
    expect(html).toContain('<p class="qa-said-line"><span class="qa-said-q">Name: </span>octiq</p>');
  });

  it("is not a message: nothing on the bubble acts, and it is no point on the map", () => {
    const html = chat([reply("m1", [call("t1", DB, "SQLite")])]);
    const bubble = html.slice(html.indexOf('class="qa-said"'), html.indexOf("</article>"));
    expect(bubble).toContain("SQLite");
    expect(bubble).not.toMatch(/<button|message-delivery|msg-copy|data-map-turn/);
    expect(html).not.toContain("msg-user");
  });

  it("draws no bubble for a question closed without an answer, and says so", () => {
    const html = chat([reply("m1", [call("t1", DB, "The user cancelled this question or stopped the task. Do not assume an answer or resume the cancelled work.")])]);
    expect(html).toContain("Closed without answering");
    expect(html).not.toContain("qa-said");
  });

  it("keeps a failed call as its tool row, where the failure can be read", () => {
    const html = chat([reply("m1", [call("t1", DB, "Question service unavailable", "error")])]);
    expect(html).toContain("tool-head");
    expect(html).not.toContain("qa-asked");
  });
});

describe("answers the host still lists", () => {
  const messages = [reply("m1", [call("t1", DB)])];
  const record = (over: Partial<Question>) => chat(messages, [q("a", DB.question, { options: DB.options, answer: "SQLite", ...over })]);

  it("draws the bubble from the record, and says saved only of what is saved", () => {
    const html = record({ status: "saved" });
    expect(html).toContain("Answers saved · waiting for the agent");
    expect(html).toContain('<p class="qa-said-line">SQLite</p>');
    expect(html).not.toContain("qa-block");
    // Saved and on its way asks nothing: no badge leads here.
    expect(html).not.toContain("data-pending-keys");
    expect(html).toContain(">Cancel pending delivery<");
    expect(html).not.toContain("Retry delivery");
  });

  it("says delivered and not saved in its own words, the reason behind a disclosure", () => {
    const html = record({ status: "delivered", unsaved: "The profile folder is not available right now." });
    expect(html).toContain("Answers sent · not saved");
    expect(html).not.toMatch(/Answers saved|>Saved/);
    expect(html).toContain("<details class=\"qa-note-why\"><summary>Why</summary><p>The profile folder is not available right now.</p></details>");
    expect(html).toContain('<p class="qa-said-line">SQLite</p>');
  });

  it("offers the retry when delivery failed, under the delivery's own key", () => {
    const html = record({ status: "failed", error: "Could not continue the agent", retryable: true });
    expect(html).toContain("Answers need attention");
    expect(html).toContain(">Retry delivery<");
    expect(html).toContain('data-pending-keys="delivery:a"');
  });
});

describe("answers that came back after their call had ended", () => {
  const turn = (text: string, over: Partial<Message> = {}): Message =>
    ({ id: "u1", role: "user", turnId: "octiq-question-r1", streaming: false, blocks: [{ kind: "text", text }], ...over });
  const words = "The user answered your saved OctiqFlow questions (request r1).\n\nQ1: Which database?\nA1: SQLite\n\nContinue the original task using these answers and the conversation context. Check what is already complete before acting; do not repeat completed actions. These answers apply to the questions above, not to unrelated later requests.";
  const messages = [
    reply("m1", [call("t1", DB, NOT_IN_TIME), { kind: "text", text: "I will wait for your answer." }]),
    turn(words, { echo: "e1" }),
    reply("m2", [{ kind: "text", text: "SQLite it is." }]),
  ];

  it("draws the host's turn as the answer bubble, not as the host's words", () => {
    const html = chat(messages);
    expect(html).toContain('<article class="msg msg-answer ">');
    expect(html).toContain('<p class="qa-said-line">SQLite</p>');
    expect(html).not.toContain("The user answered your saved OctiqFlow questions");
    expect(html).not.toContain("Continue the original task");
    expect(html.match(/qa-said-body/g)).toHaveLength(1);
  });

  it("gives that bubble none of a message's controls, and no place on the map", () => {
    const html = chat(messages);
    const answer = html.slice(html.indexOf("msg-answer"), html.indexOf("SQLite it is."));
    expect(answer).not.toMatch(/<button|message-delivery|msg-copy|data-map-turn|msg-user/);
    // Queued behind a running reply it still offers no Edit and no Send now.
    const queued = chat([messages[0], turn(words, { delivery: "queued" })]);
    expect(queued).toContain("Sent when the current reply ends");
    expect(queued.slice(queued.indexOf("msg-answer"), queued.lastIndexOf("</article>"))).not.toMatch(/<button/);
  });

  it("says at the call that the answer came later", () => {
    const html = chat(messages);
    expect(html).toContain("Answered later in this conversation");
    expect(html.indexOf("Answered later")).toBeLessThan(html.indexOf("I will wait for your answer."));
  });

  it("draws the same bubble where nobody can answer", () => {
    expect(readOnly(messages)).toContain('<p class="qa-said-line">SQLite</p>');
  });

  it("leaves a turn it cannot read as the words it holds", () => {
    expect(chat([turn("Something else entirely.")])).toContain("Something else entirely.");
  });
});

describe("where nobody can answer", () => {
  // A worker asks through a gate (`route_worker_questions`): the host makes
  // no question record, and no page ever drew a card for one. Its call keeps
  // the tool row it always had.
  const routed = "Your questions were routed to main-chat gate gate_1. No answer has been given. End this turn and wait for the coordinator to resolve the gate; do not ask the user directly.";

  it("keeps the call's tool row and its question", () => {
    const html = readOnly([reply("m1", [call("t1", DB, routed)])]);
    expect(html).toContain("tool-head");
    expect(html).toContain("Which database?");
    expect(html).not.toMatch(/qa-block|qa-asked|qa-said/);
  });
});

describe("how it is wired", () => {
  it("guards the two controls that answer against a held key and a repeated press", () => {
    for (const control of ["qa-submit", "qa-dismiss"]) {
      const at = source.indexOf(`className="${control}"`);
      const button = source.slice(at, source.indexOf("</button>", at));
      expect(button, control).toContain("onKeyDown={dropHeld}");
      expect(button, control).toContain("onClick={guarded(");
    }
    expect(source).toContain("strayAnswer(before,");
    expect(source).toContain("useState(lastPointerPress)");
  });

  it("sends what the card sent: the batch command, one answer per question", () => {
    expect(source).toContain("submitQuestionAnswers((command, args) => bridge.invoke(command, args), answers)");
    expect(source).toContain("questions.map((q) => ({ id: q.id, answer: pickAnswer(q, pickOf(q)) }))");
  });

  it("is the only place a question is drawn", () => {
    expect(chatRequests).not.toMatch(/UserQuestion|questions|qa-/);
    expect(app).not.toMatch(/UserQuestion/);
    // The transcript is handed the open chat's questions, and nothing else is.
    expect(app.match(/<ChatQuestionsContext\.Provider/g)).toHaveLength(1);
    expect(app).toContain("if (!conversationId || workerChat) return null;");
  });

  it("takes no colour but the decision colour for what the person does", () => {
    // The accent is a turn in flight, and the model's colour in the composer.
    const rules = sheet.replace(/\/\*[\s\S]*?\*\//g, "");
    const accent = [...rules.matchAll(/([^{}]+)\{([^{}]*--accent[^{}]*)\}/g)].map((m) => m[1].trim());
    // The bubble alone: it is the person's own, the wash their messages wear.
    expect(accent).toEqual([".qa-said-body"]);
    expect(rules).toMatch(/\.qa-submit \{[^}]*border: 1px solid var\(--decide\)/);
    expect(rules).toMatch(/\.qa-row input:checked \+ \.qa-mark \{[^}]*var\(--decide\)/);
    expect(rules).toMatch(/\.qa-waiting \.status-row-label \{ color: var\(--decide\); \}/);
    expect(rules).not.toMatch(/#[0-9a-f]{3,8}\b|rgb\(/i);
  });

  it("stops its motion where motion is reduced", () => {
    expect(sheet).toMatch(/@media \(prefers-reduced-motion: reduce\) \{[^}]*\.qa-asked[^}]*animation: none/);
  });
});
