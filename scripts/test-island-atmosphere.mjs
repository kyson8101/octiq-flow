// Isolated real WebGL check: registered residents only, rain umbrellas and
// leader aura. It never connects to the running OctiqFlow backend.
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {mkdtemp} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
const require=createRequire(new URL('../web/package.json',import.meta.url));
const {createServer}=await import(require.resolve('vite'));
const {chromium}=await import(process.env.PLAYWRIGHT_MODULE||'playwright');
const evidence=await mkdtemp(join(tmpdir(),'octiq-island-atmosphere-'));
const source=`
import {IslandView} from '/src/lib/island/scene.ts';
import {residentsOf,cellCenter} from '/src/lib/island/model.ts';
const roster=[{id:'lead',name:'Maya',agent:'codex',model:'sol',leader:true},{id:'member',name:'Kai',agent:'claude',model:'sonnet',leader:false}];
const plots=roster.map((a,i)=>({id:'p'+i,owner:{kind:'agent',id:a.id},ring:1,slot:i,q:i-1,r:1,...cellCenter(i-1,1),facing:150,radius:6.3,claimedAt:0}));
const island={version:1,rev:1,seed:42,createdAt:0,updatedAt:0,radius:30,settings:{wishPace:'sometimes'},plots,bots:[{id:'chip',name:'Chip',trait:'cozy',look:{},arrivedAt:0}],looks:{},assets:[],placed:[],wishes:[],lastRollAt:0};
const residents=residentsOf(island,roster);window.names=residents.map(r=>r.name);
const view=new IslandView(document.getElementById('stage'),{onPick:()=>{}},false);
view.setIsland(island,residents);view.setHourOverride(12);view.setWeather('rain');window.view=view;
`;
const server=await createServer({root:new URL('../web',import.meta.url).pathname,server:{host:'127.0.0.1',port:0,strictPort:false},plugins:[{
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
 assert.deepEqual(errors,[]);
 await page.evaluate(()=>window.view.dispose());
 console.log('PASS '+evidence);
}finally{await browser?.close();await server.close();clearTimeout(deadline);}
