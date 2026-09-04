import assert from 'node:assert/strict';
import test from 'node:test';

import { STATUS_RULES_VERSION } from '@aic/domain';
import * as evals from '@aic/evals';
import * as observability from '@aic/observability';

const expectedEvidence = Object.freeze({
  kind: 'dependency',
  source: 'dependencies/payments',
  predicate: 'inventory-api reports connection pool saturation',
});

const misleadingEvidence = Object.freeze({
  kind: 'deploy',
  source: 'deployments/payments',
  predicate: 'payments deployment overlaps the incident window',
});

const expectedRootCause = Object.freeze({
  component: 'inventory-api',
  mechanism: 'connection pool saturation delayed payment authorization',
  trigger: 'inventory traffic spike',
});

const misleadingRootCause = Object.freeze({
  component: 'payments',
  mechanism: 'a deployment introduced an authorization timeout regression',
  trigger: 'payments-v19',
});

const misleadingGroundTruth = Object.freeze({
  rootCause: expectedRootCause,
  expectedEvidence: Object.freeze([expectedEvidence]),
  misleadingEvidence: Object.freeze([misleadingEvidence]),
});

const misleadingPositiveOutcome = Object.freeze({
  rootCause: expectedRootCause,
  rootCauseHypothesisId: 'dependency-hypothesis',
  evidenceFingerprints: Object.freeze([misleadingEvidence, expectedEvidence]),
  evidenceAssessments: Object.freeze([Object.freeze({
    fingerprint: misleadingEvidence,
    hypothesisId: 'dependency-hypothesis',
    effect: 'contradicts',
  })]),
});

const falseAlertGroundTruth = Object.freeze({
  expectedStopKind: 'sufficient',
  expectedConclusionKind: 'no-incident',
  expectedEvidence: Object.freeze([expectedEvidence]),
});

const falseAlertPositiveOutcome = Object.freeze({
  stopKind: 'sufficient',
  conclusionKind: 'no-incident',
  evidenceFingerprints: Object.freeze([expectedEvidence]),
});

const challengeChangesGroundTruth = Object.freeze({
  expectedLeaderChangeAfterChallenge: true,
});

const challengeChangesOutcome = Object.freeze({
  challengeNodeExecuted: true,
  challengeInvocationCount: 1,
  leaderBeforeChallengeId: 'deployment-hypothesis',
  leaderAfterChallengeId: 'dependency-hypothesis',
  leaderStatusBeforeChallenge: 'candidate',
  leaderStatusAfterChallenge: 'supported',
  executedDiscriminatingTrialCount: 1,
});

const benchmarkVersions = Object.freeze({
  graphVersion: 'graph-v0.1',
  promptVersion: 'prompt-v0.1',
  toolsetVersion: 'toolset-v0.1',
  statusRulesVersion: STATUS_RULES_VERSION,
  evaluatorVersion: 'behavior-evaluators-v0.2',
  toolMode: 'replay',
  knowledgeSetVersion: 'knowledge-none-v0.1',
  memoryEnabled: false,
  temperature: 0,
  seed: 17,
  docsAvailable: false,
});

const executionInputKeys = Object.freeze([
  'exampleId',
  'experimentId',
  'fixture',
  'metadata',
  'runId',
  'scenarioId',
  'threadId',
]);

const executionMetadataKeys = Object.freeze([
  'docsAvailable',
  'evaluatorVersion',
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
]);

function requireFunction(name) {
  assert.equal(
    typeof evals[name],
    'function',
    `@aic/evals must publish ${name}(options)`,
  );
  return evals[name];
}

function assertVersionedMetric(metric) {
  assert.deepEqual(Object.keys(metric).sort(), [
    'evaluatorVersion',
    'key',
    'reason',
    'score',
  ]);
  assert.equal(metric.evaluatorVersion, evals.BEHAVIOR_EVALUATOR_VERSION);
  assert.equal(typeof metric.key, 'string');
  assert.equal(metric.key.length > 0, true);
  assert.equal(metric.score === 0 || metric.score === 1, true);
  assert.equal(typeof metric.reason, 'string');
  assert.equal(metric.reason.length > 0, true);
}

function assertExecutionInputAllowlist(input) {
  assert.deepEqual(Object.keys(input).sort(), executionInputKeys);
  assert.deepEqual(Object.keys(input.metadata).sort(), executionMetadataKeys);
  assert.equal(Object.hasOwn(input, 'scenario'), false);
  assert.equal(Object.hasOwn(input, 'groundTruth'), false);
  assert.equal(Object.hasOwn(input.metadata, 'scenario'), false);
  assert.equal(Object.hasOwn(input.metadata, 'groundTruth'), false);
}

