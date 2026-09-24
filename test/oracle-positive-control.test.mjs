/**
 * AIC-113 (v0.2 evidence repair, slice 0a): the evaluator-side ORACLE
 * positive-control arm.
 *
 * A positive control answers one question the model arms cannot: "does the
 * evaluator itself ever score a perfect run as perfect, and a wrong one as
 * wrong?" An arm that PROJECTS ground truth, rather than investigating,
 * exercises exactly the evaluator's own scoring path with an answer nobody
 * tuned against it. If the oracle cannot score well on scenarios it is
 * handed the answer to, the evaluator — not the model — is what is broken.
 *
 * The oracle is deliberately NOT perfect here: it is only allowed to cite
 * evidence ids that are actually shown by a fixture, and it identifies a
 * shown item as "the expected/misleading evidence" only by exact
 * `{kind, source, statement}` == `{kind, source, predicate}` equality against
 * a ground-truth fingerprint. None of the fixture statements in
 * `replay-scenarios.ts` are word-for-word equal to their own ground-truth
 * predicates (the predicates are hand-written expectations, the statements
 * are hand-written fixture text — nobody kept them byte-identical), so the
 * oracle can identify nothing on the calibration partition and its measured
 * scores are exactly what the code produces when it is told the true root
 * cause and still cannot find a citation for it. That is what section E below
 * pins, read off the code by hand rather than computed by it.
 *
 * What the rows pin:
 *  - the `@aic/evals` root exports `ArmAnswer`, `shownEvidenceOf`,
 *    `outcomeFromArmAnswer` and `METRIC_BEST_VALUES`, and never the oracle;
 *  - the oracle is reachable only as `@aic/evals/oracle`, and a
 *    dependency-cruiser rule refuses an import of it from `packages/` or
 *    `apps/`, by subpath or by relative path;
 *  - the oracle's citation path and its leader-change path each work on a
 *    hand-built scenario, so an all-zero calibration table cannot be the
 *    oracle failing to cite;
 *  - `scripts/eval-oracle.mjs` prints the calibration report, and
 *    `docs/evidence/oracle/behavior-evaluators-v0.2.json` is its committed
 *    output.
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import * as evals from '@aic/evals';
import { MODEL_API_KEY_VARIABLE } from '@aic/roles';

import { benchmarkVersions } from './fixtures/benchmark-experiment.mjs';
import { childEnv } from './fixtures/child-env.mjs';

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/* -------------------------------------------------------------------------- */
/* A. shownEvidenceOf, outcomeFromArmAnswer, METRIC_BEST_VALUES (root export) */
/* -------------------------------------------------------------------------- */

function makeEvidence(id, kind, source, statement) {
  return {
    id,
    trialId: `trial-${id}`,
    kind,
    source,
    observedAt: '2026-09-24T00:00:00.000Z',
    statement,
    rawRef: `unit://${source}/${id}`,
  };
}

const evidenceA = makeEvidence('ev-a', 'log', 'logs/unit', 'A statement');
const evidenceB = makeEvidence('ev-b', 'metric', 'metrics/unit', 'B statement');
// Shown by the fixture, but cited by neither a cause nor an assessment below —
// the row `outcomeFromArmAnswer` must never fingerprint.
const evidenceC = makeEvidence('ev-c', 'log', 'logs/unit', 'C statement, never cited');

/** Two `ok` entries and one non-`ok` entry, per the ticket's hand-built fixture. */
const handBuiltFixture = Object.freeze({
  version: 1,
  entries: Object.freeze([
    Object.freeze({
      toolId: 'logs',
      input: {},
      result: Object.freeze({ status: 'ok', output: Object.freeze([evidenceA, evidenceC]) }),
    }),
    Object.freeze({
      toolId: 'metrics',
      input: {},
      result: Object.freeze({ status: 'ok', output: Object.freeze([evidenceB]) }),
    }),
    Object.freeze({
      toolId: 'traces',
      input: {},
      result: Object.freeze({ status: 'unavailable', reason: 'not collected' }),
    }),
  ]),
});

/** One cause citing a shown id and an id the fixture never showed. */
const answerBase = Object.freeze({
  hypotheses: Object.freeze([Object.freeze({ id: 'hyp-1', statement: 'main hypothesis' })]),
  assessments: Object.freeze([
    Object.freeze({ evidenceId: 'ev-b', hypothesisId: 'hyp-1', effect: 'supports' }),
    // Cited, but never shown: must not survive into evidenceAssessments.
    Object.freeze({ evidenceId: 'ev-unknown', hypothesisId: 'hyp-1', effect: 'contradicts' }),
  ]),
  conclusion: Object.freeze({
    kind: 'root-cause',
    causes: Object.freeze([
      Object.freeze({
        hypothesisId: 'hyp-1',
        cause: Object.freeze({ component: 'x', mechanism: 'y' }),
        evidenceIds: Object.freeze(['ev-a', 'ev-unknown']),
      }),
    ]),
  }),
  stopKind: 'sufficient',
});

