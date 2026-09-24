import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';

import {
  EVIDENCE_SOURCE_REFUSAL_REASONS,
  classifyEvidenceSourceFailure,
  createRequestFingerprint,
} from './evidence-source.js';
import type {
  EvidenceSource,
  EvidenceSourceOutcome,
  EvidenceSourceProvenance,
  EvidenceSourceRefusalReason,
} from './evidence-source.js';
import { redactEvidenceOutput } from './redaction.js';

/**
 * AIC-100, slice b: `BoundSourceRegistry` — the live/record/replay wrapper
 * around slice a's `EvidenceSource` port (`./evidence-source.js`, unmodified
 * here). See test/bound-source-registry.test.mjs's header for the full set of
 * design pins this file satisfies (provenance is written ONLY by the
 * registry, the two provenance edge cases, the versioned replay identity, and
 * the explicit `rekeyReplayRecordings` migration path), including the review
 * round 1 findings the same header names (the JSON-array replay identity,
 * replay's provenance.credentialRefId, the fromAdapter===toAdapter no-op, the
 * file store's 0o600 mode, malformed/unparseable recordings, and __proto__
 * handling).
 *
 * AIC-100, slice c adds budgets and redaction on top of the above (same
 * file, see test/bound-source-registry.test.mjs's "AIC-100 slice c" sections):
 * a `timeoutMs`/`maxResultBytes`/`maxPages` budget, validated at
 * construction and defaulting to `DEFAULT_SOURCE_BUDGETS`; a real-timer
 * timeout race around the adapter call in `live`/`record`; a result-size
 * refusal (`budget_exceeded`) measured on an `ok` outcome's output; the
 * `{ maxPages }` hint passed as `execute`'s additive third argument; and
 * `redactEvidenceOutput` (`./redaction.js`) run over an `ok` outcome's output
 * before it is stored in `record` mode and before it is returned to the
 * caller in both `live` and `record`.
 *
 * Review round 1 on slice c added three more findings this file now
 * satisfies too (test/bound-source-registry.test.mjs's "AIC-100 slice c —
 * review round 1 findings" block):
 *   - `replay` redacts the `output` of a STORED `ok` hit too, not only what
 *     `record` itself wrote — a recording made before redaction shipped, or
 *     written by a caller that bypassed the registry, still never reaches a
 *     replaying caller unredacted (security + code-reviewer blocker 2).
 *   - an adapter's own `execute()` may RETURN (not throw) a `refused` outcome
 *     whose `reason` is free text rather than one of
 *     `EVIDENCE_SOURCE_REFUSAL_REASONS` — the registry normalizes that reason
 *     to `adapter_error` before it reaches the caller or `store.set`, exactly
 *     as it already does for a THROWN, unclassified failure (code-reviewer
 *     blocker 5). A reason the adapter returns that IS already one of the six
 *     typed reasons is kept unchanged.
 *   - a binding's `describe().adapterId`/`.version` are validated at
 *     construction, synchronously, against `SAFE_ADAPTER_ID`/
 *     `SAFE_ADAPTER_TOKEN` AND checked to survive `redactEvidenceOutput`
 *     unchanged — an all-alphanumeric value can pass a character-class
 *     pattern while still being credential-shaped (an AWS access-key id is
 *     exactly this case), so the pattern alone is not enough (code-reviewer
 *     blocker 6, review round 2). `adapterId` permits `:` (the colon-collision
 *     rows in this same test file construct one on purpose);  `version` does
 *     not, matching the separator `` `${adapterId}@${version}` `` uses in
 *     `provenance.adapter`.
 *
 * Review round 2 on slice c added three more findings this file now satisfies
 * (test/bound-source-registry.test.mjs's "AIC-100 slice c — review round 2
 * findings" block; the other three are `./redaction.ts`'s own, see that
 * file's header):
 *   - `describe()` is called exactly ONCE per binding, at construction —
 *     never again on any later `execute()` call. The validated `adapterId`/
 *     `version` and the `operations` list are captured into a
 *     `BoundSourceEntry` snapshot right there, so a binding whose `describe()`
 *     later starts returning something else (including a credential-shaped
 *     value) can never poison `provenance.adapter` or reopen the
 *     safe-token/redaction check on a later call (review round 2, finding 4).
 *     See `BoundSourceEntry`'s own doc comment below.
 *   - `SAFE_ADAPTER_ID`/`SAFE_ADAPTER_TOKEN` both cap their input at 64
 *     characters (review round 2, finding 5) — see those two exports' own
 *     doc comments for the exact shape and why `version` refuses `:` for a
 *     narrower reason than `adapterId` permits it.
 *
 * `replay` never re-applies a budget: it serves whatever was recorded under
 * the budget in force at record time, because the adapter is never called in
 * replay at all.
 *
 * What this module redacts, stated exactly, and what it does not:
 *   - an `ok` outcome's `output` is redacted in every mode that ever hands one
 *     to a caller or a store: `live` and `record` redact the adapter's raw
 *     output before returning or storing it; `replay` redacts whatever
 *     `output` the stored recording carries on every hit, regardless of
 *     whether that recording was itself written redacted.
 *   - a `refused` outcome's `reason` is always one of the six typed codes in
 *     `EVIDENCE_SOURCE_REFUSAL_REASONS` by the time it reaches a caller or
 *     `store.set` — never free text — because every path that can produce one
 *     (a thrown failure via `classifyEvidenceSourceFailure`, an
 *     adapter-RETURNED refusal via the normalization above, and a replayed
 *     recording via `isWellFormedStoredOutcome`'s own check) enforces the
 *     closed set before the reason is used.
 *   - every `EvidenceSourceProvenance` field is BUILT BY THE REGISTRY, never
 *     copied from an adapter's own (possibly foreign) provenance:
 *     `sourceBindingId` is the caller's argument; `adapter` is
 *     `` `${adapterId}@${version}` `` from the binding's construction-time
 *     `describe()` SNAPSHOT (review round 2, finding 4 — never a fresh call),
 *     validated at construction as above; `credentialRefId` is the CURRENT
 *     binding's own value; `fetchedAt` is `clock().toISOString()` in
 *     `live`/`record`, or the RECORDED value on a replay hit;
 *     `requestFingerprint` is `createRequestFingerprint`'s hash of
 *     `operation`/`input`. None of the four carries adapter-supplied free
 *     text.
 *   - what is NOT covered: a field a caller invents outside `output`/`reason`/
 *     `provenance` (an `interactionId`-like note, a diagnostic message) is
 *     that caller's own responsibility to redact — this module's contract is
 *     exactly the three fields above. A call whose adapter `execute()` never
 *     settles or rejects keeps running in the background past the configured
 *     `timeoutMs`: the registry's timeout race (below) stops WAITING on it,
 *     it does not cancel it — there is no `AbortSignal` threaded into
 *     `execute()` in this slice, so an adapter that ignores its own
 *     internal deadline continues consuming resources even after `execute()`
 *     has already resolved `refused`/`timeout` to its caller.
 *
 * The module reads no ambient clock: every `fetchedAt` comes from the
 * injected `clock: () => Date` an options bag carries, never `Date.now()` or
 * `new Date()` called directly here. The timeout race (slice c) DOES use a
 * real `setTimeout`, deliberately: `.claude/rules/invariants.md`'s single
 * "ambient clock" prohibition is about `fetchedAt`'s VALUE, not about
 * whether real wall-clock time may ever elapse inside the module — see
 * test/bound-source-registry.test.mjs's "AIC-100 slice c — timeout budget,
 * real timers" section header, which pins real timers as the design choice.
 */

