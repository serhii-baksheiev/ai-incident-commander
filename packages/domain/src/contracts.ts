import { z } from 'zod';

import { PrimaryScopeSchema } from './scope.js';
import { INCIDENT_STATE_SCHEMA_VERSION, STATUS_RULES_VERSION } from './status-rules.js';

const IdentifierSchema = z.string();
const ContractStringSchema = z.string();
const NonEmptyStringSchema = z.string().min(1);
const StrengthSchema = z.enum(['high', 'medium', 'low']);

export const ToolIdSchema = NonEmptyStringSchema;
export const InvestigationPhaseSchema = NonEmptyStringSchema;

/**
 * A budget or a usage count: a non-negative safe integer, and nothing else.
 *
 * Exported because the graph re-validates these same counters at runtime and
 * must not restate the rule — a schema that admits `-1` while the graph rejects
 * it is one fact spelled two ways, and the copy nobody is looking at is the one
 * that is wrong (`.claude/rules/invariants.md`, "one mechanism, one
 * implementation"). The challenge counters carried a hand-written second
 * spelling of this rule until AIC-76 and no longer do — see
 * `assertChallengeCounters` in `packages/graph/src/investigation.ts`. Which
 * fields carry the rule is not listed here, because a list in a comment is the
 * copy that goes stale: read the schema below. The one that did go stale said "four"
 * while the graph checked five, and two more have just been added.
 *
 * The graph's re-validation is not redundant, and this is the distinction worth
 * keeping. It runs where this schema cannot: a `kind: 'resume'` takes its state
 * from the checkpointer and is never parsed by `IncidentStateSchema` at all. And
 * for `challengeRounds` it enforces something no schema here expresses — the
 * `MAX_CHALLENGE_ROUNDS` cap, which is the graph's business because the graph is
 * what spends the rounds. A value one past the cap parses cleanly here on
 * purpose: investigation-graph.test.mjs › "refuses a start state one past the
 * challenge round cap, which the domain schema accepts".
 *
 * Moved above `ObservedFactSchema` and `IncidentStateControlSchema`, its two
 * users, rather than declared between them (AIC-123 slice 1).
 */
export const LogicalCountSchema = z.number().int().nonnegative();

/* -------------------------------------------------------------------------- */
/* ExpectedObservation / ObservedFact: a closed, versioned vocabulary          */
/* (AIC-123 slice 1; the owner's AIC-123 ruling of 2026-09-25, D1 and D2)     */
/* -------------------------------------------------------------------------- */

export const EXPECTED_OBSERVATION_VERSION = 1 as const;

/**
 * A subject names a service or component as the telemetry names it. It is
 * bounded, because a model or HITL caller will supply it and it is persisted
 * verbatim.
 * see expected-observation-contract.test.mjs › "refuses a subject longer than 200 characters as an ExpectedObservation"
 */
export const SubjectSchema = z.string().min(1).max(200);

/**
 * The most observations one prediction or one evidence item may carry, in
 * each list.
 * see expected-observation-contract.test.mjs › "bounds each observation list at 16 entries: expectedIfTrue, expectedIfFalse and observation.facts"
 */
const MAX_OBSERVATIONS = 16;
export const ObservationWindowSchema = z.enum(['pre-onset', 'incident', 'recovery']);
export const LogClassSchema = z.enum(['error', 'timeout', 'activity']);
export const SignalKindSchema = z.enum([
  'error-rate',
  'latency',
  'connection-pool',
  'worker-saturation',
  'dependency-health',
]);
export const SignalStateSchema = z.enum(['normal', 'elevated', 'at-limit']);
export const PresenceSchema = z.enum(['present', 'absent']);

/**
 * What a prediction commits to observing. A discriminated union of exactly the
 * three forms the corpus's evidence carries (R2, R3 in the owner ruling) —
 * replacing the previous `z.unknown()`, which accepted and round-tripped
 * anything, including the untyped `{observation: string}` bag every producer
 * used until this slice. See test/expected-observation-contract.test.mjs for
 * the accepted and refused shapes.
 */