test('exports the oracle-positive-control building blocks from the @aic/evals package root', () => {
  assert.equal(typeof evals.shownEvidenceOf, 'function', '@aic/evals must export shownEvidenceOf');
  assert.equal(typeof evals.outcomeFromArmAnswer, 'function', '@aic/evals must export outcomeFromArmAnswer');
});

test('METRIC_BEST_VALUES pins the best value of every metric this evaluator publishes, frozen', () => {
  assert.deepEqual(evals.METRIC_BEST_VALUES, {
    unsupported_claim_rate: 0,
    evidence_coverage: 1,
    termination_correctness: 1,
    misleading_evidence_handling: 1,
    false_alert_correctness: 1,
    challenge_effect: 1,
  });
  assert.equal(Object.isFrozen(evals.METRIC_BEST_VALUES), true);
});

test('shownEvidenceOf flattens every ok fixture entry\'s evidence, in fixture entry order', () => {
  assert.deepEqual(evals.shownEvidenceOf(handBuiltFixture), [evidenceA, evidenceC, evidenceB]);
});

test('shownEvidenceOf contributes nothing from a non-ok fixture entry', () => {
  const nonOkOnly = Object.freeze({
    version: 1,
    entries: Object.freeze([
      Object.freeze({ toolId: 'traces', input: {}, result: Object.freeze({ status: 'unavailable', reason: 'x' }) }),
      Object.freeze({ toolId: 'logs', input: {}, result: Object.freeze({ status: 'error', message: 'y' }) }),
    ]),
  });
  assert.deepEqual(evals.shownEvidenceOf(nonOkOnly), []);
});

test('outcomeFromArmAnswer derives claims directly from the conclusion causes\' evidenceIds', () => {
  const outcome = evals.outcomeFromArmAnswer({ answer: answerBase, fixture: handBuiltFixture });
  assert.deepEqual(outcome.claims, [{ evidenceIds: ['ev-a', 'ev-unknown'] }]);
});

test('outcomeFromArmAnswer excludes a cause evidenceId the fixture never showed from supportingEvidenceIds', () => {
  const outcome = evals.outcomeFromArmAnswer({ answer: answerBase, fixture: handBuiltFixture });
  assert.deepEqual(outcome.supportingEvidenceIds, ['ev-a']);
});

test('outcomeFromArmAnswer fingerprints only evidence a cause or an assessment referenced, never evidence shown but uncited', () => {
  const outcome = evals.outcomeFromArmAnswer({ answer: answerBase, fixture: handBuiltFixture });
  assert.deepEqual(outcome.evidenceFingerprints, [
    { kind: 'log', source: 'logs/unit', predicate: 'A statement' },
    { kind: 'metric', source: 'metrics/unit', predicate: 'B statement' },
  ]);
});

test('outcomeFromArmAnswer drops an evidenceAssessment whose evidenceId the fixture never showed', () => {
  const outcome = evals.outcomeFromArmAnswer({ answer: answerBase, fixture: handBuiltFixture });
  assert.deepEqual(outcome.evidenceAssessments, [
    {
      fingerprint: { kind: 'metric', source: 'metrics/unit', predicate: 'B statement' },
      hypothesisId: 'hyp-1',
      effect: 'supports',
    },
  ]);
});

test('outcomeFromArmAnswer derives rootCause and rootCauseHypothesisId from the first cause', () => {
  const outcome = evals.outcomeFromArmAnswer({ answer: answerBase, fixture: handBuiltFixture });
  assert.deepEqual(outcome.rootCause, { component: 'x', mechanism: 'y' });
  assert.equal(outcome.rootCauseHypothesisId, 'hyp-1');
});

test('outcomeFromArmAnswer carries stopKind and conclusionKind straight from the answer', () => {
  const outcome = evals.outcomeFromArmAnswer({ answer: answerBase, fixture: handBuiltFixture });
  assert.equal(outcome.stopKind, 'sufficient');
  assert.equal(outcome.conclusionKind, 'root-cause');
});

test('outcomeFromArmAnswer reports empty claims and no supporting evidence when the conclusion has no causes', () => {
  const noCausesAnswer = { ...answerBase, conclusion: { kind: 'no-incident', causes: [] } };
  const outcome = evals.outcomeFromArmAnswer({ answer: noCausesAnswer, fixture: handBuiltFixture });
  assert.deepEqual(outcome.claims, []);
  assert.deepEqual(outcome.supportingEvidenceIds, []);
});

