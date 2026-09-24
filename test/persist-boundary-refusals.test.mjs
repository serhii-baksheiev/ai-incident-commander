/**
 * AIC-69: the persistence boundary refuses what it cannot read as this run's
 * own, BEFORE anything crosses it.
 *
 * `test/metric-path-prototype-safety.test.mjs` is the sibling of this file and
 * asks a different question: given a record that is published, does it carry
 * only what the run OWNS? These four blocks ask whether the call happens at all
 * — an empty container, a record with no metadata of its own, a score that is
 * not a number, and the `client` slot that decides WHERE every outbound call in
 * this layer goes. Two of them involve no prototype decoy, and the two that do
 * plant an ARRAY INDEX rather than a field name, which the sibling's header
 * explicitly scopes itself away from. Hence a file of its own rather than more
 * cases in that one; the shared machinery (`capturingClient`,
 * `withPollutedObjectPrototype`, the plant-and-remove discipline) is imported
 * from the same fixtures, not copied.
 *
 * Each block below states the revert that turns it red. That is the point of
 * the file: every behaviour it pins shipped without a test, so "the suite is
 * green" said nothing about any of them.
 *
 * ## Isolation
 *
 * Two of the answers under test are "fall back to the real LangSmith client",
 * and a real client is exactly what must never reach the network from a test.
 * Two independent measures, because one of them is structural and the other is
 * mechanical:
 *
 *   - every fallback case is driven so that the refusal it asserts happens
 *     BEFORE the first outbound call — for `persistBenchmarkExperiment` the
 *     fallback is never even constructed, because the missing `experiment` is
 *     refused first;
 *   - `globalThis.fetch` is replaced for the whole file with a tripwire that
 *     records and throws. `langsmith` resolves the global at call time
 *     (`langsmith/dist/singletons/fetch.js`, `DEFAULT_FETCH_IMPLEMENTATION`),
 *     so an attempt would be caught here rather than in a real workspace, and
 *     `afterEach` fails the test that made it. It is installed at module scope
 *     and never restored: `node --test` gives each test file its own process,
 *     so the blast radius is this file.
 */
import assert from 'node:assert/strict';
import test, { afterEach } from 'node:test';

import * as observability from '@aic/observability';

import {
  benchmarkVersions,
  capturingClient,
  singleRecordExperiment,
} from './fixtures/benchmark-experiment.mjs';
import { withPollutedObjectPrototype } from './fixtures/prototype-decoy.mjs';

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
    'no test in this file may reach the network: a fallback client is asserted on the shape of its refusal, never by letting a request fail',
  );
});

/**
 * A decoy that outlived its test would silently decide the result of every test
 * after it, in this file and in every other one sharing the process. Each test
 * therefore asserts the removal itself rather than trusting the helper's
 * `finally` — the sibling file's convention, and it matters more here: the key
 * planted below is `'0'`, which every index read on an empty array in the
 * process would answer with.
 */
const DECOY_MUST_NOT_OUTLIVE =
  'the planted property must not outlive the test that planted it';

/**
 * Runs `call` and returns its rejection, so the assertions can happen OUTSIDE
 * the prototype decoy's window.
 *
 * `assert.rejects` inside the window would run the assertion machinery while
 * `Object.prototype['0']` answers every index read on an empty array in the
 * process, including the runner's own. The window here holds one call and
 * nothing else.
 */
async function refusalFrom(call) {
  try {
    await call();
    return undefined;
  } catch (error) {
    return error;
  }
}

/* -------------------------------------------------------------------------- */
/* 1. the empty-array chain walk                                              */
/* -------------------------------------------------------------------------- */

/**
 * An index read on an EMPTY array walks the prototype chain like any other
 * `[[Get]]`, so `records[0] === undefined` is not a guard: with a record planted
 * at `Object.prototype['0']`, an experiment of `{ records: [], results: [] }`
 * passes it holding an attacker's object, and its `experimentId` reaches
 * `createProject` as the project name.
 *
 * Revert that turns these red: check emptiness AFTER the index read instead of
 * before it, at `requireExperiment` and `persistBenchmarkExperiments`.
 *
 * ⚠ The third site, the guard at the top of `persistPreparedExperiment`, is
 * defence in depth and no test here can pin it: it is only reachable through
 * `requireExperiment`, which has already refused an empty record list. Reverting
 * that one alone leaves this file green, and saying so is more useful than a
 * test that pretends otherwise.
 *
 * The decoy carries both the raw caller shape (`scenario.id`) and the projected
 * one (`scenarioId`), because the two reverted sites hand it on as each.
 */
