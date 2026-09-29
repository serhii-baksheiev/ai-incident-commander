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
import { createInvestigationGraph, PREDICTION_TEMPLATES } from '@aic/graph';

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
    env: childEnv(options.env),
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
            return { ...item, observation: { version: domain.EXPECTED_OBSERVATION_VERSION, facts: row.facts } };
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

test('a --replay file whose budget field is not a non-negative integer exits non-zero and names that field', async () => {
  await withTempDir(async (dir) => {
    const scenario = calibrationScenario();
    const fixture = annotatedFixtureFor(scenario);

    // 0 is a valid LogicalCountSchema value (z.number().int().nonnegative())
    // and is pinned separately, below, as a value the CLI must accept —
    // this row's values are the ones that stay invalid under that schema.
    for (const field of ['maxIterations', 'llmCallBudget', 'reservedChallengeBudget']) {
      for (const badValue of [-1, 1.5]) {
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

/**
 * The domain's own `LogicalCountSchema` (`z.number().int().nonnegative()`)
 * is the contract the CLI's budget validation must match — not a
 * hand-written positive-integer check that disagrees with it. This row
 * widens the row above to values `LogicalCountSchema` also refuses that are
 * not plain positive-integer violations: negative non-integers and values
 * that are not numbers at all.
 */
test('a --replay file whose budget field is negative, non-integer or not a number is refused for each of the three fields, exits non-zero, writes nothing to stdout, and names the field on stderr', async () => {
  await withTempDir(async (dir) => {
    const scenario = calibrationScenario();
    const fixture = annotatedFixtureFor(scenario);
    const badValues = [-5, -0.5, 2.5, 'not-a-number', null, true, [], {}];

    for (const field of ['maxIterations', 'llmCallBudget', 'reservedChallengeBudget']) {
      for (const badValue of badValues) {
        const content = replayFileContentFor(fixture);
        content.budget = { ...content.budget, [field]: badValue };
        const replayPath = writeReplayFile(dir, content);

        const args = ['investigate', '--replay', replayPath, '--roles', 'scripted'];
        const result = runCli(args);

        assert.notEqual(
          result.status,
          0,
          `budget.${field} = ${JSON.stringify(badValue)}: ${commandDiagnostics(args, result)}`,
        );
        assert.equal(
          result.stdout,
          '',
          `no stdout may be written on refusal for budget.${field} = ${JSON.stringify(badValue)}: ${commandDiagnostics(args, result)}`,
        );
        assert.match(
          result.stderr,
          new RegExp(field),
          `stderr must name budget.${field} as invalid for value ${JSON.stringify(badValue)}: ${commandDiagnostics(args, result)}`,
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

/**
 * The composition-parity check both the row below and the budget=0 row that
 * follows it share: run the CLI over `content`, then run `content`'s own
 * `incident`/`budget`/`fixture` straight through `scriptedNodes` +
 * `createInvestigationGraph`, and assert the two agree on stopKind, trial
 * count and evidence ids.
 */
async function assertCliMatchesLaneComposition(dir, { fixture, budget, runId }) {
  const { scriptedNodes } = await import('../scripts/lane-arms.mjs');

  const content = replayFileContentFor(fixture, { asOf: evals.REPLAY_AS_OF, budget });
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
}

test('the scripted-roles CLI run is the same composition the lanes use: printed stopKind/trials/evidence equal what scriptedNodes(record) produces through createInvestigationGraph for the same replay fixture', async () => {
  await withTempDir(async (dir) => {
    const scenario = calibrationScenario();
    const fixture = annotatedFixtureFor(scenario);
    await assertCliMatchesLaneComposition(dir, {
      fixture,
      budget: budgetFromPolicy(),
      runId: 'aic126b-cli-lane-parity-run',
    });
  });
});

/**
 * `reservedChallengeBudget: 0` is a value the domain's own `LogicalCountSchema`
 * (`z.number().int().nonnegative()`) accepts, and `IncidentStateControlSchema`
 * applies that schema to exactly this field — so the CLI must accept it too,
 * and must run the same composition the lanes run, not refuse a configuration
 * the kernel itself runs.
 */
test('a --replay file with reservedChallengeBudget 0 and --roles scripted exits 0, running the same composition the lanes use', async () => {
  await withTempDir(async (dir) => {
    const scenario = calibrationScenario();
    const fixture = annotatedFixtureFor(scenario);
    const budget = { ...budgetFromPolicy(), reservedChallengeBudget: 0 };
    await assertCliMatchesLaneComposition(dir, {
      fixture,
      budget,
      runId: 'aic126b-budget-zero-run',
    });
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

/* -------------------------------------------------------------------------- */
/* 7. --roles is required: no default arm                                     */
/* -------------------------------------------------------------------------- */

test('missing --roles exits non-zero, writes nothing to stdout, and names --roles on stderr', async () => {
  await withTempDir(async (dir) => {
    const scenario = calibrationScenario();
    const replayPath = writeReplayFile(dir, replayFileContentFor(annotatedFixtureFor(scenario)));

    const args = ['investigate', '--replay', replayPath];
    const result = runCli(args);

    assert.notEqual(result.status, 0, commandDiagnostics(args, result));
    assert.equal(
      result.stdout,
      '',
      `no stdout may be written when --roles is not given: ${commandDiagnostics(args, result)}`,
    );
    assert.match(
      result.stderr,
      /--roles/,
      `stderr must name --roles as required: ${commandDiagnostics(args, result)}`,
    );
  });
});

/* -------------------------------------------------------------------------- */
/* 8. the tracing decision is made before any work, like dev-spike            */
/* -------------------------------------------------------------------------- */

test('LANGSMITH_TRACING=true with no LANGSMITH_API_KEY or LANGCHAIN_API_KEY exits non-zero, writes nothing to stdout, and names LANGSMITH_API_KEY on stderr', async () => {
  await withTempDir(async (dir) => {
    const scenario = calibrationScenario();
    const replayPath = writeReplayFile(dir, replayFileContentFor(annotatedFixtureFor(scenario)));

    const args = ['investigate', '--replay', replayPath, '--roles', 'scripted'];
    // A closed local port, never the real LangSmith endpoint: should the
    // command ever stop deciding tracing before it works, `@langchain/core`'s
    // own ambient-env tracer would reach a remote host from this row. Pointing
    // both endpoint variables at a closed port keeps any such attempt local
    // and fast-failing instead.
    const result = runCli(args, {
      env: {
        LANGSMITH_TRACING: 'true',
        LANGSMITH_ENDPOINT: 'http://127.0.0.1:1',
        LANGCHAIN_ENDPOINT: 'http://127.0.0.1:1',
      },
    });

    assert.notEqual(result.status, 0, commandDiagnostics(args, result));
    assert.equal(
      result.stdout,
      '',
      `tracing requested without a key must fail before any work is printed: ${commandDiagnostics(args, result)}`,
    );
    assert.match(
      result.stderr,
      /LANGSMITH_API_KEY/,
      `stderr must name the missing tracing credential variable, the same way aic dev spike does: ${commandDiagnostics(args, result)}`,
    );
  });
});

/* -------------------------------------------------------------------------- */
/* 9. replay-file shape refusals: fixture.entries, an entry, fixture.version, */
/*    and the incident, each named on stderr                                  */
/* -------------------------------------------------------------------------- */

test('a --replay file whose fixture.entries is empty exits non-zero, writes nothing to stdout, and names entries on stderr', async () => {
  await withTempDir(async (dir) => {
    const scenario = calibrationScenario();
    const content = replayFileContentFor(annotatedFixtureFor(scenario));
    content.fixture = { ...content.fixture, entries: [] };
    const replayPath = writeReplayFile(dir, content);

    const args = ['investigate', '--replay', replayPath, '--roles', 'scripted'];
    const result = runCli(args);

    assert.notEqual(result.status, 0, commandDiagnostics(args, result));
    assert.equal(result.stdout, '', `no stdout may be written on refusal: ${commandDiagnostics(args, result)}`);
    assert.match(
      result.stderr,
      /entries/,
      `stderr must name fixture.entries as the problem: ${commandDiagnostics(args, result)}`,
    );
  });
});

test('a --replay file whose fixture carries a non-object entry exits non-zero, writes nothing to stdout, and names the entry as the problem', async () => {
  await withTempDir(async (dir) => {
    const scenario = calibrationScenario();
    const content = replayFileContentFor(annotatedFixtureFor(scenario));
    content.fixture = { ...content.fixture, entries: [null, ...content.fixture.entries] };
    const replayPath = writeReplayFile(dir, content);

    const args = ['investigate', '--replay', replayPath, '--roles', 'scripted'];
    const result = runCli(args);

    assert.notEqual(result.status, 0, commandDiagnostics(args, result));
    assert.equal(result.stdout, '', `no stdout may be written on refusal: ${commandDiagnostics(args, result)}`);
    assert.match(
      result.stderr,
      /entr(y|ies)/,
      `stderr must name the offending entry as the problem: ${commandDiagnostics(args, result)}`,
    );
  });
});

test('a --replay file whose fixture carries an entry with no string toolId exits non-zero, writes nothing to stdout, and names toolId on stderr', async () => {
  await withTempDir(async (dir) => {
    const scenario = calibrationScenario();
    const content = replayFileContentFor(annotatedFixtureFor(scenario));
    const [firstEntry, ...restEntries] = content.fixture.entries;
    const { toolId, ...entryWithoutToolId } = firstEntry;
    content.fixture = { ...content.fixture, entries: [entryWithoutToolId, ...restEntries] };
    const replayPath = writeReplayFile(dir, content);

    const args = ['investigate', '--replay', replayPath, '--roles', 'scripted'];
    const result = runCli(args);

    assert.notEqual(result.status, 0, commandDiagnostics(args, result));
    assert.equal(result.stdout, '', `no stdout may be written on refusal: ${commandDiagnostics(args, result)}`);
    assert.match(
      result.stderr,
      /toolId/,
      `stderr must name toolId as missing: ${commandDiagnostics(args, result)}`,
    );
  });
});

test('a --replay file whose fixture.version is not a number exits non-zero, writes nothing to stdout, and names version on stderr', async () => {
  await withTempDir(async (dir) => {
    const scenario = calibrationScenario();
    const content = replayFileContentFor(annotatedFixtureFor(scenario));
    content.fixture = { ...content.fixture, version: 'not-a-number' };
    const replayPath = writeReplayFile(dir, content);

    const args = ['investigate', '--replay', replayPath, '--roles', 'scripted'];
    const result = runCli(args);

    assert.notEqual(result.status, 0, commandDiagnostics(args, result));
    assert.equal(result.stdout, '', `no stdout may be written on refusal: ${commandDiagnostics(args, result)}`);
    assert.match(
      result.stderr,
      /version/,
      `stderr must name fixture.version as invalid: ${commandDiagnostics(args, result)}`,
    );
  });
});

test('a --replay file whose fixture.version carries an ESC or BEL control character reaches stderr with no raw control character in it, only its JSON-escaped form', async () => {
  await withTempDir(async (dir) => {
    const scenario = calibrationScenario();
    const content = replayFileContentFor(annotatedFixtureFor(scenario));
    content.fixture = { ...content.fixture, version: '\u001b[31mRED\u0007secret-ish' };
    const replayPath = writeReplayFile(dir, content);

    const args = ['investigate', '--replay', replayPath, '--roles', 'scripted'];
    const result = runCli(args);

    assert.notEqual(result.status, 0, commandDiagnostics(args, result));
    assert.equal(result.stdout, '', `no stdout may be written on refusal: ${commandDiagnostics(args, result)}`);
    assert.ok(
      !result.stderr.includes('\u001b') && !result.stderr.includes('\u0007'),
      `stderr must never carry a raw ESC or BEL byte taken from an untrusted replay file, only its JSON-escaped form: ${JSON.stringify(result.stderr)}`,
    );
  });
});

test('a --replay file whose incident fails the domain IncidentSchema (missing id) exits non-zero, writes nothing to stdout, and names incident on stderr', async () => {
  await withTempDir(async (dir) => {
    const scenario = calibrationScenario();
    const content = replayFileContentFor(annotatedFixtureFor(scenario));
    content.incident = { primaryScope: content.incident.primaryScope };
    const replayPath = writeReplayFile(dir, content);

    const args = ['investigate', '--replay', replayPath, '--roles', 'scripted'];
    const result = runCli(args);

    assert.notEqual(result.status, 0, commandDiagnostics(args, result));
    assert.equal(result.stdout, '', `no stdout may be written on refusal: ${commandDiagnostics(args, result)}`);
    assert.match(
      result.stderr,
      /incident/,
      `stderr must name incident as invalid: ${commandDiagnostics(args, result)}`,
    );
  });
});

/* -------------------------------------------------------------------------- */
/* 10. the model arm is demonstrated: createModelReasoning(port) and the      */
/*     runInvestigate(args, deps) seam                                        */
/* -------------------------------------------------------------------------- */

/**
 * `createModelReasoning(port)` is the CLI's own model-arm factory, over the
 * mechanism vocabulary `Object.keys(PREDICTION_TEMPLATES.byMechanism)`
 * (`@aic/graph`) — never `evals.ROOT_CAUSE_MECHANISMS`, which this command
 * cannot import. Independent oracle: the two vocabularies are asserted equal
 * as sets directly, from `@aic/graph` and `@aic/evals`, rather than trusting
 * the command's own choice of one over the other.
 *
 * The fake-port shape and the assertions on the request it receives are
 * carried over from test/lane-arms.test.mjs's own `modelNodes(record, port)`
 * rows for the same three roles: › "modelNodes(record, port).propose_
 * conclusion is a model role: the fake port sees exactly one call, carrying
 * the mechanism vocabulary sentence built from evals.ROOT_CAUSE_MECHANISMS"
 * and › "modelNodes(record, port).generate_hypotheses and .challenge_
 * hypothesis are given the mechanism vocabulary evals.ROOT_CAUSE_MECHANISMS:
 * the provider schema's cause mechanism enum equals it exactly, and the
 * system prompt carries the vocabulary sentence".
 */
test('createModelReasoning(fakePort) wires generate_hypotheses, challenge_hypothesis and propose_conclusion as model roles carrying the PREDICTION_TEMPLATES mechanism vocabulary, which equals evals.ROOT_CAUSE_MECHANISMS as a set', async () => {
  const investigateModule = await import('../apps/cli/dist/commands/investigate.js');
  assert.equal(
    typeof investigateModule.createModelReasoning,
    'function',
    'apps/cli/src/commands/investigate.ts must export createModelReasoning(port)',
  );

  const mechanismKeys = Object.keys(PREDICTION_TEMPLATES.byMechanism);
  assert.deepEqual(
    new Set(mechanismKeys),
    new Set(evals.ROOT_CAUSE_MECHANISMS),
    'independent oracle: PREDICTION_TEMPLATES.byMechanism keys (@aic/graph) and evals.ROOT_CAUSE_MECHANISMS (@aic/evals) must name the same mechanisms',
  );

  // The port throws on every call, the same shape
  // test/lane-arms.test.mjs's generate_hypotheses/challenge_hypothesis row
  // uses: this row reads the request each role sent, never a parsed answer,
  // so one fake port serves all three roles regardless of their differing
  // response shapes.
  const requests = [];
  const fakePort = {
    async complete(request) {
      requests.push(request);
      throw new Error('fake port refuses: this row reads the request each role sent, not an answer');
    },
  };

  const reasoning = investigateModule.createModelReasoning(fakePort);
  const state = {
    incident: { id: 'aic126b-fake-incident' },
    hypotheses: [{ id: 'h-1', statement: 'a candidate cause', createdBy: 'initial' }],
    predictions: [],
    tests: [],
    trials: [],
    evidence: [],
    assessments: [],
    control: { stopKind: 'sufficient', challengeRounds: 0 },
  };

  await reasoning.generate_hypotheses(state).catch(() => {});
  await reasoning.challenge_hypothesis(state, 'h-1').catch(() => {});
  await reasoning.propose_conclusion(state).catch(() => {});

  assert.equal(requests.length, 3, 'each of the three roles must reach the fake port exactly once');
  const [generateRequest, challengeRequest, proposeRequest] = requests;
  const vocabularySentence = `Classify each cause's mechanism as one of: ${mechanismKeys.join(', ')}.`;

  for (const [label, request] of [
    ['generate_hypotheses', generateRequest],
    ['challenge_hypothesis', challengeRequest],
    ['propose_conclusion', proposeRequest],
  ]) {
    assert.ok(
      request.system.includes(vocabularySentence),
      `${label}: expected the system prompt to carry the vocabulary sentence built from PREDICTION_TEMPLATES.byMechanism: ${JSON.stringify(request.system)}`,
    );
  }

  assert.deepEqual(
    generateRequest.outputSchema.properties.hypotheses.items.properties.cause.properties.mechanism.enum,
    mechanismKeys,
    'generate_hypotheses must declare the cause mechanism enum from PREDICTION_TEMPLATES.byMechanism keys',
  );
  assert.deepEqual(
    challengeRequest.outputSchema.properties.alternative.properties.cause.properties.mechanism.enum,
    mechanismKeys,
    'challenge_hypothesis must declare the cause mechanism enum from PREDICTION_TEMPLATES.byMechanism keys',
  );
});

/**
 * `runInvestigate(args, { env, createModelPort })` routes the model arm
 * through the injected factory rather than constructing
 * `createReferenceModelPort` unconditionally — the seam that lets this row
 * reach the model arm with a fake port and no real network call, the same
 * way `scripts/lane-arms.mjs`'s `modelNodes(record, port)` already takes
 * `port` as a parameter.
 *
 * The fake port refuses every call; that is deliberate — this row reads what
 * the port and the factory SAW, not a successful run.
 */
test('runInvestigate(["--replay", file, "--roles", "model"], { env, createModelPort }) calls the injected factory once with the env credential, and the fake port it returns sees at least one call before the run ends', async () => {
  await withTempDir(async (dir) => {
    const investigateModule = await import('../apps/cli/dist/commands/investigate.js');
    assert.equal(
      typeof investigateModule.runInvestigate,
      'function',
      'apps/cli/src/commands/investigate.ts must export runInvestigate',
    );

    const scenario = calibrationScenario();
    const replayPath = writeReplayFile(dir, replayFileContentFor(annotatedFixtureFor(scenario)));

    // A credential SHAPE, assembled at runtime and never written as a
    // literal — `.claude/rules/autonomy.md` ("Never").
    const fakeApiKey = ['sk', 'ant', 'test', '9'.repeat(24)].join('-');

    const factoryCalls = [];
    const portCalls = [];
    const fakePort = {
      async complete(request) {
        portCalls.push(request);
        throw new Error('fake port refuses: this row reads what it was sent, not an answer');
      },
    };
    function createModelPort(options) {
      factoryCalls.push(options);
      return fakePort;
    }

    await assert.rejects(
      investigateModule.runInvestigate(['--replay', replayPath, '--roles', 'model'], {
        env: { ANTHROPIC_API_KEY: fakeApiKey },
        createModelPort,
      }),
    );

    assert.equal(factoryCalls.length, 1, 'createModelPort must be called exactly once');
    assert.equal(
      factoryCalls[0].apiKey,
      fakeApiKey,
      'the factory must be called with the credential read from the env passed to runInvestigate',
    );
    assert.ok(portCalls.length >= 1, 'the fake port returned by the factory must see at least one call before the run ends');
  });
});
