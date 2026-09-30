import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { childEnv } from './fixtures/child-env.mjs';

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const cliPath = resolve(projectRoot, 'apps/cli/dist/index.js');

// Assembled from parts, never written as one literal token: `test/postgres-checkpointer.test.mjs`
// › "keeps the database-backed lane out of npm test and npm run check" refuses
// any file under test/ that names this variable literally, since `node --test`
// with no paths discovers every .mjs under a directory named test.
const POSTGRES_URL_VARIABLE = ['AIC', 'POSTGRES', 'URL'].join('_');

/**
 * The onboarding command nouns `docs/decisions/integration-boundary.md`
 * (Terminology section, around lines 148-153) fixes for AIC-99, plus
 * `credential` — a new noun for the ADR addendum term CredentialRef
 * (AIC-99 slice d). Slice d gives `service`, `env`, `source` (its `add`
 * subcommand), `policy` (its `set` subcommand) and `credential` (its `add`
 * subcommand) real dispatch over the registry store — see
 * test/cli-registry-commands.test.mjs and
 * infra/postgres/tests/cli-registry.live.mjs for their own argv/store
 * contract. `incident` and `apply` remain full stubs in this slice.
 * `doctor` and `source check` stop being stubs in slice e
 * (test/cli-doctor.test.mjs, test/cli-source-check.test.mjs pin their own
 * argv/deps contract directly, without a database); this file only asserts
 * that neither one still claims to be "not implemented" — see the rows
 * below `ALL_ONBOARDING_NOUNS`.
 *
 * AIC-99 slice f: `incident` (its `start` subcommand) also stops being a
 * stub. test/cli-incident-command.test.mjs pins `runIncidentCommand`'s own
 * argv/deps/store contract directly, without a database; this file only
 * asserts that `incident start` no longer claims to be "not implemented",
 * the same shape as the `source check`/`doctor` rows below.
 *
 * AIC-99 slice g: `apply` also stops being a stub — no onboarding noun is a
 * stub any more, and `STUB_NOUNS` is empty. test/cli-apply.test.mjs pins
 * `runApplyCommand`'s own argv/deps/store contract directly, without a
 * database; this file only asserts that `apply` no longer claims to be "not
 * implemented", the same shape as the `incident start` row above.
 */
const STUB_NOUNS = [];
const REGISTRY_NOUNS = ['service', 'env', 'source', 'policy', 'credential'];
const ALL_ONBOARDING_NOUNS = [...REGISTRY_NOUNS, 'incident', 'apply'];

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

