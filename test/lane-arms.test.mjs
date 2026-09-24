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

import * as domain from '@aic/domain';
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
/** The 12-char prefix both scripts derive their dataset names from. */
const HEAD_SHA12 = HEAD_SHA.slice(0, 12);

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
/* 3b. modelNodes: the single implementation, wired with propose_conclusion   */
/*     (AIC-119 slice E)                                                      */
/* -------------------------------------------------------------------------- */

/**
 * The same execution-input shape `test/live-model-lane.test.mjs`'s
 * `calibrationExecutionInput` builds, copied rather than imported: that
 * helper is not exported, and this file's own convention (see the file
 * header) is that a row needing `scripts/lane-arms.mjs` imports it inside the
 * row so a broken module fails only that row.
 */
function calibrationExecutionInput() {
  const [record] = evals.createCalibrationBenchmarkPlan({
    experimentId: 'aic-119e-lane-arms-modelnodes',
    runsPerScenario: 3,
    metadata: v3Metadata,
  });
  assert.ok(record, 'the calibration plan must contain at least one record');
  return {
    experimentId: record.experimentId,
    exampleId: record.exampleId,
    scenarioId: record.scenario.id,
    fixture: record.scenario.fixture,
    runId: record.runId,
    threadId: record.threadId,
    metadata: record.metadata,
  };
}

/**
 * `modelNodes` moves into `scripts/lane-arms.mjs` (the one implementation
 * both live-model scripts wire), and gains `propose_conclusion` beside the
 * three roles it already swapped — the same vocabulary the naive arm
 * receives: `createModelProposeConclusion({ port, mechanisms:
 * evals.ROOT_CAUSE_MECHANISMS })`.
 *
 * The vocabulary sentence is checked against `evals.ROOT_CAUSE_MECHANISMS`
 * directly — @aic/evals' own export, not a read of
 * `investigation-roles.ts`'s internal vocabulary constant — so this row
 * cannot be satisfied by the role quietly inventing its own list.
 */
test('modelNodes(record, port).propose_conclusion is a model role: the fake port sees exactly one call, carrying the mechanism vocabulary sentence built from evals.ROOT_CAUSE_MECHANISMS', async () => {
  const { modelNodes } = await import('../scripts/lane-arms.mjs');
  const input = calibrationExecutionInput();

  const requests = [];
  const port = {
    async complete(request) {
      requests.push(request);
      return {
        text: JSON.stringify({ kind: 'inconclusive', causes: [] }),
        modelId: 'fake-model-under-test',
        usage: { inputTokens: 1, outputTokens: 1 },
      };
    },
  };

  const nodes = modelNodes(input, port);
  assert.equal(
    typeof nodes.propose_conclusion,
    'function',
    'modelNodes must wire propose_conclusion to a model-backed role, not the scripted one',
  );

  const state = {
    incident: { id: 'aic-119e-fake-incident' },
    hypotheses: [{ id: 'h-1', statement: 'a candidate cause', createdBy: 'initial' }],
    predictions: [],
    tests: [],
    trials: [],
    evidence: [],
    assessments: [],
    control: { stopKind: 'sufficient', challengeRounds: 0 },
  };

  await nodes.propose_conclusion(state);

  assert.equal(requests.length, 1, 'propose_conclusion must make exactly one model call per invocation');
  const vocabularySentence = `Classify each cause's mechanism as one of: ${evals.ROOT_CAUSE_MECHANISMS.join(', ')}.`;
  assert.ok(
    requests[0].system.includes(vocabularySentence),
    `expected the request system prompt to carry the vocabulary sentence built from evals.ROOT_CAUSE_MECHANISMS: ${JSON.stringify(requests[0].system)}`,
  );
});

/**
 * `.claude/rules/invariants.md` ("one mechanism, one implementation"):
 * `modelNodes` used to exist twice, once per script. Both scripts must now
 * reach it through `scripts/lane-arms.mjs` — by `import` when the binding is
 * used locally, or by `export … from` when a script also needs to keep
 * re-exporting it for its own tests, so either shape satisfies this row.
 */
test('both eval-live-model.mjs and eval-final-holdout.mjs reach modelNodes from ./lane-arms.mjs, the single implementation', () => {
  for (const relativePath of ['scripts/eval-live-model.mjs', 'scripts/eval-final-holdout.mjs']) {
    const source = readFileSync(join(REPO_ROOT, relativePath), 'utf8');
    assert.match(
      source,
      /\b(?:import|export)\s*\{[^}]*\bmodelNodes\b[^}]*\}\s*from\s*'\.\/lane-arms\.mjs'/,
      `${relativePath} must reach modelNodes from ./lane-arms.mjs, not define its own copy`,
    );
  }
});

