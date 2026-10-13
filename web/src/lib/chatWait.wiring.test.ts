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
import chatState from "./chat.ts?raw";

const SITES: { name: string; has: RegExp }[] = [
  // The answer is read off the page's one list of who is waited on.
  { name: "one reading", has: /const chatWaits = useMemo\(\s*\(\) => waitingChats\(pendingList, / },
  // Which refusals are a folded line is `splitSafety`'s to say, by the turn
  // itself and never by this answer.
  { name: "the fold is splitSafety's", has: /foldedSafetyKeys\(safetyBlocks, \(id\) => !!chats\[id\]\?\.busy && !interruptedIds\.has\(id\), splitSafety\)/ },
  { name: "the chat on screen", has: /const waitingHere = \(conversationId && chatWaits\.get\(conversationId\)\) \|\| null;/ },
  // The composer's running line and its clock.
  { name: "the composer's line", has: /<Composer\b[\s\S]*?\bwaiting=\{waitingHere\}/ },
  // Its waits are the chat's own state's, beside the turn's start, and are
  // noted there from the one answer.
  { name: "the composer's clock", has: /<Composer\b[\s\S]*?\bturnStartedAt=\{chat\.turnStartedAt\}[\s\S]*?\bturnWaits=\{chat\.turnWaits\}/ },
  { name: "the clock's waits", has: /for \(const id of Object\.keys\(chats\)\) patch\(id, \(state\) => withWait\(state, chatWaits\.has\(id\), now\)\);/ },
  // The chat list's rows, and the projects page's.
  { name: "the chat list", has: /<Sidebar\b[\s\S]*?\bwaiting=\{chatWaits\}/ },
  { name: "the working set", has: /const workingSet = useMemo\(\(\) => workingChats\(busySet, chatWaits\), / },
  { name: "the projects page", has: /<ProjectsPage\b[\s\S]*?\bbusy=\{workingSet\}/ },
  // The action bar's status, and its panel.
  { name: "the task bar", has: /<ChatTaskBar\b(?:(?!\/>)[\s\S])*?\bwaiting=\{!!waitingHere\}/ },
  // The task chat beside the main one, whose own status line it draws.
  { name: "the task chat beside", has: /<TaskChatPane\b(?:(?!\/>)[\s\S])*?\bwaiting=\{chatWaits\.has\(besideId\)\}/ },
];

/** The card lists the page holds. Their length says how many cards the host
 *  lists, which is not who is waited on: a question the person has answered
 *  stays listed, `saved`, until its agent has it. */
const CARD_LISTS = /\b(?:questions|asks|accessRequests|safetyBlocks|safetySplit|safetyHere|accessHere|handovers|pendingList|pendingHeld)\b/;

/** Every value the app hands a `waiting` prop, as written. */
function waitingProps(source: string): string[] {
  const found: string[] = [];
  for (let at = source.indexOf("waiting={"); at >= 0; at = source.indexOf("waiting={", at + 1)) {
    let depth = 0;
    let end = at + "waiting=".length;
    do {
      if (source[end] === "{") depth++;
      if (source[end] === "}") depth--;
      end++;
    } while (depth > 0 && end < source.length);
    found.push(source.slice(at + "waiting={".length, end - 1).trim());
  }
  return found;
}

/** The `waiting` props that are not the one answer: read off a card list,
 *  or counted. */
const rawReaders = (source: string) => waitingProps(source).filter((value) => CARD_LISTS.test(value) || /\.length\b/.test(value));

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
    expect(missing(app.replace("waiting={!!waitingHere}", "waiting={false}"))).toEqual(["the task bar"]);
    expect(missing(app.replace("waiting={chatWaits.has(besideId)}", "waiting={false}"))).toEqual(["the task chat beside"]);
    expect(missing(app.replace("withWait(state, chatWaits.has(id), now)", "withWait(state, false, now)"))).toEqual(["the clock's waits"]);
    expect(missing(app.replace("turnWaits={chat.turnWaits}", "turnWaits={undefined}"))).toEqual(["the composer's clock"]);
  });
});

describe("a turn's waits", () => {
  it("are kept in the chat's state beside its start, and nowhere else", () => {
    // The page kept them in a state of its own while the turn's start came
    // back from the chat's checkpoint: a reload restored one without the
    // other. There is no second store of them to restore, or to forget.
    expect(app).not.toMatch(/setTurnWaits|useState<[^>]*TurnWaits|noteWaits\(/);
    expect(chatState).toMatch(/turnStartedAt\?: number;[\s\S]{0,700}?turnWaits\?: TurnWaits;/);
    // A turn that is over takes both with it.
    expect(chatState).toMatch(/const turnOver = \{\s*turnStartedAt: undefined,\s*turnWaits: undefined,/);
  });
});

describe("a surface that says a chat waits", () => {
  it("is handed the one answer, never a card list or its length", () => {
    // Every `waiting` the app hands on is one of the two readings of
    // `chatWaits`: what the chat on screen waits for, or whether a chat is
    // in it.
    expect(waitingProps(app).sort()).toEqual(["!!waitingHere", "chatWaits", "chatWaits.has(besideId)", "waitingHere"]);
    expect(rawReaders(app)).toEqual([]);
  });

  it("fails for a reader of a raw list, as the task bar's was", () => {
    // What the task bar was handed: the lists' lengths, OR the one answer.
    // A question the host still lists as `saved` then read `Needs you`
    // under a composer that said the agent was working.
    const was = `waiting={
        (questions[conversationId]?.length ?? 0) +
          (asks[conversationId]?.length ?? 0) +
          (accessRequests[conversationId]?.length ?? 0) +
          safetySplit.cards.length >
        0 ||
        !!waitingHere
      }`;
    const taskBar = app.replace("waiting={!!waitingHere}", was);
    expect(taskBar).not.toBe(app);
    expect(rawReaders(taskBar)).toHaveLength(1);
    expect(missing(taskBar)).toEqual(["the task bar"]);
    // And the task chat beside it, which never asked the one answer at all.
    const beside = app.replace(
      "waiting={chatWaits.has(besideId)}",
      "waiting={(asks[besideId]?.length ?? 0) + (questions[besideId]?.length ?? 0) + (safetyBlocks[besideId]?.length ?? 0) > 0}",
    );
    expect(beside).not.toBe(app);
    expect(rawReaders(beside)).toHaveLength(1);
    expect(missing(beside)).toEqual(["the task chat beside"]);
    // A count of the page's own list is a second reading too.
    expect(rawReaders(app.replace("waiting={!!waitingHere}", "waiting={pendingList.some((action) => action.chatId === conversationId)}"))).toHaveLength(1);
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
