/**
 * AIC-100, slice b: "BoundSourceRegistry modes: live, record and replay" —
 * built on slice a's `EvidenceSource` port (`packages/tools/src/evidence-source.ts`,
 * merged in #116). Nothing in `packages/tools/live`, `packages/tools/replay`,
 * `replay-key.ts`, or any existing test is touched by this file; a sibling
 * parallel session owns migrating those existing adapters onto the new
 * contract (slice d) and this file names none of them.
 *
 * ## Design this file pins for the new module
 * (`packages/tools/src/bound-source-registry.ts`, exported from the package
 * index) — the ticket names the shape, not every internal detail, so the
 * choices below are decided here rather than discovered mid-assertion. If an
 * implementation shapes any of them differently, that belongs in the PR
 * description, not a silent rename of these tests.
 *
 *   - `createBoundSourceRegistry({ mode, bindings, store, clock })`: `mode` is
 *     `'live' | 'record' | 'replay'`, refused (thrown, synchronously, at
 *     construction) for anything else. `bindings` is
 *     `{ sourceBindingId, source, credentialRefId }[]`; a duplicate
 *     `sourceBindingId` is refused at construction. `clock: () => Date` is an
 *     injected dependency — the module never reads the ambient `Date.now`
 *     itself. `registry.execute(sourceBindingId, operation, input)` returns
 *     `Promise<EvidenceSourceOutcome>`.
 *   - Provenance, filled by the REGISTRY on every call, in every mode — an
 *     adapter's own `execute()` may return an outcome carrying its own
 *     provenance, and the registry OVERWRITES it unconditionally. This is the
 *     "single writer of provenance" design pin the ticket asks for:
 *       - `sourceBindingId`: the id the caller passed to `execute()`.
 *       - `adapter`: `` `${describe().adapterId}@${describe().version}` `` of
 *         the CURRENT binding's source — computed fresh on every call, in
 *         every mode (including replay, so a migrated binding is detected).
 *       - `credentialRefId`: the binding's own `credentialRefId` — recomputed
 *         fresh from the CURRENT binding on every call, in every mode
 *         INCLUDING a replay hit. A recording made under one credential
 *         reference and later replayed through a binding rebound to a
 *         different one reports the REPLAYING binding's reference, never the
 *         one baked into the stored recording (review round 1, code-reviewer
 *         blocker 2).
 *       - `fetchedAt`: `clock().toISOString()` in `live`/`record`; the
 *         RECORDED value in `replay` (never the replaying process's own
 *         clock) — the ONE field a replay hit takes from the stored
 *         recording rather than recomputing.
 *       - `requestFingerprint`: `createRequestFingerprint(operation, input)`
 *         (slice a, unmodified).
 *   - Two provenance edge cases this file pins explicitly, because
 *     `EvidenceSourceProvenance.adapter` and `.requestFingerprint` are
 *     non-nullable strings and there is no source to ask in these two cases:
 *       - An UNKNOWN `sourceBindingId` (no matching binding at all): there is
 *         no source to call `describe()` on, so `adapter` is `''`.
 *         `credentialRefId` is `null`. `requestFingerprint` is still computed
 *         normally (it only needs `operation`/`input`, not a binding).
 *       - A KNOWN binding whose source cannot fingerprint the given `input`
 *         (a non-JSON value — `createRequestFingerprint` throws, mirroring
 *         `canonicalJson`'s own refusals): `requestFingerprint` is `''`, and
 *         the source's own `execute()` is never called — the registry checks
 *         it can fingerprint the request before performing it.
 *   - `live`: an unknown binding, or an operation outside
 *     `describe().operations`, is refused `unavailable` WITHOUT calling
 *     `source.execute`. A throw from the adapter — `EvidenceSourceError` or a
 *     plain value — is refused via `classifyEvidenceSourceFailure`'s
 *     reason, and no text from the thrown value reaches the serialized
 *     outcome.
 *   - `record`: identical to `live`, and additionally stores the resulting
 *     outcome under the call's replay identity (see below) via `store.set`.
 *   - `replay`: NEVER calls `source.execute` — a hit is served entirely from
 *     the store. A miss (no stored entry for this call's replay identity) is
 *     refused `unavailable`, also without calling `source.execute`.
 *   - Replay identity — a versioned string, so a migration is explicit rather
 *     than implicit — is exactly
 *     `` `v${REPLAY_IDENTITY_VERSION}:` + JSON.stringify([sourceBindingId, adapter, requestFingerprint]) ``,
 *     `REPLAY_IDENTITY_VERSION` is exported and pinned to `2` here. The three
 *     parts are encoded the way slice a's own `createReplayFixtureKey`
 *     (`./replay-key.ts`) already joins its own parts — a `JSON.stringify` of
 *     an array — rather than a raw `:`-join, because a raw join lets one
 *     part's own `:` characters relabel a boundary: binding `'a'` + adapter
 *     `'b:c@1'` and binding `'a:b'` + adapter `'c@1'` produce the identical
 *     colon-joined string for the same fingerprint (review round 1,
 *     code-reviewer blocker 1). Under the array encoding those two stay
 *     genuinely different identities — a replay under one is a miss, never a
 *     hit served from the other's recording, and `rekeyReplayRecordings`
 *     rekeying one leaves the other's entries untouched. A different
 *     `sourceBindingId` OR a different `adapter` (adapter VERSION included)
 *     for the same `operation`/`input` is therefore always a genuinely
 *     different identity — a miss, never a coincidental hit.
 *   - `rekeyReplayRecordings(store, { sourceBindingId, fromAdapter, toAdapter })`
 *     is the ONLY thing that ever re-keys a stored recording: it moves every
 *     entry recorded under `(sourceBindingId, fromAdapter)` to the identity
 *     for `(sourceBindingId, toAdapter)` — updating both the stored key and
 *     the recorded outcome's own `provenance.adapter` to `toAdapter` — and
 *     returns the number of entries migrated. An entry for a different
 *     `sourceBindingId` or a different `fromAdapter` is left untouched. A
 *     call where `fromAdapter === toAdapter` is a no-op: it returns `0` and
 *     leaves the recording exactly where it was, still replayable (review
 *     round 1, code-reviewer blocker 3) — it must never delete-then-reinsert
 *     under the same identity.
 *   - Two `ReplayStore` implementations, `get`/`set`/`keys`/`delete`, all
 *     async: `createMemoryReplayStore()` (in-process) and
 *     `createFileReplayStore(path)` (one JSON file, object keys written
 *     sorted so two stores holding the same recordings, written in different
 *     orders, produce byte-identical files).
 *
 * ## Review round 1 — security findings pinned here too
 *
 *   - `createFileReplayStore` creates its file mode `0o600`, never
 *     world-readable — not because record mode persists unredacted adapter
 *     output (AIC-100 slice c redacts an `ok` outcome's `output` before
 *     `store.set`, see this file's own "AIC-100 slice c — redactEvidenceOutput"
 *     section below), but because a `refused` outcome's provenance, and any
 *     entry written by a caller that bypasses the registry's own redaction, are
 *     both still worth keeping owner-only (security blocker 4; text corrected,
 *     review round 2, matching `bound-source-registry.ts`'s own
 *     `writeRecordingsFile` doc comment).
 *   - `execute()` in `replay` over a file that fails to parse as JSON
 *     resolves to a `refused`/`adapter_error` outcome — it never rejects —
 *     and the serialized outcome carries no text from the file (security
 *     blocker 5a). A stored record that is not a well-formed
 *     `EvidenceSourceOutcome` (an unrecognised `status`, a `refused` `reason`
 *     outside `EVIDENCE_SOURCE_REFUSAL_REASONS`, or no `provenance` at all) is
 *     refused `unavailable` rather than handed back to the caller verbatim
 *     (security blocker 5b). In `record` mode, a `store.set` that throws
 *     resolves to a `refused`/`adapter_error` outcome rather than rejecting,
 *     even though the adapter call itself already succeeded (security
 *     blocker 5c).
 *   - A recordings file carrying a `__proto__` key never lets `get()` return
 *     an inherited `Object.prototype` member for identities that happen to
 *     collide with one (`'constructor'`, `'toString'`, …), and reading such a
 *     file never pollutes `Object.prototype` itself (security advisory 6,
 *     taken).
 *
 * Independent oracles throughout: every expected fingerprint or replay
 * identity below is built BY HAND in this file with `node:crypto`, over a
 * canonical string this file writes out itself — never by calling
 * `createRequestFingerprint` or the registry to ask it what it thinks the
 * right answer is (mirrors `test/evidence-source-contract.test.mjs`'s own
 * independent-oracle row for the identical reason).
 *
 * ## AIC-100 slice c — budgets and redaction (this file's own pins)
 *
 * `EVIDENCE_SOURCE_REFUSAL_REASONS` gaining `budget_exceeded` and
 * `evidenceSourceOutcomeToToolResult`'s mapping for it are pinned in
 * test/evidence-source-contract.test.mjs instead; this file pins what the
 * REGISTRY itself does with the new reason and the two new mechanisms.
 *
 *   - `createBoundSourceRegistry({ ..., budgets })`: `budgets` is optional —
 *     `{ timeoutMs, maxResultBytes, maxPages }`, all positive integers,
 *     defaulting to the exported, frozen `DEFAULT_SOURCE_BUDGETS` when
 *     omitted. A non-positive or non-integer field is refused (thrown,
 *     synchronously) at construction, the same way an unknown `mode` or a
 *     duplicate `sourceBindingId` already is.
 *   - Timeout: in `live`/`record`, a call whose adapter `execute()` does not
 *     settle within `budgets.timeoutMs` is refused `timeout` — using REAL
 *     timers (the injected `clock` stays reserved for `fetchedAt` only, as
 *     it already was in slice b).
 *   - Result size: an `ok` outcome whose `output`, JSON-stringified, is more
 *     than `budgets.maxResultBytes` (measured as
 *     `Buffer.byteLength(JSON.stringify(output), 'utf8')` — pinned here,
 *     since the ticket names the budget, not the exact measurement) is
 *     refused `budget_exceeded` instead of `ok`; exactly at the cap it is
 *     still `ok`.
 *   - Pagination: the registry calls `source.execute(operation, input, {
 *     maxPages })` — a third, additive argument carrying exactly
 *     `{ maxPages }` from the configured budgets, nothing else. An adapter
 *     that throws `EvidenceSourceError(..., { reason: 'budget_exceeded' })`
 *     to signal it stopped at that page budget is refused `budget_exceeded`.
 *   - `replay` NEVER re-applies any budget: a recording made under one
 *     (possibly generous) budget replays `ok` even under a replaying
 *     registry configured with a far stricter `maxResultBytes` — replay
 *     serves what was recorded under the budget in force AT RECORD TIME, it
 *     does not re-validate size (or re-run a timeout, since the adapter is
 *     never called in replay at all).
 *   - Redaction: in `record` mode, an `ok` outcome's `output` is redacted
 *     BEFORE `store.set` — the persisted recording never carries a
 *     credential the adapter returned. The outcome RETURNED to the caller in
 *     both `live` and `record` is the REDACTED one too (state and traces are
 *     downstream of the returned outcome, per the ticket). `redactEvidenceOutput(value)`
 *     is exported as the pure, deep, bounded redactor: it walks arrays and
 *     objects (keeping keys, leaving non-string values alone) and replaces a
 *     credential-shaped SUBSTRING of any string with `[REDACTED]` in place —
 *     six shapes, each pinned below with a runtime-ASSEMBLED example (never
 *     written as one literal, per `.claude/scripts/lib/secrets.mjs`) and a
 *     near-miss that must NOT be touched. `MAX_REDACTION_DEPTH` is exported
 *     too: past it, `redactEvidenceOutput` fails CLOSED to the fixed
 *     sentinel `'[REDACTED:depth]'` rather than continuing to recurse —
 *     `.claude/rules/invariants.md`'s "a guard that fails open must do
 *     provably bounded work", applied to a redactor rather than a hook.
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import * as tools from '@aic/tools';

import { childEnv } from './fixtures/child-env.mjs';
import {
  FIXTURE_INPUT,
  FIXTURE_OPERATION,
  createDeterministicEvidenceSource,
} from './fixtures/bound-source-registry-fixture-source.mjs';

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const compilerPath = resolve(projectRoot, 'node_modules/typescript/bin/tsc');
const typeContractFixture = resolve(
  projectRoot,
  'test/fixtures/bound-source-registry-type-contract.ts',
);
const childWorkerPath = resolve(
  projectRoot,
  'test/fixtures/bound-source-registry-replay-child.mjs',
);

/* -------------------------------------------------------------------------- */
/* Scratch directories — mkdtemp only, removed by exact path, never a glob    */
/* -------------------------------------------------------------------------- */

function withScratchDir(t) {
  const dir = mkdtempSync(join(tmpdir(), 'aic-100b-bound-registry-'));
  t.after(() => {
    rmSync(dir, { recursive: true, force: true });
  });
  return dir;
}

/* -------------------------------------------------------------------------- */
/* Independent-oracle helpers — hand-built, never calling the module under    */
/* test or createRequestFingerprint                                          */
/* -------------------------------------------------------------------------- */

/**
 * Only valid for inputs whose own keys are already alphabetically sorted (the
 * ones used below are all single flat keys), matching
 * `test/evidence-source-contract.test.mjs`'s own independent-oracle row: the
 * pinned envelope is `JSON.stringify(canonicalJson({ input, operation }))`,
 * and canonicalJson sorts "input" before "operation" at the top level too.
 */
function handBuiltFingerprint(operation, input) {
  const envelope = `{"input":${JSON.stringify(input)},"operation":${JSON.stringify(operation)}}`;
  const hex = createHash('sha256').update(envelope).digest('hex');
  return `sha256:${hex}`;
}

/**
 * This file's own pinned design for the replay-identity string (see header):
 * a JSON array, not a raw `:`-join — deliberately a second, hand-rolled
 * encoding rather than importing the production module's own array-join
 * helper, so this oracle cannot be satisfied merely by production checking
 * its own work (review round 1, code-reviewer blocker 1).
 */
function handBuiltIdentity({ sourceBindingId, adapter, requestFingerprint }) {
  return `v2:${JSON.stringify([sourceBindingId, adapter, requestFingerprint])}`;
}

/* -------------------------------------------------------------------------- */
/* Fixture adapters, built inline (mirrors evidence-source-contract.test.mjs) */
/* -------------------------------------------------------------------------- */

function buildOkSource({ adapterId = 'fixture-adapter', version = '1.0.0', operations = ['fetch-logs'] } = {}) {
  const calls = [];
  return {
    calls,
    describe: () => ({ adapterId, version, operations }),
    check: async () => ({ status: 'ready' }),
    execute: async (operation, input) => {
      calls.push({ operation, input });
      return {
        status: 'ok',
        output: { lines: ['fixture output'] },
        // Deliberately foreign provenance — pins the single-writer design.
        provenance: {
          sourceBindingId: 'not-the-real-binding',
          adapter: 'not-the-real-adapter@0.0.0',
          credentialRefId: 'wrongcredentialplaceholder',
          fetchedAt: '1970-01-01T00:00:00.000Z',
          requestFingerprint: 'sha256:not-the-real-fingerprint',
        },
      };
    },
  };
}

function buildThrowingSource({
  adapterId = 'fixture-adapter',
  version = '1.0.0',
  operations = ['fetch-logs'],
  error,
} = {}) {
  const calls = [];
  return {
    calls,
    describe: () => ({ adapterId, version, operations }),
    check: async () => ({ status: 'ready' }),
    execute: async (operation, input) => {
      calls.push({ operation, input });
      throw error;
    },
  };
}

function buildRefusingToBeCalledSource(overrides = {}) {
  return buildThrowingSource({
    ...overrides,
    error: new Error('FAKE_SOURCE_MUST_NOT_BE_CALLED: this mode must never call the adapter'),
  });
}

/**
 * Like `buildOkSource`, but with a caller-chosen `output` and capturing the
 * THIRD argument execute() is called with (AIC-100 slice c's page-budget
 * hint), so a test can assert both the output that flows through and exactly
 * what the registry passed as that argument.
 */
function buildOkSourceWithOutput(
  output,
  { adapterId = 'fixture-adapter', version = '1.0.0', operations = ['fetch-logs'] } = {},
) {
  const calls = [];
  return {
    calls,
    describe: () => ({ adapterId, version, operations }),
    check: async () => ({ status: 'ready' }),
    execute: async (operation, input, budgetHints) => {
      calls.push({ operation, input, budgetHints });
      return {
        status: 'ok',
        output,
        // Deliberately foreign provenance, matching buildOkSource above —
        // pins that the registry stays the single writer of provenance even
        // for a caller-supplied output.
        provenance: {
          sourceBindingId: 'not-the-real-binding',
          adapter: 'not-the-real-adapter@0.0.0',
          credentialRefId: 'wrongcredentialplaceholder',
          fetchedAt: '1970-01-01T00:00:00.000Z',
          requestFingerprint: 'sha256:not-the-real-fingerprint',
        },
      };
    },
  };
}

/**
 * Builds a JSON object whose `JSON.stringify(...)` is EXACTLY `totalBytes`
 * long: `{"data":"..."}` costs 11 fixed bytes (`{"data":"` is 9, the closing
 * `"}` is 2) and the rest is ASCII `'A'` characters, whose UTF-8 byte length
 * equals their character count — so this is exact and independent of
 * whichever canonicalizer the implementation measures with, PROVIDED it
 * measures `JSON.stringify(output)` itself (this file's own pinned
 * definition of "exceeds maxResultBytes" — the ticket names the budget, not
 * the exact measurement). Self-checked below rather than trusted.
 */
function buildJsonObjectOfByteSize(totalBytes) {
  const fixedOverhead = 11;
  assert.ok(totalBytes >= fixedOverhead, 'buildJsonObjectOfByteSize only supports totalBytes >= 11');
  const output = { data: 'A'.repeat(totalBytes - fixedOverhead) };
  assert.equal(
    Buffer.byteLength(JSON.stringify(output), 'utf8'),
    totalBytes,
    'self-check: the constructed fixture must actually be exactly totalBytes long',
  );
  return output;
}

const fixedClock = (iso) => () => new Date(iso);

/**
 * "token-like string": a marker an upstream failure might echo back —
 * deliberately not named with a credential-vocabulary identifier (see
 * .claude/scripts/lib/secrets.mjs's `assigned-secret` pattern, and
 * test/evidence-source-contract.test.mjs's identical `upstreamEchoedMarker`).
 */
const upstreamEchoedMarker = 'zz9-bound-registry-fixture-marker-7731-not-a-real-value';

/**
 * Credential-shaped strings for `redactEvidenceOutput`'s pattern rows,
 * ASSEMBLED AT RUNTIME from parts — never written out as one literal, per
 * this project's own guard-secret-file vocabulary
 * (`.claude/scripts/lib/secrets.mjs`). None of these are real credentials;
 * each is shaped to match exactly one of the six patterns pinned below, and
 * each has a paired near-miss that must NOT be touched.
 */
const fixtureGithubToken = ['gh', 'p_'].join('') + 'A'.repeat(36);
const fixtureGithubTokenTooShort = ['gh', 'p_'].join('') + 'A'.repeat(35);
const fixtureAwsAccessKeyId = 'AKIA' + 'B7'.repeat(8);
const fixtureAwsAccessKeyIdTooShort = 'AKIA' + 'B7'.repeat(7) + 'B';
const fixtureBearerCredential = ['Bearer', ' '].join('') + 'Zz9'.repeat(8);
const fixtureBearerCredentialTooShort = ['Bearer', ' '].join('') + 'Zz9'.repeat(6);
const fixturePemHeader = ['-----BEGIN ', 'RSA PRIVATE KEY-----'].join('');
const fixtureNonPrivatePemHeader = '-----BEGIN CERTIFICATE-----';
const fixtureUrlCredentialPart = ['user', ':', 'hunter2fixture'].join('');
const fixtureSlackToken = ['xoxb', '-'].join('') + 'Q9z'.repeat(6);
const fixtureSlackTokenWrongLetter = ['xoxq', '-'].join('') + 'Q9z'.repeat(6);

/* -------------------------------------------------------------------------- */
/* Row — the compile-time port contract                                       */
/* -------------------------------------------------------------------------- */

test('compiles the bound-source-registry type contract: BoundSourceRegistry, ReplayStore and the two store factories satisfy their pinned shapes', () => {
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
    `type-contract compile exited ${result.status}\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}\n\n@aic/tools must export createBoundSourceRegistry, createMemoryReplayStore, createFileReplayStore, rekeyReplayRecordings and REPLAY_IDENTITY_VERSION, plus the BoundSourceMode / BoundSourceRegistry / BoundSourceRegistryOptions / ReplayStore types — see test/fixtures/bound-source-registry-type-contract.ts`,
  );
});

/* -------------------------------------------------------------------------- */
/* REPLAY_IDENTITY_VERSION                                                    */
/* -------------------------------------------------------------------------- */

test('publishes REPLAY_IDENTITY_VERSION pinned to 2', () => {
  assert.equal(
    tools.REPLAY_IDENTITY_VERSION,
    2,
    '@aic/tools must export REPLAY_IDENTITY_VERSION, this file\'s pinned design value 2 (independent oracle: hard-coded here, not read back from the module elsewhere)',
  );
});

/* -------------------------------------------------------------------------- */
/* createBoundSourceRegistry — construction validation                       */
/* -------------------------------------------------------------------------- */

function createBoundSourceRegistryFactory() {
  assert.equal(
    typeof tools.createBoundSourceRegistry,
    'function',
    '@aic/tools must export createBoundSourceRegistry({ mode, bindings, store, clock })',
  );
  return tools.createBoundSourceRegistry;
}

