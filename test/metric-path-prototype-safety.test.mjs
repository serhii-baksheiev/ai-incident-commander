/**
 * AIC-67: every metric path publishes what the run OWNS, or refuses.
 *
 * `Object.prototype` is reachable from every plain object in the process, so a
 * plain `[[Get]]` on a metric container and a plain `[[Set]]` into a projection
 * are each a way for a claim nobody made to enter — or leave — the benchmark
 * record:
 *
 *   - a READ that walks the prototype chain publishes a score, a version or a
 *     provenance field the run never produced. The record then carries a
 *     measurement claim with nothing behind it, which is the one failure the
 *     persistence layer exists to prevent;
 *   - a WRITE that walks the prototype chain is SWALLOWED by an inherited
 *     accessor: the setter runs, no own property is created, and the field is
 *     simply gone from the published record. Downstream that reads as "this run
 *     produced nothing on that axis".
 *
 * Both decoy shapes are used, because each proves only one half. An ordinary
 * assignment SHADOWS a writable inherited data property — it creates an own
 * property and the decoy is overwritten — so the data decoy proves nothing
 * about the write side; only the accessor decoy does. And an accessor decoy's
 * getter is what a read finds, so the data decoy is the honest shape for the
 * read side.
 *
 * Two paths are deliberately NOT covered here, because no revert could turn a
 * test of them red — they were never vulnerable:
 *   - `requireMetrics` builds its projection with `Object.fromEntries`, and
 *     `requireBehaviorMetrics` with `Object.defineProperty` (the latter already
 *     pinned by `test/benchmark-resource-evidence.test.mjs` › "publishes its own
 *     behavior metric while Object.prototype carries an accessor of that name");
 *   - object-literal property definition — the `metrics:` literal in
 *     `evaluateBenchmarkRecord`, including its computed keys — is
 *     CreateDataProperty, which never consults the prototype chain.
 *     `projectRunMetadata` had such a literal too; at HEAD it builds its
 *     projection field by field instead, because the literal was safe while the
 *     VALUES it was built from were read through the chain.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import * as evals from '@aic/evals';
import * as observability from '@aic/observability';

import {
  benchmarkVersions,
  capturingClient,
  perfectOutcomeFor,
  singleRecordExperiment,
} from './fixtures/benchmark-experiment.mjs';
import {
  withAccessorPollutedObjectPrototype,
  withPollutedObjectPrototype,
} from './fixtures/prototype-decoy.mjs';

/**
 * A decoy that outlived its test would silently decide the result of every test
 * after it, in this file and in every other one sharing the process. Each test
 * therefore asserts the removal itself rather than trusting the helper's
 * `finally`.
 */
const DECOY_MUST_NOT_OUTLIVE =
  'the planted property must not outlive the test that planted it';

const QUALITY_METRIC_KEYS = [
  'unsupported_claim_rate',
  'evidence_coverage',
  'termination_correctness',
];

const BEHAVIOR_METRIC_KEY = 'challenge_effect';

function inheritedQualityMetric(key) {
  return { key, score: 1 };
}

function declaredBehaviorMetric(overrides = {}) {
  return {
    evaluatorVersion: benchmarkVersions.evaluatorVersion,
    key: BEHAVIOR_METRIC_KEY,
    score: 1,
    reason: 'passed',
    ...overrides,
  };
}

/**
 * Persists, and treats a refusal as one of two correct answers.
 *
 * When a metadata field exists only on `Object.prototype`, refusing the record
 * and publishing it without that field are both defensible; only publishing the
 * inherited value is wrong. These tests therefore assert on what crossed the
 * boundary rather than on which of the two correct answers was chosen — the
 * error is returned rather than swallowed so a diagnosis can name it.
 */
async function persistTolerantOfRefusal(client, datasetName, experiment) {
  try {
    await observability.persistBenchmarkExperiment({
      client,
      datasetName,
      experiment,
    });
    return undefined;
  } catch (error) {
    return error;
  }
}

