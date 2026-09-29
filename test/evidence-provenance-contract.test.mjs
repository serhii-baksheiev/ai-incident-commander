/**
 * AIC-146, slice a: "Evidence provenance" — every `Evidence` produced from a
 * bound source carries `{ sourceBindingId, adapter, credentialRefId,
 * fetchedAt, requestFingerprint }` (the five fields
 * `docs/decisions/integration-boundary.md`'s "Trust boundary" names), a
 * credential's VALUE is never stored, and existing replay evidence — which
 * carries no provenance at all — keeps parsing. Slices (b) (the bound-source
 * port) and (c) (`aic incident investigate`) are separate tickets and are not
 * touched here.
 *
 * This file pins three things:
 *
 *   - `@aic/domain` exports `EvidenceProvenanceSchema` (`z.strictObject`):
 *     `sourceBindingId` a UUID, `adapter` a single `<adapterId>@<adapterVersion>`
 *     string with a non-empty, at-most-200-character token on each side of
 *     the one `@` (the same length bound `SourceBindingSchema.adapterId` /
 *     `.adapterVersion` already carry, `packages/domain/src/scope.ts`),
 *     `credentialRefId` a UUID or `null` (present either way — never
 *     omitted), `fetchedAt` an ISO-8601 UTC datetime string, and
 *     `requestFingerprint` matching `/^sha256:[0-9a-f]{64}$/`. Unknown keys
 *     are refused, and no field ever carries a secret's own value or name.
 *   - `EvidenceSchema` accepts an optional `provenance: EvidenceProvenanceSchema`.
 *     Evidence with no `provenance` at all keeps parsing (existing replay
 *     evidence carries none), Evidence with a well-formed `provenance`
 *     parses, and Evidence whose `provenance` is malformed in any of the ways
 *     above is refused.
 *   - `@aic/domain`'s `EvidenceProvenance` type and `@aic/tools`'s
 *     `EvidenceSourceProvenance` type (`packages/tools/src/evidence-source.ts`)
 *     are the same shape — pinned as a compile-time row in
 *     `test/fixtures/evidence-provenance-type-contract.ts` — and a real
 *     `BoundSourceRegistry` call's `provenance` parses with
 *     `EvidenceProvenanceSchema` and matches a hand-built expected object
 *     (independent oracle: the fingerprint is computed here with
 *     `node:crypto` over the pinned canonical envelope, the same way
 *     `test/evidence-source-contract.test.mjs` and
 *     `test/bound-source-registry.test.mjs` do it, never by calling
 *     `createRequestFingerprint` from this file).
 *
 * `packages/persistence/src/retention.ts`'s `readRunProductSnapshot` also
 * re-parses stored evidence with `EvidenceSchema`, but every existing caller
 * of it — `test/durable-run-boundaries.test.mjs`,
 * `infra/postgres/tests/durable-run-retention.live.mjs` — drives it through a
 * real `pg.Pool`; there is no existing non-live seam that hands it a fake
 * pool, so this file adds no row for it.
 *
 * Every `credentialRefId`/`sourceBindingId` fixture below that is not `null`
 * is built with `randomUUID()`, never a literal UUID string, for the same
 * reason `test/scoped-domain-contract.test.mjs`'s header gives: `secretName`
 * (and here, `credentialRefId`) contains the keyword `credential`, and
 * `.claude/scripts/lib/secrets.mjs`'s `assigned-secret` pattern reads a
 * credential keyword next to a long assigned value — a hand-typed UUID would
 * be indistinguishable, to that scanner, from an assigned credential.
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
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
  'test/fixtures/evidence-provenance-type-contract.ts',
);

const fixtureFingerprint = `sha256:${'0'.repeat(64)}`;

function validProvenance(overrides = {}) {
  return {
    sourceBindingId: randomUUID(),
    adapter: 'lab@1',
    credentialRefId: null,
    fetchedAt: '2026-09-24T00:00:00.000Z',
    requestFingerprint: fixtureFingerprint,
    ...overrides,
  };
}

function withoutCredentialRefId() {
  const { credentialRefId, ...rest } = validProvenance();
  void credentialRefId;
  return rest;
}

function baseEvidence(overrides = {}) {
  return {
    id: 'evidence-1',
    trialId: 'trial-1',
    kind: 'log',
    source: 'checkout-logs',
    observedAt: '2026-08-27T12:00:00.000Z',
    statement: 'checkout returned 500',
    rawRef: 'fixture://logs/checkout/1',
    ...overrides,
  };
}

/* -------------------------------------------------------------------------- */
/* EvidenceProvenanceSchema — the five-field shape                            */
/* -------------------------------------------------------------------------- */

test('EvidenceProvenanceSchema accepts a fully well-formed provenance envelope', () => {
  assert.equal(domain.EvidenceProvenanceSchema.safeParse(validProvenance()).success, true);
});

test('EvidenceProvenanceSchema accepts a null credentialRefId (a credential-less binding such as lab@1)', () => {
  assert.equal(
    domain.EvidenceProvenanceSchema.safeParse(validProvenance({ credentialRefId: null })).success,
    true,
  );
});

