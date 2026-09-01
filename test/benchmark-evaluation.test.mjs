import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  benchmarkVersions,
  getControlledMutationCycle,
  perfectOutcomeFor,
  replayBackedNodes,
  requireFunction,
} from './fixtures/benchmark-experiment.mjs';
import { childEnv } from './fixtures/child-env.mjs';

import * as evals from '@aic/evals';
import * as graph from '@aic/graph';
import * as observability from '@aic/observability';

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

function currentHeadSha() {
  return execFileSync('git', ['rev-parse', 'HEAD'], {
    cwd: projectRoot,
    encoding: 'utf8',
    env: childEnv(),
  }).trim();
}

const expectedMetricKeys = [
  'evidence_coverage',
  'termination_correctness',
  'unsupported_claim_rate',
];

const expectedMetricScores = {
  evidence_coverage: 1,
  termination_correctness: 1,
  unsupported_claim_rate: 0,
};

const acceptedV01ScenarioIds = [
  'bad-deployment',
  'db-pool-exhaustion',
  'false-alert',
  'deployment-caused-incident-a',
  'dependency-caused-incident-b',
];

const acceptedV01ExampleIds = [
  'c14e9030-60d5-89f5-9488-84993d6fc6ca',
  'ae3bd54e-06b6-8423-ba59-e6855f95f0f2',
  '94f9d1cf-6914-87b2-a213-fbfb7a358cd1',
  '13f75678-c0cd-8ce7-a144-3b07160a7a40',
  '85cc633e-09ce-82f5-a620-6db31f4a1858',
  '128a8860-cb97-80a2-bfae-a8d948fc7b9e',
  'de62ed11-b5bf-859e-a3b1-be4ab531cadb',
  '3fabb8f1-1bd6-8fea-8d63-c97c9ec7fac3',
  '7b9efa5d-de95-8180-bef4-568a5f215cc9',
  'fda246df-187d-8f70-9d30-4aa7d32d63b8',
  'fe932583-2509-8449-9c1d-bc059d54d4d0',
  '00d9e595-7c46-8b5f-abb8-5fbf5b1f98bf',
  '43e98931-cb85-8a5c-91e8-b276e9e0e240',
  '86051c38-8cd2-86fb-a16b-78cb50878cb1',
  '602db4a5-7406-8e46-812e-e163dc6310e0',
];

const expectedCalibrationScenarioIds = [
  ...acceptedV01ScenarioIds,
  'multiple-plausible-causes',
  'transient-self-resolved',
  'challenge-keeps-leader',
];

const expectedHoldoutScenarioIds = [
  'incomplete-evidence',
  'challenge-changes-leader',
];

const expectedLifecycleNodes = [
  'normalize_incident',
  'collect_baseline',
  'generate_hypotheses',
  'derive_predictions',
  'plan_investigation',
  'execute_investigation',
  'evaluate_predictions',
  'interpret_residual_evidence',
  'derive_hypothesis_state',
  'termination_check',
  'challenge_hypothesis',
  'propose_conclusion',
];

const uuidPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function acceptedV01Scenarios() {
  return acceptedV01ScenarioIds.map((scenarioId) => {
    const scenario = evals.REPLAY_SCENARIOS.find(({ id }) => id === scenarioId);
    assert.ok(scenario, `missing accepted v0.1 scenario: ${scenarioId}`);
    return scenario;
  });
}

function createPlan(experimentId, metadata = benchmarkVersions) {
  const createBenchmarkPlan = requireFunction(
    evals,
    'createBenchmarkPlan',
    '@aic/evals',
  );
  return createBenchmarkPlan({
    experimentId,
    scenarios: acceptedV01Scenarios(),
    runsPerScenario: 3,
    metadata,
  });
}

function failingExampleIds(experiment, metricKey) {
  return experiment.results
    .filter(
      ({ metrics }) =>
        metrics[metricKey].score !== expectedMetricScores[metricKey],
    )
    .map(({ exampleId }) => exampleId);
}

async function compareControlledExperiments({ baseline, mutation, testedHeadSha }) {
  const internalGate = await import(
    '../packages/evals/dist/benchmark-regression-gate.js'
  );
  const compareBenchmarkExperiments = requireFunction(
    internalGate,
    'compareBenchmarkExperiments',
    'the internal benchmark regression gate',
  );
  return compareBenchmarkExperiments({
    testedHeadSha: testedHeadSha ?? currentHeadSha(),
    baseline,
    mutation,
    expectedScores: expectedMetricScores,
    expectedMutationMetric: 'evidence_coverage',
  });
}

