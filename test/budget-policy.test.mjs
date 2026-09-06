/**
 * AIC-18, executed as MEASUREMENT AND VERSIONING rather than as tuning.
 *
 * The item asked for `maxIterations`, `llmCallBudget` and
 * `reservedChallengeBudget` to be tuned from benchmark evidence. A premise sweep
 * found there is nothing on the calibration corpus to tune against, so what this
 * file pins is the honest version of the request: the three numbers become ONE
 * frozen, versioned policy; the policy becomes injectable so a sweep is possible
 * at all; a malformed policy is refused rather than defaulted; and the sweep's
 * finding is recorded as rows that go red on the day it stops being true.
 *
 * The finding, stated once here and asserted below:
 *
 *   - `maxIterations` and `llmCallBudget` are read on ONE edge — the
 *     `need-more-evidence` route out of `termination_check` — and no node
 *     outside `test/` returns that route. So `0 / 0` publishes evidence
 *     identical to the shipped `4 / 8` on every axis these rows compare — all
 *     of them except `wallClockDurationMs`, which is dropped as
 *     nondeterministic. Those two budgets are not calibrated by anything; they
 *     are unreached.
 *   - `reservedChallengeBudget` IS reached, because a `sufficient` decision with
 *     no challenge round behind it is forced through the mandatory challenge. At
 *     `1`, `2` and `8` the evidence is identical (the cap is two rounds and this
 *     corpus uses one); at `0` every run stops `budget-exhausted` and the
 *     challenge node never executes — and even then no metric and no resource
 *     axis moves. It changes the stop kind and the node trace, and nothing else.
 *
 * The corpus is the calibration partition. No hold-out scenario is run and no
 * hold-out result is read: a number measured off it here would be a number
 * spent, and the policy that says so is in `README.md`.
 *
 * The observation idiom is `benchmark-resource-evidence.test.mjs`'s: the control
 * block is not published anywhere, so the only way to see WHICH policy reached
 * the graph is to read `state.control` from inside a lifecycle node. Reading the
 * exported constant would prove the constant, not the wiring.
 */
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import * as evals from '@aic/evals';

import {
  benchmarkVersions,
  replayBackedNodes,
  requireFunction,
} from './fixtures/benchmark-experiment.mjs';
import {
  withAccessorPollutedObjectPrototype,
  withPollutedObjectPrototype,
} from './fixtures/prototype-decoy.mjs';

/* -------------------------------------------------------------------------- */
/* The vocabulary these rows are written against                              */
/* -------------------------------------------------------------------------- */

/**
 * The three budgets, as one list, so no row below restates them. A fourth
 * budget added to the policy without a decision fails the shape rows first.
 */
const BUDGET_FIELD_NAMES = ['llmCallBudget', 'maxIterations', 'reservedChallengeBudget'];

/** The two recovery axes, which stay separate from the logical budget above. */
const RECOVERY_AXIS_NAMES = ['resumeCount', 'retryCount'];

const RUNS_PER_SCENARIO = 3;

/**
 * The shape of the report, as exact key sets. An allowlist rather than a
 * "contains" check, because the thing this evidence must never grow is an EXTRA
 * field — and a blended figure added under a benign name is exactly the addition
 * a "contains" check waves through.
 */
const REPORT_KEYS = ['arms', 'calibration'];
const ARM_KEYS = [
  'budgets',
  'metrics',
  'policyVersion',
  'resourceAxes',
  'runCount',
  'stopKindDistribution',
];
const AXIS_ENTRY_KEYS = ['exampleCount', 'key', 'mean'];
const CALIBRATION_ENTRY_KEYS = ['empiricallyCalibrated', 'reason'];

/**
 * The vocabulary of a composite. Every word here names a figure that blends two
 * dimensions into one number, which is the comparison this evidence exists to
 * make impossible to fake — the same refusal `BenchmarkResourceEvidence` states
 * for the per-run axes, carried up to the per-policy report.
 *
 * Matched against every key at every depth, not against three known names: the
 * failure this guards is a key ADDED later, and a check that lists the keys it
 * expects to find cannot see one it never heard of.
 */
const COMPOSITE_KEY_PATTERN =
  /composite|aggregate|overall|blended|combined|weighted|efficiency|penalt|costScore|budgetScore|totalScore|_score$|Score$/i;

function requireBudgetPolicy() {
  const policy = evals.BENCHMARK_BUDGET_POLICY;
  assert.equal(
    typeof policy,
    'object',
    '@aic/evals must export BENCHMARK_BUDGET_POLICY: the three budgets are one versioned decision, not three literals inside a module-private function',
  );
  assert.notEqual(policy, null, 'BENCHMARK_BUDGET_POLICY must not be null');
  return policy;
}

/** A policy for a sweep arm, versioned like the shipped one so the report can key on it. */
function sweepPolicy(policyVersion, maxIterations, llmCallBudget, reservedChallengeBudget) {
  return { policyVersion, maxIterations, llmCallBudget, reservedChallengeBudget };
}

/**
 * `wallClockDurationMs` is a real clock reading, so it differs between two runs
 * of identical work. Every cross-arm comparison drops it and nothing else: an
 * arm comparison that dropped a second axis would be hiding whatever that axis
 * did.
 */
function publishedEvidence(result) {
  const { wallClockDurationMs: _elapsed, ...resources } = result.resources ?? {};
  return {
    actualStopKind: result.actualStopKind,
    metrics: result.metrics,
    behaviorMetrics: result.behaviorMetrics,
    resources,
  };
}

/* -------------------------------------------------------------------------- */
/* The sweep                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * The arms, and what each one is for. Four probes beside the shipped default,
 * because four is what discriminates: one for the pair of budgets nothing
 * reaches, two for the values of the reached budget that change nothing, and one
 * for the value that changes something.
 *
 * The shipped arm passes NO policy at all, so it also proves the default.
 */
const SWEEP_ARMS = [
  { id: 'shipped', budgetPolicy: undefined },
  {
    id: 'zero-logical',
    budgetPolicy: sweepPolicy('aic-18-sweep-zero-logical', 0, 0, 2),
  },
  {
    id: 'reserve-one',
    budgetPolicy: sweepPolicy('aic-18-sweep-reserve-one', 4, 8, 1),
  },
  {
    id: 'reserve-eight',
    budgetPolicy: sweepPolicy('aic-18-sweep-reserve-eight', 4, 8, 8),
  },
  {
    id: 'reserve-zero',
    budgetPolicy: sweepPolicy('aic-18-sweep-reserve-zero', 4, 8, 0),
  },
];

/**
 * One arm of the sweep: the whole calibration partition through the
 * replay-backed lifecycle, with the control block observed from inside the first
 * node it reaches.
 *
 * Everything is keyed by `exampleId`, never by `runId`: a runId is a fresh uuid
 * per experiment, so two arms of the same corpus share no runId at all, while
 * the exampleId is derived from the scenario and the run number and is the same
 * row in both arms.
 */
async function runSweepArm({ id, budgetPolicy }) {
  const runGraphBenchmarkExperiment = requireFunction(
    evals,
    'runGraphBenchmarkExperiment',
    '@aic/evals',
  );
  const traces = new Map();
  const replayCounts = new Map();
  const observedControl = new Map();
  const traceByExampleId = new Map();

  const experiment = await runGraphBenchmarkExperiment({
    experimentId: `aic-18-budget-policy-${id}-v0.2`,
    scenarioSet: 'calibration',
    runsPerScenario: RUNS_PER_SCENARIO,
    metadata: benchmarkVersions,
    ...(budgetPolicy === undefined ? {} : { budgetPolicy }),
    createNodes: (input) => {
      traces.set(input.runId, []);
      replayCounts.set(input.runId, 0);
      const nodes = replayBackedNodes(input, traces, replayCounts);
      return {
        ...nodes,
        // The independent observation. The control block is published nowhere,
        // so this is the only place the policy that REACHED the graph is
        // visible. Read at the first lifecycle node, before the graph has spent
        // anything: `reservedChallengeBudget` is decremented by a challenge
        // round, so a reading taken at the end would report the remainder.
        async normalize_incident(state, ...rest) {
          observedControl.set(input.exampleId, {
            maxIterations: state.control.maxIterations,
            llmCallBudget: state.control.llmCallBudget,
            reservedChallengeBudget: state.control.reservedChallengeBudget,
          });
          traceByExampleId.set(input.exampleId, traces.get(input.runId));
          return nodes.normalize_incident(state, ...rest);
        },
      };
    },
    async recordEvaluation() {},
  });

  return {
    id,
    budgetPolicy,
    experiment,
    observedControl,
    traceByExampleId,
    evidenceByExampleId: new Map(
      experiment.results.map((result) => [result.exampleId, publishedEvidence(result)]),
    ),
  };
}

let sweep;

/**
 * The whole sweep, memoised for cost exactly as the probes in
 * `benchmark-resource-evidence.test.mjs` are: every caller destructures from one
 * await, so no assertion compares values obtained from two invocations.
 */
function getSweep() {
  if (sweep !== undefined) return sweep;

  sweep = (async () => {
    const arms = new Map();
    for (const arm of SWEEP_ARMS) {
      arms.set(arm.id, await runSweepArm(arm));
    }
    return arms;
  })();

  return sweep;
}

async function getArm(id) {
  const arms = await getSweep();
  const arm = arms.get(id);
  assert.ok(arm, `no sweep arm named ${id}`);
  return arm;
}

/**
 * The precondition every comparison below rests on, and the reason it is
 * repeated in each of them rather than asserted once: an arm that did not run
 * under its own policy is the same run under another name, and a row that then
 * reports "identical evidence" has compared nothing. Without the injection seam
 * every arm IS that, so this is what separates a finding from a tautology.
 */