test('EvidenceProvenanceSchema accepts a UUID credentialRefId', () => {
  assert.equal(
    domain.EvidenceProvenanceSchema.safeParse(validProvenance({ credentialRefId: randomUUID() })).success,
    true,
  );
});

test('EvidenceProvenanceSchema refuses an unknown key (no field for a secret value or name)', () => {
  assert.equal(
    domain.EvidenceProvenanceSchema.safeParse({ ...validProvenance(), secretValue: 'unused-fixture' }).success,
    false,
  );
});

test('EvidenceProvenanceSchema refuses a sourceBindingId that is not a UUID', () => {
  assert.equal(
    domain.EvidenceProvenanceSchema.safeParse(validProvenance({ sourceBindingId: 'binding-a' })).success,
    false,
  );
});

test('EvidenceProvenanceSchema refuses an adapter with no @ at all', () => {
  assert.equal(domain.EvidenceProvenanceSchema.safeParse(validProvenance({ adapter: 'lab1' })).success, false);
});

test('EvidenceProvenanceSchema refuses an adapter with two @ characters', () => {
  assert.equal(
    domain.EvidenceProvenanceSchema.safeParse(validProvenance({ adapter: 'lab@1@extra' })).success,
    false,
  );
});

test('EvidenceProvenanceSchema refuses an adapter with an empty adapterId side', () => {
  assert.equal(domain.EvidenceProvenanceSchema.safeParse(validProvenance({ adapter: '@1' })).success, false);
});

test('EvidenceProvenanceSchema refuses an adapter with an empty adapterVersion side', () => {
  assert.equal(domain.EvidenceProvenanceSchema.safeParse(validProvenance({ adapter: 'lab@' })).success, false);
});

test('EvidenceProvenanceSchema refuses an adapter whose adapterId side is 201 characters, one past SourceBindingSchema.adapterId\'s own bound', () => {
  assert.equal(
    domain.EvidenceProvenanceSchema.safeParse(validProvenance({ adapter: `${'a'.repeat(201)}@1` })).success,
    false,
  );
});

test('EvidenceProvenanceSchema refuses an adapter whose adapterVersion side is 201 characters, one past SourceBindingSchema.adapterVersion\'s own bound', () => {
  assert.equal(
    domain.EvidenceProvenanceSchema.safeParse(validProvenance({ adapter: `lab@${'1'.repeat(201)}` })).success,
    false,
  );
});

test('EvidenceProvenanceSchema refuses a credentialRefId that is neither null nor a UUID', () => {
  assert.equal(
    domain.EvidenceProvenanceSchema.safeParse(validProvenance({ credentialRefId: 'not-a-uuid' })).success,
    false,
  );
});

test('EvidenceProvenanceSchema refuses an envelope with credentialRefId missing entirely, rather than present and null', () => {
  assert.equal(domain.EvidenceProvenanceSchema.safeParse(withoutCredentialRefId()).success, false);
});

test('EvidenceProvenanceSchema refuses a fetchedAt carrying a non-UTC offset', () => {
  assert.equal(
    domain.EvidenceProvenanceSchema.safeParse(
      validProvenance({ fetchedAt: '2026-09-24T00:00:00.000+01:00' }),
    ).success,
    false,
  );
});

test('EvidenceProvenanceSchema refuses a fetchedAt that is not a datetime at all', () => {
  assert.equal(
    domain.EvidenceProvenanceSchema.safeParse(validProvenance({ fetchedAt: 'not-a-date' })).success,
    false,
  );
});

test('EvidenceProvenanceSchema refuses a requestFingerprint missing the sha256: prefix', () => {
  assert.equal(
    domain.EvidenceProvenanceSchema.safeParse(validProvenance({ requestFingerprint: '0'.repeat(64) })).success,
    false,
  );
});

test('EvidenceProvenanceSchema refuses a requestFingerprint carrying uppercase hex', () => {
  assert.equal(
    domain.EvidenceProvenanceSchema.safeParse(
      validProvenance({ requestFingerprint: `sha256:${'A'.repeat(64)}` }),
    ).success,
    false,
  );
});

test('EvidenceProvenanceSchema refuses a requestFingerprint one character short of 64 hex characters', () => {
  assert.equal(
    domain.EvidenceProvenanceSchema.safeParse(
      validProvenance({ requestFingerprint: `sha256:${'0'.repeat(63)}` }),
    ).success,
    false,
  );
});

/* -------------------------------------------------------------------------- */
/* EvidenceSchema — optional provenance, and the compatibility row            */
/* -------------------------------------------------------------------------- */

test('EvidenceSchema accepts Evidence with no provenance field, because existing replay evidence carries none', () => {
  assert.equal(domain.EvidenceSchema.safeParse(baseEvidence()).success, true);
});

test('EvidenceSchema accepts Evidence carrying a well-formed provenance envelope', () => {
  assert.equal(domain.EvidenceSchema.safeParse(baseEvidence({ provenance: validProvenance() })).success, true);
});

