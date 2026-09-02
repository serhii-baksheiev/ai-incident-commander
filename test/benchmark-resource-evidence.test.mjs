/**
 * Stage B of AIC-63: the benchmark reports what a run COST, on its own axes.
 *
 * Three settled decisions this file encodes rather than re-litigates:
 *   - `retryCount` is a structural zero. `Trial.attempt` is the constant `1` at
 *     its only producer (`packages/graph/src/index.ts`) and no retry mechanism
 *     exists, so the field is published as `0` and is honest about it — the same
 *     treatment AIC-62 gave `llmCallsUsed`.
 *   - No composite and no derived "recovery overhead". Every axis is published
 *     as its own field, so nothing blends quality with resource and nothing
 *     blends the logical budget with recovery.
 *   - `wallClockDurationMs` is real wall-clock, measured by the runner around
 *     the investigation it ran.
 *
 * And one boundary, which is the whole reason resource evidence is not simply a
 * field on `BenchmarkOutcome`: `runBenchmarkExperiment` takes an OPAQUE
 * `investigate` callback. A number that arrives from it is a number nobody
 * verified, so the generic path publishes none at all — absence, not a figure
 * with a caveat attached to it. Only `runGraphBenchmarkExperiment`, which owns
 * the graph it executed and can read that graph's own control block, publishes
 * measured values.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { setTimeout as sleep } from 'node:timers/promises';

import * as evals from '@aic/evals';
import * as observability from '@aic/observability';

import {
  benchmarkVersions,
  perfectOutcomeFor,
  requireFunction,
} from './fixtures/benchmark-experiment.mjs';

/**
 * The declared resource dimensions, sorted, as an exact set. Every assertion
 * about "one key per dimension" reads this rather than restating it, so a
 * dimension added without a decision fails here first.
 */
const resourceFieldNames = [
  'declaredLlmCallsUsed',
  'logicalIterationsUsed',
  'resumeCount',
  'retryCount',
  'schemaVersion',
  'toolCallsUsed',
  'wallClockDurationMs',
];

/**
 * What the probe fixture below spends, chosen so no two measured axes share a
 * value: an implementation that reported the iteration count for the tool count
 * would pass a fixture where both happened to be 3.
 */
const probeSpend = Object.freeze({
  logicalIterations: 2,
  declaredLlmCalls: 5,
  toolCalls: 3,
  investigationSleepMs: 30,
});

function requireResourceSchemaVersion() {
  const version = evals.BENCHMARK_RESOURCE_SCHEMA_VERSION;
  assert.equal(
    typeof version,
    'number',
    '@aic/evals must export BENCHMARK_RESOURCE_SCHEMA_VERSION',
  );
  return version;
}

function probeTrials(runId) {
  return Array.from({ length: probeSpend.toolCalls }, (_, index) => ({
    id: `resource-probe-trial-${runId}-${index + 1}`,
    runId,
    testId: `resource-probe-test-${runId}-${index + 1}`,
    // The structural zero, at its source: nothing in this repository produces a
    // trial with a second attempt, so a retry count read off these trials is 0
    // by construction rather than by estimate.
    attempt: 1,
    tool: 'replay:logs',
    input: { probe: index + 1 },
    status: 'ok',
    durationMs: 1,
    evidenceIds: [],
  }));
}

/**
 * Lifecycle nodes that spend a known amount on each axis: two logical
 * iterations (one automatic loop-back), one node declaring five llm calls,
 * three trials, and a real pause so the wall clock has something to measure.
 */
