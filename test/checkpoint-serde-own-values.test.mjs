import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { after } from 'node:test';

import { MemorySaver } from '@langchain/langgraph-checkpoint';

import {
  DESERIALIZATION_MAX_DEPTH,
  DESERIALIZATION_MAX_NODES,
  DeserializationBudgetError,
  createSqliteCheckpointer,
} from '@aic/persistence';

/**
 * Every row drives the serde the way the graph gets it — through
 * `createSqliteCheckpointer`, which is the only place in this repository that
 * builds a checkpointer. Deep-importing `@langchain/langgraph-checkpoint` here
 * would test a serializer nobody wired up.
 */
const temporaryRoot = mkdtempSync(join(tmpdir(), 'aic-serde-own-values-'));
const checkpointer = createSqliteCheckpointer(
  join(temporaryRoot, 'checkpoints.sqlite'),
);
const { serde } = checkpointer;

after(() => {
  checkpointer.db.close();
  rmSync(temporaryRoot, { recursive: true, force: true });
});

/** The field the whole ownership boundary was measured on. */
const POLLUTED_FIELD = 'humanReview';

/** What the serialized form declares, and therefore what must survive a load. */
const DECLARED_VALUE = true;

/** What the gadget substitutes: schema-valid, which is what makes the
 * substitution invisible to anything reading the control back. */
const SUBSTITUTED_VALUE = false;

/**
 * The gadget AIC-93 exists for: an inherited setter that answers the
 * deserializer's assignment by DEFINING the attacker's value on the target, so
 * the field is a genuine own data property and no ownership check can see it.
 */
function armOwnWritingGadget(field = POLLUTED_FIELD) {
  Object.defineProperty(Object.prototype, field, {
    configurable: true,
    get() {
      return SUBSTITUTED_VALUE;
    },
    set() {
      Object.defineProperty(this, field, {
        value: SUBSTITUTED_VALUE,
        writable: true,
        enumerable: true,
        configurable: true,
      });
    },
  });
}

/** The gadget that SWALLOWS the write instead: no own property is created and
 * every later read falls through to the getter. This is the shape the graph's
 * own refusal sites see and refuse. */
function armSwallowingGadget(field = POLLUTED_FIELD) {
  Object.defineProperty(Object.prototype, field, {
    configurable: true,
    get() {
      return SUBSTITUTED_VALUE;
    },
    set() {},
  });
}

/** The gadget that answers the write by defining an ACCESSOR on the target: an
 * own property whose value is recomputed on every read, which
 * `assertRestoredControlFieldsPresent` and `pickGraphOwnedControl` refuse. */
function armAccessorWritingGadget(field = POLLUTED_FIELD) {
  Object.defineProperty(Object.prototype, field, {
    configurable: true,
    get() {
      return SUBSTITUTED_VALUE;
    },
    set() {
      Object.defineProperty(this, field, {
        configurable: true,
        enumerable: true,
        get() {
          return SUBSTITUTED_VALUE;
        },
      });
    },
  });
}

/**
 * The own-writing gadget plus one line: it RE-PARENTS the target from inside
 * the setter it already controls.
 *
 * Found by `security-scanner` during the AIC-93 gate, measured end to end
 * through a `confirm` resume. The first version of this wrapper decided whether
 * to walk by asking whether the LOADED object's prototype was exactly
 * `Object.prototype`, so `Object.setPrototypeOf(this, Object.create(Object.prototype))`
 * made it answer no and the walk returned without repairing a single slot —
 * reopening the whole bypass, at no extra cost to an attacker who already owns
 * the setter body.
 *
 * The lesson is the shape of the check, not this gadget: what the walk is
 * allowed to READ is decided by the serialized form, which the gadget cannot
 * touch, so the loaded side may only be rejected for being unwalkable — never
 * for its prototype, which the gadget can choose.
 */
function armReparentingGadget(field = POLLUTED_FIELD) {
  Object.defineProperty(Object.prototype, field, {
    configurable: true,
    get() {
      return SUBSTITUTED_VALUE;
    },
    set() {
      Object.defineProperty(this, field, {
        value: SUBSTITUTED_VALUE,
        writable: true,
        enumerable: true,
        configurable: true,
      });
      Object.setPrototypeOf(this, Object.create(Object.prototype));
    },
  });
}

