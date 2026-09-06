/**
 * The benchmark-experiment machinery, in one implementation.
 *
 * `getControlledMutationCycle()` builds the three experiments the AIC-13
 * acceptance rows are read from: an accepted baseline, a candidate with exactly
 * one required evidence fingerprint removed, and a restored baseline afterwards.
 * An evidence run that recorded those three from a hand-written copy of this
 * code would be evidence about the copy, so this file is the shared source and
 * `test/benchmark-evaluation.test.mjs` imports it rather than owning it —
 * `.claude/rules/invariants.md` ("One mechanism, one implementation").
 *
 * The cycle is memoised on the module, so it runs once per process however many
 * callers await it. ⚠ It carries no correctness weight: every caller destructures
 * from one `await getControlledMutationCycle()` — grep the call sites — so no
 * assertion compares values obtained from two separate invocations. A caller that
 * did compare across invocations would be relying on a property no test pins.
 *
 * The rejected-promise case is cached with the rest: a cycle that throws stays
 * thrown for the life of the process, so an out-of-suite run cannot retry it
 * in-process. That is the memo's one visible cost, and it is worth knowing before
 * relying on it outside the suite.
 *
 * Not here: `currentHeadSha()`. It stays in the test file because it spawns a
 * child process, and `test/child-process-environment.test.mjs` ›
 * "imports the child-environment fixture in every file that spawns a child
 * process" recognises the shared allow-list by the specifier
 * `…/fixtures/child-env.mjs` — which a sibling of `child-env.mjs` importing
 * `./child-env.mjs` does not write. Moving the spawn here would either turn that
 * audit red or make this file spell its import to satisfy a regex.
 *
 * This module is discovered by `node --test` alongside the suite's test files —
 * `node --test --test-reporter=spec` lists it — so it is also executed in a
 * process of its own. It therefore declares no tests and does no work at import
 * time; the cycle is built on the first await.
 */
import assert from 'node:assert/strict';

import { STATUS_RULES_VERSION } from '@aic/domain';
import * as evals from '@aic/evals';
import { createReplayFixtureKey } from '@aic/tools';
import { ReplayToolAdapter } from '@aic/tools/replay';

export const benchmarkVersions = Object.freeze({
  graphVersion: 'graph-v0.1',
  promptVersion: 'prompt-v0.1',
  toolsetVersion: 'toolset-v0.1',
  statusRulesVersion: STATUS_RULES_VERSION,
  evaluatorVersion: evals.BEHAVIOR_EVALUATOR_VERSION,
  toolMode: 'replay',
  knowledgeSetVersion: 'knowledge-none-v0.1',
  memoryEnabled: false,
  temperature: 0,
  seed: 17,
  docsAvailable: false,
});

export function requireFunction(packageNamespace, name, packageName) {
  assert.equal(
    typeof packageNamespace[name],
    'function',
    `${packageName} must export ${name}`,
  );
  return packageNamespace[name];
}

export function perfectOutcomeFor(scenario) {
  return {
    claims: [{ evidenceIds: ['supporting-evidence'] }],
    supportingEvidenceIds: ['supporting-evidence'],
    evidenceFingerprints: scenario.groundTruth.expectedEvidence.map(
      (fingerprint) => ({ ...fingerprint }),
    ),
    stopKind: scenario.groundTruth.expectedStopKind,
    conclusionKind: scenario.groundTruth.expectedConclusionKind,
  };
}

/**
 * A perfect outcome on EVERY metric the gate compares, not only the v0.1 three.
 *
 * `perfectOutcomeFor` above reports no misleading evidence, no root cause and
 * no challenge observation, so TWO of the three behavior metrics score 0
 * against it — `misleading_evidence_handling` and `challenge_effect`.
 * `false_alert_correctness` is the exception and scores 1, because
 * `evaluateFalseAlertOutcome` reads only stopKind, conclusionKind and
 * evidenceFingerprints, all of which that outcome already sets correctly.
 *
 * Those two zeroes were invisible while the regression gate compared the v0.1
 * metrics alone; once it compares the union, a baseline has to be green on
 * every metric before a mutation's behavior regression means anything.
 *
 * Kept separate from `perfectOutcomeFor` rather than folded into it: every
 * other caller uses that one to exercise the v0.1 surface, and widening it
 * there would change what those tests hand the evaluators for no reason they
 * asked for. No count of those callers is written here on purpose — a
 * hand-written tally of call sites is wrong the first time somebody adds one,
 * and `git grep` answers it correctly every time.
 */