test('EvidenceSchema refuses Evidence whose provenance carries an unknown key', () => {
  assert.equal(
    domain.EvidenceSchema.safeParse(
      baseEvidence({ provenance: { ...validProvenance(), secretValue: 'unused-fixture' } }),
    ).success,
    false,
  );
});

test('EvidenceSchema refuses Evidence whose provenance.sourceBindingId is not a UUID', () => {
  assert.equal(
    domain.EvidenceSchema.safeParse(
      baseEvidence({ provenance: validProvenance({ sourceBindingId: 'binding-a' }) }),
    ).success,
    false,
  );
});

test('EvidenceSchema refuses Evidence whose provenance.adapter has no @', () => {
  assert.equal(
    domain.EvidenceSchema.safeParse(baseEvidence({ provenance: validProvenance({ adapter: 'lab1' }) })).success,
    false,
  );
});

test('EvidenceSchema refuses Evidence whose provenance.fetchedAt is not an ISO-8601 UTC datetime', () => {
  assert.equal(
    domain.EvidenceSchema.safeParse(
      baseEvidence({ provenance: validProvenance({ fetchedAt: 'not-a-date' }) }),
    ).success,
    false,
  );
});

test('EvidenceSchema refuses Evidence whose provenance.requestFingerprint does not match sha256:<64 hex>', () => {
  assert.equal(
    domain.EvidenceSchema.safeParse(
      baseEvidence({ provenance: validProvenance({ requestFingerprint: 'not-a-fingerprint' }) }),
    ).success,
    false,
  );
});

test('EvidenceSchema refuses Evidence whose provenance.credentialRefId is missing entirely, rather than present and null', () => {
  assert.equal(
    domain.EvidenceSchema.safeParse(baseEvidence({ provenance: withoutCredentialRefId() })).success,
    false,
  );
});

/* -------------------------------------------------------------------------- */
/* Type contract — @aic/domain's EvidenceProvenance is @aic/tools's           */
/* EvidenceSourceProvenance, one spelling                                     */
/* -------------------------------------------------------------------------- */

test('compiles the evidence-provenance type contract: @aic/domain EvidenceProvenance and @aic/tools EvidenceSourceProvenance are mutually assignable, and an extra key is refused on both', () => {
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
    {
      cwd: projectRoot,
      encoding: 'utf8',
      env: childEnv(),
    },
  );

  assert.equal(
    result.status,
    0,
    `type-contract compile exited ${result.status}\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}\n\n@aic/domain must export an EvidenceProvenance type identical in shape to @aic/tools's EvidenceSourceProvenance — see test/fixtures/evidence-provenance-type-contract.ts`,
  );
});

/* -------------------------------------------------------------------------- */
/* Independent oracle — a real BoundSourceRegistry call's own provenance      */
/* -------------------------------------------------------------------------- */

/**
 * Hand-built, exactly `test/bound-source-registry.test.mjs`'s own
 * `handBuiltFingerprint` — a second, independent encoding of the pinned
 * canonical envelope, never a call into `createRequestFingerprint` or
 * `canonicalJson`, and only valid for an `input` whose own keys are already
 * alphabetically sorted (the single flat key used below is).
 */
function handBuiltFingerprint(operation, input) {
  const envelope = `{"input":${JSON.stringify(input)},"operation":${JSON.stringify(operation)}}`;
  const hex = createHash('sha256').update(envelope).digest('hex');
  return `sha256:${hex}`;
}

function buildLabOkSource() {
  return {
    describe: () => ({ adapterId: 'lab', version: '1', operations: ['fetch-logs'] }),
    check: async () => ({ status: 'ready' }),
    execute: async () => ({
      status: 'ok',
      output: { lines: ['fixture output'] },
      // Deliberately foreign provenance: BoundSourceRegistry is the single
      // writer of provenance and must overwrite this entirely.
      provenance: {
        sourceBindingId: 'not-the-real-binding',
        adapter: 'not-the-real-adapter@0.0.0',
        credentialRefId: 'wrongcredentialplaceholder',
        fetchedAt: '1970-01-01T00:00:00.000Z',
        requestFingerprint: 'sha256:not-the-real-fingerprint',
      },
    }),
  };
}

test('a real BoundSourceRegistry live-mode outcome\'s provenance parses with EvidenceProvenanceSchema and matches a hand-built expected object', async () => {
  const sourceBindingId = randomUUID();
  const registry = tools.createBoundSourceRegistry({
    mode: 'live',
    bindings: [{ sourceBindingId, source: buildLabOkSource(), credentialRefId: null }],
    store: tools.createMemoryReplayStore(),
    clock: () => new Date('2026-09-24T00:00:00.000Z'),
  });

  const outcome = await registry.execute(sourceBindingId, 'fetch-logs', {
    service: 'checkout',
  });

  assert.equal(outcome.status, 'ok');
  assert.equal(domain.EvidenceProvenanceSchema.safeParse(outcome.provenance).success, true);
  assert.deepEqual(outcome.provenance, {
    sourceBindingId,
    adapter: 'lab@1',
    credentialRefId: null,
    fetchedAt: '2026-09-24T00:00:00.000Z',
    requestFingerprint: handBuiltFingerprint('fetch-logs', { service: 'checkout' }),
  });
});
