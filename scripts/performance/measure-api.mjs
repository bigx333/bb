import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
const [runArg,origin,label]=process.argv.slice(2);
const run=path.resolve(runArg);
const fixture=JSON.parse(fs.readFileSync(path.join(run,'fixture.json'),'utf8'));
const results=[];
for(const [name,thread] of Object.entries(fixture.threads)) {
  for(let sample=0;sample<3;sample++) {
    const start=performance.now();
    const response=await fetch(`${origin}/api/v1/threads/${thread.id}/timeline`,{headers:{'accept-encoding':'br'}});
    const ttfbMs=performance.now()-start;
    const text=await response.text();
    const totalMs=performance.now()-start;
    if(!response.ok) throw Error(text);
    const body=JSON.parse(text);
    const sha256=crypto.createHash('sha256').update(text).digest('hex');
    results.push({name,sample,status:response.status,ttfbMs,totalMs,sha256,decodedBytes:Buffer.byteLength(text),rows:body.rows.length,maxSeq:body.maxSeq,page:body.timelinePage});
    fs.writeFileSync(path.join(run,`${label}-${name}-response.json`),text);
  }
}
fs.writeFileSync(path.join(run,`${label}-api.json`),JSON.stringify({origin,fixture,results},null,2));
console.log(results.map(({page,...r})=>r));