function attackerRecord() {
  return {
    runId: 'ATTACKER-RUN',
    exampleId: 'ATTACKER-EXAMPLE',
    experimentId: 'ATTACKER-PROJECT',
    threadId: 'ATTACKER-THREAD',
    scenario: { id: 'ATTACKER-SCENARIO', groundTruth: { attacker: true } },
    scenarioId: 'ATTACKER-SCENARIO',
    groundTruth: { attacker: true },
    metadata: { ...benchmarkVersions, runId: 'ATTACKER-RUN', scenarioId: 'ATTACKER-SCENARIO' },
    metadataScenarioId: 'ATTACKER-SCENARIO',
  };
}

test('refuses an experiment whose records are empty while Object.prototype supplies record zero', async () => {
  const capture = capturingClient();

  const error = await withPollutedObjectPrototype('0', attackerRecord(), () =>
    refusalFrom(() => observability.persistBenchmarkExperiment({
      client: capture.client,
      datasetName: 'persist-boundary-empty-records-v0.2',
      experiment: { records: [], results: [] },
    })));

  assert.equal(Object.hasOwn(Object.prototype, '0'), false, DECOY_MUST_NOT_OUTLIVE);
  assert.deepEqual(
    capture.calls.map(({ method }) => method),
    [],
    `nothing may cross the boundary for an experiment that carries no records of its own: with the emptiness check moved after the index read, the planted record’s experimentId reaches createProject as the project name (createProject received ${JSON.stringify(capture.calls.find(({ method }) => method === 'createProject')?.payload)})`,
  );
  assert.equal(
    error?.message,
    'benchmark experiment must contain at least one record',
    'and the refusal must name emptiness rather than what index zero answered with: an empty array is a prototype-chain read like any other, so `records[0] === undefined` guards nothing',
  );
});

test('refuses an experiments list that is empty while Object.prototype supplies experiment zero', async () => {
  const capture = capturingClient();
  const decoy = { records: [attackerRecord()], results: [] };

  const error = await withPollutedObjectPrototype('0', decoy, () =>
    refusalFrom(() => observability.persistBenchmarkExperiments({
      client: capture.client,
      datasetName: 'persist-boundary-empty-experiments-v0.2',
      experiments: [],
    })));

  assert.equal(Object.hasOwn(Object.prototype, '0'), false, DECOY_MUST_NOT_OUTLIVE);
  assert.deepEqual(
    capture.calls.map(({ method }) => method),
    [],
    'nothing may cross the boundary for an empty experiments list: an inherited experiment is published as a dataset and a set of native examples carrying the planted record’s identities, before any per-record guard runs',
  );
  assert.equal(
    error?.message,
    'at least one benchmark experiment is required',
    'and the plural entry point answers the same way as its singular sibling: emptiness before index zero',
  );
});

/* -------------------------------------------------------------------------- */
/* 2. the own-metadata requirement                                            */
/* -------------------------------------------------------------------------- */

/**
 * The single record's experiment, with its whole `metadata` object removed —
 * and with the result's `behaviorMetrics` container removed too.
 *
 * The second removal is what makes the first one decidable. A record with no
 * metadata declares no evaluator version, so a result that still CARRIES a
 * `behaviorMetrics` container is refused further downstream by the
 * paired-declaration rule ("…must be declared together") whatever `ownRecord`
 * does. The test would then be green on the revert for a reason that has
 * nothing to do with metadata, and it could not tell a refusal from a hollow
 * publication. With both halves absent the pairing rule is satisfied, and the
 * only thing standing between this record and a published run named
 * `benchmark:undefined` is the requirement under test.
 */
