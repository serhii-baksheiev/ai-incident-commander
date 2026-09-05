import {
  EvidenceAssessmentSchema,
  HypothesisSchema,
  InvestigationTestSchema,
  type EvidenceAssessment,
  type Hypothesis,
  type IncidentState,
  type InvestigationTest,
} from '@aic/domain';
import type { ChallengeResult, InvestigationNodeResult } from '@aic/graph';

import { ModelRoleOutputError } from './model-errors.js';
import type { ModelPort } from './reference-model-port.js';
import { ownValue } from './own-value.js';

/**
 * Three investigation roles, backed by a reference model through a
 * provider-neutral port.
 *
 * ## What this layer decides and what the model decides
 *
 * The model proposes CONTENT — which hypotheses, which effect, which
 * discriminating test. Everything that is a CLAIM ABOUT PROVENANCE OR LIFECYCLE
 * is stamped here and is refused if the model supplies it: `createdBy`,
 * `producedBy`, `promptVersion`, `at`, and a test's `status`. A model that could
 * write `producedBy: 'rule'` could label its own output as rule-derived, which
 * is exactly the confound the evaluation exists to separate.
 * see roles-model-nodes.test.mjs › "refuses an assessment that claims a rule
 * produced it"
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
 *   - **The answer is JSON in text, not a provider structured-output feature.**
 *     A structured-output request is a second wire shape this repository cannot
 *     exercise without a credential, so the roles ask for JSON and parse it
 *     tolerantly — first `{` to last `}`, one forward scan.
 *     see roles-model-nodes.test.mjs › "reads a JSON answer the model wrapped in
 *     prose or a fenced block"
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

/** The prompt set this module ships, versioned so a run can record which it used. */
export const REFERENCE_PROMPT_VERSION = 'reference-roles-prompt-v0.2' as const;

const DEFAULT_MAX_OUTPUT_TOKENS = 4096;

export interface ModelRoleOptions {
  readonly port: ModelPort;
  readonly promptVersion?: string;
  readonly maxOutputTokens?: number;
  /** The clock, injected so an assessment's `at` is decidable in a test. */
  readonly at?: () => string;
}

const JSON_ONLY = 'Answer with one JSON document and nothing else. No prose, no code fence.';

/**
 * Pull the JSON document out of a completion.
 *
 * Bounded by construction: two index scans and one slice, no backtracking
 * regular expression over model-controlled text. A model that answers with prose
 * around the document is accommodated; one that answers with no document at all
 * is refused rather than defaulted.
 */
function parseJsonDocument(role: string, text: string): unknown {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start < 0 || end <= start) {
    throw new ModelRoleOutputError(role, 'the answer carries no JSON document');
  }
  try {
    return JSON.parse(text.slice(start, end + 1));
  } catch (cause) {
    throw new ModelRoleOutputError(
      role,
      `the answer is not parseable JSON: ${(cause as Error).message}`,
    );
  }
}

/** Read a caller-controlled array off an own property, or refuse. */
function ownArray(role: string, payload: unknown, key: string): readonly unknown[] {
  const value = ownValue(payload, key);
  if (!Array.isArray(value)) {
    throw new ModelRoleOutputError(role, `the answer declares no ${key} array`);
  }
  return value;
}

function parseWith<T>(
  role: string,
  schema: { parse(value: unknown): T },
  value: unknown,
): T {
  try {
    return schema.parse(value);
  } catch (cause) {
    throw new ModelRoleOutputError(role, (cause as Error).message);
  }
}

/**
 * The state the model is shown.
 *
 * A compact projection rather than the whole state: the control block carries
 * budgets and a run id the model has no business deciding from, and a prompt
 * that grows with every field added to `IncidentState` is a prompt whose version
 * silently changes meaning.
 */
function describeState(state: IncidentState): string {
  return JSON.stringify(
    {
      incident: state.incident,
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
  promptVersion = REFERENCE_PROMPT_VERSION,
  maxOutputTokens = DEFAULT_MAX_OUTPUT_TOKENS,
}: ModelRoleOptions): (
  state: IncidentState,
) => Promise<InvestigationNodeResult> {
  const role = 'generate_hypotheses';
  return async (state) => {
    const completion = await port.complete({
      system: [
        'You are an incident investigator proposing candidate explanations.',
        'Propose distinct, falsifiable causal hypotheses for the incident below.',
        `Answer shape: {"hypotheses":[{"id":"<stable id>","statement":"<one sentence>"}]}`,
        JSON_ONLY,
      ].join('\n'),
      prompt: `prompt-version: ${promptVersion}\n\n${describeState(state)}`,
      maxOutputTokens,
    });

    const document = parseJsonDocument(role, completion.text);
    const hypotheses: Hypothesis[] = ownArray(role, document, 'hypotheses').map(
      (candidate) =>
        parseWith(role, HypothesisSchema, {
          id: ownValue(candidate, 'id'),
          statement: ownValue(candidate, 'statement'),
          createdBy: 'initial',
        }),
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
  promptVersion = REFERENCE_PROMPT_VERSION,
  maxOutputTokens = DEFAULT_MAX_OUTPUT_TOKENS,
  at = () => new Date().toISOString(),
}: ModelRoleOptions): (
  state: IncidentState,
) => Promise<InvestigationNodeResult> {
  const role = 'interpret_residual_evidence';
  return async (state) => {
    const completion = await port.complete({
      system: [
        'You are an incident investigator reading evidence against hypotheses.',
        'For each piece of evidence that bears on a hypothesis, state the effect and how strongly.',
        'Answer shape: {"assessments":[{"id":"<stable id>","evidenceId":"<id>","hypothesisId":"<id>","predictionId":"<id, optional>","effect":"supports|contradicts|neutral","strength":"high|medium|low","rationale":"<one sentence>"}]}',
        JSON_ONLY,
      ].join('\n'),
      prompt: `prompt-version: ${promptVersion}\n\n${describeState(state)}`,
      maxOutputTokens,
    });

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
      const predictionId = ownValue(candidate, 'predictionId');
      return parseWith(role, EvidenceAssessmentSchema, {
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
  promptVersion = REFERENCE_PROMPT_VERSION,
  maxOutputTokens = DEFAULT_MAX_OUTPUT_TOKENS,
}: ModelRoleOptions): (
  state: IncidentState,
  leaderId: string,
) => Promise<ChallengeResult> {
  const role = 'challenge_hypothesis';
  return async (state, leaderId) => {
    const leader = state.hypotheses.find(({ id }) => id === leaderId);
    const completion = await port.complete({
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
    });

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

    return { alternative, discriminatingTests };
  };
}
