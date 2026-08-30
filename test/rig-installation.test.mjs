import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const newRigArtifacts = [
  '.claude/hooks/guard-rulebook.mjs',
  '.claude/hooks/lib/hook-input.mjs',
  '.claude/scripts/doctor.mjs',
  '.claude/scripts/unattended-flag.mjs',
];

function readJson(path) {
  return JSON.parse(readFileSync(resolve(projectRoot, path), 'utf8'));
}

function sha256(path) {
  return createHash('sha256')
    .update(readFileSync(resolve(projectRoot, path)))
    .digest('hex');
}

function hookCommands(configuration) {
  return Object.values(configuration.hooks ?? {})
    .flat()
    .flatMap((entry) => entry.hooks ?? [])
    .map((hook) => hook.command ?? '');
}

test('pins the downstream engineering harness to the complete published Rig 0.6.2 contract', () => {
  const manifest = readJson('.claude/.rig-manifest.json');
  const problems = [];

  if (manifest.version !== '0.6.2') {
    problems.push(`expected the managed Rig version to be 0.6.2, got ${manifest.version}`);
  }

  for (const path of newRigArtifacts) {
    if (!existsSync(resolve(projectRoot, path))) {
      problems.push(`${path} is missing`);
      continue;
    }

    if (typeof manifest.files?.[path] !== 'string') {
      problems.push(`${path} is not tracked by the Rig manifest`);
      continue;
    }

    if (manifest.files[path] !== sha256(path)) {
      problems.push(`${path} differs from its Rig manifest digest`);
    }
  }

  const claudeCommands = hookCommands(readJson('.claude/settings.json'));
  const codexCommands = hookCommands(readJson('.codex/hooks.json'));
  if (!claudeCommands.some((command) => command.includes('/guard-rulebook.mjs'))) {
    problems.push('Claude hook wiring does not enforce guard-rulebook.mjs');
  }
  if (!codexCommands.some((command) => command.includes('/guard-rulebook.mjs'))) {
    problems.push('Codex hook wiring does not enforce guard-rulebook.mjs');
  }

  assert.deepEqual(problems, []);
});

test('ignores the checkout-local Rig board selector', () => {
  const result = spawnSync(
    'git',
    ['check-ignore', '--quiet', '--', '.claude/queue.board'],
    { cwd: projectRoot },
  );

  assert.equal(
    result.status,
    0,
    '.claude/queue.board must be ignored as checkout-local Rig state',
  );
});