function experimentWithoutOwnMetadataObject() {
  const { record, experiment } = singleRecordExperiment((result) => {
    const { behaviorMetrics: omittedMetrics, ...withoutBehaviorMetrics } = result;
    assert.notEqual(
      omittedMetrics,
      undefined,
      'the evaluation must produce a behaviorMetrics container, or removing it proves nothing',
    );
    return withoutBehaviorMetrics;
  });
  const { metadata: omitted, ...withoutMetadata } = record;
  assert.notEqual(
    omitted,
    undefined,
    'the record must declare its own metadata, or removing it proves nothing',
  );
  return { records: [withoutMetadata], results: experiment.results };
}

/**
 * `ownRecord` REQUIRES an own `metadata` object rather than own-reading it
 * softly, and the difference is a published run.
 *
 * Revert that turns these red: read `metadata` and `metadataScenarioId` softly
 * — drop the `typeof metadata !== 'object'` refusal and let
 * `metadataScenarioId` be `undefined`. The record is then published as a run
 * named `benchmark:undefined` whose metadata block declares no graph, prompt,
 * toolset or status-rules version — indistinguishable downstream from a run
 * that genuinely recorded none.
 */
test('refuses a record that carries no metadata of its own', async () => {
  const capture = capturingClient();

  const error = await refusalFrom(() => observability.persistBenchmarkExperiment({
    client: capture.client,
    datasetName: 'persist-boundary-absent-metadata-v0.2',
    experiment: experimentWithoutOwnMetadataObject(),
  }));

  assert.deepEqual(
    capture.calls.map(({ method }) => method),
    [],
    `a record with no metadata of its own is refused, never published hollow: read softly it is published as a run named ${JSON.stringify(capture.runs[0]?.name)} whose metadata block declares no graph, prompt, toolset or status-rules version — which reads downstream exactly like a run that recorded none`,
  );
  assert.equal(
    error?.message,
    'benchmark record must carry its own metadata',
    'and the refusal must name the missing metadata: dropping an inherited block was the point, and publishing an empty one in its place is the same lie in the other direction',
  );
});

test('refuses a record whose metadata exists only on Object.prototype', async () => {
  const capture = capturingClient();
  const experiment = experimentWithoutOwnMetadataObject();
  const decoy = {
    ...benchmarkVersions,
    runId: 'ATTACKER-RUN',
    scenarioId: 'ATTACKER-SCENARIO',
  };

  const error = await withPollutedObjectPrototype('metadata', decoy, () =>
    refusalFrom(() => observability.persistBenchmarkExperiment({
      client: capture.client,
      datasetName: 'persist-boundary-inherited-metadata-v0.2',
      experiment,
    })));

  assert.equal(Object.hasOwn(Object.prototype, 'metadata'), false, DECOY_MUST_NOT_OUTLIVE);
  assert.deepEqual(
    capture.calls.map(({ method }) => method),
    [],
    `no part of a record whose provenance exists only on Object.prototype may cross the boundary: published, the run is named ${JSON.stringify(capture.runs[0]?.name)} and its metadata block is ${JSON.stringify(capture.runs[0]?.extra?.metadata)}`,
  );
  assert.equal(
    error?.message,
    'benchmark record must carry its own metadata',
    'and an inherited block is not a declaration: read through the chain it supplies the whole provenance the record never carried, and read softly it publishes a hollow one in its place',
  );
});

test('refuses a record whose metadata scenarioId exists only on Object.prototype', async () => {
  const capture = capturingClient();
  const { record, experiment } = singleRecordExperiment();
  const { scenarioId: omitted, ...metadata } = record.metadata;
  assert.notEqual(
    omitted,
    undefined,
    'the record must declare its own metadata scenarioId, or removing it proves nothing',
  );

  const error = await withPollutedObjectPrototype('scenarioId', 'ATTACKER-SCENARIO', () =>
    refusalFrom(() => observability.persistBenchmarkExperiment({
      client: capture.client,
      datasetName: 'persist-boundary-inherited-metadata-scenario-v0.2',
      experiment: { records: [{ ...record, metadata }], results: experiment.results },
    })));

  assert.equal(Object.hasOwn(Object.prototype, 'scenarioId'), false, DECOY_MUST_NOT_OUTLIVE);
  assert.deepEqual(
    capture.calls.map(({ method }) => method),
    [],
    `the scenario id is the run’s NAME and its declared input, not a metadata field among others: published, this run is called ${JSON.stringify(capture.runs[0]?.name)} and its inputs name scenario ${JSON.stringify(capture.runs[0]?.inputs?.scenarioId)}`,
  );
  assert.equal(
    error?.message,
    'benchmark record metadata must carry its own scenarioId',
    'and the refusal must name it: read softly the run is published as `benchmark:undefined`, and read through the chain under a scenario nobody ran',
  );
});

