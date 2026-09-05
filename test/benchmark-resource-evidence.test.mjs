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
  capturingClient,
  perfectOutcomeFor,
  requireFunction,
  singleRecordExperiment,
} from './fixtures/benchmark-experiment.mjs';
import {
  withAccessorPollutedObjectPrototype,
  withPollutedObjectPrototype,
} from './fixtures/prototype-decoy.mjs';

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

test('declares a versioned benchmark resource schema', () => {
  const version = requireResourceSchemaVersion();

  assert.equal(
    Number.isSafeInteger(version) && version >= 1,
    true,
    'the resource schema version must be a positive whole number',
  );
  assert.equal(
    version,
    2,
    'bumping the resource schema version is a decision, not a refactor: version 2 is AIC-94 adding the two optional token axes, and a reader at version 1 refuses a record carrying them',
  );
});

/**
 * The optional token axes AIC-94 added, and the two properties that make them
 * safe to add without breaking the deterministic path.
 *
 * They are OPTIONAL because a run with no model has nothing to declare, and a
 * published zero would be a measured-zero claim rather than an absent
 * measurement — the reading every other axis in this file exists to refuse.
 * Present-and-malformed is still refused, so "optional" buys absence and not
 * looseness.
 */
test('publishes a token axis only when the record declared one', async () => {
  const version = requireResourceSchemaVersion();
  const withoutTokens = capturingClient();
  const { experiment: scriptedExperiment } = singleRecordExperiment((result) => ({
    ...result,
    resources: measuredResources(),
  }));

  await observability.persistBenchmarkExperiment({
    client: withoutTokens.client,
    datasetName: 'resource-evidence-no-token-axis-v0.2',
    experiment: scriptedExperiment,
  });

  const [scriptedRun] = withoutTokens.runs;
  assert.deepEqual(
    Object.keys(scriptedRun.outputs.resources).sort(),
    resourceFieldNames,
    'a run with no model must publish no token axis at all, not a zero',
  );
  assert.equal(
    withoutTokens.feedback.some(({ key }) => key.endsWith('TokensUsed')),
    false,
    'an unmeasured axis must not reach the score stream either',
  );

  const withTokens = capturingClient();
  const { experiment: modelExperiment } = singleRecordExperiment((result) => ({
    ...result,
    resources: measuredResources({ inputTokensUsed: 1234, outputTokensUsed: 56 }),
  }));

  await observability.persistBenchmarkExperiment({
    client: withTokens.client,
    datasetName: 'resource-evidence-token-axis-v0.2',
    experiment: modelExperiment,
  });

  const [modelRun] = withTokens.runs;
  assert.deepEqual(
    Object.keys(modelRun.outputs.resources).sort(),
    [...resourceFieldNames, 'inputTokensUsed', 'outputTokensUsed'].sort(),
  );
  assert.equal(modelRun.outputs.resources.inputTokensUsed, 1234);
  assert.equal(modelRun.outputs.resources.outputTokensUsed, 56);
  assert.equal(modelRun.outputs.resources.schemaVersion, version);
  assert.deepEqual(
    withTokens.feedback
      .filter(({ key }) => key.endsWith('TokensUsed'))
      .map(({ key, score }) => [key, score])
      .sort(),
    [['inputTokensUsed', 1234], ['outputTokensUsed', 56]],
    'each token axis is its own feedback key: nothing is blended into a composite',
  );
});

for (const field of ['inputTokensUsed', 'outputTokensUsed']) {
  test(`refuses a token axis that is present and is not a count: ${field}`, async () => {
    const capture = capturingClient();
    const { experiment } = singleRecordExperiment((result) => ({
      ...result,
      resources: measuredResources({ [field]: -1 }),
    }));

    await assert.rejects(
      () => observability.persistBenchmarkExperiment({
        client: capture.client,
        datasetName: `resource-evidence-token-axis-refusal-${field}-v0.2`,
        experiment,
      }),
      new RegExp(`${field} is not a count`),
      'an optional axis is allowed to be absent, never allowed to be wrong',
    );
    // The same guarantee its sibling above asserts — › "refuses resource
    // evidence at an unknown schema version before any run is created": this
    // layer validates the whole experiment before it creates any RUN, while the
    // dataset and project are created first. Asserting on `runs` rather than on
    // `calls` states the guarantee the layer actually gives.
    assert.equal(capture.runs.length, 0, 'no run may be created before the refusal');
  });
}

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
 * The write side of the same hazard, which the data decoy above cannot reach.
 *
 * The projection this layer publishes is built key by key onto a plain object.
 * Every such write is an ordinary `[[Set]]`, so an inherited ACCESSOR named
 * like an axis swallows it: the setter runs, no own property is created, and
 * the axis is simply gone from `outputs.resources` — which downstream reads as
 * "this run spent nothing on that axis", the one reading the module's own
 * header says must never be manufactured. The feedback stream then reads the
 * same key back out and publishes the inherited GETTER's number, so a figure no
 * run measured crosses the SDK boundary as evidence.
 *
 * One test per axis, so a fix that special-cases a single field does not pass.
 */
