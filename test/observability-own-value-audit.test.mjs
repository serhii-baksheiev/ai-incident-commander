/**
 * AIC-69: every read of caller-supplied data in the observability layer goes
 * through `ownValue`, or is a declared exemption with a reason.
 *
 * This file is a STATIC AUDIT of `packages/observability/src/index.ts`, and it
 * exists because the behavioural family cannot do this job.
 * `test/metric-path-prototype-safety.test.mjs` pollutes `Object.prototype` and
 * asserts that named surfaces refuse — it goes red on REGRESSION of a surface it
 * names, and it cannot go red on ADDITION, because a plain `[[Get]]` added
 * tomorrow has no test naming it. The hazard is exactly addition: a `[[Get]]`
 * walks the prototype chain, so a polluted `Object.prototype` can redirect an
 * outbound call, publish a fabricated evaluation under a real record's identity,
 * or supply an identity field the run never declared.
 *
 * The alternative — a hand-written prose inventory of the reads — was attempted
 * repeatedly in AIC-67, and each draft was a different wrong subset until the
 * enumeration was deleted rather than repaired again (see `journal/2026-09.md`,
 * the AIC-67 entry). So the inventory is COMPUTED here, from the file's AST,
 * every run.
 *
 * Its scope is ONE file, `packages/observability/src/index.ts`, and "the
 * observability layer" in the test names above means that file only because a
 * second one would fail › "audits every source file the observability layer
 * has". Without that check the claim would go quietly false on the day someone
 * adds a source file, which is the day it would matter.
 *
 * ## Why an AST and not a regex
 *
 * At the commit this audit was written against, two functions in that file
 * opened with syntactically identical object-binding-pattern parameters. One
 * was honest — the file itself builds the object passed to it — and one was the
 * hazard, because an exported function's options object comes from the caller
 * and destructuring it is three `[[Get]]`s. Only *who supplies the object*
 * separated them, and no regex can see that. The hardening removed the hazardous
 * one, so only the honest shape survives today; the argument for an AST is
 * unchanged, because the next such pair would be written the same way.
 * `typescript` is already a devDependency; this test parses with it and adds no
 * dependency.
 *
 * ## What counts as a read of caller data
 *
 * A violation is a property or element access whose BASE expression holds
 * caller-supplied data, plus each name destructured from a caller-supplied
 * object. `ownValue(target, key)` is not a property access at all, so the safe
 * form is invisible to this audit by construction — including through a local
 * alias such as `const own = (key) => ownValue(evidence, key)`, which a check
 * keyed on the literal token `ownValue` would have fired on. `Object.entries`,
 * `Object.values` and `Object.keys` are own-and-enumerable iteration and are
 * likewise not accesses.
 *
 * ## How caller data is tracked
 *
 * The layer's idiom is to project caller data ONCE at the boundary into fresh
 * own-only local objects and read those downstream, so the audit has to be able
 * to tell a projection from the thing it projects. Three properties do that:
 *
 *   - **Caller data enters at the forms this module exports a callable in, and
 *     spreads by argument.** Seeding one syntactic form lets a style refactor
 *     empty this audit without changing a single read — that is not a
 *     hypothetical: seeding keyed on `ModifierFlags.Export` alone, and moving
 *     this layer's four exports into one `export { … }` clause took the audit
 *     to zero violations over two reverted own reads (AIC-82). ⚠ **Which forms
 *     are seeded is `WALKER_CAPABILITIES`, not this sentence** — the entries
 *     whose names begin `exported-` are the whole set, each one held by a probe
 *     that goes red when its branch is deleted. Prose states capabilities at a
 *     finer grain than any list checked against it, so the capability names are
 *     the contract; read them rather than this paragraph. An internal function's parameter
 *     holds caller data only when some call site hands it some, which is what
 *     makes `persistPreparedExperiment`'s `OwnExperiment` parameter clean while
 *     `requireResourceEvidence`'s parameter is not — the same shape, different
 *     callers.
 *   - **A function's return value carries caller data if any expression it
 *     returns does.** A fresh object literal does not, which is exactly why the
 *     projections launder and `ownValue` deliberately does not: `ownValue`
 *     hands back the caller's value, checked but verbatim, and that is what
 *     keeps the reads downstream of an own read in scope for this audit.
 *   - **Object literals are tracked field by field.** A projection whose type
 *     carries a passthrough field — an `unknown` holding the caller's object —
 *     launders the container but not that field, so a later read THROUGH it is
 *     still reported.
 *   - **A name takes caller data from an ASSIGNMENT as well as a
 *     declaration.** `let x; x = caller;` reads exactly like `const x = caller`
 *     from the next line on, and modelling only declarations let that two-line
 *     detour launder — including `x ||= caller` and its two siblings.
 *   - **A container is only as laundered as what was put in it.**
 *     `Object.fromEntries` builds with CreateDataProperty exactly as a literal
 *     does, so the CONTAINER is fresh — but its values are the pairs it was
 *     handed, and `map` yields what its callback returned. That chain is what
 *     makes `requireMetrics` returning a fresh `{ key, score }` pair, rather
 *     than the caller's own metric object, a thing this audit holds: reverting
 *     it reports the two reads off that object at the feedback call.
 *
 * ## Every capability stated here is pinned, and that is checked
 *
 * Three review rounds each found a different capability that WORKED, that this
 * header promised, and that could be deleted with every test green. They were
 * one defect, not three: nothing tied the claims to the probe, so each round
 * closed the instance it happened to try. The rule that replaces the rounds:
 *
 *   **a capability stated here has a probe entry naming it, or it is not stated
 *   — it goes in the blind-spot list instead. Rewording is not an exit.**
 *
 * `WALKER_CAPABILITIES` is that list of claims, and the two checks over it go
 * red in both directions: › "pins every capability the walker states as
 * contract" when a claim has no read behind it, and › "names a declared
 * capability in every probe entry" when a probe drifts from what it was written
 * to hold. A precision rule — one whose loss makes the walker LOUDER, so no
 * planted read can catch it — is pinned from the other side, by an honest read
 * in `HONEST_PROBE_READS` that must stay silent.
 *
 * ## The coarsenings, stated rather than implied
 *
 * They do not all err the same way, and pretending otherwise would be the exact
 * defect this file exists to end. 1 and 4 err toward reporting MORE, where the
 * cost is one exemption entry with a reason. 2, 3 and 5 SUPPRESS reports: they
 * are places this audit is silent, not places it is noisy, and a green run says
 * nothing about them:
 *
 *   1. **Scopes are per function, not per block.** A name declared twice in one
 *      function is one binding here.
 *   2. **Method dispatch is not audited.** `x.m(…)` in callee position is a
 *      method lookup, and a real `Client` keeps its methods on its prototype —
 *      demanding an own read there would break the honest client. Data reads
 *      are the hazard; method resolution is not.
 *   3. **Array destructuring is not audited.** `for (const [i, r] of …)` goes
 *      through the iterator protocol. That is not itself a defence — a polluted
 *      `Object.prototype[Symbol.iterator]` makes any plain object iterable — but
 *      the destructured values in this file come from `Array.prototype.entries`,
 *      which yields real arrays. Audit it if that stops being true.
 *   4. **Array elements are one descriptor, not one per index.** Everything an
 *      array is known to hold is joined, so a single caller value in it makes
 *      every read of every element a read of caller data. Which fill operations
 *      are followed is `array-elements-and-push` in `WALKER_CAPABILITIES` and the
 *      probe entry that pins it; any other way of filling an array is not.
 *   5. **Field knowledge stops at six levels deep**, which is what makes the
 *      lattice finite and the fixpoint terminate. Deeper than that a projection
 *      reads as opaque rather than as caller data. Six is not decoration: the
 *      probe below carries a projection nested exactly that deep, so lowering
 *      the cap to five or less turns › "reports every plain [[Get]] planted on
 *      caller-supplied data" red. It was the one coarsening with no planted read
 *      behind it, and a number nothing holds is a number that drifts down.
 *
 * ⚠ The blind spots no audit of this file's text can close, stated here so no
 * reader infers cover that is not there:
 *
 *   - a built-in that reads a caller array element for you — `slice`, `at`,
 *     `flat` — performs the `[[Get]]` INSIDE `Array.prototype`, where nothing
 *     below can see it. No instance of that survives in the file today: the one
 *     `slice` left runs on a freshly built local array.
 *   - a function reached through a PARAMETER, an object property or a reassigned
 *     binding is not resolved to its declaration, so caller data does not follow
 *     it. A `const`-bound arrow IS resolved — that is what makes the `own` alias
 *     in `requireResourceEvidence` a non-event rather than a false positive —
 *     and so is a callee written INLINE at the call, `(o => o.field)(caller)`,
 *     which is not reached through anything: it is present in the call itself
 *     (`inline-callee-parameters`).
 *   - a METHOD is in that same set. An argument passed to `x.m(…)` is not
 *     matched to `m`'s parameter, so a method of a NON-exported class receives
 *     caller data from nothing and reads nothing. Methods of an exported class,
 *     and of an exported object literal, are covered — they are seeded directly
 *     rather than reached.
 *   - an exported callable the SEEDING does not reach. The seeding knows the
 *     forms named `exported-*` in `WALKER_CAPABILITIES` and no others, so a
 *     barrel, a spread, a frozen object, a factory's return or a getter puts a
 *     callable within a caller's reach whose body this audit does not judge.
 *     ⚠ This is a gap in what is AUDITED. It is not silent for a NEW EXPORT:
 *     › "reaches no callable this audit was not told about" compares the layer's
 *     export NAMES, so a new name is red whatever it holds, and the choice —
 *     seed the form, or record that its body is unaudited — has to be made out
 *     loud. It IS still silent for a callable hung under an EXISTING export
 *     name, which is the bullet below.
 *   - a callable hung under an EXISTING export name. Measured on this layer,
 *     each leaving all nine tests green while a caller reaches an unprojected
 *     `options.client`: a property assigned onto an exported function
 *     (`(resolveTracingConfig as …).handler = (o) => o.client`), the same via
 *     `Object.defineProperty` whether enumerable or not, and a callable in the
 *     object an exported factory returns when it is CALLED. Neither half of the
 *     export check sees these: the name comparison sees no new name, and the
 *     reachability walk records a function and stops there rather than
 *     enumerating its properties — it also stops below a depth of four. Nothing
 *     static closes the factory case, because the object exists only once the
 *     factory has run.
 *   - a read performed BY a helper rather than by this file. `Reflect.get(o, k)`
 *     walks the prototype chain inside the call, and there is no property access
 *     here to report. What the walker does instead is refuse to launder: the
 *     RESULT of any helper it does not model carries caller data, so the next
 *     read off it IS reported — pinned below by
 *     `reflected.plantedBehindAnUnmodelledHelper`. The call itself stays silent.
 *   - an assignment whose target is not a plain identifier. `o.field = caller`
 *     and `[a] = caller` put caller data somewhere this walker does not follow,
 *     so a later read of it is silent. An IDENTIFIER target is modelled, and
 *     pinned below by `alias.plantedThroughAnAssignment` — this bullet is about
 *     the two shapes beside it, not about assignment as such.
 */
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join as joinPath, relative, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import ts from 'typescript';

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const auditedLayer = resolve(projectRoot, 'packages/observability/src');
const auditedPath = resolve(auditedLayer, 'index.ts');
const auditedSource = readFileSync(auditedPath, 'utf8');

