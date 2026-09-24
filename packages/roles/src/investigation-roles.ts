import { createHash } from 'node:crypto';

import {
  buildExecKey,
  canonicalJson,
  CauseClaimSchema,
  conclusionViolation,
  deriveHypothesisStatus,
  EvidenceAssessmentSchema,
  HypothesisSchema,
  IncidentConclusionSchema,
  InvestigationTestSchema,
  quoteModelText,
  type CommittedExecution,
  type EvidenceAssessment,
  type Hypothesis,
  type IncidentState,
  type InvestigationTest,
} from '@aic/domain';
import type { ChallengeResult, InvestigationNodeResult } from '@aic/graph';

import { ModelRoleOutputError } from './model-errors.js';
import {
  DEFAULT_MAX_OUTPUT_TOKENS,
  JSON_ONLY,
  enumOf,
  ownArray,
  parseJsonDocument,
  parseWith,
  refuseTruncated,
  refuseUnknownKeys,
} from './role-output.js';
import type { ModelCompletion, ModelCompletionRequest, ModelPort } from './reference-model-port.js';
import { ownValue } from './own-value.js';

/**
 * Four investigation roles, backed by a reference model through a
 * provider-neutral port: `generate_hypotheses`, `interpret_residual_evidence`
 * and `challenge_hypothesis` build up the investigation, and
 * `propose_conclusion` (AIC-119 slice D) composes the final conclusion the
 * other three fed. All four share `completeOnce`'s exec-key path below, so a
 * crash between the model call and the checkpoint replays the committed
 * completion for any of them rather than asking the model again.
 * see durable-model-replay.test.mjs › "propose_conclusion: crash between commit and checkpoint - replay reuses the committed result and calls the model exactly once in total"
 * see durable-model-replay.test.mjs › "propose_conclusion: commits under buildExecKey('model.role', ...) built from the state's control fields, the role's own name and the prompt version in use"
 *
 * ## What this layer decides and what the model decides
 *
 * The model proposes CONTENT — which hypotheses, which effect, which
 * discriminating test. Everything that is a CLAIM ABOUT PROVENANCE OR LIFECYCLE
 * is stamped here, and the model never decides one. There are two different
 * mechanisms behind that, and an earlier version of this sentence claimed the
 * stronger one for all of them:
 *
 *   - **REFUSED if the model supplies it** — `producedBy`, `promptVersion` and
 *     `at`, on an assessment. A model that could write `producedBy: 'rule'`
 *     could label its own output as rule-derived, which is exactly the confound
 *     the evaluation exists to separate, so an attempt is reported rather than
 *     absorbed.
 *     see roles-model-nodes.test.mjs › "refuses an assessment that claims a rule
 *     produced it"
 *   - **STAMPED OVER, silently** — a hypothesis's `createdBy` and a
 *     discriminating test's `status`. These are built from the model's `id` and
 *     `statement` alone, so whatever the answer carried in those fields is never
 *     read. The safe value wins either way, which is why this is a difference in
 *     REPORTING rather than in what a model can achieve — but it is a real
 *     difference, and the claim above used to hide it.
 *     see roles-model-nodes.test.mjs › "produces hypotheses the domain schema
 *     accepts and declares the call it made"
 *
 * ## Every value crosses the domain schemas
 *
 * The domain contracts are `strictObject`, so an extra key is refused rather
 * than carried. That is the whole validation story here: this module adds no
 * second vocabulary of its own, it parses with the schemas the graph and the
 * evaluators already read.
 *
 * ## Limits, stated
 *
 *   - **The answer shape is enforced by the PROVIDER, and the tolerant parse is
 *     the belt beside those braces.** Each role declares a JSON schema, sent as
 *     `output_config.format`, so a malformed answer is refused before it reaches
 *     here. The first-`{`-to-last-`}` scan stays for the answer the schema does
 *     not cover and for a provider that ignores the field.
 *     see roles-port-contract.test.mjs › "constrains the answer shape at the provider when a role declares one"
 *     see roles-model-nodes.test.mjs › "reads a JSON answer the model wrapped in
 *     prose or a fenced block"
 *
 *     ⚠ This bullet used to read "The answer is JSON in text, not a provider
 *     structured-output feature… this repository cannot exercise without a
 *     credential". Both halves stopped being true when the schemas landed —
 *     ninety lines below it — and the row named above exercises the wire shape
 *     with an injected transport and no credential at all.
 *   - **One completion per role execution.** No repair round, no retry: a role
 *     that could re-ask on a refused answer would hide the model-quality signal
 *     the lane is measuring.
 *     see roles-model-nodes.test.mjs › "refuses a hypothesis set the domain
 *     schema does not accept"
 *   - **`challenge_hypothesis` reports no `declaredLlmCalls`**, because a
 *     `ChallengeResult` has no such field and the graph refuses an unknown one.
 *     Its consumption reaches the lane through the usage ledger instead.
 *     see roles-model-nodes.test.mjs › "records the challenge role usage in the
 *     ledger while the graph counter cannot see it"
 */

