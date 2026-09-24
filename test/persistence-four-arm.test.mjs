/**
 * AIC-117 slice c, sections 1-3 of the contract
 * (`.claude/runs/20260924-v02-evidence-repair/aic117c-spec.md`): what the
 * four-arm lane's own measurements add to a published evaluation, and one
 * axis the reference provider forbids.
 *
 * Three shapes, each pinned independently of the others:
 *   - `claimCount` on the `unsupported_claim_rate` metric (spec section 1);
 *   - `notApplicable` at the top of a published evaluation (spec section 2);
 *   - `temperature` moving from a required run-metadata field to an optional
 *     one, because the reference provider rejects it (spec section 3).
 *
 * `capturingClient` and `singleRecordExperiment` are the shared fixtures every
 * sibling persistence test file uses — see `test/persist-boundary-refusals.test.mjs`
 * and `test/benchmark-resource-evidence.test.mjs` for the same pattern: a
 * field is forged onto an already-evaluated result (`singleRecordExperiment`'s
 * transform argument) to exercise the OBSERVABILITY layer's own validation,
 * independent of whatever `@aic/evals` would have produced on its own.
 *
 * ## Isolation
 *
 * Every call below passes its own client, so the real LangSmith client is
 * never constructed. `globalThis.fetch` is replaced for the whole file with a
 * tripwire anyway, on the same reasoning as the sibling persistence files:
 * `langsmith` resolves the global at call time and `node --test` gives this
 * file its own process, so an attempted request fails the test that made it
 * rather than reaching a workspace.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import test, { afterEach } from 'node:test';
import { fileURLToPath } from 'node:url';

import * as evals from '@aic/evals';
import * as observability from '@aic/observability';

import {
  benchmarkVersions,
  behaviorPerfectOutcomeFor,
  capturingClient,
  perfectOutcomeFor,
  singleRecordExperiment,
} from './fixtures/benchmark-experiment.mjs';

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** Every outbound attempt made by anything in this file. Must stay empty. */
const outboundAttempts = [];

globalThis.fetch = async (input, init) => {
  const target = typeof input === 'string' ? input : String(input?.url ?? input);
  outboundAttempts.push(`${init?.method ?? 'GET'} ${target}`);
  throw new Error('this test attempted an outbound call');
};

afterEach(() => {
  const attempted = outboundAttempts.splice(0, outboundAttempts.length);
  assert.deepEqual(
    attempted,
    [],
    'no test in this file may reach the network: every row passes its own client, so a request here means the real one was constructed',
  );
});

let datasetCounter = 0;
/** A fresh, readable dataset name per call, so no two rows share a fixture identity. */
function uniqueDatasetName(label) {
  datasetCounter += 1;
  return `persistence-four-arm-${label}-${datasetCounter}-v0.2`;
}

// ---------------------------------------------------------------------------
// Section 1 — claimCount on unsupported_claim_rate
// ---------------------------------------------------------------------------

function withClaimRateOverride(mutateClaimRate) {
  return singleRecordExperiment((result) => ({
    ...result,
    metrics: {
      ...result.metrics,
      unsupported_claim_rate: mutateClaimRate(result.metrics.unsupported_claim_rate),
    },
  }));
}

test('publishes claimCount on unsupported_claim_rate when the evaluation owns a non-negative safe integer one', async () => {
  const capture = capturingClient();
  const { experiment } = withClaimRateOverride((metric) => ({ ...metric, claimCount: 7 }));

  await observability.persistBenchmarkExperiment({
    client: capture.client,
    datasetName: uniqueDatasetName('claim-count-published'),
    experiment,
  });

  const [run] = capture.runs;
  assert.equal(
    run.outputs.metrics.unsupported_claim_rate.claimCount,
    7,
    'the published claimCount must equal the one the evaluation owns',
  );
});

test('omits claimCount from unsupported_claim_rate when the evaluation owns none', async () => {
  const capture = capturingClient();
  const { experiment } = withClaimRateOverride((metric) => {
    const { claimCount, ...withoutClaimCount } = metric;
    return withoutClaimCount;
  });

  await observability.persistBenchmarkExperiment({
    client: capture.client,
    datasetName: uniqueDatasetName('claim-count-absent'),
    experiment,
  });

  const [run] = capture.runs;
  assert.equal(
    Object.hasOwn(run.outputs.metrics.unsupported_claim_rate, 'claimCount'),
    false,
    'an absent claimCount must not be published as a key at all, not as an undefined one',
  );
  assert.deepEqual(
    Object.keys(run.outputs.metrics.unsupported_claim_rate).sort(),
    ['key', 'score'],
  );
});