function resourceProbeNodes(input, observed) {
  const leaderId = `resource-probe-leader-${input.runId}`;
  const empty = async () => ({});

  return {
    async normalize_incident() {
      await sleep(probeSpend.investigationSleepMs);
      return {};
    },
    collect_baseline: empty,
    generate_hypotheses: async () => ({
      hypotheses: [{
        id: leaderId,
        statement: 'resource probe leader',
        createdBy: 'initial',
      }],
      declaredLlmCalls: probeSpend.declaredLlmCalls,
    }),
    derive_predictions: empty,
    plan_investigation: empty,
    // Runs on both passes and reports the same three trials; the state reducer
    // upserts by id, so the tool count stays 3 while the iteration count is 2.
    execute_investigation: async () => ({ trials: probeTrials(input.runId) }),
    evaluate_predictions: empty,
    interpret_residual_evidence: empty,
    derive_hypothesis_state: empty,
    async termination_check(state) {
      return state.control.iterationsUsed < probeSpend.logicalIterations
        ? { route: 'need-more-evidence' }
        : { route: 'terminal', stopKind: 'stalled' };
    },
    async challenge_hypothesis() {
      throw new Error('challenge must not run in the resource probe fixture');
    },
    // The independent observation: what this run actually spent, read from the
    // state the last lifecycle node was handed. A published figure is only
    // evidence if something other than the publisher saw the same number.
    async propose_conclusion(state) {
      observed.set(input.runId, {
        logicalIterationsUsed: state.control.iterationsUsed,
        declaredLlmCallsUsed: state.control.llmCallsUsed,
        toolCallsUsed: state.trials.length,
        resumeCount: state.control.resumeCount,
      });
      return { conclusion: { kind: 'inconclusive', causes: [] } };
    },
  };
}

/**
 * One graph-backed run of the calibration partition, shared by every test that
 * reads measured resource evidence. Memoised for cost only: no assertion
 * compares values obtained from two separate invocations.
 */
let graphResourceExperiment;

function getGraphResourceExperiment() {
  if (graphResourceExperiment !== undefined) return graphResourceExperiment;

  graphResourceExperiment = (async () => {
    const runGraphBenchmarkExperiment = requireFunction(
      evals,
      'runGraphBenchmarkExperiment',
      '@aic/evals',
    );
    const recorded = [];
    const observed = new Map();
    const experiment = await runGraphBenchmarkExperiment({
      experimentId: 'resource-evidence-graph-v0.2',
      scenarioSet: 'calibration',
      runsPerScenario: 3,
      metadata: benchmarkVersions,
      createNodes: (input) => resourceProbeNodes(input, observed),
      async recordEvaluation(payload) {
        recorded.push(payload);
      },
    });
    return { experiment, recorded, observed };
  })();

  return graphResourceExperiment;
}

function capturingClient() {
  const runs = [];
  const feedback = [];
  return {
    runs,
    feedback,
    client: {
      async createDataset() {
        return { id: 'resource-dataset-id' };
      },
      async createExamples(examples) {
        return examples.map(({ id }) => ({ id }));
      },
      async createProject() {
        return { id: 'resource-project-id' };
      },
      async createRun(run) {
        runs.push(run);
      },
      async createFeedback(payload) {
        feedback.push(payload);
        return {};
      },
    },
  };
}

function measuredResources(overrides = {}) {
  return {
    schemaVersion: evals.BENCHMARK_RESOURCE_SCHEMA_VERSION,
    logicalIterationsUsed: probeSpend.logicalIterations,
    declaredLlmCallsUsed: probeSpend.declaredLlmCalls,
    toolCallsUsed: probeSpend.toolCalls,
    wallClockDurationMs: 41,
    retryCount: 0,
    resumeCount: 0,
    ...overrides,
  };
}

/**
 * A one-record experiment, the shape `test/behavior-evaluators.test.mjs` uses
 * for its own allowlist canary: the persistence boundary is per-record, so one
 * record proves it and fifteen only make the failure slower to read.
 */
function singleRecordExperiment(attachResources) {
  const [record] = evals.createCalibrationBenchmarkPlan({
    experimentId: 'resource-evidence-persistence-v0.2',
    runsPerScenario: 3,
    metadata: benchmarkVersions,
  });
  assert.ok(record, 'the calibration plan must contain at least one record');
  const result = evals.evaluateBenchmarkRecord({
    record,
    outcome: perfectOutcomeFor(record.scenario),
  });

  return {
    record,
    experiment: {
      records: [record],
      results: [attachResources === undefined ? result : attachResources(result)],
    },
  };
}

