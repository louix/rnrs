// Test hooks of the JSI backend (Android, iOS) for device test harnesses: the runtime
// bindings (lifecycle diagnostics, forced GC, scope invalidation, iOS reload) and the settle
// registry size. Not part of any production API.
export { registeredModuleCount, runtimeBindings, type LifecycleStats } from './jsi-backend';
