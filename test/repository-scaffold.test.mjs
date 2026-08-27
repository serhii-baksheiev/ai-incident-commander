import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  cpSync,
  existsSync,
  lstatSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

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

function workspacePatternMatches(pattern, directory) {
  const expression = pattern
    .split('/')
    .map((segment) => (segment === '*' ? '[^/]+' : segment.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
    .join('/');
  return new RegExp(`^${expression}$`).test(directory);
}

function readRequired(path, message) {
  assert.equal(existsSync(path), true, message);
  return readFileSync(path, 'utf8');
}

function readManifest() {
  const manifestPath = resolve(projectRoot, 'package.json');
  return JSON.parse(readRequired(manifestPath, 'the TypeScript monorepo needs a root package.json'));
}

function commandDiagnostics(command, result) {
  return `${command} exited ${result.status}\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`;
}

function runNpm(args, cwd = projectRoot) {
  return spawnSync('npm', args, {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, CI: '1' },
  });
}

function walkSourceFiles(root) {
  if (!existsSync(root)) return [];

  const files = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) files.push(...walkSourceFiles(path));
    if (entry.isFile() && /\.[cm]?[jt]sx?$/.test(entry.name)) files.push(path);
  }
  return files;
}

function copyForBoundaryProbe() {
  const temporaryRoot = mkdtempSync(join(tmpdir(), 'aic-boundary-probe-'));
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
      if (pathFromRoot === '') return true;
      return !excludedEntries.has(pathFromRoot.split('/')[0]);
    },
  });

  const sourceNodeModules = resolve(projectRoot, 'node_modules');
  if (existsSync(sourceNodeModules) && lstatSync(sourceNodeModules).isDirectory()) {
    symlinkSync(sourceNodeModules, resolve(fixtureRoot, 'node_modules'), 'dir');
  }

  return { fixtureRoot, temporaryRoot };
}

function probeForbiddenDomainImport(specifier) {
  const { fixtureRoot, temporaryRoot } = copyForBoundaryProbe();
  try {
    const baseline = runNpm(['run', '--silent', 'lint'], fixtureRoot);
    assert.equal(
      baseline.status,
      0,
      `the clean scaffold must pass its boundary-enforcing lint command\n${commandDiagnostics('npm run lint', baseline)}`,
    );

    const probePath = resolve(fixtureRoot, 'packages/domain/__boundary_probe__.ts');
    mkdirSync(dirname(probePath), { recursive: true });
    writeFileSync(probePath, `import ${JSON.stringify(specifier)};\n`);

    return runNpm(['run', '--silent', 'lint'], fixtureRoot);
  } finally {
    rmSync(temporaryRoot, { recursive: true, force: true });
  }
}

function probeDomainSource(source) {
  const { fixtureRoot, temporaryRoot } = copyForBoundaryProbe();
  try {
    writeFileSync(resolve(fixtureRoot, 'packages/domain/__boundary_probe__.ts'), source);
    return runNpm(['run', '--silent', 'lint'], fixtureRoot);
  } finally {
    rmSync(temporaryRoot, { recursive: true, force: true });
  }
}

function probeDomainJson(pathFromDomain, mutate) {
  const { fixtureRoot, temporaryRoot } = copyForBoundaryProbe();
  try {
    const path = resolve(fixtureRoot, 'packages/domain', pathFromDomain);
    const value = JSON.parse(readFileSync(path, 'utf8'));
    mutate(value);
    writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
    return runNpm(['run', '--silent', 'lint'], fixtureRoot);
  } finally {
    rmSync(temporaryRoot, { recursive: true, force: true });
  }
}

function probeBoundaryMutation(mutate) {
  const { fixtureRoot, temporaryRoot } = copyForBoundaryProbe();
  try {
    mutate(fixtureRoot);
    return runNpm(['run', '--silent', 'lint'], fixtureRoot);
  } finally {
    rmSync(temporaryRoot, { recursive: true, force: true });
  }
}

function assertForbiddenDomainImport(specifier) {
  readManifest();
  const result = probeForbiddenDomainImport(specifier);

  assert.notEqual(
    result.status,
    0,
    `npm run lint accepted a forbidden domain import from ${specifier}\n${commandDiagnostics('npm run lint', result)}`,
  );
}

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

