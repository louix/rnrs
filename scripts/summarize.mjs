import {readFile} from 'node:fs/promises';
import {pathToFileURL} from 'node:url';
export function quantile(values, p) {
  const sorted = [...values].sort((a, b) => a - b);
  if (!sorted.length) return null;
  const position = (sorted.length - 1) * p;
  const lo = Math.floor(position), hi = Math.ceil(position);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (position - lo);
}
export function summarize(records) {
  const complete = new Set(records.filter(r => r.type === 'done' &&
    records.filter(s => s.type === 'sample' && s.runId === r.runId).length === r.samples &&
    !records.some(s => s.type === 'error' && s.runId === r.runId)).map(r => r.runId));
  const groups = new Map();
  for (const s of records.filter(s => s.type === 'sample' && complete.has(s.runId))) {
    const key = `${s.runId}/${s.group}/${s.name}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(s);
  }
  return [...groups].sort(([a], [b]) => a.localeCompare(b)).map(([, samples]) => ({
    runId: samples[0].runId, name: `${samples[0].group}/${samples[0].name}`, samples: samples.length,
    medianMs: quantile(samples.map(s => s.elapsedMs), .5),
    p10Ms: quantile(samples.map(s => s.elapsedMs), .1),
    p90Ms: quantile(samples.map(s => s.elapsedMs), .9),
    medianNsPerOp: quantile(samples.map(s => s.elapsedMs * 1e6 / s.operations), .5),
    medianThreadCpuMs: quantile(samples.map(s => s.after.threadCpuMs - s.before.threadCpuMs), .5),
    medianNativeLiveDelta: quantile(samples.map(s => s.after.nativeAllocatedBytes - s.before.nativeAllocatedBytes), .5),
    medianJsAllocatedBytes: medianDelta(samples, 'hermes_totalAllocatedBytes'),
    medianCollections: medianDelta(samples, 'hermes_numCollections'),
    medianProcessCpuMs: medianDelta(samples, 'processCpuMs'),
    samplesWithCoreMigration: samples.filter(s => s.before.cpuCore !== s.after.cpuCore).length,
    medianForcedGcMs: quantile(samples.map(s => s.postGcMs), .5),
  }));
}
function medianDelta(samples, key) {
  if (!samples.every(s => Number.isFinite(s.before[key]) && Number.isFinite(s.after[key]))) return null;
  return quantile(samples.map(s => s.after[key] - s.before[key]), .5);
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const records = (await readFile(process.argv[2], 'utf8')).trim().split('\n').map(JSON.parse);
  console.log(JSON.stringify(summarize(records), null, 2));
}
