/**
 * AIC-100, slice a: the compile-time half of the `EvidenceSource` adapter
 * contract — pinned the same way `run-event-stream-source-type-contract.ts`
 * pins `RunEventStreamSource` (AIC-58): a real object literal typed against
 * the interface, checked for structural acceptance, and one row proving the
 * check is not vacuous (an object missing `execute` is refused).
 *
 * Deliberately additive-only (AIC-100 slice a): this file names nothing from
 * `packages/tools/live` or `packages/tools/replay` — `BoundSourceRegistry`
 * (slice b) and migrating the existing live/replay adapters onto this
 * contract (slice d) are separate tickets.
 *
 * A real value, not a `declare`: like its sibling fixtures, `test/fixtures`
 * is swept by node's default test-file discovery, so this file is also
 * EXECUTED with its types stripped — every binding below must be valid plain
 * JavaScript too.
 */
import type {
  EvidenceSource,
  EvidenceSourceCheckResult,
  EvidenceSourceDescriptor,
  EvidenceSourceOutcome,
  EvidenceSourceProvenance,
} from '@aic/tools';

function acceptsEvidenceSource(source: EvidenceSource): void {
  void source;
}

// Annotated, so the literal is checked field by field: a field removed from
// EvidenceSourceProvenance makes it an excess property here, and the
// expect-error row below goes unused if a field stops being required.
const fakeProvenance: EvidenceSourceProvenance = {
  sourceBindingId: 'binding-fixture',
  adapter: 'fixture-adapter@1.0.0',
  credentialRefId: null,
  fetchedAt: '2026-09-24T00:00:00.000Z',
  requestFingerprint: `sha256:${'0'.repeat(64)}`,
};

const fakeOkOutcome: EvidenceSourceOutcome<{ lines: string[] }> = {
  status: 'ok',
  output: { lines: [] },
  provenance: fakeProvenance,
};
void fakeOkOutcome;

const fakeRefusedOutcome: EvidenceSourceOutcome<{ lines: string[] }> = {
  status: 'refused',
  reason: 'timeout',
  provenance: fakeProvenance,
};
void fakeRefusedOutcome;

const fakeReadyCheck: EvidenceSourceCheckResult = { status: 'ready' };
void fakeReadyCheck;

const fakeRefusedCheck: EvidenceSourceCheckResult = {
  status: 'refused',
  reason: 'denied',
};
void fakeRefusedCheck;

const fakeDescriptor: EvidenceSourceDescriptor = {
  adapterId: 'fixture-adapter',
  version: '1.0.0',
  operations: ['fetch-logs'],
};

// @ts-expect-error provenance requires requestFingerprint
const provenanceMissingFingerprint: EvidenceSourceProvenance = {
  sourceBindingId: 'binding-fixture',
  adapter: 'fixture-adapter@1.0.0',
  credentialRefId: null,
  fetchedAt: '2026-09-24T00:00:00.000Z',
};
void provenanceMissingFingerprint;

// @ts-expect-error the descriptor requires version
const descriptorMissingVersion: EvidenceSourceDescriptor = { adapterId: 'fixture-adapter', operations: [] };
void descriptorMissingVersion;

const fakeSource: EvidenceSource = {
  describe: () => fakeDescriptor,
  check: async () => fakeReadyCheck,
  execute: async (_operation, _input) => fakeOkOutcome,
};

acceptsEvidenceSource(fakeSource);

/**
 * AIC-100 slice c, two additive pins:
 *
 *   - `budget_exceeded` joins the refusal reasons `EvidenceSourceOutcome` and
 *     `EvidenceSourceCheckResult` accept.
 *   - `execute(operation, input)` gains an optional THIRD argument (the
 *     registry's page-budget hint) — additive, so `fakeSource` above (a
 *     two-parameter implementation) must keep compiling unchanged, and an
 *     implementation that also accepts a third parameter must compile too.
 */
const fakeBudgetExceededOutcome: EvidenceSourceOutcome<{ lines: string[] }> = {
  status: 'refused',
  reason: 'budget_exceeded',
  provenance: fakeProvenance,
};
void fakeBudgetExceededOutcome;

const fakeBudgetExceededCheck: EvidenceSourceCheckResult = {
  status: 'refused',
  reason: 'budget_exceeded',
};
void fakeBudgetExceededCheck;

const fakeSourceAcceptingBudgetHints: EvidenceSource = {
  describe: () => fakeDescriptor,
  check: async () => fakeReadyCheck,
  execute: async (_operation, _input, _budgetHints) => fakeOkOutcome,
};
acceptsEvidenceSource(fakeSourceAcceptingBudgetHints);

// Not vacuous: an object missing execute is refused, or the check above
// would prove nothing about the shape and everything would pass regardless.
const notASource = { describe: fakeSource.describe, check: fakeSource.check };
// @ts-expect-error EvidenceSource requires an execute method
acceptsEvidenceSource(notASource);

void notASource;
