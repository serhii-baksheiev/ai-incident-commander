/**
 * AIC-138 [AIC-122 audit]: `scoreChallengeEffect` passes a leader or
 * leader-status change with zero executed discriminating trials, whenever
 * that change matches the ground truth's expectation — because the only
 * "nothing happened" guard requires leader, status AND trial count to all be
 * unchanged (`packages/evals/src/behavior-evaluators.ts:266-268`), so a
 * change with no trial skips straight to the leader-change-match check.
 * Since AIC-125 the challenge round can plan and execute genuinely new
 * discriminating work, so `challenge_effect` can now demand it: a pass with
 * no executed discriminating trial is judgement over evidence the run
 * already had, not investigation.
 *
 * Fix (Option A of the AIC-138 plan, recorded on the Jira ticket): a new evaluator
 * version, `behavior-evaluators-v0.4`, differing from v0.3 only in
 * `challenge_effect` — a pass requires `executedDiscriminatingTrialCount >=
 * 1`; a leader or status change with none scores 0 with the reason
 * `no-discriminating-trial`. v0.2 and v0.3 semantics do not move.
 *
 * What the rows below pin, ahead of the implementation:
 *  - `behavior-evaluators.ts` gains `DISCRIMINATING_CHALLENGE_EVALUATOR_VERSION
 *    = 'behavior-evaluators-v0.4'`, alongside `BEHAVIOR_EVALUATOR_VERSION` and
 *    `STRUCTURAL_EVALUATOR_VERSION`, neither of which moves (A1).
 *  - `evaluateStructuralChallengeEffect(input, evaluatorVersion)` grows a
 *    second, version parameter (defaulting to v0.3, per the plan): the ticket's
 *    three mutation rows, a passing row, the "nothing changed" row unchanged,
 *    a monotonicity property, and a guard row proving v0.2/v0.3 do not move
 *    (section B).
 *  - `evaluateBenchmarkRecord` dispatches v0.4 records the same way it
 *    dispatches v0.3 ones — through a shared "scores structurally" predicate
 *    — tagging every behavior metric with the record's own version, and
 *    refusing any version outside {v0.2, v0.3, v0.4} (section C).
 *  - `oracleAnswerFor(scenario, 'behavior-evaluators-v0.4')` projects exactly
 *    what it projects under v0.3, and the committed
 *    `docs/evidence/oracle/behavior-evaluators-v0.4.json` (generated in
 *    Green, never hand-written) matches a fresh run of
 *    `scripts/eval-oracle.mjs --evaluator-version behavior-evaluators-v0.4`,
 *    reaching best on every metric including `challenge_effect` (section D).
 *  - the observability persistence boundary accepts a `behavior-evaluators-v0.4`
 *    record whose `challenge_effect` reason is `no-discriminating-trial`
 *    (section E; the companion "still refuses an unknown version" row in
 *    `structural-evaluator.test.mjs` was retargeted in place from v0.4 to
 *    v0.99, since v0.4 stops being that fixture's unknown version).
 *
 * Independent-oracle discipline (`.claude/rules/invariants.md`): every
 * expected value below is written literally — hand-traced against
 * `behavior-evaluators.ts` and `replay-scenarios.ts`, the way
 * `oracle-positive-control.test.mjs` already does for the v0.2 table and
 * `structural-evaluator.test.mjs` for v0.3 — never computed by calling the
 * production code under test. Three rows are relational by nature and
 * compare the v0.3 and v0.4 paths to each other instead: "v0.4 never passes
 * a challenge observation v0.3 fails, …", "v0.4 scores evidence_coverage,
 * misleading_evidence_handling and false_alert_correctness exactly as v0.3
 * …" and "oracleAnswerFor projects the same structural answer and challenge
 * observation under behavior-evaluators-v0.4 as under v0.3". Each claims only
 * equality or order between the versions, so it can catch the versions
 * drifting apart but not a defect both share; the literal rows in sections B
 * and C, and the v0.3 rows in `structural-evaluator.test.mjs`, pin the values
 * themselves.
 *
 * Sections:
 *   A. DISCRIMINATING_CHALLENGE_EVALUATOR_VERSION guard
 *   B. evaluateStructuralChallengeEffect(input, version): the ticket's rows
 *   C. dispatch through evaluateBenchmarkRecord
 *   D. the oracle under v0.4: oracleAnswerFor, the committed evidence file
 *   E. observability: persisting a v0.4 record
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import * as evals from '@aic/evals';
import { oracleAnswerFor } from '@aic/evals/oracle';
import * as observability from '@aic/observability';

import { behaviorPerfectOutcomeFor, benchmarkVersions, capturingClient } from './fixtures/benchmark-experiment.mjs';
import { childEnv } from './fixtures/child-env.mjs';

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

function calibrationRecord(scenarioId, evaluatorVersion, metadataOverrides = {}) {
  const record = evals
    .createCalibrationBenchmarkPlan({
      experimentId: `discriminating-challenge-${String(evaluatorVersion)}`,
      runsPerScenario: 3,
      metadata: { ...benchmarkVersions, evaluatorVersion, ...metadataOverrides },
    })
    .find(({ scenario }) => scenario.id === scenarioId);
  assert.ok(record, `missing calibration record for ${scenarioId}`);
  return record;
}

/* -------------------------------------------------------------------------- */
/* A. DISCRIMINATING_CHALLENGE_EVALUATOR_VERSION guard                        */
/* -------------------------------------------------------------------------- */