/**
 * The reads that stay plain `[[Get]]`s on purpose, each with the reason it is
 * not a prototype-pollution surface.
 *
 * They are DATA, and matched by enclosing function plus expression text, so
 * adding one is a visible line in a review rather than a walker tweak nobody
 * reads. The audit also refuses an entry it no longer needs — a stale exemption
 * is cover somebody will believe.
 */
const DECLARED_EXEMPTIONS = [
  {
    fn: 'ownValue',
    expression: 'descriptor.value',
    why: 'the descriptor is freshly built by Object.getOwnPropertyDescriptor, so `value` is its own property and the chain was already refused one line up',
  },
  {
    fn: 'ownClient',
    expression: 'descriptor.value',
    why: 'the same freshly built descriptor as in ownValue above, and for the same reason — this one reads it after Object.hasOwn has refused an accessor, which is the distinction the caller needs',
  },
  {
    fn: 'persistBenchmarkExperiments',
    expression: 'datasetName.length',
    why: 'a string primitive: `length` resolves on String.prototype, which is not the polluted surface',
  },
  {
    fn: 'resolveTracingConfig',
    expression: 'apiKey.length',
    why: 'a string primitive, same as datasetName above',
  },
  {
    fn: 'requireExperiment',
    expression: 'rawRecords.length',
    why: 'requireOwnArray refuses anything Array.isArray rejects, and `length` is an own property of every array — the ELEMENTS are still read through ownElement',
  },
  {
    fn: 'requireExperiment',
    expression: 'results.length',
    why: 'same: proven to be an array by requireOwnArray before its length is read',
  },
  {
    fn: 'persistPreparedExperiment',
    expression: 'resources[key]',
    why: 'the container is built by Object.fromEntries from a pair pushed for EVERY key of PERSISTED_RESOURCE_KEYS — requireResourceEvidence throws on any that is absent — and this loop reads that same list, so each key read here is one this layer inserted itself',
  },
  {
    fn: 'persistBenchmarkExperiments',
    expression: 'rawExperiments.length',
    why: 'same: proven to be an array by requireOwnArray before its length is read',
  },
];

/* -------------------------------------------------------------------------- */
/* Taint descriptors                                                           */
/* -------------------------------------------------------------------------- */

/**
 * What is known about one value: whether it IS caller data, and what is known
 * about its fields. A projection is `{ self: false }` with a field or two that
 * are `{ self: true }` — the container is fresh, the passthrough is not.
 *
 * The nesting is capped so that comparison, and therefore the fixpoint below,
 * terminates on any input.
 */
const MAX_FIELD_DEPTH = 6;

/**
 * The synthetic field name standing for "an element of this array".
 *
 * Elements are joined into ONE descriptor rather than tracked per index: the
 * file holds its projections in arrays, so losing them at the array boundary
 * would have made every read through a projected record invisible.
 */
const ELEMENT = '#element';

function clean() {
  return { self: false, fields: new Map() };
}

function callerData() {
  return { self: true, fields: new Map() };
}

function join(left, right) {
  const fields = new Map(left.fields);
  for (const [key, value] of right.fields) {
    fields.set(key, fields.has(key) ? join(fields.get(key), value) : value);
  }
  return { self: left.self || right.self, fields };
}

function fieldOf(descriptor, name) {
  return descriptor.fields.get(name) ?? { self: descriptor.self, fields: new Map() };
}

function elementOf(descriptor) {
  return fieldOf(descriptor, ELEMENT);
}

/**
 * Drops field knowledge below the depth cap, so the lattice is finite and the
 * fixpoint terminates on any input. It drops rather than collapses to caller
 * data: collapsing would report every field of a deep projection.
 */
function truncate(descriptor, depth = 0) {
  if (depth >= MAX_FIELD_DEPTH) return { self: descriptor.self, fields: new Map() };
  const fields = new Map();
  for (const [key, value] of descriptor.fields) fields.set(key, truncate(value, depth + 1));
  return { self: descriptor.self, fields };
}

/** A canonical form, so the fixpoint can tell "grew" from "unchanged". */
function descriptorKey(descriptor, depth = 0) {
  if (depth >= MAX_FIELD_DEPTH) return descriptor.self ? '1' : '0';
  const fields = [...descriptor.fields.entries()]
    .sort(([left], [right]) => (left < right ? -1 : 1))
    .map(([key, value]) => `${key}:${descriptorKey(value, depth + 1)}`);
  return `${descriptor.self ? '1' : '0'}{${fields.join(',')}}`;
}

/* -------------------------------------------------------------------------- */
/* Syntax helpers                                                              */
/* -------------------------------------------------------------------------- */

/**
 * The assignments that put a value into an existing name. A binding is not only
 * what it was declared with: `let x; x = caller;` reads exactly like
 * `const x = caller` from the next line onwards.
 */
const ASSIGNMENT_OPERATORS = new Set([
  ts.SyntaxKind.EqualsToken,
  ts.SyntaxKind.QuestionQuestionEqualsToken,
  ts.SyntaxKind.BarBarEqualsToken,
  ts.SyntaxKind.AmpersandAmpersandEqualsToken,
]);

/**
 * The `Object.*` helpers that hand back an ARRAY of the caller's own values.
 *
 * The walker READS this set rather than restating it: this constant spent a
 * revision declared and unreferenced beside an inline list that said something
 * different, which is two spellings of one fact — and widening the inert one
 * would have changed nothing while looking like it had.
 */
const OBJECT_HELPERS_YIELDING_ELEMENTS = new Set(['entries', 'values', 'keys']);

function parse(text) {
  return ts.createSourceFile(
    'observability-index.ts',
    text,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
}

function eachNode(node, visit) {
  visit(node);
  node.forEachChild((child) => eachNode(child, visit));
}

/** Strips the wrappers that carry a value through unchanged. */
function unwrap(node) {
  let current = node;
  for (;;) {
    if (
      ts.isParenthesizedExpression(current) ||
      ts.isAwaitExpression(current) ||
      ts.isNonNullExpression(current) ||
      ts.isAsExpression(current) ||
      ts.isSatisfiesExpression(current) ||
      ts.isTypeAssertionExpression(current)
    ) {
      current = current.expression;
      continue;
    }
    return current;
  }
}

function isAccess(node) {
  return ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node);
}

