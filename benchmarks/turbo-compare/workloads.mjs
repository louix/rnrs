// The comparison's workload table (PROTOCOL in the shared notes; README.md here). gen-cases.mjs
// turns it into app/cases.generated.ts: one literal loop per (workload, path), so every path has
// its own call site and loop bodies differ only in the receiver (`$M`). The summarizer reads the
// same table for workload metadata.
//
// Fields: id; group; paths: path -> receiver ('rnrs' | 'tm' | 'jsi' | 'nitro' | controls) and body (a loop body using
// `$M`, the loop index `i`, the accumulator `acc` and the locals from `pre`); pre: per-case
// locals from the fixtures `fx`; ret: the checksum expression; expect: the checksum for `n`
// iterations as a JS expression of `n` and `fx`; perIter: calls per iteration and unit label.

const STRINGS = [
  ['ascii-16', 0],
  ['ascii-1k', 1],
  ['ascii-64k', 2],
  ['uni-16', 3],
  ['uni-1k', 4],
  ['uni-64k', 5],
];

const three = (body) => ({
  rnrs: { receiver: 'rnrs', body },
  tm: { receiver: 'tm', body },
  jsi: { receiver: 'jsi', body },
});
const scalar = (body) => ({
  ...three(body),
  nitro: { receiver: 'nitro', body },
  'jsi-guarded': { receiver: 'guarded', body },
  'jsi-wrapped': { receiver: 'wrapped', body },
  'jsi-shaped': { receiver: 'shaped', body },
  'jsi-shaped-this': { receiver: 'shapedThis', body },
  'jsi-shaped-unbound': { receiver: 'shapedUnbound', body },
  'jsi-wrapped-proto': { receiver: 'wrappedProto', body },
  'jsi-entry': { receiver: 'entry', body },
});
const two = (body) => ({ rnrs: { receiver: 'rnrs', body }, tm: { receiver: 'tm', body } });
const sumTo = (n, offset) => `(${n} * (${n} - 1) / 2 + ${offset} * ${n})`;

export const WORKLOADS = [
  { id: 'nop', group: 'scalar', paths: scalar('$M.nop();'), ret: 'n', expect: 'n' },
  { id: 'add', group: 'scalar', paths: scalar('acc = $M.add(acc, 1);'), ret: 'acc', expect: 'n' },
  {
    id: 'flip',
    group: 'scalar',
    pre: 'let b = false;',
    paths: scalar('b = $M.flip(b);'),
    ret: 'b ? 1 : 0',
    expect: 'n % 2',
  },
  ...STRINGS.map(([name, id]) => ({
    id: `strIn-${name}`,
    group: 'string-in',
    pre: `const s = fx.strings[${id}];`,
    paths: two('acc += $M.strLen(s);'),
    ret: 'acc',
    expect: `n * fx.stringBytes[${id}]`,
  })),
  ...STRINGS.map(([name, id]) => ({
    id: `strOut-${name}`,
    group: 'string-out',
    paths: two(`acc += $M.strGet(${id}).length;`),
    ret: 'acc',
    expect: `n * fx.strings[${id}].length`,
  })),
  {
    id: 'recIn-point8',
    group: 'record',
    pre: 'const p = fx.point;',
    paths: two('acc += $M.pointSum(p);'),
    ret: 'acc',
    expect: 'n * fx.pointTotal',
  },
  {
    id: 'recOut-point8',
    group: 'record',
    paths: two('acc += $M.pointMake(i).h;'),
    ret: 'acc',
    expect: sumTo('n', 7),
  },
  {
    id: 'recIn-nested',
    group: 'record',
    pre: 'const v = fx.nested;',
    paths: two('acc += $M.nestedSum(v);'),
    ret: 'acc',
    expect: 'n * fx.nestedTotal',
  },
  {
    id: 'recOut-nested',
    group: 'record',
    paths: two('acc += $M.nestedMake(i).tint.a;'),
    ret: 'acc',
    expect: sumTo('n', 8),
  },
  // Four distinct arrays per size, rotated per call (every path the same), so no path sums one
  // unchanging array object; the checksum depends on every call's result.
  ...[16, 256, 1024].map((len) => ({
    id: `arrIn-${len}`,
    group: 'array',
    pre: `const xs = fx.rotArrays[${len}];`,
    paths: {
      ...three('acc += $M.arrSum(xs[i & 3]);'),
      nitro: { receiver: 'nitro', body: 'acc += $M.arrSum(xs[i & 3]);' },
    },
    ret: 'acc',
    expect: `fx.rotatedTotal(${len}, n)`,
  })),
  ...[16, 1024].map((len) => ({
    id: `arrOut-${len}`,
    group: 'array',
    paths: two(`acc += $M.arrMake(${len}, i)[${len - 1}];`),
    ret: 'acc',
    expect: sumTo('n', len - 1),
  })),
  {
    id: 'batch-num256',
    group: 'batch',
    unit: '256 numbers',
    pre: 'const xs = fx.arrays[256];',
    paths: {
      'rnrs-many': {
        receiver: 'rnrs',
        body: 'for (let k = 0; k < 256; k++) acc = $M.add(acc, xs[k]);',
      },
      'rnrs-batch': { receiver: 'rnrs', body: 'acc += $M.arrSum(xs);' },
      'tm-many': {
        receiver: 'tm',
        body: 'for (let k = 0; k < 256; k++) acc = $M.add(acc, xs[k]);',
      },
      'tm-batch': { receiver: 'tm', body: 'acc += $M.arrSum(xs);' },
    },
    ret: 'acc',
    expect: 'n * fx.arrayTotals[256]',
  },
  {
    id: 'batch-point64',
    group: 'batch',
    unit: '64 Point8 records',
    pre: 'const ps = fx.points64;',
    paths: {
      'rnrs-many': {
        receiver: 'rnrs',
        body: 'for (let k = 0; k < 64; k++) acc += $M.pointSum(ps[k]);',
      },
      'rnrs-batch': { receiver: 'rnrs', body: 'acc += $M.pointSumBatch(ps);' },
      'tm-many': {
        receiver: 'tm',
        body: 'for (let k = 0; k < 64; k++) acc += $M.pointSum(ps[k]);',
      },
      'tm-batch': { receiver: 'tm', body: 'acc += $M.pointSumBatch(ps);' },
    },
    ret: 'acc',
    expect: 'n * fx.points64Total',
  },
];

