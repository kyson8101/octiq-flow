// Real component/browser regression. The transport is a persistent test double;
// Rust tests exercise the real profile store, revision checks and writes.
import assert from 'node:assert/strict';
import { browserPaths } from './browser-paths.mjs';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
const {webRoot, require, moduleUrl} = browserPaths(import.meta.url);
const { createServer, transformWithEsbuild } = await import(moduleUrl(require.resolve('vite')));
const { chromium } = await import(moduleUrl(process.env.PLAYWRIGHT_MODULE || 'playwright'));
const evidence = await mkdtemp(join(tmpdir(), 'octiq-media-review-'));
const clip = join(evidence, 'clip.mp4');
const result = spawnSync('ffmpeg', ['-hide_banner','-loglevel','error','-f','lavfi','-i','color=c=steelblue:s=480x270:d=5','-c:v','libx264','-pix_fmt','yuv420p','-movflags','+faststart',clip]);
assert.equal(result.status, 0, result.stderr?.toString());
const video = await readFile(clip);
const entry = `
import React from 'react'; import {createRoot} from 'react-dom/client';
import {ReviewVideo} from '/src/components/ReviewVideo.tsx';
import {Viewer} from '/src/components/Viewer.tsx';
import {bridge} from '/src/lib/bridge.ts';
import {onQuote} from '/src/lib/quote.ts';
import '/src/design-system.css'; import '/src/styles.css'; import '/src/components/MediaComments.css';
const events = new Map(); bridge.on=(event, fn)=>{if(!events.has(event))events.set(event,new Set());events.get(event).add(fn);return()=>events.get(event).delete(fn)};
bridge.fileUrl=()=>'/fixture.mp4'; bridge.fetchFile=()=>fetch('/fixture.svg').then(r=>r.blob());
window.calls=[]; window.lastQuote=null; onQuote(q=>window.lastQuote=q);
bridge.invoke=async(cmd,args)=>{
 window.calls.push({cmd,args});
 const key='media-review:'+args.path;
 const thread=JSON.parse(localStorage.getItem(key)||JSON.stringify({target:{path:args.path,revision:'v1',kind:args.path.endsWith('.mp4')?'video':'image'},comments:[]}));
 if(cmd==='media_comment_add'){
   await new Promise(r=>setTimeout(r,150));
   if(window.failWrite){window.failWrite=false;throw Error('test write failed');}
   if(!thread.comments.some(c=>c.id===args.id))thread.comments.push({id:args.id,text:args.text,timeMs:args.timeMs,createdAt:Date.now()});
 }
 if(cmd==='media_comment_remove')thread.comments=thread.comments.filter(c=>c.id!==args.id);
 localStorage.setItem(key,JSON.stringify(thread)); return thread;
};
function Demo(){const[image,setImage]=React.useState(false);return <main style={{maxWidth:700,margin:'auto',padding:16}}>
 <h1>Media review</h1><ReviewVideo path='/clip.mp4' onError={()=>{throw Error('video decode failed')}}/>
 <button onClick={()=>setImage(true)}>Show image</button>{image&&<Viewer path='/still.svg' onClose={()=>setImage(false)}/>}
 </main>}
createRoot(document.getElementById('root')).render(<Demo/>);
`;
const server = await createServer({ root: webRoot,
 server: {host:'127.0.0.1',port:0,strictPort:false}, plugins:[{
 name:'media-review-browser-fixture',
 resolveId(id){if(id==='virtual:media-review')return '\0media-review'},
 async load(id){if(id==='\0media-review')return (await transformWithEsbuild(entry,'fixture.tsx',{loader:'tsx',jsx:'automatic'})).code},
 configureServer(server){server.middlewares.use(async(req,res,next)=>{
  if(req.url==='/__review'){res.setHeader('Content-Type','text/html');res.end(await server.transformIndexHtml(req.url, '<div id="root"></div><script type="module" src="/@vite/client"></script><script type="module" src="/@id/__x00__media-review"></script>'));return;}
  if(req.url==='/fixture.mp4'){
    res.setHeader('Content-Type','video/mp4'); res.setHeader('Accept-Ranges','bytes');
    const range=req.headers.range?.match(/bytes=(\d+)-(\d*)/);
    const start=range?Number(range[1]):0; const end=range&&range[2]?Math.min(Number(range[2]),video.length-1):video.length-1;
    if(range){res.statusCode=206;res.setHeader('Content-Range',`bytes ${start}-${end}/${video.length}`)}
    res.setHeader('Content-Length',end-start+1);res.end(video.subarray(start,end+1));return;
  }
  if(req.url==='/fixture.svg'){res.setHeader('Content-Type','image/svg+xml');res.end('<svg xmlns="http://www.w3.org/2000/svg" width="640" height="360"><rect width="640" height="360" fill="#496080"/><circle cx="320" cy="180" r="80" fill="#ffe2aa"/></svg>');return;}
  if(req.url?.startsWith('/auth')){res.statusCode=401;res.end();return;}
  next();
 })}
 }]});
