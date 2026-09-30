/**
 * AIC-21 slice 2: the two `ProposedAction` shapes — a model-facing
 * `ProposedActionDraftSchema` and the audited `ProposedActionRecordSchema` —
 * plus `ACTION_PARAMS_SCHEMAS`, the frozen per-action-type params map, and
 * `deriveActionIdempotencyKey`, the logical identity of a proposed action.
 *
 * The boundary function that builds a `ProposedAction` from untrusted input
 * (`buildProposedAction`), the refusal vocabulary
 * (`ProposalRefusalReasonSchema`), `parseProposedActionRecord` and the
 * branded `ProposedAction` type are a later, Tier-2, owner-gated slice
 * (AIC-21, slice 3). Nothing here builds a
 * `ProposedAction`, resolves risk against the registry, applies an
 * `ActionPolicy`, or checks cited evidence against state.
 *
 * Framework-free: the domain package may import only `zod`, `node:crypto` and
 * its own modules, enforced by scoped-domain-contract.test.mjs › "the domain
 * package imports only zod, node:crypto and its own modules".
 */
import { createHash } from 'node:crypto';

import { z } from 'zod';

import { ExpectedObservationSchema } from './contracts.js';
import { IdempotencyKeySchema } from './intake.js';
import { canonicalJson } from './execution.js';
import { BlastRadiusLevelSchema, RISK_REGISTRY_VERSION } from './risk-registry.js';
import { PrimaryScopeSchema, RegistryIdSchema, screenedText } from './scope.js';

export const PROPOSED_ACTION_CONTRACT_VERSION = 1 as const;

/**
 * A registry action id at most 64 characters — narrower than the free-text
 * fields below, matching the id shape `risk-registry.ts` already enforces on
 * every registered entry.
 */
const ActionTypeSchema = z.string().min(1).max(64);

/**
 * The fields every `ProposedAction`, draft or record, carries about the
 * operation's justification and safety envelope. Shared by both schemas
 * below rather than restated on each, so the two never quietly diverge
 * (`.claude/rules/invariants.md`, "one mechanism, one implementation").
 */
const ActionReasonSchema = screenedText(2000);

/**
 * At least one cited evidence id, at most 32 — the count is checked on
 * unparsed elements first, the same bounded-before-parsed pattern
 * `IncidentIntakeSchema.signals` uses (`intake.ts`), so an oversized array is
 * refused before any element is parsed. See
 * proposed-action-contract.test.mjs › "a draft with 33 evidenceIds is refused
 * on the count alone, before any element is parsed, well under half a
 * second".
 */
const ActionEvidenceIdsSchema = z
  .array(z.unknown())
  .min(1)
  .max(32)
  .pipe(z.array(z.string().min(1).max(200)));

const ActionExpectedOutcomeSchema = z.strictObject({
  statement: screenedText(1000),
  observations: z.array(ExpectedObservationSchema).max(16),
});

const ActionBlastRadiusSchema = z.strictObject({
  level: BlastRadiusLevelSchema,
  description: screenedText(500),
});

/**
 * Rollback is mandatory and has no "none" variant: a proposal without
 * rollback semantics is rejected by the schema itself, never by a later
 * check. See proposed-action-contract.test.mjs › "a draft with no
 * rollbackPlan is refused" and › "a draft whose rollbackPlan strategy is
 * "none" is refused: there is no none variant".
 */
const ActionRollbackPlanSchema = z.discriminatedUnion('strategy', [
  z.strictObject({ strategy: z.literal('compensating-action'), description: screenedText(1000) }),
  z.strictObject({ strategy: z.literal('manual-steps'), steps: z.array(screenedText(500)).min(1).max(10) }),
]);

/**
 * At least one precondition, each carrying a re-observable
 * `ExpectedObservation` (AIC-24 re-reads it against evidence and state at
 * execute time).
 */
const ActionPreconditionsSchema = z
  .array(
    z.strictObject({
      statement: screenedText(500),
      observation: ExpectedObservationSchema,
    }),
  )
  .min(1)
  .max(8);

/**
 * The only shape accepted from a model or a HITL "modify". Strict, so an
 * extra key is refused rather than silently stripped — `risk`,
 * `idempotencyKey`, `primaryScope`, `incidentId`, `writeCredentialRefId`,
 * `contractVersion`, `riskRegistryVersion` and `proposedBy` are all
 * server-derived facts about a
 * proposal, never a model's to state, and a draft carrying any of them is
 * refused as `unrecognized_keys` rather than having the field quietly
 * discarded. `params` is parsed per action type only after the type is
 * resolved against the registry (a later slice); here it is `z.unknown()`.
 */
