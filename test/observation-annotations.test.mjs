/**
 * AIC-123 slice 3a (owner decision D3, Jira comment 20872): typed facts for
 * the corpus live in a separate, versioned sidecar table rather than on the
 * fixtures themselves. Each fact follows from its own evidence item's prose
 * only; the table is digest-frozen before any prediction-derivation template
 * exists and was blind-reviewed by two independent readers, merged by
 * intersection. Fixtures stay unchanged; keys use the v2 replay identity
 * (`packages/tools/src/bound-source-registry.ts`, `buildReplayIdentity`).
 *
 * Pins `@aic/evals`'s `OBSERVATION_ANNOTATIONS_VERSION` and
 * `OBSERVATION_ANNOTATIONS`, `scripts/observation-review-packet.mjs`'s
 * `buildObservationReviewPacket()`, and the committed review record
 * `docs/evidence/observation-annotations/review-v1.json`.
 *
 * `REVIEWER_BRIEF_HEADER_LINES` below is a hand-written copy of the brief the
 * two readers were shown, so the packet builder is checked against a second
 * statement of that text rather than against itself.
 *
 * The (replay identity, evidence id) key and the packet's numbered-sentence
 * derivation are recomputed independently in this file rather than imported
 * from the production table or packet builder — see the comments on
 * `replayIdentity` and `distinctOkStatementsBySha256` below
 * (`.claude/rules/invariants.md`, "the independent-oracle invariant").
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import * as domain from '@aic/domain';
import * as evals from '@aic/evals';
import { createRequestFingerprint } from '@aic/tools';

import { buildObservationReviewPacket } from '../scripts/observation-review-packet.mjs';

const REPO_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const REVIEW_RECORD_PATH = join(
  REPO_ROOT,
  'docs',
  'evidence',
  'observation-annotations',
  'review-v1.json',
);

function readReviewRecord() {
  return JSON.parse(readFileSync(REVIEW_RECORD_PATH, 'utf8'));
}

/* -------------------------------------------------------------------------- */
/* the reviewer brief header — a one-time literal copy, not a run-time read   */
/* -------------------------------------------------------------------------- */

const REVIEWER_BRIEF_HEADER_LINES = [
  'You are an independent annotator. Do NOT use any tools, do not read any files, do not search: answer only from the text below.',
  '',
  'Below are 18 short sentences. Each is one observation written by an engineer during an incident. For each sentence, record the typed facts the sentence ITSELF states — nothing inferred from other sentences, from what the incident "probably" was, or from world knowledge about what usually causes what.',
  '',
  '## The fact vocabulary (closed; nothing outside it)',
  '',
  'Every fact has a `subject` and a `window`.',
  '- `subject`: the service or component the sentence names, spelled exactly as it appears in the sentence. A versioned release name of the form `<name>-v<N>` names the service `<name>`. If the sentence names no service or component for the observation, record no fact.',
  '- `window`: one of `pre-onset` (before the incident began, e.g. before the first alert or before the symptoms began), `incident` (during the incident window), `recovery` (during the recovery window). If the sentence does not place the observation in one of these windows, record no fact.',
  '',
  'Forms:',
  '1. `deployment-in-window`: {form, subject, window, count, coverage} — deployments/releases of the subject that happened in the window. `count` = the number stated (one deployment mentioned = 1). `coverage` = `complete` only if the sentence claims an exhaustive check (e.g. "no deployments were recorded"), otherwise `partial`.',
  '2. `log-class-in-window`: {form, subject, window, logClass, count, coverage} — log events of class `error`, `timeout` or `activity` for the subject in the window. count/coverage as above.',
  '3. `signal-state`: {form, subject, window, signal, state} — `signal` one of `error-rate`, `latency`, `connection-pool`, `worker-saturation`, `dependency-health`; `state` one of `normal`, `elevated`, `at-limit`.',
  '',
  'A sentence may yield zero, one or several facts. When in doubt, record no fact: a missing fact is safe, a wrong fact is not.',
  '',
  '## Output',
  '',
  'Return ONLY one JSON object: {"1": [facts...], "2": [...], ... "18": [...]} with an array (possibly empty) for every sentence number, and after it one line per sentence with empty facts giving the reason in a few words.',
  '',
  '## Sentences',
];

const REVIEWER_BRIEF_HEADER = REVIEWER_BRIEF_HEADER_LINES.join('\n');