/** The three modes a `BoundSourceRegistry` may run in — a closed union. */
export type BoundSourceMode = 'live' | 'record' | 'replay';

/**
 * The three budgets a `BoundSourceRegistry` enforces around an adapter call
 * in `live`/`record` mode (AIC-100 slice c). All three are positive
 * integers, validated at construction — see `validateSourceBudgets` below
 * and test/bound-source-registry.test.mjs's "AIC-100 slice c —
 * DEFAULT_SOURCE_BUDGETS and budgets construction" section.
 */
export interface SourceBudgets {
  readonly timeoutMs: number;
  readonly maxResultBytes: number;
  readonly maxPages: number;
}

/**
 * The budgets a `BoundSourceRegistry` uses when its `budgets` option is
 * omitted, or for any field a partial `budgets` option does not specify.
 * Frozen, matching `EVIDENCE_SOURCE_REFUSAL_REASONS`'s own closed-registry
 * convention. See test/bound-source-registry.test.mjs › "publishes
 * DEFAULT_SOURCE_BUDGETS as a frozen object of three positive-integer
 * fields".
 */
export const DEFAULT_SOURCE_BUDGETS: SourceBudgets = Object.freeze({
  timeoutMs: 30_000,
  maxResultBytes: 5_000_000,
  maxPages: 50,
});

/**
 * Merges a caller-supplied (possibly partial) `budgets` option over
 * `DEFAULT_SOURCE_BUDGETS` and validates every field of the RESULT — so a
 * field the caller omitted is checked as a default too, and a field the
 * caller overrides is checked as what it actually is. Throws synchronously,
 * the same way an unknown `mode` or a duplicate `sourceBindingId` already do.
 * See test/bound-source-registry.test.mjs's "refuses construction with a
 * non-positive or non-integer budgets field" rows.
 */
function validateSourceBudgets(budgets: Partial<SourceBudgets> | undefined): SourceBudgets {
  const merged: SourceBudgets = { ...DEFAULT_SOURCE_BUDGETS, ...budgets };
  for (const key of ['timeoutMs', 'maxResultBytes', 'maxPages'] as const) {
    const value = merged[key];
    if (!Number.isInteger(value) || value <= 0) {
      throw new Error(
        `createBoundSourceRegistry: budgets.${key} must be a positive integer, got ${JSON.stringify(value)}`,
      );
    }
  }
  return merged;
}

