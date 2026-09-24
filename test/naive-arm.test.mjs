/**
 * AIC-116 (v0.2 evidence repair, slice 2): the benchmark runner for the naive
 * arm — the code that turns a `BenchmarkExecutionInput` into what the naive
 * single-prompt role (`@aic/roles`, AIC-115) is allowed to see, drives it once
 * per record, and scores the answer through the same evaluators every other
 * arm is scored by.
 *
 * What the rows pin:
 *  - `@aic/roles` grows a `./naive` subpath export (`packages/roles/package.json`)
 *    that reaches `naive-role.ts` directly, bypassing the package's root barrel
 *    (`packages/roles/src/index.ts`), which itself imports `@aic/graph` for
 *    `ROLE_DEPENDENCIES` — so a module that must never reach the graph, even
 *    transitively, cannot import `@aic/roles` from its root;
 *  - `packages/evals/src/naive-arm.ts` exports `NAIVE_NOT_APPLICABLE` (a frozen,
 *    single-key `{ challenge_effect: <reason> }`), `naiveInputFor` (projects a
 *    `BenchmarkExecutionInput` into the naive role's `NaiveInvestigationInput`,
 *    with no scenario id, ground truth, or metadata anywhere in the result) and
 *    `runNaiveBenchmarkExperiment` (drives the naive role once per record,
 *    through `outcomeFromArmAnswer`, and scores it — never showing the callback
 *    anything but the projected input);
 *  - `evaluateBenchmarkRecord` grows an optional `notApplicable` argument: a
 *    metric named in it is not computed, and the result carries the map instead;
 *  - `packages/evals/src/benchmark-evaluation.ts` no longer imports `@aic/graph`
 *    — `runGraphBenchmarkExperiment` and its private helpers move to a new
 *    `packages/evals/src/graph-benchmark.ts`, and the `@aic/evals` root keeps
 *    exporting `runGraphBenchmarkExperiment` unchanged;
 *  - a new dependency-cruiser rule, `naive-arm-does-not-reach-the-graph`,
 *    refuses `packages/evals/(src|dist)/naive-arm.*` reaching `@aic/graph` or
 *    `packages/graph`, directly or through a module it imports (such as the new
 *    `graph-benchmark.ts`).
 *
 * Every fake answer a scoring row hands `investigate` below is written from
 * literal evidence ids and a literal root cause, never by reading
 * `STRUCTURAL_GROUND_TRUTH` — the same discipline `structural-evaluator.test.mjs`
 * and `oracle-positive-control.test.mjs` already follow, so a row cannot pass by
 * asking the production ground-truth table what its own answer should be.
 * Which record a fake `investigate` is answering for is told apart from the
 * evidence ids the fixture actually SHOWS it (`shownIds`, below) — real,
 * observable telemetry a model would also see — never from the scenario id or
 * ground truth the callback boundary this file pins must keep out of reach.
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import * as evals from '@aic/evals';

import { benchmarkVersions, replayBackedNodes } from './fixtures/benchmark-experiment.mjs';
import { childEnv } from './fixtures/child-env.mjs';

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

function requireEvalsExport(name) {
  assert.ok(evals[name] !== undefined, `@aic/evals must export ${name}`);
  return evals[name];
}

const structuralVersions = Object.freeze({
  ...benchmarkVersions,
  evaluatorVersion: 'behavior-evaluators-v0.3',
});

/* -------------------------------------------------------------------------- */
/* A. @aic/roles/naive — reachable without the graph-importing root barrel    */
/* -------------------------------------------------------------------------- */

test('exposes createModelNaiveInvestigation, NAIVE_PROMPT_VERSION and NAIVE_STOP_KINDS from the @aic/roles/naive subpath', async () => {
  const naive = await import('@aic/roles/naive');
  assert.equal(typeof naive.createModelNaiveInvestigation, 'function');
  assert.equal(naive.NAIVE_PROMPT_VERSION, 'naive-single-prompt-v0.1');
  assert.deepEqual(naive.NAIVE_STOP_KINDS, [
    'sufficient',
    'ambiguous',
    'stalled',
    'tools-unavailable',
  ]);
});

/* -------------------------------------------------------------------------- */
/* B. NAIVE_NOT_APPLICABLE and naiveInputFor                                  */
/* -------------------------------------------------------------------------- */

