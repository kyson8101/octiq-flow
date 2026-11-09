// Scratch page with the real Sidebar, themeStore and appearance sheets. No
// backend, model calls or web/dist build. Uses an isolated browser per run.
// PLAYWRIGHT_MODULE=/path/to/playwright/index.mjs PLAYWRIGHT_CHANNEL=chrome
// OCTIQ_EVIDENCE_DIR=/tmp/toggle-evidence node scripts/test-appearance-toggle.mjs
import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";

const webRoot = resolve(process.env.OCTIQ_WEB_ROOT || fileURLToPath(new URL("../web", import.meta.url)));
const require = createRequire(join(webRoot, "package.json"));
const { createServer } = await import(pathToFileURL(require.resolve("vite")).href);
const spec = process.env.PLAYWRIGHT_MODULE || "playwright";
const { chromium } = await import(isAbsolute(spec) ? pathToFileURL(spec).href : spec);
const artifacts = process.env.OCTIQ_EVIDENCE_DIR || await mkdtemp(join(tmpdir(), "octiq-toggle-"));
await mkdir(artifacts, { recursive: true });

const fixture = `
import React from 'react';
import { createRoot } from 'react-dom/client';
import 'lxgw-wenkai-screen-webfont/lxgwwenkaiscreen.css';
import '@fontsource-variable/inter';
import '@fontsource/dela-gothic-one';
import '@fontsource/ma-shan-zheng';
import '@fontsource/orbitron/700.css';
import '/src/design-system.css';
import '/src/styles.css';
import '/src/manga.css';
import '/src/guofeng.css';
import '/src/xp.css';
import '/src/cyberpunk.css';
import { Sidebar } from '/src/components/Sidebar';
import { applyTheme, savedThemeId, THEMES } from '/src/lib/themeStore';
const h = React.createElement;
const theme = new URL(location.href).searchParams.get('theme') || 'dark';
applyTheme(theme);
window.toggleFixture = { applyTheme, savedThemeId, THEMES };
const noop = () => {};
createRoot(document.getElementById('root')).render(h('div', {className: 'app projects-screen'},
  h('div', {className: 'workbench', style: {display:'flex', flex:1, minHeight:0}},
    h(Sidebar, { projects:[], shelved:[], conversations:[], currentConversation:null,
      running:new Set(), busy:new Set(), onPickConversation:noop, onNewChat:noop,
      onDelete:noop, onPin:noop, onToggleDone:noop, onRename:noop,
      onSearch:noop, onProjects:noop, onAgents:noop, onDisk:noop, onSettings:noop }),
    h('main', {className:'body', style:{padding:48}}, h('div', null,
      h('h1', null, 'Appearance'), h('p', null, 'Sidebar theme control · ' + theme),
      h('p', null, 'The real Sidebar and all seven appearance sheets.'))))));
`;
const fixtureId = "\0appearance-toggle-fixture";
const server = await createServer({
  root: webRoot,
  server: { host: "127.0.0.1", port: 0, strictPort: false },
  plugins: [{
    name: "appearance-toggle-fixture",
    resolveId(id) { if (id === fixtureId) return id; },
    load(id) { if (id === fixtureId) return fixture; },
    configureServer(vite) {
      vite.middlewares.use(async (req, res, next) => {
        if (!req.url?.startsWith("/__appearance-toggle")) return next();
        res.setHeader("Content-Type", "text/html");
        res.end(await vite.transformIndexHtml(req.url, '<!doctype html><html><head><meta name="viewport" content="width=device-width, initial-scale=1"></head><body><div id="root"></div><script type="module" src="/@id/__x00__appearance-toggle-fixture"></script></body></html>'));
      });
    },
  }],
});