/**
 * `.claude/rules/invariants.md` ("one mechanism, one implementation"): the
 * control arm's nodes and the model arm's base nodes come from one
 * `scriptedNodes`, in `scripts/lane-arms.mjs`. This row is `modelNodes`'s
 * sibling row above: it guards against either lane command declaring its own
 * copy again, which is how the two used to drift apart unnoticed.
 */
test('both eval-live-model.mjs and eval-final-holdout.mjs reach scriptedNodes from ./lane-arms.mjs, the single implementation', () => {
  for (const relativePath of ['scripts/eval-live-model.mjs', 'scripts/eval-final-holdout.mjs']) {
    const source = readFileSync(join(REPO_ROOT, relativePath), 'utf8');
    assert.match(
      source,
      /\b(?:import|export)\s*\{[^}]*\bscriptedNodes\b[^}]*\}\s*from\s*'\.\/lane-arms\.mjs'/,
      `${relativePath} must reach scriptedNodes from ./lane-arms.mjs, not define its own copy`,
    );
  }
});

/* -------------------------------------------------------------------------- */
/* 3c. scriptedNodes and modelNodes carry the canonical derive_hypothesis_    */
/*     state and termination_check nodes (AIC-119 slice 3)                    */
/* -------------------------------------------------------------------------- */

/**
 * A state-driven state, proven by BEHAVIOUR rather than by identity or a
 * source-text match: the fixture's own `termination_check` ignores every
 * field below and always answers `sufficient`; the fixture's own
 * `derive_hypothesis_state` ignores every field below and always answers
 * `{}`. The literal expectations are read off T0-T6 by hand
 * (`packages/graph/src/nodes/termination.ts`), never by calling
 * `createStateTerminationCheck`/`createDeriveHypothesisState` to compute
 * them — the same independent-oracle discipline `state-termination.test.mjs`
 * already holds itself to.
 *
 * `challengeRounds: 1`, one `createdBy: 'initial'` candidate hypothesis, no
 * assessments, non-empty evidence and an ok trial: T0 does not fire (evidence
 * is non-empty); T1 does not fire (a hypothesis exists); the sole hypothesis
 * has no qualifying assessment, so it stays `candidate` and is never a member
 * of `{supported, corroborated}` — T2 does not fire (`r` is already 1), T3
 * and T4 do not fire (no hypothesis is in that set at all, so `competing` is
 * empty), and T5 does not fire (`competing.length` is 0, not 1) — leaving T6:
 * `stalled`.
 */
test('scriptedNodes(record) and modelNodes(record, port) both carry the canonical derive_hypothesis_state and termination_check nodes, proven by behaviour rather than identity or source text', async () => {
  const { scriptedNodes, modelNodes } = await import('../scripts/lane-arms.mjs');
  const input = calibrationExecutionInput();

  let portCalls = 0;
  const fakePort = {
    async complete() {
      portCalls += 1;
      throw new Error('neither termination_check nor derive_hypothesis_state may ever reach a model port');
    },
  };

  const oneCandidateNoAssessments = {
    incident: { id: 'aic-119s3-lane-arms-termination-candidate' },
    hypotheses: [{ id: 'h-1', statement: 'a candidate cause', createdBy: 'initial' }],
    predictions: [],
    tests: [],
    trials: [{
      id: 'trial-1',
      runId: 'aic-119s3-lane-arms-termination-run',
      testId: 'test-1',
      attempt: 1,
      tool: 'logs.search',
      input: {},
      status: 'ok',
      durationMs: 10,
      evidenceIds: ['e-1'],
    }],
    evidence: [{
      id: 'e-1',
      trialId: 'trial-1',
      kind: 'deploy',
      source: 'deployment-history',
      observedAt: '2026-09-24T08:00:00.000Z',
      statement: 'observation recorded as e-1',
      rawRef: 'replay://evidence/e-1',
      reliability: 'medium',
    }],
    assessments: [],
    control: {
      runId: 'aic-119s3-lane-arms-termination-run',
      schemaVersion: domain.INCIDENT_STATE_SCHEMA_VERSION,
      statusRulesVersion: domain.STATUS_RULES_VERSION,
      phase: 'terminating',
      maxIterations: 4,
      llmCallBudget: 8,
      reservedChallengeBudget: 2,
      challengeRounds: 1,
      iterationsUsed: 0,
      llmCallsUsed: 0,
      resumeCount: 0,
      humanReview: false,
    },
  };

  for (const nodes of [scriptedNodes(input), modelNodes(input, fakePort)]) {
    const decision = await nodes.termination_check(oneCandidateNoAssessments);
    assert.deepEqual(
      decision,
      { route: 'terminal', stopKind: 'stalled' },
      'the fixture terminator hardcodes stopKind: "sufficient" regardless of state; the canonical node reads this state as T6',
    );
  }

  const danglingAssessment = {
    incident: { id: 'aic-119s3-lane-arms-derive-dangling' },
    hypotheses: [{ id: 'h-1', statement: 'a candidate cause', createdBy: 'initial' }],
    predictions: [],
    tests: [],
    trials: [],
    evidence: [],
    assessments: [{
      id: 'a-dangling',
      evidenceId: 'evidence-the-state-does-not-carry',
      hypothesisId: 'h-1',
      effect: 'supports',
      strength: 'high',
      rationale: 'names evidence nobody collected',
      producedBy: 'rule',
    }],
    control: { statusRulesVersion: domain.STATUS_RULES_VERSION },
  };

  for (const nodes of [scriptedNodes(input), modelNodes(input, fakePort)]) {
    assert.throws(
      () => nodes.derive_hypothesis_state(danglingAssessment),
      /derive_hypothesis_state:/,
      'the fixture no-op returns {} unconditionally; the canonical node refuses an assessment naming evidence the state does not carry',
    );
  }

  assert.equal(portCalls, 0, 'neither termination_check nor derive_hypothesis_state may ever reach the model port');
});

