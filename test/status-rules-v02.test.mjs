/**
 * AIC-119 slice 1: status rules v0.2 adds a `corroborated` hypothesis status.
 *
 * Semantics (owner ruling D1, item 1-2; also `status-rules.ts` and
 * `evaluation.ts`):
 *   - `corroborated`: at least two DISTINCT `evidenceId`s assessed `supports`
 *     at medium or high strength (the same independence key `supported`
 *     uses), no `contradicts` assessment at medium or high strength, and ZERO
 *     confirmed predictions of this hypothesis. "Consistent with the evidence,
 *     independently" — not "survived a prediction test".
 *   - `supported`: unchanged from v0.1 — the corroborated requirements PLUS
 *     at least one confirmed prediction. An untested, untestable or refuted
 *     prediction is "not confirmed"; it is never read as "no predictions" to
 *     let a hypothesis skip straight to `supported`.
 *   - Check order (owner ruling item 9): rejected, weakened, supported,
 *     corroborated, candidate — every check scoped to one hypothesis.
 *
 * `rulesVersion` is optional on `deriveHypothesisStatus`; the default is the
 * current `STATUS_RULES_VERSION`, an unknown version throws, and v0.1 stays
 * reproducible on demand so historical evidence and evaluation keep meaning
 * what they meant when it was recorded.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import * as domain from '@aic/domain';
import * as evals from '@aic/evals';

import {
  benchmarkVersions,
  replayBackedNodes,
  requireFunction,
} from './fixtures/benchmark-experiment.mjs';

const HYPOTHESIS = 'hypothesis-1';
const OTHER_HYPOTHESIS = 'hypothesis-2';

function requireStatusDeriver() {
  assert.equal(
    typeof domain.deriveHypothesisStatus,
    'function',
    '@aic/domain must publish deriveHypothesisStatus(options)',
  );
  return domain.deriveHypothesisStatus;
}

function requireStatusRulesTable() {
  assert.equal(
    typeof domain.STATUS_RULES,
    'object',
    '@aic/domain must publish STATUS_RULES, keyed by status-rules version',
  );
  assert.notEqual(
    domain.STATUS_RULES,
    null,
    '@aic/domain STATUS_RULES must not be null',
  );
  return domain.STATUS_RULES;
}

function predictionFor(id, hypothesisId, status) {
  return {
    id,
    hypothesisId,
    statement: `${hypothesisId} prediction ${id}`,
    expectedIfTrue: [{ observation: 'the predicted observation occurs' }],
    expectedIfFalse: [{ observation: 'the predicted observation does not occur' }],
    status,
  };
}

function evidenceFor(id, reliability = 'medium') {
  return {
    id,
    trialId: `trial-${id}`,
    kind: 'deploy',
    source: 'deployment-history',
    observedAt: '2026-09-24T08:00:00.000Z',
    statement: `observation recorded as ${id}`,
    rawRef: `replay://evidence/${id}`,
    reliability,
  };
}

function supportAssessment(evidenceId, strength, overrides = {}) {
  return {
    id: `support-${evidenceId}-${strength}`,
    evidenceId,
    hypothesisId: HYPOTHESIS,
    predictionId: undefined,
    effect: 'supports',
    strength,
    rationale: `supports at ${strength} strength from ${evidenceId}`,
    producedBy: 'rule',
    at: '2026-09-24T08:01:00.000Z',
    ...overrides,
  };
}

function contradictAssessment(evidenceId, strength, overrides = {}) {
  return {
    id: `contradict-${evidenceId}-${strength}`,
    evidenceId,
    hypothesisId: HYPOTHESIS,
    predictionId: undefined,
    effect: 'contradicts',
    strength,
    rationale: `contradicts at ${strength} strength from ${evidenceId}`,
    producedBy: 'rule',
    at: '2026-09-24T08:01:00.000Z',
    ...overrides,
  };
}

/**
 * Owner ruling item 9, mapped to constructed states. Every row is exercised
 * twice below: once under the default (current) rules, once pinned to
 * `rulesVersion: 'v0.1'` — the same grid, so the only thing that may differ
 * between the two runs is the rule, never the input.
 */