export function behaviorPerfectOutcomeFor(scenario) {
  const { groundTruth } = scenario;
  const misleadingEvidence = groundTruth.misleadingEvidence ?? [];
  const leaderId = `leader-${scenario.id}`;

  return {
    ...perfectOutcomeFor(scenario),
    evidenceFingerprints: [
      ...groundTruth.expectedEvidence,
      ...misleadingEvidence,
    ].map((fingerprint) => ({ ...fingerprint })),
    ...(groundTruth.rootCause === undefined
      ? {}
      : { rootCause: groundTruth.rootCause, rootCauseHypothesisId: leaderId }),
    evidenceAssessments: misleadingEvidence.map((fingerprint) => ({
      fingerprint: { ...fingerprint },
      hypothesisId: leaderId,
      effect: 'contradicts',
    })),
    ...(groundTruth.expectedLeaderChangeAfterChallenge === undefined
      ? {}
      : {
          challengeEffect: {
            challengeNodeExecuted: true,
            challengeInvocationCount: 1,
            leaderBeforeChallengeId: leaderId,
            leaderAfterChallengeId:
              groundTruth.expectedLeaderChangeAfterChallenge
                ? `${leaderId}-alternative`
                : leaderId,
            executedDiscriminatingTrialCount: 1,
          },
        }),
  };
}

const acceptedV01ScenarioIds = [
  'bad-deployment',
  'db-pool-exhaustion',
  'false-alert',
  'deployment-caused-incident-a',
  'dependency-caused-incident-b',
];

function acceptedV01Scenarios() {
  return acceptedV01ScenarioIds.map((scenarioId) => {
    const scenario = evals.REPLAY_SCENARIOS.find(({ id }) => id === scenarioId);
    assert.ok(scenario, `missing accepted v0.1 scenario: ${scenarioId}`);
    return scenario;
  });
}

async function runOutcomeExperiment(experimentId, mutateOutcome = (outcome) => outcome) {
  const runBenchmarkExperiment = requireFunction(
    evals,
    'runBenchmarkExperiment',
    '@aic/evals',
  );

  const scenarios = acceptedV01Scenarios();
  const scenariosById = new Map(
    scenarios.map((scenario) => [scenario.id, scenario]),
  );

  return runBenchmarkExperiment({
    experimentId,
    scenarioSet: 'ad-hoc',
    scenarios,
    runsPerScenario: 3,
    metadata: benchmarkVersions,
    async investigate(input) {
      const scenario = scenariosById.get(input.scenarioId);
      assert.ok(scenario, `missing execution scenario: ${input.scenarioId}`);
      // Behavior-perfect, because this cycle feeds the regression gate, and the
      // gate refuses a baseline that is red on any metric it compares.
      return mutateOutcome(behaviorPerfectOutcomeFor(scenario), input);
    },
    async recordEvaluation() {},
  });
}

let controlledMutationCycle;

export async function getControlledMutationCycle() {
  if (controlledMutationCycle !== undefined) return controlledMutationCycle;

  controlledMutationCycle = (async () => {
    const replayScenariosBefore = JSON.stringify(evals.REPLAY_SCENARIOS);
    const baseline = await runOutcomeExperiment('aic-11-baseline-v0.1');
    let removedRequiredFingerprint = false;
    const mutation = await runOutcomeExperiment(
      'aic-11-missing-evidence-mutation-v0.1',
      (outcome) => {
        if (removedRequiredFingerprint) return outcome;
        removedRequiredFingerprint = true;
        return {
          ...outcome,
          evidenceFingerprints: outcome.evidenceFingerprints.slice(1),
        };
      },
    );
    const baselineAfterMutation = await runOutcomeExperiment(
      'aic-11-baseline-after-mutation-v0.1',
    );

    return {
      baseline,
      baselineAfterMutation,
      mutation,
      removedRequiredFingerprint,
      replayScenariosBefore,
    };
  })();

  return controlledMutationCycle;
}

function replayFixtureFor(fixture) {
  return {
    version: fixture.version,
    responses: Object.fromEntries(
      fixture.entries.map(({ toolId, input, result }) => [
        createReplayFixtureKey(toolId, input),
        result,
      ]),
    ),
  };
}

