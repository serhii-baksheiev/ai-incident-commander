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

/**
 * The gadget that answers the write by defining a NON-CONFIGURABLE own data
 * property: the one shape the repair cannot write back over, because
 * `Object.defineProperty` refuses to redefine it.
 */
function armNonConfigurableWritingGadget(field = POLLUTED_FIELD) {
  Object.defineProperty(Object.prototype, field, {
    configurable: true,
    get() {
      return SUBSTITUTED_VALUE;
    },
    set() {
      Object.defineProperty(this, field, {
        value: SUBSTITUTED_VALUE,
        writable: false,
        enumerable: true,
        configurable: false,
      });
    },
  });
}

/** The container key a real checkpoint carries the whole state under, and the
 * one an inherited setter can intercept: unlike `control` it is not a LangGraph
 * channel name, so nothing else stops it. */
const CONTAINER_KEY = 'channel_values';

/** What the bytes declare under that container: the honest control, one level
 * down, exactly as a checkpoint stores it. */
const DECLARED_CONTAINER = {
  [CONTAINER_KEY]: { control: { [POLLUTED_FIELD]: DECLARED_VALUE } },
};

/**
 * A setter on the CONTAINER key that hands back a subtree of the gadget's own
 * making, carrying the substituted control.
 *
 * `plant` is the one thing the rows below vary: it decides the DESCRIPTOR the
 * attacker's subtree sits under — an own accessor, which `readOwnDataValue`
 * reports as absent, or an own data property, which it reports as present. Two
 * rows over one gadget is what isolates that descriptor as the discriminator;
 * a second hand-written gadget would let them drift apart and prove nothing.
 */
function armContainerGadget(plant) {
  return (field) => {
    Object.defineProperty(Object.prototype, field, {
      configurable: true,
      get() {
        return undefined;
      },
      set(honest) {
        plant(this, field, {
          control: { ...honest.control, [POLLUTED_FIELD]: SUBSTITUTED_VALUE },
        });
      },
    });
  };
}

/** Plants the attacker's subtree as an own ACCESSOR at the container key
 * itself, so the slot the walk reads under a declared container is not a data
 * property. */
function plantAccessorAtContainer(target, field, substituted) {
  Object.defineProperty(target, field, {
    enumerable: true,
    configurable: true,
    get() {
      return substituted;
    },
  });
}

/** Plants an honest-looking own data property at the container key whose
 * `control` is the accessor, so the non-data slot sits one level further in. */
function plantAccessorUnderContainer(target, field, substituted) {
  const shim = {};
  Object.defineProperty(shim, 'control', {
    enumerable: true,
    configurable: true,
    get() {
      return substituted.control;
    },
  });
  Object.defineProperty(target, field, {
    value: shim,
    writable: true,
    enumerable: true,
    configurable: true,
  });
}

/** The discriminating half: the same substituted subtree, planted as own DATA
 * properties the whole way down. */
function plantDataUnderContainer(target, field, substituted) {
  Object.defineProperty(target, field, {
    value: substituted,
    writable: true,
    enumerable: true,
    configurable: true,
  });
}

/** A key a real checkpoint carries an ARRAY under, and the second shape a
 * setter can intercept. */
const ARRAY_KEY = 'messages';

/** What the bytes declare under it: one element, carrying the field the whole
 * ownership boundary was measured on. */
const DECLARED_ARRAY = { [ARRAY_KEY]: [{ [POLLUTED_FIELD]: DECLARED_VALUE }] };

/**
 * A setter on an ARRAY key that hands back a counterpart of the gadget's
 * choosing, holding the substituted element at index 0.
 *
 * `makeCounterpart` is the one thing the two rows below vary: an array-LIKE
 * object, which `Array.isArray` answers no for, against a genuine array. The
 * element it carries is identical either way, so the counterpart's kind is
 * isolated as the discriminator.
 */