function assertArmRanUnderItsPolicy(arm, policy) {
  const expected = {
    maxIterations: policy.maxIterations,
    llmCallBudget: policy.llmCallBudget,
    reservedChallengeBudget: policy.reservedChallengeBudget,
  };
  assert.deepEqual(
    [...new Set([...arm.observedControl.values()].map((seen) => JSON.stringify(seen)))],
    [JSON.stringify(expected)],
    `the ${arm.id} arm did not run under the policy it declares (${policy.policyVersion}), so every comparison against it is vacuous: two arms that were never different are trivially identical`,
  );
}

/* -------------------------------------------------------------------------- */
/* 1. One versioned policy, and it is what reaches the graph                   */
/* -------------------------------------------------------------------------- */

test('declares the three budgets as one frozen, versioned policy', () => {
  const policy = requireBudgetPolicy();

  assert.deepEqual(
    Object.keys(policy).sort(),
    [...BUDGET_FIELD_NAMES, 'policyVersion'].sort(),
    'the policy carries the three budgets and the version that names them, and nothing else',
  );
  assert.equal(
    typeof policy.policyVersion === 'string' && policy.policyVersion.length > 0,
    true,
    'a policy with no version cannot be compared against another policy, which is the whole point of publishing one',
  );
  for (const field of BUDGET_FIELD_NAMES) {
    assert.equal(
      Number.isSafeInteger(policy[field]) && policy[field] >= 0,
      true,
      `every budget is a logical count, and ${field} is ${String(policy[field])}`,
    );
  }

  assert.equal(
    Object.isFrozen(policy),
    true,
    'the shipped policy is a decision, so it must not be mutable from any caller that imports it',
  );
  assert.throws(
    () => {
      policy.maxIterations = 999;
    },
    TypeError,
    'a caller that writes to the shipped policy must fail loudly, not silently re-tune every later run in the process',
  );
});

test('pins the shipped budgets, because changing one is a decision and not a refactor', () => {
  const policy = requireBudgetPolicy();

  assert.deepEqual(
    {
      maxIterations: policy.maxIterations,
      llmCallBudget: policy.llmCallBudget,
      reservedChallengeBudget: policy.reservedChallengeBudget,
    },
    { maxIterations: 4, llmCallBudget: 8, reservedChallengeBudget: 2 },
    'AIC-18 versions these three numbers and does not change them: the sweep below found no evidence on the calibration corpus that would justify a different value, so a diff that moves one has to say what evidence moved it',
  );
});

test('runs the default benchmark under the shipped policy, observed inside the graph', async () => {
  const policy = requireBudgetPolicy();
  const { experiment, observedControl } = await getArm('shipped');

  assert.equal(
    experiment.results.length,
    evals.BENCHMARK_SCENARIO_PARTITIONS.calibration.length * RUNS_PER_SCENARIO,
    'the whole calibration partition must have run',
  );
  assert.equal(
    observedControl.size,
    experiment.results.length,
    'every run must reach the node that observes the control block it was started with',
  );

  const expected = {
    maxIterations: policy.maxIterations,
    llmCallBudget: policy.llmCallBudget,
    reservedChallengeBudget: policy.reservedChallengeBudget,
  };
  assert.deepEqual(
    [...new Set([...observedControl.values()].map((seen) => JSON.stringify(seen)))],
    [JSON.stringify(expected)],
    'a benchmark run that names no policy must be started from the exported one: three literals inside the runner would publish the same numbers today and silently stop tracking the constant tomorrow',
  );
});

/* -------------------------------------------------------------------------- */
/* 2. The seam                                                                */
/* -------------------------------------------------------------------------- */

test('starts the graph from a caller-supplied budget policy', async () => {
  for (const id of ['zero-logical', 'reserve-one', 'reserve-eight', 'reserve-zero']) {
    const { budgetPolicy, observedControl, experiment } = await getArm(id);
    const expected = {
      maxIterations: budgetPolicy.maxIterations,
      llmCallBudget: budgetPolicy.llmCallBudget,
      reservedChallengeBudget: budgetPolicy.reservedChallengeBudget,
    };

    assert.equal(observedControl.size, experiment.results.length);
    assert.deepEqual(
      [...new Set([...observedControl.values()].map((seen) => JSON.stringify(seen)))],
      [JSON.stringify(expected)],
      `the ${id} arm's policy must reach the control block the graph was started with: without this seam nothing below measures a policy at all, it measures the same run five times`,
    );
  }
});

/* -------------------------------------------------------------------------- */
/* 3. A malformed policy is refused, never defaulted                          */
/* -------------------------------------------------------------------------- */

/**
 * Five shapes that are not a policy, each naming the field that makes it one.
 *
 * Fail CLOSED: a policy the runner cannot read must stop the experiment, not
 * fall back to the shipped values. A silent default publishes evidence labelled
 * with the caller's intent and produced under someone else's budgets, which is
 * the one reading a policy version exists to prevent.
 */
const MALFORMED_POLICIES = [
  {
    label: 'no policy version',
    named: 'policyVersion',
    policy: { maxIterations: 4, llmCallBudget: 8, reservedChallengeBudget: 2 },
  },
  {
    label: 'an empty policy version',
    named: 'policyVersion',
    policy: sweepPolicy('', 4, 8, 2),
  },
  {
    label: 'a fractional budget',
    named: 'maxIterations',
    policy: sweepPolicy('aic-18-malformed-fractional', 1.5, 8, 2),
  },
  {
    label: 'a negative budget',
    named: 'reservedChallengeBudget',
    policy: sweepPolicy('aic-18-malformed-negative', 4, 8, -1),
  },
  {
    label: 'a budget that is not a number',
    named: 'llmCallBudget',
    policy: sweepPolicy('aic-18-malformed-string', 4, '8', 2),
  },
  // Not a policy at all. Both rows below exist because a mutation showed the
  // branch that refuses them was unpinned, and the second one caught a real
  // fail-open: `?? BENCHMARK_BUDGET_POLICY` cannot tell "not supplied" from
  // "supplied and null", so an explicit null silently ran under the shipped
  // policy. An ABSENT option is the fail-open case and defaults; an option
  // PRESENT in a shape the runner cannot read is the refusal case.
  { label: 'a policy that is not an object', named: 'policyVersion', policy: 'nonsense' },
  { label: 'an explicitly null policy', named: 'policyVersion', policy: null },
];

for (const { label, named, policy } of MALFORMED_POLICIES) {
  test(`refuses ${label} instead of falling back to the shipped one`, async () => {
    const runGraphBenchmarkExperiment = requireFunction(
      evals,
      'runGraphBenchmarkExperiment',
      '@aic/evals',
    );
    let scenariosStarted = 0;
    let evaluationsRecorded = 0;

    await assert.rejects(
      () => runGraphBenchmarkExperiment({
        experimentId: `aic-18-malformed-policy-${named}-v0.2`,
        scenarioSet: 'calibration',
        runsPerScenario: RUNS_PER_SCENARIO,
        metadata: benchmarkVersions,
        budgetPolicy: policy,
        createNodes: () => {
          scenariosStarted += 1;
          // Deliberately worded with no word this refusal is matched on, so a
          // run that starts anyway cannot be mistaken for the refusal.
          throw new Error('no scenario may execute while the policy is unreadable');
        },
        async recordEvaluation() {
          evaluationsRecorded += 1;
        },
      }),
      (error) => {
        assert.match(
          error.message,
          /budget\s*policy/i,
          `the refusal must name what it refused: ${error.message}`,
        );
        assert.match(
          error.message,
          new RegExp(named),
          `the refusal must name the field that made the policy unreadable (${named}): ${error.message}`,
        );
        return true;
      },
      `${label} must be refused, not silently replaced by the shipped policy`,
    );

    assert.equal(
      scenariosStarted,
      0,
      `a policy the runner cannot read must stop the experiment before any scenario runs: ${label}`,
    );
    assert.equal(evaluationsRecorded, 0, 'a refused policy publishes no evaluation');
  });
}

/* -------------------------------------------------------------------------- */
/* 4. The corpus sweep — this item's actual finding                           */
/* -------------------------------------------------------------------------- */

/**
 * The precondition the two rows below rest on. If the shipped arm does not reach
 * the mandatory challenge, "the reserve is the only reached budget" is not a
 * finding about this corpus, it is an artifact of a fixture that never got there.
 */
test('reaches the mandatory challenge on every shipped-policy run', async () => {
  const shipped = await getArm('shipped');
  const { experiment, traceByExampleId } = shipped;
  assertArmRanUnderItsPolicy(shipped, requireBudgetPolicy());

  for (const result of experiment.results) {
    assert.equal(
      result.actualStopKind,
      'sufficient',
      `the shipped arm must conclude sufficient, or the reserve-zero contrast below is measuring something else: ${result.exampleId}`,
    );
    assert.equal(
      traceByExampleId.get(result.exampleId).includes('challenge_hypothesis'),
      true,
      `the challenge must execute under the shipped reserve, or reservedChallengeBudget is not a reached budget on this corpus either: ${result.exampleId}`,
    );
  }
});

/**
 * 🔴 The row whose failure is the news.
 *
 * `maxIterations` and `llmCallBudget` are read on exactly one edge — the
 * `need-more-evidence` route — and nothing outside `test/` returns it. So a run
 * with BOTH budgets at zero publishes what a run at 4 and 8 publishes, to the
 * byte.
 *
 * When this goes red, the conclusion of AIC-18 has expired: a node has started
 * returning `need-more-evidence`, the two logical-budget axes are live, and
 * there is now something on this corpus to calibrate them against. Re-read the
 * item; do not adjust the arm until the numbers agree again.
 */