function persistenceClient() {
  const runs = [];
  let runCalls = 0;
  return {
    runs,
    get runCalls() {
      return runCalls;
    },
    client: {
      async createDataset() {
        return { id: 'dataset-id' };
      },
      async createExamples(examples) {
        return examples.map(({ id }) => ({ id }));
      },
      async createProject() {
        return { id: 'project-id' };
      },
      async createRun(run) {
        runCalls += 1;
        runs.push(run);
      },
      async createFeedback() {
        return {};
      },
    },
  };
}

function versioned(options) {
  return {
    evaluatorVersion: evals.BEHAVIOR_EVALUATOR_VERSION,
    ...options,
  };
}

function behaviorMetrics({
  misleadingOutcome = misleadingPositiveOutcome,
  falseAlertOutcome = falseAlertPositiveOutcome,
  challengeOutcome = challengeChangesOutcome,
} = {}) {
  const metrics = [
    requireFunction('evaluateMisleadingEvidenceHandling')(versioned({
      groundTruth: misleadingGroundTruth,
      outcome: misleadingOutcome,
    })),
    requireFunction('evaluateFalseAlertOutcome')(versioned({
      groundTruth: falseAlertGroundTruth,
      outcome: falseAlertOutcome,
    })),
    requireFunction('evaluateChallengeEffect')(versioned({
      groundTruth: challengeChangesGroundTruth,
      outcome: challengeOutcome,
    })),
  ];
  return Object.fromEntries(metrics.map((metric) => [metric.key, metric.score]));
}

function scenarioById(scenarioId) {
  const scenario = evals.REPLAY_SCENARIOS.find(({ id }) => id === scenarioId);
  assert.ok(scenario, `missing scenario: ${scenarioId}`);
  return scenario;
}

function recordForScenario(scenarioId) {
  return evals.createCalibrationBenchmarkPlan({
    experimentId: 'behavior-metrics-calibration-v0.2',
    runsPerScenario: 3,
    metadata: benchmarkVersions,
  }).find(({ scenario }) => scenario.id === scenarioId);
}

function outcomeForScenario(scenario) {
  const rootCauseHypothesisId = scenario.groundTruth.rootCause === undefined
    ? undefined
    : 'root-cause-hypothesis';
  return {
    claims: [{ evidenceIds: ['supporting-evidence'] }],
    supportingEvidenceIds: ['supporting-evidence'],
    evidenceFingerprints: [
      ...scenario.groundTruth.expectedEvidence,
      ...(scenario.groundTruth.misleadingEvidence ?? []),
    ],
    stopKind: scenario.groundTruth.expectedStopKind,
    conclusionKind: scenario.groundTruth.expectedConclusionKind,
    rootCause: scenario.groundTruth.rootCause,
    rootCauseHypothesisId,
    evidenceAssessments: (scenario.groundTruth.misleadingEvidence ?? []).map(
      (fingerprint) => ({
        fingerprint,
        hypothesisId: rootCauseHypothesisId,
        effect: 'contradicts',
      }),
    ),
    challengeEffect: {
      challengeNodeExecuted: true,
      challengeInvocationCount: 1,
      leaderBeforeChallengeId: 'leader-before',
      leaderAfterChallengeId:
        scenario.groundTruth.expectedLeaderChangeAfterChallenge === true
          ? 'leader-after'
          : 'leader-before',
      leaderStatusBeforeChallenge: 'candidate',
      leaderStatusAfterChallenge: 'supported',
      executedDiscriminatingTrialCount: 1,
    },
  };
}

test('publishes three independently versioned behavior metrics', () => {
  assert.equal(
    typeof evals.BEHAVIOR_EVALUATOR_VERSION,
    'string',
    '@aic/evals must publish BEHAVIOR_EVALUATOR_VERSION',
  );
  assert.equal(evals.BEHAVIOR_EVALUATOR_VERSION.length > 0, true);

  const evaluations = [
    requireFunction('evaluateMisleadingEvidenceHandling')(versioned({
      groundTruth: misleadingGroundTruth,
      outcome: misleadingPositiveOutcome,
    })),
    requireFunction('evaluateFalseAlertOutcome')(versioned({
      groundTruth: falseAlertGroundTruth,
      outcome: falseAlertPositiveOutcome,
    })),
    requireFunction('evaluateChallengeEffect')(versioned({
      groundTruth: challengeChangesGroundTruth,
      outcome: challengeChangesOutcome,
    })),
  ];

  evaluations.forEach(assertVersionedMetric);
  assert.deepEqual(
    evals.BEHAVIOR_METRIC_KEYS,
    evaluations.map(({ key }) => key),
  );
  assert.equal(new Set(evals.BEHAVIOR_METRIC_KEYS).size, 3);
});

