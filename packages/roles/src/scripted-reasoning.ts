import type { InvestigationReasoning } from '@aic/graph';

/**
 * AIC-126 slice a: the scripted-control arm's reasoning — the preregistered
 * harness signal, not a model. It is not an approximation of a model role
 * that happens to be cheap: its hypotheses carry no `cause` by design, so the
 * control arm plans nothing and fetches no evidence of its own, and what it
 * measures is what the harness itself contributes (`scripts/lane-arms.mjs`'s
 * own header on `scriptedNodes`).
 *
 * AIC-126 slice b: it lives in `@aic/roles`, not `@aic/evals`. It is a
 * deterministic reasoner with no ground truth of its own, and
 * `dependency-cruiser.config.mjs`'s `benchmark-ground-truth-is-evaluator-side-only`
 * rule forbids every other package and app from importing `@aic/evals`,
 * which carries the benchmark scenarios and their ground truth. `@aic/roles`
 * already hosts the model reasoners and `@aic/evals` already depends on
 * `@aic/roles`, so a product entry (the CLI's `aic investigate --roles
 * scripted`) can use the same scripted control the lanes do without
 * importing `@aic/evals` at all — see scripted-reasoning.test.mjs › "@aic/evals
 * does not export createScriptedReasoning: the one implementation lives in
 * @aic/roles".
 *
 * Before that it lived in `@aic/evals`, moved there from
 * `test/fixtures/benchmark-experiment.mjs`'s `replayBackedNodes`, which
 * delegates its four reasoning roles to this function and only adds its own
 * traces and self-check around them, so a lane never has to import a test
 * fixture to build its control arm and the two cannot drift
 * (`.claude/rules/invariants.md`, "one mechanism, one implementation").
 *
 * One deliberate behaviour change from the fixture: `challenge_hypothesis`
 * here does not assert on the leader id it is called with. The fixture's own
 * copy does (`assert.equal(challengedLeaderId, state.hypotheses[0]?.id ??
 * leaderId)`), which is a self-check appropriate to a test fixture, not a
 * production role — a production role that throws because a caller passed a
 * different (but perfectly valid) leader id would be a harness bug the role
 * itself should not be able to cause.
 */
export function createScriptedReasoning(
  record: Readonly<{ runId: string; fixture: Readonly<{ entries: readonly Readonly<{ toolId: string }>[] }> }>,
): InvestigationReasoning {
  const leaderId = `leader-${record.runId}`;

  return {
    async generate_hypotheses() {
      return {
        hypotheses: [{
          id: leaderId,
          statement: 'replay candidate',
          createdBy: 'initial',
        }],
      };
    },
    async interpret_residual_evidence() {
      return {};
    },
    async challenge_hypothesis() {
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
    async propose_conclusion() {
      return {
        conclusion: { kind: 'inconclusive', causes: [] },
      };
    },
  };
}
