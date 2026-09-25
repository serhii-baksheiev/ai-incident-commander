import assert from 'node:assert/strict';
import test from 'node:test';

import * as domain from '@aic/domain';
import * as graph from '@aic/graph';

import { scopedIncident } from './fixtures/scoped-incident.mjs';

const state = {
  incident: scopedIncident('incident-1', { title: 'Checkout failures' }),
  hypotheses: [
    { id: 'hypothesis-1', statement: 'The deployment caused failures', createdBy: 'initial' },
  ],
  predictions: [
    {
      id: 'prediction-1',
      hypothesisId: 'hypothesis-1',
      statement: 'Failures began after deployment',
      // AIC-123 slice 1: a Prediction's observations are typed and versioned
      // rather than an opaque `{observation: string}` bag — see
      // test/expected-observation-contract.test.mjs for the shapes
      // ExpectedObservationSchema accepts and refuses.
      observationVersion: 1,
      expectedIfTrue: [
        { form: 'deployment-in-window', subject: 'checkout', window: 'incident', presence: 'present' },
      ],
      expectedIfFalse: [
        { form: 'deployment-in-window', subject: 'checkout', window: 'pre-onset', presence: 'present' },
      ],
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
    schemaVersion: domain.INCIDENT_STATE_SCHEMA_VERSION,
    statusRulesVersion: domain.STATUS_RULES_VERSION,
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

/**
 * AIC-96 slice 2: `IncidentSchema` moves from a bare `{ id }` to requiring the
 * `primaryScope` every incident carries from intake onward
 * (`packages/domain/src/scope.ts`, `packages/domain/src/intake.ts`). An
 * incident with no scope, or a scope that names something other than a
 * registry UUID, is not a persistable incident.
 */
test('rejects an incident with no primaryScope', () => {
  assert.equal(
    domain.IncidentSchema.safeParse({ id: 'incident-1' }).success,
    false,
    'an incident carrying no primaryScope must be refused, not accepted as scope-less',
  );
});

test('rejects a primaryScope whose ids are not UUIDs', () => {
  assert.equal(
    domain.IncidentSchema.safeParse({
      id: 'incident-1',
      primaryScope: { serviceId: 'checkout', environmentId: 'production' },
    }).success,
    false,
    'a primaryScope naming a slug rather than a registry UUID must be refused',
  );
});

test('accepts a scoped incident built by the shared scopedIncident fixture', () => {
  assert.equal(
    domain.IncidentSchema.safeParse(scopedIncident('incident-1')).success,
    true,
    'the fixture every other file migrated to must itself parse as a valid incident',
  );
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
  // AIC-123 slice 1 (owner ruling D1): the schema bumps 4 -> 5 for typed,
  // versioned predictions and the hypothesis cause, with no migration — see
  // test/state-cutover.test.mjs for the resume-side refusal this bump forces.
  assert.equal(domain.INCIDENT_STATE_SCHEMA_VERSION, 5);
  // AIC-119 slice 1 bumps the current status-rules version to v0.2, while
  // `BASELINE_STATUS_RULES` stays the historical v0.1 table (a literal here,
  // not `domain.STATUS_RULES_VERSION`, or this pin would float with the
  // constant it is supposed to check) — see test/status-rules-v02.test.mjs for
  // the full v0.1/v0.2 table pins and the `corroborated` status they add.
  assert.equal(domain.STATUS_RULES_VERSION, 'v0.2');
  assert.deepEqual(domain.BASELINE_STATUS_RULES, {
    version: 'v0.1',
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
  assert.deepEqual(
    domain.STATUS_RULES['v0.1'],
    domain.BASELINE_STATUS_RULES,
    'STATUS_RULES must serve the historical v0.1 table unchanged, not a re-derived copy',
  );
});

test('rejects control state persisted under the previous schema version', () => {
  assert.equal(
    domain.IncidentStateSchema.safeParse(state).success,
    true,
    'the current-version fixture must parse, or this rejection proves nothing',
  );

  const candidate = structuredClone(state);
  // Not a literal: the schema bumps to 4 for `primaryScope` (AIC-96), and this
  // row is about "the version before whatever current is", not about the
  // number 3 specifically — see `.claude/rules/invariants.md`, "one mechanism,
  // one implementation".
  candidate.control.schemaVersion = domain.INCIDENT_STATE_SCHEMA_VERSION - 1;

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

/**
 * The two challenge counters are counts in exactly the same sense as the five
 * budgets above: `challengeRounds` is how many challenge rounds a run has
 * spent, `reservedChallengeBudget` is how many it may still spend. Declared as
 * bare numbers they were the looser of two spellings of one fact: a
 * `kind: 'start'` state carrying **-1, 0.5 or a non-safe integer** parsed here
 * and was refused later, by the graph, after nine wrapped lifecycle nodes had
 * run.
 *
 * That list is exactly three values, and the two rows below it are not part of
 * it. `NaN` and the infinities were refused by the bare `z.number()` too — zod
 * checks finiteness — so those two rows pin ZOD's behaviour, not this
 * tightening, and reverting either field to `z.number()` leaves them green
 * while the other three redden. They are kept because a count rule that stopped
 * refusing NaN would be worth hearing about from somewhere.
 */
const challengeCounters = ['challengeRounds', 'reservedChallengeBudget'];

test('declares both challenge counters under the names these rejections check', () => {
  for (const counter of challengeCounters) {
    assert.equal(
      Object.hasOwn(domain.IncidentStateControlSchema.shape, counter),
      true,
      `IncidentStateControlSchema must still declare ${counter}, or the rejections below constrain a field that no longer exists`,
    );
  }
});

for (const invalidCount of [
  { label: 'a fractional', value: 0.5 },
  { label: 'a negative', value: -1 },
  { label: 'an infinite', value: Number.POSITIVE_INFINITY },
  { label: 'a NaN', value: Number.NaN },
  { label: 'a non-safe-integer', value: Number.MAX_SAFE_INTEGER + 1 },
]) {
  test(`rejects ${invalidCount.label} value in every challenge counter`, () => {
    assert.equal(
      domain.IncidentStateSchema.safeParse(state).success,
      true,
      'the fixture carrying whole counts must parse, or these rejections prove nothing',
    );

    for (const counter of challengeCounters) {
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

test('accepts zero and a whole positive count in every challenge counter', () => {
  for (const counter of challengeCounters) {
    for (const value of [0, 2]) {
      const candidate = structuredClone(state);
      candidate.control[counter] = value;

      assert.equal(
        domain.IncidentStateSchema.safeParse(candidate).success,
        true,
        `${counter} must accept ${value}: tightening the counters must not narrow what a legitimate run may carry`,
      );
    }
  }
});

/**
 * The boundary between the two rules, and the reason the graph's
 * `assertChallengeCounters` is still load-bearing after the counters become
 * counts: `MAX_CHALLENGE_ROUNDS` is deliberately NOT a schema concern. The
 * schema decides what a counter IS — a whole non-negative count — while how
 * many rounds this graph will run is the graph's policy, and a cap the domain
 * package cannot see cannot be expressed by `LogicalCountSchema`. A state past
 * the cap is therefore a well-formed state the graph refuses, not a malformed
 * one — see investigation-graph.test.mjs › "refuses a start state one past the
 * challenge round cap, which the domain schema accepts".
 */
test('accepts a challenge round count past the graph cap, which is not a schema concern', () => {
  const candidate = structuredClone(state);
  candidate.control.challengeRounds = graph.MAX_CHALLENGE_ROUNDS + 1;

  assert.equal(
    domain.IncidentStateSchema.safeParse(candidate).success,
    true,
    'the cap belongs to the graph; the schema constrains the shape of the count and nothing else',
  );
});

test('bumps the current status-rules version to v0.2 across the state schema bump, while v0.1 stays derivable', () => {
  assert.equal(domain.STATUS_RULES_VERSION, 'v0.2');
  assert.equal(domain.BASELINE_STATUS_RULES.version, 'v0.1');
  assert.equal(domain.STATUS_RULES['v0.1'].version, 'v0.1');
  assert.equal(domain.STATUS_RULES['v0.2'].version, 'v0.2');
});