/* -------------------------------------------------------------------------- */
/* 4. the committed control baseline, under v0.3, both corpora                */
/* -------------------------------------------------------------------------- */

/**
 * The scripted control's own observed baseline, over the real plan, compared
 * against ONE committed file PER CORPUS — in both directions, so neither a
 * missing nor an extra axis can hide.
 *
 * AIC-119 slice 3 re-declares the baseline: wiring the canonical, state-driven
 * `termination_check`/`derive_hypothesis_state` into `scriptedNodes` moves
 * `termination_correctness` for the final-evaluation corpus (the hold-out
 * scenarios are not all `sufficient`-expecting), while the calibration corpus
 * stays at zero on every axis. One file can no longer declare both corpora, so
 * `docs/evidence/control-baseline.json` stays the FINAL-EVALUATION baseline
 * (read by `readControlBaseline()`, its existing default path) and
 * `docs/evidence/control-baseline-calibration.json` is the calibration
 * baseline, read by `readControlBaseline(CALIBRATION_CONTROL_BASELINE_PATH)` —
 * the ONE reader both files share (`.claude/rules/invariants.md`, "one
 * mechanism, one implementation"), never a second parser of its own.
 * Under v0.3 the lane withholds nothing, so `evidence_coverage` is among the
 * axes the control observes and both files must declare it.
 */
test('the committed control baseline files each equal what the scripted control arm observes under v0.3 — control-baseline.json for final-evaluation, control-baseline-calibration.json for calibration — with no axis missing and none extra', async () => {
  const { scriptedNodes, CALIBRATION_CONTROL_BASELINE_PATH } = await import('../scripts/eval-live-model.mjs');
  const { readControlBaseline } = await import('../scripts/eval-final-holdout.mjs');
  const runLiveModelLane = requireExport('runLiveModelLane');

  assert.equal(
    typeof CALIBRATION_CONTROL_BASELINE_PATH,
    'string',
    'scripts/eval-live-model.mjs must export CALIBRATION_CONTROL_BASELINE_PATH: the calibration command needs its own baseline path, distinct from the hold-out default readControlBaseline() reads',
  );

  const declaredByScenarioSet = {
    calibration: readControlBaseline(CALIBRATION_CONTROL_BASELINE_PATH),
    'final-evaluation': readControlBaseline(),
  };

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
      experimentId: `aic-119s3-control-baseline-${scenarioSet}`,
      headSha: HEAD_SHA,
      metadata: v3Metadata,
      async runControlArm(plan) {
        return scriptedGraphExperiment(`aic-119s3-control-${scenarioSet}`, plan);
      },
      async runModelArm(plan) {
        return scriptedGraphExperiment(`aic-119s3-model-${scenarioSet}`, plan);
      },
    });

    const observed = report.arms.control.observedBaseline;
    const declared = declaredByScenarioSet[scenarioSet];
    assert.deepEqual(
      Object.keys(observed).sort(),
      Object.keys(declared).sort(),
      `over ${scenarioSet}, its own committed baseline file must declare exactly the axes the scripted control observes under v0.3 — no axis missing, none extra`,
    );
    assert.deepEqual(
      observed,
      declared,
      `over ${scenarioSet}, its own committed baseline file must equal what the scripted control arm observes under v0.3`,
    );
  }
});

/* -------------------------------------------------------------------------- */
/* 4b. both baseline files carry a _history of what they used to declare      */
/* -------------------------------------------------------------------------- */

/**
 * `_history`'s first entry records what the file declared BEFORE AIC-119
 * slice 3 re-declared it: all six axes at 0, measured under status rules
 * `v0.1` with the fixture's constant `terminal/sufficient` terminator (the
 * termination node every baseline before this ticket was measured against).
 * Read as raw JSON, and only the six metric keys are compared — never the
 * whole entry — so this row does not pin how the entry spells its own
 * rationale or its status-rules/terminator fields.
 */
