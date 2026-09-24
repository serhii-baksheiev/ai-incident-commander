/**
 * AIC-100, slice d ("migrate the legacy live/replay tool adapters onto the
 * EvidenceSource/BoundSourceRegistry contract"), the Option A owner-approved
 * design's adapter half. Nothing here touches
 * test/fixtures/benchmark-experiment.mjs, test/tool-registry-replay.test.mjs,
 * test/replay-scenarios.test.mjs, test/durable-execution-contract.test.mjs,
 * or test/lane-arms.test.mjs — those existing rows are the guards this
 * slice's Green step must keep passing UNEDITED, and this file names none of
 * them.
 *
 * Three pieces of surface this file pins — every row below guards a missing
 * export or the behaviour it names, never a typo in the test itself:
 *
 *   - `createIncidentToolSource(tool)`, a NEW export from `@aic/tools`: an
 *     `EvidenceSource` wrapper around one legacy `IncidentTool`.
 *     `describe()` returns `{ adapterId: 'aic.incident-tool', version: '1',
 *     operations: [tool.id] }` — the same fixed adapter identity
 *     `migrateReplayFixtureV1` (test/replay-fixture-migration.test.mjs) uses.
 *     `execute()` wraps the tool's own `ToolResult` WHOLE as the outcome's
 *     `ok` `output` (mirroring the migration's own "carried whole" design —
 *     an `unavailable`/`error` legacy result is not reinterpreted); a throw
 *     from the wrapped tool propagates, for the registry's own
 *     `classifyEvidenceSourceFailure` to handle exactly as it does for any
 *     other adapter.
 *   - `createMemoryReplayStore(initial?)`, an ADDITIVE optional argument on
 *     the EXISTING export: a plain object of `identity -> outcome` entries
 *     the store's `get()`/`keys()` see immediately, with no prior `set()`.
 *   - The legacy `LiveToolAdapter` (`@aic/tools/live`) and `ReplayToolAdapter`
 *     (`@aic/tools/replay`) become thin wrappers over
 *     `createBoundSourceRegistry` — so a credential-shaped value anywhere in
 *     a tool's `ToolResult` is redacted through both, and `LiveToolAdapter`
 *     gains an ADDITIVE second constructor argument, `{ budgets?, clock? }`,
 *     that reaches the registry's own budget enforcement (timeout, in this
 *     file; result-size and page budgets are `bound-source-registry.test.mjs`'s
 *     own surface, not repeated here).
 *
 * `sourceBindingId === operation === toolId` and `credentialRefId === null`
 * throughout, matching `migrateReplayFixtureV1`'s own design pins — the two
 * halves of this ticket use the same identity scheme, which is exactly what
 * the "record-mode registry over createIncidentToolSource produces the same
 * identity as migrateReplayFixtureV1" row below checks directly.
 *
 * Assembled credential fixtures follow this repository's own convention
 * (`.claude/scripts/lib/secrets.mjs`'s vocabulary; see
 * test/bound-source-registry.test.mjs's own fixture constants): built at
 * runtime from string-literal pieces, never a single literal that reads as a
 * real credential.
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import * as tools from '@aic/tools';
import { LiveToolAdapter } from '@aic/tools/live';
import { ReplayToolAdapter } from '@aic/tools/replay';

import { childEnv } from './fixtures/child-env.mjs';

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const childFixturePath = resolve(projectRoot, 'test/fixtures/legacy-replay-child.mjs');

const FIXED_FETCHED_AT = '2026-09-24T00:00:00.000Z';

// Assembled, never a literal credential — a GitHub personal-access-token
// shape (`ghp_` + 36 alphanumerics), the same shape and construction
// test/bound-source-registry.test.mjs's own `fixtureGithubToken` uses.
const fixtureGithubToken = ['gh', 'p_'].join('') + 'A'.repeat(36);

function migrateReplayFixtureV1Factory() {
  assert.equal(
    typeof tools.migrateReplayFixtureV1,
    'function',
    '@aic/tools must export migrateReplayFixtureV1(fixture, { fetchedAt }): { recordings, skipped } (AIC-100 slice d)',
  );
  return tools.migrateReplayFixtureV1;
}

function createIncidentToolSourceFactory() {
  assert.equal(
    typeof tools.createIncidentToolSource,
    'function',
    '@aic/tools must export createIncidentToolSource(tool): EvidenceSource (AIC-100 slice d)',
  );
  return tools.createIncidentToolSource;
}

function withScratchDir(t) {
  const dir = mkdtempSync(join(tmpdir(), 'aic-100d-legacy-adapters-'));
  t.after(() => {
    rmSync(dir, { recursive: true, force: true });
  });
  return dir;
}

/* -------------------------------------------------------------------------- */
/* d2 — createIncidentToolSource                                              */
/* -------------------------------------------------------------------------- */