/** The single record's experiment, with one own metadata field taken away. */
function experimentWithoutOwnMetadata(field) {
  const { experiment } = singleRecordExperiment();
  const [record] = experiment.records;
  const { [field]: omitted, ...metadata } = record.metadata;
  assert.notEqual(
    omitted,
    undefined,
    `the record must declare its own ${field}, or removing it proves nothing`,
  );
  return {
    records: [{ ...record, metadata }],
    results: experiment.results,
  };
}

/** The first calibration record for one scenario, evaluated by the caller. */
function calibrationRecordFor(scenarioId) {
  const record = evals
    .createCalibrationBenchmarkPlan({
      experimentId: 'metric-path-prototype-safety-v0.2',
      runsPerScenario: 3,
      metadata: benchmarkVersions,
    })
    .find(({ scenario }) => scenario.id === scenarioId);
  assert.ok(record, `the calibration plan must contain ${scenarioId}`);
  return record;
}

/* -------------------------------------------------------------------------- */
/* requireMetrics — the READ side                                             */
/* -------------------------------------------------------------------------- */

/**
 * The only gate on a quality metric is `metric.key !== key`, which an inherited
 * `{ key, score }` satisfies by construction. What gets past it is published
 * twice: into `outputs.metrics` and as its own `createFeedback` score.
 */
for (const key of QUALITY_METRIC_KEYS) {
  test(`refuses a quality metric that exists only on Object.prototype: ${key}`, async () => {
    const capture = capturingClient();
    const { experiment } = singleRecordExperiment((result) => {
      const { [key]: omitted, ...metrics } = result.metrics;
      assert.notEqual(omitted, undefined, `the evaluation must produce ${key}`);
      return { ...result, metrics };
    });

    await withPollutedObjectPrototype(key, inheritedQualityMetric(key), () =>
      assert.rejects(
        () => observability.persistBenchmarkExperiment({
          client: capture.client,
          datasetName: `metric-path-inherited-${key}-v0.2`,
          experiment,
        }),
        new RegExp(`missing metric: ${key}`),
        `an inherited property is not a measurement: a ${key} the run never produced must be refused by name, not published as a score`,
      ));

    assert.equal(Object.hasOwn(Object.prototype, key), false, DECOY_MUST_NOT_OUTLIVE);
    assert.equal(capture.runs.length, 0);
  });
}

test('refuses a result whose metrics container exists only on Object.prototype', async () => {
  const capture = capturingClient();
  const { experiment } = singleRecordExperiment((result) => {
    const { metrics: omitted, ...partial } = result;
    assert.notEqual(omitted, undefined, 'the evaluation must produce metrics');
    return partial;
  });
  const inherited = Object.fromEntries(
    QUALITY_METRIC_KEYS.map((key) => [key, inheritedQualityMetric(key)]),
  );

  await withPollutedObjectPrototype('metrics', inherited, () =>
    assert.rejects(
      () => observability.persistBenchmarkExperiment({
        client: capture.client,
        datasetName: 'metric-path-inherited-metrics-container-v0.2',
        experiment,
      }),
      /missing metric/,
      'a result carrying no metrics of its own must be refused: an inherited container publishes three scores in one go, all of them measurements nobody made',
    ));

  assert.equal(Object.hasOwn(Object.prototype, 'metrics'), false, DECOY_MUST_NOT_OUTLIVE);
  assert.equal(capture.runs.length, 0);
});

/**
 * The completeness half of the metadata key lists, and the reason it is a test
 * rather than a type.
 *
 * `projectRunMetadata` now walks two `as const` lists instead of a literal, and
 * the `satisfies` clauses beside them catch only a name that is not a field of
 * `PersistedBenchmarkRunMetadata`. They cannot catch the opposite: a field ADDED
 * to the metadata that neither list names is simply never published, silently,
 * and the record then describes a run configuration it did not run under. This
 * asserts the other direction against a real record.
 */
