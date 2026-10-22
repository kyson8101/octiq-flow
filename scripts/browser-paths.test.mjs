import assert from 'node:assert/strict';
import {mkdtemp, mkdir, writeFile, rm, readFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {pathToFileURL} from 'node:url';
import {test} from 'node:test';
import {browserPaths} from './browser-paths.mjs';

test('browser QA roots and filesystem imports survive spaces and native drive paths', async () => {
  const root = await mkdtemp(join(tmpdir(), 'octiq QA paths '));
  try {
    const web = join(root, 'web files');
    await mkdir(web);
    await writeFile(join(web, 'package.json'), '{"type":"module"}');
    await writeFile(join(web, 'player module.mjs'), 'export const loaded = true;');
    const script = pathToFileURL(join(root, 'scripts', 'test.mjs')).href;
    assert.equal(browserPaths(script, {}).webRoot, join(root, 'web'));
    const paths = browserPaths(script, {OCTIQ_WEB_ROOT: web});
    assert.equal(paths.webRoot, web);
    const modulePath = paths.require.resolve('./player module.mjs');
    assert.equal((await import(paths.moduleUrl(modulePath))).loaded, true);
    assert.equal(paths.moduleUrl('playwright'), 'playwright');
    assert.equal(paths.moduleUrl(pathToFileURL(modulePath).href), pathToFileURL(modulePath).href);
  } finally {
    await rm(root, {recursive: true, force: true});
  }
});

for (const name of ['media-review', 'island-atmosphere', 'island-chat-avatar', 'island-society']) {
  test(`${name} uses the portable root and module loader`, async () => {
    const script = await readFile(new URL(`./test-${name}.mjs`, import.meta.url), 'utf8');
    assert.match(script, /browserPaths\(import.meta.url\)/);
    assert.match(script, /root:\s*webRoot/);
    assert.match(script, /import\(moduleUrl\(require.resolve\('vite'\)\)\)/);
    assert.match(script, /import\(moduleUrl\(process.env.PLAYWRIGHT_MODULE/);
    assert.doesNotMatch(script, /\.pathname/);
  });
}