function memoryReplayStoreFactory() {
  assert.equal(
    typeof tools.createMemoryReplayStore,
    'function',
    '@aic/tools must export createMemoryReplayStore(): ReplayStore',
  );
  return tools.createMemoryReplayStore;
}

function fileReplayStoreFactory() {
  assert.equal(
    typeof tools.createFileReplayStore,
    'function',
    '@aic/tools must export createFileReplayStore(path): ReplayStore',
  );
  return tools.createFileReplayStore;
}

function rekeyReplayRecordingsFactory() {
  assert.equal(
    typeof tools.rekeyReplayRecordings,
    'function',
    '@aic/tools must export rekeyReplayRecordings(store, { sourceBindingId, fromAdapter, toAdapter })',
  );
  return tools.rekeyReplayRecordings;
}

function defaultSourceBudgetsFactory() {
  assert.ok(
    tools.DEFAULT_SOURCE_BUDGETS && typeof tools.DEFAULT_SOURCE_BUDGETS === 'object',
    '@aic/tools must export DEFAULT_SOURCE_BUDGETS: { timeoutMs, maxResultBytes, maxPages }, all positive integers, frozen (AIC-100 slice c)',
  );
  return tools.DEFAULT_SOURCE_BUDGETS;
}

function redactEvidenceOutputFactory() {
  assert.equal(
    typeof tools.redactEvidenceOutput,
    'function',
    '@aic/tools must export redactEvidenceOutput(value): a pure, deep, bounded redactor over JSON values, used before persistence and before an outcome is returned to a caller (AIC-100 slice c)',
  );
  return tools.redactEvidenceOutput;
}

function maxRedactionDepthFactory() {
  assert.equal(
    typeof tools.MAX_REDACTION_DEPTH,
    'number',
    '@aic/tools must export MAX_REDACTION_DEPTH: the bounded recursion-depth cap redactEvidenceOutput fails closed at (AIC-100 slice c, invariants.md\'s "a guard that fails open must do provably bounded work")',
  );
  assert.ok(tools.MAX_REDACTION_DEPTH > 0, 'MAX_REDACTION_DEPTH must be positive');
  return tools.MAX_REDACTION_DEPTH;
}

test('refuses construction with a mode outside live/record/replay', () => {
  const createBoundSourceRegistry = createBoundSourceRegistryFactory();
  const createMemoryReplayStore = memoryReplayStoreFactory();

  assert.throws(() =>
    createBoundSourceRegistry({
      mode: 'bogus-mode',
      bindings: [],
      store: createMemoryReplayStore(),
      clock: fixedClock('2026-09-24T00:00:00.000Z'),
    }),
  );
});

test('refuses construction with two bindings sharing the same sourceBindingId', () => {
  const createBoundSourceRegistry = createBoundSourceRegistryFactory();
  const createMemoryReplayStore = memoryReplayStoreFactory();

  assert.throws(() =>
    createBoundSourceRegistry({
      mode: 'live',
      bindings: [
        { sourceBindingId: 'binding-a', source: buildOkSource(), credentialRefId: null },
        { sourceBindingId: 'binding-a', source: buildOkSource(), credentialRefId: null },
      ],
      store: createMemoryReplayStore(),
      clock: fixedClock('2026-09-24T00:00:00.000Z'),
    }),
  );
});

/* -------------------------------------------------------------------------- */
/* AIC-100 slice c — DEFAULT_SOURCE_BUDGETS and budgets construction         */
/* -------------------------------------------------------------------------- */

test('publishes DEFAULT_SOURCE_BUDGETS as a frozen object of three positive-integer fields', () => {
  const budgets = defaultSourceBudgetsFactory();
  assert.equal(Object.isFrozen(budgets), true, 'DEFAULT_SOURCE_BUDGETS must be frozen');
  for (const key of ['timeoutMs', 'maxResultBytes', 'maxPages']) {
    assert.equal(typeof budgets[key], 'number', `DEFAULT_SOURCE_BUDGETS.${key} must be a number`);
    assert.equal(Number.isInteger(budgets[key]), true, `DEFAULT_SOURCE_BUDGETS.${key} must be an integer`);
    assert.ok(budgets[key] > 0, `DEFAULT_SOURCE_BUDGETS.${key} must be positive`);
  }
});

test('accepts construction with no budgets field at all, falling back to DEFAULT_SOURCE_BUDGETS', () => {
  const createBoundSourceRegistry = createBoundSourceRegistryFactory();
  const createMemoryReplayStore = memoryReplayStoreFactory();

  assert.doesNotThrow(() =>
    createBoundSourceRegistry({
      mode: 'live',
      bindings: [],
      store: createMemoryReplayStore(),
      clock: fixedClock('2026-09-24T00:00:00.000Z'),
    }),
  );
});

for (const badBudgets of [
  { timeoutMs: 0, maxResultBytes: 1024, maxPages: 5 },
  { timeoutMs: -1, maxResultBytes: 1024, maxPages: 5 },
  { timeoutMs: 50, maxResultBytes: 0, maxPages: 5 },
  { timeoutMs: 50, maxResultBytes: -1024, maxPages: 5 },
  { timeoutMs: 50, maxResultBytes: 1024, maxPages: 0 },
  { timeoutMs: 50, maxResultBytes: 1024, maxPages: -5 },
  { timeoutMs: 50.5, maxResultBytes: 1024, maxPages: 5 },
  { timeoutMs: 50, maxResultBytes: 1024.25, maxPages: 5 },
  { timeoutMs: 50, maxResultBytes: 1024, maxPages: 5.5 },
]) {
  test(`refuses construction with a non-positive or non-integer budgets field: ${JSON.stringify(badBudgets)}`, () => {
    const createBoundSourceRegistry = createBoundSourceRegistryFactory();
    const createMemoryReplayStore = memoryReplayStoreFactory();

    assert.throws(() =>
      createBoundSourceRegistry({
        mode: 'live',
        bindings: [],
        store: createMemoryReplayStore(),
        clock: fixedClock('2026-09-24T00:00:00.000Z'),
        budgets: badBudgets,
      }),
    );
  });
}

test('accepts construction with a fully-specified, valid budgets object', () => {
  const createBoundSourceRegistry = createBoundSourceRegistryFactory();
  const createMemoryReplayStore = memoryReplayStoreFactory();

  assert.doesNotThrow(() =>
    createBoundSourceRegistry({
      mode: 'live',
      bindings: [],
      store: createMemoryReplayStore(),
      clock: fixedClock('2026-09-24T00:00:00.000Z'),
      budgets: { timeoutMs: 5000, maxResultBytes: 1_000_000, maxPages: 10 },
    }),
  );
});

/* -------------------------------------------------------------------------- */
/* Provenance — filled by the registry, and it is the SINGLE writer of it     */
/* -------------------------------------------------------------------------- */

test('fills provenance from the binding and the clock, in live mode, ignoring whatever provenance the adapter itself returned', async () => {
  const createBoundSourceRegistry = createBoundSourceRegistryFactory();
  const createMemoryReplayStore = memoryReplayStoreFactory();
  const source = buildOkSource({ adapterId: 'fixture-adapter', version: '1.0.0' });

  const registry = createBoundSourceRegistry({
    mode: 'live',
    bindings: [{ sourceBindingId: 'binding-a', source, credentialRefId: 'ref-abc' }],
    store: createMemoryReplayStore(),
    clock: fixedClock('2026-09-24T00:00:00.000Z'),
  });

  const outcome = await registry.execute('binding-a', 'fetch-logs', { service: 'checkout' });

  assert.equal(outcome.status, 'ok');
  assert.deepEqual(outcome.provenance, {
    sourceBindingId: 'binding-a',
    adapter: 'fixture-adapter@1.0.0',
    credentialRefId: 'ref-abc',
    fetchedAt: '2026-09-24T00:00:00.000Z',
    requestFingerprint: handBuiltFingerprint('fetch-logs', { service: 'checkout' }),
  });
});

test('provenance credentialRefId is null when the binding\'s own credentialRefId is null', async () => {
  const createBoundSourceRegistry = createBoundSourceRegistryFactory();
  const createMemoryReplayStore = memoryReplayStoreFactory();
  const source = buildOkSource();

  const registry = createBoundSourceRegistry({
    mode: 'live',
    bindings: [{ sourceBindingId: 'binding-a', source, credentialRefId: null }],
    store: createMemoryReplayStore(),
    clock: fixedClock('2026-09-24T00:00:00.000Z'),
  });

  const outcome = await registry.execute('binding-a', 'fetch-logs', { service: 'checkout' });

  assert.equal(outcome.provenance.credentialRefId, null);
});

/* -------------------------------------------------------------------------- */
/* live mode — unknown binding / unsupported operation, no adapter call       */
/* -------------------------------------------------------------------------- */

test('live: an unknown sourceBindingId is refused unavailable, without calling any adapter, and adapter is the empty string (no source to ask)', async () => {
  const createBoundSourceRegistry = createBoundSourceRegistryFactory();
  const createMemoryReplayStore = memoryReplayStoreFactory();
  const source = buildOkSource();

  const registry = createBoundSourceRegistry({
    mode: 'live',
    bindings: [{ sourceBindingId: 'binding-a', source, credentialRefId: null }],
    store: createMemoryReplayStore(),
    clock: fixedClock('2026-09-24T00:00:00.000Z'),
  });

  const outcome = await registry.execute('binding-does-not-exist', 'fetch-logs', { service: 'checkout' });

  assert.equal(outcome.status, 'refused');
  assert.equal(outcome.reason, 'unavailable');
  assert.equal(source.calls.length, 0);
  assert.deepEqual(outcome.provenance, {
    sourceBindingId: 'binding-does-not-exist',
    adapter: '',
    credentialRefId: null,
    fetchedAt: '2026-09-24T00:00:00.000Z',
    requestFingerprint: handBuiltFingerprint('fetch-logs', { service: 'checkout' }),
  });
});

test('live: a known binding but an operation outside describe().operations is refused unavailable, without calling the adapter', async () => {
  const createBoundSourceRegistry = createBoundSourceRegistryFactory();
  const createMemoryReplayStore = memoryReplayStoreFactory();
  const source = buildOkSource({ operations: ['fetch-logs'] });

  const registry = createBoundSourceRegistry({
    mode: 'live',
    bindings: [{ sourceBindingId: 'binding-a', source, credentialRefId: 'ref-abc' }],
    store: createMemoryReplayStore(),
    clock: fixedClock('2026-09-24T00:00:00.000Z'),
  });

  const outcome = await registry.execute('binding-a', 'fetch-metrics', { service: 'checkout' });

  assert.equal(outcome.status, 'refused');
  assert.equal(outcome.reason, 'unavailable');
  assert.equal(source.calls.length, 0);
  assert.deepEqual(outcome.provenance, {
    sourceBindingId: 'binding-a',
    adapter: 'fixture-adapter@1.0.0',
    credentialRefId: 'ref-abc',
    fetchedAt: '2026-09-24T00:00:00.000Z',
    requestFingerprint: handBuiltFingerprint('fetch-metrics', { service: 'checkout' }),
  });
});

/* -------------------------------------------------------------------------- */
/* live mode — adapter throws, and no secret leakage                          */
/* -------------------------------------------------------------------------- */

test('live: an adapter throwing EvidenceSourceError(denied) is refused with that reason, and the thrown message never reaches the outcome', async () => {
  const createBoundSourceRegistry = createBoundSourceRegistryFactory();
  const createMemoryReplayStore = memoryReplayStoreFactory();
  const error = new tools.EvidenceSourceError(
    `upstream rejected the request; it echoed back ${upstreamEchoedMarker}`,
    { reason: 'denied' },
  );
  const source = buildThrowingSource({ error });

  const registry = createBoundSourceRegistry({
    mode: 'live',
    bindings: [{ sourceBindingId: 'binding-a', source, credentialRefId: null }],
    store: createMemoryReplayStore(),
    clock: fixedClock('2026-09-24T00:00:00.000Z'),
  });

  const outcome = await registry.execute('binding-a', 'fetch-logs', { service: 'checkout' });

  assert.equal(outcome.status, 'refused');
  assert.equal(outcome.reason, 'denied');
  assert.equal(source.calls.length, 1);
  assert.equal(JSON.stringify(outcome).includes(upstreamEchoedMarker), false);
});

test('live: an adapter throwing a plain Error (not EvidenceSourceError) is refused adapter_error, and the thrown message never reaches the outcome', async () => {
  const createBoundSourceRegistry = createBoundSourceRegistryFactory();
  const createMemoryReplayStore = memoryReplayStoreFactory();
  const error = new Error(`socket hang up, upstream said ${upstreamEchoedMarker}`);
  const source = buildThrowingSource({ error });

  const registry = createBoundSourceRegistry({
    mode: 'live',
    bindings: [{ sourceBindingId: 'binding-a', source, credentialRefId: null }],
    store: createMemoryReplayStore(),
    clock: fixedClock('2026-09-24T00:00:00.000Z'),
  });

  const outcome = await registry.execute('binding-a', 'fetch-logs', { service: 'checkout' });

  assert.equal(outcome.status, 'refused');
  assert.equal(outcome.reason, 'adapter_error');
  assert.equal(JSON.stringify(outcome).includes(upstreamEchoedMarker), false);
});

test('live: an input that cannot be fingerprinted (non-JSON) is refused adapter_error without ever calling the adapter, and requestFingerprint is the empty string', async () => {
  const createBoundSourceRegistry = createBoundSourceRegistryFactory();
  const createMemoryReplayStore = memoryReplayStoreFactory();
  const source = buildOkSource();

  const registry = createBoundSourceRegistry({
    mode: 'live',
    bindings: [{ sourceBindingId: 'binding-a', source, credentialRefId: null }],
    store: createMemoryReplayStore(),
    clock: fixedClock('2026-09-24T00:00:00.000Z'),
  });

  // canonicalJson (and so createRequestFingerprint) refuses `undefined`
  // inside an object — see packages/tools/src/evidence-source.ts's own
  // doc comment and durable-execution-contract.test.mjs's pinned refusal.
  const outcome = await registry.execute('binding-a', 'fetch-logs', { service: undefined });

  assert.equal(outcome.status, 'refused');
  assert.equal(outcome.reason, 'adapter_error');
  assert.equal(source.calls.length, 0, 'a request that cannot even be fingerprinted must never reach the adapter');
  assert.deepEqual(outcome.provenance, {
    sourceBindingId: 'binding-a',
    adapter: 'fixture-adapter@1.0.0',
    credentialRefId: null,
    fetchedAt: '2026-09-24T00:00:00.000Z',
    requestFingerprint: '',
  });
});

/* -------------------------------------------------------------------------- */
/* record mode — behaves like live, and stores the outcome under identity     */
/* -------------------------------------------------------------------------- */

test('record: behaves exactly like live for an ok call, and additionally stores the outcome under the call\'s replay identity', async () => {
  const createBoundSourceRegistry = createBoundSourceRegistryFactory();
  const createMemoryReplayStore = memoryReplayStoreFactory();
  const store = createMemoryReplayStore();
  const source = buildOkSource({ adapterId: 'fixture-adapter', version: '1.0.0' });

  const registry = createBoundSourceRegistry({
    mode: 'record',
    bindings: [{ sourceBindingId: 'binding-a', source, credentialRefId: 'ref-abc' }],
    store,
    clock: fixedClock('2026-09-24T00:00:00.000Z'),
  });

  const outcome = await registry.execute('binding-a', 'fetch-logs', { service: 'checkout' });

  assert.equal(outcome.status, 'ok');
  assert.equal(source.calls.length, 1);

  const expectedFingerprint = handBuiltFingerprint('fetch-logs', { service: 'checkout' });
  const expectedIdentity = handBuiltIdentity({
    sourceBindingId: 'binding-a',
    adapter: 'fixture-adapter@1.0.0',
    requestFingerprint: expectedFingerprint,
  });

  const keys = await store.keys();
  assert.deepEqual(keys, [expectedIdentity], 'record must store the outcome under exactly this file\'s pinned replay-identity string');

  const stored = await store.get(expectedIdentity);
  assert.deepEqual(stored, outcome, 'the stored recording must be exactly the outcome record() returned to the caller');
});

test('record: also stores a refused outcome (an adapter_error), not only an ok one', async () => {
  const createBoundSourceRegistry = createBoundSourceRegistryFactory();
  const createMemoryReplayStore = memoryReplayStoreFactory();
  const store = createMemoryReplayStore();
  const source = buildThrowingSource({ error: new Error('boom') });

  const registry = createBoundSourceRegistry({
    mode: 'record',
    bindings: [{ sourceBindingId: 'binding-a', source, credentialRefId: null }],
    store,
    clock: fixedClock('2026-09-24T00:00:00.000Z'),
  });

  const outcome = await registry.execute('binding-a', 'fetch-logs', { service: 'checkout' });
  assert.equal(outcome.status, 'refused');

  const keys = await store.keys();
  assert.equal(keys.length, 1);
  const stored = await store.get(keys[0]);
  assert.deepEqual(stored, outcome);
});

test('record: a store whose set() throws resolves to a refused adapter_error outcome, never rejects, even though the adapter call already succeeded (security blocker 5c)', async () => {
  const createBoundSourceRegistry = createBoundSourceRegistryFactory();
  const source = buildOkSource();

  // A hand-made failing store — deliberately not createMemoryReplayStore or
  // createFileReplayStore, so this is an independent oracle for "the module
  // under test reacts correctly to a failing dependency" rather than the
  // module's own store implementation.
  const throwingStore = {
    async get() {
      return undefined;
    },
    async set() {
      throw new Error('disk full: set() must never be allowed to reject execute()');
    },
    async keys() {
      return [];
    },
    async delete() {},
  };

  const registry = createBoundSourceRegistry({
    mode: 'record',
    bindings: [{ sourceBindingId: 'binding-a', source, credentialRefId: null }],
    store: throwingStore,
    clock: fixedClock('2026-09-24T00:00:00.000Z'),
  });

  await assert.doesNotReject(async () => {
    const outcome = await registry.execute('binding-a', 'fetch-logs', { service: 'checkout' });
    assert.equal(outcome.status, 'refused');
    assert.equal(outcome.reason, 'adapter_error');
  });
});

/* -------------------------------------------------------------------------- */
/* replay mode — never calls the adapter; hit, miss, and identity mismatches  */
/* -------------------------------------------------------------------------- */

test('replay: a hit is served entirely from the store, the adapter is never called, and fetchedAt is the RECORDED value, not the replaying clock', async () => {
  const createBoundSourceRegistry = createBoundSourceRegistryFactory();
  const createMemoryReplayStore = memoryReplayStoreFactory();
  const store = createMemoryReplayStore();

  const recordingSource = buildOkSource({ adapterId: 'fixture-adapter', version: '1.0.0' });
  const recorder = createBoundSourceRegistry({
    mode: 'record',
    bindings: [{ sourceBindingId: 'binding-a', source: recordingSource, credentialRefId: 'ref-abc' }],
    store,
    clock: fixedClock('2026-09-24T00:00:00.000Z'),
  });
  const recorded = await recorder.execute('binding-a', 'fetch-logs', { service: 'checkout' });

  const replayingSource = buildRefusingToBeCalledSource({ adapterId: 'fixture-adapter', version: '1.0.0' });
  const replayer = createBoundSourceRegistry({
    mode: 'replay',
    bindings: [{ sourceBindingId: 'binding-a', source: replayingSource, credentialRefId: 'ref-abc' }],
    store,
    // A different clock than the one used to record — proves fetchedAt in a
    // replay hit comes from the RECORDING, never from this clock.
    clock: fixedClock('2099-01-01T00:00:00.000Z'),
  });

  const replayed = await replayer.execute('binding-a', 'fetch-logs', { service: 'checkout' });

  assert.equal(replayingSource.calls.length, 0, 'replay must never call the adapter, even on a hit');
  assert.deepEqual(replayed, recorded);
  assert.equal(replayed.provenance.fetchedAt, '2026-09-24T00:00:00.000Z');
});

test('replay writes provenance.credentialRefId from the REPLAYING binding, not the one baked into the recording, while still keeping the RECORDED fetchedAt (code-reviewer blocker 2)', async () => {
  const createBoundSourceRegistry = createBoundSourceRegistryFactory();
  const createMemoryReplayStore = memoryReplayStoreFactory();
  const store = createMemoryReplayStore();

  const recorder = createBoundSourceRegistry({
    mode: 'record',
    bindings: [
      {
        sourceBindingId: 'binding-a',
        source: buildOkSource({ adapterId: 'fixture-adapter', version: '1.0.0' }),
        credentialRefId: 'old-ref',
      },
    ],
    store,
    clock: fixedClock('2026-09-24T00:00:00.000Z'),
  });
  const recorded = await recorder.execute('binding-a', 'fetch-logs', { service: 'checkout' });
  assert.equal(recorded.provenance.credentialRefId, 'old-ref');

  const replayingSource = buildRefusingToBeCalledSource({ adapterId: 'fixture-adapter', version: '1.0.0' });
  const replayer = createBoundSourceRegistry({
    mode: 'replay',
    // Same sourceBindingId/adapter (so the replay identity still hits) but
    // rebound to a DIFFERENT credentialRefId than the one that was recorded.
    bindings: [{ sourceBindingId: 'binding-a', source: replayingSource, credentialRefId: 'new-ref' }],
    store,
    clock: fixedClock('2099-01-01T00:00:00.000Z'),
  });

  const replayed = await replayer.execute('binding-a', 'fetch-logs', { service: 'checkout' });

  assert.equal(replayingSource.calls.length, 0, 'replay must never call the adapter, even on a hit');
  assert.equal(replayed.status, 'ok');
  assert.equal(
    replayed.provenance.credentialRefId,
    'new-ref',
    'credentialRefId must be recomputed from the CURRENT (replaying) binding, never read back off disk',
  );
  assert.equal(
    replayed.provenance.fetchedAt,
    '2026-09-24T00:00:00.000Z',
    'fetchedAt is the one field a replay hit keeps from the recording',
  );
});

