import {
  CauseClaimSchema,
  EvidenceAssessmentSchema,
  IncidentConclusionSchema,
  type EvidenceAssessment,
  type IncidentConclusion,
} from '@aic/domain';

import { ModelRoleOutputError } from './model-errors.js';
import type { ModelPort } from './reference-model-port.js';
import { ownValue } from './own-value.js';
import {
  DEFAULT_MAX_OUTPUT_TOKENS,
  JSON_ONLY,
  enumOf,
  ownArray,
  parseJsonDocument,
  parseWith,
  refuseTruncated,
} from './role-output.js';

/**
 * The NAIVE single-prompt role: the lower baseline for the question the v0.2
 * evaluation exists to answer — does the investigation graph make the same
 * model better than one prompt over the same telemetry?
 *
 * One completion per run. No tools, no graph, no challenge, no repair round: a
 * refused answer is the arm's measured result, never retried and never turned
 * into a zero-filled answer.
 * see naive-role.test.mjs › "does not retry when the answer is refused: the port is still called exactly once"
 *
 * It depends on no orchestration code: dependency-cruiser refuses an import of
 * the graph from this file, directly or through a module it imports.
 * see naive-role.test.mjs › "rejects packages/roles/src/naive-role.ts importing @aic/graph"
 * see naive-role.test.mjs › "rejects packages/roles/src/naive-role.ts reaching the graph through a module it imports"
 *
 * Sampling: no temperature is sent. `ModelCompletionRequest` carries no
 * sampling field, so neither this role nor the graph's roles can send one, and
 * both arms run the provider's default sampling alike. Why the item's
 * "temperature 0" is not honoured is recorded on AIC-115.
 * see naive-role.test.mjs › "sends no temperature field, so the naive arm samples exactly as the graph arm does"
 */
export const NAIVE_PROMPT_VERSION = 'naive-single-prompt-v0.1' as const;

/**
 * The stops one call can honestly report. `budget-exhausted` and `human-stop`
 * belong to a graph's lifecycle — a single call has no budget loop and no human
 * in it — so an answer claiming either is refused.
 */
export const NAIVE_STOP_KINDS = Object.freeze([
  'sufficient',
  'ambiguous',
  'stalled',
  'tools-unavailable',
] as const);

export type NaiveStopKind = (typeof NAIVE_STOP_KINDS)[number];

export interface NaiveEvidence {
  readonly id: string;
  readonly kind: string;
  readonly source: string;
  readonly observedAt: string;
  readonly statement: string;
}

/** One tool call's result, in the order the graph arm would receive it. */
export type NaiveTelemetryEntry =
  | Readonly<{ status: 'ok'; tool: string; input: unknown; evidence: readonly NaiveEvidence[] }>
  | Readonly<{ status: 'unavailable'; tool: string; input: unknown; reason: string }>
  | Readonly<{ status: 'error'; tool: string; input: unknown; message: string }>;

export interface NaiveInvestigationInput {
  readonly incidentId: string;
  readonly entries: readonly NaiveTelemetryEntry[];
}

export interface NaiveAnswer {
  readonly hypotheses: readonly Readonly<{ id: string; statement: string }>[];
  readonly assessments: readonly Readonly<{
    evidenceId: string;
    hypothesisId: string;
    effect: EvidenceAssessment['effect'];
  }>[];
  readonly conclusion: IncidentConclusion;
  readonly stopKind: NaiveStopKind;
}

export interface NaiveRoleOptions {
  readonly port: ModelPort;
  /** The closed root-cause mechanism vocabulary a cause must be classified in. */
  readonly mechanisms: readonly string[];
  readonly promptVersion?: string;
  readonly maxOutputTokens?: number;
}

const ROLE = 'naive_investigation';

function answerSchema(mechanisms: readonly string[]) {
  return Object.freeze({
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
      assessments: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            evidenceId: { type: 'string' },
            hypothesisId: { type: 'string' },
            effect: { type: 'string', enum: enumOf(EvidenceAssessmentSchema, 'effect') },
          },
          required: ['evidenceId', 'hypothesisId', 'effect'],
          additionalProperties: false,
        },
      },
      conclusion: {
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
      },
      stopKind: { type: 'string', enum: [...NAIVE_STOP_KINDS] },
    },
    required: ['hypotheses', 'assessments', 'conclusion', 'stopKind'],
    additionalProperties: false,
  });
}

