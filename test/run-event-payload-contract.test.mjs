/**
 * AIC-58, slice c: the pure domain half of "payloads remain small and
 * reference domain/evidence IDs rather than duplicating raw bodies" — a
 * closed registry, `RUN_EVENT_PAYLOAD_KEYS`,
 * naming exactly the `run_events.payload` keys each event `type` may carry,
 * and `assertRunEventPayload(type, payload)`, the refusal seam every write
 * eventually routes through.
 *
 * What this enforces is SHAPE and SIZE — a closed key set per type, values
 * that are strings or null, each string at most 256 characters. It does not
 * inspect CONTENT: a 256-character `reason` or `interactionId` can still carry
 * a credential, so the ticket's "no secret-bearing payloads" stays the
 * caller's obligation for those free-text fields, and nothing here checks it.
 *
 * The half that needs a real PostgreSQL — a fenced write whose payload
 * breaks the rule leaves NO `run_events` row and no counter increment
 * (transaction rollback) — lives on its own line,
 * `infra/postgres/tests/run-event-payload.live.mjs`, the same separation
 * `run-write-context.test.mjs` / `run-write-context.live.mjs` already use.
 *
 * ## Design choices this file assumes
 *
 * The ticket names the invariant ("payloads reference IDs, never raw
 * bodies") but not the exact refusal shape. Three choices are stated here
 * rather than discovered mid-assertion, both for consistency with
 * `InvalidLastEventIdError` (this same module, `run-event-stream.ts`) and
 * `ExecutionIntegrityViolation`/`StaleOwnerError` (`execution.ts`):
 *
 *   - one named `RunEventPayloadError` class, with a SINGLE stable `.code`
 *     (`'run_event_payload.invalid'`) across every refusal reason —
 *     mirroring `InvalidLastEventIdError`, which uses one code for every
 *     shape `parseLastEventId` refuses and distinguishes reasons only in the
 *     message text. Rows below check `instanceof`/`.name`/`.code`, never the
 *     exact message, for the same reason the sibling contract file states:
 *     "so a differently-worded refusal still passes".
 *   - the registry names the ALLOWED keys per type, not the required ones:
 *     `execution.integrity_violation` is written with two different literal
 *     shapes today (`{execKey, reason}` and
 *     `{execKey, storedResultSha, computedResultSha}`), so its entry is the
 *     union of both — a payload missing an allowed key is never refused,
 *     only a payload carrying a key outside the union.
 *   - `MAX_RUN_EVENT_PAYLOAD_STRING` bounds each STRING VALUE, not the whole
 *     payload's serialized size — the ticket calls out oversized strings
 *     ("a string longer than an exported cap"), not a total-byte budget.
 *
 * If the implementation has a reason to shape either differently, that
 * reason belongs in the PR description, not in a silent rename here.
 *
 * ## Premise found false while writing this file
 *
 * The task brief asserts the run_events-naming boundary is exactly four
 * files (`app-schema.ts`, `run-write-context.ts`, `run-event-stream.ts`,
 * `retention.ts`). Measured: `packages/persistence/src/index.ts` already
 * carries a bare `run_events` mention in its AIC-58 slice-a doc comment
 * ("... over `aic_app.run_events`"). See
 * test/run-events-table-boundary.test.mjs for where this is pinned instead
 * of silently widened here.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import * as domain from '@aic/domain';

const here = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(here, '..');
const RUN_WRITE_CONTEXT_SOURCE_PATH = resolve(
  projectRoot,
  'packages/persistence/src/run-write-context.ts',
);

/**
 * Every `type` this repository writes today, and the literal payload shape
 * `run-write-context.ts` writes for it (`grep appendEvent(client` there) —
 * pinned by hand as the independent oracle for the "accepts every literal
 * shape production writes today" row below, deliberately NOT derived from
 * `RUN_EVENT_PAYLOAD_KEYS` (`.claude/rules/invariants.md`, "independent
 * oracle"): a registry that under-approximated its own writers would still
 * satisfy a test built from the registry itself.
 */