test('DISCRIMINATING_CHALLENGE_EVALUATOR_VERSION is pinned to behavior-evaluators-v0.4, and v0.2 and v0.3 do not move', () => {
  assert.equal(evals.DISCRIMINATING_CHALLENGE_EVALUATOR_VERSION, 'behavior-evaluators-v0.4');
  assert.equal(evals.BEHAVIOR_EVALUATOR_VERSION, 'behavior-evaluators-v0.2');
  assert.equal(evals.STRUCTURAL_EVALUATOR_VERSION, 'behavior-evaluators-v0.3');
});

/* -------------------------------------------------------------------------- */
/* B. evaluateStructuralChallengeEffect(input, version): the ticket's rows    */
/* -------------------------------------------------------------------------- */

function structuralChallengeResult(expectedLeaderChangeAfterChallenge, outcome, version) {
  return evals.evaluateStructuralChallengeEffect(
    { groundTruth: { expectedLeaderChangeAfterChallenge }, outcome },
    version,
  );
}

/*
 * AIC-141: evaluateStructuralChallengeEffect takes a caller-supplied
 * evaluatorVersion constrained only by TypeScript types, and is exported from
 * @aic/evals into untyped .mjs callers. A version that does not score
 * structurally must be refused, naming the version the call received.
 */
test('evaluateStructuralChallengeEffect throws for an evaluatorVersion that does not score structurally, naming the version it got', () => {
  const outcome = {
    challengeNodeExecuted: true,
    challengeInvocationCount: 1,
    leaderBeforeChallengeId: 'leader-a',
    leaderAfterChallengeId: 'leader-b',
    executedDiscriminatingTrialCount: 1,
  };
  assert.throws(
    () => structuralChallengeResult(true, outcome, evals.BEHAVIOR_EVALUATOR_VERSION),
    /behavior-evaluators-v0\.2/,
  );
  assert.throws(
    () => structuralChallengeResult(true, outcome, 'behavior-evaluators-v0.99'),
    /behavior-evaluators-v0\.99/,
  );
  assert.throws(
    () => structuralChallengeResult(true, outcome, 42),
    /42/,
  );
});

test('evaluateStructuralChallengeEffect still scores passed under v0.3, v0.4 and the default version', () => {
  const outcome = {
    challengeNodeExecuted: true,
    challengeInvocationCount: 1,
    leaderBeforeChallengeId: 'leader-a',
    leaderAfterChallengeId: 'leader-b',
    executedDiscriminatingTrialCount: 1,
  };
  for (const version of [evals.STRUCTURAL_EVALUATOR_VERSION, evals.DISCRIMINATING_CHALLENGE_EVALUATOR_VERSION, undefined]) {
    const result = structuralChallengeResult(true, outcome, version);
    assert.deepEqual(result, {
      evaluatorVersion: version ?? evals.STRUCTURAL_EVALUATOR_VERSION,
      key: 'challenge_effect',
      score: 1,
      reason: 'passed',
    });
  }
});