async function capturePersistence(metadata) {
  const persistBenchmarkExperiment = requireFunction(
    observability,
    'persistBenchmarkExperiment',
    '@aic/observability',
  );
  const evaluateBenchmarkRecord = requireFunction(
    evals,
    'evaluateBenchmarkRecord',
    '@aic/evals',
  );
  const records = createPlan('baseline-v0.1', metadata);
  const results = records.map((record) =>
    evaluateBenchmarkRecord({
      record,
      outcome: perfectOutcomeFor(record.scenario),
    }),
  );
  const datasetId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  const projectId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
  const events = [];
  const datasets = [];
  const examples = [];
  const projects = [];
  const runs = [];
  const feedback = [];
  const outboundValues = [];
  const client = {
    async createDataset(datasetName, options) {
      events.push('createDataset');
      datasets.push({ datasetName, options });
      outboundValues.push(options);
      return { id: datasetId };
    },
    async createExamples(payloads) {
      events.push('createExamples');
      examples.push(...payloads);
      outboundValues.push(payloads);
      return payloads.map((payload) => ({ ...payload }));
    },
    async createProject(payload) {
      events.push('createProject');
      projects.push(payload);
      outboundValues.push(payload);
      return { id: projectId };
    },
    async createRun(payload) {
      events.push('createRun');
      runs.push(payload);
      outboundValues.push(payload);
    },
    async createFeedback(payload) {
      events.push('createFeedback');
      feedback.push(payload);
      outboundValues.push(payload);
    },
  };

  await persistBenchmarkExperiment({
    client,
    datasetName: 'aic-v0.1-benchmark',
    experiment: { records, results },
  });

  return {
    datasetId,
    projectId,
    records,
    events,
    datasets,
    examples,
    projects,
    runs,
    feedback,
    outboundValues,
  };
}

async function capturePluralPersistence() {
  const persistBenchmarkExperiments = requireFunction(
    observability,
    'persistBenchmarkExperiments',
    '@aic/observability',
  );
  const evaluateBenchmarkRecord = requireFunction(
    evals,
    'evaluateBenchmarkRecord',
    '@aic/evals',
  );
  const buildExperiment = (experimentId) => {
    const records = createPlan(experimentId);
    return {
      records,
      results: records.map((record) =>
        evaluateBenchmarkRecord({
          record,
          outcome: perfectOutcomeFor(record.scenario),
        }),
      ),
    };
  };
  const experiments = [
    buildExperiment('baseline-v0.1'),
    buildExperiment('candidate-v0.1'),
  ];
  const datasetId = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
  const events = [];
  const examples = [];
  const projects = [];
  const runs = [];
  const client = {
    async createDataset() {
      events.push('createDataset');
      return { id: datasetId };
    },
    async createExamples(payloads) {
      events.push('createExamples');
      examples.push(...payloads);
      return payloads.map((payload) => ({ ...payload }));
    },
    async createProject(payload) {
      events.push('createProject');
      projects.push(payload);
      return { id: `project-${payload.projectName}` };
    },
    async createRun(payload) {
      events.push('createRun');
      runs.push(payload);
    },
    async createFeedback() {
      events.push('createFeedback');
    },
  };

  await persistBenchmarkExperiments({
    client,
    datasetName: 'aic-v0.1-benchmark',
    experiments,
  });

  return { datasetId, experiments, events, examples, projects, runs };
}

test('preserves three fresh runs for each of the five accepted v0.1 scenarios', () => {
  const baseline = createPlan('baseline-v0.1');
  const candidate = createPlan('candidate-v0.1');

  assert.equal(baseline.length, 15);
  assert.deepEqual(
    baseline.map(({ exampleId }) => exampleId),
    acceptedV01ExampleIds,
    'the fifteen accepted native LangSmith example identities are immutable',
  );
  const countsByScenario = new Map();
  const runIds = new Set();
  const threadIds = new Set();

  for (const record of baseline) {
    countsByScenario.set(
      record.scenario.id,
      (countsByScenario.get(record.scenario.id) ?? 0) + 1,
    );
    assert.equal(record.experimentId, 'baseline-v0.1');
    assert.match(record.exampleId, uuidPattern);
    assert.equal(record.threadId, record.runId);
    assert.equal(record.metadata.runId, record.runId);
    assert.equal(record.metadata.scenarioId, record.scenario.id);
    assert.equal(record.metadata.humanReview, false);
    assert.match(record.metadata.toolMode, /^(?:live|replay)$/);
    runIds.add(record.runId);
    threadIds.add(record.threadId);
  }

  assert.deepEqual([...countsByScenario.values()], [3, 3, 3, 3, 3]);
  assert.equal(runIds.size, baseline.length);
  assert.equal(threadIds.size, baseline.length);
  assert.deepEqual(
    baseline.map(({ exampleId, scenario }) => ({ exampleId, scenarioId: scenario.id })),
    candidate.map(({ exampleId, scenario }) => ({ exampleId, scenarioId: scenario.id })),
    'the same native examples must remain comparable across experiments',
  );
  assert.equal(
    baseline.some((record, index) => record.runId === candidate[index].runId),
    false,
    'each experiment must receive fresh run and thread identities',
  );
});

test('declares a complete non-overlapping calibration and hold-out policy before tuning', () => {
  const partitions = evals.BENCHMARK_SCENARIO_PARTITIONS;
  assert.ok(
    partitions && typeof partitions === 'object',
    '@aic/evals must export the static BENCHMARK_SCENARIO_PARTITIONS declaration',
  );
  assert.equal(Object.isFrozen(partitions), true);
  assert.equal(Object.isFrozen(partitions.calibration), true);
  assert.equal(Object.isFrozen(partitions.holdout), true);
  assert.deepEqual(Object.keys(partitions).sort(), ['calibration', 'holdout']);
  assert.deepEqual(partitions.calibration, expectedCalibrationScenarioIds);
  assert.deepEqual(partitions.holdout, expectedHoldoutScenarioIds);

  const calibration = new Set(partitions.calibration);
  const holdout = new Set(partitions.holdout);
  const allScenarioIds = evals.REPLAY_SCENARIOS.map(({ id }) => id);
  assert.equal(calibration.size, partitions.calibration.length);
  assert.equal(holdout.size, partitions.holdout.length);
  assert.deepEqual(
    [...calibration].filter((scenarioId) => holdout.has(scenarioId)),
    [],
    'a scenario cannot be both tuning data and hold-out evidence',
  );
  assert.deepEqual(
    [...calibration, ...holdout].sort(),
    [...allScenarioIds].sort(),
    'every scenario must have exactly one declared benchmark role',
  );
  assert.ok(
    holdout.size / allScenarioIds.length >= 0.2,
    'at least twenty percent of the expanded corpus must remain hold-out',
  );
});

