// Changing what an agent's chat runs on goes through the host and nowhere
// else. This reads the sources as text for the hand-off, the way
// `chatSettings.wiring.test.ts` does: an alarm on the wiring's spelling, not
// a proof of behaviour (no test renders the app).
//
// - Both controls send `chat_switch_runtime`. `changeModel` ends the chat's
//   process itself, which would stall a turn in flight: these chats never
//   use it.
// - The page's `choice` and `effort` move only on the host's word: the
//   `chat-provider-switch` event and a `switched` answer, both through
//   `applyHostRuntime`. Never optimistically, never from a press.
// - A request is sent through `lib/inFlight`, keyed by chat.
// - Not offered for a worker's chat, a front desk, a removed agent's chat or
//   a conversation not sent yet: no row and a read-only chip.
import { describe, expect, it } from "vitest";
import app from "../App.tsx?raw";
import hook from "./useRuntimeSwitch.ts?raw";
import sheet from "../components/RuntimeSheet.tsx?raw";
import rows from "../components/RuntimeRows.tsx?raw";
import composer from "../components/Composer.tsx?raw";

/** The body of `fn` from its declaration to the first closing at its own indent. */
function body(source: string, declaration: string): string {
  const at = source.indexOf(declaration);
  if (at < 0) return "";
  const end = source.indexOf("\n  }, [", at);
  return source.slice(at, end < 0 ? at + 1200 : end);
}

