/**
 * AIC-100, slice d ("migrate the legacy live/replay tool adapters onto the
 * EvidenceSource/BoundSourceRegistry contract"), the Option A owner-approved
 * design's fixture-migration half.
 *
 * This file pins `migrateReplayFixtureV1(fixture, { fetchedAt })`, a NEW
 * export from `@aic/tools` (not yet implemented — every row below is
 * expected to fail on the missing export or the behaviour it names, never on
 * a typo in the test itself):
 *
 *   `migrateReplayFixtureV1({ version: 1, responses }, { fetchedAt })` ->
 *   `{ recordings, skipped }`
 *
 * Design pins, stated exactly (owner-approved, this ticket):
 *   - Adapter identity for every migrated entry: `adapterId` is the fixed
 *     literal `'aic.incident-tool'`, `version` is the fixed literal `'1'` —
 *     so `provenance.adapter` is always `'aic.incident-tool@1'`.
 *   - `sourceBindingId === operation === toolId` for every migrated entry —
 *     the legacy fixture format carries no separate binding id, so the tool
 *     id fills both registry-level roles.
 *   - `credentialRefId` is always `null` — the legacy fixture format has no
 *     credential-reference concept at all.
 *   - The new v2 identity string is exactly what
 *     `createBoundSourceRegistry` (`./bound-source-registry.ts`) builds:
 *     `` `v2:${JSON.stringify([sourceBindingId, adapter, requestFingerprint])}` ``,
 *     where `requestFingerprint` is `createRequestFingerprint(operation, input)`'s
 *     usual `` `sha256:${hex}` `` over the canonical envelope
 *     `JSON.stringify(canonicalJson({ input, operation }))`.
 *   - Each legacy `ToolResult` (the `v1` fixture's `responses[key]` value) is
 *     carried WHOLE, verbatim, as the migrated recording's `ok` `output` —
 *     an `unavailable`/`error` legacy result with its own free-text
 *     `reason`/`message` is not reinterpreted into one of the registry's six
 *     typed refusal reasons; it survives byte-for-byte inside `output`. Only
 *     a registry-LEVEL failure (an unparseable key, a non-read-only tool id)
 *     ever produces a typed refusal, and this module never produces one at
 *     all — it either migrates an entry into `recordings` or reports it in
 *     `skipped`, never throws for a single bad entry.
 *   - A fixture whose own `version` is not `1` is refused synchronously,
 *     before any entry is inspected (row 5, `/version/`).
 *   - Migration is pure and deterministic: the same `responses` content
 *     produces the same `recordings`, independent of the object's own key
 *     insertion order (row 6) — no clock, no randomness, `fetchedAt` is the
 *     one caller-supplied value threaded through unchanged.
 *
 * The first row's expected v2 identity is built by hand with `node:crypto`
 * over a canonical envelope written out as a literal string — an independent
 * oracle, never `createRequestFingerprint` or `canonicalJson` called from the
 * test — matching the same shape
 * test/evidence-source-contract.test.mjs's own "matches an independently
 * computed sha256" row uses.
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';

import * as evals from '@aic/evals';
import * as tools from '@aic/tools';

function migrateReplayFixtureV1Factory() {
  assert.equal(
    typeof tools.migrateReplayFixtureV1,
    'function',
    '@aic/tools must export migrateReplayFixtureV1(fixture, { fetchedAt }): { recordings, skipped } (AIC-100 slice d)',
  );
  return tools.migrateReplayFixtureV1;
}

const FIXED_FETCHED_AT = '2026-09-24T00:00:00.000Z';

/* -------------------------------------------------------------------------- */
/* Row 1 — the pinned v2 identity, independent oracle                         */
/* -------------------------------------------------------------------------- */

