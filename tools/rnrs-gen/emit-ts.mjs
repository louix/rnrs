// IR -> TS wrapper (hidden build output). Classes over the framework runtime
// (packages/runtime/src/runtime.ts); value types mirror the spec.

import { holdsNative, scalarEligible, valueTypesWithNatives } from './emit-rust.mjs';

function tsType(t) {
  switch (t.k) {
    case 'number':
      return 'number';
    case 'boolean':
      return 'boolean';
    case 'string':
      return 'string';
    case 'bytes':
      return 'ArrayBuffer';
    case 'void':
      return 'void';
    case 'array':
      return `${wrapUnion(tsType(t.of))}[]`;
    case 'nullable':
      return `${tsType(t.of)} | null`;
    case 'map':
      return `Record<string, ${tsType(t.of)}>`;
    case 'json':
      return 'JsonValue';
    case 'record':
    case 'union':
    case 'native':
      return t.name;
    default:
      throw new Error(t.k);
  }
}
const wrapUnion = (s) => (s.includes('|') ? `(${s})` : s);

const hasNative = (t) => t.k === 'native' || (t.of !== undefined && hasNative(t.of));

/** JS argument value -> what the adapter receives (native wrappers -> handles). */
function toNative(t, expr) {
  if (!hasNative(t)) return expr;
  switch (t.k) {
    case 'native':
      return `handleOf(${expr})`;
    case 'array':
      return `(Array.isArray(${expr}) ? ${expr}.map((e: any) => ${toNative(t.of, 'e')}) : ${expr})`;
    case 'nullable':
      return `(${expr} === null ? null : ${toNative(t.of, expr)})`;
    default:
      return expr;
  }
}

// Names the generated wrapping code adds contain `$`, which spec names cannot, so they never
// collide with generated classes, types or accessors.

/** Adapter result -> wrapper value (handles -> wrapper objects). `holds` names the records and
 *  unions holding handles; their generated `$wrap<Name>` replaces the handles in place (results
 *  are fresh objects the adapter created). Each expression is evaluated once. */
function fromNative(t, expr, holds, host = 'this.host') {
  if (!holdsNative(t, holds)) return expr;
  switch (t.k) {
    case 'native':
      return `new ${t.name}(${host}, ${expr} as object)`;
    case 'record':
    case 'union':
      return `$wrap${t.name}(${host}, ${expr})`;
    case 'array':
      return `(${expr} as unknown[]).map(e => ${fromNative(t.of, 'e', holds, host)})`;
    case 'nullable':
      return `((n: unknown) => n === null ? null : ${fromNative(t.of, 'n', holds, host)})(${expr})`;
    case 'map':
      // A fresh object whose own data properties the adapter defined: each one is replaced.
      return `((m: any) => { const keys = Object.keys(m); for (let i = 0; i < keys.length; i++) $conversionHelpers.define(m, keys[i], ${fromNative(t.of, 'm[keys[i]]', holds, host)}); return m; })(${expr})`;
    default:
      return expr;
  }
}

/** Whether wrapping `t` uses a map conversion (which needs the runtime helpers). */
const wrapsMap = (t, holds) =>
  (t.k === 'map' && holdsNative(t, holds)) || (t.of !== undefined && wrapsMap(t.of, holds));

/** Statements wrapping the handle-holding fields of result object `v`. */
function wrapFields(fields, holds) {
  return fields
    .filter((f) => holdsNative(f.type, holds))
    .map((f) => {
      const key = JSON.stringify(f.name);
      // Optional fields are omitted when None: read own properties only.
      return f.optional
        ? `  {\n    const field = $conversionHelpers.readOwn(v, ${key});\n    if (field !== undefined) $conversionHelpers.define(v, ${key}, ${fromNative(f.type, 'field', holds, 'host')});\n  }`
        : `  $conversionHelpers.define(v, ${key}, ${fromNative(f.type, `v[${key}]`, holds, 'host')});`;
    });
}

function wrapFunction(name, body) {
  return `function $wrap${name}(host: $ModuleHost, v: any): ${name} {\n${body.join('\n')}\n  return v;\n}`;
}

function method(m, index, receiver, holds) {
  const params = m.params.map((p) => `${p.name}${p.optional ? '?' : ''}: ${tsType(p.type)}`);
  const args = `[${m.params.map((p) => toNative(p.type, p.name)).join(', ')}]`;
  if (!m.async) {
    const ret = tsType(m.returns);
    // Scalar methods: the host's prepared entry for this method (`m<index>`, own property of
    // the host, no index or receiver argument). Up to four parameters: positional (host.callN,
    // no argument array); more: one array.
    const call = scalarEligible(m)
      ? `this.host.m${index}(${m.params.map((p) => p.name).join(', ')})`
      : m.params.length <= 4
        ? `this.host.call${m.params.length}(${[index, receiver, ...m.params.map((p) => toNative(p.type, p.name))].join(', ')})`
        : `this.host.call(${index}, ${receiver}, ${args})`;
    const body =
      m.returns.k === 'void'
        ? `${call};`
        : `return ${holdsNative(m.returns, holds) ? fromNative(m.returns, call, holds) : `${call} as ${ret}`};`;
    return `  ${m.name}(${params.join(', ')}): ${ret} {\n    ${body}\n  }`;
  }
  const ret = tsType(m.returns);
  const wrap = holdsNative(m.returns, holds)
    ? `, (value: unknown) => ${fromNative(m.returns, 'value', holds)}`
    : '';
  params.push('options?: CallOptions');
  return `  ${m.name}(${params.join(', ')}): Promise<${ret}> {\n    return this.host.start(${index}, ${receiver}, ${args}, options${wrap}) as Promise<${ret}>;\n  }`;
}

