/**
 * AIC-21 slice 1: the tool/action risk registry, held as data in
 * `@aic/domain`, and `@aic/tools`'s derivation from it.
 *
 * ## The new exports this file pins
 *
 *   `@aic/domain`:
 *     - `RiskClassSchema` = `z.enum(['read', 'safe-write', 'dangerous'])`,
 *       `.options` frozen the same way `EvidenceSourceRefusalReasonSchema`'s
 *       are (`packages/domain/src/contracts.ts`).
 *     - `RiskClass` = `z.infer<typeof RiskClassSchema>`.
 *     - `RISK_REGISTRY_VERSION` = `1`.
 *     - `BlastRadiusLevelSchema` = `z.enum(['incident-record', 'service',
 *       'environment'])`.
 *     - `RiskRegistrySchema`: a closed, versioned registry of `{kind:'tool',
 *       id, risk:'read'}` and `{kind:'action', id, risk:'safe-write'|
 *       'dangerous', minimumBlastRadius}` entries, unique ids across both
 *       kinds.
 *     - `RISK_REGISTRY`: the ten-entry constant this file's first row pins
 *       literally, deep-frozen.
 *     - `resolveRisk(id: unknown): RiskRegistryEntry | undefined` — a
 *       null-prototype-safe lookup; a non-string is never coerced.
 *
 *   `@aic/tools`:
 *     - `ToolRisk` becomes `RiskClass` restated (one spelling of the risk
 *       vocabulary) — pinned at compile time by
 *       test/fixtures/risk-registry-type-contract.ts.
 *     - `READ_ONLY_TOOL_REGISTRY` and `isReadOnlyToolId` keep their existing
 *       runtime shape and semantics; this file pins that they now agree with
 *       the registry's `kind:'tool'` entries rather than a private literal
 *       list.
 *
 * ## Oracle discipline
 *
 * Every expected risk, vocabulary member or id set below is a literal
 * written in this file, or an independent re-derivation from a SEPARATE
 * module (`@aic/tools`'s own `READ_ONLY_TOOL_REGISTRY`/`isReadOnlyToolId`
 * compared against `@aic/domain`'s `RISK_REGISTRY`) — never `resolveRisk` or
 * `RISK_REGISTRY` checking themselves (`.claude/rules/invariants.md`, "the
 * independent-oracle invariant").
 *
 * Three rows are pins rather than new-behaviour drivers: each already holds
 * under the registry's own closure rules once the entries exist, so each
 * names, in its own comment, the mutation it exists to catch rather than the
 * behaviour it introduces.
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import * as domain from '@aic/domain';
import * as tools from '@aic/tools';

import { childEnv } from './fixtures/child-env.mjs';

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const compilerPath = resolve(projectRoot, 'node_modules/typescript/bin/tsc');
const typeContractFixture = resolve(
  projectRoot,
  'test/fixtures/risk-registry-type-contract.ts',
);

/* -------------------------------------------------------------------------- */
/* The literal registry table — the independent oracle for row 1             */
/* -------------------------------------------------------------------------- */

const EXPECTED_REGISTRY_ENTRIES = [
  { kind: 'tool', id: 'deployments', risk: 'read' },
  { kind: 'tool', id: 'logs', risk: 'read' },
  { kind: 'tool', id: 'metrics', risk: 'read' },
  { kind: 'tool', id: 'traces', risk: 'read' },
  { kind: 'tool', id: 'git', risk: 'read' },
  { kind: 'tool', id: 'dependencies', risk: 'read' },
  { kind: 'action', id: 'incident-comment', risk: 'safe-write', minimumBlastRadius: 'incident-record' },
  { kind: 'action', id: 'create-follow-up-ticket', risk: 'safe-write', minimumBlastRadius: 'incident-record' },
  { kind: 'action', id: 'restart-service', risk: 'dangerous', minimumBlastRadius: 'service' },
  { kind: 'action', id: 'rollback-deployment', risk: 'dangerous', minimumBlastRadius: 'service' },
];

