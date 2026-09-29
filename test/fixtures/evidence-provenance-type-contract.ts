/**
 * AIC-146, slice a: one spelling of the provenance shape, checked from both
 * sides. `@aic/tools`'s `EvidenceSourceProvenance` (`packages/tools/src/evidence-source.ts`)
 * is the interface a `BoundSourceRegistry` call already fills; `@aic/domain`'s
 * `EvidenceProvenance` is the same shape read back through the validated
 * contract an `Evidence` carries. A value typed against either interface must
 * satisfy the other, or the two packages are silently describing two
 * different things under one name (`.claude/rules/invariants.md`, "one
 * mechanism, one implementation").
 *
 * A real value, not a `declare`: like its sibling fixtures, `test/fixtures`
 * is swept by node's default test-file discovery, so this file is also
 * EXECUTED with its types stripped — every binding below must be valid plain
 * JavaScript too. No `node:` import here (unlike this ticket's `.test.mjs`
 * file): every sibling `*-type-contract.ts` fixture is compiled standalone,
 * `--ignoreConfig`, with no `@types/node` in scope, so a UUID fixture is
 * assembled from string literals into a plain identifier instead.
 */
import type { EvidenceProvenance } from '@aic/domain';
import type { EvidenceSourceProvenance } from '@aic/tools';

function acceptsSourceProvenance(value: EvidenceSourceProvenance): void {
  void value;
}

function acceptsDomainProvenance(value: EvidenceProvenance): void {
  void value;
}

const fixtureBindingId = ['11111111', '1111', '4111', '8111', '111111111111'].join('-');
const fixtureCredentialRefId = ['33333333', '3333', '4333', '8333', '333333333333'].join('-');
const fixtureFingerprint = `sha256:${'0'.repeat(64)}`;

// Built and typed against the DOMAIN interface, then handed to a function
// that only accepts the TOOLS interface: this compiles only if the two are
// the same shape.
const domainProvenance: EvidenceProvenance = {
  sourceBindingId: fixtureBindingId,
  adapter: 'lab@1',
  credentialRefId: null,
  fetchedAt: '2026-09-24T00:00:00.000Z',
  requestFingerprint: fixtureFingerprint,
};
acceptsSourceProvenance(domainProvenance);

// The mirror image: built and typed against the TOOLS interface, handed to a
// function that only accepts the DOMAIN interface.
const toolsProvenance: EvidenceSourceProvenance = {
  sourceBindingId: fixtureBindingId,
  adapter: 'lab@1',
  credentialRefId: fixtureCredentialRefId,
  fetchedAt: '2026-09-24T00:00:00.000Z',
  requestFingerprint: fixtureFingerprint,
};
acceptsDomainProvenance(toolsProvenance);

// Not vacuous: an extra key is refused by BOTH interfaces, or a widened
// object would satisfy this whole file for the wrong reason. Neither
// interface carries a field for a secret's own value or name.
// @ts-expect-error EvidenceProvenance carries no field for a secret value or name
const domainWithExtraKey: EvidenceProvenance = {
  sourceBindingId: fixtureBindingId,
  adapter: 'lab@1',
  credentialRefId: null,
  fetchedAt: '2026-09-24T00:00:00.000Z',
  requestFingerprint: fixtureFingerprint,
  secretValue: 'unused-fixture',
};
void domainWithExtraKey;

// @ts-expect-error EvidenceSourceProvenance carries no field for a secret value or name
const toolsWithExtraKey: EvidenceSourceProvenance = {
  sourceBindingId: fixtureBindingId,
  adapter: 'lab@1',
  credentialRefId: null,
  fetchedAt: '2026-09-24T00:00:00.000Z',
  requestFingerprint: fixtureFingerprint,
  secretValue: 'unused-fixture',
};
void toolsWithExtraKey;

void acceptsSourceProvenance;
void acceptsDomainProvenance;