async function loadUnder(arm, value, field = POLLUTED_FIELD) {
  assert.equal(
    field in {},
    false,
    `the prototype is already carrying ${field} before this row started: an earlier row leaked it`,
  );
  const [type, data] = await serde.dumpsTyped(value);
  try {
    arm(field);
    return await serde.loadsTyped(type, data);
  } finally {
    delete Object.prototype[field];
  }
}

async function roundTrip(value) {
  const [type, data] = await serde.dumpsTyped(value);
  return serde.loadsTyped(type, data);
}

function ownDescriptor(target, key) {
  return Object.getOwnPropertyDescriptor(target, key);
}

test('keeps the own value when the gadget re-parents the target to escape the walk', async () => {
  const loaded = await loadUnder(armReparentingGadget, {
    [POLLUTED_FIELD]: DECLARED_VALUE,
    control: { [POLLUTED_FIELD]: DECLARED_VALUE },
    list: [{ [POLLUTED_FIELD]: DECLARED_VALUE }],
  });

  for (const [where, target] of [
    ['top level', loaded],
    ['one level down', loaded.control],
    ['inside an array', loaded.list[0]],
  ]) {
    assert.equal(
      Object.getPrototypeOf(target) === Object.prototype,
      false,
      `${where}: the gadget must actually have re-parented the target, or this row proves nothing`,
    );
    assert.deepEqual(
      ownDescriptor(target, POLLUTED_FIELD),
      {
        value: DECLARED_VALUE,
        writable: true,
        enumerable: true,
        configurable: true,
      },
      `${where}: a re-parented target must still be repaired — the prototype is the attacker's to choose`,
    );
  }
});

test('repairs the siblings of a __proto__ key, which the reviver re-parents on assignment', async () => {
  // The second route to the same skip, also measured by `security-scanner`.
  // `_reviver` does `revivedObj['__proto__'] = …`, which is a [[Set]] on the
  // `__proto__` accessor rather than a new key, so the object is re-parented
  // with no gadget armed at all. Every sibling key on it must still be
  // repaired.
  const [type, data] = await serde.dumpsTyped({
    control: { [POLLUTED_FIELD]: DECLARED_VALUE },
  });
  const text = new TextDecoder().decode(data);
  const withProtoKeyText = text.replace(
    '{"control":{',
    '{"control":{"__proto__":{"polluted":true},',
  );
  assert.notEqual(
    withProtoKeyText,
    text,
    'the fixture must actually carry a __proto__ key, or this row proves nothing',
  );
  const withProtoKey = new TextEncoder().encode(withProtoKeyText);

  let loaded;
  try {
    armOwnWritingGadget();
    loaded = await serde.loadsTyped(type, withProtoKey);
  } finally {
    delete Object.prototype[POLLUTED_FIELD];
  }

  assert.deepEqual(
    ownDescriptor(loaded.control, POLLUTED_FIELD),
    {
      value: DECLARED_VALUE,
      writable: true,
      enumerable: true,
      configurable: true,
    },
    'a __proto__ key must not take its siblings out of the repair',
  );
});

test('states its limit: an own key the serialized form does not declare is never examined', async () => {
  // The walk iterates Object.keys(declared), so a key that is not in the bytes
  // has nothing to be repaired TO. Found by `code-reviewer` at the AIC-93 gate.
  // Recorded as a limit rather than closed: deleting an undeclared key would be
  // this module inventing a refusal, and the graph is where refusals belong.
  assert.match(
    readFileSync(
      new URL('../packages/persistence/src/own-value-serde.ts', import.meta.url),
      'utf8',
    ),
    /is never examined/,
    'the guard must state this limit in the file, per .claude/rules/invariants.md',
  );

  const FABRICATED = 'stopKind';
  const loaded = await loadUnder(
    (field) => {
      Object.defineProperty(Object.prototype, field, {
        configurable: true,
        get() {
          return SUBSTITUTED_VALUE;
        },
        set() {
          Object.defineProperty(this, field, {
            value: SUBSTITUTED_VALUE,
            writable: true,
            enumerable: true,
            configurable: true,
          });
          Object.defineProperty(this, FABRICATED, {
            value: 'budget-exhausted',
            writable: true,
            enumerable: true,
            configurable: true,
          });
        },
      });
    },
    { [POLLUTED_FIELD]: DECLARED_VALUE },
  );

  assert.equal(
    loaded[POLLUTED_FIELD],
    DECLARED_VALUE,
    'the declared field is still repaired',
  );
  assert.equal(
    Object.hasOwn(loaded, FABRICATED),
    true,
    'the limit: a key the bytes never declared is left standing, because there is nothing to repair it to',
  );
});

