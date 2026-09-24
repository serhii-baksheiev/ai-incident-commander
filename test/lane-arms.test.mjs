/**
 * AIC-117 slice b: `scripts/lane-arms.mjs` wires the oracle and naive arms into
 * the two live-model scripts, and the committed control baseline covers every
 * axis the lane observes under v0.3.
 *
 * AIC-117 slice d (bottom of this file): `publishNaiveArm`, the function that
 * publishes the naive arm's own experiment under `--publish`, independently of
 * whether the model arm published.
 *
 * Rows that need `scripts/lane-arms.mjs` import it inside the row, so a broken
 * module fails those rows on their own account rather than the whole file.
 *
 * Independent oracle: what a row expects is either a literal, or read from a
 * committed evidence file this module does not produce —
 * `docs/evidence/oracle/behavior-evaluators-v0.3.json` for the oracle row, and
 * `docs/evidence/control-baseline.json` (through `readControlBaseline`, the
 * one committed reader — `scripts/eval-final-holdout.mjs`) for the baseline
 * row. Neither row derives its expectation from `lane-arms.mjs` itself.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import * as evals from '@aic/evals';
import { MODEL_API_KEY_VARIABLE } from '@aic/roles';
import { NAIVE_PROMPT_VERSION } from '@aic/roles/naive';

import { benchmarkVersions } from './fixtures/benchmark-experiment.mjs';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

function requireExport(name) {
  assert.ok(evals[name] !== undefined, `@aic/evals must export ${name}`);
  return evals[name];
}

const HEAD_SHA = 'e'.repeat(40);

function fakeApiKey() {
  return ['sk', 'ant', 'test', '9'.repeat(24)].join('-');
}

/** v0.2 promoted to the v0.3 structural evaluator, everything else unchanged. */
const v3Metadata = Object.freeze({
  ...benchmarkVersions,
  evaluatorVersion: evals.STRUCTURAL_EVALUATOR_VERSION,
});

/** Every metric key this lane compares — three benchmark, three behavior. */
function sixMetricKeys() {
  return [...evals.BENCHMARK_METRIC_KEYS, ...evals.BEHAVIOR_METRIC_KEYS];
}

/* -------------------------------------------------------------------------- */
/* 1. oracleArm reaches best on every metric under v0.3, over calibration     */
/* -------------------------------------------------------------------------- */

test('oracleArm covers the calibration plan under v0.3 metadata, and the lane reports it completed and comparable on every one of the six metrics', async () => {
  const { oracleArm } = await import('../scripts/lane-arms.mjs');
  const { scriptedNodes } = await import('../scripts/eval-live-model.mjs');
  const runLiveModelLane = requireExport('runLiveModelLane');

  const runOracleArm = oracleArm({ experimentId: 'aic-117b-oracle-calibration' });

  async function scriptedGraphExperiment(experimentId, plan) {
    return evals.runGraphBenchmarkExperiment({
      experimentId,
      scenarioSet: plan.scenarioSet,
      runsPerScenario: plan.runsPerScenario,
      metadata: plan.metadata,
      createNodes: (record) => scriptedNodes(record),
      async recordEvaluation() {},
    });
  }

  const report = await runLiveModelLane({
    env: { [MODEL_API_KEY_VARIABLE]: fakeApiKey() },
    scenarioSet: 'calibration',
    experimentId: 'aic-117b-oracle-lane',
    headSha: HEAD_SHA,
    metadata: v3Metadata,
    runOracleArm,
    async runControlArm(plan) {
      return scriptedGraphExperiment('aic-117b-oracle-control', plan);
    },
    async runModelArm(plan) {
      return scriptedGraphExperiment('aic-117b-oracle-model', plan);
    },
  });

  assert.equal(report.arms.oracle.status, 'completed');

  // Oracle reaching best everywhere under v0.3 is measured, not asserted here:
  // docs/evidence/oracle/behavior-evaluators-v0.3.json (partition: calibration)
  // carries bestValues equal to every scenario's own score, on all six axes.
  const evidencePath = join(
    REPO_ROOT,
    'docs/evidence/oracle/behavior-evaluators-v0.3.json',
  );
  const oracleEvidence = JSON.parse(readFileSync(evidencePath, 'utf8'));
  assert.equal(oracleEvidence.partition, 'calibration');

  const metricKeys = sixMetricKeys();
  assert.equal(metricKeys.length, 6);
  assert.deepEqual(Object.keys(oracleEvidence.bestValues).sort(), [...metricKeys].sort());

  assert.ok(report.comparability !== undefined, 'a completed oracle arm must publish comparability');
  for (const key of metricKeys) {
    const entry = report.comparability[key];
    assert.ok(entry !== undefined, `comparability must cover ${key}`);
    assert.equal(
      entry.comparable,
      true,
      `the committed oracle evidence says every axis reaches its best under v0.3 — including ${key}`,
    );
  }
});