function isFunctionLike(node) {
  return (
    ts.isFunctionDeclaration(node) ||
    ts.isArrowFunction(node) ||
    ts.isFunctionExpression(node) ||
    ts.isMethodDeclaration(node) ||
    ts.isConstructorDeclaration(node) ||
    ts.isGetAccessorDeclaration(node) ||
    ts.isSetAccessorDeclaration(node)
  );
}

function isExported(node) {
  return (ts.getCombinedModifierFlags(node) & ts.ModifierFlags.Export) !== 0;
}

/** The literal property name an access reads, or `null` when it is computed. */
function accessedName(node) {
  if (ts.isPropertyAccessExpression(node)) return node.name.text;
  const argument = node.argumentExpression;
  if (argument === undefined) return null;
  if (ts.isStringLiteralLike(argument)) return argument.text;
  if (ts.isNumericLiteral(argument)) return argument.text;
  return null;
}

function boundNames(name, into) {
  if (ts.isIdentifier(name)) {
    into.push(name.text);
    return into;
  }
  if (ts.isObjectBindingPattern(name) || ts.isArrayBindingPattern(name)) {
    for (const element of name.elements) {
      if (ts.isBindingElement(element)) boundNames(element.name, into);
    }
  }
  return into;
}

function enclosingFunctionName(node) {
  for (let current = node.parent; current !== undefined; current = current.parent) {
    if (ts.isFunctionDeclaration(current) && current.name !== undefined) {
      return current.name.text;
    }
    if (
      (ts.isArrowFunction(current) || ts.isFunctionExpression(current)) &&
      ts.isVariableDeclaration(current.parent) &&
      ts.isIdentifier(current.parent.name)
    ) {
      return current.parent.name.text;
    }
    // `{ handler: (opts) => … }` — an arrow bound to a property has a name just
    // as much as one bound to a const, and without this its reads are attributed
    // to `<module>`, which the probe filter then drops.
    if (
      (ts.isArrowFunction(current) || ts.isFunctionExpression(current)) &&
      ts.isPropertyAssignment(current.parent) &&
      ts.isIdentifier(current.parent.name)
    ) {
      return current.parent.name.text;
    }
    if (
      (ts.isMethodDeclaration(current) || ts.isGetAccessorDeclaration(current) ||
        ts.isSetAccessorDeclaration(current)) &&
      ts.isIdentifier(current.name)
    ) {
      return current.name.text;
    }
  }
  return '<module>';
}

/* -------------------------------------------------------------------------- */
/* The analysis                                                                */
/* -------------------------------------------------------------------------- */

/**
 * Collects the file's own functions by the name they are called through — a
 * declaration, or a const bound to an arrow. The second form is what makes an
 * `own`-style alias resolve to `ownValue` instead of looking like an unknown
 * call.
 */
function collectFunctions(sourceFile) {
  const functions = new Map();
  eachNode(sourceFile, (node) => {
    if (ts.isFunctionDeclaration(node) && node.name !== undefined) {
      functions.set(node.name.text, node);
      return;
    }
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.initializer !== undefined &&
      (ts.isArrowFunction(node.initializer) || ts.isFunctionExpression(node.initializer))
    ) {
      functions.set(node.name.text, node.initializer);
    }
  });
  return functions;
}