export const ExpectedObservationSchema = z.discriminatedUnion('form', [
  z.strictObject({
    form: z.literal('deployment-in-window'),
    subject: SubjectSchema,
    window: ObservationWindowSchema,
    presence: PresenceSchema,
  }),
  z.strictObject({
    form: z.literal('log-class-in-window'),
    subject: SubjectSchema,
    window: ObservationWindowSchema,
    logClass: LogClassSchema,
    presence: PresenceSchema,
  }),
  z.strictObject({
    form: z.literal('signal-state'),
    subject: SubjectSchema,
    window: ObservationWindowSchema,
    signal: SignalKindSchema,
    state: SignalStateSchema,
  }),
]);

/**
 * The same vocabulary's typed-data half, carried on `Evidence.observation`
 * (owner ruling D2): a count and a coverage claim rather than a presence
 * verdict, so the verdict itself is derived once, by `observedPresence` below,
 * rather than asserted by whatever populates this field.
 */
export const ObservedFactSchema = z.discriminatedUnion('form', [
  z.strictObject({
    form: z.literal('deployment-in-window'),
    subject: SubjectSchema,
    window: ObservationWindowSchema,
    count: LogicalCountSchema,
    coverage: z.enum(['complete', 'partial']),
  }),
  z.strictObject({
    form: z.literal('log-class-in-window'),
    subject: SubjectSchema,
    window: ObservationWindowSchema,
    logClass: LogClassSchema,
    count: LogicalCountSchema,
    coverage: z.enum(['complete', 'partial']),
  }),
  z.strictObject({
    form: z.literal('signal-state'),
    subject: SubjectSchema,
    window: ObservationWindowSchema,
    signal: SignalKindSchema,
    state: SignalStateSchema,
  }),
]);

/**
 * Rule (a), defined once: a fact is `absent` only when it was counted at zero
 * under complete coverage. Anything else that carries no presence semantics at
 * all (`signal-state`) is `unknown`, never `absent` — see
 * test/expected-observation-contract.test.mjs, the `observedPresence` rows.
 */
export function observedPresence(
  fact: z.infer<typeof ObservedFactSchema>,
): z.infer<typeof PresenceSchema> | 'unknown' {
  if (fact.form === 'signal-state') return 'unknown';
  if (fact.count > 0) return 'present';
  if (fact.count === 0 && fact.coverage === 'complete') return 'absent';
  return 'unknown';
}

export const IncidentSchema = z.looseObject({
  id: IdentifierSchema,
  primaryScope: PrimaryScopeSchema,
});

export const HypothesisStatusSchema = z.enum([
  'candidate',
  'supported',
  'weakened',
  'rejected',
  'corroborated',
]);

/**
 * One shape, two users (AIC-123 slice 1):
 * `CauseClaimSchema.cause` and `Hypothesis.cause` both reference this exact
 * schema object, never two copies of the same shape — see
 * test/expected-observation-contract.test.mjs › "gives Hypothesis.cause the
 * exact same schema object CauseClaimSchema.cause uses, not a second copy of
 * the same shape". Vocabulary membership of `mechanism` is checked by the
 * caller, as it already was for `CauseClaimSchema.cause`.
 */
export const CauseDescriptionSchema = z.strictObject({
  component: ContractStringSchema,
  mechanism: ContractStringSchema,
  trigger: ContractStringSchema.optional(),
});

export const HypothesisSchema = z.strictObject({
  id: IdentifierSchema,
  statement: ContractStringSchema,
  createdBy: z.enum(['initial', 'challenge']),
  // Present only if the producer supplied one; slice 1 wires the contract, and
  // no producer sets it yet (slice 2 wires the model roles).
  cause: CauseDescriptionSchema.optional(),
});

