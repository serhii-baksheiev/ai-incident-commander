/**
 * The v0.2 four-arm preregistration is written before results and never
 * rewritten after them. A correction is a new dated file that supersedes it.
 *
 * These rows make that mechanical rather than a promise: the file's bytes are
 * pinned, so an edit turns `npm run check` red and a reviewer sees it; and the
 * facts the document restates from code are checked against the code in both
 * directions, so the pin cannot freeze a statement that was already false.
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import * as evals from '@aic/evals';
import { NAIVE_PROMPT_VERSION, REFERENCE_MODEL_ID, REFERENCE_PROMPT_VERSION } from '@aic/roles';

const REPO_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const PREREGISTRATION = join(REPO_ROOT, 'docs', 'evidence', 'preregistration', 'v0.2-four-arm.md');
const ORACLE_REPORT = join(REPO_ROOT, 'docs', 'evidence', 'oracle', 'behavior-evaluators-v0.3.json');

// 🔴 Changing this value is changing a preregistration after the fact. The only
// legitimate edit is to ADD a new dated file that names this one as superseded
// and says why; this file and this pin stay as they are.
const PINNED_SHA256 = 'sha256:f58f0af7e745e674b78793289b17858fbe533563b261aab4ebe768626509a74d';

const text = () => readFileSync(PREREGISTRATION, 'utf8');

/** Rows of the expected-direction table: `| scenario | partition | … |`. */
function directionRows() {
  const section = text().split('## Expected direction')[1].split('\n## ')[0];
  return section
    .split('\n')
    .filter((line) => /^\| [a-z0-9-]+ \| (calibration|hold-out) \|/.test(line))
    .map((line) => {
      const [scenario, partition] = line.split('|').slice(1, 3).map((cell) => cell.trim());
      return { scenario, partition };
    });
}

test('the preregistration is byte-identical to what was committed before any result, so a later edit is visible', () => {
  const digest = `sha256:${createHash('sha256').update(readFileSync(PREREGISTRATION)).digest('hex')}`;
  assert.equal(
    digest,
    PINNED_SHA256,
    'the preregistration changed. A correction is a new dated file that supersedes this one, never an edit to it',
  );
});

test('registers a direction for exactly the scenarios of the declared partition, calibration and hold-out alike', () => {
  const rows = directionRows();
  const byPartition = (name) => rows.filter((row) => row.partition === name).map((row) => row.scenario).sort();
  assert.deepEqual(byPartition('calibration'), [...evals.BENCHMARK_SCENARIO_PARTITIONS.calibration].sort());
  assert.deepEqual(byPartition('hold-out'), [...evals.BENCHMARK_SCENARIO_PARTITIONS.holdout].sort());
  assert.equal(new Set(rows.map((row) => row.scenario)).size, rows.length, 'a scenario is registered twice');
});

/**
 * Which behaviour metrics a scenario's ground truth calls for.
 *
 * 🔴 Deliberately a second copy of the emission conditions in
 * `packages/evals/src/benchmark-evaluation.ts`, not an import of them: the
 * document is checked against an independent statement of the rule, and that
 * statement is itself checked against the committed oracle report below, so
 * neither the document nor this copy can drift from production unnoticed.
 */
function behaviourMetricsCalledFor(groundTruth) {
  const metrics = [];
  if (groundTruth.rootCause !== undefined && groundTruth.misleadingEvidence !== undefined) {
    metrics.push('misleading_evidence_handling');
  }
  if (groundTruth.expectedConclusionKind === 'no-incident') metrics.push('false_alert_correctness');
  if (groundTruth.expectedLeaderChangeAfterChallenge !== undefined) metrics.push('challenge_effect');
  return metrics;
}

const scenariosCalling = (key) =>
  evals.REPLAY_SCENARIOS.filter((scenario) => behaviourMetricsCalledFor(scenario.groundTruth).includes(key))
    .map((scenario) => scenario.id)
    .sort();

test('the duplicated applicability rule agrees with the committed oracle report on every calibration scenario', () => {
  const report = JSON.parse(readFileSync(ORACLE_REPORT, 'utf8'));
  assert.equal(report.partition, 'calibration');
  for (const key of evals.BEHAVIOR_METRIC_KEYS) {
    const emittedOn = report.scenarios
      .filter((scenario) => Object.hasOwn(scenario.metrics, key))
      .map((scenario) => scenario.scenarioId)
      .sort();
    const calibration = new Set(evals.BENCHMARK_SCENARIO_PARTITIONS.calibration);
    assert.deepEqual(scenariosCalling(key).filter((id) => calibration.has(id)), emittedOn, key);
  }
});

test('names each behaviour metric for exactly the scenarios, in both partitions, whose ground truth calls for it', () => {
  const section = text().split('## Metrics and where each one applies')[1].split('\n## ')[0];
  const allIds = evals.REPLAY_SCENARIOS.map((scenario) => scenario.id);
  for (const key of evals.BEHAVIOR_METRIC_KEYS) {
    const line = section.split('\n').find((candidate) => candidate.startsWith(`- \`${key}\``));
    assert.ok(line, `the applicability list names no line for ${key}`);
    const named = allIds.filter((id) => new RegExp(`(^|[^a-z-])${id}([^a-z-]|$)`).test(line)).sort();
    assert.deepEqual(named, scenariosCalling(key), `${key}: the document and the ground truth disagree`);
  }
});

// A later version bump cannot edit the pinned document; it lands as a new
// dated file in the same directory that supersedes it, and this row reads them
// all, so the bump has a legal edit rather than pressure on this test.
const registrationDirectory = () =>
  readdirSync(dirname(PREREGISTRATION))
    .filter((name) => name.endsWith('.md'))
    .map((name) => readFileSync(join(dirname(PREREGISTRATION), name), 'utf8'))
    .join('\n');

test('states the evaluator, ground-truth, prompt and model versions the code declares, and its run count', () => {
  const body = registrationDirectory();
  for (const version of [
    evals.STRUCTURAL_EVALUATOR_VERSION,
    evals.STRUCTURAL_GROUND_TRUTH_VERSION,
    REFERENCE_PROMPT_VERSION,
    NAIVE_PROMPT_VERSION,
    REFERENCE_MODEL_ID,
  ]) {
    assert.ok(body.includes(`\`${version}\``), `the preregistration does not name ${version}`);
  }
  assert.ok(body.includes(`| runs per scenario | ${evals.LIVE_MODEL_LANE_RUNS_PER_SCENARIO} `));
});