const GRID = [
  {
    name: 'two independent medium/high supports, no predictions at all',
    build: () => ({
      predictions: [],
      evidence: [evidenceFor('e1'), evidenceFor('e2')],
      assessments: [supportAssessment('e1', 'medium'), supportAssessment('e2', 'high')],
    }),
    v02: 'corroborated',
    v01: 'candidate',
  },
  {
    name: 'two independent medium/high supports, one untested prediction',
    build: () => ({
      predictions: [predictionFor('p-untested', HYPOTHESIS, 'untested')],
      evidence: [evidenceFor('e1'), evidenceFor('e2')],
      assessments: [supportAssessment('e1', 'medium'), supportAssessment('e2', 'high')],
    }),
    v02: 'corroborated',
    v01: 'candidate',
  },
  {
    name: 'a single support is not enough',
    build: () => ({
      predictions: [],
      evidence: [evidenceFor('e1')],
      assessments: [supportAssessment('e1', 'medium')],
    }),
    v02: 'candidate',
    v01: 'candidate',
  },
  {
    name: 'two supports on the SAME evidence id do not count as independent',
    build: () => ({
      predictions: [],
      evidence: [evidenceFor('e1')],
      assessments: [
        supportAssessment('e1', 'medium'),
        supportAssessment('e1', 'high', { id: 'support-e1-high-second' }),
      ],
    }),
    v02: 'candidate',
    v01: 'candidate',
  },
  {
    name: 'a second support at low strength does not count',
    build: () => ({
      predictions: [],
      evidence: [evidenceFor('e1'), evidenceFor('e2')],
      assessments: [supportAssessment('e1', 'medium'), supportAssessment('e2', 'low')],
    }),
    v02: 'candidate',
    v01: 'candidate',
  },
  {
    name: 'a material (medium-strength) contradiction beats two supports',
    build: () => ({
      predictions: [],
      evidence: [evidenceFor('e1'), evidenceFor('e2'), evidenceFor('e3')],
      assessments: [
        supportAssessment('e1', 'medium'),
        supportAssessment('e2', 'high'),
        contradictAssessment('e3', 'medium'),
      ],
    }),
    v02: 'weakened',
    v01: 'weakened',
  },
  {
    name: 'boundary: a low-strength contradiction is not material, so corroboration survives',
    build: () => ({
      predictions: [],
      evidence: [evidenceFor('e1'), evidenceFor('e2'), evidenceFor('e3')],
      assessments: [
        supportAssessment('e1', 'medium'),
        supportAssessment('e2', 'high'),
        contradictAssessment('e3', 'low'),
      ],
    }),
    v02: 'corroborated',
    v01: 'candidate',
  },
  {
    name: 'a confirmed prediction of ANOTHER hypothesis does not promote this one',
    build: () => ({
      predictions: [predictionFor('p-other', OTHER_HYPOTHESIS, 'confirmed')],
      evidence: [evidenceFor('e1'), evidenceFor('e2')],
      assessments: [supportAssessment('e1', 'medium'), supportAssessment('e2', 'high')],
    }),
    v02: 'corroborated',
    v01: 'candidate',
  },
  {
    name: 'a confirmed prediction of THIS hypothesis promotes corroborated to supported',
    build: () => ({
      predictions: [predictionFor('p-own', HYPOTHESIS, 'confirmed')],
      evidence: [evidenceFor('e1'), evidenceFor('e2')],
      assessments: [supportAssessment('e1', 'medium'), supportAssessment('e2', 'high')],
    }),
    v02: 'supported',
    v01: 'supported',
  },
  {
    name: 'an untestable prediction is not "no predictions"',
    build: () => ({
      predictions: [predictionFor('p-untestable', HYPOTHESIS, 'untestable')],
      evidence: [evidenceFor('e1'), evidenceFor('e2')],
      assessments: [supportAssessment('e1', 'medium'), supportAssessment('e2', 'high')],
    }),
    v02: 'corroborated',
    v01: 'candidate',
  },
  {
    name: 'a refuted prediction with no matching contradiction is not "no predictions"',
    build: () => ({
      predictions: [predictionFor('p-refuted', HYPOTHESIS, 'refuted')],
      evidence: [evidenceFor('e1'), evidenceFor('e2')],
      assessments: [supportAssessment('e1', 'medium'), supportAssessment('e2', 'high')],
    }),
    v02: 'corroborated',
    v01: 'candidate',
  },
  {
    name: 'a refuted prediction plus a contradiction on high-reliability evidence rejects outright',
    build: () => ({
      predictions: [predictionFor('p-refuted-2', HYPOTHESIS, 'refuted')],
      evidence: [evidenceFor('e1'), evidenceFor('e2'), evidenceFor('e-reject', 'high')],
      assessments: [
        supportAssessment('e1', 'medium'),
        supportAssessment('e2', 'high'),
        contradictAssessment('e-reject', 'medium', { predictionId: 'p-refuted-2' }),
      ],
    }),
    v02: 'rejected',
    v01: 'rejected',
  },
];

