import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { after } from 'node:test';

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
    /inside a `Map` or `Set` is NOT repaired/,
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
