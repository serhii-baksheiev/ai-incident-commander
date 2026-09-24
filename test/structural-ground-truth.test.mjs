/**
 * AIC-105 (v0.2 evidence repair, slice 0b): structural evidence and root-cause
 * ground truth, as a table the v0.3 behavior evaluator reads instead of the
 * v0.1/v0.2 fingerprint-equality machinery.
 *
 * The rows pin what `@aic/evals` exports from
 * `packages/evals/src/structural-ground-truth.ts`:
 *   - `STRUCTURAL_GROUND_TRUTH_VERSION`
 *   - `ROOT_CAUSE_MECHANISMS`
 *   - `STRUCTURAL_GROUND_TRUTH`
 *   - `structuralGroundTruthFor(scenarioId)`
 *   - `matchesRootCause(truth, claimed)`
 *
 * Every expected value below is written literally — never computed by calling
 * the production code this file tests (`.claude/rules/invariants.md`,
 * "independent-oracle invariant"). The cross-checks against
 * `evals.REPLAY_SCENARIOS` and `evals.shownEvidenceOf` are read against the
 * ACCEPTED v0.1 fixture and ground truth, which is a different, frozen
 * mechanism from the structural table under test — an independent oracle, not
 * the same computation run twice.
 *
 * The hold-out rows (`incomplete-evidence`, `challenge-changes-leader`) are
 * ground-truth LABELS only, pinned here like every other row. No test in this
 * file runs a hold-out scenario through an arm.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import * as evals from '@aic/evals';

/* -------------------------------------------------------------------------- */
/* STRUCTURAL_GROUND_TRUTH_VERSION, ROOT_CAUSE_MECHANISMS                     */
/* -------------------------------------------------------------------------- */

test('STRUCTURAL_GROUND_TRUTH_VERSION is pinned', () => {
  assert.equal(evals.STRUCTURAL_GROUND_TRUTH_VERSION, 'structural-ground-truth-v1');
});

test('ROOT_CAUSE_MECHANISMS is pinned to exactly these three mechanisms, frozen', () => {
  assert.deepEqual(evals.ROOT_CAUSE_MECHANISMS, [
    'deployment-regression',
    'connection-pool-exhaustion',
    'cache-stampede',
  ]);
  assert.equal(Object.isFrozen(evals.ROOT_CAUSE_MECHANISMS), true);
});

/* -------------------------------------------------------------------------- */
/* STRUCTURAL_GROUND_TRUTH: literal table, keying, and freezing               */
/* -------------------------------------------------------------------------- */

const EXPECTED_STRUCTURAL_GROUND_TRUTH = {
  'bad-deployment': {
    expectedEvidenceIds: ['checkout-deploy-v42', 'checkout-invalid-database-endpoint'],
    rootCause: { component: 'checkout', mechanism: 'deployment-regression' },
  },
  'db-pool-exhaustion': {
    expectedEvidenceIds: ['checkout-db-pool-active', 'checkout-db-pool-timeout'],
    rootCause: { component: 'checkout-db-pool', mechanism: 'connection-pool-exhaustion' },
  },
  'false-alert': {
    expectedEvidenceIds: ['checkout-normal-error-rate', 'checkout-no-server-errors'],
  },
  'deployment-caused-incident-a': {
    expectedEvidenceIds: ['confirmation-deploy-v17'],
    rootCause: { component: 'payments', mechanism: 'deployment-regression' },
  },
  'dependency-caused-incident-b': {
    expectedEvidenceIds: ['inventory-api-pool-saturation'],
    misleadingEvidenceIds: ['confirmation-deploy-v17'],
    rootCause: { component: 'inventory-api', mechanism: 'connection-pool-exhaustion' },
  },
  'multiple-plausible-causes': {
    expectedEvidenceIds: ['payments-error-rate-incident', 'inventory-api-latency-incident'],
  },
  'transient-self-resolved': {
    expectedEvidenceIds: ['payments-cache-transient-saturation', 'payments-cache-refill-ended'],
    rootCause: { component: 'payments-cache', mechanism: 'cache-stampede' },
  },
  'challenge-keeps-leader': {
    expectedEvidenceIds: ['payments-v19-before-timeouts', 'payments-v19-authorization-timeouts'],
    rootCause: { component: 'payments', mechanism: 'deployment-regression' },
  },
  'incomplete-evidence': {
    expectedEvidenceIds: ['checkout-intermittent-upstream-timeout'],
  },
  'challenge-changes-leader': {
    expectedEvidenceIds: ['inventory-api-challenge-saturation'],
    misleadingEvidenceIds: ['payments-deployment-overlap'],
    rootCause: { component: 'inventory-api', mechanism: 'connection-pool-exhaustion' },
  },
};