test('keeps prompt and model iteration off hold-out cases even when they are passed accidentally', () => {
  const createCalibrationBenchmarkPlan = requireFunction(
    evals,
    'createCalibrationBenchmarkPlan',
    '@aic/evals',
  );
  const attemptedHoldoutInjection = expectedHoldoutScenarioIds.map((scenarioId) =>
    evals.REPLAY_SCENARIOS.find(({ id }) => id === scenarioId),
  );
  const shared = {
    runsPerScenario: 3,
    metadata: benchmarkVersions,
  };
  const calibration = createCalibrationBenchmarkPlan({
    ...shared,
    experimentId: 'prompt-iteration-v0.2',
    scenarios: attemptedHoldoutInjection,
  });

  assert.deepEqual(
    [...new Set(calibration.map(({ scenario }) => scenario.id))],
    expectedCalibrationScenarioIds,
    'the tuning path must select only the static calibration declaration',
  );
  assert.deepEqual(
    calibration.filter(({ scenario }) =>
      expectedHoldoutScenarioIds.includes(scenario.id),
    ),
    [],
    'even an accidental scenarios argument must not inject hold-out data into tuning',
  );
});

test('includes calibration and hold-out cases in the final evaluation plan', () => {
  const createFinalEvaluationBenchmarkPlan = requireFunction(
    evals,
    'createFinalEvaluationBenchmarkPlan',
    '@aic/evals',
  );
  const finalEvaluation = createFinalEvaluationBenchmarkPlan({
    experimentId: 'final-evaluation-v0.2',
    runsPerScenario: 3,
    metadata: benchmarkVersions,
  });

  assert.deepEqual(
    [...new Set(finalEvaluation.map(({ scenario }) => scenario.id))].sort(),
    [...expectedCalibrationScenarioIds, ...expectedHoldoutScenarioIds].sort(),
    'the final evaluation path must execute calibration and hold-out cases',
  );
  assert.equal(finalEvaluation.length, evals.REPLAY_SCENARIOS.length * 3);
});

test('executes every declared scenario through the final-evaluation benchmark path', async () => {
  const runBenchmarkExperiment = requireFunction(
    evals,
    'runBenchmarkExperiment',
    '@aic/evals',
  );
  const investigatedScenarioIds = [];
  const recorded = [];

  const experiment = await runBenchmarkExperiment({
    experimentId: 'final-evaluation-execution-v0.2',
    scenarioSet: 'final-evaluation',
    scenarios: evals.REPLAY_SCENARIOS,
    runsPerScenario: 3,
    metadata: benchmarkVersions,
    async investigate(record) {
      investigatedScenarioIds.push(record.scenario.id);
      return perfectOutcomeFor(record.scenario);
    },
    async recordEvaluation(payload) {
      recorded.push(payload);
    },
  });

  assert.equal(experiment.records.length, 30);
  assert.equal(experiment.results.length, 30);
  assert.equal(recorded.length, 30);
  assert.deepEqual(
    [...new Set(investigatedScenarioIds)].sort(),
    evals.REPLAY_SCENARIOS.map(({ id }) => id).sort(),
    'final evaluation must execute hold-out cases, not merely place them in a plan',
  );
});

for (const [name, scenarioIds] of [
  ['a hold-out-only list', expectedHoldoutScenarioIds],
  [
    'the mixed five-scenario bypass',
    [...acceptedV01ScenarioIds.slice(0, 4), expectedHoldoutScenarioIds[0]],
  ],
]) {
  test(`rejects ${name} before prompt or model iteration executes`, async () => {
    const runBenchmarkExperiment = requireFunction(
      evals,
      'runBenchmarkExperiment',
      '@aic/evals',
    );
    const scenarios = scenarioIds.map((scenarioId) => {
      const scenario = evals.REPLAY_SCENARIOS.find(({ id }) => id === scenarioId);
      assert.ok(scenario, `missing declared scenario: ${scenarioId}`);
      return scenario;
    });
    let investigateCalls = 0;

    await assert.rejects(
      () => runBenchmarkExperiment({
        experimentId: 'prompt-model-iteration-v0.2',
        scenarioSet: 'calibration',
        scenarios,
        runsPerScenario: 3,
        metadata: benchmarkVersions,
        async investigate(record) {
          investigateCalls += 1;
          return perfectOutcomeFor(record.scenario);
        },
        async recordEvaluation() {},
      }),
      /(?:hold.?out.*calibration|calibration.*hold.?out)/i,
    );
    assert.equal(
      investigateCalls,
      0,
      'hold-out validation must happen before the first tuning run',
    );
  });
}

