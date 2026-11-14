import { IDBFactory } from "fake-indexeddb";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { addUserTurn, emptyChat, type ChatState } from "./chat";
import { CatchUp, type Frame } from "./catchUp";
import { saveChatCheckpoint } from "./chatCache";
import { ChatHistory } from "./chatHistory";
import { forgetHiddenScans, loadChat } from "./loadChat";
import { reconcileQueueSnapshot } from "./messageQueue";
import { replayChat } from "./replayChat";

beforeEach(() => { vi.stubGlobal("indexedDB", new IDBFactory()); forgetHiddenScans(); });
afterEach(() => vi.unstubAllGlobals());

// Shaped like the record of chat b6f57a25: the turn's record, its
// "dispatched" delivery line and the Claude echo sit far below the tail the
// page reads on reopen, because the turn then ran for an hour.
const TURN = "user-2e3c0441-1e68-4444-90a5-c5e9ff77aaf0";
const answer = (seq: number): Frame => ({ seq, event: {
  type: "assistant", message: { id: `m${seq}`, content: [{ type: "text", text: `answer ${seq}` }] } } });
const echo = (seq: number): Frame => ({ seq, event: {
  type: "user", uuid: `echo-${seq}`, isReplay: true, octiq_user_turn_id: TURN,
  message: { content: [{ type: "text", text: "开给 CD 一 帧帧 review" }] } } });
const dispatched = (seq: number): Frame => ({ seq, event: { type: "octiq_user_turn_delivery", uuid: TURN, state: "dispatched" } });

function setup() {
  let state: ChatState = emptyChat();
  return { id: "a", key: "chat:a", catchUp: new CatchUp(),
    getState: () => state, publish: (next: ChatState) => { state = next; }, cancelled: () => false };
}

/** A retained tab that sent the prompt, then went offscreen and saw nothing
 * more; the host record moved on by `gap` lines. */
async function retainedTab() {
  const options = setup();
  const seeded = await replayChat(emptyChat(), [answer(1)], 0, () => false);
  await saveChatCheckpoint({ id: "a", seq: 1, state: seeded, updatedAt: 1 });
  const sent = addUserTurn(seeded, "开给 CD 一 帧帧 review", [], 10, TURN);
  options.publish({ ...sent, messages: sent.messages.map(m => m.turnId === TURN ? { ...m, delivery: "queued" as const } : m) });
  return options;
}

/** A host record `total` lines long; each page holds up to 100 lines. */
function host(lines: Record<number, Frame>, total = 1000) {
  const requestPage = vi.fn(async (before: number | null) => {
    const end = before ?? total + 1, start = Math.max(1, end - 100);
    const events: Frame[] = [];
    for (let seq = start; seq < end; seq++) events.push(lines[seq] ?? answer(seq));
    return { events, context: [], before: start > 1 ? start : null };
  });
  return requestPage;
}

const queueGone = { live: false, queuedTurnIds: [] as string[] };


const queuedEnvelope: Frame = { seq: 1, event: { type: "user", uuid: TURN, octiq_user_turn: true,
  message: { content: [{ type: "text", text: "queued on host" }] } } };
async function hostQueuedTab() {
  const o=setup();
  const s=await replayChat(emptyChat(),[queuedEnvelope,{seq:2,event:{type:"octiq_user_turn_delivery",uuid:TURN,state:"queued"}}],0,()=>false);
  await saveChatCheckpoint({id:o.id,seq:2,state:s,updatedAt:1}); o.publish(s);return o;
}
it.each(["octiq_user_turn_cancelled","octiq_user_turn_dismissed"])("REVIEW first missing seq: %s at mark+1", async type => {
  const options=await hostQueuedTab();
  await loadChat({...options,history:new ChatHistory(),request:async()=>[],requestPage:host({1:queuedEnvelope,3:{seq:3,event:{type,uuid:TURN}}})});
  expect(options.getState().messages.find(m=>m.turnId===TURN)).toBeUndefined();
});

