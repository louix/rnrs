// Framework host subscription, shared by bootstrap and the browser component.
// No React dependency: DOM-only W1 and headless consumers remain independent of React.
import type {createCanvasHost} from './canvas-host';
type Host = ReturnType<typeof createCanvasHost>;
let active: Host | null = null;
const listeners = new Set<() => void>();
function changed() {
  const errors: unknown[] = [];
  for (const listener of [...listeners]) { try { listener(); } catch (error) { errors.push(error); } }
  if (errors.length) throw new AggregateError(errors, 'Surface host subscription failed');
}
export const currentHost = () => active;
export const serverHost = () => null;
export function subscribeHost(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; }
export function publishHost(host: Host) { active = host; changed(); }
export function retireHost(host: Host | undefined) { if (host && active === host) { active = null; changed(); } }