test('publishes identical evidence at zero logical budget, because nothing reaches that edge', async () => {
  const shipped = await getArm('shipped');
  const zeroLogical = await getArm('zero-logical');
  assertArmRanUnderItsPolicy(zeroLogical, zeroLogical.budgetPolicy);
  assertArmRanUnderItsPolicy(shipped, requireBudgetPolicy());

  assert.deepEqual(
    zeroLogical.experiment.stopKindDistribution,
    shipped.experiment.stopKindDistribution,
    'a budget nothing reads cannot change where a run stops: this going red means the need-more-evidence edge is now live and the logical budgets have become measurable',
  );

  for (const [exampleId, evidence] of shipped.evidenceByExampleId) {
    assert.deepEqual(
      zeroLogical.evidenceByExampleId.get(exampleId),
      evidence,
      `maxIterations: 0 and llmCallBudget: 0 published different evidence from the shipped 4 and 8 on ${exampleId} — a node now returns need-more-evidence, so these two axes are no longer unreached and AIC-18's conclusion has to be re-read`,
    );
  }
});

/**
 * The reached budget's values that change nothing, both directions of the cap.
 *
 * One round is what this corpus spends, `MAX_CHALLENGE_ROUNDS` is two, so a
 * reserve of one is already enough and a reserve of eight buys nothing the cap
 * would let anyone spend.
 */
for (const [id, description] of [
  ['reserve-one', 'one reserved round is all this corpus spends'],
  ['reserve-eight', 'a reserve above the round cap buys nothing the cap allows'],
]) {
  test(`publishes identical evidence at ${id}, because ${description}`, async () => {
    const shipped = await getArm('shipped');
    const arm = await getArm(id);
    assertArmRanUnderItsPolicy(arm, arm.budgetPolicy);
    assertArmRanUnderItsPolicy(shipped, requireBudgetPolicy());

    assert.deepEqual(
      arm.experiment.stopKindDistribution,
      shipped.experiment.stopKindDistribution,
      `${id} must stop where the shipped policy stops`,
    );
    for (const [exampleId, evidence] of shipped.evidenceByExampleId) {
      assert.deepEqual(
        arm.evidenceByExampleId.get(exampleId),
        evidence,
        `${id} published different evidence from the shipped policy on ${exampleId}: the reserve is bounded by MAX_CHALLENGE_ROUNDS, so only its zero is discriminating`,
      );
    }
  });
}

/**
 * The one arm that differs — and what "differs" turns out to mean.
 *
 * At a reserve of zero the mandatory challenge is refused, so every run stops
 * `budget-exhausted` and the challenge node never executes. That is the whole of
 * the difference: no metric score moves and no resource axis moves. A budget
 * whose only observable effect is the stop kind is not a budget anyone can tune
 * from quality evidence, which is why this item ships a version rather than a
 * new number.
 */
test('exhausts every run at a zero challenge reserve while no metric and no resource axis moves', async () => {
  const shipped = await getArm('shipped');
  const reserveZero = await getArm('reserve-zero');
  assertArmRanUnderItsPolicy(reserveZero, reserveZero.budgetPolicy);
  assertArmRanUnderItsPolicy(shipped, requireBudgetPolicy());

  assert.deepEqual(
    reserveZero.experiment.stopKindDistribution,
    { 'budget-exhausted': shipped.experiment.results.length },
    'a reserve of zero refuses the mandatory challenge, so every run in the partition stops budget-exhausted',
  );

  for (const result of reserveZero.experiment.results) {
    assert.equal(
      result.actualStopKind,
      'budget-exhausted',
      `every run stops budget-exhausted at a zero reserve: ${result.exampleId}`,
    );
    assert.equal(
      reserveZero.traceByExampleId.get(result.exampleId).includes('challenge_hypothesis'),
      false,
      `the challenge node must not execute at a zero reserve: ${result.exampleId}`,
    );
  }

  for (const [exampleId, evidence] of shipped.evidenceByExampleId) {
    const observed = reserveZero.evidenceByExampleId.get(exampleId);
    assert.ok(observed, `the reserve-zero arm is missing ${exampleId}`);
    assert.notDeepEqual(
      observed.actualStopKind,
      evidence.actualStopKind,
      `the reserve is the ONE reached budget, so its zero has to change the stop kind: ${exampleId}`,
    );
    assert.deepEqual(
      observed.metrics,
      evidence.metrics,
      `skipping the mandatory challenge moved a quality metric on ${exampleId}: the finding recorded for AIC-18 is that this budget changes the stop kind and the trace and nothing else`,
    );
    assert.deepEqual(
      observed.resources,
      evidence.resources,
      `skipping the mandatory challenge moved a resource axis on ${exampleId}: the challenge cycle re-enters at execute_investigation, so it counts no logical iteration and replays no further tool call — if that changed, the cost of a challenge round is now measurable and this item's conclusion has to be re-read`,
    );
    assert.deepEqual(
      Object.fromEntries(
        Object.entries(observed.behaviorMetrics).map(([key, metric]) => [key, metric.score]),
      ),
      Object.fromEntries(
        Object.entries(evidence.behaviorMetrics).map(([key, metric]) => [key, metric.score]),
      ),
      `a challenge that never ran scored differently on ${exampleId}: the reason a behaviour metric reports may move (the challenge was not observed), but not one score, or the reserve would be tunable from quality after all`,
    );
  }
});

/* -------------------------------------------------------------------------- */
/* 5. Recovery overhead stays off the logical-budget axes                     */
/* -------------------------------------------------------------------------- */

test('keeps recovery overhead on its own axes rather than compositing it with the logical budget', async () => {
  const { experiment } = await getArm('shipped');

  for (const result of experiment.results) {
    for (const axis of RECOVERY_AXIS_NAMES) {
      assert.equal(
        Object.hasOwn(result.resources ?? {}, axis),
        true,
        `${axis} is its own published axis: a recovery figure folded into the logical spend can fall while quality falls with it`,
      );
    }
  }

  const summarize = requireFunction(
    evals,
    'summarizeBudgetPolicyEvidence',
    '@aic/evals',
  );
  const report = summarize({
    arms: [{ policy: requireBudgetPolicy(), experiment }],
  });
  const [arm] = report.arms;

  for (const axis of RECOVERY_AXIS_NAMES) {
    assert.equal(
      Object.hasOwn(arm.resourceAxes, axis),
      true,
      `${axis} must be reported per policy arm as its own axis, not merged into a recovery-overhead figure`,
    );
  }
  assert.equal(
    BUDGET_FIELD_NAMES.some((field) => Object.hasOwn(arm.resourceAxes, field)),
    false,
    'a budget is what a policy ALLOWED and an axis is what a run SPENT: the report must not file one under the other',
  );
});

/* -------------------------------------------------------------------------- */
/* 6. The report                                                              */
/* -------------------------------------------------------------------------- */

function mean(values) {
  return values.reduce((total, value) => total + value, 0) / values.length;
}

function assertMean(entry, key, values, label) {
  assert.deepEqual(
    Object.keys(entry).sort(),
    AXIS_ENTRY_KEYS,
    `each reported axis carries its key, its mean and how many runs it was measured over, and nothing else: ${label}`,
  );
  assert.equal(entry.key, key, `the entry must name itself: ${label}`);
  assert.equal(
    entry.exampleCount,
    values.length,
    `a mean without the count behind it is not evidence: ${label}`,
  );
  assert.equal(
    Math.abs(entry.mean - mean(values)) < 1e-9,
    true,
    `the reported mean must be the mean of the runs this arm executed: ${label} reported ${String(entry.mean)}, the runs give ${String(mean(values))}`,
  );
}

/** Every key at every depth, so an addition cannot hide under a nested object. */
function everyKey(value, path = '$', seen = []) {
  if (Array.isArray(value)) {
    for (const [index, item] of value.entries()) {
      everyKey(item, `${path}[${String(index)}]`, seen);
    }
    return seen;
  }
  if (value === null || typeof value !== 'object') return seen;
  for (const [key, child] of Object.entries(value)) {
    seen.push({ key, path: `${path}.${key}` });
    everyKey(child, `${path}.${key}`, seen);
  }
  return seen;
}

let budgetPolicyReport;

async function getReport() {
  if (budgetPolicyReport !== undefined) return budgetPolicyReport;

  budgetPolicyReport = (async () => {
    const summarize = requireFunction(
      evals,
      'summarizeBudgetPolicyEvidence',
      '@aic/evals',
    );
    const arms = await getSweep();
    const shippedPolicy = requireBudgetPolicy();
    const inputArms = SWEEP_ARMS.map(({ id, budgetPolicy }) => ({
      policy: budgetPolicy ?? shippedPolicy,
      experiment: arms.get(id).experiment,
    }));
    return { report: summarize({ arms: inputArms }), inputArms };
  })();

  return budgetPolicyReport;
}

test('reports one row per policy arm, keyed by the version that policy declared', async () => {
  const { report, inputArms } = await getReport();

  assert.deepEqual(
    Object.keys(report).sort(),
    REPORT_KEYS,
    'the report is the arms and the calibration statement about them, and nothing else',
  );
  assert.deepEqual(
    report.arms.map(({ policyVersion }) => policyVersion),
    inputArms.map(({ policy }) => policy.policyVersion),
    'one row per arm, in the order the arms were given, each naming the policy version it ran under',
  );
  assert.equal(
    new Set(report.arms.map(({ policyVersion }) => policyVersion)).size,
    report.arms.length,
    'two rows under one version cannot be told apart, which is what keying on the version is for',
  );

  for (const [index, arm] of report.arms.entries()) {
    const { policy, experiment } = inputArms[index];
    assert.deepEqual(
      Object.keys(arm).sort(),
      ARM_KEYS,
      `each arm reports exactly these fields: ${policy.policyVersion}`,
    );
    assert.deepEqual(
      arm.budgets,
      {
        maxIterations: policy.maxIterations,
        llmCallBudget: policy.llmCallBudget,
        reservedChallengeBudget: policy.reservedChallengeBudget,
      },
      `each budget is reported separately, at the value this arm ran under: ${policy.policyVersion}`,
    );
    assert.equal(
      arm.runCount,
      experiment.results.length,
      `the arm must report how many runs are behind it: ${policy.policyVersion}`,
    );
    assert.deepEqual(
      arm.stopKindDistribution,
      experiment.stopKindDistribution,
      `the arm must carry the stop-kind distribution its runs produced: ${policy.policyVersion}`,
    );
  }
});