test('NAIVE_NOT_APPLICABLE is frozen and carries exactly one key, challenge_effect, naming a non-empty reason', () => {
  const NAIVE_NOT_APPLICABLE = requireEvalsExport('NAIVE_NOT_APPLICABLE');
  assert.deepEqual(Object.keys(NAIVE_NOT_APPLICABLE), ['challenge_effect']);
  assert.equal(typeof NAIVE_NOT_APPLICABLE.challenge_effect, 'string');
  assert.ok(NAIVE_NOT_APPLICABLE.challenge_effect.length > 0);
  assert.equal(Object.isFrozen(NAIVE_NOT_APPLICABLE), true);
});

const NAIVE_ARM_PROJECTION_RUN_ID = 'dddddddd-3333-4ddd-8ddd-dddddddddddd';
const NAIVE_ARM_PROJECTION_SCENARIO_ID = 'naive-arm-projection-scenario-marker';

function makeEvidence(id, kind, source, statement) {
  return {
    id,
    trialId: `trial-${id}`,
    kind,
    source,
    observedAt: '2026-09-24T00:00:00.000Z',
    statement,
    rawRef: `unit://${source}/${id}`,
  };
}

const projectionOkEvidence = makeEvidence(
  'naive-projection-ok-1',
  'log',
  'logs/checkout',
  'a hand-built ok statement',
);

/** A hand-built `BenchmarkExecutionInput`, one entry of each status the fixture shape declares. */
function handBuiltExecutionInput() {
  return {
    experimentId: 'naive-arm-projection-probe',
    exampleId: 'naive-arm-projection-example',
    scenarioId: NAIVE_ARM_PROJECTION_SCENARIO_ID,
    runId: NAIVE_ARM_PROJECTION_RUN_ID,
    threadId: NAIVE_ARM_PROJECTION_RUN_ID,
    metadata: {
      ...structuralVersions,
      runId: NAIVE_ARM_PROJECTION_RUN_ID,
      scenarioId: NAIVE_ARM_PROJECTION_SCENARIO_ID,
      humanReview: false,
    },
    fixture: {
      version: 1,
      entries: [
        {
          toolId: 'logs',
          input: { service: 'checkout' },
          result: { status: 'ok', output: [projectionOkEvidence] },
        },
        {
          toolId: 'traces',
          input: { service: 'checkout', window: 'incident' },
          result: { status: 'unavailable', reason: 'traces expired before collection' },
        },
        {
          toolId: 'metrics',
          input: { service: 'checkout', metric: 'error_rate' },
          result: { status: 'error', message: 'metrics backend threw' },
        },
      ],
    },
  };
}

test('naiveInputFor derives incidentId from opaqueIncidentId(runId)', () => {
  const naiveInputFor = requireEvalsExport('naiveInputFor');
  const result = naiveInputFor(handBuiltExecutionInput());
  assert.equal(result.incidentId, evals.opaqueIncidentId(NAIVE_ARM_PROJECTION_RUN_ID));
});

test('naiveInputFor maps each fixture entry to the matching NaiveTelemetryEntry status, in entry order', () => {
  const naiveInputFor = requireEvalsExport('naiveInputFor');
  const result = naiveInputFor(handBuiltExecutionInput());

  assert.deepEqual(result, {
    incidentId: evals.opaqueIncidentId(NAIVE_ARM_PROJECTION_RUN_ID),
    entries: [
      {
        status: 'ok',
        tool: 'logs',
        input: { service: 'checkout' },
        evidence: [projectionOkEvidence],
      },
      {
        status: 'unavailable',
        tool: 'traces',
        input: { service: 'checkout', window: 'incident' },
        reason: 'traces expired before collection',
      },
      {
        status: 'error',
        tool: 'metrics',
        input: { service: 'checkout', metric: 'error_rate' },
        message: 'metrics backend threw',
      },
    ],
  });
});

function collectKeysAndStrings(value, strings) {
  if (typeof value === 'string') {
    strings.push(value);
    return;
  }
  if (value === null || typeof value !== 'object') return;
  for (const key of Object.keys(value)) {
    strings.push(key);
    collectKeysAndStrings(value[key], strings);
  }
}

const FORBIDDEN_PROJECTION_KEYS = Object.freeze([
  'scenarioId',
  'groundTruth',
  'metadata',
  'scenario',
  'fixture',
]);

