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

/**
 * Thrown when the serialized form declares a CONTAINER and the loaded side
 * offers nothing the walk can verify it against.
 *
 * Separate from `DeserializationBudgetError` because the cause is different: a
 * budget refusal means the payload was too large to finish checking, this one
 * means the payload was checkable and the loaded counterpart was not there.
 * Both fail closed, and neither is the raw `TypeError` that limit 1's repair
 * can raise.
 */
export class UnverifiableContainerError extends Error {}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value) as object | null;
  return prototype === Object.prototype || prototype === null;
}

/**
 * Is this declared node a record the reviver turns into something else?
 *
 * `lc: 1` is a LangChain `Serializable`, `lc: 2` a constructor record (`Set`,
 * `Map`, `RegExp`, `Error`, `Uint8Array`, `undefined`, `DeltaSnapshot`). Either
 * way the loaded side is not the record — it is whatever was built from it — so
 * the record's keys say nothing about that value's own properties, and two of
 * them collide.
 *
 * Read as an OWN property. The declared tree comes from `JSON.parse` and is
 * own-only, but its prototype is still `Object.prototype`, so a `[[Get]]` here
 * would let a gadget supply `lc` for every node and steer this decision — which
 * is the class of mistake this module exists to close.
 *
 * 🔴 This is the whole guard, and it was measured surviving its own removal.
 * At the AIC-93 gate `code-reviewer` replaced these two lines with
 * `const lc = value.lc;` and the ENTIRE suite stayed green, while
 * `Object.prototype.lc = 1` — inert to the dependency's reviver, which also
 * requires `type === "constructor"` and an array `id` — then made every
 * declared node answer "revived", stopping the walk before it repaired
 * anything and reopening the bypass in full. The row below exists so that
 * mutation can never be silent again.
 * see checkpoint-serde-own-values.test.mjs › "reads the lc marker as an own
 * property, so an inherited lc cannot make every declared node look like a
 * revived record"
 */
