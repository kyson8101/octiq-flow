// A deterministic presentation of the durable island. Old plots and gifts
// remain in storage; offices follow the registered roster without deleting it.
import { cellCenter, ringCells, TILE, type Asset, type Island, type Part, type Placement, type Plot, type Resident } from './model';

export function officeLayout(source: Island, people: readonly Resident[]) {
  const groups = new Map<string, Resident[]>();
  for (const person of [...people].sort((a,b)=>a.key.localeCompare(b.key))) {
    const key = person.agent?.teamId ? `team:${person.agent.teamId}` : 'general';
    groups.set(key, [...(groups.get(key) ?? []), person]);
  }
  if (!groups.has('general')) groups.set('general', []);
  const plots: Plot[] = [], assets: Asset[] = source.assets.filter(a=>a.kind==='accessory'), placed: Placement[] = [], residents: Resident[] = [];
  const deskOwners = new Map<string,string>();
  const publicPlots=source.plots.filter(p=>(p.owner.kind==='home' && p.owner.id.startsWith('public:')) || source.placed.some(item=>item.plot===p.id && source.assets.some(a=>a.id===item.asset && a.kind==='building' && a.name!=='Workshop')));
  const cells: [number,number][] = [];
  for(let ring=1;cells.length<groups.size+publicPlots.length;ring++) cells.push(...ringCells(ring).filter(([q,r])=>q!==-1||r!==0));
  const part = (size: [number,number,number], at: [number,number,number], color: string): Part => ({shape:'box',size,at,color});
  for(const [index,[key,members]] of [...groups].sort(([a],[b])=>a.localeCompare(b)).entries()) {
    const [q,r]=cells[index];
    const center=cellCenter(q,r);
    const id=`office:${key}`;
    const name=key==='general'?'Agent Tower':`${members[0].agent?.teamName ?? 'Team'} Office`;
    const plot: Plot={id,owner:{kind:'home',id:key},ring:Math.max(Math.abs(q),Math.abs(r),Math.abs(q+r)),slot:index,q,r,...center,facing:Math.atan2(-center.x,-center.z)*180/Math.PI,radius:TILE,claimedAt:0,members:members.map(m=>m.owner.id),officeName:name};
    plots.push(plot);
    const floors=Math.max(key==='general'?3:1,Math.ceil(members.length/6));
    const parts: Part[]=[];
    // Open-front cutaway: every work station remains visible, including upper floors.
    for(let floor=0;floor<floors;floor++) {
      const y=floor*2.3;
      parts.push(part([8,.08,6],[0,y+.04,-.7],'#d6dce5'));
      parts.push({...part([8,2,.14],[0,y+1,-3.6],'#b6c9dd'),finish:'glass'});
      parts.push({...part([.16,2.3,6],[-3.95,y+1.15,-.7],'#7a94b1'),finish:'glass'});
      parts.push({...part([.16,2.3,6],[3.95,y+1.15,-.7],'#7a94b1'),finish:'glass'});
      for(const x of [-2.7,0,2.7]) parts.push({...part([1.5,1,.025],[x,y+1.2,-3.51],'#b5e5fa'),finish:'glass'});
    }
    assets.push({id,rev:floors,name,kind:'building',parts,by:{name:'Island offices'},madeAt:0,updatedAt:0});
    placed.push({id,asset:id,plot:id,x:0,z:0,y:0,turn:0});
    for(const [seat,member] of members.entries()) {
      residents.push({...member,plot});
      const deskId=`office-desk:${member.key}`;
      const x=(seat%3-1)*2.4, z=Math.floor(seat%6/3)*2.5-2.4, y=Math.floor(seat/6)*2.3;
      assets.push({id:deskId,rev:Number.parseInt(member.look.trim.slice(1)+member.look.glow.slice(1),16),name:`${member.name}'s desk`,kind:'furniture',use:'desk',spot:{at:[0,0,.65],face:180},parts:[part([1.3,.08,.7],[0,.6,0],'#cfa783'),part([.12,.6,.12],[-.5,.3,0],member.look.trim),part([.12,.6,.12],[.5,.3,0],member.look.trim),part([.65,.42,.08],[0,.88,-.18],'#26354a'),{...part([.55,.32,.02],[0,.88,-.13],member.look.glow),finish:'glow'}],by:{name:member.name,agentId:member.owner.id},madeAt:0,updatedAt:0});
      placed.push({id:deskId,asset:deskId,plot:id,x,z,y,turn:0});
      deskOwners.set(deskId,member.key);
      // Personal presents stay visible outside the office; starter homes/desks retire.
      const gifts=source.placed.filter(p=>p.plot===member.plot?.id).filter(p=>{
        const a=source.assets.find(a=>a.id===p.asset);
        return a && a.kind!=='building' && a.name!=='Workshop' && a.name!=='Desk' && a.use!=='bed';
      });
      for(const [giftIndex,gift] of gifts.entries()) {
        const a=source.assets.find(a=>a.id===gift.asset)!;
        if(!assets.some(asset=>asset.id===a.id)) assets.push(a);
        const angle=(seat+giftIndex/Math.max(1,gifts.length))/members.length*Math.PI*2;
        placed.push({...gift,plot:id,x:Math.sin(angle)*4.8,z:Math.cos(angle)*4.8,y:0});
      }
    }
  }
  for(const [index,original] of publicPlots.entries()) {
    const [q,r]=cells[groups.size+index];const center=cellCenter(q,r);
    const items=source.placed.filter(p=>p.plot===original.id && source.assets.some(a=>a.id===p.asset && (original.owner.kind==='home' || (a.kind==='building' && a.name!=='Workshop'))));
    const building=source.assets.find(a=>items.some(p=>p.asset===a.id)&&a.kind==='building');
    const plot={...original,q,r,...center,ring:Math.max(Math.abs(q),Math.abs(r),Math.abs(q+r)),facing:Math.atan2(-center.x,-center.z)*180/Math.PI,officeName:building?.name??'Public project'};
    plots.push(plot);placed.push(...items);
    for(const item of items) {const asset=source.assets.find(a=>a.id===item.asset);if(asset&&!assets.some(a=>a.id===asset.id)) assets.push(asset);}
  }
  const radius=Math.max(30,source.radius,...plots.map(p=>Math.hypot(p.x,p.z)+TILE+4));
  return {island:{...source,plots,assets,placed,radius},residents,deskOwners};
}
