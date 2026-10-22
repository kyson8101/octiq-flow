// Real MessageList and CSS on a scratch Vite page; no backend connection.
// PLAYWRIGHT_MODULE and PLAYWRIGHT_CHANNEL select an installed browser.
import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createRequire } from "node:module";

const webRoot = resolve(process.env.OCTIQ_WEB_ROOT || fileURLToPath(new URL("../web", import.meta.url)));
const require = createRequire(join(webRoot, "package.json"));
const moduleUrl = (spec) => isAbsolute(spec) || spec.startsWith(".") ? pathToFileURL(resolve(spec)).href : spec;
const { createServer } = await import(moduleUrl(require.resolve("vite")));
const { chromium } = await import(moduleUrl(process.env.PLAYWRIGHT_MODULE || "playwright"));
const artifacts = process.env.OCTIQ_EVIDENCE_DIR || await mkdtemp(join(tmpdir(), "octiq-job-wake-"));
await mkdir(artifacts, { recursive: true });

const fixture = `
import React, { useState } from "react";
import { createRoot } from "react-dom/client";
import { MessageList } from "/src/components/MessageList.tsx";
import "@fontsource-variable/inter";
import "lxgw-wenkai-screen-webfont/lxgwwenkaiscreen.css";
import "/src/design-system.css";
import "/src/styles.css";
const text = '[OctiqFlow job ended] {"id":"job_1","label":"复审 e8b80e0 Rust gates","status":"done","exitCode":0}\\nThe job finished. Inspect its output.';
function Scene() {
  const [queued, setQueued] = useState(true);
  const [pending, setPending] = useState(false);
  const person = { id: "person", turnId: "person-1", role: "user", streaming: false, echo: "e1", blocks: [{ kind: "text", text: "检查 Rust gates" }] };
  const reply = { id: "reply", role: "assistant", streaming: false, blocks: [{ kind: "text", text: "Rust gates 已完成。" }] };
  const job = { id: "job", turnId: "octiq-job-job_1", role: "user", streaming: false, delivery: queued ? "queued" : "dispatched", echo: queued ? undefined : "e2", queueAction: pending ? "cancel" : undefined, blocks: [{ kind: "text", text }] };
  return <main className="app" style={{ display: "flex", flexDirection: "column" }}>
    <button id="pickup" style={{ alignSelf: "center", margin: 8, padding: "4px 12px" }} onClick={() => setQueued(false)}>Simulate agent pickup</button>
    <MessageList messages={[person, job, reply]} busy={false} onCancelQueued={id => { document.body.dataset.cancelled = id; setPending(true); }} />
  </main>;
}
createRoot(document.getElementById("root")).render(<Scene />);
`;
const server = await createServer({
  root: webRoot, configFile: join(webRoot, "vite.config.ts"),
  server: { host: "127.0.0.1", port: 0, strictPort: false },
  plugins: [{
    name: "job-wake-scratch",
    enforce: "pre",
    resolveId(id) {
      if (id === "/__job-wake.tsx") return id;
      if (id.endsWith("/lib/bridge") || id.endsWith("/lib/bridge.ts")) return "\0scratch-bridge";
    },
    load(id) {
      if (id === "/__job-wake.tsx") return fixture;
      if (id === "\0scratch-bridge") return "export const bridge = { invoke: async () => [], on: () => () => {} };";
    },
    configureServer(vite) {
      vite.middlewares.use(async (req, res, next) => {
        if (req.url?.split("?")[0] !== "/__job-wake") return next();
        const html = await vite.transformIndexHtml("/__job-wake", '<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"></head><body><div id="root"></div><script type="module" src="/__job-wake.tsx"></script></body></html>');
        res.setHeader("Content-Type", "text/html");
        res.end(html);
      });
    },
  }],
});
let browser;
const report = { artifacts, widths: [] };
try {
  await server.listen();
  const address = server.httpServer.address();
  assert.notEqual(address.port, 1421);
  browser = await chromium.launch({ headless: true, ...(process.env.PLAYWRIGHT_CHANNEL ? { channel: process.env.PLAYWRIGHT_CHANNEL } : {}) });
  for (const width of [1280, 390]) {
    const context = await browser.newContext({ viewport: { width, height: 844 }, reducedMotion: "reduce", ...(width === 390 ? { hasTouch: true, isMobile: true } : {}) });
    const page = await context.newPage();
    const errors = [];
    page.on("pageerror", error => { errors.push(error.message); console.error(error.message); });
    page.on("console", message => { if (message.type() === "error") console.error(message.text()); });
    await page.goto(`http://127.0.0.1:${address.port}/__job-wake`);
    const host = page.getByRole("article", { name: "OctiqFlow job notification" });
    await host.getByText("Job finished", { exact: true }).waitFor();
    await page.evaluate(() => document.fonts.ready);
    assert.equal(await host.locator(".message-bubble, .message-delivery, .msg-copy, [data-map-turn]").count(), 0);
    assert.equal(await host.locator("details[open]").count(), 0);
    const bounds = await page.evaluate(() => {
      const host = document.querySelector(".msg-host").getBoundingClientRect();
      const reply = document.querySelector(".msg-assistant").getBoundingClientRect();
      const user = document.querySelector(".msg-user .msg-body").getBoundingClientRect();
      return { hostLeft: host.left, replyLeft: reply.left, userLeft: user.left, right: host.right, viewport: innerWidth, scrollWidth: document.documentElement.scrollWidth };
    });
    assert.equal(bounds.hostLeft, bounds.replyLeft);
    assert.ok(bounds.userLeft > bounds.hostLeft);
    assert.ok(bounds.right <= width && bounds.scrollWidth <= width);
    await page.screenshot({ path: join(artifacts, `job-wake-${width}-queued.png`) });
    await host.getByRole("button", { name: "Cancel telling the agent the job ended" }).click();
    assert.equal(await page.locator("body").getAttribute("data-cancelled"), "octiq-job-job_1");
    assert.equal(await host.getByRole("button").isDisabled(), true);
    await page.locator("#pickup").click();
    assert.equal(await host.getByRole("button").count(), 0);
    await page.screenshot({ path: join(artifacts, `job-wake-${width}-delivered.png`) });
    await host.locator("summary").click();
    assert.equal(await host.locator("details").getAttribute("open"), "");
    assert.ok(await host.getByText("The job finished. Inspect its output.", { exact: false }).isVisible());
    await page.screenshot({ path: join(artifacts, `job-wake-${width}-expanded.png`) });
    assert.deepEqual(errors, []);
    report.widths.push({ width, ...bounds, cancelTurnId: "octiq-job-job_1", disclosure: "pass", errors });
    await context.close();
  }
  await writeFile(join(artifacts, "report.json"), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
} finally {
  await browser?.close();
  await server.close();
}