for (const claimCount of [-1, 1.5, '3']) {
  test(`refuses unsupported_claim_rate when claimCount is present and malformed: ${JSON.stringify(claimCount)}`, async () => {
    const capture = capturingClient();
    const { experiment } = withClaimRateOverride((metric) => ({ ...metric, claimCount }));

    await assert.rejects(
      () => observability.persistBenchmarkExperiment({
        client: capture.client,
        datasetName: uniqueDatasetName('claim-count-malformed'),
        experiment,
      }),
      /unsupported_claim_rate|claimCount/,
      'a present-but-wrong claimCount must be refused by name, never silently dropped or published as-is',
    );
    assert.equal(capture.runs.length, 0, 'no run may be created before the refusal');
  });
}

test('publishes evidence_coverage and termination_correctness as key/score only, never claimCount', async () => {
  const capture = capturingClient();
  const { experiment } = singleRecordExperiment();

  await observability.persistBenchmarkExperiment({
    client: capture.client,
    datasetName: uniqueDatasetName('other-metrics-shape'),
    experiment,
  });

  const [run] = capture.runs;
  for (const key of ['evidence_coverage', 'termination_correctness']) {
    assert.deepEqual(
      Object.keys(run.outputs.metrics[key]).sort(),
      ['key', 'score'],
      `${key} carries no claimCount: only unsupported_claim_rate does`,
    );
  }
});

// ---------------------------------------------------------------------------
// Section 2 — notApplicable
// ---------------------------------------------------------------------------

/**
 * A record for a scenario whose ground truth makes `misleading_evidence_handling`
 * eligible: `dependency-caused-incident-b` declares both a `rootCause` and
 * `misleadingEvidence` (`packages/evals/src/replay-scenarios.ts`), so
 * `evaluateBenchmarkRecord` computes that metric unless `notApplicable` skips
 * it. `bad-deployment` — the record `singleRecordExperiment` defaults to and
 * every sibling resource-evidence test uses — declares no misleadingEvidence,
 * so a notApplicable-skips-it row built on it would be vacuous: the metric
 * would be absent from `behaviorMetrics` either way.
 */
function dependencyIncidentRecord() {
  const records = evals.createCalibrationBenchmarkPlan({
    experimentId: 'persistence-four-arm-not-applicable-v0.2',
    runsPerScenario: 3,
    metadata: benchmarkVersions,
  });
  const record = records.find(({ scenario }) => scenario.id === 'dependency-caused-incident-b');
  assert.ok(record, 'the calibration plan must contain dependency-caused-incident-b');
  return record;
}

test('evaluateBenchmarkRecord computes misleading_evidence_handling for dependency-caused-incident-b when nothing is skipped', () => {
  // Self-checks the premise the comment above states, so a change to that
  // scenario's ground truth fails here first rather than making every row
  // below it pass for the wrong reason.
  const record = dependencyIncidentRecord();
  const result = evals.evaluateBenchmarkRecord({
    record,
    outcome: behaviorPerfectOutcomeFor(record.scenario),
  });
  assert.ok(
    Object.hasOwn(result.behaviorMetrics, 'misleading_evidence_handling'),
    'dependency-caused-incident-b must be eligible for misleading_evidence_handling, or the notApplicable rows below prove nothing',
  );
});

test('publishes no notApplicable key when the evaluation carries none', async () => {
  const capture = capturingClient();
  const { experiment } = singleRecordExperiment();

  await observability.persistBenchmarkExperiment({
    client: capture.client,
    datasetName: uniqueDatasetName('not-applicable-absent'),
    experiment,
  });

  const [run] = capture.runs;
  assert.equal(Object.hasOwn(run.outputs, 'notApplicable'), false);
});

test('publishes a declared notApplicable map at outputs.notApplicable', async () => {
  const capture = capturingClient();
  const record = dependencyIncidentRecord();
  const result = evals.evaluateBenchmarkRecord({
    record,
    outcome: behaviorPerfectOutcomeFor(record.scenario),
    notApplicable: {
      misleading_evidence_handling: 'scenario has no misleading evidence to assess in this arm',
    },
  });

  await observability.persistBenchmarkExperiment({
    client: capture.client,
    datasetName: uniqueDatasetName('not-applicable-published'),
    experiment: { records: [record], results: [result] },
  });

  const [run] = capture.runs;
  assert.deepEqual(run.outputs.notApplicable, {
    misleading_evidence_handling: 'scenario has no misleading evidence to assess in this arm',
  });
});

test('a metric named in notApplicable produces no feedback row', async () => {
  const capture = capturingClient();
  const record = dependencyIncidentRecord();
  const result = evals.evaluateBenchmarkRecord({
    record,
    outcome: behaviorPerfectOutcomeFor(record.scenario),
    notApplicable: {
      misleading_evidence_handling: 'scenario has no misleading evidence to assess in this arm',
    },
  });

  await observability.persistBenchmarkExperiment({
    client: capture.client,
    datasetName: uniqueDatasetName('not-applicable-no-feedback'),
    experiment: { records: [record], results: [result] },
  });

  assert.equal(
    capture.feedback.some(({ key }) => key === 'misleading_evidence_handling'),
    false,
    'a not-applicable metric has no score, so it must never reach the feedback stream',
  );
});

