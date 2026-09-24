import {
  outcomeFromArmAnswer,
  shownEvidenceOf,
  type ArmAnswer,
} from './arm-answer.js';
import {
  runBenchmarkExperiment,
  type BenchmarkExperiment,
} from './benchmark-evaluation.js';
import type { ChallengeEffectObservation } from './behavior-evaluators.js';
import {
  REPLAY_SCENARIOS,
  type EvidenceFingerprint,
  type IncidentScenario,
} from './replay-scenarios.js';

/**
 * The ORACLE arm: a positive control that projects ground truth into an answer
 * without a graph, a model or a provider call.
 *
 * It exists to answer one question the model arms cannot: can the evaluator
 * score a run that knows the answer as best? A metric the oracle cannot bring
 * to its best value is a metric no model can be judged on, whatever it answers.
 *
 * 🔴 It is the ONLY arm allowed to read ground truth, and it is excluded from
 * every model-quality verdict. Two mechanisms keep it on the evaluator side:
 * the package root does not export it — it is reachable only as
 * `@aic/evals/oracle` — and dependency-cruiser refuses an import of this
 * module from anywhere under `packages/` or `apps/`, and of `@aic/evals`
 * itself from any package but evals and from any app.
 * see oracle-positive-control.test.mjs › "never exports the oracle arm from the
 * @aic/evals package root" and › "rejects packages/graph importing
 * @aic/evals/oracle"
 *
 * It answers in the same `ArmAnswer` shape a non-graph model arm answers in,
 * and may cite evidence only by the ids the fixture shows, exactly as a model
 * arm may. So it identifies an evidence item as expected or misleading only
 * through what the ground truth says about that item — today, a fingerprint
 * that equals the item's `{kind, source, statement}` — and where the ground
 * truth names no item that way, the oracle can cite nothing. That is the
 * measurement, not a defect of the oracle.
 * see oracle-positive-control.test.mjs › "oracleAnswerFor identifies no
 * evidence for bad-deployment, because no fixture statement equals the
 * ground-truth predicate"
 */
export const ORACLE_ARM = Object.freeze({
  arm: 'oracle',
  role: 'positive-control',
} as const);

const ROOT_CAUSE_HYPOTHESIS_ID = 'oracle-root-cause';
const INITIAL_LEADER_HYPOTHESIS_ID = 'oracle-initial-leader';

// A deliberately separate spelling of fingerprint equality, not an import of
// the evaluators' own: a positive control that asked the evaluator what counts
// as a match would agree with it by construction and prove nothing.
function sameFingerprint(
  fingerprint: EvidenceFingerprint,
  evidence: Readonly<{ kind: string; source: string; statement: string }>,
): boolean {
  return (
    fingerprint.kind === evidence.kind &&
    fingerprint.source === evidence.source &&
    fingerprint.predicate === evidence.statement
  );
}

function identifiedEvidenceIds(
  scenario: IncidentScenario,
  fingerprints: readonly EvidenceFingerprint[],
): string[] {
  return shownEvidenceOf(scenario.fixture)
    .filter((evidence) =>
      fingerprints.some((fingerprint) => sameFingerprint(fingerprint, evidence)),
    )
    .map(({ id }) => id);
}

export function oracleAnswerFor(scenario: IncidentScenario): Readonly<{
  answer: ArmAnswer;
  challengeEffect?: ChallengeEffectObservation;
}> {
  const { groundTruth } = scenario;
  const expectedIds = identifiedEvidenceIds(scenario, groundTruth.expectedEvidence);
  const misleadingIds = identifiedEvidenceIds(
    scenario,
    groundTruth.misleadingEvidence ?? [],
  );
  const { rootCause } = groundTruth;
  const leaderChanges = groundTruth.expectedLeaderChangeAfterChallenge;

  const hypotheses =
    rootCause === undefined
      ? []
      : [
          ...(leaderChanges === true
            ? [{ id: INITIAL_LEADER_HYPOTHESIS_ID, statement: 'the leader before the challenge' }]
            : []),
          {
            id: ROOT_CAUSE_HYPOTHESIS_ID,
            statement: `${rootCause.component}: ${rootCause.mechanism}`,
          },
        ];

  const answer: ArmAnswer = {
    hypotheses,
    assessments:
      rootCause === undefined
        ? []
        : [
            ...expectedIds.map((evidenceId) => ({
              evidenceId,
              hypothesisId: ROOT_CAUSE_HYPOTHESIS_ID,
              effect: 'supports' as const,
            })),
            ...misleadingIds.map((evidenceId) => ({
              evidenceId,
              hypothesisId: ROOT_CAUSE_HYPOTHESIS_ID,
              effect: 'contradicts' as const,
            })),
          ],
    conclusion: {
      kind: groundTruth.expectedConclusionKind,
      causes:
        rootCause === undefined
          ? []
          : [{
              hypothesisId: ROOT_CAUSE_HYPOTHESIS_ID,
              cause: { ...rootCause },
              evidenceIds: expectedIds,
            }],
    },
    stopKind: groundTruth.expectedStopKind,
  };

  if (leaderChanges === undefined) return { answer };
  return {
    answer,
    challengeEffect: {
      challengeNodeExecuted: true,
      challengeInvocationCount: 1,
      leaderBeforeChallengeId: leaderChanges
        ? INITIAL_LEADER_HYPOTHESIS_ID
        : ROOT_CAUSE_HYPOTHESIS_ID,
      leaderAfterChallengeId: ROOT_CAUSE_HYPOTHESIS_ID,
      executedDiscriminatingTrialCount: 1,
    },
  };
}

// Distributive, so the scenario-set union survives: a plain `Omit` over a
// union collapses it, and `'ad-hoc'` would lose its required `scenarios`.
type OmitEach<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;
type OracleExperimentOptions = OmitEach<
  Parameters<typeof runBenchmarkExperiment>[0],
  'investigate' | 'collectResources'
>;

/**
 * Run the oracle over a declared scenario set, through the same plan and the
 * same evaluators every other arm is scored by. No graph, no model, no provider.
 *
 * The execution callback reads the scenario by id, which is the ground-truth
 * access only this arm is granted; ad-hoc runs resolve against the scenarios
 * the caller supplied.
 */
export async function runOracleBenchmarkExperiment(
  options: OracleExperimentOptions,
): Promise<BenchmarkExperiment> {
  const scenarios =
    options.scenarioSet === 'ad-hoc' ? options.scenarios : REPLAY_SCENARIOS;
  const scenariosById = new Map(scenarios.map((scenario) => [scenario.id, scenario]));

  return runBenchmarkExperiment({
    ...options,
    async investigate(input) {
      const scenario = scenariosById.get(input.scenarioId);
      if (scenario === undefined) {
        throw new Error(`the oracle has no ground truth for scenario ${input.scenarioId}`);
      }
      const { answer, challengeEffect } = oracleAnswerFor(scenario);
      return outcomeFromArmAnswer({
        answer,
        fixture: input.fixture,
        ...(challengeEffect === undefined ? {} : { challengeEffect }),
      });
    },
  });
}
