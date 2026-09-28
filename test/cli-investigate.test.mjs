/**
 * AIC-126 slice b: `aic investigate --replay <file> [--roles model|scripted]
 * [--run-id <id>]` — a minimal real product entry that runs one investigation
 * through the SAME canonical composition the lanes use
 * (`createInvestigationNodes` + the planned-replay port), outside any eval
 * script. Spawns the BUILT CLI, exactly like test/cli-dispatcher.test.mjs.
 *
 * The replay file shape this suite fixes: `{ asOf, incident, budget, fixture }`.
 * `fixture` is `{ version, entries: [{ toolId, input, result }] }` — the
 * exact shape `packages/evals/src/replay-scenarios.ts`'s
 * `ScenarioReplayFixture` already carries. Evidence items in `fixture` may
 * carry `observation` inline (`{ version, facts }`); no observation table is
 * read by the CLI itself. `budget` is `{ maxIterations, llmCallBudget,
 * reservedChallengeBudget }`, all required positive integers — the CLI never
 * invents a budget of its own, so a benchmark-style comparison (row 5 below)
 * can build the file's `budget` from the same `evals.BENCHMARK_BUDGET_POLICY`
 * the lanes are measured under and compare like with like.
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import * as domain from '@aic/domain';
import * as evals from '@aic/evals';
import { createInvestigationGraph } from '@aic/graph';

import { childEnv } from './fixtures/child-env.mjs';

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const cliPath = resolve(projectRoot, 'apps/cli/dist/index.js');

/**
 * A calibration scenario, never a hold-out one — the fixture sanity check in
 * `calibrationScenario()` below pins that.
 */
const CALIBRATION_SCENARIO_ID = 'deployment-caused-incident-a';

function runCli(args, options = {}) {
  return spawnSync(process.execPath, [cliPath, ...args], {
    cwd: options.cwd ?? projectRoot,
    encoding: 'utf8',
    env: childEnv(),
  });
}

function commandDiagnostics(args, result) {
  return `aic ${args.join(' ')} exited ${result.status}\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`;
}

/**
 * One scratch directory this suite owns, created once and removed by its own
 * exact path in `after` — never a glob, and never the process's own $TMPDIR
 * root (`.claude/hooks`'s reviewer-scratch-deletes lesson).
 */
const scratchRoot = mkdtempSync(join(tmpdir(), 'aic-cli-investigate-'));
test.after(() => {
  rmSync(scratchRoot, { recursive: true, force: true });
});