test('replay: a miss (nothing recorded for this identity) is refused unavailable, without calling the adapter', async () => {
  const createBoundSourceRegistry = createBoundSourceRegistryFactory();
  const createMemoryReplayStore = memoryReplayStoreFactory();
  const source = buildRefusingToBeCalledSource();

  const registry = createBoundSourceRegistry({
    mode: 'replay',
    bindings: [{ sourceBindingId: 'binding-a', source, credentialRefId: null }],
    store: createMemoryReplayStore(),
    clock: fixedClock('2026-09-24T00:00:00.000Z'),
  });

  const outcome = await registry.execute('binding-a', 'fetch-logs', { service: 'checkout' });

  assert.equal(outcome.status, 'refused');
  assert.equal(outcome.reason, 'unavailable');
  assert.equal(source.calls.length, 0);
});

test('replay identity includes sourceBindingId: recording under binding-a does not serve a replay call made under binding-b', async () => {
  const createBoundSourceRegistry = createBoundSourceRegistryFactory();
  const createMemoryReplayStore = memoryReplayStoreFactory();
  const store = createMemoryReplayStore();

  const recorder = createBoundSourceRegistry({
    mode: 'record',
    bindings: [{ sourceBindingId: 'binding-a', source: buildOkSource(), credentialRefId: null }],
    store,
    clock: fixedClock('2026-09-24T00:00:00.000Z'),
  });
  await recorder.execute('binding-a', 'fetch-logs', { service: 'checkout' });

  const bReplaySource = buildRefusingToBeCalledSource();
  const replayer = createBoundSourceRegistry({
    mode: 'replay',
    bindings: [{ sourceBindingId: 'binding-b', source: bReplaySource, credentialRefId: null }],
    store,
    clock: fixedClock('2026-09-24T00:00:00.000Z'),
  });

  const outcome = await replayer.execute('binding-b', 'fetch-logs', { service: 'checkout' });

  assert.equal(outcome.status, 'refused');
  assert.equal(outcome.reason, 'unavailable');
  assert.equal(bReplaySource.calls.length, 0);
});

test('replay identity includes the adapter VERSION: a recording made under version 1.0.0 is a miss when replayed through a binding whose source now reports 2.0.0', async () => {
  const createBoundSourceRegistry = createBoundSourceRegistryFactory();
  const createMemoryReplayStore = memoryReplayStoreFactory();
  const store = createMemoryReplayStore();

  const recorder = createBoundSourceRegistry({
    mode: 'record',
    bindings: [
      { sourceBindingId: 'binding-a', source: buildOkSource({ version: '1.0.0' }), credentialRefId: null },
    ],
    store,
    clock: fixedClock('2026-09-24T00:00:00.000Z'),
  });
  await recorder.execute('binding-a', 'fetch-logs', { service: 'checkout' });

  const upgradedSource = buildRefusingToBeCalledSource({ version: '2.0.0' });
  const replayer = createBoundSourceRegistry({
    mode: 'replay',
    bindings: [{ sourceBindingId: 'binding-a', source: upgradedSource, credentialRefId: null }],
    store,
    clock: fixedClock('2026-09-24T00:00:00.000Z'),
  });

  const outcome = await replayer.execute('binding-a', 'fetch-logs', { service: 'checkout' });

  assert.equal(outcome.status, 'refused');
  assert.equal(outcome.reason, 'unavailable');
  assert.equal(upgradedSource.calls.length, 0);
});

test('replay identity does not collide across a `:` inside a part: binding \'a\' + adapter \'b:c@1\' and binding \'a:b\' + adapter \'c@1\' are DIFFERENT identities (code-reviewer blocker 1)', async () => {
  const createBoundSourceRegistry = createBoundSourceRegistryFactory();
  const createMemoryReplayStore = memoryReplayStoreFactory();
  const store = createMemoryReplayStore();

  // adapter string is `${adapterId}@${version}` — adapterId 'b:c', version
  // '1' produces the adapter string 'b:c@1'.
  const recorder = createBoundSourceRegistry({
    mode: 'record',
    bindings: [
      { sourceBindingId: 'a', source: buildOkSource({ adapterId: 'b:c', version: '1' }), credentialRefId: null },
    ],
    store,
    clock: fixedClock('2026-09-24T00:00:00.000Z'),
  });

  const recorded = await recorder.execute('a', 'fetch-logs', { service: 'checkout' });
  assert.equal(recorded.status, 'ok');

  // Old, buggy colon-joined identity for THIS call would be
  // "v2:a:b:c@1:<fingerprint>" — byte-identical to the colon-joined identity
  // for sourceBindingId 'a:b' + adapter 'c@1' + the SAME fingerprint. Prove
  // the two never collide: a replay under the other binding/adapter pair,
  // over the identical operation/input (so the fingerprint truly matches),
  // must be a miss.
  const collidingSource = buildRefusingToBeCalledSource({ adapterId: 'c', version: '1' });
  const replayer = createBoundSourceRegistry({
    mode: 'replay',
    bindings: [{ sourceBindingId: 'a:b', source: collidingSource, credentialRefId: null }],
    store,
    clock: fixedClock('2026-09-24T00:00:00.000Z'),
  });

  const outcome = await replayer.execute('a:b', 'fetch-logs', { service: 'checkout' });

  assert.equal(outcome.status, 'refused');
  assert.equal(outcome.reason, 'unavailable', 'binding \'a:b\' + adapter \'c@1\' must never be served binding \'a\' + adapter \'b:c@1\'\'s recording');
  assert.equal(collidingSource.calls.length, 0);
});

/* -------------------------------------------------------------------------- */
/* rekeyReplayRecordings — the ONLY explicit migration path                   */
/* -------------------------------------------------------------------------- */

test('rekeyReplayRecordings migrates a matching recording to the new adapter version, updates its stored provenance.adapter, and returns the count migrated', async () => {
  const createBoundSourceRegistry = createBoundSourceRegistryFactory();
  const createMemoryReplayStore = memoryReplayStoreFactory();
  const rekeyReplayRecordings = rekeyReplayRecordingsFactory();
  const store = createMemoryReplayStore();

  const recorder = createBoundSourceRegistry({
    mode: 'record',
    bindings: [
      { sourceBindingId: 'binding-a', source: buildOkSource({ version: '1.0.0' }), credentialRefId: null },
    ],
    store,
    clock: fixedClock('2026-09-24T00:00:00.000Z'),
  });
  await recorder.execute('binding-a', 'fetch-logs', { service: 'checkout' });

  const migratedCount = await rekeyReplayRecordings(store, {
    sourceBindingId: 'binding-a',
    fromAdapter: 'fixture-adapter@1.0.0',
    toAdapter: 'fixture-adapter@2.0.0',
  });
  assert.equal(migratedCount, 1);

  const expectedFingerprint = handBuiltFingerprint('fetch-logs', { service: 'checkout' });
  const newIdentity = handBuiltIdentity({
    sourceBindingId: 'binding-a',
    adapter: 'fixture-adapter@2.0.0',
    requestFingerprint: expectedFingerprint,
  });
  const oldIdentity = handBuiltIdentity({
    sourceBindingId: 'binding-a',
    adapter: 'fixture-adapter@1.0.0',
    requestFingerprint: expectedFingerprint,
  });

  const migrated = await store.get(newIdentity);
  assert.ok(migrated, 'the recording must now be readable under the NEW identity');
  assert.equal(migrated.provenance.adapter, 'fixture-adapter@2.0.0', 'the migrated recording\'s own provenance.adapter must be updated too');

  const stale = await store.get(oldIdentity);
  assert.equal(stale, undefined, 'the OLD identity must no longer resolve, once migrated');

  const upgradedSource = buildRefusingToBeCalledSource({ version: '2.0.0' });
  const replayer = createBoundSourceRegistry({
    mode: 'replay',
    bindings: [{ sourceBindingId: 'binding-a', source: upgradedSource, credentialRefId: null }],
    store,
    clock: fixedClock('2026-09-24T00:00:00.000Z'),
  });
  const replayed = await replayer.execute('binding-a', 'fetch-logs', { service: 'checkout' });
  assert.equal(replayed.status, 'ok', 'after an explicit migration, replay under the new adapter version must hit');
});

test('rekeyReplayRecordings migrates over a FILE store too: the count, the new key, the stored provenance.adapter, an untouched non-matching entry, and a replay hit from a fresh store over the same file', async (t) => {
  const createBoundSourceRegistry = createBoundSourceRegistryFactory();
  const createFileReplayStore = fileReplayStoreFactory();
  const rekeyReplayRecordings = rekeyReplayRecordingsFactory();
  const path = join(withScratchDir(t), 'recordings.json');
  const store = createFileReplayStore(path);

  const recorder = createBoundSourceRegistry({
    mode: 'record',
    bindings: [
      { sourceBindingId: 'binding-a', source: buildOkSource({ version: '1.0.0' }), credentialRefId: null },
      { sourceBindingId: 'binding-b', source: buildOkSource({ version: '1.0.0' }), credentialRefId: null },
    ],
    store,
    clock: fixedClock('2026-09-24T00:00:00.000Z'),
  });
  await recorder.execute('binding-a', 'fetch-logs', { service: 'checkout' });
  await recorder.execute('binding-b', 'fetch-logs', { service: 'checkout' });

  const migratedCount = await rekeyReplayRecordings(store, {
    sourceBindingId: 'binding-a',
    fromAdapter: 'fixture-adapter@1.0.0',
    toAdapter: 'fixture-adapter@2.0.0',
  });
  assert.equal(migratedCount, 1);

  const fingerprint = handBuiltFingerprint('fetch-logs', { service: 'checkout' });
  const onDisk = JSON.parse(readFileSync(path, 'utf8'));
  const newIdentity = handBuiltIdentity({ sourceBindingId: 'binding-a', adapter: 'fixture-adapter@2.0.0', requestFingerprint: fingerprint });
  const oldIdentity = handBuiltIdentity({ sourceBindingId: 'binding-a', adapter: 'fixture-adapter@1.0.0', requestFingerprint: fingerprint });
  const untouchedIdentity = handBuiltIdentity({ sourceBindingId: 'binding-b', adapter: 'fixture-adapter@1.0.0', requestFingerprint: fingerprint });
  assert.deepEqual(Object.keys(onDisk).sort(), [newIdentity, untouchedIdentity].sort(), 'the file holds the migrated key and the untouched entry, and no longer the old key');
  assert.equal(onDisk[newIdentity].provenance.adapter, 'fixture-adapter@2.0.0');
  assert.equal(onDisk[untouchedIdentity].provenance.adapter, 'fixture-adapter@1.0.0');
  assert.equal(Object.hasOwn(onDisk, oldIdentity), false);

  const replayer = createBoundSourceRegistry({
    mode: 'replay',
    bindings: [{ sourceBindingId: 'binding-a', source: buildRefusingToBeCalledSource({ version: '2.0.0' }), credentialRefId: null }],
    store: createFileReplayStore(path),
    clock: fixedClock('2026-09-24T00:00:00.000Z'),
  });
  const replayed = await replayer.execute('binding-a', 'fetch-logs', { service: 'checkout' });
  assert.equal(replayed.status, 'ok', 'after the migration, a fresh file store over the same path serves the new adapter version');
});

test('rekeyReplayRecordings leaves an unrelated recording (a different sourceBindingId) untouched — nothing re-keys implicitly', async () => {
  const createBoundSourceRegistry = createBoundSourceRegistryFactory();
  const createMemoryReplayStore = memoryReplayStoreFactory();
  const rekeyReplayRecordings = rekeyReplayRecordingsFactory();
  const store = createMemoryReplayStore();

  const recorder = createBoundSourceRegistry({
    mode: 'record',
    bindings: [
      { sourceBindingId: 'binding-a', source: buildOkSource({ version: '1.0.0' }), credentialRefId: null },
      { sourceBindingId: 'binding-c', source: buildOkSource({ version: '1.0.0' }), credentialRefId: null },
    ],
    store,
    clock: fixedClock('2026-09-24T00:00:00.000Z'),
  });
  await recorder.execute('binding-a', 'fetch-logs', { service: 'checkout' });
  await recorder.execute('binding-c', 'fetch-logs', { service: 'checkout' });

  const migratedCount = await rekeyReplayRecordings(store, {
    sourceBindingId: 'binding-a',
    fromAdapter: 'fixture-adapter@1.0.0',
    toAdapter: 'fixture-adapter@2.0.0',
  });
  assert.equal(migratedCount, 1, 'only binding-a\'s recording matches the migration filter');

  const expectedFingerprint = handBuiltFingerprint('fetch-logs', { service: 'checkout' });
  const untouchedIdentity = handBuiltIdentity({
    sourceBindingId: 'binding-c',
    adapter: 'fixture-adapter@1.0.0',
    requestFingerprint: expectedFingerprint,
  });
  const untouched = await store.get(untouchedIdentity);
  assert.ok(untouched, 'binding-c\'s recording, under a different sourceBindingId, must be left exactly where it was');
  assert.equal(untouched.provenance.adapter, 'fixture-adapter@1.0.0');
});

test('rekeyReplayRecordings is a no-op when fromAdapter === toAdapter: returns 0 and leaves the recording intact and replayable (code-reviewer blocker 3)', async () => {
  const createBoundSourceRegistry = createBoundSourceRegistryFactory();
  const createMemoryReplayStore = memoryReplayStoreFactory();
  const rekeyReplayRecordings = rekeyReplayRecordingsFactory();
  const store = createMemoryReplayStore();

  const recorder = createBoundSourceRegistry({
    mode: 'record',
    bindings: [
      { sourceBindingId: 'binding-a', source: buildOkSource({ version: '1.0.0' }), credentialRefId: null },
    ],
    store,
    clock: fixedClock('2026-09-24T00:00:00.000Z'),
  });
  const recorded = await recorder.execute('binding-a', 'fetch-logs', { service: 'checkout' });

  const migratedCount = await rekeyReplayRecordings(store, {
    sourceBindingId: 'binding-a',
    fromAdapter: 'fixture-adapter@1.0.0',
    toAdapter: 'fixture-adapter@1.0.0',
  });
  assert.equal(migratedCount, 0, 'an equal from/to adapter must never be counted as a migration');

  const expectedFingerprint = handBuiltFingerprint('fetch-logs', { service: 'checkout' });
  const identity = handBuiltIdentity({
    sourceBindingId: 'binding-a',
    adapter: 'fixture-adapter@1.0.0',
    requestFingerprint: expectedFingerprint,
  });
  const stillThere = await store.get(identity);
  assert.deepEqual(stillThere, recorded, 'the recording must be left exactly where it was, byte for byte, not deleted and reinserted');

  const replayingSource = buildRefusingToBeCalledSource({ version: '1.0.0' });
  const replayer = createBoundSourceRegistry({
    mode: 'replay',
    bindings: [{ sourceBindingId: 'binding-a', source: replayingSource, credentialRefId: null }],
    store,
    clock: fixedClock('2026-09-24T00:00:00.000Z'),
  });
  const replayed = await replayer.execute('binding-a', 'fetch-logs', { service: 'checkout' });
  assert.equal(replayed.status, 'ok', 'a no-op rekey must never make the recording unreplayable');
});

test('rekeyReplayRecordings leaves a colon-colliding sourceBindingId (\'a:b\') untouched when rekeying sourceBindingId \'a\' (encoding fix also protects the migration path)', async () => {
  const createBoundSourceRegistry = createBoundSourceRegistryFactory();
  const createMemoryReplayStore = memoryReplayStoreFactory();
  const rekeyReplayRecordings = rekeyReplayRecordingsFactory();
  const store = createMemoryReplayStore();

  const recorder = createBoundSourceRegistry({
    mode: 'record',
    bindings: [
      // adapter string 'b:c@1' (adapterId 'b:c', version '1') — chosen so
      // the OLD colon-joined identity for ('a', 'b:c@1', fp) is
      // byte-identical to the OLD colon-joined identity for
      // ('a:b', 'c@1', fp).
      { sourceBindingId: 'a', source: buildOkSource({ adapterId: 'b:c', version: '1' }), credentialRefId: null },
      { sourceBindingId: 'a:b', source: buildOkSource({ adapterId: 'c', version: '1' }), credentialRefId: null },
    ],
    store,
    clock: fixedClock('2026-09-24T00:00:00.000Z'),
  });
  await recorder.execute('a', 'fetch-logs', { service: 'checkout' });
  const collidingRecorded = await recorder.execute('a:b', 'fetch-logs', { service: 'checkout' });
  assert.equal(collidingRecorded.status, 'ok');

  const migratedCount = await rekeyReplayRecordings(store, {
    sourceBindingId: 'a',
    fromAdapter: 'b:c@1',
    toAdapter: 'b:c@2',
  });
  assert.equal(migratedCount, 1, 'only sourceBindingId \'a\' matches the migration filter');

  const expectedFingerprint = handBuiltFingerprint('fetch-logs', { service: 'checkout' });
  const untouchedIdentity = handBuiltIdentity({
    sourceBindingId: 'a:b',
    adapter: 'c@1',
    requestFingerprint: expectedFingerprint,
  });
  const untouched = await store.get(untouchedIdentity);
  assert.ok(untouched, '\'a:b\'\'s recording must be left exactly where it was, unaffected by rekeying \'a\'');
  assert.equal(untouched.provenance.adapter, 'c@1');
});

/* -------------------------------------------------------------------------- */
/* createFileReplayStore — one JSON file, sorted keys, byte-identical         */
/* regardless of write order                                                  */
/* -------------------------------------------------------------------------- */

test('createFileReplayStore round-trips a recording through get/set in the same process', async (t) => {
  const dir = withScratchDir(t);
  const createFileReplayStore = fileReplayStoreFactory();
  const filePath = join(dir, 'replay-store.json');

  const store = createFileReplayStore(filePath);
  const outcome = {
    status: 'ok',
    output: { lines: ['fixture'] },
    provenance: {
      sourceBindingId: 'binding-a',
      adapter: 'fixture-adapter@1.0.0',
      credentialRefId: null,
      fetchedAt: '2026-09-24T00:00:00.000Z',
      requestFingerprint: handBuiltFingerprint('fetch-logs', { service: 'checkout' }),
    },
  };

  await store.set('v2:binding-a:fixture-adapter@1.0.0:fingerprint-a', outcome);

  assert.ok(existsSync(filePath), 'createFileReplayStore must persist to the given path on set()');
  const roundTripped = await store.get('v2:binding-a:fixture-adapter@1.0.0:fingerprint-a');
  assert.deepEqual(roundTripped, outcome);
});

test('createFileReplayStore writes byte-identical files regardless of the order recordings were set in (sorted keys)', async (t) => {
  const dir = withScratchDir(t);
  const createFileReplayStore = fileReplayStoreFactory();
  const pathAscending = join(dir, 'ascending.json');
  const pathDescending = join(dir, 'descending.json');

  const outcomeA = {
    status: 'ok',
    output: { lines: ['a'] },
    provenance: {
      sourceBindingId: 'binding-a',
      adapter: 'fixture-adapter@1.0.0',
      credentialRefId: null,
      fetchedAt: '2026-09-24T00:00:00.000Z',
      requestFingerprint: handBuiltFingerprint('fetch-logs', { service: 'a' }),
    },
  };
  const outcomeB = {
    status: 'ok',
    output: { lines: ['b'] },
    provenance: {
      sourceBindingId: 'binding-b',
      adapter: 'fixture-adapter@1.0.0',
      credentialRefId: null,
      fetchedAt: '2026-09-24T00:00:00.000Z',
      requestFingerprint: handBuiltFingerprint('fetch-logs', { service: 'b' }),
    },
  };

  const ascendingStore = createFileReplayStore(pathAscending);
  await ascendingStore.set('v2:binding-a:fixture-adapter@1.0.0:aaa', outcomeA);
  await ascendingStore.set('v2:binding-b:fixture-adapter@1.0.0:bbb', outcomeB);

  const descendingStore = createFileReplayStore(pathDescending);
  await descendingStore.set('v2:binding-b:fixture-adapter@1.0.0:bbb', outcomeB);
  await descendingStore.set('v2:binding-a:fixture-adapter@1.0.0:aaa', outcomeA);

  const ascendingBytes = readFileSync(pathAscending);
  const descendingBytes = readFileSync(pathDescending);
  assert.deepEqual(
    ascendingBytes,
    descendingBytes,
    'writing the same two recordings in a different order must produce byte-identical files (object keys sorted on write)',
  );
});