test('under behavior-evaluators-v0.4, a challenge that changes the leader as expected with no executed discriminating trial scores 0 with reason no-discriminating-trial', () => {
  const result = structuralChallengeResult(
    true,
    {
      challengeNodeExecuted: true,
      challengeInvocationCount: 1,
      leaderBeforeChallengeId: 'leader-a',
      leaderAfterChallengeId: 'leader-b',
      executedDiscriminatingTrialCount: 0,
    },
    evals.DISCRIMINATING_CHALLENGE_EVALUATOR_VERSION,
  );
  assert.deepEqual(result, {
    evaluatorVersion: evals.DISCRIMINATING_CHALLENGE_EVALUATOR_VERSION,
    key: 'challenge_effect',
    score: 0,
    reason: 'no-discriminating-trial',
  });
});

test("under behavior-evaluators-v0.4, a challenge that changes only the leader's status with no executed discriminating trial scores 0 with reason no-discriminating-trial", () => {
  const result = structuralChallengeResult(
    false,
    {
      challengeNodeExecuted: true,
      challengeInvocationCount: 1,
      leaderBeforeChallengeId: 'leader-a',
      leaderAfterChallengeId: 'leader-a',
      leaderStatusBeforeChallenge: 'candidate',
      leaderStatusAfterChallenge: 'supported',
      executedDiscriminatingTrialCount: 0,
    },
    evals.DISCRIMINATING_CHALLENGE_EVALUATOR_VERSION,
  );
  assert.deepEqual(result, {
    evaluatorVersion: evals.DISCRIMINATING_CHALLENGE_EVALUATOR_VERSION,
    key: 'challenge_effect',
    score: 0,
    reason: 'no-discriminating-trial',
  });
});

test('under behavior-evaluators-v0.4, a challenge that changes the leader as expected with one executed discriminating trial scores 1 passed, tagged behavior-evaluators-v0.4', () => {
  const result = structuralChallengeResult(
    true,
    {
      challengeNodeExecuted: true,
      challengeInvocationCount: 1,
      leaderBeforeChallengeId: 'leader-a',
      leaderAfterChallengeId: 'leader-b',
      executedDiscriminatingTrialCount: 1,
    },
    evals.DISCRIMINATING_CHALLENGE_EVALUATOR_VERSION,
  );
  assert.deepEqual(result, {
    evaluatorVersion: evals.DISCRIMINATING_CHALLENGE_EVALUATOR_VERSION,
    key: 'challenge_effect',
    score: 1,
    reason: 'passed',
  });
});

test('under behavior-evaluators-v0.4, nothing changed and no trial still reads no-investigation-change', () => {
  const result = structuralChallengeResult(
    false,
    {
      challengeNodeExecuted: true,
      challengeInvocationCount: 1,
      leaderBeforeChallengeId: 'leader-a',
      leaderAfterChallengeId: 'leader-a',
      executedDiscriminatingTrialCount: 0,
    },
    evals.DISCRIMINATING_CHALLENGE_EVALUATOR_VERSION,
  );
  assert.deepEqual(result, {
    evaluatorVersion: evals.DISCRIMINATING_CHALLENGE_EVALUATOR_VERSION,
    key: 'challenge_effect',
    score: 0,
    reason: 'no-investigation-change',
  });
});

function challengeObservation({ leaderChanged, statusChanged, trialCount }) {
  return {
    challengeNodeExecuted: true,
    challengeInvocationCount: 1,
    leaderBeforeChallengeId: 'leader-a',
    leaderAfterChallengeId: leaderChanged ? 'leader-b' : 'leader-a',
    leaderStatusBeforeChallenge: 'candidate',
    leaderStatusAfterChallenge: statusChanged ? 'supported' : 'candidate',
    executedDiscriminatingTrialCount: trialCount,
  };
}