const ACCESSOR_DECOY_VALUE = 999;

for (const axis of measuredResourceAxisNames) {
  test(`publishes its own measured ${axis} while Object.prototype carries an accessor of that name`, async () => {
    const version = requireResourceSchemaVersion();
    const capture = capturingClient();
    const resources = measuredResources();
    const swallowed = [];
    const { experiment } = singleRecordExperiment((result) => ({
      ...result,
      resources,
    }));

    assert.notEqual(
      resources[axis],
      ACCESSOR_DECOY_VALUE,
      `the decoy only discriminates while it differs from the measured value: ${axis}`,
    );

    await withAccessorPollutedObjectPrototype(
      axis,
      ACCESSOR_DECOY_VALUE,
      swallowed,
      () => observability.persistBenchmarkExperiment({
        client: capture.client,
        datasetName: `resource-evidence-accessor-${axis}-v0.2`,
        experiment,
      }),
    );

    assert.equal(
      Object.hasOwn(Object.prototype, axis),
      false,
      'the planted accessor must not outlive the test that planted it',
    );
    assert.equal(capture.runs.length, 1);
    const [run] = capture.runs;

    assert.equal(
      Object.hasOwn(run.outputs.resources, axis),
      true,
      `an inherited setter must not swallow ${axis}: an axis missing from outputs.resources reads as a run that spent nothing on it (the prototype setter received ${JSON.stringify(swallowed)})`,
    );
    assert.deepEqual(
      run.outputs.resources,
      { ...resources, schemaVersion: version },
      `every declared axis must cross with the value this run measured, whatever Object.prototype carries: ${axis}`,
    );

    const entry = capture.feedback.find(({ key }) => key === axis);
    assert.ok(entry, `${axis} must still be published as its own feedback key`);
    assert.equal(
      entry.score,
      resources[axis],
      `${axis} feedback must carry the measured value, never a number read back off an inherited getter`,
    );
  });
}

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

/**
 * The same write-side hazard, one function over.
 *
 * `requireBehaviorMetrics` builds its projection the same way the resource one
 * did, so an inherited accessor named like a behavior metric swallows that
 * write too — and a behavior metric is a QUALITY score, so what goes missing (or
 * what an inherited getter supplies in its place) is a claim about how well the
 * investigation did, not how much it spent.
 *
 * This exists because the resource fix was pinned by six tests while the
 * identical fix beside it was pinned by none: reverting it left the suite green,
 * which is a guard nobody would notice losing.
 */
test('publishes its own behavior metric while Object.prototype carries an accessor of that name', async () => {
  const metricKey = 'challenge_effect';
  const capture = capturingClient();
  const swallowed = [];
  const { experiment } = singleRecordExperiment((result) => ({
    ...result,
    behaviorMetrics: {
      [metricKey]: {
        evaluatorVersion: benchmarkVersions.evaluatorVersion,
        key: metricKey,
        score: 1,
        reason: 'passed',
      },
    },
  }));

  await withAccessorPollutedObjectPrototype(
    metricKey,
    { key: metricKey, score: 0, reason: 'incorrect-outcome', evaluatorVersion: 'decoy' },
    swallowed,
    () => observability.persistBenchmarkExperiment({
      client: capture.client,
      datasetName: 'behavior-metric-accessor-v0.2',
      experiment,
    }),
  );

  assert.equal(
    Object.hasOwn(Object.prototype, metricKey),
    false,
    'the planted accessor must not outlive the test that planted it',
  );
  assert.equal(capture.runs.length, 1);
  const [run] = capture.runs;

  assert.equal(
    Object.hasOwn(run.outputs.behaviorMetrics, metricKey),
    true,
    `an inherited setter must not swallow ${metricKey}: a quality score missing from the published record reads as a metric the evaluator never produced (the prototype setter received ${JSON.stringify(swallowed)})`,
  );
  assert.equal(
    run.outputs.behaviorMetrics[metricKey].score,
    1,
    'the published score must be the one this run produced, not the decoy the prototype supplies',
  );
  assert.equal(
    run.outputs.behaviorMetrics[metricKey].reason,
    'passed',
    'the published reason must be the one this run produced',
  );
});
