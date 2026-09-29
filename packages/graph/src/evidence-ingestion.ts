import {
  EvidenceProvenanceSchema,
  EvidenceSchema,
  quoteModelText,
  TrialRefusalSchema,
  type Evidence,
  type TrialRefusal,
} from '@aic/domain';

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
 * `provenance` key — that is refused outright, naming the item's id quoted
 * and truncated by `quoteModelText` (never the raw id, and never the content
 * of the offending value), and `provenanceSource` is
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
  refuseOwnProvenance(item, typeof item.id === 'string' ? item.id : '<unknown>');

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

  // This post-parse check is what catches a `provenance` smuggled past the
  // FIRST guard above by a Proxy whose `getOwnPropertyDescriptor` trap lies
  // to `Object.hasOwn` on the first ask and tells the truth to `Object.keys`
  // (used by the `for (const key of Object.keys(item))` copy above) on every
  // ask after — see investigation-execution.test.mjs › "on an ok result: a
  // Proxy evidence item that hides its own provenance from Object.hasOwn but
  // reveals it to Object.keys is refused, and nothing is recorded (AIC-146 b2
  // security advisory 1)".
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
 * Refuses an item carrying its own `provenance` key — `Object.hasOwn` sees an
 * own key regardless of enumerability, unlike a `{...item}` spread, which
 * copies only OWN ENUMERABLE properties and would otherwise let a
 * non-enumerable own `provenance` vanish silently in the copy. Callers that
 * build a copy of a candidate evidence item (`./index.ts`'s `recordsOf`) must
 * therefore run this check on the ORIGINAL object, before ever spreading it —
 * see durable-tool-replay.test.mjs › "evidence carrying its own NON-enumerable
 * provenance is refused through the durable site just like an enumerable one,
 * and nothing is committed". Exported so both ingestion sites share exactly
 * one implementation of the check (`.claude/rules/invariants.md`, "one
 * mechanism, one implementation").
 *
 * The offending evidence id is named quoted and truncated (`quoteModelText`),
 * never echoed raw: an unbounded or control-character-laden id could
 * otherwise make the thrown message itself unbounded, or let a hostile id
 * inject terminal-control sequences into it — see
 * investigation-execution.test.mjs › "on an ok result: a hostile
 * 100,000-character evidence id (CR, CSI erase, BEL) carrying its own
 * provenance is refused with a short, escaped message (AIC-146 b2 round-1
 * security fix)".
 */
export function refuseOwnProvenance(item: object, evidenceId: string): void {
  if (Object.hasOwn(item, 'provenance')) {
    throw new Error(
      `evidence ${quoteModelText(evidenceId)} carries its own provenance; provenance travels alongside the outcome that produced it, never inside the item itself`,
    );
  }
}

/**
 * Reads `source[key]` only when it is an own DATA property (never an
 * accessor's getter, and never a value inherited through the prototype
 * chain), and parses it with the given schema when present. The parse
 * failure message is deliberately content-free: it never echoes the
 * malformed value, which may carry a real (if invalid) binding id or
 * fingerprint.
 *
 * An own key set explicitly to `undefined` is refused rather than treated as
 * absent: the key being PRESENT at all is itself a caller mistake worth
 * naming, distinct from the key never having been set — see
 * durable-tool-replay.test.mjs › "an ExecuteInvestigationResult with an
 * explicit own provenance: undefined is refused with a message naming
 * provenance, before anything is committed".
 *
 * Shared by `readOwnProvenance` (the `provenance` field `ingestEvidence`
 * reads off an outcome/result) and `readOwnTrialRefusal` (the `refusal`
 * field `createExecuteInvestigation` reads off an outcome, AIC-146 b4) — one
 * mechanism, not two copies of the same own-property discipline
 * (`.claude/rules/invariants.md`, "one mechanism, one implementation").
 */
function readOwnValidatedProperty<T>(
  source: object,
  key: string,
  schema: { safeParse(value: unknown): { success: true; data: T } | { success: false } },
  fieldLabel: string,
): T | undefined {
  const descriptor = Object.getOwnPropertyDescriptor(source, key);
  if (descriptor === undefined) {
    return undefined;
  }
  if (!Object.hasOwn(descriptor, 'value')) {
    throw new Error(`${fieldLabel} must be an own data property, not an accessor`);
  }
  if (descriptor.value === undefined) {
    throw new Error(`${fieldLabel} must be omitted, not set to undefined`);
  }
  const result = schema.safeParse(descriptor.value);
  if (!result.success) {
    throw new Error(`${fieldLabel} failed validation`);
  }
  return result.data;
}

function readOwnProvenance(source: object) {
  return readOwnValidatedProperty(source, 'provenance', EvidenceProvenanceSchema, 'evidence provenance');
}

/**
 * Reads `source.refusal` (AIC-146 b4) the same own-data-property way
 * `readOwnProvenance` reads `source.provenance`: an accessor's getter is
 * never invoked, an unknown key or a reason outside the closed six-reason
 * vocabulary is refused before it ever reaches the Trial, and the failure
 * message never echoes the malformed value. Exported so
 * `createExecuteInvestigation` (`./nodes/execute-investigation.ts`) is the
 * only caller, matching how `refuseOwnProvenance` is shared today — see
 * investigation-execution.test.mjs › "on an unavailable result: an accessor
 * "refusal" on the outcome makes the node throw and records nothing, and its
 * getter is never called (AIC-146 b4)", › "on an unavailable result: a
 * refusal carrying an unknown key makes the node throw and records nothing
 * (AIC-146 b4)", › "on an unavailable result: a refusal whose reason is
 * outside the six frozen reasons makes the node throw and records nothing
 * (AIC-146 b4)" and › "on an unavailable result: a refusal whose
 * sourceBindingId is neither a UUID nor null makes the node throw and
 * records nothing (AIC-146 b4)".
 */
export function readOwnTrialRefusal(source: object): TrialRefusal | undefined {
  return readOwnValidatedProperty(source, 'refusal', TrialRefusalSchema, 'trial refusal');
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
