/**
 * AIC-119 slice 2 (owner ruling D1, item 4; plan sections 2a and 2d):
 * canonical hypothesis standing — the ranking a hypothesis's derived status
 * settles into, and the leader that ranking names. `deriveHypothesisStanding`
 * is the ONE place this is computed, so `derive_hypothesis_state` and
 * `termination_check` (`packages/graph/src/nodes`) both read the same
 * answer rather than each keeping its own ranking rule
 * (`.claude/rules/invariants.md`, "one mechanism, one implementation").
 *
 * Rank order (highest to lowest): supported, corroborated, candidate,
 * weakened, rejected — a procedural target for naming a leader, never a
 * confidence score. A tie goes to the EARLIER hypothesis in state order (the
 * order `hypotheses` is given in), never to the hypothesis id or any other
 * property — the row below deliberately uses ids where alphabetical order
 * and state order disagree, so a leaderId derived by sorting ids would be
 * caught.
 *
 * Expected values below are literals, never read back off
 * `deriveHypothesisStanding` or `deriveHypothesisStatus`
 * (`.claude/rules/invariants.md`, "the independent-oracle invariant").
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import * as domain from '@aic/domain';

import { requireFunction } from './fixtures/benchmark-experiment.mjs';

function requireStandingDeriver() {
  return requireFunction(domain, 'deriveHypothesisStanding', '@aic/domain');
}

function hypothesis(id, createdBy = 'initial') {
  return { id, statement: `${id} statement`, createdBy };
}

function evidenceFor(id, reliability = 'medium') {
  return {
    id,
    trialId: `trial-${id}`,
    kind: 'deploy',
    source: 'deployment-history',
    observedAt: '2026-09-24T08:00:00.000Z',
    statement: `observation recorded as ${id}`,
    rawRef: `replay://evidence/${id}`,
    reliability,
  };
}

function supportAssessment(hypothesisId, evidenceId, strength, overrides = {}) {
  return {
    id: `support-${hypothesisId}-${evidenceId}`,
    evidenceId,
    hypothesisId,
    effect: 'supports',
    strength,
    rationale: `supports ${hypothesisId} at ${strength} strength from ${evidenceId}`,
    producedBy: 'rule',
    at: '2026-09-24T08:01:00.000Z',
    ...overrides,
  };
}

function contradictAssessment(hypothesisId, evidenceId, strength, overrides = {}) {
  return {
    id: `contradict-${hypothesisId}-${evidenceId}`,
    evidenceId,
    hypothesisId,
    effect: 'contradicts',
    strength,
    rationale: `contradicts ${hypothesisId} at ${strength} strength from ${evidenceId}`,
    producedBy: 'rule',
    at: '2026-09-24T08:01:00.000Z',
    ...overrides,
  };
}

function predictionFor(id, hypothesisId, status) {
  return {
    id,
    hypothesisId,
    statement: `${hypothesisId} prediction ${id}`,
    expectedIfTrue: [{ observation: 'the predicted observation occurs' }],
    expectedIfFalse: [{ observation: 'the predicted observation does not occur' }],
    status,
  };
}

/**
 * Two independent medium/high supports on distinct evidence ids, with no
 * confirmed prediction of the hypothesis: corroborated under v0.2, candidate
 * under v0.1 (`status-rules-v02.test.mjs`'s own grid row).
 */
function corroboratedAssessments(hypothesisId, [firstEvidenceId, secondEvidenceId]) {
  return [
    supportAssessment(hypothesisId, firstEvidenceId, 'medium'),
    supportAssessment(hypothesisId, secondEvidenceId, 'high'),
  ];
}

test('ranks every hypothesis status from supported down to rejected and leads with the highest-ranked one, regardless of state order', () => {
  const deriveHypothesisStanding = requireStandingDeriver();

  const hypotheses = [
    hypothesis('h-weakened'),
    hypothesis('h-rejected'),
    hypothesis('h-candidate'),
    hypothesis('h-corroborated'),
    hypothesis('h-supported'),
  ];
  const evidence = [
    evidenceFor('e-weak'),
    evidenceFor('e-rej', 'high'),
    evidenceFor('e-cand'),
    evidenceFor('e-c1'),
    evidenceFor('e-c2'),
    evidenceFor('e-s1'),
    evidenceFor('e-s2'),
  ];
  const predictions = [
    predictionFor('p-rej', 'h-rejected', 'refuted'),
    predictionFor('p-sup', 'h-supported', 'confirmed'),
  ];
  const assessments = [
    contradictAssessment('h-weakened', 'e-weak', 'medium'),
    contradictAssessment('h-rejected', 'e-rej', 'medium', { predictionId: 'p-rej' }),
    supportAssessment('h-candidate', 'e-cand', 'medium'),
    ...corroboratedAssessments('h-corroborated', ['e-c1', 'e-c2']),
    ...corroboratedAssessments('h-supported', ['e-s1', 'e-s2']),
  ];

  const { standings, leaderId } = deriveHypothesisStanding(
    { hypotheses, predictions, assessments, evidence },
    { rulesVersion: 'v0.2' },
  );

  assert.deepEqual(
    standings,
    [
      { id: 'h-weakened', status: 'weakened' },
      { id: 'h-rejected', status: 'rejected' },
      { id: 'h-candidate', status: 'candidate' },
      { id: 'h-corroborated', status: 'corroborated' },
      { id: 'h-supported', status: 'supported' },
    ],
    'every hypothesis must be reported once, in state order, with exactly the status the existing per-hypothesis rules already derive for it',
  );
  assert.equal(
    leaderId,
    'h-supported',
    'the leader must be the highest-ranked hypothesis (supported), even though it is listed last in state order',
  );
});