function assertDeepFrozen(value, path) {
  assert.equal(Object.isFrozen(value), true, `${path} must be frozen`);
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertDeepFrozen(item, `${path}[${index}]`));
  } else if (value !== null && typeof value === 'object') {
    for (const [key, item] of Object.entries(value)) {
      assertDeepFrozen(item, `${path}.${key}`);
    }
  }
}

test('RISK_REGISTRY is version 1 and exactly these ten entries, in order, deeply frozen', () => {
  assert.deepEqual(domain.RISK_REGISTRY, {
    version: 1,
    entries: EXPECTED_REGISTRY_ENTRIES,
  });
  assert.equal(domain.RISK_REGISTRY_VERSION, 1);
  // Kills: an entry added, removed or reclassified against this literal
  // table; a shallow freeze that leaves .entries or an individual entry
  // mutable.
  assertDeepFrozen(domain.RISK_REGISTRY, 'RISK_REGISTRY');
});

test('RiskClassSchema.options is exactly read, safe-write, dangerous, frozen', () => {
  assert.deepEqual(domain.RiskClassSchema.options, ['read', 'safe-write', 'dangerous']);
  // Kills: the vocabulary widened with a fourth member after construction —
  // mirrors EvidenceSourceRefusalReasonSchema's own frozen `.options`
  // (packages/domain/src/contracts.ts).
  assert.equal(Object.isFrozen(domain.RiskClassSchema.options), true);
});

/* -------------------------------------------------------------------------- */
/* Structural closure: a tool entry can never be non-read, an action entry   */
/* can never be read                                                          */
/* -------------------------------------------------------------------------- */

test('RiskRegistrySchema refuses a tool entry with risk safe-write or dangerous', () => {
  for (const risk of ['safe-write', 'dangerous']) {
    const candidate = {
      version: 1,
      entries: [{ kind: 'tool', id: 'deployments', risk }],
    };
    assert.equal(
      domain.RiskRegistrySchema.safeParse(candidate).success,
      false,
      `a tool entry with risk ${risk} must be refused`,
    );
  }
});

test('RiskRegistrySchema refuses an action entry with risk read', () => {
  const candidate = {
    version: 1,
    entries: [
      { kind: 'action', id: 'incident-comment', risk: 'read', minimumBlastRadius: 'incident-record' },
    ],
  };
  assert.equal(domain.RiskRegistrySchema.safeParse(candidate).success, false);
});

test('RiskRegistrySchema refuses a duplicate id across kinds, an extra entry key, an unknown risk, and version 2', () => {
  const duplicateIdAcrossKinds = {
    version: 1,
    entries: [
      { kind: 'tool', id: 'logs', risk: 'read' },
      { kind: 'action', id: 'logs', risk: 'safe-write', minimumBlastRadius: 'incident-record' },
    ],
  };
  assert.equal(
    domain.RiskRegistrySchema.safeParse(duplicateIdAcrossKinds).success,
    false,
    'the same id must not name both a tool and an action',
  );

  const extraEntryKey = {
    version: 1,
    entries: [{ kind: 'tool', id: 'logs', risk: 'read', adapterId: 'lab' }],
  };
  assert.equal(
    domain.RiskRegistrySchema.safeParse(extraEntryKey).success,
    false,
    'an entry carrying a key outside its own strict shape must be refused',
  );

  const unknownRisk = {
    version: 1,
    entries: [{ kind: 'action', id: 'incident-comment', risk: 'execute', minimumBlastRadius: 'incident-record' }],
  };
  assert.equal(
    domain.RiskRegistrySchema.safeParse(unknownRisk).success,
    false,
    'a risk value outside read | safe-write | dangerous must be refused',
  );

  const versionTwo = {
    version: 2,
    entries: EXPECTED_REGISTRY_ENTRIES,
  };
  assert.equal(
    domain.RiskRegistrySchema.safeParse(versionTwo).success,
    false,
    'the registry schema is pinned to version 1 only',
  );
});

/* -------------------------------------------------------------------------- */
/* resolveRisk: a null-prototype-safe, never-coercing lookup                  */
/* -------------------------------------------------------------------------- */