test('derives every v0.2 status-rules row from the owner ruling’s grid', () => {
  const deriveHypothesisStatus = requireStatusDeriver();

  for (const row of GRID) {
    const scenario = row.build();
    const result = deriveHypothesisStatus({ hypothesisId: HYPOTHESIS, ...scenario });
    assert.equal(result, row.v02, `v0.2 (default rules): ${row.name}`);
  }
});

test('reproduces v0.1 semantics on the identical grid, and never returns corroborated', () => {
  const deriveHypothesisStatus = requireStatusDeriver();

  for (const row of GRID) {
    const scenario = row.build();
    const result = deriveHypothesisStatus({
      hypothesisId: HYPOTHESIS,
      ...scenario,
      rulesVersion: 'v0.1',
    });
    assert.equal(result, row.v01, `v0.1: ${row.name}`);
    assert.notEqual(
      result,
      'corroborated',
      `rulesVersion: 'v0.1' must never produce corroborated: ${row.name}`,
    );
  }
});

test('never promotes a corroborated hypothesis to supported without a confirmed prediction of its own', () => {
  const deriveHypothesisStatus = requireStatusDeriver();
  const scenario = GRID[0].build();

  const result = deriveHypothesisStatus({ hypothesisId: HYPOTHESIS, ...scenario });

  assert.equal(result, 'corroborated');
  assert.notEqual(result, 'supported');
});

test('applies the current status-rules version by default', () => {
  const deriveHypothesisStatus = requireStatusDeriver();
  const scenario = GRID[0].build();

  const withDefault = deriveHypothesisStatus({ hypothesisId: HYPOTHESIS, ...scenario });
  const withExplicitCurrentVersion = deriveHypothesisStatus({
    hypothesisId: HYPOTHESIS,
    ...scenario,
    rulesVersion: domain.STATUS_RULES_VERSION,
  });

  assert.equal(withDefault, withExplicitCurrentVersion);
  assert.equal(withDefault, 'corroborated');
});

test('throws on an unknown status-rules version instead of silently falling back', () => {
  const deriveHypothesisStatus = requireStatusDeriver();

  assert.throws(
    () =>
      deriveHypothesisStatus({
        hypothesisId: HYPOTHESIS,
        predictions: [],
        assessments: [],
        evidence: [],
        rulesVersion: 'v9-does-not-exist',
      }),
    /status.?rules version|rulesVersion/i,
    'an unrecognised rulesVersion must be refused, not treated as the default',
  );
});

test('bumps STATUS_RULES_VERSION to v0.2', () => {
  assert.equal(domain.STATUS_RULES_VERSION, 'v0.2');
});

test('accepts corroborated as a hypothesis status, alongside the v0.1 statuses', () => {
  for (const status of ['candidate', 'supported', 'weakened', 'rejected', 'corroborated']) {
    assert.equal(
      domain.HypothesisStatusSchema.safeParse(status).success,
      true,
      `HypothesisStatusSchema must accept ${status}`,
    );
  }
});

/**
 * `STATUS_RULES['v0.1']` is checked against a literal copy of the frozen v0.1 table, written by
 * hand here rather than derived from `BASELINE_STATUS_RULES` — so a change to
 * the production table that quietly narrows or widens v0.1 shows up as a
 * mismatch against an independent expectation, not as a comparison of the
 * production table with itself.
 */
const EXPECTED_V01_TABLE = {
  version: 'v0.1',
  hypothesis: {
    statuses: ['candidate', 'supported', 'weakened', 'rejected'],
    derivedFrom: ['predictions', 'assessments'],
    numericConfidence: false,
    precedence: ['rejected', 'weakened', 'supported', 'candidate'],
    rules: {
      candidate: {
        fallback: true,
      },
      supported: {
        minimumIndependentSupports: 2,
        independenceKey: 'evidenceId',
        supportStrengths: ['medium', 'high'],
        forbiddenContradictionStrengths: ['medium', 'high'],
        minimumConfirmedPredictions: 1,
      },
      weakened: {
        contradictionStrengths: ['medium', 'high'],
      },
      rejected: {
        predictionStatus: 'refuted',
        evidenceReliability: 'high',
      },
    },
  },
};

