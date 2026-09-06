/**
 * AIC-94, step 5: the provider stays behind one file, and the graph and domain
 * layers stay provider-independent.
 *
 * The acceptance row this file covers reads "no provider SDK leaks into domain
 * or graph". That is two claims, and only one of them was enforced before this
 * item: `dependency-cruiser.config.mjs` scoped BOTH of its rules to
 * `^packages/domain/`, and `eslint.config.mjs` covers `packages/domain/**`
 * alone. The mechanical half of the graph claim is the new
 * `graph-and-domain-do-not-import-model-providers` rule, whose bite is measured
 * by `test/repository-scaffold.test.mjs` › "lint rejects a graph import of the
 * model role package". This file is the textual half: it holds the WORKSPACE to
 * a single provider-aware file, which no module-graph rule can express, because
 * a host name in a string is not an import.
 */
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import ts from 'typescript';

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

function sourceFiles(directory) {
  const found = [];
  const walk = (current) => {
    for (const entry of readdirSync(current)) {
      if (entry === 'node_modules' || entry === 'dist') continue;
      const path = join(current, entry);
      if (statSync(path).isDirectory()) {
        walk(path);
        continue;
      }
      if (path.endsWith('.ts')) found.push(path);
    }
  };
  walk(directory);
  return found;
}

const workspaceSources = sourceFiles(resolve(projectRoot, 'packages'));

/**
 * What "names the provider" means, spelled once.
 *
 * The host and the wire vocabulary, not the word "model": a role that says
 * `ModelPort` has named an abstraction, while a file that says
 * `api.anthropic.com` or `anthropic-version` has named a provider's HTTP
 * contract and is the thing this rule bounds to one place.
 */
const PROVIDER_SURFACE = /api\.anthropic\.com|anthropic-version|x-api-key|ANTHROPIC_API_KEY|claude-[a-z0-9-]+/;

test('reaches the model provider from exactly one file in the workspace', () => {
  const naming = workspaceSources.filter((path) =>
    PROVIDER_SURFACE.test(readFileSync(path, 'utf8')),
  );

  assert.deepEqual(
    naming.map((path) => path.slice(projectRoot.length + 1)),
    ['packages/roles/src/reference-model-port.ts'],
    'a second provider is a second adapter beside this one, never an edit spread across the roles',
  );
});