/**
 * The answer shapes, as schemas the PROVIDER enforces.
 *
 * 🔴 **These make the provenance channel unexpressible, which is stronger than
 * refusing it.** Every schema is `additionalProperties: false` and none of them
 * declares `producedBy`, `promptVersion` or `at` — so a model cannot claim
 * provenance at all, rather than claiming it and being caught. The architecture
 * says the model governs content and never provenance; this enforces that at the
 * boundary instead of detecting a violation after the fact.
 *
 * The refusals below stay anyway, and deliberately: the schema is the
 * PROVIDER's guarantee and the refusal is ours. A guard that rests on a remote
 * party keeping its promise is a guard with one owner too few.
 *
 * ⚠ **What these do NOT constrain: content.** A schema-valid answer whose
 * hypothesis is wrong, whose evidence id does not exist, or whose effect
 * contradicts the state is still refused by the domain, and those refusals are
 * the model-quality signal this lane measures. Encoding is not judgement.
 *
 * ⚠ **`discriminatingTests[].input` is a CLOSED shape, and that is a real
 * limit worth stating.** The API refuses every open form — measured: an
 * `object` with `additionalProperties: true` ("not supported"), an empty schema
 * ("Empty schema ({}) that accepts any JSON value is not supported"), and every
 * `object` must set `additionalProperties: false` explicitly. So the input keys
 * are enumerated from the ones the replay corpus actually uses (`service`,
 * `window`, `query`, `metric`), all optional. The domain types this field
 * `z.unknown()` and would accept any shape, so the constraint is this schema's
 * and not the domain's: a tool needing a key outside that set cannot be
 * expressed, which is a false REFUSAL — the safe direction — and it will show up
 * as the model failing to answer rather than as a wrong answer accepted.
 *
 * Encoding the payload as a JSON string was the alternative and was rejected: it
 * satisfies the API while moving the parse failure from the envelope into the
 * field, which relocates the defect instead of removing it.
 * see roles-port-contract.test.mjs › "constrains the answer shape at the provider when a role declares one"
 */

const HYPOTHESES_SCHEMA = Object.freeze({
  type: 'object',
  properties: {
    hypotheses: {
      type: 'array',
      items: {
        type: 'object',
        properties: { id: { type: 'string' }, statement: { type: 'string' } },
        required: ['id', 'statement'],
        additionalProperties: false,
      },
    },
  },
  required: ['hypotheses'],
  additionalProperties: false,
});

const ASSESSMENTS_SCHEMA = Object.freeze({
  type: 'object',
  properties: {
    assessments: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          evidenceId: { type: 'string' },
          hypothesisId: { type: 'string' },
          predictionId: { type: 'string' },
          effect: { type: 'string', enum: enumOf(EvidenceAssessmentSchema, 'effect') },
          strength: { type: 'string', enum: enumOf(EvidenceAssessmentSchema, 'strength') },
          rationale: { type: 'string' },
        },
        required: ['id', 'evidenceId', 'hypothesisId', 'effect', 'strength', 'rationale'],
        additionalProperties: false,
      },
    },
  },
  required: ['assessments'],
  additionalProperties: false,
});

const CHALLENGE_SCHEMA = Object.freeze({
  type: 'object',
  properties: {
    alternative: {
      type: 'object',
      properties: { id: { type: 'string' }, statement: { type: 'string' } },
      required: ['id', 'statement'],
      additionalProperties: false,
    },
    discriminatingTests: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          predictionId: { type: 'string' },
          // `minLength` matches the domain's `ToolIdSchema` (`z.string().min(1)`).
          // Without it a schema-valid empty tool id reached the domain and was
          // refused there — the schema permitting what the domain rejects, which
          // is the shape this whole repair exists to remove.
          tool: { type: 'string', minLength: 1 },
          input: {
            type: 'object',
            properties: {
              service: { type: 'string' },
              window: { type: 'string' },
              query: { type: 'string' },
              metric: { type: 'string' },
            },
            additionalProperties: false,
          },
          cost: { type: 'string', enum: enumOf(InvestigationTestSchema, 'cost') },
          // `planned` only: a test the model PROPOSES has not run, so the other
          // three statuses the domain allows would be claims about execution.
          status: { type: 'string', enum: ['planned'] },
        },
        required: ['id', 'predictionId', 'tool', 'input', 'cost', 'status'],
        additionalProperties: false,
      },
    },
  },
  required: ['alternative', 'discriminatingTests'],
  additionalProperties: false,
});

