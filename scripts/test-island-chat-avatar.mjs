// The chat avatar in a real browser, with an isolated transport and WebGL.
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {mkdtemp} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
const require=createRequire(new URL('../web/package.json',import.meta.url));
const {createServer,transformWithEsbuild}=await import(require.resolve('vite'));
const {chromium}=await import(process.env.PLAYWRIGHT_MODULE||'playwright');
const evidence=await mkdtemp(join(tmpdir(),'octiq-chat-avatar-'));
const bridgeSource=`
const events=new Map();window.avatarCalls=[];
export const bridge={state:'open',onState(fn){fn('open');return()=>{}},on(name,fn){if(!events.has(name))events.set(name,new Set());events.get(name).add(fn);return()=>events.get(name).delete(fn)},async invoke(cmd){window.avatarCalls.push(cmd);return cmd==='island_get'?{island:structuredClone(window.avatarIsland)}:structuredClone(window.avatarRoster)}};
window.avatarEvent=(name)=>events.get(name)?.forEach(fn=>fn({}));
`;
const entry=`
import React from 'react';import {createRoot} from 'react-dom/client';
import {AgentAvatar} from '/src/components/AgentAvatar.tsx';
window.avatarRoster=[{id:'maya',name:'Maya',agent:'codex',model:'sol'}];
window.avatarIsland={version:1,rev:1,seed:1,createdAt:0,updatedAt:0,radius:30,settings:{wishPace:'sometimes'},plots:[{id:'maya-plot',owner:{kind:'agent',id:'maya'},ring:1,slot:0,q:-1,r:1,x:-6,z:10,facing:150,radius:6.3,claimedAt:0}],bots:[],looks:{maya:{frame:'boxy',shell:'#f3d7ff',trim:'#984dcb',glow:'#50edff',eyes:'heart',antenna:'star',worn:{head:'hat',neck:'scarf',back:'pack'}}},assets:[
{id:'hat',rev:1,name:'Hat',kind:'accessory',slot:'head',parts:[{shape:'cylinder',size:[1,.06,.8],at:[0,.05,0],color:'#fa934c'},{shape:'cylinder',size:[.6,.3,.5],at:[0,.2,0],color:'#fa934c'}]},
{id:'scarf',rev:1,name:'Scarf',kind:'accessory',slot:'neck',parts:[{shape:'box',size:[.68,.16,.4],at:[0,-.04,.1],color:'#49bd91'},{shape:'box',size:[.18,.42,.12],at:[.18,-.25,.24],color:'#49bd91'}]},
{id:'pack',rev:1,name:'Pack',kind:'accessory',slot:'back',parts:[{shape:'round',size:[.5,.5,.25],at:[0,-.05,-.12],color:'#718dff'}]}
],placed:[],wishes:[],lastRollAt:0};
window.contexts=0;const original=HTMLCanvasElement.prototype.getContext;HTMLCanvasElement.prototype.getContext=function(type,...args){if(type==='webgl2')window.contexts++;return original.call(this,type,...args)};
const root=createRoot(document.getElementById('root'));window.unmountAvatars=()=>root.unmount();
root.render(<main style={{padding:40,background:'#edf1f8',fontFamily:'sans-serif'}}><h1>Maya</h1><div id='portrait'><AgentAvatar island name='Maya' id='maya' size={180}/></div><p>Chat header <AgentAvatar island name='Maya' id='maya' size={48}/></p><p>Message <AgentAvatar island name='Maya' id='maya' size={40}/></p><p id='editor'>Uploaded photo <AgentAvatar name='Maya' id='maya' avatar='data:image/svg+xml,%3Csvg xmlns="http://www.w3.org/2000/svg"/%3E' size={40}/></p></main>);
`;
const server=await createServer({root:new URL('../web',import.meta.url).pathname,server:{host:'127.0.0.1',port:0,strictPort:false},plugins:[{
name:'chat-avatar-fixture',enforce:'pre',resolveId(id){if(id==='virtual:chat-avatar')return '\0chat-avatar'},async load(id){if(id==='\0chat-avatar')return(await transformWithEsbuild(entry,'fixture.tsx',{loader:'tsx',jsx:'automatic'})).code;if(id.endsWith('/src/lib/bridge.ts'))return bridgeSource},
configureServer(server){server.middlewares.use(async(req,res,next)=>{if(req.url!=='/__avatar')return next();res.setHeader('Content-Type','text/html');res.end(await server.transformIndexHtml(req.url,'<div id="root"></div><script type="module" src="/@vite/client"></script><script type="module" src="/@id/__x00__chat-avatar"></script>'))})}
}]});
let browser;const timeout=setTimeout(()=>{console.error('avatar browser timeout');process.exit(1)},60000);
try{
 await server.listen();browser=await chromium.launch({headless:true,channel:'chrome',args:['--enable-unsafe-swiftshader']});
 const page=await browser.newPage({viewport:{width:700,height:560}});const errors=[];page.on('pageerror',e=>{errors.push(e.message);console.error('pageerror',e.message)});page.on('console',m=>{if(m.type()==='error'||m.type()==='debug')console.error('console',m.text())});
 await page.goto('http://127.0.0.1:'+server.httpServer.address().port+'/__avatar');
 await page.waitForFunction(()=>document.querySelector('#portrait img')?.src.startsWith('data:image/png'),null,{timeout:15000}).catch(async e=>{console.log(await page.evaluate(()=>({calls:window.avatarCalls,body:document.body.innerHTML,contexts:window.contexts})));throw e});
 const first=await page.locator('#portrait img').getAttribute('src');
 assert.deepEqual(await page.evaluate(()=>window.avatarCalls),['island_get','team_list']);
 assert.equal(await page.evaluate(()=>window.contexts),1);
 assert.equal((await page.locator('#editor img').getAttribute('src')).startsWith('data:image/svg'),true);
 assert.equal(new Set(await page.locator('img[src^="data:image/png"]').evaluateAll(imgs=>imgs.map(i=>i.src))).size,1);
 const geometry=await page.locator('#portrait img').evaluate(img=>({width:img.getBoundingClientRect().width,frame:img.parentElement.getBoundingClientRect().width,natural:img.naturalWidth,animation:getComputedStyle(img).animationName}));
 assert.equal(geometry.width/geometry.frame,24);assert.equal(geometry.natural,3072);assert.equal(geometry.animation,'island-portrait-idle');
 const motionA=await page.locator('#portrait').screenshot();await page.waitForTimeout(450);const motionB=await page.locator('#portrait').screenshot();assert.notDeepEqual(motionA,motionB,'the outfit must really move');
 await page.screenshot({path:join(evidence,'outfit.png')});
 await page.emulateMedia({reducedMotion:'reduce'});
 assert.equal(await page.locator('#portrait img').evaluate(img=>getComputedStyle(img).animationName),'none');
 await page.emulateMedia({reducedMotion:'no-preference'});
 await page.evaluate(()=>{window.avatarIsland.assets[0].parts.forEach(p=>p.color='#51aaff');window.avatarIsland.assets[0].rev++;window.avatarIsland.rev++;window.avatarEvent('island-changed')});
 await page.waitForFunction(first=>document.querySelector('#portrait img')?.src!==first,first);
 const blueHat=await page.locator('#portrait img').getAttribute('src');
 await page.evaluate(()=>{window.avatarIsland.looks.maya.worn={};window.avatarIsland.rev++;window.avatarEvent('island-changed')});
 await page.waitForFunction(previous=>document.querySelector('#portrait img')?.src!==previous,blueHat);
 await page.screenshot({path:join(evidence,'without-outfit.png')});
 assert.equal(await page.evaluate(()=>window.contexts),1);
 await page.evaluate(()=>{window.avatarRoster=[];window.avatarEvent('team-changed')});
 await page.waitForFunction(()=>!document.querySelector('#portrait img'));
 await page.evaluate(()=>window.unmountAvatars());assert.deepEqual(errors,[]);
 const fallback=await browser.newPage();
 await fallback.addInitScript(()=>{const original=HTMLCanvasElement.prototype.getContext;HTMLCanvasElement.prototype.getContext=function(type,...args){return type==='webgl'||type==='webgl2'?null:original.call(this,type,...args)}});
 await fallback.goto('http://127.0.0.1:'+server.httpServer.address().port+'/__avatar');
 await fallback.waitForFunction(()=>window.contexts>0);
 assert.equal(await fallback.locator('#portrait .agent-avatar-initials').textContent(),'MA');
 assert.equal(await fallback.locator('#editor img').count(),1);
 await fallback.close();
 console.log('PASS '+evidence);
}finally{await browser?.close();await server.close();clearTimeout(timeout)}
