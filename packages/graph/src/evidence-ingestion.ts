import { EvidenceProvenanceSchema, EvidenceSchema, type Evidence } from '@aic/domain';

/**
 * The one place `@aic/graph`'s own source calls `EvidenceSchema.parse` — see
 * evidence-ingestion-sites.test.mjs › "within packages/graph/src,
 * EvidenceSchema.parse and EvidenceSchema.safeParse appear only in
 * evidence-ingestion.ts". Both existing ingestion sites go through it:
 * `createExecuteInvestigation` (`./nodes/execute-investigation.ts`) and the
 * durable runner's `recordsOf` (`./index.ts`), so the refusal-on-item-provenance
 * rule and the own-property provenance guard live in exactly one function
 * (`.claude/rules/invariants.md`, "one mechanism, one implementation").
 *
 * Provenance travels ALONGSIDE the items a caller hands in, never inside one:
 * `item` is a candidate evidence item (which must never carry its own
 * `provenance` key — that is refused outright, naming the item's id, and the
 * content of the offending value is never echoed), and `provenanceSource` is
 * the object that may carry a shared `provenance` field for every item built
 * from it in this call (the node's `outcome`, or the durable runner's
 * `ExecuteInvestigationResult`). See investigation-execution.test.mjs ›
 * "on an ok result: an evidence item carrying its own provenance is refused,
 * naming the evidence id, and nothing is recorded (AIC-146 b2)" and
 * durable-tool-replay.test.mjs › "evidence carrying its own provenance is
 * refused, naming the evidence id, and nothing is committed".
 *
 * `provenanceSource.provenance` is read only when it is an OWN, DATA
 * property: `Object.getOwnPropertyDescriptor` is used rather than a plain
 * `.provenance` access, so an accessor never has its getter invoked — see ›
 * "on an ok result: an accessor "provenance" on the outcome is refused, and
 * its getter is never called (AIC-146 b2)". When no own data property is
 * present, the built evidence carries no `provenance` field at all — this is
 * also what keeps a polluted `Object.prototype.provenance` from leaking onto
 * recorded evidence: `provenanceSource` itself is never touched through the
 * prototype chain, and the object handed to `EvidenceSchema.parse` is built
 * with `Object.create(null)` so zod's own optional-field read (which walks
 * the prototype chain like any other property read) can never observe an
 * inherited value either — see › "on an ok result: a polluted
 * Object.prototype.provenance never leaks onto recorded evidence when the
 * outcome carries no own provenance (AIC-146 b2)".
 *
 * After parsing, the result's own `provenance` is checked against exactly
 * what was supplied (or checked to have no own `provenance` at all, when none
 * was supplied) — a second, independent guard against the same prototype-
 * pollution hazard, in case anything upstream of the parse ever changes.
 */
export function ingestEvidence({
  item,
  trialId,
  provenanceSource,
}: Readonly<{
  item: Readonly<Record<string, unknown>>;
  trialId: string;
  provenanceSource: object;
}>): Evidence {
  if (Object.hasOwn(item, 'provenance')) {
    const evidenceId = typeof item.id === 'string' ? item.id : '<unknown>';
    throw new Error(
      `evidence ${evidenceId} carries its own provenance; provenance travels alongside the outcome that produced it, never inside the item itself`,
    );
  }

  const provenance = readOwnProvenance(provenanceSource);

  // Built with a null prototype so a polluted Object.prototype.provenance can
  // never be read back through this object's own prototype chain — by zod's
  // optional-field check or by anything else — when no provenance was
  // supplied for this call.
  const input: Record<string, unknown> = Object.create(null);
  for (const key of Object.keys(item)) {
    input[key] = item[key];
  }
  input.trialId = trialId;
  if (provenance !== undefined) {
    input.provenance = provenance;
  }

  const parsed = EvidenceSchema.parse(input);

  const parsedHasOwnProvenance = Object.hasOwn(parsed, 'provenance');
  if (provenance === undefined) {
    if (parsedHasOwnProvenance) {
      throw new Error('parsed evidence unexpectedly carries a provenance field, but none was supplied');
    }
  } else if (!parsedHasOwnProvenance || !sameProvenance(parsed.provenance, provenance)) {
    throw new Error('parsed evidence provenance does not match the provenance supplied for this call');
  }

  return parsed;
}

/**
 * Reads `source.provenance` only when it is an own DATA property (never an
 * accessor's getter, and never a value inherited through the prototype
 * chain), and parses it with `EvidenceProvenanceSchema` when present. The
 * parse failure message is deliberately content-free: it never echoes the
 * malformed value, which may carry a real (if invalid) binding id or
 * fingerprint.
 */
function readOwnProvenance(source: object) {
  const descriptor = Object.getOwnPropertyDescriptor(source, 'provenance');
  if (descriptor === undefined) {
    return undefined;
  }
  if (!Object.hasOwn(descriptor, 'value')) {
    throw new Error('provenance must be an own data property, not an accessor');
  }
  if (descriptor.value === undefined) {
    return undefined;
  }
  const result = EvidenceProvenanceSchema.safeParse(descriptor.value);
  if (!result.success) {
    throw new Error('evidence provenance failed validation');
  }
  return result.data;
}

/** Own-key, own-value equality over a flat, primitive-valued object — exactly the shape EvidenceProvenanceSchema produces. */
function sameProvenance(a: unknown, b: unknown): boolean {
  if (typeof a !== 'object' || a === null || typeof b !== 'object' || b === null) {
    return a === b;
  }
  const aKeys = Object.keys(a);
  const bKeys = Object.keys(b);
  if (aKeys.length !== bKeys.length) {
    return false;
  }
  return aKeys.every(
    (key) => Object.hasOwn(b, key) && (a as Record<string, unknown>)[key] === (b as Record<string, unknown>)[key],
  );
}