export function replayBackedNodes(record, traces, replayCounts) {
  const replay = new ReplayToolAdapter(replayFixtureFor(record.fixture));
  const leaderId = `leader-${record.runId}`;
  const visit = (nodeName, update = {}) => async () => {
    traces.get(record.runId).push(nodeName);
    return update;
  };

  return {
    normalize_incident: visit('normalize_incident'),
    collect_baseline: visit('collect_baseline'),
    generate_hypotheses: visit('generate_hypotheses', {
      hypotheses: [{
        id: leaderId,
        statement: 'replay candidate',
        createdBy: 'initial',
      }],
    }),
    derive_predictions: visit('derive_predictions'),
    plan_investigation: visit('plan_investigation'),
    /**
     * Replays every recorded call and writes both channels: the evidence the
     * call yielded, and a trial recording that the call happened.
     *
     * ⚠ The link between the two is one-way. `trial.evidenceIds` names the
     * evidence this call produced, but the corpus evidence carries its own
     * baked `trialId` of `trial-<evidenceId>` (`replay-scenarios.ts`), which
     * names no trial in this state and named none before this node wrote any.
     * The real node keeps the pair equal by overwriting `trialId` as it parses
     * (`packages/graph/src/index.ts`); this one leaves the frozen corpus alone,
     * because nothing reads the back-reference and rewriting accepted evidence
     * to tidy a pointer is a larger risk than the untidiness.
     *
     * The trial half is not bookkeeping. `toolCallsUsed` is derived as
     * `finalState.trials.length` (`benchmark-evaluation.ts`), so an arm that
     * replays real calls and leaves this channel unwritten publishes a
     * measured-looking zero on the one axis that reports what it spent — which
     * is the reading that file's own comment says the evidence must never
     * manufacture. One trial per recorded call, including a call whose result
     * came back `unavailable` or `error`: it produced no evidence and it was
     * still a call this investigation spent.
     * see benchmark-resource-evidence.test.mjs ›
     * "counts one tool call per tool call the replay-backed arm replayed"
     * see benchmark-resource-evidence.test.mjs ›
     * "counts a replayed tool call that produced no evidence"
     *
     * Two identity choices carry weight, and both are pinned rather than
     * described:
     *
     * - `attempt` is 1 on every trial, because nothing here retries. That keeps
     *   `retryCount` — trials past their first attempt — a measurement rather
     *   than a constant somebody typed;
     *   see benchmark-resource-evidence.test.mjs ›
     *   "measures a retry count of zero off trials that are all on their first attempt"
     * - `testId` is this node's own, and deliberately not the
     *   `challenge-test-${runId}` the challenge plans.
     *   `executedDiscriminatingTrialCount` counts trials that are BOTH
     *   `status === 'ok'` and carry a `testId` the challenge planned. Every
     *   call this fixture replays for a calibration scenario comes back `ok`,
     *   so here the id is the whole of it: a collision would credit a
     *   challenge whose discriminating test this fixture never executes — a
     *   behaviour score moved by a resource fix.
     *   see benchmark-resource-evidence.test.mjs ›
     *   "writing the replayed tool calls into the trials channel credits no challenge"
     *
     * `durationMs` is 0 because a replay measures nothing: the recorded result
     * is returned from memory, and the wall clock the benchmark reports is
     * measured around the whole investigation instead.
     *
     * ⚠ **The ids are per entry, and the early return is what keeps them
     * unique.** This node is entered TWICE per run — the challenge round
     * re-enters at `execute_investigation` — and the second entry replays
     * nothing only because evidence is already there. A corpus whose entries
     * ALL came back non-`ok` would leave evidence empty, replay a second time,
     * and re-emit the same ids, which `upsertById` collapses: the run would
     * have spent twice what the axis reports. No scenario in
     * `BENCHMARK_SCENARIO_PARTITIONS` is that shape — every one has an `ok`
     * entry — and the divergence is caught rather than merely unlikely, because
     * the replay counter would read twice the trial count and the row below
     * asserts the two are equal.
     * see benchmark-resource-evidence.test.mjs ›
     * "counts one tool call per tool call the replay-backed arm replayed"
     */
    async execute_investigation(state) {
      traces.get(record.runId).push('execute_investigation');
      if (state.evidence.length > 0) return {};

      const evidence = [];
      const trials = [];
      for (const [index, entry] of record.fixture.entries.entries()) {
        const replayed = await replay.execute(entry.toolId, entry.input);
        assert.deepEqual(replayed, entry.result);
        replayCounts.set(record.runId, replayCounts.get(record.runId) + 1);
        const produced = replayed.status === 'ok' ? replayed.output : [];
        evidence.push(...produced);
        trials.push({
          id: `replay-trial-${record.runId}-${index + 1}`,
          runId: record.runId,
          testId: `replay-test-${record.runId}-${index + 1}`,
          attempt: 1,
          tool: entry.toolId,
          input: entry.input,
          status: replayed.status,
          durationMs: 0,
          evidenceIds: produced.map(({ id }) => id),
        });
      }
      return { trials, evidence };
    },
    evaluate_predictions: visit('evaluate_predictions'),
    interpret_residual_evidence: visit('interpret_residual_evidence'),
    derive_hypothesis_state: visit('derive_hypothesis_state'),
    async termination_check() {
      traces.get(record.runId).push('termination_check');
      return { route: 'terminal', stopKind: 'sufficient', leaderId };
    },
    async challenge_hypothesis(_state, challengedLeaderId) {
      traces.get(record.runId).push('challenge_hypothesis');
      assert.equal(challengedLeaderId, leaderId);
      return {
        alternative: {
          id: `alternative-${record.runId}`,
          statement: 'replay evidence survives a mandatory challenge',
          createdBy: 'challenge',
        },
        discriminatingTests: [{
          id: `challenge-test-${record.runId}`,
          predictionId: `challenge-prediction-${record.runId}`,
          tool: record.fixture.entries[0].toolId,
          input: { replay: true },
          cost: 'cheap',
          status: 'planned',
        }],
      };
    },
    propose_conclusion: visit('propose_conclusion', {
      conclusion: { kind: 'inconclusive', causes: [] },
    }),
  };
}

