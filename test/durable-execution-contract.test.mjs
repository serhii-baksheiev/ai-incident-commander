/**
 * AIC-56, slice A: the pure domain execution contracts
 * `docs/decisions/durable-run-execution.md` is built against - the run status
 * machine (decisions 2-4), the closed exec-key operation registry and
 * `buildExecKey` (decision 5, "Exactly-once external execution is not
 * claimed" - "the worker's ownership attempt is never part of an
 * `exec_key`"), `canonicalJson` as the one place canonical JSON lives
 * (`.claude/rules/invariants.md`, "one mechanism, one implementation"), and
 * the two integrity error classes decision 12 needs observable evidence to
 * carry a stable `code` on.
 *
 * This file does not touch PostgreSQL, leases, heartbeats or a worker process
 * - none of that exists yet, and none of it belongs in `packages/domain`
 * (`packages/domain` imports only `zod`, `node:crypto` and its own modules;
 * that boundary is already enforced generically by
 * scoped-domain-contract.test.mjs › "the domain package imports only zod,
 * node:crypto and its own modules", which scans every `.ts` file under
 * `packages/domain/src` - `execution.ts` is covered by that scan once it
 * exists, with no second copy of the check needed here).
 *
 * `buildExecKey`'s parts validation (missing part, extra part, wrong type) is
 * specified as a runtime refusal ("refuses (throws)"), not a compile-time
 * constraint, so this file tests it only through the public runtime entry
 * point - no separate type-contract fixture is added for it, to avoid
 * inventing a generic compile-time signature the spec does not ask for.
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';

import * as domain from '@aic/domain';
import * as tools from '@aic/tools';

/**
 * `assert.throws`, except that calling an export that does not exist yet is not
 * a refusal: without this, every "must refuse" row passed before the module it
 * describes was written, because `undefined(...)` throws too.
 */
const refuses = (fn, message) =>
  assert.throws(
    fn,
    (error) => !(error instanceof TypeError && /is not a function|Cannot read properties of undefined/.test(error.message)),
    message,
  );


const HEX_64_ZEROS = '0'.repeat(64);

/**
 * An independent oracle for `buildExecKey`: the documented tuple,
 * `JSON.stringify(['aic.exec', op, 1, ...parts in the registry's declared
 * order])`, hashed with node's own `crypto.createHash('sha256')` directly -
 * the same primitive `execution.ts` is specified to use, invoked here rather
 * than through `buildExecKey` (which does not exist yet, so it cannot be the
 * source of its own answer). See `incident-intake-idempotency.test.mjs`'s
 * `GOLDEN_KEY` comment for the same pattern applied to `deriveIdempotencyKey`.
 */
function independentExecKey(op, orderedPartValues) {
  const tuple = ['aic.exec', op, 1, ...orderedPartValues];
  const digest = createHash('sha256').update(JSON.stringify(tuple)).digest('hex');
  return `${op}/sha256:${digest}`;
}

const validTrialParts = () => ({ runId: 'run-1', testId: 'test-1', trialAttempt: 1 });
const validRoleParts = () => ({
  runId: 'run-1',
  role: 'investigator',
  promptVersion: 'v1',
  iterationsUsed: 2,
  challengeRounds: 1,
  resumeCount: 0,
});

/**
 * The exact command run to produce TOOL_TRIAL_GOLDEN_KEY and
 * MODEL_ROLE_GOLDEN_KEY below (matches `independentExecKey` above, computed
 * separately so the pin does not depend on this file's own helper either):
 *
 *   node -e "
 *     const crypto = require('crypto');
 *     function key(op, tuple) {
 *       const full = ['aic.exec', op, 1, ...tuple];
 *       const digest = crypto.createHash('sha256').update(JSON.stringify(full)).digest('hex');
 *       return op + '/sha256:' + digest;
 *     }
 *     console.log(key('tool.trial', ['run-1', 'test-1', 1]));
 *     console.log(key('model.role', ['run-1', 'investigator', 'v1', 2, 1, 0]));
 *   "
 */
const TOOL_TRIAL_GOLDEN_KEY = 'tool.trial/sha256:ba648ddbc4e17c67acffc70c64b26cf68ea77824c10d019ba17e97653436b7bc';
const MODEL_ROLE_GOLDEN_KEY = 'model.role/sha256:a5143cb2f9db89568eb76c61430dd9882c13ba4b3dd60bd0da458fc7cec021e8';

// --- 1. Run status machine ---------------------------------------------