test('publishes one clean-install build, lint, test, and CLI command contract', () => {
  const manifest = readManifest();
  const readme = readRequired(resolve(projectRoot, 'README.md'), 'the root README must exist');

  assert.equal(manifest.private, true, 'the monorepo root must not be publishable');
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

  for (const script of ['build', 'lint', 'test', 'cli']) {
    assert.equal(
      typeof manifest.scripts?.[script],
      'string',
      `package.json must expose npm run ${script}`,
    );
    assert.notEqual(manifest.scripts[script].trim(), '', `npm run ${script} must execute a command`);
  }
  assert.match(manifest.scripts.test, /(?:^|\s)node\s+--test(?:\s|$)/);

  for (const command of ['npm ci', 'npm run build', 'npm run lint', 'npm test', 'npm run cli']) {
    assert.match(readme, new RegExp(`(?:^|\\n)\\s*${command.replaceAll(' ', '\\s+')}(?:\\s|$)`, 'm'));
  }
});

test('runs CI lint, build, and tests from a clean npm install', () => {
  const workflow = readRequired(
    resolve(projectRoot, '.github/workflows/ci.yml'),
    'the repository CI workflow must exist',
  );
  const cleanInstall = workflow.indexOf('run: npm ci');
  const lint = workflow.indexOf('run: npm run lint');
  const build = workflow.indexOf('run: npm run build');
  const tests = workflow.indexOf('run: node --test');

  assert.notEqual(cleanInstall, -1, 'CI must install exactly from package-lock.json with npm ci');
  assert.equal(
    cleanInstall < lint && lint < build && build < tests,
    true,
    'CI must run npm ci before lint, build, and tests',
  );
});

test('builds the TypeScript workspace through its public root command', () => {
  readManifest();
  const result = runNpm(['run', '--silent', 'build']);

  assert.equal(result.status, 0, commandDiagnostics('npm run build', result));
});

test('boots the minimal CLI through its public root command', () => {
  readManifest();
  const result = runNpm(['run', '--silent', 'cli', '--', '--help']);

  assert.equal(result.status, 0, commandDiagnostics('npm run cli -- --help', result));
});

test('lint rejects a domain import from LangChain', () => {
  assertForbiddenDomainImport('@langchain/core');
});

test('lint rejects a domain import from LangGraph', () => {
  assertForbiddenDomainImport('@langchain/langgraph');
});

test('lint rejects a domain import from graph', () => {
  assertForbiddenDomainImport('../graph/src/index.js');
});

test('lint rejects a domain import from live tools', () => {
  assertForbiddenDomainImport('../tools/live/index.js');
});

test('lint rejects a domain import from replay tools', () => {
  assertForbiddenDomainImport('../tools/replay/index.js');
});

test('lint rejects a domain import from evals', () => {
  assertForbiddenDomainImport('../evals/src/index.js');
});

test('lint rejects a reverse domain manifest dependency on graph', () => {
  const { fixtureRoot, temporaryRoot } = copyForBoundaryProbe();
  try {
    const manifestPath = resolve(fixtureRoot, 'packages/domain/package.json');
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
    manifest.dependencies = { ...manifest.dependencies, '@aic/graph': '0.0.0' };
    writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);

    const result = runNpm(['run', '--silent', 'lint'], fixtureRoot);
    assert.notEqual(
      result.status,
      0,
      `npm run lint accepted @aic/graph in packages/domain/package.json\n${commandDiagnostics('npm run lint', result)}`,
    );
  } finally {
    rmSync(temporaryRoot, { recursive: true, force: true });
  }
});

test('lint allows import.meta.url before an ordinary exported string', () => {
  const result = probeDomainSource(
    'export const moduleUrl = import.meta.url\nexport const example = "@langchain/core";\n',
  );

  assert.equal(result.status, 0, commandDiagnostics('npm run lint', result));
});