// One of the three relational rows the file header names, which compare the
// v0.3 and v0.4 paths to each other (`.claude/rules/invariants.md`, "the
// independent-oracle invariant"): "v0.4 never passes what v0.3 fails" is a
// claim about the relation between the two scorers, so comparing them to each
// other is not a production computation checking its own work the way the
// literal rows here avoid — there is no other oracle for a relational claim
// between two versions of the same function.
test('v0.4 never passes a challenge observation v0.3 fails, over every combination of leader change, status change, trial count 0/1 and expectation', () => {
  for (const leaderChanged of [true, false]) {
    for (const statusChanged of [true, false]) {
      for (const trialCount of [0, 1]) {
        for (const expectedLeaderChangeAfterChallenge of [true, false]) {
          const outcome = challengeObservation({ leaderChanged, statusChanged, trialCount });
          const v3 = structuralChallengeResult(
            expectedLeaderChangeAfterChallenge,
            outcome,
            evals.STRUCTURAL_EVALUATOR_VERSION,
          );
          const v4 = structuralChallengeResult(
            expectedLeaderChangeAfterChallenge,
            outcome,
            evals.DISCRIMINATING_CHALLENGE_EVALUATOR_VERSION,
          );
          if (v3.score === 0) {
            assert.equal(
              v4.score,
              0,
              `v0.4 passed a combination v0.3 failed: leaderChanged=${leaderChanged} statusChanged=${statusChanged} trialCount=${trialCount} expected=${expectedLeaderChangeAfterChallenge}`,
            );
          }
        }
      }
    }
  }
});

// Guard row: the AIC-138 guard applies only to v0.4, so the exact observation
// the ticket flags — a leader change with zero executed discriminating trials,
// matching the expectation — keeps scoring 1 'passed' under v0.2 and v0.3.
// The row pins that, so a later change to the shared scorer cannot silently
// widen the v0.4 guard onto the versions it must never touch.
test('the leader-change-without-trial observation still scores 1 passed under behavior-evaluators-v0.3 and behavior-evaluators-v0.2', () => {
  const groundTruth = { expectedLeaderChangeAfterChallenge: true };
  const outcome = {
    challengeNodeExecuted: true,
    challengeInvocationCount: 1,
    leaderBeforeChallengeId: 'leader-a',
    leaderAfterChallengeId: 'leader-b',
    executedDiscriminatingTrialCount: 0,
  };

  const v3Result = evals.evaluateStructuralChallengeEffect({ groundTruth, outcome });
  assert.equal(v3Result.score, 1, 'v0.3 must still credit a matching leader change with zero trials');
  assert.equal(v3Result.reason, 'passed');

  const v2Result = evals.evaluateChallengeEffect({
    evaluatorVersion: evals.BEHAVIOR_EVALUATOR_VERSION,
    groundTruth,
    outcome,
  });
  assert.equal(v2Result.score, 1, 'v0.2 must still credit a matching leader change with zero trials');
  assert.equal(v2Result.reason, 'passed');
});

/* -------------------------------------------------------------------------- */
/* C. dispatch through evaluateBenchmarkRecord                                */
/* -------------------------------------------------------------------------- */

function depBOutcome(overrides = {}) {
  return {
    claims: [],
    supportingEvidenceIds: [],
    evidenceFingerprints: [],
    stopKind: 'sufficient',
    conclusionKind: 'root-cause',
    rootCause: { component: 'inventory-api', mechanism: 'connection-pool-exhaustion' },
    rootCauseHypothesisId: 'h1',
    referencedEvidenceIds: ['inventory-api-pool-saturation', 'confirmation-deploy-v17'],
    evidenceAssessments: [
      {
        evidenceId: 'confirmation-deploy-v17',
        hypothesisId: 'h1',
        effect: 'contradicts',
      },
    ],
    ...overrides,
  };
}

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

function challengeKeepsLeaderOutcome(overrides = {}) {
  return {
    claims: [],
    supportingEvidenceIds: [],
    evidenceFingerprints: [],
    stopKind: 'sufficient',
    conclusionKind: 'root-cause',
    challengeEffect: {
      challengeNodeExecuted: true,
      challengeInvocationCount: 1,
      leaderBeforeChallengeId: 'leader-a',
      leaderAfterChallengeId: 'leader-a',
      executedDiscriminatingTrialCount: 1,
    },
    ...overrides,
  };
}