test('migrates a literal v1 key for tool "logs" and input {service: "checkout"} to the pinned v2 identity, an independent oracle built by hand with node:crypto', () => {
  const migrateReplayFixtureV1 = migrateReplayFixtureV1Factory();

  const toolId = 'logs';
  const input = { service: 'checkout' };
  const v1Key = tools.createReplayFixtureKey(toolId, input);
  const toolResult = { status: 'ok', output: [{ id: 'e1', statement: 'checkout returned 500' }] };
  const fixture = { version: 1, responses: { [v1Key]: toolResult } };

  // Independent oracle: written by hand, never produced by calling
  // canonicalJson or createRequestFingerprint from this test — matching
  // test/evidence-source-contract.test.mjs's own "matches an independently
  // computed sha256" row. canonicalJson sorts every key recursively,
  // including the envelope's own two top-level keys ("input" before
  // "operation"), and here the single-key input needs no reordering.
  const handBuiltCanonicalEnvelope = '{"input":{"service":"checkout"},"operation":"logs"}';
  const expectedHex = createHash('sha256').update(handBuiltCanonicalEnvelope).digest('hex');
  const expectedFingerprint = `sha256:${expectedHex}`;
  const expectedIdentity = `v2:${JSON.stringify(['logs', 'aic.incident-tool@1', expectedFingerprint])}`;

  const { recordings, skipped } = migrateReplayFixtureV1(fixture, { fetchedAt: FIXED_FETCHED_AT });

  assert.deepEqual(skipped, { count: 0, keys: [] });
  assert.deepEqual(
    Object.keys(recordings),
    [expectedIdentity],
    `expected the single migrated identity ${expectedIdentity}, got ${JSON.stringify(Object.keys(recordings))}`,
  );
  assert.deepEqual(recordings[expectedIdentity], {
    status: 'ok',
    output: toolResult,
    provenance: {
      sourceBindingId: 'logs',
      adapter: 'aic.incident-tool@1',
      credentialRefId: null,
      fetchedAt: FIXED_FETCHED_AT,
      requestFingerprint: expectedFingerprint,
    },
  });
});

/* -------------------------------------------------------------------------- */
/* Row 2 — unavailable/error ToolResults survive verbatim inside output       */
/* -------------------------------------------------------------------------- */

test('carries an unavailable ToolResult with a free-text reason intact inside output, never reinterpreted as a typed refusal reason', () => {
  const migrateReplayFixtureV1 = migrateReplayFixtureV1Factory();

  const toolId = 'metrics';
  const input = { window: '5m' };
  const toolResult = { status: 'unavailable', reason: 'metrics backend is disabled for this scenario' };
  const v1Key = tools.createReplayFixtureKey(toolId, input);

  const { recordings, skipped } = migrateReplayFixtureV1(
    { version: 1, responses: { [v1Key]: toolResult } },
    { fetchedAt: FIXED_FETCHED_AT },
  );

  assert.equal(skipped.count, 0);
  const [identity] = Object.keys(recordings);
  assert.equal(recordings[identity].status, 'ok', 'a legacy unavailable ToolResult is carried as an ok recording');
  assert.deepEqual(recordings[identity].output, toolResult);
});

test('carries an error ToolResult with a free-text message intact inside output, never reinterpreted as a typed refusal reason', () => {
  const migrateReplayFixtureV1 = migrateReplayFixtureV1Factory();

  const toolId = 'metrics';
  const input = { window: '5m' };
  const toolResult = { status: 'error', message: 'metrics endpoint timed out after 30s' };
  const v1Key = tools.createReplayFixtureKey(toolId, input);

  const { recordings, skipped } = migrateReplayFixtureV1(
    { version: 1, responses: { [v1Key]: toolResult } },
    { fetchedAt: FIXED_FETCHED_AT },
  );

  assert.equal(skipped.count, 0);
  const [identity] = Object.keys(recordings);
  assert.equal(recordings[identity].status, 'ok', 'a legacy error ToolResult is carried as an ok recording');
  assert.deepEqual(recordings[identity].output, toolResult);
});