test('outcomeFromArmAnswer omits challengeEffect entirely when the caller does not supply one', () => {
  const outcome = evals.outcomeFromArmAnswer({ answer: answerBase, fixture: handBuiltFixture });
  assert.equal(Object.hasOwn(outcome, 'challengeEffect'), false);
});

test('outcomeFromArmAnswer passes challengeEffect through unchanged when the caller supplies one', () => {
  const challengeEffect = Object.freeze({
    challengeNodeExecuted: true,
    challengeInvocationCount: 1,
    leaderBeforeChallengeId: 'hyp-1',
    leaderAfterChallengeId: 'hyp-1',
    executedDiscriminatingTrialCount: 1,
  });
  const outcome = evals.outcomeFromArmAnswer({
    answer: answerBase,
    fixture: handBuiltFixture,
    challengeEffect,
  });
  assert.deepEqual(outcome.challengeEffect, challengeEffect);
});

/* -------------------------------------------------------------------------- */
/* B. @aic/evals/oracle — reachable only by name, never from the root         */
/* -------------------------------------------------------------------------- */

test('never exports the oracle arm from the @aic/evals package root', () => {
  for (const name of ['ORACLE_ARM', 'oracleAnswerFor', 'runOracleBenchmarkExperiment']) {
    assert.equal(
      Object.hasOwn(evals, name),
      false,
      `@aic/evals must not export ${name} from its root: an evaluator that reads ground truth must be reachable only by its own subpath`,
    );
  }
});

test('exports ORACLE_ARM, oracleAnswerFor and runOracleBenchmarkExperiment from the @aic/evals/oracle subpath', async () => {
  const oracle = await import('@aic/evals/oracle');
  assert.equal(typeof oracle.oracleAnswerFor, 'function');
  assert.equal(typeof oracle.runOracleBenchmarkExperiment, 'function');
  assert.deepEqual(oracle.ORACLE_ARM, { arm: 'oracle', role: 'positive-control' });
  assert.equal(Object.isFrozen(oracle.ORACLE_ARM), true, 'ORACLE_ARM must be frozen');
});

test('oracleAnswerFor identifies no evidence for bad-deployment, because no fixture statement equals the ground-truth predicate', async () => {
  const { oracleAnswerFor } = await import('@aic/evals/oracle');
  const scenario = evals.REPLAY_SCENARIOS.find(({ id }) => id === 'bad-deployment');
  assert.ok(scenario, 'the bad-deployment calibration scenario must exist');

  const { answer, challengeEffect } = oracleAnswerFor(scenario);

  assert.equal(answer.stopKind, scenario.groundTruth.expectedStopKind);
  assert.equal(answer.conclusion.kind, scenario.groundTruth.expectedConclusionKind);
  assert.equal(answer.conclusion.causes.length, 1);
  assert.deepEqual(answer.conclusion.causes[0].cause, scenario.groundTruth.rootCause);
  assert.deepEqual(answer.conclusion.causes[0].evidenceIds, []);
  assert.ok(
    answer.hypotheses.some(({ id }) => id === answer.conclusion.causes[0].hypothesisId),
    'the cause must name a hypothesis the answer actually declares',
  );
  assert.deepEqual(answer.assessments, []);
  assert.equal(challengeEffect, undefined);
});

test('oracleAnswerFor reports no causes for false-alert, because its ground truth declares no root cause', async () => {
  const { oracleAnswerFor } = await import('@aic/evals/oracle');
  const scenario = evals.REPLAY_SCENARIOS.find(({ id }) => id === 'false-alert');
  assert.ok(scenario, 'the false-alert calibration scenario must exist');

  const { answer } = oracleAnswerFor(scenario);

  assert.equal(answer.stopKind, scenario.groundTruth.expectedStopKind);
  assert.equal(answer.conclusion.kind, scenario.groundTruth.expectedConclusionKind);
  assert.deepEqual(answer.conclusion.causes, []);
});

test('oracleAnswerFor identifies no misleading evidence for dependency-caused-incident-b, because no fixture statement equals that predicate either', async () => {
  const { oracleAnswerFor } = await import('@aic/evals/oracle');
  const scenario = evals.REPLAY_SCENARIOS.find(({ id }) => id === 'dependency-caused-incident-b');
  assert.ok(scenario, 'the dependency-caused-incident-b calibration scenario must exist');

  const { answer } = oracleAnswerFor(scenario);

  assert.equal(answer.conclusion.causes.length, 1);
  assert.deepEqual(answer.conclusion.causes[0].evidenceIds, []);
  assert.deepEqual(answer.assessments, []);
});