test('adds stable native identities without changing the fifteen accepted v0.1 examples', () => {
  const createFinalEvaluationBenchmarkPlan = requireFunction(
    evals,
    'createFinalEvaluationBenchmarkPlan',
    '@aic/evals',
  );
  const shared = { runsPerScenario: 3, metadata: benchmarkVersions };
  const baseline = createFinalEvaluationBenchmarkPlan({
    ...shared,
    experimentId: 'expanded-baseline-v0.2',
  });
  const candidate = createFinalEvaluationBenchmarkPlan({
    ...shared,
    experimentId: 'expanded-candidate-v0.2',
  });
  const acceptedRecords = baseline.filter(({ scenario }) =>
    acceptedV01ScenarioIds.includes(scenario.id),
  );
  const newRecords = baseline.filter(
    ({ scenario }) => !acceptedV01ScenarioIds.includes(scenario.id),
  );

  assert.deepEqual(
    acceptedRecords.map(({ exampleId }) => exampleId),
    acceptedV01ExampleIds,
  );
  assert.equal(newRecords.length >= 15, true);
  assert.equal(
    newRecords.every(({ exampleId }) =>
      uuidPattern.test(exampleId) && !acceptedV01ExampleIds.includes(exampleId),
    ),
    true,
  );
  assert.deepEqual(
    baseline.map(({ exampleId, scenario }) => ({ exampleId, scenarioId: scenario.id })),
    candidate.map(({ exampleId, scenario }) => ({ exampleId, scenarioId: scenario.id })),
    'all expanded native example identities must be stable across experiments',
  );
});

test('publishes three independent metrics and rejects accidental other-stop success', () => {
  const evaluateUnsupportedClaimRate = requireFunction(
    evals,
    'evaluateUnsupportedClaimRate',
    '@aic/evals',
  );
  const evaluateEvidenceCoverage = requireFunction(
    evals,
    'evaluateEvidenceCoverage',
    '@aic/evals',
  );
  const evaluateTerminationCorrectness = requireFunction(
    evals,
    'evaluateTerminationCorrectness',
    '@aic/evals',
  );

  const unsupportedClaims = evaluateUnsupportedClaimRate({
    claims: [
      { evidenceIds: ['evidence-1'] },
      { evidenceIds: ['missing-evidence'] },
    ],
    supportingEvidenceIds: ['evidence-1'],
  });
  assert.deepEqual(unsupportedClaims, {
    key: 'unsupported_claim_rate',
    score: 0.5,
  });

  const expectedFingerprints = [
    { kind: 'deploy', source: 'deployments/checkout', predicate: 'version=v42' },
    { kind: 'log', source: 'logs/checkout', predicate: 'contains endpoint error' },
  ];
  const evidenceCoverage = evaluateEvidenceCoverage({
    expectedFingerprints,
    evidenceFingerprints: [
      expectedFingerprints[0],
      { ...expectedFingerprints[1], predicate: 'contains another error' },
    ],
  });
  assert.deepEqual(evidenceCoverage, { key: 'evidence_coverage', score: 0.5 });

  const correctTermination = evaluateTerminationCorrectness({
    expectedStopKind: 'sufficient',
    expectedConclusionKind: 'root-cause',
    stopKind: 'sufficient',
    conclusionKind: 'root-cause',
  });
  const accidentalConclusion = evaluateTerminationCorrectness({
    expectedStopKind: 'sufficient',
    expectedConclusionKind: 'root-cause',
    stopKind: 'stalled',
    conclusionKind: 'root-cause',
  });
  assert.deepEqual(correctTermination, {
    key: 'termination_correctness',
    score: 1,
  });
  assert.deepEqual(accidentalConclusion, {
    key: 'termination_correctness',
    score: 0,
  });

  const metrics = {
    [unsupportedClaims.key]: unsupportedClaims,
    [evidenceCoverage.key]: evidenceCoverage,
    [correctTermination.key]: correctTermination,
  };
  assert.deepEqual(Object.keys(metrics).sort(), expectedMetricKeys);
  assert.equal('compositeScore' in metrics, false);
  assert.equal('gate' in metrics, false);
});

test('compares experiments by stable example identity and stop distribution', () => {
  const evaluateBenchmarkRecord = requireFunction(
    evals,
    'evaluateBenchmarkRecord',
    '@aic/evals',
  );
  const summarizeStopKindDistribution = requireFunction(
    evals,
    'summarizeStopKindDistribution',
    '@aic/evals',
  );
  const baselineRecord = createPlan('baseline-v0.1')[0];
  const candidateRecord = createPlan('candidate-v0.1')[0];
  const baselineResult = evaluateBenchmarkRecord({
    record: baselineRecord,
    outcome: perfectOutcomeFor(baselineRecord.scenario),
  });
  const candidateResult = evaluateBenchmarkRecord({
    record: candidateRecord,
    outcome: {
      ...perfectOutcomeFor(candidateRecord.scenario),
      stopKind: 'stalled',
    },
  });

  assert.equal(baselineResult.exampleId, candidateResult.exampleId);
  assert.equal(baselineResult.experimentId, 'baseline-v0.1');
  assert.equal(candidateResult.experimentId, 'candidate-v0.1');
  assert.notEqual(baselineResult.runId, candidateResult.runId);
  assert.deepEqual(Object.keys(baselineResult.metrics).sort(), expectedMetricKeys);
  assert.deepEqual(summarizeStopKindDistribution([baselineResult]), {
    sufficient: 1,
  });
  assert.deepEqual(summarizeStopKindDistribution([candidateResult]), {
    stalled: 1,
  });
});

test('keeps the benchmark regression gate off the public eval package surface', () => {
  assert.equal(evals.compareBenchmarkExperiments, undefined);
});