test('publishes every declared metadata field and nothing else', async () => {
  const capture = capturingClient();
  const { record, experiment } = singleRecordExperiment();

  await observability.persistBenchmarkExperiment({
    client: capture.client,
    datasetName: 'metric-path-metadata-completeness-v0.2',
    experiment,
  });

  assert.equal(capture.runs.length, 1);
  const [run] = capture.runs;
  const declared = Object.keys(record.metadata)
    .filter((field) => record.metadata[field] !== undefined)
    .sort();

  assert.ok(
    declared.length > 0,
    'the fixture record must declare metadata, or this test asserts nothing',
  );
  assert.deepEqual(
    Object.keys(run.extra.metadata).sort(),
    declared,
    'a metadata field this record declares must reach the published record: a field the projection does not name is dropped without a word, and the run then describes a configuration it did not run under',
  );
});

/* -------------------------------------------------------------------------- */
/* projectRunMetadata — the READ side                                         */
/* -------------------------------------------------------------------------- */

/**
 * Every field of the published metadata is read off `metadata` with a plain
 * `[[Get]]`, so a record that never declared one appears to declare whatever
 * `Object.prototype` carries. The decoy value differs from the value the record
 * really declares, so the assertion discriminates.
 *
 * `evaluatorVersion` is planted at the version this layer accepts on purpose:
 * an unsupported one would be refused for the wrong reason and prove nothing.
 */
const INHERITED_METADATA_DECOYS = [
  ['runId', 'inherited-run-id'],
  ['scenarioId', 'inherited-scenario-id'],
  ['graphVersion', 'inherited-graph-v9'],
  ['promptVersion', 'inherited-prompt-v9'],
  ['toolsetVersion', 'inherited-toolset-v9'],
  ['statusRulesVersion', 'inherited-status-rules-v9'],
  ['toolMode', 'live'],
  ['knowledgeSetVersion', 'inherited-knowledge-set-v9'],
  ['memoryEnabled', true],
  ['humanReview', true],
  ['temperature', 0.9],
  ['evaluatorVersion', benchmarkVersions.evaluatorVersion],
  ['seed', 99],
  ['docsAvailable', true],
];

for (const [field, decoy] of INHERITED_METADATA_DECOYS) {
  test(`never publishes run metadata whose ${field} exists only on Object.prototype`, async () => {
    const capture = capturingClient();
    const experiment = experimentWithoutOwnMetadata(field);

    await withPollutedObjectPrototype(field, decoy, () =>
      persistTolerantOfRefusal(
        capture.client,
        `metric-path-inherited-metadata-${field}-v0.2`,
        experiment,
      ));

    assert.equal(Object.hasOwn(Object.prototype, field), false, DECOY_MUST_NOT_OUTLIVE);
    assert.equal(
      capture.runs.some((run) => run.extra.metadata[field] === decoy),
      false,
      `an inherited ${field} is not something this run declared: publishing it makes the record assert a provenance nobody recorded, and every reading of the benchmark then rests on it`,
    );
  });
}

/* -------------------------------------------------------------------------- */
/* projectRunMetadata — the WRITE side                                        */
/* -------------------------------------------------------------------------- */

/**
 * The three optional fields are assigned onto the projection rather than
 * declared in its literal, and an ordinary assignment is the shape an inherited
 * accessor swallows. The field then vanishes from `extra.metadata` while the
 * outputs beside it still carry the versioned evaluator's metrics — a record
 * that claims a measurement its own metadata does not declare.
 */
const SWALLOWABLE_METADATA_WRITES = [
  ['evaluatorVersion', 'inherited-evaluator-v9'],
  ['seed', 99],
  ['docsAvailable', true],
];

