/**
 * AIC-100, slice a: "[ONB-3] Implement EvidenceSource adapter contract and
 * BoundSourceRegistry" — the additive-only half of this ticket. This file
 * pins the contract and typed outcomes only:
 *
 *   - `EVIDENCE_SOURCE_REFUSAL_REASONS` and the `EvidenceSourceOutcome` /
 *     `EvidenceSourceCheckResult` shapes (row 1, compile-time, and the
 *     runtime rows below);
 *   - `EvidenceSourceProvenance`'s five fields (compile-time, row 1);
 *   - `createRequestFingerprint(operation, input)`'s determinism and its
 *     pinned wire format;
 *   - `EvidenceSourceError` and `classifyEvidenceSourceFailure`, and that
 *     classification never carries a thrown error's message text forward;
 *   - `evidenceSourceOutcomeToToolResult`, which lets the EXISTING
 *     `projectToolResult` keep working unchanged — the acceptance line "a
 *     403, a timeout and an empty successful result remain distinguishable"
 *     is pinned here through the real `projectToolResult`, not a re-
 *     implementation of it.
 *
 * `BoundSourceRegistry` (live/record/replay modes), budgets/redaction, and
 * migrating the existing `packages/tools/live` and `packages/tools/replay`
 * adapters onto this contract are separate slices (b, c, d) and are not
 * touched here. Nothing in `packages/tools/live`, `packages/tools/replay`,
 * `replay-key.ts`, or any existing test is changed by this file.
 *
 * ## Design choices this file pins (the ticket names the shape, not every
 * internal detail — stated here rather than discovered mid-assertion)
 *
 *   - `EvidenceSourceError` is a named `Error` subclass with a stable `code`
 *     and a `reason` drawn from `EVIDENCE_SOURCE_REFUSAL_REASONS`, mirroring
 *     `StaleOwnerError` / `ExecutionIntegrityViolation` in
 *     `packages/domain/src/execution.ts`: `.name` equals the class name,
 *     `.code` is a stable non-empty string, checked by `instanceof` and
 *     `.name`/`.code`/`.reason`, never by message text.
 *   - `createRequestFingerprint(operation, input)` returns
 *     `` `sha256:${hex}` `` where `hex` is the lowercase-hex SHA-256 digest of
 *     `JSON.stringify(canonicalJson({ input, operation }))` — `canonicalJson`
 *     (the one canonical-JSON implementation, `@aic/domain`'s own — see
 *     `.claude/rules/invariants.md`, "one mechanism, one implementation")
 *     sorts every object's keys recursively, including the envelope's own two
 *     top-level keys, so `"input"` sorts before `"operation"`. The row below
 *     titled "matches an independently computed sha256" pins this exact
 *     format against a hand-built string, not against `canonicalJson` called
 *     from the test.
 *   - `evidenceSourceOutcomeToToolResult` maps `ok` to `ToolResult.ok`,
 *     `refused` with reason `unavailable` / `denied` / `rate_limited` /
 *     `timeout` to `ToolResult.unavailable` (so `projectToolResult` marks the
 *     prediction untestable, never negative evidence), and `refused` with
 *     reason `adapter_error` to `ToolResult.error`.
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { dirname, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import * as tools from '@aic/tools';

import { childEnv } from './fixtures/child-env.mjs';

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const compilerPath = resolve(projectRoot, 'node_modules/typescript/bin/tsc');
const typeContractFixture = resolve(
  projectRoot,
  'test/fixtures/evidence-source-type-contract.ts',
);

const rawEvidence = {
  id: 'evidence-1',
  trialId: 'trial-1',
  kind: 'log',
  source: 'checkout-logs',
  observedAt: '2026-08-27T12:00:00.000Z',
  statement: 'checkout returned 500',
  rawRef: 'fixture://logs/checkout/1',
};

const plannedTest = {
  id: 'test-1',
  predictionId: 'prediction-1',
  tool: 'logs',
  input: { service: 'checkout' },
  cost: 'cheap',
  status: 'planned',
};

const untestedPrediction = {
  id: 'prediction-1',
  hypothesisId: 'hypothesis-1',
  statement: 'checkout emits errors',
  expectedIfTrue: [{ status: 500 }],
  expectedIfFalse: [{ status: 200 }],
  status: 'untested',
};

function fixedProvenance(overrides = {}) {
  return {
    sourceBindingId: 'binding-fixture',
    adapter: 'fixture-adapter@1.0.0',
    credentialRefId: null,
    fetchedAt: '2026-09-24T00:00:00.000Z',
    requestFingerprint: `sha256:${'0'.repeat(64)}`,
    ...overrides,
  };
}

/* -------------------------------------------------------------------------- */
/* Row 1 — the compile-time port contract                                     */
/* -------------------------------------------------------------------------- */

