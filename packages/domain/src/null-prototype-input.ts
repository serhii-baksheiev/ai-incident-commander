/**
 * Copies every own enumerable string key of `fields` onto a fresh object whose prototype is
 * `null`, so a schema's own optional-field read (which walks the prototype
 * chain like any other property read, `obj.key`) can never observe a value
 * inherited from a polluted `Object.prototype`.
 *
 * Three sites build their parse input with it: a candidate evidence item in
 * `@aic/graph`'s `evidence-ingestion.ts`, a trial in
 * `nodes/execute-investigation.ts`, and a row body read back off the database
 * in `@aic/persistence`'s `retention.ts` (`parseRunProductRows`, AIC-146 b4).
 * `@aic/tools`'s `bound-investigation-executor.ts` also parses evidence items,
 * on a plain object, before they reach the graph; the graph's own ingestion
 * then refuses any item that carries its own `provenance`.
 * Each of the three imports this function rather than growing its own copy
 * (`.claude/rules/invariants.md`, "one mechanism, one implementation") —
 * `@aic/persistence` in particular cannot import `@aic/graph` (the dependency
 * runs the other way), which is why this lives in `@aic/domain`, the one
 * package both already depend on. It is not the only null-prototype copy in
 * the repository: `@aic/graph`'s `investigation.ts` builds a deep,
 * depth-capped one (`ownDataCopy`) for a human conclusion-review decision,
 * a different mechanism for a different input.
 *
 * Only own enumerable string keys of `fields` are copied (`Object.keys`):
 * an inherited property is never seen, whatever `Object.prototype` carries,
 * and own non-enumerable and symbol keys are dropped. So a caller safely
 * assembles `fields` with an ordinary object literal, spread, or `JSON.parse`
 * result first, and only a key it actually set ends up present on the result.
 *
 * The copy is shallow: a nested object keeps its own prototype. It protects
 * the TOP-LEVEL optional keys a schema reads (`Trial.refusal`,
 * `Evidence.provenance`, `.reliability`, `.observation`); a nested schema with
 * an optional field would need the same treatment one level down.
 *
 * Pure: no clock, env or I/O — every input is a plain value already on hand.
 */
export function ownFieldsOnNullPrototype(fields: Readonly<Record<string, unknown>>): Record<string, unknown> {
  const input: Record<string, unknown> = Object.create(null);
  for (const key of Object.keys(fields)) {
    input[key] = fields[key];
  }
  return input;
}