/* -------------------------------------------------------------------------- */
/* 3. the finite-score check                                                  */
/* -------------------------------------------------------------------------- */

/**
 * `requireMetrics` gates the score with `Number.isFinite`, not
 * `typeof score === 'number'`.
 *
 * Revert that turns these red: `typeof score !== 'number'`. `NaN` and
 * `Infinity` are both numbers by that test, so both reach `outputs.metrics` and
 * both are published again as this run's own `createFeedback` score — where
 * every aggregate read off the benchmark then consumes them. The sibling
 * resource check already refuses a non-finite figure; this is the same standard
 * on the path that feeds the feedback stream.
 */
const SCORE_METRIC_KEY = 'evidence_coverage';

for (const [label, score] of [['NaN', Number.NaN], ['Infinity', Number.POSITIVE_INFINITY], ['-Infinity', Number.NEGATIVE_INFINITY]]) {
  test(`refuses a quality metric whose score is not a finite number: ${label}`, async () => {
    const capture = capturingClient();
    const { experiment } = singleRecordExperiment((result) => {
      const metric = result.metrics[SCORE_METRIC_KEY];
      assert.equal(
        Number.isFinite(metric?.score),
        true,
        `the evaluation must produce a finite ${SCORE_METRIC_KEY} score, or replacing it proves nothing`,
      );
      return {
        ...result,
        metrics: { ...result.metrics, [SCORE_METRIC_KEY]: { ...metric, score } },
      };
    });

    const error = await refusalFrom(() => observability.persistBenchmarkExperiment({
      client: capture.client,
      datasetName: `persist-boundary-nonfinite-score-${label}-v0.2`,
      experiment,
    }));

    assert.deepEqual(
      capture.feedback.map(({ key, score }) => `${key}=${score}`),
      [],
      `a non-finite score must be refused BEFORE createFeedback: ${SCORE_METRIC_KEY} is scored per run there, so one ${label} enters every aggregate read off this benchmark`,
    );
    assert.deepEqual(
      capture.runs.map((run) => run.outputs.metrics[SCORE_METRIC_KEY]?.score),
      [],
      `${label} is a number and not a measurement: published in outputs.metrics it is indistinguishable from a coverage figure an evaluator computed`,
    );
    assert.equal(
      error?.message,
      `benchmark result metric has no score of its own: ${SCORE_METRIC_KEY}`,
      `and the refusal must name the metric: \`typeof score === 'number'\` admits ${label}, which is why the check is Number.isFinite — the same standard the sibling resource check already holds its figures to`,
    );
  });
}

/* -------------------------------------------------------------------------- */
/* 4. the client slot                                                         */
/* -------------------------------------------------------------------------- */

