/**
 * AIC-56 slice F (the last slice): the remaining acceptance rows that are
 * decidable WITHOUT a database — the lint/static boundary the scope line
 * asks for ("lint/static boundary preventing direct run-scoped PostgreSQL
 * writes outside the approved modules"), the closed set of modules allowed to
 * write an `aic_app` table, and that `@aic/persistence`'s export list never
 * grows a way to read `node_results`.
 *
 * The database-backed half — `pruneTerminalRun`'s refusal and its terminal
 * behaviour, and `readRunProductSnapshot` never reading `node_results` — lives
 * in `infra/postgres/tests/durable-run-retention.live.mjs`.
 *
 * ## Design choices this file assumes, stated rather than discovered later
 *
 * Neither `pruneTerminalRun` nor `readRunProductSnapshot` exists yet
 * (`@aic/persistence`'s current export list, pinned below, has neither), so
 * two of this file's rows fix a shape the remaining acceptance work has not
 * chosen yet:
 *
 *   - the retention module's own source file is named
 *     `packages/persistence/src/retention.ts`. Row "the only modules ..."
 *     below needs ONE literal filename for the module that will contain
 *     `pruneTerminalRun`'s `DELETE FROM "aic_app".node_results`, and this is
 *     the name this file picks. A different name is a fine implementation
 *     choice — say so in the PR description rather than silently leaving this
 *     row red for an unrelated reason.
 *   - `pruneTerminalRun` and `readRunProductSnapshot` are exported from
 *     `@aic/persistence`'s package root (`index.ts`), the same surface every
 *     other AIC-56 slice's public API is re-exported from.
 *
 * If the implementation shapes either differently, that reason belongs in the
 * PR description, not in a silent rename here.
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import * as persistence from '@aic/persistence';

import { childEnv } from './fixtures/child-env.mjs';

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/* -------------------------------------------------------------------------- */
/* Rows 1a/1b — the lint/static boundary the scope line asks for              */
/* -------------------------------------------------------------------------- */

/**
 * Copies the whole worktree into a fresh `mktemp -d` directory, minus the
 * heavy or irrelevant top-level entries — the same shape
 * `test/repository-scaffold.test.mjs`'s `copyForBoundaryProbe` uses for its
 * own dependency-cruiser and ESLint probes (see that file's header for "how
 * dependency-cruiser rules are tested in this repo", which this follows).
 * Not imported from there because that file exports nothing: duplicated in
 * shape rather than reused, the same tradeoff that file's own sibling probes
 * accept.
 *
 * FILE-SAFETY: the copy and every mutation below live under this ONE
 * `mkdtempSync` directory, deleted in its own `finally` — nothing outside it,
 * and nothing outside this process's own scratch directory, is ever touched.
 */
function copyForBoundaryProbe() {
  const temporaryRoot = mkdtempSync(join(tmpdir(), 'aic-durable-run-boundary-'));
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

function writeProbeSource(fixtureRoot, packageDirectory, source) {
  const path = resolve(fixtureRoot, packageDirectory, 'src/__boundary_probe__.ts');
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, source);
}

function runNpm(args, cwd) {
  return spawnSync('npm', args, {
    cwd,
    encoding: 'utf8',
    env: childEnv({ CI: '1' }),
  });
}

function commandDiagnostics(command, result) {
  return `${command} exited ${result.status}\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`;
}

/**
 * Runs `npm run --silent lint:graph` against a fresh copy of the worktree
 * with `mutate` applied, having first confirmed the UNMODIFIED copy passes —
 * the same "baseline first" discipline `test/repository-scaffold.test.mjs`'s
 * `runBoundaryProbe` follows, so a probe that fails for an unrelated reason
 * (a stale fixture, a broken tsconfig reference) is never read as "the rule
 * caught it".
 */