for (const [field, decoy] of SWALLOWABLE_METADATA_WRITES) {
  test(`publishes its own ${field} while Object.prototype carries an accessor of that name`, async () => {
    const capture = capturingClient();
    const { record, experiment } = singleRecordExperiment();
    const declared = record.metadata[field];
    const swallowed = [];

    assert.notEqual(
      declared,
      undefined,
      `the record must declare its own ${field}, or the write under test never happens`,
    );
    assert.notEqual(
      declared,
      decoy,
      `the decoy only discriminates while it differs from the declared value: ${field}`,
    );

    await withAccessorPollutedObjectPrototype(field, decoy, swallowed, () =>
      observability.persistBenchmarkExperiment({
        client: capture.client,
        datasetName: `metric-path-metadata-accessor-${field}-v0.2`,
        experiment,
      }));

    assert.equal(Object.hasOwn(Object.prototype, field), false, DECOY_MUST_NOT_OUTLIVE);
    assert.equal(capture.runs.length, 1);
    const [run] = capture.runs;

    assert.equal(
      Object.hasOwn(run.extra.metadata, field),
      true,
      `an inherited setter must not swallow ${field}: the published metadata then omits a field the record declared, and the run reads as one that never set it (the prototype setter received ${JSON.stringify(swallowed)})`,
    );
    assert.equal(
      run.extra.metadata[field],
      declared,
      `the published ${field} must be the one this record declared, whatever Object.prototype carries`,
    );
  });
}

/* -------------------------------------------------------------------------- */
/* requireBehaviorMetrics — the READ side                                     */
/* -------------------------------------------------------------------------- */

/**
 * A behavior metric is a QUALITY claim, so a field supplied by the prototype is
 * a statement about how well the investigation did that no evaluator made. Each
 * field is validated before publication, and each validation is a plain
 * `[[Get]]` away from passing on a value the metric does not own.
 */
const INHERITED_BEHAVIOR_METRIC_FIELDS = [
  { field: 'key', decoy: BEHAVIOR_METRIC_KEY, refusal: /unknown behavior metric/ },
  {
    field: 'evaluatorVersion',
    decoy: benchmarkVersions.evaluatorVersion,
    refusal: /evaluator version mismatch/,
  },
  { field: 'score', decoy: 1, refusal: /score must be zero or one/ },
  { field: 'reason', decoy: 'passed', refusal: /reason is not declared/ },
];

for (const { field, decoy, refusal } of INHERITED_BEHAVIOR_METRIC_FIELDS) {
  test(`refuses a behavior metric whose ${field} exists only on Object.prototype`, async () => {
    const capture = capturingClient();
    const { [field]: omitted, ...metric } = declaredBehaviorMetric();
    assert.notEqual(omitted, undefined, `the decoy must replace a real ${field}`);
    const { experiment } = singleRecordExperiment((result) => ({
      ...result,
      behaviorMetrics: { [BEHAVIOR_METRIC_KEY]: metric },
    }));

    await withPollutedObjectPrototype(field, decoy, () =>
      assert.rejects(
        () => observability.persistBenchmarkExperiment({
          client: capture.client,
          datasetName: `metric-path-inherited-behavior-${field}-v0.2`,
          experiment,
        }),
        refusal,
        `a behavior metric whose ${field} exists only on Object.prototype must be refused: publishing it states a quality claim the evaluator never produced`,
      ));

    assert.equal(Object.hasOwn(Object.prototype, field), false, DECOY_MUST_NOT_OUTLIVE);
    assert.equal(capture.runs.length, 0);
  });
}