test('passes misleading evidence handling only after observing misleading and expected evidence', () => {
  const evaluate = requireFunction('evaluateMisleadingEvidenceHandling');

  const metric = evaluate(versioned({
    groundTruth: misleadingGroundTruth,
    outcome: misleadingPositiveOutcome,
  }));

  assertVersionedMetric(metric);
  assert.equal(metric.score, 1);
});

test('fails misleading evidence handling when the conclusion follows the misleading cause', () => {
  const evaluate = requireFunction('evaluateMisleadingEvidenceHandling');

  const metric = evaluate(versioned({
    groundTruth: misleadingGroundTruth,
    outcome: {
      ...misleadingPositiveOutcome,
      rootCause: misleadingRootCause,
    },
  }));

  assert.equal(metric.score, 0);
  assert.match(metric.reason, /root-cause-mismatch/);
});

test('fails misleading evidence handling when misleading evidence was never observed', () => {
  const evaluate = requireFunction('evaluateMisleadingEvidenceHandling');

  const metric = evaluate(versioned({
    groundTruth: misleadingGroundTruth,
    outcome: {
      ...misleadingPositiveOutcome,
      evidenceFingerprints: [expectedEvidence],
    },
  }));

  assert.equal(metric.score, 0);
  assert.match(metric.reason, /misleading-evidence-not-investigated/);
});

test('fails misleading evidence handling when collected evidence is not reconciled with the concluded hypothesis', () => {
  const evaluate = requireFunction('evaluateMisleadingEvidenceHandling');

  const metric = evaluate(versioned({
    groundTruth: misleadingGroundTruth,
    outcome: {
      ...misleadingPositiveOutcome,
      evidenceAssessments: [],
    },
  }));

  assert.equal(metric.score, 0);
  assert.equal(metric.reason, 'misleading-evidence-not-reconciled');
});

test('passes a false alert only with no-incident, sufficient stop, and all expected evidence', () => {
  const evaluate = requireFunction('evaluateFalseAlertOutcome');

  const metric = evaluate(versioned({
    groundTruth: falseAlertGroundTruth,
    outcome: falseAlertPositiveOutcome,
  }));

  assertVersionedMetric(metric);
  assert.equal(metric.score, 1);
});

test('fails a false alert that stops early without the expected evidence', () => {
  const evaluate = requireFunction('evaluateFalseAlertOutcome');

  const metric = evaluate(versioned({
    groundTruth: falseAlertGroundTruth,
    outcome: {
      ...falseAlertPositiveOutcome,
      stopKind: 'budget-exhausted',
      evidenceFingerprints: [],
    },
  }));

  assert.equal(metric.score, 0);
  assert.match(metric.reason, /insufficient-investigation/);
});

test('passes challenge effect when the challenged leader actually changes', () => {
  const metric = requireFunction('evaluateChallengeEffect')(versioned({
    groundTruth: challengeChangesGroundTruth,
    outcome: challengeChangesOutcome,
  }));

  assertVersionedMetric(metric);
  assert.equal(metric.score, 1);
});

test('does not count challenge-node invocation without an investigation change', () => {
  const metric = requireFunction('evaluateChallengeEffect')(versioned({
    groundTruth: challengeChangesGroundTruth,
    outcome: {
      ...challengeChangesOutcome,
      leaderAfterChallengeId: challengeChangesOutcome.leaderBeforeChallengeId,
      leaderStatusAfterChallenge:
        challengeChangesOutcome.leaderStatusBeforeChallenge,
      executedDiscriminatingTrialCount: 0,
    },
  }));

  assert.equal(metric.score, 0);
  assert.match(metric.reason, /no-investigation-change/);
});

