import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {mkdtemp} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
const require=createRequire(new URL('../web/package.json',import.meta.url));
const {createServer}=await import(require.resolve('vite'));
const {chromium}=await import(process.env.PLAYWRIGHT_MODULE||'playwright');
const evidence=await mkdtemp(join(tmpdir(),'octiq-society-'));
const entry=`
import {IslandView} from '/src/lib/island/scene.ts';
import {residentsOf,cellCenter} from '/src/lib/island/model.ts';
import {SOCIETY_CENTER} from '/src/lib/island/society.ts';
const roster=['gardener','reader','musician'].map(id=>({id,name:id,agent:'codex',model:'sol'}));
const plots=roster.map((a,i)=>({id:'p'+i,owner:{kind:'agent',id:a.id},ring:1,slot:i,q:i-1,r:1,...cellCenter(i-1,1),facing:150,radius:6.3,claimedAt:0}));
const part=(shape,size,at,color)=>({shape,size,at,color});
const assets=[{id:'planter',rev:1,name:'Mint Seedling Planter',kind:'decor',parts:[part('box',[.8,.4,.8],[0,.2,0],'#ac8363'),part('sphere',[.5,.4,.5],[0,.6,0],'#76bd66')]},{id:'books',rev:1,name:'Pine Library Bookshelf',kind:'furniture',parts:[part('box',[1,1.4,.4],[0,.7,0],'#c4a177')]}].map(a=>({...a,by:{name:'Gift maker',chatKey:'gift'},madeAt:0,updatedAt:0}));
const island={version:1,rev:1,seed:42,createdAt:0,updatedAt:0,radius:35,settings:{wishPace:'sometimes'},plots,bots:[],looks:{},assets,placed:assets.map((a,i)=>({id:'gift'+i,plot:'p'+i,asset:a.id,x:0,z:0,y:0,turn:0})),wishes:[],lastRollAt:0};
const residents=residentsOf(island,roster).map((r,i)=>({...r,hobbies:[['gardening','reading','music'][i]]}));
window.receipts=[];const view=new IslandView(document.getElementById('stage'),{onPick:()=>{},onWishRegister:id=>{window.receipts.push(id);island.wishes=island.wishes.map(w=>w.id===id?{...w,state:'open'}:w);view.setIsland(island,residents)}},false);
view.setIsland(island,residents);view.setHourOverride(12);view.setWeather('sunny');view.setModes(new Map(residents.map(r=>[r.key,{state:'working'}])));
window.fixture={island,residents};window.view=view;window.societyCenter=SOCIETY_CENTER;
`;
const server=await createServer({root:new URL('../web',import.meta.url).pathname,server:{host:'127.0.0.1',port:0,strictPort:false},plugins:[{name:'society-fixture',resolveId(id){if(id==='\0society')return id},load(id){if(id==='\0society')return entry},configureServer(server){server.middlewares.use(async(req,res,next)=>{if(req.url!=='/__society')return next();res.setHeader('Content-Type','text/html');res.end(await server.transformIndexHtml(req.url,'<style>body{margin:0}#stage{width:100vw;height:100vh}</style><div id="stage"></div><script type="module" src="/@id/__x00__society"></script>'))})}}]});
let browser;const timeout=setTimeout(()=>{console.error('society timeout');process.exit(1)},110000);
try{
 await server.listen();browser=await chromium.launch({headless:true,channel:'chrome',args:['--enable-unsafe-swiftshader']});
 const page=await browser.newPage({viewport:{width:1200,height:900}});const errors=[];page.on('pageerror',e=>errors.push(e.message));
 await page.goto('http://127.0.0.1:'+server.httpServer.address().port+'/__society');await page.waitForFunction(()=>window.view?.sim?.robots.size===3);
 assert.equal(await page.evaluate(()=>window.view.society.root.name),'bot-society');
 const actor=await page.evaluate(()=>{const v=window.view;v.setModes(new Map([['agent:gardener',{state:'free'}]]));return v.sim.useAsset('gift0','agent:gardener')});
 if(!actor)console.log(await page.evaluate(()=>({sites:window.view.sim.places.activities,robot:window.view.sim.robots.get('agent:gardener'),taken:[...window.view.sim.taken]})));
 assert.equal(actor,'agent:gardener');
 await page.waitForFunction(()=>{const r=window.view.sim.robots.get('agent:gardener');return r.plan.act.kind==='interact'&&!r.path.length&&window.view.robots.get(r.key).activity.root.children.some(c=>c.name==='garden'&&c.visible)});
 await page.waitForFunction(()=>window.view.gardenBeds.get('gift0')?.root.visible);
 await page.screenshot({path:join(evidence,'gardening.png')});
 await page.evaluate(()=>{
  const {island,residents}=window.fixture;const v=window.view;v.sim.release(v.sim.robots.get('agent:gardener'),v.clock);
  island.wishes=residents.map((r,i)=>({id:'wish'+i,who:r.owner,want:'decor',text:'a gift',madeAt:i,state:'queued'}));
  for(const [i,r] of [...v.sim.robots.values()].entries()){r.x=window.societyCenter.x+i*.8;r.z=window.societyCenter.z+5;r.path=[];r.perched=false;r.plan={label:'Idle',goal:null,act:{kind:'look',seconds:60},since:v.clock};}
  v.setIsland(island,residents);v.setModes(new Map(residents.map(r=>[r.key,{state:'free'}])));
  v.camera.position.set(window.societyCenter.x+13,16,window.societyCenter.z+20);v.controls.target.set(window.societyCenter.x,1,window.societyCenter.z);v.controls.update();
 });
 await page.waitForFunction(()=>[...window.view.sim.robots.values()].some(r=>r.pose==='register'),null,{timeout:30000});
 const inside=await page.evaluate(()=>{const r=[...window.view.sim.robots.values()].find(r=>r.pose==='register');return r.z<window.societyCenter.z+1&&Math.abs(r.x-window.societyCenter.x)<2});assert.equal(inside,true);
 await page.screenshot({path:join(evidence,'society-registration.png')});
 await page.waitForFunction(()=>window.receipts.length===3,null,{timeout:35000});assert.deepEqual(await page.evaluate(()=>window.receipts),['wish0','wish1','wish2']);
 assert.deepEqual(errors,[]);await page.evaluate(()=>window.view.dispose());console.log('PASS '+evidence);
}finally{await browser?.close();await server.close();clearTimeout(timeout)}