/**
 * The telemetry as the model sees it: each entry in the order given, an `ok`
 * entry with only the five named evidence fields, and an unavailable or failed
 * call with its tool, input and reason — missing data is information.
 */
function describeTelemetry({ incidentId, entries }: NaiveInvestigationInput): string {
  return JSON.stringify(
    {
      incident: { id: incidentId },
      telemetry: entries.map((entry) => {
        if (entry.status === 'ok') {
          return {
            status: 'ok',
            tool: entry.tool,
            input: entry.input,
            evidence: entry.evidence.map(({ id, kind, source, observedAt, statement }) => ({
              id,
              kind,
              source,
              observedAt,
              statement,
            })),
          };
        }
        return entry.status === 'unavailable'
          ? { status: 'unavailable', tool: entry.tool, input: entry.input, reason: entry.reason }
          : { status: 'error', tool: entry.tool, input: entry.input, message: entry.message };
      }),
    },
    null,
    2,
  );
}

function refuse(reason: string): never {
  throw new ModelRoleOutputError(ROLE, reason);
}

// Derived from the domain schemas rather than restated: a widened domain field
// must not be refused here as though the model had invented it.
const CONCLUSION_KEYS: ReadonlySet<string> = new Set(Object.keys(IncidentConclusionSchema.shape));
const CAUSE_KEYS: ReadonlySet<string> = new Set(Object.keys(CauseClaimSchema.shape));
const CAUSE_DESCRIPTION_KEYS: ReadonlySet<string> = new Set(
  Object.keys(CauseClaimSchema.shape.cause.shape),
);

const NAMED_KEYS_CAP = 5;

function refuseUnknownKeys(value: unknown, allowed: ReadonlySet<string>, where: string): void {
  if (value === null || typeof value !== 'object') return;
  const unknown = Object.keys(value).filter((key) => !allowed.has(key));
  if (unknown.length === 0) return;
  // The keys are the model's own text: each is named escaped, and only the
  // first few, so a hostile answer cannot shape or flood the message.
  const named = unknown.slice(0, NAMED_KEYS_CAP).map((key) => JSON.stringify(key.slice(0, 80)));
  const rest = unknown.length - named.length;
  refuse(
    `${where} carries keys the answer shape does not declare: ${named.join(', ')}${rest > 0 ? ` and ${rest} more` : ''}`,
  );
}

function requireCauseCount(conclusion: IncidentConclusion): void {
  const count = conclusion.causes.length;
  if ((conclusion.kind === 'no-incident' || conclusion.kind === 'inconclusive') && count !== 0) {
    refuse(`a ${conclusion.kind} conclusion names no cause, and this one names ${count}`);
  }
  if (conclusion.kind === 'root-cause' && count !== 1) {
    refuse(`a root-cause conclusion names exactly one cause, and this one names ${count}`);
  }
  if (conclusion.kind === 'multiple-causes' && count < 2) {
    refuse(`a multiple-causes conclusion names at least two causes, and this one names ${count}`);
  }
}