/* -------------------------------------------------------------------------- */
/* independent derivations                                                    */
/* -------------------------------------------------------------------------- */

/**
 * Every distinct statement the ok corpus serves, ordered by the hex sha256 of
 * the statement text ascending — the same ordering rule
 * `buildObservationReviewPacket` is specified to use, computed here directly
 * from `evals.REPLAY_SCENARIOS` rather than by calling the packet builder.
 */
function distinctOkStatementsBySha256() {
  const statementById = new Map();
  for (const scenario of evals.REPLAY_SCENARIOS) {
    for (const entry of scenario.fixture.entries) {
      if (entry.result.status !== 'ok') continue;
      for (const item of entry.result.output) {
        statementById.set(item.id, item.statement);
      }
    }
  }
  const statements = [...new Set(statementById.values())];
  const hex = (text) => createHash('sha256').update(text).digest('hex');
  statements.sort((a, b) => (hex(a) < hex(b) ? -1 : 1));
  return statements;
}

function expectedPacketText() {
  const statements = distinctOkStatementsBySha256();
  const body = statements.map((statement, index) => `${index + 1}. ${statement}`).join('\n');
  return `${REVIEWER_BRIEF_HEADER}\n${body}\n`;
}

const REPLAY_ADAPTER = 'aic.incident-tool@1';

/**
 * A second, independent construction of the v2 replay identity string,
 * deliberately not an import of `buildReplayIdentity`
 * (`packages/tools/src/bound-source-registry.ts`) — the identity this file
 * checks the table's keys against must not come from the same builder the
 * table itself might have been keyed with (`.claude/rules/invariants.md`,
 * "the independent-oracle invariant"). `createRequestFingerprint` is reused
 * because it is the one hashing implementation this repository declares
 * (same file, "one mechanism, one implementation") — it is not the mechanism
 * under test here.
 */
function replayIdentity(toolId, input) {
  return `v2:${JSON.stringify([toolId, REPLAY_ADAPTER, createRequestFingerprint(toolId, input)])}`;
}

/** Every (replay identity, evidence id) pair the ok corpus actually serves. */
function corpusRows() {
  const rows = new Map();
  for (const scenario of evals.REPLAY_SCENARIOS) {
    for (const entry of scenario.fixture.entries) {
      if (entry.result.status !== 'ok') continue;
      const identity = replayIdentity(entry.toolId, entry.input);
      for (const item of entry.result.output) {
        rows.set(`${identity}|${item.id}`, {
          identity,
          evidenceId: item.id,
          statement: item.statement,
        });
      }
    }
  }
  return rows;
}

function subjectAppearsIn(subject, statement) {
  const tokens = statement.match(/[A-Za-z0-9-]+/g) ?? [];
  return tokens.some((token) => token === subject || token.startsWith(`${subject}-`));
}

function normalizeFact(fact) {
  return JSON.stringify(
    Object.keys(fact)
      .sort()
      .reduce((acc, key) => {
        acc[key] = fact[key];
        return acc;
      }, {}),
  );
}

/** Set-style intersection by deep equality, preserving `a`'s order. */
function intersectFacts(a, b) {
  const normalizedB = new Set(b.map(normalizeFact));
  return a.filter((fact) => normalizedB.has(normalizeFact(fact)));
}

/* -------------------------------------------------------------------------- */
/* the digest freeze                                                          */
/* -------------------------------------------------------------------------- */

test('freezes OBSERVATION_ANNOTATIONS at the reviewed digest: a content change is a new dated, reviewed version, never an edit to this one', () => {
  const digest = createHash('sha256').update(JSON.stringify(evals.OBSERVATION_ANNOTATIONS)).digest('hex');
  assert.equal(
    digest,
    '9f5b5f5ec8da7e88975fe8d223c17a0f3f8937635630debf6c75f40d6aae621d',
    'OBSERVATION_ANNOTATIONS content changed since the last reviewed digest; publish a new dated, reviewed version instead of editing this one',
  );
});

/* -------------------------------------------------------------------------- */
/* keying: (replay identity, evidence id), not identity alone                 */
/* -------------------------------------------------------------------------- */