function missing(sources: { app: string; hook: string; sheet: string; rows: string; composer: string }): string[] {
  const out: string[] = [];
  const { app: a, hook: h } = sources;
  // The command is asked in one place.
  if (!/bridge\.invoke\([^)]*"chat_switch_runtime"/.test(h)) out.push("the hook asks the host");
  if (/"chat_switch_runtime"/.test(a)) out.push("only the hook sends it");
  if (!/takeAnswer\(held\.current/.test(h) || !/if \(taken\.apply\) switched\.current/.test(h)) out.push("a switched answer is applied only when the revision guard took it");
  if (/if \(done\.state === "switched"\) switched\.current/.test(h)) out.push("never apply an answer unconditionally");
  if (/once\(runtimeFlight\(chatId\)/.test(h) === false) out.push("one request per chat, through lib/inFlight");
  // The two controls ask the host and never `changeModel`.
  const pick = body(a, "const switchTo = useCallback(") + body(a, "const pickRuntime = useCallback(") + body(a, "const pickRuntimeEffort = useCallback(");
  if (!body(a, "const switchTo = useCallback(").includes("askRuntime(")) out.push("the pickers ask the host");
  if (/changeModel|changeEffort|setChoice|setEffort|endSession|chat_stop|chat_start/.test(pick)) out.push("the pickers never change the chat themselves");
  // H2: in a registered agent's chat every model or effort pick is a switch,
  // whatever agents mode is. The host's fact decides, never the roster, and
  // the composer's pickers and the main-agent select all go through it.
  const entry = body(a, "const pickModel = useCallback(") + body(a, "const pickEffort = useCallback(");
  if (!/if \(switchChat\) return pickRuntime\(c\);/.test(entry) || !/if \(switchChat\) return pickRuntimeEffort\(e\);/.test(entry)) out.push("a pick in a registered chat is a switch");
  // A pick on a saved, sent chat whose registration the host has not said
  // waits for it and, when the read fails, is refused in words.
  const unread = a.slice(a.indexOf("const picksAfterRead ="), a.indexOf("const pickEffort = useCallback("));
  if (!/const picksAfterRead = [^;]*runtimeSwitch\.registeredOf\(conversationId\) === undefined;/.test(a)) out.push("a pick before the host has said waits for it");
  if (!/afterRead\(conversationId, "the model"/.test(unread) || !/afterRead\(conversationId, "the effort"/.test(a)) out.push("both pickers wait for the host's word");
  if (!/fact\.kind === "failed"[\s\S]{0,400}Nothing was changed\./.test(a)) out.push("a failed read is refused in words");
  if (!/runtimeSwitch\.whenRead\(id\)/.test(a)) out.push("the wait is the hook's one read");
  if (!/picksThroughSwitch\(\{\s*registered: runtimeSwitch\.registeredOf\(conversationId\),/.test(a)) out.push("registered comes from the host's fact");
  if (/onChoice=\{changeModel\}|onEffort=\{changeEffort\}|if \(model\) changeModel\(model\)/.test(a) || !/onChoice=\{pickModel\}/.test(a) || !/onEffort=\{pickEffort\}/.test(a)) out.push("no picker reaches changeModel directly");
  const switchChatDecl = a.slice(a.indexOf("const switchChat ="), a.indexOf("const liveRuntime"));
  if (/agentsMode|composerIdentity|roster|frontDeskChats/.test(switchChatDecl)) out.push("registered is not read from agents mode or a roster cache");
  if (!/readRegistered\(queue\?\.registered\)/.test(h)) out.push("the hook reads the host's registered fact");
  // When the chat turns out to be registered the page takes the host's runtime.
  if (!/fact\.kind === "registered" && runtime && \(held\.current\[chatId\]\?\.rev \?\? 0\) === rev\) hostRuntime\.current\?\.\(chatId, runtime\)/.test(h) || !/useRuntimeSwitch\(conn, conversationId, applyHostRuntime, takeHostRuntime\)/.test(a)) out.push("registered brings the host's runtime");
  // The way back asks the host with the home runtime.
  if (!/onBack=\{\(home\) => void askRuntime\(runtimeChat, \{ agent: home\.agent, model: home\.model, effort: home\.effort \}, "row"\)\}/.test(a)) out.push("the way back asks for the home runtime");
  // The page's settings follow the host's word, by one function.
  const apply = body(a, "const applyHostRuntime = useCallback(");
  if (!/setChoice\(next\)/.test(apply)) out.push("the host's word moves the page's settings");
  if (!/useRuntimeSwitch\(conn, conversationId, applyHostRuntime, takeHostRuntime\)/.test(a)) out.push("a switched answer goes through applyHostRuntime");
  if (!/"chat-provider-switch"[\s\S]{0,400}applyHostRuntime\(id, payload\)/.test(a)) out.push("the event goes through applyHostRuntime");
  if (/setChoice|setEffort|setAccess/.test(h)) out.push("the hook never moves the settings");
  // Nothing optimistic in the controls.
  if (/setChoice|setEffort|changeModel/.test(sources.sheet)) out.push("the sheet never sets the page's choice");
  if (/setChoice|setEffort/.test(sources.rows)) out.push("the row never sets the page's choice");
  // Who is offered it.
  if (!/runtimeSwitchable\(\{[\s\S]{0,400}removed: !!composerIdentity\.removed,\s*workerChat,\s*frontDesk: frontDeskChats\.has\(conversationId\),\s*saved: !!openRecord,\s*started: chat\.messages\.length > 0,/.test(a)) out.push("who is offered it");
  if (!/\{runtimeChat && \(\s*<RuntimeRows/.test(a)) out.push("the row only for a chat that is offered it");
  if (!/runtime=\{runtimeChat \? \{/.test(a)) out.push("the chip's pickers only for a chat that is offered it");
  if (!/runtime=\{runtime && session \?/.test(sources.composer)) out.push("the composer hands the chip its pickers");
  // No access control here.
  if (/<AccessList|\bonAccess\b|chat_set_access|invoke\([^)]*request_access/.test(sources.sheet + sources.rows)) out.push("no access control");
  return out;
}

const ALL = { app, hook, sheet, rows, composer };

describe("changing a chat's runtime goes through the host", () => {
  it("is wired so in the app", () => {
    expect(missing(ALL)).toEqual([]);
  });

  it("fails when a picker goes through changeModel, which ends the process", () => {
    const mutated = app.replace("void askRuntime(id, asked, \"sheet\");", "changeModel(model as ModelChoice);");
    expect(mutated).not.toBe(app);
    expect(missing({ ...ALL, app: mutated })).toContain("the pickers never change the chat themselves");
  });

  it("fails when the ordinary picker is wired straight to changeModel again (H2)", () => {
    const mutated = app.replace("onChoice={pickModel}", "onChoice={changeModel}");
    expect(mutated).not.toBe(app);
    expect(missing({ ...ALL, app: mutated })).toContain("no picker reaches changeModel directly");
  });

  it("fails when a pick in a registered chat takes the ordinary path (H2)", () => {
    const mutated = app.replace("if (switchChat) return pickRuntime(c);", "");
    expect(mutated).not.toBe(app);
    expect(missing({ ...ALL, app: mutated })).toContain("a pick in a registered chat is a switch");
  });

  it("fails when a pick before the host has said which chat this is takes the ordinary path", () => {
    const mutated = app.replace("&& runtimeSwitch.registeredOf(conversationId) === undefined;", "&& false;");
    expect(mutated).not.toBe(app);
    expect(missing({ ...ALL, app: mutated })).toContain("a pick before the host has said waits for it");
  });

  it("fails when a failed read of the fact lets the pick through silently", () => {
    const mutated = app.replace("Nothing was changed.`", "`");
    expect(mutated).not.toBe(app);
    expect(missing({ ...ALL, app: mutated })).toContain("a failed read is refused in words");
  });

  it("fails when the effort picker does not wait for the host's word", () => {
    const mutated = app.replace("afterRead(conversationId, \"the effort\"", "((id: string, what: string, go: (registered: boolean) => void) => go(false))(conversationId, \"the effort\"");
    expect(mutated).not.toBe(app);
    expect(missing({ ...ALL, app: mutated })).toContain("both pickers wait for the host's word");
  });

  it("fails when the page does not take the host's runtime once the chat is known to be registered", () => {
    const mutated = hook.replace("hostRuntime.current?.(chatId, runtime)", "undefined");
    expect(mutated).not.toBe(hook);
    expect(missing({ ...ALL, hook: mutated })).toContain("registered brings the host's runtime");
  });

  it("fails when registered is worked out from agents mode (H2)", () => {
    const mutated = app.replace("const switchChat = conversationId && !workerChat && picksThroughSwitch({", "const switchChat = conversationId && agentsMode && !workerChat && picksThroughSwitch({");
    expect(mutated).not.toBe(app);
    expect(missing({ ...ALL, app: mutated })).toContain("registered is not read from agents mode or a roster cache");
  });

  it("fails when the hook ignores the host's registered fact (H2)", () => {
    const mutated = hook.replace("readRegistered(queue?.registered)", "undefined");
    expect(mutated).not.toBe(hook);
    expect(missing({ ...ALL, hook: mutated })).toContain("the hook reads the host's registered fact");
  });

  it("fails when the hook moves the page's settings on a press", () => {
    const mutated = hook.replace("const rev = held.current[chatId]?.rev ?? 0;\n    const done", "setChoice(runtime);\n    const rev = held.current[chatId]?.rev ?? 0;\n    const done");
    expect(mutated).not.toBe(hook);
    expect(missing({ ...ALL, hook: mutated })).toContain("the hook never moves the settings");
  });

  it("fails when a switched answer is applied without the revision guard (M1)", () => {
    const mutated = hook.replace("if (taken.apply) switched.current(chatId, done);", "if (done.state === \"switched\") switched.current(chatId, done);");
    expect(mutated).not.toBe(hook);
    expect(missing({ ...ALL, hook: mutated })).toContain("never apply an answer unconditionally");
  });

  it("fails when the request is not held by chat", () => {
    const mutated = hook.replace("once(runtimeFlight(chatId)", "(async (key: string, send: () => Promise<unknown>) => send())(chatId");
    expect(mutated).not.toBe(hook);
    expect(missing({ ...ALL, hook: mutated })).toContain("one request per chat, through lib/inFlight");
  });

  it("fails when the row is drawn for every chat", () => {
    const mutated = app.replace("{runtimeChat && (\n                <RuntimeRows", "{conversationId && (\n                <RuntimeRows");
    expect(mutated).not.toBe(app);
    expect(missing({ ...ALL, app: mutated })).toContain("the row only for a chat that is offered it");
  });

  it("fails when a worker's chat is offered it", () => {
    const mutated = app.replace("    workerChat,\n    frontDesk: frontDeskChats.has(conversationId),", "    workerChat: false,\n    frontDesk: frontDeskChats.has(conversationId),");
    expect(mutated).not.toBe(app);
    expect(missing({ ...ALL, app: mutated })).toContain("who is offered it");
  });

  it("fails when the sheet grows an access control", () => {
    expect(missing({ ...ALL, sheet: sheet + "\nconst a = onAccess;" })).toContain("no access control");
  });
});