/**
 * The safe-token pattern a binding's `describe().version` must match before
 * it is trusted in `provenance.adapter` (`` `${adapterId}@${version}` ``):
 * an alphanumeric first character (so an all-punctuation string never
 * matches at all), then up to 63 more characters from letters, digits, `.`,
 * `_` and `-` — 64 characters total, bounded rather than unbounded (review
 * round 2, finding 5). No `:` — the string `adapterId@version` in
 * `provenance.adapter` is itself separated by `@`, not `:`, so a `:` inside
 * `version` would not collide with that separator; it is refused anyway
 * because, unlike `adapterId` (see `SAFE_ADAPTER_ID` below, whose own
 * colon-collision regression rows genuinely need one), no existing behaviour
 * here needs `version` to carry a `:`, so its character set is kept as narrow
 * as the two patterns can differ by — exactly one character, `:`, and nothing
 * else. No `@` (the `adapterId@version` separator itself) and no whitespace.
 * Matching this
 * pattern is necessary but not sufficient: `validateSafeAdapterField` below
 * also requires the value to survive `redactEvidenceOutput` unchanged, because
 * an all-alphanumeric credential (an AWS access-key id) passes this
 * character-class check while still being credential-shaped (review round 1,
 * code-reviewer blocker 6; review round 2). See
 * test/bound-source-registry.test.mjs's "SAFE_ADAPTER_TOKEN" and
 * "construction refuses a version that is a credential shape" rows, and its
 * "SAFE_ADAPTER_TOKEN accepts a 64-character token and refuses a
 * 65-character token" row (review round 2, finding 5).
 */
export const SAFE_ADAPTER_TOKEN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

/**
 * The safe-token pattern a binding's `describe().adapterId` must match: the
 * same shape as `SAFE_ADAPTER_TOKEN` (an alphanumeric first character, 64
 * characters total) plus `:` in the allowed set — deliberately more
 * permissive than `version`, because this file's own replay-identity design
 * (and its colon-collision regression rows) constructs an `adapterId` such as
 * `'b:c'` on purpose. Still refuses `@` (the `adapterId@version` separator)
 * and whitespace, and — like `SAFE_ADAPTER_TOKEN` — is not sufficient on its
 * own: `validateSafeAdapterField` also requires the value to survive
 * `redactEvidenceOutput` unchanged. See
 * test/bound-source-registry.test.mjs's "SAFE_ADAPTER_ID" and "construction
 * accepts adapterId \"b:c\"" rows (review round 2), and its "SAFE_ADAPTER_ID
 * accepts a 64-character id and refuses a 65-character id" row (review round
 * 2, finding 5).
 */
export const SAFE_ADAPTER_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/;

/**
 * Refuses (synchronously, at construction) a `describe()` field that either
 * fails its own safe-token pattern, or — even when it passes that pattern —
 * would be changed by `redactEvidenceOutput`, which is how a credential shape
 * built entirely from the pattern's own allowed characters (an AWS
 * access-key id: letters and digits only) is still caught.
 */
function validateSafeAdapterField(
  bindingId: string,
  fieldName: 'adapterId' | 'version',
  value: string,
  pattern: RegExp,
): void {
  if (!pattern.test(value)) {
    throw new Error(
      `createBoundSourceRegistry: binding ${JSON.stringify(bindingId)}'s describe().${fieldName} ${JSON.stringify(value)} does not match the safe-token pattern`,
    );
  }
  if (redactEvidenceOutput(value) !== value) {
    throw new Error(
      `createBoundSourceRegistry: binding ${JSON.stringify(bindingId)}'s describe().${fieldName} is credential-shaped and is refused`,
    );
  }
}

/** One evidence source bound into a registry under a stable id. */
export interface BoundSourceBinding {
  readonly sourceBindingId: string;
  readonly source: EvidenceSource;
  readonly credentialRefId: string | null;
  /**
   * AIC-98, slice a: an optional `` `${adapterId}@${version}` `` compatibility
   * check, compared at construction against this binding's own construction-time
   * `describe()` snapshot (never a fresh call). A mismatch throws synchronously,
   * before any binding's `check()`/`execute()` ever runs — see
   * test/bound-source-compatibility.test.mjs › "refuses construction when a
   * binding's expectedAdapter names a different adapter@version than
   * describe() reports (compatibility handshake, AIC-98 slice a)". Omitted:
   * no check, so every pre-AIC-98 binding keeps working unchanged — see that
   * file's › "constructs successfully when expectedAdapter is absent,
   * keeping every pre-AIC-98 binding working unchanged (the field is
   * additive)".
   */
  readonly expectedAdapter?: string;
}

