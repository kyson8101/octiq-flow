// Isolated real WebGL check: registered residents only, rain umbrellas and
// leader aura. It never connects to the running OctiqFlow backend.
import assert from 'node:assert/strict';
import {browserPaths} from './browser-paths.mjs';
import {mkdtemp} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
const {webRoot,require,moduleUrl}=browserPaths(import.meta.url);
const {createServer}=await import(moduleUrl(require.resolve('vite')));
const {chromium}=await import(moduleUrl(process.env.PLAYWRIGHT_MODULE||'playwright'));
const evidence=await mkdtemp(join(tmpdir(),'octiq-island-atmosphere-'));
const source=`
import {IslandView} from '/src/lib/island/scene.ts';
import {residentsOf,cellCenter} from '/src/lib/island/model.ts';
const roster=[{id:'lead',name:'Maya',agent:'codex',model:'sol',leader:true},{id:'member',name:'Kai',agent:'claude',model:'sonnet',leader:false}];
const plots=roster.map((a,i)=>({id:'p'+i,owner:{kind:'agent',id:a.id},ring:1,slot:i,q:i-1,r:1,...cellCenter(i-1,1),facing:150,radius:6.3,claimedAt:0}));
const island={version:1,rev:1,seed:42,createdAt:0,updatedAt:0,radius:30,settings:{wishPace:'sometimes'},plots,bots:[{id:'chip',name:'Chip',trait:'cozy',look:{},arrivedAt:0}],looks:{},assets:[],placed:[],wishes:[],lastRollAt:0};
const residents=residentsOf(island,roster);window.fixture={island,residents};window.names=residents.map(r=>r.name);
const view=new IslandView(document.getElementById('stage'),{onPick:()=>{}},false);
view.setIsland(island,residents);view.setHourOverride(12);view.setWeather('rain');window.view=view;
`;
const server=await createServer({root:webRoot,server:{host:'127.0.0.1',port:0,strictPort:false},plugins:[{
 name:'island-atmosphere-fixture',resolveId(id){if(id==='\0atmosphere')return id},load(id){if(id==='\0atmosphere')return source},
 configureServer(server){server.middlewares.use(async(req,res,next)=>{if(req.url!=='/__island')return next();res.setHeader('Content-Type','text/html');res.end(await server.transformIndexHtml(req.url,'<style>body{margin:0}#stage{width:100vw;height:100vh}</style><div id="stage"></div><script type="module" src="/@id/__x00__atmosphere"></script>'))})}
}]});
let browser;const deadline=setTimeout(()=>{console.error('island browser timeout');process.exit(1)},60000);
try{
 await server.listen();browser=await chromium.launch({headless:true,channel:process.env.PLAYWRIGHT_CHANNEL||'chrome',args:['--enable-unsafe-swiftshader']});
 const page=await browser.newPage({viewport:{width:1100,height:800}});
 const errors=[];page.on('pageerror',e=>errors.push(e.message));
 await page.goto('http://127.0.0.1:'+server.httpServer.address().port+'/__island');
 await page.waitForFunction(()=>window.view?.rain.object.visible);
 assert.deepEqual(await page.evaluate(()=>window.names),['Maya','Kai']);
 const gear=await page.evaluate(()=>[...window.view.robots].map(([key,v])=>({key,umbrella:v.atmosphere.umbrella.visible,aura:v.atmosphere.aura.visible})));
 assert.deepEqual(gear,[{key:'agent:lead',umbrella:true,aura:true},{key:'agent:member',umbrella:true,aura:false}]);
 await page.screenshot({path:join(evidence,'rain-leader-aura.png')});
 await page.evaluate(()=>window.view.setWeather('sunny'));
 await page.waitForFunction(()=>[...window.view.robots.values()].every(v=>!v.atmosphere.umbrella.visible));
 await page.screenshot({path:join(evidence,'sunny.png')});
 await page.evaluate(()=>{
   const sim=window.view.sim;
   const star=sim.robots.get('agent:lead');const fan=sim.robots.get('agent:member');
   for(const [r,x] of [[star,0],[fan,3]]) {r.x=x;r.z=-5;r.path=[];r.perched=false;r.bubble=null;r.chatAfter=0;}
   star.plan={label:'Performing',goal:null,act:{kind:'dance',seconds:60},since:sim.clockNow};
   fan.plan={label:'Watching',goal:null,act:{kind:'look',seconds:60},since:sim.clockNow};
   window.view.centerOn?.('agent:lead');
 });
 await page.waitForFunction(()=>window.view.sim.audience('agent:lead')===1);
 await page.waitForFunction(()=>window.view.robots.get('agent:lead').concert.root.scale.x>.95);
 await page.screenshot({path:join(evidence,'concert.png')});
 await page.evaluate(()=>{const s=window.view.sim;const r=s.robots.get('agent:lead');r.plan={label:'Finished',goal:null,act:{kind:'look',seconds:60},since:s.clockNow};});
 await page.waitForFunction(()=>!window.view.robots.get('agent:lead').concert.root.visible);
 assert.equal(await page.evaluate(()=>window.view.sim.audience('agent:lead')),0);
 await page.evaluate(()=>{
   const {island,residents}=window.fixture;
   const officePeople=residents.map(r=>({...r,agent:{...r.agent,teamId:'studio',teamName:'Studio'}}));
   const general={...residents[1],key:'agent:general',owner:{kind:'agent',id:'general'},name:'General',agent:{...residents[1].agent,id:'general',name:'General',teamId:undefined}};
   window.view.setIsland(island,[...officePeople,general]);
   window.view.setModes(new Map([...officePeople,general].map(r=>[r.key,{state:'working'}])));
 });
 await page.waitForFunction(()=>[...window.view.sim.robots.values()].every(r=>r.plan.act.kind==='work'&&r.perched));
 const offices=await page.evaluate(()=>({plots:window.view.island.plots.map(p=>p.officeName),seats:[...window.view.sim.robots.values()].map(r=>({key:r.key,owner:r.plan.act.seat?.owner,seat:r.plan.act.seat?.key}))}));
 assert.deepEqual(offices.plots.sort(),['Agent Tower','Studio Office']);
 assert.equal(new Set(offices.seats.map(s=>s.seat)).size,3);
 assert.ok(offices.seats.every(s=>s.owner===s.key));
 await page.evaluate(()=>{window.view.camera.position.set(24,28,36);window.view.controls.target.set(0,0,0);window.view.controls.update();});
 await page.screenshot({path:join(evidence,'shared-offices.png')});
 await page.evaluate(()=>{
   const {island,residents}=window.fixture;
   const moved=residents.map(r=>({...r,agent:{...r.agent,teamId:r.key==='agent:lead'?'studio':undefined,teamName:'Studio'}}));
   const extra={...residents[1],key:'agent:general',owner:{kind:'agent',id:'general'},name:'General',agent:{...residents[1].agent,id:'general',teamId:undefined}};
   window.view.setIsland(island,[...moved,extra]);
 });
 await page.waitForFunction(()=>[...window.view.sim.robots.values()].every(r=>r.plan.act.kind==='work'&&r.perched&&r.plan.act.seat?.owner===r.key));
 assert.equal(await page.evaluate(()=>window.view.sim.robots.get('agent:member').resident.plot.id),'office:general');
 assert.deepEqual(errors,[]);
 await page.evaluate(()=>window.view.dispose());
 console.log('PASS '+evidence);
}finally{await browser?.close();await server.close();clearTimeout(deadline);}