const RUN_STATUSES_LITERAL = ['queued', 'running', 'waiting_human', 'completed', 'failed'];

test('RUN_STATUSES is exactly the five documented statuses, frozen', () => {
  assert.deepEqual(domain.RUN_STATUSES, RUN_STATUSES_LITERAL);
  assert.equal(Object.isFrozen(domain.RUN_STATUSES), true);
});

test('assertRunTransition allows exactly the seven documented transitions, against a literal 5x5 table', () => {
  // Independent oracle: this table is written by hand from the "Run lifecycle"
  // table of docs/decisions/durable-run-execution.md, never derived from
  // assertRunTransition itself. durable-run-execution-adr.test.mjs checks that
  // the record's table and the domain agree in both directions.
  const ALLOWED = new Set([
    'queued->running', // claim
    'queued->failed', // bounded exhaustion: no further attempt is allowed
    'running->waiting_human',
    'running->completed',
    'running->failed',
    'running->queued', // sweeper requeue after lease expiry
    'waiting_human->queued', // a resume request re-enqueues
  ]);

  for (const from of RUN_STATUSES_LITERAL) {
    for (const to of RUN_STATUSES_LITERAL) {
      const pair = `${from}->${to}`;
      if (ALLOWED.has(pair)) {
        assert.doesNotThrow(
          () => domain.assertRunTransition(from, to),
          `${pair} must be allowed`,
        );
      } else {
        refuses(
          () => domain.assertRunTransition(from, to),
          `${pair} must be refused`,
        );
      }
    }
  }
});

test('completed and failed are absorbing: every transition out of them is refused', () => {
  for (const terminal of ['completed', 'failed']) {
    for (const to of RUN_STATUSES_LITERAL) {
      refuses(
        () => domain.assertRunTransition(terminal, to),
        `${terminal}->${to} must be refused; ${terminal} is absorbing`,
      );
    }
  }
});

test('assertRunTransition throws on an unknown status on either side', () => {
  refuses(() => domain.assertRunTransition('bogus', 'running'));
  refuses(() => domain.assertRunTransition('queued', 'bogus'));
  refuses(() => domain.assertRunTransition('bogus', 'also-bogus'));
});

// --- 2. Closed operation registry ---------------------------------------

test('EXECUTION_OPERATIONS is frozen and names exactly tool.trial and model.role', () => {
  assert.equal(Object.isFrozen(domain.EXECUTION_OPERATIONS), true);
  assert.deepEqual(Object.keys(domain.EXECUTION_OPERATIONS).sort(), ['model.role', 'tool.trial']);
});

test('EXECUTION_OPERATIONS is frozen all the way down, including the part order a key is built from', () => {
  for (const [op, definition] of Object.entries(domain.EXECUTION_OPERATIONS)) {
    assert.equal(Object.isFrozen(definition), true, `${op} must be frozen`);
    assert.equal(Object.isFrozen(definition.order), true, `${op}.order must be frozen`);
  }
});

test('no operation name in the registry starts with action.', () => {
  for (const name of Object.keys(domain.EXECUTION_OPERATIONS)) {
    assert.equal(name.startsWith('action.'), false, `${name} must not start with action.`);
  }
});

/**
 * AIC-56 slice A review: a correspondence check between `order` (what
 * `buildExecKey` hashes into the tuple) and the operation's own zod strict
 * object shape (what `.safeParse` actually validates). Without this, `order`
 * and `schema` are two independent spellings of the same field list, and only
 * one of the two directions of drift is caught by the existing "missing part" /
 * "extra part" rows: a field the schema declares but `order` omits would parse
 * successfully and then silently vanish from the hashed tuple, with every
 * existing row still green because none of them separately reads
 * `schema.shape`. zod v4 strict objects expose `.shape` as a plain object of
 * the field schemas (measured on the installed zod 4.4.3).
 */
test('for each registered operation, definition.order lists exactly the keys of its own schema.shape', () => {
  for (const [op, definition] of Object.entries(domain.EXECUTION_OPERATIONS)) {
    const shapeKeys = new Set(Object.keys(definition.schema.shape));
    const orderKeys = new Set(definition.order);
    for (const key of shapeKeys) {
      assert.ok(
        orderKeys.has(key),
        `${op}'s schema declares ${key}; order does not list it, so buildExecKey would validate it but never hash it into the exec_key tuple`,
      );
    }
    for (const key of orderKeys) {
      assert.ok(
        shapeKeys.has(key),
        `${op}'s order lists ${key}; its schema does not declare it, so a caller-supplied value for it is never validated before being hashed`,
      );
    }
  }
});