/** A stored recording: get/set/keys/delete, all async. */
export interface ReplayStore {
  get(identity: string): Promise<EvidenceSourceOutcome<unknown> | undefined>;
  set(identity: string, outcome: EvidenceSourceOutcome<unknown>): Promise<void>;
  keys(): Promise<string[]>;
  delete(identity: string): Promise<void>;
}

export interface BoundSourceRegistryOptions {
  readonly mode: BoundSourceMode;
  readonly bindings: readonly BoundSourceBinding[];
  readonly store: ReplayStore;
  readonly clock: () => Date;
  /**
   * Optional (AIC-100 slice c): a partial override of
   * `DEFAULT_SOURCE_BUDGETS`, validated at construction. Never re-applied in
   * `replay` mode — see this file's own module-level doc comment.
   */
  readonly budgets?: Partial<SourceBudgets>;
}

export interface BoundSourceRegistry {
  execute(
    sourceBindingId: string,
    operation: string,
    input: unknown,
  ): Promise<EvidenceSourceOutcome<unknown>>;
}

/**
 * Versioned replay-identity scheme, pinned to a JSON array rather than a raw
 * `:`-join: `` `v${REPLAY_IDENTITY_VERSION}:` + JSON.stringify([sourceBindingId, adapter, requestFingerprint]) ``.
 * A raw `:`-join lets one part's own `:` characters relabel a boundary — see
 * test/bound-source-registry.test.mjs's header and its "does not collide
 * across a `:` inside a part" row (review round 1, code-reviewer blocker 1).
 * Bumping the version is an explicit, reviewed decision (a new migration
 * shape for `rekeyReplayRecordings`), never an implicit side effect of some
 * other change.
 */
export const REPLAY_IDENTITY_VERSION = 2;

const REPLAY_IDENTITY_PREFIX = `v${REPLAY_IDENTITY_VERSION}:`;

/** Exported for `migrateReplayFixtureV1`. */
export function buildReplayIdentity(parts: {
  readonly sourceBindingId: string;
  readonly adapter: string;
  readonly requestFingerprint: string;
}): string {
  return REPLAY_IDENTITY_PREFIX + JSON.stringify([parts.sourceBindingId, parts.adapter, parts.requestFingerprint]);
}

interface ParsedReplayIdentity {
  readonly sourceBindingId: string;
  readonly adapter: string;
  readonly requestFingerprint: string;
}

/**
 * The only way a stored key's parts are recovered: JSON.parse of the part
 * after this version's prefix, in a try — never a string-prefix/slice
 * operation, which is exactly the encoding that let two different
 * (sourceBindingId, adapter) pairs collide (review round 1, code-reviewer
 * blocker 1). A key that does not carry this version's prefix, or whose tail
 * does not parse as a 3-element string array, is not this version's shape and
 * is returned as `null` — callers skip it rather than guessing at it.
 */
function parseReplayIdentity(identity: string): ParsedReplayIdentity | null {
  if (!identity.startsWith(REPLAY_IDENTITY_PREFIX)) {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(identity.slice(REPLAY_IDENTITY_PREFIX.length));
  } catch {
    return null;
  }
  if (
    !Array.isArray(parsed) ||
    parsed.length !== 3 ||
    typeof parsed[0] !== 'string' ||
    typeof parsed[1] !== 'string' ||
    typeof parsed[2] !== 'string'
  ) {
    return null;
  }
  return { sourceBindingId: parsed[0], adapter: parsed[1], requestFingerprint: parsed[2] };
}

const BOUND_SOURCE_MODES: readonly BoundSourceMode[] = ['live', 'record', 'replay'];

/**
 * Normalizes an adapter-RETURNED refusal `reason` to one of the six typed
 * codes: a reason already inside `EVIDENCE_SOURCE_REFUSAL_REASONS` is kept
 * unchanged; anything else — free text, or any other value a loosely-typed
 * adapter hands back — becomes `adapter_error`, mirroring how
 * `classifyEvidenceSourceFailure` already normalizes a THROWN, unclassified
 * failure (review round 1, code-reviewer blocker 5).
 */
function normalizeRefusalReason(reason: unknown): EvidenceSourceRefusalReason {
  return typeof reason === 'string' && (EVIDENCE_SOURCE_REFUSAL_REASONS as readonly string[]).includes(reason)
    ? (reason as EvidenceSourceRefusalReason)
    : 'adapter_error';
}

/**
 * A stored value is trusted only once it is checked to be a well-formed
 * `EvidenceSourceOutcome`: `status` is `ok` or `refused`; a `refused` status
 * carries a `reason` inside `EVIDENCE_SOURCE_REFUSAL_REASONS`; `provenance` is
 * an object whose `fetchedAt` is a string (the one field a replay hit reuses
 * verbatim). Anything else — including a value with no `provenance` at all —
 * is malformed and treated as a miss (`unavailable`), never handed back to
 * the caller verbatim. See test/bound-source-registry.test.mjs's "replay
 * treats a stored record …" rows (security blocker 5b).
 */
