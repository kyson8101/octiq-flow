// Real PermissionAsk/CardFold/Confirm, disposable browser and stub decisions.
// Run serially with other harnesses sharing this Vite root.
import assert from 'node:assert/strict';
import {mkdtemp, mkdir, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {pathToFileURL} from 'node:url';
import {browserPaths} from '../../scripts/browser-paths.mjs';
const {webRoot:web,require,moduleUrl}=browserPaths(new URL('../../scripts/browser-paths.mjs',import.meta.url).href);
const {createServer}=await import(pathToFileURL(require.resolve('vite')).href);
const {chromium}=await import(moduleUrl(process.env.PLAYWRIGHT_MODULE||'playwright'));
let server,browser,cache,scratch;
try {
  cache=await mkdtemp(join(tmpdir(),'octiq-approval-restore-'));
  scratch=join(web,'.test-reading-approval.local');await mkdir(scratch,{recursive:true});
  await writeFile(join(scratch,'index.html'),'<html><body><div id="root"></div><script type="module" src="/.test-reading-approval.local/entry.tsx"></script></body></html>');
  await writeFile(join(scratch,'entry.tsx'),`
import React,{useLayoutEffect,useState}from'react';import{createRoot}from'react-dom/client';
import{PermissionAsk}from'/src/components/PermissionAsk.tsx';
import{ChatReadingProvider}from'/src/lib/useReadingState.tsx';
import{useCarefulAnswer}from'/src/components/Confirm.tsx';
import{bridge}from'/src/lib/bridge.ts';
import'/src/design-system.css';import'/src/styles.css';
window.calls=[];window.mounts=[];window.confirmed=0;
bridge.invoke=async(command,args)=>{if(command==='permission_decide')window.calls.push({command,args});return null};
const original=Array.from({length:13},(_,i)=>'echo command line '+(i+1)).join('\\n');
function Pending({command}){
 useLayoutEffect(()=>{
  const root=document.querySelector('.permission-card');
  const allows=[...root.querySelectorAll('button')].filter(b=>['Always','Allow once'].includes(b.getAttribute('aria-label')));
  window.mounts.push({command,open:root.querySelector('.card-fold')?.hidden===false,held:allows.every(b=>b.getAttribute('aria-disabled')==='true'),lastLine:root.textContent.includes(command.split('\\n').at(-1))});
  // Before passive drawnWhole: even a keyboard-style click must send nothing.
  allows.at(-1).click();
 },[]);
 return <PermissionAsk ask={{id:'same-ask',toolName:'Bash',toolInput:{command}}} onAnswered={()=>{}}/>;
}
function Careful(){const answer=useCarefulAnswer(()=>window.confirmed++);return <button data-confirm onKeyDown={answer.keys} onClick={answer.confirm}>Confirm</button>}
function Scene(){const[chat,setChat]=useState('a');const[command,setCommand]=useState(original);const[confirm,setConfirm]=useState(false);
 return <><button data-nav-a onClick={()=>{setChat('a');setConfirm(false)}}>Chat A</button><button data-nav-b onClick={()=>{setChat('b');setConfirm(false)}}>Chat B</button>
 <button data-replace onClick={()=>setCommand(original+'\\necho replacement')}>Replace while away</button>
 <button data-return-confirm onClick={()=>{setChat('a');setConfirm(true)}}>Return with confirmation</button>
 <ChatReadingProvider id={chat} scope="approval">{chat==='a'?<><Pending command={command}/>{confirm&&<Careful/>}</>:<p>Other chat</p>}</ChatReadingProvider></>}
createRoot(document.getElementById('root')).render(<Scene/>);`);
  server=await createServer({root:web,cacheDir:join(cache,'.vite'),server:{host:'127.0.0.1',port:0,strictPort:false}});await server.listen();
  const origin=`http://127.0.0.1:${server.httpServer.address().port}`;
  browser=await chromium.launch({headless:true,...(process.env.PLAYWRIGHT_EXECUTABLE_PATH?{executablePath:process.env.PLAYWRIGHT_EXECUTABLE_PATH}:{channel:'chrome'})});
  for(const width of [1280,390]){
    const context=await browser.newContext({viewport:{width,height:844}}),page=await context.newPage(),errors=[];
    page.on('pageerror',error=>errors.push(String(error)));page.setDefaultTimeout(30000);
    await context.routeWebSocket(/\/ws\?/,ws=>ws.onMessage(raw=>{const c=JSON.parse(String(raw));if(c.t==='invoke')ws.send(JSON.stringify({t:'reply',id:c.id,ok:true,result:[]}))}));
    await page.goto(`${origin}/.test-reading-approval.local/index.html?token=fixture`);
    await page.locator('.permission-card').waitFor();
    const held=await page.evaluate(()=>window.mounts[0]);assert.equal(held.held,true);assert.equal(held.open,false);assert.equal(await page.evaluate(()=>window.calls.length),0);
    const stray=await page.evaluate(async()=>{
      const frame=()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));
      const click=(el,x,y,detail=1)=>el.dispatchEvent(new MouseEvent('click',{bubbles:true,cancelable:true,detail,clientX:x,clientY:y}));
      const nav=selector=>document.querySelector(selector).click();
      click(document.querySelector('.card-fold-button'),41,73);await frame();
      nav('[data-nav-b]');await frame();nav('[data-nav-a]');await frame();
      const allow=document.querySelector('.ask-card-actions .is-primary');
      const ready=!allow.disabled&&allow.getAttribute('aria-disabled')!=='true';
      click(allow,41,73);const dropped=window.calls.length===0;
      click(allow,111,133);await frame();
      return {ready,dropped,calls:window.calls.length,mount:window.mounts.at(-1)};
    });
    assert.equal(stray.mount.open,true);assert.equal(stray.mount.held,true,'restored-open first commit keeps Allow held');
    assert.equal(stray.ready,true,'the stray probe must run after drawnWhole released Allow');
    assert.equal(stray.mount.lastLine,true);assert.equal(stray.dropped,true,'document strayPress survives remount');assert.equal(stray.calls,1,'a moved deliberate press still answers');
    const replaced=await page.evaluate(async()=>{
      const frame=()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));
      document.querySelector('[data-nav-b]').click();await frame();document.querySelector('[data-replace]').click();await frame();document.querySelector('[data-nav-a]').click();await frame();
      return {mount:window.mounts.at(-1),ready:document.querySelector('[aria-label="Allow once"]').getAttribute('aria-disabled')!=='true',calls:window.calls.length};
    });
    assert.equal(replaced.mount.open,true);assert.equal(replaced.mount.held,true);assert.equal(replaced.mount.lastLine,true);
    assert.ok(replaced.mount.command.endsWith('echo replacement'));assert.equal(replaced.ready,true,'the exact replacement is released only after its whole draw');assert.equal(replaced.calls,1);
    const confirmation=await page.evaluate(async()=>{
      const frame=()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));
      const click=(el,detail)=>el.dispatchEvent(new MouseEvent('click',{bubbles:true,cancelable:true,detail,clientX:271,clientY:19}));
      document.querySelector('[data-nav-b]').click();await frame();click(document.querySelector('[data-return-confirm]'),1);await frame();
      const button=document.querySelector('[data-confirm]');click(button,1);const dropped=window.confirmed===0;click(button,0);
      return {dropped,confirmed:window.confirmed,mount:window.mounts.at(-1),calls:window.calls.length};
    });
    assert.equal(confirmation.mount.open,true);assert.equal(confirmation.mount.held,true);
    assert.equal(confirmation.dropped,true,'lastPointerPress on the return cannot confirm the new question');assert.equal(confirmation.confirmed,1,'keyboard confirmation still works');assert.equal(confirmation.calls,1);
    assert.deepEqual(errors,[]);console.log(JSON.stringify({width,restoredMountHeld:true,sameIdReplacementHeld:true,strayPressDropped:true,lastPointerPressDropped:true,deliberatePermissionRPC:1,errors}));
    await context.close();
  }
}finally{await browser?.close();await server?.close();if(scratch)await rm(scratch,{recursive:true,force:true});if(cache)await rm(cache,{recursive:true,force:true});}
