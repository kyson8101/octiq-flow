// PLAYWRIGHT_MODULE=/path/to/playwright/index.mjs node web/scripts/test-callback-retention.mjs
// Real V8 GC is required: a DOM mock cannot detect cross-render closure chains.
import { createRequire } from 'node:module';
import { mkdir, writeFile, rm } from 'node:fs/promises';
import { isAbsolute, join, resolve } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
const web = resolve(process.env.OCTIQ_WEB_ROOT || fileURLToPath(new URL('..', import.meta.url)));
const require = createRequire(join(web, 'package.json'));
const { createServer } = await import(pathToFileURL(require.resolve('vite')).href);
const moduleUrl=spec=>isAbsolute(spec)||spec.startsWith('.')?pathToFileURL(resolve(spec)).href:spec;
const { chromium } = await import(moduleUrl(process.env.PLAYWRIGHT_MODULE || 'playwright'));
let scratch, server, browser;
try {
  scratch = join(web, `.callback-memory-${randomUUID()}.local`);
  await mkdir(scratch);
  // .local suffix keeps scratch out of Git, even on an assertion failure.
  const entry = join(scratch, 'entry.local.tsx');
  await writeFile(entry, `import React, {useState, useCallback, useLayoutEffect, Suspense, startTransition} from 'react';
import {createRoot} from 'react-dom/client';
import {flushSync} from 'react-dom';
import {useCommittedCallback} from '/src/lib/useCommittedCallback.ts';
const root=createRoot(document.getElementById('root'));
let update;let resolveSuspense;
const pending=new Promise(resolve=>{resolveSuspense=resolve;});
function Child({read}){useLayoutEffect(()=>{window.childValues.push(read(true));});return null;}
function Scene({mode}) {
 const [tick,setTick]=useState(0);update=setTick;
 const ledger={id:tick,bytes:new Uint8Array(100000)};
 window.refs.push(new WeakRef(ledger));
 const hook=mode==='fixed'?useCommittedCallback:useCallback;
 const left=hook((value)=>value?ledger.id:right,[Math.floor(tick/2)]);
 const right=hook(()=>left,[Math.floor((tick+1)/2)]);
 useLayoutEffect(()=>{window.current=[left,right];window.values.push(left(true));});
 if(tick===101&&window.suspend)throw pending;
 return <Child read={left}/>;
}
window.start=mode=>{window.refs=[];window.values=[];window.childValues=[];flushSync(()=>root.render(<Suspense fallback={null}><Scene key={mode} mode={mode}/></Suspense>));window.old=window.current[0];};
window.step=tick=>{const previous=window.current;flushSync(()=>update(tick));const current=window.current;return [current[0]===previous[0],current[1]===previous[1]];};
window.suspendRender=()=>{window.suspend=true;startTransition(()=>update(101));};
window.resumeRender=()=>{window.suspend=false;resolveSuspense();};
window.clear=()=>{flushSync(()=>root.unmount());window.current=null;window.old=null;};
`);
  const path = '/' + entry.slice(web.length).replaceAll('\\', '/').replace(/^\//, '');
  server = await createServer({root:web,cacheDir:join(scratch,'node_modules','.vite'),optimizeDeps:{entries:[entry]},configFile:join(web,'vite.config.ts'),server:{host:'127.0.0.1',port:0,strictPort:false},plugins:[{name:'memory-harness',configureServer(s){s.middlewares.use('/__memory',async(_req,res)=>{res.setHeader('Content-Type','text/html');res.end(await s.transformIndexHtml('/__memory',`<div id="root"></div><script type="module" src="${path}"></script>`));});}}]});
  await server.listen();
  browser=await chromium.launch({...(process.env.PLAYWRIGHT_EXECUTABLE_PATH?{executablePath:process.env.PLAYWRIGHT_EXECUTABLE_PATH}:{channel:process.env.PLAYWRIGHT_CHANNEL||'chrome'}),headless:true,args:['--js-flags=--expose-gc']});
  const page=await browser.newPage();
  const errors=[];page.on('pageerror',e=>errors.push(String(e)));
  await page.goto(`http://127.0.0.1:${server.httpServer.address().port}/__memory`);
  await page.waitForFunction(()=>typeof window.start==='function',null,{timeout:120000}).catch(e=>{console.error(errors);throw e;});
  const results={};
  for(const mode of ['native','fixed']) {
    await page.evaluate(mode=>window.start(mode),mode);
    for(let i=1;i<=100;i++) {
      const identity=await page.evaluate(i=>window.step(i),i);
      assert.deepEqual(identity,i%2?[true,false]:[false,true]);
    }
    // Separate tasks: WeakRef targets are kept alive through the current job.
    await page.evaluate(()=>{gc();gc();});
    results[mode]=await page.evaluate(()=>({retained:window.refs.filter(ref=>ref.deref()).length,latest:window.current[0](true),old:window.old(true),values:window.values,childValues:window.childValues}));
  }
  assert.ok(results.native.retained>=90,`control did not reproduce: ${results.native.retained}`);
  assert.ok(results.fixed.retained<=3,`old renders retained: ${results.fixed.retained}`);
  assert.equal(results.fixed.latest,100);
  assert.equal(results.fixed.old,100);
  assert.deepEqual(results.fixed.values,Array.from({length:101},(_,i)=>i));
  assert.deepEqual(results.fixed.childValues,Array.from({length:101},(_,i)=>i));
  await page.evaluate(()=>window.suspendRender());
  await page.waitForTimeout(100);
  assert.equal(await page.evaluate(()=>window.old(true)),100,'uncommitted render escaped');
  await page.evaluate(()=>window.resumeRender());
  await page.waitForFunction(()=>window.old(true)===101);
  assert.deepEqual(errors,[]);
  console.log(JSON.stringify({nativeRetained:results.native.retained,fixedRetained:results.fixed.retained,renders:101,identityAndCommitChecks:'pass'}));
} finally {
  try {await browser?.close();} finally {try {await server?.close();} finally {if(scratch)await rm(scratch,{recursive:true,force:true});}}
}
