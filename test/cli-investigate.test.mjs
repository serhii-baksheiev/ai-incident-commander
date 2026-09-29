/**
 * AIC-126 slice b: `aic investigate --replay <file> --roles model|scripted
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
 * reservedChallengeBudget }`, all required non-negative integers under the
 * domain's own `LogicalCountSchema` — the CLI never
 * invents a budget of its own, so a benchmark-style comparison (row 5 below)
 * can build the file's `budget` from the same `evals.BENCHMARK_BUDGET_POLICY`
 * the lanes are measured under and compare like with like.
 */
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
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
    // Only set when a row explicitly asks for one (a hang-detection row over
    // a FIFO or a device symlink); spawnSync's own default is no timeout at
    // all, which every other row still gets.
    ...(options.timeout === undefined ? {} : { timeout: options.timeout }),
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
    // test/investigation-plan-execute-wiring.test.mjs ›
    // "deployment-caused-incident-a is one scenario giving a strict subset: the model arm sees
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
 * rows for the same three roles: see lane-arms.test.mjs ›
 * "modelNodes(record, port).propose_conclusion is a model role: the fake port
 * sees exactly one call, carrying the mechanism vocabulary sentence built from
 * evals.ROOT_CAUSE_MECHANISMS" and lane-arms.test.mjs ›
 * "modelNodes(record, port).generate_hypotheses and .challenge_hypothesis are
 * given the mechanism vocabulary evals.ROOT_CAUSE_MECHANISMS: the provider
 * schema's cause mechanism enum equals it exactly, and the system prompt
 * carries the vocabulary sentence".
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
test('runInvestigate with --replay, --roles model and injected env and createModelPort calls the injected factory once with the env credential, and the fake port it returns sees at least one call before the run ends', async () => {
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

/* -------------------------------------------------------------------------- */
/* 11. AIC-140: the tracing refusal is decided from process.env, never from   */
/*     deps.env alone — @langchain/core's own tracer reads this process's own */
/*     ambient process.env, not whatever env object an in-process caller      */
/*     passes to runInvestigate. Residual reviewer advisory (1), PRs #160/162.*/
/* -------------------------------------------------------------------------- */

test('runInvestigate(args, { env: cleanEnv }) called in-process still refuses tracing, naming LANGSMITH_API_KEY, when the real process.env carries LANGSMITH_TRACING=true and no key — even though the env object passed in carries neither', async () => {
  await withTempDir(async (dir) => {
    const investigateModule = await import('../apps/cli/dist/commands/investigate.js');
    const scenario = calibrationScenario();
    const replayPath = writeReplayFile(dir, replayFileContentFor(annotatedFixtureFor(scenario)));

    const cleanEnv = childEnv();
    assert.ok(
      !Object.keys(cleanEnv).some((name) => /LANGSMITH|LANGCHAIN/i.test(name)),
      'fixture sanity: childEnv() with no overrides must carry no tracing variable',
    );

    const savedEnv = {
      LANGSMITH_TRACING: process.env.LANGSMITH_TRACING,
      LANGSMITH_ENDPOINT: process.env.LANGSMITH_ENDPOINT,
      LANGCHAIN_ENDPOINT: process.env.LANGCHAIN_ENDPOINT,
      LANGSMITH_API_KEY: process.env.LANGSMITH_API_KEY,
      LANGCHAIN_API_KEY: process.env.LANGCHAIN_API_KEY,
    };
    try {
      // The no-ambient-tracing preload clears the tracing flags but leaves
      // any api key a developer's shell exports; this row's premise is "no
      // key", so it removes both key variables for its duration and restores
      // them in the finally below.
      delete process.env.LANGSMITH_API_KEY;
      delete process.env.LANGCHAIN_API_KEY;
      // A closed local port, never the real LangSmith endpoint — the same
      // reasoning as the spawned-process tracing row above: should this
      // row's expected refusal ever fail to fire, nothing it does may reach a
      // real host with a real key.
      process.env.LANGSMITH_TRACING = 'true';
      process.env.LANGSMITH_ENDPOINT = 'http://127.0.0.1:1';
      process.env.LANGCHAIN_ENDPOINT = 'http://127.0.0.1:1';
      await assert.rejects(
        investigateModule.runInvestigate(['--replay', replayPath, '--roles', 'scripted'], { env: cleanEnv }),
        /LANGSMITH_API_KEY/,
        'runInvestigate must still refuse naming LANGSMITH_API_KEY when the ambient process.env — the one @langchain/core actually reads — carries LANGSMITH_TRACING=true, regardless of what deps.env carries',
      );
    } finally {
      for (const [name, value] of Object.entries(savedEnv)) {
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      }
    }
  });
});

test('runInvestigate(args, { env: depsEnv }) called in-process does not refuse tracing when depsEnv carries LANGSMITH_TRACING=true but the real process.env carries no tracing flag, because @langchain/core would not actually trace off deps.env', async () => {
  await withTempDir(async (dir) => {
    const investigateModule = await import('../apps/cli/dist/commands/investigate.js');
    const scenario = calibrationScenario();
    const replayPath = writeReplayFile(dir, replayFileContentFor(annotatedFixtureFor(scenario)));

    assert.ok(
      !['LANGSMITH_TRACING', 'LANGSMITH_TRACING_V2', 'LANGCHAIN_TRACING', 'LANGCHAIN_TRACING_V2'].some(
        (name) => name in process.env,
      ),
      "fixture sanity: the suite's own no-ambient-tracing preload must have already cleared every tracing flag from process.env",
    );

    const depsEnv = { ...childEnv(), LANGSMITH_TRACING: 'true' };

    await assert.doesNotReject(
      investigateModule.runInvestigate(['--replay', replayPath, '--roles', 'scripted'], { env: depsEnv }),
      'runInvestigate must not refuse tracing from deps.env alone: the real process.env — what @langchain/core actually reads — carries no tracing flag, so no trace would ever be attempted',
    );
  });
});

/* -------------------------------------------------------------------------- */
/* 12. AIC-140: malformed fixture entries are named eagerly, at parse time —  */
/*     never surfaced as an unnamed internal error only when the graph        */
/*     happens to query that entry. Residual reviewer advisory (2), PRs       */
/*     #160/162.                                                              */
/* -------------------------------------------------------------------------- */

test('a --replay file whose fixture.entries[0].result is missing or not an object exits non-zero, writes nothing to stdout, and names fixture.entries[0].result on stderr', async () => {
  await withTempDir(async (dir) => {
    const scenario = calibrationScenario();
    const fixture = annotatedFixtureFor(scenario);

    for (const badResult of [undefined, 'not-an-object', 42, null, []]) {
      const content = replayFileContentFor(fixture);
      const [firstEntry, ...restEntries] = content.fixture.entries;
      const mutatedEntry = { ...firstEntry };
      if (badResult === undefined) {
        delete mutatedEntry.result;
      } else {
        mutatedEntry.result = badResult;
      }
      content.fixture = { ...content.fixture, entries: [mutatedEntry, ...restEntries] };
      const replayPath = writeReplayFile(dir, content);

      const args = ['investigate', '--replay', replayPath, '--roles', 'scripted'];
      const result = runCli(args);

      assert.notEqual(
        result.status,
        0,
        `fixture.entries[0].result = ${JSON.stringify(badResult)}: ${commandDiagnostics(args, result)}`,
      );
      assert.equal(
        result.stdout,
        '',
        `no stdout may be written on refusal for fixture.entries[0].result = ${JSON.stringify(badResult)}: ${commandDiagnostics(args, result)}`,
      );
      assert.match(
        result.stderr,
        /fixture\.entries\[0\]\.result/,
        `stderr must name fixture.entries[0].result as the problem for value ${JSON.stringify(badResult)}: ${commandDiagnostics(args, result)}`,
      );
    }
  });
});

test('a --replay file whose fixture.entries[0].input is present but not an object exits non-zero, writes nothing to stdout, and names fixture.entries[0].input on stderr', async () => {
  await withTempDir(async (dir) => {
    const scenario = calibrationScenario();
    const fixture = annotatedFixtureFor(scenario);

    for (const badInput of ['not-an-object', 42, true, [], null]) {
      const content = replayFileContentFor(fixture);
      const [firstEntry, ...restEntries] = content.fixture.entries;
      const mutatedEntry = { ...firstEntry, input: badInput };
      content.fixture = { ...content.fixture, entries: [mutatedEntry, ...restEntries] };
      const replayPath = writeReplayFile(dir, content);

      const args = ['investigate', '--replay', replayPath, '--roles', 'scripted'];
      const result = runCli(args);

      assert.notEqual(
        result.status,
        0,
        `fixture.entries[0].input = ${JSON.stringify(badInput)}: ${commandDiagnostics(args, result)}`,
      );
      assert.equal(
        result.stdout,
        '',
        `no stdout may be written on refusal for fixture.entries[0].input = ${JSON.stringify(badInput)}: ${commandDiagnostics(args, result)}`,
      );
      assert.match(
        result.stderr,
        /fixture\.entries\[0\]\.input/,
        `stderr must name fixture.entries[0].input as the problem for value ${JSON.stringify(badInput)}: ${commandDiagnostics(args, result)}`,
      );
    }
  });
});

test('a --replay file whose fixture.entries[0].input is nested 200000 levels deep is refused naming fixture.entries[0].input on stderr, never surfacing a raw "Maximum call stack size exceeded"', async () => {
  await withTempDir(async (dir) => {
    const scenario = calibrationScenario();
    const fixture = annotatedFixtureFor(scenario);
    const content = replayFileContentFor(fixture);
    const [firstEntry, ...restEntries] = content.fixture.entries;
    const DEEP_INPUT_MARKER = '"__AIC140_DEEP_INPUT__"';
    const mutatedEntry = { ...firstEntry, input: '__AIC140_DEEP_INPUT__' };
    content.fixture = { ...content.fixture, entries: [mutatedEntry, ...restEntries] };

    // Built iteratively, never recursively: JSON.stringify itself overflows
    // the stack on a 200000-deep JS object assembled by recursion, so the
    // deep structure never exists as a JS object here — it is built and
    // spliced in as raw JSON text instead.
    const DEPTH = 200_000;
    const deepJson = '{"nested":'.repeat(DEPTH) + '{}' + '}'.repeat(DEPTH);
    const contentJson = JSON.stringify(content);
    assert.ok(
      contentJson.includes(DEEP_INPUT_MARKER),
      'fixture sanity: the marker must appear exactly where fixture.entries[0].input will be spliced in',
    );
    const replayJson = contentJson.replace(DEEP_INPUT_MARKER, deepJson);
    const replayPath = join(dir, 'replay.json');
    writeFileSync(replayPath, replayJson, 'utf8');

    const args = ['investigate', '--replay', replayPath, '--roles', 'scripted'];
    const result = runCli(args);

    assert.notEqual(result.status, 0, commandDiagnostics(args, result));
    assert.equal(result.stdout, '', `no stdout may be written on refusal: ${commandDiagnostics(args, result)}`);
    assert.doesNotMatch(
      result.stderr,
      /Maximum call stack/,
      `stderr must never surface a raw stack-overflow message, only a named-field refusal: ${commandDiagnostics(args, result)}`,
    );
    assert.match(
      result.stderr,
      /fixture\.entries\[0\]\.input/,
      `stderr must name fixture.entries[0].input as the problem: ${commandDiagnostics(args, result)}`,
    );
  });
});

/* -------------------------------------------------------------------------- */
/* 13. AIC-140: a --replay file over the size bound is refused before parsing */
/*     it — never handed to JSON.parse at all. Residual reviewer advisory     */
/*     (5, size half only — no ceiling on budget.llmCallBudget: out of scope, */
/*     owner decision), PRs #160/162.                                        */
/* -------------------------------------------------------------------------- */

test('a --replay file larger than 16 MiB is refused before parsing, naming the size bound on stderr', async () => {
  await withTempDir(async (dir) => {
    const scenario = calibrationScenario();
    const content = replayFileContentFor(annotatedFixtureFor(scenario));
    const json = JSON.stringify(content);

    const MiB = 1024 * 1024;
    const targetBytes = 16 * MiB + 1;
    const padding = ' '.repeat(Math.max(0, targetBytes - Buffer.byteLength(json, 'utf8')));
    // Whitespace around a valid JSON document is insignificant to JSON.parse,
    // so this row's fixture is otherwise exactly the same well-formed replay
    // file every other row writes — only its byte size differs.
    const padded = padding + json;
    assert.equal(
      Buffer.byteLength(padded, 'utf8'),
      targetBytes,
      'fixture sanity: the padded replay file must be exactly 16 MiB + 1 byte',
    );

    const replayPath = join(dir, 'replay-oversized.json');
    writeFileSync(replayPath, padded, 'utf8');

    const args = ['investigate', '--replay', replayPath, '--roles', 'scripted'];
    const result = runCli(args);

    assert.notEqual(result.status, 0, commandDiagnostics(args, result));
    assert.equal(result.stdout, '', `no stdout may be written on refusal: ${commandDiagnostics(args, result)}`);
    assert.match(
      result.stderr,
      /16\s*MiB/i,
      `stderr must name the 16 MiB size bound: ${commandDiagnostics(args, result)}`,
    );
  });
});

/* -------------------------------------------------------------------------- */
/* 14. AIC-140: buildInitialState corresponds to evals' own initial benchmark */
/*     state, for the same runId/budget — including maxIterations. Residual   */
/*     reviewer advisory (3), PRs #160/162.                                   */
/* -------------------------------------------------------------------------- */

/**
 * `packages/evals/src/graph-benchmark.ts`'s own `initialBenchmarkState` is not
 * exported from `@aic/evals` (only its callers are), so this row's oracle is a
 * literal copy of the exact control-block field set it writes — read directly
 * from `packages/evals/src/graph-benchmark.ts` at the time of writing this
 * row, never a re-import of the CLI's own `buildInitialState` under a
 * different name. `maxIterations` is given a value (7) distinct from every
 * other budget field and from the literal `1` a prior round of this command
 * left unpinned for it (reviewer advisory (3), this file's module header),
 * so a hardcoded control field in either function could not coincidentally
 * satisfy this row's expectation.
 */
function evalsInitialControlFor(runId, budget) {
  return {
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
  };
}

test(
  "apps/cli/src/commands/investigate.ts exports buildInitialState(runId, content), whose control block (and empty hypotheses/predictions/tests/trials/evidence/assessments arrays) equal packages/evals/src/graph-benchmark.ts initialBenchmarkState's own start state for the same runId and budget, maxIterations included",
  async () => {
    const investigateModule = await import('../apps/cli/dist/commands/investigate.js');
    assert.equal(
      typeof investigateModule.buildInitialState,
      'function',
      'apps/cli/src/commands/investigate.ts must export buildInitialState(runId, content)',
    );

    const runId = 'aic140-start-state-correspondence-run';
    const budget = { maxIterations: 7, llmCallBudget: 11, reservedChallengeBudget: 3 };
    const incident = { id: 'aic140-start-state-incident', primaryScope: evals.BENCHMARK_PRIMARY_SCOPE };

    const state = investigateModule.buildInitialState(runId, { incident, budget });

    assert.deepEqual(state.incident, incident);
    assert.deepEqual(state.hypotheses, []);
    assert.deepEqual(state.predictions, []);
    assert.deepEqual(state.tests, []);
    assert.deepEqual(state.trials, []);
    assert.deepEqual(state.evidence, []);
    assert.deepEqual(state.assessments, []);
    assert.deepEqual(state.control, evalsInitialControlFor(runId, budget));
  },
);

/* -------------------------------------------------------------------------- */
/* 15. AIC-140 review fixes: bounded reads and refusals that never echo    */
/* -------------------------------------------------------------------------- */

/**
 * `statSync(path).size` is 0 for a FIFO, a character device or a pipe, so a
 * stat-then-read size bound never fires for one and an unbounded read reads
 * whatever the producer supplies. The replay path must be opened once, refused by name
 * when it is not a regular file, and read no more than the size bound + 1
 * byte from that same descriptor.
 *
 * Nobody writes to the FIFO in this row: a command that still opens it for
 * read and blocks waiting for a writer must be caught by the spawn timeout
 * below, so a hang fails this one row rather than the whole suite.
 */
test(
  'a --replay path that is a FIFO (named pipe), not a regular file, is refused by name before any read, and never hangs waiting for a writer',
  async (t) => {
    await withTempDir(async (dir) => {
      const fifoPath = join(dir, 'replay.fifo');
      try {
        execFileSync('mkfifo', [fifoPath], { env: childEnv() });
      } catch (error) {
        t.skip(`mkfifo is not available on this platform: ${error.message}`);
        return;
      }

      const args = ['investigate', '--replay', fifoPath, '--roles', 'scripted'];
      const result = runCli(args, { timeout: 10_000 });

      assert.equal(
        result.signal,
        null,
        `the command must not still be blocked reading the FIFO 10s in (killed by ${result.signal}): ${commandDiagnostics(args, result)}`,
      );
      assert.notEqual(result.status, 0, commandDiagnostics(args, result));
      assert.equal(result.stdout, '', `no stdout may be written on refusal: ${commandDiagnostics(args, result)}`);
      assert.match(
        result.stderr,
        /not a regular file/i,
        `stderr must say the replay path is not a regular file: ${commandDiagnostics(args, result)}`,
      );
    });
  },
);

/**
 * a symlink to
 * `/dev/zero` has `stat().size === 0` too, so the size bound never fires and
 * an unbounded read runs indefinitely. Same fix, same fail-closed refusal.
 */
test(
  'a --replay path that is a symlink to /dev/zero, not a regular file, is refused by name before any read, and never hangs reading an infinite device',
  async (t) => {
    await withTempDir(async (dir) => {
      if (!existsSync('/dev/zero')) {
        t.skip('/dev/zero is not present on this platform');
        return;
      }
      const linkPath = join(dir, 'replay-zero.json');
      symlinkSync('/dev/zero', linkPath);

      const args = ['investigate', '--replay', linkPath, '--roles', 'scripted'];
      const result = runCli(args, { timeout: 10_000 });

      assert.equal(
        result.signal,
        null,
        `the command must not still be reading /dev/zero 10s in (killed by ${result.signal}): ${commandDiagnostics(args, result)}`,
      );
      assert.notEqual(result.status, 0, commandDiagnostics(args, result));
      assert.equal(result.stdout, '', `no stdout may be written on refusal: ${commandDiagnostics(args, result)}`);
      assert.match(
        result.stderr,
        /not a regular file/i,
        `stderr must say the replay path is not a regular file: ${commandDiagnostics(args, result)}`,
      );
    });
  },
);

/**
 * the `.result` and
 * `.input` refusals echo the untrusted value through an unbounded recursive
 * `JSON.stringify` BEFORE any bounded walk runs. `ownRecord` rejects arrays,
 * so a deep ARRAY never reaches `boundedJsonViolation` at all — it dies in
 * the throw expression's own `JSON.stringify`, printing the bare
 * `RangeError` message the CLI's other deep-value rows above already forbid
 * for the object-nesting shape. Built iteratively, never recursively, the
 * same way the existing 200000-deep OBJECT `.input` row above builds its
 * value — as raw JSON text, spliced in by a marker, never as a JS value this
 * process would have to construct (or stringify) by recursion itself.
 */
test(
  'a --replay file whose fixture.entries[0].input is a 200000-deep ARRAY is refused naming fixture.entries[0].input, never a raw "Maximum call stack size exceeded"',
  async () => {
    await withTempDir(async (dir) => {
      const scenario = calibrationScenario();
      const fixture = annotatedFixtureFor(scenario);
      const content = replayFileContentFor(fixture);
      const [firstEntry, ...restEntries] = content.fixture.entries;
      const DEEP_ARRAY_MARKER = '"__AIC140_DEEP_ARRAY_INPUT__"';
      const mutatedEntry = { ...firstEntry, input: '__AIC140_DEEP_ARRAY_INPUT__' };
      content.fixture = { ...content.fixture, entries: [mutatedEntry, ...restEntries] };

      const DEPTH = 200_000;
      const deepArrayJson = '['.repeat(DEPTH) + '[]' + ']'.repeat(DEPTH);
      const contentJson = JSON.stringify(content);
      assert.ok(
        contentJson.includes(DEEP_ARRAY_MARKER),
        'fixture sanity: the marker must appear exactly where fixture.entries[0].input will be spliced in',
      );
      const replayJson = contentJson.replace(DEEP_ARRAY_MARKER, deepArrayJson);
      const replayPath = join(dir, 'replay.json');
      writeFileSync(replayPath, replayJson, 'utf8');

      const args = ['investigate', '--replay', replayPath, '--roles', 'scripted'];
      const result = runCli(args);

      assert.notEqual(result.status, 0, commandDiagnostics(args, result));
      assert.equal(result.stdout, '', `no stdout may be written on refusal: ${commandDiagnostics(args, result)}`);
      assert.doesNotMatch(
        result.stderr,
        /Maximum call stack/,
        `stderr must never surface a raw stack-overflow message from echoing the untrusted array whole, only a named-field refusal: ${commandDiagnostics(args, result)}`,
      );
      assert.match(
        result.stderr,
        /fixture\.entries\[0\]\.input/,
        `stderr must name fixture.entries[0].input as the problem: ${commandDiagnostics(args, result)}`,
      );
    });
  },
);

/**
 * The same for the `.result` field, which `parseFixture` checks before
 * `.input`.
 */
test(
  'a --replay file whose fixture.entries[0].result is a 200000-deep ARRAY is refused naming fixture.entries[0].result, never a raw "Maximum call stack size exceeded"',
  async () => {
    await withTempDir(async (dir) => {
      const scenario = calibrationScenario();
      const fixture = annotatedFixtureFor(scenario);
      const content = replayFileContentFor(fixture);
      const [firstEntry, ...restEntries] = content.fixture.entries;
      const DEEP_ARRAY_MARKER = '"__AIC140_DEEP_ARRAY_RESULT__"';
      const mutatedEntry = { ...firstEntry, result: '__AIC140_DEEP_ARRAY_RESULT__' };
      content.fixture = { ...content.fixture, entries: [mutatedEntry, ...restEntries] };

      const DEPTH = 200_000;
      const deepArrayJson = '['.repeat(DEPTH) + '[]' + ']'.repeat(DEPTH);
      const contentJson = JSON.stringify(content);
      assert.ok(
        contentJson.includes(DEEP_ARRAY_MARKER),
        'fixture sanity: the marker must appear exactly where fixture.entries[0].result will be spliced in',
      );
      const replayJson = contentJson.replace(DEEP_ARRAY_MARKER, deepArrayJson);
      const replayPath = join(dir, 'replay.json');
      writeFileSync(replayPath, replayJson, 'utf8');

      const args = ['investigate', '--replay', replayPath, '--roles', 'scripted'];
      const result = runCli(args);

      assert.notEqual(result.status, 0, commandDiagnostics(args, result));
      assert.equal(result.stdout, '', `no stdout may be written on refusal: ${commandDiagnostics(args, result)}`);
      assert.doesNotMatch(
        result.stderr,
        /Maximum call stack/,
        `stderr must never surface a raw stack-overflow message from echoing the untrusted array whole, only a named-field refusal: ${commandDiagnostics(args, result)}`,
      );
      assert.match(
        result.stderr,
        /fixture\.entries\[0\]\.result/,
        `stderr must name fixture.entries[0].result as the problem: ${commandDiagnostics(args, result)}`,
      );
    });
  },
);

/**
 * the same echo is bounded only by
 * the 16 MiB file bound, so a large non-record `.result` prints its whole
 * value to the operator's stderr. The refusal
 * must name the field and the value's KIND, never the value itself.
 */
test(
  'a --replay file whose fixture.entries[0].result is a ~12 MiB non-object string is refused with bounded stderr, never echoing the value whole',
  async () => {
    await withTempDir(async (dir) => {
      const scenario = calibrationScenario();
      const fixture = annotatedFixtureFor(scenario);
      const content = replayFileContentFor(fixture);
      const [firstEntry, ...restEntries] = content.fixture.entries;
      const bigString = 'a'.repeat(12 * 1024 * 1024);
      const mutatedEntry = { ...firstEntry, result: bigString };
      content.fixture = { ...content.fixture, entries: [mutatedEntry, ...restEntries] };
      const replayPath = writeReplayFile(dir, content);

      const args = ['investigate', '--replay', replayPath, '--roles', 'scripted'];
      const result = runCli(args);

      assert.notEqual(result.status, 0, commandDiagnostics(args, result));
      assert.equal(result.stdout, '', `no stdout may be written on refusal: ${commandDiagnostics(args, result)}`);
      assert.match(
        result.stderr,
        /fixture\.entries\[0\]\.result/,
        `stderr must name fixture.entries[0].result as the problem: ${commandDiagnostics(args, result)}`,
      );
      const stderrBytes = Buffer.byteLength(result.stderr, 'utf8');
      assert.ok(
        stderrBytes < 4096,
        `a refusal must never echo an untrusted ~12 MiB value whole, only the field and the value's kind; got ${stderrBytes} bytes of stderr: ${JSON.stringify(result.stderr.slice(0, 200))}...`,
      );
    });
  },
);

/**
 * `IncidentSchema.safeParse` keeps
 * unknown keys, so the same bounded walk that already covers
 * `entries[].input` must also cover `incident` — never left to overflow the
 * stack later, deep inside `@langchain/langgraph`'s own unbounded recursive
 * walk over the initial state.
 */
test(
  'a --replay file whose incident carries a 200000-deep OBJECT extra field is refused naming incident, never a raw "Maximum call stack size exceeded"',
  async () => {
    await withTempDir(async (dir) => {
      const scenario = calibrationScenario();
      const fixture = annotatedFixtureFor(scenario);
      const content = replayFileContentFor(fixture);
      const DEEP_INCIDENT_MARKER = '"__AIC140_DEEP_INCIDENT_EXTRA__"';
      content.incident = { ...content.incident, extra: '__AIC140_DEEP_INCIDENT_EXTRA__' };

      const DEPTH = 200_000;
      const deepObjectJson = '{"nested":'.repeat(DEPTH) + '{}' + '}'.repeat(DEPTH);
      const contentJson = JSON.stringify(content);
      assert.ok(
        contentJson.includes(DEEP_INCIDENT_MARKER),
        'fixture sanity: the marker must appear exactly where incident.extra will be spliced in',
      );
      const replayJson = contentJson.replace(DEEP_INCIDENT_MARKER, deepObjectJson);
      const replayPath = join(dir, 'replay.json');
      writeFileSync(replayPath, replayJson, 'utf8');

      const args = ['investigate', '--replay', replayPath, '--roles', 'scripted'];
      const result = runCli(args);

      assert.notEqual(result.status, 0, commandDiagnostics(args, result));
      assert.equal(result.stdout, '', `no stdout may be written on refusal: ${commandDiagnostics(args, result)}`);
      assert.doesNotMatch(
        result.stderr,
        /Maximum call stack/,
        `stderr must never surface a raw stack-overflow message from walking the incident unbounded: ${commandDiagnostics(args, result)}`,
      );
      assert.match(
        result.stderr,
        /incident/,
        `stderr must name incident as the problem: ${commandDiagnostics(args, result)}`,
      );
    });
  },
);

/**
 * `'input' in entryRecord`
 * treats `input` as optional, while `PlannedReplayScenarioEntry`
 * (`packages/tools/replay/index.ts`) declares it required. An entry with no
 * `input` at all must be refused the same way a present-but-wrong-shaped one
 * already is, naming the same field.
 */
test(
  'a --replay file whose fixture.entries[0] carries no input field at all is refused naming fixture.entries[0].input, since PlannedReplayScenarioEntry declares input required',
  async () => {
    await withTempDir(async (dir) => {
      const scenario = calibrationScenario();
      const fixture = annotatedFixtureFor(scenario);
      const content = replayFileContentFor(fixture);
      const [firstEntry, ...restEntries] = content.fixture.entries;
      const { input, ...entryWithoutInput } = firstEntry;
      content.fixture = { ...content.fixture, entries: [entryWithoutInput, ...restEntries] };
      const replayPath = writeReplayFile(dir, content);

      const args = ['investigate', '--replay', replayPath, '--roles', 'scripted'];
      const result = runCli(args);

      assert.notEqual(result.status, 0, commandDiagnostics(args, result));
      assert.equal(result.stdout, '', `no stdout may be written on refusal: ${commandDiagnostics(args, result)}`);
      assert.match(
        result.stderr,
        /fixture\.entries\[0\]\.input/,
        `stderr must name fixture.entries[0].input as missing, since PlannedReplayScenarioEntry declares it required: ${commandDiagnostics(args, result)}`,
      );
    });
  },
);

/* -------------------------------------------------------------------------- */
/* 16. No refusal echoes an untrusted value whole: budget, asOf and          */
/*     fixture.version name the field and the value's kind too.             */
/* -------------------------------------------------------------------------- */

for (const [field, mutate] of [
  ['budget.maxIterations', (content, big) => ({ ...content, budget: { ...content.budget, maxIterations: big } })],
  ['asOf', (content, big) => ({ ...content, asOf: big })],
  ['fixture.version', (content, big) => ({ ...content, fixture: { ...content.fixture, version: big } })],
]) {
  test(`a --replay file whose ${field} is a ~12 MiB string is refused with bounded stderr naming ${field}, never echoing the value whole`, async () => {
    await withTempDir(async (dir) => {
      const scenario = calibrationScenario();
      const content = mutate(replayFileContentFor(annotatedFixtureFor(scenario)), 'a'.repeat(12 * 1024 * 1024));
      const replayPath = writeReplayFile(dir, content);

      const args = ['investigate', '--replay', replayPath, '--roles', 'scripted'];
      const result = runCli(args);

      assert.notEqual(result.status, 0, commandDiagnostics(args, result));
      assert.equal(result.stdout, '', `no stdout may be written on refusal: ${commandDiagnostics(args, result)}`);
      assert.ok(result.stderr.includes(field), `stderr must name ${field}: ${JSON.stringify(result.stderr.slice(0, 200))}`);
      const stderrBytes = Buffer.byteLength(result.stderr, 'utf8');
      assert.ok(stderrBytes < 4096, `a refusal must never echo a ~12 MiB value whole; got ${stderrBytes} bytes of stderr`);
    });
  });
}

for (const field of ['budget.maxIterations', 'fixture.version']) {
  test(`a --replay file whose ${field} is a 200000-deep array is refused naming ${field}, never with "Maximum call stack size exceeded"`, async () => {
    await withTempDir(async (dir) => {
      const scenario = calibrationScenario();
      const content = replayFileContentFor(annotatedFixtureFor(scenario));
      const placeholder = '"__AIC140_DEEP__"';
      if (field === 'budget.maxIterations') content.budget = { ...content.budget, maxIterations: '__AIC140_DEEP__' };
      else content.fixture = { ...content.fixture, version: '__AIC140_DEEP__' };
      const depth = 200000;
      const text = JSON.stringify(content).replace(placeholder, `${'['.repeat(depth)}${']'.repeat(depth)}`);
      const replayPath = join(dir, 'replay.json');
      writeFileSync(replayPath, text);

      const args = ['investigate', '--replay', replayPath, '--roles', 'scripted'];
      const result = runCli(args);

      assert.notEqual(result.status, 0, commandDiagnostics(args, result));
      assert.equal(result.stdout, '', `no stdout may be written on refusal: ${commandDiagnostics(args, result)}`);
      assert.ok(result.stderr.includes(field), `stderr must name ${field}: ${JSON.stringify(result.stderr.slice(0, 200))}`);
      assert.doesNotMatch(result.stderr, /Maximum call stack/);
    });
  });
}
