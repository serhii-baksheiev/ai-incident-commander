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
import { routeRequestVocabulary } from '@aic/domain';
import * as evals from '@aic/evals';
import { runOracleBenchmarkExperiment } from '@aic/evals/oracle';
import { INVESTIGATION_ROUTES, createInvestigationNodes } from '@aic/graph';
import {
  createModelChallengeHypothesis,
  createModelGenerateHypotheses,
  createModelInterpretResidualEvidence,
  createModelProposeConclusion,
  createScriptedReasoning,
} from '@aic/roles';
import { NAIVE_PROMPT_VERSION, createModelNaiveInvestigation } from '@aic/roles/naive';
import { createPlannedReplayExecutor } from '@aic/tools/replay';

/**
 * The deterministic arm: `@aic/graph`'s canonical `createInvestigationNodes`
 * (AIC-126 slice a), given the scripted-control reasoning
 * (`createScriptedReasoning`, `@aic/roles` since AIC-126 slice b — it lived
 * in `@aic/evals` for slice a) and the planned-replay executor. Before this
 * slice this function assembled the node map itself —
 * spreading `replayBackedNodes` (`test/fixtures/benchmark-experiment.mjs`)
 * for the scripted roles and the identity/no-op nodes, then overriding the
 * six deterministic nodes one by one. `createInvestigationNodes` now owns
 * that assembly, so this script never has to reach into `test/` to build a
 * working graph.
 * see investigation-nodes-composition.test.mjs for the behavioural proof of
 * every canonical node `createInvestigationNodes` wires.
 * see scripted-reasoning.test.mjs for the behavioural proof of the four
 * scripted reasoning roles.
 * see lane-arms.test.mjs › "both eval-live-model.mjs and eval-final-holdout.mjs reach scriptedNodes from ./lane-arms.mjs, the single implementation"
 * see lane-arms.test.mjs › "scripts/lane-arms.mjs imports nothing from test/"
 *
 * `modelNodes` inherits every canonical node, because it spreads
 * `scriptedNodes` and swaps only the four reasoning roles. This is the one
 * implementation both lane commands use, so the control arm and the model
 * arm's base nodes cannot drift apart.
 * see lane-arms.test.mjs › "scriptedNodes(record) and modelNodes(record, port) both carry the canonical derive_hypothesis_state and termination_check nodes, proven by behaviour rather than identity or source text"
 * see lane-arms.test.mjs › "modelNodes(record, port)'s termination depends on state, never on the scenario id or ground truth: a renamed clone of a real calibration scenario reaches the same stop kind as the original, and a variant with its confirming recorded fact removed reaches a different one"
 * see lane-arms.test.mjs › "scriptedNodes(record)'s termination is independent of scenario identity: a renamed clone of a real calibration scenario reaches the same stop kind as the original"
 * see prediction-wiring.test.mjs › "scriptedNodes(record) and modelNodes(record, port) carry the canonical derive_predictions and evaluate_predictions: a matching connection-pool-exhaustion fact observed at REPLAY_AS_OF confirms the derived prediction with one rule assessment, and the same fact one millisecond later confirms nothing"
 * see prediction-wiring.test.mjs › "running the real kernel over a calibration record with scriptedNodes ends with predictions: [] and no producedBy: "rule" assessment"
 * see investigation-plan-execute-wiring.test.mjs › "scriptedNodes(record) executes only planned tests, through the same canonical executor modelNodes uses: a state with no planned test replays nothing from the fixture, and a state with one planned test yields exactly one trial"
 * see investigation-plan-execute-wiring.test.mjs › "deployment-caused-incident-a is one scenario giving a strict subset: the model arm sees exactly the confirming evidence, the scenario's own recorded corpus also carries the dependencies evidence, and the scripted-control arm run through the real kernel ends with no evidence at all"
 * see live-model-lane.test.mjs › "swaps exactly the four reasoning roles and leaves the rest of the lifecycle shared"
 */
export function scriptedNodes(record) {
  return createInvestigationNodes({
    reasoning: createScriptedReasoning(record),
    execute: createPlannedReplayExecutor({
      fixture: record.fixture,
      routes: INVESTIGATION_ROUTES,
      annotate: evals.createObservationAnnotator(),
    }).execute,
    asOf: () => evals.REPLAY_AS_OF,
  });
}

/**
 * The model arm: the same nodes with the four reasoning roles swapped for
 * model-backed ones. It inherits the planned investigation, so it sees the
 * evidence its own predictions (and the challenge round) asked for, never the
 * whole recorded corpus the naive arm reads.
 * see investigation-plan-execute-wiring.test.mjs › "modelNodes(record, port).plan_investigation plans exactly one test for one untested prediction whose planned request has a matching recorded quantity, and execute_investigation yields exactly one trial carrying exactly the matching evidence"
 * see investigation-plan-execute-wiring.test.mjs › "for every calibration scenario, the model arm's plan-only evidence ids (derive → plan → execute for the ground-truth cause) are a subset of the scenario's own recorded ok evidence ids, and a strict subset for at least one scenario"
 *
 * AIC-123 slice 2: `generate_hypotheses` and `challenge_hypothesis` now also
 * take `mechanisms`, the same `evals.ROOT_CAUSE_MECHANISMS` vocabulary
 * `propose_conclusion` already received, so every cause a run produces — at
 * every stage — is classified against the one vocabulary the lane measures
 * against.
 * see lane-arms.test.mjs › "modelNodes(record, port).generate_hypotheses and .challenge_hypothesis are given the mechanism vocabulary evals.ROOT_CAUSE_MECHANISMS: the provider schema's cause mechanism enum equals it exactly, and the system prompt carries the vocabulary sentence"
 *
 * AIC-143: `challenge_hypothesis` is also given the closed request vocabulary
 * the route table can form — `routeRequestVocabulary(INVESTIGATION_ROUTES)`
 * (`@aic/domain` / `@aic/graph`) — so its system prompt names the admissible
 * tool ids and input keys the same way `describeMechanismVocabulary` already
 * names the mechanism vocabulary above.
 * see lane-arms.test.mjs › "modelNodes(record, port).challenge_hypothesis's captured system prompt contains describeRequestVocabulary(routeRequestVocabulary(INVESTIGATION_ROUTES))"
 */
export function modelNodes(record, port) {
  return {
    ...scriptedNodes(record),
    generate_hypotheses: createModelGenerateHypotheses({
      port,
      mechanisms: evals.ROOT_CAUSE_MECHANISMS,
    }),
    interpret_residual_evidence: createModelInterpretResidualEvidence({ port }),
    challenge_hypothesis: createModelChallengeHypothesis({
      port,
      mechanisms: evals.ROOT_CAUSE_MECHANISMS,
      requestVocabulary: routeRequestVocabulary(INVESTIGATION_ROUTES),
    }),
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