function runDepcruiseProbe(mutate) {
  const { fixtureRoot, temporaryRoot } = copyForBoundaryProbe();
  try {
    const baseline = runNpm(['run', '--silent', 'lint:graph'], fixtureRoot);
    assert.equal(
      baseline.status,
      0,
      `the unmodified scaffold must pass npm run lint:graph before a boundary probe is meaningful\n${commandDiagnostics('npm run lint:graph', baseline)}`,
    );

    mutate(fixtureRoot);
    return runNpm(['run', '--silent', 'lint:graph'], fixtureRoot);
  } finally {
    rmSync(temporaryRoot, { recursive: true, force: true });
  }
}

test('rejects packages/graph importing @aic/persistence', () => {
  const result = runDepcruiseProbe((fixtureRoot) =>
    writeProbeSource(fixtureRoot, 'packages/graph', 'import "@aic/persistence";\n'),
  );
  assert.notEqual(
    result.status,
    0,
    `npm run lint:graph accepted a graph import of @aic/persistence: the graph layer must never reach the run-scoped PostgreSQL substrate directly\n${commandDiagnostics('npm run lint:graph', result)}`,
  );
});

test('rejects packages/graph importing pg directly', () => {
  const result = runDepcruiseProbe((fixtureRoot) =>
    writeProbeSource(fixtureRoot, 'packages/graph', 'import "pg";\n'),
  );
  assert.notEqual(
    result.status,
    0,
    `npm run lint:graph accepted a graph import of pg: the graph layer must never reach the PostgreSQL driver directly, only through @aic/persistence's own bounded adapter\n${commandDiagnostics('npm run lint:graph', result)}`,
  );
});

test('rejects a package other than persistence importing pg', () => {
  // Domain is the representative offender: it is the layer with the
  // strictest existing boundary (framework-free, no orchestration
  // dependency), so a rule that lets pg leak in even there is a rule that
  // protects nothing. "any package other than persistence" is the claim;
  // this row measures it on one instance, the way every existing
  // dependency-cruiser probe in this repository measures its own rule on one
  // representative violation rather than exhaustively on every package.
  const result = runDepcruiseProbe((fixtureRoot) =>
    writeProbeSource(fixtureRoot, 'packages/domain', 'import "pg";\n'),
  );
  assert.notEqual(
    result.status,
    0,
    `npm run lint:graph accepted a domain import of pg: only packages/persistence may import the PostgreSQL driver\n${commandDiagnostics('npm run lint:graph', result)}`,
  );
});

/* -------------------------------------------------------------------------- */
/* Row 3 — the closed set of modules allowed to write an aic_app table        */
/* -------------------------------------------------------------------------- */

/**
 * What counts as a write against an `aic_app` table, read as TEXT rather than
 * through any production import (the independent-oracle invariant,
 * `.claude/rules/invariants.md`): every write statement in this package
 * interpolates the schema as `"${APPLICATION_SCHEMA}"` (measured across
 * `app-schema.ts`, `run-store.ts` and `run-write-context.ts` today), so the
 * scan looks for that literal text beside an INSERT/UPDATE/DELETE verb rather
 * than importing the `APPLICATION_SCHEMA` constant this file is bounding.
 *
 * ⚠ What this does NOT see, stated rather than discovered later: a table
 * name assembled at runtime, a schema qualified any other way (a raw
 * `"aic_app"` literal, a bound parameter), or a write issued from outside
 * `packages/persistence/src` (that half is `test/postgres-checkpointer.test.mjs`
 * › "keeps checkpointer storage, the application schema's tables, and the
 * PostgreSQL driver out of every layer but persistence").
 */
const WRITE_VERB_PATTERN = /\b(?:INSERT INTO|UPDATE|DELETE FROM)\s+"\$\{APPLICATION_SCHEMA\}"/;

/**
 * The closed list of `packages/persistence/src` modules allowed to write an
 * `aic_app` table, read off the tree as it exists today plus the one module
 * this slice's acceptance work still has to add (see this file's header,
 * "Design choices this file assumes").
 */
