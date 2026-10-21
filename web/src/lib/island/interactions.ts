import { plotToWorld, TILE_TOP, type Asset, type Placement, type Plot } from './model';
import { partBox } from './assets';
import type { Hobby } from './hobbies';
export type Activity = 'read'|'paint'|'garden'|'perform'|'play'|'observe';
export type ActivitySite={key:string;name:string;activity:Activity;x:number;z:number;y:number;face:number};
export function activityOf(asset:Asset):Activity|null {
 if(asset.kind==='accessory')return null;
 if(asset.use==='none')return null;
 if(['read','paint','garden','perform','play','observe'].includes(asset.use??''))return asset.use as Activity;
 const name=asset.name.toLowerCase();
 for(const [activity,pattern] of [
 ['garden',/garden|planter|greenhouse|seedling|herb|mint|花|种植|种子|盆栽|薄荷|温室|苗/],
 ['paint',/easel|paint|画架|绘画|畫架/],
 ['read',/library|bookshelf|bookcase|café|cafe|reading|书架|图书|書架|咖啡/],
 ['perform',/music|concert|stage|piano|音乐|合奏|舞台|钢琴/],
 ['play',/arcade|game|toy|游戏|玩具|游乐/],
 ['observe',/lamp|light|灯|燈/],
 ] as [Activity,RegExp][])if(pattern.test(name))return activity;
 if(/\b(chair|bench|stool|bed)\b|椅|凳|床/.test(name)&&!asset.use)return null;
 if(!asset.use&&/\b(table|desk|workbench)\b|桌|工作台/.test(name))return /workbench|工作台/.test(name)?'play':'read';
 if(asset.use==='desk')return /workbench|工作台/.test(name)?'play':'read';
 if(asset.use==='seat'||asset.use==='bed')return null;
 return asset.kind==='building'||asset.kind==='furniture'||asset.kind==='decor'?'observe':null;
}
export function activitySite(asset:Asset,plot:Plot,placement:Placement):ActivitySite|null {
 if(placement.id.startsWith('office-desk:'))return null;
 const activity=activityOf(asset);if(!activity||!asset.parts.length)return null;
 const front=Math.max(...asset.parts.map(p=>partBox(p).max[2]));
 const floor=Math.max(0,...asset.parts.map(p=>partBox(p)).filter(b=>b.max[1]<=.35&&b.max[1]-b.min[1]<=.16).map(b=>b.max[1]));
 const spot=asset.spot??(asset.kind==='building'&&activity!=='observe'?{at:[0,floor,0],face:180}:{at:[0,0,front+.85],face:180});
 const turn=placement.turn*Math.PI/180;const [x,y,z]=spot.at;
 const at=plotToWorld(plot,placement.x+x*Math.cos(turn)+z*Math.sin(turn),placement.z-x*Math.sin(turn)+z*Math.cos(turn));
 return {key:placement.id,name:asset.name,activity,...at,y:TILE_TOP+placement.y+y,face:(plot.facing+placement.turn+spot.face)*Math.PI/180};
}
export function likesActivity(hobbies:readonly Hobby[]|undefined,activity:Activity) {
 const hobby:Partial<Record<Activity,Hobby>>={garden:'gardening',read:'reading',paint:'painting',perform:'music',play:'games'};
 return activity==='observe'||!!hobbies?.includes(hobby[activity]!);
}