/**
 * `ownClient` has three answers, and each is pinned on BOTH entry points.
 *
 * Reverts that turn these red: reading the slot with `ownValue` alone (an
 * accessor then reads as absent and the caller's call goes to the LIVE
 * workspace); refusing a present-but-`undefined` client (which is how a
 * forwarded optional is spelled); and installing either guard on
 * `persistBenchmarkExperiments` only — the last round's actual defect, with
 * every caller in this repository on the singular.
 *
 * Each entry point declares the refusal a caller reaches NEXT once its client
 * slot has been accepted. That is the whole assertion for the two fallback
 * answers: the call got past the client slot without being refused for it. The
 * singular's next refusal fires before the fallback is constructed at all; the
 * plural's fires after construction and before the first outbound call, which
 * is why the tripwire above exists.
 *
 * AIC-120 round 2: `verifyPersistedBenchmarkReference` is the third entry
 * point. Before this fix it read its `client` slot with the untyped
 * `ownValue` rather than `ownClient` — so an own ACCESSOR `client` read as
 * absent there, and the call fell through to the LIVE default client exactly
 * the way the other two used to; it now reads the slot with `ownClient`, the
 * same as the other two entry points. Its `baseOptions` carries no
 * `reference` on purpose, so whichever client answer is in play, the very
 * next own-read throws
 * `nextRefusal` before any client method is ever called — same discipline as
 * the other two rows, and the same reason the tripwire above never fires for
 * any of them.
 *
 * `assertNoCapturedCalls` defaults to true and is `false` only for this third
 * entry: `verifyPersistedBenchmarkReference` never calls a client method
 * before the reference refusal fires, on the buggy reading of the slot AND
 * the fixed one alike (the real client, not `capture.client`, is what a
 * fallback would call anyway). Asserting `capture.calls` stays empty here
 * would hold no matter which behaviour is under test, so it is skipped rather
 * than kept as a check that cannot fail for the reason this file names.
 */
const CLIENT_SLOT_ENTRY_POINTS = [
  {
    name: 'persistBenchmarkExperiment',
    nextRefusal: 'persist options must carry its own experiment',
    baseOptions: () => ({ datasetName: 'persist-boundary-client-slot-v0.2' }),
    persist: (options) => observability.persistBenchmarkExperiment(options),
  },
  {
    name: 'persistBenchmarkExperiments',
    nextRefusal: 'datasetName must not be empty',
    baseOptions: () => ({ datasetName: '', experiments: [] }),
    persist: (options) => observability.persistBenchmarkExperiments(options),
  },
  {
    name: 'verifyPersistedBenchmarkReference',
    nextRefusal: 'verify options must carry their own reference',
    baseOptions: () => ({}),
    persist: (options) => observability.verifyPersistedBenchmarkReference(options),
    assertNoCapturedCalls: false,
  },
];

const ACCESSOR_REFUSAL = 'persist options carry a client that is not an own data property';

for (const {
  name,
  nextRefusal,
  baseOptions,
  persist,
  assertNoCapturedCalls = true,
} of CLIENT_SLOT_ENTRY_POINTS) {
  test(`falls back to the default client when ${name} is given no client`, async () => {
    const options = baseOptions();
    assert.equal(
      Object.hasOwn(options, 'client'),
      false,
      'the options must carry no client at all, or the absent answer is not under test',
    );

    const error = await refusalFrom(() => persist(options));

    assert.equal(
      error?.message,
      nextRefusal,
      'an absent client is a caller asking for the default one: refused here, every in-repository caller that omits it stops working, and the refusal would be reported as a client problem it does not have',
    );
  });

  test(`falls back to the default client when ${name} is given its own client of undefined`, async () => {
    const options = { ...baseOptions(), client: undefined };
    assert.equal(
      Object.hasOwn(options, 'client'),
      true,
      'the options must carry an OWN client key, or this is the absent case again',
    );

    const error = await refusalFrom(() => persist(options));

    assert.equal(
      error?.message,
      nextRefusal,
      '`{ client: undefined }` is how forwarding an optional is spelled, and the caller who wrote it meant the default: refusing a present-and-undefined client turns every such forward into a failure that names a client the caller never supplied',
    );
  });

  test(`refuses ${name} options whose client is an own accessor`, async () => {
    const capture = capturingClient();
    const reads = [];
    const options = baseOptions();
    Object.defineProperty(options, 'client', {
      configurable: true,
      enumerable: true,
      get() {
        reads.push('read');
        return capture.client;
      },
    });

    const error = await refusalFrom(() => persist(options));

    assert.equal(
      error?.message,
      ACCESSOR_REFUSAL,
      `a present client that cannot be read as an own data property is refused, never defaulted: treated as absent it sends the dataset, the examples, every run and every feedback of this benchmark to the LIVE workspace instead of to the client the caller passed (the accessor was read ${reads.length} times)`,
    );
    if (assertNoCapturedCalls) {
      assert.deepEqual(
        capture.calls.map(({ method }) => method),
        [],
        'and nothing may be published through the accessor’s own client either: the refusal is the answer, not a redirect',
      );
    }
  });
}