test('declares a versioned benchmark resource schema', () => {
  const version = requireResourceSchemaVersion();

  assert.equal(
    Number.isSafeInteger(version) && version >= 1,
    true,
    'the resource schema version must be a positive whole number',
  );
  assert.equal(
    version,
    1,
    'stage B publishes resource schema version 1; bumping it is a decision, not a refactor',
  );
});

test('sources graph resource evidence from the executed control block and the trials it produced', async () => {
  const { experiment, recorded, observed } = await getGraphResourceExperiment();

  assert.equal(experiment.results.length, 24);
  assert.equal(observed.size, 24);
  assert.deepEqual(
    [...new Set([...observed.values()].map((spend) => JSON.stringify(spend)))],
    [JSON.stringify({
      logicalIterationsUsed: probeSpend.logicalIterations,
      declaredLlmCallsUsed: probeSpend.declaredLlmCalls,
      toolCallsUsed: probeSpend.toolCalls,
      resumeCount: 0,
    })],
    'the probe fixture must really spend what it claims, or the rest of this test proves nothing',
  );

  assert.equal(
    experiment.results.every((result) => Object.hasOwn(result, 'resources')),
    true,
    'a graph-backed evaluation must carry the resource evidence it measured',
  );

  const version = requireResourceSchemaVersion();
  for (const result of experiment.results) {
    assert.deepEqual(
      Object.keys(result.resources).sort(),
      resourceFieldNames,
      'every resource dimension is its own field, and there are no others',
    );
    assert.deepEqual(
      {
        logicalIterationsUsed: result.resources.logicalIterationsUsed,
        declaredLlmCallsUsed: result.resources.declaredLlmCallsUsed,
        toolCallsUsed: result.resources.toolCallsUsed,
        resumeCount: result.resources.resumeCount,
      },
      observed.get(result.runId),
      'each counter must be the value the executed graph reached, not a constant',
    );
    assert.equal(result.resources.schemaVersion, version);
  }

  assert.equal(recorded.length, 24);
  assert.deepEqual(
    recorded.map(({ result }) => result.resources),
    experiment.results.map(({ resources }) => resources),
    'the evidence handed to recordEvaluation must be the evidence the experiment publishes',
  );
});

test('measures wall-clock duration around the investigation rather than reporting a constant', async () => {
  const { experiment } = await getGraphResourceExperiment();

  for (const result of experiment.results) {
    const duration = result.resources?.wallClockDurationMs;
    assert.equal(
      Number.isFinite(duration),
      true,
      'wallClockDurationMs must be a measured number',
    );
    assert.equal(
      duration >= probeSpend.investigationSleepMs - 5,
      true,
      `a run that slept ${probeSpend.investigationSleepMs}ms cannot report ${String(duration)}ms`,
    );
  }
});

test('reports retryCount as a structural zero because no producer raises a trial attempt', async () => {
  const { experiment } = await getGraphResourceExperiment();

  for (const result of experiment.results) {
    assert.equal(
      result.resources?.retryCount,
      0,
      'no retry mechanism exists, so the retry count is zero by construction and says so',
    );
  }
});

test('publishes no resource evidence for an opaque investigate callback, even when the callback reports some', async () => {
  const runBenchmarkExperiment = requireFunction(
    evals,
    'runBenchmarkExperiment',
    '@aic/evals',
  );
  const scenariosById = new Map(
    evals.REPLAY_SCENARIOS.map((scenario) => [scenario.id, scenario]),
  );
  const canary = 'unverified-resource-evidence-must-not-be-published';
  const recorded = [];

  const experiment = await runBenchmarkExperiment({
    experimentId: 'resource-evidence-generic-v0.2',
    scenarioSet: 'calibration',
    runsPerScenario: 3,
    metadata: benchmarkVersions,
    async investigate(input) {
      const scenario = scenariosById.get(input.scenarioId);
      assert.ok(scenario, `missing execution scenario: ${input.scenarioId}`);
      return {
        ...perfectOutcomeFor(scenario),
        resources: { ...measuredResources(), selfReported: canary },
      };
    },
    async recordEvaluation(payload) {
      recorded.push(payload);
    },
  });

  assert.equal(experiment.results.length, 24);
  for (const result of experiment.results) {
    assert.equal(
      Object.hasOwn(result, 'resources'),
      false,
      'resource evidence from an opaque callback is unverified, so the generic path publishes none',
    );
  }
  assert.equal(recorded.length, 24);
  assert.equal(
    recorded.some(({ result }) => Object.hasOwn(result, 'resources')),
    false,
    'recordEvaluation must not receive resource evidence the runner could not verify',
  );
  assert.equal(
    JSON.stringify(experiment.results).includes(canary),
    false,
    'a self-reported resource figure must not survive anywhere in the published results',
  );
});