test('carries exactly one row per distinct (replay identity, evidence id) pair the ok corpus serves, none missing and none extra', () => {
  const expected = corpusRows();
  const actualKeys = evals.OBSERVATION_ANNOTATIONS.map((row) => `${row.identity}|${row.evidenceId}`);
  assert.equal(
    new Set(actualKeys).size,
    actualKeys.length,
    'OBSERVATION_ANNOTATIONS carries a duplicate (replay identity, evidence id) pair',
  );
  assert.deepEqual([...actualKeys].sort(), [...expected.keys()].sort());
});

test('the ok corpus really serves the same replay identity for more than one distinct evidence item, so identity alone cannot key this table', () => {
  const evidenceIdsByIdentity = new Map();
  for (const { identity, evidenceId } of corpusRows().values()) {
    if (!evidenceIdsByIdentity.has(identity)) evidenceIdsByIdentity.set(identity, new Set());
    evidenceIdsByIdentity.get(identity).add(evidenceId);
  }
  const servesMultipleEvidence = [...evidenceIdsByIdentity.values()].some((ids) => ids.size > 1);
  assert.equal(
    servesMultipleEvidence,
    true,
    'no replay identity in the ok corpus serves more than one evidence id — the (identity, evidenceId) keying claim is untested by this corpus',
  );
});

test("every row's statement equals the served evidence item's own statement", () => {
  const expected = corpusRows();
  for (const row of evals.OBSERVATION_ANNOTATIONS) {
    const corpus = expected.get(`${row.identity}|${row.evidenceId}`);
    assert.ok(corpus, `row ${row.evidenceId} does not match a served (identity, evidenceId) pair`);
    assert.equal(row.statement, corpus.statement);
  }
});

/* -------------------------------------------------------------------------- */
/* facts: typed, subject grounded in the row's own statement                  */
/* -------------------------------------------------------------------------- */

test("every fact parses as a well-formed ObservedFact, and its subject appears in its own row's statement", () => {
  for (const row of evals.OBSERVATION_ANNOTATIONS) {
    for (const fact of row.facts) {
      const parsed = domain.ObservedFactSchema.safeParse(fact);
      assert.equal(
        parsed.success,
        true,
        `row ${row.evidenceId} carries a fact that fails ObservedFactSchema: ${JSON.stringify(fact)}`,
      );
      assert.equal(
        subjectAppearsIn(fact.subject, row.statement),
        true,
        `row ${row.evidenceId}: fact subject ${JSON.stringify(fact.subject)} does not appear as a whole token (or hyphenated-token prefix) in its statement ${JSON.stringify(row.statement)}`,
      );
    }
  }
});

/* -------------------------------------------------------------------------- */
/* no scenario-id leakage, and deep freeze                                    */
/* -------------------------------------------------------------------------- */

test('names no REPLAY_SCENARIOS id anywhere in the serialized table', () => {
  const serialized = JSON.stringify(evals.OBSERVATION_ANNOTATIONS);
  assert.ok(evals.REPLAY_SCENARIOS.length > 0, 'REPLAY_SCENARIOS must name at least one scenario, or this sweep checks nothing');
  for (const scenario of evals.REPLAY_SCENARIOS) {
    assert.equal(serialized.includes(scenario.id), false, `table serialization carries REPLAY_SCENARIOS id ${scenario.id}`);
  }
});

test("is deeply frozen: the table itself, every row, and every row's facts array and fact objects", () => {
  assert.equal(Object.isFrozen(evals.OBSERVATION_ANNOTATIONS), true, 'OBSERVATION_ANNOTATIONS itself must be frozen');
  for (const row of evals.OBSERVATION_ANNOTATIONS) {
    assert.equal(Object.isFrozen(row), true, `row ${row.evidenceId} must be frozen`);
    assert.equal(Object.isFrozen(row.facts), true, `row ${row.evidenceId}.facts must be frozen`);
    for (const fact of row.facts) {
      assert.equal(Object.isFrozen(fact), true, `row ${row.evidenceId}: a fact object must be frozen`);
    }
  }
});

/* -------------------------------------------------------------------------- */
/* the review packet: prose only, sha256-ordered, digest-pinned               */
/* -------------------------------------------------------------------------- */

test('buildObservationReviewPacket reproduces the reviewer brief header verbatim, followed by one numbered line per distinct ok-corpus statement in sha256 order', () => {
  assert.equal(buildObservationReviewPacket(), expectedPacketText());
});

