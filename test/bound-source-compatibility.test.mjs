/**
 * AIC-98, slice a: the binding-compatibility handshake. `BoundSourceBinding`
 * (`packages/tools/src/bound-source-registry.ts`) gains an OPTIONAL
 * `expectedAdapter?: string` field, `` `${adapterId}@${version}` `` shaped.
 * When present and it differs from the bound source's own `describe()`
 * (`adapterId@version`), `createBoundSourceRegistry` THROWS synchronously at
 * CONSTRUCTION — before any evidence collection, which is the downstream
 * AIC-101 acceptance line this slice exists to satisfy: "An incompatible
 * adapter version is refused before evidence collection."
 *
 * Design pinned here (AIC-98 owner-approved plan, slice a):
 *   - A mismatch throws at construction. The message names the binding's
 *     `sourceBindingId`, the expected `adapterId@version` and the actual one.
 *   - Neither `check()` nor `execute()` of ANY bound source is ever called —
 *     not just the mismatched one — because construction never completes.
 *     Pinned with call counters on fake sources, mirroring
 *     test/bound-source-registry.test.mjs's own `buildRefusingToBeCalledSource`
 *     convention (a source whose execute()/check() firing at all is the
 *     failure). `describe()` IS expected to be called (construction needs it
 *     to know the actual adapter@version to compare and to report), so it is
 *     deliberately not asserted to be zero.
 *   - When `expectedAdapter` matches, or is OMITTED, construction succeeds —
 *     the omitted case is what keeps every pre-AIC-98 binding working
 *     unchanged, since this field is additive.
 *
 * This file's rows never import or exercise `createLabEvidenceSource`
 * (test/lab-evidence-source.test.mjs's own concern) — the handshake is a
 * property of `createBoundSourceRegistry` itself, independent of which
 * adapter is bound.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import * as tools from '@aic/tools';

/* -------------------------------------------------------------------------- */
/* Export factory                                                             */
/* -------------------------------------------------------------------------- */

function createBoundSourceRegistryFactory() {
  assert.equal(
    typeof tools.createBoundSourceRegistry,
    'function',
    '@aic/tools must export createBoundSourceRegistry({ mode, bindings, store, clock })',
  );
  return tools.createBoundSourceRegistry;
}

/* -------------------------------------------------------------------------- */
/* Fixture source with call counters — describe() calls are NOT pinned to     */
/* zero (construction legitimately needs to read it); check()/execute() are.  */
/* -------------------------------------------------------------------------- */

const PLACEHOLDER_PROVENANCE = Object.freeze({
  sourceBindingId: '',
  adapter: '',
  credentialRefId: null,
  fetchedAt: '',
  requestFingerprint: '',
});

function buildCountingSource({ adapterId, version, operations = ['deployments'] }) {
  const calls = { describe: 0, check: 0, execute: 0 };
  return {
    calls,
    describe: () => {
      calls.describe += 1;
      return { adapterId, version, operations };
    },
    check: async () => {
      calls.check += 1;
      return { status: 'ready' };
    },
    execute: async () => {
      calls.execute += 1;
      return { status: 'ok', output: {}, provenance: PLACEHOLDER_PROVENANCE };
    },
  };
}

function buildRegistryOptions(bindings) {
  return {
    mode: 'live',
    bindings,
    store: tools.createMemoryReplayStore(),
    clock: () => new Date('2026-09-24T00:00:00.000Z'),
  };
}

/* -------------------------------------------------------------------------- */
/* Mismatch — refuses construction                                            */
/* -------------------------------------------------------------------------- */

