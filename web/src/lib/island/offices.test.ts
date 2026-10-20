import { expect, it } from 'vitest';
import { officeLayout } from './offices';
import { defaultAgentLook, type Island, type Resident } from './model';
const source: Island={version:1,rev:1,seed:1,createdAt:0,updatedAt:0,radius:50,settings:{wishPace:'sometimes'},plots:[],bots:[],looks:{},assets:[],placed:[],wishes:[],lastRollAt:0};
function member(id:string,teamId?:string):Resident {
 const agent={id,name:id,agent:'codex' as const,model:'sol',teamId,teamName:teamId};
 return {key:`agent:${id}`,owner:{kind:'agent',id},name:id,agent,look:defaultAgentLook(agent),plot:null};
}
it('shares one office per team and one taller general tower, with a private desk for everyone',()=>{
 const people=[member('a','red'),member('b','red'),member('c','blue'),member('d'),member('e')];
 const before=JSON.stringify(source);const view=officeLayout(source,people);
 expect(view.island.plots).toHaveLength(3);
 expect(view.residents[0].plot?.id).toBe(view.residents[1].plot?.id);
 expect(view.residents.find(r=>r.key==='agent:a')?.plot?.id).toBe(view.residents.find(r=>r.key==='agent:b')?.plot?.id);
 expect(new Set(view.deskOwners.values()).size).toBe(5);
 expect(view.island.assets.filter(a=>a.use==='desk')).toHaveLength(5);
 const height=(id:string)=>Math.max(...view.island.assets.find(a=>a.id===id)!.parts.map(p=>p.at[1]+p.size[1]/2));
 expect(height('office:general')).toBeGreaterThan(height('office:team:red'));
 expect(view.island.plots.every(p=>!(p.q===-1&&p.r===0))).toBe(true);
 expect(JSON.stringify(source)).toBe(before);
 expect(officeLayout(source,[...people].reverse())).toEqual(view);
});
it('resizes for large teams and gives all members their own desk on multiple floors',()=>{
 const view=officeLayout(source,Array.from({length:17},(_,i)=>member(String(i),'red')));
 expect(view.island.plots).toHaveLength(2);
 expect(view.deskOwners.size).toBe(17);
 expect(new Set(view.island.placed.filter(p=>p.id.startsWith('office-desk:')).map(p=>p.y)).size).toBe(3);
 const moved=officeLayout(source,[member('a','red'),member('b','blue')]);
 expect(moved.island.plots).toHaveLength(3);
});
