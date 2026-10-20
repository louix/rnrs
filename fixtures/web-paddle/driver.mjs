// CDP actions for real browser mouse input and device configuration changes.
export async function drive({ send }) {
  const evaluate = async (expression) => {
    const result = await send('Runtime.evaluate', { expression, returnByValue: true });
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.text);
    return result.result.value;
  };
  let handled = 0;
  const deadline = Date.now() + 110000;
  while (Date.now() < deadline) {
    if (await evaluate('!!globalThis.__rnrResult')) return;
    const action = await evaluate('globalThis.__w2Action ?? null');
    if (action && action.id !== handled) {
      try {
        if (action.type === 'dpr') {
          // Change viewport too: CDP DPR-only overrides did not emit a resize/media event
          // in this Chromium run. Content itself stays fixed-size; no synthetic DOM resize.
          await send('Emulation.setDeviceMetricsOverride', {
            width: 800 + action.value,
            height: 600,
            deviceScaleFactor: action.value,
            mobile: false,
          });
          await evaluate(
            '(globalThis.__w2DprSamples ??= []).push({dpr:devicePixelRatio,width:innerWidth})',
          );
        } else if (action.type === 'pointer') {
          await send('Input.dispatchMouseEvent', {
            type: 'mousePressed',
            x: action.x,
            y: action.y,
            button: 'left',
            buttons: 1,
            clickCount: 1,
          });
          await send('Input.dispatchMouseEvent', {
            type: 'mouseMoved',
            x: action.x + action.dx,
            y: action.y,
            button: 'left',
            buttons: 1,
          });
          await send('Input.dispatchMouseEvent', {
            type: 'mouseReleased',
            x: action.x + action.dx,
            y: action.y,
            button: 'left',
            buttons: 0,
            clickCount: 1,
          });
        } else throw new Error('Unknown action ' + action.type);
        await evaluate('globalThis.__w2ActionDone=' + action.id);
      } catch (error) {
        await evaluate('globalThis.__w2ActionError=' + JSON.stringify(String(error)));
      }
      handled = action.id;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error('Timed out driving W2 fixture');
}