function armArrayGadget(makeCounterpart) {
  return (field) => {
    Object.defineProperty(Object.prototype, field, {
      configurable: true,
      get() {
        return undefined;
      },
      set(honest) {
        Object.defineProperty(this, field, {
          value: makeCounterpart({
            ...honest[0],
            [POLLUTED_FIELD]: SUBSTITUTED_VALUE,
          }),
          writable: true,
          enumerable: true,
          configurable: true,
        });
      },
    });
  };
}

/** The counterpart the walk cannot pair with an array declaration: an object
 * carrying the same indices. */
const arrayLikeObject = (element) => ({ 0: element, length: 1 });

/** The counterpart it can: a genuine array. */
const genuineArray = (element) => [element];

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

test('hands a revived LangChain lc:1 instance back exactly as the reviver built it', async () => {
  // `code-reviewer` and `security-scanner` both measured this independently: a
  // revived Serializable has an own DATA property `type` = "human", and the
  // `lc:1` record declares `"type":"constructor"`, so a walk that enters the
  // instance sees a diverged own data property and overwrites it — `getType()`
  // then answers "constructor" and `instanceof` fails.
  //
  // The walk therefore stops at a node the DECLARED side marks as a record the
  // reviver consumes, read as an OWN property of the parsed bytes rather than
  // through the prototype chain, which is the mistake this whole guard is about.
  const { HumanMessage } = await import('@langchain/core/messages');
  const original = new HumanMessage({ content: 'hi' });

  const loaded = await roundTrip({ message: original });

  assert.ok(
    loaded.message instanceof HumanMessage,
    'the revived instance must survive the walk',
  );
  assert.equal(
    loaded.message.getType(),
    'human',
    "if this is 'constructor' the walk entered the instance and overwrote its own `type`",
  );
});

test('reads the lc marker as an own property, so an inherited lc cannot make every declared node look like a revived record', async () => {
  // `isRevivedRecord` is the walk's one EARLY RETURN over declared data, so
  // whatever answers it decides whether anything is repaired at all. Reading
  // `lc` with `[[Get]]` hands that decision to the prototype chain — the exact
  // mistake this module exists to undo — and one inherited `lc` then makes
  // every declared node look like a record the reviver consumed, so the walk
  // returns before repairing a single slot and the whole AIC-93 bypass is back.
  //
  // The decoy is inert to the dependency: `jsonplus.js` needs
  // `type === "constructor"` with an array `id` for `lc: 1`, and `lc === 2` for
  // its undefined record, so an inherited `lc` changes nothing about what is
  // revived — which is what makes this a silent total bypass rather than a
  // visible breakage.
  const [type, data] = await serde.dumpsTyped({
    control: { [POLLUTED_FIELD]: DECLARED_VALUE },
  });
  assert.equal(
    POLLUTED_FIELD in {},
    false,
    'an earlier row leaked the gadget onto the prototype',
  );
  assert.equal('lc' in {}, false, 'an earlier row leaked lc onto the prototype');

  let loaded;
  try {
    Object.defineProperty(Object.prototype, 'lc', {
      value: 1,
      writable: true,
      enumerable: true,
      configurable: true,
    });
    armOwnWritingGadget();
    loaded = await serde.loadsTyped(type, data);
  } finally {
    delete Object.prototype[POLLUTED_FIELD];
    delete Object.prototype.lc;
  }

  assert.equal(
    Object.hasOwn(loaded.control, 'lc'),
    false,
    'the decoy must stay inherited — an own lc would be a different row',
  );
  assert.deepEqual(
    ownDescriptor(loaded.control, POLLUTED_FIELD),
    {
      value: DECLARED_VALUE,
      writable: true,
      enumerable: true,
      configurable: true,
    },
    'the marker must be read as an OWN property: an inherited lc that answers for every node stops the walk before it repairs anything',
  );
});

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