test('oracleAnswerFor reports an unchanged leader across the challenge for challenge-keeps-leader (expectedLeaderChangeAfterChallenge: false)', async () => {
  const { oracleAnswerFor } = await import('@aic/evals/oracle');
  const scenario = evals.REPLAY_SCENARIOS.find(({ id }) => id === 'challenge-keeps-leader');
  assert.ok(scenario, 'the challenge-keeps-leader calibration scenario must exist');
  assert.equal(scenario.groundTruth.expectedLeaderChangeAfterChallenge, false);

  const { challengeEffect } = oracleAnswerFor(scenario);

  assert.ok(challengeEffect, 'challengeEffect must be present when expectedLeaderChangeAfterChallenge is declared');
  assert.equal(challengeEffect.challengeNodeExecuted, true);
  assert.equal(challengeEffect.challengeInvocationCount, 1);
  assert.equal(challengeEffect.executedDiscriminatingTrialCount, 1);
  assert.equal(
    challengeEffect.leaderBeforeChallengeId,
    challengeEffect.leaderAfterChallengeId,
    'the leader must not change when expectedLeaderChangeAfterChallenge is false',
  );
});

/**
 * Two hand-built scenarios, because the calibration corpus exercises neither
 * path below: no fixture statement there equals its own predicate, and no
 * calibration scenario expects the leader to change. Without these rows an
 * oracle that could never cite, or never report a changed leader, would print
 * the same table as the real one. Hand-built rather than read from the hold-out,
 * which repair work never reads.
 */
const citationProbeScenario = Object.freeze({
  id: 'oracle-citation-probe',
  groundTruth: Object.freeze({
    rootCause: Object.freeze({ component: 'probe-api', mechanism: 'probe mechanism' }),
    expectedStopKind: 'sufficient',
    expectedConclusionKind: 'root-cause',
    expectedEvidence: Object.freeze([
      Object.freeze({ kind: 'log', source: 'logs/probe', predicate: 'probe failure observed' }),
    ]),
    misleadingEvidence: Object.freeze([
      Object.freeze({ kind: 'deploy', source: 'deployments/probe', predicate: 'probe deploy overlapped' }),
    ]),
  }),
  fixture: Object.freeze({
    version: 1,
    entries: Object.freeze([
      Object.freeze({ toolId: 'logs', input: {}, result: Object.freeze({ status: 'ok', output: Object.freeze([makeEvidence('probe-log', 'log', 'logs/probe', 'probe failure observed')]) }) }),
      Object.freeze({ toolId: 'deployments', input: {}, result: Object.freeze({ status: 'ok', output: Object.freeze([makeEvidence('probe-deploy', 'deploy', 'deployments/probe', 'probe deploy overlapped')]) }) }),
      Object.freeze({ toolId: 'metrics', input: {}, result: Object.freeze({ status: 'ok', output: Object.freeze([makeEvidence('probe-noise', 'metric', 'metrics/probe', 'unrelated metric')]) }) }),
    ]),
  }),
});

function probeRecord(scenario) {
  return {
    experimentId: 'oracle-probe',
    exampleId: 'oracle-probe-example',
    scenario,
    runId: 'oracle-probe-run',
    threadId: 'oracle-probe-run',
    metadata: { ...benchmarkVersions, runId: 'oracle-probe-run', scenarioId: scenario.id, humanReview: false },
  };
}

test('oracleAnswerFor cites a shown item whose statement equals its ground-truth predicate, and the evaluator scores that answer best', async () => {
  const { oracleAnswerFor } = await import('@aic/evals/oracle');
  const { answer } = oracleAnswerFor(citationProbeScenario);

  assert.deepEqual(answer.conclusion.causes[0].evidenceIds, ['probe-log']);
  assert.deepEqual(
    answer.assessments.map(({ evidenceId, effect }) => [evidenceId, effect]),
    [['probe-log', 'supports'], ['probe-deploy', 'contradicts']],
  );

  const result = evals.evaluateBenchmarkRecord({
    record: probeRecord(citationProbeScenario),
    outcome: evals.outcomeFromArmAnswer({ answer, fixture: citationProbeScenario.fixture }),
  });
  assert.equal(result.metrics.unsupported_claim_rate.score, 0);
  assert.equal(result.metrics.evidence_coverage.score, 1);
  assert.equal(result.metrics.termination_correctness.score, 1);
  assert.equal(result.behaviorMetrics.misleading_evidence_handling.score, 1);
  assert.equal(result.behaviorMetrics.misleading_evidence_handling.reason, 'passed');
});