function isWellFormedStoredOutcome(value: unknown): value is EvidenceSourceOutcome<unknown> {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const record = value as { status?: unknown; reason?: unknown; provenance?: unknown };
  if (typeof record.provenance !== 'object' || record.provenance === null) {
    return false;
  }
  const fetchedAt = (record.provenance as { fetchedAt?: unknown }).fetchedAt;
  if (typeof fetchedAt !== 'string') {
    return false;
  }
  if (record.status === 'ok') {
    return true;
  }
  if (record.status === 'refused') {
    return (
      typeof record.reason === 'string' &&
      (EVIDENCE_SOURCE_REFUSAL_REASONS as readonly string[]).includes(record.reason)
    );
  }
  return false;
}

function withRekeyedProvenanceAdapter(
  outcome: EvidenceSourceOutcome<unknown>,
  adapter: string,
): EvidenceSourceOutcome<unknown> {
  const provenance: EvidenceSourceProvenance = { ...outcome.provenance, adapter };
  return outcome.status === 'ok'
    ? { status: 'ok', output: outcome.output, provenance }
    : { status: 'refused', reason: outcome.reason, provenance };
}

/**
 * The registry: the single writer of provenance in every mode. See the
 * test file's header for the exact per-mode behaviour this satisfies.
 */
/**
 * The outcome of racing an adapter's `execute()` against the configured
 * `timeoutMs`, using a REAL `setTimeout` (never the injected `clock`, which
 * stays reserved for `fetchedAt` — see this file's module-level doc
 * comment). Whichever settles first wins; the loser's timer/promise is left
 * to resolve on its own but is never awaited or allowed to affect the
 * result — see test/bound-source-registry.test.mjs › "a source whose
 * execute() settles ok AFTER the timeout budget is still refused timeout,
 * not ok".
 */
type TimedExecuteResult =
  | { readonly kind: 'settled'; readonly result: EvidenceSourceOutcome<unknown> }
  | { readonly kind: 'rejected'; readonly error: unknown }
  | { readonly kind: 'timeout' };

function executeWithTimeout(
  source: EvidenceSource,
  operation: string,
  input: unknown,
  budgetHints: { readonly maxPages: number },
  timeoutMs: number,
): Promise<TimedExecuteResult> {
  return new Promise((resolveRace) => {
    let finished = false;
    const timer = setTimeout(() => {
      if (finished) return;
      finished = true;
      resolveRace({ kind: 'timeout' });
    }, timeoutMs);

    // Wrapped in Promise.resolve().then(...) so a SYNCHRONOUS throw from a
    // non-async adapter's execute() becomes a rejection here too, rather than
    // throwing out of this Promise executor.
    Promise.resolve()
      .then(() => source.execute(operation, input, budgetHints))
      .then(
        (result) => {
          if (finished) return;
          finished = true;
          clearTimeout(timer);
          resolveRace({ kind: 'settled', result });
        },
        (error: unknown) => {
          if (finished) return;
          finished = true;
          clearTimeout(timer);
          resolveRace({ kind: 'rejected', error });
        },
      );
  });
}

/**
 * What construction snapshots from a binding's `describe()`, once, and
 * `execute()` reuses forever after: the binding itself (for `.source` and
 * `.credentialRefId`), the pre-built `` `${adapterId}@${version}` `` string
 * `provenance.adapter` always uses, and the `operations` list `execute()`
 * checks the requested operation against. See `createBoundSourceRegistry`'s
 * construction loop below and test/bound-source-registry.test.mjs › "the
 * registry reads describe() ONCE at construction and reuses that snapshot for
 * every call … (review round 2, finding 4)".
 */
interface BoundSourceEntry {
  readonly binding: BoundSourceBinding;
  readonly adapter: string;
  readonly operations: readonly string[];
}