test('states its limit: a declared object whose loaded slot is a primitive is left alone', async () => {
  // restoreSlot recurses whenever the DECLARED value is an object and never
  // falls through to the comparison, so a shape disagreement ends the walk for
  // that slot. Found by `code-reviewer` at the AIC-93 gate. Unreachable for a
  // control field today; a second optional graph-owned field would make it live.
  assert.match(
    readFileSync(
      new URL('../packages/persistence/src/own-value-serde.ts', import.meta.url),
      'utf8',
    ),
    /and the load left as a\s+\*\s+primitive, is skipped/,
    'the guard must state this limit in the file, per .claude/rules/invariants.md',
  );

  const [type, data] = await serde.dumpsTyped({ nested: { deeper: true } });
  const text = new TextDecoder().decode(data);
  const substituted = new TextEncoder().encode(
    text.replace('{"deeper":true}', '"a primitive the load will not match"'),
  );
  assert.notEqual(
    new TextDecoder().decode(substituted),
    text,
    'the fixture must actually substitute a primitive for the declared object',
  );

  const loaded = await serde.loadsTyped(type, substituted);

  assert.equal(
    loaded.nested,
    'a primitive the load will not match',
    'the load carries what the bytes say here, so this row pins the walk rather than the load',
  );
});

test('keeps the own value the serialized form declares when an inherited setter writes another', async () => {
  const loaded = await loadUnder(armOwnWritingGadget, {
    [POLLUTED_FIELD]: DECLARED_VALUE,
    control: { [POLLUTED_FIELD]: DECLARED_VALUE },
    deeply: { nested: { control: { [POLLUTED_FIELD]: DECLARED_VALUE } } },
    list: [{ [POLLUTED_FIELD]: DECLARED_VALUE }],
  });

  const sites = [
    ['top level', loaded],
    ['one level down', loaded.control],
    ['four levels down', loaded.deeply.nested.control],
    ['inside an array', loaded.list[0]],
  ];

  for (const [where, target] of sites) {
    assert.deepEqual(
      ownDescriptor(target, POLLUTED_FIELD),
      {
        value: DECLARED_VALUE,
        writable: true,
        enumerable: true,
        configurable: true,
      },
      `${where}: the loaded value must be the run's own, and the one the bytes on disk declare`,
    );
  }

  // A `DeltaSnapshot` carries its payload on `.value`, and the reviver builds
  // one by ASSIGNING into the constructor — so the carrier needs its own branch
  // in the walk. Without it the snapshot is not a plain object, the walk stops,
  // and the payload keeps the gadget's value.
  assert.equal(
    POLLUTED_FIELD in {},
    false,
    'an earlier row leaked the gadget onto the prototype',
  );
  let snapshot;
  try {
    armOwnWritingGadget();
    snapshot = await serde.loadsTyped(
      'json',
      `{"lc":2,"type":"delta_snapshot","value":{"${POLLUTED_FIELD}":true}}`,
    );
  } finally {
    delete Object.prototype[POLLUTED_FIELD];
  }
  assert.equal(snapshot.lg_name, 'DeltaSnapshot');
  assert.equal(
    snapshot.value[POLLUTED_FIELD],
    DECLARED_VALUE,
    'a value inside a DeltaSnapshot payload must be the one the bytes declare',
  );
});

