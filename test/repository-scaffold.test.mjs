import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  cpSync,
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const requiredDirectories = [
  'apps/cli',
  'packages/domain',
  'packages/graph',
  'packages/roles',
  'packages/tools/live',
  'packages/tools/replay',
  'packages/persistence',
  'packages/evals',
  'packages/observability',
  'datasets/scenarios',
  'incident-lab',
];

const workspaceDirectories = [
  'apps/cli',
  'packages/domain',
  'packages/graph',
  'packages/roles',
  'packages/tools',
  'packages/persistence',
  'packages/evals',
  'packages/observability',
];

function readRequired(path, message) {
  assert.equal(existsSync(path), true, message);
  return readFileSync(path, 'utf8');
}

function readJson(path, message) {
  return JSON.parse(readRequired(path, message));
}

function rootManifest() {
  return readJson(
    resolve(projectRoot, 'package.json'),
    'the TypeScript workspace needs a root package.json',
  );
}

function workspacePatternMatches(pattern, directory) {
  const expression = pattern
    .split('/')
    .map((segment) =>
      segment === '*' ? '[^/]+' : segment.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'),
    )
    .join('/');
  return new RegExp(`^${expression}$`).test(directory);
}

function runNpm(args, cwd = projectRoot) {
  return spawnSync('npm', args, {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, CI: '1' },
  });
}

function commandDiagnostics(command, result) {
  return `${command} exited ${result.status}\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`;
}

function copyForBoundaryProbe() {
  const temporaryRoot = mkdtempSync(join(tmpdir(), 'aic-layered-boundary-'));
  const fixtureRoot = join(temporaryRoot, 'repository');
  const excludedEntries = new Set([
    '.agents',
    '.claude',
    '.codex',
    '.git',
    '.github',
    'coverage',
    'node_modules',
  ]);

  cpSync(projectRoot, fixtureRoot, {
    recursive: true,
    filter(source) {
      const pathFromRoot = relative(projectRoot, source);
      return pathFromRoot === '' || !excludedEntries.has(pathFromRoot.split('/')[0]);
    },
  });

  const sourceNodeModules = resolve(projectRoot, 'node_modules');
  if (existsSync(sourceNodeModules)) {
    symlinkSync(sourceNodeModules, resolve(fixtureRoot, 'node_modules'), 'dir');
  }

  return { fixtureRoot, temporaryRoot };
}

function writeDomainSource(fixtureRoot, source) {
  const path = resolve(fixtureRoot, 'packages/domain/src/__boundary_probe__.ts');
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, source);
}