export function createBoundSourceRegistry(
  options: BoundSourceRegistryOptions,
): BoundSourceRegistry {
  const { mode, bindings, store, clock } = options;
  const budgets = validateSourceBudgets(options.budgets);

  if (!BOUND_SOURCE_MODES.includes(mode)) {
    throw new Error(`createBoundSourceRegistry: unknown mode ${JSON.stringify(mode)}`);
  }

  const bindingsById = new Map<string, BoundSourceEntry>();
  for (const binding of bindings) {
    if (bindingsById.has(binding.sourceBindingId)) {
      throw new Error(
        `createBoundSourceRegistry: duplicate sourceBindingId ${binding.sourceBindingId}`,
      );
    }
    // describe() is called exactly once per binding, right here, and never
    // again — the validated adapterId/version and the operations list are
    // captured into this entry's own snapshot below, so a binding whose
    // describe() later returns something different (including a
    // credential-shaped value) can never poison a later execute() call
    // (review round 2, finding 4).
    const descriptor = binding.source.describe();
    validateSafeAdapterField(binding.sourceBindingId, 'adapterId', descriptor.adapterId, SAFE_ADAPTER_ID);
    validateSafeAdapterField(binding.sourceBindingId, 'version', descriptor.version, SAFE_ADAPTER_TOKEN);
    const adapter = `${descriptor.adapterId}@${descriptor.version}`;
    // The compatibility handshake (AIC-98, slice a): compared against THIS
    // construction-time snapshot, never a fresh describe() call, and before
    // any binding's check()/execute() ever runs — see
    // test/bound-source-compatibility.test.mjs › "refuses construction when a
    // binding's expectedAdapter names a different adapter@version than
    // describe() reports (compatibility handshake, AIC-98 slice a)".
    if (binding.expectedAdapter !== undefined && binding.expectedAdapter !== adapter) {
      throw new Error(
        `createBoundSourceRegistry: binding ${JSON.stringify(binding.sourceBindingId)} expected adapter ${JSON.stringify(binding.expectedAdapter)}, got ${JSON.stringify(adapter)}`,
      );
    }
    bindingsById.set(binding.sourceBindingId, {
      binding,
      adapter,
      // A frozen COPY, never the adapter's own array: `descriptor.operations`
      // is the adapter's live reference, and a later push onto that same
      // array must never widen this entry's allow-list retroactively. See
      // test/bound-source-registry.test.mjs › "a later push onto the
      // adapter's own describe().operations array does not widen the
      // registry's allow-list … (review round 3, advisory)".
      operations: Object.freeze([...descriptor.operations]),
    });
  }

  return {
    async execute(sourceBindingId, operation, input) {
      let requestFingerprint = '';
      let fingerprintFailed = false;
      try {
        requestFingerprint = createRequestFingerprint(operation, input);
      } catch {
        fingerprintFailed = true;
      }

      const entry = bindingsById.get(sourceBindingId);

      if (!entry) {
        const provenance: EvidenceSourceProvenance = {
          sourceBindingId,
          adapter: '',
          credentialRefId: null,
          fetchedAt: clock().toISOString(),
          requestFingerprint,
        };
        return { status: 'refused', reason: 'unavailable', provenance };
      }

      // adapter and the binding itself come from the construction-time
      // snapshot, never from a fresh describe() call — see BoundSourceEntry's
      // own doc comment (review round 2, finding 4).
      const { binding, adapter } = entry;
      const credentialRefId = binding.credentialRefId;

      const buildProvenance = (fetchedAt: string): EvidenceSourceProvenance => ({
        sourceBindingId,
        adapter,
        credentialRefId,
        fetchedAt,
        requestFingerprint,
      });

      if (fingerprintFailed) {
        return {
          status: 'refused',
          reason: 'adapter_error',
          provenance: buildProvenance(clock().toISOString()),
        };
      }

      if (mode === 'replay') {
        const identity = buildReplayIdentity({ sourceBindingId, adapter, requestFingerprint });

        let stored: EvidenceSourceOutcome<unknown> | undefined;
        try {
          stored = await store.get(identity);
        } catch (error) {
          // store.get() is never allowed to reject execute() — an unparseable
          // recordings file, or any other store failure, refuses adapter_error
          // instead. See "replay over a file that is not valid JSON …"
          // (security blocker 5a).
          return {
            status: 'refused',
            reason: classifyEvidenceSourceFailure(error),
            provenance: buildProvenance(clock().toISOString()),
          };
        }

        if (stored === undefined || !isWellFormedStoredOutcome(stored)) {
          return {
            status: 'refused',
            reason: 'unavailable',
            provenance: buildProvenance(clock().toISOString()),
          };
        }

        // A replay hit rebuilds provenance from the CURRENT binding —
        // sourceBindingId, adapter and credentialRefId are recomputed fresh
        // (never read back off the recording, see code-reviewer blocker 2) —
        // keeping only the RECORDED fetchedAt, the one field a replay hit
        // takes from the stored recording rather than the replaying clock.
        const rebuiltProvenance = buildProvenance(stored.provenance.fetchedAt);
        // A stored `ok` output is redacted here too, even though `record`
        // already redacts before `store.set`: an older recording (made before
        // redaction shipped) or one written by a caller that bypassed the
        // registry may still carry a raw credential, and a replay hit must
        // never hand it back unredacted (review round 1, security +
        // code-reviewer blocker 2).
        return stored.status === 'ok'
          ? { status: 'ok', output: redactEvidenceOutput(stored.output), provenance: rebuiltProvenance }
          : { status: 'refused', reason: stored.reason, provenance: rebuiltProvenance };
      }

      // live and record share this path from here.
      if (!entry.operations.includes(operation)) {
        return {
          status: 'refused',
          reason: 'unavailable',
          provenance: buildProvenance(clock().toISOString()),
        };
      }

      let outcome: EvidenceSourceOutcome<unknown>;
      try {
        const raced = await executeWithTimeout(
          binding.source,
          operation,
          input,
          { maxPages: budgets.maxPages },
          budgets.timeoutMs,
        );

        if (raced.kind === 'timeout') {
          outcome = {
            status: 'refused',
            reason: 'timeout',
            provenance: buildProvenance(clock().toISOString()),
          };
        } else if (raced.kind === 'rejected') {
          outcome = {
            status: 'refused',
            reason: classifyEvidenceSourceFailure(raced.error),
            provenance: buildProvenance(clock().toISOString()),
          };
        } else {
          const fetchedAt = clock().toISOString();
          const result = raced.result;
          if (result.status !== 'ok') {
            // An adapter may RETURN (rather than throw) a `refused` outcome
            // whose `reason` is free text instead of one of the six typed
            // codes; normalize it the same way a thrown, unclassified failure
            // already is, so a valid typed reason is kept unchanged and
            // anything else becomes `adapter_error` (review round 1,
            // code-reviewer blocker 5).
            outcome = {
              status: 'refused',
              reason: normalizeRefusalReason(result.reason),
              provenance: buildProvenance(fetchedAt),
            };
          } else {
            // Result-size budget (AIC-100 slice c): measured on the
            // adapter's RAW output, before redaction — see
            // test/bound-source-registry.test.mjs's "AIC-100 slice c —
            // result-size budget" section.
            const resultBytes = Buffer.byteLength(JSON.stringify(result.output), 'utf8');
            outcome =
              resultBytes > budgets.maxResultBytes
                ? { status: 'refused', reason: 'budget_exceeded', provenance: buildProvenance(fetchedAt) }
                : {
                    status: 'ok',
                    output: redactEvidenceOutput(result.output),
                    provenance: buildProvenance(fetchedAt),
                  };
          }
        }
      } catch (error) {
        outcome = {
          status: 'refused',
          reason: classifyEvidenceSourceFailure(error),
          provenance: buildProvenance(clock().toISOString()),
        };
      }

      if (mode === 'record') {
        // The stored recording is exactly the (already redacted, if `ok`)
        // outcome returned to the caller above — see this file's
        // module-level doc comment for what `redactEvidenceOutput` covers
        // and test/bound-source-registry.test.mjs's "the registry redacts
        // BEFORE persistence and BEFORE returning the outcome to its caller"
        // block.
        const identity = buildReplayIdentity({ sourceBindingId, adapter, requestFingerprint });
        try {
          await store.set(identity, outcome);
        } catch (error) {
          // store.set() is never allowed to reject execute() either, even
          // though the adapter call itself may already have succeeded (review
          // round 1, security blocker 5c).
          return {
            status: 'refused',
            reason: classifyEvidenceSourceFailure(error),
            provenance: buildProvenance(clock().toISOString()),
          };
        }
      }

      return outcome;
    },
  };
}

