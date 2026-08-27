import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

function installedPath(relativePath) {
  return resolve(projectRoot, relativePath);
}

function readInstalled(relativePath) {
  const path = installedPath(relativePath);
  assert.equal(existsSync(path), true, `${relativePath} must be installed`);
  return readFileSync(path, 'utf8');
}

function readJson(relativePath) {
  return JSON.parse(readInstalled(relativePath));
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

async function importInstalled(relativePath) {
  const path = installedPath(relativePath);
  assert.equal(existsSync(path), true, `${relativePath} must be installed`);
  return import(`${pathToFileURL(path).href}?downstream=${Date.now()}-${Math.random()}`);
}

function runNode(scriptPath, args, options = {}) {
  return spawnSync(process.execPath, [scriptPath, ...args], {
    encoding: 'utf8',
    ...options,
  });
}

test('installs the published 0.6.1 snapshot with manifest integrity', () => {
  const manifest = readJson('.claude/.rig-manifest.json');
  const criticalArtifacts = [
    '.claude/hooks/guard-rulebook.mjs',
    '.claude/scripts/unattended-flag.mjs',
    '.claude/scripts/queue/index.mjs',
    '.claude/rules/invariants.md',
    '.claude/agents/prose-reviewer.md',
    '.codex/hooks.json',
    'AGENTS.md',
    'CLAUDE.md',
  ];

  assert.equal(manifest.version, '0.6.1');
  for (const relativePath of criticalArtifacts) {
    assert.equal(
      manifest.files[relativePath],
      sha256(readInstalled(relativePath)),
      `${relativePath} must match the installed 0.6.1 manifest`,
    );
  }
});

test('preserves the project-owned contracts in both harness rulebooks', () => {
  const contracts = [
    /^# ai-incident-commander$/m,
    /Top rule — commit\/PR attribution: NEVER include co-authored or AI-attribution information/,
    /brought the \*\*process\*\* layer[\s\S]*brought \*\*no\s+architecture rules\*\*/,
    /touch\s+~\/\.claude\/ai-incident-commander-loop-STOP/,
    /```elevated-paths[\s\S]*\.claude\/[\s\S]*\.agents\/[\s\S]*\.codex\/[\s\S]*AGENTS\.md[\s\S]*\.github\/workflows\//,
  ];
  const agents = readInstalled('AGENTS.md');
  const claude = readInstalled('CLAUDE.md');

  assert.equal(agents, claude, 'Claude and Codex must receive the same project contracts');
  for (const contract of contracts) {
    assert.match(agents, contract);
  }
});

test('guard-rulebook blocks AGENTS.md and Codex hook edits through canonical and symlink paths', async () => {
  const hookPath = installedPath('.claude/hooks/guard-rulebook.mjs');
  const { unattendedFlags } = await importInstalled('.claude/scripts/unattended-flag.mjs');
  assert.equal(existsSync(hookPath), true, 'guard-rulebook must be installed');

  const sandbox = mkdtempSync(join(tmpdir(), 'aic-rig-guard-'));
  const home = join(sandbox, 'home');
  const aliasRoot = join(sandbox, 'checkout-alias');
  mkdirSync(home, { recursive: true });
  symlinkSync(projectRoot, aliasRoot, 'dir');

  try {
    const canonicalEnv = { ...process.env, HOME: home, CLAUDE_PROJECT_DIR: projectRoot };
    const [flagPath] = unattendedFlags(canonicalEnv);
    assert.equal(flagPath.startsWith(home), true, 'the fixture flag must stay in its temp home');
    mkdirSync(dirname(flagPath), { recursive: true });
    writeFileSync(flagPath, JSON.stringify({ item: 'AIC-RIG', runDir: sandbox, allow: [] }));

    const cases = [
      { root: projectRoot, path: join(projectRoot, 'AGENTS.md') },
      { root: projectRoot, path: join(projectRoot, '.codex/hooks.json') },
      { root: aliasRoot, path: join(projectRoot, 'AGENTS.md') },
      { root: projectRoot, path: join(aliasRoot, '.codex/hooks.json') },
    ];
    for (const fixture of cases) {
      const result = runNode(hookPath, [], {
        cwd: fixture.root,
        env: { ...process.env, HOME: home, CLAUDE_PROJECT_DIR: fixture.root },
        input: JSON.stringify({
          hook_event_name: 'PreToolUse',
          tool_name: 'Write',
          tool_input: { file_path: fixture.path, content: 'replacement' },
        }),
      });

      assert.equal(result.status, 2, `${fixture.root} -> ${fixture.path}\n${result.stderr}`);
      assert.match(result.stderr, /rulebook|unattended/i);
    }
  } finally {
    rmSync(sandbox, { recursive: true, force: true });
  }
});

test('unattended authorization is checkout-scoped and legacy global state fails closed', async () => {
  const { FLAG_BASENAME, readUnattended, unattendedFlags } = await importInstalled(
    '.claude/scripts/unattended-flag.mjs',
  );
  const sandbox = mkdtempSync(join(tmpdir(), 'aic-rig-unattended-'));
  const home = join(sandbox, 'home');
  const checkoutA = join(sandbox, 'checkout-a');
  const checkoutB = join(sandbox, 'checkout-b');
  mkdirSync(checkoutA, { recursive: true });
  mkdirSync(checkoutB, { recursive: true });

  try {
    const envA = { ...process.env, HOME: home, CLAUDE_PROJECT_DIR: checkoutA };
    const envB = { ...process.env, HOME: home, CLAUDE_PROJECT_DIR: checkoutB };
    const flagA = unattendedFlags(envA)[0];
    const flagB = unattendedFlags(envB)[0];
    assert.notEqual(flagA, flagB, 'concurrent worktrees need distinct authorization paths');
    assert.equal(flagA.startsWith(home) && flagB.startsWith(home), true);

    for (const [path, item] of [
      [flagA, 'AIC-A'],
      [flagB, 'AIC-B'],
    ]) {
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, JSON.stringify({ item, runDir: sandbox, allow: [] }));
    }

    assert.match(readUnattended(envA).item, /^AIC-A$/);
    assert.match(readUnattended(envB).item, /^AIC-B$/);
    rmSync(flagA);
    assert.deepEqual(readUnattended(envA), { on: false });
    assert.equal(readUnattended(envB).item, 'AIC-B');
    rmSync(flagB);

    const legacyPath = join(home, '.claude', FLAG_BASENAME);
    writeFileSync(
      legacyPath,
      JSON.stringify({ item: 'LEGACY', runDir: sandbox, allow: ['.claude/skills/'] }),
    );
    const legacy = readUnattended(envA);
    assert.equal(legacy.on, true);
    assert.equal(legacy.unreadable, true);
    assert.match(legacy.why, /legacy|migrat/i);
    assert.equal(legacy.allow, undefined, 'legacy state must never authorize a scoped checkout');
  } finally {
    rmSync(sandbox, { recursive: true, force: true });
  }
});

test('queue board names reject terminal controls before output or writes while spaces remain valid', async () => {
  const queueScript = installedPath('.claude/scripts/queue/index.mjs');
  const { boardPathFor, loadConfig } = await importInstalled('.claude/scripts/queue/index.mjs');
  const sandbox = mkdtempSync(join(tmpdir(), 'aic-rig-board-'));
  const home = join(sandbox, 'home');
  mkdirSync(home, { recursive: true });

  try {
    for (const [index, control] of ['\u001b', '\u009b', '\u007f'].entries()) {
      const name = `owned${control}[31m`;
      const configPath = join(sandbox, `unsafe-${index}.json`);
      writeFileSync(
        configPath,
        JSON.stringify({ adapter: 'jira', board: name, boards: { [name]: { project: 'AIC' } } }),
      );

      assert.throws(() => loadConfig(configPath), /board|control|invalid/i);
      const result = runNode(queueScript, ['board', '--config', configPath], {
        cwd: sandbox,
        env: { ...process.env, HOME: home, CLAUDE_PROJECT_DIR: sandbox },
      });
      assert.notEqual(result.status, 0);
      assert.doesNotMatch(`${result.stdout}${result.stderr}`, new RegExp(control));
      assert.equal(existsSync(boardPathFor(configPath)), false, 'unsafe input must write no selector');
    }

    const configPath = join(sandbox, 'ordinary.json');
    writeFileSync(
      configPath,
      JSON.stringify({
        adapter: 'jira',
        board: 'Incident Response',
        boards: {
          'Incident Response': { project: 'IR' },
          'Security Team': { project: 'SEC' },
        },
      }),
    );
    assert.deepEqual(loadConfig(configPath).options, { project: 'IR' });
    const switched = runNode(queueScript, ['board', 'Security Team', '--config', configPath], {
      cwd: sandbox,
      env: { ...process.env, HOME: home, CLAUDE_PROJECT_DIR: sandbox },
    });
    assert.equal(switched.status, 0, `${switched.stdout}${switched.stderr}`);
    assert.equal(readFileSync(boardPathFor(configPath), 'utf8').trim(), 'Security Team');
  } finally {
    rmSync(sandbox, { recursive: true, force: true });
  }
});

test('upstream-only test pointers require an unmodified manifest snapshot and local pointers stay live', () => {
  const manifest = readJson('.claude/.rig-manifest.json');
  const inheritedPath = '.claude/hooks/guard-rulebook.mjs';
  const inherited = readInstalled(inheritedPath);
  const invariants = readInstalled('.claude/rules/invariants.md');
  const reviewer = readInstalled('.claude/agents/prose-reviewer.md');

  assert.match(inherited, /test\/template\/guard-rulebook\.test\.ts/);
  assert.match(inherited, /absent in a generated rig/i);
  assert.equal(manifest.files[inheritedPath], sha256(inherited));
  assert.notEqual(
    manifest.files[inheritedPath],
    sha256(`${inherited}\n// downstream drift\n`),
    'local drift must stop matching the inherited snapshot immediately',
  );

  for (const contract of [invariants, reviewer]) {
    assert.match(contract, /\.claude\/\.rig-manifest\.json/);
    assert.match(contract, /only while.*(?:manifest|hash).*(?:match|same)/is);
    assert.match(
      contract,
      /(?:hash mismatch|hash.*(?:differs|does not match)|missing manifest)[\s\S]*(?:local test|test is yours|exception (?:expires|ends))/i,
    );
  }

  const localPointer = invariants.match(
    /see guard-invariant\.example\.test\.mjs › "([^"]+)"/,
  );
  assert.notEqual(localPointer, null, 'the local backed-claim example must keep its test pointer');
  const localTest = readInstalled(
    '.claude/skills/new-invariant/guard-invariant.example.test.mjs',
  ).replace(/\s+/g, ' ');
  assert.equal(
    localTest.includes(localPointer[1].replace(/\s+/g, ' ')),
    true,
    'a downstream-local pointer must resolve to the named local test',
  );
});