test('refuses construction when a binding\'s expectedAdapter names a different adapter@version than describe() reports (compatibility handshake, AIC-98 slice a)', () => {
  const createBoundSourceRegistry = createBoundSourceRegistryFactory();
  const source = buildCountingSource({ adapterId: 'lab', version: '1' });
  const binding = {
    sourceBindingId: 'incident-lab',
    source,
    credentialRefId: null,
    expectedAdapter: 'lab@2',
  };

  assert.throws(
    () => createBoundSourceRegistry(buildRegistryOptions([binding])),
    (error) => {
      assert.ok(error instanceof Error, 'the handshake mismatch must throw an Error');
      assert.match(error.message, /incident-lab/, 'the message must name the sourceBindingId');
      assert.match(error.message, /lab@2/, 'the message must name the EXPECTED adapter@version');
      assert.match(error.message, /lab@1/, 'the message must name the ACTUAL adapter@version');
      return true;
    },
    'createBoundSourceRegistry must throw synchronously when expectedAdapter mismatches describe()',
  );

  assert.equal(source.calls.check, 0, 'a version-mismatched binding must never have its check() called');
  assert.equal(source.calls.execute, 0, 'a version-mismatched binding must never have its execute() called');
});

test('an adapterId mismatch (not just a version mismatch) also refuses construction, naming both the expected and actual adapter@version', () => {
  const createBoundSourceRegistry = createBoundSourceRegistryFactory();
  const source = buildCountingSource({ adapterId: 'lab', version: '1' });
  const binding = {
    sourceBindingId: 'incident-lab',
    source,
    credentialRefId: null,
    expectedAdapter: 'github@1',
  };

  assert.throws(
    () => createBoundSourceRegistry(buildRegistryOptions([binding])),
    (error) => {
      assert.match(error.message, /github@1/);
      assert.match(error.message, /lab@1/);
      return true;
    },
  );

  assert.equal(source.calls.check, 0);
  assert.equal(source.calls.execute, 0);
});

test('a single mismatched binding refuses construction of the WHOLE registry — no other binding\'s check()/execute() runs either', () => {
  const createBoundSourceRegistry = createBoundSourceRegistryFactory();
  const badSource = buildCountingSource({ adapterId: 'lab', version: '1' });
  const goodSource = buildCountingSource({ adapterId: 'github', version: '1' });
  const badBinding = {
    sourceBindingId: 'incident-lab',
    source: badSource,
    credentialRefId: null,
    expectedAdapter: 'lab@2',
  };
  const goodBinding = {
    sourceBindingId: 'github-source',
    source: goodSource,
    credentialRefId: null,
    expectedAdapter: 'github@1',
  };

  assert.throws(() => createBoundSourceRegistry(buildRegistryOptions([goodBinding, badBinding])));

  assert.equal(goodSource.calls.check, 0, 'a sibling binding that would have matched must still never be called');
  assert.equal(goodSource.calls.execute, 0, 'a sibling binding that would have matched must still never be called');
  assert.equal(badSource.calls.check, 0);
  assert.equal(badSource.calls.execute, 0);
});

/* -------------------------------------------------------------------------- */
/* Match, or absent — construction succeeds                                   */
/* -------------------------------------------------------------------------- */

test('constructs successfully when expectedAdapter matches describe()\'s own adapterId@version', () => {
  const createBoundSourceRegistry = createBoundSourceRegistryFactory();
  const source = buildCountingSource({ adapterId: 'lab', version: '1' });
  const binding = {
    sourceBindingId: 'incident-lab',
    source,
    credentialRefId: null,
    expectedAdapter: 'lab@1',
  };

  assert.doesNotThrow(() => createBoundSourceRegistry(buildRegistryOptions([binding])));
});

test('constructs successfully when expectedAdapter is absent, keeping every pre-AIC-98 binding working unchanged (the field is additive)', () => {
  const createBoundSourceRegistry = createBoundSourceRegistryFactory();
  const source = buildCountingSource({ adapterId: 'lab', version: '1' });
  const binding = {
    sourceBindingId: 'incident-lab',
    source,
    credentialRefId: null,
  };

  assert.doesNotThrow(() => createBoundSourceRegistry(buildRegistryOptions([binding])));
});