const LITERAL_SHAPES_PRODUCTION_WRITES = Object.freeze([
  { type: 'node_result.committed', payload: { execKey: 'tool.trial/sha256:abc' } },
  { type: 'node_result.reused', payload: { execKey: 'tool.trial/sha256:abc' } },
  {
    type: 'execution.integrity_violation',
    payload: { execKey: 'tool.trial/sha256:abc', reason: 'stored_result_sha_mismatch' },
  },
  {
    type: 'execution.integrity_violation',
    payload: {
      execKey: 'tool.trial/sha256:abc',
      storedResultSha: 'a'.repeat(64),
      computedResultSha: 'b'.repeat(64),
    },
  },
  { type: 'run.waiting_human', payload: { interactionId: 'interaction-1' } },
  { type: 'run.completed', payload: { reason: null } },
  { type: 'run.completed', payload: { reason: 'graph finished' } },
  { type: 'run.failed', payload: { reason: 'tool exhausted retries' } },
]);

/**
 * A minimal, independent re-parse of `run-write-context.ts`'s own
 * `appendEvent(client, claim.runId, claim.executionAttempt, '<type>', {…})`
 * call sites: a regex over the raw source text, never an import of the
 * registry or of `appendEvent` itself — the correspondence rows below must
 * be able to catch a registry that drifted from what this file actually
 * writes, which a scan built from the registry could never do.
 *
 * Assumes (true of every call site today, per the ticket's own grep) that
 * the payload object literal is flat: no nested `{}`/`[]` inside it. A call
 * site that stopped being flat would make this regex under-match rather
 * than silently accept the wrong thing — see the non-vacuity assertion
 * below.
 */
function scanAppendEventCallSites(sourceText) {
  const CALL_SITE = /appendEvent\(\s*client\s*,\s*claim\.runId\s*,\s*claim\.executionAttempt\s*,\s*'([^']+)'\s*,\s*\{([^{}]*)\}\s*\)/g;
  const sites = [];
  for (const match of sourceText.matchAll(CALL_SITE)) {
    const [, type, rawKeys] = match;
    const keys = rawKeys
      .split(',')
      .map((part) => part.trim())
      .filter((part) => part.length > 0)
      .map((part) => part.split(':')[0].trim());
    sites.push({ type, keys });
  }
  return sites;
}

/* -------------------------------------------------------------------------- */
/* The registry itself                                                        */
/* -------------------------------------------------------------------------- */

test('@aic/domain exports RUN_EVENT_PAYLOAD_KEYS as a closed registry naming exactly the six event types run_write_context.ts writes today', () => {
  assert.ok(
    domain.RUN_EVENT_PAYLOAD_KEYS,
    '@aic/domain must export RUN_EVENT_PAYLOAD_KEYS — the closed type -> allowed-keys registry AIC-58 slice c asks for',
  );
  const documentedTypes = Object.keys(domain.RUN_EVENT_PAYLOAD_KEYS).sort();
  const expectedTypes = [
    'execution.integrity_violation',
    'node_result.committed',
    'node_result.reused',
    'run.completed',
    'run.failed',
    'run.waiting_human',
  ];
  assert.deepEqual(
    documentedTypes,
    expectedTypes,
    `RUN_EVENT_PAYLOAD_KEYS must name exactly the six event types run-write-context.ts writes today, got: ${JSON.stringify(documentedTypes)}`,
  );
});

test('@aic/domain exports MAX_RUN_EVENT_PAYLOAD_STRING equal to 256', () => {
  assert.equal(
    domain.MAX_RUN_EVENT_PAYLOAD_STRING,
    256,
    'MAX_RUN_EVENT_PAYLOAD_STRING must be the exported cap assertRunEventPayload enforces on every string value',
  );
});

test('@aic/domain exports assertRunEventPayload and RunEventPayloadError', () => {
  assert.equal(
    typeof domain.assertRunEventPayload,
    'function',
    '@aic/domain must export assertRunEventPayload(type, payload)',
  );
  assert.equal(
    typeof domain.RunEventPayloadError,
    'function',
    '@aic/domain must export a RunEventPayloadError class (a named, catchable Error subclass, mirroring InvalidLastEventIdError)',
  );
});

/* -------------------------------------------------------------------------- */
/* Accepts every literal shape production writes today (independent oracle)   */
/* -------------------------------------------------------------------------- */

test('assertRunEventPayload accepts every literal payload shape run-write-context.ts writes today', () => {
  for (const { type, payload } of LITERAL_SHAPES_PRODUCTION_WRITES) {
    assert.doesNotThrow(
      () => domain.assertRunEventPayload(type, payload),
      `assertRunEventPayload must accept the literal shape production writes for "${type}": ${JSON.stringify(payload)}`,
    );
  }
});