test('reports every quality metric and every resource axis on its own row', async () => {
  const { report, inputArms } = await getReport();

  for (const [index, arm] of report.arms.entries()) {
    const { policy, experiment } = inputArms[index];
    // Derived from the published evidence rather than restated, so an axis
    // added to the resource schema is reported here or this row goes red.
    const publishedAxes = [
      ...new Set(
        experiment.results.flatMap((result) =>
          Object.keys(result.resources ?? {}).filter((key) => key !== 'schemaVersion'),
        ),
      ),
    ].sort();
    assert.equal(
      publishedAxes.length > 0,
      true,
      'the arm published no resource evidence at all, so this row proves nothing',
    );

    assert.deepEqual(
      Object.keys(arm.resourceAxes).sort(),
      publishedAxes,
      `every measured resource axis gets its own row and nothing else does: ${policy.policyVersion}`,
    );
    for (const axis of publishedAxes) {
      assertMean(
        arm.resourceAxes[axis],
        axis,
        experiment.results.map((result) => result.resources[axis]),
        `${policy.policyVersion} / ${axis}`,
      );
    }

    assert.deepEqual(
      Object.keys(arm.metrics).sort(),
      [...evals.BENCHMARK_METRIC_KEYS].sort(),
      `every benchmark metric gets its own row: ${policy.policyVersion}`,
    );
    for (const key of evals.BENCHMARK_METRIC_KEYS) {
      assertMean(
        arm.metrics[key],
        key,
        experiment.results.map((result) => result.metrics[key].score),
        `${policy.policyVersion} / ${key}`,
      );
    }
  }
});

test('states in the report that llmCallBudget is not empirically calibrated, and why', async () => {
  const { report } = await getReport();

  assert.deepEqual(
    Object.keys(report.calibration).sort(),
    BUDGET_FIELD_NAMES,
    'every budget the policy carries gets a calibration statement, or the reader cannot tell which of them the sweep actually measured',
  );

  for (const field of BUDGET_FIELD_NAMES) {
    const entry = report.calibration[field];
    assert.deepEqual(
      Object.keys(entry).sort(),
      CALIBRATION_ENTRY_KEYS,
      `a calibration statement is the claim and the reason behind it: ${field}`,
    );
    assert.equal(
      typeof entry.empiricallyCalibrated,
      'boolean',
      `${field} must say plainly whether evidence chose its value`,
    );
    assert.equal(
      typeof entry.reason === 'string' && entry.reason.trim().length > 0,
      true,
      `an unexplained calibration claim is the unbacked sentence this repository refuses: ${field}`,
    );
  }

  assert.equal(
    report.calibration.llmCallBudget.empiricallyCalibrated,
    false,
    'no run on this corpus reaches the edge that reads llmCallBudget, so its value was chosen and not measured — publishing it without that statement is the false-confidence failure this report exists to prevent',
  );
  assert.equal(
    new Set(BUDGET_FIELD_NAMES.map((field) => report.calibration[field].reason)).size > 1,
    true,
    'one reason repeated under three budgets is a placeholder: the reserve is reached and the other two are not, and the statements have to say different things',
  );
});

/* -------------------------------------------------------------------------- */
/* 6b. The premise the whole conclusion rests on                              */
/* -------------------------------------------------------------------------- */

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** Every source file under the given roots, skipping build output. */
function sourceFilesUnder(roots) {
  const found = [];
  const walk = (current) => {
    for (const entry of readdirSync(current)) {
      if (entry === 'dist' || entry === 'node_modules') continue;
      const path = join(current, entry);
      if (statSync(path).isDirectory()) {
        walk(path);
        continue;
      }
      if (/\.(ts|mjs|js)$/.test(entry)) found.push(path);
    }
  };
  for (const root of roots) walk(resolve(projectRoot, root));
  return found;
}

/**
 * 🔴 This row, not the sweep rows, is what watches this item's conclusion.
 *
 * The finding is that `maxIterations` and `llmCallBudget` cannot be calibrated
 * by any corpus, and it rests on ONE property of the tree: the edge that reads
 * them is `need-more-evidence`, and nothing outside `test/` returns it. The
 * sweep rows above cannot see that — they build their nodes from
 * `replayBackedNodes`, whose `termination_check` is hardcoded, so they watch the
 * FIXTURE. A model-backed `termination_check` added in `packages/roles` and
 * wired into the lane's model arm — the direction AIC-94 already took for three
 * other roles — would falsify the conclusion and leave every one of them green.
 *
 * ⚠ What this row can and cannot see, because a coarse check trusted as a fine
 * one is worse than none. It finds the STRING, not a return: a new mention is
 * reported and a human decides whether it is a producer, and a route assembled
 * from a variable is invisible. It walks four fixed roots, so a producer in a
 * NEW top-level directory is unwatched. It skips the top-level `test/` but does
 * walk `incident-lab/tests` and would walk a future per-package test directory — a
 * false-positive direction, which is the safe one. And a producer added inside
 * either of the two files it already allows would not redden it.
 */
test('names every non-test file that mentions the route this conclusion depends on', () => {
  const mentions = sourceFilesUnder(['packages', 'scripts', 'incident-lab', 'apps'])
    .filter((path) => readFileSync(path, 'utf8').includes('need-more-evidence'))
    .map((path) => relative(projectRoot, path))
    .sort();

  assert.deepEqual(
    mentions,
    [
      // The route's own type union and its single consumer — the budget edge.
      'packages/graph/src/investigation.ts',
      // This item's prose about why that edge is unreached.
      'packages/evals/src/budget-policy.ts',
    ].sort(),
    'a non-test file started mentioning need-more-evidence: if anything there RETURNS that route, the logical budgets became measurable and this item\'s conclusion — that no corpus can calibrate them — has to be re-read before it is quoted again',
  );
});

/* -------------------------------------------------------------------------- */
/* 7. The policy is read from what the caller OWNS                            */
/* -------------------------------------------------------------------------- */

/**
 * AIC-67 and AIC-69 were both this defect, and the convention they left is
 * repo-wide: a value published as measured is read from an own data property or
 * it is refused. A budget policy is caller-supplied input, and the version
 * string it carries is what every downstream row is keyed by — so a policy
 * assembled from `Object.prototype` is a measurement claim about a run that
 * never happened.
 */
test('refuses a policy whose fields exist only on the prototype', async () => {
  const parse = requireFunction(evals, 'parseBenchmarkBudgetPolicy', '@aic/evals');

  await withPollutedObjectPrototype('policyVersion', 'budget-policy-v0.2', async () => {
    await withPollutedObjectPrototype('maxIterations', 0, async () => {
      await withPollutedObjectPrototype('llmCallBudget', 0, async () => {
        await withPollutedObjectPrototype('reservedChallengeBudget', 0, async () => {
          assert.throws(
            () => parse({}),
            /budget\s*policy/i,
            'an empty object is not a policy: assembling one from the prototype publishes evidence under a version nobody declared',
          );
        });
      });
    });
  });
});

test('refuses a policy whose version exists only on the prototype', async () => {
  const parse = requireFunction(evals, 'parseBenchmarkBudgetPolicy', '@aic/evals');

  await withPollutedObjectPrototype('policyVersion', 'budget-policy-v0.2', async () => {
    assert.throws(
      () => parse({ maxIterations: 0, llmCallBudget: 0, reservedChallengeBudget: 0 }),
      /policyVersion/,
      'a policy that declares no version must be refused, not handed the shipped one off the prototype — that is the exact substitution this parser says it prevents',
    );
  });
});

test('refuses a budget that exists only on the prototype, with the version owned', async () => {
  const parse = requireFunction(evals, 'parseBenchmarkBudgetPolicy', '@aic/evals');

  // The version is checked first and short-circuits, so a policy that owns
  // nothing cannot tell whether the BUDGETS are read from own properties. This
  // row owns everything except one budget, which is the shape a mutation showed
  // the rows above could not see.
  await withPollutedObjectPrototype('reservedChallengeBudget', 7, async () => {
    assert.throws(
      () => parse({
        policyVersion: 'aic-18-owned-version-inherited-budget',
        maxIterations: 4,
        llmCallBudget: 8,
      }),
      /reservedChallengeBudget/,
      'a budget the caller never declared must be refused by name, not taken from the prototype and published as the policy this run executed',
    );
  });
});

test('keeps a validated budget even when an inherited accessor tries to swallow it', async () => {
  const parse = requireFunction(evals, 'parseBenchmarkBudgetPolicy', '@aic/evals');

  await withAccessorPollutedObjectPrototype('maxIterations', 999999, [], async () => {
    const policy = parse({
      policyVersion: 'aic-18-accessor-decoy',
      maxIterations: 4,
      llmCallBudget: 8,
      reservedChallengeBudget: 2,
    });
    assert.equal(
      policy.maxIterations,
      4,
      'the value the caller declared and this parser validated must be the value it returns: an accumulator that writes through the prototype lets an inherited setter rewrite an honest policy',
    );
  });
});

test('refuses an arm that inherits its policy and experiment', async () => {
  const summarize = requireFunction(evals, 'summarizeBudgetPolicyEvidence', '@aic/evals');

  // The `arms` list itself is owned; the ARM inherits both of its fields. The
  // row one level up hands over an inherited `arms` and never reaches this
  // read — measured: reverting these two alone left the whole suite green while
  // an arm built this way published a metric mean of 42 and an axis mean of 99
  // under the shipped version string.
  const arm = Object.create({
    policy: requireBudgetPolicy(),
    experiment: {
      results: [{ metrics: { accuracy: { score: 42 } }, resources: { toolCallsUsed: 99 } }],
      stopKindDistribution: {},
    },
  });

  assert.throws(
    () => summarize({ arms: [arm] }),
    /policy and an experiment/,
    'an arm that owns neither field describes a run the caller never handed over, and this refusal is advertised in the PR description by name — an advertised refusal with no row is a contract nothing holds',
  );
});