/**
 * The prompt set this module ships, versioned so a run can record which it
 * used. AIC-119 slice E bumps this to v0.3: `propose_conclusion` is now wired
 * into the graph arm (`scripts/lane-arms.mjs`'s `modelNodes`), and
 * `interpret_residual_evidence`'s system prompt states the id contract below.
 * see docs/evidence/preregistration/v0.2-four-arm-supplement-1.md
 */
export const REFERENCE_PROMPT_VERSION = 'reference-roles-prompt-v0.3' as const;

export { DEFAULT_MAX_OUTPUT_TOKENS } from './role-output.js';

export interface ModelRoleOptions {
  readonly port: ModelPort;
  /**
   * When given, each model call is one committed operation under the
   * `model.role` exec key, so a run resumed after a crash between the commit
   * and the checkpoint reuses the completion instead of asking the model again
   * (docs/decisions/durable-run-execution.md, decisions 5-7). Without it the
   * roles call the port directly, as before AIC-56.
   */
  readonly execution?: CommittedExecution;
  readonly promptVersion?: string;
  readonly maxOutputTokens?: number;
  /** The clock, injected so an assessment's `at` is decidable in a test. */
  readonly at?: () => string;
}

/**
 * One model call, committed when an execution port is given. The key is the
 * call's position in the run — role, prompt version and the graph-owned
 * counters — and the request's own fingerprint travels with it, so two
 * different requests that ever land on one key are refused as an integrity
 * violation rather than one silently answering the other.
 *
 * The key is sufficient only while every graph edge back into a model role
 * moves one of `iterationsUsed`, `challengeRounds` or `resumeCount`; an edge
 * that re-entered a role without moving one would give two calls one key and
 * turn the second into a permanent integrity refusal. see
 * durable-model-replay.test.mjs › "records a distinct model.role exec key for
 * every model call across generate -> interpret -> challenge -> interpret, and
 * no key ever repeats"
 * see durable-model-replay.test.mjs › "records a distinct model.role exec key
 * for propose_conclusion too, one edge past the row above, and no key ever
 * repeats"
 *
 * The completion is committed before the role parses it, so a truncated or
 * malformed answer is what later attempts replay for that key, and changing
 * `maxOutputTokens` changes the request under the same key — an integrity
 * refusal, not a retry.
 */
function completeOnce(
  { port, execution, promptVersion }: { port: ModelPort; execution?: CommittedExecution; promptVersion: string },
  role: string,
  state: IncidentState,
  request: ModelCompletionRequest,
): Promise<ModelCompletion> {
  if (execution === undefined) return port.complete(request);
  const execKey = buildExecKey('model.role', {
    runId: state.control.runId,
    role,
    promptVersion,
    iterationsUsed: state.control.iterationsUsed,
    challengeRounds: state.control.challengeRounds,
    resumeCount: state.control.resumeCount,
  });
  const inputFingerprint = `sha256:${createHash('sha256').update(JSON.stringify(canonicalJson(request))).digest('hex')}`;
  return execution.committed(execKey, () => port.complete(request), { inputFingerprint });
}

/**
 * The state the model is shown.
 *
 * A compact projection rather than the whole state: the control block carries
 * budgets and a run id the model has no business deciding from, and a prompt
 * that grows with every field added to `IncidentState` is a prompt whose version
 * silently changes meaning.
 *
 * `incident.primaryScope` (AIC-96) is one such field, and it is deliberately
 * omitted rather than shown: the scope routes the run to a registry Service and
 * Environment and is not investigation evidence. see roles-model-nodes.test.mjs
 * › "does not show the model the incident primaryScope, only its id"
 */
function describeState(state: IncidentState): string {
  const { primaryScope: _primaryScope, ...incident } = state.incident;
  return JSON.stringify(
    {
      incident,
      hypotheses: state.hypotheses,
      predictions: state.predictions,
      evidence: state.evidence,
      assessments: state.assessments,
    },
    null,
    2,
  );
}

/**
 * `generate_hypotheses`, backed by the model.
 *
 * `createdBy: 'initial'` is stamped here: a hypothesis this node produces is by
 * definition an initial one, and the challenge role is the only producer of a
 * `'challenge'` hypothesis.
 * see roles-model-nodes.test.mjs › "produces hypotheses the domain schema accepts
 * and declares the call it made"
 */
