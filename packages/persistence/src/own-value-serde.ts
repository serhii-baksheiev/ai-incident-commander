import type { SqliteSaver } from '@langchain/langgraph-checkpoint-sqlite';

/**
 * `SerializerProtocol`, reached through the saver that already declares it.
 * Naming it this way keeps `@langchain/langgraph-checkpoint` out of this
 * package's manifest: the type is the one the checkpointer's own `.serde` field
 * carries, so it cannot drift from what the assignment below has to satisfy.
 */
type Serde = SqliteSaver['serde'];

export const DESERIALIZATION_MAX_DEPTH = 64;
export const DESERIALIZATION_MAX_NODES = 100_000;

/** Thrown instead of returning a value the walk could not finish verifying. */
export class DeserializationBudgetError extends Error {}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value) as object | null;
  return prototype === Object.prototype || prototype === null;
}

/** The wire shape `JsonPlusSerializer` writes for a `DeltaSnapshot`. */
function isDeltaSnapshotRecord(value: unknown): value is { value: unknown } {
  return (
    isPlainObject(value) &&
    value.lc === 2 &&
    value.type === 'delta_snapshot' &&
    Object.hasOwn(value, 'value')
  );
}

/**
 * The revived counterpart, matched on `lg_name` — the marker the dependency
 * itself uses for structural detection across module boundaries — rather than
 * on `instanceof`, which would need the class imported.
 */
function carriesSnapshotValue(value: unknown): value is { value: unknown } {
  return (
    typeof value === 'object' &&
    value !== null &&
    (value as { lg_name?: unknown }).lg_name === 'DeltaSnapshot' &&
    Object.hasOwn(value, 'value')
  );
}

interface Budget {
  nodes: number;
}

/**
 * The slot as it really is, never as a `[[Get]]` would report it: absent, or a
 * data property carrying a value. An own ACCESSOR answers `present: false`,
 * which is what keeps the walk from repairing it.
 */
function readOwnDataValue(
  source: object,
  key: string,
): { present: boolean; value?: unknown } {
  const descriptor = Object.getOwnPropertyDescriptor(source, key);
  if (descriptor === undefined || !Object.hasOwn(descriptor, 'value')) {
    return { present: false };
  }
  return { present: true, value: descriptor.value };
}

/**
 * 🔴 THE ONE CONDITION, and it is narrow on purpose.
 *
 * A slot is repaired only when the reviver left it as an OWN DATA PROPERTY
 * whose value diverged from the serialized form. Absent stays absent and an own
 * accessor stays an accessor, because those two are the shapes the graph's own
 * refusal sites in `packages/graph` fire on — `assertOwnControlFields`,
 * `assertRestoredControlFieldsPresent` and `pickGraphOwnedControl` — and an
 * unconditional "make every loaded value match the bytes on disk" repairs them
 * too, so those sites stop firing and a caller who armed a read accessor gets a
 * silent success where they used to get a refusal. Measured: the wide version
 * turns five refusal rows red, and
 * `docs/decisions/control-ownership-boundary.md` forbids that outcome.
 * see checkpoint-serde-own-values.test.mjs › "leaves a swallowed write for the
 * graph to refuse rather than repairing it"
 * see hitl-resume-contract.test.mjs › "refuses a resume whose restored control
 * field is supplied by an accessor on the prototype"
 */
function restoreSlot(
  loaded: object,
  key: string,
  declaredValue: unknown,
  budget: Budget,
  depth: number,
): void {
  if (typeof declaredValue === 'object' && declaredValue !== null) {
    const slot = readOwnDataValue(loaded, key);
    if (slot.present) restoreDeclared(slot.value, declaredValue, budget, depth + 1);
    return;
  }
  const slot = readOwnDataValue(loaded, key);
  if (!slot.present || Object.is(slot.value, declaredValue)) return;
  Object.defineProperty(loaded, key, {
    value: declaredValue,
    writable: true,
    enumerable: true,
    configurable: true,
  });
}

/**
 * One forward walk of the serialized form, repairing the loaded object beside
 * it.
 *
 * The recursion is over ATTACKER-SUPPLIED input, so it carries an explicit
 * total budget rather than trusting the stack: `DESERIALIZATION_MAX_DEPTH`
 * levels and `DESERIALIZATION_MAX_NODES` nodes, both counted across the whole
 * load. Crossing either FAILS CLOSED — the load throws rather than handing back
 * a value whose own properties were never verified, and the message names the
 * limit.
 * see checkpoint-serde-own-values.test.mjs › "refuses a checkpoint value nested
 * deeper than DESERIALIZATION_MAX_DEPTH"
 * see checkpoint-serde-own-values.test.mjs › "refuses a checkpoint value
 * carrying more than DESERIALIZATION_MAX_NODES nodes"
 * see checkpoint-serde-own-values.test.mjs › "accepts a value just inside both
 * bounds"
 */
