import { useCallback, useSyncExternalStore } from 'react';
import { residentsOf, SLOTS, type Island, type IslandAgent } from './model';

type Portrait={signature:string;image:string};
const portraits=new Map<string,Portrait>();
const listeners=new Map<string,Set<()=>void>>();
let cleanup: (()=>void)|undefined;
let epoch=0;
let scheduled=false;
let data:{island:Island;roster:IslandAgent[]}|undefined;
let painter:ReturnType<typeof import('./portrait').createPortraitRenderer>|undefined;
let failed=false;

function notify(id:string) {listeners.get(id)?.forEach(fn=>fn());}
async function draw() {
  if(scheduled||failed||!data||!listeners.size)return;
  scheduled=true;
  const generation=epoch;
  try {
    const {createPortraitRenderer}=await import('./portrait');
    if(generation!==epoch||!data||!listeners.size)return;
    const residents=residentsOf(data.island,data.roster);
    for(const id of listeners.keys()) {
      const resident=residents.find(r=>r.owner.id===id);
      if(!resident) {if(portraits.delete(id))notify(id);continue;}
      const assets=SLOTS.flatMap(slot=>data!.island.assets.filter(a=>a.id===resident.look.worn[slot]&&a.kind==='accessory'));
      const signature=JSON.stringify([resident.look,assets.map(a=>[a.id,a.rev])]);
      if(portraits.get(id)?.signature===signature)continue;
      painter??=createPortraitRenderer();
      const image=painter.render(resident.look,assets);
      portraits.set(id,{signature,image});notify(id);
    }
  } catch (reason) {if(import.meta.env.DEV)console.debug("Island portrait unavailable",reason);failed=true;painter?.dispose();painter=undefined;}
  finally {scheduled=false;if(generation!==epoch&&listeners.size)void draw();}
}

async function start() {
  const {bridge}=await import('../bridge');
  if(!listeners.size||cleanup)return;
  let stopped=false;
  const reload=async()=>{
    if(stopped||bridge.state!=='open')return;
    const request=++epoch;
    try {
      const [island,roster]=await Promise.all([
        bridge.invoke<{island:Island}>('island_get'),
        bridge.invoke<IslandAgent[]>('team_list',{projectId:null,all:true}),
      ]);
      if(stopped||request!==epoch)return;
      data={island:island.island,roster};
      void draw();
    } catch { /* Keep the person's existing picture when the profile is unavailable. */ }
  };
  const offIsland=bridge.on('island-changed',()=>void reload());
  const offTeam=bridge.on('team-changed',()=>void reload());
  const offState=bridge.onState(state=>{if(state==='open'){failed=false;void reload();}});
  cleanup=()=>{stopped=true;offIsland();offTeam();offState();};
}

function subscribe(id:string,fn:()=>void) {
  let set=listeners.get(id);if(!set){set=new Set();listeners.set(id,set);}
  set.add(fn);
  if(!cleanup)void start();
  if(data)void draw();
  return ()=>{
    set!.delete(fn);if(!set!.size)listeners.delete(id);
    if(!listeners.size){cleanup?.();cleanup=undefined;epoch++;data=undefined;painter?.dispose();painter=undefined;portraits.clear();failed=false;}
  };
}

export function useIslandPortrait(id:string|undefined) {
  const listen=useCallback((fn:()=>void)=>id?subscribe(id,fn):()=>{},[id]);
  const read=useCallback(()=>id?portraits.get(id)?.image:undefined,[id]);
  return useSyncExternalStore(listen,read,()=>undefined);
}