test('STRUCTURAL_GROUND_TRUTH is keyed by exactly the ids REPLAY_SCENARIOS declares, in both directions', () => {
  const scenarioIds = new Set(evals.REPLAY_SCENARIOS.map(({ id }) => id));
  const structuralIds = new Set(Object.keys(evals.STRUCTURAL_GROUND_TRUTH ?? {}));
  assert.deepEqual([...structuralIds].sort(), [...scenarioIds].sort());
});

test('STRUCTURAL_GROUND_TRUTH pins exactly this table, entry for entry', () => {
  assert.deepEqual(evals.STRUCTURAL_GROUND_TRUTH, EXPECTED_STRUCTURAL_GROUND_TRUTH);
});

test('STRUCTURAL_GROUND_TRUTH and every entry, array and nested object inside it are frozen', () => {
  assert.equal(Object.isFrozen(evals.STRUCTURAL_GROUND_TRUTH), true);
  for (const entry of Object.values(evals.STRUCTURAL_GROUND_TRUTH)) {
    assert.equal(Object.isFrozen(entry), true);
    assert.equal(Object.isFrozen(entry.expectedEvidenceIds), true);
    if (entry.misleadingEvidenceIds !== undefined) {
      assert.equal(Object.isFrozen(entry.misleadingEvidenceIds), true);
    }
    if (entry.rootCause !== undefined) {
      assert.equal(Object.isFrozen(entry.rootCause), true);
    }
  }
});

/* -------------------------------------------------------------------------- */
/* Structural invariants, read against the accepted v0.1 fixture/ground truth */
/* -------------------------------------------------------------------------- */

test('every expected and misleading id the structural table names is an evidence id the scenario\'s own fixture actually shows', () => {
  for (const scenario of evals.REPLAY_SCENARIOS) {
    const entry = evals.STRUCTURAL_GROUND_TRUTH[scenario.id];
    assert.ok(entry, `no structural ground truth for scenario ${scenario.id}`);
    const shownIds = new Set(evals.shownEvidenceOf(scenario.fixture).map(({ id }) => id));
    for (const id of entry.expectedEvidenceIds) {
      assert.ok(shownIds.has(id), `${scenario.id}: expected id ${id} is not shown by its own fixture`);
    }
    for (const id of entry.misleadingEvidenceIds ?? []) {
      assert.ok(shownIds.has(id), `${scenario.id}: misleading id ${id} is not shown by its own fixture`);
    }
  }
});

test('a structural rootCause is present if and only if the accepted ground truth declares one, and names the same component', () => {
  for (const scenario of evals.REPLAY_SCENARIOS) {
    const entry = evals.STRUCTURAL_GROUND_TRUTH[scenario.id];
    assert.ok(entry, `no structural ground truth for scenario ${scenario.id}`);
    const acceptedRootCause = scenario.groundTruth.rootCause;
    assert.equal(
      entry.rootCause !== undefined,
      acceptedRootCause !== undefined,
      `${scenario.id}: rootCause presence disagrees with the accepted ground truth`,
    );
    if (acceptedRootCause !== undefined) {
      assert.equal(
        entry.rootCause.component,
        acceptedRootCause.component,
        `${scenario.id}: structural rootCause component disagrees with the accepted one`,
      );
    }
  }
});