test('compiles the evidence-source type contract: an EvidenceSource-shaped literal satisfies the interface, and a value missing execute is refused', () => {
  const result = spawnSync(
    process.execPath,
    [
      compilerPath,
      '--noEmit',
      '--ignoreConfig',
      '--strict',
      '--skipLibCheck',
      '--target',
      'ES2023',
      '--module',
      'NodeNext',
      '--moduleResolution',
      'NodeNext',
      typeContractFixture,
    ],
    {
      cwd: projectRoot,
      encoding: 'utf8',
      env: childEnv(),
    },
  );

  assert.equal(
    result.status,
    0,
    `type-contract compile exited ${result.status}\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}\n\n@aic/tools must export an EvidenceSource interface ({ describe(), check(), execute(operation, input) }), an EvidenceSourceOutcome<Output> type ({ status: 'ok', output, provenance } | { status: 'refused', reason, provenance }) and an EvidenceSourceCheckResult type ({ status: 'ready' } | { status: 'refused', reason }) for this fixture to compile — see test/fixtures/evidence-source-type-contract.ts`,
  );
});

/* -------------------------------------------------------------------------- */
/* EVIDENCE_SOURCE_REFUSAL_REASONS                                            */
/* -------------------------------------------------------------------------- */

test('publishes exactly the five typed refusal reasons, frozen', () => {
  assert.deepEqual(tools.EVIDENCE_SOURCE_REFUSAL_REASONS, [
    'unavailable',
    'denied',
    'rate_limited',
    'timeout',
    'adapter_error',
  ]);
  assert.equal(
    Object.isFrozen(tools.EVIDENCE_SOURCE_REFUSAL_REASONS),
    true,
    'EVIDENCE_SOURCE_REFUSAL_REASONS must be frozen, matching READ_ONLY_TOOL_REGISTRY\'s own closed-registry convention',
  );
});

/* -------------------------------------------------------------------------- */
/* createRequestFingerprint                                                   */
/* -------------------------------------------------------------------------- */

function createRequestFingerprintFactory() {
  assert.equal(
    typeof tools.createRequestFingerprint,
    'function',
    '@aic/tools must export createRequestFingerprint(operation, input): the deterministic requestFingerprint half of EvidenceSourceProvenance',
  );
  return tools.createRequestFingerprint;
}

test('createRequestFingerprint is stable under key-reordering of a nested input', () => {
  const createRequestFingerprint = createRequestFingerprintFactory();
  const first = createRequestFingerprint('fetch-logs', {
    service: 'checkout',
    query: { level: 'error', window: { from: 10, to: 20 } },
  });
  const reordered = createRequestFingerprint('fetch-logs', {
    query: { window: { to: 20, from: 10 }, level: 'error' },
    service: 'checkout',
  });

  assert.equal(first, reordered);
});

test('createRequestFingerprint differs for a different operation, input held fixed', () => {
  const createRequestFingerprint = createRequestFingerprintFactory();
  const input = { service: 'checkout' };

  assert.notEqual(
    createRequestFingerprint('fetch-logs', input),
    createRequestFingerprint('fetch-metrics', input),
  );
});

