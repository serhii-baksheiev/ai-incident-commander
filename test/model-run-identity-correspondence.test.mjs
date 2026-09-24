/**
 * AIC-94, step 7: the run-identity and resource allowlists correspond to the
 * types they publish — in BOTH directions.
 *
 * `packages/observability/src/index.ts` carries three hard allowlists. A field
 * added to a TYPE but not to the matching allowlist is **silently dropped**: the
 * run is published, it looks complete, and it describes a configuration the run
 * did not run under. The existing allowlist check —
 * `test/metric-path-prototype-safety.test.mjs` ›
 * "publishes every declared metadata field and nothing else" — cannot see that,
 * and says so in its own comment: its reach is the FIXTURE's, so a field the
 * fixture never sets stays green while being dropped.
 *
 * This item adds `modelId` and `modelProvider` to the metadata and two token
 * axes to the resource evidence, which is exactly the shape of change that
 * hazard punishes. So the correspondence is COMPUTED from the sources, and the
 * two directions are separate assertions:
 *
 *   - a key the type declares that no allowlist carries — the silent drop;
 *   - a key an allowlist carries that the type does not declare — a published
 *     field nothing produces, which reads downstream as a measurement that was
 *     attempted and came back empty.
 *
 * The comparison itself is a pure function over two sets, and two further tests
 * feed it MUTATED sets, so the check is proven to go red each way rather than
 * asserted to.
 *
 * ⚠ What this cannot see: it reads declarations, not behaviour. A key present in
 * both the type and the allowlist whose projection is broken is a behavioural
 * question, and `test/metric-path-prototype-safety.test.mjs` is where that lives.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import ts from 'typescript';

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

function parse(relativePath) {
  const path = resolve(projectRoot, relativePath);
  return ts.createSourceFile(
    path,
    readFileSync(path, 'utf8'),
    ts.ScriptTarget.ESNext,
    true,
  );
}

/** Unwrap `as const`, `satisfies …` and parentheses down to the literal. */
function literalOf(node) {
  let current = node;
  while (
    ts.isAsExpression(current) ||
    ts.isSatisfiesExpression(current) ||
    ts.isParenthesizedExpression(current)
  ) {
    current = current.expression;
  }
  return current;
}

function declarationInitializer(sourceFile, name) {
  for (const statement of sourceFile.statements) {
    if (!ts.isVariableStatement(statement)) continue;
    for (const declaration of statement.declarationList.declarations) {
      if (
        ts.isIdentifier(declaration.name) &&
        declaration.name.text === name &&
        declaration.initializer !== undefined
      ) {
        return literalOf(declaration.initializer);
      }
    }
  }
  assert.fail(`${sourceFile.fileName} declares no const named ${name}`);
}

function stringArrayConst(sourceFile, name) {
  const initializer = declarationInitializer(sourceFile, name);
  assert.ok(
    ts.isArrayLiteralExpression(initializer),
    `${name} must be an array literal to be read as an allowlist`,
  );
  return initializer.elements.map((element) => {
    assert.ok(
      ts.isStringLiteral(element),
      `${name} must contain string literals only`,
    );
    return element.text;
  });
}

function numberConst(sourceFile, name) {
  const initializer = declarationInitializer(sourceFile, name);
  assert.ok(ts.isNumericLiteral(initializer), `${name} must be a numeric literal`);
  return Number(initializer.text);
}

function interfaceMembers(sourceFile, name) {
  for (const statement of sourceFile.statements) {
    if (!ts.isInterfaceDeclaration(statement) || statement.name.text !== name) {
      continue;
    }
    return statement.members.map((member) => {
      assert.ok(
        ts.isPropertySignature(member) && ts.isIdentifier(member.name),
        `${name} must declare plain named properties`,
      );
      return member.name.text;
    });
  }
  assert.fail(`${sourceFile.fileName} declares no interface named ${name}`);
}

/**
 * The correspondence itself, as a pure function so the mutation probes below can
 * drive it without editing a source file.
 *
 * Returns the two asymmetric differences rather than a boolean: a check that
 * says only "these disagree" sends the reader to diff two lists by eye, and the
 * whole reason this check exists is that a human comparison of two lists is what
 * kept going wrong.
 */
function correspondence(declared, allowlisted) {
  const allowed = new Set(allowlisted);
  const known = new Set(declared);
  return {
    droppedByTheAllowlist: [...known].filter((key) => !allowed.has(key)).sort(),
    publishedWithNoDeclaration: [...allowed].filter((key) => !known.has(key)).sort(),
  };
}

const observability = parse('packages/observability/src/index.ts');
const evals = parse('packages/evals/src/benchmark-evaluation.ts');
const behaviorEvaluators = parse('packages/evals/src/behavior-evaluators.ts');

