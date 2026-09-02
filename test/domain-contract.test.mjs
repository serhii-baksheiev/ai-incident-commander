import assert from 'node:assert/strict';
import test from 'node:test';

import * as domain from '@aic/domain';

const state = {
  incident: { id: 'incident-1', title: 'Checkout failures' },
  hypotheses: [
    { id: 'hypothesis-1', statement: 'The deployment caused failures', createdBy: 'initial' },
  ],
  predictions: [
    {
      id: 'prediction-1',
      hypothesisId: 'hypothesis-1',
      statement: 'Failures began after deployment',
      expectedIfTrue: [{ observation: 'onset matches deployment' }],
      expectedIfFalse: [{ observation: 'failures predate deployment' }],
      status: 'confirmed',
    },
  ],
  tests: [
    {
      id: 'test-1',
      predictionId: 'prediction-1',
      tool: 'deployments',
      input: { service: 'checkout' },
      cost: 'cheap',
      status: 'executed',
    },
  ],
  trials: [
    {
      id: 'trial-1',
      runId: 'run-1',
      testId: 'test-1',
      attempt: 1,
      tool: 'deployments',
      input: { service: 'checkout' },
      status: 'ok',
      durationMs: 24,
      evidenceIds: ['evidence-1'],
    },
  ],
  evidence: [
    {
      id: 'evidence-1',
      trialId: 'trial-1',
      kind: 'deploy',
      source: 'deployment-history',
      observedAt: '2026-08-27T12:00:00.000Z',
      statement: 'checkout v42 deployed at 11:58 UTC',
      rawRef: 'replay://deployments/checkout/v42',
      reliability: 'high',
    },
  ],
  assessments: [
    {
      id: 'assessment-1',
      evidenceId: 'evidence-1',
      hypothesisId: 'hypothesis-1',
      predictionId: 'prediction-1',
      effect: 'supports',
      strength: 'high',
      rationale: 'Deployment precedes the error onset',
      producedBy: 'rule',
      at: '2026-08-27T12:01:00.000Z',
    },
  ],
  conclusion: {
    kind: 'root-cause',
    causes: [
      {
        hypothesisId: 'hypothesis-1',
        cause: {
          component: 'checkout',
          mechanism: 'invalid response serialization',
          trigger: 'deployment v42',
        },
        evidenceIds: ['evidence-1'],
      },
    ],
  },
  control: {
    runId: 'run-1',
    schemaVersion: 3,
    statusRulesVersion: 'v0.1',
    phase: 'concluding',
    maxIterations: 8,
    llmCallBudget: 12,
    iterationsUsed: 3,
    llmCallsUsed: 5,
    resumeCount: 2,
    reservedChallengeBudget: 2,
    challengeRounds: 1,
    stopKind: 'sufficient',
    humanReview: false,
  },
};

test('round-trips every canonical contract through public schemas', () => {
  const fixtures = [
    ['IncidentSchema', state.incident],
    ['HypothesisSchema', state.hypotheses[0]],
    ['PredictionSchema', state.predictions[0]],
    ['InvestigationTestSchema', state.tests[0]],
    ['TrialSchema', state.trials[0]],
    ['EvidenceSchema', state.evidence[0]],
    ['EvidenceAssessmentSchema', state.assessments[0]],
    ['CauseClaimSchema', state.conclusion.causes[0]],
    ['IncidentConclusionSchema', state.conclusion],
    ['IncidentStateSchema', state],
  ];

  for (const [name, fixture] of fixtures) {
    assert.deepEqual(domain[name].parse(fixture), fixture, `${name} must round-trip`);
  }
});

test('preserves frozen string fields without relaxing assumed non-empty names', () => {
  assert.equal(domain.ToolIdSchema.safeParse('').success, false);
  assert.equal(domain.InvestigationPhaseSchema.safeParse('').success, false);
  assert.equal(
    domain.HypothesisSchema.safeParse({
      id: '',
      statement: '',
      createdBy: 'initial',
    }).success,
    true,
    'Hypothesis id and statement are frozen as string, not non-empty string',
  );
});

test('keeps frozen contract shapes exact', () => {
  const probes = [
    ['hypothesis', (candidate) => (candidate.hypotheses[0].extra = true)],
    ['prediction', (candidate) => (candidate.predictions[0].extra = true)],
    ['test', (candidate) => (candidate.tests[0].extra = true)],
    ['trial', (candidate) => (candidate.trials[0].extra = true)],
    ['evidence', (candidate) => (candidate.evidence[0].extra = true)],
    ['assessment', (candidate) => (candidate.assessments[0].extra = true)],
    ['cause claim', (candidate) => (candidate.conclusion.causes[0].extra = true)],
    ['cause', (candidate) => (candidate.conclusion.causes[0].cause.extra = true)],
    ['conclusion', (candidate) => (candidate.conclusion.extra = true)],
    ['control', (candidate) => (candidate.control.extra = true)],
    ['state', (candidate) => (candidate.extra = true)],
  ];

  for (const [name, mutate] of probes) {
    const candidate = structuredClone(state);
    mutate(candidate);
    assert.equal(
      domain.IncidentStateSchema.safeParse(candidate).success,
      false,
      `${name} must reject unknown fields`,
    );
  }
});

test('does not store derived status, confidence, or evidence relations on Hypothesis', () => {
  for (const [field, value] of [
    ['status', 'supported'],
    ['confidence', 0.9],
    ['evidenceIds', ['evidence-1']],
  ]) {
    const candidate = { ...state.hypotheses[0], [field]: value };
    assert.equal(domain.HypothesisSchema.safeParse(candidate).success, false);
  }
});