function analyse(sourceFile) {
  const functions = collectFunctions(sourceFile);
  /** scope node → name → descriptor */
  const bindings = new Map();
  /** function name → descriptor of what calling it yields */
  const returns = new Map();
  /** parameter/variable node → descriptor of the OBJECT it destructures */
  const patternSources = new Map();
  let changed = true;

  const scopeOf = (node) => {
    for (let current = node.parent; current !== undefined; current = current.parent) {
      if (isFunctionLike(current)) return current;
    }
    return sourceFile;
  };

  const declaringScope = (node, name) => {
    let scope = scopeOf(node);
    for (;;) {
      if (bindings.get(scope)?.has(name) === true) return scope;
      if (scope === sourceFile) return null;
      scope = scopeOf(scope);
    }
  };

  const lookup = (node, name) => {
    const scope = declaringScope(node, name);
    return scope === null ? clean() : bindings.get(scope).get(name);
  };

  const record = (map, key, descriptor) => {
    const previous = map.get(key);
    const next = truncate(previous === undefined ? descriptor : join(previous, descriptor));
    if (previous !== undefined && descriptorKey(previous) === descriptorKey(next)) return;
    map.set(key, next);
    changed = true;
  };

  const bind = (scope, name, descriptor) => {
    if (!bindings.has(scope)) bindings.set(scope, new Map());
    record(bindings.get(scope), name, descriptor);
  };

  const argumentsCarryCallerData = (call, depth) =>
    call.arguments.some((argument) => taintOf(argument, depth + 1).self);

  const taintOf = (node, depth = 0) => {
    const expression = unwrap(node);

    if (ts.isIdentifier(expression)) return lookup(expression, expression.text);

    if (isAccess(expression)) {
      const base = taintOf(expression.expression, depth + 1);
      const name = accessedName(expression);
      if (name === null || /^[0-9]+$/.test(name)) return elementOf(base);
      return fieldOf(base, name);
    }

    if (ts.isObjectLiteralExpression(expression)) {
      let descriptor = clean();
      if (depth >= MAX_FIELD_DEPTH) return descriptor;
      for (const property of expression.properties) {
        if (ts.isSpreadAssignment(property)) {
          // `{ ...caller }` copies own enumerable properties into a FRESH object
          // — whose prototype is `Object.prototype` all the same, so a field the
          // source did not own is still supplied by the chain on the way out.
          descriptor = join(descriptor, taintOf(property.expression, depth + 1));
          continue;
        }
        if (ts.isPropertyAssignment(property) && !ts.isComputedPropertyName(property.name)) {
          descriptor.fields.set(
            property.name.text,
            taintOf(property.initializer, depth + 1),
          );
          continue;
        }
        if (ts.isShorthandPropertyAssignment(property)) {
          descriptor.fields.set(
            property.name.text,
            lookup(property.name, property.name.text),
          );
        }
      }
      return descriptor;
    }

    if (ts.isArrayLiteralExpression(expression)) {
      const element = expression.elements.reduce(
        (accumulated, entry) =>
          join(
            accumulated,
            ts.isSpreadElement(entry)
              ? elementOf(taintOf(entry.expression, depth + 1))
              : taintOf(entry, depth + 1),
          ),
        clean(),
      );
      return { self: false, fields: new Map([[ELEMENT, element]]) };
    }

    if (ts.isConditionalExpression(expression)) {
      return join(
        taintOf(expression.whenTrue, depth),
        taintOf(expression.whenFalse, depth),
      );
    }

    if (ts.isBinaryExpression(expression)) {
      const operator = expression.operatorToken.kind;
      const carries =
        operator === ts.SyntaxKind.QuestionQuestionToken ||
        operator === ts.SyntaxKind.BarBarToken ||
        operator === ts.SyntaxKind.AmpersandAmpersandToken;
      if (!carries) return clean();
      return join(taintOf(expression.left, depth), taintOf(expression.right, depth));
    }

    if (ts.isNewExpression(expression)) {
      const self = (expression.arguments ?? []).some(
        (argument) => taintOf(argument, depth + 1).self,
      );
      return { self, fields: new Map() };
    }

    if (ts.isCallExpression(expression)) {
      const callee = unwrap(expression.expression);
      const [firstArgument] = expression.arguments;

      if (ts.isPropertyAccessExpression(callee)) {
        if (ts.isIdentifier(callee.expression) && callee.expression.text === 'Object') {
          const helper = callee.name.text;
          const argument =
            firstArgument === undefined ? clean() : taintOf(firstArgument, depth + 1);
          // `entries`, `values` and `keys` hand back an ARRAY of the caller's
          // values; `getOwnPropertyDescriptor` hands back a fresh wrapper whose
          // `value` is one of them, and collapsing the two is how this walker
          // once laundered every own read in the file.
          if (OBJECT_HELPERS_YIELDING_ELEMENTS.has(helper)) {
            return { self: false, fields: new Map([[ELEMENT, argument]]) };
          }
          if (helper === 'getOwnPropertyDescriptor') {
            return { self: argument.self, fields: new Map() };
          }
          // `fromEntries` BUILDS a container with CreateDataProperty, exactly
          // as an object literal does — so the container is fresh. Its VALUES
          // are the second half of each pair it was handed, and a caller's
          // object arriving that way is republished under this layer's own key
          // and then read off again. Tuple positions are joined here, so the
          // element OF the element is exactly those values.
          if (helper === 'fromEntries') {
            return { self: elementOf(elementOf(argument)).self, fields: new Map() };
          }
          // Anything else is unknown, and the unknown answer is "still caller
          // data" — `Object.freeze(caller)` hands back the same object, and a
          // helper this walker has not been taught must not launder by default.
          //
          // EVERY argument, not the first one. `Object.assign({}, caller)` is
          // `{ ...caller }` written differently, with the caller in position
          // two — reading only position one laundered it while the spelling one
          // line away was reported, which is the shape of hole that makes an
          // audit worth less than no audit.
          const carried = expression.arguments.reduce(
            (accumulated, argumentNode) =>
              join(accumulated, taintOf(argumentNode, depth + 1)),
            clean(),
          );
          return {
            self: carried.self || elementOf(carried).self,
            fields: carried.fields,
          };
        }
        // A method called ON caller data hands back caller data: `records.map`,
        // `experiments.slice`, `client.createDataset`.
        // `slice`, `entries`, `filter` and friends hand back the receiver's
        // elements; `map` hands back the callback's, and treating those as the
        // receiver's is the conservative direction.
        const receiver = taintOf(callee.expression, depth + 1);
        let element = elementOf(receiver);
        // `map` hands back what its CALLBACK returns, and reading only the
        // receiver's elements loses a projection built inside one — or a
        // caller's object handed straight back out of one.
        if (
          (callee.name.text === 'map' || callee.name.text === 'flatMap') &&
          depth < MAX_FIELD_DEPTH
        ) {
          for (const argument of expression.arguments) {
            const callback = unwrap(argument);
            if (!ts.isArrowFunction(callback) && !ts.isFunctionExpression(callback)) continue;
            for (const returned of returnedExpressions(callback)) {
              element = join(element, taintOf(returned, depth + 1));
            }
          }
        }
        const elements = new Map([[ELEMENT, element]]);
        if (receiver.self) return { self: true, fields: elements };
        // A helper on some OTHER namespace — `Reflect.get`, `structuredClone`,
        // `Array.from` — is not modelled, and `Reflect.get` walks the prototype
        // chain, so an unmodelled helper handed caller data hands caller data
        // back. Failing toward reporting is the only safe default here.
        return { self: argumentsCarryCallerData(expression, depth), fields: elements };
      }

      if (ts.isIdentifier(callee)) {
        // A function this file declares is answered by its OWN return analysis,
        // even in the rounds before that answer exists — guessing "caller data"
        // for it would be joined in permanently, since the fixpoint only grows.
        if (functions.has(callee.text)) return returns.get(callee.text) ?? clean();
        return { self: argumentsCarryCallerData(expression, depth), fields: new Map() };
      }
      return clean();
    }

    return clean();
  };

  /** The expressions a function hands back. */
  const returnedExpressions = (fn) => {
    if (ts.isArrowFunction(fn) && fn.body !== undefined && !ts.isBlock(fn.body)) {
      return [fn.body];
    }
    const returned = [];
    const walk = (node) => {
      if (node !== fn && isFunctionLike(node)) return;
      if (ts.isReturnStatement(node) && node.expression !== undefined) {
        returned.push(node.expression);
      }
      node.forEachChild(walk);
    };
    if (fn.body !== undefined) fn.body.forEachChild(walk);
    return returned;
  };

  /** Hands `descriptor` to one parameter, matching an object pattern by name. */
  const handToParameter = (parameter, fn, descriptor) => {
    record(patternSources, parameter, descriptor);
    if (ts.isIdentifier(parameter.name)) {
      bind(fn, parameter.name.text, descriptor);
      return;
    }
    if (ts.isObjectBindingPattern(parameter.name)) {
      for (const element of parameter.name.elements) {
        const key = element.propertyName ?? element.name;
        const name = ts.isIdentifier(key) || ts.isStringLiteralLike(key) ? key.text : null;
        const field = name === null ? descriptor : fieldOf(descriptor, name);
        for (const bound of boundNames(element.name, [])) bind(fn, bound, field);
      }
      return;
    }
    for (const bound of boundNames(parameter.name, [])) {
      bind(fn, bound, { self: descriptor.self, fields: new Map() });
    }
  };

  // 🔴 The local names a trailing `export { … }` clause exports.
  //
  // `isExported` reads `ModifierFlags.Export` off the DECLARATION, and an export
  // clause leaves no modifier there — so seeding on that test alone made a
  // callable exported this way invisible to the walker. Measured in AIC-82: a
  // style refactor that moved this layer's four exports into one clause, without
  // changing a single read, took the audit to zero violations while two reverted
  // own reads sat in the file. `propertyName ?? name` is the LOCAL binding —
  // in `export { local as public }` the declaration to seed is `local`.
  //
  // Bounded by construction: one pass over the tree, and the set is built once
  // rather than per round.
  const exportListNames = new Set();
  eachNode(sourceFile, (node) => {
    if (!ts.isExportDeclaration(node) || node.moduleSpecifier !== undefined) return;
    const clause = node.exportClause;
    if (clause === undefined || !ts.isNamedExports(clause)) return;
    for (const specifier of clause.elements) {
      exportListNames.add((specifier.propertyName ?? specifier.name).text);
    }
  });

  // A declaration is a caller entry point when it carries the `export` modifier
  // OR when an export clause names it. Both halves are load-bearing; dropping
  // either one is the defect above, in one of its two directions.
  const isEntryPoint = (node) =>
    isExported(node) ||
    (node.name !== undefined && ts.isIdentifier(node.name) && exportListNames.has(node.name.text));

  // The round cap is a safety net, not the termination argument — the finite
  // lattice is (see coarsening 5). It is asserted rather than trusted: a file
  // that has not converged when the cap is reached has UNDER-propagated taint,
  // so the audit would report fewer violations and go quietly green. That is the
  // one way this check dies without anything turning red.
  const MAX_ROUNDS = 24;
  let round = 0;
  for (; round < MAX_ROUNDS && changed; round += 1) {
    changed = false;

    // Caller data enters here, and only here — at every form the module can
    // export a callable in, not at one of them. `export function f(o)` and
    // `export const f = (o) => …` are the same surface to a caller, and seeding
    // only the first meant a style refactor silently emptied this audit.
    eachNode(sourceFile, (node) => {
      const seed = (fn) => {
        for (const parameter of fn.parameters) {
          handToParameter(parameter, fn, callerData());
        }
      };
      if (ts.isFunctionDeclaration(node) && isEntryPoint(node)) {
        seed(node);
        return;
      }
      if (
        ts.isVariableDeclaration(node) &&
        isEntryPoint(node) &&
        node.initializer !== undefined &&
        (ts.isArrowFunction(node.initializer) || ts.isFunctionExpression(node.initializer))
      ) {
        seed(node.initializer);
        return;
      }
      // An exported object literal is an entry point per callable it carries.
      // `export const persistence = { async persistOne(options) { … } }` is the
      // same surface to a caller as `export async function persistOne(options)`,
      // and seeding only the second let a NEW entry point in this style carry an
      // unprojected read with the whole audit green — which is the ADDITION case
      // this file exists for, not a regression any behavioural test would catch.
      if (
        ts.isVariableDeclaration(node) &&
        isEntryPoint(node) &&
        node.initializer !== undefined &&
        ts.isObjectLiteralExpression(node.initializer)
      ) {
        for (const property of node.initializer.properties) {
          if (isFunctionLike(property)) {
            seed(property);
            continue;
          }
          if (
            ts.isPropertyAssignment(property) &&
            (ts.isArrowFunction(property.initializer) ||
              ts.isFunctionExpression(property.initializer))
          ) {
            seed(property.initializer);
          }
        }
        return;
      }
      if (ts.isClassDeclaration(node) && isEntryPoint(node)) {
        for (const member of node.members) {
          if (isFunctionLike(member) || ts.isConstructorDeclaration(member)) {
            seed(member);
            continue;
          }
          if (
            ts.isPropertyDeclaration(member) &&
            member.initializer !== undefined &&
            (ts.isArrowFunction(member.initializer) ||
              ts.isFunctionExpression(member.initializer))
          ) {
            seed(member.initializer);
          }
        }
      }
    });

    // …and spreads by argument, into the file's own functions.
    eachNode(sourceFile, (node) => {
      if (!ts.isCallExpression(node)) return;
      const callee = unwrap(node.expression);

      if (ts.isIdentifier(callee)) {
        const fn = functions.get(callee.text);
        if (fn === undefined) return;
        fn.parameters.forEach((parameter, index) => {
          const argument = node.arguments[index];
          if (argument === undefined) return;
          handToParameter(parameter, fn, taintOf(argument));
        });
        return;
      }

      // An inline callee — `(o => o.field)(caller)` — is this file's own
      // function as much as a named one is, and its parameters take the
      // argument at the same index. Without this the read inside it was
      // silent, and unlike the blind spots below it is not a function this
      // walker cannot RESOLVE: it is right there in the call.
      if (ts.isArrowFunction(callee) || ts.isFunctionExpression(callee)) {
        callee.parameters.forEach((parameter, index) => {
          const argument = node.arguments[index];
          if (argument === undefined) return;
          handToParameter(parameter, callee, taintOf(argument));
        });
        return;
      }

      if (!ts.isPropertyAccessExpression(callee)) return;

      // `records.push(x)` is how this file fills a fresh array, and an audit
      // that cannot see it declares every array it builds empty — and therefore
      // clean, whatever was put in it.
      if (callee.name.text === 'push' || callee.name.text === 'unshift') {
        const receiver = unwrap(callee.expression);
        if (ts.isIdentifier(receiver)) {
          const scope = declaringScope(receiver, receiver.text);
          if (scope !== null) {
            const element = node.arguments.reduce(
              (accumulated, argument) =>
                join(
                  accumulated,
                  ts.isSpreadElement(argument)
                    ? elementOf(taintOf(argument.expression))
                    : taintOf(argument),
                ),
              clean(),
            );
            bind(scope, receiver.text, {
              self: false,
              fields: new Map([[ELEMENT, element]]),
            });
          }
        }
      }

      // A callback over an array receives its elements, one at a time.
      const element = elementOf(taintOf(callee.expression));
      for (const argument of node.arguments) {
        const fn = unwrap(argument);
        if (!ts.isArrowFunction(fn) && !ts.isFunctionExpression(fn)) continue;
        for (const parameter of fn.parameters) {
          handToParameter(parameter, fn, element);
        }
      }
    });

    eachNode(sourceFile, (node) => {
      // `let alias;` carries no value yet, but it establishes WHERE the name
      // lives, so the assignment below lands in the right scope rather than
      // inventing a binding in the one that happens to contain the statement.
      if (ts.isVariableDeclaration(node) && node.initializer === undefined) {
        for (const bound of boundNames(node.name, [])) {
          bind(scopeOf(node), bound, clean());
        }
        return;
      }

      // `alias = caller`. Modelling declarations alone meant a name was only
      // ever what it was born with, and the two-line detour through an
      // assignment read as clean for the rest of the function.
      if (
        ts.isBinaryExpression(node) &&
        ASSIGNMENT_OPERATORS.has(node.operatorToken.kind) &&
        ts.isIdentifier(node.left)
      ) {
        const scope = declaringScope(node.left, node.left.text) ?? scopeOf(node);
        bind(scope, node.left.text, taintOf(node.right));
        return;
      }

      if (ts.isVariableDeclaration(node) && node.initializer !== undefined) {
        const descriptor = taintOf(node.initializer);
        const scope = scopeOf(node);
        if (ts.isIdentifier(node.name)) {
          bind(scope, node.name.text, descriptor);
          return;
        }
        record(patternSources, node, descriptor);
        if (ts.isObjectBindingPattern(node.name)) {
          for (const element of node.name.elements) {
            const key = element.propertyName ?? element.name;
            const name =
              ts.isIdentifier(key) || ts.isStringLiteralLike(key) ? key.text : null;
            const field = name === null ? descriptor : fieldOf(descriptor, name);
            for (const bound of boundNames(element.name, [])) bind(scope, bound, field);
          }
          return;
        }
        for (const bound of boundNames(node.name, [])) {
          bind(scope, bound, { self: descriptor.self, fields: new Map() });
        }
        return;
      }

      if (ts.isForInStatement(node) && ts.isVariableDeclarationList(node.initializer)) {
        const key = { self: taintOf(node.expression).self, fields: new Map() };
        for (const declaration of node.initializer.declarations) {
          for (const bound of boundNames(declaration.name, [])) {
            bind(scopeOf(node), bound, key);
          }
        }
        return;
      }

      if (ts.isForOfStatement(node) && ts.isVariableDeclarationList(node.initializer)) {
        const element = elementOf(taintOf(node.expression));
        const scope = scopeOf(node);
        for (const declaration of node.initializer.declarations) {
          if (ts.isObjectBindingPattern(declaration.name)) {
            record(patternSources, declaration, element);
          }
          for (const bound of boundNames(declaration.name, [])) {
            bind(scope, bound, element);
          }
        }
      }
    });

    for (const [name, fn] of functions) {
      const descriptor = returnedExpressions(fn).reduce(
        (accumulated, expression) => join(accumulated, taintOf(expression)),
        clean(),
      );
      record(returns, name, descriptor);
    }
  }

  if (changed) {
    throw new Error(
      `the taint fixpoint did not converge in ${MAX_ROUNDS} rounds. It is stopping short, which means it has propagated LESS than the file demands and this audit would report fewer violations than exist. Raise the cap only after establishing why the lattice grew.`,
    );
  }

  return { taintOf, patternSources };
}