test('naiveInputFor carries no scenario id, ground truth or metadata anywhere in its result', () => {
  const naiveInputFor = requireEvalsExport('naiveInputFor');
  const executionInput = handBuiltExecutionInput();
  const result = naiveInputFor(executionInput);

  const strings = [];
  collectKeysAndStrings(result, strings);

  for (const forbiddenKey of FORBIDDEN_PROJECTION_KEYS) {
    assert.equal(
      strings.includes(forbiddenKey),
      false,
      `naiveInputFor's result must never carry a "${forbiddenKey}" key`,
    );
  }
  for (const text of strings) {
    assert.equal(
      text.includes(executionInput.scenarioId),
      false,
      `naiveInputFor's result must never embed the scenario id, found in "${text}"`,
    );
  }
});

/* -------------------------------------------------------------------------- */
/* C. runNaiveBenchmarkExperiment                                             */
/* -------------------------------------------------------------------------- */

const DEFAULT_NAIVE_ANSWER = Object.freeze({
  hypotheses: Object.freeze([]),
  assessments: Object.freeze([]),
  conclusion: Object.freeze({ kind: 'inconclusive', causes: Object.freeze([]) }),
  stopKind: 'stalled',
});

function shownIds(input) {
  return new Set(
    input.entries.flatMap((entry) => (entry.status === 'ok' ? entry.evidence.map(({ id }) => id) : [])),
  );
}

function resultsFor(experiment, scenarioId) {
  return experiment.records
    .map((record, index) => ({ record, result: experiment.results[index] }))
    .filter(({ record }) => record.scenario.id === scenarioId)
    .map(({ result }) => result);
}

test('keeps scenario ground truth outside the naive investigation callback, over the calibration plan', async () => {
  const runNaiveBenchmarkExperiment = requireEvalsExport('runNaiveBenchmarkExperiment');
  const calibrationIds = evals.BENCHMARK_SCENARIO_PARTITIONS.calibration;
  const callbackInputs = [];

  const experiment = await runNaiveBenchmarkExperiment({
    experimentId: 'naive-ground-truth-boundary',
    scenarioSet: 'calibration',
    runsPerScenario: 3,
    metadata: structuralVersions,
    async investigate(input) {
      callbackInputs.push(input);
      return DEFAULT_NAIVE_ANSWER;
    },
    async recordEvaluation() {},
  });

  assert.equal(callbackInputs.length, calibrationIds.length * 3);
  assert.equal(experiment.results.length, calibrationIds.length * 3);

  for (const input of callbackInputs) {
    assert.deepEqual(Object.keys(input).sort(), ['entries', 'incidentId']);
    for (const forbiddenKey of ['groundTruth', 'scenarioId', 'scenario', 'metadata', 'fixture']) {
      assert.equal(
        Object.hasOwn(input, forbiddenKey),
        false,
        `naive investigate callback input must never carry a "${forbiddenKey}" key`,
      );
    }
    const strings = [];
    collectKeysAndStrings(input, strings);
    for (const scenarioId of calibrationIds) {
      for (const text of strings) {
        assert.equal(
          text.includes(scenarioId),
          false,
          `naive investigate callback input leaked scenario id "${scenarioId}" via "${text}"`,
        );
      }
    }
  }
});

test("calls investigate exactly once per record, in the plan's own order", async () => {
  const runNaiveBenchmarkExperiment = requireEvalsExport('runNaiveBenchmarkExperiment');
  const callbackIncidentIds = [];

  const experiment = await runNaiveBenchmarkExperiment({
    experimentId: 'naive-one-call-per-record',
    scenarioSet: 'calibration',
    runsPerScenario: 3,
    metadata: structuralVersions,
    async investigate(input) {
      callbackIncidentIds.push(input.incidentId);
      return DEFAULT_NAIVE_ANSWER;
    },
    async recordEvaluation() {},
  });

  const expectedIncidentIds = experiment.records.map((record) =>
    evals.opaqueIncidentId(record.runId),
  );
  assert.deepEqual(callbackIncidentIds, expectedIncidentIds);
});

const BAD_DEPLOYMENT_MARKER_ID = 'checkout-deploy-v42';

