/**
 * The oracle and naive arms of the live lane, wired once for both lane
 * commands (`eval-live-model.mjs` and `eval-final-holdout.mjs`), so the two
 * cannot drift apart in how they build either arm.
 *
 * The oracle reads ground truth and makes no model call. The naive arm makes
 * one completion per record through the port it is handed.
 * see lane-arms.test.mjs › "naiveArm drives the naive role from a fake port: exactly one completion per record, notApplicable.challenge_effect on every result, promptVersion/modelId/modelProvider on every record, and no REPLAY_SCENARIOS id in any request"
 */
import * as evals from '@aic/evals';
import { runOracleBenchmarkExperiment } from '@aic/evals/oracle';
import { NAIVE_PROMPT_VERSION, createModelNaiveInvestigation } from '@aic/roles/naive';

/** The positive control: the ground-truth answer, scored like every other arm. */
export function oracleArm({ experimentId }) {
  return (plan) =>
    runOracleBenchmarkExperiment({
      experimentId,
      scenarioSet: plan.scenarioSet,
      runsPerScenario: plan.runsPerScenario,
      metadata: plan.metadata,
      async recordEvaluation() {},
    });
}

/** The naive single-prompt baseline, over the same telemetry the graph arm replays. */
export function naiveArm({ experimentId, port, config }) {
  return (plan) =>
    evals.runNaiveBenchmarkExperiment({
      experimentId,
      scenarioSet: plan.scenarioSet,
      runsPerScenario: plan.runsPerScenario,
      metadata: {
        ...plan.metadata,
        promptVersion: NAIVE_PROMPT_VERSION,
        modelId: config.modelId,
        modelProvider: config.provider,
      },
      investigate: createModelNaiveInvestigation({
        port,
        mechanisms: evals.ROOT_CAUSE_MECHANISMS,
      }),
      async recordEvaluation() {},
    });
}

/**
 * Publish the naive arm's experiment, or say why it was not published.
 *
 * Only a completed, reportable naive arm is published; anything else returns
 * `absent` with the arm's own reason and publishes nothing. A refusal from
 * `persist` propagates: a lane that swallowed it would report a publication
 * that never happened.
 * see lane-arms.test.mjs › "publishNaiveArm publishes a completed, reportable naive arm exactly once, with the given datasetName and the exact experiment object, and returns what persist resolved to"
 */
export async function publishNaiveArm({ laneReport, naiveExperiment, datasetName, persist }) {
  const naive = laneReport.arms.naive;
  if (naive.status === 'not-run') return { status: 'absent', absentReason: naive.reason };
  if (naive.status === 'refused') return { status: 'absent', absentReason: naive.refusalReason };
  if (naive.reportable !== true) return { status: 'absent', absentReason: naive.unreportableReason };
  if (naiveExperiment === undefined) {
    return { status: 'absent', absentReason: 'the naive arm produced no experiment to publish' };
  }
  const publication = await persist({ datasetName, experiment: naiveExperiment });
  return { status: 'published', ...publication };
}