test('oracleAnswerFor reports a changed leader when the ground truth expects the challenge to change it, and the evaluator scores that best', async () => {
  const { oracleAnswerFor } = await import('@aic/evals/oracle');
  const scenario = {
    ...citationProbeScenario,
    id: 'oracle-leader-change-probe',
    groundTruth: { ...citationProbeScenario.groundTruth, expectedLeaderChangeAfterChallenge: true },
  };
  const { answer, challengeEffect } = oracleAnswerFor(scenario);

  assert.ok(challengeEffect, 'a declared leader-change expectation must produce a challenge observation');
  assert.notEqual(challengeEffect.leaderBeforeChallengeId, challengeEffect.leaderAfterChallengeId);
  const hypothesisIds = new Set(answer.hypotheses.map(({ id }) => id));
  assert.ok(hypothesisIds.has(challengeEffect.leaderBeforeChallengeId), 'the leader before the challenge must be a hypothesis the answer declares');
  assert.ok(hypothesisIds.has(challengeEffect.leaderAfterChallengeId), 'the leader after the challenge must be a hypothesis the answer declares');
  assert.equal(challengeEffect.leaderAfterChallengeId, answer.conclusion.causes[0].hypothesisId);

  const result = evals.evaluateBenchmarkRecord({
    record: probeRecord(scenario),
    outcome: evals.outcomeFromArmAnswer({ answer, fixture: scenario.fixture, challengeEffect }),
  });
  assert.equal(result.behaviorMetrics.challenge_effect.score, 1);
  assert.equal(result.behaviorMetrics.challenge_effect.reason, 'passed');
});

test('METRIC_BEST_VALUES names exactly the metrics the benchmark and behavior evaluators publish, in both directions', () => {
  const published = [...evals.BENCHMARK_METRIC_KEYS, ...evals.BEHAVIOR_METRIC_KEYS].sort();
  assert.deepEqual(Object.keys(evals.METRIC_BEST_VALUES).sort(), published);
});

test('cites only evidence ids the fixture actually shows, for every calibration scenario (never a hold-out one)', async () => {
  const { oracleAnswerFor } = await import('@aic/evals/oracle');
  const calibrationIds = new Set(evals.BENCHMARK_SCENARIO_PARTITIONS.calibration);
  const scenarios = evals.REPLAY_SCENARIOS.filter(({ id }) => calibrationIds.has(id));
  assert.equal(scenarios.length, evals.BENCHMARK_SCENARIO_PARTITIONS.calibration.length);

  for (const scenario of scenarios) {
    const shownIds = new Set(evals.shownEvidenceOf(scenario.fixture).map(({ id }) => id));
    const { answer } = oracleAnswerFor(scenario);
    const citedIds = [
      ...answer.conclusion.causes.flatMap(({ evidenceIds }) => evidenceIds),
      ...answer.assessments.map(({ evidenceId }) => evidenceId),
    ];
    for (const id of citedIds) {
      assert.ok(shownIds.has(id), `scenario ${scenario.id} cited an evidence id its fixture never showed: ${id}`);
    }
  }
});

test('completes an oracle run with fetch replaced by a function that throws and no model credential in the environment', async () => {
  const oracle = await import('@aic/evals/oracle');
  const originalFetch = globalThis.fetch;
  const hadCredential = Object.hasOwn(process.env, MODEL_API_KEY_VARIABLE);
  const savedCredential = process.env[MODEL_API_KEY_VARIABLE];

  globalThis.fetch = () => {
    throw new Error('no provider call is permitted from the oracle positive-control arm');
  };
  delete process.env[MODEL_API_KEY_VARIABLE];

  try {
    const experiment = await oracle.runOracleBenchmarkExperiment({
      experimentId: 'oracle-positive-control-no-provider',
      scenarioSet: 'calibration',
      runsPerScenario: 3,
      metadata: benchmarkVersions,
      async recordEvaluation() {},
    });
    assert.equal(
      experiment.results.length,
      evals.BENCHMARK_SCENARIO_PARTITIONS.calibration.length * 3,
      'the oracle run must complete every calibration example without a provider',
    );
  } finally {
    globalThis.fetch = originalFetch;
    if (hadCredential) process.env[MODEL_API_KEY_VARIABLE] = savedCredential;
  }
});

/* -------------------------------------------------------------------------- */
/* C. dependency-cruiser: nothing outside oracle-arm.ts may import it         */
/* -------------------------------------------------------------------------- */

/**
 * The exact probe shape `test/durable-run-boundaries.test.mjs`'s
 * `copyForBoundaryProbe`/`runDepcruiseProbe` uses, duplicated here rather than
 * imported — that file's own header explains why (that file exports nothing,
 * and every existing depcruise probe in this repository accepts the same
 * duplication rather than manufacturing a shared import for it).
 */