function mutateJson(path, mutate) {
  const value = JSON.parse(readFileSync(path, 'utf8'));
  mutate(value);
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

function runBoundaryProbe(mutate) {
  rootManifest();
  const { fixtureRoot, temporaryRoot } = copyForBoundaryProbe();

  try {
    const baseline = runNpm(['run', '--silent', 'lint'], fixtureRoot);
    assert.equal(
      baseline.status,
      0,
      `the unmodified scaffold must pass npm run lint before a boundary probe is meaningful\n${commandDiagnostics('npm run lint', baseline)}`,
    );

    mutate(fixtureRoot);
    return runNpm(['run', '--silent', 'lint'], fixtureRoot);
  } finally {
    rmSync(temporaryRoot, { recursive: true, force: true });
  }
}

const boundaryProbes = [
  {
    name: 'rejects a static domain import from a forbidden package',
    mutate: (fixtureRoot) => writeDomainSource(fixtureRoot, 'import "@langchain/core";\n'),
  },
  {
    name: 'rejects a literal dynamic domain import from graph',
    mutate: (fixtureRoot) =>
      writeDomainSource(
        fixtureRoot,
        'export const loadGraph = () => import("@aic/graph");\n',
      ),
  },
  {
    name: 'rejects require in domain code',
    mutate: (fixtureRoot) =>
      writeDomainSource(fixtureRoot, 'export const graph = require("@aic/graph");\n'),
  },
  {
    name: 'rejects a domain dependency value that points into graph',
    mutate: (fixtureRoot) =>
      mutateJson(resolve(fixtureRoot, 'packages/domain/package.json'), (manifest) => {
        manifest.dependencies = { ...manifest.dependencies, 'graph-alias': 'file:../graph' };
      }),
  },
  {
    name: 'rejects a domain imports-map entry that points to tools',
    mutate: (fixtureRoot) =>
      mutateJson(resolve(fixtureRoot, 'packages/domain/package.json'), (manifest) => {
        manifest.imports = { ...manifest.imports, '#tools': '@aic/tools' };
      }),
  },
  {
    name: 'rejects a domain TypeScript project reference to graph',
    mutate: (fixtureRoot) =>
      mutateJson(resolve(fixtureRoot, 'packages/domain/tsconfig.json'), (configuration) => {
        configuration.references = [...(configuration.references ?? []), { path: '../graph' }];
      }),
  },
  {
    name: 'rejects a node:module import in domain code',
    mutate: (fixtureRoot) =>
      writeDomainSource(fixtureRoot, 'import { createRequire } from "node:module";\n'),
  },
  {
    name: 'rejects a computed dynamic import in domain code',
    mutate: (fixtureRoot) =>
      writeDomainSource(
        fixtureRoot,
        'export const loadModule = (specifier: string) => import(specifier);\n',
      ),
  },
];

test('scaffolds every v0.1 repository area without an agents product package', () => {
  for (const path of requiredDirectories) {
    assert.equal(existsSync(resolve(projectRoot, path)), true, `${path} must exist`);
  }
  assert.equal(
    existsSync(resolve(projectRoot, 'packages/agents')),
    false,
    'semantic roles belong in packages/roles; packages/agents must not exist',
  );
});

test('publishes one clean-install, lint, build, test, and CLI command contract', () => {
  const manifest = rootManifest();
  const readme = readRequired(resolve(projectRoot, 'README.md'), 'the root README must exist');

  assert.equal(manifest.private, true, 'the workspace root must not be publishable');
  assert.equal(
    existsSync(resolve(projectRoot, 'package-lock.json')),
    true,
    'npm ci needs a committed package-lock.json',
  );
  assert.equal(Array.isArray(manifest.workspaces), true, 'package.json must declare workspaces');
  for (const directory of workspaceDirectories) {
    assert.equal(
      manifest.workspaces.some((pattern) => workspacePatternMatches(pattern, directory)),
      true,
      `the root workspace patterns must include ${directory}`,
    );
  }

  for (const script of ['lint', 'build', 'test', 'cli']) {
    assert.equal(typeof manifest.scripts?.[script], 'string', `package.json must expose ${script}`);
    assert.notEqual(manifest.scripts[script].trim(), '', `${script} must execute a command`);
  }

  for (const command of ['npm ci', 'npm run lint', 'npm run build', 'npm test', 'npm run cli']) {
    assert.match(
      readme,
      new RegExp(`(?:^|\\n)\\s*${command.replaceAll(' ', '\\s+')}(?:\\s|$)`, 'm'),
      `README.md must document ${command}`,
    );
  }
});

test('runs lint, build, and tests in CI after a clean npm install', () => {
  const workflow = readRequired(
    resolve(projectRoot, '.github/workflows/ci.yml'),
    'the repository CI workflow must exist',
  );
  const commands = ['run: npm ci', 'run: npm run lint', 'run: npm run build', 'run: node --test'];
  const commandPositions = commands.map((command) => workflow.indexOf(command));

  assert.equal(
    commandPositions.every((position) => position >= 0),
    true,
    `CI must run ${commands.join(', ')}`,
  );
  assert.deepEqual(
    [...commandPositions].sort((left, right) => left - right),
    commandPositions,
    'CI must install before linting, building, and testing',
  );
});

test('uses mature boundary mechanisms without the retired bespoke parser', () => {
  const manifest = rootManifest();
  const dependencies = { ...manifest.dependencies, ...manifest.devDependencies };

  assert.equal(typeof dependencies.eslint, 'string', 'ESLint must enforce domain source rules');
  assert.equal(
    typeof dependencies['dependency-cruiser'] === 'string' ||
      typeof dependencies['eslint-plugin-boundaries'] === 'string',
    true,
    'a mature module-graph rule must enforce domain dependency direction',
  );
  assert.equal(
    Object.keys(dependencies).some((name) => name.includes('typescript-eslint')),
    true,
    'TypeScript-aware ESLint rules must enforce dynamic loading restrictions',
  );
  assert.equal(dependencies['@babel/parser'], undefined, '@babel/parser must not return');
  assert.equal(
    existsSync(resolve(projectRoot, 'scripts/check-boundaries.mjs')),
    false,
    'the retired bespoke boundary checker must not return',
  );
  assert.doesNotMatch(manifest.scripts.lint, /check-boundaries\.mjs/);
});

test('builds the TypeScript workspace through its public root command', () => {
  rootManifest();
  const result = runNpm(['run', '--silent', 'build']);

  assert.equal(result.status, 0, commandDiagnostics('npm run build', result));
});

test('boots the minimal CLI through its public root command', () => {
  rootManifest();
  const result = runNpm(['run', '--silent', 'cli', '--', '--help']);

  assert.equal(result.status, 0, commandDiagnostics('npm run cli -- --help', result));
});

for (const probe of boundaryProbes) {
  test(`lint ${probe.name}`, () => {
    const result = runBoundaryProbe(probe.mutate);

    assert.notEqual(
      result.status,
      0,
      `npm run lint accepted the closed-list probe: ${probe.name}\n${commandDiagnostics('npm run lint', result)}`,
    );
  });
}