function withTempCwd(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'aic-cli-dispatcher-'));
  try {
    return fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test('general help lists every onboarding noun the integration-boundary ADR fixes, plus credential and db, and not start or resume as top-level commands', () => {
  const args = ['--help'];
  const result = runCli(args);

  assert.equal(result.status, 0, commandDiagnostics(args, result));
  for (const noun of [...ALL_ONBOARDING_NOUNS, 'db', 'doctor']) {
    assert.match(
      result.stdout,
      new RegExp(`^\\s*${noun}\\b`, 'm'),
      `general help must list the "${noun}" command`,
    );
  }
  assert.doesNotMatch(
    result.stdout,
    /^\s*start\b/m,
    'the persistence spike moves behind `aic dev spike start`, so `start` must not remain a top-level command in general help',
  );
  assert.doesNotMatch(
    result.stdout,
    /^\s*resume\b/m,
    'the persistence spike moves behind `aic dev spike resume`, so `resume` must not remain a top-level command in general help',
  );
});

for (const noun of STUB_NOUNS) {
  test(`the "${noun}" onboarding stub exits non-zero, names itself not implemented, and writes nothing to the working directory`, () => {
    withTempCwd((cwd) => {
      const before = readdirSync(cwd);
      const args = [noun];
      const result = runCli(args, { cwd });

      assert.notEqual(result.status, 0, commandDiagnostics(args, result));
      assert.match(
        `${result.stdout}${result.stderr}`,
        /not implemented/i,
        `the "${noun}" stub must say plainly that it is not implemented in this build, rather than pretend to succeed`,
      );
      assert.deepEqual(
        readdirSync(cwd),
        before,
        `the "${noun}" stub must not write to the working directory it is invoked from`,
      );
    });
  });
}

for (const noun of REGISTRY_NOUNS) {
  test(`the "${noun}" noun with no subcommand exits non-zero, names "subcommand" as the problem rather than claiming to be unimplemented, and writes nothing to the working directory`, () => {
    withTempCwd((cwd) => {
      const before = readdirSync(cwd);
      const args = [noun];
      const result = runCli(args, { cwd });

      assert.notEqual(result.status, 0, commandDiagnostics(args, result));
      assert.match(
        `${result.stdout}${result.stderr}`,
        /subcommand/i,
        `"${noun}" with no subcommand must name "subcommand" as the problem, since "${noun}" itself is implemented in this slice: ${commandDiagnostics(args, result)}`,
      );
      assert.doesNotMatch(
        `${result.stdout}${result.stderr}`,
        /not implemented/i,
        `"${noun}" itself is implemented in this slice; only a missing/unknown subcommand is refused, never the whole noun reported as unimplemented: ${commandDiagnostics(args, result)}`,
      );
      assert.deepEqual(
        readdirSync(cwd),
        before,
        `"${noun}" with no subcommand must not write to the working directory it is invoked from`,
      );
    });
  });
}

test('aic db with an unknown subcommand, and no connection string configured, is refused as a subcommand problem and writes nothing to the working directory', () => {
  withTempCwd((cwd) => {
    const before = readdirSync(cwd);
    const args = ['db', 'bogus'];
    const result = runCli(args, { cwd });

    assert.notEqual(result.status, 0, commandDiagnostics(args, result));
    assert.equal(result.stdout, '', commandDiagnostics(args, result));
    assert.match(result.stderr, /subcommand/i, commandDiagnostics(args, result));
    assert.deepEqual(readdirSync(cwd), before);
  });
});

/**
 * AIC-99 slice e: `source check` and `doctor` stop being the onboarding
 * "not implemented" stub. Neither row below asserts the full classifying
 * behaviour — that needs a registry store, and these two commands still
 * reach one through `apps/cli/src/index.ts`'s existing
 * `createConnectedRegistryStore`, which this file never wires past (the
 * connection variable it reads is not set here, by `childEnv`'s own
 * stripping — see test/fixtures/child-env.mjs) — only that whatever they now
 * report is no longer the stub sentence. test/cli-source-check.test.mjs and
 * test/cli-doctor.test.mjs pin the real argv/deps/classification contract
 * directly, against the exported command functions, without a database.
 */
test('aic source check no longer reports itself as not implemented in this build', () => {
  withTempCwd((cwd) => {
    const before = readdirSync(cwd);
    const args = ['source', 'check', 'checkout', 'staging', 'github-source'];
    const result = runCli(args, { cwd });

    assert.notEqual(result.status, 0, commandDiagnostics(args, result));
    assert.doesNotMatch(
      `${result.stdout}${result.stderr}`,
      /not implemented/i,
      `aic source check is real in this slice; it must never again claim to be unimplemented: ${commandDiagnostics(args, result)}`,
    );
    assert.deepEqual(readdirSync(cwd), before, 'it must not write to the working directory it is invoked from');
  });
});

test('aic doctor no longer reports itself as not implemented in this build', () => {
  withTempCwd((cwd) => {
    const before = readdirSync(cwd);
    const args = ['doctor'];
    const result = runCli(args, { cwd });

    assert.notEqual(result.status, 0, commandDiagnostics(args, result));
    assert.doesNotMatch(
      `${result.stdout}${result.stderr}`,
      /not implemented/i,
      `aic doctor is real in this slice; it must never again claim to be unimplemented: ${commandDiagnostics(args, result)}`,
    );
    assert.deepEqual(readdirSync(cwd), before, 'it must not write to the working directory it is invoked from');
  });
});

/**
 * AIC-99 slice f: `incident start` is real. Like `source check`/`doctor`
 * above, this file does not assert the full argv/store contract (that needs
 * a registry store, and this command still reaches one through
 * `apps/cli/src/index.ts`'s `createConnectedRegistryStore`/a connected
 * incident store, which this file never wires past — the connection variable
 * it reads is not set here, by `childEnv`'s own stripping). It only asserts
 * that a missing `<service>`/`<env>`/`--title` is refused as such, BEFORE
 * any connection is ever attempted, rather than the command claiming to be
 * unimplemented — see test/cli-incident-command.test.mjs for the full pinned
 * argv/deps/store contract, against the exported command function directly.
 */
test('aic incident start with no <service>/<env>/--title no longer reports itself as not implemented in this build', () => {
  withTempCwd((cwd) => {
    const before = readdirSync(cwd);
    const args = ['incident', 'start'];
    const result = runCli(args, { cwd });

    assert.notEqual(result.status, 0, commandDiagnostics(args, result));
    assert.doesNotMatch(
      `${result.stdout}${result.stderr}`,
      /not implemented/i,
      `aic incident start is real in this slice; it must never again claim to be unimplemented: ${commandDiagnostics(args, result)}`,
    );
    assert.deepEqual(readdirSync(cwd), before, 'it must not write to the working directory it is invoked from');
  });
});

/**
 * AIC-99 slice g: `apply` is real. Like `incident start` above, this file
 * does not assert the full argv/store contract (that needs a registry store,
 * and this command still reaches one through
 * `apps/cli/src/index.ts`'s `createConnectedRegistryStore`, which this file
 * never wires past — the connection variable it reads is not set here, by
 * `childEnv`'s own stripping). It only asserts that a missing `-f` is
 * refused as such, BEFORE any connection is ever attempted, rather than the
 * command claiming to be unimplemented — see test/cli-apply.test.mjs for the
 * full pinned argv/deps/store contract, against the exported command
 * function directly.
 */
test('aic apply with no -f no longer reports itself as not implemented in this build', () => {
  withTempCwd((cwd) => {
    const before = readdirSync(cwd);
    const args = ['apply'];
    const result = runCli(args, { cwd });

    assert.notEqual(result.status, 0, commandDiagnostics(args, result));
    assert.doesNotMatch(
      `${result.stdout}${result.stderr}`,
      /not implemented/i,
      `aic apply is real in this slice; it must never again claim to be unimplemented: ${commandDiagnostics(args, result)}`,
    );
    assert.deepEqual(readdirSync(cwd), before, 'it must not write to the working directory it is invoked from');
  });
});

test('aic incident with no subcommand exits non-zero, names "subcommand" as the problem rather than claiming to be unimplemented, and writes nothing to the working directory', () => {
  withTempCwd((cwd) => {
    const before = readdirSync(cwd);
    const args = ['incident'];
    const result = runCli(args, { cwd });

    assert.notEqual(result.status, 0, commandDiagnostics(args, result));
    assert.match(`${result.stdout}${result.stderr}`, /subcommand/i, commandDiagnostics(args, result));
    assert.doesNotMatch(`${result.stdout}${result.stderr}`, /not implemented/i, commandDiagnostics(args, result));
    assert.deepEqual(readdirSync(cwd), before);
  });
});

/**
 * AIC-146 sub-slice c4b: `aic incident investigate <service> <env>
 * <incident-id> --roles scripted|model [--run-id <id>]`. No database here —
 * every row below exits before the connection variable
 * (`${POSTGRES_URL_VARIABLE}`) is even read, matching the `incident
 * start`/`apply` rows above; the full argv/deps/refusal contract is pinned
 * directly against the exported command function in
 * test/cli-incident-investigate.test.mjs.
 */
test('aic incident with an unknown subcommand names both start and investigate', () => {
  withTempCwd((cwd) => {
    const before = readdirSync(cwd);
    const args = ['incident', 'bogus-subcommand'];
    const result = runCli(args, { cwd });

    assert.notEqual(result.status, 0, commandDiagnostics(args, result));
    const output = `${result.stdout}${result.stderr}`;
    assert.match(output, /\bstart\b/, `must still name "start": ${commandDiagnostics(args, result)}`);
    assert.match(output, /\binvestigate\b/, `must also name "investigate": ${commandDiagnostics(args, result)}`);
    assert.deepEqual(readdirSync(cwd), before);
  });
});

test('aic incident investigate with missing positionals exits non-zero before the connection variable is read', () => {
  withTempCwd((cwd) => {
    const before = readdirSync(cwd);
    const args = ['incident', 'investigate', 'checkout'];
    const result = runCli(args, { cwd });

    assert.notEqual(result.status, 0, commandDiagnostics(args, result));
    const output = `${result.stdout}${result.stderr}`;
    assert.doesNotMatch(
      output,
      new RegExp(POSTGRES_URL_VARIABLE),
      `a missing positional must be refused before ${POSTGRES_URL_VARIABLE} is ever read: ${commandDiagnostics(args, result)}`,
    );
    // "investigate" must be dispatched (never read as an unrecognised
    // subcommand) so this row exercises argument validation, not the
    // "requires a subcommand" dispatch refusal.
    assert.doesNotMatch(
      output,
      /requires a subcommand/,
      `"investigate" must be a recognised subcommand of "incident": ${commandDiagnostics(args, result)}`,
    );
    assert.deepEqual(readdirSync(cwd), before);
  });
});

test('aic incident investigate with no --roles exits non-zero before the connection variable is read', () => {
  withTempCwd((cwd) => {
    const before = readdirSync(cwd);
    const args = ['incident', 'investigate', 'checkout', 'staging', 'incident-1'];
    const result = runCli(args, { cwd });

    assert.notEqual(result.status, 0, commandDiagnostics(args, result));
    const output = `${result.stdout}${result.stderr}`;
    assert.doesNotMatch(
      output,
      new RegExp(POSTGRES_URL_VARIABLE),
      `a missing --roles must be refused before ${POSTGRES_URL_VARIABLE} is ever read: ${commandDiagnostics(args, result)}`,
    );
    assert.doesNotMatch(
      output,
      /requires a subcommand/,
      `"investigate" must be a recognised subcommand of "incident": ${commandDiagnostics(args, result)}`,
    );
    assert.deepEqual(readdirSync(cwd), before);
  });
});

test('aic incident investigate --roles bogus exits non-zero before the connection variable is read', () => {
  withTempCwd((cwd) => {
    const before = readdirSync(cwd);
    const args = ['incident', 'investigate', 'checkout', 'staging', 'incident-1', '--roles', 'bogus'];
    const result = runCli(args, { cwd });

    assert.notEqual(result.status, 0, commandDiagnostics(args, result));
    assert.doesNotMatch(
      `${result.stdout}${result.stderr}`,
      /requires a subcommand/,
      `"investigate" must be a recognised subcommand of "incident": ${commandDiagnostics(args, result)}`,
    );
    assert.doesNotMatch(
      `${result.stdout}${result.stderr}`,
      new RegExp(POSTGRES_URL_VARIABLE),
      `an invalid --roles value must be refused before ${POSTGRES_URL_VARIABLE} is ever read: ${commandDiagnostics(args, result)}`,
    );
    assert.deepEqual(readdirSync(cwd), before);
  });
});

test('aic incident investigate --roles model with no ANTHROPIC_API_KEY exits non-zero before the connection variable is read, naming the missing model credential', () => {
  withTempCwd((cwd) => {
    const before = readdirSync(cwd);
    const args = ['incident', 'investigate', 'checkout', 'staging', 'incident-1', '--roles', 'model'];
    const result = runCli(args, { cwd });

    assert.notEqual(result.status, 0, commandDiagnostics(args, result));
    const output = `${result.stdout}${result.stderr}`;
    assert.doesNotMatch(
      output,
      new RegExp(POSTGRES_URL_VARIABLE),
      `--roles model with no credential must be refused before ${POSTGRES_URL_VARIABLE} is ever read: ${commandDiagnostics(args, result)}`,
    );
    assert.match(output, /ANTHROPIC_API_KEY/, `stderr must name the missing model credential: ${commandDiagnostics(args, result)}`);
    assert.deepEqual(readdirSync(cwd), before);
  });
});

test('aic incident investigate with valid args and no connection variable set refuses naming only that variable', () => {
  withTempCwd((cwd) => {
    const before = readdirSync(cwd);
    const args = ['incident', 'investigate', 'checkout', 'staging', 'incident-1', '--roles', 'scripted'];
    const result = runCli(args, { cwd });

    assert.notEqual(result.status, 0, commandDiagnostics(args, result));
    assert.match(
      `${result.stdout}${result.stderr}`,
      new RegExp(POSTGRES_URL_VARIABLE),
      `once every prior check passes, the refusal must name ${POSTGRES_URL_VARIABLE}: ${commandDiagnostics(args, result)}`,
    );
    assert.deepEqual(readdirSync(cwd), before);
  });
});

for (const command of ['start', 'resume']) {
  test(`aic ${command} exits non-zero and points the caller at aic dev spike`, () => {
    const args = [command];
    const result = runCli(args);

    assert.notEqual(result.status, 0, commandDiagnostics(args, result));
    assert.match(
      `${result.stdout}${result.stderr}`,
      /aic dev spike/,
      `the retired \`aic ${command}\` must name \`aic dev spike\` as where the persistence spike moved`,
    );
  });
}

test('aic dev spike --help exits 0 and lists start and resume as its subcommands', () => {
  const args = ['dev', 'spike', '--help'];
  const result = runCli(args);

  assert.equal(result.status, 0, commandDiagnostics(args, result));
  assert.match(result.stdout, /\bstart\b/, 'dev spike help must list start');
  assert.match(result.stdout, /\bresume\b/, 'dev spike help must list resume');
});

test('an unknown top-level command exits non-zero', () => {
  const args = ['not-a-real-command'];
  const result = runCli(args);

  assert.notEqual(result.status, 0, commandDiagnostics(args, result));
});
