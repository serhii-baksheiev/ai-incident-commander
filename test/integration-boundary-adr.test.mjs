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
 * Owner ruling, Jira AIC-99 comment 20973 (2026-09-25): removing a Service
 * CASCADES through its Environments rather than refusing while one remains —
 * this is the accepted sentence that ruling keeps, pinned here so a future
 * edit back toward refuse-while-non-empty (this file's own round-1 wording,
 * since reverted) goes red instead of silently landing. Nothing above this
 * row pinned the distinction between the two: the older, generic assertions
 * ("names the bindings, the policy and the credential references",
 * "deletes … from the active registry") read as true of either wording.
 */
test('states that removing a Service cascades through all its Environments, not that removal is refused while one remains', () => {
  const removal = section(readAdr(), 'Removal semantics').replace(/\s+/g, ' ').trim();
  assert.match(
    removal,
    /Removing an Environment, or a Service with all its Environments, deletes/,
    'Removal semantics must state the accepted sentence: a Service is removed together with all its Environments, not refused while one remains',
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

/**
 * AIC-21 slice 4: the additive addendum the design's section C names. It is
 * matched by its dated heading text rather than by a fixed section name,
 * because the addendum may extend an existing section (Terminology, Trust
 * boundary) rather than open a new top-level one; the slice of text runs from
 * the addendum's own marker to the next `## ` heading (or end of file).
 */
const addendumText = (markdown) => {
  const start = markdown.indexOf('Addendum (AIC-21,');
  assert.notEqual(start, -1, 'the ADR must carry a dated "Addendum (AIC-21, <date>)" addendum for the risk registry and ProposedAction (slice 4)');
  const rest = markdown.slice(start);
  const end = rest.slice(1).search(/\n## /);
  return end === -1 ? rest : rest.slice(0, end + 1);
};

/**
 * Parses every `| … | … |` row of a GitHub-flavoured markdown table out of a
 * text fragment, dropping the header row (first cell literally "id", any
 * case) and the `---` separator row. Cells are trimmed; a blank cell or a
 * lone `—`/`-` placeholder (used where a tool entry has no blast radius)
 * normalizes to `undefined` so it compares equal to a domain entry that
 * simply has no `minimumBlastRadius` field.
 */
function parseRegistryTable(text) {
  const rows = [];
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed.startsWith('|') || !trimmed.endsWith('|')) continue;
    const cells = trimmed
      .slice(1, -1)
      .split('|')
      .map((cell) => cell.trim());
    if (cells.every((cell) => /^:?-+:?$/.test(cell))) continue; // the header separator row
    if (cells[0].toLowerCase() === 'id') continue; // the header row
    const [id, kind, risk, blastRaw] = cells;
    const minimumBlastRadius = blastRaw === '' || blastRaw === '—' || blastRaw === '-' ? undefined : blastRaw;
    rows.push({ id, kind, risk, minimumBlastRadius });
  }
  return rows;
}

/**
 * Row 1 (AIC-21 slice 4 design, section C): the addendum's registry table and
 * `@aic/domain`'s `RISK_REGISTRY.entries` name the same rows, both ways. The
 * table is read from the doc text; the entries come from the built domain
 * package — two independently authored sources, neither derived from the
 * other, compared against each other rather than one checking its own work.
 */
test("the addendum's registry table and @aic/domain's RISK_REGISTRY.entries name the same rows, both ways", () => {
  const rows = parseRegistryTable(addendumText(readAdr()));
  assert.ok(rows.length > 0, 'the addendum must carry a markdown table with at least one registry row');

  const rowsById = new Map();
  for (const row of rows) {
    assert.ok(!rowsById.has(row.id), `the addendum's registry table names id "${row.id}" more than once`);
    rowsById.set(row.id, row);
  }

  for (const entry of domain.RISK_REGISTRY.entries) {
    const row = rowsById.get(entry.id);
    assert.ok(row, `RISK_REGISTRY entry "${entry.id}" (kind ${entry.kind}) has no row in the addendum's registry table`);
    assert.equal(row.kind, entry.kind, `the addendum's row for "${entry.id}" names kind "${row.kind}", RISK_REGISTRY says "${entry.kind}"`);
    assert.equal(row.risk, entry.risk, `the addendum's row for "${entry.id}" names risk "${row.risk}", RISK_REGISTRY says "${entry.risk}"`);
    assert.equal(
      row.minimumBlastRadius,
      entry.minimumBlastRadius,
      `the addendum's row for "${entry.id}" names minimum blast radius "${row.minimumBlastRadius}", RISK_REGISTRY says "${entry.minimumBlastRadius}"`,
    );
  }

  const entryIds = new Set(domain.RISK_REGISTRY.entries.map((entry) => entry.id));
  for (const row of rows) {
    assert.ok(entryIds.has(row.id), `the addendum's registry table names "${row.id}", which is not an id in RISK_REGISTRY.entries`);
  }
});

/**
 * Slice 4 design, section C: "risk is resolved from this registry, never
 * from model or adapter output" must be stated, not just implied by the
 * table's presence.
 */
test('the addendum states that risk is resolved from the registry, never from model or adapter output', () => {
  const addendum = addendumText(readAdr());
  assert.match(
    addendum,
    /risk[^.]*(?:resolved|comes)[^.]*registry[^.]*never[^.]*(?:model|adapter)/i,
    'the addendum must say risk is resolved from the registry, never from model or adapter output',
  );
});

/**
 * Row 2: `docs/incident-commander-architecture-v1.md` §10's tool-layer
 * interface spells the risk union as a TypeScript literal
 * (`risk: "read" | "safe-write" | "dangerous"`). It must name exactly the
 * same three values as `@aic/domain`'s `RiskClassSchema.options`, both ways
 * — the doc's literal and the schema's frozen options array are independent
 * sources, so neither is derived from the other here.
 */
test("the architecture doc's §10 risk union and @aic/domain's RiskClassSchema.options are the same set, both ways", () => {
  const architecture = readFileSync(join(projectRoot, 'docs', 'incident-commander-architecture-v1.md'), 'utf8');
  const unionMatch = architecture.match(/risk:\s*("(?:[a-z-]+)"(?:\s*\|\s*"[a-z-]+")*)\s*;/);
  assert.ok(unionMatch, 'the architecture doc §10 must carry the literal `risk: "read" | "safe-write" | "dangerous";` union');
  const docValues = [...unionMatch[1].matchAll(/"([a-z-]+)"/g)].map((m) => m[1]);

  const schemaValues = [...domain.RiskClassSchema.options];
  for (const value of schemaValues) {
    assert.ok(docValues.includes(value), `RiskClassSchema.options names "${value}", which §10's literal union does not name`);
  }
  for (const value of docValues) {
    assert.ok(schemaValues.includes(value), `§10's literal union names "${value}", which RiskClassSchema.options does not name`);
  }
});

/**
 * Row 3: the addendum names `ProposedAction` and distinguishes the action
 * `idempotencyKey` (AIC-21) from the intake `idempotencyKey` (AIC-96) the
 * existing Terminology row already defines. That existing row is pinned
 * literally so the addendum lands as an addition beside it, not a rewrite of
 * it (AIC-21 slice 4 is additive-only).
 */
test('the existing intake idempotencyKey Terminology row is unchanged by the addendum', () => {
  const terminology = section(readAdr(), 'Terminology');
  assert.match(
    terminology,
    /\|\s*`idempotencyKey`\s*\|\s*the intake key that makes repeated intake of one incident a no-op\s*\|/,
    'the existing Terminology row defining `idempotencyKey` as the intake key must remain exactly as written; the addendum only adds beside it',
  );
});

test('the addendum names ProposedAction and distinguishes the action idempotencyKey from the intake key', () => {
  const addendum = addendumText(readAdr());
  assert.match(addendum, /ProposedAction/, 'the addendum must name ProposedAction');
  assert.match(
    addendum,
    /action[^.]*`?idempotencyKey`?[^.]*distinct[^.]*intake/i,
    'the addendum must say the action idempotencyKey is distinct from the intake idempotencyKey',
  );
});

/**
 * Row 4: the "every Terminology type … exported … as its Schema" test above
 * (line 201) reads a hard-coded array literal, not the Terminology section's
 * text — so it does not start requiring `ProposedActionSchema` merely
 * because the addendum adds `ProposedAction` terminology, and it is
 * unaffected by this slice either way. `@aic/domain` exports
 * `ProposedActionDraftSchema` and `ProposedActionRecordSchema`, never a
 * `ProposedActionSchema` (design section B2) — so the addendum's Terminology
 * entries must name the draft and the record by those exact two names, not
 * the unexported umbrella name.
 */
test('@aic/domain has no ProposedActionSchema export, only ProposedActionDraftSchema and ProposedActionRecordSchema', () => {
  assert.equal(domain.ProposedActionSchema, undefined, '@aic/domain must not export ProposedActionSchema (design section B2: draft and record are two shapes, not one)');
  assert.equal(typeof domain.ProposedActionDraftSchema?.safeParse, 'function', '@aic/domain must export ProposedActionDraftSchema');
  assert.equal(typeof domain.ProposedActionRecordSchema?.safeParse, 'function', '@aic/domain must export ProposedActionRecordSchema');
});

test('the addendum names the two real ProposedAction exports, ProposedActionDraft and ProposedActionRecord, not an unexported umbrella name', () => {
  const addendum = addendumText(readAdr());
  assert.match(addendum, /ProposedActionDraft\b/, 'the addendum must name ProposedActionDraft (the model-facing shape, `ProposedActionDraftSchema` in @aic/domain)');
  assert.match(addendum, /ProposedActionRecord\b/, 'the addendum must name ProposedActionRecord (the audited shape, `ProposedActionRecordSchema` in @aic/domain)');
});