/* -------------------------------------------------------------------------- */
/* The report                                                                  */
/* -------------------------------------------------------------------------- */

function position(sourceFile, node) {
  const { line, character } = ts.getLineAndCharacterOfPosition(
    sourceFile,
    node.getStart(sourceFile),
  );
  return { line: line + 1, column: character + 1 };
}

function oneLine(text) {
  const collapsed = text.replace(/\s+/g, ' ').trim();
  return collapsed.length > 80 ? `${collapsed.slice(0, 77)}…` : collapsed;
}

/**
 * Every read of caller-supplied data in `text` that does not go through
 * `ownValue`, innermost-first and one per chain: `experiment.records.length`
 * reports `experiment.records`, because that is the read the fix replaces.
 */
function auditReads(text) {
  const sourceFile = parse(text);
  const { taintOf, patternSources } = analyse(sourceFile);
  const violations = [];

  const report = (node, expression) => {
    const { line, column } = position(sourceFile, node);
    violations.push({
      line,
      column,
      expression,
      fn: enclosingFunctionName(node),
      pos: node.getStart(sourceFile),
    });
  };

  const reportPattern = (pattern, node) => {
    const source = patternSources.get(node);
    if (source === undefined || !source.self) return;
    for (const element of pattern.elements) {
      const key = element.propertyName ?? element.name;
      report(element, `{…}.${oneLine(key.getText(sourceFile))}`);
    }
  };

  eachNode(sourceFile, (node) => {
    if (isAccess(node)) {
      if (!taintOf(node.expression).self) return;
      // Method dispatch, not a data read (coarsening 2).
      if (ts.isCallExpression(node.parent) && unwrap(node.parent.expression) === node) {
        return;
      }
      // One report per chain: if the base is itself a reported read, the fix
      // there is the fix here.
      const base = unwrap(node.expression);
      if (isAccess(base) && taintOf(base.expression).self) return;
      report(node, oneLine(node.getText(sourceFile)));
      return;
    }

    // `for (const key in caller)` needs no property access to be a chain walk:
    // the ENUMERATION itself yields inherited enumerable keys, so the loop is
    // the violation. `Object.keys` is the own-only form.
    if (ts.isForInStatement(node) && taintOf(node.expression).self) {
      report(
        node.expression,
        `for…in ${oneLine(node.expression.getText(sourceFile))}`,
      );
      return;
    }

    if (ts.isParameter(node) && ts.isObjectBindingPattern(node.name)) {
      reportPattern(node.name, node);
      return;
    }

    if (ts.isVariableDeclaration(node) && ts.isObjectBindingPattern(node.name)) {
      reportPattern(node.name, node);
    }
  });

  return violations.sort((left, right) => left.pos - right.pos);
}

function matchesExemption(violation, exemption) {
  return violation.fn === exemption.fn && violation.expression === exemption.expression;
}

function unexemptedReads(text) {
  return auditReads(text).filter(
    (violation) =>
      !DECLARED_EXEMPTIONS.some((exemption) => matchesExemption(violation, exemption)),
  );
}

function formatViolations(violations) {
  return violations
    .map(({ line, column, expression }) => `${line}:${column}  ${expression}`)
    .join('\n');
}

/* -------------------------------------------------------------------------- */
/* The audit                                                                   */
/* -------------------------------------------------------------------------- */

/** Every TypeScript source the observability layer ships, relative to its root. */
function layerSources(directory = auditedLayer) {
  const found = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = joinPath(directory, entry.name);
    if (entry.isDirectory()) found.push(...layerSources(path));
    else if (/\.(?:ts|mts|cts|tsx)$/.test(entry.name)) found.push(relative(auditedLayer, path));
  }
  return found.sort();
}