test('evaluateBenchmarkRecord scores a v0.4 record on challenge-keeps-leader by its discriminating trials, and every behavior metric on a v0.4 record carries behavior-evaluators-v0.4', () => {
  const v4 = evals.DISCRIMINATING_CHALLENGE_EVALUATOR_VERSION;

  // challenge-keeps-leader's own ground truth expects no leader change
  // (replay-scenarios.ts:527); zero executed discriminating trials must score
  // the ticket's reason, never 'passed'.
  const untried = evals.evaluateBenchmarkRecord({
    record: calibrationRecord('challenge-keeps-leader', v4),
    outcome: challengeKeepsLeaderOutcome({
      challengeEffect: {
        challengeNodeExecuted: true,
        challengeInvocationCount: 1,
        leaderBeforeChallengeId: 'leader-a',
        leaderAfterChallengeId: 'leader-a',
        executedDiscriminatingTrialCount: 0,
      },
    }),
  });
  assert.deepEqual(untried.behaviorMetrics.challenge_effect, {
    evaluatorVersion: v4,
    key: 'challenge_effect',
    score: 0,
    reason: 'no-investigation-change',
  });

  // One executed discriminating trial: the challenge round did new work, and
  // the pass is credited to it.
  const tried = evals.evaluateBenchmarkRecord({
    record: calibrationRecord('challenge-keeps-leader', v4),
    outcome: challengeKeepsLeaderOutcome(),
  });
  assert.deepEqual(tried.behaviorMetrics.challenge_effect, {
    evaluatorVersion: v4,
    key: 'challenge_effect',
    score: 1,
    reason: 'passed',
  });

  // Every behavior metric a v0.4 record emits carries the v0.4 tag, not only
  // challenge_effect.
  const misleading = evals.evaluateBenchmarkRecord({
    record: calibrationRecord('dependency-caused-incident-b', v4),
    outcome: depBOutcome(),
  });
  assert.equal(misleading.behaviorMetrics.misleading_evidence_handling.evaluatorVersion, v4);

  const falseAlert = evals.evaluateBenchmarkRecord({
    record: calibrationRecord('false-alert', v4),
    outcome: falseAlertOutcome(),
  });
  assert.equal(falseAlert.behaviorMetrics.false_alert_correctness.evaluatorVersion, v4);
});

test('v0.4 scores evidence_coverage, misleading_evidence_handling and false_alert_correctness exactly as v0.3 on every calibration scenario for the same outcome', () => {
  for (const scenarioId of evals.BENCHMARK_SCENARIO_PARTITIONS.calibration) {
    const scenario = evals.REPLAY_SCENARIOS.find(({ id }) => id === scenarioId);
    assert.ok(scenario, `missing scenario ${scenarioId}`);
    const outcome = behaviorPerfectOutcomeFor(scenario);

    const v3Result = evals.evaluateBenchmarkRecord({
      record: calibrationRecord(scenarioId, evals.STRUCTURAL_EVALUATOR_VERSION),
      outcome,
    });
    const v4Result = evals.evaluateBenchmarkRecord({
      record: calibrationRecord(scenarioId, evals.DISCRIMINATING_CHALLENGE_EVALUATOR_VERSION),
      outcome,
    });

    assert.deepEqual(v4Result.metrics, v3Result.metrics, `${scenarioId}: benchmark metrics diverged between v0.3 and v0.4`);
    for (const key of ['misleading_evidence_handling', 'false_alert_correctness']) {
      const v3Metric = v3Result.behaviorMetrics[key];
      const v4Metric = v4Result.behaviorMetrics[key];
      assert.equal(
        v3Metric === undefined,
        v4Metric === undefined,
        `${scenarioId}: ${key} applicability diverged between v0.3 and v0.4`,
      );
      if (v3Metric !== undefined) {
        assert.equal(v4Metric.score, v3Metric.score, `${scenarioId}: ${key} score diverged between v0.3 and v0.4`);
        assert.equal(v4Metric.reason, v3Metric.reason, `${scenarioId}: ${key} reason diverged between v0.3 and v0.4`);
      }
    }
  }
});

test('evaluateBenchmarkRecord refuses behavior-evaluators-v0.99, naming v0.2, v0.3 and v0.4', () => {
  const record = calibrationRecord('bad-deployment', 'behavior-evaluators-v0.99');
  const outcome = {
    claims: [],
    supportingEvidenceIds: [],
    evidenceFingerprints: [],
    stopKind: 'sufficient',
    conclusionKind: 'root-cause',
  };
  assert.throws(
    () => evals.evaluateBenchmarkRecord({ record, outcome }),
    /evaluator version must be behavior-evaluators-v0\.2, behavior-evaluators-v0\.3 or behavior-evaluators-v0\.4/,
  );
});

/* -------------------------------------------------------------------------- */
/* D. the oracle under v0.4                                                   */
/* -------------------------------------------------------------------------- */

