/**
 * AIC-105 (v0.2 evidence repair, slice 0b): a NEW evaluator version,
 * `behavior-evaluators-v0.3`, that scores structural evidence coverage and
 * root-cause matching from `structuralGroundTruthFor` instead of the
 * `behavior-evaluators-v0.2` fingerprint-equality machinery — additive beside
 * the accepted v0.2 version, never replacing it.
 *
 * What the rows pin:
 *  - `behavior-evaluators.ts` gains `STRUCTURAL_EVALUATOR_VERSION =
 *    'behavior-evaluators-v0.3'`. `BEHAVIOR_EVALUATOR_VERSION` stays
 *    `'behavior-evaluators-v0.2'` — section B's guard test below pins that it
 *    does not move and that its scoring does not change.
 *  - `BenchmarkOutcome` gains an optional `referencedEvidenceIds`;
 *    `EvidenceAssessmentObservation` gains an optional `evidenceId`.
 *  - `evaluateBenchmarkRecord` dispatches on `record.metadata.evaluatorVersion`:
 *    v0.2 keeps today's behaviour exactly, v0.3 reads structural ground truth,
 *    any other version throws.
 *  - `oracleAnswerFor(scenario, evaluatorVersion?)` grows a second, optional
 *    argument: absent or `'behavior-evaluators-v0.2'` keeps the v0.2 answer
 *    (`oracle-positive-control.test.mjs` pins it);
 *    `'behavior-evaluators-v0.3'` cites the structural evidence ids directly.
 *    `runOracleBenchmarkExperiment` reads `options.metadata.evaluatorVersion`.
 *  - `scripts/eval-oracle.mjs` grows a `--evaluator-version` flag; with no flag
 *    it is unchanged, and `docs/evidence/oracle/behavior-evaluators-v0.3.json`
 *    is the committed output of the new flag.
 *  - the graph arm is credited only for evidence it referenced, never for what
 *    it collected;
 *  - the observability persistence boundary accepts a `behavior-evaluators-v0.3`
 *    record carrying v0.3 behavior metrics, and keeps refusing every mismatch.
 *
 * Every expected value below is written literally, never computed by calling
 * the production evaluator/oracle code this file exercises
 * (`.claude/rules/invariants.md`, "independent-oracle invariant") — each row is
 * hand-traced against `behavior-evaluators.ts`, `oracle-arm.ts` and
 * `replay-scenarios.ts` the way `oracle-positive-control.test.mjs` already
 * does for the v0.2 table.
 *
 * Sections:
 *   A. STRUCTURAL_EVALUATOR_VERSION / BEHAVIOR_EVALUATOR_VERSION guard
 *   B. evaluateBenchmarkRecord: v0.3 dispatch, v0.2 left untouched
 *   C. the oracle under v0.3: oracleAnswerFor, runOracleBenchmarkExperiment,
 *      scripts/eval-oracle.mjs --evaluator-version, the committed evidence file
 *   D. observability: persisting a v0.3 record, and its refusals
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import * as evals from '@aic/evals';
import { oracleAnswerFor, runOracleBenchmarkExperiment } from '@aic/evals/oracle';
import * as observability from '@aic/observability';

import { benchmarkVersions, capturingClient, replayBackedNodes } from './fixtures/benchmark-experiment.mjs';
import { childEnv } from './fixtures/child-env.mjs';

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

function scenarioById(scenarioId) {
  const scenario = evals.REPLAY_SCENARIOS.find(({ id }) => id === scenarioId);
  assert.ok(scenario, `missing scenario: ${scenarioId}`);
  return scenario;
}

function calibrationRecord(scenarioId, evaluatorVersion, metadataOverrides = {}) {
  const record = evals
    .createCalibrationBenchmarkPlan({
      experimentId: `structural-evaluator-${String(evaluatorVersion)}`,
      runsPerScenario: 3,
      metadata: { ...benchmarkVersions, evaluatorVersion, ...metadataOverrides },
    })
    .find(({ scenario }) => scenario.id === scenarioId);
  assert.ok(record, `missing calibration record for ${scenarioId}`);
  return record;
}

/* -------------------------------------------------------------------------- */
/* A. STRUCTURAL_EVALUATOR_VERSION / BEHAVIOR_EVALUATOR_VERSION guard          */
/* -------------------------------------------------------------------------- */

test('STRUCTURAL_EVALUATOR_VERSION is pinned to behavior-evaluators-v0.3, and v0.2 does not move', () => {
  assert.equal(evals.STRUCTURAL_EVALUATOR_VERSION, 'behavior-evaluators-v0.3');
  assert.equal(evals.BEHAVIOR_EVALUATOR_VERSION, 'behavior-evaluators-v0.2');
});

