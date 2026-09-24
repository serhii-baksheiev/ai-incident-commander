import { createHash } from 'node:crypto';

import { canonicalJson } from '@aic/domain';

import type { ToolResult } from './contracts.js';

/**
 * AIC-100, slice a: the additive-only half of "[ONB-3] Implement
 * EvidenceSource adapter contract and BoundSourceRegistry" — the typed port
 * an evidence-source adapter implements, and the classification/bridging
 * helpers around it. `BoundSourceRegistry` (live/record/replay modes),
 * budgets/redaction, and migrating the existing `packages/tools/live` and
 * `packages/tools/replay` adapters onto this contract are separate slices
 * (b, c, d) and are not touched here.
 *
 * See test/evidence-source-contract.test.mjs for the pinned contract this
 * file satisfies, including the exact wire format of
 * `createRequestFingerprint` and the acceptance line that a 403 (denied), a
 * timeout, and an empty successful result stay distinguishable through the
 * existing, unmodified `projectToolResult`.
 */

/** The five typed reasons an EvidenceSource may refuse a call, frozen. */
export const EVIDENCE_SOURCE_REFUSAL_REASONS = Object.freeze([
  'unavailable',
  'denied',
  'rate_limited',
  'timeout',
  'adapter_error',
] as const);

export type EvidenceSourceRefusalReason =
  (typeof EVIDENCE_SOURCE_REFUSAL_REASONS)[number];

/**
 * Provenance recorded with every EvidenceSource call, ok or refused: which
 * binding served it, which adapter build, the id of the binding's credential
 * reference (never the secret's value or name; null when none), when it was
 * fetched, and a deterministic fingerprint of the request that was made.
 */
export interface EvidenceSourceProvenance {
  readonly sourceBindingId: string;
  readonly adapter: string;
  readonly credentialRefId: string | null;
  readonly fetchedAt: string;
  readonly requestFingerprint: string;
}

/** The result of a single EvidenceSource#execute call. */
export type EvidenceSourceOutcome<Output> =
  | { readonly status: 'ok'; readonly output: Output; readonly provenance: EvidenceSourceProvenance }
  | {
      readonly status: 'refused';
      readonly reason: EvidenceSourceRefusalReason;
      readonly provenance: EvidenceSourceProvenance;
    };

/** The result of an EvidenceSource#check readiness probe. */
export type EvidenceSourceCheckResult =
  | { readonly status: 'ready' }
  | { readonly status: 'refused'; readonly reason: EvidenceSourceRefusalReason };

/** Static self-description an EvidenceSource adapter reports. */
export interface EvidenceSourceDescriptor {
  readonly adapterId: string;
  readonly version: string;
  readonly operations: readonly string[];
}

/**
 * The port an evidence-source adapter implements. `Output` defaults to
 * `unknown` so the interface itself stays non-generic at call sites that do
 * not care what a specific operation returns (see
 * test/fixtures/evidence-source-type-contract.ts).
 */
export interface EvidenceSource<Output = unknown> {
  describe(): EvidenceSourceDescriptor;
  check(): Promise<EvidenceSourceCheckResult>;
  /**
   * `input` carries no credential material: credentials travel only as the
   * binding's `credentialRefId`. The input is fingerprinted into provenance
   * with an unsalted hash, so a secret in it would be recoverable by guessing.
   */
  execute(operation: string, input: unknown): Promise<EvidenceSourceOutcome<Output>>;
}

export interface EvidenceSourceErrorOptions extends ErrorOptions {
  readonly reason: EvidenceSourceRefusalReason;
}

/**
 * Raised by an adapter to classify a failure into one of the five typed
 * refusal reasons, mirroring `StaleOwnerError` / `ExecutionIntegrityViolation`
 * in `@aic/domain`'s `execution.ts`: a named `Error` subclass with a stable,
 * message-independent `code`, checked by `instanceof` and `.name`/`.code`,
 * never by message text. See
 * test/evidence-source-contract.test.mjs › "EvidenceSourceError is a named
 * Error subclass carrying a stable code and one of the five refusal reasons"
 * and › "EvidenceSourceError.code is stable across instances, regardless of
 * reason or message".
 */