test('passes a challenge that proves the prior leader with a discriminating trial', () => {
  const metric = requireFunction('evaluateChallengeEffect')(versioned({
    groundTruth: { expectedLeaderChangeAfterChallenge: false },
    outcome: {
      ...challengeChangesOutcome,
      leaderAfterChallengeId: challengeChangesOutcome.leaderBeforeChallengeId,
      leaderStatusAfterChallenge: 'supported',
      executedDiscriminatingTrialCount: 1,
    },
  }));

  assert.equal(metric.score, 1);
});

test('fails challenge effect closed when either leader observation is missing', () => {
  const metric = requireFunction('evaluateChallengeEffect')(versioned({
    groundTruth: { expectedLeaderChangeAfterChallenge: false },
    outcome: {
      ...challengeChangesOutcome,
      leaderBeforeChallengeId: undefined,
      leaderAfterChallengeId: undefined,
      executedDiscriminatingTrialCount: 1,
    },
  }));

  assert.equal(metric.score, 0);
  assert.equal(metric.reason, 'leader-observation-missing');
});

test('fails a challenge that switches leaders when no switch was expected', () => {
  const metric = requireFunction('evaluateChallengeEffect')(versioned({
    groundTruth: { expectedLeaderChangeAfterChallenge: false },
    outcome: challengeChangesOutcome,
  }));

  assert.equal(metric.score, 0);
  assert.equal(metric.reason, 'leader-change-mismatch');
});

test('each behavior mutation changes only its corresponding metric', () => {
  const baseline = behaviorMetrics();
  assert.deepEqual(baseline, {
    misleading_evidence_handling: 1,
    false_alert_correctness: 1,
    challenge_effect: 1,
  });

  const mutations = [
    {
      key: 'misleading_evidence_handling',
      options: {
        misleadingOutcome: {
          ...misleadingPositiveOutcome,
          rootCause: misleadingRootCause,
        },
      },
    },
    {
      key: 'false_alert_correctness',
      options: {
        falseAlertOutcome: {
          ...falseAlertPositiveOutcome,
          evidenceFingerprints: [],
        },
      },
    },
    {
      key: 'challenge_effect',
      options: {
        challengeOutcome: {
          ...challengeChangesOutcome,
          leaderAfterChallengeId:
            challengeChangesOutcome.leaderBeforeChallengeId,
          leaderStatusAfterChallenge:
            challengeChangesOutcome.leaderStatusBeforeChallenge,
          executedDiscriminatingTrialCount: 0,
        },
      },
    },
  ];

  for (const mutation of mutations) {
    const observed = behaviorMetrics(mutation.options);
    assert.equal(observed[mutation.key], 0);
    assert.deepEqual(
      Object.fromEntries(
        Object.entries(observed).filter(([key]) => key !== mutation.key),
      ),
      Object.fromEntries(
        Object.entries(baseline).filter(([key]) => key !== mutation.key),
      ),
    );
  }
});

test('rejects evaluator inputs with an undeclared version', () => {
  assert.throws(
    () => requireFunction('evaluateFalseAlertOutcome')({
      evaluatorVersion: 'behavior-evaluators-v999',
      groundTruth: falseAlertGroundTruth,
      outcome: falseAlertPositiveOutcome,
    }),
    /evaluator version/i,
  );
});

test('keeps scenario ground truth outside the investigation execution callback', async () => {
  const scenarios = evals.REPLAY_SCENARIOS.slice(0, 5);
  const scenariosById = new Map(
    scenarios.map((scenario) => [scenario.id, scenario]),
  );
  const callbackInputs = [];

  const experiment = await requireFunction('runBenchmarkExperiment')({
    experimentId: 'behavior-execution-boundary-v0.2',
    scenarioSet: 'ad-hoc',
    scenarios,
    runsPerScenario: 3,
    metadata: benchmarkVersions,
    async investigate(input) {
      callbackInputs.push(input);
      assertExecutionInputAllowlist(input);
      const scenario = scenariosById.get(input.scenarioId);
      assert.ok(scenario);
      return {
        claims: [{ evidenceIds: ['supporting-evidence'] }],
        supportingEvidenceIds: ['supporting-evidence'],
        evidenceFingerprints: scenario.groundTruth.expectedEvidence,
        stopKind: scenario.groundTruth.expectedStopKind,
        conclusionKind: scenario.groundTruth.expectedConclusionKind,
      };
    },
    async recordEvaluation() {},
  });

  assert.equal(callbackInputs.length, 15);
  assert.equal(experiment.results.length, 15);
});

