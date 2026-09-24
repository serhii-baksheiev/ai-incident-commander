/**
 * AIC-58, slice a: the pure domain half of the "append-only run_events and
 * reconnect-safe stream source" ticket — the `RunEventStreamSource` port and
 * `RunEvent` shape (compile-time, row 1 below), and `parseLastEventId`, the
 * runtime seam that turns a reconnecting client's `Last-Event-ID` header (a
 * STRING, per the SSE spec) into the `afterSeq` the port's `readAfter`/`tail`
 * take.
 *
 * The half that needs a real PostgreSQL — a real `createRunEventStreamSource`
 * actually tailing committed rows, never before commit, surviving a restart —
 * lives on its own line, `infra/postgres/tests/run-event-stream.live.mjs`, the
 * same separation `run-write-context.test.mjs` / `run-write-context.live.mjs`
 * already use for slice C.
 *
 * ## Design choices this file assumes
 *
 * The ticket names the shape (`RunEventStreamSource`, `RunEvent`,
 * `parseLastEventId`) but not every internal detail. Two choices are stated
 * here rather than discovered mid-assertion:
 *
 *   - `parseLastEventId` throws a named `InvalidLastEventIdError` (mirroring
 *     `@aic/domain`'s existing `StaleOwnerError` / `ExecutionIntegrityViolation`:
 *     an `Error` subclass with a stable `code` and a `.name` equal to its own
 *     class name) rather than a generic `Error` or a return-a-sentinel shape.
 *     Rows below check `instanceof` and `.name`/`.code`, not the exact message
 *     text, so a differently-worded refusal still passes.
 *   - `RunEvent.createdAt` is a `Date` (matching `RunRecord.leaseExpiresAt` /
 *     `.heartbeatAt` in `packages/persistence/src/run-store.ts`, which are
 *     also `Date | null` rather than an ISO string), not a raw driver value.
 *
 * If the implementation has a reason to shape either differently, that reason
 * belongs in the PR description, not in a silent rename here.
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import * as domain from '@aic/domain';

import { childEnv } from './fixtures/child-env.mjs';

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const compilerPath = resolve(projectRoot, 'node_modules/typescript/bin/tsc');
const typeContractFixture = resolve(projectRoot, 'test/fixtures/run-event-stream-source-type-contract.ts');

/* -------------------------------------------------------------------------- */
/* Row 1 — the compile-time port contract                                     */
/* -------------------------------------------------------------------------- */

test('compiles the run-event-stream-source type contract: a RunEvent-shaped literal satisfies RunEventStreamSource, and a value missing tail is refused', () => {
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
    `type-contract compile exited ${result.status}\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}\n\n@aic/domain must export a RunEvent type ({ runId, seq, type, executionAttempt, payload, createdAt }) and a RunEventStreamSource port ({ readAfter(runId, afterSeq, options?), tail(runId, options?) }) for this fixture to compile — see test/fixtures/run-event-stream-source-type-contract.ts`,
  );
});

/* -------------------------------------------------------------------------- */
/* parseLastEventId — accepts                                                 */
/* -------------------------------------------------------------------------- */

function parseLastEventIdFactory() {
  assert.equal(
    typeof domain.parseLastEventId,
    'function',
    '@aic/domain must export parseLastEventId(value): the runtime seam that turns a reconnecting client\'s Last-Event-ID header into the afterSeq the RunEventStreamSource port takes',
  );
  return domain.parseLastEventId;
}

test('parseLastEventId accepts 0 as a number and returns 0', () => {
  assert.equal(parseLastEventIdFactory()(0), 0);
});

test('parseLastEventId accepts a positive integer number and returns it unchanged', () => {
  assert.equal(parseLastEventIdFactory()(42), 42);
});

test('parseLastEventId accepts "0" as a decimal string and returns the number 0', () => {
  assert.equal(parseLastEventIdFactory()('0'), 0);
});

test('parseLastEventId accepts a positive integer\'s decimal string, as the Last-Event-ID header sends it, and returns a number', () => {
  const parsed = parseLastEventIdFactory()('42');
  assert.equal(parsed, 42);
  assert.equal(typeof parsed, 'number', 'the header arrives as a string; the port\'s afterSeq is a number, so parseLastEventId must convert it');
});

test('parseLastEventId accepts Number.MAX_SAFE_INTEGER, both as a number and as its decimal string', () => {
  assert.equal(parseLastEventIdFactory()(Number.MAX_SAFE_INTEGER), Number.MAX_SAFE_INTEGER);
  assert.equal(parseLastEventIdFactory()(String(Number.MAX_SAFE_INTEGER)), Number.MAX_SAFE_INTEGER);
});

/* -------------------------------------------------------------------------- */
/* parseLastEventId — refuses                                                 */
/* -------------------------------------------------------------------------- */

function invalidLastEventIdErrorFactory() {
  assert.equal(
    typeof domain.InvalidLastEventIdError,
    'function',
    '@aic/domain must export InvalidLastEventIdError (an Error subclass, mirroring StaleOwnerError / ExecutionIntegrityViolation in execution.ts): parseLastEventId\'s refusal must be a named, catchable error, not a bare Error or a return-a-sentinel shape',
  );
  return domain.InvalidLastEventIdError;
}

function assertRefused(value, description) {
  const InvalidLastEventIdError = invalidLastEventIdErrorFactory();
  assert.throws(
    () => parseLastEventIdFactory()(value),
    (error) =>
      error instanceof InvalidLastEventIdError &&
      error instanceof Error &&
      error.name === 'InvalidLastEventIdError' &&
      typeof error.code === 'string' &&
      error.code.length > 0,
    `parseLastEventId(${JSON.stringify(value)}) must throw a named InvalidLastEventIdError (${description})`,
  );
}

test('parseLastEventId refuses a negative integer number', () => {
  assertRefused(-1, 'negative');
});

test('parseLastEventId refuses a negative integer\'s decimal string', () => {
  assertRefused('-1', 'negative');
});

test('parseLastEventId refuses a fractional number', () => {
  assertRefused(1.5, 'fractional');
});

test('parseLastEventId refuses a fractional decimal string', () => {
  assertRefused('1.5', 'fractional');
});

test('parseLastEventId refuses a non-numeric string', () => {
  assertRefused('abc', 'non-numeric');
});

test('parseLastEventId refuses the empty string', () => {
  assertRefused('', 'empty');
});

test('parseLastEventId refuses a value one past Number.MAX_SAFE_INTEGER, both as a number and as its decimal string', () => {
  assertRefused(Number.MAX_SAFE_INTEGER + 1, '> Number.MAX_SAFE_INTEGER');
  assertRefused(String(Number.MAX_SAFE_INTEGER + 1), '> Number.MAX_SAFE_INTEGER');
});

test('parseLastEventId refuses a decimal string far beyond Number.MAX_SAFE_INTEGER (never silently rounded through Number())', () => {
  assertRefused('99999999999999999999999999', 'far beyond Number.MAX_SAFE_INTEGER');
});

test('parseLastEventId refuses NaN and Infinity, which are numbers but never a valid sequence position', () => {
  assertRefused(Number.NaN, 'NaN');
  assertRefused(Number.POSITIVE_INFINITY, 'Infinity');
});

test('parseLastEventId refuses null, undefined, a boolean, an array and a plain object', () => {
  for (const value of [null, undefined, true, false, [], {}, [42]]) {
    assertRefused(value, `typeof ${typeof value}`);
  }
});