test("numbers exactly one line per distinct ok-corpus statement below the sentences heading, and repeats none", () => {
  const packet = buildObservationReviewPacket();
  // The header numbers its own fact forms, so only the body is counted.
  const [, body] = packet.split('## Sentences\n');
  assert.ok(body !== undefined, 'the packet has a "## Sentences" heading');
  const numberedLines = body.split('\n').filter((line) => /^\d+\. /.test(line));
  const distinctStatements = distinctOkStatementsBySha256();
  assert.equal(numberedLines.length, distinctStatements.length);
  assert.equal(new Set(numberedLines).size, numberedLines.length, 'packet repeats a numbered sentence line');
});

test('the packet carries no evidence id, no scenario id, and no evidence source string — the reader sees prose only', () => {
  const packet = buildObservationReviewPacket();
  let checkedAny = false;
  for (const scenario of evals.REPLAY_SCENARIOS) {
    assert.equal(packet.includes(scenario.id), false, `packet leaks REPLAY_SCENARIOS id ${scenario.id}`);
    for (const entry of scenario.fixture.entries) {
      if (entry.result.status !== 'ok') continue;
      for (const item of entry.result.output) {
        checkedAny = true;
        assert.equal(packet.includes(item.id), false, `packet leaks evidence id ${item.id}`);
        assert.equal(packet.includes(item.source), false, `packet leaks evidence source ${item.source}`);
      }
    }
  }
  assert.ok(checkedAny, 'no ok evidence item was checked; this sweep would pass vacuously');
});

test("sha256 of buildObservationReviewPacket() equals the digest the review record pins", () => {
  const digest = createHash('sha256').update(buildObservationReviewPacket(), 'utf8').digest('hex');
  const record = readReviewRecord();
  assert.equal(record.packetSha256, `sha256:${digest}`);
});

/* -------------------------------------------------------------------------- */
/* the review record: two readers, merged by intersection                     */
/* -------------------------------------------------------------------------- */

test('the review record declares exactly two readers and an intersection merge rule', () => {
  const record = readReviewRecord();
  assert.equal(record.mergeRule, 'intersection');
  assert.equal(record.readers.length, 2, 'the review record must name exactly two readers');
});

test("every row's facts equal the deep-equality intersection of the two readers' facts for that row's own packet sentence number", () => {
  const record = readReviewRecord();
  const [readerA, readerB] = record.readers;
  const statements = distinctOkStatementsBySha256();
  const numberOf = new Map(statements.map((statement, index) => [statement, index + 1]));

  let checkedAny = false;
  for (const row of evals.OBSERVATION_ANNOTATIONS) {
    const number = numberOf.get(row.statement);
    assert.ok(
      number !== undefined,
      `row ${row.evidenceId}: statement ${JSON.stringify(row.statement)} is not one of the ok-corpus statements the packet carries`,
    );
    const factsA = readerA.facts[String(number)] ?? [];
    const factsB = readerB.facts[String(number)] ?? [];
    const expectedFacts = intersectFacts(factsA, factsB);
    assert.deepEqual(
      row.facts,
      expectedFacts,
      `row ${row.evidenceId} (sentence ${number}) facts are not the two readers' intersection`,
    );
    checkedAny = true;
  }
  assert.ok(checkedAny, 'OBSERVATION_ANNOTATIONS is empty; this sweep would pass vacuously');
});

/* -------------------------------------------------------------------------- */
/* version                                                                    */
/* -------------------------------------------------------------------------- */

test('publishes OBSERVATION_ANNOTATIONS_VERSION as observation-annotations-v1', () => {
  assert.equal(evals.OBSERVATION_ANNOTATIONS_VERSION, 'observation-annotations-v1');
});

test("OBSERVATION_ANNOTATIONS_VERSION equals the review record's own version field", () => {
  const record = readReviewRecord();
  assert.equal(evals.OBSERVATION_ANNOTATIONS_VERSION, record.version);
});

test('no fact in the table reads as absent under observedPresence, because no sentence claims an exhaustive check', () => {
  const { observedPresence } = domain;
  let presenceFacts = 0;
  for (const row of evals.OBSERVATION_ANNOTATIONS) {
    for (const fact of row.facts) {
      if (fact.form === 'signal-state') continue;
      presenceFacts += 1;
      assert.notEqual(observedPresence(fact), 'absent', `${row.evidenceId}: a fact reads as absent`);
    }
  }
  assert.ok(presenceFacts > 0, 'the table carries at least one presence-form fact, so this row checks something');
});