export function createModelGenerateHypotheses({
  port,
  execution,
  promptVersion = REFERENCE_PROMPT_VERSION,
  maxOutputTokens = DEFAULT_MAX_OUTPUT_TOKENS,
}: ModelRoleOptions): (
  state: IncidentState,
) => Promise<InvestigationNodeResult> {
  const role = 'generate_hypotheses';
  return async (state) => {
    const completion = await completeOnce({ port, execution, promptVersion }, role, state, {
      system: [
        'You are an incident investigator proposing candidate explanations.',
        'Propose distinct, falsifiable causal hypotheses for the incident below.',
        `Answer shape: {"hypotheses":[{"id":"<stable id>","statement":"<one sentence>"}]}`,
        JSON_ONLY,
      ].join('\n'),
      prompt: `prompt-version: ${promptVersion}\n\n${describeState(state)}`,
      maxOutputTokens,
      outputSchema: HYPOTHESES_SCHEMA,
    });

    refuseTruncated(role, completion);
    const document = parseJsonDocument(role, completion.text);
    // 🔴 An id already in state is REFUSED, not merged.
    //
    // The graph's reducer is `upsertById`, which REPLACES the record at a
    // matching id rather than merging into it, so a model that emits an
    // existing id overwrites that hypothesis outright — including one a human
    // added, or the leader a challenge produced. Both sibling producers already
    // refuse exactly this: `challenge result reuses an existing hypothesis id`
    // in the graph, and `assertHumanHypothesisIdIsAvailable` for a human
    // decision. This role was the third producer and the only one without it.
    //
    // The reachable path is not hypothetical: a human `reject` on conclusion
    // review routes back through this node with state populated, and
    // `describeState` puts every existing id in the prompt — so incident text an
    // attacker can influence (a log line, a deployment message) reaches a model
    // that can then name one of those ids back. Found by `security-scanner` at
    // the AIC-94 gate.
    // see roles-model-nodes.test.mjs › "refuses a hypothesis id the run already
    // carries, rather than overwriting it"
    const taken = new Set(state.hypotheses.map(({ id }) => id));
    const hypotheses: Hypothesis[] = ownArray(role, document, 'hypotheses').map(
      (candidate) => {
        const hypothesis = parseWith(role, HypothesisSchema, {
          id: ownValue(candidate, 'id'),
          statement: ownValue(candidate, 'statement'),
          createdBy: 'initial',
        });
        if (taken.has(hypothesis.id)) {
          throw new ModelRoleOutputError(
            role,
            `proposed a hypothesis id the run already carries: ${quoteModelText(hypothesis.id)}`,
          );
        }
        taken.add(hypothesis.id);
        return hypothesis;
      },
    );

    return { hypotheses, declaredLlmCalls: 1 };
  };
}

/**
 * `interpret_residual_evidence`, backed by the model.
 *
 * `producedBy: 'llm'` and `promptVersion` are stamped here — both fields already
 * exist in the frozen v0.1 `EvidenceAssessmentSchema`, so this role needs no
 * schema change to record that a model, and which prompt, produced the reading.
 * see roles-model-nodes.test.mjs › "stamps every assessment as llm-produced and
 * carries the prompt version"
 */
