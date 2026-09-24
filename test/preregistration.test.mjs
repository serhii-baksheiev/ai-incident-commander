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
import { readFileSync } from 'node:fs';
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
const PINNED_SHA256 = 'sha256:f4d56c30800574b3309d2d82abee717cec6f26091ee77026b7b2500ca9887ecc';

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

test('names each behaviour metric for exactly the calibration scenarios the committed oracle report emits it on', () => {
  const report = JSON.parse(readFileSync(ORACLE_REPORT, 'utf8'));
  const section = text().split('## Metrics and where each one applies')[1].split('\n## ')[0];
  for (const key of evals.BEHAVIOR_METRIC_KEYS) {
    const emittedOn = report.scenarios
      .filter((scenario) => Object.hasOwn(scenario.metrics, key))
      .map((scenario) => scenario.scenarioId)
      .sort();
    const line = section.split('\n').find((candidate) => candidate.startsWith(`- \`${key}\``));
    assert.ok(line, `the applicability list names no line for ${key}`);
    const named = evals.BENCHMARK_SCENARIO_PARTITIONS.calibration.filter((id) =>
      new RegExp(`(^|[^a-z-])${id}([^a-z-]|$)`).test(line),
    );
    assert.deepEqual([...named].sort(), emittedOn, `${key}: the document and the oracle report disagree`);
  }
});

test('states the evaluator, ground-truth, prompt and model versions the code declares, and its run count', () => {
  const body = text();
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
