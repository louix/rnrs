// CDP input driver for fixtures/web-touch (scripts/web-test.mjs RNR_WEB_DRIVER). The page posts
// batches of input actions in globalThis.__touchInput = {id, actions}; this dispatches them as
// real browser input (Input.dispatchMouseEvent / dispatchTouchEvent, trusted PointerEvents)
// and acknowledges with globalThis.__touchInputDone = id. Stops once the page sets __rnrResult.
export async function drive({send}) {
  const evaluate = async expression =>
    (await send('Runtime.evaluate', {expression, returnByValue: true})).result.value;
  for (;;) {
    await new Promise(resolve => setTimeout(resolve, 20));
    let request;
    try { request = await evaluate('JSON.stringify(globalThis.__rnrResult ? {done: true} : globalThis.__touchInput ?? null)'); }
    catch { continue; } // navigation in progress
    const pending = JSON.parse(request ?? 'null');
    if (pending?.done) return;
    if (!pending || pending.id === undefined) continue;
    for (const action of pending.actions) {
      if (action.kind === 'mouse') {
        await send('Input.dispatchMouseEvent', {type: action.type, x: action.x, y: action.y, pointerType: action.pointerType ?? 'mouse',
          button: action.button ?? 'left', buttons: action.buttons ?? 0, clickCount: action.type === 'mouseMoved' ? 0 : 1});
      } else if (action.kind === 'touch') {
        await send('Input.dispatchTouchEvent', {type: action.type, touchPoints: action.points});
      } else if (action.kind === 'metrics') {
        await send('Emulation.setDeviceMetricsOverride', {width: 800, height: 600, deviceScaleFactor: action.dpr, mobile: false});
      } else if (action.kind === 'touchEmulation') {
        await send('Emulation.setTouchEmulationEnabled', {enabled: true, maxTouchPoints: 10});
      } else throw new Error('unknown action ' + JSON.stringify(action));
    }
    await evaluate(`globalThis.__touchInput = undefined; globalThis.__touchInputDone = ${Number(pending.id)}`);
  }
}
