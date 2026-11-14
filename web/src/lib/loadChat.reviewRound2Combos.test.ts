import { IDBFactory } from "fake-indexeddb";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { addUserTurn, emptyChat, reduceChat, type ChatState } from "./chat";
import { CatchUp, type Frame } from "./catchUp";
import { saveChatCheckpoint } from "./chatCache";
import { ChatHistory } from "./chatHistory";
import { forgetHiddenScans, loadChat, HIDDEN_PROMPT_PAGES } from "./loadChat";
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

import {readChatCheckpoint} from "./chatCache";
import {withLocalPrompts,chatPreviewState} from "./chatRetention";

const failed=(seq:number,id=TURN):Frame=>({seq,event:{type:"octiq_user_turn_delivery",uuid:id,state:"failed"}});
const msg=(o:ReturnType<typeof setup>,id=TURN)=>o.getState().messages.find(m=>m.turnId===id);
const opts=(o:ReturnType<typeof setup>,requestPage:any)=>({...o,history:new ChatHistory(),request:async()=>[],requestPage});

it.each([false,true])("COMBO host failure then later same-id dispatch (echo=%s)",async useEcho=>{
 const o=await retainedTab();
 const pages=host({300:failed(300),810:dispatched(810),...(useEcho?{811:echo(811)}:{})});
 await loadChat(opts(o,pages));
 if(useEcho) expect(msg(o)).toBeUndefined();
 else {expect(msg(o)).toMatchObject({delivery:"dispatched",hostFailed:undefined,queueLost:undefined});const s=o.getState();o.publish(reconcileQueueSnapshot(s,s,queueGone));expect(msg(o)).toMatchObject({delivery:"unknown",hostFailed:undefined,queueLost:undefined});}
});
it("COMBO Restore sends fresh identity; old failed prompt stays failed and new one confirmed",async()=>{
 const o=await retainedTab();o.publish(reduceChat(o.getState(),failed(2).event));
 o.publish(addUserTurn(o.getState(),"same text",[],11,"restored"));
 const e=echo(811);(e.event as any).octiq_user_turn_id="restored";
 await loadChat(opts(o,host({300:failed(300),810:{seq:810,event:{type:"octiq_user_turn_delivery",uuid:"restored",state:"dispatched"}},811:e})));
 expect(msg(o)).toMatchObject({delivery:"failed",hostFailed:true,queueLost:true});
 expect(msg(o,"restored")).toBeUndefined();
});
it("COMBO inferred failure then host failure before a capped scan stays authoritative",async()=>{
 const o=await retainedTab();const s=o.getState();o.publish(reconcileQueueSnapshot(s,s,queueGone));
 expect(msg(o)?.hostFailed).toBeUndefined();o.publish(reduceChat(o.getState(),failed(2).event));
 await loadChat(opts(o,host({},100000)));
 expect(msg(o)).toMatchObject({delivery:"failed",hostFailed:true,queueLost:true});
});
it("COMBO inferred failure then hidden host failure in a partial/error scan stays failed",async()=>{
 const o=await retainedTab();const s=o.getState();o.publish(reconcileQueueSnapshot(s,s,queueGone));
 o.publish(addUserTurn(o.getState(),"other",[],11,"other"));const pages=host({850:failed(850)});
 await loadChat(opts(o,async(before:number|null)=>{if(before!==null&&before<=801)throw Error("offline");return pages(before);}));
 expect(msg(o)).toMatchObject({delivery:"failed",hostFailed:true,queueLost:true});
});
it("COMBO host failure flag survives checkpoint and preview",async()=>{
 const o=await retainedTab();o.publish(reduceChat(o.getState(),failed(2).event));
 await saveChatCheckpoint({id:o.id,seq:2,state:o.getState(),updatedAt:2});
 const cached=await readChatCheckpoint(o.id);expect(cached?.state.messages.find(m=>m.turnId===TURN)).toMatchObject({hostFailed:true});
 expect(chatPreviewState(o.getState()).messages.find(m=>m.turnId===TURN)).toMatchObject({hostFailed:true});
 const next=withLocalPrompts(emptyChat(),o.getState());expect(next.messages.find(m=>m.turnId===TURN)).toMatchObject({hostFailed:true});
 await loadChat(opts(o,host({},100000)));expect(msg(o)).toMatchObject({delivery:"failed",hostFailed:true});
});
it("CHECK newest checkpoint host failure is not dropped for stale inferred local failure",async()=>{
 const o=await retainedTab();const s=o.getState();o.publish(reconcileQueueSnapshot(s,s,queueGone));
 const authoritative=reduceChat(o.getState(),failed(2).event);
 await saveChatCheckpoint({id:o.id,seq:2,state:authoritative,updatedAt:2});
 await loadChat(opts(o,host({2:failed(2)},100000)));
 expect(msg(o)).toMatchObject({delivery:"failed",hostFailed:true,queueLost:true});
});
it("COST no pending local prompt reads only recent page",async()=>{
 const o=setup();const s=await replayChat(emptyChat(),[answer(1)],0,()=>false);o.publish(s);
 await saveChatCheckpoint({id:o.id,seq:1,state:s,updatedAt:1});const pages=host({});
 await loadChat(opts(o,pages));expect(pages).toHaveBeenCalledTimes(1);
});
it("COST max 40 hidden pages plus recent",async()=>{
 const o=await retainedTab();const pages=host({},100000);await loadChat(opts(o,pages));
 expect(pages).toHaveBeenCalledTimes(HIDDEN_PROMPT_PAGES+1);expect(msg(o)).toMatchObject({delivery:"unknown"});
});
it("CHECK modern host failure followed by queued clears authoritative failure",async()=>{
 const o=await retainedTab();o.publish(reduceChat(o.getState(),failed(2).event));
 const s=o.getState();o.publish(reconcileQueueSnapshot(s,s,{live:true,queuedTurnIds:[TURN]}));
 expect(msg(o)).toMatchObject({delivery:"queued",hostFailed:undefined,queueLost:undefined});
 await loadChat(opts(o,host({},100000)));expect(msg(o)).toMatchObject({delivery:"unknown",hostFailed:undefined});
});
it("CHECK echo clears hostFailed together with queueLost",async()=>{
 const o=await retainedTab();o.publish(reduceChat(o.getState(),failed(2).event));
 o.publish(reduceChat(o.getState(),echo(3).event));
 expect(msg(o)).toMatchObject({delivery:"dispatched",echo:"echo-3",queueLost:undefined,hostFailed:undefined});
});
it("CHECK appended source carries its authoritative failure provenance",async()=>{
 const o=await retainedTab();o.publish(addUserTurn(o.getState(),"source",[],11,"source"));
 o.publish(reduceChat(o.getState(),failed(2,"source").event));
 o.publish(reduceChat(o.getState(),{type:"octiq_user_turn_appended",uuid:TURN,appended_uuid:"source"}));
 expect(msg(o)).toMatchObject({delivery:"failed",queueLost:true,hostFailed:true});
});