/* -------------------------------------------------------------------------- */
/* B. evaluateBenchmarkRecord: v0.3 dispatch                                  */
/* -------------------------------------------------------------------------- */

const DEP_B_STRUCTURAL_TRUTH = Object.freeze({
  component: 'inventory-api',
  mechanism: 'connection-pool-exhaustion',
});

function depBOutcome(overrides = {}) {
  return {
    claims: [],
    supportingEvidenceIds: [],
    evidenceFingerprints: [],
    stopKind: 'sufficient',
    conclusionKind: 'root-cause',
    rootCause: DEP_B_STRUCTURAL_TRUTH,
    rootCauseHypothesisId: 'h1',
    referencedEvidenceIds: ['inventory-api-pool-saturation', 'confirmation-deploy-v17'],
    evidenceAssessments: [
      {
        fingerprint: { kind: 'deploy', source: 'deployments/payments', predicate: 'irrelevant under v0.3' },
        evidenceId: 'confirmation-deploy-v17',
        hypothesisId: 'h1',
        effect: 'contradicts',
      },
    ],
    ...overrides,
  };
}

test('v0.3 misleading_evidence_handling scores passed: every id referenced, root cause matches structurally, misleading id reconciled', () => {
  const record = calibrationRecord('dependency-caused-incident-b', evals.STRUCTURAL_EVALUATOR_VERSION);
  const result = evals.evaluateBenchmarkRecord({ record, outcome: depBOutcome() });
  assert.deepEqual(result.behaviorMetrics.misleading_evidence_handling, {
    evaluatorVersion: evals.STRUCTURAL_EVALUATOR_VERSION,
    key: 'misleading_evidence_handling',
    score: 1,
    reason: 'passed',
  });
});

test('v0.3 misleading_evidence_handling scores misleading-evidence-not-investigated when the misleading id is shown but never referenced', () => {
  const record = calibrationRecord('dependency-caused-incident-b', evals.STRUCTURAL_EVALUATOR_VERSION);
  const outcome = depBOutcome({
    referencedEvidenceIds: ['inventory-api-pool-saturation'],
    evidenceAssessments: [],
  });
  const result = evals.evaluateBenchmarkRecord({ record, outcome });
  assert.deepEqual(result.behaviorMetrics.misleading_evidence_handling, {
    evaluatorVersion: evals.STRUCTURAL_EVALUATOR_VERSION,
    key: 'misleading_evidence_handling',
    score: 0,
    reason: 'misleading-evidence-not-investigated',
  });
});

test('v0.3 misleading_evidence_handling scores misleading-evidence-not-reconciled when the misleading id is assessed as supports', () => {
  const record = calibrationRecord('dependency-caused-incident-b', evals.STRUCTURAL_EVALUATOR_VERSION);
  const outcome = depBOutcome({
    evidenceAssessments: [
      {
        fingerprint: { kind: 'deploy', source: 'deployments/payments', predicate: 'irrelevant under v0.3' },
        evidenceId: 'confirmation-deploy-v17',
        hypothesisId: 'h1',
        effect: 'supports',
      },
    ],
  });
  const result = evals.evaluateBenchmarkRecord({ record, outcome });
  assert.deepEqual(result.behaviorMetrics.misleading_evidence_handling, {
    evaluatorVersion: evals.STRUCTURAL_EVALUATOR_VERSION,
    key: 'misleading_evidence_handling',
    score: 0,
    reason: 'misleading-evidence-not-reconciled',
  });
});

test('v0.3 misleading_evidence_handling scores root-cause-mismatch against the accepted v0.1 prose mechanism', () => {
  const record = calibrationRecord('dependency-caused-incident-b', evals.STRUCTURAL_EVALUATOR_VERSION);
  const outcome = depBOutcome({
    rootCause: { component: 'inventory-api', mechanism: 'dependency connection pool saturation' },
  });
  const result = evals.evaluateBenchmarkRecord({ record, outcome });
  assert.deepEqual(result.behaviorMetrics.misleading_evidence_handling, {
    evaluatorVersion: evals.STRUCTURAL_EVALUATOR_VERSION,
    key: 'misleading_evidence_handling',
    score: 0,
    reason: 'root-cause-mismatch',
  });
});