/* -------------------------------------------------------------------------- */
/* Row 3 — key-order-permuted inputs match a direct fingerprint               */
/* -------------------------------------------------------------------------- */

test('migrates a key-order-permuted input to the same identity a direct fingerprint of the original input produces', () => {
  const migrateReplayFixtureV1 = migrateReplayFixtureV1Factory();

  const toolId = 'logs';
  const inputInOrder = { service: 'checkout', query: { level: 'error', limit: 1 } };
  const inputReordered = { query: { limit: 1, level: 'error' }, service: 'checkout' };
  const toolResult = { status: 'ok', output: [] };

  const fixtureInOrder = {
    version: 1,
    responses: { [tools.createReplayFixtureKey(toolId, inputInOrder)]: toolResult },
  };
  const fixtureReordered = {
    version: 1,
    responses: { [tools.createReplayFixtureKey(toolId, inputReordered)]: toolResult },
  };

  const migratedInOrder = migrateReplayFixtureV1(fixtureInOrder, { fetchedAt: FIXED_FETCHED_AT });
  const migratedReordered = migrateReplayFixtureV1(fixtureReordered, { fetchedAt: FIXED_FETCHED_AT });

  const directFingerprint = tools.createRequestFingerprint(toolId, inputInOrder);
  const directIdentity = `v2:${JSON.stringify([toolId, 'aic.incident-tool@1', directFingerprint])}`;

  assert.deepEqual(migratedInOrder.skipped, { count: 0, keys: [] });
  assert.deepEqual(migratedReordered.skipped, { count: 0, keys: [] });
  assert.deepEqual(Object.keys(migratedInOrder.recordings), [directIdentity]);
  assert.deepEqual(Object.keys(migratedReordered.recordings), [directIdentity]);
});

/* -------------------------------------------------------------------------- */
/* Row 4 — a non-read-only tool id, or an unparseable key, is skipped         */
/* -------------------------------------------------------------------------- */

test('skips a non-read-only tool id without throwing, and records it in skipped by count and key', () => {
  const migrateReplayFixtureV1 = migrateReplayFixtureV1Factory();

  const nonReadOnlyKey = tools.createReplayFixtureKey('secrets', { any: true });
  const fixture = { version: 1, responses: { [nonReadOnlyKey]: { status: 'ok', output: [] } } };

  const { recordings, skipped } = migrateReplayFixtureV1(fixture, { fetchedAt: FIXED_FETCHED_AT });

  assert.deepEqual(recordings, {});
  assert.equal(skipped.count, 1);
  assert.deepEqual(skipped.keys, [nonReadOnlyKey]);
});

test('skips an unparseable v1 key without throwing, and records it in skipped by count and key', () => {
  const migrateReplayFixtureV1 = migrateReplayFixtureV1Factory();

  const unparseableKey = 'this-is-not-a-v1-replay-fixture-key';
  const fixture = { version: 1, responses: { [unparseableKey]: { status: 'ok', output: [] } } };

  const { recordings, skipped } = migrateReplayFixtureV1(fixture, { fetchedAt: FIXED_FETCHED_AT });

  assert.deepEqual(recordings, {});
  assert.equal(skipped.count, 1);
  assert.deepEqual(skipped.keys, [unparseableKey]);
});

test('skips one bad entry and still migrates the other good entries in the same fixture, never throwing for the whole fixture', () => {
  const migrateReplayFixtureV1 = migrateReplayFixtureV1Factory();

  const goodKey = tools.createReplayFixtureKey('logs', { service: 'checkout' });
  const nonReadOnlyKey = tools.createReplayFixtureKey('secrets', { any: true });
  const unparseableKey = 'not-a-v1-key-either';
  const goodResult = { status: 'ok', output: [{ id: 'e1' }] };

  const { recordings, skipped } = migrateReplayFixtureV1(
    {
      version: 1,
      responses: {
        [goodKey]: goodResult,
        [nonReadOnlyKey]: { status: 'ok', output: [] },
        [unparseableKey]: { status: 'ok', output: [] },
      },
    },
    { fetchedAt: FIXED_FETCHED_AT },
  );

  assert.equal(Object.keys(recordings).length, 1);
  assert.equal(skipped.count, 2);
  assert.deepEqual(new Set(skipped.keys), new Set([nonReadOnlyKey, unparseableKey]));
});