// --- 3. buildExecKey ------------------------------------------------------

test('buildExecKey returns <op>/sha256:<64 hex> for a valid tool.trial and model.role input', () => {
  const trialKey = domain.buildExecKey('tool.trial', validTrialParts());
  const roleKey = domain.buildExecKey('model.role', validRoleParts());
  assert.match(trialKey, /^tool\.trial\/sha256:[0-9a-f]{64}$/);
  assert.match(roleKey, /^model\.role\/sha256:[0-9a-f]{64}$/);
});

test('buildExecKey pins the exact key for one fixed tool.trial and one fixed model.role input', () => {
  assert.equal(domain.buildExecKey('tool.trial', validTrialParts()), TOOL_TRIAL_GOLDEN_KEY);
  assert.equal(domain.buildExecKey('model.role', validRoleParts()), MODEL_ROLE_GOLDEN_KEY);
  // The independent oracle in this file must agree with the golden literal
  // above, or the golden literal (not the implementation) is wrong.
  assert.equal(independentExecKey('tool.trial', ['run-1', 'test-1', 1]), TOOL_TRIAL_GOLDEN_KEY);
  assert.equal(
    independentExecKey('model.role', ['run-1', 'investigator', 'v1', 2, 1, 0]),
    MODEL_ROLE_GOLDEN_KEY,
  );
});

test('buildExecKey is stable regardless of the parts object key order', () => {
  const inOrder = domain.buildExecKey('tool.trial', { runId: 'run-1', testId: 'test-1', trialAttempt: 1 });
  const reordered = domain.buildExecKey('tool.trial', { trialAttempt: 1, testId: 'test-1', runId: 'run-1' });
  assert.equal(inOrder, reordered);
});

test('buildExecKey gives a different key for a different trialAttempt, and a different runId', () => {
  const base = domain.buildExecKey('tool.trial', validTrialParts());

  const differentAttempt = domain.buildExecKey('tool.trial', { ...validTrialParts(), trialAttempt: 2 });
  assert.notEqual(differentAttempt, base, 're-observation (a new trialAttempt) must be a new logical operation');

  const differentRun = domain.buildExecKey('tool.trial', { ...validTrialParts(), runId: 'run-2' });
  assert.notEqual(differentRun, base, 'a different runId must give a different key');
});

test('buildExecKey never collides between tool.trial and model.role', () => {
  const trialKey = domain.buildExecKey('tool.trial', validTrialParts());
  const roleKey = domain.buildExecKey('model.role', validRoleParts());
  assert.notEqual(trialKey, roleKey);

  // Sharing the same runId value across both operations must still not collide.
  const trialKeySharedRun = domain.buildExecKey('tool.trial', { ...validTrialParts(), runId: 'shared-run' });
  const roleKeySharedRun = domain.buildExecKey('model.role', { ...validRoleParts(), runId: 'shared-run' });
  assert.notEqual(trialKeySharedRun, roleKeySharedRun);
});

test('buildExecKey refuses an operation name outside the registry', () => {
  refuses(() => domain.buildExecKey('action.restart-service', { runId: 'run-1' }));
  refuses(() => domain.buildExecKey('tool.other', validTrialParts()));
  refuses(() => domain.buildExecKey('', validTrialParts()));
});

test('buildExecKey refuses an operation name the registry only inherits from Object.prototype', () => {
  for (const inherited of ['toString', 'valueOf', 'constructor', 'hasOwnProperty', '__proto__', 'isPrototypeOf']) {
    refuses(() => domain.buildExecKey(inherited, { runId: 'run-1' }), `${inherited} is not a registered operation`);
  }
});

/**
 * AIC-56 slice A review: `op` is specified and typed as a string, but nothing
 * in `buildExecKey` checks `typeof op === 'string'` before using it as a
 * property key. `Object.hasOwn(EXECUTION_OPERATIONS, op)` coerces a non-string
 * key through `ToPropertyKey`, which calls the value's own `toString()` — so an
 * object whose `toString` returns a registered operation name is read as that
 * operation, not refused as a non-string `op`. A caller that meant to pass the
 * literal string `'tool.trial'` and instead passed something merely
 * string-*like* should not silently succeed.
 */
