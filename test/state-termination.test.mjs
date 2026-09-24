/**
 * AIC-119 slice 2 (owner ruling D1, item 4; plan section 2c):
 * `createStateTerminationCheck()`, the canonical `termination_check` node.
 * It decides purely from `hypotheses`, `predictions`, `assessments`,
 * `evidence`, `trials` and `control.challengeRounds` — statuses are derived
 * under `state.control.statusRulesVersion` — and reads nothing else on
 * `IncidentState`, which "scenario independence" below pins directly.
 *
 * T0-T6 read literally off plan section 2c, where `S` is the hypotheses at
 * corroborated or supported, `L` the leader `deriveHypothesisStanding`
 * names, and `r` is `challengeRounds`:
 *   T0: evidence empty, trials non-empty, no trial ok      -> tools-unavailable
 *   T1: no hypotheses                                       -> stalled
 *   T2: r === 0                                              -> challenge-required(L)
 *   T3: r >= 1 and |S| >= 2                                  -> challenge-required(L)
 *   T4: r >= 1, r < MAX_CHALLENGE_ROUNDS, L is the newest
 *       createdBy:'challenge' hypothesis                     -> challenge-required(L)
 *   T5: r >= 1 and |S| === 1 with L in S                     -> terminal sufficient(L)
 *   T6: otherwise                                            -> terminal stalled
 *
 * Expected decisions below are literals, never read back off
 * `createStateTerminationCheck` or `deriveHypothesisStanding`
 * (`.claude/rules/invariants.md`, "the independent-oracle invariant").
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { INCIDENT_STATE_SCHEMA_VERSION, STATUS_RULES_VERSION } from '@aic/domain';
import * as graphPackage from '@aic/graph';

import { requireFunction } from './fixtures/benchmark-experiment.mjs';
import { scopedIncident } from './fixtures/scoped-incident.mjs';

function requireStateTerminationCheck() {
  return requireFunction(graphPackage, 'createStateTerminationCheck', '@aic/graph');
}

function requireGraphFactory() {
  return requireFunction(graphPackage, 'createInvestigationGraph', '@aic/graph');
}

const LIFECYCLE_NODES = [
  'normalize_incident',
  'collect_baseline',
  'generate_hypotheses',
  'derive_predictions',
  'plan_investigation',
  'execute_investigation',
  'evaluate_predictions',
  'interpret_residual_evidence',
  'derive_hypothesis_state',
  'termination_check',
  'challenge_hypothesis',
  'propose_conclusion',
];

/** Every lifecycle node as a no-op, so only the named overrides do anything observable. */
function stubNodes(overrides = {}) {
  return {
    ...Object.fromEntries(LIFECYCLE_NODES.map((name) => [name, async () => ({})])),
    ...overrides,
  };
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

function trialFor(id, status, overrides = {}) {
  return {
    id,
    runId: 'run-state-termination',
    testId: `test-${id}`,
    attempt: 1,
    tool: 'logs.search',
    input: {},
    status,
    durationMs: 10,
    evidenceIds: [],
    ...overrides,
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

/** Two independent medium/high supports, no confirmed prediction of the hypothesis: corroborated. */
function corroboratedAssessments(hypothesisId, [firstEvidenceId, secondEvidenceId]) {
  return [
    supportAssessment(hypothesisId, firstEvidenceId, 'medium'),
    supportAssessment(hypothesisId, secondEvidenceId, 'high'),
  ];
}

function baseState({ control: controlOverrides = {}, ...overrides } = {}) {
  return {
    incident: scopedIncident('incident-state-termination'),
    hypotheses: [],
    predictions: [],
    tests: [],
    trials: [],
    evidence: [],
    assessments: [],
    ...overrides,
    control: {
      runId: 'run-state-termination',
      schemaVersion: INCIDENT_STATE_SCHEMA_VERSION,
      statusRulesVersion: STATUS_RULES_VERSION,
      phase: 'terminating',
      maxIterations: 4,
      llmCallBudget: 8,
      reservedChallengeBudget: 2,
      challengeRounds: 0,
      iterationsUsed: 0,
      llmCallsUsed: 0,
      resumeCount: 0,
      humanReview: false,
      ...controlOverrides,
    },
  };
}

/* -------------------------------------------------------------------------- */
/* T0 - tools-unavailable, and its negative case                              */
/* -------------------------------------------------------------------------- */

test('T0: empty evidence with a non-ok trial history is tools-unavailable, guarding the architecture rule that a tool outage is reported honestly rather than read as "no hypotheses found"', async () => {
  const createStateTerminationCheck = requireStateTerminationCheck();
  const check = createStateTerminationCheck();
  const state = baseState({
    hypotheses: [hypothesis('h-1')],
    trials: [trialFor('trial-1', 'unavailable'), trialFor('trial-2', 'error')],
    evidence: [],
  });

  const decision = await check(state);

  assert.deepEqual(decision, { route: 'terminal', stopKind: 'tools-unavailable' });
});

test('T0 negative: no evidence and no trials at all is NOT tools-unavailable - an investigation that never ran a trial is not a tool outage', async () => {
  const createStateTerminationCheck = requireStateTerminationCheck();
  const check = createStateTerminationCheck();
  const state = baseState({ hypotheses: [], trials: [], evidence: [] });

  const decision = await check(state);

  assert.notEqual(decision.stopKind, 'tools-unavailable');
  assert.deepEqual(decision, { route: 'terminal', stopKind: 'stalled' });
});

/* -------------------------------------------------------------------------- */
/* T1 - stalled on no hypotheses                                              */
/* -------------------------------------------------------------------------- */

test('T1: no hypotheses at all is stalled, even with evidence and a successful trial on record', async () => {
  const createStateTerminationCheck = requireStateTerminationCheck();
  const check = createStateTerminationCheck();
  const state = baseState({
    hypotheses: [],
    evidence: [evidenceFor('e1')],
    trials: [trialFor('trial-1', 'ok', { evidenceIds: ['e1'] })],
  });

  const decision = await check(state);

  assert.deepEqual(decision, { route: 'terminal', stopKind: 'stalled' });
});

/* -------------------------------------------------------------------------- */
/* T2 - the mandatory first round                                             */
/* -------------------------------------------------------------------------- */

test('T2: challengeRounds === 0 always names the leader for a mandatory first challenge, before any competing-leader or leadership-change rule is even consulted', async () => {
  const createStateTerminationCheck = requireStateTerminationCheck();
  const check = createStateTerminationCheck();
  const state = baseState({ hypotheses: [hypothesis('h-1')] });

  const decision = await check(state);

  assert.deepEqual(decision, { route: 'challenge-required', leaderId: 'h-1' });
});

/* -------------------------------------------------------------------------- */
/* T3 - two-or-more competing leaders after the first round                   */
/* -------------------------------------------------------------------------- */

test('T3: two hypotheses at corroborated-or-above after the first round is challenge-required, naming the earlier one in state order as leader on the tie', async () => {
  const createStateTerminationCheck = requireStateTerminationCheck();
  const check = createStateTerminationCheck();
  const state = baseState({
    hypotheses: [hypothesis('h-first'), hypothesis('h-second')],
    evidence: [evidenceFor('e-f1'), evidenceFor('e-f2'), evidenceFor('e-s1'), evidenceFor('e-s2')],
    assessments: [
      ...corroboratedAssessments('h-first', ['e-f1', 'e-f2']),
      ...corroboratedAssessments('h-second', ['e-s1', 'e-s2']),
    ],
    control: { challengeRounds: 1 },
  });

  const decision = await check(state);

  assert.deepEqual(decision, { route: 'challenge-required', leaderId: 'h-first' });
});

/* -------------------------------------------------------------------------- */
/* T4 - policy 2: leadership just changed to the newest challenge alternative */
/* -------------------------------------------------------------------------- */

test('T4: leadership just passed to the newest challenge alternative - one more mandatory round before it can be called sufficient (policy 2)', async () => {
  const createStateTerminationCheck = requireStateTerminationCheck();
  const check = createStateTerminationCheck();
  const state = baseState({
    hypotheses: [hypothesis('h-initial'), hypothesis('h-challenge', 'challenge')],
    evidence: [evidenceFor('e-c1'), evidenceFor('e-c2')],
    assessments: corroboratedAssessments('h-challenge', ['e-c1', 'e-c2']),
    control: { challengeRounds: 1 },
  });

  const decision = await check(state);

  assert.deepEqual(
    decision,
    { route: 'challenge-required', leaderId: 'h-challenge' },
    'h-challenge is the sole corroborated hypothesis AND the newest challenge alternative, so T4 fires ahead of T5 - a single round is never enough to call a fresh challenge winner sufficient',
  );
});

test('T4 boundary: once challengeRounds reaches MAX_CHALLENGE_ROUNDS, the newest-challenge-alternative rule no longer applies and a sole corroborated leader is sufficient instead', async () => {
  const createStateTerminationCheck = requireStateTerminationCheck();
  const check = createStateTerminationCheck();
  const state = baseState({
    hypotheses: [hypothesis('h-initial'), hypothesis('h-challenge', 'challenge')],
    evidence: [evidenceFor('e-c1'), evidenceFor('e-c2')],
    assessments: corroboratedAssessments('h-challenge', ['e-c1', 'e-c2']),
    control: { challengeRounds: graphPackage.MAX_CHALLENGE_ROUNDS },
  });

  const decision = await check(state);

  assert.deepEqual(decision, { route: 'terminal', stopKind: 'sufficient', leaderId: 'h-challenge' });
});

/* -------------------------------------------------------------------------- */
/* T5 - a sole corroborated-or-above leader                                   */
/* -------------------------------------------------------------------------- */

test('T5: a sole corroborated leader that was never challenged is sufficient once at least one round has run', async () => {
  const createStateTerminationCheck = requireStateTerminationCheck();
  const check = createStateTerminationCheck();
  const state = baseState({
    hypotheses: [hypothesis('h-1')],
    evidence: [evidenceFor('e1'), evidenceFor('e2')],
    assessments: corroboratedAssessments('h-1', ['e1', 'e2']),
    control: { challengeRounds: 1 },
  });

  const decision = await check(state);

  assert.deepEqual(decision, { route: 'terminal', stopKind: 'sufficient', leaderId: 'h-1' });
});

test('a supported leader (a confirmed prediction) with no competitor is also sufficient, leaving room for AIC-122', async () => {
  const createStateTerminationCheck = requireStateTerminationCheck();
  const check = createStateTerminationCheck();
  const state = baseState({
    hypotheses: [hypothesis('h-1')],
    evidence: [evidenceFor('e1'), evidenceFor('e2')],
    predictions: [predictionFor('p-1', 'h-1', 'confirmed')],
    assessments: corroboratedAssessments('h-1', ['e1', 'e2']),
    control: { challengeRounds: 1 },
  });

  const decision = await check(state);

  assert.deepEqual(decision, { route: 'terminal', stopKind: 'sufficient', leaderId: 'h-1' });
});

/* -------------------------------------------------------------------------- */
/* T6 - stalled with no round-worthy leader                                   */
/* -------------------------------------------------------------------------- */

test('T6: after a round has run, no hypothesis reaching corroborated or above is stalled, not sufficient by default', async () => {
  const createStateTerminationCheck = requireStateTerminationCheck();
  const check = createStateTerminationCheck();
  const state = baseState({
    hypotheses: [hypothesis('h-1'), hypothesis('h-2', 'challenge')],
    evidence: [evidenceFor('e1')],
    assessments: [supportAssessment('h-1', 'e1', 'medium')],
    control: { challengeRounds: 1 },
  });

  const decision = await check(state);

  assert.deepEqual(decision, { route: 'terminal', stopKind: 'stalled' });
});

/* -------------------------------------------------------------------------- */
/* Through the real kernel: the graph, not the node in isolation, decides the */
/* eventual stop kind for challenge-required at the cap or with no reserve   */
/* -------------------------------------------------------------------------- */

test('through the real kernel: two corroborated hypotheses at the challenge round cap terminates ambiguous, not challenge-required forever', async () => {
  const createInvestigationGraph = requireGraphFactory();
  const createStateTerminationCheck = requireStateTerminationCheck();
  const state = baseState({
    hypotheses: [hypothesis('h-first'), hypothesis('h-second')],
    evidence: [evidenceFor('e-f1'), evidenceFor('e-f2'), evidenceFor('e-s1'), evidenceFor('e-s2')],
    assessments: [
      ...corroboratedAssessments('h-first', ['e-f1', 'e-f2']),
      ...corroboratedAssessments('h-second', ['e-s1', 'e-s2']),
    ],
    control: { challengeRounds: graphPackage.MAX_CHALLENGE_ROUNDS },
  });

  const graph = createInvestigationGraph({
    nodes: stubNodes({ termination_check: createStateTerminationCheck() }),
  });
  const result = await graph.execute({ kind: 'start', state });

  assert.equal(
    result.control.stopKind,
    'ambiguous',
    'T3 names a challenge-required decision, but the kernel itself converts it to ambiguous once challengeRounds is already at the cap',
  );
});

test('through the real kernel: a challenge-required decision with no reserve left terminates budget-exhausted rather than challenging', async () => {
  const createInvestigationGraph = requireGraphFactory();
  const createStateTerminationCheck = requireStateTerminationCheck();
  const state = baseState({
    hypotheses: [hypothesis('h-1')],
    control: { reservedChallengeBudget: 0 },
  });

  const graph = createInvestigationGraph({
    nodes: stubNodes({ termination_check: createStateTerminationCheck() }),
  });
  const result = await graph.execute({ kind: 'start', state });

  assert.equal(
    result.control.stopKind,
    'budget-exhausted',
    'T2 mandates a first challenge round, but the kernel converts it to budget-exhausted once the reserve is already spent',
  );
});

/* -------------------------------------------------------------------------- */
/* Non-constant, and never need-more-evidence                                 */
/* -------------------------------------------------------------------------- */

test('is non-constant: the stop kinds reachable across the constructed matrix and the kernel scenarios above include at least sufficient, ambiguous, stalled and tools-unavailable', async () => {
  const createStateTerminationCheck = requireStateTerminationCheck();
  const createInvestigationGraph = requireGraphFactory();
  const check = createStateTerminationCheck();

  const toolsUnavailable = await check(
    baseState({
      hypotheses: [hypothesis('h-1')],
      trials: [trialFor('trial-1', 'unavailable')],
      evidence: [],
    }),
  );
  const sufficient = await check(
    baseState({
      hypotheses: [hypothesis('h-1')],
      evidence: [evidenceFor('e1'), evidenceFor('e2')],
      assessments: corroboratedAssessments('h-1', ['e1', 'e2']),
      control: { challengeRounds: 1 },
    }),
  );
  const stalled = await check(baseState({ hypotheses: [] }));

  const ambiguousState = baseState({
    hypotheses: [hypothesis('h-first'), hypothesis('h-second')],
    evidence: [evidenceFor('e-f1'), evidenceFor('e-f2'), evidenceFor('e-s1'), evidenceFor('e-s2')],
    assessments: [
      ...corroboratedAssessments('h-first', ['e-f1', 'e-f2']),
      ...corroboratedAssessments('h-second', ['e-s1', 'e-s2']),
    ],
    control: { challengeRounds: graphPackage.MAX_CHALLENGE_ROUNDS },
  });
  const ambiguousGraph = createInvestigationGraph({
    nodes: stubNodes({ termination_check: createStateTerminationCheck() }),
  });
  const ambiguousResult = await ambiguousGraph.execute({ kind: 'start', state: ambiguousState });

  const stopKinds = new Set([
    toolsUnavailable.stopKind,
    sufficient.stopKind,
    stalled.stopKind,
    ambiguousResult.control.stopKind,
  ]);

  for (const expected of ['sufficient', 'ambiguous', 'stalled', 'tools-unavailable']) {
    assert.ok(
      stopKinds.has(expected),
      `the reachable stop kinds must include ${expected}: termination must not collapse onto one constant decision`,
    );
  }
});

/* -------------------------------------------------------------------------- */
/* Scenario independence                                                      */
/* -------------------------------------------------------------------------- */

test('scenario independence: a different incident.id and a different scenario label anywhere it appears give an identical decision - the node reads nothing outside hypotheses, predictions, assessments, evidence, trials and control.challengeRounds', async () => {
  const createStateTerminationCheck = requireStateTerminationCheck();
  const check = createStateTerminationCheck();

  const buildScenario = (label) =>
    baseState({
      incident: { ...scopedIncident(`incident-${label}`), scenario: `scenario-${label}` },
      hypotheses: [{ id: 'h-1', statement: `${label}: the checkout deploy did it`, createdBy: 'initial' }],
      evidence: [
        { ...evidenceFor('e1'), statement: `${label}: observation e1`, source: `${label}-source` },
        { ...evidenceFor('e2'), statement: `${label}: observation e2`, source: `${label}-source` },
      ],
      assessments: corroboratedAssessments('h-1', ['e1', 'e2']),
      tests: [{ id: `${label}-test`, predictionId: 'p-x', tool: 'logs.search', input: {}, cost: 'cheap', status: 'planned' }],
      control: { challengeRounds: 1 },
    });

  const decisionAlpha = await check(buildScenario('alpha'));
  const decisionBeta = await check(buildScenario('beta'));

  assert.deepEqual(decisionAlpha, { route: 'terminal', stopKind: 'sufficient', leaderId: 'h-1' });
  assert.deepEqual(
    decisionAlpha,
    decisionBeta,
    'incident.id, an added scenario label, and free text elsewhere in the state must not change the termination decision',
  );
});

/* -------------------------------------------------------------------------- */
/* need-more-evidence is never returned                                       */
/* -------------------------------------------------------------------------- */

test('never returns need-more-evidence over the T0-T6 matrix constructed above', async () => {
  const createStateTerminationCheck = requireStateTerminationCheck();
  const check = createStateTerminationCheck();

  const decisions = await Promise.all(
    [
      baseState({ hypotheses: [hypothesis('h-1')], trials: [trialFor('trial-1', 'unavailable')], evidence: [] }),
      baseState({ hypotheses: [] }),
      baseState({ hypotheses: [hypothesis('h-1')] }),
      baseState({
        hypotheses: [hypothesis('h-first'), hypothesis('h-second')],
        evidence: [evidenceFor('e-f1'), evidenceFor('e-f2'), evidenceFor('e-s1'), evidenceFor('e-s2')],
        assessments: [
          ...corroboratedAssessments('h-first', ['e-f1', 'e-f2']),
          ...corroboratedAssessments('h-second', ['e-s1', 'e-s2']),
        ],
        control: { challengeRounds: 1 },
      }),
      baseState({
        hypotheses: [hypothesis('h-1')],
        evidence: [evidenceFor('e1'), evidenceFor('e2')],
        assessments: corroboratedAssessments('h-1', ['e1', 'e2']),
        control: { challengeRounds: 1 },
      }),
    ].map((state) => check(state)),
  );

  for (const decision of decisions) {
    assert.notEqual(
      decision.route,
      'need-more-evidence',
      'state-driven termination must never return need-more-evidence: budget-policy.test.mjs pins that nothing outside test/ may produce that route',
    );
  }
});

/* -------------------------------------------------------------------------- */
/* The owner-mandated mutation (ruling D1, item 9, last bullet)                */
/* -------------------------------------------------------------------------- */

/**
 * "A mutation turning corroborated into supported without a confirmed
 * prediction must redden a test" is pinned once, at the status-rules layer,
 * in status-rules-v02.test.mjs. Termination reads corroborated-or-above as
 * one set (`S`), so |S| and its membership are unaffected by that mutation -
 * a T3 or T5 decision still fires on the same states either way. What DOES
 * change is WHICH hypothesis termination names as leader when a corroborated
 * hypothesis and a genuinely supported one are both in `S`: rank order
 * (supported over corroborated) breaks that tie today. A status table where
 * the two collapse into the same word would leave only state order to break
 * it, silently naming the wrong hypothesis for a T3 challenge target or a T5
 * sufficient leader - termination is NOT fully agnostic to this mutation.
 */
test('the owner-mandated mutation matters here too: a genuinely supported challenger, not the earlier-listed corroborated hypothesis, is named leader for the mandatory T3 challenge round', async () => {
  const createStateTerminationCheck = requireStateTerminationCheck();
  const check = createStateTerminationCheck();
  const state = baseState({
    hypotheses: [hypothesis('h-corroborated'), hypothesis('h-supported')],
    evidence: [evidenceFor('e-c1'), evidenceFor('e-c2'), evidenceFor('e-s1'), evidenceFor('e-s2')],
    predictions: [predictionFor('p-sup', 'h-supported', 'confirmed')],
    assessments: [
      ...corroboratedAssessments('h-corroborated', ['e-c1', 'e-c2']),
      ...corroboratedAssessments('h-supported', ['e-s1', 'e-s2']),
    ],
    control: { challengeRounds: 1 },
  });

  const decision = await check(state);

  assert.deepEqual(
    decision,
    { route: 'challenge-required', leaderId: 'h-supported' },
    'both hypotheses are in S (corroborated-or-above), so |S| === 2 drives T3 either way - but the NAMED leader depends on supported outranking corroborated; collapsing the two statuses would flip this to h-corroborated, the earlier-listed one, by state order alone',
  );
});