function restoreDeclared(
  loaded: unknown,
  declared: unknown,
  budget: Budget,
  depth: number,
): void {
  if (depth > DESERIALIZATION_MAX_DEPTH) {
    throw new DeserializationBudgetError(
      `checkpoint value nests deeper than ${DESERIALIZATION_MAX_DEPTH} levels: refusing to deserialize it rather than leaving its own values unverified`,
    );
  }
  budget.nodes += 1;
  if (budget.nodes > DESERIALIZATION_MAX_NODES) {
    throw new DeserializationBudgetError(
      `checkpoint value carries more than ${DESERIALIZATION_MAX_NODES} nodes: refusing to deserialize it rather than leaving its own values unverified`,
    );
  }
  if (isDeltaSnapshotRecord(declared) && carriesSnapshotValue(loaded)) {
    restoreSlot(loaded, 'value', declared.value, budget, depth);
    return;
  }
  if (Array.isArray(declared) && Array.isArray(loaded)) {
    const shared = Math.min(declared.length, loaded.length);
    for (let index = 0; index < shared; index += 1) {
      restoreSlot(loaded, String(index), declared[index], budget, depth);
    }
    return;
  }
  if (!isPlainObject(declared) || !isPlainObject(loaded)) return;
  for (const key of Object.keys(declared)) {
    restoreSlot(loaded, key, declared[key], budget, depth);
  }
}

/**
 * Wraps a checkpointer's serde so a loaded value keeps the own values its
 * serialized form declares.
 *
 * ## What it is for
 *
 * `JsonPlusSerializer._reviver` builds `const revivedObj = {}` and then does
 * `revivedObj[k] = await _reviver(v)` — a `[[Set]]`. An inherited setter on
 * `Object.prototype` takes that assignment, and one that answers it by
 * `Object.defineProperty(this, k, { value: <attacker's> })` leaves a GENUINE
 * own data property carrying the attacker's value. No ownership check anywhere
 * distinguishes that from an honest run, because there is nothing left to
 * detect. `JSON.parse` uses define semantics and never invokes the setter, so
 * the serialized form is the one copy the gadget could not touch — this wrapper
 * compares the two and puts the declared value back.
 * see checkpoint-serde-own-values.test.mjs › "keeps the own value the
 * serialized form declares when an inherited setter writes another"
 *
 * The run is made IMMUNE, not refused: no new refusal reaches an operator on
 * this shape, and nothing on disk records the attempt. That trade, and why it
 * was reversed from AIC-92's answer, is in
 * `docs/decisions/control-ownership-boundary.md`.
 *
 * ## Limits — each one measured, none of them argued
 *
 * 1. **Only a diverged own data property is repaired.** The condition is on
 *    `restoreSlot` above, with the reason: repairing the absent and accessor
 *    shapes silences the graph's refusal sites.
 *    see checkpoint-serde-own-values.test.mjs › "leaves a swallowed write for
 *    the graph to refuse rather than repairing it"
 *
 * 2. **The walk is bounded and fails closed** at `DESERIALIZATION_MAX_DEPTH`
 *    levels and `DESERIALIZATION_MAX_NODES` nodes; both bounds are stated on
 *    `restoreDeclared` above with the rows that pin each direction.
 *
 * 3. **A polluted key on an object stored
 *    inside a `Map` or `Set` is NOT repaired.** The walk stops at the revived
 *    collection: its members are not
 *    reachable as own properties, and rebuilding the collection to reach them
 *    would risk reordering it or collapsing keys the checkpoint distinguished —
 *    a worse failure than the one being repaired. Nothing in
 *    `IncidentStateControlSchema` is stored that way today.
 *    see checkpoint-serde-own-values.test.mjs › "states its limit: a polluted
 *    key inside a Map member is not repaired"
 *
 * 4. **A caller who wires their own `BaseCheckpointSaver` into
 *    `createInvestigationGraph` loses this entirely.** The repair travels with
 *    the checkpointer `createSqliteCheckpointer` builds, not with the graph, so
 *    the guarantee depends on which checkpointer was wired up. That is the
 *    standing cost of putting the fix on this side of the boundary.
 *    see checkpoint-serde-own-values.test.mjs › "states its limit: a
 *    checkpointer this module did not build keeps the unrepaired serde"
 *
 * 5. **Only the `json` payload is walked.** A `bytes` payload is handed back
 *    exactly as the inner serde produced it — it is not JSON and parsing it
 *    would throw.
 *    see checkpoint-serde-own-values.test.mjs › "passes a bytes payload through
 *    untouched"
 *
 * The revived non-plain values the reviver builds — `Set`, `Map`, `Uint8Array`,
 * `RegExp`, `Error`, `DeltaSnapshot`, a LangChain `lc: 1` object — are handed
 * on unchanged, and an own key whose serialized value is the `undefined` record
 * keeps its key.
 * see checkpoint-serde-own-values.test.mjs › "revives Set, Map, Uint8Array,
 * RegExp, Error and DeltaSnapshot unchanged"
 * see checkpoint-serde-own-values.test.mjs › "keeps an own key whose serialized
 * value is undefined"
 */
export function withDeclaredOwnValues(inner: Serde): Serde {
  return {
    dumpsTyped(data: unknown) {
      return inner.dumpsTyped(data);
    },
    async loadsTyped(type: string, data: Uint8Array | string) {
      const loaded: unknown = await inner.loadsTyped(type, data);
      if (type !== 'json') return loaded;
      const text = typeof data === 'string' ? data : new TextDecoder().decode(data);
      const declared: unknown = JSON.parse(text);
      restoreDeclared(loaded, declared, { nodes: 0 }, 0);
      return loaded;
    },
  };
}