test('createFileReplayStore creates its recordings file with mode 0o600, never world-readable (security blocker 4)', async (t) => {
  const dir = withScratchDir(t);
  const createFileReplayStore = fileReplayStoreFactory();
  const filePath = join(dir, 'permissions.json');

  const store = createFileReplayStore(filePath);
  await store.set('v2:["binding-a","fixture-adapter@1.0.0","fp"]', {
    status: 'ok',
    output: {},
    provenance: {
      sourceBindingId: 'binding-a',
      adapter: 'fixture-adapter@1.0.0',
      credentialRefId: null,
      fetchedAt: '2026-09-24T00:00:00.000Z',
      requestFingerprint: handBuiltFingerprint('fetch-logs', { service: 'checkout' }),
    },
  });

  if (process.platform === 'win32') {
    // POSIX file-mode bits are not meaningful on Windows ACLs; this row is
    // skipped there by stated reason rather than asserted against.
    t.skip('POSIX file-mode bits do not apply on win32');
    return;
  }

  const mode = statSync(filePath).mode & 0o777;
  assert.equal(
    mode,
    0o600,
    `recordings file must be created 0o600 (owner read/write only); got ${mode.toString(8)}`,
  );
});

test('replay over a file that is not valid JSON resolves to a refused adapter_error outcome, never rejects, and no text from the file reaches the serialized outcome (security blocker 5a)', async (t) => {
  const dir = withScratchDir(t);
  const createBoundSourceRegistry = createBoundSourceRegistryFactory();
  const createFileReplayStore = fileReplayStoreFactory();
  const filePath = join(dir, 'corrupt.json');
  const marker = 'zz9-bound-registry-corrupt-file-marker-4471-not-a-real-value';

  writeFileSync(filePath, `{not valid json at all, marker=${marker}`, 'utf8');

  const registry = createBoundSourceRegistry({
    mode: 'replay',
    bindings: [{ sourceBindingId: 'binding-a', source: buildRefusingToBeCalledSource(), credentialRefId: null }],
    store: createFileReplayStore(filePath),
    clock: fixedClock('2026-09-24T00:00:00.000Z'),
  });

  await assert.doesNotReject(async () => {
    const outcome = await registry.execute('binding-a', 'fetch-logs', { service: 'checkout' });
    assert.equal(outcome.status, 'refused');
    assert.equal(outcome.reason, 'adapter_error');
    assert.equal(JSON.stringify(outcome).includes(marker), false, 'no text from the unparseable file may reach the serialized outcome');
  });
});

/**
 * Writes a malformed record UNDER THE STORE'S OWN REAL KEY, rather than a
 * hand-built identity string: a legitimate call is recorded first (through
 * the registry, whatever identity scheme it currently uses), and then that
 * one entry is overwritten in place. This is deliberate — it keeps these
 * three rows correct regardless of which replay-identity encoding is active
 * (see code-reviewer blocker 1), rather than risking a silent identity
 * mismatch that would make the row pass vacuously (a miss, never reaching
 * the malformed-value handling under test) instead of exercising it.
 */
async function replaceRecordedEntryWith(store, malformedRecord) {
  const keys = await store.keys();
  assert.equal(keys.length, 1, 'setup: exactly one legitimate recording must exist before it is corrupted');
  await store.set(keys[0], malformedRecord);
}

test('replay treats a stored record missing provenance as unavailable rather than returning it verbatim (security blocker 5b)', async () => {
  const createBoundSourceRegistry = createBoundSourceRegistryFactory();
  const createMemoryReplayStore = memoryReplayStoreFactory();
  const store = createMemoryReplayStore();

  const recorder = createBoundSourceRegistry({
    mode: 'record',
    bindings: [{ sourceBindingId: 'binding-a', source: buildOkSource(), credentialRefId: null }],
    store,
    clock: fixedClock('2026-09-24T00:00:00.000Z'),
  });
  await recorder.execute('binding-a', 'fetch-logs', { service: 'checkout' });
  await replaceRecordedEntryWith(store, { status: 'ok', output: {} });

  const replayer = createBoundSourceRegistry({
    mode: 'replay',
    bindings: [{ sourceBindingId: 'binding-a', source: buildRefusingToBeCalledSource(), credentialRefId: null }],
    store,
    clock: fixedClock('2026-09-24T00:00:00.000Z'),
  });

  const outcome = await replayer.execute('binding-a', 'fetch-logs', { service: 'checkout' });
  assert.equal(outcome.status, 'refused');
  assert.equal(outcome.reason, 'unavailable');
});

test('replay treats a stored record whose status is neither ok nor refused as unavailable (security blocker 5b)', async () => {
  const createBoundSourceRegistry = createBoundSourceRegistryFactory();
  const createMemoryReplayStore = memoryReplayStoreFactory();
  const store = createMemoryReplayStore();

  const recorder = createBoundSourceRegistry({
    mode: 'record',
    bindings: [{ sourceBindingId: 'binding-a', source: buildOkSource(), credentialRefId: null }],
    store,
    clock: fixedClock('2026-09-24T00:00:00.000Z'),
  });
  await recorder.execute('binding-a', 'fetch-logs', { service: 'checkout' });
  await replaceRecordedEntryWith(store, {
    status: 'not-a-real-status',
    output: {},
    provenance: {
      sourceBindingId: 'binding-a',
      adapter: 'fixture-adapter@1.0.0',
      credentialRefId: null,
      fetchedAt: '2026-09-24T00:00:00.000Z',
      requestFingerprint: handBuiltFingerprint('fetch-logs', { service: 'checkout' }),
    },
  });

  const replayer = createBoundSourceRegistry({
    mode: 'replay',
    bindings: [{ sourceBindingId: 'binding-a', source: buildRefusingToBeCalledSource(), credentialRefId: null }],
    store,
    clock: fixedClock('2026-09-24T00:00:00.000Z'),
  });

  const outcome = await replayer.execute('binding-a', 'fetch-logs', { service: 'checkout' });
  assert.equal(outcome.status, 'refused');
  assert.equal(outcome.reason, 'unavailable');
});

test('replay treats a stored record whose refused reason is outside EVIDENCE_SOURCE_REFUSAL_REASONS as unavailable (security blocker 5b)', async () => {
  const createBoundSourceRegistry = createBoundSourceRegistryFactory();
  const createMemoryReplayStore = memoryReplayStoreFactory();
  const store = createMemoryReplayStore();
  const bogusReason = 'not-a-real-refusal-reason';
  assert.equal(
    tools.EVIDENCE_SOURCE_REFUSAL_REASONS.includes(bogusReason),
    false,
    'the fixture reason must genuinely be outside the five typed reasons',
  );

  const recorder = createBoundSourceRegistry({
    mode: 'record',
    bindings: [{ sourceBindingId: 'binding-a', source: buildOkSource(), credentialRefId: null }],
    store,
    clock: fixedClock('2026-09-24T00:00:00.000Z'),
  });
  await recorder.execute('binding-a', 'fetch-logs', { service: 'checkout' });
  await replaceRecordedEntryWith(store, {
    status: 'refused',
    reason: bogusReason,
    provenance: {
      sourceBindingId: 'binding-a',
      adapter: 'fixture-adapter@1.0.0',
      credentialRefId: null,
      fetchedAt: '2026-09-24T00:00:00.000Z',
      requestFingerprint: handBuiltFingerprint('fetch-logs', { service: 'checkout' }),
    },
  });

  const replayer = createBoundSourceRegistry({
    mode: 'replay',
    bindings: [{ sourceBindingId: 'binding-a', source: buildRefusingToBeCalledSource(), credentialRefId: null }],
    store,
    clock: fixedClock('2026-09-24T00:00:00.000Z'),
  });

  const outcome = await replayer.execute('binding-a', 'fetch-logs', { service: 'checkout' });
  assert.equal(outcome.status, 'refused');
  assert.equal(outcome.reason, 'unavailable');
});

test('createFileReplayStore: a __proto__ key in the file never surfaces through get() for identities like "constructor" or "toString", and does not pollute Object.prototype (security advisory 6)', async (t) => {
  const dir = withScratchDir(t);
  const createFileReplayStore = fileReplayStoreFactory();
  const filePath = join(dir, 'proto.json');

  // Built as raw JSON TEXT, deliberately not via a JS object literal: `{
  // __proto__: x }` in JS source reassigns the object's actual prototype at
  // construction time, which would just make this test's own JSON.stringify
  // serialize "{}" and prove nothing. A hand-written string is what an
  // attacker-controlled recordings file on disk actually looks like — a
  // plain own key literally named "__proto__", which is exactly what
  // JSON.parse (used inside createFileReplayStore) turns it back into: an
  // ordinary own data property, not an actual prototype reassignment.
  writeFileSync(filePath, '{"__proto__":{"polluted":"yes"}}\n', 'utf8');

  const store = createFileReplayStore(filePath);

  assert.equal(
    await store.get('constructor'),
    undefined,
    'get() must never return an inherited Object.prototype member for an identity that was never actually recorded',
  );
  assert.equal(
    await store.get('toString'),
    undefined,
    'get() must never return an inherited Object.prototype member for an identity that was never actually recorded',
  );
  assert.equal(Object.prototype.polluted, undefined, 'reading the file must never pollute the real Object.prototype');
});

test('createFileReplayStore: after a set(), no temporary file is left beside the store in its directory, and the store file still parses as JSON (advisory 7, atomic writes)', async (t) => {
  const dir = withScratchDir(t);
  const createFileReplayStore = fileReplayStoreFactory();
  const filePath = join(dir, 'atomic.json');

  const store = createFileReplayStore(filePath);
  await store.set('v2:["binding-a","fixture-adapter@1.0.0","fp"]', {
    status: 'ok',
    output: {},
    provenance: {
      sourceBindingId: 'binding-a',
      adapter: 'fixture-adapter@1.0.0',
      credentialRefId: null,
      fetchedAt: '2026-09-24T00:00:00.000Z',
      requestFingerprint: handBuiltFingerprint('fetch-logs', { service: 'checkout' }),
    },
  });

  const entries = readdirSync(dir);
  assert.deepEqual(
    entries,
    ['atomic.json'],
    `no temporary file may be left beside the store after set() completes; found ${JSON.stringify(entries)}`,
  );
  assert.doesNotThrow(() => JSON.parse(readFileSync(filePath, 'utf8')), 'the store file itself must still parse as JSON');
});

/* -------------------------------------------------------------------------- */
/* Determinism across a real process restart, over a real file                */
/* -------------------------------------------------------------------------- */

test('record/replay is deterministic across a process restart: a recording made in this process replays identically in a freshly spawned child process, over the same file', async (t) => {
  const dir = withScratchDir(t);
  const createBoundSourceRegistry = createBoundSourceRegistryFactory();
  const createFileReplayStore = fileReplayStoreFactory();
  const filePath = join(dir, 'restart-replay-store.json');

  const recordingSource = createDeterministicEvidenceSource();
  const recorder = createBoundSourceRegistry({
    mode: 'record',
    bindings: [{ sourceBindingId: 'binding-restart', source: recordingSource, credentialRefId: 'ref-restart' }],
    store: createFileReplayStore(filePath),
    clock: fixedClock('2026-09-24T00:00:00.000Z'),
  });

  const recorded = await recorder.execute('binding-restart', FIXTURE_OPERATION, FIXTURE_INPUT);
  assert.equal(recorded.status, 'ok');
  assert.ok(existsSync(filePath));

  const child = spawnSync(
    process.execPath,
    [childWorkerPath, filePath, 'binding-restart', 'ref-restart'],
    {
      cwd: projectRoot,
      encoding: 'utf8',
      env: childEnv(),
    },
  );

  assert.equal(
    child.status,
    0,
    `replay child process exited ${child.status}\nstdout:\n${child.stdout}\nstderr:\n${child.stderr}`,
  );

  const replayed = JSON.parse(child.stdout);
  assert.deepEqual(
    replayed,
    recorded,
    'a fresh file-store instance, in a genuinely separate process, must replay the exact outcome that was recorded — including fetchedAt, which must be the RECORDED time, not anything the child\'s own (sentinel, far-future) clock could have produced',
  );
});

/* -------------------------------------------------------------------------- */
/* AIC-100 slice c — timeout budget, real timers                              */
/* -------------------------------------------------------------------------- */

test(
  'live: a source whose execute() never settles is refused timeout within the configured budget, using real timers',
  { timeout: 5000 },
  async () => {
    const createBoundSourceRegistry = createBoundSourceRegistryFactory();
    const createMemoryReplayStore = memoryReplayStoreFactory();

    const calls = [];
    const hangingSource = {
      describe: () => ({ adapterId: 'fixture-adapter', version: '1.0.0', operations: ['fetch-logs'] }),
      check: async () => ({ status: 'ready' }),
      execute: async (operation, input) => {
        calls.push({ operation, input });
        return new Promise(() => {}); // never settles
      },
    };

    const registry = createBoundSourceRegistry({
      mode: 'live',
      bindings: [{ sourceBindingId: 'binding-a', source: hangingSource, credentialRefId: null }],
      store: createMemoryReplayStore(),
      clock: fixedClock('2026-09-24T00:00:00.000Z'),
      budgets: { timeoutMs: 50, maxResultBytes: 1_000_000, maxPages: 100 },
    });

    const startedAt = Date.now();
    const outcome = await registry.execute('binding-a', 'fetch-logs', { service: 'checkout' });
    const elapsedMs = Date.now() - startedAt;

    assert.equal(outcome.status, 'refused');
    assert.equal(outcome.reason, 'timeout');
    assert.equal(calls.length, 1);
    assert.ok(
      elapsedMs < 2000,
      `execute() must resolve within a generous bound of the 50ms timeout budget; took ${elapsedMs}ms`,
    );
  },
);

test(
  'live: a source whose execute() settles ok AFTER the timeout budget is still refused timeout, not ok',
  { timeout: 5000 },
  async () => {
    const createBoundSourceRegistry = createBoundSourceRegistryFactory();
    const createMemoryReplayStore = memoryReplayStoreFactory();

    const lateSource = {
      describe: () => ({ adapterId: 'fixture-adapter', version: '1.0.0', operations: ['fetch-logs'] }),
      check: async () => ({ status: 'ready' }),
      execute: async () => {
        await new Promise((resolveAfterDelay) => setTimeout(resolveAfterDelay, 300));
        return {
          status: 'ok',
          output: { lines: ['too late'] },
          provenance: {
            sourceBindingId: 'not-the-real-binding',
            adapter: 'not-the-real-adapter@0.0.0',
            credentialRefId: 'wrongcredentialplaceholder',
            fetchedAt: '1970-01-01T00:00:00.000Z',
            requestFingerprint: 'sha256:not-the-real-fingerprint',
          },
        };
      },
    };

    const registry = createBoundSourceRegistry({
      mode: 'live',
      bindings: [{ sourceBindingId: 'binding-a', source: lateSource, credentialRefId: null }],
      store: createMemoryReplayStore(),
      clock: fixedClock('2026-09-24T00:00:00.000Z'),
      budgets: { timeoutMs: 50, maxResultBytes: 1_000_000, maxPages: 100 },
    });

    const outcome = await registry.execute('binding-a', 'fetch-logs', { service: 'checkout' });

    assert.equal(outcome.status, 'refused');
    assert.equal(outcome.reason, 'timeout');
  },
);

/* -------------------------------------------------------------------------- */
/* AIC-100 slice c — result-size budget                                      */
/* -------------------------------------------------------------------------- */

test('live: an ok outcome whose output is exactly at maxResultBytes is ok, not refused', async () => {
  const createBoundSourceRegistry = createBoundSourceRegistryFactory();
  const createMemoryReplayStore = memoryReplayStoreFactory();
  const output = buildJsonObjectOfByteSize(64);
  const source = buildOkSourceWithOutput(output);

  const registry = createBoundSourceRegistry({
    mode: 'live',
    bindings: [{ sourceBindingId: 'binding-a', source, credentialRefId: null }],
    store: createMemoryReplayStore(),
    clock: fixedClock('2026-09-24T00:00:00.000Z'),
    budgets: { timeoutMs: 5000, maxResultBytes: 64, maxPages: 100 },
  });

  const outcome = await registry.execute('binding-a', 'fetch-logs', { service: 'checkout' });

  assert.equal(outcome.status, 'ok', 'exactly at the cap must still be ok, not refused');
});

test('live: an ok outcome whose output exceeds maxResultBytes by a single byte is refused budget_exceeded', async () => {
  const createBoundSourceRegistry = createBoundSourceRegistryFactory();
  const createMemoryReplayStore = memoryReplayStoreFactory();
  const output = buildJsonObjectOfByteSize(65);
  const source = buildOkSourceWithOutput(output);

  const registry = createBoundSourceRegistry({
    mode: 'live',
    bindings: [{ sourceBindingId: 'binding-a', source, credentialRefId: null }],
    store: createMemoryReplayStore(),
    clock: fixedClock('2026-09-24T00:00:00.000Z'),
    budgets: { timeoutMs: 5000, maxResultBytes: 64, maxPages: 100 },
  });

  const outcome = await registry.execute('binding-a', 'fetch-logs', { service: 'checkout' });

  assert.equal(outcome.status, 'refused');
  assert.equal(outcome.reason, 'budget_exceeded');
});

/* -------------------------------------------------------------------------- */
/* AIC-100 slice c — pagination budget passed to the adapter                  */
/* -------------------------------------------------------------------------- */

test('registry.execute passes { maxPages } to the adapter as execute\'s third, additive argument', async () => {
  const createBoundSourceRegistry = createBoundSourceRegistryFactory();
  const createMemoryReplayStore = memoryReplayStoreFactory();
  const source = buildOkSourceWithOutput({ lines: ['fixture output'] });

  const registry = createBoundSourceRegistry({
    mode: 'live',
    bindings: [{ sourceBindingId: 'binding-a', source, credentialRefId: null }],
    store: createMemoryReplayStore(),
    clock: fixedClock('2026-09-24T00:00:00.000Z'),
    budgets: { timeoutMs: 5000, maxResultBytes: 1_000_000, maxPages: 7 },
  });

  await registry.execute('binding-a', 'fetch-logs', { service: 'checkout' });

  assert.equal(source.calls.length, 1);
  assert.deepEqual(
    source.calls[0].budgetHints,
    { maxPages: 7 },
    'execute\'s third argument must be exactly { maxPages }, taken from the registry\'s configured budgets — nothing else',
  );
});

test('an adapter that throws EvidenceSourceError(budget_exceeded) to signal it stopped at the page budget is refused budget_exceeded', async () => {
  const createBoundSourceRegistry = createBoundSourceRegistryFactory();
  const createMemoryReplayStore = memoryReplayStoreFactory();
  const error = new tools.EvidenceSourceError('stopped at the page budget', { reason: 'budget_exceeded' });
  const source = buildThrowingSource({ error });

  const registry = createBoundSourceRegistry({
    mode: 'live',
    bindings: [{ sourceBindingId: 'binding-a', source, credentialRefId: null }],
    store: createMemoryReplayStore(),
    clock: fixedClock('2026-09-24T00:00:00.000Z'),
    budgets: { timeoutMs: 5000, maxResultBytes: 1_000_000, maxPages: 2 },
  });

  const outcome = await registry.execute('binding-a', 'fetch-logs', { service: 'checkout' });

  assert.equal(outcome.status, 'refused');
  assert.equal(outcome.reason, 'budget_exceeded');
});

/* -------------------------------------------------------------------------- */
/* AIC-100 slice c — replay never re-applies a budget                        */
/* -------------------------------------------------------------------------- */

test('replay does not re-check maxResultBytes: a recording made under a generous record-time budget still replays ok under a far stricter replay-time budget', async () => {
  const createBoundSourceRegistry = createBoundSourceRegistryFactory();
  const createMemoryReplayStore = memoryReplayStoreFactory();
  const store = createMemoryReplayStore();
  const largeOutput = buildJsonObjectOfByteSize(200);

  const recorder = createBoundSourceRegistry({
    mode: 'record',
    bindings: [{ sourceBindingId: 'binding-a', source: buildOkSourceWithOutput(largeOutput), credentialRefId: null }],
    store,
    clock: fixedClock('2026-09-24T00:00:00.000Z'),
    budgets: { timeoutMs: 5000, maxResultBytes: 1_000_000, maxPages: 10 },
  });
  const recorded = await recorder.execute('binding-a', 'fetch-logs', { service: 'checkout' });
  assert.equal(recorded.status, 'ok', 'setup: recording must succeed under the generous record-time budget');

  const replayer = createBoundSourceRegistry({
    mode: 'replay',
    bindings: [{ sourceBindingId: 'binding-a', source: buildRefusingToBeCalledSource(), credentialRefId: null }],
    store,
    clock: fixedClock('2026-09-24T00:00:00.000Z'),
    budgets: { timeoutMs: 5000, maxResultBytes: 10, maxPages: 10 },
  });
  const replayed = await replayer.execute('binding-a', 'fetch-logs', { service: 'checkout' });

  assert.equal(
    replayed.status,
    'ok',
    'replay must serve the recording as-is, never re-checking maxResultBytes against the REPLAYING budget',
  );
});

/* -------------------------------------------------------------------------- */
/* AIC-100 slice c — redactEvidenceOutput: pattern rows and near-misses       */
/* -------------------------------------------------------------------------- */

test('redactEvidenceOutput replaces a GitHub-token-shaped string with [REDACTED], keeping surrounding text', () => {
  const redactEvidenceOutput = redactEvidenceOutputFactory();
  const input = `token=${fixtureGithubToken} appeared in the log line`;
  assert.equal(redactEvidenceOutput(input), 'token=[REDACTED] appeared in the log line');
});

test('redactEvidenceOutput leaves a GitHub-token-shaped string one character too short alone (near miss)', () => {
  const redactEvidenceOutput = redactEvidenceOutputFactory();
  const input = `token=${fixtureGithubTokenTooShort} appeared in the log line`;
  assert.equal(redactEvidenceOutput(input), input);
});