test('refuses a result whose behavior metrics container exists only on Object.prototype', async () => {
  const capture = capturingClient();
  const { experiment } = singleRecordExperiment((result) => {
    const { behaviorMetrics: omitted, ...partial } = result;
    assert.notEqual(omitted, undefined, 'the evaluation must produce behaviorMetrics');
    return partial;
  });
  const inherited = { [BEHAVIOR_METRIC_KEY]: declaredBehaviorMetric() };

  await withPollutedObjectPrototype('behaviorMetrics', inherited, () =>
    assert.rejects(
      () => observability.persistBenchmarkExperiment({
        client: capture.client,
        datasetName: 'metric-path-inherited-behavior-container-v0.2',
        experiment,
      }),
      /declared together/,
      'a result carrying no behavior metrics of its own must be refused: the paired-declaration check is what reads an inherited container as a declaration',
    ));

  assert.equal(
    Object.hasOwn(Object.prototype, 'behaviorMetrics'),
    false,
    DECOY_MUST_NOT_OUTLIVE,
  );
  assert.equal(capture.runs.length, 0);
});

/* -------------------------------------------------------------------------- */
/* evaluateBenchmarkRecord — the WRITE side, one layer upstream               */
/* -------------------------------------------------------------------------- */

/**
 * The evaluation builds its behavior metrics by assigning onto a plain object,
 * one layer ABOVE the hardened projection in `@aic/observability` — so an
 * inherited accessor swallows the metric before the downstream defence is ever
 * reached.
 *
 * And the swallow is invisible to that defence: what is left is `{}`, not
 * `undefined`, so the paired-declaration check does not fire. The record
 * declares a versioned evaluator, carries zero behavior metrics, and is
 * published exactly like a run on which every behavior evaluator was silent.
 *
 * The evaluation is computed INSIDE the decoy and persisted OUTSIDE it, so what
 * the persistence layer sees is the object the evaluator really built.
 */
const UPSTREAM_BEHAVIOR_METRIC_WRITES = [
  ['dependency-caused-incident-b', 'misleading_evidence_handling'],
  ['false-alert', 'false_alert_correctness'],
  ['challenge-keeps-leader', 'challenge_effect'],
];

for (const [scenarioId, metricKey] of UPSTREAM_BEHAVIOR_METRIC_WRITES) {
  test(`records its own ${metricKey} while Object.prototype carries an accessor of that name`, async () => {
    const record = calibrationRecordFor(scenarioId);
    const swallowed = [];
    const decoy = {
      evaluatorVersion: 'inherited-evaluator-v9',
      key: metricKey,
      score: 0,
      reason: 'incorrect-outcome',
    };

    const evaluation = await withAccessorPollutedObjectPrototype(
      metricKey,
      decoy,
      swallowed,
      () => evals.evaluateBenchmarkRecord({
        record,
        outcome: perfectOutcomeFor(record.scenario),
      }),
    );

    assert.equal(Object.hasOwn(Object.prototype, metricKey), false, DECOY_MUST_NOT_OUTLIVE);
    assert.equal(
      Object.hasOwn(evaluation.behaviorMetrics, metricKey),
      true,
      `an inherited setter must not swallow ${metricKey}: the evaluation then carries zero behavior metrics while its record declares a versioned evaluator, which is indistinguishable from a run the evaluator was silent on (the prototype setter received ${JSON.stringify(swallowed)})`,
    );
    assert.equal(
      evaluation.behaviorMetrics[metricKey].evaluatorVersion,
      benchmarkVersions.evaluatorVersion,
      `the recorded ${metricKey} must be the one this evaluator produced, not the decoy the prototype supplies`,
    );

    const capture = capturingClient();
    await observability.persistBenchmarkExperiment({
      client: capture.client,
      datasetName: `metric-path-upstream-accessor-${metricKey}-v0.2`,
      experiment: { records: [record], results: [evaluation] },
    });

    assert.equal(capture.runs.length, 1);
    assert.equal(
      Object.hasOwn(capture.runs[0].outputs.behaviorMetrics, metricKey),
      true,
      `${metricKey} must reach the published record: a metric swallowed upstream is published as an empty behaviorMetrics object, which no check downstream can tell from an unmeasured run`,
    );
    assert.equal(
      capture.feedback.some(({ key }) => key === metricKey),
      true,
      `${metricKey} must still be published as its own feedback key`,
    );
  });
}