function copyForBoundaryProbe() {
  const temporaryRoot = mkdtempSync(join(tmpdir(), 'aic-oracle-boundary-'));
  const fixtureRoot = join(temporaryRoot, 'repository');
  const excludedEntries = new Set([
    '.agents',
    '.claude',
    '.codex',
    '.git',
    '.github',
    'coverage',
    'node_modules',
  ]);

  cpSync(projectRoot, fixtureRoot, {
    recursive: true,
    filter(source) {
      const pathFromRoot = relative(projectRoot, source);
      return pathFromRoot === '' || !excludedEntries.has(pathFromRoot.split('/')[0]);
    },
  });

  const sourceNodeModules = resolve(projectRoot, 'node_modules');
  if (existsSync(sourceNodeModules)) {
    symlinkSync(sourceNodeModules, resolve(fixtureRoot, 'node_modules'), 'dir');
  }

  return { fixtureRoot, temporaryRoot };
}

function writeProbeSource(fixtureRoot, packageDirectory, source) {
  const path = resolve(fixtureRoot, packageDirectory, 'src/__boundary_probe__.ts');
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, source);
}

function runNpm(args, cwd) {
  return spawnSync('npm', args, {
    cwd,
    encoding: 'utf8',
    env: childEnv({ CI: '1' }),
  });
}

function commandDiagnostics(command, result) {
  return `${command} exited ${result.status}\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`;
}

function runDepcruiseProbe(mutate) {
  const { fixtureRoot, temporaryRoot } = copyForBoundaryProbe();
  try {
    const baseline = runNpm(['run', '--silent', 'lint:graph'], fixtureRoot);
    assert.equal(
      baseline.status,
      0,
      `the unmodified scaffold must pass npm run lint:graph before a boundary probe is meaningful\n${commandDiagnostics('npm run lint:graph', baseline)}`,
    );

    mutate(fixtureRoot);
    return runNpm(['run', '--silent', 'lint:graph'], fixtureRoot);
  } finally {
    rmSync(temporaryRoot, { recursive: true, force: true });
  }
}

test('rejects packages/graph importing @aic/evals/oracle', () => {
  const result = runDepcruiseProbe((fixtureRoot) =>
    writeProbeSource(fixtureRoot, 'packages/graph', 'import "@aic/evals/oracle";\n'),
  );
  assert.notEqual(
    result.status,
    0,
    `npm run lint:graph accepted a graph import of @aic/evals/oracle: the ground-truth-reading oracle arm must never be reachable from outside its own module\n${commandDiagnostics('npm run lint:graph', result)}`,
  );
  assert.match(
    result.stdout + result.stderr,
    /oracle-arm-is-evaluator-side-only/,
    `the refusal must come from oracle-arm-is-evaluator-side-only itself, not only from a broader rule beside it that would mask its removal\n${commandDiagnostics('npm run lint:graph', result)}`,
  );
});

test('rejects a file in packages/evals/src, other than oracle-arm.ts itself, importing oracle-arm by relative path', () => {
  const result = runDepcruiseProbe((fixtureRoot) =>
    writeProbeSource(fixtureRoot, 'packages/evals', 'import "./oracle-arm.js";\n'),
  );
  assert.notEqual(
    result.status,
    0,
    `npm run lint:graph accepted a relative import of oracle-arm.js from a different module in packages/evals/src: only oracle-arm.ts itself may reference the module it defines\n${commandDiagnostics('npm run lint:graph', result)}`,
  );
  assert.match(
    result.stdout + result.stderr,
    /oracle-arm-is-evaluator-side-only/,
    `the refusal must come from oracle-arm-is-evaluator-side-only itself, not only from a broader rule beside it that would mask its removal\n${commandDiagnostics('npm run lint:graph', result)}`,
  );
});

test('rejects apps/cli, the shipped binary, importing @aic/evals/oracle', () => {
  const result = runDepcruiseProbe((fixtureRoot) =>
    writeProbeSource(fixtureRoot, 'apps/cli', 'import "@aic/evals/oracle";\n'),
  );
  assert.notEqual(
    result.status,
    0,
    `npm run lint:graph accepted an apps/cli import of @aic/evals/oracle: the shipped application must not reach the ground-truth-reading oracle either\n${commandDiagnostics('npm run lint:graph', result)}`,
  );
  assert.match(
    result.stdout + result.stderr,
    /oracle-arm-is-evaluator-side-only/,
    `the refusal must come from oracle-arm-is-evaluator-side-only itself, not only from a broader rule beside it that would mask its removal\n${commandDiagnostics('npm run lint:graph', result)}`,
  );
});