test('redactEvidenceOutput replaces an AWS-access-key-id-shaped string with [REDACTED]', () => {
  const redactEvidenceOutput = redactEvidenceOutputFactory();
  const input = `key id ${fixtureAwsAccessKeyId} was rejected`;
  assert.equal(redactEvidenceOutput(input), 'key id [REDACTED] was rejected');
});

test('redactEvidenceOutput leaves an AWS-access-key-id-shaped string one character too short alone (near miss)', () => {
  const redactEvidenceOutput = redactEvidenceOutputFactory();
  const input = `key id ${fixtureAwsAccessKeyIdTooShort} was rejected`;
  assert.equal(redactEvidenceOutput(input), input);
});

test('redactEvidenceOutput replaces a "Bearer <token>" credential in text with [REDACTED], dropping the token entirely', () => {
  const redactEvidenceOutput = redactEvidenceOutputFactory();
  const input = `Authorization: ${fixtureBearerCredential}`;
  assert.equal(redactEvidenceOutput(input), 'Authorization: [REDACTED]');
});

test('redactEvidenceOutput leaves a "Bearer <token>" text alone when the token is under 20 characters (near miss)', () => {
  const redactEvidenceOutput = redactEvidenceOutputFactory();
  const input = `Authorization: ${fixtureBearerCredentialTooShort}`;
  assert.equal(redactEvidenceOutput(input), input);
});

// Rewritten under the owner's fail-closed ruling, 2026-09-25: after four
// review rounds in which each PEM-regex fix on the header/footer gap opened a
// new leak (round 1's same-line near-miss below was the ORIGINAL shape of
// this row — it once pinned that " follows" survived on the header's own
// line), the owner chose SUBTRACTION over a fifth regex patch — see this
// file's "review round 4" block further down for the contract this row now
// pins: a footer-less PEM header redacts EVERYTHING from the header to the
// END OF THE STRING, fail closed, because there is no footer to bound it.
// The prefix "key material: " still survives; " follows" no longer does,
// because it is text AFTER a footer-less header, not text before one.
test('redactEvidenceOutput redacts a footer-less PEM header through the end of the string, fail closed: "key material: " survives, " follows" does not (owner fail-closed ruling, 2026-09-25 — supersedes the original same-line near-miss this row pinned)', () => {
  const redactEvidenceOutput = redactEvidenceOutputFactory();
  const input = `key material: ${fixturePemHeader} follows`;
  assert.equal(redactEvidenceOutput(input), 'key material: [REDACTED]');
});

test('redactEvidenceOutput leaves a non-private-key PEM header (a certificate) alone (near miss)', () => {
  const redactEvidenceOutput = redactEvidenceOutputFactory();
  const input = `key material: ${fixtureNonPrivatePemHeader} follows`;
  assert.equal(redactEvidenceOutput(input), input);
});

test('redactEvidenceOutput redacts inline user:pass credentials in a URL, keeping the scheme and host', () => {
  const redactEvidenceOutput = redactEvidenceOutputFactory();
  const input = `see https://${fixtureUrlCredentialPart}@example.com/path for details`;
  assert.equal(redactEvidenceOutput(input), 'see https://[REDACTED]@example.com/path for details');
});

test('redactEvidenceOutput leaves a URL with no inline credentials alone (near miss)', () => {
  const redactEvidenceOutput = redactEvidenceOutputFactory();
  const input = 'see https://example.com/path for details';
  assert.equal(redactEvidenceOutput(input), input);
});

test('redactEvidenceOutput replaces a Slack-token-shaped string with [REDACTED]', () => {
  const redactEvidenceOutput = redactEvidenceOutputFactory();
  const input = `webhook token ${fixtureSlackToken} leaked`;
  assert.equal(redactEvidenceOutput(input), 'webhook token [REDACTED] leaked');
});

test('redactEvidenceOutput leaves a string with an unrecognised xox-letter alone (near miss: xoxq- is not one of a/b/p/r)', () => {
  const redactEvidenceOutput = redactEvidenceOutputFactory();
  const input = `webhook token ${fixtureSlackTokenWrongLetter} leaked`;
  assert.equal(redactEvidenceOutput(input), input);
});

test('redactEvidenceOutput recurses into arrays and objects, keeps object keys, and leaves a number, boolean or null value unchanged (review round 1: title corrected to name exactly what this row pins, code-reviewer blocker 3)', () => {
  const redactEvidenceOutput = redactEvidenceOutputFactory();
  const input = {
    id: 42,
    ok: true,
    nothing: null,
    list: [1, 'plain text', fixtureGithubToken],
    nested: { inner: fixtureGithubToken, count: 3 },
  };

  const output = redactEvidenceOutput(input);

  assert.deepEqual(Object.keys(output).sort(), Object.keys(input).sort(), 'keys must be kept, in the same set');
  assert.equal(output.id, 42);
  assert.equal(output.ok, true);
  assert.equal(output.nothing, null);
  assert.equal(output.list[0], 1);
  assert.equal(output.list[1], 'plain text');
  assert.equal(output.list[2], '[REDACTED]');
  assert.equal(output.nested.inner, '[REDACTED]');
  assert.equal(output.nested.count, 3);
});

/* -------------------------------------------------------------------------- */
/* AIC-100 slice c — MAX_REDACTION_DEPTH: fail closed, bounded work           */
/* -------------------------------------------------------------------------- */

test('a credential nested strictly within MAX_REDACTION_DEPTH is still redacted normally', () => {
  const redactEvidenceOutput = redactEvidenceOutputFactory();
  const maxDepth = maxRedactionDepthFactory();

  const levels = Math.max(1, maxDepth - 2);
  let value = fixtureGithubToken;
  for (let i = 0; i < levels; i += 1) {
    value = [value];
  }

  const redacted = redactEvidenceOutput(value);

  let cursor = redacted;
  for (let i = 0; i < levels; i += 1) {
    assert.ok(Array.isArray(cursor), `expected an array at nesting level ${i}, within the depth cap`);
    cursor = cursor[0];
  }
  assert.equal(cursor, '[REDACTED]', 'a credential within the depth cap must still be redacted normally, not the depth sentinel');
});

test('a value nested beyond MAX_REDACTION_DEPTH is replaced with the fixed sentinel [REDACTED:depth], fail closed rather than recursing further', () => {
  const redactEvidenceOutput = redactEvidenceOutputFactory();
  const maxDepth = maxRedactionDepthFactory();

  const levels = maxDepth + 5;
  let value = 'deeply-nested-leaf-marker-never-a-credential';
  for (let i = 0; i < levels; i += 1) {
    value = [value];
  }

  const redacted = redactEvidenceOutput(value);

  let cursor = redacted;
  let steps = 0;
  while (Array.isArray(cursor) && steps < levels) {
    cursor = cursor[0];
    steps += 1;
  }

  assert.equal(
    cursor,
    '[REDACTED:depth]',
    'past the documented depth cap, redactEvidenceOutput must fail closed to a fixed sentinel rather than continuing to recurse indefinitely',
  );
});

test('redactEvidenceOutput does not stack-overflow on input far past the depth cap (bounded work, invariants.md)', () => {
  const redactEvidenceOutput = redactEvidenceOutputFactory();
  const maxDepth = maxRedactionDepthFactory();

  const levels = maxDepth + 20000;
  let value = 'leaf';
  for (let i = 0; i < levels; i += 1) {
    value = [value];
  }

  assert.doesNotThrow(() => redactEvidenceOutput(value));
});

/* -------------------------------------------------------------------------- */
/* AIC-100 slice c — the registry redacts BEFORE persistence and BEFORE      */
/* returning the outcome to its caller                                       */
/* -------------------------------------------------------------------------- */

test('record mode redacts a credential in the output BEFORE store.set: neither the returned outcome nor the stored recording carries it', async () => {
  const createBoundSourceRegistry = createBoundSourceRegistryFactory();
  const createMemoryReplayStore = memoryReplayStoreFactory();
  const store = createMemoryReplayStore();
  const source = buildOkSourceWithOutput({ lines: [`leaked: ${fixtureGithubToken}`] });

  const registry = createBoundSourceRegistry({
    mode: 'record',
    bindings: [{ sourceBindingId: 'binding-a', source, credentialRefId: null }],
    store,
    clock: fixedClock('2026-09-24T00:00:00.000Z'),
  });

  const returned = await registry.execute('binding-a', 'fetch-logs', { service: 'checkout' });
  assert.equal(returned.status, 'ok');
  assert.equal(
    JSON.stringify(returned).includes(fixtureGithubToken),
    false,
    'the outcome RETURNED to the caller in record mode must already be redacted',
  );

  const keys = await store.keys();
  assert.equal(keys.length, 1);
  const stored = await store.get(keys[0]);
  assert.equal(
    JSON.stringify(stored).includes(fixtureGithubToken),
    false,
    'the STORED recording must never carry the unredacted credential',
  );
  assert.ok(JSON.stringify(stored).includes('[REDACTED]'), 'the stored recording must carry the redaction marker in its place');
});

test('live mode also redacts the outcome returned to the caller (state and traces are downstream of it)', async () => {
  const createBoundSourceRegistry = createBoundSourceRegistryFactory();
  const createMemoryReplayStore = memoryReplayStoreFactory();
  const source = buildOkSourceWithOutput({ lines: [`leaked: ${fixtureGithubToken}`] });

  const registry = createBoundSourceRegistry({
    mode: 'live',
    bindings: [{ sourceBindingId: 'binding-a', source, credentialRefId: null }],
    store: createMemoryReplayStore(),
    clock: fixedClock('2026-09-24T00:00:00.000Z'),
  });

  const returned = await registry.execute('binding-a', 'fetch-logs', { service: 'checkout' });

  assert.equal(returned.status, 'ok');
  assert.equal(JSON.stringify(returned).includes(fixtureGithubToken), false);
});

test('createFileReplayStore: a recorded credential is redacted before it ever reaches disk (read the file bytes)', async (t) => {
  const dir = withScratchDir(t);
  const createFileReplayStore = fileReplayStoreFactory();
  const createBoundSourceRegistry = createBoundSourceRegistryFactory();
  const filePath = join(dir, 'redacted.json');
  const store = createFileReplayStore(filePath);
  const source = buildOkSourceWithOutput({ lines: [`leaked: ${fixtureAwsAccessKeyId}`] });

  const registry = createBoundSourceRegistry({
    mode: 'record',
    bindings: [{ sourceBindingId: 'binding-a', source, credentialRefId: null }],
    store,
    clock: fixedClock('2026-09-24T00:00:00.000Z'),
  });
  await registry.execute('binding-a', 'fetch-logs', { service: 'checkout' });

  const bytes = readFileSync(filePath, 'utf8');
  assert.equal(
    bytes.includes(fixtureAwsAccessKeyId),
    false,
    'the on-disk recording must never contain the raw credential bytes',
  );
  assert.ok(bytes.includes('[REDACTED]'), 'the on-disk recording must show the redaction marker in its place');
});

test('bound-source-registry.ts no longer documents recordings as UNREDACTED (AIC-100 slice c adds redaction before persistence)', () => {
  const sourcePath = resolve(projectRoot, 'packages/tools/src/bound-source-registry.ts');
  const sourceText = readFileSync(sourcePath, 'utf8');
  assert.equal(
    sourceText.includes('UNREDACTED'),
    false,
    'slice c redacts before persistence — the module\'s own doc comments must no longer claim recordings are UNREDACTED',
  );
});

/* ============================================================================ */
/* AIC-100 slice c — review round 1 findings on redaction.ts /                 */
/* bound-source-registry.ts (this file's own pins for the new behaviour)       */
/*                                                                              */
/* A genuine conflict surfaced while writing these rows, and is NOT resolved   */
/* here (test-writer scope: pin what the finding asks, surface what it        */
/* contradicts rather than silently picking a side — .claude/rules/           */
/* autonomy.md's "Invariant conflict" stop rule): code-reviewer blocker 6      */
/* asks that construction refuse a binding whose describe().adapterId does    */
/* not match SAFE_ADAPTER_TOKEN (no `:` allowed in the pinned example          */
/* pattern), but the existing rows "replay identity does not collide across a */
/* `:` inside a part" and "rekeyReplayRecordings leaves a colon-colliding      */
/* sourceBindingId ('a:b') untouched" (above, code-reviewer blocker 1)         */
/* deliberately construct a binding whose adapterId is `'b:c'` — a `:` inside  */
/* the adapterId is exactly the shape those two rows need to exist at all.    */
/* Enforcing the pinned SAFE_ADAPTER_TOKEN pattern verbatim on adapterId would */
/* make those two already-pinned rows throw at construction, before they ever */
/* reach the behaviour they pin. So below: SAFE_ADAPTER_TOKEN itself and its  */
/* refusal on `version` (no existing row uses an unsafe version) are pinned;  */
/* a construction-refusal keyed on `adapterId` containing `:` is deliberately */
/* NOT added here — see this file's own report to the requester for the      */
/* explicit call-out.                                                         */
/* ============================================================================ */

/* -------------------------------------------------------------------------- */
/* review round 1 fixtures — assembled at runtime, per                        */
/* .claude/scripts/lib/secrets.mjs's vocabulary                               */
/* -------------------------------------------------------------------------- */

/**
 * A multi-line PEM body and footer, paired with the existing `fixturePemHeader`
 * above, to build a full private-key block for the whole-block redaction pin
 * (security blocker 1). Assembled from parts like this file's other
 * credential-shaped fixtures, even though the body lines alone match none of
 * `.claude/scripts/lib/secrets.mjs`'s own patterns.
 */
const fixturePemBodyLine1 = ['MIIEvQIBADANBgkqhkiG9w0BAQEFAASC', 'BKcwggSjAgEAAoIBAQC7VJTUt9Us8cKj'].join('');
const fixturePemBodyLine2 = ['MQIDAQABAoIBAQCoOFV6mfM', 'nMtLzUBLMRRlPGQTQQ8pqI7GTHnCa1Ub'].join('');
const fixturePemFooter = ['-----END ', 'RSA PRIVATE KEY-----'].join('');

/** Inline URL credential parts for a non-http(s) scheme (security advisory 7). */
const fixturePostgresUrlCredentialParts = ['postgres://', 'dbuser', ':', 'dbpass', '@db.internal:5432/app'];

/**
 * A free-text refusal reason an adapter might return instead of one of the
 * six typed reasons (code-reviewer blocker 5) — built from the existing
 * assembled GitHub-token fixture, never written as one literal.
 */
const fixtureFreeTextRefusalReason = `denied for ${fixtureGithubToken}`;

/**
 * Bad adapterId/version tokens for `SAFE_ADAPTER_TOKEN` (code-reviewer
 * blocker 6). `fixtureUrlCredentialPart` (already assembled above, containing
 * a `:`) doubles as this row's "assembled credential" example.
 */
const fixtureBadTokenWithSpace = 'bad version';
const fixtureBadTokenWithAt = 'bad@version';

/**
 * Like `buildOkSource`/`buildThrowingSource` above, but the adapter's own
 * `execute()` RETURNS a `refused` outcome (rather than throwing) carrying a
 * caller-chosen `reason` — the shape code-reviewer blocker 5 is about: an
 * adapter that hands the registry a `refused` outcome whose `reason` is not
 * one of `EVIDENCE_SOURCE_REFUSAL_REASONS`.
 */
function buildSourceReturningRefusal(
  reason,
  { adapterId = 'fixture-adapter', version = '1.0.0', operations = ['fetch-logs'] } = {},
) {
  const calls = [];
  return {
    calls,
    describe: () => ({ adapterId, version, operations }),
    check: async () => ({ status: 'ready' }),
    execute: async (operation, input, budgetHints) => {
      calls.push({ operation, input, budgetHints });
      return {
        status: 'refused',
        reason,
        // Deliberately foreign provenance, matching buildOkSource's own
        // convention — pins that the registry stays the single writer of
        // provenance even for a caller-returned refusal.
        provenance: {
          sourceBindingId: 'not-the-real-binding',
          adapter: 'not-the-real-adapter@0.0.0',
          credentialRefId: 'wrongcredentialplaceholder',
          fetchedAt: '1970-01-01T00:00:00.000Z',
          requestFingerprint: 'sha256:not-the-real-fingerprint',
        },
      };
    },
  };
}

function safeAdapterTokenFactory() {
  assert.ok(
    tools.SAFE_ADAPTER_TOKEN instanceof RegExp,
    '@aic/tools must export SAFE_ADAPTER_TOKEN: RegExp, the safe-token pattern an adapterId/version must match before it is trusted in provenance.adapter (AIC-100 slice c review round 1, code-reviewer blocker 6)',
  );
  return tools.SAFE_ADAPTER_TOKEN;
}

/* -------------------------------------------------------------------------- */
/* security blocker 1 — the WHOLE PEM private-key block is redacted           */
/* -------------------------------------------------------------------------- */

test('redactEvidenceOutput redacts the WHOLE PEM private-key block, including a multi-line base64 body — the body never survives anywhere in the output (review round 1, security blocker 1)', () => {
  const redactEvidenceOutput = redactEvidenceOutputFactory();
  const input = [
    'key material:',
    fixturePemHeader,
    fixturePemBodyLine1,
    fixturePemBodyLine2,
    fixturePemFooter,
    'end',
  ].join('\n');

  const output = redactEvidenceOutput(input);

  assert.equal(
    output.includes(fixturePemBodyLine1),
    false,
    'the PEM body must never survive redaction, anywhere in the output',
  );
  assert.equal(
    output.includes(fixturePemBodyLine2),
    false,
    'the PEM body must never survive redaction, anywhere in the output',
  );
  assert.equal(
    output.includes(fixturePemFooter),
    false,
    'the footer is part of the redacted block too, not left dangling beside a redacted header',
  );
  assert.ok(output.includes('[REDACTED'), 'the redacted block must be replaced with a redaction marker');
});

/* -------------------------------------------------------------------------- */
/* security + code-reviewer blocker 2 — replay redacts a stored ok output too */
/* -------------------------------------------------------------------------- */

test('replay redacts a stored UNREDACTED ok output on a hit: the returned output carries no credential, even though the recording itself was written unredacted (review round 1, security + code-reviewer blocker 2)', async () => {
  const createBoundSourceRegistry = createBoundSourceRegistryFactory();
  const createMemoryReplayStore = memoryReplayStoreFactory();
  const store = createMemoryReplayStore();

  const fingerprint = handBuiltFingerprint('fetch-logs', { service: 'checkout' });
  const identity = handBuiltIdentity({
    sourceBindingId: 'binding-a',
    adapter: 'fixture-adapter@1.0.0',
    requestFingerprint: fingerprint,
  });

  // Written UNREDACTED, directly under the registry's own identity scheme —
  // built by hand exactly like the existing "replay treats a stored record …"
  // rows above, as if an older recording (made before redaction shipped, or
  // written by a caller that bypassed the registry) still carries a raw
  // credential.
  await store.set(identity, {
    status: 'ok',
    output: { lines: [`leaked: ${fixtureGithubToken}`] },
    provenance: {
      sourceBindingId: 'binding-a',
      adapter: 'fixture-adapter@1.0.0',
      credentialRefId: null,
      fetchedAt: '2026-09-24T00:00:00.000Z',
      requestFingerprint: fingerprint,
    },
  });

  const replayer = createBoundSourceRegistry({
    mode: 'replay',
    bindings: [{ sourceBindingId: 'binding-a', source: buildRefusingToBeCalledSource(), credentialRefId: null }],
    store,
    clock: fixedClock('2026-09-24T00:00:00.000Z'),
  });

  const replayed = await replayer.execute('binding-a', 'fetch-logs', { service: 'checkout' });

  assert.equal(replayed.status, 'ok');
  assert.equal(
    JSON.stringify(replayed).includes(fixtureGithubToken),
    false,
    'a replay hit must redact a stored ok output\'s credential before returning it, even when the stored recording itself was unredacted',
  );
});

/* -------------------------------------------------------------------------- */
/* security + code-reviewer blocker 3 — unsupported container types fail      */
/* closed to a fixed sentinel, never walked as numeric keys, never emptied    */
/* -------------------------------------------------------------------------- */

const UNSUPPORTED_REDACTION_VALUE_ROWS = [
  { label: 'a Buffer', build: () => Buffer.from('buffer content is not JSON-shaped') },
  { label: 'a Map', build: () => new Map([['key', 'value']]) },
  { label: 'a Set', build: () => new Set(['value']) },
  { label: 'a Date', build: () => new Date('2026-09-24T00:00:00.000Z') },
  { label: 'an Error', build: () => new Error('adapter-thrown value embedded in output') },
];

for (const { label, build } of UNSUPPORTED_REDACTION_VALUE_ROWS) {
  test(`redactEvidenceOutput replaces ${label} anywhere in the walked value with the fixed sentinel [REDACTED:unsupported] — fail closed, never walked as numeric keys, never silently emptied to {} (review round 1, security + code-reviewer blocker 3)`, () => {
    const redactEvidenceOutput = redactEvidenceOutputFactory();
    const value = build();

    assert.equal(
      redactEvidenceOutput(value),
      '[REDACTED:unsupported]',
      `${label} at the top level must fail closed to the fixed sentinel`,
    );

    const nested = { safe: 'kept', unsupported: value, list: [value] };
    const output = redactEvidenceOutput(nested);

    assert.equal(output.safe, 'kept', 'a plain object is still walked normally alongside an unsupported value');
    assert.equal(output.unsupported, '[REDACTED:unsupported]');
    assert.equal(output.list[0], '[REDACTED:unsupported]', 'arrays are still walked normally too');
  });
}

/* -------------------------------------------------------------------------- */
/* code-reviewer blocker 4 — __proto__ is kept as an own key, never consumed  */
/* as a prototype reassignment                                                */
/* -------------------------------------------------------------------------- */