test('buildExecKey refuses a non-string op, without coercing it through ToPropertyKey into a registered operation name', () => {
  const objectOp = { toString: () => 'tool.trial' };
  refuses(
    () => domain.buildExecKey(objectOp, validTrialParts()),
    'an object whose toString() returns a registered operation name must still be refused: op must be the string itself, not anything merely coercible to one',
  );
  refuses(() => domain.buildExecKey(42, validTrialParts()), 'a number must be refused as an operation name');
});

/**
 * The companion to "bounds what a refusal echoes …" above, for the one input
 * shape that row does not cover: an `op` whose own `toString()` throws. The
 * refusal path calls `echoed(op)`, which calls `String(value)`, which for an
 * object invokes `toString()` — so a hostile `toString` runs INSIDE the
 * refusal's own error-message construction, not only inside `buildExecKey`'s
 * ordinary logic. This must still end in one bounded refusal, not an uncaught
 * exception from the guard's own reporting path.
 */
test('bounds what a refusal echoes even when the caller-supplied op\'s toString() itself throws', () => {
  const hostileOp = {
    toString() {
      throw new Error('nope');
    },
  };
  let message;
  let threw = false;
  try {
    domain.buildExecKey(hostileOp, validTrialParts());
  } catch (error) {
    threw = true;
    message = error instanceof Error ? error.message : String(error);
  }
  assert.equal(threw, true, 'buildExecKey must refuse a hostile-toString op rather than let the exception escape uncaught from somewhere other than a deliberate refusal');
  assert.equal(typeof message, 'string', 'the refusal must carry a string message');
  assert.equal(message.includes('\n'), false, 'a refusal must not carry a raw newline from the input');
  assert.ok(message.length < 300, `a refusal must not echo the input unbounded (got ${message.length} chars)`);
});

test('buildExecKey refuses a part that only a polluted Object.prototype supplies', () => {
  const { trialAttempt, ...missingAttempt } = validTrialParts();
  void trialAttempt;
  Object.prototype.trialAttempt = 9;
  try {
    refuses(() => domain.buildExecKey('tool.trial', missingAttempt), 'an inherited trialAttempt is not a supplied part');
  } finally {
    delete Object.prototype.trialAttempt;
  }
});

test('buildExecKey refuses an extra own __proto__ part rather than silently dropping it', () => {
  const parts = JSON.parse('{"runId":"run-1","testId":"test-1","trialAttempt":1,"__proto__":{"x":1}}');
  assert.equal(Object.hasOwn(parts, '__proto__'), true, 'the fixture must carry __proto__ as an own key');
  refuses(() => domain.buildExecKey('tool.trial', parts));
});

test('buildExecKey refuses trialAttempt 0: a Trial attempt counts from 1', () => {
  refuses(() => domain.buildExecKey('tool.trial', { ...validTrialParts(), trialAttempt: 0 }));
  assert.match(domain.buildExecKey('tool.trial', { ...validTrialParts(), trialAttempt: 1 }), /^tool\.trial\/sha256:/);
});

test('bounds what a refusal echoes of the caller-supplied operation name and statuses', () => {
  const hostile = `x${'y'.repeat(500)}\n[CRITICAL] forged log line`;
  for (const call of [
    () => domain.buildExecKey(hostile, { runId: 'run-1' }),
    () => domain.assertRunTransition(hostile, 'running'),
    () => domain.assertRunTransition('running', hostile),
  ]) {
    let message;
    try {
      call();
    } catch (error) {
      message = error.message;
    }
    assert.equal(typeof message, 'string', 'the call must refuse');
    assert.equal(message.includes('\n'), false, 'a refusal must not carry a raw newline from the input');
    assert.ok(message.length < 300, `a refusal must not echo the input unbounded (got ${message.length} chars)`);
  }
});

test('buildExecKey refuses a missing part', () => {
  const { trialAttempt, ...missingAttempt } = validTrialParts();
  void trialAttempt;
  refuses(() => domain.buildExecKey('tool.trial', missingAttempt));

  const { runId, ...missingRunId } = validRoleParts();
  void runId;
  refuses(() => domain.buildExecKey('model.role', missingRunId));
});

test('buildExecKey refuses an extra part, including a worker-ownership field', () => {
  refuses(() => domain.buildExecKey('tool.trial', { ...validTrialParts(), executionAttempt: 1 }));
  refuses(() => domain.buildExecKey('tool.trial', { ...validTrialParts(), ownerWorkerId: 'worker-1' }));
  refuses(() => domain.buildExecKey('tool.trial', { ...validTrialParts(), workerId: 'worker-1' }));
  refuses(() => domain.buildExecKey('model.role', { ...validRoleParts(), workerId: 'worker-1' }));
});

