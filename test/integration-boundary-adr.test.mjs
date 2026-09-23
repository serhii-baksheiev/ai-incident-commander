import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import test from 'node:test';

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