/** The browser page's table (web/, informational): the scalar and numeric-array workloads with the
 *  same bodies on four receivers: the rnrs module on the Wasm backend, plain JS, the minimal direct
 *  wasm-bindgen crate and its checked JS wrapper. */
export const WEB_PATHS = { rnrs: 'rnrs', js: 'js', wasm: 'wasm', 'wasm-checked': 'wasmChecked' };
export const WEB_WORKLOADS = WORKLOADS.filter((w) =>
  ['nop', 'add', 'flip', 'arrIn-16', 'arrIn-256', 'arrIn-1024'].includes(w.id),
).map((w) => ({
  ...w,
  paths: Object.fromEntries(
    Object.entries(WEB_PATHS).map(([path, receiver]) => [
      path,
      { receiver, body: w.paths.rnrs.body },
    ]),
  ),
}));

/** Web pairs: every path against rnrs, and the checked wrapper against the raw binding. */
export function webPairsFor() {
  return [
    ['rnrs', 'js'],
    ['rnrs', 'wasm'],
    ['rnrs', 'wasm-checked'],
    ['wasm-checked', 'wasm'],
  ];
}

/** Paired differences reported per workload: [minuend, subtrahend]. */
export function pairsFor(workload) {
  const p = Object.keys(workload.paths);
  if (workload.group === 'batch')
    return [
      ['rnrs-many', 'rnrs-batch'],
      ['tm-many', 'tm-batch'],
      ['rnrs-many', 'tm-many'],
      ['rnrs-batch', 'tm-batch'],
    ];
  const pairs = [['rnrs', 'tm']];
  if (p.includes('jsi')) pairs.push(['tm', 'jsi'], ['rnrs', 'jsi']);
  if (p.includes('jsi-guarded'))
    pairs.push(['rnrs', 'jsi-guarded'], ['jsi-guarded', 'jsi'], ['jsi-wrapped', 'jsi-guarded']);
  if (p.includes('nitro')) pairs.push(['rnrs', 'nitro'], ['nitro', 'tm']);
  if (p.includes('jsi-entry'))
    pairs.push(
      ['rnrs', 'jsi-entry'],
      ['jsi-entry', 'jsi-wrapped-proto'],
      ['jsi-wrapped-proto', 'jsi-wrapped'],
    );
  if (p.includes('jsi-shaped'))
    pairs.push(
      ['rnrs', 'jsi-shaped'],
      ['jsi-shaped', 'jsi-shaped-this'],
      ['jsi-shaped-this', 'jsi-shaped-unbound'],
      ['jsi-shaped-unbound', 'jsi-wrapped'],
    );
  return pairs;
}
