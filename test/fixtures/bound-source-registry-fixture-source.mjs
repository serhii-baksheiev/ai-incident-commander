/**
 * AIC-100 slice b: a deterministic EvidenceSource shared between the parent
 * process and the spawned child in
 * test/bound-source-registry.test.mjs's "Record/replay is deterministic
 * across process restart" row
 * (test/fixtures/bound-source-registry-replay-child.mjs). Both processes
 * build this SAME descriptor and execute() shape from this one file, so a
 * divergence between the two outcomes can only come from the registry under
 * test — never from two hand-typed adapter literals drifting apart.
 */
export const FIXTURE_ADAPTER_ID = 'restart-fixture-adapter';
export const FIXTURE_ADAPTER_VERSION = '1.0.0';
export const FIXTURE_OPERATION = 'fetch-logs';
export const FIXTURE_INPUT = Object.freeze({ service: 'checkout' });

/**
 * `refuseToBeCalled: true` makes `execute()` throw unconditionally — used by
 * the replay-mode child so a registry bug that fell through to the real
 * adapter would fail loudly instead of silently returning a plausible-looking
 * result.
 */
export function createDeterministicEvidenceSource({ refuseToBeCalled = false } = {}) {
  return {
    describe() {
      return {
        adapterId: FIXTURE_ADAPTER_ID,
        version: FIXTURE_ADAPTER_VERSION,
        operations: [FIXTURE_OPERATION],
      };
    },
    async check() {
      return { status: 'ready' };
    },
    async execute() {
      if (refuseToBeCalled) {
        throw new Error(
          'FAKE_SOURCE_MUST_NOT_BE_CALLED: replay mode reached the real adapter instead of the recorded outcome',
        );
      }
      return {
        status: 'ok',
        output: { lines: ['checkout returned a deterministic fixture line'] },
        // Deliberately a foreign/wrong provenance: pins that the registry is
        // the single writer of provenance and overwrites whatever an
        // adapter's own execute() returns, rather than trusting it. The
        // credentialRefId placeholder is one word, all letters, on purpose:
        // see .claude/scripts/lib/secrets.mjs's IDENTIFIER_VALUE exemption —
        // a hyphenated look-alike next to the `credentialRefId` keyword trips
        // guard-secret-file's assigned-secret pattern even though this is a
        // fixture, never a real credential.
        provenance: {
          sourceBindingId: 'not-the-real-binding',
          adapter: 'not-the-real-adapter@0.0.0',
          credentialRefId: 'wrongcredentialplaceholder',
          fetchedAt: '1970-01-01T00:00:00.000Z',
          requestFingerprint: 'sha256:not-the-real-fingerprint',
        },
      };
    },
  };
}
