// Real React panel and polling hook, isolated transport and image fixtures.
import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
const require = createRequire(new URL("../web/package.json", import.meta.url));
const { createServer } = await import(require.resolve("vite"));
const { chromium } = await import(process.env.OCTIQOS_PLAYWRIGHT_MODULE ?? "@playwright/test");
const output = await mkdtemp(path.join(tmpdir(), "octiq-image-preview-"));
const { previewHtml } = createRequire(import.meta.url)("./mcp/preview.cjs");
const htmlSource = '<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><style>body{font:20px system-ui;padding:32px;background:#eef3f0;color:#263e35}button{font:inherit;padding:12px}</style></head><body><h1>HTML review</h1><button id="counter" onclick="this.textContent=Number(this.textContent)+1">0</button><script>try{localStorage.getItem("octiq.web.token");document.body.dataset.isolated="no";}catch{document.body.dataset.isolated="yes";}</script></body></html>';
const htmlFirst = previewHtml({ html: htmlSource, title: "Review document", slot: "review" }, output, "chat:a");
const htmlNext = previewHtml({ html: htmlSource.replace("HTML review", "HTML revision two"), title: "Review document", slot: "review" }, output, "chat:a");
const source = await readFile(new URL("../src-tauri/src/web.rs", import.meta.url), "utf8");
const htmlCsp = /const HTML_FILE_CSP: &str = "([^"]+)"/.exec(source)[1];
const fixture = `
import React, { useState } from "react";
import { createRoot } from "react-dom/client";
import { ImagePreviewPanel, PreviewButton } from "/src/components/ImagePreviewPanel.tsx";
import { useImagePreviews } from "/src/lib/imagePreview.ts";
import "/src/styles.css";
window.images = { "chat:a": [], "chat:b": [] };
window.htmlDocs = ${JSON.stringify([htmlFirst, htmlNext])};
window.addHtml = revision => window.images["chat:a"].push(window.htmlDocs[revision]);
window.addImage = (chat, id, slot = "hero") => window.images[chat].push({ id, slot, path: "/fixture/" + id + ".png", title: slot === "hero" ? "Home screen" : "Detail screen", createdAt: Date.now() });
function App() {
 const [key, setKey] = useState("chat:a"); window.switchChat = setKey;
 const previews = useImagePreviews(key, true);
 return <div className="app"><header className="topbar"><span>OctiqFlow</span><PreviewButton count={previews.images.length} open={previews.open} onClick={() => previews.setOpen(!previews.open)} /></header><div className="body"><main className="main" style={{padding: 28}}><h2>Image review</h2><p>Keep the first version open while the agent prepares the next one.</p><textarea aria-label="Chat draft" defaultValue="Make the image a little brighter." /></main>{previews.open && <ImagePreviewPanel key={key} conversationKey={key} images={previews.images} error={previews.error} onClose={() => previews.setOpen(false)} />}</div></div>;
}
createRoot(document.getElementById("root")).render(<React.StrictMode><App /></React.StrictMode>);
`;
const mock = `import { bridge as actualBridge } from "/src/lib/bridge.ts?actual";
export const bridge = {
 openFileInBrowser: path => actualBridge.openFileInBrowser(path),
 invoke: async (command, args) => { if (command !== "image_preview_list") throw Error("Unexpected RPC: " + command); return [...window.images[args.key]]; },
 fetchFile: async path => { if (window.failImages) throw Error("Missing image"); return new Blob(['<svg xmlns="http://www.w3.org/2000/svg" width="800" height="600"><rect width="800" height="600" fill="#c7d4d0"/><rect x="80" y="65" width="640" height="470" rx="24" fill="#f2f5f2"/><rect x="120" y="110" width="240" height="28" rx="6" fill="#405f58"/><rect x="120" y="180" width="560" height="240" rx="12" fill="#8ea8a0"/><circle cx="400" cy="300" r="62" fill="#dbe7df"/><text x="120" y="485" fill="#405f58" font-size="24">Preview fixture · ' + path.split('/').pop() + '</text></svg>'], {type:"image/svg+xml"}); }
};`;
const server = await createServer({
 root: fileURLToPath(new URL("../web", import.meta.url)), configFile: fileURLToPath(new URL("../web/vite.config.ts", import.meta.url)), server: {host:"127.0.0.1",port:0,strictPort:false},
 plugins: [{name:"image-preview-fixture", enforce:"pre",
 resolveId(id) { if(id === "image-preview-fixture")return "\0image-preview-fixture.tsx"; if (/(^|\/)bridge(\.ts)?$/.test(id)) return "\0image-preview-bridge"; },
 async load(id) { if(id === "\0image-preview-fixture.tsx") { const {transformWithEsbuild}=await import(require.resolve("vite")); return (await transformWithEsbuild(fixture,"fixture.tsx",{loader:"tsx",jsx:"automatic"})).code; } if(id === "\0image-preview-bridge")return mock; },
 configureServer(server) { server.middlewares.use("/__image-preview",async (_req,res,next)=>{try{res.setHeader("Content-Type","text/html");res.end(await server.transformIndexHtml("/__image-preview",'<html><head><meta name="viewport" content="width=device-width, initial-scale=1"></head><body><div id="root"></div><script type="module">import "image-preview-fixture"</script></body></html>'));}catch(error){next(error);}});}
 }]
});
let browser;
try {
 await server.listen();
 browser = await chromium.launch({headless:true, executablePath:process.env.OCTIQOS_CHROME_EXECUTABLE});
 const page = await browser.newPage({viewport:{width:1280,height:800}});
 const errors=[]; page.on("pageerror",error=>errors.push(error.message));
 const context = page.context();
 await context.route("**/token", route => route.fulfill({ body: "preview-test-token" }));
 await context.routeWebSocket(/\/ws\?/, () => {});
 let htmlPosts = [];
 await context.route("**/file", async route => {
   const request = route.request();
   assert.equal(request.method(), "POST");
   const fields = new URLSearchParams(request.postData());
   assert.equal(fields.get("token"), "preview-test-token");
   assert.ok([htmlFirst.path, htmlNext.path].includes(fields.get("path")));
   assert.equal(new URL(request.url()).search, "");
   assert.notEqual(request.headers().origin, "null");
   htmlPosts.push(fields.get("path"));
   await route.fulfill({ contentType: "text/html; charset=utf-8", headers: { "Content-Security-Policy": htmlCsp }, body: await readFile(fields.get("path"), "utf8") });
 });
 await page.goto(`http://127.0.0.1:${server.httpServer.address().port}/__image-preview`);
 await page.getByRole("button",{name:"Open previews",exact:true}).waitFor();
 assert.equal(await page.locator(".image-preview-panel").count(),0);
 await page.evaluate(()=>window.addImage("chat:a","first"));
 await page.locator(".image-preview-picture img").waitFor();
 assert.equal(await page.getByLabel("Preview version").inputValue(),"first");
 await page.evaluate(()=>{window.addImage("chat:a","second");window.addImage("chat:a","detail","detail");});
 await page.getByRole("button",{name:/Newer version/}).waitFor();
 assert.equal(await page.getByLabel("Preview version").inputValue(),"first");
 assert.equal(await page.locator(".image-preview-strip button").count(),2);
 await page.screenshot({path:path.join(output,"desktop.png")});
 await page.getByRole("button",{name:/Newer version/}).click();
 assert.equal(await page.getByLabel("Preview version").inputValue(),"second");
 await page.getByLabel("Preview version").selectOption("first");
 await page.getByRole("button",{name:"Zoom in",exact:true}).click();
 assert.ok(await page.locator(".image-preview-stage").evaluate(el=>el.scrollWidth > el.clientWidth));
 await page.getByRole("button",{name:"1.5×",exact:true}).click();
 assert.ok(await page.locator(".image-preview-stage").evaluate(el=>el.scrollWidth === el.clientWidth));
 await page.getByRole("button",{name:"Full screen",exact:true}).click();
 await page.locator(".viewer-img").waitFor();
 await page.keyboard.press("Escape");
 assert.equal(await page.locator(".viewer").count(),0);
 assert.equal(await page.locator(".image-preview-panel").count(),1);
 await page.getByRole("button",{name:"Close preview",exact:true}).click();
 await page.evaluate(()=>window.addImage("chat:a","third"));
 await page.waitForTimeout(1500);
 assert.equal(await page.locator(".image-preview-panel").count(),0);
 await page.getByRole("button",{name:/^Open previews/}).click();
 assert.equal(await page.getByLabel("Preview version").inputValue(),"first");
 await page.evaluate(()=>window.switchChat("chat:b"));
 await page.waitForTimeout(100);
 assert.equal(await page.locator(".image-preview-panel").count(),0);
 await page.evaluate(()=>{window.addImage("chat:b","other");});
 await page.locator(".image-preview-picture img").waitFor();
 assert.equal(await page.getByLabel("Preview version").inputValue(),"other");
 await page.evaluate(()=>window.switchChat("chat:a"));
 await page.waitForFunction(()=>document.querySelector('[aria-label="Preview version"]')?.value === "first");
 await page.setViewportSize({width:390,height:700});
 const panel=await page.locator(".image-preview-panel").boundingBox();
 assert.ok(panel.x>=0 && panel.x+panel.width<=391 && panel.y+panel.height<=701);
 assert.equal(await page.getByRole("textbox",{name:"Chat draft"}).inputValue(),"Make the image a little brighter.");
 await page.screenshot({path:path.join(output,"mobile.png")});
 await page.getByRole("button",{name:"Close preview",exact:true}).click();
 await page.reload();
 await page.getByRole("button",{name:"Open previews",exact:true}).waitFor();
 await page.evaluate(()=>window.addImage("chat:a","first"));
 await page.waitForTimeout(1500);
 assert.equal(await page.locator(".image-preview-panel").count(),0);
 await page.getByRole("button",{name:/^Open previews/}).click();
 await page.locator(".image-preview-picture img").waitFor();
 await page.evaluate(()=>{window.failImages=true; window.addImage("chat:a","broken","broken");});
 await page.getByRole("button",{name:"Detail screen, 1 version"}).waitFor();
 await page.getByRole("button",{name:"Detail screen, 1 version"}).click();
 await page.locator(".image-preview-picture").getByText("Image unavailable").waitFor();
 // HTML is a passive card until a click. Use the real bridge's POST opener
 // against the generated immutable snapshot and the backend's actual CSP.
 await page.evaluate(() => window.addHtml(0));
 await page.getByRole("button", {name:"Review document, 1 version"}).click();
 await page.getByRole("button", {name:"Open HTML", exact:true}).waitFor();
 assert.equal(htmlPosts.length, 0);
 assert.equal(await page.locator("iframe").count(), 0);
 assert.equal(await page.getByRole("button", {name:"Zoom in", exact:true}).count(), 0);
 await page.screenshot({path:path.join(output,"html-mobile.png")});
 const firstOpened = context.waitForEvent("page");
 await page.getByRole("button", {name:"Open HTML", exact:true}).click();
 const documentPage = await firstOpened;
 await documentPage.getByRole("heading", {name:"HTML review", exact:true}).waitFor();
 await documentPage.getByRole("button", {name:"0", exact:true}).click();
 assert.equal(await documentPage.getByRole("button", {name:"1", exact:true}).count(), 1);
 assert.equal(await documentPage.locator("body").getAttribute("data-isolated"), "yes");
 assert.equal(await documentPage.evaluate(() => window.opener), null);
 assert.equal(new URL(documentPage.url()).search, "");
 assert.equal(htmlPosts[0], htmlFirst.path);
 await documentPage.screenshot({path:path.join(output,"html-open.png")});
 await documentPage.close();
 await page.evaluate(() => window.addHtml(1));
 await page.getByRole("button", {name:/Newer version/}).waitFor();
 assert.equal(await page.getByLabel("Preview version").inputValue(), htmlFirst.id);
 await page.getByRole("button", {name:/Newer version/}).click();
 const nextOpened = context.waitForEvent("page");
 await page.getByRole("button", {name:"Open HTML", exact:true}).click();
 const revisionPage = await nextOpened;
 await revisionPage.getByRole("heading", {name:"HTML revision two"}).waitFor();
 assert.equal(htmlPosts[1], htmlNext.path);
 await revisionPage.close();
 await page.setViewportSize({width:1280,height:800});
 await page.screenshot({path:path.join(output,"html-desktop.png")});
 assert.deepEqual(errors,[]);
 console.log("PASS: HTML upload, passive cards, click-to-open authenticated POST, interactive script, opaque origin, no opener/token in URL, HTML revisions; first-image opening, stable selection, versions, multiple slots, zoom, fullscreen, dismiss persistence, conversation isolation, mobile bounds, draft preservation, reload and image failure.");
 console.log("Screenshots:", output);
} finally { await browser?.close(); await server.close(); }
