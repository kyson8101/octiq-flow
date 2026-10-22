// Real captured host turns through the reducer and MessageList, on a scratch
// Vite page. No live backend, paid CLI, profile writes, or persistent service.
// PLAYWRIGHT_MODULE/PLAYWRIGHT_CHANNEL select an installed browser.
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
const artifacts = process.env.OCTIQ_EVIDENCE_DIR || await mkdtemp(join(tmpdir(), "octiq-host-notice-"));
await mkdir(artifacts, { recursive: true });

const fixture = `
import React from "react";
import { createRoot } from "react-dom/client";
import { MessageList } from "/src/components/MessageList.tsx";
import { ChatPersonaContext } from "/src/lib/agentRoster.ts";
import { emptyChat, reduceChat } from "/src/lib/chat.ts";
import capture from "/src/lib/__fixtures__/host-notifications.jsonl?raw";
import reportCapture from "/src/lib/__fixtures__/host-notification-report.jsonl?raw";
import "@fontsource-variable/inter";
import "lxgw-wenkai-screen-webfont/lxgwwenkaiscreen.css";
import "/src/design-system.css";
import "/src/styles.css";
const scene = new URLSearchParams(location.search).get("scene") || "status";
const events = capture.trim().split("\\n").map(line => JSON.parse(line));
const picked = scene === "report" ? JSON.parse(reportCapture.trim()) : events[scene === "batch" ? 2 : scene === "nonstatus" ? 1 : 0];
const person = { id: "person", turnId: "person-1", role: "user", streaming: false, echo: "person-echo", blocks: [{ kind: "text", text: "检查状态，并汇总验证结果。" }] };
const firstAnswer = { id: "prior", role: "assistant", streaming: false, blocks: [{ kind: "text", text: "已安排检查，收到结果后继续。" }] };
const host = reduceChat(emptyChat(), picked).messages[0];
const answer = { id: "answer", role: "assistant", streaming: false, blocks: [{ kind: "text", text: "检查已收到，等待其余结果。\\n\\n完整回复第二段，保持可回读。" }] };
if (scene === "protected") answer.blocks.push(
 { kind: "tool", id: "read-check", name: "Read", argsJson: "{}", args: { file_path: "/tmp/host-notice-check.txt" }, result: "Checked", state: "done" },
 { kind: "text", text: "要继续检查吗？" },
 { kind: "text", text: '\u0060\u0060\u0060octiq-diagram\\n{"rows":[[{"title":"Visible card"}]]}\\n\u0060\u0060\u0060' }
);
const names = key => key.includes("554f9d") ? { name: "OCTIQ FE" } : key.includes("094a29") ? { name: "OCTIQ BE" } : null;
createRoot(document.getElementById("root")).render(<main className="app" style={{ display: "flex", flexDirection: "column" }}>
 <ChatPersonaContext.Provider value={names}><MessageList messages={[person, firstAnswer, host, answer]} conversationId={"notice-test-" + scene} busy={false} hostPersona={{ name: "OCTIQ HEAD" }} /></ChatPersonaContext.Provider>
</main>);
`;