/**
 * What the new, cause-carrying path reads: the same `Hypothesis` shape, with
 * `cause` required rather than optional — see
 * test/expected-observation-contract.test.mjs › "StructuredHypothesisSchema
 * requires a cause that HypothesisSchema leaves optional".
 */
export const StructuredHypothesisSchema = HypothesisSchema.extend({
  cause: CauseDescriptionSchema,
});

export const HumanAddedHypothesisSchema = HypothesisSchema.extend({
  createdBy: z.literal('initial'),
});

export const ConclusionReviewDecisionSchema = z.discriminatedUnion('action', [
  z.strictObject({ action: z.literal('confirm') }),
  z.strictObject({ action: z.literal('reject') }),
  z.strictObject({
    action: z.literal('add_hypothesis'),
    hypothesis: HumanAddedHypothesisSchema,
  }),
]);

export const PredictionSchema = z.strictObject({
  id: IdentifierSchema,
  hypothesisId: IdentifierSchema,
  statement: ContractStringSchema,
  observationVersion: z.literal(EXPECTED_OBSERVATION_VERSION),
  // A prediction that commits to nothing is not a prediction; expectedIfFalse
  // carries no such minimum.
  expectedIfTrue: z.array(ExpectedObservationSchema).min(1).max(MAX_OBSERVATIONS),
  expectedIfFalse: z.array(ExpectedObservationSchema).max(MAX_OBSERVATIONS),
  status: z.enum(['untested', 'confirmed', 'refuted', 'untestable']),
});

export const InvestigationTestSchema = z.strictObject({
  id: IdentifierSchema,
  predictionId: IdentifierSchema,
  tool: ToolIdSchema,
  input: z.unknown(),
  cost: z.enum(['cheap', 'medium', 'expensive']),
  status: z.enum(['planned', 'executed', 'unavailable', 'failed']),
});

export const TrialSchema = z.strictObject({
  id: IdentifierSchema,
  runId: IdentifierSchema,
  testId: IdentifierSchema,
  attempt: z.number(),
  tool: ToolIdSchema,
  input: z.unknown(),
  status: z.enum(['ok', 'unavailable', 'error']),
  durationMs: z.number(),
  evidenceIds: z.array(IdentifierSchema),
});

export const EvidenceSchema = z.strictObject({
  id: IdentifierSchema,
  trialId: IdentifierSchema,
  kind: z.enum([
    'log',
    'metric',
    'trace',
    'deploy',
    'git',
    'config',
    'dependency',
    'runbook',
    'historical-incident',
  ]),
  source: ContractStringSchema,
  observedAt: ContractStringSchema,
  statement: ContractStringSchema,
  rawRef: ContractStringSchema,
  reliability: StrengthSchema.optional(),
  // Typed data for the observation vocabulary above (owner ruling D2): optional
  // because nothing populates it yet — see
  // test/expected-observation-contract.test.mjs › "accepts Evidence with no
  // observation field, since nothing populates it yet (owner ruling D2)".
  observation: z
    .strictObject({
      version: z.literal(EXPECTED_OBSERVATION_VERSION),
      facts: z.array(ObservedFactSchema).min(1).max(MAX_OBSERVATIONS),
    })
    .optional(),
});

export const EvidenceAssessmentSchema = z.strictObject({
  id: IdentifierSchema,
  evidenceId: IdentifierSchema,
  hypothesisId: IdentifierSchema,
  predictionId: IdentifierSchema.optional(),
  effect: z.enum(['supports', 'contradicts', 'neutral']),
  strength: StrengthSchema,
  rationale: ContractStringSchema,
  producedBy: z.enum(['rule', 'llm']),
  promptVersion: ContractStringSchema.optional(),
  at: ContractStringSchema,
});

export const CauseClaimSchema = z.strictObject({
  hypothesisId: IdentifierSchema,
  cause: CauseDescriptionSchema,
  evidenceIds: z.array(IdentifierSchema),
});