test('both docs/evidence/control-baseline.json and docs/evidence/control-baseline-calibration.json carry a non-empty _history whose first entry records the previous values as all six axes at 0', () => {
  const metricKeys = sixMetricKeys();
  assert.equal(metricKeys.length, 6);

  for (const relativePath of [
    'docs/evidence/control-baseline.json',
    'docs/evidence/control-baseline-calibration.json',
  ]) {
    const raw = JSON.parse(readFileSync(join(REPO_ROOT, relativePath), 'utf8'));
    assert.ok(Array.isArray(raw._history), `${relativePath} must carry a _history array`);
    assert.ok(raw._history.length > 0, `${relativePath}'s _history must be non-empty`);

    const [firstEntry] = raw._history;
    const previousMetrics = Object.fromEntries(metricKeys.map((key) => [key, firstEntry?.[key]]));
    assert.deepEqual(
      previousMetrics,
      Object.fromEntries(metricKeys.map((key) => [key, 0])),
      `${relativePath}'s _history[0] must record all six axes at 0, what this file declared before AIC-119 slice 3`,
    );
  }
});

/* -------------------------------------------------------------------------- */
/* 4c. scripts/eval-live-model.mjs declares the v0.3 graph                    */
/* -------------------------------------------------------------------------- */

/**
 * The scripted arm and the model arm now run the canonical, state-driven
 * `derive_hypothesis_state`/`termination_check` nodes (AIC-119 slice 3), so
 * the graph version the calibration command declares moves from `graph-v0.2`
 * to `graph-v0.3` — the same source-regex style `final-evaluation-command.test.mjs`
 * already uses for this file.
 */
test('scripts/eval-live-model.mjs declares graphVersion as graph-v0.3', () => {
  const source = readFileSync(join(REPO_ROOT, 'scripts/eval-live-model.mjs'), 'utf8');
  assert.match(
    source,
    /graphVersion:\s*'graph-v0\.3'/,
    "scripts/eval-live-model.mjs's baseMetadata must declare graphVersion as graph-v0.3",
  );
});

/* -------------------------------------------------------------------------- */
/* 4d. benchmark-level scenario independence: the lane's scriptedNodes        */
/*     termination depends on state, never on the scenario id or ground truth */
/* -------------------------------------------------------------------------- */

/**
 * Every evidence item supports `state.hypotheses[0]` at `medium` strength,
 * `producedBy: 'rule'`, one assessment id per evidence item — deterministic,
 * scenario-blind, and independent of `@aic/roles`.
 */
function deterministicSupportInterpreter(state) {
  const hypothesisId = state.hypotheses[0]?.id;
  return {
    assessments: state.evidence.map((evidenceItem) => ({
      id: `aic-119s3-deterministic-support-${evidenceItem.id}`,
      evidenceId: evidenceItem.id,
      hypothesisId,
      effect: 'supports',
      strength: 'medium',
      rationale: `deterministic interpreter: ${evidenceItem.id} supports ${hypothesisId}`,
      producedBy: 'rule',
    })),
  };
}

/**
 * Every calibration scenario supplies at least two independently-identified
 * `ok` fixture entries (`evals.BENCHMARK_SCENARIO_PARTITIONS.calibration`,
 * checked against every scenario's own fixture), so
 * `deterministicSupportInterpreter` above corroborates the sole hypothesis
 * `scriptedNodes`' fixture-based `generate_hypotheses` creates, on every one
 * of them: the real corpus alone never exercises the `stalled` branch under
 * this interpreter. `sparseEvidenceVariant` builds a scenario with the same
 * shape as a real one, its fixture trimmed to a single entry, so fewer than
 * two independent supports reach the hypothesis and T6 fires instead — the
 * two branches this row needs both come from `scriptedNodes` reading STATE,
 * never scenario identity.
 */
function sparseEvidenceVariant(scenario, id) {
  return {
    ...scenario,
    id,
    groundTruth: { ...scenario.groundTruth, expectedStopKind: 'stalled' },
    fixture: { ...scenario.fixture, entries: scenario.fixture.entries.slice(0, 1) },
  };
}

/** A renamed-id, flipped-ground-truth clone of a real scenario — nothing else about it differs. */
function renamedClone(scenario, id) {
  return {
    ...scenario,
    id,
    groundTruth: {
      ...scenario.groundTruth,
      expectedStopKind: scenario.groundTruth.expectedStopKind === 'sufficient' ? 'ambiguous' : 'sufficient',
    },
  };
}