test('keeps the own value when the gadget hands back an Array as the container', async () => {
  // The third bypass of the same class, found by `security-scanner` at the
  // AIC-93 gate and measured end to end through a real `confirm` resume.
  //
  // The gate used to reject the loaded side when `Array.isArray(loaded)` or
  // `typeof loaded !== 'object'`. Both are the GADGET'S to choose: a setter on
  // a parent key hands back an Array — or a function — carrying the same data,
  // and the whole subtree under it is skipped. In the real checkpoint the
  // interceptable key is `channel_values`, which is not a LangGraph channel
  // name and so does not hit the channel-map collision that accidentally stops
  // the `control` key.
  //
  // The rule this row exists to hold: the loaded side is rejected ONLY for
  // being genuinely unwalkable — a primitive, which cannot carry a property at
  // all. Everything else is decided from the serialized form.
  for (const [label, makeContainer] of [
    ['an Array', () => []],
    ['a function', () => Object.assign(function container() {}, {})],
  ]) {
    const loaded = await loadUnder(
      (field) => {
        Object.defineProperty(Object.prototype, field, {
          configurable: true,
          get() {
            return undefined;
          },
          set(incoming) {
            const container = makeContainer();
            for (const [key, value] of Object.entries(incoming ?? {})) {
              container[key] = value;
            }
            Object.defineProperty(container.control, POLLUTED_FIELD, {
              value: SUBSTITUTED_VALUE,
              writable: true,
              enumerable: true,
              configurable: true,
            });
            Object.defineProperty(this, field, {
              value: container,
              writable: true,
              enumerable: true,
              configurable: true,
            });
          },
        });
      },
      { channel_values: { control: { [POLLUTED_FIELD]: DECLARED_VALUE } } },
      'channel_values',
    );

    assert.equal(
      loaded.channel_values.control[POLLUTED_FIELD],
      DECLARED_VALUE,
      `${label}: a container the gadget chose must not take its subtree out of the repair`,
    );
  }
});

test('refuses the load when the slot under a declared container key is not an own data property, and names that key', async () => {
  // The fourth bypass of the same class, measured end to end through a real
  // `confirm` resume: `outcome: COMPLETED`, a persisted control carrying
  // `humanReview:false` that `IncidentStateControlSchema` accepts, and a
  // `humanReview` descriptor on disk that is a genuine own data property.
  //
  // `restoreSlot`'s object-valued branch reads the loaded slot with
  // `readOwnDataValue`, which answers `present: false` for an own ACCESSOR —
  // and then returns. On a LEAF that is the deliberate carve-out: the shape is
  // left for `assertRestoredControlFieldsPresent` and `pickGraphOwnedControl`
  // to refuse. At a CONTAINER key there is no graph refusal site at all, so the
  // whole subtree under it is neither repaired here nor refused there, and the
  // gadget's control is handed back whole.
  //
  // A container therefore fails CLOSED, in the same spirit as the bound
  // refusals: the load throws rather than returning a subtree whose own values
  // were never verified, and the message names the key it refused on so an
  // operator reading it knows where the substitution was attempted.
  for (const [where, plant, offendingKey] of [
    ['at the container key itself', plantAccessorAtContainer, CONTAINER_KEY],
    ['one level under the container', plantAccessorUnderContainer, 'control'],
  ]) {
    await assert.rejects(
      () =>
        loadUnder(armContainerGadget(plant), DECLARED_CONTAINER, CONTAINER_KEY),
      (error) => {
        assert.ok(
          error instanceof Error,
          `${where}: the refusal must be an Error, not: ${error}`,
        );
        assert.ok(
          error.message.includes(offendingKey),
          `${where}: the refusal must name the key it refused on — got: ${error.message}`,
        );
        return true;
      },
      `${where}: a declared container whose loaded slot is an own accessor must be refused, not handed back as the gadget built it`,
    );
  }
});

test('repairs a declared container whose loaded slot the gadget planted as an own data property', async () => {
  // The discriminating half of the row above: the same gadget, the same
  // substituted subtree, the same container key — only the DESCRIPTOR differs.
  // Here the slot is an own data property, `readOwnDataValue` reports it
  // present, the walk enters and the declared value goes back. Without this row
  // the refusal above is satisfied by refusing every container, which is the
  // failure mode a fail-closed guard has and the one this pair exists to catch.
  const loaded = await loadUnder(
    armContainerGadget(plantDataUnderContainer),
    DECLARED_CONTAINER,
    CONTAINER_KEY,
  );

  assert.deepEqual(
    ownDescriptor(loaded[CONTAINER_KEY].control, POLLUTED_FIELD),
    {
      value: DECLARED_VALUE,
      writable: true,
      enumerable: true,
      configurable: true,
    },
    'a container the walk can read must still be repaired to the value the bytes declare',
  );
});

