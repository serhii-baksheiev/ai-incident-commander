import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const addedComponents = [
  '.claude/hooks/guard-rulebook.mjs',
  '.claude/scripts/unattended-flag.mjs',
  '.claude/scripts/doctor.mjs',
];

function readJson(relativePath) {
  return JSON.parse(readFileSync(resolve(projectRoot, relativePath), 'utf8'));
}

function sha256(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

test('records the installed create-agent-rig 0.6.0 release', () => {
  const manifest = readJson('.claude/.rig-manifest.json');

  assert.equal(manifest.version, '0.6.0');
});

test('tracks every newly installed 0.6.0 component with matching manifest integrity', () => {
  const manifest = readJson('.claude/.rig-manifest.json');

  for (const relativePath of addedComponents) {
    const installedPath = resolve(projectRoot, relativePath);
    assert.equal(existsSync(installedPath), true, `${relativePath} must be installed`);
    assert.equal(
      manifest.files[relativePath],
      sha256(installedPath),
      `${relativePath} must match the hash recorded by the rig`,
    );
  }
});

test('wires guard-rulebook through every edit surface in both harnesses', () => {
  for (const configPath of ['.claude/settings.json', '.codex/hooks.json']) {
    const config = readJson(configPath);
    const editGroup = config.hooks.PreToolUse.find((group) =>
      group.matcher.split('|').includes('apply_patch'),
    );

    assert.notEqual(editGroup, undefined, `${configPath} must define pre-edit hooks`);
    assert.deepEqual(editGroup.matcher.split('|'), [
      'Write',
      'Edit',
      'MultiEdit',
      'NotebookEdit',
      'apply_patch',
    ]);
    assert.equal(
      editGroup.hooks.some((hook) => hook.command.includes('/.claude/hooks/guard-rulebook.mjs"')),
      true,
      `${configPath} must invoke guard-rulebook.mjs`,
    );
  }
});

test('keeps the local queue board selector out of version control', () => {
  const ignoreEntries = readFileSync(resolve(projectRoot, '.gitignore'), 'utf8').split(/\r?\n/);

  assert.equal(ignoreEntries.includes('.claude/queue.board'), true);
});