test('gates a controlled benchmark mutation independently for each metric', async () => {
  const { baseline, mutation, removedRequiredFingerprint } =
    await getControlledMutationCycle();
  const testedHeadSha = currentHeadSha();

  assert.equal(removedRequiredFingerprint, true);
  assert.equal(baseline.records.length, 15);
  assert.equal(mutation.records.length, 15);
  assert.deepEqual(
    baseline.records.map(({ exampleId }) => exampleId),
    mutation.records.map(({ exampleId }) => exampleId),
    'the mutation must run against the same fifteen native examples',
  );
  assert.equal(
    new Set([
      ...baseline.records.map(({ runId }) => runId),
      ...mutation.records.map(({ runId }) => runId),
    ]).size,
    30,
    'baseline and mutation experiments must use distinct fresh runs',
  );

  assert.deepEqual(
    Object.fromEntries(
      expectedMetricKeys.map((metricKey) => [
        metricKey,
        {
          baseline: failingExampleIds(baseline, metricKey),
          mutation: failingExampleIds(mutation, metricKey),
        },
      ]),
    ),
    {
      evidence_coverage: {
        baseline: [],
        mutation: [mutation.records[0].exampleId],
      },
      termination_correctness: { baseline: [], mutation: [] },
      unsupported_claim_rate: { baseline: [], mutation: [] },
    },
    'removing one required fingerprint must turn only evidence coverage red',
  );

  const proof = await compareControlledExperiments({
    testedHeadSha,
    baseline,
    mutation,
  });

  assert.equal(proof.testedHeadSha, testedHeadSha);
  assert.deepEqual(proof.experiments, {
    baseline: 'aic-11-baseline-v0.1',
    mutation: 'aic-11-missing-evidence-mutation-v0.1',
  });
  assert.deepEqual(
    proof.exampleIds,
    baseline.records.map(({ exampleId }) => exampleId),
  );
  assert.deepEqual(proof.metrics, {
    evidence_coverage: {
      requiredScore: 1,
      baseline: { passed: true, failingExampleIds: [] },
      mutation: {
        passed: false,
        failingExampleIds: [mutation.records[0].exampleId],
      },
    },
    termination_correctness: {
      requiredScore: 1,
      baseline: { passed: true, failingExampleIds: [] },
      mutation: { passed: true, failingExampleIds: [] },
    },
    unsupported_claim_rate: {
      requiredScore: 0,
      baseline: { passed: true, failingExampleIds: [] },
      mutation: { passed: true, failingExampleIds: [] },
    },
  });
  assert.equal(
    Object.hasOwn(proof, 'compositeScore'),
    false,
    'the gate must not collapse independent metrics into a composite score',
  );
});

test('keeps the evidence mutation scoped and leaves a later baseline green', async () => {
  const {
    baseline,
    baselineAfterMutation,
    replayScenariosBefore,
  } = await getControlledMutationCycle();

  assert.equal(JSON.stringify(evals.REPLAY_SCENARIOS), replayScenariosBefore);
  assert.deepEqual(
    baselineAfterMutation.records.map(({ exampleId }) => exampleId),
    baseline.records.map(({ exampleId }) => exampleId),
  );
  assert.equal(
    new Set([
      ...baseline.records.map(({ runId }) => runId),
      ...baselineAfterMutation.records.map(({ runId }) => runId),
    ]).size,
    30,
    'the post-mutation baseline must receive fresh runs',
  );
  for (const metricKey of expectedMetricKeys) {
    assert.deepEqual(failingExampleIds(baselineAfterMutation, metricKey), []);
  }
});

test('rejects changed ground truth hidden behind a stable example identity', async () => {
  const { baseline, mutation } = await getControlledMutationCycle();
  const changedGroundTruth = {
    ...mutation,
    records: mutation.records.map((record, index) =>
      index === 0
        ? {
            ...record,
            scenario: {
              ...record.scenario,
              groundTruth: {
                ...record.scenario.groundTruth,
                expectedEvidence: record.scenario.groundTruth.expectedEvidence.map(
                  (fingerprint, evidenceIndex) =>
                    evidenceIndex === 0
                      ? {
                          ...fingerprint,
                          predicate: `${fingerprint.predicate} changed`,
                        }
                      : fingerprint,
                ),
              },
            },
          }
        : record),
  };

  assert.deepEqual(
    changedGroundTruth.records.map(({ exampleId }) => exampleId),
    baseline.records.map(({ exampleId }) => exampleId),
  );
  await assert.rejects(
    () => compareControlledExperiments({ baseline, mutation: changedGroundTruth }),
    /ground truth.*match/i,
  );
});

test('rejects swapped scenario objects hidden behind stable example identities', async () => {
  const { baseline, mutation } = await getControlledMutationCycle();
  const firstScenario = mutation.records[0].scenario;
  const secondScenario = mutation.records[3].scenario;
  const swappedScenarios = {
    ...mutation,
    records: mutation.records.map((record, index) => {
      const scenario = index === 0
        ? secondScenario
        : index === 3
          ? firstScenario
          : record.scenario;
      return {
        ...record,
        scenario,
        metadata: { ...record.metadata, scenarioId: scenario.id },
      };
    }),
  };

  assert.deepEqual(
    swappedScenarios.records.map(({ exampleId }) => exampleId),
    baseline.records.map(({ exampleId }) => exampleId),
  );
  await assert.rejects(
    () => compareControlledExperiments({ baseline, mutation: swappedScenarios }),
    /scenario.*match.*example/i,
  );
});