test('createIncidentToolSource describes itself as the fixed aic.incident-tool@1 adapter, scoped to the wrapped tool\'s own id', () => {
  const createIncidentToolSource = createIncidentToolSourceFactory();

  const source = createIncidentToolSource({
    id: 'logs',
    risk: 'read',
    execute: async () => ({ status: 'ok', output: [] }),
  });

  assert.deepEqual(source.describe(), {
    adapterId: 'aic.incident-tool',
    version: '1',
    operations: ['logs'],
  });
});

test('a record-mode registry over createIncidentToolSource produces the same identity and output as migrateReplayFixtureV1 of the matching v1 fixture, fetchedAt held equal on both sides', async () => {
  const createIncidentToolSource = createIncidentToolSourceFactory();
  const migrateReplayFixtureV1 = migrateReplayFixtureV1Factory();

  const toolId = 'logs';
  const input = { service: 'checkout' };
  const toolResult = { status: 'ok', output: [{ id: 'e1', statement: 'checkout returned 500' }] };
  const tool = { id: toolId, risk: 'read', execute: async () => toolResult };

  const store = tools.createMemoryReplayStore();
  const registry = tools.createBoundSourceRegistry({
    mode: 'record',
    bindings: [{ sourceBindingId: toolId, source: createIncidentToolSource(tool), credentialRefId: null }],
    store,
    clock: () => new Date(FIXED_FETCHED_AT),
  });

  const recordedOutcome = await registry.execute(toolId, toolId, input);
  assert.equal(recordedOutcome.status, 'ok');

  const v1Key = tools.createReplayFixtureKey(toolId, input);
  const { recordings, skipped } = migrateReplayFixtureV1(
    { version: 1, responses: { [v1Key]: toolResult } },
    { fetchedAt: FIXED_FETCHED_AT },
  );
  assert.equal(skipped.count, 0);
  const migratedIdentities = Object.keys(recordings);
  assert.equal(migratedIdentities.length, 1);
  const [migratedIdentity] = migratedIdentities;

  const storedKeys = await store.keys();
  assert.deepEqual(
    storedKeys,
    [migratedIdentity],
    'the record-mode registry and migrateReplayFixtureV1 must key the same (toolId, input) pair identically',
  );
  assert.deepEqual(await store.get(migratedIdentity), recordings[migratedIdentity]);
  assert.deepEqual(recordedOutcome, recordings[migratedIdentity]);
});

test('createMemoryReplayStore(initial) seeds get()/keys() from an initial recordings object, with no prior set()', async () => {
  const requestFingerprint = `sha256:${'0'.repeat(64)}`;
  const identity = `v2:${JSON.stringify(['logs', 'aic.incident-tool@1', requestFingerprint])}`;
  const seededOutcome = {
    status: 'ok',
    output: { status: 'ok', output: [] },
    provenance: {
      sourceBindingId: 'logs',
      adapter: 'aic.incident-tool@1',
      credentialRefId: null,
      fetchedAt: FIXED_FETCHED_AT,
      requestFingerprint,
    },
  };

  const store = tools.createMemoryReplayStore({ [identity]: seededOutcome });

  assert.deepEqual(await store.get(identity), seededOutcome);
  assert.deepEqual(await store.keys(), [identity]);
  assert.equal(await store.get('some-other-identity'), undefined);
});

test('a legacy corpus migrated to v2 and written to a file store replays identically in a freshly spawned child process', async (t) => {
  const migrateReplayFixtureV1 = migrateReplayFixtureV1Factory();
  const dir = withScratchDir(t);
  const filePath = join(dir, 'legacy-corpus.json');

  const entries = [
    { toolId: 'logs', input: { service: 'checkout' }, result: { status: 'ok', output: [{ id: 'e1' }] } },
    { toolId: 'metrics', input: { window: '5m' }, result: { status: 'unavailable', reason: 'metrics disabled for this scenario' } },
  ];
  const responses = {};
  for (const entry of entries) {
    responses[tools.createReplayFixtureKey(entry.toolId, entry.input)] = entry.result;
  }

  const { recordings, skipped } = migrateReplayFixtureV1({ version: 1, responses }, { fetchedAt: FIXED_FETCHED_AT });
  assert.equal(skipped.count, 0);
  assert.equal(Object.keys(recordings).length, entries.length);

  const store = tools.createFileReplayStore(filePath);
  for (const [identity, outcome] of Object.entries(recordings)) {
    await store.set(identity, outcome);
  }

  const corpus = entries.map(({ toolId, input }) => ({ toolId, input }));
  const child = spawnSync(
    process.execPath,
    [childFixturePath, filePath, JSON.stringify(corpus)],
    { cwd: projectRoot, encoding: 'utf8', env: childEnv() },
  );

  assert.equal(
    child.status,
    0,
    `legacy replay child process exited ${child.status}\nstdout:\n${child.stdout}\nstderr:\n${child.stderr}`,
  );

  const outputs = JSON.parse(child.stdout);
  assert.deepEqual(
    outputs,
    entries.map((entry) => entry.result),
    'a fresh file-store instance, in a genuinely separate process, must replay each entry\'s exact original ToolResult',
  );
});