/**
 * Every callable a caller can reach from this layer, taken from the BUILT
 * module rather than from its text.
 *
 * 🔴 **Why this is a runtime list and not another AST walk.** AIC-82 spent five
 * review rounds trying to decide, from the source text, which callables a caller
 * can reach. Each attempt closed the export spellings it knew and the next round
 * measured another one reaching a caller with the suite green; the last attempt
 * added a walk that resolved names with a flat, unscoped map, so an unrelated
 * local sharing a name silently redirected it, and reading the callee of a call
 * made it report module-local helpers as exported. Deciding this from syntax
 * needs scope-aware name resolution — a type checker — which is the wrong price
 * for a test.
 *
 * The built module already knows the answer exactly. `export { f }`, a barrel, a
 * spread, a frozen object, a factory's return, `export default` — every spelling
 * collapses to the same thing once the module has run: a value on the namespace
 * object. So this asks the module.
 *
 * What it buys is narrow and worth stating exactly. It does NOT prove a callable
 * is seeded. It proves two things: the layer's export NAMES are unchanged, and
 * the callables reachable from them by enumerating own properties down to a
 * depth of four are unchanged. A new export in any spelling turns this red
 * whatever it holds, and the person who added it then has to decide,
 * deliberately, whether the seeding above reaches it — the decision that was
 * being made silently and wrongly. A callable hung under an EXISTING export name
 * is outside both halves; that limit is in the blind-spot list above, with the
 * measurements behind it.
 *
 * ⚠ It reads `dist`, so it is only as fresh as the last build — and `npm test`,
 * the repo's own script for the whole suite, does NOT build. Measured: add an
 * export, skip the rebuild, and this test stays green. `npm run check` and CI
 * both build first, so the false green is transient rather than shipped, but the
 * window is any run that did not build, not just this file run alone.
 *
 * It imports the built layer in-process, as six other suites already do —
 * `metric-path-prototype-safety`, `persist-boundary-refusals`,
 * `behavior-evaluators`, `benchmark-evaluation`, `benchmark-resource-evidence`
 * and `langsmith-tracing` — and `dist/index.js` imports `langsmith` on its first
 * line, so neither the layer nor that dependency arrives here first. Measured at
 * import: no network call and no credential-shaped environment read, because the
 * client is referenced and never constructed.
 *
 * The two expected lists below are what the test compares against; the walk
 * itself is `reachableCallables`, further down.
 */
const EXPECTED_EXPORT_NAMES = [
  'OBSERVABILITY_LAYER',
  'createLangSmithClient',
  'persistBenchmarkExperiment',
  'persistBenchmarkExperiments',
  'resolveTracingConfig',
];

const EXPECTED_REACHABLE_CALLABLES = [
  'createLangSmithClient',
  'persistBenchmarkExperiment',
  'persistBenchmarkExperiments',
  'resolveTracingConfig',
];

const reachableCallables = async () => {
  const layer = await import('../packages/observability/dist/index.js');
  const found = [];
  const seen = new Set();
  // Bounded: depth-capped and cycle-guarded. ⚠ Both bounds find FEWER callables
  // than the layer really holds, which is why the export NAMES are asserted
  // separately above — that half does not depend on reaching anything. The
  // depth cap, and the fact that a function is recorded without enumerating its
  // own properties, are stated in the blind-spot list at the top of this file
  // under "a callable hung under an EXISTING export name".
  const visit = (value, path, depth) => {
    if (depth > 4 || value === null) return;
    const kind = typeof value;
    if (kind === 'function') {
      found.push(path);
      return;
    }
    if (kind !== 'object' || seen.has(value)) return;
    seen.add(value);
    for (const [key, child] of Object.entries(value)) visit(child, `${path}.${key}`, depth + 1);
    if (value instanceof Map) {
      for (const [key, child] of value) visit(child, `${path}[${String(key)}]`, depth + 1);
    }
    if (value instanceof Set) {
      let index = 0;
      for (const child of value) visit(child, `${path}[${index++}]`, depth + 1);
    }
  };
  for (const [name, value] of Object.entries(layer)) visit(value, name, 0);
  return found.sort();
};

test('reaches no callable this audit was not told about', async () => {
  // 🔴 The NAMES are asserted as well as the callables, and that is not
  // belt-and-braces. The callable walk records only functions, so an export
  // whose callables sit deeper than the depth cap, or behind a
  // non-enumerable property, contributes NO entry — and an exact-set
  // comparison of callables alone stays green while a caller reaches
  // `deep.a.b.c.d.persist`. Measured, on this layer, before this line existed.
  // Comparing the names closes both: a new export is red whatever it holds,
  // which is the property the header claims.
  const layer = await import('../packages/observability/dist/index.js');
  assert.deepEqual(
    Object.keys(layer).sort(),
    EXPECTED_EXPORT_NAMES,
    'this layer exports a name this audit was not told about.\nAdd it here only once you have decided the question this test exists to force: does the seeding hand caller data to whatever callable it puts within a caller\'s reach?\nA callable can hide from the reachability walk below — too deep, or non-enumerable — so the name list is the half that cannot be slipped past.',
  );

  assert.deepEqual(
    await reachableCallables(),
    EXPECTED_REACHABLE_CALLABLES,
    'the set of callables a caller can reach from this layer changed.\nThat is not a failure by itself — it is the moment to decide something that used to be decided silently: does the seeding above hand caller data to the new one?\nIf it does, add the name here. If it does not, seed the form it is written in, or declare it in the blind-spot list at the top of this file with the reason.\nAIC-82 exists because a callable arrived through a spelling the seeding did not know, and every read inside it was judged clean.',
  );
});

test('audits every source file the observability layer has', () => {
  assert.deepEqual(
    layerSources(),
    ['index.ts'],
    'this audit reads ONE hard-coded file. A second source file in this layer would be audited by nothing, while this file\'s header still read as though the layer were covered — audit the new file too, or glob the directory. Do not delete this assertion: it is the only thing that makes "the observability layer" in the sentence above mean the layer.',
  );
});

test('reads every caller-supplied field of the observability layer through ownValue', () => {
  const violations = unexemptedReads(auditedSource);

  assert.equal(
    violations.length,
    0,
    `packages/observability/src/index.ts reads caller-supplied data with a plain [[Get]] in ${violations.length} place(s).\n` +
      'Each one lets a polluted Object.prototype supply a value the caller never declared. ' +
      'Use ownValue(target, key), or declare an exemption with a reason in DECLARED_EXEMPTIONS.\n\n' +
      `${formatViolations(violations)}\n`,
  );
});

test('declares no exemption the audit no longer needs', () => {
  const violations = auditReads(auditedSource);
  const stale = DECLARED_EXEMPTIONS.filter(
    (exemption) => !violations.some((violation) => matchesExemption(violation, exemption)),
  ).map((exemption) => `${exemption.fn}: ${exemption.expression}`);

  assert.deepEqual(
    stale,
    [],
    'an exemption that matches nothing is cover a reader will believe and the audit no longer gives — delete it',
  );
});

test('states a reason for every exemption it declares', () => {
  const reasonless = DECLARED_EXEMPTIONS.filter(
    (exemption) => typeof exemption.why !== 'string' || exemption.why.trim().length === 0,
  ).map((exemption) => `${exemption.fn}: ${exemption.expression}`);

  assert.deepEqual(
    reasonless,
    [],
    'an exemption without a reason is an unexplained hole in the audit',
  );
});

/* -------------------------------------------------------------------------- */
/* The audit's own teeth                                                       */
/* -------------------------------------------------------------------------- */

/**
 * The planted reads, appended to the parsed TEXT only — the file on disk is never
 * touched. Their exact set is `EXPECTED_PROBE_REPORTS` below, which is also
 * where the count lives; a number spelled here as well would be a second
 * spelling of one fact, and it was wrong within two rounds of being written.
 *
 * Every precision rule the walker gained to stop reporting projections is a rule
 * that could be widened until nothing is reported at all, so each one is pinned
 * here by a read it must still catch:
 *
 *   - a plain read on an exported function's own parameter;
 *   - a plain read inside an INTERNAL function that a caller hands caller data
 *     to (argument-to-parameter propagation);
 *   - a plain read THROUGH a projection's passthrough field (field tracking);
 *   - the same, where the projection reached the reader inside an array it was
 *     pushed onto — the array machinery laundered every own read in the file
 *     once, silently, and this is what caught it;
 *   - a read inside an exported const arrow, and inside a method of an exported
 *     class: rewriting `export function f(o)` as `export const f = (o) => …` is
 *     a style refactor, and while the seeding named only the declaration form it
 *     emptied this whole audit without changing a single read;
 *   - a read after `Object.freeze`, after an object spread, and the enumeration
 *     in `for (const k in caller)` — the three shapes that look like copies and
 *     are not;
 *
 * and the honest side — an `ownValue` read, and an internal function that is
 * only ever handed a freshly built local object — must stay unreported.
 */
