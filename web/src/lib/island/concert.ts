import { AdditiveBlending, BoxGeometry, CircleGeometry, Group, Mesh, MeshBasicMaterial, RingGeometry, SphereGeometry } from 'three';

/** Local stage props: no lights that change other residents or extra audio. */
export function concertStage() {
  const root = new Group();
  root.name = 'concert-stage';
  const dark = new MeshBasicMaterial({ color: '#253044' });
  const cone = new MeshBasicMaterial({ color: '#9d8dff' });
  const light = new MeshBasicMaterial({ color: '#c2a1ff', transparent: true, opacity: .32, depthWrite: false });
  const glowMaterial = new MeshBasicMaterial({ color: '#b997ff', transparent: true, opacity: .13, depthWrite: false, blending: AdditiveBlending });
  const sphere = new SphereGeometry(.75, 20, 12);
  const glow = new Mesh(sphere, glowMaterial);
  glow.position.y = .65;
  root.add(glow);
  const box = new BoxGeometry(.5, .8, .4);
  const circle = new CircleGeometry(.16, 20);
  const ring = new RingGeometry(.7, 1.25, 40);
  const halo = new Mesh(ring, light);
  halo.rotation.x = -Math.PI / 2;
  halo.position.y = .05;
  root.add(halo);
  const speakers: Group[] = [];
  for (const side of [-1, 1]) {
    const speaker = new Group();
    speaker.position.set(side * 1.2, .4, 0);
    speaker.add(new Mesh(box, dark));
    for (const y of [-.19, .19]) {
      const driver = new Mesh(circle, cone);
      driver.position.set(0, y, .205);
      speaker.add(driver);
    }
    root.add(speaker);
    speakers.push(speaker);
  }
  root.visible = false;
  let growth = 0;
  return {
    root,
    update(active: boolean, dt: number, t: number, calm: boolean) {
      growth = Math.max(0, Math.min(1, growth + (active ? 1 : -1) * dt * 3));
      root.visible = growth > 0;
      const pulse = calm ? 1 : 1 + Math.sin(t * 8) * .09;
      root.scale.setScalar(Math.max(.001, growth));
      halo.scale.setScalar(pulse);
      glow.scale.setScalar(pulse);
      light.opacity = .24 + (calm ? 0 : (Math.sin(t * 8) + 1) * .1);
      speakers.forEach(s => s.scale.set(1, pulse, pulse));
    },
    dispose() { sphere.dispose(); glowMaterial.dispose(); box.dispose(); circle.dispose(); ring.dispose(); dark.dispose(); cone.dispose(); light.dispose(); },
  };
}
