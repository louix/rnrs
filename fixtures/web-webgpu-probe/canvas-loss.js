(async () => {
  const out = {};
  const t0 = performance.now();
  async function run(name, f) {
    const a = await navigator.gpu.requestAdapter();
    const d = await a.requestDevice();
    let lost = null;
    d.lost.then(
      (i) => (lost = i.reason + ':' + i.message + '@' + (performance.now() - t0).toFixed(0)),
    );
    try {
      await f(d);
    } catch (e) {
      out[name] = 'threw ' + e;
      return;
    }
    await new Promise((r) => setTimeout(r, 600));
    out[name] = lost ?? 'alive';
    globalThis['keep_' + name] = d;
  }
  const fmt = navigator.gpu.getPreferredCanvasFormat();
  function pass(d, view) {
    const e = d.createCommandEncoder();
    const p = e.beginRenderPass({
      colorAttachments: [{ view, loadOp: 'clear', clearValue: [1, 0, 0, 1], storeOp: 'store' }],
    });
    p.end();
    d.queue.submit([e.finish()]);
  }
  await run('texture-only', async (d) => {
    const tx = d.createTexture({
      size: [64, 64],
      format: fmt,
      usage: GPUTextureUsage.RENDER_ATTACHMENT,
    });
    pass(d, tx.createView());
  });
  await run('canvas-configure-only', async (d) => {
    const c = document.createElement('canvas');
    document.body.append(c);
    c.width = c.height = 64;
    c.getContext('webgpu').configure({ device: d, format: fmt, alphaMode: 'opaque' });
  });
  await run('canvas-draw-in-dom', async (d) => {
    const c = document.createElement('canvas');
    document.body.append(c);
    c.width = c.height = 64;
    const x = c.getContext('webgpu');
    x.configure({ device: d, format: fmt, alphaMode: 'opaque' });
    pass(d, x.getCurrentTexture().createView());
  });
  await run('canvas-draw-detached', async (d) => {
    const c = document.createElement('canvas');
    c.width = c.height = 64;
    const x = c.getContext('webgpu');
    x.configure({ device: d, format: fmt, alphaMode: 'opaque' });
    pass(d, x.getCurrentTexture().createView());
  });
  await run('offscreen-draw', async (d) => {
    const c = new OffscreenCanvas(64, 64);
    const x = c.getContext('webgpu');
    x.configure({ device: d, format: fmt, alphaMode: 'opaque' });
    pass(d, x.getCurrentTexture().createView());
  });
  await run('canvas-draw-premultiplied', async (d) => {
    const c = document.createElement('canvas');
    document.body.append(c);
    c.width = c.height = 64;
    const x = c.getContext('webgpu');
    x.configure({ device: d, format: fmt, alphaMode: 'premultiplied' });
    pass(d, x.getCurrentTexture().createView());
  });
  return out;
})();
