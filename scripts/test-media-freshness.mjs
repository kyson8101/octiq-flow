// Replay a real overwritten file through the production reply player. The
// socket/path replies are mocked; stat_paths reads the overwritten local MP4.
// OCTIQ_BROWSER=webkit|chromium, PLAYWRIGHT_CHANNEL=chrome (Chromium only).
// The first stopped replay presses native Play with AAC sound, unmuted, with
// no autoplay policy override; it must survive the async stat_paths lookup.
import assert from 'node:assert/strict';
import { copyFile, mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const web = resolve(process.env.OCTIQ_WEB_ROOT || fileURLToPath(new URL('../web', import.meta.url)));
const out = resolve(process.env.OCTIQ_EVIDENCE_DIR || join(web, '../.shots/media-freshness'));
await mkdir(out, { recursive: true });
const require = createRequire(join(web, 'package.json'));
const { createServer } = await import(pathToFileURL(require.resolve('vite')).href);
const playwright = await import(process.env.PLAYWRIGHT_MODULE ? pathToFileURL(resolve(process.env.PLAYWRIGHT_MODULE)).href : 'playwright');
const engine = process.env.OCTIQ_BROWSER || 'chromium';
for (const [color, duration] of [['red', 2], ['blue', 4]]) {
  execFileSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', `color=c=${color}:s=320x180:r=24:d=${duration}`, '-f', 'lavfi', '-i', `sine=frequency=${color === 'red' ? 330 : 660}:duration=${duration}`, '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', '-movflags', '+faststart', join(out, `${color}.mp4`)]);
}
const current = join(out, 'current.mp4');
const imp = p => JSON.stringify('/@fs/' + join(web, p));
await writeFile(join(out, 'freshness-fixture.tsx'), `
import React from 'react'; import {createRoot} from 'react-dom/client';
import {ProsePlayer} from ${imp('src/components/ProseMedia.tsx')};
import {MediaChatContext,MediaReplyContext} from ${imp('src/components/MediaSlot.tsx')};
import {bridge} from ${imp('src/lib/bridge.ts')};
import {nowPlaying} from ${imp('src/lib/nowPlaying.ts')};
import ${imp('src/design-system.css')}; import ${imp('src/styles.css')};
bridge.invoke=async(cmd,args)=>{const r=await fetch('/__lookup',{method:'POST',body:JSON.stringify({cmd,args})});return r.json()};
window.store=nowPlaying;
createRoot(document.getElementById('root')).render(<main style={{padding:16,maxWidth:900,margin:'auto'}}><p>Earlier reply · overwritten file playback</p><MediaChatContext.Provider value='freshness'><MediaReplyContext.Provider value='earlier-reply'><article className='prose'><p>/p/current.mp4</p><ProsePlayer path='/p/current.mp4' kind='video'/></article></MediaReplyContext.Provider></MediaChatContext.Provider><div id='mini'/></main>);
`);
const calls = [], files = [];
const server = await createServer({ root: web, configFile: join(web, 'vite.config.ts'), appType: 'custom', server: { host: '127.0.0.1', port: 0, strictPort: false, fs: { allow: [web, out] } }, cacheDir: join(web, 'node_modules/.vite-freshness') });
server.middlewares.use('/__lookup', async (req, res) => {
  let body = ''; for await (const chunk of req) body += chunk;
  const { cmd, args } = JSON.parse(body); calls.push({ cmd, args });
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify(cmd === 'resolve_paths' ? args.paths : cmd === 'stat_paths' ? await Promise.all(args.paths.map(async () => Math.floor((await stat(current)).mtimeMs))) : []));
});
server.middlewares.use('/file', async (req, res) => {
  const body = await readFile(current), match = /bytes=(\d+)-(\d*)/.exec(req.headers.range || '');
  const start = match ? +match[1] : 0, end = match?.[2] ? Math.min(+match[2], body.length - 1) : body.length - 1;
  res.statusCode = match ? 206 : 200;
  res.setHeader('Content-Type', 'video/mp4'); res.setHeader('Cache-Control', 'no-store'); res.setHeader('Accept-Ranges', 'bytes');
  if (match) res.setHeader('Content-Range', `bytes ${start}-${end}/${body.length}`);
  res.setHeader('Content-Length', end - start + 1);
  files.push({ url: req.url, length: body.length }); res.end(body.subarray(start, end + 1));
});
server.middlewares.use('/__freshness.html', async (_req, res) => {
  res.setHeader('Content-Type', 'text/html');
  res.end(await server.transformIndexHtml('/__freshness.html', `<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><div id="root"></div><script type="module" src="/@fs/${join(out, 'freshness-fixture.tsx')}"></script>`));
});
const report = { engine, sourceHead: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: web, encoding: 'utf8' }).trim(), host: 'production ProsePlayer/MediaSlot/nowPlaying; mocked resolve_paths and real local mtime via stat_paths; real range HTTP file with AAC sound', widths: {}, errors: [] };
let browser;
try {
  await server.listen(); browser = engine === 'webkit' ? await playwright.webkit.launch({ headless: true }) : await playwright.chromium.launch({ channel: process.env.PLAYWRIGHT_CHANNEL || 'chrome', headless: true });
  for (const width of [1280, 390]) {
    await copyFile(join(out, 'red.mp4'), current);
    const context = await browser.newContext({ viewport: { width, height: 900 }, ...(width === 390 ? { isMobile: engine !== 'webkit', hasTouch: true } : {}) });
    await context.addInitScript(() => {
      window.playRejections = [];
      const nativePlay = HTMLMediaElement.prototype.play;
      HTMLMediaElement.prototype.play = function (...args) {
        const result = nativePlay.apply(this, args);
        result.catch(error => window.playRejections.push({name: error.name, message: error.message}));
        return result;
      };
    });
    await context.route('**/token', r => r.fulfill({ body: 'fixture' }));
    await context.routeWebSocket(/.*/, s => s.onMessage(raw => { const r = JSON.parse(raw); if (r.t === 'invoke') s.send(JSON.stringify({ t: 'reply', id: r.id, ok: true, result: [] })); }));
    const page = await context.newPage(); page.setDefaultTimeout(60000); page.on('pageerror', e => report.errors.push(String(e)));
    await page.goto(`http://127.0.0.1:${server.httpServer.address().port}/__freshness.html`, { waitUntil: 'domcontentloaded', timeout: 180000 });
    // WebKit honours preload=metadata and need not decode a frame yet.
    await page.waitForFunction(() => document.querySelector('video')?.readyState >= 1);
    await page.evaluate(() => { window.player = document.querySelector('video'); window.initialUrl = player.src; window.loads = 0; player.addEventListener('loadstart', () => window.loads++); window.store.setHost(document.querySelector('#mini')); window.store.show(['freshness']); });
    const shot = async name => { assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)); await page.screenshot({ path: join(out, `${name}-${width}.png`), fullPage: true }); };
    assert.equal(await page.locator('video').evaluate(v => v.duration), 2);
    await shot('freshness-red');
    // The reviewer's exact repro: the earlier player is still stopped on red
    // when the file is overwritten, with no new reply and no page reload.
    await copyFile(join(out, 'blue.mp4'), current);
    const stoppedCalls = calls.length;
    // The browser's actual Play control, with audible AAC and no autoplay
    // permission flags. In WebKit this starts at the centre of the poster.
    const pressPlay = async () => {
      const box = await page.locator('video').boundingBox();
      await page.mouse.click(box.x + (engine === 'webkit' ? box.width / 2 : 24), box.y + (engine === 'webkit' ? box.height / 2 : box.height - 50));
    };
    await pressPlay();
    await page.waitForFunction(() => player.duration === 4 && player.currentTime > 0.1);
    // The clock can advance before WebKit presents the decoded replacement
    // frame. Wait for the actual new pixels, rather than sampling that race.
    const waitForBlue = () => page.waitForFunction(() => {
      if (player.readyState < 2) return false;
      const canvas = document.createElement('canvas'); canvas.width = canvas.height = 1;
      const context = canvas.getContext('2d'); context.drawImage(player, 0, 0, 1, 1);
      const pixel = context.getImageData(0, 0, 1, 1).data;
      // WebKit's colour conversion gives this blue a little red (~26).
      return pixel[2] > 200 && pixel[0] < 80;
    });
    await waitForBlue();
    const pausedOverwrite = await page.evaluate(() => { const c = document.createElement('canvas'); c.width = c.height = 1; const x = c.getContext('2d'); x.drawImage(player, 0, 0, 1, 1); return { duration: player.duration, pixel: [...x.getImageData(0, 0, 1, 1).data], same: player === document.querySelector('video'), muted: player.muted, volume: player.volume, paused: player.paused, audioTracks: player.audioTracks?.length ?? null, rejections: window.playRejections }; });
    assert.equal(pausedOverwrite.duration, 4); assert(pausedOverwrite.same); assert(pausedOverwrite.pixel[2] > 200 && pausedOverwrite.pixel[0] < 80);
    assert.equal(pausedOverwrite.muted, false); assert(pausedOverwrite.volume > 0); assert.equal(pausedOverwrite.paused, false);
    if (engine === 'webkit') assert(pausedOverwrite.audioTracks > 0, 'WebKit plays an actual audio track');
    assert(calls.slice(stoppedCalls).some(call => call.cmd === 'stat_paths'));
    assert(!pausedOverwrite.rejections.some(error => error.name === 'NotAllowedError'));
    await shot('freshness-blue-stopped-replay');
    await page.evaluate(() => player.pause());
    await copyFile(join(out, 'red.mp4'), current);
    await page.locator('video').evaluate(v => v.play());
    await page.waitForFunction(() => player.duration === 2 && player.currentTime > 0.2);
    const unchanged = await page.evaluate(() => { player.pause(); return { url: player.src, loads: window.loads, time: player.currentTime }; });
    await page.locator('video').evaluate(v => v.play());
    assert.deepEqual(await page.evaluate(() => ({ url: player.src, loads: window.loads })), { url: unchanged.url, loads: unchanged.loads });
    // Overwrite during playback: no polling and no source replacement.
    const beforeCalls = calls.length;
    await copyFile(join(out, 'blue.mp4'), current);
    await page.waitForFunction(() => player.currentTime > 0.6);
    const playing = await page.evaluate(() => ({ duration: player.duration, url: player.src, same: player === document.querySelector('video') }));
    assert.equal(playing.duration, 2); assert.equal(playing.url, unchanged.url); assert.equal(calls.length, beforeCalls);
    // Wait for ended, then press the browser's own native play control.
    await page.waitForFunction(() => player.ended);
    await pressPlay();
    await page.waitForFunction(() => player.duration === 4 && !player.paused && player.currentTime > 0.1);
    await waitForBlue();
    const blue = await page.evaluate(() => { player.pause(); const c = document.createElement('canvas'); c.width = c.height = 1; const x = c.getContext('2d'); x.drawImage(player, 0, 0, 1, 1); return { duration: player.duration, time: player.currentTime, pixel: [...x.getImageData(0, 0, 1, 1).data], same: player === document.querySelector('video'), urlChanged: player.src !== window.initialUrl }; });
    assert.equal(blue.duration, 4); assert(blue.pixel[2] > 200 && blue.pixel[0] < 80); assert(blue.time < 1); assert(blue.same); assert(blue.urlChanged);
    await shot('freshness-blue-earlier-reply');
    // The same element floats to mini-player, refreshes there while paused,
    // and is handed back to the original reply (no second media element).
    await page.locator('video').evaluate(v => v.play());
    await page.evaluate(() => window.store.show([]));
    await page.waitForFunction(() => document.querySelector('#mini video') === player);
    await page.evaluate(() => window.store.toggle());
    await copyFile(join(out, 'red.mp4'), current);
    await page.evaluate(() => window.store.toggle());
    await page.waitForFunction(() => player.duration === 2 && !player.paused && player.currentTime > 0.1);
    const detached = await page.evaluate(() => ({ same: document.querySelector('#mini video') === player, count: document.querySelectorAll('video').length, duration: player.duration }));
    assert(detached.same); assert.equal(detached.count, 1);
    await page.evaluate(() => window.store.show(['freshness']));
    await page.waitForFunction(() => document.querySelector('.prose-media video') === player);
    await shot('freshness-returned-same-element');
    const rejections = await page.evaluate(() => window.playRejections);
    assert(!rejections.some(error => error.name === 'NotAllowedError'));
    report.widths[width] = { pausedOverwrite, unchanged, overwriteWhilePlaying: playing, nativeEndedReplay: blue, detachedReplay: detached, returnedSameElement: true, rejections };
    await context.close();
  }
  assert.deepEqual(report.errors, []); report.passed = true;
} catch (error) {
  report.error = String(error);
  for (const page of browser?.contexts().flatMap(context => context.pages()) || []) {
    report.failureState = await page.evaluate(() => { const player = document.querySelector('video'); return {duration: player?.duration, paused: player?.paused, time: player?.currentTime, error: player?.error?.message, rejections: window.playRejections}; }).catch(() => null);
    await page.screenshot({path: join(out, 'failure.png'), fullPage: true}).catch(() => {});
  }
  throw error;
}
finally { await writeFile(join(out, 'freshness-playback-report.json'), JSON.stringify({ ...report, calls, files }, null, 2)); await browser?.close(); await server.close(); }
console.log(JSON.stringify(report, null, 2));