export class EvidenceSourceError extends Error {
  readonly code = 'evidence_source.refused' as const;
  readonly reason: EvidenceSourceRefusalReason;

  constructor(message: string, options: EvidenceSourceErrorOptions) {
    super(message, options);
    this.name = 'EvidenceSourceError';
    this.reason = options.reason;
  }
}

/**
 * Classifies a thrown value into one of the five typed refusal reasons. An
 * `EvidenceSourceError` keeps its own `reason`; anything else — a plain
 * `Error`, a non-Error thrown value — classifies as `adapter_error`. Only
 * `instanceof EvidenceSourceError` and its typed `.reason` are consulted. What
 * the test pins is the consequence: no text from the thrown value reaches a
 * serialized outcome. See
 * test/evidence-source-contract.test.mjs › "classifyEvidenceSourceFailure
 * never carries a thrown error's message text into a serialized outcome (no
 * secret leakage)".
 */
export function classifyEvidenceSourceFailure(
  error: unknown,
): EvidenceSourceRefusalReason {
  if (error instanceof EvidenceSourceError) {
    return error.reason;
  }
  return 'adapter_error';
}

/**
 * Deterministic fingerprint of an EvidenceSource request:
 * `` `sha256:${hex}` `` where `hex` is the lowercase-hex SHA-256 digest of
 * `JSON.stringify(canonicalJson({ input, operation }))`. Reuses `@aic/domain`'s
 * `canonicalJson` — the one canonical-JSON implementation in this repository
 * (`.claude/rules/invariants.md`, "one mechanism, one implementation") —
 * rather than a second canonicalizer, so key order in a nested `input` never
 * affects the fingerprint. See
 * test/evidence-source-contract.test.mjs › "createRequestFingerprint matches
 * an independently computed sha256 over the pinned canonical envelope (fixed
 * input, hand-built string — not canonicalJson called from the test)" for the
 * exact pinned wire format. It throws what `canonicalJson` throws for a
 * non-JSON input — see durable-execution-contract.test.mjs › "canonicalJson
 * refuses non-JSON values: undefined in an object, a function, a bigint, NaN
 * and Infinity" — so an adapter calls it inside its own try and classifies
 * that as `adapter_error`.
 */
export function createRequestFingerprint(operation: string, input: unknown): string {
  const canonicalEnvelope = JSON.stringify(canonicalJson({ input, operation }));
  const hex = createHash('sha256').update(canonicalEnvelope).digest('hex');
  return `sha256:${hex}`;
}

/**
 * Bridges an `EvidenceSourceOutcome` into the existing, unmodified
 * `ToolResult` so `projectToolResult` keeps working unchanged: `ok` maps to
 * `ToolResult.ok` (an empty successful output stays `ok`, never a refusal);
 * `refused` with reason `unavailable` / `denied` / `rate_limited` / `timeout`
 * maps to `ToolResult.unavailable`, so the prediction becomes untestable
 * rather than reading as negative evidence; `refused` with reason
 * `adapter_error` maps to `ToolResult.error`. The mapped reason/message
 * carries only the typed reason code, never a thrown error's own message
 * text. See test/evidence-source-contract.test.mjs › "a 403 (denied), a
 * timeout and an empty successful result remain distinguishable through the
 * real, unmodified projectToolResult (AIC-100 acceptance)". A new refusal
 * reason is a compile error in the switch
 * below until it is mapped.
 */
export function evidenceSourceOutcomeToToolResult<Output>(
  outcome: EvidenceSourceOutcome<Output>,
): ToolResult<Output> {
  if (outcome.status === 'ok') {
    return { status: 'ok', output: outcome.output };
  }

  switch (outcome.reason) {
    case 'adapter_error':
      return { status: 'error', message: outcome.reason };
    case 'unavailable':
    case 'denied':
    case 'rate_limited':
    case 'timeout':
      return { status: 'unavailable', reason: outcome.reason };
    default: {
      // Compile-time: a new reason must be mapped above. Runtime (untyped JS or
      // fixture JSON): a reason outside the five stays untestable, and its
      // unknown text is not echoed.
      const unmapped: never = outcome.reason;
      void unmapped;
      return { status: 'unavailable', reason: 'unavailable' };
    }
  }
}
