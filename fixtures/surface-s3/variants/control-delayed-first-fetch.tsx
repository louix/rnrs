// D4: D1 except that each new runtime waits 2 s after mount before its first request (run 2
// crashed in the new runtime's first sendRequest, in RCTNetworking's handler setup).
import {controlApp} from './controlHttp';

export default controlApp('control-delayed-first-fetch', {firstFetchDelayMs: 2000});