let browser;
const deadline=setTimeout(()=>{console.error('browser test timeout');process.exit(1)},60000);
console.log('fixture ready');
try {
 await server.listen(); console.log("server listening"); const port=server.httpServer.address().port;
 console.log("launching browser"); browser=await chromium.launch({headless:true,channel:process.env.PLAYWRIGHT_CHANNEL||'chrome'});
 console.log("browser launched"); const page=await browser.newPage({viewport:{width:1100,height:850}});
 page.on('pageerror',e=>console.error('PAGE',e.message)); page.on('console',m=>{if(m.type()==='error')console.error('CONSOLE',m.text())});
 await page.goto('http://127.0.0.1:'+port+'/__review');
 console.log('page loaded'); await page.locator('video').waitFor();
 await page.waitForFunction(()=>document.querySelector('video')?.readyState>=3);
 await page.evaluate(()=>{document.querySelector('video').currentTime=1.234;});
 await page.waitForFunction(()=>Math.abs(document.querySelector('video').currentTime-1.234)<.01 && !document.querySelector('video').seeking);
 console.log('before open',await page.locator('video').evaluate(v=>[v.currentTime,v.duration,v.readyState,v.seeking]));
 await page.getByRole('button',{name:'Comments',exact:true}).click();
 console.log('after open',await page.locator('video').evaluate(v=>[v.currentTime,v.duration,v.readyState,v.seeking]));
 const input=page.getByRole('textbox'); await input.fill('Fix this cut'); console.log('after fill',await page.locator('video').evaluate(v=>[v.currentTime,v.duration,v.readyState,v.seeking]));
 await page.evaluate(()=>{document.querySelector('video').currentTime=4;});
 await page.getByRole('button',{name:'Save comment',exact:true}).click();
 await page.getByText('Comment saved.',{exact:true}).waitFor();
 console.log('saved',await page.evaluate(()=>window.calls.filter(x=>x.cmd==='media_comment_add')), await page.locator('.media-comment-meta').innerText());
 assert.equal(await page.getByRole('button',{name:'00:01.234',exact:true}).count(),1);
 await page.reload(); await page.getByRole('button',{name:'Comments',exact:true}).click();
 await page.getByRole('button',{name:'00:01.234',exact:true}).click();
 assert.ok(Math.abs(await page.locator('video').evaluate(v=>v.currentTime)-1.234)<.02);
 await page.evaluate(()=>{window.failWrite=true});
 await page.getByRole('textbox').fill('Keep my draft');
 await page.getByRole('button',{name:'Save comment',exact:true}).click();
 await page.getByRole('alert').filter({hasText:'test write failed'}).waitFor();
 assert.equal(await page.getByRole('textbox').inputValue(),'Keep my draft');
 await page.getByRole('button',{name:'Save comment',exact:true}).click();
 await page.getByText('Comment saved.',{exact:true}).waitFor();
 assert.equal(await page.getByRole('listitem').count(),2);
 await page.getByRole('button',{name:'Add to chat',exact:true}).first().click();
 assert.match(await page.evaluate(()=>window.lastQuote.text),/00:01.234/);
 await page.getByRole('button',{name:'Show image',exact:true}).click();
 await page.locator('.viewer').getByRole('button',{name:'Comments',exact:true}).click();
 await page.locator('.viewer').getByRole('textbox').fill('Warm up the image');
 await page.locator('.viewer').getByRole('button',{name:'Save comment',exact:true}).click();
 await page.locator('.viewer').getByText('Comment saved.',{exact:true}).waitFor();
 await page.locator('.viewer').getByRole('button',{name:'Close',exact:true}).click();
 await page.getByRole('button',{name:'Show image',exact:true}).click();
 await page.locator('.viewer').getByRole('button',{name:'Comments',exact:true}).click();
 await page.getByText('Warm up the image',{exact:true}).waitFor();
 await page.screenshot({path:join(evidence,'image-desktop.png')});
 await page.setViewportSize({width:390,height:844});
 assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth),true);
 console.log('mobile layout',await page.locator('.viewer-bar').count(),await page.locator('.viewer').count());
 const saveRect=await page.locator('.viewer').getByRole('button',{name:'Save comment',exact:true}).boundingBox();
 assert.ok(saveRect && saveRect.y+saveRect.height<=844);
 await page.screenshot({path:join(evidence,'image-mobile.png')});
 await page.locator('.viewer').getByRole('button',{name:'Add to chat',exact:true}).click();
 assert.match(await page.evaluate(()=>window.lastQuote.text),/Image review/);
 assert.equal(await page.locator('.viewer').count(),0);
 await page.screenshot({path:join(evidence,'video-mobile.png')});
 await writeFile(join(evidence,'result.json'),JSON.stringify({ok:true,checks:['frozen video anchor','seek','reload persistence','failed write retains draft','retry','image notes','chat context','mobile width']},null,2));
 console.log('PASS '+evidence);
} finally {clearTimeout(deadline);await browser?.close();await server.close();}
