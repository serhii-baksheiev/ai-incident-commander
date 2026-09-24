import type {
  NaiveAnswer,
  NaiveInvestigationInput,
  NaiveTelemetryEntry,
} from '@aic/roles/naive';

import { outcomeFromArmAnswer } from './arm-answer.js';
import {
  opaqueIncidentId,
  runBenchmarkExperiment,
  type BenchmarkExecutionInput,
  type BenchmarkExperiment,
  type NotApplicableMetrics,
} from './benchmark-evaluation.js';

/**
 * The NAIVE arm's benchmark runner: one prompt per run over the same telemetry
 * the graph arm replays, scored by the same evaluators through the same
 * answer projection as every other non-graph arm.
 *
 * It reaches no orchestration code: dependency-cruiser refuses an import of the
 * graph from this file, directly or through anything it imports.
 * see naive-arm.test.mjs › "rejects packages/evals/src/naive-arm.ts reaching the graph transitively through ./graph-benchmark.js"
 *
 * The role it drives sees `naiveInputFor(input)` only — never the scenario, its
 * id, its ground truth or the record's metadata.
 * see naive-arm.test.mjs › "keeps scenario ground truth outside the naive investigation callback, over the calibration plan"
 */

/**
 * What the naive arm cannot be scored on, and why. A single prompt runs no
 * challenge round, so there is no leader before or after a challenge to
 * compare: challenge_effect is not applicable to this arm, which is a different
 * statement from a score of zero.
 */
export const NAIVE_NOT_APPLICABLE: NotApplicableMetrics = Object.freeze({
  challenge_effect:
    'not applicable: the naive arm answers in one prompt and runs no challenge round, so there is no leader before or after a challenge to compare',
});

/**
 * The naive role's input for one benchmark run: the opaque incident id and each
 * fixture entry, in order, as the telemetry the graph arm would replay.
 */
export function naiveInputFor(input: BenchmarkExecutionInput): NaiveInvestigationInput {
  const entries: NaiveTelemetryEntry[] = input.fixture.entries.map(({ toolId, input: toolInput, result }) => {
    if (result.status === 'ok') {
      return { status: 'ok', tool: toolId, input: toolInput, evidence: result.output };
    }
    return result.status === 'unavailable'
      ? { status: 'unavailable', tool: toolId, input: toolInput, reason: result.reason }
      : { status: 'error', tool: toolId, input: toolInput, message: result.message };
  });
  return { incidentId: opaqueIncidentId(input.runId), entries };
}

// Distributive, so the scenario-set union survives: a plain `Omit` over a
// union collapses it, and `'ad-hoc'` would lose its required `scenarios`.
type OmitEach<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;
type NaiveExperimentOptions = OmitEach<
  Parameters<typeof runBenchmarkExperiment>[0],
  'investigate' | 'collectResources' | 'notApplicable'
> &
  Readonly<{
    investigate(input: NaiveInvestigationInput): Promise<NaiveAnswer>;
  }>;

export async function runNaiveBenchmarkExperiment(
  options: NaiveExperimentOptions,
): Promise<BenchmarkExperiment> {
  const naive = options.investigate;
  return runBenchmarkExperiment({
    ...options,
    notApplicable: NAIVE_NOT_APPLICABLE,
    async investigate(input) {
      // One call per run. A refusal propagates, and the run records nothing.
      const answer = await naive(naiveInputFor(input));
      return outcomeFromArmAnswer({ answer, fixture: input.fixture });
    },
  });
}
