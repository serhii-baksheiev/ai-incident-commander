/**
 * Stage B of AIC-63: the benchmark reports what a run COST, on its own axes.
 *
 * Three settled decisions this file encodes rather than re-litigates:
 *   - `retryCount` is MEASURED off the executed trials, never written as a
 *     literal: it is how many trials the graph left past their first attempt.
 *     Every in-repo producer writes `attempt: 1` today, so the published figure
 *     is zero — but it must be zero because nothing was counted, not because a
 *     constant was typed. A fixture that DOES raise an attempt is below, and it
 *     is what separates the two.
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
 * The axes a run actually SPENDS: every declared dimension except the schema
 * version, which describes the shape of the evidence rather than a figure any
 * run paid. Read by the feedback assertions so the two lists cannot drift.
 */
const measuredResourceAxisNames = resourceFieldNames.filter(
  (name) => name !== 'schemaVersion',
);

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
    // Every trial here is on its first attempt, so a retry count MEASURED off
    // these trials is honestly zero. The retry fixture further down raises the
    // attempt, and an implementation that writes the zero rather than counting
    // it passes this fixture and fails that one.
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

/**
 * The attempts the retry probe's trials carry, and what a truthful count of
 * them is. Three first attempts and two later ones: zero is wrong, and so is
 * "one per trial", so an implementation cannot pass this by writing either.
 */
const retryProbeAttempts = Object.freeze([1, 1, 1, 2, 3]);
const expectedRetryCount = retryProbeAttempts.filter(
  (attempt) => attempt > 1,
).length;

function retryProbeTrials(runId) {
  return retryProbeAttempts.map((attempt, index) => ({
    id: `retry-probe-trial-${runId}-${index + 1}`,
    runId,
    testId: `retry-probe-test-${runId}-${index + 1}`,
    attempt,
    tool: 'replay:logs',
    input: { probe: index + 1 },
    status: attempt === 1 ? 'ok' : 'error',
    durationMs: 1,
    evidenceIds: [],
  }));
}

/**
 * The calibration probe above, with one difference that is the whole point: its
 * trials do not all sit on their first attempt. Its other axes are given values
 * shared with nothing else here (one iteration, seven declared llm calls, five
 * trials), so a counter reported for the wrong axis is visible.
 */
function retryProbeNodes(input, observed) {
  const leaderId = `retry-probe-leader-${input.runId}`;
  const empty = async () => ({});

  return {
    normalize_incident: empty,
    collect_baseline: empty,
    generate_hypotheses: async () => ({
      hypotheses: [{
        id: leaderId,
        statement: 'retry probe leader',
        createdBy: 'initial',
      }],
      declaredLlmCalls: 7,
    }),
    derive_predictions: empty,
    plan_investigation: empty,
    execute_investigation: async () => ({ trials: retryProbeTrials(input.runId) }),
    evaluate_predictions: empty,
    interpret_residual_evidence: empty,
    derive_hypothesis_state: empty,
    async termination_check() {
      return { route: 'terminal', stopKind: 'stalled' };
    },
    async challenge_hypothesis() {
      throw new Error('challenge must not run in the retry probe fixture');
    },
    // The independent observation again: what the executed state really holds,
    // read by something other than the publisher.
    async propose_conclusion(state) {
      observed.set(input.runId, {
        trialCount: state.trials.length,
        trialsPastFirstAttempt: state.trials.filter(
          ({ attempt }) => attempt > 1,
        ).length,
      });
      return { conclusion: { kind: 'inconclusive', causes: [] } };
    },
  };
}

let retryGraphExperiment;

/**
 * The retry probe's own graph-backed run of the calibration partition, memoised
 * for cost exactly as the probe above is. It runs the declared partition rather
 * than a hand-picked scenario list, so nothing here restates the hold-out
 * boundary.
 */
function getRetryGraphExperiment() {
  if (retryGraphExperiment !== undefined) return retryGraphExperiment;

  retryGraphExperiment = (async () => {
    const runGraphBenchmarkExperiment = requireFunction(
      evals,
      'runGraphBenchmarkExperiment',
      '@aic/evals',
    );
    const observed = new Map();
    const experiment = await runGraphBenchmarkExperiment({
      experimentId: 'resource-evidence-retry-v0.2',
      scenarioSet: 'calibration',
      runsPerScenario: 3,
      metadata: benchmarkVersions,
      createNodes: (input) => retryProbeNodes(input, observed),
      async recordEvaluation() {},
    });
    return { experiment, observed };
  })();

  return retryGraphExperiment;
}