test('refuses the load when a declared array is answered by a non-array counterpart, and names that key', async () => {
  // The same family as the row above, on the other container kind, and live at
  // this head: `restoreDeclared` pairs arrays with
  // `Array.isArray(declared) && Array.isArray(loaded)`, and when the loaded
  // side is not an array it falls through to `if (!isPlainObject(declared))
  // return` — which an array declaration satisfies, so the whole subtree is
  // skipped. An array-LIKE object carrying the same indices therefore keeps the
  // gadget's element, as own data properties, with nothing downstream to refuse
  // it.
  //
  // Skipping is the wrong answer for a container either way: no repair here and
  // no refusal anywhere. It fails closed instead, naming the key.
  await assert.rejects(
    () => loadUnder(armArrayGadget(arrayLikeObject), DECLARED_ARRAY, ARRAY_KEY),
    (error) => {
      assert.ok(
        error instanceof Error,
        `the refusal must be an Error, not: ${error}`,
      );
      assert.ok(
        error.message.includes(ARRAY_KEY),
        `the refusal must name the key it refused on — got: ${error.message}`,
      );
      return true;
    },
    'a declared array answered by a non-array counterpart must be refused, not skipped',
  );
});

test('repairs a declared array element-wise when the loaded counterpart is a genuine array', async () => {
  // The discriminating half: same gadget, same substituted element, and the
  // counterpart is an array — so the walk pairs the two and the declared value
  // goes back. Without this row the refusal above is satisfied by refusing
  // every array.
  const loaded = await loadUnder(
    armArrayGadget(genuineArray),
    DECLARED_ARRAY,
    ARRAY_KEY,
  );

  assert.deepEqual(
    ownDescriptor(loaded[ARRAY_KEY][0], POLLUTED_FIELD),
    {
      value: DECLARED_VALUE,
      writable: true,
      enumerable: true,
      configurable: true,
    },
    'an element inside a paired array must be repaired to the value the bytes declare',
  );
});

