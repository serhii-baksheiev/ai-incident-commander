/**
 * AIC-126 slice a: `@aic/evals`'s `createScriptedReasoning(record)`, the
 * scripted-control reasoning the benchmark harness needs — the same
 * behaviour `test/fixtures/benchmark-experiment.mjs`'s `replayBackedNodes`
 * carries today for `generate_hypotheses`, `interpret_residual_evidence`,
 * `challenge_hypothesis` and `propose_conclusion` — moved into the package so
 * a lane never has to reach into `test/` for its control arm's reasoning.
 *
 * One deliberate behaviour change from the fixture: `challenge_hypothesis`
 * here does not assert on the leader id it is called with. The fixture's own
 * copy does (`assert.equal(challengedLeaderId, state.hypotheses[0]?.id ??
 * leaderId)`), which is a self-check appropriate to a test fixture, not a
 * production role — a production role that throws because a caller passed a
 * different (but perfectly valid) leader id would be a harness bug the role
 * itself should not be able to cause.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import * as evals from '@aic/evals';

function requireEvalsExport(name) {
  assert.equal(typeof evals[name], 'function', `@aic/evals must export ${name}`);
  return evals[name];
}

function record(overrides = {}) {
  return {
    runId: 'run-aic126a-scripted-reasoning',
    fixture: {
      entries: [
        { toolId: 'deployments', input: {}, result: { status: 'ok', output: [] } },
        { toolId: 'metrics', input: {}, result: { status: 'ok', output: [] } },
      ],
    },
    ...overrides,
  };
}

/* -------------------------------------------------------------------------- */
/* 1. shape: the four reasoning roles                                        */
/* -------------------------------------------------------------------------- */

test('createScriptedReasoning(record) returns the four reasoning roles as functions', () => {
  const createScriptedReasoning = requireEvalsExport('createScriptedReasoning');
  const reasoning = createScriptedReasoning(record());

  for (const role of ['generate_hypotheses', 'interpret_residual_evidence', 'challenge_hypothesis', 'propose_conclusion']) {
    assert.equal(typeof reasoning[role], 'function', `createScriptedReasoning(record) must return a function at ${role}`);
  }
});

/* -------------------------------------------------------------------------- */
/* 2. generate_hypotheses: one causeless leader-<runId>                      */
/* -------------------------------------------------------------------------- */

test('generate_hypotheses mints exactly one causeless hypothesis leader-<runId>, createdBy initial', async () => {
  const createScriptedReasoning = requireEvalsExport('createScriptedReasoning');
  const aRecord = record();
  const reasoning = createScriptedReasoning(aRecord);

  const result = await reasoning.generate_hypotheses({});

  assert.deepEqual(result, {
    hypotheses: [{
      id: `leader-${aRecord.runId}`,
      statement: 'replay candidate',
      createdBy: 'initial',
    }],
  });
  assert.equal('cause' in result.hypotheses[0], false, 'the scripted leader carries no cause');
});

/* -------------------------------------------------------------------------- */
/* 3. interpret_residual_evidence: a no-op                                   */
/* -------------------------------------------------------------------------- */

test('interpret_residual_evidence returns {} regardless of state', async () => {
  const createScriptedReasoning = requireEvalsExport('createScriptedReasoning');
  const reasoning = createScriptedReasoning(record());

  assert.deepEqual(await reasoning.interpret_residual_evidence({ some: 'state' }), {});
});

/* -------------------------------------------------------------------------- */
/* 4. challenge_hypothesis: alternative-<runId>, one discriminating test     */
/* -------------------------------------------------------------------------- */

test('challenge_hypothesis returns the causeless alternative-<runId> and one discriminating test on the fixture\'s first entry, byte-identical to the fixture\'s own shape', async () => {
  const createScriptedReasoning = requireEvalsExport('createScriptedReasoning');
  const aRecord = record();
  const reasoning = createScriptedReasoning(aRecord);

  const result = await reasoning.challenge_hypothesis({}, `leader-${aRecord.runId}`);

  assert.deepEqual(result, {
    alternative: {
      id: `alternative-${aRecord.runId}`,
      statement: 'replay evidence survives a mandatory challenge',
      createdBy: 'challenge',
    },
    discriminatingTests: [{
      id: `challenge-test-${aRecord.runId}`,
      predictionId: `challenge-prediction-${aRecord.runId}`,
      tool: aRecord.fixture.entries[0].toolId,
      input: { replay: true },
      cost: 'cheap',
      status: 'planned',
    }],
  });
  assert.equal('cause' in result.alternative, false, 'the scripted alternative carries no cause');
});

test('challenge_hypothesis does not assert on the leader id it is called with, unlike the fixture it replaces', async () => {
  const createScriptedReasoning = requireEvalsExport('createScriptedReasoning');
  const aRecord = record();
  const reasoning = createScriptedReasoning(aRecord);

  // A leader id that is neither `leader-<runId>` nor anything derived from
  // state must not make this role throw: it is a production role now, and a
  // caller-supplied (but different) leader id is not this role's business.
  await assert.doesNotReject(
    reasoning.challenge_hypothesis({}, 'some-other-leader-id-entirely'),
  );
});

/* -------------------------------------------------------------------------- */
/* 5. propose_conclusion: inconclusive, no causes                            */
/* -------------------------------------------------------------------------- */

test('propose_conclusion returns an inconclusive conclusion with no causes', async () => {
  const createScriptedReasoning = requireEvalsExport('createScriptedReasoning');
  const reasoning = createScriptedReasoning(record());

  assert.deepEqual(await reasoning.propose_conclusion({}), {
    conclusion: { kind: 'inconclusive', causes: [] },
  });
});