test('persists accepted v0.1 records without behavior-evaluator fields', async () => {
  const scenario = scenarioById('bad-deployment');
  const record = recordForScenario('bad-deployment');
  assert.ok(record);
  const result = evals.evaluateBenchmarkRecord({
    record,
    outcome: outcomeForScenario(scenario),
  });
  const { evaluatorVersion: _evaluatorVersion, ...legacyMetadata } =
    record.metadata;
  const { behaviorMetrics: _behaviorMetrics, ...legacyResult } = result;
  const capture = persistenceClient();

  await observability.persistBenchmarkExperiment({
    client: capture.client,
    datasetName: 'accepted-v0.1-without-behavior-fields',
    experiment: {
      records: [{ ...record, metadata: legacyMetadata }],
      results: [legacyResult],
    },
  });

  assert.equal(capture.runCalls, 1);
  assert.equal(
    Object.hasOwn(capture.runs[0].extra.metadata, 'evaluatorVersion'),
    false,
  );
});

test('rejects behavior metrics when their evaluator version is absent', async () => {
  const scenario = scenarioById('false-alert');
  const record = recordForScenario('false-alert');
  assert.ok(record);
  const result = evals.evaluateBenchmarkRecord({
    record,
    outcome: outcomeForScenario(scenario),
  });
  const { evaluatorVersion: _evaluatorVersion, ...metadataWithoutVersion } =
    record.metadata;
  const capture = persistenceClient();

  await assert.rejects(
    () => observability.persistBenchmarkExperiment({
      client: capture.client,
      datasetName: 'behavior-metrics-without-version',
      experiment: {
        records: [{ ...record, metadata: metadataWithoutVersion }],
        results: [result],
      },
    }),
    /behavior metric evaluator version/i,
  );
  assert.equal(capture.runCalls, 0);
});

test('rejects an explicitly unsupported persisted evaluator version', async () => {
  const scenario = scenarioById('false-alert');
  const record = recordForScenario('false-alert');
  assert.ok(record);
  const result = evals.evaluateBenchmarkRecord({
    record,
    outcome: outcomeForScenario(scenario),
  });
  const capture = persistenceClient();

  await assert.rejects(
    () => observability.persistBenchmarkExperiment({
      client: capture.client,
      datasetName: 'unsupported-behavior-version',
      experiment: {
        records: [{
          ...record,
          metadata: {
            ...record.metadata,
            evaluatorVersion: 'behavior-evaluators-v999',
          },
        }],
        results: [result],
      },
    }),
    /evaluator version/i,
  );
  assert.equal(capture.runCalls, 0);
});

test('attaches each applicable behavior metric without a composite score', () => {
  const cases = [
    ['dependency-caused-incident-b', ['misleading_evidence_handling']],
    ['false-alert', ['false_alert_correctness']],
    ['challenge-keeps-leader', ['challenge_effect']],
  ];

  for (const [scenarioId, expectedKeys] of cases) {
    const scenario = scenarioById(scenarioId);
    const record = recordForScenario(scenarioId);
    assert.ok(record);
    const result = evals.evaluateBenchmarkRecord({
      record,
      outcome: outcomeForScenario(scenario),
    });

    assert.deepEqual(Object.keys(result.behaviorMetrics), expectedKeys);
    assert.equal(result.behaviorMetrics[expectedKeys[0]].score, 1);
    assert.equal(Object.hasOwn(result, 'compositeScore'), false);
  }
});

test('persists versioned behavior output and feedback on the LangSmith experiment', async () => {
  const scenario = scenarioById('false-alert');
  const record = recordForScenario('false-alert');
  assert.ok(record);
  const result = evals.evaluateBenchmarkRecord({
    record,
    outcome: outcomeForScenario(scenario),
  });
  const feedback = [];
  const runs = [];
  const client = {
    async createDataset() {
      return { id: 'dataset-id' };
    },
    async createExamples(examples) {
      return examples.map(({ id }) => ({ id }));
    },
    async createProject() {
      return { id: 'project-id' };
    },
    async createRun(run) {
      runs.push(run);
    },
    async createFeedback(item) {
      feedback.push(item);
      return {};
    },
  };

  await observability.persistBenchmarkExperiment({
    client,
    datasetName: 'behavior-evaluators-calibration-v0.2',
    experiment: { records: [record], results: [result] },
  });

  assert.deepEqual(
    feedback.map(({ key }) => key).sort(),
    [
      'evidence_coverage',
      'false_alert_correctness',
      'termination_correctness',
      'unsupported_claim_rate',
    ],
  );
  assert.equal(
    runs[0].extra.metadata.evaluatorVersion,
    evals.BEHAVIOR_EVALUATOR_VERSION,
  );
  assert.deepEqual(
    Object.keys(runs[0].outputs.behaviorMetrics),
    ['false_alert_correctness'],
  );
});