test('oracleAnswerFor projects the same structural answer and challenge observation under behavior-evaluators-v0.4 as under v0.3', () => {
  for (const scenario of evals.REPLAY_SCENARIOS) {
    const v3 = oracleAnswerFor(scenario, evals.STRUCTURAL_EVALUATOR_VERSION);
    const v4 = oracleAnswerFor(scenario, evals.DISCRIMINATING_CHALLENGE_EVALUATOR_VERSION);
    assert.deepEqual(v4, v3, `oracleAnswerFor(${scenario.id}, v0.4) must equal oracleAnswerFor(${scenario.id}, v0.3)`);
  }
});

function runEvalOracleScript(extraArgs = []) {
  return spawnSync(
    process.execPath,
    ['--import', './test/fixtures/no-ambient-tracing.mjs', 'scripts/eval-oracle.mjs', ...extraArgs],
    { cwd: projectRoot, encoding: 'utf8', env: childEnv() },
  );
}

const V04_EVIDENCE_PATH = resolve(projectRoot, 'docs/evidence/oracle/behavior-evaluators-v0.4.json');

test('docs/evidence/oracle/behavior-evaluators-v0.4.json deep-equals a fresh run of scripts/eval-oracle.mjs --evaluator-version behavior-evaluators-v0.4, and reaches best on every metric including challenge_effect', () => {
  const executed = runEvalOracleScript(['--evaluator-version', 'behavior-evaluators-v0.4']);
  assert.equal(
    executed.status,
    0,
    `node scripts/eval-oracle.mjs --evaluator-version behavior-evaluators-v0.4 exited ${executed.status}\nstdout:\n${executed.stdout}\nstderr:\n${executed.stderr}`,
  );

  let fresh;
  assert.doesNotThrow(() => {
    fresh = JSON.parse(executed.stdout);
  }, `scripts/eval-oracle.mjs --evaluator-version behavior-evaluators-v0.4 did not print valid JSON to stdout:\n${executed.stdout}`);

  const committed = JSON.parse(readFileSync(V04_EVIDENCE_PATH, 'utf8'));
  assert.deepEqual(
    committed,
    fresh,
    'docs/evidence/oracle/behavior-evaluators-v0.4.json has drifted from a fresh run of scripts/eval-oracle.mjs --evaluator-version behavior-evaluators-v0.4',
  );

  for (const key of [...evals.BENCHMARK_METRIC_KEYS, ...evals.BEHAVIOR_METRIC_KEYS]) {
    assert.equal(
      fresh.reachesBest[key]?.reached,
      true,
      `${key} must reach best under v0.4, including challenge_effect`,
    );
  }
});

/* -------------------------------------------------------------------------- */
/* E. observability: persisting a v0.4 record                                 */
/* -------------------------------------------------------------------------- */

function v4ChallengeResult(record, overrides = {}) {
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
    behaviorMetrics: {
      challenge_effect: {
        evaluatorVersion: evals.DISCRIMINATING_CHALLENGE_EVALUATOR_VERSION,
        key: 'challenge_effect',
        score: 0,
        reason: 'no-discriminating-trial',
      },
    },
    ...overrides,
  };
}

test('persistBenchmarkExperiment accepts a record declaring behavior-evaluators-v0.4 whose challenge_effect reason is no-discriminating-trial', async () => {
  const record = calibrationRecord('challenge-keeps-leader', evals.DISCRIMINATING_CHALLENGE_EVALUATOR_VERSION);
  const result = v4ChallengeResult(record);
  const capture = capturingClient();

  await observability.persistBenchmarkExperiment({
    client: capture.client,
    datasetName: 'discriminating-v0.4-accepted',
    experiment: { records: [record], results: [result] },
  });

  assert.equal(capture.runs.length, 1);
  assert.equal(capture.runs[0].extra.metadata.evaluatorVersion, evals.DISCRIMINATING_CHALLENGE_EVALUATOR_VERSION);
  assert.equal(capture.runs[0].outputs.behaviorMetrics.challenge_effect.reason, 'no-discriminating-trial');
  assert.equal(
    capture.runs[0].outputs.behaviorMetrics.challenge_effect.evaluatorVersion,
    evals.DISCRIMINATING_CHALLENGE_EVALUATOR_VERSION,
  );
});