test('resolveRisk returns undefined for __proto__, constructor, toString, hasOwnProperty, an unregistered id, and a non-string whose toString() returns "incident-comment"', () => {
  for (const id of ['__proto__', 'constructor', 'toString', 'hasOwnProperty', 'not-a-registered-id']) {
    assert.equal(domain.resolveRisk(id), undefined, `resolveRisk(${JSON.stringify(id)}) must be undefined`);
  }

  const coercingToARegisteredId = { toString: () => 'incident-comment' };
  assert.equal(
    domain.resolveRisk(coercingToARegisteredId),
    undefined,
    'a non-string must never be coerced through String() or a custom toString() before lookup',
  );
});

test("resolveRisk('incident-comment').risk is 'safe-write', ('restart-service') is 'dangerous', ('logs') is 'read'", () => {
  assert.equal(domain.resolveRisk('incident-comment')?.risk, 'safe-write');
  assert.equal(domain.resolveRisk('restart-service')?.risk, 'dangerous');
  assert.equal(domain.resolveRisk('logs')?.risk, 'read');
});

/* -------------------------------------------------------------------------- */
/* Two-way correspondence: @aic/tools derives from @aic/domain, not a second  */
/* literal copy                                                               */
/* -------------------------------------------------------------------------- */

test("READ_ONLY_TOOL_REGISTRY ids are exactly the registry's tool-kind ids, and vice versa", () => {
  const registryToolIds = domain.RISK_REGISTRY.entries
    .filter((entry) => entry.kind === 'tool')
    .map((entry) => entry.id);
  const toolsRegistryIds = tools.READ_ONLY_TOOL_REGISTRY.map((entry) => entry.id);

  assert.deepEqual(
    [...registryToolIds].sort(),
    [...toolsRegistryIds].sort(),
    'a tools-side literal copy must never diverge from the registry it derives from',
  );

  const toolsRegistrySet = new Set(toolsRegistryIds);
  for (const id of registryToolIds) {
    assert.ok(toolsRegistrySet.has(id), `RISK_REGISTRY tool id ${id} is missing from READ_ONLY_TOOL_REGISTRY`);
  }
  const registryToolSet = new Set(registryToolIds);
  for (const id of toolsRegistryIds) {
    assert.ok(registryToolSet.has(id), `READ_ONLY_TOOL_REGISTRY id ${id} is missing from RISK_REGISTRY`);
  }
});

test('isReadOnlyToolId refuses every action id in the registry', () => {
  // Kills: isReadOnlyToolId widened to "id is in the registry, of any kind"
  // rather than "id is a kind:'tool' entry".
  for (const actionId of ['incident-comment', 'create-follow-up-ticket', 'restart-service', 'rollback-deployment']) {
    assert.equal(tools.isReadOnlyToolId(actionId), false, `isReadOnlyToolId(${actionId}) must be false`);
  }
});

/* -------------------------------------------------------------------------- */
/* Row — the compile-time vocabulary contract                                */
/* -------------------------------------------------------------------------- */

test("compiles the risk-registry type contract: @aic/tools's ToolRisk is exactly @aic/domain's RiskClass", () => {
  // Kills: ToolRisk restated with a member RiskClass does not have, or vice
  // versa — one spelling of the risk vocabulary, not two independently
  // maintained unions.
  const result = spawnSync(
    process.execPath,
    [
      compilerPath,
      '--noEmit',
      '--ignoreConfig',
      '--strict',
      '--skipLibCheck',
      '--target',
      'ES2023',
      '--module',
      'NodeNext',
      '--moduleResolution',
      'NodeNext',
      typeContractFixture,
    ],
    { cwd: projectRoot, encoding: 'utf8', env: childEnv() },
  );

  assert.equal(
    result.status,
    0,
    `type-contract compile exited ${result.status}\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}\n\n@aic/domain must export RiskClassSchema/RiskClass and @aic/tools's ToolRisk must be exactly that same union — see test/fixtures/risk-registry-type-contract.ts`,
  );
});
