// D3: no surface; before each reload through the RnrRuntime hook the old runtime's HTTP
// transport is quiesced (nothing in flight for 1 s); the new runtime fetches at once. Replaces
// "React Native's own reload", which is a no-op in Release.
import { controlApp } from './controlHttp';

export default controlApp('control-quiesced-http', { quiesce: true });
