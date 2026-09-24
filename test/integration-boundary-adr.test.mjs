import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import test from 'node:test';

import * as domain from '@aic/domain';

const projectRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const adrPath = join(projectRoot, 'docs', 'decisions', 'integration-boundary.md');
const readAdr = () => readFileSync(adrPath, 'utf8');

/** The text under one `## ` heading, up to the next `## ` heading. */
const section = (markdown, heading) => {
  const start = markdown.indexOf(`\n## ${heading}\n`);
  assert.notEqual(start, -1, `the ADR must carry a "## ${heading}" section`);
  const rest = markdown.slice(start + heading.length + 5);
  const end = rest.search(/\n## /);
  return end === -1 ? rest : rest.slice(0, end);
};

/**
 * AIC-97 acceptance, pinned on the document rather than on memory of it.
 *
 * The ADR is what AIC-96 (domain), AIC-100 (source adapters), AIC-99 (CLI) and
 * AIC-21/AIC-25 (Safe Operations) are built against, so the decisions it must
 * record are checked here as present, not paraphrased back.
 */
test('records every decision AIC-97 lists, each under the Decisions section', () => {
  const decisions = section(readAdr(), 'Decisions');
  for (const [decision, pattern] of [
    ['AIC is a standalone service', /standalone service/i],
    ['the registered unit is Service × Environment', /Service\s*×\s*Environment/],
    ['one primaryScope per Incident in v0.3', /primaryScope\s*\{\s*serviceId,\s*environmentId\s*\}/],
    ['a repository is an alias or source, not identity', /repositor(y|ies)[^.]*\b(alias|source)\b[^.]*not[^.]*identity/i],
    ['AIC storage is the source of truth, YAML an idempotent import', /source of truth[\s\S]*?idempotent import/i],
    ['nothing is installed in the consumer repository', /consumer repositor/i],
    ['embedded mode is rejected', /embedded[^.]*rejected/i],
    ['a stateless connector is deferred behind named triggers', /connector[^.]*deferred/i],
    ['workspace stays an implicit singleton until v1.0', /implicit singleton[^.]*v1\.0/i],
    ['no SaaS, onboarding UI, discovery or multi-service incident in v0.3', /SaaS[\s\S]*?onboarding UI[\s\S]*?discovery[\s\S]*?multi-service/i],
  ]) {
    assert.match(decisions, pattern, `the Decisions section must record: ${decision}`);
  }
});

test('makes ownership, the trust boundary, removal semantics and the connector triggers explicit, each with its substance', () => {
  const adr = readAdr();
  for (const heading of ['Ownership', 'Trust boundary', 'Removal semantics', 'Connector triggers']) {
    const body = section(adr, heading).trim();
    assert.ok(body.length > 0, `"## ${heading}" must not be empty`);
  }

  const ownership = section(adr, 'Ownership');
  for (const [row, pattern] of [
    ['an Environment belongs to exactly one Service', /\|\s*Environment\s*\|\s*exactly one Service\s*\|/],
    ['a SourceBinding belongs to exactly one Environment', /\|\s*SourceBinding\s*\|\s*exactly one Environment\s*\|/],
    ['a CredentialRef belongs to exactly one Environment', /\|\s*CredentialRef\s*\|\s*exactly one Environment\s*\|/],
    ['an ActionPolicy belongs to exactly one Environment', /\|\s*ActionPolicy\s*\|\s*exactly one Environment\s*\|/],
  ]) {
    assert.match(ownership, pattern, `the Ownership table must say: ${row}`);
  }

  const trust = section(adr, 'Trust boundary');
  assert.match(trust, /CredentialRef[\s\S]*?reference/i, 'credentials must cross the boundary as references');
  assert.match(trust, /write\s+`?CredentialRef`?\s+distinct from every read/i, 'a write credential must be distinct from every read credential');
  assert.match(trust, /untestable/i, 'an unreachable or refusing source must yield untestable, not negative, evidence');

  const removal = section(adr, 'Removal semantics');
  assert.match(removal, /SourceBindings[\s\S]*?ActionPolicy[\s\S]*?CredentialRefs/, 'removal must name the bindings, the policy and the credential references it removes');
  assert.match(removal, /deletes[\s\S]*?from the active registry/i, 'removal must say the bindings, policy and credential references leave the active registry, not merely change state');
  assert.match(removal, /audit/i, 'removal must say what audits the past is kept');

  const triggers = section(adr, 'Connector triggers');
  for (const trigger of [/network-inaccessible|not reachable|unreachable/i, /push-only/i, /perimeter/i]) {
    assert.match(triggers, trigger, 'each of the three triggers that may introduce a connector must be named');
  }
});

test('states that connector-held state or evidence would break the single-orchestrator boundary', () => {
  assert.match(
    section(readAdr(), 'Connector triggers'),
    /single-orchestrator/i,
    'AIC-97 acceptance 3: the ADR must say that a connector storing state or evidence violates the single-orchestrator boundary',
  );
});

test('names the domain and CLI vocabulary the onboarding contracts use, spelled as they spell it', () => {
  const terminology = section(readAdr(), 'Terminology');
  for (const term of [
    'Service',
    'Environment',
    'SourceBinding',
    'CredentialRef',
    'ActionPolicy',
    'primaryScope',
    'idempotencyKey',
    'aic service add',
    'aic env add',
    'aic source add',
    'aic source check',
    'aic policy set',
    'aic incident start',
  ]) {
    assert.ok(terminology.includes(`\`${term}\``), `the Terminology section must name \`${term}\` exactly as the contracts spell it`);
  }
});

test('is reachable from the architecture document it amends', () => {
  const architecture = readFileSync(join(projectRoot, 'docs', 'incident-commander-architecture-v1.md'), 'utf8');
  assert.match(
    architecture,
    /decisions\/integration-boundary\.md/,
    'a reader of the canonical architecture must be pointed at the decision that bounds v0.3 integration',
  );
});

/**
 * AIC-96, slice A: the ADR is what the scoped domain types (this PR) and the
 * onboarding CLI (AIC-99) are built against, so the sentences that name their
 * shared vocabulary are pinned here too - the doc edits these four checks
 * require land with the implementation, not with this test file.
 */
test("cites the Incident row's idempotencyKey sentence to AIC-96 and AIC-99", () => {
  const ownership = section(readAdr(), 'Ownership');
  assert.match(
    ownership,
    /\|\s*Incident\s*\|[^\n]*idempotencyKey[^\n]*AIC-96[^\n]*AIC-99/,
    'the Incident row must cite both AIC-96 (the schema) and AIC-99 (the CLI that writes it) beside idempotencyKey',
  );
});

test('names aic resume beside aic start as the development-only spike', () => {
  const terminology = section(readAdr(), 'Terminology');
  assert.match(
    terminology,
    /`aic resume`/,
    'the Terminology section must name `aic resume` beside `aic start` as part of the development-only spike AIC-99 moves behind an explicit command',
  );
});

test("leaves revoking a removed CredentialRef's secret to AIC-46, undecided here", () => {
  const removal = section(readAdr(), 'Removal semantics').replace(/\s+/g, ' ').trim();
  assert.match(
    removal,
    /revoking it in the secret backend[^.]*AIC-46 owns, and this record does not decide it\./,
    'Removal semantics must leave revoking the secret to AIC-46 without deciding it here',
  );
});

/**
 * AIC-99 slice b, round-1 review: the CredentialRef ownership row still
 * reads "a SourceBinding refers to one read `CredentialRef`", which the
 * owner's 2026-09-25 ruling supersedes - `credentialRefId` is nullable, for
 * a credential-less adapter (`lab@1`). "at most one read" is the phrase
 * this row pins; the ADR is edited to carry it.
 */
test('the CredentialRef ownership row allows a SourceBinding with no credential (a credential-less adapter, e.g. lab@1)', () => {
  const ownership = section(readAdr(), 'Ownership').replace(/\s+/g, ' ');
  assert.match(
    ownership,
    /a SourceBinding refers to at most one read `?CredentialRef`?/i,
    'the CredentialRef row must say a SourceBinding refers to AT MOST ONE read CredentialRef, so a credential-less binding (AIC-99 slice b) is allowed by the row itself, not merely by omission',
  );
});

/**
 * AIC-99 slice b, round-1 review: the Trust-boundary provenance bullet lists
 * `credentialRefId` among the fields every piece of Evidence must record,
 * without saying what a credential-less SourceBinding (`lab@1`) records
 * there.
 */
test('the Trust-boundary provenance bullet says credentialRefId is null for a credential-less SourceBinding', () => {
  const trust = section(readAdr(), 'Trust boundary').replace(/\s+/g, ' ');
  assert.match(
    trust,
    /`credentialRefId`[^.]*null[^.]*credential-less/i,
    'the provenance bullet must say credentialRefId is null when the SourceBinding is credential-less (AIC-99 slice b)',
  );
});

test('every Terminology type the registry declares is exported by @aic/domain as its Schema', () => {
  for (const schemaName of [
    'ServiceSchema',
    'EnvironmentSchema',
    'SourceBindingSchema',
    'CredentialRefSchema',
    'ActionPolicySchema',
    'PrimaryScopeSchema',
    'IdempotencyKeySchema',
  ]) {
    assert.equal(
      typeof domain[schemaName]?.safeParse,
      'function',
      `@aic/domain must export ${schemaName}, a zod schema, to match the ADR's Terminology table`,
    );
  }
});