const TEETH_PROBE = `

export function auditTeethProbe(supplied: Readonly<Record<string, unknown>>): unknown {
  const hazard = supplied.plantedByTheTeethProbe;
  const honest = ownValue(supplied, 'plantedByTheTeethProbe');
  const sunk = auditTeethSink(supplied);
  const projected = auditTeethProjection(supplied);
  const deep = projected.raw.plantedBehindTheProjection;
  const fresh = auditTeethHonestSink({ plantedInAFreshLiteral: 1 });
  const collected = auditTeethArraySink(supplied);
  const shorthand = auditTeethShorthandSink(supplied) as { plantedThroughAShorthandField?: unknown };
  const bundledRead = shorthand.plantedThroughAShorthandField;
  return [hazard, honest, sunk, deep, fresh, collected, bundledRead];
}

function auditTeethArraySink(supplied: unknown): unknown {
  const collected: Readonly<{ raw: unknown }>[] = [];
  collected.push(auditTeethProjection(supplied));
  for (const entry of collected) {
    ownValue(entry.raw, 'plantedBehindAnIteration');
    void entry.raw.plantedBehindAnIteration;
  }
  const first = collected[0];
  return first === undefined ? undefined : first.raw.plantedBehindAnArray;
}

function auditTeethSink(handed: Readonly<Record<string, unknown>>): unknown {
  return handed.plantedInTheInternalSink;
}

function auditTeethProjection(source: unknown): Readonly<{ raw: unknown }> {
  return { raw: ownValue(source, 'raw') };
}

/**
 * The SHORTHAND spelling of an object literal, which had no probe of its own.
 *
 * A shorthand field and a written-out one are the same operation, and only the
 * written-out spelling was planted — so the branch could be deleted with every
 * test green while the audited file leans on it: the object requireExperiment
 * returns, and the one persistBenchmarkExperiments hands to
 * persistPreparedExperiment, are both shorthand, and they are what carry caller
 * data into the function that publishes every run and every feedback.
 */
function auditTeethShorthandSink(carried: unknown): unknown {
  const bundled = { carried };
  return bundled.carried;
}

function auditTeethHonestSink(local: Readonly<{ plantedInAFreshLiteral: number }>): unknown {
  return local.plantedInAFreshLiteral;
}

export function auditTeethDestructuredFieldProbe(
  opts: Readonly<Record<string, unknown>>,
): unknown {
  return auditTeethDestructuredFieldSink({ carried: ownValue(opts, 'carried') });
}

function auditTeethDestructuredFieldSink({
  carried,
}: Readonly<{ carried: unknown }>): unknown {
  return carried.plantedThroughADestructuredField;
}

export function auditTeethOwnIterationProbe(
  opts: Readonly<Record<string, unknown>>,
): unknown {
  const values = Object.values(opts);
  return values.length;
}

export function auditTeethContainerProbe(opts: Readonly<Record<string, unknown>>): unknown {
  const keys = ['alpha'];
  const mapped = keys.map((key) => ({ raw: ownValue(opts, key) }));
  const firstMapped = mapped[0];
  const built = Object.fromEntries(keys.map((key) => [key, ownValue(opts, key)]));
  return [
    firstMapped.raw.plantedThroughAMapCallback,
    built.plantedThroughAFromEntriesContainer,
  ];
}

export function auditTeethDestructureProbe({
  plantedByDestructuring,
  renamed: alsoPlanted,
}: Readonly<{ plantedByDestructuring: unknown; renamed: unknown }>): unknown {
  return [plantedByDestructuring, alsoPlanted];
}

export function auditTeethLogicalAssignmentProbe(
  opts: Readonly<Record<string, unknown>>,
): unknown {
  let nullish;
  nullish ??= opts;
  let disjunctive;
  disjunctive ||= opts;
  let conjunctive;
  conjunctive &&= opts;
  return [
    nullish.plantedThroughNullishAssignment,
    disjunctive.plantedThroughDisjunctiveAssignment,
    conjunctive.plantedThroughConjunctiveAssignment,
  ];
}

export function auditTeethReceiverProbe(opts: Readonly<Record<string, unknown>>): unknown {
  const items = ownValue(opts, 'items') as unknown[];
  const tail = items.slice(1);
  return tail.plantedBehindAMethodReceiver;
}

export function auditTeethBareHelperProbe(opts: Readonly<Record<string, unknown>>): unknown {
  return structuredClone(opts).plantedBehindABareHelper;
}

export function auditTeethAssignmentProbe(opts: Readonly<Record<string, unknown>>): unknown {
  let alias;
  alias = opts;
  return alias.plantedThroughAnAssignment;
}

export function auditTeethCopyProbe(opts: Readonly<Record<string, unknown>>): unknown {
  const merged = Object.assign({}, opts);
  const created = Object.create(opts);
  const spread = { ...opts };
  return [
    merged.plantedBehindObjectAssign,
    created.plantedBehindObjectCreate,
    spread.plantedBehindSpreadControl,
  ];
}

export function auditTeethDepthProbe(supplied: unknown): unknown {
  const level6 = { raw: ownValue(supplied, 'deep') };
  const level5 = { nested: level6 };
  const level4 = { nested: level5 };
  const level3 = { nested: level4 };
  const level2 = { nested: level3 };
  const level1 = { nested: level2 };
  return level1.nested.nested.nested.nested.nested.raw.plantedSixLevelsDown;
}

export const auditTeethExportedArrow = (
  opts: Readonly<Record<string, unknown>>,
): unknown => opts.plantedOnAnExportedArrow;

export class AuditTeethExportedClass {
  auditTeethMethod(opts: Readonly<Record<string, unknown>>): unknown {
    return opts.plantedOnAnExportedMethod;
  }
}

export function auditTeethLaundering(opts: Readonly<Record<string, unknown>>): unknown {
  const frozen = Object.freeze(opts);
  const copied = { ...opts };
  const enumerated: string[] = [];
  for (const key in opts) {
    enumerated.push(key);
  }
  const reflected = Reflect.get(opts, 'nested');
  return [
    frozen.plantedBehindFreeze,
    copied.plantedBehindSpread,
    reflected.plantedBehindAnUnmodelledHelper,
    enumerated,
  ];
}

function auditTeethExportListProbe(opts: Readonly<Record<string, unknown>>): unknown {
  return opts.plantedInAnExportListCallable;
}

const auditTeethAliasedArrow = (
  opts: Readonly<Record<string, unknown>>,
): unknown => opts.plantedBehindAnExportAlias;

export const auditTeethExportedObject = {
  auditTeethObjectMethod(opts: Readonly<Record<string, unknown>>): unknown {
    return opts.plantedOnAnExportedObjectMethod;
  },
  auditTeethObjectArrow: (opts: Readonly<Record<string, unknown>>): unknown =>
    opts.plantedOnAnExportedObjectArrow,
};

export function auditTeethInlineCalleeProbe(
  opts: Readonly<Record<string, unknown>>,
): unknown {
  return ((inner: Readonly<Record<string, unknown>>) => inner.plantedInAnInlineCallee)(opts);
}

export { auditTeethExportListProbe, auditTeethAliasedArrow as auditTeethAliasedExport };
`;

const PROBE_FUNCTIONS = new Set([
  'auditTeethProbe',
  'auditTeethSink',
  'auditTeethProjection',
  'auditTeethShorthandSink',
  'auditTeethHonestSink',
  'auditTeethArraySink',
  'auditTeethDestructuredFieldProbe',
  'auditTeethDestructuredFieldSink',
  'auditTeethOwnIterationProbe',
  'auditTeethContainerProbe',
  'auditTeethDestructureProbe',
  'auditTeethLogicalAssignmentProbe',
  'auditTeethReceiverProbe',
  'auditTeethBareHelperProbe',
  'auditTeethAssignmentProbe',
  'auditTeethCopyProbe',
  'auditTeethDepthProbe',
  'auditTeethExportedArrow',
  'auditTeethMethod',
  'auditTeethLaundering',
  'auditTeethExportListProbe',
  'auditTeethAliasedArrow',
  'auditTeethObjectMethod',
  'auditTeethObjectArrow',
  'auditTeethInlineCalleeProbe',
]);

/**
 * Every capability of this walker that the header above states as CONTRACT.
 *
 * The rule this list exists to make mechanical: a capability stated in the
 * header has a probe entry naming it, or it is not stated — it belongs in the
 * blind-spot list instead. Rewording is not an exit. Three separate review
 * rounds each found a different capability that worked, that the header
 * promised, and that could be deleted with every test green; they were the same
 * defect three times, because nothing tied the claims to the probe.
 *
 * The two checks below close that in both directions: a capability nothing pins
 * is a claim with no cover, and an entry pinning a name that is not here is a
 * probe that has drifted from what it was written to hold.
 */