/**
 * `runGraphBenchmarkExperiment`'s ad-hoc plan requires exactly five scenarios
 * (a v0.1 constraint unrelated to this row); two real calibration scenarios
 * fill the remaining slots and their own results are read too, corroborating
 * the same finding the header above states.
 */
test("scriptedNodes(record)'s termination depends on state, never on the scenario id or ground truth: a renamed clone of a real calibration scenario reaches the same stop kind as the original, and a sparse-evidence variant reaches a different one", async () => {
  const { scriptedNodes } = await import('../scripts/lane-arms.mjs');

  const original = evals.REPLAY_SCENARIOS.find(({ id }) => id === 'bad-deployment');
  assert.ok(original, 'the calibration corpus must still carry bad-deployment');
  const clone = renamedClone(original, 'aic-119s3-scenario-independence-clone');
  const sparse = sparseEvidenceVariant(original, 'aic-119s3-scenario-independence-sparse');
  const fillerOne = evals.REPLAY_SCENARIOS.find(({ id }) => id === 'db-pool-exhaustion');
  const fillerTwo = evals.REPLAY_SCENARIOS.find(({ id }) => id === 'false-alert');
  assert.ok(fillerOne && fillerTwo, 'the calibration corpus must still carry both filler scenarios');

  const experiment = await evals.runGraphBenchmarkExperiment({
    experimentId: 'aic-119s3-scenario-independence',
    scenarioSet: 'ad-hoc',
    scenarios: [original, clone, sparse, fillerOne, fillerTwo],
    runsPerScenario: 3,
    metadata: benchmarkVersions,
    createNodes: (record) => ({
      ...scriptedNodes(record),
      interpret_residual_evidence: deterministicSupportInterpreter,
    }),
    async recordEvaluation() {},
  });

  const stopKindsById = new Map();
  for (const [index, record] of experiment.records.entries()) {
    const stopKind = experiment.results[index].actualStopKind;
    const seenBefore = stopKindsById.get(record.scenario.id);
    assert.ok(
      seenBefore === undefined || seenBefore === stopKind,
      `every run of ${record.scenario.id} must reach the same stop kind: this interpreter and the termination node are both deterministic`,
    );
    stopKindsById.set(record.scenario.id, stopKind);
  }

  assert.equal(
    stopKindsById.get(clone.id),
    stopKindsById.get(original.id),
    'renaming the scenario id and flipping groundTruth.expectedStopKind must not change the termination decision',
  );
  assert.notEqual(
    stopKindsById.get(sparse.id),
    stopKindsById.get(original.id),
    'a state with fewer than two independent supports must reach a different termination decision than one with enough to corroborate — proving the decision tracks evidence in state, not which scenario produced it',
  );

  const reachable = new Set(stopKindsById.values());
  assert.ok(reachable.size > 1, 'the reachable stop kinds across this batch must not collapse onto one constant route');
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

/* -------------------------------------------------------------------------- */
/* 6. publishHoldoutArms / publishLiveModelArms — AIC-117 slice d, round 2    */
/* -------------------------------------------------------------------------- */

/** A model-arm experiment, scored the same deterministic way as the control. */
async function scriptedModelExperimentFor(label, plan) {
  const { scriptedNodes } = await import('../scripts/eval-live-model.mjs');
  return evals.runGraphBenchmarkExperiment({
    experimentId: `aic-117d-publish-arms-${label}`,
    scenarioSet: plan.scenarioSet,
    runsPerScenario: plan.runsPerScenario,
    metadata: plan.metadata,
    createNodes: (record) => scriptedNodes(record),
    async recordEvaluation() {},
  });
}

/**
 * A whole lane like `publishNaiveLane` above, but also letting the caller
 * override the model arm — `publishHoldoutArms`/`publishLiveModelArms` need a
 * laneReport where the model and naive arms diverge (one refused, the other
 * completed and reportable), which `publishNaiveLane`'s fixed `runModelArm`
 * cannot produce.
 */
async function fourArmLaneForPublish({ runModelArm, runNaiveArm, includeControlBaseline = true } = {}) {
  const { readControlBaseline } = await import('../scripts/eval-final-holdout.mjs');
  const runLiveModelLane = requireExport('runLiveModelLane');

  return runLiveModelLane({
    env: { [MODEL_API_KEY_VARIABLE]: fakeApiKey() },
    scenarioSet: 'calibration',
    experimentId: 'aic-117d-publish-arms',
    headSha: HEAD_SHA,
    metadata: v3Metadata,
    ...(includeControlBaseline ? { controlBaseline: readControlBaseline() } : {}),
    async runControlArm(plan) {
      return scriptedModelExperimentFor('control', plan);
    },
    ...(runNaiveArm === undefined ? {} : { runNaiveArm }),
    async runModelArm(plan) {
      if (runModelArm !== undefined) return runModelArm(plan);
      return scriptedModelExperimentFor('model', plan);
    },
  });
}

/** A reportable naive arm, captured the way both scripts capture naiveExperiment. */
function capturingNaiveArm(experimentId, assign) {
  return async (plan) => {
    const { naiveArm } = await import('../scripts/lane-arms.mjs');
    const config = Object.freeze({ modelId: 'fake-naive-model', provider: 'anthropic' });
    const experiment = await naiveArm({ experimentId, port: fakeNaivePort(), config })(plan);
    assign(experiment);
    return experiment;
  };
}

/**
 * AIC-120 replaces `publishHoldoutArms` with the pure `planHoldoutPublication`
 * (whose plan `scripts/final-holdout-publication.mjs` then executes) — LangSmith
 * publication for the hold-out moves entirely out of the lane call. The three
 * rows below restate, on the new API, the order, both-required and per-arm
 * reason-independence assertions the three deleted `publishHoldoutArms` rows
 * made — not those rows' dataset-name or exact-persisted-experiment-object
 * assertions, which moved elsewhere (see below):
 *   - "publishHoldoutArms persists the model arm then the naive arm, in order,
 *     under their own dataset names and exact experiment objects, when both are
 *     reportable" -> "planHoldoutPublication requires the model arm before the
 *     naive arm ... when both are reportable" (order + both required + the
 *     naive experiment is the one runNaiveArm actually captured)
 *   - "publishHoldoutArms persists only the naive arm, and carries the model
 *     arms own reason as publicationSkipped, when the model arm is unreportable
 *     and the naive arm is reportable" -> "planHoldoutPublication marks only the
 *     model arm not required ... while the naive arm stays required" (skip
 *     reason + arm independence)
 *   - "publishHoldoutArms persists only the model arm, and reports
 *     naivePublication absent with the refusal reason, when the naive arm
 *     refused" -> "planHoldoutPublication marks only the naive arm not required,
 *     carrying its refusal reason ... when the naive arm refused" (skip reason +
 *     arm independence, the other direction)
 * `publishHoldoutArms` itself is gone: these rows assert on `evals.planHoldoutPublication`
 * (packages/evals/src/final-evaluation-publication.ts), not on anything
 * `scripts/eval-final-holdout.mjs` exports.
 * see final-evaluation-publication.test.mjs for the exhaustive reason-by-reason
 * coverage of planHoldoutPublication; the rows here are the wiring-level
 * restatement that belongs beside fourArmLaneForPublish/capturingNaiveArm.
 *
 * The dataset-name and exact-experiment-object half of the three deleted
 * rows' assertions is not restated here: `planHoldoutPublication` is pure and
 * never calls `persist`, so it has no dataset name or persisted experiment to
 * read. That half now lives in `scripts/final-holdout-publication.mjs`'s
 * `publishRecordedMeasurement` — the dataset name is pinned in
 * `test/final-evaluation-publication.test.mjs` ›
 * "publishOnly persists each required arm under a dataset name built from the
 * record’s own head SHA and attempt number, and a retry after ingestion-failed
 * bumps the suffix", and the exact experiment object reaching `persist` per
 * arm is pinned by the same file's ›
 * "T8: naive persist succeeds and model persist rejects — the log holds model
 * ingestion-failed and naive verified, satisfied is false, and the next
 * publishOnly retries only the model arm".
 */
test('planHoldoutPublication requires the model arm before the naive arm, in FINAL_EVALUATION_PUBLISHABLE_ARMS order, when both are reportable, and the naive experiment is the one runNaiveArm actually captured', async () => {
  let modelExperiment;
  let naiveExperiment;
  const report = await fourArmLaneForPublish({
    async runModelArm(plan) {
      modelExperiment = await scriptedModelExperimentFor('model-1', plan);
      return modelExperiment;
    },
    runNaiveArm: capturingNaiveArm('aic-120-lane-arms-naive-1', (experiment) => (naiveExperiment = experiment)),
  });

  assert.equal(report.arms.model.reportable, true);
  assert.equal(report.arms.naive.reportable, true);
  assert.ok(
    naiveExperiment && naiveExperiment.records.length > 0,
    'capturingNaiveArm must have captured a real experiment inside runNaiveArm, the same capture pattern eval-final-holdout.mjs uses',
  );

  assert.deepEqual(
    [...evals.FINAL_EVALUATION_PUBLISHABLE_ARMS],
    ['model', 'naive'],
    'the publish order is model then naive, exactly what publishHoldoutArms used to hard-code',
  );

  const plan = evals.planHoldoutPublication({
    report,
    experiments: { model: modelExperiment, naive: naiveExperiment },
  });
  assert.deepEqual(Object.keys(plan), ['model', 'naive']);
  assert.deepEqual(plan.model, { required: true });
  assert.deepEqual(plan.naive, { required: true });
});

test('planHoldoutPublication marks only the model arm not required, carrying its own unreportable reason, while the naive arm stays required, when the model arm is unreportable and the naive arm is reportable', async () => {
  let naiveExperiment;
  const report = await fourArmLaneForPublish({
    async runModelArm() {
      throw new Error('model harness exploded');
    },
    runNaiveArm: capturingNaiveArm('aic-120-lane-arms-naive-2', (experiment) => (naiveExperiment = experiment)),
  });

  assert.equal(report.arms.model.reportable, false);
  assert.equal(report.arms.naive.reportable, true);

  const plan = evals.planHoldoutPublication({
    report,
    experiments: { model: undefined, naive: naiveExperiment },
  });

  assert.deepEqual(
    plan.model,
    { required: false, reason: report.arms.model.unreportableReason },
    'the plan must carry the model arms own unreportable reason, not a generic one',
  );
  assert.deepEqual(
    plan.naive,
    { required: true },
    "independence: the naive arm's requirement must not be affected by the model arm's own refusal",
  );
});

test('planHoldoutPublication marks only the naive arm not required, carrying its refusal reason, while the model arm stays required, when the naive arm refused and the model arm is reportable', async () => {
  let modelExperiment;
  const report = await fourArmLaneForPublish({
    async runModelArm(plan) {
      modelExperiment = await scriptedModelExperimentFor('model-3', plan);
      return modelExperiment;
    },
    async runNaiveArm() {
      throw new Error('naive harness exploded');
    },
  });

  assert.equal(report.arms.model.reportable, true);
  assert.equal(report.arms.naive.status, 'refused');

  const plan = evals.planHoldoutPublication({
    report,
    experiments: { model: modelExperiment, naive: undefined },
  });

  assert.deepEqual(
    plan.model,
    { required: true },
    "independence: the model arm's requirement must not be affected by the naive arm's own refusal",
  );
  assert.deepEqual(plan.naive, { required: false, reason: 'naive harness exploded' });
});

test('publishLiveModelArms rejects with the refusal message before any persist call, when the model arm is unreportable — even though the naive arm is reportable', async () => {
  const { publishLiveModelArms } = await import('../scripts/eval-live-model.mjs');

  let naiveExperiment;
  const report = await fourArmLaneForPublish({
    async runModelArm() {
      throw new Error('model harness exploded');
    },
    runNaiveArm: capturingNaiveArm('aic-117d-publish-live-naive-1', (experiment) => (naiveExperiment = experiment)),
  });

  assert.equal(report.arms.model.reportable, false);
  assert.equal(report.arms.naive.reportable, true);

  let persistCalls = 0;
  await assert.rejects(
    () =>
      publishLiveModelArms({
        laneReport: report,
        modelExperiment: undefined,
        naiveExperiment,
        headSha: HEAD_SHA,
        async persist() {
          persistCalls += 1;
          return { datasetId: 'd', projects: [], runIds: [] };
        },
      }),
    (error) => error.message === `refusing to publish an unreportable model arm: ${report.arms.model.unreportableReason}`,
  );
  assert.equal(persistCalls, 0, 'not even the reportable naive arm may be published once the model arm is refused');
});

test('publishLiveModelArms persists the model arm then the naive arm and returns the naive publication, when both are reportable', async () => {
  const { publishLiveModelArms } = await import('../scripts/eval-live-model.mjs');

  let modelExperiment;
  let naiveExperiment;
  const report = await fourArmLaneForPublish({
    async runModelArm(plan) {
      modelExperiment = await scriptedModelExperimentFor('model-5', plan);
      return modelExperiment;
    },
    runNaiveArm: capturingNaiveArm('aic-117d-publish-live-naive-2', (experiment) => (naiveExperiment = experiment)),
  });

  assert.equal(report.arms.model.reportable, true);
  assert.equal(report.arms.naive.reportable, true);

  const calls = [];
  async function persist(options) {
    calls.push(options);
    return { datasetId: `d-${calls.length}`, projects: [], runIds: [] };
  }

  const result = await publishLiveModelArms({ laneReport: report, modelExperiment, naiveExperiment, headSha: HEAD_SHA, persist });

  assert.deepEqual(
    calls,
    [
      { datasetName: `aic-94-live-model-${HEAD_SHA12}`, experiment: modelExperiment },
      { datasetName: `aic-94-live-model-naive-${HEAD_SHA12}`, experiment: naiveExperiment },
    ],
    'the model persist call must happen before the naive one',
  );
  assert.deepEqual(result, { naive: { status: 'published', datasetId: 'd-2', projects: [], runIds: [] } });
});

/**
 * The text between the `{` immediately following the first occurrence of
 * `marker` and its matching closing `}`, found by counting braces rather than
 * slicing to EOF. Round-1 review (code-reviewer + security-scanner HOLD) found
 * that an EOF slice from `flag('publish')` stayed green under three defects at
 * once — dropping the naive-experiment capture, coupling the hold-out's naive
 * publication to the model's, or hoisting the call out of the `--publish`
 * path — because none of those moves the matched text outside an EOF slice.
 * Brace-matched extraction narrows the audit to the one block each assertion
 * below means to pin.
 */
function bracedBodyAfter(source, marker) {
  // A string marker is matched literally; a RegExp marker is needed for
  // `flag('publish') ? {`, which both scripts wrap across a line break.
  const markerIndex = typeof marker === 'string' ? source.indexOf(marker) : source.search(marker);
  assert.ok(markerIndex >= 0, `expected to find ${marker} in the source`);
  const openIndex = source.indexOf('{', markerIndex);
  assert.ok(openIndex >= 0, `expected an opening brace after ${marker}`);
  let depth = 0;
  for (let i = openIndex; i < source.length; i += 1) {
    if (source[i] === '{') depth += 1;
    else if (source[i] === '}') {
      depth -= 1;
      if (depth === 0) return source.slice(openIndex + 1, i);
    }
  }
  throw new Error(`unterminated brace body after ${JSON.stringify(marker)}`);
}

/**
 * Narrowed replacement for the EOF-slicing row this file used to carry: the
 * `publish(laneReport)` callback's own body (not everything after it) must
 * call `publishLiveModelArms`, that callback must sit inside the
 * `flag('publish') ? {` spread (not merely somewhere after it), and
 * `runNaiveArm`'s own body must assign `naiveExperiment`.
 */
test('eval-live-model.mjs calls publishLiveModelArms inside the body of its publish(laneReport) callback, which sits inside the flag(\'publish\') spread, and runNaiveArm assigns naiveExperiment', () => {
  const source = readFileSync(join(REPO_ROOT, 'scripts/eval-live-model.mjs'), 'utf8');

  const spreadBody = bracedBodyAfter(source, /flag\('publish'\)\s*\?\s*\{/);
  assert.match(
    spreadBody,
    /async publish\(laneReport\)/,
    "the publish(laneReport) callback must sit inside the flag('publish') ? { spread",
  );

  const publishBody = bracedBodyAfter(source, 'async publish(laneReport) {');
  assert.match(
    publishBody,
    /publishLiveModelArms\(/,
    'the body of publish(laneReport) must call publishLiveModelArms',
  );

  const naiveArmBody = bracedBodyAfter(source, 'async runNaiveArm(plan) {');
  assert.match(
    naiveArmBody,
    /naiveExperiment\s*=/,
    'the body of runNaiveArm must assign naiveExperiment',
  );
});

/**
 * AIC-120 replaces the sibling row above (`eval-final-holdout.mjs calls
 * publishHoldoutArms inside the body of its publish(laneReport) callback...`):
 * there is no `publish(laneReport)` callback and no `naivePublication` field
 * any more — LangSmith publication for the hold-out moved out of the lane call
 * entirely, into `completeHoldout`/`publishRecordedMeasurement`
 * (scripts/eval-final-holdout.mjs, scripts/final-holdout-publication.mjs). What
 * survives from the deleted row is the one assertion still true under the new
 * design — `runNaiveArm` still assigns `naiveExperiment`, because
 * `completeHoldout`'s `execute()` closure still needs to capture it — plus the
 * new invariant this ticket adds: the options object handed to
 * `runLiveModelLane` carries no `publish` key at all.
 * see final-evaluation-publication.test.mjs › "T12: a persist that reads the record file AT CALL TIME sees status complete, proving the durable write happens before any publication attempt"
 * see final-evaluation-publication.test.mjs › "scripts/eval-final-holdout.mjs passes runLiveModelLane no publish option any more"
 */
test("eval-final-holdout.mjs's runNaiveArm still assigns naiveExperiment, and its runLiveModelLane call carries no publish key any more", () => {
  const source = readFileSync(join(REPO_ROOT, 'scripts/eval-final-holdout.mjs'), 'utf8');

  const naiveArmBody = bracedBodyAfter(source, 'async runNaiveArm(plan) {');
  assert.match(
    naiveArmBody,
    /naiveExperiment\s*=/,
    "the body of runNaiveArm must assign naiveExperiment: completeHoldout's execute() closure still captures it for planHoldoutPublication and the record",
  );

  const laneBody = bracedBodyAfter(source, 'evals.runLiveModelLane({');
  assert.doesNotMatch(
    laneBody,
    /\bpublish\s*[:(]/,
    'AIC-120: LangSmith publication moved entirely out of the lane call and into completeHoldout/publishRecordedMeasurement, so the options object handed to runLiveModelLane must carry no publish key',
  );
});
