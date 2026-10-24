// Derives the fixed iterations per sample (n) for one phone from that phone's pilot summary
// (summary.json), the same n for every path of a workload and every process of the run set.
// Rule, from each workload's pilot pooled medians (ns per unit) of its fastest and slowest path:
//   n = max(ceil(FAST_MS / fastest), ceil(SLOW_MS / slowest)), rounded up to 2 significant
//   digits, then capped so the slowest path's sample stays <= CAP_MS. A workload whose fastest
//   path would still be below FAST_MS is flagged, not silently accepted.
//   node benchmarks/turbo-compare/fixed-n.mjs <pilot summary.json> <out prefix>
//   -> <out prefix>.json (workload -> n, for --fixed-n) and <out prefix>.md (the table and rule)
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export const FAST_MS = 1;
export const SLOW_MS = 10;
export const CAP_MS = 50;

const up2 = (x) => {
  const p = 10 ** Math.max(0, Math.floor(Math.log10(x)) - 1);
  return Math.ceil(x / p) * p;
};

export function deriveFixedN(summary) {
  return summary.map((w) => {
    const medians = Object.entries(w.paths).map(([p, s]) => [p, s.median]);
    const [fastPath, fast] = medians.reduce((a, b) => (b[1] < a[1] ? b : a));
    const [slowPath, slow] = medians.reduce((a, b) => (b[1] > a[1] ? b : a));
    const want = up2(
      Math.max(Math.ceil((FAST_MS * 1e6) / fast), Math.ceil((SLOW_MS * 1e6) / slow)),
    );
    const cap = Math.floor((CAP_MS * 1e6) / slow);
    const n = Math.max(1, Math.min(want, cap));
    const fastMs = (n * fast) / 1e6;
    const slowMs = (n * slow) / 1e6;
    return {
      workload: w.workload,
      n,
      fastPath,
      fastNs: fast,
      fastMs,
      slowPath,
      slowNs: slow,
      slowMs,
      flag:
        fastMs < FAST_MS
          ? `fastest path ${fastMs.toFixed(2)} ms < ${FAST_MS} ms (capped by the slowest path)`
          : null,
    };
  });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [input, prefix] = process.argv.slice(2);
  const rows = deriveFixedN(JSON.parse(readFileSync(input, 'utf8')));
  writeFileSync(
    `${prefix}.json`,
    JSON.stringify(Object.fromEntries(rows.map((r) => [r.workload, r.n])), null, 1) + '\n',
  );
  const md = [
    `# Fixed n from ${input}`,
    '',
    `Rule: n = max(ceil(${FAST_MS} ms / fastest), ceil(${SLOW_MS} ms / slowest)) from the pilot pooled medians, rounded up to`,
    `2 significant digits, capped so the slowest sample <= ${CAP_MS} ms. Same n for every path and process. Expected sample`,
    'durations are pilot-based estimates.',
    '',
    '| workload | n | fastest path (pilot ns) | est. fastest ms | slowest path (pilot ns) | est. slowest ms | flag |',
    '| --- | ---: | --- | ---: | --- | ---: | --- |',
    ...rows.map(
      (r) =>
        `| ${r.workload} | ${r.n} | ${r.fastPath} (${Math.round(r.fastNs)}) | ${r.fastMs.toFixed(2)} | ${r.slowPath} (${Math.round(r.slowNs)}) | ${r.slowMs.toFixed(2)} | ${r.flag ?? ''} |`,
    ),
  ].join('\n');
  writeFileSync(`${prefix}.md`, md + '\n');
  console.log(md);
}