test('rejects packages/graph importing the @aic/evals root, where the scenarios and their ground truth live', () => {
  const result = runDepcruiseProbe((fixtureRoot) =>
    writeProbeSource(fixtureRoot, 'packages/graph', 'import { REPLAY_SCENARIOS } from "@aic/evals";\nexport const leaked = REPLAY_SCENARIOS;\n'),
  );
  assert.notEqual(
    result.status,
    0,
    `npm run lint:graph accepted a graph import of the @aic/evals root: an investigating layer must not be able to read benchmark ground truth\n${commandDiagnostics('npm run lint:graph', result)}`,
  );
  assert.match(
    result.stdout + result.stderr,
    /benchmark-ground-truth-is-evaluator-side-only/,
    `the refusal must come from benchmark-ground-truth-is-evaluator-side-only itself, not only from a broader rule beside it that would mask its removal\n${commandDiagnostics('npm run lint:graph', result)}`,
  );
});

test('reachesBest does not count a metric no scenario emitted as reached', async () => {
  const { reachesBestOf } = await import('../scripts/eval-oracle.mjs');
  const scenarios = [{ scenarioId: 'only', metrics: { termination_correctness: { score: 1 } } }];
  assert.deepEqual(reachesBestOf(scenarios, { termination_correctness: 1, challenge_effect: 1 }), {
    termination_correctness: { reached: true, scenariosBelowBest: [] },
    challenge_effect: { reached: false, scenariosBelowBest: [] },
  });
});

test('declares the oracle report as an npm script, so it is invoked by name and built first', () => {
  const manifest = JSON.parse(readFileSync(resolve(projectRoot, 'package.json'), 'utf8'));
  assert.equal(typeof manifest.scripts['eval:oracle'], 'string');
  assert.match(manifest.scripts['eval:oracle'], /npm run build/);
  assert.match(manifest.scripts['eval:oracle'], /scripts\/eval-oracle\.mjs/);
});

/* -------------------------------------------------------------------------- */
/* D + E. scripts/eval-oracle.mjs, its committed evidence, and the pinned     */
/* hand-derived calibration table (the independent oracle for this suite)    */
/* -------------------------------------------------------------------------- */

const EVIDENCE_PATH = resolve(projectRoot, 'docs/evidence/oracle/behavior-evaluators-v0.2.json');

function runEvalOracleScript() {
  return spawnSync(
    process.execPath,
    ['--import', './test/fixtures/no-ambient-tracing.mjs', 'scripts/eval-oracle.mjs'],
    { cwd: projectRoot, encoding: 'utf8', env: childEnv() },
  );
}

test('scripts/eval-oracle.mjs prints JSON on stdout that deep-equals the committed evidence file', () => {
  const executed = runEvalOracleScript();
  assert.equal(
    executed.status,
    0,
    `node scripts/eval-oracle.mjs exited ${executed.status}\nstdout:\n${executed.stdout}\nstderr:\n${executed.stderr}`,
  );

  let fresh;
  assert.doesNotThrow(() => {
    fresh = JSON.parse(executed.stdout);
  }, `scripts/eval-oracle.mjs did not print valid JSON to stdout:\n${executed.stdout}`);

  const committed = JSON.parse(readFileSync(EVIDENCE_PATH, 'utf8'));
  assert.deepEqual(
    committed,
    fresh,
    'docs/evidence/oracle/behavior-evaluators-v0.2.json has drifted from a fresh run of scripts/eval-oracle.mjs',
  );
});

/**
 * The pinned calibration table, hand-derived by reading `behavior-evaluators.ts`
 * and `replay-scenarios.ts` directly (see this file's header) rather than by
 * calling the production evaluators — the independent-oracle invariant
 * (`.claude/rules/invariants.md`). No fixture statement in the calibration
 * partition is byte-identical to its own ground-truth predicate, so the
 * oracle arm — which may cite a shown evidence item only under that exact
 * equality — identifies nothing, on every scenario, and every metric that
 * depends on a citation reads accordingly.
 */