function usesJson(ir) {
  const has = (t) => t.k === 'json' || (t.of !== undefined && has(t.of));
  return (
    ir.methods.some((m) => has(m.returns) || m.params.some((p) => has(p.type))) ||
    ir.records.some((r) => r.fields.some((f) => has(f.type))) ||
    ir.unions.some((u) => u.variants.some((v) => v.fields.some((f) => has(f.type))))
  );
}

function field(f) {
  return `${JSON.stringify(f.name)}${f.optional ? '?' : ''}: ${tsType(f.type)}`;
}

export function emitTs(ir, { runtimeImport, maxInFlight }) {
  const holds = valueTypesWithNatives(ir);
  // Only modules that wrap handles inside records, unions or maps import the wrapping helpers,
  // so other wrappers stay as they were.
  const helpers =
    holds.size || ir.methods.some((m) => wrapsMap(m.returns, holds))
      ? ', conversionHelpers as $conversionHelpers, type ModuleHost as $ModuleHost'
      : '';
  const out = [
    `// @generated by tools/rnrs-gen from ${ir.spec}; do not edit.\n// IR hash: ${ir.hash}`,
    `import {ModuleBase, NativeObjectBase, createModuleForTesting, handleOf, runtimeModule, type CallOptions${usesJson(ir) ? ', type JsonValue' : ''}${helpers}} from '${runtimeImport}';`,
  ];
  for (const r of ir.records)
    out.push(
      `export interface ${r.name} {\n${r.fields.map((f) => `  ${field(f)};`).join('\n')}\n}`,
    );
  for (const u of ir.unions) {
    const variants = u.variants.map((v) => {
      const members = [
        `${JSON.stringify(u.discriminator)}: ${JSON.stringify(v.tag)}`,
        ...v.literals.map((l) => `${JSON.stringify(l.name)}: ${JSON.stringify(l.value)}`),
        ...v.fields.map(field),
      ];
      return `  | {${members.join('; ')}}`;
    });
    out.push(`export type ${u.name} =\n${variants.join('\n')};`);
  }
  for (const r of ir.records.filter((r) => holds.has(r.name)))
    out.push(wrapFunction(r.name, wrapFields(r.fields, holds)));
  for (const u of ir.unions.filter((u) => holds.has(u.name))) {
    const arms = u.variants
      .map((v) => ({ v, body: wrapFields(v.fields, holds) }))
      .filter(({ body }) => body.length)
      .map(
        ({ v, body }) =>
          `    case ${JSON.stringify(v.tag)}:\n${body.map((l) => '    ' + l.replace(/\n/g, '\n    ')).join('\n')}\n      break;`,
      );
    out.push(
      wrapFunction(u.name, [
        `  switch (v[${JSON.stringify(u.discriminator)}]) {\n${arms.join('\n')}\n  }`,
      ]),
    );
  }
  const indexed = ir.methods.map((m, i) => ({ m, i }));
  for (const o of ir.objects) {
    const methods = indexed
      .filter(({ m }) => m.owner === o.name)
      .map(({ m, i }) => method(m, i, 'this.handle', holds));
    out.push(`export class ${o.name} extends NativeObjectBase {\n${methods.join('\n\n')}\n}`);
  }
  const moduleMethods = indexed
    .filter(({ m }) => !m.owner)
    .map(({ m, i }) => method(m, i, 'undefined', holds));
  // Protocol 3: the runtime installs `m<index>` entries for `direct` ([index, arity] pairs).
  const direct = indexed
    .filter(({ m }) => scalarEligible(m))
    .map(({ m, i }) => `[${i}, ${m.params.length}]`);
  const descriptor = direct.length ? `protocol: 3, direct: [${direct.join(', ')}]` : 'protocol: 2';
  out.push(`export class ${ir.module} extends ModuleBase {
  static readonly descriptor = {name: ${JSON.stringify(ir.module)}, hash: ${JSON.stringify(ir.hash)}, defaultMaxInFlight: ${maxInFlight}, ${descriptor}};
${moduleMethods.length ? '\n' + moduleMethods.join('\n\n') + '\n' : ''}}`);
  const accessor = ir.module[0].toLowerCase() + ir.module.slice(1);
  out.push(`/** This runtime's framework-owned ${ir.module}: created on first use, torn down with the runtime. */
export function ${accessor}(): ${ir.module} {
  return runtimeModule(${ir.module});
}

/** Test hook: an extra adapter generation in this runtime; the caller tears it down. */
export function create${ir.module}ForTesting(maxInFlight: number): ${ir.module} {
  return createModuleForTesting(${ir.module}, maxInFlight);
}`);
  return out.join('\n\n') + '\n';
}