/**
 * One row per MEMBER, not one for the pair.
 *
 * The row above hands over an arm inheriting BOTH fields, so it pins the
 * conjunction — measured: either own-read reverted alone left the whole suite
 * green while an arm inheriting only that one field went from refused to
 * publishing a metric mean of 42 under the shipped version string.
 *
 * That is the sentence this branch wrote about somebody else's finding one
 * commit before making the same mistake: a row pins the conjunction, never the
 * member. It is why these two exist separately.
 */
for (const [label, build] of [
  ['policy', (policy, experiment) => Object.assign(Object.create({ policy }), { experiment })],
  ['experiment', (policy, experiment) => Object.assign(Object.create({ experiment }), { policy })],
]) {
  test(`refuses an arm that inherits only its ${label}`, async () => {
    const summarize = requireFunction(evals, 'summarizeBudgetPolicyEvidence', '@aic/evals');
    const experiment = {
      results: [{ metrics: { accuracy: { score: 42 } }, resources: { toolCallsUsed: 99 } }],
      stopKindDistribution: {},
    };

    assert.throws(
      () => summarize({ arms: [build(requireBudgetPolicy(), experiment)] }),
      /policy and an experiment/,
      `an arm that owns one field and inherits the other is still an arm describing a run the caller did not fully hand over: ${label} reached through the prototype must be refused on its own, not only alongside the other`,
    );
  });
}

test('refuses an experiment whose measurements exist only on the prototype', async () => {
  const summarize = requireFunction(evals, 'summarizeBudgetPolicyEvidence', '@aic/evals');
  const arm = { policy: requireBudgetPolicy(), experiment: {} };

  // The arms guard passes here — the caller owns `arms`, `policy` and
  // `experiment`. What it does not own is the MEASUREMENTS, and a report that
  // hardened which policy it names while reading the numbers off the prototype
  // would carry the convention's wording and not its property.
  await withPollutedObjectPrototype('results', [{ metrics: {}, resources: {} }], async () => {
    await withPollutedObjectPrototype('stopKindDistribution', { PWNED: 7 }, async () => {
      assert.throws(
        () => summarize({ arms: [arm] }),
        /results/,
        'an experiment that owns no results is not evidence: publishing an inherited run list as a measured one is the reading this report exists to make impossible',
      );
    });
  });
});

test('refuses an experiment whose stop-kind distribution exists only on the prototype', async () => {
  const summarize = requireFunction(evals, 'summarizeBudgetPolicyEvidence', '@aic/evals');
  const arm = { policy: requireBudgetPolicy(), experiment: { results: [] } };

  // Its own row, because the results guard throws FIRST and would mask this
  // one: a review round measured that deleting this refusal left the suite
  // green, which is what an unpinned guard beside a pinned one looks like.
  await withPollutedObjectPrototype('stopKindDistribution', { PWNED: 7 }, async () => {
    assert.throws(
      () => summarize({ arms: [arm] }),
      /stopKindDistribution/,
      'a distribution read off the prototype describes runs that did not happen, and publishing it beside a real run count is the fabrication this report refuses',
    );
  });
});

test('counts no metric score the run did not own', async () => {
  const summarize = requireFunction(evals, 'summarizeBudgetPolicyEvidence', '@aic/evals');

  // The metric OBJECT is owned; only its score is inherited. That separates the
  // own-read on the score from the own-read on its container, which the row
  // above cannot do.
  const experiment = {
    results: [{ metrics: { accuracy: Object.create({ score: 42 }) }, resources: {} }],
    stopKindDistribution: {},
  };
  const report = summarize({ arms: [{ policy: requireBudgetPolicy(), experiment }] });

  assert.deepEqual(
    report.arms[0].metrics,
    {},
    'a score reached through the prototype is not a score this run measured: it must contribute nothing AND leave no row behind, or the report carries a key whose mean rests on no evidence',
  );
});

test('counts no resource axis the run did not own', async () => {
  const summarize = requireFunction(evals, 'summarizeBudgetPolicyEvidence', '@aic/evals');

  // An OWN accessor, not an inherited value. `Object.keys` returns own keys
  // only, so a resources object that merely INHERITS an axis lists no key at
  // all and the row passes whether the read is hardened or not — measured: that
  // shape left this row green against a plain `[[Get]]`. An own accessor is the
  // shape that separates them: the key is listed, and the value is computed
  // rather than written down.
  const resources = {};
  Object.defineProperty(resources, 'toolCallsUsed', {
    enumerable: true,
    configurable: true,
    get: () => 42,
  });
  const experiment = {
    results: [{ metrics: {}, resources }],
    stopKindDistribution: {},
  };
  const report = summarize({ arms: [{ policy: requireBudgetPolicy(), experiment }] });

  assert.deepEqual(
    report.arms[0].resourceAxes,
    {},
    'a value a getter computes is not spend the run wrote down: publishing it would make the report a measurement of whatever the caller decides to return, which is the property readOwnValue exists to hold',
  );
});

/**
 * The pin behind a sentence three sites make.
 *
 * `budget-policy.ts`, the architecture document and `packages/graph`'s own
 * header all say `llmCallsUsed` is 0
 * on EVERY benchmark run, and the only pointer either offered was
 * `investigation-graph.test.mjs` › "leaves llmCallsUsed at zero when no node
 * declares an llm call" — which drives `fakeNodes` through the graph and never
 * runs a benchmark arm at all. The claim was true and unbacked, which is the
 * shape this repository refuses; it is the same premise family that had already
 * rotted in three places and is corrected by this branch.
 *
 * This row runs the shipped arm and reads the axis. It goes red the day a
 * declaring node enters the benchmark arm — which is precisely the drift the
 * decision record names as what would expire this item's conclusion.
 */
test('measures a declared llm call count of zero on every run of the shipped arm', async () => {
  const { experiment } = await getArm('shipped');

  assert.equal(
    experiment.results.length > 0,
    true,
    'an axis asserted over no runs is not a measurement',
  );
  for (const result of experiment.results) {
    assert.equal(
      result.resources?.declaredLlmCallsUsed,
      0,
      'the replay-backed arm declares no llm call, so this axis reads a real zero rather than an estimated one — if it ever reads otherwise, all three sites that say "0 on every benchmark run" have to be re-read before any of them is quoted again',
    );
  }
});

test('counts no metric or resource container the run did not own', async () => {
  const summarize = requireFunction(evals, 'summarizeBudgetPolicyEvidence', '@aic/evals');

  // The CONTAINERS are inherited, not the numbers inside them. The two rows
  // above hand over owned containers and inherit only the value, so `ownNumber`
  // refuses first and MASKS the container read — measured: reverting the
  // container read alone left the whole suite green while a result owning
  // nothing published a metric mean of 42 and an axis mean of 99, which is
  // verbatim the fabrication this module's own comment cites as fixed.
  //
  // Mutating the expression is not mutating the guards inside it: each needs the
  // shape that reaches it first. No count is written here on purpose — an
  // earlier version of this comment said four and the PR body said five, which
  // is one fact spelled twice and disagreeing. The rows below name the
  // positions instead.
  const result = Object.create({
    metrics: { accuracy: { score: 42 } },
    resources: { toolCallsUsed: 99 },
  });
  const experiment = { results: [result], stopKindDistribution: {} };
  const [arm] = summarize({
    arms: [{ policy: requireBudgetPolicy(), experiment }],
  }).arms;

  assert.deepEqual(
    { ...arm.metrics, ...arm.resourceAxes },
    {},
    'a container reached through the prototype is not a container this run handed over: reading the numbers out of it own-safely proves nothing if the bag they came from was never the run\'s',
  );
});

test('counts only the results that owned their containers, when a run mixes both', async () => {
  const summarize = requireFunction(evals, 'summarizeBudgetPolicyEvidence', '@aic/evals');

  // Two results, mixed ownership. Every row above hands over a SINGLE result,
  // so when its container is inherited the key list is empty and the value path
  // is never walked — the key enumeration reaches the container read first and
  // masks the three call sites on the value path. Measured: reverting any of
  // those three alone left the suite green while publishing a mean drawn from a
  // bag the run never handed over.
  const owned = {
    metrics: { accuracy: { score: 10 } },
    resources: { toolCallsUsed: 10 },
  };
  // Two distinct inheriting shapes, because the container read and the read one
  // level in are separate call sites: one result inherits the CONTAINERS, the
  // other owns `metrics` and `resources` and inherits what sits under each key.
  //
  // ⚠ Those two halves are not symmetric, and calling them both "the record
  // under each key" would invite a later reader to simplify one of them away.
  // Under `metrics` the inherited thing is a RECORD, read by `ownRecord`; under
  // `resources` it is a NUMBER, read by `ownNumber`. So the resources half pins
  // the value read, not a per-key container read.
  const inheritedContainers = Object.create({
    metrics: { accuracy: { score: 90 } },
    resources: { toolCallsUsed: 90 },
  });
  const inheritedRecords = {
    metrics: Object.create({ accuracy: { score: 90 } }),
    resources: Object.create({ toolCallsUsed: 90 }),
  };
  const experiment = {
    results: [owned, inheritedContainers, inheritedRecords],
    stopKindDistribution: {},
  };
  const [arm] = summarize({
    arms: [{ policy: requireBudgetPolicy(), experiment }],
  }).arms;

  assert.deepEqual(
    { metrics: arm.metrics, resourceAxes: arm.resourceAxes },
    {
      metrics: { accuracy: { key: 'accuracy', mean: 10, exampleCount: 1 } },
      resourceAxes: { toolCallsUsed: { key: 'toolCallsUsed', mean: 10, exampleCount: 1 } },
    },
    'the second result owns neither container, so it contributes neither a value nor an example: a mean of 50 over two examples would be an average of one real measurement and one the run never handed over',
  );
});