const ALLOWED_APPLICATION_SCHEMA_WRITERS = Object.freeze([
  'app-schema.ts',
  'run-store.ts',
  'run-write-context.ts',
  'retention.ts',
]);

test('only the allow-listed modules in packages/persistence/src write an aic_app table', () => {
  const sourceDirectory = resolve(projectRoot, 'packages/persistence/src');
  const entries = readdirSync(sourceDirectory).filter((entry) => entry.endsWith('.ts'));
  assert.ok(
    entries.length > 0,
    'the scan found no .ts file under packages/persistence/src at all: an empty scan would pass the assertion below by looking at nothing',
  );

  const writers = entries
    .filter((entry) => WRITE_VERB_PATTERN.test(readFileSync(resolve(sourceDirectory, entry), 'utf8')))
    .sort();

  assert.deepEqual(
    writers,
    [...ALLOWED_APPLICATION_SCHEMA_WRITERS].sort(),
    `packages/persistence/src writes an aic_app table from a module outside the declared allow-list (or is missing one the allow-list expects): found [${writers.join(', ')}], expected [${[...ALLOWED_APPLICATION_SCHEMA_WRITERS].sort().join(', ')}]. A new module writing run-scoped rows must be added to ALLOWED_APPLICATION_SCHEMA_WRITERS deliberately, in the same change that adds the write — never silently.`,
  );
});

/* -------------------------------------------------------------------------- */
/* Row 4 — the export list never grows a way to read node_results            */
/* -------------------------------------------------------------------------- */

/**
 * `@aic/persistence`'s full export list, measured from the BUILT module
 * (`npm run build` first) rather than the source, the same convention
 * `test/roles-boundary.test.mjs` and `test/postgres-checkpointer.test.mjs`
 * follow for a package's own dist output. Pinned as a literal so a new
 * export — including the two this slice is expected to add,
 * `readRunProductSnapshot` and `pruneTerminalRun` — is a visible, deliberate
 * change to this list rather than a silent addition.
 */
const CURRENT_PERSISTENCE_EXPORTS = Object.freeze([
  'APPLICATION_MIGRATIONS',
  'APPLICATION_SCHEMA',
  'APP_SCHEMA_VERSION',
  'CHECKPOINTER_MIGRATION_VERSION',
  'CHECKPOINTER_SCHEMA',
  'DESERIALIZATION_MAX_DEPTH',
  'DESERIALIZATION_MAX_NODES',
  'DeserializationBudgetError',
  'PERSISTENCE_LAYER',
  'RUN_STORE_TRANSITIONS',
  'RUN_WRITE_CONTEXT_FENCE_SQL',
  'RunNotTerminalError',
  'UnverifiableContainerError',
  'assertApplicationSchemaVersion',
  'assertCheckpointerSchemaVersion',
  'createFencedCheckpointer',
  'createPostgresCheckpointer',
  'createRunEventStreamSource',
  'createRunStore',
  'createSqliteCheckpointer',
  'openRunWriteContext',
  'pruneTerminalRun',
  'readRunProductSnapshot',
  'setupApplicationSchema',
  'withDeclaredOwnValues',
]);

test('pins the current @aic/persistence export list, so a new export is a visible change', () => {
  assert.deepEqual(
    Object.keys(persistence).sort(),
    [...CURRENT_PERSISTENCE_EXPORTS].sort(),
    "@aic/persistence's export list changed: update CURRENT_PERSISTENCE_EXPORTS deliberately (this pin exists so a new export, including the read model and the retention function this slice adds, is a change someone reads rather than one nobody notices)",
  );
});

test('no @aic/persistence export name reads node results: node_results is readable through no exported function', () => {
  const offenders = Object.keys(persistence).filter((name) => /nodeResult/i.test(name));

  assert.deepEqual(
    offenders,
    [],
    `@aic/persistence exports a name matching /nodeResult/i: ${offenders.join(', ')}. The acceptance row this test covers is "node_results is not readable through product API/UI paths" — an exported function whose NAME says it reads node results is the plainest way that could stop being true`,
  );
});