test('refuses a result that both scores a behavior metric and declares it not applicable', async () => {
  const capture = capturingClient();
  const record = dependencyIncidentRecord();
  const scored = evals.evaluateBenchmarkRecord({
    record,
    outcome: behaviorPerfectOutcomeFor(record.scenario),
  });
  // Hand-built: evaluateBenchmarkRecord never produces this pair, so the
  // contradiction is forged here to pin the refusal at the publishing layer.
  const contradictory = {
    ...scored,
    notApplicable: { misleading_evidence_handling: 'declared not applicable while also scored' },
  };

  await assert.rejects(
    () => observability.persistBenchmarkExperiment({
      client: capture.client,
      datasetName: uniqueDatasetName('not-applicable-and-scored'),
      experiment: { records: [record], results: [contradictory] },
    }),
    /misleading_evidence_handling/,
    'a metric cannot be both scored and not applicable: the refusal names it',
  );
  assert.equal(capture.runs.length, 0, 'no run may be created before the refusal');
});

test('refuses notApplicable naming a key that is not a behavior metric', async () => {
  const capture = capturingClient();
  const { experiment } = singleRecordExperiment((result) => ({
    ...result,
    notApplicable: { not_a_real_metric: 'a reason' },
  }));

  await assert.rejects(
    () => observability.persistBenchmarkExperiment({
      client: capture.client,
      datasetName: uniqueDatasetName('not-applicable-unknown-key'),
      experiment,
    }),
    /not_a_real_metric/,
    'an unknown key must be refused by name',
  );
  assert.equal(capture.runs.length, 0, 'no run may be created before the refusal');
});

test('refuses notApplicable whose reason is an empty string', async () => {
  const capture = capturingClient();
  const { experiment } = singleRecordExperiment((result) => ({
    ...result,
    notApplicable: { misleading_evidence_handling: '' },
  }));

  await assert.rejects(
    () => observability.persistBenchmarkExperiment({
      client: capture.client,
      datasetName: uniqueDatasetName('not-applicable-empty-reason'),
      experiment,
    }),
    /misleading_evidence_handling/,
    'an empty reason is not a reason, and must be refused by the metric it names',
  );
  assert.equal(capture.runs.length, 0, 'no run may be created before the refusal');
});

for (const notApplicable of ['not-an-object', ['array-shaped'], null]) {
  test(`refuses a notApplicable that is not a plain object: ${JSON.stringify(notApplicable)}`, async () => {
    const capture = capturingClient();
    const { experiment } = singleRecordExperiment((result) => ({ ...result, notApplicable }));

    await assert.rejects(
      () => observability.persistBenchmarkExperiment({
        client: capture.client,
        datasetName: uniqueDatasetName('not-applicable-non-object'),
        experiment,
      }),
    );
    assert.equal(capture.runs.length, 0, 'no run may be created before the refusal');
  });
}

// ---------------------------------------------------------------------------
// Section 3 — temperature is optional
// ---------------------------------------------------------------------------

test('publishes a declared temperature, even when it is exactly zero', async () => {
  const capture = capturingClient();
  const { experiment } = singleRecordExperiment();

  await observability.persistBenchmarkExperiment({
    client: capture.client,
    datasetName: uniqueDatasetName('temperature-present'),
    experiment,
  });

  const [run] = capture.runs;
  assert.equal(Object.hasOwn(run.extra.metadata, 'temperature'), true);
  assert.equal(run.extra.metadata.temperature, 0);
});

test('publishes no temperature key when the run metadata declares none', async () => {
  const capture = capturingClient();
  const { temperature, ...metadataWithoutTemperature } = benchmarkVersions;
  const [record] = evals.createCalibrationBenchmarkPlan({
    experimentId: 'persistence-four-arm-temperature-v0.2',
    runsPerScenario: 3,
    metadata: metadataWithoutTemperature,
  });
  const result = evals.evaluateBenchmarkRecord({
    record,
    outcome: perfectOutcomeFor(record.scenario),
  });

  await observability.persistBenchmarkExperiment({
    client: capture.client,
    datasetName: uniqueDatasetName('temperature-absent'),
    experiment: { records: [record], results: [result] },
  });

  const [run] = capture.runs;
  assert.equal(
    Object.hasOwn(run.extra.metadata, 'temperature'),
    false,
    'a record that declares no temperature must publish no temperature key — not one carrying undefined',
  );
});

test('scripts/eval-live-model.mjs no longer declares a temperature field in its run metadata', () => {
  const source = readFileSync(resolve(projectRoot, 'scripts/eval-live-model.mjs'), 'utf8');
  assert.doesNotMatch(
    source,
    /\btemperature\s*:/,
    'the reference provider rejects temperature and no role sends one ' +
      '(naive-role.test.mjs › "sends no temperature field, so the naive arm samples exactly as the graph arm does"); ' +
      'this script must not declare one in its run metadata',
  );
});