export function createModelInterpretResidualEvidence({
  port,
  execution,
  promptVersion = REFERENCE_PROMPT_VERSION,
  maxOutputTokens = DEFAULT_MAX_OUTPUT_TOKENS,
  at = () => new Date().toISOString(),
}: ModelRoleOptions): (
  state: IncidentState,
) => Promise<InvestigationNodeResult> {
  const role = 'interpret_residual_evidence';
  return async (state) => {
    const completion = await completeOnce({ port, execution, promptVersion }, role, state, {
      system: [
        'You are an incident investigator reading evidence against hypotheses.',
        'For each piece of evidence that bears on a hypothesis, state the effect and how strongly.',
        'Answer shape: {"assessments":[{"id":"<stable id>","evidenceId":"<id>","hypothesisId":"<id>","predictionId":"<id, optional>","effect":"supports|contradicts|neutral","strength":"high|medium|low","rationale":"<one sentence>"}]}',
        // AIC-119 slice E: the model was never told this rule exists, and the
        // refusal for a fabricated id already lands three rows below. Naming
        // an evidenceId, hypothesisId or predictionId not shown in the state
        // below is refused.
        'Every assessment must name an evidenceId, hypothesisId and, if present, a predictionId shown in the state below; naming any other id is refused.',
        JSON_ONLY,
      ].join('\n'),
      prompt: `prompt-version: ${promptVersion}\n\n${describeState(state)}`,
      maxOutputTokens,
      outputSchema: ASSESSMENTS_SCHEMA,
    });

    refuseTruncated(role, completion);
    const document = parseJsonDocument(role, completion.text);
    const stampedAt = at();
    const assessments: EvidenceAssessment[] = ownArray(
      role,
      document,
      'assessments',
    ).map((candidate) => {
      // Provenance is refused rather than overwritten: a model that supplied
      // `producedBy` was answering a question this layer never asked, and
      // silently replacing the value would hide that it tried.
      for (const stamped of ['producedBy', 'promptVersion', 'at']) {
        if (ownValue(candidate, stamped) !== undefined) {
          throw new ModelRoleOutputError(
            role,
            `an assessment may not declare ${stamped}; this layer stamps provenance`,
          );
        }
      }
      // 🔴 `null` is absent for an OPTIONAL field, because that is how a JSON
      // author spells "no value" — and this role's own prompt asks for
      // `"predictionId":"<id, optional>"`. Treating only `undefined` as absent
      // sent the model's `null` into the schema, which refused it, and the lane
      // then recorded the model arm unreportable for a contract the model was
      // never told about. Measured on a real calibration run.
      //
      // This does not widen the schema: a `null` in a REQUIRED field still
      // reaches it and is still refused.
      // see roles-model-nodes.test.mjs › "reads null as absent for an optional assessment field, as any JSON author would write it"
      // see roles-model-nodes.test.mjs › "still refuses null in a required assessment field"
      const declaredPredictionId = ownValue(candidate, 'predictionId');
      const predictionId =
        declaredPredictionId === null ? undefined : declaredPredictionId;
      const assessment = parseWith(role, EvidenceAssessmentSchema, {
        id: ownValue(candidate, 'id'),
        evidenceId: ownValue(candidate, 'evidenceId'),
        hypothesisId: ownValue(candidate, 'hypothesisId'),
        ...(predictionId === undefined ? {} : { predictionId }),
        effect: ownValue(candidate, 'effect'),
        strength: ownValue(candidate, 'strength'),
        rationale: ownValue(candidate, 'rationale'),
        producedBy: 'llm',
        promptVersion,
        at: stampedAt,
      });

      // 🔴 A fabricated evidenceId/hypothesisId/predictionId is a
      // model-quality failure and is refused HERE, not left to surface later
      // as a plain, untyped `Error` out of `deriveHypothesisStatus`
      // (`packages/domain/src/evaluation.ts`) when `propose_conclusion` reads
      // this assessment — that misattributes a model fault as a harness fault,
      // exactly what `ModelRoleOutputError` exists to prevent.
      // see roles-model-nodes.test.mjs › "refuses an assessment whose evidenceId is not in state.evidence"
      // see roles-model-nodes.test.mjs › "refuses an assessment whose hypothesisId is not in state.hypotheses"
      // see roles-model-nodes.test.mjs › "refuses an assessment whose predictionId is not a prediction of the named hypothesis"
      // see roles-model-nodes.test.mjs › "escapes and truncates a hostile hypothesisId before it reaches the refusal message"
      if (!state.evidence.some(({ id }) => id === assessment.evidenceId)) {
        throw new ModelRoleOutputError(
          role,
          `an assessment cites evidence the run does not carry: ${quoteModelText(assessment.evidenceId)}`,
        );
      }
      if (!state.hypotheses.some(({ id }) => id === assessment.hypothesisId)) {
        throw new ModelRoleOutputError(
          role,
          `an assessment names a hypothesis the run does not carry: ${quoteModelText(assessment.hypothesisId)}`,
        );
      }
      if (
        assessment.predictionId !== undefined &&
        !state.predictions.some(
          (prediction) =>
            prediction.id === assessment.predictionId &&
            prediction.hypothesisId === assessment.hypothesisId,
        )
      ) {
        throw new ModelRoleOutputError(
          role,
          `an assessment names a predictionId that is not a prediction of hypothesis ${quoteModelText(
            assessment.hypothesisId,
          )}: ${quoteModelText(assessment.predictionId)}`,
        );
      }

      return assessment;
    });

    return { assessments, declaredLlmCalls: 1 };
  };
}

/**
 * `challenge_hypothesis`, backed by the model.
 *
 * Refuses an "alternative" that is the challenged hypothesis wearing a new id:
 * a challenge round that restates the leader spends a round and changes nothing,
 * and `evaluateChallengeEffect` would read the restatement as a challenge having
 * happened.
 * see roles-model-nodes.test.mjs › "refuses a challenge whose alternative repeats
 * the hypothesis it was asked to challenge"
 */
