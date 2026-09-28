/**
 * AIC-125 slice d: discriminating credit counts only challenge-round work
 * that fetched new evidence.
 *
 * `runGraphBenchmarkExperiment`'s own `investigate` callback
 * (`packages/evals/src/graph-benchmark.ts`) currently builds
 * `discriminatingTestIds` from `challenge_hypothesis`'s own
 * `discriminatingTests` alone, and credits any `ok` trial of one of those
 * ids — never checking whether the trial actually fetched evidence the run
 * did not already hold. This file pins the NEW definition instead: a trial
 * counts only when both hold —
 *
 *   1. its test id did not exist in state before the first challenge round
 *      (created in a challenge round: the challenge role's own proposed
 *      tests, or a test `plan_investigation` planned for the alternative —
 *      see challenge-planning.test.mjs for that half), and
 *   2. its `evidenceIds` is non-empty: it fetched evidence this run did not
 *      already hold, never a replay of evidence the run already carries.
 *
 * `executedDiscriminatingTrialCount` is not published on its own — it only
 * ever surfaces through `challenge_effect`'s score/reason
 * (`evaluateChallengeEffect`, `behavior-evaluators.ts`), the same way
 * `benchmark-resource-evidence.test.mjs`'s own
 * "writing the replayed tool calls into the trials channel credits no
 * challenge" pin reads it. Every scenario below holds the leader's identity
 * and status fixed across the challenge round (same leaderId reported before
 * and after, no prediction ever evaluated) and declares
 * `expectedLeaderChangeAfterChallenge: false`, so `challenge_effect`'s score
 * is driven by exactly one thing: whether a discriminating trial with new
 * evidence was executed. Score 1 / "passed" reads as "credited"; score 0 /
 * "no-investigation-change" reads as "not credited".
 *
 * Built with ad-hoc ground-truth-only scenarios through
 * `runGraphBenchmarkExperiment`, the way
 * `test/benchmark-resource-evidence.test.mjs` builds its own probe fixtures:
 * fully scripted lifecycle nodes that do not touch a scenario's `fixture` at
 * all, using the canonical `createExecuteInvestigation` (`@aic/graph`) with a
 * test-local port (a `(tool, input) -> outcome` map) rather than a raw
 * hand-rolled trial, so what counts as "fetched new evidence" is decided by
 * the same executor production uses, not by a second, competing rule this
 * file would have to keep in sync with it by hand.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import * as domain from '@aic/domain';
import * as graph from '@aic/graph';
import * as evals from '@aic/evals';

import { benchmarkVersions, requireFunction } from './fixtures/benchmark-experiment.mjs';

/* -------------------------------------------------------------------------- */
/* shared fixtures                                                            */
/* -------------------------------------------------------------------------- */

const LEADER_ID = 'aic125d-credit-leader';
const ALTERNATIVE_ID = 'aic125d-credit-alternative';

/**
 * An ad-hoc, ground-truth-only scenario set: `fixture` is never read by the
 * nodes below. `createBenchmarkPlan` (the 'ad-hoc' path) requires exactly
 * five scenarios, so this is five otherwise-identical copies under distinct
 * ids rather than one — every run all five produce is scored the same way,
 * since `creditNodes` below reads nothing scenario-specific off `input`.
 */
const CREDIT_SCENARIOS = Object.freeze(
  Array.from({ length: 5 }, (_, index) => Object.freeze({
    id: `aic125d-discriminating-credit-${index + 1}`,
    groundTruth: Object.freeze({
      expectedStopKind: 'sufficient',
      expectedConclusionKind: 'inconclusive',
      expectedEvidence: [],
      expectedLeaderChangeAfterChallenge: false,
    }),
    fixture: Object.freeze({ version: 'v1', entries: [] }),
  })),
);

function evidenceItem(id, overrides = {}) {
  return {
    id,
    kind: 'metric',
    source: 'metrics',
    observedAt: '2026-09-29T00:00:00.000Z',
    statement: `evidence recorded as ${id}`,
    rawRef: `test://evidence/${id}`,
    ...overrides,
  };
}

/**
 * A stable key for a (tool, input) request, independent of key order —
 * a fixture convenience, not a re-implementation of `planInvestigation`'s own
 * request-identity recipe.
 */
function requestKey(tool, input) {
  return JSON.stringify(domain.canonicalJson([tool, input]));
}

/** The test-local port: a scripted `(tool, input) -> outcome` map. */
function portFrom(map) {
  return async ({ tool, input }) => {
    const key = requestKey(tool, input);
    const outcome = map.get(key);
    assert.ok(outcome, `unscripted execute call in this fixture: ${key}`);
    return outcome;
  };
}