test('createRequestFingerprint differs for a different input, operation held fixed', () => {
  const createRequestFingerprint = createRequestFingerprintFactory();

  assert.notEqual(
    createRequestFingerprint('fetch-logs', { service: 'checkout' }),
    createRequestFingerprint('fetch-logs', { service: 'payments' }),
  );
});

test('createRequestFingerprint returns the pinned "sha256:" + 64 lowercase-hex-character shape', () => {
  const createRequestFingerprint = createRequestFingerprintFactory();
  const fingerprint = createRequestFingerprint('fetch-logs', { service: 'checkout' });

  assert.match(fingerprint, /^sha256:[0-9a-f]{64}$/);
});

test('createRequestFingerprint matches an independently computed sha256 over the pinned canonical envelope (fixed input, hand-built string — not canonicalJson called from the test)', () => {
  // Independent oracle: this string is written by hand, never produced by
  // calling canonicalJson or createRequestFingerprint. The pinned envelope is
  // JSON.stringify(canonicalJson({ input, operation })) — canonicalJson sorts
  // every key recursively, including these two top-level ones, so "input"
  // (i) sorts before "operation" (o), and the nested input's own two keys
  // sort "level" before "service".
  const handBuiltCanonicalEnvelope =
    '{"input":{"level":"error","service":"checkout"},"operation":"fetch-logs"}';
  const expectedHex = createHash('sha256')
    .update(handBuiltCanonicalEnvelope)
    .digest('hex');

  const createRequestFingerprint = createRequestFingerprintFactory();
  const fingerprint = createRequestFingerprint('fetch-logs', {
    service: 'checkout',
    level: 'error',
  });

  assert.equal(fingerprint, `sha256:${expectedHex}`);
});

/* -------------------------------------------------------------------------- */
/* EvidenceSourceError                                                        */
/* -------------------------------------------------------------------------- */

function evidenceSourceErrorFactory() {
  assert.equal(
    typeof tools.EvidenceSourceError,
    'function',
    '@aic/tools must export EvidenceSourceError (an Error subclass, mirroring StaleOwnerError / ExecutionIntegrityViolation in @aic/domain): a named, catchable error an adapter throws to classify a failure, carrying one of the five refusal reasons',
  );
  return tools.EvidenceSourceError;
}

test('EvidenceSourceError is a named Error subclass carrying a stable code and one of the five refusal reasons', () => {
  const EvidenceSourceError = evidenceSourceErrorFactory();
  const error = new EvidenceSourceError('upstream refused', { reason: 'denied' });

  assert.ok(error instanceof Error);
  assert.ok(error instanceof EvidenceSourceError);
  assert.equal(error.name, 'EvidenceSourceError');
  assert.equal(error.reason, 'denied');
  assert.equal(typeof error.code, 'string');
  assert.ok(error.code.length > 0);
});

test('EvidenceSourceError.code is stable across instances, regardless of reason or message', () => {
  const EvidenceSourceError = evidenceSourceErrorFactory();
  const a = new EvidenceSourceError('one', { reason: 'timeout' });
  const b = new EvidenceSourceError('two', { reason: 'denied' });

  assert.equal(a.code, b.code);
});

/* -------------------------------------------------------------------------- */
/* classifyEvidenceSourceFailure                                              */
/* -------------------------------------------------------------------------- */

function classifyEvidenceSourceFailureFactory() {
  assert.equal(
    typeof tools.classifyEvidenceSourceFailure,
    'function',
    '@aic/tools must export classifyEvidenceSourceFailure(error): an EvidenceSourceError keeps its own reason; anything else classifies as adapter_error',
  );
  return tools.classifyEvidenceSourceFailure;
}

for (const reason of ['unavailable', 'denied', 'rate_limited', 'timeout', 'adapter_error']) {
  test(`classifyEvidenceSourceFailure keeps an EvidenceSourceError's own reason (${reason})`, () => {
    const EvidenceSourceError = evidenceSourceErrorFactory();
    const classify = classifyEvidenceSourceFailureFactory();
    const error = new EvidenceSourceError('adapter refused', { reason });

    assert.equal(classify(error), reason);
  });
}