/* -------------------------------------------------------------------------- */
/* Row 5 — an unsupported fixture version is refused synchronously            */
/* -------------------------------------------------------------------------- */

test('throws synchronously for a fixture whose version is not 1', () => {
  const migrateReplayFixtureV1 = migrateReplayFixtureV1Factory();

  assert.throws(
    () => migrateReplayFixtureV1({ version: 2, responses: {} }, { fetchedAt: FIXED_FETCHED_AT }),
    /version/,
  );
});

/* -------------------------------------------------------------------------- */
/* Row 6 — deterministic, independent of the responses object's key order     */
/* -------------------------------------------------------------------------- */

test('is deterministic: the same responses content produces deep-equal recordings and skipped, regardless of the object\'s key insertion order', () => {
  const migrateReplayFixtureV1 = migrateReplayFixtureV1Factory();

  const keyA = tools.createReplayFixtureKey('logs', { service: 'checkout' });
  const keyB = tools.createReplayFixtureKey('metrics', { window: '5m' });
  const resultA = { status: 'ok', output: [{ id: 'a' }] };
  const resultB = { status: 'ok', output: [{ id: 'b' }] };

  const fixtureInOrder = { version: 1, responses: { [keyA]: resultA, [keyB]: resultB } };
  const fixtureReversed = { version: 1, responses: { [keyB]: resultB, [keyA]: resultA } };

  const first = migrateReplayFixtureV1(fixtureInOrder, { fetchedAt: FIXED_FETCHED_AT });
  const second = migrateReplayFixtureV1(fixtureReversed, { fetchedAt: FIXED_FETCHED_AT });

  assert.deepEqual(first.recordings, second.recordings);
  assert.deepEqual(first.skipped, second.skipped);
});

/* -------------------------------------------------------------------------- */
/* Row 7 — every @aic/evals REPLAY_SCENARIOS entry migrates, uniquely         */
/* -------------------------------------------------------------------------- */

test('migrates every entry of every @aic/evals REPLAY_SCENARIOS fixture, one unique identity per distinct v1 key, none skipped', () => {
  const migrateReplayFixtureV1 = migrateReplayFixtureV1Factory();

  const responses = {};
  let entryCount = 0;
  for (const scenario of evals.REPLAY_SCENARIOS) {
    for (const entry of scenario.fixture.entries) {
      responses[tools.createReplayFixtureKey(entry.toolId, entry.input)] = entry.result;
      entryCount += 1;
    }
  }
  const uniqueKeyCount = Object.keys(responses).length;
  assert.ok(uniqueKeyCount > 0, 'REPLAY_SCENARIOS must contribute at least one fixture entry for this row to mean anything');

  const { recordings, skipped } = migrateReplayFixtureV1({ version: 1, responses }, { fetchedAt: FIXED_FETCHED_AT });

  assert.deepEqual(
    skipped,
    { count: 0, keys: [] },
    `expected no skips across ${entryCount} entries (${uniqueKeyCount} distinct v1 keys), got ${JSON.stringify(skipped)}`,
  );
  assert.equal(
    Object.keys(recordings).length,
    uniqueKeyCount,
    `every one of the ${uniqueKeyCount} distinct v1 keys across REPLAY_SCENARIOS must migrate to its own identity`,
  );
  assert.equal(
    new Set(Object.keys(recordings)).size,
    uniqueKeyCount,
    'migrated identities must be unique — no two distinct v1 keys collide onto the same v2 identity',
  );
});
