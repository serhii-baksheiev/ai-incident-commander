/**
 * AIC-117 slice b: `scripts/lane-arms.mjs` (not yet written) wires the oracle
 * and naive arms into the two live-model scripts, and the v0.3 control
 * baseline the lane now observes without withholding.
 *
 * `scripts/lane-arms.mjs` does not exist yet, so every row that needs it
 * imports it DYNAMICALLY, inside the row: a static top-level import would
 * throw while the whole file loads and take every row down with the same
 * "module not found" instead of each row failing on its own account.
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