test('refuses a stop-kind distribution that is owned but is not a record', async () => {
  const summarize = requireFunction(evals, 'summarizeBudgetPolicyEvidence', '@aic/evals');

  // The results guard beside it checks shape as well as presence; this one
  // checked presence only, so an owned string was republished verbatim under a
  // field declared as a record of counts.
  for (const value of ['PWNED', 7, null, true]) {
    assert.throws(
      () => summarize({
        arms: [{
          policy: requireBudgetPolicy(),
          experiment: { results: [], stopKindDistribution: value },
        }],
      }),
      /stopKindDistribution/,
      `an owned ${typeof value} is not a stop-kind distribution: republishing it puts a value in the report that violates the type the report declares`,
    );
  }
});

test('reports no row for a key whose every value was inherited', async () => {
  const summarize = requireFunction(evals, 'summarizeBudgetPolicyEvidence', '@aic/evals');

  const experiment = {
    results: [{ metrics: { accuracy: Object.create({ score: 1 }) }, resources: {} }],
    stopKindDistribution: {},
  };
  // A second arm, whose scores it OWNS. The finite-mean and non-zero-count
  // assertions below are properties of a published row, and the arm above
  // publishes none — so walking its metrics executed the loop zero times and
  // this row asserted the empty case twice instead of asserting both cases once.
  const measuredExperiment = {
    results: [{ metrics: { accuracy: { score: 1 } }, resources: {} }],
    stopKindDistribution: {},
  };
  const [arm, measured] = summarize({
    arms: [
      { policy: requireBudgetPolicy(), experiment },
      { policy: sweepPolicy('aic-18-inherited-beside-measured', 4, 8, 2), experiment: measuredExperiment },
    ],
  }).arms;

  assert.deepEqual(
    arm.metrics,
    {},
    'a key whose every value was inherited must leave no row at all: a row published for it carries a mean that rests on nothing',
  );

  assert.equal(
    Object.keys(measured.metrics).length > 0,
    true,
    'the arm this loop walks must publish at least one row, or the two assertions below execute zero times and this row goes green without checking either of them',
  );
  for (const row of Object.values(measured.metrics)) {
    assert.equal(
      Number.isFinite(row.mean),
      true,
      'a published row must carry a finite mean: NaN serialises to null and reads as a measurement that came back empty, rather than as no measurement at all',
    );
    assert.equal(row.exampleCount > 0, true, 'a row with no runs behind it is not evidence');
  }
});

test('refuses a report whose arms exist only on the prototype', async () => {
  const summarize = requireFunction(evals, 'summarizeBudgetPolicyEvidence', '@aic/evals');
  const arm = {
    policy: requireBudgetPolicy(),
    experiment: { results: [], stopKindDistribution: {} },
  };

  await withPollutedObjectPrototype('arms', [arm], async () => {
    assert.throws(
      () => summarize({}),
      /arm/i,
      'a report assembled from the prototype is a published measurement of runs the caller never handed over',
    );
  });
});

test('carries one calibration statement per declared budget field, and no other', async () => {
  const { report } = await getReport();

  // A correspondence check, in both directions, because the two spellings of
  // "which budgets exist" live in different shapes: an exported array the
  // validator walks, and the calibration statements the report publishes. They
  // agreed by hand until a mutation showed nothing made them: removing a field
  // from the array left it unvalidated while the report still carried a
  // statement about it, which is the reassurance-shaped drift this row refuses.
  assert.deepEqual(
    Object.keys(report.calibration).sort(),
    [...evals.BENCHMARK_BUDGET_FIELDS].sort(),
    'every declared budget gets exactly one calibration statement and nothing else does: a statement about a budget the validator no longer knows is a claim about a number nobody checks',
  );
});

test('publishes no composite or aggregate score anywhere in the report', async () => {
  const { report } = await getReport();

  const offenders = everyKey(report).filter(({ key }) =>
    COMPOSITE_KEY_PATTERN.test(key),
  );
  assert.deepEqual(
    offenders,
    [],
    'a single number blending quality with spend, or the logical budget with recovery, can fall while quality falls with it — every dimension stays its own row, at every depth',
  );
});

/* -------------------------------------------------------------------------- */
/* 8. A member of a list is not a member the caller wrote down                 */
/* -------------------------------------------------------------------------- */

/**
 * The rows above harden how a single arm and a single result are READ. None of
 * them hands over a list whose MEMBERSHIP is a lie — a hole, a null, a string —
 * and `Array.prototype.map` decides an index exists with HasProperty, which
 * walks the prototype chain. So every own-read below the list is answered
 * honestly about an element the caller never wrote down.
 *
 * All of it lands in the same published shape: a row that names a policy
 * version, carries a run count and reads as a measurement.
 */

/** The one arm of a report built from this experiment, for the rows below. */
function reportFor(experiment, policy = requireBudgetPolicy()) {
  const summarize = requireFunction(evals, 'summarizeBudgetPolicyEvidence', '@aic/evals');
  return summarize({ arms: [{ policy, experiment }] }).arms[0];
}

/** The same call, undone, so `assert.throws` can drive it. */
function summarizing(experiment, policy = requireBudgetPolicy()) {
  const summarize = requireFunction(evals, 'summarizeBudgetPolicyEvidence', '@aic/evals');
  return () => summarize({ arms: [{ policy, experiment }] });
}

/**
 * What a call did, captured, so the assertion runs after the decoy is gone.
 *
 * The two rows that plant an INDEX on `Object.prototype` poison every `[0]` and
 * `[1]` read in the process, including the ones `assert` performs while it
 * builds a failure message. The helper's `finally` restores the prototype
 * whatever happens, and this keeps the assertion itself outside the window.
 */
function capture(call) {
  try {
    return { returned: call() };
  } catch (error) {
    return { error };
  }
}

test('refuses an arms list with a hole in it, naming the index', () => {
  const summarize = requireFunction(evals, 'summarizeBudgetPolicyEvidence', '@aic/evals');
  const arms = [{
    policy: sweepPolicy('aic-18-dense-arm', 4, 8, 2),
    experiment: { results: [], stopKindDistribution: {} },
  }];
  arms.length = 2;

  assert.throws(
    () => summarize({ arms }),
    (error) => {
      assert.match(
        error.message,
        /budget\s*policy/i,
        `the refusal must name what it refused: ${error.message}`,
      );
      assert.match(
        error.message,
        /\b1\b/,
        `the refusal must name the index nobody filled in, or the caller is told an arms list is wrong without being told which arm: ${error.message}`,
      );
      return true;
    },
    'an index the caller never wrote to is published today as a null arm: a row that was never parsed, never version-checked and never deduplicated, sitting in a list every reader takes to be one arm per policy that ran',
  );
});

test('refuses an arms list whose hole is answered by the prototype', async () => {
  const summarize = requireFunction(evals, 'summarizeBudgetPolicyEvidence', '@aic/evals');
  const decoy = {
    policy: sweepPolicy('PWNED', 1, 1, 1),
    experiment: {
      results: [{ metrics: { accuracy: { score: 99 } }, resources: {} }],
      stopKindDistribution: {},
    },
  };

  // `map` asks HasProperty, not "did the caller write this down", so a hole in
  // an arms list is filled from `Object.prototype` and published as an arm.
  let outcome;
  await withPollutedObjectPrototype('0', decoy, async () => {
    outcome = capture(() => summarize({ arms: new Array(1) }));
  });

  assert.ok(
    outcome.error,
    `an arm assembled from the prototype is a whole policy row nobody declared — measured at head: it published policyVersion PWNED with a metric mean of 99, which is the fabrication every own-read in this module exists to refuse, arriving one level above where those reads look: ${JSON.stringify(outcome.returned)}`,
  );
  assert.match(
    outcome.error.message,
    /arm/i,
    `the refusal must say the arms list is what it refused: ${outcome.error.message}`,
  );
});

test('refuses a results list whose hole is answered by the prototype, naming the index', async () => {
  const summarize = requireFunction(evals, 'summarizeBudgetPolicyEvidence', '@aic/evals');

  // Verbatim the scenario `budget-policy.ts` (the comment above the own-read on
  // `results`) says it closed: an experiment owning nothing publishes a run
  // count and a metric mean of 42. Owning the `results` array does not close
  // it, because the elements of that array are still HasProperty reads.
  let outcome;
  await withPollutedObjectPrototype('0', { metrics: { accuracy: { score: 42 } } }, async () => {
    outcome = capture(() => summarize({
      arms: [{
        policy: requireBudgetPolicy(),
        experiment: { results: new Array(3), stopKindDistribution: {} },
      }],
    }));
  });

  assert.ok(
    outcome.error,
    `a run the caller never wrote into the results list is not a run: measured at head this published runCount 3 and a metric mean of 42 off a single prototype entry, which is the exact fabrication the module comment claims to have fixed — the fix reached the experiment's own read of results and stopped above its elements: ${JSON.stringify(outcome.returned)}`,
  );
  assert.match(
    outcome.error.message,
    /\b0\b/,
    `the refusal must name the index that was never filled in, or a caller with a long results list is told nothing about where to look: ${outcome.error.message}`,
  );
});

for (const [label, entry] of [
  ['null', null],
  ['a string', 'x'],
  ['a number', 1],
  ['undefined', undefined],
]) {
  test(`refuses a results entry that is ${label}, rather than counting it as a run`, () => {
    const results = [{ metrics: { accuracy: { score: 1 } }, resources: {} }, entry];

    assert.throws(
      summarizing({ results, stopKindDistribution: {} }),
      (error) => {
        assert.match(
          error.message,
          /budget\s*policy/i,
          `the refusal must name what it refused: ${error.message}`,
        );
        assert.match(
          error.message,
          /\b1\b/,
          `the refusal must name the entry that is not a run: ${error.message}`,
        );
        return true;
      },
      `a results entry that is not an object is counted in runCount today and measured in nothing: the arm publishes more runs than it has measurements, so every mean beside it rests on fewer examples than the count claims — which is the "looks like a measurement, rests on nothing" reading this report refuses`,
    );
  });
}