test('keeps the earlier hypothesis in state order as leader when ranks tie, never breaking the tie by id', () => {
  const deriveHypothesisStanding = requireStandingDeriver();
  const hypotheses = [hypothesis('z-candidate'), hypothesis('a-candidate')];

  const { leaderId } = deriveHypothesisStanding(
    { hypotheses, predictions: [], assessments: [], evidence: [] },
    { rulesVersion: 'v0.2' },
  );

  assert.equal(
    leaderId,
    'z-candidate',
    'both hypotheses are candidate (neither has any assessment), so the tie must go to the FIRST one in state order — an id-sorted tie-break would instead pick a-candidate',
  );
});

test('derives status under the rulesVersion passed as an option, not a fixed default', () => {
  const deriveHypothesisStanding = requireStandingDeriver();
  const hypotheses = [hypothesis('h-1')];
  const evidence = [evidenceFor('e1'), evidenceFor('e2')];
  const assessments = corroboratedAssessments('h-1', ['e1', 'e2']);

  const underV02 = deriveHypothesisStanding(
    { hypotheses, predictions: [], assessments, evidence },
    { rulesVersion: 'v0.2' },
  );
  const underV01 = deriveHypothesisStanding(
    { hypotheses, predictions: [], assessments, evidence },
    { rulesVersion: 'v0.1' },
  );

  assert.deepEqual(
    underV02.standings,
    [{ id: 'h-1', status: 'corroborated' }],
    'v0.2 has a corroborated status; two independent medium/high supports with no confirmed prediction must land there',
  );
  assert.deepEqual(
    underV01.standings,
    [{ id: 'h-1', status: 'candidate' }],
    'v0.1 has no corroborated status at all, so the IDENTICAL input must fall back to candidate under that version — only the rulesVersion option differs between the two calls',
  );
});

test("refuses a rulesVersion that is not one of STATUS_RULES's published versions", () => {
  const deriveHypothesisStanding = requireStandingDeriver();
  const hypotheses = [hypothesis('h-1')];

  assert.throws(
    () =>
      deriveHypothesisStanding(
        { hypotheses, predictions: [], assessments: [], evidence: [] },
        { rulesVersion: 'v0.99' },
      ),
    /version/i,
    'an unrecognised status-rules version must fail closed rather than silently deriving every hypothesis under some default table',
  );
});

test('ranks a corroborated hypothesis above a candidate for the leader, even when the candidate is listed first', () => {
  const deriveHypothesisStanding = requireStandingDeriver();
  const hypotheses = [hypothesis('h-candidate'), hypothesis('h-corroborated')];
  const evidence = [evidenceFor('e-cand'), evidenceFor('e-c1'), evidenceFor('e-c2')];
  const assessments = [
    supportAssessment('h-candidate', 'e-cand', 'medium'),
    ...corroboratedAssessments('h-corroborated', ['e-c1', 'e-c2']),
  ];

  const { leaderId } = deriveHypothesisStanding(
    { hypotheses, predictions: [], assessments, evidence },
    { rulesVersion: 'v0.2' },
  );

  assert.equal(
    leaderId,
    'h-corroborated',
    'corroborated outranks candidate, so the leader must be the corroborated hypothesis despite state order naming the candidate first',
  );
});

test('ranks a supported hypothesis above a corroborated one for the leader, even when the corroborated one is listed first', () => {
  const deriveHypothesisStanding = requireStandingDeriver();
  const hypotheses = [hypothesis('h-corroborated'), hypothesis('h-supported')];
  const evidence = [evidenceFor('e-c1'), evidenceFor('e-c2'), evidenceFor('e-s1'), evidenceFor('e-s2')];
  const predictions = [predictionFor('p-sup', 'h-supported', 'confirmed')];
  const assessments = [
    ...corroboratedAssessments('h-corroborated', ['e-c1', 'e-c2']),
    ...corroboratedAssessments('h-supported', ['e-s1', 'e-s2']),
  ];

  const { leaderId } = deriveHypothesisStanding(
    { hypotheses, predictions, assessments, evidence },
    { rulesVersion: 'v0.2' },
  );

  assert.equal(
    leaderId,
    'h-supported',
    'a confirmed prediction promotes h-supported to supported, which outranks corroborated regardless of state order — collapsing the two statuses into one (the owner-mandated mutation) would flip this leader to the first-listed hypothesis, h-corroborated, by state order alone',
  );
});
