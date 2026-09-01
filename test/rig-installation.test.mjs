import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

function readRequired(path, message) {
  assert.equal(existsSync(path), true, message);
  return readFileSync(path, 'utf8');
}

function readJson(path, message) {
  return JSON.parse(readRequired(path, message));
}

test('records the create-agent-rig 0.7.0 installation without losing project identity', () => {
  const manifest = readJson(
    resolve(projectRoot, '.claude/.rig-manifest.json'),
    'the installed Rig needs a versioned manifest',
  );

  assert.equal(manifest.version, '0.7.0');
  assert.equal(manifest.kind, 'init');
  assert.deepEqual(manifest.project, {
    name: 'ai-incident-commander',
    scope: 'ai-incident-commander',
    region: '',
  });
});

test('installs the versioned content-blind revalidation contract and its runtime boundary', () => {
  const contract = readJson(
    resolve(projectRoot, '.rig/revalidation.json'),
    'Rig 0.7.0 must install the project-owned content-blind revalidation contract',
  );

  assert.deepEqual(contract, {
    schemaVersion: 1,
    detection: {
      mode: 'pull',
      sources: ['run-state', 'journal'],
      acceptedLatency: '24h',
      push: false,
    },
    pairedFacts: [],
  });

  for (const path of [
    '.claude/scripts/lib/claim-records.mjs',
    '.claude/scripts/lib/revalidation-evidence.mjs',
    'docs/decisions/content-blind-revalidation.md',
  ]) {
    assert.equal(existsSync(resolve(projectRoot, path)), true, `${path} must be installed`);
  }

  const preflight = readRequired(
    resolve(projectRoot, '.claude/scripts/preflight.mjs'),
    'preflight must exist',
  );
  const revalidate = readRequired(
    resolve(projectRoot, '.claude/scripts/revalidate.mjs'),
    'revalidation must exist',
  );
  assert.match(preflight, /from ['"]\.\/lib\/claim-records\.mjs['"]/);
  assert.match(revalidate, /from ['"]\.\/lib\/claim-records\.mjs['"]/);
});

test('runs both Never-tier shell guards from one Bash and PowerShell tool list', async () => {
  const shellToolsPath = resolve(projectRoot, '.claude/scripts/lib/shell-tools.mjs');
  assert.equal(
    existsSync(shellToolsPath),
    true,
    'Rig 0.7.0 must install the shared shell-tool list',
  );

  const { SHELL_TOOLS, SHELL_TOOL_MATCHER } = await import(pathToFileURL(shellToolsPath).href);
  assert.deepEqual([...SHELL_TOOLS], ['Bash', 'PowerShell']);
  assert.equal(SHELL_TOOL_MATCHER, 'Bash|PowerShell');

  const settings = readJson(
    resolve(projectRoot, '.claude/settings.json'),
    'Claude hook settings must exist',
  );
  const shellEntry = settings.hooks?.PreToolUse?.find((entry) =>
    entry.hooks?.some(
      (hook) =>
        hook.command?.includes('/block-no-verify.mjs') ||
        hook.command?.includes('/guard-bash.mjs'),
    ),
  );
  assert.equal(shellEntry?.matcher, SHELL_TOOL_MATCHER);

  for (const path of [
    '.claude/hooks/block-no-verify.mjs',
    '.claude/hooks/guard-bash.mjs',
  ]) {
    const source = readRequired(resolve(projectRoot, path), `${path} must exist`);
    assert.match(source, /import \{ SHELL_TOOLS \} from ['"]\.\.\/scripts\/lib\/shell-tools\.mjs['"]/);
    assert.match(source, /SHELL_TOOLS\.includes\(input\.tool_name\)/);
  }
});