test('v0.3 misleading_evidence_handling scores root-cause-mismatch on a wrong component', () => {
  const record = calibrationRecord('dependency-caused-incident-b', evals.STRUCTURAL_EVALUATOR_VERSION);
  const outcome = depBOutcome({
    rootCause: { component: 'payments', mechanism: 'connection-pool-exhaustion' },
  });
  const result = evals.evaluateBenchmarkRecord({ record, outcome });
  assert.deepEqual(result.behaviorMetrics.misleading_evidence_handling, {
    evaluatorVersion: evals.STRUCTURAL_EVALUATOR_VERSION,
    key: 'misleading_evidence_handling',
    score: 0,
    reason: 'root-cause-mismatch',
  });
});

test('v0.3 misleading_evidence_handling scores root-cause-mismatch on a wrong (but taxonomy-valid) mechanism', () => {
  const record = calibrationRecord('dependency-caused-incident-b', evals.STRUCTURAL_EVALUATOR_VERSION);
  const outcome = depBOutcome({
    rootCause: { component: 'inventory-api', mechanism: 'deployment-regression' },
  });
  const result = evals.evaluateBenchmarkRecord({ record, outcome });
  assert.deepEqual(result.behaviorMetrics.misleading_evidence_handling, {
    evaluatorVersion: evals.STRUCTURAL_EVALUATOR_VERSION,
    key: 'misleading_evidence_handling',
    score: 0,
    reason: 'root-cause-mismatch',
  });
});

test('v0.3 evidence_coverage is 0.5 on bad-deployment when only one of the two expected ids is referenced', () => {
  const record = calibrationRecord('bad-deployment', evals.STRUCTURAL_EVALUATOR_VERSION);
  const outcome = {
    claims: [],
    supportingEvidenceIds: [],
    evidenceFingerprints: [],
    stopKind: 'sufficient',
    conclusionKind: 'root-cause',
    referencedEvidenceIds: ['checkout-deploy-v42'],
  };
  const result = evals.evaluateBenchmarkRecord({ record, outcome });
  assert.deepEqual(result.metrics.evidence_coverage, { key: 'evidence_coverage', score: 0.5 });
});

test('v0.3 evidence_coverage reads an absent referencedEvidenceIds as none referenced, even though the v0.2 fingerprint-based reading of the same outcome would score it fully covered', () => {
  const record = calibrationRecord('bad-deployment', evals.STRUCTURAL_EVALUATOR_VERSION);
  const scenario = scenarioById('bad-deployment');
  const outcome = {
    claims: [],
    supportingEvidenceIds: [],
    // Full v0.2-style fingerprint coverage, and deliberately no
    // referencedEvidenceIds: a v0.3 dispatch that fell back to the v0.2
    // fingerprint formula here would wrongly score this 1, not 0.
    evidenceFingerprints: scenario.groundTruth.expectedEvidence.map((fingerprint) => ({ ...fingerprint })),
    stopKind: 'sufficient',
    conclusionKind: 'root-cause',
  };
  const result = evals.evaluateBenchmarkRecord({ record, outcome });
  assert.deepEqual(result.metrics.evidence_coverage, { key: 'evidence_coverage', score: 0 });
});

function falseAlertOutcome(overrides = {}) {
  return {
    claims: [],
    supportingEvidenceIds: [],
    evidenceFingerprints: [],
    stopKind: 'sufficient',
    conclusionKind: 'no-incident',
    referencedEvidenceIds: ['checkout-normal-error-rate', 'checkout-no-server-errors'],
    ...overrides,
  };
}

test('v0.3 false_alert_correctness passes when stopKind, every expected id, and conclusionKind all match', () => {
  const record = calibrationRecord('false-alert', evals.STRUCTURAL_EVALUATOR_VERSION);
  const result = evals.evaluateBenchmarkRecord({ record, outcome: falseAlertOutcome() });
  assert.deepEqual(result.behaviorMetrics.false_alert_correctness, {
    evaluatorVersion: evals.STRUCTURAL_EVALUATOR_VERSION,
    key: 'false_alert_correctness',
    score: 1,
    reason: 'passed',
  });
});

test('v0.3 false_alert_correctness scores expected-evidence-missing when not every expected id is referenced', () => {
  const record = calibrationRecord('false-alert', evals.STRUCTURAL_EVALUATOR_VERSION);
  const outcome = falseAlertOutcome({ referencedEvidenceIds: ['checkout-normal-error-rate'] });
  const result = evals.evaluateBenchmarkRecord({ record, outcome });
  assert.deepEqual(result.behaviorMetrics.false_alert_correctness, {
    evaluatorVersion: evals.STRUCTURAL_EVALUATOR_VERSION,
    key: 'false_alert_correctness',
    score: 0,
    reason: 'expected-evidence-missing',
  });
});