test('rejects a record whose scenario disagrees with its metadata', async () => {
  const { baseline, mutation } = await getControlledMutationCycle();
  const inconsistentMutation = {
    ...mutation,
    records: mutation.records.map((record, index) =>
      index === 0
        ? {
            ...record,
            metadata: { ...record.metadata, scenarioId: 'different-scenario' },
          }
        : record),
  };

  await assert.rejects(
    () => compareControlledExperiments({ baseline, mutation: inconsistentMutation }),
    /scenario\.id.*metadata\.scenarioId/i,
  );
});

test('rejects a record whose run identity disagrees with its metadata', async () => {
  const { baseline, mutation } = await getControlledMutationCycle();
  const inconsistentMutation = {
    ...mutation,
    records: mutation.records.map((record, index) =>
      index === 0
        ? {
            ...record,
            metadata: {
              ...record.metadata,
              runId: '00000000-0000-4000-8000-000000000001',
            },
          }
        : record),
  };

  await assert.rejects(
    () => compareControlledExperiments({ baseline, mutation: inconsistentMutation }),
    /record\.runId.*metadata\.runId/i,
  );
});

test('rejects a record whose thread identity differs from its run identity', async () => {
  const { baseline, mutation } = await getControlledMutationCycle();
  const inconsistentMutation = {
    ...mutation,
    records: mutation.records.map((record, index) =>
      index === 0
        ? {
            ...record,
            threadId: '00000000-0000-4000-8000-000000000002',
          }
        : record),
  };

  await assert.rejects(
    () => compareControlledExperiments({ baseline, mutation: inconsistentMutation }),
    /threadId.*runId/i,
  );
});

test('rejects a result whose run identity does not match its benchmark record', async () => {
  const { baseline, mutation } = await getControlledMutationCycle();
  const mismatchedBaseline = {
    ...baseline,
    results: baseline.results.map((result, index) =>
      index === 0
        ? { ...result, runId: '00000000-0000-4000-8000-000000000000' }
        : result),
  };

  await assert.rejects(
    () => compareControlledExperiments({ baseline: mismatchedBaseline, mutation }),
    /result runId.*record/i,
  );
});

test('rejects baseline and mutation experiments that reuse a run identity', async () => {
  const { baseline, mutation } = await getControlledMutationCycle();
  const sharedRunId = baseline.records[0].runId;
  const overlappingMutation = {
    ...mutation,
    records: mutation.records.map((record, index) =>
      index === 0
        ? {
            ...record,
            runId: sharedRunId,
            threadId: sharedRunId,
            metadata: { ...record.metadata, runId: sharedRunId },
          }
        : record),
    results: mutation.results.map((result, index) =>
      index === 0 ? { ...result, runId: sharedRunId } : result),
  };

  await assert.rejects(
    () => compareControlledExperiments({ baseline, mutation: overlappingMutation }),
    /run IDs.*overlap/i,
  );
});

test('rejects a red baseline before accepting mutation evidence', async () => {
  const { baseline, mutation } = await getControlledMutationCycle();
  const redBaseline = {
    ...baseline,
    results: baseline.results.map((result, index) =>
      index === 0
        ? {
            ...result,
            metrics: {
              ...result.metrics,
              evidence_coverage: {
                key: 'evidence_coverage',
                score: 0.5,
              },
            },
          }
        : result),
  };

  await assert.rejects(
    () => compareControlledExperiments({ baseline: redBaseline, mutation }),
    /baseline.*pass.*metric/i,
  );
});

test('rejects an all-green mutation for the declared evidence coverage regression', async () => {
  const { baseline, baselineAfterMutation } = await getControlledMutationCycle();

  await assert.rejects(
    () => compareControlledExperiments({
      baseline,
      mutation: baselineAfterMutation,
    }),
    /mutation.*evidence_coverage/i,
  );
});

test('rejects a mutation that turns an undeclared metric red', async () => {
  const { baseline, mutation } = await getControlledMutationCycle();
  const multiMetricMutation = {
    ...mutation,
    results: mutation.results.map((result, index) =>
      index === 1
        ? {
            ...result,
            metrics: {
              ...result.metrics,
              termination_correctness: {
                key: 'termination_correctness',
                score: 0,
              },
            },
          }
        : result),
  };

  await assert.rejects(
    () => compareControlledExperiments({
      baseline,
      mutation: multiMetricMutation,
    }),
    /mutation.*termination_correctness/i,
  );
});

const invalidMetricScores = [
  ['rejects a NaN actual metric score', Number.NaN],
  ['rejects an infinite actual metric score', Number.POSITIVE_INFINITY],
  ['rejects a negative actual metric score', -0.1],
  ['rejects an actual metric score above one', 1.1],
  ['rejects a non-number actual metric score', '0.5'],
];

for (const [name, invalidScore] of invalidMetricScores) {
  test(name, async () => {
    const { baseline, mutation } = await getControlledMutationCycle();
    const invalidMutation = {
      ...mutation,
      results: mutation.results.map((result, index) =>
        index === 0
          ? {
              ...result,
              metrics: {
                ...result.metrics,
                evidence_coverage: {
                  key: 'evidence_coverage',
                  score: invalidScore,
                },
              },
            }
          : result),
    };

    await assert.rejects(
      () => compareControlledExperiments({ baseline, mutation: invalidMutation }),
      /metric score.*finite number.*between 0 and 1/i,
    );
  });
}