test('scores bad-deployment perfect on the structural core metrics when the answer cites its literal expected evidence and root cause', async () => {
  const runNaiveBenchmarkExperiment = requireEvalsExport('runNaiveBenchmarkExperiment');

  const experiment = await runNaiveBenchmarkExperiment({
    experimentId: 'naive-bad-deployment-full-pass',
    scenarioSet: 'calibration',
    runsPerScenario: 3,
    metadata: structuralVersions,
    async investigate(input) {
      if (!shownIds(input).has(BAD_DEPLOYMENT_MARKER_ID)) return DEFAULT_NAIVE_ANSWER;
      return {
        hypotheses: [
          { id: 'naive-bad-deployment-hyp', statement: 'checkout deployment broke the database endpoint' },
        ],
        assessments: [],
        conclusion: {
          kind: 'root-cause',
          causes: [
            {
              hypothesisId: 'naive-bad-deployment-hyp',
              cause: { component: 'checkout', mechanism: 'deployment-regression' },
              evidenceIds: ['checkout-deploy-v42', 'checkout-invalid-database-endpoint'],
            },
          ],
        },
        stopKind: 'sufficient',
      };
    },
    async recordEvaluation() {},
  });

  const badDeploymentResults = resultsFor(experiment, 'bad-deployment');
  assert.equal(badDeploymentResults.length, 3);
  for (const result of badDeploymentResults) {
    assert.equal(result.metrics.evidence_coverage.score, 1);
    assert.equal(result.metrics.unsupported_claim_rate.score, 0);
    assert.equal(result.metrics.termination_correctness.score, 1);
  }
});

test('does not credit evidence merely shown but never cited: bad-deployment scores evidence_coverage 0 when the answer has no causes and no assessments', async () => {
  const runNaiveBenchmarkExperiment = requireEvalsExport('runNaiveBenchmarkExperiment');

  const experiment = await runNaiveBenchmarkExperiment({
    experimentId: 'naive-bad-deployment-uncited-evidence',
    scenarioSet: 'calibration',
    runsPerScenario: 3,
    metadata: structuralVersions,
    async investigate() {
      return DEFAULT_NAIVE_ANSWER;
    },
    async recordEvaluation() {},
  });

  const badDeploymentResults = resultsFor(experiment, 'bad-deployment');
  assert.equal(badDeploymentResults.length, 3);
  for (const result of badDeploymentResults) {
    assert.equal(result.metrics.evidence_coverage.score, 0);
  }
});

test('challenge_effect is never computed for a naive result, and every result carries notApplicable equal to NAIVE_NOT_APPLICABLE', async () => {
  const runNaiveBenchmarkExperiment = requireEvalsExport('runNaiveBenchmarkExperiment');
  const NAIVE_NOT_APPLICABLE = requireEvalsExport('NAIVE_NOT_APPLICABLE');

  const experiment = await runNaiveBenchmarkExperiment({
    experimentId: 'naive-challenge-not-applicable',
    scenarioSet: 'calibration',
    runsPerScenario: 3,
    metadata: structuralVersions,
    async investigate() {
      return DEFAULT_NAIVE_ANSWER;
    },
    async recordEvaluation() {},
  });

  assert.ok(experiment.results.length > 0);
  for (const result of experiment.results) {
    assert.equal(Object.hasOwn(result.behaviorMetrics, 'challenge_effect'), false);
    assert.deepEqual(result.notApplicable, NAIVE_NOT_APPLICABLE);
  }

  // challenge-keeps-leader is the calibration scenario that declares a
  // challenge expectation, so it is where a metric would otherwise appear.
  const challengeKeepsLeaderResults = resultsFor(experiment, 'challenge-keeps-leader');
  assert.equal(challengeKeepsLeaderResults.length, 3);
  for (const result of challengeKeepsLeaderResults) {
    assert.equal(Object.hasOwn(result.behaviorMetrics, 'challenge_effect'), false);
  }
});

test('scores the other behavior metrics where they apply: misleading_evidence_handling on dependency-caused-incident-b, false_alert_correctness on false-alert', async () => {
  const runNaiveBenchmarkExperiment = requireEvalsExport('runNaiveBenchmarkExperiment');

  const experiment = await runNaiveBenchmarkExperiment({
    experimentId: 'naive-other-behavior-metrics-present',
    scenarioSet: 'calibration',
    runsPerScenario: 3,
    metadata: structuralVersions,
    async investigate() {
      return DEFAULT_NAIVE_ANSWER;
    },
    async recordEvaluation() {},
  });

  for (const result of resultsFor(experiment, 'dependency-caused-incident-b')) {
    assert.equal(Object.hasOwn(result.behaviorMetrics, 'misleading_evidence_handling'), true);
  }
  for (const result of resultsFor(experiment, 'false-alert')) {
    assert.equal(Object.hasOwn(result.behaviorMetrics, 'false_alert_correctness'), true);
  }
});

