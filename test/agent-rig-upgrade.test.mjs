import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
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

function relativeArtifacts(rootPath, relativePath = '') {
  return readdirSync(resolve(rootPath, relativePath), { withFileTypes: true })
    .flatMap((entry) => {
      const artifactPath = relativePath ? `${relativePath}/${entry.name}` : entry.name;
      return entry.isDirectory() ? relativeArtifacts(rootPath, artifactPath) : [artifactPath];
    })
    .sort();
}

function decodePowerShellCommand(command) {
  const encodedCommand = command.match(/(?:^|\s)-EncodedCommand\s+(\S+)/)?.[1];

  assert.notEqual(encodedCommand, undefined, 'Windows hook must use PowerShell -EncodedCommand');
  assert.match(encodedCommand, /^[A-Za-z0-9+/]+={0,2}$/);
  return Buffer.from(encodedCommand, 'base64').toString('utf16le');
}

test('records the installed create-agent-rig version 0.6.0', () => {
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

test('invokes guard-rulebook from the encoded Codex Windows hook', () => {
  const config = readJson('.codex/hooks.json');
  const editGroup = config.hooks.PreToolUse.find((group) =>
    group.matcher.split('|').includes('apply_patch'),
  );
  const guardRulebookHook = editGroup?.hooks.find((hook) =>
    hook.command.includes('/.claude/hooks/guard-rulebook.mjs"'),
  );

  assert.notEqual(guardRulebookHook, undefined, 'Codex must define the guard-rulebook edit hook');
  assert.equal(typeof guardRulebookHook.commandWindows, 'string');
  const windowsScript = decodePowerShellCommand(guardRulebookHook.commandWindows);
  assert.match(windowsScript, /\.claude\/hooks\/guard-rulebook\.mjs/);
  assert.match(windowsScript, /&\s+node\s+\$hookPath\b/);
});

test('keeps the generated rulebook entrypoints byte-identical', () => {
  assert.equal(sha256(resolve(projectRoot, 'AGENTS.md')), sha256(resolve(projectRoot, 'CLAUDE.md')));
});

test('describes remaining project setup accurately in both harness rulebooks', () => {
  const requiredProse = [
    {
      label: 'must name the section and state that exactly two project-specific items remain',
      pattern:
        /^## Remaining setup and installed safeguards\n\nExactly two project-specific setup items remain\.$/m,
    },
    {
      label: 'must say all five runtime paths are already ignored',
      pattern:
        /All five runtime paths below are already present in `\.gitignore` and therefore ignored\./,
    },
    {
      label: 'must say the rig manifest is tracked',
      pattern: /`\.claude\/\.rig-manifest\.json` is tracked\./,
    },
    {
      label: 'must limit the optional doctor exemption to a locally owned deliberate exemption',
      pattern:
        /`\.claude\/doctor-exemptions\.json` is optional and is needed only for a deliberate exemption to a locally owned hook\./,
    },
  ];
  const forbiddenProse = [
    {
      label: 'must not instruct the project to add the runtime ignore entries',
      pattern: /(?:runtime paths need a `\.gitignore` line each|Add all five)/i,
    },
    {
      label: 'must not claim doctor reads two unshipped files',
      pattern: /`?doctor`? reads two files this install does not ship/i,
    },
  ];
  const problems = [];

  for (const rulebookPath of ['AGENTS.md', 'CLAUDE.md']) {
    const rulebook = readFileSync(resolve(projectRoot, rulebookPath), 'utf8');
    for (const { label, pattern } of requiredProse) {
      if (!pattern.test(rulebook)) problems.push(`${rulebookPath} ${label}`);
    }
    for (const { label, pattern } of forbiddenProse) {
      if (pattern.test(rulebook)) problems.push(`${rulebookPath} ${label}`);
    }
  }

  assert.deepEqual(problems, []);
});

test('keeps every Codex skill artifact byte-identical to its Claude mirror', () => {
  const codexRoot = resolve(projectRoot, '.agents/skills');
  const claudeRoot = resolve(projectRoot, '.claude/skills');
  const codexArtifacts = relativeArtifacts(codexRoot);
  const claudeArtifacts = relativeArtifacts(claudeRoot);

  assert.deepEqual(codexArtifacts, claudeArtifacts, 'both harnesses must expose the same skills');
  for (const artifactPath of codexArtifacts) {
    assert.equal(
      sha256(resolve(codexRoot, artifactPath)),
      sha256(resolve(claudeRoot, artifactPath)),
      `${artifactPath} must be identical in both harnesses`,
    );
  }
});

test('keeps the local queue board selector out of version control', () => {
  const ignoreEntries = readFileSync(resolve(projectRoot, '.gitignore'), 'utf8').split(/\r?\n/);

  assert.equal(ignoreEntries.includes('.claude/queue.board'), true);
});