test('lint allows internal packages outside the v0.1 dependency directions', () => {
  const result = probeDomainSource(
    [
      'import "@aic/domain";',
      'import "@aic/roles";',
      'import "@aic/persistence";',
      'import "@aic/observability";',
      'import "../roles/src/index.js";',
      'import "../persistence/src/index.js";',
      'import "../observability/src/index.js";',
      '',
    ].join('\n'),
  );

  assert.equal(result.status, 0, commandDiagnostics('npm run lint', result));
});

test('lint rejects a nonliteral dynamic import in domain', () => {
  const result = probeDomainSource(
    'export const loadModule = (specifier: string) => import(specifier);\n',
  );

  assert.notEqual(
    result.status,
    0,
    `npm run lint accepted a nonliteral dynamic import\n${commandDiagnostics('npm run lint', result)}`,
  );
});

test('lint rejects require.resolve module loading in domain', () => {
  const result = probeDomainSource(
    'export const graphPath = require.resolve("@aic/graph");\n',
  );

  assert.notEqual(
    result.status,
    0,
    `npm run lint accepted require.resolve("@aic/graph")\n${commandDiagnostics('npm run lint', result)}`,
  );
});

test('lint rejects a domain source symlink resolving outside domain', () => {
  const { fixtureRoot, temporaryRoot } = copyForBoundaryProbe();
  try {
    symlinkSync(
      '../../roles/src/index.ts',
      resolve(fixtureRoot, 'packages/domain/src/__boundary_probe__.ts'),
    );
    const result = runNpm(['run', '--silent', 'lint'], fixtureRoot);

    assert.notEqual(
      result.status,
      0,
      `npm run lint accepted a domain source symlink resolving outside domain\n${commandDiagnostics('npm run lint', result)}`,
    );
  } finally {
    rmSync(temporaryRoot, { recursive: true, force: true });
  }
});

test('lint rejects a symlinked directory beneath domain', () => {
  const { fixtureRoot, temporaryRoot } = copyForBoundaryProbe();
  try {
    symlinkSync('src', resolve(fixtureRoot, 'packages/domain/__boundary_probe__'), 'dir');
    const result = runNpm(['run', '--silent', 'lint'], fixtureRoot);

    assert.notEqual(
      result.status,
      0,
      `npm run lint accepted a symlinked directory beneath domain\n${commandDiagnostics('npm run lint', result)}`,
    );
  } finally {
    rmSync(temporaryRoot, { recursive: true, force: true });
  }
});

test('lint ignores an ordinary exported string literal in domain code', () => {
  const { fixtureRoot, temporaryRoot } = copyForBoundaryProbe();
  try {
    writeFileSync(
      resolve(fixtureRoot, 'packages/domain/__boundary_probe__.ts'),
      'export const example = "@langchain/core";\n',
    );
    const result = runNpm(['run', '--silent', 'lint'], fixtureRoot);

    assert.equal(result.status, 0, commandDiagnostics('npm run lint', result));
  } finally {
    rmSync(temporaryRoot, { recursive: true, force: true });
  }
});

test('boundary lint allows an exported function with a local from binding', () => {
  const result = probeDomainSource(
    'export function example() { const from = "langchain"; return from; }\n',
  );

  assert.equal(result.status, 0, commandDiagnostics('npm run lint', result));
});

test('boundary lint rejects a file dependency alias to graph', () => {
  const result = probeDomainJson('package.json', (manifest) => {
    manifest.dependencies = { ...manifest.dependencies, 'graph-alias': 'file:../graph' };
  });

  assert.notEqual(
    result.status,
    0,
    `npm run lint accepted graph-alias=file:../graph\n${commandDiagnostics('npm run lint', result)}`,
  );
});

test('boundary lint rejects an npm dependency alias to graph', () => {
  const result = probeDomainJson('package.json', (manifest) => {
    manifest.dependencies = {
      ...manifest.dependencies,
      'graph-alias': 'npm:@aic/graph@0.0.0',
    };
  });

  assert.notEqual(
    result.status,
    0,
    `npm run lint accepted graph-alias=npm:@aic/graph@0.0.0\n${commandDiagnostics('npm run lint', result)}`,
  );
});