test('v0.3 false_alert_correctness scores insufficient-investigation on a stopKind mismatch', () => {
  const record = calibrationRecord('false-alert', evals.STRUCTURAL_EVALUATOR_VERSION);
  const outcome = falseAlertOutcome({ stopKind: 'stalled' });
  const result = evals.evaluateBenchmarkRecord({ record, outcome });
  assert.deepEqual(result.behaviorMetrics.false_alert_correctness, {
    evaluatorVersion: evals.STRUCTURAL_EVALUATOR_VERSION,
    key: 'false_alert_correctness',
    score: 0,
    reason: 'insufficient-investigation',
  });
});

test('v0.3 false_alert_correctness scores incorrect-outcome on a conclusionKind mismatch', () => {
  const record = calibrationRecord('false-alert', evals.STRUCTURAL_EVALUATOR_VERSION);
  const outcome = falseAlertOutcome({ conclusionKind: 'root-cause' });
  const result = evals.evaluateBenchmarkRecord({ record, outcome });
  assert.deepEqual(result.behaviorMetrics.false_alert_correctness, {
    evaluatorVersion: evals.STRUCTURAL_EVALUATOR_VERSION,
    key: 'false_alert_correctness',
    score: 0,
    reason: 'incorrect-outcome',
  });
});

test('evaluateBenchmarkRecord throws for a metadata evaluatorVersion neither v0.2 nor v0.3 names', () => {
  const record = calibrationRecord('false-alert', 'behavior-evaluators-v0.99');
  assert.throws(() => evals.evaluateBenchmarkRecord({ record, outcome: falseAlertOutcome() }));
});

test('the same outcome scores by whichever evaluatorVersion the record declares, and v0.2 semantics are unchanged', () => {
  const scenario = scenarioById('dependency-caused-incident-b');
  const expectedFingerprint = scenario.groundTruth.expectedEvidence[0];
  const misleadingFingerprint = scenario.groundTruth.misleadingEvidence[0];
  // A v0.2-shaped outcome: fingerprints and the accepted (v0.1-prose) rootCause,
  // reconciled by fingerprint — exactly what today's evaluateMisleadingEvidenceHandling
  // scores as passed. Deliberately carries NO referencedEvidenceIds, so a v0.3
  // dispatch reading this same object sees nothing referenced.
  const outcome = {
    claims: [],
    supportingEvidenceIds: [],
    evidenceFingerprints: [expectedFingerprint, misleadingFingerprint],
    stopKind: scenario.groundTruth.expectedStopKind,
    conclusionKind: scenario.groundTruth.expectedConclusionKind,
    rootCause: scenario.groundTruth.rootCause,
    rootCauseHypothesisId: 'h1',
    evidenceAssessments: [
      { fingerprint: misleadingFingerprint, hypothesisId: 'h1', effect: 'contradicts' },
    ],
  };

  const v02Record = calibrationRecord('dependency-caused-incident-b', evals.BEHAVIOR_EVALUATOR_VERSION);
  const v02Result = evals.evaluateBenchmarkRecord({ record: v02Record, outcome });
  assert.deepEqual(v02Result.behaviorMetrics.misleading_evidence_handling, {
    evaluatorVersion: evals.BEHAVIOR_EVALUATOR_VERSION,
    key: 'misleading_evidence_handling',
    score: 1,
    reason: 'passed',
  });

  const v03Record = calibrationRecord('dependency-caused-incident-b', evals.STRUCTURAL_EVALUATOR_VERSION);
  const v03Result = evals.evaluateBenchmarkRecord({ record: v03Record, outcome });
  assert.deepEqual(v03Result.behaviorMetrics.misleading_evidence_handling, {
    evaluatorVersion: evals.STRUCTURAL_EVALUATOR_VERSION,
    key: 'misleading_evidence_handling',
    score: 0,
    reason: 'misleading-evidence-not-investigated',
  });
});

/* -------------------------------------------------------------------------- */
/* C. the oracle under v0.3                                                   */
/* -------------------------------------------------------------------------- */

test('oracleAnswerFor keeps today\'s v0.2 answer for a root-cause scenario, by default and with the version named explicitly', () => {
  const scenario = scenarioById('bad-deployment');
  for (const call of [() => oracleAnswerFor(scenario), () => oracleAnswerFor(scenario, evals.BEHAVIOR_EVALUATOR_VERSION)]) {
    const { answer, challengeEffect } = call();
    assert.equal(answer.conclusion.causes.length, 1);
    // No fixture statement is byte-identical to its own ground-truth predicate
    // in the calibration partition (oracle-positive-control.test.mjs's header),
    // so the v0.2 oracle identifies nothing here.
    assert.deepEqual(answer.conclusion.causes[0].evidenceIds, []);
    assert.deepEqual(answer.assessments, []);
    assert.equal(challengeEffect, undefined);
  }
});