export const IncidentConclusionSchema = z.strictObject({
  kind: z.enum(['root-cause', 'multiple-causes', 'inconclusive', 'no-incident']),
  causes: z.array(CauseClaimSchema),
});

export const InvestigationStopSchema = z.enum([
  'sufficient',
  'ambiguous',
  'stalled',
  'budget-exhausted',
  'tools-unavailable',
  'human-stop',
]);

export const IncidentStateControlSchema = z.strictObject({
  runId: IdentifierSchema,
  schemaVersion: z.literal(INCIDENT_STATE_SCHEMA_VERSION),
  statusRulesVersion: z.literal(STATUS_RULES_VERSION),
  phase: InvestigationPhaseSchema,
  maxIterations: LogicalCountSchema,
  llmCallBudget: LogicalCountSchema,
  reservedChallengeBudget: LogicalCountSchema,
  challengeRounds: LogicalCountSchema,
  // Usage against the two logical budgets above. Required, not optional: an
  // absent counter would have to be read as zero, which is indistinguishable
  // from a run that has spent nothing.
  // The graph owns both; a node update can never write them —
  // see investigation-graph.test.mjs › "does not let normal lifecycle nodes
  // rewrite the graph-owned logical budgets".
  iterationsUsed: LogicalCountSchema,
  llmCallsUsed: LogicalCountSchema,
  // How many times a paused run was resumed. Graph-owned like the two above —
  // see investigation-graph.test.mjs › "does not let normal lifecycle nodes
  // rewrite the graph-owned resume counter" — and required for the same reason:
  // an absent count reads as "never resumed", which is exactly what a run that
  // lost its history would also look like.
  resumeCount: LogicalCountSchema,
  stopKind: InvestigationStopSchema.optional(),
  humanReview: z.boolean(),
});

export const IncidentStateSchema = z.strictObject({
  incident: IncidentSchema,
  hypotheses: z.array(HypothesisSchema),
  predictions: z.array(PredictionSchema),
  tests: z.array(InvestigationTestSchema),
  trials: z.array(TrialSchema),
  evidence: z.array(EvidenceSchema),
  assessments: z.array(EvidenceAssessmentSchema),
  conclusion: IncidentConclusionSchema.optional(),
  control: IncidentStateControlSchema,
});

export type ToolId = z.infer<typeof ToolIdSchema>;
export type ExpectedObservation = z.infer<typeof ExpectedObservationSchema>;
export type ObservedFact = z.infer<typeof ObservedFactSchema>;
export type InvestigationPhase = z.infer<typeof InvestigationPhaseSchema>;
export type Incident = z.infer<typeof IncidentSchema>;
export type HypothesisStatus = z.infer<typeof HypothesisStatusSchema>;
export type CauseDescription = z.infer<typeof CauseDescriptionSchema>;
export type Hypothesis = z.infer<typeof HypothesisSchema>;
export type StructuredHypothesis = z.infer<typeof StructuredHypothesisSchema>;
export type HumanAddedHypothesis = z.infer<
  typeof HumanAddedHypothesisSchema
>;
export type ConclusionReviewDecision = z.infer<
  typeof ConclusionReviewDecisionSchema
>;
export type Prediction = z.infer<typeof PredictionSchema>;
export type InvestigationTest = z.infer<typeof InvestigationTestSchema>;
export type Trial = z.infer<typeof TrialSchema>;
export type Evidence = z.infer<typeof EvidenceSchema>;
export type EvidenceAssessment = z.infer<typeof EvidenceAssessmentSchema>;
export type CauseClaim = z.infer<typeof CauseClaimSchema>;
export type IncidentConclusion = z.infer<typeof IncidentConclusionSchema>;
export type InvestigationStop = z.infer<typeof InvestigationStopSchema>;
export type IncidentStateControl = z.infer<typeof IncidentStateControlSchema>;
export type IncidentState = z.infer<typeof IncidentStateSchema>;