/**
 * Plants one own property on `Object.prototype` for the duration of `body`, and
 * takes it off again whatever happens. The planted value is what an evidence
 * object that never declared the field appears to carry to anything that reads
 * it through the prototype chain.
 */
async function withPollutedObjectPrototype(key, value, body) {
  Object.defineProperty(Object.prototype, key, {
    configurable: true,
    enumerable: false,
    value,
    writable: true,
  });
  try {
    return await body();
  } finally {
    delete Object.prototype[key];
  }
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

test('publishes a retry count of zero when every trial is on its first attempt', async () => {
  const { experiment } = await getGraphResourceExperiment();

  for (const result of experiment.results) {
    assert.equal(
      result.resources?.retryCount,
      0,
      'a run whose trials never left their first attempt spent no retries, and says so',
    );
  }
});

test('counts the trials past their first attempt rather than publishing a constant retry count', async () => {
  const { experiment, observed } = await getRetryGraphExperiment();

  assert.equal(experiment.results.length, 24);
  assert.equal(observed.size, 24);
  assert.deepEqual(
    [...new Set([...observed.values()].map((spend) => JSON.stringify(spend)))],
    [JSON.stringify({
      trialCount: retryProbeAttempts.length,
      trialsPastFirstAttempt: expectedRetryCount,
    })],
    'the retry fixture must really produce the attempts it claims, or the rest of this test proves nothing',
  );
  assert.equal(
    expectedRetryCount !== 0 &&
      expectedRetryCount !== retryProbeAttempts.length,
    true,
    'the fixture only discriminates while a retry count of zero AND a retry count of every trial are both wrong',
  );

  for (const result of experiment.results) {
    assert.equal(
      result.resources?.retryCount,
      expectedRetryCount,
      'retryCount must be the number of trials past their first attempt, read off the executed state',
    );
    assert.equal(
      result.resources.toolCallsUsed,
      retryProbeAttempts.length,
      'the retry count and the tool count are separate axes and must not be the same number',
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

/**
 * A field the evidence never declared, planted where a prototype-chain read
 * would find it. `schemaVersion` is planted at the version this layer accepts,
 * because planting an unsupported one would be refused for the wrong reason and
 * prove nothing.
 */
for (const field of resourceFieldNames) {
  test(`refuses resource evidence whose ${field} exists only on Object.prototype`, async () => {
    const version = requireResourceSchemaVersion();
    const capture = capturingClient();
    const { experiment } = singleRecordExperiment((result) => {
      const { [field]: _omitted, ...partial } = measuredResources();
      return { ...result, resources: partial };
    });

    await withPollutedObjectPrototype(
      field,
      field === 'schemaVersion' ? version : 999,
      () => assert.rejects(
        () => observability.persistBenchmarkExperiment({
          client: capture.client,
          datasetName: `resource-evidence-inherited-${field}-v0.2`,
          experiment,
        }),
        new RegExp(`resource.*${field}|${field}.*resource`, 'i'),
        `an inherited property is not evidence: a ${field} the run never declared must still be refused by name`,
      ),
    );

    assert.equal(
      Object.hasOwn(Object.prototype, field),
      false,
      'the planted property must not outlive the test that planted it',
    );
    assert.equal(capture.runs.length, 0);
  });
}

test('publishes its own resource values while Object.prototype carries decoys', async () => {
  const version = requireResourceSchemaVersion();
  const capture = capturingClient();
  const resources = measuredResources();
  const { experiment } = singleRecordExperiment((result) => ({
    ...result,
    resources,
  }));

  await withPollutedObjectPrototype('resumeCount', 999, () =>
    withPollutedObjectPrototype('toolCallsUsed', 999, () =>
      observability.persistBenchmarkExperiment({
        client: capture.client,
        datasetName: 'resource-evidence-own-values-v0.2',
        experiment,
      })));

  assert.equal(Object.hasOwn(Object.prototype, 'resumeCount'), false);
  assert.equal(Object.hasOwn(Object.prototype, 'toolCallsUsed'), false);
  assert.equal(capture.runs.length, 1);
  assert.deepEqual(
    capture.runs[0].outputs.resources,
    { ...resources, schemaVersion: version },
    'refusing an inherited field must not stop a run from publishing the fields it does own',
  );
});

/**
 * The graph refuses these values where the counters are produced; the outbound
 * projection is a second reader of the same numbers and must refuse them too,
 * or the boundary publishes a figure the producer would not have written.
 */
for (const [label, value] of [
  ['a negative', -5],
  ['a fractional', 1.7],
  ['an unsafe-integer', 9007199254741000],
]) {
  test(`refuses ${label} resource count before any run is created`, async () => {
    requireResourceSchemaVersion();

    for (const field of measuredResourceAxisNames) {
      const capture = capturingClient();
      const { experiment } = singleRecordExperiment((result) => ({
        ...result,
        resources: measuredResources({ [field]: value }),
      }));

      await assert.rejects(
        () => observability.persistBenchmarkExperiment({
          client: capture.client,
          datasetName: `resource-evidence-${label.replace(/\s+/g, '-')}-${field}-v0.2`,
          experiment,
        }),
        new RegExp(`resource.*${field}|${field}.*resource`, 'i'),
        `every resource axis is a non-negative safe integer, and ${String(value)} is not one: ${field}`,
      );
      assert.equal(capture.runs.length, 0, `a refused ${field} must create no run`);
    }
  });
}

test('refuses a null resources field by name instead of dereferencing it', async () => {
  const capture = capturingClient();
  const { experiment } = singleRecordExperiment((result) => ({
    ...result,
    resources: null,
  }));

  await assert.rejects(
    () => observability.persistBenchmarkExperiment({
      client: capture.client,
      datasetName: 'resource-evidence-null-v0.2',
      experiment,
    }),
    (error) => {
      assert.equal(
        error instanceof TypeError,
        false,
        `declared-but-null resource evidence must be refused, not read through: ${error.message}`,
      );
      assert.match(
        error.message,
        /resource/i,
        'the refusal must name what it refused',
      );
      return true;
    },
  );
  assert.equal(capture.runs.length, 0);
});

/**
 * A characterisation PIN, not a requirement: `resumeCount` can only rise on the
 * graph's human-review resume path, and the benchmark declares `humanReview`
 * false on every record, so the axis is a structural zero for the whole
 * benchmark. It is pinned so that stops being invisible — a change that makes
 * the axis reachable turns this red and asks for a decision.
 */
test('pins resumeCount at zero for every benchmark run, because the benchmark never enables human review', async () => {
  const { experiment } = await getGraphResourceExperiment();

  assert.equal(
    experiment.records.every(({ metadata }) => metadata.humanReview === false),
    true,
    'the benchmark declares humanReview false, so the resume path is unreachable from it',
  );
  for (const result of experiment.results) {
    assert.equal(
      result.resources?.resumeCount,
      0,
      'no benchmark run can resume, so every published resume count is zero',
    );
  }
});

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
  // REWRITTEN pin. The previous assertion here required resource keys to stay
  // OUT of the feedback stream, which narrowed AIC-63 ("separate LangSmith
  // feedback/output keys ... preserve every individual quality and resource
  // dimension") to outputs alone — a narrowing nobody ruled on. Every axis is
  // its own feedback entry; nothing is blended into a composite.
  const [publishedResult] = experiment.results;
  const qualityFeedback = [
    ...Object.values(publishedResult.metrics),
    ...Object.values(publishedResult.behaviorMetrics ?? {}),
  ];
  const feedbackByKey = new Map();
  for (const entry of capture.feedback) {
    assert.equal(
      feedbackByKey.has(entry.key),
      false,
      `each dimension is published once, under its own key: ${entry.key}`,
    );
    feedbackByKey.set(entry.key, entry);
  }

  assert.deepEqual(
    [...feedbackByKey.keys()].sort(),
    [
      ...qualityFeedback.map(({ key }) => key),
      ...measuredResourceAxisNames,
    ].sort(),
    'every quality metric and every measured resource axis is its own feedback key, and no key merges dimensions',
  );
  for (const metric of qualityFeedback) {
    assert.equal(
      feedbackByKey.get(metric.key).score,
      metric.score,
      `the quality feedback must be unchanged by resource publication: ${metric.key}`,
    );
  }
  for (const axis of measuredResourceAxisNames) {
    assert.equal(
      feedbackByKey.get(axis).score,
      resources[axis],
      `${axis} must cross as the value that was measured, not a normalised score`,
    );
    assert.equal(
      feedbackByKey.get(axis).sessionId,
      capture.feedback[0].sessionId,
      `${axis} feedback belongs to the same project session as the quality feedback`,
    );
  }
  assert.equal(
    feedbackByKey.has('schemaVersion'),
    false,
    'schemaVersion describes the shape of the evidence and is not an axis anything spent',
  );
  assert.equal(
    feedbackByKey.has('resources'),
    false,
    'a single resources key would be the composite this design refuses',
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
  assert.equal(
    capture.feedback.some(({ key }) => measuredResourceAxisNames.includes(key)),
    false,
    'an unmeasured run publishes no resource feedback: a key carrying undefined would read as a measurement',
  );
  assert.equal(
    capture.feedback.length > 0,
    true,
    'the quality feedback a v0.1 record has always produced is unaffected',
  );
});