test('a refusal from investigate propagates out of runNaiveBenchmarkExperiment, and no result is recorded for the run that refused', async () => {
  const runNaiveBenchmarkExperiment = requireEvalsExport('runNaiveBenchmarkExperiment');
  const recorded = [];

  await assert.rejects(
    () =>
      runNaiveBenchmarkExperiment({
        experimentId: 'naive-refusal-propagation',
        scenarioSet: 'ad-hoc',
        scenarios: evals.REPLAY_SCENARIOS.slice(0, 5),
        runsPerScenario: 3,
        metadata: structuralVersions,
        async investigate() {
          throw new Error('the naive role refused to answer');
        },
        async recordEvaluation(payload) {
          recorded.push(payload);
        },
      }),
    /the naive role refused to answer/,
  );

  assert.equal(
    recorded.length,
    0,
    'a refused run must never reach recordEvaluation with a zero-filled result',
  );
});

test('the graph runner is unaffected: a graph result carries no notApplicable key', async () => {
  const runGraphBenchmarkExperiment = requireEvalsExport('runGraphBenchmarkExperiment');
  const traces = new Map();
  const replayCounts = new Map();

  const experiment = await runGraphBenchmarkExperiment({
    experimentId: 'naive-arm-does-not-touch-graph-runner',
    scenarioSet: 'ad-hoc',
    scenarios: evals.REPLAY_SCENARIOS.slice(0, 5),
    runsPerScenario: 3,
    metadata: benchmarkVersions,
    createNodes(record) {
      traces.set(record.runId, []);
      replayCounts.set(record.runId, 0);
      return replayBackedNodes(record, traces, replayCounts);
    },
    async recordEvaluation() {},
  });

  assert.equal(experiment.results.length, 15);
  for (const result of experiment.results) {
    assert.equal(Object.hasOwn(result, 'notApplicable'), false);
  }
});

/* -------------------------------------------------------------------------- */
/* D. evaluateBenchmarkRecord: an optional notApplicable argument             */
/* -------------------------------------------------------------------------- */

function notApplicableProbeRecord(scenario, evaluatorVersion = structuralVersions.evaluatorVersion) {
  const runId = 'notApplicable-probe-run';
  return {
    experimentId: 'notApplicable-probe',
    exampleId: 'notApplicable-probe-example',
    scenario,
    runId,
    threadId: runId,
    metadata: {
      ...structuralVersions,
      evaluatorVersion,
      runId,
      scenarioId: scenario.id,
      humanReview: false,
    },
  };
}

function notApplicableProbeOutcome() {
  return {
    claims: [],
    supportingEvidenceIds: [],
    evidenceFingerprints: [],
    referencedEvidenceIds: [],
    stopKind: 'sufficient',
    conclusionKind: 'root-cause',
    rootCause: { component: 'payments', mechanism: 'deployment-regression' },
    rootCauseHypothesisId: 'notApplicable-probe-hyp',
  };
}

/**
 * Which conditional behavior metric applies to which calibration scenario,
 * and the condition on the scenario's own `groundTruth` that `evaluateBenchmarkRecord`
 * decides it from (`packages/evals/src/benchmark-evaluation.ts`) — read off
 * `replay-scenarios.ts` directly, not asserted from the evaluator's own
 * behavior, so the row below is checking the evaluator against an
 * independent fact about the fixture rather than against itself.
 */
const NOT_APPLICABLE_TABLE_ROWS = Object.freeze([
  Object.freeze({
    metric: 'misleading_evidence_handling',
    scenarioId: 'dependency-caused-incident-b',
    assertConditionHolds(groundTruth) {
      assert.notEqual(groundTruth.rootCause, undefined);
      assert.notEqual(groundTruth.misleadingEvidence, undefined);
    },
  }),
  Object.freeze({
    metric: 'false_alert_correctness',
    scenarioId: 'false-alert',
    assertConditionHolds(groundTruth) {
      assert.equal(groundTruth.expectedConclusionKind, 'no-incident');
    },
  }),
  Object.freeze({
    metric: 'challenge_effect',
    scenarioId: 'challenge-keeps-leader',
    assertConditionHolds(groundTruth) {
      assert.notEqual(groundTruth.expectedLeaderChangeAfterChallenge, undefined);
    },
  }),
]);

const NOT_APPLICABLE_TABLE_EVALUATOR_VERSIONS = Object.freeze([
  evals.BEHAVIOR_EVALUATOR_VERSION,
  'behavior-evaluators-v0.3',
]);