function isRevivedRecord(value: Record<string, unknown>): boolean {
  if (!Object.hasOwn(value, 'lc')) return false;
  const lc = Object.getOwnPropertyDescriptor(value, 'lc')?.value;
  return lc === 1 || lc === 2;
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
 * 🔴 THE ONE CONDITION — and it answers differently for a LEAF and a CONTAINER.
 *
 * A LEAF slot is repaired only when the reviver left it as an OWN DATA PROPERTY
 * whose value diverged from the serialized form. Absent stays absent and an own
 * accessor stays an accessor, because those two are the shapes the graph's own
 * refusal sites in `packages/graph` fire on — `assertOwnControlFields`,
 * `assertRestoredControlFieldsPresent` and `pickGraphOwnedControl` — and an
 * unconditional "make every loaded value match the bytes on disk" repairs them
 * too, so those sites stop firing and a caller who armed a read accessor gets a
 * silent success where they used to get a refusal. Measured: the wide version
 * turns FOUR refusal rows red — the four
 * `docs/decisions/control-ownership-boundary.md` enumerates, which is where the
 * count lives so there is one copy of it — and that record forbids the outcome.
 * see checkpoint-serde-own-values.test.mjs › "leaves a swallowed write for the
 * graph to refuse rather than repairing it"
 * see hitl-resume-contract.test.mjs › "refuses a resume whose restored control
 * field is supplied by an accessor on the prototype"
 *
 * A CONTAINER slot in the same shape is REFUSED instead, and the difference is
 * not a preference. The justification above is that the graph refuses what this
 * module leaves — and that is true only where the graph looks, which is the
 * leaf control fields. At a container key it looks nowhere: `channel_values` is
 * the reachable parent in a real checkpoint and is not a LangGraph channel
 * name, so leaving an unverifiable container hands back a whole subtree neither
 * side ever checked. Measured before this branch closed it: an own getter
 * planted at `control` under such a parent carried `humanReview:false` and
 * `stopKind:'budget-exhausted'` through a real `confirm` resume, parse-clean,
 * with the run completing. The refusal is in `restoreSlot` below.
 * see checkpoint-serde-own-values.test.mjs › "refuses the load when the slot
 * under a declared container key is not an own data property, and names that
 * key" — and, for the end-to-end half this paragraph actually claims,
 * see hitl-resume-contract.test.mjs › "refuses a resume when a container key hides the control behind an own accessor, and leaves the checkpoint the run's own values"
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
    // 🔴 A declared CONTAINER whose loaded slot is not an own data property is
    // refused, where a declared LEAF in the same shape is left alone.
    //
    // The asymmetry is the whole point. For a leaf, `absent` and `own accessor`
    // are the shapes the graph's own refusal sites fire on, so leaving them is
    // what keeps those refusals reachable. At a container key there is no graph
    // refusal site at all — `channel_values` is the reachable parent in a real
    // checkpoint — so the same "leave it" would hand back an entire subtree
    // nobody verified, which is exactly the substitution this module exists to
    // stop.
    // see checkpoint-serde-own-values.test.mjs › "refuses the load when the
    // slot under a declared container key is not an own data property, and
    // names that key" and › "repairs a declared container whose loaded slot the
    // gadget planted as an own data property"
    //
    // ⚠ `__proto__` is the one key exempt from that refusal, and the exemption
    // is about the LANGUAGE, not about trust. `JSON.parse` gives the declared
    // tree an own `__proto__` data property; the reviver's assignment of the
    // same key RE-PARENTS the target instead of defining one, so the loaded
    // side legitimately has no own slot there. Refusing on it would fail every
    // checkpoint whose bytes carry the key, and it buys nothing: assignment put
    // the value on the prototype rather than into an own property, which is the
    // shape the graph's ownership sites already refuse. The siblings around it
    // are still repaired, which is what the row below pins.
    // see checkpoint-serde-own-values.test.mjs › "repairs the siblings of a
    // __proto__ key, which the reviver re-parents on assignment"
    if (!slot.present) {
      if (key === '__proto__') return;
      throw new UnverifiableContainerError(
        `checkpoint key ${JSON.stringify(key)} declares a container and the loaded slot is not an own data property: refusing to deserialize it rather than handing back a subtree whose own values were never verified`,
      );
    }
    // A declared ARRAY answered by a non-array is the one shape mismatch that
    // silently skipped the whole subtree: `restoreDeclared`'s array branch
    // needs both sides to be arrays, and an array `declared` then falls through
    // `isPlainObject(declared)` and returns. Refused here, where the key is
    // still in scope to name.
    // ⚠ Only the DECLARED side's array-ness is a gate. When the declaration is
    // a plain object the loaded counterpart may still be an Array or a
    // function — those belong to the attacker and are walked, not rejected.
    // see checkpoint-serde-own-values.test.mjs › "refuses the load when a
    // declared array is answered by a non-array counterpart, and names that
    // key", › "repairs a declared array element-wise when the loaded
    // counterpart is a genuine array" and › "keeps the own value when the
    // gadget hands back an Array as the container"
    if (Array.isArray(declaredValue) && !Array.isArray(slot.value)) {
      throw new UnverifiableContainerError(
        `checkpoint key ${JSON.stringify(key)} declares an array and the loaded counterpart is not one: refusing to deserialize it rather than skipping the subtree it declares`,
      );
    }
    restoreDeclared(slot.value, declaredValue, budget, depth + 1);
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
  // 🔴 The DECLARED side decides whether to walk, and the loaded side is
  // rejected only for being unwalkable — never for its prototype.
  //
  // This asymmetry is the whole guard. The first version asked
  // `isPlainObject(loaded)`, which reads the loaded object's prototype — and
  // the prototype is the ATTACKER'S to choose, because the gadget owns the
  // setter body that the reviver's assignment invokes. One added line,
  // `Object.setPrototypeOf(this, Object.create(Object.prototype))`, made that
  // question answer no, the walk returned without repairing a single slot, and
  // the whole bypass was back, at no extra cost. A `__proto__` key in the bytes
  // re-parented the object the same way with no gadget armed at all.
  //
  // The serialized form is the one copy the gadget could not touch, so it is
  // the only safe thing to decide from. What this gives up is nothing: every
  // write below goes through `restoreSlot`, which touches a key ONLY where the
  // loaded side already has it as an own DATA property whose value diverged —
  // so a revived Set, Map, RegExp, Error, Uint8Array or `lc:1` instance, whose
  // own keys are none of the ones a constructor record declares, is walked past
  // and left exactly as the reviver built it.
  // see checkpoint-serde-own-values.test.mjs › "keeps the own value when the
  // gadget re-parents the target to escape the walk", › "repairs the siblings
  // of a __proto__ key, which the reviver re-parents on assignment", and ›
  // "revives Set, Map, Uint8Array, RegExp, Error and DeltaSnapshot unchanged"
  if (!isPlainObject(declared)) return;

  // A record the reviver CONSUMES — `lc: 1` (a LangChain `Serializable`) or
  // `lc: 2` (a constructor record) — built something on the loaded side whose
  // own keys are its own business, and two of them collide with the record's:
  // a revived message carries an own `type` of `"human"` where the record
  // declares `"constructor"`. Walking in overwrote it and broke `instanceof`.
  // Decided from the declared side's OWN properties, never through `[[Get]]`,
  // because reading a decision off the prototype chain is the exact mistake
  // this guard exists to undo.
  // see checkpoint-serde-own-values.test.mjs › "hands a revived LangChain lc:1
  // instance back exactly as the reviver built it" and › "revives Set, Map,
  // Uint8Array, RegExp, Error and DeltaSnapshot unchanged"
  if (isRevivedRecord(declared)) return;

  // 🔴 The loaded side is rejected ONLY for being genuinely unwalkable.
  //
  // Three properties of it were tried as the gate and all three turned out to
  // belong to the attacker: its prototype, its array-ness, and its `typeof`.
  // A setter on a parent key hands back an Array — or a function — carrying the
  // same data, and every earlier version skipped the whole subtree under it.
  // `channel_values` is the reachable parent in a real checkpoint, and unlike
  // `control` it is not a LangGraph channel name, so nothing else stops it.
  //
  // What is left is the one property the gadget cannot choose away: a primitive
  // cannot carry a property, so there is nothing to repair on it. Everything
  // else is walked, and `restoreSlot` decides each key.
  // see checkpoint-serde-own-values.test.mjs › "keeps the own value when the
  // gadget hands back an Array as the container"
  if (loaded === null) return;
  if (typeof loaded !== 'object' && typeof loaded !== 'function') return;

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
 * On a LEAF the run is made IMMUNE rather than refused: no new refusal reaches
 * an operator on that shape, and nothing on disk records the attempt. On a
 * CONTAINER the answer is the opposite — limit 9 below refuses, because there
 * the alternative is not immunity but an unchecked subtree. That trade, and why
 * the leaf half was reversed from AIC-92's answer, is in
 * `docs/decisions/control-ownership-boundary.md`.
 *
 * ## Limits — each one measured, each one pinned
 *
 * ⚠ This list is the limits that were FOUND, not a proof that no others exist.
 * An earlier draft headed it "none of them argued", which read as exhaustive;
 * the AIC-93 gate then measured two more (6 and 7 below) and a third that was
 * a live bypass rather than a limit. Read it as what two cold readers could
 * break, not as a boundary.
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
 *    ⚠ `DESERIALIZATION_MAX_NODES` counts CONTAINERS entered, not keys visited,
 *    so one object with a million primitive keys is one node and a million
 *    iterations. The work stays linear in a payload `JSON.parse` has already
 *    walked, so it is not an amplification — but the bound does not bound the
 *    loop, and the wording used to imply it did.
 *
 * 3. **A polluted key on an object stored inside a revived non-plain value is
 *    NOT repaired** — a `Map` or `Set` member, and equally an `Error`, a
 *    `RegExp` or a LangChain `lc: 1` instance. The walk stops at the revived
 *    value: its members are not reachable as own properties under the keys the
 *    serialized record declares, and rebuilding a collection to reach them
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
 * 6. **An own key the loaded value has and the serialized form does NOT declare
 *    is never examined.** The walk iterates `Object.keys(declared)`, so a
 *    gadget that answers one field's write by ALSO defining a second, undeclared
 *    field leaves that second field standing. It is not repaired because there
 *    is nothing declared to repair it to, and deleting an undeclared key would
 *    be this module inventing a refusal.
 *    🔴 Do NOT read the graph as the place that refuses it instead — an earlier
 *    wording said so and `security-scanner` measured otherwise at the AIC-93
 *    gate. `stopKind` is an OPTIONAL graph-owned field, so honest bytes that
 *    omit it plus an own-writing gadget at `control` leave
 *    `stopKind: 'budget-exhausted'` standing as a genuine own data property,
 *    and `pickGraphOwnedControl` reads it straight out of that descriptor.
 *    Nothing refuses it today. `humanReview` is declared and therefore repaired,
 *    so the human-review gate is not reachable this way.
 *    Found by `code-reviewer` and re-measured by `security-scanner`, both at the
 *    AIC-93 gate.
 *    see checkpoint-serde-own-values.test.mjs › "states its limit: an own key
 *    the serialized form does not declare is never examined"
 *
 * 7. **A slot the serialized form declares as a PLAIN OBJECT, and the load left
 *    as a primitive, is skipped.** `restoreSlot` recurses on an object-valued
 *    declaration and never falls through to the comparison, so the shapes
 *    disagreeing ends the walk for that slot rather than repairing it.
 *    ⚠ Read "plain object" strictly: an array is an object too, and a declared
 *    ARRAY answered by a primitive is REFUSED, not skipped — that half belongs
 *    to limit 9. This entry said "an object" until `prose-reviewer` measured the
 *    two halves apart at the AIC-93 gate. This
 *    includes the `{"lc":2,"type":"undefined"}` record, which means a gadget
 *    substituting a value for a serialized `undefined` survives.
 *    ⚠ Unreachable for control today only because the graph drops an undefined
 *    `stopKind` before persisting; a second optional graph-owned field would
 *    make it live. Found by `code-reviewer` at the AIC-93 gate.
 *    see checkpoint-serde-own-values.test.mjs › "states its limit: a declared
 *    object whose loaded slot is a primitive is left alone"
 *
 * 8. **A `Proxy` that lies through `getOwnPropertyDescriptor` defeats the
 *    comparison.** `readOwnDataValue` asks for the descriptor; a proxy can
 *    report the honest declared value there while `[[Get]]` returns the
 *    attacker's, so nothing looks diverged and nothing is repaired.
 *    ⚠ `packages/graph/src/investigation.ts` puts a lying `Proxy` outside its
 *    threat model on the ground that a caller able to build one can supply the
 *    value directly. That reason does NOT cover this route, where the proxy is
 *    built by a pollution gadget inside a setter rather than by a caller — so
 *    it is recorded here as a limit of this module rather than inherited as
 *    covered. Found by `security-scanner` at the AIC-93 gate; identical before
 *    this module existed, so it is a limit rather than a regression.
 *    see checkpoint-serde-own-values.test.mjs › "states its limit: a Proxy that
 *    lies through getOwnPropertyDescriptor is not repaired"
 *
 * 9. **A declared container the walk cannot verify is REFUSED, not skipped.**
 *    When the loaded slot under a declared container key is not an own data
 *    property, or a declared ARRAY is answered by a non-array counterpart, the
 *    load throws `UnverifiableContainerError` naming the key. It is the only
 *    place where a repair was available and refusal was chosen instead — NOT
 *    the module's only throw site, which limit 2's bounds also are, and those
 *    raise `DeserializationBudgetError`. Limit 1 explains why the leaf and the
 *    container answer differently.
 *    ⚠ `__proto__` is exempt: the reviver's assignment of that key re-parents
 *    the target instead of defining an own slot, so its absence is the
 *    language's doing rather than a substitution, and refusing on it would fail
 *    every checkpoint whose bytes carry the key. What the exemption routes into
 *    a prototype is refused by the graph's ownership sites — but only at a LEAF,
 *    and above `control` there is no graph site at all. It is safe there for a
 *    different reason, which is worth stating rather than assuming: a channel
 *    cannot BE named `__proto__`, because the channel names come from
 *    `IncidentStateSchema`, a `z.strictObject`. Measured by `security-scanner`
 *    at the AIC-93 gate over six `__proto__` shapes, none of which produced an
 *    own attacker value.
 *    see checkpoint-serde-own-values.test.mjs › "refuses the load when the slot
 *    under a declared container key is not an own data property, and names that
 *    key", › "refuses the load when a declared array is answered by a non-array
 *    counterpart, and names that key" and › "repairs the siblings of a
 *    __proto__ key, which the reviver re-parents on assignment"
 *
 * 10. **A declared `lc:1` / `lc:2` record is walked past without checking that
 *     the loaded side is what the record says the reviver built.**
 *     `isRevivedRecord(declared)` returns before anything looks at the
 *     counterpart, so an own-writing gadget at such a key hands back its own
 *     object verbatim. This is the SAME family limit 9 closes — the declared
 *     side describes a value nobody verified the loaded side against — and it
 *     is left open rather than closed because closing it means deciding, per
 *     constructor record, what "is what it says" means, and getting that wrong
 *     re-breaks the `instanceof` regression rounds 1 and 2 already paid for.
 *     ⚠ Not reached by anything this repository writes TODAY, and the reason is
 *     a property of the state schema rather than of this module: no channel in
 *     `IncidentStateSchema` DECLARES a `Set`, a `Map` or a LangChain `lc:1`
 *     value, so nothing in-repo writes an `lc` record into a checkpoint.
 *     🔴 That is weaker than "unreachable", and the difference matters: the
 *     schema declares three `z.unknown()` slots — `predictions[].expectedIfTrue[]`,
 *     `tests[].input` and `trials[].input` — and a caller who stores a `Set` in
 *     one of them makes this live with **no schema change at all**. An earlier
 *     draft of this entry said a new channel would be needed; `test-writer`
 *     measured otherwise at the AIC-93 gate.
 *     Found by `security-scanner` at the AIC-93 gate, round 5.
 *
 * ⚠ The repair in limit 1 has a raw-`TypeError` edge. A loaded value carrying a
 * NON-CONFIGURABLE own data property under a declared key makes
 * `Object.defineProperty` throw. That is fail-closed at this module's boundary
 * — `loadsTyped` throws rather than returning an unverified value — but the
 * error is a raw `TypeError`, not one of this module's own refusal types.
 * see checkpoint-serde-own-values.test.mjs › "states its limit: a
 * non-configurable own data property under a declared key throws a raw
 * TypeError"
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