/* -------------------------------------------------------------------------- */
/* Refuses everything the ticket names                                        */
/* -------------------------------------------------------------------------- */

function assertRefusesAsRunEventPayloadError(type, payload, description) {
  assert.equal(
    typeof domain.assertRunEventPayload,
    'function',
    `${description}: @aic/domain must export assertRunEventPayload before this row can check what it refuses`,
  );
  assert.throws(
    () => domain.assertRunEventPayload(type, payload),
    (error) => {
      assert.equal(
        typeof domain.RunEventPayloadError,
        'function',
        `${description}: @aic/domain must export RunEventPayloadError before this row can check the error's class`,
      );
      assert.ok(error instanceof domain.RunEventPayloadError, `${description}: must throw RunEventPayloadError, got ${error?.constructor?.name}`);
      assert.equal(error.name, 'RunEventPayloadError', `${description}: .name must be RunEventPayloadError`);
      assert.equal(
        error.code,
        'run_event_payload.invalid',
        `${description}: .code must be the stable 'run_event_payload.invalid', mirroring InvalidLastEventIdError's one-code-per-class convention`,
      );
      return true;
    },
    description,
  );
}

test('assertRunEventPayload refuses an unknown event type', () => {
  assertRefusesAsRunEventPayloadError(
    'node_result.imagined',
    { execKey: 'x' },
    'an event type outside the registry must be refused',
  );
});

test('assertRunEventPayload refuses an inherited Object.prototype name as an unknown event type, with RunEventPayloadError rather than a TypeError', () => {
  for (const type of ['constructor', 'toString', '__proto__', 'hasOwnProperty', 'valueOf']) {
    assertRefusesAsRunEventPayloadError(type, { execKey: 'x' }, `the inherited name ${JSON.stringify(type)} is not a registered event type`);
  }
});

test('a refusal echoes a caller-supplied type or key bounded and escaped — never a raw newline, never its full length', () => {
  const longKey = `${'k'.repeat(300)}\n2026-09-24 ERROR forged-log-line`;
  const longType = `${'t'.repeat(500)}\nforged`;
  for (const [description, run] of [
    ['an oversized, newline-carrying key', () => domain.assertRunEventPayload('run.failed', { [longKey]: 'x' })],
    ['an oversized, newline-carrying type', () => domain.assertRunEventPayload(longType, {})],
  ]) {
    assert.throws(run, (error) => {
      assert.ok(error instanceof domain.RunEventPayloadError, `${description}: must throw RunEventPayloadError`);
      assert.ok(!error.message.includes('\n'), `${description}: the message must not carry a raw newline (a forged log line), got ${JSON.stringify(error.message.slice(0, 120))}`);
      assert.ok(error.message.length <= 200, `${description}: the message must be bounded, got ${error.message.length} characters`);
      return true;
    });
  }
});

test('assertRunEventPayload refuses a payload that is not a plain object', () => {
  for (const notAnObject of [null, undefined, 'a string', 42, true, ['execKey']]) {
    assertRefusesAsRunEventPayloadError(
      'node_result.committed',
      notAnObject,
      `a payload of ${JSON.stringify(notAnObject)} is not a plain object and must be refused`,
    );
  }
});

test('assertRunEventPayload refuses a key not allowed for the given type', () => {
  assertRefusesAsRunEventPayloadError(
    'node_result.committed',
    { execKey: 'x', extra: 'not allowed' },
    'an extra key outside the registered set for node_result.committed must be refused',
  );
});

test('assertRunEventPayload refuses a key that belongs to a DIFFERENT type, not this one', () => {
  assertRefusesAsRunEventPayloadError(
    'run.completed',
    { reason: 'ok', interactionId: 'borrowed-from-run.waiting_human' },
    'interactionId is registered for run.waiting_human, not run.completed, and must still be refused here',
  );
});

test('assertRunEventPayload refuses a value that is neither a string nor null', () => {
  for (const badValue of [42, true, {}, ['x'], undefined]) {
    assertRefusesAsRunEventPayloadError(
      'node_result.committed',
      { execKey: badValue },
      `execKey of ${JSON.stringify(badValue)} is neither a string nor null and must be refused`,
    );
  }
});

