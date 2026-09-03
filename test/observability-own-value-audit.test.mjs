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
 *   - **Caller data enters at the exported functions and spreads by
 *     argument.** A parameter of an exported function holds caller data; an
 *     internal function's parameter holds caller data only when some call site
 *     hands it some. This is what makes `persistPreparedExperiment`'s
 *     `OwnExperiment` parameter clean while `requireResourceEvidence`'s
 *     parameter is not — the same shape, different callers.
 *   - **A function's return value carries caller data if any expression it
 *     returns does.** A fresh object literal does not, which is exactly why the
 *     projections launder and `ownValue` deliberately does not: `ownValue`
 *     hands back the caller's value, checked but verbatim, and that is what
 *     keeps the reads downstream of an own read in scope for this audit.
 *   - **Object literals are tracked field by field.** A projection whose type
 *     carries a passthrough field — an `unknown` holding the caller's object —
 *     launders the container but not that field, so a later read THROUGH it is
 *     still reported.
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
 *      every read of every element a read of caller data. `push` and `unshift`
 *      are followed; any other way of filling an array is not.
 *   5. **Field knowledge stops at six levels deep**, which is what makes the
 *      lattice finite and the fixpoint terminate. Deeper than that a projection
 *      reads as opaque rather than as caller data.
 *
 * ⚠ Two blind spots no audit of this file's text can close, stated here so no
 * reader infers cover that is not there:
 *
 *   - a built-in that reads a caller array element for you — `slice`, `at`,
 *     `flat` — performs the `[[Get]]` INSIDE `Array.prototype`, where nothing
 *     below can see it. No instance of that survives in the file today: the one
 *     `slice` left runs on a freshly built local array.
 *   - a function reached through a PARAMETER, an object property or a reassigned
 *     binding is not resolved to its declaration, so caller data does not follow
 *     it. A `const`-bound arrow IS resolved — that is what makes the `own` alias
 *     in `requireResourceEvidence` a non-event rather than a false positive.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import ts from 'typescript';

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const auditedPath = resolve(projectRoot, 'packages/observability/src/index.ts');
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

/** `Object.*` helpers that hand back caller data (or a wrapper around it). */
const OBJECT_HELPERS_RETURNING_CALLER_DATA = new Set([
  'entries',
  'values',
  'keys',
  'getOwnPropertyDescriptor',
]);

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
    ts.isMethodDeclaration(node)
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
          const spread = taintOf(property.expression, depth + 1);
          descriptor = join(descriptor, { self: false, fields: spread.fields });
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
        if (
          ts.isIdentifier(callee.expression) &&
          callee.expression.text === 'Object' &&
          OBJECT_HELPERS_RETURNING_CALLER_DATA.has(callee.name.text)
        ) {
          const argument =
            firstArgument === undefined ? clean() : taintOf(firstArgument, depth + 1);
          // `entries`, `values` and `keys` hand back an ARRAY of the caller's
          // values; `getOwnPropertyDescriptor` hands back a fresh wrapper whose
          // `value` is one of them, and collapsing the two is how this walker
          // once laundered every own read in the file.
          return callee.name.text === 'getOwnPropertyDescriptor'
            ? { self: argument.self, fields: new Map() }
            : { self: false, fields: new Map([[ELEMENT, argument]]) };
        }
        // A method called ON caller data hands back caller data: `records.map`,
        // `experiments.slice`, `client.createDataset`.
        // `slice`, `entries`, `filter` and friends hand back the receiver's
        // elements; `map` hands back the callback's, and treating those as the
        // receiver's is the conservative direction.
        const receiver = taintOf(callee.expression, depth + 1);
        return { self: receiver.self, fields: new Map([[ELEMENT, elementOf(receiver)]]) };
      }

      if (ts.isIdentifier(callee)) {
        return returns.get(callee.text) ?? clean();
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

  // The round cap is a safety net, not the termination argument — the finite
  // lattice is (see coarsening 5). It is asserted rather than trusted: a file
  // that has not converged when the cap is reached has UNDER-propagated taint,
  // so the audit would report fewer violations and go quietly green. That is the
  // one way this check dies without anything turning red.
  const MAX_ROUNDS = 24;
  let round = 0;
  for (; round < MAX_ROUNDS && changed; round += 1) {
    changed = false;

    // Caller data enters here, and only here.
    eachNode(sourceFile, (node) => {
      if (ts.isFunctionDeclaration(node) && isExported(node)) {
        for (const parameter of node.parameters) {
          handToParameter(parameter, node, callerData());
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
 * Five hazardous reads and three honest ones, appended to the parsed TEXT only — the
 * file on disk is never touched.
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
  return [hazard, honest, sunk, deep, fresh, collected];
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

function auditTeethHonestSink(local: Readonly<{ plantedInAFreshLiteral: number }>): unknown {
  return local.plantedInAFreshLiteral;
}
`;

const PROBE_FUNCTIONS = new Set([
  'auditTeethProbe',
  'auditTeethSink',
  'auditTeethProjection',
  'auditTeethHonestSink',
  'auditTeethArraySink',
]);

const EXPECTED_PROBE_REPORTS = [
  'supplied.plantedByTheTeethProbe',
  'handed.plantedInTheInternalSink',
  'projected.raw.plantedBehindTheProjection',
  'entry.raw.plantedBehindAnIteration',
  'first.raw.plantedBehindAnArray',
];

function probeReports() {
  return auditReads(`${auditedSource}${TEETH_PROBE}`).filter((violation) =>
    PROBE_FUNCTIONS.has(violation.fn),
  );
}

test('reports every plain [[Get]] planted on caller-supplied data', () => {
  const reported = probeReports().map((violation) => violation.expression);

  assert.deepEqual(
    [...reported].sort(),
    [...EXPECTED_PROBE_REPORTS].sort(),
    'the walker must report a planted plain [[Get]] — directly, through an internal function it is handed to, and through a projection field that carries it — or the audit above proves nothing',
  );
});

test('leaves the honest reads of the same fields unreported', () => {
  const unexpected = probeReports().filter(
    (violation) => !EXPECTED_PROBE_REPORTS.includes(violation.expression),
  );

  assert.deepEqual(
    unexpected.map(({ line, column, expression }) => `${line}:${column} ${expression}`),
    [],
    'an ownValue read, and an internal function handed only a fresh local object, must stay invisible to the audit — or the walker fires on honest work',
  );
});