it("REVIEW modern queued host prompt later delivered is not condemned after negative-cache reopen", async()=>{
  const options=await hostQueuedTab(); const history=new ChatHistory();
  await loadChat({...options,history,request:async()=>[],requestPage:host({1:queuedEnvelope,2:{seq:2,event:{type:"octiq_user_turn_delivery",uuid:TURN,state:"queued"}}})});
  const s=options.getState(); options.publish(reconcileQueueSnapshot(s,s,{live:true,queuedTurnIds:[TURN]}));
  await loadChat({...options,history,request:async()=>[],requestPage:host({1050:dispatched(1050),1051:echo(1051)},2000)});
  const current=options.getState(); const after=reconcileQueueSnapshot(current,current,queueGone);
  expect(after.messages.find(m=>m.turnId===TURN)).toBeUndefined();
});

it("REVIEW multiple prompts plus failed page read preserves newest host failure", async () => {
  const options = await retainedTab();
  options.publish(addUserTurn(options.getState(), "another local", [], 11, "other"));
  const paged = host({
    810: {seq: 810, event: {type: "octiq_user_turn_delivery", uuid: TURN, state: "queued"}},
    850: {seq: 850, event: {type: "octiq_user_turn_delivery", uuid: TURN, state: "failed"}},
  });
  await loadChat({ ...options, history: new ChatHistory(), request: async () => [], requestPage: async before => {
    if (before !== null && before <= 801) throw Error("offline");
    return paged(before);
  } });
  expect(options.getState().messages.find(m => m.turnId === TURN)).toMatchObject({ delivery: "failed", queueLost: true });
});

it("REVIEW a negative scan must not hide a later real host failure on reopen", async () => {
  const options = await retainedTab();
  const history = new ChatHistory();
  await loadChat({ ...options, history, request: async () => [], requestPage: host({}) });
  // The message's send was slow while the first scan read a stable old prefix.
  // The host then receives it, but fails dispatch, while this tab is offscreen.
  const pages = host({ 1050: {seq: 1050, event: { type: "octiq_user_turn_delivery", uuid: TURN, state: "failed" }} }, 2000);
  await loadChat({ ...options, history, request: async () => [], requestPage: pages });
  expect(options.getState().messages.find(m => m.turnId === TURN)).toMatchObject({ delivery: "failed", queueLost: true });
});

it.each(["octiq_user_turn_cancelled", "octiq_user_turn_dismissed"])("REVIEW two-tab cached absence must not hide later %s", async type => {
  const options = await retainedTab();
  const history = new ChatHistory();
  await loadChat({ ...options, history, request: async () => [], requestPage: host({}) });
  await loadChat({ ...options, history, request: async () => [], requestPage: host({ 1050: { seq:1050, event:{type, uuid:TURN}} }, 2000) });
  expect(options.getState().messages.find(m => m.turnId === TURN)).toBeUndefined();
});

it.each(["octiq_user_turn_cancelled", "octiq_user_turn_dismissed"])("REVIEW uncached hidden %s removes pending copy", async type => {
  const options = await retainedTab();
  await loadChat({ ...options, history: new ChatHistory(), request: async () => [], requestPage: host({ 400: {seq:400,event:{type,uuid:TURN}} }) });
  expect(options.getState().messages.find(m => m.turnId === TURN)).toBeUndefined();
});

it("REVIEW held scan: switch away before read returns never publishes obsolete state", async () => {
  const options = await retainedTab(); let cancelled = false;
  let entered!: () => void, finish!: () => void;
  const started = new Promise<void>(resolve => {entered=resolve;});
  const held = new Promise<void>(resolve => {finish=resolve;});
  const pages = host({400:echo(400)});
  const loading = loadChat({ ...options, history: new ChatHistory(), cancelled:()=>cancelled, request:async()=>[], requestPage:async before=>{
    if(before!==null){entered(); await held;}
    return pages(before);
  }});
  await started;
  cancelled=true; options.catchUp.forget(options.key);
  const afterSwitch=options.getState(); finish(); await loading;
  expect(options.getState()).toBe(afterSwitch);
});

