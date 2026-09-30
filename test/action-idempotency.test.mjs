/**
 * AIC-21 slice 2: `deriveActionIdempotencyKey`, the logical identity of a
 * proposed action — which mutation, where, and on which incident. It
 * describes the operation, never the justification: `reason`, `evidenceIds`,
 * `expectedOutcome`, `blastRadius`, `rollbackPlan`, `preconditions` and
 * `proposedBy` never feed it, and neither does a worker id, an execution
 * attempt, a lease id, a retry count or a process id. Two proposals of the
 * same operation with different justifications are the same operation; a
 * retry of the same operation by a different worker is still the same
 * operation.
 *
 * It is not an exec key: `durable-execution-contract.test.mjs` pins that no
 * `action.*` operation is ever registered in `buildExecKey`'s closed
 * registry, so this identity is domain-tagged `aic.action` and built without
 * touching that registry at all — its shape and `ExecKeySchema`'s are
 * disjoint by construction, checked below.
 *
 * ## Oracle discipline (`.claude/rules/invariants.md`, "the independent-oracle
 * invariant")
 *
 * The one row that pins the exact digest computes its expected value with
 * this file's OWN `createHash` call over a hand-written tuple — laid out
 * with the params object's keys already in canonical JSON's sorted order —
 * and freezes that digest as a literal constant.
 * `deriveActionIdempotencyKey` is never called to produce an expected value
 * anywhere in this file; every other row either compares two of its own
 * outputs for (in)equality (a mutation-sensitivity property, not a value
 * claim) or compares its output against the frozen literal / a reused,
 * separately-tested schema (`IdempotencyKeySchema`, `ExecKeySchema`).
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { dirname, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import * as domain from '@aic/domain';

import { childEnv } from './fixtures/child-env.mjs';

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const fixtureServiceId = '11111111-1111-4111-8111-111111111111';
const fixtureEnvironmentId = '22222222-2222-4222-8222-222222222222';
const fixtureIncidentId = 'incident-42';
const fixtureActionType = 'incident-comment';
const fixtureParamsSortedKeys = Object.freeze({ body: 'checkout error rate spike', severity: 'high' });

/**
 * The literal digest of `['aic.action', 1, fixtureServiceId,
 * fixtureEnvironmentId, fixtureIncidentId, fixtureActionType,
 * fixtureParamsSortedKeys]`, computed once and frozen here. The first row
 * below re-derives it independently, from this file's own `createHash` call,
 * and checks the two agree before ever comparing against production.
 */
const FROZEN_DIGEST_HEX = 'ee50ccdaa607de07df0bdea2e3eca6a1a5a09c91e8ff62c5f26800aad333c9e9';
const FROZEN_KEY = `sha256:${FROZEN_DIGEST_HEX}`;

const fixtureParts = () => ({
  incidentId: fixtureIncidentId,
  primaryScope: { serviceId: fixtureServiceId, environmentId: fixtureEnvironmentId },
  actionType: fixtureActionType,
  params: fixtureParamsSortedKeys,
});

/* -------------------------------------------------------------------------- */
/* Row — the literal digest of the documented tuple                           */
/* -------------------------------------------------------------------------- */

test('deriveActionIdempotencyKey equals the literal digest of the documented tuple: aic.action, version 1, serviceId, environmentId, incidentId, actionType, canonical params', () => {
  const handWrittenTuple = [
    'aic.action',
    1,
    fixtureServiceId,
    fixtureEnvironmentId,
    fixtureIncidentId,
    fixtureActionType,
    // Keys already in the sorted order canonical JSON produces (body < severity).
    { body: 'checkout error rate spike', severity: 'high' },
  ];
  const reDerivedDigest = createHash('sha256').update(JSON.stringify(handWrittenTuple)).digest('hex');

  assert.equal(
    reDerivedDigest,
    FROZEN_DIGEST_HEX,
    'sanity: the hand-written tuple must hash to the frozen literal constant, or the constant itself has drifted',
  );
  assert.equal(domain.deriveActionIdempotencyKey(fixtureParts()), `sha256:${reDerivedDigest}`);
});

/* -------------------------------------------------------------------------- */
/* Row — stable under params key reordering                                   */
/* -------------------------------------------------------------------------- */

test('the key is stable under params key reordering', () => {
  const bodyFirst = { body: 'checkout error rate spike', severity: 'high' };
  const severityFirst = { severity: 'high', body: 'checkout error rate spike' };

  const keyFromBodyFirst = domain.deriveActionIdempotencyKey({ ...fixtureParts(), params: bodyFirst });
  const keyFromSeverityFirst = domain.deriveActionIdempotencyKey({ ...fixtureParts(), params: severityFirst });

  assert.equal(keyFromBodyFirst, FROZEN_KEY);
  assert.equal(keyFromSeverityFirst, FROZEN_KEY);
});

/* -------------------------------------------------------------------------- */
/* Row — extra parts are refused, not silently carried through                */
/* -------------------------------------------------------------------------- */