test('oracleAnswerFor(scenario, v0.3) cites the real evidence ids for a root-cause scenario, tagged with the structural cause', () => {
  const scenario = scenarioById('bad-deployment');
  const { answer, challengeEffect } = oracleAnswerFor(scenario, evals.STRUCTURAL_EVALUATOR_VERSION);

  assert.equal(answer.conclusion.causes.length, 1);
  assert.deepEqual(answer.conclusion.causes[0].cause, {
    component: 'checkout',
    mechanism: 'deployment-regression',
  });
  assert.deepEqual(
    [...answer.conclusion.causes[0].evidenceIds].sort(),
    ['checkout-deploy-v42', 'checkout-invalid-database-endpoint'].sort(),
  );
  const hypothesisId = answer.conclusion.causes[0].hypothesisId;
  assert.ok(
    answer.hypotheses.some(({ id }) => id === hypothesisId),
    'the cause must name a hypothesis the answer actually declares',
  );
  const supports = answer.assessments.filter(({ effect }) => effect === 'supports');
  assert.deepEqual(
    supports.map(({ evidenceId }) => evidenceId).sort(),
    ['checkout-deploy-v42', 'checkout-invalid-database-endpoint'].sort(),
  );
  assert.ok(supports.every(({ hypothesisId: h }) => h === hypothesisId));
  assert.equal(challengeEffect, undefined);
});

test('oracleAnswerFor(scenario, v0.3) cites the misleading id as contradicts by the root-cause hypothesis', () => {
  const scenario = scenarioById('dependency-caused-incident-b');
  const { answer } = oracleAnswerFor(scenario, evals.STRUCTURAL_EVALUATOR_VERSION);

  assert.equal(answer.conclusion.causes.length, 1);
  assert.deepEqual(answer.conclusion.causes[0].cause, {
    component: 'inventory-api',
    mechanism: 'connection-pool-exhaustion',
  });
  assert.deepEqual(answer.conclusion.causes[0].evidenceIds, ['inventory-api-pool-saturation']);
  const hypothesisId = answer.conclusion.causes[0].hypothesisId;
  const misleadingAssessment = answer.assessments.find(
    ({ evidenceId }) => evidenceId === 'confirmation-deploy-v17',
  );
  assert.ok(misleadingAssessment, 'the misleading id must be assessed');
  assert.equal(misleadingAssessment.effect, 'contradicts');
  assert.equal(misleadingAssessment.hypothesisId, hypothesisId);
});

test('oracleAnswerFor(scenario, v0.3) reports no causes for a no-rootCause, no-incident scenario, and contradicts every expected id', () => {
  const scenario = scenarioById('false-alert');
  const { answer } = oracleAnswerFor(scenario, evals.STRUCTURAL_EVALUATOR_VERSION);

  assert.deepEqual(answer.conclusion.causes, []);
  assert.equal(answer.hypotheses.length, 1);
  const hypothesisId = answer.hypotheses[0].id;
  const byEvidenceId = (a, b) => a.evidenceId.localeCompare(b.evidenceId);
  assert.deepEqual(
    answer.assessments
      .map(({ evidenceId, hypothesisId: h, effect }) => ({ evidenceId, hypothesisId: h, effect }))
      .sort(byEvidenceId),
    [
      { evidenceId: 'checkout-no-server-errors', hypothesisId, effect: 'contradicts' },
      { evidenceId: 'checkout-normal-error-rate', hypothesisId, effect: 'contradicts' },
    ],
  );
});

test('oracleAnswerFor(scenario, v0.3) reports no causes for a no-rootCause, non-no-incident scenario, and supports every expected id', () => {
  const scenario = scenarioById('multiple-plausible-causes');
  const { answer } = oracleAnswerFor(scenario, evals.STRUCTURAL_EVALUATOR_VERSION);

  assert.deepEqual(answer.conclusion.causes, []);
  assert.equal(answer.hypotheses.length, 1);
  const hypothesisId = answer.hypotheses[0].id;
  const byEvidenceId = (a, b) => a.evidenceId.localeCompare(b.evidenceId);
  assert.deepEqual(
    answer.assessments
      .map(({ evidenceId, hypothesisId: h, effect }) => ({ evidenceId, hypothesisId: h, effect }))
      .sort(byEvidenceId),
    [
      { evidenceId: 'inventory-api-latency-incident', hypothesisId, effect: 'supports' },
      { evidenceId: 'payments-error-rate-incident', hypothesisId, effect: 'supports' },
    ],
  );
});