/* -------------------------------------------------------------------------- */
/* d3 — ReplayToolAdapter on the registry: redaction becomes observable       */
/* -------------------------------------------------------------------------- */

test('ReplayToolAdapter redacts an assembled credential inside a replayed ok output, through the registry', async () => {
  const toolId = 'logs';
  const input = { service: 'checkout' };
  const toolResult = {
    status: 'ok',
    output: [{ id: 'e1', statement: `leaked token ${fixtureGithubToken} in the log line` }],
  };
  const key = tools.createReplayFixtureKey(toolId, input);
  const adapter = new ReplayToolAdapter({ version: 1, responses: { [key]: toolResult } });

  const result = await adapter.execute(toolId, input);

  assert.equal(result.status, 'ok');
  const serialized = JSON.stringify(result.output);
  assert.equal(serialized.includes(fixtureGithubToken), false, 'the credential must not survive replay');
  assert.equal(serialized.includes('[REDACTED]'), true, 'the credential\'s span must be replaced with the marker');
});

test('ReplayToolAdapter redacts an assembled credential inside a replayed unavailable reason, through the registry', async () => {
  const toolId = 'metrics';
  const input = { window: '5m' };
  const toolResult = { status: 'unavailable', reason: `disabled: token ${fixtureGithubToken} exposed in config` };
  const key = tools.createReplayFixtureKey(toolId, input);
  const adapter = new ReplayToolAdapter({ version: 1, responses: { [key]: toolResult } });

  const result = await adapter.execute(toolId, input);

  assert.equal(result.status, 'unavailable');
  assert.equal(typeof result.reason, 'string');
  assert.equal(result.reason.includes(fixtureGithubToken), false, 'the credential must not survive replay');
  assert.equal(result.reason.includes('[REDACTED]'), true, 'the credential\'s span must be replaced with the marker');
});

/* -------------------------------------------------------------------------- */
/* d4 — LiveToolAdapter on the registry: additive { budgets?, clock? }        */
/* -------------------------------------------------------------------------- */

test('LiveToolAdapter redacts an assembled credential inside a live tool\'s output, through the registry', async () => {
  const adapter = new LiveToolAdapter([
    {
      id: 'logs',
      risk: 'read',
      execute: async () => ({
        status: 'ok',
        output: [{ id: 'e1', statement: `leaked token ${fixtureGithubToken} in the log line` }],
      }),
    },
  ]);

  const result = await adapter.execute('logs', { service: 'checkout' });

  assert.equal(result.status, 'ok');
  const serialized = JSON.stringify(result.output);
  assert.equal(serialized.includes(fixtureGithubToken), false, 'the credential must not survive live execution');
  assert.equal(serialized.includes('[REDACTED]'), true, 'the credential\'s span must be replaced with the marker');
});

test(
  'LiveToolAdapter refuses a tool that never settles as unavailable/timeout, under a configured budgets.timeoutMs',
  { timeout: 5000 },
  async () => {
    let calls = 0;
    const adapter = new LiveToolAdapter(
      [
        {
          id: 'logs',
          risk: 'read',
          execute: async () => {
            calls += 1;
            return new Promise(() => {}); // never settles
          },
        },
      ],
      { budgets: { timeoutMs: 20, maxResultBytes: 5_000_000, maxPages: 50 } },
    );

    const result = await adapter.execute('logs', { service: 'checkout' });

    assert.deepEqual(result, { status: 'unavailable', reason: 'timeout' });
    assert.equal(calls, 1);
  },
);

test('LiveToolAdapter never reaches the tool for a non-JSON input containing a function, and reports the existing generic execution-failure message', async () => {
  let calls = 0;
  const adapter = new LiveToolAdapter([
    {
      id: 'logs',
      risk: 'read',
      execute: async () => {
        calls += 1;
        return { status: 'ok', output: [] };
      },
    },
  ]);

  const result = await adapter.execute('logs', { service: 'checkout', filter: () => true });

  assert.equal(calls, 0, 'a non-JSON input must never reach the tool');
  assert.deepEqual(result, { status: 'error', message: 'tool execution failed' });
});