test('deriveActionIdempotencyKey refuses extra parts: workerId, executionAttempt, leaseId, retry, pid', () => {
  for (const extraKey of ['workerId', 'executionAttempt', 'leaseId', 'retry', 'pid']) {
    assert.throws(
      () => domain.deriveActionIdempotencyKey({ ...fixtureParts(), [extraKey]: 'x' }),
      `an extra part named "${extraKey}" must throw rather than pass through silently`,
    );
  }
});

/* -------------------------------------------------------------------------- */
/* Row — deterministic across a genuinely separate process                    */
/* -------------------------------------------------------------------------- */

/**
 * Reads the operation parts as JSON on stdin, derives the key with the
 * BUILT `@aic/domain` package (the workspace symlink under node_modules,
 * exactly as every other suite file imports it), and writes the bare key to
 * stdout. `node --test` auto-discovers `test/`, but this script is never a
 * file on disk under `test/` — it exists only as this in-process string
 * handed to `node -e` — so there is no accidental second test run to guard
 * against.
 */
const CHILD_SCRIPT = [
  "const parts = JSON.parse(require('node:fs').readFileSync(0, 'utf8'));",
  "import('@aic/domain').then((domain) => {",
  '  process.stdout.write(domain.deriveActionIdempotencyKey(parts));',
  '});',
].join('\n');

test('the key computed in a child process equals the in-process key and the frozen constant', () => {
  const outcome = spawnSync(
    process.execPath,
    ['--import', './test/fixtures/no-ambient-tracing.mjs', '-e', CHILD_SCRIPT],
    {
      cwd: projectRoot,
      encoding: 'utf8',
      input: JSON.stringify(fixtureParts()),
      env: childEnv(),
    },
  );

  assert.equal(
    outcome.status,
    0,
    `child process exited ${outcome.status}\nstdout:\n${outcome.stdout}\nstderr:\n${outcome.stderr}`,
  );
  assert.equal(outcome.stdout, FROZEN_KEY);
  assert.equal(outcome.stdout, domain.deriveActionIdempotencyKey(fixtureParts()));
});

/* -------------------------------------------------------------------------- */
/* Row — sensitivity to the operation, and exclusion of the justification     */
/* -------------------------------------------------------------------------- */

test('a changed incidentId, environmentId, actionType or params gives a different key', () => {
  const baseline = domain.deriveActionIdempotencyKey(fixtureParts());

  assert.notEqual(domain.deriveActionIdempotencyKey({ ...fixtureParts(), incidentId: 'incident-43' }), baseline);
  assert.notEqual(
    domain.deriveActionIdempotencyKey({
      ...fixtureParts(),
      primaryScope: { serviceId: fixtureServiceId, environmentId: randomUUID() },
    }),
    baseline,
  );
  assert.notEqual(
    domain.deriveActionIdempotencyKey({ ...fixtureParts(), actionType: 'create-follow-up-ticket' }),
    baseline,
  );
  assert.notEqual(
    domain.deriveActionIdempotencyKey({ ...fixtureParts(), params: { body: 'a different body entirely' } }),
    baseline,
  );
});

test('the key does not depend on reason, evidenceIds, expectedOutcome or rollbackPlan: two proposals for the same operation share one key regardless', () => {
  const proposalA = {
    ...fixtureParts(),
    reason: 'first justification',
    evidenceIds: ['evidence-1'],
    expectedOutcome: { statement: 'a', observations: [] },
    rollbackPlan: { strategy: 'manual-steps', steps: ['undo'] },
  };
  const proposalB = {
    ...fixtureParts(),
    reason: 'a completely different justification',
    evidenceIds: ['evidence-2', 'evidence-3'],
    expectedOutcome: { statement: 'b', observations: [] },
    rollbackPlan: { strategy: 'compensating-action', description: 'revert the comment' },
  };
  const operationIdentity = ({ incidentId, primaryScope, actionType, params }) => ({
    incidentId,
    primaryScope,
    actionType,
    params,
  });

  assert.equal(
    domain.deriveActionIdempotencyKey(operationIdentity(proposalA)),
    domain.deriveActionIdempotencyKey(operationIdentity(proposalB)),
    'reason, evidenceIds, expectedOutcome and rollbackPlan must never be part of the operation identity',
  );
});

/* -------------------------------------------------------------------------- */
/* Row — the key's own shape, and its separation from ExecKeySchema           */
/* -------------------------------------------------------------------------- */

test("the key has IdempotencyKeySchema's shape and is not an ExecKeySchema string", () => {
  const key = domain.deriveActionIdempotencyKey(fixtureParts());

  assert.equal(domain.IdempotencyKeySchema.safeParse(key).success, true, 'the key must match sha256:<64 hex>');
  assert.equal(
    domain.ExecKeySchema.safeParse(key).success,
    false,
    'the key must never also satisfy ExecKeySchema\'s <op>/sha256:<64 hex> shape',
  );
});
