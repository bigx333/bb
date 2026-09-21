import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const [runArg, origin, widthArg, scenario, label = 'baseline'] = process.argv.slice(2);
const run = path.resolve(runArg);
const fixture = JSON.parse(fs.readFileSync(path.join(run, 'fixture.json'), 'utf8'));
const width = Number(widthArg);
const config = { run, origin, width, height: width < 600 ? 844 : 1000, scenario, label, fixture };
async function measure(c) {
  const p = await browser.getPage('benchmark');
  await p.setViewport({ width: c.width, height: c.height, deviceScaleFactor: 2 });
  const setup = () => {
    window.__bench = { longTasks: [], errors: [], readyAt: null };
    performance.setResourceTimingBufferSize(2000);
    window.__benchObserver?.disconnect();
    window.__benchObserver=new PerformanceObserver(list => window.__bench.longTasks.push(...list.getEntries().map(e => ({start:e.startTime,duration:e.duration}))));
    window.__benchObserver.observe({type:'longtask',buffered:true});
    window.addEventListener('error',e => window.__bench.errors.push(e.message));
  };
  const injected = await p.evaluateOnNewDocument(setup);
  await p.evaluate(setup);
  const session = await p.createCDPSession();
  await session.send('Network.enable');
  const version = await session.send('Browser.getVersion');
  const results = [];
  const route = name => `/projects/${c.fixture.projectId}/threads/${c.fixture.threads[name].id}`;
  const waitReady = async marker => {
    await p.waitForFunction(value => {
      const matches = value === 'home' ? [...document.querySelectorAll('[contenteditable="true"]')] : [...document.querySelectorAll('strong')].filter(e => e.textContent === value);
      const ready = matches.some(e => { const r=e.getBoundingClientRect(); return r.width>0 && r.height>0 && r.top<innerHeight && r.bottom>0; });
      if(ready) {window.__bench.readyAt ??= performance.now();return true;}
      return false;
    },{timeout:20000},marker);
    await p.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
  };
  const openSidebar = async () => {
    if(c.width>=600) return;
    const link = await p.$('a[href="'+route('small')+'"]');
    if(link && await link.evaluate(e=>{const r=e.getBoundingClientRect();return r.left>=0&&r.right<=innerWidth&&r.width>0;})) return;
    const button=await p.$('button[aria-label^="Toggle sidebar"]');
    if(button) {await button.click(); await new Promise(r=>setTimeout(r,350));}
  };
  for(let sample=0;sample<(c.scenario==='windowing'?6:c.scenario==='profile'?1:3);sample++) {
    const windowing=c.scenario==='windowing'?sample%2===1:null;
    if(windowing!==null) {
      const current=await (await fetch(c.origin+'/api/v1/system/config')).json();
      const response=await fetch(c.origin+'/api/v1/settings/experiments',{method:'PUT',headers:{'content-type':'application/json'},body:JSON.stringify({...current.experiments,timelineWindowing:windowing})});
      if(!response.ok) throw Error('Experiment update failed: '+response.status);
    }
    const errors=[];
    const onError=e=>errors.push(e.message);
    const onConsole=m=>{if(m.type()==='error') errors.push(m.text());};
    p.on('pageerror',onError);p.on('console',onConsole);
    const isNav=['cold-home','hard-reload','small-direct','long-direct'].includes(c.scenario);
    if(c.scenario==='cold-home') {await p.goto('about:blank');await session.send('Network.clearBrowserCache');}
    if(c.scenario==='hard-reload') {await p.goto(c.origin+'/');await waitReady('home');}
    if(['small','long','settings','home','switch','windowing','profile'].includes(c.scenario)) {
      const start=c.scenario==='switch'?route('small'):c.scenario==='home'?'/settings':'/';
      await p.goto(c.origin+start);if(c.scenario==='home') await p.waitForFunction(()=>document.body.innerText.includes('Appearance')); else await waitReady(c.scenario==='switch'?'SMALL READY 3':'home');
      await new Promise(r=>setTimeout(r,200));
      if(['small','long','switch','settings','windowing','profile'].includes(c.scenario)) await openSidebar();
    }
    await p.evaluate(()=>{performance.clearResourceTimings();window.__bench.longTasks=[];window.__bench.errors=[];window.__bench.readyAt=null;});
    if(c.scenario==='profile'){await session.send('Profiler.enable');await session.send('Profiler.start');}
    const start=await p.evaluate(()=>performance.now());
    if(c.scenario==='cold-home') await p.goto(c.origin+'/',{waitUntil:'domcontentloaded'});
    else if(c.scenario==='hard-reload') await p.reload({waitUntil:'domcontentloaded'});
    else if(c.scenario.endsWith('-direct')) await p.goto(c.origin+route(c.scenario.split('-')[0]),{waitUntil:'domcontentloaded'});
    else if(c.scenario==='settings') await p.click('a[href="/settings"]');
    else if(c.scenario==='home') {
      const back=await p.$('a[href="/"]');
      if(back) await back.click(); else await p.click('button[aria-label^="New thread"]');
    }
    else {const target='a[href="'+route(['switch','windowing','profile'].includes(c.scenario)?'long':c.scenario)+'"]'; const visible=await p.$$(target); for(const link of visible){if(await link.evaluate(e=>{const r=e.getBoundingClientRect();return r.left>=0&&r.right<=innerWidth&&r.width>0;})){await link.click();break;}}}
    if(c.scenario==='settings') {
      await p.waitForFunction(()=>location.pathname.startsWith('/settings')&&document.body.innerText.includes('Appearance'),{timeout:15000});
      await p.evaluate(()=>{window.__bench.readyAt=performance.now();});
    } else await waitReady(c.scenario.includes('long')||['switch','windowing','profile'].includes(c.scenario)?'LONG READY 40':c.scenario.includes('small')?'SMALL READY 3':'home');
    const painted=await p.evaluate(()=>performance.now());
    await new Promise(r=>setTimeout(r,500));
    const metrics=await p.evaluate(({start,isNav})=>{
      const since=isNav?0:start;
      const resources=performance.getEntriesByType('resource').filter(e=>e.startTime>=since).map(e=>({url:new URL(e.name).pathname+new URL(e.name).search,start:e.startTime-since,ms:e.duration,ttfb:e.responseStart-e.requestStart,wire:e.transferSize,encoded:e.encodedBodySize,decoded:e.decodedBodySize,status:e.responseStatus,type:e.initiatorType}));
      const nav=performance.getEntriesByType('navigation')[0];
      return {readyMs:window.__bench.readyAt-since,domNodes:document.querySelectorAll('*').length,rowCount:document.querySelectorAll('[data-timeline-row-id]').length,nav:isNav&&nav?{ttfb:nav.responseStart-nav.requestStart,domContentLoaded:nav.domContentLoadedEventEnd,load:nav.loadEventEnd,wire:nav.transferSize}:null,resources,longTasks:[...new Map(window.__bench.longTasks.map(e=>[e.start+":"+e.duration,e])).values()].filter(e=>e.start>=since).map(e=>({...e,start:e.start-since})),errors:window.__bench.errors,url:location.href};
    },{start,isNav});
    const profile=c.scenario==='profile'?(await session.send('Profiler.stop')).profile:null;
    results.push({sample,windowing,profile,...metrics,paintedMs:painted-(isNav?0:start),consoleErrors:errors});
    p.off('pageerror',onError);p.off('console',onConsole);
  }
  await p.screenshot({path:c.run+'/'+c.label+'-'+c.width+'-'+c.scenario+'.png'});
  await p.removeScriptToEvaluateOnNewDocument(injected.identifier);
  console.log(JSON.stringify({config:c,browser:version,results}));
}
const script=`(${measure.toString()})(${JSON.stringify(config)})`;
const result=spawnSync('dev-browser',['--headless','-b',fixture.browserName,'-t','100','-e',script],{encoding:'utf8',maxBuffer:12*1024*1024});
const base=path.join(run,`${label}-${width}-${scenario}`);
const fullOutput=result.stdout.match(/full output: ([^ ]+)/)?.[1];
const stdout=fullOutput?fs.readFileSync(fullOutput,'utf8'):result.stdout;
fs.writeFileSync(base+'.json',stdout);
fs.writeFileSync(base+'.stderr.txt',result.stderr);
if(result.status!==0){console.error(result.stderr,result.stdout);process.exit(result.status??1);}
const data=JSON.parse(stdout);
console.log(JSON.stringify({scenario,width,origin,results:data.results.map(r=>({windowing:r.windowing,ready:r.readyMs,painted:r.paintedMs,wire:r.resources.reduce((n,e)=>n+e.wire,0),longTaskMs:r.longTasks.reduce((n,e)=>n+e.duration,0),errors:r.consoleErrors.length,rows:r.rowCount}))}));