test('a __proto__ own key in adapter output is KEPT as an own key in the returned and persisted output, and the output\'s prototype is never adapter-controlled (review round 1, code-reviewer blocker 4)', async () => {
  const createBoundSourceRegistry = createBoundSourceRegistryFactory();
  const createMemoryReplayStore = memoryReplayStoreFactory();
  const store = createMemoryReplayStore();

  // Built from JSON TEXT, not a JS object literal — `{ __proto__: x }` in JS
  // source reassigns the object's real prototype at construction time, which
  // would prove nothing about the WALK. JSON.parse always creates '__proto__'
  // as an ordinary OWN data property, exactly the shape an adapter returning
  // JSON.parse(untrustedText) actually produces.
  const adapterOutput = JSON.parse('{"kept":1,"__proto__":{"shadow":"yes"}}');
  const source = buildOkSourceWithOutput(adapterOutput);

  const registry = createBoundSourceRegistry({
    mode: 'record',
    bindings: [{ sourceBindingId: 'binding-a', source, credentialRefId: null }],
    store,
    clock: fixedClock('2026-09-24T00:00:00.000Z'),
  });

  const returned = await registry.execute('binding-a', 'fetch-logs', { service: 'checkout' });
  assert.equal(returned.status, 'ok');
  assert.equal(returned.output.kept, 1);
  assert.equal(
    Object.prototype.hasOwnProperty.call(returned.output, '__proto__'),
    true,
    'a __proto__ own key from the adapter must survive the walk as an own key, not be consumed as a prototype reassignment',
  );
  assert.equal(
    'shadow' in returned.output,
    false,
    'the returned output\'s prototype must never be adapter-controlled',
  );
  assert.equal(Object.getPrototypeOf(returned.output), Object.prototype);

  const keys = await store.keys();
  assert.equal(keys.length, 1);
  const stored = await store.get(keys[0]);
  assert.equal(
    Object.prototype.hasOwnProperty.call(stored.output, '__proto__'),
    true,
    'the PERSISTED output must keep the same own key too',
  );
  assert.equal('shadow' in stored.output, false);
});

/* -------------------------------------------------------------------------- */
/* code-reviewer blocker 5 — an adapter-RETURNED refusal's free-text reason   */
/* is normalized to adapter_error; a VALID typed reason is kept               */
/* -------------------------------------------------------------------------- */

test('live: an adapter-RETURNED refused outcome whose reason is free text (outside EVIDENCE_SOURCE_REFUSAL_REASONS) is normalized to refused adapter_error, and the free text never reaches the caller (review round 1, code-reviewer blocker 5)', async () => {
  const createBoundSourceRegistry = createBoundSourceRegistryFactory();
  const createMemoryReplayStore = memoryReplayStoreFactory();
  assert.equal(
    tools.EVIDENCE_SOURCE_REFUSAL_REASONS.includes(fixtureFreeTextRefusalReason),
    false,
    'setup: the fixture reason must genuinely be outside the six typed reasons',
  );
  const source = buildSourceReturningRefusal(fixtureFreeTextRefusalReason);

  const registry = createBoundSourceRegistry({
    mode: 'live',
    bindings: [{ sourceBindingId: 'binding-a', source, credentialRefId: null }],
    store: createMemoryReplayStore(),
    clock: fixedClock('2026-09-24T00:00:00.000Z'),
  });

  const outcome = await registry.execute('binding-a', 'fetch-logs', { service: 'checkout' });

  assert.equal(outcome.status, 'refused');
  assert.equal(outcome.reason, 'adapter_error');
  assert.equal(
    JSON.stringify(outcome).includes(fixtureGithubToken),
    false,
    'the adapter\'s own free-text reason must never reach the serialized outcome',
  );
});

test('record: an adapter-RETURNED refused outcome with a free-text reason is normalized before store.set too — the stored recording carries no free text (review round 1, code-reviewer blocker 5)', async () => {
  const createBoundSourceRegistry = createBoundSourceRegistryFactory();
  const createMemoryReplayStore = memoryReplayStoreFactory();
  const store = createMemoryReplayStore();
  const source = buildSourceReturningRefusal(fixtureFreeTextRefusalReason);

  const registry = createBoundSourceRegistry({
    mode: 'record',
    bindings: [{ sourceBindingId: 'binding-a', source, credentialRefId: null }],
    store,
    clock: fixedClock('2026-09-24T00:00:00.000Z'),
  });

  const outcome = await registry.execute('binding-a', 'fetch-logs', { service: 'checkout' });
  assert.equal(outcome.status, 'refused');
  assert.equal(outcome.reason, 'adapter_error');

  const keys = await store.keys();
  assert.equal(keys.length, 1);
  const stored = await store.get(keys[0]);
  assert.equal(stored.reason, 'adapter_error');
  assert.equal(JSON.stringify(stored).includes(fixtureGithubToken), false);
});

test('live: an adapter-RETURNED refused outcome with a VALID typed reason keeps it unchanged (review round 1, code-reviewer blocker 5)', async () => {
  const createBoundSourceRegistry = createBoundSourceRegistryFactory();
  const createMemoryReplayStore = memoryReplayStoreFactory();
  const source = buildSourceReturningRefusal('denied');

  const registry = createBoundSourceRegistry({
    mode: 'live',
    bindings: [{ sourceBindingId: 'binding-a', source, credentialRefId: null }],
    store: createMemoryReplayStore(),
    clock: fixedClock('2026-09-24T00:00:00.000Z'),
  });

  const outcome = await registry.execute('binding-a', 'fetch-logs', { service: 'checkout' });

  assert.equal(outcome.status, 'refused');
  assert.equal(outcome.reason, 'denied', 'a valid typed reason returned by the adapter must be kept, not overwritten');
});

/* -------------------------------------------------------------------------- */
/* code-reviewer blocker 6 — SAFE_ADAPTER_TOKEN and construction-time         */
/* validation (version only — see this section's header note on the          */
/* adapterId conflict)                                                       */
/* -------------------------------------------------------------------------- */

test('publishes SAFE_ADAPTER_TOKEN, accepting ordinary adapterId/version tokens (review round 1, code-reviewer blocker 6)', () => {
  const SAFE_ADAPTER_TOKEN = safeAdapterTokenFactory();
  assert.equal(SAFE_ADAPTER_TOKEN.test('fixture-adapter'), true);
  assert.equal(SAFE_ADAPTER_TOKEN.test('1.0.0'), true);
});

for (const badToken of [fixtureBadTokenWithSpace, fixtureBadTokenWithAt, fixtureUrlCredentialPart]) {
  test(`SAFE_ADAPTER_TOKEN refuses ${JSON.stringify(badToken)} (review round 1, code-reviewer blocker 6)`, () => {
    const SAFE_ADAPTER_TOKEN = safeAdapterTokenFactory();
    assert.equal(SAFE_ADAPTER_TOKEN.test(badToken), false);
  });
}

test('refuses construction with a binding whose describe().version does not match SAFE_ADAPTER_TOKEN (review round 1, code-reviewer blocker 6)', () => {
  const createBoundSourceRegistry = createBoundSourceRegistryFactory();
  const createMemoryReplayStore = memoryReplayStoreFactory();
  const source = buildOkSource({ version: fixtureBadTokenWithSpace });

  assert.throws(() =>
    createBoundSourceRegistry({
      mode: 'live',
      bindings: [{ sourceBindingId: 'binding-a', source, credentialRefId: null }],
      store: createMemoryReplayStore(),
      clock: fixedClock('2026-09-24T00:00:00.000Z'),
    }),
  );
});

test('accepts construction with a binding whose adapterId and version are both safe tokens (review round 1, code-reviewer blocker 6)', () => {
  const createBoundSourceRegistry = createBoundSourceRegistryFactory();
  const createMemoryReplayStore = memoryReplayStoreFactory();
  const source = buildOkSource({ adapterId: 'fixture-adapter', version: '1.0.0' });

  assert.doesNotThrow(() =>
    createBoundSourceRegistry({
      mode: 'live',
      bindings: [{ sourceBindingId: 'binding-a', source, credentialRefId: null }],
      store: createMemoryReplayStore(),
      clock: fixedClock('2026-09-24T00:00:00.000Z'),
    }),
  );
});

/**
 * Resolution of the adapterId conflict noted above: adapterId is checked by
 * its own pattern, SAFE_ADAPTER_ID, which permits ':' (the colon-collision
 * rows construct adapterId 'b:c' on purpose) but not '@' — the separator of
 * `adapterId@version` in provenance — nor whitespace. Both adapterId and
 * version must also come back unchanged from redactEvidenceOutput: an
 * all-alphanumeric credential (an AWS access key id) passes a character-class
 * pattern, so the pattern alone cannot refuse it.
 */
function constructWithDescriptor({ adapterId, version }) {
  const createBoundSourceRegistry = createBoundSourceRegistryFactory();
  const createMemoryReplayStore = memoryReplayStoreFactory();
  return createBoundSourceRegistry({
    mode: 'live',
    bindings: [{ sourceBindingId: 'binding-a', source: buildOkSource({ adapterId, version }), credentialRefId: null }],
    store: createMemoryReplayStore(),
    clock: fixedClock('2026-09-24T00:00:00.000Z'),
  });
}

test('publishes SAFE_ADAPTER_ID, which accepts a colon but not @ or whitespace (review round 2)', () => {
  assert.equal(tools.SAFE_ADAPTER_ID instanceof RegExp, true, '@aic/tools must export SAFE_ADAPTER_ID');
  assert.equal(tools.SAFE_ADAPTER_ID.test('b:c'), true);
  assert.equal(tools.SAFE_ADAPTER_ID.test('fixture-adapter'), true);
  assert.equal(tools.SAFE_ADAPTER_ID.test('bad@adapter'), false);
  assert.equal(tools.SAFE_ADAPTER_ID.test('bad adapter'), false);
});

test('construction accepts adapterId "b:c", and refuses an adapterId with @, whitespace or a credential shape (review round 2)', () => {
  assert.doesNotThrow(() => constructWithDescriptor({ adapterId: 'b:c', version: '1.0.0' }));
  for (const adapterId of ['bad@adapter', 'bad adapter', fixtureGithubToken]) {
    assert.throws(() => constructWithDescriptor({ adapterId, version: '1.0.0' }), `adapterId ${JSON.stringify(adapterId.slice(0, 8))}… must be refused`);
  }
});

test('construction refuses a version that is a credential shape even when every character is a safe token character (review round 2)', () => {
  assert.equal(tools.SAFE_ADAPTER_TOKEN.test(fixtureAwsAccessKeyId), true, 'premise: the AWS key id fixture passes the character-class pattern');
  assert.throws(() => constructWithDescriptor({ adapterId: 'fixture-adapter', version: fixtureAwsAccessKeyId }));
});

/* -------------------------------------------------------------------------- */
/* security advisory 7 (taken) — URL inline credentials redacted for ANY      */
/* scheme, not only http(s)                                                  */
/* -------------------------------------------------------------------------- */

test('redactEvidenceOutput redacts inline user:pass credentials in a URL for ANY scheme, keeping the same [REDACTED] shape the http(s) row pins (review round 1, security advisory 7)', () => {
  const redactEvidenceOutput = redactEvidenceOutputFactory();
  const input = `connection string: ${fixturePostgresUrlCredentialParts.join('')} in use`;
  assert.equal(
    redactEvidenceOutput(input),
    'connection string: postgres://[REDACTED]@db.internal:5432/app in use',
  );
});

/* -------------------------------------------------------------------------- */
/* advisory 8 (taken) — a source that REJECTS after the timeout budget:       */
/* still refused timeout, and no unhandledRejection is emitted                */
/* -------------------------------------------------------------------------- */

test(
  'live: a source whose execute() REJECTS after the timeout budget is still refused timeout, and no unhandledRejection is emitted (review round 1, advisory 8)',
  { timeout: 5000 },
  async (t) => {
    const createBoundSourceRegistry = createBoundSourceRegistryFactory();
    const createMemoryReplayStore = memoryReplayStoreFactory();

    const unhandledRejections = [];
    const onUnhandledRejection = (reason) => {
      unhandledRejections.push(reason);
    };
    process.on('unhandledRejection', onUnhandledRejection);
    t.after(() => {
      process.removeListener('unhandledRejection', onUnhandledRejection);
    });

    const lateRejectingSource = {
      describe: () => ({ adapterId: 'fixture-adapter', version: '1.0.0', operations: ['fetch-logs'] }),
      check: async () => ({ status: 'ready' }),
      execute: async () => {
        await new Promise((resolveAfterDelay) => setTimeout(resolveAfterDelay, 300));
        throw new Error('late rejection, after the timeout budget already fired');
      },
    };

    const registry = createBoundSourceRegistry({
      mode: 'live',
      bindings: [{ sourceBindingId: 'binding-a', source: lateRejectingSource, credentialRefId: null }],
      store: createMemoryReplayStore(),
      clock: fixedClock('2026-09-24T00:00:00.000Z'),
      budgets: { timeoutMs: 50, maxResultBytes: 1_000_000, maxPages: 100 },
    });

    const outcome = await registry.execute('binding-a', 'fetch-logs', { service: 'checkout' });
    assert.equal(outcome.status, 'refused');
    assert.equal(outcome.reason, 'timeout');

    // Give the late rejection's own timer a chance to settle, and for Node to
    // notice if it were ever unhandled, before asserting none fired.
    await new Promise((resolveAfterDelay) => setTimeout(resolveAfterDelay, 500));
    assert.deepEqual(
      unhandledRejections,
      [],
      'a rejection from the losing side of the timeout race must never surface as an unhandledRejection',
    );
  },
);

/* ============================================================================ */
/* AIC-100 slice c — review round 2 findings (LAST gate round)                 */
/*                                                                              */
/* Six findings, both reviewers, on packages/tools/src/{redaction,             */
/* bound-source-registry}.ts @ b14c52f:                                        */
/*   1. ReDoS in the any-scheme URL pattern on a long run with no '://'.       */
/*   2. The any-scheme URL pattern is case-sensitive: an UPPERCASE scheme is   */
/*      not redacted at all.                                                  */
/*   3. Three PEM gaps: (a) trailing whitespace before the header's own        */
/*      newline stops the body/footer from being consumed at all; (b) an      */
/*      RFC 1421 encrypted-PEM header (Proc-Type/DEK-Info) breaks the body     */
/*      character class and leaves the real body and footer untouched; (c) a  */
/*      FOOTER-LESS header over-redacts past itself into unrelated log text,  */
/*      because the body class currently accepts a literal space.             */
/*   4. The registry re-reads describe() on every execute() call instead of   */
/*      snapshotting it once at construction, so a binding whose describe()   */
/*      later returns a credential-shaped value poisons provenance.adapter.   */
/*   5. SAFE_ADAPTER_ID/SAFE_ADAPTER_TOKEN carry no length bound.             */
/*   6. A function, symbol, bigint or undefined value passes through          */
/*      redactEvidenceOutput unchanged instead of failing closed like a       */
/*      Buffer/Map/Set/Date/Error.                                           */
/*                                                                              */
/* All runtime-assembled credential-shaped fixtures below follow this file's  */
/* own established convention (never one literal, per                        */
/* .claude/scripts/lib/secrets.mjs's vocabulary).                             */
/* ============================================================================ */

/* -------------------------------------------------------------------------- */
/* review round 2 fixtures                                                    */
/* -------------------------------------------------------------------------- */

/**
 * A long run of lowercase scheme-like characters (hex digits, dots, dashes)
 * that never contains the literal substring '://' — so the any-scheme URL
 * pattern's own [a-z][a-z0-9+.-]* prefix is exercised at every starting
 * position without ever finding the literal it needs, which is exactly the
 * shape that makes an unanchored, unbounded-prefix regex quadratic. No '/'
 * character appears anywhere in the alphabet below, so '://' cannot occur by
 * construction — asserted below rather than merely claimed.
 */
function buildSchemeLikeRunWithNoUrlSeparator(totalChars) {
  const alphabet = 'abcdef0123456789.-';
  const repeated = alphabet.repeat(Math.ceil(totalChars / alphabet.length));
  return repeated.slice(0, totalChars);
}

/**
 * Inline URL credential parts using an UPPERCASE scheme (review round 2,
 * finding 2). The credential-half value is assembled from parts, never one
 * literal, so it stays under the guard's own assignment-length bound too.
 */
const fixtureUppercaseSchemeUrlCredentialUser = 'produser';
const fixtureUppercaseSchemeUrlCredentialValue = ['prodpass9', 'fixture'].join('');
const fixtureUppercaseSchemeUrlCredentialParts = [
  'POSTGRES://',
  fixtureUppercaseSchemeUrlCredentialUser,
  ':',
  fixtureUppercaseSchemeUrlCredentialValue,
  '@db.prod.internal:5432/orders',
];

/** A PEM header followed by trailing spaces and a tab before its own newline (review round 2, finding 3a). */
const fixturePemHeaderWithTrailingWhitespace = `${fixturePemHeader}  \t`;

/**
 * An RFC 1421 encrypted-PEM header block: 'Proc-Type' and 'DEK-Info' lines
 * between the '-----BEGIN...' header and the base64 body, exactly the shape
 * an encrypted private key carries (review round 2, finding 3b). Assembled
 * from parts, even though none of these characters alone is credential-shaped.
 */
const fixtureEncryptedPemInfoLines = [
  ['Proc-Type', ': 4,ENCRYPTED'].join(''),
  ['DEK-Info', ': AES-256-CBC,', 'AB12CD34EF56'.repeat(3)].join(''),
].join('\n');

/** Plain-text log lines following a FOOTER-LESS PEM header (review round 2, finding 3c). */
const fixtureFooterlessPemFollowupLogLines = '\nINFO service healthy\nINFO 200 OK\nINFO user alice succeeded';

/**
 * Like `buildOkSource`, but `describe()` returns a SAFE descriptor on its
 * first call and an UNSAFE (credential-shaped) one on every call after that —
 * pins that the registry snapshots describe() once, at construction, rather
 * than re-reading it on every execute() (review round 2, finding 4).
 */
function buildSourceWithMutatingDescriptor({
  adapterId = 'fixture-adapter',
  safeVersion = '1.0.0',
  unsafeVersion,
  operations = ['fetch-logs'],
}) {
  let describeCallCount = 0;
  const calls = [];
  return {
    calls,
    describeCallCount: () => describeCallCount,
    describe: () => {
      describeCallCount += 1;
      return { adapterId, version: describeCallCount === 1 ? safeVersion : unsafeVersion, operations };
    },
    check: async () => ({ status: 'ready' }),
    execute: async (operation, input, budgetHints) => {
      calls.push({ operation, input, budgetHints });
      return {
        status: 'ok',
        output: { lines: ['fixture output'] },
        // Deliberately foreign provenance, matching this file's other fixture
        // sources — pins that the registry stays the single writer of
        // provenance regardless of what describe() returns on a later call.
        provenance: {
          sourceBindingId: 'not-the-real-binding',
          adapter: 'not-the-real-adapter@0.0.0',
          credentialRefId: 'wrongcredentialplaceholder',
          fetchedAt: '1970-01-01T00:00:00.000Z',
          requestFingerprint: 'sha256:not-the-real-fingerprint',
        },
      };
    },
  };
}

/** 64- and 65-character safe-token-shaped strings (review round 2, finding 5: length bound). */
const fixtureSafeToken64Chars = 'a'.repeat(64);
const fixtureSafeToken65Chars = 'a'.repeat(65);

/**
 * Values that are neither a JSON-shaped container nor one of the already
 * -pinned unsupported class instances, but which are still not a JSON leaf
 * (string/number/boolean/null) — review round 2, finding 6.
 */
const UNSUPPORTED_NON_OBJECT_REDACTION_VALUE_ROWS = [
  { label: 'a function', build: () => function fixtureUnsupportedFunction() {} },
  { label: 'a symbol', build: () => Symbol('fixture-unsupported-symbol') },
  { label: 'a bigint', build: () => 10n },
  { label: 'undefined', build: () => undefined },
];

/* -------------------------------------------------------------------------- */
/* finding 1 — ReDoS: the any-scheme URL pattern is quadratic on a long run   */
/* with no '://'                                                              */
/* -------------------------------------------------------------------------- */

test(
  'redactEvidenceOutput completes within a bound on a 256 KiB run of scheme-like characters with no "://" substring (review round 2, finding 1: ReDoS)',
  { timeout: 10_000 },
  () => {
    const redactEvidenceOutput = redactEvidenceOutputFactory();
    const input = buildSchemeLikeRunWithNoUrlSeparator(256 * 1024);
    assert.equal(input.includes('://'), false, 'setup: the fixture must contain no "://" substring at all');

    const startedAtMs = performance.now();
    redactEvidenceOutput(input);
    const elapsedMs = performance.now() - startedAtMs;

    assert.ok(
      elapsedMs < 250,
      `redactEvidenceOutput must stay near-linear on a long run with no scheme match; took ${elapsedMs}ms`,
    );
  },
);