const report = { kind: "real Sidebar scratch fixture; no backend", scenes: [], screenshots: [] };
async function settled(page, toggle, dark) {
  await page.waitForFunction(({ button, dark }) => {
    if (button.getAttribute("aria-checked") !== String(dark)) return false;
    const knob = button.querySelector(".appearance-toggle-knob");
    const x = new DOMMatrixReadOnly(getComputedStyle(knob).transform).m41;
    const expected = button.getAttribute("aria-checked") === "true" ? 0 : 32;
    return Math.abs(x - expected) < 0.01 && [...button.querySelectorAll("circle")].every(dot =>
      Math.abs(Number(getComputedStyle(dot).opacity) - (dot.dataset.lit === "true" ? 1 : 0.085)) < 0.001);
  }, { button: await toggle.elementHandle(), dark });
}
let browser;
try {
  await server.listen();
  const address = server.httpServer.address();
  const base = `http://127.0.0.1:${address.port}/__appearance-toggle`;
  browser = await chromium.launch({ headless: true, ...(process.env.PLAYWRIGHT_CHANNEL ? { channel: process.env.PLAYWRIGHT_CHANNEL } : {}) });
  for (const dpr of [1, 2]) {
    for (const width of [1280, 390]) {
      const context = await browser.newContext({ viewport: { width, height: width === 390 ? 844 : 860 }, deviceScaleFactor: dpr });
      const page = await context.newPage();
      const errors = [];
      page.on("pageerror", error => errors.push(error.message));
      for (const theme of ["dark", "light", "fun", "manga", "guofeng", "xp", "cyberpunk"]) {
        await page.goto(`${base}?theme=${theme}`);
        const toggle = page.getByRole("switch", { name: "Dark mode" });
        await toggle.waitFor();
        // Each evidence pair starts with default opposite-scheme history.
        // Thus Cyberpunk's light-state screenshot is actually Light, not a
        // previous loop's XP choice. History is exercised separately below.
        await page.evaluate(id => { localStorage.clear(); window.toggleFixture.applyTheme(id); }, theme);
        const dark = ["dark", "fun", "guofeng", "cyberpunk"].includes(theme);
        assert.equal(await toggle.getAttribute("aria-checked"), String(dark));
        await settled(page, toggle, dark);
        const geometry = await toggle.boundingBox();
        assert.equal(geometry.width, 60);
        assert.equal(geometry.height, width === 390 ? 44 : 30);
        const row = await toggle.locator("..").boundingBox();
        assert.equal(row.height, geometry.height, "toggle fits a single Settings row");
        const knobs = await toggle.locator("circle").elementHandles();
        assert.equal(knobs.length, 81);
        const before = await toggle.locator("circle").evaluateAll(dots => dots.map(dot => dot.dataset.lit));
        if (["dark", "light", "cyberpunk"].includes(theme)) {
          const path = join(artifacts, `${theme}-${width}-dpr${dpr}-before-${dark ? "dark" : "light"}.png`);
          await page.screenshot({ path });
          report.screenshots.push(path);
        }
        // Native button keyboard activation: Enter and Space, in both directions.
        await toggle.focus();
        await page.keyboard.press("Enter");
        await settled(page, toggle, !dark);
        assert.equal(await toggle.getAttribute("aria-checked"), String(!dark));
        assert.equal(await page.evaluate(() => window.toggleFixture.savedThemeId()), dark ? "light" : "dark");
        const after = await toggle.locator("circle").evaluateAll(dots => dots.map(dot => dot.dataset.lit));
        assert.notDeepEqual(after, before);
        // React preserves the physical dots rather than replacing whole images.
        assert.equal(await knobs[0].evaluate(dot => dot.isConnected), true);
        if (["dark", "light", "cyberpunk"].includes(theme)) {
          const path = join(artifacts, `${theme}-${width}-dpr${dpr}-after-${dark ? "light" : "dark"}.png`);
          await page.screenshot({ path });
          report.screenshots.push(path);
        }
        await page.keyboard.press("Space");
        await settled(page, toggle, dark);
        assert.equal(await page.evaluate(() => window.toggleFixture.savedThemeId()), theme);
        const focus = await toggle.evaluate(button => {
          const style = getComputedStyle(button);
          return { visible: button.matches(":focus-visible"), outline: style.outlineColor, width: style.outlineWidth,
            accent: style.getPropertyValue("--accent").trim(), pseudo: getComputedStyle(button, "::before").boxShadow,
            knob: getComputedStyle(button.querySelector(".appearance-toggle-knob")).transform };
        });
        assert.equal(focus.visible, true);
        assert.equal(focus.width, "2px");
        assert.notEqual(focus.outline, "rgb(41, 227, 245)", "focus must not use Cyberpunk activity cyan");
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
        report.scenes.push({ theme, width, dpr, geometry, focus });
      }
      // Settings (applyTheme) updates both mounted copies. Last-used schemes
      // round-trip even after a page reload.
      await page.evaluate(() => { window.toggleFixture.applyTheme("guofeng"); window.toggleFixture.applyTheme("manga"); });
      const toggle = page.getByRole("switch", { name: "Dark mode" });
      assert.equal(await toggle.getAttribute("aria-checked"), "false");
      await toggle.click();
      assert.equal(await page.evaluate(() => window.toggleFixture.savedThemeId()), "guofeng");
      await page.reload();
      await toggle.waitFor();
      await page.evaluate(() => window.toggleFixture.applyTheme("guofeng"));
      await toggle.click();
      assert.equal(await page.evaluate(() => window.toggleFixture.savedThemeId()), "manga");
      await page.emulateMedia({ reducedMotion: "reduce" });
      const durations = await toggle.evaluate(button => [".appearance-toggle-track", ".appearance-toggle-knob", ".appearance-toggle-dot"]
        .map(selector => getComputedStyle(button.querySelector(selector)).transitionDuration));
      // The app's global reduced-motion rule forces a negligible 0.01ms
      // duration with !important, even over a component's transition:none.
      assert(durations.every(duration => Number.parseFloat(duration) <= 0.00001));
      assert.deepEqual(errors, []);
      await context.close();
    }
  }
  await writeFile(join(artifacts, "report.json"), JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ scenes: report.scenes.length, screenshots: report.screenshots.length, artifacts }));
} finally {
  await browser?.close();
  await server.close();
}