export const ProposedActionDraftSchema = z.strictObject({
  actionType: ActionTypeSchema,
  params: z.unknown(),
  reason: ActionReasonSchema,
  evidenceIds: ActionEvidenceIdsSchema,
  expectedOutcome: ActionExpectedOutcomeSchema,
  blastRadius: ActionBlastRadiusSchema,
  rollbackPlan: ActionRollbackPlanSchema,
  preconditions: ActionPreconditionsSchema,
});
export type ProposedActionDraft = z.infer<typeof ProposedActionDraftSchema>;

/**
 * `z.strictObject` drops an own `__proto__` key instead of reporting it, and
 * `canonicalJson` keeps one as data, so a params object parsed from JSON with
 * an own `__proto__` would read as the same payload here while deriving a
 * different idempotency key. Refused before the strict parse, with a fixed
 * message that echoes nothing — see proposed-action-contract.test.mjs ›
 * "ACTION_PARAMS_SCHEMAS refuses params carrying an own __proto__ key parsed
 * from JSON, for every action type, and echoes nothing".
 */
function paramsWithoutOwnProto<T extends z.ZodType>(schema: T) {
  return z
    .unknown()
    .superRefine((value, ctx) => {
      if (typeof value === 'object' && value !== null && Object.hasOwn(value, '__proto__')) {
        ctx.addIssue({ code: 'custom', message: 'action params must not carry an own __proto__ key', path: [] });
      }
    })
    .pipe(schema);
}

/**
 * One params schema per registered safe-write action id, frozen. Kept in
 * exact correspondence with `RISK_REGISTRY`'s safe-write entries — see
 * proposed-action-contract.test.mjs › "ACTION_PARAMS_SCHEMAS keys are exactly
 * the registry's safe-write action ids, and vice versa"
 * (`.claude/rules/invariants.md`, "one mechanism, one implementation").
 */
export const ACTION_PARAMS_SCHEMAS = Object.freeze({
  'incident-comment': paramsWithoutOwnProto(z.strictObject({ body: screenedText(4000) })),
  'create-follow-up-ticket': paramsWithoutOwnProto(
    z.strictObject({ title: screenedText(200), body: screenedText(4000) }),
  ),
});

/**
 * The fields common to every `ProposedActionRecordSchema` variant besides
 * `actionType`/`params` — the draft's own justification fields, plus the
 * server-derived facts a draft may never carry.
 */
const proposedActionRecordCommonFields = {
  contractVersion: z.literal(PROPOSED_ACTION_CONTRACT_VERSION),
  riskRegistryVersion: z.literal(RISK_REGISTRY_VERSION),
  // v0.3 only ever admits a safe-write record onto this schema; a dangerous
  // action type never reaches `ProposedActionRecordSchema` (AIC-21 design,
  // section G, Q1).
  risk: z.literal('safe-write'),
  idempotencyKey: IdempotencyKeySchema,
  incidentId: z.string().min(1).max(200),
  primaryScope: PrimaryScopeSchema,
  writeCredentialRefId: RegistryIdSchema,
  proposedBy: z.enum(['llm', 'human']),
  reason: ActionReasonSchema,
  evidenceIds: ActionEvidenceIdsSchema,
  expectedOutcome: ActionExpectedOutcomeSchema,
  blastRadius: ActionBlastRadiusSchema,
  rollbackPlan: ActionRollbackPlanSchema,
  preconditions: ActionPreconditionsSchema,
};

/**
 * One discriminated-union member per `ACTION_PARAMS_SCHEMAS` entry, built
 * from each literal key so `actionType` stays a literal type and narrowing on
 * it narrows `params` — see proposed-action-contract.test.mjs › "compiles the
 * proposed-action type contract: a record narrows params by actionType, and
 * an unregistered actionType does not type-check". The variant list and the
 * params map are kept equal by › "the record schema's actionType variants are
 * exactly ACTION_PARAMS_SCHEMAS' keys, and vice versa".
 */
function proposedActionRecordVariant<K extends keyof typeof ACTION_PARAMS_SCHEMAS>(actionType: K) {
  return z.strictObject({
    ...proposedActionRecordCommonFields,
    actionType: z.literal(actionType),
    params: ACTION_PARAMS_SCHEMAS[actionType],
  });
}