test('projects behavior metrics through an exact outbound allowlist', async () => {
  const scenario = scenarioById('false-alert');
  const record = recordForScenario('false-alert');
  assert.ok(record);
  const result = evals.evaluateBenchmarkRecord({
    record,
    outcome: outcomeForScenario(scenario),
  });
  const canary = 'must-not-cross-langsmith-boundary';
  const runs = [];
  const client = {
    async createDataset() {
      return { id: 'dataset-id' };
    },
    async createExamples(examples) {
      return examples.map(({ id }) => ({ id }));
    },
    async createProject() {
      return { id: 'project-id' };
    },
    async createRun(run) {
      runs.push(run);
    },
    async createFeedback() {
      return {};
    },
  };
  const metric = result.behaviorMetrics.false_alert_correctness;

  await observability.persistBenchmarkExperiment({
    client,
    datasetName: 'behavior-evaluator-allowlist-v0.2',
    experiment: {
      records: [record],
      results: [{
        ...result,
        behaviorMetrics: {
          false_alert_correctness: { ...metric, secretCanary: canary },
        },
      }],
    },
  });

  assert.equal(JSON.stringify(runs).includes(canary), false);
  assert.deepEqual(
    Object.keys(runs[0].outputs.behaviorMetrics.false_alert_correctness).sort(),
    ['evaluatorVersion', 'key', 'reason', 'score'],
  );
});

test('rejects malformed behavior metrics before any LangSmith run is created', async () => {
  const scenario = scenarioById('false-alert');
  const record = recordForScenario('false-alert');
  assert.ok(record);
  const result = evals.evaluateBenchmarkRecord({
    record,
    outcome: outcomeForScenario(scenario),
  });
  let runCalls = 0;
  const client = {
    async createDataset() {
      return { id: 'dataset-id' };
    },
    async createExamples(examples) {
      return examples.map(({ id }) => ({ id }));
    },
    async createProject() {
      return { id: 'project-id' };
    },
    async createRun() {
      runCalls += 1;
    },
    async createFeedback() {
      return {};
    },
  };
  const metric = result.behaviorMetrics.false_alert_correctness;

  await assert.rejects(
    () => observability.persistBenchmarkExperiment({
      client,
      datasetName: 'behavior-evaluator-invalid-v0.2',
      experiment: {
        records: [record],
        results: [{
          ...result,
          behaviorMetrics: {
            false_alert_correctness: { ...metric, score: Number.NaN },
          },
        }],
      },
    }),
    /behavior metric score/i,
  );
  assert.equal(runCalls, 0);
});

test('graph benchmark keeps ground truth outside createNodes and records a challenge with no investigation change', async () => {
  const experiment = await evals.runGraphBenchmarkExperiment({
    experimentId: 'challenge-observation-calibration-v0.2',
    scenarioSet: 'calibration',
    runsPerScenario: 3,
    metadata: benchmarkVersions,
    createNodes(input) {
      assertExecutionInputAllowlist(input);
      const leaderId = `leader-${input.runId}`;
      const empty = async () => ({});
      return {
        normalize_incident: empty,
        collect_baseline: empty,
        generate_hypotheses: async () => ({
          hypotheses: [{
            id: leaderId,
            statement: 'initial leader',
            createdBy: 'initial',
          }],
        }),
        derive_predictions: empty,
        plan_investigation: empty,
        execute_investigation: empty,
        evaluate_predictions: empty,
        interpret_residual_evidence: empty,
        derive_hypothesis_state: empty,
        termination_check: async () => ({
          route: 'terminal',
          stopKind: 'sufficient',
          leaderId,
        }),
        challenge_hypothesis: async () => ({
          alternative: {
            id: `alternative-${input.runId}`,
            statement: 'challenge alternative',
            createdBy: 'challenge',
          },
          discriminatingTests: [{
            id: `challenge-test-${input.runId}`,
            predictionId: `challenge-prediction-${input.runId}`,
            tool: input.fixture.entries[0].toolId,
            input: { challenge: true },
            cost: 'cheap',
            status: 'planned',
          }],
        }),
        propose_conclusion: async () => ({
          conclusion: { kind: 'inconclusive', causes: [] },
        }),
      };
    },
    async recordEvaluation() {},
  });
  const record = experiment.records.find(
    ({ scenario }) => scenario.id === 'challenge-keeps-leader',
  );
  assert.ok(record);
  const result = experiment.results.find(({ runId }) => runId === record.runId);
  assert.ok(result);

  assert.equal(result.behaviorMetrics.challenge_effect.score, 0);
  assert.equal(
    result.behaviorMetrics.challenge_effect.reason,
    'no-investigation-change',
  );
});