test('states its limit: a Proxy that lies through getOwnPropertyDescriptor is not repaired', async () => {
  assert.match(
    readFileSync(
      new URL('../packages/persistence/src/own-value-serde.ts', import.meta.url),
      'utf8',
    ),
    /defeats the\s+\*\s+comparison/,
    'the guard must state this limit in the file, per .claude/rules/invariants.md',
  );

  // The comparison asks for a descriptor. A proxy can report the honest value
  // there and answer [[Get]] with the attacker's, so nothing looks diverged.
  // Found by `security-scanner` at the AIC-93 gate; recorded rather than fixed,
  // because the graph's own threat-model note does not cover a proxy a
  // pollution gadget builds inside a setter.
  const loaded = await loadUnder(
    (field) => {
      Object.defineProperty(Object.prototype, field, {
        configurable: true,
        get() {
          return undefined;
        },
        set() {
          const honest = { [POLLUTED_FIELD]: DECLARED_VALUE };
          Object.defineProperty(this, field, {
            value: new Proxy(
              { [POLLUTED_FIELD]: SUBSTITUTED_VALUE },
              {
                getOwnPropertyDescriptor(target, key) {
                  return key === POLLUTED_FIELD
                    ? Object.getOwnPropertyDescriptor(honest, key)
                    : Object.getOwnPropertyDescriptor(target, key);
                },
              },
            ),
            writable: true,
            enumerable: true,
            configurable: true,
          });
        },
      });
    },
    { wrapper: { [POLLUTED_FIELD]: DECLARED_VALUE } },
    'wrapper',
  );

  assert.equal(
    loaded.wrapper[POLLUTED_FIELD],
    SUBSTITUTED_VALUE,
    'the limit still holds: the descriptor matched, so nothing was repaired. If this is now the declared value the limit has closed — update the comment and this row',
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

  // The shape the limit names, presented rather than described: the bytes
  // declare `{"lc":2,"type":"undefined"}` — an OBJECT — and the reviver turns
  // it into `undefined`, a primitive. An earlier version of this row
  // substituted the primitive in the BYTES, which made both sides the same
  // primitive and the walk never reached the shape at all; `prose-reviewer` and
  // `code-reviewer` both measured that it stayed green when the limit was
  // closed. This one arms the gadget on the declared key instead.
  const FIELD = 'stopKind';
  const loaded = await loadUnder(
    (field) => {
      Object.defineProperty(Object.prototype, field, {
        configurable: true,
        get() {
          return undefined;
        },
        set() {
          Object.defineProperty(this, field, {
            value: 'budget-exhausted',
            writable: true,
            enumerable: true,
            configurable: true,
          });
        },
      });
    },
    { [FIELD]: undefined },
    FIELD,
  );

  const [, bytes] = await serde.dumpsTyped({ [FIELD]: undefined });
  assert.match(
    new TextDecoder().decode(bytes),
    /"lc":2,"type":"undefined"/,
    'the fixture must serialize as the undefined RECORD, or the declared side is not an object and this row proves nothing',
  );

  assert.equal(
    loaded[FIELD],
    'budget-exhausted',
    'the limit still holds: a declared object whose load left a primitive is skipped, so the substitution survives. If this is now undefined the limit has closed — update the comment and this row',
  );
});

test('states its limit: a non-configurable own data property under a declared key throws a raw TypeError', async () => {
  assert.match(
    readFileSync(
      new URL('../packages/persistence/src/own-value-serde.ts', import.meta.url),
      'utf8',
    ),
    /NON-CONFIGURABLE own data property under a declared key/,
    'the guard must state this limit in the file, per .claude/rules/invariants.md',
  );

  // The limit stated, presented rather than described. `restoreSlot` writes the
  // declared value back with `Object.defineProperty`, which refuses a
  // non-configurable slot — so the load fails CLOSED, which is the half of this
  // that matters, but with the platform's error rather than this module's own
  // refusal type. Pinned as it behaves today: if the module grows a refusal for
  // this shape, this row is where the change surfaces.
  await assert.rejects(
    () =>
      loadUnder(armNonConfigurableWritingGadget, {
        [POLLUTED_FIELD]: DECLARED_VALUE,
      }),
    (error) => {
      assert.ok(
        error instanceof TypeError,
        `the limit still holds: the throw is the platform's TypeError, not: ${error}`,
      );
      assert.equal(
        error instanceof DeserializationBudgetError,
        false,
        "the limit still holds: it is not this module's refusal type. If it now is, the limit has closed — update the comment and this row",
      );
      assert.match(
        error.message,
        /Cannot redefine property/,
        'the throw must be the redefinition refusal, not some other TypeError on the way there',
      );
      return true;
    },
    'a non-configurable own data property under a declared key must still make the load throw rather than hand the value back',
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

  // The same leaf shape, one level down under a declared CONTAINER the walk
  // does read. The refusal a container's non-data slot earns must not reach
  // this far in: a leaf control field is the graph's to refuse, and turning it
  // into a serde-level throw takes the four refusal rows
  // `docs/decisions/control-ownership-boundary.md` enumerates with it. Reaching
  // this assertion at all is half of what it measures — a load that threw would
  // fail here instead.
  const nested = await loadUnder(armAccessorWritingGadget, {
    control: { [POLLUTED_FIELD]: DECLARED_VALUE },
  });
  const nestedDescriptor = ownDescriptor(nested.control, POLLUTED_FIELD);
  assert.notEqual(
    nestedDescriptor,
    undefined,
    'the gadget must leave an own property one level down, or this half is not measuring that shape',
  );
  assert.equal(
    Object.hasOwn(nestedDescriptor, 'value'),
    false,
    'a leaf accessor inside a walked container must stay an accessor, and must not be escalated into a load-time throw',
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