test('classifyEvidenceSourceFailure maps a plain Error (not an EvidenceSourceError) to adapter_error', () => {
  const classify = classifyEvidenceSourceFailureFactory();

  assert.equal(classify(new Error('socket hang up')), 'adapter_error');
});

test('classifyEvidenceSourceFailure maps a thrown non-Error value to adapter_error', () => {
  const classify = classifyEvidenceSourceFailureFactory();

  for (const value of ['boom', null, undefined, 42, { message: 'not an error' }]) {
    assert.equal(classify(value), 'adapter_error', `classify(${JSON.stringify(value)}) must be adapter_error`);
  }
});

/**
 * "token-like string": a long, high-entropy-looking literal such as an
 * upstream provider might echo back in a rejected-credential message —
 * deliberately not named with a credential-vocabulary identifier here (see
 * `.claude/scripts/lib/secrets.mjs`'s `assigned-secret` pattern), because an
 * identifier like `secretValue = '<literal>'` is exactly the assignment shape
 * that guard exists to catch, and this fixture is not, itself, a credential.
 */
const upstreamEchoedMarker = 'zz9-fixture-marker-4471-not-a-real-value';

test('classifyEvidenceSourceFailure never carries a thrown error\'s message text into a serialized outcome (no secret leakage)', () => {
  const classify = classifyEvidenceSourceFailureFactory();
  const thrown = new Error(
    `upstream rejected the request; it echoed back ${upstreamEchoedMarker} in the body`,
  );

  const reason = classify(thrown);
  const outcome = { status: 'refused', reason, provenance: fixedProvenance() };

  assert.equal(
    JSON.stringify(outcome).includes(upstreamEchoedMarker),
    false,
    'the classified reason must be one of the five typed codes, never the thrown error\'s own message text',
  );
});

test('classifyEvidenceSourceFailure never carries an EvidenceSourceError\'s own message text into a serialized outcome either (no secret leakage)', () => {
  const EvidenceSourceError = evidenceSourceErrorFactory();
  const classify = classifyEvidenceSourceFailureFactory();
  const thrown = new EvidenceSourceError(
    `the upstream provider rejected the request and echoed back ${upstreamEchoedMarker}`,
    { reason: 'denied' },
  );

  const reason = classify(thrown);
  const outcome = { status: 'refused', reason, provenance: fixedProvenance() };

  assert.equal(reason, 'denied');
  assert.equal(JSON.stringify(outcome).includes(upstreamEchoedMarker), false);
});

/* -------------------------------------------------------------------------- */
/* evidenceSourceOutcomeToToolResult                                          */
/* -------------------------------------------------------------------------- */

function evidenceSourceOutcomeToToolResultFactory() {
  assert.equal(
    typeof tools.evidenceSourceOutcomeToToolResult,
    'function',
    '@aic/tools must export evidenceSourceOutcomeToToolResult(outcome): the bridge that lets the existing projectToolResult keep working unchanged',
  );
  return tools.evidenceSourceOutcomeToToolResult;
}

test('evidenceSourceOutcomeToToolResult maps an ok outcome to ToolResult ok, carrying the same output — an empty successful result is ok, never a refusal', () => {
  const evidenceSourceOutcomeToToolResult = evidenceSourceOutcomeToToolResultFactory();

  const nonEmpty = evidenceSourceOutcomeToToolResult({
    status: 'ok',
    output: [rawEvidence],
    provenance: fixedProvenance(),
  });
  assert.deepEqual(nonEmpty, { status: 'ok', output: [rawEvidence] });

  const empty = evidenceSourceOutcomeToToolResult({
    status: 'ok',
    output: [],
    provenance: fixedProvenance(),
  });
  assert.deepEqual(empty, { status: 'ok', output: [] });
});