test('rejects a benchmark below five scenarios with three runs each', async () => {
  const { baseline, mutation } = await getControlledMutationCycle();
  const truncate = (experiment) => ({
    ...experiment,
    records: experiment.records.slice(0, -1),
    results: experiment.results.slice(0, -1),
    stopKindDistribution: { sufficient: 14 },
  });

  await assert.rejects(
    () => compareControlledExperiments({
      baseline: truncate(baseline),
      mutation: truncate(mutation),
    }),
    /five scenarios.*three runs/i,
  );
});

test('runs all fifteen fresh records through createInvestigationGraph and replay', async () => {
  const runGraphBenchmarkExperiment = requireFunction(
    evals,
    'runGraphBenchmarkExperiment',
    '@aic/evals',
  );
  const traces = new Map();
  const replayCounts = new Map();
  const recorded = [];

  const experiment = await runGraphBenchmarkExperiment({
    experimentId: 'baseline-v0.1',
    scenarios: acceptedV01Scenarios(),
    runsPerScenario: 3,
    metadata: benchmarkVersions,
    createNodes(record) {
      assert.equal(record.metadata.humanReview, false);
      assert.equal(record.threadId, record.runId);
      traces.set(record.runId, []);
      replayCounts.set(record.runId, 0);
      return replayBackedNodes(record, traces, replayCounts);
    },
    async recordEvaluation(payload) {
      recorded.push(payload);
    },
  });

  assert.equal(recorded.length, 15);
  assert.equal(experiment.records.length, 15);
  assert.equal(experiment.results.length, 15);
  assert.equal(new Set(experiment.records.map(({ runId }) => runId)).size, 15);
  assert.equal(new Set(experiment.records.map(({ threadId }) => threadId)).size, 15);
  assert.equal(new Set(experiment.records.map(({ scenario }) => scenario.id)).size, 5);
  assert.deepEqual(experiment.stopKindDistribution, { sufficient: 15 });

  const expectedGraphTrace = [
    ...expectedLifecycleNodes.slice(0, 10),
    'challenge_hypothesis',
    ...expectedLifecycleNodes.slice(5, 10),
    'propose_conclusion',
  ];
  for (const record of experiment.records) {
    assert.deepEqual(traces.get(record.runId), expectedGraphTrace);
    assert.equal(
      replayCounts.get(record.runId),
      record.scenario.fixture.entries.length,
      `${record.exampleId} must execute all recorded calls via ReplayToolAdapter`,
    );
  }
});

test('runs the complete expanded corpus through createInvestigationGraph and replay', async () => {
  const runGraphBenchmarkExperiment = requireFunction(
    evals,
    'runGraphBenchmarkExperiment',
    '@aic/evals',
  );
  const traces = new Map();
  const replayCounts = new Map();
  const recorded = [];

  const experiment = await runGraphBenchmarkExperiment({
    experimentId: 'final-graph-evaluation-v0.2',
    scenarioSet: 'final-evaluation',
    scenarios: evals.REPLAY_SCENARIOS,
    runsPerScenario: 3,
    metadata: benchmarkVersions,
    createNodes(record) {
      assert.equal(record.metadata.humanReview, false);
      assert.equal(record.threadId, record.runId);
      traces.set(record.runId, []);
      replayCounts.set(record.runId, 0);
      return replayBackedNodes(record, traces, replayCounts);
    },
    async recordEvaluation(payload) {
      recorded.push(payload);
    },
  });

  assert.equal(recorded.length, 30);
  assert.equal(experiment.records.length, 30);
  assert.equal(experiment.results.length, 30);
  assert.deepEqual(
    [...new Set(experiment.records.map(({ scenario }) => scenario.id))].sort(),
    evals.REPLAY_SCENARIOS.map(({ id }) => id).sort(),
  );
  for (const record of experiment.records) {
    assert.equal(
      replayCounts.get(record.runId),
      record.scenario.fixture.entries.length,
      `${record.exampleId} must execute every recorded call through ReplayToolAdapter`,
    );
    assert.equal(traces.get(record.runId).includes('execute_investigation'), true);
  }
});

test('persists baseline and candidate against one shared native dataset', async () => {
  const captured = await capturePluralPersistence();

  assert.equal(
    captured.events.filter((event) => event === 'createDataset').length,
    1,
  );
  assert.equal(
    captured.events.filter((event) => event === 'createExamples').length,
    1,
  );
  assert.equal(captured.examples.length, 15);
  assert.equal(captured.projects.length, 2);
  assert.deepEqual(
    captured.projects.map(({ projectName }) => projectName),
    ['baseline-v0.1', 'candidate-v0.1'],
  );
  assert.equal(
    captured.projects.every(
      ({ referenceDatasetId }) => referenceDatasetId === captured.datasetId,
    ),
    true,
  );
  assert.equal(captured.runs.length, 30);

  const nativeExampleIds = captured.examples.map(({ id }) => id).sort();
  const baselineExampleIds = captured.runs
    .filter(({ project_name }) => project_name === 'baseline-v0.1')
    .map(({ reference_example_id }) => reference_example_id)
    .sort();
  const candidateExampleIds = captured.runs
    .filter(({ project_name }) => project_name === 'candidate-v0.1')
    .map(({ reference_example_id }) => reference_example_id)
    .sort();

  assert.deepEqual(baselineExampleIds, nativeExampleIds);
  assert.deepEqual(candidateExampleIds, nativeExampleIds);
  assert.deepEqual(
    captured.experiments[0].records.map(({ exampleId }) => exampleId),
    captured.experiments[1].records.map(({ exampleId }) => exampleId),
    'baseline and candidate must reuse the same stable example identities',
  );
});