export function createModelChallengeHypothesis({
  port,
  execution,
  promptVersion = REFERENCE_PROMPT_VERSION,
  maxOutputTokens = DEFAULT_MAX_OUTPUT_TOKENS,
}: ModelRoleOptions): (
  state: IncidentState,
  leaderId: string,
) => Promise<ChallengeResult> {
  const role = 'challenge_hypothesis';
  return async (state, leaderId) => {
    const leader = state.hypotheses.find(({ id }) => id === leaderId);
    const completion = await completeOnce({ port, execution, promptVersion }, role, state, {
      system: [
        'You are a red-team reviewer challenging the leading explanation of an incident.',
        'Propose ONE genuinely different alternative cause, and tests that discriminate between it and the leader.',
        'Answer shape: {"alternative":{"id":"<stable id>","statement":"<one sentence>"},"discriminatingTests":[{"id":"<id>","predictionId":"<id>","tool":"<tool id>","input":{},"cost":"cheap|medium|expensive"}]}',
        JSON_ONLY,
      ].join('\n'),
      prompt: [
        `prompt-version: ${promptVersion}`,
        `leading hypothesis: ${leader?.statement ?? leaderId}`,
        '',
        describeState(state),
      ].join('\n'),
      maxOutputTokens,
      outputSchema: CHALLENGE_SCHEMA,
    });

    refuseTruncated(role, completion);
    const document = parseJsonDocument(role, completion.text);
    const candidate = ownValue(document, 'alternative');
    const alternative = parseWith(role, HypothesisSchema, {
      id: ownValue(candidate, 'id'),
      statement: ownValue(candidate, 'statement'),
      createdBy: 'challenge',
    });
    if (alternative.id === leaderId || alternative.statement === leader?.statement) {
      throw new ModelRoleOutputError(
        role,
        'the alternative restates the hypothesis it was asked to challenge',
      );
    }

    const discriminatingTests: InvestigationTest[] = ownArray(
      role,
      document,
      'discriminatingTests',
    ).map((test) =>
      parseWith(role, InvestigationTestSchema, {
        id: ownValue(test, 'id'),
        predictionId: ownValue(test, 'predictionId'),
        tool: ownValue(test, 'tool'),
        input: ownValue(test, 'input'),
        cost: ownValue(test, 'cost'),
        status: 'planned',
      }),
    );

    // 🔴 An empty list is a MODEL-QUALITY failure, and it is refused HERE so it
    // is reported as one.
    //
    // The graph refuses it too — `parseChallengeResult` rejects the shape — but
    // with a generic `invalid challenge result`, which reads as a harness fault.
    // That is the confusion `model-errors.ts` exists to prevent and the whole
    // point of this item: a challenge that names no way to tell the two
    // hypotheses apart is the model failing at the task, not the harness
    // failing at its contract. Found by `code-reviewer` at the AIC-94 gate.
    // see roles-model-nodes.test.mjs › "refuses a challenge carrying no
    // discriminating test in the role, where a model-quality failure belongs"
    if (discriminatingTests.length === 0) {
      throw new ModelRoleOutputError(
        role,
        'the challenge names no discriminating test, so nothing separates the alternative from the hypothesis it challenges',
      );
    }

    return { alternative, discriminatingTests };
  };
}

/**
 * `propose_conclusion`'s answer shape, as a schema the PROVIDER enforces
 * (AIC-119 slice D). Derived from the domain schemas the same way the three
 * schemas above are: every object is `additionalProperties: false`, `kind`'s
 * enum comes from `IncidentConclusionSchema` and `mechanism`'s from the
 * caller-supplied vocabulary, never restated by hand.
 * see conclusion-role.test.mjs › "produces a 'root-cause' conclusion the domain schema accepts and declares the call it made"
 */
function proposeConclusionSchema(mechanisms: readonly string[]) {
  return Object.freeze({
    type: 'object',
    properties: {
      kind: { type: 'string', enum: enumOf(IncidentConclusionSchema, 'kind') },
      causes: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            hypothesisId: { type: 'string' },
            cause: {
              type: 'object',
              properties: {
                component: { type: 'string' },
                mechanism: { type: 'string', enum: [...mechanisms] },
                trigger: { type: 'string' },
              },
              required: ['component', 'mechanism'],
              additionalProperties: false,
            },
            evidenceIds: { type: 'array', items: { type: 'string' } },
          },
          required: ['hypothesisId', 'cause', 'evidenceIds'],
          additionalProperties: false,
        },
      },
    },
    required: ['kind', 'causes'],
    additionalProperties: false,
  });
}

// Derived from the domain schemas rather than restated, like naive-role.ts's
// identical constants: a widened domain field must not be refused here as
// though the model had invented it.
const CONCLUSION_KEYS: ReadonlySet<string> = new Set(Object.keys(IncidentConclusionSchema.shape));
const CAUSE_KEYS: ReadonlySet<string> = new Set(Object.keys(CauseClaimSchema.shape));
const CAUSE_DESCRIPTION_KEYS: ReadonlySet<string> = new Set(
  Object.keys(CauseClaimSchema.shape.cause.shape),
);

export interface ModelProposeConclusionOptions extends ModelRoleOptions {
  /** The closed root-cause mechanism vocabulary a cause must be classified in. */
  readonly mechanisms: readonly string[];
}