test('buildExecKey refuses a part of the wrong type', () => {
  refuses(
    () => domain.buildExecKey('tool.trial', { ...validTrialParts(), trialAttempt: 1.5 }),
    'a non-integer trialAttempt must be refused',
  );
  refuses(
    () => domain.buildExecKey('tool.trial', { ...validTrialParts(), trialAttempt: -1 }),
    'a negative trialAttempt must be refused',
  );
  refuses(
    () => domain.buildExecKey('tool.trial', { ...validTrialParts(), runId: '' }),
    'an empty runId must be refused',
  );
  refuses(
    () => domain.buildExecKey('tool.trial', { ...validTrialParts(), runId: 123 }),
    'a non-string runId must be refused',
  );
  refuses(
    () => domain.buildExecKey('model.role', { ...validRoleParts(), iterationsUsed: -1 }),
    'a negative iterationsUsed must be refused',
  );
  refuses(
    () => domain.buildExecKey('model.role', { ...validRoleParts(), challengeRounds: 1.5 }),
    'a non-integer challengeRounds must be refused',
  );
  refuses(
    () => domain.buildExecKey('model.role', { ...validRoleParts(), role: '' }),
    'an empty role must be refused',
  );
});

// --- 4. ExecKeySchema -----------------------------------------------------

test('ExecKeySchema accepts a key buildExecKey builds', () => {
  assert.equal(domain.ExecKeySchema.safeParse(TOOL_TRIAL_GOLDEN_KEY).success, true);
  assert.equal(domain.ExecKeySchema.safeParse(MODEL_ROLE_GOLDEN_KEY).success, true);
  assert.equal(domain.ExecKeySchema.safeParse(domain.buildExecKey('tool.trial', validTrialParts())).success, true);
});

test('ExecKeySchema refuses a string without the <op>/sha256: shape', () => {
  assert.equal(domain.ExecKeySchema.safeParse(`tool.trial/${HEX_64_ZEROS}`).success, false, 'missing sha256: prefix');
  assert.equal(
    domain.ExecKeySchema.safeParse(`tool.trial/sha256:${'0'.repeat(63)}`).success,
    false,
    '63 hex characters instead of 64',
  );
  assert.equal(
    domain.ExecKeySchema.safeParse(`tool.trial/sha256:${'A'.repeat(64)}`).success,
    false,
    'uppercase hex must be refused',
  );
  assert.equal(domain.ExecKeySchema.safeParse(`tool.trialsha256:${HEX_64_ZEROS}`).success, false, 'missing the slash');
  assert.equal(domain.ExecKeySchema.safeParse('').success, false);
});

test('ExecKeySchema refuses an op outside the registry', () => {
  assert.equal(
    domain.ExecKeySchema.safeParse(`action.restart-service/sha256:${HEX_64_ZEROS}`).success,
    false,
  );
  assert.equal(domain.ExecKeySchema.safeParse(`unknown.op/sha256:${HEX_64_ZEROS}`).success, false);
});

// --- 5. Errors --------------------------------------------------------

test('ExecutionIntegrityViolation carries code, execKey and is an Error named after its class', () => {
  const execKey = TOOL_TRIAL_GOLDEN_KEY;
  const err = new domain.ExecutionIntegrityViolation('a committed result already exists for this exec_key', {
    execKey,
  });
  assert.ok(err instanceof Error);
  assert.equal(err.name, 'ExecutionIntegrityViolation');
  assert.equal(err.code, 'execution.integrity_violation');
  assert.equal(err.execKey, execKey);
});

test('StaleOwnerError carries code and is an Error named after its class', () => {
  const err = new domain.StaleOwnerError('this worker no longer holds the fencing token');
  assert.ok(err instanceof Error);
  assert.equal(err.name, 'StaleOwnerError');
  assert.equal(err.code, 'execution.fenced');
});

// --- 6. canonicalJson -------------------------------------------------

test('canonicalJson sorts object keys recursively, stable across key-order permutations', () => {
  const a = domain.canonicalJson({ b: 1, a: { d: 2, c: 1 } });
  const b = domain.canonicalJson({ a: { c: 1, d: 2 }, b: 1 });
  assert.deepEqual(a, b);
  assert.deepEqual(Object.keys(a), ['a', 'b']);
  assert.deepEqual(Object.keys(a.a), ['c', 'd']);
});

test('canonicalJson keeps array order', () => {
  const result = domain.canonicalJson({ list: [3, 1, 2] });
  assert.deepEqual(result.list, [3, 1, 2]);
});