/* -------------------------------------------------------------------------- */
/* 2. naiveArm: one completion per record, no scenario id ever shown          */
/* -------------------------------------------------------------------------- */

test('naiveArm drives the naive role from a fake port: exactly one completion per record, notApplicable.challenge_effect on every result, promptVersion/modelId/modelProvider on every record, and no REPLAY_SCENARIOS id in any request', async () => {
  const { naiveArm } = await import('../scripts/lane-arms.mjs');

  const requests = [];
  const fakePort = {
    async complete(request) {
      requests.push(request);
      return {
        // A schema-valid, internally-consistent naive completion — the same
        // shape test/naive-role.test.mjs's baseAnswer() pins, simplified to
        // the case that needs no mechanism vocabulary: an 'inconclusive'
        // conclusion carries no cause.
        text: JSON.stringify({
          hypotheses: [],
          assessments: [],
          conclusion: { kind: 'inconclusive', causes: [] },
          stopKind: 'ambiguous',
        }),
        modelId: 'fake-naive-model',
        usage: { inputTokens: 10, outputTokens: 5 },
      };
    },
  };
  const config = Object.freeze({ modelId: 'fake-naive-model', provider: 'anthropic' });

  const runNaiveArm = naiveArm({
    experimentId: 'aic-117b-naive-calibration',
    port: fakePort,
    config,
  });

  const experiment = await runNaiveArm({
    scenarioSet: 'calibration',
    runsPerScenario: 3,
    metadata: v3Metadata,
  });

  assert.ok(experiment.records.length > 0, 'the calibration plan must produce at least one record');
  assert.equal(
    requests.length,
    experiment.records.length,
    'the naive arm runs one prompt per run: no retry, no repair round',
  );

  for (const result of experiment.results) {
    assert.equal(
      typeof result.notApplicable?.challenge_effect,
      'string',
      'the naive arm answers in one prompt with no challenge round, so every result must carry notApplicable.challenge_effect',
    );
  }

  for (const record of experiment.records) {
    assert.equal(record.metadata.promptVersion, NAIVE_PROMPT_VERSION);
    assert.equal(record.metadata.modelId, config.modelId);
    assert.equal(record.metadata.modelProvider, config.provider);
  }

  const scenarioIds = evals.REPLAY_SCENARIOS.map(({ id }) => id);
  assert.ok(scenarioIds.length > 0);
  for (const request of requests) {
    const text = `${request.system ?? ''}\n${request.prompt ?? ''}`;
    for (const scenarioId of scenarioIds) {
      assert.equal(
        text.includes(scenarioId),
        false,
        `the naive role sees only the opaque incident id: the scenario id ${scenarioId} must never reach the request text`,
      );
    }
  }
});

/* -------------------------------------------------------------------------- */
/* 3. both scripts wire all four arms and declare v0.3 (a source audit)       */
/* -------------------------------------------------------------------------- */

/**
 * Neither script can run its lane in this suite — each refuses before
 * touching a dataset without a live provider credential, which this suite
 * never sets. So this row reads what the script WOULD hand `runLiveModelLane`
 * off its source text, the same audit style
 * `final-evaluation-command.test.mjs` already uses for this file
 * (`laneOptionNames`), narrowed here to plain pattern matches because the
 * three things this row checks are each a fixed phrase rather than a
 * structural question about the call site.
 */
