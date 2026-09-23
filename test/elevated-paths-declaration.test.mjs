import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import test from 'node:test';

import { elevatedPathsIn, readDeclaredPaths } from '../.claude/scripts/detect-missed-gate.mjs';

const projectRoot = join(dirname(fileURLToPath(import.meta.url)), '..');

/**
 * The repository's own elevated-paths declaration, read the way the gate sweep
 * reads it — through `readDeclaredPaths` over this checkout, never a restated
 * copy of the list.
 *
 * `AGENTS.md` asks for the list to be extended "the same day you write the code
 * it covers". AIC-55 added the first infrastructure configuration under
 * `infra/` — a loopback-only PostgreSQL whose container trusts every local
 * connection — and both of its reviewers found the directory undeclared, so a
 * later edit binding that port off loopback would merge without the sweep
 * asking for `human-review`.
 */
test('declares the infrastructure configuration under infra/ as an elevated path', () => {
  const declared = readDeclaredPaths(projectRoot);
  assert.ok(Array.isArray(declared), 'the repository must carry an elevated-paths declaration at all');

  assert.deepEqual(
    elevatedPathsIn(['infra/postgres/compose.yaml'], declared),
    ['infra/postgres/compose.yaml'],
    'the PostgreSQL compose file is infrastructure configuration — a Tier-2 kind — and the sweep must see a merge that changes it',
  );
});

test('still treats a test path under infra/ as inert, so the declaration does not escalate the lane on its own', () => {
  const declared = readDeclaredPaths(projectRoot);

  assert.deepEqual(
    elevatedPathsIn(['infra/postgres/tests/postgres-checkpointer.live.mjs', 'infra/README.md'], declared),
    [],
    'test paths and markdown under an elevated directory provision nothing; the sweep\'s inert carve-out must keep holding for infra/',
  );
});