const WALKER_CAPABILITIES = [
  'exported-function-declaration',
  'exported-const-arrow',
  'exported-class-method',
  // Forms a caller reaches that the modifier-based test above cannot see. An
  // `export { … }` clause leaves no modifier on the declaration it names, so
  // seeding on `ModifierFlags.Export` alone meant a style refactor emptied this
  // audit without changing a single read — measured, on this file, in AIC-82.
  // `inline-callee-parameters` is the odd one out: a propagation rule rather
  // than an export form, kept here because it is seeded in the same pass.
  'exported-via-export-list',
  'exported-via-aliased-export-list',
  'exported-object-literal-method',
  'exported-object-literal-arrow',
  'inline-callee-parameters',
  'destructured-parameter',
  'argument-to-parameter',
  'return-value',
  'object-literal-fields',
  'array-elements-and-push',
  'for-of-elements',
  'field-depth-six',
  'assignment-equals',
  'assignment-nullish',
  'assignment-disjunctive',
  'assignment-conjunctive',
  'object-spread',
  'object-helper-later-arguments',
  'object-helper-unmodelled',
  'namespaced-helper-unmodelled',
  'bare-identifier-helper',
  'method-receiver',
  'map-callback-return',
  'fromEntries-values',
  'for-in-enumeration',
  'destructured-field-precision',
  // Held by a read that must stay SILENT rather than by a planted one: losing
  // these makes the walker louder, not quieter, so no hazardous read can pin
  // them. `test('leaves the honest reads of the same fields unreported')` is
  // what goes red.
  'own-value-read-is-silent',
  'fresh-local-argument',
  'own-only-iteration',
];

/** Each planted read the probe must report, and the capability it holds. */
const EXPECTED_PROBE_REPORTS = [
  { expression: 'supplied.plantedByTheTeethProbe', pins: ['exported-function-declaration'] },
  { expression: 'handed.plantedInTheInternalSink', pins: ['argument-to-parameter'] },
  {
    expression: 'projected.raw.plantedBehindTheProjection',
    pins: ['return-value', 'object-literal-fields'],
  },
  {
    expression: 'shorthand.plantedThroughAShorthandField',
    pins: ['object-literal-fields'],
  },
  { expression: 'entry.raw.plantedBehindAnIteration', pins: ['for-of-elements'] },
  { expression: 'first.raw.plantedBehindAnArray', pins: ['array-elements-and-push'] },
  { expression: 'alias.plantedThroughAnAssignment', pins: ['assignment-equals'] },
  { expression: 'nullish.plantedThroughNullishAssignment', pins: ['assignment-nullish'] },
  {
    expression: 'disjunctive.plantedThroughDisjunctiveAssignment',
    pins: ['assignment-disjunctive'],
  },
  {
    expression: 'conjunctive.plantedThroughConjunctiveAssignment',
    pins: ['assignment-conjunctive'],
  },
  { expression: '{…}.plantedByDestructuring', pins: ['destructured-parameter'] },
  { expression: '{…}.renamed', pins: ['destructured-parameter'] },
  { expression: 'merged.plantedBehindObjectAssign', pins: ['object-helper-later-arguments'] },
  { expression: 'created.plantedBehindObjectCreate', pins: ['object-helper-unmodelled'] },
  { expression: 'frozen.plantedBehindFreeze', pins: ['object-helper-unmodelled'] },
  { expression: 'spread.plantedBehindSpreadControl', pins: ['object-spread'] },
  { expression: 'copied.plantedBehindSpread', pins: ['object-spread'] },
  {
    expression: 'reflected.plantedBehindAnUnmodelledHelper',
    pins: ['namespaced-helper-unmodelled'],
  },
  {
    expression: 'structuredClone(opts).plantedBehindABareHelper',
    pins: ['bare-identifier-helper'],
  },
  { expression: 'tail.plantedBehindAMethodReceiver', pins: ['method-receiver'] },
  {
    expression: 'firstMapped.raw.plantedThroughAMapCallback',
    pins: ['map-callback-return'],
  },
  {
    expression: 'built.plantedThroughAFromEntriesContainer',
    pins: ['fromEntries-values'],
  },
  {
    expression: 'level1.nested.nested.nested.nested.nested.raw.plantedSixLevelsDown',
    pins: ['field-depth-six'],
  },
  { expression: 'opts.plantedOnAnExportedArrow', pins: ['exported-const-arrow'] },
  { expression: 'opts.plantedOnAnExportedMethod', pins: ['exported-class-method'] },
  {
    expression: 'opts.plantedInAnExportListCallable',
    pins: ['exported-via-export-list'],
  },
  {
    expression: 'opts.plantedBehindAnExportAlias',
    pins: ['exported-via-aliased-export-list'],
  },
  {
    expression: 'opts.plantedOnAnExportedObjectMethod',
    pins: ['exported-object-literal-method'],
  },
  {
    expression: 'opts.plantedOnAnExportedObjectArrow',
    pins: ['exported-object-literal-arrow'],
  },
  {
    expression: 'inner.plantedInAnInlineCallee',
    pins: ['inline-callee-parameters'],
  },
  { expression: 'for…in opts', pins: ['for-in-enumeration'] },
  {
    expression: 'carried.plantedThroughADestructuredField',
    pins: ['destructured-field-precision'],
  },
];

/**
 * The honest reads the probe also carries, and what each one holds.
 *
 * A precision rule cannot be pinned by a planted read, because losing it makes
 * the walker report MORE rather than less. What holds it is a read that must
 * stay silent — so these are enforced by the exact-set assertion from the other
 * side, and listed here so the coverage check below can see them.
 */
const HONEST_PROBE_READS = [
  {
    description: "auditTeethProbe reads the same field through ownValue",
    pins: ['own-value-read-is-silent'],
  },
  {
    description: 'auditTeethHonestSink is only ever handed a fresh local literal',
    pins: ['fresh-local-argument'],
  },
  {
    description: 'auditTeethOwnIterationProbe takes the length of Object.values(caller)',
    pins: ['own-only-iteration'],
  },
];

const EXPECTED_PROBE_EXPRESSIONS = EXPECTED_PROBE_REPORTS.map(
  ({ expression }) => expression,
);

function probeReports() {
  return auditReads(`${auditedSource}${TEETH_PROBE}`).filter((violation) =>
    PROBE_FUNCTIONS.has(violation.fn),
  );
}

test('reports every plain [[Get]] planted on caller-supplied data', () => {
  const reported = probeReports().map((violation) => violation.expression);

  assert.deepEqual(
    [...reported].sort(),
    [...EXPECTED_PROBE_EXPRESSIONS].sort(),
    'the walker must report a planted plain [[Get]] — directly, through an internal function it is handed to, and through a projection field that carries it — or the audit above proves nothing',
  );
});

test('pins every capability the walker states as contract', () => {
  const pinned = new Set(
    [...EXPECTED_PROBE_REPORTS, ...HONEST_PROBE_READS].flatMap(({ pins }) => pins),
  );
  const unpinned = WALKER_CAPABILITIES.filter((capability) => !pinned.has(capability));

  assert.deepEqual(
    unpinned,
    [],
    'a capability with no planted read behind it can be deleted from the walker with every test green — three review rounds found one each. Add a probe entry that only that capability can satisfy, or move the claim to the blind-spot list and take it out of this array',
  );
});

test('names a declared capability in every probe entry', () => {
  const known = new Set(WALKER_CAPABILITIES);
  const stray = [...EXPECTED_PROBE_REPORTS, ...HONEST_PROBE_READS].flatMap(
    ({ expression, description, pins }) => {
      const subject = expression ?? description;
      return pins.length === 0
          ? [`${subject}: pins nothing`]
          : pins
              .filter((capability) => !known.has(capability))
              .map((capability) => `${subject}: ${capability}`);
    },
  );

  assert.deepEqual(
    stray,
    [],
    'a probe entry that pins nothing, or names a capability this walker does not declare, has drifted from what it was written to hold',
  );
});

test('leaves the honest reads of the same fields unreported', () => {
  const unexpected = probeReports().filter(
    (violation) => !EXPECTED_PROBE_EXPRESSIONS.includes(violation.expression),
  );

  assert.deepEqual(
    unexpected.map(({ line, column, expression }) => `${line}:${column} ${expression}`),
    [],
    'an ownValue read, and an internal function handed only a fresh local object, must stay invisible to the audit — or the walker fires on honest work',
  );
});