test('runOracleBenchmarkExperiment reads options.metadata.evaluatorVersion: v0.3 reaches full evidence coverage where v0.2 cannot', async () => {
  // The ad-hoc plan requires exactly five scenarios (createBenchmarkPlan), so
  // five are supplied and only the 'bad-deployment' result is read back.
  const scenarios = [
    'bad-deployment',
    'db-pool-exhaustion',
    'false-alert',
    'deployment-caused-incident-a',
    'dependency-caused-incident-b',
  ].map(scenarioById);

  async function scoreUnder(evaluatorVersion) {
    let captured;
    await runOracleBenchmarkExperiment({
      experimentId: `oracle-version-dispatch-${evaluatorVersion}`,
      scenarioSet: 'ad-hoc',
      scenarios,
      runsPerScenario: 3,
      metadata: { ...benchmarkVersions, evaluatorVersion },
      async recordEvaluation({ record, result }) {
        if (record.scenario.id === 'bad-deployment') captured = result;
      },
    });
    assert.ok(captured, `no bad-deployment result recorded for evaluatorVersion ${evaluatorVersion}`);
    return captured;
  }

  const v02Result = await scoreUnder(evals.BEHAVIOR_EVALUATOR_VERSION);
  assert.equal(v02Result.metrics.evidence_coverage.score, 0);

  const v03Result = await scoreUnder(evals.STRUCTURAL_EVALUATOR_VERSION);
  assert.equal(v03Result.metrics.evidence_coverage.score, 1);
});

function runEvalOracleScript(extraArgs = []) {
  return spawnSync(
    process.execPath,
    ['--import', './test/fixtures/no-ambient-tracing.mjs', 'scripts/eval-oracle.mjs', ...extraArgs],
    { cwd: projectRoot, encoding: 'utf8', env: childEnv() },
  );
}

test('scripts/eval-oracle.mjs with no flag still prints the v0.2 report', () => {
  const executed = runEvalOracleScript();
  assert.equal(
    executed.status,
    0,
    `node scripts/eval-oracle.mjs exited ${executed.status}\nstdout:\n${executed.stdout}\nstderr:\n${executed.stderr}`,
  );
  const fresh = JSON.parse(executed.stdout);
  assert.equal(fresh.evaluatorVersion, 'behavior-evaluators-v0.2');
});

/**
 * The pinned v0.3 calibration table. Hand-derived exactly as
 * `oracle-positive-control.test.mjs` derives its v0.2 counterpart: every
 * scenario reaches every metric's best value, because the v0.3 oracle cites
 * real evidence ids directly rather than needing a byte-identical fixture
 * statement.
 */
const EXPECTED_ORACLE_REPORT_V03 = {
  evaluatorVersion: 'behavior-evaluators-v0.3',
  partition: 'calibration',
  arm: { arm: 'oracle', role: 'positive-control' },
  providerCalls: 0,
  runsPerScenario: 3,
  bestValues: {
    unsupported_claim_rate: 0,
    evidence_coverage: 1,
    termination_correctness: 1,
    misleading_evidence_handling: 1,
    false_alert_correctness: 1,
    challenge_effect: 1,
  },
  scenarios: [
    {
      scenarioId: 'bad-deployment',
      claimCount: 1,
      metrics: {
        unsupported_claim_rate: { score: 0 },
        evidence_coverage: { score: 1 },
        termination_correctness: { score: 1 },
      },
    },
    {
      scenarioId: 'db-pool-exhaustion',
      claimCount: 1,
      metrics: {
        unsupported_claim_rate: { score: 0 },
        evidence_coverage: { score: 1 },
        termination_correctness: { score: 1 },
      },
    },
    {
      scenarioId: 'false-alert',
      claimCount: 0,
      metrics: {
        unsupported_claim_rate: { score: 0 },
        evidence_coverage: { score: 1 },
        termination_correctness: { score: 1 },
        false_alert_correctness: { score: 1, reason: 'passed' },
      },
    },
    {
      scenarioId: 'deployment-caused-incident-a',
      claimCount: 1,
      metrics: {
        unsupported_claim_rate: { score: 0 },
        evidence_coverage: { score: 1 },
        termination_correctness: { score: 1 },
      },
    },
    {
      scenarioId: 'dependency-caused-incident-b',
      claimCount: 1,
      metrics: {
        unsupported_claim_rate: { score: 0 },
        evidence_coverage: { score: 1 },
        termination_correctness: { score: 1 },
        misleading_evidence_handling: { score: 1, reason: 'passed' },
      },
    },
    {
      scenarioId: 'multiple-plausible-causes',
      claimCount: 0,
      metrics: {
        unsupported_claim_rate: { score: 0 },
        evidence_coverage: { score: 1 },
        termination_correctness: { score: 1 },
      },
    },
    {
      scenarioId: 'transient-self-resolved',
      claimCount: 1,
      metrics: {
        unsupported_claim_rate: { score: 0 },
        evidence_coverage: { score: 1 },
        termination_correctness: { score: 1 },
      },
    },
    {
      scenarioId: 'challenge-keeps-leader',
      claimCount: 1,
      metrics: {
        unsupported_claim_rate: { score: 0 },
        evidence_coverage: { score: 1 },
        termination_correctness: { score: 1 },
        challenge_effect: { score: 1, reason: 'passed' },
      },
    },
  ],
  reachesBest: {
    unsupported_claim_rate: { reached: true, scenariosBelowBest: [] },
    evidence_coverage: { reached: true, scenariosBelowBest: [] },
    termination_correctness: { reached: true, scenariosBelowBest: [] },
    false_alert_correctness: { reached: true, scenariosBelowBest: [] },
    misleading_evidence_handling: { reached: true, scenariosBelowBest: [] },
    challenge_effect: { reached: true, scenariosBelowBest: [] },
  },
};