for (const row of NOT_APPLICABLE_TABLE_ROWS) {
  for (const evaluatorVersion of NOT_APPLICABLE_TABLE_EVALUATOR_VERSIONS) {
    test(`evaluateBenchmarkRecord skips ${row.metric} on ${row.scenarioId} under evaluatorVersion ${evaluatorVersion} when notApplicable names it, and computes it by default`, () => {
      const scenario = evals.REPLAY_SCENARIOS.find(({ id }) => id === row.scenarioId);
      assert.ok(scenario, `missing scenario ${row.scenarioId}`);
      row.assertConditionHolds(scenario.groundTruth);

      const record = notApplicableProbeRecord(scenario, evaluatorVersion);

      // Control: with no notApplicable argument, the metric is present — so
      // the row below is not vacuously true of a metric never computed here.
      const controlResult = evals.evaluateBenchmarkRecord({
        record,
        outcome: notApplicableProbeOutcome(),
      });
      assert.equal(
        Object.hasOwn(controlResult.behaviorMetrics, row.metric),
        true,
        `${row.metric} must be present on ${row.scenarioId} under evaluatorVersion ${evaluatorVersion} when notApplicable is not given`,
      );

      const notApplicable = Object.freeze({ [row.metric]: `${row.metric} is not applicable for this probe` });
      const skippedResult = evals.evaluateBenchmarkRecord({
        record,
        outcome: notApplicableProbeOutcome(),
        notApplicable,
      });
      assert.equal(
        Object.hasOwn(skippedResult.behaviorMetrics, row.metric),
        false,
        `${row.metric} must be absent on ${row.scenarioId} under evaluatorVersion ${evaluatorVersion} when notApplicable names it`,
      );
      assert.deepEqual(skippedResult.notApplicable, notApplicable);
    });
  }
}

test('evaluateBenchmarkRecord given notApplicable: null throws a named refusal rather than a TypeError from Object.entries', () => {
  const scenario = evals.REPLAY_SCENARIOS.find(({ id }) => id === 'challenge-keeps-leader');
  assert.ok(scenario);

  assert.throws(
    () =>
      evals.evaluateBenchmarkRecord({
        record: notApplicableProbeRecord(scenario),
        outcome: notApplicableProbeOutcome(),
        notApplicable: null,
      }),
    (error) => {
      assert.ok(
        error instanceof Error && !(error instanceof TypeError),
        `expected a named Error (not a TypeError), got ${error?.constructor?.name}: ${error?.message}`,
      );
      assert.match(error.message, /notApplicable|not.applicable/i);
      return true;
    },
  );
});

test('evaluateBenchmarkRecord given a non-object notApplicable refuses it by naming the required shape', () => {
  const scenario = evals.REPLAY_SCENARIOS.find(({ id }) => id === 'challenge-keeps-leader');
  assert.ok(scenario);

  assert.throws(
    () =>
      evals.evaluateBenchmarkRecord({
        record: notApplicableProbeRecord(scenario),
        outcome: notApplicableProbeOutcome(),
        notApplicable: 'challenge_effect',
      }),
    (error) => {
      assert.ok(
        error instanceof Error && !(error instanceof TypeError),
        `expected a named Error (not a TypeError), got ${error?.constructor?.name}: ${error?.message}`,
      );
      assert.match(error.message, /object|map/i);
      return true;
    },
  );
});

test('runBenchmarkExperiment refuses an invalid notApplicable before calling investigate for any record', async () => {
  const runBenchmarkExperiment = requireEvalsExport('runBenchmarkExperiment');
  let investigateCalls = 0;

  await assert.rejects(() =>
    runBenchmarkExperiment({
      experimentId: 'notApplicable-invalid-refused-before-investigate',
      scenarioSet: 'ad-hoc',
      scenarios: evals.REPLAY_SCENARIOS.slice(0, 5),
      runsPerScenario: 3,
      metadata: structuralVersions,
      notApplicable: { not_a_metric: 'x' },
      async investigate() {
        investigateCalls += 1;
        return {
          claims: [],
          supportingEvidenceIds: [],
          evidenceFingerprints: [],
          referencedEvidenceIds: [],
          stopKind: 'stalled',
          conclusionKind: 'inconclusive',
        };
      },
      async recordEvaluation() {},
    }),
  );

  assert.equal(
    investigateCalls,
    0,
    'an invalid notApplicable must be refused before the plan drives a single investigate call',
  );
});