test('assertRunEventPayload accepts a null value where the registry allows it (run.completed\'s reason may be null)', () => {
  assert.doesNotThrow(() => domain.assertRunEventPayload('run.completed', { reason: null }));
});

test('assertRunEventPayload refuses a string value one character past MAX_RUN_EVENT_PAYLOAD_STRING (257), and accepts exactly the cap (256)', () => {
  const atCap = 'a'.repeat(domain.MAX_RUN_EVENT_PAYLOAD_STRING);
  const overCap = 'a'.repeat(domain.MAX_RUN_EVENT_PAYLOAD_STRING + 1);

  assert.doesNotThrow(
    () => domain.assertRunEventPayload('node_result.committed', { execKey: atCap }),
    'a string of exactly MAX_RUN_EVENT_PAYLOAD_STRING characters must be accepted — the cap is inclusive',
  );
  assertRefusesAsRunEventPayloadError(
    'node_result.committed',
    { execKey: overCap },
    'a string one character past MAX_RUN_EVENT_PAYLOAD_STRING must be refused',
  );
});

/* -------------------------------------------------------------------------- */
/* Correspondence, in both directions, against run-write-context.ts's own    */
/* source text (never against the registry's own logic)                      */
/* -------------------------------------------------------------------------- */

test('every appendEvent(client, …) call site in run-write-context.ts uses a type RUN_EVENT_PAYLOAD_KEYS knows, and only keys it allows for that type', () => {
  const sourceText = readFileSync(RUN_WRITE_CONTEXT_SOURCE_PATH, 'utf8');
  const sites = scanAppendEventCallSites(sourceText);

  // The floor is every appendEvent(client occurrence in the source, counted
  // with a plain substring search independent of the scan's own regex: a call
  // site the regex cannot parse (a nested payload, a double-quoted type, a
  // payload passed as a variable) makes the counts differ and reddens here,
  // instead of first failing at runtime inside a fenced transaction.
  const occurrences = sourceText.split('appendEvent(client').length - 1;
  assert.ok(occurrences > 0, 'run-write-context.ts must contain appendEvent(client call sites, or this row looks at nothing');
  assert.equal(
    sites.length,
    occurrences,
    `the regex scan parsed ${sites.length} appendEvent call sites but the source has ${occurrences} occurrences of "appendEvent(client" — every call site must be one the scan can read`,
  );

  for (const { type, keys } of sites) {
    const allowedKeys = domain.RUN_EVENT_PAYLOAD_KEYS?.[type];
    assert.ok(
      allowedKeys !== undefined,
      `run-write-context.ts appends a "${type}" event; RUN_EVENT_PAYLOAD_KEYS does not know this type at all`,
    );
    for (const key of keys) {
      assert.ok(
        allowedKeys.includes(key),
        `run-write-context.ts appends "${type}" with key "${key}"; RUN_EVENT_PAYLOAD_KEYS["${type}"] does not allow it (allows: ${JSON.stringify(allowedKeys)})`,
      );
    }
  }
});

test('every type RUN_EVENT_PAYLOAD_KEYS registers is written by at least one appendEvent call site in run-write-context.ts', () => {
  // Non-vacuity first: an absent (or empty) registry would make the loop
  // below iterate zero times and report a false pass, exactly the failure
  // mode `.claude/rules/invariants.md` warns a boundary scan against.
  assert.ok(
    domain.RUN_EVENT_PAYLOAD_KEYS && Object.keys(domain.RUN_EVENT_PAYLOAD_KEYS).length >= 6,
    'RUN_EVENT_PAYLOAD_KEYS must exist and register at least the six known event types before this row can mean anything',
  );

  const sourceText = readFileSync(RUN_WRITE_CONTEXT_SOURCE_PATH, 'utf8');
  const sites = scanAppendEventCallSites(sourceText);
  const writtenTypes = new Set(sites.map((site) => site.type));

  for (const registeredType of Object.keys(domain.RUN_EVENT_PAYLOAD_KEYS ?? {})) {
    assert.ok(
      writtenTypes.has(registeredType),
      `RUN_EVENT_PAYLOAD_KEYS registers "${registeredType}", but no appendEvent call site in run-write-context.ts writes it — a registry entry with no writer is dead weight nothing can ever pin against production`,
    );
  }
});
