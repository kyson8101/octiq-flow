// Small visual planting progress, local to the same simulation as the robots.
import {BoxGeometry,Group,Mesh,MeshStandardMaterial} from 'three';
export function gardenPatch() {
 const root=new Group();root.name='planted-seedlings';const growth=new Group();root.add(growth);
 const geometry=new BoxGeometry(1,1,1),soil=new MeshStandardMaterial({color:'#88674b'}),green=new MeshStandardMaterial({color:'#64a856'});
 const bed=new Mesh(geometry,soil);bed.scale.set(.8,.035,.45);bed.position.y=.02;root.add(bed);
 for(const x of [-.26,0,.26]) {
  const stem=new Mesh(geometry,green);stem.scale.set(.025,.3,.025);stem.position.set(x,.17,0);growth.add(stem);
  for(const side of [-1,1]){const leaf=new Mesh(geometry,green);leaf.scale.set(.17,.045,.08);leaf.position.set(x+side*.07,.23,0);leaf.rotation.z=side*.4;growth.add(leaf);}
 }
 let progress=0;
 return {root,update(dt:number,tended:boolean){if(tended)progress=Math.min(1,progress+dt/12);growth.scale.setScalar(.12+progress*.88);root.visible=progress>0;},dispose(){geometry.dispose();soil.dispose();green.dispose();}};
}
