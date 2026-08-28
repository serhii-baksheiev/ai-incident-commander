import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { STATUS_RULES_VERSION } from '@aic/domain';
import * as evals from '@aic/evals';
import * as graph from '@aic/graph';
import * as observability from '@aic/observability';

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const expectedMetricKeys = [
  'evidence_coverage',
  'termination_correctness',
  'unsupported_claim_rate',
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

const benchmarkVersions = {
  graphVersion: 'graph-v0.1',
  promptVersion: 'prompt-v0.1',
  toolsetVersion: 'toolset-v0.1',
  statusRulesVersion: STATUS_RULES_VERSION,
  toolMode: 'replay',
  knowledgeSetVersion: 'knowledge-none-v0.1',
  memoryEnabled: false,
  temperature: 0,
  seed: 17,
  docsAvailable: false,
};

function requireFunction(packageNamespace, name, packageName) {
  assert.equal(
    typeof packageNamespace[name],
    'function',
    `${packageName} must export ${name}`,
  );
  return packageNamespace[name];
}

function createPlan(experimentId) {
  const createBenchmarkPlan = requireFunction(
    evals,
    'createBenchmarkPlan',
    '@aic/evals',
  );
  return createBenchmarkPlan({
    experimentId,
    scenarios: evals.REPLAY_SCENARIOS,
    runsPerScenario: 3,
    metadata: benchmarkVersions,
  });
}

function perfectOutcomeFor(scenario) {
  return {
    claims: [{ evidenceIds: ['supporting-evidence'] }],
    supportingEvidenceIds: ['supporting-evidence'],
    evidenceFingerprints: scenario.groundTruth.expectedEvidence.map(
      (fingerprint) => ({ ...fingerprint }),
    ),
    stopKind: scenario.groundTruth.expectedStopKind,
    conclusionKind: scenario.groundTruth.expectedConclusionKind,
  };
}

test('plans at least three fresh benchmark runs for each of exactly five scenarios', () => {
  assert.equal(evals.REPLAY_SCENARIOS.length, 5);
  const records = createPlan('baseline-v0.1');

  assert.equal(records.length, 15);
  const countsByScenario = new Map();
  const runIds = new Set();
  const threadIds = new Set();
  const expectedMetadataKeys = [
    'docsAvailable',
    'graphVersion',
    'humanReview',
    'knowledgeSetVersion',
    'memoryEnabled',
    'promptVersion',
    'runId',
    'scenarioId',
    'seed',
    'statusRulesVersion',
    'temperature',
    'toolMode',
    'toolsetVersion',
  ];

  for (const record of records) {
    countsByScenario.set(
      record.scenario.id,
      (countsByScenario.get(record.scenario.id) ?? 0) + 1,
    );
    assert.equal(record.experimentId, 'baseline-v0.1');
    assert.equal(typeof record.exampleId, 'string');
    assert.notEqual(record.exampleId.length, 0);
    assert.equal(record.threadId, record.runId);
    assert.equal(record.metadata.runId, record.runId);
    assert.equal(record.metadata.scenarioId, record.scenario.id);
    assert.equal(record.metadata.humanReview, false);
    assert.match(record.metadata.toolMode, /^(?:live|replay)$/);
    assert.deepEqual(Object.keys(record.metadata).sort(), expectedMetadataKeys);
    assert.deepEqual(record.metadata, {
      ...benchmarkVersions,
      runId: record.runId,
      scenarioId: record.scenario.id,
      humanReview: false,
    });
    runIds.add(record.runId);
    threadIds.add(record.threadId);
  }

  assert.equal(countsByScenario.size, 5);
  for (const count of countsByScenario.values()) assert.ok(count >= 3);
  assert.equal(runIds.size, records.length);
  assert.equal(threadIds.size, records.length);
});

test('publishes three independent deterministic metrics without a composite gate', () => {
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
  assert.equal(unsupportedClaims.key, 'unsupported_claim_rate');
  assert.equal(unsupportedClaims.score, 0.5);

  const expectedFingerprints = [
    { kind: 'deploy', source: 'deployments/checkout', predicate: 'version=v42' },
    { kind: 'log', source: 'logs/checkout', predicate: 'contains endpoint error' },
  ];
  const evidenceCoverage = evaluateEvidenceCoverage({
    expectedFingerprints,
    evidenceFingerprints: [
      expectedFingerprints[0],
      {
        ...expectedFingerprints[1],
        predicate: 'contains a different error',
      },
    ],
  });
  assert.equal(evidenceCoverage.key, 'evidence_coverage');
  assert.equal(
    evidenceCoverage.score,
    0.5,
    'coverage requires an exact kind/source/predicate triple',
  );

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
  assert.equal(correctTermination.key, 'termination_correctness');
  assert.equal(correctTermination.score, 1);
  assert.equal(accidentalConclusion.key, 'termination_correctness');
  assert.equal(
    accidentalConclusion.score,
    0,
    'a correct conclusion with the wrong stop kind is not termination-correct',
  );

  const metrics = {
    [unsupportedClaims.key]: unsupportedClaims,
    [evidenceCoverage.key]: evidenceCoverage,
    [correctTermination.key]: correctTermination,
  };
  assert.deepEqual(Object.keys(metrics).sort(), expectedMetricKeys);
  assert.equal('compositeScore' in metrics, false);
  assert.equal('gate' in metrics, false);
});

test('keeps results comparable by stable example and distinct experiment identities', () => {
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
  const baseline = createPlan('baseline-v0.1');
  const candidate = createPlan('candidate-v0.1');

  assert.deepEqual(
    baseline.map(({ exampleId, scenario }) => ({ exampleId, scenarioId: scenario.id })),
    candidate.map(({ exampleId, scenario }) => ({ exampleId, scenarioId: scenario.id })),
    'the same examples must be addressable across experiments',
  );
  assert.equal(
    baseline.some((record, index) => record.runId === candidate[index].runId),
    false,
    'each experiment invocation still receives a fresh runId',
  );

  const baselineRecord = baseline[0];
  const candidateRecord = candidate[0];
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
  assert.equal('compositeScore' in baselineResult, false);
  assert.equal('gate' in baselineResult, false);
  assert.deepEqual(summarizeStopKindDistribution([baselineResult]), {
    sufficient: 1,
  });
  assert.deepEqual(summarizeStopKindDistribution([candidateResult]), {
    stalled: 1,
  });
});

test('runs and records the baseline experiment across every planned example', async () => {
  const runBenchmarkExperiment = requireFunction(
    evals,
    'runBenchmarkExperiment',
    '@aic/evals',
  );
  const investigated = [];
  const recorded = [];

  const experiment = await runBenchmarkExperiment({
    experimentId: 'baseline-v0.1',
    scenarios: evals.REPLAY_SCENARIOS,
    runsPerScenario: 3,
    metadata: benchmarkVersions,
    async investigate(record) {
      investigated.push({
        exampleId: record.exampleId,
        runId: record.runId,
        scenarioId: record.scenario.id,
      });
      return perfectOutcomeFor(record.scenario);
    },
    async recordEvaluation(payload) {
      recorded.push(payload);
    },
  });

  assert.equal(investigated.length, 15);
  assert.equal(recorded.length, 15);
  assert.equal(experiment.records.length, 15);
  assert.equal(experiment.results.length, 15);
  assert.equal(new Set(investigated.map(({ scenarioId }) => scenarioId)).size, 5);
  assert.equal(new Set(investigated.map(({ runId }) => runId)).size, 15);
  assert.deepEqual(experiment.stopKindDistribution, { sufficient: 15 });
  assert.deepEqual(
    recorded.map(({ record, result }) => ({
      exampleId: result.exampleId,
      experimentId: result.experimentId,
      runId: result.runId,
      recordRunId: record.runId,
    })),
    experiment.results.map((result) => ({
      exampleId: result.exampleId,
      experimentId: result.experimentId,
      runId: result.runId,
      recordRunId: result.runId,
    })),
  );
});

test('persists complete metadata and three metric feedback keys through an injected client', async () => {
  const persistBenchmarkEvaluation = requireFunction(
    observability,
    'persistBenchmarkEvaluation',
    '@aic/observability',
  );
  const metadata = {
    ...benchmarkVersions,
    runId: 'run-observability-1',
    scenarioId: 'bad-deployment',
    humanReview: false,
  };
  const record = {
    experimentId: 'baseline-v0.1',
    exampleId: 'bad-deployment:1',
    runId: metadata.runId,
    threadId: metadata.runId,
    metadata,
  };
  const result = {
    experimentId: record.experimentId,
    exampleId: record.exampleId,
    runId: record.runId,
    actualStopKind: 'sufficient',
    metrics: {
      unsupported_claim_rate: {
        key: 'unsupported_claim_rate',
        score: 0,
      },
      evidence_coverage: { key: 'evidence_coverage', score: 1 },
      termination_correctness: {
        key: 'termination_correctness',
        score: 1,
      },
      composite_score: {
        key: 'composite_score',
        score: 1,
      },
    },
  };
  const capturedRuns = [];
  const capturedFeedback = [];
  const fakeClient = {
    async createRun(payload) {
      capturedRuns.push(payload);
    },
    async createFeedback(runId, key, feedback) {
      capturedFeedback.push({ runId, key, feedback });
    },
  };
  let networkCalls = 0;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => {
    networkCalls += 1;
    throw new Error('network is forbidden in benchmark acceptance tests');
  };

  try {
    await persistBenchmarkEvaluation({ client: fakeClient, record, result });
  } finally {
    globalThis.fetch = originalFetch;
  }

  assert.equal(networkCalls, 0);
  assert.equal(capturedRuns.length, 1);
  assert.deepEqual(capturedRuns[0].extra.metadata, metadata);
  assert.deepEqual(
    Object.keys(capturedRuns[0].outputs.metrics).sort(),
    expectedMetricKeys,
  );
  assert.deepEqual(
    capturedFeedback.map(({ key }) => key).sort(),
    expectedMetricKeys,
  );
  assert.equal(new Set(capturedFeedback.map(({ key }) => key)).size, 3);
  assert.equal(
    capturedFeedback.every(({ runId }) => runId === record.runId),
    true,
  );
});

test('pins LangSmith in observability without changing eval dependencies or graph topology', () => {
  const observabilityManifest = JSON.parse(
    readFileSync(
      resolve(projectRoot, 'packages/observability/package.json'),
      'utf8',
    ),
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