test('carries every declared run-metadata field in one of the two metadata allowlists', () => {
  const declared = interfaceMembers(observability, 'PersistedBenchmarkRunMetadata');
  const allowlisted = [
    ...stringArrayConst(observability, 'PERSISTED_METADATA_KEYS'),
    ...stringArrayConst(observability, 'PERSISTED_OPTIONAL_METADATA_KEYS'),
  ];

  assert.ok(declared.includes('modelId'), 'the run must record which model ran it');
  assert.ok(
    declared.includes('modelProvider'),
    'a model id without its provider is ambiguous across providers',
  );
  assert.deepEqual(correspondence(declared, allowlisted), {
    droppedByTheAllowlist: [],
    publishedWithNoDeclaration: [],
  });
});

test('carries every declared resource axis in one of the two resource allowlists', () => {
  const declared = interfaceMembers(evals, 'BenchmarkResourceEvidence');
  const allowlisted = [
    'schemaVersion',
    ...stringArrayConst(observability, 'PERSISTED_RESOURCE_KEYS'),
    ...stringArrayConst(observability, 'PERSISTED_OPTIONAL_RESOURCE_KEYS'),
  ];

  assert.ok(declared.includes('inputTokensUsed'));
  assert.ok(declared.includes('outputTokensUsed'));
  assert.deepEqual(correspondence(declared, allowlisted), {
    droppedByTheAllowlist: [],
    publishedWithNoDeclaration: [],
  });
});

test('publishes exactly the run metadata the benchmark layer declares', () => {
  const persisted = interfaceMembers(observability, 'PersistedBenchmarkRunMetadata');
  // `BenchmarkRunMetadata extends BenchmarkVersions` and adds the three fields
  // below, so the union is what a record actually carries.
  const produced = [
    ...interfaceMembers(evals, 'BenchmarkVersions'),
    ...interfaceMembers(evals, 'BenchmarkRunMetadata'),
  ];

  assert.deepEqual(correspondence(produced, persisted), {
    droppedByTheAllowlist: [],
    publishedWithNoDeclaration: [],
  });
});

test('reads resource evidence at the version the benchmark writes', () => {
  assert.equal(
    numberConst(observability, 'PERSISTED_RESOURCE_SCHEMA_VERSION'),
    numberConst(evals, 'BENCHMARK_RESOURCE_SCHEMA_VERSION'),
    'a producer and a reader at different versions refuse every record',
  );
  assert.equal(
    numberConst(observability, 'PERSISTED_RESOURCE_SCHEMA_VERSION'),
    2,
    'adding the token axes moved the resource shape, so the version moved with it',
  );
});

/**
 * AIC-117 (slice c): the persisted evaluation shape corresponds
 * to what the benchmark layer's own `BenchmarkEvaluation` declares — in both
 * directions, on the same `correspondence` helper and the same two generic
 * mutation-proof rows above prove for every other pair in this file.
 */
test('carries every declared benchmark-evaluation field in the persisted evaluation shape', () => {
  const declared = interfaceMembers(evals, 'BenchmarkEvaluation');
  const persisted = interfaceMembers(observability, 'PersistedBenchmarkEvaluation');

  assert.deepEqual(correspondence(declared, persisted), {
    droppedByTheAllowlist: [],
    publishedWithNoDeclaration: [],
  });
});

/**
 * `UnsupportedClaimRateMetric extends BenchmarkMetric<'unsupported_claim_rate'>`,
 * so its full declared shape is the union of both interfaces' own members —
 * the same reasoning `BenchmarkRunMetadata extends BenchmarkVersions` gets
 * above. The persisted side is a literal rather than a read off
 * `packages/observability/src/index.ts`: this row states the shape a published
 * `unsupported_claim_rate` metric carries (`key`, `score`, `claimCount`)
 * directly, so the expectation here is the contract, not a second read of the
 * projection this file's other rows already hold to allowlists.
 */
test('carries the unsupported-claim-rate metric fields (key, score, claimCount) in the persisted metric shape', () => {
  const declared = [
    ...interfaceMembers(evals, 'BenchmarkMetric'),
    ...interfaceMembers(evals, 'UnsupportedClaimRateMetric'),
  ];
  const persistedUnsupportedClaimRateShape = ['key', 'score', 'claimCount'];

  assert.deepEqual(correspondence(declared, persistedUnsupportedClaimRateShape), {
    droppedByTheAllowlist: [],
    publishedWithNoDeclaration: [],
  });
});

test('carries every behavior metric key in the persisted behavior-metric allowlist', () => {
  const declared = stringArrayConst(behaviorEvaluators, 'BEHAVIOR_METRIC_KEYS');
  const persisted = stringArrayConst(observability, 'PERSISTED_BEHAVIOR_METRIC_KEYS');

  assert.deepEqual(correspondence(declared, persisted), {
    droppedByTheAllowlist: [],
    publishedWithNoDeclaration: [],
  });
});

test('reports a field the type declares that no allowlist carries', () => {
  assert.deepEqual(
    correspondence(['runId', 'modelId'], ['runId']),
    { droppedByTheAllowlist: ['modelId'], publishedWithNoDeclaration: [] },
  );
});

test('reports a field an allowlist carries that the type does not declare', () => {
  assert.deepEqual(
    correspondence(['runId'], ['runId', 'modelId']),
    { droppedByTheAllowlist: [], publishedWithNoDeclaration: ['modelId'] },
  );
});
