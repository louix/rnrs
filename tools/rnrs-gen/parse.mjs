// TS spec -> validated IR, using the TypeScript compiler API (syntax for shape, checker for
// symbol resolution across imports). Every rejection carries file:line:col.
import path from 'node:path';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';

// TypeScript 7 (the native compiler, used for tsc) has no stable JS API, so the generator uses
// the TypeScript 6 API. The published @rnrs/cli depends on plain typescript@6.0.3: npm nests it
// under the CLI when the app has its own typescript, so the app's tsc is untouched. The repository
// root, whose typescript is 7, adds 6.0.3 under the alias typescript6. Both resolve from this file;
// the first one that is the supported major wins: the CLI's own typescript first, so an app's
// typescript6 never replaces the CLI's pin.
const TYPESCRIPT_API_MAJOR = 6;
function loadTypeScriptApi() {
  const require = createRequire(import.meta.url);
  const found = [];
  for (const name of ['typescript', 'typescript6']) {
    let file;
    try {
      file = require.resolve(name);
    } catch (e) {
      if (e?.code === 'MODULE_NOT_FOUND') continue;
      throw e;
    }
    const api = require(file);
    if (
      Number(String(api.version).split('.')[0]) === TYPESCRIPT_API_MAJOR &&
      typeof api.createProgram === 'function'
    )
      return { ts: api, name, file };
    found.push(`${name} ${api.version} (${file})`);
  }
  throw new Error(
    `rnrs: the generator needs the TypeScript ${TYPESCRIPT_API_MAJOR} compiler API (typescript@6.0.3, a dependency of @rnrs/cli); ` +
      (found.length ? `found only ${found.join(', ')}` : 'typescript is not installed') +
      '. Reinstall @rnrs/cli (or run npm ci in the repository).',
  );
}
const api = loadTypeScriptApi();
const ts = api.ts;
/** Where the generator's TypeScript compiler API came from (diagnostics and tests). */
export const typescriptApi = { name: api.name, version: ts.version, file: api.file };

export const IR_VERSION = 1;

// `then` would make wrappers thenables: a Promise resolving to one would try to adopt it.
const RESERVED_OBJECT = new Set(['dispose', 'handle', 'host', 'constructor', 'then']);
const RESERVED_MODULE = new Set([
  'teardown',
  'stats',
  'generation',
  'violations',
  'host',
  'runtimeOwned',
  'constructor',
  'then',
]);
// Rust identifiers that cannot be written even as raw identifiers.
const RUST_UNRAWABLE = new Set(['self', 'super', 'crate', '_']);
// Type names the generated Rust code uses unqualified.
const RESERVED_TYPES = new Set([
  'Self',
  'Result',
  'Option',
  'String',
  'Vec',
  'Box',
  'Native',
  'Future',
  'CancelToken',
  'MaybeSend',
  'NativeObject',
  'Default',
  'Send',
  'Sync',
  'Ok',
  'Err',
  'Some',
  'None',
  'Module',
]);

/** Must match emit-rust.mjs `snake`. */
export function snakeOf(name) {
  return name
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1_$2')
    .toLowerCase();
}

const TYPED_ARRAYS = new Set([
  'Int8Array',
  'Uint8Array',
  'Uint8ClampedArray',
  'Int16Array',
  'Uint16Array',
  'Int32Array',
  'Uint32Array',
  'Float32Array',
  'Float64Array',
  'BigInt64Array',
  'BigUint64Array',
  'ArrayBufferView',
  'ArrayBufferLike',
]);

const LIB_REJECTIONS = {
  Date: 'Date is not supported; pass a timestamp number',
  Map: 'Map is not supported; use a record or an array of records',
  Set: 'Set is not supported; use an array',
  SharedArrayBuffer: 'SharedArrayBuffer is not supported (concurrent writers); pass an ArrayBuffer',
  DataView: 'pass an ArrayBuffer, not a view; slice explicitly with view.buffer.slice(start, end)',
  Object: 'Object is not supported; declare a record type',
  Function: 'functions and callbacks are not supported',
};