test('keeps Evidence raw by rejecting hypothesis and effect relations', () => {
  for (const [field, value] of [
    ['hypothesisId', 'hypothesis-1'],
    ['effect', 'supports'],
  ]) {
    const candidate = { ...state.evidence[0], [field]: value };
    assert.equal(domain.EvidenceSchema.safeParse(candidate).success, false);
  }
});

test('upserts collection members by replacing in place and appending new ids', () => {
  const original = [
    { id: 'hypothesis-1', statement: 'old' },
    { id: 'hypothesis-2', statement: 'unchanged' },
  ];
  const replacement = { id: 'hypothesis-1', statement: 'new' };
  const addition = { id: 'hypothesis-3', statement: 'added' };

  assert.deepEqual(domain.upsertById(original, replacement), [replacement, original[1]]);
  assert.deepEqual(domain.upsertById(original, addition), [...original, addition]);
});

test('publishes explicit state and baseline status-rule versions', () => {
  assert.equal(domain.INCIDENT_STATE_SCHEMA_VERSION, 3);
  assert.equal(domain.STATUS_RULES_VERSION, state.control.statusRulesVersion);
  assert.deepEqual(domain.BASELINE_STATUS_RULES, {
    version: domain.STATUS_RULES_VERSION,
    hypothesis: {
      statuses: ['candidate', 'supported', 'weakened', 'rejected'],
      derivedFrom: ['predictions', 'assessments'],
      numericConfidence: false,
      precedence: ['rejected', 'weakened', 'supported', 'candidate'],
      rules: {
        candidate: {
          fallback: true,
        },
        supported: {
          minimumIndependentSupports: 2,
          independenceKey: 'evidenceId',
          supportStrengths: ['medium', 'high'],
          forbiddenContradictionStrengths: ['medium', 'high'],
          minimumConfirmedPredictions: 1,
        },
        weakened: {
          contradictionStrengths: ['medium', 'high'],
        },
        rejected: {
          predictionStatus: 'refuted',
          evidenceReliability: 'high',
        },
      },
    },
  });
});

test('rejects control state persisted under the previous schema version', () => {
  assert.equal(
    domain.IncidentStateSchema.safeParse(state).success,
    true,
    'the current-version fixture must parse, or this rejection proves nothing',
  );

  const candidate = structuredClone(state);
  candidate.control.schemaVersion = 1;

  assert.equal(
    domain.IncidentStateSchema.safeParse(candidate).success,
    false,
    'state persisted before the logical-budget counters must fail loudly, not be coerced',
  );
});

test('requires the graph-owned usage counters on every control record', () => {
  assert.equal(
    domain.IncidentStateSchema.safeParse(state).success,
    true,
    'the fixture carrying both counters must parse, or these rejections prove nothing',
  );

  for (const counter of ['iterationsUsed', 'llmCallsUsed']) {
    const candidate = structuredClone(state);
    delete candidate.control[counter];

    assert.equal(
      domain.IncidentStateSchema.safeParse(candidate).success,
      false,
      `control without ${counter} must be rejected instead of silently defaulted`,
    );
  }
});

test('rejects control state persisted at schema version 2, before the resume counter existed', () => {
  assert.equal(
    domain.IncidentStateSchema.safeParse(state).success,
    true,
    'the current-version fixture must parse, or this rejection proves nothing',
  );

  const candidate = structuredClone(state);
  candidate.control.schemaVersion = 2;

  assert.equal(
    domain.IncidentStateSchema.safeParse(candidate).success,
    false,
    'state persisted before the resume counter must fail loudly, not be coerced',
  );
});

test('requires the graph-owned resume counter on every control record', () => {
  assert.equal(
    domain.IncidentStateSchema.safeParse(state).success,
    true,
    'the fixture carrying the resume counter must parse, or this rejection proves nothing',
  );

  const candidate = structuredClone(state);
  delete candidate.control.resumeCount;

  assert.equal(
    domain.IncidentStateSchema.safeParse(candidate).success,
    false,
    'control without resumeCount must be rejected instead of silently defaulted to zero',
  );
});

/**
 * The graph refuses a budget or usage counter that is not a whole non-negative
 * count, one node into the run. The schema is the boundary that decides what a
 * counter IS, so it has to refuse the same values — otherwise the same fact is
 * spelled two ways and the persisted shape is the looser of the two.
 */
const logicalBudgetCounters = [
  'maxIterations',
  'llmCallBudget',
  'iterationsUsed',
  'llmCallsUsed',
  'resumeCount',
];

for (const invalidCount of [
  { label: 'a fractional', value: 0.5 },
  { label: 'a negative', value: -1 },
  { label: 'an infinite', value: Number.POSITIVE_INFINITY },
  { label: 'a NaN', value: Number.NaN },
]) {
  test(`rejects ${invalidCount.label} value in every logical budget counter`, () => {
    assert.equal(
      domain.IncidentStateSchema.safeParse(state).success,
      true,
      'the fixture carrying whole counts must parse, or these rejections prove nothing',
    );

    for (const counter of logicalBudgetCounters) {
      const candidate = structuredClone(state);
      candidate.control[counter] = invalidCount.value;

      assert.equal(
        domain.IncidentStateSchema.safeParse(candidate).success,
        false,
        `${counter} must reject ${invalidCount.label} value at the schema boundary, not one node into the graph`,
      );
    }
  });
}

test('keeps the baseline status-rules version at v0.1 across the state schema bump', () => {
  assert.equal(domain.STATUS_RULES_VERSION, 'v0.1');
  assert.equal(domain.BASELINE_STATUS_RULES.version, 'v0.1');
});