test('names the arm it refused when an arms entry is null', () => {
  const summarize = requireFunction(evals, 'summarizeBudgetPolicyEvidence', '@aic/evals');

  assert.throws(
    () => summarize({ arms: [null] }),
    (error) => {
      assert.match(
        error.message,
        /budget\s*policy/i,
        `every refusal in this module names what it refused, so the caller is told which input to fix rather than that "something" was wrong: ${error.message}`,
      );
      assert.match(
        error.message,
        /\b0\b|null|arm/i,
        `the refusal must name the offending element: ${error.message}`,
      );
      return true;
    },
    'at head this leaves the module through a raw TypeError from Object.getOwnPropertyDescriptor — "Cannot convert undefined or null to object" — which names no arm, no index and no field, and reads to a caller as a bug in the report rather than as the malformed input it is',
  );
});

/* -------------------------------------------------------------------------- */
/* 9. A published mean is finite, or there is no row                           */
/* -------------------------------------------------------------------------- */

/**
 * `budget-policy.ts` calls a row of `mean: null` against a non-zero
 * `exampleCount` "the reading this whole report exists to refuse", and the
 * inherited-value path really does refuse it. The measured path does not: a
 * `typeof value === 'number'` test admits `NaN` and `Infinity`, and both
 * serialise to `null` in the published JSON.
 *
 * The rule these rows pin is the one the module already states for an inherited
 * value: a measurement that is not a number contributes NOTHING to the mean,
 * and if that leaves the key with no values, no row is published at all.
 */

test('excludes a non-finite metric score from the mean it publishes', () => {
  const arm = reportFor({
    results: [
      { metrics: { accuracy: { score: NaN } }, resources: {} },
      { metrics: { accuracy: { score: 1 } }, resources: {} },
    ],
    stopKindDistribution: {},
  });

  assert.deepEqual(
    arm.metrics,
    { accuracy: { key: 'accuracy', mean: 1, exampleCount: 1 } },
    'measured at head this publishes mean null over exampleCount 2: one run that scored nothing readable drags the whole key to null while the count still claims two runs are behind it, so a policy arm with one broken score reads as a policy that measured nothing rather than as one measurement plus one unreadable value',
  );
});

test('reports no metric row when every score was non-finite', () => {
  const arm = reportFor({
    results: [{ metrics: { accuracy: { score: NaN } }, resources: {} }],
    stopKindDistribution: {},
  });

  assert.deepEqual(
    arm.metrics,
    {},
    'a key whose only score was unreadable measured nothing, exactly as a key whose only score was inherited measured nothing: publishing the row anyway puts mean null beside exampleCount 1 in the report, which reads as a measurement that came back empty rather than as no measurement at all',
  );
});

test('excludes a non-finite resource reading from the axis mean', () => {
  const arm = reportFor({
    results: [
      { metrics: {}, resources: { toolCallsUsed: Infinity } },
      { metrics: {}, resources: { toolCallsUsed: 2 } },
    ],
    stopKindDistribution: {},
  });

  assert.deepEqual(
    arm.resourceAxes,
    { toolCallsUsed: { key: 'toolCallsUsed', mean: 2, exampleCount: 1 } },
    'the resource path reads its numbers through the same predicate as the metric path and admits the same non-finite values: an arm that spent 2 tool calls on its one readable run publishes mean null, and a cost axis that reports null is a cost comparison nobody can make',
  );
});

test('reports no resource axis row when every reading was non-finite', () => {
  const arm = reportFor({
    results: [{ metrics: {}, resources: { toolCallsUsed: Infinity } }],
    stopKindDistribution: {},
  });

  assert.deepEqual(
    arm.resourceAxes,
    {},
    'an axis whose only reading was unreadable measured nothing, and a row published for it claims a spend figure this arm never produced',
  );
});

test('publishes a finite mean when two readings overflow the sum they are averaged through', () => {
  const arm = reportFor({
    results: [
      { metrics: {}, resources: { toolCallsUsed: Number.MAX_VALUE } },
      { metrics: {}, resources: { toolCallsUsed: Number.MAX_VALUE } },
    ],
    stopKindDistribution: {},
  });

  assert.deepEqual(
    { exampleCount: arm.resourceAxes.toolCallsUsed?.exampleCount, finite: Number.isFinite(arm.resourceAxes.toolCallsUsed?.mean) },
    { exampleCount: 2, finite: true },
    'both readings are finite, so their mean is finite: summing first makes it Infinity, which serialises to null and publishes a row that says two runs measured nothing while both of them measured something — the same unreadable row the non-finite inputs above produce, reached from inputs the module accepts on purpose',
  );
});

/* -------------------------------------------------------------------------- */
/* 10. The stop-kind distribution is counts, and it is the report's own copy   */
/* -------------------------------------------------------------------------- */

/**
 * The row above ("refuses a stop-kind distribution that is owned but is not a
 * record") pins the four non-objects. An array IS an object, and the values
 * inside a real object are not checked at all — both come back verbatim under a
 * field the report declares as `Readonly<Record<string, number>>`.
 *
 * And "comes back" is literal: the caller's object is republished by reference
 * and unfrozen, so the report is a live view of a container the caller still
 * holds.
 */

test('refuses a stop-kind distribution that is an array', () => {
  assert.throws(
    summarizing({ results: [], stopKindDistribution: ['not', 'a', 'record'] }),
    /stopKindDistribution/,
    'an array passes a typeof object check and is republished verbatim: the report then declares a record of stop-kind counts and carries a list of strings, so anything that reads it by stop-kind name gets undefined and anything that iterates it counts positions',
  );
});

for (const [label, count] of [
  ['a string', 'lots'],
  ['a nested object', { nested: true }],
  ['null', null],
  ['NaN', NaN],
  ['Infinity', Infinity],
]) {
  test(`refuses a stop-kind count that is ${label}`, () => {
    assert.throws(
      summarizing({ results: [], stopKindDistribution: { sufficient: count } }),
      /stopKindDistribution/,
      `a stop-kind distribution is how many runs stopped each way, and ${label} is not a count: republished, it puts a value in the report that violates the type the report declares, and the reading it produces — a stop kind that happened "lots" of times, or null times — is exactly the measurement-shaped nonsense this module refuses everywhere else`,
    );
  });
}

test('publishes the stop-kind distribution as the report\'s own frozen copy', () => {
  const distribution = { sufficient: 1 };
  const arm = reportFor({ results: [], stopKindDistribution: distribution });

  assert.notEqual(
    arm.stopKindDistribution,
    distribution,
    'the report republishes the caller\'s object itself, so the published evidence is a live view of a container the caller still holds',
  );
  assert.equal(
    Object.isFrozen(arm.stopKindDistribution),
    true,
    'every other value this module publishes is frozen, because a report is a record of what happened and not a mutable working object',
  );

  distribution.ghostStopKind = 99;
  assert.deepEqual(
    Object.entries(arm.stopKindDistribution),
    [['sufficient', 1]],
    'a stop kind added to the caller\'s object AFTER the report was produced appears in the report: the published distribution then describes runs that were not in the experiment it names, and nothing about the report says when it stopped being true',
  );
});

/**
 * ⚠ **The property this section deliberately does NOT assert, and why.**
 *
 * A key planted on `Object.prototype` after publication reads through the
 * published distribution, because the copy is an ordinary object. A row
 * demanding otherwise was written here and removed: the only implementation
 * that satisfies it is a null-prototype copy, which turns
 * "reports one row per policy arm, keyed by the version that policy declared"
 * red — `deepStrictEqual` compares prototypes — and which would single out one
 * field of the report while `metrics`, `resourceAxes`, `budgets` and
 * `calibration` are all ordinary `Object.fromEntries` records with exactly the
 * same exposure.
 *
 * So the property the copy buys is stated at its width and no wider: the report
 * does not change when the CALLER'S object changes. Pollution of the reader's
 * own realm is not something any record in this report defends against, and
 * `budget-policy.ts` says so at the site.
 */

/* -------------------------------------------------------------------------- */
/* 11. The refusals the module states and nothing reached                      */
/* -------------------------------------------------------------------------- */

/**
 * These six rows are GREEN at head. They are here because each names a refusal
 * the module makes and no row exercised — including one advertised in the
 * module's own contract prose and in `docs/decisions/budget-policy-not-calibrated.md`.
 * An unpinned refusal is one deletion away from a fail-open nobody notices.
 */

for (const [label, input] of [['null', null], ['a string', 'x']]) {
  test(`refuses a report request that is ${label}`, () => {
    const summarize = requireFunction(evals, 'summarizeBudgetPolicyEvidence', '@aic/evals');
    assert.throws(
      () => summarize(input),
      /budget\s*policy/i,
      'a report has to be asked for with an options object carrying arms: anything else is a caller error that must stop here rather than reach a property read further in',
    );
  });
}

test('refuses an arms field that is owned but is not an array', () => {
  const summarize = requireFunction(evals, 'summarizeBudgetPolicyEvidence', '@aic/evals');
  assert.throws(
    () => summarize({ arms: 'x' }),
    /arms/,
    'the prototype row beside this one only ever hands over an ABSENT arms field, so the shape half of this guard was unreached: an owned non-array is the half that decides whether a caller who passes one arm instead of a list of them is refused or walked as characters',
  );
});

test('refuses an empty arms list', () => {
  const summarize = requireFunction(evals, 'summarizeBudgetPolicyEvidence', '@aic/evals');
  assert.throws(
    () => summarize({ arms: [] }),
    /arm/i,
    'a report over no arms is a page of calibration statements with no evidence under them, published in the same shape as a report that measured something',
  );
});