test('scripts/eval-oracle.mjs --evaluator-version behavior-evaluators-v0.3 prints exactly the hand-derived v0.3 calibration table', () => {
  const executed = runEvalOracleScript(['--evaluator-version', 'behavior-evaluators-v0.3']);
  assert.equal(
    executed.status,
    0,
    `node scripts/eval-oracle.mjs --evaluator-version behavior-evaluators-v0.3 exited ${executed.status}\nstdout:\n${executed.stdout}\nstderr:\n${executed.stderr}`,
  );
  const fresh = JSON.parse(executed.stdout);
  assert.deepEqual(fresh, EXPECTED_ORACLE_REPORT_V03);
});

test('scripts/eval-oracle.mjs never runs or scores a hold-out scenario under v0.3 either', () => {
  const executed = runEvalOracleScript(['--evaluator-version', 'behavior-evaluators-v0.3']);
  assert.equal(executed.status, 0);
  const fresh = JSON.parse(executed.stdout);
  const scoredIds = new Set(fresh.scenarios.map(({ scenarioId }) => scenarioId));
  for (const holdoutId of evals.BENCHMARK_SCENARIO_PARTITIONS.holdout) {
    assert.equal(scoredIds.has(holdoutId), false, `scored a hold-out scenario under v0.3: ${holdoutId}`);
  }
});

const V03_EVIDENCE_PATH = resolve(projectRoot, 'docs/evidence/oracle/behavior-evaluators-v0.3.json');

test('docs/evidence/oracle/behavior-evaluators-v0.3.json deep-equals a fresh run of the v0.3 report', () => {
  const executed = runEvalOracleScript(['--evaluator-version', 'behavior-evaluators-v0.3']);
  assert.equal(
    executed.status,
    0,
    `node scripts/eval-oracle.mjs --evaluator-version behavior-evaluators-v0.3 exited ${executed.status}\nstdout:\n${executed.stdout}\nstderr:\n${executed.stderr}`,
  );
  const fresh = JSON.parse(executed.stdout);
  const committed = JSON.parse(readFileSync(V03_EVIDENCE_PATH, 'utf8'));
  assert.deepEqual(
    committed,
    fresh,
    'docs/evidence/oracle/behavior-evaluators-v0.3.json has drifted from a fresh run of scripts/eval-oracle.mjs --evaluator-version behavior-evaluators-v0.3',
  );
});

/**
 * The graph arm replays every fixture entry, so every item is COLLECTED on
 * every run. The structural evaluator must count only what the run
 * referenced, or collection alone would score full coverage.
 */
async function graphCoverageByScenario(createNodes) {
  const coverage = new Map();
  await evals.runGraphBenchmarkExperiment({
    experimentId: 'structural-graph-coverage',
    scenarioSet: 'calibration',
    runsPerScenario: 3,
    metadata: { ...benchmarkVersions, evaluatorVersion: evals.STRUCTURAL_EVALUATOR_VERSION },
    createNodes,
    async recordEvaluation({ record, result }) {
      coverage.set(record.scenario.id, result.metrics.evidence_coverage.score);
    },
  });
  return coverage;
}