test('leaves a swallowed write for the graph to refuse rather than repairing it', async () => {
  // A repair here would be a repair of the wrong half: the graph's refusal
  // sites exist for exactly these two shapes, and an unconditional "make the
  // loaded value match the serialized form" makes them stop firing.
  const swallowed = await loadUnder(armSwallowingGadget, {
    [POLLUTED_FIELD]: DECLARED_VALUE,
  });
  assert.equal(
    Object.hasOwn(swallowed, POLLUTED_FIELD),
    false,
    'an absent slot must stay absent, so the graph still refuses a control that is not its own',
  );

  const accessor = await loadUnder(armAccessorWritingGadget, {
    [POLLUTED_FIELD]: DECLARED_VALUE,
  });
  const descriptor = ownDescriptor(accessor, POLLUTED_FIELD);
  assert.notEqual(
    descriptor,
    undefined,
    'the accessor-writing gadget must leave an own property, or this row is not measuring that shape',
  );
  assert.equal(
    Object.hasOwn(descriptor, 'value'),
    false,
    'an own ACCESSOR must stay an accessor, so the presence check still refuses it',
  );
});

test('revives Set, Map, Uint8Array, RegExp, Error and DeltaSnapshot unchanged', async () => {
  const set = await roundTrip(new Set(['a', 'b']));
  assert.ok(set instanceof Set);
  assert.deepEqual([...set], ['a', 'b']);

  const map = await roundTrip(new Map([['k', { nested: 1 }]]));
  assert.ok(map instanceof Map);
  assert.deepEqual([...map], [['k', { nested: 1 }]]);

  const bytes = await roundTrip({ payload: new Uint8Array([1, 2, 250]) });
  assert.ok(bytes.payload instanceof Uint8Array);
  assert.deepEqual([...bytes.payload], [1, 2, 250]);

  const pattern = await roundTrip(/ab+c/gi);
  assert.ok(pattern instanceof RegExp);
  assert.equal(pattern.source, 'ab+c');
  assert.equal(pattern.flags, 'gi');

  const error = await roundTrip(new Error('transient model failure'));
  assert.ok(error instanceof Error);
  assert.equal(error.message, 'transient model failure');

  // A `DeltaSnapshot` is built by the reviver from its own record shape, so it
  // is driven through the wire form rather than by importing the class.
  const snapshot = await serde.loadsTyped(
    'json',
    '{"lc":2,"type":"delta_snapshot","value":{"channel":7}}',
  );
  assert.equal(snapshot.lg_name, 'DeltaSnapshot');
  assert.deepEqual(snapshot.value, { channel: 7 });

});

test('keeps an own key whose serialized value is undefined', async () => {
  const loaded = await roundTrip({ stopKind: undefined, runId: 'run-1' });

  assert.equal(
    Object.hasOwn(loaded, 'stopKind'),
    true,
    'an explicitly undefined key must survive as an own key, or an optional control field silently disappears',
  );
  assert.equal(loaded.stopKind, undefined);
  assert.equal(loaded.runId, 'run-1');
});

test('passes a bytes payload through untouched', async () => {
  const payload = new Uint8Array([0xff, 0x00, 0x01, 0x80]);
  const [type, data] = await serde.dumpsTyped(payload);

  assert.equal(type, 'bytes', 'a Uint8Array must still take the bytes route');

  // Not valid JSON: a wrapper that parsed the payload regardless of type would
  // throw here rather than returning the bytes.
  const loaded = await serde.loadsTyped(type, data);
  assert.deepEqual([...loaded], [...payload]);
});

/** `count` nested objects, so the deepest one sits at depth `count - 1`. */
function nestedObjects(count) {
  let node = { leaf: 'bottom' };
  for (let level = 1; level < count; level += 1) node = { v: node };
  return node;
}

/** An array of `count` objects, which the walk counts as `count + 1` nodes. */
function wideArray(count) {
  return Array.from({ length: count }, (_, index) => ({ index }));
}

test('refuses a checkpoint value nested deeper than DESERIALIZATION_MAX_DEPTH', async () => {
  const tooDeep = JSON.stringify(nestedObjects(DESERIALIZATION_MAX_DEPTH + 2));

  await assert.rejects(
    () => serde.loadsTyped('json', tooDeep),
    (error) => {
      assert.ok(
        error instanceof DeserializationBudgetError,
        `the refusal must be the budget error, not: ${error}`,
      );
      assert.match(
        error.message,
        new RegExp(String(DESERIALIZATION_MAX_DEPTH)),
        'the refusal must name the limit it refused on',
      );
      return true;
    },
  );
});