export function createModelNaiveInvestigation(
  options: NaiveRoleOptions,
): (input: NaiveInvestigationInput) => Promise<NaiveAnswer> {
  const { port } = options;
  const promptVersion = options.promptVersion ?? NAIVE_PROMPT_VERSION;
  const outputBudget = options.maxOutputTokens ?? DEFAULT_MAX_OUTPUT_TOKENS;
  const vocabulary = Object.freeze([...options.mechanisms]);
  const outputSchema = answerSchema(vocabulary);

  return async (input) => {
    const completion = await port.complete({
      system: [
        'You are an incident investigator. You are given every piece of telemetry collected for one incident, including the calls that returned nothing.',
        'Propose the candidate explanations, say how each piece of evidence bears on them, conclude, and say why you stopped.',
        'A conclusion is root-cause (exactly one cause), multiple-causes (two or more), inconclusive or no-incident (no cause). Cite evidence only by the ids shown, and hypotheses only by ids you declared.',
        `Classify each cause's mechanism as one of: ${vocabulary.join(', ')}.`,
        `Stop kinds: ${NAIVE_STOP_KINDS.join(', ')}.`,
        JSON_ONLY,
      ].join('\n'),
      prompt: `prompt-version: ${promptVersion}\n\n${describeTelemetry(input)}`,
      maxOutputTokens: outputBudget,
      outputSchema,
    });

    refuseTruncated(ROLE, completion);
    const document = parseJsonDocument(ROLE, completion.text);

    const shownEvidenceIds = new Set(
      input.entries.flatMap((entry) =>
        entry.status === 'ok' ? entry.evidence.map(({ id }) => id) : [],
      ),
    );

    const hypotheses = ownArray(ROLE, document, 'hypotheses').map((candidate) => {
      const id = ownValue(candidate, 'id');
      const statement = ownValue(candidate, 'statement');
      if (typeof id !== 'string' || id.length === 0 || typeof statement !== 'string') {
        refuse('every hypothesis carries a non-empty string id and a string statement');
      }
      return { id, statement };
    });
    const hypothesisIds = new Set<string>();
    for (const { id } of hypotheses) {
      if (hypothesisIds.has(id)) refuse(`declared hypothesis id ${id} twice`);
      hypothesisIds.add(id);
    }

    const effects: readonly string[] = enumOf(EvidenceAssessmentSchema, 'effect');
    const assessments = ownArray(ROLE, document, 'assessments').map((candidate) => {
      const evidenceId = ownValue(candidate, 'evidenceId');
      const hypothesisId = ownValue(candidate, 'hypothesisId');
      const effect = ownValue(candidate, 'effect');
      if (typeof evidenceId !== 'string' || !shownEvidenceIds.has(evidenceId)) {
        refuse(`an assessment names evidence that was not shown: ${String(evidenceId)}`);
      }
      if (typeof hypothesisId !== 'string' || !hypothesisIds.has(hypothesisId)) {
        refuse(`an assessment names a hypothesis the answer did not declare: ${String(hypothesisId)}`);
      }
      if (typeof effect !== 'string' || !effects.includes(effect)) {
        refuse(`an assessment carries an effect outside the domain's: ${String(effect)}`);
      }
      return { evidenceId, hypothesisId, effect: effect as EvidenceAssessment['effect'] };
    });

    // Rebuilt from own reads so the schema never reads an inherited field as
    // the model's answer, and every unknown own key refused, so the rebuild
    // keeps the strictness the domain schema would have applied to the raw
    // object.
    // see naive-role.test.mjs › "reads the conclusion only from what the answer owns, never from Object.prototype"
    // see naive-role.test.mjs › "refuses an unknown key on the conclusion, on a cause, and on a cause description"
    const declared = ownValue(document, 'conclusion');
    refuseUnknownKeys(declared, CONCLUSION_KEYS, 'the conclusion');
    const conclusion = parseWith(ROLE, IncidentConclusionSchema, {
      kind: ownValue(declared, 'kind'),
      causes: ownArray(ROLE, declared, 'causes').map((cause) => {
        refuseUnknownKeys(cause, CAUSE_KEYS, 'a cause');
        const claimed = ownValue(cause, 'cause');
        refuseUnknownKeys(claimed, CAUSE_DESCRIPTION_KEYS, "a cause's description");
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
    for (const { hypothesisId, cause, evidenceIds } of conclusion.causes) {
      if (!hypothesisIds.has(hypothesisId)) {
        refuse(`a cause names a hypothesis the answer did not declare: ${hypothesisId}`);
      }
      const unshown = evidenceIds.find((evidenceId) => !shownEvidenceIds.has(evidenceId));
      if (unshown !== undefined) refuse(`a cause cites evidence that was not shown: ${unshown}`);
      if (!vocabulary.includes(cause.mechanism)) {
        refuse(`a cause's mechanism is outside the vocabulary: ${cause.mechanism}`);
      }
    }
    requireCauseCount(conclusion);

    const stopKind = ownValue(document, 'stopKind');
    if (typeof stopKind !== 'string' || !(NAIVE_STOP_KINDS as readonly string[]).includes(stopKind)) {
      refuse(`the stop kind is not one a single call can report: ${String(stopKind)}`);
    }

    return { hypotheses, assessments, conclusion, stopKind: stopKind as NaiveStopKind };
  };
}
