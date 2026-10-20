// Snapshot the same rig and equipped assets the island draws. One shared
// renderer serves every chat avatar; the chat never owns an animation loop.
import { ACESFilmicToneMapping, AmbientLight, Box3, DirectionalLight, OrthographicCamera, Scene, Vector3, WebGLRenderer } from 'three';
import { AssetCache, assetObject } from './assets';
import { createIslandRobot, poseIslandRobot } from './robot';
import { SLOTS, type Asset, type Look } from './model';

export function createPortraitRenderer() {
  const renderer = new WebGLRenderer({ alpha: true, antialias: true, preserveDrawingBuffer: true });
  renderer.setSize(192,192);
  renderer.setPixelRatio(1);
  renderer.toneMapping=ACESFilmicToneMapping;
  const scene=new Scene();
  scene.add(new AmbientLight('#ffffff',2));
  const sun=new DirectionalLight('#fff3e2',3);sun.position.set(3,5,5);scene.add(sun);
  const cache=new AssetCache();
  return {
    render(look: Look, assets: readonly Asset[]) {
      const rig=createIslandRobot(look);
      try {
        poseIslandRobot(rig,'stand',0,{calm:true,console:false});
        for(const slot of SLOTS) {
          const asset=assets.find(a=>a.id===look.worn[slot]&&a.kind==='accessory');
          if(asset) rig.wear(slot,assetObject(cache.get(asset)));
        }
        scene.add(rig.root);
        rig.root.updateMatrixWorld(true);
        const bounds=new Box3().setFromObject(rig.root);
        const center=bounds.getCenter(new Vector3());
        const camera=new OrthographicCamera(-1,1,1,-1,.01,100);
        camera.position.copy(center).add(new Vector3(1.6,.7,4).normalize().multiplyScalar(8));
        camera.lookAt(center);
        camera.updateMatrixWorld(true);
        const projected=new Box3();
        for(let corner=0;corner<8;corner++) projected.expandByPoint(new Vector3(
          corner&1?bounds.max.x:bounds.min.x,
          corner&2?bounds.max.y:bounds.min.y,
          corner&4?bounds.max.z:bounds.min.z,
        ).applyMatrix4(camera.matrixWorldInverse));
        const size=projected.getSize(new Vector3());
        const half=Math.max(size.x,size.y)/2*1.08;
        camera.left=-half;camera.right=half;camera.top=half;camera.bottom=-half;
        camera.updateProjectionMatrix();
        renderer.render(scene,camera);
        return renderer.domElement.toDataURL('image/png');
      } finally {scene.remove(rig.root);rig.dispose();cache.prune(new Set());}
    },
    dispose() {cache.dispose();renderer.dispose();renderer.forceContextLoss();},
  };
}
