/**
 * AIC-94, step 5: the provider stays behind one file, and the graph and domain
 * layers stay provider-independent.
 *
 * The acceptance row this file covers reads "no provider SDK leaks into domain
 * or graph". That is two claims, and only one of them was enforced before this
 * item: `dependency-cruiser.config.mjs` scoped BOTH of its rules to
 * `^packages/domain/`, and `eslint.config.mjs` covers `packages/domain/**`
 * alone. The mechanical half of the graph claim is the new
 * `graph-and-domain-do-not-import-model-providers` rule, whose bite is measured
 * by `test/repository-scaffold.test.mjs` › "lint rejects a graph import of the
 * model role package". This file is the textual half: it holds the WORKSPACE to
 * a single provider-aware file, which no module-graph rule can express, because
 * a host name in a string is not an import.
 */
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

function sourceFiles(directory) {
  const found = [];
  const walk = (current) => {
    for (const entry of readdirSync(current)) {
      if (entry === 'node_modules' || entry === 'dist') continue;
      const path = join(current, entry);
      if (statSync(path).isDirectory()) {
        walk(path);
        continue;
      }
      if (path.endsWith('.ts')) found.push(path);
    }
  };
  walk(directory);
  return found;
}

const workspaceSources = sourceFiles(resolve(projectRoot, 'packages'));

/**
 * What "names the provider" means, spelled once.
 *
 * The host and the wire vocabulary, not the word "model": a role that says
 * `ModelPort` has named an abstraction, while a file that says
 * `api.anthropic.com` or `anthropic-version` has named a provider's HTTP
 * contract and is the thing this rule bounds to one place.
 */
const PROVIDER_SURFACE = /api\.anthropic\.com|anthropic-version|x-api-key|ANTHROPIC_API_KEY|claude-[a-z0-9-]+/;

test('reaches the model provider from exactly one file in the workspace', () => {
  const naming = workspaceSources.filter((path) =>
    PROVIDER_SURFACE.test(readFileSync(path, 'utf8')),
  );

  assert.deepEqual(
    naming.map((path) => path.slice(projectRoot.length + 1)),
    ['packages/roles/src/reference-model-port.ts'],
    'a second provider is a second adapter beside this one, never an edit spread across the roles',
  );
});

test('keeps every provider reference out of the graph and domain packages', () => {
  for (const layer of ['domain', 'graph']) {
    for (const path of sourceFiles(resolve(projectRoot, 'packages', layer))) {
      const source = readFileSync(path, 'utf8');
      assert.doesNotMatch(
        source,
        PROVIDER_SURFACE,
        `${path} names the model provider: the graph and domain layers stay provider-independent`,
      );
      assert.doesNotMatch(
        source,
        /(?:from\s+|import\s*\()['"]@aic\/roles(?:\/[^'"]*)?['"]/,
        `${path} imports the role package, which is what carries the provider adapter`,
      );
    }
  }
});

test('performs the provider request in the adapter and nowhere else', () => {
  const issuing = workspaceSources.filter((path) => {
    const source = readFileSync(path, 'utf8');
    return /\bfetch\s*\(/.test(source) || /\bhttps?:\/\//.test(source);
  });

  assert.deepEqual(
    issuing.map((path) => path.slice(projectRoot.length + 1)),
    ['packages/roles/src/reference-model-port.ts'],
    'one outbound HTTP surface, so a security review has one file to read',
  );
});

test('keeps one own-property read for the whole roles package', () => {
  const defining = sourceFiles(resolve(projectRoot, 'packages/roles')).filter(
    (path) => /export function ownValue\b/.test(readFileSync(path, 'utf8')),
  );

  assert.deepEqual(
    defining.map((path) => path.slice(projectRoot.length + 1)),
    ['packages/roles/src/own-value.ts'],
    'two spellings of one read is how the copy nobody looks at goes wrong',
  );
});

test('states the adapter limits in the adapter', () => {
  const adapter = readFileSync(
    resolve(projectRoot, 'packages/roles/src/reference-model-port.ts'),
    'utf8',
  );

  for (const limit of ['no streaming', 'no retry', 'no tool use']) {
    assert.ok(
      adapter.includes(limit),
      `the adapter must state its "${limit}" limit where a reader of it will be`,
    );
  }
});

test('adds no provider SDK to any package manifest', () => {
  const manifests = [
    'package.json',
    'packages/domain/package.json',
    'packages/graph/package.json',
    'packages/roles/package.json',
    'packages/evals/package.json',
    'packages/observability/package.json',
    'packages/tools/package.json',
    'packages/persistence/package.json',
    'apps/cli/package.json',
  ];

  for (const relativePath of manifests) {
    const manifest = JSON.parse(
      readFileSync(resolve(projectRoot, relativePath), 'utf8'),
    );
    const declared = Object.keys({
      ...manifest.dependencies,
      ...manifest.devDependencies,
    });
    for (const name of declared) {
      assert.doesNotMatch(
        name,
        /^(?:@anthropic-ai\/|openai$|@google\/generative-ai$|@aws-sdk\/client-bedrock)/,
        `${relativePath} declares a provider SDK: the reference path is plain fetch with an injected transport, which keeps the supply-chain surface unchanged`,
      );
    }
  }
});

test('declares the model-provider boundary rule for graph and domain', () => {
  const config = readFileSync(
    resolve(projectRoot, 'dependency-cruiser.config.mjs'),
    'utf8',
  );

  assert.match(
    config,
    /graph-and-domain-do-not-import-model-providers/,
    'the graph half of the boundary needs a rule, not only a convention',
  );
  assert.match(
    config,
    /\^packages\/\(\?:domain\|graph\)\//,
    'the rule must be scoped to both layers the acceptance row names',
  );
});
