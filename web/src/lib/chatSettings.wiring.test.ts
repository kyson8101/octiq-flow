// The level said beside the agent's name is the level the page holds for
// the chat: the one it starts the chat with and saves with it.
//
// Since 0.3.10 a chat's level is its own (AGENTS.md, "A chat's level is its
// own"): it opens on its agent's registered settings and then keeps the
// level it has, the page sends the level it holds and works nothing out, no
// host rule raises a chat at a start and no event carries a level. So what
// the chat runs at is that one held value, and never the registration's.
//
// `chatSettings.test.ts` is what the text says of a level it is handed. This
// file reads `App.tsx` as text for the hand-off: which value the text gets,
// where that value comes from when a saved chat is opened, and that it is
// the value a start asks for. It is an alarm on the wiring's spelling, not a
// proof of behaviour: no test renders the app.
import { describe, expect, it } from "vitest";
import app from "../App.tsx?raw";

/** The body of the memo that makes the composer's settings text. */
function runsAtMemo(source: string): string {
  const at = source.indexOf("const runsAt = useMemo(");
  if (at < 0) return "";
  return source.slice(at, source.indexOf(");", source.indexOf("],", at)) + 2);
}

const SITES: { name: string; has: RegExp }[] = [
  // The one level the page holds for the chat on screen.
  { name: "the held level", has: /const \[access, setAccess\] = useState<AccessLevel>\(/ },
  // A saved chat is opened at its own record's level.
  { name: "a saved chat's own level", has: /const conversationAccess = accessFor\(model\.agent, \(c\.permission as AccessLevel\) \?\? "read"\);[\s\S]{0,900}?\bsetAccess\(conversationAccess\);/ },
  // The text is handed that level and the chat's own record.
  { name: "the text's level", has: /knownSettings\(\{\s*record: conversationId \? openRecord : null,\s*reported: chat\.model, choice, effort, access,\s*\}\)/ },
  { name: "the composer", has: /<Composer\b[\s\S]*?\brunsAt=\{runsAt\}/ },
  // A start asks for the same value: the send's own, and the start a
  // completion or a plan's Start hands the host.
  { name: "a send's start", has: /bridge\.invoke\("chat_start", \{\s*key: keyFor\(id\),\s*cwd: launchCwd,[\s\S]{0,900}?\s+access,\s+effort,/ },
  { name: "the host's own first turn", has: /const startSettingsOf = useCallback\([\s\S]{0,700}?\s+access,\s+effort,[\s\S]{0,200}?\}, \[workspaces, project, choice, access, effort, lite\]\);/ },
];

/** What the check says is missing, for the page as it is and for a mutation
 *  of it. */
function missing(source: string): string[] {
  const out = SITES.filter((site) => !site.has.test(source)).map((site) => site.name);
  const memo = runsAtMemo(source);
  // The registration is not the chat's level: the memo names nothing of the
  // roster, the agent or its registered settings.
  if (/\b(?:roster|lead|leads|chatLead|leadSettings|recipients|registered|frontDesk)\b/.test(memo)) out.push("no registration in the text");
  // No event carries a level (develop's review of the mirror: an unordered
  // frame put back a level the person had just changed).
  if (/chat-access-changed/.test(source)) out.push("no level event");
  // Nothing of the page narrows a chat to read-only by itself.
  if (/\bdiscussUnsent\b|\bcanDiscussUnsent\b|writerConflict|handover_discuss/.test(source)) out.push("no read-only retry");
  return out;
}

describe("the level beside the agent's name is the one the page starts the chat with", () => {
  it("is wired so in the app", () => {
    expect(runsAtMemo(app)).toContain("knownSettings(");
    expect(missing(app)).toEqual([]);
  });

  it("fails when the text is handed the registration's level instead", () => {
    const fromRoster = app.replace(
      "reported: chat.model, choice, effort, access,",
      "reported: chat.model, choice, effort, access: leadSettings(lead!)?.access ?? access,",
    );
    expect(fromRoster).not.toBe(app);
    expect(missing(fromRoster)).toEqual(expect.arrayContaining(["the text's level", "no registration in the text"]));
  });

  it("fails when a saved chat is opened at another level than its record's", () => {
    const fromAgent = app.replace("setAccess(conversationAccess);", "setAccess(access);");
    expect(fromAgent).not.toBe(app);
    expect(missing(fromAgent)).toContain("a saved chat's own level");
  });

  it("fails when a start asks for another level than the one the text says", () => {
    const narrowed = app.replace(/(cwd: launchCwd,[\s\S]{0,900}?\s+)access,(\s+effort,)/, "$1access: sendAccess,$2");
    expect(narrowed).not.toBe(app);
    expect(missing(narrowed)).toContain("a send's start");
  });

  it("fails when a level event, or the read-only retry, is put back", () => {
    expect(missing(`${app}\nbridge.listen("chat-access-changed", () => {});`)).toContain("no level event");
    expect(missing(`${app}\nconst discussUnsent = () => {};`)).toContain("no read-only retry");
  });
});