test('keeps every provider reference out of the graph and domain packages', () => {
  for (const layer of ['domain', 'graph']) {
    for (const path of sourceFiles(resolve(projectRoot, 'packages', layer))) {
      const source = readFileSync(path, 'utf8');
      assert.doesNotMatch(
        source,
        PROVIDER_SURFACE,
        `${path} names the model provider: the graph and domain layers stay provider-independent`,
      );
      assert.doesNotMatch(
        source,
        /(?:from\s+|import\s*\()['"]@aic\/roles(?:\/[^'"]*)?['"]/,
        `${path} imports the role package, which is what carries the provider adapter`,
      );
    }
  }
});

test('performs the provider request in the adapter and nowhere else', () => {
  const issuing = workspaceSources.filter((path) => {
    const source = readFileSync(path, 'utf8');
    return /\bfetch\s*\(/.test(source) || /\bhttps?:\/\//.test(source);
  });

  assert.deepEqual(
    issuing.map((path) => path.slice(projectRoot.length + 1)),
    ['packages/roles/src/reference-model-port.ts'],
    'one outbound HTTP surface, so a security review has one file to read',
  );
});

test('spells the own-property read the same way as the two copies it names', async () => {
  // `code-reviewer` measured the third copy diverging from both siblings in
  // exactly the hardening they carry: it read `descriptor.value` without first
  // asking whether the descriptor OWNS `value`. For an ACCESSOR descriptor it
  // does not, so that read walks the prototype chain — the defect this whole
  // family of reads exists to prevent, in the function written to prevent it.
  //
  // Proving the three agree by comparing their source would break on
  // whitespace, so this compares BEHAVIOUR on the shape that separated them.
  // `.claude/rules/invariants.md` ("one mechanism, one implementation") asks for
  // a check rather than a note wherever a second copy has to stay, and the
  // reason this one stays is in own-value.ts's own limit.
  // `ownValue` is private to each package on purpose, so it is reached the way
  // this repository already reaches an off-surface symbol: through the built
  // module by path (`benchmark-regression-gate.js` is the precedent).
  const roles = await import('../packages/roles/dist/own-value.js');

  // The correspondence this probe cannot see on its own — that every OTHER
  // spelling carries the guard too — used to live here as a list of three
  // paths, and a fourth copy had already arrived without it noticing. It is
  // computed now, from the AST of every package source:
  // see roles-boundary.test.mjs › "every private own-data-property read in
  // packages carries the descriptor guard"

  const planted = {};
  Object.defineProperty(planted, 'token', {
    configurable: true,
    enumerable: true,
    get() {
      return 'from-the-accessor';
    },
  });

  assert.equal(
    roles.ownValue(planted, 'token'),
    undefined,
    'an accessor must read as absent rather than being invoked',
  );

  Object.defineProperty(Object.prototype, 'value', {
    configurable: true,
    value: 'POLLUTED',
    writable: true,
  });
  try {
    assert.equal(
      roles.ownValue(planted, 'token'),
      undefined,
      "a planted Object.prototype.value must not become the accessor descriptor's value",
    );
  } finally {
    delete Object.prototype.value;
  }
});

test('keeps every process-environment read out of the workspace packages', () => {
  // Three places asserted "packages/ reads process.env zero times" — a counted,
  // repository-wide invariant with nothing behind it, which
  // `.claude/rules/invariants.md` treats as the copy that goes stale. It is the
  // reason `resolveModelConfig` takes the environment as an argument, so it is
  // worth a check rather than three sentences.
  const offenders = [];
  for (const packageName of ['domain', 'graph', 'roles', 'tools', 'evals', 'observability', 'persistence']) {
    const directory = resolve(projectRoot, `packages/${packageName}`);
    for (const path of sourceFiles(directory)) {
      const source = readFileSync(path, 'utf8');
      // Comments may DISCUSS process.env — that is what these sentences do —
      // so only a read outside a comment counts.
      const code = source
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/^\s*\/\/.*$/gm, '');
      if (/\bprocess\s*\.\s*env\b/.test(code)) {
        offenders.push(path.slice(projectRoot.length + 1));
      }
    }
  }

  assert.deepEqual(
    offenders,
    [],
    'a workspace package read the process environment: the credential and the tracing config enter at the executable edge and are passed in as arguments, which is what lets a caller test either without touching the real environment',
  );
});

test('keeps one own-property read for the whole roles package', () => {
  const defining = sourceFiles(resolve(projectRoot, 'packages/roles')).filter(
    (path) => /export function ownValue\b/.test(readFileSync(path, 'utf8')),
  );

  assert.deepEqual(
    defining.map((path) => path.slice(projectRoot.length + 1)),
    ['packages/roles/src/own-value.ts'],
    'two spellings of one read is how the copy nobody looks at goes wrong',
  );
});

test('states the adapter limits in the adapter', () => {
  const adapter = readFileSync(
    resolve(projectRoot, 'packages/roles/src/reference-model-port.ts'),
    'utf8',
  );

  for (const limit of ['no streaming', 'no retry', 'no tool use']) {
    assert.ok(
      adapter.includes(limit),
      `the adapter must state its "${limit}" limit where a reader of it will be`,
    );
  }
});

test('adds no provider SDK to any package manifest', () => {
  const manifests = [
    'package.json',
    'packages/domain/package.json',
    'packages/graph/package.json',
    'packages/roles/package.json',
    'packages/evals/package.json',
    'packages/observability/package.json',
    'packages/tools/package.json',
    'packages/persistence/package.json',
    'apps/cli/package.json',
  ];

  for (const relativePath of manifests) {
    const manifest = JSON.parse(
      readFileSync(resolve(projectRoot, relativePath), 'utf8'),
    );
    const declared = Object.keys({
      ...manifest.dependencies,
      ...manifest.devDependencies,
    });
    for (const name of declared) {
      assert.doesNotMatch(
        name,
        /^(?:@anthropic-ai\/|openai$|@google\/generative-ai$|@aws-sdk\/client-bedrock)/,
        `${relativePath} declares a provider SDK: the reference path is plain fetch with an injected transport, which keeps the supply-chain surface unchanged`,
      );
    }
  }
});

test('declares the model-provider boundary rule for graph and domain', () => {
  const config = readFileSync(
    resolve(projectRoot, 'dependency-cruiser.config.mjs'),
    'utf8',
  );

  assert.match(
    config,
    /graph-and-domain-do-not-import-model-providers/,
    'the graph half of the boundary needs a rule, not only a convention',
  );
  assert.match(
    config,
    /\^packages\/\(\?:domain\|graph\)\//,
    'the rule must be scoped to both layers the acceptance row names',
  );
});

/* -------------------------------------------------------------------------- */
/* the own-data-property reads, as a COMPUTED inventory                        */
/* -------------------------------------------------------------------------- */

/**
 * What counts as a private own-data-property read, decided from the AST.
 *
 * A read is a function that BINDS an own-property descriptor to a name and then
 * reads `value` off that name. That pair is the family this repository keeps
 * several private spellings of, and it is the pair that goes wrong: an ACCESSOR
 * descriptor owns `get`/`set` and no `value`, so reading `descriptor.value` off
 * one walks the prototype chain — the defect every copy exists to prevent.
 *
 * ⚠ Outside the scope, and said here rather than discovered later. Three
 * spellings bind nothing this scan recognises and are NOT collected:
 *   - an inline `Object.getOwnPropertyDescriptor(x, k)?.value`;
 *   - destructuring, `const { value } = Object.getOwnPropertyDescriptor(...)`;
 *   - declare-then-assign, `let d; d = Object.getOwnPropertyDescriptor(...)`.
 * The third is inside the "binds a descriptor to a name" wording above, so read
 * that wording as "binds it in a variable declaration with a call initializer",
 * which is what the scan does. Measured at the AIC-94 gate by planting all three
 * as unguarded reads and watching this row stay green.
 *
 * `isRevivedRecord` in `packages/persistence/src/own-value-serde.ts` is the
 * first form. It is SAFE, and the reason matters because the obvious one is
 * wrong: not "a polluted value could not be 1 or 2" — the attacker picks the
 * polluted value — but that `Object.hasOwn(value, 'lc')` runs first AND the
 * declared tree comes from `JSON.parse`, which produces own DATA properties
 * only, so the accessor descriptor that would make `descriptor.value` fall
 * through cannot arise on that side. `own-value-serde.ts` documents that
 * provenance itself. Rationale corrected by `code-reviewer` at the AIC-94 gate,
 * which measured the first version of it false.
 *
 * ⚠ The scan also OVER-reaches once, in the safe direction: a read whose
 * `Object.hasOwn` check is delegated to a type-guard helper is reported as
 * unguarded. That is a false refusal, never a false pass.
 *
 * The inventory is computed rather than listed for the reason
 * `test/observability-own-value-audit.test.mjs` gives at length: a hand-written
 * list of the copies is a different wrong subset every time it is edited. The
 * list this row replaced named three files while four existed.
 */
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

function isCallTo(node, object, method) {
  return (
    ts.isCallExpression(node) &&
    ts.isPropertyAccessExpression(node.expression) &&
    ts.isIdentifier(node.expression.expression) &&
    node.expression.expression.text === object &&
    node.expression.name.text === method
  );
}

function eachNode(node, visit) {
  visit(node);
  node.forEachChild((child) => eachNode(child, visit));
}

function enclosingFunction(node) {
  let current = node.parent;
  while (current !== undefined && !isFunctionLike(current)) current = current.parent;
  return current;
}

function functionLabel(node) {
  const named = node.name ?? node.parent?.name;
  return named !== undefined && ts.isIdentifier(named) ? named.text : '<anonymous>';
}

function ownDataPropertyReads() {
  const reads = [];
  for (const path of workspaceSources) {
    const text = readFileSync(path, 'utf8');
    if (!text.includes('getOwnPropertyDescriptor')) continue;
    const file = ts.createSourceFile(
      path,
      text,
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.TS,
    );

    eachNode(file, (node) => {
      if (
        !ts.isVariableDeclaration(node) ||
        !ts.isIdentifier(node.name) ||
        node.initializer === undefined ||
        !isCallTo(node.initializer, 'Object', 'getOwnPropertyDescriptor')
      ) {
        return;
      }
      const holder = enclosingFunction(node);
      if (holder === undefined) return;

      const binding = node.name.text;
      let readsValue = false;
      let guarded = false;
      eachNode(holder, (inner) => {
        if (
          ts.isPropertyAccessExpression(inner) &&
          ts.isIdentifier(inner.expression) &&
          inner.expression.text === binding &&
          inner.name.text === 'value'
        ) {
          readsValue = true;
        }
        if (
          isCallTo(inner, 'Object', 'hasOwn') &&
          inner.arguments.length === 2 &&
          ts.isIdentifier(inner.arguments[0]) &&
          inner.arguments[0].text === binding &&
          ts.isStringLiteralLike(inner.arguments[1]) &&
          inner.arguments[1].text === 'value'
        ) {
          guarded = true;
        }
      });
      if (!readsValue) return;

      const { line } = file.getLineAndCharacterOfPosition(node.getStart(file));
      reads.push({
        where: `${path.slice(projectRoot.length + 1)}:${line + 1} ${functionLabel(holder)}`,
        guarded,
      });
    });
  }
  return reads;
}

test('every private own-data-property read in packages carries the descriptor guard', () => {
  const reads = ownDataPropertyReads();

  assert.ok(
    reads.length > 0,
    'the scan found no own-data-property read anywhere in packages: an audit that finds nothing passes everything, so this reads as broken rather than as clean',
  );

  const unguarded = reads.filter(({ guarded }) => !guarded).map(({ where }) => where);
  assert.deepEqual(
    unguarded,
    [],
    `each of these binds an own-property descriptor and reads 'value' off it without first asking Object.hasOwn(descriptor, 'value'): for an ACCESSOR descriptor there is no own 'value', so a planted Object.prototype.value answers the read — the exact prototype-chain read this family of functions exists to prevent. The whole computed inventory was: ${reads.map(({ where }) => where).join(', ')}`,
  );
});

/* -------------------------------------------------------------------------- */
/* the model error types are an affordance, not yet a branch                   */
/* -------------------------------------------------------------------------- */

test('leaves the model error types undistinguished by any caller in packages or scripts', () => {
  // `packages/roles/src/model-errors.ts` says in its own header that no caller
  // branches on these types yet — that the separate types are the affordance and
  // not the behaviour. That is a claim about this repository, so it is checked
  // here rather than believed: the day someone adds the first `instanceof`, this
  // row goes red and the header gets corrected, instead of quietly becoming
  // false in the direction of "we already have that".
  //
  // The type names are read out of the module rather than listed, so a fifth
  // error class is covered on the day it is written.
  const errorsPath = resolve(projectRoot, 'packages/roles/src/model-errors.ts');
  const declared = [
    ...readFileSync(errorsPath, 'utf8').matchAll(/export class (\w+) extends Error\b/g),
  ].map(([, name]) => name);

  assert.ok(
    declared.length > 0,
    'no error class was found in model-errors.ts: the scan below would then check nothing',
  );

  const scanned = [
    ...workspaceSources,
    ...readdirSync(resolve(projectRoot, 'scripts'))
      .filter((entry) => entry.endsWith('.mjs'))
      .map((entry) => resolve(projectRoot, 'scripts', entry)),
  ];
  const branching = [];
  for (const path of scanned) {
    // A comment may DISCUSS the types — model-errors.ts's header does — so only
    // an `instanceof` outside a comment counts.
    const code = readFileSync(path, 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/^\s*\/\/.*$/gm, '');
    for (const name of declared) {
      if (new RegExp(`instanceof\\s+${name}\\b`).test(code)) {
        branching.push(`${path.slice(projectRoot.length + 1)} branches on ${name}`);
      }
    }
  }

  assert.deepEqual(
    branching,
    [],
    'a caller now tells the model error types apart, which the header of model-errors.ts says nothing does: update that header — the types stopped being only an affordance',
  );
});

/* -------------------------------------------------------------------------- */
/* the credential has one reader, and the scan says exactly which spellings     */
/* -------------------------------------------------------------------------- */

/**
 * `packages/roles/src/model-config.ts` claims in its own header that
 * `readModelCredential` is "one reader, used by BOTH the availability decision
 * and the caller that actually sends the value", and
 * `scripts/eval-live-model.mjs` repeats the claim over the line that calls it.
 * Nothing pinned it. Measured at the AIC-94 gate: reverting that line to
 * `const apiKey = env[MODEL_API_KEY_VARIABLE]` left the whole suite green,
 * because the row it cited — live-model-lane.test.mjs › "never hands the
 * transport a credential the configuration did not validate" — is an
 * end-to-end leak row that the PORT's own control-character guard already
 * satisfies. That row pins the conjunction of two guards; this one pins the
 * single-reader property on its own, so removing either guard is visible.
 *
 * ⚠ What this scan matches, exactly — a scanner sees the spellings it matches
 * and nothing else, so the list is the claim:
 *   1. an element access keyed by the constant or the literal name —
 *      `x[MODEL_API_KEY_VARIABLE]`, `x['ANTHROPIC_API_KEY']`;
 *   2. a property access by that name — `x.ANTHROPIC_API_KEY`;
 *   3. a destructure of that name — `const { ANTHROPIC_API_KEY } = x`;
 *   4. a call whose SECOND argument is the constant or the literal name — the
 *      `(object, key)` helper shape `readModelCredential` itself is written in,
 *      `ownTrimmedString(env, MODEL_API_KEY_VARIABLE)`.
 *
 * ⚠ What it does NOT see, and therefore does not claim:
 *   - a key assembled at runtime (`env['ANTHROPIC_' + 'API_KEY']`) or held in a
 *     variable or parameter. That last one is how `ownValue` is written, which
 *     is why the trail stops at the call site in form 4 rather than following
 *     it into the helper — and it means an indirection through a second helper
 *     of one's own would pass;
 *   - anything outside `packages/**\/*.ts` and `scripts/*.mjs`: tests, `apps/`,
 *     configuration and shell are all out of scope;
 *   - what a caller DOES with the value once `readModelCredential` returns it.
 *     That is the other row's subject, not this one's.
 *
 * Comments are not matched because this reads the AST rather than the text,
 * which is the same "only a read outside a comment counts" convention the
 * process-environment row above states — both files above DISCUSS the variable
 * in prose, and neither discussion is a read.
 */
const CREDENTIAL_VARIABLE_NAME = 'ANTHROPIC_API_KEY';
const CREDENTIAL_VARIABLE_CONSTANT = 'MODEL_API_KEY_VARIABLE';
const CREDENTIAL_READER = {
  file: 'packages/roles/src/model-config.ts',
  holder: 'readModelCredential',
};

function namesTheCredentialKey(node) {
  return (
    (ts.isIdentifier(node) && node.text === CREDENTIAL_VARIABLE_CONSTANT) ||
    (ts.isStringLiteralLike(node) && node.text === CREDENTIAL_VARIABLE_NAME)
  );
}

/**
 * The key a destructuring element reads, which is spelled differently from a
 * key in expression position: `const { ANTHROPIC_API_KEY: k } = env` names the
 * key with a bare identifier that is NOT a variable reference, while
 * `const { [MODEL_API_KEY_VARIABLE]: k } = env` computes it and IS one. Reading
 * both through `namesTheCredentialKey` gets the first case backwards, which is
 * how the first draft of this scanner missed the plainest destructure there is.
 */
function bindsTheCredentialKey(node) {
  const key = node.propertyName;
  if (key === undefined) {
    return ts.isIdentifier(node.name) && node.name.text === CREDENTIAL_VARIABLE_NAME;
  }
  if (ts.isComputedPropertyName(key)) return namesTheCredentialKey(key.expression);
  return (
    (ts.isIdentifier(key) || ts.isStringLiteralLike(key)) &&
    key.text === CREDENTIAL_VARIABLE_NAME
  );
}

function credentialValueReads() {
  const scanned = [
    ...workspaceSources,
    ...readdirSync(resolve(projectRoot, 'scripts'))
      .filter((entry) => entry.endsWith('.mjs'))
      .map((entry) => resolve(projectRoot, 'scripts', entry)),
  ];

  const reads = [];
  for (const path of scanned) {
    const text = readFileSync(path, 'utf8');
    if (
      !text.includes(CREDENTIAL_VARIABLE_NAME) &&
      !text.includes(CREDENTIAL_VARIABLE_CONSTANT)
    ) {
      continue;
    }
    const file = ts.createSourceFile(
      path,
      text,
      ts.ScriptTarget.Latest,
      true,
      path.endsWith('.ts') ? ts.ScriptKind.TS : ts.ScriptKind.JS,
    );

    eachNode(file, (node) => {
      let spelling;
      if (
        ts.isElementAccessExpression(node) &&
        namesTheCredentialKey(node.argumentExpression)
      ) {
        spelling = 'element access';
      } else if (
        ts.isPropertyAccessExpression(node) &&
        node.name.text === CREDENTIAL_VARIABLE_NAME
      ) {
        spelling = 'property access';
      } else if (ts.isBindingElement(node) && bindsTheCredentialKey(node)) {
        spelling = 'destructure';
      } else if (
        ts.isCallExpression(node) &&
        node.arguments.length === 2 &&
        namesTheCredentialKey(node.arguments[1])
      ) {
        spelling = 'keyed helper call';
      } else {
        return;
      }

      const holder = enclosingFunction(node);
      const { line } = file.getLineAndCharacterOfPosition(node.getStart(file));
      reads.push({
        file: path.slice(projectRoot.length + 1),
        holder: holder === undefined ? '<module scope>' : functionLabel(holder),
        where: `${path.slice(projectRoot.length + 1)}:${line + 1} ${
          holder === undefined ? '<module scope>' : functionLabel(holder)
        } (${spelling})`,
      });
    });
  }
  return reads;
}

test('reads the credential value in readModelCredential and nowhere else in packages or scripts', () => {
  const reads = credentialValueReads();

  assert.ok(
    reads.length > 0,
    `the scan found no read of ${CREDENTIAL_VARIABLE_NAME} anywhere in packages or scripts: an audit that finds nothing passes everything, so this reads as a broken scanner — a renamed constant, a moved module, or a spelling this row does not match — rather than as a clean repository`,
  );

  assert.ok(
    reads.some(
      ({ file, holder }) =>
        file === CREDENTIAL_READER.file && holder === CREDENTIAL_READER.holder,
    ),
    `the scan did not find the read inside ${CREDENTIAL_READER.file} › ${CREDENTIAL_READER.holder}, which is the one reader this row exists to keep alone: either that function stopped reading the credential or the scan stopped seeing it, and both make every other assertion here vacuous. What it did find was: ${reads.map(({ where }) => where).join(', ') || '(nothing)'}`,
  );

  const offenders = reads
    .filter(
      ({ file, holder }) =>
        !(file === CREDENTIAL_READER.file && holder === CREDENTIAL_READER.holder),
    )
    .map(({ where }) => where);

  assert.deepEqual(
    offenders,
    [],
    `each of these reads the value of ${CREDENTIAL_VARIABLE_NAME} outside ${CREDENTIAL_READER.holder}, so the string a caller sends is no longer provably the string ${CREDENTIAL_READER.file} validated: the two diverged before — the configuration validated a trimmed value while the caller sent the raw one — and a second reader is how they diverge again. Read through readModelCredential instead. The whole scanned inventory was: ${reads.map(({ where }) => where).join(', ')}`,
  );
});
