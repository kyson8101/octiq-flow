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
import pendingActions from "./pendingActions.ts?raw";
import requests from "./useChatRequests.ts?raw";
import chatState from "./chat.ts?raw";
import turnClock from "./turnClock.ts?raw";

const SITES: { name: string; has: RegExp }[] = [
  // The answer is read off the page's one list of who is waited on.
  { name: "one reading", has: /const chatWaits = useMemo\(\s*\(\) => waitingChats\(pendingList, / },
  // The reading is told where each request behind it stands: the four card
  // lists and the ledger. An unread list is not an empty one.
  { name: "the lists' requests", has: /useChatRequests\(conn, [\s\S]{0,200}?\)[\s\S]{0,20}?;/ },
  { name: "what has answered", has: /const waitSources = useMemo<SourcesRead>\(\s*\(\) => \(\{ \.\.\.listsRead, orchestration_snapshot: ledgerRead \? "answered" : ledgerFailed \? "failed" : "asked" \}\),/ },
  { name: "the reading knows how whole it is", has: /pendingReading\(\{[^}]*\bsources: waitSources, late: listsLate \}\)/ },
  // The third answer: a chat its checkpoint brought back parked is unknown
  // until the reading is whole. Made by the one reader, from the reading's
  // own word and the chats' own states.
  { name: "the restored waits", has: /const restoredParks = useMemo\(\s*\(\) => Object\.keys\(chats\)\.filter\(\(id\) => parkRestored\(chats\[id\]\)\)\.sort\(\)\.join\(" "\),/ },
  { name: "unknown is an answer", has: /waitingChats\(pendingList, new Set\(foldedSafety \? foldedSafety\.split\(" "\) : \[\]\), \{\s*whole: pendingRead\.whole, restored: restoredParks \? restoredParks\.split\(" "\) : \[\],\s*\}\)/ },
  // Which refusals are a folded line is `splitSafety`'s to say, by the turn
  // itself and never by this answer.
  { name: "the fold is splitSafety's", has: /foldedSafetyKeys\(safetyBlocks, \(id\) => !!chats\[id\]\?\.busy && !interruptedIds\.has\(id\), splitSafety\)/ },
  { name: "the chat on screen", has: /const waitingHere = \(conversationId && chatWaits\.get\(conversationId\)\) \|\| null;/ },
  // The composer's running line and its clock.
  { name: "the composer's line", has: /<Composer\b[\s\S]*?\bwaiting=\{waitingHere\}/ },
  // Its waits are the chat's own state's, beside the turn's start, and are
  // noted there from the one answer.
  { name: "the composer's clock", has: /<Composer\b[\s\S]*?\bturnStartedAt=\{chat\.turnStartedAt\}[\s\S]*?\bturnWaits=\{chat\.turnWaits\}/ },
  // The clock is told all three answers, and how whole the reading is.
  { name: "the clock's waits", has: /const waitsWhole = pendingRead\.whole;[\s\S]{0,120}?for \(const id of Object\.keys\(chats\)\) patch\(id, \(state\) => withWait\(state, seenWait\(chatWaits, id\), now, waitsWhole\)\);/ },
  // The chat list's rows, and the projects page's.
  { name: "the chat list", has: /<Sidebar\b[\s\S]*?\bwaiting=\{chatWaits\}/ },
  { name: "the working set", has: /const workingSet = useMemo\(\(\) => workingChats\(busySet, chatWaits\), / },
  { name: "the projects page", has: /<ProjectsPage\b[\s\S]*?\bbusy=\{workingSet\}/ },
  // The action bar's status, and its panel.
  { name: "the task bar", has: /<ChatTaskBar\b(?:(?!\/>)[\s\S])*?\bwaiting=\{waitingHere\}/ },
  // The task chat beside the main one, whose own status line it draws.
  { name: "the task chat beside", has: /<TaskChatPane\b(?:(?!\/>)[\s\S])*?\bwaiting=\{chatWaits\.get\(besideId\) \?\? null\}/ },
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
    // The composer's is the second `waiting={waitingHere}`: the task bar's
    // comes first in the file.
    const composerAt = app.lastIndexOf("waiting={waitingHere}");
    expect(missing(`${app.slice(0, composerAt)}waiting={null}${app.slice(composerAt + "waiting={waitingHere}".length)}`)).toEqual(["the composer's line"]);
    expect(missing(app.replace("waiting={chatWaits}", ""))).toEqual(["the chat list"]);
    expect(missing(app.replace("busy={workingSet}", "busy={busySet}"))).toEqual(["the projects page"]);
    expect(missing(app.replace("waitingChats(pendingList, ", "waitingChats(heldCards(cards), "))).toEqual(["one reading", "unknown is an answer"]);
    expect(missing(app.replace("waiting={waitingHere}", "waiting={false}"))).toEqual(["the task bar"]);
    expect(missing(app.replace("waiting={chatWaits.get(besideId) ?? null}", "waiting={false}"))).toEqual(["the task chat beside"]);
    expect(missing(app.replace("withWait(state, seenWait(chatWaits, id), now, waitsWhole)", "withWait(state, false, now)"))).toEqual(["the clock's waits"]);
    expect(missing(app.replace("turnWaits={chat.turnWaits}", "turnWaits={undefined}"))).toEqual(["the composer's clock"]);
  });
});

describe("a list that has not been read yet", () => {
  // After a reload the page's lists of what waits start empty. Read as "no
  // card", a chat its checkpoint brought back parked was drawn thinking and
  // its clock ran until the lists answered: `1m 30s` became `3m 31s`.
  it("is never handed on as `nothing waits`", () => {
    // Each of these is the page treating unknown as does-not-wait.
    // The third answer dropped where it is made:
    const noThird = app.replace(/, \{\s*whole: pendingRead\.whole, restored: restoredParks \? restoredParks\.split\(" "\) : \[\],\s*\}\)/, ")");
    expect(noThird).not.toBe(app);
    expect(missing(noThird)).toEqual(["unknown is an answer"]);
    // The reading not told what has answered, so it calls itself whole:
    const noSources = app.replace(", sources: waitSources, late: listsLate })", " })");
    expect(noSources).not.toBe(app);
    expect(missing(noSources)).toEqual(["the reading knows how whole it is"]);
    // The ledger left out of what must answer:
    const noLedger = app.replace('orchestration_snapshot: ledgerRead ? "answered" : ledgerFailed ? "failed" : "asked"', 'orchestration_snapshot: "answered"');
    expect(noLedger).not.toBe(app);
    expect(missing(noLedger)).toEqual(["what has answered"]);
    // The clock told yes or no, as it was, with unknown folded into no:
    const twoAnswers = app.replace("withWait(state, seenWait(chatWaits, id), now, waitsWhole)", "withWait(state, chatWaits.has(id), now)");
    expect(twoAnswers).not.toBe(app);
    expect(missing(twoAnswers)).toEqual(["the clock's waits"]);
    // The clock told the answer but not how whole the reading is:
    const noWhole = app.replace("withWait(state, seenWait(chatWaits, id), now, waitsWhole)", "withWait(state, seenWait(chatWaits, id), now)");
    expect(missing(noWhole)).toEqual(["the clock's waits"]);
    // No chat counted as restored:
    const noRestored = app.replace("parkRestored(chats[id])", "false");
    expect(noRestored).not.toBe(app);
    expect(missing(noRestored)).toEqual(["the restored waits"]);
  });

  it("is one of the reader's own answers, drawn by every surface that follows it", () => {
    // `unknown` is a value of the one map, so a surface handed the map or a
    // value of it has the third answer: no surface is told by a flag beside.
    expect(chatWait).toMatch(/export type ChatHold = ChatWait \| "unknown" \| "unchecked";/);
    expect(chatWait).toMatch(/\): ReadonlyMap<string, ChatHold> \{/);
    // Held until the reading is whole, under one of two words: still
    // checking, or could not check. Never let go while a list is unread.
    expect(chatWait).toMatch(/if \(unsettled\.whole !== "read"\) \{\s*const held = unsettled\.whole === "unread" \? "unknown" : "unchecked";\s*for \(const chat of unsettled\.restored\) if \(!waits\.has\(chat\)\) waits\.set\(chat, held\);/);
    // Nothing in the app asks how whole the reading is but the reading's
    // own two consumers: no side reader of `whole` for one surface.
    expect(app.match(/pendingRead\.whole/g)).toHaveLength(3);
    // Where each request stands is handed to the reading and nowhere else.
    expect(app.match(/\blistsRead\b/g)).toHaveLength(3);
    expect(app.match(/\bwaitSources\b/g)).toHaveLength(3);
  });

  it("ends a restored wait on a read and on nothing else: no give-up, no guess", () => {
    // A list that failed twice, or said nothing for five minutes, proves
    // nothing. The clock used to let the wait go there and count on a guess.
    expect(turnClock).toMatch(/if \(before\.restored && read !== "read"\) return before;/);
    const code = turnClock.replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*/g, "");
    // Nothing in the clock makes a guess or reads one, but the one line that
    // leaves out a guess an older checkpoint still holds.
    expect(code.match(/guessed/g)).toHaveLength(4);
    expect(code).toMatch(/const old = \(mine as \{ guessed\?: number \} \| undefined\)\?\.guessed;/);
    expect(code).not.toMatch(/"gaveUp"\)|=== "gaveUp"/);
    // The mutation: the wait let go when the page gives up, as it was.
    const guessing = turnClock.replace('if (before.restored && read !== "read") return before;', 'if (before.restored && read === "unread") return before;');
    expect(guessing).not.toBe(turnClock);
    expect(guessing).not.toMatch(/if \(before\.restored && read !== "read"\) return before;/);
    // The person's way to ask again is the composer's, and asks every source.
    expect(app).toMatch(/const recheckWaits = useCallback\(\(\) => \{\s*rereadLists\(\);\s*void orchestrationFeed\.refresh\(\)\.catch\(\(\) => \{\}\);\s*\}, \[rereadLists\]\);/);
    expect(app).toMatch(/waiting=\{waitingHere\}\s*onRecheckWaits=\{recheckWaits\}/);
    expect(requests).toMatch(/const reread = useCallback\(\(\) => setRound\(\(n\) => n \+ 1\), \[\]\);/);
    expect(requests).toMatch(/\}, \[conn, round\]\);/);
    // A host with no such list has answered, and emptily; any other failure
    // says nothing.
    expect(requests).toMatch(/if \(lacksCommand\(problem\)\) return true;\s*throw problem;/);
  });

  it("names every request that must answer", () => {
    expect(pendingActions).toMatch(/export const WAIT_SOURCES = \["permission_pending", "access_request_pending", "question_pending", "safety_block_pending", "orchestration_snapshot"\] as const;/);
    // Each card list is asked for by its own name, marked as it answers.
    for (const list of ["permission_pending", "safety_block_pending", "question_pending", "access_request_pending"]) {
      expect(requests).toMatch(new RegExp(`refill\\(\\w+, "${list}"`));
    }
    expect(requests).toMatch(/\(answered\) => mark\(command, answered \? "answered" : "failed"\)/);
    // Every list is unread again on a new connection, and before the first.
    expect(requests).toMatch(/useState<ListsRead>\(ASKED\)/);
    expect(requests).toMatch(/if \(conn !== "open"\) return;[\s\S]{0,120}?setRead\(ASKED\);\s*setLate\(false\);\s*const silent = setTimeout\(\(\) => setLate\(true\), SILENT_MS\);/);
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
    expect(waitingProps(app).sort()).toEqual(["chatWaits", "chatWaits.get(besideId) ?? null", "waitingHere", "waitingHere"]);
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
    const taskBar = app.replace("waiting={waitingHere}", was);
    expect(taskBar).not.toBe(app);
    expect(rawReaders(taskBar)).toHaveLength(1);
    expect(missing(taskBar)).toEqual(["the task bar"]);
    // And the task chat beside it, which never asked the one answer at all.
    const beside = app.replace(
      "waiting={chatWaits.get(besideId) ?? null}",
      "waiting={(asks[besideId]?.length ?? 0) + (questions[besideId]?.length ?? 0) + (safetyBlocks[besideId]?.length ?? 0) > 0}",
    );
    expect(beside).not.toBe(app);
    expect(rawReaders(beside)).toHaveLength(1);
    expect(missing(beside)).toEqual(["the task chat beside"]);
    // A count of the page's own list is a second reading too.
    expect(rawReaders(app.replace("waiting={waitingHere}", "waiting={pendingList.some((action) => action.chatId === conversationId)}"))).toHaveLength(1);
  });
});

describe("the reading of which chats wait", () => {
  it("is drawn from the list of pending actions and reads nothing else", () => {
    const code = chatWait.replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*/g, "");
    // No second reader of the cards, the ledger or its waits.
    expect(code).not.toMatch(/\b(gates|nativeDecisions|awaits|heldCards|ledgerWaits|runWaits|orchestration)\b/);
    expect([...code.matchAll(/from "([^"]+)"/g)].map((match) => match[1])).toEqual(["./pendingActions"]);
    // Nor does it read a request's state itself: how whole the reading is,
    // is the reading's word.
    expect(code).not.toMatch(/\b(sources|SourceRead|wholeOf|listsRead|late)\b/);
  });
});
