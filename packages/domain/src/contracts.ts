import { z } from 'zod';

import { PrimaryScopeSchema } from './scope.js';
import { INCIDENT_STATE_SCHEMA_VERSION, STATUS_RULES_VERSION } from './status-rules.js';

const IdentifierSchema = z.string();
const ContractStringSchema = z.string();
const NonEmptyStringSchema = z.string().min(1);
const StrengthSchema = z.enum(['high', 'medium', 'low']);

export const ToolIdSchema = NonEmptyStringSchema;
export const ExpectedObservationSchema = z.unknown();
export const InvestigationPhaseSchema = NonEmptyStringSchema;

export const IncidentSchema = z.looseObject({
  id: IdentifierSchema,
  primaryScope: PrimaryScopeSchema,
});

export const HypothesisStatusSchema = z.enum([
  'candidate',
  'supported',
  'weakened',
  'rejected',
]);

export const HypothesisSchema = z.strictObject({
  id: IdentifierSchema,
  statement: ContractStringSchema,
  createdBy: z.enum(['initial', 'challenge']),
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
  expectedIfTrue: z.array(ExpectedObservationSchema),
  expectedIfFalse: z.array(ExpectedObservationSchema),
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
  cause: z.strictObject({
    component: ContractStringSchema,
    mechanism: ContractStringSchema,
    trigger: ContractStringSchema.optional(),
  }),
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
 */
export const LogicalCountSchema = z.number().int().nonnegative();

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
export type InvestigationPhase = z.infer<typeof InvestigationPhaseSchema>;
export type Incident = z.infer<typeof IncidentSchema>;
export type HypothesisStatus = z.infer<typeof HypothesisStatusSchema>;
export type Hypothesis = z.infer<typeof HypothesisSchema>;
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