test('runNaiveBenchmarkExperiment does not forward a caller-smuggled collectResources option to the underlying runner', async () => {
  const runNaiveBenchmarkExperiment = requireEvalsExport('runNaiveBenchmarkExperiment');
  let collectResourcesCalls = 0;

  const experiment = await runNaiveBenchmarkExperiment({
    experimentId: 'naive-collect-resources-not-forwarded',
    scenarioSet: 'calibration',
    runsPerScenario: 3,
    metadata: structuralVersions,
    // `NaiveExperimentOptions` (packages/evals/src/naive-arm.ts) omits
    // `collectResources` at the type level; this is a JS caller passing it
    // anyway, which TypeScript cannot stop at runtime.
    collectResources() {
      collectResourcesCalls += 1;
      return {
        logicalIterationsUsed: 1,
        declaredLlmCallsUsed: 1,
        toolCallsUsed: 1,
        retryCount: 0,
        resumeCount: 0,
      };
    },
    async investigate() {
      return DEFAULT_NAIVE_ANSWER;
    },
    async recordEvaluation() {},
  });

  assert.equal(
    collectResourcesCalls,
    0,
    'the naive arm measures nothing about its own spend: a smuggled collectResources must never run',
  );
  assert.ok(experiment.results.length > 0);
  for (const result of experiment.results) {
    assert.equal(
      Object.hasOwn(result, 'resources'),
      false,
      'a naive result must carry no own resources key when nothing measured it',
    );
  }
});

test('evaluateBenchmarkRecord omits a metric named in notApplicable, and the result carries the map', () => {
  const scenario = evals.REPLAY_SCENARIOS.find(({ id }) => id === 'challenge-keeps-leader');
  assert.ok(scenario);

  const result = evals.evaluateBenchmarkRecord({
    record: notApplicableProbeRecord(scenario),
    outcome: notApplicableProbeOutcome(),
    notApplicable: { challenge_effect: 'the naive arm runs no challenge round' },
  });

  assert.equal(Object.hasOwn(result.behaviorMetrics, 'challenge_effect'), false);
  assert.deepEqual(result.notApplicable, { challenge_effect: 'the naive arm runs no challenge round' });
});

test('evaluateBenchmarkRecord refuses a notApplicable key that is not a metric key', () => {
  const scenario = evals.REPLAY_SCENARIOS.find(({ id }) => id === 'challenge-keeps-leader');
  assert.ok(scenario);

  assert.throws(() =>
    evals.evaluateBenchmarkRecord({
      record: notApplicableProbeRecord(scenario),
      outcome: notApplicableProbeOutcome(),
      notApplicable: { not_a_real_metric_key: 'x' },
    }),
  );
});

/* -------------------------------------------------------------------------- */
/* E. benchmark-evaluation.ts, arm-answer.ts, naive-arm.ts import no @aic/graph */
/* -------------------------------------------------------------------------- */

function sourceTextOf(relativePath) {
  return readFileSync(resolve(projectRoot, relativePath), 'utf8');
}

test('packages/evals/src/benchmark-evaluation.ts imports no @aic/graph', () => {
  assert.doesNotMatch(
    sourceTextOf('packages/evals/src/benchmark-evaluation.ts'),
    /@aic\/graph/,
    'benchmark-evaluation.ts must not import @aic/graph: the graph-specific runner moves to graph-benchmark.ts',
  );
});

test('packages/evals/src/arm-answer.ts imports no @aic/graph', () => {
  assert.doesNotMatch(
    sourceTextOf('packages/evals/src/arm-answer.ts'),
    /@aic\/graph/,
    'arm-answer.ts must not import @aic/graph',
  );
});

test('packages/evals/src/naive-arm.ts imports no @aic/graph', () => {
  assert.doesNotMatch(
    sourceTextOf('packages/evals/src/naive-arm.ts'),
    /@aic\/graph/,
    'naive-arm.ts must not import @aic/graph: it is the no-graph baseline runner',
  );
});

/* -------------------------------------------------------------------------- */
/* F. dependency-cruiser: naive-arm-does-not-reach-the-graph                  */
/* -------------------------------------------------------------------------- */

/**
 * The exact probe shape `test/oracle-positive-control.test.mjs` and
 * `test/naive-role.test.mjs` each duplicate rather than import — see either
 * file's header for why every existing depcruise probe in this repository
 * accepts the duplication rather than manufacturing a shared import for it.
 *
 * FILE-SAFETY: the copy and every mutation below live under this ONE
 * `mkdtempSync` directory, deleted in its own `finally` — nothing outside it
 * is ever touched.
 */
