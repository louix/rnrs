// Read-only WebGPU availability probe: per-process Chromium flags only, no global settings.
// Usage (inside nix develop .#web --offline): node fixtures/web-webgpu-probe/probe.mjs '["--enable-unsafe-webgpu"]'
import {spawn} from 'node:child_process';
import {mkdtemp, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os'; import path from 'node:path'; import http from 'node:http';
const server = http.createServer((q,r)=>{r.setHeader('content-type','text/html');r.end('<!doctype html><body>probe</body>')});
await new Promise(r=>server.listen(0,'127.0.0.1',r));
const url=`http://127.0.0.1:${server.address().port}/`;
const flags = JSON.parse(process.argv[2]);
const profile = await mkdtemp(path.join(tmpdir(),'wgp-'));
const b = spawn(process.env.CHROMIUM ?? 'chromium',['--headless=new','--no-first-run',`--user-data-dir=${profile}`,'--remote-debugging-port=0',...flags,'about:blank'],{stdio:['ignore','ignore','pipe']});
let log='';
const wsUrl = await new Promise((res,rej)=>{b.stderr.on('data',c=>{log+=c;const m=log.match(/DevTools listening on (ws:\/\/\S+)/);if(m)res(m[1]);});b.on('exit',c=>rej(new Error('exit '+c+log)));});
const ws=new WebSocket(wsUrl); await new Promise(r=>ws.onopen=r);
let id=1;const w=new Map();ws.onmessage=e=>{const m=JSON.parse(e.data);if(m.id&&w.has(m.id)){w.get(m.id)(m);w.delete(m.id);}};
const send=(method,params={},sessionId)=>new Promise(r=>{const i=id++;w.set(i,r);ws.send(JSON.stringify({id:i,method,params,sessionId}));});
const {result:{targetId}}=await send('Target.createTarget',{url});
const {result:{sessionId}}=await send('Target.attachToTarget',{targetId,flatten:true});
await new Promise(r=>setTimeout(r,1000));
const expr=`(async()=>{const o={secure:isSecureContext,gpu:!!navigator.gpu};if(!navigator.gpu)return o;
for (const opt of [{}, {forceFallbackAdapter:true}]) {
 const a=await Promise.race([navigator.gpu.requestAdapter(opt),new Promise(r=>setTimeout(()=>r('timeout'),5000))]);
 const k=JSON.stringify(opt);
 if(!a||a==='timeout'){o[k]=a===null?null:a;continue;}
 const i=a.info||{};o[k]={vendor:i.vendor,arch:i.architecture,device:i.device,desc:i.description,fallback:i.isFallbackAdapter};
 try{const d=await a.requestDevice();const c=document.createElement('canvas');const x=c.getContext('webgpu');x.configure({device:d,format:navigator.gpu.getPreferredCanvasFormat()});o[k].device='ok';o[k].fmt=navigator.gpu.getPreferredCanvasFormat();d.destroy();}catch(e){o[k].device=String(e)}
}return o;})()`;
const r=await send('Runtime.evaluate',{expression:expr,awaitPromise:true,returnByValue:true},sessionId);
const v=await send('Browser.getVersion');
console.log(JSON.stringify({flags,product:v.result.product,res:r.result.result?.value??r.result}));
ws.close();b.kill();server.close();await new Promise(r=>b.once('exit',r));await rm(profile,{recursive:true,force:true,maxRetries:5});