test('boundary lint rejects a package imports mapping to graph', () => {
  const result = probeDomainJson('package.json', (manifest) => {
    manifest.imports = { ...manifest.imports, '#graph': '@aic/graph' };
  });

  assert.notEqual(
    result.status,
    0,
    `npm run lint accepted #graph=@aic/graph\n${commandDiagnostics('npm run lint', result)}`,
  );
});

test('boundary lint rejects graph hidden in conditional package imports arrays', () => {
  const result = probeDomainJson('package.json', (manifest) => {
    manifest.imports = {
      ...manifest.imports,
      '#graph': {
        node: ['@aic/domain', '@aic/graph'],
        default: '@aic/domain',
      },
    };
  });

  assert.notEqual(
    result.status,
    0,
    `npm run lint accepted a nested #graph mapping\n${commandDiagnostics('npm run lint', result)}`,
  );
});

test('boundary lint rejects a domain TypeScript project reference to graph', () => {
  const result = probeDomainJson('tsconfig.json', (configuration) => {
    configuration.references = [...(configuration.references ?? []), { path: '../graph' }];
  });

  assert.notEqual(
    result.status,
    0,
    `npm run lint accepted packages/domain/tsconfig.json -> ../graph\n${commandDiagnostics('npm run lint', result)}`,
  );
});

test('boundary lint rejects eval as an interpreted module loader', () => {
  const result = probeDomainSource(
    'export const loadGraph = () => eval(\'import("@aic/graph")\');\n',
  );

  assert.notEqual(
    result.status,
    0,
    `npm run lint accepted eval loading @aic/graph\n${commandDiagnostics('npm run lint', result)}`,
  );
});

test('boundary lint rejects Function as an interpreted module loader', () => {
  const result = probeDomainSource(
    'export const loadGraph = Function(\'return import("@aic/graph")\');\n',
  );

  assert.notEqual(
    result.status,
    0,
    `npm run lint accepted Function loading @aic/graph\n${commandDiagnostics('npm run lint', result)}`,
  );
});

test('boundary lint rejects parenthesized require.resolve', () => {
  const result = probeDomainSource(
    'export const graphPath = (require.resolve)("@aic/graph");\n',
  );

  assert.notEqual(
    result.status,
    0,
    `npm run lint accepted parenthesized require.resolve\n${commandDiagnostics('npm run lint', result)}`,
  );
});

test('boundary lint rejects bracketed require.resolve', () => {
  const result = probeDomainSource(
    'export const graphPath = require["resolve"]("@aic/graph");\n',
  );

  assert.notEqual(
    result.status,
    0,
    `npm run lint accepted bracketed require.resolve\n${commandDiagnostics('npm run lint', result)}`,
  );
});

test('boundary lint rejects optional require.resolve', () => {
  const result = probeDomainSource(
    'export const graphPath = require?.resolve("@aic/graph");\n',
  );

  assert.notEqual(
    result.status,
    0,
    `npm run lint accepted optional require.resolve\n${commandDiagnostics('npm run lint', result)}`,
  );
});

test('round-two boundary lint rejects an aliased eval loader', () => {
  const result = probeDomainSource(
    'const execute = eval; export const loadGraph = () => execute(\'import("@aic/graph")\');\n',
  );

  assert.notEqual(
    result.status,
    0,
    `npm run lint accepted an eval alias\n${commandDiagnostics('npm run lint', result)}`,
  );
});

test('round-two boundary lint rejects globalThis eval', () => {
  const result = probeDomainSource(
    'export const loadGraph = () => globalThis.eval(\'import("@aic/graph")\');\n',
  );

  assert.notEqual(
    result.status,
    0,
    `npm run lint accepted globalThis.eval\n${commandDiagnostics('npm run lint', result)}`,
  );
});

test('round-two boundary lint rejects an aliased Function loader', () => {
  const result = probeDomainSource(
    'const BuildLoader = Function; export const loadGraph = BuildLoader(\'return import("@aic/graph")\');\n',
  );

  assert.notEqual(
    result.status,
    0,
    `npm run lint accepted a Function alias\n${commandDiagnostics('npm run lint', result)}`,
  );
});

