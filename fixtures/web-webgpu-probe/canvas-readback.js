(async()=>{const a=await navigator.gpu.requestAdapter();const d=await a.requestDevice();let lost=null;d.lost.then(i=>lost=i.message);
const c=document.createElement('canvas');document.body.append(c);c.width=c.height=64;const x=c.getContext('webgpu');x.configure({device:d,format:navigator.gpu.getPreferredCanvasFormat(),alphaMode:'opaque'});
const e=d.createCommandEncoder();const p=e.beginRenderPass({colorAttachments:[{view:x.getCurrentTexture().createView(),loadOp:'clear',clearValue:[1,0.5,0,1],storeOp:'store'}]});p.end();d.queue.submit([e.finish()]);
const k=document.createElement('canvas');k.width=k.height=64;const g=k.getContext('2d');g.drawImage(c,0,0);const same=Array.from(g.getImageData(32,32,1,1).data);
await new Promise(r=>setTimeout(r,300));g.clearRect(0,0,64,64);g.drawImage(c,0,0);const later=Array.from(g.getImageData(32,32,1,1).data);
return {same,later,lost};})()
