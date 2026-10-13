// The page never opens, re-sends or switches a chat to read-only of its own
// accord, and it starts a registered agent's chat at that agent's level.
//
// `agentsMode.test.ts` tables the rule itself (`startAccess`). This file is
// the hand-off: it reads the source as text, the way `runWaits.wiring.test.ts`
// does, because nothing here renders `App`. It is an alarm on spelling, not a
// proof of behaviour: a start written some other way passes it unseen. What
// it does catch is the two things that were removed coming back, and a start
// that reads the level off the composer again.
import { describe, expect, it } from "vitest";
import app from "../App.tsx?raw";

const sources = import.meta.glob<string>("../**/*.{ts,tsx}", { query: "?raw", import: "default", eager: true });
const shipped = Object.entries(sources).filter(([path]) => !/\.test\.tsx?$/.test(path) && !path.includes("__fixtures__"));

/** One step of the hand-off in `App.tsx`: what it is, and the text that makes it. */
const SITES: { name: string; has: RegExp }[] = [
  // Who a chat is with, asked of the roster as it is at that moment.
  { name: "the chat's agent, from the roster now", has: /conversationAgent\(keyFor\(id\), leadsRef\.current, rosterRef\.current\)/ },
  // A worker's chat and the front desk's are never raised.
  { name: "not a worker's chat or the front desk's", has: /isWorkerChat\(id, chatParentsRef\.current\) \|\| frontDeskChatIds\.current\.has\(id\)\) return null;/ },
  // A running process keeps the level it has.
  { name: "a running process is left alone", has: /runningRef\.current\.has\(id\) \? saved : startAccess\(saved, agentOfChat\(id\), provider\)/ },
  // Opening a chat, and the task beside it.
  { name: "opening a chat", has: /const conversationAccess = startLevel\(c\.id, accessFor\(model\.agent, \(c\.permission as AccessLevel\) \?\? "read"\), model\.agent\);/ },
  { name: "the chat beside", has: /access: startLevel\(\s*besideConversation\.id, accessFor\(model\.agent, \(besideConversation\.permission as AccessLevel\) \?\? "read"\), model\.agent,\s*\)/ },
  // The roster arriving after the chat was opened.
  { name: "the roster arriving later", has: /const level = startLevel\(conversationId, held\.access,[^;]*;\s*if \(level === held\.access\) return;\s*held\.access = level;\s*setAccess\(level\);\s*\}, \[conversationId, roster, leads, running,/ },
  // A send: asked at the send, and again at the start itself.
  { name: "the send", has: /const sendAccess = conversationId \? startLevel\(conversationId, access, choice\.agent\) : access;/ },
  { name: "the start a send makes", has: /const startAt = startAccess\(sendAccess, agentOfChat\(id\), choice\.agent\);[\s\S]*?bridge\.invoke\("chat_start", \{[\s\S]*?\baccess: startAt,/ },
  // Complete, for a chat with no process, and a run's coordinator.
  { name: "completing a chat", has: /completions\.complete\(id, \{[\s\S]*?\baccess: startAccess\(access, agentOfChat\(id\), choice\.agent\),/ },
  { name: "a run's coordinator", has: /"orchestration_master_start", \{[\s\S]*?\baccess: startLevel\(id, access, choice\.agent\),/ },
];

const missing = (source: string) => SITES.filter((site) => !site.has.test(source)).map((site) => site.name);

describe("the level a chat is started at, in the app", () => {
  it("is the roster-aware one at every start", () => {
    expect(missing(app)).toEqual([]);
  });

  it("fails when a start reads the composer's level again", () => {
    expect(missing(app.replace("access: startAt,", "access: sendAccess,"))).toEqual(["the start a send makes"]);
    expect(missing(app.replace(
      "const sendAccess = conversationId ? startLevel(conversationId, access, choice.agent) : access;",
      "const sendAccess = access;",
    ))).toEqual(["the send"]);
    expect(missing(app.replace("access: startAccess(access, agentOfChat(id), choice.agent),", "access,")))
      .toEqual(["completing a chat"]);
    expect(missing(app.replace("runningRef.current.has(id) ? saved : startAccess(saved, agentOfChat(id), provider)", "saved")))
      .toEqual(["a running process is left alone"]);
  });

  it("is passed to every chat_start in the app, never the composer's own", () => {
    // Two starts: a send's, and a pull-request chat's, whose level is its
    // request's (`lib/pullRequests`: Study and Review are read by design).
    const starts = [...app.matchAll(/bridge\.invoke\("chat_start", \{([\s\S]*?)\n\s*\}\);/g)].map((match) => match[1]);
    expect(starts).toHaveLength(2);
    expect(starts.map((body) => /\baccess: (\w+),/.exec(body)?.[1])).toEqual(["startAt", "launchAccess"]);
  });
});

describe("nothing on the page makes a chat read-only of its own accord", () => {
  /** Files that say `needle`, by path. */
  const saying = (needle: RegExp) => shipped.filter(([, text]) => needle.test(text)).map(([path]) => path).sort();

  it("has no command and no control for a read-only discussion", () => {
    expect(saying(/handover_discuss/)).toEqual([]);
    expect(saying(/Discuss (only|read-only)|read-only to discuss|[Rr]ead-only discussion|discussion, read-only/)).toEqual([]);
    expect(saying(/onDiscuss|canDiscuss|DISCUSS_NOTICE|writerConflict/)).toEqual([]);
  });

  it("names the level read outright only where it is the person's or a request's", () => {
    // A level is changed for a running chat by `chat_set_access`, and never
    // to a level written into the page.
    expect(saying(/chat_set_access"[^)]*access: "/)).toEqual([]);
    // `access: "read"` as a value handed on: a pull-request Study or Review
    // chat, which the person starts as that (`lib/pullRequests`).
    expect(saying(/\baccess: "read"/)).toEqual(["./pullRequests.ts"]);
    expect(saying(/setAccess\("read"\)/)).toEqual([]);
  });
});