test('canonicalJson refuses non-JSON values: undefined in an object, a function, a bigint, NaN and Infinity', () => {
  refuses(() => domain.canonicalJson({ a: undefined }), 'undefined in an object must be refused');
  refuses(() => domain.canonicalJson({ a: () => 1 }), 'a function must be refused');
  refuses(() => domain.canonicalJson({ a: 1n }), 'a bigint must be refused');
  refuses(() => domain.canonicalJson({ a: Number.NaN }), 'NaN must be refused');
  refuses(() => domain.canonicalJson({ a: Number.POSITIVE_INFINITY }), 'Infinity must be refused');
  refuses(() => domain.canonicalJson({ a: Number.NEGATIVE_INFINITY }), '-Infinity must be refused');
});

/**
 * Measured today, on current code, with `@aic/tools`'s own
 * `createReplayFixtureKey` and `canonicalSerializeToolInput` - before slice A
 * makes `packages/tools/src/replay-key.ts` reuse `canonicalJson` instead of
 * its own private `canonicalize`. This row is the guard that the move changes
 * nothing: every literal below was produced by running, against the code at
 * this commit,
 *
 *   node -e "
 *     import('@aic/tools').then((tools) => {
 *       console.log(tools.createReplayFixtureKey('http.get', { url: 'https://example.com', headers: { b: 2, a: 1 } }));
 *       console.log(tools.createReplayFixtureKey('tool.with.array', { items: [3,1,2], nested: { z: 'x', a: 'y' } }));
 *       console.log(tools.createReplayFixtureKey('tool.empty', {}));
 *       console.log(tools.createReplayFixtureKey('tool.null', null));
 *       console.log(tools.createReplayFixtureKey('tool.string', 'plain-input'));
 *       console.log(tools.createReplayFixtureKey('tool.number', 42));
 *       console.log(tools.canonicalSerializeToolInput({ b: 1, a: [1, 2, { d: 1, c: 2 }] }));
 *     });
 *   "
 *
 * Measured also (same run): `canonicalize`'s treatment of the edge cases
 * `canonicalJson` is specified to refuse already matches that spec exactly -
 * an `undefined` object value, a function, a bigint and a non-finite number
 * (`NaN`/`Infinity`) each throw a `TypeError` today, both nested in an object
 * and passed as the whole input. There is no divergence to carry into the
 * tools row for those cases; this test pins byte-identical *successful*
 * outputs instead, which is what the slice-A move must leave unchanged.
 */
test('pins packages/tools/src/replay-key.ts output for fixed inputs, measured on current code', () => {
  assert.equal(
    tools.createReplayFixtureKey('http.get', { url: 'https://example.com', headers: { b: 2, a: 1 } }),
    '1:["http.get","{\\"headers\\":{\\"a\\":1,\\"b\\":2},\\"url\\":\\"https://example.com\\"}"]',
  );
  assert.equal(
    tools.createReplayFixtureKey('tool.with.array', { items: [3, 1, 2], nested: { z: 'x', a: 'y' } }),
    '1:["tool.with.array","{\\"items\\":[3,1,2],\\"nested\\":{\\"a\\":\\"y\\",\\"z\\":\\"x\\"}}"]',
  );
  assert.equal(tools.createReplayFixtureKey('tool.empty', {}), '1:["tool.empty","{}"]');
  assert.equal(tools.createReplayFixtureKey('tool.null', null), '1:["tool.null","null"]');
  assert.equal(tools.createReplayFixtureKey('tool.string', 'plain-input'), '1:["tool.string","\\"plain-input\\""]');
  assert.equal(tools.createReplayFixtureKey('tool.number', 42), '1:["tool.number","42"]');
  assert.equal(
    tools.canonicalSerializeToolInput({ b: 1, a: [1, 2, { d: 1, c: 2 }] }),
    '{"a":[1,2,{"c":2,"d":1}],"b":1}',
  );
});

test('replay-key canonicalize already refuses the same non-JSON values canonicalJson refuses (no divergence to reconcile)', () => {
  assert.throws(() => tools.createReplayFixtureKey('tool.undefined-field', { a: undefined }));
  assert.throws(() => tools.createReplayFixtureKey('tool.nan', { a: Number.NaN }));
  assert.throws(() => tools.createReplayFixtureKey('tool.fn', { a: () => 1 }));
  assert.throws(() => tools.createReplayFixtureKey('tool.bigint', { a: 1n }));
});
