import type { Material } from 'three';
import { BoxGeometry, CanvasTexture, Group, Mesh, MeshBasicMaterial, MeshStandardMaterial } from 'three';
import { cellCenter, defaultAgentLook } from './model';
import { createIslandRobot, poseIslandRobot } from './robot';
export const SOCIETY_CELL={q:0,r:-1};
export const SOCIETY_CENTER=cellCenter(0,-1);
export const SOCIETY_COUNTER={x:SOCIETY_CENTER.x,z:SOCIETY_CENTER.z-.8};
export function societyQueueSpot(index:number) {
 return {x:SOCIETY_CENTER.x+((index%4-1.5)*1.6),z:SOCIETY_CENTER.z+.6+Math.floor(index/4)*1};
}
export function buildSociety() {
 const root=new Group();root.name='bot-society';root.position.set(SOCIETY_CENTER.x,.05,SOCIETY_CENTER.z);
 const geometry=new BoxGeometry(1,1,1);
 const stone=new MeshStandardMaterial({color:'#ded8c9',roughness:.8});
 const gold=new MeshStandardMaterial({color:'#caa45c',metalness:.5,roughness:.3});
 const glass=new MeshStandardMaterial({color:'#b8e5f0',transparent:true,opacity:.22,depthWrite:false});
 const box=(x:number,y:number,z:number,w:number,h:number,d:number,material:Material=stone)=>{const m=new Mesh(geometry,material);m.position.set(x,y,z);m.scale.set(w,h,d);root.add(m);};
 box(0,.05,0,8,.1,7);box(-3.9,1.2,0,.15,2.4,7,glass);box(3.9,1.2,0,.15,2.4,7,glass);
 for(const x of [-3.2,3.2]){box(x,1.5,2.8,.45,3,.45);box(x,3.1,2.8,.75,.2,.75,gold);}
 box(0,3.15,2.8,6.8,.25,.35,gold);
 box(0,.45,-1.6,3.2,.9,.65);box(0,.94,-1.6,3.5,.1,.9,gold);
 box(0,.5,-3.7,2.4,1,1.8);box(0,1.07,-3.7,2.7,.15,2,gold);
 const look=defaultAgentLook({id:'bot-society-statue',agent:'codex',model:'sol'});
 const statue=createIslandRobot({...look,shell:'#d7c592',trim:'#a98642',glow:'#fff2af',antenna:'crown'});
 poseIslandRobot(statue,'raise',0,{calm:true});statue.root.scale.setScalar(4.5);statue.root.position.set(0,1.15,-3.7);root.add(statue.root);
 const canvas=document.createElement('canvas');canvas.width=768;canvas.height=128;const ctx=canvas.getContext('2d')!;
 ctx.fillStyle='#f7e8bd';ctx.fillRect(0,0,768,128);ctx.fillStyle='#5d4828';ctx.font='bold 56px sans-serif';ctx.textAlign='center';ctx.fillText('BOT SOCIETY',384,80);
 const texture=new CanvasTexture(canvas);const signMaterial=new MeshBasicMaterial({map:texture});box(0,3.15,3.02,4.8,.8,.04,signMaterial);
 return {root,solids:[{cx:SOCIETY_CENTER.x-3.9,cz:SOCIETY_CENTER.z,hx:.08,hz:3.5,yaw:0},{cx:SOCIETY_CENTER.x+3.9,cz:SOCIETY_CENTER.z,hx:.08,hz:3.5,yaw:0},{cx:SOCIETY_CENTER.x,cz:SOCIETY_CENTER.z-1.6,hx:1.7,hz:.45,yaw:0},{cx:SOCIETY_CENTER.x,cz:SOCIETY_CENTER.z-3.7,hx:1.4,hz:1.1,yaw:0}],dispose(){statue.dispose();geometry.dispose();stone.dispose();gold.dispose();glass.dispose();texture.dispose();signMaterial.dispose();}};
}