test('both eval-live-model.mjs and eval-final-holdout.mjs import oracleArm and naiveArm from ./lane-arms.mjs, wire them into runLiveModelLane, and declare the v0.3 structural evaluator', () => {
  for (const relativePath of ['scripts/eval-live-model.mjs', 'scripts/eval-final-holdout.mjs']) {
    const source = readFileSync(join(REPO_ROOT, relativePath), 'utf8');

    assert.match(
      source,
      /import \{[^}]*\boracleArm\b[^}]*\}\s*from\s*'\.\/lane-arms\.mjs'/,
      `${relativePath} must import oracleArm from ./lane-arms.mjs`,
    );
    assert.match(
      source,
      /import \{[^}]*\bnaiveArm\b[^}]*\}\s*from\s*'\.\/lane-arms\.mjs'/,
      `${relativePath} must import naiveArm from ./lane-arms.mjs`,
    );
    assert.match(
      source,
      // Either `runOracleArm: oracleArm(…)` or a method that returns `oracleArm(…)(plan)`,
      // the form a runner uses when its port is created lazily inside the lane.
      /runOracleArm(?::\s*|\s*\(\s*plan\s*\)\s*\{\s*return\s+)oracleArm\(/,
      `${relativePath} must pass runOracleArm: oracleArm(...) to runLiveModelLane`,
    );
    assert.match(
      source,
      // Either `runNaiveArm: naiveArm(…)` or a method that returns `naiveArm(…)(plan)`,
      // the form a runner uses when its port is created lazily inside the lane.
      /runNaiveArm(?::\s*|\s*\(\s*plan\s*\)\s*\{\s*return\s+)naiveArm\(/,
      `${relativePath} must pass runNaiveArm: naiveArm(...) to runLiveModelLane`,
    );
    assert.match(
      source,
      /evaluatorVersion:\s*evals\.STRUCTURAL_EVALUATOR_VERSION/,
      `${relativePath} must declare evaluatorVersion as evals.STRUCTURAL_EVALUATOR_VERSION`,
    );
  }
});

/**
 * The two paid arms spend through ONE port, and so one usage ledger: the call
 * and output-token caps bound the naive and graph-model arms together only if
 * neither arm builds a port of its own. A source audit, because neither command
 * can run a lane without a live credential.
 */
test('each lane command creates exactly one reference-model port and hands it to both paid arms', () => {
  for (const relativePath of ['scripts/eval-live-model.mjs', 'scripts/eval-final-holdout.mjs']) {
    const source = readFileSync(join(REPO_ROOT, relativePath), 'utf8');

    assert.equal(
      source.split('createReferenceModelPort(').length - 1,
      1,
      `${relativePath} must create exactly one reference-model port: a second one carries its own ledger and escapes the lane's caps`,
    );

    const naiveStart = source.indexOf('async runNaiveArm(plan)');
    const modelStart = source.indexOf('async runModelArm(plan)');
    assert.ok(naiveStart >= 0 && modelStart > naiveStart, `${relativePath} must declare runNaiveArm before runModelArm`);
    const naiveBody = source.slice(naiveStart, modelStart);
    const modelBody = source.slice(modelStart, modelStart + 1500);
    assert.match(naiveBody, /sharedPort\(\)/, `${relativePath} runNaiveArm must take the shared port`);
    assert.match(modelBody, /sharedPort\(\)/, `${relativePath} runModelArm must take the shared port`);
  }
});

/* -------------------------------------------------------------------------- */
/* 4. the committed control baseline, under v0.3, both corpora                */
/* -------------------------------------------------------------------------- */

/**
 * The scripted control's own observed baseline, over the real plan, compared
 * against the one committed file — in both directions, so neither a missing
 * nor an extra axis can hide.
 * Under v0.3 the lane withholds nothing, so `evidence_coverage` is among the
 * axes the control observes and the file must declare it.
 */
test('the committed control baseline equals what the scripted control arm observes under v0.3, over calibration and over final-evaluation, with no axis missing and none extra', async () => {
  const { scriptedNodes } = await import('../scripts/eval-live-model.mjs');
  const { readControlBaseline } = await import('../scripts/eval-final-holdout.mjs');
  const runLiveModelLane = requireExport('runLiveModelLane');

  const declared = readControlBaseline();

  for (const scenarioSet of ['calibration', 'final-evaluation']) {
    async function scriptedGraphExperiment(experimentId, plan) {
      return evals.runGraphBenchmarkExperiment({
        experimentId,
        scenarioSet: plan.scenarioSet,
        runsPerScenario: plan.runsPerScenario,
        metadata: plan.metadata,
        createNodes: (record) => scriptedNodes(record),
        async recordEvaluation() {},
      });
    }

    // eslint-disable-next-line no-await-in-loop -- two independent corpora, run one after the other on purpose
    const report = await runLiveModelLane({
      env: { [MODEL_API_KEY_VARIABLE]: fakeApiKey() },
      scenarioSet,
      experimentId: `aic-117b-control-baseline-${scenarioSet}`,
      headSha: HEAD_SHA,
      metadata: v3Metadata,
      async runControlArm(plan) {
        return scriptedGraphExperiment(`aic-117b-control-${scenarioSet}`, plan);
      },
      async runModelArm(plan) {
        return scriptedGraphExperiment(`aic-117b-model-${scenarioSet}`, plan);
      },
    });

    const observed = report.arms.control.observedBaseline;
    assert.deepEqual(
      Object.keys(observed).sort(),
      Object.keys(declared).sort(),
      `over ${scenarioSet}, docs/evidence/control-baseline.json must declare exactly the axes the scripted control observes under v0.3 — no axis missing, none extra`,
    );
    assert.deepEqual(
      observed,
      declared,
      `over ${scenarioSet}, docs/evidence/control-baseline.json must equal what the scripted control arm observes under v0.3`,
    );
  }
});

/* -------------------------------------------------------------------------- */
/* 5. publishNaiveArm — AIC-117 slice d                                       */
/* -------------------------------------------------------------------------- */

/**
 * A fake naive completion port, schema-valid and internally consistent — the
 * same shape row 2 above already uses for `naiveArm`.
 */
function fakeNaivePort() {
  return {
    async complete() {
      return {
        text: JSON.stringify({
          hypotheses: [],
          assessments: [],
          conclusion: { kind: 'inconclusive', causes: [] },
          stopKind: 'ambiguous',
        }),
        modelId: 'fake-naive-model',
        usage: { inputTokens: 10, outputTokens: 5 },
      };
    },
  };
}

/**
 * A whole lane, driven through the real `runLiveModelLane`, with a scripted
 * (zero-score, deterministic) control and model arm and a caller-supplied
 * naive arm — the shape `publishNaiveArm`'s rows below need on their input
 * side. The control baseline defaults to the committed
 * `docs/evidence/control-baseline.json` (through `readControlBaseline`, row 4
 * above's own reader) so the scripted control arm never moves against it and
 * the naive arm's `reportable` flag turns on ordinary completion — set
 * `includeControlBaseline: false` for the row that needs the undeclared-
 * baseline path instead.
 */
async function publishNaiveLane({ runNaiveArm, includeControlBaseline = true } = {}) {
  const { scriptedNodes } = await import('../scripts/eval-live-model.mjs');
  const { readControlBaseline } = await import('../scripts/eval-final-holdout.mjs');
  const runLiveModelLane = requireExport('runLiveModelLane');

  async function scriptedGraphExperiment(experimentId, plan) {
    return evals.runGraphBenchmarkExperiment({
      experimentId,
      scenarioSet: plan.scenarioSet,
      runsPerScenario: plan.runsPerScenario,
      metadata: plan.metadata,
      createNodes: (record) => scriptedNodes(record),
      async recordEvaluation() {},
    });
  }

  return runLiveModelLane({
    env: { [MODEL_API_KEY_VARIABLE]: fakeApiKey() },
    scenarioSet: 'calibration',
    experimentId: 'aic-117d-publish-naive',
    headSha: HEAD_SHA,
    metadata: v3Metadata,
    ...(includeControlBaseline ? { controlBaseline: readControlBaseline() } : {}),
    async runControlArm(plan) {
      return scriptedGraphExperiment('aic-117d-publish-naive-control', plan);
    },
    ...(runNaiveArm === undefined ? {} : { runNaiveArm }),
    async runModelArm(plan) {
      return scriptedGraphExperiment('aic-117d-publish-naive-model', plan);
    },
  });
}

/**
 * The completed-and-reportable case both the "publishes" row and the
 * "persist rejection propagates" row need: a real naive experiment, captured
 * the way `eval-live-model.mjs` captures `modelExperiment` (assigned inside
 * `runNaiveArm`, returned unchanged).
 */
async function completedReportableNaiveLane() {
  const { naiveArm } = await import('../scripts/lane-arms.mjs');
  const config = Object.freeze({ modelId: 'fake-naive-model', provider: 'anthropic' });

  let naiveExperiment;
  const report = await publishNaiveLane({
    async runNaiveArm(plan) {
      naiveExperiment = await naiveArm({
        experimentId: 'aic-117d-publish-naive-naive',
        port: fakeNaivePort(),
        config,
      })(plan);
      return naiveExperiment;
    },
  });
  return { report, naiveExperiment };
}

test('publishNaiveArm publishes a completed, reportable naive arm exactly once, with the given datasetName and the exact experiment object, and returns what persist resolved to', async () => {
  const { publishNaiveArm } = await import('../scripts/lane-arms.mjs');
  const { report, naiveExperiment } = await completedReportableNaiveLane();

  // Pinned so a failure here points at the lane input rather than at
  // publishNaiveArm: the row's whole premise is that the arm completed and
  // was judged reportable before publishNaiveArm ever saw it.
  assert.equal(report.arms.naive.status, 'completed');
  assert.equal(report.arms.naive.reportable, true);

  const calls = [];
  async function persist(options) {
    calls.push(options);
    return { datasetId: 'd', projects: [], runIds: [] };
  }

  const result = await publishNaiveArm({
    laneReport: report,
    naiveExperiment,
    datasetName: 'aic-117d-publish-naive-dataset',
    persist,
  });

  assert.deepEqual(
    calls,
    [{ datasetName: 'aic-117d-publish-naive-dataset', experiment: naiveExperiment }],
    'persist must be called exactly once, with exactly datasetName and experiment',
  );
  assert.deepEqual(result, { status: 'published', datasetId: 'd', projects: [], runIds: [] });
});

test('publishNaiveArm returns absent with the not-run reason and never calls persist, when the lane ran with no naive arm', async () => {
  const { publishNaiveArm } = await import('../scripts/lane-arms.mjs');
  const report = await publishNaiveLane();

  // Pinned by four-arm-lane.test.mjs's own not-run row; restated here as a
  // literal because this row's assertion on publishNaiveArm is only
  // meaningful if the input really is the not-run shape.
  assert.deepEqual(report.arms.naive, {
    arm: 'naive',
    status: 'not-run',
    reason: 'the caller supplied no naive arm',
  });

  let persistCalls = 0;
  const result = await publishNaiveArm({
    laneReport: report,
    naiveExperiment: undefined,
    datasetName: 'unused',
    async persist() {
      persistCalls += 1;
    },
  });

  assert.equal(persistCalls, 0);
  assert.deepEqual(result, { status: 'absent', absentReason: 'the caller supplied no naive arm' });
});

test('publishNaiveArm returns absent with the refusal reason and never calls persist, when the naive arm threw', async () => {
  const { publishNaiveArm } = await import('../scripts/lane-arms.mjs');
  const report = await publishNaiveLane({
    async runNaiveArm() {
      throw new Error('naive harness exploded');
    },
  });

  assert.equal(report.arms.naive.status, 'refused');

  let persistCalls = 0;
  const result = await publishNaiveArm({
    laneReport: report,
    naiveExperiment: undefined,
    datasetName: 'unused',
    async persist() {
      persistCalls += 1;
    },
  });

  assert.equal(persistCalls, 0);
  assert.deepEqual(result, { status: 'absent', absentReason: 'naive harness exploded' });
});

test('publishNaiveArm returns absent with the unreportable reason and never calls persist, when the naive arm completed but no control baseline was declared', async () => {
  const { publishNaiveArm } = await import('../scripts/lane-arms.mjs');
  const { naiveArm } = await import('../scripts/lane-arms.mjs');
  const config = Object.freeze({ modelId: 'fake-naive-model', provider: 'anthropic' });

  let naiveExperiment;
  const report = await publishNaiveLane({
    includeControlBaseline: false,
    async runNaiveArm(plan) {
      naiveExperiment = await naiveArm({
        experimentId: 'aic-117d-publish-naive-unreportable',
        port: fakeNaivePort(),
        config,
      })(plan);
      return naiveExperiment;
    },
  });

  assert.equal(report.arms.naive.status, 'completed');
  assert.equal(report.arms.naive.reportable, false);

  let persistCalls = 0;
  const result = await publishNaiveArm({
    laneReport: report,
    naiveExperiment,
    datasetName: 'unused',
    async persist() {
      persistCalls += 1;
    },
  });

  assert.equal(persistCalls, 0);
  assert.deepEqual(result, {
    status: 'absent',
    // Literal, pinned from packages/evals/src/live-model-lane.ts's own
    // armReportable() — the undeclared-baseline branch.
    absentReason:
      'no control baseline was declared, so a metric that moved cannot be attributed to the model rather than to the harness',
  });
});

test('publishNaiveArm returns absent with its own reason and never calls persist, when naiveExperiment is undefined despite a completed, reportable arm', async () => {
  const { publishNaiveArm } = await import('../scripts/lane-arms.mjs');

  // A minimal literal laneReport rather than one driven through
  // runLiveModelLane: the lane never reports an arm completed+reportable
  // without also having produced an experiment for it, so "completed,
  // reportable, but naiveExperiment is undefined" is not a lane output — it is
  // a caller-side capture bug (the script's own local variable never got
  // assigned). publishNaiveArm still has to answer for it, so this branch is
  // pinned as a literal rather than left unreachable.
  const laneReport = {
    arms: {
      naive: { arm: 'naive', status: 'completed', reportable: true, metrics: {} },
    },
  };

  let persistCalls = 0;
  const result = await publishNaiveArm({
    laneReport,
    naiveExperiment: undefined,
    datasetName: 'unused',
    async persist() {
      persistCalls += 1;
    },
  });

  assert.equal(persistCalls, 0);
  assert.deepEqual(result, {
    status: 'absent',
    absentReason: 'the naive arm produced no experiment to publish',
  });
});

test('a persist rejection propagates out of publishNaiveArm rather than being turned into an absent result', async () => {
  const { publishNaiveArm } = await import('../scripts/lane-arms.mjs');
  const { report, naiveExperiment } = await completedReportableNaiveLane();
  assert.equal(report.arms.naive.status, 'completed');
  assert.equal(report.arms.naive.reportable, true);

  const failure = new Error('LangSmith ingestion refused');
  let persistCalls = 0;

  await assert.rejects(
    () =>
      publishNaiveArm({
        laneReport: report,
        naiveExperiment,
        datasetName: 'aic-117d-publish-naive-dataset',
        async persist() {
          persistCalls += 1;
          throw failure;
        },
      }),
    (error) => error === failure,
  );
  assert.equal(persistCalls, 1, 'a rejection must not be retried');
});

/**
 * Neither command can run its lane in this suite without a live provider
 * credential, so this is a source audit — the same style row 3 above already
 * uses for oracleArm/naiveArm.
 */
test('eval-live-model.mjs imports publishNaiveArm from ./lane-arms.mjs and calls it inside its --publish path under the aic-94-live-model-naive- dataset-name prefix', () => {
  const source = readFileSync(join(REPO_ROOT, 'scripts/eval-live-model.mjs'), 'utf8');

  assert.match(
    source,
    /import \{[^}]*\bpublishNaiveArm\b[^}]*\}\s*from\s*'\.\/lane-arms\.mjs'/,
    'scripts/eval-live-model.mjs must import publishNaiveArm from ./lane-arms.mjs',
  );

  const publishBlockStart = source.indexOf("flag('publish')");
  assert.ok(publishBlockStart >= 0, 'scripts/eval-live-model.mjs must still declare a --publish branch');
  const publishBlock = source.slice(publishBlockStart);

  assert.match(
    publishBlock,
    /publishNaiveArm\(/,
    'scripts/eval-live-model.mjs must call publishNaiveArm inside its --publish path',
  );
  assert.match(
    publishBlock,
    /aic-94-live-model-naive-/,
    "scripts/eval-live-model.mjs must publish the naive arm's dataset under the 'aic-94-live-model-naive-' prefix",
  );
});