test('expectedEvidenceIds/misleadingEvidenceIds counts match the accepted expectedEvidence/misleadingEvidence lengths', () => {
  for (const scenario of evals.REPLAY_SCENARIOS) {
    const entry = evals.STRUCTURAL_GROUND_TRUTH[scenario.id];
    assert.ok(entry, `no structural ground truth for scenario ${scenario.id}`);
    assert.equal(
      entry.expectedEvidenceIds.length,
      scenario.groundTruth.expectedEvidence.length,
      `${scenario.id}: expectedEvidenceIds length disagrees with the accepted expectedEvidence length`,
    );
    assert.equal(
      entry.misleadingEvidenceIds !== undefined,
      scenario.groundTruth.misleadingEvidence !== undefined,
      `${scenario.id}: misleadingEvidenceIds presence disagrees with the accepted misleadingEvidence`,
    );
    assert.equal(
      entry.misleadingEvidenceIds?.length ?? 0,
      scenario.groundTruth.misleadingEvidence?.length ?? 0,
      `${scenario.id}: misleadingEvidenceIds length disagrees with the accepted misleadingEvidence length`,
    );
  }
});

test('every mechanism the structural table names is a member of ROOT_CAUSE_MECHANISMS', () => {
  for (const [scenarioId, entry] of Object.entries(evals.STRUCTURAL_GROUND_TRUTH)) {
    if (entry.rootCause === undefined) continue;
    assert.ok(
      evals.ROOT_CAUSE_MECHANISMS.includes(entry.rootCause.mechanism),
      `${scenarioId}: mechanism ${entry.rootCause.mechanism} is outside ROOT_CAUSE_MECHANISMS`,
    );
  }
});

/* -------------------------------------------------------------------------- */
/* structuralGroundTruthFor                                                   */
/* -------------------------------------------------------------------------- */

test('structuralGroundTruthFor returns the table entry for a known scenario id', () => {
  assert.deepEqual(
    evals.structuralGroundTruthFor('bad-deployment'),
    EXPECTED_STRUCTURAL_GROUND_TRUTH['bad-deployment'],
  );
});

test('structuralGroundTruthFor throws for a scenario id the table does not name', () => {
  assert.throws(() => evals.structuralGroundTruthFor('not-a-real-scenario'));
});

/* -------------------------------------------------------------------------- */
/* matchesRootCause                                                           */
/* -------------------------------------------------------------------------- */

const inventoryApiTruth = Object.freeze({
  component: 'inventory-api',
  mechanism: 'connection-pool-exhaustion',
});

test('matchesRootCause fails on a wrong component', () => {
  assert.equal(
    evals.matchesRootCause(inventoryApiTruth, {
      component: 'payments',
      mechanism: 'connection-pool-exhaustion',
    }),
    false,
  );
});

test('matchesRootCause fails on a wrong mechanism that is still in the taxonomy', () => {
  assert.equal(
    evals.matchesRootCause(inventoryApiTruth, {
      component: 'inventory-api',
      mechanism: 'deployment-regression',
    }),
    false,
  );
});

test('matchesRootCause passes with a different trigger, and with no trigger at all', () => {
  assert.equal(
    evals.matchesRootCause(inventoryApiTruth, {
      component: 'inventory-api',
      mechanism: 'connection-pool-exhaustion',
      trigger: 'a trigger the ground truth never named',
    }),
    true,
  );
  assert.equal(
    evals.matchesRootCause(inventoryApiTruth, {
      component: 'inventory-api',
      mechanism: 'connection-pool-exhaustion',
    }),
    true,
  );
});

test('matchesRootCause matches the component after trim and lowercase', () => {
  assert.equal(
    evals.matchesRootCause(inventoryApiTruth, {
      component: ' Inventory-API ',
      mechanism: 'connection-pool-exhaustion',
    }),
    true,
  );
});

test('matchesRootCause fails closed on the accepted v0.1 prose mechanism for the same component', () => {
  assert.equal(
    evals.matchesRootCause(inventoryApiTruth, {
      component: 'inventory-api',
      mechanism: 'dependency connection pool saturation',
    }),
    false,
  );
});

test('matchesRootCause fails closed on a case variant of the mechanism, because the taxonomy match is exact', () => {
  assert.equal(
    evals.matchesRootCause(inventoryApiTruth, {
      component: 'inventory-api',
      mechanism: 'Connection-Pool-Exhaustion',
    }),
    false,
  );
});

test('matchesRootCause fails on an undefined claimed cause', () => {
  assert.equal(evals.matchesRootCause(inventoryApiTruth, undefined), false);
});