test('passes challenge effect from a graph-backed status trajectory and executed discriminating trial', async () => {
  const experiment = await evals.runGraphBenchmarkExperiment({
    experimentId: 'challenge-positive-trajectory-calibration-v0.2',
    scenarioSet: 'calibration',
    runsPerScenario: 3,
    metadata: benchmarkVersions,
    createNodes(input) {
      assertExecutionInputAllowlist(input);
      const leaderId = `leader-${input.runId}`;
      const predictionId = `prediction-${input.runId}`;
      const testId = `challenge-test-${input.runId}`;
      const trialId = `challenge-trial-${input.runId}`;
      const evidenceIds = [
        `challenge-evidence-a-${input.runId}`,
        `challenge-evidence-b-${input.runId}`,
      ];
      const tool = input.fixture.entries[0].toolId;
      const empty = async () => ({});
      return {
        normalize_incident: empty,
        collect_baseline: empty,
        generate_hypotheses: async () => ({
          hypotheses: [{
            id: leaderId,
            statement: 'initial leader survives a discriminating challenge',
            createdBy: 'initial',
          }],
        }),
        derive_predictions: async () => ({
          predictions: [{
            id: predictionId,
            hypothesisId: leaderId,
            statement: 'challenge evidence supports the leader',
            expectedIfTrue: [],
            expectedIfFalse: [],
            status: 'untested',
          }],
        }),
        plan_investigation: empty,
        execute_investigation: async (state) => {
          if (state.control.challengeRounds === 0) return {};
          return {
            tests: [{
              id: testId,
              predictionId,
              tool,
              input: { challenge: true },
              cost: 'cheap',
              status: 'executed',
            }],
            trials: [{
              id: trialId,
              runId: input.runId,
              testId,
              attempt: 1,
              tool,
              input: { challenge: true },
              status: 'ok',
              durationMs: 1,
              evidenceIds,
            }],
            evidence: evidenceIds.map((id, index) => ({
              id,
              trialId,
              kind: 'dependency',
              source: `challenge/source-${index + 1}`,
              observedAt: '2026-09-01T00:00:00.000Z',
              statement: `independent challenge support ${index + 1}`,
              rawRef: `replay://challenge/${index + 1}`,
              reliability: 'high',
            })),
          };
        },
        evaluate_predictions: async (state) => {
          if (state.control.challengeRounds === 0) return {};
          return {
            predictions: [{
              id: predictionId,
              hypothesisId: leaderId,
              statement: 'challenge evidence supports the leader',
              expectedIfTrue: [],
              expectedIfFalse: [],
              status: 'confirmed',
            }],
            assessments: evidenceIds.map((evidenceId, index) => ({
              id: `assessment-${index + 1}-${input.runId}`,
              evidenceId,
              hypothesisId: leaderId,
              predictionId,
              effect: 'supports',
              strength: 'high',
              rationale: 'independent challenge evidence supports the leader',
              producedBy: 'rule',
              at: '2026-09-01T00:00:00.000Z',
            })),
          };
        },
        interpret_residual_evidence: empty,
        derive_hypothesis_state: empty,
        termination_check: async () => ({
          route: 'terminal',
          stopKind: 'sufficient',
          leaderId,
        }),
        challenge_hypothesis: async () => ({
          alternative: {
            id: `alternative-${input.runId}`,
            statement: 'challenge alternative',
            createdBy: 'challenge',
          },
          discriminatingTests: [{
            id: testId,
            predictionId,
            tool,
            input: { challenge: true },
            cost: 'cheap',
            status: 'planned',
          }],
        }),
        propose_conclusion: async () => ({
          conclusion: { kind: 'inconclusive', causes: [] },
        }),
      };
    },
    async recordEvaluation() {},
  });
  const record = experiment.records.find(
    ({ scenario }) => scenario.id === 'challenge-keeps-leader',
  );
  assert.ok(record);
  const result = experiment.results.find(({ runId }) => runId === record.runId);
  assert.ok(result);

  assert.equal(result.behaviorMetrics.challenge_effect.score, 1);
  assert.equal(result.behaviorMetrics.challenge_effect.reason, 'passed');
});

