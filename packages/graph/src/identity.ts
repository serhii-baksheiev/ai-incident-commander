import { createHash } from 'node:crypto';

/**
 * The identity formulas shared by the durable investigation runner
 * (`createPersistentInvestigationRunner`, `./index.ts`) and the canonical
 * `execute_investigation` node (`./nodes/execute-investigation.ts`, AIC-125
 * slice B), pulled out to this module rather than kept in `index.ts` so
 * neither depends on the other: `index.ts` re-exports the node module with
 * `export *`, and the node module needs `deriveTrialId` at runtime, so
 * importing it from `index.ts` directly would be a value-level import cycle.
 * `index.ts` re-exports both functions, so `@aic/graph`'s public surface is
 * unchanged.
 */
function hashIdentity(parts: readonly unknown[]): string {
  return createHash('sha256').update(JSON.stringify(parts)).digest('hex');
}

/**
 * A trial's identity: `sha256(JSON.stringify([runId, testId, attempt]))`. See
 * investigation-execution.test.mjs › "derives the trial id from the same
 * identity formula deriveTrialId uses: sha256 of JSON.stringify([runId,
 * testId, attempt])".
 */
export function deriveTrialId({
  runId,
  testId,
  attempt,
}: Readonly<{ runId: string; testId: string; attempt: number }>): string {
  return hashIdentity([runId, testId, attempt]);
}

export function deriveEvidenceId({
  trialId,
  payloadFingerprint,
}: Readonly<{ trialId: string; payloadFingerprint: string }>): string {
  return hashIdentity([trialId, payloadFingerprint]);
}