/**
 * In-process `ReplayStore`: a plain `Map`, nothing persisted, optionally
 * seeded from `initial` (AIC-100 slice d).
 */
export function createMemoryReplayStore(
  initial: Readonly<Record<string, EvidenceSourceOutcome<unknown>>> = {},
): ReplayStore {
  const recordings = new Map<string, EvidenceSourceOutcome<unknown>>(Object.entries(initial));
  return {
    async get(identity) {
      return recordings.get(identity);
    },
    async set(identity, outcome) {
      recordings.set(identity, outcome);
    },
    async keys() {
      return Array.from(recordings.keys());
    },
    async delete(identity) {
      recordings.delete(identity);
    },
  };
}

type StoredRecordings = Record<string, EvidenceSourceOutcome<unknown>>;

/**
 * Parses the recordings file into a null-prototype object, so a `__proto__`
 * key present in the file is stored as an ordinary own property rather than
 * reassigning the object's real prototype, and a lookup for an identity like
 * `'constructor'` or `'toString'` can never resolve to an inherited
 * `Object.prototype` member — there is no prototype to inherit from. See
 * test/bound-source-registry.test.mjs's "a __proto__ key in the file never
 * surfaces through get() …" row (security advisory 6).
 */
function readRecordingsFile(path: string): StoredRecordings {
  const target: StoredRecordings = Object.create(null) as StoredRecordings;
  if (!existsSync(path)) {
    return target;
  }
  const raw = readFileSync(path, 'utf8');
  if (raw.trim().length === 0) {
    return target;
  }
  const parsed = JSON.parse(raw) as Record<string, EvidenceSourceOutcome<unknown>>;
  return Object.assign(target, parsed);
}

/**
 * Writes the whole file back with its keys sorted, so two stores holding the
 * same recordings, populated in different orders, produce byte-identical
 * files — see test/bound-source-registry.test.mjs's
 * "createFileReplayStore writes byte-identical files regardless of the order
 * recordings were set in" row.
 *
 * Written atomically: a temp file in the same directory (so the rename below
 * is same-filesystem) is created with mode `0o600` — never world-readable,
 * because a recording is adapter output kept beyond this process's own
 * memory (security blocker 4) — and renamed over the target, so a reader
 * never observes a partially written file and no temp file is left behind
 * once `set()`/`delete()` returns. `0o600` stays in force even though
 * AIC-100 slice c now redacts a recorded `ok` outcome's `output` before it
 * ever reaches this function (see `createBoundSourceRegistry`'s `record`
 * branch): a `refused` outcome's provenance and a caller who bypasses the
 * registry are both still worth keeping owner-only. See
 * test/bound-source-registry.test.mjs's "creates its recordings file with
 * mode 0o600" and "after a set(), no temporary file is left beside the store
 * …" rows.
 */
