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
import test from 'node:test';

import * as evals from '@aic/evals';

import {
  benchmarkVersions,
  replayBackedNodes,
  requireFunction,
} from './fixtures/benchmark-experiment.mjs';

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
