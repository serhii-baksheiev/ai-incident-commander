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
 */
const STUB_NOUNS = ['incident', 'apply'];
const REGISTRY_NOUNS = ['service', 'env', 'source', 'policy', 'credential'];
const ALL_ONBOARDING_NOUNS = [...REGISTRY_NOUNS, ...STUB_NOUNS];

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