it("REVIEW compaction mid-scan keeps logical event identity and seq", async () => {
  const options = await retainedTab();
  let compacted=false;
  const pages = host({400:echo(400)});
  await loadChat({...options,history:new ChatHistory(),request:async()=>[],requestPage:async before=>{
    if(before===null) return pages(before);
    compacted=true;
    // 401..900 redundant deltas were merged into 399; the real echo stays 400.
    if(before>401) return {events:[{seq:900,event:{type:"octiq_compacted",into:399,count:500}}, echo(400)].sort((a,b)=>a.seq-b.seq),context:[],before:400};
    return pages(before);
  }});
  expect(compacted).toBe(true);
  expect(options.getState().messages.find(m=>m.turnId===TURN)).toBeUndefined();
});

it("REVIEW two tabs and an unstamped same-text echo cannot accept a truly unsent turn", async () => {
  const a=await retainedTab(); const b=await retainedTab();
  const unstamped=echo(400); delete (unstamped.event as Record<string,unknown>).octiq_user_turn_id;
  await Promise.all([a,b].map(options=>loadChat({...options,history:new ChatHistory(),request:async()=>[],requestPage:host({400:unstamped})})));
  for(const options of [a,b]){
    const current=options.getState(); const after=reconcileQueueSnapshot(current,current,queueGone);
    expect(after.messages.find(m=>m.turnId===TURN)).toMatchObject({delivery:"failed",queueLost:true});
  }
});

it("REVIEW mixed found+absent prompts do not treat one host acknowledgement as all prompts", async () => {
  const options=await retainedTab(); options.publish(addUserTurn(options.getState(),"not sent",[],11,"other"));
  await loadChat({...options,history:new ChatHistory(),request:async()=>[],requestPage:host({400:echo(400)})});
  expect(options.getState().messages.find(m=>m.turnId===TURN)).toBeUndefined();
  const s=options.getState(); const after=reconcileQueueSnapshot(s,s,queueGone);
  expect(after.messages.find(m=>m.turnId==="other")).toMatchObject({delivery:"failed",queueLost:true});
});

it("REVIEW capped partial scan with previously inferred Not sent must remain uncertain", async () => {
  const options=await retainedTab(); const s=options.getState(); options.publish(reconcileQueueSnapshot(s,s,queueGone));
  await loadChat({...options,history:new ChatHistory(),request:async()=>[],requestPage:host({5:echo(5)},100000)});
  expect(options.getState().messages.find(m=>m.turnId===TURN)).toMatchObject({delivery:"unknown"});
});

it("REVIEW held partial scan plus idle queue poll must not retain an inferred Not sent", async()=>{
  const options=await retainedTab();let entered!:()=>void, release!:()=>void;
  const started=new Promise<void>(resolve=>{entered=resolve;});const held=new Promise<void>(resolve=>{release=resolve;});
  const pages=host({5:echo(5)},100000);let first=true;
  const loading=loadChat({...options,history:new ChatHistory(),request:async()=>[],requestPage:async before=>{
    if(before!==null&&first){first=false;entered();await held;}
    return pages(before);
  }});
  await started;const current=options.getState();options.publish(reconcileQueueSnapshot(current,current,queueGone));
  release();await loading;
  expect(options.getState().messages.find(m=>m.turnId===TURN)).toMatchObject({delivery:"unknown",queueLost:undefined});
});

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { MessageBubble } from "../components/MessageBubble";