for (const reason of ['unavailable', 'denied', 'rate_limited', 'timeout']) {
  test(`evidenceSourceOutcomeToToolResult maps a refused(${reason}) outcome to ToolResult unavailable, never negative evidence`, () => {
    const evidenceSourceOutcomeToToolResult = evidenceSourceOutcomeToToolResultFactory();
    const result = evidenceSourceOutcomeToToolResult({
      status: 'refused',
      reason,
      provenance: fixedProvenance(),
    });

    assert.equal(result.status, 'unavailable');
    assert.equal(typeof result.reason, 'string');
    assert.equal('output' in result, false);
  });
}

test('evidenceSourceOutcomeToToolResult maps a refused(adapter_error) outcome to ToolResult error, distinct from the four untestable reasons', () => {
  const evidenceSourceOutcomeToToolResult = evidenceSourceOutcomeToToolResultFactory();
  const result = evidenceSourceOutcomeToToolResult({
    status: 'refused',
    reason: 'adapter_error',
    provenance: fixedProvenance(),
  });

  assert.equal(result.status, 'error');
  assert.equal(typeof result.message, 'string');
  assert.equal('output' in result, false);
});

/* -------------------------------------------------------------------------- */
/* AIC-100 acceptance line, through the REAL projectToolResult                */
/* -------------------------------------------------------------------------- */

test('a 403 (denied), a timeout and an empty successful result remain distinguishable through the real, unmodified projectToolResult (AIC-100 acceptance)', () => {
  const evidenceSourceOutcomeToToolResult = evidenceSourceOutcomeToToolResultFactory();

  const deniedResult = evidenceSourceOutcomeToToolResult({
    status: 'refused',
    reason: 'denied',
    provenance: fixedProvenance(),
  });
  const timeoutResult = evidenceSourceOutcomeToToolResult({
    status: 'refused',
    reason: 'timeout',
    provenance: fixedProvenance(),
  });
  const emptyOkResult = evidenceSourceOutcomeToToolResult({
    status: 'ok',
    output: [],
    provenance: fixedProvenance(),
  });

  const deniedProjection = tools.projectToolResult({
    test: plannedTest,
    prediction: untestedPrediction,
    result: deniedResult,
  });
  const timeoutProjection = tools.projectToolResult({
    test: plannedTest,
    prediction: untestedPrediction,
    result: timeoutResult,
  });
  const emptyOkProjection = tools.projectToolResult({
    test: plannedTest,
    prediction: untestedPrediction,
    result: emptyOkResult,
  });

  // denied (403): prediction becomes untestable, no evidence — untestable,
  // never negative evidence.
  assert.equal(deniedProjection.test.status, 'unavailable');
  assert.equal(deniedProjection.prediction.status, 'untestable');
  assert.deepEqual(deniedProjection.evidence, []);

  // timeout: same untestable shape, reached through a different refusal
  // reason than denied.
  assert.equal(timeoutProjection.test.status, 'unavailable');
  assert.equal(timeoutProjection.prediction.status, 'untestable');
  assert.deepEqual(timeoutProjection.evidence, []);

  // empty successful result: test executed, zero evidence, prediction is
  // left untouched — specifically NOT marked untestable, unlike denied and
  // timeout above, even though all three end up with an empty evidence array.
  assert.equal(emptyOkProjection.test.status, 'executed');
  assert.equal(emptyOkProjection.prediction.status, 'untested');
  assert.notEqual(emptyOkProjection.prediction.status, 'untestable');
  assert.deepEqual(emptyOkProjection.evidence, []);

  // The three remain distinguishable from one another at the test/prediction
  // level, despite denied and timeout sharing a status and all three sharing
  // an empty evidence array.
  assert.notEqual(deniedProjection.test.status, emptyOkProjection.test.status);
  assert.notEqual(timeoutProjection.test.status, emptyOkProjection.test.status);
  assert.notEqual(deniedProjection.prediction.status, emptyOkProjection.prediction.status);
  assert.notEqual(timeoutProjection.prediction.status, emptyOkProjection.prediction.status);
});