/**
 * A fully scripted lifecycle: the leader (with or without a cause) and the
 * challenge round's alternative (with or without a cause), the canonical
 * derive/plan/execute nodes wired exactly as `createInvestigationGraph`
 * wires them in production, and a termination check that forces exactly one
 * mandatory challenge round, reporting the SAME leaderId before and after so
 * `challenge_effect` is never credited by a leader or status change — only by
 * a discriminating trial.
 */
function creditNodes({ leaderCause, alternativeCause, challengeTest, executeMap }) {
  const noop = async () => ({});
  return {
    normalize_incident: noop,
    collect_baseline: noop,
    async generate_hypotheses() {
      return {
        hypotheses: [{
          id: LEADER_ID,
          statement: 'the leader candidate cause',
          createdBy: 'initial',
          ...(leaderCause === undefined ? {} : { cause: leaderCause }),
        }],
      };
    },
    derive_predictions: graph.createDerivePredictions(),
    plan_investigation: graph.createPlanInvestigation(),
    execute_investigation: graph.createExecuteInvestigation({ execute: portFrom(executeMap) }),
    evaluate_predictions: noop,
    interpret_residual_evidence: noop,
    derive_hypothesis_state: noop,
    async termination_check(state) {
      return state.control.challengeRounds > 0
        ? { route: 'terminal', stopKind: 'sufficient', leaderId: LEADER_ID }
        : { route: 'challenge-required', leaderId: LEADER_ID };
    },
    async challenge_hypothesis() {
      return {
        alternative: {
          id: ALTERNATIVE_ID,
          statement: 'the alternative candidate cause',
          createdBy: 'challenge',
          ...(alternativeCause === undefined ? {} : { cause: alternativeCause }),
        },
        discriminatingTests: [challengeTest],
      };
    },
    async propose_conclusion() {
      return { conclusion: { kind: 'inconclusive', causes: [] } };
    },
  };
}

async function runCreditExperiment({ experimentId, ...nodesOptions }) {
  const runGraphBenchmarkExperiment = requireFunction(evals, 'runGraphBenchmarkExperiment', '@aic/evals');
  return runGraphBenchmarkExperiment({
    experimentId,
    scenarioSet: 'ad-hoc',
    scenarios: CREDIT_SCENARIOS,
    runsPerScenario: 3,
    metadata: benchmarkVersions,
    createNodes: () => creditNodes(nodesOptions),
    async recordEvaluation() {},
  });
}

function challengeEffectMetrics(experiment) {
  return experiment.results.map((result) => result.behaviorMetrics?.challenge_effect);
}

function assertCredited(experiment, message) {
  for (const metric of challengeEffectMetrics(experiment)) {
    assert.ok(metric, 'fixture sanity: challenge_effect must be scored on every run');
    assert.equal(metric.score, 1, `${message}: got reason "${metric?.reason}"`);
    assert.equal(metric.reason, 'passed');
  }
}

function assertNotCredited(experiment, message) {
  for (const metric of challengeEffectMetrics(experiment)) {
    assert.ok(metric, 'fixture sanity: challenge_effect must be scored on every run');
    assert.equal(metric.score, 0, `${message}: got reason "${metric?.reason}"`);
    assert.equal(metric.reason, 'no-investigation-change');
  }
}

/* -------------------------------------------------------------------------- */
/* rows                                                                       */
/* -------------------------------------------------------------------------- */

test('discriminating credit: a challenge test whose ok trial fetched new evidence counts 1', async () => {
  const challengeTest = Object.freeze({
    id: 'aic125d-row1-challenge-test',
    predictionId: 'aic125d-row1-challenge-prediction',
    tool: 'logs',
    input: { service: 'aic125d-row1', window: 'incident', query: 'error' },
    cost: 'cheap',
    status: 'planned',
  });
  const executeMap = new Map([
    [requestKey(challengeTest.tool, challengeTest.input), {
      status: 'ok',
      output: [evidenceItem('aic125d-row1-evidence', { kind: 'log', source: 'logs' })],
    }],
  ]);

  const experiment = await runCreditExperiment({
    experimentId: 'aic125d-discriminating-credit-row1',
    challengeTest,
    executeMap,
  });

  assertCredited(
    experiment,
    'a challenge-proposed test whose ok trial fetched new evidence must earn discriminating credit',
  );
});