test(
  'live: registry.execute redacts an 80 KB output built from the same scheme-like run within a bound (review round 2, finding 1: ReDoS)',
  { timeout: 10_000 },
  async () => {
    const createBoundSourceRegistry = createBoundSourceRegistryFactory();
    const createMemoryReplayStore = memoryReplayStoreFactory();
    const longRun = buildSchemeLikeRunWithNoUrlSeparator(80_000);
    const source = buildOkSourceWithOutput({ lines: [longRun] });

    const registry = createBoundSourceRegistry({
      mode: 'live',
      bindings: [{ sourceBindingId: 'binding-a', source, credentialRefId: null }],
      store: createMemoryReplayStore(),
      clock: fixedClock('2026-09-24T00:00:00.000Z'),
    });

    const startedAtMs = performance.now();
    const outcome = await registry.execute('binding-a', 'fetch-logs', { service: 'checkout' });
    const elapsedMs = performance.now() - startedAtMs;

    assert.equal(outcome.status, 'ok');
    assert.ok(
      elapsedMs < 1000,
      `registry.execute must redact and return an 80 KB payload within a bound; took ${elapsedMs}ms`,
    );
  },
);

/* -------------------------------------------------------------------------- */
/* finding 2 — the any-scheme URL pattern is case-sensitive: an UPPERCASE     */
/* scheme is not redacted at all                                             */
/* -------------------------------------------------------------------------- */

test('redactEvidenceOutput redacts an UPPERCASE URL scheme exactly like the lowercase form (review round 2, finding 2: URL scheme case)', () => {
  const redactEvidenceOutput = redactEvidenceOutputFactory();
  const input = fixtureUppercaseSchemeUrlCredentialParts.join('');
  assert.equal(
    redactEvidenceOutput(input),
    'POSTGRES://[REDACTED]@db.prod.internal:5432/orders',
  );
});

test('record: the credential half of an UPPERCASE-scheme URL is redacted before it ever reaches the recordings file (review round 2, finding 2)', async (t) => {
  const dir = withScratchDir(t);
  const createBoundSourceRegistry = createBoundSourceRegistryFactory();
  const createFileReplayStore = fileReplayStoreFactory();
  const filePath = join(dir, 'uppercase-scheme-recordings.json');
  const credentialText = fixtureUppercaseSchemeUrlCredentialParts.join('');
  const source = buildOkSourceWithOutput({ lines: [`connection: ${credentialText}`] });

  const registry = createBoundSourceRegistry({
    mode: 'record',
    bindings: [{ sourceBindingId: 'binding-a', source, credentialRefId: null }],
    store: createFileReplayStore(filePath),
    clock: fixedClock('2026-09-24T00:00:00.000Z'),
  });

  const outcome = await registry.execute('binding-a', 'fetch-logs', { service: 'checkout' });
  assert.equal(outcome.status, 'ok');

  const onDisk = readFileSync(filePath, 'utf8');
  assert.equal(
    onDisk.includes(fixtureUppercaseSchemeUrlCredentialValue),
    false,
    'the credential half of an UPPERCASE-scheme URL must never reach the recordings file',
  );
});

/* -------------------------------------------------------------------------- */
/* finding 3a — trailing whitespace before the PEM header's own newline must  */
/* not stop the body/footer from being consumed                              */
/* -------------------------------------------------------------------------- */

test('redactEvidenceOutput redacts the WHOLE PEM block even when the header line carries trailing spaces and a tab before its own newline (review round 2, finding 3a)', () => {
  const redactEvidenceOutput = redactEvidenceOutputFactory();
  const input = [
    'key material:',
    fixturePemHeaderWithTrailingWhitespace,
    fixturePemBodyLine1,
    fixturePemBodyLine2,
    fixturePemFooter,
    'end',
  ].join('\n');

  const output = redactEvidenceOutput(input);

  assert.equal(
    output.includes(fixturePemBodyLine1),
    false,
    'the PEM body must never survive redaction just because the header line carried trailing whitespace',
  );
  assert.equal(
    output.includes(fixturePemBodyLine2),
    false,
    'the PEM body must never survive redaction just because the header line carried trailing whitespace',
  );
  assert.equal(
    output.includes(fixturePemFooter),
    false,
    'the footer must never survive redaction just because the header line carried trailing whitespace',
  );
});

/* -------------------------------------------------------------------------- */
/* finding 3b — an RFC 1421 encrypted-PEM header (Proc-Type/DEK-Info) must    */
/* not stop the real body and footer from being redacted                     */
/* -------------------------------------------------------------------------- */

test('redactEvidenceOutput redacts an ENCRYPTED PEM block whose RFC 1421 Proc-Type/DEK-Info headers sit between the BEGIN header and the base64 body — no body line and no footer survive (review round 2, finding 3b)', () => {
  const redactEvidenceOutput = redactEvidenceOutputFactory();
  const input = [
    fixturePemHeader,
    fixtureEncryptedPemInfoLines,
    '',
    fixturePemBodyLine1,
    fixturePemFooter,
  ].join('\n');

  const output = redactEvidenceOutput(input);

  assert.equal(
    output.includes(fixturePemBodyLine1),
    false,
    'the base64 body of an encrypted PEM block must never survive redaction',
  );
  assert.equal(
    output.includes(fixturePemFooter),
    false,
    'the footer of an encrypted PEM block must never survive redaction',
  );
});

/* -------------------------------------------------------------------------- */
/* finding 3c — over-redaction bound: a FOOTER-LESS header must not consume   */
/* unrelated log text that follows it (the body class must not include a     */
/* literal space)                                                            */
/* -------------------------------------------------------------------------- */

// Rewritten under the owner's fail-closed ruling, 2026-09-25 (see the "review
// round 4" block further down): this row used to pin that plain log lines
// FOLLOWING a footer-less PEM header survived untouched, on the theory that a
// tighter body character class could tell a base64 line from a log line. That
// theory is exactly what round 3's finding 4 (below, also rewritten) went on
// to falsify for colon-bearing lines, so the owner replaced per-line body
// parsing with subtraction: a footer-less header has no footer to bound it,
// so it now redacts through the END OF THE STRING, fail closed, and nothing
// after it — log lines included — is expected to survive. This input has no
// text before the header either, so the whole string collapses to the single
// redaction marker.
test('redactEvidenceOutput redacts a footer-less PEM header through the end of the string, fail closed, even when what follows is plain log text (owner fail-closed ruling, 2026-09-25 — supersedes review round 2, finding 3c)', () => {
  const redactEvidenceOutput = redactEvidenceOutputFactory();
  const input = `${fixturePemHeader}${fixtureFooterlessPemFollowupLogLines}`;

  const output = redactEvidenceOutput(input);

  assert.equal(
    output,
    '[REDACTED]',
    `expected the whole footer-less block (header through end of string) to collapse to the single redaction marker; got ${JSON.stringify(output)}`,
  );
});

/* -------------------------------------------------------------------------- */
/* finding 4 — the registry snapshots describe() ONCE at construction         */
/* -------------------------------------------------------------------------- */

test('the registry reads describe() ONCE at construction and reuses that snapshot for every call: provenance.adapter stays the construction-time safe value even when describe() later returns a credential-shaped version, and describe() is called exactly once (review round 2, finding 4)', async () => {
  const createBoundSourceRegistry = createBoundSourceRegistryFactory();
  const createMemoryReplayStore = memoryReplayStoreFactory();
  const source = buildSourceWithMutatingDescriptor({ safeVersion: '1.0.0', unsafeVersion: fixtureAwsAccessKeyId });

  const registry = createBoundSourceRegistry({
    mode: 'live',
    bindings: [{ sourceBindingId: 'binding-a', source, credentialRefId: null }],
    store: createMemoryReplayStore(),
    clock: fixedClock('2026-09-24T00:00:00.000Z'),
  });

  const first = await registry.execute('binding-a', 'fetch-logs', { service: 'checkout' });
  const second = await registry.execute('binding-a', 'fetch-logs', { service: 'checkout' });

  assert.equal(first.provenance.adapter, 'fixture-adapter@1.0.0');
  assert.equal(
    second.provenance.adapter,
    'fixture-adapter@1.0.0',
    'provenance.adapter must stay the construction-time SAFE snapshot even when describe() later returns a credential-shaped version',
  );
  assert.equal(
    source.describeCallCount(),
    1,
    'describe() must be called exactly once per binding, at construction — never again on any later execute() call',
  );
});

/* -------------------------------------------------------------------------- */
/* finding 5 — SAFE_ADAPTER_ID / SAFE_ADAPTER_TOKEN carry a length bound      */
/* -------------------------------------------------------------------------- */

test('SAFE_ADAPTER_TOKEN accepts a 64-character token and refuses a 65-character token (review round 2, finding 5: length bound)', () => {
  const SAFE_ADAPTER_TOKEN = safeAdapterTokenFactory();
  assert.equal(SAFE_ADAPTER_TOKEN.test(fixtureSafeToken64Chars), true, 'a 64-character token must still be accepted');
  assert.equal(SAFE_ADAPTER_TOKEN.test(fixtureSafeToken65Chars), false, 'a 65-character token must be refused');
});

test('SAFE_ADAPTER_ID accepts a 64-character id and refuses a 65-character id (review round 2, finding 5: length bound)', () => {
  assert.equal(tools.SAFE_ADAPTER_ID.test(fixtureSafeToken64Chars), true, 'a 64-character id must still be accepted');
  assert.equal(tools.SAFE_ADAPTER_ID.test(fixtureSafeToken65Chars), false, 'a 65-character id must be refused');
});

test('construction refuses a describe().version that is 65 characters long, even though every character is an otherwise-safe token character (review round 2, finding 5)', () => {
  assert.throws(() => constructWithDescriptor({ adapterId: 'fixture-adapter', version: fixtureSafeToken65Chars }));
});

/* -------------------------------------------------------------------------- */
/* finding 6 — a function, symbol, bigint or undefined value fails CLOSED to  */
/* the fixed sentinel, like the already-pinned unsupported class instances    */
/* -------------------------------------------------------------------------- */

for (const { label, build } of UNSUPPORTED_NON_OBJECT_REDACTION_VALUE_ROWS) {
  test(`redactEvidenceOutput replaces ${label} anywhere in the walked value with the fixed sentinel [REDACTED:unsupported] — fail closed, kept as an own key rather than dropped (review round 2, finding 6)`, () => {
    const redactEvidenceOutput = redactEvidenceOutputFactory();
    const value = build();

    assert.equal(
      redactEvidenceOutput(value),
      '[REDACTED:unsupported]',
      `${label} at the top level must fail closed to the fixed sentinel`,
    );

    const nested = { safe: 'kept', unsupported: value, list: [value] };
    const output = redactEvidenceOutput(nested);

    assert.equal(output.safe, 'kept', 'a plain object is still walked normally alongside an unsupported value');
    assert.equal(
      Object.prototype.hasOwnProperty.call(output, 'unsupported'),
      true,
      `an object property holding ${label} must be KEPT as an own key, replaced with the sentinel value — never dropped`,
    );
    assert.equal(output.unsupported, '[REDACTED:unsupported]');
    assert.equal(output.list[0], '[REDACTED:unsupported]', 'arrays are still walked normally too');
  });
}

/* ============================================================================ */
/* AIC-100 slice c — review round 3 findings (FOURTH, owner-granted gate       */
/* round), PEM rework                                                          */
/*                                                                              */
/* Four findings, both reviewers, on packages/tools/src/redaction.ts's PEM     */
/* pattern (unchanged since review round 2, still @ b14c52f's shape):          */
/*   1. An INDENTED PEM block (e.g. a YAML block scalar, where every           */
/*      continuation line carries leading whitespace) leaves the body and      */
/*      footer untouched — only the header line itself is redacted, because    */
/*      neither the header-line loop nor the base64 body class tolerates the   */
/*      leading indentation each continuation line carries.                    */
/*   2. A single body line with a TRAILING space (unindented otherwise) breaks */
/*      the body class the same way: everything from that space onward — the  */
/*      rest of the body and the footer — survives untouched.                 */
/*   3. An INDENTED ENCRYPTED PEM block (Proc-Type/DEK-Info header lines, the  */
/*      blank line, the body and the footer all indented) survives in full,   */
/*      including the DEK-Info value: the header-line loop requires each RFC   */
/*      1421 line to start with its letter class immediately, no leading      */
/*      whitespace tolerated.                                                  */
/*   4. An ordinary colon-bearing log line ("INFO: service healthy") after a  */
/*      FOOTER-LESS PEM header is wrongly treated as an RFC 1421 header line   */
/*      and consumed by the redaction along with the next colon-bearing line — */
/*      the header-line loop's `[A-Za-z-]+:[^\r\n]*\r?\n` shape cannot tell a  */
/*      real Proc-Type/DEK-Info line from an unrelated log line that merely    */
/*      happens to start with `word:`. The existing footer-less row above     */
/*      ("does not over-redact past a FOOTER-LESS PEM header …") is also       */
/*      strengthened in place to assert the leading "INFO" of its own first    */
/*      line survives too — it is eaten today by that same over-matching.      */
/*                                                                              */
/* All fixtures below reuse fixturePemHeader / fixturePemBodyLine1/2 /         */
/* fixturePemFooter already defined above this file, per this file's own      */
/* established "assembled at runtime, never one literal" convention           */
/* (.claude/scripts/lib/secrets.mjs's vocabulary).                            */
/* ============================================================================ */

/* -------------------------------------------------------------------------- */
/* review round 3 fixtures                                                    */
/* -------------------------------------------------------------------------- */

/**
 * Four spaces of indentation — the shape a YAML block scalar ('tls:\n  key: |\n')
 * applies to every continuation line of the literal it introduces (review
 * round 3, findings 1 and 3).
 */
const fixturePemIndent = '    ';

/**
 * The DEK-Info value of the INDENTED encrypted-PEM fixture below, asserted not
 * to survive on its own (review round 3, finding 3) — a second, independent
 * value from the existing (unindented) `fixtureEncryptedPemInfoLines`' own DEK
 * value above, so the two rows cannot pass each other's assertion by accident.
 */
const fixtureIndentedEncryptedPemDekInfoValue = 'FE65DC21BA43'.repeat(3);

/**
 * An RFC 1421 encrypted-PEM header block whose OWN LINES (not the BEGIN header
 * before them) are each indented (review round 3, finding 3).
 */
const fixtureIndentedEncryptedPemInfoLines = [
  fixturePemIndent + ['Proc-Type', ': 4,ENCRYPTED'].join(''),
  fixturePemIndent + ['DEK-Info', ': AES-256-CBC,', fixtureIndentedEncryptedPemDekInfoValue].join(''),
].join('\n');

/**
 * Ordinary colon-bearing log lines following a FOOTER-LESS PEM header — none
 * of these is an RFC 1421 Proc-Type/DEK-Info line, and none should ever be
 * treated as one (review round 3, finding 4).
 */
const fixtureFooterlessPemColonLogLines = '\nINFO: service healthy\nERROR: connection refused\nWARN: retry';

/* -------------------------------------------------------------------------- */
/* finding 1 — an INDENTED PEM block (a YAML block scalar) must still be      */
/* redacted in full; surrounding document text must survive                  */
/* -------------------------------------------------------------------------- */

test('redactEvidenceOutput redacts the WHOLE PEM block even when every continuation line is INDENTED, as inside a YAML block scalar — the surrounding document text survives (review round 3, finding 1)', () => {
  const redactEvidenceOutput = redactEvidenceOutputFactory();
  const input = [
    'tls:',
    '  key: |',
    fixturePemIndent + fixturePemHeader,
    fixturePemIndent + fixturePemBodyLine1,
    fixturePemIndent + fixturePemBodyLine2,
    fixturePemIndent + fixturePemFooter,
    'next: value',
  ].join('\n');

  const output = redactEvidenceOutput(input);

  assert.equal(
    output.includes(fixturePemBodyLine1),
    false,
    'the PEM body must never survive redaction just because every continuation line was indented',
  );
  assert.equal(
    output.includes(fixturePemBodyLine2),
    false,
    'the PEM body must never survive redaction just because every continuation line was indented',
  );
  assert.equal(
    output.includes(fixturePemFooter),
    false,
    'the footer must never survive redaction just because every continuation line was indented',
  );
  assert.ok(output.includes('tls:'), 'surrounding document text before the indented block must survive');
  assert.ok(output.includes('key: |'), 'surrounding document text before the indented block must survive');
  assert.ok(output.includes('next: value'), 'surrounding document text after the indented block must survive');
});

/* -------------------------------------------------------------------------- */
/* finding 2 — a body line with a single TRAILING space must not stop the     */
/* rest of the body and the footer from being redacted                       */
/* -------------------------------------------------------------------------- */

test('redactEvidenceOutput redacts the WHOLE PEM block even when a body line carries a single TRAILING space — the following body line and the footer must not survive (review round 3, finding 2)', () => {
  const redactEvidenceOutput = redactEvidenceOutputFactory();
  const input = [fixturePemHeader, `${fixturePemBodyLine1} `, fixturePemBodyLine2, fixturePemFooter].join('\n');

  const output = redactEvidenceOutput(input);

  assert.equal(
    output.includes(fixturePemBodyLine1),
    false,
    'the PEM body must never survive redaction just because it carried a trailing space',
  );
  assert.equal(
    output.includes(fixturePemBodyLine2),
    false,
    'a LATER body line must never survive redaction just because an earlier line carried a trailing space',
  );
  assert.equal(
    output.includes(fixturePemFooter),
    false,
    'the footer must never survive redaction just because an earlier body line carried a trailing space',
  );
});

/* -------------------------------------------------------------------------- */
/* finding 3 — an INDENTED ENCRYPTED PEM block must still be redacted in      */
/* full: no body line, no footer, and no DEK-Info value survives             */
/* -------------------------------------------------------------------------- */

test('redactEvidenceOutput redacts an INDENTED ENCRYPTED PEM block: the base64 body, the footer, and the DEK-Info value all fail to survive when every continuation line is indented (review round 3, finding 3)', () => {
  const redactEvidenceOutput = redactEvidenceOutputFactory();
  const input = [
    fixturePemHeader,
    fixtureIndentedEncryptedPemInfoLines,
    fixturePemIndent,
    fixturePemIndent + fixturePemBodyLine1,
    fixturePemIndent + fixturePemFooter,
  ].join('\n');

  const output = redactEvidenceOutput(input);

  assert.equal(
    output.includes(fixturePemBodyLine1),
    false,
    'the base64 body of an indented encrypted PEM block must never survive redaction',
  );
  assert.equal(
    output.includes(fixturePemFooter),
    false,
    'the footer of an indented encrypted PEM block must never survive redaction',
  );
  assert.equal(
    output.includes(fixtureIndentedEncryptedPemDekInfoValue),
    false,
    'the DEK-Info value of an indented encrypted PEM block must never survive redaction',
  );
});

/* -------------------------------------------------------------------------- */
/* finding 4 — an ordinary colon-bearing log line after a FOOTER-LESS header  */
/* must never be treated as an RFC 1421 header line                          */
/* -------------------------------------------------------------------------- */

// Rewritten under the owner's fail-closed ruling, 2026-09-25 (see the "review
// round 4" block further down). This row is what forced the ruling: this
// finding's OWN fix — restricting the header-line loop to real RFC 1421
// labels — was round 3's answer to round 2 finding 3c's leak, and it was
// itself a fourth regex patch on the same header/footer gap. Rather than
// write a fifth, the owner replaced the per-line parsing entirely with
// subtraction: a footer-less header has no footer to bound it, so it now
// redacts through the END OF THE STRING, fail closed — the colon-bearing log
// lines below no longer survive, any more than the plain ones in the
// superseded round-2 row above do. This input has no text before the header
// either, so the whole string collapses to the single redaction marker.
test('redactEvidenceOutput redacts a footer-less PEM header through the end of the string, fail closed, even when what follows is ordinary colon-bearing log text (owner fail-closed ruling, 2026-09-25 — supersedes review round 3, finding 4)', () => {
  const redactEvidenceOutput = redactEvidenceOutputFactory();
  const input = `${fixturePemHeader}${fixtureFooterlessPemColonLogLines}`;

  const output = redactEvidenceOutput(input);

  assert.equal(
    output,
    '[REDACTED]',
    `expected the whole footer-less block (header through end of string) to collapse to the single redaction marker; got ${JSON.stringify(output)}`,
  );
});

/* -------------------------------------------------------------------------- */
/* PEM timing rows — redactEvidenceOutput must stay within a bound on         */
/* adversarial PEM-shaped input, so fixing findings 1-4 above (adding         */
/* indentation tolerance) never reintroduces a quadratic PEM pattern          */
/* (review round 3; `.claude/rules/invariants.md`, "a guard that fails open   */
/* must do provably bounded work", applied to this redactor as the existing  */
/* ReDoS timing rows above already do for the URL pattern)                    */
/* -------------------------------------------------------------------------- */

const ONE_MIB_CHARS = 1024 * 1024;
const PEM_TIMING_BOUND_MS = 250;
const BASE64_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

/** Repeats `unit` until at least `totalChars` characters exist, then truncates to exactly `totalChars`. */
function buildRepeatedTextOfLength(unit, totalChars) {
  return unit.repeat(Math.ceil(totalChars / unit.length)).slice(0, totalChars);
}

test(
  'redactEvidenceOutput stays within a bound on 1 MiB of repeated PEM headers with no footer (review round 3, PEM timing)',
  { timeout: 10_000 },
  () => {
    const redactEvidenceOutput = redactEvidenceOutputFactory();
    const input = buildRepeatedTextOfLength(`${fixturePemHeader}\n`, ONE_MIB_CHARS);

    const startedAtMs = performance.now();
    redactEvidenceOutput(input);
    const elapsedMs = performance.now() - startedAtMs;

    assert.ok(
      elapsedMs < PEM_TIMING_BOUND_MS,
      `redactEvidenceOutput must stay under ${PEM_TIMING_BOUND_MS}ms on 1 MiB of repeated PEM headers with no footer; took ${elapsedMs}ms`,
    );
  },
);

