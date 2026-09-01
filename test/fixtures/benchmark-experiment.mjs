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
 * callers await it. ⚠ That is a COST optimisation and nothing more — measured at
 * roughly 14x on this suite. It carries no correctness weight here: every caller
 * destructures from one `await getControlledMutationCycle()`, so no assertion
 * compares values obtained from two separate invocations, and removing the memo
 * leaves the suite green. A caller that did compare across invocations would be
 * relying on a property no test pins.
 *
 * The rejected-promise case is cached with the rest: a cycle that throws stays
 * thrown for the life of the process, so an out-of-suite run cannot retry it
 * in-process.
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

async function runOutcomeExperiment(experimentId, mutateOutcome = (outcome) => outcome) {
  const runBenchmarkExperiment = requireFunction(
    evals,
    'runBenchmarkExperiment',
    '@aic/evals',
  );

  return runBenchmarkExperiment({
    experimentId,
    scenarios: evals.REPLAY_SCENARIOS,
    runsPerScenario: 3,
    metadata: benchmarkVersions,
    async investigate(record) {
      return mutateOutcome(perfectOutcomeFor(record.scenario), record);
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

function replayFixtureFor(scenario) {
  return {
    version: scenario.fixture.version,
    responses: Object.fromEntries(
      scenario.fixture.entries.map(({ toolId, input, result }) => [
        createReplayFixtureKey(toolId, input),
        result,
      ]),
    ),
  };
}

export function replayBackedNodes(record, traces, replayCounts) {
  const replay = new ReplayToolAdapter(replayFixtureFor(record.scenario));
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
    async execute_investigation(state) {
      traces.get(record.runId).push('execute_investigation');
      if (state.evidence.length > 0) return {};

      const evidence = [];
      for (const entry of record.scenario.fixture.entries) {
        const replayed = await replay.execute(entry.toolId, entry.input);
        assert.deepEqual(replayed, entry.result);
        replayCounts.set(record.runId, replayCounts.get(record.runId) + 1);
        if (replayed.status === 'ok') evidence.push(...replayed.output);
      }
      return { evidence };
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
          tool: record.scenario.fixture.entries[0].toolId,
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
