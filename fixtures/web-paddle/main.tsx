import React, {StrictMode, useLayoutEffect} from 'react';
import {createRoot, type Root} from 'react-dom/client';
import {flushSync} from 'react-dom';
import {AppState, Linking} from 'react-native';
import {installWebBackend, setBackend, type RnrWasm} from '@rnrs/runtime/web';
import {SurfaceView} from '@rnrs/surface';
import {createSurfaceBootstrap} from '@rnrs/surface/browser';
import {createVello2DModuleForTesting, vello2DModule, type Renderer} from '@rnrs/example-vello2d';
import {FrameWriter} from '@rnrs/example-vello2d/frame';
import init, * as wasm from './.rnr/web/pkg/rnr_bundle.js';
import App from './.generated/game/App';

const checks: {name:string;ok:boolean;detail:string}[]=[];
const reports: any[]=[];
const snapshots: any[]=[];
const log=console.log;
console.log=(...args: unknown[])=>{
  const text=String(args[0]);
  if(text.startsWith('RNR_GAME ')) reports.push(JSON.parse(text.slice(9)));
  if(text.startsWith('RNR_GAME_STATS ')) snapshots.push(JSON.parse(text.slice(15)));
  log(...args);
};
const assert=(ok: unknown,message:string)=>{if(!ok) throw new Error(message);};
const passed=(name:string,detail='')=>checks.push({name,ok:true,detail});
const delay=(ms:number)=>new Promise(resolve=>setTimeout(resolve,ms));
async function until(predicate:()=>unknown, label:string, timeout=8000) {
  const end=performance.now()+timeout;
  while(!predicate()) { if(performance.now()>end) throw new Error('Timeout: '+label); await delay(20); }
}
let actionId=0;
async function action(type:string,args:Record<string,number>) {
  const id=++actionId;
  (globalThis as any).__w2Action={id,type,...args};
  await until(()=> (globalThis as any).__w2ActionDone===id || (globalThis as any).__w2ActionError,'CDP '+type);
  if((globalThis as any).__w2ActionError) throw new Error((globalThis as any).__w2ActionError);
}
const diagnostics=()=>Array.from(wasm.rnr_surface_diagnostics()) as number[];
const latest=()=>snapshots.at(-1);
const container=document.getElementById('root')!;
let root: Root | undefined;
let backend: ReturnType<typeof installWebBackend> | undefined;
let visibility='visible';
function show(visible:boolean) {
  visibility=visible?'visible':'hidden';
  document.dispatchEvent(new Event('visibilitychange'));
}
function unmount() { if(root) { const old=root; root=undefined; flushSync(()=>old.unmount()); } }
function mountApp() {
  const module=vello2DModule(), created:Renderer[]=[];
  const original=module.create.bind(module);
  module.create=options=>{const renderer=original(options);created.push(renderer);return renderer;};
  root=createRoot(container);
  flushSync(()=>root!.render(<StrictMode><App/></StrictMode>));
  return {module,created};
}
async function main() {
  await init({module_or_path:new URL('../.rnr/web/pkg/rnr_bundle_bg.wasm',import.meta.url)});
  backend=installWebBackend(wasm as unknown as RnrWasm,createSurfaceBootstrap);
  assert((await Linking.getInitialURL())===window.location.href,'RNWeb Linking preserves initial HTTP URL');
  assert(AppState.currentState==='active','RNWeb AppState starts active');
  passed('RNWeb Linking/AppState use browser URL and visibility without an app shim');

  const cached=vello2DModule();
  setBackend(backend);
  assert(vello2DModule()===cached,'same backend identity preserves cached module');
  passed('unchanged backend identity preserves the normal module accessor');

  const module=createVello2DModuleForTesting(8), renderer=module.create({resolutionScale:1,timingRecords:0});
  const simpleKey=renderer.surfaceKey();
  renderer.submit(new FrameWriter().clear([1,0,0,1]).finish());
  let layouts=0;
  root=createRoot(container);
  const simple=(width:number,height:number,key:number|undefined=renderer.surfaceKey())=>
    <StrictMode><SurfaceView surfaceKey={key} style={{width,height}} onLayout={()=>{layouts++;}}/></StrictMode>;
  flushSync(()=>root!.render(simple(100.5,80.25)));
  await until(()=>renderer.stats().framesPresented>0,'StrictMode canvas draw');
  let canvas=container.querySelector('canvas')!;
  assert(canvas.getContext('2d')!.getImageData(0,0,1,1).data[0]===255,'real SurfaceView displayed Rust pixels');
  assert(renderer.stats().attaches>=2 && diagnostics()[1]===1,'StrictMode attaches cleanly without duplicate producer');
  await until(()=>layouts>0,'RNWeb onLayout');
  passed('packaged SurfaceView conditional export draws with StrictMode and forwarded onLayout');
  await action('dpr',{value:2});
  await until(()=>canvas.width===201 && canvas.height===161,'fractional DPR geometry');
  assert(renderer.stats().scale===2,'DPR applied exactly once');
  flushSync(()=>root!.render(simple(120.25,90.5)));
  await until(()=>canvas.width===241 && canvas.height===181,'component resize');
  passed('fractional CSS content sizes become physical backing pixels at DPR2');
  flushSync(()=>root!.render(<StrictMode><SurfaceView surfaceKey={undefined} style={{width:120.25,height:90.5}}/></StrictMode>));
  await until(()=>container.querySelector('canvas')!.width===0,'undefined key detach');
  canvas=container.querySelector('canvas')!;
  flushSync(()=>root!.render(simple(120.25,90.5,0)));
  await until(()=>canvas.width===0 && renderer.stats().state==='detached','zero key detach');
  flushSync(()=>root!.render(simple(120.25,0)));
  await until(()=>renderer.stats().state==='detached','zero extent');
  flushSync(()=>root!.render(simple(120.25,90.5)));
  await until(()=>renderer.stats().state==='attached','positive extent resume');
  unmount(); renderer.close(); module.teardown();
  assert(diagnostics()[1]===0 && diagnostics()[2]===0,'simple surface unmount released raster/producer');
  passed('key changes and zero extent detach; positive extent resumes; unmount cleans up');
  await action('dpr',{value:1});

  // Keep this SurfaceView mounted across replacement. Its old key becomes closed;
  // a subsequent author key update attaches to the new host without a root remount.
  let retainedModule=vello2DModule();
  let retained=retainedModule.create({resolutionScale:1,timingRecords:0});
  const retainedKey=retained.surfaceKey();
  retained.submit(new FrameWriter().clear([0,1,0,1]).finish());
  root=createRoot(container);
  flushSync(()=>root!.render(<SurfaceView surfaceKey={retainedKey} style={{width:80,height:60}}/>));
  await until(()=>retained.stats().framesPresented>0,'mounted replacement initial draw');
  backend=installWebBackend(wasm as unknown as RnrWasm,createSurfaceBootstrap);
  await until(()=>container.querySelector('canvas')!.width===0,'mounted old key cleared');
  assert(wasm.rnr_surface_attach(retainedKey,8,8,1)==='closed','mounted old renderer key closed');
  assert(diagnostics()[1]===0 && diagnostics()[2]===0 && diagnostics()[3]===0,'replacement released old resources');
  assert(vello2DModule()!==retainedModule,'changed backend identity invalidates cached module');
  retainedModule=vello2DModule();
  retained=retainedModule.create({resolutionScale:1,timingRecords:0});
  retained.submit(new FrameWriter().clear([0,0,1,1]).finish());
  const keySwapOldCanvas=container.querySelector('canvas')!;
  flushSync(()=>root!.render(<SurfaceView surfaceKey={retained.surfaceKey()} style={{width:80,height:60}}/>));
  await until(()=>retained.stats().framesPresented>0,'same mounted component new key');
  // Each surface key gets a fresh canvas (a canvas keeps its first context type). The old
  // element is gone and cleared; its mount's cleanup cannot touch the new one.
  assert(container.querySelectorAll('canvas').length===1 && container.querySelector('canvas')!==keySwapOldCanvas &&
    !keySwapOldCanvas.isConnected && keySwapOldCanvas.width===0,'key change replaces the canvas element');
  assert(container.querySelector('canvas')!.getContext('2d')!.getImageData(0,0,1,1).data[2]===255,'new host pixels');
  const retainedNewKey=retained.surfaceKey();
  unmount(); retained.close();
  passed('mounted SurfaceView replacement clears closed key and accepts new backend renderer');

  // Layout effects run before SurfaceView's passive mount effect. This deterministically
  // disposes the host captured by that render, rather than relying on scheduler timing.
  const raceRenderer=vello2DModule().create({resolutionScale:1,timingRecords:0});
  const raceKey=raceRenderer.surfaceKey();
  const errors:unknown[][]=[];
  const previousError=console.error;
  console.error=(...args:unknown[])=>{errors.push(args);};
  function ReplaceBeforeMount() {
    useLayoutEffect(()=>{backend=installWebBackend(wasm as unknown as RnrWasm,createSurfaceBootstrap);},[]);
    return null;
  }
  try {
    root=createRoot(container);
    flushSync(()=>root!.render(<><SurfaceView surfaceKey={raceKey} style={{width:80,height:60}}/><ReplaceBeforeMount/></>));
    await delay(100);
    assert(errors.length===0,'stale captured host must not mount or report a genuine error');
    assert(container.querySelector('canvas')!.width===0 && wasm.rnr_surface_attach(raceKey,8,8,1)==='closed','race leaves old key closed and canvas blank');
    unmount();
    // Genuine setup failure must be reported, leave no resources, and not crash React.
    const failRenderer=vello2DModule().create({resolutionScale:1,timingRecords:0});
    const getContext=HTMLCanvasElement.prototype.getContext;
    HTMLCanvasElement.prototype.getContext=function(){throw new Error('W2 injected context setup failure');};
    try {
      root=createRoot(container);
      flushSync(()=>root!.render(<SurfaceView surfaceKey={failRenderer.surfaceKey()} style={{width:80,height:60}}/>));
      await delay(50);
      assert(errors.length===1 && String(errors[0][1]).includes('W2 injected'),'genuine mount failure reported exactly once');
      assert(container.querySelector('canvas')!.width===0,'failed mount canvas cleared');
    } finally {HTMLCanvasElement.prototype.getContext=getContext;unmount();failRenderer.close();}
    assert(diagnostics()[1]===0 && diagnostics()[2]===0 && diagnostics()[3]===0,'race/failure cleanup releases resources');
  } finally {console.error=previousError;unmount();}
  passed('layout-effect replacement race is inert; genuine mount failure is reported and cleaned');

  const first=mountApp();
  await until(()=>first.created.length>0 && first.created.at(-1)!.stats().framesPresented>3,'unchanged App first frames');
  const gameRenderer=first.created.at(-1)!;
  assert(first.created.length===1 && diagnostics()[1]===1,'StrictMode async initial URL creates only one live renderer');
  assert(gameRenderer.stats().presentation==='canvas2d','Canvas2D backend');
  passed('unchanged paddle App starts through normal packaged accessor under StrictMode');
  await until(()=>reports.length>0,'original 20 active-second scripted game report',45000);
  assert(reports[0].ok,'Original game checks failed: '+JSON.stringify(reports[0].checks.filter((c:any)=>!c.ok)));
  await until(()=>snapshots.length>0 && latest().running,'interactive game snapshot');
  passed('original scripted game checks pass without changing game code',JSON.stringify(reports[0].checks));
  canvas=container.querySelector('canvas')!;
  let rect=canvas.getBoundingClientRect(), touches=latest().touches;
  await action('pointer',{x:rect.left+20,y:rect.top+rect.height*0.8,dx:rect.width-60});
  await until(()=>latest().touches>touches && latest().paddleX>200,'RNWeb mouse responder moves paddle');
  assert(Math.abs(latest().touchX-(rect.width-40))<2,'responder locationX stays in CSS coordinates');
  passed('real Chromium mouse press/drag reaches RNWeb responder overlay and moves paddle');

  Object.defineProperty(document,'visibilityState',{configurable:true,get:()=>visibility});
  show(false);
  await until(()=>latest().running===false && gameRenderer.stats().state==='detached','hidden pause');
  const hiddenTick=latest().tick, hiddenFrames=gameRenderer.stats().framesSubmitted;
  await delay(700);
  assert(latest().tick===hiddenTick && gameRenderer.stats().framesSubmitted===hiddenFrames,'no hidden physics or submission');
  assert(AppState.currentState==='background','RNWeb AppState reports background');
  show(true);
  await until(()=>latest().running && gameRenderer.stats().framesSubmitted>hiddenFrames,'visible resume');
  assert(latest().firstTickAfterResumeSteps.at(-1)===0,'resume resets clock with no catch-up');
  passed('visibility suspends original game physics/submits and resumes without catch-up');

  window.dispatchEvent(new PageTransitionEvent('pagehide',{persisted:true}));
  await until(()=>latest().running===false && gameRenderer.stats().state==='detached','pagehide pause');
  const pageTick=latest().tick, pageFrames=gameRenderer.stats().framesSubmitted;
  await delay(700);
  assert(latest().tick===pageTick && gameRenderer.stats().framesSubmitted===pageFrames,'no pagehide physics/submission while AppState remains active');
  window.dispatchEvent(new PageTransitionEvent('pageshow',{persisted:true}));
  await until(()=>latest().running && gameRenderer.stats().framesSubmitted>pageFrames,'pageshow resume');
  assert(latest().firstTickAfterResumeSteps.at(-1)===0,'pageshow no catch-up');
  passed('pagehide gates game through real attachment state; pageshow gets a fresh attachment');

  container.style.width='400.5px'; container.style.height='260.25px';
  await action('dpr',{value:2});
  await until(()=>gameRenderer.stats().surfaceWidth===801 && gameRenderer.stats().surfaceHeight===521 && latest().sizeAgrees,'game resize and DPR');
  rect=canvas.getBoundingClientRect(); touches=latest().touches;
  await action('pointer',{x:rect.left+50,y:rect.top+rect.height*0.8,dx:200});
  await until(()=>latest().touches>touches,'DPR2 pointer');
  assert(Math.abs(latest().touchX-250)<2,'DPR2 must not scale pointer layout units');
  passed('game layout and raster agree after fractional resize/DPR; pointer coordinates remain CSS units');
  container.style.height='0px';
  await until(()=>gameRenderer.stats().state==='detached' && latest().running===false,'game zero height');
  const zeroFrames=gameRenderer.stats().framesSubmitted;
  await delay(600);
  assert(gameRenderer.stats().framesSubmitted===zeroFrames,'zero extent prevents submits');
  container.style.height='260.25px';
  await until(()=>latest().running && gameRenderer.stats().state==='attached','game resize resume');
  passed('zero-size game view pauses and positive resize resumes');

  const oldKey=gameRenderer.surfaceKey();
  unmount();
  await until(()=>diagnostics()[1]===0 && diagnostics()[2]===0 && diagnostics()[3]===0,'game unmount cleanup');
  const logs=snapshots.length;
  await delay(700);
  assert(snapshots.length===logs,'App timers stopped on unmount');
  passed('game unmount closes renderer, releases pixels and removes timers');

  backend=installWebBackend(wasm as unknown as RnrWasm,createSurfaceBootstrap);
  assert(wasm.rnr_surface_attach(oldKey,8,8,1)==='closed','old key remains closed');
  let refused=false; try { gameRenderer.submit(new FrameWriter().clear([0,0,0,1]).finish()); } catch { refused=true; }
  assert(refused,'old wrapper is retired');
  const second=mountApp();
  await until(()=>second.created.length>0 && second.created.at(-1)!.stats().framesPresented>3,'App reinstall');
  assert(second.module!==first.module,'normal accessor uses a new backend-owned module');
  assert(second.created.at(-1)!.surfaceKey()!==oldKey && diagnostics()[1]===1,'new renderer and one producer');
  passed('framework reinstall retires old handles and unchanged App remount uses fresh normal accessor');
  const finalKey=second.created.at(-1)!.surfaceKey();
  unmount(); backend.dispose(); backend=undefined;
  for (const key of [simpleKey,retainedKey,retainedNewKey,raceKey,oldKey,finalKey])
    assert(wasm.rnr_surface_attach(key,8,8,1)==='closed','retained wrapper key must be closed');
  // diagnostics[0] counts still-referenced Inner objects, including closed wrappers.
  // GC/finalization is not forced; resource counters below must nevertheless be zero.
  assert(diagnostics()[1]===0 && diagnostics()[2]===0 && diagnostics()[3]===0,'final resources released');
}
main().catch(error=>checks.push({name:'fixture completion',ok:false,detail:String(error)})).finally(()=>{
  try { unmount(); backend?.dispose(); } catch(error) { checks.push({name:'cleanup',ok:false,detail:String(error)}); }
  Reflect.deleteProperty(document,'visibilityState');
  const result={ok:checks.every(c=>c.ok),checks,gameReport:reports[0]??null,finalDiagnostics:diagnostics(),dprSamples:(globalThis as any).__w2DprSamples,
    limitation:'Packaged RNWeb consumer, unchanged game sources, CDP mouse/DPR. Visibility and page events are synthetic. Scalar Canvas2D main-thread work has no duration bound.'};
  (globalThis as any).__rnrResult=result;
  document.getElementById('result')!.textContent=JSON.stringify(result,null,2);
});