test('refuses two arms declaring the same policy version', () => {
  const summarize = requireFunction(evals, 'summarizeBudgetPolicyEvidence', '@aic/evals');
  const experiment = { results: [], stopKindDistribution: {} };

  assert.throws(
    () => summarize({
      arms: [
        { policy: sweepPolicy('aic-18-same-version', 4, 8, 2), experiment },
        { policy: sweepPolicy('aic-18-same-version', 0, 0, 0), experiment },
      ],
    }),
    /aic-18-same-version/,
    'this refusal is advertised in the module\'s own contract prose and in docs/decisions/budget-policy-not-calibrated.md and was pinned by nothing: two rows under one version cannot be told apart, so a sweep that accidentally reuses a version publishes two policies\' evidence as one policy\'s',
  );
});

test('refuses an experiment whose results is owned but is not an array', () => {
  assert.throws(
    summarizing({ results: 'x', stopKindDistribution: {} }),
    /results/,
    'the prototype row for this guard hands over an absent results field, so only the presence half was reached: an owned non-array is what decides whether a caller who passes one result instead of a list is refused or measured by its characters',
  );
});

test('refuses a budget above the safe-integer range, by field name', () => {
  const parse = requireFunction(evals, 'parseBenchmarkBudgetPolicy', '@aic/evals');

  assert.throws(
    () => parse(sweepPolicy('aic-18-unsafe-budget', 2 ** 53, 8, 2)),
    /maxIterations/,
    'a budget past 2**53 no longer counts: the integers stop being distinct, so a run bounded by it is bounded by a number that cannot be decremented reliably — and the MALFORMED_POLICIES table above reaches every other clause of this predicate but not this one',
  );
});

/**
 * The predicate and the schema, pinned as an AGREEMENT rather than as an
 * implementation.
 *
 * `packages/evals/src/budget-policy.ts` hand-restates what `@aic/domain` exports
 * as `LogicalCountSchema` and what the graph enforces these same three fields
 * with. `packages/graph/src/investigation.ts` records that this exact
 * duplication already drifted once and agreed with the schema by luck. This row
 * survives replacing the predicate with the schema, and goes red the day the two
 * answers differ on any value in the table — which is the property, not the call.
 */
test('accepts a budget exactly when the shared logical-count schema accepts it', async () => {
  const parse = requireFunction(evals, 'parseBenchmarkBudgetPolicy', '@aic/evals');
  // Imported here rather than at the top of the file: the rows above are read
  // by line number by a reviewer while this is being written.
  const { LogicalCountSchema } = await import('@aic/domain');

  const answers = [0, 1, 4, 2 ** 53 - 1, 2 ** 53, 1e21, Number.MAX_VALUE, NaN, Infinity, -1, 1.5, -0]
    .map((value) => {
      let accepted = true;
      try {
        parse(sweepPolicy('aic-18-schema-agreement', value, 8, 2));
      } catch {
        accepted = false;
      }
      return {
        value: String(value),
        parser: accepted,
        schema: LogicalCountSchema.safeParse(value).success,
      };
    });

  assert.deepEqual(
    answers.filter(({ parser, schema }) => parser !== schema),
    [],
    'a budget the graph would refuse must be a budget this parser refuses, and the other way round: two spellings of "what a logical count is" drift, and the one nobody is looking at is the one that is wrong — a policy accepted here and rejected downstream fails halfway through a corpus, and one accepted downstream and rejected here cannot be swept at all',
  );
});

/* -------------------------------------------------------------------------- */
/* 12. An absent option defaults; an unreadable one is refused                 */
/* -------------------------------------------------------------------------- */

/**
 * `tsconfig.base.json` does not set `exactOptionalPropertyTypes`, so
 * `budgetPolicy: undefined` is TypeScript's own spelling of "absent" on an
 * optional property, and a caller that assembles options with a spread writes it
 * without meaning anything by it. The helper at the top of this file already
 * has to spread-guard around it.
 *
 * The asymmetry these two rows pin, since it is the thing a later reader will
 * want to undo: `undefined` is ABSENT and takes the shipped policy, `null` is
 * PRESENT in a shape the runner cannot read and is refused
 * (the MALFORMED_POLICIES entry "an explicitly null policy"). An option nobody
 * set must not stop a corpus; an option somebody set to a wrong value must.
 */

const OBSERVED_THEN_STOPPED = 'aic-18-stopped-after-observing-the-control-block';

/**
 * The budgets the graph was actually started with, read from inside the first
 * lifecycle node and then stopped — the same observation idiom as the sweep
 * above, without running a corpus to learn one thing.
 */
async function budgetsTheGraphStartedWith(buildOptions) {
  const runGraphBenchmarkExperiment = requireFunction(
    evals,
    'runGraphBenchmarkExperiment',
    '@aic/evals',
  );
  const traces = new Map();
  const replayCounts = new Map();
  const observed = new Set();

  try {
    await runGraphBenchmarkExperiment(buildOptions({
      experimentId: 'aic-18-budget-policy-option-v0.2',
      scenarioSet: 'calibration',
      runsPerScenario: RUNS_PER_SCENARIO,
      metadata: benchmarkVersions,
      createNodes: (input) => {
        traces.set(input.runId, []);
        replayCounts.set(input.runId, 0);
        const nodes = replayBackedNodes(input, traces, replayCounts);
        return {
          ...nodes,
          async normalize_incident(state) {
            observed.add(JSON.stringify({
              maxIterations: state.control.maxIterations,
              llmCallBudget: state.control.llmCallBudget,
              reservedChallengeBudget: state.control.reservedChallengeBudget,
            }));
            throw new Error(OBSERVED_THEN_STOPPED);
          },
        };
      },
      async recordEvaluation() {},
    }));
  } catch (error) {
    if (error.message !== OBSERVED_THEN_STOPPED) {
      return { refusal: error, observed: [...observed] };
    }
  }

  return { observed: [...observed] };
}

function shippedControlBlock() {
  const policy = requireBudgetPolicy();
  return JSON.stringify({
    maxIterations: policy.maxIterations,
    llmCallBudget: policy.llmCallBudget,
    reservedChallengeBudget: policy.reservedChallengeBudget,
  });
}

test('starts from the shipped policy when budgetPolicy is present but undefined', async () => {
  const { refusal, observed } = await budgetsTheGraphStartedWith((base) => ({
    ...base,
    budgetPolicy: undefined,
  }));

  assert.equal(
    refusal?.message,
    undefined,
    `without exactOptionalPropertyTypes, budgetPolicy: undefined is how TypeScript spells an absent optional property, so this option is type-legal and means nothing — refusing it makes the declared type a lie and stops a corpus over an option nobody set: ${String(refusal?.message)}`,
  );
  assert.deepEqual(
    observed,
    [shippedControlBlock()],
    'an option that was never really set must default to the shipped policy, exactly as an omitted one does — the JSDoc on this option promises that in so many words',
  );
});

test('starts from the shipped policy when budgetPolicy is only inherited', async () => {
  const ghost = sweepPolicy('aic-18-inherited-option', 0, 0, 0);
  const { refusal, observed } = await budgetsTheGraphStartedWith((base) =>
    Object.assign(Object.create({ budgetPolicy: ghost }), base));

  assert.equal(refusal?.message, undefined, `an inherited option is not an option this caller set: ${String(refusal?.message)}`);
  assert.deepEqual(
    observed,
    [shippedControlBlock()],
    'a policy reached through the prototype chain is not a policy the caller declared, so it is absent and the shipped one runs: picking it up instead would run a whole corpus under budgets nobody asked for and publish it under that policy\'s version',
  );
});

/* -------------------------------------------------------------------------- */
/* 13. The two spellings of "which budgets exist"                              */
/* -------------------------------------------------------------------------- */

/**
 * ⚠ **The existing row is kept and is not this claim.**
 * "carries one calibration statement per declared budget field, and no other"
 * compares `Object.keys(report.calibration)` with `BENCHMARK_BUDGET_FIELDS` —
 * but `calibration` is built by `Object.fromEntries(BENCHMARK_BUDGET_FIELDS.map(…))`,
 * so its keys ARE that list by construction and the assertion cannot fail. It
 * still pins that the report publishes the derived record rather than a literal,
 * which is worth keeping; it is not a correspondence check.
 *
 * The real gap is one direction the compiler does not close either: a
 * `CALIBRATION` statement for a budget the field list does not declare compiles
 * clean and is silently dropped from every report. That contradicts the module
 * comment above `BENCHMARK_BUDGET_FIELDS`, which claims the compiler makes the
 * two agree in both directions.
 *
 * This row reads the constant out of the source because both constants are
 * frozen and `CALIBRATION` is module-private: nothing a caller can do makes the
 * two diverge at runtime, so no runtime row can reach the drift.
 */
test('declares a calibration statement for exactly the budgets the field list carries', () => {
  const source = readFileSync(
    resolve(projectRoot, 'packages/evals/src/budget-policy.ts'),
    'utf8',
  );
  const declaration = source.slice(source.indexOf('const CALIBRATION'));
  const end = declaration.indexOf('\n});');
  assert.equal(
    end > 0,
    true,
    'the CALIBRATION literal was not found where this row reads it: a correspondence check that cannot find one of the two things it compares reports agreement it never measured',
  );

  const statedBudgets = [...declaration.slice(0, end).matchAll(/^ {2}([A-Za-z_$][\w$]*):/gm)]
    .map(([, field]) => field)
    .sort();
  assert.equal(
    statedBudgets.length > 0,
    true,
    'no statement was extracted at all, so the comparison below would pass against an empty list — the vacuous-loop failure this file already made once',
  );

  assert.deepEqual(
    statedBudgets,
    [...evals.BENCHMARK_BUDGET_FIELDS].sort(),
    'a statement for a budget the field list does not declare compiles clean and is dropped from every report: the module then carries a written, reviewed claim about a budget nothing validates and nothing publishes, while the report reads complete — which is the reassurance-shaped drift the correspondence rule exists to catch, and the compiler closes only the other direction',
  );
});
