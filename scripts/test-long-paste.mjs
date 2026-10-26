// Real Composer/CSS, isolated Vite page and mocked save_attachment; no backend restart.
// PLAYWRIGHT_MODULE=/path/to/playwright/index.mjs node scripts/test-long-paste.mjs
import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createRequire } from "node:module";
import { pathToFileURL, fileURLToPath } from "node:url";
const webRoot = resolve(process.env.OCTIQ_WEB_ROOT || fileURLToPath(new URL("../web", import.meta.url)));
const require = createRequire(join(webRoot, "package.json"));
const { createServer } = await import(pathToFileURL(require.resolve("vite")).href);
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || "playwright");
const artifacts = await mkdtemp(join(tmpdir(), "octiq-long-paste-"));
const fixture = `
import React, { useState } from "react";
import { createRoot } from "react-dom/client";
import { Composer, MODELS } from "/src/components/Composer";
import { Drafts } from "/src/lib/drafts";
import { attachmentPrompt } from "/src/lib/attachmentPrompt";
import "@fontsource-variable/inter";
import "/src/design-system.css";
import "/src/styles.css";
const drafts = new Drafts();
window.__sends = []; window.__uploads = []; window.__clip = "";
Object.defineProperty(navigator, "clipboard", {configurable:true, value:{readText:async()=>window.__clip}});
function Scratch() {
 const [session, setSession] = useState("a");
 const [visible, setVisible] = useState(true);
 return <div style={{maxWidth:720, margin:"20px auto", padding:12}}>
 <button onClick={()=>setSession(session === "a" ? "b" : "a")}>Switch chat</button>
 <button onClick={()=>setVisible(!visible)}>Toggle composer</button>
 <span data-session>{session}</span>
 {visible && <Composer session={session} draftStore={drafts} choice={MODELS[0]} onChoice={()=>{}} access="auto" onAccess={()=>{}}
 onSend={(text,attachments)=>window.__sends.push({text,attachments,prompt:attachmentPrompt(text,attachments)})}
 onStop={()=>{}} busy={false} effort="high" onEffort={()=>{}} lite={false} onLite={()=>{}}/>}</div>;
}
createRoot(document.getElementById("root")).render(<Scratch/>);`;
const stub = `export const bridge = {
 state:"open", on:()=>()=>{}, onState:()=>()=>{},
 invoke:async(cmd,args)=>{
  if(cmd !== "save_attachment") return [];
  window.__uploads.push(args);
  if(window.__hold) await new Promise(resolve=>{window.__release=resolve;});
  if(window.__fail) throw new Error("Scratch socket closed");
  return "/scratch/"+window.__uploads.length+"-"+args.filename;
 }
}; window.__bridge=bridge;`;
const server = await createServer({root:webRoot,configFile:join(webRoot,"vite.config.ts"),server:{host:"127.0.0.1",port:0,strictPort:false},plugins:[{
 name:"long-paste-scratch",enforce:"pre",
 resolveId(id,importer) {
  if(id === "/__paste.tsx") return id;
  if(id.endsWith("/lib/bridge") || id.endsWith("/lib/bridge.ts") || (id === "./bridge" && importer?.includes("/src/lib/"))) return "\0paste-bridge";
 },
 load(id) {if(id === "/__paste.tsx") return fixture; if(id === "\0paste-bridge") return stub;},
 configureServer(vite) {vite.middlewares.use(async(req,res,next)=>{
  if(req.url !== "/__paste") return next();
  res.setHeader("Content-Type","text/html");
  res.end(await vite.transformIndexHtml("/__paste",'<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"></head><body><div id="root"></div><script type="module" src="/__paste.tsx"></script></body></html>'));
 });}
}]});
let browser;
const checks=[];
const long = "字😀\r\n".repeat(80);
async function paste(page,text,files=false) {
 return page.locator("textarea").evaluate((area,{text,files})=>{
  const clipboardData=new DataTransfer(); clipboardData.setData("text/plain",text);
  if(files) clipboardData.items.add(new File(["image"],"shot.png",{type:"image/png"}));
  return !area.dispatchEvent(new ClipboardEvent("paste",{bubbles:true,cancelable:true,clipboardData}));
 },{text,files});
}
async function clear(page) {
 if(await page.locator(".clear-btn").count()) await page.locator(".clear-btn").click();
 await page.locator("textarea").fill("");
}
try {
 await server.listen(); browser=await chromium.launch({headless:true,...(process.env.PLAYWRIGHT_CHANNEL ? {channel:process.env.PLAYWRIGHT_CHANNEL} : {})});
 for(const width of [1280,390]) {
  const page=await browser.newPage({viewport:{width,height:900},isMobile:width===390,hasTouch:width===390});
  page.setDefaultTimeout(60000);
  const errors=[]; page.on("pageerror",e=>errors.push(e.message));
  await page.goto(`http://127.0.0.1:${server.httpServer.address().port}/__paste`);
  const area=page.locator("textarea"); await area.waitFor();
  await area.fill("before selected after"); await area.evaluate(el=>el.setSelectionRange(7,15));
  assert(await paste(page,long));
  await page.getByRole("button",{name:"Insert as text",exact:true}).waitFor();
  assert.equal(await area.inputValue(),"before selected after");
  assert.equal(await page.locator(".chip-name").textContent(),"Pasted text · 81 lines");
  const bytes=await page.evaluate(()=>new TextDecoder().decode(Uint8Array.from(atob(window.__uploads[0].dataBase64),c=>c.charCodeAt(0))));
  assert.equal(bytes,long);
  assert.match(await page.locator(".chip").getAttribute("title"),/pasted-text-\d{8}-\d{6}\.txt$/);
  const fit=await page.locator(".chip-insert").evaluate(el=>{const r=el.getBoundingClientRect();return {height:r.height,left:r.left,right:r.right,scroll:document.documentElement.scrollWidth};});
  assert(fit.left>=0 && fit.right<=width && fit.scroll<=width);
  if(width===390) assert(fit.height>=44);
  await page.screenshot({path:join(artifacts,`paste-${width}.png`)});
  // Keyboard reaches the real button and restores the exact clipboard string.
  await area.evaluate(el=>el.setSelectionRange(7,15));
  await page.getByRole("button",{name:"Insert as text",exact:true}).focus(); await page.keyboard.press("Enter");
  await page.locator(".send[title='Send']").click();
  assert.equal((await page.evaluate(()=>window.__sends.at(-1))).text,"before "+long+" after");
  await page.evaluate(text=>window.__clip=text,long);
  await page.getByRole("button",{name:"Paste",exact:true}).click();
  await page.getByRole("button",{name:"Insert as text",exact:true}).waitFor();
  await page.locator(".clear-btn").click(); await page.getByRole("button",{name:"Undo",exact:true}).click();
  assert.equal(await page.getByRole("button",{name:"Insert as text",exact:true}).count(),1);
  await page.getByRole("button",{name:"Switch chat"}).click(); assert.equal(await page.locator(".chip").count(),0);
  await page.getByRole("button",{name:"Switch chat"}).click(); await page.locator(".chip").waitFor();
  await page.locator(".send[title='Send']").click();
  const sent=await page.evaluate(()=>window.__sends.at(-1));
  assert.equal(sent.text,""); assert(sent.prompt.startsWith("Pasted text (read it, it is part of this message):\n- /scratch/")); assert(!sent.prompt.includes("字"));
  // Also exercise ClipboardItem read(), used by Safari/Chromium's Paste button.
  await page.evaluate(()=>navigator.clipboard.read=async()=>[{types:["text/plain"],getType:async()=>new Blob([window.__clip],{type:"text/plain"})}]);
  await page.getByRole("button",{name:"Paste",exact:true}).click();
  await page.getByRole("button",{name:"Insert as text",exact:true}).waitFor();
  if(width===390) await page.getByRole("button",{name:"Insert as text",exact:true}).tap();
  else await page.getByRole("button",{name:"Insert as text",exact:true}).click();
  assert.equal(await page.locator(".chip").count(),0); await clear(page);
  console.log(`width=${width}: upload, selection, restore, clear, draft, send passed`);
  // Pending uploads cannot send early; completion belongs to the original chat.
  await area.fill("keep"); await page.evaluate(()=>window.__hold=true); await paste(page,long);
  await page.getByText("Saving pasted text…",{exact:true}).waitFor();
  assert(await page.locator(".send[title='Send']").isDisabled());
  const pendingText=width===390 ? "keep\n" : "keep";
  await area.press("Enter"); assert.equal(await area.inputValue(),pendingText);
  await page.getByRole("button",{name:"Switch chat"}).click();
  await page.evaluate(()=>{window.__hold=false;window.__release();});
  await page.getByText("Saving pasted text…",{exact:true}).waitFor({state:"detached"});
  assert.equal(await page.locator(".chip").count(),0);
  await page.getByRole("button",{name:"Switch chat"}).click(); await page.locator(".chip").waitFor();
  assert.equal(await area.inputValue(),pendingText); await clear(page);
  // The parent-owned Drafts survives an unmount while the upload waits.
  await page.evaluate(()=>window.__hold=true); await paste(page,long);
  await page.getByText("Saving pasted text…",{exact:true}).waitFor();
  await page.getByRole("button",{name:"Toggle composer"}).click();
  await page.getByRole("button",{name:"Toggle composer"}).click();
  assert(await page.locator(".send[title='Send']").isDisabled());
  await page.evaluate(()=>{window.__hold=false;window.__release();});
  await page.locator(".chip").waitFor(); await clear(page);
  console.log(`width=${width}: pending switch and remount passed`);
  // Failure falls back at the current caret, including the exact original CRLF.
  await area.fill("left right"); await area.evaluate(el=>el.setSelectionRange(5,5));
  await page.evaluate(()=>window.__fail=true); await paste(page,long);
  await page.locator(".attach-error").getByText(/it was put in the message instead/).waitFor();
  await page.locator(".send[title='Send']").click();
  assert.equal((await page.evaluate(()=>window.__sends.at(-1))).text,"left "+long+"right");
  await page.evaluate(()=>{window.__fail=false;window.__bridge.state="closed";}); await paste(page,long);
  await page.locator(".attach-error").getByText(/Connection is not open/).waitFor(); await clear(page);
  await page.evaluate(()=>window.__bridge.state="open");
  await paste(page,"x".repeat(12*1024*1024+1));
  await page.locator(".attach-error").getByText(/larger than 12 MB/).waitFor();
  assert.equal((await area.inputValue()).length,12*1024*1024+1); await clear(page);
  assert.equal(await paste(page,"short"),false);
  // Clipboard files still win over even long text.
  await paste(page,long,true); await page.locator(".chip.is-image").waitFor();
  assert.equal(await area.inputValue(),""); assert.equal(await page.locator(".chip-insert").count(),0);
  assert.deepEqual(errors,[]); checks.push({width,passed:true,phoneTarget:fit.height}); await page.close();
 }
 const report=JSON.stringify({passed:true,mockedBackend:true,artifacts,checks},null,2);
 await writeFile(join(artifacts,"report.json"),report);
 console.log(report);
} catch (error) {
 const page=browser?.contexts().at(-1)?.pages().at(-1);
 await page?.screenshot({path:join(artifacts,"failure.png"),fullPage:true}).catch(()=>{});
 console.log(JSON.stringify({artifacts,checks,error:String(error)},null,2));
 throw error;
} finally {await browser?.close();await server.close();}
