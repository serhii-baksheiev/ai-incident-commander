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
  EvidenceSourceOutcome,
} from '@aic/tools';

function acceptsEvidenceSource(source: EvidenceSource): void {
  void source;
}

const fakeProvenance = {
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

const fakeSource: EvidenceSource = {
  describe: () => ({
    adapterId: 'fixture-adapter',
    version: '1.0.0',
    operations: ['fetch-logs'],
  }),
  check: async () => fakeReadyCheck,
  execute: async (_operation, _input) => fakeOkOutcome,
};

acceptsEvidenceSource(fakeSource);

// Not vacuous: an object missing execute is refused, or the check above
// would prove nothing about the shape and everything would pass regardless.
const notASource = { describe: fakeSource.describe, check: fakeSource.check };
// @ts-expect-error EvidenceSource requires an execute method
acceptsEvidenceSource(notASource);

void notASource;
