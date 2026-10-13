// The app hands every surface that draws a turn in flight the SAME answer to
// "does this chat wait on the person".
//
// `chatWait.test.ts` is the rule, and the components' own tests are what
// each draws when told a chat waits. Neither can see the app forgetting to
// tell one of them, or telling it from a second reading of the cards. This
// file reads `App.tsx` as text, names each hand-off, and runs the same check
// on the mutations that drop one. It is an alarm on the wiring's spelling,
// not a proof of behaviour: no test renders the app.
import { describe, expect, it } from "vitest";
import app from "../App.tsx?raw";
import chatWait from "./chatWait.ts?raw";

const SITES: { name: string; has: RegExp }[] = [
  // The answer is read off the page's one list of who is waited on.
  { name: "one reading", has: /const chatWaits = useMemo\(\s*\(\) => waitingChats\(pendingList, / },
  // Which refusals are a folded line is `splitSafety`'s to say, by the turn
  // itself and never by this answer.
  { name: "the fold is splitSafety's", has: /foldedSafetyKeys\(safetyBlocks, \(id\) => !!chats\[id\]\?\.busy && !interruptedIds\.has\(id\), splitSafety\)/ },
  { name: "the chat on screen", has: /const waitingHere = \(conversationId && chatWaits\.get\(conversationId\)\) \|\| null;/ },
  // The composer's running line and its clock.
  { name: "the composer's line", has: /<Composer\b[\s\S]*?\bwaiting=\{waitingHere\}/ },
  { name: "the composer's clock", has: /<Composer\b[\s\S]*?\bturnWaits=\{conversationId \? turnWaits\[conversationId\] : undefined\}/ },
  { name: "the clock's waits", has: /setTurnWaits\(\(before\) => noteWaits\(\s*before, chatWaits, / },
  // The chat list's rows, and the projects page's.
  { name: "the chat list", has: /<Sidebar\b[\s\S]*?\bwaiting=\{chatWaits\}/ },
  { name: "the working set", has: /const workingSet = useMemo\(\(\) => workingChats\(busySet, chatWaits\), / },
  { name: "the projects page", has: /<ProjectsPage\b[\s\S]*?\bbusy=\{workingSet\}/ },
  // The top bar's status line.
  { name: "the task bar", has: /<ChatTaskBar\b[\s\S]*?\bwaiting=\{[\s\S]*?!!waitingHere\s*\}/ },
];

const missing = (source: string) => SITES.filter((site) => !site.has.test(source)).map((site) => site.name);

describe("the app's hand-off of which chats wait on the person", () => {
  it("gives every surface the one answer", () => {
    expect(missing(app)).toEqual([]);
    // Made once.
    expect(app.match(/waitingChats\(/g)).toHaveLength(1);
  });

  it("fails for a hand-off that is dropped or made from something else", () => {
    expect(missing(app.replace("waiting={waitingHere}", "waiting={null}"))).toEqual(["the composer's line"]);
    expect(missing(app.replace("waiting={chatWaits}", ""))).toEqual(["the chat list"]);
    expect(missing(app.replace("busy={workingSet}", "busy={busySet}"))).toEqual(["the projects page"]);
    expect(missing(app.replace("waitingChats(pendingList, ", "waitingChats(heldCards(cards), "))).toEqual(["one reading"]);
    expect(missing(app.replace(/\|\|\s*\/\/ A plan to approve[^\n]*\n\s*!!waitingHere/, ""))).toEqual(["the task bar"]);
    expect(missing(app.replace("before, chatWaits, (id)", "before, new Map(), (id)"))).toEqual(["the clock's waits"]);
  });
});

describe("the reading of which chats wait", () => {
  it("is drawn from the list of pending actions and reads nothing else", () => {
    const code = chatWait.replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*/g, "");
    // No second reader of the cards, the ledger or its waits.
    expect(code).not.toMatch(/\b(gates|nativeDecisions|awaits|heldCards|ledgerWaits|runWaits|orchestration)\b/);
    expect([...code.matchAll(/from "([^"]+)"/g)].map((match) => match[1])).toEqual(["./pendingActions"]);
  });
});
