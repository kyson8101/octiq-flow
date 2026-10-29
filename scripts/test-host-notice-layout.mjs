// Run: node scripts/test-host-notice-layout.mjs (OCTIQ_WEB_ROOT, PLAYWRIGHT_MODULE, OCTIQ_EVIDENCE_DIR optional).
import { createRequire } from 'node:module';
import { writeFile, mkdir, mkdtemp, rm } from 'node:fs/promises';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { randomUUID } from 'node:crypto';
const webRoot = resolve(process.env.OCTIQ_WEB_ROOT || fileURLToPath(new URL("../web", import.meta.url)));
const require = createRequire(join(webRoot, "package.json"));
const moduleUrl = (spec) => isAbsolute(spec) || spec.startsWith(".") ? pathToFileURL(resolve(spec)).href : spec;
const {createServer} = await import(moduleUrl(require.resolve('vite')));
const {chromium} = await import(moduleUrl(process.env.PLAYWRIGHT_MODULE || 'playwright'));
const evidence = process.env.OCTIQ_EVIDENCE_DIR ? resolve(process.env.OCTIQ_EVIDENCE_DIR) : await mkdtemp(join(tmpdir(), "octiq-host-notice-layout-"));
await mkdir(evidence,{recursive:true});
// *.local is ignored by Git, including while a failed assertion unwinds.
const scratch = join(webRoot, `.host-notice-qa-${randomUUID()}.local`);
const entry = join(scratch, 'entry.tsx');
const entryUrl = '/' + relative(webRoot, entry).split(sep).join('/');
const source = (...parts) => JSON.stringify('/' + relative(webRoot, join(webRoot, 'src', ...parts)).split(sep).join('/'));
let server;
let browser;
try {
await mkdir(scratch);
await writeFile(entry, `import React from 'react';
import {createRoot} from 'react-dom/client';
import {HostNotice} from ${source('components', 'HostNotice')};
import {AgentRosterContext, ChatPersonaContext} from ${source('lib', 'agentRoster')};
import {personaFor} from ${source('lib', 'agentPersona')};
import {useContext} from 'react';
import {applyTheme} from ${source('lib', 'themeStore')};
import ${source('design-system.css')};
import ${source('styles.css')};
import ${source('manga.css')};import ${source('guofeng.css')};import ${source('xp.css')};import ${source('cyberpunk.css')};
import 'lxgw-wenkai-screen-webfont/lxgwwenkaiscreen.css';import '@fontsource-variable/inter';
import '@fontsource/dela-gothic-one';import '@fontsource/ma-shan-zheng';import '@fontsource/orbitron/700.css';
const face=(colour, eyes, mouth)=>'data:image/svg+xml,'+encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32"><rect width="32" height="32" rx="16" fill="'+colour+'"/><rect x="5" y="7" width="22" height="20" rx="7" fill="#d7e9ef"/><path d="'+eyes+' '+mouth+'" stroke="#264352" stroke-width="2" fill="none" stroke-linecap="round"/></svg>');
const roster=[
 {id:'backup',name:'OCTIQ DEV BACKUP',avatar:face('#507a93','M10 14v3m12-3v3','M11 21h10')},
 {id:'story',name:'STAR STORY',avatar:face('#735bb3','M9 16l3-2m8 0 3 2','M11 20q5 6 10 0')},
 {id:'potato',name:'Potato Juice',avatar:face('#4f8f74','M10 14h3m6 0h3','M12 22q4-4 8 0')},
 {id:'head',name:'OCTIQ HEAD',avatar:face('#4c719b','M10 15h2m8 0h2','M12 21h8')},
];
const head=roster[3];
const assignees=new Map(roster.map(agent=>['chat:'+agent.id,agent]));
const names=key=>personaFor(key,[],roster,assignees);
function Scene(){const nameOf=useContext(ChatPersonaContext);return <main style={{maxWidth:760,margin:'32px auto',padding:'0 20px'}}><h2 style={{fontSize:16,marginBottom:18}}>Host updates</h2><HostNotice notices={notices} coordinator={head.name} nameOf={nameOf} reply="已收到，验证继续进行。"/><HostNotice notices={[]} coordinator="OCTIQ DEV BACKUP" nameOf={nameOf} reply="Coordinator reply keeps the complete ordinary name."/><div style={{marginTop:24}}><HostNotice notices={[{id:'fallback',kind:'status',subject:'Unknown sender fallback',body:'Hidden',text:'Raw'}]} coordinator={head.name} nameOf={()=>null}/></div></main>}
applyTheme(new URLSearchParams(location.search).get('theme')||'dark');
window.__theme=applyTheme;
const notices=['status','reply','report','failure','escalation','capacity','question','instruction','unknown'].map((kind,i)=>({id:'notice-'+kind,kind,from:'chat:'+roster[i%3].id,subject:'Long subject should shrink before ordinary agent names: tsc/build pass；full test retry 正常推进',body:'Agent prose stays behind disclosure.\\n第二段原文。',text:'Original host envelope'}));
createRoot(document.getElementById('root')).render(<AgentRosterContext.Provider value={roster}><ChatPersonaContext.Provider value={names}><Scene/></ChatPersonaContext.Provider></AgentRosterContext.Provider>);
`);
server=await createServer({root:webRoot,configFile:join(webRoot,'vite.config.ts'),server:{host:'127.0.0.1',port:0,strictPort:false},plugins:[{name:'qa-html',configureServer(s){s.middlewares.use('/__qa',async(req,res)=>{res.setHeader('Content-Type','text/html');res.end(await s.transformIndexHtml('/__qa','<html><head></head><body><div id="root"></div><script type="module" src="'+entryUrl+'"></script></body></html>'));});}}]});
 await server.listen();
 const url='http://127.0.0.1:'+server.httpServer.address().port+'/__qa';
 browser=await chromium.launch({headless:true,channel:'chrome'});
 const context=await browser.newContext({reducedMotion:'reduce'});
 const page=await context.newPage();
 page.setDefaultTimeout(90000);page.setDefaultNavigationTimeout(180000);
 const errors=[];page.on('pageerror',e=>errors.push(String(e)));
 const results=[];
 for(const theme of ['light','dark','fun','manga','guofeng','xp','cyberpunk']) {
  for(const width of [1280,390]) {
   await page.setViewportSize({width,height:840});
   await page.goto(url+'?theme='+theme);
   await page.waitForSelector('.host-notice-toggle');
   await page.evaluate(()=>document.fonts.ready);
   const rows=await page.locator('.host-notice-toggle').evaluateAll(nodes=>nodes.map(node=>{
    const box=node.getBoundingClientRect();const label=node.querySelector('.host-notice-label');
    const names=[...label.querySelectorAll('.host-notice-sender, .host-notice-coordinator')].map(n=>({name:n.textContent,clientWidth:n.clientWidth,scrollWidth:n.scrollWidth}));
    const chevron=node.querySelector('.card-fold-chevron').getBoundingClientRect();
    const parts=[...label.children].map(child=>{const r=child.getBoundingClientRect();return {cls:child.className.baseVal??child.className,x:r.x,y:r.y,w:r.width,h:r.height,mid:r.y+r.height/2};});
    return {names,chevronReachable:chevron.right<=box.right && chevron.left>=box.left,height:box.height,width:box.width,labelHeight:label.getBoundingClientRect().height,parts,spoken:node.getAttribute('aria-label'),overflow:node.scrollWidth>node.clientWidth};
   }));
   for(const row of rows){assert.ok(row.height>=32);assert.ok(row.chevronReachable);for(const name of row.names)assert.ok(name.scrollWidth<=name.clientWidth,JSON.stringify({theme,width,...name}));assert.ok(!row.overflow);assert.ok(row.labelHeight<25);const mids=row.parts.map(x=>x.mid);assert.ok(Math.max(...mids)-Math.min(...mids)<1);assert.equal(row.parts[0].w,16);assert.equal(row.parts[0].h,16);}
   const names=await page.locator('.host-notice-sender, .host-notice-coordinator').evaluateAll(nodes=>nodes.map(n=>({name:n.textContent,title:n.title,clientWidth:n.clientWidth,scrollWidth:n.scrollWidth})));
   for(const name of names){assert.ok(name.scrollWidth<=name.clientWidth,JSON.stringify({theme,width,...name}));assert.equal(name.title,name.name);}
   assert.equal(await page.locator('.host-notice-toggle .agent-avatar img').evaluateAll(nodes=>new Set(nodes.map(n=>n.src)).size),3);
   assert.ok(await page.locator('.host-notice-subject').first().evaluate(n=>n.scrollWidth>=n.clientWidth));
   const toggles=page.getByRole('button',{name:'OCTIQ DEV BACKUP to OCTIQ HEAD, status: Long subject should shrink before ordinary agent names: tsc/build pass；full test retry 正常推进',exact:true});
   await toggles.focus();
   assert.equal(await toggles.evaluate(n=>getComputedStyle(n).outlineStyle),'solid');
   await page.screenshot({path:join(evidence,`${theme}-${width}.png`),fullPage:true});
   await toggles.click();
   await page.getByText('Agent prose stays behind disclosure.').waitFor();
   await page.getByRole('button',{name:'Host text',exact:true}).click();
   await page.getByText('Original host envelope',{exact:true}).waitFor();
   results.push({theme,width,rows,names});
  }
 }
 // Long identities may ellipsize, but can never hide the chevron or wrap.
 await page.setViewportSize({width:390,height:840});
 await page.evaluate(()=>document.querySelectorAll('.host-notice-sender, .host-notice-coordinator').forEach(n=>{n.textContent='A genuinely long agent name with many extra characters';}));
 assert.ok(await page.locator('.host-notice-toggle').evaluateAll(nodes=>nodes.every(n=>{const r=n.getBoundingClientRect(),c=n.querySelector('.card-fold-chevron').getBoundingClientRect();return n.scrollWidth<=n.clientWidth && c.right<=r.right && c.left>=r.left && n.querySelector('.host-notice-label').getBoundingClientRect().height<25;})));
 assert.ok(await page.locator('.host-notice-sender').first().evaluate(n=>n.scrollWidth>n.clientWidth));
 const touch=await browser.newContext({viewport:{width:390,height:840},isMobile:true,hasTouch:true,reducedMotion:'reduce'});
 const phone=await touch.newPage();await phone.goto(url+'?theme=dark');await phone.waitForSelector('.host-notice-toggle');
 assert.ok(await phone.locator('.host-notice-toggle').first().evaluate(n=>n.getBoundingClientRect().height>=44));
 assert.deepEqual(errors,[]);
 await writeFile(join(evidence,'geometry.json'),JSON.stringify(results,null,2));
 console.log(JSON.stringify({evidence,screenshots:14,scenes:results.length,errors}));
} finally {
 try { await browser?.close(); }
 finally {
  try { await server?.close(); }
  finally { await rm(scratch,{recursive:true,force:true}); }
 }
}
process.exit(0);