function replayNodes(record) {
  return replayBackedNodes(record, new Map([[record.runId, []]]), new Map([[record.runId, 0]]));
}

test('v0.3 does not credit the graph arm for evidence it collected but never cited', async () => {
  const coverage = await graphCoverageByScenario(replayNodes);
  assert.equal(coverage.get('bad-deployment'), 0);
  assert.equal(coverage.get('dependency-caused-incident-b'), 0);
});

test('v0.3 credits the graph arm for the expected evidence its conclusion cites', async () => {
  const citedIdsByScenario = {
    'bad-deployment': ['checkout-deploy-v42', 'checkout-invalid-database-endpoint'],
    'dependency-caused-incident-b': ['inventory-api-pool-saturation'],
  };
  const coverage = await graphCoverageByScenario((record) => ({
    ...replayNodes(record),
    async propose_conclusion(state) {
      const evidenceIds = citedIdsByScenario[record.scenarioId] ?? [];
      return {
        conclusion: {
          kind: 'root-cause',
          causes: [{
            hypothesisId: state.hypotheses[0].id,
            cause: { component: 'unused-here', mechanism: 'unused-here' },
            evidenceIds,
          }],
        },
      };
    },
  }));
  assert.equal(coverage.get('bad-deployment'), 1);
  assert.equal(coverage.get('dependency-caused-incident-b'), 1);
});

/* -------------------------------------------------------------------------- */
/* D. observability: persisting a v0.3 record                                 */
/* -------------------------------------------------------------------------- */

function v03Result(record, behaviorMetrics) {
  return {
    experimentId: record.experimentId,
    exampleId: record.exampleId,
    runId: record.runId,
    actualStopKind: 'sufficient',
    metrics: {
      unsupported_claim_rate: { key: 'unsupported_claim_rate', score: 0 },
      evidence_coverage: { key: 'evidence_coverage', score: 1 },
      termination_correctness: { key: 'termination_correctness', score: 1 },
    },
    behaviorMetrics,
  };
}

test('persistBenchmarkExperiment accepts a record declaring behavior-evaluators-v0.3 with v0.3 behavior metrics', async () => {
  const record = calibrationRecord('dependency-caused-incident-b', 'behavior-evaluators-v0.3');
  const result = v03Result(record, {
    misleading_evidence_handling: {
      evaluatorVersion: 'behavior-evaluators-v0.3',
      key: 'misleading_evidence_handling',
      score: 1,
      reason: 'passed',
    },
  });
  const capture = capturingClient();

  await observability.persistBenchmarkExperiment({
    client: capture.client,
    datasetName: 'structural-v0.3-accepted',
    experiment: { records: [record], results: [result] },
  });

  assert.equal(capture.runs.length, 1);
  assert.equal(capture.runs[0].extra.metadata.evaluatorVersion, 'behavior-evaluators-v0.3');
  assert.equal(
    capture.runs[0].outputs.behaviorMetrics.misleading_evidence_handling.evaluatorVersion,
    'behavior-evaluators-v0.3',
  );
});

test('persistBenchmarkExperiment refuses a v0.3-tagged behavior metric inside a record declaring v0.2', async () => {
  const record = calibrationRecord('false-alert', 'behavior-evaluators-v0.2');
  const result = v03Result(record, {
    false_alert_correctness: {
      evaluatorVersion: 'behavior-evaluators-v0.3',
      key: 'false_alert_correctness',
      score: 1,
      reason: 'passed',
    },
  });
  const capture = capturingClient();

  await assert.rejects(() =>
    observability.persistBenchmarkExperiment({
      client: capture.client,
      datasetName: 'structural-v0.3-inside-v0.2-record',
      experiment: { records: [record], results: [result] },
    }),
  );
  assert.equal(capture.runs.length, 0);
});

test('persistBenchmarkExperiment still refuses an evaluator version neither v0.2 nor v0.3 names', async () => {
  const record = calibrationRecord('false-alert', 'behavior-evaluators-v0.4');
  const result = v03Result(record, {
    false_alert_correctness: {
      evaluatorVersion: 'behavior-evaluators-v0.4',
      key: 'false_alert_correctness',
      score: 1,
      reason: 'passed',
    },
  });
  const capture = capturingClient();

  await assert.rejects(() =>
    observability.persistBenchmarkExperiment({
      client: capture.client,
      datasetName: 'structural-unknown-version',
      experiment: { records: [record], results: [result] },
    }),
  );
  assert.equal(capture.runs.length, 0);
});