/**
 * `propose_conclusion`, backed by the model (AIC-119 slice D): the
 * evidence-constrained conclusion role that closes an investigation.
 *
 * Every value crosses the same gate a hand-composed conclusion would:
 * `IncidentConclusionSchema`, the supplied mechanism vocabulary, and
 * `conclusionViolation` (`@aic/domain`) — the rule `naive-role.ts`'s
 * `requireCauseCount` and this role now both delegate to
 * (`.claude/rules/invariants.md`, "one mechanism, one implementation").
 * There is no retry: a refused answer is the role's measured result, exactly
 * like every other model-backed role here.
 *
 * Validation runs in this order, each failure a `ModelRoleOutputError`:
 * (1) a truncated completion, (2) unparseable JSON, (3) an unknown key at
 * any level, (4) an own-read rebuild that does not satisfy
 * `IncidentConclusionSchema`, (5) a cause mechanism outside the supplied
 * vocabulary, (6) `conclusionViolation`.
 * see conclusion-role.test.mjs › "refuses a truncated completion as a truncation, not as malformed output (refusal 1)"
 * see conclusion-role.test.mjs › "refuses an answer that carries no JSON document at all (refusal 2)"
 * see conclusion-role.test.mjs › "refuses an unknown key on the top-level answer, on a cause, and on a cause description (refusal 3)"
 * see conclusion-role.test.mjs › "refuses an answer the domain schema does not accept, once rebuilt from its own properties (refusal 4)"
 * see conclusion-role.test.mjs › "refuses a cause mechanism outside the supplied vocabulary (refusal 5)"
 * see conclusion-role.test.mjs › "refuses a cause naming a hypothesis the state does not carry, via conclusionViolation (refusal 6)"
 *
 * The prompt shows the model `describeState`'s usual projection, plus the
 * mechanism vocabulary (worded exactly as `naive-role.ts` words it, so the
 * v0.2 evaluation's two arms read the same sentence), `control.stopKind` and
 * `control.challengeRounds` as context, and the derived status of every
 * hypothesis — computed with `deriveHypothesisStatus` (`@aic/domain`), the
 * same function the benchmark (`packages/evals/src/graph-benchmark.ts`) uses
 * — this role's only other production caller — so the model is shown the
 * run's own read of its hypotheses rather than a second, competing one.
 * see conclusion-role.test.mjs › "shows the model the mechanism vocabulary, exactly as naive-role's sentence reads, and the stop kind as context"
 * see conclusion-role.test.mjs › "shows a different prompt when challengeRounds differs, so the round count reaches the model as context"
 * see conclusion-role.test.mjs › "shows the derived status of every hypothesis, computed the same way deriveHypothesisStatus computes it"
 *
 * The mechanism vocabulary shapes the request (it is embedded in the JSON
 * schema `completeOnce` sends) but is not itself a `buildExecKey('model.role',
 * ...)` field, so a vocabulary change between a crash and a resume lands on
 * the same exec key with a different request — refused as an execution
 * integrity violation, the same as a changed `maxOutputTokens`
 * (`completeOnce`'s own doc, below), never silently reused.
 */
