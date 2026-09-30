/**
 * AIC-146 slice b4: the read-back half of the prototype-pollution defence
 * `execute-investigation.ts`'s `parseTrial` already carries via
 * `nullPrototypeInput` (`packages/graph/src/evidence-ingestion.ts`).
 * `readRunProductSnapshot` (`packages/persistence/src/retention.ts`) parses
 * row bodies straight out of `JSON.parse`, which — same as any other plain
 * object — reads an optional key zod's `z.strictObject` treats as present
 * through `Object.prototype` when no OWN key shadows it. A polluted
 * `Object.prototype.refusal` becomes an own `refusal` on every `Trial` this
 * read model returns; `.provenance` and `.reliability` do the same to every
 * `Evidence`.
 *
 * The pinned fix surface is a pure function, `parseRunProductRows`
 * (`packages/persistence/src/retention.ts`, re-exported from
 * `@aic/persistence`'s package root the same way `readRunProductSnapshot`
 * and `pruneTerminalRun` already are):
 *
 *   parseRunProductRows({ trialRows, evidenceRows }): { trials, evidence }
 *
 * `trialRows`/`evidenceRows` are arrays of `{ body: string }` — the exact
 * shape `pool.query<{ body: string }>(...)`'s `rows` already have — and the
 * function parses each `body` through `JSON.parse` and the matching domain
 * schema the same way `readRunProductSnapshot` parses a row, only immune to
 * `Object.prototype` the way `nullPrototypeInput` makes the canonical node
 * immune. `readRunProductSnapshot` is pinned (row 3 below) to call this
 * function rather than parsing rows itself, so the live database path is
 * never a second, divergent copy of the same parse
 * (`.claude/rules/invariants.md`, "one mechanism, one implementation").
 *
 * If the Green step's implementation shapes `parseRunProductRows`
 * differently, that reason belongs in the PR description, not in a silent
 * rename here.
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import * as persistence from '@aic/persistence';

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const retentionSourcePath = resolve(projectRoot, 'packages/persistence/src/retention.ts');

function requirePersistenceExport(name) {
  assert.equal(
    typeof persistence[name],
    'function',
    `@aic/persistence must export ${name}`,
  );
  return persistence[name];
}

/** A valid Trial (TrialSchema), carrying no own `refusal`. */
function validTrial(overrides = {}) {
  return {
    id: 't-read-back-1',
    runId: 'run-read-back',
    testId: 'test-read-back',
    attempt: 1,
    tool: 'metrics',
    input: { service: 'checkout' },
    status: 'ok',
    durationMs: 12,
    evidenceIds: ['e-read-back-1'],
    ...overrides,
  };
}

/** A valid Evidence (EvidenceSchema), carrying no own `provenance`/`reliability`/`observation`. */
function validEvidence(overrides = {}) {
  return {
    id: 'e-read-back-1',
    trialId: 't-read-back-1',
    kind: 'metric',
    source: 'metrics',
    observedAt: '2026-09-24T00:00:00.000Z',
    statement: 'checkout evidence recorded as e-read-back-1',
    rawRef: 'replay://evidence/e-read-back-1',
    ...overrides,
  };
}

/** A well-formed EvidenceProvenance (EvidenceProvenanceSchema). */
function wellFormedProvenance() {
  return {
    sourceBindingId: randomUUID(),
    adapter: 'lab@1',
    credentialRefId: null,
    fetchedAt: '2026-09-24T00:00:00.000Z',
    requestFingerprint: `sha256:${'0'.repeat(64)}`,
  };
}

/* -------------------------------------------------------------------------- */
/* Row 1 — a polluted prototype never becomes an own field of a parsed row    */
/* -------------------------------------------------------------------------- */

test('parseRunProductRows: a polluted Object.prototype.refusal/.provenance/.reliability never becomes an own field of the parsed trial or evidence', () => {
  const parseRunProductRows = requirePersistenceExport('parseRunProductRows');

  const trialRows = [{ body: JSON.stringify(validTrial()) }];
  const evidenceRows = [{ body: JSON.stringify(validEvidence()) }];

  Object.defineProperty(Object.prototype, 'refusal', {
    value: { reason: 'denied', sourceBindingId: null },
    enumerable: false,
    configurable: true,
    writable: true,
  });
  Object.defineProperty(Object.prototype, 'provenance', {
    value: wellFormedProvenance(),
    enumerable: false,
    configurable: true,
    writable: true,
  });
  Object.defineProperty(Object.prototype, 'reliability', {
    value: 'high',
    enumerable: false,
    configurable: true,
    writable: true,
  });
  try {
    const { trials, evidence } = parseRunProductRows({ trialRows, evidenceRows });

    assert.equal(trials.length, 1);
    assert.equal(
      Object.hasOwn(trials[0], 'refusal'),
      false,
      'a prototype-inherited refusal must never become an own property on a parsed trial',
    );

    assert.equal(evidence.length, 1);
    assert.equal(
      Object.hasOwn(evidence[0], 'provenance'),
      false,
      'a prototype-inherited provenance must never become an own property on parsed evidence',
    );
    assert.equal(
      Object.hasOwn(evidence[0], 'reliability'),
      false,
      'a prototype-inherited reliability must never become an own property on parsed evidence',
    );
  } finally {
    delete Object.prototype.refusal;
    delete Object.prototype.provenance;
    delete Object.prototype.reliability;
  }
});

/* -------------------------------------------------------------------------- */
/* Row 2 — without pollution, valid rows round-trip exactly                   */
/* -------------------------------------------------------------------------- */

test('parseRunProductRows: without prototype pollution, valid trial and evidence rows round-trip deep-equal', () => {
  const parseRunProductRows = requirePersistenceExport('parseRunProductRows');

  const trial = validTrial();
  const evidenceItem = validEvidence();
  const trialRows = [{ body: JSON.stringify(trial) }];
  const evidenceRows = [{ body: JSON.stringify(evidenceItem) }];

  const { trials, evidence } = parseRunProductRows({ trialRows, evidenceRows });

  assert.deepEqual(trials, [trial]);
  assert.deepEqual(evidence, [evidenceItem]);
});

/* -------------------------------------------------------------------------- */
/* Row 3 — readRunProductSnapshot uses parseRunProductRows, not its own parse */
/* -------------------------------------------------------------------------- */

test('readRunProductSnapshot calls parseRunProductRows to build its trials and evidence, rather than parsing rows itself', () => {
  const source = readFileSync(retentionSourcePath, 'utf8');
  const functionStart = source.indexOf('export async function readRunProductSnapshot');
  assert.ok(
    functionStart >= 0,
    'readRunProductSnapshot must still be exported from packages/persistence/src/retention.ts',
  );

  const nextExportStart = source.indexOf('\nexport ', functionStart + 1);
  const functionBody =
    nextExportStart === -1 ? source.slice(functionStart) : source.slice(functionStart, nextExportStart);

  assert.ok(
    /\bparseRunProductRows\s*\(/.test(functionBody),
    'readRunProductSnapshot must call parseRunProductRows to build the trials/evidence arrays of its snapshot, so the live database path and this file\'s pure-function tests are the same one implementation',
  );
});
