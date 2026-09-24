/**
 * The oracle, naive and model arms of the live lane, wired once for both lane
 * commands (`eval-live-model.mjs` and `eval-final-holdout.mjs`), so the two
 * cannot drift apart in how they build any arm.
 *
 * The oracle reads ground truth and makes no model call. The naive arm makes
 * one completion per record through the port it is handed.
 * see lane-arms.test.mjs › "naiveArm drives the naive role from a fake port: exactly one completion per record, notApplicable.challenge_effect on every result, promptVersion/modelId/modelProvider on every record, and no REPLAY_SCENARIOS id in any request"
 *
 * AIC-119 slice E: `modelNodes` used to be defined once per script
 * (`eval-live-model.mjs`, `eval-final-holdout.mjs`), and both copies swapped
 * only three roles — `propose_conclusion` stayed the scripted, replay-backed
 * node, so the model arm never spent the fourth model-backed role at all.
 * `.claude/rules/invariants.md` ("one mechanism, one implementation"): this is
 * now the one definition, and it wires all four.
 * see lane-arms.test.mjs › "modelNodes(record, port).propose_conclusion is a model role: the fake port sees exactly one call, carrying the mechanism vocabulary sentence built from evals.ROOT_CAUSE_MECHANISMS"
 * see lane-arms.test.mjs › "both eval-live-model.mjs and eval-final-holdout.mjs reach modelNodes from ./lane-arms.mjs, the single implementation"
 */
import * as evals from '@aic/evals';
import { runOracleBenchmarkExperiment } from '@aic/evals/oracle';
import {
  createModelChallengeHypothesis,
  createModelGenerateHypotheses,
  createModelInterpretResidualEvidence,
  createModelProposeConclusion,
} from '@aic/roles';
import { NAIVE_PROMPT_VERSION, createModelNaiveInvestigation } from '@aic/roles/naive';

import { replayBackedNodes } from '../test/fixtures/benchmark-experiment.mjs';

/** The deterministic arm: the replay-backed nodes, unchanged. */
function scriptedNodes(record) {
  return replayBackedNodes(record, new Map([[record.runId, []]]), new Map([[record.runId, 0]]));
}

/**
 * The model arm: the same nodes with the four reasoning roles swapped for
 * model-backed ones. `execute_investigation` still replays the recorded tool
 * calls, so the evidence both arms see is identical and the only difference
 * is who reasoned over it.
 */
export function modelNodes(record, port) {
  return {
    ...scriptedNodes(record),
    generate_hypotheses: createModelGenerateHypotheses({ port }),
    interpret_residual_evidence: createModelInterpretResidualEvidence({ port }),
    challenge_hypothesis: createModelChallengeHypothesis({ port }),
    propose_conclusion: createModelProposeConclusion({ port, mechanisms: evals.ROOT_CAUSE_MECHANISMS }),
  };
}

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