/**
 * Same audit shape as the row above, plus the one field
 * eval-final-holdout.mjs alone gains: `naivePublication` on the complete
 * record.
 */
test('eval-final-holdout.mjs imports publishNaiveArm from ./lane-arms.mjs, calls it inside its --publish path under the aic-19-final-holdout-naive- dataset-name prefix, and writes naivePublication into the complete record', () => {
  const source = readFileSync(join(REPO_ROOT, 'scripts/eval-final-holdout.mjs'), 'utf8');

  assert.match(
    source,
    /import \{[^}]*\bpublishNaiveArm\b[^}]*\}\s*from\s*'\.\/lane-arms\.mjs'/,
    'scripts/eval-final-holdout.mjs must import publishNaiveArm from ./lane-arms.mjs',
  );

  const publishBlockStart = source.indexOf("flag('publish')");
  assert.ok(publishBlockStart >= 0, 'scripts/eval-final-holdout.mjs must still declare a --publish branch');
  const publishBlock = source.slice(publishBlockStart);

  assert.match(
    publishBlock,
    /publishNaiveArm\(/,
    'scripts/eval-final-holdout.mjs must call publishNaiveArm inside its --publish path',
  );
  assert.match(
    publishBlock,
    /aic-19-final-holdout-naive-/,
    "scripts/eval-final-holdout.mjs must publish the naive arm's dataset under the 'aic-19-final-holdout-naive-' prefix",
  );

  assert.match(
    source,
    /naivePublication\s*:/,
    'scripts/eval-final-holdout.mjs must write naivePublication into the complete record',
  );
});