const EXPECTED_ORACLE_REPORT = {
  evaluatorVersion: 'behavior-evaluators-v0.2',
  partition: 'calibration',
  arm: { arm: 'oracle', role: 'positive-control' },
  providerCalls: 0,
  runsPerScenario: 3,
  bestValues: {
    unsupported_claim_rate: 0,
    evidence_coverage: 1,
    termination_correctness: 1,
    misleading_evidence_handling: 1,
    false_alert_correctness: 1,
    challenge_effect: 1,
  },
  scenarios: [
    {
      scenarioId: 'bad-deployment',
      claimCount: 1,
      metrics: {
        unsupported_claim_rate: { score: 1 },
        evidence_coverage: { score: 0 },
        termination_correctness: { score: 1 },
      },
    },
    {
      scenarioId: 'db-pool-exhaustion',
      claimCount: 1,
      metrics: {
        unsupported_claim_rate: { score: 1 },
        evidence_coverage: { score: 0 },
        termination_correctness: { score: 1 },
      },
    },
    {
      scenarioId: 'false-alert',
      claimCount: 0,
      metrics: {
        unsupported_claim_rate: { score: 0 },
        evidence_coverage: { score: 0 },
        termination_correctness: { score: 1 },
        false_alert_correctness: { score: 0, reason: 'expected-evidence-missing' },
      },
    },
    {
      scenarioId: 'deployment-caused-incident-a',
      claimCount: 1,
      metrics: {
        unsupported_claim_rate: { score: 1 },
        evidence_coverage: { score: 0 },
        termination_correctness: { score: 1 },
      },
    },
    {
      scenarioId: 'dependency-caused-incident-b',
      claimCount: 1,
      metrics: {
        unsupported_claim_rate: { score: 1 },
        evidence_coverage: { score: 0 },
        termination_correctness: { score: 1 },
        misleading_evidence_handling: { score: 0, reason: 'misleading-evidence-not-investigated' },
      },
    },
    {
      scenarioId: 'multiple-plausible-causes',
      claimCount: 0,
      metrics: {
        unsupported_claim_rate: { score: 0 },
        evidence_coverage: { score: 0 },
        termination_correctness: { score: 1 },
      },
    },
    {
      scenarioId: 'transient-self-resolved',
      claimCount: 1,
      metrics: {
        unsupported_claim_rate: { score: 1 },
        evidence_coverage: { score: 0 },
        termination_correctness: { score: 1 },
      },
    },
    {
      scenarioId: 'challenge-keeps-leader',
      claimCount: 1,
      metrics: {
        unsupported_claim_rate: { score: 1 },
        evidence_coverage: { score: 0 },
        termination_correctness: { score: 1 },
        challenge_effect: { score: 1, reason: 'passed' },
      },
    },
  ],
  reachesBest: {
    unsupported_claim_rate: {
      reached: false,
      scenariosBelowBest: [
        'bad-deployment',
        'db-pool-exhaustion',
        'deployment-caused-incident-a',
        'dependency-caused-incident-b',
        'transient-self-resolved',
        'challenge-keeps-leader',
      ],
    },
    evidence_coverage: {
      reached: false,
      scenariosBelowBest: [
        'bad-deployment',
        'db-pool-exhaustion',
        'false-alert',
        'deployment-caused-incident-a',
        'dependency-caused-incident-b',
        'multiple-plausible-causes',
        'transient-self-resolved',
        'challenge-keeps-leader',
      ],
    },
    termination_correctness: { reached: true, scenariosBelowBest: [] },
    false_alert_correctness: { reached: false, scenariosBelowBest: ['false-alert'] },
    misleading_evidence_handling: {
      reached: false,
      scenariosBelowBest: ['dependency-caused-incident-b'],
    },
    challenge_effect: { reached: true, scenariosBelowBest: [] },
  },
};

test('scores the calibration partition exactly as hand-derived from behavior-evaluators.ts and replay-scenarios.ts', () => {
  const executed = runEvalOracleScript();
  assert.equal(
    executed.status,
    0,
    `node scripts/eval-oracle.mjs exited ${executed.status}\nstdout:\n${executed.stdout}\nstderr:\n${executed.stderr}`,
  );

  let fresh;
  assert.doesNotThrow(() => {
    fresh = JSON.parse(executed.stdout);
  }, `scripts/eval-oracle.mjs did not print valid JSON to stdout:\n${executed.stdout}`);

  assert.deepEqual(fresh, EXPECTED_ORACLE_REPORT);
});

test('never runs or scores a hold-out scenario', () => {
  const executed = runEvalOracleScript();
  assert.equal(
    executed.status,
    0,
    `node scripts/eval-oracle.mjs exited ${executed.status}\nstdout:\n${executed.stdout}\nstderr:\n${executed.stderr}`,
  );

  let fresh;
  assert.doesNotThrow(() => {
    fresh = JSON.parse(executed.stdout);
  }, `scripts/eval-oracle.mjs did not print valid JSON to stdout:\n${executed.stdout}`);

  const scoredIds = new Set(fresh.scenarios.map(({ scenarioId }) => scenarioId));
  for (const holdoutId of evals.BENCHMARK_SCENARIO_PARTITIONS.holdout) {
    assert.equal(
      scoredIds.has(holdoutId),
      false,
      `scripts/eval-oracle.mjs scored a hold-out scenario: ${holdoutId}`,
    );
  }
});