test('discriminating credit: a challenge test whose ok trial fetched only already-held evidence (empty evidenceIds) counts 0 — replay must not earn discriminating credit without new evidence', async () => {
  const challengeTest = Object.freeze({
    id: 'aic125d-row2-challenge-test',
    predictionId: 'aic125d-row2-challenge-prediction',
    tool: 'logs',
    input: { service: 'aic125d-row2', window: 'incident', query: 'error' },
    cost: 'cheap',
    status: 'planned',
  });
  const executeMap = new Map([
    [requestKey(challengeTest.tool, challengeTest.input), { status: 'ok', output: [] }],
  ]);

  const experiment = await runCreditExperiment({
    experimentId: 'aic125d-discriminating-credit-row2',
    challengeTest,
    executeMap,
  });

  assertNotCredited(
    experiment,
    'an ok trial that fetched no new evidence (empty evidenceIds) must not earn discriminating credit merely for being ok',
  );
});

const ROW3_ALTERNATIVE_CAUSE = Object.freeze({ component: 'aic125d-row3-alt', mechanism: 'connection-pool-exhaustion' });
const ROW3_PLANNED_INPUT = Object.freeze({ service: 'aic125d-row3-alt', window: 'incident', metric: 'connection-pool' });

test('discriminating credit: a test planned for the alternative in the challenge round that fetched new evidence counts', async () => {
  const challengeTest = Object.freeze({
    id: 'aic125d-row3-challenge-test',
    predictionId: 'aic125d-row3-challenge-prediction',
    tool: 'logs',
    input: { service: 'aic125d-row3', window: 'incident', query: 'error' },
    cost: 'cheap',
    status: 'planned',
  });
  const executeMap = new Map([
    // The challenge role's own proposed test is deliberately NOT ok: an ok
    // trial (even one that fetched nothing new) is exactly what row 2 above
    // exercises, and letting this row's own filler test come back ok would
    // let the OLD, ok-status-only definition credit this row for the wrong
    // reason, passing regardless of whether the newly planned test below is
    // ever executed at all.
    [requestKey(challengeTest.tool, challengeTest.input), { status: 'unavailable', reason: 'not relevant to this row' }],
    [requestKey('metrics', ROW3_PLANNED_INPUT), {
      status: 'ok',
      output: [evidenceItem('aic125d-row3-evidence', { kind: 'metric', source: 'metrics' })],
    }],
  ]);

  const experiment = await runCreditExperiment({
    experimentId: 'aic125d-discriminating-credit-row3',
    alternativeCause: ROW3_ALTERNATIVE_CAUSE,
    challengeTest,
    executeMap,
  });

  assertCredited(
    experiment,
    'a test plan_investigation planned for the alternative inside the challenge round, whose trial fetched new evidence, must earn discriminating credit even though the challenge role never proposed it',
  );
});

const ROW4_LEADER_CAUSE = Object.freeze({ component: 'aic125d-row4-leader', mechanism: 'connection-pool-exhaustion' });
const ROW4_LEADER_INPUT = Object.freeze({ service: 'aic125d-row4-leader', window: 'incident', metric: 'connection-pool' });

test('discriminating credit: a pre-challenge test that ran again or fetched evidence counts 0', async () => {
  const challengeTest = Object.freeze({
    id: 'aic125d-row4-challenge-test',
    predictionId: 'aic125d-row4-challenge-prediction',
    tool: 'logs',
    input: { service: 'aic125d-row4', window: 'incident', query: 'error' },
    cost: 'cheap',
    status: 'planned',
  });
  const executeMap = new Map([
    // The leader's OWN test, planned and executed before the first challenge
    // round: its trial fetches real, new evidence, but it was never created
    // in a challenge round and must not be credited on that account.
    [requestKey('metrics', ROW4_LEADER_INPUT), {
      status: 'ok',
      output: [evidenceItem('aic125d-row4-leader-evidence', { kind: 'metric', source: 'metrics' })],
    }],
    // Deliberately NOT ok, for the same reason as row 3's filler test above:
    // an ok challenge-role trial (even an evidence-free one) is row 2's own
    // fixture, and this row must isolate the pre-existing leader trial's
    // (non-)credit from that separate fact.
    [requestKey(challengeTest.tool, challengeTest.input), { status: 'unavailable', reason: 'not relevant to this row' }],
  ]);

  const experiment = await runCreditExperiment({
    experimentId: 'aic125d-discriminating-credit-row4',
    leaderCause: ROW4_LEADER_CAUSE,
    challengeTest,
    executeMap,
  });

  assertNotCredited(
    experiment,
    'a trial that predates the first challenge round must never earn discriminating credit, even though its own trial fetched evidence before the challenge ever ran',
  );
});