test('round-two boundary lint rejects createRequire loaders', () => {
  const result = probeDomainSource(
    [
      'import { createRequire } from "node:module";',
      'const load = createRequire(import.meta.url);',
      'export const graph = load("@aic/graph");',
      '',
    ].join('\n'),
  );

  assert.notEqual(
    result.status,
    0,
    `npm run lint accepted createRequire\n${commandDiagnostics('npm run lint', result)}`,
  );
});

test('round-two boundary lint rejects aliased createRequire loaders', () => {
  const result = probeDomainSource(
    [
      'import { createRequire as makeRequire } from "node:module";',
      'const load = makeRequire(import.meta.url);',
      'export const graph = load("@aic/graph");',
      '',
    ].join('\n'),
  );

  assert.notEqual(
    result.status,
    0,
    `npm run lint accepted an aliased createRequire\n${commandDiagnostics('npm run lint', result)}`,
  );
});

test('round-two boundary lint rejects an indirect require loader', () => {
  const result = probeDomainSource(
    'const load = require; export const graph = load("@aic/graph");\n',
  );

  assert.notEqual(
    result.status,
    0,
    `npm run lint accepted an indirect require alias\n${commandDiagnostics('npm run lint', result)}`,
  );
});

test('round-two boundary lint scans nested source directories named dist', () => {
  const result = probeBoundaryMutation((fixtureRoot) => {
    const escapePath = resolve(fixtureRoot, 'packages/domain/src/dist/escape.mjs');
    mkdirSync(dirname(escapePath), { recursive: true });
    writeFileSync(escapePath, 'import "@aic/graph";\n');
  });

  assert.notEqual(
    result.status,
    0,
    `npm run lint skipped packages/domain/src/dist/escape.mjs\n${commandDiagnostics('npm run lint', result)}`,
  );
});

test('round-two boundary lint rejects TypeScript import types from graph', () => {
  const result = probeDomainSource(
    'export type GraphModule = typeof import("@aic/graph");\n',
  );

  assert.notEqual(
    result.status,
    0,
    `npm run lint accepted a TSImportType dependency on graph\n${commandDiagnostics('npm run lint', result)}`,
  );
});

test('round-two boundary lint rejects TypeScript paths into graph', () => {
  const result = probeDomainJson('tsconfig.json', (configuration) => {
    configuration.compilerOptions.paths = {
      ...configuration.compilerOptions.paths,
      '#graph-types': ['../graph/src/index.ts'],
    };
  });

  assert.notEqual(
    result.status,
    0,
    `npm run lint accepted compilerOptions.paths -> ../graph\n${commandDiagnostics('npm run lint', result)}`,
  );
});

test('round-two boundary lint resolves TypeScript paths from baseUrl', () => {
  const result = probeDomainJson('tsconfig.json', (configuration) => {
    configuration.compilerOptions.baseUrl = 'src';
    configuration.compilerOptions.paths = {
      ...configuration.compilerOptions.paths,
      '#graph-types': ['../../graph/src/index.ts'],
    };
  });

  assert.notEqual(
    result.status,
    0,
    `npm run lint accepted a baseUrl-relative path into graph\n${commandDiagnostics('npm run lint', result)}`,
  );
});

test('round-two boundary lint rejects an absolute file dependency alias to graph', () => {
  const result = probeBoundaryMutation((fixtureRoot) => {
    const manifestPath = resolve(fixtureRoot, 'packages/domain/package.json');
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
    manifest.dependencies = {
      ...manifest.dependencies,
      'graph-alias': `file:${resolve(fixtureRoot, 'packages/graph')}`,
    };
    writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  });

  assert.notEqual(
    result.status,
    0,
    `npm run lint accepted an absolute file: alias to graph\n${commandDiagnostics('npm run lint', result)}`,
  );
});

test('round-two boundary lint rejects an absolute project reference to graph', () => {
  const result = probeBoundaryMutation((fixtureRoot) => {
    const configurationPath = resolve(fixtureRoot, 'packages/domain/tsconfig.json');
    const configuration = JSON.parse(readFileSync(configurationPath, 'utf8'));
    configuration.references = [
      ...(configuration.references ?? []),
      { path: resolve(fixtureRoot, 'packages/graph') },
    ];
    writeFileSync(configurationPath, `${JSON.stringify(configuration, null, 2)}\n`);
  });

  assert.notEqual(
    result.status,
    0,
    `npm run lint accepted an absolute tsconfig reference to graph\n${commandDiagnostics('npm run lint', result)}`,
  );
});