it("CONTROL authoritative checkpoint host failure without stale local duplicate remains failed",async()=>{
 const o=await retainedTab();const authoritative=reduceChat(o.getState(),failed(2).event);
 await saveChatCheckpoint({id:o.id,seq:2,state:authoritative,updatedAt:2});o.publish(emptyChat());
 await loadChat(opts(o,host({2:failed(2)},100000)));
 expect(msg(o)).toMatchObject({delivery:"failed",hostFailed:true,queueLost:true});
});
it("CHECK checkpoint recovery preserves host failure provenance at seed publication",async()=>{
 const o=await retainedTab();const old=o.getState();o.publish(reconcileQueueSnapshot(old,old,queueGone));
 const authoritative=reduceChat(o.getState(),failed(2).event);
 await saveChatCheckpoint({id:o.id,seq:2,state:authoritative,updatedAt:2});
 const phases:any[]=[];const publish=(s:ChatState)=>{phases.push(s.messages.find(m=>m.turnId===TURN));o.publish(s);};
 await loadChat({...opts(o,host({2:failed(2)},100000)),publish});
 expect(phases[0]).toMatchObject({hostFailed:true,delivery:"failed"});
});

it("COMBO valid queued append preserves correct failure provenance through later receipts",async()=>{
 const o=await retainedTab();o.publish(reduceChat(o.getState(),failed(2).event));
 o.publish(reduceChat(o.getState(),{type:"octiq_user_turn_delivery",uuid:TURN,state:"queued"}));
 o.publish(addUserTurn(o.getState(),"append",[],11,"source"));
 o.publish(reduceChat(o.getState(),{type:"octiq_user_turn_delivery",uuid:"source",state:"queued"}));
 o.publish(reduceChat(o.getState(),{type:"octiq_user_turn_appended",uuid:TURN,appended_uuid:"source"}));
 expect(msg(o)).toMatchObject({delivery:"queued",queueLost:undefined,hostFailed:undefined,sourceTurnIds:[TURN,"source"]});
 o.publish(reduceChat(o.getState(),failed(3,"source").event));
 expect(msg(o)).toMatchObject({delivery:"failed",queueLost:true,hostFailed:true});
 o.publish(reduceChat(o.getState(),{type:"octiq_user_turn_delivery",uuid:TURN,state:"dispatched"}));
 expect(msg(o)).toMatchObject({delivery:"dispatched",queueLost:undefined,hostFailed:undefined});
});