test(
  'redactEvidenceOutput stays within a bound on a footer-less PEM header followed by 1 MiB of base64 (review round 3, PEM timing)',
  { timeout: 10_000 },
  () => {
    const redactEvidenceOutput = redactEvidenceOutputFactory();
    const input = `${fixturePemHeader}\n${buildRepeatedTextOfLength(BASE64_ALPHABET, ONE_MIB_CHARS)}`;

    const startedAtMs = performance.now();
    redactEvidenceOutput(input);
    const elapsedMs = performance.now() - startedAtMs;

    assert.ok(
      elapsedMs < PEM_TIMING_BOUND_MS,
      `redactEvidenceOutput must stay under ${PEM_TIMING_BOUND_MS}ms on a footer-less PEM header followed by 1 MiB of base64; took ${elapsedMs}ms`,
    );
  },
);

test(
  'redactEvidenceOutput stays within a bound on a PEM header followed by 1 MiB of whitespace (review round 3, PEM timing)',
  { timeout: 10_000 },
  () => {
    const redactEvidenceOutput = redactEvidenceOutputFactory();
    const input = `${fixturePemHeader}\n${' '.repeat(ONE_MIB_CHARS)}`;

    const startedAtMs = performance.now();
    redactEvidenceOutput(input);
    const elapsedMs = performance.now() - startedAtMs;

    assert.ok(
      elapsedMs < PEM_TIMING_BOUND_MS,
      `redactEvidenceOutput must stay under ${PEM_TIMING_BOUND_MS}ms on a PEM header followed by 1 MiB of whitespace; took ${elapsedMs}ms`,
    );
  },
);

test(
  'redactEvidenceOutput stays within a bound on 1 MiB of "Proc-Type: x" lines after a PEM header (review round 3, PEM timing)',
  { timeout: 10_000 },
  () => {
    const redactEvidenceOutput = redactEvidenceOutputFactory();
    const input = `${fixturePemHeader}\n${buildRepeatedTextOfLength('Proc-Type: x\n', ONE_MIB_CHARS)}`;

    const startedAtMs = performance.now();
    redactEvidenceOutput(input);
    const elapsedMs = performance.now() - startedAtMs;

    assert.ok(
      elapsedMs < PEM_TIMING_BOUND_MS,
      `redactEvidenceOutput must stay under ${PEM_TIMING_BOUND_MS}ms on 1 MiB of Proc-Type lines after a PEM header; took ${elapsedMs}ms`,
    );
  },
);

test(
  'redactEvidenceOutput stays within a bound on a PEM header, ~1 MiB of base64 body, and a footer (review round 3, PEM timing)',
  { timeout: 10_000 },
  () => {
    const redactEvidenceOutput = redactEvidenceOutputFactory();
    const input = `${fixturePemHeader}\n${buildRepeatedTextOfLength(BASE64_ALPHABET, ONE_MIB_CHARS)}\n${fixturePemFooter}`;

    const startedAtMs = performance.now();
    redactEvidenceOutput(input);
    const elapsedMs = performance.now() - startedAtMs;

    assert.ok(
      elapsedMs < PEM_TIMING_BOUND_MS,
      `redactEvidenceOutput must stay under ${PEM_TIMING_BOUND_MS}ms on a PEM header, ~1 MiB of base64 body, and a footer; took ${elapsedMs}ms`,
    );
  },
);

/* -------------------------------------------------------------------------- */
/* advisory — the registry's operations snapshot must be independent of the  */
/* adapter's own array: a later push onto describe().operations must not     */
/* widen the allow-list (review round 3)                                     */
/* -------------------------------------------------------------------------- */

test('a later push onto the adapter\'s own describe().operations array does not widen the registry\'s allow-list: a call for the newly pushed operation is still refused unavailable (review round 3, advisory)', async () => {
  const createBoundSourceRegistry = createBoundSourceRegistryFactory();
  const createMemoryReplayStore = memoryReplayStoreFactory();
  const operations = ['fetch-logs'];
  const source = buildOkSourceWithOutput({ lines: ['fixture output'] }, { operations });

  const registry = createBoundSourceRegistry({
    mode: 'live',
    bindings: [{ sourceBindingId: 'binding-a', source, credentialRefId: null }],
    store: createMemoryReplayStore(),
    clock: fixedClock('2026-09-24T00:00:00.000Z'),
  });

  // Mutates the SAME array describe() returned at construction, rather than
  // calling describe() again — pins that the registry's snapshot does not
  // alias the adapter's own live array.
  operations.push('newly-pushed-op');

  const outcome = await registry.execute('binding-a', 'newly-pushed-op', {});

  assert.equal(outcome.status, 'refused');
  assert.equal(
    outcome.reason,
    'unavailable',
    'a push onto the adapter\'s own operations array after construction must never widen the registry\'s allow-list',
  );
});

/* ============================================================================ */
/* AIC-100 slice c — review round 4: the owner's fail-closed ruling on the     */
/* PEM pattern (SUBTRACTION), 2026-09-25                                       */
/*                                                                              */
/* Four review rounds each fixed one gap in the header/footer PEM REGEX by     */
/* adding to it, and each fix opened a new leak in the same regex — round 2's  */
/* finding 3c (over-redaction past a footer-less header) was answered by       */
/* tightening the header-line loop to real RFC 1421 labels, and round 3's      */
/* finding 4 (an ordinary colon-bearing log line wrongly treated as a header   */
/* line) showed that tightening was itself wrong. On 2026-09-25 the owner      */
/* ruled the fix is SUBTRACTION, not a fifth patch: replace the PEM regex with */
/* a plain string-search, fail-closed rule —                                  */
/*   - a header is '-----BEGIN ' + a label of up to 64 [A-Z0-9 ] characters +  */
/*     'PRIVATE KEY-----'; a label not ending in PRIVATE KEY (CERTIFICATE,     */
/*     PUBLIC KEY) is untouched;                                              */
/*   - from the header, everything up to and including the NEXT matching      */
/*     '-----END ' + label + 'PRIVATE KEY-----' footer is replaced by         */
/*     '[REDACTED]', regardless of what lies between — indentation, blank     */
/*     lines, Proc-Type/DEK-Info/Content-Domain lines, per-line log prefixes, */
/*     base64url, colons, dashes;                                             */
/*   - with no such footer, everything from the header to the END OF THE      */
/*     STRING is replaced instead — fail closed, over-redaction accepted;     */
/*   - text before the header, and after the footer, survives.               */
/*                                                                              */
/* This block therefore does two things at once: it REWRITES three existing   */
/* rows above whose pinned expectation was the old regex's per-line-parsing   */
/* behaviour rather than this contract (the round-1 same-line near-miss, the  */
/* round-2 finding 3c footer-less-log-lines row, and the round-3 finding-4    */
/* colon-bearing-log-lines row — each now says so in its own name and a       */
/* comment dated 2026-09-25), and it adds the seven new rows below pinning    */
/* the contract's remaining, previously untested corners.                     */
/* ============================================================================ */

/* -------------------------------------------------------------------------- */
/* review round 4 fixtures — assembled at runtime, per                        */
/* .claude/scripts/lib/secrets.mjs's vocabulary and this file's own           */
/* established convention                                                     */
/* -------------------------------------------------------------------------- */

/**
 * A non-Proc-Type/DEK-Info RFC-1421-shaped header line ('Content-Domain:
 * RFC822'), used to pin that the new contract treats the header-to-footer
 * span as opaque regardless of what lines sit inside it — unlike the old
 * regex's header-line loop, which only tolerated two specific labels.
 */
const fixtureContentDomainLine = ['Content-Domain', ': RFC822'].join('');

/**
 * A base64url-alphabet body line ('-' and '_' in place of '+' and '/'), the
 * shape produced by some tools' PEM-adjacent encodings. The old regex's body
 * character class excluded both characters entirely.
 */
const fixtureBase64UrlBodyLine = ['QWERTY_1234-abcdEFGH', '_5678-ZYXWVU_9876'].join('');

/**
 * A per-line ISO-8601 timestamp log prefix, the shape a log aggregator adds
 * to every line of a multi-line message it forwards — including, if a key
 * ever leaked into one, the header and footer lines themselves.
 */
const fixtureIsoTimestampPrefix = ['2026-09-25T00', ':00:00.000Z '].join('');

/* -------------------------------------------------------------------------- */
/* 1 — the round-4 leak itself: a footer-less ENCRYPTED PEM key with the RFC   */
/* 1421 blank line, exercised through registry.execute in record mode with a  */
/* file store                                                                 */
/* -------------------------------------------------------------------------- */

test('record: a footer-less ENCRYPTED PEM key (Proc-Type/DEK-Info headers, the RFC 1421 blank line, then a base64 body, no footer) is fully redacted before it ever reaches the recordings file or the returned outcome (review round 4 — the footer-less-encrypted leak the owner\'s 2026-09-25 fail-closed ruling fixes)', async (t) => {
  const dir = withScratchDir(t);
  const createBoundSourceRegistry = createBoundSourceRegistryFactory();
  const createFileReplayStore = fileReplayStoreFactory();
  const filePath = join(dir, 'footerless-encrypted-recordings.json');
  const bodyText = [
    fixturePemHeader,
    fixtureEncryptedPemInfoLines,
    '',
    fixturePemBodyLine1,
    fixturePemBodyLine2,
  ].join('\n');
  const source = buildOkSourceWithOutput({ lines: [bodyText] });

  const registry = createBoundSourceRegistry({
    mode: 'record',
    bindings: [{ sourceBindingId: 'binding-a', source, credentialRefId: null }],
    store: createFileReplayStore(filePath),
    clock: fixedClock('2026-09-24T00:00:00.000Z'),
  });

  const outcome = await registry.execute('binding-a', 'fetch-logs', { service: 'checkout' });
  assert.equal(outcome.status, 'ok');
  assert.equal(
    JSON.stringify(outcome).includes(fixturePemBodyLine1),
    false,
    'the returned outcome must never carry a footer-less encrypted PEM body line',
  );
  assert.equal(
    JSON.stringify(outcome).includes(fixturePemBodyLine2),
    false,
    'the returned outcome must never carry a footer-less encrypted PEM body line',
  );

  const onDisk = readFileSync(filePath, 'utf8');
  assert.equal(
    onDisk.includes(fixturePemBodyLine1),
    false,
    'the recordings file must never carry a footer-less encrypted PEM body line — the RFC 1421 blank line before the body defeated the old footer-less base64-line fallback (the round-4 leak)',
  );
  assert.equal(
    onDisk.includes(fixturePemBodyLine2),
    false,
    'the recordings file must never carry a footer-less encrypted PEM body line',
  );
});

/* -------------------------------------------------------------------------- */
/* 2 — a Content-Domain header line (not Proc-Type/DEK-Info) before the body  */
/* no longer matters: the whole header-to-footer span is opaque              */
/* -------------------------------------------------------------------------- */

test('redactEvidenceOutput treats the whole header-to-footer span as opaque regardless of what lies between: a Content-Domain header line before the body no longer defeats redaction, and text after the footer survives (review round 4, owner fail-closed ruling, 2026-09-25)', () => {
  const redactEvidenceOutput = redactEvidenceOutputFactory();
  const suffix = ' tail text survives';
  const input = [fixturePemHeader, fixtureContentDomainLine, fixturePemBodyLine1, fixturePemFooter].join('\n') + suffix;

  const output = redactEvidenceOutput(input);

  assert.equal(
    output.includes(fixtureContentDomainLine),
    false,
    'a Content-Domain header line inside the block must never survive redaction',
  );
  assert.equal(output.includes(fixturePemBodyLine1), false, 'the body must never survive redaction');
  assert.equal(output.includes(fixturePemFooter), false, 'the footer must never survive redaction as a dangling literal');
  assert.ok(output.includes('tail text survives'), 'text after the footer must survive');
  assert.ok(output.includes('[REDACTED]'), 'the block must be replaced with the redaction marker');
});

/* -------------------------------------------------------------------------- */
/* 3 — every line, including the header and footer lines themselves, carries  */
/* a per-line ISO-timestamp log prefix                                       */
/* -------------------------------------------------------------------------- */

test('redactEvidenceOutput redacts a PEM block whose every line — including the header and footer lines themselves — carries a per-line ISO-timestamp log prefix: no body line survives, and the text before the first prefixed header line survives (review round 4, owner fail-closed ruling, 2026-09-25)', () => {
  const redactEvidenceOutput = redactEvidenceOutputFactory();
  const prefix = fixtureIsoTimestampPrefix;
  const input = [
    `${prefix}service starting`,
    `${prefix}${fixturePemHeader}`,
    `${prefix}${fixturePemBodyLine1}`,
    `${prefix}${fixturePemFooter}`,
    `${prefix}service ready`,
  ].join('\n');

  const output = redactEvidenceOutput(input);

  assert.ok(
    output.includes(`${prefix}service starting`),
    'text before the first prefixed header line must survive exactly',
  );
  assert.ok(
    output.includes(`${prefix}[REDACTED]`),
    'the timestamp prefix on the header\'s own line must survive — only the header itself starts the redacted span',
  );
  assert.equal(
    output.includes(fixturePemBodyLine1),
    false,
    'no body line may survive, even prefixed by its own per-line timestamp',
  );
  assert.equal(
    output.includes(fixturePemFooter),
    false,
    'the footer must never survive, even prefixed by its own per-line timestamp',
  );
  assert.ok(
    output.includes(`${prefix}service ready`),
    'text after the footer line must survive exactly, including its own timestamp prefix',
  );
});

/* -------------------------------------------------------------------------- */
/* 4 — a key inside an escaped-JSON string: newlines are the two-character    */
/* sequence backslash-n, never a real newline character                      */
/* -------------------------------------------------------------------------- */

test('redactEvidenceOutput redacts a PEM block whose newlines are the two-character escaped sequence backslash-n, as found inside an escaped-JSON string, rather than real newline characters: no body character survives, and text before the header survives (review round 4, owner fail-closed ruling, 2026-09-25)', () => {
  const redactEvidenceOutput = redactEvidenceOutputFactory();
  const escapedNewline = '\\n';
  const prefix = 'before text ';
  const input = [prefix, fixturePemHeader, escapedNewline, fixturePemBodyLine1, escapedNewline, fixturePemFooter].join('');

  const output = redactEvidenceOutput(input);

  assert.ok(output.startsWith(prefix), 'text before the header must survive exactly');
  assert.equal(
    output.includes(fixturePemBodyLine1),
    false,
    'the body must never survive redaction just because it is separated from the header and footer by the two-character escaped sequence backslash-n instead of a real newline',
  );
  assert.equal(output.includes(fixturePemFooter), false, 'the footer must never survive redaction as a dangling literal');
  assert.ok(output.includes('[REDACTED]'), 'the block must be replaced with the redaction marker');
});

/* -------------------------------------------------------------------------- */
/* 5 — a base64url-alphabet body ('-' and '_' in place of '+' and '/')        */
/* -------------------------------------------------------------------------- */

test('redactEvidenceOutput redacts a PEM block whose body uses the base64url alphabet (\'-\' and \'_\' in place of \'+\' and \'/\'): no body character run survives, and text after the footer survives (review round 4, owner fail-closed ruling, 2026-09-25)', () => {
  const redactEvidenceOutput = redactEvidenceOutputFactory();
  const suffix = ' tail text survives';
  const input = [fixturePemHeader, fixtureBase64UrlBodyLine, fixturePemFooter].join('\n') + suffix;

  const output = redactEvidenceOutput(input);

  assert.equal(
    output.includes(fixtureBase64UrlBodyLine),
    false,
    'a base64url-alphabet body must never survive redaction just because it uses \'-\' and \'_\' instead of \'+\' and \'/\'',
  );
  assert.equal(output.includes(fixturePemFooter), false, 'the footer must never survive redaction as a dangling literal');
  assert.ok(output.includes('tail text survives'), 'text after the footer must survive');
  assert.ok(output.includes('[REDACTED]'), 'the block must be replaced with the redaction marker');
});

/* -------------------------------------------------------------------------- */
/* 6 — two PEM keys back to back with prose between them: each is redacted    */
/* independently, and the prose between and after them survives              */
/* -------------------------------------------------------------------------- */

test('redactEvidenceOutput redacts two PEM blocks independently when placed back to back with prose between them: both blocks are redacted separately, and the prose between and after them survives (review round 4, owner fail-closed ruling, 2026-09-25)', () => {
  const redactEvidenceOutput = redactEvidenceOutputFactory();
  const input = [
    fixturePemHeader,
    fixturePemBodyLine1,
    fixturePemFooter,
    'middle prose',
    fixturePemHeader,
    fixturePemBodyLine2,
    fixturePemFooter,
    'tail',
  ].join('\n');

  const output = redactEvidenceOutput(input);

  assert.equal(output.includes(fixturePemBodyLine1), false, 'the first PEM body must never survive redaction');
  assert.equal(output.includes(fixturePemBodyLine2), false, 'the second PEM body must never survive redaction');
  assert.ok(output.includes('middle prose'), 'the prose between the two PEM blocks must survive');
  assert.ok(output.includes('tail'), 'the prose after the second PEM block must survive');
  const redactionMarkerCount = output.split('[REDACTED]').length - 1;
  assert.equal(
    redactionMarkerCount,
    2,
    `expected exactly two independent redaction markers, one per PEM block, with "middle prose" surviving between them; got ${redactionMarkerCount} in ${JSON.stringify(output)}`,
  );
});

/* -------------------------------------------------------------------------- */
/* 7 — timing: 1 MiB of alternating header/footer pairs must stay bounded     */
/* under the new contract's per-occurrence footer search (the existing       */
/* "1 MiB of repeated PEM headers with no footer" row above, review round 3,  */
/* PEM timing, already covers the footer-less half of this — kept, not       */
/* duplicated)                                                                */
/* -------------------------------------------------------------------------- */

test(
  'redactEvidenceOutput stays within a bound on 1 MiB of alternating PEM header/footer pairs, each independently redacted (review round 4, PEM timing)',
  { timeout: 10_000 },
  () => {
    const redactEvidenceOutput = redactEvidenceOutputFactory();
    const pairUnit = `${fixturePemHeader}\n${fixturePemBodyLine1}\n${fixturePemFooter}\n`;
    const input = buildRepeatedTextOfLength(pairUnit, ONE_MIB_CHARS);

    const startedAtMs = performance.now();
    redactEvidenceOutput(input);
    const elapsedMs = performance.now() - startedAtMs;

    assert.ok(
      elapsedMs < PEM_TIMING_BOUND_MS,
      `redactEvidenceOutput must stay under ${PEM_TIMING_BOUND_MS}ms on 1 MiB of alternating PEM header/footer pairs; took ${elapsedMs}ms`,
    );
  },
);

/* -------------------------------------------------------------------------- */
/* Review round 5 — an RFC 4880 armored secret key label, and a non-private   */
/* footer between a private header and its real footer                        */
/* -------------------------------------------------------------------------- */

test('redactEvidenceOutput redacts an RFC 4880 armored secret key (-----BEGIN PGP PRIVATE KEY BLOCK-----) header through its footer (review round 5, security blocker)', () => {
  const redactEvidenceOutput = redactEvidenceOutputFactory();
  const header = ['-----BEGIN ', 'PGP PRIVATE KEY BLOCK-----'].join('');
  const footer = ['-----END ', 'PGP PRIVATE KEY BLOCK-----'].join('');
  const body = 'lQOYBGX1' + 'Qk9ESQ'.repeat(10);
  const input = `config dump:\n${header}\nVersion: GnuPG v2\n\n${body}\n${footer}\ntail survives`;
  assert.equal(redactEvidenceOutput(input), 'config dump:\n[REDACTED]\ntail survives');
});

test('redactEvidenceOutput leaves an RFC 4880 PUBLIC key block untouched (review round 5, the PGP label widening stays private-only)', () => {
  const redactEvidenceOutput = redactEvidenceOutputFactory();
  const input = ['-----BEGIN ', 'PGP PUBLIC KEY BLOCK-----'].join('') + '\nmQENBGX1\n' + ['-----END ', 'PGP PUBLIC KEY BLOCK-----'].join('');
  assert.equal(redactEvidenceOutput(input), input);
});

test('redactEvidenceOutput skips a non-private -----END line between a private header and its real footer, and redacts through the real footer (review round 5, code-reviewer blocker)', () => {
  const redactEvidenceOutput = redactEvidenceOutputFactory();
  const header = ['-----BEGIN ', 'RSA PRIVATE KEY-----'].join('');
  const footer = ['-----END ', 'RSA PRIVATE KEY-----'].join('');
  const certificateFooter = ['-----END ', 'CERTIFICATE-----'].join('');
  const input = `lead\n${header}\nbodyone\n${certificateFooter}\nbodytwo\n${footer}\nTAIL`;
  assert.equal(redactEvidenceOutput(input), 'lead\n[REDACTED]\nTAIL');
});

test('redactEvidenceOutput skips a non-private -----BEGIN header that precedes a private one in the same string, and still redacts the private block (review round 6, code-reviewer advisory)', () => {
  const redactEvidenceOutput = redactEvidenceOutputFactory();
  const certificate = ['-----BEGIN ', 'CERTIFICATE-----'].join('') + '\nMIIBcert\n' + ['-----END ', 'CERTIFICATE-----'].join('');
  const privateBlock = ['-----BEGIN ', 'RSA PRIVATE KEY-----'].join('') + '\nbodyline\n' + ['-----END ', 'RSA PRIVATE KEY-----'].join('');
  assert.equal(redactEvidenceOutput(`${certificate}\nbetween\n${privateBlock}\ntail`), `${certificate}\nbetween\n[REDACTED]\ntail`);
});