test('round-two boundary lint rejects a file URL source import from graph', () => {
  const result = probeBoundaryMutation((fixtureRoot) => {
    const specifier = pathToFileURL(resolve(fixtureRoot, 'packages/graph/src/index.js')).href;
    writeFileSync(
      resolve(fixtureRoot, 'packages/domain/__boundary_probe__.ts'),
      `import ${JSON.stringify(specifier)};\n`,
    );
  });

  assert.notEqual(
    result.status,
    0,
    `npm run lint accepted a file URL import from graph\n${commandDiagnostics('npm run lint', result)}`,
  );
});

test('round-two boundary lint rejects an absolute source import from graph', () => {
  const result = probeBoundaryMutation((fixtureRoot) => {
    const specifier = resolve(fixtureRoot, 'packages/graph/src/index.js');
    writeFileSync(
      resolve(fixtureRoot, 'packages/domain/__boundary_probe__.ts'),
      `import ${JSON.stringify(specifier)};\n`,
    );
  });

  assert.notEqual(
    result.status,
    0,
    `npm run lint accepted an absolute import from graph\n${commandDiagnostics('npm run lint', result)}`,
  );
});

test('pre-round-two boundary lint rejects a destructured global eval alias', () => {
  const result = probeDomainSource(
    [
      'const { eval: execute } = globalThis;',
      'export const loadGraph = () => execute(\'import("@aic/graph")\');',
      '',
    ].join('\n'),
  );

  assert.notEqual(
    result.status,
    0,
    `npm run lint accepted a destructured global eval alias\n${commandDiagnostics('npm run lint', result)}`,
  );
});

test('pre-round-two boundary lint rejects destructured createRequire from a module namespace', () => {
  const result = probeDomainSource(
    [
      'import * as moduleApi from "node:module";',
      'const { createRequire: makeRequire } = moduleApi;',
      'const load = makeRequire(import.meta.url);',
      'export const graph = load("@aic/graph");',
      '',
    ].join('\n'),
  );

  assert.notEqual(
    result.status,
    0,
    `npm run lint accepted destructured createRequire\n${commandDiagnostics('npm run lint', result)}`,
  );
});

test('pre-round-two boundary lint rejects a closure-produced require loader', () => {
  const result = probeDomainSource(
    'const load = (() => require)(); export const graph = load("@aic/graph");\n',
  );

  assert.notEqual(
    result.status,
    0,
    `npm run lint accepted require returned by an IIFE\n${commandDiagnostics('npm run lint', result)}`,
  );
});

test('pre-round-two boundary lint rejects a domain tsconfig extending graph', () => {
  const result = probeDomainJson('tsconfig.json', (configuration) => {
    configuration.extends = '../graph/tsconfig.json';
  });

  assert.notEqual(
    result.status,
    0,
    `npm run lint accepted tsconfig extends ../graph/tsconfig.json\n${commandDiagnostics('npm run lint', result)}`,
  );
});

test('pre-round-two boundary lint rejects a domain baseUrl pointing at graph', () => {
  const result = probeDomainJson('tsconfig.json', (configuration) => {
    configuration.compilerOptions.baseUrl = '../graph';
  });

  assert.notEqual(
    result.status,
    0,
    `npm run lint accepted compilerOptions.baseUrl=../graph\n${commandDiagnostics('npm run lint', result)}`,
  );
});

test('does not introduce a prebuilt autonomous tool loop', () => {
  const sourceFiles = [
    ...walkSourceFiles(resolve(projectRoot, 'apps')),
    ...walkSourceFiles(resolve(projectRoot, 'packages')),
  ];

  for (const path of sourceFiles) {
    const source = readFileSync(path, 'utf8');
    assert.doesNotMatch(
      source,
      /@langchain\/langgraph\/prebuilt|\bcreateReactAgent\b|\bcreate_react_agent\b/,
      `${relative(projectRoot, path)} must not instantiate a prebuilt autonomous tool loop`,
    );
  }
});
