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
 *     string whose sides match `ADAPTER_ID_PATTERN` / `ADAPTER_VERSION_PATTERN`
 *     (the AIC-146 b1 rows below), `credentialRefId` a UUID or `null`
 *     (present either way — never omitted), `fetchedAt` an ISO-8601 UTC
 *     datetime with exactly three fractional digits, and
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

test('EvidenceProvenanceSchema refuses an adapter whose adapterId side is 201 characters, past SourceBindingSchema.adapterId\'s 200 as well as the 64-character adapter spelling', () => {
  assert.equal(
    domain.EvidenceProvenanceSchema.safeParse(validProvenance({ adapter: `${'a'.repeat(201)}@1` })).success,
    false,
  );
});

test('EvidenceProvenanceSchema refuses an adapter whose adapterVersion side is 201 characters, past SourceBindingSchema.adapterVersion\'s 200 as well as the 64-character adapter spelling', () => {
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

/* -------------------------------------------------------------------------- */
/* AIC-146 slice b1 — the domain owns the adapter spelling                    */
/*                                                                            */
/* `ADAPTER_ID_PATTERN` / `ADAPTER_VERSION_PATTERN` are the spelling          */
/* `BoundSourceRegistry` checks `describe()` against (an alphanumeric first   */
/* character, up to 64 characters, `:` allowed only in the id), and           */
/* `EvidenceProvenanceSchema.adapter` is built from them. The registry's own  */
/* `SAFE_ADAPTER_ID` / `SAFE_ADAPTER_TOKEN` are these objects — pinned as     */
/* object identity in bound-source-registry.test.mjs › "SAFE_ADAPTER_ID and   */
/* SAFE_ADAPTER_TOKEN are @aic/domain's own ADAPTER_ID_PATTERN /              */
/* ADAPTER_VERSION_PATTERN objects, not a second, possibly-diverging copy of  */
/* the same spelling (AIC-146 b1)".                                           */
/*                                                                            */
/* Independent oracle: every row below is a hand-written string with its     */
/* expected verdict, never an expectation computed from the exports.         */
/* -------------------------------------------------------------------------- */

test('ADAPTER_ID_PATTERN and ADAPTER_VERSION_PATTERN are each anchored at both ends and carry no top-level alternation, which the composed adapter field relies on (AIC-146 b1)', () => {
  for (const pattern of [domain.ADAPTER_ID_PATTERN, domain.ADAPTER_VERSION_PATTERN]) {
    const { source, flags } = pattern;
    assert.equal(source.startsWith('^') && source.endsWith('$'), true, `${source} must be anchored at both ends`);
    assert.equal(flags, '', `${source} must carry no flags`);
    let depth = 0;
    for (const char of source.replace(/\\./g, '')) {
      if (char === '(' || char === '[') depth += 1;
      else if (char === ')' || char === ']') depth -= 1;
      else if (char === '|' && depth === 0) assert.fail(`${source} must carry no top-level alternation`);
    }
  }
});

test('EvidenceProvenanceSchema accepts a fetchedAt with exactly three fractional digits and refuses any other count, none included (AIC-146 b1)', () => {
  assert.equal(domain.EvidenceProvenanceSchema.safeParse(validProvenance({ fetchedAt: '2026-09-24T00:00:00.000Z' })).success, true);
  for (const fetchedAt of [
    '2026-09-24T00:00:00Z',
    '2026-09-24T00:00:00.00Z',
    '2026-09-24T00:00:00.0000Z',
    `2026-09-24T00:00:00.${'0'.repeat(10000)}Z`,
  ]) {
    assert.equal(
      domain.EvidenceProvenanceSchema.safeParse(validProvenance({ fetchedAt })).success,
      false,
      `${fetchedAt.slice(0, 30)} must be refused: fetchedAt is the toISOString() form the registry writes, three fractional digits, so a stored recording can neither grow it nor carry another precision`,
    );
  }
});

test('@aic/domain exports ADAPTER_ID_PATTERN and ADAPTER_VERSION_PATTERN as RegExp objects (AIC-146 b1)', () => {
  assert.equal(
    domain.ADAPTER_ID_PATTERN instanceof RegExp,
    true,
    '@aic/domain must export ADAPTER_ID_PATTERN: RegExp, the safe-token pattern an adapter\'s adapterId side must match (moved here from packages/tools/src/bound-source-registry.ts\'s SAFE_ADAPTER_ID)',
  );
  assert.equal(
    domain.ADAPTER_VERSION_PATTERN instanceof RegExp,
    true,
    '@aic/domain must export ADAPTER_VERSION_PATTERN: RegExp, the safe-token pattern an adapter\'s version side must match (moved here from packages/tools/src/bound-source-registry.ts\'s SAFE_ADAPTER_TOKEN)',
  );
});

test('EvidenceProvenanceSchema refuses an adapter whose adapterId side is 65 characters, one character past the 64-character adapter spelling (AIC-146 b1)', () => {
  const adapter = `${'a'.repeat(65)}@1`;
  assert.equal(
    domain.EvidenceProvenanceSchema.safeParse(validProvenance({ adapter })).success,
    false,
    `${JSON.stringify(adapter)} must be refused once the domain owns the registry's own adapterId spelling (65 characters is one past SAFE_ADAPTER_ID's 64-character bound)`,
  );
});

/**
 * Hand-written accept/refuse table for `EvidenceProvenanceSchema.adapter`,
 * decided directly from the registry's own two patterns (an alphanumeric
 * first character; `SAFE_ADAPTER_ID` additionally allows `:` in the
 * adapterId side; `SAFE_ADAPTER_TOKEN` never allows `:` in the version
 * side; neither allows a leading space or any other punctuation outside
 * `._:-`), never by calling `ADAPTER_ID_PATTERN`/`ADAPTER_VERSION_PATTERN`
 * to compute the expectation.
 */
const ADAPTER_SPELLING_ROWS = [
  { adapter: 'lab@1', expected: true, why: 'an ordinary one-character id and version, exactly what the registry produces for lab@1' },
  { adapter: 'lab@v:1', expected: false, why: 'the version side "v:1" carries a colon, which SAFE_ADAPTER_TOKEN never allows' },
  { adapter: ' lab@1', expected: false, why: 'the adapterId side starts with a space, not an alphanumeric first character' },
  { adapter: 'lab@-1', expected: false, why: 'the version side starts with "-", not an alphanumeric first character' },
  { adapter: 'b:c@1', expected: true, why: 'a colon inside the adapterId side is exactly what SAFE_ADAPTER_ID\'s colon-collision design allows' },
];

for (const { adapter, expected, why } of ADAPTER_SPELLING_ROWS) {
  test(`EvidenceProvenanceSchema ${expected ? 'accepts' : 'refuses'} adapter ${JSON.stringify(adapter)} (AIC-146 b1: ${why})`, () => {
    assert.equal(domain.EvidenceProvenanceSchema.safeParse(validProvenance({ adapter })).success, expected);
  });
}
