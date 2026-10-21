export type Hobby = 'gardening'|'reading'|'painting'|'music'|'games';
export function hobbiesFor(id:string):Hobby[] {
 let hash=2166136261;for(const c of id)hash=Math.imul(hash^c.charCodeAt(0),16777619);
 const hobbies:Hobby[]=['gardening','reading','painting','music','games'];
 return [hobbies[(hash>>>0)%hobbies.length]];
}