test('creates native examples before a dataset-backed experiment and links every run', async () => {
  const captured = await capturePersistence(benchmarkVersions);

  assert.deepEqual(captured.events.slice(0, 3), [
    'createDataset',
    'createExamples',
    'createProject',
  ]);
  assert.deepEqual(captured.datasets, [{
    datasetName: 'aic-v0.1-benchmark',
    options: undefined,
  }]);
  assert.deepEqual(captured.projects, [{
    projectName: 'baseline-v0.1',
    referenceDatasetId: captured.datasetId,
  }]);
  assert.equal(captured.examples.length, 15);
  assert.deepEqual(
    captured.examples.map(({ id }) => id),
    captured.records.map(({ exampleId }) => exampleId),
  );
  captured.examples.forEach((example, index) => {
    const record = captured.records[index];
    assert.equal(example.dataset_id, captured.datasetId);
    assert.deepEqual(example.inputs, {
      scenarioId: record.scenario.id,
      runNumber: (index % 3) + 1,
    });
    assert.deepEqual(example.outputs, {
      groundTruth: record.scenario.groundTruth,
    });
  });

  assert.equal(captured.runs.length, 15);
  const nativeExampleIds = new Set(captured.examples.map(({ id }) => id));
  captured.runs.forEach((run, index) => {
    assert.equal(run.id, captured.records[index].runId);
    assert.equal(run.project_name, 'baseline-v0.1');
    assert.equal(
      Object.hasOwn(run, 'session_name'),
      false,
      'LangSmith 0.9.0 CreateRunParams declares project_name, not session_name',
    );
    assert.equal(run.reference_example_id, captured.records[index].exampleId);
    assert.equal(nativeExampleIds.has(run.reference_example_id), true);
  });
  assert.equal(captured.feedback.length, 45);
  assert.equal(
    captured.feedback.every(({ sessionId }) => sessionId === captured.projectId),
    true,
  );
  assert.deepEqual(
    [...new Set(captured.feedback.map(({ key }) => key))].sort(),
    expectedMetricKeys,
  );
});

test('allowlists outbound run metadata and omits undefined optional fields', async () => {
  const canaryKey = 'arbitraryAgentMetadata';
  const captured = await capturePersistence({
    ...benchmarkVersions,
    seed: undefined,
    docsAvailable: undefined,
    [canaryKey]: 'must-not-cross-the-sdk-boundary',
  });
  const expectedMetadataKeys = [
    'graphVersion',
    'humanReview',
    'knowledgeSetVersion',
    'memoryEnabled',
    'promptVersion',
    'runId',
    'scenarioId',
    'statusRulesVersion',
    'temperature',
    'toolMode',
    'toolsetVersion',
  ];

  assert.equal(captured.runs.length, 15);
  captured.runs.forEach((run, index) => {
    const record = captured.records[index];
    assert.deepEqual(Object.keys(run.extra.metadata).sort(), expectedMetadataKeys);
    assert.deepEqual(run.extra.metadata, {
      graphVersion: benchmarkVersions.graphVersion,
      humanReview: false,
      knowledgeSetVersion: benchmarkVersions.knowledgeSetVersion,
      memoryEnabled: false,
      promptVersion: benchmarkVersions.promptVersion,
      runId: record.runId,
      scenarioId: record.scenario.id,
      statusRulesVersion: benchmarkVersions.statusRulesVersion,
      temperature: 0,
      toolMode: 'replay',
      toolsetVersion: benchmarkVersions.toolsetVersion,
    });
  });
  assert.equal(
    JSON.stringify(captured.outboundValues).includes(canaryKey),
    false,
    'unknown metadata keys must never cross any LangSmith SDK call',
  );
});

test('pins direct LangSmith 0.9.0 ownership in observability without changing eval topology', () => {
  const observabilityManifest = JSON.parse(
    readFileSync(resolve(projectRoot, 'packages/observability/package.json'), 'utf8'),
  );
  const evalsManifest = JSON.parse(
    readFileSync(resolve(projectRoot, 'packages/evals/package.json'), 'utf8'),
  );

  assert.equal(observabilityManifest.dependencies?.langsmith, '0.9.0');
  assert.deepEqual(
    Object.keys(evalsManifest.dependencies ?? {})
      .filter((dependency) => dependency.startsWith('@aic/'))
      .sort(),
    ['@aic/domain', '@aic/graph'],
  );
  assert.equal(evalsManifest.dependencies?.langsmith, undefined);
  assert.deepEqual(graph.INVESTIGATION_NODE_NAMES, expectedLifecycleNodes);
});

test('disables LangSmith runtime metadata injection in the default client', () => {
  const createLangSmithClient = requireFunction(
    observability,
    'createLangSmithClient',
    '@aic/observability',
  );
  const client = createLangSmithClient();

  assert.equal(
    client.omitTracedRuntimeInfo,
    true,
    'Client.createRun must not append runtime or environment keys after the AIC-10 allowlist boundary',
  );
});
