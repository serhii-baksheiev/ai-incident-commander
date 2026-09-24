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
 * (Terminology section, around lines 148-153) fixes for AIC-99:
 * `aic service add`, `aic env add`, `aic source add`/`aic source check`,
 * `aic policy set`, `aic incident start`, plus `aic doctor` and `aic apply -f`.
 * This slice's dispatcher exposes each noun as a stub; the subcommands under
 * a noun are later slices' work.
 */
const ONBOARDING_NOUNS = ['service', 'env', 'source', 'policy', 'incident', 'doctor', 'apply'];

function runCli(args, cwd) {
  return spawnSync(process.execPath, [cliPath, ...args], {
    cwd: cwd ?? projectRoot,
    encoding: 'utf8',
    env: childEnv(),
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

test('general help lists every onboarding noun the integration-boundary ADR fixes, and not start or resume as top-level commands', () => {
  const args = ['--help'];
  const result = runCli(args);

  assert.equal(result.status, 0, commandDiagnostics(args, result));
  for (const noun of ONBOARDING_NOUNS) {
    assert.match(
      result.stdout,
      new RegExp(`^\\s*${noun}\\b`, 'm'),
      `general help must list the "${noun}" onboarding noun the ADR fixes`,
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

for (const noun of ONBOARDING_NOUNS) {
  test(`the "${noun}" onboarding stub exits non-zero, names itself not implemented, and writes nothing to the working directory`, () => {
    withTempCwd((cwd) => {
      const before = readdirSync(cwd);
      const args = [noun];
      const result = runCli(args, cwd);

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