it("REVIEW actual host page cursors: echo below the window is found (cursors of chat b6f57a25)",async()=>{
  const o=setup();const seed=await replayChat(emptyChat(),[answer(179376)],0,()=>false);
  await saveChatCheckpoint({id:o.id,seq:179376,state:seed,updatedAt:1});
  const local=addUserTurn(seed,"typed",[],10,TURN);o.publish({...local,messages:local.messages.map(m=>m.turnId===TURN?{...m,delivery:"queued" as const}:m)});
  const pages=new Map<number|null,any>([
    [null,{events:[answer(181302)],context:[],before:180779}],
    [180779,{events:[answer(180778)],context:[],before:180020}],
    [180020,{events:[answer(180019)],context:[],before:179996}],
    [179996,{events:[{...queuedEnvelope,seq:179377},dispatched(179378),echo(179387),answer(179995)],context:[],before:179377}],
  ]);
  const requestPage=vi.fn(async before=>pages.get(before));
  await loadChat({...o,history:new ChatHistory(),request:async()=>{throw Error("unbounded");},requestPage});
  const current=o.getState();const after=reconcileQueueSnapshot(current,current,queueGone);
  expect(after.messages.find(m=>m.turnId===TURN)).toBeUndefined();expect(requestPage).toHaveBeenCalledTimes(4);
});

it("REVIEW truly unsent prompt still renders Not sent and Restore",async()=>{
  const o=await retainedTab();await loadChat({...o,history:new ChatHistory(),request:async()=>[],requestPage:host({})});
  const current=o.getState();const msg=reconcileQueueSnapshot(current,current,queueGone).messages.find(m=>m.turnId===TURN)!;
  const html=renderToStaticMarkup(createElement(MessageBubble,{user:true,message:msg,onRestore:()=>{},children:"typed"}));
  expect(html).toContain("Not sent");expect(html).toContain("Restore to composer");expect(msg.echo).toBeUndefined();expect(msg.takenUp).toBeFalsy();
});

it("H1 an absence read once is not asked again for the same range", async () => {
  const options = await retainedTab(); const history = new ChatHistory();
  const first = host({});
  await loadChat({ ...options, history, request: async () => [], requestPage: first });
  const calls = first.mock.calls.length;
  await loadChat({ ...options, history, request: async () => [], requestPage: first });
  expect(first.mock.calls.length).toBeLessThanOrEqual(calls + 1);
});

it("H2 the first unseen line is read: a prompt echoed exactly at mark+1 is accepted", async () => {
  const options = await retainedTab(); // checkpoint mark is 1, so mark+1 is 2
  await loadChat({ ...options, history: new ChatHistory(), request: async () => [], requestPage: host({ 2: echo(2) }) });
  expect(options.getState().messages.find(m => m.turnId === TURN)).toBeUndefined();
});

it("H2 a line at the mark itself is not news about the gap", async () => {
  const options = await retainedTab();
  const old: Frame = { seq: 1, event: { type: "user", uuid: "echo-1", isReplay: true, octiq_user_turn_id: TURN, message: { content: [{ type: "text", text: "x" }] } } };
  await loadChat({ ...options, history: new ChatHistory(), request: async () => [], requestPage: host({ 1: old }) });
  expect(options.getState().messages.find(m => m.turnId === TURN)).toMatchObject({ delivery: "queued" });
});

it("H3 a failure the queue inferred is taken back when the gap was read only in part", async () => {
  const options = await retainedTab();
  const before = options.getState();
  options.publish(reconcileQueueSnapshot(before, before, queueGone));
  expect(options.getState().messages.find(m => m.turnId === TURN)).toMatchObject({ delivery: "failed", queueLost: true });
  await loadChat({ ...options, history: new ChatHistory(), request: async () => [], requestPage: host({}, 100000) });
  expect(options.getState().messages.find(m => m.turnId === TURN)).toMatchObject({ delivery: "unknown", queueLost: undefined });
});

it("M1 a page error keeps ascending order for every line already read", async () => {
  const options = await retainedTab();
  const paged = host({
    810: { seq: 810, event: { type: "octiq_user_turn_delivery", uuid: TURN, state: "queued" } },
    850: { seq: 850, event: { type: "octiq_user_turn_delivery", uuid: TURN, state: "failed" } },
  });
  await loadChat({ ...options, history: new ChatHistory(), request: async () => [], requestPage: async before => {
    if (before !== null && before <= 801) throw Error("offline");
    return paged(before);
  } });
  expect(options.getState().messages.find(m => m.turnId === TURN)).toMatchObject({ delivery: "failed", queueLost: true, hostFailed: true });
});