/**
 * The v0.2 table, pinned exactly: `corroborated` sits between `supported` and
 * `candidate` in precedence, shares `supported`'s independence and strength
 * rules, and is separated from `supported` by exactly one field —
 * `minimumConfirmedPredictions: 1` on `supported` against
 * `maximumConfirmedPredictions: 0` on `corroborated`. A mutation that widens
 * either boundary (for example `>= 0`, or dropping the corroborated cap)
 * reddens this row.
 */
const EXPECTED_V02_TABLE = {
  version: 'v0.2',
  hypothesis: {
    statuses: ['candidate', 'supported', 'weakened', 'rejected', 'corroborated'],
    derivedFrom: ['predictions', 'assessments'],
    numericConfidence: false,
    precedence: ['rejected', 'weakened', 'supported', 'corroborated', 'candidate'],
    rules: {
      candidate: {
        fallback: true,
      },
      supported: {
        minimumIndependentSupports: 2,
        independenceKey: 'evidenceId',
        supportStrengths: ['medium', 'high'],
        forbiddenContradictionStrengths: ['medium', 'high'],
        minimumConfirmedPredictions: 1,
      },
      corroborated: {
        minimumIndependentSupports: 2,
        independenceKey: 'evidenceId',
        supportStrengths: ['medium', 'high'],
        forbiddenContradictionStrengths: ['medium', 'high'],
        maximumConfirmedPredictions: 0,
      },
      weakened: {
        contradictionStrengths: ['medium', 'high'],
      },
      rejected: {
        predictionStatus: 'refuted',
        evidenceReliability: 'high',
      },
    },
  },
};

test('publishes STATUS_RULES with the historical v0.1 table and the new v0.2 table', () => {
  const STATUS_RULES = requireStatusRulesTable();

  assert.deepEqual(
    STATUS_RULES['v0.1'],
    EXPECTED_V01_TABLE,
    'STATUS_RULES.v0.1 must be the historical table, unchanged',
  );
  assert.deepEqual(
    STATUS_RULES['v0.1'],
    domain.BASELINE_STATUS_RULES,
    'STATUS_RULES.v0.1 and BASELINE_STATUS_RULES must be the same table',
  );
  assert.deepEqual(
    STATUS_RULES['v0.2'],
    EXPECTED_V02_TABLE,
    'STATUS_RULES.v0.2 must add corroborated exactly as the owner ruling specifies',
  );
});

test('pins the confirmed-prediction boundary between supported and corroborated', () => {
  const STATUS_RULES = requireStatusRulesTable();

  assert.equal(STATUS_RULES['v0.2'].hypothesis.rules.supported.minimumConfirmedPredictions, 1);
  assert.equal(STATUS_RULES['v0.2'].hypothesis.rules.corroborated.maximumConfirmedPredictions, 0);
});

/**
 * `initialBenchmarkState` (`packages/evals/src/graph-benchmark.ts:48-50`)
 * refuses a benchmark run whose declared `metadata.statusRulesVersion` does
 * not match the graph's current `STATUS_RULES_VERSION` — untested until now.
 * Every other metadata field is the shipped, current-version fixture
 * (`benchmarkVersions`); only `statusRulesVersion` is stale.
 */
test('refuses a benchmark run whose metadata declares status-rules version v0.1', async () => {
  const runGraphBenchmarkExperiment = requireFunction(
    evals,
    'runGraphBenchmarkExperiment',
    '@aic/evals',
  );
  const traces = new Map();
  const replayCounts = new Map();

  await assert.rejects(
    () =>
      runGraphBenchmarkExperiment({
        experimentId: 'aic-119-status-rules-v0.1-metadata-refused',
        scenarioSet: 'ad-hoc',
        scenarios: evals.REPLAY_SCENARIOS.slice(0, 5),
        runsPerScenario: 3,
        metadata: { ...benchmarkVersions, statusRulesVersion: 'v0.1' },
        createNodes(record) {
          traces.set(record.runId, []);
          replayCounts.set(record.runId, 0);
          return replayBackedNodes(record, traces, replayCounts);
        },
        async recordEvaluation() {},
      }),
    /status-rules version/i,
    'a benchmark run declaring an old status-rules version must be refused, not executed under the current graph',
  );
});
