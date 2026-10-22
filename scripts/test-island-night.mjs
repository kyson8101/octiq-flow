// Isolated WebGL evidence: no OctiqFlow backend or shared browser session.
// PLAYWRIGHT_MODULE may point to an external Playwright install; OCTIQ_WEB_ROOT
// selects an exact checkout. ISLAND_NIGHT_EVIDENCE selects the output folder.
import assert from 'node:assert/strict';
import {mkdtemp, mkdir, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {browserPaths} from './browser-paths.mjs';
const {webRoot, require, moduleUrl} = browserPaths(import.meta.url);
const {createServer} = await import(moduleUrl(require.resolve('vite')));
const {chromium} = await import(moduleUrl(process.env.PLAYWRIGHT_MODULE || 'playwright'));
const evidence = process.env.ISLAND_NIGHT_EVIDENCE || await mkdtemp(join(tmpdir(), 'octiq-island-night-'));
await mkdir(evidence, {recursive: true});
const server = await createServer({root: webRoot, server: {host: '127.0.0.1', port: 0, strictPort: false}});
let browser;
const errors = [], metrics = [];
try {
  await server.listen();
  browser = await chromium.launch({headless: true, channel: process.env.PLAYWRIGHT_CHANNEL || 'chrome', args: ['--enable-unsafe-swiftshader']});
  const page = await browser.newPage({viewport: {width: 1280, height: 800}, reducedMotion: 'reduce'});
  page.on('pageerror', e => errors.push(e.message));
  page.on('console', msg => { if (msg.type() === 'error') errors.push(msg.text()); });
  const base = `http://127.0.0.1:${server.httpServer.address().port}`;
  for (const width of [1280, 390]) for (const hour of [12, 19, 23]) {
    await page.setViewportSize({width, height: 800});
    await page.goto(`${base}/island.html?hour=${hour}`);
    await page.waitForFunction(() => window.islandView?.hour === Number(new URLSearchParams(location.search).get('hour')));
    await page.evaluate(() => { window.islandView.setWeather('sunny'); window.islandView.setReducedMotion(true); });
    await page.waitForFunction(() => window.islandView?.weatherChoice === 'sunny' && window.islandView.hourAt >= 0);
    const state = await page.evaluate(() => {
      const v = window.islandView;
      let points = 0;
      v.scene.traverse(o => { if (o.isPointLight) points++; });
      return {night: v.sky.night, interiorVisible: v.buildingLights.group.visible,
        interiorNight: v.buildingLights.material.uniforms.night.value,
        outdoorVisible: v.scenery.group.getObjectByName('night-light-pools').visible,
        fixturesVisible: v.scenery.group.getObjectByName('night-lanterns').visible,
        calls: v.renderer.info.render.calls, points};
    });
    assert.equal(state.points, 0);
    assert.equal(state.interiorVisible, hour !== 12);
    assert.equal(state.outdoorVisible, hour !== 12);
    assert.equal(state.fixturesVisible, hour !== 12);
    assert.equal(state.interiorNight, state.night);
    metrics.push({width, hour, ...state});
    await page.screenshot({path: join(evidence, `${width}-hour-${hour}.png`)});
  }

  // Clock transitions, reduced-motion steadiness and restored daylight.
  const transitions = [];
  for (const hour of [18.8, 19, 20.3, 23, 5.5, 6, 6.6, 8, 12]) {
    await page.evaluate(hour => window.islandView.setHourOverride(hour), hour);
    await page.waitForFunction(hour => window.islandView.hour === hour && window.islandView.hourAt >= 0, hour);
    transitions.push(await page.evaluate(() => ({hour: window.islandView.hour,
      night: window.islandView.sky.night, light: window.islandView.buildingLights.material.uniforms.night.value})));
  }
  assert.ok(transitions.slice(0, 4).every((v, i, a) => !i || v.light > a[i - 1].light));
  assert.ok(transitions.slice(4).every((v, i, a) => !i || v.light <= a[i - 1].light));
  assert.ok(transitions.every(v => v.light === v.night));
  await page.evaluate(() => { window.islandView.setHourOverride(23); window.islandView.setReducedMotion(true); });
  await page.waitForFunction(() => window.islandView.hour === 23);
  const steady = await page.evaluate(() => window.islandView.buildingLights.material.uniforms.night.value);
  await page.waitForTimeout(1100);
  assert.equal(await page.evaluate(() => window.islandView.buildingLights.material.uniforms.night.value), steady);

  // Twenty-four registered residents, team offices, Tower, old homes and a
  // granted project on a translated/rotated placement; independent of host data.
  await page.setViewportSize({width: 1280, height: 800});
  await page.evaluate(async () => {
    const v = window.islandView, first = v.residents[0];
    const source = {...v.island,
      plots: v.island.plots.filter(p => !p.id.startsWith('office:')),
      placed: v.island.placed.filter(p => !p.id.startsWith('office:') && !p.id.startsWith('office-desk:')),
      assets: v.island.assets.filter(a => !a.id.startsWith('office:') && !a.id.startsWith('office-desk:'))};
    const people = Array.from({length: 24}, (_, i) => ({...first, key: 'agent:qa' + i,
      owner: {kind: 'agent', id: 'qa' + i}, name: 'Agent ' + i,
      agent: {...first.agent, id: 'qa' + i, teamId: i % 4 ? 'team' + i % 4 : undefined, teamName: 'Team ' + i % 4}}));
    window.nightFixture = {source, people};
    v.setIsland(source, people); v.setWeather('sunny'); v.setReducedMotion(false);
  });
  await page.waitForTimeout(1500);
  const populated = await page.evaluate(async () => {
    const v = window.islandView, render = v.renderer.render, submit = [], frames = [];
    let previous;
    v.renderer.render = function (...args) {
      const start = performance.now(), result = render.apply(this, args);
      submit.push(performance.now() - start); return result;
    };
    try {
      for (let i = 0; i < 120; i++) await new Promise(resolve => requestAnimationFrame(t => {
        if (previous) frames.push(t - previous); previous = t; resolve();
      }));
    } finally { v.renderer.render = render; }
    submit.sort((a, b) => a - b); frames.sort((a, b) => a - b);
    return {robots: v.robots.size, plots: v.island.plots.length,
      medianSubmit: submit[Math.floor(submit.length / 2)], p95Submit: submit[Math.floor(submit.length * .95)],
      medianFrame: frames[Math.floor(frames.length / 2)], p95Frame: frames[Math.floor(frames.length * .95)],
      calls: v.renderer.info.render.calls, triangles: v.renderer.info.render.triangles};
  });
  await page.screenshot({path: join(evidence, 'populated-23.png')});
  assert.equal(populated.robots, 24);

  const project = await page.evaluate(() => {
    const v = window.islandView, {source, people} = window.nightFixture;
    const home = source.assets.find(a => a.kind === 'building');
    const asset = {...home, id: 'qa-project', name: 'Granted project', rev: 1};
    const plot = {...source.plots[0], id: 'qa-project-plot', owner: {kind: 'home', id: 'public:qa-project'}};
    const placement = {id: 'qa-project-placement', plot: plot.id, asset: asset.id, x: .4, z: -.3, y: .5, turn: 30};
    const extended = {...source, assets: [...source.assets, asset], plots: [...source.plots, plot], placed: [...source.placed, placement]};
    v.setIsland(extended, people);
    const geometry = v.buildingLights.group.children[0].geometry;
    const unchanged = geometry;
    v.setIsland(extended, people);
    const retained = v.buildingLights.group.children[0].geometry === unchanged;
    let disposed = false;
    geometry.addEventListener('dispose', () => { disposed = true; });
    v.setIsland(source, people);
    return {retained, disposed, removed: !v.placed.has(placement.id)};
  });
  assert.deepEqual(project, {retained: true, disposed: true, removed: true});
  // Render the granted project as additional evidence after exercising removal.
  await page.evaluate(() => {
    const v = window.islandView, {source, people} = window.nightFixture;
    const home = source.assets.find(a => a.kind === 'building');
    const asset = {...home, id: 'qa-project', name: 'Granted project', rev: 1};
    const plot = {...source.plots[0], id: 'qa-project-plot', owner: {kind: 'home', id: 'public:qa-project'}};
    v.setIsland({...source, assets: [...source.assets, asset], plots: [...source.plots, plot],
      placed: [...source.placed, {id: 'qa-project-placement', plot: plot.id, asset: asset.id, x: .4, z: -.3, y: .5, turn: 30}]}, people);
  });
  await page.screenshot({path: join(evidence, 'granted-project-23.png')});
  await page.evaluate(() => {
    const v = window.islandView, plot = v.island.plots.find(p => p.id === 'qa-project-plot');
    v.camera.position.set(plot.x + 11, 14, plot.z + 14);
    v.controls.target.set(plot.x, 0, plot.z);
    v.controls.update();
  });
  await page.screenshot({path: join(evidence, 'granted-project-close-23.png')});
  assert.deepEqual(errors, []);
  await writeFile(join(evidence, 'metrics.json'), JSON.stringify({matrix: metrics, transitions, populated, project, errors}, null, 2));
  await page.evaluate(() => window.islandView.dispose());
  console.log('PASS ' + evidence, populated);
} finally {
  await browser?.close();
  await server.close();
}