test('refuses a checkpoint value carrying more than DESERIALIZATION_MAX_NODES nodes', async () => {
  const tooWide = JSON.stringify(wideArray(DESERIALIZATION_MAX_NODES));

  await assert.rejects(
    () => serde.loadsTyped('json', tooWide),
    (error) => {
      assert.ok(
        error instanceof DeserializationBudgetError,
        `the refusal must be the budget error, not: ${error}`,
      );
      assert.match(
        error.message,
        new RegExp(String(DESERIALIZATION_MAX_NODES)),
        'the refusal must name the limit it refused on',
      );
      return true;
    },
  );
});

test('accepts a value just inside both bounds', async () => {
  // Without this row a bound is satisfied by refusing everything, which is the
  // failure mode a fail-closed guard has and a fail-open one does not.
  const deepest = await serde.loadsTyped(
    'json',
    JSON.stringify(nestedObjects(DESERIALIZATION_MAX_DEPTH + 1)),
  );
  let walked = deepest;
  for (let level = 1; level <= DESERIALIZATION_MAX_DEPTH; level += 1) {
    walked = walked.v;
  }
  assert.equal(
    walked.leaf,
    'bottom',
    'the deepest accepted value must come back whole',
  );

  const widest = await serde.loadsTyped(
    'json',
    JSON.stringify(wideArray(DESERIALIZATION_MAX_NODES - 1)),
  );
  assert.equal(widest.length, DESERIALIZATION_MAX_NODES - 1);
  assert.deepEqual(widest.at(-1), { index: DESERIALIZATION_MAX_NODES - 2 });
});

test('states its limit: a polluted key inside a Map member is not repaired', async () => {
  const source = readFileSync(
    new URL('../packages/persistence/src/own-value-serde.ts', import.meta.url),
    'utf8',
  );
  assert.match(
    source,
    /inside a revived non-plain value is\s+\*\s+NOT repaired/,
    'the guard must state this limit in the file, per .claude/rules/invariants.md',
  );

  const loaded = await loadUnder(
    armOwnWritingGadget,
    new Map([['member', { [POLLUTED_FIELD]: DECLARED_VALUE }]]),
  );

  assert.ok(loaded instanceof Map, 'the Map itself must still revive');
  assert.equal(
    loaded.get('member')[POLLUTED_FIELD],
    SUBSTITUTED_VALUE,
    'the limit still holds: if this is now the declared value the limit has closed — update the comment and this row',
  );
});

test('states its limit: a checkpointer this module did not build keeps the unrepaired serde', async () => {
  const source = readFileSync(
    new URL('../packages/persistence/src/own-value-serde.ts', import.meta.url),
    'utf8',
  );
  assert.match(
    source,
    /loses this entirely/,
    'the guard must state this limit in the file, per .claude/rules/invariants.md',
  );

  // `createInvestigationGraph` takes any `BaseCheckpointSaver`, and the repair
  // travels with the checkpointer rather than with the graph. `MemorySaver` is
  // a saver a caller could wire up directly, carrying the default serde.
  const theirs = new MemorySaver().serde;
  const [type, data] = await theirs.dumpsTyped({
    [POLLUTED_FIELD]: DECLARED_VALUE,
  });

  assert.equal(POLLUTED_FIELD in {}, false);
  let loaded;
  try {
    armOwnWritingGadget();
    loaded = await theirs.loadsTyped(type, data);
  } finally {
    delete Object.prototype[POLLUTED_FIELD];
  }

  assert.equal(
    loaded[POLLUTED_FIELD],
    SUBSTITUTED_VALUE,
    'the limit still holds: a serde this module did not wrap keeps the gadget\'s value',
  );
  assert.equal(
    Object.hasOwn(loaded, POLLUTED_FIELD),
    true,
    'and it is genuinely own, which is why no ownership check downstream sees it',
  );
});