/**
 * The audited record: what AIC-22's ledger will store and AIC-25's executor
 * will accept. Deliberately carries no top-level `.refine` (the
 * checkpoint-serde custom-check restriction on `IncidentStateSchema` — see
 * `contracts.ts`'s `ProvenanceAdapterFieldSchema` comment — even though this
 * schema is not reached from state in this slice), so a later slice is free
 * to embed it there without first removing one. Integrity checks that a
 * schema alone cannot express (the idempotency key matches the record,
 * `resolveRisk` agrees) belong to `parseProposedActionRecord`, a later slice.
 */
export const ProposedActionRecordSchema = z.discriminatedUnion('actionType', [
  proposedActionRecordVariant('incident-comment'),
  proposedActionRecordVariant('create-follow-up-ticket'),
]);
export type ProposedActionRecord = z.infer<typeof ProposedActionRecordSchema>;

/**
 * The parts of `deriveActionIdempotencyKey`'s logical identity: which
 * mutation, where, and on which incident. Strict, so a caller cannot pass a
 * worker id, an execution attempt, a lease id, a retry count or a process id
 * through unnoticed — see action-idempotency.test.mjs › "deriveActionIdempotencyKey
 * refuses extra parts: workerId, executionAttempt, leaseId, retry, pid".
 */
const ActionIdempotencyPartsSchema = z.strictObject({
  incidentId: z.string().min(1).max(200),
  primaryScope: PrimaryScopeSchema,
  actionType: ActionTypeSchema,
  params: z.custom<Record<string, unknown>>(
    (value) => typeof value === 'object' && value !== null && !Array.isArray(value),
    'action params must be a plain object',
  ),
});

/**
 * True when a canonical value (the output of `canonicalJson`, which keeps an
 * own `__proto__` key as data) carries one at any depth — see
 * action-idempotency.test.mjs › "params carrying an own __proto__ key, at the
 * top, nested or inside an array, are refused rather than given a second
 * identity".
 */
function carriesOwnProtoKey(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(carriesOwnProtoKey);
  if (typeof value !== 'object' || value === null) return false;
  if (Object.hasOwn(value, '__proto__')) return true;
  return Object.values(value).some(carriesOwnProtoKey);
}

const ACTION_IDEMPOTENCY_TUPLE_VERSION = 1 as const;

/**
 * Derives the logical identity of a proposed action: which mutation, where,
 * and on which incident — never why. `reason`, `evidenceIds`,
 * `expectedOutcome`, `blastRadius`, `rollbackPlan`, `preconditions` and
 * `proposedBy` never feed it, and neither does a worker id, an execution
 * attempt, a lease id, a retry count or a process id: two proposals of the
 * same operation with different justifications are the same operation, and a
 * retry of the same operation by a different worker is still the same
 * operation.
 *
 * Not an exec key: `durable-execution-contract.test.mjs` pins that no
 * `action.*` operation is ever registered in `buildExecKey`'s closed
 * registry (`execution.ts`), so this identity is built without touching that
 * registry at all, under its own domain tag `aic.action`.
 *
 * `'sha256:' + sha256(JSON.stringify(['aic.action', 1, serviceId,
 * environmentId, incidentId, actionType, canonicalJson(params)]))` —
 * `params` goes through `canonicalJson` (`execution.ts`) so the key is
 * stable under key reordering, the one place canonical JSON lives in this
 * codebase (`.claude/rules/invariants.md`, "one mechanism, one
 * implementation").
 *
 * @throws {Error} a `ZodError` when `parts` carries a missing or extra key,
 * or a field of the wrong shape (including `params` that is not a plain
 * object); an `Error` when `params` carries an own `__proto__` key at any
 * depth — see action-idempotency.test.mjs › "params carrying an own __proto__
 * key, at the top or nested, are refused rather than given a second
 * identity"; and whatever `canonicalJson` throws for a value it refuses.
 */
export function deriveActionIdempotencyKey(parts: unknown): string {
  const { incidentId, primaryScope, actionType, params } = ActionIdempotencyPartsSchema.parse(parts);
  const canonicalParams = canonicalJson(params);
  if (carriesOwnProtoKey(canonicalParams)) {
    throw new Error('action params must not carry an own __proto__ key');
  }
  const tuple = [
    'aic.action',
    ACTION_IDEMPOTENCY_TUPLE_VERSION,
    primaryScope.serviceId,
    primaryScope.environmentId,
    incidentId,
    actionType,
    canonicalParams,
  ];
  const digest = createHash('sha256').update(JSON.stringify(tuple)).digest('hex');
  return `sha256:${digest}`;
}