function copyForBoundaryProbe() {
  const temporaryRoot = mkdtempSync(join(tmpdir(), 'aic-naive-arm-boundary-'));
  const fixtureRoot = join(temporaryRoot, 'repository');
  const excludedEntries = new Set([
    '.agents',
    '.claude',
    '.codex',
    '.git',
    '.github',
    'coverage',
    'node_modules',
  ]);

  cpSync(projectRoot, fixtureRoot, {
    recursive: true,
    filter(source) {
      const pathFromRoot = relative(projectRoot, source);
      return pathFromRoot === '' || !excludedEntries.has(pathFromRoot.split('/')[0]);
    },
  });

  const sourceNodeModules = resolve(projectRoot, 'node_modules');
  if (existsSync(sourceNodeModules)) {
    symlinkSync(sourceNodeModules, resolve(fixtureRoot, 'node_modules'), 'dir');
  }

  return { fixtureRoot, temporaryRoot };
}

function runNpm(args, cwd) {
  return spawnSync('npm', args, {
    cwd,
    encoding: 'utf8',
    env: childEnv({ CI: '1' }),
  });
}

function commandDiagnostics(command, result) {
  return `${command} exited ${result.status}\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`;
}

function runDepcruiseProbe(mutate) {
  const { fixtureRoot, temporaryRoot } = copyForBoundaryProbe();
  try {
    const baseline = runNpm(['run', '--silent', 'lint:graph'], fixtureRoot);
    assert.equal(
      baseline.status,
      0,
      `the unmodified scaffold must pass npm run lint:graph before a boundary probe is meaningful\n${commandDiagnostics('npm run lint:graph', baseline)}`,
    );

    mutate(fixtureRoot);
    return runNpm(['run', '--silent', 'lint:graph'], fixtureRoot);
  } finally {
    rmSync(temporaryRoot, { recursive: true, force: true });
  }
}

test('rejects packages/evals/src/naive-arm.ts importing @aic/graph directly', () => {
  const result = runDepcruiseProbe((fixtureRoot) => {
    const path = resolve(fixtureRoot, 'packages/evals/src/naive-arm.ts');
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, 'import "@aic/graph";\nexport {};\n');
  });
  assert.notEqual(
    result.status,
    0,
    `npm run lint:graph accepted packages/evals/src/naive-arm.ts importing @aic/graph: this is the no-graph baseline runner and must depend on no graph orchestration\n${commandDiagnostics('npm run lint:graph', result)}`,
  );
  assert.match(
    result.stdout + result.stderr,
    /naive-arm-does-not-reach-the-graph/,
    `the refusal must come from the naive-arm-does-not-reach-the-graph rule itself\n${commandDiagnostics('npm run lint:graph', result)}`,
  );
});

test('rejects packages/evals/src/naive-arm.ts reaching the graph transitively through ./graph-benchmark.js', () => {
  const result = runDepcruiseProbe((fixtureRoot) => {
    const naiveArmPath = resolve(fixtureRoot, 'packages/evals/src/naive-arm.ts');
    const graphBenchmarkPath = resolve(fixtureRoot, 'packages/evals/src/graph-benchmark.ts');
    mkdirSync(dirname(naiveArmPath), { recursive: true });
    writeFileSync(naiveArmPath, 'import "./graph-benchmark.js";\nexport {};\n');
    // graph-benchmark.ts is where runGraphBenchmarkExperiment moves to (section
    // C above), and it legitimately imports @aic/graph — written here rather
    // than relying on the real file so this probe is meaningful whether or not
    // graph-benchmark.ts has landed yet in the tree it copies.
    writeFileSync(graphBenchmarkPath, 'import "@aic/graph";\nexport {};\n');
  });
  assert.notEqual(
    result.status,
    0,
    `npm run lint:graph accepted packages/evals/src/naive-arm.ts reaching the graph transitively through graph-benchmark.ts\n${commandDiagnostics('npm run lint:graph', result)}`,
  );
  assert.match(
    result.stdout + result.stderr,
    /naive-arm-does-not-reach-the-graph/,
    `the refusal must come from the naive-arm-does-not-reach-the-graph rule itself\n${commandDiagnostics('npm run lint:graph', result)}`,
  );
});