test('LiveToolAdapter never reaches the tool for a non-JSON input containing a BigInt, and reports the existing generic execution-failure message', async () => {
  let calls = 0;
  const adapter = new LiveToolAdapter([
    {
      id: 'logs',
      risk: 'read',
      execute: async () => {
        calls += 1;
        return { status: 'ok', output: [] };
      },
    },
  ]);

  const result = await adapter.execute('logs', { service: 'checkout', limit: 1n });

  assert.equal(calls, 0, 'a non-JSON input must never reach the tool');
  assert.deepEqual(result, { status: 'error', message: 'tool execution failed' });
});

/* -------------------------------------------------------------------------- */
/* review round 1 — both adapters unwrap outcome.output as ToolResult         */
/* unchecked, and LiveToolAdapter's zero-option constructor default budgets   */
/* -------------------------------------------------------------------------- */

test('ReplayToolAdapter refuses "replay response is not recorded" when a v1 fixture entry for a valid key is null, rather than returning the unwrapped null (code-reviewer round 1: unchecked outcome.output unwrap)', async () => {
  const toolId = 'logs';
  const input = { service: 'checkout' };
  const key = tools.createReplayFixtureKey(toolId, input);
  const adapter = new ReplayToolAdapter({ version: 1, responses: { [key]: null } });

  const result = await adapter.execute(toolId, input);

  assert.deepStrictEqual(result, { status: 'unavailable', reason: 'replay response is not recorded' });
});

test('ReplayToolAdapter refuses "replay response is not recorded" when a v1 fixture entry for a valid key is a bare string, not a ToolResult-shaped value (code-reviewer round 1)', async () => {
  const toolId = 'logs';
  const input = { service: 'checkout' };
  const key = tools.createReplayFixtureKey(toolId, input);
  const adapter = new ReplayToolAdapter({ version: 1, responses: { [key]: 'nope' } });

  const result = await adapter.execute(toolId, input);

  assert.deepStrictEqual(result, { status: 'unavailable', reason: 'replay response is not recorded' });
});

test('ReplayToolAdapter refuses "replay response is not recorded" when a v1 fixture entry for a valid key is an object whose status is not a recognised ToolResult status (code-reviewer round 1)', async () => {
  const toolId = 'logs';
  const input = { service: 'checkout' };
  const key = tools.createReplayFixtureKey(toolId, input);
  const adapter = new ReplayToolAdapter({ version: 1, responses: { [key]: { status: 'bogus' } } });

  const result = await adapter.execute(toolId, input);

  assert.deepStrictEqual(result, { status: 'unavailable', reason: 'replay response is not recorded' });
});

test('LiveToolAdapter reports the existing generic execution-failure message when the wrapped tool resolves a class instance instead of a ToolResult, rather than returning it unwrapped (code-reviewer round 1)', async () => {
  class NotAToolResult {
    constructor() {
      this.status = 'ok';
      this.output = [];
    }
  }
  const adapter = new LiveToolAdapter([
    { id: 'logs', risk: 'read', execute: async () => new NotAToolResult() },
  ]);

  const result = await adapter.execute('logs', { service: 'checkout' });

  assert.deepStrictEqual(result, { status: 'error', message: 'tool execution failed' });
});

test('LiveToolAdapter reports the existing generic execution-failure message when the wrapped tool resolves null instead of a ToolResult, rather than returning it unwrapped (code-reviewer round 1)', async () => {
  const adapter = new LiveToolAdapter([
    { id: 'logs', risk: 'read', execute: async () => null },
  ]);

  const result = await adapter.execute('logs', { service: 'checkout' });

  assert.deepStrictEqual(result, { status: 'error', message: 'tool execution failed' });
});

test('LiveToolAdapter constructed with NO second (options) argument is still bound by DEFAULT_SOURCE_BUDGETS: an ok result whose serialized size exceeds maxResultBytes is refused budget_exceeded (code-reviewer round 1)', async () => {
  const oversized = 'x'.repeat(tools.DEFAULT_SOURCE_BUDGETS.maxResultBytes + 1);
  const adapter = new LiveToolAdapter([
    { id: 'logs', risk: 'read', execute: async () => ({ status: 'ok', output: oversized }) },
  ]);

  const result = await adapter.execute('logs', { service: 'checkout' });

  assert.deepStrictEqual(result, { status: 'unavailable', reason: 'budget_exceeded' });
});
