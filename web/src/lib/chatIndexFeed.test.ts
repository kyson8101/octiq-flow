import { beforeEach, afterEach, expect, it, vi } from "vitest";
const mock=vi.hoisted(()=>({calls:[] as Array<{cmd:string;resolve:(v:unknown)=>void;reject:(e:unknown)=>void}>,events:new Map<string,(v:unknown)=>void>(),state:undefined as undefined|((s:string)=>void)}));
vi.mock("./bridge",()=>({bridge:{invoke:(cmd:string)=>new Promise((resolve,reject)=>mock.calls.push({cmd,resolve,reject})),on:(name:string,fn:(v:unknown)=>void)=>{mock.events.set(name,fn);return()=>mock.events.delete(name);},onState:(fn:(s:string)=>void)=>{mock.state=fn;fn("open");return()=>{};}}}));
import {createChatIndexFeed, type IndexReading} from "./chatIndexFeed";
const row=(id:string,over={})=>({id,title:id,projectId:"p",createdAt:1,updatedAt:1,sessionId:null,modelId:null,access:null,...over});
const emit=(value:unknown)=>mock.events.get("chat-index-changed")!(value);
const settle=async(entries:unknown[]=[],deleted:unknown[]=[],at=0)=>{mock.calls[at].resolve(entries);mock.calls[at+1].resolve(deleted);await vi.advanceTimersByTimeAsync(0);};
beforeEach(()=>{vi.useFakeTimers();mock.calls=[];mock.events.clear();});afterEach(()=>vi.useRealTimers());
it("reads once and applies only changed rows, with deletions and restores",async()=>{
 const feed=createChatIndexFeed(),seen:IndexReading[]=[];const off=feed.subscribe(r=>seen.push(r));
 await settle([row("a",{coordinatesRun:true}),row("b")]);
 for(let n=0;n<363;n++)emit({id:"b",gone:false,entry:row("b",{updatedAt:n+2})});
 emit({id:"a",gone:true,entry:null,deleted:{...row("a"),deletedAt:4}});
 expect((await feed.entries()).map(r=>r.id)).toEqual(["b"]);
 emit({id:"a",gone:false,entry:row("a",{generation:1})});
 expect((await feed.entries()).find(r=>r.id==="a")?.generation).toBe(1);
 expect(mock.calls.map(c=>c.cmd)).toEqual(["chat_index_list","chat_index_deleted"]);
 expect(seen.slice(1).every(r=>r.partial&&r.entries.length<=1)).toBe(true);off();
});
it("replays a changed/delete event over an older initial reply",async()=>{
 const feed=createChatIndexFeed(),seen:IndexReading[]=[];feed.subscribe(r=>seen.push(r));
 emit({id:"a",gone:true,entry:null});emit({id:"b",gone:false,entry:row("b",{generation:3})});
 await settle([row("a"),row("b")]);
 expect(await feed.entries()).toEqual([row("b",{generation:3})]);
 expect(seen.map(r=>r.partial)).toEqual([false,true,true]);
});
it("ignores a reply from a dead connection and reads once on reconnect",async()=>{
 const feed=createChatIndexFeed();feed.subscribe(()=>{});mock.state!("closed");mock.state!("open");
 await settle([row("new")],[],2);await settle([row("old")]);expect(await feed.entries()).toEqual([row("new")]);expect(mock.calls).toHaveLength(4);
});
it("keeps older-server invalidation fallback and a change during a read",async()=>{
 const feed=createChatIndexFeed();feed.subscribe(()=>{});emit({id:"a",gone:false});await settle([row("a")]);
 await vi.advanceTimersByTimeAsync(250);expect(mock.calls).toHaveLength(4);await settle([row("a"),row("b")],[],2);
 emit({id:"b",gone:true});await vi.advanceTimersByTimeAsync(250);expect(mock.calls).toHaveLength(6);await settle([row("a")],[],4);expect(await feed.entries()).toEqual([row("a")]);
});
it("preserves the run-column first-paint fact across metadata patches",async()=>{
 const feed=createChatIndexFeed();feed.subscribe(()=>{});await settle([row("a",{coordinatesRun:true})]);emit({id:"a",gone:false,entry:row("a",{readAt:3})});expect((await feed.entries())[0].coordinatesRun).toBe(true);
});
it("resolves a notification that outruns its event with one targeted lookup",async()=>{
 const feed=createChatIndexFeed();feed.subscribe(()=>{});await settle([row("a")]);
 const first=feed.forChat("b"),second=feed.forChat("b");expect(mock.calls.at(-1)?.cmd).toBe("chat_index_entry");expect(mock.calls).toHaveLength(3);
 mock.calls[2].resolve(row("b"));expect((await first).map(r=>r.id)).toEqual(["a","b"]);await second;expect(mock.calls).toHaveLength(3);
});
it("does not let a targeted reply overwrite a newer deletion event",async()=>{
 const feed=createChatIndexFeed();feed.subscribe(()=>{});await settle([row("a")]);
 const lookup=feed.forChat("b");emit({id:"b",gone:true,entry:null});mock.calls[2].resolve(row("b"));expect((await lookup).map(r=>r.id)).toEqual(["a"]);
});
it("recovers an unread initial index on the next canonical change",async()=>{
 const feed=createChatIndexFeed();feed.subscribe(()=>{});
 mock.calls[0].reject(new Error("profile unavailable"));mock.calls[1].resolve([]);await vi.advanceTimersByTimeAsync(0);
 emit({id:"b",gone:false,entry:row("b")});expect(mock.calls).toHaveLength(4);
 await settle([row("a")],[],2);expect((await feed.entries()).map(r=>r.id)).toEqual(["a","b"]);
});