// The shared fixture for the three trial-status tests below. It differs from
// the status-trajectory test above in what it deliberately LEAVES OUT: nothing
// after the challenge writes an assessment or confirms a prediction, so the
// leader's derived status is identical either side of the challenge, and the
// leader itself never changes. Every route to a non-zero challenge_effect is
// therefore closed except the executed-discriminating-trial count, which is
// what these tests are about.
async function graphExperimentWithDiscriminatingTrialStatus(trialStatus) {
  return evals.runGraphBenchmarkExperiment({
    experimentId: `challenge-trial-${trialStatus}-calibration-v0.2`,
    scenarioSet: 'calibration',
    runsPerScenario: 3,
    metadata: benchmarkVersions,
    createNodes(input) {
      assertExecutionInputAllowlist(input);
      const leaderId = `leader-${input.runId}`;
      const predictionId = `prediction-${input.runId}`;
      const testId = `challenge-test-${input.runId}`;
      const trialId = `challenge-trial-${input.runId}`;
      const tool = input.fixture.entries[0].toolId;
      const empty = async () => ({});
      return {
        normalize_incident: empty,
        collect_baseline: empty,
        generate_hypotheses: async () => ({
          hypotheses: [{
            id: leaderId,
            statement: 'initial leader survives a discriminating challenge',
            createdBy: 'initial',
          }],
        }),
        derive_predictions: async () => ({
          predictions: [{
            id: predictionId,
            hypothesisId: leaderId,
            statement: 'the discriminating test separates the alternatives',
            expectedIfTrue: [],
            expectedIfFalse: [],
            status: 'untested',
          }],
        }),
        plan_investigation: empty,
        execute_investigation: async (state) => {
          if (state.control.challengeRounds === 0) return {};
          return {
            tests: [{
              id: testId,
              predictionId,
              tool,
              input: { challenge: true },
              cost: 'cheap',
              status: 'executed',
            }],
            trials: [{
              id: trialId,
              runId: input.runId,
              testId,
              attempt: 1,
              tool,
              input: { challenge: true },
              status: trialStatus,
              durationMs: 1,
              evidenceIds: [],
            }],
          };
        },
        evaluate_predictions: empty,
        interpret_residual_evidence: empty,
        derive_hypothesis_state: empty,
        termination_check: async () => ({
          route: 'terminal',
          stopKind: 'sufficient',
          leaderId,
        }),
        challenge_hypothesis: async () => ({
          alternative: {
            id: `alternative-${input.runId}`,
            statement: 'challenge alternative',
            createdBy: 'challenge',
          },
          discriminatingTests: [{
            id: testId,
            predictionId,
            tool,
            input: { challenge: true },
            cost: 'cheap',
            status: 'planned',
          }],
        }),
        propose_conclusion: async () => ({
          conclusion: { kind: 'inconclusive', causes: [] },
        }),
      };
    },
    async recordEvaluation() {},
  });
}

function challengeEffectForKeptLeader(experiment) {
  const record = experiment.records.find(
    ({ scenario }) => scenario.id === 'challenge-keeps-leader',
  );
  assert.ok(record);
  const result = experiment.results.find(({ runId }) => runId === record.runId);
  assert.ok(result);
  return result.behaviorMetrics.challenge_effect;
}

test('passes challenge effect when the only investigation change is a discriminating trial that succeeded', async () => {
  const metric = challengeEffectForKeptLeader(
    await graphExperimentWithDiscriminatingTrialStatus('ok'),
  );

  assert.equal(metric.score, 1);
  assert.equal(metric.reason, 'passed');
});

test('does not credit a discriminating trial that ended in error', async () => {
  const metric = challengeEffectForKeptLeader(
    await graphExperimentWithDiscriminatingTrialStatus('error'),
  );

  assert.equal(metric.score, 0);
  assert.equal(metric.reason, 'no-investigation-change');
});

test('does not credit a discriminating trial whose tool was unavailable', async () => {
  const metric = challengeEffectForKeptLeader(
    await graphExperimentWithDiscriminatingTrialStatus('unavailable'),
  );

  assert.equal(metric.score, 0);
  assert.equal(metric.reason, 'no-investigation-change');
});
