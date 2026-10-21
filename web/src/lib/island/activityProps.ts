import { BoxGeometry, Group, Mesh, MeshBasicMaterial } from 'three';
export function activityProps() {
 const root=new Group();const geometry=new BoxGeometry(1,1,1);
 const materials=['#f1e7cb','#6b86b6','#f5a14a','#76b9a5','#71c7ff'].map(color=>new MeshBasicMaterial({color}));
 const make=(name:string,size:[number,number,number],color:number)=>{const group=new Group();group.name=name;const mesh=new Mesh(geometry,materials[color]);mesh.scale.set(...size);group.add(mesh);root.add(group);group.visible=false;return group};
 const book=make('read',[.32,.24,.05],1),brush=make('paint',[.035,.32,.035],2),can=make('garden',[.22,.16,.17],3),paper=make('register',[.24,.3,.02],0),controller=make('play',[.25,.1,.1],1);
 const spout=new Mesh(geometry,materials[4]);spout.scale.set(.18,.035,.035);spout.position.x=.16;can.add(spout);
 return {root,show(kind:string|null){for(const group of [book,brush,can,paper,controller])group.visible=group.name===kind;},dispose(){geometry.dispose();materials.forEach(m=>m.dispose());}};
}