async function withTempDir(fn) {
  const dir = mkdtempSync(join(scratchRoot, 'case-'));
  try {
    return await fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function calibrationScenario() {
  assert.ok(
    evals.BENCHMARK_SCENARIO_PARTITIONS.calibration.includes(CALIBRATION_SCENARIO_ID),
    `fixture sanity: ${CALIBRATION_SCENARIO_ID} must be a calibration scenario, never a hold-out one`,
  );
  const scenario = evals.REPLAY_SCENARIOS.find(({ id }) => id === CALIBRATION_SCENARIO_ID);
  assert.ok(scenario, `fixture sanity: REPLAY_SCENARIOS must carry ${CALIBRATION_SCENARIO_ID}`);
  return scenario;
}

/**
 * Inlines each matching `OBSERVATION_ANNOTATIONS` row's facts directly onto
 * the scenario's own fixture evidence items, by evidence id — the shape the
 * replay file's `fixture` field takes so a reader needs no separate
 * annotation table to answer a planned request's quantity.
 */
function annotatedFixtureFor(scenario) {
  const rowsByEvidenceId = new Map(evals.OBSERVATION_ANNOTATIONS.map((row) => [row.evidenceId, row]));
  return {
    version: scenario.fixture.version,
    entries: scenario.fixture.entries.map((entry) => {
      if (entry.result.status !== 'ok') return entry;
      return {
        ...entry,
        result: {
          ...entry.result,
          output: entry.result.output.map((item) => {
            const row = rowsByEvidenceId.get(item.id);
            if (!row || row.facts.length === 0) return item;
            return { ...item, observation: { version: 1, facts: row.facts } };
          }),
        },
      };
    }),
  };
}

/**
 * The three budget fields, taken from the same `evals.BENCHMARK_BUDGET_POLICY`
 * the lanes run under — never a literal a row would have to keep in sync by
 * hand, and never invented by the CLI itself (row 5 below compares against a
 * direct kernel run built from this exact policy).
 */
function budgetFromPolicy() {
  return {
    maxIterations: evals.BENCHMARK_BUDGET_POLICY.maxIterations,
    llmCallBudget: evals.BENCHMARK_BUDGET_POLICY.llmCallBudget,
    reservedChallengeBudget: evals.BENCHMARK_BUDGET_POLICY.reservedChallengeBudget,
  };
}

function replayFileContentFor(
  fixture,
  { asOf = evals.REPLAY_AS_OF, incidentId = 'incident-cli-investigate-test', budget = budgetFromPolicy() } = {},
) {
  return {
    asOf,
    incident: {
      id: incidentId,
      primaryScope: evals.BENCHMARK_PRIMARY_SCOPE,
    },
    budget,
    fixture,
  };
}

function writeReplayFile(dir, content) {
  const path = join(dir, 'replay.json');
  writeFileSync(path, JSON.stringify(content), 'utf8');
  return path;
}

/* -------------------------------------------------------------------------- */
/* 1. scripted roles over the calibration scenario: pinned output shape       */
/* -------------------------------------------------------------------------- */

test('aic investigate --replay <file> --roles scripted over the calibration scenario deployment-caused-incident-a exits 0 and prints exactly the pinned output shape', async () => {
  await withTempDir(async (dir) => {
    const scenario = calibrationScenario();
    const replayPath = writeReplayFile(dir, replayFileContentFor(annotatedFixtureFor(scenario)));

    const args = ['investigate', '--replay', replayPath, '--roles', 'scripted'];
    const result = runCli(args);

    assert.equal(result.status, 0, commandDiagnostics(args, result));

    let parsed;
    try {
      parsed = JSON.parse(result.stdout);
    } catch (error) {
      assert.fail(`stdout must be exactly one JSON object: ${error.message}\n${commandDiagnostics(args, result)}`);
    }

    assert.deepEqual(
      Object.keys(parsed).sort(),
      ['conclusion', 'evidence', 'hypotheses', 'runId', 'stopKind', 'trials'].sort(),
      `printed object must carry exactly the pinned keys: ${commandDiagnostics(args, result)}`,
    );
    // The scripted control plans nothing of its own — its hypothesis carries
    // no cause — so the only trial is the mandatory challenge round's own
    // hard-coded probe, which the planned-replay port answers unavailable.
    // Measured directly through the same composition in
    // test/investigation-plan-execute-wiring.test.mjs › "deployment-caused-
    // incident-a is one scenario giving a strict subset: the model arm sees
    // exactly the confirming evidence, the scenario's own recorded corpus
    // also carries the dependencies evidence, and the scripted-control arm
    // run through the real kernel ends with no evidence at all".
    assert.equal(parsed.stopKind, 'tools-unavailable', commandDiagnostics(args, result));
    assert.equal(parsed.trials, 1, commandDiagnostics(args, result));
    assert.deepEqual(parsed.evidence, [], commandDiagnostics(args, result));
  });
});

/* -------------------------------------------------------------------------- */
/* 2. model roles with no credential: refuse before any network reaches out   */
/* -------------------------------------------------------------------------- */

test('aic investigate --roles model with no ANTHROPIC_API_KEY in the child env exits non-zero, writes nothing to stdout, names the missing variable on stderr, and reaches no network', async () => {
  await withTempDir(async (dir) => {
    const scenario = calibrationScenario();
    const replayPath = writeReplayFile(dir, replayFileContentFor(annotatedFixtureFor(scenario)));

    const env = childEnv();
    assert.ok(
      !Object.keys(env).some((name) => /ANTHROPIC|LANGSMITH|LANGCHAIN/i.test(name)),
      'fixture sanity: childEnv() with no overrides must carry no provider or LangSmith variable',
    );

    const args = ['investigate', '--replay', replayPath, '--roles', 'model'];
    const result = runCli(args);

    assert.notEqual(result.status, 0, commandDiagnostics(args, result));
    assert.equal(result.stdout, '', `no stdout may be written on refusal: ${commandDiagnostics(args, result)}`);
    assert.match(
      result.stderr,
      /ANTHROPIC_API_KEY/,
      `stderr must name the missing model credential variable: ${commandDiagnostics(args, result)}`,
    );
  });
});

/* -------------------------------------------------------------------------- */
/* 3. malformed input: missing --replay, unreadable/non-JSON, missing/bad     */
/*    asOf — one row each, each naming its own problem                       */
/* -------------------------------------------------------------------------- */

test('missing --replay exits non-zero and names the missing option', () => {
  const args = ['investigate', '--roles', 'scripted'];
  const result = runCli(args);

  assert.notEqual(result.status, 0, commandDiagnostics(args, result));
  assert.match(
    `${result.stdout}${result.stderr}`,
    /--replay/,
    `the refusal must name --replay as the missing option: ${commandDiagnostics(args, result)}`,
  );
});

test('an unreadable or non-JSON --replay file exits non-zero and names the replay file as the problem', () => {
  const nonExistentPath = join(scratchRoot, 'does-not-exist-cli126b.json');
  const garbagePath = join(scratchRoot, 'garbage-cli126b.json');
  writeFileSync(garbagePath, 'this is not valid JSON {{{', 'utf8');

  for (const replayPath of [nonExistentPath, garbagePath]) {
    const args = ['investigate', '--replay', replayPath, '--roles', 'scripted'];
    const result = runCli(args);

    assert.notEqual(result.status, 0, commandDiagnostics(args, result));
    assert.match(
      `${result.stdout}${result.stderr}`,
      /replay/i,
      `the refusal must name the replay file as the problem for ${replayPath}: ${commandDiagnostics(args, result)}`,
    );
  }

  rmSync(garbagePath, { force: true });
});

test('a --replay file missing asOf exits non-zero and names asOf', async () => {
  await withTempDir(async (dir) => {
    const scenario = calibrationScenario();
    const content = replayFileContentFor(annotatedFixtureFor(scenario));
    delete content.asOf;
    const replayPath = writeReplayFile(dir, content);

    const args = ['investigate', '--replay', replayPath, '--roles', 'scripted'];
    const result = runCli(args);

    assert.notEqual(result.status, 0, commandDiagnostics(args, result));
    assert.match(
      `${result.stdout}${result.stderr}`,
      /asOf/,
      `the refusal must name asOf as missing, never default to the clock: ${commandDiagnostics(args, result)}`,
    );
  });
});

test('a --replay file whose asOf is not a parseable instant exits non-zero and names asOf', async () => {
  await withTempDir(async (dir) => {
    const scenario = calibrationScenario();
    const replayPath = writeReplayFile(
      dir,
      replayFileContentFor(annotatedFixtureFor(scenario), { asOf: 'not-an-instant' }),
    );

    const args = ['investigate', '--replay', replayPath, '--roles', 'scripted'];
    const result = runCli(args);

    assert.notEqual(result.status, 0, commandDiagnostics(args, result));
    assert.match(
      `${result.stdout}${result.stderr}`,
      /asOf/,
      `the refusal must name asOf as unparseable: ${commandDiagnostics(args, result)}`,
    );
  });
});

test('a --replay file missing budget exits non-zero and names budget', async () => {
  await withTempDir(async (dir) => {
    const scenario = calibrationScenario();
    const content = replayFileContentFor(annotatedFixtureFor(scenario));
    delete content.budget;
    const replayPath = writeReplayFile(dir, content);

    const args = ['investigate', '--replay', replayPath, '--roles', 'scripted'];
    const result = runCli(args);

    assert.notEqual(result.status, 0, commandDiagnostics(args, result));
    assert.match(
      `${result.stdout}${result.stderr}`,
      /budget/,
      `the refusal must name budget as missing, never invent one of its own: ${commandDiagnostics(args, result)}`,
    );
  });
});

test('a --replay file whose budget field is not a positive integer exits non-zero and names that field', async () => {
  await withTempDir(async (dir) => {
    const scenario = calibrationScenario();
    const fixture = annotatedFixtureFor(scenario);

    for (const field of ['maxIterations', 'llmCallBudget', 'reservedChallengeBudget']) {
      for (const badValue of [0, -1, 1.5]) {
        const content = replayFileContentFor(fixture);
        content.budget = { ...content.budget, [field]: badValue };
        const replayPath = writeReplayFile(dir, content);

        const args = ['investigate', '--replay', replayPath, '--roles', 'scripted'];
        const result = runCli(args);

        assert.notEqual(result.status, 0, `budget.${field} = ${badValue}: ${commandDiagnostics(args, result)}`);
        assert.match(
          `${result.stdout}${result.stderr}`,
          new RegExp(field),
          `the refusal must name budget.${field} as invalid for value ${badValue}: ${commandDiagnostics(args, result)}`,
        );
      }
    }
  });
});

/* -------------------------------------------------------------------------- */
/* 4. general help lists investigate                                          */
/* -------------------------------------------------------------------------- */

test('aic --help lists investigate', () => {
  const args = ['--help'];
  const result = runCli(args);

  assert.equal(result.status, 0, commandDiagnostics(args, result));
  assert.match(
    result.stdout,
    /^\s*investigate\b/m,
    `general help must list the "investigate" command: ${commandDiagnostics(args, result)}`,
  );
});

/* -------------------------------------------------------------------------- */
/* 5. same composition as the lanes: the CLI must not drift from lane-arms.mjs */
/* -------------------------------------------------------------------------- */

/**
 * The full initial IncidentState a direct kernel run starts from — copied
 * from test/investigation-plan-execute-wiring.test.mjs's own helper of the
 * same shape (this suite's convention: a row needing it builds its own
 * copy). `incident` and `budget` are taken from the SAME replay-file content
 * the CLI itself reads for this row, never re-derived, so a mismatch between
 * what the CLI parses and what this direct comparison assumes cannot hide
 * inside two independently-built incidents or budgets.
 */
function directInitialStateFor(runId, { incident, budget }) {
  return {
    incident,
    hypotheses: [],
    predictions: [],
    tests: [],
    trials: [],
    evidence: [],
    assessments: [],
    control: {
      runId,
      schemaVersion: domain.INCIDENT_STATE_SCHEMA_VERSION,
      statusRulesVersion: domain.STATUS_RULES_VERSION,
      phase: 'normalizing',
      maxIterations: budget.maxIterations,
      llmCallBudget: budget.llmCallBudget,
      reservedChallengeBudget: budget.reservedChallengeBudget,
      challengeRounds: 0,
      iterationsUsed: 0,
      llmCallsUsed: 0,
      resumeCount: 0,
      humanReview: false,
    },
  };
}

test('the scripted-roles CLI run is the same composition the lanes use: printed stopKind/trials/evidence equal what scriptedNodes(record) produces through createInvestigationGraph for the same replay fixture', async () => {
  await withTempDir(async (dir) => {
    const { scriptedNodes } = await import('../scripts/lane-arms.mjs');

    const scenario = calibrationScenario();
    const fixture = annotatedFixtureFor(scenario);
    const runId = 'aic126b-cli-lane-parity-run';
    const content = replayFileContentFor(fixture, { asOf: evals.REPLAY_AS_OF });
    const replayPath = writeReplayFile(dir, content);

    const args = ['investigate', '--replay', replayPath, '--roles', 'scripted', '--run-id', runId];
    const result = runCli(args);
    assert.equal(result.status, 0, commandDiagnostics(args, result));
    const parsed = JSON.parse(result.stdout);

    const nodes = scriptedNodes({ runId, fixture });
    const investigationGraph = createInvestigationGraph({ nodes });
    const finalState = await investigationGraph.execute({
      kind: 'start',
      state: directInitialStateFor(runId, content),
    });

    assert.equal(
      parsed.stopKind,
      finalState.control.stopKind,
      `the CLI's printed stopKind must equal the lane composition's own stopKind for the same fixture: ${commandDiagnostics(args, result)}`,
    );
    assert.equal(
      parsed.trials,
      finalState.trials.length,
      `the CLI's printed trial count must equal the lane composition's own trial count: ${commandDiagnostics(args, result)}`,
    );
    assert.deepEqual(
      [...parsed.evidence].sort(),
      finalState.evidence.map((item) => item.id).sort(),
      `the CLI's printed evidence ids must equal the lane composition's own evidence ids: ${commandDiagnostics(args, result)}`,
    );
  });
});

/* -------------------------------------------------------------------------- */
/* 6. --run-id                                                                 */
/* -------------------------------------------------------------------------- */

test('--run-id sets the printed runId; without it the runId is a non-empty string', async () => {
  await withTempDir(async (dir) => {
    const scenario = calibrationScenario();
    const replayPath = writeReplayFile(dir, replayFileContentFor(annotatedFixtureFor(scenario)));

    const withIdArgs = ['investigate', '--replay', replayPath, '--roles', 'scripted', '--run-id', 'aic126b-fixed-run-id'];
    const withId = runCli(withIdArgs);
    assert.equal(withId.status, 0, commandDiagnostics(withIdArgs, withId));
    const parsedWithId = JSON.parse(withId.stdout);
    assert.equal(parsedWithId.runId, 'aic126b-fixed-run-id', commandDiagnostics(withIdArgs, withId));

    const withoutIdArgs = ['investigate', '--replay', replayPath, '--roles', 'scripted'];
    const withoutId = runCli(withoutIdArgs);
    assert.equal(withoutId.status, 0, commandDiagnostics(withoutIdArgs, withoutId));
    const parsedWithoutId = JSON.parse(withoutId.stdout);
    assert.equal(typeof parsedWithoutId.runId, 'string', commandDiagnostics(withoutIdArgs, withoutId));
    assert.ok(parsedWithoutId.runId.length > 0, commandDiagnostics(withoutIdArgs, withoutId));
  });
});