/**
 * A LangSmith persistence client that records what crossed the boundary instead
 * of sending it, so a test can assert on the PUBLISHED record — the runs and the
 * feedback — rather than on the projection's internals.
 *
 * `calls` is the whole boundary in order, one entry per method invocation, and
 * it exists for the assertion `runs` and `feedback` cannot make: that NOTHING
 * was sent. A refusal that happens after `createDataset` and `createProject`
 * have already fired is not a refusal — the dataset and the project are created
 * under the attacker's names either way — so a test about a record that must
 * never reach the boundary asserts on `calls`, and a test about what a published
 * record CARRIES asserts on `runs` and `feedback`.
 */
export function capturingClient() {
  const runs = [];
  const feedback = [];
  const calls = [];
  return {
    runs,
    feedback,
    calls,
    client: {
      async createDataset(datasetName) {
        calls.push({ method: 'createDataset', payload: datasetName });
        return { id: 'resource-dataset-id' };
      },
      async createExamples(examples) {
        calls.push({ method: 'createExamples', payload: examples });
        return examples.map(({ id }) => ({ id }));
      },
      async createProject(project) {
        calls.push({ method: 'createProject', payload: project });
        return { id: 'resource-project-id' };
      },
      async createRun(run) {
        calls.push({ method: 'createRun', payload: run });
        runs.push(run);
      },
      async createFeedback(payload) {
        calls.push({ method: 'createFeedback', payload });
        feedback.push(payload);
        return {};
      },
    },
  };
}

/**
 * A one-record experiment, the shape `test/behavior-evaluators.test.mjs` uses
 * for its own allowlist canary: the persistence boundary is per-record, so one
 * record proves it and fifteen only make the failure slower to read.
 */
export function singleRecordExperiment(attachResources) {
  const [record] = evals.createCalibrationBenchmarkPlan({
    experimentId: 'resource-evidence-persistence-v0.2',
    runsPerScenario: 3,
    metadata: benchmarkVersions,
  });
  assert.ok(record, 'the calibration plan must contain at least one record');
  const result = evals.evaluateBenchmarkRecord({
    record,
    outcome: perfectOutcomeFor(record.scenario),
  });

  return {
    record,
    experiment: {
      records: [record],
      results: [attachResources === undefined ? result : attachResources(result)],
    },
  };
}