export function createModelProposeConclusion(
  options: ModelProposeConclusionOptions,
): (state: IncidentState) => Promise<InvestigationNodeResult> {
  const { port, execution, mechanisms } = options;
  const promptVersion = options.promptVersion ?? REFERENCE_PROMPT_VERSION;
  const maxOutputTokens = options.maxOutputTokens ?? DEFAULT_MAX_OUTPUT_TOKENS;
  const role = 'propose_conclusion';
  const vocabulary = Object.freeze([...mechanisms]);
  const outputSchema = proposeConclusionSchema(vocabulary);

  return async (state) => {
    // 🔴 An ABSENT `stopKind` is a graph invariant violation, not a model
    // refusal: `terminate()` always stamps `control.stopKind` before routing
    // here, so its absence means the harness reached this role wrongly, and
    // reporting it as a `ModelRoleOutputError` would blame the model for a
    // fault it had no chance to cause. Checked BEFORE any port call — asking
    // the model to compose a conclusion the harness cannot even validate
    // afterward would spend a call on a run that was never going to get an
    // answer through.
    // see conclusion-role.test.mjs › "throws a plain harness Error naming stopKind when state.control.stopKind is absent, before any port call"
    const stopKind = state.control.stopKind;
    if (stopKind === undefined) {
      throw new Error(
        'propose_conclusion: state.control.stopKind is absent; terminate() must stamp it before routing to this role',
      );
    }

    // 🔴 AIC-119 slice E: an assessment naming evidence, a hypothesis, or a
    // prediction the run does not carry is a STATE/HARNESS fault, not a model
    // refusal — `interpret_residual_evidence` already validates this at write
    // time (three rows above in `roles-model-nodes.test.mjs`), so an
    // assessment failing this check here means it was written before that
    // validation existed (a checkpoint resumed across the boundary #127 added).
    // Checked before `deriveHypothesisStatus` and before any port call, for
    // the same reason the `stopKind` guard above is. For an unknown evidenceId
    // or a prediction outside its hypothesis, `deriveHypothesisStatus`
    // (`packages/domain/src/evaluation.ts`) throws its own plain
    // `Error`; an unknown hypothesisId it would silently filter out, so that
    // branch is a refusal of its own rather than a pre-emption. Asking the model to compose a
    // conclusion the harness cannot even validate would spend a call on a run
    // that was never going to get an answer through.
    // see conclusion-role.test.mjs › "an assessment naming evidence the run does not carry throws a plain (non-ModelRoleOutputError) Error before any port call, with no raw newline from a hostile id"
    // see conclusion-role.test.mjs › "an assessment naming a hypothesisId the state does not carry throws a plain (non-ModelRoleOutputError) Error before any port call, with no raw newline from a hostile id"
    // see conclusion-role.test.mjs › "an assessment naming a predictionId that is not a prediction of its hypothesis throws a plain (non-ModelRoleOutputError) Error before any port call, with no raw newline from a hostile id"
    for (const assessment of state.assessments) {
      if (!state.evidence.some(({ id }) => id === assessment.evidenceId)) {
        throw new Error(
          `propose_conclusion: state.assessments cites evidence the run does not carry: ${quoteModelText(assessment.evidenceId)}`,
        );
      }
      if (!state.hypotheses.some(({ id }) => id === assessment.hypothesisId)) {
        throw new Error(
          `propose_conclusion: state.assessments names a hypothesis the run does not carry: ${quoteModelText(assessment.hypothesisId)}`,
        );
      }
      if (
        assessment.predictionId !== undefined &&
        !state.predictions.some(
          (prediction) =>
            prediction.id === assessment.predictionId &&
            prediction.hypothesisId === assessment.hypothesisId,
        )
      ) {
        throw new Error(
          `propose_conclusion: state.assessments names a predictionId that is not a prediction of hypothesis ${quoteModelText(
            assessment.hypothesisId,
          )}: ${quoteModelText(assessment.predictionId)}`,
        );
      }
    }

    const hypothesisStatuses = state.hypotheses.map((hypothesis) => ({
      id: hypothesis.id,
      status: deriveHypothesisStatus({
        hypothesisId: hypothesis.id,
        predictions: state.predictions,
        assessments: state.assessments,
        evidence: state.evidence,
      }),
    }));

    const completion = await completeOnce({ port, execution, promptVersion }, role, state, {
      system: [
        'You are an incident investigator composing the final conclusion from the investigation gathered so far.',
        'A conclusion is root-cause (exactly one cause), multiple-causes (two or more), inconclusive or no-incident (no cause). Cite evidence only by the ids shown, and hypotheses only by ids shown.',
        `Classify each cause's mechanism as one of: ${vocabulary.join(', ')}.`,
        JSON_ONLY,
      ].join('\n'),
      prompt: [
        `prompt-version: ${promptVersion}`,
        `stop kind: ${stopKind}`,
        `challenge rounds so far: ${state.control.challengeRounds}`,
        `derived hypothesis statuses: ${JSON.stringify(hypothesisStatuses)}`,
        '',
        describeState(state),
      ].join('\n'),
      maxOutputTokens,
      outputSchema,
    });

    refuseTruncated(role, completion);
    const document = parseJsonDocument(role, completion.text);

    refuseUnknownKeys(role, document, CONCLUSION_KEYS, 'the conclusion');
    const conclusion = parseWith(role, IncidentConclusionSchema, {
      kind: ownValue(document, 'kind'),
      causes: ownArray(role, document, 'causes').map((cause) => {
        refuseUnknownKeys(role, cause, CAUSE_KEYS, 'a cause');
        const claimed = ownValue(cause, 'cause');
        refuseUnknownKeys(role, claimed, CAUSE_DESCRIPTION_KEYS, "a cause's description");
        return {
          hypothesisId: ownValue(cause, 'hypothesisId'),
          // An own key even when absent, so the schema cannot read an
          // inherited trigger through a key the rebuild left out.
          cause: {
            component: ownValue(claimed, 'component'),
            mechanism: ownValue(claimed, 'mechanism'),
            trigger: ownValue(claimed, 'trigger'),
          },
          evidenceIds: ownValue(cause, 'evidenceIds'),
        };
      }),
    });
    for (const { cause } of conclusion.causes) {
      if (cause.trigger === undefined) delete (cause as { trigger?: string }).trigger;
    }

    for (const { cause } of conclusion.causes) {
      if (!vocabulary.includes(cause.mechanism)) {
        throw new ModelRoleOutputError(
          role,
          `a cause's mechanism is outside the supplied vocabulary: ${quoteModelText(cause.mechanism)}`,
        );
      }
    }

    const reason = conclusionViolation({
      conclusion,
      hypotheses: state.hypotheses,
      evidence: state.evidence,
      stopKind,
    });
    if (reason !== undefined) {
      throw new ModelRoleOutputError(role, reason);
    }

    return { conclusion, declaredLlmCalls: 1 };
  };
}