export function parseSpec(specPath, { frameworkSpec, root }) {
  const diagnostics = [];
  const rel = (file) => path.relative(root, file).split(path.sep).join('/');
  const options = {
    strict: true,
    noEmit: true,
    skipLibCheck: true,
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    lib: ['lib.es2022.d.ts'],
    // The spec import resolves to this generator's own framework spec (an absolute path, so no
    // baseUrl), whether or not @rnrs/runtime is installed next to the spec.
    paths: { '@rnrs/runtime/spec': [frameworkSpec] },
  };
  const program = ts.createProgram([specPath], options);
  const checker = program.getTypeChecker();
  const fail = (node, message) => {
    const sf = node.getSourceFile();
    const { line, character } = sf.getLineAndCharacterOfPosition(node.getStart(sf));
    diagnostics.push({ file: rel(sf.fileName), line: line + 1, column: character + 1, message });
  };
  const lineOf = (n) =>
    n.getSourceFile().getLineAndCharacterOfPosition(n.getStart(n.getSourceFile())).line + 1;
  for (const d of ts.getPreEmitDiagnostics(program)) {
    if (d.category !== ts.DiagnosticCategory.Error) continue;
    const message = ts.flattenDiagnosticMessageText(d.messageText, '\n');
    if (d.file && d.start !== undefined) {
      const { line, character } = d.file.getLineAndCharacterOfPosition(d.start);
      diagnostics.push({
        file: rel(d.file.fileName),
        line: line + 1,
        column: character + 1,
        message: `TypeScript: ${message}`,
      });
    } else
      diagnostics.push({
        file: rel(specPath),
        line: 1,
        column: 1,
        message: `TypeScript: ${message}`,
      });
  }
  const source = program.getSourceFile(specPath);
  if (!source) throw new Error(`cannot read spec ${specPath}`);
  const framework = program.getSourceFile(frameworkSpec);
  const markerDecl = (name) =>
    framework?.statements.find((s) => ts.isInterfaceDeclaration(s) && s.name.text === name);
  const markers = {
    object: markerDecl('NativeObject'),
    module: markerDecl('NativeModule'),
    // Recognized by declaration like the interfaces: a type merely named JsonValue is not it.
    json: framework?.statements.find(
      (s) => ts.isTypeAliasDeclaration(s) && s.name.text === 'JsonValue',
    ),
  };
  // Rust names the generated interface imports when the spec uses Record<string, T> or JsonValue.
  const dynamicUses = new Map(); // Rust type name -> first use site

  const resolve = (name) => {
    let symbol = checker.getSymbolAtLocation(name);
    if (symbol && symbol.flags & ts.SymbolFlags.Alias) symbol = checker.getAliasedSymbol(symbol);
    return symbol;
  };
  // Library types: TypeScript's default libs and declaration files of dependencies. Specs
  // themselves are .ts files and live in node_modules in every consumer, so a path test alone
  // would be wrong.
  const isLibDecl = (decl) => {
    const sf = decl.getSourceFile();
    return (
      program.isSourceFileDefaultLibrary(sf) ||
      (sf.isDeclarationFile && sf.fileName.includes('/node_modules/'))
    );
  };
  const markerOf = (decl) => {
    for (const clause of decl.heritageClauses ?? [])
      for (const t of clause.types) {
        const target = resolve(t.expression)?.declarations?.[0];
        if (target === markers.object) return 'object';
        if (target === markers.module) return 'module';
      }
    return null;
  };

  const records = new Map(); // name -> record IR (null while in progress)
  const unions = new Map();
  const typeOrigins = new Map(); // name -> declaration (collision check)

  const where = (decl) => `${rel(decl.getSourceFile().fileName)}:${lineOf(decl)}`;
  // Generated Rust names are flat: two distinct declarations with one name (for example
  // same-named records imported from two files) are rejected, never merged.
  const claim = (name, decl, useSite = decl) => {
    const previous = typeOrigins.get(name);
    if (previous && previous !== decl) {
      fail(
        useSite,
        `type name ${name} refers to two different declarations (${where(previous)} and ${where(decl)}); rename one`,
      );
      return false;
    }
    if (!previous && !checkTypeName(useSite, name)) return false;
    typeOrigins.set(name, decl);
    return true;
  };

  function checkTypeName(node, name) {
    if (!/^[A-Z][A-Za-z0-9]*$/.test(name)) {
      fail(node, `type name ${name} must be PascalCase letters and digits`);
      return false;
    }
    if (RESERVED_TYPES.has(name)) {
      fail(node, `type name ${name} is reserved by the generated Rust code`);
      return false;
    }
    return true;
  }

  /** Field, parameter and method names: valid in JS and Rust, unique after snake_case. */
  function checkValueName(node, owner, name, seen) {
    if (name === '__proto__') {
      fail(node, `${owner}: __proto__ cannot be a field or parameter name`);
      return false;
    }
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
      fail(
        node,
        `${owner}: ${JSON.stringify(name)} must be an identifier of letters, digits and _`,
      );
      return false;
    }
    const s = snakeOf(name);
    if (RUST_UNRAWABLE.has(s)) {
      fail(node, `${owner}: ${name} cannot be a Rust identifier (${s})`);
      return false;
    }
    if (seen.has(s)) {
      fail(node, `${owner}: ${name} and ${seen.get(s)} both become Rust ${s}`);
      return false;
    }
    seen.set(s, name);
    return true;
  }

  /** Declaration merging (interface + interface, interface + namespace) is not supported. */
  function single(symbol, node, name) {
    const decls = symbol?.declarations ?? [];
    if (decls.length > 1) {
      fail(
        node,
        `${name} has ${decls.length} merged declarations (${decls.map(where).join(', ')}); declaration merging is not supported`,
      );
      return false;
    }
    return true;
  }

  // Declarations: classify exported interfaces of the spec file.
  const objects = new Map(); // name -> decl
  let moduleDecl = null;
  for (const statement of source.statements) {
    if (ts.isImportDeclaration(statement)) continue;
    if (ts.isInterfaceDeclaration(statement)) {
      const kind = markerOf(statement);
      if (statement.heritageClauses && !kind)
        fail(
          statement,
          `interface ${statement.name.text} may only extend NativeObject or NativeModule`,
        );
      if (kind && statement.heritageClauses.flatMap((c) => c.types).length > 1)
        fail(
          statement,
          `interface ${statement.name.text} must extend exactly one of NativeObject or NativeModule`,
        );
      if (kind && statement.typeParameters)
        fail(statement, `generic native interfaces are not supported`);
      const symbol = checker.getSymbolAtLocation(statement.name);
      if (symbol?.declarations?.[0] !== statement) continue; // reported once, at the first declaration
      if (!single(symbol, statement, statement.name.text)) continue;
      if (kind && !claim(statement.name.text, statement)) continue;
      if (kind === 'object') objects.set(statement.name.text, statement);
      if (kind === 'module') {
        if (moduleDecl)
          fail(
            statement,
            `a spec declares exactly one NativeModule; ${moduleDecl.name.text} was declared first`,
          );
        else moduleDecl = statement;
      }
      continue;
    }
    if (ts.isTypeAliasDeclaration(statement)) continue;
    fail(
      statement,
      `unsupported declaration in a spec: only interfaces, type aliases and type imports are allowed`,
    );
  }
  if (!moduleDecl)
    diagnostics.push({
      file: rel(specPath),
      line: 1,
      column: 1,
      message: 'the spec must declare one interface extending NativeModule',
    });

  const ERR = { k: 'error' };

  function mapNode(node, ctx) {
    switch (node.kind) {
      case ts.SyntaxKind.NumberKeyword:
        return { k: 'number' };
      case ts.SyntaxKind.StringKeyword:
        return { k: 'string' };
      case ts.SyntaxKind.BooleanKeyword:
        return { k: 'boolean' };
      case ts.SyntaxKind.VoidKeyword:
        if (ctx.position === 'return') return { k: 'void' };
        fail(node, 'void is only allowed as a method result');
        return ERR;
      case ts.SyntaxKind.AnyKeyword:
      case ts.SyntaxKind.UnknownKeyword:
        fail(node, `${node.getText()} has no concrete conversion; use records, unions or bytes`);
        return ERR;
      case ts.SyntaxKind.ObjectKeyword:
        fail(node, 'object has no concrete conversion; declare a record type');
        return ERR;
      case ts.SyntaxKind.BigIntKeyword:
        fail(node, 'bigint is not supported; numbers are f64, use bytes for exact wide integers');
        return ERR;
      case ts.SyntaxKind.SymbolKeyword:
        fail(node, 'symbols are not supported');
        return ERR;
      case ts.SyntaxKind.UndefinedKeyword:
        fail(node, 'undefined is only expressible as an optional field or parameter (x?: T)');
        return ERR;
      case ts.SyntaxKind.NeverKeyword:
        fail(node, 'never is not supported');
        return ERR;
      case ts.SyntaxKind.ParenthesizedType:
        return mapNode(node.type, ctx);
      case ts.SyntaxKind.ArrayType:
        return array(mapNode(node.elementType, { ...ctx, position: 'element' }));
      case ts.SyntaxKind.TypeOperator:
        if (node.operator === ts.SyntaxKind.ReadonlyKeyword && ts.isArrayTypeNode(node.type))
          return mapNode(node.type, ctx);
        fail(node, `type operator ${node.getText()} is not supported`);
        return ERR;
      case ts.SyntaxKind.UnionType:
        return mapUnionNode(node, ctx, null);
      case ts.SyntaxKind.TypeReference:
        return mapReference(node, ctx);
      case ts.SyntaxKind.LiteralType:
        if (node.literal.kind === ts.SyntaxKind.NullKeyword)
          fail(node, 'null alone is not a type; use T | null');
        else
          fail(
            node,
            'literal types are only supported as union discriminators and constant variant fields',
          );
        return ERR;
      case ts.SyntaxKind.TypeLiteral:
        fail(node, 'name this object type with an interface or type alias');
        return ERR;
      case ts.SyntaxKind.TupleType:
        fail(node, 'tuples are not supported yet');
        return ERR;
      case ts.SyntaxKind.FunctionType:
        fail(node, 'functions and callbacks are not supported');
        return ERR;
      default:
        fail(node, `unsupported type construct: ${node.getText()}`);
        return ERR;
    }
  }

  function array(of) {
    return of === ERR ? ERR : { k: 'array', of };
  }

  function nullable(of, node) {
    if (of === ERR) return ERR;
    if (of.k === 'nullable') {
      fail(node, 'nested nullability is not supported');
      return ERR;
    }
    if (of.k === 'void') {
      fail(node, 'void | null is not supported');
      return ERR;
    }
    if (of.k === 'json') {
      fail(
        node,
        'JsonValue already includes null; use JsonValue (or x?: JsonValue to tell absent from null)',
      );
      return ERR;
    }
    return { k: 'nullable', of };
  }

  // `name` is set when the union is the body of a type alias.
  function mapUnionNode(node, ctx, name, useSite) {
    const isNull = (t) =>
      t.kind === ts.SyntaxKind.LiteralType && t.literal.kind === ts.SyntaxKind.NullKeyword;
    const isUndefined = (t) => t.kind === ts.SyntaxKind.UndefinedKeyword;
    if (node.types.some(isUndefined)) {
      fail(node, 'use an optional field or parameter (x?: T) instead of | undefined');
      return ERR;
    }
    const hasNull = node.types.some(isNull);
    const rest = node.types.filter((t) => !isNull(t));
    let base;
    if (rest.length === 1) base = mapNode(rest[0], ctx);
    else if (name) base = mapDiscriminated(name, rest, node, useSite);
    else if (rest.every((t) => ts.isTypeLiteralNode(t) || ts.isTypeReferenceNode(t))) {
      fail(node, 'name this union with a type alias; discriminated unions become named Rust enums');
      return ERR;
    } else {
      fail(node, 'untagged mixed unions are not supported; use a discriminated union');
      return ERR;
    }
    return hasNull ? nullable(base, node) : base;
  }

  function mapReference(node, ctx) {
    const symbol = resolve(node.typeName);
    const decl = symbol?.declarations?.[0];
    const name = node.typeName.getText();
    if (!decl) {
      fail(node, `cannot resolve type ${name}`);
      return ERR;
    }
    if (markers.json && decl === markers.json) {
      if (!dynamicUses.has('JsonValue')) dynamicUses.set('JsonValue', node);
      return { k: 'json' };
    }
    if (isLibDecl(decl)) {
      const libName = symbol.getName();
      if (libName === 'Record') return mapRecordType(node, ctx);
      if (libName === 'Promise') {
        if (ctx.position !== 'return' || ctx.promised) {
          fail(node, 'Promise is only supported as a method result');
          return ERR;
        }
        const inner = node.typeArguments?.[0];
        if (!inner) {
          fail(node, 'Promise needs a type argument');
          return ERR;
        }
        const of = mapNode(inner, { ...ctx, promised: true });
        return of === ERR ? ERR : { k: 'promise', of };
      }
      if (libName === 'ArrayBuffer') return { k: 'bytes' };
      if (TYPED_ARRAYS.has(libName)) {
        fail(
          node,
          `${libName} is not accepted; the contract is ArrayBuffer (slice explicitly with view.buffer.slice(start, end))`,
        );
        return ERR;
      }
      if (libName === 'Array' || libName === 'ReadonlyArray') {
        const inner = node.typeArguments?.[0];
        return inner
          ? array(mapNode(inner, { ...ctx, position: 'element' }))
          : (fail(node, 'Array needs a type argument'), ERR);
      }
      fail(node, LIB_REJECTIONS[libName] ?? `${libName} is not supported`);
      return ERR;
    }
    if (node.typeArguments?.length) {
      fail(node, `generic types are not supported (${name})`);
      return ERR;
    }
    if (!single(symbol, node, name)) return ERR;
    if (ts.isInterfaceDeclaration(decl)) {
      const kind = markerOf(decl);
      if (kind === 'object') {
        if (decl.getSourceFile() !== source) {
          fail(
            node,
            `native object interface ${decl.name.text} must be declared in the spec file (it becomes an associated type of the module)`,
          );
          return ERR;
        }
        return { k: 'native', name: decl.name.text };
      }
      if (kind === 'module') {
        fail(node, 'the NativeModule cannot be passed or returned');
        return ERR;
      }
      return recordFrom(decl.name.text, decl, decl.members, node);
    }
    if (ts.isTypeAliasDeclaration(decl)) {
      if (decl.typeParameters) {
        fail(node, `generic types are not supported (${name})`);
        return ERR;
      }
      const body = decl.type;
      if (ts.isTypeLiteralNode(body)) return recordFrom(decl.name.text, decl, body.members, node);
      if (ts.isUnionTypeNode(body)) {
        const objectish = body.types.filter(
          (t) =>
            !(t.kind === ts.SyntaxKind.LiteralType && t.literal.kind === ts.SyntaxKind.NullKeyword),
        );
        if (objectish.length > 1) return mapUnionNode(body, ctx, decl.name.text, node);
      }
      return mapNode(body, ctx); // plain alias, e.g. type Meters = number
    }
    if (ts.isClassDeclaration(decl)) {
      fail(node, 'class instances are not value types; use a record or a native object');
      return ERR;
    }
    if (ts.isEnumDeclaration(decl)) {
      fail(node, 'TS enums are not supported; use a string-literal discriminated union');
      return ERR;
    }
    fail(node, `unsupported type ${name}`);
    return ERR;
  }

  /** `Record<string, T>`: a dictionary (`BTreeMap<String, T>`), converted by enumerating a
   *  plain object's own keys; unlike records, which read declared fields. */
  function mapRecordType(node, ctx) {
    const [key, value] = node.typeArguments ?? [];
    if (!key || key.kind !== ts.SyntaxKind.StringKeyword || !value) {
      fail(node, 'only Record<string, T> is supported: keys must be the string type');
      return ERR;
    }
    const of = mapNode(value, { ...ctx, position: 'element' });
    if (of === ERR) return ERR;
    if (!dynamicUses.has('BTreeMap')) dynamicUses.set('BTreeMap', node);
    return { k: 'map', of };
  }

  function fieldsFrom(owner, members, { allowLiterals }) {
    const fields = [];
    const literals = [];
    const seen = new Set();
    const seenSnake = new Map();
    for (const member of members) {
      if (ts.isIndexSignatureDeclaration(member)) {
        fail(member, `${owner}: index signatures are not supported; use Record<string, T>`);
        continue;
      }
      if (
        !ts.isPropertySignature(member) ||
        !member.type ||
        (!ts.isIdentifier(member.name) && !ts.isStringLiteral(member.name))
      ) {
        fail(
          member,
          `${owner}: records contain only named properties with types (no methods, index signatures or computed keys)`,
        );
        continue;
      }
      const name = member.name.text;
      if (seen.has(name)) {
        fail(member, `${owner}: duplicate field ${name}`);
        continue;
      }
      seen.add(name);
      const optional = !!member.questionToken;
      const isLiteral =
        member.type.kind === ts.SyntaxKind.LiteralType &&
        member.type.literal.kind === ts.SyntaxKind.StringLiteral;
      if (
        isLiteral
          ? name === '__proto__' &&
            (fail(member, `${owner}: __proto__ cannot be a field name`), true)
          : !checkValueName(member, owner, name, seenSnake)
      )
        continue;
      if (isLiteral) {
        if (!allowLiterals) {
          fail(
            member,
            `${owner}.${name}: string-literal fields are only supported in discriminated union variants`,
          );
          continue;
        }
        if (optional) {
          fail(member, `${owner}.${name}: literal fields must be required`);
          continue;
        }
        literals.push({ name, value: member.type.literal.text, line: lineOf(member) });
        continue;
      }
      if (
        optional &&
        ts.isUnionTypeNode(member.type) &&
        member.type.types.some(
          (t) =>
            t.kind === ts.SyntaxKind.LiteralType && t.literal.kind === ts.SyntaxKind.NullKeyword,
        )
      ) {
        fail(
          member,
          `${owner}.${name}: optional nullable fields (x?: T | null) have three states and are rejected; choose x?: T or x: T | null`,
        );
        continue;
      }
      const type = mapNode(member.type, { position: 'field' });
      if (type === ERR) continue;
      if (optional && type.k === 'nullable') {
        fail(
          member,
          `${owner}.${name}: optional field of a nullable type has three states (missing, null, value) and is rejected; choose x?: T or x: T | null`,
        );
        continue;
      }
      fields.push({ name, type, optional });
    }
    return { fields, literals };
  }

  function recordFrom(name, decl, members, useSite) {
    if (!claim(name, decl, useSite)) return ERR;
    if (records.has(name)) {
      if (records.get(name) === null) {
        fail(useSite, `recursive value types are not supported yet (${name})`);
        return ERR;
      }
      return { k: 'record', name };
    }
    if (ts.isInterfaceDeclaration(decl) && decl.heritageClauses) {
      fail(decl, `record ${name} cannot extend other interfaces`);
      return ERR;
    }
    records.set(name, null);
    const { fields } = fieldsFrom(name, members, { allowLiterals: false });
    if (fields.length === 0 && members.length === 0) fail(decl, `record ${name} has no fields`);
    records.set(name, { name, fields, line: lineOf(decl) });
    return { k: 'record', name };
  }

  function mapDiscriminated(name, variantNodes, node, useSite) {
    const aliasDecl = node.parent;
    if (!claim(name, aliasDecl, useSite)) return ERR;
    if (unions.has(name)) {
      if (unions.get(name) === null) {
        fail(node, `recursive value types are not supported yet (${name})`);
        return ERR;
      }
      return { k: 'union', name };
    }
    unions.set(name, null);
    const variants = [];
    for (const v of variantNodes) {
      let members;
      if (ts.isTypeLiteralNode(v)) members = v.members;
      else if (ts.isTypeReferenceNode(v)) {
        const symbol = resolve(v.typeName);
        const decl = symbol?.declarations?.[0];
        if (!single(symbol, v, v.typeName.getText())) {
          unions.delete(name);
          return ERR;
        }
        if (decl && ts.isInterfaceDeclaration(decl) && !markerOf(decl) && !decl.heritageClauses)
          members = decl.members;
        else if (decl && ts.isTypeAliasDeclaration(decl) && ts.isTypeLiteralNode(decl.type))
          members = decl.type.members;
      }
      if (!members) {
        fail(
          v,
          `${name}: every union variant must be an object type (untagged mixed unions are not supported)`,
        );
        unions.delete(name);
        return ERR;
      }
      const { fields, literals } = fieldsFrom(name, members, { allowLiterals: true });
      variants.push({ node: v, fields, literals });
    }
    // Discriminator inference (docs/generator.md, "Discriminated unions"): present and required in every variant,
    // one string literal in each, distinct across variants.
    const candidates = variants[0].literals
      .map((l) => l.name)
      .filter(
        (field) =>
          variants.every((v) => v.literals.some((l) => l.name === field)) &&
          new Set(variants.map((v) => v.literals.find((l) => l.name === field).value)).size ===
            variants.length,
      );
    const annotated = ts.getJSDocTags(aliasDecl).find((t) => t.tagName.text === 'discriminator');
    let discriminator;
    if (annotated) {
      const wanted = (
        typeof annotated.comment === 'string'
          ? annotated.comment
          : (ts.getTextOfJSDocComment(annotated.comment) ?? '')
      ).trim();
      if (!candidates.includes(wanted)) {
        fail(
          annotated,
          `${name}: @discriminator ${wanted || '(missing)'} is not a valid discriminator; candidates: ${candidates.join(', ') || 'none'}`,
        );
        unions.delete(name);
        return ERR;
      }
      discriminator = wanted;
    } else if (candidates.length === 1) discriminator = candidates[0];
    else if (candidates.length === 0) {
      fail(
        aliasDecl,
        `${name}: no discriminator: a field must be present and required in every variant, have one string-literal value in each, and differ between variants`,
      );
      unions.delete(name);
      return ERR;
    } else {
      fail(
        aliasDecl,
        `${name}: ambiguous discriminator (${candidates.join(', ')}); annotate the alias with /** @discriminator <field> */`,
      );
      unions.delete(name);
      return ERR;
    }
    const used = new Map();
    const out = variants.map((v) => {
      const tag = v.literals.find((l) => l.name === discriminator).value;
      const rustName = variantIdent(tag);
      if (!rustName)
        fail(
          v.node,
          `${name}: tag ${JSON.stringify(tag)} cannot be turned into a Rust variant name`,
        );
      else if (used.has(rustName))
        fail(
          v.node,
          `${name}: tags ${JSON.stringify(used.get(rustName))} and ${JSON.stringify(tag)} map to the same Rust variant ${rustName}`,
        );
      used.set(rustName, tag);
      return {
        tag,
        rustName,
        fields: v.fields,
        literals: v.literals
          .filter((l) => l.name !== discriminator)
          .map(({ name, value }) => ({ name, value })),
      };
    });
    unions.set(name, { name, discriminator, variants: out, line: lineOf(aliasDecl) });
    return { k: 'union', name };
  }

  function methodsOf(decl, owner) {
    const reserved = owner ? RESERVED_OBJECT : RESERVED_MODULE;
    const methods = [];
    const names = new Set();
    const methodSnakes = new Map();
    const seenMethods = []; // {member, name, snake, async}: for checks needing every resolved result
    for (const member of decl.members) {
      if (!ts.isMethodSignature(member)) {
        fail(
          member,
          `${decl.name.text}: only methods are allowed in native interfaces (no properties)`,
        );
        continue;
      }
      if (!ts.isIdentifier(member.name)) {
        fail(member, 'method names must be identifiers');
        continue;
      }
      const name = member.name.text;
      if (member.questionToken) {
        fail(member, `${name}: optional methods are not supported`);
        continue;
      }
      if (member.typeParameters) {
        fail(member, `${name}: generic methods are not supported; export concrete signatures`);
        continue;
      }
      if (names.has(name)) {
        fail(member, `${name}: overloads are not supported`);
        continue;
      }
      names.add(name);
      if (reserved.has(name)) {
        fail(member, `${name} is reserved by the framework wrapper`);
        continue;
      }
      if (!checkValueName(member, decl.name.text, name, methodSnakes)) continue;
      if (!member.type) {
        fail(member, `${name}: declare the result type`);
        continue;
      }
      // The result is resolved first: whether a method is async depends on the resolved type
      // (`type Later = Promise<number>` is async too), not on how the signature is spelled.
      let returns = mapNode(member.type, { position: 'return' });
      const isAsync = returns !== ERR && returns.k === 'promise';
      seenMethods.push({ member, name, snake: snakeOf(name), async: isAsync });
      const params = [];
      let ok = returns !== ERR;
      let sawOptional = false;
      const paramSnakes = new Map();
      for (const p of member.parameters) {
        if (!ts.isIdentifier(p.name) || p.dotDotDotToken || p.initializer || !p.type) {
          fail(
            p,
            `${name}: parameters must be plain named parameters with types (no rest, defaults or destructuring)`,
          );
          ok = false;
          continue;
        }
        if (!checkValueName(p, name, p.name.text, paramSnakes)) {
          ok = false;
          continue;
        }
        if (isAsync && snakeOf(p.name.text) === 'cancel') {
          fail(p, `${name}: cancel is reserved for the async method's CancelToken`);
          ok = false;
          continue;
        }
        const optional = !!p.questionToken;
        if (sawOptional && !optional) {
          fail(p, `${name}: required parameters cannot follow optional ones`);
          ok = false;
        }
        sawOptional ||= optional;
        if (
          optional &&
          ts.isUnionTypeNode(p.type) &&
          p.type.types.some(
            (t) =>
              t.kind === ts.SyntaxKind.LiteralType && t.literal.kind === ts.SyntaxKind.NullKeyword,
          )
        ) {
          fail(p, `${name}: optional nullable parameters have three states and are rejected`);
          ok = false;
          continue;
        }
        const type = mapNode(p.type, { position: 'param' });
        if (type === ERR) {
          ok = false;
          continue;
        }
        if (optional && type.k === 'nullable') {
          fail(
            p,
            `${name}: optional parameter of a nullable type has three states and is rejected`,
          );
          ok = false;
          continue;
        }
        params.push({ name: p.name.text, type, optional });
      }
      if (returns === ERR) continue;
      if (isAsync) returns = returns.of;
      if (ok) methods.push({ name, owner, async: isAsync, params, returns, line: lineOf(member) });
    }
    // Generated validate_<method> hooks share the trait namespace with the methods.
    for (const a of seenMethods.filter((m) => m.async)) {
      for (const other of seenMethods.filter((m) => m.snake === `validate_${a.snake}`)) {
        fail(
          other.member,
          `${other.name} collides with the generated validate hook of async method ${a.name}`,
        );
        const i = methods.findIndex((m) => m.name === other.name);
        if (i >= 0) methods.splice(i, 1);
      }
    }
    return methods;
  }

  const objectIR = [];
  const methods = [];
  if (moduleDecl) {
    // Module methods first, then each object's methods: the order is the call index.
    methods.push(...methodsOf(moduleDecl, null));
    for (const [name, decl] of objects) {
      objectIR.push({ name, line: lineOf(decl) });
      methods.push(...methodsOf(decl, name));
    }
    for (const o of objects.keys()) {
      const assoc = `${o}Impl`;
      if (typeOrigins.has(assoc))
        fail(
          typeOrigins.get(assoc),
          `type name ${assoc} collides with the associated type generated for native object ${o}`,
        );
    }
  }
  // The generated interface imports these names only when used; a spec type of the same name
  // would collide with the import.
  for (const [name, site] of dynamicUses)
    if (typeOrigins.has(name))
      fail(
        typeOrigins.get(name),
        `type name ${name} is reserved when the spec uses ${name === 'JsonValue' ? 'JsonValue' : 'Record<string, T>'} (${where(site)})`,
      );
  const ir = {
    irVersion: IR_VERSION,
    module: moduleDecl ? moduleDecl.name.text : null,
    spec: rel(specPath),
    objects: objectIR,
    records: [...records.values()].filter(Boolean),
    unions: [...unions.values()].filter(Boolean),
    methods,
  };
  ir.hash = irHash(ir);
  return { ir, diagnostics };
}

export function irHash(ir) {
  const strip = (value) =>
    Array.isArray(value)
      ? value.map(strip)
      : value && typeof value === 'object'
        ? Object.fromEntries(
            Object.entries(value)
              .filter(([k]) => k !== 'line' && k !== 'hash' && k !== 'spec')
              .map(([k, v]) => [k, strip(v)]),
          )
        : value;
  return createHash('sha256')
    .update(JSON.stringify(strip(ir)))
    .digest('hex')
    .slice(0, 16);
}

/** `"circle"` -> `Circle`, `"two-words"` -> `TwoWords`; null if no valid identifier results. */
export function variantIdent(tag) {
  const parts = tag.split(/[^A-Za-z0-9]+/).filter(Boolean);
  const ident = parts.map((p) => p[0].toUpperCase() + p.slice(1)).join('');
  return /^[A-Za-z][A-Za-z0-9]*$/.test(ident) ? ident : null;
}

export function formatDiagnostic(d) {
  return `${d.file}:${d.line}:${d.column}: error: ${d.message}`;
}