test('refuses resource evidence at an unknown schema version before any run is created', async () => {
  const capture = capturingClient();
  const { experiment } = singleRecordExperiment((result) => ({
    ...result,
    resources: measuredResources({ schemaVersion: 9999 }),
  }));

  await assert.rejects(
    () => observability.persistBenchmarkExperiment({
      client: capture.client,
      datasetName: 'resource-evidence-unknown-version-v0.2',
      experiment,
    }),
    /resource schema version/i,
    'an unreadable resource schema version must be refused, not published',
  );
  assert.equal(capture.runs.length, 0);
});

for (const field of resourceFieldNames) {
  test(`refuses resource evidence missing ${field} before any run is created`, async () => {
    requireResourceSchemaVersion();
    const capture = capturingClient();
    const { experiment } = singleRecordExperiment((result) => {
      const { [field]: _omitted, ...partial } = measuredResources();
      return { ...result, resources: partial };
    });

    await assert.rejects(
      () => observability.persistBenchmarkExperiment({
        client: capture.client,
        datasetName: `resource-evidence-missing-${field}-v0.2`,
        experiment,
      }),
      new RegExp(`resource[a-z ]*${field}|${field}[a-z ]*resource`, 'i'),
      `partial resource evidence must be refused by name, not silently dropped: ${field}`,
    );
    assert.equal(capture.runs.length, 0);
  });
}

test('projects resource evidence through an exact outbound allowlist, one key per dimension', async () => {
  const version = requireResourceSchemaVersion();
  const canary = 'must-not-cross-the-sdk-boundary';
  const capture = capturingClient();
  const resources = measuredResources();
  const { experiment } = singleRecordExperiment((result) => ({
    ...result,
    resources: { ...resources, undeclaredResourceAxis: canary },
  }));

  await observability.persistBenchmarkExperiment({
    client: capture.client,
    datasetName: 'resource-evidence-allowlist-v0.2',
    experiment,
  });

  assert.equal(capture.runs.length, 1);
  const [run] = capture.runs;
  assert.deepEqual(
    Object.keys(run.outputs).sort(),
    ['actualStopKind', 'behaviorMetrics', 'metrics', 'resources'],
    'resource evidence is its own output, never merged into the quality metrics',
  );
  assert.deepEqual(
    Object.keys(run.outputs.resources).sort(),
    resourceFieldNames,
    'every declared dimension crosses as its own key, and nothing else does',
  );
  assert.deepEqual(run.outputs.resources, { ...resources, schemaVersion: version });
  assert.equal(
    JSON.stringify([capture.runs, capture.feedback]).includes(canary),
    false,
    'an undeclared resource property must never cross any LangSmith SDK call',
  );
  assert.equal(
    capture.feedback.some(({ key }) => resourceFieldNames.includes(key)),
    false,
    'resource evidence is not a score, so it must not enter the metric feedback stream',
  );
});

test('accepts a persisted v0.1 evaluation that carries no resource evidence at all', async () => {
  const capture = capturingClient();
  const { experiment } = singleRecordExperiment();

  await observability.persistBenchmarkExperiment({
    client: capture.client,
    datasetName: 'resource-evidence-absent-v0.1',
    experiment,
  });

  assert.equal(capture.runs.length, 1);
  const [run] = capture.runs;
  assert.deepEqual(
    Object.keys(run.outputs).sort(),
    ['actualStopKind', 'behaviorMetrics', 'metrics'],
    'a record written before resource evidence existed stays readable and gains no empty placeholder',
  );
});