function writeRecordingsFile(path: string, recordings: StoredRecordings): void {
  const sorted: StoredRecordings = Object.create(null) as StoredRecordings;
  for (const key of Object.keys(recordings).sort()) {
    sorted[key] = recordings[key];
  }
  const contents = `${JSON.stringify(sorted, null, 2)}\n`;
  const tempPath = `${path}.tmp-${randomUUID()}`;
  try {
    writeFileSync(tempPath, contents, { encoding: 'utf8', mode: 0o600 });
    renameSync(tempPath, path);
  } catch (error) {
    try {
      unlinkSync(tempPath);
    } catch {
      // Best effort: the temporary file may never have been created, or its
      // removal may itself fail; the original error is what is rethrown.
    }
    throw error;
  }
}

/**
 * File-backed `ReplayStore`: one JSON file at `path`, read fresh and
 * rewritten whole on every mutation — no in-memory cache, so a freshly
 * constructed store in a genuinely separate process (see the test file's
 * "deterministic across a process restart" row) always sees what is on disk.
 * Construction itself performs no I/O: the file is read only inside
 * `get`/`set`/`keys`/`delete`, so a store that is only ever constructed and
 * never called (see test/fixtures/bound-source-registry-type-contract.ts,
 * executed directly by node's bare test-file discovery) touches no file.
 *
 * This store persists exactly the outcome it is given by `set()`: for an
 * `ok` outcome, `createBoundSourceRegistry`'s `record` mode already redacted
 * `output` (AIC-100 slice c, `./redaction.ts`) before calling `set()`, so
 * what lands on disk here is the same redacted value — this store itself
 * performs no redaction of its own.
 */
export function createFileReplayStore(path: string): ReplayStore {
  return {
    async get(identity) {
      return readRecordingsFile(path)[identity];
    },
    async set(identity, outcome) {
      const recordings = readRecordingsFile(path);
      recordings[identity] = outcome;
      writeRecordingsFile(path, recordings);
    },
    async keys() {
      return Object.keys(readRecordingsFile(path));
    },
    async delete(identity) {
      const recordings = readRecordingsFile(path);
      delete recordings[identity];
      writeRecordingsFile(path, recordings);
    },
  };
}

/**
 * The only thing that ever re-keys a stored recording: moves every entry
 * recorded under `(sourceBindingId, fromAdapter)` to the identity for
 * `(sourceBindingId, toAdapter)`, updating both the stored key and the
 * recorded outcome's own `provenance.adapter`. Returns the number of entries
 * migrated. An entry for a different `sourceBindingId` or a different
 * `fromAdapter` is left untouched — nothing re-keys implicitly. Keys are
 * recovered by parsing this version's JSON-array encoding (see
 * `parseReplayIdentity`), never by a string prefix/slice — a key that is not
 * this version's shape is left exactly where it is.
 *
 * `fromAdapter === toAdapter` is a no-op: it returns `0` without touching the
 * store at all — no read, no write — so the recording is left exactly where
 * it was, still replayable (review round 1, code-reviewer blocker 3).
 *
 * One implementation for every store, through the public `ReplayStore`
 * methods. Over `createFileReplayStore` each `get`/`set`/`delete` rewrites
 * the whole file, so a migration costs O(entries × matches) file I/O — a
 * known cost, accepted for fixture-sized stores rather than kept in a second,
 * store-specific copy of this algorithm.
 */
export async function rekeyReplayRecordings(
  store: ReplayStore,
  options: {
    readonly sourceBindingId: string;
    readonly fromAdapter: string;
    readonly toAdapter: string;
  },
): Promise<number> {
  const { sourceBindingId, fromAdapter, toAdapter } = options;

  if (fromAdapter === toAdapter) {
    return 0;
  }

  const keys = await store.keys();
  let migrated = 0;

  for (const key of keys) {
    const parsedIdentity = parseReplayIdentity(key);
    if (
      parsedIdentity === null ||
      parsedIdentity.sourceBindingId !== sourceBindingId ||
      parsedIdentity.adapter !== fromAdapter
    ) {
      continue;
    }

    const outcome = await store.get(key);
    if (outcome === undefined) {
      continue;
    }

    const newIdentity = buildReplayIdentity({
      sourceBindingId,
      adapter: toAdapter,
      requestFingerprint: parsedIdentity.requestFingerprint,
    });

    await store.set(newIdentity, withRekeyedProvenanceAdapter(outcome, toAdapter));
    await store.delete(key);
    migrated += 1;
  }

  return migrated;
}