const server = await createServer({
  root: webRoot, configFile: join(webRoot, "vite.config.ts"),
  server: { host: "127.0.0.1", port: 0, strictPort: false },
  plugins: [{
    name: "host-notice-scratch", enforce: "pre",
    resolveId(id) {
      if (id === "/__host-notice.tsx") return id;
      if (id.endsWith("/lib/bridge") || id.endsWith("/lib/bridge.ts")) return "\0scratch-bridge";
    },
    load(id) {
      if (id === "/__host-notice.tsx") return fixture;
      if (id === "\0scratch-bridge") return "export const bridge = { invoke: async () => [], on: () => () => {} };";
    },
    configureServer(vite) {
      vite.middlewares.use(async (req, res, next) => {
        if (req.url?.split("?")[0] !== "/__host-notice") return next();
        const html = await vite.transformIndexHtml("/__host-notice", '<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"></head><body><div id="root"></div><script type="module" src="/__host-notice.tsx"></script></body></html>');
        res.setHeader("Content-Type", "text/html"); res.end(html);
      });
    },
  }],
});
let browser;
const report = { artifacts, checks: [] };
try {
  await server.listen();
  const address = server.httpServer.address();
  assert.notEqual(address.port, 1421);
  browser = await chromium.launch({ headless: true, ...(process.env.PLAYWRIGHT_CHANNEL ? { channel: process.env.PLAYWRIGHT_CHANNEL } : {}) });
  for (const width of (process.env.OCTIQ_WIDTHS || "1280,390").split(",").map(Number)) {
    const context = await browser.newContext({ viewport: { width, height: 844 }, reducedMotion: "reduce", ...(width === 390 ? { hasTouch: true, isMobile: true } : {}) });
    for (const scene of (process.env.OCTIQ_SCENES || "status,batch,report,nonstatus,protected").split(",")) {
      const page = await context.newPage();
      const errors = [];
      page.on("pageerror", error => errors.push(error.message));
      await page.goto(`http://127.0.0.1:${address.port}/__host-notice?scene=${scene}`);
      const host = page.getByRole("article", { name: "OctiqFlow host notifications" });
      await host.locator(".host-notice-toggle").first().waitFor();
      await page.evaluate(() => document.fonts.ready);
      const buttons = host.locator(".host-notice-toggle");
      assert.equal(await buttons.count(), scene === "batch" ? 3 : ["report", "nonstatus"].includes(scene) ? 1 : 2);
      assert.equal(await host.locator('[aria-expanded="true"]').count(), 0);
      assert.equal(await host.locator(".message-bubble, .message-delivery, .msg-copy, [data-map-turn]").count(), 0);
      assert.equal(await page.locator("[data-map-turn]").count(), 1);
      const bounds = await page.evaluate(() => {
        const host = document.querySelector(".msg-host").getBoundingClientRect();
        const reply = document.querySelector(".msg-assistant").getBoundingClientRect();
        const row = document.querySelector(".host-notice-toggle").getBoundingClientRect();
        const label = document.querySelector(".host-notice-label");
        return { hostLeft: host.left, replyLeft: reply.left, rowHeight: row.height, right: host.right,
          scrollWidth: document.documentElement.scrollWidth, whiteSpace: getComputedStyle(label).whiteSpace,
          textOverflow: getComputedStyle(label).textOverflow };
      });
      assert.equal(bounds.hostLeft, bounds.replyLeft);
      assert.ok(bounds.right <= width && bounds.scrollWidth <= width);
      assert.equal(bounds.whiteSpace, "nowrap"); assert.equal(bounds.textOverflow, "ellipsis");
      if (width === 390) assert.ok(bounds.rowHeight >= 44);
      if (["report", "nonstatus"].includes(scene)) {
        assert.ok(await page.getByText("完整回复第二段，保持可回读。", { exact: false }).isVisible());
      } else assert.equal(await host.getByText("完整回复第二段，保持可回读。", { exact: false }).count(), 0);
      if (scene === "protected") {
        await page.screenshot({ path: join(artifacts, `${scene}-${width}-folded.png`) });
        assert.ok(await page.getByText("要继续检查吗？", { exact: true }).isVisible());
        assert.ok(await page.getByText("Visible card", { exact: true }).isVisible());
        assert.ok(await host.locator(".tool-group").isVisible());
      }
      await page.screenshot({ path: join(artifacts, `${scene}-${width}-folded.png`) });
      // The entire one-line button is a keyboard or touch disclosure.
      if (width === 1280) { await buttons.first().focus(); await page.keyboard.press("Enter"); }
      else await buttons.first().tap();
      assert.equal(await buttons.first().getAttribute("aria-expanded"), "true");
      assert.equal(await host.locator("pre.host-notice-text").count(), 1);
      assert.equal(await host.locator("pre.host-notice-text a, pre.host-notice-text button").count(), 0);
      if (scene === "batch") {
        await buttons.nth(1).click();
        assert.equal(await buttons.first().getAttribute("aria-expanded"), "true");
        assert.equal(await buttons.nth(1).getAttribute("aria-expanded"), "true");
        assert.equal(await buttons.nth(2).getAttribute("aria-expanded"), "false");
      }
      await page.screenshot({ path: join(artifacts, `${scene}-${width}-opened.png`) });
      if (["status", "batch"].includes(scene)) {
        await buttons.last().click();
        assert.ok(await host.getByText("完整回复第二段，保持可回读。", { exact: false }).isVisible());
      }
      // Reload and a second tab rebuild the same fold state from the record.
      await page.reload(); await host.locator(".host-notice-toggle").first().waitFor();
      assert.equal(await host.locator('[aria-expanded="true"]').count(), 0);
      const other = await context.newPage(); await other.goto(page.url());
      await other.locator(".host-notice-toggle").first().waitFor();
      assert.equal(await other.locator('.host-notice-toggle[aria-expanded="true"]').count(), 0);
      await other.close();
      assert.deepEqual(errors, []);
      report.checks.push({ width, scene, ...bounds, keyboardOrTouch: "pass", independentRows: "pass", reloadAndSecondTab: "pass", errors });
      console.log(`PASS ${width} ${scene}`);
      await page.close();
    }
    await context.close();
  }
  await writeFile(join(artifacts, "report.json"), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
} finally { await browser?.close(); await server.close(); }
